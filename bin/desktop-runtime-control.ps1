param(
  [Parameter(Mandatory=$true)][ValidateSet('Snapshot','ColdSnapshot','SharedSnapshot','TaskRetirement','TaskPermissions','TaskRestoreNeeded','StopPermission','TestIdentity','ReadOwner','ProtectCapability','UnprotectCapability','StartOrdinary','StopOwned','CloseDesktop','BackupTask','DisableTask','RestoreTask','StartLegacy')][string]$Action,
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
if($taskConfig.legacyTaskOperationsAllowed -eq $false -and ($Action -in @('DisableTask','RestoreTask','StartLegacy') -or ($Action -eq 'StopOwned' -and $Role -eq 'legacy'))){throw 'New-only runtime forbids legacy task or process mutations'}
foreach($taskPath in @($taskConfig.desktopExe,$taskConfig.legacy.executable,$taskConfig.legacy.entryPoint)){
  if(![IO.Path]::IsPathRooted($taskPath)){throw 'Runtime paths must be absolute'}
}
function Get-Sha($text){
  $taskHash=[Security.Cryptography.SHA256]::Create()
  try{return ([BitConverter]::ToString($taskHash.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-','').ToLowerInvariant()}finally{$taskHash.Dispose()}
}
function Throw-UnreadableProcess($process,[string]$reason){
  # Only process identifiers and missing-field flags. Never emit command text,
  # executable paths, environment, user identity, or capability arguments.
  $taskCreatedAt=$null
  if($process.CreationDate -is [DateTime]){$taskCreatedAt=$process.CreationDate.ToUniversalTime().ToString('o')}
  $taskOpaque=@{version=1;pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;processName=[string]$process.Name;createdAt=$taskCreatedAt;missingExecutablePath=(!$process.ExecutablePath);missingCommandLine=(!$process.CommandLine);missingCreationDate=($null -eq $taskCreatedAt)}
  [Console]::Error.WriteLine('BRIDGE_NATIVE_UNREADABLE_PROCESS '+($taskOpaque|ConvertTo-Json -Compress))
  throw $reason
}
function Has-Argument($command,$value){
  $taskPattern='(?:^|\s)(?:"'+[regex]::Escape($value)+'"|'+[regex]::Escape($value)+')(?:\s|$)'
  return [regex]::IsMatch($command,$taskPattern,[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function Open-ProcessExitObservation($process){
  if(!('BridgePinnedProcessExit' -as [type])){Add-Type -TypeDefinition @'
using System;using System.ComponentModel;using System.Runtime.InteropServices;
public sealed class BridgePinnedProcessExit : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct Time { public uint Low,High; public long Value { get { return ((long)High<<32)|Low; } } }
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint GetProcessId(IntPtr handle);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out Time created,out Time exited,out Time kernel,out Time user);
  [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr handle; public int NativeError { get; private set; } public bool IdentityVerified { get; private set; }
  public DateTime KernelCreatedAt { get; private set; }
  public static BridgePinnedProcessExit Open(int pid,DateTime expectedCreated) {
    var result=new BridgePinnedProcessExit();result.handle=OpenProcess(0x00101000,false,pid);
    if(result.handle==IntPtr.Zero){result.NativeError=Marshal.GetLastWin32Error();return result;}
    Time created,exited,kernel,user;
    if(GetProcessId(result.handle)!=(uint)pid || !GetProcessTimes(result.handle,out created,out exited,out kernel,out user)){
      result.NativeError=Marshal.GetLastWin32Error();if(result.NativeError==0)result.NativeError=87;return result;
    }
    result.KernelCreatedAt=DateTime.FromFileTimeUtc(created.Value);
    // CIM creation times have microsecond resolution. Integer comparison
    // retains that precision without floating-point rounding or PID reuse.
    result.IdentityVerified=created.Value/10==expectedCreated.ToUniversalTime().ToFileTimeUtc()/10;
    return result;
  }
  public bool IsExited(){
    if(NativeError!=0 || !IdentityVerified || handle==IntPtr.Zero)return false;
    var status=WaitForSingleObject(handle,0);if(status==0)return true;if(status==258)return false;
    if(status==0xffffffff)throw new Win32Exception(Marshal.GetLastWin32Error());throw new InvalidOperationException("Unexpected process wait result");
  }
  public void Dispose(){if(handle!=IntPtr.Zero){CloseHandle(handle);handle=IntPtr.Zero;}}
}
'@}
  return [BridgePinnedProcessExit]::Open([int]$process.ProcessId,$process.CreationDate)
}
function New-VerifiedExitedRecord($process,$observation){
  if($Action -notin @('Snapshot','ColdSnapshot','SharedSnapshot') -or !$observation.IdentityVerified -or !$observation.IsExited()){throw 'Native exit proof is not available'}
  $taskExitProof=@{version=1;pid=[int]$process.ProcessId;parentPid=[int]$process.ParentProcessId;processName=[string]$process.Name;
    createdAt=$process.CreationDate.ToUniversalTime().ToString('o');kernelCreatedAt=$observation.KernelCreatedAt.ToUniversalTime().ToString('o');
    observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();identityVerified=$true;exited=$true}
  if($null -eq $script:taskVerifiedExits){$script:taskVerifiedExits=[Collections.Generic.List[object]]::new()}
  [void]$script:taskVerifiedExits.Add($taskExitProof)
  # Retain the original topology for live descendants. This is a tombstone,
  # never a complete active identity and never usable by a mutation.
  return [pscustomobject]@{ProcessId=$process.ProcessId;ParentProcessId=$process.ParentProcessId;Name=$process.Name;CreationDate=$process.CreationDate;
    ExecutablePath=$process.ExecutablePath;CommandLine=$process.CommandLine;BridgeVerifiedExited=$true}
}
function Get-Role($process){
  if($process.BridgeVerifiedExited -eq $true){return $null}
  if($process.Name -eq 'ChatGPT.exe' -and $process.CommandLine -notmatch '(?:^|\s)--type='){return 'desktop'}
  if($process.Name -in @('powershell.exe','pwsh.exe') -and $process.CommandLine -match 'desktop-package-broker\.ps1["\s]'){return 'broker'}
  if($process.Name -ne 'node.exe'){return $null}
  if((Has-Argument $process.CommandLine $taskConfig.legacy.entryPoint) -and (Has-Argument $process.CommandLine 'run') -and $process.CommandLine -match ('(?:^|\s)--profile\s+"?'+[regex]::Escape($taskConfig.legacy.profile)+'"?(?:\s|$)')){return 'legacy'}
  # Count foreign installs of desktop hosts/listeners as conflicts as well.
  if($process.CommandLine -match '(?:lark-chatgpt-host\.mjs|desktop-host\.js)["\s]'){return 'host'}
  if($process.CommandLine -match '(?:lark-chatgpt-(topics|bridge)\.mjs|desktop(?:-topics)?\.js)["\s]'){return 'listener'}
  return $null
}
function Resolve-ProcessMetadata($process){
  if($process.BridgeVerifiedExited -eq $true){if($Action -notin @('Snapshot','ColdSnapshot','SharedSnapshot')){Throw-UnreadableProcess $process 'Process identity is not readable'};return $process}
  if($process.ExecutablePath -and $process.CommandLine -and $process.CreationDate -is [DateTime]){return $process}
  # A bulk CIM record can lack fields while a process is being created/exiting.
  # Re-read this exact identity once. For read-only scans only, pin a kernel
  # handle before the re-read so an actual exit can be distinguished from an
  # unreadable live process. Mere disappearance still is not exit proof.
  if(!($process.CreationDate -is [DateTime]) -or [int]$process.ProcessId -le 0 -or !$process.Name){Throw-UnreadableProcess $process 'Process identity is not readable'}
  $taskExitObservation=$null
  try{
    if($Action -in @('Snapshot','ColdSnapshot','SharedSnapshot')){$taskExitObservation=Open-ProcessExitObservation $process}
    $taskFresh=@(Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$process.ProcessId) -ErrorAction Stop | Where-Object {$null -ne $_})
    if($taskFresh.Count -gt 1){Throw-UnreadableProcess $process 'Process identity is not readable'}
    if($taskFresh.Count -eq 1){
      $taskCurrent=$taskFresh[0]
      if($taskCurrent.ProcessId -ne $process.ProcessId -or $taskCurrent.ParentProcessId -ne $process.ParentProcessId -or $taskCurrent.Name -cne $process.Name -or $taskCurrent.CreationDate -ne $process.CreationDate -or
        ($process.ExecutablePath -and $taskCurrent.ExecutablePath -and $taskCurrent.ExecutablePath -cne $process.ExecutablePath) -or
        ($process.CommandLine -and $taskCurrent.CommandLine -and $taskCurrent.CommandLine -cne $process.CommandLine)){
        Throw-UnreadableProcess $process 'Process identity is not readable'
      }
      if($taskExitObservation -and $taskExitObservation.NativeError -eq 0 -and !$taskExitObservation.IdentityVerified){Throw-UnreadableProcess $process 'Process identity is not readable'}
      if($taskCurrent.ExecutablePath -and $taskCurrent.CommandLine -and $taskCurrent.CreationDate -is [DateTime]){return $taskCurrent}
    }
    if($taskExitObservation -and $taskExitObservation.IdentityVerified -and $taskExitObservation.IsExited()){return New-VerifiedExitedRecord $process $taskExitObservation}
    if($taskExitObservation -and $taskExitObservation.NativeError -eq 5){throw 'Native process exit observation access denied: 0x80070005'}
    if($taskExitObservation -and $taskExitObservation.NativeError -notin @(0,87)){throw 'Native process exit observation failed'}
    Throw-UnreadableProcess $process 'Process identity is not readable'
  }finally{if($taskExitObservation){$taskExitObservation.Dispose()}}
}
function Get-Identity($process){
  $process=Resolve-ProcessMetadata $process
  if($process.BridgeVerifiedExited -eq $true){Throw-UnreadableProcess $process 'Exited process is not an active identity'}
  if(!$process.ExecutablePath -or !$process.CommandLine -or !($process.CreationDate -is [DateTime])){Throw-UnreadableProcess $process 'Process identity is not readable'}
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
  $processes=@($processes | ForEach-Object {if($_.Name -in @('ChatGPT.exe','codex.exe')){Resolve-ProcessMetadata $_}else{$_}})
  $taskRelated=[Collections.Generic.HashSet[int]]::new()
  foreach($taskProcess in $processes){
    if($taskProcess.BridgeVerifiedExited -ne $true -and $taskProcess.Name -in @('ChatGPT.exe','codex.exe') -and (!$taskProcess.ExecutablePath -or !$taskProcess.CommandLine)){Throw-UnreadableProcess $taskProcess 'Potential desktop or App Server is unreadable'}
    # Count every desktop child and any Codex App Server, not just the selected
    # install. A renderer left after main-window exit is not a cold baseline.
    if($taskProcess.Name -eq 'ChatGPT.exe' -or ($taskProcess.Name -eq 'codex.exe' -and ($taskProcess.BridgeVerifiedExited -eq $true -or (Has-Argument $taskProcess.CommandLine 'app-server')))){[void]$taskRelated.Add([int]$taskProcess.ProcessId)}
  }
  do{
    $taskAdded=$false
    foreach($taskProcess in $processes){
      if($taskRelated.Contains([int]$taskProcess.ParentProcessId) -and $taskRelated.Add([int]$taskProcess.ProcessId)){$taskAdded=$true}
    }
  }while($taskAdded)
  return @($processes | Where-Object {$taskRelated.Contains([int]$_.ProcessId)} | ForEach-Object {
    $taskRelatedProcess=Resolve-ProcessMetadata $_
    if($taskRelatedProcess.BridgeVerifiedExited -ne $true){Get-Identity $taskRelatedProcess}
  })
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
function Test-ProcessStopAccess([int]$processId){
  if(!('BridgeProcessStopAccess' -as [type])){Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public static class BridgeProcessStopAccess {
  [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool Check(int pid){var handle=OpenProcess(1,false,pid);if(handle==IntPtr.Zero)return false;CloseHandle(handle);return true;}
}
'@}
  return [BridgeProcessStopAccess]::Check($processId)
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
function Restore-TaskEnabled([bool]$savedEnabled,[bool]$currentEnabled,$taskName){
  if($savedEnabled -ne $currentEnabled){
    if($savedEnabled){Enable-ScheduledTask -TaskName $taskName | Out-Null}else{Disable-ScheduledTask -TaskName $taskName | Out-Null}
  }
}
function Test-TaskAccess($sddl,[uint32]$desired){
  # Task Scheduler uses file access rights. Check the actual filtered token,
  # including deny-only groups; membership in Administrators is not sufficient.
  if(!('BridgeTaskAccess' -as [type])){
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class BridgeTaskAccess {
  [StructLayout(LayoutKind.Sequential)] public struct Mapping { public uint Read,Write,Execute,All; }
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool DuplicateToken(IntPtr token,int level,out IntPtr copy);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AccessCheck(byte[] sd,IntPtr token,uint desired,ref Mapping mapping,IntPtr privileges,ref uint length,out uint granted,out bool allowed);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool Check(string sddl,uint desired){
    var descriptor=new RawSecurityDescriptor(sddl);
    var bytes=new byte[descriptor.BinaryLength];descriptor.GetBinaryForm(bytes,0);
    using(var identity=WindowsIdentity.GetCurrent()){
      IntPtr copy;
      if(!DuplicateToken(identity.Token,2,out copy))throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr privileges=IntPtr.Zero;
      try{
        uint length=1024,granted;bool allowed;
        privileges=Marshal.AllocHGlobal((int)length);
        var mapping=new Mapping{Read=0x120089,Write=0x120116,Execute=0x1200a0,All=0x1f01ff};
        if(!AccessCheck(bytes,copy,desired,ref mapping,privileges,ref length,out granted,out allowed))throw new Win32Exception(Marshal.GetLastWin32Error());
        return allowed;
      }finally{if(privileges!=IntPtr.Zero)Marshal.FreeHGlobal(privileges);CloseHandle(copy);}
    }
  }
}
'@
  }
  return [BridgeTaskAccess]::Check($sddl,$desired)
}
if($Action -eq 'TaskRetirement'){
  if($taskConfig.legacy.scheduledTaskName -cne ('LarkChannelBridge.Bot.'+$taskConfig.legacy.profile)){throw 'Retirement target is not the original profile task'}
  $taskService=New-Object -ComObject 'Schedule.Service';$taskService.Connect()
  $taskRegistered=$null
  try{$taskRegistered=$taskService.GetFolder('\').GetTask($taskConfig.legacy.scheduledTaskName)}catch{
    $taskException=$_.Exception;$taskAbsent=$false
    for($taskDepth=0;$taskException -and $taskDepth -lt 8;$taskDepth++){
      if($taskException.HResult -eq -2147024894){$taskAbsent=$true;break};$taskException=$taskException.InnerException
    }
    if(!$taskAbsent){throw}
  }
  if(!$taskRegistered){
    @{version=1;observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();retired=$true;taskPresent=$false;taskEnabled=$false;taskState='absent';definitionSha256=(Get-Sha ('absent:'+$taskConfig.legacy.scheduledTaskName))}|ConvertTo-Json -Compress
  }else{
    $taskDefinition=Read-TaskDefinition
    $taskEnabled=[bool]$taskRegistered.Enabled;$taskDisabled=(!$taskEnabled -and [int]$taskRegistered.State -eq 1 -and !$taskDefinition.enabled)
    @{version=1;observedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();retired=$taskDisabled;taskPresent=$true;taskEnabled=$taskEnabled;taskState=$(if($taskDisabled){'disabled'}else{'other'});definitionSha256=$taskDefinition.sha256}|ConvertTo-Json -Compress
  }
  exit 0
}
if($Action -eq 'TaskPermissions'){
  $null=Read-TaskDefinition
  $taskService=New-Object -ComObject 'Schedule.Service';$taskService.Connect()
  $taskRegistered=$taskService.GetFolder('\').GetTask($taskConfig.legacy.scheduledTaskName)
  $taskSddl=$taskRegistered.GetSecurityDescriptor(7)
  @{version=1;writeAllowed=(Test-TaskAccess $taskSddl 0x120116);executeAllowed=(Test-TaskAccess $taskSddl 0x1200a0);descriptorSha256=(Get-Sha $taskSddl)} | ConvertTo-Json -Compress
  exit 0
}
if($Action -in @('Snapshot','ColdSnapshot','SharedSnapshot')){
  $script:taskVerifiedExits=[Collections.Generic.List[object]]::new()
  $taskObservedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $taskProcesses=@(Get-CimInstance Win32_Process)
  $taskProcesses=@($taskProcesses | ForEach-Object {if($_.Name -in @('node.exe','ChatGPT.exe','codex.exe')){Resolve-ProcessMetadata $_}else{$_}})
  $taskResult=@{legacy=@();desktop=@();host=@();listener=@();broker=@()}
  foreach($taskProcess in @($taskProcesses | Where-Object {$_.Name -in @('node.exe','ChatGPT.exe','powershell.exe','pwsh.exe')})){
    if($taskProcess.BridgeVerifiedExited -eq $true){continue}
    if($taskProcess.Name -in @('node.exe','ChatGPT.exe') -and (!$taskProcess.ExecutablePath -or !$taskProcess.CommandLine)){Throw-UnreadableProcess $taskProcess 'A potential runtime process cannot be identified'}
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
    if($script:taskVerifiedExits.Count){$taskColdResult.verifiedExitedProcesses=@($script:taskVerifiedExits.ToArray())}
    $taskColdResult | ConvertTo-Json -Depth 8 -Compress
    exit 0
  }
  if($script:taskVerifiedExits.Count){$taskResult.verifiedExitedProcesses=@($script:taskVerifiedExits.ToArray())}
  $taskResult | ConvertTo-Json -Depth 6 -Compress
  exit 0
}
if($Action -in @('BackupTask','TaskRestoreNeeded','DisableTask','RestoreTask','StartLegacy')){
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
  if($Action -eq 'TaskRestoreNeeded'){@{version=1;needed=([bool]$taskSaved.enabled -ne [bool]$taskDefinition.enabled)}|ConvertTo-Json -Compress;exit 0}
  if($Action -eq 'DisableTask'){
    Disable-ScheduledTask -TaskName $taskConfig.legacy.scheduledTaskName | Out-Null
  }elseif($Action -eq 'StartLegacy'){
    if(!$taskSaved.enabled -or !$taskDefinition.enabled){throw 'Legacy startup task is disabled'}
    $taskProcesses=@(Get-CimInstance Win32_Process)
    foreach($taskProcess in $taskProcesses){if((Get-Role $taskProcess) -in @('legacy','host','listener')){throw 'Consumer or host already exists'}}
    Start-ScheduledTask -TaskName $taskConfig.legacy.scheduledTaskName
  }else{
    # An unchanged setting is already restored. Avoid requiring write access
    # after a failed disable operation that never changed the task.
    Restore-TaskEnabled ([bool]$taskSaved.enabled) ([bool]$taskDefinition.enabled) $taskConfig.legacy.scheduledTaskName
  }
  @{ok=$true;action=$Action;startedConsumer=$false} | ConvertTo-Json -Compress
  exit 0
}
if(!$IdentityFile -or !$Role){throw 'Process action requires identity file and role'}
$taskExpected=Get-Content -LiteralPath $IdentityFile -Encoding UTF8 | ConvertFrom-Json
$taskMatched=Assert-Identity $taskExpected $Role
if($Action -eq 'StopPermission'){
  if($Role -ne 'legacy'){throw 'Stop permission probe only accepts the verified old consumer'}
  @{version=1;allowed=(Test-ProcessStopAccess ([int]$taskExpected.pid));processTerminated=$false}|ConvertTo-Json -Compress
  exit 0
}
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
