import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishListenerReady } from '../../../src/desktop/listener-ready';
import {writeFileAtomic} from '../../../src/platform/atomic-write';
let dir:string;const closers:Array<()=>Promise<void>>=[];
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'listener-ready-'));});
afterEach(async()=>{for(const close of closers.splice(0))await close();await rm(dir,{recursive:true,force:true});});
const env=()=>({BRIDGE_SUPERVISOR_READY_FILE:join(dir,'ready.json'),BRIDGE_SUPERVISOR_RUN_ID:'12345678-1234-1234-1234-123456789abc'});
it('does nothing for an existing listener without supervisor variables',async()=>{await(await publishListenerReady([],{}))();});
it.each([{BRIDGE_SUPERVISOR_RUN_ID:'bad'},{BRIDGE_SUPERVISOR_READY_FILE:'relative'}])('rejects incomplete or invalid handshake',async value=>{await expect(publishListenerReady(['oc_test'],value)).rejects.toThrow();});
it('publishes identity and connection state, advances heartbeat and removes only its own marker',async()=>{
  let state='connected';const values=env(),close=await publishListenerReady(['oc_test'],values,()=>state,10);closers.push(close);
  const initial=JSON.parse(await readFile(values.BRIDGE_SUPERVISOR_READY_FILE,'utf8'));expect(initial).toMatchObject({pid:process.pid,phase:'ready',connectionState:'connected',enabledChatIds:['oc_test']});
  state='reconnecting';const deadline=Date.now()+1000;let updated;
  do{await new Promise(done=>setTimeout(done,10));updated=JSON.parse(await readFile(values.BRIDGE_SUPERVISOR_READY_FILE,'utf8'));}while(updated.phase==='ready'&&Date.now()<deadline);
  expect(updated.phase).toBe('disconnected');expect(updated.updatedAt).toBeGreaterThan(initial.updatedAt);await close();closers.pop();await expect(readFile(values.BRIDGE_SUPERVISOR_READY_FILE)).rejects.toMatchObject({code:'ENOENT'});
});
it('keeps a marker belonging to a replacement instead of deleting it',async()=>{
  const values=env(),close=await publishListenerReady(['oc_test'],values,()=> 'connected',5000);await writeFile(values.BRIDGE_SUPERVISOR_READY_FILE,JSON.stringify({runId:'other',pid:999}),'utf8');await close();expect(JSON.parse(await readFile(values.BRIDGE_SUPERVISOR_READY_FILE,'utf8')).runId).toBe('other');
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
