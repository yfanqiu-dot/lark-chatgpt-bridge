import { expect, it } from 'vitest';
import { validatePackageStatus } from '../../../src/desktop/packaged-desktop';

const packageFullName='OpenAI.Codex_26.924.2738.0_x64__2p2nqsd0c76g0';
const running={version:1,phase:'running',pid:1234,packageFullName};
it('does not accept a PID without the pinned package identity',()=>{
  expect(()=>validatePackageStatus({...running,packageFullName:undefined},packageFullName)).toThrow('identity');
  expect(()=>validatePackageStatus({...running,packageFullName:'other-version'},packageFullName)).toThrow('identity');
  expect(()=>validatePackageStatus(running,packageFullName,9999)).toThrow('identity');
  expect(validatePackageStatus(running,packageFullName,1234)).toEqual(running);
});
it('preserves an early zero exit and propagates activation failures',()=>{
  expect(validatePackageStatus({...running,phase:'exited',exitCode:0},packageFullName).phase).toBe('exited');
  expect(()=>validatePackageStatus({...running,phase:'exited'},packageFullName)).toThrow('exit status');
  expect(()=>validatePackageStatus({version:1,phase:'failed',error:'No package identity'},packageFullName)).toThrow('No package identity');
});
