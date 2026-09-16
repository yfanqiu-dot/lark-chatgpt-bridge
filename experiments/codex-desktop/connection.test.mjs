import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopLaunchEnvironment, desktopToolOverrides, requireLoopbackWebSocket } from './connection.mjs';
const definition = { command: 'node', cwd: 'C:/verified-plugin', env: { RUNTIME: 'keep' }, tools: { create_thread: { approval_mode: 'prompt' } } };
const binding = { desktopPid: 10, serverPid: 10, pipe: '\\\\.\\pipe\\codex-browser-use-test', verifiedAt: 1000, toolNames: ['list_projects', 'create_thread'] };
test('relaunch removes stale task and desktop transport variables without changing source', () => {
  const source = { PATH: 'path', CODEX_HOME: 'home', CODEX_THREAD_ID: 'old', CODEX_APP_TOOLS_PIPE_PATH: 'stale', NODE_REPL_X: 'old' };
  assert.deepEqual(desktopLaunchEnvironment(source), { PATH: 'path', CODEX_HOME: 'home' });
  assert.equal(source.CODEX_APP_TOOLS_PIPE_PATH, 'stale');
});
test('task-scoped definition preserves approval rules and uses only the verified pipe', () => {
  const output = desktopToolOverrides(definition, binding, { allowedTools: ['list_projects'], now: 1001 });
  const server = output['mcp_servers.codex_app'];
  assert.deepEqual(server.tools, definition.tools);
  assert.equal(server.env.RUNTIME, 'keep');
  assert.equal(server.env.CODEX_APP_TOOLS_PIPE_PATH, binding.pipe);
  assert.deepEqual(server.enabled_tools, ['list_projects']);
  assert.equal(definition.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
  assert.equal(JSON.stringify(output).includes('threadId'), false);
});
test('rejects another process, stale verification, and the wrong pipe service', () => {
  for (const change of [{serverPid:11}, {verifiedAt:-100000}, {toolNames:['browser_open']}, {pipe:'\\\\remote\\pipe\\codex-browser-use-test'}]) {
    assert.throws(() => desktopToolOverrides(definition, {...binding,...change}, {now:1001}));
  }
});
test('rejects unavailable tools and non-loopback endpoints', () => {
  assert.throws(() => desktopToolOverrides(definition,binding,{allowedTools:['unknown'],now:1001}));
  assert.equal(requireLoopbackWebSocket('ws://127.0.0.1:1234'), 'ws://127.0.0.1:1234/');
  for (const endpoint of ['ws://0.0.0.0:1234','ws://example.com','ws://user@127.0.0.1:1234']) assert.throws(() => requireLoopbackWebSocket(endpoint));
});
