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
import { periodBounds, previousOf, PERIODS } from '../lib/periods.js';

const num = (v) => (v == null ? 0 : Number(v));

/** One compliance alert, flattened for the client. */
const mapAlert = (r) => ({
  kind: r.subject_kind, subject: r.subject, owner: r.owner_name,
  doc_type: r.doc_type, doc_name: r.doc_name,
  expires_on: r.expires_on, days: num(r.days), source: r.source,
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
          FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
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

  app.get('/dashboard/v5', async (req, reply) => {
    if (isDegraded()) {
      return reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
    }
    const errors = [];
    const t0 = Date.now();

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
          (SELECT count(*) FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
            WHERE t.status = 'IN_TRANSIT' ${TRIP_F})                                 AS active_trips,
          (SELECT count(*) FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
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
               expires_on, (expires_on - CURRENT_DATE)::int AS days, source
          FROM v_compliance_alerts
         WHERE expires_on - CURRENT_DATE <= compliance_alert_days()
         ORDER BY expires_on ASC
         LIMIT 60`);
      // Proof the background sweep is alive. An empty list means "nothing
      // expires soon" AND "the job died three weeks ago" — this tells them apart.
      const { rows: run } = await query(`
        SELECT ran_on, threshold_days, checked, expired, expiring
          FROM compliance_alert_runs ORDER BY ran_on DESC LIMIT 1`);
      return {
        threshold_days: 10,
        expired: rows.filter((r) => r.days < 0).map(mapAlert),
        expiring: rows.filter((r) => r.days >= 0).map(mapAlert),
        last_sweep: run[0] ?? null,
      };
    }, { threshold_days: 10, expired: [], expiring: [], last_sweep: null });

    const drivers = await safe(errors, 'drivers', async () => {
      const { rows } = await query(`
        SELECT name, license_expiry, hzd_expiry,
               (license_expiry - CURRENT_DATE) AS dl_days,
               (hzd_expiry     - CURRENT_DATE) AS hzd_days
        FROM drivers
        WHERE status = 'ACTIVE' AND (license_expiry IS NOT NULL OR hzd_expiry IS NOT NULL)
        ORDER BY LEAST(COALESCE(license_expiry,'9999-12-31'::date),
                       COALESCE(hzd_expiry,'9999-12-31'::date)) ASC
        LIMIT 6`);
      return rows.map((r) => ({
        name: r.name, dl_days: r.dl_days == null ? null : num(r.dl_days),
        hzd_days: r.hzd_days == null ? null : num(r.hzd_days),
      }));
    }, []);

    const trips_by_day = await safe(errors, 'trips_by_day', async () => {
      const { rows } = await query(`
        SELECT to_char(d.day,'Dy') AS label, COALESCE(t.n,0) AS trips
        FROM generate_series(CURRENT_DATE - 6, CURRENT_DATE, '1 day') AS d(day)
        LEFT JOIN (SELECT t.loading_date::date AS day, count(*) AS n
                     FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
                    WHERE t.loading_date >= CURRENT_DATE - 6 ${TRIP_F}
                    GROUP BY 1) t ON t.day = d.day
        ORDER BY d.day`, P);
      return rows.map((r) => ({ day: String(r.label).trim(), trips: num(r.trips) }));
    }, []);

    const live_fleet = await safe(errors, 'live_fleet', async () => {
      const { rows } = await query(`
        SELECT t.vehicle_no, t.loading_point, t.unloading_location, t.status, t.product_type,
               t.driver_name, t.loading_date, t.unloading_date
        FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
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
          FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
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
          FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
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
            JOIN vehicles v ON v.id = t.vehicle_id
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
        FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
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
          FROM trips t JOIN vehicles v ON v.id = t.vehicle_id
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
      const { rows } = await query(`
        SELECT ledger_name, COALESCE(current_balance,0) AS bal
        FROM ledgers
        WHERE group_head ILIKE '%Bank%' OR group_head ILIKE '%Cash%' OR group_head ILIKE '%Wallet%'
        ORDER BY COALESCE(current_balance,0) DESC LIMIT 8`);
      return rows.map((r) => ({ name: r.ledger_name, balance: num(r.bal) }));
    }, []);

    const groups = await safe(errors, 'group_totals', async () => {
      const { rows } = await query(`
        SELECT group_head, COALESCE(SUM(current_balance),0) AS bal, count(*) AS n
        FROM ledgers GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
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
               count(*) FILTER (WHERE direction = 'IN')::int                        AS inbound,
               count(*) FILTER (WHERE direction = 'OUT')::int                       AS outbound,
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

    return {
      ok: true,
      generated_at: new Date().toISOString(),
      took_ms: Date.now() - t0,
      // Echoed back so the UI can label the page with what it actually applied,
      // rather than with what the user believes they selected.
      filter: F,
      ops: { ...fleet, doc_vault, drivers, trips_by_day, live_fleet, unloading_queue,
             vehicle_rtkm, shortage_recovery, compliance_alerts },
      finance: { ...money, banks, groups, monthly, customers, ledger_book, book_totals, health, emi, toll, tally, unbilled_list, pnl },
      crm: { staff, activity, whatsapp, geo },
      // Non-empty means a card is showing a fallback, not a real figure.
      errors,
    };
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
}
