import { beforeEach,expect,it,vi } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {createHash} from 'node:crypto';
import { readOwnedSharedContext,readOwnedSharedIdentity,inspectOwnedShared } from '../../../src/desktop/shared-inspector';
import type { WindowsSupervisorControl } from '../../../src/desktop/supervisor-windows';
const mocked=vi.hoisted(()=>({verify:vi.fn(),tools:vi.fn(),read:vi.fn(),pipes:vi.fn(),catalog:vi.fn(),connect:vi.fn(),calls:vi.fn(),close:vi.fn(),listen:vi.fn()}));
vi.mock('../../../src/desktop/deployment',()=>({verifyDeployment:mocked.verify}));
vi.mock('../../../src/desktop/backend',()=>({readDesktopToolConfig:mocked.tools}));
vi.mock('node:fs/promises',()=>({readFile:mocked.read}));
vi.mock('../../../src/desktop/windows-tools',()=>({desktopPipes:mocked.pipes,desktopToolCatalog:mocked.catalog}));
vi.mock('../../../src/desktop/rpc',async importOriginal=>{
  const original=await importOriginal<typeof import('../../../src/desktop/rpc')>();
  return {...original,DesktopRpc:class {connect=mocked.connect;call=mocked.calls;close=mocked.close;onMessage(fn:unknown){mocked.listen(fn);} }};
});
const identity=(pid:number,parentPid=1,executable=process.execPath)=>({pid,parentPid,createdAt:'2026-10-12T00:00:00.000Z',executable,commandLineSha256:'a'.repeat(64)});
const owned={host:identity(42),broker:identity(41)};
const host={endpoint:'ws://127.0.0.1:9998/',backendEndpoint:'ws://127.0.0.1:9999/',connectionFile:join(tmpdir(),'lease.json'),desktopExe:join(tmpdir(),'ChatGPT.exe'),codexBinary:join(tmpdir(),'codex.exe'),desktopVersion:'fixture',codexSha256:'b'.repeat(64)};
let lease:any,scan:any;
const control={sharedSnapshot:async()=>structuredClone(scan),boundedSharedSnapshot:async()=>structuredClone(scan)} as WindowsSupervisorControl;
beforeEach(()=>{
  vi.resetAllMocks();
  lease={version:1,endpoint:host.endpoint,backendEndpoint:host.backendEndpoint,hostPid:42,backendPid:43,desktopPid:44,pipeServerPid:44,pipe:'pipe',verifiedAt:Date.now(),desktopVersion:host.desktopVersion,codexSha256:host.codexSha256,toolNames:['list_projects']};
  scan={verifiedAt:Date.now(),complete:true,desktopRelated:[identity(44,41,host.desktopExe),identity(43,42,host.codexBinary)],inventory:{host:[structuredClone(owned.host)],broker:[structuredClone(owned.broker)],desktop:[identity(44,41,host.desktopExe)],legacy:[],listener:[]},
    endpointOwners:[{endpoint:host.endpoint,listeners:[{address:'127.0.0.1',pid:42}]},{endpoint:host.backendEndpoint,listeners:[{address:'127.0.0.1',pid:43}]}]};
  mocked.verify.mockResolvedValue({host,snapshot:{bindings:[{threadId:'original',projectId:'project',projectRoot:tmpdir()}],spec:{expectedToolNames:['list_projects']}}});
  mocked.tools.mockResolvedValue({});mocked.read.mockImplementation(async()=>JSON.stringify(lease));mocked.pipes.mockResolvedValue([{pipe:'pipe',serverPid:44}]);mocked.catalog.mockResolvedValue(['list_projects']);
  mocked.calls.mockImplementation(async(m:string,p:any)=>m==='project/list'?{data:[{id:'project',roots:[{path:tmpdir()}]}]}:m==='thread/turns/list'?{data:[{status:'completed',completedAt:1}]}:
    m==='thread/loaded/list'?{data:['original']}:m==='thread/read'?{thread:{id:p.threadId,projectId:'project',cwd:tmpdir(),status:{type:'idle'}}}:m==='thread/queue/list'?{data:[]}:undefined);
});
it('matches actual host, its own child backend, package pipe and both TCP owners',async()=>{
  expect(await readOwnedSharedContext(tmpdir(),control,owned)).toMatchObject({host:owned.host,backend:{pid:43,parentPid:42},desktop:{pid:44},packageIdentityVerified:true,endpointOwnershipVerified:true});
  expect(mocked.tools).toHaveBeenCalledOnce();expect(mocked.pipes).toHaveBeenCalledWith(44,host.desktopExe);
});
it('checks original OS identities while admission is absent without reading old tools or native queues',async()=>{
  const expected=await readOwnedSharedContext(tmpdir(),control,owned);vi.clearAllMocks();
  mocked.read.mockRejectedValue(Object.assign(Error('withdrawn'),{code:'ENOENT'}));mocked.tools.mockRejectedValue(Error('withdrawn'));
  await readOwnedSharedIdentity(tmpdir(),control,owned,expected);
  expect(mocked.read).not.toHaveBeenCalled();expect(mocked.tools).not.toHaveBeenCalled();expect(mocked.pipes).not.toHaveBeenCalled();expect(mocked.calls).not.toHaveBeenCalled();
});
it.each(['gui','backend','host','broker','legacy','foreign','incomplete','stale','port','duplicatePort'])('rejects %s loss or replacement during a configuration wait',async kind=>{
  const expected=await readOwnedSharedContext(tmpdir(),control,owned);
  if(kind==='gui')scan.inventory.desktop[0].createdAt='2026-10-12T00:01:00.000Z';
  if(kind==='backend')scan.desktopRelated[1].createdAt='2026-10-12T00:01:00.000Z';
  if(kind==='host'||kind==='broker')scan.inventory[kind][0].commandLineSha256='f'.repeat(64);
  if(kind==='legacy')scan.inventory.legacy.push(identity(99));
  if(kind==='foreign')scan.desktopRelated.push(identity(99,999));
  if(kind==='incomplete')scan.complete=false;if(kind==='stale')scan.verifiedAt-=6000;
  if(kind==='port')scan.endpointOwners[1].listeners[0].pid=99;
  if(kind==='duplicatePort')scan.endpointOwners[1].listeners.push({address:'127.0.0.1',pid:43});
  await expect(readOwnedSharedIdentity(tmpdir(),control,owned,expected)).rejects.toThrow();
});
it.each(['exact','heartbeat','mismatch','withdrawn','changed','toolNamesChanged'])('requires an actual %s catalog and the same stable lease after settings refresh',async kind=>{
  const initialVerifiedAt=lease.verifiedAt;
  if(kind==='mismatch')mocked.catalog.mockResolvedValue(['list_projects','unexpected']);
  if(kind==='withdrawn')mocked.catalog.mockImplementation(async()=>{mocked.read.mockRejectedValue(Object.assign(Error('withdrawn'),{code:'ENOENT'}));return ['list_projects'];});
  if(kind==='changed')mocked.catalog.mockImplementation(async()=>{lease.endpoint='ws://127.0.0.1:10000/';return ['list_projects'];});
  if(kind==='heartbeat')mocked.catalog.mockImplementation(async()=>{lease.verifiedAt=Date.now()+1;return ['list_projects'];});
  if(kind==='toolNamesChanged')mocked.catalog.mockImplementation(async()=>{lease.toolNames=['list_projects','unexpected'];return ['list_projects'];});
  const result=readOwnedSharedContext(tmpdir(),control,owned,true,undefined,true);
  if(kind==='exact')expect(await result).toMatchObject({leaseVerifiedAt:initialVerifiedAt});
  else if(kind==='heartbeat')expect(await result).toMatchObject({leaseVerifiedAt:initialVerifiedAt});else await expect(result).rejects.toThrow();
  expect(mocked.catalog).toHaveBeenCalledOnce();
});
it.each(['incomplete','stale'])('still rejects a complete-reader result that is %s before any native task read',async kind=>{
  if(kind==='incomplete')scan.complete=false;else scan.verifiedAt-=6000;
  await expect(readOwnedSharedContext(tmpdir(),control,owned)).rejects.toThrow('unverified');expect(mocked.calls).not.toHaveBeenCalled();
});
it.each(['hostPid','backendPid','version','stale','parent','replacement'])('rejects %s lease/identity drift',async condition=>{
  if(condition==='hostPid')lease.hostPid=99;
  if(condition==='backendPid')lease.backendPid=99;
  if(condition==='version')lease.desktopVersion='other';
  if(condition==='stale')lease.verifiedAt-=61_000;
  if(condition==='parent')scan.desktopRelated[1].parentPid=999;
  if(condition==='replacement')scan.inventory.host[0].createdAt='2026-10-12T00:01:00.000Z';
  await expect(readOwnedSharedContext(tmpdir(),control,owned)).rejects.toThrow();expect(mocked.calls).not.toHaveBeenCalled();
});
it.each(['wrongOwner','wildcard','duplicate','foreignBackend','legacy','pipe'])('rejects %s conflicts before native inspection',async condition=>{
  if(condition==='wrongOwner')scan.endpointOwners[0].listeners[0].pid=99;
  if(condition==='wildcard')scan.endpointOwners[0].listeners[0].address='0.0.0.0';
  if(condition==='duplicate')scan.endpointOwners[0].listeners.push({address:'127.0.0.1',pid:99});
  if(condition==='foreignBackend')scan.desktopRelated.push(identity(99,999,host.codexBinary));
  if(condition==='legacy')scan.inventory.legacy.push(identity(99));
  if(condition==='pipe')mocked.pipes.mockResolvedValue([{pipe:'pipe',serverPid:99}]);
  await expect(readOwnedSharedContext(tmpdir(),control,owned)).rejects.toThrow();expect(mocked.calls).not.toHaveBeenCalled();
});
it('measures the real desktop catalog, then performs only native deployment reads',async()=>{
  expect(await inspectOwnedShared(tmpdir(),control,owned)).toMatchObject({verified:true,source:'owned_shared_native'});
  expect(mocked.catalog).toHaveBeenCalledOnce();expect(mocked.calls.mock.calls.map(([m])=>m).every(m=>['project/list','thread/turns/list','thread/loaded/list','thread/read','thread/queue/list'].includes(m))).toBe(true);
});
it('rejects catalog mismatch before opening the native connection',async()=>{
  mocked.catalog.mockResolvedValue(['list_projects','unexpected']);await expect(inspectOwnedShared(tmpdir(),control,owned)).rejects.toThrow('catalog mismatch');expect(mocked.connect).not.toHaveBeenCalled();
});
it('starts the activity window after initialization and still rejects notifications during native scans',async()=>{
  mocked.connect.mockImplementation(async()=>{mocked.listen.mock.calls.at(-1)![0]({method:'session/initialized'});});
  expect((await inspectOwnedShared(tmpdir(),control,owned)).verified).toBe(true);
  const original=mocked.calls.getMockImplementation()!;
  mocked.calls.mockImplementation(async(method,params)=>{if(method==='thread/read')mocked.listen.mock.calls.at(-1)![0]({method:'thread/status/changed'});return original(method,params);});
  expect((await inspectOwnedShared(tmpdir(),control,owned)).verified).toBe(false);
});
it.each(['notification','request'] as const)('records only fixed first %s metadata while keeping native admission blocked',async kind=>{
  const threadId='11111111-1111-4111-8111-111111111111',turnId='22222222-2222-4222-8222-222222222222',original=mocked.calls.getMockImplementation()!;
  mocked.calls.mockImplementation(async(method,params)=>{if(method==='thread/read')mocked.listen.mock.calls.at(-1)![0]({method:'thread/status/changed',...(kind==='request'?{id:'SECRET_REQUEST_ID'}:{}),params:{threadId,turnId,body:'SECRET_BODY'}});return original(method,params);});
  const r=await inspectOwnedShared(tmpdir(),control,owned);
  expect(r).toMatchObject({verified:false,activity:{kind,method:'thread/status/changed',methodSha256:createHash('sha256').update('thread/status/changed').digest('hex'),threadId,turnId}});
  expect(r.activity!.observedAt).toBeGreaterThan(0);expect(r.proof).toBeUndefined();expect(JSON.stringify(r)).not.toContain('SECRET');
});
it('keeps an unknown method hashed and the first event immutable without copying malformed identifiers',async()=>{
  const original=mocked.calls.getMockImplementation()!;
  mocked.calls.mockImplementation(async(method,params)=>{if(method==='thread/read'){const notify=mocked.listen.mock.calls.at(-1)![0];notify({method:'SECRET_METHOD',params:{threadId:'SECRET_THREAD',turnId:'SECRET_TURN',value:'SECRET_VALUE'}});notify({method:'thread/status/changed',params:{threadId:'11111111-1111-4111-8111-111111111111'}});}return original(method,params);});
  const r=await inspectOwnedShared(tmpdir(),control,owned);
  expect(r).toMatchObject({verified:false,activity:{kind:'notification',methodSha256:createHash('sha256').update('SECRET_METHOD').digest('hex')}});
  expect(r.activity).not.toHaveProperty('method');expect(r.activity).not.toHaveProperty('threadId');expect(r.activity).not.toHaveProperty('turnId');expect(JSON.stringify(r)).not.toContain('SECRET');
});
it('does not retain initialization notifications as activity evidence or a permission to reject a later quiet scan',async()=>{
  mocked.connect.mockImplementation(async()=>{mocked.listen.mock.calls.at(-1)![0]({method:'thread/status/changed',params:{threadId:'11111111-1111-4111-8111-111111111111'}});});
  const r=await inspectOwnedShared(tmpdir(),control,owned);expect(r.verified).toBe(true);expect(r).not.toHaveProperty('activity');
});
