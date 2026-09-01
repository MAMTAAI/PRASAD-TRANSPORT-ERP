#!/usr/bin/env node
/**
 * scripts/bulk-vehicle-docs-run.mjs — file a staged batch of vehicle paperwork.
 *
 * The other half of bulk-vehicle-docs.mjs --stage. That one runs on the office
 * PC where the scans are, matches each to a lorry and copies the chosen files
 * into a folder; this runs ON THE BOX and does the writing.
 *
 * WHY HERE AND NOT OVER HTTP. Filing these through the API needs a staff JWT,
 * and the only way to get one without a person logging in is to mint it from
 * JWT_SECRET — walking past the password and the 2FA code that guard every
 * other staff session. A bulk import is not a good reason to build a second
 * door into the front one. On the box no token is needed at all: pool.js,
 * storage.js and universalScan.js are the very modules the API writes through,
 * so this acts as the server rather than as a forged user.
 *
 * WHAT IT WILL NOT DO:
 *   · overwrite. vehicle_documents upserts on (vehicle_id, doc_type), so a
 *     blind run would replace good scans with whatever the matcher guessed.
 *     Rows that already carry a document_url are skipped and counted.
 *   · overwrite a date. An expiry already on file beats an OCR reading; the
 *     scan only fills a blank.
 *   · touch money. No amount, no account, no voucher. The fee a certificate
 *     cost is not reliably on its face, and a ledger entry needs the account it
 *     was paid from, which no filename can supply.
 *
 *   node -r dotenv/config scripts/bulk-vehicle-docs-run.mjs --stage <dir>
 *   node -r dotenv/config scripts/bulk-vehicle-docs-run.mjs --stage <dir> --apply
 *   node -r dotenv/config scripts/bulk-vehicle-docs-run.mjs --stage <dir> --apply --limit 5
 */
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { initDb, query, isDegraded, DB_TARGET } from '../server/db/pool.js';
import { put, publicUrl } from '../server/lib/storage.js';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? d); };

const STAGE = val('stage', '');
const APPLY = has('apply');
const LIMIT = Number(val('limit', '0')) || 0;
if (!STAGE) { console.error('\n  --stage <dir> is required\n'); process.exit(1); }

const MIME = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

const isoDate = (s) => {
  if (!s) return null;
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};

await initDb({ attempts: 2 });
if (isDegraded()) { console.error('\n  no database reachable\n'); process.exit(1); }

const plan = JSON.parse(readFileSync(join(STAGE, 'plan.json'), 'utf8'));
console.log(`\n  database : ${DB_TARGET}`);
console.log(`  staged   : ${plan.length} documents`);
console.log(`  ${APPLY ? 'APPLYING' : 'DRY RUN — pass --apply to write'}\n`);

// The OCR the /scan route uses. Imported lazily so a dry run needs none of it.
let scanDocument = null;
if (APPLY) {
  try { ({ scanDocument } = await import('../server/services/universalScan.js')); }
  catch (e) { console.log(`  (OCR unavailable — filing without dates: ${e.message})\n`); }
}

const todo = LIMIT ? plan.slice(0, LIMIT) : plan;
let filed = 0; let skipped = 0; let failed = 0; let dated = 0;

for (const [i, p] of todo.entries()) {
  const tag = `[${i + 1}/${todo.length}] ${String(p.vehicle_no).padEnd(14)} ${p.doc_name}`;
  try {
    const { rows: existing } = await query(
      `SELECT id, document_url, next_due_date FROM vehicle_documents
        WHERE vehicle_id = $1::uuid AND doc_type = $2`, [p.vehicle_id, p.doc_type]);
    if (existing[0]?.document_url) { console.log(`  SKIP ${tag} — already has a file`); skipped++; continue; }

    if (!APPLY) { console.log(`  WOULD ${tag}`); filed++; continue; }

    const ext = extname(p.staged).toLowerCase();
    const buf = readFileSync(join(STAGE, 'files', p.staged));
    const ct = MIME[ext] ?? 'application/octet-stream';

    // Read before writing, so one upsert carries both the file and the date.
    let due = existing[0]?.next_due_date ? String(existing[0].next_due_date).slice(0, 10) : null;
    let appNo = null;
    if (scanDocument && !due) {
      try {
        // (buffer, opts) — the same call /api/v1/scan makes, so this batch is
        // read by exactly the pipeline the phone and the browser use.
        const ex = await scanDocument(buf, { filename: p.original, source: 'bulk-import' });
        due = isoDate(ex?.expiry_date) ?? null;
        appNo = ex?.document_number ? String(ex.document_number).replace(/[^A-Za-z0-9/-]/g, '').trim() || null : null;
        if (due) dated++;
      } catch { /* a dead scanner must not cost the filing */ }
    }

    const key = `vehicle-docs/${String(p.vehicle_no).replace(/[^A-Za-z0-9]/g, '_')}/${p.doc_type}_${Date.now()}${ext}`;
    await put(key, buf, ct);

    await query(`
      INSERT INTO vehicle_documents
        (vehicle_id, doc_type, doc_name, document_url, next_due_date, application_no)
      VALUES ($1::uuid, $2, $3, $4, $5::date, $6)
      ON CONFLICT (vehicle_id, doc_type) DO UPDATE SET
        doc_name      = EXCLUDED.doc_name,
        document_url  = COALESCE(vehicle_documents.document_url, EXCLUDED.document_url),
        next_due_date = COALESCE(vehicle_documents.next_due_date, EXCLUDED.next_due_date),
        application_no= COALESCE(vehicle_documents.application_no, EXCLUDED.application_no),
        updated_at    = now()`,
      [p.vehicle_id, p.doc_type, p.doc_name, publicUrl(key), due, appNo]);

    // Keep the denormalised column in step, exactly as POST /vehicle-documents
    // does — the compliance view reads both and they must not disagree.
    const COL = {
      fitness: 'fitness_expiry', insurance: 'insurance_expiry', pollution: 'puc_expiry',
      national_permit: 'national_permit_expiry', home_permit: 'permit_expiry', mv_tax: 'tax_expiry',
    }[p.doc_type];
    if (COL && due) {
      await query(`UPDATE vehicles SET ${COL} = COALESCE(${COL}, $2::date), updated_at = now() WHERE id = $1::uuid`,
        [p.vehicle_id, due]);
    }

    console.log(`  OK   ${tag}${due ? ` — expiry ${due}` : ''}`);
    filed++;
  } catch (e) {
    console.log(`  FAIL ${tag} — ${e.message}`);
    failed++;
  }
}

console.log(`\n  ${filed} filed, ${skipped} already had a file, ${failed} failed, ${dated} got an expiry date from OCR.`);
console.log('  Re-run the audit to confirm: /home/ubuntu/erp-work/erp_audit.sh\n');
process.exit(0);
