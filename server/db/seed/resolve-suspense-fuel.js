// server/db/seed/resolve-suspense-fuel.js
// ---------------------------------------------------------------------------
// Moves the fuel-bill reconciliations that the original migration could not
// attribute out of 'MIGRATION: unresolved ledger' (Suspense A/c) and onto the
// fuel pump that is actually owed the money.
//
//   node server/db/seed/resolve-suspense-fuel.js            DRY RUN
//   node server/db/seed/resolve-suspense-fuel.js --live     commit
//
// The six original rows are LEGACY entries: no voucher, no counterpart leg, and
// ledger_entries is append-only by trigger, so they cannot be edited or
// reversed in the usual way. The correction is therefore a fresh balanced
// journal per bill — Dr the suspense account (clearing it) / Cr the pump's
// creditor account — which leaves the original rows exactly as they were and
// records the reattribution as its own auditable event.
//
// HOW A PUMP IS IDENTIFIED, and when it is not. The particulars name no vendor;
// they give a period and a slip count. The slip counts do not agree with
// anything in fuel_entries, so they are ignored. What does identify a bill is
// its amount: for five of the six, exactly ONE pump's fuel entries in the
// stated period total the same figure to within a rupee — Rs 1,44,844.98
// against Rs 1,44,845 is a fingerprint, not a coincidence. Uniqueness is
// required: if two pumps could match, or none does, the entry stays in
// suspense, because a misattributed bill makes one pump appear owed money that
// another is owed, which is worse than an obviously unresolved balance.
// ---------------------------------------------------------------------------
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import 'dotenv/config';
import { initDb, query, closePool, DB_TARGET } from '../pool.js';
import { postVoucher } from '../../agents/tara.js';

const LIVE = process.argv.includes('--live');
const SUSPENSE = 'MIGRATION: unresolved ledger';
const TOLERANCE = 1;              // rupees

await initDb();
console.log(`[suspense-fuel] ${LIVE ? 'LIVE' : 'DRY-RUN'} - target ${DB_TARGET}`);
const q = async (s, p = []) => (await query(s, p)).rows;

// Pull the period straight out of the particulars the migration wrote.
const rows = await q(
  `SELECT id, entry_date::text AS d, amount, particulars
     FROM ledger_entries WHERE ledger_name = $1 AND dr_cr = 'CR' ORDER BY id`, [SUSPENSE]);

const report = { target: DB_TARGET, mode: LIVE ? 'LIVE' : 'DRY-RUN', resolved: [], left: [] };
let moved = 0;

for (const r of rows) {
  const m = String(r.particulars).match(/Period:\s*(\d{2})\/(\d{2})\/(\d{4})\s*to\s*(\d{2})\/(\d{2})\/(\d{4})/);
  // One row states no period. Fall back to the fortnight its entry_date sits in,
  // which is how these bills are cut, and let the uniqueness test decide.
  const from = m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  const to = m ? `${m[6]}-${m[5]}-${m[4]}` : null;
  const amt = Number(r.amount);
  let cands = [];
  if (from && to) {
    cands = await q(
      `SELECT coalesce(vendor_name,'(none)') AS pump, round(sum(amount),2) AS total, count(*)::int AS n
         FROM fuel_entries WHERE entry_date BETWEEN $1::date AND $2::date
         GROUP BY 1 HAVING abs(round(sum(amount),2) - $3::numeric) <= $4`, [from, to, amt, TOLERANCE]);
  }
  if (cands.length !== 1) {
    report.left.push({ id: r.id, amount: amt, why: cands.length ? `ambiguous: ${cands.map((c) => c.pump).join(' / ')}` : 'no pump in the stated period totals this amount', particulars: r.particulars });
    console.log(`  LEFT   #${r.id} Rs ${amt}  ${cands.length ? 'ambiguous' : 'no unique match'}`);
    continue;
  }
  const pump = cands[0].pump;
  const creditor = `Creditors: ${pump}`;
  const v = {
    type: 'JOURNAL', entry_date: r.d, source_type: 'SUSPENSE_RESOLUTION',
    ref_no: `SUSPENSE-FIX-${r.id}`,
    narration: `Fuel bill reattributed from suspense to ${pump} (matched on period total Rs ${cands[0].total} across ${cands[0].n} slips)`,
    created_by: 'history-migration',
    lines: [
      { ledger: SUSPENSE, dr_cr: 'DR', amount: amt, group: 'Suspense A/c' },
      { ledger: creditor, dr_cr: 'CR', amount: amt, group: 'Sundry Creditors (Fuel Pumps)' },
    ],
  };
  if (LIVE) {
    try { const out = await postVoucher(v); report.resolved.push({ id: r.id, amount: amt, pump, voucher_id: out.voucher_id }); }
    catch (e) {
      if (e.code === 'DUPLICATE_REF' || /duplicate/i.test(e.message || '')) { console.log(`  SKIP   #${r.id} already corrected`); continue; }
      throw e;
    }
  } else report.resolved.push({ id: r.id, amount: amt, pump });
  moved += amt;
  console.log(`  MOVE   #${r.id} Rs ${amt}  ->  ${creditor}`);
}

const [bal] = await q(
  `SELECT to_char(coalesce(sum(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0),'FM99999990.00') AS net
     FROM ledger_entries WHERE ledger_name = $1`, [SUSPENSE]);
console.log(`\n  moved Rs ${moved.toFixed(2)} across ${report.resolved.length} bill(s); ${report.left.length} left in suspense`);
console.log(`  suspense net balance now: ${bal.net} (negative = still sitting there as a credit)`);
const out = join(process.cwd(), 'backups', `suspense-fix-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
console.log(`  report: ${out}`);
if (!LIVE) console.log('\n  DRY RUN - nothing posted.');
await closePool();
