import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TopicRegistry, parseCreateTopic, parseTopicConfig, type TopicConfig, type TopicProject } from '../../../src/desktop/topics';
import { TopicProvisioner, type TopicResources } from '../../../src/desktop/topic-provisioner';
import { TopicRouter, type TopicController } from '../../../src/desktop/topic-router';
import type { InboundMessage } from '../../../src/desktop/controller';
import { TopicArchive } from '../../../src/desktop/topic-archive';
import { registeredTopicBinding, type HostConfig } from '../../../src/desktop/host';
import type { DesktopRpc } from '../../../src/desktop/rpc';
import { CodexTopicResources, FeishuTopicResources, TOPIC_BOOTSTRAP_PROMPT } from '../../../src/desktop/topic-resources';
import { WebSocketServer } from 'ws';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'desktop-p2-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const config = (): TopicConfig => parseTopicConfig({
  appId:'cli_test',appSecretEnv:'LARK_APP_SECRET',ownerOpenId:'ou_owner',entryChatId:'oc_entry',
  endpoint:'ws://127.0.0.1:9000/',connectionFile:join(dir,'connection.json'),registryFile:join(dir,'registry.json'),stateDir:join(dir,'state'),
  projects:[{key:'alpha',projectId:'p-alpha',projectRoot:dir},{key:'beta',projectId:'p-beta',projectRoot:join(dir,'beta')}],
});

function resources() {
  const calls: string[] = []; let failChatVerification = false; let unknownChatResult = false;
  const port: TopicResources = {
    async verifyProject(project: TopicProject) { calls.push(`project:${project.key}`); },
    async createThread(project: TopicProject, _title, saveId) { calls.push(`thread:${project.key}`); const id=`thread-${calls.filter(c=>c.startsWith('thread:')).length}`; await saveId(id); calls.push(`persist:${id}`); return id; },
    async verifyThread(_project, id) { calls.push(`verify-thread:${id}`); },
    async nameThread(id, title) { calls.push(`name:${id}:${title}`); },
    async createChat(title) { calls.push(`chat:${title}`); if (unknownChatResult) throw new Error('Connection dropped'); return `oc_new${calls.filter(c=>c.startsWith('chat:')).length}`; },
    async verifyChat(id) { calls.push(`verify-chat:${id}`); if (failChatVerification) throw new Error('Member not yet visible'); },
  };
  return { port, calls, setFailChatVerification(value:boolean) { failChatVerification=value; }, setUnknownChatResult(value:boolean) { unknownChatResult=value; } };
}

