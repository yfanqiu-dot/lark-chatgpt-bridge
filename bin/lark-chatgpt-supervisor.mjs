#!/usr/bin/env node
import { standaloneMain } from '../dist/desktop-standalone.js';
void standaloneMain().catch(e => { console.error(e?.code === 'EEXIST' ? 'Standalone plan was already attempted. No second worker was launched; inspect its preserved evidence.' : 'Standalone preflight failed. Inspect preserved local evidence; no production mode was enabled.'); process.exitCode=1; });
