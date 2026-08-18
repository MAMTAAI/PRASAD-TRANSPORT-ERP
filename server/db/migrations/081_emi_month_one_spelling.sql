-- ═══════════════════════════════════════════════════════════════════════════
-- 081_emi_month_one_spelling.sql — one spelling for the month an EMI belongs to.
--
-- emi_payments.emi_month holds the month an instalment is FOR, which on these
-- accounts is rarely the month it was paid in: 'Apr-2026' was settled between
-- 24-05-2026 and 09-07-2026. So it is the only key that identifies an
-- instalment, and it has been stored two ways:
--
--     '2026-04'    108 rows   written by POST /loans/post-emis
--     'Apr-2026'    42 rows   written by the browser (toLocaleString('short'))
--
-- The same month under two labels. On the EMI Payment History screen they print
-- raw and sort apart, so April 2026 appears twice in a list that is supposed to
-- be one row per truck per month. Worse, the duplicate guard in /post-emis has
-- to test BOTH spellings to avoid charging a month twice — a workaround that is
-- one forgotten OR away from paying an EMI a second time. `emi-tracker` carries
-- the same workaround for the same reason.
--
-- Canonical is YYYY-MM: it sorts, it groups, and it is the same shape the
-- instalment ledger uses. The CHECK is what stops it drifting again — the two
-- spellings existed because nothing prevented the second one, and normalising
-- without constraining just resets the clock.
--
-- Display is a separate question. A screen that would rather show "Apr-2026"
-- can format it; what must not vary is what is stored.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- 'Apr-2026' -> '2026-04'. to_date parses the month name; anything that is not
-- one of the two known shapes is left alone so the CHECK below reports it
-- rather than this UPDATE mangling it.
UPDATE emi_payments
   SET emi_month = to_char(to_date(emi_month, 'Mon-YYYY'), 'YYYY-MM')
 WHERE emi_month ~ '^[A-Za-z]{3}-\d{4}$';

-- A month that is neither shape has to be looked at, not guessed at. There are
-- none today; this fails loudly if that changes before the constraint lands.
DO $$
DECLARE bad integer;
BEGIN
  SELECT count(*) INTO bad FROM emi_payments
   WHERE emi_month IS NOT NULL AND emi_month !~ '^\d{4}-(0[1-9]|1[0-2])$';
  IF bad > 0 THEN
    RAISE EXCEPTION 'emi_payments: % row(s) carry an emi_month in neither YYYY-MM '
                    'nor Mon-YYYY. Fix them by hand — a month key cannot be guessed.', bad;
  END IF;
END $$;

ALTER TABLE emi_payments DROP CONSTRAINT IF EXISTS emi_month_canonical;
ALTER TABLE emi_payments ADD CONSTRAINT emi_month_canonical
  CHECK (emi_month IS NULL OR emi_month ~ '^\d{4}-(0[1-9]|1[0-2])$');

COMMENT ON COLUMN emi_payments.emi_month IS
  'The month the instalment is FOR, as YYYY-MM — not the month it was paid in. '
  'These accounts settle two and three months in arrears. Enforced by '
  'emi_month_canonical; normalise at the API boundary, never in the browser.';

COMMIT;
