import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const exec = promisify(execFile);

export function cleanDesktopEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('NODE_REPL_') && (!key.startsWith('CODEX_') || key === 'CODEX_HOME')));
}
/** powershell.exe is Windows PowerShell, not the pwsh that may launch Node.
 * Let it construct its own module path instead of inheriting pwsh's modules. */
export function windowsPowerShellEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(cleanDesktopEnvironment(source)).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
}
const discovery = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$taskExpectedPid=[int]$env:BRIDGE_DESKTOP_PID
$taskExpectedExe=$env:BRIDGE_DESKTOP_EXE
$taskProcess=Get-CimInstance Win32_Process -Filter "ProcessId = $taskExpectedPid"
if(!$taskProcess -or $taskProcess.ExecutablePath -ne $taskExpectedExe -or $taskProcess.CommandLine -match '--type='){throw 'Desktop process identity changed'}
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles; public static class BridgePipeOwner { [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint pid); [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name); }'
$taskPackageExpected=(Split-Path -Parent (Split-Path -Parent $taskExpectedExe) | Split-Path -Leaf)
$taskHandle=Get-Process -Id $taskExpectedPid
[uint32]$taskLength=0
if([BridgePipeOwner]::GetPackageFullName($taskHandle.Handle,[ref]$taskLength,$null) -ne 122){throw 'Desktop has no package identity'}
$taskPackage=[Text.StringBuilder]::new([int]$taskLength)
if([BridgePipeOwner]::GetPackageFullName($taskHandle.Handle,[ref]$taskLength,$taskPackage) -ne 0 -or $taskPackage.ToString() -ne $taskPackageExpected){throw 'Desktop package identity changed'}
$taskMatches=@(foreach($taskPath in [IO.Directory]::GetFiles('\\.\pipe\')) {
  $taskName=$taskPath.Substring($taskPath.LastIndexOf('\')+1)
  if(!$taskName.StartsWith('codex-browser-use-')){continue}
  $taskPipe=[IO.Pipes.NamedPipeClientStream]::new('.',$taskName,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
  try { $taskPipe.Connect(100); [uint32]$taskOwner=0; if([BridgePipeOwner]::GetNamedPipeServerProcessId($taskPipe.SafePipeHandle,[ref]$taskOwner) -and $taskOwner -eq $taskExpectedPid){[pscustomobject]@{pipe=$taskPath;serverPid=$taskOwner}} } catch {} finally { $taskPipe.Dispose() }
})
ConvertTo-Json -InputObject $taskMatches -Compress
`;
export async function desktopPipes(pid: number, desktopExe: string): Promise<Array<{pipe: string; serverPid: number}>> {
  if (process.platform !== 'win32') throw new Error('Shared desktop host currently requires Windows');
  const { stdout } = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', discovery], {
    windowsHide: true, timeout: 20_000, encoding: 'utf8',
    env: { ...windowsPowerShellEnvironment(process.env), BRIDGE_DESKTOP_PID: String(pid), BRIDGE_DESKTOP_EXE: desktopExe },
  });
  return JSON.parse(stdout.trim());
}

/** Only initialize/tools/list; never executes a business tool or synthesizes task identity. */
export async function desktopToolCatalog(pluginDir: string, pipe: string): Promise<string[]> {
  const child = spawn(process.execPath, [join(pluginDir, 'server.mjs')], {
    cwd: pluginDir, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...cleanDesktopEnvironment(process.env), CODEX_APP_TOOLS_PIPE_PATH: pipe },
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, {resolve: (v:any)=>void; reject: (e:Error)=>void; timer: ReturnType<typeof setTimeout>}>(); let seq = 0;
  const rejectAll = () => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Desktop MCP probe exited')); } pending.clear(); };
  child.on('error', rejectAll); child.on('exit', rejectAll);
  lines.on('line', line => {
    let message: any; try { message=JSON.parse(line); } catch { return; }
    const p=pending.get(message.id); if (!p) return;
    clearTimeout(p.timer);pending.delete(message.id);message.error?p.reject(new Error('Desktop MCP catalog failed')):p.resolve(message.result);
  });
  const call = (method:string,params:unknown) => new Promise<any>((resolve,reject)=>{
    const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Desktop MCP catalog timeout'));},8000);
    pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  try {
    await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'lark_bridge_catalog',version:'0.1.0'}});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const result = await call('tools/list',{});
    return result.tools.map((t:{name:string})=>t.name);
  } finally { lines.close(); child.kill(); rejectAll(); }
}
