-- ═══════════════════════════════════════════════════════════════════════════
-- 083_move_loan_counters.sql — move the loan counters by the payments that
-- were recorded but never applied, and fix the view that mis-measured them.
--
-- ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
-- POST /loans/post-emis inserts into emi_payments with a plain query() and
-- never touches loan_master. /loans/:id/emi moves the counters inside the same
-- transaction as the insert, which is the whole point of 035. So 108 payments
-- carrying 83.2 lakh of principal went in without the liability ever coming
-- down, and v_loan_reconciliation reported drift on all 29 loans.
--
-- ── AND WHAT THE VIEW GOT WRONG ────────────────────────────────────────────
-- The drift it reported was too big, because its formula is
--
--     expected_remaining = opening_remaining_principal - SUM(all principal_part)
--
-- and that double-counts. `opening_remaining_principal` is the balance AT THE
-- CUT-OFF (01-04-2026): every instalment that fell due before it is already
-- inside that figure — that is what an opening balance IS. 21 of the 150
-- payments are for February and March 2026, worth 15.6 lakh of principal, and
-- subtracting them again charges the same repayment to the loan twice.
--
-- The proof is that it goes negative. Applied literally, seven body loans end
-- at MINUS 27,689 — a loan that owes less than nothing. Counting only the
-- instalments due on or after the cut-off, the same seven end at 0.00, which is
-- what a fully repaid loan should say.
--
--     remaining = opening - SUM(principal WHERE emi_month >= opening month)
--
-- ── THE 49 RUPEES ──────────────────────────────────────────────────────────
-- Three body loans still overshoot, by 49.24, 49.24 and 49.10. That is not an
-- error to hide: the opening balance was MODELLED (1,12,891.27) and the lender's
-- actual remaining instalments repay 1,12,940.51. A 49-rupee gap between a model
-- and a contract on a loan at its 47th of 47 instalments. The counter is floored
-- at zero and the loan closed, and the overshoot is reported by the view rather
-- than absorbed silently.
--
-- ── INTEREST HAS NO OPENING, SO IT IS GIVEN ONE ────────────────────────────
-- 035 froze an opening for principal and for the EMI count, and nothing for
-- interest — so total_interest_paid has been accumulating against no baseline
-- and today holds a partial figure on 17 loans and NULL on 12. There is no
-- honest way to reconstruct interest paid before the books existed: it was paid
-- over four years, on paper, by a lender that states balances and not interest
-- history.
--
-- So the baseline is stated instead of guessed. opening_total_interest_paid is
-- frozen at 0 and the column means INTEREST PAID SINCE THE CUT-OFF. A figure
-- with a clear meaning and a known start beats a larger one nobody can source.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE loan_master
  ADD COLUMN IF NOT EXISTS opening_total_interest_paid numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS counters_moved_at timestamptz;

COMMENT ON COLUMN loan_master.opening_total_interest_paid IS
  'Frozen at 0: interest paid before the opening cut-off is not on record and '
  'cannot be reconstructed. total_interest_paid therefore means interest paid '
  'SINCE opening_as_of, which is a figure with a source.';
COMMENT ON COLUMN loan_master.total_interest_paid IS
  'Interest paid since opening_as_of. See opening_total_interest_paid.';

