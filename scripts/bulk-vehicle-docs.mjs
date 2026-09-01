#!/usr/bin/env node
/**
 * scripts/bulk-vehicle-docs.mjs — read a folder of vehicle paperwork and file it.
 *
 * The office keeps ~2,100 scans in `vehical doc/` and the ERP holds 536 document
 * rows for 49 lorries. Doing that by hand is a fortnight of clicking, so this
 * matches each file to a vehicle, works out which paper it is, and (with
 * --apply) uploads it and saves the row.
 *
 * MATCHING IS ON THE LAST FOUR DIGITS OF THE PLATE, and that is safe here for a
 * reason worth writing down rather than assuming: all 49 active vehicles have a
 * DISTINCT last-four (checked — zero collisions). Filenames in this folder are
 * things like "3054 AIP Upto 24.10.2021.pdf", so the four digits are usually the
 * only identifier present. If a lorry is ever added whose last-four repeats an
 * existing one, this script must start refusing that pair instead of guessing:
 * attaching one man's insurance to another lorry is worse than filing nothing.
 *
 * A FILE THAT CANNOT BE PLACED IS REPORTED, NEVER GUESSED. No fuzzy nearest
 * match, no "probably the RC". Unmatched files are listed so a person can look.
 *
 * DRY RUN BY DEFAULT. --apply is the only thing that writes, and even then it
 * never overwrites a document that already has a file: vehicle_documents upserts
 * on (vehicle_id, doc_type), so a blind run would replace good scans with
 * whatever this guessed. Existing rows with a file are skipped and counted.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: post money. Fees are not read from these
 * PDFs and no ledger entry is made. See the note in the summary output.
 *
 *   node scripts/bulk-vehicle-docs.mjs --dir "<path>" --vehicles vehicles.json
 *   node scripts/bulk-vehicle-docs.mjs --dir "<path>" --vehicles vehicles.json --apply --api <url> --token <jwt>
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const val = (n, d) => { const i = argv.indexOf(`--${n}`); return i === -1 ? d : (argv[i + 1] ?? d); };

const DIR = val('dir', '');
const VEHICLES = val('vehicles', '');
const APPLY = has('apply');
const LIMIT = Number(val('limit', '0')) || 0;

if (!DIR || !VEHICLES) {
  console.error('\n  --dir and --vehicles are required\n');
  process.exit(1);
}

const READABLE = new Set(['.pdf', '.jpg', '.jpeg', '.png']);

/** Which paper is this? Ordered most-specific first: "national permit" must be
 *  tested before "permit", or every permit becomes a home permit. */
const DOC_RULES = [
  [/national\s*permit|\bnp\b|\baip\b|all\s*india/i, 'national_permit', 'National Permit'],
  [/home\s*state|home\s*permit|assam\s*permit|state\s*permit/i, 'home_permit', 'Home State Permit'],
  [/road\s*tax|\bmv\s*tax\b|\btax\b/i, 'mv_tax', 'Road Tax'],
  [/insurance|policy|\bins\b/i, 'insurance', 'Insurance'],
  [/fitness|\bfc\b/i, 'fitness', 'Fitness Certificate'],
  [/pollution|\bpuc\b/i, 'pollution', 'PUC'],
  [/explosive|peso/i, 'explosive', 'PESO / Explosive Licence'],
  [/calibrat/i, 'calibration', 'Calibration'],
  [/rule\s*18|hydro/i, 'rule18', 'Rule 18 (Hydro Test)'],
  [/rule\s*43|safety/i, 'rule43', 'Rule 43 (Safety Cert)'],
  [/\bcii\b/i, 'cii', 'CII Insurance'],
  [/\brc\b|registration/i, 'custom_rc', 'RC'],
];

const vehicles = JSON.parse(readFileSync(VEHICLES, 'utf8'));
const byLast4 = new Map();
for (const v of vehicles) {
  const l4 = String(v.vehicle_no).replace(/\D/g, '').slice(-4);
  if (!byLast4.has(l4)) byLast4.set(l4, []);
  byLast4.get(l4).push(v);
}
// The guarantee this whole script rests on, re-checked at run time rather than
// trusted from the day it was written.
const collisions = [...byLast4.entries()].filter(([, v]) => v.length > 1);
if (collisions.length) {
  console.error('\n  REFUSING TO RUN — these vehicles share a last-four, so a filename cannot identify one:');
  collisions.forEach(([k, v]) => console.error(`    ${k}: ${v.map((x) => x.vehicle_no).join(', ')}`));
  console.error('  Match on something else before using this.\n');
  process.exit(1);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('~$') || name.startsWith('.')) continue;   // Office temp files
    const p = join(dir, name);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (READABLE.has(extname(name).toLowerCase())) out.push(p);
  }
  return out;
}

/** Every 4-digit run in the name, longest-plate-first. A name may carry a date
 *  ("upto 24.10.2021") whose year is also four digits, so a token that matches a
 *  real plate wins and a year that matches nothing is simply ignored. */
const tokensOf = (name) => (name.match(/\d{4,}/g) ?? [])
  .flatMap((t) => (t.length === 4 ? [t] : [t.slice(-4), t.slice(0, 4)]));

const classify = (name) => {
  for (const [re, type, label] of DOC_RULES) if (re.test(name)) return { type, label };
  return null;
};

const files = walk(DIR);
const plan = [];
const unmatchedVehicle = [];
const unmatchedType = [];

