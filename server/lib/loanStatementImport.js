// server/lib/loanStatementImport.js
// ─────────────────────────────────────────────────────────────────────────────
// Load a lender's own transaction ledger into loan_instalments / loan_receipts /
// loan_charges.
//
// ONE IMPLEMENTATION, TWO DOORS. The route at POST /api/v1/loans/statement-import
// and the bulk loader at scripts/load-loan-statements.mjs both call `importLedgers`
// below. A statement loaded from the command line and one posted by the app must
// produce identical rows, and the only way to guarantee that is for there to be
// one piece of code.
//
// IDEMPOTENT BY REPLACEMENT. Instalments, receipts and charges sourced from a
// lender statement are a MIRROR — they carry no voucher, no GL link, and nothing
// downstream holds their ids. So a re-import deletes this loan's statement-sourced
// rows and writes them again, which converges exactly whether the statement grew
// by two months or was corrected in the middle. Trying to merge row-by-row into a
// ledger the lender renumbers at will is how a duplicate instalment 34 appears and
// quietly adds 1.13 lakh to the arrears.
//
// WHAT IS NOT REPLACED: emi_payments and everything in ledger_entries. Those are
// OUR book, they carry vouchers, and TARA owns them. This file never touches them
// and never posts to the GL — the gap between the lender's receipts and our
// emi_payments is the reconciliation, and it only exists while both sides are
// kept independently.
//
// MODELLED ROWS SURVIVE. An instalment the lender has not raised yet — fourteen
// of 5004384745's fifty-eight — still has a modelled due date and amount, and the
// statement import leaves those alone. Overwriting the whole schedule with only
// what has been billed so far would truncate every loan at today and make a
// start-to-end statement impossible.
// ─────────────────────────────────────────────────────────────────────────────

import { withTransaction } from '../db/pool.js';

/** Charge heads that exist because the account went into default. */
const PENAL_HEADS = [
  'lpc', 'bounce', 'penal', 'legal', 'repossession', 'valuation', 'seizure', 'odc',
];
/** Deducted at disbursal. Never owed, so never arrears. */
const NON_PENAL_HEADS = ['stamp', 'processing', 'documentation', 'insurance'];

export function isPenalHead(head) {
  const h = String(head ?? '').toLowerCase();
  if (NON_PENAL_HEADS.some((k) => h.includes(k))) return false;
  return PENAL_HEADS.some((k) => h.includes(k));
}

const money = (v) => (v == null ? null : Number(v));

/**
 * @param query   async (sql, params) => { rows }
 * @param ledgers parsed statements, as tools/loan_recon/loan_ledger_parser.py emits
 * @param opts    { commit, statementAsOf, createdBy }
 */