-- ── the move ───────────────────────────────────────────────────────────────
WITH since_cutoff AS (
  SELECT l.id AS loan_id,
         -- The cut-off as a YYYY-MM key, to compare against emi_month. A
         -- payment FOR the cut-off month is after it; the opening balance is
         -- struck before that instalment falls due.
         to_char(COALESCE(l.opening_as_of, DATE '2026-04-01'), 'YYYY-MM') AS from_month,
         COALESCE(SUM(p.principal_part), 0) AS pri,
         COALESCE(SUM(p.interest_part), 0)  AS intr,
         count(p.id)                        AS n
    FROM loan_master l
    LEFT JOIN emi_payments p
      ON p.loan_id = l.id
     AND p.emi_month >= to_char(COALESCE(l.opening_as_of, DATE '2026-04-01'), 'YYYY-MM')
   GROUP BY l.id, l.opening_as_of
)
UPDATE loan_master l
   SET remaining_principal = GREATEST(0, COALESCE(l.opening_remaining_principal, 0) - s.pri),
       emis_completed      = COALESCE(l.opening_emis_completed, 0) + s.n,
       total_interest_paid = l.opening_total_interest_paid + s.intr,
       -- Same threshold /loans/:id/emi uses, so a loan closed by the backfill
       -- and one closed by a payment mean the same thing.
       payment_status      = CASE
                               WHEN COALESCE(l.opening_remaining_principal, 0) - s.pri <= 10
                                 THEN 'CLOSED' ELSE 'ACTIVE' END,
       counters_moved_at   = now(),
       updated_at          = now()
  FROM since_cutoff s
 WHERE s.loan_id = l.id;

-- ── the view, measuring the same thing the counter now holds ───────────────
-- Dropped and rebuilt rather than replaced: CREATE OR REPLACE can only append
-- columns and this one gains two in the middle. Nothing else in the schema
-- depends on it (checked) — GET /loans joins it at query time, which does not
-- pin the shape.
DROP VIEW IF EXISTS v_loan_reconciliation;

CREATE VIEW v_loan_reconciliation AS
SELECT l.id, l.loan_account_no, l.vehicle_no, l.bank_name,
       l.principal_amt, l.opening_remaining_principal, l.opening_as_of,
       l.remaining_principal                              AS stored_remaining,
       COALESCE(p.principal_paid, 0)::numeric(14,2)       AS principal_paid_since,
       COALESCE(p.principal_before, 0)::numeric(14,2)     AS principal_before_cutoff,
       GREATEST(0, l.opening_remaining_principal - COALESCE(p.principal_paid, 0))::numeric(14,2)
                                                          AS expected_remaining,
       (l.remaining_principal
        - GREATEST(0, l.opening_remaining_principal - COALESCE(p.principal_paid, 0)))::numeric(14,2)
                                                          AS drift,
       -- Where the instalments actually recorded repay MORE than the modelled
       -- opening balance. Small and real: the model and the contract disagree
       -- by a few tens of rupees on a loan in its final month.
       GREATEST(0, COALESCE(p.principal_paid, 0) - l.opening_remaining_principal)::numeric(14,2)
                                                          AS overpaid_vs_model,
       COALESCE(p.n, 0)::int                              AS payments_recorded,
       COALESCE(p.n_before, 0)::int                       AS payments_before_cutoff,
       l.emis_completed, l.opening_emis_completed,
       l.payment_status
  FROM loan_master l
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE emi_month >= to_char(COALESCE(l.opening_as_of, DATE '2026-04-01'), 'YYYY-MM')) AS n,
           count(*) FILTER (WHERE emi_month <  to_char(COALESCE(l.opening_as_of, DATE '2026-04-01'), 'YYYY-MM')) AS n_before,
           SUM(principal_part) FILTER (WHERE emi_month >= to_char(COALESCE(l.opening_as_of, DATE '2026-04-01'), 'YYYY-MM')) AS principal_paid,
           SUM(principal_part) FILTER (WHERE emi_month <  to_char(COALESCE(l.opening_as_of, DATE '2026-04-01'), 'YYYY-MM')) AS principal_before
      FROM emi_payments WHERE loan_id = l.id) p ON true;

COMMENT ON VIEW v_loan_reconciliation IS
  'drift <> 0 means the stored remaining_principal and the payments recorded '
  'SINCE THE OPENING CUT-OFF disagree. Payments for months before the cut-off '
  'are already inside opening_remaining_principal and are counted separately as '
  'principal_before_cutoff — subtracting them again charges a repayment twice.';

COMMIT;
