import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { WebSocketServer } from 'ws';
import { diagnoseDeployment, inspectNativeBinding, parseDeploymentSpec, prepareDeployment, verifyDeployment, type DeploymentSpec } from '../../../src/desktop/deployment';
import { parseTopicConfig, TopicRegistry, validateTopicScope } from '../../../src/desktop/topics';
import { TopicRouter, type TopicController } from '../../../src/desktop/topic-router';
import { TopicProvisioner } from '../../../src/desktop/topic-provisioner';
import { ApprovalJournal } from '../../../src/desktop/approval-journal';
import type { Approval } from '../../../src/desktop/backend';
import {prepareColdRuntime,verifyColdRuntimePlan} from '../../../src/desktop/runtime-supervisor';

let dir: string;
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'desktop-p4-'))); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value), 'utf8');
async function fixture() {
  const desktopVersion = '26.1007.2314.0', packageDir = join(dir, `OpenAI.Codex_${desktopVersion}_x64__2p2nqsd0c76g0`, 'app');
  await mkdir(packageDir, { recursive: true });
  const desktopExe = join(packageDir, 'ChatGPT.exe'), codexBinary = join(dir, 'codex.exe'), legacyExe = join(dir, 'node.exe'), legacyEntry = join(dir, 'legacy.mjs'), artifact = join(dir, 'desktop-topics.js');
  for (const p of [desktopExe, codexBinary, legacyExe, legacyEntry, artifact]) await writeFile(p, 'fixture', 'utf8');
  const c = parseTopicConfig({ appId: 'cli_test', appSecretEnv: 'LARK_APP_SECRET', ownerOpenId: 'ou_owner', entryChatId: 'oc_entry',
    endpoint: 'ws://127.0.0.1:9000/', connectionFile: join(dir, 'connection.json'), registryFile: join(dir, 'registry.json'), stateDir: join(dir, 'ledgers'),
    projects: [{ key: 'test', projectId: 'project', projectRoot: dir }], enabledChatIds: ['oc_c'], allowTopicCreation: false });
  await mkdir(c.stateDir);
  const registry = { version: 1, topics: ['a', 'b', 'c'].map(id => ({ requestId: id, title: id, stage: 'active', chatId: `oc_${id}`, threadId: `thread-${id}`, projectKey: 'test', projectId: 'project', projectRoot: dir, createdAt: '', updatedAt: '' })) };
  await save(c.registryFile, registry);
  for (const id of ['a', 'b', 'c']) await save(join(c.stateDir, `oc_${id}.json`), { version: 1, binding: { appId: c.appId, chatId: `oc_${id}`, ownerOpenId: c.ownerOpenId, projectId: 'project', projectRoot: dir, threadId: `thread-${id}` }, messages: [{ messageId: `m-${id}`, prompt: 'PRIVATE_PROMPT', replyInThread: false, state: id === 'c' ? 'failed' : 'uncertain' }] });
  const host = { codexBinary, codexSha256: createHash('sha256').update('fixture').digest('hex'), desktopExe, desktopVersion, projectRoot: dir, endpoint: c.endpoint, backendEndpoint: 'ws://127.0.0.1:9001/', connectionFile: c.connectionFile, topicRegistryFile: c.registryFile, topicProjects: [{ projectId: 'project', projectRoot: dir }], appSecret: 'DO_NOT_COPY' };
  const spec: DeploymentSpec = { hostConfigFile: join(dir, 'host.json'), topicConfigFile: join(dir, 'topics.json'), codeRevision: 'a'.repeat(40), artifactFiles: [artifact], expectedToolNames: ['list_projects'], legacy: { scheduledTaskName: 'Legacy.codex', executable: legacyExe, entryPoint: legacyEntry, profile: 'codex', configFiles: [] } };
  await save(spec.hostConfigFile, host); await save(spec.topicConfigFile, { ...c, appSecret: 'DO_NOT_COPY' });
  return { c, registry, spec, host, stage: join(dir, 'stage') };
}

