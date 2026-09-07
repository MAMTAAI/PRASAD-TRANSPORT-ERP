-- ═══════════════════════════════════════════════════════════════════════════
-- 184 — THE DUPLICATE DOOR, AND ONE BALANCE PER FIRM
--
-- Owner, 7-Sep-2026, after seeing the audit: "ek card, teen khate" — one vendor
-- card, the money kept separate per firm. And: leave JOHN N WELL alone for now.
--
-- WHY A TRIGGER AND NOT A UNIQUE INDEX
-- Migration 183 put a UNIQUE index on customers and companies, and could not
-- put one on vendors: JOHN N WELL SERVICE STATION holds two active ids with
-- Rs 1,858 and eleven entries between them, and the owner has decided that
-- merge is not to happen yet. A UNIQUE index is all-or-nothing — it would
-- either refuse to build or force a decision about somebody's money in the
-- middle of a deploy.
--
-- A trigger can do what the owner actually asked for: STOP THE NEXT ONE while
-- leaving the one already there alone. It fires on INSERT and on a rename, so
-- a row that exists today is untouched and unchanged rows never see it — but
-- typing "NIRMALA PETROLUM" into the vendor form tomorrow lands on the vendor
-- that already exists instead of minting a second.
--
-- THE CORRECTION THIS FILE ALSO MAKES
-- When the owner was offered "ek card, teen khate (aaj jaisa)" the parenthesis
-- was half right and it matters. ledger_entries carries company_id and
-- v_ledger_entries_routed resolves most of the rest, so LEDGER money is already
-- split by firm. vendor_txns — the table the vendor bills and payments actually
-- live in, 62 bills worth Rs 62.6 L — has NO company column at all, and 18 of
-- its 67 rows carry no voucher either. So a vendor's own account is NOT split
-- by firm today. v_party_balance_by_company below is where that split is
-- computed from the ledger, honestly, with everything it cannot attribute
-- shown as UNATTRIBUTED rather than quietly spread across the three firms.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. ONE NAME, ONE CARD — FROM HERE ON ────────────────────────────────────
-- Generic over the three masters, because three copies of one rule is how the
-- rule ends up being three slightly different rules.
CREATE OR REPLACE FUNCTION party_dup_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_col   text;
  v_name  text;
  v_key   text;
  v_id    uuid;
  v_other text;
BEGIN
  -- Read the name through to_jsonb(NEW) rather than a CASE over NEW.<col>.
  -- plpgsql resolves EVERY arm of a CASE expression, so `NEW.customer_name`
  -- inside an arm that is never taken still fails on the vendors table with
  -- `record "new" has no field "customer_name"` — which the first dry run
  -- caught, and which would have looked exactly like the guard working.
  v_col := CASE TG_TABLE_NAME
             WHEN 'vendors'   THEN 'vendor_name'
             WHEN 'customers' THEN 'customer_name'
             WHEN 'drivers'   THEN 'name'
           END;
  IF v_col IS NULL THEN RETURN NEW; END IF;

  v_name := to_jsonb(NEW) ->> v_col;
  v_key  := party_key(v_name);
  IF v_key IS NULL OR v_key = '' THEN RETURN NEW; END IF;

  -- Only an ACTIVE row can be clashed with. A retired duplicate is history and
  -- must not block the live card that replaced it.
  EXECUTE format(
    'SELECT id, %I FROM %I WHERE status = ''ACTIVE'' AND id <> $1 AND party_key(%I) = $2 LIMIT 1',
    v_col, TG_TABLE_NAME, v_col)
  INTO v_id, v_other
  USING NEW.id, v_key;

  IF v_id IS NOT NULL THEN
    RAISE EXCEPTION
      '% "%" pehle se hai ("%") — nayi ID mat banayein, usi ko istemaal karein',
      TG_TABLE_NAME, v_name, v_other
      USING ERRCODE = 'unique_violation',
            HINT = format('existing id %s', v_id);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION party_dup_guard() IS
  'Refuses a NEW party whose name already belongs to an active one. Existing duplicates are grandfathered on purpose — merging them moves money and is the desk''s decision.';

-- OF (name) so an edit that does not touch the name never pays for this, and a
-- row that already collides can still be corrected in every other field.
DROP TRIGGER IF EXISTS vendors_dup_guard ON vendors;
CREATE TRIGGER vendors_dup_guard
  BEFORE INSERT OR UPDATE OF vendor_name ON vendors
  FOR EACH ROW EXECUTE FUNCTION party_dup_guard();

