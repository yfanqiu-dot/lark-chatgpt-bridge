import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { WebSocket, WebSocketServer } from 'ws';
import lockfile from 'proper-lockfile';
import { writeFileAtomic } from '../platform/atomic-write';
import { loopbackEndpoint } from './rpc';
import { cleanDesktopEnvironment, desktopPipes, desktopToolCatalog } from './windows-tools';
import { DesktopReadiness } from './readiness';

export interface HostConfig { codexBinary: string; codexSha256: string; desktopExe: string; desktopVersion: string; projectRoot: string; endpoint: string; backendEndpoint: string; connectionFile: string }
const exec = promisify(execFile);
const sleep = (ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
// The CLI accepts a socket address, while WebSocket clients accept a URL ending in '/'.
export function appServerArgs(endpoint: string): string[] {
  const address = new URL(loopbackEndpoint(endpoint));
  return ['-c','features.code_mode_host=true','app-server','--listen',`ws://${address.host}`,'-c','plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=true'];
}
function launchAppServer(cfg: HostConfig, env: NodeJS.ProcessEnv) {
  const child=spawn(cfg.codexBinary,appServerArgs(cfg.backendEndpoint),{env,cwd:cfg.projectRoot,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let startupError: Error | undefined, startupStderr='';
  const collect=(data: Buffer)=>{startupStderr=(startupStderr+data.toString()).slice(-4000);};
  child.stderr!.on('data',collect);
  child.on('error',e=>{startupError=e;});
  return {child, async ready() {
    try {
      for(let i=0;i<50;i++) {
        if(startupError)throw startupError;
        if(child.exitCode!==null || child.signalCode!==null)throw new Error(`Owned App Server exited before readiness (code ${child.exitCode}, signal ${child.signalCode}): ${startupStderr.trim()}`);
        try {const response=await fetch(`http://${new URL(cfg.backendEndpoint).host}/readyz`,{signal:AbortSignal.timeout(1000)});if(response.ok)return;}catch{}
        await sleep(200);
      }
      throw new Error('Shared server did not become ready');
    } finally { child.stderr!.removeListener('data',collect);child.stderr!.resume();startupStderr=''; }
  }, error:()=>startupError};
}
export async function checkAppServer(cfg: HostConfig): Promise<void> {
  const server=launchAppServer(cfg,cleanDesktopEnvironment(process.env));
  try {await server.ready();}
  finally {if(!await stopOwnedChild(server.child))throw new Error('App Server preflight child did not exit');}
}
async function stopOwnedChild(child?: ReturnType<typeof spawn>): Promise<boolean> {
  if(!child || child.exitCode!==null || child.signalCode!==null || !child.pid)return true;
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{child.removeListener('exit',done);resolve(false);},5000);
    const done=()=>{clearTimeout(timer);resolve(true);};
    child.once('exit',done);child.kill();
  });
}
export async function validateHostConfig(raw: HostConfig): Promise<HostConfig> {
  for(const key of ['codexBinary','desktopExe','projectRoot','connectionFile'] as const) if(typeof raw[key] !== 'string' || !isAbsolute(raw[key])) throw new Error(`${key} must be an absolute path`);
  const cfg = {...raw, endpoint:loopbackEndpoint(raw.endpoint),backendEndpoint:loopbackEndpoint(raw.backendEndpoint)};
  if(cfg.endpoint===cfg.backendEndpoint)throw new Error('Proxy and backend addresses must differ');
  cfg.codexBinary=await realpath(cfg.codexBinary);cfg.desktopExe=await realpath(cfg.desktopExe);cfg.projectRoot=await realpath(cfg.projectRoot);
  if(!/^[a-f0-9]{64}$/i.test(cfg.codexSha256)||createHash('sha256').update(await readFile(cfg.codexBinary)).digest('hex')!==cfg.codexSha256.toLowerCase())throw new Error('Codex binary hash differs from verified version');
  const match=/[\\/]OpenAI\.Codex_([0-9.]+)_x64__2p2nqsd0c76g0[\\/]app[\\/]ChatGPT\.exe$/i.exec(cfg.desktopExe);
  if(!match || match[1]!==cfg.desktopVersion)throw new Error('Installed desktop version differs from configured version');
  return cfg;
}

