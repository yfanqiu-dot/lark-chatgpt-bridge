import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,mkdir,copyFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
let root:string;
beforeEach(async()=>{root=await mkdtemp(join(tmpdir(),'bridge-runtime-error-'));await mkdir(join(root,'bin'));await mkdir(join(root,'dist'));await writeFile(join(root,'package.json'),'{"type":"module"}','utf8');await copyFile(resolve('bin/lark-chatgpt-runtime-supervisor.mjs'),join(root,'bin/entry.mjs'));});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
it.each(['service_previous_run_unresolved','UNTRUSTED_PRIVATE_CODE'])('returns only a fixed startup code and fingerprint for %s',async code=>{
  await writeFile(join(root,'dist/desktop-runtime-supervisor.js'),`export async function runtimeSupervisorMain(){throw Object.assign(new Error('PRIVATE_TEST_SECRET'),{code:${JSON.stringify(code)}})}`,'utf8');
  let stderr='';try{execFileSync(process.execPath,[join(root,'bin/entry.mjs'),'--service-launch'],{encoding:'utf8',windowsHide:true,stdio:'pipe'});}catch(error:any){expect(error.status).toBe(1);stderr=String(error.stderr);}
  expect(stderr).not.toContain('PRIVATE_TEST_SECRET');expect(stderr).not.toContain('UNTRUSTED_PRIVATE_CODE');
  const result=JSON.parse(stderr.trim().replace(/^QIU_BRIDGE_FAILURE /,''));expect(result).toMatchObject({version:1,code:code==='service_previous_run_unresolved'?code:'service_launch_failed'});expect(result.errorSha256).toMatch(/^[a-f0-9]{64}$/);
});
