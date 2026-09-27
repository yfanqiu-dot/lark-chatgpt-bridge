import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

let bundle:string,dir:string,server:WebSocketServer;
const children:ChildProcess[]=[];
beforeAll(async()=>{
  bundle=await mkdtemp(join(tmpdir(),'p3-recovery-bundle-'));
  await promisify(execFile)(process.execPath,['-e',"require('tsup').build({...JSON.parse(process.argv[1]),outExtension:()=>({js:'.cjs'})}).catch(e=>{console.error(e);process.exitCode=1})",
    JSON.stringify({entry:['tests/fixtures/desktop-recovery-child.ts'],outDir:bundle,format:['cjs'],
      platform:'node',target:'node22',bundle:true,noExternal:['graceful-fs'],silent:true,dts:false,config:false})],{windowsHide:true});
},20_000);
afterAll(async()=>{await rm(bundle,{recursive:true,force:true});});
beforeEach(async()=>{
  dir=await mkdtemp(join(tmpdir(),'p3-recovery-process-'));
  server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
  await writeFile(join(dir,'config.json'),JSON.stringify({appId:'app',appSecretEnv:'SECRET',chatId:'chat',ownerOpenId:'owner',projectId:'project',projectRoot:dir,threadId:'thread',
    endpoint:`ws://127.0.0.1:${(server.address() as {port:number}).port}/`,stateFile:join(dir,'ledger.json'),connectionFile:join(dir,'unused.json'),requireMention:true,maxQueue:10}),'utf8');
});
afterEach(async()=>{
  for(const child of children.splice(0))if(child.exitCode===null && child.signalCode===null){const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill('SIGKILL');await exited;}
  for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(dir,{recursive:true,force:true});
});

function run(mode:string) {
  const child=spawn(process.execPath,[join(bundle,'desktop-recovery-child.cjs'),join(dir,'config.json'),mode],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);
  let text='',errors='';let onRunning:()=>void=()=>{};
  const running=new Promise<void>(resolve=>{onRunning=resolve;});
  child.stdout!.on('data',chunk=>{text+=chunk.toString();if(text.includes('RUNNING\n'))onRunning();});child.stderr!.on('data',chunk=>{errors+=chunk.toString();});
  const exited=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
  return {child,running,exited,output:()=>text,errors:()=>errors};
}

it.each(['known','unknown'])('survives actual process termination with %s turn identity and never replays the original start',async identity=>{
  let starts=0,completed=false,notifyStart:()=>void=()=>{};
  const started=new Promise<void>(resolve=>{notifyStart=resolve;});
  server.on('connection',socket=>socket.on('message',data=>{
    const m=JSON.parse(data.toString());if(m.id===undefined)return;
    let result:any={};
    if(m.method==='project/list')result={data:[{id:'project',roots:[{path:dir}]}]};
    if(['thread/read','thread/resume'].includes(m.method))result={thread:{id:'thread',projectId:'project',cwd:dir,status:{type:starts&&!completed?'active':'idle'}}};
    if(m.method==='mcpServerStatus/list')result={data:[{name:'codex_app',runtimeStatus:'connected',tools:{list_projects:{name:'list_projects'}}}]};
    if(m.method==='turn/start'){starts++;notifyStart();if(identity==='unknown')return;result={turn:{id:'original-turn'}};}
    if(m.method==='thread/turns/list')result={data:[{id:'original-turn',status:completed?'completed':'inProgress',completedAt:completed?1:null}]};
    if(m.method==='thread/items/list')result={data:[{turnId:'original-turn',item:{type:'agentMessage',phase:'final_answer',text:'durable answer'}}]};
    socket.send(JSON.stringify({id:m.id,result}));
  }));
  const first=run('initial');await started;if(identity==='known')await first.running;
  first.child.kill('SIGKILL');await first.exited;
  const crashed=JSON.parse(await readFile(join(dir,'ledger.json'),'utf8')).messages[0];
  expect(crashed.state).toBe(identity==='known'?'running':'submitting');
  completed=true;
  const second=run('recover');expect(await second.exited,second.errors()).toBe(0);
  const recovered=JSON.parse(await readFile(join(dir,'ledger.json'),'utf8')).messages[0];
  expect(starts).toBe(1);
  if(identity==='known') {
    expect(recovered).toMatchObject({state:'completed',turnId:'original-turn',result:'durable answer',receipt:'receipt'});
    expect(second.output().match(/REPLY /g)).toHaveLength(1);
  } else {
    expect(recovered.state).toBe('uncertain');expect(recovered.turnId).toBeUndefined();expect(second.output()).not.toContain('REPLY ');
  }
},15_000);
