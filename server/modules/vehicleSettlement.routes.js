// server/modules/vehicleSettlement.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// VEHICLE-WISE 15-DAY SETTLEMENT — draft, review, approve, lock.
//
// Maker-checker, and the two roles are enforced in different places on purpose:
//   • the MAKER (any signed-in staff) edits a draft and saves it
//   • the CHECKER (admin only) approves, which posts and locks
// A screen that hides the Approve button is a courtesy, not a control; the
// control is requireAdminRole on the approve route.
//
// WHAT APPROVAL POSTS, AND WHY IT IS NOT THE WHOLE P&L
// The brief asked for "posts the final P&L to the main accounting ledger".
// Doing that literally books the business twice: the freight reaches the ledger
// through customer billing and the diesel reaches it through the fortnightly
// pump bill (FUELBILL_ vouchers). What exists in NO other flow is the manual
// adjustments a reviewer keys in — detention, a driver bonus, a workshop bill
// nobody raised a voucher for — so that is what posts. The rest of the
// statement is a report over money the other flows own, and it says so on the
// screen.
//
// See migration 158 for the audit that decided the income column: billed_amount
// (Rs2.91 crore, 765 trips) rather than freight_amount (21 trips, and rate x
// qty with the kilometres missing).
import { postVoucher } from '../agents/tara.js';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const clamp = (v, d, max) => Math.min(Math.max(1, Number(v) || d), max);

/** Money as a reviewer typed it: a number, or nothing at all. */
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[, ₹]/g, ''));
  return Number.isFinite(n) ? r2(n) : null;
}