DROP TRIGGER IF EXISTS customers_dup_guard ON customers;
CREATE TRIGGER customers_dup_guard
  BEFORE INSERT OR UPDATE OF customer_name ON customers
  FOR EACH ROW EXECUTE FUNCTION party_dup_guard();

-- Drivers get the guard too, but note what it will and will not catch: the
-- three men called RAJESH KUMAR already exist and are grandfathered, and the
-- owner has not said whether they are one man or three. A FOURTH Rajesh Kumar
-- is refused, which is the behaviour asked for.
DROP TRIGGER IF EXISTS drivers_dup_guard ON drivers;
CREATE TRIGGER drivers_dup_guard
  BEFORE INSERT OR UPDATE OF name ON drivers
  FOR EACH ROW EXECUTE FUNCTION party_dup_guard();

-- ── 2. ONE CARD, THREE KHATE ────────────────────────────────────────────────
-- The owner's own words. A party keeps ONE identity; its money is read per
-- firm. Built on v_ledger_entries_routed rather than ledger_entries because
-- that view is what resolves the firm for entries whose company_id was never
-- stamped — it is the same source the three-tier books use.
--
-- WHAT IS NOT HIDDEN: an entry the routing cannot place appears under
-- 'UNATTRIBUTED'. Spreading it over the three firms would make every one of
-- them slightly wrong and none of them say so.
CREATE OR REPLACE VIEW v_party_balance_by_company AS
  WITH party AS (
    SELECT 'VENDOR'::text AS party_type, v.id AS party_id, v.vendor_name AS party_name,
           party_key(v.vendor_name) AS pkey
      FROM vendors v WHERE v.status = 'ACTIVE'
    UNION ALL
    SELECT 'CUSTOMER', c.id, c.customer_name, party_key(c.customer_name)
      FROM customers c WHERE c.status = 'ACTIVE'
    UNION ALL
    SELECT 'VEHICLE_OWNER', o.id, o.display_name, o.owner_key
      FROM vehicle_owners o WHERE o.status = 'ACTIVE'
  )
  SELECT p.party_type,
         p.party_id,
         p.party_name,
         p.pkey                                                AS party_key,
         COALESCE(r.company_routed_name, 'UNATTRIBUTED')       AS firm,
         count(*)::int                                         AS entries,
         COALESCE(sum(CASE WHEN r.dr_cr = 'CR' THEN r.amount ELSE 0 END), 0)::numeric(16,2) AS credit,
         COALESCE(sum(CASE WHEN r.dr_cr = 'DR' THEN r.amount ELSE 0 END), 0)::numeric(16,2) AS debit,
         COALESCE(sum(CASE WHEN r.dr_cr = 'CR' THEN r.amount ELSE -r.amount END), 0)::numeric(16,2) AS balance,
         max(r.entry_date)                                     AS last_entry
    FROM party p
    JOIN v_ledger_entries_routed r ON party_key(r.ledger_name) = p.pkey
   GROUP BY 1,2,3,4,5;

COMMENT ON VIEW v_party_balance_by_company IS
  'One card, three khate: a party keeps one identity and its balance is read per operating firm. Entries the routing cannot place show as UNATTRIBUTED rather than being spread across the firms.';

-- Where a vendor''s own account (vendor_txns) stands, and the fact that it has
-- no firm of its own. Kept separate from the view above so nobody mistakes one
-- for the other.
CREATE OR REPLACE VIEW v_vendor_account_unsplit AS
  SELECT v.id AS vendor_id, v.vendor_name,
         count(*)::int AS entries,
         count(*) FILTER (WHERE t.voucher_id IS NULL)::int AS entries_without_voucher,
         COALESCE(sum(CASE WHEN t.txn_type = 'BILL_RECEIVED' THEN t.amount ELSE -t.amount END), 0)::numeric(16,2) AS owed
    FROM vendors v JOIN vendor_txns t ON t.vendor_id = v.id
   WHERE v.status = 'ACTIVE'
   GROUP BY 1,2;

COMMENT ON VIEW v_vendor_account_unsplit IS
  'vendor_txns has no company column, so these bills and payments belong to no firm in the data. Read alongside v_party_balance_by_company, which splits the LEDGER side. Closing this gap needs a company on vendor_txns — an owner decision, not a migration.';

COMMIT;
