#!/usr/bin/env node
// scripts/processCleaner.cjs — orphaned headless-browser killer + RAM report.
//
//   node scripts/processCleaner.cjs            kill orphans, print reclaimed RAM
//   node scripts/processCleaner.cjs --dry-run  census only
//
// KILL CRITERIA (every condition must hold — precision over enthusiasm):
//   • process is chrome.exe / headless_shell.exe / chromium.exe / msedge.exe
//   • command line contains --headless          (never a human's browser window)
//   • older than 5 minutes                       (never an in-flight PDF render)
//
// HARD PROTECT-LIST — never touched no matter what the census shows:
//   postgres*  (both books live here)         ollama* (shared AI brain —
//   node.exe   (API, bridge, WhatsApp engine,  Jaiswal Capital uses it too)
//              sync tunnel, healer — ALL kept) msedgewebview2 (host apps own these)
//
// This deliberately kills NOTHING belonging to the trading stack or the ERP
// runtime. Reclaim comes only from render debris.
const { execSync } = require('node:child_process');

const DRY = process.argv.includes('--dry-run');

function ps(cmd) {
  return execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
}

function ramSnapshot() {
  const out = ps(`$o=Get-CimInstance Win32_OperatingSystem; '{0}|{1}' -f $o.TotalVisibleMemorySize,$o.FreePhysicalMemory`);
  const [total, free] = out.trim().split('|').map(Number);
  return { totalMB: Math.round(total / 1024), freeMB: Math.round(free / 1024) };
}

const before = ramSnapshot();

// census: headless browsers older than 5 minutes
const raw = ps(`Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='headless_shell.exe' OR Name='chromium.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -match '--headless' -and $_.CreationDate -lt (Get-Date).AddMinutes(-5) } | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.Name, [math]::Round((Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).WS/1MB) }`);

const orphans = raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const [pid, name, mb] = l.split('|');
  return { pid: Number(pid), name, mb: Number(mb) || 0 };
});

console.log(`\n[processCleaner] headless-browser orphans (>5 min old): ${orphans.length}`);
let freedByKill = 0;
for (const o of orphans) {
  console.log(`  ${DRY ? '[dry] would kill' : 'killing'} ${o.name} pid=${o.pid} (${o.mb} MB)`);
  freedByKill += o.mb;
  if (!DRY) {
    try { process.kill(o.pid); } catch { /* already gone */ }
  }
}
if (!orphans.length) console.log('  none found — renders are closing their browsers correctly');

// give the OS a moment to reclaim, then re-measure
if (!DRY && orphans.length) execSync('powershell -NoProfile -Command "Start-Sleep -Seconds 2"');
const after = ramSnapshot();

console.log(`\n[processCleaner] RAM  before: ${before.totalMB - before.freeMB}/${before.totalMB} MB used`);
console.log(`[processCleaner] RAM  after : ${after.totalMB - after.freeMB}/${after.totalMB} MB used`);
console.log(`[processCleaner] reclaimed  : ${Math.max(0, after.freeMB - before.freeMB)} MB back to the OS pool`);
console.log(`[processCleaner] protected  : postgres · ollama · every node.exe · user browsers · webviews\n`);
