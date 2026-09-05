// scripts/raise-customer-bills.mjs
// ─────────────────────────────────────────────────────────────────────────────
// "ENTRY PASS KARO" — raise every customer bill of a period that is ready.
//
// Owner, 5-Sep-2026: audit both firms for 1-Apr → 1-Sep and pass the entries.
// This raises the drafts the documents support and REFUSES the rest, loudly:
//   · a bill with an unpriced trip (no AC5 amount, no contract rate) is skipped
//   · a bill whose period has not ended is skipped (nothing to close yet)
//   · a bill already raised is skipped (DUPLICATE_REF is the guard, not us)
// Everything else goes through the same raiseCustomerBill() the admin button
// uses: Dr Debtors: <customer> / Cr Freight Income for the trips no legacy
// company_bill posted, trips marked BILLED, bill locked.
//
//   node scripts/raise-customer-bills.mjs --from 2026-04-01 --to 2026-08-31            # plan only
//   node scripts/raise-customer-bills.mjs --from 2026-04-01 --to 2026-08-31 --live     # post
//   … --customer IOCL            only bills whose customer name contains IOCL / INDIAN OIL
//   … --books "PRASAD"           only one firm's books
//   … --by "owner (5-Sep)"       who signs the raise (default: script)
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';
dotenv.config();

const arg = (k, d = null) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const LIVE = process.argv.includes('--live');
const FROM = arg('--from', '2026-04-01');
const TO = arg('--to', new Date().toISOString().slice(0, 10));
const CUSTOMER = arg('--customer');
const BOOKS = arg('--books');
const BY = arg('--by', 'raise-customer-bills');

const { query, closePool, initDb } = await import('../server/db/pool.js');
const { raiseCustomerBill, RaiseError, inr } = await import('../server/lib/customerBillRaise.js');
await initDb({ attempts: 1, quiet: true });

const { rows } = await query(`
  SELECT id, bill_no, customer_name, company_name, operating_company, cycle_label, period_from, period_to, status,
         trips, gross, net_receivable, received, balance, revenue_to_post, revenue_posted_legacy,
         unpriced_count, missing_count, pending_count, paid_count, short_count, company_id
    FROM v_customer_bill
   WHERE status IN ('AI_DRAFT', 'STAFF_REVIEWED') AND locked_at IS NULL
     AND period_from >= $1::date AND period_to <= $2::date
     AND ($3::text IS NULL OR customer_name ILIKE '%' || $3 || '%' OR ($3 ILIKE 'IOCL' AND customer_name ILIKE '%INDIAN OIL%'))
     AND ($4::text IS NULL OR COALESCE(company_name, operating_company) ILIKE '%' || $4 || '%')
   ORDER BY customer_name, company_name, period_from`, [FROM, TO, CUSTOMER, BOOKS]);

console.log(`\n${'='.repeat(78)}\n RAISE CUSTOMER BILLS ${FROM} → ${TO}   [${LIVE ? 'LIVE' : 'PLAN ONLY'}]\n${'='.repeat(78)}`);
console.log(` ${rows.length} open draft(s) in the period${CUSTOMER ? ` · customer ~ ${CUSTOMER}` : ''}${BOOKS ? ` · books ~ ${BOOKS}` : ''}\n`);

const stats = { raised: 0, posted: 0, locked_only: 0, skipped_unpriced: 0, skipped_open: 0, skipped_nocompany: 0, failed: 0, amount: 0 };
const today = new Date().toISOString().slice(0, 10);
for (const b of rows) {
  const tag = `${b.bill_no.padEnd(28)} ${String(b.customer_name).slice(0, 28).padEnd(28)} ${String(b.company_name ?? b.operating_company ?? '?').slice(0, 24).padEnd(24)}`;
  if (Number(b.unpriced_count) > 0) { stats.skipped_unpriced++; console.log(`  - ${tag} SKIP  ${b.unpriced_count} unpriced trip(s)`); continue; }
  if (String(b.period_to).slice(0, 10) >= today) { stats.skipped_open++; console.log(`  - ${tag} SKIP  period still open`); continue; }
  if (!b.company_id) { stats.skipped_nocompany++; console.log(`  - ${tag} SKIP  no firm on the bill`); continue; }
  const toPost = Number(b.revenue_to_post) || 0;
  const flags = `paid ${b.paid_count} short ${b.short_count} pending ${b.pending_count} missing ${b.missing_count}`;
  if (!LIVE) { console.log(`  · ${tag} gross ${inr(b.gross)} → post ${inr(toPost)}${Number(b.revenue_posted_legacy) ? ` (legacy ${inr(b.revenue_posted_legacy)})` : ''} · ${flags}`); stats.raised++; stats.amount += toPost; continue; }
  try {
    const r = await raiseCustomerBill(b.id, BY);
    stats.raised++; stats.amount += Number(r.amount) || 0;
    if (r.voucher_id) stats.posted++; else stats.locked_only++;
    console.log(`  ✓ ${tag} ${r.voucher_id ? `posted ${inr(r.amount)}` : 'locked (revenue already posted)'} · ${flags}`);
  } catch (e) {
    stats.failed++;
    console.log(`  x ${tag} ${e instanceof RaiseError ? e.code : (e.code ?? 'ERR')}: ${String(e.detail ?? e.message).slice(0, 140)}`);
  }
}

console.log(`\n${'-'.repeat(78)}`);
console.log(`  ${LIVE ? 'raised' : 'would raise'}     : ${stats.raised}   (journals ${stats.posted}, lock-only ${stats.locked_only})`);
console.log(`  revenue posted    : ${inr(stats.amount)}`);
console.log(`  skipped unpriced  : ${stats.skipped_unpriced}`);
console.log(`  skipped open      : ${stats.skipped_open}`);
console.log(`  skipped no firm   : ${stats.skipped_nocompany}`);
console.log(`  failed            : ${stats.failed}`);
if (!LIVE) console.log('\n  PLAN ONLY — re-run with --live to post.');
await closePool();
