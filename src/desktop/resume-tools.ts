import type { RpcMessage } from './rpc';

export function desktopToolOverrides(mcpServer: Record<string, any>, pipe: string): Record<string, unknown> {
  return {
    'plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled': false,
    'mcp_servers.codex_app': { ...mcpServer, enabled: true, env: { ...mcpServer.env, CODEX_APP_TOOLS_PIPE_PATH: pipe } },
  };
}

/** Install tool wiring on the first resume, including desktop-initiated resumes.
 * A later resume cannot be relied on to replace an already loaded MCP runtime.
 * Only explicitly bound tasks are changed; permissions and caller identity survive.
 */
export async function prepareResumeTools(
  message: RpcMessage, threadIds: ReadonlySet<string>, getConfig: () => Promise<Record<string, unknown>>,
): Promise<RpcMessage> {
  if (message.method !== 'thread/resume' || !threadIds.has(message.params?.threadId)) return message;
  const config = message.params.config;
  if (config != null && (typeof config !== 'object' || Array.isArray(config))) throw new Error('Invalid resume config');
  return { ...message, params: { ...message.params, config: { ...config, ...await getConfig() } } };
}
