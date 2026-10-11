import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

let bundle: string, dir: string;
const children: ChildProcess[] = [];
beforeAll(async () => {
  bundle = await mkdtemp(join(tmpdir(), 'p4-supervisor-bundle-'));
  await promisify(execFile)(process.execPath, ['-e', "require('tsup').build({...JSON.parse(process.argv[1]),outExtension:()=>({js:'.cjs'})}).catch(e=>{console.error(e);process.exitCode=1})", JSON.stringify({ entry: ['tests/fixtures/desktop-supervisor-child.ts'], outDir: bundle, format: ['cjs'], platform: 'node', target: 'node22', bundle: true, noExternal: ['graceful-fs','proper-lockfile'], silent: true, dts: false, config: false })], { windowsHide: true });
}, 20_000);
afterAll(async () => { await rm(bundle, { recursive: true, force: true }); });
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'p4-supervisor-process-')); });
afterEach(async () => {
  for (const role of ['host','broker','listener']) await writeFile(join(dir, `stop-${role}`), 'stop', 'utf8');
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) {
    const done = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await done;
  }
  // Worker stop requests only affect this unique fixture directory. No PID from
  // a saved record is used to kill an arbitrary OS process.
  const until = Date.now() + 3000;
  while (Date.now() < until) {
    const pending = await Promise.all(['host','broker','listener'].map(async role => {
      try { await readFile(join(dir, `identity-${role}.json`)); } catch { return false; }
      try { await readFile(join(dir, `exited-${role}.json`)); return false; } catch { return true; }
    }));
    if (!pending.some(Boolean)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await rm(dir, { recursive: true, force: true });
});
function run(mode: string) {
  const child = spawn(process.execPath, [join(bundle, 'desktop-supervisor-child.cjs'), dir, mode], { windowsHide: true, stdio: ['ignore','pipe','pipe'] }); children.push(child);
  let output = '', errors = '', notify: () => void = () => {};
  const running = new Promise<void>(resolve => { notify = resolve; });
  child.stdout!.on('data', data => { output += data; if (output.includes('RUNNING')) notify(); });
  child.stderr!.on('data', data => { errors += data; });
  const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  return { child, running, exit, output: () => output, errors: () => errors };
}
it('recovers only backward after actual supervisor termination and natural writer-lock expiry', async () => {
  const first = run('initial'); await Promise.race([first.running, first.exit.then(code => { throw new Error(`Initial fixture exited (${code}): ${first.errors()}`); })]);
  const before = JSON.parse(await readFile(join(dir, 'supervisor.json'), 'utf8')); expect(before.phase).toBe('running');
  for (const role of ['host','broker','listener']) { const p = JSON.parse(await readFile(join(dir, `identity-${role}.json`), 'utf8')); expect(() => process.kill(p.pid, 0)).not.toThrow(); }
  first.child.kill('SIGKILL'); await first.exit;
  // Do not delete an active lock. Wait for its configured natural stale window.
  await new Promise(resolve => setTimeout(resolve, 2500));
  const second = run('recover'); expect(await second.exit, second.errors()).toBe(0); expect(second.output()).toContain('RESTORED');
  const after = JSON.parse(await readFile(join(dir, 'supervisor.json'), 'utf8')); expect(after.runId).toBe(before.runId); expect(after.phase).toBe('restored');
  const events = JSON.parse(await readFile(join(dir, 'events.json'), 'utf8'));
  expect(events.filter((e: string) => e.startsWith('start:'))).toEqual(['start:broker','start:host','start:listener']);
  expect(events.slice(-5)).toEqual(['stop:listener','stop:host','restore:desktop','restore:legacy','stop:broker']);
}, 15_000);
