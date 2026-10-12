import { execFileSync } from 'node:child_process';
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
