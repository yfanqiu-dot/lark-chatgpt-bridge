param(
  [Parameter(Mandatory=$true)][string]$ConnectionFile,
  [Parameter(Mandatory=$true)][string]$TokenFile,
  [ValidateRange(60,43200)][int]$DeadlineSeconds=5400,
  [ValidateRange(60,43200)][int]$BrokerDeadlineSeconds=3600
)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path -Parent $ConnectionFile
$taskBroker=Join-Path $PSScriptRoot 'desktop-package-broker.ps1'
$taskStop=Join-Path $taskRoot 'package-broker.stop'
$taskStatus=Join-Path $taskRoot 'package-broker.status.json'
$taskReport=Join-Path $taskRoot 'package-broker-task.status.json'
function Save-TaskStatus($value){
  [IO.File]::WriteAllText($taskReport,($value|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
}
try {
  $taskArgs='-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "'+$taskBroker+'" -ConnectionFile "'+$ConnectionFile+'" -TokenFile "'+$TokenFile+'" -DeadlineSeconds '+$BrokerDeadlineSeconds
  Invoke-CommandInDesktopPackage -PackageFamilyName 'OpenAI.Codex_2p2nqsd0c76g0' -AppId App -Command "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Args $taskArgs -PreventBreakaway
  $taskDeadline=[DateTime]::UtcNow.AddSeconds($DeadlineSeconds)
  $taskBrokerPid=$null
  for($taskIndex=0;$taskIndex -lt 50;$taskIndex++){
    if(Test-Path -LiteralPath $taskStatus){
      $taskState=Get-Content -LiteralPath $taskStatus -Encoding UTF8|ConvertFrom-Json
      if($taskState.phase -eq 'ready' -and (Get-Process -Id $taskState.pid -ErrorAction SilentlyContinue)){$taskBrokerPid=[int]$taskState.pid;break}
    }
    Start-Sleep -Milliseconds 200
  }
  if(!$taskBrokerPid){throw 'Package broker did not become ready'}
  Save-TaskStatus @{phase='watching';taskPid=$PID;brokerPid=$taskBrokerPid;startedAt=[DateTime]::UtcNow.ToString('o')}
  while([DateTime]::UtcNow -lt $taskDeadline -and !(Test-Path -LiteralPath $taskStop) -and (Get-Process -Id $taskBrokerPid -ErrorAction SilentlyContinue)){
    Start-Sleep -Seconds 1
  }
  Save-TaskStatus @{phase='finished';taskPid=$PID;brokerPid=$taskBrokerPid;finishedAt=[DateTime]::UtcNow.ToString('o');brokerAlive=[bool](Get-Process -Id $taskBrokerPid -ErrorAction SilentlyContinue)}
} catch {
  Save-TaskStatus @{phase='failed';taskPid=$PID;error=$_.Exception.Message;failedAt=[DateTime]::UtcNow.ToString('o')}
  exit 1
}
