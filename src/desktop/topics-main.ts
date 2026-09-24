import { readFile, rm, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';
import { createLarkChannel } from '@larksuite/channel';
import { acquireAppRuntimeLock } from '../runtime/locks';
import { resolveAppPaths } from '../config/app-paths';
import { writeFileAtomic } from '../platform/atomic-write';
import { DesktopBackend, readDesktopToolConfig } from './backend';
import { DesktopController } from './controller';
import { DesktopLedger } from './ledger';
import { approvalCard, resolvedCard } from './cards';
import { desktopInbound } from './inbound';
import { parseTopicConfig, TopicRegistry } from './topics';
import { TopicProvisioner } from './topic-provisioner';
import { CodexTopicResources, topicResources } from './topic-resources';
import { TopicRouter } from './topic-router';
import { TopicArchive } from './topic-archive';

async function main(): Promise<void> {
  const [configPath, mode, requestId, resourceId] = process.argv.slice(2);
  if (!configPath || !['--check','--run','--stop','--repair-thread','--repair-chat'].includes(mode ?? '')) throw new Error('Usage: lark-chatgpt-topics <config.json> --check|--run|--stop|--repair-thread <messageId> <threadId>|--repair-chat <messageId> <chatId> (Node.js >=22)');
  const config = parseTopicConfig(JSON.parse(await readFile(configPath, 'utf8')));
  if (mode === '--stop') {
    if (!await lockfile.check(config.registryFile, {realpath:false})) throw new Error('No topic bridge owns this registry');
    await writeFileAtomic(`${config.registryFile}.stop`, 'Stop the topic bridge gracefully'); return;
  }
  if (mode === '--repair-thread' || mode === '--repair-chat') {
    if (!requestId || !resourceId) throw new Error('Repair requires a source message ID and verified resource ID');
    if (await lockfile.check(config.registryFile, {realpath:false})) throw new Error('Stop the topic bridge before repairing its registry');
    const unlock = await lockfile.lock(config.registryFile, {realpath:false,retries:0});
    try {
      const registry = new TopicRegistry(config.registryFile); await registry.load();
      const secret = process.env[config.appSecretEnv];
      if (mode === '--repair-chat' && !secret) throw new Error(`Missing secret environment variable ${config.appSecretEnv}`);
      const maker = new TopicProvisioner(config,registry,topicResources(config,secret ?? ''));
      const row = mode === '--repair-thread' ? await maker.attachKnownThread(requestId,resourceId) : await maker.attachKnownChat(requestId,resourceId);
      console.log(`Verified ${row.stage} for source message ${row.requestId}. Use /topic resume in the entry group to continue.`);
    } finally { await unlock(); }
    return;
  }
  await readDesktopToolConfig(config);
  const codex = new CodexTopicResources(config);
  for (const project of config.projects) await codex.verifyProject(project);
  if (mode === '--check') { console.log('Topic projects and desktop tool lease verified. Feishu not connected.'); return; }
  const secret = process.env[config.appSecretEnv];
  if (!secret) throw new Error(`Missing secret environment variable ${config.appSecretEnv}`);
  await mkdir(dirname(config.registryFile), {recursive:true}); await mkdir(config.stateDir, {recursive:true});
  const appLock = await acquireAppRuntimeLock(resolveAppPaths({profile:'codex-desktop'}), config.appId, 'codex');
  let releaseRegistry: () => Promise<void>;
  try { releaseRegistry = await lockfile.lock(config.registryFile, {realpath:false,retries:0}); }
  catch (e) { await appLock.release(); throw e; }
  const release = async () => { await releaseRegistry(); await appLock.release(); };
  const registry = new TopicRegistry(config.registryFile);
  const archive = new TopicArchive(config,registry);
  const channel = createLarkChannel({appId:config.appId,appSecret:secret,domain:'https://open.feishu.cn',source:'lark-chatgpt-topics',resolveChatMode:true,
    policy:{dmMode:'disabled',requireMention:false,respondToMentionAll:false},safety:{chatQueue:{enabled:false}},respectProxyEnv:true,httpTimeoutMs:30_000});
  const cards = new Map<string,string>();
  const send = async (chatId:string,text:string,replyTo:string,replyInThread:boolean) => (await channel.send(chatId,{markdown:text},{replyTo,replyInThread})).messageId;
  const router = new TopicRouter(config,registry,new TopicProvisioner(config,registry,topicResources(config,secret)),
    bound => new DesktopController(bound,new DesktopLedger(bound.stateFile,{appId:bound.appId,chatId:bound.chatId,ownerOpenId:bound.ownerOpenId,projectId:bound.projectId,projectRoot:bound.projectRoot,threadId:bound.threadId}),new DesktopBackend(bound),{
      send,
      approval:async(chatId,request,replyTo,replyInThread)=>{const result=await channel.send(chatId,{card:approvalCard(request)},{replyTo,replyInThread});if(!result.messageId)throw new Error('Approval card receipt missing');cards.set(request.token,result.messageId);},
      resolved:async token=>{const id=cards.get(token);if(!id)return;await channel.updateCard(id,resolvedCard());cards.delete(token);},
    }),{send},row=>archive.sync(row));
  let readyResolve!:()=>void,readyReject!:(error:unknown)=>void;
  const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});void ready.catch(()=>{});
  channel.on({
    message:async msg=>{try{await ready;}catch{return;}const inbound=desktopInbound(msg,channel.botIdentity?.openId);if(inbound)await router.receive(inbound).catch(e=>console.error('Topic intake failed:',String(e)));},
    cardAction:async evt=>{try{await ready;}catch{return;}const value=evt.action.value as {desktopApproval?:unknown;decision?:unknown};if(typeof value?.desktopApproval!=='string'||typeof value.decision!=='string')return;
      try{await router.decideFromCard(evt.chatId,evt.operator.openId,value.desktopApproval,value.decision);return{toast:{type:'info',content:'决定已提交，等待服务端确认。'}};}
      catch(e){return{toast:{type:'error',content:String(e)}};}},
    error:e=>console.error('Feishu channel error:',e.message),
  });
  let stopWatcher:ReturnType<typeof setInterval>|undefined,archiveWatcher:ReturnType<typeof setInterval>|undefined,shutdownPromise:Promise<void>|undefined;
  const shutdown=()=>shutdownPromise??=(async()=>{
    clearInterval(stopWatcher);clearInterval(archiveWatcher);
    try{await router.shutdown();}finally{try{await channel.disconnect();}finally{await rm(`${config.registryFile}.stop`,{force:true});await release();}}
  })();
  const onSignal=()=>{void shutdown().catch(e=>{console.error(String(e));process.exitCode=1;});};
  try{
    await rm(`${config.registryFile}.stop`,{force:true});
    await channel.connect();await router.start();readyResolve();
    process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
    stopWatcher=setInterval(()=>{void readFile(`${config.registryFile}.stop`,'utf8').then(shutdown).catch(e=>{if((e as NodeJS.ErrnoException).code!=='ENOENT'){console.error('Topic bridge shutdown failed:',String(e));process.exitCode=1;}});},1000);
    let syncing=false;
    archiveWatcher=setInterval(()=>{if(syncing)return;syncing=true;void (async()=>{
      for(const row of registry.all().filter(r=>r.stage==='active'))await archive.sync(row).catch(e=>console.error(`Topic archive ${row.chatId}:`,String(e)));
    })().finally(()=>{syncing=false;});},60_000);
    console.log(`Topic bridge ready for entry chat ${config.entryChatId}`);
  }catch(e){readyReject(e);await shutdown();throw e;}
}
void main().catch(e=>{console.error(String(e));process.exitCode=1;});
