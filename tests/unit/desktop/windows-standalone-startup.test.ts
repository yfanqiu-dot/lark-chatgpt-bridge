import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect,it } from 'vitest';

it.skipIf(process.platform!=='win32')('uses hidden detached startup with a limited Unicode environment',()=>{
  const source=resolve('bin/desktop-supervisor-launch.ps1').replaceAll("'","''");
  const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$ast=[Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$null,[ref]$null);$fn=$ast.Find({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'New-StandaloneStartup'},$true);if(!$fn){throw 'Startup helper missing'};. ([scriptblock]::Create($fn.Extent.Text));function Get-ChildItem($path){@([pscustomobject]@{Name='Path';Value='safe'},[pscustomobject]@{Name='CODEX_HOME';Value='home'},[pscustomobject]@{Name='CODEX_THREAD_ID';Value='old'},[pscustomobject]@{Name='AUTH_TOKEN';Value='SECRET'})};function New-CimInstance($ClassName,[switch]$ClientOnly,$Property){return $Property};$value=New-StandaloneStartup;if($value.ShowWindow -ne 0 -or $value.CreateFlags -ne 1032 -or $value.EnvironmentVariables.Count -ne 2 -or $value.EnvironmentVariables -notcontains 'Path=safe' -or $value.EnvironmentVariables -notcontains 'CODEX_HOME=home'){throw 'Unsafe startup settings'};Write-Output OK`;
  expect(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}).trim()).toBe('OK');
});
