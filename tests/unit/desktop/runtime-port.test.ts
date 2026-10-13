import { beforeEach,afterEach,expect,it } from 'vitest';
import { mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopRuntimePort,type RuntimeEffects } from '../../../src/desktop/runtime-port';
import { DesktopSupervisor,SupervisorJournal,type ProcessIdentity,type SupervisorState } from '../../../src/desktop/supervisor';
let dir:string;const ports:DesktopRuntimePort[]=[];
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'runtime-port-'));});
afterEach(async()=>{for(const p of ports.splice(0))await p.close();await rm(dir,{recursive:true,force:true});});
const identity=(pid:number):ProcessIdentity=>({pid,parentPid:1,createdAt:new Date().toISOString(),executable:process.execPath,commandLineSha256:'a'.repeat(64)});
const runId='12345678-1234-1234-1234-123456789abc';
function harness(recovery=false,channelMode?:'new-only'){
  const events:string[]=[],ids={legacy:identity(1),desktop:identity(2),broker:identity(3),host:identity(4),shared:identity(5),listener:identity(6),ordinary:identity(7)};
  const inventory={legacy:[ids.legacy],desktop:[ids.desktop],host:[] as ProcessIdentity[],listener:[] as ProcessIdentity[],broker:[] as ProcessIdentity[]};
  const registry=join(dir,'registry.json'),bindings=[{threadId:'original',projectId:'project',projectRoot:dir}];
  const input:any={host:{connectionFile:join(dir,'connection.json'),desktopVersion:'26.1007.2314.0'},topics:{registryFile:registry,enabledChatIds:['oc_c'],appSecretEnv:'LARK_APP_SECRET',appId:'cli_test',ownerOpenId:'ou_owner',entryChatId:'oc_entry'},
    snapshot:{bindings,spec:{expectedToolNames:['list_projects']}},ledgers:[{binding:{chatId:'oc_c'},counts:{completed:1}},{binding:{chatId:'oc_a'},counts:{uncertain:1}}]};
  let clock=Date.now(),packageFails=false,tools=true,context=true,locks=true,secret=true,runtimeRun=runId;
  const checkStop=async()=>{
    for(const role of ['listener','host'] as const){const path=role==='host'?`${input.host.connectionFile}.stop`:`${registry}.stop`;
      try{await readFile(path);if(inventory[role].length){inventory[role]=[];if(role==='host')inventory.desktop=[ids.ordinary];}}catch{}
    }
    try{await readFile(join(dir,'package-broker.stop'));inventory.broker=[];await writeFile(join(dir,'package-broker.status.json'),JSON.stringify({phase:'stopped',pid:3,runId:runtimeRun}),'utf8');}catch{}
  };
  const effects:RuntimeEffects={
    control:{async canStopLegacy(){return true;},async taskPermissions(){return {version:1,writeAllowed:true,executeAllowed:true,descriptorSha256:'e'.repeat(64)};},async inventory(){await checkStop();return structuredClone(inventory);},async coldSnapshot(){return {verifiedAt:clock,complete:true,desktopRelated:[...inventory.desktop],inventory:structuredClone(inventory)};},
      async testIdentity(role,p){events.push(`identity:${role}`);expect(p.pid).toBe(inventory[role as 'legacy'|'desktop'|'host'|'listener'][0]!.pid);},
      async backupTask(){events.push('backup');return {enabled:true,definitionSha256:'b'.repeat(64)};},async pauseTask(){events.push('pauseTask');},async restoreTaskSetting(){events.push('restoreTask');},
      async startLegacy(){events.push('startLegacy');inventory.legacy=[ids.legacy];},async stopOwned(role){events.push(`stop:${role}`);inventory[role]=[];},
      async protectCapability(path,token){expect(token).toMatch(/^[a-f0-9]{64}$/);await writeFile(path,'ENCRYPTED_TEST_CAPABILITY',{encoding:'utf8',flag:'wx'});events.push('protect');},async unprotectCapability(){events.push('unprotect');return 'a'.repeat(64);},
      async startOrdinary(){events.push('shell');inventory.desktop=[ids.ordinary];}},
    async verify(){return input;},async launch(role,_run,env){runtimeRun=_run;events.push(`launch:${role}`);inventory[role]=[ids[role]];if(role==='host')inventory.desktop=[ids.shared];
      if(role==='listener'){expect(env.LARK_APP_SECRET).toBe('TEST_MEMORY_SECRET');expect(env.BRIDGE_SUPERVISOR_OWNER_LEASE_FILE).toBe(join(dir,'broker-owner.json'));await writeFile(join(dir,'listener.ready.json'),JSON.stringify({version:1,runId:_run,pid:ids.listener.pid,readyAt:clock,updatedAt:clock,connectionState:'connected',phase:'ready',enabledChatIds:['oc_c']}),'utf8');}
      return ids[role];},
    async command(){events.push('packageRestore');if(packageFails)throw new Error('TEST_PRIVATE_ERROR');inventory.desktop=[ids.ordinary];},
    async secret(){events.push('secret');if(!secret)throw new Error('TEST_PRIVATE_SECRET_ERROR');return 'TEST_MEMORY_SECRET';},
    async shared(){events.push('shared');return {verified:true,source:'owned_shared_native',findings:[],proof:{verifiedAt:clock,desktop:inventory.desktop[0]!,allDesktopTasksIdle:true,toolsExact:true,tasks:bindings.map(b=>({...b,status:'idle',queueCount:0,waitingApproval:false}))}};},
    async context(){events.push('context');if(!context)throw new Error('Not ready');return {} as any;},async ordinaryTools(){events.push('tools');return tools;},locksHeld:async()=>locks,
    now:()=>clock,async pause(){clock+=1000;await checkStop();},
  };
  const saved:SupervisorState={version:1,startMode:'cold',runId,phase:'running',revision:1,updatedAt:'',owned:{broker:ids.broker,host:ids.host,listener:ids.listener},legacyPauseAttempted:true,desktopCloseAttempted:false,desktopRestoreRequired:true,
    baseline:{legacy:ids.legacy,desktop:ids.desktop,legacyTaskEnabled:true,launchDefinitionSha256:'b'.repeat(64)}};
  if(recovery)Object.assign(inventory,{legacy:[],desktop:[],host:[],listener:[],broker:[ids.broker]});
  const port=new DesktopRuntimePort(input,dir,identity(process.pid),effects,recovery?saved:undefined,channelMode);ports.push(port);
  return {port,effects,input,events,inventory,ids,saved,bindings,clock:()=>clock,advance:(ms:number)=>{clock+=ms;},packageFails:()=>{packageFails=true;},badTools:()=>{tools=false;},badContext:()=>{context=false;},badLocks:()=>{locks=false;},badSecret:()=>{secret=false;}};
}
it('runs the concrete new-only port without old task permissions, backup, pause or restore',async()=>{
  const h=harness(false,'new-only');h.inventory.legacy=[];
  h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)});
  h.effects.control.taskPermissions=async()=>{throw Error('Legacy permission operation forbidden');};
  let stop=false;const s=await new DesktopSupervisor(new SupervisorJournal(join(dir,'journal.json')),h.port,h.bindings,h.clock).run(async()=>stop,async()=>{if(h.inventory.desktop[0]?.pid===2&&!h.inventory.host.length)h.inventory.desktop=[];else stop=true;},{startMode:'cold',channelMode:'new-only'});
  expect(s.phase).toBe('restored');expect(s.errorCode).toBeUndefined();expect(h.inventory.legacy).toHaveLength(0);expect(h.events).not.toContain('backup');expect(h.events).not.toContain('pauseTask');expect(h.events).not.toContain('restoreTask');expect(h.events).not.toContain('startLegacy');
});
it('rejects explicit legacy mutations through a new-only port',async()=>{
  const h=harness(false,'new-only');await expect(h.port.backup()).rejects.toThrow('does not back up');await expect(h.port.pauseLegacy(h.ids.legacy)).rejects.toThrow('never pauses');await expect(h.port.restoreLegacy(h.saved.baseline!)).rejects.toThrow('never reactivates');expect(h.events).toEqual([]);
});
it.each(['run','host','desktop','old','future','abnormal','unready','backend'])('rejects a %s managed quit receipt without granting permission to suppress restoration',async condition=>{
  const h=harness(false,'new-only');h.inventory.legacy=[];h.input.host.desktopQuitPolicy='stop-with-desktop';
  h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)});
  await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.sharedIdle();
  const p:any={version:1,runId,hostPid:4,desktopPid:5,backendPid:88,observedAt:h.clock(),exitCode:0,verifiedOnce:true,backendWasRunning:true};
  if(condition==='run')p.runId='foreign';if(condition==='host')p.hostPid=99;if(condition==='desktop')p.desktopPid=99;if(condition==='old')p.observedAt-=31000;if(condition==='future')p.observedAt+=2000;if(condition==='abnormal')p.exitCode=1;if(condition==='unready')p.verifiedOnce=false;if(condition==='backend')p.backendWasRunning=false;
  await writeFile(`${h.input.host.connectionFile}.desktop-exit.json`,JSON.stringify(p),'utf8');await expect(h.port.desktopQuit()).rejects.toThrow('receipt invalid');
});
it('retains uncertain results on clean close, while refusing to use them for the next forward startup',async()=>{
  const h=harness(false,'new-only');h.input.ledgers[0].counts.uncertain=1;await h.port.verifyClosedBindings();await expect(h.port.verifyBindings()).rejects.toThrow('reconciliation');expect(h.input.ledgers[0].counts.uncertain).toBe(1);
});
it('waits for the original host refresh after the GUI disappears instead of classifying PID absence as a fault or clean exit',async()=>{
  const h=harness(false,'new-only');h.inventory.legacy=[];h.input.host.desktopQuitPolicy='stop-with-desktop';
  h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)});
  await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.sharedIdle();await h.port.startListener(runId);h.inventory.desktop=[];
  const original=h.effects.pause;let waits=0;h.effects.pause=async()=>{await original();if(++waits===10)await writeFile(`${h.input.host.connectionFile}.desktop-exit.json`,JSON.stringify({version:1,runId,hostPid:4,desktopPid:5,backendPid:88,observedAt:h.clock(),exitCode:0,verifiedOnce:true,backendWasRunning:true}),'utf8');};
  expect(await h.port.desktopQuit()).toEqual(h.ids.shared);expect(waits).toBe(10);expect(h.events.filter(e=>e==='launch:listener')).toHaveLength(1);
});
it('bounds missing clean-exit evidence and grants no permission to skip ordinary restoration',async()=>{
  const h=harness(false,'new-only');h.inventory.legacy=[];h.input.host.desktopQuitPolicy='stop-with-desktop';
  h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)});
  await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.sharedIdle();await h.port.startListener(runId);h.inventory.desktop=[];
  const started=h.clock();expect(await h.port.desktopQuit()).toBeUndefined();expect(h.clock()-started).toBe(20_000);
});
it('runs the concrete cold lifecycle with fresh lease, memory-only auth, handshake and ordered restoration',async()=>{
  const h=harness();let stop=false;
  const state=await new DesktopSupervisor(new SupervisorJournal(join(dir,'journal.json')),h.port,h.bindings,h.clock).run(async()=>stop,async()=>{if(h.inventory.desktop[0]?.pid===2&&!h.inventory.host.length)h.inventory.desktop=[];else stop=true;},{startMode:'cold'});
  expect(state.phase).toBe('restored');expect(state.errorCode).toBeUndefined();expect(h.events.indexOf('secret')).toBeLessThan(h.events.indexOf('pauseTask'));
  expect(h.events.filter(e=>e.startsWith('launch:'))).toEqual(['launch:broker','launch:host','launch:listener']);
  expect(h.events.indexOf('tools')).toBeLessThan(h.events.indexOf('startLegacy'));
  expect(await readFile(join(dir,'broker-capability.dpapi'),'utf8')).toBe('ENCRYPTED_TEST_CAPABILITY');
  const lease=JSON.parse(await readFile(join(dir,'broker-owner.json'),'utf8'));expect(lease).toHaveProperty('tokenSha256');expect(JSON.stringify(lease)).not.toContain('TEST_MEMORY_SECRET');
});
it.each(['selectedUncertain','outsideActive','approval'])('retains %s and refuses service mutation',async condition=>{
  const h=harness();if(condition==='selectedUncertain')h.input.ledgers[0].counts.uncertain=1;
  if(condition==='outsideActive')h.input.ledgers[1].counts.running=1;
  if(condition==='approval')await writeFile(`${h.input.topics.registryFile}.approvals.json`,JSON.stringify({version:1,binding:{},cards:[{state:'open'}]}),'utf8');
  await expect(h.port.verifyBindings()).rejects.toThrow();expect(h.events).toEqual([]);
});
it('does not pause the old consumer when the credential provider fails',async()=>{
  const h=harness();h.badSecret();await expect(h.port.pauseLegacy(h.ids.legacy)).rejects.toThrow();expect(h.events).not.toContain('pauseTask');expect(h.inventory.legacy).toHaveLength(1);
});
it('refuses cold admission before requesting desktop exit when legacy task permissions are insufficient',async()=>{
  const h=harness();h.effects.control.taskPermissions=async()=>({version:1,writeAllowed:false,executeAllowed:false,descriptorSha256:'e'.repeat(64)});
  const state=await new DesktopSupervisor(new SupervisorJournal(join(dir,'journal.json')),h.port,h.bindings,h.clock).run(async()=>false,async()=>{throw Error('Must not wait for desktop exit');},{startMode:'cold'});
  expect(state.errorCode).toBeDefined();expect(h.events).not.toContain('pauseTask');expect(h.events).not.toContain('secret');expect(state.lastColdExitProof).toBeUndefined();expect(h.inventory.desktop).toHaveLength(1);
  expect(JSON.parse(await readFile(join(dir,'legacy-permissions.json'),'utf8'))).toMatchObject({writeAllowed:false,executeAllowed:false});
});
it('keeps the desktop open when the ordinary worker cannot stop the verified old consumer',async()=>{
  const h=harness();h.effects.control.canStopLegacy=async()=>false;
  await expect(h.port.backup()).rejects.toThrow('stop permission');expect(h.events).not.toContain('backup');expect(h.inventory.desktop).toHaveLength(1);
});
it('does not repeat an ambiguous host launch',async()=>{
  const h=harness();await h.port.startBroker(runId);h.effects.launch=async()=>{h.events.push('AMBIGUOUS');throw new Error('PRIVATE_FAILURE');};
  await expect(h.port.startHost(runId)).rejects.toThrow();await expect(h.port.startHost(runId)).rejects.toThrow();expect(h.events.filter(e=>e==='AMBIGUOUS')).toHaveLength(1);
});
it.each(['stale','disconnected','locks'])('fails health on %s even when the listener PID still exists',async condition=>{
  const h=harness();await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.startListener(runId);expect(await h.port.health()).toBe(true);
  if(condition==='stale')h.advance(11_000);
  if(condition==='locks')h.badLocks();
  if(condition==='disconnected'){const path=join(dir,'listener.ready.json'),r=JSON.parse(await readFile(path,'utf8'));r.connectionState='reconnecting';r.phase='disconnected';await writeFile(path,JSON.stringify(r),'utf8');}
  expect(await h.port.health()).toBe(false);
});
it('keeps healthy checks read-only without creating a failure diagnostic',async()=>{
  const h=harness();await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.startListener(runId);
  const before=h.events.filter(e=>e.startsWith('launch:'));expect(await h.port.health()).toBe(true);
  await expect(readFile(join(dir,'runtime-health.failure.json'),'utf8')).rejects.toMatchObject({code:'ENOENT'});
  expect(h.events.filter(e=>e.startsWith('launch:'))).toEqual(before);
});
it('preserves the first failing read stage without disclosing private error text or retrying',async()=>{
  const h=harness();await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.startListener(runId);
  let reads=0;h.effects.context=async()=>{reads++;throw Error('TEST_PRIVATE_HEALTH_SECRET');};
  expect(await h.port.health()).toBe(false);expect(reads).toBe(1);
  const path=join(dir,'runtime-health.failure.json'),bytes=await readFile(path,'utf8');
  expect(JSON.parse(bytes)).toEqual({version:1,runId,observedAt:h.clock(),reason:'health_read_failed',stage:'shared_context',errorSha256:createHash('sha256').update('TEST_PRIVATE_HEALTH_SECRET').digest('hex')});
  expect(bytes).not.toContain('TEST_PRIVATE_HEALTH_SECRET');
  h.effects.context=async()=>{throw Error('SECOND_PRIVATE_ERROR');};expect(await h.port.health()).toBe(false);
  expect(await readFile(path,'utf8')).toBe(bytes);expect(h.events).not.toContain('startLegacy');
});
it('records only boolean heartbeat checks for stale listener readiness',async()=>{
  const h=harness();await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.startListener(runId);
  const path=join(dir,'listener.ready.json'),r=JSON.parse(await readFile(path,'utf8'));
  r.privateExtra='TEST_PRIVATE_HEARTBEAT';await writeFile(path,JSON.stringify(r),'utf8');h.advance(11000);
  expect(await h.port.health()).toBe(false);const bytes=await readFile(join(dir,'runtime-health.failure.json'),'utf8'),failure=JSON.parse(bytes);
  expect(failure).toMatchObject({reason:'listener_not_ready',stage:'listener',checks:{heartbeatFresh:false,scopeMatches:true,connected:true}});
  expect(Object.values(failure.checks).every(v=>typeof v==='boolean')).toBe(true);expect(bytes).not.toContain('TEST_PRIVATE_HEARTBEAT');
});
it('records unavailable retirement while retaining new-only legacy protections',async()=>{
  const h=harness(false,'new-only');h.inventory.legacy=[];
  h.effects.control.legacyRetirement=async()=>{throw Error('TEST_PRIVATE_RETIREMENT');};
  expect(await h.port.health()).toBe(false);expect(JSON.parse(await readFile(join(dir,'runtime-health.failure.json'),'utf8'))).toMatchObject({reason:'health_read_failed',stage:'retirement'});
  expect(h.events).not.toContain('startLegacy');expect(h.events.filter(e=>e.startsWith('launch:'))).toEqual([]);
});
it('distinguishes failed lock reads from an observed lost runtime lock',async()=>{
  const h=harness();await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.startListener(runId);
  h.effects.locksHeld=async()=>{throw Error('TEST_PRIVATE_LOCK_ERROR');};expect(await h.port.health()).toBe(false);
  expect(JSON.parse(await readFile(join(dir,'runtime-health.failure.json'),'utf8'))).toMatchObject({reason:'health_read_failed',stage:'locks'});
});
it('fails closed even when the diagnostic destination cannot be written',async()=>{
  const h=harness();await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.startListener(runId);
  await mkdir(join(dir,'runtime-health.failure.json'));h.badContext();expect(await h.port.health()).toBe(false);
  expect(h.events.filter(e=>e.startsWith('launch:'))).toEqual(['launch:broker','launch:host','launch:listener']);
});
it('preserves package failure and verifies a separate shell restore before old consumer restoration',async()=>{
  const h=harness(true);h.packageFails();const proof=await h.port.ordinary();expect(proof.toolsExact).toBe(true);expect(h.events.filter(e=>['packageRestore','shell'].includes(e))).toEqual(['packageRestore','shell']);
  const error=await readFile(join(dir,'ordinary-package.failure.json'),'utf8');expect(error).toContain('package_restore_not_confirmed');expect(error).not.toContain('TEST_PRIVATE_ERROR');
  await h.port.restoreLegacy(h.saved.baseline!);expect(h.events.indexOf('tools')).toBeLessThan(h.events.indexOf('startLegacy'));
});
it('does not retry the first package restoration across recovery',async()=>{
  const h=harness(true);await writeFile(join(dir,'ordinary-package.intent.json'),JSON.stringify({version:1,runId}),'utf8');await h.port.ordinary();expect(h.events).not.toContain('packageRestore');expect(h.events).toContain('shell');
});
it('blocks old consumer restoration without a complete ordinary tool proof',async()=>{
  const h=harness(true);h.inventory.desktop=[h.ids.ordinary];h.badTools();await expect(h.port.restoreLegacy(h.saved.baseline!)).rejects.toThrow('tools');expect(h.events).not.toContain('startLegacy');
});
it('reuses an identical graceful stop intent while forbidding a changed identity',async()=>{
  const h=harness(true);h.inventory.listener=[h.ids.listener];const path=join(dir,'stop-listener.intent.json');await writeFile(path,JSON.stringify({version:1,runId,identity:h.ids.listener}),'utf8');await h.port.stopListener(h.ids.listener);expect(h.inventory.listener).toHaveLength(0);
  h.inventory.listener=[h.ids.listener];await writeFile(path,JSON.stringify({version:1,runId,identity:{...h.ids.listener,createdAt:'2026-10-01T00:00:00.000Z'}}),'utf8');await expect(h.port.stopListener(h.ids.listener)).rejects.toThrow('intent changed');
});
it('does not turn a timed-out broker drain into a successful restored state',async()=>{
  const h=harness(true);h.inventory.broker=[];await writeFile(join(dir,'package-broker.status.json'),JSON.stringify({phase:'stopped',pid:3,runId,drainTimedOut:true}),'utf8');await expect(h.port.verifyBindings()).rejects.toThrow('exit unverified');
});
