import {spawnSync} from 'node:child_process';
import {openSync,closeSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
const output=resolve(process.argv[2]??'release-artifacts/checks');mkdirSync(output,{recursive:true});
const phases=[['web',['node_modules/vite/bin/vite.js','build','web']],
  ['tests',['node_modules/vitest/vitest.mjs','run','--reporter=json',`--outputFile=${join(output,'tests.json')}`]],
  ['types',['node_modules/typescript/bin/tsc','--noEmit']],['build',['node_modules/tsup/dist/cli-default.js']]];
const results=[];
for(const [phase,args] of phases){
  const fd=openSync(join(output,`${phase}.log`),'w');
  const result=spawnSync(process.execPath,args,{stdio:['ignore',fd,fd],windowsHide:true,timeout:300000,env:{...process.env,CI:'true'}});closeSync(fd);
  results.push({phase,code:result.status,error:result.error?.code});
  if(result.status!==0){
    if(phase==='tests'){try{const report=JSON.parse(readFileSync(join(output,'tests.json'),'utf8'));console.log(JSON.stringify({tests:report.numTotalTests,failed:report.testResults.flatMap(s=>s.assertionResults.filter(t=>t.status==='failed').map(t=>({name:t.fullName,errors:t.failureMessages})))},null,2));}catch{}}
    console.log(JSON.stringify(results));writeFileSync(join(output,'summary.json'),JSON.stringify(results,null,2),'utf8');process.exit(1);
  }
}
writeFileSync(join(output,'summary.json'),JSON.stringify(results,null,2),'utf8');
const report=JSON.parse(readFileSync(join(output,'tests.json'),'utf8'));console.log(JSON.stringify({phases:results,tests:report.numTotalTests,passed:report.numPassedTests,failed:report.numFailedTests}));
