import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
const mock=vi.hoisted(()=>({verify:vi.fn(),exec:vi.fn()}));
vi.mock('../../../src/desktop/deployment',()=>({verifyDeployment:mock.verify}));
vi.mock('node:child_process',async original=>{
  const actual=await original<typeof import('node:child_process')>();const fn:any=()=>{};fn[Symbol.for('nodejs.util.promisify.custom')]=mock.exec;return {...actual,execFile:fn};
});
import {WindowsSupervisorControl} from '../../../src/desktop/supervisor-windows';
import {ColdExitObservationUnavailable} from '../../../src/desktop/supervisor';
let directory:string;
beforeEach(async()=>{vi.resetAllMocks();directory=await mkdtemp(join(tmpdir(),'control-errors-'));});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
it.skipIf(process.platform!=='win32')('retains the failing action and native exit code without copying private stderr',async()=>{
  const script=join(directory,'control.ps1');await writeFile(script,'TEST ONLY','utf8');
  mock.verify.mockResolvedValue({host:{desktopExe:join(directory,'ChatGPT.exe')},snapshot:{spec:{legacy:{}},files:[{path:script,sha256:createHash('sha256').update('TEST ONLY').digest('hex')}]}});
  const control=await WindowsSupervisorControl.prepare(join(directory,'stage'),script,join(directory,'evidence'));
  mock.exec.mockRejectedValue(Object.assign(new Error('TEST_PRIVATE_EXCEPTION'),{code:1,stderr:'TEST_PRIVATE_STDERR HRESULT 0x80070005'}));
  await expect(control.taskPermissions()).rejects.toThrow('TEST_PRIVATE_EXCEPTION');
  const folders=await readdir(join(directory,'evidence'));const report=await readFile(join(directory,'evidence',folders.find(n=>n.startsWith('operation-failure-'))!,'summary.json'),'utf8');
  expect(JSON.parse(report)).toMatchObject({action:'TaskPermissions',errorCode:'native_task_access_denied',exitCode:1});
  expect(report).not.toContain('TEST_PRIVATE');expect(JSON.parse(report).stderrSha256).toMatch(/^[a-f0-9]{64}$/);
});
async function fixtureControl(allowMutations=false){
  const script=join(directory,'control.ps1');await writeFile(script,'TEST ONLY','utf8');
  mock.verify.mockResolvedValue({host:{desktopExe:join(directory,'ChatGPT.exe')},snapshot:{spec:{legacy:{}},files:[{path:script,sha256:createHash('sha256').update('TEST ONLY').digest('hex')}]}});
  return WindowsSupervisorControl.prepare(join(directory,'stage'),script,join(directory,'evidence'),allowMutations);
}
it.skipIf(process.platform!=='win32').each([
  'A potential runtime process cannot be identified',
  'Potential desktop or App Server is unreadable',
  'Process identity is not readable',
])('classifies the exact pinned native error ID %s as an unavailable read, without returning an empty proof',async errorId=>{
  const control=await fixtureControl();mock.exec.mockRejectedValue(Object.assign(new Error('TEST_PRIVATE_EXCEPTION'),{code:1,stderr:`TEST_PRIVATE_STDERR\r\n    + FullyQualifiedErrorId : ${errorId}\r\n \r\n`}));
  await expect(control.coldSnapshot()).rejects.toBeInstanceOf(ColdExitObservationUnavailable);
  const folders=await readdir(join(directory,'evidence'));const report=await readFile(join(directory,'evidence',folders.find(n=>n.startsWith('operation-failure-'))!,'summary.json'),'utf8');
  expect(JSON.parse(report)).toMatchObject({action:'ColdSnapshot',errorCode:'native_process_identity_unavailable',exitCode:1});expect(report).not.toContain('TEST_PRIVATE');
});
it.skipIf(process.platform!=='win32')('also classifies a failed second inventory read',async()=>{
  const control=await fixtureControl();mock.exec.mockRejectedValue(Object.assign(new Error('TEST_PRIVATE_EXCEPTION'),{code:1,stderr:'    + FullyQualifiedErrorId : A potential runtime process cannot be identified\r\n'}));
  await expect(control.inventory()).rejects.toMatchObject({name:'ColdExitObservationUnavailable',action:'Snapshot'});
  expect(mock.exec).toHaveBeenCalledTimes(3);
});
it.skipIf(process.platform!=='win32')('returns only a complete later inventory after two unreadable scans',async()=>{
  const control=await fixtureControl(),unavailable=Object.assign(new Error('TEST_PRIVATE_EXCEPTION'),{code:1,stderr:'    + FullyQualifiedErrorId : A potential runtime process cannot be identified\r\n'});
  const complete={desktop:[],legacy:[],host:[],listener:[],broker:[]};
  mock.exec.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable).mockResolvedValueOnce({stdout:JSON.stringify(complete)});
  expect(await control.inventory()).toEqual(complete);expect(mock.exec).toHaveBeenCalledTimes(3);
  expect(mock.exec.mock.calls.every(([program,args])=>program==='powershell.exe'&&args.at(-1)==='Snapshot')).toBe(true);
});
it.skipIf(process.platform!=='win32')('never repeats a process mutation even with the same unreadable error ID',async()=>{
  const control=await fixtureControl(true),error=Object.assign(new Error('TEST_PRIVATE_EXCEPTION'),{code:1,stderr:'    + FullyQualifiedErrorId : A potential runtime process cannot be identified\r\n'});
  mock.exec.mockRejectedValue(error);
  await expect(control.stopOwned('listener',{pid:1,parentPid:0,createdAt:'2026-10-13T00:00:00.000Z',executable:process.execPath,commandLineSha256:'a'.repeat(64)})).rejects.toBe(error);
  expect(mock.exec).toHaveBeenCalledTimes(1);
});
it.skipIf(process.platform!=='win32').each(['shared','bounded'] as const)('returns only a complete later %s shared scan, preserving its original timestamp and owners',async mode=>{
  const control=await fixtureControl(),unavailable=Object.assign(new Error('TEST_PRIVATE_SHARED'),{code:1,stderr:'    + FullyQualifiedErrorId : Process identity is not readable\r\n'});
  const complete={verifiedAt:123,complete:true,desktopRelated:[{pid:4}],inventory:{desktop:[{pid:4}],legacy:[],host:[{pid:2}],listener:[],broker:[{pid:1}]},endpointOwners:[{endpoint:'ws://127.0.0.1:9998/',listeners:[{address:'127.0.0.1',pid:2}]}]};
  mock.exec.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable).mockResolvedValueOnce({stdout:JSON.stringify(complete)});
  expect(await (mode==='shared'?control.sharedSnapshot():control.boundedSharedSnapshot())).toEqual(complete);
  expect(mock.exec).toHaveBeenCalledTimes(3);expect(mock.exec.mock.calls.every(([program,args])=>program==='powershell.exe'&&args.at(-1)==='SharedSnapshot')).toBe(true);
});
it.skipIf(process.platform!=='win32').each(['shared','bounded'] as const)('rejects persistent unreadability after at most three %s shared scans and retains validated diagnostics',async mode=>{
  const control=await fixtureControl(),diagnostic={version:1,pid:23,parentPid:5,processName:'node.exe',createdAt:'2026-10-13T00:00:00.000Z',missingExecutablePath:true,missingCommandLine:true,missingCreationDate:false,privateExtra:'TEST_PRIVATE_SHARED'};
  mock.exec.mockRejectedValue(Object.assign(new Error('TEST_PRIVATE_SHARED'),{code:1,stderr:`BRIDGE_NATIVE_UNREADABLE_PROCESS ${JSON.stringify(diagnostic)}\r\n    + FullyQualifiedErrorId : Process identity is not readable\r\n`}));
  await expect(mode==='shared'?control.sharedSnapshot():control.boundedSharedSnapshot()).rejects.toMatchObject({name:'ColdExitObservationUnavailable',action:'SharedSnapshot'});expect(mock.exec).toHaveBeenCalledTimes(3);
  const folders=(await readdir(join(directory,'evidence'))).filter(n=>n.startsWith('operation-failure-'));expect(folders).toHaveLength(3);
  for(const folder of folders){const text=await readFile(join(directory,'evidence',folder,'summary.json'),'utf8');expect(JSON.parse(text)).toMatchObject({action:'SharedSnapshot',errorCode:'native_process_identity_unavailable',unreadableProcess:{pid:23,parentPid:5}});expect(text).not.toContain('TEST_PRIVATE');}
});
it.skipIf(process.platform!=='win32').each(['denied','timeout','unknown','body-only','killed'])('does not repeat a %s shared failure',async kind=>{
  const control=await fixtureControl(),failure=Object.assign(new Error('TEST_PRIVATE_SHARED'),{code:1 as string|number,signal:null as string|null,stderr:'    + FullyQualifiedErrorId : Process identity is not readable\r\n'});
  if(kind==='denied')failure.stderr+='HRESULT 0x80070005';if(kind==='timeout')failure.code='ETIMEDOUT';if(kind==='unknown')failure.stderr='    + FullyQualifiedErrorId : Unknown native failure\r\n';if(kind==='body-only')failure.stderr='Process identity is not readable';if(kind==='killed')failure.signal='SIGTERM';
  mock.exec.mockRejectedValue(failure);await expect(control.sharedSnapshot()).rejects.toBe(failure);expect(mock.exec).toHaveBeenCalledTimes(1);
});
it.skipIf(process.platform!=='win32')('rejects a bounded shared retry when its pinned reader changes after the first scan',async()=>{
  const control=await fixtureControl();
  mock.exec.mockImplementationOnce(async()=>{await writeFile(join(directory,'control.ps1'),'CHANGED READER','utf8');throw Object.assign(Error('TEST_PRIVATE_SHARED'),{code:1,stderr:'    + FullyQualifiedErrorId : Process identity is not readable\r\n'});});
  await expect(control.boundedSharedSnapshot()).rejects.toThrow('Bounded native reader changed');expect(mock.exec).toHaveBeenCalledTimes(1);
});
it.skipIf(process.platform!=='win32')('keeps only validated unreadable process identifiers and flags, excluding command and path fields',async()=>{
  const control=await fixtureControl();const diagnostic={version:1,pid:12,parentPid:5,processName:'node.exe',createdAt:'2026-10-13T00:00:00.000Z',missingExecutablePath:true,missingCommandLine:false,missingCreationDate:false,commandLine:'TEST_PRIVATE_COMMAND',executablePath:'TEST_PRIVATE_PATH'};
  mock.exec.mockRejectedValue(Object.assign(new Error('TEST_PRIVATE_EXCEPTION'),{code:1,stderr:`BRIDGE_NATIVE_UNREADABLE_PROCESS ${JSON.stringify(diagnostic)}\r\n    + FullyQualifiedErrorId : Process identity is not readable\r\n`}));
  await expect(control.coldSnapshot()).rejects.toBeInstanceOf(ColdExitObservationUnavailable);
  const folders=await readdir(join(directory,'evidence')),report=await readFile(join(directory,'evidence',folders.find(n=>n.startsWith('operation-failure-'))!,'summary.json'),'utf8');
  expect(JSON.parse(report).unreadableProcess).toEqual({pid:12,parentPid:5,processName:'node.exe',createdAt:'2026-10-13T00:00:00.000Z',missingExecutablePath:true,missingCommandLine:false,missingCreationDate:false});expect(report).not.toContain('TEST_PRIVATE');
});
it.skipIf(process.platform!=='win32')('does not persist malformed diagnostic records',async()=>{
  const control=await fixtureControl();mock.exec.mockRejectedValue(Object.assign(new Error('TEST_PRIVATE_EXCEPTION'),{code:1,stderr:'BRIDGE_NATIVE_UNREADABLE_PROCESS {"version":1,"pid":"TEST_PRIVATE_PID"}\r\n    + FullyQualifiedErrorId : Process identity is not readable\r\n'}));
  await expect(control.coldSnapshot()).rejects.toBeInstanceOf(ColdExitObservationUnavailable);
  const folders=await readdir(join(directory,'evidence')),report=await readFile(join(directory,'evidence',folders.find(n=>n.startsWith('operation-failure-'))!,'summary.json'),'utf8');
  expect(JSON.parse(report).unreadableProcess).toBeUndefined();expect(report).not.toContain('TEST_PRIVATE');
});
it.skipIf(process.platform!=='win32').each(['body-only','wrong-action','denied','timeout','killed','unknown'])('does not retry %s failures',async condition=>{
  const control=await fixtureControl(),failure=Object.assign(new Error('TEST_PRIVATE_EXCEPTION'),{code:1 as string|number,signal:null as string|null,stderr:'    + FullyQualifiedErrorId : A potential runtime process cannot be identified\r\n'});
  if(condition==='body-only')failure.stderr='A potential runtime process cannot be identified';
  if(condition==='denied')failure.stderr+='HRESULT 0x80070005';
  if(condition==='timeout')failure.code='ETIMEDOUT';
  if(condition==='killed')failure.signal='SIGTERM';
  if(condition==='unknown')failure.stderr='    + FullyQualifiedErrorId : Unknown native failure\r\n';
  mock.exec.mockRejectedValue(failure);
  await expect(condition==='wrong-action'?control.taskPermissions():control.inventory()).rejects.toBe(failure);expect(mock.exec).toHaveBeenCalledTimes(1);
});