describe('P2 topic creation journal', () => {
  it('accepts only an explicit command and rejects unlisted projects and unsafe names', async () => {
    expect(parseCreateTopic('新建话题：普通请求')).toBeUndefined();
    expect(parseCreateTopic('/topic new alpha 会议资料')).toEqual({projectKey:'alpha',title:'会议资料'});
    expect(()=>parseCreateTopic('/topic new alpha ' + 'x'.repeat(61))).toThrow();
    const store=new TopicRegistry(config().registryFile);await store.load();
    await expect(new TopicProvisioner(config(),store,resources().port).create('m1','other','资料')).rejects.toThrow('未知项目');
    expect(store.all()).toHaveLength(0);
  });
  it('creates isolated groups and native tasks for two topics in one project and one in another', async () => {
    const store=new TopicRegistry(config().registryFile);await store.load();const r=resources();const maker=new TopicProvisioner(config(),store,r.port);
    const a=await maker.create('m1','alpha','第一话题');const b=await maker.create('m2','alpha','第二话题');const c=await maker.create('m3','beta','第三话题');
    expect(new Set([a.chatId,b.chatId,c.chatId]).size).toBe(3);
    expect(new Set([a.threadId,b.threadId,c.threadId]).size).toBe(3);
    expect([a.projectId,b.projectId,c.projectId]).toEqual(['p-alpha','p-alpha','p-beta']);
    expect(store.byChat(a.chatId!)?.threadId).toBe(a.threadId);
    expect(store.byChat(c.chatId!)?.projectId).toBe('p-beta');
    const disk=JSON.parse(await readFile(config().registryFile,'utf8'));expect(disk.topics).toHaveLength(3);
    expect(r.calls.indexOf('persist:thread-1')).toBeLessThan(r.calls.indexOf('verify-thread:thread-1'));
  });
  it('deduplicates concurrent delivery and a restart without creating another resource', async () => {
    const store=new TopicRegistry(config().registryFile);await store.load();const r=resources();const maker=new TopicProvisioner(config(),store,r.port);
    const [a,b]=await Promise.all([maker.create('m1','alpha','资料'),maker.create('m1','alpha','资料')]);expect(a.chatId).toBe(b.chatId);
    const reloaded=new TopicRegistry(config().registryFile);await reloaded.load();await new TopicProvisioner(config(),reloaded,r.port).create('m1','alpha','资料');
    expect(r.calls.filter(c=>c.startsWith('thread:'))).toHaveLength(1);
    expect(r.calls.filter(c=>c.startsWith('chat:'))).toHaveLength(1);
    await expect(new TopicProvisioner(config(),reloaded,r.port).create('m1','beta','别的')).rejects.toThrow('参数已改变');
  });
  it('resumes verification after a known group ID, but never replays a lost create response', async () => {
    const store=new TopicRegistry(config().registryFile);await store.load();const r=resources();const maker=new TopicProvisioner(config(),store,r.port);
    r.setFailChatVerification(true);await expect(maker.create('m1','alpha','资料')).rejects.toThrow('not yet');
    expect(store.byRequest('m1')).toMatchObject({stage:'chat_ready',threadId:'thread-1',chatId:'oc_new1'});
    r.setFailChatVerification(false);expect((await maker.create('m1','alpha','资料')).stage).toBe('active');
    expect(r.calls.filter(c=>c.startsWith('chat:'))).toHaveLength(1);
    r.setUnknownChatResult(true);await expect(maker.create('m2','alpha','其他')).rejects.toThrow('Connection dropped');
    expect(store.byRequest('m2')?.stage).toBe('chat_creating');
    await expect(maker.create('m2','alpha','其他')).rejects.toThrow('不会重试');
    expect(r.calls.filter(c=>c.startsWith('chat:'))).toHaveLength(2);
    await maker.attachKnownChat('m2','oc_recovered');
    r.setUnknownChatResult(false);
    expect((await maker.create('m2','alpha','其他')).chatId).toBe('oc_recovered');
    expect(r.calls.filter(c=>c.startsWith('chat:'))).toHaveLength(2);
  });
  it('can attach a verified native task after an ambiguous thread/start response', async () => {
    const store=new TopicRegistry(config().registryFile);await store.load();const r=resources();
    r.port.createThread=async()=>{throw new Error('Lost thread/start response');};
    const maker=new TopicProvisioner(config(),store,r.port);
    await expect(maker.create('m1','alpha','资料')).rejects.toThrow('Lost');
    expect(store.byRequest('m1')?.stage).toBe('thread_creating');
    await expect(maker.create('m1','alpha','资料')).rejects.toThrow('不会重试');
    await maker.attachKnownThread('m1','recovered-thread');
    expect((await maker.create('m1','alpha','资料')).threadId).toBe('recovered-thread');
  });
  it('never creates a group when task initialization has an unknown outcome', async () => {
    const store=new TopicRegistry(config().registryFile);await store.load();const r=resources();
    r.port.createThread=async (_project,_title,saveId)=>{await saveId('thread-saved');throw new Error('Initialization connection lost');};
    const maker=new TopicProvisioner(config(),store,r.port);
    await expect(maker.create('m1','alpha','资料')).rejects.toThrow('Initialization connection lost');
    expect(store.byRequest('m1')).toMatchObject({stage:'thread_initializing',threadId:'thread-saved'});
    await expect(maker.create('m1','alpha','资料')).rejects.toThrow('不会重试');
    expect(r.calls.filter(call=>call.startsWith('chat:'))).toHaveLength(0);
    await maker.attachKnownThread('m1','thread-saved');
    expect((await maker.create('m1','alpha','资料')).stage).toBe('active');
  });
});

