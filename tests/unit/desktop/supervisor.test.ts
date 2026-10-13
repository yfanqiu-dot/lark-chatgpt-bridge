import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopSupervisor, SupervisorJournal, sameProcess, type IdleProof, type ProcessIdentity, type SupervisorInventory, type SupervisorPort, type SupervisorState } from '../../../src/desktop/supervisor';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'p4-supervisor-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const identity = (pid: number): ProcessIdentity => ({ pid, parentPid: 1, createdAt: '2026-10-11T00:00:00.000Z', executable: process.execPath, commandLineSha256: 'a'.repeat(64) });
const bindings = [{ threadId: 'thread', projectId: 'project', projectRoot: tmpdir() }];
it('waits for lock availability without disturbing an active writer', async () => {
  const path = join(dir,'availability.json'), writer = new SupervisorJournal(path), observer = new SupervisorJournal(path);
  await writer.open();
  try { expect(await observer.waitUntilAvailable(30)).toBe(false); await expect(observer.open()).rejects.toThrow(); }
  finally { await writer.close(); }
  expect(await observer.waitUntilAvailable(30)).toBe(true); await observer.open(); await observer.close();
});
function harness() {
  const inventory: SupervisorInventory = { legacy: [identity(1)], desktop: [identity(2)], host: [], listener: [], broker: [] };
  const events: string[] = []; let failedStep = '', failAfter = false, health = true, stop = false;
  let idleOverride: Partial<IdleProof> = {};
  const step = async (name: string, action: () => void = () => {}) => {
    events.push(name);
    if (failedStep === name && !failAfter) throw new Error('SECRET_OPERATION_ERROR');
    action();
    if (failedStep === name && failAfter) throw new Error('SECRET_OPERATION_ERROR');
  };
  const port: SupervisorPort = {
    async inventory() { return structuredClone(inventory); },
    async idle() { await step('idle'); return { verifiedAt: Date.now(), desktop: inventory.desktop[0]!, allDesktopTasksIdle: true, toolsExact: true, tasks: bindings.map(b => ({ ...b, status: 'idle', queueCount: 0, waitingApproval: false })), ...idleOverride }; },
    async backup() { await step('backup'); return { legacyTaskEnabled: true, launchDefinitionSha256: 'b'.repeat(64) }; },
    async pauseLegacy() { await step('pauseLegacy', () => { inventory.legacy = []; }); },
    async closeDesktop() { await step('closeDesktop', () => { inventory.desktop = []; }); },
    async startBroker() { await step('startBroker', () => { inventory.broker = [identity(3)]; }); return inventory.broker[0]!; },
    async startHost() { await step('startHost', () => { inventory.host = [identity(4)]; inventory.desktop = [identity(5)]; }); return inventory.host[0]!; },
    async startListener() { await step('startListener', () => { inventory.listener = [identity(6)]; }); return inventory.listener[0]!; },
    async ready() { await step('ready'); },
    async health() { await step('health'); return health; },
    async stopListener(p) { expect(sameProcess(p, inventory.listener[0]!)).toBe(true); await step('stopListener', () => { inventory.listener = []; }); },
    async stopHost(p) { expect(sameProcess(p, inventory.host[0]!)).toBe(true); await step('stopHost', () => { inventory.host = []; inventory.desktop = []; }); },
    async ordinary() { await step('ordinary', () => { inventory.desktop = [identity(7)]; }); return { desktop: inventory.desktop[0]!, verifiedAt: Date.now(), packageIdentityVerified: true, toolsExact: true }; },
    async restoreLegacy(baseline) { expect(baseline.legacyTaskEnabled).toBe(true); await step('restoreLegacy', () => { inventory.legacy = [identity(8)]; }); },
    async stopBroker(p) { expect(sameProcess(p, inventory.broker[0]!)).toBe(true); await step('stopBroker', () => { inventory.broker = []; }); },
    async verifyBindings() { await step('bindings'); },
  };
  const path = join(dir, 'supervisor.json');
  return { inventory, events, port, path, supervisor: () => new DesktopSupervisor(new SupervisorJournal(path), port, bindings),
    run: () => new DesktopSupervisor(new SupervisorJournal(path), port, bindings).run(async () => stop, async () => { stop = true; }),
    fail(name: string, after = false) { failedStep = name; failAfter = after; },
    setIdle(p: Partial<IdleProof>) { idleOverride = p; }, setHealth(value: boolean) { health = value; }, setStop(value: boolean) { stop = value; } };
}

