import { beforeEach,afterEach,expect,it } from 'vitest';
import { mkdtemp,mkdir,readFile,rm,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopRuntimePort,type RuntimeEffects } from '../../../src/desktop/runtime-port';
import { readDesktopToolConfig } from '../../../src/desktop/backend';
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
  let clock=Date.now(),packageFails=false,tools=true,context=true,locks=true,foreignRegistryLock=false,secret=true,runtimeRun=runId;
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
    async context(){events.push('context');if(!context)throw new Error('Not ready');return {} as any;},async ordinaryTools(){events.push('tools');return tools;},
    locksHeld:async(listenerExpected=true)=>{events.push(`locks:${listenerExpected?'listener':'before-listener'}`);return locks&&(inventory.listener.length>0||foreignRegistryLock)===listenerExpected;},
    now:()=>clock,async pause(){clock+=1000;await checkStop();},
  };
  const saved:SupervisorState={version:1,startMode:'cold',runId,phase:'running',revision:1,updatedAt:'',owned:{broker:ids.broker,host:ids.host,listener:ids.listener},legacyPauseAttempted:true,desktopCloseAttempted:false,desktopRestoreRequired:true,
    baseline:{legacy:ids.legacy,desktop:ids.desktop,legacyTaskEnabled:true,launchDefinitionSha256:'b'.repeat(64)}};
  if(recovery)Object.assign(inventory,{legacy:[],desktop:[],host:[],listener:[],broker:[ids.broker]});
  const port=new DesktopRuntimePort(input,dir,identity(process.pid),effects,recovery?saved:undefined,channelMode);ports.push(port);
  return {port,effects,input,events,inventory,ids,saved,bindings,clock:()=>clock,advance:(ms:number)=>{clock+=ms;},packageFails:()=>{packageFails=true;},badTools:()=>{tools=false;},badContext:()=>{context=false;},badLocks:()=>{locks=false;},foreignRegistryLock:()=>{foreignRegistryLock=true;},badSecret:()=>{secret=false;}};
}
async function configurationHarness(){
  const h=harness(false,'new-only');h.inventory.legacy=[];
  h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)});
  const original={host:h.ids.host,desktop:h.ids.shared,backend:{...identity(8),parentPid:4},endpoint:'ws://127.0.0.1:9998/',backendEndpoint:'ws://127.0.0.1:9999/',
    leaseVerifiedAt:h.clock(),desktopVersion:h.input.host.desktopVersion,codexSha256:'c'.repeat(64),toolNames:['list_projects'],packageIdentityVerified:true,endpointOwnershipVerified:true};
  Object.assign(h.input.host,{endpoint:original.endpoint,backendEndpoint:original.backendEndpoint,codexSha256:original.codexSha256});
  let pending=false;const missing=()=>Object.assign(Error('Connection withdrawn'),{code:'ENOENT',path:h.input.host.connectionFile});
  h.effects.context=async(_owned,refreshCatalog)=>{h.events.push(refreshCatalog?'refreshedCatalog':'context');if(pending)throw missing();return {...original,leaseVerifiedAt:h.clock()};};
  h.effects.configurationIdentity=async()=>{h.events.push('liveOriginalIdentity');};
  await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.sharedIdle();await h.port.startListener(runId);await h.port.ready();
  h.advance(1);pending=true;
  const withdrawal:any={version:1,runId,hostPid:4,observedAt:h.clock(),reason:'desktop_readiness_changed',readiness:{desktopConnected:true,initialized:true,projectsRead:true,configurationFailures:0,revision:2,lastChange:'request config/batchWrite',pendingConfiguration:['config/batchWrite']}};
  const publish=()=>writeFile(`${h.input.host.connectionFile}.invalidation.json`,JSON.stringify(withdrawal),'utf8');await publish();
  const pause=h.effects.pause;h.effects.pause=async()=>{await pause();await writeFile(join(dir,'listener.ready.json'),JSON.stringify({version:1,runId,pid:6,readyAt:original.leaseVerifiedAt,updatedAt:h.clock(),phase:'ready',connectionState:'connected',enabledChatIds:['oc_c']}),'utf8');};
  return {...h,original,withdrawal,publish,missing,refresh:()=>{pending=false;}};
}
async function transportHarness(){
  const h=await configurationHarness();h.refresh();
  const marker:any={version:1,runId,pid:6,readyAt:h.original.leaseVerifiedAt,updatedAt:h.clock(),phase:'reconnecting',connectionState:'reconnecting',enabledChatIds:['oc_c'],
    transport:{version:1,disconnectedSince:h.clock()}};
  const publish=async()=>{marker.updatedAt=h.clock();await writeFile(join(dir,'listener.ready.json'),JSON.stringify(marker),'utf8');};await publish();
  h.effects.pause=async()=>{h.advance(1000);await publish();};
  return {...h,marker,publishMarker:publish};
}

