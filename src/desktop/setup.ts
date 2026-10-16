import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { validateHostConfig } from './host';
import { parseTopicConfig } from './topics';

/** New installations only. Never imports, replaces or resets an existing ledger. */
export async function prepareNewDesktopSetup(input: Record<string, unknown>, directory: string, root: string, revision: string, toolNames: string[]) {
  const keys = ['appId', 'chatId', 'ownerOpenId', 'projectId', 'projectRoot', 'threadId', 'codexBinary', 'desktopExe', 'desktopVersion'];
  if (Object.keys(input).some(k => !keys.includes(k)) || keys.some(k => typeof input[k] !== 'string' || !(input[k] as string).trim())) throw new Error('Setup requires exactly the documented fields; never include credentials');
  if (!isAbsolute(directory) || !isAbsolute(root) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Absolute paths and a full release revision are required');
  if (!toolNames.includes('list_projects') || toolNames.some(n => !/^[a-zA-Z0-9_]+$/.test(n)) || new Set(toolNames).size !== toolNames.length) throw new Error('A complete observed tool catalog is required');
  const i = input as Record<string, string>, dir = resolve(directory);
  const host = await validateHostConfig({codexBinary:i.codexBinary!, codexSha256:createHash('sha256').update(await readFile(i.codexBinary!)).digest('hex'),
    desktopExe:i.desktopExe!, desktopVersion:i.desktopVersion!, projectRoot:i.projectRoot!, endpoint:'ws://127.0.0.1:19431/', backendEndpoint:'ws://127.0.0.1:19432/',
    connectionFile:join(dir,'connection.json'), toolBindings:[{threadId:i.threadId!,projectId:i.projectId!}],
    topicRegistryFile:join(dir,'topics-registry.json'), topicProjects:[{projectId:i.projectId!,projectRoot:i.projectRoot!}]});
  const topics = parseTopicConfig({appId:i.appId, appSecretEnv:'LARK_APP_SECRET', ownerOpenId:i.ownerOpenId, entryChatId:i.chatId,
    endpoint:host.endpoint, connectionFile:host.connectionFile, registryFile:host.topicRegistryFile, stateDir:join(dir,'ledgers'), requireMention:true, maxQueue:20,
    projects:[{key:'main',projectId:i.projectId,projectRoot:host.projectRoot}],
    existing:{chatId:i.chatId,projectKey:'main',threadId:i.threadId,stateFile:join(dir,'existing-ledger.json')}, enabledChatIds:[i.chatId], allowTopicCreation:false});
  const artifactFiles:string[] = [];
  for (const folder of ['bin','dist']) for (const item of await readdir(join(root,folder),{withFileTypes:true})) {
    if (item.isFile() && /\.(?:mjs|ps1|js)$/.test(item.name)) artifactFiles.push(join(root,folder,item.name));
  }
  if (!artifactFiles.includes(join(root,'dist','desktop-runtime-supervisor.js'))) throw new Error('Build or extract the complete release before setup');
  // All validation precedes the exclusive directory creation. Existing state,
  // including a partially prepared installation, is never overwritten.
  await mkdir(dir,{mode:0o700});
  const binding={appId:topics.appId,chatId:i.chatId!,ownerOpenId:topics.ownerOpenId,projectId:i.projectId!,projectRoot:host.projectRoot,threadId:i.threadId!};
  const spec={hostConfigFile:join(dir,'host.json'),topicConfigFile:join(dir,'topics.json'),codeRevision:revision,artifactFiles,
    expectedToolNames:[...toolNames].sort(),legacy:{scheduledTaskName:'LarkChannelBridge.Bot.codex-desktop',executable:process.execPath,
      entryPoint:join(root,'bin','lark-channel-bridge.mjs'),profile:'codex-desktop',configFiles:[]}};
  for (const [name,value] of Object.entries({'host.json':host,'topics.json':topics,'topics-registry.json':{version:1,topics:[]},
    'existing-ledger.json':{version:1,binding,messages:[]},'deployment.json':spec})) {
    await writeFile(join(dir,name),JSON.stringify(value,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
  }
  return {prepared:true,directory:dir,revision,servicesStarted:false,startupInstalled:false,nativeBindingVerified:false};
}
