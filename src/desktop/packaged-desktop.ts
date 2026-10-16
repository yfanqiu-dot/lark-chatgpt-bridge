import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const sleep = (ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
interface LaunchConfig {desktopExe:string; desktopVersion:string; projectRoot:string; connectionFile:string}
interface Status {version:1; phase:'running'|'exited'|'failed'|'detached'; pid?:number; packageFullName?:string; exitCode?:number; error?:string}
export interface PackagedDesktop {
  pid:number;
  exitCode:number|null;
  signalCode:null;
  refresh():Promise<void>;
  stop():Promise<boolean>;
  detach():Promise<void>;
}

export function validatePackageStatus(value:unknown, packageFullName:string, expectedPid?:number): Status {
  const s=value as Status;
  if(!s || s.version!==1 || !['running','exited','failed','detached'].includes(s.phase))throw new Error('Invalid packaged desktop launch status');
  if(s.phase==='failed')throw new Error(`Packaged desktop launch failed: ${typeof s.error==='string'?s.error:'unknown error'}`);
  if(!Number.isSafeInteger(s.pid) || s.pid!<=0 || s.packageFullName!==packageFullName || (expectedPid!==undefined && s.pid!==expectedPid))throw new Error('Packaged desktop process identity changed');
  if(s.phase==='exited' && !Number.isInteger(s.exitCode))throw new Error('Packaged desktop exit status is missing');
  return s;
}

/** The pre-activated package broker does not inherit the host's environment.
 * Pass only selected settings as data, then apply them inside the package.
 * No registry environment changes, package registration, or singleton bypass.
 */
export async function launchPackagedDesktop(cfg:LaunchConfig, endpoint?:string):Promise<PackagedDesktop> {
  if(process.platform!=='win32')throw new Error('Packaged desktop launch requires Windows');
  const fullName=`OpenAI.Codex_${cfg.desktopVersion}_x64__2p2nqsd0c76g0`;
  if(!cfg.desktopExe.replaceAll('\\','/').endsWith(`/${fullName}/app/ChatGPT.exe`))throw new Error('Desktop path and package version differ');
  const base=dirname(cfg.connectionFile);await mkdir(base,{recursive:true});
  const dir=await mkdtemp(join(base,'.desktop-launch-'));
  const requestPath=join(dir,'request.json'),statusPath=join(dir,'status.json');
  const brokerToken=process.env.BRIDGE_PACKAGE_BROKER_TOKEN;
  if(!brokerToken || !/^[a-f0-9]{64}$/.test(brokerToken))throw new Error('An active package broker is required to launch the desktop');
  await writeFile(requestPath,JSON.stringify({version:1,ownerPid:process.pid,packageFullName:fullName,desktopExe:cfg.desktopExe,projectRoot:cfg.projectRoot,endpoint,codexHome:process.env.CODEX_HOME,allowDetach:endpoint===undefined,brokerToken}),'utf8');
  let pid:number|undefined;
  const read=async()=>{
    try{return validatePackageStatus(JSON.parse(await readFile(statusPath,'utf8')),fullName,pid);}
    catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw e;}
  };
  try{
    const until=Date.now()+30_000;
    while(Date.now()<until){
      const s=await read();
      if(s){if(s.phase!=='running')throw new Error(`Packaged desktop exited during launch (code ${s.exitCode})`);pid=s.pid;break;}
      try{throw new Error(`Windows package broker rejected desktop launch: ${await readFile(join(dir,'activation.error'),'utf8')}`);}
      catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      await sleep(200);
    }
    if(pid===undefined)throw new Error('Packaged desktop launch timed out');
  }catch(e){
    await writeFile(join(dir,'stop'),'Cancel failed launch','utf8');
    throw e;
  }
  const desktop:PackagedDesktop={pid,exitCode:null,signalCode:null,
    async refresh(){const s=await read();if(!s)throw new Error('Packaged desktop status disappeared');if(s.phase==='exited')desktop.exitCode=s.exitCode!;},
    async stop(){
      await writeFile(join(dir,'stop'),'Stop owned desktop','utf8');
      const until=Date.now()+12_000;
      while(Date.now()<until){await desktop.refresh();if(desktop.exitCode!==null)return true;await sleep(200);}
      return false;
    },
    async detach(){
      if(endpoint!==undefined)throw new Error('Cannot detach a shared desktop');
      await writeFile(join(dir,'detach'),'Ordinary desktop tools verified','utf8');
      const until=Date.now()+5_000;
      while(Date.now()<until){const s=await read();if(s?.phase==='detached')return;if(s?.phase==='exited')throw new Error('Ordinary desktop exited before release');await sleep(200);}
      throw new Error('Ordinary desktop release timed out');
    },
  };
  return desktop;
}
