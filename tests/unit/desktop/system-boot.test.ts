import {expect,it} from 'vitest';
import {freshSystemBoot,laterSystemBoot,sameSystemBoot,validSystemBoot} from '../../../src/desktop/system-boot';
it('requires a fresh native observation on the same machine after the prior observation, not a sleep/resume',()=>{
  const now=Date.now(),p={version:1 as const,machineSha256:'a'.repeat(64),bootedAt:new Date(now-3600_000).toISOString(),observedAt:now-120_000};
  const current={...p,bootedAt:new Date(now-60_000).toISOString(),observedAt:now};
  expect(laterSystemBoot(p,current)).toBe(true);expect(sameSystemBoot(p,{...p,observedAt:now})).toBe(true);
  expect(laterSystemBoot(p,{...p,observedAt:now})).toBe(false);
  expect(laterSystemBoot(p,{...current,machineSha256:'b'.repeat(64)})).toBe(false);
  expect(laterSystemBoot(p,{...current,bootedAt:new Date(p.observedAt).toISOString()})).toBe(false);
  expect(freshSystemBoot({...current,observedAt:now-60_001},now)).toBe(false);
  expect(freshSystemBoot({...current,observedAt:now+1001},now)).toBe(false);
  expect(validSystemBoot({...p,bootedAt:'invalid'})).toBe(false);
  expect(validSystemBoot({...p,observedAt:'0'})).toBe(false);
});
