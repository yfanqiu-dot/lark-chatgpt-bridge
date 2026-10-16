import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { DesktopReadiness } from '../../../src/desktop/readiness';
import { cleanDesktopEnvironment } from '../../../src/desktop/windows-tools';
import { unexpectedChildExit, validateHostConfig, type HostConfig } from '../../../src/desktop/host';

let dir:string;
beforeEach(async()=>{dir=await mkdtemp(join(tmpdir(),'desktop-host-'));});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});

it('reports which owned child ended during a shared session',()=>{
  expect(unexpectedChildExit('Owned desktop',{exitCode:0,signalCode:null}).message)
    .toContain('Owned desktop exited during shared desktop session (code 0, signal null)');
  expect(unexpectedChildExit('Owned App Server',{exitCode:null,signalCode:'SIGTERM'},new Error('spawn failed')).message)
    .toContain('Owned App Server exited during shared desktop session (code null, signal SIGTERM): spawn failed');
});

it('removes inherited task identity and stale pipe environment before desktop launch',()=>{
  expect(cleanDesktopEnvironment({PATH:'keep',CODEX_HOME:'keep',CODEX_THREAD_ID:'old',CODEX_APP_TOOLS_PIPE_PATH:'old',CODEX_APP_SERVER_WS_URL:'old',NODE_REPL_THREAD:'old'}))
    .toEqual({PATH:'keep',CODEX_HOME:'keep'});
});

it('pins binary hash and desktop version instead of trusting the CLI version string',async()=>{
  const cfg:HostConfig={codexBinary:join(dir,'codex.exe'),codexSha256:createHash('sha256').update('binary').digest('hex'),desktopExe:join(dir,'OpenAI.Codex_26.908.9136.0_x64__2p2nqsd0c76g0','app','ChatGPT.exe'),desktopVersion:'26.908.9136.0',projectRoot:dir,endpoint:'ws://127.0.0.1:19431',backendEndpoint:'ws://127.0.0.1:19432',connectionFile:join(dir,'lease.json')};
  await mkdir(dirname(cfg.desktopExe),{recursive:true});await writeFile(cfg.codexBinary,'binary','utf8');await writeFile(cfg.desktopExe,'desktop','utf8');
  expect((await validateHostConfig(cfg)).endpoint).toBe('ws://127.0.0.1:19431/');
  await expect(validateHostConfig({...cfg,toolBindings:[{threadId:'t',projectId:null}]})).resolves.toMatchObject({toolBindings:[{threadId:'t',projectId:null}]});
  await expect(validateHostConfig({...cfg,toolBindings:[{threadId:'t'} as any]})).rejects.toThrow('bindings');
  await expect(validateHostConfig({...cfg,toolBindings:[{threadId:'t',projectId:'p'},{threadId:'t',projectId:'p'}]})).rejects.toThrow('bindings');
  await expect(validateHostConfig({...cfg,desktopVersion:'old'})).rejects.toThrow('version');
  await expect(validateHostConfig({...cfg,backendEndpoint:cfg.endpoint})).rejects.toThrow('differ');
  await writeFile(cfg.codexBinary,'upgraded','utf8');
  await expect(validateHostConfig(cfg)).rejects.toThrow('hash');
});

function initialize(r:DesktopReadiness,c:object){
  r.request(c,{id:1,method:'initialize',params:{clientInfo:{name:'Codex Desktop'}}});
  r.response(c,{id:1,result:{}});
  r.request(c,{id:2,method:'project/list'});r.response(c,{id:2,result:{data:[]}});
  r.request(c,{id:3,method:'config/batchWrite'});r.response(c,{id:3,result:{}});
}

it('reports the exact configuration withdrawal before a later quiet-window poll without request bodies',()=>{
  let now=0;const observations:unknown[]=[];const r=new DesktopReadiness(snapshot=>observations.push(snapshot),()=>now),c={};
  initialize(r,c);now=15_000;expect(r.canLease()).toBe(true);
  r.request(c,{id:9,method:'config/batchWrite',params:{private:'SECRET_REQUEST_BODY'}});
  expect(observations.at(-1)).toMatchObject({lastChange:'request config/batchWrite',configurationObserved:false,pendingConfiguration:[],revision:r.revision});
  expect(r.canLease()).toBe(false);expect(JSON.stringify(observations)).not.toContain('SECRET');
  r.response(c,{id:9,result:{private:'SECRET_RESPONSE_BODY'}});
  expect(observations.at(-1)).toMatchObject({lastChange:'response config/batchWrite',configurationObserved:false});
  now+=14_999;expect(r.canLease()).toBe(false);now++;expect(r.canLease()).toBe(true);expect(JSON.stringify(observations)).not.toContain('SECRET');
});

