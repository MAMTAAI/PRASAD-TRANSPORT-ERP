// server/lib/customerBillRaise.js
// ─────────────────────────────────────────────────────────────────────────────
// RAISING A CUSTOMER BILL — the one place revenue is posted for it.
//
// Shared by the route (an admin's click) and scripts/raise-customer-bills.mjs
// (the owner's "entry pass karo" for a whole period). Same rules either way:
//   · a bill raises once; a locked bill refuses (P0415 / ALREADY_RAISED)
//   · an unpriced trip blocks it (P0416 / UNPRICED) — nothing is guessed
//   · the journal is Dr Debtors: <customer> / Cr Freight Income for the trips
//     no legacy company_bill already posted; one trip's freight, once, ever
//   · deterministic ref CBILL_<bill_no>, so a re-run is a DUPLICATE_REF no-op
// ─────────────────────────────────────────────────────────────────────────────
import { postVoucher } from '../agents/tara.js';
import { query, withTransaction } from '../db/pool.js';

const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));
export const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The ledgers, as the chart of accounts holds them (never improvised).
export const DEBTOR = (name) => `Debtors: ${name}`;
export const DEBTOR_GROUP = 'Sundry Debtors (Customers)';
export const FREIGHT_INCOME = 'Freight Income';

export class RaiseError extends Error {
  constructor(code, detail, http = 409, extra = {}) { super(detail || code); this.code = code; this.detail = detail; this.http = http; Object.assign(this, extra); }
}

export const billById = async (id) => (await query('SELECT * FROM v_customer_bill WHERE id = $1::uuid', [id])).rows[0] ?? null;

/** The revenue journal a RAISE posts: only what no legacy bill posted. */
export function revenueJournal(b) {
  const lines = [];
  const base = r2(num(b.revenue_to_post) + num(b.adj_income) - num(b.adj_expense));
  if (base > 0) {
    lines.push({ ledger: DEBTOR(b.customer_name), dr_cr: 'DR', amount: base, group: DEBTOR_GROUP });
    lines.push({ ledger: FREIGHT_INCOME, dr_cr: 'CR', amount: base, group: 'Freight Income' });
  }
  return { lines, amount: base, legacy: r2(num(b.revenue_posted_legacy)) };
}

/**
 * Raise one bill: post its revenue journal (if any is left to post), mark its
 * trips BILLED, lock it. Throws RaiseError with an http code for the route.
 */
export async function raiseCustomerBill(id, who = 'desk', { dryRun = false } = {}) {
  let bill = await billById(id);
  if (!bill) throw new RaiseError('NOT_FOUND', 'Bill nahi mila', 404);
  if (bill.locked_at) throw new RaiseError('ALREADY_RAISED', 'Yeh bill pehle se raised hai', 409, { bill });
  await query('SELECT customer_bill_refresh($1::uuid)', [id]);
  bill = await billById(id);
  if (num(bill.unpriced_count) > 0) {
    throw new RaiseError('UNPRICED', `${bill.unpriced_count} trip ka rate/amount nahi — pehle price kijiye (Pending Billing me qty × rate), tab raise hoga.`);
  }
  if (!bill.company_id) throw new RaiseError('NO_COMPANY', 'Is bill ki firm (books) pata nahi — trips par operating company set kijiye.');
  const journal = revenueJournal(bill);
  let voucher = null;
  if (journal.lines.length) {
    try {
      voucher = await postVoucher({
        type: 'JOURNAL', source_type: 'CUSTOMER_BILL', company_id: bill.company_id,
        ref_no: `CBILL_${bill.bill_no}`, entry_date: isoDate(bill.period_to),
        narration: `Customer bill ${bill.bill_no} — ${bill.customer_name}, ${bill.cycle_label}: freight ${inr(journal.amount)}`
                 + (journal.legacy > 0 ? ` (a further ${inr(journal.legacy)} was posted by earlier bills and is not repeated)` : ''),
        lines: journal.lines,
        dry_run: dryRun,
      });
    } catch (e) {
      if (e.code === 'DUPLICATE_REF') throw new RaiseError('ALREADY_POSTED', e.message);
      throw new RaiseError(e.code ?? 'POSTING_FAILED', e.message, 422);
    }
  }
  if (dryRun) return { raised: false, dry_run: true, bill, posted: journal.lines, amount: journal.amount, legacy: journal.legacy };
  try {
    await withTransaction(async (t) => {
      await t.query(`UPDATE trips SET billing_status = 'BILLED', updated_at = now()
                      WHERE customer_bill_id = $1::uuid AND linked_bill_id IS NULL`, [id]);
      await t.query(`
        UPDATE customer_bills
           SET status = 'RAISED', raised_by = $2, raised_at = now(), locked_at = now(), locked_by = $2,
               voucher_id = COALESCE($3::uuid, voucher_id),
               voucher_ids = CASE WHEN $3::uuid IS NULL THEN voucher_ids ELSE voucher_ids || to_jsonb($3::text) END,
               post_count = CASE WHEN $3::uuid IS NULL THEN post_count ELSE post_count + 1 END,
               posted_lines = CASE WHEN $3::uuid IS NULL THEN posted_lines ELSE $4::jsonb END
         WHERE id = $1::uuid`, [id, who, voucher?.voucher_id ?? null, JSON.stringify(journal.lines)]);
    });
    await query('SELECT customer_bill_refresh($1::uuid)', [id]);   // status follows the money already in
  } catch (e) {
    if (e.code === 'P0416') throw new RaiseError('UNPRICED', e.message);
    throw e;
  }
  const fresh = await billById(id);
  return {
    raised: true, bill: fresh, voucher_id: voucher?.voucher_id ?? null, posted: journal.lines, amount: journal.amount, legacy: journal.legacy,
    note: voucher
      ? `Revenue ${inr(journal.amount)} post hua (Dr Debtors / Cr Freight Income).${journal.legacy > 0 ? ` ${inr(journal.legacy)} pehle ke bill se already posted tha — dobara nahi.` : ''}`
      : 'Poora revenue pehle ke bill se already posted tha — sirf lock hua. Milaan chalti rahegi.',
  };
}
