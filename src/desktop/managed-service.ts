import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import lockfile from 'proper-lockfile';
import {verifyDeployment} from './deployment';
import {prepareColdRuntime,launchColdRuntime,verifyColdRuntimePlan} from './runtime-supervisor';
import {writeFileAtomic} from '../platform/atomic-write';
import {WindowsSupervisorControl} from './supervisor-windows';
import {sameProcess,validRetirementProof} from './supervisor';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {windowsPowerShellEnvironment} from './windows-tools';

const sha=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
export interface ManagedServiceManifest {
  version:1; serviceId:string; serviceMode:'stop-with-desktop'; channelMode:'new-only';
  sourceStage:string; sourceSha256:string; directory:string; root:string; nodeExecutable:string;
  codeRevision:string; scope?:'registered-topics'; enabledChatIds?:string[]; allowTopicCreation:boolean;
}
/** Preparation is read-only with respect to services and original business
 * files. Each invocation later creates a fresh expiring one-shot cold plan. */
export async function prepareManagedService(sourceStage:string,directory:string,root:string){
  if(![sourceStage,directory,root].every(isAbsolute) || /["\r\n]/.test(sourceStage+directory+root))throw new Error('Invalid service paths');
  const d=await verifyDeployment(sourceStage);
  if(d.host.desktopQuitPolicy || (d.snapshot.spec.scope==='registered-topics'
    ? d.topics.enabledChatIds!==undefined || d.topics.allowTopicCreation!==true
    : d.topics.allowTopicCreation!==false || !d.topics.enabledChatIds?.length))throw new Error('Service requires an explicit existing group or registered-topic scope');
  if(!d.snapshot.files.some(f=>f.path===join(root,'bin/desktop-service-start.ps1')))throw new Error('Service startup program missing from source proofs');
  await mkdir(directory,{recursive:false,mode:0o700});
  const manifest:ManagedServiceManifest={version:1,serviceId:randomUUID(),serviceMode:'stop-with-desktop',channelMode:'new-only',
    sourceStage:resolve(sourceStage),sourceSha256:sha(await readFile(join(sourceStage,'manifest.json'))),directory:resolve(directory),root:resolve(root),
    nodeExecutable:d.snapshot.spec.legacy.executable,codeRevision:d.snapshot.spec.codeRevision,
    ...(d.snapshot.spec.scope==='registered-topics'?{scope:'registered-topics' as const,allowTopicCreation:true}:{enabledChatIds:[...d.topics.enabledChatIds!],allowTopicCreation:false})};
  const path=join(directory,'service.json'),bytes=JSON.stringify(manifest,null,2)+'\n';
  await writeFile(path,bytes,{encoding:'utf8',flag:'wx',mode:0o600});
  return {manifestFile:path,manifestSha256:sha(bytes),servicesChanged:false,startupInstalled:false};
}
export async function readManagedService(path:string,proof:string){
  if(!isAbsolute(path)||!/^[a-f0-9]{64}$/.test(proof))throw new Error('Invalid service proof');
  const bytes=await readFile(path);if(sha(bytes)!==proof)throw new Error('Service manifest changed');
  const m=JSON.parse(bytes.toString('utf8')) as ManagedServiceManifest;
  if(m.version!==1 || !/^[a-f0-9-]{36}$/.test(m.serviceId) || m.serviceMode!=='stop-with-desktop' || m.channelMode!=='new-only'
    || !/^[a-f0-9]{64}$/.test(m.sourceSha256) || !/^[a-f0-9]{40}$/.test(m.codeRevision)
    || (m.scope==='registered-topics' ? m.allowTopicCreation!==true || m.enabledChatIds!==undefined
      : m.scope!==undefined || m.allowTopicCreation!==false || !Array.isArray(m.enabledChatIds) || !m.enabledChatIds.length || m.enabledChatIds.some(id=>typeof id!=='string'||!id) || new Set(m.enabledChatIds).size!==m.enabledChatIds.length)
    || ![m.sourceStage,m.directory,m.root,m.nodeExecutable].every(p=>typeof p==='string'&&isAbsolute(p)&&!/["\r\n]/.test(p)) || resolve(m.directory)!==dirname(resolve(path)))throw new Error('Invalid managed service manifest');
  if(sha(await readFile(join(m.sourceStage,'manifest.json')))!==m.sourceSha256)throw new Error('Service source manifest changed');
  const d=await verifyDeployment(m.sourceStage);
  if(d.snapshot.spec.codeRevision!==m.codeRevision || d.snapshot.spec.legacy.executable!==m.nodeExecutable || d.topics.allowTopicCreation!==m.allowTopicCreation || d.snapshot.spec.scope!==m.scope
    || JSON.stringify(d.topics.enabledChatIds)!==JSON.stringify(m.enabledChatIds) || d.host.desktopQuitPolicy)throw new Error('Service scope or source changed');
  if(!d.snapshot.files.some(f=>f.path===join(m.root,'bin/desktop-service-start.ps1')))throw new Error('Service startup proof missing');
  return m;
}
export async function managedServiceShortcuts(path:string,proof:string,checkOnly=true){
  if(process.platform!=='win32')throw new Error('Service shortcuts require Windows');
  const m=await readManagedService(path,proof),d=await verifyDeployment(m.sourceStage),script=join(m.root,'bin/desktop-service-shortcuts.ps1');
  if(!d.snapshot.files.some(f=>f.path===script))throw new Error('Shortcut program missing from source proofs');
  const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',script,'-ManifestFile',path,'-ManifestSha256',proof,...(checkOnly?['-CheckOnly']:[])],{windowsHide:true,env:windowsPowerShellEnvironment(process.env),encoding:'utf8',timeout:25_000});
  const r=JSON.parse(stdout);
  if(r.version!==1 || r.serviceId!==m.serviceId || r.checkOnly!==checkOnly || r.startupInstalled!==!checkOnly || r.legacyTaskChanged!==false || r.servicesStarted!==false || !Array.isArray(r.paths) || r.paths.length!==2)throw new Error('Shortcut settings unconfirmed');
  await writeFileAtomic(join(m.directory,checkOnly?'shortcuts.preflight.json':'shortcuts.installed.json'),JSON.stringify(r));
  return r;
}
/** A new entry may follow a fully restored health failure after fresh admission.
 * It never resumes a failed forward launch or replays a model input. */
export async function launchManagedService(path:string,proof:string){
  const m=await readManagedService(path,proof);
  const release=await lockfile.lock(join(m.directory,'service-launch'),{realpath:false,retries:0,stale:10_000});
  let releasePrevious:(()=>Promise<void>)|undefined;
  try{
    let previous:any,reentry:any;
    try{previous=await json(join(m.directory,'active-run.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    if(previous){
      if(previous.version!==1 || previous.serviceId!==m.serviceId || !isAbsolute(previous.planFile) || dirname(dirname(previous.planFile))!==join(m.directory,'runs'))throw new Error('Service previous run pointer invalid');
      const p=await verifyColdRuntimePlan(previous.planFile,previous.planSha256,false);
      if(p.serviceMode!==m.serviceMode || p.codeRevision!==m.codeRevision || p.serviceAcceptanceWindow)throw new Error('Previous service policy changed');
      // Hold the previous journal's writer lock through pointer publication.
      // A stale availability observation alone cannot authorize a new run.
      releasePrevious=await lockfile.lock(join(p.directory,'supervisor.json'),{realpath:false,retries:0,stale:10_000});
      const stateBytes=await readFile(join(p.directory,'supervisor.json')),resultBytes=await readFile(join(p.directory,'runtime.result.json'));
      const s=JSON.parse(stateBytes.toString('utf8')),r=JSON.parse(resultBytes.toString('utf8'));
      const restoredHealthFailure=s.phase==='restored' && s.errorCode==='runtime_health_failed' && r.errorCode===s.errorCode
        && s.channelMode==='new-only' && s.serviceMode==='stop-with-desktop' && s.startMode==='cold'
        && r.channelMode===s.channelMode && r.serviceMode===s.serviceMode && r.ordinaryRestoreVerified===true
        && s.ordinaryProof?.packageIdentityVerified===true && s.ordinaryProof.toolsExact===true
        && sameProcess(s.ordinaryProof.desktop,s.ordinaryProof.desktop)
        && validRetirementProof(s.newBaseline?.retirement);
      if(!['restored','closed'].includes(s.phase) || r.phase!==s.phase || r.planId!==p.planId || !/^[a-f0-9-]{36}$/.test(s.runId) || r.runId!==s.runId
        || s.rollbackErrorCode || r.rollbackErrorCode || (s.errorCode || r.errorCode) && !restoredHealthFailure
        || r.messageServicePaused!==true || r.legacyRecoveryAllowed!==false || s.phase==='closed' && (s.desktopQuitVerified!==true||r.desktopQuitVerified!==true)){
        throw Object.assign(new Error('Previous service run requires independent reconciliation'),{code:'service_previous_run_unresolved'});
      }
      if(restoredHealthFailure)reentry={version:1,previousPlanFile:previous.planFile,previousPlanSha256:previous.planSha256,
        previousRunId:s.runId,stateSha256:sha(stateBytes),resultSha256:sha(resultBytes),previousErrorCode:s.errorCode,
        retirement:s.newBaseline.retirement,ordinaryRestoreWasVerified:true};
    }
    const control=await WindowsSupervisorControl.prepare(m.sourceStage,join(m.root,'bin/desktop-runtime-control.ps1'),join(m.directory,`entry-check-${randomUUID()}`),false,false);
    const i=await control.inventory(),retirement=await control.legacyRetirement();
    if(i.legacy.length || i.desktop.length>1 || i.host.length || i.listener.length || i.broker.length || !validRetirementProof(retirement)
      || retirement.observedAt>Date.now()+1000 || Date.now()-retirement.observedAt>60_000)throw new Error('Service entry inventory or retirement unavailable');
    if(reentry && (retirement.taskPresent!==reentry.retirement.taskPresent || retirement.definitionSha256!==reentry.retirement.definitionSha256))throw new Error('Previous service retirement policy changed');
    // Full empty native inventory is still required by the worker twice before
    // broker/host launch. An existing ordinary UI is observed, never closed.
    const runs=join(m.directory,'runs');await mkdir(runs,{recursive:true,mode:0o700});
    const prepared=await prepareColdRuntime(m.sourceStage,join(runs,randomUUID()),m.root,undefined,'new-only',{mode:m.serviceMode});
    if(reentry)await writeFile(join(dirname(prepared.planFile),'previous-run-reentry.json'),JSON.stringify({...reentry,observedAt:Date.now(),
      freshRetirement:retirement,noPriorChannelProcesses:true,previousEvidencePreserved:true,messageReplayAllowed:false}),{encoding:'utf8',flag:'wx',mode:0o600});
    await writeFileAtomic(join(m.directory,'active-run.json'),JSON.stringify({version:1,serviceId:m.serviceId,planFile:prepared.planFile,planSha256:prepared.planSha256,requestedAt:Date.now()}));
    return await launchColdRuntime(prepared.planFile,prepared.planSha256);
  }finally{try{await releasePrevious?.();}finally{await release();}}
}
