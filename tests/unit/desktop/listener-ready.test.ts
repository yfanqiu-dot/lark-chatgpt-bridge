import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishListenerReady,assertListenerSubmissionOpen } from '../../../src/desktop/listener-ready';
import {writeFileAtomic} from '../../../src/platform/atomic-write';
let dir:string;const closers:Array<()=>Promise<void>>=[];
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'listener-ready-'));});
afterEach(async()=>{for(const close of closers.splice(0))await close();await rm(dir,{recursive:true,force:true});});
const env=()=>({BRIDGE_SUPERVISOR_READY_FILE:join(dir,'ready.json'),BRIDGE_SUPERVISOR_RUN_ID:'12345678-1234-1234-1234-123456789abc'});
it('publishes the explicit DM control scope and rejects a group-entry collision',async()=>{
  const scope={mode:'registered-topics' as const,entryChatId:'oc_entry',directControlChatId:'oc_control',allowTopicCreation:true as const},values=env();
  await expect(publishListenerReady([],values,()=> 'connected',5000,undefined,{...scope,directControlChatId:'oc_entry'})).rejects.toThrow('handshake');
  const close=await publishListenerReady([],values,()=> 'connected',5000,undefined,scope);closers.push(close);
  expect(JSON.parse(await readFile(values.BRIDGE_SUPERVISOR_READY_FILE,'utf8'))).toMatchObject({directControlChatId:'oc_control',entryChatId:'oc_entry'});
});
it('allows standalone submission and managed submission before a health failure',async()=>{
  await expect(assertListenerSubmissionOpen({})).resolves.toBeUndefined();await expect(assertListenerSubmissionOpen(env())).resolves.toBeUndefined();
});
it.each(['current','foreign','malformed'])('blocks submission immediately for a %s health-failure marker before shutdown',async kind=>{
  const values=env();await writeFile(join(dir,'runtime-health.failure.json'),kind==='malformed'?'bad':JSON.stringify({version:1,runId:kind==='current'?values.BRIDGE_SUPERVISOR_RUN_ID:'other',reason:'health_read_failed'}));
  await expect(assertListenerSubmissionOpen(values)).rejects.toThrow('未提交新请求');
});
it.each([{BRIDGE_SUPERVISOR_RUN_ID:'bad'},{BRIDGE_SUPERVISOR_READY_FILE:'relative'}])('rejects an incomplete managed submission identity',async values=>{await expect(assertListenerSubmissionOpen(values)).rejects.toThrow('handshake');});
it('does nothing for an existing listener without supervisor variables',async()=>{await(await publishListenerReady([],{}))();});
it('publishes an explicit registered-topic scope, and rejects ambiguous scope widening',async()=>{
  const scope={mode:'registered-topics' as const,entryChatId:'oc_entry',allowTopicCreation:true as const},values=env();
  await expect(publishListenerReady([],values)).rejects.toThrow('handshake');
  await expect(publishListenerReady(['oc_c'],values,()=> 'connected',5000,undefined,scope)).rejects.toThrow('handshake');
  await expect(publishListenerReady([],values,()=> 'connected',5000,undefined,{...scope,entryChatId:'bad'})).rejects.toThrow('handshake');
  const close=await publishListenerReady([],values,()=> 'connected',5000,undefined,scope);closers.push(close);
  expect(JSON.parse(await readFile(values.BRIDGE_SUPERVISOR_READY_FILE,'utf8'))).toMatchObject({scope:'registered-topics',entryChatId:'oc_entry',allowTopicCreation:true,enabledChatIds:[],phase:'ready'});
});
it.each([{BRIDGE_SUPERVISOR_RUN_ID:'bad'},{BRIDGE_SUPERVISOR_READY_FILE:'relative'}])('rejects incomplete or invalid handshake',async value=>{await expect(publishListenerReady(['oc_test'],value)).rejects.toThrow();});
it('publishes identity and connection state, advances heartbeat and removes only its own marker',async()=>{
  let state='connected';const values=env(),close=await publishListenerReady(['oc_test'],values,()=>state,100);closers.push(close);
  const initial=JSON.parse(await readFile(values.BRIDGE_SUPERVISOR_READY_FILE,'utf8'));expect(initial).toMatchObject({pid:process.pid,phase:'ready',connectionState:'connected',enabledChatIds:['oc_test']});
  state='reconnecting';const deadline=Date.now()+3000;let updated;
  do{await new Promise(done=>setTimeout(done,50));updated=JSON.parse(await readFile(values.BRIDGE_SUPERVISOR_READY_FILE,'utf8'));}while(updated.phase==='ready'&&Date.now()<deadline);
  expect(updated.phase).toBe('disconnected');expect(updated.updatedAt).toBeGreaterThan(initial.updatedAt);await close();closers.pop();await expect(readFile(values.BRIDGE_SUPERVISOR_READY_FILE)).rejects.toMatchObject({code:'ENOENT'});
});
it('keeps a marker belonging to a replacement instead of deleting it',async()=>{
  const values=env(),close=await publishListenerReady(['oc_test'],values,()=> 'connected',5000);await writeFile(values.BRIDGE_SUPERVISOR_READY_FILE,JSON.stringify({runId:'other',pid:999}),'utf8');await close();expect(JSON.parse(await readFile(values.BRIDGE_SUPERVISOR_READY_FILE,'utf8')).runId).toBe('other');
});
it('persists sanitized connection diagnostics after removing its readiness marker',async()=>{
  const values=env(),close=await publishListenerReady(['oc_test'],values,()=>({state:'reconnecting',phase:'reconnecting',disconnectedSince:Date.now(),
    reconnectAttempts:3,lastErrorSha256:'a'.repeat(64),transitions:[{at:Date.now(),state:'reconnecting',private:'TEST_PRIVATE'}],private:'TEST_PRIVATE'} as any),5000);
  const marker=JSON.parse(await readFile(values.BRIDGE_SUPERVISOR_READY_FILE,'utf8'));expect(marker).toMatchObject({phase:'reconnecting',transport:{version:1,reconnectAttempts:3}});
  await close();await expect(readFile(values.BRIDGE_SUPERVISOR_READY_FILE)).rejects.toMatchObject({code:'ENOENT'});
  const bytes=await readFile(join(dir,'listener.connection.json'),'utf8');expect(bytes).not.toContain('TEST_PRIVATE');expect(JSON.parse(bytes)).toEqual(marker);
});
const ownerProof=(runId:string)=>({version:1,runId,owner:{pid:process.pid,parentPid:process.ppid,createdAt:new Date().toISOString(),executable:process.execPath,commandLineSha256:'a'.repeat(64)},packageFullName:'OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0',tokenSha256:'b'.repeat(64),revision:0,expiresAt:Date.now()+15000});
it.each(['missing','expired','replaced'])('stops refreshing and invokes shutdown once when the owner is %s',async kind=>{
  const values={...env(),BRIDGE_SUPERVISOR_OWNER_LEASE_FILE:join(dir,'owner.json')},p=ownerProof(values.BRIDGE_SUPERVISOR_RUN_ID),lost=vi.fn();
  await writeFile(values.BRIDGE_SUPERVISOR_OWNER_LEASE_FILE,JSON.stringify(p),'utf8');
  const close=await publishListenerReady(['oc_test'],values,()=> 'connected',10,lost);closers.push(()=>close().catch(()=>{}));
  const original=await readFile(values.BRIDGE_SUPERVISOR_READY_FILE,'utf8');expect(original).not.toContain('tokenSha256');
  if(kind==='missing')await rm(values.BRIDGE_SUPERVISOR_OWNER_LEASE_FILE);else{if(kind==='expired')p.expiresAt=Date.now()-1;else p.owner.commandLineSha256='c'.repeat(64);await writeFileAtomic(values.BRIDGE_SUPERVISOR_OWNER_LEASE_FILE,JSON.stringify(p));}
  const deadline=Date.now()+2000;while(!lost.mock.calls.length&&Date.now()<deadline)await new Promise(done=>setTimeout(done,10));
  expect(lost).toHaveBeenCalledTimes(1);await new Promise(done=>setTimeout(done,40));expect(lost).toHaveBeenCalledTimes(1);
  await expect(close()).rejects.toThrow();await expect(readFile(values.BRIDGE_SUPERVISOR_READY_FILE)).rejects.toMatchObject({code:'ENOENT'});
});
it('rejects an owner file without explicit shutdown wiring or outside the ready directory',async()=>{
  const values={...env(),BRIDGE_SUPERVISOR_OWNER_LEASE_FILE:join(dir,'owner.json')};
  await expect(publishListenerReady(['oc_test'],values)).rejects.toThrow('owner handshake');
  await expect(publishListenerReady(['oc_test'],{...values,BRIDGE_SUPERVISOR_OWNER_LEASE_FILE:join(dir,'other','owner.json')},()=> 'connected',10,()=>{})).rejects.toThrow('owner handshake');
  await expect(publishListenerReady([],{BRIDGE_SUPERVISOR_OWNER_LEASE_FILE:values.BRIDGE_SUPERVISOR_OWNER_LEASE_FILE})).rejects.toThrow();
});
