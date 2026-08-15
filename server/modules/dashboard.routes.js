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

const num = (v) => (v == null ? 0 : Number(v));

/** Run one aggregate; on failure record it and hand back a fallback. */
async function safe(errors, label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return fallback;
  }
}

export function registerDashboardRoutes(app) {
  app.get('/dashboard/v5', async (req, reply) => {
    if (isDegraded()) {
      return reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
    }
    const errors = [];
    const t0 = Date.now();

    // ── OPERATIONS ──────────────────────────────────────────────────────────
    const fleet = await safe(errors, 'fleet_counts', async () => {
      const { rows } = await query(`
        SELECT
          (SELECT count(*) FROM vehicles WHERE status = 'ACTIVE')                    AS fleet_size,
          (SELECT count(*) FROM trips    WHERE status = 'IN_TRANSIT')                AS active_trips,
          (SELECT count(*) FROM trips    WHERE status = 'IN_TRANSIT'
                                           AND unloading_date IS NULL)               AS pending_unloading,
          (SELECT count(*) FROM drivers  WHERE status = 'ACTIVE')                    AS drivers_active`);
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
        LEFT JOIN (SELECT loading_date::date AS day, count(*) AS n FROM trips
                   WHERE loading_date >= CURRENT_DATE - 6 GROUP BY 1) t ON t.day = d.day
        ORDER BY d.day`);
      return rows.map((r) => ({ day: String(r.label).trim(), trips: num(r.trips) }));
    }, []);

    const live_fleet = await safe(errors, 'live_fleet', async () => {
      const { rows } = await query(`
        SELECT vehicle_no, loading_point, unloading_location, status, product_type,
               driver_name, loading_date
        FROM trips
        WHERE status = 'IN_TRANSIT'
        ORDER BY loading_date DESC NULLS LAST
        LIMIT 8`);
      return rows.map((r) => ({
        vehicle: r.vehicle_no || '-',
        route: `${r.loading_point || '?'} -> ${r.unloading_location || '?'}`,
        status: r.unloading_date ? 'Unloading' : 'En Route',
        product: r.product_type || '',
        driver: r.driver_name || '',
      }));
    }, []);

    // ── FINANCE ─────────────────────────────────────────────────────────────
    const money = await safe(errors, 'money', async () => {
      const { rows } = await query(`
        SELECT
          COALESCE(SUM(freight_amount) FILTER (WHERE COALESCE(billed_amount,0) = 0), 0) AS unbilled_freight,
          COALESCE(SUM(billed_amount), 0)                                              AS freight_income,
          COALESCE(SUM(received_amount), 0)                                            AS received,
          COALESCE(SUM(total_expense), 0)                                              AS total_expense,
          COALESCE(SUM(tds_amount), 0)                                                 AS tds
        FROM trips`);
      const r = rows[0];
      return {
        unbilled_freight: num(r.unbilled_freight), freight_income: num(r.freight_income),
        received: num(r.received), total_expense: num(r.total_expense), tds: num(r.tds),
      };
    }, { unbilled_freight: 0, freight_income: 0, received: 0, total_expense: 0, tds: 0 });

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

    const health = await safe(errors, 'accounting_health', async () => {
      const { rows } = await query('SELECT * FROM v_accounting_health');
      return rows[0] ?? null;
    }, null);

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
      ops: { ...fleet, doc_vault, drivers, trips_by_day, live_fleet },
      finance: { ...money, banks, groups, monthly, customers, ledger_book, book_totals, health, emi, toll },
      crm: { staff, activity },
      // Non-empty means a card is showing a fallback, not a real figure.
      errors,
    };
  });
}
