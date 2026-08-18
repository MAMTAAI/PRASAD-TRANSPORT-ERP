// ═══════════════════════════════════════════════════════════════════════════
// import-vehicle-documents.mjs — load the Vehicle Document Vault from the
// operator's folder tree.
//
//   node scripts/import-vehicle-documents.mjs --src "<folder>" [--map map.json]
//   node scripts/import-vehicle-documents.mjs --src "<folder>" --map map.json --apply
//   node scripts/import-vehicle-documents.mjs --src "<folder>" --emit-map
//
// The tree is  <category>/<vehicle>/<document>.pdf , and the filename carries
// what the register needs: which document it is and when it expires.
//   "8666 Insurance valid 06.01.2027.pdf"  ->  insurance, 2027-01-06
//   "0831 RC-26-02-34.JPG"                 ->  rc,        2034-02-26
//
// MATCHING IS BY FULL REGISTRATION, NEVER BY THE LAST FOUR DIGITS.
// Last-4 looked fine until this tree produced "ETHANOL TANKERS/AS26C9811/9808
// National permit.pdf" — one truck's permit inside another truck's folder. A
// folder-level match files it against 9811, and a register that says the wrong
// lorry holds a valid national permit is worse than one that says nothing.
// Evidence, in order: the file's own registration, then the folder's, then the
// operator-reviewed map. Nothing else attaches.
//
// NOTHING IS SKIPPED.
// What cannot be proven goes to `unmapped_documents` with the reason and the
// parser's best suggestion, and shows up in the Unmapped queue on the Vault
// screen. A skipped file is invisible, and invisible paperwork is
// indistinguishable from paperwork nobody ever scanned.
//
// WHAT THIS DOES NOT INVENT
// `amount` is the fee paid. No fee appears anywhere in these filenames, so
// every row is written with amount NULL rather than 0 — a zero would read as
// "this document was free", which is a different and false claim. Fees arrive
// separately via scripts/import-document-fees.mjs.
// ═══════════════════════════════════════════════════════════════════════════
import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, extname, basename, relative } from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  classifyDocument, findRegistrations, firstDate, fleetNumberIn, normReg, DRIVER_FOLDER_RE,
} from '../server/lib/docPatterns.js';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
dotenv.config({ path: join(ROOT, '.env') });

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SRC = args[args.indexOf('--src') + 1];
// An operator-reviewed folder -> full registration table. NOT the old last-4
// heuristic wearing a hat: the heuristic guessed silently at import time, this
// is a checked-in file a human signed off, and a folder absent from it is
// refused rather than assumed.
const MAP_FILE = args.includes('--map') ? args[args.indexOf('--map') + 1] : null;
const EMIT_MAP = args.includes('--emit-map');
const VAULT = process.env.VEHICLE_DOC_VAULT
  || join(process.env.LOCAL_STORAGE_PATH || 'F:/Prasad_Transport_Data', 'vehicle-documents');
const QUEUE_DIR = join(VAULT, '_unmapped');

if (!SRC || !existsSync(SRC)) {
  console.error('usage: --src "<documents folder>" [--map <map.json>] [--emit-map] [--apply]');
  process.exit(1);
}

const MAP = new Map();
if (MAP_FILE && existsSync(MAP_FILE)) {
  for (const [k, v] of Object.entries(JSON.parse(readFileSync(MAP_FILE, 'utf8')))) {
    if (!k.startsWith('_') && v) MAP.set(k, v);
  }
}

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
};
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

