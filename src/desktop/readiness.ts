import type { RpcMessage } from './rpc';

/** Observes the actual desktop connection; bridge traffic cannot make it ready. */
export class DesktopReadiness {
  private connection?: object;
  private pending = new Map<string, string>();
  private initialized = false;
  private projects = false;
  private configured = false;
  private changedAt = 0;
  revision = 0;
  constructor(private readonly invalidate: () => void, private readonly now = Date.now) {}

  request(connection: object, message: RpcMessage): void {
    if (message.method === 'initialize' && message.params?.clientInfo?.name === 'Codex Desktop') {
      this.connection = connection;
      this.pending.clear(); this.initialized = false; this.projects = false; this.configured = false;
      this.changed();
    }
    if (connection !== this.connection) return;
    if (message.id !== undefined && message.method) this.pending.set(String(message.id), message.method);
    if (['config/batchWrite','config/value/write','plugin/install','experimentalFeature/enablement/set'].includes(message.method ?? '')) {
      this.configured = false;
      this.changed();
    }
  }
  response(connection: object, message: RpcMessage): void {
    if (connection !== this.connection || message.id === undefined || message.method) return;
    const method = this.pending.get(String(message.id)); this.pending.delete(String(message.id));
    if (message.error) return;
    if (method === 'initialize') this.initialized = true;
    if (method === 'project/list') this.projects = true;
    if (method === 'config/batchWrite' || method === 'config/value/write') this.configured = true;
  }
  close(connection: object): void {
    if (connection !== this.connection) return;
    this.connection = undefined; this.pending.clear(); this.changed();
  }
  canLease(revision = this.revision): boolean {
    return revision === this.revision && Boolean(this.connection) && this.initialized && this.projects && this.configured && this.now() - this.changedAt >= 15_000;
  }
  private changed(): void { this.changedAt = this.now(); this.revision++; this.invalidate(); }
}
