import { randomBytes,createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { dirname,join,resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { BrokerOwnerLease } from './broker-lease';
import { sameProcess,validRetirementProof,type SupervisorPort,type ProcessIdentity,type SupervisorState,type OrdinaryProof } from './supervisor';
import { verifyDeployment,pendingApprovalChats } from './deployment';
import { WindowsSupervisorControl } from './supervisor-windows';
import { inspectOwnedShared,readOwnedSharedContext,readOwnedSharedIdentity } from './shared-inspector';
import type {SharedContext} from './shared-idle';
import {writeFileAtomic} from '../platform/atomic-write';
import { desktopPipes,desktopToolCatalog,cleanDesktopEnvironment,windowsPowerShellEnvironment } from './windows-tools';
import { execFile,spawn,type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { TaskUacController } from './task-uac';
import {LISTENER_RECONNECT_MS} from './listener-transport';
import {topicChatEnabled} from './topics';

type Deployment=Awaited<ReturnType<typeof verifyDeployment>>;
type Control=Pick<WindowsSupervisorControl,'inventory'|'taskPermissions'|'canStopLegacy'|'coldSnapshot'|'backupTask'|'pauseTask'|'restoreTaskSetting'|'startLegacy'|'stopOwned'|'testIdentity'|'protectCapability'|'unprotectCapability'|'startOrdinary'> & Partial<Pick<WindowsSupervisorControl,'legacyRetirement'>>;
export interface RuntimeEffects {
  control:Control;
  verify():Promise<Deployment>;
  launch(role:'broker'|'host'|'listener',runId:string,env:NodeJS.ProcessEnv):Promise<ProcessIdentity>;
  command(args:string[],env:NodeJS.ProcessEnv):Promise<void>;
  secret():Promise<string>;
  shared(owned:{host:ProcessIdentity;broker:ProcessIdentity}):ReturnType<typeof inspectOwnedShared>;
  context(owned:{host:ProcessIdentity;broker:ProcessIdentity;listener?:ProcessIdentity},refreshCatalog?:boolean):ReturnType<typeof readOwnedSharedContext>;
  configurationIdentity?(owned:{host:ProcessIdentity;broker:ProcessIdentity;listener?:ProcessIdentity},expected:SharedContext):Promise<void>;
  ordinaryTools(desktop:ProcessIdentity):Promise<boolean>;
  locksHeld():Promise<boolean>;
  now():number;
  pause():Promise<void>;
}
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const sleep=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
const CONFIGURATION_REFRESH_WINDOW_MS=60_000;
/** A Windows listener without a console must have the original bounded owner
 * lease. Other roles keep their existing parent/job lifecycle. */
export function detachOwnedListener(role:'broker'|'host'|'listener',extra:NodeJS.ProcessEnv,directory:string,platform=process.platform):boolean{
  if(role!=='listener'||platform!=='win32')return false;
  if(extra.BRIDGE_SUPERVISOR_OWNER_LEASE_FILE!==join(directory,'broker-owner.json'))throw new Error('Detached listener requires its original owner lease');
  return true;
}
/** Concrete cold lifecycle; only an explicitly invoked runtime worker creates
 * it. Never calls closeDesktop, overwrites ledgers or repeats launch intents. */
export class DesktopRuntimePort implements SupervisorPort {
  private owned:Partial<Record<'broker'|'host'|'listener',ProcessIdentity>>={};
  private runId?:string;
  private token?:string;
  private appSecret?:string;
  private lease?:BrokerOwnerLease;
  private lost=false;
  private sharedObservation=0;
  private sharedDesktop?:ProcessIdentity;
  private lastSharedContext?:SharedContext;
  private retirementDefinition?:{taskPresent:boolean;definitionSha256:string};
  constructor(private readonly input:Deployment,readonly directory:string,private readonly owner:ProcessIdentity,
    private readonly effects:RuntimeEffects, recovery?:SupervisorState,private readonly channelMode?:'new-only'){
    if(resolve(directory)!==dirname(input.host.connectionFile) || !sameProcess(owner,owner))throw new Error('Runtime directory or owner invalid');
    if(channelMode!==undefined && channelMode!=='new-only' || recovery && recovery.channelMode!==channelMode)throw new Error('Runtime channel policy mismatch');
    if(recovery){this.owned=structuredClone(recovery.owned);this.runId=recovery.runId;if(recovery.newBaseline)this.retirementDefinition=structuredClone(recovery.newBaseline.retirement);}
  }
  inventory(){return this.effects.control.inventory();}
  coldExit(){return this.effects.control.coldSnapshot();}
  async legacyRetirement(){
    if(this.channelMode!=='new-only' || !this.effects.control.legacyRetirement)throw new Error('New-only retirement reader unavailable');
    const i=await this.inventory(),p=await this.effects.control.legacyRetirement();
    if(i.legacy.length || !validRetirementProof(p) || p.observedAt>this.effects.now()+1000 || this.effects.now()-p.observedAt>60_000)throw new Error('Legacy startup or consumer not retired');
    if(this.retirementDefinition && (p.taskPresent!==this.retirementDefinition.taskPresent || p.definitionSha256!==this.retirementDefinition.definitionSha256))throw new Error('Retired task definition changed');
    this.retirementDefinition={taskPresent:p.taskPresent,definitionSha256:p.definitionSha256};
    return p;
  }
  async idle():Promise<never>{throw new Error('Runtime worker only supports cold admission');}
  async closeDesktop():Promise<never>{throw new Error('Cold runtime never closes the ordinary desktop');}
  async verifyClosedBindings(){return this.verifyBindings(true);}
  async verifyBindings(closing=false){
    const current=await this.effects.verify();
    if(JSON.stringify(current.snapshot.bindings)!==JSON.stringify(this.input.snapshot.bindings))throw new Error('Runtime original bindings changed');
    const selected=current.ledgers.filter(l=>topicChatEnabled(current.topics,l.binding.chatId));
    if(selected.some(l=>l.counts.queued || l.counts.running || l.counts.submitting || !closing && l.counts.uncertain))throw new Error('Gray ledger requires reconciliation');
    // Historical uncertain outside the gray scope is preserved. Any active
    // queue in any original group still forbids pausing the consumer.
    if(current.ledgers.some(l=>l.counts.queued || l.counts.running || l.counts.submitting))throw new Error('Original group has active work');
    if((await pendingApprovalChats(current.topics)).length)throw new Error('Original approvals not closed');
    if(this.owned.broker && !(await this.inventory()).broker.length){
      const status=await json(join(this.directory,'package-broker.status.json'));
      if(status.phase!=='stopped' || status.pid!==this.owned.broker.pid || status.runId!==this.runId || status.drainTimedOut===true)throw new Error('Broker final exit unverified');
    }
  }
  async backup(){
    if(this.channelMode==='new-only')throw new Error('New-only runtime does not back up or manage legacy tasks');
    const inventory=await this.inventory();
    if(inventory.legacy.length!==1 || !await this.effects.control.canStopLegacy(inventory.legacy[0]!))throw new Error('Old consumer stop permission unavailable before desktop exit');
    const permissions=await this.effects.control.taskPermissions();
    await writeFile(join(this.directory,'legacy-permissions.json'),JSON.stringify(permissions),{encoding:'utf8',flag:'wx'});
    if(!permissions.writeAllowed || !permissions.executeAllowed)throw new Error('Legacy task permissions unavailable before desktop exit');
    const b=await this.effects.control.backupTask(join(this.directory,'legacy-backup'));
    return {legacyTaskEnabled:b.enabled,launchDefinitionSha256:b.definitionSha256};
  }
  async pauseLegacy(identity:ProcessIdentity){
    if(this.channelMode==='new-only')throw new Error('New-only runtime never pauses a legacy consumer');
    await this.verifyBindings();await this.effects.control.testIdentity('legacy',identity);
    this.appSecret=await this.effects.secret();if(!this.appSecret)throw new Error('Secret provider unavailable');
    await this.effects.control.pauseTask(join(this.directory,'legacy-backup'));
    await this.effects.control.stopOwned('legacy',identity);
  }
  private async intent(name:string,value:any){
    const path=join(this.directory,`${name}.intent.json`);
    try{await writeFile(path,JSON.stringify(value),{encoding:'utf8',flag:'wx',mode:0o600});}
    catch(e){
      if((e as NodeJS.ErrnoException).code!=='EEXIST' || !name.startsWith('stop-'))throw e;
      const previous=await json(path);if(previous.version!==1 || previous.runId!==value.runId || !sameProcess(previous.identity,value.identity))throw new Error('Prior stop intent changed');
    }
  }
  private async capability():Promise<string>{
    if(!this.token)this.token=await this.effects.control.unprotectCapability(join(this.directory,'broker-capability.dpapi'));
    return this.token;
  }
  async startBroker(runId:string){
    if(this.channelMode==='new-only')await this.legacyRetirement();
    if(this.owned.broker || this.lease)throw new Error('Broker launch already attempted');
    if(this.runId && this.runId!==runId)throw new Error('Runtime run changed');this.runId=runId;
    this.token=randomBytes(32).toString('hex');
    await this.effects.control.protectCapability(join(this.directory,'broker-capability.dpapi'),this.token);
    this.lease=new BrokerOwnerLease(join(this.directory,'broker-owner.json'));
    await this.lease.open(runId,this.owner,`OpenAI.Codex_${this.input.host.desktopVersion}_x64__2p2nqsd0c76g0`,this.token);
    this.lease.startHeartbeat(()=>{this.lost=true;});
    return this.launch('broker',runId,{});
  }
  private async launch(role:'broker'|'host'|'listener',runId:string,extra:NodeJS.ProcessEnv,beforeCreate?:()=>Promise<void>){
    await this.effects.verify();await beforeCreate?.();await this.intent(`launch-${role}`,{version:1,runId,role,requestedAt:this.effects.now()});
    const identity=await this.effects.launch(role,runId,extra);
    if(!sameProcess(identity,identity))throw new Error('Runtime launch identity unavailable');
    await writeFile(join(this.directory,`${role}.receipt.json`),JSON.stringify({version:1,runId,role,identity}),{encoding:'utf8',flag:'wx',mode:0o600});
    this.owned[role]=structuredClone(identity);return identity;
  }
  async startHost(runId:string){return this.launch('host',runId,{BRIDGE_PACKAGE_BROKER_TOKEN:await this.capability(),BRIDGE_SUPERVISOR_RUN_ID:runId,BRIDGE_SUPERVISOR_OWNER_LEASE_FILE:join(this.directory,'broker-owner.json')});}
  async startListener(runId:string,beforeCreate?:()=>Promise<void>){
    if(!this.appSecret)this.appSecret=await this.effects.secret();if(!this.appSecret)throw new Error('Secret provider unavailable');
    const result=await this.launch('listener',runId,{[this.input.topics.appSecretEnv]:this.appSecret,BRIDGE_SUPERVISOR_RUN_ID:runId,BRIDGE_SUPERVISOR_READY_FILE:join(this.directory,'listener.ready.json'),BRIDGE_SUPERVISOR_OWNER_LEASE_FILE:join(this.directory,'broker-owner.json')},beforeCreate);
    this.appSecret=undefined;return result;
  }
  private sharedOwned(){if(!this.owned.host || !this.owned.broker)throw new Error('Shared runtime not owned');return {host:this.owned.host,broker:this.owned.broker,...(this.owned.listener?{listener:this.owned.listener}:{})};}
  async sharedIdle(){
    const r=await this.effects.shared(this.sharedOwned());
    await writeFile(join(this.directory,`shared-idle-${++this.sharedObservation}.json`),JSON.stringify(r),{encoding:'utf8',flag:'wx',mode:0o600});
    if(!r.verified || !r.proof)throw new Error('Shared native admission unavailable');this.sharedDesktop=structuredClone(r.proof.desktop);return r.proof;
  }
  async desktopQuit(options:{waitForReceipt?:boolean}={}):Promise<ProcessIdentity|undefined>{
    if(this.channelMode!=='new-only' || this.input.host.desktopQuitPolicy!=='stop-with-desktop' || !this.sharedDesktop || !this.owned.host || this.lost)return;
    let p:any;
    const deadline=this.effects.now()+20_000;
    let receiptRead:'before_inventory'|'after_inventory'='before_inventory';
    const report=async(reason:string,checks?:Record<string,boolean>)=>{
      if(!options.waitForReceipt)return;
      try{await writeFileAtomic(join(this.directory,'runtime-desktop-quit-observation.json'),JSON.stringify({version:1,runId:this.runId,
        startedAt:deadline-20_000,deadline,observedAt:this.effects.now(),elapsedMs:this.effects.now()-(deadline-20_000),reason,receiptRead,...(checks?{checks}:{})}));}catch{}
    };
    for(;;){
      receiptRead='before_inventory';
      try{p=await json(`${this.input.host.connectionFile}.desktop-exit.json`);break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      const i=await this.inventory();
      // Inventory can outlast receipt publication and the original host's
      // exit. Re-read before rejecting a now-absent host; no missing process
      // or old readiness grants clean-quit permission.
      receiptRead='after_inventory';
      try{p=await json(`${this.input.host.connectionFile}.desktop-exit.json`);break;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      // A closing GUI can lose its tool pipe before disappearing. Only the
      // failed-health path may wait while that exact GUI remains. Normal
      // healthy polling stays immediate; both paths retain the fixed 20s
      // receipt budget, original roles and subsequent empty-GUI verification.
      const checks={ownerAvailable:!this.lost,
        originalDesktop:i.desktop.length===0||options.waitForReceipt===true&&i.desktop.length===1&&sameProcess(i.desktop[0]!,this.sharedDesktop),
        noLegacy:i.legacy.length===0,originalHost:i.host.length===0||i.host.length===1&&sameProcess(i.host[0]!,this.owned.host),
        originalBroker:!!this.owned.broker&&i.broker.length===1&&sameProcess(i.broker[0]!,this.owned.broker),
        originalListener:!!this.owned.listener&&i.listener.length===1&&sameProcess(i.listener[0]!,this.owned.listener),withinBudget:this.effects.now()<deadline};
      if(!Object.values(checks).every(Boolean)){await report('inventory_refused',checks);return;}
      await this.effects.pause();
    }
    if(this.lost || this.effects.now()>deadline){await report('receipt_observation_refused',{ownerAvailable:!this.lost,withinBudget:this.effects.now()<=deadline});return;}
    if(p?.version!==1 || p.runId!==this.runId || p.hostPid!==this.owned.host.pid || p.desktopPid!==this.sharedDesktop.pid || !Number.isSafeInteger(p.backendPid) || p.backendPid<1
      || p.exitCode!==0 || p.verifiedOnce!==true || p.backendWasRunning!==true || !Number.isFinite(p.observedAt)
      || p.observedAt<Date.parse(this.sharedDesktop.createdAt) || p.observedAt>this.effects.now()+1000 || this.effects.now()-p.observedAt>30_000){await report('receipt_invalid');throw new Error('Owned desktop quit receipt invalid');}
    await report('original_receipt_verified');
    if(this.lost || this.effects.now()>deadline)return;
    return structuredClone(this.sharedDesktop);
  }
  private listenerChecks(r:any){
    // Persist fixed boolean checks only, never an untrusted heartbeat or lease.
    return {versionMatches:r.version===1,runMatches:r.runId===this.runId,pidMatches:r.pid===this.owned.listener?.pid,
      phaseReady:r.phase==='ready',connected:r.connectionState==='connected',
      heartbeatFresh:Number.isFinite(r.updatedAt) && r.updatedAt<=this.effects.now()+1000 && this.effects.now()-r.updatedAt<=10_000,
      readyTimeValid:Number.isFinite(r.readyAt) && r.readyAt<=this.effects.now()+1000 && !!this.owned.listener && r.readyAt>=Date.parse(this.owned.listener.createdAt)-1000,
      scopeMatches:this.input.snapshot.spec.scope==='registered-topics'
        ? JSON.stringify(r.enabledChatIds)==='[]'&&r.scope==='registered-topics'&&r.entryChatId===this.input.topics.entryChatId&&r.allowTopicCreation===true
        : r.scope===undefined&&JSON.stringify(r.enabledChatIds)===JSON.stringify(this.input.topics.enabledChatIds)};
  }
  private async listenerReadiness(){return this.listenerChecks(await json(join(this.directory,'listener.ready.json')));}
  private async listenerReady(){return Object.values(await this.listenerReadiness()).every(Boolean);}
  private async awaitListenerRecovery(first:any):Promise<boolean>{
    const expected=this.lastSharedContext,started=this.effects.now(),since=first.transport?.disconnectedSince;
    const fixed=(r:any)=>{const c=this.listenerChecks(r);return Object.entries(c).every(([k,v])=>k==='phaseReady'||k==='connected'||v);};
    // Only the original new-only listener's fresh transport transition is
    // recoverable. Invalid/missing/stale/foreign markers still fail immediately.
    if(this.channelMode!=='new-only'||!expected?.packageIdentityVerified||!expected.endpointOwnershipVerified||!expected.backend||!expected.desktop
      ||!this.sharedDesktop||!sameProcess(expected.desktop,this.sharedDesktop)||!this.owned.listener||!fixed(first)
      ||first.phase!=='reconnecting'||!['connecting','reconnecting','disconnected','connected'].includes(first.connectionState)
      ||first.transport?.version!==1||!Number.isSafeInteger(since)||since<first.readyAt||since>started+1000)return false;
    const until=Math.min(since+LISTENER_RECONNECT_MS,started+LISTENER_RECONNECT_MS);
    let polls=0,lastState=first.connectionState;
    const report=async(phase:string)=>writeFileAtomic(join(this.directory,'runtime-health.listener-recovery.json'),JSON.stringify({version:1,runId:this.runId,phase,
      firstDisconnectedAt:since,startedAt:started,until,observedAt:this.effects.now(),elapsedMs:this.effects.now()-started,polls,lastState}));
    await report('waiting');
    try{
      while(this.effects.now()<until){
        if(this.lost)throw Error('Listener recovery owner lease lost');
        try{await readFile(join(this.directory,'stop.request'));throw Error('Listener recovery stop requested');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        await this.legacyRetirement();
        const i=await this.inventory();
        if(i.desktop.length!==1||!sameProcess(i.desktop[0]!,expected.desktop)||['host','listener','broker'].some(role=>i[role as 'host'|'listener'|'broker'].length!==1
          ||!sameProcess(i[role as 'host'|'listener'|'broker'][0]!,this.owned[role as 'host'|'listener'|'broker']!)))throw Error('Listener recovery original processes changed');
        const fresh=await this.effects.context(this.sharedOwned(),true);
        if(!sameProcess(fresh.host,expected.host)||!sameProcess(fresh.desktop,expected.desktop)||!sameProcess(fresh.backend,expected.backend)
          ||fresh.endpoint!==expected.endpoint||fresh.backendEndpoint!==expected.backendEndpoint||fresh.desktopVersion!==expected.desktopVersion||fresh.codexSha256!==expected.codexSha256
          ||fresh.packageIdentityVerified!==true||fresh.endpointOwnershipVerified!==true||JSON.stringify([...fresh.toolNames].sort())!==JSON.stringify([...this.input.snapshot.spec.expectedToolNames].sort())
          ||!Number.isFinite(fresh.leaseVerifiedAt)||fresh.leaseVerifiedAt<expected.leaseVerifiedAt||fresh.leaseVerifiedAt>this.effects.now()+1000||this.effects.now()-fresh.leaseVerifiedAt>60000
          ||!await this.effects.locksHeld())throw Error('Listener recovery context or locks changed');
        const marker=await json(join(this.directory,'listener.ready.json'));polls++;lastState=['connected','connecting','reconnecting','disconnected','failed','unknown'].includes(marker.connectionState)?marker.connectionState:'unknown';
        if(!fixed(marker)||marker.readyAt!==first.readyAt)throw Error('Listener recovery marker identity changed');
        if(this.lost)throw Error('Listener recovery owner lease lost');
        if(this.effects.now()>=until)throw Error('Listener recovery deadline exceeded');
        if(Object.values(this.listenerChecks(marker)).every(Boolean)){this.lastSharedContext=fresh;await report('recovered');return true;}
        if(marker.phase!=='reconnecting'||marker.transport?.version!==1||marker.transport.disconnectedSince!==since
          ||!['connecting','reconnecting','disconnected','connected'].includes(marker.connectionState))throw Error('Listener recovery transition rejected');
        await this.effects.pause();
      }
      throw Error('Listener recovery deadline exceeded');
    }catch{await report('failed');return false;}
  }
  async ready(){
    const deadline=this.effects.now()+130_000;
    do{
      if(this.lost)throw new Error('Supervisor broker lease lost');
      const i=await this.inventory();
      if(i.legacy.length || !this.owned.host || !this.owned.broker || i.host.length!==1 || i.broker.length!==1
        || !sameProcess(i.host[0]!,this.owned.host) || !sameProcess(i.broker[0]!,this.owned.broker))throw new Error('Owned runtime changed during readiness');
      try{this.lastSharedContext=await this.effects.context(this.sharedOwned());if(!this.owned.listener || await this.listenerReady() && await this.effects.locksHeld())return;}catch{}
      await this.effects.pause();
    }while(this.effects.now()<deadline);
    throw new Error('Runtime readiness deadline exceeded');
  }
  private async healthFailure(reason:string,details?:{stage:'retirement'|'shared_context'|'listener'|'locks';errorSha256?:string;checks?:Awaited<ReturnType<DesktopRuntimePort['listenerReadiness']>>}){
    // Keep the first failed observation. Diagnostics never relax fail-closed
    // health, retry reads/mutations, or expose raw errors/private capabilities.
    try{await writeFile(join(this.directory,'runtime-health.failure.json'),JSON.stringify({version:1,runId:this.runId,
      observedAt:this.effects.now(),reason,...details}),{encoding:'utf8',flag:'wx',mode:0o600});}catch{}
    return false;
  }
  private missingConnection(error:unknown):boolean{
    const e=error as NodeJS.ErrnoException;return e?.code==='ENOENT'&&e.path===this.input.host.connectionFile;
  }
  private validConfigurationWithdrawal(value:any,expected:SharedContext):boolean{
    const r=value?.readiness,now=this.effects.now();
    return value?.version===1&&value.runId===this.runId&&value.hostPid===this.owned.host?.pid&&value.reason==='desktop_readiness_changed'
      &&Number.isFinite(value.observedAt)&&value.observedAt>=expected.leaseVerifiedAt&&value.observedAt<=now+1000&&now-value.observedAt<CONFIGURATION_REFRESH_WINDOW_MS
      &&r?.desktopConnected===true&&r.initialized===true&&r.projectsRead===true&&r.configurationFailures===0&&Number.isSafeInteger(r.revision)&&r.revision>0
      &&/^(request|response) (config\/batchWrite|config\/value\/write|experimentalFeature\/enablement\/set)$/.test(r.lastChange??'')
      &&Array.isArray(r.pendingConfiguration)&&r.pendingConfiguration.every((m:unknown)=>['config/batchWrite','config/value/write','experimentalFeature/enablement/set'].includes(m as string));
  }
  private async healthContext():Promise<void>{
    try{this.lastSharedContext=await this.effects.context(this.sharedOwned());return;}catch(firstError){
      const expected=this.lastSharedContext;
      if(!this.missingConnection(firstError)||this.channelMode!=='new-only'||!this.effects.configurationIdentity||!expected?.desktop||!expected.backend
        ||!expected.packageIdentityVerified||!expected.endpointOwnershipVerified||!this.sharedDesktop||!sameProcess(expected.desktop,this.sharedDesktop)||!this.owned.listener)throw firstError;
      // Withdrawal deliberately removes admission before publishing diagnostics.
      // Allow one publication recheck, never admit using the cached context.
      let first:any;
      try{first=await json(`${this.input.host.connectionFile}.invalidation.json`);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw firstError;}
      if(!first||first.observedAt<expected.leaseVerifiedAt){
        if(this.lost)throw firstError;await this.effects.pause();
        try{first=await json(`${this.input.host.connectionFile}.invalidation.json`);}catch{throw firstError;}
      }
      if(!this.validConfigurationWithdrawal(first,expected))throw firstError;
      // Anchor to the first withdrawal, not each subsequent settings write.
      const until=first.observedAt+CONFIGURATION_REFRESH_WINDOW_MS,trace={version:1,runId:this.runId,hostPid:this.owned.host!.pid,firstObservedAt:first.observedAt,until,
        originalErrorSha256:sha(firstError instanceof Error?firstError.message:'NonError'),lastChange:first.readiness.lastChange};
      let freshChecks:Record<string,boolean>|undefined;
      const report=async(phase:string,error?:unknown)=>{try{await writeFileAtomic(join(this.directory,'runtime-health.configuration-refresh.json'),JSON.stringify({...trace,phase,observedAt:this.effects.now(),...(freshChecks?{freshChecks}:{}),...(error?{errorSha256:sha(error instanceof Error?error.message:'NonError')}:{})}));}catch{}};
      await report('waiting_for_fresh_connection');
      try{
        while(this.effects.now()<until){
          if(this.lost)throw Error('Configuration wait owner lease lost');
          const current=await json(`${this.input.host.connectionFile}.invalidation.json`);
          if(!this.validConfigurationWithdrawal(current,expected))throw Error('Configuration withdrawal changed or failed');
          await this.legacyRetirement();await this.effects.configurationIdentity(this.sharedOwned(),expected);
          if(!await this.effects.locksHeld())throw Error('Configuration wait runtime lock lost');
          try{
            const fresh=await this.effects.context(this.sharedOwned(),true);
            const now=this.effects.now();
            freshChecks={hostIdentity:sameProcess(fresh.host,expected.host),desktopIdentity:sameProcess(fresh.desktop,expected.desktop),backendIdentity:sameProcess(fresh.backend,expected.backend),
              endpoints:fresh.endpoint===expected.endpoint&&fresh.backendEndpoint===expected.backendEndpoint,desktopVersion:fresh.desktopVersion===expected.desktopVersion,codexSha:fresh.codexSha256===expected.codexSha256,
              packageIdentity:fresh.packageIdentityVerified===true,endpointOwnership:fresh.endpointOwnershipVerified===true,newLease:fresh.leaseVerifiedAt>=first.observedAt,
              freshLease:Number.isFinite(fresh.leaseVerifiedAt)&&fresh.leaseVerifiedAt<=now+1000&&now-fresh.leaseVerifiedAt<=60000,
              toolCatalog:JSON.stringify([...fresh.toolNames].sort())===JSON.stringify([...this.input.snapshot.spec.expectedToolNames].sort()),withinWindow:now<until};
            if(Object.entries(freshChecks).some(([name,passed])=>name!=='withinWindow'&&!passed))throw Error('Configuration wait fresh context differs from original admission');
            if(!freshChecks.withinWindow)throw Error('Configuration refresh exceeded bounded window');
            this.lastSharedContext=fresh;await report('fresh_connection_verified');return;
          }catch(e){if(!this.missingConnection(e))throw e;}
          await this.effects.pause();
        }
        throw Error('Configuration refresh exceeded bounded window');
      }catch(e){await report('failed',e);throw e;}
    }
  }
  async health(){
    if(this.lost)return this.healthFailure('broker_owner_lease_lost');
    let stage:'retirement'|'shared_context'|'listener'|'locks'='retirement';
    try{
      if(this.channelMode==='new-only')await this.legacyRetirement();
      stage='shared_context';await this.healthContext();
      stage='listener';if(!this.owned.listener)return this.healthFailure('listener_not_owned');
      const marker=await json(join(this.directory,'listener.ready.json')),checks=this.listenerChecks(marker);
      if(!Object.values(checks).every(Boolean)&&!await this.awaitListenerRecovery(marker))return this.healthFailure('listener_not_ready',{stage,checks});
      stage='locks';if(!await this.effects.locksHeld())return this.healthFailure('runtime_locks_lost',{stage});
      return true;
    }catch(e){return this.healthFailure('health_read_failed',{stage,errorSha256:sha(e instanceof Error?e.message:'NonError')});}
  }
  private async stop(role:'host'|'listener',identity:ProcessIdentity){
    await this.effects.control.testIdentity(role,identity);
    await this.intent(`stop-${role}`,{version:1,runId:this.runId,identity});
    const path=role==='host'?`${this.input.host.connectionFile}.stop`:`${this.input.topics.registryFile}.stop`;
    await writeFile(path,'Supervisor requested graceful stop','utf8');
    const deadline=this.effects.now()+(role==='host'?190_000:60_000);
    while(this.effects.now()<deadline){const i=await this.inventory();if(!i[role].length)return;if(i[role].length!==1 || !sameProcess(i[role][0]!,identity))throw new Error('Owned runtime replaced during stop');await this.effects.pause();}
    throw new Error('Graceful runtime stop deadline exceeded');
  }
  stopListener(identity:ProcessIdentity){return this.stop('listener',identity);}
  stopHost(identity:ProcessIdentity){return this.stop('host',identity);}
  async ordinary():Promise<OrdinaryProof>{
    let i=await this.inventory();if(i.host.length || i.listener.length)throw new Error('Shared processes not stopped');
    if(!i.desktop.length){
      // Preserve first-path failure. A distinct shell attempt is permitted only
      // after all related processes are gone; no repeated package activation.
      if(this.owned.broker && i.broker.length===1 && sameProcess(i.broker[0]!,this.owned.broker)){
        let prior=false;try{const intent=await json(join(this.directory,'ordinary-package.intent.json'));if(intent.runId!==this.runId)throw new Error('Ordinary restore intent changed');prior=true;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
        if(!prior){
          await this.intent('ordinary-package',{version:1,runId:this.runId});
          try{await this.effects.command(['--restore'],{BRIDGE_PACKAGE_BROKER_TOKEN:await this.capability()});}
          catch(e){await writeFile(join(this.directory,'ordinary-package.failure.json'),JSON.stringify({version:1,runId:this.runId,errorCode:'package_restore_not_confirmed',errorSha256:sha(String(e))}),{encoding:'utf8',flag:'wx'});}
        }
        i=await this.inventory();
      }
      if(!i.desktop.length){
        const cold=await this.effects.control.coldSnapshot();if(!cold.complete || cold.desktopRelated.length)throw new Error('Related process remains before shell recovery');
        await this.intent('ordinary-shell',{version:1,runId:this.runId});await this.effects.control.startOrdinary();
      }
    }
    const deadline=this.effects.now()+65_000;
    do{
      i=await this.inventory();if(i.desktop.length>1 || i.host.length || i.listener.length)throw new Error('Ordinary inventory conflict');
      if(i.desktop.length===1){
        await this.effects.control.testIdentity('desktop',i.desktop[0]!);
        if(await this.effects.ordinaryTools(i.desktop[0]!)){
          const verified=await this.inventory();if(verified.desktop.length!==1 || !sameProcess(i.desktop[0]!,verified.desktop[0]!))throw new Error('Ordinary desktop changed');
          return {desktop:i.desktop[0]!,verifiedAt:this.effects.now(),packageIdentityVerified:true,toolsExact:true};
        }
      }
      await this.effects.pause();
    }while(this.effects.now()<deadline);
    throw new Error('Ordinary tools not verified');
  }
  async restoreLegacy(baseline:NonNullable<SupervisorState['baseline']>){
    if(this.channelMode==='new-only')throw new Error('New-only runtime never reactivates a legacy consumer');
    await this.effects.verify();const i=await this.inventory();
    if(i.host.length || i.listener.length || i.desktop.length!==1 || i.legacy.length>1)throw new Error('Legacy restore inventory conflict');
    if(!await this.effects.ordinaryTools(i.desktop[0]!))throw new Error('Ordinary tools unavailable before legacy restoration');
    await this.effects.control.restoreTaskSetting(join(this.directory,'legacy-backup'));
    if(!i.legacy.length){
      if(!baseline.legacyTaskEnabled)throw new Error('Disabled legacy startup requires manual recovery');
      await this.intent('restore-legacy',{version:1,runId:this.runId});await this.effects.control.startLegacy(join(this.directory,'legacy-backup'));
    }
    const deadline=this.effects.now()+45_000;
    do{const current=await this.inventory();if(current.legacy.length>1 || current.host.length || current.listener.length)throw new Error('Legacy restoration conflict');
      if(current.legacy.length===1){await this.effects.control.testIdentity('legacy',current.legacy[0]!);return;}await this.effects.pause();
    }while(this.effects.now()<deadline);throw new Error('Legacy restoration unconfirmed');
  }
  async stopBroker(identity:ProcessIdentity){
    const i=await this.inventory();if(i.host.length || i.listener.length || i.broker.length!==1 || !sameProcess(i.broker[0]!,identity))throw new Error('Broker stop inventory conflict');
    await this.intent('stop-broker',{version:1,runId:this.runId,identity});await writeFile(join(this.directory,'package-broker.stop'),'Supervisor restoration verified','utf8');
    const deadline=this.effects.now()+20_000;
    do{const current=await this.inventory();if(!current.broker.length){const status=await json(join(this.directory,'package-broker.status.json'));if(status.phase!=='stopped' || status.runId!==this.runId || status.pid!==identity.pid || status.drainTimedOut===true)throw new Error('Broker exit not verified');return;}
      if(current.broker.length!==1 || !sameProcess(current.broker[0]!,identity))throw new Error('Broker replaced during stop');await this.effects.pause();
    }while(this.effects.now()<deadline);throw new Error('Broker did not exit');
  }
  async close(){await this.lease?.close();this.lease=undefined;this.appSecret=undefined;this.token=undefined;}
}

const exec=promisify(execFile);
export async function createWindowsRuntimePort(stage:string,directory:string,root:string,recovery?:SupervisorState,taskUac?:{planId:string;deadline:number;forwardDeadline:number},channelMode?:'new-only'){
  if(channelMode==='new-only' && taskUac)throw new Error('New-only runtime cannot use legacy UAC actions');
  if(recovery && recovery.channelMode!==channelMode)throw new Error('Recovery channel policy mismatch');
  const input=await verifyDeployment(stage),script=join(root,'bin/desktop-runtime-control.ps1');
  if(process.platform!=='win32' || resolve(directory)!==dirname(input.host.connectionFile))throw new Error('Windows runtime location invalid');
  const control=await WindowsSupervisorControl.prepare(stage,script,join(directory,`control-${process.pid}`),true,channelMode!=='new-only');
  const owner=await control.ownerIdentity(process.pid);
  if(owner.pid!==process.pid || owner.executable.toLowerCase()!==process.execPath.toLowerCase())throw new Error('Runtime worker identity mismatch');
  const {host,topics,snapshot}=input;
  const uac=taskUac?new TaskUacController(stage,directory,root,owner,taskUac.planId,taskUac.deadline,control,undefined,taskUac.forwardDeadline):undefined;
  for(const relative of ['bin/lark-chatgpt-host.mjs','bin/lark-chatgpt-topics.mjs','bin/desktop-package-broker-task.ps1','bin/desktop-package-broker.ps1','dist/desktop-runtime-supervisor.js','bin/lark-chatgpt-runtime-supervisor.mjs']){
    if(!snapshot.files.some(f=>f.path===resolve(root,relative)))throw new Error('Runtime program missing from pinned files');
  }
  const children=new Map<string,ChildProcess>();
  const effects:RuntimeEffects={
    control:uac?{
      inventory:()=>control.inventory(),coldSnapshot:()=>control.coldSnapshot(),testIdentity:(role,identity)=>control.testIdentity(role,identity),canStopLegacy:identity=>control.canStopLegacy(identity),
      taskPermissions:async()=>{const permissions=await uac.call('TaskPermissions');if(!permissions)throw new Error('Task UAC permission proof missing');return permissions;},
      backupTask:path=>control.backupTask(path),pauseTask:async path=>{await uac.call('DisableTask',path);},
      restoreTaskSetting:async path=>{if(await control.taskRestoreNeeded(path))await uac.call('RestoreTask',path);else await control.restoreTaskSetting(path);},
      startLegacy:async path=>{await uac.call('StartLegacy',path);},stopOwned:(role,identity)=>control.stopOwned(role,identity),
      protectCapability:(path,token)=>control.protectCapability(path,token),unprotectCapability:path=>control.unprotectCapability(path),startOrdinary:()=>control.startOrdinary(),
    }:control,verify:()=>verifyDeployment(stage),now:Date.now,pause:()=>sleep(500),
    async launch(role,runId,extra){
      const started=Date.now();
      const args=role==='broker'?['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',join(root,'bin/desktop-package-broker-task.ps1'),'-ConnectionFile',host.connectionFile,'-ProtectedTokenFile',join(directory,'broker-capability.dpapi'),'-OwnerLeaseFile',join(directory,'broker-owner.json')]:
        [join(root,`bin/lark-chatgpt-${role==='host'?'host':'topics'}.mjs`),role==='host'?snapshot.spec.hostConfigFile:snapshot.spec.topicConfigFile,role==='host'?'--start':'--run'];
      const child=spawn(role==='broker'?'powershell.exe':snapshot.spec.legacy.executable,args,{cwd:host.projectRoot,windowsHide:true,detached:detachOwnedListener(role,extra,directory),stdio:['ignore','ignore','pipe'],env:{...(role==='broker'?windowsPowerShellEnvironment(process.env):cleanDesktopEnvironment(process.env)),...extra}});
      const stderrHash=createHash('sha256');let stderrBytes=0;
      child.stderr?.on('data',(bytes:Buffer)=>{stderrBytes+=bytes.length;stderrHash.update(bytes);});
      child.once('close',(code,signal)=>{void writeFile(join(directory,`${role}.exit.json`),JSON.stringify({version:1,runId,role,pid:child.pid,code,signal,stderrBytes,stderrSha256:stderrHash.digest('hex'),exitedAt:new Date().toISOString()}),{encoding:'utf8',flag:'wx',mode:0o600}).catch(()=>{});});
      children.set(role,child);let error=false;child.on('error',()=>{error=true;});
      const deadline=started+(role==='broker'?30_000:10_000);
      do{
        if(error || child.exitCode!==null || child.signalCode!==null)throw new Error('Runtime child exited during launch');
        const i=await control.inventory();if(i[role].length>1 || i.legacy.length)throw new Error('Runtime launch inventory conflict');
        if(i[role].length===1){
          const identity=i[role][0]!;
          if(Date.parse(identity.createdAt)<started-1000)throw new Error('Runtime role existed before launch');
          if(role==='broker'){
            try{const watched=await json(join(directory,'package-broker-task.status.json')),status=await json(join(directory,'package-broker.status.json'));
              if(watched.phase==='watching' && watched.taskPid===child.pid && watched.runId===runId && sameProcess(watched.brokerIdentity,identity) && status.phase==='ready' && status.runId===runId && status.continuous===true)return identity;
            }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
          }else if(identity.pid===child.pid && identity.parentPid===owner.pid && identity.executable.toLowerCase()===snapshot.spec.legacy.executable.toLowerCase())return identity;
          else throw new Error('Runtime child identity conflict');
        }
        await sleep(200);
      }while(Date.now()<deadline);throw new Error('Runtime launch receipt deadline exceeded');
    },
    async command(args,extra){await exec(snapshot.spec.legacy.executable,[join(root,'bin/lark-chatgpt-host.mjs'),snapshot.spec.hostConfigFile,...args],{windowsHide:true,timeout:100_000,env:{...cleanDesktopEnvironment(process.env),...extra},maxBuffer:64_000});},
    async secret(){
      return new Promise<string>((done,reject)=>{
        const id=`app-${topics.appId}`,child=spawn(snapshot.spec.legacy.executable,[snapshot.spec.legacy.entryPoint,'secrets','get'],{cwd:host.projectRoot,windowsHide:true,env:cleanDesktopEnvironment(process.env),stdio:['pipe','pipe','ignore']});let output='';
        const timer=setTimeout(()=>{child.kill();reject(new Error('Configured credential provider timeout'));},15_000);
        child.on('error',()=>{clearTimeout(timer);reject(new Error('Configured credential provider unavailable'));});
        child.stdout!.on('data',data=>{output+=data;if(output.length>100_000){child.kill();output='';}});
        child.once('exit',code=>{clearTimeout(timer);try{const value=JSON.parse(output).values?.[id];output='';if(code!==0 || typeof value!=='string' || !value)throw new Error();done(value);}catch{reject(new Error('Configured credential unavailable'));}});
        child.stdin!.end(JSON.stringify({protocolVersion:1,provider:'bridge',ids:[id]}));
      });
    },
    shared:owned=>inspectOwnedShared(stage,control,owned),context:(owned,refreshCatalog)=>readOwnedSharedContext(stage,control,owned,true,undefined,refreshCatalog),configurationIdentity:(owned,expected)=>readOwnedSharedIdentity(stage,control,owned,expected),
    locksHeld:async()=>await lockfile.check(host.connectionFile,{realpath:false}) && await lockfile.check(topics.registryFile,{realpath:false}),
    async ordinaryTools(desktop){
      try{await control.testIdentity('desktop',desktop);const pipes=await desktopPipes(desktop.pid,host.desktopExe);let exact=0;
        for(const pipe of pipes){try{const names=await desktopToolCatalog(join(dirname(host.desktopExe),'resources/plugins/openai-bundled/plugins/codex-app-tools'),pipe.pipe);if(JSON.stringify([...names].sort())===JSON.stringify(snapshot.spec.expectedToolNames))exact++;}catch{}}
        await control.testIdentity('desktop',desktop);return exact===1;
      }catch{return false;}
    },
  };
  return new DesktopRuntimePort(input,directory,owner,effects,recovery,channelMode);
}
