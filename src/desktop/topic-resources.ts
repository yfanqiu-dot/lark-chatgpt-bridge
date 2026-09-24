import { realpath } from 'node:fs/promises';
import { DesktopRpc } from './rpc';
import { readDesktopToolConfig } from './backend';
import type { TopicConfig, TopicProject } from './topics';
import { assertProjectThread, type TopicResources } from './topic-provisioner';

async function withRpc<T>(endpoint: string, use: (rpc: DesktopRpc) => Promise<T>): Promise<T> {
  const rpc = new DesktopRpc(endpoint);
  try { await rpc.connect(); return await use(rpc); } finally { rpc.close(); }
}

export class CodexTopicResources implements Pick<TopicResources, 'verifyProject' | 'createThread' | 'verifyThread' | 'nameThread'> {
  constructor(readonly config: TopicConfig) {}
  async verifyProject(project: TopicProject): Promise<void> {
    const root = await realpath(project.projectRoot);
    await withRpc(this.config.endpoint, async rpc => {
      let cursor: string | undefined; const seen = new Set<string>();
      do {
        const page = await rpc.call('project/list', cursor ? { cursor } : {});
        const found = page.data?.find((p: any) => p.id === project.projectId);
        if (found) {
          const roots = await Promise.all((found.roots ?? []).map((r: any) => realpath(r.path)));
          if (!roots.includes(root)) throw new Error('Desktop project ID/root mismatch');
          return;
        }
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('Repeated desktop project cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      throw new Error('Desktop project is not available');
    });
  }
  async createThread(project: TopicProject, _title: string): Promise<string> {
    const root = await realpath(project.projectRoot);
    const config = await readDesktopToolConfig(this.config);
    return withRpc(this.config.endpoint, async rpc => {
      const result = await rpc.call('thread/start', { cwd: root, projectId: project.projectId, config });
      const id = result.thread?.id;
      if (typeof id !== 'string' || !id) throw new Error('Desktop task ID missing from thread/start');
      // Save the returned ID before any further verification or title mutation.
      return id;
    });
  }
  async verifyThread(project: TopicProject, threadId: string): Promise<void> {
    const root = await realpath(project.projectRoot);
    await withRpc(this.config.endpoint, async rpc => {
      const result = await rpc.call('thread/read', { threadId, includeTurns: false });
      assertProjectThread(result.thread, project, root);
      if (result.thread.id !== threadId) throw new Error('Desktop task ID mismatch');
    });
  }
  async nameThread(threadId: string, title: string): Promise<void> {
    await withRpc(this.config.endpoint, rpc => rpc.call('thread/name/set', { threadId, name: title }));
  }
}

interface FeishuResult { code?: number; msg?: string; data?: any; tenant_access_token?: string; expire?: number }
export class FeishuTopicResources implements Pick<TopicResources, 'createChat' | 'verifyChat'> {
  private token?: string;
  private expiresAt = 0;
  constructor(readonly config: TopicConfig, readonly secret: string, private readonly fetcher: typeof fetch = fetch) {}
  private async accessToken(): Promise<string> {
    if (this.token && this.expiresAt > Date.now() + 60_000) return this.token;
    const response = await this.fetcher('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.config.appId, app_secret: this.secret }), signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json() as FeishuResult;
    if (!response.ok || body.code !== 0 || !body.tenant_access_token) throw new Error(`Feishu token exchange failed (${response.status}, ${body.code ?? '?'})`);
    this.token = body.tenant_access_token; this.expiresAt = Date.now() + Math.max(60, body.expire ?? 7200) * 1000;
    return this.token;
  }
  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const response = await this.fetcher(`https://open.feishu.cn/open-apis${path}`, {
      method, headers: { Authorization: `Bearer ${await this.accessToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000),
    });
    const result = await response.json() as FeishuResult;
    if (!response.ok || result.code !== 0) throw new Error(`Feishu ${method} ${path.split('?')[0]} failed (${response.status}, ${result.code ?? '?'}, ${result.msg ?? ''})`);
    return result.data;
  }
  async createChat(title: string, ownerOpenId: string): Promise<string> {
    // The creating bot is automatically a member. The user is explicitly invited.
    const data = await this.request('POST', '/im/v1/chats?user_id_type=open_id', {
      name: title, chat_type: 'private', chat_mode: 'group', owner_id: ownerOpenId, user_id_list: [ownerOpenId],
    });
    return data?.chat_id ?? data?.chat?.chat_id;
  }
  async verifyChat(chatId: string, ownerOpenId: string): Promise<void> {
    const data = await this.request('GET', `/im/v1/chats/${encodeURIComponent(chatId)}?user_id_type=open_id`);
    const chat = data?.chat ?? data;
    if (chat?.chat_id !== chatId) throw new Error('Feishu chat identity mismatch');
    let cursor: string | undefined; const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ member_id_type: 'open_id', page_size: '100', ...(cursor ? { page_token: cursor } : {}) });
      const members = await this.request('GET', `/im/v1/chats/${encodeURIComponent(chatId)}/members?${query}`);
      if (members?.items?.some((m: any) => m.member_id === ownerOpenId || m.id === ownerOpenId)) return;
      cursor = members?.page_token || undefined;
      if (cursor && seen.has(cursor)) throw new Error('Repeated Feishu member cursor');
      if (cursor) seen.add(cursor);
    } while (cursor);
    throw new Error('The owner is not a member of the created Feishu group');
  }
}

export function topicResources(config: TopicConfig, secret: string): TopicResources {
  const codex = new CodexTopicResources(config);
  const feishu = new FeishuTopicResources(config, secret);
  return {
    verifyProject: project => codex.verifyProject(project), createThread: (project, title) => codex.createThread(project, title),
    verifyThread: (project, id) => codex.verifyThread(project, id), nameThread: (id, title) => codex.nameThread(id, title),
    createChat: (title, owner) => feishu.createChat(title, owner), verifyChat: (id, owner) => feishu.verifyChat(id, owner),
  };
}
