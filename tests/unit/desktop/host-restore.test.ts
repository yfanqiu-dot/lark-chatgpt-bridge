import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const mocks=vi.hoisted(()=>({launch:vi.fn(),pipes:vi.fn(),catalog:vi.fn()}));
vi.mock('../../../src/desktop/packaged-desktop',()=>({launchPackagedDesktop:mocks.launch}));
vi.mock('../../../src/desktop/windows-tools',()=>({desktopPipes:mocks.pipes,desktopToolCatalog:mocks.catalog,cleanDesktopEnvironment:(env:unknown)=>env}));
import { restoreOrdinaryDesktop, type HostConfig } from '../../../src/desktop/host';
let dir:string,cfg:HostConfig,desktop:any;
beforeEach(async()=>{
  vi.resetAllMocks();dir=await mkdtemp(join(tmpdir(),'host-restore-'));
  cfg={desktopExe:'/test/app/ChatGPT.exe',desktopVersion:'test',projectRoot:dir,connectionFile:join(dir,'lease.json')} as HostConfig;
  desktop={pid:42,exitCode:null,signalCode:null,refresh:vi.fn(async()=>{}),stop:vi.fn(async()=>true),detach:vi.fn(async()=>{})};
  mocks.launch.mockResolvedValue(desktop);mocks.pipes.mockResolvedValue([{pipe:'owned',serverPid:42}]);mocks.catalog.mockResolvedValue(['list_projects']);
});
afterEach(async()=>{vi.useRealTimers();await rm(dir,{recursive:true,force:true});});
it('releases ordinary desktop only after its own package-verified tool catalog responds',async()=>{
  await restoreOrdinaryDesktop(cfg);
  expect(mocks.launch).toHaveBeenCalledWith(cfg);
  expect(mocks.pipes).toHaveBeenCalledWith(42,cfg.desktopExe);
  expect(desktop.detach).toHaveBeenCalledOnce();expect(desktop.stop).not.toHaveBeenCalled();
  expect(JSON.parse(await readFile(`${cfg.connectionFile}.restored.json`,'utf8'))).toMatchObject({desktopPid:42,toolsVerified:true,packageIdentityVerified:true});
});
it('does not report a short-lived ordinary process as restored even when its exit code is zero',async()=>{
  desktop.refresh.mockImplementation(async()=>{desktop.exitCode=0;});
  await expect(restoreOrdinaryDesktop(cfg)).rejects.toThrow('code 0');
  expect(desktop.detach).not.toHaveBeenCalled();expect(desktop.stop).toHaveBeenCalledOnce();
  await expect(readFile(`${cfg.connectionFile}.restored.json`)).rejects.toMatchObject({code:'ENOENT'});
});
it('fails restoration when the process exists but package/tool verification never succeeds',async()=>{
  vi.useFakeTimers();mocks.pipes.mockRejectedValue(new Error('Desktop has no package identity'));
  const result=expect(restoreOrdinaryDesktop(cfg)).rejects.toThrow('did not become ready');
  await vi.waitFor(()=>expect(mocks.pipes).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(61_000);await result;
  expect(desktop.detach).not.toHaveBeenCalled();expect(desktop.stop).toHaveBeenCalledOnce();
});
