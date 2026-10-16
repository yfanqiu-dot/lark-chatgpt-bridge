import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerOwnerLease } from '../../../src/desktop/broker-lease';

let dir: string; const owned: BrokerOwnerLease[] = [];
const runId = '12345678-1234-1234-1234-123456789abc', token = 'a'.repeat(64);
const owner = { pid: 42, parentPid: 1, createdAt: '2026-10-11T00:00:00.000Z', executable: process.execPath, commandLineSha256: 'b'.repeat(64) };
const packageName = 'OpenAI.Codex_26.1007.2314.0_x64__2p2nqsd0c76g0';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(),'broker-lease-')); });
afterEach(async () => { vi.useRealTimers(); for (const lease of owned.splice(0)) await lease.close().catch(() => {}); await rm(dir,{recursive:true,force:true}); });
function lease(now = Date.now) { const l = new BrokerOwnerLease(join(dir,'owner.json'),now); owned.push(l); return l; }
const read = async () => JSON.parse(await readFile(join(dir,'owner.json'),'utf8'));
it('renews atomically with increasing revisions, hashed capability and immutable owner', async () => {
  let time = 1000; const l = lease(() => time); await l.open(runId,owner,packageName,token); const before = await read();
  owner.pid = 99; time += 5000; await l.renew(); owner.pid = 42;
  expect(await read()).toMatchObject({ owner: { pid: 42 }, revision: 1, expiresAt: 21000 }); expect(before.tokenSha256).not.toBe(token); expect(JSON.stringify(before)).not.toContain(`"${token}"`);
});
it('refuses a second writer and retains a closed lease as evidence instead of overwriting it', async () => {
  const first = lease(); await first.open(runId,owner,packageName,token); const original = await readFile(first.path,'utf8');
  const second = lease(); await expect(second.open(runId,owner,packageName,token)).rejects.toThrow(); expect(await readFile(first.path,'utf8')).toBe(original);
  await first.close(); expect((await read()).expiresAt).toBeLessThanOrEqual(Date.now()); await expect(second.open(runId,owner,packageName,token)).rejects.toThrow();
});
it('refuses expired renewals so a broker that has begun draining cannot revive', async () => {
  let time = 1000; const l = lease(() => time); await l.open(runId,owner,packageName,token); time = 16000;
  await expect(l.renew()).rejects.toThrow('expired'); expect((await read()).revision).toBe(0);
});
it('renews on heartbeat and reports a changed lease only once without overwriting it', async () => {
  vi.useFakeTimers({ toFake: ['setInterval','clearInterval'] });
  const l = new BrokerOwnerLease(join(dir,'owner.json'),() => 1000,5000); owned.push(l);
  await l.open(runId,owner,packageName,token); let lost = 0; l.startHeartbeat(() => { lost++; });
  await vi.advanceTimersByTimeAsync(1667); await expect.poll(async () => (await read()).revision).toBe(1);
  const foreign = { ...await read(), runId: 'foreign' }; const data = JSON.stringify(foreign); await writeFile(l.path,data,'utf8');
  await vi.advanceTimersByTimeAsync(1667); await expect.poll(() => lost).toBe(1);
  await vi.advanceTimersByTimeAsync(10000); expect(lost).toBe(1); expect(await readFile(l.path,'utf8')).toBe(data);
});
it.each(['owner','runId','token','revision'])('refuses changed %s and does not replace it on close', async field => {
  const l = lease(); await l.open(runId,owner,packageName,token); const foreign = await read();
  if (field === 'owner') foreign.owner.createdAt = '2026-10-11T01:00:00.000Z';
  if (field === 'runId') foreign.runId = 'other';
  if (field === 'token') foreign.tokenSha256 = 'c'.repeat(64);
  if (field === 'revision') foreign.revision++;
  const data = JSON.stringify(foreign); await writeFile(l.path,data,'utf8'); await expect(l.renew()).rejects.toThrow('changed'); await l.close(); expect(await readFile(l.path,'utf8')).toBe(data);
});
