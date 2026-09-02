// server/lib/drilldownRegistry.js
// ─────────────────────────────────────────────────────────────────────────────
// One definition per dashboard number: the rows, and the total OVER those rows.
//
// THE FAILURE THIS EXISTS TO PREVENT. The obvious way to build "click a number,
// see the rows behind it" is to write a second query for the detail. Then the
// card says 52 and the drawer lists 51, and the drawer is believed, because it
// looks like evidence. A drill-down that disagrees with its own headline is
// worse than no drill-down at all -- it launders a wrong number into a verified
// one.
//
// So a metric declares its ROW query and nothing else. The headline count is
// computed by wrapping that same query:
//
//     SELECT count(*), sum(_measure) FROM ( <the row query> ) d
//
// The count is therefore the number of rows the drawer would list, by
// construction rather than by agreement. There is no second predicate that can
// drift, because there is no second predicate.
//
// The dashboard's own cards still run their own SQL, so _selfcheck compares the
// two and reports any metric where they disagree. See drilldown.routes.js.
//
// PARAMETER POSITIONS ARE FIXED AT $1..$4 -- company, branch, owner, fleet --
// exactly as in dashboard.routes.js, so the same array serves every metric and
// "filter by owner" cannot quietly become "filter by branch".

// Predicate over `trips t` JOIN `vehicles v`. Kept character-identical to
// TRIP_F in dashboard.routes.js: if these two ever diverge, _selfcheck fails
// loudly, which is the point.
//
// The join to vehicles is LEFT for the reason recorded in dashboard.routes.js:
// 27 trips carry vehicle_id NULL, and an INNER join silently drops them.
const TRIP_F = `
  AND ($1::uuid IS NULL OR t.company_id = $1::uuid)
  AND ($2::uuid IS NULL OR t.branch_id  = $2::uuid)
  AND ($3::text IS NULL OR v.owner_name = $3::text)
  AND ($4::text IS NULL OR (CASE WHEN v.is_company_owned THEN 'OWNED' ELSE 'ATTACHED' END) = $4::text)`;

const VEHICLE_F = `
  AND ($3::text IS NULL OR v.owner_name = $3::text)
  AND ($4::text IS NULL OR (CASE WHEN v.is_company_owned THEN 'OWNED' ELSE 'ATTACHED' END) = $4::text)`;

// Every metric is executed with the same four-element parameter array, but not
// every metric uses all four. PostgreSQL refuses a statement carrying a
// parameter it cannot type ("could not determine data type of parameter $1"),
// so the unused positions are given a always-true guard that types them and
// changes no rows. Cheaper than maintaining a different array per metric and
// getting the ORDER wrong once.
const typeOnly = (...ns) =>
  ns.map((n) => `AND ($${n}::${n <= 2 ? 'uuid' : 'text'} IS NULL OR TRUE)`).join('\n  ');

/**
 * A metric.
 *  from/where/select/order   the ROW query, in pieces
 *  filter                    'TRIP' | 'VEHICLE' | 'NONE'
 *  measure                   SQL expression summed for the money total, or null
 *  headline                  dotted path into /dashboard/v5 that this must equal
 *  link                      how a row opens its own record
 */
