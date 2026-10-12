import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDeployment } from './deployment';
import { WindowsSupervisorControl } from './supervisor-windows';
import { sameProcess, type ProcessIdentity, type SupervisorInventory } from './supervisor';
import { writeFileAtomic } from '../platform/atomic-write';
import { cleanDesktopEnvironment } from './windows-tools';
import { BrokerOwnerLease } from './broker-lease';

const exec = promisify(execFile);
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = async (path: string) => JSON.parse(await readFile(path,'utf8'));
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)),'..');
export interface StandalonePlan {
  version: 1; mode: 'preflight'; planId: string; codeRevision: string;
  stage: string; directory: string; createdAt: string; expiresAt: number;
  nodeExecutable: string; workerEntryPoint: string; launcherScript: string;
  files: Array<{ path: string; sha256: string }>;
}
export function parseStandalonePlan(raw: unknown, planFile: string): StandalonePlan {
  const r = raw as StandalonePlan;
  if (!r || r.version !== 1 || r.mode !== 'preflight' || !/^[a-f0-9-]{36}$/.test(r.planId) || !/^[a-f0-9]{40}$/.test(r.codeRevision)
    || !Number.isFinite(Date.parse(r.createdAt)) || !Number.isSafeInteger(r.expiresAt) || r.expiresAt <= Date.parse(r.createdAt) || r.expiresAt - Date.parse(r.createdAt) > 600_000) throw new Error('Invalid standalone preflight plan');
  for (const path of [planFile,r.stage,r.directory,r.nodeExecutable,r.workerEntryPoint,r.launcherScript]) if (typeof path !== 'string' || !isAbsolute(path) || /["\r\n]/.test(path)) throw new Error('Invalid standalone path');
  if (resolve(r.directory) !== dirname(resolve(planFile)) || resolve(r.workerEntryPoint) !== join(dirname(resolve(r.launcherScript)),'lark-chatgpt-supervisor.mjs') || !r.launcherScript.endsWith('desktop-supervisor-launch.ps1')) throw new Error('Standalone directory or entry point changed');
  if (!Array.isArray(r.files) || r.files.length !== 7 || new Set(r.files.map(f => f.path)).size !== r.files.length || r.files.some(f => !f || typeof f.path !== 'string' || !isAbsolute(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256))) throw new Error('Invalid standalone program proofs');
  const required = [r.nodeExecutable,r.workerEntryPoint,r.launcherScript,join(dirname(r.workerEntryPoint),'../dist/desktop-standalone.js'),join(dirname(r.workerEntryPoint),'desktop-runtime-control.ps1'),join(dirname(r.workerEntryPoint),'lark-chatgpt-deploy.mjs'),join(dirname(r.workerEntryPoint),'../dist/desktop-deploy.js')].map(resolvePath => resolve(resolvePath));
  if (required.some(path => !r.files.some(f => resolve(f.path) === path))) throw new Error('Standalone program proof missing');
  return { version: 1, mode: 'preflight', planId: r.planId, codeRevision: r.codeRevision, stage: resolve(r.stage), directory: resolve(r.directory), createdAt: r.createdAt, expiresAt: r.expiresAt,
    nodeExecutable: resolve(r.nodeExecutable), workerEntryPoint: resolve(r.workerEntryPoint), launcherScript: resolve(r.launcherScript), files: r.files.map(f => ({ path: resolve(f.path), sha256: f.sha256 })) };
}
/** Create an exclusive plan and a runtime source stage. No task registration,
 * child process, package activation, credentials copy or service change. */
export async function prepareStandalone(stage: string, directory: string, root = packageRoot): Promise<{ planFile: string; planSha256: string; planId: string }> {
  if (![stage,directory,root].every(isAbsolute)) throw new Error('Standalone paths must be absolute');
  const { snapshot } = await verifyDeployment(stage);
  const files = [snapshot.spec.legacy.executable,join(root,'bin/lark-chatgpt-supervisor.mjs'),join(root,'bin/desktop-supervisor-launch.ps1'),join(root,'dist/desktop-standalone.js'),join(root,'bin/desktop-runtime-control.ps1'),join(root,'bin/lark-chatgpt-deploy.mjs'),join(root,'dist/desktop-deploy.js')].map(path => resolve(path));
  const proofs = files.map(path => {
    const proof = snapshot.files.find(f => resolve(f.path) === path); if (!proof) throw new Error('Standalone program must be in deployment proofs'); return { ...proof, path };
  });
  await mkdir(directory,{recursive:false,mode:0o700});
  const createdAt = new Date().toISOString(), planFile = join(directory,'plan.json');
  const plan: StandalonePlan = { version:1,mode:'preflight',planId:randomUUID(),codeRevision:snapshot.spec.codeRevision,stage:resolve(stage),directory:resolve(directory),createdAt,expiresAt:Date.parse(createdAt)+600_000,nodeExecutable:files[0]!,workerEntryPoint:files[1]!,launcherScript:files[2]!,files:proofs };
  const data = JSON.stringify(plan,null,2)+'\n'; await writeFile(planFile,data,{encoding:'utf8',flag:'wx',mode:0o600});
  return { planFile, planSha256: sha(data), planId: plan.planId };
}
export async function readStandalonePlan(planFile: string, expectedSha: string, checkExpiry = true): Promise<StandalonePlan> {
  if (!isAbsolute(planFile) || !/^[a-f0-9]{64}$/.test(expectedSha)) throw new Error('Invalid standalone plan proof');
  const data = await readFile(planFile); if (sha(data) !== expectedSha) throw new Error('Standalone plan changed');
  const plan = parseStandalonePlan(JSON.parse(data.toString('utf8')),planFile);
  if (checkExpiry && (Date.parse(plan.createdAt) > Date.now()+1000 || plan.expiresAt <= Date.now())) throw new Error('Standalone plan expired');
  return plan;
}
export async function verifyStandalone(planFile: string, expectedSha: string, checkExpiry = true): Promise<StandalonePlan> {
  const plan = await readStandalonePlan(planFile,expectedSha,checkExpiry);
  const { snapshot } = await verifyDeployment(plan.stage);
  if (snapshot.spec.codeRevision !== plan.codeRevision) throw new Error('Standalone source revision changed');
  for (const f of plan.files) if (!snapshot.files.some(p => resolve(p.path) === f.path && p.sha256 === f.sha256) || sha(await readFile(f.path)) !== f.sha256) throw new Error('Standalone program changed');
  return plan;
}
/** One native creation attempt. Existing intent, ambiguous launch or a failed
 * result is retained; never retry the same plan. WMI creation avoids inheriting
 * the launching command's desktop process tree. The worker is read-only. */
export async function launchStandalone(planFile: string, expectedSha: string): Promise<any> {
  if (process.platform !== 'win32') throw new Error('Standalone native launch requires Windows');
  const plan = await verifyStandalone(planFile,expectedSha);
  await reserveStandaloneLaunch(plan,expectedSha);
  try {
    const { stdout } = await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',plan.launcherScript,'-Action','Launch','-PlanFile',planFile,'-PlanSha256',expectedSha],{windowsHide:true,timeout:20_000,encoding:'utf8',env:cleanDesktopEnvironment(process.env)});
    return validateStandaloneReceipt(JSON.parse(stdout),plan);
  } catch {
    await writeFileAtomic(join(plan.directory,'launch.failure.json'),JSON.stringify({version:1,planId:plan.planId,phase:'uncertain',errorCode:'native_launch_not_confirmed',servicesChanged:false}));
    throw new Error('Standalone launch uncertain; inspect evidence and do not repeat this plan');
  }
}
export async function reserveStandaloneLaunch(plan: StandalonePlan, expectedSha: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha) || plan.mode !== 'preflight') throw new Error('Invalid standalone launch intent');
  await writeFile(join(plan.directory,'launch.intent.json'),JSON.stringify({version:1,planId:plan.planId,planSha256:expectedSha,mode:'preflight',requestedAt:new Date().toISOString()}),{encoding:'utf8',flag:'wx',mode:0o600});
}
export function validateStandaloneReceipt(value: unknown, plan: StandalonePlan) {
  const r = value as any;
  if (!r || r.version !== 1 || r.planId !== plan.planId || r.mode !== 'preflight' || r.phase !== 'launched' || !sameProcess(r.identity,r.identity)
    || r.identity.executable.toLowerCase() !== plan.nodeExecutable.toLowerCase() || Date.parse(r.identity.createdAt) < Date.parse(plan.createdAt)-1000 || Date.parse(r.identity.createdAt) > Date.now()+1000 || r.servicesChanged !== false || r.productionReady !== false) throw new Error('Standalone native receipt unconfirmed');
  const p: ProcessIdentity = r.identity;
  return {version:1,planId:plan.planId,mode:'preflight',phase:'launched',identity:{pid:p.pid,parentPid:p.parentPid,createdAt:p.createdAt,executable:p.executable,commandLineSha256:p.commandLineSha256},servicesChanged:false,productionReady:false};
}
const inventorySame = (a: SupervisorInventory,b: SupervisorInventory) => (['legacy','desktop','host','listener','broker'] as const).every(role => a[role].length === b[role].length && a[role].every(p => b[role].some(q => sameProcess(p,q))));
const unique = (i: SupervisorInventory) => i.legacy.length === 1 && i.desktop.length === 1 && !i.host.length && !i.listener.length && !i.broker.length;
/** No production mode exists in this entry point. The only child invocation
 * is the deployment CLI's read-only ordinary-check command. */
