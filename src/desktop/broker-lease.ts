import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import lockfile from 'proper-lockfile';
import { sameProcess, type ProcessIdentity } from './supervisor';
import { writeFileAtomic } from '../platform/atomic-write';

export interface BrokerOwnerProof {
  version: 1; runId: string; owner: ProcessIdentity; packageFullName: string;
  tokenSha256: string; revision: number; expiresAt: number;
}
/** The ephemeral broker capability is hashed in this public lease. It is not
 * an account credential, and its original value is never written here. */
export class BrokerOwnerLease {
  private release?: () => Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private proof?: BrokerOwnerProof;
  private writes: Promise<void> = Promise.resolve();
  private closing = false;
  private lost = false;
  constructor(readonly path: string, private readonly now = Date.now, private readonly ttlMs = 15_000) {
    if (!isAbsolute(path) || !Number.isSafeInteger(ttlMs) || ttlMs < 5000 || ttlMs > 30_000) throw new Error('Invalid broker lease path or TTL');
  }
  async open(runId: string, owner: ProcessIdentity, packageFullName: string, token: string): Promise<void> {
    if (this.release || !/^[a-f0-9-]{36}$/.test(runId) || !sameProcess(owner,owner) || !/^OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0$/.test(packageFullName) || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid broker lease identity');
    this.release = await lockfile.lock(this.path, { realpath: false, retries: 0, stale: 10_000 });
    try {
      this.closing = false; this.lost = false;
      this.proof = { version: 1, runId, owner: structuredClone(owner), packageFullName, tokenSha256: createHash('sha256').update(token).digest('hex'), revision: 0, expiresAt: this.now() + this.ttlMs };
      await writeFile(this.path, JSON.stringify(this.proof), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch (e) { const release = this.release; this.release = undefined; this.proof = undefined; await release(); throw e; }
  }
  async renew(): Promise<void> {
    const update = this.writes.then(async () => {
      if (!this.release || !this.proof || this.closing) throw new Error('Broker lease is not owned');
      const current: BrokerOwnerProof = JSON.parse(await readFile(this.path,'utf8'));
      if (current.version !== 1 || current.runId !== this.proof.runId || !sameProcess(current.owner,this.proof.owner) || current.packageFullName !== this.proof.packageFullName || current.tokenSha256 !== this.proof.tokenSha256 || current.revision !== this.proof.revision || current.expiresAt !== this.proof.expiresAt) throw new Error('Broker lease changed');
      if (current.expiresAt <= this.now()) throw new Error('Broker lease expired; draining cannot be reversed');
      const next = { ...this.proof, revision: this.proof.revision + 1, expiresAt: this.now() + this.ttlMs };
      await writeFileAtomic(this.path,JSON.stringify(next)); this.proof = next;
    });
    this.writes = update.catch(() => {}); await update;
  }
  startHeartbeat(onLost: () => void): void {
    if (!this.release || this.timer) throw new Error('Broker heartbeat cannot start');
    this.timer = setInterval(() => { void this.renew().catch(() => { if (this.timer) clearInterval(this.timer); this.timer = undefined; if (!this.closing && !this.lost) { this.lost = true; onLost(); } }); }, Math.floor(this.ttlMs / 3));
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    await this.writes;
    try {
      if (this.release && this.proof) {
        const current: BrokerOwnerProof = JSON.parse(await readFile(this.path,'utf8'));
        // Never overwrite a changed or foreign lease while closing.
        if (current.runId === this.proof.runId && sameProcess(current.owner,this.proof.owner) && current.revision === this.proof.revision && current.tokenSha256 === this.proof.tokenSha256 && current.packageFullName === this.proof.packageFullName && current.expiresAt === this.proof.expiresAt) await writeFileAtomic(this.path,JSON.stringify({ ...this.proof, revision: this.proof.revision + 1, expiresAt: this.now() }));
      }
    } finally { const release = this.release; this.release = undefined; this.proof = undefined; await release?.(); }
  }
}
