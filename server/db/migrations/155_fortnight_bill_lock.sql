-- ═══════════════════════════════════════════════════════════════════════════
-- 155 — The consolidated 15-day bill, and the lock that closes it
--
-- THE LEDGER POSTING ALREADY EXISTS and is not touched here:
-- /queues/fuel-reconcile posts ONE journal — Dr 'Direct Expenses - Fuel & HSD',
-- Cr 'Creditors: <pump>' — under a deterministic ref_no, moves each trip by the
-- delta, and writes the pump's khata row. That is point 2 of the command,
-- already built.
--
-- WHAT WAS MISSING, and it is a money error rather than a missing feature:
-- the screen posted the WHOLE physical bill amount even when the desk had
-- marked lines as disputed. A disputed line is one the office is refusing to
-- pay — crediting the pump for it anyway is exactly the thing the dispute
-- button exists to prevent. The payable is the bill LESS what is disputed, and
-- this table is where that arithmetic is recorded and kept.
--
-- AND THE LOCK. Once a fortnight is settled it must not be settled again: no
-- second import of the same invoice, no re-allocation of its slips, no edit of
-- its figures. The lock is a trigger, not a convention, because a convention is
-- something a future screen forgets.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE pump_bill_drafts
  -- The reference a person quotes on the phone: BNFS-APR-H1-2026.
  ADD COLUMN IF NOT EXISTS invoice_no       text,
  -- The four figures the command asks the summary to carry.
  ADD COLUMN IF NOT EXISTS disputed_amount  numeric(16,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payable_amount   numeric(16,2),
  ADD COLUMN IF NOT EXISTS locked_at        timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by        text,
  -- What the desk decided, line by line, kept beside the bill it decided about.
  ADD COLUMN IF NOT EXISTS resolutions      jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS pump_bill_invoice_no_uq
  ON pump_bill_drafts (invoice_no) WHERE invoice_no IS NOT NULL;

-- ── The invoice number ────────────────────────────────────────────────────
--
-- BNFS-APR-H1-2026 — the pump's initials, the month, the half, the year.
-- Derived from the bill's own period so the same fortnight always produces the
-- same reference, which is what makes a duplicate obvious to a person rather
-- than only to a unique index.
CREATE OR REPLACE FUNCTION pump_invoice_no(p_vendor text, p_from date)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT upper(
    -- Initials of the first three significant words: "B N FILLING STATION" →
    -- BNF. Short, and stable for a given pump.
    COALESCE(NULLIF(regexp_replace(
      (SELECT string_agg(left(w, 1), '')
         FROM (SELECT unnest(string_to_array(regexp_replace(upper(coalesce(p_vendor,'')),
                       '[^A-Z ]', '', 'g'), ' ')) AS w) q
        WHERE w <> ''), '[^A-Z]', '', 'g'), ''), 'PUMP')
    || '-' || to_char(p_from, 'MON')
    || '-' || CASE WHEN extract(day FROM p_from) <= 15 THEN 'H1' ELSE 'H2' END
    || '-' || to_char(p_from, 'YYYY'))
$$;

COMMENT ON FUNCTION pump_invoice_no(text, date) IS
  'The human reference for a fortnight: BNFS-APR-H1-2026. Derived from the '
  'period, so the same fortnight always yields the same number.';

-- ── The lock ──────────────────────────────────────────────────────────────
--
-- A settled fortnight is closed. The trigger refuses every change to a locked
-- row except the two that must stay possible: unlocking it deliberately, and
-- recording the cancellation of the whole bill. Everything else — amounts,
-- period, lines, status — is frozen.
--
-- WHY A TRIGGER. The screen already refuses; so does the endpoint. Neither is
-- present when someone runs an UPDATE by hand at eleven at night to "just fix
-- one figure", and that is the moment a settled fortnight quietly changes shape
-- underneath a posted voucher.
CREATE OR REPLACE FUNCTION pump_bill_lock_guard() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'bill % is settled and locked — it cannot be deleted',
        COALESCE(OLD.invoice_no, OLD.ref_no, OLD.id::text)
        USING ERRCODE = 'P0408',
              HINT = 'Reverse it with a cancellation instead.';
    END IF;
    RETURN OLD;
  END IF;

  -- THE TEST IS ON *OLD*, NOT ON NEW. A row that was locked has its figures
  -- frozen for this statement whatever the statement does to locked_at — so
  -- `SET locked_at = NULL, physical_amount = 1` in one go is refused, and
  -- unlocking has to be its own deliberate act before anything can be
  -- restated. Guarding on NEW instead left exactly that hole: one statement
  -- that unlocked and edited at the same time sailed through.
  --
  -- Unlocking on its own is allowed. It is meant to be possible; it is meant
  -- to be a decision.
  IF OLD.locked_at IS NOT NULL THEN
    IF (
         NEW.physical_amount IS DISTINCT FROM OLD.physical_amount
      OR NEW.payable_amount  IS DISTINCT FROM OLD.payable_amount
      OR NEW.disputed_amount IS DISTINCT FROM OLD.disputed_amount
      OR NEW.period_from     IS DISTINCT FROM OLD.period_from
      OR NEW.period_to       IS DISTINCT FROM OLD.period_to
      OR NEW.vendor_id       IS DISTINCT FROM OLD.vendor_id
      OR NEW.lines           IS DISTINCT FROM OLD.lines) THEN
      RAISE EXCEPTION 'bill % is settled and locked — its figures cannot change',
        COALESCE(OLD.invoice_no, OLD.ref_no, OLD.id::text)
        USING ERRCODE = 'P0408',
              HINT = 'Unlock it first, or post a correcting entry.';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS pump_bill_lock ON pump_bill_drafts;
CREATE TRIGGER pump_bill_lock
  BEFORE UPDATE OR DELETE ON pump_bill_drafts
  FOR EACH ROW EXECUTE FUNCTION pump_bill_lock_guard();

-- ── A settled fortnight is settled once ───────────────────────────────────
-- One locked bill per pump per period. A second import of the same invoice
-- collides here rather than creating a parallel bill for the same fortnight.
CREATE UNIQUE INDEX IF NOT EXISTS pump_bill_one_locked_per_period
  ON pump_bill_drafts (vendor_id, period_from, period_to)
  WHERE locked_at IS NOT NULL;

-- ── What the pump is owed, live ───────────────────────────────────────────
--
-- Straight off the pump's own khata: what has been billed to us, less what we
-- have paid. vendor_txns is the subsidiary ledger the reconciliation already
-- writes to, so this needs no new bookkeeping — only somewhere to read it.
CREATE OR REPLACE VIEW v_pump_outstanding AS
SELECT v.id                                              AS vendor_id,
       v.vendor_name,
       pump_key(v.vendor_name)                           AS vendor_key,
       COALESCE(v.opening_balance, 0)::numeric(16,2)     AS opening_balance,
       COALESCE(t.billed, 0)::numeric(16,2)              AS billed,
       COALESCE(t.paid, 0)::numeric(16,2)                AS paid,
       COALESCE(t.adjustments, 0)::numeric(16,2)         AS adjustments,
       COALESCE(t.adjustment_count, 0)::int              AS adjustment_count,
       (COALESCE(v.opening_balance, 0) + COALESCE(t.billed, 0) - COALESCE(t.paid, 0))::numeric(16,2)
                                                         AS outstanding,
       t.last_txn_at,
       COALESCE(b.locked_bills, 0)                       AS settled_fortnights,
       b.last_settled_period
  FROM vendors v
  -- THE TYPE NAMES ARE THE SCHEMA'S, NOT PLAUSIBLE ONES. vendor_txns allows
  -- exactly PAYMENT_GIVEN, BILL_RECEIVED, OPENING, ADJUSTMENT, CREDIT_NOTE.
  -- This view first said 'PAYMENT' and 'DEBIT_NOTE' — neither exists — so
  -- `paid` summed nothing and every pump would have read as entirely unpaid,
  -- with ₹5,88,600 of real payments invisible. A FILTER that matches no rows
  -- returns 0 rather than an error, which is why a guess here is dangerous.
  --
  -- ADJUSTMENT is deliberately in neither column. It can go either way and the
  -- schema does not say which; it is reported on its own so a pump whose
  -- balance turns on one is visible instead of silently mis-added.
  LEFT JOIN LATERAL (
    SELECT sum(amount) FILTER (WHERE txn_type IN ('BILL_RECEIVED','OPENING'))    AS billed,
           sum(amount) FILTER (WHERE txn_type IN ('PAYMENT_GIVEN','CREDIT_NOTE')) AS paid,
           sum(amount) FILTER (WHERE txn_type = 'ADJUSTMENT')                     AS adjustments,
           count(*) FILTER (WHERE txn_type = 'ADJUSTMENT')                        AS adjustment_count,
           max(txn_date)                                                          AS last_txn_at
      FROM vendor_txns x WHERE x.vendor_id = v.id) t ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS locked_bills, max(period_to) AS last_settled_period
      FROM pump_bill_drafts d WHERE d.vendor_id = v.id AND d.locked_at IS NOT NULL) b ON true
 WHERE EXISTS (SELECT 1 FROM vendor_txns x WHERE x.vendor_id = v.id)
    OR EXISTS (SELECT 1 FROM pump_bill_drafts d WHERE d.vendor_id = v.id);

