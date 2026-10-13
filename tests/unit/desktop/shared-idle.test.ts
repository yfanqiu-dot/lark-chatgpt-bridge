import { expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { inspectSharedIdle, type SharedContext } from '../../../src/desktop/shared-idle';
import { type OrdinaryReadRpc } from '../../../src/desktop/ordinary-idle';
import { RpcError } from '../../../src/desktop/rpc';

const identity=(pid:number,parentPid=1)=>({pid,parentPid,createdAt:'2026-10-12T00:00:00.000Z',executable:process.execPath,commandLineSha256:'a'.repeat(64)});
const bindings=[{threadId:'original',projectId:'project',projectRoot:tmpdir()}];
const baseline={desktopVersion:'fixture-version',codexSha256:'b'.repeat(64),toolNames:['list_projects','read_thread']};
const context=():SharedContext=>({host:identity(42),backend:identity(43,42),desktop:identity(44),endpoint:'ws://127.0.0.1:9998/',backendEndpoint:'ws://127.0.0.1:9999/',leaseVerifiedAt:Date.now(),desktopVersion:baseline.desktopVersion,codexSha256:baseline.codexSha256,toolNames:[...baseline.toolNames],packageIdentityVerified:true,endpointOwnershipVerified:true});
function harness(override:(method:string,params:any)=>any=()=>undefined){
  const calls:string[]=[];let closed=0;
  const rpc:OrdinaryReadRpc={async call(method,params){calls.push(method);const value=override(method,params);if(value!==undefined)return value;
    if(method==='project/list')return {data:[{id:'project',roots:[{path:tmpdir()}]}]};
    if(method==='thread/turns/list')return {data:[{status:'completed',completedAt:1}]};
    if(method==='thread/loaded/list')return {data:['original','other']};
    if(method==='thread/read')return {thread:{id:(params as any).threadId,projectId:'project',cwd:tmpdir(),status:{type:'idle',activeFlags:[]}}};
    if(method==='thread/queue/list')return {data:[]};throw new Error('Unexpected RPC');},close(){closed++;}};
  return {rpc,calls,get closed(){return closed;}};
}
it('uses only native reads, checks original project/history and every loaded task twice',async()=>{
  const h=harness(),c=context(); const r=await inspectSharedIdle(h.rpc,c,bindings,baseline,async()=>c);
  expect(r).toMatchObject({verified:true,source:'owned_shared_native',proof:{allDesktopTasksIdle:true,tasks:[{threadId:'original',queueCount:0}]}});
  expect(h.calls).not.toContain('tools/list');expect(h.calls.filter(m=>m==='thread/queue/list')).toHaveLength(4);expect(h.closed).toBe(1);
});
it.each(['waitingOnApproval','queue','active'])('blocks %s on an unrelated loaded task',async condition=>{
  const h=harness((m,p)=>{
    if(p.threadId!=='other')return;
    if(condition==='queue' && m==='thread/queue/list')return {data:[{id:'pending',text:'SECRET_QUEUE'}]};
    if(condition!=='queue' && m==='thread/read')return {thread:{id:'other',preview:'SECRET_BODY',status:{type:'active',activeFlags:condition==='waitingOnApproval'?[condition]:['SECRET_FLAG']}}};
  }),c=context();const r=await inspectSharedIdle(h.rpc,c,bindings,baseline,async()=>c);
  expect(r).toMatchObject({verified:false,blocker:{threadId:'other',pass:1,status:condition==='queue'?'idle':'active',waitingApproval:condition==='waitingOnApproval',activeFlagCount:condition==='queue'?0:1}});
  expect(r.blocker?.queueCount).toBe(condition==='queue'?1:undefined);
  expect(r.blocker?.observedAt).toBeGreaterThan(0);expect(r.proof).toBeUndefined();expect(JSON.stringify(r)).not.toContain('SECRET');
  expect(h.calls.filter(m=>m==='thread/read')).toHaveLength(2);expect(h.closed).toBe(1);
});
it.each(['project','history','cursor'])('rejects %s failures without exposing response bodies',async condition=>{
  const h=harness(m=>condition==='project' && m==='project/list'?{data:[{id:'project',roots:[{path:process.execPath}]}]}:
    condition==='history' && m==='thread/turns/list'?{data:[{status:'active',private:'SECRET'}]}:
    condition==='cursor' && m==='project/list'?{data:[],nextCursor:'same'}:undefined),c=context();
  const r=await inspectSharedIdle(h.rpc,c,bindings,baseline,async()=>c);expect(r.verified).toBe(false);expect(JSON.stringify(r)).not.toContain('SECRET');
});
it.each(['lease','host','backend','tools','package','endpoint'])('rejects unverified or changed %s context',async condition=>{
  const h=harness(),c=context();const changed={...c};
  if(condition==='lease')changed.leaseVerifiedAt-=61_000;
  if(condition==='host')changed.host={...c.host,createdAt:'2026-10-12T00:01:00.000Z'};
  if(condition==='backend')changed.backend={...c.backend,parentPid:999};
  if(condition==='tools')changed.toolNames=['list_projects'];
  if(condition==='package')changed.packageIdentityVerified=false;
  if(condition==='endpoint')changed.endpointOwnershipVerified=false;
  expect(await inspectSharedIdle(h.rpc,c,bindings,baseline,async()=>changed)).toMatchObject({verified:false,findings:['shared_context_unverified']});expect(h.calls).toEqual([]);
});
it('retains an actual RPC error code without a raw error or retry',async()=>{
  const h=harness(m=>{if(m==='thread/loaded/list')throw new RpcError(-32602,'SECRET_BODY');}),c=context();
  const r=await inspectSharedIdle(h.rpc,c,bindings,baseline,async()=>c);expect(r).toMatchObject({verified:false,failure:{method:'thread/loaded/list',code:-32602}});
  expect(JSON.stringify(r)).not.toContain('SECRET');expect(h.calls.filter(m=>m==='thread/loaded/list')).toHaveLength(1);
});
it('includes project/history scan time in proof freshness and rejects observed activity',async()=>{
  const c=context();let tick=Date.now();const h=harness(m=>{if(m==='project/list')tick+=6000;});
  const r=await inspectSharedIdle(h.rpc,c,bindings,baseline,async()=>c,()=>tick);expect(r.verified).toBe(false);
  const dirty=harness();Object.defineProperty(dirty.rpc,'changed',{value:true});expect((await inspectSharedIdle(dirty.rpc,c,bindings,baseline,async()=>c)).verified).toBe(false);
});
