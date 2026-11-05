import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TopicRegistry, parseTopicConfig, validateTopicScope, type TopicRecord } from '../../../src/desktop/topics';
import { TopicProvisioner } from '../../../src/desktop/topic-provisioner';
import { TopicRouter } from '../../../src/desktop/topic-router';
import { TopicArchive } from '../../../src/desktop/topic-archive';
import type { DesktopRpc } from '../../../src/desktop/rpc';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'topic-retirement-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const config = parseTopicConfig({ appId:'cli_test', appSecretEnv:'LARK_APP_SECRET', ownerOpenId:'ou_owner', entryChatId:'oc_entry',
    directControl:{chatId:'oc_direct',projectKey:'main',threadId:'direct-thread',stateFile:join(dir,'direct.json')},
    endpoint:'ws://127.0.0.1:9000/', connectionFile:join(dir,'connection.json'), registryFile:join(dir,'registry.json'), stateDir:join(dir,'state'),
    projects:[{key:'main',projectId:'project',projectRoot:dir}], requireMention:true });
  const registry = new TopicRegistry(config.registryFile); await registry.load();
  for (const key of ['test', 'business']) await registry.add({requestId:`request-${key}`,title:key,projectKey:'main',projectId:'project',projectRoot:dir,stage:'active',chatId:`oc_${key}`,threadId:`thread-${key}`,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  const row = registry.byChat('oc_test')!;
  const entry = {requestId:row.requestId,chatId:row.chatId,threadId:row.threadId,retiredAt:new Date().toISOString(),reason:'Verified test group dissolution',evidenceFile:join(dir,'deletion-evidence.json')};
  const retire = (topics: unknown[] = [entry]) => writeFile(`${config.registryFile}.retired.json`, JSON.stringify({version:1,topics}), 'utf8');
  return {config,registry,row,entry,retire};
}

describe('retired topic discovery', () => {
  it('reads retirement changes without mutating original bindings or excluding business topics', async () => {
    const {registry,config,retire} = await fixture();
    const before = await readFile(config.registryFile, 'utf8');
    expect((await registry.visible()).map(row=>row.title)).toEqual(['test','business']);
    await retire();
    expect((await registry.visible()).map(row=>row.title)).toEqual(['business']);
    const restarted = new TopicRegistry(config.registryFile); await restarted.load(true);
    expect((await restarted.visible()).map(row=>row.title)).toEqual(['business']);
    expect(restarted.all()).toHaveLength(2);
    expect(await readFile(config.registryFile,'utf8')).toBe(before);
    expect(()=>validateTopicScope(config,restarted.all())).not.toThrow();
  });
  it.each(['chatId','threadId','requestId','retiredAt','reason','evidenceFile'])('rejects mismatched or invalid retirement %s instead of hiding unrelated topics', async key => {
    const {registry,retire,entry} = await fixture();
    await retire([{...entry,[key]:''}]);
    await expect(registry.visible()).rejects.toThrow('Invalid topic retirement');
    expect(registry.all()).toHaveLength(2);
  });
  it('rejects duplicate and malformed retirement journals', async () => {
    const {registry,config,retire,entry} = await fixture();
    await retire([entry,entry]); await expect(registry.visible()).rejects.toThrow('Invalid topic retirement');
    await writeFile(`${config.registryFile}.retired.json`,'{}','utf8');
    await expect(registry.visible()).rejects.toThrow('Invalid topic retirement journal');
  });
  it.each(['oc_entry','oc_direct'])('omits retired links from /topic list in %s', async chatId => {
    const {registry,config,retire} = await fixture(); await retire();
    const send = vi.fn(async(_chatId:string,_text:string,_replyTo:string,_replyInThread:boolean)=> 'receipt');
    const controller = {start:vi.fn(async()=>{}),receive:vi.fn(async()=>{}),decideFromCard:vi.fn(async()=>{}),shutdown:vi.fn(async()=>{})};
    const router = new TopicRouter(config,registry,{} as TopicProvisioner,()=>controller,{send});
    await router.start();
    try {
      await router.receive({chatId,chatType:chatId==='oc_direct'?'p2p':'group',senderId:'ou_owner',isBot:false,mentionedBot:true,messageId:'query',content:'/topic list',replyInThread:false});
      expect(send).toHaveBeenCalledOnce();
      const text = send.mock.calls[0]![1];
      expect(text).toContain('oc_business'); expect(text).not.toContain('oc_test');
    } finally { await router.shutdown(); }
  });
  it('keeps the complete binding journal after the final visible topic retires', async () => {
    const {registry,config,entry,retire} = await fixture();
    const business = registry.byChat('oc_business')!;
    await retire([entry,{...entry,requestId:business.requestId,chatId:business.chatId,threadId:business.threadId}]);
    expect(await registry.visible()).toEqual([]);
    expect(registry.all()).toHaveLength(2);
  });
  it('blocks resuming a retired request without creating replacement resources', async () => {
    const {registry,config,retire,row} = await fixture(); await retire();
    const resources = {verifyProject:vi.fn(),createThread:vi.fn(),verifyThread:vi.fn(),nameThread:vi.fn(),createChat:vi.fn(),verifyChat:vi.fn()};
    const provisioner = new TopicProvisioner(config,registry,resources);
    await expect(provisioner.create(row.requestId,row.projectKey,row.title)).rejects.toThrow('已退役');
    expect(resources.createThread).not.toHaveBeenCalled(); expect(resources.createChat).not.toHaveBeenCalled();
    const business = registry.byChat('oc_business') as TopicRecord;
    await expect(provisioner.create(business.requestId,business.projectKey,business.title)).resolves.toEqual(business);
  });
  it('removes retired discovery links while retaining the local history file', async () => {
    const {registry,config,retire,row} = await fixture();
    const rpc = {connect:async()=>{},close:()=>{},call:async(method:string)=>{
      if(method==='thread/read')return {thread:{id:row.threadId,projectId:row.projectId,cwd:row.projectRoot}};
      if(method==='thread/turns/list')return {data:[]};
      throw new Error(method);
    }} as unknown as DesktopRpc;
    const archive = new TopicArchive(config,registry,()=>rpc);
    await archive.sync(row);
    const history = await readFile(join(dir,'.lark-chatgpt-bridge','topics',`${row.chatId}.md`),'utf8');
    await retire(); await archive.sync(row); await archive.shutdown();
    const index = await readFile(join(dir,'.lark-chatgpt-bridge','index.md'),'utf8');
    expect(index).not.toContain(row.chatId);
    expect(index).toContain('oc_business');
    expect(await readFile(join(dir,'.lark-chatgpt-bridge','topics',`${row.chatId}.md`),'utf8')).toContain(row.threadId!);
    expect(history).toContain(row.threadId!);
  });
});
