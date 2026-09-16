import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { createLarkChannel } from '@larksuite/channel';
import { parseDesktopConfig } from './config';
import { DesktopBackend } from './backend';
import { DesktopLedger } from './ledger';
import { DesktopController } from './controller';
import { resolveAppPaths } from '../config/app-paths';
import { acquireAppRuntimeLock } from '../runtime/locks';

async function main(): Promise<void> {
  const [configPath, mode] = process.argv.slice(2);
  if (!configPath || !['--check', '--run'].includes(mode ?? '')) throw new Error('Usage: lark-chatgpt-bridge <config.json> --check|--run (Node.js >=22)');
  const config = parseDesktopConfig(JSON.parse(await readFile(configPath, 'utf8')));
  const backend = new DesktopBackend(config);
  // No Feishu connection or secret required for the desktop-only preflight.
  await backend.preflight();
  if (mode === '--check') { console.log('Desktop project/thread/tool lease verified. Feishu not connected.'); return; }
  const secret = process.env[config.appSecretEnv];
  if (!secret) throw new Error(`Missing secret environment variable ${config.appSecretEnv}`);
  await mkdir(dirname(config.stateFile), { recursive: true });
  // Same application lock as the upstream consumer, in the same LARK_CHANNEL_HOME.
  const appLock = await acquireAppRuntimeLock(resolveAppPaths({ profile: 'codex-desktop' }), config.appId, 'codex');
  let releaseState: () => Promise<void>;
  try { releaseState = await lockfile.lock(config.stateFile, { realpath: false, retries: 0 }); }
  catch (e) { await appLock.release(); throw e; }
  const release = async () => { await releaseState(); await appLock.release(); };
  const binding = { appId: config.appId, chatId: config.chatId, ownerOpenId: config.ownerOpenId, projectId: config.projectId, projectRoot: config.projectRoot, threadId: config.threadId };
  const channel = createLarkChannel({ appId: config.appId, appSecret: secret, domain: 'https://open.feishu.cn', source: 'lark-chatgpt-bridge', resolveChatMode: true,
    policy: { dmMode: 'disabled', requireMention: false, respondToMentionAll: false }, safety: { chatQueue: { enabled: false } }, respectProxyEnv: true, httpTimeoutMs: 30_000 });
  const cards = new Map<string, string>();
  const controller = new DesktopController(config, new DesktopLedger(config.stateFile, binding), backend, {
    send: async (chatId, text, replyTo, replyInThread) => (await channel.send(chatId, { markdown: text }, { replyTo, replyInThread })).messageId,
    approval: async (chatId, a, replyTo, replyInThread) => {
      const card = { config: { wide_screen_mode: true }, header: { title: { tag: 'plain_text', content: 'Codex 操作等待审批' }, template: 'orange' }, elements: [
        { tag: 'div', text: { tag: 'plain_text', content: a.description } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: `审批编号：${a.token}。仅任务所有者可处理。` }] },
        ...(a.decisions.length ? [{ tag: 'action', actions: a.decisions.map(decision => ({ tag: 'button', text: { tag: 'plain_text', content: ({ accept: '同意本次', decline: '拒绝', cancel: '取消任务' } as Record<string, string>)[decision] }, value: { desktopApproval: a.token, decision } })) }] : []),
      ] };
      const result = await channel.send(chatId, { card }, { replyTo, replyInThread });
      if (!result.messageId) throw new Error('Approval card receipt missing');
      cards.set(a.token, result.messageId);
    },
    resolved: async token => {
      const messageId = cards.get(token); if (!messageId) return;
      await channel.updateCard(messageId, { elements: [{ tag: 'div', text: { tag: 'plain_text', content: '此审批已结束或原连接失效。如仍需审批，请以最新卡片为准。' } }] });
      cards.delete(token);
    },
  });
  let readyResolve!: () => void;
  let readyReject!: (e: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  channel.on({
    message: async msg => {
      try { await ready; } catch { return; }
      if (msg.resources.length || msg.rawContentType !== 'text') return;
      let content = msg.content;
      for (const mention of msg.mentions.filter(m => m.isBot || m.openId === channel.botIdentity?.openId)) {
        content = content.replace(mention.key, '').replace(`@${mention.name}`, '');
      }
      await controller.receive({ messageId: msg.messageId, chatId: msg.chatId, senderId: msg.senderId, content, mentionedBot: msg.mentionedBot, isBot: msg.senderIsBot || msg.senderId === channel.botIdentity?.openId, replyInThread: Boolean(msg.threadId || msg.chatMode === 'topic') }).catch(e => console.error('Desktop intake failed:', String(e)));
    },
    cardAction: async evt => {
      try { await ready; } catch { return; }
      const value = evt.action.value as { desktopApproval?: unknown; decision?: unknown };
      if (typeof value?.desktopApproval !== 'string' || typeof value.decision !== 'string') return;
      try { await controller.decideFromCard(evt.chatId, evt.operator.openId, value.desktopApproval, value.decision); return { toast: { type: 'info', content: '决定已提交，等待服务端确认。' } }; }
      catch (e) { return { toast: { type: 'error', content: String(e) } }; }
    },
    error: e => console.error('Feishu channel error:', e.message),
  });
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    try { await controller.shutdown(); } finally { try { await channel.disconnect(); } finally { await release(); } }
  })();
  const onSignal = () => { void shutdown().catch(e => { console.error(String(e)); process.exitCode = 1; }); };
  try {
    await channel.connect(); await controller.start(); readyResolve();
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    console.log(`Desktop bridge ready for ${config.chatId}`);
  } catch (e) { readyReject(e); await shutdown(); throw e; }
}
void main().catch(e => { console.error(String(e)); process.exitCode = 1; });
