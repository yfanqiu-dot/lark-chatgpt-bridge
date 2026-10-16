import { execFileSync } from 'node:child_process';
import {readFileSync} from 'node:fs';
import { expect,it } from 'vitest';
import { cleanDesktopEnvironment,windowsPowerShellEnvironment } from '../../../src/desktop/windows-tools';
import {nativeEnvironmentFixture} from '../../helpers/windows-native-environment';

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
])('preserves native executable pipeline invocation in the restricted %s child environment',async(file,variable)=>{
  const source=readFileSync(file,'utf8'),assignment=source.match(new RegExp('\\$'+variable+'=@\\(([^)]*)\\)'));
  expect(assignment).not.toBeNull();
  const names=[...assignment![1]!.matchAll(/'([^']+)'/g)].map(match=>match[1]!.toLowerCase());
  expect(await nativeEnvironmentFixture(names)).toMatchObject({passed:true,marker:'NATIVE_PIPELINE_OK',stderrDrained:true,privateEnvironmentInherited:false});
},45000);
it.skipIf(process.platform!=='win32')('detects the missing PATHEXT regression with the same native fixture',async()=>{
  const source=readFileSync('bin/desktop-cold-launch.ps1','utf8'),assignment=source.match(/\$taskNames=@\(([^)]*)\)/)!;
  const names=[...assignment[1]!.matchAll(/'([^']+)'/g)].map(match=>match[1]!).filter(name=>name.toLowerCase()!=='pathext');
  expect(await nativeEnvironmentFixture(names)).toMatchObject({passed:false,phase:'native-command',timedOut:false,nativeInvocationRejected:true});
},45000);
