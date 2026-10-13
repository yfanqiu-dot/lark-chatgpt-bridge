import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';

export interface ProcessIdentity {
  pid: number;
  parentPid: number;
  createdAt: string;
  executable: string;
  commandLineSha256: string;
}
export interface SupervisorInventory {
  legacy: ProcessIdentity[];
  desktop: ProcessIdentity[];
  host: ProcessIdentity[];
  listener: ProcessIdentity[];
  broker: ProcessIdentity[];
}
export interface IdleProof {
  verifiedAt: number;
  desktop: ProcessIdentity;
  allDesktopTasksIdle: boolean;
  toolsExact: boolean;
  tasks: Array<{ threadId: string; projectId: string; projectRoot: string; status: 'idle' | 'notLoaded'; queueCount: number; waitingApproval: boolean }>;
}
export interface SupervisorBinding { threadId: string; projectId: string; projectRoot: string }
export interface OrdinaryProof { desktop: ProcessIdentity; verifiedAt: number; packageIdentityVerified: boolean; toolsExact: boolean }
export interface ColdExitProof {
  verifiedAt: number;
  /** Includes every desktop process, its descendants and all App Servers,
   * including foreign installs. Missing/unreadable inventory fails closed. */
  desktopRelated: ProcessIdentity[];
  complete: boolean;
}
/** A fixed native inventory read failure, never a proof or permission to launch.
 * Structural identification also works across independently bundled adapters. */
export class ColdExitObservationUnavailable extends Error {
  readonly code = 'cold_exit_observation_unavailable';
  constructor(readonly action: 'Snapshot' | 'ColdSnapshot' | 'SharedSnapshot') {
    super('Native process identity is incomplete; cold exit remains unverified');
    this.name = 'ColdExitObservationUnavailable';
  }
}
function isUnavailableColdRead(error: unknown): error is ColdExitObservationUnavailable {
  const value = error as Partial<ColdExitObservationUnavailable> | null;
  return error instanceof Error && value?.name === 'ColdExitObservationUnavailable' && value.code === 'cold_exit_observation_unavailable'
    && (value.action === 'Snapshot' || value.action === 'ColdSnapshot');
}
export interface LegacyRetirementProof {
  version: 1;
  observedAt: number;
  retired: boolean;
  taskPresent: boolean;
  taskEnabled: boolean;
  taskState: 'disabled' | 'absent' | 'other';
  definitionSha256: string;
}
export function validRetirementProof(p: LegacyRetirementProof): boolean {
  return !!p && p.version===1 && Number.isFinite(p.observedAt) && p.retired===true && p.taskEnabled===false
    && typeof p.taskPresent==='boolean' && p.taskState===(p.taskPresent?'disabled':'absent') && /^[a-f0-9]{64}$/.test(p.definitionSha256);
}
export type SupervisorPhase = 'preflight' | 'waiting_desktop_exit' | 'pausing_legacy' | 'closing_desktop' | 'starting_broker' | 'starting_host' | 'starting_listener' | 'running'
  | 'stopping_listener' | 'stopping_host' | 'restoring_desktop' | 'restoring_legacy' | 'stopping_broker' | 'restored' | 'closed' | 'blocked';
