import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeFileAtomic } from '../platform/atomic-write';
import { DesktopRpc } from './rpc';
import type { TopicConfig, TopicRecord } from './topics';
import { TopicRegistry } from './topics';
import { assertProjectThread } from './topic-provisioner';
import { TOPIC_BOOTSTRAP_PROMPT } from './topic-resources';

function itemText(item: any): string {
  if (typeof item.text === 'string') return item.text;
  if (!Array.isArray(item.content)) return '';
  return item.content.filter((x: any) => x?.type === 'text' && typeof x.text === 'string').map((x: any) => x.text).join('\n');
}
function quote(text: string): string { return text.split('\n').map(line => `> ${line}`).join('\n'); }

/** Human-readable local projection of native history; native desktop history remains authoritative. */
export class TopicArchive {
  private writes = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(readonly config: TopicConfig, readonly registry: TopicRegistry,
    private readonly rpcFactory: () => DesktopRpc = () => new DesktopRpc(config.endpoint)) {}
  async sync(row: TopicRecord): Promise<void> {
    if (this.stopping) throw new Error('Topic archive is shutting down');
    if (row.stage !== 'active' || !row.threadId || !row.chatId) throw new Error('Only active topics can be archived');
    const project = this.config.projects.find(p => p.key === row.projectKey);
    if (!project || project.projectId !== row.projectId || resolve(project.projectRoot) !== resolve(row.projectRoot)) throw new Error('Archive project binding mismatch');
    const prior = this.writes.get(project.key) ?? Promise.resolve();
    const work = prior.then(() => this.writeTopic(row, project));
    this.writes.set(project.key, work.catch(() => {})); await work;
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all(this.writes.values());
  }
  private async writeTopic(row: TopicRecord, project: {key:string;projectId:string;projectRoot:string}): Promise<void> {
    const root = await realpath(project.projectRoot);
    const rpc = this.rpcFactory();
    const lines = [`# ${row.title}`, '', `- 飞书群：${row.chatId}`, `- Codex 对话：${row.threadId}`, `- 项目：${project.key}`, `- 同步时间：${new Date().toISOString()}`, '- 范围：已持久化的用户文字和最终答复；不包含未完成轮次、工具细节或附件。', ''];
    try {
      await rpc.connect();
      const read = await rpc.call('thread/read', { threadId: row.threadId, includeTurns: false });
      assertProjectThread(read.thread, project, root);
      if (read.thread.id !== row.threadId) throw new Error('Archive desktop task ID mismatch');
      let cursor: string | undefined; const seen = new Set<string>(); const turns: any[] = [];
      do {
        const page = await rpc.call('thread/turns/list', { threadId: row.threadId, limit: 50, itemsView: 'notLoaded', ...(cursor ? {cursor} : {}) });
        if (!Array.isArray(page.data)) throw new Error('Invalid desktop turn page');
        turns.push(...page.data);
        cursor = page.nextCursor ?? undefined;
        if (cursor && seen.has(cursor)) throw new Error('Repeated desktop turn cursor');
        if (cursor) seen.add(cursor);
      } while (cursor);
      turns.reverse();
      for (const turn of turns) {
        if (!turn?.id || turn.completedAt == null) continue;
        let itemCursor: string | undefined; const seenItems = new Set<string>(); const items: any[] = [];
        do {
          const page = await rpc.call('thread/items/list', { threadId: row.threadId, turnId: turn.id, limit: 100, sortDirection: 'asc', ...(itemCursor ? {cursor:itemCursor} : {}) });
          if (!Array.isArray(page.data)) throw new Error('Invalid desktop item page');
          for (const entry of page.data) { if (entry.turnId !== turn.id || !entry.item) throw new Error('Item belongs to another turn'); items.push(entry.item); }
          itemCursor = page.nextCursor ?? undefined;
          if (itemCursor && seenItems.has(itemCursor)) throw new Error('Repeated desktop item cursor');
          if (itemCursor) seenItems.add(itemCursor);
        } while (itemCursor);
        const user = items.filter(i => i.type === 'userMessage').map(itemText).filter(Boolean).join('\n\n');
        if (user === TOPIC_BOOTSTRAP_PROMPT) continue;
        const answer = items.filter(i => i.type === 'agentMessage' && i.phase === 'final_answer').map(itemText).filter(Boolean).join('\n\n');
        lines.push(`## 轮次 ${turn.id}`, '', `状态：${turn.status ?? 'unknown'}`, '');
        if (user) lines.push('**用户**', '', quote(user), '');
        if (answer) lines.push('**Codex**', '', quote(answer), '');
        if (!user && !answer) lines.push('_该轮次没有可导出的文字。_', '');
      }
    } finally { rpc.close(); }
    const base = join(root, '.lark-chatgpt-bridge');
    await mkdir(join(base, 'topics'), {recursive:true});
    await writeFileAtomic(join(base, '.gitignore'), '*\n');
    await writeFileAtomic(join(base, 'topics', `${row.chatId}.md`), `${lines.join('\n')}\n`);
    const rows = this.registry.all().filter(r => r.stage === 'active' && r.projectId === project.projectId);
    const index = [`# ${project.key} · 飞书与 Codex 对话索引`, '', `同步时间：${new Date().toISOString()}`, '', '| 话题 | 飞书群 | Codex 对话 | 记录 |', '| --- | --- | --- | --- |',
      ...rows.map(r => `| ${r.title.replaceAll('|','\\|')} | ${r.chatId} | ${r.threadId} | [打开](topics/${r.chatId}.md) |`), ''];
    await writeFileAtomic(join(base, 'index.md'), index.join('\n'));
  }
}
