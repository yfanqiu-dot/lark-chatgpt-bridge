import { readFile,rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
/** Optional supervisor handshake. Existing standalone listeners are unchanged.
 * This contains identity/scope only; never auth, prompts or message results. */
export async function publishListenerReady(chatIds:readonly string[],env=process.env,connection=()=> 'connected',periodMs=2500):Promise<()=>Promise<void>> {
  const path=env.BRIDGE_SUPERVISOR_READY_FILE,runId=env.BRIDGE_SUPERVISOR_RUN_ID;
  if(!path && !runId)return async()=>{};
  if(!path || !isAbsolute(path) || !runId || !/^[a-f0-9-]{36}$/.test(runId) || chatIds.length!==1 || new Set(chatIds).size!==1)throw new Error('Invalid listener supervisor handshake');
  if(!Number.isSafeInteger(periodMs) || periodMs<10 || periodMs>5000)throw new Error('Invalid listener readiness interval');
  const readyAt=Date.now();let disposed=false,writes=Promise.resolve();
  const publish=()=>{writes=writes.then(async()=>{
    if(disposed)return;
    const state=connection();await writeFileAtomic(path,JSON.stringify({version:1,runId,pid:process.pid,readyAt,updatedAt:Date.now(),phase:state==='connected'?'ready':'disconnected',connectionState:state,enabledChatIds:[...chatIds]}));
  });return writes;};
  await publish();
  const timer=setInterval(()=>{void publish().catch(()=>clearInterval(timer));},periodMs);timer.unref();
  return async()=>{
    disposed=true;clearInterval(timer);await writes;
    try {const saved=JSON.parse(await readFile(path,'utf8'));if(saved.runId===runId && saved.pid===process.pid)await rm(path,{force:true});}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  };
}
