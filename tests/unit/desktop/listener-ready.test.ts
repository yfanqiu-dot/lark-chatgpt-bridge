import { afterEach,beforeEach,expect,it } from 'vitest';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishListenerReady } from '../../../src/desktop/listener-ready';
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