it('switches a single consumer, writes intent before side effects and restores in dependency order', async () => {
  const h = harness(), pause = h.port.pauseLegacy;
  h.port.pauseLegacy = async p => { const s = JSON.parse(await readFile(h.path, 'utf8')); expect(s).toMatchObject({ phase: 'pausing_legacy', legacyPauseAttempted: true, baseline: { legacy: p } }); await pause(p); };
  const result = await h.run(); expect(result.phase).toBe('restored');
  expect(h.events.filter(e => !['idle','bindings','ready','health'].includes(e))).toEqual(['backup','pauseLegacy','closeDesktop','startBroker','startHost','startListener','stopListener','stopHost','ordinary','restoreLegacy','stopBroker']);
  expect(h.inventory).toMatchObject({ legacy: [identity(8)], desktop: [identity(7)], host: [], listener: [], broker: [] });
});
it.each(['pauseLegacy','closeDesktop','startBroker','startHost','startListener','ready'])('rolls back a known failure before %s without relaunching model consumers', async step => {
  const h = harness(); h.fail(step); const result = await h.run();
  expect(result.phase).toBe('restored'); expect(result.errorCode).toBe('supervisor_operation_failed');
  expect(h.inventory.legacy).toHaveLength(1); expect(h.inventory.host).toHaveLength(0); expect(h.inventory.listener).toHaveLength(0);
  expect(await readFile(h.path, 'utf8')).not.toContain('SECRET');
  for (const launch of ['startBroker','startHost','startListener']) expect(h.events.filter(e => e === launch).length).toBeLessThanOrEqual(1);
});
it.each(['startBroker','startHost','startListener'])('keeps an ambiguous %s receipt blocked and never guesses which process to stop', async step => {
  const h = harness(); h.fail(step, true); const result = await h.run();
  expect(result.phase).toBe('blocked'); expect(result.rollbackErrorCode).toBe('owned_process_unconfirmed');
  expect(h.events).not.toContain('restoreLegacy'); expect(h.inventory.legacy).toHaveLength(0);
});
it('rejects active, missing, stale or mismatched idle evidence before stopping old consumer', async () => {
  for (const p of [{ allDesktopTasksIdle: false }, { verifiedAt: Date.now() - 6000 }, { tasks: [] }, { tasks: [{ ...bindings[0]!, status: 'idle' as const, queueCount: 1, waitingApproval: false }] }, { desktop: identity(99) }, { toolsExact: false }]) {
    const h = harness(); h.setIdle(p); const result = await h.run();
    expect(result).toMatchObject({ phase: 'blocked', errorCode: 'idle_proof_rejected' }); expect(h.events).not.toContain('pauseLegacy');
    // Each failed check has a separate local journal; no mutation needs recovery.
    await rm(h.path); 
  }
});
it('rechecks native idleness after legacy pause and returns safely if a desktop task starts', async () => {
  const h = harness(), idle = h.port.idle; let reads = 0;
  h.port.idle = async () => { const p = await idle(); if (++reads === 3) p.allDesktopTasksIdle = false; return p; };
  expect(await h.run()).toMatchObject({ phase: 'restored', errorCode: 'idle_proof_rejected' });
  expect(h.events).not.toContain('closeDesktop'); expect(h.events).toContain('restoreLegacy');
});
it('cancels after host readiness before connecting a new listener', async () => {
  const h = harness(), ready = h.port.ready;
  h.port.ready = async () => { await ready(); h.setStop(true); };
  expect(await h.run()).toMatchObject({ phase: 'restored', errorCode: 'stop_requested' }); expect(h.events).not.toContain('startListener');
});
it('automatically rolls back failed health once without restarting forward', async () => {
  const h = harness(); h.setHealth(false);
  expect(await h.run()).toMatchObject({ phase: 'restored', errorCode: 'runtime_health_failed' });
  expect(h.events.filter(e => e === 'startListener')).toHaveLength(1); expect(h.events.filter(e => e === 'restoreLegacy')).toHaveLength(1);
});
it('refuses PID reuse and leaves the old consumer paused when stopping a replacement cannot be proved', async () => {
  const h = harness(); h.port.health = async () => { h.inventory.listener[0]!.createdAt = '2026-10-11T00:01:00.000Z'; return false; };
  expect(await h.run()).toMatchObject({ phase: 'blocked', rollbackErrorCode: 'owned_process_unconfirmed' });
  expect(h.events).not.toContain('stopListener'); expect(h.events).not.toContain('restoreLegacy');
});
it('does not restore the legacy consumer before ordinary desktop proof succeeds', async () => {
  const h = harness(); h.port.ordinary = async () => ({ desktop: identity(7), verifiedAt: Date.now(), packageIdentityVerified: false, toolsExact: true });
  expect(await h.run()).toMatchObject({ phase: 'blocked', rollbackErrorCode: 'ordinary_desktop_unverified' }); expect(h.events).not.toContain('restoreLegacy');
});
it('restart of an unfinished journal only rolls back and never repeats a forward operation', async () => {
  const h = harness(); const j = new SupervisorJournal(h.path); await j.open();
  const state: SupervisorState = { version: 1, runId: '12345678-1234-1234-1234-123456789abc', phase: 'running', revision: 0, updatedAt: '', baseline: { legacy: identity(1), desktop: identity(2), legacyTaskEnabled: true, launchDefinitionSha256: 'b'.repeat(64) }, owned: { broker: identity(3), host: identity(4), listener: identity(6) }, legacyPauseAttempted: true, desktopCloseAttempted: true };
  await j.save(state); await j.close();
  Object.assign(h.inventory, { legacy: [], desktop: [identity(5)], host: [identity(4)], listener: [identity(6)], broker: [identity(3)] });
  expect((await h.run()).phase).toBe('restored'); expect(h.events.some(e => e.startsWith('start'))).toBe(false);
});
it('locks a journal against two writers and rejects malformed state before any OS call', async () => {
  const h = harness(), a = new SupervisorJournal(h.path), b = new SupervisorJournal(h.path);
  await a.open(); try { await expect(b.open()).rejects.toMatchObject({ code: 'ELOCKED' }); } finally { await a.close(); }
  await writeFile(h.path, JSON.stringify({ version: 1, phase: 'running', owned: {}, legacyPauseAttempted: true }), 'utf8');
  await expect(h.run()).rejects.toThrow('journal_invalid'); expect(h.events).toEqual([]);
});

