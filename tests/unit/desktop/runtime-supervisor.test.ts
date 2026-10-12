import { beforeEach,afterEach,expect,it,vi } from 'vitest';
import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const mocked=vi.hoisted(()=>({verify:vi.fn(),prepare:vi.fn(),exec:vi.fn(),control:vi.fn(),permissions:vi.fn()}));
vi.mock('../../../src/desktop/deployment',()=>({verifyDeployment:mocked.verify,prepareDeployment:mocked.prepare}));
vi.mock('../../../src/desktop/supervisor-windows',()=>({WindowsSupervisorControl:{prepare:mocked.control}}));
vi.mock('node:child_process',async original=>{
  const actual=await original<typeof import('node:child_process')>();const fn:any=()=>{};fn[Symbol.for('nodejs.util.promisify.custom')]=mocked.exec;return {...actual,execFile:fn};
});
import { prepareColdRuntime,readColdRuntimePlan,verifyColdRuntimePlan,launchColdRuntime } from '../../../src/desktop/runtime-supervisor';
let root:string,directory:string,input:any;
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
beforeEach(async()=>{
  vi.resetAllMocks();root=await mkdtemp(join(tmpdir(),'cold-plan-'));directory=join(root,'runtime');await mkdir(join(root,'bin'));await mkdir(join(root,'dist'));
  const files=['node.exe','bin/lark-chatgpt-runtime-supervisor.mjs','bin/desktop-cold-launch.ps1','dist/desktop-runtime-supervisor.js','bin/desktop-runtime-control.ps1','bin/lark-chatgpt-host.mjs','bin/lark-chatgpt-topics.mjs','bin/desktop-package-broker.ps1','bin/desktop-package-broker-task.ps1'].map(p=>join(root,p));
  for(const f of files)await writeFile(f,'TEST ONLY','utf8');
  input={host:{connectionFile:join(root,'source-connection.json')},topics:{connectionFile:join(root,'source-connection.json'),registryFile:join(root,'original-registry.json'),enabledChatIds:['oc_c'],allowTopicCreation:false},snapshot:{files:await Promise.all(files.map(async path=>({path,sha256:sha(await readFile(path))}))),spec:{codeRevision:'a'.repeat(40),legacy:{executable:files[0],profile:'fixture',scheduledTaskName:'LarkChannelBridge.Bot.fixture'}}}};
  mocked.verify.mockImplementation(async stage=>stage===join(directory,'stage')?{...input,host:JSON.parse(await readFile(join(directory,'host.json'),'utf8')),topics:JSON.parse(await readFile(join(directory,'topics.json'),'utf8'))}:input);
  mocked.prepare.mockImplementation(async(_spec,stage)=>{await mkdir(stage);});
  mocked.control.mockResolvedValue({taskPermissions:mocked.permissions,inventory:async()=>({legacy:[{pid:1}]}),canStopLegacy:async()=>true});
  mocked.permissions.mockResolvedValue({version:1,writeAllowed:true,executeAllowed:true,descriptorSha256:'e'.repeat(64)});
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const prepare=()=>prepareColdRuntime(join(root,'source-stage'),directory,root);
it('prepares an exclusive isolated runtime, preserving registry and gray scope without launching a service',async()=>{
  const r=await prepare(),p=await verifyColdRuntimePlan(r.planFile,r.planSha256);
  expect(p.files).toHaveLength(9);expect(p.windowMs).toBe(2700000);expect(p.exitTimeoutMs).toBe(600000);
  expect(JSON.parse(await readFile(join(directory,'topics.json'),'utf8'))).toMatchObject({registryFile:input.topics.registryFile,enabledChatIds:['oc_c'],allowTopicCreation:false,connectionFile:join(directory,'connection.json')});
  expect(input.host.connectionFile).toBe(join(root,'source-connection.json'));expect(mocked.exec).not.toHaveBeenCalled();await expect(prepare()).rejects.toThrow();
});
it.each(['mode','window','expiry','programs','location'])('rejects altered %s admission before a native launch',async condition=>{
  const r=await prepare(),p=JSON.parse(await readFile(r.planFile,'utf8'));
  if(condition==='mode')p.mode='hot';if(condition==='window')p.windowMs=0;if(condition==='expiry')p.expiresAt++;if(condition==='programs')p.files.pop();if(condition==='location')p.directory=root;
  const data=JSON.stringify(p);await writeFile(r.planFile,data,'utf8');await expect(readColdRuntimePlan(r.planFile,sha(data))).rejects.toThrow();expect(mocked.exec).not.toHaveBeenCalled();
});
it('rejects plan/code changes and preserves historical status after expiry',async()=>{
  const r=await prepare(),p=JSON.parse(await readFile(r.planFile,'utf8'));p.createdAt=new Date(Date.now()-700000).toISOString();p.expiresAt=Date.parse(p.createdAt)+600000;
  const data=JSON.stringify(p);await writeFile(r.planFile,data,'utf8');await expect(verifyColdRuntimePlan(r.planFile,sha(data))).rejects.toThrow('expired');expect(await readColdRuntimePlan(r.planFile,sha(data),false)).toMatchObject({mode:'cold'});
  await writeFile(join(root,'bin/desktop-cold-launch.ps1'),'CHANGED','utf8');await expect(verifyColdRuntimePlan(r.planFile,sha(data),false)).rejects.toThrow('program changed');
});
it('requires all runtime programs in the verified source, before creating the directory',async()=>{
  input.snapshot.files.pop();await expect(prepare()).rejects.toThrow('source proofs');await expect(readFile(join(directory,'plan.json'))).rejects.toMatchObject({code:'ENOENT'});
});
it.skipIf(process.platform!=='win32')('retains native ambiguity and does not retry the same launch',async()=>{
  const r=await prepare();mocked.exec.mockRejectedValue(new Error('TEST_PRIVATE_NATIVE_ERROR'));await expect(launchColdRuntime(r.planFile,r.planSha256)).rejects.toThrow('uncertain');
  expect(await readFile(join(directory,'launch.failure.json'),'utf8')).not.toContain('TEST_PRIVATE');await expect(launchColdRuntime(r.planFile,r.planSha256)).rejects.toThrow();expect(mocked.exec).toHaveBeenCalledOnce();
});
it.skipIf(process.platform!=='win32')('checks complete native identity and returns only whitelisted fields',async()=>{
  const r=await prepare();mocked.exec.mockResolvedValue({stdout:JSON.stringify({version:1,planId:r.planId,workerMode:'Run',identity:{pid:100,parentPid:1,createdAt:new Date().toISOString(),executable:join(root,'node.exe'),commandLineSha256:'b'.repeat(64)},private:'TEST_PRIVATE'})});
  expect(await launchColdRuntime(r.planFile,r.planSha256)).not.toHaveProperty('private');await expect(launchColdRuntime(r.planFile,r.planSha256)).rejects.toThrow();expect(mocked.exec).toHaveBeenCalledOnce();
});
it.skipIf(process.platform!=='win32')('blocks recovery while the original journal writer is alive',async()=>{
  const r=await prepare();const {SupervisorJournal}=await import('../../../src/desktop/supervisor');const j=new SupervisorJournal(join(directory,'supervisor.json'));await j.open();
  await writeFile(join(directory,'supervisor.json'),JSON.stringify({phase:'running'}),'utf8');try{await expect(launchColdRuntime(r.planFile,r.planSha256,true)).rejects.toThrow('still owns');expect(mocked.exec).not.toHaveBeenCalled();}finally{await j.close();}
});
it.skipIf(process.platform!=='win32')('blocks a read-only legacy task before creating a launch intent or process',async()=>{
  const r=await prepare();mocked.permissions.mockResolvedValue({version:1,writeAllowed:false,executeAllowed:false,descriptorSha256:'e'.repeat(64)});
  await expect(launchColdRuntime(r.planFile,r.planSha256)).rejects.toThrow('desktop must remain open');expect(mocked.exec).not.toHaveBeenCalled();
  await expect(readFile(join(directory,'launch.intent.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(JSON.parse(await readFile(join(directory,'launch.admission.json'),'utf8'))).toMatchObject({allowed:false});
});
it('pins the additional task helper only for an explicitly prepared UAC plan',async()=>{
  await expect(prepareColdRuntime(join(root,'source-stage'),directory,root,'uac')).rejects.toThrow('source proofs');
  const path=join(root,'bin/desktop-task-uac.ps1');await writeFile(path,'TEST UAC ONLY','utf8');input.snapshot.files.push({path,sha256:sha('TEST UAC ONLY')});
  const r=await prepareColdRuntime(join(root,'source-stage'),directory,root,'uac'),p=await verifyColdRuntimePlan(r.planFile,r.planSha256);
  expect(p.taskControl).toBe('uac');expect(p.files).toHaveLength(10);expect(mocked.exec).not.toHaveBeenCalled();
});
it.skipIf(process.platform!=='win32')('retains denied ordinary permissions and requires explicit administrator consent in a UAC launch',async()=>{
  const path=join(root,'bin/desktop-task-uac.ps1');await writeFile(path,'TEST UAC ONLY','utf8');input.snapshot.files.push({path,sha256:sha('TEST UAC ONLY')});
  const r=await prepareColdRuntime(join(root,'source-stage'),directory,root,'uac');mocked.permissions.mockResolvedValue({version:1,writeAllowed:false,executeAllowed:false,descriptorSha256:'e'.repeat(64)});
  mocked.exec.mockResolvedValue({stdout:JSON.stringify({version:1,planId:r.planId,workerMode:'Run',identity:{pid:100,parentPid:1,createdAt:new Date().toISOString(),executable:join(root,'node.exe'),commandLineSha256:'b'.repeat(64)}})});
  await launchColdRuntime(r.planFile,r.planSha256);expect(JSON.parse(await readFile(join(directory,'launch.admission.json'),'utf8'))).toMatchObject({requiresAdministratorConsent:true,permissions:{writeAllowed:false,executeAllowed:false}});
});
