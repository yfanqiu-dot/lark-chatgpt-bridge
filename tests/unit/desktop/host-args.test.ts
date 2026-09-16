import {describe,expect,it} from 'vitest';
import {appServerArgs} from '../../../src/desktop/host';

describe('App Server listener arguments',()=>{
  it('accepts either client URL spelling but passes the socket address required by the CLI',()=>{
    for(const endpoint of ['ws://127.0.0.1:19432','ws://127.0.0.1:19432/']) {
      const args=appServerArgs(endpoint);
      expect(args[args.indexOf('--listen')+1]).toBe('ws://127.0.0.1:19432');
    }
  });
  it('preserves bracketed IPv6 without a trailing path separator',()=>{
    const args=appServerArgs('ws://[::1]:19432/');
    expect(args[args.indexOf('--listen')+1]).toBe('ws://[::1]:19432');
  });
  it('does not strip forbidden paths or credentials to make an invalid endpoint acceptable',()=>{
    for(const endpoint of ['ws://127.0.0.1:19432/private','ws://secret@127.0.0.1:19432','ws://0.0.0.0:19432'])expect(()=>appServerArgs(endpoint)).toThrow();
  });
});
