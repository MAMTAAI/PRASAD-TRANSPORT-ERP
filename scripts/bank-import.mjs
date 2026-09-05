// scripts/bank-import.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Import bank statements in bulk: a folder of SBI PDFs / CSVs, or JSON files
// already produced by tools/bank/parse_sbi_statement.py — then let TARA tally.
//
//   node scripts/bank-import.mjs --dir "C:/Users/.../Bank Statement FY 26-27" [--password-file "…/Password.txt"] [--no-tally]
//   node scripts/bank-import.mjs --json parsed/*.json
//   node scripts/bank-import.mjs --tally            # only re-run TARA on NEW/REVIEW lines
//
// Every file goes through the same importParsed()/tallyAccount() the upload
// endpoint uses; lines are deduped by their uid, so a re-run converges.
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
dotenv.config();

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const DIR = arg('--dir'); const PWFILE = arg('--password-file'); const NO_TALLY = process.argv.includes('--no-tally'); const ONLY_TALLY = process.argv.includes('--tally');
const jsons = (() => { const i = process.argv.indexOf('--json'); return i > -1 ? process.argv.slice(i + 1).filter((a) => !a.startsWith('--')) : []; })();
const PY = process.env.PYTHON_BIN || (fs.existsSync(path.join(REPO, '.venv', 'bin', 'python')) ? path.join(REPO, '.venv', 'bin', 'python') : process.platform === 'win32' ? 'python' : 'python3');

const { initDb, closePool } = await import('../server/db/pool.js');
const { importParsed, tallyAccount, bankSummary } = await import('../server/lib/bankTally.js');
await initDb({ attempts: 1, quiet: true });

const parsedFiles = [...jsons];
if (DIR) {
  const pw = PWFILE && fs.existsSync(PWFILE) ? fs.readFileSync(PWFILE, 'utf8').trim().split(/\r?\n/).pop().trim() : null;
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const files = walk(DIR).filter((f) => /\.(pdf|csv|xlsx)$/i.test(f));
  console.log(`\n parsing ${files.length} statement file(s) from ${DIR}`);
  for (const f of files) {
    const out = f + '.json';
    const args = [path.join(REPO, 'tools', 'bank', 'parse_sbi_statement.py'), '--file', f, '--out', out];
    const r = spawnSync(PY, args, { encoding: 'utf8' });
    if (r.status !== 0 && pw) { const r2 = spawnSync(PY, [...args, '--password', pw], { encoding: 'utf8' }); if (r2.status === 0) { console.log(`  ✓ ${path.basename(f)} (password)`); parsedFiles.push(out); continue; } console.log(`  x ${path.basename(f)}: ${(r2.stderr || r2.stdout).trim().split('\n').pop()}`); continue; }
    if (r.status !== 0) { console.log(`  x ${path.basename(f)}: ${(r.stderr || r.stdout).trim().split('\n').pop()}`); continue; }
    console.log(`  ✓ ${r.stdout.trim().split('\n').pop()}`); parsedFiles.push(out);
  }
}

const stats = { files: 0, rows_new: 0, rows_seen: 0, skipped: [] };
if (!ONLY_TALLY) {
  for (const jf of parsedFiles) {
    const j = JSON.parse(fs.readFileSync(jf, 'utf8'));
    try {
      const imp = await importParsed({ accountNo: j.meta?.account_no, meta: j.meta ?? {}, lines: j.lines ?? [], sourceFile: j.meta?.file ?? path.basename(jf), format: 'JSON', by: 'bank-import' });
      stats.files += 1; stats.rows_new += imp.rows_new; stats.rows_seen += imp.rows_seen;
      console.log(`  → ${imp.account.ledger_name}: ${imp.rows_new} new, ${imp.rows_seen} already held  (${j.meta?.file ?? path.basename(jf)})`);
    } catch (e) { stats.skipped.push(`${path.basename(jf)}: ${e.message}`); console.log(`  x ${path.basename(jf)}: ${e.message}`); }
  }
}
if (!NO_TALLY) {
  console.log('\n TARA tallying…');
  const t = await tallyAccount({ statuses: ['NEW', 'REVIEW'], by: 'agent:TARA', log: console });
  console.log(`  lines ${t.lines} · auto-posted ${t.auto_posted} · linked to book ${t.linked} · review ${t.review} · not ours ${t.not_ours} · errors ${t.errors}`);
}
const s = await bankSummary();
console.log('\n ACCOUNTS');
for (const a of s.accounts) console.log(`  ${a.ledger_name.padEnd(12)} ${String(a.company_name ?? '').padEnd(26)} lines ${String(a.lines).padStart(5)} · auto ${String(a.auto_posted).padStart(4)} · linked ${String(a.linked).padStart(4)} · waiting ${String(a.waiting).padStart(5)} · not ours ${String(a.not_ours).padStart(4)} · bank ${a.bank_closing ?? '—'} · book ${a.book_balance} · book-not-in-bank ${a.book_not_in_bank}`);
console.log(`\n files ${stats.files} · new lines ${stats.rows_new} · already held ${stats.rows_seen}${stats.skipped.length ? '\n skipped: ' + stats.skipped.join(' | ') : ''}`);
await closePool();
