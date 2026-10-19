import {afterEach,beforeEach,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,copyFile,writeFile,readFile,readdir,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
let root:string,entry:string,service:string,source:string,manifestFile:string,proof:string,marker:string;
beforeEach(async()=>{
  // Windows runners expose RUNNER~1 in TEMP. Match the canonical package
  // paths returned by PowerShell rather than sealing a short-path alias.
  root=await realpath(await mkdtemp(join(tmpdir(),'bridge-service-entry-')));entry=join(root,'bin/desktop-service-start.ps1');service=join(root,'service');source=join(root,'source');marker=join(root,'native-called');
  for(const directory of ['bin','service','source','temp'])await mkdir(join(root,directory));
  await copyFile(resolve('bin/desktop-service-start.ps1'),entry);
  await writeFile(join(root,'bin/lark-chatgpt-runtime-supervisor.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'called');if(process.env.BRIDGE_TEST_FAILURE){console.error('QIU_BRIDGE_FAILURE '+JSON.stringify({version:1,code:'service_previous_run_unresolved',errorSha256:'a'.repeat(64)}));console.error('PRIVATE_TEST_SENTINEL');process.exitCode=1;}`,'utf8');
  const pinned=join(root,'pinned.txt');await writeFile(pinned,'original','utf8');
  const sourceBytes=JSON.stringify({files:await Promise.all([entry,process.execPath,pinned].map(async path=>({path,sha256:sha(await readFile(path))})))});
  await writeFile(join(source,'manifest.json'),sourceBytes,'utf8');
  const bytes=JSON.stringify({version:1,root,directory:service,sourceStage:source,nodeExecutable:process.execPath,sourceSha256:sha(sourceBytes),channelMode:'new-only',serviceMode:'stop-with-desktop'});
  manifestFile=join(service,'service.json');proof=sha(bytes);await writeFile(manifestFile,bytes,'utf8');
});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
function run(failure=false){
  const env={...process.env,PSModulePath:join(root,'nonexistent-pwsh-modules'),TEMP:join(root,'temp'),TMP:join(root,'temp'),...(failure?{BRIDGE_TEST_FAILURE:'1'}:{})};
  try{return {code:0,stdout:execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',entry,'-ManifestFile',manifestFile,'-ManifestSha256',proof,'-NoNotify'],{env,windowsHide:true,encoding:'utf8',timeout:30000}),stderr:''};}
  catch(error:any){return {code:error.status,stdout:String(error.stdout),stderr:String(error.stderr)};}
}
async function diagnostics(){const files=await readdir(join(service,'startup'));return (await Promise.all(files.map(file=>readFile(join(service,'startup',file),'utf8')))).join('\n');}
async function failureContext(){
  const records=[];for(const directory of [join(service,'startup'),join(root,'temp/QIUBridgeStartup')]){
    let files:string[];try{files=await readdir(directory);}catch{continue;}
    for(const file of files)for(const line of (await readFile(join(directory,file),'utf8')).trim().split(/\r?\n/))records.push(JSON.parse(line));
  }return JSON.stringify(records);
}
it.skipIf(process.platform!=='win32')('starts with a foreign module path and records requested, without claiming running',async()=>{
  expect(run().code,await failureContext()).toBe(0);expect(await readFile(marker,'utf8')).toBe('called');
  const records=(await diagnostics()).trim().split(/\r?\n/).map(line=>JSON.parse(line));expect(records.at(-1)).toMatchObject({phase:'requested',code:'runtime_requested'});expect(records.some(row=>row.phase==='running')).toBe(false);
});
it.skipIf(process.platform!=='win32')('reports a refused previous run without leaking native stderr or changing the manifest',async()=>{
  const bytes=await readFile(manifestFile),result=run(true);expect(result.code,await failureContext()).toBe(1);expect(result.stderr,await failureContext()).toContain('service_previous_run_unresolved');
  const evidence=await diagnostics();expect(evidence).toContain('"phase":"failed"');expect(evidence).toContain('service_previous_run_unresolved');expect(evidence+result.stderr).not.toContain('PRIVATE_TEST_SENTINEL');expect(await readFile(manifestFile)).toEqual(bytes);
});
it.skipIf(process.platform!=='win32')('blocks changed programs before native execution and records the integrity stage',async()=>{
  await writeFile(join(root,'pinned.txt'),'changed','utf8');expect(run().code).toBe(1);await expect(readFile(marker)).rejects.toThrow();
  const evidence=await diagnostics();expect(evidence).toContain('program_integrity');expect(evidence).toContain('"phase":"failed"');
});
