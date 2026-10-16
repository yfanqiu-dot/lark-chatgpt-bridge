param([Parameter(Mandatory=$true)][string]$ManifestFile,[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,[switch]$CheckOnly)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if(![IO.Path]::IsPathRooted($ManifestFile) -or $ManifestFile -match '["\r\n]' -or (Get-FileHash -LiteralPath $ManifestFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ManifestSha256){throw 'Service manifest changed'}
$bridgeService=Get-Content -LiteralPath $ManifestFile -Encoding UTF8|ConvertFrom-Json
if($bridgeService.version -ne 1 -or $bridgeService.channelMode -cne 'new-only' -or $bridgeService.serviceMode -cne 'stop-with-desktop' -or [IO.Path]::GetFullPath($bridgeService.root) -ne (Split-Path -Parent $PSScriptRoot)){throw 'Invalid service entry'}
$bridgeSourceFile=Join-Path $bridgeService.sourceStage 'manifest.json'
if((Get-FileHash -LiteralPath $bridgeSourceFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $bridgeService.sourceSha256){throw 'Service source changed'}
$bridgeSource=Get-Content -LiteralPath $bridgeSourceFile -Encoding UTF8|ConvertFrom-Json
foreach($bridgeProof in $bridgeSource.files){if((Get-FileHash -LiteralPath $bridgeProof.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $bridgeProof.sha256){throw 'Service program changed'}}
if(@($bridgeSource.files|Where-Object{$_.path -eq $PSCommandPath}).Count -ne 1){throw 'Shortcut program proof missing'}
$bridgeShell=New-Object -ComObject WScript.Shell
$bridgeTarget=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$bridgeEntry=Join-Path $PSScriptRoot 'desktop-service-start.ps1'
$bridgeArguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy RemoteSigned -File "'+$bridgeEntry+'" -ManifestFile "'+$ManifestFile+'" -ManifestSha256 '+$ManifestSha256
$bridgeDescription='QIU New Bridge '+$bridgeService.serviceId
$bridgeLinks=@((Join-Path $bridgeShell.SpecialFolders.Item('Startup') 'QIU New Bridge.lnk'),(Join-Path $bridgeShell.SpecialFolders.Item('Desktop') 'QIU New Bridge.lnk'))
# Validate every existing link before any write. Foreign links and another
# service revision are preserved; migration must be explicit and reviewable.
foreach($bridgeLinkPath in $bridgeLinks){
  if(Test-Path -LiteralPath $bridgeLinkPath){
    $bridgeLink=$bridgeShell.CreateShortcut($bridgeLinkPath)
    if($bridgeLink.TargetPath -ine $bridgeTarget -or $bridgeLink.Arguments -cne $bridgeArguments -or $bridgeLink.Description -cne $bridgeDescription -or $bridgeLink.WorkingDirectory -ine $bridgeService.root){throw 'Existing shortcut belongs to another entry'}
  }
}
if(!$CheckOnly){
  foreach($bridgeLinkPath in $bridgeLinks){
    $bridgeLink=$bridgeShell.CreateShortcut($bridgeLinkPath)
    $bridgeLink.TargetPath=$bridgeTarget;$bridgeLink.Arguments=$bridgeArguments;$bridgeLink.Description=$bridgeDescription
    $bridgeLink.WorkingDirectory=$bridgeService.root;$bridgeLink.WindowStyle=7;$bridgeLink.Save()
    $bridgeRead=$bridgeShell.CreateShortcut($bridgeLinkPath)
    if($bridgeRead.TargetPath -ine $bridgeTarget -or $bridgeRead.Arguments -cne $bridgeArguments -or $bridgeRead.Description -cne $bridgeDescription){throw 'Shortcut write not verified'}
  }
}
@{version=1;serviceId=$bridgeService.serviceId;checkOnly=[bool]$CheckOnly;startupInstalled=(!$CheckOnly);paths=$bridgeLinks;legacyTaskChanged=$false;servicesStarted=$false}|ConvertTo-Json -Compress
