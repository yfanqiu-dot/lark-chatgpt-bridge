import net, { type Socket } from 'node:net';
import { resolve } from 'node:path';
import {createHash} from 'node:crypto';
import { RpcError,isEphemeralQueueUnavailable } from './rpc';
import { sameProcess, type IdleProof, type ProcessIdentity, type SupervisorBinding } from './supervisor';

const methods = new Set(['tools/list', 'thread/loaded/list', 'thread/read', 'thread/queue/list']);
const maxFrame = 8 * 1024 * 1024;
export interface OrdinaryReadRpc { readonly changed?: boolean; beginObservation?():void; call(method: string, params: unknown): Promise<any>; close(): void }

/** The installed app-tools pipe uses a four-byte little-endian frame. This
 * client has a fixed read allowlist and never reconnects or replays a request. */
export class OrdinaryPipeRpc implements OrdinaryReadRpc {
  private sequence = 0;
  private buffer = Buffer.alloc(0);
  private socket?: Socket;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>;method:string;threadId?:string }>();
  private dirty = false;
  get changed(): boolean { return this.dirty; }
  constructor(private readonly path: string, private readonly timeoutMs = 2500) {}
  async connect(): Promise<void> {
    if (this.socket) throw new Error('Ordinary pipe cannot reconnect');
    const socket = this.socket = net.createConnection(this.path);
    socket.on('data', chunk => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32LE(0);
        if (length > maxFrame || !length) { this.close(); return; }
        if (this.buffer.length < length + 4) return;
        let response: any;
        try { response = JSON.parse(this.buffer.subarray(4, length + 4).toString('utf8')); }
        catch { this.close(); return; }
        this.buffer = this.buffer.subarray(length + 4);
        if (!response || typeof response !== 'object' || Array.isArray(response)) { this.close(); return; }
        if (typeof response.method === 'string') { this.dirty = true; continue; }
        const p = this.pending.get(response.id);
        if (!p) continue;
        clearTimeout(p.timer); this.pending.delete(response.id);
        if (response.error && Number.isInteger(response.error.code)) {
          const known=new RpcError(response.error.code,typeof response.error.message==='string'?response.error.message:'');
          p.reject(p.method==='thread/queue/list'&&isEphemeralQueueUnavailable(known,p.threadId)?known:new RpcError(response.error.code,'Ordinary desktop read rejected'));
        }
        else if (Object.hasOwn(response, 'result')) p.resolve(response.result);
        else { p.reject(new Error('Invalid ordinary pipe response')); this.close(); }
      }
    });
    socket.on('error', () => this.close()); socket.on('close', () => this.rejectAll());
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Ordinary pipe connect timeout')); }, this.timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); done(); });
      socket.once('error', () => { clearTimeout(timer); reject(new Error('Ordinary pipe connect failed')); });
    });
  }
  async call(method: string, params: unknown): Promise<any> {
    if (!methods.has(method)) throw new Error('Ordinary pipe only permits deployment reads');
    if (!this.socket || this.socket.destroyed || this.dirty) throw new Error('Ordinary pipe unavailable or changed during inspection');
    const id = ++this.sequence, data = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    if (data.length > maxFrame) throw new Error('Ordinary pipe request is too large');
    const frame = Buffer.alloc(data.length + 4); frame.writeUInt32LE(data.length); data.copy(frame, 4);
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Ordinary read timeout')); this.close(); }, this.timeoutMs);
      const threadId=(params as {threadId?:unknown})?.threadId;
      this.pending.set(id, { resolve: done, reject, timer,method,...(typeof threadId==='string'?{threadId}:{}) }); this.socket!.write(frame);
    });
  }
  close(): void { this.socket?.destroy(); this.buffer = Buffer.alloc(0); this.rejectAll(); }
  private rejectAll(): void { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Ordinary read disconnected')); } this.pending.clear(); }
}