for (const f of files) {
  const name = basename(f);
  const hits = [...new Set(tokensOf(name))].map((t) => byLast4.get(t)).filter(Boolean).flat();
  const uniq = [...new Map(hits.map((v) => [v.id, v])).values()];
  if (uniq.length !== 1) { unmatchedVehicle.push({ file: f, why: uniq.length ? 'more than one vehicle in the name' : 'no plate digits' }); continue; }
  const kind = classify(name);
  if (!kind) { unmatchedType.push({ file: f, vehicle: uniq[0].vehicle_no }); continue; }
  plan.push({ file: f, name, vehicle_id: uniq[0].id, vehicle_no: uniq[0].vehicle_no, ...kind, bytes: statSync(f).size });
}

// One file per (vehicle, doc_type): the table upserts on that pair, so sending
// five RCs for one lorry would just overwrite the same row five times. Newest
// name wins only as a tie-break — there is no date in most of these.
const chosen = new Map();
for (const p of plan) {
  const k = `${p.vehicle_id}|${p.type}`;
  const prev = chosen.get(k);
  if (!prev || p.bytes > prev.bytes) chosen.set(k, p);   // bigger scan = more pages
}
const finalPlan = [...chosen.values()].sort((a, b) => a.vehicle_no.localeCompare(b.vehicle_no) || a.type.localeCompare(b.type));

console.log(`\n  folder      : ${DIR}`);
console.log(`  readable    : ${files.length} files`);
console.log(`  matched     : ${plan.length} (vehicle + document type both identified)`);
console.log(`  to upload   : ${finalPlan.length} after one-per-(vehicle,type)`);
console.log(`  no vehicle  : ${unmatchedVehicle.length}`);
console.log(`  no doc type : ${unmatchedType.length}`);

const byType = {};
for (const p of finalPlan) byType[p.label] = (byType[p.label] ?? 0) + 1;
console.log('\n  by document type:');
Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`    ${String(k).padEnd(26)} ${n}`));

const vehSet = new Set(finalPlan.map((p) => p.vehicle_no));
console.log(`\n  vehicles covered: ${vehSet.size} of ${vehicles.length}`);
const missing = vehicles.filter((v) => !vehSet.has(v.vehicle_no)).map((v) => v.vehicle_no);
if (missing.length) console.log(`  no file found for: ${missing.join(', ')}`);

if (unmatchedVehicle.length) {
  console.log('\n  first 10 that name no vehicle (left alone, never guessed):');
  unmatchedVehicle.slice(0, 10).forEach((u) => console.log(`    ${basename(u.file)}  — ${u.why}`));
}

if (!APPLY) {
  console.log('\n  DRY RUN — nothing uploaded, nothing written.');
  console.log('  Fees and ledger entries are NOT part of this job: the amount a');
  console.log('  certificate cost is not reliably on its face, and posting money');
  console.log('  needs the account it left, which a filename cannot supply.\n');
  process.exit(0);
}

// ── apply ──────────────────────────────────────────────────────────────────
const API = val('api', '');
const TOKEN = val('token', '');
if (!API || !TOKEN) { console.error('\n  --apply needs --api and --token\n'); process.exit(1); }
console.log(`\n  APPLYING to ${API}\n`);

let ok = 0; let skipped = 0; let failed = 0;
const todo = LIMIT ? finalPlan.slice(0, LIMIT) : finalPlan;
for (const [i, p] of todo.entries()) {
  const tag = `[${i + 1}/${todo.length}] ${p.vehicle_no} ${p.label}`;
  try {
    const existing = await fetch(`${API}/api/v1/masters/vehicle-documents?vehicle_id=${p.vehicle_id}&limit=200`,
      { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json()).catch(() => ({}));
    const have = (existing.documents ?? []).find((d) => d.doc_type === p.type && d.document_url);
    if (have) { console.log(`  SKIP ${tag} — already has a file`); skipped++; continue; }

    const buf = readFileSync(p.file);
    const form = new FormData();
    form.append('source', 'bulk-vehicle-docs');
    form.append('file', new Blob([buf]), p.name);
    const scan = await fetch(`${API}/api/v1/scan`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: form,
    }).then((r) => r.json()).catch(() => ({}));

    const up = new FormData();
    up.append('file', new Blob([buf]), p.name);
    up.append('path', `vehicle-docs/${p.vehicle_no.replace(/\s+/g, '_')}/${p.type}_${Date.now()}${extname(p.name).toLowerCase()}`);
    const stored = await fetch(`${API}/api/v1/files`, {
      method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: up,
    }).then((r) => r.json()).catch(() => ({}));
    if (!stored?.url) throw new Error('upload returned no url');

    const res = await fetch(`${API}/api/v1/masters/vehicle-documents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        vehicle_id: p.vehicle_id, doc_type: p.type, doc_name: p.label,
        document_url: stored.url,
        next_due_date: scan?.expiry_date || null,
        application_no: scan?.document_number || null,
        // no amount, no account: this job does not move money.
      }),
    });
    if (!res.ok) throw new Error(`save HTTP ${res.status}`);
    console.log(`  OK   ${tag}${scan?.expiry_date ? ` — expiry ${scan.expiry_date}` : ''}`);
    ok++;
  } catch (e) {
    console.log(`  FAIL ${tag} — ${e.message}`);
    failed++;
  }
}
console.log(`\n  ${ok} filed, ${skipped} already had a file, ${failed} failed.\n`);
process.exit(0);
