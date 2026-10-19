import {afterEach,beforeEach,expect,it} from 'vitest';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseTopicConfig,topicChannelPolicy,validateTopicScope,TopicRegistry,type TopicConfig} from '../../../src/desktop/topics';
import {TopicRouter} from '../../../src/desktop/topic-router';
import {TopicProvisioner,type TopicResources} from '../../../src/desktop/topic-provisioner';
import {DesktopController,type InboundMessage} from '../../../src/desktop/controller';
import {DesktopLedger} from '../../../src/desktop/ledger';
import type {DesktopBackend} from '../../../src/desktop/backend';
import {desktopInbound} from '../../../src/desktop/inbound';
let dir:string;const closers:Array<()=>Promise<void>>=[];
beforeEach(async()=>{dir=await realpath(await mkdtemp(join(tmpdir(),'dm-control-')));});
afterEach(async()=>{for(const close of closers.splice(0))await close();await rm(dir,{recursive:true,force:true});});
const config=()=>parseTopicConfig({appId:'cli_test',appSecretEnv:'LARK_APP_SECRET',ownerOpenId:'ou_owner',entryChatId:'oc_entry',endpoint:'ws://127.0.0.1:9999/',connectionFile:join(dir,'connection.json'),registryFile:join(dir,'registry.json'),stateDir:join(dir,'ledgers'),projects:[{key:'office',projectId:'project',projectRoot:dir}],allowTopicCreation:true,existing:{chatId:'oc_entry',projectKey:'office',threadId:'entry-thread',stateFile:join(dir,'entry.json')},directControl:{chatId:'oc_control',projectKey:'office',threadId:'control-thread',stateFile:join(dir,'control.json')}});
const dm=(id:string,content:string):InboundMessage=>({messageId:id,content,chatId:'oc_control',senderId:'ou_owner',chatType:'p2p',mentionedBot:false,replyInThread:false});
async function harness(c:TopicConfig=config()){
 const replies:Array<{chat:string;text:string;thread:boolean}>=[],executions:Array<{thread:string;prompt:string}>=[],created:string[]=[];
 const registry=new TopicRegistry(c.registryFile);
 const resources:TopicResources={verifyProject:async()=>{},verifyThread:async()=>{},nameThread:async()=>{},createThread:async(_p,title,save)=>{created.push(title);const id=`task-${created.length}`;await save(id);return id;},createChat:async()=>`oc_topic${created.length}`,verifyChat:async()=>{}};
 const send=async(chat:string,text:string,_reply:string,thread:boolean)=>{replies.push({chat,text,thread});return `receipt-${replies.length}`;};
 const router=new TopicRouter(c,registry,new TopicProvisioner(c,registry,resources),bound=>new DesktopController(bound,new DesktopLedger(bound.stateFile,{appId:bound.appId,chatId:bound.chatId,ownerOpenId:bound.ownerOpenId,projectId:bound.projectId,projectRoot:bound.projectRoot,threadId:bound.threadId}),{
  execute:async(prompt:string)=>{executions.push({thread:bound.threadId,prompt});return {status:'completed',turnId:`turn-${executions.length}`,text:`result:${prompt}`};},pendingApprovals:()=>[],stop:async()=>{},disconnect:()=>{},
 } as unknown as DesktopBackend,{send,approval:async()=>{},resolved:async()=>{}}),{send});
 await router.start();closers.push(()=>router.shutdown());
 const wait=async(count:number)=>{const until=Date.now()+3000;while(replies.length<count&&Date.now()<until)await new Promise(r=>setTimeout(r,10));expect(replies.length).toBeGreaterThanOrEqual(count);};
 return {router,registry,replies,executions,created,wait};
}
it('allows only the configured owner P2P channel without mention and preserves deduplication and group isolation',async()=>{
 const h=await harness();
 await h.router.receive(dm('m1','control work'));await h.wait(1);
 await h.router.receive(dm('m1','control work'));
 for(const m of [{...dm('other','bad'),senderId:'ou_other'},{...dm('bot','bad'),isBot:true},{...dm('foreign','bad'),chatId:'oc_foreign'},{...dm('group','bad'),chatType:'group' as const},{...dm('unknown','bad'),chatType:undefined}])await h.router.receive(m);
 await h.router.receive({...dm('no-mention','ignored'),chatId:'oc_entry',chatType:'group'});
 await h.router.receive({...dm('group-work','group work'),chatId:'oc_entry',chatType:'group',mentionedBot:true});await h.wait(2);
 expect(h.executions).toEqual([{thread:'control-thread',prompt:'control work'},{thread:'entry-thread',prompt:'group work'}]);
 await h.router.receive(dm('result','/result'));await h.wait(3);
 expect(h.replies[2]).toEqual({chat:'oc_control',text:'result:control work',thread:false});
 expect(h.replies.slice(0,2).map(r=>r.chat)).toEqual(['oc_control','oc_entry']);
},15000);
it('creates a topic from the DM once, returns its group link and routes later work into its separate thread',async()=>{
 const h=await harness();
 await h.router.receive(dm('new','/topic new office Weekly report'));
 await h.router.receive(dm('new','/topic new office Weekly report'));
 expect(h.created).toEqual(['Weekly report']);expect(h.registry.all()).toHaveLength(1);
 expect(h.replies).toHaveLength(1);expect(h.replies[0]!.text).toContain('openChatId=oc_topic1');expect(h.replies[0]!.chat).toBe('oc_control');
 await h.router.receive({...dm('special','specialized work'),chatId:'oc_topic1',chatType:'group',mentionedBot:true});await h.wait(2);
 expect(h.executions).toEqual([{thread:'task-1',prompt:'specialized work'}]);
 await h.router.receive(dm('list','/topic list'));await h.router.receive(dm('help','/help'));
 expect(h.replies[2]!.text).toContain('Weekly report');expect(h.replies[3]!.text).toContain('office');
 await h.router.receive(dm('main','main work'));await h.wait(5);
 expect(h.executions[1]!.thread).toBe('control-thread');
},15000);
it('shares provisioning intake between the group entry and DM while keeping both ordinary controllers',async()=>{
 const h=await harness();
 await Promise.all([h.router.receive(dm('a','/topic new office A')),h.router.receive({...dm('b','/topic new office B'),chatId:'oc_entry',chatType:'group',mentionedBot:true})]);
 expect(h.created).toEqual(['A','B']);expect(h.registry.all().map(r=>r.chatId)).toEqual(['oc_topic1','oc_topic2']);
 expect(h.replies.map(r=>r.chat)).toEqual(['oc_control','oc_entry']);
},15000);
it('keeps DM closed by default and honors selected-chat scope and disabled creation',async()=>{
 const c=config();expect(topicChannelPolicy(c)).toMatchObject({dmMode:'allowlist',dmAllowlist:['ou_owner']});
 expect(topicChannelPolicy({...c,directControl:undefined}).dmMode).toBe('disabled');
 expect(topicChannelPolicy({...c,enabledChatIds:['oc_entry'],allowTopicCreation:false}).dmMode).toBe('disabled');
 const h=await harness({...c,enabledChatIds:['oc_control'],allowTopicCreation:false});
 await h.router.receive(dm('new','/topic new office denied'));expect(h.created).toEqual([]);expect(h.replies[0]!.text).toContain('关闭');
},15000);
it('rejects colliding or malformed DM bindings before any controller can start',()=>{
 const c=config();
 for(const patch of [{chatId:'oc_entry'},{threadId:'entry-thread'},{stateFile:c.existing!.stateFile},{projectKey:'unknown'},{chatId:'bad'}])expect(()=>parseTopicConfig({...c,directControl:{...c.directControl,...patch}})).toThrow();
 expect(()=>validateTopicScope(c,[{requestId:'x',title:'X',projectKey:'office',projectId:'project',projectRoot:dir,stage:'active',chatId:'oc_control',threadId:'other',createdAt:'',updatedAt:''}])).toThrow('conflicts');
});
it('preserves normalized P2P identity and never replies to a DM as a topic thread',()=>{
 expect(desktopInbound({messageId:'m',chatId:'oc_control',senderId:'ou_owner',content:'work',rawContentType:'text',resources:[],mentionedBot:false,mentions:[],chatType:'p2p',threadId:'unexpected'})).toMatchObject({chatType:'p2p',mentionedBot:false,replyInThread:false});
});
