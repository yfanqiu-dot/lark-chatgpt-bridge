import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyDeployment } from './deployment';
import { readDesktopToolConfig } from './backend';
import { desktopPipes, desktopToolCatalog } from './windows-tools';
import { DesktopRpc } from './rpc';
import { inspectSharedIdle, type SharedContext, type SharedIdleObservation } from './shared-idle';
import { sameProcess, type ProcessIdentity } from './supervisor';
import type { WindowsSupervisorControl } from './supervisor-windows';

/** Actual OS/lease/pipe proof for cold admission. Caller must supply durable
 * receipts for its launched host and broker. No production launch here. */
export async function readOwnedSharedContext(stage:string, control:WindowsSupervisorControl,
  owned:{host:ProcessIdentity;broker:ProcessIdentity;listener?:ProcessIdentity},verifyPipe=true,pinned?:Awaited<ReturnType<typeof verifyDeployment>>,refreshCatalog=false):Promise<SharedContext> {
  const {host,snapshot}=pinned??await verifyDeployment(stage);
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
  if(refreshCatalog){
    const names=await desktopToolCatalog(join(dirname(host.desktopExe),'resources/plugins/openai-bundled/plugins/codex-app-tools'),lease.pipe);
    if(JSON.stringify([...names].sort())!==JSON.stringify([...snapshot.spec.expectedToolNames].sort()))throw Error('Refreshed tool catalog mismatch');
    const current=JSON.parse(await readFile(host.connectionFile,'utf8'));
    const stableLease=(value:Record<string,unknown>)=>{const {verifiedAt:_verifiedAt,...identity}=value;return JSON.stringify(identity);};
    if(!Number.isFinite(current.verifiedAt)||current.verifiedAt<Date.now()-60_000||current.verifiedAt>Date.now()+1000
      ||current.verifiedAt<lease.verifiedAt||stableLease(current)!==stableLease(lease))throw Error('Connection changed during catalog refresh');
  }
  return {host:owned.host,backend:candidates[0]!,desktop:i.desktop[0]!,endpoint:host.endpoint,backendEndpoint:host.backendEndpoint,
    leaseVerifiedAt:lease.verifiedAt,desktopVersion:lease.desktopVersion,codexSha256:lease.codexSha256,toolNames:lease.toolNames,
    packageIdentityVerified:true,endpointOwnershipVerified:true};
}
/** Identity-only liveness during an intentional configuration withdrawal.
 * This is never a tool/queue admission proof: a fresh normal context remains
 * mandatory before health can return true. Pin the original GUI and backend. */
