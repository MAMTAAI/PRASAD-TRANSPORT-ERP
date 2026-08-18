// server/modules/loanImport.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Load the vehicle loans off the financiers' statements, strike an opening
// liability at a cut-off date, and post EMIs split into principal and interest.
//
// WHY THE OPENING BALANCE IS THE POINT OF THIS FILE. EMIs were already being
// posted — Dr the loan account with the principal, Dr finance cost with the
// interest, Cr the bank — but the loan itself had never been recognised. So
// every repayment debited a liability that was not there, and the seven loan
// ledgers ended up carrying a NET DEBIT of about 26.5 lakh between them. On the
// balance sheet that reads as the financiers owing US money. Striking the
// opening balance is what turns 26.5 lakh of phantom asset into the debt it
// actually is.
//
// WHERE THE OTHER SIDE GOES. Dr Opening Balance Difference (Capital Account),
// which is what that account is for: the counterweight to balances that predate
// the books. It is not an expense — recognising a loan that already existed
// costs the company nothing, and routing it through the P&L would invent a loss
// in the year the bookkeeping was tidied up.
//
// WHOSE NUMBER WINS. Where a lender states its own principal outstanding, that
// figure is used and the model is not consulted. IndusInd does: it prints POS,
// and it prints Interest Outstanding, and its running ledger balance is exactly
// the two added together — 16,12,468.49 = 15,80,366.49 + 32,102.00. Those three
// loans were also restructured in January 2024 and are classified NPA, so no
// clean amortisation describes them any more and pretending otherwise would put
// a tidy fiction on the balance sheet. TATA states no such figure, so its loans
// are modelled — from its own instalments, at the rate that reproduces its own
// contract value and interest to the rupee.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded, withTransaction } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { buildSchedule, positionAt, dueBetween } from '../lib/loanAmortiser.js';
import { importLedgers } from '../lib/loanStatementImport.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

const OPENING_CONTRA = 'Opening Balance Difference';
const OPENING_GROUP = 'Capital Account';
const LOAN_GROUP = 'Secured Loans';
const INTEREST_LEDGER = 'Interest on Vehicle Loans';
const INTEREST_GROUP = 'Finance Costs';
const DEFAULT_BANK = 'SBI (8490)';

// The cut-off the statements are struck at, in one place. The endpoints all take
// `as_of` and this is only the default — a statement for the year before has to
// be printable without editing code, the same rule the IOCL window follows.
const OPENING_CUTOFF = '2026-04-01';

/** 'AS26C9802' -> 'AS 26C 9802' if the fleet spells it that way; else as given. */
async function fleetSpelling(norm) {
  if (!norm) return null;
  const { rows } = await query(
    `SELECT vehicle_no FROM vehicles WHERE vehicle_no_norm = $1 LIMIT 1`, [norm]);
  return rows[0]?.vehicle_no ?? norm;
}

const loanLedgerName = (financier, vehicleNo) => `Loan: ${financier} (${vehicleNo})`;

const toIso = (d) => {
  if (!d) return null;
  const m = String(d).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);      // TATA prints dd.mm.yyyy
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(d).slice(0, 10);
};

/**
 * Rewrite a loan's instalment tiers.
 *
 * IN ONE TRANSACTION, AND IT HAS TO BE. loan_emi_tiers carries a DEFERRABLE
 * constraint trigger that checks the tiers cover instalments 1..N with no gap.
 * Deferred means "at COMMIT", and every statement outside an explicit
 * transaction commits on its own — so a delete-then-insert run statement by
 * statement fires the check after tier 1 alone is in, and a perfectly good
 * three-tier pattern is rejected because it was momentarily one tier long.
 */
async function syncTiers(loanId, slabs, printedIrr) {
  const tiers = [...(slabs ?? [])]
    .map((s) => ({ from: Number(s.from_month ?? s.from_instalment),
                   to: Number(s.to_month ?? s.to_instalment),
                   amount: Number(s.amount ?? s.emi_amount) }))
    .sort((a, b) => a.from - b.from);
  if (!tiers.length) return 0;

  return withTransaction(async (client) => {
    await client.query(`DELETE FROM loan_emi_tiers WHERE loan_id = $1::uuid`, [loanId]);
    for (const t of tiers) {
      await client.query(
        `INSERT INTO loan_emi_tiers (loan_id, from_instalment, to_instalment, emi_amount,
                printed_irr, source)
         VALUES ($1::uuid,$2,$3,$4,$5,'LENDER_CONTRACT')`,
        [loanId, t.from, t.to, t.amount, printedIrr]);
    }
    return tiers.length;
  });
}

