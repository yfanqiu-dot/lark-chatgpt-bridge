import {afterEach,beforeEach,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {windowsPowerShellEnvironment} from '../../../src/desktop/windows-tools';
let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'retirement-policy-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
it.skipIf(process.platform!=='win32').each(['DisableTask','RestoreTask','StartLegacy','StopOwned'])('rejects native %s before a task or process call in new-only mode',async action=>{
  const config=join(dir,'config.json');await writeFile(config,JSON.stringify({version:1,legacyTaskOperationsAllowed:false,legacy:{profile:'fixture',scheduledTaskName:'LarkChannelBridge.Bot.fixture'}}),'utf8');
  let stderr='';try{execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',resolve('bin/desktop-runtime-control.ps1'),'-ConfigFile',config,'-Action',action,...(action==='StopOwned'?['-Role','legacy']:[])],{encoding:'utf8',windowsHide:true,env:windowsPowerShellEnvironment(process.env),stdio:['ignore','pipe','pipe']});throw Error('Mutation accepted');}catch(e){stderr=String((e as any).stderr);}
  expect(stderr).toContain('New-only runtime forbids legacy task or process mutations');
});
function readFixture(kind:string){
  const source=resolve('bin/desktop-runtime-control.ps1').replaceAll("'","''");
  const missing=kind==='absent'?`throw [Runtime.InteropServices.COMException]::new('Fixture absent',-2147024894)`:kind==='denied'?`throw [Runtime.InteropServices.COMException]::new('Fixture denied',-2147024891)`:`return $script:taskRegistered`;
  const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ast=[Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$null,[ref]$null);$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-Sha'},$true);. ([scriptblock]::Create($fn.Extent.Text));$taskConfig=@{legacy=@{profile='fixture';scheduledTaskName='LarkChannelBridge.Bot.fixture'}};$script:taskRegistered=[pscustomobject]@{Enabled=${kind==='enabled'?'$true':'$false'};State=${kind==='queued'?2:kind==='running'?4:1}};$folder=[pscustomobject]@{};Add-Member -InputObject $folder -MemberType ScriptMethod -Name GetTask -Value {${missing}};$script:folder=$folder;$script:service=[pscustomobject]@{};Add-Member -InputObject $script:service -MemberType ScriptMethod -Name Connect -Value {};Add-Member -InputObject $script:service -MemberType ScriptMethod -Name GetFolder -Value {return $script:folder};function New-Object {return $script:service};function Read-TaskDefinition {return @{enabled=${kind==='enabled'?'$true':'$false'};sha256=('b'*64)}};$block=$ast.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Clauses[0].Item1.Extent.Text -eq "$Action -eq 'TaskRetirement'"},$true);if(!$block){throw 'Retirement block missing'};& ([scriptblock]::Create($block.Extent.Text))`;
  // Literal $Action must remain in the AST search; the test sets the actual action separately.
  const fixed=script.replace('"$Action -eq', '"`$Action -eq').replace(';& ([scriptblock]', ";$Action='TaskRetirement';& ([scriptblock]");
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(fixed,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,env:windowsPowerShellEnvironment(process.env),stdio:['ignore','pipe','pipe']}));
}
it.skipIf(process.platform!=='win32').each(['disabled','absent','enabled','queued','running'])('reads %s task retirement without a real Task Scheduler write',kind=>{
  const r=readFixture(kind);expect(r.retired).toBe(['disabled','absent'].includes(kind));expect(r.taskPresent).toBe(kind!=='absent');
});
it.skipIf(process.platform!=='win32')('does not interpret inaccessible tasks as absent',()=>{expect(()=>readFixture('denied')).toThrow();});
