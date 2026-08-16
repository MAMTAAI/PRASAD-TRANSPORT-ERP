// server/modules/fortnightBilling.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Fortnightly auto-billing: fetch by unloading date, split into the invoices
// that actually have to exist, price each line, and hand each group to the
// existing POST /billing/bills — which already writes company_bills +
// company_bill_trips and posts the SALES journal through TARA.
//
// This module GROUPS and PRICES. It does not invent a second way to create a
// bill, because a second way is a second set of rules about when revenue
// reaches the ledger.
//
// UNLOADING DATE, NOT LOADING DATE. A trip loaded on the 14th and unloaded on
// the 17th belongs to the second half. Billing it on the loading date would put
// revenue in a fortnight where the delivery had not happened, and the customer's
// own records would disagree.
//
// WHY THE SPLIT IS THREE-DEEP
//   operating company   different GSTIN, letterhead, bank account and invoice
//                       series. Two companies on one invoice is not a formatting
//                       problem, it is the wrong legal entity billing.
//   customer            obviously.
//   unloading depot     an oil company reconciles per receiving location; a
//                       Guwahati depot will not pass a line that unloaded at
//                       Agartala.
//
// The grouping key is trimmed and upper-cased. That is not defensive
// programming: operating_company genuinely held "M/S JAISWAL ENTERPRISE  " with
// trailing spaces alongside "JAISWAL ENTERPRISE", and grouping on the raw column
// put one company on two invoices.
import { query } from '../db/pool.js';
import { requireAdminOrService } from './auth.routes.js';
import { computeFreight } from '../lib/freightRate.js';

const HALVES = { FIRST: [1, 15], SECOND: [16, 31] };

