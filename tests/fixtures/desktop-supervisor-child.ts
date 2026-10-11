// Test-only roles. No Codex desktop, Feishu, task scheduler or model input.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DesktopSupervisor, SupervisorJournal, type ProcessIdentity, type SupervisorInventory, type SupervisorPort } from '../../src/desktop/supervisor';

const [dir, mode, role] = process.argv.slice(2) as [string,string,string];
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const read = async (file: string) => JSON.parse(await readFile(join(dir, file), 'utf8'));
const save = async (file: string, value: unknown) => writeFile(join(dir, file), JSON.stringify(value), 'utf8');
const exists = async (file: string) => { try { await readFile(join(dir, file)); return true; } catch { return false; } };
const fake = (pid: number): ProcessIdentity => ({ pid, parentPid: 1, createdAt: '2026-10-11T00:00:00.000Z', executable: process.execPath, commandLineSha256: 'a'.repeat(64) });
async function worker(): Promise<void> {
  await save(`identity-${role}.json`, { pid: process.pid, parentPid: process.ppid, createdAt: new Date().toISOString(), executable: process.execPath, commandLineSha256: createHash('sha256').update(process.argv.join('\0')).digest('hex') });
  const until = Date.now() + 25_000;
  while (!await exists(`stop-${role}`) && Date.now() < until) await delay(50);
  await save(`exited-${role}.json`, { exited: true });
}
async function supervisor(): Promise<void> {
  const inventoryFile = 'inventory.json';
  if (!await exists(inventoryFile)) await save(inventoryFile, { legacy: [fake(10000001)], desktop: [fake(10000002)], broker: [], host: [], listener: [] });
  const events: string[] = await exists('events.json') ? await read('events.json') : [];
  const event = async (value: string) => { events.push(value); await save('events.json', events); };
  const inventory = async (): Promise<SupervisorInventory> => read(inventoryFile);
  const launch = async (name: string): Promise<ProcessIdentity> => {
    await event(`start:${name}`);
    const child = spawn(process.execPath, [__filename, dir, 'worker', name], { detached: true, windowsHide: true, stdio: 'ignore' }); child.unref();
    const until = Date.now() + 5000;
    while (!await exists(`identity-${name}.json`) && Date.now() < until) await delay(20);
    const identity = await read(`identity-${name}.json`), i = await inventory();
    i[name as 'host'|'listener'|'broker'] = [identity]; if (name === 'host') i.desktop = [fake(10000003)];
    await save(inventoryFile, i); return identity;
  };
  const stop = async (name: string): Promise<void> => {
    await event(`stop:${name}`); await writeFile(join(dir, `stop-${name}`), 'stop', 'utf8');
    const until = Date.now() + 5000; while (!await exists(`exited-${name}.json`) && Date.now() < until) await delay(20);
    if (!await exists(`exited-${name}.json`)) throw new Error('Fixture role did not exit');
    const i = await inventory(); i[name as 'host'|'listener'|'broker'] = []; if (name === 'host') i.desktop = []; await save(inventoryFile, i);
  };
  const bindings = [{ threadId: 'fixture-thread', projectId: 'fixture-project', projectRoot: dir }];
  const port: SupervisorPort = {
    inventory,
    async idle() { return { verifiedAt: Date.now(), desktop: (await inventory()).desktop[0]!, allDesktopTasksIdle: true, toolsExact: true, tasks: bindings.map(b => ({ ...b, status: 'idle', queueCount: 0, waitingApproval: false })) }; },
    async backup() { return { legacyTaskEnabled: true, launchDefinitionSha256: 'b'.repeat(64) }; },
    async pauseLegacy() { await event('pause:legacy'); const i = await inventory(); i.legacy = []; await save(inventoryFile, i); },
    async closeDesktop() { await event('close:desktop'); const i = await inventory(); i.desktop = []; await save(inventoryFile, i); },
    startBroker: () => launch('broker'), startHost: () => launch('host'), startListener: () => launch('listener'),
    async ready() {}, async health() { return true; },
    stopListener: () => stop('listener'), stopHost: () => stop('host'), stopBroker: () => stop('broker'),
    async ordinary() { await event('restore:desktop'); const i = await inventory(); i.desktop = [fake(10000004)]; await save(inventoryFile, i); return { desktop: i.desktop[0]!, verifiedAt: Date.now(), packageIdentityVerified: true, toolsExact: true }; },
    async restoreLegacy() { await event('restore:legacy'); const i = await inventory(); i.legacy = [fake(10000005)]; await save(inventoryFile, i); },
    async verifyBindings() {},
  };
  const state = await new DesktopSupervisor(new SupervisorJournal(join(dir, 'supervisor.json'), 2000), port, bindings).run(
    () => exists('request-stop'), async () => { console.log('RUNNING'); await delay(100); });
  console.log(state.phase.toUpperCase()); if (state.phase !== 'restored') process.exitCode = 1;
}
void (mode === 'worker' ? worker() : supervisor()).catch(e => { console.error(e.message); process.exitCode = 1; });