/** Owns only its child server/desktop. Start with the ordinary desktop closed. */
export async function runDesktopHost(cfg: HostConfig): Promise<void> {
  if(process.platform!=='win32')throw new Error('Desktop host currently requires Windows');
  const env=cleanDesktopEnvironment(process.env);
  const running=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name = 'ChatGPT.exe'\" | Where-Object { $_.ExecutablePath -like '*OpenAI.Codex_*' -and $_.CommandLine -notmatch '--type=' }).Count"],{windowsHide:true,env,timeout:20_000});
  if(Number(running.stdout.trim())!==0)throw new Error('Close the ordinary Codex desktop before starting the shared host. No existing process was stopped.');
  await mkdir(dirname(cfg.connectionFile),{recursive:true});
  const release=await lockfile.lock(cfg.connectionFile,{realpath:false,retries:0});
  const backendUrl=new URL(cfg.backendEndpoint),proxyUrl=new URL(cfg.endpoint);
  const children = new Set<WebSocket>();
  let stopping=false;
  let leaseWrites: Promise<void> = Promise.resolve();
  const invalidate = () => { leaseWrites = leaseWrites.then(() => rm(cfg.connectionFile,{force:true})); void leaseWrites.catch(e => { console.error('Lease invalidation failed:',String(e));stopping=true; }); };
  const readiness=new DesktopReadiness(invalidate);
  let proxy: WebSocketServer | undefined;
  let desktop: ReturnType<typeof spawn> | undefined;
  const appServer=launchAppServer(cfg,env),server=appServer.child;
  const pluginDir=join(dirname(cfg.desktopExe),'resources/plugins/openai-bundled/plugins/codex-app-tools');
  const stop=()=>{stopping=true;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    invalidate(); await leaseWrites;
    await rm(`${cfg.connectionFile}.stop`,{force:true});
    await appServer.ready();
    proxy=new WebSocketServer({host:proxyUrl.hostname.replace(/[\[\]]/g,''),port:Number(proxyUrl.port),maxPayload:8*1024*1024});
    await new Promise<void>((resolve,reject)=>{proxy!.once('listening',resolve);proxy!.once('error',reject);});
    proxy.on('connection',down=>{
      const up=new WebSocket(cfg.backendEndpoint);children.add(down);children.add(up);
      const queue:Array<{data:Buffer;binary:boolean}>=[];let queueBytes=0;
      down.on('message',(data,binary)=>{
        const buffer=Buffer.from(data as Buffer);
        try {
          readiness.request(down,JSON.parse(buffer.toString()));
        }catch{}
        if(up.readyState===WebSocket.OPEN)up.send(buffer,{binary});else {queueBytes+=buffer.length;if(queueBytes>8*1024*1024){down.close();return;}queue.push({data:buffer,binary});}
      });
      up.on('open',()=>{for(const m of queue)up.send(m.data,{binary:m.binary});queue.length=0;});
      up.on('message',(data,binary)=>{
        try{readiness.response(down,JSON.parse(data.toString()));}catch{}
        if(down.readyState===WebSocket.OPEN)down.send(data,{binary});
      });
      let closed=false;
      const close=()=>{if(closed)return;closed=true;children.delete(down);children.delete(up);down.terminate();up.terminate();readiness.close(down);};
      down.on('error',close);up.on('error',close);down.on('close',close);up.on('close',close);
    });
    desktop=spawn(cfg.desktopExe,[],{env:{...env,CODEX_APP_SERVER_WS_URL:cfg.endpoint},cwd:cfg.projectRoot,stdio:'ignore'});
    let desktopError:Error|undefined;desktop.on('error',e=>{desktopError=e;});
    let verifiedOnce=false,lastReadiness='';const startedAt=Date.now();
    while(!stopping && server.exitCode===null && desktop.exitCode===null) {
      try { await readFile(`${cfg.connectionFile}.stop`,'utf8');stopping=true;break; }
      catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      if(appServer.error() || desktopError)throw appServer.error()??desktopError;
      const snapshot=readiness.snapshot();
      const summary=JSON.stringify({...snapshot,quietForMs:Math.min(snapshot.quietForMs,15000)});
      if(!verifiedOnce && summary!==lastReadiness){console.log('Desktop readiness:',summary);lastReadiness=summary;}
      if(!verifiedOnce && Date.now()-startedAt>120_000)throw new Error(`Desktop did not finish shared initialization within 120 seconds: ${summary}`);
      if(readiness.canLease()) {
        const revision=readiness.revision;
        try {
          const candidates=await desktopPipes(desktop.pid!,cfg.desktopExe);
          const matches:Array<{pipe:string;serverPid:number;toolNames:string[]}>=[];
          for(const c of candidates){try{const names=await desktopToolCatalog(pluginDir,c.pipe);if(names.includes('list_projects'))matches.push({...c,toolNames:names});}catch{}}
          if(matches.length!==1)throw new Error('Desktop tool catalog is not uniquely identified');
          const match=matches[0]!;
          const definition=JSON.parse(await readFile(join(pluginDir,'.mcp.json'),'utf8')).mcpServers.codex_app;
          const mcpServer={...definition,command:process.execPath,args:[join(pluginDir,'server.mjs')],cwd:cfg.projectRoot};
          const lease=JSON.stringify({version:1,endpoint:cfg.endpoint,verifiedAt:Date.now(),desktopPid:desktop.pid,pipeServerPid:match.serverPid,pipe:match.pipe,toolNames:match.toolNames,mcpServer,desktopVersion:cfg.desktopVersion,codexSha256:cfg.codexSha256});
          leaseWrites=leaseWrites.then(async()=>{
            if(!readiness.canLease(revision) || stopping)return;
            await writeFileAtomic(cfg.connectionFile,lease);
            if(!verifiedOnce){verifiedOnce=true;console.log('Shared desktop and tool catalog ready.');}
          });
          await leaseWrites;
        }catch(e){invalidate();console.error('Desktop lease not refreshed:',String(e));}
      }
      await sleep(10_000);
    }
  } finally {
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    // Remove only the lease owned by this host; never touch conversation storage.
    stopping=true;
    await leaseWrites.catch(()=>{});
    await rm(cfg.connectionFile,{force:true});
    const desktopStopped=await stopOwnedChild(desktop);
    for(const c of children)c.terminate();proxy?.close();
    const serverStopped=await stopOwnedChild(server);
    await rm(`${cfg.connectionFile}.stop`,{force:true});await release();
    if(desktop?.pid && desktopStopped && serverStopped){
      const ordinary=spawn(cfg.desktopExe,[],{env,cwd:cfg.projectRoot,detached:true,stdio:'ignore'});
      ordinary.on('error',e=>console.error('Ordinary desktop startup failed:',String(e)));ordinary.unref();
      console.log('Shared children stopped; ordinary desktop startup requested.');
    } else console.log('Shared host stopped. Check remaining owned processes before opening Codex normally.');
  }
}

