import type { RpcMessage } from './rpc';
const configurationChanges = new Set(['config/batchWrite','config/value/write','plugin/install','plugin/uninstall','experimentalFeature/enablement/set']);
// Feature enablement is an acknowledged configuration write too. The desktop
// can perform it in the background without issuing a later config/read.
const configurationWrites = new Set(['config/batchWrite','config/value/write','experimentalFeature/enablement/set']);
export type ReadinessSnapshot = ReturnType<DesktopReadiness['snapshot']>;

/** Observes the actual desktop connection; bridge traffic cannot make it ready. */
export class DesktopReadiness {
  private connection?: object;
  private pending = new Map<string, {method: string; revision: number}>();
  private initialized = false;
  private projects = false;
  private configured = false;
  private changedAt = 0;
  private configurationFailures = 0;
  private lastChange = 'not initialized';
  revision = 0;
  constructor(private readonly invalidate: (snapshot: ReadinessSnapshot) => void, private readonly now = Date.now) {}

  request(connection: object, message: RpcMessage): void {
    if (message.method === 'initialize' && message.params?.clientInfo?.name === 'Codex Desktop') {
      this.connection = connection;
      this.pending.clear(); this.initialized = false; this.projects = false; this.configured = false; this.configurationFailures = 0;
      this.changed('desktop initialize');
    }
    if (connection !== this.connection) return;
    if (configurationChanges.has(message.method ?? '')) {
      this.configured = false;
      this.changed(`request ${message.method}`);
    }
    if (message.id !== undefined && message.method) this.pending.set(String(message.id), {method:message.method,revision:this.revision});
  }
  response(connection: object, message: RpcMessage): void {
    if (connection !== this.connection || message.id === undefined || message.method) return;
    const request = this.pending.get(String(message.id)); this.pending.delete(String(message.id));
    if(!request)return;
    const {method,revision}=request;
    const mutating=configurationChanges.has(method);
    if(mutating){this.configured=false;if(message.error)this.configurationFailures++;this.changed(`response ${method}${message.error ? ' failed' : ''}`);}
    if (message.error) return;
    if (!Object.hasOwn(message,'result')) return;
    if (method === 'initialize') this.initialized = true;
    if (method === 'project/list') this.projects = true;
    // A warm desktop may only read configuration. A read begun before a change
    // cannot prove the configuration after that change, even if its reply is late.
    if (!this.pendingConfiguration().length && (configurationWrites.has(method) || (method === 'config/read' && revision === this.revision))) this.configured = true;
  }
  close(connection: object): void {
    if (connection !== this.connection) return;
    this.connection = undefined; this.pending.clear(); this.changed('desktop connection closed');
  }
  canLease(revision = this.revision): boolean {
    return revision === this.revision && Boolean(this.connection) && this.initialized && this.projects && this.configured && !this.pendingConfiguration().length && this.now() - this.changedAt >= 15_000;
  }
  snapshot() { return {desktopConnected:Boolean(this.connection),initialized:this.initialized,projectsRead:this.projects,configurationObserved:this.configured,pendingConfiguration:this.pendingConfiguration(),configurationFailures:this.configurationFailures,quietForMs:this.now()-this.changedAt,revision:this.revision,lastChange:this.lastChange}; }
  private pendingConfiguration(): string[] {return [...this.pending.values()].filter(r=>configurationChanges.has(r.method)).map(r=>r.method);}
  private changed(reason: string): void { this.lastChange=reason;this.changedAt = this.now(); this.revision++; this.invalidate(this.snapshot()); }
}
