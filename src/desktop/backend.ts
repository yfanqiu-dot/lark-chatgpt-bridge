import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DesktopRpc, RpcError, type RpcMessage } from './rpc';
import type { DesktopConfig } from './config';
import { desktopToolOverrides } from './resume-tools';

export interface Approval { token: string; requestId: string | number; threadId: string; turnId: string; method: string; description: string; decisions: string[]; submitted?: boolean }
export interface TurnResult { turnId: string; status: 'completed' | 'interrupted' | 'failed'; text: string }
export interface BackendHooks {
  submitting(): Promise<void>;
  started(turnId: string): Promise<void>;
  approval(request: Approval): Promise<void>;
  resolved(token: string): Promise<void>;
  state(status: string): Promise<void>;
}
export interface RpcTransport {
  readonly connected: boolean;
  connect(): Promise<void>; close(): void;
  call<T = any>(method: string, params?: unknown): Promise<T>;
  respond(id: string | number, result: unknown): void;
  onMessage(listener: (m: RpcMessage) => void): () => void;
}
export interface BackendOptions {
  rpcFactory?: () => RpcTransport;
  toolConfig?: () => Promise<Record<string, unknown>>;
  pollMs?: number;
  reconnectDelayMs?: number;
}
export class UncertainExecution extends Error {}
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/** Desktop and bridge use one server; this class never spawns or kills that server. */
export class DesktopBackend {
  private rpc?: RpcTransport;
  private inbox: RpcMessage[] = [];
  private activeTurn?: string;
  private completedTurn?: any;
  private busy = false;
  private stopping = false;
  private disconnected = false;
  private approvals = new Map<string, Approval>();
  constructor(readonly config: DesktopConfig, private readonly options: BackendOptions = {}) {}
  pendingApprovals(): Approval[] { return structuredClone([...this.approvals.values()]); }
  get currentTurn(): string | undefined { return this.activeTurn; }
  private async connect(resume = true): Promise<void> {
    if (this.disconnected) throw new Error('Desktop client is shutting down');
    this.rpc?.close();
    this.inbox = [];
    this.rpc = this.options.rpcFactory?.() ?? new DesktopRpc(this.config.endpoint);
    this.rpc.onMessage(m => { this.inbox.push(m); });
    try {
      const config = await (this.options.toolConfig?.() ?? this.readToolConfig());
      await this.rpc.connect();
      const expectedRoot = await realpath(this.config.projectRoot);
      let cursor: string | undefined; const seen = new Set<string>(); let matched: any;
      do {
        const page = await this.rpc.call('project/list', { ...(cursor ? { cursor } : {}) });
        matched = page.data?.find((p: any) => p.id === this.config.projectId);
        if (matched) break;
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('Repeated project cursor'); if (cursor) seen.add(cursor);
      } while (cursor);
      if (!matched || !(await Promise.all((matched.roots ?? []).map((r: any) => realpath(r.path)))).includes(expectedRoot)) throw new Error('Desktop project ID/root mismatch');
      // Read identity before resume/config mutation. Never attach a wrong task.
      const read = await this.rpc.call('thread/read', { threadId: this.config.threadId, includeTurns: false });
      this.checkThread(read.thread, expectedRoot);
      if (resume) await this.resumeThread(config, expectedRoot);
    } catch (e) { this.rpc.close(); throw e; }
  }
  private async resumeThread(config: Record<string, unknown>, root: string): Promise<void> {
    const resumed = await this.rpc!.call('thread/resume', { threadId: this.config.threadId, excludeTurns: true, config });
    this.checkThread(resumed.thread, root);
  }
  private checkThread(thread: any, root: string): void {
    if (!thread || thread.id !== this.config.threadId || thread.projectId !== this.config.projectId || resolve(thread.cwd) !== resolve(root)) throw new Error('Desktop thread/project/cwd mismatch');
  }
  private async readToolConfig(): Promise<Record<string, unknown>> {
    const m = JSON.parse(await readFile(this.config.connectionFile, 'utf8'));
    if (m.endpoint !== this.config.endpoint || m.version !== 1 || Date.now() - m.verifiedAt > 60_000 || m.verifiedAt > Date.now() + 1000 || !Number.isFinite(m.verifiedAt)) throw new Error('Desktop connection lease expired or mismatched');
    if (!Number.isInteger(m.desktopPid) || m.desktopPid <= 0 || m.pipeServerPid !== m.desktopPid || !m.toolNames?.includes('list_projects')) throw new Error('Desktop tool endpoint not verified');
    try { process.kill(m.desktopPid, 0); } catch { throw new Error('Desktop process is unavailable'); }
    if (!/^\\\\\.\\pipe\\codex-browser-use-[\w-]+$/.test(m.pipe)) throw new Error('Invalid desktop tool pipe');
    if (!m.mcpServer?.command || !m.mcpServer?.cwd) throw new Error('Missing installed MCP definition');
    return desktopToolOverrides(m.mcpServer,m.pipe);
  }
  async preflight(): Promise<void> { if (this.busy) throw new Error('Desktop turn already active'); try { await this.connect(false); } finally { this.rpc?.close(); } }
  /** Explicit runtime check: resume only the verified idle task; never start a turn. */
  async preflightTools(): Promise<void> {
    if(this.busy)throw new Error('Desktop turn already active');
    try {
      await this.connect(false);
      const read=await this.rpc!.call('thread/read',{threadId:this.config.threadId,includeTurns:false});
      if(read.thread.status?.type==='active')throw new Error('Desktop task is active; tool preflight deferred');
      await this.resumeThread(await(this.options.toolConfig?.()??this.readToolConfig()),await realpath(this.config.projectRoot));
      await this.verifyRuntimeTools();
    } finally {this.rpc?.close();}
  }
  private async verifyRuntimeTools(): Promise<void> {
    let cursor: string | undefined; const seen=new Set<string>();const until=Date.now()+15_000;
    do {
      const page=await this.rpc!.call('mcpServerStatus/list',{threadId:this.config.threadId,detail:'full',...(cursor?{cursor}:{})});
      if(!Array.isArray(page.data))throw new Error('Invalid task MCP status page');
      const server=page.data.find((s:any)=>s.name==='codex_app');
      if(server){
        if(['starting','notStarted'].includes(server.runtimeStatus) && Date.now()<until){cursor=undefined;seen.clear();await delay(this.options.pollMs??500);continue;}
        if(server.runtimeStatus!=='connected' || server.toolsError || !Object.values(server.tools??{}).some((t:any)=>t?.name==='list_projects'))throw new Error(`Task desktop tools are not connected (${server.runtimeStatus??'unknown'}); no turn submitted`);
        return;
      }
      cursor=page.nextCursor??undefined;
      if(cursor && seen.has(cursor))throw new Error('Repeated MCP status cursor');if(cursor)seen.add(cursor);
      if(!cursor)break;
    }while(true);
    throw new Error('Task desktop tool server is missing; no turn submitted');
  }
  async execute(prompt: string, hooks: BackendHooks, resumeTurnId?: string): Promise<TurnResult> {
    if (this.busy) throw new Error('Desktop turn already active');
    this.busy = true; this.stopping = false; this.disconnected = false; this.activeTurn = resumeTurnId; this.completedTurn = undefined;
    let submitted = Boolean(resumeTurnId);
    try {
      await this.connect(Boolean(resumeTurnId));
      if (!resumeTurnId) {
        // Desktop may own a turn. Queue without interrupting it or changing its policy.
        while (true) {
          const read = await this.rpc!.call('thread/read', { threadId: this.config.threadId, includeTurns: false });
          if (read.thread.status?.type !== 'active') break;
          if (this.stopping) return { turnId: '', status: 'interrupted', text: '已取消排队，桌面当前工作未停止。' };
          await hooks.state('等待桌面当前任务结束'); await delay(this.options.pollMs ?? 1000);
        }
        if (this.stopping) return { turnId: '', status: 'interrupted', text: '已取消。' };
        await this.resumeThread(await (this.options.toolConfig?.() ?? this.readToolConfig()), await realpath(this.config.projectRoot));
        await this.verifyRuntimeTools();
        await hooks.submitting(); submitted = true;
        const result = await this.rpc!.call('turn/start', {
          threadId: this.config.threadId,
          input: [{ type: 'text', text: prompt }],
          ...(this.config.model ? { model: this.config.model } : {}),
          // Preserve the task's existing permissions and approval reviewer.
        });
        if (!result.turn?.id) throw new UncertainExecution('turn/start response has no turn ID');
        this.activeTurn = result.turn.id;
        await hooks.started(this.activeTurn!);
      }
      let failures = 0;
      let unresolvedIdleReads = 0;
      let lastStatus = '';
      while (true) {
        try {
          if (!this.rpc!.connected) {
            for (const a of this.approvals.values()) await hooks.resolved(a.token);
            this.approvals.clear();
            await hooks.state('连接中断，正在核对原任务');
            await this.connect();
          }
          await this.processMessages(hooks);
          const historyTurn = await this.readTurn(this.activeTurn!);
          await this.processMessages(hooks);
          // Paginated history may normalize an unfinished rollout as interrupted.
          // Live completion wins; history needs a persisted completion timestamp.
          const turn = this.completedTurn ?? (historyTurn?.completedAt != null ? historyTurn : undefined);
          if (turn && ['completed', 'interrupted', 'failed'].includes(turn.status)) {
            const items = await this.readItems(this.activeTurn!);
            const text = items.filter((i: any) => i.type === 'agentMessage' && i.phase === 'final_answer').map((i: any) => i.text).join('\n\n');
            return { turnId: this.activeTurn!, status: turn.status, text: text || turn.error?.message || (turn.status === 'interrupted' ? '当前对话轮次已停止；已经启动的外部命令可能继续运行。' : '该轮次已结束，没有最终文本。') };
          }
          const read = await this.rpc!.call('thread/read', { threadId: this.config.threadId, includeTurns: false });
          if (read.thread.status?.type === 'active') unresolvedIdleReads = 0;
          else if (++unresolvedIdleReads >= 3) throw new UncertainExecution(`原任务 ${this.activeTurn} 没有实时完成事件或可靠的结束时间，需核对；未重新提交。`);
          const status = read.thread.status?.activeFlags?.includes('waitingOnApproval') ? '等待审批' : '正在执行';
          if (status !== lastStatus) { lastStatus = status; await hooks.state(status); }
          if (this.stopping) await this.interruptKnownTurn();
          failures = 0;
          await delay(this.options.pollMs ?? 1000);
        } catch (e) {
          if(e instanceof UncertainExecution)throw e;
          this.rpc?.close();
          if (++failures >= 3) throw new UncertainExecution(`连接恢复失败，原任务 ${this.activeTurn} 待核对：${String(e)}`);
          await delay(this.options.reconnectDelayMs ?? 2000);
        }
      }
    } catch (e) {
      if (submitted && (resumeTurnId || this.activeTurn || !(e instanceof RpcError)) && !(e instanceof UncertainExecution)) throw new UncertainExecution(String(e));
      throw e;
    } finally {
      for (const a of this.approvals.values()) await hooks.resolved(a.token).catch(() => {});
      this.approvals.clear(); this.rpc?.close(); this.activeTurn = undefined; this.completedTurn = undefined; this.busy = false;
    }
  }
  private async processMessages(hooks: BackendHooks): Promise<void> {
    for (const m of this.inbox.splice(0)) {
      const p = m.params;
      if (p?.threadId !== this.config.threadId) continue;
      if (m.method === 'turn/completed' && p.turn?.id === this.activeTurn && ['completed','interrupted','failed'].includes(p.turn.status)) {
        this.completedTurn = p.turn;
      } else if (m.method === 'serverRequest/resolved') {
        for (const a of this.approvals.values()) if (a.requestId === p.requestId) { this.approvals.delete(a.token); await hooks.resolved(a.token); }
      } else if (m.id !== undefined && p.turnId === this.activeTurn) {
        if ([...this.approvals.values()].some(a => a.requestId === m.id)) continue;
        let supported = ['accept', 'decline', 'cancel'];
        let description: string;
        if (m.method === 'item/commandExecution/requestApproval') {
          description = `命令：${p.command ?? '未提供'}\n工作目录：${p.cwd ?? this.config.projectRoot}\n原因：${p.reason ?? '未提供'}`;
          if (p.additionalPermissions) description += `\n额外权限：${JSON.stringify(p.additionalPermissions)}`;
          if (p.networkApprovalContext) description += `\n网络范围：${JSON.stringify(p.networkApprovalContext)}`;
          if (!p.command || (p.kind && p.kind !== 'command')) {
            supported = ['decline', 'cancel']; description += '\n此请求需在桌面查看完整详情后同意。';
          }
        } else if (m.method === 'item/fileChange/requestApproval') {
          const items = await this.readItems(this.activeTurn!);
          const change = items.find(i => i.id === p.itemId && i.type === 'fileChange');
          description = `文件修改原因：${p.reason ?? '未提供'}\n请求写入根目录：${p.grantRoot ?? '沿用现有范围'}\n修改：${change?.changes ? JSON.stringify(change.changes, null, 2) : '请到桌面查看差异'}`;
          if (!change?.changes?.length) supported = ['decline', 'cancel'];
        } else if (['item/tool/requestUserInput', 'mcpServer/elicitation/request', 'item/permissions/requestApproval'].includes(m.method ?? '')) {
          supported = []; description = '此任务需要补充信息或处理特殊权限，请回到绑定的 Codex 桌面对话处理。P1 不代答此类请求。';
        } else continue;
        if (description.length > 6000) { supported = supported.filter(d => d !== 'accept');description = description.slice(0,5500) + '\n详情过长，请到桌面查看完整内容并决定是否同意。'; }
        const decisions = Array.isArray(p.availableDecisions) ? p.availableDecisions.filter((d: unknown) => typeof d === 'string' && supported.includes(d)) : supported;
        const a: Approval = { token: randomUUID(), requestId: m.id, threadId: p.threadId, turnId: p.turnId, method: m.method!, description, decisions };
        this.approvals.set(a.token, a); await hooks.approval(a);
      }
    }
  }
  async decide(token: string, decision: string): Promise<void> {
    const a = this.approvals.get(token);
    if (!a || a.submitted || a.turnId !== this.activeTurn || !a.decisions.includes(decision) || !this.rpc?.connected) throw new Error('审批已过期、已处理，或不支持该决定');
    a.submitted = true;
    // Keep it pending until the server's resolved event; never infer acceptance from send().
    this.rpc.respond(a.requestId, { decision });
  }
  async stop(): Promise<void> { this.stopping = true; if (this.activeTurn && this.rpc?.connected) await this.interruptKnownTurn(); }
  disconnect(): void { this.disconnected = true; this.rpc?.close(); }
  async steer(text: string): Promise<void> {
    if (!this.activeTurn || !this.rpc?.connected || this.stopping) throw new Error('没有可追加指令的活动任务');
    await this.rpc.call('turn/steer', { threadId: this.config.threadId, expectedTurnId: this.activeTurn, input: [{ type: 'text', text }] });
  }
  private async interruptKnownTurn(): Promise<void> {
    try { await this.rpc!.call('turn/interrupt', { threadId: this.config.threadId, turnId: this.activeTurn }); }
    catch (e) { const turn = this.completedTurn ?? await this.readTurn(this.activeTurn!); if (!turn || (turn !== this.completedTurn && turn.completedAt == null) || !['completed','interrupted','failed'].includes(turn.status)) throw e; }
  }
  private async readTurn(turnId: string): Promise<any> {
    let cursor: string | undefined; const seen = new Set<string>();
    do {
      const page = await this.rpc!.call('thread/turns/list', { threadId: this.config.threadId, limit: 50, itemsView: 'notLoaded', ...(cursor ? { cursor } : {}) });
      const turn = page.data?.find((t: any) => t.id === turnId); if (turn) return turn;
      cursor = page.nextCursor ?? undefined; if (cursor && seen.has(cursor)) throw new Error('Repeated history cursor'); if (cursor) seen.add(cursor);
    } while (cursor);
    return undefined;
  }
  private async readItems(turnId: string): Promise<any[]> {
    const items: any[] = []; let cursor: string | undefined; const seen = new Set<string>();
    do {
      const page = await this.rpc!.call('thread/items/list', { threadId: this.config.threadId, turnId, limit: 100, sortDirection: 'asc', ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page.data)) throw new Error('Invalid full item page');
      for (const entry of page.data) {
        if (entry.turnId !== turnId || !entry.item) throw new Error('Item belongs to unexpected turn');
        items.push(entry.item);
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('Repeated item cursor'); if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
}
