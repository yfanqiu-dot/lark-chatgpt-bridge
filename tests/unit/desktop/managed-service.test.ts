import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import lockfile from 'proper-lockfile';
const mock=vi.hoisted(()=>({verify:vi.fn(),prepare:vi.fn(),launch:vi.fn(),plan:vi.fn(),control:vi.fn()}));
vi.mock('../../../src/desktop/deployment',()=>({verifyDeployment:mock.verify}));
vi.mock('../../../src/desktop/runtime-supervisor',()=>({prepareColdRuntime:mock.prepare,launchColdRuntime:mock.launch,verifyColdRuntimePlan:mock.plan}));
vi.mock('../../../src/desktop/supervisor-windows',()=>({WindowsSupervisorControl:{prepare:mock.control}}));
import {prepareManagedService,readManagedService,launchManagedService} from '../../../src/desktop/managed-service';
const sha=(data:string|Buffer)=>createHash('sha256').update(data).digest('hex');
let root:string,source:string,service:string,d:any,inventory:any,bootAt:string,machineSha256:string;
const originalRunId='11111111-1111-4111-8111-111111111111';
beforeEach(async()=>{
  vi.resetAllMocks();bootAt=new Date(Date.now()-3600_000).toISOString();machineSha256='e'.repeat(64);root=await mkdtemp(join(tmpdir(),'managed-service-'));source=join(root,'source');service=join(root,'service');await mkdir(source);await writeFile(join(source,'manifest.json'),'TEST_SOURCE','utf8');
  d={host:{},topics:{enabledChatIds:['oc_original_c'],allowTopicCreation:false},snapshot:{files:[{path:join(root,'bin/desktop-service-start.ps1')}],spec:{codeRevision:'a'.repeat(40),legacy:{executable:process.execPath}}}};
  mock.verify.mockImplementation(async()=>d);inventory={legacy:[],desktop:[],host:[],listener:[],broker:[]};
  mock.control.mockResolvedValue({systemBoot:async()=>({version:1,bootedAt:bootAt,machineSha256,observedAt:Date.now()}),inventory:async()=>inventory,legacyRetirement:async()=>({version:1,observedAt:Date.now(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)})});
  mock.prepare.mockImplementation(async(_source,dir)=>{await mkdir(dir);return {planFile:join(dir,'plan.json'),planSha256:'c'.repeat(64)};});mock.launch.mockResolvedValue({identity:{pid:99}});
});
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true});});
const prepare=()=>prepareManagedService(source,service,root);
it('prepares a sealed existing-group service without launching services or installing startup',async()=>{
  const p=await prepare();expect(await readManagedService(p.manifestFile,p.manifestSha256)).toMatchObject({serviceMode:'stop-with-desktop',enabledChatIds:['oc_original_c'],allowTopicCreation:false});expect(p.startupInstalled).toBe(false);expect(mock.launch).not.toHaveBeenCalled();await expect(prepare()).rejects.toThrow();
});
it('seals and launches explicit registered-topic scope, rejecting later policy changes',async()=>{
  d.snapshot.spec.scope='registered-topics';d.topics={allowTopicCreation:true};
  const p=await prepare(),m=await readManagedService(p.manifestFile,p.manifestSha256);
  expect(m).toMatchObject({scope:'registered-topics',allowTopicCreation:true});expect(m.enabledChatIds).toBeUndefined();
  await launchManagedService(p.manifestFile,p.manifestSha256);expect(mock.launch).toHaveBeenCalledOnce();
  d.topics.enabledChatIds=['oc_c'];await expect(readManagedService(p.manifestFile,p.manifestSha256)).rejects.toThrow('scope');
});
it('does not infer registered-topic permission from a missing group list',async()=>{
  d.topics={allowTopicCreation:true};await expect(prepare()).rejects.toThrow('scope');expect(mock.launch).not.toHaveBeenCalled();
});
it.each(['mode','scope','source','node','creation'])('rejects changed %s before creating a runtime',async condition=>{
  const p=await prepare(),m=JSON.parse(await readFile(p.manifestFile,'utf8'));
  if(condition==='mode')m.serviceMode='auto-reopen';if(condition==='scope')m.enabledChatIds.push('oc_new');if(condition==='source')m.sourceSha256='0'.repeat(64);if(condition==='node')m.nodeExecutable=join(root,'foreign.exe');if(condition==='creation')m.allowTopicCreation=true;
  const data=JSON.stringify(m);await writeFile(p.manifestFile,data,'utf8');await expect(launchManagedService(p.manifestFile,sha(data))).rejects.toThrow();expect(mock.prepare).not.toHaveBeenCalled();expect(mock.launch).not.toHaveBeenCalled();
});
it('uses a fresh one-shot run and retains its pointer before native launch',async()=>{
  const p=await prepare();mock.launch.mockImplementation(async(planFile:string,proof:string)=>{const active=JSON.parse(await readFile(join(service,'active-run.json'),'utf8'));expect(active).toMatchObject({planFile,planSha256:proof});return {identity:{pid:99}};});
  expect(await launchManagedService(p.manifestFile,p.manifestSha256)).toMatchObject({identity:{pid:99}});expect(mock.prepare.mock.calls[0]![5]).toEqual({mode:'stop-with-desktop'});expect(mock.launch).toHaveBeenCalledOnce();
});
it('refuses a second entry after an ambiguous native creation without replay or a second plan',async()=>{
  const p=await prepare();mock.launch.mockRejectedValue(Error('private native error'));await expect(launchManagedService(p.manifestFile,p.manifestSha256)).rejects.toThrow();
  mock.plan.mockRejectedValue(Error('unresolved'));await expect(launchManagedService(p.manifestFile,p.manifestSha256)).rejects.toThrow();expect(mock.prepare).toHaveBeenCalledOnce();expect(mock.launch).toHaveBeenCalledOnce();
});
it('refuses concurrent entry while the original launch lock is live',async()=>{
  const p=await prepare(),release=await lockfile.lock(join(service,'service-launch'),{realpath:false,retries:0});
  try{await expect(launchManagedService(p.manifestFile,p.manifestSha256)).rejects.toThrow();expect(mock.prepare).not.toHaveBeenCalled();}finally{await release();}
});
it.each(['legacy','host','listener','broker','desktop'])('refuses %s inventory conflicts before a plan or native launch',async role=>{
  const p=await prepare();inventory[role]=role==='desktop'?[{pid:1},{pid:2}]:[{pid:1}];await expect(launchManagedService(p.manifestFile,p.manifestSha256)).rejects.toThrow('inventory');expect(mock.prepare).not.toHaveBeenCalled();expect(mock.launch).not.toHaveBeenCalled();
});
it.each(['running','missing-result','fault','wrong-run'])('keeps %s prior evidence and blocks automatic restart',async condition=>{
  const p=await prepare();await launchManagedService(p.manifestFile,p.manifestSha256);const previous=JSON.parse(await readFile(join(service,'active-run.json'),'utf8')),dir=dirname(previous.planFile);
  mock.plan.mockResolvedValue({serviceMode:'stop-with-desktop',codeRevision:'a'.repeat(40),directory:dir,planId:'original-plan'});
  const state={phase:condition==='running'?'running':'closed',runId:originalRunId,desktopQuitVerified:true,...(condition==='fault'?{errorCode:'fault'}:{})};await writeFile(join(dir,'supervisor.json'),JSON.stringify(state),'utf8');
  if(condition!=='missing-result')await writeFile(join(dir,'runtime.result.json'),JSON.stringify({...state,planId:'original-plan',runId:condition==='wrong-run'?'foreign-run':originalRunId,messageServicePaused:true,legacyRecoveryAllowed:false}),'utf8');
  const bytes=await readFile(join(service,'active-run.json'));await expect(launchManagedService(p.manifestFile,p.manifestSha256)).rejects.toThrow();expect(await readFile(join(service,'active-run.json'))).toEqual(bytes);expect(mock.launch).toHaveBeenCalledOnce();
});
it('allows an explicitly invoked new entry after a clean closed run, with a different run directory',async()=>{
  const p=await prepare();await launchManagedService(p.manifestFile,p.manifestSha256);const previous=JSON.parse(await readFile(join(service,'active-run.json'),'utf8')),dir=dirname(previous.planFile);
  mock.plan.mockResolvedValue({serviceMode:'stop-with-desktop',codeRevision:'a'.repeat(40),directory:dir,planId:'original-plan'});
  const state={phase:'closed',runId:originalRunId,desktopQuitVerified:true};await writeFile(join(dir,'supervisor.json'),JSON.stringify(state),'utf8');await writeFile(join(dir,'runtime.result.json'),JSON.stringify({...state,planId:'original-plan',messageServicePaused:true,legacyRecoveryAllowed:false}),'utf8');
  await launchManagedService(p.manifestFile,p.manifestSha256);expect(mock.prepare).toHaveBeenCalledTimes(2);expect(mock.prepare.mock.calls[0]![1]).not.toBe(mock.prepare.mock.calls[1]![1]);
});

