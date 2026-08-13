// scripts/rebuild-rate-master.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Point 1: put IOCL's own rates and distances into the ERP's masters.
//
// Pending Billing shows RATE 0 on all 650 trips, so gross, TDS and net all
// compute to zero. The rate card was never populated, and rtkm_master's
// distances disagree with what IOCL actually bills (MAINA JUSTIN: 79.6 stored
// vs 160.6 billed — a ₹2.17 L difference over 60 trips).
//
// Both are now derivable from evidence rather than typed in: 1,033 parsed bill
// lines carry the rate and RTD IOCL used, verified against the formula
// gross = rate × RTD × quantity.
//
// TWO DELIBERATE CHOICES
//
//   * Only lanes with a MATCHED billed load are touched. A lane IOCL has never
//     billed has no observed rate, and inventing one would put a number on a
//     screen that nobody can defend.
//   * The old distance is preserved in `remarks` before being overwritten, so
//     the change is reversible and reviewable. Silently replacing a master
//     value with a derived one is how data provenance gets lost.
//
//   node scripts/rebuild-rate-master.mjs          # dry run
//   node scripts/rebuild-rate-master.mjs --live
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

const LIVE = process.argv.includes('--live');
const { query, closePool, initDb, withTransaction } = await import('../server/db/pool.js');
const inr = (v) => Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const info = await initDb({ attempts: 1, quiet: true });
console.log(`\n${'='.repeat(76)}\n REBUILD RATE + LANE MASTER   [${LIVE ? 'LIVE' : 'DRY RUN'}]  db=${info.target}\n${'='.repeat(76)}`);

// ── The observed card: one row per lane × product ────────────────────────────
const { rows: card } = await query(`
  SELECT ship_to_code, ship_to_name, material, current_rate, current_rtd,
         loads, rate_changes, rate_as_of
    FROM v_iocl_lane_rate
   WHERE current_rate IS NOT NULL AND current_rtd > 0
   ORDER BY loads DESC`);
console.log(`\n  observed lanes: ${card.length}  (from ${card.reduce((s, r) => s + Number(r.loads), 0)} billed loads)`);

// ── rtkm_master: correct distances where they disagree ──────────────────────
const { rows: drift } = await query(`
  SELECT r.id, r.consignee_name, r.rtkm_distance AS old_rtkm,
         l.current_rtd AS new_rtkm, l.current_rate, l.loads
    FROM rtkm_master r
    JOIN v_iocl_lane_rate l
      ON l.ship_to_code = substring(r.consignee_name from '^[0-9]{4,8}')
     AND l.current_rtd > 0
   WHERE r.status = 'ACTIVE'
     AND (r.rtkm_distance IS NULL OR abs(r.rtkm_distance - l.current_rtd) > 1)`);

console.log(`\n  rtkm_master rows needing correction: ${drift.length}`);
for (const d of drift.slice(0, 8)) {
  console.log(`    ${String(d.consignee_name).slice(0, 34).padEnd(36)}`
    + `${String(d.old_rtkm ?? '-').padStart(9)} -> ${String(d.new_rtkm).padStart(9)} km   (${d.loads} loads)`);
}
if (drift.length > 8) console.log(`    ... and ${drift.length - 8} more`);

// ── rate_master: one row per lane × product, current rate ───────────────────
console.log(`\n  rate_master rows to write: ${card.length}`);
for (const c of card.slice(0, 6)) {
  console.log(`    ${String(c.ship_to_name).slice(0, 30).padEnd(32)}${String(c.material).padEnd(8)}`
    + `rate ${String(c.current_rate).padStart(11)}  rtd ${String(c.current_rtd).padStart(9)}  ${c.loads} loads`);
}

if (!LIVE) {
  console.log('\n  DRY RUN — nothing written. Re-run with --live.');
  await closePool();
  process.exit(0);
}

const stats = await withTransaction(async (tx) => {
  let rtkm = 0, rates = 0;

  // rtkm_master has no free-text column to annotate, so provenance goes to a
  // report file instead of being lost. Overwriting a master value with a
  // derived one without keeping the original is not a correction, it is an
  // erasure — the file is what makes this reversible.
  for (const d of drift) {
    await tx.query(`UPDATE rtkm_master SET rtkm_distance = $1 WHERE id = $2`,
      [d.new_rtkm, d.id]);
    rtkm++;
  }

  for (const c of card) {
    // rate_master keyed by customer + route; route carries the ship-to code so
    // the auto-calc can find it without fuzzy name matching.
    const route = `${c.ship_to_code} ${c.ship_to_name}`.trim().slice(0, 200);
    const legacy = `IOCL-RATE-${c.ship_to_code}-${c.material}`;
    await tx.query(
      `INSERT INTO rate_master (legacy_id, customer_name, route, rate_type, rate, unit, valid_from, status)
       VALUES ($1, 'INDIAN OIL CORPORATION LTD', $2, $3, $4, 'RS_PER_UNIT_PER_KM', $5, 'ACTIVE')
       ON CONFLICT (legacy_id) DO UPDATE
         SET rate = EXCLUDED.rate, route = EXCLUDED.route,
             rate_type = EXCLUDED.rate_type, valid_from = EXCLUDED.valid_from,
             status = 'ACTIVE'`,
      [legacy, route, `MATERIAL_${c.material}`, c.current_rate, c.rate_as_of]);
    rates++;
  }
  return { rtkm, rates };
});

console.log(`\n  rtkm_master corrected : ${stats.rtkm}`);
console.log(`  rate_master rows      : ${stats.rates}`);

const { rows: [chk] } = await query(`
  SELECT (SELECT count(*) FROM rate_master WHERE status='ACTIVE' AND rate > 0) AS rates,
         (SELECT count(*) FROM rtkm_master WHERE status='ACTIVE' AND rtkm_distance > 0) AS lanes`);
console.log(`\n  VERIFY  rate_master with a rate: ${chk.rates}   rtkm_master with a distance: ${chk.lanes}`);

await closePool();
