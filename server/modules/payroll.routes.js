// server/modules/payroll.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// HR & PAYROLL (migration 174) — /api/v1/payroll
//
//   GET  /overview                          per firm: models, open settlements, ready for disbursal, staff
//   POST /audit                             deep audit: settle every open trip, khata vs ledger, report
//   PATCH /drivers/:id/pay                  compensation model (TRIP / MONTHLY), basis, rate, salary, recovery %, paying firm
//   GET  /drivers/:id/desk                  one driver: pay config, khata, instant settlements, monthly lines
//   GET  /trip-settlements?firm&status&driver  the instant settlements (BLOCKED / DRAFT / POSTED / PAID)
//   POST /trip-settlements/:id/post         Approve & Post: Dr wages / Cr korki heads / Cr Driver Payable (TARA journal)
//   POST /trip-settlements/:id/pay          PAYMENT from a cash/bank ledger → PAID (khata FINAL_PAYMENT mirror)
//   POST /trip-settlements/:id/recompute · /cancel
//   GET  /runs?firm&kind · POST /runs/build {firm, period, kind} · GET /runs/:id
//   PATCH /runs/:id/lines/:lineId           edit gross / other deduction / skip
//   POST /runs/:id/post                     Approve & Post the whole run (one journal per line)
//   POST /runs/:id/pay                      pay every posted line from one ledger (or {line_ids})
//   GET  /staff · POST /staff · PATCH /staff/:id · POST /staff/:id/txn   staff & partner master, advances, drawings
//   GET  /disbursal?firm                    everything posted and unpaid (the Cash & Bank Book strip)
//   POST /disbursal/pay                     {source, ref_id, account, paid_on} — same as the per-item pay
//   GET  /accounts?firm                     cash / bank ledgers with balances, for the pay dialog
// Money moves only through TARA's postVoucher; nothing here writes a ledger line itself.
// ─────────────────────────────────────────────────────────────────────────────
import { query, withTransaction } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';
import { prepareMonth, renderSlips, slipText } from '../lib/monthEnd.js';
import { notifyWhatsApp } from '../lib/notify.js';

/** A stand-in reply for calling a route's core from another route (month-end). */
const mkReply = () => { const r = { statusCode: 200, body: null, code(c) { r.statusCode = c; return r; }, send(b) { r.body = b; return r; } }; return r; };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const WAGES_LEDGER = 'Driver Wages & Trip Pay';
const WAGES_GROUP = 'Direct Expenses - Driver & Trip';
const PAYABLE_GROUP = 'Salaries & Wages Payable';
const ADVANCE_GROUP = 'Current Assets - Driver Advances';
const SHORTAGE_LEDGER = 'Shortage Recovery (Drivers)';
const SHORTAGE_GROUP = 'Shortage & Penalty';
const STAFF_SALARY_LEDGER = 'Salaries - Office Staff';
const INDIRECT_GROUP = 'Indirect Expenses';
const payableLedgerOf = (kind, name) => (kind === 'DRIVER' ? `Driver Payable: ${name}` : kind === 'PARTNER' ? `Remuneration Payable: ${name}` : `Salary Payable: ${name}`);

