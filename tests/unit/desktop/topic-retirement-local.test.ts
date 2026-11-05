import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { TopicRegistry, parseTopicConfig } from '../../../src/desktop/topics';
import { TopicRouter } from '../../../src/desktop/topic-router';
import type { TopicProvisioner } from '../../../src/desktop/topic-provisioner';

// Opt-in read-only local acceptance. All controller and outbound ports are fakes.
const configFile=process.env.BRIDGE_RETIREMENT_LOCAL_CONFIG;
it.skipIf(!configFile)('renders /topic list against the real local retirement journal without network calls or state mutations', async()=>{
  const config=parseTopicConfig(JSON.parse(await readFile(configFile!,'utf8')));
  const before=await readFile(config.registryFile);
  const registry=new TopicRegistry(config.registryFile);await registry.load(true);
  const retired=JSON.parse(await readFile(`${config.registryFile}.retired.json`,'utf8'));
  expect(retired.topics).toHaveLength(7);expect(registry.all()).toHaveLength(7);
  expect(await registry.visible()).toEqual([]);
  const send=vi.fn(async(_chatId:string,_text:string,_replyTo:string,_replyInThread:boolean)=>'local-only');
  const controller={start:async()=>{},receive:async()=>{},decideFromCard:async()=>{},shutdown:async()=>{}};
  const router=new TopicRouter(config,registry,{} as TopicProvisioner,()=>controller,{send});
  await router.start();
  try{
    for(const chatId of [config.entryChatId,config.directControl!.chatId])await router.receive({chatId,chatType:chatId===config.directControl!.chatId?'p2p':'group',senderId:config.ownerOpenId,isBot:false,mentionedBot:true,messageId:'local-discovery-probe',content:'/topic list',replyInThread:false});
    expect(send).toHaveBeenCalledTimes(2);
    for(const call of send.mock.calls){
      expect(call[1]).toContain('暂无已建立的话题');
      for(const entry of retired.topics)expect(call[1]).not.toContain(entry.chatId);
    }
  }finally{await router.shutdown();}
  expect(createHash('sha256').update(await readFile(config.registryFile)).digest('hex')).toBe(createHash('sha256').update(before).digest('hex'));
});
