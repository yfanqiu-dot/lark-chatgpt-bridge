param(
  [Parameter(Mandatory=$true)][string]$ConnectionFile,
  [string]$TokenFile,
  [string]$ProtectedTokenFile,
  [ValidateRange(60,43200)][int]$DeadlineSeconds=5400,
  [ValidateRange(60,43200)][int]$BrokerDeadlineSeconds=3600,
  [string]$OwnerLeaseFile
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
function Get-WatchedBroker($id){
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$id)
  $pattern='(?:^|\s)(?:"'+[regex]::Escape($taskBroker)+'"|'+[regex]::Escape($taskBroker)+')(?:\s|$)'
  if(!$process -or $process.ExecutablePath -ne "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -or $process.CommandLine -notmatch $pattern){return $null}
  $hash=[Security.Cryptography.SHA256]::Create()
  try{$commandHash=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($process.CommandLine)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
  return @{pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;createdAt=$process.CreationDate.ToUniversalTime().ToString('o');executable=$process.ExecutablePath;commandLineSha256=$commandHash}
}
function Test-WatchedBroker($expected){
  $actual=Get-WatchedBroker $expected.pid
  if(!$actual){return $false}
  foreach($key in @('pid','parentPid','createdAt','executable','commandLineSha256')){if($actual[$key] -cne $expected[$key]){return $false}}
  return $true
}
try {
  if((!!$TokenFile) -eq (!!$ProtectedTokenFile)){throw 'Exactly one capability source is required'}
  $taskCapabilityPath=if($ProtectedTokenFile){$ProtectedTokenFile}else{$TokenFile}
  foreach($path in @($ConnectionFile,$taskCapabilityPath)){if(![IO.Path]::IsPathRooted($path) -or $path -match '["\r\n]'){throw 'Invalid broker runtime path'}}
  $taskActivatedAt=[DateTime]::UtcNow
  $taskExpectedRun=$null
  $taskCapabilityArgument=if($ProtectedTokenFile){' -ProtectedTokenFile "'+$ProtectedTokenFile+'"'}else{' -TokenFile "'+$TokenFile+'"'}
  $taskArgs='-NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "'+$taskBroker+'" -ConnectionFile "'+$ConnectionFile+'"'+$taskCapabilityArgument+' -DeadlineSeconds '+$BrokerDeadlineSeconds
  if($OwnerLeaseFile){
    if(![IO.Path]::IsPathRooted($OwnerLeaseFile) -or $OwnerLeaseFile.Contains('"')){throw 'Invalid broker lease path'}
    $taskArgs+=' -OwnerLeaseFile "'+$OwnerLeaseFile+'"'
    $taskExpectedRun=(Get-Content -LiteralPath $OwnerLeaseFile -Encoding UTF8 | ConvertFrom-Json).runId
  }
  Invoke-CommandInDesktopPackage -PackageFamilyName 'OpenAI.Codex_2p2nqsd0c76g0' -AppId App -Command "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Args $taskArgs -PreventBreakaway
  $taskDeadline=[DateTime]::UtcNow.AddSeconds($DeadlineSeconds)
  $taskBrokerPid=$null
  for($taskIndex=0;$taskIndex -lt 50;$taskIndex++){
    if(Test-Path -LiteralPath $taskStatus){
      $taskState=Get-Content -LiteralPath $taskStatus -Encoding UTF8|ConvertFrom-Json
      if($taskState.phase -eq 'ready' -and [DateTime]::Parse($taskState.readyAt).ToUniversalTime() -ge $taskActivatedAt -and (!$OwnerLeaseFile -or ($taskState.continuous -and $taskState.runId -ceq $taskExpectedRun))){
        $taskBrokerIdentity=Get-WatchedBroker $taskState.pid
        if($taskBrokerIdentity -and [DateTime]::Parse($taskBrokerIdentity.createdAt).ToUniversalTime() -ge $taskActivatedAt){$taskBrokerPid=[int]$taskState.pid;break}
      }
    }
    Start-Sleep -Milliseconds 200
  }
  if(!$taskBrokerPid){throw 'Package broker did not become ready'}
  Save-TaskStatus @{phase='watching';taskPid=$PID;brokerPid=$taskBrokerPid;brokerIdentity=$taskBrokerIdentity;runId=$taskExpectedRun;startedAt=[DateTime]::UtcNow.ToString('o')}
  while(($OwnerLeaseFile -or [DateTime]::UtcNow -lt $taskDeadline) -and !(Test-Path -LiteralPath $taskStop) -and (Test-WatchedBroker $taskBrokerIdentity)){
    Start-Sleep -Seconds 1
  }
  Save-TaskStatus @{phase='finished';taskPid=$PID;brokerPid=$taskBrokerPid;finishedAt=[DateTime]::UtcNow.ToString('o');brokerAlive=(Test-WatchedBroker $taskBrokerIdentity)}
} catch {
  Save-TaskStatus @{phase='failed';taskPid=$PID;error=$_.Exception.Message;failedAt=[DateTime]::UtcNow.ToString('o')}
  exit 1
}
