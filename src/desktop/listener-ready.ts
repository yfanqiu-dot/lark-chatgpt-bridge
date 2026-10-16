import { readFile,rm } from 'node:fs/promises';
import { dirname,isAbsolute } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import {ListenerOwnerLease} from './listener-owner';
/** Optional supervisor handshake. Existing standalone listeners are unchanged.
 * This contains identity/scope only; never auth, prompts or message results. */
export async function publishListenerReady(chatIds:readonly string[],env=process.env,connection=()=> 'connected',periodMs=2500,onOwnerLost?:()=>void):Promise<()=>Promise<void>> {
  const path=env.BRIDGE_SUPERVISOR_READY_FILE,runId=env.BRIDGE_SUPERVISOR_RUN_ID;
  const ownerPath=env.BRIDGE_SUPERVISOR_OWNER_LEASE_FILE;
  if(!path && !runId && !ownerPath)return async()=>{};
  if(!path || !isAbsolute(path) || !runId || !/^[a-f0-9-]{36}$/.test(runId) || chatIds.length!==1 || new Set(chatIds).size!==1)throw new Error('Invalid listener supervisor handshake');
  if(ownerPath&&(!isAbsolute(ownerPath)||dirname(ownerPath)!==dirname(path)||typeof onOwnerLost!=='function'))throw new Error('Invalid listener owner handshake');
  const owner=ownerPath?new ListenerOwnerLease(ownerPath,runId):undefined;
  if(!Number.isSafeInteger(periodMs) || periodMs<10 || periodMs>5000)throw new Error('Invalid listener readiness interval');
  const readyAt=Date.now();let disposed=false,writes=Promise.resolve();
  const publish=()=>{writes=writes.then(async()=>{
    if(disposed)return;
    await owner?.assert();
    if(disposed)return;
    const state=connection();await writeFileAtomic(path,JSON.stringify({version:1,runId,pid:process.pid,readyAt,updatedAt:Date.now(),phase:state==='connected'?'ready':'disconnected',connectionState:state,enabledChatIds:[...chatIds]}));
  });return writes;};
  await publish();
  let lost=false;
  const timer=setInterval(()=>{void publish().catch(()=>{clearInterval(timer);if(owner&&!disposed&&!lost){lost=true;onOwnerLost!();}});},periodMs);timer.unref();
  return async()=>{
    disposed=true;clearInterval(timer);
    try{await writes;}finally{
      try {const saved=JSON.parse(await readFile(path,'utf8'));if(saved.runId===runId && saved.pid===process.pid)await rm(path,{force:true});}
      catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    }
  };
}
