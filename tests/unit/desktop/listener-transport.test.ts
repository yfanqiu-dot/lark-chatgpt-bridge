import {expect,it} from 'vitest';
import {ListenerTransport,LISTENER_RECONNECT_MS,LISTENER_STABLE_MS} from '../../../src/desktop/listener-transport';

function harness(){
  let clock=1000,state='connected',ticks=0;
  const transport=new ListenerTransport(()=>({state,reconnectAttempts:2}),()=>clock,async()=>{clock+=1000;ticks++;});
  return {transport,set:(s:string)=>{state=s;},advance:(ms:number)=>{clock+=ms;},ticks:()=>ticks};
}
it('retains one outage timestamp through flapping and requires stable connection',()=>{
  const h=harness();expect(h.transport.snapshot().phase).toBe('ready');h.set('disconnected');const since=h.transport.snapshot().disconnectedSince;
  h.advance(2000);h.set('connected');expect(h.transport.snapshot().phase).toBe('reconnecting');h.advance(4000);h.set('reconnecting');
  expect(h.transport.snapshot().disconnectedSince).toBe(since);h.set('connected');h.transport.snapshot();h.advance(LISTENER_STABLE_MS);
  expect(h.transport.snapshot()).toMatchObject({phase:'ready',state:'connected'});expect(h.transport.snapshot().disconnectedSince).toBeUndefined();
});
it('bounds an outage and latches failure even if connection returns late',async()=>{
  const h=harness();h.set('reconnecting');await expect(h.transport.waitReady()).rejects.toThrow();expect(h.ticks()).toBe(LISTENER_RECONNECT_MS/1000);
  h.set('connected');h.advance(10000);expect(h.transport.snapshot().phase).toBe('failed');await expect(h.transport.waitReady()).rejects.toThrow();
});
it.each(['failed','unexpected'])('rejects terminal or unknown state %s without waiting',async state=>{
  const h=harness();h.set(state);await expect(h.transport.waitReady()).rejects.toThrow();expect(h.ticks()).toBe(0);
});
it('cancels waiting before submission and respects shutdown',async()=>{
  const h=harness();h.set('reconnecting');await expect(h.transport.waitReady(()=>h.ticks()>=2)).rejects.toThrow('cancelled');
  h.set('connected');h.transport.close();await expect(h.transport.waitReady()).rejects.toThrow('cancelled');
});
it('hashes errors and bounds diagnostics without exposing raw fields',()=>{
  let clock=0,state='connected';const t=new ListenerTransport(()=>({state,reconnectAttempts:-1,nextConnectTime:NaN,secret:'PRIVATE'} as any),()=>clock);
  for(let n=0;n<80;n++){state=n%2?'connected':'reconnecting';clock++;t.snapshot();}t.recordError(Error('TEST_PRIVATE_ERROR'));
  const s=t.snapshot();expect(s.transitions).toHaveLength(32);expect(s.lastErrorSha256).toMatch(/^[a-f0-9]{64}$/);expect(s.reconnectAttempts).toBeUndefined();
  expect(JSON.stringify(s)).not.toContain('PRIVATE');
});
