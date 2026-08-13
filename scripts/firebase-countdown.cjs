#!/usr/bin/env node
// Firebase purge countdown — the gate for the FINAL deletion step.
//
// The deploy layer (functions/, firebase.json, rules) is already purged and the
// data now lives in PostgreSQL. What remains is the SPA's own Firestore usage:
// src/firebase.ts may only be deleted when this counter reaches ZERO, because
// deleting it earlier bricks the running business app. Repoint one module at a
// time to the PG API (server/modules/*), watch the number fall.
const { execSync } = require('node:child_process');

let hits = [];
try {
  const out = execSync(`git grep -n "from 'firebase" -- src/`, { encoding: 'utf8' });
  hits = out.split('\n').filter(Boolean);
} catch { /* grep exits 1 on zero matches — that is the goal state */ }

const byFile = {};
for (const line of hits) {
  const file = line.split(':')[0];
  byFile[file] = (byFile[file] ?? 0) + 1;
}
const files = Object.keys(byFile).sort((a, b) => byFile[b] - byFile[a]);

console.log(`\nFirebase imports remaining in src/: ${hits.length} across ${files.length} files\n`);
if (hits.length === 0) {
  console.log('  ✔ ZERO — safe to: delete src/firebase.ts, npm uninstall firebase,');
  console.log('    and disable project prasad-transport-grup in the console');
  console.log('    (AFTER the parallel-run reconciliation passes — see MIGRATION-FIREBASE-TO-POSTGRES.md)');
} else {
  console.log('  Top modules still to repoint to the PG API:');
  for (const f of files.slice(0, 12)) console.log(`   ${String(byFile[f]).padStart(3)}  ${f}`);
  if (files.length > 12) console.log(`        ... and ${files.length - 12} more`);
  console.log('\n  src/firebase.ts must NOT be deleted until this reads zero.');
}
