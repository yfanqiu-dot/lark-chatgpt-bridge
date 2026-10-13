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
let root:string,source:string,service:string,d:any,inventory:any;
beforeEach(async()=>{
  vi.resetAllMocks();root=await mkdtemp(join(tmpdir(),'managed-service-'));source=join(root,'source');service=join(root,'service');await mkdir(source);await writeFile(join(source,'manifest.json'),'TEST_SOURCE','utf8');
  d={host:{},topics:{enabledChatIds:['oc_original_c'],allowTopicCreation:false},snapshot:{files:[{path:join(root,'bin/desktop-service-start.ps1')}],spec:{codeRevision:'a'.repeat(40),legacy:{executable:process.execPath}}}};
  mock.verify.mockImplementation(async()=>d);inventory={legacy:[],desktop:[],host:[],listener:[],broker:[]};
  mock.control.mockResolvedValue({inventory:async()=>inventory,legacyRetirement:async()=>({version:1,observedAt:Date.now(),retired:true,taskPresent:true,taskEnabled:false,taskState:'disabled',definitionSha256:'b'.repeat(64)})});
  mock.prepare.mockImplementation(async(_source,dir)=>{await mkdir(dir);return {planFile:join(dir,'plan.json'),planSha256:'c'.repeat(64)};});mock.launch.mockResolvedValue({identity:{pid:99}});
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const prepare=()=>prepareManagedService(source,service,root);
it('prepares a sealed existing-group service without launching services or installing startup',async()=>{
  const p=await prepare();expect(await readManagedService(p.manifestFile,p.manifestSha256)).toMatchObject({serviceMode:'stop-with-desktop',enabledChatIds:['oc_original_c'],allowTopicCreation:false});expect(p.startupInstalled).toBe(false);expect(mock.launch).not.toHaveBeenCalled();await expect(prepare()).rejects.toThrow();
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
  const state={phase:condition==='running'?'running':'closed',runId:'original-run',desktopQuitVerified:true,...(condition==='fault'?{errorCode:'fault'}:{})};await writeFile(join(dir,'supervisor.json'),JSON.stringify(state),'utf8');
  if(condition!=='missing-result')await writeFile(join(dir,'runtime.result.json'),JSON.stringify({...state,planId:'original-plan',runId:condition==='wrong-run'?'foreign-run':'original-run',messageServicePaused:true,legacyRecoveryAllowed:false}),'utf8');
  const bytes=await readFile(join(service,'active-run.json'));await expect(launchManagedService(p.manifestFile,p.manifestSha256)).rejects.toThrow();expect(await readFile(join(service,'active-run.json'))).toEqual(bytes);expect(mock.launch).toHaveBeenCalledOnce();
});
it('allows an explicitly invoked new entry after a clean closed run, with a different run directory',async()=>{
  const p=await prepare();await launchManagedService(p.manifestFile,p.manifestSha256);const previous=JSON.parse(await readFile(join(service,'active-run.json'),'utf8')),dir=dirname(previous.planFile);
  mock.plan.mockResolvedValue({serviceMode:'stop-with-desktop',codeRevision:'a'.repeat(40),directory:dir,planId:'original-plan'});
  const state={phase:'closed',runId:'original-run',desktopQuitVerified:true};await writeFile(join(dir,'supervisor.json'),JSON.stringify(state),'utf8');await writeFile(join(dir,'runtime.result.json'),JSON.stringify({...state,planId:'original-plan',messageServicePaused:true,legacyRecoveryAllowed:false}),'utf8');
  await launchManagedService(p.manifestFile,p.manifestSha256);expect(mock.prepare).toHaveBeenCalledTimes(2);expect(mock.prepare.mock.calls[0]![1]).not.toBe(mock.prepare.mock.calls[1]![1]);
});