export const METRICS = {
  // ── MARKET FLEET — the Command Deck's tiles (2-Sep-2026) ──────────────────
  // filter NONE: a bazaar load carries no company / branch / owner / fleet,
  // so the four positional parameters are typed and ignored. The count the
  // deck shows is the count of these rows, by construction, like every other
  // metric here. No `headline`: /dashboard/v5 is the OWN fleet's payload and
  // has nothing to compare against — _selfcheck reports RUNS_OK.
  'market.loads_open': {
    hub: 'market', label: 'Loads on the board', unit: 'loads',
    from: 'bazaar_loads l',
    where: "l.status IN ('OPEN', 'PENDING_REVIEW')",
    filter: 'NONE',
    select: `l.load_id AS id, l.load_id, l.status, l.customer_name, l.origin, l.destination,
             l.material, l.weight, l.vehicle_type, l.loading_date, l.target_rate, l.book_now_rate,
             l.bid_close_at,
             (SELECT count(*) FROM bazaar_bids b WHERE b.load_id = l.load_id AND b.status = 'PENDING')::int AS live_bids,
             (SELECT min(b.bid_amount) FROM bazaar_bids b WHERE b.load_id = l.load_id AND b.status = 'PENDING') AS l1_amount,
             l.posted_by, l.created_at`,
    order: 'l.created_at DESC',
    measure: null,
    link: { module: 'OPERATION', screen: 'BAZAAR_ADMIN', idField: 'id', labelField: 'load_id' },
  },

  'market.award_requests': {
    hub: 'market', label: 'Award requests — desk decides', unit: 'requests',
    from: 'bazaar_loads l LEFT JOIN bazaar_bids b ON b.id = l.award_requested_bid_id',
    where: "l.status = 'AWARD_REQUESTED'",
    filter: 'NONE',
    select: `l.load_id AS id, l.load_id, l.customer_name, l.origin, l.destination, l.material, l.loading_date,
             l.award_requested_by AS requested_by, l.award_requested_at AS requested_at,
             b.vendor_name, b.bid_amount, b.remarks, l.target_rate, l.book_now_rate`,
    order: 'l.award_requested_at NULLS LAST',
    measure: null,
    link: { module: 'OPERATION', screen: 'BAZAAR_ADMIN', idField: 'id', labelField: 'load_id' },
  },

  'market.settlements_open': {
    hub: 'market', label: 'Settlements in progress', unit: 'INR',
    from: `bazaar_settlements s
             LEFT JOIN vendors v ON v.id = s.vendor_id
             LEFT JOIN bazaar_loads l ON l.load_id = s.load_id
             LEFT JOIN market_vehicles mv ON mv.id = s.market_vehicle_id
             LEFT JOIN companies co ON co.id = s.company_id`,
    where: "s.status NOT IN ('SETTLED', 'CANCELLED')",
    filter: 'NONE',
    select: `s.id::text AS id, s.load_id, s.status, v.vendor_name, mv.registration_no,
             l.origin, l.destination, l.customer_name,
             s.awarded_amount, s.advance_pct, s.advance_amount, s.balance_amount, s.deposit_amount,
             co.company_name AS firm, s.confirm_deadline, s.vendor_confirmed_at,
             s.pod_submitted_at, s.pod_verified_at, s.created_at`,
    order: 's.created_at DESC',
    measure: 's.awarded_amount',
    link: { module: 'OPERATION', screen: 'BAZAAR_ADMIN', idField: 'load_id', labelField: 'load_id' },
  },

  'market.fleet': {
    hub: 'market', label: 'Market fleet — partner trucks', unit: 'trucks',
    from: `market_vehicles mv
             LEFT JOIN vendors v ON v.id = mv.vendor_id
             LEFT JOIN market_drivers md ON md.id = mv.market_driver_id`,
    where: 'TRUE',
    filter: 'NONE',
    select: `mv.id::text AS id, mv.registration_no, mv.vendor_agency, mv.system_status,
             mv.vehicle_class, mv.capacity, COALESCE(md.name, mv.driver_name) AS driver, mv.driver_mobile,
             v.mobile_no AS partner_mobile, mv.rc_expiry, mv.ins_expiry, mv.fit_expiry, mv.puc_expiry,
             mv.np_expiry, mv.reject_reason, mv.approved_at, mv.created_at`,
    order: "(mv.system_status = 'PENDING APPROVAL') DESC, mv.created_at DESC",
    measure: null,
    link: { module: 'OPERATION', screen: 'MARKET_VEHICLE', idField: 'id', labelField: 'registration_no' },
  },

  // ── OPERATIONS ────────────────────────────────────────────────────────────
  'ops.active_trips': {
    hub: 'ops', label: 'Active Trips', unit: 'trips',
    headline: 'ops.active_trips',
    from: 'trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id',
    where: "t.status = 'IN_TRANSIT'",
    filter: 'TRIP',
    select: `t.id::text AS id, t.trip_code, t.vehicle_no, t.driver_name,
             t.product_type, t.loading_date, t.loading_point,
             COALESCE(t.unloading_location, t.consignee_name) AS destination,
             t.loaded_qty, t.status`,
    order: 't.loading_date DESC NULLS LAST',
    measure: null,
    link: { module: 'OPERATION', screen: 'TRIP', idField: 'id', labelField: 'trip_code' },
  },

  'ops.pending_unloading': {
    hub: 'ops', label: 'Pending Unloading', unit: 'trips',
    headline: 'ops.pending_unloading',
    from: 'trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id',
    where: "t.status = 'IN_TRANSIT' AND t.unloading_date IS NULL",
    filter: 'TRIP',
    select: `t.id::text AS id, t.trip_code, t.vehicle_no, t.driver_name,
             t.product_type, t.loading_date, t.loading_point,
             COALESCE(t.unloading_location, t.consignee_name) AS destination,
             t.loaded_qty,
             CASE WHEN t.loading_date > DATE '2000-01-01'
                  THEN (CURRENT_DATE - t.loading_date)::int END AS days_out`,
    order: 't.loading_date ASC NULLS LAST',
    measure: null,
    link: { module: 'OPERATION', screen: 'SETTLEMENT', idField: 'id', labelField: 'trip_code' },
  },

  'ops.fleet_size': {
    hub: 'ops', label: 'Fleet Size', unit: 'vehicles',
    headline: 'ops.fleet_size',
    from: 'vehicles v',
    // Character-for-character the dashboard's own company rule: a vehicle has
    // no company column, so it belongs to a company by having run a trip for it.
    where: `v.status = 'ACTIVE'
            AND ($1::uuid IS NULL OR EXISTS (
                  SELECT 1 FROM trips t WHERE t.vehicle_id = v.id AND t.company_id = $1::uuid))`,
    filter: 'VEHICLE',
    extraTyping: [2],
    select: `v.id::text AS id, v.vehicle_no, v.owner_name,
             CASE WHEN v.is_company_owned THEN 'OWNED' ELSE 'ATTACHED' END AS fleet,
             v.vehicle_type, v.capacity_kl, v.payload_mt, v.status,
             v.insurance_expiry, v.fitness_expiry, v.permit_expiry, v.puc_expiry`,
    order: 'v.vehicle_no',
    measure: null,
    link: { module: 'OPERATION', screen: 'VEHICLE', idField: 'id', labelField: 'vehicle_no' },
  },

  'ops.drivers_active': {
    hub: 'ops', label: 'Active Drivers', unit: 'drivers',
    headline: 'ops.drivers_active',
    from: 'drivers d',
    where: "d.status = 'ACTIVE'",
    filter: 'NONE',
    select: `d.id::text AS id, d.name AS driver_name, d.mobile, d.license_no,
             d.license_expiry, d.hzd_expiry, d.status`,
    order: 'd.name',
    measure: null,
    link: { module: 'OPERATION', screen: 'DRIVER', idField: 'id', labelField: 'driver_name' },
  },

  // ── FINANCE ───────────────────────────────────────────────────────────────
  'finance.unbilled': {
    hub: 'finance', label: 'Unbilled Freight', unit: 'INR',
    headline: 'finance.unbilled_freight',
    // The card sums freight over ALL unbilled trips; unbilled_list is capped at
    // 25 rows for display. The drawer is not capped, which is the whole point.
    from: 'trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id',
    // NO status filter -- this mirrors the `money` query exactly. The
    // unbilled_list preview below the card DOES filter to
    // ('COMPLETED','UNLOADING','IN_TRANSIT'), so the card and its own list have
    // never described the same set. Reproducing the card is the correct choice
    // here: a drawer opened from a number must explain THAT number. Whether the
    // card should exclude CANCELLED trips is a separate decision, and not one
    // to make silently inside a drill-down.
    where: 'COALESCE(t.billed_amount,0) = 0',
    filter: 'TRIP',
    select: `t.id::text AS id, t.trip_code, t.vehicle_no, t.customer_name,
             t.loading_date, t.status,
             COALESCE(NULLIF(t.freight_amount,0),0)::numeric(14,2) AS freight_amount,
             CASE WHEN t.loading_date > DATE '2000-01-01'
                  THEN (CURRENT_DATE - t.loading_date)::int END AS age_days`,
    order: 't.loading_date ASC NULLS LAST',
    measure: 'COALESCE(NULLIF(t.freight_amount,0),0)',
    link: { module: 'ACCOUNTS', screen: 'BILLING', idField: 'id', labelField: 'trip_code' },
  },

  'finance.toll_spent': {
    hub: 'finance', label: 'Toll Spent', unit: 'INR',
    headline: 'finance.toll.spent_total',
    from: 'toll_transactions tt',
    where: 'TRUE',
    filter: 'NONE',
    select: `tt.id::text AS id, tt.txn_date, tt.vehicle_no, tt.plaza_name,
             tt.amount, tt.claim_status, tt.provider, tt.ext_txn_id`,
    order: 'tt.txn_date DESC NULLS LAST',
    measure: 'tt.amount',
    link: { module: 'OPERATION', screen: 'TOLL', idField: 'id', labelField: 'ext_txn_id' },
  },

  'finance.toll_unclaimed': {
    hub: 'finance', label: 'Toll Unclaimed', unit: 'INR',
    headline: 'finance.toll.unclaimed',
    from: 'toll_transactions tt',
    where: "(tt.claim_status <> 'CLAIMED' OR tt.claim_status IS NULL)",
    filter: 'NONE',
    select: `tt.id::text AS id, tt.txn_date, tt.vehicle_no, tt.plaza_name,
             tt.amount, tt.claim_status, tt.provider`,
    order: 'tt.txn_date DESC NULLS LAST',
    measure: 'tt.amount',
    link: { module: 'OPERATION', screen: 'TOLL', idField: 'id', labelField: 'plaza_name' },
  },

  'finance.loans': {
    hub: 'finance', label: 'Loans Outstanding', unit: 'INR',
    from: 'loan_master lm',
    where: 'lm.bank_name IS NOT NULL',
    filter: 'NONE',
    // remaining_principal is a known-stale denormalised column; it is shown
    // because the EMI card sums exactly this, and a drill-down must reproduce
    // its own headline. v_loan_reconciliation is the trustworthy figure.
    select: `lm.id::text AS id, lm.bank_name, lm.loan_account_no, lm.vehicle_no,
             lm.principal_amt, lm.remaining_principal, lm.emi_amount,
             lm.emis_completed, lm.tenure_months, lm.sanction_date`,
    order: 'lm.remaining_principal DESC NULLS LAST',
    measure: 'COALESCE(lm.remaining_principal,0)',
    link: { module: 'ACCOUNTS', screen: 'LOAN', idField: 'id', labelField: 'loan_account_no' },
  },

  'finance.ledger_entries': {
    hub: 'finance', label: 'Ledger Entries', unit: 'INR',
    from: 'ledger_entries le',
    where: 'TRUE',
    filter: 'NONE',
    select: `le.id::text AS id, le.entry_date, le.voucher_id::text AS voucher_id, le.source_ref, le.ledger_name,
             le.dr_cr, le.amount, le.particulars, le.created_at`,
    order: 'le.created_at DESC',
    measure: 'le.amount',
    link: { module: 'ACCOUNTS', screen: 'LEDGER', idField: 'id', labelField: 'source_ref' },
  },

  // ── CRM ───────────────────────────────────────────────────────────────────
  'crm.staff': {
    hub: 'crm', label: 'Active Staff', unit: 'people',
    // No headline: the CRM hub lists the 8 most recent staff, it does not show
    // an active-staff COUNT anywhere. Claiming a headline that does not exist
    // would make _selfcheck compare against undefined and report a permanent
    // false mismatch, which is how a red light gets ignored.
    from: 'users u',
    where: "u.status = 'ACTIVE'",
    filter: 'NONE',
    select: `u.id::text AS id, u.full_name, u.email, u.role, u.status, u.last_login_at`,
    order: 'u.role, u.full_name',
    measure: null,
    link: { module: 'ACCOUNTS', screen: 'ONBOARDING', idField: 'id', labelField: 'full_name' },
  },

  'crm.whatsapp': {
    hub: 'crm', label: 'WhatsApp Messages', unit: 'messages',
    headline: 'crm.whatsapp.total',
    from: 'wa_chats w',
    where: 'TRUE',
    filter: 'NONE',
    select: `w.id::text AS id, w.ts, w.direction, w.phone, w.sent_by_user_name, w.role, w.text`,
    order: 'w.ts DESC',
    measure: null,
    link: { module: 'CRM', screen: 'WHATSAPP', idField: 'id', labelField: 'phone' },
  },

  'ops.shortage': {
    hub: 'ops', label: 'Driver Shortage', unit: 'INR',
    from: `trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
           LEFT JOIN LATERAL (
             SELECT COALESCE(sum(dt.amount),0) AS recovered
               FROM driver_transactions dt
              WHERE dt.trip_id = t.id AND dt.txn_type = 'SHORTAGE_RECOVERY') rec ON true`,
    where: 'COALESCE(t.shortage_penalty,0) > 0',
    filter: 'TRIP',
    // Trip-wise, not driver-wise. The panel groups by driver; the audit question
    // is always "which trip", because that is the row somebody has to go and fix.
    select: `t.id::text AS id, t.trip_code, t.driver_name, t.vehicle_no,
             t.loading_date, t.shortage_qty, t.shortage_penalty,
             rec.recovered,
             (COALESCE(t.shortage_penalty,0) - rec.recovered) AS still_owed`,
    order: '(COALESCE(t.shortage_penalty,0) - rec.recovered) DESC, t.loading_date DESC',
    measure: 'COALESCE(t.shortage_penalty,0)',
    link: { module: 'OPERATION', screen: 'SETTLEMENT', idField: 'id', labelField: 'trip_code' },
  },

  'ops.doc_expiry': {
    hub: 'ops', label: 'Expiring Documents', unit: 'documents',
    // The view the compliance panel already reads, with the same threshold
    // function -- not a reimplementation of "soon".
    from: 'v_compliance_alerts ca',
    where: 'ca.expires_on - CURRENT_DATE <= compliance_alert_days()',
    filter: 'NONE',
    select: `ca.subject, ca.subject_kind, ca.owner_name, ca.doc_type,
             COALESCE(ca.doc_name, ca.doc_type) AS doc_name,
             ca.expires_on, (ca.expires_on - CURRENT_DATE)::int AS days_left, ca.source`,
    order: 'ca.expires_on ASC',
    measure: null,
    link: null,
  },

  'finance.customers': {
    hub: 'finance', label: 'Customer Freight', unit: 'INR',
    from: 'trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id',
    where: 'COALESCE(t.freight_amount,0) <> 0',
    filter: 'TRIP',
    select: `t.id::text AS id, COALESCE(NULLIF(t.customer_name,''),'UNKNOWN') AS customer_name,
             t.trip_code, t.vehicle_no, t.loading_date, t.freight_amount,
             t.billed_amount, t.status`,
    order: 't.freight_amount DESC NULLS LAST',
    measure: 'COALESCE(t.freight_amount,0)',
    link: { module: 'ACCOUNTS', screen: 'BILLING', idField: 'id', labelField: 'trip_code' },
  },

  'finance.ledger_book': {
    hub: 'finance', label: 'Ledger Book', unit: 'INR',
    from: 'ledgers l JOIN ledger_entries e ON e.ledger_id = l.id',
    where: 'TRUE',
    filter: 'NONE',
    select: `e.id::text AS id, e.entry_date, l.ledger_name, l.group_head,
             e.dr_cr, e.amount, e.source_ref, e.particulars`,
    order: 'e.entry_date DESC NULLS LAST, e.created_at DESC',
    measure: 'e.amount',
    link: { module: 'ACCOUNTS', screen: 'LEDGER', idField: 'id', labelField: 'source_ref' },
  },
};

/** Build the row-level SQL for a metric. This is the ONLY query definition. */
export function rowSql(m) {
  const frag =
    m.filter === 'TRIP' ? TRIP_F
      : m.filter === 'VEHICLE' ? VEHICLE_F + '\n  ' + typeOnly(...(m.extraTyping ?? [1, 2]))
        : typeOnly(1, 2, 3, 4);

  const measure = m.measure ? `,\n             ${m.measure} AS _measure` : '';
  return `SELECT ${m.select}${measure}
            FROM ${m.from}
           WHERE ${m.where}
           ${frag}`;
}

/**
 * Count and money total, computed BY WRAPPING the row query.
 * This is what makes the drawer and the headline the same number.
 */
export function totalsSql(m) {
  return `SELECT count(*)::int AS n,
                 ${m.measure ? 'COALESCE(sum(d._measure),0)::text' : 'NULL'} AS total
            FROM (${rowSql(m)}) d`;
}

export function pagedSql(m) {
  return `${rowSql(m)}
           ORDER BY ${m.order}
           LIMIT $5::int OFFSET $6::int`;
}

export const metricKeys = () => Object.keys(METRICS);
export const getMetric = (k) => METRICS[k] ?? null;
