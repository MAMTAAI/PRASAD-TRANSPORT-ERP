// server/modules/dashboard.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/dashboard/v5 — everything the three Master Control v5.0 modules
// render, in ONE round trip.
//
// WHY ONE ENDPOINT. The v5.0 screens need ~15 different aggregates. Fetching
// those as 15 calls from the browser would be 15 round trips on every tab
// switch; here they are 15 cheap queries inside one connection, next to the
// data.
//
// EVERY SECTION IS INDEPENDENT. Each block is wrapped so that one failing
// aggregate degrades one card instead of blanking the whole dashboard — and
// the failure is REPORTED in `errors`, never silently swallowed into a zero. A
// zero that means "query failed" and a zero that means "no money" look
// identical on a screen, and only one of them is true.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';
import { tallyAlive } from '../lib/tallyAdapter.js';
import { requireAdminRole } from './auth.routes.js';
import * as otpChannel from '../lib/otpChannel.js';
import { periodBounds, previousOf, PERIODS } from '../lib/periods.js';
import { DIRECTORY_CTE } from '../lib/contactDirectory.js';
import { syncState } from '../lib/ioclSyncRunner.js';

const num = (v) => (v == null ? 0 : Number(v));

/** One compliance alert, flattened for the client. */
const mapAlert = (r) => ({
  kind: r.subject_kind, subject: r.subject, owner: r.owner_name,
  doc_type: r.doc_type, doc_name: r.doc_name,
  expires_on: r.expires_on, renewed_on: r.renewed_on, days: num(r.days), source: r.source,
});

