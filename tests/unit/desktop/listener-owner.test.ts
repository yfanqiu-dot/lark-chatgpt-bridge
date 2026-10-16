import {beforeEach,afterEach,it,expect} from 'vitest';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ListenerOwnerLease} from '../../../src/desktop/listener-owner';
import {detachOwnedListener} from '../../../src/desktop/runtime-port';
let dir:string;
const runId='12345678-1234-1234-1234-123456789abc',now=100000;
const proof=()=>({version:1,runId,owner:{pid:12,parentPid:1,createdAt:new Date(0).toISOString(),executable:process.execPath,commandLineSha256:'a'.repeat(64)},packageFullName:'OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0',tokenSha256:'b'.repeat(64),revision:1,expiresAt:now+15000});
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'listener-owner-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
it('accepts only unchanged or renewed original lease without writing it',async()=>{
  const path=join(dir,'owner.json'),p=proof();await writeFile(path,JSON.stringify(p),'utf8');
  const lease=new ListenerOwnerLease(path,runId,()=>now,()=>true);await lease.assert();await lease.assert();expect(await readFile(path,'utf8')).toBe(JSON.stringify(p));
  p.revision++;p.expiresAt++;await writeFile(path,JSON.stringify(p),'utf8');await lease.assert();
});
it.each(['run','owner','package','capability','revision','same-revision-expiry','shorter-expiry'])('rejects a replaced or rolled back %s',async kind=>{
  const path=join(dir,'owner.json'),p=proof();await writeFile(path,JSON.stringify(p),'utf8');const lease=new ListenerOwnerLease(path,runId,()=>now,()=>true);await lease.assert();
  if(kind==='run')p.runId='22345678-1234-1234-1234-123456789abc';if(kind==='owner')p.owner.createdAt=new Date(1).toISOString();if(kind==='package')p.packageFullName='OpenAI.Codex_26.1008.1.0_x64__2p2nqsd0c76g0';if(kind==='capability')p.tokenSha256='c'.repeat(64);if(kind==='revision')p.revision=0;if(kind==='same-revision-expiry')p.expiresAt++;if(kind==='shorter-expiry'){p.revision++;p.expiresAt--;}
  await writeFile(path,JSON.stringify(p),'utf8');await expect(lease.assert()).rejects.toThrow('lease lost');
});
it.each(['expired','unbounded','dead','invalid','missing','partial'])('rejects %s owner evidence',async kind=>{
  const path=join(dir,'owner.json'),p=proof();if(kind==='expired')p.expiresAt=now;if(kind==='unbounded')p.expiresAt=now+30001;
  if(kind!=='missing')await writeFile(path,kind==='invalid'?'null':kind==='partial'?'{':JSON.stringify(p),'utf8');
  await expect(new ListenerOwnerLease(path,runId,()=>now,()=>kind!=='dead').assert()).rejects.toThrow();
});
it('only detaches the Windows listener with its original owner file',()=>{
  const env={BRIDGE_SUPERVISOR_OWNER_LEASE_FILE:join(dir,'broker-owner.json')};expect(detachOwnedListener('listener',env,dir,'win32')).toBe(true);
  for(const role of ['host','broker'] as const)expect(detachOwnedListener(role,{},dir,'win32')).toBe(false);
  expect(detachOwnedListener('listener',{},dir,'linux')).toBe(false);
  expect(()=>detachOwnedListener('listener',{},dir,'win32')).toThrow();
  expect(()=>detachOwnedListener('listener',{BRIDGE_SUPERVISOR_OWNER_LEASE_FILE:join(dir,'foreign.json')},dir,'win32')).toThrow();
});
