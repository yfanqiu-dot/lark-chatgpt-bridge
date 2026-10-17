import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { parseTopicConfig, TopicRegistry, topicChatEnabled, validateTopicScope, type TopicConfig } from './topics';
import { topicDesktopConfig } from './topic-router';
import { validateHostConfig, type HostConfig } from './host';
import { readDesktopToolConfig } from './backend';
import { CodexTopicResources } from './topic-resources';
import { assertProjectThread } from './topic-provisioner';
import { DesktopRpc, RpcError } from './rpc';
import type { Binding, DeliveryState } from './ledger';
import { validateReconciliation } from './ledger';

export interface DeploymentSpec {
  /** Explicit opt-in to all registered bindings and owner-created topics. */
  scope?: 'registered-topics';
  hostConfigFile: string;
  topicConfigFile: string;
  codeRevision: string;
  artifactFiles: string[];
  expectedToolNames: string[];
  /** References only. Credentials remain in the original secret provider. */
  legacy: { scheduledTaskName: string; executable: string; entryPoint: string; profile: string; configFiles: string[] };
}
interface FileProof { path: string; sha256: string }
interface LedgerSummary {
  binding: Binding;
  file: string;
  sha256: string;
  counts: Partial<Record<DeliveryState, number>>;
  savedResultsPending: number;
  deliveryReceiptsUnconfirmed: number;
  savedResultsRetrieved: number;
}
interface Snapshot {
  version: 1;
  createdAt: string;
  spec: DeploymentSpec;
  files: FileProof[];
  bindings: Binding[];
  ledgers: LedgerSummary[];
  backupFiles: FileProof[];
}
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const json = async (path: string): Promise<any> => JSON.parse(await readFile(path, 'utf8'));
const absolute = (path: unknown): string => {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Deployment paths must be absolute');
  return resolve(path);
};

export function parseDeploymentSpec(raw: unknown): DeploymentSpec {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid deployment spec');
  const r = raw as DeploymentSpec, legacy = r.legacy;
  if (r.scope !== undefined && r.scope !== 'registered-topics') throw new Error('Invalid deployment scope');
  if (!/^[a-f0-9]{40}$/i.test(r.codeRevision)) throw new Error('A full Git codeRevision is required');
  if (!Array.isArray(r.artifactFiles) || !r.artifactFiles.length || !Array.isArray(r.expectedToolNames) || !r.expectedToolNames.includes('list_projects') || r.expectedToolNames.some(n => typeof n !== 'string' || !/^[a-zA-Z0-9_]+$/.test(n)) || new Set(r.expectedToolNames).size !== r.expectedToolNames.length) throw new Error('Invalid artifact or tool baseline');
  if (!legacy || typeof legacy.scheduledTaskName !== 'string' || !/^[\w.-]+$/.test(legacy.scheduledTaskName) || typeof legacy.profile !== 'string' || !/^[\w-]+$/.test(legacy.profile) || !Array.isArray(legacy.configFiles)) throw new Error('Invalid legacy launch references');
  const spec: DeploymentSpec = {
    ...(r.scope ? { scope: r.scope } : {}),
    hostConfigFile: absolute(r.hostConfigFile), topicConfigFile: absolute(r.topicConfigFile), codeRevision: r.codeRevision.toLowerCase(),
    artifactFiles: r.artifactFiles.map(absolute), expectedToolNames: [...r.expectedToolNames].sort(),
    legacy: { scheduledTaskName: legacy.scheduledTaskName, executable: absolute(legacy.executable), entryPoint: absolute(legacy.entryPoint), profile: legacy.profile, configFiles: legacy.configFiles.map(absolute) },
  };
  if (new Set(spec.artifactFiles).size !== spec.artifactFiles.length) throw new Error('Duplicate artifact file');
  return spec; // Deliberately discard unrecognized fields, including secret values.
}