export interface SupervisorState {
  version: 1;
  runId: string;
  phase: SupervisorPhase;
  revision: number;
  updatedAt: string;
  startMode?: 'hot' | 'cold'; // Missing means the historical hot workflow.
  channelMode?: 'new-only'; // Missing preserves the historical rollback policy.
  serviceMode?: 'stop-with-desktop';
  desktopQuitVerified?: boolean;
  newBaseline?: { desktop?: ProcessIdentity; retirement: LegacyRetirementProof };
  baseline?: { legacy: ProcessIdentity; desktop: ProcessIdentity; legacyTaskEnabled: boolean; launchDefinitionSha256: string };
  owned: Partial<Record<'host' | 'listener' | 'broker', ProcessIdentity>>;
  /** Intent is durable before every potentially destructive call. */
  legacyPauseAttempted: boolean;
  desktopCloseAttempted: boolean;
  desktopRestoreRequired?: boolean;
  lastColdExitProof?: ColdExitProof;
  errorCode?: string;
  rollbackErrorCode?: string;
  ordinaryProof?: OrdinaryProof;
  lastIdleProof?: IdleProof;
}
export interface SupervisorPort {
  inventory(): Promise<SupervisorInventory>;
  idle(): Promise<IdleProof>;
  backup(): Promise<{ legacyTaskEnabled: boolean; launchDefinitionSha256: string }>;
  pauseLegacy(identity: ProcessIdentity): Promise<void>;
  closeDesktop(identity: ProcessIdentity): Promise<void>;
  /** Each launch must return a durable identity receipt. An ambiguous launch
   * is never repeated. Its unresolved inventory blocks rollback instead. */
  startBroker(runId: string): Promise<ProcessIdentity>;
  startHost(runId: string): Promise<ProcessIdentity>;
  startListener(runId: string): Promise<ProcessIdentity>;
  ready(): Promise<void>;
  health(): Promise<boolean>;
  stopListener(identity: ProcessIdentity): Promise<void>;
  stopHost(identity: ProcessIdentity): Promise<void>;
  ordinary(): Promise<OrdinaryProof>;
  restoreLegacy(baseline: NonNullable<SupervisorState['baseline']>): Promise<void>;
  stopBroker(identity: ProcessIdentity): Promise<void>;
  verifyBindings(): Promise<void>;
  verifyClosedBindings?(): Promise<void>;
  /** Cold mode only: the supervisor observes a human's normal exit. It never
   * calls closeDesktop or claims that the old desktop was natively idle. */
  coldExit?(): Promise<ColdExitProof>;
  sharedIdle?(): Promise<IdleProof>;
  legacyRetirement?(): Promise<LegacyRetirementProof>;
  /** Explicit managed mode only. A fresh owned host receipt of a clean GUI
   * exit; missing/abnormal receipts never authorize skipping restoration. */
  desktopQuit?(): Promise<ProcessIdentity | undefined>;
}
const phases: SupervisorPhase[] = ['preflight', 'waiting_desktop_exit', 'pausing_legacy', 'closing_desktop', 'starting_broker', 'starting_host', 'starting_listener', 'running', 'stopping_listener', 'stopping_host', 'restoring_desktop', 'restoring_legacy', 'stopping_broker', 'restored', 'closed', 'blocked'];
function validIdentity(p: ProcessIdentity): boolean {
  return !!p && Number.isSafeInteger(p.pid) && p.pid > 0 && Number.isSafeInteger(p.parentPid) && p.parentPid >= 0
    && typeof p.createdAt === 'string' && Number.isFinite(Date.parse(p.createdAt)) && typeof p.executable === 'string' && isAbsolute(p.executable) && /^[a-f0-9]{64}$/.test(p.commandLineSha256);
}
export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return validIdentity(a) && validIdentity(b) && a.pid === b.pid && a.parentPid === b.parentPid && a.createdAt === b.createdAt && a.executable === b.executable && a.commandLineSha256 === b.commandLineSha256;
}
class SupervisorFailure extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new SupervisorFailure(code); };
const codeOf = (e: unknown, fallback: string) => e instanceof SupervisorFailure ? e.code : fallback;

