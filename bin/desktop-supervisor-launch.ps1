param(
  [Parameter(Mandatory=$true)][ValidateSet('Launch','InspectIdentity')][string]$Action,
  [Parameter(Mandatory=$true)][string]$PlanFile,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$PlanSha256,
  [int]$ProcessId
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Get-LaunchSha($text){
  $hash=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
}
function New-StandaloneStartup {
  $names=@('Path','SystemRoot','ComSpec','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramData','CODEX_HOME','LANG')
  $variables=@(Get-ChildItem Env: | Where-Object {$_.Name -in $names} | ForEach-Object {$_.Name+'='+$_.Value})
  # Win32_ProcessStartup's documented Detached_Process + Unicode environment.
  # https://learn.microsoft.com/windows/win32/cimwin32prov/win32-processstartup
  return New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]1032;EnvironmentVariables=[string[]]$variables}
}
if(![IO.Path]::IsPathRooted($PlanFile) -or (Get-FileHash -LiteralPath $PlanFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $PlanSha256){throw 'Standalone plan changed'}
$taskPlan=Get-Content -LiteralPath $PlanFile -Encoding UTF8 | ConvertFrom-Json
if($taskPlan.version -ne 1 -or $taskPlan.mode -ne 'preflight' -or $taskPlan.planId -notmatch '^[a-f0-9-]{36}$' -or $taskPlan.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()){throw 'Invalid or expired preflight plan'}
foreach($path in @($PlanFile,$taskPlan.nodeExecutable,$taskPlan.workerEntryPoint,$taskPlan.launcherScript,$taskPlan.directory)){
  if(![IO.Path]::IsPathRooted($path) -or $path -match '["\r\n]'){throw 'Invalid standalone path'}
}
if([IO.Path]::GetFullPath($taskPlan.directory) -ne [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PlanFile)) -or [IO.Path]::GetFullPath($taskPlan.workerEntryPoint) -ne (Join-Path $PSScriptRoot 'lark-chatgpt-supervisor.mjs') -or [IO.Path]::GetFileName($taskPlan.nodeExecutable) -ne 'node.exe' -or [IO.Path]::GetFullPath($taskPlan.launcherScript) -ne $PSCommandPath){throw 'Standalone program identity changed'}
if(@($taskPlan.files).Count -ne 7){throw 'Standalone program proofs missing'}
foreach($required in @($taskPlan.nodeExecutable,$taskPlan.workerEntryPoint,$taskPlan.launcherScript,(Join-Path $PSScriptRoot '..\dist\desktop-standalone.js'),(Join-Path $PSScriptRoot 'desktop-runtime-control.ps1'),(Join-Path $PSScriptRoot 'lark-chatgpt-deploy.mjs'),(Join-Path $PSScriptRoot '..\dist\desktop-deploy.js'))){
  if(!@($taskPlan.files | Where-Object {[IO.Path]::GetFullPath($_.path) -eq [IO.Path]::GetFullPath($required)}).Count){throw 'Standalone program proof missing'}
}
foreach($file in $taskPlan.files){if((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw 'Standalone program proof changed'}}
$taskCommand='"'+$taskPlan.nodeExecutable+'" "'+$taskPlan.workerEntryPoint+'" --preflight "'+$PlanFile+'" '+$PlanSha256
function Read-WorkerIdentity($id){
  if($id -le 0){throw 'Invalid standalone PID'}
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$id)
  if(!$process -or $process.ExecutablePath -ne $taskPlan.nodeExecutable -or $process.CommandLine -cne $taskCommand){throw 'Standalone worker identity changed'}
  return @{pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;createdAt=$process.CreationDate.ToUniversalTime().ToString('o');executable=$process.ExecutablePath;commandLineSha256=(Get-LaunchSha $process.CommandLine)}
}
if($Action -eq 'InspectIdentity'){
  Read-WorkerIdentity $ProcessId | ConvertTo-Json -Compress
  exit 0
}
$taskIntent=Get-Content -LiteralPath (Join-Path $taskPlan.directory 'launch.intent.json') -Encoding UTF8 | ConvertFrom-Json
if($taskIntent.planId -cne $taskPlan.planId -or $taskIntent.planSha256 -cne $PlanSha256 -or $taskIntent.mode -ne 'preflight'){throw 'Standalone launch intent missing'}
$taskStarted=[DateTime]::UtcNow
$taskClaim=[IO.File]::Open((Join-Path $taskPlan.directory 'launch.claim.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$bytes=[Text.Encoding]::UTF8.GetBytes((@{planId=$taskPlan.planId;planSha256=$PlanSha256;claimedAt=$taskStarted.ToString('o')}|ConvertTo-Json -Compress));$taskClaim.Write($bytes,0,$bytes.Length)}finally{$taskClaim.Dispose()}
$taskStartup=New-StandaloneStartup
$taskCreated=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$taskCommand;CurrentDirectory=$taskPlan.directory;ProcessStartupInformation=$taskStartup}
$taskNative=@{version=1;planId=$taskPlan.planId;returnValue=[int]$taskCreated.ReturnValue;processId=[int]$taskCreated.ProcessId;observedAt=[DateTime]::UtcNow.ToString('o')}
$taskBytes=[Text.Encoding]::UTF8.GetBytes(($taskNative|ConvertTo-Json -Compress))
$taskStream=[IO.File]::Open((Join-Path $taskPlan.directory 'native-creation.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$taskStream.Write($taskBytes,0,$taskBytes.Length)}finally{$taskStream.Dispose()}
if($taskCreated.ReturnValue -ne 0 -or !$taskCreated.ProcessId){throw 'Native standalone process creation failed'}
$taskIdentity=Read-WorkerIdentity $taskCreated.ProcessId
if([DateTime]::Parse($taskIdentity.createdAt).ToUniversalTime() -lt $taskStarted.AddSeconds(-1)){throw 'Standalone worker creation time changed'}
$taskReceipt=@{version=1;planId=$taskPlan.planId;mode='preflight';phase='launched';identity=$taskIdentity;servicesChanged=$false;productionReady=$false}
$taskBytes=[Text.Encoding]::UTF8.GetBytes(($taskReceipt|ConvertTo-Json -Depth 5 -Compress))
$taskStream=[IO.File]::Open((Join-Path $taskPlan.directory 'launch.receipt.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try{$taskStream.Write($taskBytes,0,$taskBytes.Length)}finally{$taskStream.Dispose()}
$taskReceipt | ConvertTo-Json -Depth 5 -Compress
