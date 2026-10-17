import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';

export type DeliveryState = 'queued' | 'submitting' | 'running' | 'completed' | 'interrupted' | 'failed' | 'uncertain';
export interface MessageRecord {
  messageId: string; prompt: string; replyInThread: boolean; state: DeliveryState;
  turnId?: string; queueClientId?: string; queueSubmissionId?: string;
  result?: string; receipt?: string; deliveryAttempted?: boolean; error?: string;
  /** Read-only native reconciliation preserves the original sent notice and
   * receipt. The recovered answer is returned only by an explicit /result. */
  reconciliation?: {version:1;priorState:'uncertain';nativeStatus:'completed'|'interrupted'|'failed';nativeTurnId:string;nativeResult:string;verifiedAt:number;evidenceSha256:string};
}
export function validateReconciliation(row: MessageRecord): void {
  const r=row.reconciliation;if(r===undefined)return;
  if(!r||r.version!==1||r.priorState!=='uncertain'||!['completed','interrupted','failed'].includes(r.nativeStatus)
    ||r.nativeStatus!==row.state||r.nativeTurnId!==row.turnId||typeof r.nativeTurnId!=='string'||!r.nativeTurnId
    ||typeof r.nativeResult!=='string'||!Number.isFinite(r.verifiedAt)||r.verifiedAt<=0||!/^[a-f0-9]{64}$/.test(r.evidenceSha256))throw new Error('Malformed native reconciliation');
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
        if (typeof row.replyInThread !== 'boolean'
          || ['turnId','queueClientId','queueSubmissionId','receipt'].some(key => row[key] !== undefined && typeof row[key] !== 'string')
          || ['result','error'].some(key => row[key] !== undefined && typeof row[key] !== 'string')
          || (row.deliveryAttempted !== undefined && typeof row.deliveryAttempted !== 'boolean')) throw new Error('Malformed ledger record');
        if (row.queueClientId !== undefined && row.queueClientId !== row.messageId) throw new Error('Ledger queue client identity mismatch');
        validateReconciliation(row);
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