describe('P4 gray group scope', () => {
  it('rejects empty, duplicate, malformed scope and resource creation in gray mode', async () => {
    const { c } = await fixture();
    for (const enabledChatIds of [[], ['oc_c', 'oc_c'], ['bad']]) expect(() => parseTopicConfig({ ...c, enabledChatIds })).toThrow();
    expect(() => parseTopicConfig({ ...c, allowTopicCreation: true })).toThrow('requires');
    expect(() => parseTopicConfig({ ...c, allowTopicCreation: 'false' })).toThrow('boolean');
    expect(() => validateTopicScope({ ...c, enabledChatIds: ['oc_missing'] }, [])).toThrow('no active binding');
  });
  it('starts and archives only C, ignores A/B and entry, rejects excluded card decisions without touching their ledgers', async () => {
    const { c } = await fixture(), store = new TopicRegistry(c.registryFile), calls: string[] = [];
    const aFile = join(c.stateDir, 'oc_a.json'), before = await readFile(aFile, 'utf8');
    const factory = (bound: { chatId: string }): TopicController => ({ async start() { calls.push(`start:${bound.chatId}`); }, async receive(m) { calls.push(`message:${m.chatId}`); }, async decideFromCard(chat) { calls.push(`card:${chat}`); }, async shutdown() {} });
    const port: any = { async createThread() { throw new Error('must not create'); } };
    const router = new TopicRouter(c, store, new TopicProvisioner(c, store, port), factory, { async send() { throw new Error('outside scope reply'); } }, async row => { calls.push(`archive:${row.chatId}`); });
    await router.start();
    for (const id of ['oc_a', 'oc_b', 'oc_entry', 'oc_c']) await router.receive({ messageId: id, chatId: id, senderId: c.ownerOpenId, content: id === 'oc_c' ? 'hello' : '/topic new test unexpected', mentionedBot: true, replyInThread: false });
    await expect(router.decideFromCard('oc_a', c.ownerOpenId, 'old', 'accept')).rejects.toThrow('灰度范围');
    await router.decideFromCard('oc_c', c.ownerOpenId, 'new', 'accept');
    await router.shutdown();
    expect(await readFile(aFile, 'utf8')).toBe(before);
    expect(calls).toEqual(['start:oc_c', 'archive:oc_c', 'message:oc_c', 'card:oc_c']);
  });
  it('fails before any controller when selected binding is missing or project identity changed', async () => {
    const { c } = await fixture(), store = new TopicRegistry(c.registryFile); let starts = 0;
    const factory = (): TopicController => ({ async start() { starts++; }, async receive() {}, async decideFromCard() {}, async shutdown() {} });
    const router = new TopicRouter({ ...c, enabledChatIds: ['oc_missing'] }, store, new TopicProvisioner(c, store, {} as any), factory, { async send() { return ''; } });
    await expect(router.start()).rejects.toThrow('no active binding'); expect(starts).toBe(0);
    await store.load(true);
    expect(() => validateTopicScope(c, store.all().map(r => r.chatId === 'oc_c' ? { ...r, projectId: 'different' } : r))).toThrow('project');
  });
  it('blocks creation and resume when the entry binding itself is enabled', async () => {
    const { c } = await fixture(), messages: string[] = [];
    const entry = { ...c, enabledChatIds: ['oc_entry'], existing: { chatId: 'oc_entry', projectKey: 'test', threadId: 'entry', stateFile: join(dir, 'entry.json') } };
    const factory = (): TopicController => ({ async start() {}, async receive() { throw new Error('no model input'); }, async decideFromCard() {}, async shutdown() {} });
    const router = new TopicRouter(entry, new TopicRegistry(c.registryFile), new TopicProvisioner(entry, new TopicRegistry(c.registryFile), {} as any), factory, { async send(_chat, text) { messages.push(text); return 'receipt'; } });
    await router.start();
    for (const content of ['/topic new test title', '/topic resume original']) await router.receive({ messageId: content, chatId: 'oc_entry', senderId: c.ownerOpenId, content, mentionedBot: true, replyInThread: false });
    expect(messages).toHaveLength(2); expect(messages.every(m => m.includes('已关闭'))).toBe(true); await router.shutdown();
  });
  it('does not close or alter historical A/B cards during C recovery', async () => {
    const file = join(dir, 'cards.json'), binding = { appId: 'app' }, closed: string[] = [];
    const cards = [{ token: 'a', chatId: 'oc_a', state: 'open', messageId: 'receipt-a' }, { token: 'c', chatId: 'oc_c', state: 'open', messageId: 'receipt-c' }];
    await save(file, { version: 1, binding, cards });
    const j = new ApprovalJournal(file, binding, { async send() { return 'new'; }, async close(id) { closed.push(id); } }, 60_000, ['oc_c']);
    try {
      await j.start(); await j.flush(); await j.resolved('a');
      await expect(j.publish('oc_a', { token: 'new-a' } as Approval, '', false)).rejects.toThrow('outside');
      expect(closed).toEqual(['receipt-c']); expect((await jsonFile(file)).cards[0]).toEqual(cards[0]);
    } finally { await j.shutdown(); }
  });
});
const jsonFile = async (file: string) => JSON.parse(await readFile(file, 'utf8'));

