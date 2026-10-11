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
export type SupervisorPhase = 'preflight' | 'pausing_legacy' | 'closing_desktop' | 'starting_broker' | 'starting_host' | 'starting_listener' | 'running'
  | 'stopping_listener' | 'stopping_host' | 'restoring_desktop' | 'restoring_legacy' | 'stopping_broker' | 'restored' | 'blocked';
export interface SupervisorState {
  version: 1;
  runId: string;
  phase: SupervisorPhase;
  revision: number;
  updatedAt: string;
  baseline?: { legacy: ProcessIdentity; desktop: ProcessIdentity; legacyTaskEnabled: boolean; launchDefinitionSha256: string };
  owned: Partial<Record<'host' | 'listener' | 'broker', ProcessIdentity>>;
  /** Intent is durable before every potentially destructive call. */
  legacyPauseAttempted: boolean;
  desktopCloseAttempted: boolean;
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
}
const phases: SupervisorPhase[] = ['preflight', 'pausing_legacy', 'closing_desktop', 'starting_broker', 'starting_host', 'starting_listener', 'running', 'stopping_listener', 'stopping_host', 'restoring_desktop', 'restoring_legacy', 'stopping_broker', 'restored', 'blocked'];
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
  async open(): Promise<SupervisorState | undefined> {
    await mkdir(dirname(this.path), { recursive: true });
    this.release = await lockfile.lock(this.path, { realpath: false, retries: 0, stale: this.staleMs });
    try {
      let state: SupervisorState;
      try { state = JSON.parse(await readFile(this.path, 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
      if (state.version !== 1 || !/^[a-f0-9-]{36}$/.test(state.runId) || !phases.includes(state.phase) || !Number.isSafeInteger(state.revision) || state.revision < 0
        || typeof state.legacyPauseAttempted !== 'boolean' || typeof state.desktopCloseAttempted !== 'boolean' || !state.owned
        || Object.entries(state.owned).some(([role, identity]) => !['broker','host','listener'].includes(role) || !validIdentity(identity))) fail('journal_invalid');
      if (state.baseline && (!validIdentity(state.baseline.legacy) || !validIdentity(state.baseline.desktop) || typeof state.baseline.legacyTaskEnabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(state.baseline.launchDefinitionSha256))) fail('journal_baseline_invalid');
      if ((state.legacyPauseAttempted || state.desktopCloseAttempted || Object.keys(state.owned).length) && !state.baseline) fail('journal_baseline_missing');
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
  private async inventory(): Promise<SupervisorInventory> {
    const i = await this.port.inventory();
    if (['legacy','desktop','host','listener','broker'].some(role => !Array.isArray(i[role as keyof SupervisorInventory]) || i[role as keyof SupervisorInventory].some(p => !validIdentity(p)))) fail('inventory_invalid');
    return i;
  }
  private async idle(desktop: ProcessIdentity, state: SupervisorState): Promise<void> {
    const p = await this.port.idle();
    if (!Number.isFinite(p.verifiedAt) || p.verifiedAt > this.now() + 1000 || this.now() - p.verifiedAt > 5000 || !sameProcess(p.desktop, desktop)
      || p.allDesktopTasksIdle !== true || p.toolsExact !== true || !Array.isArray(p.tasks) || new Set(p.tasks.map(t => t.threadId)).size !== p.tasks.length
      || p.tasks.some(t => !['idle','notLoaded'].includes(t.status) || t.queueCount !== 0 || t.waitingApproval !== false)
      || this.bindings.some(b => !p.tasks.some(t => t.threadId === b.threadId && t.projectId === b.projectId && t.projectRoot === b.projectRoot))) fail('idle_proof_rejected');
    state.lastIdleProof = { verifiedAt: p.verifiedAt, desktop: structuredClone(p.desktop), allDesktopTasksIdle: p.allDesktopTasksIdle, toolsExact: p.toolsExact,
      tasks: p.tasks.map(t => ({ threadId: t.threadId, projectId: t.projectId, projectRoot: t.projectRoot, status: t.status, queueCount: t.queueCount, waitingApproval: t.waitingApproval })) };
    await this.journal.save(state);
  }
  private async phase(s: SupervisorState, phase: SupervisorPhase): Promise<void> { s.phase = phase; await this.journal.save(s); }
  private async launch(s: SupervisorState, role: 'broker' | 'host' | 'listener'): Promise<void> {
    await this.phase(s, `starting_${role}`);
    const before = await this.inventory();
    if (before[role].length || (role === 'listener' && before.legacy.length)) fail('consumer_or_role_conflict');
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
      if (s.desktopCloseAttempted) {
        await this.phase(s, 'restoring_desktop');
        const proof = await this.port.ordinary(), observed = await this.inventory();
        if (proof.packageIdentityVerified !== true || proof.toolsExact !== true || !Number.isFinite(proof.verifiedAt) || proof.verifiedAt > this.now() + 1000 || this.now() - proof.verifiedAt > 60_000
          || observed.desktop.length !== 1 || !sameProcess(proof.desktop, observed.desktop[0]!)) fail('ordinary_desktop_unverified');
        s.ordinaryProof = proof; await this.journal.save(s);
      }
      await this.port.verifyBindings();
      if (s.legacyPauseAttempted) {
        await this.phase(s, 'restoring_legacy');
        await this.port.restoreLegacy(structuredClone(s.baseline!));
      }
      await this.phase(s, 'stopping_broker'); await this.stopOwned(s, 'broker');
      const final = await this.inventory();
      if (final.host.length || final.listener.length || final.broker.length || final.legacy.length !== 1 || final.desktop.length !== 1) fail('rollback_inventory_incomplete');
      await this.port.verifyBindings();
      delete s.rollbackErrorCode; await this.phase(s, 'restored');
    } catch (e) {
      s.rollbackErrorCode = codeOf(e, 'rollback_operation_failed');
      await this.phase(s, 'blocked');
    }
  }
  /** The caller supplies an independent stop source. No automatic Feishu
   * message, approval decision, task creation or model submit exists here. */
  async run(stopRequested: () => Promise<boolean>, pause: () => Promise<void>): Promise<SupervisorState> {
    let s = await this.journal.open();
    try {
      if (s && s.phase !== 'restored') { await this.rollback(s); return s; }
      s = { version: 1, runId: randomUUID(), phase: 'preflight', revision: 0, updatedAt: new Date().toISOString(), owned: {}, legacyPauseAttempted: false, desktopCloseAttempted: false };
      await this.journal.save(s);
      try {
        await this.port.verifyBindings();
        const baseline = await this.inventory();
        if (baseline.legacy.length !== 1 || baseline.desktop.length !== 1 || baseline.host.length || baseline.listener.length || baseline.broker.length) fail('baseline_not_unique');
        await this.idle(baseline.desktop[0]!, s);
        const backup = await this.port.backup();
        if (typeof backup.legacyTaskEnabled !== 'boolean' || !/^[a-f0-9]{64}$/.test(backup.launchDefinitionSha256)) fail('backup_unverified');
        s.baseline = { legacy: structuredClone(baseline.legacy[0]!), desktop: structuredClone(baseline.desktop[0]!), legacyTaskEnabled: backup.legacyTaskEnabled, launchDefinitionSha256: backup.launchDefinitionSha256 }; await this.journal.save(s);
        if (await stopRequested()) { await this.phase(s, 'restored'); return s; }
        await this.idle(s.baseline.desktop, s);
        s.legacyPauseAttempted = true; await this.phase(s, 'pausing_legacy');
        await this.port.pauseLegacy(structuredClone(s.baseline.legacy));
        if ((await this.inventory()).legacy.length) fail('legacy_not_stopped');
        if (await stopRequested()) fail('stop_requested');
        // A task may start while the legacy consumer is being stopped.
        await this.idle(s.baseline.desktop, s);
        s.desktopCloseAttempted = true; await this.phase(s, 'closing_desktop');
        await this.port.closeDesktop(structuredClone(s.baseline.desktop));
        if ((await this.inventory()).desktop.length) fail('desktop_reappeared');
        if (await stopRequested()) fail('stop_requested');
        await this.launch(s, 'broker');
        if (await stopRequested()) fail('stop_requested');
        await this.launch(s, 'host');
        await this.port.ready();
        if (await stopRequested()) fail('stop_requested');
        await this.launch(s, 'listener'); await this.port.ready();
        await this.phase(s, 'running');
        while (!await stopRequested()) {
          const i = await this.inventory();
          if (i.legacy.length || ['broker','host','listener'].some(role => i[role as 'broker'|'host'|'listener'].length !== 1 || !sameProcess(i[role as 'broker'|'host'|'listener'][0]!, s!.owned[role as 'broker'|'host'|'listener']!)) || !await this.port.health()) fail('runtime_health_failed');
          await pause();
        }
      } catch (e) { s.errorCode = codeOf(e, 'supervisor_operation_failed'); await this.journal.save(s); }
      if (s.legacyPauseAttempted || s.desktopCloseAttempted || Object.keys(s.owned).length) await this.rollback(s);
      else await this.phase(s, 'blocked');
      return s;
    } finally { await this.journal.close(); }
  }
}