async function restoredHealthFailure(){
  const p=await prepare();await launchManagedService(p.manifestFile,p.manifestSha256);
  const pointerFile=join(service,'active-run.json'),pointerBytes=await readFile(pointerFile),previous=JSON.parse(pointerBytes.toString('utf8')),dir=dirname(previous.planFile);
  mock.plan.mockResolvedValue({serviceMode:'stop-with-desktop',codeRevision:'a'.repeat(40),directory:dir,planId:'original-plan'});
  const retirement={version:1,observedAt:Date.now(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)};
  const desktop={pid:10,parentPid:1,createdAt:'2026-01-01T00:00:00Z',executable:process.execPath,commandLineSha256:'d'.repeat(64)};
  const state:any={phase:'restored',startMode:'cold',channelMode:'new-only',serviceMode:'stop-with-desktop',runId:originalRunId,errorCode:'runtime_health_failed',newBaseline:{retirement},ordinaryProof:{desktop,packageIdentityVerified:true,toolsExact:true}};
  const result:any={phase:'restored',channelMode:'new-only',serviceMode:'stop-with-desktop',runId:originalRunId,planId:'original-plan',errorCode:'runtime_health_failed',ordinaryRestoreVerified:true,messageServicePaused:true,legacyRecoveryAllowed:false};
  const save=async()=>{await writeFile(join(dir,'supervisor.json'),JSON.stringify(state),'utf8');await writeFile(join(dir,'runtime.result.json'),JSON.stringify(result),'utf8');};
  await save();return {p,dir,state,result,save,pointerFile,pointerBytes};
}
it('reenters a fully restored health failure once, preserving original evidence and sealing a fresh admission record',async()=>{
  const h=await restoredHealthFailure(),oldState=await readFile(join(h.dir,'supervisor.json')),oldResult=await readFile(join(h.dir,'runtime.result.json'));
  await launchManagedService(h.p.manifestFile,h.p.manifestSha256);
  expect(await readFile(join(h.dir,'supervisor.json'))).toEqual(oldState);expect(await readFile(join(h.dir,'runtime.result.json'))).toEqual(oldResult);
  const active=JSON.parse(await readFile(h.pointerFile,'utf8'));expect(dirname(active.planFile)).not.toBe(h.dir);
  const evidence=JSON.parse(await readFile(join(dirname(active.planFile),'previous-run-reentry.json'),'utf8'));
  expect(evidence).toMatchObject({previousRunId:originalRunId,stateSha256:sha(oldState),resultSha256:sha(oldResult),previousErrorCode:'runtime_health_failed',noPriorChannelProcesses:true,previousEvidencePreserved:true,messageReplayAllowed:false});
  expect(mock.launch).toHaveBeenCalledTimes(2);
});
it('permits a new admission after a fully restored, explicitly classified startup busy timeout',async()=>{
  const h=await restoredHealthFailure();h.state.errorCode=h.result.errorCode='shared_admission_busy_timeout';await h.save();
  await launchManagedService(h.p.manifestFile,h.p.manifestSha256);expect(mock.launch).toHaveBeenCalledTimes(2);
});
it.each(['restore-unverified','wrong-policy','wrong-run','rollback-failed','other-error','invalid-identity','retirement-changed','listener-live','journal-owned'])('blocks failed-run reentry when %s, retaining its original pointer',async condition=>{
  const h=await restoredHealthFailure();let release:(()=>Promise<void>)|undefined;
  if(condition==='restore-unverified')h.result.ordinaryRestoreVerified=false;
  if(condition==='wrong-policy')h.state.channelMode='legacy-rollback';
  if(condition==='wrong-run')h.result.runId='22222222-2222-4222-8222-222222222222';
  if(condition==='rollback-failed')h.state.rollbackErrorCode='rollback_failed';
  if(condition==='other-error')h.state.errorCode=h.result.errorCode='listener_start_unconfirmed';
  if(condition==='invalid-identity')h.state.ordinaryProof.desktop.pid=0;
  if(condition==='retirement-changed')h.state.newBaseline.retirement.definitionSha256='f'.repeat(64);
  if(condition==='listener-live')inventory.listener=[{pid:20}];
  await h.save();
  if(condition==='journal-owned')release=await lockfile.lock(join(h.dir,'supervisor.json'),{realpath:false,retries:0});
  try{await expect(launchManagedService(h.p.manifestFile,h.p.manifestSha256)).rejects.toThrow();expect(await readFile(h.pointerFile)).toEqual(h.pointerBytes);expect(mock.launch).toHaveBeenCalledOnce();}
  finally{await release?.();}
});
it('does not retry a fresh ambiguous launch after successful old-run reentry admission',async()=>{
  const h=await restoredHealthFailure();mock.launch.mockRejectedValueOnce(Error('native creation unconfirmed'));
  await expect(launchManagedService(h.p.manifestFile,h.p.manifestSha256)).rejects.toThrow('unconfirmed');
  mock.plan.mockRejectedValueOnce(Error('unresolved fresh plan'));
  await expect(launchManagedService(h.p.manifestFile,h.p.manifestSha256)).rejects.toThrow();expect(mock.prepare).toHaveBeenCalledTimes(2);expect(mock.launch).toHaveBeenCalledTimes(2);
});

