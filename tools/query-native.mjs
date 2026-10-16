#!/usr/bin/env node
import {WebSocket} from 'ws';
const [endpoint,method,raw='{}',...extra]=process.argv.slice(2);
const allowed=new Set(['project/list','thread/list','thread/read']);
try{
  const url=new URL(endpoint);
  if(extra.length||url.protocol!=='ws:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.pathname!=='/'||url.search||url.hash||!allowed.has(method))throw Error();
  const params=JSON.parse(raw);if(!params||typeof params!=='object'||Array.isArray(params))throw Error();
  const socket=new WebSocket(url),pending=new Map();let id=0;
  const timer=setTimeout(()=>{socket.terminate();console.error('Native query timed out; no mutating method was sent.');process.exitCode=1;},15000);
  const call=(name,args)=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method:name,params:args}));});
  socket.on('message',data=>{try{const value=JSON.parse(String(data)),p=pending.get(value.id);if(p){pending.delete(value.id);value.error?p.reject(Error()):p.resolve(value.result);}}catch{socket.terminate();}});
  socket.on('error',()=>{for(const p of pending.values())p.reject(Error());});
  socket.once('open',async()=>{
    try{await call('initialize',{clientInfo:{name:'qiu_bridge_readonly',version:'0.8.0'},capabilities:{experimentalApi:true}});
      socket.send(JSON.stringify({method:'initialized'}));console.log(JSON.stringify(await call(method,params),null,2));
    }catch{console.error('Read-only native query failed. Check the pinned version and documented parameters.');process.exitCode=1;}
    finally{clearTimeout(timer);socket.close();}
  });
}catch{console.error('Usage: node tools/query-native.mjs ws://127.0.0.1:PORT project/list|thread/list|thread/read JSON_PARAMS');process.exitCode=1;}
