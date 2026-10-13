import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DesktopSupervisor,SupervisorJournal,ColdExitObservationUnavailable,type SupervisorPort,type SupervisorInventory,type LegacyRetirementProof,type SupervisorState} from '../../../src/desktop/supervisor';
import {isCleanManagedDesktopExit} from '../../../src/desktop/host';
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'new-only-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
const id=(pid:number)=>({pid,parentPid:1,createdAt:'2026-10-13T00:00:00.000Z',executable:process.execPath,commandLineSha256:'a'.repeat(64)});
const bindings=[{threadId:'original',projectId:'project',projectRoot:tmpdir()}];
function fixture(){
  const inventory:SupervisorInventory={legacy:[],desktop:[id(1)],host:[],listener:[],broker:[]};
  const forbidden=vi.fn(async()=>{throw Error('Legacy operation forbidden');});
  let stop=false,failed='',ambiguous=false,retired=true,health=true;
  const events:string[]=[],path=join(dir,'journal.json');
  const launch=async(role:'broker'|'host'|'listener',pid:number)=>{events.push(`start:${role}`);if(failed===role&&!ambiguous)throw Error('TEST_PRIVATE');inventory[role]=[id(pid)];if(role==='host')inventory.desktop=[id(5)];if(failed===role)throw Error('TEST_PRIVATE');return id(pid);};
  const port:SupervisorPort={
    inventory:async()=>structuredClone(inventory),idle:forbidden,backup:forbidden,pauseLegacy:forbidden,restoreLegacy:forbidden,closeDesktop:forbidden,
    legacyRetirement:async()=>({version:1,observedAt:Date.now(),retired,taskPresent:true,taskEnabled:!retired,taskState:retired?'disabled':'other',definitionSha256:'b'.repeat(64)}),
    coldExit:async()=>({verifiedAt:Date.now(),complete:true,desktopRelated:structuredClone(inventory.desktop)}),
    sharedIdle:async()=>({verifiedAt:Date.now(),desktop:inventory.desktop[0]!,allDesktopTasksIdle:true,toolsExact:true,tasks:bindings.map(b=>({...b,status:'idle',queueCount:0,waitingApproval:false}))}),
    startBroker:()=>launch('broker',2),startHost:()=>launch('host',3),startListener:()=>launch('listener',4),ready:async()=>{},health:async()=>health,
    stopListener:async()=>{events.push('stop:listener');inventory.listener=[];},stopHost:async()=>{events.push('stop:host');inventory.host=[];inventory.desktop=[];},
    ordinary:async()=>{events.push('ordinary');inventory.desktop=[id(6)];return {desktop:id(6),verifiedAt:Date.now(),packageIdentityVerified:true,toolsExact:true};},
    stopBroker:async()=>{events.push('stop:broker');inventory.broker=[];},verifyBindings:async()=>{},
  };
  const run=()=>new DesktopSupervisor(new SupervisorJournal(path),port,bindings).run(async()=>stop,async()=>{if(inventory.desktop[0]?.pid===1)inventory.desktop=[];else stop=true;},{startMode:'cold',channelMode:'new-only'});
  return {inventory,port,path,events,forbidden,run,setRetired:(v:boolean)=>{retired=v;},fail:(s:string,a=false)=>{failed=s;ambiguous=a;},badHealth:()=>{health=false;},stop:()=>{stop=true;}};
}
it('runs and stops the sole new consumer, restoring only the desktop',async()=>{
  const h=fixture(),s=await h.run();expect(s).toMatchObject({phase:'restored',channelMode:'new-only',legacyPauseAttempted:false});expect(s.errorCode).toBeUndefined();expect(s.baseline).toBeUndefined();
  expect(h.events).toEqual(['start:broker','start:host','start:listener','stop:listener','stop:host','ordinary','stop:broker']);expect(h.forbidden).not.toHaveBeenCalled();expect(h.inventory.legacy).toEqual([]);
},15_000);
it.each(['ColdSnapshot','Snapshot'] as const)('waits through an incomplete %s read and launches only after a fresh complete exit proof',async action=>{
  const h=fixture(),read=h.port.coldExit!,inventory=h.port.inventory;
  let failed=false,proved=false,paused=false;
  h.port.coldExit=async()=>{if(action==='ColdSnapshot'&&!failed){failed=true;throw new ColdExitObservationUnavailable(action);}const p=await read();if(!p.desktopRelated.length)proved=true;return p;};
  h.port.inventory=async()=>{const s=JSON.parse(await readFile(h.path,'utf8'));if(action==='Snapshot'&&s.phase==='waiting_desktop_exit'&&!failed){failed=true;throw new ColdExitObservationUnavailable(action);}return inventory();};
  const start=h.port.startBroker;h.port.startBroker=async runId=>{expect(failed).toBe(true);expect(paused).toBe(true);expect(proved).toBe(true);return start(runId);};
  const result=await new DesktopSupervisor(new SupervisorJournal(h.path),h.port,bindings).run(async()=>h.inventory.listener.length>0,async()=>{expect(h.events).toEqual([]);paused=true;h.inventory.desktop=[];},{startMode:'cold',channelMode:'new-only'});
  expect(result.phase).toBe('restored');expect(result.errorCode).toBeUndefined();expect(h.forbidden).not.toHaveBeenCalled();expect(h.events.filter(e=>e==='start:broker')).toHaveLength(1);
});
it('keeps permanent unreadable exit observations bounded and never launches or treats them as an exit',async()=>{
  const h=fixture();let now=Date.now();h.port.coldExit=async()=>{throw new ColdExitObservationUnavailable('ColdSnapshot');};
  const s=await new DesktopSupervisor(new SupervisorJournal(h.path),h.port,bindings,()=>now).run(async()=>false,async()=>{now+=600001;},{startMode:'cold',channelMode:'new-only'});
  expect(s).toMatchObject({phase:'blocked',errorCode:'cold_exit_timeout'});expect(s.lastColdExitProof).toBeUndefined();expect(h.events).toEqual([]);expect(h.forbidden).not.toHaveBeenCalled();
});
it('does not retry an arbitrary cold read failure',async()=>{
  const h=fixture();h.port.coldExit=async()=>{throw Error('TEST_PRIVATE_NATIVE_FAILURE');};
  expect(await h.run()).toMatchObject({phase:'blocked',errorCode:'supervisor_operation_failed'});expect(h.events).toEqual([]);expect(h.forbidden).not.toHaveBeenCalled();
});
it('does not treat an unavailable SharedSnapshot as a retryable cold exit read',async()=>{
  const h=fixture();h.port.coldExit=async()=>{throw new ColdExitObservationUnavailable('SharedSnapshot');};
  expect(await h.run()).toMatchObject({phase:'blocked',errorCode:'supervisor_operation_failed'});
  expect(h.events).toEqual([]);expect(h.forbidden).not.toHaveBeenCalled();
});
it('does not advance from an unavailable exit recheck after launching the broker',async()=>{
  const h=fixture(),read=h.port.coldExit!;h.port.coldExit=async()=>{if(h.inventory.broker.length)throw new ColdExitObservationUnavailable('ColdSnapshot');return read();};
  expect(await h.run()).toMatchObject({phase:'restored',errorCode:'cold_desktop_reappeared'});expect(h.events).not.toContain('start:host');expect(h.events).not.toContain('start:listener');expect(h.events).toContain('ordinary');expect(h.forbidden).not.toHaveBeenCalled();
});
it.each(['enabled','old-process','stale'])('blocks %s retirement before requesting desktop exit',async condition=>{
  const h=fixture();if(condition==='enabled')h.setRetired(false);if(condition==='old-process')h.inventory.legacy=[id(90)];
  if(condition==='stale'){const read=h.port.legacyRetirement!;h.port.legacyRetirement=async()=>({...await read(),observedAt:Date.now()-61000});}
  const s=await h.run();expect(s.phase).toBe('blocked');expect(s.lastColdExitProof).toBeUndefined();expect(h.events).toEqual([]);expect(h.inventory.desktop).toEqual([id(1)]);expect(h.forbidden).not.toHaveBeenCalled();
});
it.each(['broker','host','listener'])('cleans a known %s failure without ever reactivating legacy',async role=>{
  const h=fixture();h.fail(role);const s=await h.run();expect(s).toMatchObject({phase:'restored',errorCode:'supervisor_operation_failed'});expect(h.forbidden).not.toHaveBeenCalled();expect(h.inventory.legacy).toEqual([]);expect(h.inventory.desktop).toEqual([id(6)]);expect(await readFile(h.path,'utf8')).not.toContain('TEST_PRIVATE');
});
it.each(['broker','host','listener'])('preserves an ambiguous %s identity without a relaunch or foreign stop',async role=>{
  const h=fixture();h.fail(role,true);expect(await h.run()).toMatchObject({phase:'blocked',rollbackErrorCode:'owned_process_unconfirmed'});expect(h.events.filter(e=>e===`start:${role}`)).toHaveLength(1);expect(h.forbidden).not.toHaveBeenCalled();
});
it('halts service on failed health and keeps legacy disabled',async()=>{
  const h=fixture();h.badHealth();expect(await h.run()).toMatchObject({phase:'restored',errorCode:'runtime_health_failed'});expect(h.forbidden).not.toHaveBeenCalled();expect(h.inventory.legacy).toEqual([]);
});
it('cleans the new service when an administrator reenables the old task, retaining blocked state',async()=>{
  const h=fixture();h.port.health=async()=>{h.setRetired(false);return false;};expect(await h.run()).toMatchObject({phase:'blocked',rollbackErrorCode:'legacy_retirement_unverified'});expect(h.inventory.host).toEqual([]);expect(h.inventory.listener).toEqual([]);expect(h.forbidden).not.toHaveBeenCalled();
});
it('restores the desktop after cancellation following proven human exit',async()=>{
  const h=fixture(),read=h.port.coldExit!;h.port.coldExit=async()=>{const p=await read();if(!p.desktopRelated.length)h.stop();return p;};
  expect(await h.run()).toMatchObject({phase:'restored',errorCode:'stop_requested'});expect(h.events).toEqual(['ordinary']);expect(h.forbidden).not.toHaveBeenCalled();
});
it('resumes only cleanup for a known new-only run, with no forward or legacy calls',async()=>{
  const h=fixture(),j=new SupervisorJournal(h.path);await j.open();
  const s:SupervisorState={version:1,runId:'12345678-1234-1234-1234-123456789abc',startMode:'cold',channelMode:'new-only',phase:'running',revision:0,updatedAt:'',owned:{broker:id(2),host:id(3),listener:id(4)},legacyPauseAttempted:false,desktopCloseAttempted:false,desktopRestoreRequired:true,newBaseline:{desktop:id(1),retirement:await h.port.legacyRetirement!()}};
  await j.save(s);await j.close();Object.assign(h.inventory,{desktop:[id(5)],broker:[id(2)],host:[id(3)],listener:[id(4)]});expect((await h.run()).phase).toBe('restored');expect(h.events.some(e=>e.startsWith('start:'))).toBe(false);expect(h.forbidden).not.toHaveBeenCalled();
});
it('refuses interpreting a historical legacy journal as a new-only recovery',async()=>{
  const h=fixture(),j=new SupervisorJournal(h.path);await j.open();const s:SupervisorState={version:1,runId:'12345678-1234-1234-1234-123456789abc',phase:'preflight',revision:0,updatedAt:'',owned:{},legacyPauseAttempted:false,desktopCloseAttempted:false};await j.save(s);await j.close();const bytes=await readFile(h.path,'utf8');
  await expect(h.run()).rejects.toThrow('policy_mismatch');expect(await readFile(h.path,'utf8')).toBe(bytes);expect(h.forbidden).not.toHaveBeenCalled();
});
it('rejects a tampered new-only journal containing legacy pause intent',async()=>{
  const h=fixture();await writeFile(h.path,JSON.stringify({version:1,runId:'12345678-1234-1234-1234-123456789abc',channelMode:'new-only',startMode:'cold',phase:'blocked',revision:0,owned:{},legacyPauseAttempted:true,desktopCloseAttempted:false}),'utf8');await expect(h.run()).rejects.toThrow('journal_new_only_invalid');expect(h.forbidden).not.toHaveBeenCalled();
});
it.each([0,1])('starts managed service with %s ordinary desktops and preserves all native admission gates',async count=>{
  const h=fixture();if(!count)h.inventory.desktop=[];h.port.desktopQuit=async()=>undefined;
  const s=await new DesktopSupervisor(new SupervisorJournal(h.path),h.port,bindings).run(async()=>!!h.inventory.listener.length,async()=>{h.inventory.desktop=[];},{startMode:'cold',channelMode:'new-only',serviceMode:'stop-with-desktop'});
  expect(s.phase).toBe('restored');expect(s.lastColdExitProof).toMatchObject({complete:true,desktopRelated:[]});expect(s.lastIdleProof?.allDesktopTasksIdle).toBe(true);expect(h.events.filter(e=>e.startsWith('start:'))).toEqual(['start:broker','start:host','start:listener']);expect(h.forbidden).not.toHaveBeenCalled();
});
it('stops all new roles after a verified clean exit without reopening ordinary Codex or restarting on journal resume',async()=>{
  const h=fixture();h.inventory.desktop=[];
  h.port.desktopQuit=async()=>{h.inventory.desktop=[];return id(5);};
  const run=()=>new DesktopSupervisor(new SupervisorJournal(h.path),h.port,bindings).run(async()=>false,async()=>{}, {startMode:'cold',channelMode:'new-only',serviceMode:'stop-with-desktop'});
  const s=await run();expect(s).toMatchObject({phase:'closed',desktopQuitVerified:true});expect(s.errorCode).toBeUndefined();expect(s.ordinaryProof).toBeUndefined();expect(h.events).not.toContain('ordinary');expect(h.inventory.desktop).toEqual([]);
  const events=[...h.events];expect((await run()).phase).toBe('closed');expect(h.events).toEqual(events);
});
it('keeps abnormal managed health failure on the proven ordinary restoration path',async()=>{
  const h=fixture();h.inventory.desktop=[];h.badHealth();h.port.desktopQuit=async()=>undefined;
  const s=await new DesktopSupervisor(new SupervisorJournal(h.path),h.port,bindings).run(async()=>false,async()=>{}, {startMode:'cold',channelMode:'new-only',serviceMode:'stop-with-desktop'});
  expect(s).toMatchObject({phase:'restored',errorCode:'runtime_health_failed'});expect(s.desktopQuitVerified).toBeUndefined();expect(h.events).toContain('ordinary');
});
it('recognizes the original clean GUI receipt when exit begins between the quit precheck and health read, without restarting or retrying health',async()=>{
  const h=fixture();h.inventory.desktop=[];let exited=false,healthReads=0,quitReads=0;
  h.port.desktopQuit=async()=>{quitReads++;return exited?id(5):undefined;};
  h.port.health=async()=>{healthReads++;h.inventory.desktop=[];h.inventory.host=[];exited=true;return false;};
  const s=await new DesktopSupervisor(new SupervisorJournal(h.path),h.port,bindings).run(async()=>false,async()=>{}, {startMode:'cold',channelMode:'new-only',serviceMode:'stop-with-desktop'});
  expect(s).toMatchObject({phase:'closed',desktopQuitVerified:true});expect(s.errorCode).toBeUndefined();expect(healthReads).toBe(1);expect(quitReads).toBe(2);expect(h.events).not.toContain('ordinary');expect(h.events.filter(e=>e.startsWith('start:'))).toEqual(['start:broker','start:host','start:listener']);
});
it.each(['missing-receipt','foreign-desktop','listener-lost','broker-lost','retirement-changed','stop-requested'])('does not mask %s behind a concurrent managed GUI exit',async condition=>{
  const h=fixture();h.inventory.desktop=[];let exited=false,stop=false;
  h.port.desktopQuit=async()=>exited&&condition!=='missing-receipt'?id(5):undefined;
  h.port.health=async()=>{exited=true;h.inventory.desktop=condition==='foreign-desktop'?[id(80)]:[];
    if(condition==='listener-lost')h.inventory.listener=[];if(condition==='broker-lost')h.inventory.broker=[];
    if(condition==='retirement-changed')h.setRetired(false);if(condition==='stop-requested')stop=true;return false;};
  const s=await new DesktopSupervisor(new SupervisorJournal(h.path),h.port,bindings).run(async()=>stop,async()=>{}, {startMode:'cold',channelMode:'new-only',serviceMode:'stop-with-desktop'});
  expect(s.phase).not.toBe('closed');expect(s.desktopQuitVerified).toBeUndefined();expect(s.errorCode).toBeDefined();expect(h.events).toContain('ordinary');expect(h.events.filter(e=>e==='start:listener')).toHaveLength(1);
});
it('keeps an explicit stop received during the bounded quit observation on the ordinary recovery path',async()=>{
  const h=fixture();h.inventory.desktop=[];let exited=false,stop=false;
  h.port.desktopQuit=async()=>{if(!exited)return;stop=true;return id(5);};
  h.port.health=async()=>{exited=true;h.inventory.desktop=[];return false;};
  const s=await new DesktopSupervisor(new SupervisorJournal(h.path),h.port,bindings).run(async()=>stop,async()=>{}, {startMode:'cold',channelMode:'new-only',serviceMode:'stop-with-desktop'});
  expect(s).toMatchObject({phase:'restored',errorCode:'runtime_health_failed'});expect(s.desktopQuitVerified).toBeUndefined();expect(h.events).toContain('ordinary');
});
it.each(['wrong-desktop','foreign-desktop','appserver-remains'])('refuses managed closed proof for %s',async condition=>{
  const h=fixture();h.inventory.desktop=[];
  h.port.desktopQuit=async()=>{h.inventory.desktop=condition==='foreign-desktop'?[id(80)]:[];return id(condition==='wrong-desktop'?80:5);};
  if(condition==='appserver-remains'){const cold=h.port.coldExit!;h.port.coldExit=async()=>({...await cold(),desktopRelated:h.events.includes('stop:broker')?[id(88)]:[]});}
  const s=await new DesktopSupervisor(new SupervisorJournal(h.path),h.port,bindings).run(async()=>false,async()=>{}, {startMode:'cold',channelMode:'new-only',serviceMode:'stop-with-desktop'});
  expect(s.phase).not.toBe('closed');if(condition==='appserver-remains')expect(s.rollbackErrorCode).toBe('closed_desktop_unverified');else expect(s.errorCode).toBe('desktop_quit_inventory_changed');
});
it('does not allow a zero-desktop baseline in historical finite acceptance mode',async()=>{
  const h=fixture();h.inventory.desktop=[];expect(await h.run()).toMatchObject({phase:'blocked',errorCode:'baseline_not_unique'});expect(h.events).toEqual([]);
});
it.each(['not-ready','signal-stop','desktop-crash','backend-crash','backend-error','no-policy'])('does not classify %s as a clean managed GUI exit',condition=>{
  expect(isCleanManagedDesktopExit(condition==='no-policy'?undefined:'stop-with-desktop',condition!=='not-ready',condition==='signal-stop',
    {exitCode:condition==='desktop-crash'?1:0,signalCode:null},{exitCode:condition==='backend-crash'?1:null,signalCode:null},condition==='backend-error'?Error('fault'):undefined)).toBe(false);
});
it('distinguishes a ready clean GUI exit from faults and supervisor stop requests',()=>{
  expect(isCleanManagedDesktopExit('stop-with-desktop',true,false,{exitCode:0,signalCode:null},{exitCode:null,signalCode:null})).toBe(true);
});