const main = async () => {
  const client = new pg.Client({
    host: process.env.PGHOST, port: +(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  });
  await client.connect();
  const { rows: vehicles } = await client.query('SELECT id, vehicle_no FROM vehicles');

  const byFull = new Map(vehicles.map((v) => [normReg(v.vehicle_no), v]));
  // Last-4 is used ONLY to notice a file disagreeing with its folder, and to
  // offer a candidate in --emit-map. It never decides a match.
  const digitsToReg = new Map();
  for (const v of vehicles) {
    const d = v.vehicle_no.replace(/\D/g, '').slice(-4);
    if (!digitsToReg.has(d)) digitsToReg.set(d, []);
    digitsToReg.get(d).push(v);
  }

  const matched = [], queue = [], noDate = [];
  const unresolvedFolders = [], conflictFolders = [];

  for (const cat of readdirSync(SRC)) {
    const catPath = join(SRC, cat);
    if (!statSync(catPath).isDirectory()) continue;
    for (const veh of readdirSync(catPath)) {
      const vehPath = join(catPath, veh);
      if (!statSync(vehPath).isDirectory()) continue;

      const files = walk(vehPath).filter((f) => !/^desktop\.ini$|thumbs\.db$/i.test(basename(f)));
      const folderKey = `${cat}/${veh}`;

      // FOLDER IDENTITY: the folder name, plus any full registration a file
      // inside it carries. Both must agree on one vehicle.
      const evidence = new Set(findRegistrations(veh, byFull));
      for (const f of files) for (const r of findRegistrations(basename(f), byFull)) evidence.add(r);

      let folderVehicle = null, folderBasis = null;
      if (evidence.size === 1) { folderVehicle = byFull.get([...evidence][0]); folderBasis = 'folder-reg'; }
      else if (evidence.size > 1) {
        conflictFolders.push({ folder: folderKey, regs: [...evidence].map((r) => byFull.get(r).vehicle_no) });
      } else if (MAP.has(folderKey)) {
        const want = normReg(MAP.get(folderKey));
        if (byFull.has(want)) { folderVehicle = byFull.get(want); folderBasis = 'operator-map'; }
        else conflictFolders.push({ folder: folderKey, regs: [`${MAP.get(folderKey)} (NOT IN MASTER)`] });
      } else {
        const d = veh.replace(/\D/g, '').slice(-4);
        unresolvedFolders.push({
          folder: folderKey, files: files.length,
          candidate: (digitsToReg.get(d) || []).map((v) => v.vehicle_no).join(' / ') || '(none in master)',
        });
      }

      const folderDigits = veh.replace(/\D/g, '').slice(-4);

      for (const file of files) {
        const rel = relative(SRC, file);
        const name = basename(file);
        const parentDir = basename(join(file, '..')) === veh ? '' : basename(join(file, '..'));
        // The path of this file BELOW its vehicle folder — "Driver Details/DL.pdf".
        const inner = relative(vehPath, file);
        // The importer is the one caller that genuinely HAS a path, so it is the
        // one that gets to say a file was filed under a driver folder. The
        // classifier no longer guesses this from text.
        const cls = classifyDocument(name, parentDir, { driverContext: DRIVER_FOLDER_RE.test(inner) });
        const expiry = firstDate(name, parentDir);

        const toQueue = (reason, detail, extra = {}) => queue.push({
          file, rel, reason, detail,
          scope: cls?.scope ?? null, doc_type: cls?.type ?? null, doc_name: cls?.label ?? null,
          vehicle: folderVehicle ?? null, expiry, ...extra,
        });

        // Driver paperwork belongs to a person. `drivers` already has columns
        // for it; a vehicle folder cannot say WHICH driver, so it queues for a
        // human to link rather than being filed against the lorry.
        if (cls?.scope === 'DRIVER') { toQueue('DRIVER_DOCUMENT', `driver paperwork found under ${folderKey}`); continue; }
        if (!cls) { toQueue('UNCLASSIFIED', 'no document type matched the filename'); continue; }

        // FILE IDENTITY beats folder identity: the document names its own truck.
        const own = findRegistrations(name, byFull);
        let v = null, basis = null;
        if (own.length === 1) { v = byFull.get(own[0]); basis = 'file-reg'; }
        else if (own.length > 1) {
          toQueue('MISFILED', `filename names ${own.map((r) => byFull.get(r).vehicle_no).join(' and ')}`); continue;
        } else {
          const tok = fleetNumberIn(name);
          if (tok && folderDigits && tok !== folderDigits) {
            const claims = (digitsToReg.get(tok) || []).map((x) => x.vehicle_no).join(' / ') || 'a truck not in the master';
            toQueue('MISFILED', `file names ${tok} (${claims}) but sits in ${folderVehicle?.vehicle_no ?? folderKey}`);
            continue;
          }
          if (!folderVehicle) { toQueue('NO_VEHICLE_PROOF', `no full registration in "${veh}" or any file inside it`); continue; }
          v = folderVehicle; basis = folderBasis;
        }

        if (!expiry) noDate.push({ rel, vehicle: v.vehicle_no, type: cls.type });
        matched.push({ file, rel, vehicle: v, type: cls.type, label: cls.label, expiry, category: cat, basis });
      }
    }
  }

  // One row per (vehicle, doc_type) — the table enforces it. When a truck that
  // changed fleets keeps documents under both its old and new category, the
  // LATER expiry is the live one.
  const best = new Map();
  let superseded = 0;
  for (const m of matched) {
    const k = m.vehicle.id + '|' + m.type;
    const prev = best.get(k);
    if (!prev) { best.set(k, m); continue; }
    best.set(k, (m.expiry || '') > (prev.expiry || '') ? m : prev);
    superseded++;
  }
  const finalRows = [...best.values()];
  const withDocs = new Set(finalRows.map((r) => r.vehicle.vehicle_no));
  const noDocs = vehicles.map((v) => v.vehicle_no).filter((n) => !withDocs.has(n)).sort();
  const byBasis = matched.reduce((a, r) => (a[r.basis] = (a[r.basis] || 0) + 1, a), {});
  const byReason = queue.reduce((a, r) => (a[r.reason] = (a[r.reason] || 0) + 1, a), {});

  // ── report ───────────────────────────────────────────────────────────────
  console.log(`=== VEHICLE DOCUMENT VAULT IMPORT (${APPLY ? 'APPLY' : 'DRY RUN'}) ===`);
  console.log('    matching: FULL REGISTRATION ONLY - no last-4 fallback\n');
  console.log(`source        : ${SRC}`);
  console.log(`vault         : ${VAULT}`);
  console.log(`vehicles (db) : ${vehicles.length}`);
  console.log('');
  console.log(`PROVEN -> vehicle_documents : ${finalRows.length} rows from ${matched.length} files (${superseded} superseded)`);
  console.log(`   by file registration  : ${byBasis['file-reg'] || 0}`);
  console.log(`   by folder registration: ${byBasis['folder-reg'] || 0}`);
  console.log(`   by operator map       : ${byBasis['operator-map'] || 0}`);
  console.log('');
  console.log(`QUEUED -> unmapped_documents : ${queue.length} files (nothing skipped)`);
  for (const [r, n] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${r}`);
  console.log('');
  console.log(`missing expiry: ${noDate.length}   (imported with next_due_date NULL)`);
  console.log(`vehicles with no proven documents: ${noDocs.length}`);

  if (conflictFolders.length) {
    console.log('\n--- CONFLICTING EVIDENCE ---');
    conflictFolders.forEach((r) => console.log(`   ${r.folder} -> ${r.regs.join(' , ')}`));
  }
  if (unresolvedFolders.length) {
    console.log('\n--- FOLDERS WITH NO FULL REGISTRATION (add to the map to import) ---');
    unresolvedFolders.forEach((r) => console.log(`   ${String(r.files).padStart(3)} files  ${r.folder.padEnd(38)} candidate: ${r.candidate}`));
  }
  const byType = {};
  for (const r of finalRows) byType[r.type] = (byType[r.type] || 0) + 1;
  console.log('\n--- rows by document type ---');
  for (const [t, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${t}`);
  const qByType = {};
  for (const r of queue) qByType[r.doc_type || '(unknown)'] = (qByType[r.doc_type || '(unknown)'] || 0) + 1;
  console.log('\n--- queued by suggested type ---');
  for (const [t, n] of Object.entries(qByType).sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(4)}  ${t}`);
  if (noDocs.length) { console.log('\n--- vehicles with NO proven documents ---'); console.log('   ' + noDocs.join(', ')); }

  if (EMIT_MAP) {
    const out = {
      _README: 'Operator-reviewed folder -> full registration. Every value must be an exact vehicle_no from the master. A folder not listed here is REFUSED, not guessed.',
    };
    for (const u of unresolvedFolders) out[u.folder] = u.candidate.includes(' / ') ? '' : u.candidate;
    const dest = MAP_FILE ?? 'scripts/vehicle-folder-map.json';
    writeFileSync(dest, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${dest} with ${unresolvedFolders.length} folders for review.`);
  }

  if (!APPLY) { console.log('\nDRY RUN - nothing written. Re-run with --apply.'); await client.end(); return; }

  // ── write ────────────────────────────────────────────────────────────────
  let copied = 0, inserted = 0;
  for (const r of finalRows) {
    const destDir = join(VAULT, r.vehicle.vehicle_no.replace(/\s+/g, '_'));
    mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, `${r.type}${extname(r.file)}`);
    copyFileSync(r.file, dest);
    copied++;
    await client.query(
      `INSERT INTO vehicle_documents (vehicle_id, doc_type, doc_name, next_due_date, document_url, remarks)
       VALUES ($1, $2, $3, $4::date, $5, $6)
       ON CONFLICT (vehicle_id, doc_type) DO UPDATE
         SET doc_name = EXCLUDED.doc_name,
             -- A filename date is only as good as whoever typed the filename.
             -- Re-running the importer must not overwrite a date a person has
             -- since corrected on the screen, so an existing value stands and
             -- only a missing one gets filled.
             next_due_date = COALESCE(vehicle_documents.next_due_date, EXCLUDED.next_due_date),
             document_url = EXCLUDED.document_url, remarks = EXCLUDED.remarks, updated_at = now()`,
      [r.vehicle.id, r.type, r.label, r.expiry, dest, `imported from ${r.rel}`]);
    inserted++;
  }

  mkdirSync(QUEUE_DIR, { recursive: true });
  let queued = 0;
  for (const q of queue) {
    const hash = sha(q.file);
    const dest = join(QUEUE_DIR, `${hash.slice(0, 16)}${extname(q.file)}`);
    if (!existsSync(dest)) copyFileSync(q.file, dest);
    await client.query(
      `INSERT INTO unmapped_documents
         (source_path, stored_path, file_hash, file_size, reason, reason_detail,
          suggested_scope, suggested_doc_type, suggested_doc_name, suggested_vehicle_id, suggested_expiry)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date)
       ON CONFLICT (file_hash) DO UPDATE
         SET source_path = EXCLUDED.source_path, reason = EXCLUDED.reason,
             reason_detail = EXCLUDED.reason_detail,
             suggested_scope = EXCLUDED.suggested_scope,
             suggested_doc_type = EXCLUDED.suggested_doc_type,
             suggested_doc_name = EXCLUDED.suggested_doc_name,
             suggested_vehicle_id = EXCLUDED.suggested_vehicle_id,
             suggested_expiry = EXCLUDED.suggested_expiry,
             updated_at = now()
         WHERE unmapped_documents.status = 'PENDING'`,
      [q.rel, dest, hash, statSync(q.file).size, q.reason, q.detail,
       q.scope, q.doc_type, q.doc_name, q.vehicle?.id ?? null, q.expiry]);
    queued++;
  }

  console.log(`\nAPPLIED: ${copied} files to the vault, ${inserted} vehicle_documents rows, ${queued} queued for review.`);
  await client.end();
};

main().catch((e) => { console.error('FATAL: ' + e.message); process.exit(1); });
