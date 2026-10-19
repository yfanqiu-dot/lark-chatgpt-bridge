param([Parameter(Mandatory=$true)][string]$ManifestFile,[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,[switch]$NoNotify)
$ErrorActionPreference='Stop'
# Use Windows PowerShell's own modules even when launched from pwsh.
$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules')
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$bridgeAttempt=[guid]::NewGuid().ToString()
$bridgeStage='initializing'
$bridgeFailureCode='startup_entry_failed'
$bridgeDiagnosticFile=$null
$bridgeNativeErrorFingerprint=$null
function Write-BridgeStartupState([string]$phase,[string]$code,[string]$fingerprint=''){
  $record=@{version=1;attemptId=$bridgeAttempt;observedAt=[DateTime]::UtcNow.ToString('o');phase=$phase;stage=$bridgeStage;code=$code}
  if($fingerprint){$record.errorSha256=$fingerprint}
  [IO.File]::AppendAllText($bridgeDiagnosticFile,($record|ConvertTo-Json -Compress)+[Environment]::NewLine,[Text.UTF8Encoding]::new($false))
}
function Get-BridgeErrorFingerprint([string]$value){
  $algorithm=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-','').ToLowerInvariant()}finally{$algorithm.Dispose()}
}
try{
  Import-Module ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
  $bridgeFallback=[IO.Path]::Combine([IO.Path]::GetTempPath(),'QIUBridgeStartup')
  [void][IO.Directory]::CreateDirectory($bridgeFallback)
  $bridgeDiagnosticFile=[IO.Path]::Combine($bridgeFallback,($bridgeAttempt+'.jsonl'))
  Write-BridgeStartupState 'starting' 'entry_started'
  $bridgeStage='service_manifest'
  if(![IO.Path]::IsPathRooted($ManifestFile) -or (Get-FileHash -LiteralPath $ManifestFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ManifestSha256){throw 'Service manifest changed'}
  $bridgeService=[IO.File]::ReadAllText($ManifestFile,[Text.Encoding]::UTF8)|ConvertFrom-Json
  if($bridgeService.version -ne 1 -or $bridgeService.channelMode -cne 'new-only' -or $bridgeService.serviceMode -cne 'stop-with-desktop' -or [IO.Path]::GetFullPath($bridgeService.root) -ne (Split-Path -Parent $PSScriptRoot) -or [IO.Path]::GetFullPath($bridgeService.directory) -ne (Split-Path -Parent ([IO.Path]::GetFullPath($ManifestFile)))){throw 'Invalid service entry'}
  $bridgeDiagnosticDirectory=Join-Path $bridgeService.directory 'startup'
  [void][IO.Directory]::CreateDirectory($bridgeDiagnosticDirectory)
  $bridgeDiagnosticFile=Join-Path $bridgeDiagnosticDirectory ($bridgeAttempt+'.jsonl')
  Write-BridgeStartupState 'starting' 'manifest_verified'
  $bridgeStage='source_manifest'
  $bridgeSourceFile=Join-Path $bridgeService.sourceStage 'manifest.json'
  if((Get-FileHash -LiteralPath $bridgeSourceFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $bridgeService.sourceSha256){throw 'Service source changed'}
  $bridgeSource=[IO.File]::ReadAllText($bridgeSourceFile,[Text.Encoding]::UTF8)|ConvertFrom-Json
  $bridgeStage='program_integrity'
  foreach($bridgeProof in $bridgeSource.files){if((Get-FileHash -LiteralPath $bridgeProof.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $bridgeProof.sha256){throw 'Service program changed'}}
  if(@($bridgeSource.files|Where-Object{$_.path -eq $PSCommandPath}).Count -ne 1 -or @($bridgeSource.files|Where-Object{$_.path -eq $bridgeService.nodeExecutable}).Count -ne 1){throw 'Service entry proofs missing'}
  $bridgeStage='service_launch'
  Write-BridgeStartupState 'starting' 'programs_verified'
  # Capture native stderr without writing raw errors to a startup log.
  $ErrorActionPreference='Continue'
  $bridgeNativeOutput=@(& $bridgeService.nodeExecutable (Join-Path $PSScriptRoot 'lark-chatgpt-runtime-supervisor.mjs') --service-launch $ManifestFile $ManifestSha256 2>&1)
  $bridgeNativeCode=$LASTEXITCODE
  $ErrorActionPreference='Stop'
  if($bridgeNativeCode -ne 0){
    $bridgeText=($bridgeNativeOutput|ForEach-Object{[string]$_}) -join [Environment]::NewLine
    $bridgeNativeErrorFingerprint=Get-BridgeErrorFingerprint $bridgeText
    $bridgeFailureCode='service_launch_failed'
    if($bridgeText -match 'QIU_BRIDGE_FAILURE (\{[^\r\n]+\})'){
      $bridgeFailure=$Matches[1]|ConvertFrom-Json
      if($bridgeFailure.version -eq 1 -and $bridgeFailure.code -in @('service_previous_run_unresolved','service_launch_failed')){$bridgeFailureCode=$bridgeFailure.code}
      if($bridgeFailure.errorSha256 -match '^[a-f0-9]{64}$'){$bridgeNativeErrorFingerprint=$bridgeFailure.errorSha256}
    }
    throw 'Service launch refused'
  }
  # A worker request is not proof that the channel has reached running.
  Write-BridgeStartupState 'requested' 'runtime_requested'
  exit 0
}catch{
  $ErrorActionPreference='Stop'
  $bridgeFingerprint=if($bridgeNativeErrorFingerprint){$bridgeNativeErrorFingerprint}else{Get-BridgeErrorFingerprint ([string]$_)}
  try{if($bridgeDiagnosticFile){Write-BridgeStartupState 'failed' $bridgeFailureCode $bridgeFingerprint}}catch{}
  [Console]::Error.WriteLine('QIU_BRIDGE_STARTUP_FAILED '+$bridgeFailureCode)
  if(!$NoNotify){
    try{
      $bridgeShell=New-Object -ComObject WScript.Shell
      [void]$bridgeShell.Popup(('QIU Bridge could not connect to Feishu. Your saved records have been kept.'+[Environment]::NewLine+'Check the startup log before trying again. Do not repeatedly click Start.'+[Environment]::NewLine+'Log: '+$bridgeDiagnosticFile),15,'QIU Bridge',48)
    }catch{}
  }
  exit 1
}
