import { afterEach, beforeEach, expect, it } from 'vitest';
import net, { type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectOrdinaryIdle, OrdinaryPipeRpc, type OrdinaryReadRpc } from '../../../src/desktop/ordinary-idle';
import { RpcError } from '../../../src/desktop/rpc';

const desktop = { pid: 42, parentPid: 1, createdAt: '2026-10-11T00:00:00.000Z', executable: process.execPath, commandLineSha256: 'a'.repeat(64) };
const bindings = [{ threadId: 'original', projectId: 'project', projectRoot: tmpdir() }];
const tools = ['list_projects', 'read_thread'];
function reads(overrides: (method: string, params: any) => any = () => undefined) {
  const calls: string[] = []; let closed = 0;
  const rpc: OrdinaryReadRpc = { async call(method, params) {
    calls.push(method); const value = overrides(method, params); if (value !== undefined) return value;
    if (method === 'tools/list') return { tools: tools.map(name => ({ name })) };
    if (method === 'thread/loaded/list') return { data: ['original', 'other-project'] };
    if (method === 'thread/read') return { thread: { id: (params as any).threadId, projectId: 'project', cwd: tmpdir(), status: { type: 'idle', activeFlags: [] } } };
    if (method === 'thread/queue/list') return { data: [] };
    throw new Error('Unexpected method');
  }, close() { closed++; } };
  return { rpc, calls, get closed() { return closed; } };
}
it('reads all loaded tasks including other projects twice and emits only original binding proof', async () => {
  const h = reads(); const report = await inspectOrdinaryIdle(h.rpc, desktop, bindings, tools, async () => desktop);
  expect(report).toMatchObject({ verified: true, toolCount: 2, loadedThreadCount: 2, proof: { allDesktopTasksIdle: true, tasks: [{ threadId: 'original', queueCount: 0 }] } });
  expect(report.proof!.tasks).toHaveLength(1); expect(h.calls.filter(m => m === 'thread/queue/list')).toHaveLength(4); expect(h.closed).toBe(1);
});
it.each(['active', 'approval', 'queue'])('rejects %s on an unrelated loaded task', async condition => {
  const h = reads((m, p) => {
    if (p.threadId !== 'other-project') return;
    if (condition === 'queue' && m === 'thread/queue/list') return { data: [{ id: 'queued' }] };
    if (m === 'thread/read') return { thread: { id: p.threadId, status: { type: 'active', activeFlags: condition === 'approval' ? ['waitingOnApproval'] : [] } } };
  });
  // Queue case needs an idle task before inspecting its pending input.
  const rpc = condition === 'queue' ? reads((m,p) => m === 'thread/queue/list' && p.threadId === 'other-project' ? { data: [{ id: 'queued' }] } : undefined).rpc : h.rpc;
  expect(await inspectOrdinaryIdle(rpc, desktop, bindings, tools, async () => desktop)).toMatchObject({ verified: false, findings: [condition === 'queue' ? 'ordinary_queue_pending' : condition === 'approval' ? 'ordinary_waiting_approval' : 'ordinary_task_active'] });
});
it('fails closed on unsupported native RPC and does not expose raw errors', async () => {
  const h = reads(m => { if (m === 'thread/loaded/list') throw new RpcError(-32601, 'SECRET raw response'); });
  const report = await inspectOrdinaryIdle(h.rpc, desktop, bindings, tools, async () => desktop);
  expect(report).toMatchObject({ verified: false, findings: ['ordinary_native_rpc_unsupported'] }); expect(JSON.stringify(report)).not.toContain('SECRET'); expect(h.closed).toBe(1);
});
it('rejects repeated queue cursors and changed loaded sets', async () => {
  const h = reads(m => m === 'thread/queue/list' ? { data: [], nextCursor: 'same' } : undefined);
  expect((await inspectOrdinaryIdle(h.rpc, desktop, bindings, tools, async () => desktop)).verified).toBe(false);
  let scans = 0; const changed = reads(m => m === 'thread/loaded/list' ? { data: ++scans === 1 ? ['original'] : ['original','new'] } : undefined);
  expect(await inspectOrdinaryIdle(changed.rpc, desktop, bindings, tools, async () => desktop)).toMatchObject({ verified: false, findings: ['ordinary_loaded_set_changed'] });
});
it('rejects binding drift, tool drift, PID reuse, stale reads and observed activity', async () => {
  const wrong = reads(m => m === 'thread/read' ? { thread: { id: 'original', projectId: 'wrong', cwd: tmpdir(), status: { type: 'idle' } } } : undefined);
  expect((await inspectOrdinaryIdle(wrong.rpc, desktop, bindings, tools, async () => desktop)).findings).toEqual(['ordinary_binding_mismatch']);
  const extra = reads(m => m === 'tools/list' ? { tools: [{ name: 'list_projects' }] } : undefined);
  expect((await inspectOrdinaryIdle(extra.rpc, desktop, bindings, tools, async () => desktop)).findings).toEqual(['ordinary_tools_mismatch']);
  expect((await inspectOrdinaryIdle(reads().rpc, desktop, bindings, tools, async () => ({ ...desktop, parentPid: 9 }))).findings).toEqual(['ordinary_process_identity_changed']);
  let tick = 0; expect((await inspectOrdinaryIdle(reads().rpc, desktop, bindings, tools, async () => desktop, () => tick++ ? 7000 : 0)).verified).toBe(false);
  const dirty = reads().rpc; Object.defineProperty(dirty, 'changed', { value: true });
  expect((await inspectOrdinaryIdle(dirty, desktop, bindings, tools, async () => desktop)).findings).toEqual(['ordinary_native_activity_observed']);
});

