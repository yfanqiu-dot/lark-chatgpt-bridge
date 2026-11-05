import {execFileSync} from 'node:child_process';
import {access,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.platform!=='win32'){console.log('Skipping the Windows package launcher on this platform.');process.exit(0);}
const output=resolve(process.argv[2]??join(root,'bin/desktop-package-launcher.exe'));
const compiler=join(process.env.SystemRoot??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');
await access(compiler);await mkdir(dirname(output),{recursive:true});
const source=join(root,'native/BridgePackageLauncher.cs');
execFileSync(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/debug-','/out:'+output,source],{windowsHide:true,encoding:'utf8',stdio:'pipe'});
const bytes=await readFile(output),pe=bytes.readUInt32LE(0x3c);
if(bytes.readUInt32LE(pe)!==0x00004550||bytes.readUInt16LE(pe+24+68)!==2)throw Error('Launcher must use the GUI subsystem');
const report={version:1,output,source,sourceSha256:createHash('sha256').update(await readFile(source)).digest('hex'),sha256:createHash('sha256').update(bytes).digest('hex'),subsystem:'Windows GUI',consoleAllocated:false};
if(process.argv[3])await writeFile(resolve(process.argv[3]),JSON.stringify(report,null,2)+'\n','utf8');
console.log(JSON.stringify(report));
