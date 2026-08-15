// server/modules/owners.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Vehicle-owner statements, in the shape the office actually needs.
//
// THE FACT THAT DRIVES THE WHOLE DESIGN: 15 of 49 trucks run loads under more
// than one operating company. One owner's fleet therefore earns money inside
// three separate sets of books, and "what do we owe Sandeep?" has no single
// answer — it has one answer per entity plus a total. That is why the statement
// comes back split by company AND consolidated, rather than as one number.
//
// ZERO BLEED. Every query filters on trips.company_id, which is a real foreign
// key resolved in migration 054 (872 of 872 trips carry one). Nothing here
// matches on operating_company text, because that column holds
// "M/S JAISWAL ENTERPRISE  " with trailing spaces and would quietly drop rows.
// Passing ?company_id= restricts to one entity; omitting it returns every
// entity separately — never merged into a single figure that hides which book a
// rupee belongs to.
//
// ALL MONEY ARITHMETIC HAPPENS IN SQL. pool.js returns NUMERIC as text so a
// 15-digit rupee value never round-trips through a JS float; summing in JS
// would reintroduce exactly the error that protects against.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

// Owners are identified by vehicles.owner_name today. vehicle_owner_ledger_id
// (migration 053) is the precise key and takes over automatically once owners
// are mapped to ledgers — until then, grouping on the name is what makes this
// usable against the data that actually exists.
const OWNER_KEY = `COALESCE(l.ledger_name, v.owner_name)`;

/** Per-trip cost roll-up, joined once and reused. Fuel and toll live in their
 *  own tables (541 fuel entries, toll_transactions) and MUST be aggregated
 *  before joining — joining them raw multiplies the freight by the number of
 *  fuel slips, which is the classic fan-out that silently inflates a
 *  statement. */
const TRIP_COSTS = `
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(f.amount), 0) AS fuel
      FROM fuel_entries f WHERE f.trip_id = t.id
  ) fu ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(sum(tx.amount), 0) AS toll
      FROM toll_transactions tx WHERE tx.trip_id = t.id
  ) tl ON true`;

// billed_amount is the real freight: 489 trips carry it and it totals
// 1,42,54,037.90, matching the books. freight_amount is populated on only 21
// rows, so it is a fallback, not the primary.
const GROSS = `COALESCE(NULLIF(t.billed_amount,0), t.freight_amount, 0)`;
const ADVANCES = `(COALESCE(t.pump_cash_advance,0) + COALESCE(t.office_cash_paid,0))`;

// Commission is per vehicle: a percentage of gross, or a flat amount per trip.
// Neither set means no commission agreed — which is a real arrangement for a
// family truck run at cost, not a missing value to guess at.
const COMMISSION = `
  CASE WHEN v.commission_flat IS NOT NULL THEN v.commission_flat
       WHEN v.commission_pct  IS NOT NULL THEN ${GROSS} * v.commission_pct / 100
       ELSE 0 END`;

function windowOf(q) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q?.from ?? '') ? q.from : null;
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q?.to ?? '') ? q.to : null;
  return { from, to };
}