let dir: string; const sockets = new Set<Socket>(); let server: net.Server | undefined;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'p4-pipe-')); });
afterEach(async () => { for (const socket of sockets) socket.destroy(); sockets.clear(); if (server?.listening) await new Promise<void>(done => server!.close(() => done())); server = undefined; await rm(dir, { recursive: true, force: true }); });
async function pipe(reply: (socket: Socket, request: any) => void) {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\codex-browser-use-p4-test-${randomUUID()}` : join(dir, 'rpc.sock');
  const requests: any[] = []; server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); let pending = Buffer.alloc(0);
    socket.on('data', chunk => { pending = Buffer.concat([pending,chunk]); while (pending.length >= 4 && pending.length >= pending.readUInt32LE(0) + 4) { const n = pending.readUInt32LE(0); const request = JSON.parse(pending.subarray(4, n + 4).toString('utf8')); pending = pending.subarray(n + 4); requests.push(request); reply(socket, request); } });
  });
  await new Promise<void>(done => server!.listen(path, done)); const rpc = new OrdinaryPipeRpc(path, 150); await rpc.connect(); return { rpc, requests };
}
function frame(value: unknown): Buffer { const bytes = Buffer.from(JSON.stringify(value)); const buffer = Buffer.alloc(bytes.length + 4); buffer.writeUInt32LE(bytes.length); bytes.copy(buffer,4); return buffer; }
it('uses actual framed pipe reads with fragmented responses and forbids mutation methods', async () => {
  const h = await pipe((socket,r) => { const response = frame({ id: r.id, result: { tools: [] } }); socket.write(response.subarray(0,3)); setTimeout(() => socket.write(response.subarray(3)),10); });
  try { expect(await h.rpc.call('tools/list', {})).toEqual({ tools: [] }); await expect(h.rpc.call('thread/queue/add', {})).rejects.toThrow('only permits'); expect(h.requests).toHaveLength(1); } finally { h.rpc.close(); }
});
it.each(['invalid-json-root','oversized-frame','disconnect','timeout'])('rejects %s without replaying', async fault => {
  const h = await pipe((socket,r) => {
    if (fault === 'invalid-json-root') socket.write(frame(null));
    if (fault === 'oversized-frame') { const header = Buffer.alloc(4); header.writeUInt32LE(8*1024*1024+1); socket.write(header); }
    if (fault === 'disconnect') socket.destroy();
  });
  try { await expect(h.rpc.call('tools/list', {})).rejects.toThrow(); expect(h.requests).toHaveLength(1); await expect(h.rpc.connect()).rejects.toThrow('cannot reconnect'); } finally { h.rpc.close(); }
});
