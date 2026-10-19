/** Native Windows boot evidence. The machine identifier is hashed at source. */
export interface SystemBootProof {
  version:1; machineSha256:string; bootedAt:string; observedAt:number;
}
export function validSystemBoot(value:any):value is SystemBootProof {
  return value?.version===1 && /^[a-f0-9]{64}$/.test(value.machineSha256)
    && typeof value.bootedAt==='string' && /Z$/.test(value.bootedAt)
    && Number.isFinite(Date.parse(value.bootedAt)) && Number.isSafeInteger(value.observedAt)
    && Date.parse(value.bootedAt)>0 && Date.parse(value.bootedAt)<=value.observedAt;
}
export function freshSystemBoot(value:any,now=Date.now()):value is SystemBootProof {
  return validSystemBoot(value) && value.observedAt<=now+1000 && now-value.observedAt<=60_000;
}
export function sameSystemBoot(a:SystemBootProof,b:SystemBootProof){
  return validSystemBoot(a) && validSystemBoot(b) && a.machineSha256===b.machineSha256
    && Date.parse(a.bootedAt)===Date.parse(b.bootedAt);
}
export function laterSystemBoot(previous:SystemBootProof,current:SystemBootProof){
  return validSystemBoot(previous) && freshSystemBoot(current) && previous.machineSha256===current.machineSha256
    && Date.parse(current.bootedAt)>previous.observedAt;
}
