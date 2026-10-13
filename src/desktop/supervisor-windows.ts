import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { verifyDeployment } from './deployment';
import type { ColdExitProof, ProcessIdentity, SupervisorInventory, LegacyRetirementProof } from './supervisor';
import { ColdExitObservationUnavailable } from './supervisor';
import { windowsPowerShellEnvironment } from './windows-tools';

const exec = promisify(execFile);
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
/** Windows adapter primitives. The native idle gate and production launch
 * lifecycle are deliberately required before wiring destructive operations. */
export class WindowsSupervisorControl {
  private constructor(private readonly stage: string, private readonly script: string, private readonly configFile: string, private readonly configSha256: string, private readonly evidence: string, private readonly allowMutations: boolean,private readonly scriptSha256:string) {}
  static async prepare(stage: string, script: string, evidence: string, allowMutations = false, legacyTaskOperationsAllowed = true): Promise<WindowsSupervisorControl> {
    if (process.platform !== 'win32') throw new Error('Windows supervisor control requires Windows');
    if (![stage,script,evidence].every(isAbsolute)) throw new Error('Windows supervisor control paths must be absolute');
    const { host, snapshot } = await verifyDeployment(stage);
    if (!snapshot.files.some(f => f.path === resolve(script))) throw new Error('Runtime control script must be included in deployment artifact proofs');
    await mkdir(evidence, { recursive: false, mode: 0o700 });
    const configFile = join(evidence, 'control.json');
    const data = JSON.stringify({ version: 1, desktopExe: host.desktopExe, endpoint:host.endpoint,backendEndpoint:host.backendEndpoint,legacy: snapshot.spec.legacy,...(!legacyTaskOperationsAllowed?{legacyTaskOperationsAllowed:false}:{}) });
    await writeFile(configFile, data, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return new WindowsSupervisorControl(stage, script, configFile, digest(data), evidence, allowMutations,snapshot.files.find(f=>f.path===resolve(script))!.sha256);
  }
  private async call(action: string, extra: string[] = [], input?:string, raw=false,boundedRead=false): Promise<any> {
    if (!['Snapshot','ColdSnapshot','SharedSnapshot','TaskRetirement','TaskPermissions','TaskRestoreNeeded','StopPermission','TestIdentity','ReadOwner','BackupTask'].includes(action) && !this.allowMutations) throw new Error('Production mutations require verified hot or cold admission and explicit runtime wiring');
    if(boundedRead){if(action!=='SharedSnapshot' || digest(await readFile(this.script))!==this.scriptSha256)throw new Error('Bounded native reader changed');}
    else await verifyDeployment(this.stage);
    if (digest(await readFile(this.configFile)) !== this.configSha256) throw new Error('Runtime control configuration changed');
    const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',this.script,'-ConfigFile',this.configFile,'-Action',action,...extra];
    const options={windowsHide:true,timeout:35_000,encoding:'utf8' as const,env:windowsPowerShellEnvironment(process.env),maxBuffer:2*1024*1024};
    let stdout:string;
    try{
      stdout=input===undefined ? (await exec('powershell.exe',args,options)).stdout : await new Promise<string>((done,reject)=>{
        const child=execFile('powershell.exe',args,options,(error,output)=>error ? reject(new Error('Capability protection failed')) : done(output));
        child.stdin?.end(input);
      });
    }catch(error){
      const native=error as {code?:unknown;stderr?:unknown;signal?:unknown};
      const stderr=typeof native.stderr==='string'?native.stderr:'';
      // Only exact fixed PowerShell error IDs from our pinned inventory
      // reader are retryable. Private error text, denied reads and timeouts
      // remain fatal; unreadable processes are never omitted from inventory.
      const identityUnavailable = native.code===1 && !native.signal && !stderr.includes('0x80070005') && (action==='ColdSnapshot' || action==='Snapshot')
        && /\+ FullyQualifiedErrorId\s*:\s*(?:A potential runtime process cannot be identified|Potential desktop or App Server is unreadable|Process identity is not readable)\s*(?:\r?\n|$)/.test(stderr);
      const errorCode=identityUnavailable?'native_process_identity_unavailable':stderr.includes('0x80070005')?'native_task_access_denied':'native_control_failed';
      try{const directory=await mkdtemp(join(this.evidence,'operation-failure-'));await writeFile(join(directory,'summary.json'),JSON.stringify({version:1,action,errorCode,exitCode:typeof native.code==='number'?native.code:null,signal:typeof native.signal==='string'?native.signal:null,stderrBytes:Buffer.byteLength(stderr),stderrSha256:digest(stderr),observedAt:new Date().toISOString()}),{encoding:'utf8',flag:'wx'});}catch{}
      if(identityUnavailable)throw new ColdExitObservationUnavailable(action as 'ColdSnapshot'|'Snapshot');
      throw error;
    }
    return raw ? stdout : JSON.parse(stdout);
  }
  async inventory(): Promise<SupervisorInventory> { return this.call('Snapshot'); }
  async legacyRetirement():Promise<LegacyRetirementProof>{
    const p=await this.call('TaskRetirement');
    if(p.version!==1 || !Number.isFinite(p.observedAt) || typeof p.retired!=='boolean' || typeof p.taskPresent!=='boolean' || typeof p.taskEnabled!=='boolean'
      || !['disabled','absent','other'].includes(p.taskState) || !/^[a-f0-9]{64}$/.test(p.definitionSha256))throw new Error('Legacy retirement observation invalid');
    return p;
  }
  async taskPermissions():Promise<{version:1;writeAllowed:boolean;executeAllowed:boolean;descriptorSha256:string}>{
    const result=await this.call('TaskPermissions');
    if(result.version!==1 || typeof result.writeAllowed!=='boolean' || typeof result.executeAllowed!=='boolean' || !/^[a-f0-9]{64}$/.test(result.descriptorSha256))throw new Error('Legacy task permission proof invalid');
    return result;
  }
  async ownerIdentity(pid:number):Promise<ProcessIdentity>{return this.call('ReadOwner',['-ProcessId',String(pid)]);}
  async protectCapability(path:string,token:string):Promise<void>{await this.call('ProtectCapability',['-CapabilityFile',path],token);}
  async unprotectCapability(path:string):Promise<string>{
    const token=await this.call('UnprotectCapability',['-CapabilityFile',path],undefined,true);
    if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token))throw new Error('Protected capability unavailable');return token;
  }
  async startOrdinary():Promise<void>{await this.call('StartOrdinary');}
  async coldSnapshot(): Promise<ColdExitProof & { inventory: SupervisorInventory }> { return this.call('ColdSnapshot'); }
  async sharedSnapshot(): Promise<ColdExitProof & { inventory: SupervisorInventory; endpointOwners:Array<{endpoint:string;listeners:Array<{address:string;pid:number}>}> }> { return this.call('SharedSnapshot'); }
  /** For an already pinned <=5s admission scan only. Still hashes the sealed
   * reader/config and queries live CIM/TCP. Never permits a mutation. */
  async boundedSharedSnapshot():ReturnType<WindowsSupervisorControl['sharedSnapshot']>{return this.call('SharedSnapshot',[],undefined,false,true);}
  async backupTask(directory: string): Promise<{ definitionSha256: string; enabled: boolean }> {
    if (!isAbsolute(directory)) throw new Error('Backup directory must be absolute');
    await mkdir(directory, { recursive: false, mode: 0o700 });
    return this.call('BackupTask', ['-BackupDirectory', directory]);
  }
  private async identityCall(action: string, role: 'legacy' | 'desktop' | 'host' | 'listener', identity: ProcessIdentity): Promise<void> {
    const evidence = await mkdtemp(join(this.evidence, 'identity-'));
    const file = join(evidence, 'expected.json');
    await writeFile(file, JSON.stringify(identity), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await this.call(action, ['-Role',role,'-IdentityFile',file]);
  }
  async testIdentity(role: 'legacy' | 'desktop' | 'host' | 'listener', identity: ProcessIdentity): Promise<void> { await this.identityCall('TestIdentity', role, identity); }
  async canStopLegacy(identity:ProcessIdentity):Promise<boolean>{
    const directory=await mkdtemp(join(this.evidence,'stop-permission-')),file=join(directory,'expected.json');
    await writeFile(file,JSON.stringify(identity),{encoding:'utf8',flag:'wx'});
    const result=await this.call('StopPermission',['-Role','legacy','-IdentityFile',file]);
    if(result.version!==1 || typeof result.allowed!=='boolean' || result.processTerminated!==false)throw new Error('Old consumer stop permission proof invalid');return result.allowed;
  }
  async pauseTask(backupDirectory: string): Promise<void> { await this.call('DisableTask', ['-BackupDirectory',backupDirectory]); }
  async taskRestoreNeeded(backupDirectory:string):Promise<boolean>{
    const result=await this.call('TaskRestoreNeeded',['-BackupDirectory',backupDirectory]);
    if(result.version!==1 || typeof result.needed!=='boolean')throw new Error('Task restoration setting proof invalid');return result.needed;
  }
  async restoreTaskSetting(backupDirectory: string): Promise<void> { await this.call('RestoreTask', ['-BackupDirectory',backupDirectory]); }
  async startLegacy(backupDirectory:string):Promise<void>{await this.call('StartLegacy',['-BackupDirectory',backupDirectory]);}
  async stopOwned(role: 'legacy' | 'listener', identity: ProcessIdentity): Promise<void> { await this.identityCall('StopOwned', role, identity); }
  async closeDesktop(identity: ProcessIdentity): Promise<void> { await this.identityCall('CloseDesktop', 'desktop', identity); }
}
