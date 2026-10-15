import { resolve } from 'node:path';
import { inspectOrdinaryIdle, type OrdinaryReadRpc, type IdleBlocker } from './ordinary-idle';
import { sameProcess, type ProcessIdentity, type SupervisorBinding, type IdleProof } from './supervisor';
import { RpcError, loopbackEndpoint } from './rpc';

/** The production adapter must obtain this context from the owned host's
 * fresh tool lease AND OS process/endpoint ownership checks, not task history. */
export interface SharedContext {
  host: ProcessIdentity;
  backend: ProcessIdentity;
  desktop: ProcessIdentity;
  endpoint: string;
  backendEndpoint: string;
  leaseVerifiedAt: number;
  desktopVersion: string;
  codexSha256: string;
  toolNames: string[];
  packageIdentityVerified: boolean;
  endpointOwnershipVerified: boolean;
}
export interface SharedIdleObservation {
  verified: boolean;
  source: 'owned_shared_native';
  findings: string[];
  proof?: IdleProof;
  blocker?: IdleBlocker;
  failure?: { method?: string; kind: string; code?: number };
  /** Fixed counters and durations only. Diagnostic data never grants admission. */
  timing?: SharedAdmissionTiming;
  /** First unsolicited message in the native observation window. No body,
   * configuration value, request id or arbitrary method text is retained. */
  activity?: { observedAt:number; kind:'request'|'notification'|'unclassified'; method?:string; methodSha256?:string; threadId?:string; turnId?:string };
}
export interface SharedAdmissionTiming {
  version: 1;
  startedAt: number;
  completedAt: number;
  elapsedMs: number;
  nativeWindowStartedAt?: number;
  nativeWindowMs?: number;
  prerequisiteContextMs: number;
  finalContextMs: number;
  projectHistoryReadMs: number;
  taskQueueReadMs: number;
  nativeReadCount: number;
  contextReadCount: number;
}
const reads = new Set(['project/list','thread/turns/list','thread/loaded/list','thread/read','thread/queue/list']);
/** Only reads the new shared App Server. Does not resume/create a task, submit
 * input, replay a queue entry or answer an approval. The tool catalog is from
 * its verified desktop lease, not a fabricated native tools/list response. */