COMMENT ON VIEW v_pump_outstanding IS
  'What each pump is still owed, read from its own khata (vendor_txns) rather '
  'than recomputed — plus how many fortnights have been settled and locked.';

-- ── The fortnight, as one line ────────────────────────────────────────────
CREATE OR REPLACE VIEW v_pump_fortnight_bill AS
SELECT d.id,
       COALESCE(d.invoice_no, pump_invoice_no(d.vendor_name, d.period_from)) AS invoice_no,
       d.vendor_id,
       d.vendor_name,
       d.period_from,
       d.period_to,
       fortnight_label(d.period_from)                       AS cycle_label,
       d.status,
       d.slip_count,
       d.system_liters                                      AS total_liters,
       d.physical_amount                                    AS bill_amount,
       COALESCE(d.disputed_amount, 0)::numeric(16,2)        AS disputed_amount,
       COALESCE(d.payable_amount,
                d.physical_amount - COALESCE(d.disputed_amount, 0))::numeric(16,2)
                                                            AS payable_amount,
       d.voucher_id,
       d.locked_at,
       d.locked_by,
       (d.locked_at IS NOT NULL)                            AS locked,
       d.resolutions,
       d.created_at
  FROM pump_bill_drafts d;

COMMENT ON VIEW v_pump_fortnight_bill IS
  'One row per 15-day pump bill: total litres, what the pump billed, what is '
  'disputed, and what is actually payable. `locked` means the fortnight is '
  'closed and nothing about it may change.';