async function interruptedBoot(missingResult=false){
  const h=await restoredHealthFailure(),at=Date.now();
  Object.assign(h.state,{version:1,revision:10,updatedAt:new Date(at).toISOString(),phase:'blocked',legacyPauseAttempted:false,desktopCloseAttempted:false,owned:{},rollbackErrorCode:'rollback_operation_failed'});
  Object.assign(h.result,{version:1,phase:'blocked',completedAt:new Date(at).toISOString(),ordinaryRestoreVerified:false,messageServicePaused:null,rollbackErrorCode:'rollback_operation_failed'});
  await h.save();if(missingResult)await rm(join(h.dir,'runtime.result.json'));
  mock.plan.mockResolvedValue({serviceMode:'stop-with-desktop',codeRevision:'a'.repeat(40),directory:h.dir,planId:'original-plan',mode:'cold',channelMode:'new-only',createdAt:new Date(at).toISOString()});
  bootAt=new Date(at+60_000).toISOString();vi.spyOn(Date,'now').mockReturnValue(at+120_000);
  return h;
}
it.each([false,true])('admits a fresh plan on a proven new boot, preserving failed cleanup and missing-result=%s evidence',async missing=>{
  const h=await interruptedBoot(missing),old=await readFile(join(h.dir,'supervisor.json'));
  await launchManagedService(h.p.manifestFile,h.p.manifestSha256);
  const active=JSON.parse(await readFile(h.pointerFile,'utf8')),dir=dirname(active.planFile);
  const evidence=JSON.parse(await readFile(join(dir,'previous-run-reentry.json'),'utf8'));
  expect(evidence).toMatchObject({reason:'previous_windows_boot',previousRollbackErrorCode:'rollback_operation_failed',resultAbsent:missing,messageReplayAllowed:false,ordinaryRestoreWasVerified:false});
  expect(await readFile(join(h.dir,'supervisor.json'))).toEqual(old);
  const boot=await readFile(join(dir,'service-boot.json'));expect(sha(boot)).toBe(active.bootProofSha256);
  expect(mock.launch).toHaveBeenCalledTimes(2);
});
it('admits an interrupted running generation on a new boot without inventing a terminal result',async()=>{
  const h=await interruptedBoot(true);h.state.phase='running';delete h.state.errorCode;delete h.state.rollbackErrorCode;
  await writeFile(join(h.dir,'supervisor.json'),JSON.stringify(h.state),'utf8');
  await launchManagedService(h.p.manifestFile,h.p.manifestSha256);
  const pointer=JSON.parse(await readFile(h.pointerFile,'utf8'));
  expect(JSON.parse(await readFile(join(dirname(pointer.planFile),'previous-run-reentry.json'),'utf8'))).toMatchObject({reason:'previous_windows_boot',resultAbsent:true,previousErrorCode:null,previousRollbackErrorCode:null});
  await expect(readFile(join(h.dir,'runtime.result.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it.each(['same-boot','different-machine','changed-proof','missing-proof','invalid-proof','future-proof','wrong-run','malformed-result','new-journal','live-role','retirement-changed','ledger-uncertain','boot-changed'])('refuses cross-boot recovery with %s and retains original evidence',async condition=>{
  const h=await interruptedBoot();
  const bootFile=join(h.dir,'service-boot.json'),record=JSON.parse(await readFile(bootFile,'utf8')),pointer=JSON.parse(h.pointerBytes.toString('utf8'));
  if(condition==='same-boot')bootAt=record.boot.bootedAt;
  if(condition==='different-machine')machineSha256='f'.repeat(64);
  if(condition==='changed-proof')await writeFile(bootFile,'{}','utf8');
  if(condition==='missing-proof'){delete pointer.bootProofSha256;await writeFile(h.pointerFile,JSON.stringify(pointer),'utf8');}
  if(condition==='invalid-proof'||condition==='future-proof'){
    record.boot.observedAt=condition==='invalid-proof'?'invalid':Date.now()+1;
    const bytes=JSON.stringify(record);await writeFile(bootFile,bytes,'utf8');pointer.bootProofSha256=sha(bytes);await writeFile(h.pointerFile,JSON.stringify(pointer),'utf8');
  }
  if(condition==='wrong-run'){h.result.runId='foreign';await h.save();}
  if(condition==='malformed-result')await writeFile(join(h.dir,'runtime.result.json'),'null','utf8');
  if(condition==='new-journal'){h.state.updatedAt=new Date(Date.now()).toISOString();await h.save();}
  if(condition==='live-role')inventory.host=[{pid:20}];
  if(condition==='retirement-changed'){h.state.newBaseline.retirement.definitionSha256='f'.repeat(64);await h.save();}
  if(condition==='ledger-uncertain')mock.prepare.mockRejectedValueOnce(Error('ledger uncertain'));
  if(condition==='boot-changed'){const c=await mock.control.mock.results[0]!.value;let count=0;c.systemBoot=async()=>({version:1,machineSha256,bootedAt:++count===1?bootAt:new Date(Date.now()-1).toISOString(),observedAt:Date.now()});}
  const original=await readFile(h.pointerFile);
  await expect(launchManagedService(h.p.manifestFile,h.p.manifestSha256)).rejects.toThrow();
  expect(await readFile(h.pointerFile)).toEqual(original);expect(mock.launch).toHaveBeenCalledOnce();
});