async function startupBusyHarness(initialIdle=true){
  const h=harness(false,'new-only');h.inventory.legacy=[];h.input.host.desktopQuitPolicy='stop-with-desktop';
  h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)});
  const context={host:h.ids.host,desktop:h.ids.shared,backend:{...identity(8),parentPid:4},endpoint:'ws://127.0.0.1:9998/',backendEndpoint:'ws://127.0.0.1:9999/',
    leaseVerifiedAt:h.clock(),desktopVersion:h.input.host.desktopVersion,codexSha256:'c'.repeat(64),toolNames:['list_projects'],packageIdentityVerified:true,endpointOwnershipVerified:true};
  h.effects.context=async()=>({...context,leaseVerifiedAt:h.clock()});
  await h.port.legacyRetirement();await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.ready();if(initialIdle)await h.port.sharedIdle();
  const successful=h.effects.shared;
  const busy=()=>({verified:false,source:'owned_shared_native' as const,findings:['shared_task_active'],blocker:{threadId:'desktop-task',status:'active' as const,pass:1,observedAt:h.clock(),waitingApproval:false,activeFlagCount:0}});
  return {...h,context,successful,busy};
}
it('waits for desktop activity at the final listener gate, preserves rejected reads, then uses a fresh complete proof once',async()=>{
  const h=await startupBusyHarness();let reads=0;
  h.effects.shared=async owned=>++reads<3?h.busy():h.successful(owned);
  h.effects.pause=async()=>{expect(h.events).not.toContain('launch:listener');await expect(readFile(join(dir,'launch-listener.intent.json'))).rejects.toThrow();h.advance(1000);};
  await h.port.startListener(runId,async()=>{await h.port.sharedIdle();});
  expect(reads).toBe(3);expect(h.events.filter(event=>event==='launch:listener')).toHaveLength(1);
  expect(JSON.parse(await readFile(join(dir,'shared-idle-2.json'),'utf8'))).toMatchObject({verified:true});
  expect(JSON.parse(await readFile(join(dir,'shared-idle-2.busy-1.json'),'utf8'))).toMatchObject({verified:false,findings:['shared_task_active']});
  expect(JSON.parse(await readFile(join(dir,'shared-admission-wait.json'),'utf8'))).toMatchObject({phase:'idle-verified',attempts:3});
});
it('waits on the first native activity observation before any listener or topic lock exists, then verifies both locks after launch',async()=>{
  const h=await startupBusyHarness(false);let reads=0;
  h.effects.shared=async owned=>++reads<3?h.busy():h.successful(owned);
  await h.port.sharedIdle();
  expect(h.inventory.listener).toHaveLength(0);expect(h.events).toContain('locks:before-listener');
  expect(JSON.parse(await readFile(join(dir,'shared-admission-wait.json'),'utf8'))).toMatchObject({phase:'idle-verified',attempts:3});
  await h.port.startListener(runId);expect(await h.port.health()).toBe(true);expect(h.events).toContain('locks:listener');
});
it('rejects a foreign topic lock before listener creation without publishing a listener intent',async()=>{
  const h=await startupBusyHarness(false);h.foreignRegistryLock();h.effects.shared=async()=>h.busy();
  await expect(h.port.sharedIdle()).rejects.toThrow('locks changed');expect(h.events).toContain('locks:before-listener');
  expect(h.events).not.toContain('launch:listener');await expect(readFile(join(dir,'launch-listener.intent.json'))).rejects.toThrow();
});
it.each(['approval','unknown-finding','stale-blocker','context','listener-present','retirement','locks','stop','timeout'])('does not create a listener while startup activity has %s',async condition=>{
  const h=await startupBusyHarness();h.effects.shared=async()=>{
    const result=h.busy();if(condition==='approval')result.blocker.waitingApproval=true;if(condition==='unknown-finding')result.findings=['shared_history_incompatible'];if(condition==='stale-blocker')result.blocker.observedAt-=6000;return result;
  };
  if(condition==='context')h.effects.context=async()=>({...h.context,backend:{...h.context.backend,pid:99},leaseVerifiedAt:h.clock()});
  if(condition==='listener-present')h.inventory.listener=[h.ids.listener];
  if(condition==='retirement')h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'f'.repeat(64)});
  if(condition==='locks')h.badLocks();
  if(condition==='stop')await writeFile(join(dir,'stop.request'),'stop','utf8');
  if(condition==='timeout')h.effects.pause=async()=>{h.advance(600_000);};
  await expect(h.port.startListener(runId,async()=>{await h.port.sharedIdle();})).rejects.toThrow();
  expect(h.events).not.toContain('launch:listener');await expect(readFile(join(dir,'launch-listener.intent.json'))).rejects.toThrow();
});
it('rejects a complete idle observation received after the startup wait budget',async()=>{
  const h=await startupBusyHarness();let reads=0;h.effects.shared=async owned=>{if(++reads===1)return h.busy();h.advance(600_000);return h.successful(owned);};
  await expect(h.port.sharedIdle()).rejects.toMatchObject({code:'shared_admission_busy_timeout'});expect(h.events).not.toContain('launch:listener');
});
it('does not reset the startup busy budget between idle observations',async()=>{
  const h=await startupBusyHarness();let reads=0;h.effects.shared=async owned=>++reads===1?h.busy():h.successful(owned);
  await h.port.sharedIdle();h.advance(600_000);h.effects.shared=async()=>h.busy();
  await expect(h.port.sharedIdle()).rejects.toMatchObject({code:'shared_admission_busy_timeout'});expect(h.events).not.toContain('launch:listener');
});
  it.each([undefined,'oc_foreign'])('rejects a listener that loses or changes the declared direct control scope: %s',async actual=>{
    const h=await configurationHarness();h.refresh();h.input.snapshot.spec.scope='registered-topics';delete h.input.topics.enabledChatIds;h.input.topics.allowTopicCreation=true;h.input.topics.directControl={chatId:'oc_control'};
    const marker={version:1,runId,pid:6,readyAt:h.clock(),updatedAt:h.clock(),phase:'ready',connectionState:'connected',enabledChatIds:[],scope:'registered-topics',entryChatId:'oc_entry',allowTopicCreation:true,directControlChatId:'oc_control'};
    await writeFile(join(dir,'listener.ready.json'),JSON.stringify(marker),'utf8');expect(await h.port.health()).toBe(true);
    await writeFile(join(dir,'listener.ready.json'),JSON.stringify({...marker,directControlChatId:actual}),'utf8');expect(await h.port.health()).toBe(false);
  });
  it('verifies registered-topic listener policy and includes every binding in reconciliation checks',async()=>{
  const h=await configurationHarness();h.refresh();h.input.snapshot.spec.scope='registered-topics';delete h.input.topics.enabledChatIds;h.input.topics.allowTopicCreation=true;
  await expect(h.port.verifyBindings()).rejects.toThrow('reconciliation');
  h.input.ledgers[1].counts={completed:1};await expect(h.port.verifyBindings()).resolves.toBeUndefined();
  const marker={version:1,runId,pid:6,readyAt:h.clock(),updatedAt:h.clock(),phase:'ready',connectionState:'connected',enabledChatIds:[],scope:'registered-topics',entryChatId:'oc_entry',allowTopicCreation:true};
  await writeFile(join(dir,'listener.ready.json'),JSON.stringify(marker),'utf8');expect(await h.port.health()).toBe(true);
  await writeFile(join(dir,'listener.ready.json'),JSON.stringify({...marker,entryChatId:'oc_foreign'}),'utf8');expect(await h.port.health()).toBe(false);
});
it('lets the original transport reconnect with full fresh admission and no process relaunch',async()=>{
  const h=await transportHarness(),pause=h.effects.pause,started=h.clock();
  h.effects.pause=async()=>{await pause();if(h.clock()-started>=10000){h.marker.phase='ready';h.marker.connectionState='connected';delete h.marker.transport.disconnectedSince;await h.publishMarker();}};
  expect(await h.port.health()).toBe(true);expect(h.events).toContain('refreshedCatalog');
  expect(h.events.filter(e=>e.startsWith('launch:'))).toEqual(['launch:broker','launch:host','launch:listener']);expect(h.events).not.toContain('packageRestore');
  expect(JSON.parse(await readFile(join(dir,'runtime-health.listener-recovery.json'),'utf8'))).toMatchObject({phase:'recovered',elapsedMs:10000});
  await expect(readFile(join(dir,'runtime-health.failure.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it('bounds an uninterrupted outage to the first timestamp',async()=>{
  const h=await transportHarness(),started=h.clock();expect(await h.port.health()).toBe(false);expect(h.clock()-started).toBe(180000);
  expect(JSON.parse(await readFile(join(dir,'runtime-health.listener-recovery.json'),'utf8'))).toMatchObject({phase:'failed',firstDisconnectedAt:started,until:started+180000});
});
it.each(['foreignRun','foreignPid','foreignScope','stale','failed','unknown','noTransport'])('never grants recovery for %s evidence',async kind=>{
  const h=await transportHarness(),started=h.clock();
  if(kind==='foreignRun')h.marker.runId='other';if(kind==='foreignPid')h.marker.pid=99;if(kind==='foreignScope')h.marker.enabledChatIds=['oc_other'];
  if(kind==='stale'){h.advance(11000);}if(kind==='failed')h.marker.phase='failed';if(kind==='unknown')h.marker.connectionState='TEST_PRIVATE';if(kind==='noTransport')delete h.marker.transport;
  await writeFile(join(dir,'listener.ready.json'),JSON.stringify(h.marker),'utf8');
  expect(await h.port.health()).toBe(false);expect(h.clock()-started).toBe(kind==='stale'?11000:0);
  await expect(readFile(join(dir,'runtime-health.listener-recovery.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it.each(['desktop','listener','host','broker','locks','owner','stop','catalog','backend','oldLease','resetBudget','missing','privateState'])('fails recovery on %s without relaxing ownership',async kind=>{
  const h=await transportHarness(),pause=h.effects.pause;let changed=false;
  h.effects.pause=async()=>{await pause();if(changed)return;changed=true;
    if(['desktop','listener','host','broker'].includes(kind))h.inventory[kind as 'desktop'|'listener'|'host'|'broker'][0]!.createdAt='2026-10-12T00:01:00.000Z';
    if(kind==='locks')h.badLocks();if(kind==='owner')(h.port as any).lost=true;if(kind==='stop')await writeFile(join(dir,'stop.request'),'stop','utf8');
    if(['catalog','backend','oldLease'].includes(kind))h.effects.context=async()=>({...h.original,leaseVerifiedAt:kind==='oldLease'?0:h.clock(),
      ...(kind==='catalog'?{toolNames:['wrong']}:{}),...(kind==='backend'?{backend:{...h.original.backend,pid:99}}:{})});
    if(kind==='resetBudget'){h.marker.transport.disconnectedSince++;await h.publishMarker();}
    if(kind==='privateState'){h.marker.connectionState='TEST_PRIVATE';await h.publishMarker();}
    if(kind==='missing')await rm(join(dir,'listener.ready.json'));
  };
  expect(await h.port.health()).toBe(false);expect(h.events.filter(e=>e==='launch:listener')).toHaveLength(1);
  const bytes=await readFile(join(dir,'runtime-health.listener-recovery.json'),'utf8');expect(JSON.parse(bytes).phase).toBe('failed');expect(bytes).not.toContain('TEST_PRIVATE');
});
it('counts slow final verification against the recovery budget',async()=>{
  const h=await transportHarness();let reads=0;const context=h.effects.context;
  h.effects.context=async(...args)=>{const v=await context(...args);if(++reads===2){h.advance(180001);h.marker.phase='ready';h.marker.connectionState='connected';await h.publishMarker();}return {...v,leaseVerifiedAt:h.clock()};};
  expect(await h.port.health()).toBe(false);expect(JSON.parse(await readFile(join(dir,'runtime-health.listener-recovery.json'),'utf8')).phase).toBe('failed');
});
it('keeps the original running desktop through a settings gap and requires new admission before health succeeds',async()=>{
  const h=await configurationHarness(),started=h.clock(),pause=h.effects.pause;let readDenied=false;
  h.effects.pause=async()=>{await pause();await expect(readDesktopToolConfig(h.input.host)).rejects.toMatchObject({code:'ENOENT'});readDenied=true;if(h.clock()-started>=20000)h.refresh();};
  expect(await h.port.health()).toBe(true);expect(readDenied).toBe(true);expect(h.events).toContain('liveOriginalIdentity');expect(h.events).toContain('refreshedCatalog');
  expect(h.events.filter(e=>e.startsWith('launch:'))).toEqual(['launch:broker','launch:host','launch:listener']);expect(h.events).not.toContain('packageRestore');expect(h.events).not.toContain('startLegacy');
  const trace=JSON.parse(await readFile(join(dir,'runtime-health.configuration-refresh.json'),'utf8'));expect(trace.phase).toBe('fresh_connection_verified');expect(trace.until-trace.firstObservedAt).toBe(60000);
  await expect(readFile(join(dir,'runtime-health.failure.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it('allows one diagnostic publication recheck after admission has already been withdrawn',async()=>{
  const h=await configurationHarness();await rm(`${h.input.host.connectionFile}.invalidation.json`);const pause=h.effects.pause;
  h.effects.pause=async()=>{await pause();await h.publish();h.refresh();};expect(await h.port.health()).toBe(true);
});
it('bounds continuous settings writes by the first withdrawal instead of extending the wait',async()=>{
  const h=await configurationHarness(),started=h.clock(),pause=h.effects.pause;
  h.effects.pause=async()=>{await pause();h.withdrawal.observedAt=h.clock();h.withdrawal.readiness.revision++;await h.publish();};
  expect(await h.port.health()).toBe(false);expect(h.clock()-started).toBe(60000);
  const trace=JSON.parse(await readFile(join(dir,'runtime-health.configuration-refresh.json'),'utf8'));expect(trace.firstObservedAt).toBe(started);expect(trace.phase).toBe('failed');expect(trace.originalErrorSha256).toHaveLength(64);
});
it.each(['socket','failedResponse','failure','foreignRun','foreignHost','stale','pendingUnknown'])('never interprets %s withdrawal evidence as healthy configuration activity',async kind=>{
  const h=await configurationHarness();
  if(kind==='socket')h.withdrawal.readiness.lastChange='desktop connection closed';if(kind==='failedResponse')h.withdrawal.readiness.lastChange='response config/batchWrite failed';
  if(kind==='failure')h.withdrawal.readiness.configurationFailures=1;if(kind==='foreignRun')h.withdrawal.runId='foreign';if(kind==='foreignHost')h.withdrawal.hostPid=99;
  if(kind==='stale')h.advance(61000);if(kind==='pendingUnknown')h.withdrawal.readiness.pendingConfiguration=['other/write'];await h.publish();
  expect(await h.port.health()).toBe(false);expect(h.events).not.toContain('liveOriginalIdentity');
},20_000);
it.each(['identity','locks','owner','retirement','catalog','backend','oldLease','otherFile'])('fails closed on %s change during configuration refresh',async kind=>{
  const h=await configurationHarness();
  if(kind==='identity')h.effects.configurationIdentity=async()=>{throw Error('Original process changed');};
  if(kind==='locks')h.badLocks();if(kind==='owner')h.effects.configurationIdentity=async()=>{(h.port as any).lost=true;throw Error('Owner lost');};
  if(kind==='retirement')h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'f'.repeat(64)});
  if(['catalog','backend','oldLease'].includes(kind)){let reads=0;h.effects.context=async()=>{if(++reads===1)throw h.missing();const v=structuredClone(h.original);if(kind==='catalog')v.toolNames=['unexpected'];if(kind==='backend')v.backend.createdAt='2026-10-12T00:01:00.000Z';return v;};}
  if(kind==='otherFile')h.effects.context=async()=>{throw Object.assign(h.missing(),{path:join(dir,'other.json')});};
  expect(await h.port.health()).toBe(false);expect(h.events).not.toContain('packageRestore');expect(h.events.filter(e=>e==='launch:listener')).toHaveLength(1);
});
it.each([57000,61000])('includes the final context verification in the fixed refresh budget at %d ms',async elapsed=>{
  const h=await configurationHarness(),started=h.clock();let reads=0;
  h.effects.context=async(_owned,refreshCatalog)=>{
    if(++reads===1)throw h.missing();expect(refreshCatalog).toBe(true);
    h.advance(elapsed-1000);await h.effects.pause();
    return {...h.original,leaseVerifiedAt:h.clock(),privateExtra:'TEST_PRIVATE_REFRESH'};
  };
  expect(await h.port.health()).toBe(elapsed<60000);
  const bytes=await readFile(join(dir,'runtime-health.configuration-refresh.json'),'utf8'),trace=JSON.parse(bytes);
  expect(trace.firstObservedAt).toBe(started);expect(trace.until-started).toBe(60000);expect(trace.freshChecks.withinWindow).toBe(elapsed<60000);
  expect(Object.entries(trace.freshChecks).filter(([key])=>key!=='withinWindow').every(([,passed])=>passed===true)).toBe(true);
  expect(bytes).not.toContain('TEST_PRIVATE_REFRESH');
  if(elapsed>=60000)expect(trace.errorSha256).toBe(createHash('sha256').update('Configuration refresh exceeded bounded window').digest('hex'));
});
it('records a changed identity independently of an expired verification budget',async()=>{
  const h=await configurationHarness();let reads=0;
  h.effects.context=async()=>{if(++reads===1)throw h.missing();h.advance(61000);return {...h.original,desktop:{...h.original.desktop,pid:99},leaseVerifiedAt:h.clock()};};
  expect(await h.port.health()).toBe(false);
  const trace=JSON.parse(await readFile(join(dir,'runtime-health.configuration-refresh.json'),'utf8'));
  expect(trace.freshChecks).toMatchObject({desktopIdentity:false,withinWindow:false});
  expect(trace.errorSha256).toBe(createHash('sha256').update('Configuration wait fresh context differs from original admission').digest('hex'));
});
it('runs final native admission after credentials and deployment verification, before listener creation',async()=>{
  const h=harness();await h.port.startBroker(runId);await h.port.startHost(runId);h.events.length=0;
  const verify=h.effects.verify;h.effects.verify=async()=>{h.events.push('deploymentVerify');return verify();};
  await h.port.startListener(runId,async()=>{h.events.push('finalAdmission');});
  expect(h.events.filter(e=>['secret','deploymentVerify','finalAdmission','launch:listener'].includes(e))).toEqual(['secret','deploymentVerify','finalAdmission','launch:listener']);
});
it('does not publish a listener intent or create its process when final admission rejects',async()=>{
  const h=harness();await h.port.startBroker(runId);await h.port.startHost(runId);
  await expect(h.port.startListener(runId,async()=>{throw Error('Final native task active');})).rejects.toThrow('Final native task active');
  expect(h.events).not.toContain('launch:listener');expect(h.inventory.listener).toEqual([]);
  await expect(readFile(join(dir,'launch-listener.intent.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it('refreshes the concrete listener proof after a slow deployment verification',async()=>{
  const h=harness(false,'new-only');h.inventory.legacy=[];
  h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)});
  const journal=join(dir,'journal.json'),verify=h.effects.verify;let delayed=false,stop=false;
  h.effects.verify=async()=>{const state=JSON.parse(await readFile(journal,'utf8'));if(state.phase==='starting_listener'&&!delayed){delayed=true;h.advance(6000);}return verify();};
  const state=await new DesktopSupervisor(new SupervisorJournal(journal),h.port,h.bindings,h.clock).run(async()=>stop,async()=>{if(h.inventory.desktop[0]?.pid===2&&!h.inventory.host.length)h.inventory.desktop=[];else stop=true;},{startMode:'cold',channelMode:'new-only'});
  expect(delayed).toBe(true);expect(state.errorCode).toBeUndefined();expect(state.phase).toBe('restored');
  const intent=JSON.parse(await readFile(join(dir,'launch-listener.intent.json'),'utf8'));
  expect(intent.requestedAt-state.lastIdleProof!.verifiedAt).toBeLessThanOrEqual(5000);
});
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
async function managedQuitHarness(){
  const h=harness(false,'new-only');h.inventory.legacy=[];h.input.host.desktopQuitPolicy='stop-with-desktop';
  h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)});
  await h.port.startBroker(runId);await h.port.startHost(runId);await h.port.sharedIdle();await h.port.startListener(runId);
  const receipt=(extra={})=>writeFile(`${h.input.host.connectionFile}.desktop-exit.json`,JSON.stringify({version:1,runId,hostPid:4,desktopPid:5,backendPid:88,observedAt:h.clock(),exitCode:0,verifiedOnce:true,backendWasRunning:true,...extra}),'utf8');
  return {...h,receipt};
}
it('keeps healthy polling immediate but awaits the original clean receipt after a tool-pipe failure while the GUI is still present',async()=>{
  const h=await managedQuitHarness(),started=h.clock(),pause=h.effects.pause;let waits=0;
  expect(await h.port.desktopQuit()).toBeUndefined();expect(h.clock()).toBe(started);
  h.effects.pause=async()=>{await pause();if(++waits===9){h.inventory.desktop=[];h.inventory.host=[];await h.receipt();}};
  expect(await h.port.desktopQuit({waitForReceipt:true})).toEqual(h.ids.shared);expect(waits).toBe(9);
  expect(h.events.filter(e=>e.startsWith('launch:'))).toEqual(['launch:broker','launch:host','launch:listener']);expect(h.events).not.toContain('packageRestore');expect(h.events).not.toContain('shell');
});
it('reads a receipt published during the inventory query even when the original host has already exited',async()=>{
  const h=await managedQuitHarness(),inventory=h.effects.control.inventory;let reads=0;
  h.effects.control.inventory=async()=>{if(++reads===1){h.advance(10000);h.inventory.desktop=[];h.inventory.host=[];await h.receipt();}return inventory();};
  expect(await h.port.desktopQuit({waitForReceipt:true})).toEqual(h.ids.shared);expect(reads).toBe(1);expect(h.events).not.toContain('packageRestore');
});
it('does not turn an unresponsive live GUI into a clean quit and bounds failed-health receipt waiting by twenty seconds',async()=>{
  const h=await managedQuitHarness(),started=h.clock();
  expect(await h.port.desktopQuit({waitForReceipt:true})).toBeUndefined();expect(h.clock()-started).toBe(20000);expect(h.inventory.desktop).toEqual([h.ids.shared]);
});
it.each(['desktop','host','listener','broker','legacy','owner'])('rejects a %s conflict while awaiting the original quit receipt',async role=>{
  const h=await managedQuitHarness(),started=h.clock();
  if(role==='owner')(h.port as any).lost=true;
  else if(role==='legacy')h.inventory.legacy=[h.ids.legacy];
  else h.inventory[role as 'desktop'|'host'|'listener'|'broker']=[{...h.ids.shared,createdAt:'2026-10-12T00:00:00.000Z'}];
  expect(await h.port.desktopQuit({waitForReceipt:true})).toBeUndefined();expect(h.clock()).toBe(started);expect(h.events).not.toContain('packageRestore');
});
it('rejects an abnormal receipt that arrives while waiting after failed health',async()=>{
  const h=await managedQuitHarness(),pause=h.effects.pause;
  h.effects.pause=async()=>{await pause();h.inventory.desktop=[];h.inventory.host=[];await h.receipt({exitCode:1});};
  await expect(h.port.desktopQuit({waitForReceipt:true})).rejects.toThrow('receipt invalid');expect(h.events).not.toContain('packageRestore');
});
it('does not accept a receipt published after owner-lease loss during the bounded wait',async()=>{
  const h=await managedQuitHarness(),pause=h.effects.pause;
  h.effects.pause=async()=>{await pause();(h.port as any).lost=true;h.inventory.desktop=[];h.inventory.host=[];await h.receipt();};
  expect(await h.port.desktopQuit({waitForReceipt:true})).toBeUndefined();expect(h.events).not.toContain('packageRestore');
});
it.each([20000,20001])('includes a slow final inventory read in the fixed quit-receipt budget at %d ms',async elapsed=>{
  const h=await managedQuitHarness(),inventory=h.effects.control.inventory;
  h.effects.control.inventory=async()=>{h.advance(elapsed);h.inventory.desktop=[];h.inventory.host=[];await h.receipt();return inventory();};
  expect(await h.port.desktopQuit({waitForReceipt:true})).toEqual(elapsed===20000?h.ids.shared:undefined);expect(h.events).not.toContain('packageRestore');
});
it('closes the concrete managed lifecycle when tool-pipe loss precedes GUI exit and the host receipt by nine seconds',async()=>{
  const h=harness(false,'new-only');h.inventory.legacy=[];h.inventory.desktop=[];h.input.host.desktopQuitPolicy='stop-with-desktop';
  h.effects.control.legacyRetirement=async()=>({version:1,observedAt:h.clock(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)});
  const path=join(dir,'journal.json'),pause=h.effects.pause;let failed=false,healthReads=0,waits=0;
  h.effects.context=async()=>{const s=JSON.parse(await readFile(path,'utf8'));if(s.phase==='running'){failed=true;healthReads++;throw Error('Owned tool pipe unverified');}return {} as any;};
  h.effects.pause=async()=>{await pause();if(failed&&++waits===9){const s=JSON.parse(await readFile(path,'utf8'));h.inventory.desktop=[];h.inventory.host=[];await writeFile(`${h.input.host.connectionFile}.desktop-exit.json`,JSON.stringify({version:1,runId:s.runId,hostPid:4,desktopPid:5,backendPid:88,observedAt:h.clock(),exitCode:0,verifiedOnce:true,backendWasRunning:true}),'utf8');}};
  const result=await new DesktopSupervisor(new SupervisorJournal(path),h.port,h.bindings,h.clock).run(async()=>false,async()=>{}, {startMode:'cold',channelMode:'new-only',serviceMode:'stop-with-desktop'});
  expect(result).toMatchObject({phase:'closed',desktopQuitVerified:true});expect(result.errorCode).toBeUndefined();expect(healthReads).toBe(1);expect(waits).toBe(9);
  expect(h.inventory).toMatchObject({desktop:[],legacy:[],host:[],listener:[],broker:[]});expect(h.events).not.toContain('packageRestore');expect(h.events).not.toContain('shell');
  expect(h.events.filter(e=>e.startsWith('launch:'))).toEqual(['launch:broker','launch:host','launch:listener']);
  expect(JSON.parse(await readFile(join(dir,'runtime-health.failure.json'),'utf8')).errorSha256).toBe(createHash('sha256').update('Owned tool pipe unverified').digest('hex'));
  expect(JSON.parse(await readFile(join(dir,'runtime-desktop-quit-observation.json'),'utf8'))).toMatchObject({runId:result.runId,reason:'original_receipt_verified',elapsedMs:9000});
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
