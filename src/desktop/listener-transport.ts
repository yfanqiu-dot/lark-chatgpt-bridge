import {createHash} from 'node:crypto';

export const LISTENER_RECONNECT_MS=180_000;
export const LISTENER_STABLE_MS=5_000;
const states=['connected','connecting','reconnecting','disconnected','failed','unknown'] as const;
export type TransportState=typeof states[number];
export interface TransportSnapshot {
  state:TransportState; phase:'ready'|'reconnecting'|'failed';
  disconnectedSince?:number; reconnectAttempts?:number; lastConnectTime?:number; nextConnectTime?:number;
  lastErrorSha256?:string;
  transitions:Array<{at:number;state:TransportState}>;
}
/** One transport, one fixed outage budget. Does not restart a listener or replay inputs. */
export class ListenerTransport {
  private since?:number;
  private stableSince?:number;
  private closed=false;
  private timedOut=false;
  private lastState?:TransportState;
  private transitions:TransportSnapshot['transitions']=[];
  private errorHash?:string;
  constructor(private readonly status:()=>{state:string;reconnectAttempts?:number;lastConnectTime?:number;nextConnectTime?:number}|undefined,
    private readonly now=Date.now,private readonly pause=()=>new Promise<void>(r=>setTimeout(r,100))){}
  recordError(error:unknown){this.errorHash=createHash('sha256').update(error instanceof Error?error.message:'NonError').digest('hex');}
  snapshot():TransportSnapshot{
    const raw=this.status(),now=this.now();
    const state:TransportState=raw&&states.includes(raw.state as TransportState)?raw.state as TransportState:'unknown';
    if(state!==this.lastState){this.transitions.push({at:now,state});this.transitions=this.transitions.slice(-32);this.lastState=state;}
    if(state!=='connected'){this.since??=now;this.stableSince=undefined;}
    if(this.since!==undefined&&now-this.since>=LISTENER_RECONNECT_MS)this.timedOut=true;
    if(state==='connected'&&this.since!==undefined&&!this.timedOut){this.stableSince??=now;if(now-this.stableSince>=LISTENER_STABLE_MS){this.since=undefined;this.stableSince=undefined;}}
    const numbers:Partial<TransportSnapshot>={};
    for(const key of ['reconnectAttempts','lastConnectTime','nextConnectTime'] as const){const v=raw?.[key];if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)numbers[key]=v;}
    return {state,phase:this.timedOut||state==='failed'||state==='unknown'?'failed':this.since!==undefined?'reconnecting':'ready',
      ...(this.since!==undefined?{disconnectedSince:this.since}:{}),...numbers,...(this.errorHash?{lastErrorSha256:this.errorHash}:{}),transitions:[...this.transitions]};
  }
  async waitReady(cancelled=()=>false):Promise<void>{
    for(;;){
      if(this.closed||cancelled())throw Error('Listener transport wait cancelled before submission');
      const s=this.snapshot();
      if(s.phase==='failed')throw Error('Listener transport unavailable before submission');
      if(s.disconnectedSince!==undefined&&this.now()-s.disconnectedSince>=LISTENER_RECONNECT_MS)throw Error('Listener transport recovery deadline exceeded before submission');
      if(s.phase==='ready')return;
      await this.pause();
    }
  }
  close(){this.closed=true;}
}
