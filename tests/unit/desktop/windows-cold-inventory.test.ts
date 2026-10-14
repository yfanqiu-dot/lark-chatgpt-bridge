import { execFileSync,spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect,it } from 'vitest';
import { windowsPowerShellEnvironment } from '../../../src/desktop/windows-tools';
function testCode(assertion:string){
  const source=resolve('bin/desktop-runtime-control.ps1').replaceAll("'","''");
  const code=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$ast=[Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$null,[ref]$null);foreach($name in @('Get-Sha','Throw-UnreadableProcess','Has-Argument','Resolve-ProcessMetadata','Get-Identity','Get-ColdRelated')){$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);if(!$fn){throw 'Missing helper'};. ([scriptblock]::Create($fn.Extent.Text))};function Get-CimInstance {return $null};function P($id,$parent,$name,$command){[pscustomobject]@{ProcessId=$id;ParentProcessId=$parent;Name=$name;ExecutablePath='C:\fixture\'+$name;CommandLine=$command;CreationDate=[DateTime]::UtcNow}};${assertion}`;
  return code;
}
function run(assertion:string){
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(testCode(assertion),'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,env:windowsPowerShellEnvironment(process.env)}).trim();
}
it.skipIf(process.platform!=='win32')('counts desktop children, descendants and orphaned foreign App Servers',()=>{
  expect(run(`$p=@((P 1 0 ChatGPT.exe 'desktop'),(P 2 1 ChatGPT.exe '--type=renderer'),(P 3 2 node.exe 'tool'),(P 4 99 codex.exe 'codex app-server --listen ws://127.0.0.1:9999/'),(P 5 4 node.exe 'tool'),(P 6 99 codex.exe 'codex --version'));$r=@(Get-ColdRelated $p);if(($r.pid | Sort-Object) -join ',' -ne '1,2,3,4,5'){throw 'Inventory incomplete'};Write-Output OK`)).toBe('OK');
});
it.skipIf(process.platform!=='win32')('fails closed on unreadable potential desktop or backend',()=>{
  expect(run(`foreach($name in @('ChatGPT.exe','codex.exe')){$p=P 1 0 $name ''; $rejected=$false;try{$null=Get-ColdRelated @($p)}catch{$rejected=$true};if(!$rejected){throw 'Opaque process accepted'}};Write-Output OK`)).toBe('OK');
});
it.skipIf(process.platform!=='win32')('fails closed on an unreadable desktop descendant and accepts an empty inventory',()=>{
  expect(run(`$p=P 2 1 node.exe ''; $rejected=$false;try{$null=Get-ColdRelated @((P 1 0 ChatGPT.exe 'desktop'),$p)}catch{$rejected=$true};if(!$rejected -or @(Get-ColdRelated @()).Count -ne 0){throw 'Invalid empty/descendant proof'};Write-Output OK`)).toBe('OK');
});
it.skipIf(process.platform!=='win32')('records a real native diagnostic for an opaque process without command text or paths',()=>{
  const code=testCode(`$p=P 12 5 node.exe 'TEST_PRIVATE_COMMAND';$p.ExecutablePath=$null;try{$null=Get-Identity $p}catch{if($_.FullyQualifiedErrorId -ne 'Process identity is not readable'){throw};Write-Output OK}`);
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,env:windowsPowerShellEnvironment(process.env)});
  expect(result.status).toBe(0);expect(result.stdout.trim()).toBe('OK');
  const line=result.stderr.split(/\r?\n/).find(value=>value.startsWith('BRIDGE_NATIVE_UNREADABLE_PROCESS '));expect(line).toBeDefined();
  expect(JSON.parse(line!.slice('BRIDGE_NATIVE_UNREADABLE_PROCESS '.length))).toMatchObject({version:1,pid:12,parentPid:5,processName:'node.exe',missingExecutablePath:true,missingCommandLine:false,missingCreationDate:false});expect(line).not.toContain('TEST_PRIVATE');expect(line).not.toContain('C:\\fixture');
});
it.skipIf(process.platform!=='win32')('completes one same-identity CIM record without changing known fields',()=>{
  expect(run(`$p=P 12 5 node.exe 'tool';$p.ExecutablePath=$null;$script:fresh=$p.PSObject.Copy();$script:fresh.ExecutablePath='C:\\fixture\\node.exe';$script:calls=0;function Get-CimInstance {param($class,$Filter,$ErrorAction);$script:calls++;if($class -ne 'Win32_Process' -or $Filter -ne 'ProcessId = 12' -or $ErrorAction -ne 'Stop'){throw 'Unbounded query'};return $script:fresh};$r=Get-Identity $p;if($script:calls -ne 1 -or $r.pid -ne 12 -or $r.executable -ne $script:fresh.ExecutablePath -or $r.commandLineSha256 -ne (Get-Sha 'tool')){throw 'Recovery mismatch'};Write-Output OK`)).toBe('OK');
});
it.skipIf(process.platform!=='win32')('does not query already complete records or synthesize missing creation identity',()=>{
  expect(run(`$script:calls=0;function Get-CimInstance {$script:calls++;throw 'Unexpected query'};$p=P 12 5 node.exe 'tool';$null=Get-Identity $p;$p.CreationDate=$null;$rejected=$false;try{$null=Get-Identity $p}catch{$rejected=$true};if(!$rejected -or $script:calls -ne 0){throw 'Invalid proof'};Write-Output OK`)).toBe('OK');
});
it.skipIf(process.platform!=='win32').each([
  ['$script:fresh=$null','disappeared'],
  ['$script:fresh=@($script:fresh,$script:fresh)','duplicate'],
  ['$script:fresh.CreationDate=$script:fresh.CreationDate.AddTicks(1)','PID reused'],
  ['$script:fresh.ParentProcessId=6','parent changed'],
  ["$script:fresh.Name='other.exe'",'name changed'],
  ['$script:fresh.ProcessId=13','PID changed'],
  ["$script:fresh.CommandLine='other tool'",'known command changed'],
  ['$script:fresh.ExecutablePath=$null','persistent unreadability'],
  ['$script:fresh.CreationDate=$null','missing new creation time'],
])('rejects an incomplete or changed fixed-PID re-read: %s', (mutation)=>{
  expect(run(`$p=P 12 5 node.exe 'tool';$p.ExecutablePath=$null;$script:fresh=$p.PSObject.Copy();$script:fresh.ExecutablePath='C:\\fixture\\node.exe';${mutation};$script:calls=0;function Get-CimInstance {$script:calls++;return $script:fresh};$rejected=$false;try{$null=Get-Identity $p}catch{$rejected=$true};if(!$rejected -or $script:calls -ne 1){throw 'Invalid recovery admitted'};Write-Output OK`)).toBe('OK');
});
it.skipIf(process.platform!=='win32')('preserves access errors and rejects changes to a previously known executable',()=>{
  expect(run(`$p=P 12 5 node.exe '';$script:fresh=$p.PSObject.Copy();$script:fresh.CommandLine='tool';$script:fresh.ExecutablePath='C:\\changed\\node.exe';function Get-CimInstance {return $script:fresh};$rejected=$false;try{$null=Get-Identity $p}catch{$rejected=$true};if(!$rejected){throw 'Known path replaced'};function Get-CimInstance {throw '0x80070005'};$denied=$false;try{$null=Get-Identity $p}catch{$denied=$_.Exception.Message -eq '0x80070005'};if(!$denied){throw 'Access error hidden'};Write-Output OK`)).toBe('OK');
});
