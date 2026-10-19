#!/usr/bin/env node
import { runtimeSupervisorMain } from '../dist/desktop-runtime-supervisor.js';
import {createHash} from 'node:crypto';
void runtimeSupervisorMain().catch(error=>{
  const code=error?.code==='service_previous_run_unresolved'?'service_previous_run_unresolved':process.argv[2]==='--service-launch'?'service_launch_failed':'runtime_supervisor_failed';
  // Fixed codes and a fingerprint only: never expose raw native errors,
  // credentials, prompts or configuration through a startup notification.
  console.error('QIU_BRIDGE_FAILURE '+JSON.stringify({version:1,code,errorSha256:createHash('sha256').update(String(error)).digest('hex')}));
  process.exitCode=1;
});
