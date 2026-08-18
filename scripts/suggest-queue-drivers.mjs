// ═══════════════════════════════════════════════════════════════════════════
// suggest-queue-drivers.mjs — turn 115 lookups into 115 confirmations.
//
//   node scripts/suggest-queue-drivers.mjs            # dry run
//   node scripts/suggest-queue-drivers.mjs --apply    # write the suggestions
//
// The document import could prove which LORRY each driver document was filed
// under, and nothing more — a vehicle folder does not name its driver. So 115
// Aadhaars, licences and passbooks sit in the queue, each needing a clerk to
// work out whose they are before it can be filed.
//
// But the ERP already knows who drives what. `vehicle_assignments` records the
// current pairing, and `trips` records who actually drove: 573 trips carry both
// a driver and a lorry. That is enough to put a NAME in front of the clerk
// instead of a blank dropdown.
//
// A SUGGESTION, NOT AN ASSIGNMENT.
// Only `suggested_driver_id` is written and the row stays PENDING. Somebody
// still presses the button. A driver who took a lorry out ninety-five times is
// very likely the owner of the Aadhaar in that lorry's folder — likely is not
// the same as true, and a driver's identity document filed against the wrong
// person is a worse mistake than an unfiled one. The evidence and its strength
// are written alongside so the clerk can judge rather than trust.
// ═══════════════════════════════════════════════════════════════════════════
import pg from 'pg';
import dotenv from 'dotenv';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
dotenv.config({ path: join(ROOT, '.env') });
const APPLY = process.argv.includes('--apply');

const c = new pg.Client({
  host: process.env.PGHOST, port: +(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
});
await c.connect();

// Evidence per lorry, strongest first:
//   ASSIGNED  the current pairing in vehicle_assignments — the operator said so
//   DROVE     the driver with the most trips on that lorry — behaviour, not record
const { rows: assigned } = await c.query(`
  SELECT va.vehicle_id, va.driver_id, d.name
    FROM vehicle_assignments va JOIN drivers d ON d.id = va.driver_id
   WHERE va.driver_id IS NOT NULL`);
const byAssignment = new Map(assigned.map((r) => [r.vehicle_id, r]));

const { rows: drove } = await c.query(`
  SELECT vehicle_id, driver_id, name, trips FROM (
    SELECT t.vehicle_id, t.driver_id, d.name, count(*)::int trips,
           row_number() OVER (PARTITION BY t.vehicle_id ORDER BY count(*) DESC) rn
      FROM trips t JOIN drivers d ON d.id = t.driver_id
     WHERE t.driver_id IS NOT NULL AND t.vehicle_id IS NOT NULL
     GROUP BY 1,2,3) x
   WHERE rn = 1`);
const byTrips = new Map(drove.map((r) => [r.vehicle_id, r]));

const { rows: pending } = await c.query(`
  SELECT u.id, u.source_path, u.suggested_doc_name, u.suggested_vehicle_id, v.vehicle_no
    FROM unmapped_documents u LEFT JOIN vehicles v ON v.id = u.suggested_vehicle_id
   WHERE u.status = 'PENDING' AND u.reason = 'DRIVER_DOCUMENT'
   ORDER BY v.vehicle_no, u.source_path`);

const plan = [];
const unresolved = [];
for (const p of pending) {
  const a = byAssignment.get(p.suggested_vehicle_id);
  const t = byTrips.get(p.suggested_vehicle_id);
  if (a) plan.push({ ...p, driver_id: a.driver_id, driver: a.name, basis: 'ASSIGNED', strength: 'current assignment' });
  else if (t) plan.push({ ...p, driver_id: t.driver_id, driver: t.name, basis: 'DROVE', strength: `${t.trips} trips` });
  else unresolved.push(p);
}

const byDriver = plan.reduce((m, r) => (m[r.driver] = (m[r.driver] || 0) + 1, m), {});
console.log(`=== DRIVER SUGGESTIONS FOR THE QUEUE (${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);
console.log(`pending driver documents : ${pending.length}`);
console.log(`  suggestion available   : ${plan.length}`);
console.log(`     from a current assignment : ${plan.filter((r) => r.basis === 'ASSIGNED').length}`);
console.log(`     from trip history         : ${plan.filter((r) => r.basis === 'DROVE').length}`);
console.log(`  no evidence either way : ${unresolved.length}   (stay blank — the clerk picks)`);

console.log('\n--- documents per suggested driver ---');
for (const [d, n] of Object.entries(byDriver).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(`   ${String(n).padStart(3)}  ${d}`);
}
console.log('\n--- sample ---');
for (const r of plan.slice(0, 10)) {
  console.log(`   ${(r.vehicle_no || '?').padEnd(14)} ${String(r.suggested_doc_name).padEnd(18)} -> ${r.driver} (${r.basis}, ${r.strength})`);
}
if (unresolved.length) {
  console.log('\n--- no driver evidence for these lorries ---');
  console.log('   ' + [...new Set(unresolved.map((u) => u.vehicle_no))].join(', '));
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply.');
  console.log('Rows stay PENDING either way: this only pre-fills the name.\n');
  await c.end();
  process.exit(0);
}

let n = 0;
for (const r of plan) {
  await c.query(
    `UPDATE unmapped_documents
        SET suggested_driver_id = $2,
            reason_detail = reason_detail || '  |  suggested driver: ' || $3 || ' (' || $4 || ')',
            updated_at = now()
      WHERE id = $1 AND status = 'PENDING'`,
    [r.id, r.driver_id, r.driver, `${r.basis}: ${r.strength}`]);
  n++;
}
console.log(`\nAPPLIED: ${n} suggestions written. All rows remain PENDING — a person still files them.\n`);
await c.end();
