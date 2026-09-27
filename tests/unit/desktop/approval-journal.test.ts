import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalJournal, type ApprovalCardPort } from '../../../src/desktop/approval-journal';
import type { Approval } from '../../../src/desktop/backend';

let dir:string;
const journals:ApprovalJournal[] = [];
const binding = {appId:'app',chatId:'chat'};
const request:Approval = {token:'token',requestId:42,threadId:'thread',turnId:'turn',method:'item/commandExecution/requestApproval',description:'test',decisions:['accept','cancel']};
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'p3-approvals-'));});
afterEach(async()=>{for(const j of journals.splice(0))await j.shutdown().catch(()=>{});await rm(dir,{recursive:true,force:true});});
function journal(port:ApprovalCardPort, identity:unknown=binding) {
  const j=new ApprovalJournal(join(dir,'approvals.json'),identity,port,60_000);journals.push(j);return j;
}

it('closes saved cards after process restart without resending or replaying decisions',async()=>{
  const sent:string[]=[],closed:string[]=[];
  const port:ApprovalCardPort={async send(chat){sent.push(chat);return 'receipt';},async close(id){closed.push(id);}};
  const a=journal(port);await a.start();await a.publish('chat',request,'source',false);await a.shutdown();
  const b=journal(port);await b.start();await b.flush();
  expect(sent).toEqual(['chat']);expect(closed).toEqual(['receipt']);
  expect(JSON.parse(await readFile(join(dir,'approvals.json'),'utf8')).cards[0].state).toBe('closed');
});

it('persists closing intent across failed updates and retries only the same card',async()=>{
  let failing=true;const ids:string[]=[];
  const port:ApprovalCardPort={async send(){return 'receipt';},async close(id){ids.push(id);if(failing)throw new Error('network offline');}};
  const a=journal(port);await a.start();await a.publish('chat',request,'source',false);await a.resolved('token');
  expect(a.pending()).toEqual({closing:1,unknown:0});await a.shutdown();
  failing=false;const b=journal(port);await b.start();await b.flush();
  expect(ids).toEqual(['receipt','receipt']);expect(b.pending()).toEqual({closing:0,unknown:0});
});

it('never retries a card send with a missing receipt, including after restart',async()=>{
  let sends=0;const port:ApprovalCardPort={async send(){sends++;throw new Error('receipt lost');},async close(){throw new Error('no known card');}};
  const a=journal(port);await a.start();await expect(a.publish('chat',request,'source',false)).rejects.toThrow('receipt lost');await a.shutdown();
  const b=journal(port);await b.start();await b.flush();
  expect(b.pending()).toEqual({closing:0,unknown:1});
  await expect(b.publish('chat',request,'source',false)).rejects.toThrow('already attempted');expect(sends).toBe(1);
});

it('marks a crash during sending as unknown without sending a new card',async()=>{
  await writeFile(join(dir,'approvals.json'),JSON.stringify({version:1,binding,cards:[{token:'token',chatId:'chat',state:'sending'}]}),'utf8');
  const b=journal({async send(){throw new Error('must not send');},async close(){throw new Error('must not close without ID');}});
  await b.start();expect(b.pending().unknown).toBe(1);
});

it('rejects a mismatched binding or malformed receipt before external updates',async()=>{
  const port:ApprovalCardPort={async send(){return 'receipt';},async close(){throw new Error('must not update');}};
  const a=journal(port);await a.start();await a.shutdown();
  await expect(journal(port,{appId:'different'}).start()).rejects.toThrow('mismatch');
  await writeFile(join(dir,'approvals.json'),JSON.stringify({version:1,binding,cards:[{token:'token',chatId:'chat',state:'open'}]}),'utf8');
  await expect(journal(port).start()).rejects.toThrow('Malformed');
});

it('starts without waiting for stale-card network updates and stops between retries',async()=>{
  await writeFile(join(dir,'approvals.json'),JSON.stringify({version:1,binding,cards:[
    {token:'one',chatId:'chat',state:'open',messageId:'one'},
    {token:'two',chatId:'chat',state:'open',messageId:'two'},
  ]}),'utf8');
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const updated:string[]=[];
  const b=journal({async send(){throw new Error('no send');},async close(id){updated.push(id);await gate;}});
  await b.start();expect(updated).toEqual(['one']);expect(b.pending().closing).toBe(2);
  const stopped=b.shutdown();release();await stopped;
  expect(updated).toEqual(['one']);expect(b.pending().closing).toBe(1);
});
