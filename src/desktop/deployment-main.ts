import { readFile } from 'node:fs/promises';
import { diagnoseDeployment, prepareDeployment, verifyDeployment } from './deployment';
import { WindowsSupervisorControl } from './supervisor-windows';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { desktopPipes } from './windows-tools';
import { OrdinaryPipeRpc, inspectOrdinaryIdle } from './ordinary-idle';
import { prepareStandalone } from './standalone';
import { prepareColdRuntime } from './runtime-supervisor';

async function main(): Promise<void> {
  const [mode, path, directory, ...extra] = process.argv.slice(2);
  if (!path || extra.length || !['prepare', 'verify', 'diagnose', 'rollback-check','supervisor-prepare','ordinary-check','cold-check','cold-prepare','cold-prepare-uac','standalone-prepare'].includes(mode ?? '')) throw new Error('Usage: lark-chatgpt-deploy prepare <spec.json> <new-directory> | verify <directory> | diagnose <directory> [--native] | rollback-check <directory> | supervisor-prepare <stage> <new-evidence-directory> | ordinary-check|cold-check <stage> <new-evidence-directory> | standalone-prepare|cold-prepare|cold-prepare-uac <stage> <new-plan-directory>');
  if (mode === 'prepare') {
    if (!directory) throw new Error('A new staging directory is required');
    const snapshot = await prepareDeployment(JSON.parse(await readFile(path, 'utf8')), directory);
    console.log(JSON.stringify({ staged: true, codeRevision: snapshot.spec.codeRevision, grayChatCount: 1, servicesChanged: false }));
  } else if (mode === 'cold-prepare'||mode==='cold-prepare-uac') {
    if(!directory)throw new Error('A new cold runtime directory is required');console.log(JSON.stringify(await prepareColdRuntime(path,directory,undefined,mode==='cold-prepare-uac'?'uac':undefined),null,2));
  } else if (mode === 'standalone-prepare') {
    if (!directory) throw new Error('A new standalone plan directory is required');
    console.log(JSON.stringify({ ...await prepareStandalone(path,directory),servicesChanged:false,productionReady:false },null,2));
  } else if (mode === 'supervisor-prepare' || mode === 'ordinary-check' || mode === 'cold-check') {
    if (!directory) throw new Error('A new evidence directory is required');
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/desktop-runtime-control.ps1');
    const control = await WindowsSupervisorControl.prepare(path, script, directory);
    if (mode === 'cold-check') {
      const scan = await control.coldSnapshot();
      const valid = scan.complete === true && Number.isFinite(scan.verifiedAt) && scan.verifiedAt <= Date.now()+1000 && Date.now()-scan.verifiedAt <= 5000
        && Array.isArray(scan.desktopRelated) && scan.inventory.legacy.length === 1 && !scan.inventory.host.length && !scan.inventory.listener.length && !scan.inventory.broker.length;
      const exited = valid && !scan.desktopRelated.length && !scan.inventory.desktop.length;
      const report = {version:1,observedAt:new Date().toISOString(),startMode:'cold',desktopExitVerified:exited,
        findings:!valid ? ['cold_inventory_invalid_or_conflicting'] : exited ? [] : ['cold_desktop_or_backend_present'],
        desktopRelatedCount:scan.desktopRelated.length,inventoryCounts:Object.fromEntries(Object.entries(scan.inventory).map(([role,items]) => [role,items.length])),
        servicesChanged:false,productionReady:false,oldDesktopNativeIdleVerified:false};
      await writeFile(join(directory,'cold-observation.json'),JSON.stringify(report,null,2),{encoding:'utf8',flag:'wx',mode:0o600});
      console.log(JSON.stringify(report,null,2)); if (!exited) process.exitCode=2; return;
    }
    const inventory = await control.inventory();
    if (inventory.legacy.length !== 1 || inventory.desktop.length !== 1 || inventory.host.length || inventory.listener.length || inventory.broker.length) throw new Error('Initial supervisor inventory is not unique');
    await control.testIdentity('legacy', inventory.legacy[0]!); await control.testIdentity('desktop', inventory.desktop[0]!);
    if (mode === 'ordinary-check') {
      const { host, snapshot } = await verifyDeployment(path);
      const desktop = inventory.desktop[0]!;
      const pipes = await desktopPipes(desktop.pid, host.desktopExe);
      const matching: string[] = [];
      for (const candidate of pipes) {
        const rpc = new OrdinaryPipeRpc(candidate.pipe);
        try {
          await rpc.connect(); const catalog = await rpc.call('tools/list', { threadStartKind: 'all' });
          const names = catalog.tools?.map((t: any) => t.name);
          if (Array.isArray(names) && JSON.stringify([...names].sort()) === JSON.stringify([...snapshot.spec.expectedToolNames].sort())) matching.push(candidate.pipe);
        } catch { /* A failed pipe is not a successful capability check. */ }
        finally { rpc.close(); }
      }
      let observation;
      if (matching.length !== 1) observation = { verified: false, findings: ['ordinary_tool_pipe_not_unique'], toolCount: 0 };
      else {
        const rpc = new OrdinaryPipeRpc(matching[0]!);
        await rpc.connect();
        observation = await inspectOrdinaryIdle(rpc, desktop, snapshot.bindings, snapshot.spec.expectedToolNames, async () => {
          await control.testIdentity('desktop', desktop);
          const current = await control.inventory();
          if (current.desktop.length !== 1 || current.legacy.length !== 1 || current.host.length || current.listener.length || current.broker.length) throw new Error('Ordinary inventory changed');
          return current.desktop[0]!;
        });
      }
      await control.testIdentity('desktop', desktop);
      const report = { ...observation, observedAt: new Date().toISOString(), source: 'ordinary_desktop_owned_pipe', pipeCount: pipes.length, matchingToolCatalogs: matching.length, servicesChanged: false, productionReady: false };
      await writeFile(join(directory, 'ordinary-observation.json'), JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ ...report, proof: report.proof ? { taskCount: report.proof.tasks.length, verifiedAt: report.proof.verifiedAt } : undefined }, null, 2));
      if (!observation.verified) process.exitCode = 2;
      return;
    }
    const backup = await control.backupTask(join(directory, 'legacy-backup'));
    console.log(JSON.stringify({ prepared: true, servicesChanged: false, inventoryCounts: Object.fromEntries(Object.entries(inventory).map(([role, items]) => [role, items.length])), legacyTaskDefinitionBackedUp: true,
      legacyTaskEnabled: backup.enabled, productionReady: false, missingCapabilities: ['ordinary_desktop_native_idle_and_queue_probe', 'independent_production_launcher', 'continuous_package_broker_wiring_and_acceptance', 'live_cutover_and_rollback_acceptance'] }, null, 2));
  } else if (mode === 'verify') {
    if (directory) throw new Error('Unexpected argument');
    const { snapshot } = await verifyDeployment(path);
    console.log(JSON.stringify({ verified: true, codeRevision: snapshot.spec.codeRevision, servicesChanged: false }));
  } else {
    if (directory && !(mode === 'diagnose' && directory === '--native')) throw new Error('Unexpected argument');
    const report = await diagnoseDeployment(path, directory === '--native');
    console.log(JSON.stringify(report, null, 2));
    if (mode === 'rollback-check' && !report.rollback.newRuntimeStopped) process.exitCode = 2;
  }
}
void main().catch(e => {
  // Errors from validators contain fixed labels. Never print arbitrary raw JSON,
  // native RPC errors, file contents, or authentication configuration.
  const message = e instanceof Error && ['Invalid ', 'A full ', 'Duplicate ', 'Initial ', 'Selected ', 'Host and ', 'Topic project ', 'Ledger ', 'Malformed ', 'Deployment ', 'Pinned ', 'Original ', 'Codex binary hash differs', 'Installed desktop version differs', 'Usage:', 'Unexpected ', 'A new '].some(prefix => e.message.startsWith(prefix)) ? e.message : 'Inspect local configuration, pinned files and preserved bindings';
  console.error(`Deployment check failed: ${message}. No service was changed.`); process.exitCode = 1;
});
