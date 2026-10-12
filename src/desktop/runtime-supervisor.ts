import { randomUUID,createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { dirname,isAbsolute,join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareDeployment,verifyDeployment } from './deployment';
import { DesktopSupervisor,SupervisorJournal,sameProcess,type SupervisorState } from './supervisor';
import { createWindowsRuntimePort } from './runtime-port';
import { windowsPowerShellEnvironment,desktopPipes,desktopToolCatalog } from './windows-tools';
import { WindowsSupervisorControl } from './supervisor-windows';
import { writeFileAtomic } from '../platform/atomic-write';
import { TaskUacController } from './task-uac';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),exec=promisify(execFile);
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const json=async(p:string)=>JSON.parse(await readFile(p,'utf8'));
const programs=['bin/lark-chatgpt-runtime-supervisor.mjs','bin/desktop-cold-launch.ps1','dist/desktop-runtime-supervisor.js',
  'bin/desktop-runtime-control.ps1','bin/lark-chatgpt-host.mjs','bin/lark-chatgpt-topics.mjs','bin/desktop-package-broker.ps1','bin/desktop-package-broker-task.ps1'];
export interface ColdRuntimePlan {version:1;mode:'cold';taskControl?:'uac';planId:string;codeRevision:string;createdAt:string;expiresAt:number;stage:string;directory:string;root:string;nodeExecutable:string;files:Array<{path:string;sha256:string}>;exitTimeoutMs:number;windowMs:number}
export async function prepareColdRuntime(sourceStage:string,directory:string,packageRoot=root,taskControl?:'uac'){
  if(![sourceStage,directory,packageRoot].every(isAbsolute) || /["\r\n]/.test(directory+packageRoot))throw new Error('Invalid cold runtime paths');
  const source=await verifyDeployment(sourceStage);
  if(taskControl==='uac'&&source.snapshot.spec.legacy.scheduledTaskName!==`LarkChannelBridge.Bot.${source.snapshot.spec.legacy.profile}`)throw new Error('Task UAC requires the original profile startup task');
  if(taskControl!==undefined && taskControl!=='uac')throw new Error('Unsupported task control mode');
  const required=[source.snapshot.spec.legacy.executable,...[...programs,...(taskControl?['bin/desktop-task-uac.ps1']:[])].map(p=>resolve(packageRoot,p))];
  const files=required.map(path=>{const f=source.snapshot.files.find(f=>f.path===path);if(!f)throw new Error('Cold runtime program missing from source proofs');return f;});
  await mkdir(directory,{recursive:false,mode:0o700});
  const hostFile=join(directory,'host.json'),topicFile=join(directory,'topics.json'),stage=join(directory,'stage');
  const host={...source.host,connectionFile:join(directory,'connection.json')},topics={...source.topics,connectionFile:host.connectionFile};
  for(const [path,value] of [[hostFile,host],[topicFile,topics]] as const)await writeFile(path,JSON.stringify(value,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
  await prepareDeployment({...source.snapshot.spec,hostConfigFile:hostFile,topicConfigFile:topicFile},stage);
  const createdAt=new Date().toISOString();
  const plan:ColdRuntimePlan={version:1,mode:'cold',...(taskControl?{taskControl}:{}),planId:randomUUID(),codeRevision:source.snapshot.spec.codeRevision,createdAt,expiresAt:Date.parse(createdAt)+600_000,
    stage:resolve(stage),directory:resolve(directory),root:resolve(packageRoot),nodeExecutable:source.snapshot.spec.legacy.executable,files,exitTimeoutMs:600_000,windowMs:2_700_000};
  const data=JSON.stringify(plan,null,2)+'\n',path=join(directory,'plan.json');await writeFile(path,data,{encoding:'utf8',flag:'wx',mode:0o600});
  return {planFile:path,planSha256:sha(data),planId:plan.planId,servicesChanged:false,productionReady:false};
}
export async function readColdRuntimePlan(path:string,proof:string,fresh=true):Promise<ColdRuntimePlan>{
  if(!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(proof))throw new Error('Invalid cold plan proof');
  const data=await readFile(path);if(sha(data)!==proof)throw new Error('Cold runtime plan changed');const p=JSON.parse(data.toString('utf8')) as ColdRuntimePlan;
  if(p.version!==1 || p.mode!=='cold' || !/^[a-f0-9-]{36}$/.test(p.planId) || !/^[a-f0-9]{40}$/.test(p.codeRevision)
    || !Number.isFinite(Date.parse(p.createdAt)) || !Number.isSafeInteger(p.expiresAt) || p.expiresAt-Date.parse(p.createdAt)!==600_000
    || p.exitTimeoutMs!==600_000 || p.windowMs!==2_700_000 || ![p.stage,p.directory,p.root,p.nodeExecutable].every(v=>typeof v==='string'&&isAbsolute(v)&&!/["\r\n]/.test(v))
    || resolve(p.directory)!==dirname(resolve(path)) || resolve(p.stage)!==join(resolve(p.directory),'stage')
    || p.taskControl!==undefined&&p.taskControl!=='uac'
    || !Array.isArray(p.files) || p.files.length!==programs.length+1+(p.taskControl?1:0) || new Set(p.files.map(f=>f.path)).size!==p.files.length)throw new Error('Invalid cold runtime plan');
  const required=[p.nodeExecutable,...[...programs,...(p.taskControl?['bin/desktop-task-uac.ps1']:[])].map(f=>resolve(p.root,f))];
  if(required.some(path=>!p.files.some(f=>f.path===path&&/^[a-f0-9]{64}$/.test(f.sha256))))throw new Error('Cold runtime proof incomplete');
  if(fresh && (p.expiresAt<=Date.now() || Date.parse(p.createdAt)>Date.now()+1000))throw new Error('Cold runtime plan expired');
  return {version:1,mode:'cold',...(p.taskControl?{taskControl:p.taskControl}:{}),planId:p.planId,codeRevision:p.codeRevision,createdAt:p.createdAt,expiresAt:p.expiresAt,stage:resolve(p.stage),directory:resolve(p.directory),root:resolve(p.root),nodeExecutable:resolve(p.nodeExecutable),files:p.files.map(f=>({path:f.path,sha256:f.sha256})),exitTimeoutMs:p.exitTimeoutMs,windowMs:p.windowMs};
}
export async function verifyColdRuntimePlan(path:string,proof:string,fresh=true){
  const p=await readColdRuntimePlan(path,proof,fresh),d=await verifyDeployment(p.stage);
  if(d.snapshot.spec.codeRevision!==p.codeRevision || d.host.connectionFile!==join(p.directory,'connection.json') || d.topics.connectionFile!==d.host.connectionFile)throw new Error('Cold runtime source changed');
  for(const f of p.files)if(!d.snapshot.files.some(v=>v.path===f.path&&v.sha256===f.sha256) || sha(await readFile(f.path))!==f.sha256)throw new Error('Cold runtime program changed');
  return p;
}
/** The caller must explicitly select --launch. Preparation/status never arms
 * the services, and a lost/ambiguous launch is never submitted a second time. */
export async function launchColdRuntime(path:string,proof:string,recover=false){
  if(process.platform!=='win32')throw new Error('Cold runtime launch requires Windows');
  const p=await verifyColdRuntimePlan(path,proof,!recover);
  if(!recover){
    const control=await WindowsSupervisorControl.prepare(p.stage,join(p.root,'bin/desktop-runtime-control.ps1'),join(p.directory,'launch-permission-check'));
    const permissions=await control.taskPermissions();
    const inventory=await control.inventory();if(inventory.legacy.length!==1 || !await control.canStopLegacy(inventory.legacy[0]!))throw new Error('Old consumer stop permission unavailable; desktop must remain open');
    await writeFile(join(p.directory,'launch.admission.json'),JSON.stringify({version:1,planId:p.planId,permissions,taskControl:p.taskControl??'direct',requiresAdministratorConsent:p.taskControl==='uac',allowed:p.taskControl==='uac'||permissions.writeAllowed&&permissions.executeAllowed}),{encoding:'utf8',flag:'wx'});
    if(p.taskControl!=='uac'&&(!permissions.writeAllowed || !permissions.executeAllowed))throw new Error('Legacy task permissions unavailable; desktop must remain open');
  }
  if(recover){const s=await json(join(p.directory,'supervisor.json'));if(s.phase==='restored')throw new Error('Completed runtime cannot be recovered');
    if(!await new SupervisorJournal(join(p.directory,'supervisor.json')).waitUntilAvailable(0))throw new Error('Runtime supervisor still owns its journal');}
  const name=recover?'recovery':'launch';await writeFile(join(p.directory,`${name}.intent.json`),JSON.stringify({version:1,planId:p.planId,planSha256:proof,workerMode:recover?'Recover':'Run',requestedAt:Date.now()}),{encoding:'utf8',flag:'wx',mode:0o600});
  try{
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',join(p.root,'bin/desktop-cold-launch.ps1'),'-PlanFile',path,'-PlanSha256',proof,'-WorkerMode',recover?'Recover':'Run'],{windowsHide:true,timeout:25_000,env:windowsPowerShellEnvironment(process.env),encoding:'utf8'});
    const r=JSON.parse(stdout);if(r.version!==1 || r.planId!==p.planId || r.workerMode!==(recover?'Recover':'Run') || !sameProcess(r.identity,r.identity) || r.identity.executable!==p.nodeExecutable
      || Date.parse(r.identity.createdAt)<Date.parse(p.createdAt)-1000 || Date.parse(r.identity.createdAt)>Date.now()+1000)throw new Error('Cold launch receipt invalid');
    const identity=r.identity;
    return {version:1,planId:p.planId,workerMode:r.workerMode,identity:{pid:identity.pid,parentPid:identity.parentPid,createdAt:identity.createdAt,executable:identity.executable,commandLineSha256:identity.commandLineSha256}};
  }catch{await writeFileAtomic(join(p.directory,`${name}.failure.json`),JSON.stringify({version:1,planId:p.planId,phase:'uncertain',errorCode:'native_runtime_launch_not_confirmed'}));throw new Error('Cold runtime launch uncertain; never repeat this plan');}
}
export async function runColdRuntime(path:string,proof:string,recover=false){
  const p=await verifyColdRuntimePlan(path,proof,!recover);
  await writeFile(join(p.directory,recover?'recovery.worker.intent.json':'worker.intent.json'),JSON.stringify({version:1,planId:p.planId,recover}),{encoding:'utf8',flag:'wx',mode:0o600});
  const saved=recover?await json(join(p.directory,'supervisor.json')) as SupervisorState:undefined;
  if(!recover){try{await readFile(join(p.directory,'supervisor.json'));throw new Error('Existing runtime journal requires recovery');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  const startedAt=Date.now(),windowMs=recover?600_000:p.windowMs,deadline=startedAt+windowMs,testingStopsAt=recover?startedAt:p.taskControl?deadline-600_000:deadline;
  await writeFile(join(p.directory,recover?'recovery.window.json':'runtime.window.json'),JSON.stringify({version:1,planId:p.planId,startedAt,leaseExpiresAt:deadline,testingStopsAt,windowMs,recoveryOnly:recover}),{encoding:'utf8',flag:'wx'});
  const port=await createWindowsRuntimePort(p.stage,p.directory,p.root,saved,p.taskControl?{planId:p.planId,deadline,forwardDeadline:testingStopsAt}:undefined),deployment=await verifyDeployment(p.stage);
  let stopped=false;const stop=()=>{stopped=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{
    const state=await new DesktopSupervisor(new SupervisorJournal(join(p.directory,'supervisor.json')),port,deployment.snapshot.bindings).run(async()=>{
      if(stopped || Date.now()>=testingStopsAt)return true;try{await readFile(join(p.directory,'stop.request'));return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}
    },()=>new Promise<void>(done=>setTimeout(done,500)),{startMode:'cold',exitTimeoutMs:p.exitTimeoutMs});
    await writeFileAtomic(join(p.directory,recover?'recovery.result.json':'runtime.result.json'),JSON.stringify({version:1,planId:p.planId,runId:state.runId,phase:state.phase,errorCode:state.errorCode,rollbackErrorCode:state.rollbackErrorCode,completedAt:new Date().toISOString(),runtimeActivated:!!state.owned.listener,coldExitObserved:!!state.lastColdExitProof,ordinaryRestoreVerified:!!state.ordinaryProof,productionReady:false}));
    return state.phase==='restored' && !state.rollbackErrorCode && (recover||!state.errorCode) ? 0 : 2;
  }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);await port.close();}
}
export async function preflightColdRuntime(path:string,proof:string){
  const p=await verifyColdRuntimePlan(path,proof),d=await verifyDeployment(p.stage),evidence=join(p.directory,'preflight');
  const control=await WindowsSupervisorControl.prepare(p.stage,join(p.root,'bin/desktop-runtime-control.ps1'),evidence);
  const before=await control.inventory();
  if(before.legacy.length!==1 || before.desktop.length!==1 || before.host.length || before.listener.length || before.broker.length)throw new Error('Runtime preflight inventory conflict');
  await control.testIdentity('legacy',before.legacy[0]!);await control.testIdentity('desktop',before.desktop[0]!);
  const backup=await control.backupTask(join(evidence,'legacy-backup'));
  const taskPermissions=await control.taskPermissions();
  const legacyStopAllowed=await control.canStopLegacy(before.legacy[0]!);
  const cold=await control.coldSnapshot();
  const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"[bool](Get-Command Invoke-CommandInDesktopPackage -ErrorAction SilentlyContinue)"],{windowsHide:true,env:windowsPowerShellEnvironment(process.env),encoding:'utf8',timeout:15_000});
  const packageCommandAvailable=stdout.trim()==='True';let exact=0;
  for(const pipe of await desktopPipes(before.desktop[0]!.pid,d.host.desktopExe)){
    try{const names=await desktopToolCatalog(join(dirname(d.host.desktopExe),'resources/plugins/openai-bundled/plugins/codex-app-tools'),pipe.pipe);if(JSON.stringify([...names].sort())===JSON.stringify(d.snapshot.spec.expectedToolNames))exact++;}catch{}
  }
  const after=await control.inventory(),current=await verifyDeployment(p.stage);
  const unchanged=(['legacy','desktop','host','listener','broker'] as const).every(role=>before[role].length===after[role].length && before[role].every(v=>after[role].some(w=>sameProcess(v,w))))
    && d.ledgers.every(l=>current.ledgers.some(n=>n.file===l.file && n.sha256===l.sha256));
  const report={version:1,planId:p.planId,observedAt:new Date().toISOString(),packageCommandAvailable,exactToolCatalogs:exact,expectedToolCount:d.snapshot.spec.expectedToolNames.length,
    legacyTaskBackedUp:true,legacyTaskEnabled:backup.enabled,taskPermissions,taskControl:p.taskControl??'direct',requiresAdministratorConsent:p.taskControl==='uac',
    legacyStopAllowed,candidateForTaskUacWindow:p.taskControl==='uac'&&packageCommandAvailable&&exact===1&&unchanged&&legacyStopAllowed,
    readyForColdWindow:p.taskControl!=='uac'&&packageCommandAvailable&&exact===1&&unchanged&&legacyStopAllowed&&taskPermissions.writeAllowed&&taskPermissions.executeAllowed,desktopRelatedCount:cold.desktopRelated.length,originalProcessesAndLedgersUnchanged:unchanged,
    servicesChanged:false,productionReady:false,coldExitVerified:false,packageActivationTested:false,credentialProviderRead:false};
  await writeFile(join(evidence,'summary.json'),JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
  return report;
}
export async function runtimeSupervisorMain(){
  const [mode,path,proof,...extra]=process.argv.slice(2);
  if(!path || !proof || extra.length || !['--launch','--run','--launch-recovery','--recover','--preflight','--task-uac-probe','--status','--stop'].includes(mode??''))throw new Error('Invalid runtime supervisor arguments');
  if(mode==='--launch'||mode==='--launch-recovery')console.log(JSON.stringify(await launchColdRuntime(path,proof,mode==='--launch-recovery')));
  else if(mode==='--run'||mode==='--recover')process.exitCode=await runColdRuntime(path,proof,mode==='--recover');
  else if(mode==='--preflight')console.log(JSON.stringify(await preflightColdRuntime(path,proof),null,2));
  else if(mode==='--task-uac-probe'){
    const p=await verifyColdRuntimePlan(path,proof);if(p.taskControl!=='uac')throw new Error('Task UAC probe requires an explicit scoped plan');
    const control=await WindowsSupervisorControl.prepare(p.stage,join(p.root,'bin/desktop-runtime-control.ps1'),join(p.directory,`task-uac-probe-control-${process.pid}`),true),original=await verifyDeployment(p.stage);
    const owner=await control.ownerIdentity(process.pid),before=await control.inventory();
    if(before.desktop.length!==1||before.legacy.length!==1||before.host.length||before.listener.length||before.broker.length)throw new Error('Task UAC probe inventory conflict');
    const permissions=await new TaskUacController(p.stage,p.directory,p.root,owner,p.planId,Date.now()+120_000,control).call('TaskPermissions');
    const after=await control.inventory(),current=await verifyDeployment(p.stage);if(JSON.stringify(before)!==JSON.stringify(after) || original.ledgers.some(l=>!current.ledgers.some(n=>l.file===n.file&&l.sha256===n.sha256)))throw new Error('Task UAC probe inventory or ledgers changed');
    const report={planId:p.planId,permissions,originalProcessesAndLedgersUnchanged:true,servicesChanged:false,productionReady:false};
    await writeFile(join(p.directory,`task-uac-probe-${process.pid}.json`),JSON.stringify(report),{encoding:'utf8',flag:'wx'});console.log(JSON.stringify(report));
  }
  else{
    const p=await readColdRuntimePlan(path,proof,false);
    if(mode==='--stop'){await writeFile(join(p.directory,'stop.request'),'Human requested runtime stop',{encoding:'utf8',flag:'wx'});console.log(JSON.stringify({stopRequested:true,planId:p.planId}));}
    else{let state;try{state=await json(join(p.directory,'supervisor.json'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      console.log(JSON.stringify({planId:p.planId,phase:state?.phase??'not_started',runId:state?.runId,errorCode:state?.errorCode,rollbackErrorCode:state?.rollbackErrorCode,updatedAt:state?.updatedAt,historical:true,productionReady:false}));}
  }
}