export async function registerPayrollRoutes(app) {
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };
  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';
  const bad = (reply, code, detail) => reply.code(400).send({ error: code, detail });
  const accountOk = async (name) => (await query(`SELECT ledger_name FROM ledgers WHERE ledger_name = $1 AND group_head IN ('Bank Accounts','Cash-in-Hand')`, [name])).rows.length > 0;

  // ── overview / audit ──────────────────────────────────────────────────
  app.get('/overview', staff, async () => {
    const { rows: firms } = await query(`SELECT * FROM v_payroll_overview ORDER BY company_name`);
    const { rows: [last] } = await query(`SELECT ran_at, ran_by, summary FROM payroll_audit_runs ORDER BY ran_at DESC LIMIT 1`);
    const { rows: blocked } = await query(`SELECT block_reason, count(*)::int AS n, sum(earning)::numeric(14,2) AS earning FROM driver_trip_settlements WHERE status = 'BLOCKED' GROUP BY 1 ORDER BY 2 DESC`);
    const { rows: unconfigured } = await query(`SELECT d.id, d.name, d.mobile, (SELECT count(*)::int FROM trips t WHERE driver_of_trip(t.id) = d.id AND t.status IN ('COMPLETED','SETTLED') AND t.loading_date >= DATE '2026-04-01') AS trips_fy, driver_khata_balance(d.id, d.name)::numeric(14,2) AS khata
                                                 FROM drivers d WHERE d.pay_model IS NULL AND d.status::text = 'ACTIVE' ORDER BY trips_fy DESC, d.name`);
    return { today: new Date().toISOString().slice(0, 10), firms, blocked, unconfigured, last_audit: last ?? null };
  });
  app.post('/audit', admin, async (req) => ({ summary: (await query(`SELECT payroll_deep_audit($1) AS s`, [actor(req)])).rows[0].s }));

  app.get('/accounts', staff, async (req) => {
    const firm = UUID_RE.test(req.query.firm ?? '') ? req.query.firm : null;
    const { rows } = await query(`SELECT l.ledger_name, l.group_head, l.company, coalesce((SELECT sum(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END) FROM ledger_entries e WHERE e.ledger_name = l.ledger_name), 0)::numeric(14,2) AS balance
                                    FROM ledgers l WHERE l.group_head IN ('Bank Accounts','Cash-in-Hand') AND l.status::text <> 'INACTIVE'
                                      AND ($1::uuid IS NULL OR l.company IS NULL OR btrim(l.company) = (SELECT company_name FROM companies WHERE id = $1::uuid))
                                    ORDER BY l.group_head, l.ledger_name`, [firm]);
    return { rows };
  });

  // ── driver compensation ───────────────────────────────────────────────
  app.patch('/drivers/:id/pay', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'driver id');
    const b = req.body ?? {};
    if (!['TRIP', 'MONTHLY'].includes(b.pay_model)) return bad(reply, 'BAD_MODEL', 'pay_model must be TRIP (instant settlement) or MONTHLY (fixed salary)');
    const mode = b.trip_rate_mode ?? 'ROUTE';
    if (!['ROUTE', 'PER_TRIP', 'PCT_FREIGHT', 'PER_KM'].includes(mode)) return bad(reply, 'BAD_BASIS', 'trip_rate_mode');
    const rate = num(b.trip_rate); const salary = num(b.monthly_salary); const pct = b.shortage_recovery_pct === undefined ? 100 : num(b.shortage_recovery_pct);
    if (b.pay_model === 'TRIP' && mode !== 'ROUTE' && !(rate > 0)) return bad(reply, 'RATE_REQUIRED', `${mode} needs a rate above zero`);
    if (b.pay_model === 'MONTHLY' && !(salary > 0)) return bad(reply, 'SALARY_REQUIRED', 'a monthly salary above zero is required');
    if (mode === 'PCT_FREIGHT' && rate > 50) return bad(reply, 'BAD_RATE', 'a freight share above 50% is not a driver rate');
    if (!(pct >= 0 && pct <= 100)) return bad(reply, 'BAD_PCT', 'shortage recovery must be 0–100%');
    const firm = UUID_RE.test(b.pay_company_id ?? '') ? b.pay_company_id : null;
    const { rows: [d] } = await query(`UPDATE drivers SET pay_model = $2, trip_rate_mode = $3, trip_rate = $4, monthly_salary = $5, shortage_recovery_pct = $6, pay_company_id = $7, pay_notes = $8, pay_configured_by = $9, pay_configured_at = now(), updated_at = now()
                                        WHERE id = $1::uuid RETURNING id, name, pay_model, trip_rate_mode, trip_rate, monthly_salary, shortage_recovery_pct, pay_company_id, pay_notes`,
      [id, b.pay_model, mode, rate, salary, pct, firm, b.pay_notes ?? null, actor(req)]);
    if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { rows: [rs] } = await query(`SELECT driver_resettle_open($1::uuid) AS n`, [id]);
    return { driver: d, resettled: rs.n };
  });

  app.get('/drivers/:id/desk', staff, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'driver id');
    const { rows: [d] } = await query(`SELECT d.id, d.name, d.mobile, d.pay_model, d.trip_rate_mode, d.trip_rate, d.monthly_salary, d.shortage_recovery_pct, d.pay_company_id, d.pay_notes, d.pay_configured_by, d.pay_configured_at,
                                              driver_khata_balance(d.id, d.name)::numeric(14,2) AS khata_balance, c.company_name AS pay_company,
                                              cv.vehicle_no AS current_vehicle, cv.ownership::text AS vehicle_ownership, cv.owner_name
                                         FROM drivers d LEFT JOIN companies c ON c.id = d.pay_company_id
                                         LEFT JOIN LATERAL (SELECT v.vehicle_no, v.ownership, v.owner_name FROM vehicle_assignments va JOIN vehicles v ON v.id = va.vehicle_id WHERE va.driver_id = d.id AND va.released_at IS NULL ORDER BY va.assigned_at DESC LIMIT 1) cv ON true
                                         WHERE d.id = $1::uuid`, [id]);
    if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { rows: settlements } = await query(`SELECT * FROM driver_trip_settlements WHERE driver_id = $1::uuid OR (driver_id IS NULL AND norm_person_name(driver_name) = norm_person_name($2)) ORDER BY completed_at DESC NULLS LAST, created_at DESC LIMIT 200`, [id, d.name]);
    const { rows: lines } = await query(`SELECT l.*, r.period, r.run_no, r.status AS run_status FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.person_kind = 'DRIVER' AND l.person_id = $1::uuid ORDER BY r.period DESC`, [id]);
    const { rows: txns } = await query(`SELECT dt.id, dt.txn_date, dt.txn_type, dt.amount, dt.mode, dt.remarks, dt.trip_id, t.trip_code FROM driver_transactions dt LEFT JOIN trips t ON t.id = dt.trip_id
                                         WHERE dt.driver_id = $1::uuid OR (dt.driver_id IS NULL AND norm_person_name(dt.driver_name) = norm_person_name($2)) ORDER BY dt.txn_date DESC, dt.created_at DESC LIMIT 300`, [id, d.name]);
    const sum = (f) => r2(settlements.filter(f).reduce((s, x) => s + Number(x.net_payable || 0), 0));
    return { driver: d, settlements, monthly_lines: lines, transactions: txns,
      totals: { blocked: settlements.filter((s) => s.status === 'BLOCKED').length, draft_net: sum((s) => s.status === 'DRAFT'), posted_unpaid: sum((s) => s.status === 'POSTED'), paid: sum((s) => s.status === 'PAID') } };
  });

  // ── instant settlements ───────────────────────────────────────────────
  app.get('/trip-settlements', staff, async (req) => {
    const firm = UUID_RE.test(req.query.firm ?? '') ? req.query.firm : null;
    const status = ['BLOCKED', 'DRAFT', 'POSTED', 'PAID', 'CANCELLED'].includes(req.query.status) ? req.query.status : null;
    const driver = UUID_RE.test(req.query.driver ?? '') ? req.query.driver : null;
    const { rows } = await query(`SELECT s.*, c.company_name FROM driver_trip_settlements s LEFT JOIN companies c ON c.id = s.company_id
                                   WHERE ($1::uuid IS NULL OR s.company_id = $1::uuid) AND ($2::text IS NULL OR s.status = $2) AND ($3::uuid IS NULL OR s.driver_id = $3::uuid)
                                   ORDER BY CASE s.status WHEN 'DRAFT' THEN 0 WHEN 'BLOCKED' THEN 1 WHEN 'POSTED' THEN 2 ELSE 3 END, s.completed_at DESC NULLS LAST LIMIT 500`, [firm, status, driver]);
    return { rows };
  });

  const loadSettlement = async (id) => (await query(`SELECT s.*, c.company_name FROM driver_trip_settlements s LEFT JOIN companies c ON c.id = s.company_id WHERE s.id = $1::uuid`, [id])).rows[0];

  app.post('/trip-settlements/:id/recompute', admin, async (req, reply) => {
    const s = await loadSettlement(req.params.id); if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    await query(`SELECT driver_trip_settle($1::uuid, $2)`, [s.trip_id, actor(req)]);
    return { settlement: await loadSettlement(s.id) };
  });
  app.post('/trip-settlements/:id/cancel', admin, async (req, reply) => {
    const s = await loadSettlement(req.params.id); if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!['DRAFT', 'BLOCKED'].includes(s.status)) return reply.code(409).send({ error: 'NOT_OPEN', detail: `a ${s.status} settlement cannot be cancelled here` });
    await query(`UPDATE driver_trip_settlements SET status = 'CANCELLED', note = $2, updated_at = now() WHERE id = $1::uuid`, [s.id, req.body?.note ?? `cancelled by ${actor(req)}`]);
    return { ok: true };
  });

  // Approve & Post — the liability exists from this moment. The core takes a
  // (req, reply) pair so the month-end batch can call it without HTTP.
  const tripPostCore = async (req, reply) => {
    const s = await loadSettlement(req.params.id); if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (s.status !== 'DRAFT') return reply.code(409).send({ error: 'NOT_DRAFT', detail: s.status === 'BLOCKED' ? `blocked: ${s.block_reason}` : `already ${s.status}` });
    if (!s.company_id) return reply.code(422).send({ error: 'NO_FIRM', detail: 'the settlement names no paying firm — set it on the driver (Configure) or the trip' });
    if (Number(s.earning) <= 0) return reply.code(422).send({ error: 'NOTHING_EARNED' });
    const attached = s.vehicle_ownership === 'ATTACHED' && s.owner_ledger;
    const lines = [];
    if (attached) {
      // The company is the owner's agent: what it pays the driver is the
      // owner's cost. The advance was debited to the owner when it went out
      // (routing, 175); what the driver is docked stays with the owner too.
      // So the liability to the driver is the only thing to book, against
      // the owner's ledger — no wages expense, no korki legs.
      if (Number(s.net_payable) > 0) {
        lines.push({ ledger: s.owner_ledger, dr_cr: 'DR', amount: r2(s.net_payable), group: 'Sundry Creditors (Vehicle Owners)' });
        lines.push({ ledger: `Driver Payable: ${s.driver_name}`, dr_cr: 'CR', amount: r2(s.net_payable), group: PAYABLE_GROUP });
      }
    } else {
      lines.push({ ledger: WAGES_LEDGER, dr_cr: 'DR', amount: r2(s.earning), group: WAGES_GROUP });
      if (Number(s.applied_shortage) > 0) lines.push({ ledger: SHORTAGE_LEDGER, dr_cr: 'CR', amount: r2(s.applied_shortage), group: SHORTAGE_GROUP });
      if (Number(s.applied_challans) > 0) lines.push({ ledger: SHORTAGE_LEDGER, dr_cr: 'CR', amount: r2(s.applied_challans), group: SHORTAGE_GROUP });
      if (Number(s.applied_advances) > 0) lines.push({ ledger: `Driver Advance: ${s.driver_name}`, dr_cr: 'CR', amount: r2(s.applied_advances), group: ADVANCE_GROUP });
      if (Number(s.net_payable) > 0) lines.push({ ledger: `Driver Payable: ${s.driver_name}`, dr_cr: 'CR', amount: r2(s.net_payable), group: PAYABLE_GROUP });
    }
    if (!lines.length) {
      // nothing to book (attached lorry, korki swallowed the whole earning): the settlement is complete as it stands
      await query(`UPDATE driver_trip_settlements SET status = 'PAID', posted_at = now(), posted_by = $2, paid_on = current_date, paid_by = $2, paid_via = 'nil — fully adjusted', updated_at = now() WHERE id = $1::uuid`, [s.id, actor(req)]);
      await query(`INSERT INTO driver_transactions (driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks) VALUES ($1::uuid, $2, $3::uuid, current_date, 'SALARY_CREDIT', $4, 'Trip settlement', $5)`, [s.driver_id, s.driver_name, s.trip_id, r2(s.earning), `[${s.settlement_no}] ${s.trip_code} trip pay (${s.basis}) — fully adjusted against korki`]);
      return { settlement: await loadSettlement(s.id), voucher: null };
    }
    let voucher;
    try {
      voucher = await postVoucher({ type: 'JOURNAL', company_id: s.company_id, lines, source_type: 'DRIVER_TRIP_PAY', ref_no: s.settlement_no,
        entry_date: (s.completed_at ? new Date(s.completed_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10)),
        narration: `Trip pay ${s.trip_code} · ${s.driver_name} · ${s.basis} ${s.rate ?? ''}: earned ${r2(s.earning)}, korki ${r2(Number(s.applied_shortage) + Number(s.applied_challans) + Number(s.applied_advances))}, net ${r2(s.net_payable)}`, created_by: actor(req) });
    } catch (e) {
      if (e.code !== 'DUPLICATE_REF') return reply.code(422).send({ error: 'POST_FAILED', detail: e.message });
    }
    await withTransaction(async (t) => {
      await t.query(`UPDATE driver_trip_settlements SET status = 'POSTED', journal_voucher_id = coalesce($2::uuid, journal_voucher_id), posted_at = now(), posted_by = $3, updated_at = now() WHERE id = $1::uuid`, [s.id, voucher?.voucher_id ?? null, actor(req)]);
      // the khata mirror: the driver earned this; the trip's korki is now consumed
      await t.query(`INSERT INTO driver_transactions (driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks) VALUES ($1::uuid, $2, $3::uuid, current_date, 'SALARY_CREDIT', $4, 'Trip settlement', $5)`,
        [s.driver_id, s.driver_name, s.trip_id, r2(s.earning), `[${s.settlement_no}] ${s.trip_code} trip pay (${s.basis}) — net payable ${r2(s.net_payable)}`]);
      if (Number(s.applied_shortage) > 0) await t.query(`INSERT INTO driver_transactions (driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks) VALUES ($1::uuid, $2, $3::uuid, current_date, 'SHORTAGE_RECOVERY', $4, 'Trip settlement', $5)`,
        [s.driver_id, s.driver_name, s.trip_id, r2(s.applied_shortage), `[${s.settlement_no}] shortage recovered from trip pay`]);
    });
    return { settlement: await loadSettlement(s.id), voucher: voucher ?? null };
  };
  app.post('/trip-settlements/:id/post', admin, tripPostCore);

  const payOne = async (req, reply, { source, ref_id, account, paid_on }) => {
    if (!UUID_RE.test(ref_id ?? '')) return bad(reply, 'BAD_ID', 'ref_id');
    if (!account || !(await accountOk(account))) return bad(reply, 'BAD_ACCOUNT', 'account must be a cash or bank ledger');
    const day = DATE_RE.test(paid_on ?? '') ? paid_on : new Date().toISOString().slice(0, 10);
    if (source === 'TRIP') {
      const s = await loadSettlement(ref_id); if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
      if (s.status !== 'POSTED') return reply.code(409).send({ error: 'NOT_POSTED', detail: `settlement is ${s.status}` });
      if (!(Number(s.net_payable) > 0)) return reply.code(422).send({ error: 'NOTHING_TO_PAY' });
      // ONE transaction for the voucher AND the rows that record it as paid.
      // These used to be two: postVoucher committed on its own, and a failure in
      // the follow-up left the ledger holding a payment no settlement claimed.
      // postVoucher now takes `tx` (migration 177 work) and joins this one.
      let v;
      try {
        await withTransaction(async (t) => {
          v = await postVoucher({ tx: t, type: 'PAYMENT', company_id: s.company_id, account, party_ledger: `Driver Payable: ${s.driver_name}`, party_group: PAYABLE_GROUP, amount: r2(s.net_payable), entry_date: day,
            source_type: 'DRIVER_TRIP_PAY', ref_no: `${s.settlement_no}-PAY`, narration: `Trip pay ${s.trip_code} paid to ${s.driver_name} from ${account}`, created_by: actor(req) });
          await t.query(`UPDATE driver_trip_settlements SET status = 'PAID', payment_voucher_id = coalesce($2::uuid, payment_voucher_id), paid_via = $3, paid_on = $4::date, paid_by = $5, updated_at = now() WHERE id = $1::uuid`, [s.id, v?.voucher_id ?? null, account, day, actor(req)]);
          await t.query(`INSERT INTO driver_transactions (driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks) VALUES ($1::uuid, $2, $3::uuid, $4::date, 'FINAL_PAYMENT', $5, $6, $7)`,
            [s.driver_id, s.driver_name, s.trip_id, day, r2(s.net_payable), account, `[${s.settlement_no}] trip pay paid`]);
        });
      } catch (e) {
        // A re-run of an already-posted payment still has to mark it paid, so
        // DUPLICATE_REF replays the status half without the voucher half.
        if (e.code !== 'DUPLICATE_REF') return reply.code(422).send({ error: e.code === 'OVERDRAFT' ? 'OVERDRAFT' : 'PAY_FAILED', detail: e.message });
        await withTransaction(async (t) => {
          await t.query(`UPDATE driver_trip_settlements SET status = 'PAID', paid_via = $2, paid_on = $3::date, paid_by = $4, updated_at = now() WHERE id = $1::uuid AND status <> 'PAID'`, [s.id, account, day, actor(req)]);
        });
      }
      return { paid: true, settlement: await loadSettlement(s.id), voucher: v ?? null };
    }
    const { rows: [l] } = await query(`SELECT l.*, r.company_id, r.run_no, r.period FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.id = $1::uuid`, [ref_id]);
    if (!l) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (l.status !== 'POSTED') return reply.code(409).send({ error: 'NOT_POSTED', detail: `line is ${l.status}` });
    if (!(Number(l.net_payable) > 0)) return reply.code(422).send({ error: 'NOTHING_TO_PAY' });
    const party = payableLedgerOf(l.person_kind, l.person_name);
    // Same single-transaction rule as the trip branch above: the voucher and the
    // "PAID" rows commit together or not at all.
    let v;
    let posted = true;
    try {
      await withTransaction(async (t) => {
        v = await postVoucher({ tx: t, type: 'PAYMENT', company_id: l.company_id, account, party_ledger: party, party_group: PAYABLE_GROUP, amount: r2(l.net_payable), entry_date: day,
          source_type: 'PAYROLL', ref_no: `${l.run_no}/${l.person_name}-PAY`, narration: `${l.period} ${l.person_kind === 'PARTNER' ? 'remuneration' : 'salary'} paid to ${l.person_name} from ${account}`, created_by: actor(req) });
        await payMarkPaid(t, l, v, account, day, actor(req));
      });
    } catch (e) {
      if (e.code !== 'DUPLICATE_REF') return reply.code(422).send({ error: e.code === 'OVERDRAFT' ? 'OVERDRAFT' : 'PAY_FAILED', detail: e.message });
      posted = false;
    }
    // DUPLICATE_REF means the voucher was already posted by an earlier attempt.
    // Mark the line paid, but only if it is not already — re-running this blind
    // (which the pre-177 code did) inserted a second driver/staff khata row for
    // one payment, so a replay quietly doubled the person's recorded receipts.
    if (!posted) {
      await withTransaction(async (t) => {
        const { rows: [cur] } = await t.query(`SELECT status FROM payroll_lines WHERE id = $1::uuid FOR UPDATE`, [l.id]);
        if (cur?.status !== 'PAID') await payMarkPaid(t, l, null, account, day, actor(req));
      });
    }
    return { paid: true, line: (await query(`SELECT * FROM payroll_lines WHERE id = $1::uuid`, [l.id])).rows[0], voucher: v ?? null };
  };

  /** The "this line is paid" writes, so the normal path and the DUPLICATE_REF
   *  replay cannot drift apart. */
  const payMarkPaid = async (t, l, v, account, day, by) => {
    await t.query(`UPDATE payroll_lines SET status = 'PAID', payment_voucher_id = coalesce($2::uuid, payment_voucher_id), paid_via = $3, paid_on = $4::date, paid_by = $5, updated_at = now() WHERE id = $1::uuid`, [l.id, v?.voucher_id ?? null, account, day, by]);
    if (l.person_kind === 'DRIVER') await t.query(`INSERT INTO driver_transactions (driver_id, driver_name, txn_date, txn_type, amount, mode, remarks) VALUES ($1::uuid, $2, $3::date, 'FINAL_PAYMENT', $4, $5, $6)`, [l.person_id, l.person_name, day, r2(l.net_payable), account, `[${l.run_no}] ${l.period} salary paid`]);
    else await t.query(`INSERT INTO staff_transactions (staff_id, txn_date, txn_type, amount, mode, remarks, voucher_id, ref, created_by) VALUES ($1::uuid, $2::date, 'PAYMENT_GIVEN', $3, $4, $5, $6::uuid, $7, $8)`, [l.person_id, day, r2(l.net_payable), account, `${l.period} ${l.person_kind === 'PARTNER' ? 'remuneration' : 'salary'} paid`, v?.voucher_id ?? null, l.run_no, by]);
    await t.query(`UPDATE payroll_runs r SET status = CASE WHEN NOT EXISTS (SELECT 1 FROM payroll_lines x WHERE x.run_id = r.id AND x.status = 'POSTED') THEN 'PAID' ELSE r.status END, updated_at = now() WHERE r.id = $1::uuid`, [l.run_id]);
  };
  app.post('/trip-settlements/:id/pay', admin, async (req, reply) => payOne(req, reply, { source: 'TRIP', ref_id: req.params.id, account: req.body?.account, paid_on: req.body?.paid_on }));
  app.post('/disbursal/pay', admin, async (req, reply) => payOne(req, reply, { source: req.body?.source === 'TRIP' ? 'TRIP' : 'MONTHLY', ref_id: req.body?.ref_id, account: req.body?.account, paid_on: req.body?.paid_on }));

  app.get('/disbursal', staff, async (req) => {
    const firm = UUID_RE.test(req.query.firm ?? '') ? req.query.firm : null;
    const { rows } = await query(`SELECT p.*, c.company_name FROM v_payables_for_disbursal p LEFT JOIN companies c ON c.id = p.company_id WHERE ($1::uuid IS NULL OR p.company_id = $1::uuid) ORDER BY p.posted_at NULLS LAST`, [firm]);
    return { rows, total: r2(rows.reduce((s, r) => s + Number(r.amount || 0), 0)) };
  });

  // ── monthly runs ──────────────────────────────────────────────────────
  app.get('/runs', staff, async (req) => {
    const firm = UUID_RE.test(req.query.firm ?? '') ? req.query.firm : null; const kind = ['DRIVER', 'STAFF'].includes(req.query.kind) ? req.query.kind : null;
    const { rows } = await query(`SELECT r.*, c.company_name FROM payroll_runs r JOIN companies c ON c.id = r.company_id WHERE ($1::uuid IS NULL OR r.company_id = $1::uuid) AND ($2::text IS NULL OR r.kind = $2) ORDER BY r.period DESC, c.company_name, r.kind`, [firm, kind]);
    return { rows };
  });
  app.post('/runs/build', admin, async (req, reply) => {
    const b = req.body ?? {};
    if (!UUID_RE.test(b.firm ?? '')) return bad(reply, 'BAD_FIRM', 'firm');
    if (!PERIOD_RE.test(b.period ?? '')) return bad(reply, 'BAD_PERIOD', 'period must be YYYY-MM');
    if (!['DRIVER', 'STAFF'].includes(b.kind)) return bad(reply, 'BAD_KIND', 'kind must be DRIVER or STAFF');
    const { rows: [r] } = await query(`SELECT payroll_run_build($1::uuid, $2, $3, $4) AS id`, [b.firm, b.period, b.kind, actor(req)]);
    return runOf(r.id);
  });
  const runOf = async (id) => {
    const { rows: [run] } = await query(`SELECT r.*, c.company_name FROM payroll_runs r JOIN companies c ON c.id = r.company_id WHERE r.id = $1::uuid`, [id]);
    const { rows: lines } = await query(`SELECT * FROM payroll_lines WHERE run_id = $1::uuid ORDER BY person_kind, person_name`, [id]);
    return { run, lines };
  };
  app.get('/runs/:id', staff, async (req, reply) => { if (!UUID_RE.test(req.params.id)) return bad(reply, 'BAD_ID', 'id'); const r = await runOf(req.params.id); if (!r.run) return reply.code(404).send({ error: 'NOT_FOUND' }); return r; });
  app.patch('/runs/:id/lines/:lineId', admin, async (req, reply) => {
    const { id, lineId } = req.params; if (!UUID_RE.test(id) || !UUID_RE.test(lineId)) return bad(reply, 'BAD_ID', 'id');
    const { rows: [l] } = await query(`SELECT l.*, r.status AS run_status FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.id = $1::uuid AND l.run_id = $2::uuid`, [lineId, id]);
    if (!l) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (l.status !== 'DRAFT' && l.status !== 'SKIPPED') return reply.code(409).send({ error: 'NOT_DRAFT', detail: `line is ${l.status}` });
    const b = req.body ?? {};
    const gross = b.gross === undefined ? Number(l.gross) : Number(b.gross);
    const other = b.deduct_other === undefined ? Number(l.deduct_other) : Number(b.deduct_other);
    if (!(gross >= 0) || !(other >= 0)) return bad(reply, 'BAD_AMOUNT', 'amounts must be ≥ 0');
    const status = b.skip === true ? 'SKIPPED' : 'DRAFT';
    // deductions keep their priority: shortage, challans, other, advances — up to the gross
    let rem = gross; const sh = Math.min(rem, Number(l.deduct_shortage)); rem -= sh; const ch = Math.min(rem, Number(l.deduct_challans)); rem -= ch; const ot = Math.min(rem, other); rem -= ot;
    const advDue = Number(l.detail?.khata_balance ?? l.detail?.advances_outstanding ?? l.deduct_advances); const adv = Math.min(rem, advDue); rem -= adv;
    await query(`UPDATE payroll_lines SET gross = $2, deduct_shortage = $3, deduct_challans = $4, deduct_other = $5, deduct_advances = $6, deductions_total = $7, net_payable = $8, carry_forward = $9, status = $10, note = $11, edited_by = $12, updated_at = now() WHERE id = $1::uuid`,
      [lineId, r2(gross), r2(sh), r2(ch), r2(ot), r2(adv), r2(sh + ch + ot + adv), r2(rem), r2(advDue - adv), status, b.note ?? l.note, actor(req)]);
    await query(`UPDATE payroll_runs pr SET persons = x.n, gross_total = x.g, deductions_total = x.d, net_total = x.nt, updated_at = now() FROM (SELECT count(*) AS n, coalesce(sum(gross), 0) AS g, coalesce(sum(deductions_total), 0) AS d, coalesce(sum(net_payable), 0) AS nt FROM payroll_lines WHERE run_id = $1::uuid AND status <> 'SKIPPED') x WHERE pr.id = $1::uuid`, [id]);
    return runOf(id);
  });

  // Approve & Post the run: one journal per person, liability per person.
  const runPostCore = async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const { run, lines } = await runOf(id); if (!run) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (run.status !== 'DRAFT') return reply.code(409).send({ error: 'NOT_DRAFT', detail: `run is ${run.status}` });
    const posted = []; const failed = [];
    for (const l of lines) {
      if (l.status !== 'DRAFT' || !(Number(l.gross) > 0)) continue;
      const expense = l.person_kind === 'DRIVER' ? { ledger: WAGES_LEDGER, group: WAGES_GROUP } : l.person_kind === 'PARTNER' ? { ledger: `Partner Remuneration: ${l.person_name}`, group: INDIRECT_GROUP } : { ledger: STAFF_SALARY_LEDGER, group: INDIRECT_GROUP };
      const jl = [{ ledger: expense.ledger, dr_cr: 'DR', amount: r2(l.gross), group: expense.group }];
      if (Number(l.deduct_shortage) + Number(l.deduct_challans) > 0) jl.push({ ledger: SHORTAGE_LEDGER, dr_cr: 'CR', amount: r2(Number(l.deduct_shortage) + Number(l.deduct_challans)), group: SHORTAGE_GROUP });
      if (Number(l.deduct_other) > 0) jl.push({ ledger: l.person_kind === 'DRIVER' ? SHORTAGE_LEDGER : 'Recoveries from Staff', dr_cr: 'CR', amount: r2(l.deduct_other), group: l.person_kind === 'DRIVER' ? SHORTAGE_GROUP : 'Other Income' });
      if (Number(l.deduct_advances) > 0) jl.push({ ledger: l.person_kind === 'DRIVER' ? `Driver Advance: ${l.person_name}` : `Staff Advance: ${l.person_name}`, dr_cr: 'CR', amount: r2(l.deduct_advances), group: l.person_kind === 'DRIVER' ? ADVANCE_GROUP : 'Loans & Advances (Asset)' });
      if (Number(l.net_payable) > 0) jl.push({ ledger: payableLedgerOf(l.person_kind, l.person_name), dr_cr: 'CR', amount: r2(l.net_payable), group: PAYABLE_GROUP });
      let v = null;
      try {
        v = await postVoucher({ type: 'JOURNAL', company_id: run.company_id, lines: jl, source_type: 'PAYROLL', ref_no: `${run.run_no}/${l.person_name}`, entry_date: `${run.period}-01`,
          narration: `${run.period} ${l.person_kind === 'PARTNER' ? 'remuneration' : 'salary'} of ${l.person_name}: gross ${r2(l.gross)}, deductions ${r2(l.deductions_total)}, net ${r2(l.net_payable)}`, created_by: actor(req) });
      } catch (e) { if (e.code !== 'DUPLICATE_REF') { failed.push({ line: l.person_name, detail: e.message }); continue; } }
      await query(`UPDATE payroll_lines SET status = 'POSTED', updated_at = now() WHERE id = $1::uuid`, [l.id]);
      const charged = r2(Number(l.deduct_shortage) + Number(l.deduct_challans) + Number(l.deduct_other));
      if (l.person_kind === 'DRIVER') {
        await query(`INSERT INTO driver_transactions (driver_id, driver_name, txn_date, txn_type, amount, mode, remarks) VALUES ($1::uuid, $2, $3::date, 'SALARY_CREDIT', $4, 'Monthly payroll', $5)`, [l.person_id, l.person_name, `${run.period}-01`, r2(l.gross), `[${run.run_no}] ${run.period} salary — net payable ${r2(l.net_payable)}`]).catch(() => {});
        if (charged > 0) await query(`INSERT INTO driver_transactions (driver_id, driver_name, txn_date, txn_type, amount, mode, remarks) VALUES ($1::uuid, $2, $3::date, 'SHORTAGE_RECOVERY', $4, 'Monthly payroll', $5)`, [l.person_id, l.person_name, `${run.period}-01`, charged, `[${run.run_no}] shortage / challans / other charged against ${run.period} salary`]).catch(() => {});
      } else {
        await query(`INSERT INTO staff_transactions (staff_id, txn_date, txn_type, amount, mode, remarks, voucher_id, ref, created_by) VALUES ($1::uuid, $2::date, 'SALARY_CREDIT', $3, 'Monthly payroll', $4, $5::uuid, $6, $7)`, [l.person_id, `${run.period}-01`, r2(l.gross), `${run.period} ${l.person_kind === 'PARTNER' ? 'remuneration' : 'salary'} — net payable ${r2(l.net_payable)}`, v?.voucher_id ?? null, run.run_no, actor(req)]).catch(() => {});
        if (Number(l.deduct_other) > 0 && !(l.detail?.other_deductions > 0)) await query(`INSERT INTO staff_transactions (staff_id, txn_date, txn_type, amount, mode, remarks, voucher_id, ref, created_by) VALUES ($1::uuid, $2::date, 'OTHER_DEDUCTION', $3, 'Monthly payroll', $4, $5::uuid, $6, $7)`, [l.person_id, `${run.period}-01`, r2(l.deduct_other), `deducted from ${run.period} ${l.person_kind === 'PARTNER' ? 'remuneration' : 'salary'}`, v?.voucher_id ?? null, run.run_no, actor(req)]).catch(() => {});
      }
      posted.push(l.person_name);
    }
    if (posted.length) await query(`UPDATE payroll_runs SET status = 'POSTED', posted_at = now(), posted_by = $2, updated_at = now() WHERE id = $1::uuid`, [id, actor(req)]);
    return { ...(await runOf(id)), posted, failed };
  };
  app.post('/runs/:id/post', admin, runPostCore);
  app.post('/runs/:id/pay', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const b = req.body ?? {}; if (!b.account) return bad(reply, 'BAD_ACCOUNT', 'account');
    const { lines } = await runOf(id);
    const wanted = Array.isArray(b.line_ids) && b.line_ids.length ? new Set(b.line_ids) : null;
    const results = [];
    for (const l of lines) {
      if (l.status !== 'POSTED' || (wanted && !wanted.has(l.id))) continue;
      const fake = { code: null, body: null, send(x) { this.body = x; return this; } }; const rep = { code(c) { fake.code = c; return fake; }, send(x) { fake.body = x; return fake; } };
      const out = await payOne(req, rep, { source: 'MONTHLY', ref_id: l.id, account: b.account, paid_on: b.paid_on });
      results.push({ line: l.person_name, ok: !!out?.paid, detail: out?.paid ? null : (fake.body?.detail ?? fake.body?.error ?? 'failed') });
    }
    return { ...(await runOf(id)), results };
  });

  // ── staff & partners ──────────────────────────────────────────────────
  app.get('/staff', staff, async (req) => {
    const firm = UUID_RE.test(req.query.firm ?? '') ? req.query.firm : null;
    const { rows } = await query(`SELECT s.*, c.company_name,
        coalesce((SELECT sum(CASE WHEN txn_type IN ('ADVANCE_GIVEN','PAYMENT_GIVEN','OTHER_DEDUCTION') THEN amount WHEN txn_type = 'SALARY_CREDIT' THEN -amount ELSE 0 END) FROM staff_transactions x WHERE x.staff_id = s.id), 0)::numeric(14,2) AS balance,
        coalesce((SELECT sum(amount) FROM staff_transactions x WHERE x.staff_id = s.id AND x.txn_type = 'DRAWING'), 0)::numeric(14,2) AS drawings_total
      FROM staff_members s JOIN companies c ON c.id = s.company_id WHERE ($1::uuid IS NULL OR s.company_id = $1::uuid) ORDER BY s.status, s.kind, s.name`, [firm]);
    return { rows };
  });
  app.post('/staff', admin, async (req, reply) => {
    const b = req.body ?? {};
    if (!UUID_RE.test(b.company_id ?? '') || !b.name || !['STAFF', 'PARTNER'].includes(b.kind)) return bad(reply, 'MISSING_FIELDS', 'company_id, kind (STAFF/PARTNER) and name are required');
    const { rows: [s] } = await query(`INSERT INTO staff_members (company_id, kind, name, role_title, user_id, mobile, pan_no, bank_name, account_no, ifsc_code, monthly_amount, join_date, notes, created_by)
      VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11, $12::date, $13, $14) RETURNING *`,
      [b.company_id, b.kind, String(b.name).trim().toUpperCase(), b.role_title ?? null, UUID_RE.test(b.user_id ?? '') ? b.user_id : null, b.mobile ?? null, b.pan_no ? String(b.pan_no).toUpperCase() : null, b.bank_name ?? null, b.account_no ?? null, b.ifsc_code ? String(b.ifsc_code).toUpperCase() : null, r2(num(b.monthly_amount) ?? 0), DATE_RE.test(b.join_date ?? '') ? b.join_date : null, b.notes ?? null, actor(req)]);
    return { staff: s };
  });
  app.patch('/staff/:id', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const b = req.body ?? {}; const sets = []; const args = [id]; const put = (c, v) => { args.push(v); sets.push(`${c} = $${args.length}`); };
    for (const c of ['role_title', 'mobile', 'bank_name', 'account_no', 'notes']) if (b[c] !== undefined) put(c, b[c] || null);
    if (b.name !== undefined && b.name) put('name', String(b.name).trim().toUpperCase());
    if (b.pan_no !== undefined) put('pan_no', b.pan_no ? String(b.pan_no).toUpperCase() : null);
    if (b.ifsc_code !== undefined) put('ifsc_code', b.ifsc_code ? String(b.ifsc_code).toUpperCase() : null);
    if (b.monthly_amount !== undefined) put('monthly_amount', r2(num(b.monthly_amount) ?? 0));
    if (['ACTIVE', 'LEFT'].includes(b.status)) { put('status', b.status); if (b.status === 'LEFT') put('left_date', DATE_RE.test(b.left_date ?? '') ? b.left_date : new Date().toISOString().slice(0, 10)); }
    if (b.join_date !== undefined) put('join_date', DATE_RE.test(b.join_date ?? '') ? b.join_date : null);
    if (b.user_id !== undefined) put('user_id', UUID_RE.test(b.user_id ?? '') ? b.user_id : null);
    if (!sets.length) return bad(reply, 'NOTHING_TO_UPDATE', 'nothing to update');
    sets.push('updated_at = now()');
    const { rows: [s] } = await query(`UPDATE staff_members SET ${sets.join(', ')} WHERE id = $1::uuid RETURNING *`, args);
    return { staff: s };
  });
  // Advance / drawing / other deduction — an advance or drawing also moves cash (PAYMENT via TARA).
  app.post('/staff/:id/txn', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const b = req.body ?? {}; const amount = r2(num(b.amount) ?? 0);
    if (!['ADVANCE_GIVEN', 'DRAWING', 'OTHER_DEDUCTION'].includes(b.txn_type) || !(amount > 0)) return bad(reply, 'BAD_TXN', 'txn_type ADVANCE_GIVEN / DRAWING / OTHER_DEDUCTION and an amount > 0');
    const { rows: [s] } = await query(`SELECT * FROM staff_members WHERE id = $1::uuid`, [id]); if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (b.txn_type === 'DRAWING' && s.kind !== 'PARTNER') return bad(reply, 'NOT_A_PARTNER', 'drawings are for partners; give staff an advance');
    const day = DATE_RE.test(b.txn_date ?? '') ? b.txn_date : new Date().toISOString().slice(0, 10);
    let v = null;
    if (b.txn_type !== 'OTHER_DEDUCTION') {
      if (!b.account || !(await accountOk(b.account))) return bad(reply, 'BAD_ACCOUNT', 'account must be a cash or bank ledger');
      const ref = `STF-${s.id.slice(0, 8)}-${Date.now()}`;
      try {
        v = await postVoucher({ type: 'PAYMENT', company_id: s.company_id, account: b.account, amount, entry_date: day, source_type: 'PAYROLL', ref_no: ref, created_by: actor(req),
          party_ledger: b.txn_type === 'DRAWING' ? `Partner Capital: ${s.name}` : `Staff Advance: ${s.name}`, party_group: b.txn_type === 'DRAWING' ? 'Capital Account' : 'Loans & Advances (Asset)',
          narration: `${b.txn_type === 'DRAWING' ? 'Drawings by partner' : 'Advance to staff'} ${s.name}${b.remarks ? ' — ' + b.remarks : ''}` });
      } catch (e) { return reply.code(422).send({ error: e.code === 'OVERDRAFT' ? 'OVERDRAFT' : 'PAY_FAILED', detail: e.message }); }
    }
    const { rows: [t] } = await query(`INSERT INTO staff_transactions (staff_id, txn_date, txn_type, amount, mode, remarks, voucher_id, created_by) VALUES ($1::uuid, $2::date, $3, $4, $5, $6, $7::uuid, $8) RETURNING *`,
      [id, day, b.txn_type, amount, b.account ?? null, b.remarks ?? null, v?.voucher_id ?? null, actor(req)]);
    return { txn: t, voucher: v };
  });
  app.get('/staff/:id/txns', staff, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const { rows } = await query(`SELECT * FROM staff_transactions WHERE staff_id = $1::uuid ORDER BY txn_date DESC, created_at DESC LIMIT 300`, [id]);
    return { rows };
  });

  // ── attached-lorry routing (175): driver cash → the owner's ledger ──────
  // Dr Vehicle Owner: NAME / Cr the head the cash sits on (the driver's own
  // advance head, or the pooled pump-cash head). A khata entry with no cash
  // voucher behind it is flagged NEEDS_VOUCHER, never routed on a guess.
  const routeAttached = async (by, limit = 500) => {
    const { rows } = await query(`SELECT * FROM driver_txn_routing_candidates($1)`, [limit]);
    let routed = 0, needs = 0, failed = 0;
    for (const c of rows) {
      if (!c.source_ledger) {
        await query(`INSERT INTO driver_payment_routing (txn_id, trip_id, vehicle_no, driver_name, owner_name, owner_ledger, source_ledger, amount, status, note) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, NULL, $7, 'NEEDS_VOUCHER', 'no cash / bank voucher found for this khata entry')
          ON CONFLICT (txn_id) DO UPDATE SET status = 'NEEDS_VOUCHER', note = EXCLUDED.note, updated_at = now()`, [c.txn_id, c.trip_id, c.vehicle_no, c.driver_name, c.owner_name, c.owner_ledger, c.amount]);
        needs += 1; continue;
      }
      let v = null;
      try {
        v = await postVoucher({ type: 'JOURNAL', company_id: c.company_id, source_type: 'DRIVER_ROUTING', ref_no: `DRVRT-${c.txn_id}`, entry_date: String(c.txn_date).slice(0, 10) === 'Inva' ? undefined : new Date(c.txn_date).toISOString().slice(0, 10),
          lines: [{ ledger: c.owner_ledger, dr_cr: 'DR', amount: r2(c.amount), group: 'Sundry Creditors (Vehicle Owners)' }, { ledger: c.source_ledger, dr_cr: 'CR', amount: r2(c.amount), group: ADVANCE_GROUP }],
          narration: `${c.txn_type} ₹${r2(c.amount)} to ${c.driver_name} on ${c.trip_code} (${c.vehicle_no}, attached) charged to owner ${c.owner_name}`, created_by: by });
      } catch (e) {
        if (e.code !== 'DUPLICATE_REF') {
          await query(`INSERT INTO driver_payment_routing (txn_id, trip_id, vehicle_no, driver_name, owner_name, owner_ledger, source_ledger, amount, status, note) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 'FAILED', $9)
            ON CONFLICT (txn_id) DO UPDATE SET status = 'FAILED', note = EXCLUDED.note, updated_at = now()`, [c.txn_id, c.trip_id, c.vehicle_no, c.driver_name, c.owner_name, c.owner_ledger, c.source_ledger, c.amount, e.message.slice(0, 300)]);
          failed += 1; continue;
        }
      }
      await query(`INSERT INTO driver_payment_routing (txn_id, trip_id, vehicle_no, driver_name, owner_name, owner_ledger, source_ledger, amount, status, voucher_id, routed_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 'ROUTED', $9::uuid, now())
        ON CONFLICT (txn_id) DO UPDATE SET status = 'ROUTED', source_ledger = EXCLUDED.source_ledger, voucher_id = coalesce(EXCLUDED.voucher_id, driver_payment_routing.voucher_id), routed_at = now(), note = NULL, updated_at = now()`, [c.txn_id, c.trip_id, c.vehicle_no, c.driver_name, c.owner_name, c.owner_ledger, c.source_ledger, c.amount, v?.voucher_id ?? null]);
      routed += 1;
    }
    return { candidates: rows.length, routed, needs_voucher: needs, failed };
  };
  app.post('/routing/run', admin, async (req) => routeAttached(actor(req)));
  app.get('/routing', staff, async (req) => {
    const status = ['ROUTED', 'NEEDS_VOUCHER', 'FAILED', 'NOT_APPLICABLE'].includes(req.query.status) ? req.query.status : null;
    const { rows } = await query(`SELECT r.*, t.trip_code, dt.txn_type, dt.txn_date, dt.mode, dt.remarks FROM driver_payment_routing r LEFT JOIN trips t ON t.id = r.trip_id LEFT JOIN driver_transactions dt ON dt.id = r.txn_id WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.updated_at DESC LIMIT 500`, [status]);
    const { rows: pend } = await query(`SELECT count(*)::int AS n, coalesce(sum(amount), 0)::numeric(14,2) AS amount FROM driver_txn_routing_candidates(5000)`);
    return { rows, pending: pend[0] };
  });

  // ── month-end (175) ───────────────────────────────────────────────────
  const monthEndOf = async (firm, period) => {
    const { rows: [run] } = await query(`SELECT m.*, c.company_name FROM month_end_runs m JOIN companies c ON c.id = m.company_id WHERE m.company_id = $1::uuid AND m.period = $2`, [firm, period]);
    const { rows: slips } = await query(`SELECT id, person_kind, person_id, person_name, kind, opening, earned, korki, advances, paid, closing, trips, file_key, generated_at, status, note, mobile, approved_by, approved_at, posted_at, wa_sent_at FROM payroll_slips WHERE company_id = $1::uuid AND period = $2 ORDER BY status, kind, person_name`, [firm, period]);
    const { rows: [gate] } = await query(`SELECT month_end_gate($1::uuid, $2) AS g`, [firm, period]);
    return { run: run ?? null, gate: gate.g, slips };
  };
  app.get('/month-end', staff, async (req, reply) => {
    const { firm, period } = req.query; if (!UUID_RE.test(firm ?? '')) return bad(reply, 'BAD_FIRM', 'firm'); if (!PERIOD_RE.test(period ?? '')) return bad(reply, 'BAD_PERIOD', 'period must be YYYY-MM');
    return monthEndOf(firm, period);
  });
  app.get('/month-end/history', staff, async (req) => {
    const firm = UUID_RE.test(req.query.firm ?? '') ? req.query.firm : null;
    const { rows } = await query(`SELECT m.*, c.company_name FROM month_end_runs m JOIN companies c ON c.id = m.company_id WHERE ($1::uuid IS NULL OR m.company_id = $1::uuid) ORDER BY m.period DESC, c.company_name`, [firm]);
    return { rows };
  });

  // Run the month in DRAFT mode (owner, 5-Sep evening): settle every trip,
  // build both runs, route attached-lorry cash, write the slips and their
  // PDFs into the Approval Queue. NOTHING is posted here — a manager edits,
  // prints, sends, then presses Approve & Post per person (or for all). The
  // gate blocks the drafting unless an admin overrides with a reason, which
  // is recorded and raised on the Exception Desk.
  const runMonthEnd = async (req, firm, period, force, reason) => {
    const by = actor(req);
    let { run } = await monthEndOf(firm, period);
    if (run?.status === 'CLOSED') return { ...(await monthEndOf(firm, period)), already_closed: true };
    const { run: prepared, pdfs } = await prepareMonth(firm, period, by);
    const routing = await routeAttached(by, 2000).catch((e) => ({ error: e.message }));
    const { gate } = await monthEndOf(firm, period);
    if (gate.length && !force) {
      await query(`UPDATE month_end_runs SET status = 'BLOCKED', gate = $2::jsonb, updated_at = now() WHERE id = $1::uuid`, [prepared.id, JSON.stringify(gate)]);
      return { blocked: true, gate, run: (await monthEndOf(firm, period)).run, routing };
    }
    if (gate.length && force) {
      await query(`INSERT INTO exceptions (kind, severity, status, title, detail, subject_type, subject_id, company, dedupe_key, detected_by, evidence, detected_at, last_seen_at)
        VALUES ('PAYROLL_MONTH_END_BLOCKED', 'HIGH', 'OPEN', $1, $2, 'month_end', $3, (SELECT company_name FROM companies WHERE id = $4::uuid), $5, $6, $7::jsonb, now(), now()) ON CONFLICT DO NOTHING`,
        [`${period} drafted by ${by} with ${gate.length} blocker(s) overridden`, `Reason given: ${reason}. Blockers: ${gate.map((g) => g.title).join(' | ')}`, prepared.id, firm, `PAYROLL_MONTH_END_BLOCKED:${firm}:${period}`, by, JSON.stringify(gate)]).catch(() => {});
    }
    const summary = { routing, pdfs, forced: !!(gate.length && force), drafted_by: by };
    await query(`UPDATE month_end_runs SET status = 'DRAFT', forced = $3, force_reason = $4, routed = $5, summary = coalesce(summary, '{}'::jsonb) || $6::jsonb, updated_at = now() WHERE id = $1::uuid AND period = $2`,
      [prepared.id, period, !!(gate.length && force), reason ?? null, routing?.routed ?? 0, JSON.stringify(summary)]);
    return { drafted: true, summary, ...(await monthEndOf(firm, period)) };
  };
  app.post('/month-end/run', admin, async (req, reply) => {
    const b = req.body ?? {};
    if (!UUID_RE.test(b.firm ?? '')) return bad(reply, 'BAD_FIRM', 'firm'); if (!PERIOD_RE.test(b.period ?? '')) return bad(reply, 'BAD_PERIOD', 'period must be YYYY-MM');
    if (b.force && !(b.reason && String(b.reason).trim().length >= 8)) return bad(reply, 'REASON_REQUIRED', 'overriding the gate needs a reason (8+ characters), recorded on the run');
    const out = await runMonthEnd(req, b.firm, b.period, !!b.force, b.reason ?? null);
    if (out.blocked) return reply.code(409).send({ error: 'GATE_OPEN', detail: `${out.gate.length} blocker(s) must be cleared on the Exception Desk before ${b.period} can close`, ...out });
    return out;
  });
  // April → today, every firm, month by month (idempotent: a CLOSED month is skipped)
  app.post('/month-end/backfill', admin, async (req, reply) => {
    const b = req.body ?? {};
    const from = PERIOD_RE.test(b.from ?? '') ? b.from : '2026-04'; const to = PERIOD_RE.test(b.to ?? '') ? b.to : new Date(Date.now() - 86400000 * 5).toISOString().slice(0, 7);
    if (b.force && !(b.reason && String(b.reason).trim().length >= 8)) return bad(reply, 'REASON_REQUIRED', 'overriding the gate needs a reason');
    const { rows: firms } = await query(`SELECT id, company_name FROM companies WHERE status::text = 'ACTIVE' AND ($1::uuid IS NULL OR id = $1::uuid) ORDER BY company_name`, [UUID_RE.test(b.firm ?? '') ? b.firm : null]);
    const periods = []; for (let p = from; p <= to; ) { periods.push(p); const [y, m] = p.split('-').map(Number); p = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`; }
    const results = [];
    for (const f of firms) for (const period of periods) {
      const out = await runMonthEnd(req, f.id, period, !!b.force, b.reason ?? null).catch((e) => ({ error: e.message }));
      results.push({ firm: f.company_name, period, drafted: !!out.drafted, already_closed: !!out.already_closed, blocked: !!out.blocked, blockers: out.gate?.length ?? 0, routed: out.summary?.routing?.routed ?? 0, slips: out.slips?.length ?? 0, error: out.error ?? null });
    }
    return { from, to, results };
  });
  app.get('/slips', staff, async (req, reply) => {
    const { firm, period } = req.query; if (!UUID_RE.test(firm ?? '')) return bad(reply, 'BAD_FIRM', 'firm');
    const { rows } = await query(`SELECT s.*, c.company_name FROM payroll_slips s JOIN companies c ON c.id = s.company_id WHERE s.company_id = $1::uuid AND ($2::text IS NULL OR s.period = $2) ORDER BY s.period DESC, s.kind, s.person_name`, [firm, PERIOD_RE.test(period ?? '') ? period : null]);
    return { rows };
  });
  app.post('/slips/render', admin, async (req, reply) => {
    const b = req.body ?? {}; if (!UUID_RE.test(b.firm ?? '') || !PERIOD_RE.test(b.period ?? '')) return bad(reply, 'BAD_ARGS', 'firm, period');
    await query(`SELECT month_end_prepare($1::uuid, $2, $3)`, [b.firm, b.period, actor(req)]);
    return renderSlips(b.firm, b.period);
  });

  // ── the Manager Approval Queue (175, owner's evening directive) ──────────
  // One row per person per month (payroll_slips). The 1st-of-month agent and
  // "Run Monthly Settlement" fill it in DRAFT; a manager edits (manual korki,
  // missed advances, a wrong name), saves, prints, sends on WhatsApp, and
  // Approve & Post locks the slip and posts that person's settlements.
  const slipOf = async (id) => (await query(`SELECT s.*, c.company_name FROM payroll_slips s JOIN companies c ON c.id = s.company_id WHERE s.id = $1::uuid`, [id])).rows[0];
  const refreshSlip = async (s, by) => { await query(`SELECT month_end_prepare($1::uuid, $2, $3)`, [s.company_id, s.period, by]); return slipOf(s.id); };
  app.get('/approval-queue', staff, async (req, reply) => {
    const { firm, period } = req.query; if (!UUID_RE.test(firm ?? '')) return bad(reply, 'BAD_FIRM', 'firm'); if (!PERIOD_RE.test(period ?? '')) return bad(reply, 'BAD_PERIOD', 'period must be YYYY-MM');
    const { rows } = await query(`SELECT s.*,
        (SELECT count(*)::int FROM driver_trip_settlements x WHERE x.driver_id = s.person_id AND x.company_id = s.company_id AND to_char(x.completed_at, 'YYYY-MM') = s.period AND x.status = 'DRAFT') AS drafts,
        (SELECT count(*)::int FROM driver_trip_settlements x WHERE x.driver_id = s.person_id AND x.company_id = s.company_id AND to_char(x.completed_at, 'YYYY-MM') = s.period AND x.status = 'BLOCKED') AS blocked,
        (SELECT coalesce(sum(net_payable), 0)::numeric(14,2) FROM driver_trip_settlements x WHERE x.driver_id = s.person_id AND x.company_id = s.company_id AND to_char(x.completed_at, 'YYYY-MM') = s.period AND x.status IN ('DRAFT','POSTED','PAID')) AS net_month,
        (SELECT l.status FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.person_id = s.person_id AND r.company_id = s.company_id AND r.period = s.period LIMIT 1) AS line_status,
        (SELECT l.net_payable FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.person_id = s.person_id AND r.company_id = s.company_id AND r.period = s.period LIMIT 1) AS line_net
      FROM payroll_slips s WHERE s.company_id = $1::uuid AND s.period = $2 ORDER BY s.status, s.kind, s.person_name`, [firm, period]);
    const { rows: [run] } = await query(`SELECT * FROM month_end_runs WHERE company_id = $1::uuid AND period = $2`, [firm, period]);
    return { rows, run: run ?? null, totals: { drafts: rows.filter((r) => r.status === 'DRAFT').length, approved: rows.filter((r) => r.status !== 'DRAFT').length, net: r2(rows.reduce((a, r) => a + Number(r.kind === 'TRIP' ? r.net_month : r.line_net ?? 0), 0)) } };
  });
  app.get('/slips/:id', staff, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const s = await slipOf(id); if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    const { rows: settlements } = await query(`SELECT * FROM driver_trip_settlements WHERE driver_id = $1::uuid AND company_id = $2::uuid AND to_char(completed_at, 'YYYY-MM') = $3 AND status <> 'CANCELLED' ORDER BY completed_at`, [s.person_id, s.company_id, s.period]);
    const { rows: [line] } = await query(`SELECT l.*, r.run_no FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.person_id = $1::uuid AND r.company_id = $2::uuid AND r.period = $3 LIMIT 1`, [s.person_id, s.company_id, s.period]);
    const { rows: txns } = await query(`SELECT id, txn_date, txn_type, amount, mode, remarks, trip_id FROM driver_transactions WHERE driver_id = $1::uuid AND txn_date BETWEEN to_date($2 || '-01', 'YYYY-MM-DD') AND (to_date($2 || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date ORDER BY txn_date`, [s.person_id, s.period]);
    return { slip: s, settlements, line: line ?? null, transactions: s.person_kind === 'DRIVER' ? txns : [], text: slipText(s, s.company_name) };
  });
  // EDIT / SAVE — the slip's note; a trip's manual korki; a missed advance; the driver's name
  app.patch('/slips/:id', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const s = await slipOf(id); if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (s.status === 'POSTED') return reply.code(409).send({ error: 'LOCKED', detail: 'this slip is posted — reopen is not allowed; post a correction next month' });
    const b = req.body ?? {};
    await query(`UPDATE payroll_slips SET note = coalesce($2, note), mobile = coalesce($3, mobile), edited_by = $4, edited_at = now() WHERE id = $1::uuid`, [id, b.note ?? null, b.mobile ? String(b.mobile).replace(/\D/g, '').slice(-10) : null, actor(req)]);
    if (b.person_name && s.person_kind === 'DRIVER' && String(b.person_name).trim() && String(b.person_name).trim().toUpperCase() !== s.person_name) {
      await query(`UPDATE drivers SET name = $2, updated_at = now() WHERE id = $1::uuid`, [s.person_id, String(b.person_name).trim().toUpperCase()]);
      await query(`UPDATE driver_trip_settlements SET driver_name = $2 WHERE driver_id = $1::uuid AND status IN ('DRAFT','BLOCKED')`, [s.person_id, String(b.person_name).trim().toUpperCase()]);
    }
    return { slip: await refreshSlip(s, actor(req)) };
  });
  app.patch('/trip-settlements/:id', admin, async (req, reply) => {
    const s = await loadSettlement(req.params.id); if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!['DRAFT', 'BLOCKED'].includes(s.status)) return reply.code(409).send({ error: 'NOT_OPEN', detail: `settlement is ${s.status}` });
    const b = req.body ?? {}; const mk = b.manual_korki === undefined ? Number(s.manual_korki) : Number(b.manual_korki);
    if (!(mk >= 0)) return bad(reply, 'BAD_AMOUNT', 'manual korki must be ≥ 0');
    await query(`UPDATE driver_trip_settlements SET manual_korki = $2, manual_note = coalesce($3, manual_note), note = coalesce($4, note), edited_by = $5, edited_at = now(), updated_at = now() WHERE id = $1::uuid`, [s.id, r2(mk), b.manual_note ?? null, b.note ?? null, actor(req)]);
    await query(`SELECT driver_trip_settle($1::uuid, $2)`, [s.trip_id, actor(req)]);
    return { settlement: await loadSettlement(s.id) };
  });
  // a missed advance: recorded in the khata (dated), optionally paid out now from a ledger; every open settlement of the driver recomputes
  app.post('/drivers/:id/advance', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const b = req.body ?? {}; const amount = r2(num(b.amount) ?? 0); if (!(amount > 0)) return bad(reply, 'BAD_AMOUNT', 'amount > 0');
    const { rows: [d] } = await query(`SELECT id, name FROM drivers WHERE id = $1::uuid`, [id]); if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
    const day = DATE_RE.test(b.txn_date ?? '') ? b.txn_date : new Date().toISOString().slice(0, 10);
    const trip = UUID_RE.test(b.trip_id ?? '') ? b.trip_id : null;
    let v = null;
    if (b.account) {
      if (!(await accountOk(b.account))) return bad(reply, 'BAD_ACCOUNT', 'account must be a cash or bank ledger');
      const { rows: [co] } = await query(`SELECT coalesce((SELECT company_id FROM trips WHERE id = $2::uuid), (SELECT pay_company_id FROM drivers WHERE id = $1::uuid)) AS company_id`, [id, trip]);
      try { v = await postVoucher({ type: 'PAYMENT', company_id: co?.company_id ?? null, account: b.account, party_ledger: `Driver Advance: ${d.name}`, party_group: ADVANCE_GROUP, amount, entry_date: day, source_type: 'DRIVER_ADVANCE', ref_no: `DRVADV-${id.slice(0, 8)}-${Date.now()}`, narration: `Advance to ${d.name}${b.remarks ? ' — ' + b.remarks : ''}`, created_by: actor(req) }); }
      catch (e) { return reply.code(422).send({ error: e.code === 'OVERDRAFT' ? 'OVERDRAFT' : 'PAY_FAILED', detail: e.message }); }
    }
    const { rows: [t] } = await query(`INSERT INTO driver_transactions (driver_id, driver_name, trip_id, txn_date, txn_type, amount, mode, remarks) VALUES ($1::uuid, $2, $3::uuid, $4::date, 'ADVANCE_GIVEN', $5, $6, $7) RETURNING *`,
      [id, d.name, trip, day, amount, b.account ?? (b.mode ?? 'Office Cash'), `[${actor(req)}] ${b.remarks ?? 'missed advance added at month-end'}${v ? '' : ' (khata only — no voucher)'}`]);
    const { rows: [rs] } = await query(`SELECT driver_resettle_open($1::uuid) AS n`, [id]);
    return { transaction: t, voucher: v, resettled: rs.n };
  });
  // PRINT
  app.post('/slips/:id/render', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const s = await slipOf(id); if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (s.status !== 'POSTED') await query(`SELECT month_end_prepare($1::uuid, $2, $3)`, [s.company_id, s.period, actor(req)]);
    const r = await renderSlips(s.company_id, s.period, id);
    return { ...r, slip: await slipOf(id) };
  });
  // WHATSAPP
  app.post('/slips/:id/whatsapp', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const s = await slipOf(id); if (!s) return reply.code(404).send({ error: 'NOT_FOUND' });
    const mobile = String(req.body?.mobile ?? s.mobile ?? '').replace(/\D/g, '').slice(-10);
    if (mobile.length < 10) return bad(reply, 'NO_MOBILE', 'no registered mobile for this person — add it on the slip or the master');
    const text = slipText(s, s.company_name) + (s.file_key ? `\n\nPDF: ${process.env.PUBLIC_APP_URL ? `${process.env.PUBLIC_APP_URL.replace(/\/$/, '')}/api/v1/files/${s.file_key}` : '(ask the office for the PDF)'}` : '');
    const ok = await notifyWhatsApp(mobile, text).catch(() => false);
    await query(`UPDATE payroll_slips SET wa_sent_at = CASE WHEN $2 THEN now() ELSE wa_sent_at END, wa_result = $3, mobile = coalesce(mobile, $4) WHERE id = $1::uuid`, [id, !!ok, ok ? `sent to ${mobile}` : `failed to ${mobile} — WhatsApp engine did not accept it`, mobile]);
    if (!ok) return reply.code(502).send({ error: 'WA_FAILED', detail: 'the WhatsApp engine did not accept the message — is the number linked and the engine paired?' });
    return { sent: true, mobile };
  });
  // APPROVE & POST — locks the slip, posts the person's settlements / run line
  const approveSlipCore = async (req, id) => {
    const s = await slipOf(id); if (!s) return { error: 'NOT_FOUND', status: 404 };
    if (s.status === 'POSTED') return { slip: s, already: true };
    const by = actor(req); const results = [];
    if (s.kind === 'TRIP') {
      const { rows: drafts } = await query(`SELECT id FROM driver_trip_settlements WHERE driver_id = $1::uuid AND company_id = $2::uuid AND to_char(completed_at, 'YYYY-MM') = $3 AND status = 'DRAFT'`, [s.person_id, s.company_id, s.period]);
      for (const d of drafts) { const rep = mkReply(); try { const out = await tripPostCore({ params: { id: d.id }, user: req.user }, rep); results.push({ id: d.id, ok: rep.statusCode === 200 && !!out?.settlement, detail: rep.body?.detail ?? null }); } catch (e) { results.push({ id: d.id, ok: false, detail: e.message }); } }
    } else {
      const { rows: [l] } = await query(`SELECT l.id, l.run_id, l.status, r.status AS run_status FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.person_id = $1::uuid AND r.company_id = $2::uuid AND r.period = $3 LIMIT 1`, [s.person_id, s.company_id, s.period]);
      if (l && l.status === 'DRAFT') {
        // post just this line: skip the others, post the run, un-skip
        await query(`UPDATE payroll_lines SET status = 'SKIPPED', note = coalesce(note, '') || ' [held: not yet approved]' WHERE run_id = $1::uuid AND id <> $2::uuid AND status = 'DRAFT'`, [l.run_id, l.id]);
        const rep = mkReply(); try { const out = await runPostCore({ params: { id: l.run_id }, user: req.user }, rep); results.push({ id: l.id, ok: rep.statusCode === 200 && (out?.posted ?? []).length > 0, detail: rep.body?.detail ?? (out?.failed?.[0]?.detail ?? null) }); } catch (e) { results.push({ id: l.id, ok: false, detail: e.message }); }
        await query(`UPDATE payroll_lines SET status = 'DRAFT', note = replace(coalesce(note, ''), ' [held: not yet approved]', '') WHERE run_id = $1::uuid AND status = 'SKIPPED' AND note LIKE '%[held: not yet approved]%'`, [l.run_id]);
        await query(`UPDATE payroll_runs SET status = CASE WHEN EXISTS (SELECT 1 FROM payroll_lines x WHERE x.run_id = $1::uuid AND x.status = 'DRAFT') THEN 'DRAFT' ELSE status END, updated_at = now() WHERE id = $1::uuid`, [l.run_id]);
      } else if (l) results.push({ id: l.id, ok: true, detail: `already ${l.status}` });
    }
    const allOk = results.every((r) => r.ok);
    await query(`UPDATE payroll_slips SET status = CASE WHEN $2 THEN 'POSTED' ELSE 'BLOCKED' END, approved_by = $3, approved_at = now(), posted_at = CASE WHEN $2 THEN now() ELSE posted_at END WHERE id = $1::uuid`, [id, allOk, by]);
    await query(`SELECT month_end_prepare($1::uuid, $2, $3)`, [s.company_id, s.period, by]).catch(() => {});
    await renderSlips(s.company_id, s.period, id).catch(() => {});
    // the month closes itself when every slip is posted
    await query(`UPDATE month_end_runs m SET status = 'CLOSED', closed_at = now(), closed_by = $3, updated_at = now() WHERE m.company_id = $1::uuid AND m.period = $2 AND m.status <> 'CLOSED' AND NOT EXISTS (SELECT 1 FROM payroll_slips p WHERE p.company_id = m.company_id AND p.period = m.period AND p.status <> 'POSTED')`, [s.company_id, s.period, by]);
    return { slip: await slipOf(id), results, ok: allOk };
  };
  app.post('/slips/:id/approve', admin, async (req, reply) => {
    const { id } = req.params; if (!UUID_RE.test(id)) return bad(reply, 'BAD_ID', 'id');
    const out = await approveSlipCore(req, id); if (out.error) return reply.code(out.status ?? 400).send({ error: out.error });
    return out;
  });
  app.post('/month-end/approve-all', admin, async (req, reply) => {
    const b = req.body ?? {}; if (!UUID_RE.test(b.firm ?? '') || !PERIOD_RE.test(b.period ?? '')) return bad(reply, 'BAD_ARGS', 'firm, period');
    const { rows } = await query(`SELECT id, person_name FROM payroll_slips WHERE company_id = $1::uuid AND period = $2 AND status = 'DRAFT' ORDER BY person_name`, [b.firm, b.period]);
    const results = [];
    for (const s of rows) { const out = await approveSlipCore(req, s.id); results.push({ person: s.person_name, ok: !!out.ok, detail: out.results?.find((r) => !r.ok)?.detail ?? null }); }
    return { approved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results };
  });
}