async function configs(spec: DeploymentSpec): Promise<{ host: HostConfig; topics: TopicConfig }> {
  const raw = await json(spec.hostConfigFile);
  // Explicit whitelist: the deployment backup must never copy arbitrary config fields.
  const host = await validateHostConfig({
    codexBinary: raw.codexBinary, codexSha256: raw.codexSha256, desktopExe: raw.desktopExe, desktopVersion: raw.desktopVersion,
    projectRoot: raw.projectRoot, endpoint: raw.endpoint, backendEndpoint: raw.backendEndpoint, connectionFile: raw.connectionFile,
    ...(raw.desktopQuitPolicy !== undefined ? { desktopQuitPolicy: raw.desktopQuitPolicy } : {}),
    ...(raw.toolBindings !== undefined ? { toolBindings: raw.toolBindings.map((b: any) => ({ threadId: b.threadId, projectId: b.projectId })) } : {}),
    ...(raw.topicRegistryFile !== undefined ? { topicRegistryFile: raw.topicRegistryFile } : {}),
    ...(raw.topicProjects !== undefined ? { topicProjects: raw.topicProjects.map((p: any) => ({ projectId: p.projectId, projectRoot: p.projectRoot })) } : {}),
  });
  const topics = parseTopicConfig(await json(spec.topicConfigFile));
  if (spec.scope === 'registered-topics') {
    if (topics.enabledChatIds !== undefined || topics.allowTopicCreation !== true) throw new Error('Registered-topic deployment requires all registered bindings and explicit topic creation');
  } else if (topics.enabledChatIds?.length !== 1 || topics.allowTopicCreation !== false) throw new Error('Initial deployment requires exactly one gray chat and disabled topic creation');
  if (host.endpoint !== topics.endpoint || resolve(host.connectionFile) !== topics.connectionFile || !host.topicRegistryFile || resolve(host.topicRegistryFile) !== topics.registryFile) throw new Error('Host and topic deployment paths differ');
  for (const project of topics.projects) if (!host.topicProjects?.some(p => p.projectId === project.projectId && resolve(p.projectRoot) === project.projectRoot)) throw new Error('Topic project is absent from host allowlist');
  return { host, topics };
}

async function bindings(config: TopicConfig): Promise<Binding[]> {
  const registry = new TopicRegistry(config.registryFile);
  await registry.load(true);
  validateTopicScope(config, registry.all());
  const result = registry.all().filter(r => r.stage === 'active').map(row => {
    const c = topicDesktopConfig(config, row);
    return { appId: c.appId, chatId: c.chatId, ownerOpenId: c.ownerOpenId, projectId: c.projectId, projectRoot: c.projectRoot, threadId: c.threadId };
  });
  if (config.existing) {
    const e = config.existing, p = config.projects.find(p => p.key === e.projectKey)!;
    result.push({ appId: config.appId, chatId: e.chatId, ownerOpenId: config.ownerOpenId, projectId: p.projectId, projectRoot: p.projectRoot, threadId: e.threadId });
  }
  return result.sort((a, b) => a.chatId.localeCompare(b.chatId));
}

async function ledger(config: TopicConfig, binding: Binding): Promise<LedgerSummary> {
  const file = config.existing?.chatId === binding.chatId ? config.existing.stateFile : join(config.stateDir, `${binding.chatId}.json`);
  const bytes = await readFile(file), saved = JSON.parse(bytes.toString('utf8'));
  if (saved.version !== 1 || !Array.isArray(saved.messages) || !saved.binding || Object.entries(binding).some(([k, v]) => saved.binding[k] !== v)) throw new Error('Ledger identity/version mismatch');
  const counts: LedgerSummary['counts'] = {}, ids = new Set<string>();
  let savedResultsPending = 0, deliveryReceiptsUnconfirmed = 0, savedResultsRetrieved = 0;
  for (const m of saved.messages) {
    if (!m || typeof m.messageId !== 'string' || ids.has(m.messageId) || !['queued', 'submitting', 'running', 'completed', 'interrupted', 'failed', 'uncertain'].includes(m.state) || (m.queueClientId !== undefined && m.queueClientId !== m.messageId)) throw new Error('Malformed ledger');
    ids.add(m.messageId);
    validateReconciliation(m);
    const state = m.state as DeliveryState; counts[state] = (counts[state] ?? 0) + 1;
    if (typeof m.result === 'string' && m.result && !m.receipt) {
      if (!m.deliveryAttempted) savedResultsPending++;
      else {
        deliveryReceiptsUnconfirmed++;
        // Explicit /result has its own message and receipt. Do not falsify the
        // original ambiguous send's receipt or count that retrieval as a replay.
        if (saved.messages.some((r: any) => r.state === 'completed' && r.receipt && typeof r.prompt === 'string' && /^\/result\s+(\S+)\s*$/i.exec(r.prompt.trim())?.[1] === m.messageId)) savedResultsRetrieved++;
      }
    }
  }
  return { binding, file, sha256: digest(bytes), counts, savedResultsPending, deliveryReceiptsUnconfirmed, savedResultsRetrieved };
}
const proof = async (path: string): Promise<FileProof> => ({ path, sha256: digest(await readFile(path)) });

export async function pendingApprovalChats(topics: TopicConfig): Promise<string[]> {
  try {
    const cards = await json(`${topics.registryFile}.approvals.json`), tokens = new Set<string>();
    if (cards.version !== 1 || cards.binding?.appId !== topics.appId || cards.binding?.ownerOpenId !== topics.ownerOpenId || cards.binding?.entryChatId !== topics.entryChatId || !Array.isArray(cards.cards)) throw new Error('Invalid approval journal');
    for (const c of cards.cards) {
      if (!c || typeof c.token !== 'string' || tokens.has(c.token) || typeof c.chatId !== 'string' || !['sending','open','closing','closed','unknown'].includes(c.state) || (['open','closing','closed'].includes(c.state) && (typeof c.messageId !== 'string' || !c.messageId))) throw new Error('Invalid approval journal');
      tokens.add(c.token);
    }
    return cards.cards.filter((c: any) => c.state !== 'closed').map((c: any) => c.chatId);
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e; }
}

