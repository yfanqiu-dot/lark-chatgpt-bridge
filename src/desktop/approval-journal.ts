import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from '../platform/atomic-write';
import type { Approval } from './backend';

interface CardRecord {
  token: string;
  chatId: string;
  messageId?: string;
  state: 'sending' | 'open' | 'closing' | 'closed' | 'unknown';
}
export interface ApprovalCardPort {
  send(chatId: string, request: Approval, replyTo: string, replyInThread: boolean): Promise<string>;
  close(messageId: string): Promise<void>;
}

/** Persist receipts, never decisions. A card from a previous process is stale.
 * Only idempotent closing updates are retried; ambiguous sends are not replayed.
 * The caller holds the bridge's application and registry/state locks.
 */
export class ApprovalJournal {
  private records: CardRecord[] = [];
  private writes: Promise<void> = Promise.resolve();
  private flushing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  constructor(readonly path: string, private readonly binding: unknown, private readonly port: ApprovalCardPort,
    private readonly retryMs = 5_000, private readonly enabledChatIds?: readonly string[]) {}

  private enabled(chatId: string): boolean { return this.enabledChatIds === undefined || this.enabledChatIds.includes(chatId); }

  async start(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (saved.version !== 1 || JSON.stringify(saved.binding) !== JSON.stringify(this.binding) || !Array.isArray(saved.cards)) throw new Error('Approval journal binding/version mismatch');
      const tokens = new Set<string>();
      for (const card of saved.cards) {
        if (!card || typeof card.token !== 'string' || tokens.has(card.token) || typeof card.chatId !== 'string'
          || !['sending', 'open', 'closing', 'closed', 'unknown'].includes(card.state)
          || (card.messageId !== undefined && (typeof card.messageId !== 'string' || !card.messageId))
          || (['open', 'closing', 'closed'].includes(card.state) && !card.messageId)) throw new Error('Malformed approval journal');
        tokens.add(card.token);
      }
      this.records = saved.cards;
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    for (const card of this.records) if (this.enabled(card.chatId) && card.state !== 'closed') card.state = card.messageId ? 'closing' : 'unknown';
    await this.save();
    const retry = () => { void this.flush().catch(e => console.error('Approval journal persistence failed:', String(e))); };
    // A Feishu outage must not hold up all group controllers at startup.
    this.timer = setInterval(retry, this.retryMs);
    this.timer.unref();
    retry();
  }

  async publish(chatId: string, request: Approval, replyTo: string, replyInThread: boolean): Promise<void> {
    if (this.stopping) throw new Error('Approval journal is shutting down');
    if (!this.enabled(chatId)) throw new Error('Approval chat is outside rollout scope');
    if (this.records.some(c => c.token === request.token)) throw new Error('Approval card send already attempted');
    const card: CardRecord = { token: request.token, chatId, state: 'sending' };
    this.records.push(card);
    await this.save();
    try {
      const messageId = await this.port.send(chatId, request, replyTo, replyInThread);
      if (!messageId) throw new Error('Approval card receipt missing');
      card.messageId = messageId;
      card.state = 'open';
      await this.save();
    } catch (e) {
      // A known receipt can still be closed if persisting it failed in this process.
      card.state = card.messageId ? 'closing' : 'unknown';
      await this.save();
      throw e;
    }
  }

  async resolved(token: string): Promise<void> {
    const card = this.records.find(c => c.token === token);
    if (!card || !this.enabled(card.chatId) || card.state === 'closed' || !card.messageId) return;
    card.state = 'closing';
    await this.save();
    await this.flush();
  }

  pending(chatId?: string): { closing: number; unknown: number } {
    const cards = this.records.filter(c => this.enabled(c.chatId) && (chatId === undefined || c.chatId === chatId));
    return { closing: cards.filter(c => c.state === 'closing').length, unknown: cards.filter(c => c.state === 'unknown').length };
  }

  flush(): Promise<void> {
    if (this.stopping) return this.flushing ?? Promise.resolve();
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      for (const card of this.records.filter(c => this.enabled(c.chatId) && c.state === 'closing')) {
        if (this.stopping) break;
        try { await this.port.close(card.messageId!); }
        catch { continue; } // Retain durable closing intent for the next retry/restart.
        card.state = 'closed';
        await this.save();
      }
    })().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  async shutdown(): Promise<void> { this.stopping = true; clearInterval(this.timer); await this.flushing; await this.writes; }
  private save(): Promise<void> {
    const data = JSON.stringify({ version: 1, binding: this.binding, cards: this.records }, null, 2);
    this.writes = this.writes.then(() => writeFileAtomic(this.path, data));
    return this.writes;
  }
}
