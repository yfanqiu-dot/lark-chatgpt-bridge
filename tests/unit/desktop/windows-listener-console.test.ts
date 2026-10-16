import {it,expect} from 'vitest';
import {spawn,execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {detachOwnedListener} from '../../../src/desktop/runtime-port';
import {windowsPowerShellEnvironment} from '../../../src/desktop/windows-tools';
it.skipIf(process.platform!=='win32')('runs an owned detached Windows Node listener without a console child and observes its exit',async()=>{
  const directory=tmpdir(),env={BRIDGE_SUPERVISOR_OWNER_LEASE_FILE:join(directory,'broker-owner.json')};
  const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),20000)'],{windowsHide:true,detached:detachOwnedListener('listener',env,directory),stdio:['ignore','ignore','pipe']});
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((done,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>done({code,signal}));});
  const rows=()=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);@{rows=@(Get-CimInstance Win32_Process -Filter 'ProcessId = ${child.pid} OR ParentProcessId = ${child.pid}'|ForEach-Object{@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;name=[string]$_.Name}})}|ConvertTo-Json -Depth 3 -Compress`],{windowsHide:true,env:windowsPowerShellEnvironment(process.env),encoding:'utf8',timeout:10000})).rows;
  try{expect(rows()).toEqual([{pid:child.pid,parentPid:process.pid,name:'node.exe'}]);expect(child.kill()).toBe(true);const exit=await closed;expect(exit.code!==0||exit.signal!==null).toBe(true);expect(rows()).toEqual([]);}finally{if(child.exitCode===null&&child.signalCode===null)child.kill();await closed.catch(()=>{});}
},35000);