export async function standalonePreflight(planFile: string, expectedSha: string): Promise<number> {
  const plan = await readStandalonePlan(planFile,expectedSha);
  const resultPath = join(plan.directory,'worker.result.json');
  // Prevent a second invocation from overwriting the first inspection.
  await writeFile(join(plan.directory,'worker.intent.json'),JSON.stringify({version:1,planId:plan.planId,mode:'preflight'}),{encoding:'utf8',flag:'wx',mode:0o600});
  let identity: ProcessIdentity | undefined;
  let ownerLease: BrokerOwnerLease | undefined, leaseLost = false;
  try {
    await verifyStandalone(planFile,expectedSha);
    const receipt = await exec('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',plan.launcherScript,'-Action','InspectIdentity','-ProcessId',String(process.pid),'-PlanFile',planFile,'-PlanSha256',expectedSha],{windowsHide:true,timeout:20_000,encoding:'utf8',env:cleanDesktopEnvironment(process.env)});
    identity = JSON.parse(receipt.stdout);
    if (!identity || identity.pid !== process.pid || !sameProcess(identity,identity) || identity.executable.toLowerCase() !== plan.nodeExecutable.toLowerCase()) throw new Error('Standalone identity unavailable');
    await writeFile(join(plan.directory,'worker.identity.json'),JSON.stringify({version:1,planId:plan.planId,identity}),{encoding:'utf8',flag:'wx',mode:0o600});
    const { host } = await verifyDeployment(plan.stage);
    const leaseFile = join(plan.directory,'broker-owner-probe.json'), capability = randomBytes(32).toString('hex');
    ownerLease = new BrokerOwnerLease(leaseFile);
    await ownerLease.open(plan.planId,identity,`OpenAI.Codex_${host.desktopVersion}_x64__2p2nqsd0c76g0`,capability);
    ownerLease.startHeartbeat(() => { leaseLost = true; });
    const control = await WindowsSupervisorControl.prepare(plan.stage,join(dirname(plan.workerEntryPoint),'desktop-runtime-control.ps1'),join(plan.directory,'worker-control'));
    const before = await control.inventory(); if (!unique(before)) throw new Error('Standalone initial inventory conflict');
    await control.testIdentity('desktop',before.desktop[0]!); await control.testIdentity('legacy',before.legacy[0]!);
    const { ledgers: beforeLedgers, topics } = await verifyDeployment(plan.stage);
    const originals = async () => {
      const paths = [topics.registryFile,`${topics.registryFile}.approvals.json`];
      const result: Record<string,string> = {};
      for (const path of paths) { try { result[path] = sha(await readFile(path)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') result[path] = 'missing'; else throw e; } }
      return result;
    };
    const originalBefore = await originals(), ordinaryDirectory = join(plan.directory,'ordinary');
    let childExit = 0;
    try { await exec(plan.nodeExecutable,[join(dirname(plan.workerEntryPoint),'lark-chatgpt-deploy.mjs'),'ordinary-check',plan.stage,ordinaryDirectory],{windowsHide:true,timeout:90_000,encoding:'utf8',env:cleanDesktopEnvironment(process.env)}); }
    catch (e) { childExit = Number((e as any).code); if (childExit !== 2) throw new Error('Standalone ordinary inspection failed'); }
    const observed = await json(join(ordinaryDirectory,'ordinary-observation.json'));
    if (typeof observed.verified !== 'boolean' || !Array.isArray(observed.findings) || observed.findings.some((f: unknown) => typeof f !== 'string' || !/^ordinary_[a-z_]+$/.test(f))) throw new Error('Standalone ordinary report invalid');
    const after = await control.inventory(), { ledgers: afterLedgers } = await verifyDeployment(plan.stage);
    const preserved = inventorySame(before,after) && unique(after) && JSON.stringify(originalBefore) === JSON.stringify(await originals())
      && beforeLedgers.every(l => afterLedgers.some(a => a.file === l.file && a.sha256 === l.sha256));
    const finalLease = await json(leaseFile); await ownerLease.close(); ownerLease = undefined;
    const closedLease = await json(leaseFile);
    const leaseClosed = closedLease.runId === plan.planId && sameProcess(closedLease.owner,identity) && closedLease.tokenSha256 === sha(capability) && closedLease.expiresAt <= Date.now();
    const report = { version:1,planId:plan.planId,mode:'preflight',phase:preserved && !leaseLost && leaseClosed ? observed.verified ? 'preflight_only' : 'blocked' : 'failed',identity,completedAt:new Date().toISOString(),servicesChanged:false,productionReady:false,originalProcessesAndBytesUnchanged:preserved,
      leaseProbe:{renewals:finalLease.revision,closed:leaseClosed,lost:leaseLost,rawCapabilityStored:false},
      ordinary:{verified:observed.verified === true,findings:observed.findings,toolCount:observed.toolCount,pipeCount:observed.pipeCount,matchingToolCatalogs:observed.matchingToolCatalogs,...(observed.failure ? {failure:observed.failure}: {})} };
    await writeFileAtomic(resultPath,JSON.stringify(report,null,2)); return preserved && !leaseLost && leaseClosed ? observed.verified ? childExit : 2 : 1;
  } catch {
    await writeFileAtomic(resultPath,JSON.stringify({version:1,planId:plan.planId,mode:'preflight',phase:'failed',identity,completedAt:new Date().toISOString(),servicesChanged:false,productionReady:false,errorCode:'standalone_preflight_failed'})); return 1;
  } finally { await ownerLease?.close().catch(() => {}); }
}
export async function standaloneMain(): Promise<void> {
  const [mode,path,proof,...extra] = process.argv.slice(2);
  if (!path || !proof || extra.length || !['--launch','--preflight','--status'].includes(mode ?? '')) throw new Error('Usage: lark-chatgpt-supervisor --launch|--status <plan.json> <sha256>');
  if (mode === '--launch') console.log(JSON.stringify(await launchStandalone(path,proof),null,2));
  else if (mode === '--preflight') process.exitCode = await standalonePreflight(path,proof);
  else {
    const plan = await readStandalonePlan(path,proof,false);
    try {
      const result = await json(join(plan.directory,'worker.result.json'));
      if (result.version !== 1 || result.planId !== plan.planId || result.mode !== 'preflight') throw new Error('Standalone result identity changed');
      console.log(JSON.stringify({ ...result, historical:true },null,2));
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; console.log(JSON.stringify({planId:plan.planId,phase:'result_not_available',servicesChanged:false,productionReady:false})); }
  }
}
