import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {expect,it} from 'vitest';
import {windowsPowerShellEnvironment} from '../../../src/desktop/windows-tools';

it.skipIf(process.platform!=='win32')('reads live IPv4, IPv6, wildcard and same-port owners exactly like the Windows TCP inventory',()=>{
  const source=resolve('bin/desktop-runtime-control.ps1').replaceAll("'","''");
  const code=String.raw`
$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$null,[ref]$null)
$fn=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Open-ProcessExitObservation'},$true)
. ([scriptblock]::Create($fn.Extent.Text));$null=Open-ProcessExitObservation $null
$listeners=[Collections.Generic.List[object]]::new()
function Start-TestListener([string]$address,[int]$port=0){
  $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($address),$port)
  if($listener.Server.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6){$listener.Server.DualMode=$false}
  $listener.Start();$listeners.Add($listener);return $listener
}
try{
  $a=Start-TestListener '127.0.0.1';$b=Start-TestListener '::1' $a.LocalEndpoint.Port
  $c=Start-TestListener '0.0.0.0';$d=Start-TestListener '::'
  $ports=@($listeners|ForEach-Object{$_.LocalEndpoint.Port}|Sort-Object -Unique)
  $native=@([BridgeTcpListeners]::Read()|Where-Object{$_.LocalPort -in $ports})
  $reference=@(Get-NetTCPConnection -State Listen -ErrorAction Stop|Where-Object{$_.LocalPort -in $ports})
  function Key($row){return [string]$row.LocalAddress+':'+[string]$row.LocalPort+':'+[string]$row.OwningProcess}
  $actual=(@($native|ForEach-Object{Key $_}|Sort-Object) -join ',')
  $expected=(@($reference|ForEach-Object{Key $_}|Sort-Object) -join ',')
  if($actual -cne $expected -or $native.Count -ne 4){throw 'TCP listener address, port or owner differs from Windows'}
  if(@($native|Where-Object{$_.OwningProcess -ne $PID}).Count){throw 'Fixture owner missing'}
  foreach($address in @('127.0.0.1','::1','0.0.0.0','::')){if(@($native|Where-Object{$_.LocalAddress -ceq $address}).Count -ne 1){throw 'Address family or wildcard listener hidden'}}
  if(@($native|Where-Object{$_.LocalPort -eq $a.LocalEndpoint.Port}).Count -ne 2){throw 'Same-port conflicting family hidden'}
  foreach($listener in $listeners){$listener.Stop()}
  if(@([BridgeTcpListeners]::Read()|Where-Object{$_.LocalPort -in $ports -and $_.OwningProcess -eq $PID}).Count){throw 'Closed listener returned from a cached table'}
  Write-Output OK
}finally{foreach($listener in $listeners){$listener.Stop()}}
`;
  expect(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,env:windowsPowerShellEnvironment(process.env),encoding:'utf8',timeout:20000}).trim()).toBe('OK');
},25000);
