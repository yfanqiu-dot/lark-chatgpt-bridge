import {readFile,access} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
const files=['README.md','README.zh.md','README.desktop.md','docs/desktop-p4-deployment.md','docs/compatibility.md','docs/releases/v0.8.0.md','docs/cli-backend.en.md','docs/cli-backend.zh.md'];
const broken=[];
for(const file of files){
  const text=await readFile(file,'utf8');
  for(const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)){
    const link=match[1];if(/^(?:https?:|#|mailto:)/.test(link))continue;
    try{await access(resolve(dirname(file),decodeURIComponent(link.split('#')[0])));}catch{broken.push({file,link});}
  }
}
console.log(JSON.stringify({files:files.length,broken},null,2));if(broken.length)process.exitCode=1;
