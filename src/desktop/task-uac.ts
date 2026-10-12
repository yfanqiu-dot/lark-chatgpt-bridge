import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {link,mkdir,readFile,unlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {verifyDeployment} from './deployment';
import {sameProcess,type ProcessIdentity} from './supervisor';
import {WindowsSupervisorControl} from './supervisor-windows';
import {windowsPowerShellEnvironment} from './windows-tools';

export type TaskUacAction='TaskPermissions'|'DisableTask'|'RestoreTask'|'StartLegacy';
const actions:TaskUacAction[]=['TaskPermissions','DisableTask','RestoreTask','StartLegacy'];
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const json=async(path:string)=>JSON.parse(await readFile(path,'utf8'));
const exec=promisify(execFile),sleep=(ms:number)=>new Promise<void>(done=>setTimeout(done,ms));
export function taskUacMac(token:string,payload:string){return createHmac('sha256',token).update(payload).digest('hex');}
export async function writeTaskUacNewFile(path:string,data:string){
  const temporary=`${path}.tmp-${randomUUID()}`;
  try{await writeFile(temporary,data,{encoding:'utf8',flag:'wx',mode:0o600});await link(temporary,path);}finally{await unlink(temporary).catch(()=>{});}
}
export function readTaskUacReport(raw:any,token:string,requestId:string,action:TaskUacAction){
  if(!raw || typeof raw.payload!=='string' || raw.payload.length>32_000 || typeof raw.mac!=='string' || !/^[a-f0-9]{64}$/.test(raw.mac)
    || !timingSafeEqual(Buffer.from(raw.mac,'hex'),Buffer.from(taskUacMac(token,raw.payload),'hex')))throw new Error('Task UAC response authentication failed');
  const r=JSON.parse(Buffer.from(raw.payload,'base64').toString('utf8'));
  if(r.version!==1 || r.requestId!==requestId || r.action!==action || !sameProcess(r.identity,r.identity)
    || !['ready','completed','blocked'].includes(r.phase))throw new Error('Task UAC response identity invalid');
  return r;
}
export interface TaskUacEffects {
  launch(args:string[]):Promise<void>;
  now():number;
  pause():Promise<void>;
}
/** One UAC confirmation per fixed task action. No elevated Node, desktop,
 * account credential, ACL editing or arbitrary command interface. */
export class TaskUacController {
  private readonly effects:TaskUacEffects;
  constructor(private readonly stage:string,private readonly directory:string,private readonly root:string,
    private readonly owner:ProcessIdentity,private readonly planId:string,private readonly deadline:number,
    private readonly control:WindowsSupervisorControl,effects?:TaskUacEffects,private readonly forwardDeadline=deadline){
    if(!sameProcess(owner,owner) || !/^[a-f0-9-]{36}$/.test(planId))throw new Error('Invalid task UAC owner');
    this.effects=effects??{now:Date.now,pause:()=>sleep(200),launch:async args=>{await exec('powershell.exe',args,{windowsHide:true,timeout:155_000,env:windowsPowerShellEnvironment(process.env),maxBuffer:64_000});}};
  }
  async call(action:TaskUacAction,backupDirectory?:string){
    const actionDeadline=['RestoreTask','StartLegacy'].includes(action)?this.deadline:this.forwardDeadline;
    if(!actions.includes(action) || actionDeadline<=this.effects.now())throw new Error('Task UAC action expired or unsupported');
    const input=await verifyDeployment(this.stage),helper=resolve(this.root,'bin/desktop-task-uac.ps1'),native=resolve(this.root,'bin/desktop-runtime-control.ps1');
    if(resolve(this.directory)!==resolve(input.host.connectionFile,'..'))throw new Error('Task UAC runtime location invalid');
    const helperProof=input.snapshot.files.find(f=>f.path===helper),nativeProof=input.snapshot.files.find(f=>f.path===native);
    if(!helperProof || !nativeProof)throw new Error('Task UAC programs are not pinned');
    const requestId=randomUUID(),directory=join(this.directory,`task-uac-${requestId}`);await mkdir(directory,{recursive:false});
    if(action!=='TaskPermissions')await writeFile(join(this.directory,`task-uac-${action}.intent.json`),JSON.stringify({version:1,requestId,action,planId:this.planId}),{encoding:'utf8',flag:'wx'});
    if(!backupDirectory){backupDirectory=join(directory,'baseline');await this.control.backupTask(backupDirectory);}
    const backup=await json(join(backupDirectory,'legacy-task.json'));
    const originalPermissions=await this.control.taskPermissions();
    const inventory=await this.control.inventory();
    let expectedBroker:ProcessIdentity|undefined;
    if(['RestoreTask','StartLegacy'].includes(action)&&(inventory.broker?.length??0)){
      const receipt=await json(join(this.directory,'broker.receipt.json'));
      if(inventory.broker.length!==1||receipt.version!==1||receipt.role!=='broker'||!sameProcess(receipt.identity,inventory.broker[0]!))throw new Error('Task UAC restoration broker ownership changed');
      expectedBroker=receipt.identity;
    }
    const token=randomBytes(32).toString('hex'),capabilityFile=join(directory,'capability.dpapi');
    await this.control.protectCapability(capabilityFile,token);
    const request={version:1,requestId,action,planId:this.planId,owner:this.owner,requestedAt:this.effects.now(),expiresAt:Math.min(this.effects.now()+120_000,actionDeadline),
      control:{version:1,desktopExe:input.host.desktopExe,legacy:input.snapshot.spec.legacy},backup:{...backup,xmlFile:join(backupDirectory,'legacy-task.xml')},
      legacy:inventory.legacy[0],expectedBroker,descriptorSha256:originalPermissions.descriptorSha256,
      helperFile:helper,helperSha256:helperProof.sha256,nativeFile:native,nativeSha256:nativeProof.sha256,
      files:input.snapshot.files,capabilityFile,directory};
    if(action==='DisableTask' && inventory.legacy.length!==1)throw new Error('Task UAC legacy identity unavailable');
    const requestFile=join(directory,'request.json'),data=JSON.stringify(request);await writeFile(requestFile,data,{encoding:'utf8',flag:'wx'});
    let launchError:unknown;const launched=this.effects.launch(['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',helper,'-Mode','Launch','-RequestFile',requestFile,'-RequestSha256',sha(data)]).catch(async e=>{
      launchError=e;const error=e as {code?:unknown;stderr?:unknown};const stderr=typeof error.stderr==='string'?error.stderr:'';
      await writeFile(join(directory,'launch.failure.json'),JSON.stringify({version:1,requestId,action,errorCode:'task_uac_launch_not_confirmed',exitCode:typeof error.code==='number'?error.code:null,stderrBytes:Buffer.byteLength(stderr),stderrSha256:sha(stderr)}),{encoding:'utf8',flag:'wx'}).catch(()=>{});
    });
    let ready:any,receipt:any;
    while(this.effects.now()<request.expiresAt){
      if(launchError)break;
      try{
        receipt=await json(join(directory,'native.json'));ready=readTaskUacReport(await json(join(directory,'ready.json')),token,requestId,action);
        if(receipt.version!==1 || receipt.requestId!==requestId || !sameProcess(receipt.identity,ready.identity) || ready.phase!=='ready'
          || Date.parse(receipt.identity.createdAt)<request.requestedAt-1000 || Date.parse(receipt.identity.createdAt)>this.effects.now()+1000)throw new Error('Task UAC native identity mismatch');
        break;
      }catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      await this.effects.pause();
    }
    if(!ready || !receipt || launchError)throw new Error('Task UAC consent or native identity not confirmed; do not repeat action');
    const grant=`go:${requestId}`;await writeTaskUacNewFile(join(directory,'go.json'),JSON.stringify({payload:grant,mac:taskUacMac(token,grant)}));
    await launched;
    if(launchError)throw new Error('Task UAC helper exit not confirmed; preserve response and do not repeat action');
    let report:any;
    try{report=readTaskUacReport(await json(join(directory,'result.json')),token,requestId,action);}catch{throw new Error('Task UAC result uncertain; do not repeat action');}
    if(!sameProcess(report.identity,receipt.identity) || report.phase!=='completed')throw new Error('Scoped administrator task action failed; inspect preserved evidence');
    if(action==='TaskPermissions'){
      const p=report.permissions;if(!p || p.version!==1 || p.writeAllowed!==true || p.executeAllowed!==true || p.descriptorSha256!==request.descriptorSha256)throw new Error('Administrator task permissions unavailable');
      return {version:1 as const,writeAllowed:true,executeAllowed:true,descriptorSha256:p.descriptorSha256};
    }
  }
}
