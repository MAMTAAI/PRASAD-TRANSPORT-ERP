// server/modules/assets.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/assets — vehicle loans and EMIs, tyres, batteries, and the service
// log. The maintenance side of the fleet.
//
//   GET/POST/PATCH/DELETE  /loans          loan_master
//   GET                    /loans/reconciliation
//   POST                   /loans/:id/emi  pay an EMI (splits, posts, adjusts)
//   GET/POST/PATCH         /tyres  /tyres/:id/fit  /tyres/:id/remove
//   GET/POST/PATCH         /batteries  + the same fit/remove pair
//   GET/POST/PATCH/DELETE  /maintenance    maintenance_logs
//
// TWO THINGS THIS MODULE EXISTS TO GET RIGHT.
//
// 1. AN EMI IS NOT ONE NUMBER. Principal repays the loan (a liability going
//    down); interest is a finance cost (an expense). The Firestore screens
//    wrote a single BANK_TRANSACTIONS row for the total, so the books could
//    never tell the two apart and finance costs never appeared in the P&L.
//    Every EMI here posts a three-leg JOURNAL through TARA.
//
// 2. THE COUNTER MOVES WITH THE PAYMENT, IN ONE TRANSACTION. The old code read
//    the loan in the browser, subtracted, and wrote it back — two people
//    paying at once lost one payment silently. Insert and adjustment now share
//    a transaction, and v_loan_reconciliation (035) makes any drift visible.
// ─────────────────────────────────────────────────────────────────────────────
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { drain } from '../agents/bus.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const money = (v) => Number(v ?? 0);
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

// The firm that OWNS a truck pays for its upkeep (owner rule of 2026-08-31,
// see migration 111). ASSET ownership is single-firm even for the trucks whose
// TRIPS span firms (054) — so vehicles.company_id is safe here where
// trip-derived attribution is not. An ATTACHED truck's upkeep debits the owner
// khata (056) and deliberately stays company-NULL.
async function ownedVehicleCompanyId(vehicleNo) {
  if (!vehicleNo) return null;
  const { rows: [v] } = await query(
    `SELECT company_id FROM vehicles
      WHERE vehicle_no = $1 AND ownership = 'OWNED' LIMIT 1`, [vehicleNo]);
  return v?.company_id ?? null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * The month an EMI is FOR, as YYYY-MM.
 *
 * NORMALISED HERE, AT THE BOUNDARY, and nowhere else. The column held two
 * spellings for two years — '2026-04' from the posting job and 'Apr-2026' from
 * the browser, which formats it with toLocaleString and offers "e.g. Mar-26" in
 * the edit box. The same month under two labels sorted apart on the history
 * screen and forced the duplicate guard in /post-emis to test both, one
 * forgotten OR away from charging an EMI twice.
 *
 * Migration 081 unified the stored rows and constrains the column. Rejecting
 * the browser's spelling outright would have been the easy half of that and
 * would have broken the edit dialog the moment it shipped, so both shapes are
 * accepted and one is stored. Anything else is refused rather than guessed —
 * a month key that is wrong is worse than one that is missing, because it
 * silently becomes a different instalment.
 */
export function normaliseEmiMonth(v) {
  if (v == null || String(v).trim() === '') return null;
  const s = String(v).trim();

  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) return s;                   // already canonical

  // 'Apr-2026', 'apr 2026', 'Mar-26'  ->  '2026-04'
  const m = s.match(/^([A-Za-z]{3,9})[-\s/]?(\d{2}|\d{4})$/);
  if (m) {
    const idx = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (idx >= 0) {
      const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
      return `${y}-${String(idx + 1).padStart(2, '0')}`;
    }
  }
  // '04-2026' / '04/2026'
  const n = s.match(/^(0?[1-9]|1[0-2])[-\s/](\d{4})$/);
  if (n) return `${n[2]}-${String(Number(n[1])).padStart(2, '0')}`;

  throw Object.assign(new Error(`unreadable EMI month "${v}" — use YYYY-MM`),
    { code: 'BAD_EMI_MONTH' });
}

/**
 * A payment row with its loan resolved.
 *
 * emi_payments carries loan_id and nothing else about the loan, so the history
 * screen printed empty Vehicle No and Bank / A/C No columns for every row —
 * 150 payments that could not be told apart. The join belongs here rather than
 * in the browser: any consumer of a payment needs to know which truck it was
 * for, and there is no version of that question the client can answer on its own.
 *
 * Company and owner come from the loan too, NOT from the copies stored on the
 * payment — those are 54 nulls and two spellings of the same firm, frozen at
 * whatever the loan said on the day the row was written.
 */
const PAYMENT_SELECT = `
  SELECT p.*,
         l.vehicle_no, l.loan_account_no, l.bank_name, l.loan_type,
         l.company_name AS loan_company, l.owner_name AS loan_owner,
         l.financier_ledger,
         -- Which transfer this payment was part of. Computed by the same
         -- function the batch view uses, so a row and its block can never
         -- disagree about which block it belongs to (084).
         emi_batch_key(p.payment_date, l.bank_name, p.paid_from_account, p.instrument_ref)
           AS batch_key
    FROM emi_payments p
    JOIN loan_master l ON l.id = p.loan_id`;

