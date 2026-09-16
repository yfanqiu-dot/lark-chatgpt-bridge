import { afterEach, beforeEach, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopRpc, RpcError } from '../../../src/desktop/rpc';
import { DesktopBackend, UncertainExecution, type BackendHooks } from '../../../src/desktop/backend';
import type { DesktopConfig } from '../../../src/desktop/config';

let server: WebSocketServer, dir: string, endpoint: string;
let clients: DesktopRpc[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'desktop-transport-'));
  server = new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise<void>(resolve => server.once('listening', resolve));
  endpoint = `ws://127.0.0.1:${(server.address() as {port:number}).port}/`;
  clients = [];
});
afterEach(async () => {
  clients.forEach(c => c.close());
  for (const socket of server.clients) socket.terminate();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(dir,{recursive:true,force:true});
});
const hooks = (): BackendHooks => ({submitting:async()=>{},started:async()=>{},approval:async()=>{},resolved:async()=>{},state:async()=>{}});
const config = (): DesktopConfig => ({appId:'cli_test',appSecretEnv:'SECRET',chatId:'oc_test',ownerOpenId:'ou_test',projectId:'p',projectRoot:dir,threadId:'t',endpoint,connectionFile:join(dir,'lease.json'),stateFile:join(dir,'ledger.json'),requireMention:true,maxQueue:20});
function client() { const c = new DesktopRpc(endpoint,500);clients.push(c);return c; }
type Handler = (m:any,s:WebSocket)=>unknown;
function serve(handler:Handler) {
  server.on('connection',socket=>socket.on('message',data=>{
    const m=JSON.parse(data.toString());
    if (m.id===undefined || !m.method) { handler(m,socket);return; }
    if (m.method==='initialize') { socket.send(JSON.stringify({id:m.id,result:{}}));return; }
    const result=handler(m,socket);
    if (result!==undefined) socket.send(JSON.stringify({id:m.id,result}));
  }));
}
function baseline(m:any) {
  if(m.method==='project/list')return {data:[{id:'p',roots:[{path:dir}]}]};
  if(['thread/read','thread/resume'].includes(m.method))return {thread:{id:'t',projectId:'p',cwd:dir,status:{type:'idle'}}};
  if(m.method==='thread/items/list')return {data:[{turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'结果'}}]};
}

it('correlates responses, routes server requests, rejects RPC errors and times out without replay',async()=>{
  const methods:string[]=[];
  serve((m,s)=>{
    methods.push(m.method);
    if(m.method==='error')s.send(JSON.stringify({id:m.id,error:{code:-32601,message:'unsupported'}}));
    if(m.method==='request') { s.send(JSON.stringify({id:'approval',method:'item/fileChange/requestApproval',params:{threadId:'t'}}));return {ok:true}; }
  });
  const c=client();await c.connect();
  const incoming:any[]=[];c.onMessage(m=>incoming.push(m));
  expect(await c.call('request')).toEqual({ok:true});
  expect(incoming[0].id).toBe('approval');
  await expect(c.call('error')).rejects.toBeInstanceOf(RpcError);
  await expect(c.call('lost-mutation')).rejects.toThrow('timeout');
  expect(methods.filter(m=>m==='lost-mutation')).toHaveLength(1);
});

it('does not repeat a real wire submission whose response was lost',async()=>{
  let starts=0;
  serve((m,s)=>{if(m.method==='turn/start'){starts++;s.terminate();return;}return baseline(m);});
  const b=new DesktopBackend(config(),{rpcFactory:client,toolConfig:async()=>({}),pollMs:1,reconnectDelayMs:1});
  await expect(b.execute('one',hooks())).rejects.toBeInstanceOf(UncertainExecution);
  expect(starts).toBe(1);
});

it('reconnects to a known turn and returns its final output without submitting again',async()=>{
  let starts=0,reads=0,resumes=0;
  serve((m,s)=>{
    if(m.method==='thread/resume')resumes++;
    if(m.method==='turn/start'){starts++;return {turn:{id:'turn'}};}
    if(m.method==='thread/turns/list'){
      if(++reads===1){s.terminate();return;}
      return {data:[{id:'turn',status:'completed'}]};
    }
    return baseline(m);
  });
  const b=new DesktopBackend(config(),{rpcFactory:client,toolConfig:async()=>({}),pollMs:1,reconnectDelayMs:1});
  expect(await b.execute('one',hooks())).toEqual({turnId:'turn',status:'completed',text:'结果'});
  expect(starts).toBe(1);expect(resumes).toBe(2);
});

it('invalidates disconnected approval cards and handles server replay with a new token',async()=>{
  let resumes=0,starts=0,terminal=false;
  const request={id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'t',turnId:'turn',command:'echo test',availableDecisions:['accept','cancel']}};
  serve((m,s)=>{
    if(m.method==='thread/resume' && ++resumes===2)s.send(JSON.stringify(request));
    if(m.method==='turn/start'){starts++;s.send(JSON.stringify(request));return {turn:{id:'turn'}};}
    if(m.method==='thread/turns/list')return {data:[{id:'turn',status:terminal?'completed':'inProgress'}]};
    if(m.id==='approval' && m.result){terminal=true;s.send(JSON.stringify({method:'serverRequest/resolved',params:{threadId:'t',requestId:'approval'}}));}
    return baseline(m);
  });
  const b=new DesktopBackend(config(),{rpcFactory:client,toolConfig:async()=>({}),pollMs:1,reconnectDelayMs:1});
  const tokens:string[]=[],resolved:string[]=[];const h=hooks();
  h.approval=async a=>{
    tokens.push(a.token);
    if(tokens.length===1)clients[0]!.close();
    else {await expect(b.decide(tokens[0]!,'accept')).rejects.toThrow();await b.decide(a.token,'accept');}
  };
  h.resolved=async token=>{resolved.push(token);};
  expect((await b.execute('approve',h)).status).toBe('completed');
  expect(tokens).toHaveLength(2);expect(new Set(tokens).size).toBe(2);expect(resolved).toEqual(tokens);expect(starts).toBe(1);
});