/** One journal writer; restart resumes rollback, never a forward launch. */
export class SupervisorJournal {
  private release?: () => Promise<void>;
  constructor(readonly path: string, private readonly staleMs = 10_000) {
    if (!isAbsolute(path) || !Number.isSafeInteger(staleMs) || staleMs < 2000) throw new Error('Supervisor journal path or stale interval is invalid');
  }
  /** Observe natural expiry without acquiring/removing a live writer's lock.
   * Availability is only a hint: open() still performs the atomic acquisition. */
  async waitUntilAvailable(timeoutMs = 15_000): Promise<boolean> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new Error('Invalid journal availability timeout');
    const deadline = Date.now() + timeoutMs;
    do {
      if (!await lockfile.check(this.path, { realpath: false, stale: this.staleMs })) return true;
      const remaining = deadline - Date.now(); if (remaining <= 0) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(100,remaining)));
    } while (true);
  }
  async open(): Promise<SupervisorState | undefined> {
    await mkdir(dirname(this.path), { recursive: true });
    this.release = await lockfile.lock(this.path, { realpath: false, retries: 0, stale: this.staleMs });
    try {
      let state: SupervisorState;
      try { state = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
      if (state.version !== 1 || !/^[a-f0-9-]{36}$/.test(state.runId) || !phases.includes(state.phase) || !Number.isSafeInteger(state.revision) || state.revision < 0
        || (state.channelMode!==undefined && state.channelMode!=='new-only')
        || (state.startMode !== undefined && !['hot','cold'].includes(state.startMode)) || (state.desktopRestoreRequired !== undefined && typeof state.desktopRestoreRequired !== 'boolean')
        || typeof state.legacyPauseAttempted !== 'boolean' || typeof state.desktopCloseAttempted !== 'boolean' || !state.owned
        || Object.entries(state.owned).some(([role, identity]) => !['broker','host','listener'].includes(role) || !validIdentity(identity))) fail('journal_invalid');
      if (state.baseline && (!validIdentity(state.baseline.legacy) || !validIdentity(state.baseline.desktop) || typeof state.baseline.legacyTaskEnabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(state.baseline.launchDefinitionSha256))) fail('journal_baseline_invalid');
      if(state.channelMode==='new-only'){
        if(state.startMode!=='cold' || state.baseline || state.legacyPauseAttempted || state.desktopCloseAttempted || ['pausing_legacy','closing_desktop','restoring_legacy'].includes(state.phase)
          || state.newBaseline && ((state.newBaseline.desktop ? !validIdentity(state.newBaseline.desktop) : state.serviceMode!=='stop-with-desktop') || !validRetirementProof(state.newBaseline.retirement)))fail('journal_new_only_invalid');
      }else if(state.newBaseline)fail('journal_new_only_invalid');
      if(state.serviceMode!==undefined && (state.serviceMode!=='stop-with-desktop' || state.channelMode!=='new-only')
        || state.desktopQuitVerified!==undefined && (state.desktopQuitVerified!==true || state.serviceMode!=='stop-with-desktop' || !state.lastIdleProof || !state.owned.host || !state.owned.listener)
        || state.phase==='closed' && !state.desktopQuitVerified)fail('journal_service_policy_invalid');
      if ((state.legacyPauseAttempted || state.desktopCloseAttempted || state.desktopRestoreRequired || Object.keys(state.owned).length) && !(state.channelMode==='new-only'?state.newBaseline:state.baseline)) fail('journal_baseline_missing');
      return state;
    } catch (e) { await this.close(); throw e; }
  }
  async save(state: SupervisorState): Promise<void> {
    if (!this.release) fail('journal_not_locked');
    state.revision++; state.updatedAt = new Date().toISOString();
    await writeFileAtomic(this.path, JSON.stringify(state, null, 2));
  }
  async close(): Promise<void> { const release = this.release; this.release = undefined; await release?.(); }
}

/** The OS adapter supplies observations; the state machine never guesses task
 * idleness from a model answer or kills a process using a PID alone. */
