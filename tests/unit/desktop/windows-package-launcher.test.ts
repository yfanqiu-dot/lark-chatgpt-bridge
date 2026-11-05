import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {windowsPowerShellEnvironment} from '../../../src/desktop/windows-tools';

describe.skipIf(process.platform!=='win32')('Windows package launcher without a console',()=>{
  let dir:string,exe:string,script:string;
  beforeAll(async()=>{
    dir=await mkdtemp(join(tmpdir(),'bridge-headless-unit-'));exe=join(dir,'desktop-package-launcher.exe');script=join(dir,'probe with spaces.ps1');
    await writeFile(script,'param([string]$Value)\n','utf8');
    await writeFile(join(dir,'desktop-package-broker.ps1'),'[IO.File]::WriteAllText((Join-Path $PSScriptRoot "unexpected-execution"),"executed")','utf8');
    execFileSync(join(process.env.SystemRoot??'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:winexe','/platform:x64','/optimize+','/debug-','/out:'+exe,resolve('native/BridgePackageLauncher.cs')],{windowsHide:true,encoding:'utf8',timeout:30000});
  },35000);
  afterAll(async()=>{
    if(dir){const target=resolve(dir),parent=resolve(tmpdir())+sep;if(!target.toLowerCase().startsWith(parent.toLowerCase())||!target.includes('bridge-headless-unit-'))throw Error('Unexpected cleanup path');await rm(target,{recursive:true,force:true});}
  });
  function run(body:string){
    const code=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$null=[Reflection.Assembly]::LoadFile('${exe.replaceAll("'","''")}');${body}`;
    return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{windowsHide:true,env:windowsPowerShellEnvironment(process.env),encoding:'utf8',timeout:15000}).trim();
  }
  it('uses the GUI subsystem so the package activation itself cannot allocate a console',async()=>{
    const bytes=await readFile(exe),offset=bytes.readUInt32LE(0x3c);expect(bytes.readUInt32LE(offset)).toBe(0x4550);expect(bytes.readUInt16LE(offset+24+68)).toBe(2);
  });
  it('sets CreateNoWindow with shell execution disabled and the fixed system PowerShell executable',()=>{
    const value=JSON.parse(run(`$p=[BridgePackageLauncher]::CreateStartInfo('${script.replaceAll("'","''")}',@('-Value','中文 路径'));@{noWindow=$p.CreateNoWindow;shell=$p.UseShellExecute;exe=$p.FileName;dialog=$p.ErrorDialog;args=$p.Arguments}|ConvertTo-Json -Compress`));
    expect(value).toMatchObject({noWindow:true,shell:false,dialog:false});
    expect(value.exe.toLowerCase()).toBe(join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe').toLowerCase());
    expect(value.args).toContain('中文 路径');expect(value.args).toContain('-NonInteractive');
  });
  it('round trips Windows arguments including spaces, quotes, empty values and trailing slashes',()=>{
    const values=['','normal','中文 空格','C:\\path with spaces\\','a"b','x\\\\"y',"literal '$() ` text"];
    const payload=Buffer.from(JSON.stringify(values),'utf8').toString('base64');
    const result=JSON.parse(run(`$values=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;Add-Type 'using System;using System.Runtime.InteropServices;public static class BridgeArgv{[DllImport("shell32.dll",CharSet=CharSet.Unicode)]public static extern IntPtr CommandLineToArgvW(string cmd,out int count);[DllImport("kernel32.dll")]public static extern IntPtr LocalFree(IntPtr value);}';$line='probe.exe '+(($values|ForEach-Object{[BridgePackageLauncher]::Quote($_)}) -join ' ');$count=0;$ptr=[BridgeArgv]::CommandLineToArgvW($line,[ref]$count);try{$out=@();for($i=1;$i -lt $count;$i++){$out += [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($ptr,$i*[IntPtr]::Size))};ConvertTo-Json -InputObject $out -Compress}finally{$null=[BridgeArgv]::LocalFree($ptr)}`));
    expect(result).toEqual(values);
  });
  it('rejects control characters and missing scripts',()=>{
    expect(run(`$rejected=0;try{[BridgePackageLauncher]::Quote("bad\narg")}catch{$rejected++};try{[BridgePackageLauncher]::CreateStartInfo('relative.ps1',@())}catch{$rejected++};$rejected`)).toBe('2');
  });
  it('fails closed outside the Codex package without starting the broker',async()=>{
    let status=0;try{execFileSync(exe,[],{windowsHide:true,timeout:10000,stdio:'pipe'});}catch(error:any){status=error.status;}
    expect(status).toBe(2);await expect(readFile(join(dir,'unexpected-execution'))).rejects.toThrow();
  });
});
