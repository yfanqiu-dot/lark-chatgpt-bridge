#!/usr/bin/env node
import { runtimeSupervisorMain } from '../dist/desktop-runtime-supervisor.js';
void runtimeSupervisorMain().catch(()=>{console.error('Runtime supervisor failed. Inspect preserved local evidence; never repeat a launch or model input.');process.exitCode=1;});
