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
async function fixtureControl(){
  const script=join(directory,'control.ps1');await writeFile(script,'TEST ONLY','utf8');
  mock.verify.mockResolvedValue({host:{desktopExe:join(directory,'ChatGPT.exe')},snapshot:{spec:{legacy:{}},files:[{path:script,sha256:createHash('sha256').update('TEST ONLY').digest('hex')}]}});
  return WindowsSupervisorControl.prepare(join(directory,'stage'),script,join(directory,'evidence'));
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
});
it.skipIf(process.platform!=='win32').each(['body-only','wrong-action','denied','timeout','killed','unknown'])('does not retry %s failures',async condition=>{
  const control=await fixtureControl(),failure=Object.assign(new Error('TEST_PRIVATE_EXCEPTION'),{code:1 as string|number,signal:null as string|null,stderr:'    + FullyQualifiedErrorId : A potential runtime process cannot be identified\r\n'});
  if(condition==='body-only')failure.stderr='A potential runtime process cannot be identified';
  if(condition==='denied')failure.stderr+='HRESULT 0x80070005';
  if(condition==='timeout')failure.code='ETIMEDOUT';
  if(condition==='killed')failure.signal='SIGTERM';
  if(condition==='unknown')failure.stderr='    + FullyQualifiedErrorId : Unknown native failure\r\n';
  mock.exec.mockRejectedValue(failure);
  await expect(condition==='wrong-action'?control.taskPermissions():control.coldSnapshot()).rejects.toBe(failure);
});
