import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNewDesktopSetup } from '../../../src/desktop/setup';
import { prepareDeployment, verifyDeployment } from '../../../src/desktop/deployment';
import { DesktopLedger } from '../../../src/desktop/ledger';
let dir:string,root:string,input:Record<string,string>;
beforeEach(async()=>{
  dir=await realpath(await mkdtemp(join(tmpdir(),'desktop-setup-')));root=join(dir,'release');
  const version='26.1007.9446.0',app=join(dir,`OpenAI.Codex_${version}_x64__2p2nqsd0c76g0`,'app');
  for(const p of [app,join(root,'bin'),join(root,'dist')])await mkdir(p,{recursive:true});
  input={appId:'cli_test',chatId:'oc_group',ownerOpenId:'ou_owner',projectId:'native-project',projectRoot:dir,threadId:'native-thread',
    codexBinary:join(dir,'codex.exe'),desktopExe:join(app,'ChatGPT.exe'),desktopVersion:version};
  for(const p of [input.codexBinary!,input.desktopExe!,join(root,'bin/lark-channel-bridge.mjs'),join(root,'dist/desktop-runtime-supervisor.js')])await writeFile(p,'fixture','utf8');
});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
it('prepares a fresh single-group installation accepted by the deployment verifier and ledger reader',async()=>{
  const out=join(dir,'install');await prepareNewDesktopSetup(input,out,root,'a'.repeat(40),['list_projects','read_thread']);
  const spec=JSON.parse(await readFile(join(out,'deployment.json'),'utf8'));
  await prepareDeployment(spec,join(dir,'stage'));const deployed=await verifyDeployment(join(dir,'stage'));
  expect(deployed.topics.enabledChatIds).toEqual(['oc_group']);expect(deployed.topics.allowTopicCreation).toBe(false);
  expect(deployed.snapshot.spec.legacy.entryPoint).toBe(join(root,'bin/lark-channel-bridge.mjs'));
  const ledger=new DesktopLedger(join(out,'existing-ledger.json'),deployed.ledgers[0]!.binding);await ledger.load();expect(ledger.all()).toEqual([]);
});
it('preserves an existing installation byte for byte and never resets a pending message',async()=>{
  const out=join(dir,'install');await mkdir(out);const path=join(out,'existing-ledger.json');await writeFile(path,'pending-message-evidence','utf8');
  await expect(prepareNewDesktopSetup(input,out,root,'a'.repeat(40),['list_projects'])).rejects.toThrow();
  expect(await readFile(path,'utf8')).toBe('pending-message-evidence');
});
it.each(['appSecret','token','stateFile'])('rejects credentials and migration fields (%s) before creating files',async key=>{
  const out=join(dir,'install');await expect(prepareNewDesktopSetup({...input,[key]:'do-not-copy'},out,root,'a'.repeat(40),['list_projects'])).rejects.toThrow();
  await expect(stat(out)).rejects.toThrow();
});
it('rejects a desktop-version mismatch and an incomplete tool catalog before creating files',async()=>{
  const out=join(dir,'install');await expect(prepareNewDesktopSetup({...input,desktopVersion:'1.0'},out,root,'a'.repeat(40),['list_projects'])).rejects.toThrow();
  await expect(prepareNewDesktopSetup(input,out,root,'a'.repeat(40),['read_thread'])).rejects.toThrow();await expect(stat(out)).rejects.toThrow();
});
