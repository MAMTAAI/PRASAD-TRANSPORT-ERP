-- ═══════════════════════════════════════════════════════════════════════════
-- 126_bazaar_money_constraints.sql — the 0 % error rule, in the database
--
-- Owner's rule (Load Bazaar 2026, Phase 1, 2026-09-02): every rupee event in
-- the bazaar goes through the TARA voucher engine, stamped with the firm it
-- belongs to, and can never post twice. bazaarSettlement.routes.js already
-- refuses a deposit / advance / balance without company_id (409 NO_COMPANY);
-- this puts the same fact under the table so no future code path can post a
-- bazaar voucher into a firm-less settlement.
--
-- NOT VALID: rows that already exist are not re-judged (the desk sets
-- company_id after the fact on some of them — v_accounting_health shows
-- which). Every new write is judged.
--
-- Also here, because the same desk approves them: market_vehicles gets the
-- two approval columns its approve route has been writing since 069 — they
-- never existed, so `POST /bazaar/market-vehicles/:id/approve` raised 42703
-- — and a REJECTED state, matching market_drivers.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

ALTER TABLE bazaar_settlements
  DROP CONSTRAINT IF EXISTS bazaar_settlements_company_before_money;
ALTER TABLE bazaar_settlements
  ADD CONSTRAINT bazaar_settlements_company_before_money
  CHECK (
    company_id IS NOT NULL
    OR (vendor_deposit_voucher_id IS NULL
        AND customer_deposit_voucher_id IS NULL
        AND vendor_deposit_refund_voucher_id IS NULL
        AND customer_deposit_refund_voucher_id IS NULL
        AND advance_voucher_id IS NULL
        AND balance_voucher_id IS NULL)
  ) NOT VALID;

-- ONE VOUCHER PER REFERENCE, UNDER THE TABLE. postVoucher() checks DUPLICATE_REF
-- with a SELECT before it inserts; two operators clicking "advance" in the same
-- second could both pass that check. This trigger takes a transaction-scoped
-- advisory lock on the reference, so the second insert waits and then sees
-- the first. There is no vouchers table — a voucher is its ledger_entries
-- legs sharing voucher_id, and source_ref is the ref_no (BZADV-<id>, …).
-- Checked on 2-Sep-2026: 261 voucher legs, no reference under two vouchers.
CREATE OR REPLACE FUNCTION ledger_one_voucher_per_ref() RETURNS trigger AS $$
BEGIN
  IF NEW.source_type = 'VOUCHER' AND NEW.source_ref IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('ledger_ref:' || NEW.source_ref));
    IF EXISTS (SELECT 1 FROM ledger_entries e
                WHERE e.source_type = 'VOUCHER' AND e.source_ref = NEW.source_ref
                  AND e.voucher_id IS DISTINCT FROM NEW.voucher_id) THEN
      RAISE EXCEPTION 'DUPLICATE_REF: reference % is already posted under another voucher', NEW.source_ref
        USING ERRCODE = '23505';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_one_voucher_per_ref ON ledger_entries;
CREATE TRIGGER ledger_entries_one_voucher_per_ref
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_one_voucher_per_ref();

ALTER TABLE market_vehicles
  ADD COLUMN IF NOT EXISTS approved_by uuid,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz;

ALTER TABLE market_vehicles DROP CONSTRAINT IF EXISTS market_vehicles_system_status_check;
ALTER TABLE market_vehicles
  ADD CONSTRAINT market_vehicles_system_status_check
  CHECK (system_status IN ('System Active', 'PENDING APPROVAL', 'BLOCKED', 'REJECTED'));

COMMIT;
