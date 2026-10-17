import { readFile,rm } from 'node:fs/promises';
import { dirname,isAbsolute } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import {ListenerOwnerLease} from './listener-owner';
import type {TransportSnapshot} from './listener-transport';
/** Optional supervisor handshake. Existing standalone listeners are unchanged.
 * This contains identity/scope only; never auth, prompts or message results. */
export async function publishListenerReady(chatIds:readonly string[],env=process.env,connection:()=>string|TransportSnapshot=()=> 'connected',periodMs=2500,onOwnerLost?:()=>void,scope?:{mode:'registered-topics';entryChatId:string;allowTopicCreation:true}):Promise<()=>Promise<void>> {
  const path=env.BRIDGE_SUPERVISOR_READY_FILE,runId=env.BRIDGE_SUPERVISOR_RUN_ID;
  const ownerPath=env.BRIDGE_SUPERVISOR_OWNER_LEASE_FILE;
  if(!path && !runId && !ownerPath)return async()=>{};
  const validScope=scope?.mode==='registered-topics'&&/^oc_[a-zA-Z0-9]+$/.test(scope.entryChatId)&&scope.allowTopicCreation===true&&chatIds.length===0;
  if(!path || !isAbsolute(path) || !runId || !/^[a-f0-9-]{36}$/.test(runId) || (scope!==undefined?!validScope:chatIds.length!==1 || new Set(chatIds).size!==1))throw new Error('Invalid listener supervisor handshake');
  if(ownerPath&&(!isAbsolute(ownerPath)||dirname(ownerPath)!==dirname(path)||typeof onOwnerLost!=='function'))throw new Error('Invalid listener owner handshake');
  const owner=ownerPath?new ListenerOwnerLease(ownerPath,runId):undefined;
  if(!Number.isSafeInteger(periodMs) || periodMs<10 || periodMs>5000)throw new Error('Invalid listener readiness interval');
  const readyAt=Date.now();let disposed=false,writes=Promise.resolve();
  const publish=()=>{writes=writes.then(async()=>{
    if(disposed)return;
    await owner?.assert();
    if(disposed)return;
    const value=connection(),raw=typeof value==='string'?undefined:value;
    const known=['connected','connecting','reconnecting','disconnected','failed','unknown'];
    const state=known.includes(typeof value==='string'?value:value.state)?typeof value==='string'?value:value.state:'unknown';
    const transport:Record<string,unknown>|undefined=raw?{version:1}:undefined;
    if(raw&&transport){
      for(const key of ['disconnectedSince','reconnectAttempts','lastConnectTime','nextConnectTime'] as const){const n=raw[key];if(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0)transport[key]=n;}
      if(/^[a-f0-9]{64}$/.test(raw.lastErrorSha256??''))transport.lastErrorSha256=raw.lastErrorSha256;
      transport.transitions=raw.transitions.slice(-32).filter(v=>Number.isSafeInteger(v.at)&&v.at>=readyAt&&known.includes(v.state)).map(v=>({at:v.at,state:v.state}));
    }
    const phase=raw?(raw.phase==='ready'&&state==='connected'?'ready':raw.phase==='reconnecting'?'reconnecting':'failed'):state==='connected'?'ready':'disconnected';
    const marker={version:1,runId,pid:process.pid,readyAt,updatedAt:Date.now(),phase,connectionState:state,enabledChatIds:[...chatIds],...(scope?{scope:scope.mode,entryChatId:scope.entryChatId,allowTopicCreation:true}:{}),...(transport?{transport}:{})};
    if(transport)await writeFileAtomic(path.replace(/[^\\/]+$/,'listener.connection.json'),JSON.stringify(marker));
    await writeFileAtomic(path,JSON.stringify(marker));
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
