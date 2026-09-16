// P0 prototype. Intentionally not registered as a production bridge backend.
export function desktopLaunchEnvironment(source) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !key.startsWith('NODE_REPL_') && (!key.startsWith('CODEX_') || key === 'CODEX_HOME')));
}

export function desktopToolOverrides(definition, binding, { allowedTools, now = Date.now() } = {}) {
  if (!Number.isInteger(binding.desktopPid) || binding.desktopPid <= 0 || binding.serverPid !== binding.desktopPid) {
    throw new Error('Desktop tool pipe owner does not match the verified desktop process');
  }
  const prefix = '\\\\.\\pipe\\codex-browser-use-';
  if (!binding.pipe?.startsWith(prefix) || !/^[a-zA-Z0-9-]+$/.test(binding.pipe.slice(prefix.length))) {
    throw new Error('Expected a local Codex named pipe');
  }
  if (!Number.isFinite(binding.verifiedAt) || now - binding.verifiedAt > 60_000 || binding.verifiedAt > now + 1000) {
    throw new Error('Desktop connection verification has expired; resolve it again');
  }
  if (!binding.toolNames?.includes('list_projects')) throw new Error('Endpoint does not expose the desktop tool catalog');
  if (!definition.command || !definition.cwd) throw new Error('Installed desktop MCP definition is incomplete');
  const server = structuredClone(definition);
  server.enabled = true;
  server.env = { ...server.env, CODEX_APP_TOOLS_PIPE_PATH: binding.pipe };
  if (allowedTools !== undefined) {
    if (!allowedTools.length || allowedTools.some(name => !binding.toolNames.includes(name))) {
      throw new Error('Requested desktop tools are absent from the verified catalog');
    }
    server.enabled_tools = [...allowedTools];
  }
  // This version accepts a complete task-scoped MCP server definition. The
  // plugin-scoped env override was live-tested and did not supply the variable.
  // Keep the installed definition's approval rules; do not synthesize identity.
  return {
    'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': false,
    'mcp_servers.codex_app': server,
  };
}

export function requireLoopbackWebSocket(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('P0 only permits a local loopback WebSocket endpoint');
  }
  return url.href;
}
