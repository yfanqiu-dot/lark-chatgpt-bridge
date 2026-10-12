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
