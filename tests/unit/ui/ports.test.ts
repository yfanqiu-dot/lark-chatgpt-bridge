import { EventEmitter } from 'node:events';
import type { Server } from 'node:http';
import { expect, it } from 'vitest';
import { browserHttpPort, listenBrowserPort } from '../../../src/ui/ports';
function fake(ports:number[],error?:Error){
  const emitter=new EventEmitter();let listens=0,closes=0,port=0;
  const server=Object.assign(emitter,{listen(_requested:number,_host:string,done:()=>void){port=ports[Math.min(listens++,ports.length-1)]!;queueMicrotask(()=>error?emitter.emit('error',error):done());},address(){return {port};},close(done:()=>void){closes++;done();}});
  return {server:server as unknown as Server,get listens(){return listens;},get closes(){return closes;}};
}
it('releases browser-blocked ephemeral listeners before accepting a usable port',async()=>{
  const h=fake([6000,6667,49152]);expect(await listenBrowserPort(h.server,'127.0.0.1')).toBe(49152);expect(h.listens).toBe(3);expect(h.closes).toBe(2);
});
it('fails bounded allocation without leaving a blocked listener open',async()=>{
  const h=fake([10080]);await expect(listenBrowserPort(h.server,'127.0.0.1')).rejects.toThrow('No browser-compatible');expect(h.listens).toBe(8);expect(h.closes).toBe(8);
});
it('rejects explicit blocked or invalid ports before binding and retains valid explicit ports',async()=>{
  for(const port of [6000,6667,-1,65536,1.5]){const h=fake([port]);await expect(listenBrowserPort(h.server,'127.0.0.1',port)).rejects.toThrow();expect(h.listens).toBe(0);}
  const h=fake([8080]);expect(await listenBrowserPort(h.server,'127.0.0.1',8080)).toBe(8080);expect(browserHttpPort(8080)).toBe(true);
});
it('propagates bind failures without retrying or changing the requested port',async()=>{
  const h=fake([8080],new Error('EADDRINUSE'));await expect(listenBrowserPort(h.server,'127.0.0.1',8080)).rejects.toThrow('EADDRINUSE');expect(h.listens).toBe(1);expect(h.closes).toBe(0);
});
