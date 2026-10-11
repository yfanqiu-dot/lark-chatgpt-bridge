param([Parameter(Mandatory=$true)][string]$ConnectionFile,[Parameter(Mandatory=$true)][string]$TokenFile,[ValidateRange(60,43200)][int]$DeadlineSeconds=3600,[string]$OwnerLeaseFile,[ValidateRange(90,300)][int]$DrainSeconds=180)
$ErrorActionPreference='Stop'
$taskToken=[IO.File]::ReadAllText($TokenFile,[Text.Encoding]::UTF8)
if($taskToken -notmatch '^[a-f0-9]{64}$'){throw 'Package broker token is missing'}
$taskRoot=Split-Path -Parent $ConnectionFile
$taskStatus=Join-Path $taskRoot 'package-broker.status.json'
$taskStop=Join-Path $taskRoot 'package-broker.stop'
$taskDeadline=[DateTime]::UtcNow.AddSeconds($DeadlineSeconds)
$taskActive=@{}
$taskContinuous=!!$OwnerLeaseFile
$taskRunId=$null;$taskLeaseOwner=$null;$taskLastLeaseRevision=-1;$taskDraining=$false;$taskDrainUntil=$null;$taskOrdinaryDetached=$false
function Get-BrokerSha($text){
  $hash=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
}
function Test-BrokerLease($lease,$runId,$tokenHash,$package,$now,$actualOwner){
  if(!$lease -or $lease.version -ne 1 -or $lease.runId -notmatch '^[a-f0-9-]{36}$' -or ($runId -and $lease.runId -cne $runId) -or $lease.tokenSha256 -cne $tokenHash -or $lease.packageFullName -cne $package -or $lease.revision -lt 0 -or $lease.expiresAt -le $now -or $lease.expiresAt -gt ($now+30000) -or !$actualOwner){return $false}
  foreach($key in @('pid','parentPid','createdAt','executable','commandLineSha256')){if($lease.owner.$key -cne $actualOwner.$key){return $false}}
  return $true
}
function Test-BrokerLaunchAllowed([bool]$draining,$request){
  return !$draining -or (!$request.endpoint -and $request.allowDetach -is [bool] -and $request.allowDetach)
}
function Test-BrokerDrainComplete([bool]$draining,[bool]$ordinaryDetached,[int]$activeCount,$now,$until){
  return $draining -and (($ordinaryDetached -and $activeCount -eq 0) -or $now -ge $until)
}
function Read-BrokerLease {
  try{
    $lease=Get-Content -LiteralPath $OwnerLeaseFile -Encoding UTF8 | ConvertFrom-Json
    if(!$lease.owner -or $lease.owner.pid -le 0){return $null}
    if($taskLeaseOwner){foreach($key in @('pid','parentPid','createdAt','executable','commandLineSha256')){if($lease.owner.$key -cne $taskLeaseOwner.$key){return $null}}}
    if($lease.revision -lt $taskLastLeaseRevision){return $null}
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$lease.owner.pid)
    if(!$process -or !$process.ExecutablePath -or !$process.CommandLine){return $null}
    $owner=@{pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;createdAt=$process.CreationDate.ToUniversalTime().ToString('o');executable=[string]$process.ExecutablePath;commandLineSha256=(Get-BrokerSha $process.CommandLine)}
    if(Test-BrokerLease $lease $taskRunId (Get-BrokerSha $taskToken) $taskCurrentPackage ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) $owner){return $lease}
  }catch{}
  return $null
}
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class BridgeBrokerPackage {
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern int GetCurrentPackageFullName(ref uint length,StringBuilder name);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern int GetPackageFullName(IntPtr process,ref uint length,StringBuilder name);
  public static string Read(IntPtr process){uint length=0;int code=process==IntPtr.Zero?GetCurrentPackageFullName(ref length,null):GetPackageFullName(process,ref length,null);if(code!=122)throw new Win32Exception(code);var name=new StringBuilder((int)length);code=process==IntPtr.Zero?GetCurrentPackageFullName(ref length,name):GetPackageFullName(process,ref length,name);if(code!=0)throw new Win32Exception(code);return name.ToString();}
  public static void ReplaceFile(string source,string target){System.IO.File.Replace(source,target,null);}
}
'@
$taskCurrentPackage=[BridgeBrokerPackage]::Read([IntPtr]::Zero)
if($taskCurrentPackage -notmatch '^OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0$'){throw 'Broker is not running in the Codex package'}
if($taskContinuous){
  if(![IO.Path]::IsPathRooted($OwnerLeaseFile) -or [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($OwnerLeaseFile)) -ne [IO.Path]::GetFullPath($taskRoot)){throw 'Broker owner lease must be in its runtime directory'}
  $taskLease=Read-BrokerLease
  if(!$taskLease){throw 'Broker requires a fresh verified owner lease'}
  $taskRunId=$taskLease.runId;$taskLeaseOwner=$taskLease.owner;$taskLastLeaseRevision=[long]$taskLease.revision
}
function Save-LaunchStatus($directory,$value){
  $statusPath=Join-Path $directory 'status.json'
  $tempPath=$statusPath+'.tmp'
  [IO.File]::WriteAllText($tempPath,($value|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
  if([IO.File]::Exists($statusPath)){[BridgeBrokerPackage]::ReplaceFile($tempPath,$statusPath)}else{[IO.File]::Move($tempPath,$statusPath)}
}
function Finish-Launch($directory,$record,$stopRequested){
  $child=$record.child
  if($stopRequested -and !$child.HasExited){$child.Kill();if(!$child.WaitForExit(10000)){throw 'Owned desktop did not stop'}}
  if(!$child.HasExited){return $false}
  Save-LaunchStatus $directory @{version=1;phase='exited';pid=$child.Id;packageFullName=$record.package;exitCode=$child.ExitCode}
  $child.Dispose();$record.owner.Dispose();return $true
}
[IO.File]::WriteAllText($taskStatus,(@{pid=$PID;readyAt=[DateTime]::UtcNow.ToString('o');phase='ready';continuous=$taskContinuous;runId=$taskRunId}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
$taskNextLeaseCheck=[DateTime]::UtcNow
try{
  while(($taskContinuous -or [DateTime]::UtcNow -lt $taskDeadline) -and !(Test-Path -LiteralPath $taskStop)){
    if($taskContinuous -and !$taskDraining -and [DateTime]::UtcNow -ge $taskNextLeaseCheck){
      $taskNextLeaseCheck=[DateTime]::UtcNow.AddSeconds(1)
      $taskLease=Read-BrokerLease
      if($taskLease){$taskLastLeaseRevision=[long]$taskLease.revision}else{
        $taskDraining=$true;$taskDrainUntil=[DateTime]::UtcNow.AddSeconds($DrainSeconds)
        [IO.File]::WriteAllText(($ConnectionFile+'.stop'),'Broker owner lease lost; stop shared host and restore ordinary desktop',[Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($taskStatus,(@{pid=$PID;phase='draining';runId=$taskRunId;reason='owner_lease_lost';drainUntil=$taskDrainUntil.ToString('o')}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
      }
    }
    foreach($taskKey in @($taskActive.Keys)){
      $record=$taskActive[$taskKey]
      try{
        $shouldStop=(Test-Path -LiteralPath (Join-Path $taskKey 'stop')) -or $record.owner.HasExited
        if($record.allowDetach -and (Test-Path -LiteralPath (Join-Path $taskKey 'detach')) -and !$record.child.HasExited){
          Save-LaunchStatus $taskKey @{version=1;phase='detached';pid=$record.child.Id;packageFullName=$record.package}
          $record.child.Dispose();$record.owner.Dispose();$taskActive.Remove($taskKey)
          if($taskDraining){$taskOrdinaryDetached=$true}
        }elseif(Finish-Launch $taskKey $record $shouldStop){$taskActive.Remove($taskKey)}
      }catch{
        [IO.File]::WriteAllText((Join-Path $taskKey 'broker.error'),$_.Exception.Message,[Text.UTF8Encoding]::new($false))
        throw
      }
    }
    foreach($taskDir in @(Get-ChildItem -LiteralPath $taskRoot -Directory -Filter '.desktop-launch-*' -ErrorAction SilentlyContinue)){
      $taskRequestPath=Join-Path $taskDir.FullName 'request.json'
      $taskDone=Join-Path $taskDir.FullName 'activation.done'
      if(!(Test-Path -LiteralPath $taskRequestPath) -or (Test-Path -LiteralPath $taskDone)){continue}
      $taskChild=$null;$taskOwner=$null
      try{
        $taskRequest=Get-Content -LiteralPath $taskRequestPath -Encoding UTF8 | ConvertFrom-Json
        if($taskRequest.version -ne 1 -or $taskRequest.brokerToken -cne $taskToken){continue}
        if(!(Test-BrokerLaunchAllowed $taskDraining $taskRequest)){throw 'Broker is draining; shared launch refused'}
        if($taskRequest.packageFullName -cne $taskCurrentPackage){throw 'Broker package version differs from requested desktop'}
        $taskExe=[IO.Path]::GetFullPath([string]$taskRequest.desktopExe)
        $taskExpected=Join-Path "C:\Program Files\WindowsApps\$taskCurrentPackage" 'app\ChatGPT.exe'
        if($taskExe -ne $taskExpected){throw 'Desktop executable does not match installed package'}
        if(Test-Path -LiteralPath (Join-Path $taskDir.FullName 'stop')){throw 'Launch was canceled'}
        $taskOwner=[Diagnostics.Process]::GetProcessById([int]$taskRequest.ownerPid)
        $null=$taskOwner.Handle
        if($taskOwner.HasExited){throw 'Launch owner exited'}
        $taskInfo=[Diagnostics.ProcessStartInfo]::new()
        $taskInfo.FileName=$taskExe
        $taskInfo.WorkingDirectory=[string]$taskRequest.projectRoot
        $taskInfo.UseShellExecute=$false
        $taskInfo.CreateNoWindow=$true
        foreach($taskEnvKey in @($taskInfo.EnvironmentVariables.Keys)){
          if($taskEnvKey -like 'CODEX_*' -or $taskEnvKey -like 'NODE_REPL_*'){$taskInfo.EnvironmentVariables.Remove($taskEnvKey)}
        }
        if($taskRequest.codexHome){$taskInfo.EnvironmentVariables['CODEX_HOME']=[string]$taskRequest.codexHome}
        if($taskRequest.endpoint){$taskInfo.EnvironmentVariables['CODEX_APP_SERVER_WS_URL']=[string]$taskRequest.endpoint}
        $taskChild=[Diagnostics.Process]::Start($taskInfo)
        if(!$taskChild){throw 'Desktop process did not start'}
        $taskChildPackage=[BridgeBrokerPackage]::Read($taskChild.Handle)
        if($taskChildPackage -cne $taskCurrentPackage){throw 'Desktop child lost its package identity'}
        Save-LaunchStatus $taskDir.FullName @{version=1;phase='running';pid=$taskChild.Id;packageFullName=$taskChildPackage}
        $taskActive[$taskDir.FullName]=@{child=$taskChild;owner=$taskOwner;package=$taskChildPackage;allowDetach=[bool]$taskRequest.allowDetach}
        [IO.File]::WriteAllText($taskDone,'activated',[Text.UTF8Encoding]::new($false))
      }catch{
        if($taskChild -and !$taskChild.HasExited){$taskChild.Kill();$null=$taskChild.WaitForExit(10000)}
        if($taskChild){$taskChild.Dispose()};if($taskOwner){$taskOwner.Dispose()}
        [IO.File]::WriteAllText((Join-Path $taskDir.FullName 'activation.error'),$_.Exception.Message,[Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText($taskDone,'failed',[Text.UTF8Encoding]::new($false))
      }
    }
    if(Test-BrokerDrainComplete $taskDraining $taskOrdinaryDetached $taskActive.Count ([DateTime]::UtcNow) $taskDrainUntil){break}
    Start-Sleep -Milliseconds 200
  }
}finally{
  foreach($taskKey in @($taskActive.Keys)){
    try{$null=Finish-Launch $taskKey $taskActive[$taskKey] $true}catch{}
  }
  [IO.File]::WriteAllText($taskStatus,(@{pid=$PID;finishedAt=[DateTime]::UtcNow.ToString('o');phase='stopped';runId=$taskRunId;ownerLeaseLost=$taskDraining;ordinaryDetached=$taskOrdinaryDetached;drainTimedOut=($taskDraining -and !$taskOrdinaryDetached)}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