export async function importLedgers(query, ledgers, opts = {}) {
  const { commit = false, statementAsOf = null } = opts;
  const loaded = [], skipped = [], problems = [];

  for (const led of ledgers ?? []) {
    const loanNo = led.loan_no;
    try {
      if (led.problems?.length) {
        skipped.push({ loan_no: loanNo, why: `statement did not reconcile: ${led.problems[0]}` });
        continue;
      }
      const { rows: found } = await query(
        `SELECT id, instalment_count FROM loan_master WHERE loan_account_no = $1 LIMIT 1`, [loanNo]);
      if (!found.length) {
        // A contract on the lender's paper that the ERP has never heard of is a
        // finding, not a row to invent. 5003502544 matured in October 2024 and
        // was never migrated; loading its ledger against a loan record that does
        // not exist would put four years of instalments nowhere.
        skipped.push({ loan_no: loanNo, why: 'no loan_master row with this account number' });
        continue;
      }
      const loanId = found[0].id;
      const demands = led.demands ?? [];
      const receipts = led.receipts ?? [];

      // An instalment beyond the contracted count means the statement and the
      // contract disagree about the term. Refuse — a 59th instalment on a
      // 58-instalment loan is either a misread serial or a restructure, and both
      // need a human.
      const count = found[0].instalment_count;
      const over = count ? demands.filter((d) => d.instalment_no > count) : [];
      if (over.length) {
        problems.push({ loan_no: loanNo,
          why: `statement raises instalment ${over[0].instalment_no} on a ${count}-instalment contract` });
        continue;
      }

      const rec = {
        loan_no: loanNo, loan_id: loanId,
        instalments: demands.length, receipts: receipts.length,
        demanded: Number(demands.reduce((a, d) => a + d.amount, 0).toFixed(2)),
        received: Number(receipts.reduce((a, r) => a + r.amount, 0).toFixed(2)),
        charge_heads: (led.charge_heads ?? []).length,
        penal_outstanding: Number((led.charge_heads ?? [])
          .filter((h) => isPenalHead(h.head))
          .reduce((a, h) => a + h.outstanding, 0).toFixed(2)),
      };
      if (!commit) { loaded.push(rec); continue; }

      // ── ONE TRANSACTION PER LOAN ────────────────────────────────────────
      // The replace is a DELETE followed by inserts, and outside a transaction
      // every one of those commits on its own. The first run of this loader
      // failed on a type error partway through and left the receipts written
      // and the instalments not — a loan that had been half-replaced, which the
      // reconciliation view then read as a genuine shortfall. All of a loan's
      // statement rows land together or none of them do.
      await withTransaction(async (client) => {
        const q = (sql, params) => client.query(sql, params);

        await q(`DELETE FROM loan_receipts WHERE loan_id = $1::uuid AND source = 'LENDER_STATEMENT'`,
          [loanId]);
        for (const r of receipts) {
          await q(
            `INSERT INTO loan_receipts (loan_id, value_date, cleared_date, amount, document_no,
                    lender_running_dues, delay_days, overdue_interest, stmt_seq, source)
             VALUES ($1::uuid,$2::date,$3::date,$4,$5,$6,$7,$8,$9,'LENDER_STATEMENT')
             ON CONFLICT DO NOTHING`,
            [loanId, r.value_date ?? r.cleared_date, r.cleared_date ?? r.value_date, r.amount,
             r.document_no ?? null, money(r.running_dues), r.delay_days ?? null,
             money(r.overdue_interest), r.seq ?? null]);
        }

        await q(`DELETE FROM loan_charges WHERE loan_id = $1::uuid AND source = 'LENDER_STATEMENT'`,
          [loanId]);
        for (const h of led.charge_heads ?? []) {
          await q(
            `INSERT INTO loan_charges (loan_id, head, charge_date, charged, recovered,
                    outstanding, is_penal, source)
             VALUES ($1::uuid,$2,NULL,$3,$4,$5,$6,'LENDER_STATEMENT')
             ON CONFLICT (loan_id, head, source) DO UPDATE
               SET charged = EXCLUDED.charged, recovered = EXCLUDED.recovered,
                   outstanding = EXCLUDED.outstanding, is_penal = EXCLUDED.is_penal`,
            [loanId, h.head, h.charged, h.recovered, h.outstanding, isPenalHead(h.head)]);
        }

        // The modelled principal/interest split describes the instalment the
        // model built. Where the lender's amount for that instalment differs,
        // the split no longer describes it and is cleared rather than left to
        // look authoritative.
        //
        // $8 IS CAST EXPLICITLY. Without it COALESCE($8, 0) takes its type from
        // the integer literal, Postgres decides the parameter is an integer,
        // and 92.08 of late-payment interest is rejected as bad syntax — on a
        // numeric(14,2) column that would have taken it happily.
        for (const d of demands) {
          await q(
            `INSERT INTO loan_instalments (loan_id, instalment_no, due_date, due_amount,
                    raised_on, lender_running_dues, delay_days, overdue_interest,
                    document_no, source)
             VALUES ($1::uuid,$2,$3::date,$4,$5::date,$6,$7,COALESCE($8::numeric,0),$9,
                     'LENDER_STATEMENT')
             ON CONFLICT (loan_id, instalment_no) DO UPDATE SET
                    due_date = EXCLUDED.due_date,
                    due_amount = EXCLUDED.due_amount,
                    raised_on = EXCLUDED.raised_on,
                    lender_running_dues = EXCLUDED.lender_running_dues,
                    delay_days = EXCLUDED.delay_days,
                    overdue_interest = EXCLUDED.overdue_interest,
                    document_no = EXCLUDED.document_no,
                    source = 'LENDER_STATEMENT',
                    principal_part = CASE WHEN abs(loan_instalments.due_amount - EXCLUDED.due_amount) <= 1
                                          THEN loan_instalments.principal_part ELSE NULL END,
                    interest_part  = CASE WHEN abs(loan_instalments.due_amount - EXCLUDED.due_amount) <= 1
                                          THEN loan_instalments.interest_part ELSE NULL END,
                    closing_principal = CASE WHEN abs(loan_instalments.due_amount - EXCLUDED.due_amount) <= 1
                                          THEN loan_instalments.closing_principal ELSE NULL END`,
            [loanId, d.instalment_no, d.due_date, d.amount, d.raised_on ?? null,
             money(d.running_dues), d.delay_days ?? null, money(d.overdue_interest),
             d.document_no ?? null]);
        }

        await q(
          `UPDATE loan_master SET statement_as_of = COALESCE($2::date, statement_as_of),
                  updated_at = now() WHERE id = $1::uuid`,
          [loanId, statementAsOf]);
      });

      loaded.push(rec);
    } catch (e) {
      problems.push({ loan_no: loanNo, why: e.message });
    }
  }

  const sum = (k) => Number(loaded.reduce((a, r) => a + (r[k] ?? 0), 0).toFixed(2));
  return {
    dry_run: !commit,
    summary: {
      statements: (ledgers ?? []).length,
      loaded: loaded.length, skipped: skipped.length, problems: problems.length,
      instalments: loaded.reduce((a, r) => a + r.instalments, 0),
      receipts: loaded.reduce((a, r) => a + r.receipts, 0),
      total_demanded: sum('demanded'),
      total_received: sum('received'),
      penal_outstanding: sum('penal_outstanding'),
    },
    loaded, skipped, problems,
  };
}
