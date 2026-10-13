param([Parameter(Mandatory=$true)][string]$ManifestFile,[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256)
$ErrorActionPreference='Stop'
if(![IO.Path]::IsPathRooted($ManifestFile) -or (Get-FileHash -LiteralPath $ManifestFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ManifestSha256){throw 'Service manifest changed'}
$bridgeService=Get-Content -LiteralPath $ManifestFile -Encoding UTF8|ConvertFrom-Json
if($bridgeService.version -ne 1 -or $bridgeService.channelMode -cne 'new-only' -or $bridgeService.serviceMode -cne 'stop-with-desktop' -or [IO.Path]::GetFullPath($bridgeService.root) -ne (Split-Path -Parent $PSScriptRoot)){throw 'Invalid service entry'}
$bridgeSourceFile=Join-Path $bridgeService.sourceStage 'manifest.json'
if((Get-FileHash -LiteralPath $bridgeSourceFile -Algorithm SHA256).Hash.ToLowerInvariant() -cne $bridgeService.sourceSha256){throw 'Service source changed'}
$bridgeSource=Get-Content -LiteralPath $bridgeSourceFile -Encoding UTF8|ConvertFrom-Json
# Verify this entry, Node and the complete pinned artifact set before executing.
foreach($bridgeProof in $bridgeSource.files){if((Get-FileHash -LiteralPath $bridgeProof.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $bridgeProof.sha256){throw 'Service program changed'}}
if(@($bridgeSource.files|Where-Object{$_.path -eq $PSCommandPath}).Count -ne 1 -or @($bridgeSource.files|Where-Object{$_.path -eq $bridgeService.nodeExecutable}).Count -ne 1){throw 'Service entry proofs missing'}
& $bridgeService.nodeExecutable (Join-Path $PSScriptRoot 'lark-chatgpt-runtime-supervisor.mjs') --service-launch $ManifestFile $ManifestSha256
exit $LASTEXITCODE
