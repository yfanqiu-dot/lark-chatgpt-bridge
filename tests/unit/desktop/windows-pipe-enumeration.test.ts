import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {expect,it} from 'vitest';
import {desktopPipeNames,desktopPipes,windowsPowerShellEnvironment} from '../../../src/desktop/windows-tools';

it.skipIf(process.platform!=='win32')('discovers a live pipe and omits it after the server closes',async()=>{
  const name='codex-browser-use-test-'+randomUUID(),pipe='\\\\.\\pipe\\'+name,server=createServer(socket=>socket.end());
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
  try{expect(await desktopPipeNames()).toContain(name);}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  expect(await desktopPipeNames()).not.toContain(name);
});
it.skipIf(process.platform!=='win32')('rejects a non-packaged process even when desktop pipe candidates exist',async()=>{
  await expect(desktopPipes(process.pid,process.execPath)).rejects.toThrow();
},20000);
it.skipIf(process.platform!=='win32')('checks multiple real pipe owners across the Windows PowerShell 5 JSON boundary',async()=>{
  const names=[0,1].map(()=> 'codex-browser-use-test-'+randomUUID()),servers=names.map(()=>createServer(socket=>socket.end())),exec=promisify(execFile);
  const source=readFileSync('src/desktop/windows-tools.ts','utf8'),declaration=source.split('\n').find(line=>line.startsWith('Add-Type '))!,start=source.indexOf('$taskCandidates='),block=source.slice(start,source.indexOf('\n`;',start));
  expect(start).toBeGreaterThan(0);
  for(const [i,server] of servers.entries())await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen('\\\\.\\pipe\\'+names[i],resolve);});
  const check=async(pid:number,candidates:string[])=>{
    const script="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$taskExpectedPid=[int]$env:BRIDGE_DESKTOP_PID;\n"+declaration+'\n'+block;
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:10000,env:{...windowsPowerShellEnvironment(process.env),BRIDGE_DESKTOP_PID:String(pid),BRIDGE_DESKTOP_PIPE_NAMES:JSON.stringify(candidates)}});return JSON.parse(stdout);
  };
  try{
    const rows=await check(process.pid,names);expect(rows.map((row:{pipe:string})=>row.pipe).sort()).toEqual(names.map(name=>'\\\\.\\pipe\\'+name).sort());expect(rows.every((row:{serverPid:number})=>row.serverPid===process.pid)).toBe(true);
    expect(await check(process.pid+1,names)).toEqual([]);expect(await check(process.pid,[])).toEqual([]);
  }finally{await Promise.all(servers.map(server=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));}
},30000);
