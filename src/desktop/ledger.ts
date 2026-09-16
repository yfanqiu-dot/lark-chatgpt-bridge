import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export type DeliveryState = 'queued' | 'submitting' | 'running' | 'completed' | 'interrupted' | 'failed' | 'uncertain';
export interface MessageRecord {
  messageId: string; prompt: string; replyInThread: boolean; state: DeliveryState;
  turnId?: string; result?: string; receipt?: string; deliveryAttempted?: boolean; error?: string;
}
export interface Binding { appId: string; chatId: string; ownerOpenId: string; projectId: string; projectRoot: string; threadId: string }
export class DesktopLedger {
  private rows: MessageRecord[] = [];
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly path: string, readonly binding: Binding) {}
  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.version !== 1 || JSON.stringify(saved.binding) !== JSON.stringify(this.binding) || !Array.isArray(saved.messages)) throw new Error('Ledger binding/version mismatch');
      const ids = new Set<string>();
      for (const row of saved.messages) {
        if (!row || typeof row.messageId !== 'string' || ids.has(row.messageId) || typeof row.prompt !== 'string' || !['queued','submitting','running','completed','interrupted','failed','uncertain'].includes(row.state)) throw new Error('Malformed ledger');
        ids.add(row.messageId);
      }
      this.rows = saved.messages;
      for (const row of this.rows) if (row.state === 'submitting' || row.state === 'running') row.state = 'uncertain';
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    await this.save();
  }
  all(): MessageRecord[] { return structuredClone(this.rows); }
  get(id: string): MessageRecord | undefined { return this.all().find(r => r.messageId === id); }
  async add(record: MessageRecord): Promise<boolean> {
    if (this.rows.some(r => r.messageId === record.messageId)) return false;
    this.rows.push(structuredClone(record)); await this.save(); return true;
  }
  async update(id: string, patch: Partial<Omit<MessageRecord, 'messageId'>>): Promise<void> {
    const row = this.rows.find(r => r.messageId === id); if (!row) throw new Error('Unknown message');
    Object.assign(row, patch); await this.save();
  }
  private save(): Promise<void> {
    const data = JSON.stringify({ version: 1, binding: this.binding, messages: this.rows }, null, 2);
    // Failed persistence stops subsequent writes and therefore all new work.
    this.writes = this.writes.then(() => writeFileAtomic(this.path, data)); return this.writes;
  }
}