/** Run one aggregate; on failure record it and hand back a fallback. */
async function safe(errors, label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return fallback;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse the 3-tier filter off the query string. Anything unrecognised becomes
 *  NULL rather than an error: a stale bookmark carrying a deleted company id
 *  should show the unfiltered dashboard, not a 400. */
function filtersOf(q) {
  const id = (v) => (UUID_RE.test(String(v ?? '')) ? String(v) : null);
  const fleet = String(q?.fleet ?? '').toUpperCase();
  return {
    companyId: id(q?.company_id),
    branchId: id(q?.branch_id),
    owner: String(q?.owner ?? '').trim() || null,
    fleet: fleet === 'OWNED' || fleet === 'ATTACHED' ? fleet : null,
  };
}

// Predicate over `trips t` JOIN `vehicles v`. Positional params are fixed at
// $1..$4 so every query in the handler can share one parameter array — mixing
// the order is how a "filter by owner" quietly becomes "filter by branch".
const TRIP_F = `
  AND ($1::uuid IS NULL OR t.company_id = $1::uuid)
  AND ($2::uuid IS NULL OR t.branch_id  = $2::uuid)
  AND ($3::text IS NULL OR v.owner_name = $3::text)
  AND ($4::text IS NULL OR (CASE WHEN v.is_company_owned THEN 'OWNED' ELSE 'ATTACHED' END) = $4::text)`;

// Same, for a bare `vehicles v` (fleet size). Company is handled by the caller
// via an EXISTS over trips, because a vehicle has no single company.
const VEHICLE_F = `
  AND ($3::text IS NULL OR v.owner_name = $3::text)
  AND ($4::text IS NULL OR (CASE WHEN v.is_company_owned THEN 'OWNED' ELSE 'ATTACHED' END) = $4::text)`;

export function registerDashboardRoutes(app) {
  // ── FINANCE HUB ───────────────────────────────────────────────────────────
  //
  // THIS SCREEN USED TO BE ENTIRELY INVENTED. It showed an Axis Bank loan of
  // 1.25 Cr, an SBI one of 85 lakh and an HDFC one of 42 lakh. The firm banks
  // with neither Axis nor HDFC: the 29 real loans are with TATA CAPITAL and
  // INDUSIND. A finance screen that is confidently wrong is worse than one that
  // is empty, because nobody goes and checks a number that is already there.
  //
  // Every figure below is read from loan_master, emi_payments and trips.
  app.get('/dashboard/finance-hub', async (req, reply) => {
    if (isDegraded()) {
      return reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
    }
    const period = PERIODS.includes(String(req.query?.period ?? '').toUpperCase())
      ? String(req.query.period).toUpperCase() : 'ALL';
    const bounds = periodBounds(period, req.query?.offset);
    const F = filtersOf(req.query);
    const P = [F.companyId, F.branchId, F.owner, F.fleet];

    // Lenders, with what is actually still owed. remaining_principal is the
    // figure the books carry; principal_paid_since is what EMIs have retired
    // since the opening balance. Where those disagree the loan has drifted and
    // the screen says so rather than picking the flattering one.
    const { rows: lenders } = await query(`
      SELECT l.bank_name,
             count(*)                                        AS loans,
             count(*) FILTER (WHERE l.payment_status = 'ACTIVE') AS active,
             COALESCE(sum(l.principal_amt), 0)               AS principal,
             COALESCE(sum(l.remaining_principal), 0)         AS outstanding,
             COALESCE(sum(l.emi_amount), 0)                  AS emi_monthly,
             COALESCE(sum(pay.paid), 0)                      AS principal_paid_since
        FROM loan_master l
        LEFT JOIN LATERAL (
          SELECT sum(e.principal_part) AS paid FROM emi_payments e WHERE e.loan_id = l.id
        ) pay ON true
       GROUP BY l.bank_name
       ORDER BY sum(l.remaining_principal) DESC NULLS LAST`);

    // Per-vehicle loans, so a truck can be seen carrying its own debt.
    const { rows: loans } = await query(`
      SELECT l.loan_account_no, l.vehicle_no, l.bank_name, l.loan_type,
             l.principal_amt, l.remaining_principal, l.emi_amount,
             l.rate_of_interest, l.tenure_months, l.emis_completed,
             l.payment_status,
             COALESCE(pay.n, 0) AS payments_recorded
        FROM loan_master l
        LEFT JOIN LATERAL (
          SELECT count(*) n FROM emi_payments e WHERE e.loan_id = l.id
        ) pay ON true
       ORDER BY l.remaining_principal DESC NULLS LAST`);

    // Where the money actually comes from. The old screen said "IOCL Refinery
    // 60%, Haldia Petrochem 25%, Others 15%" — round numbers nobody measured.
    // The real concentration is by consignee depot.
    const { rows: parties } = await query(`
      SELECT COALESCE(NULLIF(trim(t.consignee_name), ''), '(not recorded)') AS party,
             count(*) AS trips,
             COALESCE(sum(COALESCE(NULLIF(t.billed_amount,0), t.freight_amount, 0)), 0) AS freight
        FROM trips t
        LEFT JOIN vehicles v ON v.id = t.vehicle_id
       WHERE ($5::date IS NULL OR t.loading_date >= $5::date)
         AND ($6::date IS NULL OR t.loading_date <= $6::date)
         ${TRIP_F}
       GROUP BY 1 ORDER BY 3 DESC NULLS LAST LIMIT 8`, [...P, bounds.from, bounds.to]);

    // Revenue by month. Bounded to sane dates: one trip carries a year of
    // "0026", a typo that would otherwise stretch the axis across two millennia.
    const { rows: monthly } = await query(`
      SELECT to_char(t.loading_date,'YYYY-MM') AS month,
             count(*) AS trips,
             COALESCE(sum(COALESCE(NULLIF(t.billed_amount,0), t.freight_amount, 0)), 0) AS revenue
        FROM trips t
        LEFT JOIN vehicles v ON v.id = t.vehicle_id
       WHERE t.loading_date BETWEEN '2000-01-01' AND '2100-01-01' ${TRIP_F}
       GROUP BY 1 ORDER BY 1 DESC LIMIT 13`, P);

    // Real bank and cash balances, straight off the ledger view.
    const { rows: accounts } = await query(`
      SELECT b.ledger_name, b.group_head, b.balance_natural AS balance,
             b.total_dr, b.total_cr
        FROM v_ledger_balances b
       WHERE b.group_head ILIKE '%Bank%' OR b.group_head ILIKE '%Cash%'
       ORDER BY abs(b.balance_natural::numeric) DESC NULLS LAST LIMIT 10`);

    // HOW STALE IS THE OUTSTANDING FIGURE?
    //
    // remaining_principal is a stored balance, set from the opening position on
    // 31-03-2026 and never decremented since. Every EMI recorded in
    // emi_payments has retired principal that this number does not know about.
    // The screen keeps showing the stored figure — it is what the books say —
    // but it must not present it as today's debt without saying so.
    const { rows: driftRows } = await query(`
      SELECT count(*) FILTER (WHERE abs(drift::numeric) > 1) AS stale_loans,
             COALESCE(sum(drift::numeric), 0)                AS total_drift,
             max(opening_as_of)                              AS as_of
        FROM v_loan_reconciliation`);
    const drift = driftRows[0] ?? {};

    const n = (v) => Number(v || 0);
    const outstanding = lenders.reduce((a, l) => a + n(l.outstanding), 0);
    const emiMonthly = lenders.reduce((a, l) => a + n(l.emi_monthly), 0);
    const freightTotal = parties.reduce((a, p) => a + n(p.freight), 0);

    return {
      period: bounds,
      debt: {
        lenders: lenders.map((l) => ({
          ...l,
          share_pct: outstanding > 0 ? Math.round((n(l.outstanding) / outstanding) * 100) : 0,
          repaid_pct: n(l.principal) > 0
            ? Math.round(((n(l.principal) - n(l.outstanding)) / n(l.principal)) * 100) : null,
        })),
        loans,
        totals: {
          loans: loans.length,
          principal: lenders.reduce((a, l) => a + n(l.principal), 0).toFixed(2),
          outstanding: outstanding.toFixed(2),
          emi_monthly: emiMonthly.toFixed(2),
        },
        // Non-null means the outstanding above is an opening balance carrying
        // unposted repayments, and the real debt is lower by roughly this much.
        staleness: n(drift.total_drift) > 1 ? {
          stale_loans: Number(drift.stale_loans),
          unposted_repayment: n(drift.total_drift).toFixed(2),
          as_of: drift.as_of,
        } : null,
      },
      // Concentration risk: if one depot is most of the freight, losing it is
      // the whole business, and that is worth seeing next to the debt.
      revenue: {
        parties: parties.map((p) => ({
          ...p,
          share_pct: freightTotal > 0 ? Math.round((n(p.freight) / freightTotal) * 100) : 0,
        })),
        total: freightTotal.toFixed(2),
        monthly: monthly.reverse(),
      },
      accounts,
    };
  });

  // ── DRIVER SHORTAGE RECOVERY, BY PERIOD ───────────────────────────────────
  //
  // PENDING IS CHARGED MINUS RECOVERED, never "has a penalty". Every recovery is
  // a driver_transactions row of type SHORTAGE_RECOVERY carrying the trip_id, so
  // what is still owed is arithmetic on two real tables rather than a flag
  // somebody has to remember to clear. That is also what makes it auto-update:
  // the moment a recovery row lands, the pending figure drops on the next read.
  //
  // TRIP-WISE IS THE UNIT THAT CAN BE ACTED ON. "Prakash Prasad owes 15,767" is
  // a number to argue about; "trip PT00653 on 8 July, 0.412 KL short on AS 26C
  // 5107" is a conversation with a driver. Both are returned.
  app.get('/dashboard/shortage-recovery', async (req, reply) => {
    if (isDegraded()) {
      return reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
    }
    const period = PERIODS.includes(String(req.query?.period ?? '').toUpperCase())
      ? String(req.query.period).toUpperCase() : 'ALL';
    const bounds = periodBounds(period, req.query?.offset);
    const F = filtersOf(req.query);
    const P = [F.companyId, F.branchId, F.owner, F.fleet];

    // One CTE, read three ways: per trip, per driver, and as a total. Deriving
    // the three separately is how a summary ends up disagreeing with the rows
    // underneath it.
    const { rows: trips } = await query(`
      SELECT t.id, t.trip_code, t.loading_date, t.vehicle_no,
             COALESCE(t.driver_name, 'driver not recorded') AS driver_name,
             t.loading_point, COALESCE(t.unloading_location, t.consignee_name) AS destination,
             COALESCE(t.shortage_qty, 0)             AS qty,
             COALESCE(t.shortage_penalty, 0)         AS penalty,
             COALESCE(rec.recovered, 0)              AS recovered,
             COALESCE(t.shortage_penalty,0) - COALESCE(rec.recovered,0) AS pending,
             rec.last_at                             AS last_recovery_at
        FROM trips t
        LEFT JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN LATERAL (
          SELECT sum(d.amount) AS recovered, max(d.txn_date) AS last_at
            FROM driver_transactions d
           WHERE d.trip_id = t.id AND d.txn_type = 'SHORTAGE_RECOVERY'
        ) rec ON true
       WHERE COALESCE(t.shortage_penalty, 0) > 0
         AND ($5::date IS NULL OR t.loading_date >= $5::date)
         AND ($6::date IS NULL OR t.loading_date <= $6::date)
         ${TRIP_F}
       ORDER BY (COALESCE(t.shortage_penalty,0) - COALESCE(rec.recovered,0)) DESC,
                COALESCE(t.shortage_penalty,0) DESC`, [...P, bounds.from, bounds.to]);

    // Group in JS off the SAME rows the client sees, so the driver totals and
    // the trip list can never disagree.
    const byKey = new Map();
    for (const t of trips) {
      const key = `${t.driver_name}||${t.vehicle_no}`;
      const g = byKey.get(key) ?? {
        driver: t.driver_name, vehicle: t.vehicle_no, trips: 0,
        qty: 0, penalty: 0, recovered: 0, pending: 0, trip_codes: [], last_recovery_at: null,
      };
      g.trips += 1;
      g.qty += Number(t.qty);
      g.penalty += Number(t.penalty);
      g.recovered += Number(t.recovered);
      g.pending += Number(t.pending);
      if (t.trip_code) g.trip_codes.push(t.trip_code);
      if (t.last_recovery_at && (!g.last_recovery_at || t.last_recovery_at > g.last_recovery_at)) {
        g.last_recovery_at = t.last_recovery_at;
      }
      byKey.set(key, g);
    }
    const drivers = [...byKey.values()]
      .map((g) => ({
        ...g,
        qty: g.qty.toFixed(3),
        penalty: g.penalty.toFixed(2),
        recovered: g.recovered.toFixed(2),
        pending: g.pending.toFixed(2),
        settled: g.pending <= 0.005,
      }))
      .sort((a, b) => Number(b.pending) - Number(a.pending) || Number(b.penalty) - Number(a.penalty));

    const sum = (f) => trips.reduce((a, t) => a + Number(t[f] || 0), 0);
    const charged = sum('penalty');
    const recovered = sum('recovered');

    // What actually came back, and when — this is the feed that answers
    // "has anyone paid since I last looked".
    const { rows: recent } = await query(`
      SELECT d.driver_name, d.amount, d.txn_date, d.mode, d.remarks,
             t.trip_code, t.vehicle_no
        FROM driver_transactions d
        LEFT JOIN trips t ON t.id = d.trip_id
       WHERE d.txn_type = 'SHORTAGE_RECOVERY'
       ORDER BY d.txn_date DESC NULLS LAST, d.created_at DESC
       LIMIT 12`);

    // Fortnight-by-fortnight trend, for the graph. Charged against recovered:
    // a period where the two diverge is one where money stopped coming back.
    const { rows: trend } = await query(`
      SELECT to_char(t.loading_date,'YYYY-MM') AS mon,
             CASE WHEN extract(day FROM t.loading_date) <= 15 THEN 'H1' ELSE 'H2' END AS half,
             min(t.loading_date) AS from_date,
             COALESCE(sum(t.shortage_penalty),0)      AS charged,
             COALESCE(sum(rec.recovered),0)           AS recovered
        FROM trips t
        LEFT JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN LATERAL (
          SELECT sum(d.amount) AS recovered FROM driver_transactions d
           WHERE d.trip_id = t.id AND d.txn_type = 'SHORTAGE_RECOVERY') rec ON true
       WHERE COALESCE(t.shortage_penalty,0) > 0 ${TRIP_F}
       GROUP BY 1,2 ORDER BY min(t.loading_date) DESC LIMIT 8`, P);

    return {
      period: bounds,
      totals: {
        trips: trips.length,
        drivers: new Set(trips.map((t) => t.driver_name)).size,
        charged: charged.toFixed(2),
        recovered: recovered.toFixed(2),
        pending: (charged - recovered).toFixed(2),
        // The single number that says whether recovery is working at all.
        recovery_pct: charged > 0 ? Math.round((recovered / charged) * 100) : null,
        qty: sum('qty').toFixed(3),
      },
      drivers,
      pending: drivers.filter((d) => !d.settled),
      settled: drivers.filter((d) => d.settled),
      trips: trips.map((t) => ({
        trip_id: t.id, trip_code: t.trip_code, date: t.loading_date,
        vehicle: t.vehicle_no, driver: t.driver_name,
        route: `${t.loading_point ?? '?'} -> ${t.destination ?? '?'}`,
        qty: t.qty, penalty: t.penalty, recovered: t.recovered, pending: t.pending,
        settled: Number(t.pending) <= 0.005,
        last_recovery_at: t.last_recovery_at,
      })),
      recent_recoveries: recent,
      trend: trend.reverse().map((r) => ({
        label: `${r.mon} ${r.half}`,
        charged: r.charged, recovered: r.recovered,
      })),
    };
  });

  // ── VEHICLE PRODUCTIVITY, BY PERIOD ───────────────────────────────────────
  //
  // A SEPARATE ENDPOINT FROM /dashboard/v5 ON PURPOSE. This panel refreshes on
  // its own and the operator flips between fortnights while looking at it;
  // driving that from the full dashboard payload would re-run the compliance
  // sweep, the owner matrix and the ledger roll-up every time somebody clicked
  // "previous fortnight".
  //
  // BOTH FIGURES COME FROM THE SAME ROWS. RTKM and freight are summed in one
  // pass over the same trips, so a vehicle can never show distance from one
  // window and money from another. Freight is billed_amount via the same
  // COALESCE the owner matrix uses — 489 trips carry it against 21 with
  // freight_amount, and using the other column would put a second, smaller
  // revenue figure on the same screen.
  app.get('/dashboard/vehicle-productivity', async (req, reply) => {
    if (isDegraded()) {
      return reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
    }
    const period = PERIODS.includes(String(req.query?.period ?? '').toUpperCase())
      ? String(req.query.period).toUpperCase() : 'FORTNIGHT';
    const bounds = periodBounds(period, req.query?.offset);
    const prev = previousOf(bounds);

    const F = filtersOf(req.query);
    const P = [F.companyId, F.branchId, F.owner, F.fleet];

    // Trips are dated by loading_date: that is when the kilometres were run.
    // Dating by unloading would move a trip that crossed a fortnight boundary
    // into the wrong invoice period.
    // EVERY join to `vehicles` in this file is a LEFT join, deliberately.
    //
    // They were INNER joins. The join exists so the owner/fleet filter can reach
    // the vehicles table -- it was never meant to decide whether a trip counts.
    // But 27 trips carried vehicle_id NULL (the AC5 importer wrote vehicle_no and
    // never resolved the id), and an INNER join silently dropped every one of
    // them: 15 August trips with 9,069 km disappeared from the Month and
    // Fortnight tabs while the Year tab still showed a total, so the widget
    // looked alive and read zero for the current month.
    //
    // A dashboard that omits rows is worse than one that errors, because nobody
    // goes looking for a number that is merely smaller than it should be.
    const rowsFor = async (b) => {
      if (!b) return [];
      const { rows } = await query(`
        SELECT t.vehicle_no,
               count(*)::int                                  AS trips,
               round(sum(t.rtkm), 1)                          AS rtkm,
               COALESCE(sum(COALESCE(NULLIF(t.billed_amount,0), t.freight_amount, 0)), 0) AS freight,
               COALESCE(sum(t.shortage_penalty), 0)           AS shortage,
               COALESCE(sum(t.loaded_qty), 0)                 AS qty,
               count(*) FILTER (WHERE COALESCE(NULLIF(t.billed_amount,0), t.freight_amount, 0) = 0)::int
                                                              AS unbilled_trips
          FROM trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
         WHERE t.vehicle_no IS NOT NULL AND t.rtkm > 0
           AND ($5::date IS NULL OR t.loading_date >= $5::date)
           AND ($6::date IS NULL OR t.loading_date <= $6::date)
           ${TRIP_F}
         GROUP BY t.vehicle_no
         ORDER BY sum(t.rtkm) DESC`, [...P, b.from, b.to]);
      return rows;
    };

    const [cur, before] = await Promise.all([rowsFor(bounds), rowsFor(prev)]);

    const prevByVehicle = Object.fromEntries(before.map((r) => [r.vehicle_no, r]));
    const all = cur.map((r) => {
      const was = prevByVehicle[r.vehicle_no];
      return {
        vehicle: r.vehicle_no,
        trips: num(r.trips),
        rtkm: r.rtkm,
        freight: r.freight,
        shortage: r.shortage,
        qty: r.qty,
        unbilled_trips: num(r.unbilled_trips),
        // Rupees earned per kilometre run — the number that says whether a long
        // truck is a productive truck or just a tired one.
        per_km: Number(r.rtkm) > 0
          ? (Number(r.freight) / Number(r.rtkm)).toFixed(2) : null,
        prev_rtkm: was ? was.rtkm : null,
        // Percent change vs the SAME period one step back, which is the only
        // comparison that means anything on a fortnightly cycle.
        rtkm_delta_pct: was && Number(was.rtkm) > 0
          ? Math.round(((Number(r.rtkm) - Number(was.rtkm)) / Number(was.rtkm)) * 100)
          : null,
      };
    });

    const sum = (k) => all.reduce((a, r) => a + Number(r[k] || 0), 0);
    return {
      period: bounds,
      previous: prev ? { label: prev.label, from: prev.from, to: prev.to } : null,
      vehicles: all.length,
      // Fewer than ten ranked vehicles means top-5 and bottom-5 share rows.
      overlap: all.length > 0 && all.length < 10,
      totals: {
        trips: sum('trips'),
        rtkm: +sum('rtkm').toFixed(1),
        freight: sum('freight').toFixed(2),
        shortage: sum('shortage').toFixed(2),
        per_km: sum('rtkm') > 0 ? (sum('freight') / sum('rtkm')).toFixed(2) : null,
        prev_rtkm: before.reduce((a, r) => a + Number(r.rtkm || 0), 0).toFixed(1),
      },
      top: all.slice(0, 5),
      bottom: all.slice(-5).reverse(),
      all,
    };
  });

  // ── /v5 MICRO-CACHE ───────────────────────────────────────────────────────
  // The handler below runs ~55 aggregate queries in sequence, and every open
  // Master Control tab polls it every 8 seconds. On the 2GB box the P&L
  // aggregation alone takes 1–9s under load, so two viewers were enough to
  // push a poll past the SPA's 20s abort — which the screens render as "Live
  // data unavailable — API not reachable" over numbers that were fine.
  //
  // Six seconds is just under the poll cadence: each filter combination is
  // computed once per cycle no matter how many screens are watching, and
  // nobody ever reads a figure more than one poll stale. Keyed on the APPLIED
  // filters (filtersOf), so a company-scoped view never serves the group's
  // numbers. Same-payload-for-all is safe here: the route is staff-only via
  // the global guard, and it already serves identical data to every staff.
  const V5_TTL_MS = Number(process.env.DASHBOARD_V5_CACHE_MS || 6000);
  const v5Cache = new Map();

  app.get('/dashboard/v5', async (req, reply) => {
    if (isDegraded()) {
      return reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
    }
    const errors = [];
    const t0 = Date.now();

    const cacheKey = JSON.stringify(filtersOf(req.query));
    const hit = v5Cache.get(cacheKey);
    if (hit && t0 - hit.at < V5_TTL_MS) return hit.payload;

    // ── THE 3-TIER FILTER ───────────────────────────────────────────────────
    // Company -> Branch -> Fleet/Owner. Every value is optional and NULL means
    // "all", so one parameter list serves the unfiltered dashboard and every
    // narrowing of it without a second set of queries.
    //
    // A VEHICLE IS NOT FILTERED BY vehicles.company_id. That column exists but
    // is NULL on all 49 rows, and more importantly a truck genuinely works for
    // several firms — 15 of them do. So "fleet under Prasad Transport" means
    // vehicles that actually RAN a trip for Prasad Transport, which is the only
    // definition the data supports.
    const F = filtersOf(req.query);
    const P = [F.companyId, F.branchId, F.owner, F.fleet];

    // ── OPERATIONS ──────────────────────────────────────────────────────────
    const fleet = await safe(errors, 'fleet_counts', async () => {
      const { rows } = await query(`
        SELECT
          (SELECT count(*) FROM vehicles v
            WHERE v.status = 'ACTIVE' ${VEHICLE_F}
              AND ($1::uuid IS NULL OR EXISTS (
                    SELECT 1 FROM trips t WHERE t.vehicle_id = v.id AND t.company_id = $1::uuid)))
                                                                                     AS fleet_size,
          (SELECT count(*) FROM trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.status = 'IN_TRANSIT' ${TRIP_F})                                 AS active_trips,
          (SELECT count(*) FROM trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.status = 'IN_TRANSIT' AND t.unloading_date IS NULL ${TRIP_F})     AS pending_unloading,
          (SELECT count(*) FROM drivers WHERE status = 'ACTIVE')                     AS drivers_active`, P);
      return {
        fleet_size: num(rows[0].fleet_size),
        active_trips: num(rows[0].active_trips),
        pending_unloading: num(rows[0].pending_unloading),
        drivers_active: num(rows[0].drivers_active),
      };
    }, { fleet_size: 0, active_trips: 0, pending_unloading: 0, drivers_active: 0 });

    // Compliance vault: soonest expiry per document type across the fleet.
    const doc_vault = await safe(errors, 'doc_vault', async () => {
      const { rows } = await query(`
        WITH d AS (
          SELECT 'INSURANCE'       AS doc, min(insurance_expiry)        AS soonest FROM vehicles WHERE status='ACTIVE' AND insurance_expiry IS NOT NULL
          UNION ALL SELECT 'FITNESS',       min(fitness_expiry)         FROM vehicles WHERE status='ACTIVE' AND fitness_expiry IS NOT NULL
          UNION ALL SELECT 'PERMIT',        min(permit_expiry)          FROM vehicles WHERE status='ACTIVE' AND permit_expiry IS NOT NULL
          UNION ALL SELECT 'PUC',           min(puc_expiry)             FROM vehicles WHERE status='ACTIVE' AND puc_expiry IS NOT NULL
          UNION ALL SELECT 'ROAD TAX',      min(tax_expiry)             FROM vehicles WHERE status='ACTIVE' AND tax_expiry IS NOT NULL
          UNION ALL SELECT 'NAT. PERMIT',   min(national_permit_expiry) FROM vehicles WHERE status='ACTIVE' AND national_permit_expiry IS NOT NULL
        )
        SELECT doc, soonest, (soonest - CURRENT_DATE) AS days
        FROM d WHERE soonest IS NOT NULL ORDER BY soonest ASC`);
      return rows.map((r) => ({ doc: r.doc, expiry: r.soonest, days: num(r.days) }));
    }, []);

    // ── Fleet Document Vault — the two panels merged, per LORRY ──────────────
    // doc_vault answers "which KIND of paper expires soonest" and compliance_alerts
    // answers "whose paper expires next", and they were drawn as two panels stacked
    // on each other. Neither could be acted on alone: the first never names a
    // vehicle, the second names one but says nothing about the rest of its file.
    // This is one row per lorry — what is expired, what is due, what has no file —
    // so the answer and the thing you act on are the same object.
    //
    // AND IT CARRIES THE FEE, which is the part nothing on this dashboard showed.
    // vehicle_documents.amount is filled for 79 rows totalling ₹11,11,030 and every
    // one has voucher_id NULL: the 2026-08 Firestore import wrote the table
    // directly and so bypassed POST /vehicle-documents, which is what queues the
    // expense_approvals row. That money has never reached the cashbook or the P&L.
    // Reported here, never posted from here — ₹11 lakh of historical expense is an
    // owner's decision and the approval queue is where it belongs.
    const fleet_vault = await safe(errors, 'fleet_vault', async () => {
      const { rows } = await query(`
        SELECT v.id, v.vehicle_no,
               count(*) FILTER (WHERE c.compliance_state = 'EXPIRED')::int  AS expired,
               count(*) FILTER (WHERE c.compliance_state = 'EXPIRING')::int AS expiring,
               count(*) FILTER (WHERE c.document_url IS NULL)::int          AS no_file,
               count(*)::int                                               AS docs,
               min(c.next_due_date) FILTER (
                 WHERE c.compliance_state IN ('EXPIRED','EXPIRING'))        AS soonest,
               count(*) FILTER (WHERE c.amount > 0 AND c.voucher_id IS NULL)::int AS unposted_fees,
               COALESCE(sum(c.amount) FILTER (
                 WHERE c.amount > 0 AND c.voucher_id IS NULL), 0)::numeric  AS unposted_rs
          FROM vehicles v
          LEFT JOIN v_vehicle_compliance c ON c.vehicle_id = v.id
         WHERE v.status = 'ACTIVE'
         GROUP BY v.id, v.vehicle_no`);

      const mapped = rows.map((r) => ({
        id: r.id, vehicle_no: r.vehicle_no,
        expired: num(r.expired), expiring: num(r.expiring),
        no_file: num(r.no_file), docs: num(r.docs),
        soonest: r.soonest,
        soonest_days: r.soonest ? Math.round((new Date(r.soonest) - new Date(new Date().toDateString())) / 86400000) : null,
        unposted_fees: num(r.unposted_fees), unposted_rs: Number(r.unposted_rs ?? 0),
      }));

      // Expired first and most-overdue within that, because an expired paper is a
      // lorry that must not roll today; everything else is scheduling.
      mapped.sort((a, b) => {
        if (!!a.expired !== !!b.expired) return b.expired - a.expired;
        if (a.expired && b.expired) return (a.soonest_days ?? 0) - (b.soonest_days ?? 0);
        if (!!a.expiring !== !!b.expiring) return b.expiring - a.expiring;
        return (a.soonest_days ?? 99999) - (b.soonest_days ?? 99999);
      });

      return {
        rows: mapped.slice(0, 12),
        total_vehicles: mapped.length,
        with_expired: mapped.filter((v) => v.expired > 0).length,
        with_expiring: mapped.filter((v) => v.expiring > 0).length,
        no_docs: mapped.filter((v) => v.docs === 0).length,
        unposted_fees: mapped.reduce((n, v) => n + v.unposted_fees, 0),
        unposted_rs: mapped.reduce((n, v) => n + v.unposted_rs, 0),
      };
    }, { rows: [], total_vehicles: 0, with_expired: 0, with_expiring: 0, no_docs: 0, unposted_fees: 0, unposted_rs: 0 });

    // ── Fee approval queue ───────────────────────────────────────────────────
    // 75 of these carry a real scanned document and ₹10,66,381 between them, and
    // not one has ever reached the cashbook: the 2026-08 Firestore import wrote
    // vehicle_documents directly and so skipped POST /vehicle-documents, which is
    // the call that queues the expense. They were only visible as a chip on the
    // vault until now, which is a fine way to be reminded and no way to act.
    //
    // Ordered by amount because that is the order somebody clearing a backlog
    // wants: the ₹55,810 insurance matters more than a ₹120 PUC receipt.
    const pending_fees = await safe(errors, 'pending_fees', async () => {
      const { rows } = await query(`
        SELECT d.id, d.vehicle_id, v.vehicle_no,
               d.doc_type, COALESCE(d.doc_name, d.doc_type) AS doc_name,
               d.amount, d.receipt_no, d.application_no,
               d.inspected_on, d.next_due_date,
               (d.document_url IS NOT NULL) AS has_file,
               v.is_company_owned
          FROM vehicle_documents d
          JOIN vehicles v ON v.id = d.vehicle_id
         WHERE d.amount > 0 AND d.voucher_id IS NULL AND v.status = 'ACTIVE'
         ORDER BY d.amount DESC
         LIMIT 200`);
      return {
        rows: rows.map((r) => ({
          id: r.id, vehicle_id: r.vehicle_id, vehicle_no: r.vehicle_no,
          doc_type: r.doc_type, doc_name: r.doc_name,
          amount: Number(r.amount), receipt_no: r.receipt_no, application_no: r.application_no,
          inspected_on: r.inspected_on, next_due_date: r.next_due_date,
          has_file: !!r.has_file, is_company_owned: !!r.is_company_owned,
        })),
        count: rows.length,
        total_rs: rows.reduce((n, r) => n + Number(r.amount || 0), 0),
        with_file: rows.filter((r) => r.has_file).length,
      };
    }, { rows: [], count: 0, total_rs: 0, with_file: 0 });

    // ── Document history ─────────────────────────────────────────────────────
    // "Kab kya renew hua" had no answer anywhere on this dashboard. Every panel
    // showed the CURRENT state, so a document renewed this morning and one
    // untouched since the import looked identical, and there was no way to see
    // whether the office is keeping up or the pile is simply growing.
    //
    // updated_at, not created_at: the row is upserted on (vehicle_id, doc_type),
    // so renewing a fitness certificate updates the same row it has always had.
    // created_at would date every one of them to the August import and show a
    // year of renewals as a single day's work.
    const doc_history = await safe(errors, 'doc_history', async () => {
      const { rows } = await query(`
        SELECT v.vehicle_no AS subject, COALESCE(d.doc_name, d.doc_type) AS doc_name,
               d.updated_at, d.next_due_date, d.amount,
               (d.document_url IS NOT NULL) AS has_file,
               (d.voucher_id IS NOT NULL)   AS fee_posted
          FROM vehicle_documents d
          JOIN vehicles v ON v.id = d.vehicle_id
         WHERE v.status = 'ACTIVE'
         ORDER BY d.updated_at DESC
         LIMIT 40`);
      return rows.map((r) => ({
        subject: r.subject, doc_name: r.doc_name,
        at: r.updated_at, next_due_date: r.next_due_date,
        amount: r.amount == null ? null : Number(r.amount),
        has_file: !!r.has_file, fee_posted: !!r.fee_posted,
      }));
    }, []);

    // THE 10-DAY RED ALERT. doc_vault above shows the soonest expiry per document
    // TYPE across the fleet — useful as a summary, useless for acting, because it
    // never names the lorry. This names every vehicle AND driver whose paper
    // expires inside the operator's own 10-day window (compliance_alert_days(),
    // migration 058), so the two screens cannot disagree about what "expiring"
    // means. Already-expired items sort first: they are not a warning, they are
    // a truck that should not be on the road.
    const compliance_alerts = await safe(errors, 'compliance_alerts', async () => {
      const { rows } = await query(`
        SELECT subject_kind, subject, owner_name, doc_type,
               COALESCE(doc_name, doc_type) AS doc_name,
               expires_on, renewed_on, (expires_on - CURRENT_DATE)::int AS days, source
          FROM v_compliance_alerts
         WHERE expires_on - CURRENT_DATE <= compliance_alert_days()
         ORDER BY expires_on ASC
         LIMIT 60`);
      // Proof the background sweep is alive. An empty list means "nothing
      // expires soon" AND "the job died three weeks ago" — this tells them apart.
      const { rows: run } = await query(`
        SELECT ran_on, threshold_days, checked, expired, expiring
          FROM compliance_alert_runs ORDER BY ran_on DESC LIMIT 1`);
      // COUNTED IN SQL, NOT FROM THE ARRAY ABOVE. That array is LIMIT 60, so
      // once the window holds more than sixty papers every headline built from
      // `.length` would quietly stop rising — the one failure a compliance
      // count must never have. 46 today, which is close enough to matter.
      //
      // And split by kind, because a lorry panel counting drivers is how the
      // Fleet vault came to show 40 expired when 33 of them were vehicles: the
      // number was true of the feed and wrong about the panel it sat on.
      const { rows: cnt } = await query(`
        SELECT subject_kind,
               count(*) FILTER (WHERE expires_on <  CURRENT_DATE)::int AS expired,
               count(*) FILTER (WHERE expires_on >= CURRENT_DATE)::int AS expiring
          FROM v_compliance_alerts
         WHERE expires_on - CURRENT_DATE <= compliance_alert_days()
         GROUP BY subject_kind`);
      const bucket = (k) => cnt.find((c) => c.subject_kind === k) ?? { expired: 0, expiring: 0 };
      const veh = bucket('VEHICLE');
      const drv = bucket('DRIVER');

      return {
        threshold_days: 10,
        expired: rows.filter((r) => r.days < 0).map(mapAlert),
        expiring: rows.filter((r) => r.days >= 0).map(mapAlert),
        counts: {
          vehicle_expired: num(veh.expired), vehicle_expiring: num(veh.expiring),
          driver_expired: num(drv.expired), driver_expiring: num(drv.expiring),
          listed: rows.length,
          total: num(veh.expired) + num(veh.expiring) + num(drv.expired) + num(drv.expiring),
        },
        last_sweep: run[0] ?? null,
      };
    }, { threshold_days: 10, expired: [], expiring: [], last_sweep: null });

    // ── Driver Command Center ────────────────────────────────────────────────
    // THE OLD FILTER HID EXACTLY THE DRIVERS THIS PANEL EXISTS TO CATCH. It read
    //   WHERE license_expiry IS NOT NULL OR hzd_expiry IS NOT NULL
    // so a driver whose expiry dates were never recorded — 22 of 54 on
    // 2026-09-01 — could not appear at all, and neither could the 25 with no DL
    // scan. The panel showed six drivers whose paperwork was complete enough to
    // have a date on it, while the ones with nothing on file stayed invisible.
    // A compliance panel that can only see the drivers who are already halfway
    // compliant is worse than no panel, because it reads as "all clear".
    //
    // So every ACTIVE driver is scored, missing DOCUMENTS count alongside
    // expiring ones, and `id` travels so the row can open that driver.
    const drivers = await safe(errors, 'drivers', async () => {
      const { rows } = await query(`
        SELECT id, name, mobile, license_expiry, hzd_expiry,
               (license_expiry - CURRENT_DATE) AS dl_days,
               (hzd_expiry     - CURRENT_DATE) AS hzd_days,
               (profile_pic_url  IS NULL) AS no_photo,
               (dl_photo_url     IS NULL) AS no_dl,
               (aadhar_photo_url IS NULL) AS no_aadhaar,
               (pan_photo_url    IS NULL) AS no_pan,
               (bank_photo_url   IS NULL) AS no_bank,
               (hzd_photo_url    IS NULL) AS no_hzd
        FROM drivers
        WHERE status = 'ACTIVE'`);

      const mapped = rows.map((r) => {
        const missing = [];
        if (r.no_photo) missing.push('Photo');
        if (r.no_dl) missing.push('DL');
        if (r.no_aadhaar) missing.push('Aadhaar');
        if (r.no_pan) missing.push('PAN');
        if (r.no_bank) missing.push('Bank');
        if (r.no_hzd) missing.push('HZD');
        if (r.license_expiry == null) missing.push('DL-expiry');
        const dl_days = r.dl_days == null ? null : num(r.dl_days);
        const hzd_days = r.hzd_days == null ? null : num(r.hzd_days);
        return { id: r.id, name: r.name, mobile: r.mobile, dl_days, hzd_days, missing };
      });

      // Worst first, and "expired" outranks "many documents missing": an expired
      // licence is a truck that must not roll today, while a missing passbook is
      // paperwork. Sorted here rather than in SQL because the rank mixes three
      // things and 54 rows cost nothing to sort in memory.
      const expiredDays = (d) => Math.min(
        d.dl_days == null ? Infinity : d.dl_days,
        d.hzd_days == null ? Infinity : d.hzd_days);
      mapped.sort((a, b) => {
        const ax = expiredDays(a); const bx = expiredDays(b);
        const aExp = ax < 0 ? 0 : 1; const bExp = bx < 0 ? 0 : 1;
        if (aExp !== bExp) return aExp - bExp;          // expired first
        if (aExp === 0) return ax - bx;                 // most overdue first
        if (a.missing.length !== b.missing.length) return b.missing.length - a.missing.length;
        return ax - bx;                                 // then soonest to expire
      });

      return {
        rows: mapped.slice(0, 12),
        total_active: mapped.length,
        with_gaps: mapped.filter((d) => d.missing.length > 0).length,
        expired: mapped.filter((d) => expiredDays(d) < 0).length,
      };
    }, { rows: [], total_active: 0, with_gaps: 0, expired: 0 });

    const trips_by_day = await safe(errors, 'trips_by_day', async () => {
      const { rows } = await query(`
        SELECT to_char(d.day,'Dy') AS label, COALESCE(t.n,0) AS trips
        FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, '1 day') AS d(day)
        LEFT JOIN (SELECT t.loading_date::date AS day, count(*) AS n
                     FROM trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
                    WHERE t.loading_date >= CURRENT_DATE - 6 ${TRIP_F}
                    GROUP BY 1) t ON t.day = d.day
        ORDER BY d.day`, P);
      return rows.map((r) => ({ day: String(r.label).trim(), trips: num(r.trips) }));
    }, []);

    const live_fleet = await safe(errors, 'live_fleet', async () => {
      const { rows } = await query(`
        SELECT t.vehicle_no, t.loading_point, t.unloading_location, t.status, t.product_type,
               t.driver_name, t.loading_date, t.unloading_date
        FROM trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
        WHERE t.status = 'IN_TRANSIT' ${TRIP_F}
        ORDER BY t.loading_date DESC NULLS LAST
        LIMIT 8`, P);
      return rows.map((r) => ({
        vehicle: r.vehicle_no || '-',
        route: `${r.loading_point || '?'} -> ${r.unloading_location || '?'}`,
        status: r.unloading_date ? 'Unloading' : 'En Route',
        product: r.product_type || '',
        driver: r.driver_name || '',
      }));
    }, []);

    // The queue behind the "pending unloading" number. A count tells you there
    // is a problem; the list tells you which trucks, which is what dispatch
    // actually acts on.
    const unloading_queue = await safe(errors, 'unloading_queue', async () => {
      const { rows } = await query(`
        SELECT t.trip_code, t.vehicle_no, t.driver_name, t.product_type,
               t.loading_date, t.loading_point,
               COALESCE(t.unloading_location, t.consignee_name) AS destination,
               t.loaded_qty,
               CASE WHEN t.loading_date > DATE '2000-01-01'
                    THEN (CURRENT_DATE - t.loading_date)::int END AS days_out
          FROM trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
         WHERE t.status = 'IN_TRANSIT' AND t.unloading_date IS NULL ${TRIP_F}
         ORDER BY t.loading_date ASC NULLS LAST
         LIMIT 25`, P);
      return rows.map((r) => ({
        trip_code: r.trip_code, vehicle: r.vehicle_no, driver: r.driver_name,
        product: r.product_type, since: r.loading_date,
        route: `${r.loading_point ?? '?'} -> ${r.destination ?? '?'}`,
        qty: r.loaded_qty, days_out: r.days_out == null ? null : num(r.days_out),
      }));
    }, []);

    // Vehicle productivity by RTKM — the whole ranked list, once.
    //
    // FREIGHT IS `billed_amount`, NOT `freight_amount`. Only 21 trips carry
    // freight_amount; 489 carry billed_amount, totalling 1,42,54,037.90, which
    // is what the books and the owner matrix read. Defining freight any other
    // way here would put two different revenue figures on the same screen —
    // exactly the disagreement the matrix comment warns about — so this reuses
    // the same COALESCE the owners route uses.
    //
    // Every figure is summed IN SQL and handed over as a numeric string. Money
    // never touches a JS float on the way to the screen.
    const vehicle_rtkm = await safe(errors, 'vehicle_rtkm', async () => {
      const { rows } = await query(`
        SELECT t.vehicle_no,
               count(*)::int                                   AS trips,
               round(sum(t.rtkm), 1)                           AS total_rtkm,
               COALESCE(sum(COALESCE(NULLIF(t.billed_amount,0), t.freight_amount, 0)), 0)
                                                               AS freight,
               COALESCE(sum(t.shortage_penalty), 0)            AS shortage,
               count(*) FILTER (WHERE COALESCE(NULLIF(t.billed_amount,0), t.freight_amount, 0) = 0)::int
                                                               AS unbilled_trips
          FROM trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
         WHERE t.vehicle_no IS NOT NULL AND t.rtkm > 0 ${TRIP_F}
         GROUP BY t.vehicle_no
         ORDER BY sum(t.rtkm) DESC`, P);
      const all = rows.map((r) => ({
        vehicle: r.vehicle_no,
        trips: num(r.trips),
        rtkm: r.total_rtkm,          // numeric -> string, formatted client-side
        freight: r.freight,
        shortage: r.shortage,
        unbilled_trips: num(r.unbilled_trips),
      }));
      // Bottom 5 is the tail of the SAME ordering rather than a second query
      // with ORDER BY ASC — one sort cannot disagree with itself, and with
      // fewer than 10 vehicles in scope the two lists would otherwise overlap
      // silently. `overlap` says so out loud instead.
      const top = all.slice(0, 5);
      const bottom = all.slice(-5).reverse();
      return {
        top,
        bottom,
        all,
        vehicles: all.length,
        overlap: all.length > 0 && all.length < 10,
      };
    }, { top: [], bottom: [], all: [], vehicles: 0, overlap: false });

    // Driver shortage recovery.
    //
    // PENDING MEANS NOT YET RECOVERED, not "has a penalty". Every recovery is a
    // driver_transactions row of type SHORTAGE_RECOVERY carrying the trip_id, so
    // outstanding is penalty minus what has already been taken back. As of now
    // all ten penalties are fully recovered and this list is empty — which is
    // the correct answer, and the reason the recovered set is returned
    // alongside rather than folded in. Showing a settled penalty as actionable
    // is how a driver gets docked for the same shortage twice.
    const shortage_recovery = await safe(errors, 'shortage_recovery', async () => {
      const { rows } = await query(`
        WITH per_trip AS (
          SELECT t.id, t.trip_code, t.driver_name, t.vehicle_no, t.loading_date,
                 COALESCE(t.shortage_qty, 0)                AS qty,
                 COALESCE(t.shortage_penalty, 0)            AS penalty,
                 COALESCE(rec.recovered, 0)                 AS recovered
            FROM trips t
            LEFT JOIN vehicles v ON v.id = t.vehicle_id
            LEFT JOIN LATERAL (
              SELECT COALESCE(sum(dt.amount), 0) AS recovered
                FROM driver_transactions dt
               WHERE dt.trip_id = t.id AND dt.txn_type = 'SHORTAGE_RECOVERY'
            ) rec ON true
           WHERE COALESCE(t.shortage_penalty, 0) > 0 ${TRIP_F}
        )
        SELECT COALESCE(driver_name, 'driver not recorded') AS driver_name,
               vehicle_no,
               count(*)::int         AS trips,
               sum(qty)              AS qty,
               sum(penalty)          AS penalty,
               sum(recovered)        AS recovered,
               sum(penalty) - sum(recovered) AS pending,
               max(loading_date)     AS latest,
               string_agg(trip_code, ', ' ORDER BY penalty DESC) AS trip_codes
          FROM per_trip
         GROUP BY 1, 2
         ORDER BY (sum(penalty) - sum(recovered)) DESC, sum(penalty) DESC`, P);
      const map = (r) => ({
        driver: r.driver_name,
        vehicle: r.vehicle_no,
        trips: num(r.trips),
        qty: r.qty,
        penalty: r.penalty,
        recovered: r.recovered,
        pending: r.pending,
        latest: r.latest,
        trip_codes: r.trip_codes,
      });
      // Compare as numbers only for the pending/settled SPLIT — never to
      // produce a figure. Every rupee shown is the SQL-summed string.
      const rowsOut = rows.map(map);
      return {
        pending: rowsOut.filter((r) => Number(r.pending) > 0.005),
        settled: rowsOut.filter((r) => Number(r.pending) <= 0.005),
      };
    }, { pending: [], settled: [] });

    // ── FINANCE ─────────────────────────────────────────────────────────────
    const money = await safe(errors, 'money', async () => {
      const { rows } = await query(`
        SELECT
          COALESCE(SUM(t.freight_amount) FILTER (WHERE COALESCE(t.billed_amount,0) = 0), 0) AS unbilled_freight,
          COALESCE(SUM(t.billed_amount), 0)                                            AS freight_income,
          COALESCE(SUM(t.received_amount), 0)                                          AS received,
          COALESCE(SUM(t.total_expense), 0)                                            AS total_expense,
          COALESCE(SUM(t.tds_amount), 0)                                               AS tds
        FROM trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
        WHERE 1=1 ${TRIP_F}`, P);
      const r = rows[0];
      return {
        unbilled_freight: num(r.unbilled_freight), freight_income: num(r.freight_income),
        received: num(r.received), total_expense: num(r.total_expense), tds: num(r.tds),
      };
    }, { unbilled_freight: 0, freight_income: 0, received: 0, total_expense: 0, tds: 0 });

    // Which loads are sitting unbilled. The KPI gives a rupee total; this says
    // whose invoice has not gone out, which is the only form of that number
    // anybody can act on.
    const unbilled_list = await safe(errors, 'unbilled_list', async () => {
      const { rows } = await query(`
        SELECT t.trip_code, t.vehicle_no, t.customer_name, t.loading_date,
               COALESCE(NULLIF(t.freight_amount,0), 0)::numeric(14,2) AS amount,
               CASE WHEN t.loading_date > DATE '2000-01-01'
                    THEN (CURRENT_DATE - t.loading_date)::int END AS age_days
          FROM trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
         WHERE COALESCE(t.billed_amount,0) = 0
           AND t.status IN ('COMPLETED','UNLOADING','IN_TRANSIT')
           ${TRIP_F}
         ORDER BY t.loading_date ASC NULLS LAST
         LIMIT 25`, P);
      return rows.map((r) => ({
        trip_code: r.trip_code, vehicle: r.vehicle_no, customer: r.customer_name,
        date: r.loading_date, amount: num(r.amount),
        age_days: r.age_days == null ? null : num(r.age_days),
      }));
    }, []);

    // Real-time P&L for the selected scope, straight off the posted books.
    // v_profit_and_loss is company-agnostic, so the company filter is applied
    // here against ledger_entries.company_id — the dimension migration 053
    // backfilled — rather than by re-deriving the statement.
    const pnl = await safe(errors, 'pnl', async () => {
      const { rows } = await query(`
        SELECT g.group_head, g.account_type,
               COALESCE(SUM(CASE WHEN g.account_type = 'INCOME'
                                 THEN CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END
                                 ELSE CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END
                            END), 0)::numeric(16,2) AS amount
          FROM account_groups g
          LEFT JOIN ledger_entries e ON e.ledger_name IN (
                 SELECT ledger_name FROM ledgers WHERE group_head = g.group_head)
               AND ($1::uuid IS NULL OR e.company_id = $1::uuid)
         WHERE g.statement = 'PROFIT_AND_LOSS'
         GROUP BY g.group_head, g.account_type, g.sort_order
         ORDER BY g.sort_order`, [F.companyId]);
      // HOW MUCH OF THE BOOKS THIS SCOPE CAN ACTUALLY SEE.
      //
      // ledger_entries.company_id was backfilled from a free-text column that
      // was NULL on 848 of 1720 rows — and the Freight Income postings are
      // among the untagged. So filtering the P&L by company silently drops
      // nearly all income and every company reads as a heavy loss while the
      // group reads as a profit. That is not a loss; it is an unattributable
      // entry, and the difference matters enormously to whoever reads it.
      //
      // Rather than hide the filter or fake an attribution, the coverage is
      // measured and returned so the screen can refuse to be believed.
      const cov = await query(`
        SELECT count(*)::int AS total,
               count(company_id)::int AS tagged,
               COALESCE(SUM(amount) FILTER (WHERE company_id IS NULL), 0)::numeric(16,2) AS untagged_amount
          FROM ledger_entries
         WHERE ledger_name IN (SELECT ledger_name FROM ledgers
                                WHERE group_head IN (SELECT group_head FROM account_groups
                                                      WHERE statement = 'PROFIT_AND_LOSS'))`);
      const c0 = cov.rows[0];
      const coverage = {
        total: num(c0.total),
        tagged: num(c0.tagged),
        untagged: num(c0.total) - num(c0.tagged),
        untagged_amount: num(c0.untagged_amount),
        pct: num(c0.total) ? Math.round((num(c0.tagged) / num(c0.total)) * 100) : 100,
      };

      const income = rows.filter((r) => r.account_type === 'INCOME');
      const expense = rows.filter((r) => r.account_type === 'EXPENSE');
      const sum = (a) => a.reduce((n, r) => n + num(r.amount), 0);
      const ti = sum(income), te = sum(expense);
      return {
        income: income.filter((r) => num(r.amount) !== 0).map((r) => ({ group: r.group_head, amount: num(r.amount) })),
        expense: expense.filter((r) => num(r.amount) !== 0).map((r) => ({ group: r.group_head, amount: num(r.amount) })),
        total_income: ti, total_expense: te, net: ti - te,
        // Present only when a company is selected: unfiltered totals are
        // complete by definition, so the warning would be noise there.
        coverage: F.companyId ? coverage : null,
      };
    }, { income: [], expense: [], total_income: 0, total_expense: 0, net: 0 });

    const banks = await safe(errors, 'banks', async () => {
      // READ THE COMPUTED VIEW, NOT ledgers.current_balance.
      //
      // current_balance is a denormalised column that nothing maintains: 184 of
      // the 185 ledgers still hold 0 in it. This widget therefore reported every
      // bank account as empty while SBI (8490) had 74.48 lakh in it, on 3.63
      // crore of debits against 2.88 crore of credits. v_ledger_balances derives
      // the balance from ledger_entries, which is the only place the money
      // actually is.
      const { rows } = await query(`
        SELECT ledger_name, COALESCE(balance_natural,0) AS bal
        FROM v_ledger_balances
        WHERE group_head ILIKE '%Bank%' OR group_head ILIKE '%Cash%' OR group_head ILIKE '%Wallet%'
        ORDER BY abs(COALESCE(balance_natural,0)::numeric) DESC LIMIT 8`);
      return rows.map((r) => ({ name: r.ledger_name, balance: num(r.bal) }));
    }, []);

    const groups = await safe(errors, 'group_totals', async () => {
      // Same dead column as above — group totals were all zero for the same reason.
      const { rows } = await query(`
        SELECT group_head, COALESCE(SUM(balance_natural),0) AS bal, count(*) AS n
        FROM v_ledger_balances GROUP BY 1 ORDER BY abs(SUM(balance_natural)) DESC LIMIT 12`);
      return rows.map((r) => ({ group: r.group_head, balance: num(r.bal), count: num(r.n) }));
    }, []);

    const monthly = await safe(errors, 'monthly_revenue', async () => {
      const { rows } = await query(`
        SELECT to_char(m.mon,'Mon') AS label,
               COALESCE(SUM(le.amount) FILTER (WHERE le.dr_cr = 'CR'), 0) AS revenue
        FROM generate_series(date_trunc('month', CURRENT_DATE) - interval '6 month',
                             date_trunc('month', CURRENT_DATE), '1 month') AS m(mon)
        LEFT JOIN ledger_entries le
               ON date_trunc('month', le.entry_date) = m.mon
              AND le.ledger_name ILIKE '%freight%'
        GROUP BY m.mon ORDER BY m.mon`);
      return rows.map((r) => ({ month: String(r.label).trim(), revenue: num(r.revenue) }));
    }, []);

    const customers = await safe(errors, 'customer_split', async () => {
      const { rows } = await query(`
        SELECT COALESCE(NULLIF(customer_name,''),'UNKNOWN') AS name,
               COALESCE(SUM(freight_amount),0) AS value
        FROM trips GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
      return rows.map((r) => ({ name: r.name, value: num(r.value) }));
    }, []);

    const ledger_book = await safe(errors, 'ledger_book', async () => {
      const { rows } = await query(`
        SELECT l.ledger_name, l.group_head,
               COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr='DR'),0) AS dr,
               COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr='CR'),0) AS cr,
               max(e.entry_date) AS last_entry
        FROM ledgers l
        JOIN ledger_entries e ON e.ledger_id = l.id
        GROUP BY l.ledger_name, l.group_head
        ORDER BY (COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr='DR'),0)
                + COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr='CR'),0)) DESC
        LIMIT 8`);
      return rows.map((r) => ({
        name: r.ledger_name, type: r.group_head,
        debit: num(r.dr), credit: num(r.cr), last_entry: r.last_entry,
      }));
    }, []);

    const book_totals = await safe(errors, 'book_totals', async () => {
      const { rows } = await query(`
        SELECT COALESCE(SUM(amount) FILTER (WHERE dr_cr='DR'),0) AS dr,
               COALESCE(SUM(amount) FILTER (WHERE dr_cr='CR'),0) AS cr,
               count(DISTINCT voucher_id) AS vouchers, count(*) AS entries
        FROM ledger_entries`);
      const r = rows[0];
      return { debit: num(r.dr), credit: num(r.cr), vouchers: num(r.vouchers), entries: num(r.entries) };
    }, { debit: 0, credit: 0, vouchers: 0, entries: 0 });

    // EMI / bank liabilities — real loans, not a hand-drawn ladder.
    const emi = await safe(errors, 'emi', async () => {
      const { rows } = await query(`
        SELECT bank_name,
               count(*)                                        AS loans,
               COALESCE(SUM(remaining_principal),0)             AS outstanding,
               COALESCE(SUM(emi_amount),0)                      AS monthly_emi,
               COALESCE(SUM(principal_amt),0)                   AS sanctioned,
               COALESCE(SUM(emis_completed),0)                  AS emis_done,
               COALESCE(SUM(tenure_months),0)                   AS emis_total
        FROM loan_master
        WHERE bank_name IS NOT NULL
        GROUP BY bank_name
        ORDER BY SUM(remaining_principal) DESC NULLS LAST`);
      const banks = rows.map((r) => ({
        bank: r.bank_name,
        loans: num(r.loans),
        outstanding: num(r.outstanding),
        monthly_emi: num(r.monthly_emi),
        sanctioned: num(r.sanctioned),
        // Repayment progress = EMIs paid / EMIs in the tenure.
        pct: num(r.emis_total) > 0 ? Math.round((num(r.emis_done) / num(r.emis_total)) * 100) : 0,
      }));
      const { rows: nxt } = await query(`
        SELECT count(*) AS due_loans, COALESCE(SUM(emi_amount),0) AS due_amount
        FROM loan_master WHERE payment_status IS DISTINCT FROM 'CLOSED'`);
      return {
        banks,
        total_outstanding: banks.reduce((s, b) => s + b.outstanding, 0),
        total_monthly: banks.reduce((s, b) => s + b.monthly_emi, 0),
        active_loans: num(nxt[0].due_loans),
      };
    }, { banks: [], total_outstanding: 0, total_monthly: 0, active_loans: 0 });

    // FASTag / toll. NOTE: fastag_accounts is empty, so there is no live tag
    // balance to show — what IS real is the spend, the credits loaded, and how
    // much of that spend has NOT yet been claimed back from the customer.
    const toll = await safe(errors, 'toll', async () => {
      const { rows: t } = await query(`
        SELECT COALESCE(SUM(amount),0)                                              AS spent_total,
               count(*)                                                             AS txns,
               COALESCE(SUM(amount) FILTER (WHERE claim_status = 'CLAIMED'),0)      AS claimed,
               COALESCE(SUM(amount) FILTER (WHERE claim_status <> 'CLAIMED'
                                              OR claim_status IS NULL),0)           AS unclaimed,
               COALESCE(SUM(amount) FILTER (WHERE txn_date >= date_trunc('month', CURRENT_DATE)),0) AS this_month,
               min(txn_date) AS since, max(txn_date) AS latest
        FROM toll_transactions`);
      const { rows: c } = await query(
        `SELECT COALESCE(SUM(amount),0) AS credited, count(*) AS n FROM fastag_credits`);
      const { rows: p } = await query(`
        SELECT COALESCE(provider,'Unassigned') AS provider,
               count(*) AS txns, COALESCE(SUM(amount),0) AS amount
        FROM toll_transactions GROUP BY 1 ORDER BY 3 DESC LIMIT 5`);
      const r = t[0];
      return {
        spent_total: num(r.spent_total), txns: num(r.txns),
        claimed: num(r.claimed), unclaimed: num(r.unclaimed),
        this_month: num(r.this_month), since: r.since, latest: r.latest,
        credited: num(c[0].credited), credit_count: num(c[0].n),
        providers: p.map((x) => ({ provider: x.provider, txns: num(x.txns), amount: num(x.amount) })),
        // There is no fastag_accounts row anywhere, so a "balance" figure would
        // be invented. Declared, not guessed.
        balance_available: false,
      };
    }, { spent_total: 0, txns: 0, claimed: 0, unclaimed: 0, this_month: 0,
         credited: 0, credit_count: 0, providers: [], balance_available: false });

    // Tally Prime connector. The card used to claim "Sync Active - 25,000 txs
    // - 100%". None of that existed: tally_sync has never held a row and the
    // connector has never reached Tally. What is reported here is the live
    // probe plus the real push ledger, so an accounting integration that has
    // never run cannot look healthy.
    const tally = await safe(errors, 'tally', async () => {
      // Connection refused returns immediately; the adapter's own 3s timeout
      // only bites if something is listening but mute.
      const alive = await tallyAlive().catch((e) => ({ up: false, detail: e.message }));

      const { rows: counts } = await query(
        `SELECT status, count(*)::int AS n FROM tally_sync GROUP BY status`);
      const byStatus = Object.fromEntries(counts.map((r) => [r.status, num(r.n)]));
      const pushed = counts.reduce((s, r) => s + num(r.n), 0);

      const { rows: last } = await query(
        `SELECT max(tally_synced_at) AS last_ok, max(updated_at) AS last_attempt
         FROM tally_sync`);

      // Everything in the books that Tally has never been told about.
      const { rows: pend } = await query(
        `SELECT count(DISTINCT voucher_id)::int AS n FROM ledger_entries
          WHERE voucher_id IS NOT NULL
            AND voucher_id::text NOT IN (SELECT source FROM tally_sync)`);

      return {
        up: !!alive.up,
        detail: alive.detail ?? null,
        url: process.env.TALLY_URL ?? 'http://localhost:9000',
        pushed,
        by_status: byStatus,
        failed: num(byStatus.FAILED ?? 0),
        pending_vouchers: num(pend[0].n),
        last_ok: last[0].last_ok,
        last_attempt: last[0].last_attempt,
        ever_synced: pushed > 0,
      };
    }, { up: false, detail: 'probe failed', url: '', pushed: 0, by_status: {},
         failed: 0, pending_vouchers: 0, last_ok: null, last_attempt: null, ever_synced: false });

    const health = await safe(errors, 'accounting_health', async () => {
      const { rows } = await query('SELECT * FROM v_accounting_health');
      return rows[0] ?? null;
    }, null);

    // WhatsApp inbox. The engine POSTs every message to /api/v1/crm, which is
    // the ONLY writer of wa_chats and dedupes on wa_msg_id — so this table is
    // the honest record of what actually went in and out, not the engine's own
    // in-memory view which resets on every reconnect.
    const whatsapp = await safe(errors, 'whatsapp', async () => {
      // Short probe: the engine is loopback locally and comes through the
      // reverse tunnel on AWS. Kept tight so a dead tunnel cannot stall the
      // whole dashboard.
      let engine = { connected: false, status: 'UNREACHABLE' };
      try {
        const base = process.env.WA_ENGINE_URL || 'http://127.0.0.1:5001';
        const res = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const j = await res.json();
          engine = { connected: !!j.connected, status: j.status || (j.connected ? 'ONLINE' : 'UNKNOWN') };
        }
      } catch { /* engine down is a state, not an error */ }

      const { rows: tot } = await query(`
        SELECT count(*)::int                                                        AS total,
               -- direction is stored as 'incoming'/'outgoing', NOT 'IN'/'OUT'. This
               -- filter asked for 'IN' and matched nothing, so the CRM hub showed
               -- inbound 0 and outbound 0 while wa_chats held 5 incoming messages.
               -- Matching on the first three letters accepts both spellings, so a
               -- future engine writing 'IN' does not silently zero the card again.
               count(*) FILTER (WHERE upper(left(direction,2)) = 'IN')::int          AS inbound,
               count(*) FILTER (WHERE upper(left(direction,3)) = 'OUT')::int         AS outbound,
               count(*) FILTER (WHERE ts >= now() - interval '24 hours')::int       AS last_24h,
               count(DISTINCT phone)::int                                           AS contacts,
               max(ts)                                                              AS last_msg_at
        FROM wa_chats`);

      // One row per conversation, newest first.
      const { rows: chats } = await query(`
        SELECT DISTINCT ON (phone)
               phone, text, direction, ts, role,
               (SELECT count(*)::int FROM wa_chats c2 WHERE c2.phone = c1.phone) AS msgs
        FROM wa_chats c1
        ORDER BY phone, ts DESC`);
      chats.sort((a, b) => new Date(b.ts) - new Date(a.ts));

      const { rows: notif } = await query(`
        SELECT status, count(*)::int AS n FROM notifications GROUP BY status`);

      const t = tot[0];
      return {
        engine,
        total: num(t.total), inbound: num(t.inbound), outbound: num(t.outbound),
        last_24h: num(t.last_24h), contacts: num(t.contacts), last_msg_at: t.last_msg_at,
        chats: chats.slice(0, 6).map((c) => ({
          phone: c.phone, last: c.text, direction: c.direction,
          at: c.ts, msgs: num(c.msgs), role: c.role,
        })),
        notifications: Object.fromEntries(notif.map((r) => [r.status, num(r.n)])),
      };
    }, { engine: { connected: false, status: 'UNREACHABLE' }, total: 0, inbound: 0,
         outbound: 0, last_24h: 0, contacts: 0, last_msg_at: null, chats: [], notifications: {} });

    // Map layer. trip_gps_pings is EMPTY — no vehicle has ever reported a
    // position — so there is no live GPS trail to draw. What IS real is where
    // the fleet actually paid toll: 2,788 of 2,870 crossings carry plaza
    // coordinates. That is a genuine footprint of the routes run, so the map
    // plots those instead of inventing a live mesh.
    const geo = await safe(errors, 'geo', async () => {
      const { rows: pings } = await query('SELECT count(*)::int AS n FROM trip_gps_pings');

      const { rows: plazas } = await query(`
        SELECT plaza_name,
               avg(lat)::double precision  AS lat,
               avg(lng)::double precision  AS lng,
               count(*)::int               AS crossings,
               COALESCE(SUM(amount),0)     AS amount,
               max(txn_date)               AS last_seen
        FROM toll_transactions
        WHERE lat IS NOT NULL AND lng IS NOT NULL
          AND lat BETWEEN 6 AND 37 AND lng BETWEEN 68 AND 98   -- inside India
        GROUP BY plaza_name
        ORDER BY count(*) DESC
        LIMIT 120`);

      const { rows: span } = await query(`
        SELECT min(lat)::double precision AS min_lat, max(lat)::double precision AS max_lat,
               min(lng)::double precision AS min_lng, max(lng)::double precision AS max_lng,
               count(*)::int AS geo_txns, count(DISTINCT plaza_name)::int AS plaza_count
        FROM toll_transactions WHERE lat IS NOT NULL AND lng IS NOT NULL`);

      return {
        source: 'toll_plaza',           // NOT gps — declared so the UI cannot mislabel it
        gps_pings: num(pings[0].n),
        live_gps_available: num(pings[0].n) > 0,
        plazas: plazas.map((p) => ({
          name: p.plaza_name, lat: p.lat, lng: p.lng,
          crossings: num(p.crossings), amount: num(p.amount), last_seen: p.last_seen,
        })),
        ...span[0],
      };
    }, { source: 'toll_plaza', gps_pings: 0, live_gps_available: false, plazas: [] });

    // ── CRM ─────────────────────────────────────────────────────────────────
    const staff = await safe(errors, 'staff', async () => {
      const { rows } = await query(`
        SELECT full_name, role, status, last_login_at
        FROM users WHERE status = 'ACTIVE' ORDER BY role, full_name LIMIT 8`);
      return rows.map((r) => ({
        name: r.full_name, role: r.role, last_login: r.last_login_at,
      }));
    }, []);

    const activity = await safe(errors, 'activity', async () => {
      const { rows } = await query(`
        SELECT to_char(entry_date,'DD Mon') AS d, ledger_name, dr_cr, amount, particulars
        FROM ledger_entries ORDER BY created_at DESC LIMIT 12`);
      return rows.map((r) => ({
        at: String(r.d).trim(),
        text: `${r.ledger_name} ${r.dr_cr} ${Number(r.amount).toLocaleString('en-IN')}`
            + (r.particulars ? ` — ${String(r.particulars).slice(0, 48)}` : ''),
      }));
    }, []);

    // LIVE DISPATCH CHAT. The panel that shows this was hard-coded — six named
    // drivers and a four-message conversation written into the component — so
    // it read as a working dispatch line on a system where no driver has ever
    // sent a message. That is the one thing useDashboardData's honesty contract
    // exists to prevent, and it was being broken by the widget the contract was
    // written next to.
    //
    // MATCHED TO THE DRIVER MASTER, NOT SHOWN RAW. wa_chats currently holds 150
    // messages from 9 senders and not one of them is a driver: six are WhatsApp
    // GROUP ids (last10() of a group jid leaves something that is not a phone
    // number at all) and the rest are forwards. Piping that straight into a
    // panel titled "Live Dispatch Chat" would replace invented dispatch traffic
    // with real traffic that is not dispatch — worse, because it looks
    // authoritative. The join to drivers IS the filter, and today it correctly
    // returns nothing.
    //
    // Unread means "incoming since we last replied", which is the only
    // definition available without a read-receipt column, and it is the one the
    // operator actually cares about: who is waiting on the office.
    // EVERY NUMBER THAT WRITES IN, NOT JUST THE ONES IN THE DRIVER MASTER.
    //
    // This used to be `wa_chats JOIN drivers` — an INNER join — so a message
    // from a customer, a vendor, or any number not yet on a driver record was
    // dropped on the floor. Not shown as unknown: dropped. The panel then said
    // "no chats yet" while the company number had actually been written to, and
    // there was nothing on screen to suggest anything was missing. That is the
    // failure this dashboard's honesty contract exists to prevent.
    //
    // The directory below is drivers ∪ customers ∪ vendors matched on the last
    // ten digits, and the join to it is a LEFT one, so an unrecognised number
    // arrives labelled UNKNOWN and can be answered — which is exactly when
    // somebody wants to see it. `kind` is what makes the All/Driver/Vendor/
    // Customer tabs mean something rather than being three empty lists.
    //
    // Keyed on PHONE, not driver_id. The phone is the WhatsApp identity and the
    // only key every one of these rows actually has; driver_id is null for
    // three of the four kinds.
    const dispatch_chats = await safe(errors, 'dispatch_chats', async () => {
      // The union that used to be written out here now lives in
      // server/lib/contactDirectory.js, shared with the picker in the chat
      // panel and with the privacy gate on POST /crm/chats. The copy it
      // replaces knew nothing of fuel pumps (11 of them, sitting in `vendors`
      // under vendor_type='Fuel Pump') or of hand-added wa_contacts, so both
      // arrived here labelled UNKNOWN — "Anjaan" on a screen, for numbers the
      // Broadcast Center two tabs away was listing by name.
      const { rows } = await query(`
        WITH ${DIRECTORY_CTE},
        latest AS (
          SELECT DISTINCT ON (phone) phone, text, direction, ts
            FROM wa_chats ORDER BY phone, ts DESC
        )
        SELECT l.phone,
               COALESCE(d.kind, 'UNKNOWN') AS kind,
               d.driver_id,
               d.contact_name,
               d.sub AS contact_sub,
               l.text AS last_text, l.direction AS last_direction, l.ts AS last_ts,
               t.id AS trip_id, t.trip_code, t.status AS trip_status, t.vehicle_no,
               (SELECT count(*)::int FROM wa_chats m
                 WHERE m.phone = l.phone AND m.direction = 'incoming'
                   AND m.ts > COALESCE((SELECT max(o.ts) FROM wa_chats o
                                         WHERE o.phone = l.phone AND o.direction = 'outgoing'),
                                       '-infinity'::timestamptz)) AS unread,
               COALESCE((SELECT json_agg(x ORDER BY x.ts)
                           FROM (SELECT m.id, m.text, m.direction, m.ts, m.sent_by_user_name,
                                        m.media_type, m.media_key
                                   FROM wa_chats m WHERE m.phone = l.phone
                                  ORDER BY m.ts DESC LIMIT 20) x), '[]'::json) AS messages
          FROM latest l
          LEFT JOIN dir d ON d.phone = l.phone
          -- Trips belong to drivers. For the other kinds this stays null rather
          -- than matching something coincidental.
          LEFT JOIN LATERAL (
                 SELECT id, trip_code, status, vehicle_no
                   FROM trips
                  WHERE d.driver_id IS NOT NULL
                    AND driver_id = d.driver_id
                    AND status IN ('LOADED','IN_TRANSIT','UNLOADING')
                  ORDER BY updated_at DESC
                  LIMIT 1) t ON true
         ORDER BY l.ts DESC
         LIMIT 24`);
      return rows.map((r) => ({
        // Stable key for the UI. driver_id is kept for the callers that still
        // use it, but it is null for CUSTOMER, VENDOR and UNKNOWN.
        phone: r.phone,
        kind: r.kind,
        driver_id: r.driver_id,
        // Named where the ERP knows the number, and honestly unnamed where it
        // does not — never a plausible-looking placeholder.
        contact_name: r.contact_name || null,
        driver_name: r.contact_name || null,   // legacy field name, same value
        // The vendor_type behind a PUMP or VENDOR ("Fuel Pump", "Spare Parts"),
        // so the panel can say which kind of vendor without a second lookup.
        contact_sub: r.contact_sub || null,
        trip_id: r.trip_id,
        trip_code: r.trip_code,
        trip_status: r.trip_status,
        vehicle_no: r.vehicle_no,
        last_text: r.last_text,
        last_direction: r.last_direction,
        last_ts: r.last_ts,
        unread: num(r.unread),
        messages: r.messages ?? [],
      }));
    }, []);

    // ── ACTIVE ERP TRIPS — THE DISPATCH LIST THAT IS NOT AN INBOX ───────────
    //
    // The panel above (dispatch_chats) is an INBOX: it lists whoever wrote to
    // the company number, newest first. On this system that is mostly people
    // dispatch has no business with — horoscope forwards, a bus-gangrape news
    // chain, numbers on no master at all. Six of the top rows on 2-Sep were
    // "Anjaan", and the one thing a dispatcher actually wants — "show me the
    // 146 lorries that are out right now and let me talk to their drivers" —
    // was not on the screen at all.
    //
    // This is that list. It starts from TRIPS, not from messages, so a driver
    // who has never written in is still one click away, and a stranger who
    // writes in every hour never appears. The inbox is not deleted: it lives in
    // the Dispatch Console (EXPAND), which is where an unrecognised number
    // should be dealt with.
    //
    // NO MESSAGE BODIES HERE. dispatch_chats embeds 20 messages per thread for
    // 24 threads; doing that for 146 trips would put roughly 3,000 messages in
    // a payload that is polled every 8 seconds. The list carries the last line
    // and the unread count — enough to decide who to open — and the panel
    // fetches the conversation itself from /crm/chats?phone= when a trip is
    // actually selected.
    //
    // THE PHONE IS THE TRIP'S OWN driver_mobile FIRST, the driver master
    // second. Those disagree on real rows (a relief driver takes the lorry and
    // the trip records the number that actually went out), and the trip is the
    // more specific record. A trip whose driver has no reachable number is
    // still listed, with phone null — the panel says so rather than hiding the
    // lorry, because "we cannot reach this driver" is dispatch information.
    const dispatch_trips = await safe(errors, 'dispatch_trips', async () => {
      const { rows } = await query(`
        WITH act AS (
          SELECT t.id, t.trip_code, t.status, t.vehicle_no, t.driver_id,
                 COALESCE(NULLIF(btrim(t.driver_name), ''), d.name) AS driver_name,
                 t.loading_point, t.unloading_location, t.consignee_name,
                 t.customer_name, t.loading_date, t.updated_at, t.product_type,
                 t.loaded_qty,
                 NULLIF(right(regexp_replace(
                   COALESCE(NULLIF(btrim(t.driver_mobile), ''), d.mobile, ''),
                   '[^0-9]', '', 'g'), 10), '') AS phone
            FROM trips t
            LEFT JOIN vehicles v ON v.id = t.vehicle_id
            LEFT JOIN drivers  d ON d.id = t.driver_id
           WHERE t.status IN ('LOADED','IN_TRANSIT','UNLOADING') ${TRIP_F}
           ORDER BY t.updated_at DESC
           LIMIT 250
        )
        SELECT a.*,
               m.text AS last_text, m.direction AS last_direction, m.ts AS last_ts,
               COALESCE(u.unread, 0)::int AS unread
          FROM act a
          LEFT JOIN LATERAL (
                 SELECT w.text, w.direction, w.ts
                   FROM wa_chats w
                  WHERE a.phone IS NOT NULL AND w.phone = a.phone
                  ORDER BY w.ts DESC LIMIT 1) m ON true
          LEFT JOIN LATERAL (
                 -- "Incoming since we last replied" — the same definition the
                 -- inbox uses, so one number does not mean two things on one
                 -- screen.
                 SELECT count(*)::int AS unread
                   FROM wa_chats w
                  WHERE a.phone IS NOT NULL AND w.phone = a.phone
                    AND w.direction = 'incoming'
                    AND w.ts > COALESCE((SELECT max(o.ts) FROM wa_chats o
                                          WHERE o.phone = a.phone AND o.direction = 'outgoing'),
                                        '-infinity'::timestamptz)) u ON true
         -- Unanswered first, then whoever spoke last, then the freshest trip.
         -- A dispatcher's queue is "who is waiting on me", not "who loaded most
         -- recently".
         ORDER BY COALESCE(u.unread, 0) DESC, m.ts DESC NULLS LAST, a.updated_at DESC`, P);
      return rows.map((r) => ({
        trip_id: r.id,
        trip_code: r.trip_code,
        status: r.status,
        vehicle_no: r.vehicle_no,
        driver_id: r.driver_id,
        driver_name: r.driver_name || null,
        phone: r.phone,
        loading_point: r.loading_point || null,
        // The destination as the trip records it. unloading_location is the
        // place; consignee is who receives it. Both are shown because a lane
        // is quoted either way on the phone, and neither is invented when the
        // trip record is blank.
        unloading_location: r.unloading_location || null,
        consignee_name: r.consignee_name || null,
        customer_name: r.customer_name || null,
        product_type: r.product_type || null,
        loaded_qty: r.loaded_qty === null ? null : Number(r.loaded_qty),
        loading_date: r.loading_date,
        last_text: r.last_text ?? null,
        last_direction: r.last_direction ?? null,
        last_ts: r.last_ts ?? null,
        unread: num(r.unread),
      }));
    }, []);

    // ── TODAY'S LOADING ACTIVITY — WHERE EACH ROW CAME FROM ─────────────────
    //
    // Two ways a loading reaches this ERP: the IOCL AC5 mailbox sync parses an
    // invoice and inserts it, or somebody types it into the Loading Register.
    // The register shows them side by side and identical, so nobody can tell
    // which half of the day's work the machine did and which half a person did —
    // and, more usefully, nobody can tell when the machine has QUIETLY STOPPED.
    //
    // THE SPLIT IS `iocl_invoice_no`, AND IT IS NOT A GUESS. The sync writes it
    // on every row it creates (tools/iocl_recon/iocl_ac5_loading.py). Measured
    // on production: 639 trips carry one, 379 do not, and the two sets do not
    // overlap. `submitted_by` would have been the natural column and is NULL on
    // all 1018 rows — it has never been written — so it is not used here rather
    // than being used and quietly meaning nothing.
    //
    // DATED IN IST, DELIBERATELY. This database runs in UTC, so `CURRENT_DATE`
    // is the UTC day: between midnight and 05:30 India time it names YESTERDAY,
    // and a panel titled "today" would spend every night showing the wrong one.
    //
    // BY created_at, NOT loading_date. The question is what the ERP took in
    // today, not which trucks loaded today — a mailbox sync routinely imports an
    // invoice days after the loading it describes. Each row still carries its
    // loading date so the difference is visible rather than hidden.
    //
    // AND SPLIT BY OPERATING COMPANY, BECAUSE THREE OF THEM SHARE THIS REGISTER.
    // Measured on production: M/S PRASAD TRANSPORT 746 trips, M/S JAISWAL
    // ENTERPRISE 188, M/S GAUTAM PRASAD 84. The two mailboxes feed the first
    // two (PT##### and JE##### series); the third arrives the same ways and had
    // nowhere on this dashboard that named it.
    //
    // A DAY THAT IS EMPTY STILL HAS TO SAY SOMETHING TRUE. Today is genuinely
    // empty — the newest row in the whole table is 21-08, seven days back — and
    // a panel that renders nothing on an empty day is indistinguishable from one
    // that failed to load, which is the fault this dashboard's honesty contract
    // exists to prevent. So the last day that DID have entries is returned
    // alongside, and the panel falls back to showing it under its own date.
    // That is also what makes a stopped mailbox sync visible instead of silent.
    const loading_activity = await safe(errors, 'loading_activity', async () => {
      const SPLIT = `CASE WHEN iocl_invoice_no IS NOT NULL THEN 'EMAIL' ELSE 'MANUAL' END`;
      const IST_DAY = `(created_at AT TIME ZONE 'Asia/Kolkata')::date`;
      const { rows } = await query(`
        WITH tagged AS (
          SELECT id, trip_code, vehicle_no, product_type, loaded_qty, loading_date,
                 customer_name, loading_point, iocl_invoice_no, created_at,
                 COALESCE(operating_company, '(unassigned)') AS operating_company,
                 ${SPLIT} AS source,
                 ${IST_DAY} AS ist_day
            FROM trips
        ),
        -- The day the panel is ABOUT: today when it has rows, otherwise the most
        -- recent day that does. Chosen in SQL so the UI never has to make a
        -- second request to find out which day it is looking at.
        target AS (
          SELECT COALESCE(
            (SELECT ist_day FROM tagged
              WHERE ist_day = (now() AT TIME ZONE 'Asia/Kolkata')::date LIMIT 1),
            (SELECT max(ist_day) FROM tagged)
          ) AS day
        ),
        day_rows AS (
          SELECT t.* FROM tagged t, target WHERE t.ist_day = target.day
        ),
        -- ── THE WEEK VIEW IS ABOUT LOADING DATES, NOT ENTRY DATES ─────────────
        -- target/last7 above are keyed on created_at, which is the right
        -- axis for "did the sync run" — that is what this panel was built to
        -- expose. It is the WRONG axis for "kis din kitni loading hui", and on
        -- 28-08 the difference was the whole screen: the register was recovered
        -- that morning, so every one of those trips carried today's created_at
        -- and the week chart drew six empty days and one spike, for loadings
        -- that actually happened on the 17th to the 21st.
        --
        -- Anchored on the newest LOADING day rather than today for the same
        -- reason target falls back: a window ending today is empty whenever
        -- the register is behind, and an empty chart is indistinguishable from
        -- a broken one. Ending it on the last day with real work shows the week
        -- the operator is actually asking about.
        load_target AS (
          SELECT COALESCE((SELECT max(loading_date)::date FROM tagged),
                          (now() AT TIME ZONE 'Asia/Kolkata')::date) AS day
        ),
        load_week AS (
          SELECT t.* FROM tagged t, load_target
           WHERE t.loading_date::date BETWEEN load_target.day - 6 AND load_target.day
        )
        SELECT
          (SELECT day FROM target)                                        AS day,
          ((SELECT day FROM target) = (now() AT TIME ZONE 'Asia/Kolkata')::date) AS is_today,
          (SELECT count(*)::int FROM day_rows WHERE source = 'EMAIL')     AS email_count,
          (SELECT count(*)::int FROM day_rows WHERE source = 'MANUAL')    AS manual_count,
          (SELECT COALESCE(sum(loaded_qty), 0) FROM day_rows WHERE source = 'EMAIL')  AS email_qty,
          (SELECT COALESCE(sum(loaded_qty), 0) FROM day_rows WHERE source = 'MANUAL') AS manual_qty,
          (SELECT max(created_at) FROM tagged)                            AS last_entry_at,
          (SELECT count(*)::int FROM tagged
            WHERE created_at > now() - interval '7 days')                 AS last_7d_count,
          COALESCE((SELECT json_agg(c ORDER BY c.trips DESC)
                      FROM (SELECT operating_company AS company,
                                   count(*)::int AS trips,
                                   count(*) FILTER (WHERE source = 'EMAIL')::int  AS email_count,
                                   count(*) FILTER (WHERE source = 'MANUAL')::int AS manual_count,
                                   COALESCE(sum(loaded_qty), 0) AS qty
                              FROM day_rows GROUP BY 1) c), '[]'::json)   AS by_company,
          COALESCE((SELECT json_agg(r ORDER BY r.created_at DESC)
                      FROM (SELECT * FROM day_rows ORDER BY created_at DESC LIMIT 40) r),
                   '[]'::json)                                            AS rows,
          -- THE LAST SEVEN DAYS, WITH THE EMPTY ONES STILL IN IT.
          --
          -- generate_series is what puts a zero row on a day nothing came in.
          -- Aggregating the trips table alone would simply omit those days, and
          -- a chart that silently skips its empty days is a chart that hides the
          -- exact thing this panel exists to show — the week the sync stopped
          -- would render as an unbroken line of busy days.
          COALESCE((SELECT json_agg(d ORDER BY d.day)
                      FROM (
                        SELECT g::date AS day,
                               count(t.id) FILTER (WHERE t.source = 'EMAIL')::int  AS email_count,
                               count(t.id) FILTER (WHERE t.source = 'MANUAL')::int AS manual_count,
                               COALESCE(sum(t.loaded_qty) FILTER (WHERE t.source = 'EMAIL'), 0)  AS email_qty,
                               COALESCE(sum(t.loaded_qty) FILTER (WHERE t.source = 'MANUAL'), 0) AS manual_qty,
                               COALESCE(json_agg(DISTINCT t.operating_company)
                                        FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS companies
                          FROM generate_series(
                                 (now() AT TIME ZONE 'Asia/Kolkata')::date - 6,
                                 (now() AT TIME ZONE 'Asia/Kolkata')::date,
                                 interval '1 day') g
                          LEFT JOIN tagged t ON t.ist_day = g::date
                         GROUP BY g::date) d), '[]'::json)                 AS last7,

          -- The same seven rows on the loading-date axis, ending on the last day
          -- that had a loading. This is what the 7-day dialog draws.
          (SELECT day FROM load_target)                                    AS load_week_to,
          ((SELECT day FROM load_target) - 6)                              AS load_week_from,
          COALESCE((SELECT json_agg(d ORDER BY d.day)
                      FROM (
                        SELECT g::date AS day,
                               count(t.id) FILTER (WHERE t.source = 'EMAIL')::int  AS email_count,
                               count(t.id) FILTER (WHERE t.source = 'MANUAL')::int AS manual_count,
                               COALESCE(sum(t.loaded_qty) FILTER (WHERE t.source = 'EMAIL'), 0)  AS email_qty,
                               COALESCE(sum(t.loaded_qty) FILTER (WHERE t.source = 'MANUAL'), 0) AS manual_qty
                          FROM load_target,
                               generate_series(load_target.day - 6, load_target.day,
                                               interval '1 day') g
                          LEFT JOIN tagged t ON t.loading_date::date = g::date
                         GROUP BY g::date) d), '[]'::json)                 AS last7_loading,

          -- TRANSPORT-WISE, over that same week. The day chips answer "kiska
          -- aaj"; this answers "kiska is hafte", which is the question actually
          -- asked of a register three companies share — and the one the panel
          -- could not answer at all before.
          COALESCE((SELECT json_agg(c ORDER BY c.trips DESC)
                      FROM (SELECT operating_company AS company,
                                   count(*)::int AS trips,
                                   count(*) FILTER (WHERE source = 'EMAIL')::int  AS email_count,
                                   count(*) FILTER (WHERE source = 'MANUAL')::int AS manual_count,
                                   COALESCE(sum(loaded_qty), 0) AS qty,
                                   count(DISTINCT vehicle_no)::int AS vehicles,
                                   min(loading_date)::date AS first_day,
                                   max(loading_date)::date AS last_day
                              FROM load_week GROUP BY 1) c), '[]'::json)   AS by_company_week,

          -- EVERY TRIP IN THAT WEEK, NOT JUST THE TOTALS.
          --
          -- The bars answer "kitni" and the company cards answer "kiski"; the
          -- next question is always "kaunsi gaadi, kahan se kahan, kitna" and
          -- until now that meant leaving the dashboard for the Loading Register.
          -- Read straight from trips rather than through tagged so the extra
          -- columns do not widen the day-panel payload, which is polled every
          -- 30s and needs none of them.
          --
          -- Capped at 200. A seven-day window has never held a fifth of that,
          -- and an uncapped json_agg on a dashboard poll is how a slow page
          -- becomes a slow server.
          COALESCE((SELECT json_agg(t ORDER BY t.loading_date DESC, t.trip_code)
                      FROM (SELECT tr.id, tr.trip_code, tr.vehicle_no, tr.loading_date,
                                   tr.loading_point, tr.unloading_location, tr.consignee_name,
                                   tr.product_type, tr.loaded_qty, tr.unloaded_qty,
                                   tr.shortage_qty, tr.rtkm, tr.driver_name, tr.status,
                                   COALESCE(tr.operating_company, '(unassigned)') AS operating_company,
                                   tr.iocl_invoice_no,
                                   CASE WHEN tr.iocl_invoice_no IS NOT NULL THEN 'EMAIL' ELSE 'MANUAL' END AS source
                              FROM trips tr, load_target
                             WHERE tr.loading_date::date
                                   BETWEEN load_target.day - 6 AND load_target.day
                             ORDER BY tr.loading_date DESC, tr.trip_code
                             LIMIT 200) t), '[]'::json)                    AS week_trips`);
      const r = rows[0] || {};
      // MAILBOX HEALTH TRAVELS WITH THE COUNTS IT EXPLAINS.
      //
      // "0 auto entries today" has two meanings and the panel cannot tell them
      // apart on its own: a quiet day, or a mailbox that has not been readable
      // since 21-08 because its OAuth token expired. Both tokens had. The
      // counts and the reason belong in the same payload, on the same screen,
      // or the reason is somewhere nobody looks.
      //
      // In memory, so this costs nothing on a dashboard polled every 30s. It is
      // null until the first sync tick after an API restart, and the UI says
      // nothing rather than claiming health it has not checked.
      const sync = syncState();
      const failedBoxes = sync?.last_run?.mailboxes_failed ?? [];
      // ── THE DAILY LOADING REGISTER (AC4) ─────────────────────────────────
      // Two documents, two processes, never merged (owner's rule, 2-Sep-2026).
      // The AC4 — IOCL's tax invoice to the consignee, mailed within the hour
      // of the truck leaving the bay — is DAILY LOADING and lives in
      // iocl_ac4_loads (migration 125), one row per document. The AC5 is the
      // fortnightly FREIGHT document and is what the trips above are made of.
      // 77 AC4s to 32 AC5s between 15-Aug and 2-Sep: on a day with eight
      // retail loads, trips alone said "nothing today". This is the answer to
      // "what loaded today"; the tiles below remain the answer to "what got
      // billed as a trip".
      //
      // If today has AC4 loadings but no trip yet, today IS the panel's day —
      // otherwise the stale-date banner would call a busy morning empty. The
      // trip-side counts for that day are then genuinely zero.
      const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      let ac4Rows = [];
      let ac4Error = sync?.last_run?.ac4_error ?? null;
      try {
        ac4Rows = (await query(
          `SELECT sap_no, loading_date::text AS loading_date, loading_time, vehicle_no,
                  operating_company, loading_point, consignee, products, qty_kl, mailbox
             FROM iocl_ac4_loads
            WHERE loading_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date - 6
            ORDER BY loading_date DESC, loading_time DESC NULLS LAST, sap_no DESC`)).rows;
      } catch (e) {
        ac4Error = ac4Error || `loading register unavailable: ${String(e.message).slice(0, 120)}`;
      }
      const ac4Today = ac4Rows.filter((x) => x.loading_date === todayIst);
      const override = !r.is_today && ac4Today.length > 0;
      const day = override ? todayIst : (r.day ?? null);
      const ac4Day = ac4Rows.filter((x) => x.loading_date === day);
      const ac4Week = {};
      for (const x of ac4Rows) {
        const w = (ac4Week[x.loading_date] ||= { day: x.loading_date, count: 0, qty_kl: 0 });
        w.count += 1;
        w.qty_kl += Number(x.qty_kl || 0);
      }
      const ac4Load = (x) => ({
        sap_no: x.sap_no, date: x.loading_date, time: x.loading_time ?? null,
        vehicle_no: x.vehicle_no, company: x.operating_company ?? null,
        from: x.loading_point ?? null, consignee: x.consignee ?? null,
        products: x.products ?? null, qty_kl: num(x.qty_kl), mailbox: x.mailbox ?? null,
      });
      return {
        day,
        is_today: override ? true : !!r.is_today,
        ac4: {
          day: ac4Day.map(ac4Load),
          today_count: ac4Today.length,
          today_qty: Number(ac4Today.reduce((s, x) => s + Number(x.qty_kl || 0), 0).toFixed(3)),
          week: Object.values(ac4Week).sort((p, q) => p.day.localeCompare(q.day)),
          error: ac4Error,
        },
        sync: {
          checked_at: sync?.last_run?.at ?? null,
          running: !!sync?.running,
          downloaded: sync?.last_run?.downloaded ?? null,
          mailboxes_failed: failedBoxes,
          mailbox_detail: failedBoxes.length
            ? Object.fromEntries(failedBoxes.map((k) => [k, sync.last_run.mailboxes?.[k]?.status ?? 'unavailable']))
            : {},
          // A READABLE MAILBOX IS ONLY HALF THE CHAIN.
          // From 21-08 the mailboxes were fine and every insert answered 401, so
          // a banner that watches only the read end would have gone green while
          // the register stayed frozen — the exact wrong answer, because green
          // is what stops anyone looking. Carried separately from
          // mailboxes_failed: "we could not read" and "we read it and could not
          // file it" send you to different places.
          insert_failed: sync?.last_run?.insert_failed ?? 0,
          insert_errors: sync?.last_run?.insert_errors ?? [],
          // AND THE THIRD OUTCOME, WHICH WAS INVISIBLE. An AC5 that matches an
          // existing trip on truck, date and quantity but whose trip has no
          // invoice number recorded is HELD — the importer will not attach it,
          // because deciding that two records are the same movement is a human
          // call. Six were being held on 2026-09-02 and nothing on any screen
          // said so: not a failure, so no banner; not an insert, so no count.
          // Work that is waiting on a person has to be visible or it is not
          // waiting on anyone.
          held_for_review: sync?.last_run?.held_for_review ?? 0,
          // The AC4 tally of the last tick, for the sync line; the loads
          // themselves come from iocl_ac4_loads above, not from memory.
          ac4_new: sync?.last_run?.ac4_new ?? 0,
          ac4_failed: sync?.last_run?.ac4_failed ?? 0,
          second_invoice: sync?.last_run?.second_invoice ?? 0,
        },
        // When today is the day only because of AC4 loadings, the trip-side
        // figures are today's — zero — not the fallback day's.
        email_count: override ? 0 : num(r.email_count),
        manual_count: override ? 0 : num(r.manual_count),
        email_qty: override ? 0 : num(r.email_qty),
        manual_qty: override ? 0 : num(r.manual_qty),
        last_entry_at: r.last_entry_at ?? null,
        last_7d_count: num(r.last_7d_count),
        last7: (r.last7 ?? []).map((d) => ({
          day: d.day,
          email_count: num(d.email_count),
          manual_count: num(d.manual_count),
          email_qty: num(d.email_qty),
          manual_qty: num(d.manual_qty),
          companies: d.companies ?? [],
        })),
        by_company: (override ? [] : (r.by_company ?? [])).map((c) => ({
          company: c.company,
          trips: num(c.trips),
          email_count: num(c.email_count),
          manual_count: num(c.manual_count),
          qty: num(c.qty),
        })),
        load_week_from: r.load_week_from ?? null,
        load_week_to: r.load_week_to ?? null,
        last7_loading: (r.last7_loading ?? []).map((d) => ({
          day: d.day,
          email_count: num(d.email_count),
          manual_count: num(d.manual_count),
          email_qty: num(d.email_qty),
          manual_qty: num(d.manual_qty),
        })),
        week_trips: (r.week_trips ?? []).map((t) => ({
          id: t.id,
          trip_code: t.trip_code,
          vehicle_no: t.vehicle_no,
          loading_date: t.loading_date,
          from: t.loading_point,
          to: t.unloading_location || t.consignee_name,
          product_type: t.product_type,
          loaded_qty: num(t.loaded_qty),
          unloaded_qty: t.unloaded_qty == null ? null : num(t.unloaded_qty),
          shortage_qty: t.shortage_qty == null ? null : num(t.shortage_qty),
          rtkm: t.rtkm == null ? null : num(t.rtkm),
          driver_name: t.driver_name,
          status: t.status,
          company: t.operating_company,
          invoice_no: t.iocl_invoice_no,
          source: t.source,
        })),
        by_company_week: (r.by_company_week ?? []).map((c) => ({
          company: c.company,
          trips: num(c.trips),
          email_count: num(c.email_count),
          manual_count: num(c.manual_count),
          qty: num(c.qty),
          vehicles: num(c.vehicles),
          first_day: c.first_day ?? null,
          last_day: c.last_day ?? null,
        })),
        rows: (override ? [] : (r.rows ?? [])).map((x) => ({
          id: x.id,
          trip_code: x.trip_code,
          vehicle_no: x.vehicle_no,
          product_type: x.product_type,
          loaded_qty: num(x.loaded_qty),
          loading_date: x.loading_date,
          customer_name: x.customer_name,
          loading_point: x.loading_point,
          company: x.operating_company,
          invoice_no: x.iocl_invoice_no,
          created_at: x.created_at,
          source: x.source,
        })),
      };
    }, { day: null, is_today: false, email_count: 0, manual_count: 0, email_qty: 0,
         manual_qty: 0, last_entry_at: null, last_7d_count: 0, by_company: [], rows: [], last7: [],
         load_week_from: null, load_week_to: null, last7_loading: [], by_company_week: [],
         week_trips: [],
         ac4: { day: [], today_count: 0, today_qty: 0, week: [], error: null },
         sync: { checked_at: null, running: false, downloaded: null, mailboxes_failed: [], mailbox_detail: {},
                 insert_failed: 0, insert_errors: [], held_for_review: 0,
                 ac4_new: 0, ac4_failed: 0, second_invoice: 0 } });

    // ── UNLOADING, THE OTHER HALF OF THE TRIP ────────────────────────────────
    //
    // Loading had a panel and unloading had a number: "PENDING UNLOADING 137",
    // with no way to ask what those 137 are or how long they have been that
    // way. The answer turns out to matter more than the count. Of the 137, 80
    // were loaded MORE THAN THIRTY DAYS ago and the oldest is 01-04; the newest
    // unloading recorded anywhere in the table is 30-07. Trucks are not sitting
    // full for four months — unloading ENTRY stopped, and the trips stayed
    // IN_TRANSIT because nothing closes them.
    //
    // So this panel leads with age, not with a total. A count of 137 reads as
    // busy; "80 trips over 30 days, 2088 KL" reads as what it is.
    //
    // Unscoped, like loading_activity beside it: both answer "what is the state
    // of the register", not "what is this branch doing".
    const unloading_activity = await safe(errors, 'unloading_activity', async () => {
      const { rows } = await query(`
        WITH t AS (
          SELECT id, trip_code, vehicle_no, loading_date, unloading_date,
                 loading_point, unloading_location, consignee_name, product_type,
                 loaded_qty, unloaded_qty, shortage_qty, rtkm, driver_name, status,
                 COALESCE(operating_company, '(unassigned)') AS operating_company
            FROM trips
        ),
        pending AS (
          SELECT *, (CURRENT_DATE - loading_date) AS age_days
            FROM t WHERE status = 'IN_TRANSIT' AND unloading_date IS NULL
        ),
        -- Same fallback the loading week uses: anchor on the last day that had
        -- an unloading, because a window ending today is empty whenever entry
        -- has stopped -- and "empty" is exactly the state worth showing clearly.
        unload_target AS (
          SELECT COALESCE((SELECT max(unloading_date)::date FROM t WHERE unloading_date IS NOT NULL),
                          (now() AT TIME ZONE 'Asia/Kolkata')::date) AS day
        )
        SELECT
          (SELECT count(*)::int FROM pending)                              AS pending_count,
          (SELECT COALESCE(sum(loaded_qty), 0) FROM pending)               AS pending_qty,
          (SELECT max(unloading_date)::date FROM t)                        AS last_unload_day,
          (SELECT CURRENT_DATE - max(unloading_date)::date FROM t)         AS days_since_unload,
          (SELECT day FROM unload_target)                                  AS week_to,
          ((SELECT day FROM unload_target) - 6)                            AS week_from,

          -- Age buckets. Fixed edges rather than quantiles so the same trip does
          -- not change bucket because a different one was closed.
          COALESCE((SELECT json_agg(b ORDER BY b.sort)
                      FROM (SELECT CASE WHEN age_days <= 2 THEN 1 WHEN age_days <= 7 THEN 2
                                        WHEN age_days <= 15 THEN 3 WHEN age_days <= 30 THEN 4
                                        ELSE 5 END AS sort,
                                   CASE WHEN age_days <= 2 THEN '0-2 din' WHEN age_days <= 7 THEN '3-7 din'
                                        WHEN age_days <= 15 THEN '8-15 din' WHEN age_days <= 30 THEN '16-30 din'
                                        ELSE '30+ din' END AS label,
                                   count(*)::int AS trips,
                                   COALESCE(sum(loaded_qty), 0) AS qty
                              FROM pending GROUP BY 1, 2) b), '[]'::json)  AS pending_buckets,

          COALESCE((SELECT json_agg(c ORDER BY c.trips DESC)
                      FROM (SELECT operating_company AS company, count(*)::int AS trips,
                                   COALESCE(sum(loaded_qty), 0) AS qty,
                                   min(loading_date)::date AS oldest,
                                   max(age_days)::int AS oldest_days
                              FROM pending GROUP BY 1) c), '[]'::json)     AS pending_by_company,

          -- Oldest first: the top of this list is the work. Capped at 60 — the
          -- backlog is 137 today and an uncapped agg on a 30s poll is a bill
          -- nobody agreed to.
          COALESCE((SELECT json_agg(p ORDER BY p.age_days DESC, p.trip_code)
                      FROM (SELECT id, trip_code, vehicle_no, loading_date, loading_point,
                                   unloading_location, consignee_name, product_type,
                                   loaded_qty, rtkm, driver_name, operating_company, age_days
                              FROM pending ORDER BY age_days DESC, trip_code LIMIT 60) p),
                   '[]'::json)                                             AS pending_rows,

          -- The unloading week, on the unloading-date axis.
          COALESCE((SELECT json_agg(d ORDER BY d.day)
                      FROM (SELECT g::date AS day, count(x.id)::int AS trips,
                                   COALESCE(sum(x.unloaded_qty), 0) AS qty,
                                   COALESCE(sum(x.shortage_qty), 0) AS shortage
                              FROM unload_target,
                                   generate_series(unload_target.day - 6, unload_target.day,
                                                   interval '1 day') g
                              LEFT JOIN t x ON x.unloading_date::date = g::date
                             GROUP BY g::date) d), '[]'::json)             AS last7_unloading,

          COALESCE((SELECT json_agg(u ORDER BY u.unloading_date DESC, u.trip_code)
                      FROM (SELECT x.id, x.trip_code, x.vehicle_no, x.loading_date, x.unloading_date,
                                   x.loading_point, x.unloading_location, x.consignee_name,
                                   x.product_type, x.loaded_qty, x.unloaded_qty, x.shortage_qty,
                                   x.rtkm, x.driver_name, x.operating_company,
                                   (x.unloading_date - x.loading_date) AS transit_days
                              FROM t x, unload_target
                             WHERE x.unloading_date::date
                                   BETWEEN unload_target.day - 6 AND unload_target.day
                             ORDER BY x.unloading_date DESC, x.trip_code
                             LIMIT 200) u), '[]'::json)                    AS week_unloads`);

      const r = rows[0] || {};
      const mapTrip = (x) => ({
        id: x.id,
        trip_code: x.trip_code,
        vehicle_no: x.vehicle_no,
        loading_date: x.loading_date,
        unloading_date: x.unloading_date ?? null,
        from: x.loading_point,
        to: x.unloading_location || x.consignee_name,
        product_type: x.product_type,
        loaded_qty: num(x.loaded_qty),
        unloaded_qty: x.unloaded_qty == null ? null : num(x.unloaded_qty),
        shortage_qty: x.shortage_qty == null ? null : num(x.shortage_qty),
        rtkm: x.rtkm == null ? null : num(x.rtkm),
        driver_name: x.driver_name,
        company: x.operating_company,
        age_days: x.age_days == null ? null : num(x.age_days),
        transit_days: x.transit_days == null ? null : num(x.transit_days),
      });

      return {
        pending_count: num(r.pending_count),
        pending_qty: num(r.pending_qty),
        last_unload_day: r.last_unload_day ?? null,
        days_since_unload: r.days_since_unload == null ? null : num(r.days_since_unload),
        week_from: r.week_from ?? null,
        week_to: r.week_to ?? null,
        pending_buckets: (r.pending_buckets ?? []).map((b) => ({
          label: b.label, trips: num(b.trips), qty: num(b.qty),
        })),
        pending_by_company: (r.pending_by_company ?? []).map((c) => ({
          company: c.company, trips: num(c.trips), qty: num(c.qty),
          oldest: c.oldest ?? null, oldest_days: num(c.oldest_days),
        })),
        pending_rows: (r.pending_rows ?? []).map(mapTrip),
        last7_unloading: (r.last7_unloading ?? []).map((d) => ({
          day: d.day, trips: num(d.trips), qty: num(d.qty), shortage: num(d.shortage),
        })),
        week_unloads: (r.week_unloads ?? []).map(mapTrip),
      };
    }, { pending_count: 0, pending_qty: 0, last_unload_day: null, days_since_unload: null,
         week_from: null, week_to: null, pending_buckets: [], pending_by_company: [],
         pending_rows: [], last7_unloading: [], week_unloads: [] });

    const payload = {
      ok: true,
      generated_at: new Date().toISOString(),
      took_ms: Date.now() - t0,
      // Echoed back so the UI can label the page with what it actually applied,
      // rather than with what the user believes they selected.
      filter: F,
      ops: { ...fleet, doc_vault, fleet_vault, doc_history, pending_fees, drivers, trips_by_day, live_fleet, unloading_queue,
             vehicle_rtkm, shortage_recovery, compliance_alerts, dispatch_chats, dispatch_trips,
             loading_activity, unloading_activity },
      finance: { ...money, banks, groups, monthly, customers, ledger_book, book_totals, health, emi, toll, tally, unbilled_list, pnl },
      crm: { staff, activity, whatsapp, geo },
      // Non-empty means a card is showing a fallback, not a real figure.
      errors,
    };
    // A degraded payload (any per-card error) is not cached: serving a fallback
    // for six more seconds after the fault cleared is six seconds of wrong.
    if (!errors.length) {
      v5Cache.set(cacheKey, { at: Date.now(), payload });
      // Filter combinations are few, but an unbounded map is an unbounded map.
      if (v5Cache.size > 50) {
        const oldest = [...v5Cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        v5Cache.delete(oldest[0]);
      }
    }
    return payload;
  });

  // ── GET /api/v1/monitoring/live ─────────────────────────────────────────
  // The Boss view: who is signed in right now, and what they have actually
  // been doing. Separate from /dashboard/v5 on purpose — it polls faster than
  // the books need to, and it is admin-only, so folding it into the shared
  // dashboard payload would either leak it to every role or slow that payload
  // down for everyone.
  //
  // "Recent actions" reads audit_logs, not activity_logs: activity_logs is a
  // free-text note the SPA writes about itself and can simply forget to write,
  // while audit_logs is stamped server-side by a hook that every mutating route
  // passes through. Only writes that LANDED are shown (status < 400) — a
  // rejected request is an attempt, not an action, and mixing the two makes the
  // trail read like people changed things they did not.
  app.get('/monitoring/live', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) {
      return reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
    }
    const errors = [];
    const minutes = Math.min(Math.max(Number.parseInt(req.query?.minutes ?? '60', 10) || 60, 5), 1440);

    const sessions = await safe(errors, 'sessions', async () => {
      const { rows } = await query(`
        SELECT actor_name, actor_role, branch, email, ip, user_agent,
               issued_at, last_seen_at, is_online,
               EXTRACT(EPOCH FROM (now() - last_seen_at))::int AS idle_seconds
          FROM user_sessions
         ORDER BY is_online DESC, last_seen_at DESC
         LIMIT 50`);
      return rows.map((r) => ({
        name: r.actor_name,
        role: r.actor_role,
        branch: r.branch,
        email: r.email,
        ip: r.ip,
        // The full UA string is noise on a dashboard; the device class is not.
        device: /Android|iPhone|iPad|Mobile/i.test(r.user_agent ?? '') ? 'mobile' : 'desktop',
        since: r.issued_at,
        last_seen: r.last_seen_at,
        online: r.is_online,
        idle_seconds: r.idle_seconds,
      }));
    }, []);

    const actions = await safe(errors, 'actions', async () => {
      const { rows } = await query(`
        SELECT at, actor_name, actor_role, method, action, entity, entity_id,
               path, status_code, duration_ms,
               (before IS NOT NULL AND after IS NOT NULL) AS has_diff
          FROM audit_logs
         WHERE at > now() - ($1 || ' minutes')::interval
           AND status_code < 400
         ORDER BY at DESC
         LIMIT 60`, [String(minutes)]);
      return rows.map((r) => ({
        at: r.at,
        who: r.actor_name,
        role: r.actor_role,
        what: r.entity
          ? `${r.method} ${r.entity}${r.entity_id ? ` ${String(r.entity_id).slice(0, 8)}` : ''}`
          : `${r.method} ${r.path}`,
        status: r.status_code,
        ms: r.duration_ms,
        has_diff: r.has_diff,
      }));
    }, []);

    const totals = await safe(errors, 'totals', async () => {
      const { rows } = await query(`
        SELECT
          (SELECT count(*) FROM user_sessions WHERE is_online)                       AS online_now,
          (SELECT count(*) FROM user_sessions)                                       AS sessions_open,
          (SELECT count(*) FROM audit_logs
            WHERE at > now() - ($1 || ' minutes')::interval AND status_code < 400)   AS writes_window,
          (SELECT count(*) FROM audit_logs
            WHERE at > now() - ($1 || ' minutes')::interval AND status_code >= 400)  AS rejected_window`,
        [String(minutes)]);
      return {
        online_now: num(rows[0].online_now),
        sessions_open: num(rows[0].sessions_open),
        writes_window: num(rows[0].writes_window),
        rejected_window: num(rows[0].rejected_window),
      };
    }, { online_now: 0, sessions_open: 0, writes_window: 0, rejected_window: 0 });

    return { ok: true, generated_at: new Date().toISOString(), window_minutes: minutes, totals, sessions, actions, errors };
  });

  // ── GET /api/v1/monitoring/connected ────────────────────────────────────
  // "Who is connected to us right now, and what are they doing?"
  //
  // /monitoring/live answers this for STAFF. It cannot answer it for the outside
  // world, because v_user_sessions resolves a session to a NAME and not to a
  // PARTY: a VENDOR login showed the person and never which firm they speak for.
  // v_connected_parties (migration 105) makes the join the boards were missing —
  // driver, customer, partner or staff; which app; what they are carrying; and
  // the last real GPS fix if it is a driver.
  //
  // IT ALSO RETURNS WHO IS *NOT* HERE. A presence board that lists only the
  // connected cannot distinguish "nobody is working" from "nobody was ever given
  // a login", and those need opposite responses. 54 drivers can sign in with the
  // mobile already on their record and not one ever has; without `reach` the
  // driver app simply looks idle.
  //
  // Admin-only, like /monitoring/live: this names people, gives their mobile
  // number and puts them on a map.
  app.get('/monitoring/connected', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) {
      return reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
    }
    const errors = [];

    const parties = await safe(errors, 'parties', async () => {
      const { rows } = await query(`
        SELECT party_kind, party_id, party_name, person_name, mobile, role,
               app, device, ip, signed_in_at, last_seen_at, is_online, idle_seconds,
               trip_id, trip_code, vehicle_no, loading_point, unloading_location, activity,
               last_lat, last_lng, last_speed_kmh, last_fix_at, fix_age_seconds
          FROM v_connected_parties
         ORDER BY is_online DESC, last_seen_at DESC`);
      return rows.map((r) => ({
        kind: r.party_kind,
        id: r.party_id,
        // The organisation, and the human holding the phone when they differ.
        name: r.party_name,
        person: r.person_name && r.person_name !== r.party_name ? r.person_name : null,
        mobile: r.mobile,
        role: r.role,
        app: r.app,
        device: r.device,
        ip: r.ip,
        since: r.signed_in_at,
        last_seen: r.last_seen_at,
        online: r.is_online,
        idle_seconds: r.idle_seconds,
        activity: r.activity,
        trip: r.trip_code ? {
          id: r.trip_id, code: r.trip_code, vehicle: r.vehicle_no,
          from: r.loading_point, to: r.unloading_location,
        } : null,
        // Absent for everyone but the driver app, and absent for a driver whose
        // device has not reported. Never substituted with anything.
        position: r.last_lat != null && r.last_lng != null ? {
          lat: Number(r.last_lat), lng: Number(r.last_lng),
          speed_kmh: r.last_speed_kmh == null ? null : Number(r.last_speed_kmh),
          at: r.last_fix_at, age_seconds: r.fix_age_seconds,
        } : null,
      }));
    }, []);

    const reach = await safe(errors, 'reach', async () => {
      const { rows } = await query('SELECT * FROM v_portal_reach ORDER BY party_kind');
      return rows.map((r) => ({
        kind: r.party_kind,
        eligible: num(r.eligible),
        can_sign_in: num(r.can_sign_in),
        ever_signed_in: num(r.ever_signed_in),
        // The number worth acting on: people with a way in who have never used it.
        never_used: Math.max(num(r.can_sign_in) - num(r.ever_signed_in), 0),
      }));
    }, []);

    const totals = {
      connected: parties.length,
      online_now: parties.filter((p) => p.online).length,
      by_app: parties.reduce((a, p) => ({ ...a, [p.app]: (a[p.app] ?? 0) + 1 }), {}),
      tracking: parties.filter((p) => p.position).length,
    };

    // WHY the driver app is empty, not just THAT it is.
    //
    // A driver signs in with an OTP, and the OTP goes over WhatsApp. When that
    // engine is unlinked every driver login fails at /auth/otp/request with a
    // 503 before a code is ever sent — so "0 drivers connected" is not a fact
    // about drivers, it is a fact about the phone in the office. The board must
    // say which, because the two need completely different responses and look
    // identical from the outside.
    const login_channel = await safe(errors, 'login_channel', async () => {
      const ch = await otpChannel.available();
      return {
        name: ch.name ?? 'otp',
        ok: !!ch.ok,
        reason: ch.reason ?? null,
        // Drivers have no password path at all — OTP is their only door.
        blocks_driver_login: !ch.ok,
      };
    }, { name: 'otp', ok: false, reason: 'channel probe failed', blocks_driver_login: true });

    return { ok: true, generated_at: new Date().toISOString(), totals, parties, reach, login_channel, errors };
  });

  // ── GET /api/v1/monitoring/whatsapp ─────────────────────────────────────
  // The pairing screen for the OTP engine.
  //
  // On the office PC somebody could open the engine's own page. On a cloud box
  // there is no screen and the engine binds loopback with an unauthenticated
  // API, so it can never be published. This route is the only way to see the
  // code: admin-only, behind the same nginx TLS as the rest of the ERP.
  //
  // THE QR IS A CREDENTIAL, NOT A PICTURE. Whoever scans it becomes a linked
  // device on the company's WhatsApp account and can read every chat. So it is
  // returned as the raw string and rendered client-side by qrcode.react — never
  // handed to an external QR image service, which is how PublicWebsite draws
  // its (public, harmless) wa.me code and would be a giveaway here.
  app.get('/monitoring/whatsapp', { preHandler: requireAdminRole }, async (req, reply) => {
    const state = await otpChannel.linkStatus();
    return { ok: true, generated_at: new Date().toISOString(), ...state };
  });
}
