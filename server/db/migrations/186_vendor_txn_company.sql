-- ═══════════════════════════════════════════════════════════════════════════
-- 186 — EVERY VENDOR BILL BELONGS TO A FIRM
--
-- Owner, 7-Sep-2026: "vendor_txns mein company column turant add kar do. Har ek
-- bill aur payment ka hisaab company-wise (Prasad, Jaiswal, Gautam) clear hona
-- chahiye."
--
-- This is the gap migration 184 reported rather than hid. vendor_txns holds 67
-- rows — 62 bills worth Rs 62.6 L and 5 payments worth Rs 5.9 L — and had no
-- company column at all, so a vendor's own account belonged to no firm. The
-- ledger side was already routed per firm; this side was not, which is why
-- "ek card, teen khate" was only half true.
--
-- WHERE THE FIRM COMES FROM
-- vendor_txns.voucher_id is a loose reference (no foreign key) to the voucher
-- the transaction was posted under, and the ledger entries of that voucher DO
-- carry company_id. So the firm is recoverable for every row that was posted
-- properly. 18 of the 67 rows carry no voucher at all and cannot be recovered
-- this way — those are left NULL and listed, not guessed. A vendor bill filed
-- under the wrong firm is money in the wrong set of books, and a default would
-- put every unattributed rupee into whichever firm this file picked.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE vendor_txns ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id);
CREATE INDEX IF NOT EXISTS vendor_txns_company_idx ON vendor_txns (company_id);

COMMENT ON COLUMN vendor_txns.company_id IS
  'Which firm this bill or payment belongs to. Recovered from the voucher''s ledger entries; NULL when the row was never posted through a voucher — see v_vendor_txns_unattributed.';

-- ── 1. RECOVER THE FIRM FROM THE VOUCHER ────────────────────────────────────
-- A voucher posts to several ledgers and every entry carries the same company,
-- so any one of them answers. Where a voucher's entries somehow disagree the
-- row is left NULL rather than taking the first — a disagreement is a fault to
-- look at, not a coin to flip.
DO $$
DECLARE
  fixed int; unposted int; conflicted int;
BEGIN
  WITH v AS (
    SELECT e.voucher_id,
           min(e.company_id::text)::uuid AS company_id,
           count(DISTINCT e.company_id)  AS firms
      FROM ledger_entries e
     WHERE e.voucher_id IS NOT NULL AND e.company_id IS NOT NULL
     GROUP BY 1
  )
  UPDATE vendor_txns t
     SET company_id = v.company_id
    FROM v
   WHERE t.company_id IS NULL
     AND t.voucher_id IS NOT NULL
     AND v.voucher_id = t.voucher_id
     AND v.firms = 1;
  GET DIAGNOSTICS fixed = ROW_COUNT;

  SELECT count(*) INTO unposted   FROM vendor_txns WHERE company_id IS NULL AND voucher_id IS NULL;
  SELECT count(*) INTO conflicted FROM vendor_txns WHERE company_id IS NULL AND voucher_id IS NOT NULL;

  RAISE NOTICE '[186] % vendor txn(s) attributed to a firm; % have no voucher; % have a voucher that could not answer',
    fixed, unposted, conflicted;
END $$;

-- ── 2. AND FROM NOW ON ──────────────────────────────────────────────────────
-- Stamped at the table so every writer is covered — the vendor portal, the pump
-- bill flow, the fleet-card settlement and the agents all insert here.
CREATE OR REPLACE FUNCTION vendor_txns_stamp_company()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE v_co uuid; v_n int;
BEGIN
  IF NEW.company_id IS NOT NULL OR NEW.voucher_id IS NULL THEN RETURN NEW; END IF;
  SELECT min(e.company_id::text)::uuid, count(DISTINCT e.company_id)
    INTO v_co, v_n
    FROM ledger_entries e
   WHERE e.voucher_id = NEW.voucher_id AND e.company_id IS NOT NULL;
  IF v_n = 1 THEN NEW.company_id := v_co; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vendor_txns_stamp_company ON vendor_txns;
CREATE TRIGGER vendor_txns_stamp_company
  BEFORE INSERT OR UPDATE OF voucher_id, company_id ON vendor_txns
  FOR EACH ROW EXECUTE FUNCTION vendor_txns_stamp_company();

-- ── 3. THE VENDOR ACCOUNT, NOW SPLIT BY FIRM ────────────────────────────────
-- What "teen khate" actually means on this side: one vendor card, one row per
-- firm, and an honest row for whatever still has no firm.
CREATE OR REPLACE VIEW v_vendor_account_by_company AS
  SELECT v.id AS vendor_id,
         v.vendor_name,
         COALESCE(c.company_name, 'FIRM NAHI PATA') AS firm,
         count(*)::int AS entries,
         COALESCE(sum(t.amount) FILTER (WHERE t.txn_type = 'BILL_RECEIVED'), 0)::numeric(16,2) AS billed,
         COALESCE(sum(t.amount) FILTER (WHERE t.txn_type = 'PAYMENT_GIVEN'), 0)::numeric(16,2) AS paid,
         COALESCE(sum(CASE WHEN t.txn_type = 'BILL_RECEIVED' THEN t.amount ELSE -t.amount END), 0)::numeric(16,2) AS owed,
         max(t.txn_date) AS last_entry
    FROM vendors v
    JOIN vendor_txns t ON t.vendor_id = v.id
    LEFT JOIN companies c ON c.id = t.company_id
   WHERE v.status = 'ACTIVE'
   GROUP BY 1,2,3;

COMMENT ON VIEW v_vendor_account_by_company IS
  'One vendor card, one khata per firm. Rows under "FIRM NAHI PATA" were never posted through a voucher and belong to no firm in the data — a person must place them.';

-- ── 4. WHAT COULD NOT BE PLACED ─────────────────────────────────────────────
CREATE OR REPLACE VIEW v_vendor_txns_unattributed AS
  SELECT t.id, t.vendor_id, t.vendor_name, t.txn_date, t.txn_type, t.amount, t.remarks,
         CASE WHEN t.voucher_id IS NULL
              THEN 'is entry par koi voucher hi nahi — kis firm ki hai, aap batayein'
              ELSE 'voucher hai par uske ledger entries par firm nahi likhi' END AS reason
    FROM vendor_txns t
   WHERE t.company_id IS NULL
   ORDER BY t.txn_date DESC NULLS LAST;

COMMENT ON VIEW v_vendor_txns_unattributed IS
  'Vendor bills and payments that belong to no firm. Never defaulted to one — a bill filed under the wrong firm is money in the wrong books.';

-- The unsplit view from migration 184 said this gap existed. It is replaced by
-- the split above; kept as a pointer so nothing that reads it breaks.
COMMENT ON VIEW v_vendor_account_unsplit IS
  'SUPERSEDED by v_vendor_account_by_company (migration 186), which splits these figures per firm. Kept for callers that have not moved.';

COMMIT;