export async function registerVehicleSettlementRoutes(app) {
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };

  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';

  // ═══ THE CYCLE LIST — what the screen opens on ═══════════════════════════
  app.get('/cycles', staff, async () => {
    const { rows } = await query('SELECT * FROM v_vehicle_settlement_cycles LIMIT 40');
    return { cycles: rows };
  });

  // ═══ THE DRAFTS IN ONE CYCLE ════════════════════════════════════════════
  //
  // Stored settlements where they exist, LIVE draft figures where they do not —
  // so a fortnight nobody has generated yet still shows its real numbers
  // instead of an empty screen that reads as "no work here".
  app.get('/drafts', staff, async (req) => {
    const q = req.query ?? {};
    const from = DATE_RE.test(String(q.period_from ?? '')) ? q.period_from : null;
    const status = ['AI_DRAFT', 'STAFF_REVIEWED', 'APPROVED'].includes(q.status) ? q.status : null;
    const limit = clamp(q.limit, 200, 500);

    const { rows } = await query(`
      SELECT d.vehicle_key, d.vehicle_no, d.vehicle_id, d.operating_company,
             d.period_from, d.period_to, d.cycle,
             fortnight_label(d.period_from)                      AS cycle_label,
             d.trips_count      AS live_trips,
             d.billed_amount    AS live_billed,
             d.expense_total    AS live_expense,
             d.net              AS live_net,
             d.loaded_qty, d.rtkm,
             s.id, s.status, s.reviewed_by, s.reviewed_at, s.approved_by, s.approved_at,
             s.voucher_id, s.locked_at,
             COALESCE(s.trips_count,   d.trips_count)             AS trips_count,
             COALESCE(s.billed_amount, d.billed_amount)           AS billed_amount,
             COALESCE(s.received_amount, d.received_amount)       AS received_amount,
             COALESCE(s.hsd, d.hsd)                               AS hsd,
             COALESCE(s.toll, d.toll)                             AS toll,
             COALESCE(s.tyre, d.tyre)                             AS tyre,
             COALESCE(s.maintenance, d.maintenance)               AS maintenance,
             COALESCE(s.other_expense, d.other_expense)           AS other_expense,
             COALESCE(s.advances, d.advances)                     AS advances,
             COALESCE(s.other_income, 0)                          AS other_income,
             COALESCE(s.adjustments, '[]'::jsonb)                 AS adjustments,
             COALESCE(v.gross_income,
                      d.billed_amount)                            AS gross_income,
             COALESCE(v.total_expense, d.expense_total)           AS total_expense,
             (COALESCE(v.gross_income, d.billed_amount)
              - COALESCE(v.total_expense, d.expense_total))::numeric(14,2) AS net,
             -- A stored draft whose trips have moved since it was built. The
             -- screen shows this rather than silently refreshing, because a
             -- reviewer's numbers must not change under them mid-review.
             (s.id IS NOT NULL AND (s.trips_count <> d.trips_count
                                 OR s.billed_amount <> d.billed_amount))  AS stale
        FROM v_vehicle_fortnight_draft d
        LEFT JOIN vehicle_fortnight_settlements s
          ON s.vehicle_key = d.vehicle_key AND s.period_from = d.period_from
        LEFT JOIN v_vehicle_settlement v ON v.id = s.id
       WHERE ($1::date IS NULL OR d.period_from = $1::date)
         AND ($2::text IS NULL OR s.status = $2::text)
       ORDER BY d.period_from DESC, (COALESCE(v.gross_income, d.billed_amount)
              - COALESCE(v.total_expense, d.expense_total)) ASC
       LIMIT $3`, [from, status, limit]);

    const sum = (k) => r2(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0));
    return {
      rows,
      totals: {
        lorries: rows.length,
        trips: rows.reduce((a, r) => a + (Number(r.trips_count) || 0), 0),
        income: sum('gross_income'),
        expense: sum('total_expense'),
        net: sum('net'),
        drafts: rows.filter((r) => !r.status || r.status === 'AI_DRAFT').length,
        reviewed: rows.filter((r) => r.status === 'STAFF_REVIEWED').length,
        approved: rows.filter((r) => r.status === 'APPROVED').length,
      },
    };
  });

  // ═══ BUILD THE DRAFTS FOR A FORTNIGHT ═══════════════════════════════════
  //
  // Safe to press twice. The function refreshes untouched AI drafts and steps
  // around anything a person has reviewed or approved.
  app.post('/build', staff, async (req, reply) => {
    const b = req.body ?? {};
    if (!DATE_RE.test(String(b.period_from ?? ''))) {
      return reply.code(400).send({ error: 'BAD_PERIOD', detail: 'period_from must be YYYY-MM-DD' });
    }
    const { rows: [out] } = await query(
      'SELECT * FROM vehicle_fortnight_build($1::date, $2)', [b.period_from, actor(req)]);
    return {
      built: true,
      created: out.created, refreshed: out.refreshed, skipped: out.skipped,
      note: out.skipped
        ? `${out.skipped} settlement pehle se review/approve ho chuke hain — unhe haath nahi lagaya.`
        : null,
    };
  });

  // ═══ THE WHOLE FORTNIGHT AS ONE BILL ════════════════════════════════════
  //
  // Laid out the way IOCL lays out the transportation bill they send us
  // (0011024699_7R01, 16–30.06.2026): every trip listed under its lorry, a
  // "Subtotal for Vehicle" under each block, and one "Total of All Bills" at
  // the foot. The owner reads that document every fortnight, so the report of
  // their OWN money is easier to check line-against-line in the same shape.
  //
  // One query for the whole fleet rather than one per lorry: at 47 lorries and
  // 170 trips a per-lorry round trip is 47 round trips, and the screen is meant
  // to be read top to bottom in one go.
  app.get('/report', staff, async (req, reply) => {
    const q = req.query ?? {};
    if (!DATE_RE.test(String(q.period_from ?? ''))) {
      return reply.code(400).send({ error: 'BAD_PERIOD' });
    }
    const only = String(q.company ?? '').trim();

    const { rows } = await query(`
      SELECT btrim(t.operating_company)                                   AS company,
             upper(regexp_replace(t.vehicle_no,'[^A-Za-z0-9]','','g'))    AS vehicle_key,
             t.vehicle_no,
             -- THE TWO NAMES ARE DIFFERENT THINGS, and the report used to show
             -- only the first. operating_company is WHOSE BOOKS the trip was
             -- billed in; owner_name is WHOSE LORRY it is. AS 19C 8666 runs
             -- under M/S PRASAD TRANSPORT and belongs to SANTOSH PRASAD, and
             -- an owner's lorries run for up to three of the firms.
             v.owner_name,
             v.ownership::text                                            AS ownership,
             vehicle_class(t.vehicle_no)::text                            AS fleet_class,
             p.trip_id, p.trip_code, t.iocl_bill_no, t.challan_no,
             t.loading_date, t.unloading_date,
             p.customer_name, t.unloading_location, t.product_type,
             t.loaded_qty, t.shortage_qty, t.rtkm, t.rate,
             COALESCE(t.billed_amount,0)::numeric(14,2)                   AS billed,
             COALESCE(t.received_amount,0)::numeric(14,2)                 AS received,
             COALESCE(t.shortage_penalty,0)::numeric(14,2)                AS penalty,
             p.hsd, p.toll, p.tyre, p.maintenance, p.other, p.expense_total, p.advances
        FROM trips t
        JOIN v_trip_pnl p ON p.trip_id = t.id
        LEFT JOIN vehicles v
          ON v.vehicle_no_norm = upper(regexp_replace(t.vehicle_no,'[^A-Za-z0-9]','','g'))
       WHERE t.status = 'COMPLETED'
         AND t.vehicle_no IS NOT NULL
         AND fortnight_from(COALESCE(t.unloading_date, t.loading_date)) = $1::date
         AND ($2 = '' OR btrim(t.operating_company) = $2)
       ORDER BY btrim(t.operating_company),
                COALESCE(v.owner_name,'~'),
                upper(regexp_replace(t.vehicle_no,'[^A-Za-z0-9]','','g')),
                COALESCE(t.unloading_date, t.loading_date), p.trip_code`,
      [q.period_from, only]);

    // The settlement already opened for each lorry, so the report can show
    // where it stands and what our commission on it is without a second call.
    const { rows: settled } = await query(`
      SELECT vehicle_key, id, status, approved_by, locked_at, adjustments,
             fleet_class::text AS fleet_class, owner_name,
             commission_amount, commission_basis, commission_rate,
             tds_amount, payable_to_owner, expenses_recovered
        FROM vehicle_fortnight_settlements WHERE period_from = $1::date`, [q.period_from]);
    const byKey = new Map(settled.map((s) => [s.vehicle_key, s]));

    const zero = () => ({ trips: 0, qty: 0, rtkm: 0, billed: 0, penalty: 0, hsd: 0, toll: 0,
                          other: 0, expense: 0, advances: 0, adj_income: 0, adj_expense: 0,
                          commission: 0, tds: 0, payable: 0, our_earning: 0, without_rate: 0 });
    const addTrip = (st, r) => {
      st.trips += 1;
      st.qty += Number(r.loaded_qty) || 0;
      st.rtkm += Number(r.rtkm) || 0;
      st.billed += Number(r.billed) || 0;
      st.penalty += Number(r.penalty) || 0;
      st.hsd += Number(r.hsd) || 0;
      st.toll += Number(r.toll) || 0;
      st.other += (Number(r.tyre) || 0) + (Number(r.maintenance) || 0) + (Number(r.other) || 0);
      st.expense += Number(r.expense_total) || 0;
      st.advances += Number(r.advances) || 0;
    };
    const roll = (into, from) => {
      for (const k of Object.keys(into)) into[k] = r2((into[k] || 0) + (Number(from[k]) || 0));
    };

    // ── company → owner → lorry ───────────────────────────────────────────
    const companies = [];
    let co = null; let ow = null; let ve = null;
    for (const r of rows) {
      const cName = r.company || '(company darj nahi)';
      // A lorry with no master row has no owner either — said plainly rather
      // than filed under a blank heading nobody can act on.
      const oName = r.owner_name || '(owner darj nahi)';

      if (!co || co.company !== cName) {
        co = { company: cName, owners: [], subtotal: zero() };
        companies.push(co); ow = null; ve = null;
      }
      if (!ow || ow.owner_name !== oName) {
        ow = { owner_name: oName, company: cName, vehicles: [], subtotal: zero() };
        co.owners.push(ow); ve = null;
      }
      if (!ve || ve.vehicle_key !== r.vehicle_key) {
        const s = byKey.get(r.vehicle_key);
        ve = {
          vehicle_key: r.vehicle_key, vehicle_no: r.vehicle_no,
          owner_name: oName, company: cName,
          ownership: r.ownership, fleet_class: r.fleet_class ?? s?.fleet_class ?? null,
          settlement_id: s?.id ?? null, status: s?.status ?? null,
          approved_by: s?.approved_by ?? null, locked: !!s?.locked_at,
          adjustments: s?.adjustments ?? [],
          commission_basis: s?.commission_basis ?? null,
          commission_rate: s?.commission_rate ?? null,
          commission_amount: s?.commission_amount ?? null,
          tds_amount: s?.tds_amount ?? null,
          payable_to_owner: s?.payable_to_owner ?? null,
          trips: [], subtotal: zero(),
        };
        ow.vehicles.push(ve);
      }
      ve.trips.push(r);
      addTrip(ve.subtotal, r);
    }

    // Close each lorry, then roll up. Adjustments belong to the LORRY, not to
    // any one trip — the same place a reviewer entered them.
    const flatVehicles = [];
    for (const c of companies) {
      for (const o of c.owners) {
        for (const v of o.vehicles) {
          const adj = Array.isArray(v.adjustments) ? v.adjustments : [];
          const st = v.subtotal;
          st.adj_income = r2(adj.filter((a) => a.side === 'INCOME')
            .reduce((n, a) => n + (Number(a.amount) || 0), 0));
          st.adj_expense = r2(adj.filter((a) => a.side === 'EXPENSE')
            .reduce((n, a) => n + (Number(a.amount) || 0), 0));
          for (const k of ['qty', 'rtkm', 'billed', 'penalty', 'hsd', 'toll', 'other',
                           'expense', 'advances']) st[k] = r2(st[k]);
          st.income = r2(st.billed + st.adj_income);
          st.expense_all = r2(st.expense + st.adj_expense);
          st.net = r2(st.income - st.expense_all);

          // On an attached or market lorry only the commission is ours; on an
          // own lorry the whole margin is. One rule, stated once.
          const agency = ['ATTACHED', 'MARKET'].includes(v.fleet_class);
          st.commission = agency ? (v.commission_amount === null ? 0 : Number(v.commission_amount)) : 0;
          st.tds = agency ? Number(v.tds_amount || 0) : 0;
          st.payable = agency ? Number(v.payable_to_owner || 0) : 0;
          st.our_earning = agency
            ? (v.commission_amount === null ? 0 : Number(v.commission_amount))
            : st.net;
          st.without_rate = (agency && v.commission_amount === null) ? 1 : 0;
          v.needs_rate = st.without_rate === 1;

          roll(o.subtotal, st);
          flatVehicles.push(v);
        }
        // An owner is ATTACHED to us if any of their lorries here is.
        o.fleet_classes = [...new Set(o.vehicles.map((v) => v.fleet_class).filter(Boolean))];
        o.lorries = o.vehicles.length;
        roll(c.subtotal, o.subtotal);
      }
      c.lorries = c.owners.reduce((n, o) => n + o.lorries, 0);
      c.owner_count = c.owners.length;
    }

    const grand = companies.reduce((a, c) => { roll(a, c.subtotal); return a; }, zero());
    grand.companies = companies.length;
    grand.owners = companies.reduce((n, c) => n + c.owner_count, 0);
    grand.lorries = flatVehicles.length;

    const { rows: [meta] } = await query(
      `SELECT fortnight_label($1::date) label, fortnight_to($1::date) period_to`, [q.period_from]);
    const { rows: coList } = await query(`
      SELECT DISTINCT btrim(operating_company) AS c FROM trips
       WHERE status='COMPLETED' AND operating_company IS NOT NULL
         AND fortnight_from(COALESCE(unloading_date, loading_date)) = $1::date
       ORDER BY 1`, [q.period_from]);

    return {
      period: { from: q.period_from, to: meta?.period_to, label: meta?.label },
      company: only || null,
      companies_list: coList.map((c) => c.c),
      companies,
      // Kept so an older client that reads a flat list still works.
      vehicles: flatVehicles,
      grand,
    };
  });


  // ═══ ONE SETTLEMENT, IN FULL ════════════════════════════════════════════
  app.get('/:id', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });

    const { rows } = await query('SELECT * FROM v_vehicle_settlement WHERE id = $1::uuid', [id]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    const s = rows[0];

    // The trips as they are NOW, beside the snapshot taken when the draft was
    // built. A statement that only ever shows the snapshot cannot tell a
    // reviewer that a trip was added yesterday.
    const { rows: live } = await query(`
      SELECT p.trip_id, p.trip_code, p.loading_date, p.unloading_date,
             p.customer_name, p.driver_name, p.status,
             t.billed_amount, t.received_amount, t.loaded_qty, t.rtkm,
             p.hsd, p.toll, p.tyre, p.maintenance, p.other,
             p.expense_total, p.advances
        FROM v_trip_pnl p
        JOIN trips t ON t.id = p.trip_id
       WHERE upper(regexp_replace(t.vehicle_no,'[^A-Za-z0-9]','','g')) = $1
         AND t.status = 'COMPLETED'
         AND fortnight_from(COALESCE(t.unloading_date, t.loading_date)) = $2::date
       ORDER BY COALESCE(t.unloading_date, t.loading_date), p.trip_code`,
      [s.vehicle_key, s.period_from]);

    return { settlement: s, trips: live, snapshot: s.lines ?? [] };
  });

  // ═══ THE MAKER SAVES ════════════════════════════════════════════════════
  //
  // Saving does NOT post anything. It records what a person corrected and moves
  // the row to STAFF_REVIEWED so the checker can see it has been looked at.
  app.patch('/:id', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {};

    const { rows: cur } = await query(
      'SELECT * FROM vehicle_fortnight_settlements WHERE id = $1::uuid', [id]);
    if (!cur.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (cur[0].locked_at) {
      return reply.code(409).send({
        error: 'LOCKED',
        detail: 'Yeh settlement approve ho chuka hai. Pehle "Reopen" kijiye.',
      });
    }

    // Only the buckets a person is allowed to correct. billed_amount and the
    // trip count come from the register and are not typed in here — if they are
    // wrong the trip is wrong, and that is a different screen.
    const editable = ['hsd', 'toll', 'tyre', 'maintenance', 'other_expense',
                      'other_income', 'advances'];
    const sets = []; const args = [id];
    for (const f of editable) {
      const v = money(b[f]);
      if (v !== null) { args.push(v); sets.push(`${f} = $${args.length}`); }
    }

    if (Array.isArray(b.adjustments)) {
      // Each line is normalised here rather than trusted: a bad `side` would
      // silently flip an expense into income in the view's SUM.
      const adj = b.adjustments
        .map((a) => ({
          label: String(a?.label ?? '').slice(0, 120).trim(),
          amount: money(a?.amount) ?? 0,
          side: a?.side === 'INCOME' ? 'INCOME' : 'EXPENSE',
          added_by: a?.added_by ?? actor(req),
          added_at: a?.added_at ?? new Date().toISOString(),
        }))
        .filter((a) => a.label && a.amount !== 0);
      args.push(JSON.stringify(adj));
      sets.push(`adjustments = $${args.length}::jsonb`);
    }
    if (typeof b.notes === 'string') {
      args.push(b.notes.slice(0, 2000));
      sets.push(`notes = $${args.length}`);
    }
    if (!sets.length) return reply.code(400).send({ error: 'NOTHING_TO_SAVE' });

    args.push(actor(req));
    sets.push(`reviewed_by = $${args.length}`, 'reviewed_at = now()',
              `status = CASE WHEN status = 'AI_DRAFT' THEN 'STAFF_REVIEWED' ELSE status END`);

    const { rows } = await query(
      `UPDATE vehicle_fortnight_settlements SET ${sets.join(', ')}
        WHERE id = $1::uuid RETURNING id`, args);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });

    const { rows: [out] } = await query('SELECT * FROM v_vehicle_settlement WHERE id = $1::uuid', [id]);
    return { saved: true, settlement: out };
  });

  // ═══ THE CHECKER APPROVES ═══════════════════════════════════════════════
  app.post('/:id/approve', admin, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });

    const { rows } = await query('SELECT * FROM v_vehicle_settlement WHERE id = $1::uuid', [id]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    const s = rows[0];
    if (s.locked_at) {
      return reply.code(409).send({ error: 'ALREADY_APPROVED', settlement: s });
    }

    // ── the gate the database also holds ───────────────────────────────────
    //
    // An attached or market lorry with no commission rate on file cannot be
    // approved: its commission is NULL, and NULL is not zero. Migration 159's
    // trigger refuses it too (P0410) — this is the message a person reads.
    if (['ATTACHED', 'MARKET'].includes(s.fleet_class) && s.commission_amount === null) {
      return reply.code(409).send({
        error: 'NO_COMMISSION_RATE',
        detail: `${s.vehicle_no} ${s.fleet_class === 'MARKET' ? 'market' : 'attached'} lorry hai — `
              + 'pehle iska commission rate darj kijiye, tab hi approve hoga.',
        vehicle_key: s.vehicle_key,
      });
    }

    const adj = Array.isArray(s.adjustments) ? s.adjustments : [];
    const adjExpense = r2(adj.filter((a) => a.side === 'EXPENSE')
                             .reduce((n, a) => n + (Number(a.amount) || 0), 0));
    const adjIncome = r2(adj.filter((a) => a.side === 'INCOME')
                            .reduce((n, a) => n + (Number(a.amount) || 0), 0));

    const isAgency = ['ATTACHED', 'MARKET'].includes(s.fleet_class);
    const num = (v) => Number(v) || 0;
    const lines = [];
    let narration;

    if (isAgency) {
      // ── AN ATTACHED OR MARKET LORRY ──────────────────────────────────────
      //
      // The freight is the OWNER'S money that we collected. Out of it we keep
      // the commission, withhold TDS on what we pay them, and take back the
      // diesel and tolls we advanced. ONLY THE COMMISSION IS OUR INCOME —
      // which is exactly what the owner asked for: "yaha ka balance sheet may
      // profit may sirf comition hi add hogi".
      //
      // The journal balances by construction:
      //   freight = commission + tds + expenses recovered + payable to owner
      const freight = r2(num(s.billed_amount));
      const comm = r2(num(s.commission_amount));
      const tds = r2(num(s.tds_amount));
      const rec = r2(num(s.expenses_recovered));
      const payable = r2(freight - comm - tds - rec);

      lines.push({ ledger: 'Attached Vehicle Freight Control', dr_cr: 'DR',
                   amount: freight, group: 'Current Liabilities' });
      if (comm > 0) {
        lines.push({ ledger: 'Commission Income - Attached Vehicles', dr_cr: 'CR',
                     amount: comm, group: 'Direct Income' });
      }
      if (tds > 0) {
        lines.push({ ledger: `TDS Payable (${s.tds_pct ?? 0}% 194C)`, dr_cr: 'CR',
                     amount: tds, group: 'Duties & Taxes' });
      }
      if (rec > 0) {
        // A recovery, not income: the diesel was already booked as our expense
        // when the pump bill posted, and this takes it back out.
        lines.push({ ledger: 'Vehicle Expense Recovery', dr_cr: 'CR',
                     amount: rec, group: 'Direct Expenses - Vehicle Operations' });
      }
      if (payable > 0) {
        lines.push({ ledger: `Vehicle Owner: ${s.owner_name ?? s.vehicle_no}`, dr_cr: 'CR',
                     amount: payable, group: 'Sundry Creditors (Vendors)' });
      } else if (payable < 0) {
        // The owner owes US — the diesel we advanced outran the freight.
        lines.push({ ledger: `Vehicle Owner: ${s.owner_name ?? s.vehicle_no}`, dr_cr: 'DR',
                     amount: -payable, group: 'Sundry Creditors (Vendors)' });
      }
      narration = `${s.fleet_class === 'MARKET' ? 'Market' : 'Attached'} vehicle settlement — `
                + `${s.vehicle_no} (${s.owner_name ?? 'owner darj nahi'}), ${s.cycle_label}. `
                + `Freight ₹${freight.toFixed(2)}, commission ₹${comm.toFixed(2)}, `
                + `TDS ₹${tds.toFixed(2)}, recovery ₹${rec.toFixed(2)}, payable ₹${payable.toFixed(2)}.`;
    }

    // ── the manual adjustments, on any class of lorry ──────────────────────
    //
    // On an OWN lorry these are the ONLY thing that posts: its freight reaches
    // the books through customer billing and its diesel through the fortnightly
    // pump bill, so posting the P&L on top would book the same diesel twice.
    if (adjExpense > 0) {
      lines.push({ ledger: 'Direct Expenses - Vehicle Operations', dr_cr: 'DR',
                   amount: adjExpense, group: 'Direct Expenses - Vehicle Operations' });
    }
    if (adjIncome > 0) {
      lines.push({ ledger: 'Freight & Trip Income', dr_cr: 'CR',
                   amount: adjIncome, group: 'Direct Income' });
    }
    const diff = r2(adjExpense - adjIncome);
    if (diff > 0) {
      lines.push({ ledger: 'Vehicle Settlement Control', dr_cr: 'CR',
                   amount: diff, group: 'Current Liabilities' });
    } else if (diff < 0) {
      lines.push({ ledger: 'Vehicle Settlement Control', dr_cr: 'DR',
                   amount: -diff, group: 'Current Liabilities' });
    }
    if (!narration) {
      narration = `Vehicle settlement — ${s.vehicle_no}, ${s.cycle_label} `
                + '(manual adjustments only; freight and HSD post through their own flows)';
    }

    let voucher = null;
    if (lines.length) {
      try {
        voucher = await postVoucher({
          type: 'JOURNAL',
          source_type: 'VEHICLE_SETTLEMENT',
          // The company the lorry belongs to, so the entry lands in THAT firm's
          // trial balance — f_trial_balance_scoped already routes on it.
          company_id: s.company_id ?? null,
          // Deterministic: the same lorry and the same fortnight cannot post
          // twice, however many times Approve is clicked.
          ref_no: `VEHSETL_${s.vehicle_key}_${s.period_from instanceof Date
            ? s.period_from.toISOString().slice(0, 10) : s.period_from}`,
          entry_date: s.period_to,
          narration,
          lines,
        });
      } catch (e) {
        if (e.code === 'DUPLICATE_REF') {
          return reply.code(409).send({ error: 'ALREADY_POSTED', detail: e.message });
        }
        return reply.code(422).send({ error: e.code ?? 'POSTING_FAILED', detail: e.message });
      }
    }

    const { rows: [out] } = await query(`
      UPDATE vehicle_fortnight_settlements
         SET status = 'APPROVED', approved_by = $2, approved_at = now(),
             voucher_id = $3::uuid, locked_at = now(), locked_by = $2
       WHERE id = $1::uuid RETURNING id`, [id, actor(req), voucher?.voucher_id ?? null]);
    if (!out) return reply.code(404).send({ error: 'NOT_FOUND' });

    const { rows: [fresh] } = await query('SELECT * FROM v_vehicle_settlement WHERE id = $1::uuid', [id]);
    return {
      approved: true,
      settlement: fresh,
      voucher_id: voucher?.voucher_id ?? null,
      posted: {
        fleet_class: s.fleet_class,
        company: fresh?.company_name ?? null,
        commission: isAgency ? r2(num(s.commission_amount)) : null,
        tds: isAgency ? r2(num(s.tds_amount)) : null,
        payable_to_owner: isAgency ? r2(num(s.payable_to_owner)) : null,
        adjustment_income: adjIncome,
        adjustment_expense: adjExpense,
      },
      note: !voucher
        ? 'Koi manual adjustment nahi tha, isliye koi voucher nahi bana — settlement approve aur lock ho gaya.'
        : isAgency
          ? `${fresh?.company_name ?? 'company'} ki books me commission ₹${r2(num(s.commission_amount)).toFixed(2)} `
            + `income gaya. Owner ko ₹${r2(num(s.payable_to_owner)).toFixed(2)} dena hai, `
            + `TDS ₹${r2(num(s.tds_amount)).toFixed(2)} kaata gaya.`
          : `Ledger me sirf manual adjustment gaya (₹${(adjExpense - adjIncome).toFixed(2)} net). `
            + 'Freight aur HSD apne apne flow se jaate hain.',
    };
  });

  // ═══ REOPEN — admin only, and it moves no money ═════════════════════════
  app.post('/:id/reopen', admin, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const { rows } = await query(`
      UPDATE vehicle_fortnight_settlements
         SET locked_at = NULL, locked_by = NULL, status = 'STAFF_REVIEWED'
       WHERE id = $1::uuid AND locked_at IS NOT NULL
       RETURNING id, voucher_id`, [id]);
    if (!rows.length) return reply.code(409).send({ error: 'NOT_LOCKED' });
    return {
      reopened: true,
      // Append-only: the voucher stays posted. A correction is a SECOND
      // journal, never a rewrite of the first.
      note: rows[0].voucher_id
        ? 'Purana voucher waisa hi rehta hai — badlaav ke baad naya antar wala voucher banega.'
        : null,
    };
  });

  // ═══ THE STATEMENT AS TEXT, FOR WHATSAPP ════════════════════════════════
  app.get('/:id/summary-text', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const { rows } = await query('SELECT * FROM v_vehicle_settlement WHERE id = $1::uuid', [id]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    const s = rows[0];

    const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 });
    const NL = String.fromCharCode(10);
    const net = Number(s.gross_income) - Number(s.total_expense);
    const L = [
      `*${s.vehicle_no}* — ${s.cycle_label}`,
      `${s.period_from} se ${s.period_to}`,
      '',
      `Trip: ${s.trips_count}`,
      `Billed: ${inr(s.billed_amount)}`,
      Number(s.adj_income) ? `Anya aay: ${inr(s.adj_income)}` : null,
      `*Kul aay: ${inr(s.gross_income)}*`,
      '',
      `HSD: ${inr(s.hsd)}`,
      `Toll: ${inr(s.toll)}`,
      Number(s.tyre) ? `Tyre: ${inr(s.tyre)}` : null,
      Number(s.maintenance) ? `Maintenance: ${inr(s.maintenance)}` : null,
      Number(s.other_expense) ? `Anya: ${inr(s.other_expense)}` : null,
      Number(s.adj_expense) ? `Manual: ${inr(s.adj_expense)}` : null,
      `*Kul kharch: ${inr(s.total_expense)}*`,
      '',
      `*${net >= 0 ? 'Munafa' : 'Ghata'}: ${inr(Math.abs(net))}*`,
      '',
      s.status === 'APPROVED' ? `✅ Approved — ${s.approved_by}`
        : s.status === 'STAFF_REVIEWED' ? '📝 Staff ne dekh liya, approval baaki'
        : '🤖 AI draft — abhi kisi ne dekha nahi',
    ].filter((x) => x !== null);
    return { text: L.join(NL), settlement: s };
  });
}
