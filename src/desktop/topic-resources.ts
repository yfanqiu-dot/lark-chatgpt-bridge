import { realpath } from 'node:fs/promises';
import { DesktopRpc } from './rpc';
import { readDesktopToolConfig } from './backend';
import type { TopicConfig, TopicProject } from './topics';
import { assertProjectThread, type TopicResources } from './topic-provisioner';

async function withRpc<T>(endpoint: string, use: (rpc: DesktopRpc) => Promise<T>): Promise<T> {
  const rpc = new DesktopRpc(endpoint);
  try { await rpc.connect(); return await use(rpc); } finally { rpc.close(); }
}

export const TOPIC_BOOTSTRAP_PROMPT = '[QIU bridge 初始化] 新话题已创建。请只回复“话题已就绪”，不要调用工具或修改文件；等待用户在飞书群中的下一条指令。';

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
  async createThread(project: TopicProject, title: string, saveId: (threadId: string) => Promise<void>): Promise<string> {
    const root = await realpath(project.projectRoot);
    const config = await readDesktopToolConfig(this.config, 45_000);
    return withRpc(this.config.endpoint, async rpc => {
      const result = await rpc.call('thread/start', { cwd: root, projectId: project.projectId, config });
      const id = result.thread?.id;
      if (typeof id !== 'string' || !id) throw new Error('Desktop task ID missing from thread/start');
      assertProjectThread(result.thread, project, root);
      // An empty task is not durable when this connection closes. Save its ID,
      // then name it and start a harmless first turn on the same connection.
      await saveId(id);
      await rpc.call('thread/name/set', { threadId: id, name: title });
      const started: { turn?: { id?: string } } = await rpc.call('turn/start', { threadId: id, input: [{ type: 'text', text: TOPIC_BOOTSTRAP_PROMPT }] });
      const turnId = started.turn?.id;
      if (!turnId) throw new Error('Desktop topic initialization turn ID missing; reconcile the saved task');
      const until = Date.now() + 90_000;
      while (Date.now() < until) {
        const page: { data?: Array<{ id?: string; status?: string; completedAt?: unknown }> } = await rpc.call('thread/turns/list', { threadId: id, limit: 10, itemsView: 'notLoaded' });
        const turn = page.data?.find(item => item.id === turnId);
        if (turn?.status === 'completed' && turn.completedAt != null) return id;
        // Paginated history may label an unfinished rollout interrupted. Only
        // persisted completion is a terminal result, as in DesktopBackend.
        if (turn?.completedAt != null && ['failed','interrupted','cancelled'].includes(turn.status ?? '')) throw new Error(`Desktop topic initialization ended as ${turn.status}; reconcile the saved task`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('Desktop topic initialization is still running; reconcile the saved task before retrying');
    });
  }
  async verifyThread(project: TopicProject, threadId: string): Promise<void> {
    const root = await realpath(project.projectRoot);
    await withRpc(this.config.endpoint, async rpc => {
      const result = await rpc.call('thread/read', { threadId, includeTurns: false });
      assertProjectThread(result.thread, project, root);
      if (result.thread.id !== threadId) throw new Error('Desktop task ID mismatch');
      const turns: { data?: Array<{ status?: string; completedAt?: unknown }> } = await rpc.call('thread/turns/list', { threadId, limit: 5, itemsView: 'notLoaded' });
      if (!turns.data?.some(turn => turn.status === 'completed' && turn.completedAt != null)) throw new Error('Desktop task has no durable completed turn');
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
    // Feishu's chat/get response omits chat_id; the ID is the successful lookup key.
    if (!chat || (chat.chat_id && chat.chat_id !== chatId) || chat.chat_mode !== 'group' || chat.chat_type !== 'private' || chat.chat_status !== 'normal' || chat.owner_id !== ownerOpenId) throw new Error('Feishu chat identity mismatch');
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
    verifyProject: project => codex.verifyProject(project), createThread: (project, title, saveId) => codex.createThread(project, title, saveId),
    verifyThread: (project, id) => codex.verifyThread(project, id), nameThread: (id, title) => codex.nameThread(id, title),
    createChat: (title, owner) => feishu.createChat(title, owner), verifyChat: (id, owner) => feishu.verifyChat(id, owner),
  };
}