describe('P4 offline deployment and rollback guards', () => {
  it('requires explicit registered-topic scope and preserves historical uncertain ledgers', async () => {
    const f=await fixture(),before=await readFile(join(f.c.stateDir,'oc_a.json'));
    await save(f.spec.topicConfigFile,{...f.c,enabledChatIds:undefined,allowTopicCreation:true});
    await expect(prepareDeployment(f.spec,f.stage)).rejects.toThrow('exactly one');
    await expect(prepareDeployment({...f.spec,scope:'registered-topics'},f.stage)).rejects.toThrow('uncertain');
    expect(await readFile(join(f.c.stateDir,'oc_a.json'))).toEqual(before);
    expect(()=>parseDeploymentSpec({...f.spec,scope:'anything'})).toThrow('scope');
  });
  it('admits appended registered topics without relaxing immutable old bindings or ledger identities',async()=>{
    const f=await fixture();
    for(const id of ['a','b']){const path=join(f.c.stateDir,`oc_${id}.json`),value=await jsonFile(path);value.messages[0].state='completed';await save(path,value);}
    await save(f.spec.topicConfigFile,{...f.c,enabledChatIds:undefined,allowTopicCreation:true});
    const spec={...f.spec,scope:'registered-topics' as const};await prepareDeployment(spec,f.stage);
    const newRow={...f.registry.topics[0]!,requestId:'new-request',chatId:'oc_new',threadId:'thread-new'};
    const newLedger=join(f.c.stateDir,'oc_new.json');
    await save(newLedger,{version:1,binding:{appId:f.c.appId,chatId:'oc_new',ownerOpenId:f.c.ownerOpenId,projectId:'project',projectRoot:dir,threadId:'thread-new'},messages:[]});
    f.registry.topics.push(newRow);await save(f.c.registryFile,f.registry);
    const current=await verifyDeployment(f.stage);expect(current.ledgers).toHaveLength(4);expect(current.snapshot.bindings).toHaveLength(3);
    const bytes=await readFile(newLedger);await save(newLedger,{...JSON.parse(bytes.toString()),binding:{chatId:'oc_foreign'}});
    await expect(verifyDeployment(f.stage)).rejects.toThrow('Ledger identity');await writeFile(newLedger,bytes);
    f.registry.topics[0]!.threadId='changed-original';await save(f.c.registryFile,f.registry);
    await expect(verifyDeployment(f.stage)).rejects.toThrow('Original topic bindings changed');
    f.registry.topics.shift();await save(f.c.registryFile,f.registry);
    await expect(verifyDeployment(f.stage)).rejects.toThrow('Original topic bindings changed');
  });
  it('preserves the managed quit policy through the actual source, copied host and cold plan chain',async()=>{
    const {spec,stage}=await fixture();spec.legacy.scheduledTaskName='LarkChannelBridge.Bot.codex';
    await mkdir(join(dir,'bin'));await mkdir(join(dir,'dist'));
    for(const relative of ['bin/lark-chatgpt-runtime-supervisor.mjs','bin/desktop-cold-launch.ps1','dist/desktop-runtime-supervisor.js','bin/desktop-runtime-control.ps1','bin/lark-chatgpt-host.mjs','bin/lark-chatgpt-topics.mjs','bin/desktop-package-broker.ps1','bin/desktop-package-broker-task.ps1']){
      const path=join(dir,relative);await writeFile(path,'FIXTURE_PROGRAM','utf8');spec.artifactFiles.push(path);
    }
    await prepareDeployment(spec,stage);
    const p=await prepareColdRuntime(stage,join(dir,'managed-runtime'),dir,undefined,'new-only',{mode:'stop-with-desktop',acceptanceWindow:true});
    expect(await verifyColdRuntimePlan(p.planFile,p.planSha256)).toMatchObject({serviceMode:'stop-with-desktop',serviceAcceptanceWindow:true});
    const actual=await verifyDeployment(join(dir,'managed-runtime','stage'));expect(actual.host.desktopQuitPolicy).toBe('stop-with-desktop');
    expect(await readFile(join(dir,'managed-runtime','stage','host.json'),'utf8')).toContain('stop-with-desktop');expect((await verifyDeployment(stage)).host.desktopQuitPolicy).toBeUndefined();
    expect(await readFile(join(dir,'managed-runtime','stage','host.json'),'utf8')).not.toContain('DO_NOT_COPY');
  });
  it('rejects an unsupported quit policy instead of silently dropping it from the backup',async()=>{
    const {spec,stage,host}=await fixture();await save(spec.hostConfigFile,{...host,desktopQuitPolicy:'always-reopen'});await expect(prepareDeployment(spec,stage)).rejects.toThrow('quit policy');
  });
  it('backs up only public configuration, leaves original state byte identical, and never overwrites a stage', async () => {
    const { c, spec, stage } = await fixture(), before = await readFile(c.registryFile, 'utf8');
    await prepareDeployment({ ...spec, appSecret: 'DO_NOT_COPY' }, stage);
    const files = await Promise.all(['manifest.json', 'host.json', 'topics.json', 'legacy-launch.json'].map(f => readFile(join(stage, f), 'utf8')));
    expect(files.join('')).not.toContain('DO_NOT_COPY'); expect(files.join('')).not.toContain('PRIVATE_PROMPT');
    expect(await readFile(c.registryFile, 'utf8')).toBe(before);
    const verified = await verifyDeployment(stage); expect(verified.ledgers.map(l => l.counts)).toEqual([{ uncertain: 1 }, { uncertain: 1 }, { failed: 1 }]);
    await expect(prepareDeployment(spec, stage)).rejects.toMatchObject({ code: 'EEXIST' });
  });
  it('refuses staging C uncertain or busy while allowing untouched A/B historical uncertain', async () => {
    const { c, spec, stage } = await fixture(), file = join(c.stateDir, 'oc_c.json'), original = await jsonFile(file);
    for (const state of ['uncertain', 'running', 'submitting', 'queued']) {
      await save(file, { ...original, messages: [{ ...original.messages[0], state }] });
      await expect(prepareDeployment(spec, stage)).rejects.toThrow('busy or uncertain');
    }
  });
  it('detects changed pinned artifacts, backups, config and binding rather than clearing state', async () => {
    const { c, spec, stage, registry } = await fixture(); await prepareDeployment(spec, stage);
    await writeFile(spec.artifactFiles[0]!, 'changed', 'utf8'); await expect(verifyDeployment(stage)).rejects.toThrow('Pinned');
    await writeFile(spec.artifactFiles[0]!, 'fixture', 'utf8');
    await save(c.registryFile, { ...registry, topics: registry.topics.map(t => t.chatId === 'oc_a' ? { ...t, threadId: 'changed' } : t) });
    await expect(verifyDeployment(stage)).rejects.toThrow('Original topic');
    await save(c.registryFile, registry); await writeFile(join(stage, 'host.json'), '{}', 'utf8'); await expect(verifyDeployment(stage)).rejects.toThrow('backup changed');
  });
  it('inspects newly completed messages without restoring old ledger hashes or printing their content', async () => {
    const { c, spec, stage } = await fixture(); await prepareDeployment(spec, stage);
    const file = join(c.stateDir, 'oc_c.json'), saved = await jsonFile(file);
    saved.messages.push({ messageId: 'new', prompt: 'SECRET_PROMPT', replyInThread: false, state: 'completed', result: 'SECRET_RESULT', receipt: 'receipt' });
    await save(file, saved);
    const report = await diagnoseDeployment(stage); expect(report.ledgers[2]?.counts).toEqual({ failed: 1, completed: 1 });
    expect(JSON.stringify(report)).not.toContain('SECRET_'); expect(report.findings).toContain('desktop_lease_unavailable');
    expect(report.rollback.ledgerRestoreAllowed).toBe(false); expect(await jsonFile(file)).toEqual(saved);
    saved.messages.push({ messageId: 'ambiguous', prompt: 'PRIVATE_PROMPT', replyInThread: false, state: 'completed', result: 'SECRET_RESULT', deliveryAttempted: true });
    saved.messages.push({ messageId: 'retrieve', prompt: '/result ambiguous', replyInThread: false, state: 'completed', result: 'SECRET_RESULT', receipt: 'retrieval-receipt', deliveryAttempted: true });
    await save(file, saved);
    const retrieved = await diagnoseDeployment(stage);
    expect(retrieved.ledgers[2]).toMatchObject({ savedResultsPending: 0, deliveryReceiptsUnconfirmed: 1, savedResultsRetrieved: 1 });
    expect(retrieved.findings).toContain('original_delivery_receipt_unconfirmed');
    expect(retrieved.findings).not.toContain('saved_result_pending');
    expect(await jsonFile(file)).toEqual(saved); // Original receipt stays absent.
  });
  it('blocks rollback readiness while either new runtime lock is live and does not remove locks', async () => {
    const { c, spec, stage } = await fixture(); await prepareDeployment(spec, stage);
    const release = await lockfile.lock(c.registryFile, { realpath: false });
    try { expect((await diagnoseDeployment(stage)).rollback.newRuntimeStopped).toBe(false); expect(await lockfile.check(c.registryFile, { realpath: false })).toBe(true); }
    finally { await release(); }
    expect((await diagnoseDeployment(stage)).rollback.newRuntimeStopped).toBe(true);
  });
  it('rejects incomplete manifest and never accepts unknown secret fields in launch references', async () => {
    const { spec, stage } = await fixture();
    expect(JSON.stringify(parseDeploymentSpec({ ...spec, legacy: { ...spec.legacy, token: 'SECRET' } }))).not.toContain('SECRET');
    await prepareDeployment(spec, stage); const manifest = await jsonFile(join(stage, 'manifest.json')); manifest.files = [];
    await save(join(stage, 'manifest.json'), manifest); await expect(verifyDeployment(stage)).rejects.toThrow('proofs are incomplete');
  });
  it('refuses staging pending selected approvals and preserves excluded open cards', async () => {
    const { c, spec, stage } = await fixture(), file = `${c.registryFile}.approvals.json`;
    const binding = { appId: c.appId, ownerOpenId: c.ownerOpenId, entryChatId: c.entryChatId };
    await save(file, { version: 1, binding, cards: [{ token: 'c', chatId: 'oc_c', state: 'open', messageId: 'receipt' }] });
    await expect(prepareDeployment(spec, stage)).rejects.toThrow('pending approval');
    const excluded = { version: 1, binding, cards: [{ token: 'a', chatId: 'oc_a', state: 'open', messageId: 'receipt' }] };
    await save(file, excluded); await prepareDeployment(spec, stage);
    expect((await diagnoseDeployment(stage)).findings).not.toContain('approval_card_pending');
    expect(await jsonFile(file)).toEqual(excluded);
  });
});

