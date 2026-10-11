import { readFile } from 'node:fs/promises';
import { diagnoseDeployment, prepareDeployment, verifyDeployment } from './deployment';

async function main(): Promise<void> {
  const [mode, path, directory, ...extra] = process.argv.slice(2);
  if (!path || extra.length || !['prepare', 'verify', 'diagnose', 'rollback-check'].includes(mode ?? '')) throw new Error('Usage: lark-chatgpt-deploy prepare <spec.json> <new-directory> | verify <directory> | diagnose <directory> [--native] | rollback-check <directory>');
  if (mode === 'prepare') {
    if (!directory) throw new Error('A new staging directory is required');
    const snapshot = await prepareDeployment(JSON.parse(await readFile(path, 'utf8')), directory);
    console.log(JSON.stringify({ staged: true, codeRevision: snapshot.spec.codeRevision, grayChatCount: 1, servicesChanged: false }));
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