async function main() {
  const [path,mode]=process.argv.slice(2);
  if(!path || !['--check','--check-server','--check-tools','--start','--stop'].includes(mode??''))throw new Error('Usage: lark-chatgpt-host <host.json> --check|--check-server|--check-tools <desktopPid>|--start|--stop');
  const cfg=await validateHostConfig(JSON.parse(await readFile(path,'utf8')));
  if(mode==='--stop'){
    if(!await lockfile.check(cfg.connectionFile,{realpath:false}))throw new Error('No running host owns this configuration');
    await writeFileAtomic(`${cfg.connectionFile}.stop`,'Restore ordinary desktop startup');
    console.log('Stop requested; wait for the host to confirm ordinary startup.');return;
  }
  if(mode==='--check'){console.log('Pinned desktop and Codex binary verified; nothing started.');return;}
  if(mode==='--check-server'){
    await checkAppServer(cfg);
    console.log('App Server readiness verified; probe process stopped. Desktop unchanged.');return;
  }
  if(mode==='--check-tools'){
    const pid=Number(process.argv[4]);if(!Number.isInteger(pid)||pid<=0)throw new Error('Expected the current desktop process ID');
    const candidates=await desktopPipes(pid,cfg.desktopExe);
    const matches=[];
    for(const candidate of candidates){
      try { const names=await desktopToolCatalog(join(dirname(cfg.desktopExe),'resources/plugins/openai-bundled/plugins/codex-app-tools'),candidate.pipe);if(names.includes('list_projects'))matches.push({serverPid:candidate.serverPid,toolCount:names.length,hasListProjects:true}); }catch{}
    }
    if(matches.length!==1)throw new Error('Desktop tool catalog is not uniquely identified');
    console.log(JSON.stringify({ok:true,desktopVersion:cfg.desktopVersion,...matches[0],businessToolsExecuted:0}));return;
  }
  await runDesktopHost(cfg);
}
// Separate entry module keeps imports safe for tests.
export { main as desktopHostMain };
