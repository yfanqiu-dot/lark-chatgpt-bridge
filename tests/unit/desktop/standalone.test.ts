import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({ verify:vi.fn(),exec:vi.fn(),inventory:vi.fn(),identity:vi.fn() }));
vi.mock('../../../src/desktop/deployment',() => ({verifyDeployment:mocks.verify}));
vi.mock('../../../src/desktop/supervisor-windows',() => ({WindowsSupervisorControl:{prepare:async () => ({inventory:mocks.inventory,testIdentity:mocks.identity})}}));
vi.mock('node:child_process',async original => {
  const actual = await original<typeof import('node:child_process')>();
  const fn:any = () => {}; fn[Symbol.for('nodejs.util.promisify.custom')] = mocks.exec;
  return {...actual,execFile:fn};
});
import { launchStandalone, parseStandalonePlan, prepareStandalone, readStandalonePlan, reserveStandaloneLaunch, standalonePreflight, validateStandaloneReceipt, verifyStandalone } from '../../../src/desktop/standalone';
let root:string, directory:string, snapshot:any, registry:string;
const digest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const read = async (path:string) => JSON.parse(await readFile(path,'utf8'));
const identity = () => ({pid:process.pid,parentPid:1,createdAt:new Date().toISOString(),executable:process.execPath,commandLineSha256:'a'.repeat(64)});
beforeEach(async () => {
  vi.resetAllMocks(); root = await mkdtemp(join(tmpdir(),'p4-standalone-')); directory = join(root,'plan'); registry=join(root,'registry.json');
  await mkdir(join(root,'bin'));await mkdir(join(root,'dist'));await writeFile(registry,'{}','utf8');
  const files=[process.execPath,'bin/lark-chatgpt-supervisor.mjs','bin/desktop-supervisor-launch.ps1','dist/desktop-standalone.js','bin/desktop-runtime-control.ps1','bin/lark-chatgpt-deploy.mjs','dist/desktop-deploy.js'].map((p,i)=>i?join(root,p):p);
  for(const file of files.slice(1))await writeFile(file,'TEST ONLY','utf8');
  snapshot={files:await Promise.all(files.map(async path=>({path,sha256:digest(await readFile(path))}))),spec:{codeRevision:'a'.repeat(40),legacy:{executable:process.execPath}}};
  mocks.verify.mockResolvedValue({snapshot,host:{desktopVersion:'26.1007.2314.0'},ledgers:[],topics:{registryFile:registry}});
  mocks.inventory.mockImplementation(async () => ({legacy:[{...identity(),pid:1}],desktop:[{...identity(),pid:2}],host:[],listener:[],broker:[]}));
  // Keep native identity observations stable between scans.
  const stable=await mocks.inventory();mocks.inventory.mockImplementation(async()=>structuredClone(stable));
  mocks.identity.mockResolvedValue(undefined);
  mocks.exec.mockImplementation(async (_program,args) => {
    if(args.includes('InspectIdentity'))return {stdout:JSON.stringify(identity()),stderr:''};
    const evidence=args.at(-1);await mkdir(evidence);await writeFile(join(evidence,'ordinary-observation.json'),JSON.stringify({verified:false,findings:['ordinary_native_state_unavailable'],toolCount:54,pipeCount:7,matchingToolCatalogs:1,failure:{method:'thread/loaded/list',kind:'rpc_error',code:-32602}}),'utf8');
    throw Object.assign(new Error('SECRET RAW ERROR'),{code:2});
  });
});
afterEach(async () => {await rm(root,{recursive:true,force:true});});
const prepare=async()=>prepareStandalone(join(root,'source-stage'),directory,root);
it('prepares an exclusive read-only plan with all programs pinned and no arbitrary fields',async()=>{
  const result=await prepare(),plan=await verifyStandalone(result.planFile,result.planSha256);
  expect(plan).toMatchObject({version:1,mode:'preflight',codeRevision:'a'.repeat(40)});expect(plan.files).toHaveLength(7);expect(mocks.exec).not.toHaveBeenCalled();
  expect(parseStandalonePlan({...plan,secret:'SECRET'},result.planFile)).not.toHaveProperty('secret');
  await expect(prepare()).rejects.toThrow();
});
it.each(['production','expired-lifetime','foreign-directory','missing-proof','quote-in-path'])('rejects %s before any launch',async fault=>{
  const prepared=await prepare(),plan=await read(prepared.planFile);
  if(fault==='production')plan.mode='run';
  if(fault==='expired-lifetime')plan.expiresAt=Date.parse(plan.createdAt)+700000;
  if(fault==='foreign-directory')plan.directory=root;
  if(fault==='missing-proof')plan.files.pop();
  if(fault==='quote-in-path')plan.nodeExecutable+='"';
  expect(()=>parseStandalonePlan(plan,prepared.planFile)).toThrow();expect(mocks.exec).not.toHaveBeenCalled();
});
it('requires the worker and launcher in the source deployment proof',async()=>{
  snapshot.files.pop();await expect(prepare()).rejects.toThrow('deployment proofs');expect(mocks.exec).not.toHaveBeenCalled();
});
it('rejects changed plan bytes, changed code and expired admission; history remains readable',async()=>{
  const prepared=await prepare();await writeFile(prepared.planFile,(await readFile(prepared.planFile,'utf8'))+' ','utf8');
  await expect(verifyStandalone(prepared.planFile,prepared.planSha256)).rejects.toThrow('plan changed');
  const planFile=join(directory,'second.json'),plan=await read(prepared.planFile);plan.createdAt=new Date(Date.now()-700000).toISOString();plan.expiresAt=Date.parse(plan.createdAt)+600000;
  const data=JSON.stringify(plan);await writeFile(planFile,data,'utf8');await expect(verifyStandalone(planFile,digest(data))).rejects.toThrow('expired');
  expect(await readStandalonePlan(planFile,digest(data),false)).toMatchObject({mode:'preflight'});
  await writeFile(join(root,'dist/desktop-standalone.js'),'CHANGED','utf8');await expect(verifyStandalone(planFile,digest(data),false)).rejects.toThrow('program changed');
});
it('reserves exactly one launch attempt and never overwrites its intent',async()=>{
  const prepared=await prepare(),plan=await verifyStandalone(prepared.planFile,prepared.planSha256);
  await reserveStandaloneLaunch(plan,prepared.planSha256);const before=await readFile(join(directory,'launch.intent.json'),'utf8');
  await expect(reserveStandaloneLaunch(plan,prepared.planSha256)).rejects.toThrow();expect(await readFile(join(directory,'launch.intent.json'),'utf8')).toBe(before);
});
it('requires full native receipt identity, exact plan and read-only scope',async()=>{
  const prepared=await prepare(),plan=await verifyStandalone(prepared.planFile,prepared.planSha256);
  const receipt={version:1,planId:plan.planId,mode:'preflight',phase:'launched',identity:identity(),servicesChanged:false,productionReady:false,secret:'SECRET'};
  expect(validateStandaloneReceipt(receipt,plan)).not.toHaveProperty('secret');
  for(const bad of [{...receipt,planId:'other'},{...receipt,productionReady:true},{...receipt,identity:{...identity(),commandLineSha256:'missing'}}])expect(()=>validateStandaloneReceipt(bad,plan)).toThrow('unconfirmed');
});
it('independent worker preserves blocked ordinary RPC evidence and never enables production',async()=>{
  const prepared=await prepare();expect(await standalonePreflight(prepared.planFile,prepared.planSha256)).toBe(2);
  const result=await read(join(directory,'worker.result.json'));expect(result).toMatchObject({phase:'blocked',servicesChanged:false,productionReady:false,originalProcessesAndBytesUnchanged:true,ordinary:{failure:{code:-32602}}});
  expect(result.leaseProbe).toMatchObject({closed:true,lost:false,rawCapabilityStored:false});
  expect(JSON.stringify(result)).not.toContain('SECRET');expect(mocks.exec.mock.calls.filter(c=>c[1].includes('ordinary-check'))).toHaveLength(1);
  await expect(standalonePreflight(prepared.planFile,prepared.planSha256)).rejects.toThrow();expect(mocks.exec.mock.calls.filter(c=>c[1].includes('ordinary-check'))).toHaveLength(1);
});
it('keeps a failed source validation as evidence without launching an inspection child',async()=>{
  const prepared=await prepare();mocks.verify.mockRejectedValue(new Error('SECRET SOURCE ERROR'));
  expect(await standalonePreflight(prepared.planFile,prepared.planSha256)).toBe(1);expect(await read(join(directory,'worker.result.json'))).toMatchObject({phase:'failed',errorCode:'standalone_preflight_failed'});expect(mocks.exec).not.toHaveBeenCalled();
});
it('reports changed original bytes without restoring a snapshot',async()=>{
  const prepared=await prepare(),originalExec=mocks.exec.getMockImplementation()!;
  mocks.exec.mockImplementation(async(...args:any[])=>{if(args[1].includes('ordinary-check'))await writeFile(registry,'{"new":true}','utf8');return originalExec(...args);});
  expect(await standalonePreflight(prepared.planFile,prepared.planSha256)).toBe(1);expect(await read(join(directory,'worker.result.json'))).toMatchObject({phase:'failed',originalProcessesAndBytesUnchanged:false});expect(await readFile(registry,'utf8')).toBe('{"new":true}');
});
it.skipIf(process.platform!=='win32')('keeps ambiguous native launch evidence and never retries the same plan',async()=>{
  const prepared=await prepare();mocks.exec.mockRejectedValue(new Error('SECRET NATIVE ERROR'));
  await expect(launchStandalone(prepared.planFile,prepared.planSha256)).rejects.toThrow('uncertain');expect(await read(join(directory,'launch.failure.json'))).toMatchObject({phase:'uncertain'});
  await expect(launchStandalone(prepared.planFile,prepared.planSha256)).rejects.toThrow();expect(mocks.exec).toHaveBeenCalledTimes(1);
});
