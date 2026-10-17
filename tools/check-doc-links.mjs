import {readFile,access,readdir} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
async function markdownFiles(dir){
  const entries=await readdir(dir,{withFileTypes:true});
  return (await Promise.all(entries.map(e=>e.isDirectory()?markdownFiles(`${dir}/${e.name}`):e.isFile()&&e.name.endsWith('.md')?[`${dir}/${e.name}`]:[]))).flat();
}
const files=['README.md','README.zh.md','README.desktop.md','README.topics.md','SECURITY.md',...await markdownFiles('docs')];
const broken=[];
for(const file of files){
  const text=await readFile(file,'utf8');
  for(const match of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)){
    const link=match[1];if(/^(?:https?:|#|mailto:)/.test(link))continue;
    try{await access(resolve(dirname(file),decodeURIComponent(link.split('#')[0])));}catch{broken.push({file,link});}
  }
}
console.log(JSON.stringify({files:files.length,broken},null,2));if(broken.length)process.exitCode=1;
