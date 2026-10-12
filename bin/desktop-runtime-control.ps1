param(
  [Parameter(Mandatory=$true)][ValidateSet('Snapshot','ColdSnapshot','SharedSnapshot','TestIdentity','ReadOwner','ProtectCapability','UnprotectCapability','StartOrdinary','StopOwned','CloseDesktop','BackupTask','DisableTask','RestoreTask','StartLegacy')][string]$Action,
  [Parameter(Mandatory=$true)][string]$ConfigFile,
  [string]$IdentityFile,
  [ValidateSet('legacy','desktop','host','listener')][string]$Role,
  [string]$BackupDirectory,
  [string]$CapabilityFile,
  [int]$ProcessId
)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$taskConfig=Get-Content -LiteralPath $ConfigFile -Encoding UTF8 | ConvertFrom-Json
if($taskConfig.version -ne 1 -or $taskConfig.legacy.profile -notmatch '^[\w-]+$' -or $taskConfig.legacy.scheduledTaskName -notmatch '^[\w.-]+$'){throw 'Invalid runtime control configuration'}
foreach($taskPath in @($taskConfig.desktopExe,$taskConfig.legacy.executable,$taskConfig.legacy.entryPoint)){
  if(![IO.Path]::IsPathRooted($taskPath)){throw 'Runtime paths must be absolute'}
}
function Get-Sha($text){
  $taskHash=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$taskHash.Dispose()}
}
function Has-Argument($command,$value){
  $taskPattern='(?:^|\s)(?:"'+[regex]::Escape($value)+'"|'+[regex]::Escape($value)+')(?:\s|$)'
  return [regex]::IsMatch($command,$taskPattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function Get-Role($process){
  if($process.Name -eq 'ChatGPT.exe' -and $process.CommandLine -notmatch '(?:^|\s)--type='){return 'desktop'}
  if($process.Name -in @('powershell.exe','pwsh.exe') -and $process.CommandLine -match 'desktop-package-broker\.ps1["\s]'){return 'broker'}
  if($process.Name -ne 'node.exe'){return $null}
  if((Has-Argument $process.CommandLine $taskConfig.legacy.entryPoint) -and (Has-Argument $process.CommandLine 'run') -and $process.CommandLine -match ('(?:^|\s)--profile\s+"?'+[regex]::Escape($taskConfig.legacy.profile)+'"?(?:\s|$)')){return 'legacy'}
  # Count foreign installs of desktop hosts/listeners as conflicts as well.
  if($process.CommandLine -match '(?:lark-chatgpt-host\.mjs|desktop-host\.js)["\s]'){return 'host'}
  if($process.CommandLine -match '(?:lark-chatgpt-(topics|bridge)\.mjs|desktop(?:-topics)?\.js)["\s]'){return 'listener'}
  return $null
}
function Get-Identity($process){
  if(!$process.ExecutablePath -or !$process.CommandLine){throw 'Process identity is not readable'}
  return @{pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;createdAt=$process.CreationDate.ToUniversalTime().ToString('o');executable=[string]$process.ExecutablePath;commandLineSha256=(Get-Sha $process.CommandLine)}
}
if($Action -eq 'ReadOwner'){
  $taskOwner=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$ProcessId)
  $taskEntry=Join-Path $PSScriptRoot 'lark-chatgpt-runtime-supervisor.mjs'
  if(!$taskOwner -or $taskOwner.ExecutablePath -ne $taskConfig.legacy.executable -or !(Has-Argument $taskOwner.CommandLine $taskEntry)){throw 'Runtime supervisor identity is not verified'}
  Get-Identity $taskOwner | ConvertTo-Json -Compress
  exit 0
}
if($Action -in @('ProtectCapability','UnprotectCapability')){
  if(!$CapabilityFile -or ![IO.Path]::IsPathRooted($CapabilityFile)){throw 'Protected capability path must be absolute'}
  Add-Type -AssemblyName System.Security
  $taskEntropy=[Text.Encoding]::UTF8.GetBytes('lark-chatgpt-bridge broker capability v1')
  if($Action -eq 'ProtectCapability'){
    $taskToken=[Console]::In.ReadToEnd()
    if($taskToken -notmatch '^[a-f0-9]{64}$'){throw 'Invalid capability input'}
    $taskClear=[Text.Encoding]::UTF8.GetBytes($taskToken)
    try{$taskCipher=[Security.Cryptography.ProtectedData]::Protect($taskClear,$taskEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)}finally{[Array]::Clear($taskClear,0,$taskClear.Length);$taskToken=$null}
    $taskStream=[IO.File]::Open($CapabilityFile,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$taskBytes=[Text.Encoding]::UTF8.GetBytes([Convert]::ToBase64String($taskCipher));$taskStream.Write($taskBytes,0,$taskBytes.Length)}finally{$taskStream.Dispose()}
    @{ok=$true;protected=$true} | ConvertTo-Json -Compress
  }else{
    $taskCipher=[Convert]::FromBase64String([IO.File]::ReadAllText($CapabilityFile,[Text.Encoding]::UTF8))
    $taskClear=[Security.Cryptography.ProtectedData]::Unprotect($taskCipher,$taskEntropy,[Security.Cryptography.DataProtectionScope]::CurrentUser)
    try{[Console]::Out.Write([Text.Encoding]::UTF8.GetString($taskClear))}finally{[Array]::Clear($taskClear,0,$taskClear.Length)}
  }
  exit 0
}
function Get-ColdRelated($processes){
  $taskRelated=[Collections.Generic.HashSet[int]]::new()
  foreach($taskProcess in $processes){
    if($taskProcess.Name -in @('ChatGPT.exe','codex.exe') -and (!$taskProcess.ExecutablePath -or !$taskProcess.CommandLine)){throw 'Potential desktop or App Server is unreadable'}
    # Count every desktop child and any Codex App Server, not just the selected
    # install. A renderer left after main-window exit is not a cold baseline.
    if($taskProcess.Name -eq 'ChatGPT.exe' -or ($taskProcess.Name -eq 'codex.exe' -and (Has-Argument $taskProcess.CommandLine 'app-server'))){[void]$taskRelated.Add([int]$taskProcess.ProcessId)}
  }
  do{
    $taskAdded=$false
    foreach($taskProcess in $processes){
      if($taskRelated.Contains([int]$taskProcess.ParentProcessId) -and $taskRelated.Add([int]$taskProcess.ProcessId)){$taskAdded=$true}
    }
  }while($taskAdded)
  return @($processes | Where-Object {$taskRelated.Contains([int]$_.ProcessId)} | ForEach-Object {Get-Identity $_})
}
if($Action -eq 'StartOrdinary'){
  # This is a separate recovery attempt; never close an existing app.
  $taskProcesses=@(Get-CimInstance Win32_Process)
  if(@(Get-ColdRelated $taskProcesses).Count){throw 'Desktop or App Server already exists'}
  Start-Process (Join-Path $env:SystemRoot 'explorer.exe') -ArgumentList 'shell:AppsFolder\OpenAI.Codex_2p2nqsd0c76g0!App' -WindowStyle Hidden
  @{ok=$true;action='StartOrdinary'} | ConvertTo-Json -Compress
  exit 0
}
function Assert-Identity($expected,$expectedRole){
  if(!$expected -or !$expectedRole -or [int]$expected.pid -le 0){throw 'Missing expected process identity'}
  $taskCurrent=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$expected.pid)
  if(!$taskCurrent){throw 'Expected process no longer exists'}
  $taskActual=Get-Identity $taskCurrent
  foreach($taskKey in @('pid','parentPid','createdAt','executable','commandLineSha256')){
    if($taskActual[$taskKey] -cne $expected.$taskKey){throw 'Process identity changed'}
  }
  if((Get-Role $taskCurrent) -ne $expectedRole){throw 'Process role changed'}
  if($expectedRole -eq 'legacy' -and $taskCurrent.ExecutablePath -ne $taskConfig.legacy.executable){throw 'Legacy executable changed'}
  if($expectedRole -eq 'desktop' -and $taskCurrent.ExecutablePath -ne $taskConfig.desktopExe){throw 'Desktop executable changed'}
  return $taskCurrent
}
function Normalize-TaskDefinition($xmlText,[bool]$enabled){
  $taskDocument=[xml]$xmlText
  if($taskDocument.FirstChild -is [Xml.XmlDeclaration]){$taskDocument.FirstChild.Encoding='UTF-8'}
  # Backup bytes are UTF-8. Export's UTF-16 declaration must not remain in the
  # saved file; retain the actual enabled setting before hashing its exclusion.
  $taskSavedXml=$taskDocument.OuterXml
  $taskSettingsNode=$taskDocument.SelectSingleNode('//*[local-name()="Settings"]')
  if($null -eq $taskSettingsNode){throw 'Legacy task settings are missing'}
  $taskEnabledNode=$taskSettingsNode.SelectSingleNode('*[local-name()="Enabled"]')
  if($null -ne $taskEnabledNode){
    if($taskEnabledNode.InnerText -notin @('true','false') -or (($taskEnabledNode.InnerText -eq 'true') -ne $enabled)){throw 'Legacy task enabled state differs from export'}
    [void]$taskSettingsNode.RemoveChild($taskEnabledNode)
  }elseif(!$enabled){throw 'Disabled legacy task export omits enabled state'}
  # Export omits Enabled when the task uses its default true value. Exclude
  # only that setting from the definition hash so enable/disable stays stable.
  return @{xml=$taskSavedXml;sha256=(Get-Sha $taskDocument.OuterXml);enabled=$enabled}
}
function Read-TaskDefinition {
  $taskScheduled=Get-ScheduledTask -TaskName $taskConfig.legacy.scheduledTaskName
  if(@($taskScheduled.Actions).Count -ne 1){throw 'Legacy task has unexpected actions'}
  $taskAction=$taskScheduled.Actions[0]
  # Only a known hidden launcher path is accepted for export. Arbitrary action
  # arguments (which might contain credentials) are never written to backup.
  $taskScript=$taskAction.Arguments.Trim().Trim('"')
  if([IO.Path]::GetFullPath($taskAction.Execute) -ne (Join-Path $env:SystemRoot 'System32\wscript.exe') -or ![IO.Path]::IsPathRooted($taskScript) -or !$taskScript.EndsWith('.vbs',[StringComparison]::OrdinalIgnoreCase) -or $taskScript -notin $taskConfig.legacy.configFiles){throw 'Legacy task launcher is not in verified configuration'}
  $taskXml=[string](Export-ScheduledTask -TaskName $taskConfig.legacy.scheduledTaskName)
  if($null -eq $taskScheduled.Settings.Enabled){throw 'Legacy task enabled state is missing'}
  return Normalize-TaskDefinition $taskXml ([bool]$taskScheduled.Settings.Enabled)
}
if($Action -in @('Snapshot','ColdSnapshot','SharedSnapshot')){
  $taskObservedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $taskProcesses=@(Get-CimInstance Win32_Process)
  $taskResult=@{legacy=@();desktop=@();host=@();listener=@();broker=@()}
  foreach($taskProcess in @($taskProcesses | Where-Object {$_.Name -in @('node.exe','ChatGPT.exe','powershell.exe','pwsh.exe')})){
    if($taskProcess.Name -in @('node.exe','ChatGPT.exe') -and (!$taskProcess.ExecutablePath -or !$taskProcess.CommandLine)){throw 'A potential runtime process cannot be identified'}
    $taskRole=Get-Role $taskProcess
    if($taskRole){$taskResult[$taskRole]+=,(Get-Identity $taskProcess)}
  }
  if($Action -in @('ColdSnapshot','SharedSnapshot')){
    $taskColdResult=@{verifiedAt=$taskObservedAt;complete=$true;desktopRelated=@(Get-ColdRelated $taskProcesses);inventory=$taskResult}
    if($Action -eq 'SharedSnapshot'){
      $taskOwners=@()
      $taskListening=@(Get-NetTCPConnection -State Listen -ErrorAction Stop)
      foreach($taskEndpoint in @($taskConfig.endpoint,$taskConfig.backendEndpoint)){
        $taskUri=[Uri]$taskEndpoint
        if($taskUri.Scheme -ne 'ws' -or $taskUri.Host -notin @('127.0.0.1','[::1]','::1') -or $taskUri.Port -le 0 -or $taskUri.UserInfo -or $taskUri.Query -or $taskUri.Fragment -or $taskUri.AbsolutePath -ne '/'){throw 'Invalid shared endpoint'}
        $taskTcp=@($taskListening | Where-Object {$_.LocalPort -eq $taskUri.Port})
        # Wildcard or another listening address/owner cannot establish the
        # expected exclusive loopback endpoint, even if its PID exists.
        $taskOwners+=@{endpoint=[string]$taskEndpoint;listeners=@($taskTcp | ForEach-Object {@{address=[string]$_.LocalAddress;pid=[int]$_.OwningProcess}})}
      }
      $taskColdResult.endpointOwners=$taskOwners
    }
    $taskColdResult | ConvertTo-Json -Depth 8 -Compress
    exit 0
  }
  $taskResult | ConvertTo-Json -Depth 6 -Compress
  exit 0
}
if($Action -in @('BackupTask','DisableTask','RestoreTask','StartLegacy')){
  if(!$BackupDirectory -or ![IO.Path]::IsPathRooted($BackupDirectory)){throw 'Task backup directory must be absolute'}
  $taskBackup=Join-Path $BackupDirectory 'legacy-task.json'
  $taskDefinition=Read-TaskDefinition
  if($Action -eq 'BackupTask'){
    if(!(Test-Path -LiteralPath $BackupDirectory -PathType Container)){throw 'Task backup directory must already exist'}
    $taskXmlPath=Join-Path $BackupDirectory 'legacy-task.xml'
    $taskBytes=[Text.Encoding]::UTF8.GetBytes($taskDefinition.xml)
    $taskStream=[IO.File]::Open($taskXmlPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$taskStream.Write($taskBytes,0,$taskBytes.Length)}finally{$taskStream.Dispose()}
    $taskValue=@{version=1;taskName=$taskConfig.legacy.scheduledTaskName;definitionSha256=$taskDefinition.sha256;xmlSha256=(Get-Sha $taskDefinition.xml);enabled=$taskDefinition.enabled;backedUpAt=[DateTime]::UtcNow.ToString('o')}
    $taskBytes=[Text.Encoding]::UTF8.GetBytes(($taskValue | ConvertTo-Json -Compress))
    $taskStream=[IO.File]::Open($taskBackup,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try{$taskStream.Write($taskBytes,0,$taskBytes.Length)}finally{$taskStream.Dispose()}
    $taskValue | ConvertTo-Json -Compress
    exit 0
  }
  $taskSaved=Get-Content -LiteralPath $taskBackup -Encoding UTF8 | ConvertFrom-Json
  if($taskSaved.version -ne 1 -or $taskSaved.taskName -ne $taskConfig.legacy.scheduledTaskName -or $taskSaved.definitionSha256 -cne $taskDefinition.sha256 -or $taskSaved.xmlSha256 -cne (Get-Sha ([IO.File]::ReadAllText((Join-Path $BackupDirectory 'legacy-task.xml'),[Text.Encoding]::UTF8)))){throw 'Legacy task definition changed; refusing mutation'}
  if($Action -eq 'DisableTask'){
    Disable-ScheduledTask -TaskName $taskConfig.legacy.scheduledTaskName | Out-Null
  }elseif($Action -eq 'StartLegacy'){
    if(!$taskSaved.enabled -or !$taskDefinition.enabled){throw 'Legacy startup task is disabled'}
    $taskProcesses=@(Get-CimInstance Win32_Process)
    foreach($taskProcess in $taskProcesses){if((Get-Role $taskProcess) -in @('legacy','host','listener')){throw 'Consumer or host already exists'}}
    Start-ScheduledTask -TaskName $taskConfig.legacy.scheduledTaskName
  }else{
    if($taskSaved.enabled){Enable-ScheduledTask -TaskName $taskConfig.legacy.scheduledTaskName | Out-Null}else{Disable-ScheduledTask -TaskName $taskConfig.legacy.scheduledTaskName | Out-Null}
  }
  @{ok=$true;action=$Action;startedConsumer=$false} | ConvertTo-Json -Compress
  exit 0
}
if(!$IdentityFile -or !$Role){throw 'Process action requires identity file and role'}
$taskExpected=Get-Content -LiteralPath $IdentityFile -Encoding UTF8 | ConvertFrom-Json
$taskMatched=Assert-Identity $taskExpected $Role
if($Action -eq 'CloseDesktop'){
  if($Role -ne 'desktop'){throw 'CloseDesktop requires desktop role'}
  $taskHandle=Get-Process -Id $taskExpected.pid
  [void]$taskHandle.CloseMainWindow()
  for($taskIndex=0;$taskIndex -lt 15;$taskIndex++){
    if(!(Get-Process -Id $taskExpected.pid -ErrorAction SilentlyContinue)){break}
    Start-Sleep -Seconds 1
  }
  if(Get-Process -Id $taskExpected.pid -ErrorAction SilentlyContinue){
    $null=Assert-Identity $taskExpected $Role
    Stop-Process -Id $taskExpected.pid -ErrorAction Stop
  }
}elseif($Action -eq 'StopOwned'){
  if($Role -ne 'legacy' -and $Role -ne 'listener'){throw 'Host, broker and desktop require their graceful lifecycle, not StopOwned'}
  if(@(Get-CimInstance Win32_Process -Filter ('ParentProcessId = '+[int]$taskExpected.pid)).Count){throw 'Owned process has active child work'}
  $null=Assert-Identity $taskExpected $Role
  Stop-Process -Id $taskExpected.pid -ErrorAction Stop
}
@{ok=$true;action=$Action;pid=$taskExpected.pid;mutated=($Action -ne 'TestIdentity')} | ConvertTo-Json -Compress