function coldHarness() {
  const h=harness(); let stop=false, tick=Date.now(), linger=false, reads=0;
  // Every observation must use the injected clock. Wall-clock file IO on a
  // loaded runner cannot turn an otherwise valid ordinary proof into a future
  // timestamp relative to the frozen supervisor clock.
  const ordinary=h.port.ordinary;
  h.port.ordinary=async()=>({...await ordinary(),verifiedAt:tick});
  h.port.coldExit=async () => { h.events.push('coldExit'); reads++; return {verifiedAt:tick,complete:true,desktopRelated:linger ? [identity(90)] : structuredClone(h.inventory.desktop)}; };
  h.port.sharedIdle=async () => { h.events.push('sharedIdle'); return {verifiedAt:tick,desktop:h.inventory.desktop[0]!,allDesktopTasksIdle:true,toolsExact:true,
    tasks:bindings.map(b => ({...b,status:'idle',queueCount:0,waitingApproval:false}))}; };
  const run=(pause=async () => { if(h.inventory.desktop[0]?.pid===2) h.inventory.desktop=[]; else stop=true; }) =>
    new DesktopSupervisor(new SupervisorJournal(h.path),h.port,bindings,()=>tick).run(async()=>stop,pause,{startMode:'cold',exitTimeoutMs:20});
  return {...h,run,stop:()=>{stop=true;},advance:(ms=21)=>{tick+=ms;},linger:()=>{linger=true;},get reads(){return reads;}};
}
it('cold mode waits for a human exit, checks shared tasks twice and never closes the old desktop', async () => {
  const h=coldHarness(); let waiting=false;
  const result=await h.run(async()=>{
    if(h.inventory.desktop[0]?.pid===2) { waiting=true; expect(JSON.parse(await readFile(h.path,'utf8')).phase).toBe('waiting_desktop_exit');
      expect(h.events).not.toContain('pauseLegacy'); h.inventory.desktop=[];
    } else h.stop();
  });
  expect(waiting).toBe(true); expect(result).toMatchObject({startMode:'cold',phase:'restored',desktopCloseAttempted:false,desktopRestoreRequired:true,lastColdExitProof:{desktopRelated:[]}});
  expect(h.events).not.toContain('idle'); expect(h.events).not.toContain('closeDesktop');
  expect(h.events.filter(e=>e==='sharedIdle')).toHaveLength(2);
  expect(h.events.indexOf('sharedIdle')).toBeLessThan(h.events.indexOf('startListener'));
  expect(h.events.indexOf('ordinary')).toBeLessThan(h.events.indexOf('restoreLegacy'));
});
it('cold cancellation during waiting does not stop services or reopen the desktop', async()=>{
  const h=coldHarness(); expect(await h.run(async()=>h.stop())).toMatchObject({phase:'blocked',errorCode:'stop_requested'});
  expect(h.inventory.desktop).toEqual([identity(2)]); expect(h.events).not.toContain('pauseLegacy'); expect(h.events).not.toContain('ordinary');
});
it.each(['desktop','backend'])('cold %s remaining at timeout does not mutate any service',async remaining=>{
  const h=coldHarness();
  if(remaining==='backend') {h.port.backup=async()=>{h.inventory.desktop=[];return {legacyTaskEnabled:true,launchDefinitionSha256:'b'.repeat(64)};};h.linger();}
  expect(await h.run(async()=>h.advance())).toMatchObject({phase:'blocked',errorCode:'cold_exit_timeout'});
  expect(h.events).not.toContain('pauseLegacy'); expect(h.events).not.toContain('startBroker');
});
it.each(['incomplete','stale'])('rejects %s cold inventory evidence before stopping old consumer',async condition=>{
  const h=coldHarness(), read=h.port.coldExit!;
  h.port.coldExit=async()=>({...await read(),...(condition==='incomplete'?{complete:false}:{verifiedAt:Date.now()-6000})});
  expect(await h.run()).toMatchObject({phase:'blocked',errorCode:'cold_exit_proof_rejected'});expect(h.events).not.toContain('pauseLegacy');
});
it('rejects a desktop reopened during cold waiting with a different creation identity',async()=>{
  const h=coldHarness();expect(await h.run(async()=>{h.inventory.desktop=[identity(80)];})).toMatchObject({phase:'blocked',errorCode:'cold_exit_inventory_changed'});
  expect(h.events).not.toContain('pauseLegacy');
});
it.each([{allDesktopTasksIdle:false},{toolsExact:false},{tasks:[]},{tasks:[{...bindings[0]!,status:'idle' as const,queueCount:1,waitingApproval:false}]},
  {tasks:[{...bindings[0]!,status:'idle' as const,queueCount:0,waitingApproval:true}]}])('rejects invalid new shared native proof and restores before old consumer',async proof=>{
  const h=coldHarness(), idle=h.port.sharedIdle!;h.port.sharedIdle=async()=>({...await idle(),...proof});
  expect(await h.run()).toMatchObject({phase:'restored',errorCode:'idle_proof_rejected'});
  expect(h.events).not.toContain('startListener');expect(h.events.indexOf('ordinary')).toBeLessThan(h.events.indexOf('restoreLegacy'));
});
it('cold mode restores an ordinary desktop even if pausing legacy fails before a host was started',async()=>{
  const h=coldHarness(); h.fail('pauseLegacy'); expect(await h.run()).toMatchObject({phase:'restored',desktopCloseAttempted:false,desktopRestoreRequired:true});
  expect(h.events).toContain('ordinary');expect(h.events).not.toContain('startHost');
});
it('restart of cold waiting never treats a human exit as permission for a forward launch',async()=>{
  const h=coldHarness();await h.run(async()=>h.stop());h.events.length=0;
  expect(await h.run()).toMatchObject({phase:'blocked',errorCode:'cold_start_resume_requires_new_plan'}); expect(h.events).toEqual([]);
});
it('a cold journal cannot be resumed as a hot run to bypass native admission',async()=>{
  const h=coldHarness();await h.run(async()=>h.stop()); h.events.length=0;
  expect(await h.supervisor().run(async()=>false,async()=>{})).toMatchObject({phase:'blocked',startMode:'cold',errorCode:'cold_start_resume_requires_new_plan'});
  expect(h.events).toEqual([]);
});
it('requires the real cold exit and new shared probes before opening a cold journal',async()=>{
  const h=harness();await expect(h.supervisor().run(async()=>false,async()=>{},{startMode:'cold'})).rejects.toThrow('Cold start requires');expect(h.events).toEqual([]);
});
it('cold recovery restores the desktop even when no automatic close was attempted',async()=>{
  const h=coldHarness();await h.run();const state=JSON.parse(await readFile(h.path,'utf8'));
  state.phase='running';await writeFile(h.path,JSON.stringify(state),'utf8');
  Object.assign(h.inventory,{legacy:[],desktop:[identity(5)],host:[identity(4)],broker:[identity(3)],listener:[identity(6)]});h.events.length=0;
  expect(await h.run()).toMatchObject({phase:'restored',startMode:'cold',desktopCloseAttempted:false,desktopRestoreRequired:true});
  expect(h.events.some(e=>e.startsWith('start'))).toBe(false);expect(h.events.indexOf('ordinary')).toBeLessThan(h.events.indexOf('restoreLegacy'));
});
it('blocks listener startup when the final shared proof becomes stale during inventory',async()=>{
  const h=coldHarness(), inventory=h.port.inventory;let proofs=0;
  const idle=h.port.sharedIdle!;h.port.sharedIdle=async()=>{proofs++;return idle();};
  h.port.inventory=async()=>{if(proofs===2){h.advance(6000);proofs++;}return inventory();};
  expect(await h.run()).toMatchObject({phase:'restored',errorCode:'cold_shared_proof_stale_or_changed'});expect(h.events).not.toContain('startListener');
});
