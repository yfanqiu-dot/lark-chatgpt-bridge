import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { createLarkChannel } from '@larksuite/channel';
import { desktopOutboundConfig } from './outbound';
import { parseDesktopConfig } from './config';
import { DesktopBackend } from './backend';
import { DesktopLedger } from './ledger';
import { DesktopController } from './controller';
import { resolveAppPaths } from '../config/app-paths';
import { acquireAppRuntimeLock } from '../runtime/locks';
import { writeFileAtomic } from '../platform/atomic-write';
import { approvalCard, resolvedCard } from './cards';
import { desktopInbound } from './inbound';
import { ApprovalJournal } from './approval-journal';

async function main(): Promise<void> {
  const [configPath, mode] = process.argv.slice(2);
  if (!configPath || !['--check', '--run', '--stop'].includes(mode ?? '')) throw new Error('Usage: lark-chatgpt-bridge <config.json> --check|--run|--stop (Node.js >=22)');
  const config = parseDesktopConfig(JSON.parse(await readFile(configPath, 'utf8')));
  if (mode === '--stop') {
    if (!await lockfile.check(config.stateFile, { realpath: false })) throw new Error('No running bridge owns this state file');
    await writeFileAtomic(`${config.stateFile}.stop`, 'Stop this bridge gracefully'); return;
  }
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
    policy: { dmMode: 'disabled', requireMention: false, respondToMentionAll: false }, safety: { chatQueue: { enabled: false } }, outbound: desktopOutboundConfig, respectProxyEnv: true, httpTimeoutMs: 30_000 });
  const cards = new ApprovalJournal(`${config.stateFile}.approvals.json`, binding, {
    send: async (chatId, request, replyTo, replyInThread) => (await channel.send(chatId, { card: approvalCard(request) }, { replyTo, replyInThread })).messageId,
    close: async messageId => { await channel.updateCard(messageId, resolvedCard()); },
  });
  const controller = new DesktopController(config, new DesktopLedger(config.stateFile, binding), backend, {
    send: async (chatId, text, replyTo, replyInThread) => (await channel.send(chatId, { markdown: text }, { replyTo, replyInThread })).messageId,
    approval: (chatId, a, replyTo, replyInThread) => cards.publish(chatId, a, replyTo, replyInThread),
    resolved: token => cards.resolved(token),
    cardStatus: chatId => cards.pending(chatId),
  });
  let readyResolve!: () => void;
  let readyReject!: (e: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  channel.on({
    message: async msg => {
      try { await ready; } catch { return; }
      const inbound=desktopInbound(msg,channel.botIdentity?.openId);
      if(inbound)await controller.receive(inbound).catch(e => console.error('Desktop intake failed:', String(e)));
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
  let stopWatcher: ReturnType<typeof setInterval> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    clearInterval(stopWatcher);
    try { await controller.shutdown(); } finally { try { await cards.shutdown(); } finally { try { await channel.disconnect(); } finally { await rm(`${config.stateFile}.stop`, { force: true }); await release(); } } }
  })();
  const onSignal = () => { void shutdown().catch(e => { console.error(String(e)); process.exitCode = 1; }); };
  try {
    await rm(`${config.stateFile}.stop`, { force: true });
    await channel.connect(); await cards.start(); await controller.start(); readyResolve();
    process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
    stopWatcher = setInterval(() => { void readFile(`${config.stateFile}.stop`).then(shutdown).catch(e => {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { console.error('Bridge shutdown failed:', String(e)); process.exitCode = 1; }
    }); }, 1000);
    console.log(`Desktop bridge ready for ${config.chatId}`);
  } catch (e) { readyReject(e); await shutdown(); throw e; }
}
void main().catch(e => { console.error(String(e)); process.exitCode = 1; });