const pgErr = (reply, err) => {
  if (err.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', detail: err.detail ?? err.message });
  if (err.code === '23514') return reply.code(400).send({ error: 'CONSTRAINT', detail: err.message });
  if (err.code === '23503') return reply.code(409).send({ error: 'IN_USE', detail: err.detail ?? err.message });
  throw err;
};

const JSONB = new Set(['parts', 'emi_slabs', 'repayment_schedule']);
const enc = (c, v) => (JSONB.has(c) && v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

const buildUpdate = (table, allowed, body) => {
  const cols = allowed.filter((c) => body[c] !== undefined);
  if (!cols.length) return null;
  return {
    sql: `UPDATE ${table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now()
           WHERE id = $1::uuid RETURNING *`,
    args: [null, ...cols.map((c) => enc(c, body[c]))],
  };
};

const insert = (table, allowed, body) => {
  const cols = allowed.filter((c) => body[c] !== undefined);
  return {
    sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    args: cols.map((c) => enc(c, body[c])),
  };
};

export async function registerAssetRoutes(app) {
  // ═══ LOANS ════════════════════════════════════════════════════════════════
  const LOAN_COLS = ['loan_account_no', 'vehicle_no', 'owner_name', 'company_name', 'loan_type',
    'bank_name', 'sanction_date', 'rate_of_interest', 'principal_amt', 'tenure_months',
    'emi_amount', 'moratorium_months', 'first_emi_date', 'as_on_date', 'emis_completed',
    'remaining_principal', 'total_interest_paid', 'payment_status', 'emi_slabs',
    'repayment_schedule', 'financier_ledger'];

  app.get('/loans', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT l.*, r.expected_remaining, r.drift, r.payments_recorded
         FROM loan_master l
         JOIN v_loan_reconciliation r ON r.id = l.id
        ORDER BY l.payment_status, l.vehicle_no NULLS LAST, l.bank_name`);
    return {
      count: rows.length,
      loans: rows,
      total_outstanding: r2(rows.reduce((a, l) => a + money(l.remaining_principal), 0)),
      total_emi: r2(rows.filter((l) => l.payment_status !== 'CLOSED').reduce((a, l) => a + money(l.emi_amount), 0)),
    };
  });

  // Surfaced as its own endpoint so an operator can be shown the drift rather
  // than the app quietly picking a side.
  app.get('/loans/reconciliation', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM v_loan_reconciliation WHERE abs(COALESCE(drift, 0)) > 0.05 ORDER BY abs(drift) DESC`);
    return { drifted: rows.length, loans: rows };
  });

  app.post('/loans', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.bank_name && !b.loan_account_no) return reply.code(400).send({ error: 'NO_LOAN_IDENTITY' });
    // A new loan starts where it starts: the opening anchor is what was typed.
    const seeded = {
      ...b,
      remaining_principal: b.remaining_principal ?? b.principal_amt ?? 0,
      payment_status: b.payment_status ?? 'ACTIVE',
    };
    const u = insert('loan_master', LOAN_COLS, seeded);
    try {
      const { rows } = await query(u.sql, u.args);
      await query(
        `UPDATE loan_master SET opening_remaining_principal = remaining_principal,
                                opening_emis_completed = COALESCE(emis_completed, 0),
                                opening_as_of = CURRENT_DATE
          WHERE id = $1::uuid`, [rows[0].id]);
      reply.code(201);
      return { created: true, loan: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/loans/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('loan_master', LOAN_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, loan: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.delete('/loans/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: [n] } = await query(
      'SELECT count(*)::int AS c FROM emi_payments WHERE loan_id = $1::uuid', [req.params.id]);
    // A loan with payments against it is history, not a typo.
    if (n.c > 0) {
      return reply.code(409).send({
        error: 'HAS_PAYMENTS',
        detail: `${n.c} EMI payment(s) are recorded against this loan — close it instead of deleting it`,
      });
    }
    const { rows } = await query('DELETE FROM loan_master WHERE id = $1::uuid RETURNING loan_account_no', [req.params.id]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { deleted: true };
  });

  // ── Pay an EMI ─────────────────────────────────────────────────────────────
  app.post(
    '/loans/:id/emi',
    { schema: { body: { type: 'object', required: ['total_paid'], additionalProperties: false, properties: {
      total_paid: { type: 'number', exclusiveMinimum: 0 },
      principal_part: { type: 'number', minimum: 0 },
      interest_part: { type: 'number', minimum: 0 },
      payment_date: { type: ['string', 'null'], format: 'date' },
      emi_month: { type: ['string', 'null'], maxLength: 40 },
      months_paid: { type: 'integer', minimum: 1, default: 1 },
      payment_mode: { type: ['string', 'null'], maxLength: 40 },
      ref_no: { type: ['string', 'null'], maxLength: 80 },
      account: { type: ['string', 'null'], maxLength: 120 },
      company: { type: ['string', 'null'], maxLength: 120 },
      created_by: { type: ['string', 'null'], maxLength: 100 },
      post_to_ledger: { type: 'boolean', default: true },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [loan] } = await query('SELECT * FROM loan_master WHERE id = $1::uuid', [req.params.id]);
      if (!loan) return reply.code(404).send({ error: 'NOT_FOUND' });

      // The month key is canonicalised before anything else touches it — the
      // narration below quotes it, the row stores it, and the column now
      // constrains it. Accepting "Mar-26" from the edit box and storing
      // "2026-03" is the whole job; see normaliseEmiMonth.
      let emiMonth;
      try {
        emiMonth = normaliseEmiMonth(b.emi_month);
      } catch (e) {
        return reply.code(400).send({ error: 'BAD_EMI_MONTH', detail: e.message });
      }

      const total = r2(b.total_paid);
      // If the caller does not split it, the split is derived from the loan's
      // own rate on the CURRENT outstanding — never guessed as "all principal",
      // which would understate the debt and hide the interest cost entirely.
      let principal = b.principal_part !== undefined ? r2(b.principal_part) : null;
      let interest = b.interest_part !== undefined ? r2(b.interest_part) : null;
      if (principal === null && interest === null) {
        const monthlyRate = money(loan.rate_of_interest) / 12 / 100;
        interest = r2(money(loan.remaining_principal) * monthlyRate * (b.months_paid ?? 1));
        if (interest > total) interest = total;
        principal = r2(total - interest);
      } else if (principal === null) {
        principal = r2(total - interest);
      } else if (interest === null) {
        interest = r2(total - principal);
      }
      if (principal < 0 || interest < 0) {
        return reply.code(400).send({ error: 'BAD_SPLIT', detail: 'principal and interest cannot be negative' });
      }
      if (Math.abs(principal + interest - total) > 0.05) {
        return reply.code(400).send({
          error: 'BAD_SPLIT',
          detail: `principal ${principal} + interest ${interest} does not equal the ${total} paid`,
        });
      }
      // Overpaying the outstanding is almost always a typo in the split.
      if (principal > money(loan.remaining_principal) + 0.05) {
        return reply.code(422).send({
          error: 'OVER_REPAYMENT',
          detail: `principal ${principal} exceeds the ${loan.remaining_principal} still outstanding on this loan`,
        });
      }

      const date = b.payment_date ?? new Date().toISOString().slice(0, 10);
      const financier = loan.financier_ledger || `Loan: ${loan.bank_name || 'Financier'}${loan.vehicle_no ? ` (${loan.vehicle_no})` : ''}`;

      let voucher = null;
      let ledgerNote = null;
      if (b.post_to_ledger !== false) {
        if (!b.account) {
          return reply.code(400).send({
            error: 'NO_ACCOUNT',
            detail: 'an EMI leaves a bank account — name it, or post_to_ledger=false to record the repayment only',
          });
        }
        try {
          // Three legs, because an EMI is three facts: the liability falls, the
          // interest is spent, and the bank balance drops by the total.
          const legs = [
            { ledger: financier, dr_cr: 'DR', amount: principal, group: 'Secured Loans' },
            { ledger: b.account, dr_cr: 'CR', amount: total, group: 'Bank Accounts' },
          ];
          if (interest > 0) legs.splice(1, 0, { ledger: 'Interest on Vehicle Loans', dr_cr: 'DR', amount: interest, group: 'Finance Costs' });
          voucher = await postVoucher({
            type: 'JOURNAL',
            entry_date: date,
            narration: `EMI ${loan.vehicle_no || loan.loan_account_no || ''} ${emiMonth ? `(${emiMonth})` : ''} — ${loan.bank_name || ''}`.trim(),
            source_type: 'LOAN_EMI',
            ref_no: b.ref_no || null,
            company: b.company ?? loan.company_name ?? null,
            // The loan's firm (111: HDFC/SBI → Jaiswal, rest → Prasad), not the
            // caller's guess — the financier decides whose books this is.
            company_id: loan.company_id ?? null,
            created_by: b.created_by ?? null,
            lines: legs,
          });
          await drain().catch(() => {});
        } catch (err) {
          const map = { OVERDRAFT: 422, DUPLICATE_REF: 409, UNBALANCED: 400, NO_ACCOUNT: 400 };
          if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message, balance: err.balance });
          ledgerNote = err.message;
        }
      }

      try {
        const out = await withTransaction(async (t) => {
          const { rows: [pay] } = await t.query(
            `INSERT INTO emi_payments (loan_id, payment_date, emi_month, months_paid, principal_part,
                                       interest_part, total_paid, payment_mode, ref_no,
                                       paid_from_account, voucher_id, company, created_by)
             VALUES ($1::uuid,$2::date,$3,$4,$5,$6,$7,$8,$9,$10,$11::uuid,$12,$13) RETURNING *`,
            [loan.id, date, emiMonth, b.months_paid ?? 1, principal, interest, total,
             b.payment_mode ?? null, b.ref_no || null, b.account ?? null,
             voucher?.voucher_id ?? null, b.company ?? loan.company_name ?? null, b.created_by ?? null]);

          // Same transaction as the insert — this is the read-modify-write the
          // browser used to do, moved to where it is atomic.
          const { rows: [updated] } = await t.query(
            `UPDATE loan_master
                SET remaining_principal = GREATEST(0, COALESCE(remaining_principal,0) - $2),
                    total_interest_paid = COALESCE(total_interest_paid,0) + $3,
                    emis_completed      = COALESCE(emis_completed,0) + $4,
                    -- CLOSED only where there is no lender ledger to consult.
                    -- Where there is one, the modelled principal reaching zero
                    -- proves nothing: nine body loans hit zero with TATA still
                    -- demanding 4.32 lakh of instalments, and closing them took
                    -- that straight off the dashboard (083, undone by 085).
                    -- v_loan_closure_check carries the basis for each loan.
                    payment_status      = CASE
                      WHEN EXISTS (SELECT 1 FROM loan_receipts lr WHERE lr.loan_id = loan_master.id)
                        THEN payment_status
                      WHEN COALESCE(remaining_principal,0) - $2 <= 10 THEN 'CLOSED'
                      ELSE 'ACTIVE' END,
                    updated_at = now()
              WHERE id = $1::uuid RETURNING *`,
            [loan.id, principal, interest, b.months_paid ?? 1]);
          return { pay, loan: updated };
        });

        reply.code(201);
        return {
          created: true, payment: out.pay, loan: out.loan,
          split: { principal, interest, derived: b.principal_part === undefined && b.interest_part === undefined },
          voucher_id: voucher?.voucher_id ?? null, ledger_note: ledgerNote,
        };
      } catch (err) { return pgErr(reply, err); }
    }
  );

  // ── Undo an EMI ────────────────────────────────────────────────────────────
  // Deleting a payment has to put back exactly what it took: the principal, the
  // interest, the month count — and the ledger entry. The Firestore version did
  // this across four writes (add back the counters, delete from EMI_PAYMENTS,
  // delete from LOAN_PAYMENTS, hunt BANK_TRANSACTIONS for a matching row and
  // delete that too), any of which could fail on its own and leave the loan
  // saying one thing and the books another.
  //
  // The ledger entry is REVERSED, never deleted — ledger_entries is append-only
  // by trigger, and a repayment that happened is a fact even when it was
  // recorded by mistake.
  app.delete('/loans/:loanId/payments/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows: [pay] } = await query(
      'SELECT * FROM emi_payments WHERE id = $1::uuid AND loan_id = $2::uuid',
      [req.params.id, req.params.loanId]);
    if (!pay) return reply.code(404).send({ error: 'NOT_FOUND' });

    let reversal = null;
    const ledgerNote = null;
    if (pay.voucher_id) {
      try {
        // Same shape the cash book uses: a mirror-image JOURNAL, referenced
        // REV-<voucher> so a voucher cannot be reversed twice.
        const { rows: legs } = await query(
          `SELECT ledger_name, dr_cr, amount, company, branch, company_id
             FROM ledger_entries WHERE voucher_id = $1::uuid ORDER BY id`, [pay.voucher_id]);
        if (!legs.length) throw new Error('the voucher has no ledger entries');
        const ref = `REV-${pay.voucher_id}`;
        const { rows: dup } = await query(
          `SELECT 1 FROM ledger_entries WHERE source_type = 'REVERSAL' AND source_ref = $1 LIMIT 1`, [ref]);
        if (dup.length) throw new Error('this voucher has already been reversed');
        reversal = await postVoucher({
          type: 'JOURNAL',
          lines: legs.map((l) => ({
            ledger: l.ledger_name,
            dr_cr: l.dr_cr === 'DR' ? 'CR' : 'DR',
            amount: Number(l.amount),
          })),
          source_type: 'REVERSAL',
          ref_no: ref,
          entry_date: new Date().toISOString().slice(0, 10),
          narration: `Reversal of voucher ${pay.voucher_id} — ${req.body?.reason || 'EMI payment deleted'}`,
          company: legs[0].company,
          branch: legs[0].branch,
          // A reversal un-does the entry in the SAME firm's books.
          company_id: legs[0].company_id ?? null,
          created_by: req.body?.created_by ?? null,
        });
        await drain().catch(() => {});
      } catch (err) {
        // Refuse rather than half-undo: deleting the row while its voucher
        // stands would leave the loan repaid in the books and not in the app.
        return reply.code(409).send({
          error: 'REVERSAL_FAILED',
          detail: `the ledger entry for this payment could not be reversed (${err.message}), so the payment was left in place`,
        });
      }
    }

    try {
      const out = await withTransaction(async (t) => {
        await t.query('DELETE FROM emi_payments WHERE id = $1::uuid', [pay.id]);
        const { rows: [loan] } = await t.query(
          `UPDATE loan_master
              SET remaining_principal = COALESCE(remaining_principal,0) + $2,
                  total_interest_paid = GREATEST(0, COALESCE(total_interest_paid,0) - $3),
                  emis_completed      = GREATEST(0, COALESCE(emis_completed,0) - $4),
                  payment_status      = 'ACTIVE',
                  updated_at = now()
            WHERE id = $1::uuid RETURNING *`,
          [pay.loan_id, money(pay.principal_part), money(pay.interest_part), pay.months_paid ?? 1]);
        return loan;
      });
      return { deleted: true, loan: out, reversal_voucher_id: reversal?.voucher_id ?? null, ledger_note: ledgerNote };
    } catch (err) { return pgErr(reply, err); }
  });

  app.get('/loans/:id/payments', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `${PAYMENT_SELECT} WHERE p.loan_id = $1::uuid
        ORDER BY p.payment_date DESC, p.created_at DESC`,
      [req.params.id]);
    return { count: rows.length, payments: rows };
  });

  // ── Every EMI payment, across every loan ─────────────────────────────────
  // The history screen groups payments into BANK BLOCKS — one bank transfer
  // covering seven trucks, keyed on date + account + UTR — so it needs every
  // loan's payments at once to find the block. It was getting them by asking
  // for one loan at a time: 29 round trips to draw one table, and a screen that
  // renders in a different order depending on which of them answers first.
  //
  // Static segment, so it must be declared where Fastify will not read
  // "payments" as a loan id. It sits beside /loans/:id/payments rather than
  // replacing it — a caller that has one loan should not fetch the fleet.
  app.get(
    '/loans/payments',
    { schema: { querystring: { type: 'object', properties: {
      from: { type: ['string', 'null'], format: 'date' },
      to: { type: ['string', 'null'], format: 'date' },
      loan_no: { type: ['string', 'null'], maxLength: 40 },
      vehicle_no: { type: ['string', 'null'], maxLength: 20 },
      limit: { type: 'integer', minimum: 1, maximum: 5000, default: 2000 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { from = null, to = null, loan_no = null, vehicle_no = null, limit = 2000 } = req.query ?? {};
      const { rows } = await query(
        `${PAYMENT_SELECT}
          WHERE ($1::date IS NULL OR p.payment_date >= $1::date)
            AND ($2::date IS NULL OR p.payment_date <= $2::date)
            AND ($3::text IS NULL OR l.loan_account_no = $3)
            AND ($4::text IS NULL OR l.vehicle_no = $4)
          ORDER BY p.payment_date DESC, l.vehicle_no, p.created_at DESC
          LIMIT $5`,
        [from, to, loan_no, vehicle_no, limit]);
      // The blocks the screen draws come back alongside the rows, computed by
      // the view rather than re-derived in the browser. A block header that
      // adds up its own rows and a block total that came from SQL will drift
      // apart the first time a filter hides one of them.
      const { rows: batches } = await query(
        `SELECT * FROM v_emi_payment_batches
          WHERE ($1::date IS NULL OR payment_date >= $1::date)
            AND ($2::date IS NULL OR payment_date <= $2::date)
          ORDER BY payment_date DESC, financier`,
        [from, to]);

      return {
        count: rows.length,
        truncated: rows.length >= limit,
        total_paid: rows.reduce((a, r) => a + money(r.total_paid), 0).toFixed(2),
        batches,
        payments: rows,
      };
    }
  );

  // ═══ TYRES & BATTERIES ════════════════════════════════════════════════════
  // One shape, two components — the screens are near-identical and so is the
  // life cycle: bought into stock, fitted to a position, removed with a reason.
  // Where a component's cost sits before and after it is worn out (036).
  // Purchase: Dr <stock>  Cr bank/creditor. Consumption: Dr <expense> Cr <stock>.
  const STOCK = {
    tyres:     { stock: 'Tyre Stock',    expense: 'Tyre Consumption Expenses' },
    batteries: { stock: 'Battery Stock', expense: 'Battery Consumption Expenses' },
  };
  const STOCK_GROUP = 'Stock-in-Hand (Asset)';
  const CONSUMPTION_GROUP = 'Direct Expenses - Repairs & Tyres';

  const COMPONENTS = {
    tyres: {
      table: 'tyres', fitTable: 'tyre_fitments', idCol: 'tyre_id', serialCol: 'tyre_serial',
      cols: ['serial_no', 'brand', 'model', 'size', 'tyre_type', 'purchase_date', 'purchase_cost',
        'base_cost', 'gst_amount', 'gst_percent', 'invoice_no', 'invoice_url', 'vendor_name',
        'status', 'removal_reason', 'total_km_run'],
    },
    batteries: {
      table: 'batteries', fitTable: 'battery_fitments', idCol: 'battery_id', serialCol: 'battery_serial',
      cols: ['serial_no', 'brand', 'model', 'capacity_ah', 'warranty_months', 'purchase_date',
        'purchase_cost', 'base_cost', 'gst_amount', 'gst_percent', 'invoice_no', 'invoice_url',
        'vendor_name', 'status', 'removal_reason'],
    },
  };

  // The screens speak the Firestore-era 'IN STOCK'; the tables use 'IN_STOCK'
  // (the incumbent tyres spelling). Normalised once, here, so neither side has
  // to know about the other's punctuation.
  const normStatus = (v) => (v === undefined || v === null ? v : String(v).trim().toUpperCase().replace(/\s+/g, '_'));

  for (const [kind, C] of Object.entries(COMPONENTS)) {
    app.get(`/${kind}`, async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT c.*, f.vehicle_no AS fitted_on, f.position AS fitted_position, f.fitment_date
           FROM ${C.table} c
           LEFT JOIN LATERAL (
             SELECT vehicle_no, position, fitment_date FROM ${C.fitTable}
              WHERE ${C.idCol} = c.id AND removal_date IS NULL LIMIT 1) f ON true
          ORDER BY c.created_at DESC LIMIT 5000`);
      return {
        count: rows.length, [kind]: rows,
        in_stock: rows.filter((r) => r.status === 'IN_STOCK').length,
        fitted: rows.filter((r) => r.status === 'FITTED').length,
        stock_value: r2(rows.filter((r) => r.status === 'IN_STOCK').reduce((a, r) => a + money(r.purchase_cost), 0)),
      };
    });

    // Bulk create: one invoice buys several at once, and half an invoice must
    // never land. A serial that already exists is reported, not silently
    // skipped — it usually means the invoice was entered twice.
    app.post(`/${kind}`, async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const items = Array.isArray(req.body?.items) ? req.body.items : [req.body ?? {}];
      if (!items.length) return reply.code(400).send({ error: 'NOTHING_TO_ADD' });
      if (items.some((i) => !i.serial_no)) return reply.code(400).send({ error: 'NO_SERIAL' });
      for (const i of items) if (i.status !== undefined) i.status = normStatus(i.status);
      let created;
      try {
        created = await withTransaction(async (t) => {
          const out = [];
          for (const item of items) {
            const u = insert(C.table, C.cols, item);
            const { rows } = await t.query(u.sql, u.args);
            out.push(rows[0]);
          }
          return out;
        });
      } catch (err) { return pgErr(reply, err); }

      // ── The purchase enters STOCK, it is not an expense yet ────────────────
      // The Firestore screens took the whole invoice out as cash on the day it
      // was bought and then ALSO wrote a one-sided expense when the tyre wore
      // out. A component sitting in the store is an asset; it becomes an
      // expense on the day it is consumed, and only then. Posted after the rows
      // commit so a ledger failure leaves an invoice that can be posted again,
      // never stock that exists twice.
      const invoiceValue = r2(created.reduce((a, r) => a + money(r.purchase_cost), 0));
      let voucher = null;
      let ledgerNote = null;
      if (invoiceValue > 0 && (req.body?.account || req.body?.vendor_name)) {
        try {
          const payingCash = !!req.body.account;
          voucher = await postVoucher({
            type: 'JOURNAL',
            entry_date: created[0].purchase_date ?? new Date().toISOString().slice(0, 10),
            narration: `${kind === 'tyres' ? 'Tyre' : 'Battery'} purchase — ${created.length} item(s)`
              + (req.body.invoice_no ? ` (inv ${req.body.invoice_no})` : ''),
            source_type: kind === 'tyres' ? 'TYRE_PURCHASE' : 'BATTERY_PURCHASE',
            // The invoice number is the reference, so re-entering the same
            // invoice cannot post its stock leg twice.
            ref_no: req.body.invoice_no || null,
            created_by: req.body.created_by ?? null,
            lines: [
              { ledger: STOCK[kind].stock, dr_cr: 'DR', amount: invoiceValue, group: STOCK_GROUP },
              payingCash
                ? { ledger: req.body.account, dr_cr: 'CR', amount: invoiceValue, group: 'Bank Accounts' }
                : { ledger: `Creditors: ${req.body.vendor_name}`, dr_cr: 'CR', amount: invoiceValue, group: 'Sundry Creditors (Vendors)' },
            ],
          });
          await drain().catch(() => {});
          await query(
            `UPDATE ${C.table} SET purchase_voucher_id = $2::uuid WHERE id = ANY($1::uuid[])`,
            [created.map((r) => r.id), voucher.voucher_id]);
        } catch (err) {
          ledgerNote = err.message;
        }
      }

      reply.code(201);
      return {
        created: created.length, [kind]: created,
        stock_value: invoiceValue,
        voucher_id: voucher?.voucher_id ?? null,
        ledger_note: ledgerNote,
      };
    });

    app.patch(`/${kind}/:id`, async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const body = { ...(req.body ?? {}) };
      if (body.status !== undefined) body.status = normStatus(body.status);
      const u = buildUpdate(C.table, C.cols, body);
      if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
      u.args[0] = req.params.id;
      try {
        const { rows } = await query(u.sql, u.args);
        if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
        return { updated: true, item: rows[0] };
      } catch (err) { return pgErr(reply, err); }
    });

    // Fit. The partial unique index refuses a second live fitment for the same
    // item, so "already fitted somewhere else" is caught by the database rather
    // than by whichever screen happens to check.
    app.post(`/${kind}/:id/fit`, async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body ?? {};
      if (!b.vehicle_no) return reply.code(400).send({ error: 'NO_VEHICLE' });
      const { rows: [item] } = await query(`SELECT * FROM ${C.table} WHERE id = $1::uuid`, [req.params.id]);
      if (!item) return reply.code(404).send({ error: 'NOT_FOUND' });

      // The plate has to resolve to a real vehicle. tyre_fitments.vehicle_id is
      // NOT NULL for a good reason — a fitment on a plate the fleet does not
      // have is a typo, and left unlinked it would never appear on that
      // vehicle's history. Matched on the normalised plate, so spacing and
      // case in what the operator typed do not matter.
      const plate = String(b.vehicle_no).toUpperCase();
      const { rows: [veh] } = await query(
        `SELECT id, vehicle_no FROM vehicles
          WHERE upper(regexp_replace(vehicle_no, '[^A-Za-z0-9]', '', 'g'))
              = upper(regexp_replace($1, '[^A-Za-z0-9]', '', 'g')) LIMIT 1`, [plate]);
      if (!veh) {
        return reply.code(404).send({
          error: 'UNKNOWN_VEHICLE',
          detail: `no vehicle '${plate}' in the fleet master — check the plate, or add the vehicle first`,
        });
      }

      try {
        const out = await withTransaction(async (t) => {
          const { rows: [fit] } = await t.query(
            `INSERT INTO ${C.fitTable} (${C.idCol}, ${C.serialCol}, vehicle_id, vehicle_no, position,
                                        fitment_date, fitment_km, cost)
             VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6::date,$7,$8) RETURNING *`,
            [item.id, item.serial_no, veh.id, veh.vehicle_no, b.position ?? null,
             b.fitment_date ?? new Date().toISOString().slice(0, 10), b.fitment_km ?? null,
             b.cost ?? item.purchase_cost ?? null]);
          await t.query(`UPDATE ${C.table} SET status = 'FITTED', updated_at = now() WHERE id = $1::uuid`, [item.id]);
          return fit;
        });
        reply.code(201);
        return { fitted: true, fitment: out };
      } catch (err) {
        if (err.code === '23505') {
          return reply.code(409).send({
            error: 'ALREADY_FITTED',
            detail: `${item.serial_no} is already fitted and has not been removed`,
          });
        }
        return pgErr(reply, err);
      }
    });

    app.post(`/${kind}/:id/remove`, async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body ?? {};
      try {
        const out = await withTransaction(async (t) => {
          const { rows } = await t.query(
            `UPDATE ${C.fitTable}
                SET removal_date = $2::date, removal_km = $3, removal_reason = $4
              WHERE ${C.idCol} = $1::uuid AND removal_date IS NULL RETURNING *`,
            [req.params.id, b.removal_date ?? new Date().toISOString().slice(0, 10),
             b.removal_km ?? null, b.removal_reason ?? null]);
          if (!rows.length) return null;
          // A removed item goes back to stock unless it is scrapped/claimed.
          const status = b.removal_reason && /scrap|damage|burst/i.test(b.removal_reason) ? 'SCRAPPED'
            : b.removal_reason && /warranty/i.test(b.removal_reason) ? 'WARRANTY_CLAIM'
            : b.removal_reason && /retread|resole/i.test(b.removal_reason) && C.table === 'tyres' ? 'RETREADING'
            : 'IN_STOCK';
          await t.query(
            `UPDATE ${C.table} SET status = $2, removal_reason = $3, updated_at = now() WHERE id = $1::uuid`,
            [req.params.id, status, b.removal_reason ?? null]);
          // Tyres accumulate lifetime km; a removal is when that is known.
          if (C.table === 'tyres' && b.removal_km && rows[0].fitment_km) {
            await t.query(
              // Explicit casts: two bare parameters leave Postgres unable to
              // resolve the '-' operator ("operator is not unique: unknown - unknown").
              `UPDATE tyres SET total_km_run = COALESCE(total_km_run,0)
                                             + GREATEST(0::numeric, $2::numeric - $3::numeric)
                WHERE id = $1::uuid`,
              [req.params.id, Number(b.removal_km), Number(rows[0].fitment_km)]);
          }
          return { fitment: rows[0], status };
        });
        if (!out) return reply.code(409).send({ error: 'NOT_FITTED', detail: 'no live fitment to remove' });

        // ── Consumption: the cost finally leaves stock and hits the P&L ──────
        // Only when the component is actually GONE. A tyre sent for retreading
        // or back to the shelf is still ours and still stock — posting it as an
        // expense there would charge the P&L for something we still own, and
        // charge it again when it is eventually scrapped.
        let voucher = null;
        let ledgerNote = null;
        if (out.status === 'SCRAPPED' || out.status === 'WARRANTY_CLAIM') {
          const { rows: [item] } = await query(
            `SELECT serial_no, purchase_cost, consumption_voucher_id FROM ${C.table} WHERE id = $1::uuid`,
            [req.params.id]);
          const cost = money(item?.purchase_cost);
          if (cost > 0 && !item.consumption_voucher_id) {
            try {
              voucher = await postVoucher({
                type: 'JOURNAL',
                entry_date: b.removal_date ?? new Date().toISOString().slice(0, 10),
                narration: `${kind === 'tyres' ? 'Tyre' : 'Battery'} ${item.serial_no} consumed`
                  + (b.removal_reason ? ` — ${b.removal_reason}` : ''),
                source_type: kind === 'tyres' ? 'TYRE_CONSUMPTION' : 'BATTERY_CONSUMPTION',
                ref_no: `${kind.toUpperCase()}-CONSUME-${item.serial_no}`,
                created_by: b.created_by ?? null,
                // The truck it died on decides whose P&L eats it — owned only;
                // stock bought but not yet consumed stays firm-neutral.
                company_id: await ownedVehicleCompanyId(out.fitment?.vehicle_no),
                lines: [
                  { ledger: STOCK[kind].expense, dr_cr: 'DR', amount: cost, group: CONSUMPTION_GROUP },
                  { ledger: STOCK[kind].stock, dr_cr: 'CR', amount: cost, group: STOCK_GROUP },
                ],
              });
              await drain().catch(() => {});
              await query(`UPDATE ${C.table} SET consumption_voucher_id = $2::uuid WHERE id = $1::uuid`,
                [req.params.id, voucher.voucher_id]);
            } catch (err) { ledgerNote = err.message; }
          }
        }

        return {
          removed: true, ...out,
          consumption_voucher_id: voucher?.voucher_id ?? null,
          ledger_note: ledgerNote,
        };
      } catch (err) { return pgErr(reply, err); }
    });

    app.get(`/${kind}/fitments`, async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT * FROM ${C.fitTable}
          WHERE ($1::text IS NULL OR vehicle_no = upper($1))
          ORDER BY fitment_date DESC LIMIT 2000`, [req.query.vehicle_no || null]);
      return { count: rows.length, fitments: rows };
    });
  }

  // ═══ MAINTENANCE ══════════════════════════════════════════════════════════
  const MAINT_COLS = ['vehicle_id', 'vehicle_no', 'service_date', 'service_type', 'garage_name',
    'vendor_id', 'bill_no', 'bill_amount', 'odometer_km', 'next_due_km', 'next_due_date',
    'parts', 'remarks', 'bill_url', 'company', 'created_by'];

  app.get('/maintenance', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT * FROM maintenance_logs
        WHERE ($1::text IS NULL OR vehicle_no = upper($1))
          AND ($2::date IS NULL OR service_date >= $2)
          AND ($3::date IS NULL OR service_date <= $3)
        ORDER BY service_date DESC, created_at DESC LIMIT 2000`,
      [req.query.vehicle_no || null, req.query.from || null, req.query.to || null]);
    return {
      count: rows.length, logs: rows,
      total_spend: r2(rows.reduce((a, r) => a + money(r.bill_amount), 0)),
      // What is due soon is the question this screen exists to answer.
      due_soon: rows.filter((r) => r.next_due_date && r.next_due_date <= new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10)).length,
    };
  });

  app.post('/maintenance', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.vehicle_no) return reply.code(400).send({ error: 'NO_VEHICLE' });
    const body = { ...b, vehicle_no: String(b.vehicle_no).toUpperCase() };

    // A repair bill is an expense the moment it is recorded. Posted only when
    // an account is named — otherwise the log is kept and says it was not.
    let voucher = null;
    let ledgerNote = null;
    if (b.account && money(b.bill_amount) > 0) {
      try {
        voucher = await postVoucher({
          type: 'PAYMENT',
          account: b.account,
          party_ledger: b.garage_name ? `Creditors: ${b.garage_name}` : 'Repairs & Maintenance',
          party_group: b.garage_name ? 'Sundry Creditors (Vendors)' : 'Direct Expenses - Repairs & Tyres',
          amount: money(b.bill_amount),
          ref_no: b.bill_no || null,
          entry_date: body.service_date ?? new Date().toISOString().slice(0, 10),
          narration: `${b.service_type || 'Service'} — ${body.vehicle_no}${b.garage_name ? ` @ ${b.garage_name}` : ''}`,
          source_type: 'VEHICLE_MAINTENANCE',
          company: b.company ?? null,
          company_id: await ownedVehicleCompanyId(body.vehicle_no),
          created_by: b.created_by ?? null,
        });
        await drain().catch(() => {});
      } catch (err) {
        const map = { OVERDRAFT: 422, DUPLICATE_REF: 409, NO_ACCOUNT: 400 };
        if (map[err.code]) return reply.code(map[err.code]).send({ error: err.code, detail: err.message, balance: err.balance });
        ledgerNote = err.message;
      }
    }

    const u = insert('maintenance_logs', MAINT_COLS, body);
    try {
      const { rows } = await query(u.sql, u.args);
      if (voucher) {
        await query('UPDATE maintenance_logs SET voucher_id = $2::uuid WHERE id = $1::uuid', [rows[0].id, voucher.voucher_id]);
        rows[0].voucher_id = voucher.voucher_id;
      }
      reply.code(201);
      return { created: true, log: rows[0], voucher_id: voucher?.voucher_id ?? null, ledger_note: ledgerNote };
    } catch (err) { return pgErr(reply, err); }
  });

  app.patch('/maintenance/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const u = buildUpdate('maintenance_logs', MAINT_COLS, req.body ?? {});
    if (!u) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    u.args[0] = req.params.id;
    try {
      const { rows } = await query(u.sql, u.args);
      if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { updated: true, log: rows[0] };
    } catch (err) { return pgErr(reply, err); }
  });

  app.delete('/maintenance/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `DELETE FROM maintenance_logs WHERE id = $1::uuid AND voucher_id IS NULL RETURNING id`, [req.params.id]);
    // A posted bill is not deletable — reverse the voucher instead, the same
    // rule the cash book follows.
    if (!rows.length) {
      return reply.code(409).send({
        error: 'POSTED_OR_MISSING',
        detail: 'this bill is posted to the ledger — reverse its voucher instead of deleting the log',
      });
    }
    return { deleted: true };
  });
}
