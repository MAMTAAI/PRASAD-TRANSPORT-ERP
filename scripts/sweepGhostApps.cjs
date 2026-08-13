#!/usr/bin/env node
// scripts/sweepGhostApps.cjs — Node wrapper for the Windows ghost-process sweeper.
//   npm run system:kill-ghosts            kill ghost GUI apps, print reclaimed RAM
//   npm run system:kill-ghosts -- --dry   census only, kill nothing
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const dry = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const script = path.join(__dirname, 'ghostSweeper.ps1');

const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
if (dry) args.push('-DryRun');

const out = spawnSync('powershell', args, { stdio: 'inherit' });
process.exit(out.status ?? 1);
