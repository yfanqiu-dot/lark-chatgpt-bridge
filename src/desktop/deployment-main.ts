import { readFile } from 'node:fs/promises';
import { diagnoseDeployment, prepareDeployment, verifyDeployment } from './deployment';
import { WindowsSupervisorControl } from './supervisor-windows';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function main(): Promise<void> {
  const [mode, path, directory, ...extra] = process.argv.slice(2);
  if (!path || extra.length || !['prepare', 'verify', 'diagnose', 'rollback-check','supervisor-prepare'].includes(mode ?? '')) throw new Error('Usage: lark-chatgpt-deploy prepare <spec.json> <new-directory> | verify <directory> | diagnose <directory> [--native] | rollback-check <directory> | supervisor-prepare <stage> <new-evidence-directory>');
  if (mode === 'prepare') {
    if (!directory) throw new Error('A new staging directory is required');
    const snapshot = await prepareDeployment(JSON.parse(await readFile(path, 'utf8')), directory);
    console.log(JSON.stringify({ staged: true, codeRevision: snapshot.spec.codeRevision, grayChatCount: 1, servicesChanged: false }));
  } else if (mode === 'supervisor-prepare') {
    if (!directory) throw new Error('A new evidence directory is required');
    const script = resolve(dirname(fileURLToPath(import.meta.url)), '../bin/desktop-runtime-control.ps1');
    const control = await WindowsSupervisorControl.prepare(path, script, directory);
    const inventory = await control.inventory();
    if (inventory.legacy.length !== 1 || inventory.desktop.length !== 1 || inventory.host.length || inventory.listener.length || inventory.broker.length) throw new Error('Initial supervisor inventory is not unique');
    await control.testIdentity('legacy', inventory.legacy[0]!); await control.testIdentity('desktop', inventory.desktop[0]!);
    const backup = await control.backupTask(join(directory, 'legacy-backup'));
    console.log(JSON.stringify({ prepared: true, servicesChanged: false, inventoryCounts: Object.fromEntries(Object.entries(inventory).map(([role, items]) => [role, items.length])), legacyTaskDefinitionBackedUp: true,
      legacyTaskEnabled: backup.enabled, productionReady: false, missingCapabilities: ['ordinary_desktop_native_idle_and_queue_probe', 'independent_production_launcher', 'continuous_package_broker_lifecycle', 'live_cutover_and_rollback_acceptance'] }, null, 2));
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
