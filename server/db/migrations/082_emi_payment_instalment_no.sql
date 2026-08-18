-- ═══════════════════════════════════════════════════════════════════════════
-- 082_emi_payment_instalment_no.sql — a payment covers one month, and knows
-- which instalment it was.
--
-- ── THE BUG ────────────────────────────────────────────────────────────────
-- POST /loans/post-emis wrote the INSTALMENT SERIAL into `months_paid`:
--
--     VALUES (..., $4, ...)   with   $4 = r.month_no
--
-- `months_paid` means "how many months this single payment settles" — it is 1
-- for an ordinary EMI and 3 when someone clears a quarter's arrears in one
-- transfer. The serial is which instalment of the contract it is: 44th, 48th.
-- 96 of the 150 payments therefore claim a single 1,12,987 transfer settled
-- forty-eight months. The EMI Payment History screen prints it as "Block: 48
-- Mth", which is how it was noticed.
--
-- IT IS NOT ONLY COSMETIC. DELETE /loans/:loanId/payments/:id undoes a payment
-- by subtracting months_paid from loan_master.emis_completed. Deleting any one
-- of those 96 rows would wind the loan back forty-eight instalments — a
-- one-click, silent corruption of a counter that migration 035 went out of its
-- way to make safe. Nobody has pressed it yet.
--
-- ── THE FIX IS NOT "SET IT TO 1" ───────────────────────────────────────────
-- The serial is worth keeping: it is what ties a payment to its row in
-- loan_instalments, and throwing it away to fix the display would lose the one
-- piece of information that makes a payment reconcilable against the schedule.
-- So it moves to a column that means it, and months_paid goes back to meaning
-- what it says.
--
-- Only rows where the serial is CORROBORATED are moved: the instalment of that
-- number must exist on that loan and fall due in the month the payment is for.
-- 105 rows corroborate. Anything else keeps its value and is left for a human,
-- because a payment that covered three months genuinely has months_paid = 3 and
-- must not be rewritten to 1.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE emi_payments
  ADD COLUMN IF NOT EXISTS instalment_no integer CHECK (instalment_no IS NULL OR instalment_no >= 1);

COMMENT ON COLUMN emi_payments.instalment_no IS
  'Which instalment of the contract this payment settles (1..instalment_count). '
  'Joins to loan_instalments.instalment_no. NOT months_paid — that is how many '
  'months one payment covers, and is 1 for an ordinary EMI.';
COMMENT ON COLUMN emi_payments.months_paid IS
  'How many months this single payment settles. 1 for an ordinary EMI; more '
  'only when one transfer clears several months of arrears. The DELETE path '
  'subtracts it from emis_completed, so a wrong value here corrupts the loan.';

-- Move the serial, but only where the schedule agrees it is one.
WITH corroborated AS (
  SELECT p.id, p.months_paid AS serial
    FROM emi_payments p
    JOIN loan_instalments i
      ON i.loan_id = p.loan_id
     AND i.instalment_no = p.months_paid
     AND to_char(i.due_date, 'YYYY-MM') = p.emi_month
   WHERE p.months_paid > 1
     AND p.instalment_no IS NULL
)
UPDATE emi_payments p
   SET instalment_no = c.serial,
       months_paid   = 1
  FROM corroborated c
 WHERE p.id = c.id;

-- An ordinary single-month payment knows its instalment too, where the schedule
-- can name it unambiguously.
UPDATE emi_payments p
   SET instalment_no = i.instalment_no
  FROM loan_instalments i
 WHERE i.loan_id = p.loan_id
   AND to_char(i.due_date, 'YYYY-MM') = p.emi_month
   AND p.instalment_no IS NULL
   AND p.months_paid = 1;

CREATE INDEX IF NOT EXISTS emi_payments_instalment_idx
  ON emi_payments (loan_id, instalment_no) WHERE instalment_no IS NOT NULL;

-- What is left over, so a multi-month payment that genuinely exists stays
-- visible rather than being assumed away.
CREATE OR REPLACE VIEW v_emi_payment_month_check AS
SELECT p.id, l.loan_account_no, l.vehicle_no, p.emi_month, p.months_paid,
       p.instalment_no, p.total_paid, p.payment_date, p.ref_no,
       CASE WHEN p.instalment_no IS NULL AND p.months_paid > 1
              THEN 'multi-month payment, or a serial the schedule cannot corroborate'
            WHEN p.instalment_no IS NULL
              THEN 'no instalment in this loan falls due in that month'
            ELSE 'ok' END AS note
  FROM emi_payments p
  JOIN loan_master l ON l.id = p.loan_id
 WHERE p.instalment_no IS NULL;

COMMENT ON VIEW v_emi_payment_month_check IS
  'Payments that could not be tied to an instalment. Each is either a genuine '
  'multi-month settlement or a month key that does not match the schedule — '
  'both need a person, neither should be rewritten automatically.';

COMMIT;
