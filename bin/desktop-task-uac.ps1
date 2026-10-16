param([Parameter(Mandatory=$true)][ValidateSet('Launch','Execute')][string]$Mode,[Parameter(Mandatory=$true)][string]$RequestFile,[Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$RequestSha256)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
function Hash-Bytes($bytes){$hash=[Security.Cryptography.SHA256]::Create();try{return ([BitConverter]::ToString($hash.ComputeHash($bytes))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}}
function Read-SealedBytes($path,$expected){if(![IO.Path]::IsPathRooted($path)){throw 'Absolute path required'};$bytes=[IO.File]::ReadAllBytes($path);if((Hash-Bytes $bytes) -cne $expected){throw 'Pinned file changed'};return ,$bytes}
function Write-NewJson($path,$value){
  $temporary=$path+'.tmp-'+[Guid]::NewGuid().ToString();$bytes=[Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 12 -Compress))
  try{$stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()};[IO.File]::Move($temporary,$path)}finally{if([IO.File]::Exists($temporary)){[IO.File]::Delete($temporary)}}
}
function New-TaskLaunchFailure($record,$stage){
  $exception=$record.Exception;$nativeCode=$null;$source='not_available'
  for($depth=0;$exception -and $depth -lt 8;$depth++){
    if($exception -is [ComponentModel.Win32Exception]){$nativeCode=$exception.NativeErrorCode;$source='exception_native_code';break}
    $exception=$exception.InnerException
  }
  # Windows PowerShell can flatten the native exception into a localized
  # InvalidOperationException. Match only exact installed system templates;
  # arbitrary text remains unknown, and the original message is never saved.
  if($null -eq $nativeCode -and $stage -eq 'administrator_start'){
    try{
      $assembly=(Get-Command Microsoft.PowerShell.Management\Start-Process).ImplementingType.Assembly
      $manager=[Resources.ResourceManager]::new('ProcessResources',$assembly)
      foreach($locale in @([Globalization.CultureInfo]::CurrentUICulture.Name,'en-US','zh-CN')){
        $template=$manager.GetString('InvalidStartProcess',[Globalization.CultureInfo]::new($locale))
        foreach($candidate in @(786,1260,1223,5,740)){
          $expected=[string]::Format($template,([ComponentModel.Win32Exception]::new($candidate).Message))
          if([string]$record.Exception.Message -ceq $expected){$nativeCode=$candidate;$source='wrapped_system_message';break}
        }
        if($null -ne $nativeCode){break}
      }
    }catch{}
  }
  $code=switch($nativeCode){786{'administrator_launch_blocked_by_policy'};1260{'administrator_launch_blocked_by_policy'};1223{'administrator_consent_cancelled'};5{'administrator_launch_access_denied'};740{'administrator_elevation_required'};default{'administrator_launch_not_confirmed'}}
  return @{version=1;stage=$stage;errorCode=$code;nativeErrorCode=$nativeCode;nativeErrorSource=$source;hresult=$record.Exception.HResult;errorSha256=(Hash-Bytes ([Text.Encoding]::UTF8.GetBytes([string]$record.Exception.Message)));authenticated=$false}
}
$taskLaunchStage='read_request';$taskFailureDirectory=$null
trap {
  if($Mode -eq 'Launch' -and $taskFailureDirectory){
    try{Write-NewJson (Join-Path $taskFailureDirectory 'native.launch.failure.json') (New-TaskLaunchFailure $_ $taskLaunchStage)}catch{}
  }
  exit 1
}
function Check-Request($request,$path){
  if($request.version -ne 1 -or $request.requestId -notmatch '^[a-f0-9-]{36}$' -or $request.planId -notmatch '^[a-f0-9-]{36}$' -or $request.action -notin @('TaskPermissions','DisableTask','RestoreTask','StartLegacy')){throw 'Invalid scoped task request'}
  if([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path)) -ne [IO.Path]::GetFullPath($request.directory) -or [IO.Path]::GetFileName($request.helperFile) -ne 'desktop-task-uac.ps1' -or [IO.Path]::GetFileName($request.nativeFile) -ne 'desktop-runtime-control.ps1'){throw 'Task action paths changed'}
  if($request.expiresAt -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -or $request.expiresAt -gt ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+120000)){throw 'Task action expired'}
  if(!$request.owner -or [int]$request.owner.pid -le 0 -or !$request.backup -or !$request.control -or $request.control.version -ne 1){throw 'Task action proofs missing'}
  if($request.control.legacy.scheduledTaskName -cne ('LarkChannelBridge.Bot.'+$request.control.legacy.profile) -or [IO.Path]::GetDirectoryName($request.nativeFile) -ne [IO.Path]::GetDirectoryName($request.helperFile)){throw 'Task control scope changed'}
}
$requestBytes=Read-SealedBytes $RequestFile $RequestSha256
$request=[Text.Encoding]::UTF8.GetString($requestBytes)|ConvertFrom-Json
Check-Request $request $RequestFile
$helperBytes=Read-SealedBytes $request.helperFile $request.helperSha256
$taskFailureDirectory=$request.directory
if($Mode -eq 'Launch'){
  $taskLaunchStage='entry_identity'
  if([IO.Path]::GetFullPath($PSCommandPath) -ne [IO.Path]::GetFullPath($request.helperFile)){throw 'Task helper entry changed'}
  # Load exactly the hashed bytes in the elevated process, avoiding a second
  # unchecked -File read. The only elevated program is this fixed task helper.
  $pathLiteral=$request.helperFile.Replace("'","''");$requestLiteral=$RequestFile.Replace("'","''")
  $loader="`$b=[IO.File]::ReadAllBytes('$pathLiteral');`$h=[Security.Cryptography.SHA256]::Create();try{`$s=([BitConverter]::ToString(`$h.ComputeHash(`$b))).Replace('-','').ToLowerInvariant()}finally{`$h.Dispose()};if(`$s -cne '$($request.helperSha256)'){throw 'Task helper changed'};& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString(`$b))) -Mode Execute -RequestFile '$requestLiteral' -RequestSha256 '$RequestSha256'"
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($loader))
  $powershell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $taskLaunchStage='administrator_start'
  $process=Start-Process $powershell -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -Verb RunAs -WindowStyle Hidden -PassThru
  try{
    $taskLaunchStage='native_identity'
    $native=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$process.Id)
    if(!$native -or $native.ExecutablePath -ne $powershell -or $native.CommandLine -notmatch [regex]::Escape($encoded)){throw 'Elevated task identity unavailable'}
    $identity=@{pid=[int]$native.ProcessId;parentPid=[int]$native.ParentProcessId;createdAt=$native.CreationDate.ToUniversalTime().ToString('o');executable=[string]$native.ExecutablePath;commandLineSha256=(Hash-Bytes ([Text.Encoding]::UTF8.GetBytes($native.CommandLine)))}
    Write-NewJson (Join-Path $request.directory 'native.json') @{version=1;requestId=$request.requestId;identity=$identity}
    $taskLaunchStage='helper_exit'
    $remaining=[Math]::Max(1,[int]($request.expiresAt-[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()+10000))
    if(!$process.WaitForExit($remaining)){throw 'Elevated task result not confirmed'}
    $process.Refresh();if($process.ExitCode -ne 0){throw 'Elevated task helper rejected the action'}
  }finally{$process.Dispose()}
  exit 0
}
# Import only fixed helpers from pinned bytes. No elevated external script,
# Node/SDK, process termination, ACL mutation or task registration is exposed.
$nativeBytes=Read-SealedBytes $request.nativeFile $request.nativeSha256
function Load-TaskHelpers($nativeBytes){
  $ast=[Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString($nativeBytes),[ref]$null,[ref]$null)
  foreach($name in @('Get-Sha','Throw-UnreadableProcess','Has-Argument','Get-Role','Resolve-ProcessMetadata','Get-Identity','Get-ColdRelated','Normalize-TaskDefinition','Read-TaskDefinition','Restore-TaskEnabled','Test-TaskAccess')){
    $matches=@($ast.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true))
    if($matches.Count -ne 1){throw 'Pinned task helper missing'}
    . ([scriptblock]::Create($matches[0].Extent.Text))
  }
}
. Load-TaskHelpers $nativeBytes
$taskConfig=$request.control
Add-Type -AssemblyName System.Security
$cipher=[Convert]::FromBase64String([IO.File]::ReadAllText($request.capabilityFile,[Text.Encoding]::UTF8))
$clear=[Security.Cryptography.ProtectedData]::Unprotect($cipher,[Text.Encoding]::UTF8.GetBytes('lark-chatgpt-bridge broker capability v1'),[Security.Cryptography.DataProtectionScope]::CurrentUser)
try{$token=[Text.Encoding]::UTF8.GetString($clear)}finally{[Array]::Clear($clear,0,$clear.Length)}
if($token -notmatch '^[a-f0-9]{64}$'){throw 'Task capability unavailable'}
function Task-Mac($payload){$hmac=[Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($token));try{return ([BitConverter]::ToString($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($payload)))).Replace('-','').ToLowerInvariant()}finally{$hmac.Dispose()}}
function Save-Report($name,$value){$payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($value|ConvertTo-Json -Depth 10 -Compress)));Write-NewJson (Join-Path $request.directory $name) @{payload=$payload;mac=(Task-Mac $payload)}}
function Check-Owner {
  if([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $request.expiresAt){throw 'Task request expired'}
  $process=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$request.owner.pid)
  if(!$process){throw 'Task request owner exited'}
  $actual=Get-Identity $process
  foreach($key in @('pid','parentPid','createdAt','executable','commandLineSha256')){if($actual[$key] -cne $request.owner.$key){throw 'Task request owner identity changed'}}
  if($actual.executable -ne $taskConfig.legacy.executable -or $process.CommandLine -notmatch 'lark-chatgpt-runtime-supervisor\.mjs'){throw 'Task owner is not the fixed runtime'}
}
function Check-TaskProof {
  Check-Owner
  foreach($file in $request.files){$null=Read-SealedBytes $file.path $file.sha256}
  $definition=Read-TaskDefinition
  if($request.backup.version -ne 1 -or $request.backup.taskName -ne $taskConfig.legacy.scheduledTaskName -or $request.backup.definitionSha256 -cne $definition.sha256 -or (Get-Sha ([IO.File]::ReadAllText($request.backup.xmlFile,[Text.Encoding]::UTF8))) -cne $request.backup.xmlSha256){throw 'Original task definition changed'}
  $service=New-Object -ComObject 'Schedule.Service';$service.Connect();$registered=$service.GetFolder('\').GetTask($taskConfig.legacy.scheduledTaskName);$sddl=$registered.GetSecurityDescriptor(7)
  if((Get-Sha $sddl) -cne $request.descriptorSha256){throw 'Original task ACL changed'}
  return @{definition=$definition;permissions=@{version=1;writeAllowed=(Test-TaskAccess $sddl 0x120116);executeAllowed=(Test-TaskAccess $sddl 0x1200a0);descriptorSha256=(Get-Sha $sddl)}}
}
function Invoke-ScopedTaskAction($request,$proof,$processes){
  if($request.action -eq 'TaskPermissions'){return}
  if($request.action -notin @('DisableTask','RestoreTask','StartLegacy')){throw 'Unsupported scoped task action'}
  $roles=@($processes|ForEach-Object{@{role=(Get-Role $_);process=$_}})
  if($request.action -eq 'DisableTask'){
    if(@(Get-ColdRelated $processes).Count -or @($roles|Where-Object{$_.role -in @('host','listener','broker')}).Count){throw 'Cold exit not proven before task disable'}
    $legacy=@($roles|Where-Object{$_.role -eq 'legacy'})
    if($legacy.Count -ne 1 -or !$request.legacy){throw 'Original consumer not unique'}
    $actual=Get-Identity $legacy[0].process
    foreach($key in @('pid','parentPid','createdAt','executable','commandLineSha256')){if($actual[$key] -cne $request.legacy.$key){throw 'Original consumer identity changed'}}
    if($proof.definition.enabled -ne [bool]$request.backup.enabled){throw 'Original enabled state changed'}
    Check-Owner;Disable-ScheduledTask -TaskName $taskConfig.legacy.scheduledTaskName|Out-Null
  }elseif($request.action -in @('RestoreTask','StartLegacy')){
    $desktop=@($roles|Where-Object{$_.role -eq 'desktop'})
    if($desktop.Count -ne 1 -or $desktop[0].process.ExecutablePath -ne $taskConfig.desktopExe -or @($roles|Where-Object{$_.role -in @('host','listener')}).Count -or @($roles|Where-Object{$_.role -eq 'legacy'}).Count -gt 1){throw 'Ordinary restoration inventory conflict'}
    $brokers=@($roles|Where-Object{$_.role -eq 'broker'})
    if($brokers.Count -gt 1 -or ($brokers.Count -eq 1 -and !$request.expectedBroker)){throw 'Restoration broker ownership missing'}
    if($brokers.Count -eq 1){$actual=Get-Identity $brokers[0].process;foreach($key in @('pid','parentPid','createdAt','executable','commandLineSha256')){if($actual[$key] -cne $request.expectedBroker.$key){throw 'Restoration broker identity changed'}}}
    Check-Owner
    if($request.action -eq 'RestoreTask'){Restore-TaskEnabled ([bool]$request.backup.enabled) ([bool]$proof.definition.enabled) $taskConfig.legacy.scheduledTaskName}
    else{
      if(!$request.backup.enabled -or !$proof.definition.enabled -or @($roles|Where-Object{$_.role -eq 'legacy'}).Count){throw 'Legacy startup prerequisites unavailable'}
      Start-ScheduledTask -TaskName $taskConfig.legacy.scheduledTaskName
    }
  }
}
$self=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$PID);$identity=Get-Identity $self
$report=@{version=1;requestId=$request.requestId;action=$request.action;identity=$identity;phase='blocked'}
try{
  $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if(!$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Administrator consent required'}
  $proof=Check-TaskProof
  if(!$proof.permissions.writeAllowed -or !$proof.permissions.executeAllowed){throw 'Task administrator permission unavailable'}
  Save-Report 'ready.json' @{version=1;requestId=$request.requestId;action=$request.action;identity=$identity;phase='ready'}
  $goFile=Join-Path $request.directory 'go.json'
  while(!(Test-Path -LiteralPath $goFile)){Check-Owner;Start-Sleep -Milliseconds 200}
  $go=Get-Content -LiteralPath $goFile -Encoding UTF8|ConvertFrom-Json
  if($go.payload -cne ('go:'+ $request.requestId) -or $go.mac -cne (Task-Mac $go.payload)){throw 'Task action confirmation invalid'}
  $proof=Check-TaskProof
  Invoke-ScopedTaskAction $request $proof @(Get-CimInstance Win32_Process)
  $after=Check-TaskProof
  if($request.action -eq 'DisableTask' -and $after.definition.enabled){throw 'Task disable unconfirmed'}
  if($request.action -eq 'RestoreTask' -and $after.definition.enabled -ne [bool]$request.backup.enabled){throw 'Task setting restoration unconfirmed'}
  $report.phase='completed';$report.permissions=$after.permissions
}catch{$report.errorCode='scoped_task_action_failed';$report.errorSha256=Get-Sha ([string]$_.Exception.Message);$report.nativeHResult=$_.Exception.HResult}
finally{Save-Report 'result.json' $report;$token=$null}
if($report.phase -ne 'completed'){exit 2}
