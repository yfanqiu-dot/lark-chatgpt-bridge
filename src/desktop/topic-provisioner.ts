import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TopicConfig, TopicProject, TopicRecord } from './topics';
import { TopicRegistry } from './topics';

export interface TopicResources {
  verifyProject(project: TopicProject): Promise<void>;
  createThread(project: TopicProject, title: string, saveId: (threadId: string) => Promise<void>): Promise<string>;
  verifyThread(project: TopicProject, threadId: string): Promise<void>;
  nameThread(threadId: string, title: string): Promise<void>;
  createChat(title: string, ownerOpenId: string): Promise<string>;
  verifyChat(chatId: string, ownerOpenId: string): Promise<void>;
}

/** Recover known IDs; never repeat an irreversible call with an unknown result. */
export class TopicProvisioner {
  private inflight = new Map<string, Promise<TopicRecord>>();
  constructor(readonly config: TopicConfig, readonly registry: TopicRegistry, readonly resources: TopicResources) {}
  create(requestId: string, projectKey: string, title: string): Promise<TopicRecord> {
    const running = this.inflight.get(requestId); if (running) return running;
    const task = this.run(requestId, projectKey, title).finally(() => this.inflight.delete(requestId));
    this.inflight.set(requestId, task); return task;
  }
  async attachKnownThread(requestId: string, threadId: string): Promise<TopicRecord> {
    const row = this.registry.byRequest(requestId);
    if (!row || !['thread_creating','thread_initializing'].includes(row.stage) || !/^[\w-]+$/.test(threadId) || (row.threadId && row.threadId !== threadId)) throw new Error('No thread creation awaiting reconciliation');
    const project = this.config.projects.find(p => p.key === row.projectKey);
    if (!project || project.projectId !== row.projectId || resolve(project.projectRoot) !== resolve(row.projectRoot)) throw new Error('Saved project binding changed');
    await this.resources.verifyThread(project, threadId);
    return this.registry.advance(requestId, 'thread_ready', {threadId});
  }
  async attachKnownChat(requestId: string, chatId: string): Promise<TopicRecord> {
    const row = this.registry.byRequest(requestId);
    if (!row || row.stage !== 'chat_creating' || !/^oc_[a-zA-Z0-9]+$/.test(chatId)) throw new Error('No group creation awaiting reconciliation');
    await this.resources.verifyChat(chatId, this.config.ownerOpenId);
    return this.registry.advance(requestId, 'chat_ready', {chatId});
  }
  private async run(requestId: string, projectKey: string, title: string): Promise<TopicRecord> {
    if (!requestId) throw new Error('Missing source message ID');
    const project = this.config.projects.find(p => p.key === projectKey);
    if (!project) throw new Error(`未知项目：${projectKey}。可选：${this.config.projects.map(p => p.key).join('、')}`);
    if (!title.trim() || [...title].length > 60) throw new Error('话题名称须为 1–60 个字符');
    const existing = this.registry.byRequest(requestId);
    if (existing && (existing.projectKey !== projectKey || existing.title !== title)) throw new Error('同一消息的创建参数已改变');
    if (existing && (existing.projectId !== project.projectId || resolve(existing.projectRoot) !== resolve(project.projectRoot))) throw new Error('已保存的话题项目绑定与配置不符');
    if (existing?.stage === 'active') return existing;
    await this.resources.verifyProject(project);
    let row = existing;
    if (!row) {
      const now = new Date().toISOString();
      row = await this.registry.add({ requestId, title, projectKey, projectId: project.projectId, projectRoot: project.projectRoot, stage: 'planned', createdAt: now, updatedAt: now });
    }
    if (row.stage === 'thread_creating' || row.stage === 'thread_initializing' || row.stage === 'chat_creating') throw new Error(`创建结果待人工核对（${row.stage}）；不会重试可能已成功的创建调用`);
    if (row.stage === 'planned') {
      row = await this.registry.advance(requestId, 'thread_creating');
      const threadId = await this.resources.createThread(project, title, async id => {
        if (!id) throw new Error('Desktop task ID missing; creation must be reconciled');
        row = await this.registry.advance(requestId, 'thread_initializing', { threadId: id });
      });
      if (!threadId) throw new Error('Desktop task ID missing; creation must be reconciled');
      if (row.stage !== 'thread_initializing' || row.threadId !== threadId) throw new Error('Desktop task ID was not saved before connection close');
      row = await this.registry.advance(requestId, 'thread_ready');
    }
    if (!row.threadId) throw new Error('Topic has no saved desktop task ID');
    await this.resources.verifyThread(project, row.threadId);
    if (row.stage === 'thread_ready') {
      await this.resources.nameThread(row.threadId, title);
      row = await this.registry.advance(requestId, 'chat_creating');
      const chatId = await this.resources.createChat(title, this.config.ownerOpenId);
      if (!/^oc_[a-zA-Z0-9]+$/.test(chatId)) throw new Error('Feishu chat ID missing; creation must be reconciled');
      row = await this.registry.advance(requestId, 'chat_ready', { chatId });
    }
    if (!row.chatId) throw new Error('Topic has no saved Feishu chat ID');
    await this.resources.verifyChat(row.chatId, this.config.ownerOpenId);
    if (row.stage !== 'active') row = await this.registry.advance(requestId, 'active');
    return row;
  }
}

export function assertProjectThread(thread: any, project: TopicProject, root: string): void {
  if (!thread || typeof thread.id !== 'string' || thread.projectId !== project.projectId || typeof thread.cwd !== 'string' || resolve(thread.cwd) !== resolve(root)) throw new Error('Desktop task/project/root mismatch');
}

export async function verifiedProjectRoot(project: TopicProject): Promise<string> { return realpath(project.projectRoot); }
