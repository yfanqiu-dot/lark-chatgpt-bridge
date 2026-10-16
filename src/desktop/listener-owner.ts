import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {sameProcess} from './supervisor';
import type {BrokerOwnerProof} from './broker-lease';

/** Detached Windows listeners must stop when the original supervisor's bounded
 * lease is unavailable. Never renew it, accept a replacement, or restart work. */
export class ListenerOwnerLease {
  private previous?:BrokerOwnerProof;
  constructor(readonly path:string,private readonly runId:string,private readonly now=Date.now,
    private readonly alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}}){
    if(!isAbsolute(path)||!/^[a-f0-9-]{36}$/.test(runId))throw new Error('Invalid listener owner lease');
  }
  async assert():Promise<void>{
    let p:BrokerOwnerProof;
    try{p=JSON.parse(await readFile(this.path,'utf8'));}catch{throw new Error('Listener owner lease unavailable');}
    const now=this.now(),old=this.previous;
    if(!p||p.version!==1||p.runId!==this.runId||!sameProcess(p.owner,p.owner)
      ||!/^OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0$/.test(p.packageFullName)||!/^[a-f0-9]{64}$/.test(p.tokenSha256)
      ||!Number.isSafeInteger(p.revision)||p.revision<0||!Number.isSafeInteger(p.expiresAt)||p.expiresAt<=now||p.expiresAt>now+30_000
      ||!this.alive(p.owner.pid)||old&&(!sameProcess(p.owner,old.owner)||p.packageFullName!==old.packageFullName||p.tokenSha256!==old.tokenSha256
        ||p.revision<old.revision||p.expiresAt<old.expiresAt||p.revision===old.revision&&p.expiresAt!==old.expiresAt))throw new Error('Listener owner lease lost');
    // Only the public identity fields; no arbitrary lease properties retained.
    this.previous={version:1,runId:p.runId,owner:{pid:p.owner.pid,parentPid:p.owner.parentPid,createdAt:p.owner.createdAt,executable:p.owner.executable,commandLineSha256:p.owner.commandLineSha256},packageFullName:p.packageFullName,tokenSha256:p.tokenSha256,revision:p.revision,expiresAt:p.expiresAt};
  }
}
