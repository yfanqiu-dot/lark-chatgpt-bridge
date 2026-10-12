import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect,it } from 'vitest';
import { windowsPowerShellEnvironment } from '../../../src/desktop/windows-tools';
function run(assertion:string){
  const source=resolve('bin/desktop-runtime-control.ps1').replaceAll("'","''");
  const code=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$ast=[Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$null,[ref]$null);foreach($name in @('Get-Sha','Has-Argument','Get-Identity','Get-ColdRelated')){$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);if(!$fn){throw 'Missing helper'};. ([scriptblock]::Create($fn.Extent.Text))};function P($id,$parent,$name,$command){[pscustomobject]@{ProcessId=$id;ParentProcessId=$parent;Name=$name;ExecutablePath='C:\fixture\'+$name;CommandLine=$command;CreationDate=[DateTime]::UtcNow}};${assertion}`;
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,env:windowsPowerShellEnvironment(process.env)}).trim();
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
