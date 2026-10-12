import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { verifyDeployment } from './deployment';
import { readDesktopToolConfig } from './backend';
import { desktopPipes, desktopToolCatalog } from './windows-tools';
import { DesktopRpc } from './rpc';
import { inspectSharedIdle, type SharedContext } from './shared-idle';
import { sameProcess, type ProcessIdentity } from './supervisor';
import type { WindowsSupervisorControl } from './supervisor-windows';

/** Actual OS/lease/pipe proof for cold admission. Caller must supply durable
 * receipts for its launched host and broker. No production launch here. */
export async function readOwnedSharedContext(stage:string, control:WindowsSupervisorControl,
  owned:{host:ProcessIdentity;broker:ProcessIdentity;listener?:ProcessIdentity},verifyPipe=true,pinned?:Awaited<ReturnType<typeof verifyDeployment>>):Promise<SharedContext> {
  const {host}=pinned??await verifyDeployment(stage);
  await readDesktopToolConfig(host);
  const lease=JSON.parse(await readFile(host.connectionFile,'utf8'));
  const scan=await (pinned?control.boundedSharedSnapshot():control.sharedSnapshot()),i=scan.inventory;
  if(scan.complete!==true || !Number.isFinite(scan.verifiedAt) || scan.verifiedAt>Date.now()+1000 || Date.now()-scan.verifiedAt>5000
    || i.legacy.length || i.listener.length!==(owned.listener?1:0) || (owned.listener && !sameProcess(i.listener[0]!,owned.listener)) || i.host.length!==1 || i.broker.length!==1 || i.desktop.length!==1
    || !sameProcess(i.host[0]!,owned.host) || !sameProcess(i.broker[0]!,owned.broker) || i.desktop[0]!.executable!==host.desktopExe
    || lease.hostPid!==owned.host.pid || lease.desktopPid!==i.desktop[0]!.pid || lease.backendEndpoint!==host.backendEndpoint
    || lease.endpoint!==host.endpoint || lease.desktopVersion!==host.desktopVersion || lease.codexSha256!==host.codexSha256
    || !Number.isFinite(lease.verifiedAt) || lease.verifiedAt>Date.now()+1000 || Date.now()-lease.verifiedAt>60_000) throw new Error('Owned shared lease or processes unverified');
  const candidates=scan.desktopRelated.filter(p=>p.pid===lease.backendPid && p.parentPid===owned.host.pid && p.executable===host.codexBinary);
  if(candidates.length!==1 || !sameProcess(candidates[0]!,candidates[0]!)) throw new Error('Owned App Server unverified');
  const roots=new Set([candidates[0]!.pid,i.desktop[0]!.pid]), related=new Map(scan.desktopRelated.map(p=>[p.pid,p]));
  if(related.size!==scan.desktopRelated.length || !roots.size || scan.desktopRelated.some(p=>{
    if(!sameProcess(p,p))return true;
    const seen=new Set<number>();let current:ProcessIdentity|undefined=p;
    while(current && !roots.has(current.pid)){
      if(seen.has(current.pid))return true;seen.add(current.pid);current=related.get(current.parentPid);
    }
    return !current;
  })) throw new Error('Foreign desktop or App Server remains');
  for(const [endpoint,pid] of [[host.endpoint,owned.host.pid],[host.backendEndpoint,candidates[0]!.pid]] as const){
    const owners=scan.endpointOwners.filter(p=>p.endpoint===endpoint), address=new URL(endpoint).hostname.replace(/[\[\]]/g,'');
    if(owners.length!==1 || owners[0]!.listeners.length!==1 || owners[0]!.listeners[0]!.pid!==pid || owners[0]!.listeners[0]!.address!==address) throw new Error('Owned endpoint unverified');
  }
  if(verifyPipe){
    const pipes=await desktopPipes(i.desktop[0]!.pid,host.desktopExe);
    if(pipes.filter(p=>p.pipe===lease.pipe && p.serverPid===lease.desktopPid).length!==1) throw new Error('Owned tool pipe unverified');
  }
  return {host:owned.host,backend:candidates[0]!,desktop:i.desktop[0]!,endpoint:host.endpoint,backendEndpoint:host.backendEndpoint,
    leaseVerifiedAt:lease.verifiedAt,desktopVersion:lease.desktopVersion,codexSha256:lease.codexSha256,toolNames:lease.toolNames,
    packageIdentityVerified:true,endpointOwnershipVerified:true};
}
export async function inspectOwnedShared(stage:string,control:WindowsSupervisorControl,owned:{host:ProcessIdentity;broker:ProcessIdentity}) {
  const pinned=await verifyDeployment(stage),{snapshot,host}=pinned;
  const context=await readOwnedSharedContext(stage,control,owned);
  const lease=JSON.parse(await readFile(host.connectionFile,'utf8'));
  // Measure the actual catalog on the already OS/package verified pipe; do
  // not trust the persisted list alone, even when the lease is fresh.
  const names=await desktopToolCatalog(join(dirname(host.desktopExe),'resources/plugins/openai-bundled/plugins/codex-app-tools'),lease.pipe);
  if(JSON.stringify([...names].sort())!==JSON.stringify([...snapshot.spec.expectedToolNames].sort())) throw new Error('Owned tool catalog mismatch');
  const rpc=new DesktopRpc(host.endpoint,2500);let changed=false;
  rpc.onMessage(()=>{changed=true;});
  try {
    await rpc.connect();
    // The bounded admission window starts after initialize. Activity during
    // the handshake is accounted for by the following full native scan.
    changed=false;
    return await inspectSharedIdle({get changed(){return changed;},call:(method,params)=>rpc.call(method,params),close:()=>rpc.close()},context,
      snapshot.bindings,{desktopVersion:host.desktopVersion,codexSha256:host.codexSha256,toolNames:snapshot.spec.expectedToolNames},
      ()=>readOwnedSharedContext(stage,control,owned,false,pinned));
  } finally {rpc.close();}
}
