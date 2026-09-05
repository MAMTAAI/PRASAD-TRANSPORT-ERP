// server/modules/customerBills.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// THE CUSTOMER 15-DAY BILL — list, open, raise, reconcile, map (migration 163).
//
// Owner, 5-Sep-2026: bills for 1-Apr → 1-Sep-2026; bill collection from mail
// and trip-wise reconciliation; the HSD share of an oil company's payment goes
// to the fleet account and the rest to the bank; an agent drafts, staff
// approve, errors on the dashboard; GST/TDS managed; 0% error.
//
// WHAT MOVES MONEY HERE, AND WHAT DOES NOT
//   · RAISE posts revenue — Dr Debtors: <customer> / Cr Freight Income — for
//     the trips no legacy company_bill already posted (BILL_RAISED). One
//     trip's freight is posted once, ever.
//   · Receipts are NOT posted here. The IOCL advice pipeline posts them (015),
//     and this screen READS them: v_customer_trip_recon derives every trip's
//     flag from what that pipeline wrote on the trip.
//   · The ledger audit shows the split the audit found (receipts credited to
//     a plain-named party ledger, CCMS diesel debited to expense) and offers
//     ONE reasoned correction journal, admin-signed, through TARA.
// ─────────────────────────────────────────────────────────────────────────────
import { postVoucher } from '../agents/tara.js';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';
import { send as sendMail } from '../lib/mailChannel.js';
import { raiseCustomerBill, RaiseError, revenueJournal, billById } from '../lib/customerBillRaise.js';
import multipart from '@fastify/multipart';
import path from 'node:path';
import fs from 'node:fs';
import { runChild, PYTHON, TOOLS, REPO, tail as tailOf } from '../lib/adviceCollectJob.js';
export { revenueJournal };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;
const clamp = (v, d, max) => Math.min(Math.max(1, Number(v) || d), max);
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));
const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? r2(n) : null; };

// The ledgers, as the chart of accounts holds them (never improvised).
const DEBTOR = (name) => `Debtors: ${name}`;
const DEBTOR_GROUP = 'Sundry Debtors (Customers)';
const FREIGHT_INCOME = 'Freight Income';
const FUEL_EXPENSE = 'Direct Expenses - Fuel & HSD';

/** The bill as text — for WhatsApp / e-mail. Branch-wise, IOCL shape. */
function billText(b) {
  const NL = String.fromCharCode(10);
  const blocks = Array.isArray(b.lines) ? b.lines : [];
  const L = [
    `*${b.customer_name}* — 15-day bill`,
    `${b.bill_no} · ${b.cycle_label} (${isoDate(b.period_from)} se ${isoDate(b.period_to)}) · ${b.company_name ?? b.operating_company ?? ''}`,
    `${b.branches} branch · ${b.trips} trip · ${Number(b.loaded_qty || 0).toFixed(3)} KL`,
    '',
  ];
  for (const blk of blocks) {
    const s = blk.subtotal ?? {};
    L.push(`📍 ${blk.branch_name} — ${s.trips} trip · ${inr(s.gross)}${num(s.penalty) ? ` · penalty ${inr(s.penalty)}` : ''}`);
  }
  L.push('');
  L.push(`Gross: ${inr(b.gross)}`);
  if (num(b.shortage_penalty)) L.push(`− Shortage penalty: ${inr(b.shortage_penalty)}`);
  L.push(`− TDS 194C${b.tds_pct !== null ? ` ${num(b.tds_pct)}%` : ''}: ${inr(b.tds)}`);
  if (b.gst_mode === 'RCM') L.push(`GST ${num(b.gst_pct)}% RCM (memo): ${inr(b.gst_memo)}`);
  L.push(`*Net receivable: ${inr(b.net_receivable)}*`);
  L.push(`Received: ${inr(b.received)} · Balance: ${inr(b.balance)}`);
  if (num(b.missing_count)) L.push(`❌ Missing freight: ${b.missing_count} trip · ${inr(b.missing_amount)}`);
  if (num(b.pending_count)) L.push(`🕒 Pending: ${b.pending_count} trip · ${inr(b.pending_amount)}`);
  L.push('');
  L.push(b.status === 'PAID' ? '✅ Paid' : b.status === 'PART_PAID' ? '🟡 Part-paid' : b.status === 'RAISED' ? `📤 Raised — ${b.raised_by}` : b.status === 'DISPUTED' ? '⚠️ Dispute' : '🤖 Draft');
  return L.join(NL);
}