it('reads native approval and paginated queues without submitting, resuming or replying to approvals', async () => {
  const { c } = await fixture(), methods: string[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  c.endpoint = `ws://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const binding = (await jsonFile(join(c.stateDir, 'oc_c.json'))).binding;
  let scenario = 'waiting';
  server.on('connection', socket => socket.on('message', data => {
    const m = JSON.parse(data.toString()); if (m.id === undefined) return;
    methods.push(m.method); let result: any = {}, error: any;
    if (m.method === 'project/list') result = { data: [{ id: 'project', roots: [{ path: dir }] }] };
    if (m.method === 'thread/read') {
      result = { thread: { id: binding.threadId, cwd: dir, projectId: 'project', status: { type: 'active', activeFlags: ['waitingOnApproval'] } } };
      if (scenario === 'denied') error = { code: 403, message: 'Permission denied SECRET_ERROR' };
    }
    if (m.method === 'thread/turns/list') result = { data: scenario === 'history' ? [] : [{ status: 'completed', completedAt: 1 }] };
    if (m.method === 'thread/queue/list') result = m.params.cursor ? { data: [{ id: 'pending' }] } : { data: [], nextCursor: 'second' };
    socket.send(JSON.stringify(error ? { id: m.id, error } : { id: m.id, result }));
  }));
  try {
    expect(await inspectNativeBinding(c, binding)).toEqual({ verified: true, findings: ['waiting_approval', 'native_queue_pending'] });
    scenario = 'denied'; const denied = await inspectNativeBinding(c, binding);
    expect(denied).toEqual({ verified: false, findings: ['permission_denied'] }); expect(JSON.stringify(denied)).not.toContain('SECRET');
    scenario = 'history'; expect(await inspectNativeBinding(c, binding)).toEqual({ verified: false, findings: ['history_incompatible'] });
    expect(methods.every(m => ['initialize', 'project/list', 'thread/read', 'thread/turns/list', 'thread/queue/list'].includes(m))).toBe(true);
  } finally { for (const s of server.clients) s.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
