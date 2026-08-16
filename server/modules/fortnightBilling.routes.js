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
          sl: i + 1, trip_code: t.trip_code, vehicle_no: t.vehicle_no,
          challan_no: t.challan_no, iocl_invoice_no: t.iocl_invoice_no,
          loading_date: t.loading_date, unloading_date: t.unloading_date,
          route: `${t.loading_point ?? '?'} -> ${t.unloading_location ?? '?'}`,
          rtkm: t._priced.billable_rtkm ?? t.rtkm,
          qty: t._priced.qty, unit: t._priced.unit,
          rate: t._priced.rate, rule: t._priced.rule,
          gross_freight: t._priced.amount,
          shortage_amt: Number(t.shortage_penalty ?? 0),
          priced_from: t._priced.source,
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
}
