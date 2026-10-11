import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe.skipIf(process.platform !== 'win32')('Windows task definition export', () => {
  // Load only the two pure functions from our own parsed source. Do not dot
  // source the service-control entry point or call Task Scheduler operations.
  function run(assertion: string): string {
    const source = resolve('bin/desktop-runtime-control.ps1').replaceAll("'", "''");
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $ast=[Management.Automation.Language.Parser]::ParseFile('${source}',[ref]$null,[ref]$null); foreach($name in @('Get-Sha','Normalize-TaskDefinition')) { $fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true); if(!$fn){throw 'Pure helper missing'}; . ([scriptblock]::Create($fn.Extent.Text)) }; ${assertion}`;
    return execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }).trim();
  }
  it('normalizes omitted default true and explicit enabled/disabled exports equally', () => {
    expect(run(`$base='<Task xmlns="urn:task"><Settings><Hidden>true</Hidden></Settings></Task>'; $on='<Task xmlns="urn:task"><Settings><Hidden>true</Hidden><Enabled>true</Enabled></Settings></Task>'; $off='<Task xmlns="urn:task"><Settings><Hidden>true</Hidden><Enabled>false</Enabled></Settings></Task>'; $a=Normalize-TaskDefinition $base $true; $b=Normalize-TaskDefinition $on $true; $c=Normalize-TaskDefinition $off $false; if($a.sha256 -ne $b.sha256 -or $b.sha256 -ne $c.sha256 -or !$a.enabled -or $c.enabled){throw 'Normalization failed'}; Write-Output OK`)).toBe('OK');
  });
  it('rejects inconsistent enabled state and retains other setting changes', () => {
    expect(run(`$bad='<Task><Settings><Enabled>false</Enabled></Settings></Task>'; $rejected=$false; try{ $null=Normalize-TaskDefinition $bad $true }catch{$rejected=$true}; if(!$rejected){throw 'Mismatch accepted'}; $a=Normalize-TaskDefinition '<Task><Settings><Hidden>true</Hidden></Settings></Task>' $true; $b=Normalize-TaskDefinition '<Task><Settings><Hidden>false</Hidden></Settings></Task>' $true; if($a.sha256 -eq $b.sha256){throw 'Changed definition accepted'}; Write-Output OK`)).toBe('OK');
  });
  it('writes a declaration matching UTF-8 backup bytes and preserves the actual setting', () => {
    expect(run(`$value=Normalize-TaskDefinition '<?xml version="1.0" encoding="UTF-16"?><Task><Settings><Enabled>false</Enabled></Settings></Task>' $false; $bytes=[Text.Encoding]::UTF8.GetBytes($value.xml); $stream=[IO.MemoryStream]::new($bytes,$false); $reader=[Xml.XmlReader]::Create($stream); $document=[Xml.XmlDocument]::new(); try{$document.Load($reader)}finally{$reader.Dispose();$stream.Dispose()}; if($document.FirstChild.Encoding -ne 'UTF-8' -or $document.Task.Settings.Enabled -ne 'false'){throw 'Backup bytes mismatch'}; Write-Output OK`)).toBe('OK');
  });
});
