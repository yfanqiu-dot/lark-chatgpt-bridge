param([Parameter(Mandatory=$true)][string]$ConnectionFile,[Parameter(Mandatory=$true)][string]$TokenFile,[int]$DeadlineSeconds=3600)
$ErrorActionPreference='Stop'
$taskToken=[IO.File]::ReadAllText($TokenFile,[Text.Encoding]::UTF8)
if($taskToken -notmatch '^[a-f0-9]{64}$'){throw 'Package broker token is missing'}
$taskRoot=Split-Path -Parent $ConnectionFile
$taskStatus=Join-Path $taskRoot 'package-broker.status.json'
$taskStop=Join-Path $taskRoot 'package-broker.stop'
$taskDeadline=[DateTime]::UtcNow.AddSeconds($DeadlineSeconds)
$taskActive=@{}
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
[IO.File]::WriteAllText($taskStatus,(@{pid=$PID;readyAt=[DateTime]::UtcNow.ToString('o');phase='ready'}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
try{
  while([DateTime]::UtcNow -lt $taskDeadline -and !(Test-Path -LiteralPath $taskStop)){
    foreach($taskKey in @($taskActive.Keys)){
      $record=$taskActive[$taskKey]
      try{
        $shouldStop=(Test-Path -LiteralPath (Join-Path $taskKey 'stop')) -or $record.owner.HasExited
        if($record.allowDetach -and (Test-Path -LiteralPath (Join-Path $taskKey 'detach')) -and !$record.child.HasExited){
          Save-LaunchStatus $taskKey @{version=1;phase='detached';pid=$record.child.Id;packageFullName=$record.package}
          $record.child.Dispose();$record.owner.Dispose();$taskActive.Remove($taskKey)
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
    Start-Sleep -Milliseconds 200
  }
}finally{
  foreach($taskKey in @($taskActive.Keys)){
    try{$null=Finish-Launch $taskKey $taskActive[$taskKey] $true}catch{}
  }
  [IO.File]::WriteAllText($taskStatus,(@{pid=$PID;finishedAt=[DateTime]::UtcNow.ToString('o');phase='stopped'}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