it('names a new native task on its creation connection after journaling the ID', async () => {
  const server=new WebSocketServer({host:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const c=config();c.endpoint=`ws://127.0.0.1:${(server.address() as {port:number}).port}/`;
  await writeFile(c.connectionFile,JSON.stringify({version:1,endpoint:c.endpoint,verifiedAt:Date.now(),desktopPid:process.pid,pipeServerPid:process.pid,
    toolNames:['list_projects'],pipe:'\\\\.\\pipe\\codex-browser-use-test',mcpServer:{command:process.execPath,cwd:dir}}),'utf8');
  let named=false,savedId:string|undefined;const methods:string[]=[];
  server.on('connection',socket=>socket.on('message',data=>{
    const m=JSON.parse(data.toString());if(m.id===undefined)return;
    methods.push(m.method);
    let result:any={};let error:any;
    if(m.method==='thread/start')result={thread:{id:'new-task',projectId:'p-alpha',cwd:dir}};
    if(m.method==='thread/name/set'){
      expect(savedId).toBe('new-task');expect(m.params.name).toBe('资料');named=true;
    }
    if(m.method==='turn/start'){expect(named).toBe(true);result={turn:{id:'init-turn'}};}
    if(m.method==='thread/read'){
      if(named)result={thread:{id:'new-task',projectId:'p-alpha',cwd:dir}};
      else error={code:-32600,message:'thread not loaded'};
    }
    if(m.method==='thread/turns/list')result={data:[{status:'completed',completedAt:1}]};
    socket.send(JSON.stringify(error?{id:m.id,error}:{id:m.id,result}));
  }));
  try{
    const resources=new CodexTopicResources(c);
    const id=await resources.createThread(c.projects[0]!,'资料',async value=>{savedId=value;});
    await resources.verifyThread(c.projects[0]!,id);
    expect(id).toBe('new-task');expect(methods).toEqual(['initialize','thread/start','thread/name/set','turn/start','thread/read','initialize','thread/read','thread/turns/list']);
  }finally{for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

describe('P2 group routing', () => {
  it('routes messages and approvals only to their own topic controller', async () => {
    const c=config();const store=new TopicRegistry(c.registryFile);const r=resources();
    const received=new Map<string,string[]>(),decisions=new Map<string,string[]>(),sent:string[]=[];
    const factory=(bound:{chatId:string}):TopicController=>({
      async start(){received.set(bound.chatId,[]);decisions.set(bound.chatId,[]);},
      async receive(message){received.get(bound.chatId)!.push(message.messageId);},
      async decideFromCard(chatId,_operator,token){if(chatId!==bound.chatId)throw new Error('wrong chat');decisions.get(bound.chatId)!.push(token);},
      async shutdown(){},
    });
    const router=new TopicRouter(c,store,new TopicProvisioner(c,store,r.port),factory,{
      async send(_chatId,text){sent.push(text);return `receipt${sent.length}`;},
    });await router.start();
    const incoming=(id:string,chatId:string,content:string):InboundMessage=>({messageId:id,chatId,senderId:'ou_owner',content,mentionedBot:true,replyInThread:false});
    await router.receive(incoming('m1','oc_entry','/topic new alpha 第一话题'));
    await router.receive(incoming('m2','oc_entry','/topic new alpha 第二话题'));
    await router.receive(incoming('m3','oc_entry','/topic new beta 第三话题'));
    await router.receive(incoming('m1','oc_entry','/topic new alpha 第一话题'));
    expect(sent).toHaveLength(3);
    for(const [index,chatId] of ['oc_new1','oc_new2','oc_new3'].entries()){
      await router.receive(incoming(`reply${index}`,chatId,'继续'));await router.decideFromCard(chatId,'ou_owner',`approval${index}`,'cancel');
      expect(received.get(chatId)).toEqual([`reply${index}`]);expect(decisions.get(chatId)).toEqual([`approval${index}`]);
    }
    await router.receive(incoming('outside','oc_other','不要串群'));
    await router.receive({...incoming('stranger','oc_new1','不要处理'),senderId:'ou_other'});
    await router.receive(incoming('wrong-place','oc_new1','/topic new alpha 不在这里创建'));
    expect(received.get('oc_new1')).toEqual(['reply0']);
    expect(sent.at(-1)).toContain('请在入口群');
    expect(r.calls.filter(x=>x.startsWith('thread:'))).toHaveLength(3);
    await router.shutdown();
  });
});

describe('P2 host binding and local records', () => {
  it('gives desktop tools only to a registered task in an allowlisted project', async () => {
    const c=config(),store=new TopicRegistry(c.registryFile);await store.load();const maker=new TopicProvisioner(c,store,resources().port);
    const row=await maker.create('m1','alpha','资料');
    const host={topicRegistryFile:c.registryFile,topicProjects:[{projectId:'p-alpha',projectRoot:dir}]} as HostConfig;
    const read=async(id:string)=>({id,projectId:'p-alpha',cwd:dir});
    expect(await registeredTopicBinding(host,row.threadId!,read)).toBe(true);
    expect(await registeredTopicBinding(host,'unbound',read)).toBe(false);
    await expect(registeredTopicBinding(host,row.threadId!,async id=>({id,projectId:'p-beta',cwd:dir}))).rejects.toThrow('identity changed');
    await expect(registeredTopicBinding({...host,topicProjects:[{projectId:'p-beta',projectRoot:dir}]},row.threadId!,read)).rejects.toThrow('not allowed');
  });
  it('exports only verified native user text and final answers to the matching project', async () => {
    const c=config(),store=new TopicRegistry(c.registryFile);await store.load();const row=await new TopicProvisioner(c,store,resources().port).create('m1','alpha','资料');
    const calls:string[]=[];
    const rpc={async connect(){},close(){},async call(method:string,params:any){calls.push(method);
      if(method==='thread/read')return{thread:{id:row.threadId,projectId:'p-alpha',cwd:dir}};
      if(method==='thread/turns/list')return{data:[{id:'turn1',status:'completed',completedAt:2},{id:'init',status:'completed',completedAt:1}]};
      if(method==='thread/items/list' && params.turnId==='init')return{data:[
        {turnId:'init',item:{type:'userMessage',content:[{type:'text',text:TOPIC_BOOTSTRAP_PROMPT}]}},
        {turnId:'init',item:{type:'agentMessage',phase:'final_answer',text:'话题已就绪'}},
      ]};
      if(method==='thread/items/list')return{data:[
        {turnId:'turn1',item:{type:'userMessage',content:[{type:'text',text:'整理资料'}]}},
        {turnId:'turn1',item:{type:'agentMessage',phase:'commentary',text:'internal progress'}},
        {turnId:'turn1',item:{type:'agentMessage',phase:'final_answer',text:'已整理'}},
      ]};throw new Error(method);
    }} as unknown as DesktopRpc;
    await new TopicArchive(c,store,()=>rpc).sync(row);
    const text=await readFile(join(dir,'.lark-chatgpt-bridge','topics',`${row.chatId}.md`),'utf8');
    const index=await readFile(join(dir,'.lark-chatgpt-bridge','index.md'),'utf8');
    expect(text).toContain('整理资料');expect(text).toContain('已整理');expect(text).not.toContain('internal progress');expect(text).not.toContain(TOPIC_BOOTSTRAP_PROMPT);
    expect(index).toContain(row.threadId!);expect(index).toContain(row.chatId!);
    expect(calls).toEqual(['thread/read','thread/turns/list','thread/items/list','thread/items/list']);
  });
});

describe('P2 Feishu bot resource adapter', () => {
  it('creates a private normal group with the owner and checks membership using bot credentials', async () => {
    const requests:Array<{url:string;body?:any}>=[];
    const fetcher=async(input:string|URL|Request,init?:RequestInit)=>{
      const url=String(input);requests.push({url,body:init?.body?JSON.parse(String(init.body)):undefined});
      const data=url.includes('/tenant_access_token/')?{tenant_access_token:'token',expire:7200}
        :url.endsWith('/im/v1/chats?user_id_type=open_id')?{chat_id:'oc_created'}
        :url.includes('/members?')?{items:[{member_id:'ou_owner'}]}
        :{chat_id:'oc_created'};
      return new Response(JSON.stringify({code:0,msg:'success',data,...(url.includes('/tenant_access_token/')?data:{})}),{status:200});
    };
    const port=new FeishuTopicResources(config(),'private-secret',fetcher as typeof fetch);
    expect(await port.createChat('资料','ou_owner')).toBe('oc_created');
    await port.verifyChat('oc_created','ou_owner');
    expect(requests[1]?.body).toMatchObject({name:'资料',chat_type:'private',chat_mode:'group',owner_id:'ou_owner',user_id_list:['ou_owner']});
    expect(requests.filter(r=>r.url.includes('/tenant_access_token/'))).toHaveLength(1);
  });
});
