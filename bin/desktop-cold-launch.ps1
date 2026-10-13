param([Parameter(Mandatory=$true)][string]$PlanFile,[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$PlanSha256,[ValidateSet('Run','Recover')][string]$WorkerMode='Run')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Sha($text){$hash=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}}
if(![IO.Path]::IsPathRooted($PlanFile) -or (Get-FileHash -LiteralPath $PlanFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $PlanSha256){throw 'Runtime plan changed'}
$taskPlan=Get-Content -LiteralPath $PlanFile -Encoding UTF8 | ConvertFrom-Json
if($taskPlan.version -ne 1 -or $taskPlan.mode -ne 'cold' -or $taskPlan.planId -notmatch '^[a-f0-9-]{36}$' -or ($WorkerMode -eq 'Run' -and $taskPlan.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())){throw 'Invalid runtime plan'}
foreach($path in @($taskPlan.directory,$taskPlan.root,$taskPlan.nodeExecutable,$PlanFile)){if(![IO.Path]::IsPathRooted($path) -or $path -match '["\r\n]'){throw 'Invalid runtime path'}}
if([IO.Path]::GetFullPath($taskPlan.directory) -ne [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($PlanFile)) -or [IO.Path]::GetFullPath($taskPlan.root) -ne (Split-Path -Parent $PSScriptRoot) -or [IO.Path]::GetFileName($taskPlan.nodeExecutable) -ne 'node.exe'){throw 'Runtime program path changed'}
if($taskPlan.taskControl -and $taskPlan.taskControl -ne 'uac'){throw 'Unsupported scoped task control'}
if($taskPlan.channelMode -and ($taskPlan.channelMode -ne 'new-only' -or $taskPlan.taskControl)){throw 'Unsupported channel policy or legacy control in new-only mode'}
if(@($taskPlan.files).Count -ne (9+[int](!!$taskPlan.taskControl))){throw 'Runtime program proofs missing'}
$taskRequired=@($taskPlan.nodeExecutable,(Join-Path $PSScriptRoot 'lark-chatgpt-runtime-supervisor.mjs'),$PSCommandPath,(Join-Path $PSScriptRoot '..\dist\desktop-runtime-supervisor.js'),(Join-Path $PSScriptRoot 'desktop-runtime-control.ps1'),(Join-Path $PSScriptRoot 'lark-chatgpt-host.mjs'),(Join-Path $PSScriptRoot 'lark-chatgpt-topics.mjs'),(Join-Path $PSScriptRoot 'desktop-package-broker.ps1'),(Join-Path $PSScriptRoot 'desktop-package-broker-task.ps1'))
if($taskPlan.taskControl -eq 'uac'){$taskRequired+=(Join-Path $PSScriptRoot 'desktop-task-uac.ps1')}
foreach($required in $taskRequired){if(@($taskPlan.files|Where-Object{[IO.Path]::GetFullPath($_.path) -eq [IO.Path]::GetFullPath($required)}).Count -ne 1){throw 'Runtime proof incomplete'}}
foreach($file in $taskPlan.files){if((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256){throw 'Runtime program changed'}}
$taskName=if($WorkerMode -eq 'Run'){'launch'}else{'recovery'}
$taskIntent=Get-Content -LiteralPath (Join-Path $taskPlan.directory ($taskName+'.intent.json')) -Encoding UTF8|ConvertFrom-Json
if($taskIntent.planId -cne $taskPlan.planId -or $taskIntent.planSha256 -cne $PlanSha256 -or $taskIntent.workerMode -cne $WorkerMode){throw 'Runtime launch intent missing'}
if($WorkerMode -eq 'Recover'){
  $taskState=Get-Content -LiteralPath (Join-Path $taskPlan.directory 'supervisor.json') -Encoding UTF8|ConvertFrom-Json
  if($taskState.phase -eq 'restored'){throw 'Runtime already restored'}
  $taskLeasePath=Join-Path $taskPlan.directory 'broker-owner.json'
  if(Test-Path -LiteralPath $taskLeasePath){
    $taskLease=Get-Content -LiteralPath $taskLeasePath -Encoding UTF8|ConvertFrom-Json
    $taskOwner=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$taskLease.owner.pid)
    if($taskOwner -and $taskOwner.CreationDate.ToUniversalTime().ToString('o') -ceq $taskLease.owner.createdAt){throw 'Original supervisor still exists'}
  }
}
$taskClaim=[IO.File]::Open((Join-Path $taskPlan.directory ($taskName+'.claim')),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$taskClaim.Dispose()
$taskNames=@('Path','SystemRoot','ComSpec','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','ProgramFiles','ProgramData','CODEX_HOME','LANG')
$taskEnvironment=@(Get-ChildItem Env:|Where-Object{$_.Name -in $taskNames}|ForEach-Object{$_.Name+'='+$_.Value})
$taskStartup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0;CreateFlags=[uint32]1032;EnvironmentVariables=[string[]]$taskEnvironment}
$taskArgument=if($WorkerMode -eq 'Run'){'--run'}else{'--recover'}
$taskCommand='"'+$taskPlan.nodeExecutable+'" "'+(Join-Path $PSScriptRoot 'lark-chatgpt-runtime-supervisor.mjs')+'" '+$taskArgument+' "'+$PlanFile+'" '+$PlanSha256
$taskCreated=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$taskCommand;CurrentDirectory=$taskPlan.directory;ProcessStartupInformation=$taskStartup}
[IO.File]::WriteAllText((Join-Path $taskPlan.directory ($taskName+'.native.json')),(@{returnValue=[int]$taskCreated.ReturnValue;pid=[int]$taskCreated.ProcessId}|ConvertTo-Json -Compress),[Text.UTF8Encoding]::new($false))
if($taskCreated.ReturnValue -ne 0 -or !$taskCreated.ProcessId){throw 'Runtime native creation failed'}
$taskProcess=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$taskCreated.ProcessId)
if(!$taskProcess -or $taskProcess.CommandLine -cne $taskCommand -or $taskProcess.ExecutablePath -ne $taskPlan.nodeExecutable){throw 'Runtime identity receipt unconfirmed'}
$taskReceipt=@{version=1;planId=$taskPlan.planId;workerMode=$WorkerMode;identity=@{pid=[int]$taskProcess.ProcessId;parentPid=[int]$taskProcess.ParentProcessId;createdAt=$taskProcess.CreationDate.ToUniversalTime().ToString('o');executable=$taskProcess.ExecutablePath;commandLineSha256=(Sha $taskProcess.CommandLine)}}
[IO.File]::WriteAllText((Join-Path $taskPlan.directory ($taskName+'.receipt.json')),($taskReceipt|ConvertTo-Json -Depth 5 -Compress),[Text.UTF8Encoding]::new($false))
$taskReceipt|ConvertTo-Json -Depth 5 -Compress
