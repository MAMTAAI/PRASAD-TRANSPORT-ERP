-- ═══════════════════════════════════════════════════════════════════════════
-- 076_loan_term_reconcile.sql — make tenure_months mean the term on all 29.
--
-- 074 split the instalment count out of tenure_months and left v_loan_term_check
-- to report what could not be squared. It reported all 26 TATA loans, and the
-- reason is now unambiguous:
--
--     tenure_months = moratorium_months + instalment_count
--
--     IndusInd  60 = 2 + 58   ✓ already right — a 60-month facility that
--                               collects 58 instalments after a two-month
--                               moratorium.
--     TATA      58 = 1 + 58   ✗ 58 is the instalment count. The import read it
--                               from "No.of Instls" and wrote it to a column
--                               that means the term.
--
-- The term is not a guess. Contract 5004384745 pays out on 14-07-2022, would
-- have collected its first instalment on 11-08-2022 had there been no
-- moratorium, and in fact collects it on 11-09-2022 — exactly one instalment
-- month skipped, so 59 months of term carrying 58 instalments.
--
-- Only the loans that fail the identity are touched, and only where the
-- moratorium is known, so re-running converges and a loan whose paperwork
-- disagrees stays visible in the view rather than being quietly rounded into
-- agreement.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE loan_master
   SET tenure_months = COALESCE(moratorium_months, 0) + instalment_count,
       updated_at    = now()
 WHERE instalment_count IS NOT NULL
   AND moratorium_months IS NOT NULL
   AND tenure_months IS DISTINCT FROM COALESCE(moratorium_months, 0) + instalment_count
   -- The correction only makes sense where tenure_months was carrying the
   -- instalment count. A term that disagrees for some other reason is a
   -- question for a human, not something to overwrite.
   AND tenure_months = instalment_count;

COMMIT;
