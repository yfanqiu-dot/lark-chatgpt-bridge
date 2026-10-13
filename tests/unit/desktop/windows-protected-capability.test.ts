import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { windowsPowerShellEnvironment } from '../../../src/desktop/windows-tools';
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'broker-dpapi-'));await writeFile(join(dir,'control.json'),JSON.stringify({version:1,desktopExe:join(dir,'ChatGPT.exe'),legacy:{profile:'codex',scheduledTaskName:'Fixture',executable:process.execPath,entryPoint:join(dir,'fixture.mjs')}}),'utf8');});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
function call(action:string,input?:string){return new Promise<string>((done,reject)=>{
  const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-File',resolve('bin/desktop-runtime-control.ps1'),'-ConfigFile',join(dir,'control.json'),'-Action',action,'-CapabilityFile',join(dir,'capability.dpapi')],{windowsHide:true,encoding:'utf8',timeout:10_000,env:windowsPowerShellEnvironment(process.env)},(e,stdout)=>e?reject(new Error('Test capability command rejected')):done(stdout));child.stdin?.end(input??'');
});}
describe.skipIf(process.platform!=='win32')('Windows protected capability, no package activation or service control',()=>{
  it('round trips a disposable capability via CurrentUser protection without storing plaintext',async()=>{
    const token='a'.repeat(64);expect(JSON.parse(await call('ProtectCapability',token)).protected).toBe(true);expect(await readFile(join(dir,'capability.dpapi'),'utf8')).not.toContain(token);expect(await call('UnprotectCapability')).toBe(token);
    await expect(call('ProtectCapability',token)).rejects.toThrow();
  },35_000);
  it('rejects corrupt ciphertext and malformed capability input',async()=>{
    await expect(call('ProtectCapability','not-a-token')).rejects.toThrow();await writeFile(join(dir,'capability.dpapi'),'corrupt','utf8');await expect(call('UnprotectCapability')).rejects.toThrow();
  },35_000);
});
