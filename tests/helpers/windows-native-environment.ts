import {execFile} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {promisify} from 'node:util';
import {setTimeout as pause} from 'node:timers/promises';
import {windowsPowerShellEnvironment} from '../../src/desktop/windows-tools';

const fixture=String.raw`
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
const config=JSON.parse(await readFile(process.argv[2],'utf8'));
const save=value=>writeFile(config.output,JSON.stringify(value),'utf8');
await writeFile(config.started,JSON.stringify({pid:process.pid,phase:'node-started'}),'utf8');
try{
 const execution=promisify(execFile)(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',config.nativeScript],{windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:512*1024});
 execution.child.stdin?.end();
 const result=await execution;
 await save({pid:process.pid,passed:result.stdout.trim()==='NATIVE_PIPELINE_OK'&&result.stderr.includes('x'.repeat(131072)),marker:result.stdout.trim(),stderrDrained:result.stderr.includes('x'.repeat(131072)),privateEnvironmentInherited:!!(process.env.CODEX_THREAD_ID||process.env.NODE_REPL_SECRET)});
}catch(error){const stderr=String(error.stderr??'');await save({pid:process.pid,passed:false,phase:'native-command',code:error.code,timedOut:!!error.killed,nativeInvocationRejected:stderr.includes('CantActivateDocumentInPipeline')||stderr.includes('Native identity command failed'),nativeTrace:['PS_READY','PS_BEFORE_NATIVE','PS_AFTER_NATIVE'].filter(marker=>stderr.includes(marker)),stderr:stderr.replace(/S-1-[0-9]+(?:-[0-9]+)+/g,'[identity]').slice(-1200)});process.exitCode=1;}
`;
const nativeScript=String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::Error.Write('PS_READY')
[Console]::Error.Write(('x'*131072))
if($env:CODEX_THREAD_ID -or $env:NODE_REPL_SECRET){throw 'Private parent environment inherited'}
$whoami=[IO.Path]::Combine($env:SystemRoot,'System32','whoami.exe')
[Console]::Error.Write('PS_BEFORE_NATIVE')
$identity=& $whoami /user /fo csv /nh
[Console]::Error.Write('PS_AFTER_NATIVE')
if($LASTEXITCODE -ne 0 -or [string]::Join('',@($identity)) -notmatch 'S-1-[0-9]+(-[0-9]+)+'){throw 'Native identity command failed'}
[Console]::Out.Write('NATIVE_PIPELINE_OK')
`;

/** Match the production detached CIM launch and record the phase on failure. */
export async function nativeEnvironmentFixture(names:string[]){
  const directory=await mkdtemp(join(tmpdir(),'bridge-native-env-')),script=join(directory,'fixture.mjs'),nativeFile=join(directory,'native.ps1'),configFile=join(directory,'config.json'),output=join(directory,'result.json'),started=join(directory,'started.json'),quote=(value:string)=>"'"+value.replaceAll("'","''")+"'";
  try{
    await writeFile(script,fixture,'utf8');await writeFile(nativeFile,nativeScript,'utf8');await writeFile(configFile,JSON.stringify({output,started,nativeScript:nativeFile}),'utf8');
    const command=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$env:CODEX_THREAD_ID='excluded-parent-thread';$env:NODE_REPL_SECRET='excluded-parent-secret';$names=@(${names.map(quote).join(',')});$variables=@(Get-ChildItem Env:|Where-Object{$_.Name -in $names}|ForEach-Object{$_.Name+'='+$_.Value});$startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]1032;EnvironmentVariables=[string[]]$variables};$node=${quote(process.execPath)};$script=${quote(script)};$config=${quote(configFile)};$line='"'+$node+'" "'+$script+'" "'+$config+'"';$created=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$line;CurrentDirectory=${quote(directory)};ProcessStartupInformation=$startup};if($created.ReturnValue -ne 0){throw ('Native creation failed: '+$created.ReturnValue)};@{pid=[int]$created.ProcessId}|ConvertTo-Json -Compress`;
    const launch=JSON.parse((await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',env:windowsPowerShellEnvironment(process.env),timeout:15000})).stdout);
    const deadline=Date.now()+25000;let result;
    while(Date.now()<deadline){try{result=JSON.parse(await readFile(output,'utf8'));break;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}await pause(100);}
    if(!result){let phase='not-started';try{phase=JSON.parse(await readFile(started,'utf8')).phase;}catch{}throw new Error('Native fixture timed out in phase '+phase);}
    if(result.pid!==launch.pid)throw new Error('Native fixture process identity changed');
    return result;
  }finally{
    if(!resolve(directory).startsWith(resolve(tmpdir(),'bridge-native-env-')))throw new Error('Fixture cleanup escaped temporary directory');
    await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
}