/** Fortnight bounds. The 2nd half ends on the real last day, never a hardcoded 31. */
function fortnightBounds(year, month, half) {
  const last = new Date(year, month, 0).getDate();
  const [d1, d2] = half === 'SECOND' ? [16, last] : [1, 15];
  const iso = (d) => `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { from: iso(d1), to: iso(d2), label: `${iso(d1)}..${iso(d2)}` };
}

/** Every fortnight between two dates, inclusive. */
function fortnightsBetween(from, to) {
  const out = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  let y = start.getUTCFullYear(), m = start.getUTCMonth() + 1;
  while (y < end.getUTCFullYear() || (y === end.getUTCFullYear() && m <= end.getUTCMonth() + 1)) {
    for (const half of ['FIRST', 'SECOND']) {
      const b = fortnightBounds(y, m, half);
      if (b.to >= from && b.from <= to) out.push({ year: y, month: m, half, ...b });
    }
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export async function registerFortnightBillingRoutes(app, opts = {}) {
  const guard = opts.requireAdmin || requireAdminOrService;

  // Preview: what would be billed, split exactly as it would be, priced exactly
  // as it would be. Changes nothing.
  app.post('/plan-fortnights', { preHandler: guard }, async (req, reply) => {
    const from = req.body?.from;
    const to = req.body?.to;
    if (!from || !to) return reply.code(400).send({ error: 'BAD_RANGE', detail: 'from and to are required (YYYY-MM-DD)' });

    const periods = fortnightsBetween(from, to);
    const out = [];

    for (const p of periods) {
      // UNBILLED ONLY. A trip already on a bill must never appear on a second
      // one; company_bill_trips is the record of that, and it is the only
      // check that survives a re-run.
      const { rows: trips } = await query(
        `SELECT t.id, t.trip_code, t.vehicle_no, t.driver_name, t.challan_no,
                t.loading_date, t.unloading_date, t.loading_point, t.unloading_location,
                t.consignee_name, t.customer_name, t.customer_id,
                btrim(t.operating_company)               AS operating_company,
                t.product_type, t.rtkm, t.rate, t.loaded_qty, t.unloaded_qty,
                t.shortage_qty, t.shortage_penalty, t.billed_amount, t.iocl_invoice_no
           FROM trips t
          WHERE t.unloading_date BETWEEN $1::date AND $2::date
            -- THE PREREQUISITE IS 'UNLOADED', AND IN THIS ERP THAT IS COMPLETED.
            --
            -- The obvious reading is "only bill SETTLED trips". That would bill
            -- nothing: not one row in this database has status SETTLED, and the
            -- status ladder is PENDING -> LOADED -> IN_TRANSIT -> UNLOADING ->
            -- COMPLETED -> SETTLED, where SETTLED means the BILL has been
            -- settled. Requiring it before billing is circular -- a trip
            -- becomes SETTLED because it was billed and paid.
            --
            -- COMPLETED is the state that means "unloaded", and it is what the
            -- unload endpoint sets. An IN_TRANSIT trip is excluded here even if
            -- it somehow carries an unloading_date, which is the substance of
            -- the requirement.
            AND t.status IN ('COMPLETED', 'SETTLED')
            AND NOT EXISTS (SELECT 1 FROM company_bill_trips bt WHERE bt.trip_id = t.id)
          ORDER BY t.unloading_date, t.trip_code`,
        [p.from, p.to],
      );
      if (!trips.length) continue;

      // HOW DEEP TO SPLIT IS A BUSINESS DECISION, NOT A TECHNICAL ONE.
      //
      // Splitting to depot produced 447 invoices for 820 trips, 287 of them
      // carrying a single trip -- an invoice per delivery. That is right if the
      // customer reconciles per receiving location and wrong if they expect one
      // statement per fortnight. The depot always appears as a LINE COLUMN
      // either way, so 'CUSTOMER' loses no information from the invoice; it
      // only stops splitting on it.
      //
      //   COMPANY_CUSTOMER_DEPOT  (default)  legal entity + customer + depot
      //   CUSTOMER                           legal entity + customer
      const level = String(req.body?.group_by || 'COMPANY_CUSTOMER_DEPOT').toUpperCase();
      const groups = new Map();
      for (const t of trips) {
        const company = (t.operating_company || 'UNKNOWN').trim();
        const customer = (t.customer_name || t.consignee_name || 'UNKNOWN').trim();
        const depot = (t.unloading_location || t.consignee_name || 'UNKNOWN').trim();
        // The operating company is never collapsed: it is a different GSTIN and
        // a different invoice series, so merging two of them is the wrong legal
        // entity billing, not a coarser grouping.
        const key = level === 'CUSTOMER'
          ? `${company.toUpperCase()}||${customer.toUpperCase()}`
          : `${company.toUpperCase()}||${customer.toUpperCase()}||${depot.toUpperCase()}`;
        if (!groups.has(key)) {
          groups.set(key, {
            company, customer,
            depot: level === 'CUSTOMER' ? '(multiple - see lines)' : depot,
            trips: [], totals: {},
          });
        }
        groups.get(key).trips.push(t);
      }

      for (const g of groups.values()) {
        let gross = 0, shortage = 0, priced = 0, unpriced = [];
        for (const t of g.trips) {
          // Quantity billed is what was DELIVERED where that is known. Billing
          // the loaded figure on a short delivery invoices the customer for
          // fuel they did not receive, and the shortage line then tries to take
          // it back on the same invoice.
          const qty = Number(t.unloaded_qty ?? t.loaded_qty ?? 0);
          const f = await computeFreight({
            product: t.product_type, rtkm: t.rtkm, qty,
            shipToCode: null, onDate: t.unloading_date,
          });
          // An amount already agreed with the customer outranks a computed one.
          const amount = t.billed_amount != null && Number(t.billed_amount) > 0
            ? Number(t.billed_amount)
            : f.amount;
          t._priced = {
            qty, unit: f.unit, rate: f.rate, rule: f.rule,
            billable_rtkm: f.billable_rtkm, amount,
            source: t.billed_amount > 0 ? 'EXISTING_BILLED_AMOUNT' : (f.amount != null ? 'RATE_ENGINE' : null),
            reason: f.reason,
          };
          if (amount != null) { gross += amount; priced += 1; }
          else unpriced.push({ trip_code: t.trip_code, why: f.reason });
          shortage += Number(t.shortage_penalty ?? 0);
        }
        g.totals = {
          trips: g.trips.length, priced, unpriced: unpriced.length,
          gross: Math.round(gross * 100) / 100,
          shortage: Math.round(shortage * 100) / 100,
          net: Math.round((gross - shortage) * 100) / 100,
        };
        g.unpriced = unpriced;
        g.lines = g.trips.map((t, i) => ({
          sl: i + 1, trip_id: t.id, trip_code: t.trip_code, vehicle_no: t.vehicle_no,
          challan_no: t.challan_no, iocl_invoice_no: t.iocl_invoice_no,
          loading_date: t.loading_date, unloading_date: t.unloading_date,
          route: `${t.loading_point ?? '?'} -> ${t.unloading_location ?? '?'}`,
          rtkm: t._priced.billable_rtkm ?? t.rtkm,
          qty: t._priced.qty, unit: t._priced.unit,
          rate: t._priced.rate, rule: t._priced.rule,
          gross_freight: t._priced.amount,
          shortage_amt: Number(t.shortage_penalty ?? 0),
          priced_from: t._priced.source,
          why: t._priced.reason,
        }));
        delete g.trips;
      }

      out.push({ period: p, groups: [...groups.values()] });
    }

    const totals = out.reduce((a, p) => {
      for (const g of p.groups) {
        a.groups += 1; a.trips += g.totals.trips; a.priced += g.totals.priced;
        a.unpriced += g.totals.unpriced; a.gross += g.totals.gross;
      }
      return a;
    }, { groups: 0, trips: 0, priced: 0, unpriced: 0, gross: 0 });
    totals.gross = Math.round(totals.gross * 100) / 100;

    return { ok: true, range: [from, to], fortnights: out.length, totals, periods: out };
  });

  // ── Generate ───────────────────────────────────────────────────────────────
  // Delegates every group to POST /billing/bills via app.inject, so bills are
  // created and revenue reaches the ledger by EXACTLY the path the Bill
  // Management screen uses. A second insert path would be a second set of rules
  // about when revenue is recognised.
  //
  // Sequential on purpose. Bill numbers are minted from the current maximum,
  // and 460 concurrent injections would race for the same number.
  app.post('/generate-fortnights', { preHandler: guard }, async (req, reply) => {
    const from = req.body?.from, to = req.body?.to;
    if (!from || !to) return reply.code(400).send({ error: 'BAD_RANGE', detail: 'from and to are required' });

    // Reuse the planner verbatim: what is generated is what was previewed.
    const planRes = await app.inject({
      method: 'POST', url: '/api/v1/billing/plan-fortnights',
      headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' },
      payload: { from, to, group_by: req.body?.group_by ?? 'COMPANY_CUSTOMER_DEPOT' },
    });
    if (planRes.statusCode !== 200) {
      return reply.code(502).send({ error: 'PLAN_FAILED', detail: planRes.body.slice(0, 400) });
    }
    const plan = planRes.json();

    const created = [], failed = [];
    let grossPosted = 0, linesManual = 0;

    for (const p of plan.periods) {
      for (const g of p.groups) {
        const trips = g.lines.map((l) => ({
          trip_id: l.trip_id,
          qty: Number(l.qty) || 0,
          rate: Number(l.rate) || 0,
          rtkm: Number(l.rtkm) || 0,
          // A line the engine could not price goes on at zero and says so. The
          // CHECK constraint refuses a manual_rate_required line that carries a
          // number, so these two can never drift apart.
          gross_freight: l.gross_freight == null ? 0 : Number(l.gross_freight),
          shortage_amt: Number(l.shortage_amt) || 0,
          lr_no: l.challan_no ?? null,
          billing_type: l.unit === 'MT' ? 'PER_MT' : 'PER_KL',
          provisional: true,
          manual_rate_required: l.gross_freight == null,
          pricing_note: l.gross_freight == null
            ? `unpriced: ${l.why ?? 'rate engine could not price this line'}`
            : `${l.rule ?? 'STANDARD'} via ${l.priced_from ?? 'RATE_ENGINE'}`,
        }));
        linesManual += trips.filter((t) => t.manual_rate_required).length;

        const res = await app.inject({
          method: 'POST', url: '/api/v1/billing/bills',
          headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' },
          payload: {
            company: g.company,
            location: g.depot,
            billing_period: `${p.period.half === 'FIRST' ? '1st Half' : '2nd Half'} ${p.period.year}-${String(p.period.month).padStart(2, '0')}`,
            period_from: p.period.from,
            period_to: p.period.to,
            bill_date: p.period.to,
            created_by: 'fortnight-auto-billing',
            post_revenue: true,
            trips,
          },
        });

        if (res.statusCode >= 200 && res.statusCode < 300) {
          const body = res.json();
          created.push({
            bill_no: body.bill?.bill_no ?? body.bill_no ?? null,
            company: g.company, customer: g.customer, depot: g.depot,
            period: p.period.label, trips: trips.length,
            gross: g.totals.gross, manual: trips.filter((t) => t.manual_rate_required).length,
          });
          grossPosted += Number(g.totals.gross) || 0;
        } else {
          failed.push({
            company: g.company, customer: g.customer, depot: g.depot,
            period: p.period.label, trips: trips.length,
            status: res.statusCode, detail: res.body.slice(0, 220),
          });
        }
      }
    }

    return {
      ok: true,
      range: [from, to],
      bills_created: created.length,
      bills_failed: failed.length,
      gross_posted: Math.round(grossPosted * 100) / 100,
      lines_needing_manual_rate: linesManual,
      created: created.slice(0, 40),
      failed: failed.slice(0, 40),
    };
  });
}
