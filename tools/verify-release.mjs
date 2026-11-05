import {readFile,mkdir,readdir,lstat,writeFile} from 'node:fs/promises';
import {basename,join,resolve,dirname} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';

const pkg=JSON.parse(await readFile('package.json','utf8'));
const archive=resolve(process.argv[2]??`release-artifacts/qiu-bridge-v${pkg.version}-windows-x64.zip`);
const output=resolve(process.argv[3]??`release-artifacts/verify-${pkg.version}-${randomUUID()}`);
const entries=execFileSync('tar.exe',['-tf',archive],{windowsHide:true,encoding:'utf8'}).trim().split(/\r?\n/);
const folder=`qiu-bridge-v${pkg.version}-windows-x64`;
if(entries.some(path=>path.includes('\\')||path.includes(':')||path.split('/').includes('..')||!(path===folder||path.startsWith(folder+'/'))))throw Error('Archive contains an unexpected path');
await mkdir(output,{recursive:false});
execFileSync('tar.exe',['-xf',archive,'-C',output],{windowsHide:true,stdio:'pipe'});
const root=join(output,folder),release=JSON.parse(await readFile(join(root,'release.json'),'utf8'));
if(release.version!==pkg.version||release.platform!=='windows-x64'||!/^[a-f0-9]{40}$/.test(release.revision)||release.runtimeRevision!==release.revision)throw Error('Release metadata mismatch');
const manifest=(await readFile(join(root,'FILES.sha256'),'utf8')).trim().split(/\r?\n/).map(line=>{const match=/^([a-f0-9]{64})  (.+)$/.exec(line);if(!match)throw Error('Invalid package manifest');return {sha256:match[1],path:match[2]};});
if(new Set(manifest.map(row=>row.path)).size!==manifest.length)throw Error('Duplicate manifest path');
for(const row of manifest){
 if(row.path.includes('\\')||row.path.includes(':')||row.path.split('/').includes('..')||row.path.startsWith('/'))throw Error('Invalid manifest path');
 if(createHash('sha256').update(await readFile(join(root,row.path))).digest('hex')!==row.sha256)throw Error('Package digest mismatch: '+row.path);
}
const files=[];async function walk(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name),info=await lstat(path);if(info.isSymbolicLink())throw Error('Symlink in release');if(entry.isDirectory())await walk(path);else files.push(path.slice(root.length+1).replaceAll('\\','/'));}}
await walk(root);
if(files.length!==manifest.length+1||files.some(path=>path!=='FILES.sha256'&&!manifest.some(row=>row.path===path)))throw Error('Unmanifested release file');
if(files.some(path=>/(^|\/)(?:\.git|\.p[1-4]-local|\.feishu-bridge|\.lark-chatgpt-bridge|\.env(?:\.[^/]*)?|connection\.json|topics-registry\.json|[^/]*ledger[^/]*\.json|[^/]*capability[^/]*\.dpapi)(?:\/|$)/i.test(path)))throw Error('Private state filename in release');
const version=execFileSync(process.execPath,[join(root,'bin/lark-channel-bridge.mjs'),'--version'],{cwd:root,windowsHide:true,encoding:'utf8',timeout:30000}).trim();
if(version!==pkg.version)throw Error('Packaged CLI version mismatch');
execFileSync(process.execPath,[join(root,'bin/lark-chatgpt-setup.mjs'),'--help'],{cwd:root,windowsHide:true,stdio:'pipe',timeout:30000});
const launcher=await readFile(join(root,'bin/desktop-package-launcher.exe')),pe=launcher.readUInt32LE(0x3c);
if(launcher.readUInt32LE(pe)!==0x4550||launcher.readUInt16LE(pe+24+68)!==2)throw Error('Package launcher is not a Windows GUI executable');
for(const name of ['overview','topics','installation']){
 const png=await readFile(join(root,'docs/images',name+'.png'));
 if(png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('Missing or invalid documentation image');
 await readFile(join(root,'docs/images',name+'.svg'));
}
for(const path of files.filter(path=>path.endsWith('.md'))){
 const text=await readFile(join(root,path),'utf8');
 for(const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)){
  const link=match[1];if(/^(?:https?:|#|mailto:)/.test(link))continue;
  await lstat(resolve(dirname(join(root,path)),decodeURIComponent(link.split('#')[0])));
 }
}
const result={verified:true,version:pkg.version,revision:release.revision,archive:basename(archive),sha256:createHash('sha256').update(await readFile(archive)).digest('hex'),files:files.length,manifestVerified:true,cliSmokePassed:true,guiSubsystemVerified:true,illustrationsVerified:true,offlineLinksVerified:true,privateStateFilenamesAbsent:true};
await writeFile(join(output,'verification.json'),JSON.stringify(result,null,2)+'\n','utf8');
console.log(JSON.stringify(result));