export class DesktopSupervisor {
  constructor(private readonly journal: SupervisorJournal, private readonly port: SupervisorPort, private readonly bindings: readonly SupervisorBinding[], private readonly now = Date.now) {
    if (!bindings.length || bindings.some(b => typeof b.threadId !== 'string' || !b.threadId || typeof b.projectId !== 'string' || !b.projectId || !isAbsolute(b.projectRoot)) || new Set(bindings.map(b => b.threadId)).size !== bindings.length) throw new Error('Supervisor requires unique original bindings');
  }
  private desktop(s:SupervisorState){return s.channelMode==='new-only'?s.newBaseline!.desktop:s.baseline!.desktop;}
  private async retired(s?:SupervisorState):Promise<LegacyRetirementProof>{
    const i=await this.inventory(),p=await this.port.legacyRetirement!();
    if(i.legacy.length || !validRetirementProof(p) || p.observedAt>this.now()+1000 || this.now()-p.observedAt>60_000)fail('legacy_retirement_unverified');
    if(s?.newBaseline && (p.taskPresent!==s.newBaseline.retirement.taskPresent || p.definitionSha256!==s.newBaseline.retirement.definitionSha256))fail('legacy_retirement_definition_changed');
    return p;
  }
  private async inventory(): Promise<SupervisorInventory> {
    const i = await this.port.inventory();
    if (['legacy','desktop','host','listener','broker'].some(role => !Array.isArray(i[role as keyof SupervisorInventory]) || i[role as keyof SupervisorInventory].some(p => !validIdentity(p)))) fail('inventory_invalid');
    return i;
  }
  private async idle(desktop: ProcessIdentity, state: SupervisorState, shared = false): Promise<void> {
    const p = await (shared ? this.port.sharedIdle!() : this.port.idle());
    if (!Number.isFinite(p.verifiedAt) || p.verifiedAt > this.now() + 1000 || this.now() - p.verifiedAt > 5000 || !sameProcess(p.desktop, desktop)
      || p.allDesktopTasksIdle !== true || p.toolsExact !== true || !Array.isArray(p.tasks) || new Set(p.tasks.map(t => t.threadId)).size !== p.tasks.length
      || p.tasks.some(t => !['idle','notLoaded'].includes(t.status) || t.queueCount !== 0 || t.waitingApproval !== false)
      || this.bindings.some(b => !p.tasks.some(t => t.threadId === b.threadId && t.projectId === b.projectId && t.projectRoot === b.projectRoot))) fail('idle_proof_rejected');
    state.lastIdleProof = { verifiedAt: p.verifiedAt, desktop: structuredClone(p.desktop), allDesktopTasksIdle: p.allDesktopTasksIdle, toolsExact: p.toolsExact,
      tasks: p.tasks.map(t => ({ threadId: t.threadId, projectId: t.projectId, projectRoot: t.projectRoot, status: t.status, queueCount: t.queueCount, waitingApproval: t.waitingApproval })) };
    await this.journal.save(state);
  }
  private async coldExit(s: SupervisorState): Promise<boolean> {
    let p: ColdExitProof, i: SupervisorInventory;
    try { p = await this.port.coldExit!(); i = await this.inventory(); }
    catch (error) {
      // Re-read only during the existing bounded wait. No proof, service
      // launch, process stop, queue submission, or desktop restore is implied.
      if (isUnavailableColdRead(error)) return false;
      throw error;
    }
    if (p.complete !== true || !Number.isFinite(p.verifiedAt) || p.verifiedAt > this.now() + 1000 || this.now() - p.verifiedAt > 5000
      || !Array.isArray(p.desktopRelated) || p.desktopRelated.some(identity => !validIdentity(identity))) fail('cold_exit_proof_rejected');
    if (i.legacy.length !== (s.channelMode==='new-only' || s.legacyPauseAttempted ? 0 : 1) || (s.channelMode!=='new-only' && !s.legacyPauseAttempted && !sameProcess(i.legacy[0]!, s.baseline!.legacy))
      || i.host.length || i.listener.length || i.broker.length !== (s.owned.broker ? 1 : 0) || (s.owned.broker && !sameProcess(i.broker[0]!, s.owned.broker))
      || i.desktop.length > 1 || (i.desktop.length && (!this.desktop(s) || !sameProcess(i.desktop[0]!, this.desktop(s)!)))) fail('cold_exit_inventory_changed');
    // The second inventory must also report no desktop. Never accept a stale
    // disappearance proof when the user has reopened the app during the scan.
    const exited = !p.desktopRelated.length && !i.desktop.length;
    if (exited) { s.lastColdExitProof = { verifiedAt:p.verifiedAt,complete:true,desktopRelated:[] };if(s.channelMode==='new-only')s.desktopRestoreRequired=true; await this.journal.save(s); }
    return exited;
  }
  private async phase(s: SupervisorState, phase: SupervisorPhase): Promise<void> { s.phase = phase; await this.journal.save(s); }
  private async launch(s: SupervisorState, role: 'broker' | 'host' | 'listener'): Promise<void> {
    await this.phase(s, `starting_${role}`);
    const before = await this.inventory();
    if (before[role].length || (role === 'listener' && before.legacy.length)) fail('consumer_or_role_conflict');
    if (role === 'listener' && s.startMode === 'cold' && (!s.lastIdleProof || this.now() - s.lastIdleProof.verifiedAt > 5000
      || before.desktop.length !== 1 || !sameProcess(before.desktop[0]!, s.lastIdleProof.desktop))) fail('cold_shared_proof_stale_or_changed');
    const identity = await (role === 'broker' ? this.port.startBroker(s.runId) : role === 'host' ? this.port.startHost(s.runId) : this.port.startListener(s.runId));
    if (!validIdentity(identity)) fail('launch_identity_invalid');
    s.owned[role] = structuredClone(identity); await this.journal.save(s);
    const after = await this.inventory();
    if (after[role].length !== 1 || !sameProcess(after[role][0]!, identity) || after.legacy.length) fail('launch_inventory_conflict');
  }
  private async stopOwned(s: SupervisorState, role: 'broker' | 'host' | 'listener'): Promise<void> {
    const current = (await this.inventory())[role], owned = s.owned[role];
    if (current.length) {
      if (!owned || current.length !== 1 || !sameProcess(current[0]!, owned)) fail('owned_process_unconfirmed');
      await (role === 'broker' ? this.port.stopBroker(structuredClone(owned!)) : role === 'host' ? this.port.stopHost(structuredClone(owned!)) : this.port.stopListener(structuredClone(owned!)));
    }
    if ((await this.inventory())[role].length) fail('owned_process_still_running');
    // Keep the last identity receipt for postmortem/repeated rollback checks.
  }
  private async managedDesktopQuit(s:SupervisorState,stopRequested:()=>Promise<boolean>):Promise<boolean>{
    if(!s.serviceMode)return false;
    const quit=await this.port.desktopQuit!();if(!quit)return false;
    const q=await this.inventory();
    if(!s.lastIdleProof || !sameProcess(quit,s.lastIdleProof.desktop) || q.desktop.length || q.legacy.length
      || q.host.length>1 || q.host.length && !sameProcess(q.host[0]!,s.owned.host!)
      || q.broker.length!==1 || !sameProcess(q.broker[0]!,s.owned.broker!) || q.listener.length!==1 || !sameProcess(q.listener[0]!,s.owned.listener!))fail('desktop_quit_inventory_changed');
    // A failed retirement health check cannot become a clean exit merely
    // because the GUI also exited. Retain the original retirement policy.
    await this.retired(s);
    if(await stopRequested())return false;
    s.desktopQuitVerified=true;await this.journal.save(s);return true;
  }
  private async rollback(s: SupervisorState): Promise<void> {
    try {
      const initial = await this.inventory();
      for (const role of ['broker','host','listener'] as const) {
        if (initial[role].length && (!s.owned[role] || initial[role].length !== 1 || !sameProcess(initial[role][0]!, s.owned[role]!))) fail('owned_process_unconfirmed');
      }
      await this.phase(s, 'stopping_listener'); await this.stopOwned(s, 'listener');
      await this.phase(s, 'stopping_host'); await this.stopOwned(s, 'host');
      const stopped = await this.inventory();
      if (stopped.host.length || stopped.listener.length) fail('new_runtime_not_stopped');
      if (!s.desktopQuitVerified && (s.desktopCloseAttempted || s.desktopRestoreRequired)) {
        await this.phase(s, 'restoring_desktop');
        const proof = await this.port.ordinary(), observed = await this.inventory();
        if (proof.packageIdentityVerified !== true || proof.toolsExact !== true || !Number.isFinite(proof.verifiedAt) || proof.verifiedAt > this.now() + 1000 || this.now() - proof.verifiedAt > 60_000
          || observed.desktop.length !== 1 || !sameProcess(proof.desktop, observed.desktop[0]!)) fail('ordinary_desktop_unverified');
        s.ordinaryProof = proof; await this.journal.save(s);
      }
      await (s.desktopQuitVerified && this.port.verifyClosedBindings ? this.port.verifyClosedBindings() : this.port.verifyBindings());
      if (s.legacyPauseAttempted && s.channelMode!=='new-only') {
        await this.phase(s, 'restoring_legacy');
        await this.port.restoreLegacy(structuredClone(s.baseline!));
      }
      await this.phase(s, 'stopping_broker'); await this.stopOwned(s, 'broker');
      const final = await this.inventory();
      if (final.host.length || final.listener.length || final.broker.length || final.legacy.length !== (s.channelMode==='new-only'?0:1) || final.desktop.length !== (s.desktopQuitVerified?0:1)) fail('rollback_inventory_incomplete');
      if(s.desktopQuitVerified){
        const cold=await this.port.coldExit!();
        if(cold.complete!==true || !Number.isFinite(cold.verifiedAt) || cold.verifiedAt>this.now()+1000 || this.now()-cold.verifiedAt>5000 || !Array.isArray(cold.desktopRelated) || cold.desktopRelated.length)fail('closed_desktop_unverified');
      }
      if(s.channelMode==='new-only')await this.retired(s);
      await (s.desktopQuitVerified && this.port.verifyClosedBindings ? this.port.verifyClosedBindings() : this.port.verifyBindings());
      delete s.rollbackErrorCode; await this.phase(s, s.desktopQuitVerified?'closed':'restored');
    } catch (e) {
      s.rollbackErrorCode = codeOf(e, 'rollback_operation_failed');
      await this.phase(s, 'blocked');
    }
  }
  /** The caller supplies an independent stop source. No automatic Feishu
   * message, approval decision, task creation or model submit exists here. */
  async run(stopRequested: () => Promise<boolean>, pause: () => Promise<void>, options: { startMode?: 'hot' | 'cold'; exitTimeoutMs?: number; channelMode?:'new-only'; serviceMode?:'stop-with-desktop' } = {}): Promise<SupervisorState> {
    const mode = options.startMode ?? 'hot', timeout = options.exitTimeoutMs ?? 600_000;
    if (!['hot','cold'].includes(mode) || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_700_000) throw new Error('Invalid supervisor start mode or exit timeout');
    if (mode === 'cold' && (!this.port.coldExit || !this.port.sharedIdle)) throw new Error('Cold start requires exit inventory and shared native idle probes');
    if(options.channelMode!==undefined && (options.channelMode!=='new-only' || mode!=='cold' || !this.port.legacyRetirement))throw new Error('New-only mode requires cold admission and retirement proof');
    if(options.serviceMode!==undefined && (options.serviceMode!=='stop-with-desktop' || options.channelMode!=='new-only' || !this.port.desktopQuit))throw new Error('Managed service requires new-only mode and owned desktop quit evidence');
    let s = await this.journal.open();
    try {
      if(s && s.channelMode!==options.channelMode)fail('journal_channel_policy_mismatch');
      if(s && s.serviceMode!==options.serviceMode)fail('journal_service_policy_mismatch');
      if(s?.phase==='closed')return s;
      if (s && s.phase !== 'restored') {
        if (s.startMode === 'cold' && !s.legacyPauseAttempted && !s.desktopCloseAttempted && !s.desktopRestoreRequired && !Object.keys(s.owned).length) {
          s.errorCode = 'cold_start_resume_requires_new_plan'; await this.phase(s,'blocked');
        } else await this.rollback(s);
        return s;
      }
      s = { version: 1, runId: randomUUID(), startMode:mode,...(options.channelMode?{channelMode:options.channelMode}:{}),...(options.serviceMode?{serviceMode:options.serviceMode}:{}), phase: 'preflight', revision: 0, updatedAt: new Date().toISOString(), owned: {}, legacyPauseAttempted: false, desktopCloseAttempted: false };
      await this.journal.save(s);
      try {
        await this.port.verifyBindings();
        const baseline = await this.inventory();
        if (baseline.legacy.length !== (s.channelMode==='new-only'?0:1) || (s.serviceMode?baseline.desktop.length>1:baseline.desktop.length!==1) || baseline.host.length || baseline.listener.length || baseline.broker.length) fail('baseline_not_unique');
        if (mode === 'hot') await this.idle(baseline.desktop[0]!, s);
        if(s.channelMode==='new-only'){
          s.newBaseline={...(baseline.desktop[0]?{desktop:structuredClone(baseline.desktop[0])}:{}),retirement:await this.retired(s)};await this.journal.save(s);
        }else{
          const backup = await this.port.backup();
          if (typeof backup.legacyTaskEnabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(backup.launchDefinitionSha256)) fail('backup_unverified');
          s.baseline = { legacy: structuredClone(baseline.legacy[0]!), desktop: structuredClone(baseline.desktop[0]!), legacyTaskEnabled: backup.legacyTaskEnabled, launchDefinitionSha256: backup.launchDefinitionSha256 }; await this.journal.save(s);
        }
        if (await stopRequested()) { await this.phase(s, 'restored'); return s; }
        if (mode === 'cold') {
          await this.phase(s,'waiting_desktop_exit');
          const deadline = this.now() + timeout;
          for (;;) {
            if (await stopRequested()) { await this.phase(s,'blocked'); s.errorCode = 'stop_requested'; await this.journal.save(s); return s; }
            if (this.now() >= deadline) fail('cold_exit_timeout');
            if (await this.coldExit(s)) break;
            await pause();
          }
          await this.port.verifyBindings();
          if (!await this.coldExit(s)) fail('cold_desktop_reappeared');
          if (await stopRequested()) fail('stop_requested');
          // Human already closed the ordinary desktop; recovery after any
          // legacy pause attempt must restore it even if host launch fails.
          s.desktopRestoreRequired = true;
        } else await this.idle(s.baseline!.desktop, s);
        if(s.channelMode==='new-only')await this.retired(s);
        else{
          s.legacyPauseAttempted = true; await this.phase(s, 'pausing_legacy');
          await this.port.pauseLegacy(structuredClone(s.baseline!.legacy));
          if ((await this.inventory()).legacy.length) fail('legacy_not_stopped');
          if (await stopRequested()) fail('stop_requested');
        }
        if (mode === 'cold') {
          if (!await this.coldExit(s)) fail('cold_desktop_reappeared');
        } else {
          // A task may start while the legacy consumer is being stopped.
          await this.idle(s.baseline!.desktop, s);
          s.desktopCloseAttempted = true; await this.phase(s, 'closing_desktop');
          await this.port.closeDesktop(structuredClone(s.baseline!.desktop));
          if ((await this.inventory()).desktop.length) fail('desktop_reappeared');
        }
        if (await stopRequested()) fail('stop_requested');
        await this.launch(s, 'broker');
        if (await stopRequested()) fail('stop_requested');
        if (mode === 'cold' && !await this.coldExit(s)) fail('cold_desktop_reappeared');
        await this.launch(s, 'host');
        await this.port.ready();
        if (await stopRequested()) fail('stop_requested');
        if (mode === 'cold') {
          const shared = await this.inventory();
          if (shared.desktop.length !== 1 || this.desktop(s) && sameProcess(shared.desktop[0]!, this.desktop(s)!)) fail('cold_shared_desktop_not_unique');
          await this.idle(shared.desktop[0]!, s, true);
          await this.port.verifyBindings();
          if(s.channelMode==='new-only')await this.retired(s);
          if (await stopRequested()) fail('stop_requested');
          // Recheck after bindings so that the listener uses a fresh proof.
          await this.idle(shared.desktop[0]!, s, true);
        }
        await this.launch(s, 'listener'); await this.port.ready();
        await this.phase(s, 'running');
        while (!await stopRequested()) {
          if(await this.managedDesktopQuit(s,stopRequested))break;
          const i = await this.inventory();
          if (i.legacy.length || ['broker','host','listener'].some(role => i[role as 'broker'|'host'|'listener'].length !== 1 || !sameProcess(i[role as 'broker'|'host'|'listener'][0]!, s!.owned[role as 'broker'|'host'|'listener']!)) || !await this.port.health()) {
            // GUI exit can begin after the preceding quit check and during
            // inventory/health reads. Before restoration, observe the same
            // original clean-exit receipt once more (adapter bound: 20s).
            // Missing/abnormal receipts still fail; no health retry, stale
            // readiness allowance, service restart or input replay occurs.
            if(await stopRequested())fail('runtime_health_failed');
            if(await this.managedDesktopQuit(s,stopRequested))break;
            fail('runtime_health_failed');
          }
          await pause();
        }
      } catch (e) { s.errorCode = codeOf(e, 'supervisor_operation_failed'); await this.journal.save(s); }
      if (s.legacyPauseAttempted || s.desktopCloseAttempted || s.desktopRestoreRequired || Object.keys(s.owned).length) await this.rollback(s);
      else await this.phase(s, 'blocked');
      return s;
    } finally { await this.journal.close(); }
  }
}
