import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.platform !== 'win32')('Windows broker lifetime policy', () => {
  function run(assertion: string): string {
    const source = resolve('bin/desktop-package-broker.ps1').replaceAll("'","''");
    const script = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'; $ast=[Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$null,[ref]$null); foreach($name in @('Test-BrokerLease','Test-BrokerLaunchAllowed','Test-BrokerDrainComplete')){$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true); if(!$fn){throw 'Policy helper missing'}; . ([scriptblock]::Create($fn.Extent.Text))}; ${assertion}`;
    return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true}).trim();
  }
  it('requires fresh lease, exact capability, run and full owner identity', () => {
    expect(run(`$id=@{pid=42;parentPid=1;createdAt='start';executable='node';commandLineSha256='cmd'};$lease=@{version=1;runId='12345678-1234-1234-1234-123456789abc';tokenSha256='token';packageFullName='package';revision=1;expiresAt=15000;owner=$id}; if(!(Test-BrokerLease $lease $lease.runId 'token' 'package' 1000 $id)){throw 'Valid lease rejected'}; foreach($bad in @('wrong-token','wrong-run','expiry','pid-reuse')){$copy=$lease.Clone();$actual=$id.Clone();$key='token';$run=$lease.runId;if($bad -eq 'wrong-token'){$key='other'};if($bad -eq 'wrong-run'){$run='other'};if($bad -eq 'expiry'){$copy.expiresAt=1000};if($bad -eq 'pid-reuse'){$actual.createdAt='replacement'};if(Test-BrokerLease $copy $run $key 'package' 1000 $actual){throw 'Unsafe lease accepted'}};Write-Output OK`)).toBe('OK');
  });
  it('allows only ordinary detach requests while draining and waits for release or timeout', () => {
    expect(run(`if(Test-BrokerLaunchAllowed $true @{endpoint='ws://127.0.0.1:19431';allowDetach=$true}){throw 'Shared launch accepted'};if(Test-BrokerLaunchAllowed $true @{allowDetach='true'}){throw 'Invalid boolean accepted'};if(!(Test-BrokerLaunchAllowed $true @{allowDetach=$true})){throw 'Ordinary restore rejected'};if(Test-BrokerDrainComplete $true $false 0 1000 2000){throw 'Stopped before restore'};if(Test-BrokerDrainComplete $true $true 1 1000 2000){throw 'Stopped with active child'};if(!(Test-BrokerDrainComplete $true $true 0 1000 2000)){throw 'Release not accepted'};if(!(Test-BrokerDrainComplete $true $false 1 2000 2000)){throw 'Timeout not accepted'};Write-Output OK`)).toBe('OK');
  });
});
