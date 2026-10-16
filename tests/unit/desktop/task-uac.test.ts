import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocked=vi.hoisted(()=>({verify:vi.fn()}));
vi.mock('../../../src/desktop/deployment',()=>({verifyDeployment:mocked.verify}));
import {TaskUacController,readTaskUacReport,taskUacMac,writeTaskUacNewFile,type TaskUacAction} from '../../../src/desktop/task-uac';
import type {WindowsSupervisorControl} from '../../../src/desktop/supervisor-windows';
let root:string,directory:string,clock:number,token:string,requests:any[],events:string[],controller:TaskUacController,input:any;
const id=(pid:number,exe:string)=>({pid,parentPid:1,createdAt:'2026-10-12T00:00:00.000Z',executable:exe,commandLineSha256:'a'.repeat(64)});
const envelope=(body:any)=>{const payload=Buffer.from(JSON.stringify(body),'utf8').toString('base64');return {payload,mac:taskUacMac(token,payload)};};
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'task-uac-'));directory=join(root,'runtime');await mkdir(directory);clock=Date.now();requests=[];events=[];token='';mocked.verify.mockReset();
  input={host:{connectionFile:join(directory,'connection.json'),desktopExe:join(root,'ChatGPT.exe')},snapshot:{files:['desktop-task-uac.ps1','desktop-runtime-control.ps1'].map(f=>({path:join(root,'bin',f),sha256:'b'.repeat(64)})),spec:{legacy:{scheduledTaskName:'LarkChannelBridge.Bot.fixture'}}}};mocked.verify.mockResolvedValue(input);
  const control={backupTask:async(path:string)=>{await mkdir(path);await writeFile(join(path,'legacy-task.json'),JSON.stringify({version:1,enabled:true}),'utf8');},taskPermissions:async()=>({version:1,writeAllowed:false,executeAllowed:false,descriptorSha256:'c'.repeat(64)}),inventory:async()=>({legacy:[id(2,join(root,'node.exe'))]}),protectCapability:async(path:string,value:string)=>{token=value;await writeFile(path,'ENCRYPTED_TEST_CAPABILITY','utf8');}} as unknown as WindowsSupervisorControl;
  const effects={now:()=>clock,pause:async()=>{clock+=200;await new Promise(r=>setTimeout(r,1));},launch:async(args:string[])=>{
    events.push('launch');const requestFile=args[args.indexOf('-RequestFile')+1]!,request=JSON.parse(await readFile(requestFile,'utf8'));requests.push(request);const identity={...id(20,join(root,'powershell.exe')),createdAt:new Date(clock).toISOString()};
    await writeTaskUacNewFile(join(request.directory,'native.json'),JSON.stringify({version:1,requestId:request.requestId,identity}));
    await writeTaskUacNewFile(join(request.directory,'ready.json'),JSON.stringify(envelope({version:1,requestId:request.requestId,action:request.action,identity,phase:'ready'})));
    for(let n=0;n<1000;n++){try{const go=JSON.parse(await readFile(join(request.directory,'go.json'),'utf8'));expect(go.mac).toBe(taskUacMac(token,`go:${request.requestId}`));events.push('confirmed');break;}catch{await new Promise(r=>setTimeout(r,1));}}
    await writeTaskUacNewFile(join(request.directory,'result.json'),JSON.stringify(envelope({version:1,requestId:request.requestId,action:request.action,identity,phase:'completed',permissions:{version:1,writeAllowed:true,executeAllowed:true,descriptorSha256:request.descriptorSha256}})));
  }};
  controller=new TaskUacController(join(root,'stage'),directory,root,id(10,join(root,'node.exe')),'a'.repeat(8)+'-aaaa-aaaa-aaaa-'+ 'a'.repeat(12),clock+2700000,control,effects);
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it('confirms native identity before authorizing a fixed action and stores only encrypted capability',async()=>{
  expect(await controller.call('TaskPermissions')).toMatchObject({writeAllowed:true,executeAllowed:true});expect(events).toEqual(['launch','confirmed']);
  expect(requests[0].action).toBe('TaskPermissions');expect(requests[0].expiresAt-clock).toBeLessThanOrEqual(120000);
  expect(JSON.stringify(requests[0])).not.toContain(token);expect(await readFile(requests[0].capabilityFile,'utf8')).toBe('ENCRYPTED_TEST_CAPABILITY');
});
it('does not repeat a mutating action after its exclusive intent exists',async()=>{
  await controller.call('DisableTask');await expect(controller.call('DisableTask')).rejects.toMatchObject({code:'EEXIST'});expect(events.filter(e=>e==='launch')).toHaveLength(1);
});
it('rejects arbitrary commands and an unpinned administrator helper before launching',async()=>{
  await expect(controller.call('DeleteTask' as TaskUacAction)).rejects.toThrow('unsupported');input.snapshot.files.pop();await expect(controller.call('TaskPermissions')).rejects.toThrow('not pinned');expect(events).toEqual([]);
});
it.each(['mac','request','action','identity'])('rejects a changed %s response',condition=>{
  token='f'.repeat(64);const value=envelope({version:1,requestId:'expected',action:'TaskPermissions',identity:id(20,join(root,'powershell.exe')),phase:'ready'});
  if(condition==='mac')value.mac='0'.repeat(64);
  else{const body=JSON.parse(Buffer.from(value.payload,'base64').toString('utf8'));if(condition==='request')body.requestId='foreign';if(condition==='action')body.action='StartLegacy';if(condition==='identity')body.identity.createdAt='invalid';Object.assign(value,envelope(body));}
  expect(()=>readTaskUacReport(value,token,'expected','TaskPermissions')).toThrow();
});
it('rejects actions after the cleanup allowance without launching',async()=>{
  clock+=3000001;await expect(controller.call('RestoreTask')).rejects.toThrow('expired');expect(events).toEqual([]);
});
it('publishes complete authorization once and refuses overwriting an existing grant',async()=>{
  const path=join(directory,'grant.json');await writeTaskUacNewFile(path,JSON.stringify({nonce:'original'}));
  await expect(writeTaskUacNewFile(path,JSON.stringify({nonce:'foreign'}))).rejects.toMatchObject({code:'EEXIST'});
  expect(JSON.parse(await readFile(path,'utf8'))).toEqual({nonce:'original'});expect((await readdir(directory)).filter(n=>n.includes('.tmp-'))).toEqual([]);
});
it('retains consent failure without a grant, private stderr or a repeated task mutation',async()=>{
  const internals=controller as unknown as {effects:{launch:(args:string[])=>Promise<void>}};
  internals.effects.launch=async()=>{throw Object.assign(new Error('TEST_PRIVATE_REASON'),{code:1,stderr:'TEST_PRIVATE_STDERR'});};
  await expect(controller.call('DisableTask')).rejects.toThrow('not confirmed');
  const folder=(await readdir(directory)).find(n=>n.startsWith('task-uac-')&&!n.endsWith('.json'))!;
  const report=await readFile(join(directory,folder,'launch.failure.json'),'utf8');expect(report).not.toContain('TEST_PRIVATE');
  await expect(readFile(join(directory,folder,'go.json'))).rejects.toMatchObject({code:'ENOENT'});
  await expect(controller.call('DisableTask')).rejects.toMatchObject({code:'EEXIST'});
});