/** Local rejection evidence only; never persist task text, queue bodies or raw flags. */
export interface IdleBlocker {
  threadId: string;
  status: 'idle' | 'notLoaded' | 'active';
  pass: number;
  observedAt: number;
  waitingApproval: boolean;
  activeFlagCount: number;
  queueCount?: number;
}
export interface OrdinaryIdleObservation {
  verified: boolean;
  findings: string[];
  toolCount: number;
  loadedThreadCount?: number;
  proof?: IdleProof;
  blocker?: IdleBlocker;
  failure?: { method?: string; kind: string; code?: number;threadId?:string;pass?:number;ephemeral?:boolean;errorSha256?:string };
  unqueueableEphemeralThreadIds?:string[];
}
/** The caller must verify the Windows package/pipe owner and the complete
 * process identity before AND after this read. A separate App Server is not an
 * admissible transport. Unsupported app-tools RPC cannot be treated as idle. */
export async function inspectOrdinaryIdle(rpc: OrdinaryReadRpc, desktop: ProcessIdentity, bindings: readonly SupervisorBinding[], expectedTools: readonly string[], recheckIdentity: () => Promise<ProcessIdentity>, now = Date.now): Promise<OrdinaryIdleObservation> {
  const started = now(); let toolCount = 0, loadedThreadCount: number | undefined, lastMethod: string | undefined,lastThreadId:string|undefined,lastPass:number|undefined,lastEphemeral:boolean|undefined;
  const read = (method: string, params: unknown) => { lastMethod = method; return rpc.call(method,params); };
  const failure = (finding: string): OrdinaryIdleObservation => ({ verified: false, findings: [finding], toolCount, ...(loadedThreadCount === undefined ? {} : { loadedThreadCount }) });
  try {
    if (!bindings.length || new Set(bindings.map(b => b.threadId)).size !== bindings.length) return failure('ordinary_bindings_invalid');
    const catalog = await read('tools/list', { threadStartKind: 'all' });
    if (!Array.isArray(catalog.tools) || catalog.tools.some((t: any) => typeof t.name !== 'string')) return failure('ordinary_tool_catalog_invalid');
    const names = catalog.tools.map((t: any) => t.name); toolCount = names.length;
    if (new Set(names).size !== names.length || !expectedTools.length || JSON.stringify([...names].sort()) !== JSON.stringify([...expectedTools].sort())) return failure('ordinary_tools_mismatch');
    const pages = async (method: string, params: Record<string, unknown>,firstPageUnavailable?:(e:unknown)=>boolean): Promise<any[]> => {
      let cursor: string | undefined; const cursors = new Set<string>(), data: any[] = [];
      do {
        if (cursors.size >= 100 || now() - started > 5000) throw new Error('Ordinary inspection exceeded bounded window');
        let page;
        try{page=await read(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) });}
        catch(e){if(cursor===undefined&&cursors.size===0&&data.length===0&&firstPageUnavailable?.(e))return [];throw e;}
        if (!Array.isArray(page.data)) throw new Error('Invalid ordinary page');
        data.push(...page.data); if (data.length > 10_000) throw new Error('Ordinary page limit exceeded');
        cursor = page.nextCursor ?? undefined;
        if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) throw new Error('Invalid ordinary cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return data;
    };
    const loaded = async () => {
      const ids = await pages('thread/loaded/list', {});
      if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) throw new Error('Invalid loaded task list');
      return ids.sort() as string[];
    };
    const initial = await loaded(); loadedThreadCount = initial.length;
    const ids = [...new Set([...initial, ...bindings.map(b => b.threadId)])];
    const ephemeralTypes=new Map<string,boolean>(),unqueueable=new Set<string>();
    let tasks: IdleProof['tasks'] = [];
    // Two reads account for activity that starts during the first queue scan.
    for (let pass = 0; pass < 2; pass++) {
      tasks = [];
      for (const threadId of ids) {
        lastThreadId=threadId;lastPass=pass+1;lastEphemeral=undefined;
        const { thread } = await read('thread/read', { threadId, includeTurns: false });
        if (thread?.id !== threadId || !['idle','notLoaded','active'].includes(thread.status?.type) || (thread.status.activeFlags !== undefined && !Array.isArray(thread.status.activeFlags))) return failure('ordinary_native_state_invalid');
        if(thread.ephemeral!==undefined&&typeof thread.ephemeral!=='boolean')return failure('ordinary_native_state_invalid');
        lastEphemeral=thread.ephemeral===true;
        if(pass===0)ephemeralTypes.set(threadId,lastEphemeral);else if(ephemeralTypes.get(threadId)!==lastEphemeral)return failure('ordinary_thread_kind_changed');
        const blocker: IdleBlocker = {threadId,status:thread.status.type,pass:pass+1,observedAt:now(),waitingApproval:thread.status.activeFlags?.includes('waitingOnApproval')===true,activeFlagCount:thread.status.activeFlags?.length??0};
        if (blocker.waitingApproval) return {...failure('ordinary_waiting_approval'),blocker};
        if (!['idle','notLoaded'].includes(thread.status.type) || thread.status.activeFlags?.length) return {...failure('ordinary_task_active'),blocker};
        const binding = bindings.find(b => b.threadId === threadId);
        if(binding&&lastEphemeral)return failure('ordinary_binding_ephemeral');
        if (binding && (thread.projectId !== binding.projectId || typeof thread.cwd !== 'string' || resolve(thread.cwd) !== resolve(binding.projectRoot))) return failure('ordinary_binding_mismatch');
        const queue = await pages('thread/queue/list', { threadId },e=>{
          // Only an explicit first-page rejection on an unrelated idle
          // ephemeral thread proves queues unsupported. Never hide a partial
          // queue, a paginated failure, a binding or a durable task's error.
          if(!binding&&lastEphemeral&&thread.status.type==='idle'&&isEphemeralQueueUnavailable(e,threadId)){unqueueable.add(threadId);return true;}return false;
        });
        if (queue.length) return {...failure('ordinary_queue_pending'),blocker:{...blocker,observedAt:now(),queueCount:queue.length}};
        if (binding) tasks.push({ ...binding, status: thread.status.type, queueCount: 0, waitingApproval: false });
      }
      if (JSON.stringify(initial) !== JSON.stringify(await loaded())) return failure('ordinary_loaded_set_changed');
    }
    if (!sameProcess(desktop, await recheckIdentity())) return failure('ordinary_process_identity_changed');
    if (rpc.changed) return failure('ordinary_native_activity_observed');
    if (now() - started > 5000 || now() < started) return failure('ordinary_observation_stale');
    return { verified: true, findings: [], toolCount, loadedThreadCount,...(unqueueable.size?{unqueueableEphemeralThreadIds:[...unqueueable].sort()}:{}), proof: { verifiedAt: started, desktop: structuredClone(desktop), allDesktopTasksIdle: true, toolsExact: true, tasks } };
  } catch (e) {
    return { ...failure(e instanceof RpcError && e.code===-32601 ? 'ordinary_native_rpc_unsupported' : e instanceof RpcError&&e.code===-32600?'ordinary_native_request_rejected':e instanceof RpcError && e.code === 403 ? 'ordinary_native_permission_denied' : 'ordinary_native_state_unavailable'),
      failure: e instanceof RpcError ? { method: lastMethod, kind: 'rpc_error', code: e.code,...(lastThreadId?{threadId:lastThreadId,pass:lastPass,ephemeral:lastEphemeral}:{}),errorSha256:createHash('sha256').update(e.message).digest('hex') } : { method: lastMethod, kind: e instanceof Error && e.message === 'Ordinary read timeout' ? 'read_timeout' : e instanceof Error && e.message === 'Ordinary read disconnected' ? 'transport_disconnected' : 'read_validation_or_transport_failed' } };
  } finally { rpc.close(); }
}