/**
 * Write the modelled schedule out as rows.
 *
 * Modelled rows never overwrite one the lender has raised. The statement is the
 * record of what actually happened and a fresh contract import must not quietly
 * replace 47 real instalments — with their delay days and their late-payment
 * interest — with a tidy schedule that says everything fell due on the 11th.
 */
async function syncModelledInstalments(loanId, rows) {
  let n = 0;
  for (const r of rows ?? []) {
    const res = await query(
      `INSERT INTO loan_instalments (loan_id, instalment_no, due_date, due_amount,
              principal_part, interest_part, closing_principal, source)
       VALUES ($1::uuid,$2,$3::date,$4,$5,$6,$7,'MODELLED')
       ON CONFLICT (loan_id, instalment_no) DO UPDATE SET
              due_date = EXCLUDED.due_date, due_amount = EXCLUDED.due_amount,
              principal_part = EXCLUDED.principal_part, interest_part = EXCLUDED.interest_part,
              closing_principal = EXCLUDED.closing_principal
        WHERE loan_instalments.source = 'MODELLED'`,
      [loanId, r.month_no, r.date, r.emi, r.principal, r.interest, r.balance]);
    n += res.rowCount ?? 0;
  }
  return n;
}

export async function registerLoanImportRoutes(app) {
  // ── 1. load the contracts and their schedules ────────────────────────────
  app.post(
    '/import',
    { schema: { body: { type: 'object', required: ['contracts'], properties: {
      contracts: { type: 'array', maxItems: 500, items: { type: 'object' } },
      commit: { type: 'boolean', default: false },
      created_by: { type: ['string', 'null'], maxLength: 60 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { contracts = [], commit = false } = req.body ?? {};
      if (!contracts.length) return reply.code(400).send({ error: 'NO_CONTRACTS' });

      const created = [], updated = [], skipped = [], problems = [];

      for (const c of contracts) {
        try {
          if (c.is_closed) { skipped.push({ loan_no: c.loan_no, why: 'contract already fully received' }); continue; }
          const firstDue = toIso(c.first_emi_date);
          if (!firstDue || !c.emi_slabs?.length || !c.finance_amt) {
            problems.push({ loan_no: c.loan_no, why: 'missing first instalment date, slabs or principal' });
            continue;
          }

          let sched;
          if (c.ledger_emis?.length) {
            // ── LOANS THE LENDER NO LONGER AMORTISES ────────────────────────
            // IndusInd restructured these three in January 2024 — the statement
            // shows a "NET MIG Balance Amount Transfer" of 45.1 lakh — and has
            // run them ever since as a balance with a monthly Interest Demand
            // against it, not as a schedule of instalments. They are also
            // classified NPA. There is no contractual amortisation left to
            // model, and inventing one would put a tidy fiction where the bank
            // has real figures.
            //
            // So the instalments are the ones the bank actually charged and the
            // borrower actually paid. The check is the bank's own arithmetic:
            // the principal these rows imply must equal the distance its running
            // balance moved over the same window, to the paisa.
            const rows = c.ledger_emis.map((r, i) => ({
              month_no: i + 1, date: r.date, emi: Number(r.emi).toFixed(2),
              interest: Number(r.interest).toFixed(2), principal: Number(r.principal).toFixed(2),
              balance: null, source: 'lender ledger',
            }));
            const impliedPaise = rows.reduce((a, r) => a + Math.round(Number(r.principal) * 100), 0);
            const movedPaise = Math.round((Number(c.ledger_opening_balance) - Number(c.ledger_closing_balance)) * 100);
            if (impliedPaise !== movedPaise) {
              problems.push({ loan_no: c.loan_no,
                why: `ledger rows imply ${(impliedPaise / 100).toFixed(2)} of principal but the bank's `
                   + `balance moved ${(movedPaise / 100).toFixed(2)}` });
              continue;
            }
            sched = { annual_rate: c.printed_rate ?? null, rows,
                      total_emi: rows.reduce((a, r) => a + Number(r.emi), 0).toFixed(2),
                      total_interest: rows.reduce((a, r) => a + Number(r.interest), 0).toFixed(2),
                      closing_balance: '0.00' };
          } else {
            sched = buildSchedule({ principal: c.finance_amt, slabs: c.emi_slabs, firstDue,
                                    disbursal: toIso(c.disbursal_date) });
            // The schedule must repay the principal and charge the interest the
            // lender printed. If it does not, the contract was misread and it must
            // not become a liability.
            if (c.contract_value && Math.abs(Number(sched.total_emi) - Number(c.contract_value)) > 1) {
              problems.push({ loan_no: c.loan_no,
                why: `schedule totals ${sched.total_emi} against contract value ${c.contract_value}` });
              continue;
            }
            if (Math.abs(Number(sched.closing_balance)) > 1) {
              problems.push({ loan_no: c.loan_no, why: `schedule does not close (${sched.closing_balance})` });
              continue;
            }
          }

          const vehicleNo = await fleetSpelling(c.vehicle_norm);
          const existing = await query(
            `SELECT id FROM loan_master WHERE loan_account_no = $1 LIMIT 1`, [c.loan_no]);

          if (!commit) {
            (existing.rows.length ? updated : created).push({
              loan_no: c.loan_no, vehicle: vehicleNo, type: c.loan_type,
              rate: sched.annual_rate, instalments: sched.rows.length,
              total_emi: sched.total_emi, total_interest: sched.total_interest,
            });
            continue;
          }

          // tenure_months is the TERM; instalment_count is how many instalments
          // the lender collects. The two are not the same number and used to be
          // the same column — TATA's "No.of Instls" went into a field IndusInd
          // was filling with a 60-month term that collects 58. Migration 076
          // untangled the 29 rows that already existed; this keeps the next
          // import from putting them back.
          const instalments = sched.rows.length;
          const moratorium = c.moratorium_months ?? sched.moratorium_months ?? null;
          const args = [
            c.loan_no, vehicleNo, c.customer ?? null, c.customer ?? null, c.loan_type,
            c.financier, toIso(c.disbursal_date), sched.annual_rate, c.finance_amt,
            (moratorium ?? 0) + instalments, c.emi_amount, moratorium, firstDue,
            JSON.stringify(c.emi_slabs), JSON.stringify(sched.rows),
            loanLedgerName(c.financier, vehicleNo),
            instalments, sched.lead_period_days, sched.moratorium_interest,
            c.contract_value ?? null, c.interest_amt ?? null, c.printed_irr ?? null,
          ];
          const COLS = `vehicle_no=$2, owner_name=$3, company_name=$4, loan_type=$5,
                      bank_name=$6, sanction_date=$7::date, disbursal_date=$7::date,
                      rate_of_interest=$8, principal_amt=$9,
                      tenure_months=$10, emi_amount=$11, moratorium_months=$12,
                      first_emi_date=$13::date, emi_slabs=$14::jsonb,
                      repayment_schedule=$15::jsonb, financier_ledger=$16,
                      instalment_count=$17, lead_period_days=$18, moratorium_interest=$19,
                      contract_value=$20, interest_amt=$21, printed_irr=$22`;
          let loanId;
          if (existing.rows.length) {
            await query(
              `UPDATE loan_master SET ${COLS}, updated_at=now() WHERE loan_account_no=$1`, args);
            loanId = existing.rows[0].id;
            updated.push({ loan_no: c.loan_no, vehicle: vehicleNo, rate: sched.annual_rate });
          } else {
            const ins = await query(
              `INSERT INTO loan_master (loan_account_no, vehicle_no, owner_name, company_name, loan_type,
                      bank_name, sanction_date, disbursal_date, rate_of_interest, principal_amt,
                      tenure_months, emi_amount, moratorium_months, first_emi_date, emi_slabs,
                      repayment_schedule, financier_ledger, instalment_count, lead_period_days,
                      moratorium_interest, contract_value, interest_amt, printed_irr)
               VALUES ($1,$2,$3,$4,$5,$6,$7::date,$7::date,$8,$9,$10,$11,$12,$13::date,$14::jsonb,
                       $15::jsonb,$16,$17,$18,$19,$20,$21,$22)
               RETURNING id`, args);
            loanId = ins.rows[0].id;
            created.push({ loan_no: c.loan_no, vehicle: vehicleNo, rate: sched.annual_rate });
          }
          await syncTiers(loanId, c.emi_slabs, c.printed_irr ?? null);
          await syncModelledInstalments(loanId, sched.rows);
        } catch (e) {
          problems.push({ loan_no: c.loan_no, why: e.message });
        }
      }

      return { ok: true, dry_run: !commit,
        summary: { received: contracts.length, created: created.length, updated: updated.length,
                   skipped_closed: skipped.length, problems: problems.length },
        created, updated, skipped, problems };
    }
  );

  // ── 2. strike the opening liability at a cut-off ──────────────────────────
  app.post(
    '/opening-balance',
    { schema: { body: { type: 'object', properties: {
      as_of: { type: 'string', format: 'date', default: '2026-04-01' },
      commit: { type: 'boolean', default: false },
      created_by: { type: ['string', 'null'], maxLength: 60 },
      stated: { type: 'object', additionalProperties: true, default: {} },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { as_of = '2026-04-01', commit = false, stated = {} } = req.body ?? {};

      const { rows: loans } = await query(
        `SELECT loan_account_no, vehicle_no, bank_name, loan_type, company_name,
                principal_amt, first_emi_date, emi_slabs, repayment_schedule, financier_ledger
           FROM loan_master ORDER BY bank_name, loan_account_no`);

      const posted = [], skipped = [], problems = [];
      for (const l of loans) {
        try {
          const sched = { rows: l.repayment_schedule ?? [] };
          if (!sched.rows.length) { problems.push({ loan_no: l.loan_account_no, why: 'no schedule stored' }); continue; }

          // A schedule taken from a lender's transaction ledger carries no
          // running balance — the bank keeps that, we only recorded what it
          // charged and what was paid. Such a loan can only get its opening
          // figure from the lender, so demand one rather than fall back to a
          // model that does not exist for it.
          const modelled = sched.rows.every((r) => r.balance != null);
          const override = stated[l.loan_account_no];
          if (!modelled && override == null) {
            problems.push({ loan_no: l.loan_account_no,
              why: 'schedule came from the lender ledger and has no running balance, so an '
                 + 'opening principal must be supplied from the statement' });
            continue;
          }

          let pos = { emis_completed: 0, principal_outstanding: 0 };
          if (modelled) {
            for (const r of sched.rows) {
              r.balance_paise = Math.round(Number(r.balance) * 100);
              r.principal_paise = Math.round(Number(r.principal) * 100);
              r.interest_paise = Math.round(Number(r.interest) * 100);
            }
            pos = positionAt(sched, as_of);
          } else {
            pos.emis_completed = sched.rows.filter((r) => r.date < as_of).length;
          }

          const amount = override != null ? Number(override) : pos.principal_outstanding;
          const basis = override != null
            ? "the lender's own stated position"
            : 'modelled from the contract instalments';

          if (!(amount > 0)) { skipped.push({ loan_no: l.loan_account_no, why: 'nothing outstanding at the cut-off' }); continue; }

          const ledger = l.financier_ledger || loanLedgerName(l.bank_name, l.vehicle_no);
          const rec = { loan_no: l.loan_account_no, vehicle: l.vehicle_no, financier: l.bank_name,
                        type: l.loan_type, ledger, emis_completed: pos.emis_completed,
                        opening_principal: Number(amount.toFixed(2)), basis };
          if (!commit) { posted.push(rec); continue; }

          const voucher = await postVoucher({
            type: 'JOURNAL',
            source_type: 'LOAN_OPENING',
            ref_no: `LOANOPEN-${l.loan_account_no}-${as_of}`,
            entry_date: as_of,
            narration: `Opening loan liability ${as_of} — ${l.bank_name} ${l.loan_account_no} `
                     + `(${l.vehicle_no}) after ${pos.emis_completed} EMIs [${basis}]`,
            created_by: req.body.created_by ?? 'loan-import',
            lines: [
              { ledger: OPENING_CONTRA, dr_cr: 'DR', amount, group: OPENING_GROUP },
              { ledger, dr_cr: 'CR', amount, group: LOAN_GROUP },
            ],
          });

          await query(
            `UPDATE loan_master SET opening_remaining_principal=$2, opening_emis_completed=$3,
                    opening_as_of=$4::date, remaining_principal=$2, emis_completed=$3,
                    as_on_date=$4::date, financier_ledger=$5, updated_at=now()
              WHERE loan_account_no=$1`,
            [l.loan_account_no, amount, pos.emis_completed, as_of, ledger]);

          posted.push({ ...rec, voucher_id: voucher?.voucher_id ?? null });
        } catch (e) {
          if (e.code === 'DUPLICATE_REF') { skipped.push({ loan_no: l.loan_account_no, why: 'opening balance already posted' }); continue; }
          problems.push({ loan_no: l.loan_account_no, why: e.message });
        }
      }

      const total = posted.reduce((a, p) => a + p.opening_principal, 0);
      return { ok: true, dry_run: !commit, as_of,
        summary: { loans: loans.length, posted: posted.length, skipped: skipped.length,
                   problems: problems.length,
                   total_opening_liability: Number(total.toFixed(2)),
                   by_financier: posted.reduce((a, p) => {
                     a[p.financier] = Number(((a[p.financier] ?? 0) + p.opening_principal).toFixed(2)); return a; }, {}) },
        posted, skipped, problems };
    }
  );

  // ── the tracker: every instalment, and where it stands ───────────────────
  // PAID / OVERDUE / UPCOMING is decided per instalment, not per loan, because
  // these accounts are settled two and three months in arrears — February's EMI
  // was paid on 9 May — so a loan can be simultaneously up to date on one month
  // and overdue on another. Anything else would either flatter the position or
  // raise an alarm on a loan that is merely paid late by habit.
  app.get(
    '/emi-tracker',
    { schema: { querystring: { type: 'object', properties: {
      as_of: { type: ['string', 'null'], format: 'date' },
      loan_no: { type: ['string', 'null'], maxLength: 40 },
      months_ahead: { type: 'integer', minimum: 0, maximum: 60, default: 6 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const asOf = req.query.as_of || new Date().toISOString().slice(0, 10);
      const ahead = req.query.months_ahead ?? 6;

      const { rows: loans } = await query(
        `SELECT id, loan_account_no, vehicle_no, bank_name, loan_type, company_name,
                principal_amt, emi_amount, repayment_schedule, financier_ledger,
                opening_remaining_principal, opening_as_of
           FROM loan_master
          WHERE ($1::text IS NULL OR loan_account_no = $1)
          ORDER BY bank_name, loan_account_no`, [req.query.loan_no || null]);

      const { rows: paid } = await query(
        `SELECT loan_id, emi_month, total_paid, principal_part, interest_part, payment_date
           FROM emi_payments`);
      const paidBy = new Map();
      const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      for (const p of paid) {
        const m = String(p.emi_month ?? '');
        // Normalise both spellings the table has collected: '2026-04' and 'Apr-2026'.
        let key = m;
        const alt = m.match(/^([A-Za-z]{3})-(\d{4})$/);
        if (alt) key = `${alt[2]}-${String(MON.indexOf(alt[1]) + 1).padStart(2, '0')}`;
        paidBy.set(`${p.loan_id}|${key}`, p);
      }

      const horizon = new Date(`${asOf}T00:00:00Z`);
      horizon.setUTCMonth(horizon.getUTCMonth() + ahead);
      const horizonIso = horizon.toISOString().slice(0, 10);

      const out = [];
      const totals = { PAID: 0, OVERDUE: 0, UPCOMING: 0, SETTLED_IN_OPENING: 0 };
      const money = { paid: 0, overdue: 0, upcoming: 0 };

      for (const l of loans) {
        // Instalments that fell due before the opening balance was struck are
        // not outstanding — they are the reason the opening balance is what it
        // is. 43 EMIs had been paid on each TATA loan by 01-04-2026, and the
        // ledger records their effect as one figure rather than as 43 rows, so
        // there is nothing here to match them against. Calling them OVERDUE
        // would report 6.96 crore of arrears on debts that were settled years
        // ago, and bury the handful of instalments genuinely in default.
        const openedOn = l.opening_as_of ? String(l.opening_as_of).slice(0, 10) : null;
        const rows = (l.repayment_schedule ?? []).map((r) => {
          const ym = String(r.date).slice(0, 7);
          const hit = paidBy.get(`${l.id}|${ym}`);
          const preOpening = openedOn && r.date < openedOn;
          const status = hit ? 'PAID'
                       : preOpening ? 'SETTLED_IN_OPENING'
                       : (r.date < asOf ? 'OVERDUE' : 'UPCOMING');
          return { month_no: r.month_no, due_date: r.date, emi: Number(r.emi),
                   principal: Number(r.principal), interest: Number(r.interest),
                   balance: r.balance == null ? null : Number(r.balance),
                   status, paid_on: hit?.payment_date ?? null,
                   paid_amount: hit ? Number(hit.total_paid) : null };
        });
        for (const r of rows) {
          totals[r.status]++;
          if (r.status === 'PAID') money.paid += r.emi;
          else if (r.status === 'OVERDUE') money.overdue += r.emi;
          else if (r.due_date <= horizonIso) money.upcoming += r.emi;
        }
        const overdue = rows.filter((r) => r.status === 'OVERDUE');
        const upcoming = rows.filter((r) => r.status === 'UPCOMING' && r.due_date <= horizonIso);
        out.push({
          loan_no: l.loan_account_no, vehicle: l.vehicle_no, financier: l.bank_name,
          loan_type: l.loan_type, company: l.company_name,
          principal: Number(l.principal_amt), emi_amount: Number(l.emi_amount ?? 0),
          ledger: l.financier_ledger,
          opening_principal: l.opening_remaining_principal == null ? null : Number(l.opening_remaining_principal),
          opening_as_of: l.opening_as_of,
          instalments: rows.length,
          paid_count: rows.filter((r) => r.status === 'PAID').length,
          overdue_count: overdue.length,
          overdue_amount: Number(overdue.reduce((a, r) => a + r.emi, 0).toFixed(2)),
          next_due: upcoming[0] ?? null,
          upcoming: upcoming.slice(0, ahead),
          schedule: rows,
        });
      }

      return { as_of: asOf, horizon: horizonIso, loans: out.length,
               totals, money: { paid: Number(money.paid.toFixed(2)),
                                overdue: Number(money.overdue.toFixed(2)),
                                upcoming: Number(money.upcoming.toFixed(2)) },
               tracker: out };
    }
  );

  // ── 3. post the EMIs that fell due in a window ────────────────────────────
  app.post(
    '/post-emis',
    { schema: { body: { type: 'object', properties: {
      from: { type: 'string', format: 'date', default: '2026-04-01' },
      to: { type: 'string', format: 'date', default: '2026-08-31' },
      bank_ledger: { type: 'string', default: DEFAULT_BANK },
      commit: { type: 'boolean', default: false },
      created_by: { type: ['string', 'null'], maxLength: 60 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { from = '2026-04-01', to = '2026-08-31',
              bank_ledger = DEFAULT_BANK, commit = false } = req.body ?? {};

      const { rows: loans } = await query(
        `SELECT id, loan_account_no, vehicle_no, bank_name, company_name, repayment_schedule, financier_ledger
           FROM loan_master ORDER BY bank_name, loan_account_no`);

      const posted = [], skipped = [], problems = [];
      for (const l of loans) {
        const rows = (l.repayment_schedule ?? []).filter((x) => x.date >= from && x.date <= to);
        for (const r of rows) {
          const principal = Number(r.principal), interest = Number(r.interest), emi = Number(r.emi);
          if (!(emi > 0)) continue;
          // The moratorium instalments do not cover their own interest, so the
          // principal component is negative and the debt grows. Posting a
          // negative debit is not a thing TARA will accept, and nor should it —
          // that month is a finance cost plus a further borrowing, not a
          // repayment, and it needs a human to say so.
          if (principal <= 0) {
            skipped.push({ loan_no: l.loan_account_no, due: r.date,
                           why: `instalment ${r.month_no} does not cover its interest (principal ${r.principal})` });
            continue;
          }
          // ── DO NOT PAY THE SAME MONTH TWICE ───────────────────────────────
          // 42 EMIs were already recorded for February to May 2026 by an
          // earlier run, under references of the form HIST-EMI-<random>. Nothing
          // about that key can be reconstructed here, so TARA's duplicate guard
          // — which matches on the reference — would not catch them and every
          // one of those months would be charged to the bank a second time.
          // The month the instalment BELONGS to is the natural key, so that is
          // what is checked, in whichever of the two spellings is on the row.
          // Deliberately NOT the payment date: these EMIs are settled two and
          // three months in arrears — February's was paid on 9 May — so matching
          // on when money moved would suppress a genuine April instalment
          // because some unrelated March EMI happened to be paid in April.
          const ym = r.date.slice(0, 7);
          const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const alt = `${MON[Number(ym.slice(5, 7)) - 1]}-${ym.slice(0, 4)}`;
          const already = await query(
            `SELECT 1 FROM emi_payments
              WHERE loan_id = $1::uuid AND (emi_month = $2 OR emi_month = $3) LIMIT 1`,
            [l.id, ym, alt]);
          if (already.rows.length) {
            skipped.push({ loan_no: l.loan_account_no, due: r.date, why: 'this month is already recorded' });
            continue;
          }

          const ledger = l.financier_ledger || loanLedgerName(l.bank_name, l.vehicle_no);
          const rec = { loan_no: l.loan_account_no, vehicle: l.vehicle_no, due: r.date,
                        month_no: r.month_no, emi, principal, interest };
          if (!commit) { posted.push(rec); continue; }

          try {
            const voucher = await postVoucher({
              type: 'JOURNAL',
              source_type: 'LOAN_EMI',
              ref_no: `LOANEMI-${l.loan_account_no}-${r.date}`,
              entry_date: r.date,
              narration: `EMI ${r.month_no}/${(l.repayment_schedule ?? []).length} ${l.vehicle_no} `
                       + `${l.bank_name} (P ${r.principal} + I ${r.interest})`,
              created_by: req.body.created_by ?? 'loan-import',
              lines: [
                { ledger, dr_cr: 'DR', amount: principal, group: LOAN_GROUP },
                { ledger: INTEREST_LEDGER, dr_cr: 'DR', amount: interest, group: INTEREST_GROUP },
                { ledger: bank_ledger, dr_cr: 'CR', amount: emi, group: 'Bank Accounts' },
              ],
            });
            await query(
              `INSERT INTO emi_payments (loan_id, payment_date, emi_month, months_paid,
                      principal_part, interest_part, total_paid, payment_mode, ref_no,
                      paid_from_account, voucher_id, company, created_by)
               VALUES ($1::uuid,$2::date,$3,$4,$5,$6,$7,'BANK',$8,$9,$10::uuid,$11,$12)`,
              [l.id, r.date, r.date.slice(0, 7), r.month_no, principal, interest, emi,
               `LOANEMI-${l.loan_account_no}-${r.date}`, bank_ledger,
               voucher?.voucher_id ?? null, l.company_name ?? null, req.body.created_by ?? 'loan-import']);
            posted.push({ ...rec, voucher_id: voucher?.voucher_id ?? null });
          } catch (e) {
            if (e.code === 'DUPLICATE_REF') { skipped.push({ loan_no: l.loan_account_no, due: r.date, why: 'already posted' }); continue; }
            problems.push({ loan_no: l.loan_account_no, due: r.date, why: e.message });
          }
        }
      }

      const sum = (k) => Number(posted.reduce((a, p) => a + p[k], 0).toFixed(2));
      return { ok: true, dry_run: !commit, from, to,
        summary: { emis_posted: posted.length, skipped: skipped.length, problems: problems.length,
                   total_emi: sum('emi'), total_principal: sum('principal'), total_interest: sum('interest') },
        posted: posted.slice(0, 40), skipped: skipped.slice(0, 20), problems: problems.slice(0, 20) };
    }
  );

  // ── 4. load a lender's own transaction ledger ────────────────────────────
  app.post(
    '/statement-import',
    { schema: { body: { type: 'object', required: ['ledgers'], properties: {
      ledgers: { type: 'array', maxItems: 500, items: { type: 'object' } },
      commit: { type: 'boolean', default: false },
      statement_as_of: { type: ['string', 'null'], format: 'date' },
      created_by: { type: ['string', 'null'], maxLength: 60 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { ledgers = [], commit = false, statement_as_of = null } = req.body ?? {};
      if (!ledgers.length) return reply.code(400).send({ error: 'NO_LEDGERS' });
      const out = await importLedgers(query, ledgers,
        { commit, statementAsOf: statement_as_of, createdBy: req.body.created_by });
      return { ok: true, ...out };
    }
  );

  // ── 5. the ledger statement ──────────────────────────────────────────────
  // Start-to-end history of one loan, with the opening balance struck at a
  // cut-off. This is what the printable statement renders and what an auditor
  // reads, so everything it needs comes back in ONE response — a screen that
  // has to make four calls to print a statement will print a half-built one the
  // first time a request is slow.
  app.get(
    '/ledger',
    { schema: { querystring: { type: 'object', properties: {
      loan_no: { type: ['string', 'null'], maxLength: 40 },
      vehicle_no: { type: ['string', 'null'], maxLength: 20 },
      as_of: { type: ['string', 'null'], format: 'date' },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const asOf = req.query.as_of || OPENING_CUTOFF;
      const loanNo = req.query.loan_no || null;
      const vehicleNo = req.query.vehicle_no || null;
      if (!loanNo && !vehicleNo) {
        return reply.code(400).send({ error: 'NO_SELECTION',
          detail: 'give a loan_no or a vehicle_no' });
      }

      const { rows: heads } = await query(
        `SELECT * FROM v_loan_statement_header
          WHERE ($1::text IS NULL OR loan_account_no = $1)
            AND ($2::text IS NULL OR vehicle_no = $2)
          ORDER BY loan_account_no`, [loanNo, vehicleNo]);
      if (!heads.length) return reply.code(404).send({ error: 'NO_SUCH_LOAN' });

      const ids = heads.map((h) => h.loan_id);
      const [{ rows: ledger }, { rows: opening }, { rows: charges }, { rows: health }] =
        await Promise.all([
          query(`SELECT * FROM v_loan_ledger WHERE loan_id = ANY($1::uuid[])
                  ORDER BY loan_account_no, instalment_no`, [ids]),
          query(`SELECT * FROM loan_opening_balance($1::date)
                  WHERE loan_id = ANY($2::uuid[])`, [asOf, ids]),
          query(`SELECT loan_id, head, charge_date, charged, recovered, outstanding, is_penal
                   FROM loan_charges WHERE loan_id = ANY($1::uuid[])
                  ORDER BY is_penal DESC, head`, [ids]),
          query(`SELECT * FROM v_loan_ledger_health WHERE loan_id = ANY($1::uuid[])`, [ids]),
        ]);

      const by = (rows) => rows.reduce((m, r) => {
        (m[r.loan_id] ??= []).push(r); return m; }, {});
      const ledgerBy = by(ledger), chargeBy = by(charges);
      const openBy = Object.fromEntries(opening.map((o) => [o.loan_id, o]));
      const healthBy = Object.fromEntries(health.map((h) => [h.loan_id, h]));

      const loans = heads.map((h) => {
        const rows = ledgerBy[h.loan_id] ?? [];
        const open = openBy[h.loan_id] ?? null;
        const ch = chargeBy[h.loan_id] ?? [];
        // The statement's own arithmetic, so the page never has to add up money
        // in JavaScript floats to fill in a total.
        const since = rows.filter((r) => r.due_date >= asOf);
        const num = (v) => Number(v ?? 0);
        return {
          ...h,
          opening: open,
          // Undated charges are reported BESIDE the opening balance, never
          // inside it. They are real and they are owed; what the lender does not
          // state is when they were raised, and a cut-off cannot be applied to a
          // figure that has no date. Folding them in would make the balance look
          // more precise than the paper it came from.
          charges: ch,
          totals: {
            demanded: num(h.total_demanded),
            received: num(h.total_received),
            outstanding: Number((num(h.total_demanded) - num(h.total_received)).toFixed(2)),
            due_since_cutoff: Number(since.reduce((a, r) => a + num(r.due_amount), 0).toFixed(2)),
            instalments_since_cutoff: since.length,
            overdue_interest_accrued:
              Number(rows.reduce((a, r) => a + num(r.overdue_interest), 0).toFixed(2)),
            paid_late: rows.filter((r) => r.status === 'PAID_LATE').length,
            worst_delay_days: rows.reduce((a, r) => Math.max(a, r.delay_days ?? 0), 0),
          },
          health: healthBy[h.loan_id] ?? null,
          rows,
        };
      });

      return { as_of: asOf, loans: loans.length, statement: loans };
    }
  );
}