/** Read-only native checks. No resume, queue/add, turn/start or approval reply. */
export async function inspectNativeBinding(topics: TopicConfig, binding: Binding) {
  const findings: string[] = [], project = topics.projects.find(p => p.projectId === binding.projectId)!;
  const classify = (e: unknown, fallback: string) => e instanceof RpcError && (e.code === 403 || /permission denied|unauthori[sz]ed|forbidden/i.test(e.message)) ? 'permission_denied'
    : e instanceof RpcError && e.code === -32601 ? 'protocol_unsupported' : fallback;
  try { await new CodexTopicResources(topics).verifyProject(project); }
  catch (e) { return { verified: false, findings: [classify(e, 'project_unbound_or_unavailable')] }; }
  const rpc = new DesktopRpc(topics.endpoint);
  try {
    await rpc.connect();
    const read = await rpc.call('thread/read', { threadId: binding.threadId, includeTurns: false });
    try {
      assertProjectThread(read.thread, project, await realpath(project.projectRoot));
      if (read.thread?.id !== binding.threadId) throw new Error('Task identity changed');
    } catch { return { verified: false, findings: ['native_binding_mismatch'] }; }
    const turns = await rpc.call('thread/turns/list', { threadId: binding.threadId, limit: 5, itemsView: 'notLoaded' });
    if (!turns.data?.some((t: any) => t.status === 'completed' && t.completedAt != null)) return { verified: false, findings: ['history_incompatible'] };
    if (read.thread.status?.activeFlags?.includes('waitingOnApproval')) findings.push('waiting_approval');
    else if (read.thread.status?.type === 'active') findings.push('native_turn_active');
    // Even an inactive task may still have queued input. Inspect all pages;
    // repeated cursors or malformed pages cannot be treated as an empty queue.
    let cursor: string | undefined; const seen = new Set<string>();
    do {
      const page = await rpc.call('thread/queue/list', { threadId: binding.threadId, limit: 100, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error('Invalid native queue page');
      if (page.data.length && !findings.includes('native_queue_pending')) findings.push('native_queue_pending');
      cursor = page.nextCursor ?? undefined;
      if (cursor && (typeof cursor !== 'string' || seen.has(cursor))) throw new Error('Invalid queue cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return { verified: true, findings };
  } catch (e) { return { verified: false, findings: [classify(e, 'native_state_unavailable')] }; }
  finally { rpc.close(); }
}

/** Offline staging: no service changes, no Feishu calls, no ledger writes. */
export async function prepareDeployment(raw: unknown, directory: string): Promise<Snapshot> {
  const spec = parseDeploymentSpec(raw), { host, topics } = await configs(spec);
  const all = await bindings(topics), ledgers = await Promise.all(all.map(b => ledger(topics, b)));
  const selected = ledgers.filter(l => topicChatEnabled(topics, l.binding.chatId));
  if (selected.some(l => ['queued', 'submitting', 'running', 'uncertain'].some(s => l.counts[s as DeliveryState]))) throw new Error('Selected gray ledger is busy or uncertain; preserve it for reconciliation');
  if ((await pendingApprovalChats(topics)).some(id => topicChatEnabled(topics, id))) throw new Error('Selected gray chat has pending approval cards');
  const files = await Promise.all([...new Set([spec.hostConfigFile, spec.topicConfigFile, host.codexBinary, host.desktopExe, spec.legacy.executable, spec.legacy.entryPoint, ...spec.legacy.configFiles, ...spec.artifactFiles])].map(proof));
  const stage = absolute(directory);
  // An existing directory is never overwritten, even after a partial preparation.
  await mkdir(stage, { mode: 0o700 });
  const backupFiles: FileProof[] = [];
  for (const [name, value] of [['host.json', host], ['topics.json', topics], ['legacy-launch.json', spec.legacy]] as const) {
    const data = JSON.stringify(value, null, 2) + '\n';
    await writeFile(join(stage, name), data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    backupFiles.push({ path: name, sha256: digest(data) });
  }
  const snapshot: Snapshot = { version: 1, createdAt: new Date().toISOString(), spec, files, bindings: all, ledgers, backupFiles };
  await writeFile(join(stage, 'manifest.json'), JSON.stringify(snapshot, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return snapshot;
}

/** Mutable ledgers are inspected, never replaced with the staging snapshot. */
export async function verifyDeployment(directory: string): Promise<{ snapshot: Snapshot; host: HostConfig; topics: TopicConfig; ledgers: LedgerSummary[] }> {
  const stage = absolute(directory), snapshot = await json(join(stage, 'manifest.json')) as Snapshot;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.backupFiles) || !Array.isArray(snapshot.bindings)) throw new Error('Invalid deployment manifest');
  const spec = parseDeploymentSpec(snapshot.spec);
  for (const f of snapshot.backupFiles) {
    if (!['host.json', 'topics.json', 'legacy-launch.json'].includes(f.path) || digest(await readFile(join(stage, f.path))) !== f.sha256) throw new Error('Deployment backup changed');
  }
  if (snapshot.backupFiles.length !== 3 || new Set(snapshot.backupFiles.map(f => f.path)).size !== 3) throw new Error('Deployment backup is incomplete');
  for (const f of snapshot.files) if ((await proof(absolute(f.path))).sha256 !== f.sha256) throw new Error('Pinned deployment file changed');
  const { host, topics } = await configs(spec), all = await bindings(topics);
  const required = [...new Set([spec.hostConfigFile, spec.topicConfigFile, host.codexBinary, host.desktopExe, spec.legacy.executable, spec.legacy.entryPoint, ...spec.legacy.configFiles, ...spec.artifactFiles])];
  if (snapshot.files.length !== required.length || required.some(p => !snapshot.files.some(f => f.path === p))) throw new Error('Deployment file proofs are incomplete');
  if (spec.scope === 'registered-topics') {
    // New owner-provisioned bindings may be appended. Original bindings remain
    // immutable, including currently inactive historical groups.
    if (snapshot.bindings.some(old => !all.some(current => JSON.stringify(current) === JSON.stringify(old)))) throw new Error('Original topic bindings changed');
  } else if (JSON.stringify(all) !== JSON.stringify(snapshot.bindings)) throw new Error('Original topic bindings changed');
  return { snapshot, host, topics, ledgers: await Promise.all(all.map(b => ledger(topics, b))) };
}

export async function diagnoseDeployment(directory: string, native = false) {
  const { snapshot, host, topics, ledgers } = await verifyDeployment(directory);
  const selected = ledgers.filter(l => topicChatEnabled(topics, l.binding.chatId));
  const findings: string[] = [];
  if (selected.some(l => l.counts.uncertain)) findings.push('uncertain_paused');
  if (selected.some(l => l.counts.queued || l.counts.running || l.counts.submitting)) findings.push('queue_busy');
  if (selected.some(l => l.savedResultsPending)) findings.push('saved_result_pending');
  if (selected.some(l => l.deliveryReceiptsUnconfirmed)) findings.push('original_delivery_receipt_unconfirmed');
  if ((await pendingApprovalChats(topics)).some(id => topicChatEnabled(topics, id))) findings.push('approval_card_pending');
  let leaseVerified = false, nativeBindingsVerified = false;
  try {
    await readDesktopToolConfig(topics);
    const lease = await json(topics.connectionFile);
    if (lease.desktopVersion !== host.desktopVersion || lease.codexSha256 !== host.codexSha256 || !Array.isArray(lease.toolNames) || JSON.stringify([...lease.toolNames].sort()) !== JSON.stringify(snapshot.spec.expectedToolNames)) findings.push('tool_catalog_or_version_mismatch');
    else leaseVerified = true;
  } catch { findings.push('desktop_lease_unavailable'); }
  if (native && leaseVerified) {
    const nativeResults = await Promise.all(selected.map(l => inspectNativeBinding(topics, l.binding)));
    nativeBindingsVerified = nativeResults.every(r => r.verified);
    findings.push(...new Set(nativeResults.flatMap(r => r.findings)));
  }
  const hostLockHeld = await lockfile.check(host.connectionFile, { realpath: false });
  const topicLockHeld = await lockfile.check(topics.registryFile, { realpath: false });
  return {
    version: 1, checkedAt: new Date().toISOString(), codeRevision: snapshot.spec.codeRevision,
    desktopVersion: host.desktopVersion, selectedChatIds: topics.enabledChatIds,
    leaseVerified, nativeBindingsVerified, hostLockHeld, topicLockHeld, findings,
    // Counts only; no prompts, results, error text, auth config or MCP definitions.
    ledgers: ledgers.map(l => ({ chatId: l.binding.chatId, selected: topicChatEnabled(topics, l.binding.chatId), counts: l.counts, savedResultsPending: l.savedResultsPending, deliveryReceiptsUnconfirmed: l.deliveryReceiptsUnconfirmed, savedResultsRetrieved: l.savedResultsRetrieved })),
    rollback: { newRuntimeStopped: !hostLockHeld && !topicLockHeld, ledgerRestoreAllowed: false, legacyLaunch: snapshot.spec.legacy, requiresProcessIdentityAndUniqueConsumerCheck: true },
  };
}
