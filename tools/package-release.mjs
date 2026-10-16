import {cp,mkdir,readFile,readdir,writeFile,realpath,stat} from 'node:fs/promises';
import {join,resolve,dirname,basename} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
const root=process.cwd(),pkg=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(process.platform!=='win32'||process.arch!=='x64')throw Error('The supported release bundle is Windows x64');
const git=args=>execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,...args],{cwd:root,encoding:'utf8'}).trim();
const revision=git(['rev-parse','HEAD']);
if(git(['status','--porcelain','--untracked-files=no']))throw Error('Commit the release source before packaging');
const output=resolve('release-artifacts'),build=join(output,`build-${revision.slice(0,12)}`),bundle=join(build,`qiu-bridge-v${pkg.version}-windows-x64`);
await mkdir(output,{recursive:true});await mkdir(build);await mkdir(bundle);
const files=['bin','dist','examples/desktop','tools/query-native.mjs','README.md','README.zh.md','README.desktop.md','LICENSE','SECURITY.md',
  'docs/desktop-p4-deployment.md','docs/compatibility.md','docs/cli-backend.en.md','docs/cli-backend.zh.md',`docs/releases/v${pkg.version}.md`];
for(const file of files){await mkdir(dirname(join(bundle,file)),{recursive:true});await cp(join(root,file),join(bundle,file),{recursive:true});}
const runtimePkg={...pkg};delete runtimePkg.scripts;delete runtimePkg.devDependencies;delete runtimePkg.pnpm;delete runtimePkg.packageManager;
await writeFile(join(bundle,'package.json'),JSON.stringify(runtimePkg,null,2)+'\n','utf8');
await writeFile(join(bundle,'release.json'),JSON.stringify({name:'QIU Bridge',version:pkg.version,revision,platform:'windows-x64',node:'22 LTS',runtimeBaseline:'63d3ba7d0fd83353327e678be76c7b17da10831a'},null,2)+'\n','utf8');
// Copy only the installed production graph, dereferencing pnpm links. No
// registry re-resolution, dev dependencies, shell shims or global packages.
async function packageRoot(name,from){
  for(const base of createRequire(join(from,'package.json')).resolve.paths(name)??[]){
    const path=join(base,name);try{const actual=await realpath(path),p=JSON.parse(await readFile(join(actual,'package.json'),'utf8'));if(p.name===name)return {path:actual,pkg:p};}catch{}}
  throw Error(`Missing locked production dependency: ${name}`);
}
let packages=0;const installed=new Map(),rootVersions=new Map();
for(const name of Object.keys(pkg.dependencies)){const source=await packageRoot(name,root);rootVersions.set(name,`${name}@${source.pkg.version}`);}
async function dependency(name,from,consumer,ancestors){
  const source=await packageRoot(name,from),key=`${name}@${source.pkg.version}`;
  if(ancestors.get(name)===key||installed.get(name)===key)return;
  // Hoist shared versions to avoid Windows MAX_PATH failures. Conflicting
  // versions remain nested under the consumer that requests them.
  const hoist=!installed.has(name)&&(!rootVersions.has(name)||rootVersions.get(name)===key);
  const target=hoist?join(bundle,'node_modules',name):join(consumer,'node_modules',name);
  if(hoist)installed.set(name,key);
  await mkdir(dirname(target),{recursive:true});
  await cp(source.path,target,{recursive:true,dereference:true,filter:path=>basename(path)!=='node_modules'});packages++;
  const next=new Map(ancestors);next.set(name,key);
  const deps={...source.pkg.dependencies,...source.pkg.optionalDependencies};
  for(const child of Object.keys(deps)){
    try{await dependency(child,source.path,target,next);}
    catch(e){if(!Object.hasOwn(source.pkg.optionalDependencies??{},child))throw e;}
  }
}
for(const name of Object.keys(pkg.dependencies))await dependency(name,root,bundle,new Map());
execFileSync(process.execPath,[join(bundle,'bin/lark-chatgpt-setup.mjs'),'--help'],{cwd:bundle,stdio:'pipe',windowsHide:true});
execFileSync(process.execPath,[join(bundle,'bin/lark-channel-bridge.mjs'),'--version'],{cwd:bundle,stdio:'pipe',windowsHide:true});
const manifest=[];
async function inventory(dir){for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())await inventory(path);else{if(!item.isFile()||(await stat(path)).isSymbolicLink())throw Error('Unexpected release file');manifest.push({path:path.slice(bundle.length+1).replaceAll('\\','/'),sha256:createHash('sha256').update(await readFile(path)).digest('hex')});}}}
await inventory(bundle);
await writeFile(join(bundle,'FILES.sha256'),manifest.map(f=>`${f.sha256}  ${f.path}`).join('\n')+'\n','utf8');
const archive=join(output,`${basename(bundle)}.zip`);
try{await stat(archive);throw Error('Archive already exists; preserve it before rebuilding');}catch(e){if(e.code!=='ENOENT')throw e;}
execFileSync('tar.exe',['-a','-cf',archive,'-C',build,basename(bundle)],{windowsHide:true,stdio:'pipe'});
const sha=createHash('sha256').update(await readFile(archive)).digest('hex');
await writeFile(join(output,'SHA256SUMS.txt'),`${sha}  ${basename(archive)}\n`,'utf8');
console.log(JSON.stringify({archive,sha256:sha,revision,productionPackages:packages,files:manifest.length,privateStateIncluded:false}));
