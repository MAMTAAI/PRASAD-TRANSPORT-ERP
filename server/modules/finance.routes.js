// server/modules/finance.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/finance — the live-PostgreSQL backend for the 2026 voucher modal and
// the Party Ledger Hub.
//
//   GET  /parties/search?q=        predictive search: customers ∪ vendors ∪
//                                  drivers ∪ bank/cash ledgers, with category
//                                  badge + live outstanding balance
//   GET  /party-context?kind=&id=  active trip, pending advance, unsettled fuel
//                                  slips — the auto-context panel
//   GET  /accounts                 bank/cash ledgers with live balances
//   POST /vouchers                 TARA's posting API (guards + DB constraint);
//                                  body.dry_run=true → full validation, rollback
//   GET  /tax/preview              TDS 194C/194Q + GST RCM computation
//   GET  /ledgers?q=               ledger hub table with live balances
//   GET  /ledgers/statement?name=  full statement + WhatsApp-ready text
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { computeTax } from '../lib/taxEngine.js';
import { drain } from '../agents/bus.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });

export async function registerFinanceRoutes(app) {
  // ── Predictive party search ───────────────────────────────────────────────
  app.get(
    '/parties/search',
    { schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 1, maxLength: 60 } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const q = `%${req.query.q}%`;
      // One UNION, one round trip. Balances: customers carry outstanding (Dr),
      // vendors carry payable (Cr), drivers = advances − recoveries (Dr),
      // ledgers = opening + ΣDr − ΣCr.
      const { rows } = await query(
        `(SELECT 'CUSTOMER' AS kind, id::text, customer_name AS name,
                 current_outstanding::numeric(14,2) AS balance, 'DR' AS balance_side,
                 'Sundry Debtors (Customers)' AS ledger_group
            FROM customers WHERE status='ACTIVE' AND customer_name ILIKE $1 LIMIT 6)
         UNION ALL
         (SELECT 'VENDOR', id::text, vendor_name,
                 current_balance::numeric(14,2), 'CR',
                 CASE WHEN vendor_type ILIKE '%fuel%' THEN 'Sundry Creditors (Fuel Pumps)' ELSE 'Sundry Creditors (Vendors)' END
            FROM vendors WHERE status='ACTIVE' AND (vendor_name ILIKE $1 OR vendor_type ILIKE $1) LIMIT 6)
         UNION ALL
         (SELECT 'DRIVER', d.id::text, d.name,
                 COALESCE((SELECT SUM(CASE WHEN t.txn_type='ADVANCE_GIVEN' THEN t.amount ELSE -t.amount END)
                             FROM driver_transactions t WHERE t.driver_id = d.id OR t.driver_name = d.name),0)::numeric(14,2),
                 'DR', 'Current Assets - Driver Advances'
            FROM drivers d WHERE d.status='ACTIVE' AND d.name ILIKE $1 LIMIT 6)
         UNION ALL
         (SELECT 'ACCOUNT', l.id::text, l.ledger_name,
                 (l.opening_balance
                  + COALESCE((SELECT SUM(CASE WHEN e.dr_cr='DR' THEN e.amount ELSE -e.amount END)
                                FROM ledger_entries e WHERE lower(e.ledger_name)=lower(l.ledger_name)),0))::numeric(14,2),
                 'DR', l.group_head
            FROM ledgers l
           WHERE (l.group_head IN ('Bank Accounts','Cash-in-Hand') OR l.ledger_name ILIKE '%cash%' OR l.ledger_name ILIKE '%bank%')
             AND l.ledger_name ILIKE $1 LIMIT 4)`,
        [q]
      );
      return { results: rows };
    }
  );

  // ── Auto-context for the selected party ───────────────────────────────────
  app.get(
    '/party-context',
    {
      schema: {
        querystring: {
          type: 'object', required: ['kind', 'id'],
          properties: { kind: { type: 'string', enum: ['CUSTOMER', 'VENDOR', 'DRIVER', 'ACCOUNT'] }, id: { type: 'string' } },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { kind, id } = req.query;
      const ctx = { kind, id };

      if (kind === 'DRIVER') {
        const d = await query(`SELECT name FROM drivers WHERE id = $1::uuid`, [id]).then((r) => r.rows[0]);
        if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
        const [trip, advance, fuel] = await Promise.all([
          query(`SELECT id, trip_code, vehicle_no, status, loading_date, customer_name
                   FROM trips WHERE driver_id = $1::uuid AND status IN ('LOADED','IN_TRANSIT','UNLOADING')
                  ORDER BY loading_date DESC NULLS LAST LIMIT 1`, [id]),
          query(`SELECT COALESCE(SUM(CASE WHEN txn_type='ADVANCE_GIVEN' THEN amount ELSE -amount END),0)::numeric(14,2) AS pending
                   FROM driver_transactions WHERE driver_id = $1::uuid OR driver_name = $2`, [id, d.name]),
          query(`SELECT f.id, f.entry_date, f.vehicle_no, f.memo_no, f.liters, f.amount, f.vendor_name
                   FROM fuel_entries f
                   JOIN trips t ON t.id = f.trip_id
                  WHERE t.driver_id = $1::uuid AND COALESCE(f.bill_status,'') NOT IN ('SETTLED','PAID')
                  ORDER BY f.entry_date DESC LIMIT 5`, [id]),
        ]);
        ctx.driver_name = d.name;
        ctx.active_trip = trip.rows[0] ?? null;
        ctx.pending_advance = advance.rows[0].pending;
        ctx.unsettled_fuel_slips = fuel.rows;
      } else if (kind === 'VENDOR') {
        const v = await query(`SELECT vendor_name, vendor_type, gst_no, current_balance FROM vendors WHERE id = $1::uuid`, [id]).then((r) => r.rows[0]);
        if (!v) return reply.code(404).send({ error: 'NOT_FOUND' });
        const fuel = await query(
          `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS unbilled, count(*)::int AS slips
             FROM fuel_entries WHERE vendor_id = $1::uuid AND COALESCE(bill_status,'') NOT IN ('SETTLED','PAID')`, [id]);
        Object.assign(ctx, v, { unsettled_fuel: fuel.rows[0] });
        // 15-char GSTIN check surfaces master-data defects right in the modal.
        if (v.gst_no && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{2}$/.test(String(v.gst_no).toUpperCase())) {
          ctx.warnings = [`vendor GSTIN '${v.gst_no}' is malformed (${String(v.gst_no).length} chars) — fix the vendor master`];
        }
      } else if (kind === 'CUSTOMER') {
        const c = await query(
          `SELECT customer_name, current_outstanding, payment_terms,
                  (SELECT count(*)::int FROM trips t WHERE t.customer_id = customers.id AND t.status='COMPLETED') AS unsettled_trips
             FROM customers WHERE id = $1::uuid`, [id]).then((r) => r.rows[0]);
        if (!c) return reply.code(404).send({ error: 'NOT_FOUND' });
        Object.assign(ctx, c);
      }
      return ctx;
    }
  );

  // ── Dashboard summary ─────────────────────────────────────────────────────
  // Everything the Finance Hub renders, in one round trip, derived from the
  // ledger rather than recomputed in the browser. The old Dashboard.tsx pulled
  // seven Firestore collections and summed them client-side, which is why it
  // could show ₹8.39 L of revenue while the book held ₹1.42 Cr — it was adding
  // up a different database.
  //
  // All figures are voucher-era. Legacy migrated rows are reported separately
  // by /health rather than blended in, because they predate double entry and
  // averaging them into a P&L would misstate it.
  app.get(
    '/dashboard',
    { schema: { querystring: { type: 'object', properties: { months: { type: 'integer', minimum: 1, maximum: 36 } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const months = req.query.months ?? 6;

      const [pl, groups, banks, debtors, creditors, trend, health, ops] = await Promise.all([
        query(`SELECT account_type, SUM(amount)::numeric(14,2) AS amount
                 FROM v_profit_and_loss GROUP BY account_type`),
        query(`SELECT group_head, account_type, amount FROM v_profit_and_loss
                WHERE amount <> 0 ORDER BY sort_order`),
        query(`SELECT ledger_name, group_head, balance_dr::numeric(14,2) AS balance
                 FROM v_ledger_balances
                WHERE group_head IN ('Bank Accounts','Cash-in-Hand')
                ORDER BY group_head, ledger_name`),
        query(`SELECT ledger_name, balance_dr::numeric(14,2) AS balance
                 FROM v_ledger_balances
                WHERE account_type = 'ASSET' AND group_head = 'Sundry Debtors (Customers)'
                  AND balance_dr <> 0
                ORDER BY balance_dr DESC LIMIT 12`),
        query(`SELECT ledger_name, (-balance_dr)::numeric(14,2) AS balance
                 FROM v_ledger_balances
                WHERE group_head = 'Sundry Creditors (Vendors)' AND balance_dr <> 0
                ORDER BY balance_dr ASC LIMIT 12`),
        query(`SELECT to_char(date_trunc('month', e.entry_date), 'YYYY-MM') AS month,
                      SUM(CASE WHEN e.account_type='INCOME'  AND e.dr_cr='CR' THEN e.amount
                               WHEN e.account_type='INCOME'  AND e.dr_cr='DR' THEN -e.amount ELSE 0 END)::numeric(14,2) AS income,
                      SUM(CASE WHEN e.account_type='EXPENSE' AND e.dr_cr='DR' THEN e.amount
                               WHEN e.account_type='EXPENSE' AND e.dr_cr='CR' THEN -e.amount ELSE 0 END)::numeric(14,2) AS expense
                 FROM v_ledger_entries_resolved e
                WHERE NOT e.is_legacy
                  AND e.entry_date >= date_trunc('month', CURRENT_DATE) - ($1::int - 1) * INTERVAL '1 month'
                GROUP BY 1 ORDER BY 1`, [months]),
        query('SELECT * FROM v_accounting_health'),
        query(`SELECT
                 (SELECT count(*)::int FROM trips WHERE status IN ('LOADED','IN_TRANSIT','UNLOADING')) AS trips_running,
                 (SELECT count(*)::int FROM trips WHERE payment_status = 'UNBILLED'
                     AND status IN ('COMPLETED','SETTLED')) AS trips_unbilled,
                 (SELECT count(*)::int FROM vehicles WHERE status = 'ACTIVE') AS vehicles_active,
                 (SELECT count(*)::int FROM drivers  WHERE status = 'ACTIVE') AS drivers_active,
                 (SELECT COALESCE(SUM(gross_amt),0)::numeric(14,2) FROM iocl_recon_matches
                   WHERE match_status <> 'MATCHED') AS unreconciled_freight,
                 (SELECT count(*)::int FROM iocl_recon_matches WHERE match_status <> 'MATCHED') AS unreconciled_loads`),
      ]);

      const byType = Object.fromEntries(pl.rows.map((r) => [r.account_type, Number(r.amount)]));
      const income = byType.INCOME ?? 0;
      const expense = byType.EXPENSE ?? 0;
      const cash = banks.rows.reduce((s, b) => s + Number(b.balance), 0);
      const receivable = debtors.rows.reduce((s, d) => s + Number(d.balance), 0);
      const payable = creditors.rows.reduce((s, c) => s + Number(c.balance), 0);

      return {
        generated_at: new Date().toISOString(),
        source: 'postgres',
        kpi: {
          revenue: income,
          expenses: expense,
          net_profit: income - expense,
          receivable,
          payable,
          cash_and_bank: cash,
        },
        pl_groups: groups.rows,
        accounts: banks.rows,
        top_debtors: debtors.rows,
        top_creditors: creditors.rows,
        trend: trend.rows,
        operations: ops.rows[0],
        health: health.rows[0],
      };
    }
  );

  // ── Accounting health ─────────────────────────────────────────────────────
  app.get('/health/accounting', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query('SELECT * FROM v_accounting_health');
    const h = rows[0];
    const failures = Object.entries(h)
      .filter(([k, v]) => k !== 'merged_aliases' && Number(v) !== 0)
      .map(([k, v]) => `${k}=${v}`);
    reply.code(failures.length ? 409 : 200);
    return { ok: failures.length === 0, failures, ...h };
  });

  // ── Report filters ────────────────────────────────────────────────────────
  // Every reporting screen asks a period-and-company question, so the three
  // statements share one querystring shape. The bounded forms are SQL functions
  // (migration 020/021) rather than filtered-in-JS views: profit must have a
  // single definition, or the P&L and the balance sheet start disagreeing.
  const REPORT_QS = {
    type: 'object',
    properties: {
      from:    { type: ['string', 'null'], format: 'date' },
      to:      { type: ['string', 'null'], format: 'date' },
      company: { type: ['string', 'null'], maxLength: 120 },
    },
  };
  const bounds = (q) => [q.from || null, q.to || null, q.company || null];

  // ── Trial balance ─────────────────────────────────────────────────────────
  app.get('/reports/trial-balance', { schema: { querystring: REPORT_QS } }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM f_trial_balance($1::date, $2::date, $3::text)
        WHERE dr <> 0 OR cr <> 0 ORDER BY sort_order`, bounds(req.query));
    return {
      rows,
      totals: rows.reduce((a, r) => ({
        dr: a.dr + Number(r.dr), cr: a.cr + Number(r.cr),
        dr_voucher_era: a.dr_voucher_era + Number(r.dr_voucher_era),
        cr_voucher_era: a.cr_voucher_era + Number(r.cr_voucher_era),
      }), { dr: 0, cr: 0, dr_voucher_era: 0, cr_voucher_era: 0 }),
    };
  });

  // ── Profit & loss (period) ────────────────────────────────────────────────
  app.get('/reports/profit-and-loss', { schema: { querystring: REPORT_QS } }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT group_head, account_type, sort_order, amount
         FROM f_profit_and_loss($1::date, $2::date, $3::text)
        WHERE amount <> 0 ORDER BY sort_order`, bounds(req.query));
    const sum = (t) => rows.filter((r) => r.account_type === t)
      .reduce((a, r) => a + Number(r.amount), 0);
    const income = sum('INCOME'), expense = sum('EXPENSE');
    return {
      period: { from: req.query.from ?? null, to: req.query.to ?? null, company: req.query.company ?? null },
      income:   rows.filter((r) => r.account_type === 'INCOME'),
      expenses: rows.filter((r) => r.account_type === 'EXPENSE'),
      total_income: income.toFixed(2),
      total_expense: expense.toFixed(2),
      net_profit: (income - expense).toFixed(2),
      // A ratio is undefined on zero revenue; null says so instead of showing 0%.
      margin_pct: income > 0 ? (((income - expense) / income) * 100).toFixed(2) : null,
    };
  });

  // ── Balance sheet (as on a date) ──────────────────────────────────────────
  // Cumulative by nature, so only `to` applies — equity is retained earnings,
  // not one period's result. `from` is accepted and ignored for a uniform
  // querystring; the period result is what /reports/profit-and-loss reports.
  //
  // `balanced` is returned explicitly rather than left for the caller to work
  // out: a balance sheet that does not foot must announce itself. Cutting the
  // ledger at a date can genuinely not foot — the voucher era balances at every
  // cut, but the migrated single-entry history nets to zero only once all of it
  // is included. `legacy_imbalance` names that amount so the screen can explain
  // the difference instead of just displaying a broken total.
  app.get('/reports/balance-sheet', { schema: { querystring: REPORT_QS } }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const asOn = req.query.to || null;
    const company = req.query.company || null;
    const [rows, split] = await Promise.all([
      query(`SELECT group_head, account_type, amount, side
               FROM f_balance_sheet($1::date, $2::text) ORDER BY side, sort_order`, [asOn, company]),
      query(`SELECT COALESCE(SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END)
                              FILTER (WHERE voucher_id IS NOT NULL), 0)::numeric(14,2) AS voucher_imbalance,
                    COALESCE(SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END)
                              FILTER (WHERE voucher_id IS NULL), 0)::numeric(14,2) AS legacy_imbalance
               FROM ledger_entries
              WHERE ($1::date IS NULL OR entry_date <= $1::date)
                AND ($2::text IS NULL OR company_matches(company, $2::text))`, [asOn, company]),
    ]);
    const assets = rows.rows.filter((r) => r.side === 'ASSETS');
    const liabs  = rows.rows.filter((r) => r.side === 'LIABILITIES_AND_EQUITY');
    const total = (xs) => xs.reduce((a, r) => a + Number(r.amount), 0);
    const ta = total(assets), tl = total(liabs);
    return {
      as_on: asOn, company,
      assets, liabilities_and_equity: liabs,
      total_assets: ta.toFixed(2),
      total_liabilities_equity: tl.toFixed(2),
      difference: (ta - tl).toFixed(2),
      balanced: Math.abs(ta - tl) < 0.01,
      voucher_imbalance: split.rows[0].voucher_imbalance,
      legacy_imbalance: split.rows[0].legacy_imbalance,
    };
  });

  // ── Bank/Cash accounts with live balances ─────────────────────────────────
  app.get('/accounts', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT l.ledger_name, l.group_head,
              (l.opening_balance
               + COALESCE((SELECT SUM(CASE WHEN e.dr_cr='DR' THEN e.amount ELSE -e.amount END)
                             FROM ledger_entries e WHERE lower(e.ledger_name)=lower(l.ledger_name)),0))::numeric(14,2) AS balance
         FROM ledgers l
        WHERE l.group_head IN ('Bank Accounts','Cash-in-Hand')
        ORDER BY l.group_head, l.ledger_name`);
    return { accounts: rows };
  });

  // ── Voucher posting (TARA) ────────────────────────────────────────────────
  app.post(
    '/vouchers',
    {
      schema: {
        body: {
          type: 'object', required: ['type'], additionalProperties: false,
          properties: {
            type: { type: 'string', enum: ['RECEIPT', 'PAYMENT', 'CONTRA', 'JOURNAL'] },
            // JOURNAL only: explicit legs. ΣDr must equal ΣCr — checked by TARA
            // in integer paise and again by the deferred DB constraint.
            lines: {
              type: 'array', minItems: 2, maxItems: 200,
              items: {
                type: 'object', required: ['ledger', 'dr_cr', 'amount'], additionalProperties: false,
                properties: {
                  ledger: { type: 'string', maxLength: 120 },
                  dr_cr: { type: 'string', enum: ['DR', 'CR'] },
                  amount: { type: 'number', exclusiveMinimum: 0 },
                  group: { type: ['string', 'null'], maxLength: 60 },
                },
              },
            },
            source_type: { type: ['string', 'null'], maxLength: 40 },
            party_ledger: { type: 'string', maxLength: 120 },
            party_group: { type: 'string', maxLength: 60 },
            account: { type: 'string', maxLength: 120 },
            to_account: { type: 'string', maxLength: 120 },
            amount: { type: 'number', exclusiveMinimum: 0, maximum: 100_000_000 },
            ref_no: { type: ['string', 'null'], maxLength: 60 },
            narration: { type: ['string', 'null'], maxLength: 500 },
            entry_date: { type: ['string', 'null'], format: 'date' },
            company: { type: ['string', 'null'], maxLength: 120 },
            branch: { type: ['string', 'null'], maxLength: 60 },
            created_by: { type: ['string', 'null'], maxLength: 100 },
            tds: { type: ['object', 'null'], properties: { ledger: { type: 'string' }, amount: { type: 'number', minimum: 0 } } },
            dry_run: { type: 'boolean' },
          },
        },
      },
    },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      try {
        const out = await postVoucher(req.body);
        if (out.posted) await drain().catch(() => {});
        reply.code(out.posted ? 201 : 200);
        return out;
      } catch (err) {
        // TARA's guards → structured 4xx the modal can show inline, not a 500.
        const map = { DUPLICATE_REF: 409, OVERDRAFT: 422, BAD_TYPE: 400, BAD_AMOUNT: 400, NO_ACCOUNT: 400, NO_PARTY: 400, BAD_CONTRA: 400, BAD_TDS: 400, BAD_LINES: 400, UNBALANCED: 422 };
        if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message, balance: err.balance });
        throw err;
      }
    }
  );

  // ── Tax preview ───────────────────────────────────────────────────────────
  app.get(
    '/tax/preview',
    {
      schema: {
        querystring: {
          type: 'object', required: ['amount'],
          properties: {
            amount: { type: 'number', exclusiveMinimum: 0 },
            section: { type: 'string', enum: ['194C', '194Q', 'none'] },
            has_pan: { type: 'boolean', default: true },
            deductee_type: { type: 'string', enum: ['INDIVIDUAL', 'COMPANY'], default: 'COMPANY' },
            fy_aggregate: { type: 'number', minimum: 0, default: 0 },
            transporter_declaration: { type: 'boolean', default: false },
            gta_rcm: { type: 'boolean', default: false },
          },
        },
      },
    },
    async (req) => computeTax({
      amount: req.query.amount,
      section: req.query.section === 'none' ? null : req.query.section ?? null,
      hasPan: req.query.has_pan,
      deducteeType: req.query.deductee_type,
      fyAggregate: req.query.fy_aggregate,
      transporterDeclaration: req.query.transporter_declaration,
      gtaReverseCharge: req.query.gta_rcm,
    })
  );

  // ── Ledger hub ────────────────────────────────────────────────────────────
  app.get(
    '/ledgers',
    { schema: { querystring: { type: 'object', properties: { q: { type: 'string', maxLength: 60 }, limit: { type: 'integer', minimum: 1, maximum: 300, default: 100 } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT l.ledger_name, l.group_head, l.company, l.branch, l.opening_balance,
                COALESCE(e.dr,0)::numeric(14,2) AS total_dr, COALESCE(e.cr,0)::numeric(14,2) AS total_cr,
                (l.opening_balance + COALESCE(e.dr,0) - COALESCE(e.cr,0))::numeric(14,2) AS balance,
                COALESCE(e.entries,0)::int AS entries, e.last_entry
           FROM ledgers l
           LEFT JOIN LATERAL (
             SELECT SUM(amount) FILTER (WHERE dr_cr='DR') dr, SUM(amount) FILTER (WHERE dr_cr='CR') cr,
                    count(*) entries, max(entry_date) last_entry
               FROM ledger_entries WHERE lower(ledger_name)=lower(l.ledger_name)
           ) e ON true
          WHERE ($1::text IS NULL OR l.ledger_name ILIKE '%'||$1||'%' OR l.group_head ILIKE '%'||$1||'%')
          ORDER BY abs(l.opening_balance + COALESCE(e.dr,0) - COALESCE(e.cr,0)) DESC
          LIMIT $2`,
        [req.query.q ?? null, req.query.limit ?? 100]
      );
      return { count: rows.length, data: rows };
    }
  );

  app.get(
    '/ledgers/statement',
    { schema: { querystring: { type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 120 }, limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const name = req.query.name;
      const { rows } = await query(
        `SELECT entry_date, particulars, dr_cr, amount, source_type, source_ref, voucher_id
           FROM ledger_entries WHERE lower(ledger_name)=lower($1)
          ORDER BY entry_date DESC, id DESC LIMIT $2`, [name, req.query.limit ?? 100]);
      const { rows: [tot] } = await query(
        `SELECT COALESCE((SELECT opening_balance FROM ledgers WHERE lower(ledger_name)=lower($1) LIMIT 1),0) AS opening,
                COALESCE(SUM(amount) FILTER (WHERE dr_cr='DR'),0) AS dr,
                COALESCE(SUM(amount) FILTER (WHERE dr_cr='CR'),0) AS cr
           FROM ledger_entries WHERE lower(ledger_name)=lower($1)`, [name]);
      const balance = (Number(tot.opening) + Number(tot.dr) - Number(tot.cr)).toFixed(2);

      // WhatsApp-ready text — MATANGI's channel formats it the same way.
      const lines = rows.slice(0, 15).map((e) =>
        `${e.entry_date} ${e.dr_cr === 'DR' ? '▲' : '▼'} ₹${e.amount} — ${String(e.particulars ?? '').slice(0, 40)}`);
      const waText = encodeURIComponent(
        `*PRASAD TRANSPORT — Ledger Statement*\n*${name}*\n\n${lines.join('\n')}\n\n*Closing balance: ₹${balance} ${Number(balance) >= 0 ? 'Dr' : 'Cr'}*\n_System generated · ${new Date().toISOString().slice(0, 10)}_`);

      return { ledger: name, opening: tot.opening, total_dr: tot.dr, total_cr: tot.cr, balance, entries: rows, whatsapp_text: waText };
    }
  );
}
