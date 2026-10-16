import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { desktopPipes, desktopToolCatalog } from './windows-tools';
import { prepareNewDesktopSetup } from './setup';

async function main() {
  const [mode,a,b,c,...extra]=process.argv.slice(2),root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  if(mode==='--help'||!mode){console.log('QIU Bridge setup\n  probe <desktopPid> <desktopExe> <new-catalog.json>\n  init <setup.json> <catalog.json> <new-directory>\nPreparation only; no process starts, no credentials, no existing-state migration.');return;}
  if(!a||!b||!c||extra.length)throw new Error('Invalid arguments; see --help');
  if(mode==='probe'){
    if(process.platform!=='win32'||!/^\d+$/.test(a))throw new Error('Probe requires a Windows desktop PID');
    const exe=resolve(b),version=/[\\/]OpenAI\.Codex_([0-9.]+)_x64__2p2nqsd0c76g0[\\/]app[\\/]ChatGPT\.exe$/i.exec(exe)?.[1];
    if(!version)throw new Error('Use the installed packaged Codex desktop executable');
    const matches=[];
    for(const pipe of await desktopPipes(Number(a),exe)){
      try{const names=await desktopToolCatalog(join(dirname(exe),'resources/plugins/openai-bundled/plugins/codex-app-tools'),pipe.pipe);if(names.includes('list_projects'))matches.push(names);}catch{ /* No success is inferred from a failed pipe. */ }
    }
    if(matches.length!==1)throw new Error('Expected exactly one complete desktop tool catalog');
    await writeFile(resolve(c),JSON.stringify({version:1,observedAt:new Date().toISOString(),desktopExe:exe,desktopVersion:version,expectedToolNames:matches[0]},null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
    console.log(JSON.stringify({catalogSaved:true,toolCount:matches[0]!.length,servicesStarted:false}));return;
  }
  if(mode!=='init')throw new Error('Unknown mode');
  const input=JSON.parse(await readFile(resolve(a),'utf8')),catalog=JSON.parse(await readFile(resolve(b),'utf8'));
  if(catalog.version!==1||resolve(input.desktopExe)!==catalog.desktopExe||input.desktopVersion!==catalog.desktopVersion||!Array.isArray(catalog.expectedToolNames))throw new Error('Setup must match the observed desktop catalog');
  let revision:string;
  try{revision=JSON.parse(await readFile(join(root,'release.json'),'utf8')).revision;}
  catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;revision=execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,'rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim();}
  console.log(JSON.stringify(await prepareNewDesktopSetup(input,resolve(c),root,revision,catalog.expectedToolNames)));
}
void main().catch(()=>{console.error('Setup failed. Check documented fields, installed version and new output paths. Existing state is preserved; no service was started.');process.exitCode=1;});
