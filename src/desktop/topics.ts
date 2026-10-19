import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import { loopbackEndpoint } from './rpc';

export interface TopicProject { key: string; projectId: string; projectRoot: string }
export interface StaticTopicBinding { chatId: string; projectKey: string; threadId: string; stateFile: string }
export interface TopicConfig {
  appId: string; appSecretEnv: string; ownerOpenId: string; entryChatId: string;
  endpoint: string; connectionFile: string; registryFile: string; stateDir: string;
  projects: TopicProject[]; requireMention: boolean; maxQueue: number; model?: string;
  existing?: StaticTopicBinding;
  /** Explicit owner-only P2P control channel, separate from group bindings. */
  directControl?: StaticTopicBinding;
  /** Omitted means all bindings. Gray rollout never provisions new resources. */
  enabledChatIds?: string[];
  allowTopicCreation?: boolean;
}

export function parseTopicConfig(raw: unknown): TopicConfig {
  if (!raw || typeof raw !== 'object') throw new Error('Topic config must be an object');
  const r = raw as Record<string, unknown>;
  const str = (key: string): string => { const value = r[key]; if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${key}`); return value.trim(); };
  const absolute = (key: string): string => { const value = str(key); if (!isAbsolute(value)) throw new Error(`${key} must be absolute`); return resolve(value); };
  if (!Array.isArray(r.projects) || !r.projects.length) throw new Error('At least one project is required');
  const projects = r.projects.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid project');
    const p = value as Record<string, unknown>;
    if (typeof p.key !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(p.key) || typeof p.projectId !== 'string' || !p.projectId.trim() || typeof p.projectRoot !== 'string' || !isAbsolute(p.projectRoot)) throw new Error('Invalid project key, ID, or root');
    return { key: p.key, projectId: p.projectId.trim(), projectRoot: resolve(p.projectRoot) };
  });
  if (new Set(projects.map(p => p.key)).size !== projects.length || new Set(projects.map(p => p.projectId)).size !== projects.length) throw new Error('Duplicate project key or ID');
  const config: TopicConfig = {
    appId: str('appId'), appSecretEnv: str('appSecretEnv'), ownerOpenId: str('ownerOpenId'), entryChatId: str('entryChatId'),
    endpoint: loopbackEndpoint(str('endpoint')), connectionFile: absolute('connectionFile'), registryFile: absolute('registryFile'), stateDir: absolute('stateDir'),
    projects, requireMention: r.requireMention !== false, maxQueue: Number.isInteger(r.maxQueue) && Number(r.maxQueue) > 0 ? Number(r.maxQueue) : 20,
    ...(typeof r.model === 'string' && r.model.trim() ? { model: r.model.trim() } : {}),
  };
  if (!/^cli_[a-zA-Z0-9]+$/.test(config.appId) || !/^oc_[a-zA-Z0-9]+$/.test(config.entryChatId) || !/^ou_[a-zA-Z0-9]+$/.test(config.ownerOpenId) || !/^[A-Z][A-Z0-9_]*$/.test(config.appSecretEnv)) throw new Error('Invalid Feishu ID or secret variable');
  for (const key of ['existing','directControl'] as const) if (r[key] !== undefined) {
    const e = r[key] as Record<string, unknown>;
    if (!e || typeof e !== 'object' || typeof e.chatId !== 'string' || !/^oc_[a-zA-Z0-9]+$/.test(e.chatId) || typeof e.projectKey !== 'string' || !projects.some(p => p.key === e.projectKey) || typeof e.threadId !== 'string' || !e.threadId || typeof e.stateFile !== 'string' || !isAbsolute(e.stateFile)) throw new Error('Invalid existing desktop binding');
    config[key] = { chatId: e.chatId, projectKey: e.projectKey, threadId: e.threadId, stateFile: resolve(e.stateFile) };
  }
  const fixed = staticTopicBindings(config);
  if (config.directControl?.chatId === config.entryChatId || ['chatId','threadId','stateFile'].some(key => new Set(fixed.map(b=>key==='stateFile'&&process.platform==='win32'?b.stateFile.toLowerCase():b[key as keyof StaticTopicBinding])).size !== fixed.length)) throw new Error('Conflicting control or existing bindings');
  if (r.allowTopicCreation !== undefined && typeof r.allowTopicCreation !== 'boolean') throw new Error('allowTopicCreation must be boolean');
  if (r.allowTopicCreation !== undefined) config.allowTopicCreation = r.allowTopicCreation;
  if (r.enabledChatIds !== undefined) {
    if (!Array.isArray(r.enabledChatIds) || !r.enabledChatIds.length || r.enabledChatIds.some(id => typeof id !== 'string' || !/^oc_[a-zA-Z0-9]+$/.test(id)) || new Set(r.enabledChatIds).size !== r.enabledChatIds.length) throw new Error('Invalid enabledChatIds');
    if (config.allowTopicCreation !== false) throw new Error('Gray rollout requires allowTopicCreation=false');
    config.enabledChatIds = [...r.enabledChatIds];
  }
  return config;
}

export function topicChatEnabled(config: TopicConfig, chatId: string): boolean {
  return config.enabledChatIds === undefined || config.enabledChatIds.includes(chatId);
}

export function staticTopicBindings(config: TopicConfig): StaticTopicBinding[] {
  return [config.existing,config.directControl].filter((b):b is StaticTopicBinding=>b!==undefined);
}

export function topicControlChat(config: TopicConfig, chatId: string): boolean {
  return chatId === config.entryChatId || chatId === config.directControl?.chatId;
}

/** SDK and router both restrict DMs; no pairing or open-DM fallback. */
export function topicChannelPolicy(config: TopicConfig) {
  return {dmMode:config.directControl && topicChatEnabled(config,config.directControl.chatId)?'allowlist' as const:'disabled' as const,
    dmAllowlist:config.directControl?[config.ownerOpenId]:[],requireMention:false,respondToMentionAll:false};
}

/** Fail before connecting Feishu or starting any controller. */
export function validateTopicScope(config: TopicConfig, rows: TopicRecord[]): void {
  const bindings = rows.filter(r => r.stage === 'active');
  if (staticTopicBindings(config).some(b => rows.some(r => r.chatId === b.chatId || r.threadId === b.threadId))) throw new Error('Existing binding conflicts with topic registry');
  for (const row of bindings.filter(r => topicChatEnabled(config, r.chatId!))) {
    const project = config.projects.find(p => p.key === row.projectKey);
    if (!project || project.projectId !== row.projectId || project.projectRoot !== resolve(row.projectRoot)) throw new Error('Selected topic binding does not match configured project');
  }
  for (const id of config.enabledChatIds ?? []) if (!staticTopicBindings(config).some(b=>b.chatId===id) && !bindings.some(r => r.chatId === id)) throw new Error(`Selected chat has no active binding: ${id}`);
}

export type TopicStage = 'planned' | 'thread_creating' | 'thread_initializing' | 'thread_ready' | 'chat_creating' | 'chat_ready' | 'active';
export interface TopicRecord {
  requestId: string; title: string; projectKey: string; projectId: string; projectRoot: string;
  stage: TopicStage; threadId?: string; chatId?: string; createdAt: string; updatedAt: string; noticeAttempted?: boolean; noticeReceipt?: string;
}

/** Single-writer journal. The runtime must hold the same application lock as P1. */
export class TopicRegistry {
  private rows: TopicRecord[] = [];
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}
  async load(readOnly = false): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.topics)) throw new Error('Topic registry version mismatch');
      const requests = new Set<string>(), chats = new Set<string>(), threads = new Set<string>();
      for (const row of saved.topics as TopicRecord[]) {
        if (!row || typeof row.requestId !== 'string' || requests.has(row.requestId) || !['planned','thread_creating','thread_initializing','thread_ready','chat_creating','chat_ready','active'].includes(row.stage) || typeof row.title !== 'string' || !row.title || typeof row.projectKey !== 'string' || !row.projectKey || typeof row.projectId !== 'string' || !row.projectId || typeof row.projectRoot !== 'string' || !isAbsolute(row.projectRoot)) throw new Error('Malformed topic registry');
        if (['thread_initializing','thread_ready','chat_creating','chat_ready','active'].includes(row.stage) && !row.threadId) throw new Error('Topic task ID is missing');
        if (['chat_ready','active'].includes(row.stage) && !row.chatId) throw new Error('Topic chat ID is missing');
        if (row.chatId && (chats.has(row.chatId) || !/^oc_[a-zA-Z0-9]+$/.test(row.chatId))) throw new Error('Duplicate or invalid chat binding');
        if (row.threadId && threads.has(row.threadId)) throw new Error('Duplicate desktop task binding');
        requests.add(row.requestId); if (row.chatId) chats.add(row.chatId); if (row.threadId) threads.add(row.threadId);
      }
      this.rows = saved.topics;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!readOnly) await this.save();
  }
  all(): TopicRecord[] { return structuredClone(this.rows); }
  byRequest(id: string): TopicRecord | undefined { return this.all().find(r => r.requestId === id); }
  byChat(id: string): TopicRecord | undefined { return this.all().find(r => r.chatId === id && r.stage === 'active'); }
  async add(row: TopicRecord): Promise<TopicRecord> {
    const existing = this.byRequest(row.requestId); if (existing) return existing;
    this.rows.push(structuredClone(row)); await this.save(); return structuredClone(row);
  }
  async advance(id: string, stage: TopicStage, patch: Pick<Partial<TopicRecord>, 'threadId' | 'chatId'> = {}): Promise<TopicRecord> {
    const row = this.rows.find(r => r.requestId === id); if (!row) throw new Error('Unknown topic request');
    if (patch.threadId && this.rows.some(r => r.requestId !== id && r.threadId === patch.threadId)) throw new Error('Desktop task already belongs to another topic');
    if (patch.chatId && this.rows.some(r => r.requestId !== id && r.chatId === patch.chatId)) throw new Error('Feishu group already belongs to another topic');
    Object.assign(row, patch, { stage, updatedAt: new Date().toISOString() });
    await this.save(); return structuredClone(row);
  }
  async notice(id: string, receipt?: string): Promise<void> {
    const row = this.rows.find(r => r.requestId === id); if (!row || row.stage !== 'active') throw new Error('Topic is not active');
    row.noticeAttempted = true; if (receipt) row.noticeReceipt = receipt;
    row.updatedAt = new Date().toISOString(); await this.save();
  }
  private save(): Promise<void> {
    const data = JSON.stringify({ version: 1, topics: this.rows }, null, 2);
    this.writes = this.writes.then(() => writeFileAtomic(this.path, data)); return this.writes;
  }
}

/** Only this explicit command creates resources. A plain message is never a topic request. */
export function parseCreateTopic(content: string): { projectKey: string; title: string } | undefined {
  const match = /^\/topic\s+new\s+([a-zA-Z0-9_-]{1,40})\s+(.+)$/i.exec(content.trim());
  if (!match) return;
  const title = match[2]!.trim();
  if (!title || [...title].length > 60 || /[\r\n\x00-\x1f]/.test(title)) throw new Error('话题名称须为 1–60 个可见字符');
  return { projectKey: match[1]!, title };
}