export async function readOwnedSharedIdentity(stage:string,control:WindowsSupervisorControl,
  owned:{host:ProcessIdentity;broker:ProcessIdentity;listener?:ProcessIdentity},expected:SharedContext):Promise<void>{
  const {host}=await verifyDeployment(stage),scan=await control.sharedSnapshot(),i=scan.inventory;
  if(!expected.packageIdentityVerified||!expected.endpointOwnershipVerified||!sameProcess(expected.host,owned.host)
    ||expected.endpoint!==host.endpoint||expected.backendEndpoint!==host.backendEndpoint||expected.desktopVersion!==host.desktopVersion||expected.codexSha256!==host.codexSha256
    ||scan.complete!==true||!Number.isFinite(scan.verifiedAt)||scan.verifiedAt>Date.now()+1000||Date.now()-scan.verifiedAt>5000
    ||i.legacy.length||i.host.length!==1||i.broker.length!==1||i.desktop.length!==1||i.listener.length!==(owned.listener?1:0)
    ||!sameProcess(i.host[0]!,owned.host)||!sameProcess(i.broker[0]!,owned.broker)||!sameProcess(i.desktop[0]!,expected.desktop)
    ||i.desktop[0]!.executable!==host.desktopExe||(owned.listener&&!sameProcess(i.listener[0]!,owned.listener)))throw Error('Configuration wait original process identity unavailable');
  const backend=scan.desktopRelated.filter(p=>p.pid===expected.backend.pid&&p.parentPid===owned.host.pid&&p.executable===host.codexBinary);
  if(backend.length!==1||!sameProcess(backend[0]!,expected.backend))throw Error('Configuration wait original backend unavailable');
  const roots=new Set([expected.backend.pid,expected.desktop.pid]),related=new Map(scan.desktopRelated.map(p=>[p.pid,p]));
  if(related.size!==scan.desktopRelated.length||scan.desktopRelated.some(p=>{
    if(!sameProcess(p,p))return true;const seen=new Set<number>();let current:ProcessIdentity|undefined=p;
    while(current&&!roots.has(current.pid)){if(seen.has(current.pid))return true;seen.add(current.pid);current=related.get(current.parentPid);}return !current;
  }))throw Error('Configuration wait foreign related process');
  for(const [endpoint,pid]of [[host.endpoint,owned.host.pid],[host.backendEndpoint,expected.backend.pid]]as const){
    const owners=scan.endpointOwners.filter(o=>o.endpoint===endpoint),address=new URL(endpoint).hostname.replace(/[\[\]]/g,'');
    if(owners.length!==1||owners[0]!.listeners.length!==1||owners[0]!.listeners[0]!.pid!==pid||owners[0]!.listeners[0]!.address!==address)throw Error('Configuration wait original endpoint unavailable');
  }
}
export async function inspectOwnedShared(stage:string,control:WindowsSupervisorControl,owned:{host:ProcessIdentity;broker:ProcessIdentity}) {
  const pinned=await verifyDeployment(stage),{snapshot,host}=pinned;
  const context=await readOwnedSharedContext(stage,control,owned);
  const lease=JSON.parse(await readFile(host.connectionFile,'utf8'));
  // Measure the actual catalog on the already OS/package verified pipe; do
  // not trust the persisted list alone, even when the lease is fresh.
  const names=await desktopToolCatalog(join(dirname(host.desktopExe),'resources/plugins/openai-bundled/plugins/codex-app-tools'),lease.pipe);
  if(JSON.stringify([...names].sort())!==JSON.stringify([...snapshot.spec.expectedToolNames].sort())) throw new Error('Owned tool catalog mismatch');
  const rpc=new DesktopRpc(host.endpoint,2500);let changed=false,observing=false,activity:SharedIdleObservation['activity'];
  const diagnosticMethods=new Set(['thread/status/changed','thread/started','thread/closed','thread/archived','thread/unarchived','thread/name/updated',
    'turn/started','turn/completed','item/started','item/completed','serverRequest/resolved','item/commandExecution/requestApproval','item/fileChange/requestApproval',
    'config/batchWrite','config/value/write','experimentalFeature/enablement/set']);
  const identifier=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:undefined;
  rpc.onMessage(message=>{
    if(!observing)return;changed=true;if(activity)return;
    const method=typeof message.method==='string'?message.method:undefined;
    const threadId=identifier(message.params?.threadId??message.params?.thread?.id),turnId=identifier(message.params?.turnId??message.params?.turn?.id);
    activity={observedAt:Date.now(),kind:method?(message.id===undefined?'notification':'request'):'unclassified',
      ...(method?{methodSha256:createHash('sha256').update(method).digest('hex'),...(diagnosticMethods.has(method)?{method}:{})}:{}),
      ...(threadId?{threadId}:{}),...(turnId?{turnId}:{})};
  });
  try {
    await rpc.connect();
    const observed=await inspectSharedIdle({get changed(){return changed;},beginObservation(){changed=false;activity=undefined;observing=true;},call:(method,params)=>rpc.call(method,params),close:()=>rpc.close()},context,
      snapshot.bindings,{desktopVersion:host.desktopVersion,codexSha256:host.codexSha256,toolNames:snapshot.spec.expectedToolNames},
      ()=>readOwnedSharedContext(stage,control,owned,false,pinned));
    return !observed.verified&&activity?{...observed,activity}:observed;
  } finally {rpc.close();}
}
