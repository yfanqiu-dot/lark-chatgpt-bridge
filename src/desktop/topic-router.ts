import { join } from 'node:path';
import type { DesktopConfig } from './config';
import type { InboundMessage } from './controller';
import { TopicRegistry, parseCreateTopic, type TopicConfig, type TopicRecord } from './topics';
import { TopicProvisioner } from './topic-provisioner';

export interface TopicController {
  start(): Promise<void>;
  receive(message: InboundMessage): Promise<void>;
  decideFromCard(chatId: string, operator: string, token: string, decision: string): Promise<void>;
  shutdown(): Promise<void>;
}
export interface TopicReply { send(chatId: string, text: string, replyTo: string, replyInThread: boolean): Promise<string> }
export type TopicControllerFactory = (config: DesktopConfig) => TopicController;

export function topicDesktopConfig(config: TopicConfig, row: TopicRecord): DesktopConfig {
  const project = config.projects.find(p => p.key === row.projectKey);
  if (!project || !row.chatId || !row.threadId || project.projectId !== row.projectId || project.projectRoot !== row.projectRoot) throw new Error('Topic binding does not match configured project');
  return {
    appId: config.appId, appSecretEnv: config.appSecretEnv, ownerOpenId: config.ownerOpenId,
    chatId: row.chatId, projectId: row.projectId, projectRoot: row.projectRoot, threadId: row.threadId,
    endpoint: config.endpoint, connectionFile: config.connectionFile,
    stateFile: join(config.stateDir, `${row.chatId}.json`), model: config.model,
    requireMention: config.requireMention, maxQueue: config.maxQueue,
  };
}

export class TopicRouter {
  private controllers = new Map<string, TopicController>();
  private intake: Promise<void> = Promise.resolve();
  constructor(readonly config: TopicConfig, readonly registry: TopicRegistry, readonly provisioner: TopicProvisioner,
    private readonly factory: TopicControllerFactory, private readonly replies: TopicReply,
    private readonly onActive?: (row: TopicRecord) => Promise<void>) {}
  async start(): Promise<void> {
    await this.registry.load();
    if (this.config.existing) {
      const e = this.config.existing, project = this.config.projects.find(p => p.key === e.projectKey)!;
      const c = this.factory({ appId: this.config.appId, appSecretEnv: this.config.appSecretEnv, ownerOpenId: this.config.ownerOpenId,
        chatId: e.chatId, projectId: project.projectId, projectRoot: project.projectRoot, threadId: e.threadId,
        endpoint: this.config.endpoint, connectionFile: this.config.connectionFile, stateFile: e.stateFile,
        model: this.config.model, requireMention: this.config.requireMention, maxQueue: this.config.maxQueue });
      await c.start(); this.controllers.set(e.chatId, c);
    }
    for (const row of this.registry.all().filter(r => r.stage === 'active')) await this.attach(row);
  }
  receive(message: InboundMessage): Promise<void> {
    const task = this.intake.then(() => this.handle(message)); this.intake = task.catch(() => {}); return task;
  }
  private async attach(row: TopicRecord): Promise<void> {
    if (this.controllers.has(row.chatId!)) throw new Error('Two topic bindings claim the same chat');
    const c = this.factory(topicDesktopConfig(this.config, row));
    await c.start(); this.controllers.set(row.chatId!, c);
    if (this.onActive) void this.onActive(row).catch(e => console.error(`Topic archive ${row.chatId}:`, String(e)));
  }
  private async handle(message: InboundMessage): Promise<void> {
    if (message.isBot || message.senderId !== this.config.ownerOpenId || (this.config.requireMention && !message.mentionedBot)) return;
    if (message.chatId === this.config.entryChatId) {
      let create: ReturnType<typeof parseCreateTopic>;
      try { create = parseCreateTopic(message.content); }
      catch (error) { await this.replies.send(message.chatId, String(error), message.messageId, message.replyInThread); return; }
      const resume = /^\/topic\s+resume\s+(\S+)$/i.exec(message.content.trim());
      if (create || resume) {
        try {
          const previous = resume ? this.registry.byRequest(resume[1]!) : undefined;
          if (resume && !previous) throw new Error('找不到该创建请求');
          const row = await this.provisioner.create(resume ? resume[1]! : message.messageId, create?.projectKey ?? previous!.projectKey, create?.title ?? previous!.title);
          if (!this.controllers.has(row.chatId!)) await this.attach(row);
          const summary = `话题「${row.title}」已建立。项目：${row.projectKey}\n群 ID：${row.chatId}\n桌面对话：${row.threadId}`;
          if (!row.noticeAttempted) {
            await this.registry.notice(row.requestId); // Ambiguous send will not be replayed.
            try {
              const receipt = await this.replies.send(message.chatId, summary, message.messageId, message.replyInThread);
              if (receipt) await this.registry.notice(row.requestId, receipt);
            } catch (error) { console.error('Topic creation succeeded, but notification needs reconciliation:', String(error)); }
          } else if (resume) {
            await this.replies.send(message.chatId, summary, message.messageId, message.replyInThread);
          }
        } catch (e) {
          await this.replies.send(message.chatId, `话题创建未完成：${String(e)}\n可用 /topic resume ${resume?.[1] ?? message.messageId} 核对并接续；创建结果不明时不会重复创建。`, message.messageId, message.replyInThread);
        }
        return;
      }
    }
    if (message.chatId !== this.config.entryChatId && /^\/topic\b/i.test(message.content.trim()) && this.controllers.has(message.chatId)) {
      await this.replies.send(message.chatId, `请在入口群 ${this.config.entryChatId} 使用 /topic new <projectKey> <名称>。`, message.messageId, message.replyInThread);
      return;
    }
    await this.controllers.get(message.chatId)?.receive(message);
  }
  async decideFromCard(chatId: string, operator: string, token: string, decision: string): Promise<void> {
    const controller = this.controllers.get(chatId); if (!controller) throw new Error('群尚未绑定桌面对话');
    await controller.decideFromCard(chatId, operator, token, decision);
  }
  async shutdown(): Promise<void> { await this.intake; await Promise.all([...this.controllers.values()].map(c => c.shutdown())); }
}