it('records a desktop socket withdrawal while unrelated bridge traffic cannot supply a replacement proof',()=>{
  let now=0;const observations:unknown[]=[];const r=new DesktopReadiness(snapshot=>observations.push(snapshot),()=>now),desktop={},bridge={};
  initialize(r,desktop);now=15_000;expect(r.canLease()).toBe(true);r.close(desktop);
  expect(observations.at(-1)).toMatchObject({lastChange:'desktop connection closed',desktopConnected:false});
  const count=observations.length;r.request(bridge,{id:11,method:'config/read'});r.response(bridge,{id:11,result:{}});now+=60_000;
  expect(observations).toHaveLength(count);expect(r.canLease()).toBe(false);
});

it('requires actual desktop initialization, successful configuration and a quiet window',()=>{
  let now=0,invalidations=0;const r=new DesktopReadiness(()=>invalidations++,()=>now);const c={};
  r.request(c,{id:1,method:'initialize',params:{clientInfo:{name:'lark_chatgpt_bridge'}}});r.response(c,{id:1,result:{}});
  now=60_000;expect(r.canLease()).toBe(false);
  initialize(r,c);now+=14_999;expect(r.canLease()).toBe(false);now++;expect(r.canLease()).toBe(true);
  const revision=r.revision;
  r.request(c,{id:4,method:'config/batchWrite'});now+=20_000;
  r.response(c,{id:4,error:{code:1,message:'failed'}});expect(r.canLease()).toBe(false);expect(r.canLease(revision)).toBe(false);
  r.request(c,{id:5,method:'config/batchWrite'});r.response(c,{id:5,result:{}});now+=15_000;expect(r.canLease()).toBe(true);
  r.close(c);expect(r.canLease()).toBe(false);expect(invalidations).toBeGreaterThan(3);
});

it('ignores stale socket replies and does not invalidate a replacement when the old socket closes',()=>{
  let now=0;const r=new DesktopReadiness(()=>{},()=>now);const old={},current={};
  initialize(r,old);initialize(r,current);
  r.request(old,{id:9,method:'config/batchWrite'});r.close(old);now=15_000;
  expect(r.canLease()).toBe(true);
  r.request(current,{id:10,method:'config/batchWrite'});r.response(old,{id:10,result:{}});now+=15_000;
  expect(r.canLease()).toBe(false);
});

it('accepts a warm desktop that reads existing configuration without writing it',()=>{
  let now=0;const r=new DesktopReadiness(()=>{},()=>now),c={};
  r.request(c,{id:1,method:'initialize',params:{clientInfo:{name:'Codex Desktop'}}});r.response(c,{id:1,result:{}});
  r.request(c,{id:2,method:'project/list'});r.response(c,{id:2,result:{data:[]}});
  r.request(c,{id:3,method:'config/read'});r.response(c,{id:3,result:{config:{}}});
  now=15_000;expect(r.canLease()).toBe(true);
});

it('requires fresh configuration after failed plugin install instead of remaining stuck forever',()=>{
  let now=0;const r=new DesktopReadiness(()=>{},()=>now),c={};initialize(r,c);now=15_000;
  expect(r.canLease()).toBe(true);
  r.request(c,{id:4,method:'config/read'});
  r.request(c,{id:5,method:'plugin/install'});now+=20_000;
  r.response(c,{id:5,error:{code:-32600,message:'plugin missing'}});
  r.response(c,{id:4,result:{config:{}}});expect(r.canLease()).toBe(false);
  r.request(c,{id:6,method:'config/read'});r.response(c,{id:6,result:{config:{}}});
  now+=14_999;expect(r.canLease()).toBe(false);now++;expect(r.canLease()).toBe(true);
  expect(r.snapshot().configurationFailures).toBe(1);
});

it('does not lease while another configuration mutation is still in flight',()=>{
  let now=0;const r=new DesktopReadiness(()=>{},()=>now),c={};initialize(r,c);
  r.request(c,{id:4,method:'config/batchWrite'});r.request(c,{id:5,method:'plugin/install'});
  r.response(c,{id:4,result:{}});r.request(c,{id:6,method:'config/read'});r.response(c,{id:6,result:{}});
  now=60_000;expect(r.canLease()).toBe(false);expect(r.snapshot().pendingConfiguration).toEqual(['plugin/install']);
  r.response(c,{id:5,result:{}});expect(r.canLease()).toBe(false);
  r.request(c,{id:7,method:'config/read'});r.response(c,{id:7,result:{}});now+=15_000;expect(r.canLease()).toBe(true);
});

it('renews readiness after successful background feature enablement without requiring an unrelated desktop read',()=>{
  let now=0;const r=new DesktopReadiness(()=>{},()=>now),c={};initialize(r,c);now=15_000;
  expect(r.canLease()).toBe(true);
  r.request(c,{id:4,method:'experimentalFeature/enablement/set'});
  expect(r.canLease()).toBe(false);
  r.response(c,{id:4,result:{}});
  now+=14_999;expect(r.canLease()).toBe(false);
  now++;expect(r.canLease()).toBe(true);
  r.request(c,{id:5,method:'experimentalFeature/enablement/set'});
  r.response(c,{id:5,error:{code:1,message:'update failed'}});
  now+=60_000;expect(r.canLease()).toBe(false);
});
