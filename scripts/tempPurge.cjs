#!/usr/bin/env node
// scripts/tempPurge.cjs — temp-file lifecycle cleanup for the ERP workstation.
//
//   node scripts/tempPurge.cjs            clean now, print reclaimed bytes
//   node scripts/tempPurge.cjs --dry-run  report what WOULD be removed
//
// WHAT IT TOUCHES (exhaustive — nothing outside this list):
//   • *.log over 10MB under logs/ and whatsapp-server/  → rotated in place
//     (last 2,000 lines kept, so live tails keep working; PM2/tasks unharmed)
//   • public/temp/**                                     → deleted (scratch dir)
//   • *.tmp anywhere under the repo (excluding node_modules/.git)
//   • %TEMP%\playwright-* and %TEMP%\puppeteer_dev_* older than 24h
//   • %TEMP%\api*.log session-debug leftovers older than 24h
//
// WHAT IT WILL NEVER TOUCH (by design, hard-coded):
//   • uploads/  — scanned bills are FINANCIAL AUDIT EVIDENCE (documents.storage_path
//     points at them; Bhuvaneshwari's artefact-retained guard). Purging a bill
//     image after OCR would destroy the proof behind a ledger entry.
//   • backups/, data/ (SQLite security events, tesseract traineddata cache),
//     dist/ (deployable build), .env*, any source file, node_modules.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DRY = process.argv.includes('--dry-run');
const ROOT = path.join(__dirname, '..');
const TMP = os.tmpdir();
const MB = 1024 * 1024;
const LOG_CAP = 10 * MB;
const KEEP_LINES = 2000;
const DAY_MS = 24 * 3600 * 1000;

let reclaimed = 0;
const actions = [];
const act = (what, bytes) => { actions.push(`  ${DRY ? '[dry] ' : ''}${what} (${(bytes / MB).toFixed(1)} MB)`); reclaimed += bytes; };

const safeStat = (p) => { try { return fs.statSync(p); } catch { return null; } };

// 1 ── oversize log rotation (truncate-in-place keeps file handles valid)
function rotateLogs(dir) {
  const st = safeStat(dir);
  if (!st?.isDirectory()) return;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const s = safeStat(p);
    if (!s) continue;
    if (s.isDirectory() && f !== 'node_modules' && f !== '.git') { rotateLogs(p); continue; }
    if (!/\.log$/i.test(f) || s.size <= LOG_CAP) continue;
    if (!DRY) {
      const tail = fs.readFileSync(p, 'utf8').split('\n').slice(-KEEP_LINES).join('\n');
      fs.writeFileSync(p, `[tempPurge] rotated ${new Date().toISOString()} — kept last ${KEEP_LINES} lines\n${tail}`);
    }
    act(`rotated oversize log ${path.relative(ROOT, p)}`, s.size - Math.min(s.size, KEEP_LINES * 200));
  }
}

// 2 ── recursive delete helper (files + dirs), returns bytes
function rmrf(p) {
  const s = safeStat(p);
  if (!s) return 0;
  let bytes = 0;
  if (s.isDirectory()) {
    for (const f of fs.readdirSync(p)) bytes += rmrf(path.join(p, f));
    if (!DRY) fs.rmdirSync(p, { recursive: false });
  } else {
    bytes = s.size;
    if (!DRY) fs.unlinkSync(p);
  }
  return bytes;
}

// 3 ── *.tmp sweep inside the repo (skip protected dirs)
const PROTECT = new Set(['node_modules', '.git', 'uploads', 'backups', 'data', 'dist']);
function sweepTmp(dir) {
  const st = safeStat(dir);
  if (!st?.isDirectory()) return;
  for (const f of fs.readdirSync(dir)) {
    if (PROTECT.has(f)) continue;
    const p = path.join(dir, f);
    const s = safeStat(p);
    if (!s) continue;
    if (s.isDirectory()) sweepTmp(p);
    else if (/\.tmp$/i.test(f)) { const b = s.size; if (!DRY) fs.unlinkSync(p); act(`deleted ${path.relative(ROOT, p)}`, b); }
  }
}

// ── run ─────────────────────────────────────────────────────────────────────
rotateLogs(path.join(ROOT, 'logs'));
rotateLogs(path.join(ROOT, 'whatsapp-server'));

const scratch = path.join(ROOT, 'public', 'temp');
if (safeStat(scratch)) act(`cleared public/temp/`, rmrf(scratch));

sweepTmp(ROOT);

// stale headless-browser profiles + session debug logs in the OS temp dir
for (const f of fs.readdirSync(TMP)) {
  const isBrowserScratch = /^(playwright-.*|puppeteer_dev_.*)$/i.test(f);
  const isSessionLog = /^api\d*\.log$/i.test(f);
  if (!isBrowserScratch && !isSessionLog) continue;
  const p = path.join(TMP, f);
  const s = safeStat(p);
  if (!s || Date.now() - s.mtimeMs < DAY_MS) continue; // 24h grace — never yank an active render
  const b = rmrf(p);
  if (b) act(`removed stale ${f}`, b);
}

console.log(`\n[tempPurge] ${DRY ? 'DRY RUN — ' : ''}${actions.length} action(s):`);
for (const a of actions) console.log(a);
if (!actions.length) console.log('  nothing to purge — workspace already clean');
console.log(`[tempPurge] disk reclaimed: ${(reclaimed / MB).toFixed(1)} MB\n`);
