-- ═══════════════════════════════════════════════════════════════════════════
-- 084_emi_payment_batches.sql — one cheque or RTGS to one financier on one
-- date is ONE block, however many trucks it covers.
--
-- ── WHAT THE SCREEN SHOWED ─────────────────────────────────────────────────
-- The EMI Payment History groups payments into blocks so an operator can see
-- the transfer that actually left the bank. It keyed the block on
-- date + account + ref_no, and that worked for the six payments made through
-- the browser — one UTR, SBINR12026070934662407, covering seven trucks, shown
-- as one block of 7.
--
-- It did not work for the 108 posted by /loans/post-emis, because that route
-- writes a ref of its own per loan: LOANEMI-5004384630-2026-08-11. Thirteen
-- trucks paid in one transfer on 11-08-2026 came out as thirteen separate
-- blocks of "1 Vehicles", each with a reference that no bank statement will
-- ever show.
--
-- ── ref_no HELD TWO DIFFERENT THINGS ───────────────────────────────────────
-- That is the actual defect, and it is the same shape as the emi_month and
-- months_paid bugs before it: one column, two meanings.
--
--   ref_no          the VOUCHER reference. Unique per payment, which is what
--                   makes it a duplicate guard. Ours.
--   instrument_ref  the UTR or cheque number. SHARED by every payment the same
--                   transfer settled. The bank's.
--
-- Splitting them lets a block be what it is in the world: one instrument. And
-- where there is no instrument on record — the posted rows have none, because
-- nobody typed one — the block falls back to what is still true and checkable:
-- one date, one financier, one bank account.
--
-- Deliberately NOT the amount, and NOT a tolerance window. Two transfers to the
-- same financier from the same account on the same day are rare and real, and
-- an instrument reference separates them. Guessing from amounts would merge
-- them, and a block that silently combines two payments is worse than thirteen
-- that were never combined at all.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE emi_payments
  ADD COLUMN IF NOT EXISTS instrument_ref text;

COMMENT ON COLUMN emi_payments.instrument_ref IS
  'The bank instrument: UTR, NEFT/RTGS reference or cheque number. SHARED by '
  'every payment that one transfer settled — that is what makes a block a block. '
  'Distinct from ref_no, which is our per-payment voucher reference and must '
  'stay unique for the duplicate guard.';

-- A ref_no that more than one payment carries was never a voucher reference —
-- it is the instrument, typed once and applied across the transfer. Move it.
UPDATE emi_payments p
   SET instrument_ref = p.ref_no
  FROM (SELECT ref_no FROM emi_payments
         WHERE ref_no IS NOT NULL AND ref_no <> ''
         GROUP BY ref_no HAVING count(*) > 1) shared
 WHERE p.ref_no = shared.ref_no
   AND p.instrument_ref IS NULL;

CREATE INDEX IF NOT EXISTS emi_payments_instrument_idx
  ON emi_payments (instrument_ref) WHERE instrument_ref IS NOT NULL;

-- ── the block key ──────────────────────────────────────────────────────────
-- A function so the browser, the API and any report compute the same key from
-- the same rule. If this ever needs to change, it changes in one place.
CREATE OR REPLACE FUNCTION emi_batch_key(
  p_date date, p_financier text, p_account text, p_instrument text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT md5(concat_ws('|',
    to_char(p_date, 'YYYY-MM-DD'),
    upper(coalesce(p_financier, '')),
    upper(coalesce(p_account, '')),
    -- No instrument on record means the block is the day's transfer to that
    -- financier from that account. With one, the instrument IS the block.
    upper(coalesce(nullif(p_instrument, ''), ''))))
$$;

COMMENT ON FUNCTION emi_batch_key(date, text, text, text) IS
  'One cheque or RTGS to one financier on one date. Falls back to '
  'date+financier+account when no instrument reference was recorded.';

-- ── one row per block ──────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_emi_payment_batches AS
SELECT
  emi_batch_key(p.payment_date, l.bank_name, p.paid_from_account, p.instrument_ref) AS batch_key,
  p.payment_date,
  l.bank_name                                    AS financier,
  p.paid_from_account,
  max(p.instrument_ref)                          AS instrument_ref,
  count(*)::int                                  AS payments,
  count(DISTINCT l.vehicle_no)::int              AS vehicles,
  SUM(p.total_paid)::numeric(14,2)               AS total_paid,
  SUM(p.principal_part)::numeric(14,2)           AS principal_part,
  SUM(p.interest_part)::numeric(14,2)            AS interest_part,
  min(p.emi_month)                               AS emi_month_from,
  max(p.emi_month)                               AS emi_month_to,
  -- Kept so the block can still show where its rows came from. A block with no
  -- instrument shows thirteen voucher references, which is honest: that is all
  -- the bank detail anyone recorded.
  array_agg(DISTINCT p.ref_no) FILTER (WHERE p.ref_no IS NOT NULL) AS voucher_refs,
  bool_or(p.instrument_ref IS NULL)              AS missing_instrument
  FROM emi_payments p
  JOIN loan_master l ON l.id = p.loan_id
 GROUP BY 1, 2, 3, 4;

COMMENT ON VIEW v_emi_payment_batches IS
  'The transfers that actually left the bank. missing_instrument = true means '
  'no UTR or cheque number was ever recorded for it, so the block is inferred '
  'from date + financier + account rather than read off the instrument.';

COMMIT;
