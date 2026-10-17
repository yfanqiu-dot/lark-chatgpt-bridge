export interface RpcMessage { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } }
export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
/** A pinned App Server rejects queues on ephemeral threads with this exact
 * response. Other invalid requests, unknown methods and permissions are not
 * evidence that a queue is empty or impossible. */
export function isEphemeralQueueUnavailable(error:unknown,threadId:unknown):boolean {
  return typeof threadId==='string'&&threadId.length<=128&&/^[\w-]+$/.test(threadId)&&error instanceof RpcError&&error.code===-32600
    &&error.message===`ephemeral thread does not support queued submissions: ${threadId}`;
}
export function loopbackEndpoint(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'ws:' || !u.port || u.port === '0' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
    throw new Error('Desktop endpoint must be a loopback ws:// address without credentials or a path');
  }
  return u.href;
}

/** One connection. Requests are never transparently replayed after transport loss. */
export class DesktopRpc {
  private sequence = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private socket?: WebSocket;
  get connected(): boolean { return this.socket?.readyState === 1; }
  constructor(readonly endpoint: string, private readonly timeoutMs = 15_000) { loopbackEndpoint(endpoint); }
  onMessage(fn: (message: RpcMessage) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  async connect(): Promise<void> {
    if (typeof WebSocket === 'undefined') throw new Error('Desktop backend requires Node.js 22 or later');
    const socket = this.socket = new WebSocket(loopbackEndpoint(this.endpoint));
    socket.addEventListener('message', e => {
      let m: RpcMessage;
      try { m = JSON.parse(String(e.data)); } catch { this.close(); return; }
      if (m.id !== undefined && !m.method) {
        const p = this.pending.get(Number(m.id));
        if (p) { clearTimeout(p.timer); this.pending.delete(Number(m.id)); m.error ? p.reject(new RpcError(m.error.code, m.error.message)) : p.resolve(m.result); }
      } else { for (const listener of this.listeners) listener(m); }
    });
    socket.addEventListener('close', () => this.rejectPending(new Error('Desktop connection closed; execution may need reconciliation')));
    socket.addEventListener('error', () => this.rejectPending(new Error('Desktop connection failed')));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(new Error('Desktop connect timeout')); }, this.timeoutMs);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Desktop connect failed')); }, { once: true });
      });
      await this.call('initialize', { clientInfo: { name: 'lark_chatgpt_bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
      this.send({ method: 'initialized', params: {} });
    } catch (e) { this.close(); throw e; }
  }
  call<T = any>(method: string, params: unknown = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!this.connected) { reject(new Error('Desktop is disconnected')); return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout; do not blindly retry a mutation`)); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  respond(id: string | number, result: unknown): void { this.send({ id, result }); }
  private send(value: unknown): void {
    if (!this.connected) throw new Error('Desktop is disconnected');
    this.socket!.send(JSON.stringify(value));
  }
  close(): void { this.socket?.close(); this.rejectPending(new Error('Desktop client closed')); }
  private rejectPending(error: Error): void { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
}