export async function inspectSharedIdle(rpc: OrdinaryReadRpc, expected: SharedContext,
  bindings: readonly SupervisorBinding[], baseline: { desktopVersion: string; codexSha256: string; toolNames: readonly string[] },
  recheckContext: () => Promise<SharedContext>, now = Date.now): Promise<SharedIdleObservation> {
  const startedAt=now();let nativeWindowStartedAt:number|undefined;
  const timing:SharedAdmissionTiming={version:1,startedAt,completedAt:startedAt,elapsedMs:0,prerequisiteContextMs:0,finalContextMs:0,projectHistoryReadMs:0,taskQueueReadMs:0,nativeReadCount:0,contextReadCount:0};
  const measured:OrdinaryReadRpc={
    get changed(){return rpc.changed;},
    beginObservation(){nativeWindowStartedAt=now();rpc.beginObservation?.();},
    async call(method,params){
      const at=now();timing.nativeReadCount++;
      try{return await rpc.call(method,params);}finally{
        const key=method==='project/list'||method==='thread/turns/list'?'projectHistoryReadMs':'taskQueueReadMs';
        timing[key]+=Math.max(0,now()-at);
      }
    },
    close(){rpc.close();},
  };
  const observed=await inspectSharedIdleCore(measured,expected,bindings,baseline,async()=>{
    const at=now(),key=timing.contextReadCount++===0?'prerequisiteContextMs':'finalContextMs';
    try{return await recheckContext();}finally{timing[key]+=Math.max(0,now()-at);}
  },now);
  const completedAt=now();
  return {...observed,timing:{...timing,completedAt,elapsedMs:Math.max(0,completedAt-startedAt),
    ...(nativeWindowStartedAt===undefined?{}:{nativeWindowStartedAt,nativeWindowMs:Math.max(0,completedAt-nativeWindowStartedAt)})}};
}
async function inspectSharedIdleCore(rpc: OrdinaryReadRpc, expected: SharedContext,
  bindings: readonly SupervisorBinding[], baseline: { desktopVersion: string; codexSha256: string; toolNames: readonly string[] },
  recheckContext: () => Promise<SharedContext>, now:()=>number): Promise<SharedIdleObservation> {
  let started = now(),lastMethod: string | undefined;
  const failed = (finding: string): SharedIdleObservation => ({verified:false,source:'owned_shared_native',findings:[finding]});
  const contextValid = (c: SharedContext) => sameProcess(c.host,expected.host) && sameProcess(c.backend,expected.backend) && sameProcess(c.desktop,expected.desktop)
    && c.backend.parentPid === c.host.pid && c.packageIdentityVerified === true && c.endpointOwnershipVerified === true
    && loopbackEndpoint(c.endpoint) === loopbackEndpoint(expected.endpoint) && loopbackEndpoint(c.backendEndpoint) === loopbackEndpoint(expected.backendEndpoint)
    && c.endpoint !== c.backendEndpoint && c.desktopVersion === baseline.desktopVersion && c.codexSha256 === baseline.codexSha256
    && Number.isFinite(c.leaseVerifiedAt) && c.leaseVerifiedAt <= now()+1000 && now()-c.leaseVerifiedAt <= 60_000
    && Array.isArray(c.toolNames) && c.toolNames.every(n => typeof n === 'string') && new Set(c.toolNames).size === c.toolNames.length
    && baseline.toolNames.length > 0 && JSON.stringify([...c.toolNames].sort()) === JSON.stringify([...baseline.toolNames].sort());
  const read = async (method: string, params: unknown) => {
    if (!reads.has(method) || rpc.changed || now()-started > 5000 || now() < started) throw new Error('Shared admission read invalidated');
    lastMethod=method; return rpc.call(method,params);
  };
  try {
    if (!bindings.length || !contextValid(expected) || !contextValid(await recheckContext())) return failed('shared_context_unverified');
    // Context/package validation is a prerequisite. Native freshness begins
    // with the first project/history/task read and includes the final live OS
    // owner check. All loaded tasks are then scanned twice.
    started=now();rpc.beginObservation?.();
    const projects: any[] = []; let cursor: string | undefined; const cursors = new Set<string>();
    do {
      if (cursors.size >= 100) return failed('shared_project_pages_invalid');
      const page = await read('project/list',{limit:100,...(cursor ? {cursor} : {})});
      if (!Array.isArray(page.data) || projects.length+page.data.length > 10_000) return failed('shared_project_pages_invalid');
      projects.push(...page.data); cursor=page.nextCursor ?? undefined;
      if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) return failed('shared_project_pages_invalid');
      if (cursor) cursors.add(cursor);
    } while(cursor);
    for (const b of bindings) {
      const matches=projects.filter(p => p?.id === b.projectId);
      if (matches.length !== 1 || !Array.isArray(matches[0].roots) || !matches[0].roots.some((r: any) => typeof r?.path === 'string' && resolve(r.path) === resolve(b.projectRoot))) return failed('shared_project_binding_mismatch');
      const turns=await read('thread/turns/list',{threadId:b.threadId,limit:5,itemsView:'notLoaded'});
      if (!Array.isArray(turns.data) || !turns.data.some((t: any) => t?.status === 'completed' && t.completedAt != null)) return failed('shared_history_incompatible');
    }
    // Reuse the bounded two-pass scan over ALL loaded tasks and every original
    // binding. tools/list is resolved only from the previously verified lease.
    const bridge: OrdinaryReadRpc = {
      get changed() { return rpc.changed; },
      call(method,params) { return method === 'tools/list' ? Promise.resolve({tools:expected.toolNames.map(name => ({name}))}) : read(method,params); },
      close() {},
    };
    const observed = await inspectOrdinaryIdle(bridge,expected.desktop,bindings,baseline.toolNames,async () => {
      if (!contextValid(await recheckContext())) throw new Error('Shared context changed');
      return expected.desktop;
    },now);
    if (!observed.verified) return {...failed(observed.findings[0]!.replace(/^ordinary_/,'shared_')),...(observed.failure ? {failure:observed.failure} : {}),...(observed.blocker ? {blocker:observed.blocker} : {})};
    // inspectOrdinaryIdle already rechecked the complete context immediately
    // after its last queue scan. No intervening read/mutation needs a third
    // identical OS query; still use the oldest native-read timestamp.
    if (rpc.changed || now()-started > 5000 || now() < started) return failed('shared_context_changed_or_stale');
    return {verified:true,source:'owned_shared_native',findings:[],proof:{...observed.proof!,verifiedAt:started}};
  } catch(e) {
    return {...failed('shared_native_read_unavailable'),failure:e instanceof RpcError ? {method:lastMethod,kind:'rpc_error',code:e.code} : {method:lastMethod,kind:'validation_or_transport_failed'}};
  } finally { rpc.close(); }
}