export function registerOwnerRoutes(app) {
  // ── Who are the owners ────────────────────────────────────────────────────
  app.get('/owners', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`
      SELECT ${OWNER_KEY} AS owner,
             bool_or(NOT v.is_company_owned)      AS has_attached,
             count(*)::int                        AS trucks,
             count(*) FILTER (WHERE NOT v.is_company_owned)::int AS attached_trucks,
             max(v.vehicle_owner_ledger_id::text) AS owner_ledger_id
        FROM vehicles v
        LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
       WHERE COALESCE(l.ledger_name, v.owner_name) IS NOT NULL
       GROUP BY 1
       ORDER BY trucks DESC, owner`);
    return { count: rows.length, owners: rows };
  });

  // ── The statement ─────────────────────────────────────────────────────────
  // Returns three levels at once, because they are three views of one query and
  // the print layout needs all of them: per-entity totals (View B), per-vehicle
  // rows within each entity (the IOCL-style summary grid), and the itemised
  // trip log underneath it.
  app.get('/owners/statement', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const owner = String(req.query?.owner ?? '').trim();
    if (!owner) return reply.code(400).send({ error: 'MISSING_OWNER' });
    const companyId = req.query?.company_id || null;
    const { from, to } = windowOf(req.query);

    // One WHERE clause, shared by all three levels, so a row can never appear
    // in the vehicle grid but not the entity total.
    const where = `
      WHERE ${OWNER_KEY} = $1
        AND ($2::uuid IS NULL OR t.company_id = $2::uuid)
        AND ($3::date IS NULL OR t.loading_date >= $3::date)
        AND ($4::date IS NULL OR t.loading_date <= $4::date)`;
    const params = [owner, companyId, from, to];

    const byEntity = await query(`
      SELECT c.id AS company_id, c.company_name,
             count(t.id)::int                        AS trips,
             count(t.id) FILTER (WHERE ${GROSS} = 0)::int AS unbilled_trips,
             sum(${GROSS})::numeric(16,2)            AS gross_freight,
             sum(${COMMISSION})::numeric(16,2)       AS commission,
             sum(fu.fuel)::numeric(16,2)             AS fuel,
             sum(tl.toll)::numeric(16,2)             AS toll,
             sum(${ADVANCES})::numeric(16,2)         AS advances,
             sum(COALESCE(t.shortage_penalty,0))::numeric(16,2) AS shortage,
             (sum(${GROSS}) - sum(${COMMISSION}) - sum(fu.fuel) - sum(tl.toll)
              - sum(${ADVANCES}) - sum(COALESCE(t.shortage_penalty,0)))::numeric(16,2) AS net_payable
        FROM trips t
        JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
        JOIN companies c ON c.id = t.company_id
        ${TRIP_COSTS}
        ${where}
       GROUP BY c.id, c.company_name
       ORDER BY net_payable DESC`, params);

    const byVehicle = await query(`
      SELECT c.id AS company_id, c.company_name,
             v.vehicle_no,
             NOT v.is_company_owned                  AS is_attached,
             v.commission_pct, v.commission_flat,
             count(t.id)::int                        AS trips,
             count(t.id) FILTER (WHERE ${GROSS} = 0)::int AS unbilled_trips,
             sum(${GROSS})::numeric(16,2)            AS gross_freight,
             sum(${COMMISSION})::numeric(16,2)       AS commission,
             sum(fu.fuel)::numeric(16,2)             AS fuel,
             sum(tl.toll)::numeric(16,2)             AS toll,
             sum(${ADVANCES})::numeric(16,2)         AS advances,
             sum(COALESCE(t.shortage_penalty,0))::numeric(16,2) AS shortage,
             (sum(${GROSS}) - sum(${COMMISSION}) - sum(fu.fuel) - sum(tl.toll)
              - sum(${ADVANCES}) - sum(COALESCE(t.shortage_penalty,0)))::numeric(16,2) AS net_payable
        FROM trips t
        JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
        JOIN companies c ON c.id = t.company_id
        ${TRIP_COSTS}
        ${where}
       GROUP BY c.id, c.company_name, v.vehicle_no, v.is_company_owned, v.commission_pct, v.commission_flat
       ORDER BY c.company_name, v.vehicle_no`, params);

    // The itemised log. Capped: a two-year window on a 13-truck owner is
    // thousands of rows, and a print view that silently truncates is worse than
    // one that says it did.
    const LIMIT = 2000;
    const trips = await query(`
      SELECT t.loading_date, t.trip_code, t.challan_no, v.vehicle_no,
             c.company_name,
             t.loading_point, COALESCE(t.unloading_location, t.consignee_name) AS destination,
             t.product_type, t.loaded_qty, t.unloaded_qty, t.shortage_qty,
             ${GROSS}::numeric(16,2)      AS gross_freight,
             ${COMMISSION}::numeric(16,2) AS commission,
             fu.fuel::numeric(16,2)       AS fuel,
             tl.toll::numeric(16,2)       AS toll,
             ${ADVANCES}::numeric(16,2)   AS advances,
             COALESCE(t.shortage_penalty,0)::numeric(16,2) AS shortage,
             (SELECT string_agg(DISTINCT f.memo_no, ', ')
                FROM fuel_entries f WHERE f.trip_id = t.id AND f.memo_no IS NOT NULL) AS diesel_slips
        FROM trips t
        JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
        JOIN companies c ON c.id = t.company_id
        ${TRIP_COSTS}
        ${where}
       ORDER BY t.loading_date DESC NULLS LAST, t.trip_code
       LIMIT ${LIMIT + 1}`, params);

    const truncated = trips.rows.length > LIMIT;

    // Grand total across entities. Summed in SQL for the same reason as
    // everything else here.
    const grand = await query(`
      SELECT count(t.id)::int AS trips,
             count(t.id) FILTER (WHERE ${GROSS} = 0)::int AS unbilled_trips,
             COALESCE(sum(${GROSS}),0)::numeric(16,2)      AS gross_freight,
             COALESCE(sum(${COMMISSION}),0)::numeric(16,2) AS commission,
             COALESCE(sum(fu.fuel),0)::numeric(16,2)       AS fuel,
             COALESCE(sum(tl.toll),0)::numeric(16,2)       AS toll,
             COALESCE(sum(${ADVANCES}),0)::numeric(16,2)   AS advances,
             COALESCE(sum(COALESCE(t.shortage_penalty,0)),0)::numeric(16,2) AS shortage,
             COALESCE(sum(${GROSS}) - sum(${COMMISSION}) - sum(fu.fuel) - sum(tl.toll)
              - sum(${ADVANCES}) - sum(COALESCE(t.shortage_penalty,0)),0)::numeric(16,2) AS net_payable
        FROM trips t
        JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
        JOIN companies c ON c.id = t.company_id
        ${TRIP_COSTS}
        ${where}`, params);

    // A stable reference for the printed page. Derived from the arguments, so
    // reprinting the same window reproduces the same number instead of a new
    // one every time somebody hits print.
    const ref = `PT/OS/${owner.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase()}`
      + `/${(from ?? 'ALL').replace(/-/g, '')}-${(to ?? 'ALL').replace(/-/g, '')}`
      + (companyId ? `/${String(companyId).slice(0, 4).toUpperCase()}` : '/GRP');

    return {
      owner,
      scope: companyId ? 'ENTITY' : 'CONSOLIDATED',
      window: { from, to },
      statement_ref: ref,
      generated_at: new Date().toISOString(),
      by_entity: byEntity.rows,
      by_vehicle: byVehicle.rows,
      trips: trips.rows.slice(0, LIMIT),
      trips_truncated: truncated,
      trips_limit: LIMIT,
      grand_total: grand.rows[0],
    };
  });

  // ── Vehicle-wise profitability matrix ─────────────────────────────────────
  // Company-owned trucks show a profit; attached trucks show the commission we
  // earned, because their freight was never our revenue. The two are NOT
  // comparable as "profit", so the column is labelled by owner type and the
  // margin is computed against the figure that is actually ours in each case.
  app.get('/owners/profitability', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const companyId = req.query?.company_id || null;
    const { from, to } = windowOf(req.query);
    const { rows } = await query(`
      SELECT v.vehicle_no,
             CASE WHEN v.is_company_owned THEN 'OWNED' ELSE 'ATTACHED' END AS owner_type,
             COALESCE(l.ledger_name, v.owner_name) AS owner,
             count(t.id)::int                      AS trips,
             sum(${GROSS})::numeric(16,2)          AS gross_freight,
             sum(fu.fuel)::numeric(16,2)           AS fuel,
             sum(tl.toll)::numeric(16,2)           AS toll,
             sum(COALESCE(t.total_expense,0))::numeric(16,2) AS other_expense,
             sum(${ADVANCES})::numeric(16,2)       AS driver_expense,
             sum(${COMMISSION})::numeric(16,2)     AS commission,
             CASE WHEN v.is_company_owned
                  THEN (sum(${GROSS}) - sum(fu.fuel) - sum(tl.toll) - sum(${ADVANCES}))
                  ELSE sum(${COMMISSION})
             END::numeric(16,2)                    AS company_result,
             CASE WHEN sum(${GROSS}) > 0 THEN
               (CASE WHEN v.is_company_owned
                     THEN (sum(${GROSS}) - sum(fu.fuel) - sum(tl.toll) - sum(${ADVANCES}))
                     ELSE sum(${COMMISSION}) END) * 100 / sum(${GROSS})
             END::numeric(8,2)                     AS margin_pct
        FROM trips t
        JOIN vehicles v ON v.id = t.vehicle_id
        LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
        ${TRIP_COSTS}
       WHERE ($1::uuid IS NULL OR t.company_id = $1::uuid)
         AND ($2::date IS NULL OR t.loading_date >= $2::date)
         AND ($3::date IS NULL OR t.loading_date <= $3::date)
       GROUP BY v.vehicle_no, v.is_company_owned, COALESCE(l.ledger_name, v.owner_name)
       HAVING count(t.id) > 0
       ORDER BY company_result DESC NULLS LAST`, [companyId, from, to]);
    return { count: rows.length, rows };
  });

  // ── Filter options for the 3-tier bar ─────────────────────────────────────
  // One call so the bar can render fully populated instead of cascading three
  // round trips. Branches come back keyed by company, which is what makes the
  // second dropdown filter itself when the first changes.
  //
  // ONLY the three transport entities appear here, because only they exist in
  // this database. Jaiswal Capital Pvt Ltd is a separate trading company and is
  // deliberately not part of these books — nothing in this ERP should ever
  // offer it as a choice.
  app.get('/filters/options', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const companies = await query(
      `SELECT id, btrim(company_name) AS company_name FROM companies ORDER BY 2`);
    const branches = await query(`
      SELECT b.id, b.company_id, b.branch_name, b.branch_code, b.city
        FROM branches b WHERE b.status = 'ACTIVE' ORDER BY b.branch_name`);
    const owners = await query(`
      SELECT COALESCE(l.ledger_name, v.owner_name) AS owner,
             count(*)::int AS trucks,
             count(*) FILTER (WHERE NOT v.is_company_owned)::int AS attached_trucks
        FROM vehicles v
        LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
       WHERE COALESCE(l.ledger_name, v.owner_name) IS NOT NULL
       GROUP BY 1 ORDER BY trucks DESC, owner`);
    return {
      companies: companies.rows,
      branches: branches.rows,
      owners: owners.rows,
      fleet_types: [{ id: 'OWNED', label: 'Company Fleet' }, { id: 'ATTACHED', label: 'Attached Fleet' }],
    };
  });

  // ── Vehicle Owner Fleet Matrix ────────────────────────────────────────────
  // One row per owner: how big their fleet is, what it earned, what we deducted
  // and what is left to pay them. Honours the same 3-tier filter as the rest of
  // the dashboard so the matrix and the KPI cards can never disagree.
  app.get('/owners/matrix', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const companyId = req.query?.company_id || null;
    const branchId = req.query?.branch_id || null;
    const { from, to } = windowOf(req.query);
    const { rows } = await query(`
      SELECT ${OWNER_KEY} AS owner,
             count(DISTINCT v.id)::int                 AS trucks,
             count(DISTINCT v.id) FILTER (WHERE NOT v.is_company_owned)::int AS attached_trucks,
             count(t.id)::int                          AS trips,
             count(t.id) FILTER (WHERE t.status = 'IN_TRANSIT')::int AS active_trips,
             count(t.id) FILTER (WHERE ${GROSS} = 0)::int AS unbilled_trips,
             COALESCE(sum(${GROSS}),0)::numeric(16,2)      AS gross_freight,
             COALESCE(sum(${COMMISSION}),0)::numeric(16,2) AS commission,
             COALESCE(sum(fu.fuel),0)::numeric(16,2)       AS fuel,
             COALESCE(sum(tl.toll),0)::numeric(16,2)       AS toll,
             COALESCE(sum(${ADVANCES}),0)::numeric(16,2)   AS advances,
             COALESCE(sum(COALESCE(t.shortage_penalty,0)),0)::numeric(16,2) AS shortage,
             COALESCE(sum(fu.fuel) + sum(tl.toll) + sum(${ADVANCES})
                      + sum(COALESCE(t.shortage_penalty,0)),0)::numeric(16,2) AS deductions,
             COALESCE(sum(${GROSS}) - sum(${COMMISSION}) - sum(fu.fuel) - sum(tl.toll)
                      - sum(${ADVANCES}) - sum(COALESCE(t.shortage_penalty,0)),0)::numeric(16,2) AS net_payable
        FROM vehicles v
        LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id
        LEFT JOIN trips t ON t.vehicle_id = v.id
             AND ($1::uuid IS NULL OR t.company_id = $1::uuid)
             AND ($2::uuid IS NULL OR t.branch_id  = $2::uuid)
             AND ($3::date IS NULL OR t.loading_date >= $3::date)
             AND ($4::date IS NULL OR t.loading_date <= $4::date)
        ${TRIP_COSTS}
       WHERE COALESCE(l.ledger_name, v.owner_name) IS NOT NULL
       GROUP BY 1
       ORDER BY net_payable DESC`, [companyId, branchId, from, to]);
    return { count: rows.length, rows };
  });
}
