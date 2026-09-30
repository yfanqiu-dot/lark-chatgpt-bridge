import type { DesktopConfig } from './config';
import { DesktopBackend, UncertainExecution, type Approval } from './backend';
import { DesktopLedger, type MessageRecord } from './ledger';

export interface InboundMessage { messageId: string; chatId: string; senderId: string; content: string; mentionedBot: boolean; isBot?: boolean; replyInThread: boolean }
export interface ReplyPort {
  send(chatId: string, text: string, replyTo: string, replyInThread: boolean): Promise<string>;
  approval(chatId: string, request: Approval, replyTo: string, replyInThread: boolean): Promise<void>;
  resolved(token: string): Promise<void>;
  cardStatus?(chatId: string): { closing: number; unknown: number };
}
export class DesktopController {
  private intake: Promise<void> = Promise.resolve();
  private worker?: Promise<void>;
  private shuttingDown = false;
  private activeMessage?: string;
  private status = '就绪';
  private recoveryAttempted = new Set<string>();
  constructor(readonly config: DesktopConfig, readonly ledger: DesktopLedger, private readonly backend: DesktopBackend, private readonly replies: ReplyPort) {}
  async start(): Promise<void> {
    await this.ledger.load();
    // Recover results persisted before the first send attempt, never replay an ambiguous send.
    for (const row of this.ledger.all()) await this.deliver(row);
    this.kick();
  }
  receive(msg: InboundMessage): Promise<void> {
    const operation = this.intake.then(() => this.handle(msg));
    this.intake = operation.catch(() => {}); return operation;
  }
  private async handle(msg: InboundMessage): Promise<void> {
    if (this.shuttingDown || msg.chatId !== this.config.chatId || msg.senderId !== this.config.ownerOpenId || msg.isBot || (this.config.requireMention && !msg.mentionedBot)) return;
    if (!msg.messageId || !msg.content.trim() || this.ledger.get(msg.messageId)) return;
    const prompt = msg.content.trim();
    if (prompt.startsWith('/')) {
      await this.ledger.add({ messageId: msg.messageId, prompt, replyInThread: msg.replyInThread, state: 'completed' });
      let response: string;
      try { response = await this.command(prompt); } catch (e) { response = `操作未完成：${String(e)}`; }
      await this.ledger.update(msg.messageId, { result: response });
      await this.deliver(this.ledger.get(msg.messageId)!); return;
    }
    if (this.ledger.all().filter(r => r.state === 'queued').length >= this.config.maxQueue) {
      await this.replies.send(msg.chatId, '排队已满，请稍后重试。', msg.messageId, msg.replyInThread); return;
    }
    await this.ledger.add({ messageId: msg.messageId, prompt, replyInThread: msg.replyInThread, state: 'queued' });
    this.kick();
  }
  private async command(text: string): Promise<string> {
    const [name, ...args] = text.split(/\s+/);
    switch (name) {
      case '/status': {
        const cards = this.replies.cardStatus?.(this.config.chatId);
        return `项目：${this.config.projectRoot}\n对话：${this.config.threadId}\n状态：${this.status}\n排队：${this.ledger.all().filter(r => r.state === 'queued').length}\n待核对：${this.ledger.all().filter(r => r.state === 'uncertain').length}\n回传待核对：${this.ledger.all().filter(r => r.deliveryAttempted && !r.receipt).length}\n审批：${this.backend.pendingApprovals().map(a => `${a.token}${a.submitted ? '（等待服务端确认）' : ''}`).join(', ') || '无'}${cards ? `\n审批卡片待关闭：${cards.closing}\n审批卡片回执不明：${cards.unknown}` : ''}`;
      }
      case '/stop':
        if (!this.activeMessage) return '当前没有飞书发起的运行；桌面其他工作不受影响。';
        await this.backend.stop(); return '已请求停止当前对话轮次，等待服务端确认；排队中的请求仍保留。已经启动的外部命令可能继续运行。';
      case '/steer':
        if (!args.length) return '用法：/steer 追加指令';
        await this.backend.steer(args.join(' ')); return '追加指令已提交到当前运行。';
      case '/approve':
        if (args.length !== 2) return '用法：/approve 审批编号 accept|decline|cancel';
        await this.backend.decide(args[0]!, args[1]!); return '决定已提交，等待服务端确认。';
      case '/result': {
        const row = args[0] ? this.ledger.get(args[0]) : this.ledger.all().reverse().find(r => !r.prompt.startsWith('/') && r.result);
        return row?.result ?? '没有已保存的结果。';
      }
      case '/reconcile': {
        if (this.worker) return '当前正在处理任务，请稍后核对。';
        const row = this.ledger.all().find(r => r.state === 'uncertain');
        if (!row) return '没有待核对任务。';
        if (!row.turnId && !row.queueClientId) return '提交响应丢失，尚无turnId。请在桌面核对执行情况；不会自动重发该请求。';
        this.launch(row, row.turnId, Boolean(row.queueClientId && !row.turnId));
        return '正在按原消息标识核对队列或轮次，不会重新提交任务。';
      }
      default: return '可用命令：/status、/stop、/steer 指令、/approve 编号 决定、/result [消息编号]、/reconcile。新建话题请在配置的入口群使用 /topic new。';
    }
  }
  async decideFromCard(chatId: string, operator: string, token: string, decision: string): Promise<void> {
    if (chatId !== this.config.chatId || operator !== this.config.ownerOpenId) throw new Error('无权处理此审批');
    await this.backend.decide(token, decision);
  }
  private kick(): void {
    if (this.worker || this.shuttingDown) return;
    const uncertain = this.ledger.all().find(r => r.state === 'uncertain');
    if (uncertain) {
      // One recovery attempt per known turn per process. Never replay turn/start.
      if ((uncertain.turnId || uncertain.queueClientId) && !this.recoveryAttempted.has(uncertain.messageId)) this.launch(uncertain, uncertain.turnId, Boolean(uncertain.queueClientId && !uncertain.turnId));
      else this.status = '存在待核对任务，暂停新请求；可使用 /reconcile';
      return;
    }
    const row = this.ledger.all().find(r => r.state === 'queued'); if (!row) return;
    this.launch(row);
  }
  private launch(row: MessageRecord, turnId?: string, recoverQueued = false): void {
    if (turnId || recoverQueued) this.recoveryAttempted.add(row.messageId);
    this.worker = this.runRow(row, turnId, recoverQueued).catch(e => { this.status = `存储或回复失败，已暂停：${String(e)}`; this.shuttingDown = true; }).finally(() => { this.worker = undefined; this.kick(); });
  }
  private async runRow(row: MessageRecord, resumeTurnId?: string, recoverQueued = false): Promise<void> {
    this.activeMessage = row.messageId; this.status = '正在连接桌面';
    try {
      const result = await this.backend.execute(row.prompt, {
        submitting: () => this.ledger.update(row.messageId, { state: 'submitting', queueClientId: row.messageId }),
        accepted: queueSubmissionId => this.ledger.update(row.messageId, { queueSubmissionId }),
        started: turnId => this.ledger.update(row.messageId, { state: 'running', turnId }),
        state: async status => { this.status = status; },
        approval: request => this.replies.approval(this.config.chatId, request, row.messageId, row.replyInThread),
        resolved: token => this.replies.resolved(token),
      }, resumeTurnId, row.messageId, Boolean(row.queueClientId) || recoverQueued);
      await this.ledger.update(row.messageId, { state: result.status, turnId: result.turnId, result: result.text,
        ...(resumeTurnId || recoverQueued ? { receipt: undefined, deliveryAttempted: false, error: undefined } : {}) });
      this.status = result.status === 'completed' ? '已完成' : result.status === 'interrupted' ? '已停止' : '失败';
    } catch (e) {
      const uncertain = e instanceof UncertainExecution;
      this.status = uncertain ? '执行状态待核对，未重试' : '失败';
      await this.ledger.update(row.messageId, { state: uncertain ? 'uncertain' : 'failed', error: String(e), result: `${this.status}：${String(e)}` });
    } finally { this.activeMessage = undefined; }
    await this.deliver(this.ledger.get(row.messageId)!);
  }
  private async deliver(row: MessageRecord): Promise<void> {
    if (!row.result || row.receipt || row.deliveryAttempted) return;
    await this.ledger.update(row.messageId, { deliveryAttempted: true });
    try {
      const receipt = await this.replies.send(this.config.chatId, row.result, row.messageId, row.replyInThread);
      if (!receipt) throw new Error('Missing Feishu receipt');
      await this.ledger.update(row.messageId, { receipt });
    } catch (e) {
      await this.ledger.update(row.messageId, { error: `回传结果待核对：${String(e)}；使用 /result 读取已保存结果` });
      this.status = '结果已保存，回传待核对；可使用 /result';
    }
  }
  async idle(): Promise<void> { await this.intake; while (this.worker) await this.worker; }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await this.intake;
    const timer = setTimeout(() => this.backend.disconnect(), 20_000);
    try { await this.backend.stop().catch(() => {}); await this.worker; }
    finally { clearTimeout(timer); this.backend.disconnect(); }
  }
}
