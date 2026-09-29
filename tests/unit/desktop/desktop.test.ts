import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBackend, UncertainExecution, readDesktopToolConfig, type BackendHooks, type RpcTransport } from '../../../src/desktop/backend';
import { DesktopController, type ReplyPort, type InboundMessage } from '../../../src/desktop/controller';
import { DesktopLedger, type Binding } from '../../../src/desktop/ledger';
import { parseDesktopConfig, type DesktopConfig } from '../../../src/desktop/config';
import { loopbackEndpoint, type RpcMessage } from '../../../src/desktop/rpc';
import { desktopInbound } from '../../../src/desktop/inbound';

let dir: string;
beforeEach(async () => { dir = await realpath(await mkdtemp(join(tmpdir(), 'desktop-p1-'))); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const config = (): DesktopConfig => ({ appId: 'cli_test', appSecretEnv: 'LARK_APP_SECRET', chatId: 'oc_test', ownerOpenId: 'ou_owner', projectId: 'project', projectRoot: dir, threadId: 'thread', endpoint: 'ws://127.0.0.1:9000/', stateFile: join(dir,'ledger.json'), connectionFile: join(dir,'connection.json'), requireMention: true, maxQueue: 20 });
const binding = (): Binding => { const c = config(); return { appId: c.appId, chatId: c.chatId, ownerOpenId: c.ownerOpenId, projectId: c.projectId, projectRoot: c.projectRoot, threadId: c.threadId }; };
class FakeRpc implements RpcTransport {
  connected = false;
  calls: Array<{ method: string; params: any }> = [];
  responses: any[] = [];
  listeners: Array<(m: RpcMessage) => void> = [];
  terminal = 'completed'; approval = false; dropStart = false; wrongThread = false; pageItems = true; desktopActive = false; threadLoaded = true;
  extraRequest?: RpcMessage;
  connectCount = 0;
  async connect() { this.connected = true; this.connectCount++; }
  close() { this.connected = false; }
  onMessage(fn: (m: RpcMessage) => void) { this.listeners.push(fn); return () => {}; }
  emit(m: RpcMessage) { this.listeners.forEach(fn => fn(m)); }
  respond(id: string | number, result: unknown) { this.responses.push({ id, result }); this.emit({ method: 'serverRequest/resolved', params: { threadId:'thread', requestId:id } }); this.terminal = (result as any).decision === 'cancel' ? 'interrupted' : 'completed'; }
  async call<T = any>(method: string, params?: any): Promise<T> {
    this.calls.push({ method, params });
    let result: any;
    const thread = { id: this.wrongThread ? 'other' : 'thread', projectId:'project', cwd:dir, status:{ type:this.threadLoaded?(this.desktopActive?'active':'idle'):'notLoaded' } };
    switch (method) {
      case 'project/list': result = { data: params.cursor ? [{ id:'project', roots:[{path:dir}] }] : [], nextCursor: params.cursor ? null : 'projects2' }; break;
      case 'thread/read': result = { thread }; break;
      case 'thread/resume': this.threadLoaded=true; thread.status.type=this.desktopActive?'active':'idle'; result = { thread }; break;
      case 'mcpServerStatus/list': result = {data:[{name:'codex_app',runtimeStatus:'connected',tools:{list_projects:{name:'list_projects'}}}]}; break;
      case 'turn/start':
        if (this.dropStart) { this.connected = false; throw new Error('Response lost'); }
        if (this.extraRequest) { this.terminal='inProgress';this.emit(this.extraRequest); }
        if (this.approval) {
          this.terminal = 'inProgress';
          this.emit({ id:42, method:'item/commandExecution/requestApproval', params: { threadId:'thread', turnId:'turn', command:'Write-Output test', availableDecisions:['accept','cancel'] } });
          this.emit({ id:43, method:'item/commandExecution/requestApproval', params: { threadId:'other', turnId:'turn', command:'OTHER', availableDecisions:['accept'] } });
        }
        result = { turn:{id:'turn'} }; break;
      case 'thread/turns/list': result = { data: params.cursor ? [{id:'turn',status:this.terminal,completedAt:this.terminal==='inProgress'?null:1}] : [{id:'unrelated',status:'completed',completedAt:1}], nextCursor: params.cursor ? null : 'turns2' }; break;
      case 'thread/items/list': result = params.cursor || !this.pageItems ? {data:[{turnId:'turn',item:{type:'agentMessage',phase:'final_answer',text:'actual final'}}]} : {data:[{turnId:'turn',item:{type:'agentMessage',phase:'commentary',text:'not final'}}],nextCursor:'items2'}; break;
      case 'turn/interrupt': this.terminal = 'interrupted'; result = {}; break;
      case 'turn/steer': result = {}; break;
      default: throw new Error(method);
    }
    return result;
  }
}
const hooks = (): BackendHooks => ({ submitting:async()=>{},started:async()=>{},approval:async()=>{},resolved:async()=>{},state:async()=>{} });
const backend = (rpc: FakeRpc) => new DesktopBackend(config(), {rpcFactory:()=>rpc,toolConfig:async()=>({}),pollMs:1,reconnectDelayMs:1});
const incoming = (id: string): InboundMessage => ({messageId:id,chatId:'oc_test',senderId:'ou_owner',content:'hello',mentionedBot:true,replyInThread:true});
function replies(): ReplyPort & { sent: string[] } { return {sent:[],async send(_c,text){this.sent.push(text);return 'receipt'+this.sent.length;},async approval(){},async resolved(){}}; }

describe('desktop boundaries and history', () => {
  it('waits for a temporarily invalidated desktop lease before a new submission',async()=>{
    const c=config();
    const pending=readDesktopToolConfig(c,2000);
    await new Promise(resolve=>setTimeout(resolve,20));
    await writeFile(c.connectionFile,JSON.stringify({version:1,endpoint:c.endpoint,verifiedAt:Date.now(),desktopPid:process.pid,pipeServerPid:process.pid,
      toolNames:['list_projects'],pipe:'\\\\.\\pipe\\codex-browser-use-test',mcpServer:{command:process.execPath,cwd:dir}}),'utf8');
    expect(await pending).toHaveProperty('mcp_servers.codex_app');
  });
  it('checks idle task runtime without starting a model turn and refuses an active desktop task',async()=>{
    const rpc=new FakeRpc();await backend(rpc).preflightTools();
    expect(rpc.calls.some(c=>c.method==='mcpServerStatus/list')).toBe(true);expect(rpc.calls.some(c=>c.method==='turn/start')).toBe(false);
    const active=new FakeRpc();active.desktopActive=true;
    await expect(backend(active).preflightTools()).rejects.toThrow('active');
    expect(active.calls.some(c=>c.method==='thread/resume')).toBe(false);
  });
  it('rejects remote endpoints, credentials, and incomplete bindings', () => {
    for (const url of ['ws://example.com:9','wss://127.0.0.1:9','ws://user@127.0.0.1:9','ws://127.0.0.1:9/x']) expect(()=>loopbackEndpoint(url)).toThrow();
    expect(()=>parseDesktopConfig({...config(),ownerOpenId:''})).toThrow();
  });
  it('validates project pagination, blocks wrong task before resume', async()=>{
    const rpc=new FakeRpc();rpc.wrongThread=true;
    await expect(backend(rpc).preflight()).rejects.toThrow('mismatch');
    expect(rpc.calls.some(c=>c.method==='thread/resume')).toBe(false);
  });
  it('reads final answer across turn and item pages without mixing commentary',async()=>{
    const rpc=new FakeRpc();const r=await backend(rpc).execute('question',hooks());
    expect(r).toEqual({turnId:'turn',status:'completed',text:'actual final'});
    expect(rpc.calls.filter(c=>c.method==='turn/start')).toHaveLength(1);
    expect(rpc.calls.find(c=>c.method==='turn/start')?.params).not.toHaveProperty('approvalPolicy');
  });
  it('does not resubmit when start response is lost',async()=>{
    const rpc=new FakeRpc();rpc.dropStart=true;
    await expect(backend(rpc).execute('question',hooks())).rejects.toBeInstanceOf(UncertainExecution);
    expect(rpc.calls.filter(c=>c.method==='turn/start')).toHaveLength(1);
  });
  it('resumes known turns without starting another turn',async()=>{
    const rpc=new FakeRpc();await backend(rpc).execute('ignored',hooks(),'turn');
    expect(rpc.calls.some(c=>c.method==='turn/start')).toBe(false);
  });
  it('matches approval by thread and turn, rejects duplicates, waits for resolved',async()=>{
    const rpc=new FakeRpc();rpc.approval=true;const b=backend(rpc);const h=hooks();const tokens:string[]=[];const resolved:string[]=[];
    h.approval=async a=>{tokens.push(a.token);await b.decide(a.token,'accept');await expect(b.decide(a.token,'accept')).rejects.toThrow();};
    h.resolved=async t=>{resolved.push(t);};
    await b.execute('approval',h);
    expect(tokens).toHaveLength(1);expect(resolved).toEqual(tokens);expect(rpc.responses).toEqual([{id:42,result:{decision:'accept'}}]);
    await expect(b.decide(tokens[0]!,'accept')).rejects.toThrow();
  });
  it('stops only the known turn and does not terminate the shared backend',async()=>{
    const rpc=new FakeRpc();rpc.approval=true;const b=backend(rpc);const h=hooks();h.approval=async()=>{await b.stop();};
    expect((await b.execute('stop',h)).status).toBe('interrupted');
    expect(rpc.calls.find(c=>c.method==='turn/interrupt')?.params).toEqual({threadId:'thread',turnId:'turn'});
  });
  it('cancels a queued request without changing or interrupting the desktop-owned turn',async()=>{
    const rpc=new FakeRpc();rpc.desktopActive=true;const b=backend(rpc),h=hooks();
    h.state=async()=>{await b.stop();};
    expect((await b.execute('queued',h)).status).toBe('interrupted');
    expect(rpc.calls.some(c=>['turn/start','turn/interrupt','thread/resume'].includes(c.method))).toBe(false);
  });
  it('steers only the exact active turn',async()=>{
    const rpc=new FakeRpc();rpc.approval=true;const b=backend(rpc),h=hooks();
    h.approval=async()=>{await b.steer('new instructions');await b.stop();};await b.execute('run',h);
    expect(rpc.calls.find(c=>c.method==='turn/steer')?.params).toEqual({threadId:'thread',expectedTurnId:'turn',input:[{type:'text',text:'new instructions'}]});
  });
  it('never exposes accept on a file approval whose concrete changes are missing',async()=>{
    const rpc=new FakeRpc();rpc.extraRequest={id:99,method:'item/fileChange/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'missing'}};
    const b=backend(rpc),h=hooks();h.approval=async a=>{expect(a.decisions).toEqual(['decline','cancel']);await expect(b.decide(a.token,'accept')).rejects.toThrow();await b.decide(a.token,'cancel');};
    expect((await b.execute('file',h)).status).toBe('interrupted');
  });
  it('routes special permission requests to the desktop without inventing a grant',async()=>{
    const rpc=new FakeRpc();rpc.extraRequest={id:99,method:'item/permissions/requestApproval',params:{threadId:'thread',turnId:'turn',itemId:'item'}};
    const b=backend(rpc),h=hooks();h.approval=async a=>{expect(a.decisions).toEqual([]);expect(a.description).toContain('桌面');await b.stop();};
    await b.execute('permissions',h);expect(rpc.responses).toHaveLength(0);
  });
});
describe('durable single-group controller',()=>{
  it('accepts a formatted Feishu text message through the real intake mapping and deduplicates it',async()=>{
    // Regression: the first real 09/23 calibration question was a `post` envelope.
    const inbound=desktopInbound({messageId:'post-question',chatId:'oc_test',senderId:'ou_owner',content:'@QIU 现在的校验词是什么？',rawContentType:'post',resources:[],mentionedBot:true,mentions:[{key:'@_user_1',name:'QIU',openId:'ou_bot'}]},'ou_bot');
    expect(inbound?.content.trim()).toBe('现在的校验词是什么？');
    const rpc=new FakeRpc(),store=new DesktopLedger(config().stateFile,binding());
    const c=new DesktopController(config(),store,backend(rpc),replies());await c.start();
    await c.receive(inbound!);await c.receive(inbound!);await c.idle();
    expect(rpc.calls.filter(r=>r.method==='turn/start')).toHaveLength(1);
    expect(store.all()[0]?.prompt).toBe('现在的校验词是什么？');
    expect(desktopInbound({...inbound!,resources:[{type:'image'}],mentions:[],rawContentType:'post'})).toBeUndefined();
    expect(desktopInbound({...inbound!,resources:[],mentions:[],rawContentType:'interactive'})).toBeUndefined();
  });
  it('deduplicates message IDs and serially executes three rounds',async()=>{
    const rpc=new FakeRpc();const out=replies();const store=new DesktopLedger(config().stateFile,binding());const c=new DesktopController(config(),store,backend(rpc),out);await c.start();
    await Promise.all(['a','a','b','c'].map(id=>c.receive(incoming(id))));await c.idle();
    expect(rpc.calls.filter(x=>x.method==='turn/start')).toHaveLength(3);expect(store.all()).toHaveLength(3);expect(out.sent).toHaveLength(3);
    const saved=JSON.parse(await readFile(config().stateFile,'utf8'));expect(saved.messages.every((x:any)=>x.receipt)).toBe(true);
  });
  it('ignores another group, another sender, bots and missing mention',async()=>{
    const rpc=new FakeRpc();const store=new DesktopLedger(config().stateFile,binding());const c=new DesktopController(config(),store,backend(rpc),replies());await c.start();
    for(const patch of [{chatId:'oc_other'},{senderId:'ou_other'},{isBot:true},{mentionedBot:false}])await c.receive({...incoming('a'),...patch});
    expect(store.all()).toHaveLength(0);expect(rpc.calls).toHaveLength(0);
    await expect(c.decideFromCard('oc_other','ou_owner','token','accept')).rejects.toThrow('无权');
  });
  it('marks in-flight persisted submissions uncertain and blocks queued work after restart',async()=>{
    const store=new DesktopLedger(config().stateFile,binding());await store.load();await store.add({messageId:'old',prompt:'old',replyInThread:false,state:'submitting'});
    const rpc=new FakeRpc();const reloaded=new DesktopLedger(config().stateFile,binding());const c=new DesktopController(config(),reloaded,backend(rpc),replies());await c.start();await c.receive(incoming('new'));await c.idle();
    expect(reloaded.get('old')?.state).toBe('uncertain');expect(reloaded.get('new')?.state).toBe('queued');expect(rpc.calls).toHaveLength(0);
  });
  it('persists final result on delivery loss and never reruns the model for /result',async()=>{
    const rpc=new FakeRpc();const out=replies();out.send=async()=>{throw new Error('receipt lost');};const store=new DesktopLedger(config().stateFile,binding());const c=new DesktopController(config(),store,backend(rpc),out);await c.start();await c.receive(incoming('a'));await c.idle();
    expect(store.get('a')).toMatchObject({state:'completed',result:'actual final',deliveryAttempted:true});
    await c.receive({...incoming('b'),content:'/result'});await c.idle();expect(rpc.calls.filter(x=>x.method==='turn/start')).toHaveLength(1);
  });
  it('refuses loading a ledger for a different project/chat binding',async()=>{
    const store=new DesktopLedger(config().stateFile,binding());await store.load();
    await expect(new DesktopLedger(config().stateFile,{...binding(),chatId:'oc_elsewhere'}).load()).rejects.toThrow('mismatch');
  });
  it('delivers a final result saved before shutdown without another model call',async()=>{
    const store=new DesktopLedger(config().stateFile,binding());await store.load();
    await store.add({messageId:'saved',prompt:'question',replyInThread:true,state:'completed',result:'saved final'});
    const rpc=new FakeRpc(),out=replies();
    const c=new DesktopController(config(),new DesktopLedger(config().stateFile,binding()),backend(rpc),out);
    await c.start();await c.idle();expect(out.sent).toEqual(['saved final']);expect(rpc.calls).toHaveLength(0);
  });
  it('reconciles a known turn and delivers its newly confirmed final result once',async()=>{
    const store=new DesktopLedger(config().stateFile,binding());await store.load();
    await store.add({messageId:'old',prompt:'question',replyInThread:true,state:'uncertain',turnId:'turn',result:'uncertain',receipt:'previous',deliveryAttempted:true});
    const rpc=new FakeRpc(),out=replies();const c=new DesktopController(config(),store,backend(rpc),out);
    await c.start();await c.receive({...incoming('command'),content:'/reconcile'});await c.idle();
    expect(store.get('old')).toMatchObject({state:'completed',result:'actual final'});
    expect(out.sent.filter(x=>x==='actual final')).toHaveLength(1);expect(rpc.calls.some(x=>x.method==='turn/start')).toBe(false);
  });
});

describe('P3 recovery and desktop concurrency', () => {
  it('automatically observes a persisted known turn before releasing queued work, without replaying it', async () => {
    const store = new DesktopLedger(config().stateFile, binding()); await store.load();
    await store.add({messageId:'old',prompt:'old',replyInThread:false,state:'running',turnId:'turn'});
    await store.add({messageId:'next',prompt:'next',replyInThread:false,state:'queued'});
    const rpc = new FakeRpc(), out = replies();
    const recovered = new DesktopLedger(config().stateFile, binding());
    const c = new DesktopController(config(), recovered, backend(rpc), out);
    await c.start(); await c.idle();
    expect(recovered.all().map(r => r.state)).toEqual(['completed','completed']);
    expect(rpc.calls.filter(r => r.method === 'turn/start')).toHaveLength(1);
    expect(rpc.calls.find(r => r.method === 'turn/start')?.params.input[0].text).toBe('next');
    expect(out.sent).toHaveLength(2);
  });

  it('attempts failed startup reconciliation only once and leaves subsequent work queued', async () => {
    const store = new DesktopLedger(config().stateFile, binding()); await store.load();
    await store.add({messageId:'old',prompt:'old',replyInThread:false,state:'running',turnId:'turn'});
    const rpc = new FakeRpc(); rpc.connect = async () => { rpc.connectCount++; throw new Error('host offline'); };
    const c = new DesktopController(config(),store,backend(rpc),replies());
    await c.start(); await c.idle(); await c.receive(incoming('next')); await c.idle();
    expect(rpc.connectCount).toBe(1); expect(store.get('old')?.state).toBe('uncertain');
    expect(store.get('next')?.state).toBe('queued');
    await c.receive({...incoming('retry'),content:'/reconcile'}); await c.idle();
    expect(rpc.connectCount).toBe(2); expect(rpc.calls.some(r => r.method === 'turn/start')).toBe(false);
  });

  it('does not resend an ambiguous reply after restart and /result reads the saved answer', async () => {
    const store = new DesktopLedger(config().stateFile,binding()); await store.load();
    await store.add({messageId:'old',prompt:'old',replyInThread:false,state:'completed',turnId:'turn',result:'saved answer',deliveryAttempted:true});
    const rpc = new FakeRpc(), out = replies(); const c = new DesktopController(config(),store,backend(rpc),out);
    await c.start(); await c.idle(); expect(out.sent).toEqual([]);
    await c.receive({...incoming('result'),content:'/result'}); await c.idle();
    expect(out.sent).toEqual(['saved answer']); expect(rpc.calls).toEqual([]);
  });

  it('defers submission when the desktop starts work during tool verification', async () => {
    const rpc = new FakeRpc(), original = rpc.call.bind(rpc);
    rpc.call = async (method, params) => { const result = await original(method,params); if(method === 'mcpServerStatus/list') rpc.desktopActive = true; return result; };
    const b = backend(rpc), h = hooks(); h.state = async () => { await b.stop(); };
    expect((await b.execute('queued',h)).status).toBe('interrupted');
    expect(rpc.calls.some(c => ['turn/start','turn/interrupt'].includes(c.method))).toBe(false);
  });

  it('refuses to submit when the server does not confirm an idle task', async () => {
    const rpc = new FakeRpc(), original = rpc.call.bind(rpc);
    rpc.call = async (method, params) => { const result = await original(method,params); if(method === 'thread/read') delete result.thread.status; return result; };
    await expect(backend(rpc).execute('run',hooks())).rejects.toThrow('not idle');
    expect(rpc.calls.some(c => c.method === 'turn/start')).toBe(false);
  });

  it('loads a saved task from notLoaded before configuring tools and submitting once', async () => {
    const rpc = new FakeRpc(); rpc.threadLoaded=false;
    expect((await backend(rpc).execute('run',hooks())).status).toBe('completed');
    const resumes=rpc.calls.filter(c=>c.method==='thread/resume');
    expect(resumes).toHaveLength(2);
    expect(resumes[0]!.params).not.toHaveProperty('config');
    expect(resumes[1]!.params).toHaveProperty('config');
    expect(rpc.calls.filter(c=>c.method==='turn/start')).toHaveLength(1);
  });

  it('does not submit if a saved task remains notLoaded after resume', async () => {
    const rpc=new FakeRpc(); rpc.threadLoaded=false;
    const original=rpc.call.bind(rpc);
    rpc.call=async (method,params)=>{
      const result=await original(method,params);
      if(method==='thread/resume'){rpc.threadLoaded=false;result.thread.status.type='notLoaded';}
      return result;
    };
    await expect(backend(rpc).execute('run',hooks())).rejects.toThrow('remained unloaded');
    expect(rpc.calls.some(c=>c.method==='turn/start')).toBe(false);
  });

  it('keeps a live approval available when the Feishu card send fails', async () => {
    const rpc = new FakeRpc(); rpc.approval = true;
    const b = backend(rpc), h = hooks(); h.approval = async () => { throw new Error('Feishu offline'); };
    h.state = async state => { if(state.includes('通知回传失败')) await b.decide(b.pendingApprovals()[0]!.token,'accept'); };
    expect((await b.execute('approval',h)).status).toBe('completed');
    expect(rpc.responses).toHaveLength(1); expect(rpc.connectCount).toBe(1);
  });

  it('reconnects during approval without applying config to an active task or replaying decisions', async () => {
    const first = new FakeRpc(), second = new FakeRpc(); first.approval = true;
    const originalFirst = first.call.bind(first), originalSecond = second.call.bind(second);
    first.call = async (method, params) => { if(method === 'thread/turns/list') { first.connected = false; throw new Error('wire dropped'); } return originalFirst(method,params); };
    second.desktopActive = true;
    second.call = async (method, params) => {
      const result = await originalSecond(method,params);
      if(method === 'thread/resume') {
        expect(params).not.toHaveProperty('config');
        second.terminal = 'inProgress';
        second.emit({id:42,method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn',command:'echo test',availableDecisions:['accept','cancel']}});
        // A late event on the old socket cannot resolve the new request.
        first.emit({method:'serverRequest/resolved',params:{threadId:'thread',requestId:42}});
      }
      return result;
    };
    let connects = 0; const b = new DesktopBackend(config(),{rpcFactory:()=>++connects === 1 ? first : second,toolConfig:async()=>({}),pollMs:1,reconnectDelayMs:1});
    const h = hooks(), tokens:string[] = [];
    h.resolved = async () => { throw new Error('card update offline'); };
    h.approval = async a => { tokens.push(a.token); if(tokens.length === 2) { await expect(b.decide(tokens[0]!,'accept')).rejects.toThrow(); await b.decide(a.token,'accept'); } };
    expect((await b.execute('approval',h)).status).toBe('completed');
    expect(tokens).toHaveLength(2); expect(first.responses).toHaveLength(0); expect(second.responses).toHaveLength(1);
    expect([...first.calls,...second.calls].filter(c=>c.method==='turn/start')).toHaveLength(1);
  });
});