export async function registerCustomerBillRoutes(app) {
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };
  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';

  // ═══ THE LIST ═══════════════════════════════════════════════════════════
  app.get('/', staff, async (req) => {
    const q = req.query ?? {};
    const from = DATE_RE.test(String(q.period_from ?? '')) ? q.period_from : null;
    const status = ['AI_DRAFT', 'STAFF_REVIEWED', 'RAISED', 'PART_PAID', 'PAID', 'DISPUTED', 'CANCELLED'].includes(q.status) ? q.status : null;
    const type = ['OIL_COMPANY', 'CONTRACT', 'MARKET'].includes(q.type) ? q.type : null;
    const text = String(q.q ?? '').trim() || null;
    const limit = clamp(q.limit, 200, 500);
    const { rows } = await query(`
      SELECT * FROM v_customer_bill b
       WHERE ($1::date IS NULL OR b.period_from = $1::date
              OR (b.cycle_kind = 'MONTH' AND $1::date BETWEEN b.period_from AND b.period_to))
         AND ($2::text IS NULL OR b.status = $2::text)
         AND ($3::text IS NULL OR b.customer_type = $3::text)
         AND ($4::text IS NULL OR b.customer_name ILIKE '%' || $4 || '%' OR b.bill_no ILIKE '%' || $4 || '%')
         AND b.status <> 'CANCELLED'
       ORDER BY b.period_from DESC, b.gross DESC
       LIMIT $5`, [from, status, type, text, limit]);
    const { rows: cards } = await query(`
      SELECT c.id AS customer_id, c.customer_name, c.customer_type, c.bill_cycle,
             count(b.id)::int AS bills,
             COALESCE(sum(b.gross), 0)::numeric(14,2) AS gross,
             COALESCE(sum(b.received), 0)::numeric(14,2) AS received,
             COALESCE(sum(b.balance) FILTER (WHERE b.status IN ('RAISED','PART_PAID','DISPUTED')), 0)::numeric(14,2) AS outstanding_raised,
             COALESCE(sum(b.balance) FILTER (WHERE b.status IN ('AI_DRAFT','STAFF_REVIEWED')), 0)::numeric(14,2) AS in_draft,
             COALESCE(sum(b.missing_amount), 0)::numeric(14,2) AS missing_amount,
             COALESCE(sum(b.missing_count), 0)::int AS missing_count,
             COALESCE(sum(b.pending_amount), 0)::numeric(14,2) AS pending_amount,
             COALESCE(sum(b.unpriced_count), 0)::int AS unpriced,
             (SELECT count(*)::int FROM customer_branches cb WHERE cb.customer_id = c.id) AS branches,
             (SELECT count(*)::int FROM customer_branches cb WHERE cb.customer_id = c.id AND cb.source = 'CONFIRMED') AS branches_confirmed
        FROM customers c
        LEFT JOIN customer_bills b ON b.customer_id = c.id AND b.status <> 'CANCELLED'
       WHERE c.status = 'ACTIVE'
       GROUP BY c.id
       ORDER BY gross DESC`);
    const { rows: cycles } = await query(`
      SELECT period_from, period_to, cycle_kind,
             CASE WHEN cycle_kind = 'MONTH' THEN to_char(period_from, 'Mon YYYY') || ' · Monthly'
                  ELSE fortnight_label(period_from) END AS cycle_label,
             count(*)::int AS bills,
             count(*) FILTER (WHERE status IN ('AI_DRAFT','STAFF_REVIEWED'))::int AS drafts,
             count(*) FILTER (WHERE status IN ('RAISED','PART_PAID','DISPUTED'))::int AS raised,
             count(*) FILTER (WHERE status = 'PAID')::int AS paid,
             COALESCE(sum(gross), 0)::numeric(14,2) AS gross,
             COALESCE(sum(balance), 0)::numeric(14,2) AS balance,
             COALESCE(sum(missing_count), 0)::int AS missing
        FROM customer_bills WHERE status <> 'CANCELLED'
       GROUP BY period_from, period_to, cycle_kind
       ORDER BY period_from DESC LIMIT 60`);
    const { rows: [audit] } = await query(`
      SELECT count(*)::int AS findings,
             COALESCE(sum(trips) FILTER (WHERE finding = 'NO_CUSTOMER'), 0)::int AS no_customer,
             COALESCE(sum(trips) FILTER (WHERE finding = 'UNPRICED'), 0)::int AS unpriced,
             count(*) FILTER (WHERE finding = 'UNKNOWN_NAME')::int AS unknown_names,
             count(*) FILTER (WHERE finding = 'BRANCH_UNCONFIRMED')::int AS branches_unconfirmed
        FROM v_customer_mapping_audit`);
    const sum = (k) => r2(rows.reduce((a, r) => a + num(r[k]), 0));
    return {
      rows, cards, cycles, audit,
      totals: { bills: rows.length, gross: sum('gross'), received: sum('received'), balance: sum('balance'),
                tds: sum('tds'), gst_memo: sum('gst_memo'), missing: sum('missing_amount'), pending: sum('pending_amount'),
                drafts: rows.filter((r) => ['AI_DRAFT', 'STAFF_REVIEWED'].includes(r.status)).length,
                raised: rows.filter((r) => ['RAISED', 'PART_PAID', 'DISPUTED'].includes(r.status)).length,
                paid: rows.filter((r) => r.status === 'PAID').length },
    };
  });

  // ═══ BUILD ══════════════════════════════════════════════════════════════
  app.post('/build', staff, async (req, reply) => {
    const b = req.body ?? {};
    if (!DATE_RE.test(String(b.period_from ?? ''))) return reply.code(400).send({ error: 'BAD_PERIOD' });
    const { rows: [out] } = await query('SELECT * FROM customer_bills_build($1::date, $2)', [b.period_from, actor(req)]);
    return { built: true, ...out };
  });
  app.post('/build-range', admin, async (req, reply) => {
    const b = req.body ?? {};
    if (!DATE_RE.test(String(b.from ?? '')) || !DATE_RE.test(String(b.to ?? ''))) return reply.code(400).send({ error: 'BAD_RANGE' });
    const { rows: periods } = await query(`
      SELECT DISTINCT fortnight_from(d::date) AS f
        FROM generate_series($1::date, $2::date, interval '1 day') d ORDER BY 1`, [b.from, b.to]);
    const results = [];
    for (const p of periods) {
      const f = isoDate(p.f);
      const { rows: [out] } = await query('SELECT * FROM customer_bills_build($1::date, $2)', [f, actor(req)]);
      results.push({ period_from: f, ...out });
    }
    return { built: true, periods: results };
  });

  // ═══ THE MAPPING DESK — what stops a bill from being right ═════════════
  app.get('/mapping-audit', staff, async () => {
    const { rows } = await query(`SELECT * FROM v_customer_mapping_audit
                                   ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END, amount DESC, trips DESC`);
    const { rows: customers } = await query(`
      SELECT id, customer_name, customer_code, customer_type, bill_cycle, print_format, tds_pct_deducted, gst_pct, gst_mode, gst_no, pan_no
        FROM customers WHERE status = 'ACTIVE' ORDER BY customer_name`);
    const { rows: unknownTrips } = await query(`
      SELECT COALESCE(btrim(t.customer_name), '') AS name, COALESCE(btrim(t.operating_company), '') AS company,
             count(*)::int AS trips, min(t.loading_date) AS first, max(t.loading_date) AS last,
             array_agg(t.id::text ORDER BY t.loading_date) AS trip_ids,
             count(*) FILTER (WHERE t.iocl_bill_no IS NOT NULL)::int AS with_iocl_no,
             array_agg(DISTINCT btrim(t.unloading_location)) FILTER (WHERE t.unloading_location IS NOT NULL) AS locations
        FROM trips t
       WHERE t.status = 'COMPLETED'
         AND (t.customer_name IS NULL OR btrim(t.customer_name) = '' OR customer_of(t.customer_name) IS NULL)
       GROUP BY 1, 2 ORDER BY trips DESC`);
    const { rows: branches } = await query(`
      SELECT cb.*, c.customer_name,
             (SELECT count(*)::int FROM trips t WHERE t.status='COMPLETED' AND customer_of(t.customer_name) = cb.customer_id
                 AND branch_key(t.unloading_location) = cb.branch_key) AS trips
        FROM customer_branches cb JOIN customers c ON c.id = cb.customer_id
       ORDER BY c.customer_name, cb.source, trips DESC`);
    return { rows, customers, unknown_trips: unknownTrips, branches };
  });

  // Give trips their customer (and remember the spelling as an alias).
  app.post('/mapping/assign-customer', staff, async (req, reply) => {
    const b = req.body ?? {};
    if (!UUID_RE.test(String(b.customer_id ?? ''))) return reply.code(400).send({ error: 'BAD_CUSTOMER' });
    const ids = (Array.isArray(b.trip_ids) ? b.trip_ids : []).filter((x) => UUID_RE.test(String(x)));
    const alias = String(b.alias ?? '').trim();
    const { rows: [c] } = await query('SELECT customer_name FROM customers WHERE id = $1::uuid', [b.customer_id]);
    if (!c) return reply.code(404).send({ error: 'NOT_FOUND' });
    const who = actor(req);
    const out = await withTransaction(async (t) => {
      let n = 0;
      if (alias) {
        await t.query(`INSERT INTO customer_name_aliases (alias_norm, alias, customer_id, source, confirmed_by)
                       VALUES (norm_company($1), $1, $2::uuid, 'DESK', $3)
                       ON CONFLICT (alias_norm) DO UPDATE SET customer_id = EXCLUDED.customer_id, confirmed_by = EXCLUDED.confirmed_by`,
          [alias, b.customer_id, who]);
      }
      if (ids.length) {
        const { rowCount } = await t.query(`
          UPDATE trips SET customer_name = $2, updated_at = now()
           WHERE id = ANY($1::uuid[]) AND customer_bill_id IS NULL`, [ids, c.customer_name]);
        n = rowCount;
      }
      return n;
    });
    return { assigned: out, alias_saved: !!alias, customer: c.customer_name };
  });

  app.post('/mapping/branch-confirm', staff, async (req, reply) => {
    const id = String(req.body?.branch_id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const name = String(req.body?.branch_name ?? '').trim();
    const code = String(req.body?.branch_code ?? '').trim();
    const { rows } = await query(`
      UPDATE customer_branches SET source = 'CONFIRMED', confirmed_by = $2, confirmed_at = now(),
             branch_name = COALESCE(NULLIF($3, ''), branch_name), branch_code = COALESCE(NULLIF($4, ''), branch_code)
       WHERE id = $1::uuid RETURNING *`, [id, actor(req), name, code]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { confirmed: true, branch: rows[0] };
  });

  app.patch('/customers/:id', admin, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {};
    const sets = []; const args = [id];
    const put = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
    if (['OIL_COMPANY', 'CONTRACT', 'MARKET'].includes(b.customer_type)) put('customer_type', b.customer_type);
    if (['FORTNIGHT', 'MONTH', 'PER_LOAD'].includes(b.bill_cycle)) put('bill_cycle', b.bill_cycle);
    if (['OIL_CO', 'CONTRACT_RCM', 'MARKET_LR'].includes(b.print_format)) put('print_format', b.print_format);
    if (money(b.tds_pct_deducted) !== null) put('tds_pct_deducted', money(b.tds_pct_deducted));
    // Contract ₹/KL (164): blank clears it; an oil company should stay NULL.
    if ('contract_rate_per_kl' in b) put('contract_rate_per_kl', money(b.contract_rate_per_kl) > 0 ? money(b.contract_rate_per_kl) : null);
    if (money(b.gst_pct) !== null) put('gst_pct', money(b.gst_pct));
    if (['RCM', 'FORWARD', 'EXEMPT'].includes(b.gst_mode)) put('gst_mode', b.gst_mode);
    if (typeof b.customer_code === 'string') put('customer_code', b.customer_code.trim() || null);
    if (!sets.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    const { rows } = await query(`UPDATE customers SET ${sets.join(', ')} WHERE id = $1::uuid RETURNING id, customer_name, customer_type, bill_cycle, print_format, tds_pct_deducted, gst_pct, gst_mode, contract_rate_per_kl`, args);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    // Open bills of this customer follow the new terms.
    await query(`SELECT customer_bill_refresh(id) FROM customer_bills WHERE customer_id = $1::uuid AND locked_at IS NULL`, [id]).catch(() => {});
    return { updated: true, customer: rows[0] };
  });

  // ═══ GST / TDS — what the returns need, per customer per cycle ══════════
  app.get('/tax-summary', staff, async (req) => {
    const q = req.query ?? {};
    const from = DATE_RE.test(String(q.from ?? '')) ? q.from : '2026-04-01';
    const to = DATE_RE.test(String(q.to ?? '')) ? q.to : isoDate(new Date());
    const { rows } = await query(`
      SELECT b.customer_name, b.customer_type, b.gst_mode, to_char(b.period_from, 'YYYY-MM') AS month,
             count(*)::int AS bills, sum(b.gross)::numeric(14,2) AS gross,
             sum(b.gst_memo)::numeric(14,2) AS gst_rcm_memo,
             sum(b.tds)::numeric(14,2) AS tds_expected,
             sum(b.received)::numeric(14,2) AS received
        FROM customer_bills b
       WHERE b.status <> 'CANCELLED' AND b.period_from BETWEEN $1::date AND $2::date
       GROUP BY 1, 2, 3, 4 ORDER BY 4, 1`, [from, to]);
    const { rows: [tdsPosted] } = await query(`
      SELECT COALESCE(sum(amount) FILTER (WHERE dr_cr = 'DR'), 0)::numeric(14,2) AS tds_receivable_posted
        FROM ledger_entries WHERE ledger_name = 'TDS Receivable 194C' AND entry_date BETWEEN $1::date AND $2::date`, [from, to]);
    const { rows: [advTds] } = await query(`
      SELECT COALESCE(-sum(l.tds), 0)::numeric(14,2) AS tds_per_advices
        FROM iocl_advice_lines l JOIN iocl_payment_advices a ON a.advice_id = l.advice_id
       WHERE a.advice_date BETWEEN $1::date AND $2::date`).catch(() => ({ rows: [{ tds_per_advices: null }] }));
    return { from, to, rows, tds_receivable_posted: tdsPosted.tds_receivable_posted, tds_per_advices: advTds?.tds_per_advices ?? null,
             note: 'GST 5% under RCM is a memo — the customer discharges it; nothing is posted as our output tax. TDS 194C is our receivable, posted when the advice lands.' };
  });

  // ═══ COLLECT THE CUSTOMER'S ADVICES NOW — the daily job, by hand ═══════
  // BHUVANESHWARI reads the advice mail, TARA posts the settlement, the bills
  // re-read their trips. The scheduler does this daily after 04:30 IST; this is
  // the same run for "advice aa gaya, abhi milao".
  app.post('/collect-advices', admin, async (req) => {
    const { runAdviceCollect } = await import('../lib/adviceCollectJob.js');
    return runAdviceCollect({ trigger: 'MANUAL', force: true, by: req.user?.username ?? 'admin' });
  });

  // ═══ THE LEDGER AUDIT — the split the audit found, and its one fix ═════
  app.get('/ledger-audit', staff, async () => {
    const { rows: pairs } = await query(`
      SELECT c.customer_name,
             (SELECT COALESCE(sum(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0)::numeric(14,2) FROM ledger_entries e WHERE e.ledger_name = 'Debtors: ' || c.customer_name) AS debtor_balance,
             (SELECT COALESCE(sum(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0)::numeric(14,2) FROM ledger_entries e WHERE e.ledger_name = c.customer_name) AS plain_balance,
             (SELECT count(*)::int FROM ledger_entries e WHERE e.ledger_name = c.customer_name) AS plain_entries
        FROM customers c WHERE c.status = 'ACTIVE' ORDER BY 1`);
    const { rows: [ccms] } = await query(`
      SELECT COALESCE(sum(amount) FILTER (WHERE dr_cr = 'DR'), 0)::numeric(14,2) AS fuel_expense_from_advices,
             count(*)::int AS entries
        FROM ledger_entries WHERE source_type = 'ADVICE_SETTLEMENT' AND ledger_name = $1`, [FUEL_EXPENSE]);
    const { rows: cards } = await query(`SELECT ledger_name FROM ledgers WHERE group_head = 'Prepaid Cards & Wallets (Asset)' ORDER BY 1`);
    // The fleet-card module already names IOCL's wallet for the firm that runs
    // IOCL's trucks; offer that one first rather than a pattern guess.
    const { rows: [acct] } = await query(`
      SELECT wallet_ledger FROM fleet_card_accounts
       WHERE provider = 'IOCL' AND active AND wallet_ledger IS NOT NULL
       ORDER BY (operating_company ILIKE '%PRASAD%') DESC LIMIT 1`).catch(() => ({ rows: [] }));
    const { rows: fixes } = await query(`SELECT source_ref, entry_date, narration, sum(amount) FILTER (WHERE dr_cr='DR') AS amount
                                          FROM ledger_entries WHERE source_type = 'CUSTOMER_LEDGER_FIX' GROUP BY 1,2,3 ORDER BY 2 DESC`);
    return {
      pairs, ccms, fleet_card_ledgers: cards.map((c) => c.ledger_name), default_card: acct?.wallet_ledger ?? null, fixes,
      rule: 'Oil-company payment: the HSD (CCMS) share is money the customer keeps to recharge OUR fleet card — it goes to the card ledger (asset), the rest to the bank; both against the same Debtors ledger the revenue was raised in.',
    };
  });

  // The correction, admin-signed. Two journals, append-only, deterministic refs.
  app.post('/ledger-audit/fix', admin, async (req, reply) => {
    const b = req.body ?? {};
    const customer = String(b.customer_name ?? '').trim();
    const card = String(b.fleet_card_ledger ?? '').trim();
    if (!customer) return reply.code(400).send({ error: 'NO_CUSTOMER' });
    const { rows: [pb] } = await query(`
      SELECT COALESCE(sum(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0)::numeric(14,2) AS bal
        FROM ledger_entries WHERE ledger_name = $1`, [customer]);
    const plain = num(pb?.bal);           // negative = credits sitting on the plain-named ledger
    const posted = [];
    const stamp = isoDate(new Date());
    try {
      if (plain < -0.005 && b.move_receipts !== false) {
        const amt = r2(-plain);
        const v = await postVoucher({
          type: 'JOURNAL', source_type: 'CUSTOMER_LEDGER_FIX', ref_no: `CBFIX_DEBTOR_${customer.replace(/\s+/g, '_')}_${stamp}`,
          entry_date: stamp,
          narration: `Correction: receipts credited to '${customer}' moved to '${DEBTOR(customer)}' — same customer, one ledger (audit 5-Sep-2026)`,
          lines: [
            { ledger: customer, dr_cr: 'DR', amount: amt, group: DEBTOR_GROUP },
            { ledger: DEBTOR(customer), dr_cr: 'CR', amount: amt, group: DEBTOR_GROUP },
          ],
        });
        posted.push({ what: 'receipts → Debtors ledger', amount: amt, voucher_id: v?.voucher_id });
      }
      if (card && b.move_ccms !== false) {
        const { rows: [cc] } = await query(`
          SELECT COALESCE(sum(amount) FILTER (WHERE dr_cr = 'DR'), 0)::numeric(14,2) AS amt
            FROM ledger_entries WHERE source_type = 'ADVICE_SETTLEMENT' AND ledger_name = $1`, [FUEL_EXPENSE]);
        const { rows: [done] } = await query(`
          SELECT COALESCE(sum(amount) FILTER (WHERE dr_cr = 'CR'), 0)::numeric(14,2) AS amt
            FROM ledger_entries WHERE source_type = 'CUSTOMER_LEDGER_FIX' AND ledger_name = $1`, [FUEL_EXPENSE]);
        const amt = r2(num(cc?.amt) - num(done?.amt));
        if (amt > 0.005) {
          const v = await postVoucher({
            type: 'JOURNAL', source_type: 'CUSTOMER_LEDGER_FIX', ref_no: `CBFIX_CCMS_${stamp}`,
            entry_date: stamp,
            narration: `Correction: IOCL CCMS diesel recovery is the customer recharging our fleet card, not a second fuel expense — moved from '${FUEL_EXPENSE}' to '${card}' (owner's rule 5-Sep-2026)`,
            lines: [
              { ledger: card, dr_cr: 'DR', amount: amt, group: 'Prepaid Cards & Wallets (Asset)' },
              { ledger: FUEL_EXPENSE, dr_cr: 'CR', amount: amt, group: FUEL_EXPENSE },
            ],
          });
          posted.push({ what: 'CCMS → fleet card', amount: amt, voucher_id: v?.voucher_id });
        }
      }
    } catch (e) {
      if (e.code === 'DUPLICATE_REF') return reply.code(409).send({ error: 'ALREADY_POSTED', detail: e.message, posted });
      return reply.code(422).send({ error: e.code ?? 'POSTING_FAILED', detail: e.message, posted });
    }
    return { fixed: posted.length > 0, posted };
  });

  // ═══ ONE BILL ═══════════════════════════════════════════════════════════
  app.get('/:id', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const bill = await billById(id);
    if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
    // Their lines with no trip of ours in this period (IOCL only).
    const { rows: theirs } = await query(`
      SELECT m.bill_no, m.trip_date, m.vehicle_no_raw, m.ship_to_code, m.ship_to_name, m.gross_amt, m.match_status, m.invoice_nos
        FROM iocl_recon_matches m
       WHERE $2 = '11024699' AND m.match_status <> 'MATCHED' AND m.trip_date BETWEEN $3::date AND $4::date
       ORDER BY m.trip_date`, [id, bill.customer_code ?? '', bill.period_from, bill.period_to]).catch(() => ({ rows: [] }));
    // The advices that paid this period's IOCL bills, with their deductions.
    const { rows: advices } = await query(`
      SELECT a.odn, a.advice_date, a.remitted,
             sum(l.gross) FILTER (WHERE l.kind = 'FREIGHT_BILL')::numeric(14,2) AS freight,
             sum(-l.tds)::numeric(14,2) AS tds,
             sum(-l.gross) FILTER (WHERE l.kind = 'FUEL_CCMS_RECOVERY')::numeric(14,2) AS ccms,
             sum(-l.gross) FILTER (WHERE l.kind = 'TOLL_RECOVERY')::numeric(14,2) AS toll,
             sum(-l.gross) FILTER (WHERE l.kind = 'MISC_RECOVERY')::numeric(14,2) AS misc,
             sum(l.gross) FILTER (WHERE l.kind IN ('OTHER_BILLED_INCOME','RENTAL_INCOME','OTHER'))::numeric(14,2) AS other_income
        FROM iocl_payment_advices a JOIN iocl_advice_lines l ON l.advice_id = a.advice_id
       WHERE $1 = '11024699' AND l.bill_no IN (
               SELECT DISTINCT m.bill_no FROM iocl_recon_matches m
                WHERE m.trip_date BETWEEN $2::date AND $3::date)
       GROUP BY a.odn, a.advice_date, a.remitted ORDER BY a.advice_date`, [bill.customer_code ?? '', bill.period_from, bill.period_to]).catch(() => ({ rows: [] }));
    return { bill, blocks: Array.isArray(bill.lines) ? bill.lines : [], their_unmatched: theirs, advices, journal: revenueJournal(bill) };
  });

  app.post('/:id/refresh', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    await query('SELECT customer_bill_refresh($1::uuid)', [id]);
    return { refreshed: true, bill: await billById(id) };
  });

  // ═══ THE MAKER SAVES — notes, adjustments, disputes ═════════════════════
  app.patch('/:id', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {};
    const bill = await billById(id);
    if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
    const who = actor(req);
    const sets = []; const args = [id];
    if (!bill.locked_at && Array.isArray(b.adjustments)) {
      const adj = b.adjustments.map((a) => ({
        label: String(a?.label ?? '').slice(0, 120).trim(), amount: money(a?.amount) ?? 0,
        side: a?.side === 'INCOME' ? 'INCOME' : 'EXPENSE', added_by: a?.added_by ?? who, added_at: a?.added_at ?? new Date().toISOString(),
      })).filter((a) => a.label && a.amount !== 0);
      args.push(JSON.stringify(adj)); sets.push(`adjustments = $${args.length}::jsonb`);
    }
    if (Array.isArray(b.disputes)) {
      // A dispute is a person's claim against the customer: kept on the bill,
      // shown on the dashboard, cleared by a person.
      const d = b.disputes.map((x) => ({
        trip_id: UUID_RE.test(String(x?.trip_id ?? '')) ? x.trip_id : null,
        trip_code: String(x?.trip_code ?? '').slice(0, 40),
        kind: ['MISSING', 'SHORT', 'OTHER'].includes(x?.kind) ? x.kind : 'OTHER',
        amount: money(x?.amount) ?? 0, note: String(x?.note ?? '').slice(0, 300),
        by: x?.by ?? who, at: x?.at ?? new Date().toISOString(),
      })).filter((x) => x.amount !== 0 || x.note);
      args.push(JSON.stringify(d)); sets.push(`disputes = $${args.length}::jsonb`);
      if (bill.locked_at) {
        sets.push(d.length ? `status = 'DISPUTED'` : `status = CASE WHEN status = 'DISPUTED' THEN 'RAISED' ELSE status END`);
      }
    }
    if (typeof b.notes === 'string') { args.push(b.notes.slice(0, 2000)); sets.push(`notes = $${args.length}`); }
    if (!sets.length) return reply.code(400).send({ error: 'NOTHING_TO_SAVE' });
    args.push(who); sets.push(`reviewed_by = $${args.length}`, 'reviewed_at = now()');
    if (!bill.locked_at) sets.push(`status = CASE WHEN status = 'AI_DRAFT' THEN 'STAFF_REVIEWED' ELSE status END`);
    try {
      await query(`UPDATE customer_bills SET ${sets.join(', ')} WHERE id = $1::uuid`, args);
      await query('SELECT customer_bill_refresh($1::uuid)', [id]);
    } catch (e) {
      if (e.code === 'P0415') return reply.code(409).send({ error: 'LOCKED', detail: e.message });
      throw e;
    }
    return { saved: true, bill: await billById(id) };
  });

  // ═══ RAISE — revenue for what no legacy bill posted; then lock ═════════
  // The same raise the owner's period script uses (lib/customerBillRaise.js).
  app.post('/:id/raise', admin, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    try {
      return await raiseCustomerBill(id, actor(req));
    } catch (e) {
      if (e instanceof RaiseError) return reply.code(e.http).send({ error: e.code, detail: e.detail, bill: e.bill ?? undefined });
      throw e;
    }
  });

  app.post('/:id/reopen', admin, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 4) return reply.code(400).send({ error: 'REASON_REQUIRED' });
    const { rows } = await query(`
      UPDATE customer_bills SET locked_at = NULL, locked_by = NULL, status = 'STAFF_REVIEWED',
             reopen_reason = $2, reopened_by = $3, reopened_at = now()
       WHERE id = $1::uuid AND locked_at IS NOT NULL RETURNING id, voucher_id`, [id, reason.slice(0, 500), actor(req)]);
    if (!rows.length) return reply.code(409).send({ error: 'NOT_LOCKED' });
    return { reopened: true, note: rows[0].voucher_id ? 'The original voucher stands — re-raising posts only the difference.' : null };
  });

  // ═══ STAFF SETTLES A TRIP BY HAND (166) ═══════════════════════════════════
  // Owner, 5-Sep: "staff bhi data ko trip-wise update kar sake". The customer's
  // invoice number and the penalty live on the trip; a receipt the advice
  // pipeline cannot see is recorded in customer_trip_settlements with who /
  // when / reference, and overrides the advice for that trip only. An empty
  // received amount removes the override and puts the advice back in charge.
  app.patch('/:id/trips/:tripId', staff, async (req, reply) => {
    const id = String(req.params.id ?? ''); const tripId = String(req.params.tripId ?? '');
    if (!UUID_RE.test(id) || !UUID_RE.test(tripId)) return reply.code(400).send({ error: 'BAD_ID' });
    const { rows: [t] } = await query('SELECT id, trip_code, customer_bill_id FROM trips WHERE id = $1::uuid', [tripId]);
    if (!t) return reply.code(404).send({ error: 'NOT_FOUND', detail: 'Trip not found' });
    if (t.customer_bill_id !== id) return reply.code(409).send({ error: 'NOT_ON_BILL', detail: `Trip ${t.trip_code} is not on this bill` });
    const b = req.body ?? {}; const who = actor(req);
    const sets = []; const args = [tripId];
    const put = (col, v) => { args.push(v); sets.push(`${col} = $${args.length}`); };
    if ('iocl_bill_no' in b) put('iocl_bill_no', String(b.iocl_bill_no ?? '').trim() || null);
    if ('shortage_penalty' in b && money(b.shortage_penalty) !== null) put('shortage_penalty', money(b.shortage_penalty));
    if (sets.length) await query(`UPDATE trips SET ${sets.join(', ')}, updated_at = now() WHERE id = $1::uuid`, args);
    let settlement = null;
    if ('received' in b) {
      const amt = money(b.received);
      if (amt === null || amt <= 0) {
        await query('DELETE FROM customer_trip_settlements WHERE trip_id = $1::uuid', [tripId]);
      } else {
        const { rows: [s] } = await query(`
          INSERT INTO customer_trip_settlements (trip_id, received, settled_on, reference, note, updated_by, updated_at)
          VALUES ($1::uuid, $2, $3::date, $4, $5, $6, now())
          ON CONFLICT (trip_id) DO UPDATE SET received = EXCLUDED.received, settled_on = EXCLUDED.settled_on,
                reference = EXCLUDED.reference, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
          RETURNING *`,
          [tripId, amt, DATE_RE.test(String(b.settled_on ?? '')) ? b.settled_on : null, String(b.reference ?? '').trim().slice(0, 120) || null, String(b.note ?? '').trim().slice(0, 500) || null, who]);
        settlement = s;
      }
    }
    await query('SELECT customer_bill_refresh($1::uuid)', [id]);
    const { rows: [line] } = await query('SELECT trip_code, iocl_bill_no, penalty, received, flag, manual_ref FROM v_customer_trip_recon WHERE trip_id = $1::uuid', [tripId]);
    return { updated: true, trip: line, settlement, bill: await billById(id) };
  });

  // ═══ THE CUSTOMER'S DOCUMENT, BY HAND ═════════════════════════════════════
  // Owner, 5-Sep: "manual bill reconciliation — PDF scan kar ke update". The
  // mailbox is the usual road; this is the hand-carried one. The PDF goes
  // through the same parsers the sweep uses (iocl_bill_automation.py for a
  // transportation bill, fetch/load/post for a payment advice), lands in the
  // same tables, and every affected bill re-reads its trips. Nothing is
  // guessed: a PDF the parser cannot read is reported, not filed.
  await app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
    scope.post('/documents/upload', staff, async (req, reply) => {
      let part;
      try { part = await req.file(); } catch (e) { return reply.code(400).send({ error: 'BAD_MULTIPART', detail: e.message }); }
      if (!part) return reply.code(400).send({ error: 'NO_FILE', detail: 'Attach a PDF' });
      const kind = String(part.fields?.kind?.value ?? 'BILL').toUpperCase() === 'ADVICE' ? 'ADVICE' : 'BILL';
      const firm = String(part.fields?.firm?.value ?? 'prasad').toLowerCase() === 'jaiswal' ? 'jaiswal' : 'prasad';
      const buf = await part.toBuffer();
      if (!/^%PDF/.test(buf.subarray(0, 5).toString('latin1'))) return reply.code(400).send({ error: 'NOT_PDF', detail: 'Only a PDF can be read' });
      const safe = String(part.filename ?? 'document.pdf').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80);
      const stamp = new Date().toISOString().slice(0, 10);
      const dir = kind === 'ADVICE'
        ? path.join(REPO, 'uploads', firm === 'jaiswal' ? 'iocl_advices_jaiswal' : 'iocl_advices')
        : path.join(REPO, 'uploads', 'iocl_bills_manual', firm);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `${stamp}_manual_${safe}`);
      fs.writeFileSync(dest, buf);
      const who = actor(req);
      const steps = [];
      let ok = true;
      if (kind === 'ADVICE') {
        const r1 = await runChild(PYTHON, [path.join(TOOLS, 'fetch_advices.py'), '--no-fetch', '--mailbox', firm, '--window-from', '2026-04-01']);
        steps.push({ step: 'parse', ok: r1.ok, tail: tailOf(r1.ok ? r1.stdout : (r1.stderr || r1.stdout), 8) }); ok = ok && r1.ok;
        if (r1.ok) {
          const r2 = await runChild(PYTHON, [path.join(TOOLS, 'load_advices.py'), '--apply']);
          steps.push({ step: 'load', ok: r2.ok, tail: tailOf(r2.ok ? r2.stdout : (r2.stderr || r2.stdout), 6) }); ok = ok && r2.ok;
          if (r2.ok) {
            const r3 = await runChild(process.execPath, [path.join(REPO, 'scripts', 'post-advice-settlements.mjs'), '--live']);
            steps.push({ step: 'post', ok: r3.ok, tail: tailOf(r3.stdout, 8) }); ok = ok && r3.ok;
          }
        }
      } else {
        // The bill: parse + match + write bill lines. No bank receipts are
        // ever posted from a bill (the advice does that); trips are marked
        // BILLED, never PAID, by the document alone.
        const r1 = await runChild(PYTHON, [path.join(TOOLS, 'iocl_bill_automation.py'), '--live', '--no-fetch', '--no-vouchers', '--settlement-basis', 'billed',
          '--bill-dir', dir, '--window-from', '2026-04-01', '--window-to', new Date().toISOString().slice(0, 10)]);
        steps.push({ step: 'parse+match', ok: r1.ok, tail: tailOf(r1.ok ? r1.stdout : (r1.stderr || r1.stdout), 14) }); ok = ok && r1.ok;
      }
      const { rows } = await query(`SELECT customer_bill_refresh(id) FROM customer_bills WHERE status <> 'CANCELLED' AND period_from >= current_date - interval '240 days'`).catch(() => ({ rows: [] }));
      const { autoRaiseCustomerBills } = await import('../lib/customerBillRaise.js');
      const ar = await autoRaiseCustomerBills({ by: `desk:${who}` }).catch(() => ({ raised: 0 }));
      const summary = `${kind === 'ADVICE' ? 'Payment advice' : 'Transportation bill'} "${part.filename}" filed for ${firm === 'jaiswal' ? 'Jaiswal Enterprise' : 'Prasad Transport'}: ${ok ? 'read and reconciled' : 'the parser reported a problem'}; ${rows.length} bill(s) re-read, ${ar.raised} raised automatically.`;
      return { ok, kind, firm, saved: path.relative(REPO, dest), summary, steps, tail: steps.map((s) => `— ${s.step}: ${s.ok ? 'ok' : 'FAILED'}\n${s.tail}`).join('\n') };
    });
  });

  app.get('/:id/summary-text', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const bill = await billById(id);
    if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { text: billText(bill), bill };
  });

  app.post('/:id/email', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const to = String(req.body?.to ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return reply.code(400).send({ error: 'BAD_EMAIL' });
    const bill = await billById(id);
    if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
    try {
      const r = await sendMail(to, `${bill.bill_no} — ${bill.customer_name} — bill ${bill.cycle_label}`, billText(bill).replace(/\*/g, ''));
      return { sent: true, to, channel: r?.channel ?? 'gmail' };
    } catch (e) { return reply.code(502).send({ error: e.code ?? 'MAIL_FAILED', detail: e.message }); }
  });
}
