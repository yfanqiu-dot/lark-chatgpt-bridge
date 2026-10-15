import { execFileSync } from 'node:child_process';
import {readFileSync} from 'node:fs';
import { expect,it } from 'vitest';
import { cleanDesktopEnvironment,windowsPowerShellEnvironment } from '../../../src/desktop/windows-tools';

it('only removes inherited module paths for Windows PowerShell children',()=>{
  const source={PATH:'keep',CODEX_HOME:'home',CODEX_THREAD_ID:'old',NODE_REPL_THREAD:'old',PSModulePath:'pwsh-only',PSMODULEPATH:'alternate-case'};
  expect(windowsPowerShellEnvironment(source)).toEqual({PATH:'keep',CODEX_HOME:'home'});
  expect(cleanDesktopEnvironment(source)).toMatchObject({PSModulePath:'pwsh-only',PSMODULEPATH:'alternate-case'});
  expect(source.PSModulePath).toBe('pwsh-only');
});
it.skipIf(process.platform!=='win32')('loads core hash and CIM commands despite a foreign parent module path',()=>{
  const env=windowsPowerShellEnvironment({...process.env,PSModulePath:'C:\\foreign-pwsh-modules'});
  const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop';$null=Get-Command Get-FileHash;$null=Get-Command Get-CimInstance;Write-Output CORE_MODULES_AVAILABLE"],{encoding:'utf8',windowsHide:true,env});
  expect(output.trim()).toBe('CORE_MODULES_AVAILABLE');
});
it.skipIf(process.platform!=='win32').each([
  ['bin/desktop-cold-launch.ps1','taskNames'],
  ['bin/desktop-supervisor-launch.ps1','names'],
])('preserves native executable pipeline invocation in the restricted %s child environment',(file,variable)=>{
  const source=readFileSync(file,'utf8'),assignment=source.match(new RegExp('\\$'+variable+'=@\\(([^)]*)\\)'));
  expect(assignment).not.toBeNull();
  const names=[...assignment![1]!.matchAll(/'([^']+)'/g)].map(match=>match[1]!.toLowerCase());
  const code="$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';if($env:CODEX_THREAD_ID -or $env:NODE_REPL_SECRET){throw 'Private parent environment inherited'};$identity=(& (Join-Path $env:SystemRoot 'System32/whoami.exe') /logonid | Out-String);if($LASTEXITCODE -ne 0 -or $identity -notmatch 'S-1-5-5-\\d+-\\d+'){throw 'Native login command failed'};Write-Output NATIVE_PIPELINE_OK";
  const encoded=Buffer.from(code,'utf16le').toString('base64'),allow=names.map(name=>"'"+name+"'").join(',');
  const parent=`$ErrorActionPreference='Stop';$env:CODEX_THREAD_ID='excluded-parent-thread';$env:NODE_REPL_SECRET='excluded-parent-secret';$names=@(${allow});$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe';$info.Arguments='-NoProfile -NonInteractive -EncodedCommand ${encoded}';$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.EnvironmentVariables.Clear();foreach($row in Get-ChildItem Env:){if($row.Name -in $names){$info.EnvironmentVariables[$row.Name]=$row.Value}};$child=[Diagnostics.Process]::Start($info);try{if(!$child.WaitForExit(10000)){$child.Kill();throw 'Native child timed out'};$text=$child.StandardOutput.ReadToEnd();$errorText=$child.StandardError.ReadToEnd();if($child.ExitCode -ne 0){throw $errorText};Write-Output $text.Trim()}finally{$child.Dispose()}`;
  expect(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(parent,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,env:windowsPowerShellEnvironment(process.env),timeout:15000}).trim()).toBe('NATIVE_PIPELINE_OK');
});
