-- ═══════════════════════════════════════════════════════════════════════════
-- 053_fleet_hierarchy_and_owners.sql
--   Company -> Branch -> Vehicle as real dimensions, and the schema an
--   attached-vehicle (commission-only) accounting engine needs.
--
-- ── WHAT THIS FILE ASSUMES, AND WHAT IT FOUND INSTEAD ──────────────────────
--
-- The brief asked to "update ledger_entries, vouchers and expense_bills". Two
-- of those three do not exist:
--
--   vouchers      — there is no voucher TABLE. A voucher is logical: legs share
--                   a ledger_entries.voucher_id. Tagging ledger_entries
--                   therefore tags vouchers, because that is where a voucher
--                   physically is.
--   expense_bills — bills live in company_bills; retro expenses in
--                   pending_expenses; everything posted is in ledger_entries.
--   branches      — no table at all, which is why the Branch Setup screen is
--                   empty. Created here.
--
-- ── WHY company_id IS NULLABLE, WHEN THE BRIEF SAID REQUIRED ───────────────
--
-- 1720 ledger rows already exist. Their `company` column is free text with
-- EIGHT distinct values for three companies — NULL, 'ALL', and JAISWAL spelled
-- three different ways with trailing spaces. Those are backfilled below by
-- normalised name, but rows tagged 'ALL' or NULL are genuinely group-level and
-- have no single company to resolve to.
--
-- NOT NULL would therefore either abort this migration or force a company onto
-- history that never had one. The column stays nullable in the database and is
-- required at the WRITE path instead (TARA), so everything posted from now on
-- carries its dimensions while history stays honest about what it does not
-- know. Same reasoning, more strongly, for branch_id: there are currently ZERO
-- branches, so no historical row can possibly have one.
--
-- ── THE APPEND-ONLY EXCEPTION ──────────────────────────────────────────────
--
-- ledger_entries refuses UPDATE by trigger, so the backfill below cannot run
-- with it enabled. 005_ledger.sql says the sanctioned path for a genuine repair
-- is "a migration with an audit trail, not a quiet UPDATE" — this is that
-- migration. The trigger is disabled for the tagging statement ONLY, and
-- re-enabled in the same transaction; no amount, no dr_cr and no date is
-- touched, so the balance the voucher_must_balance trigger guards is unchanged.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. BRANCH ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS branches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  branch_name  text NOT NULL,
  branch_code  text,
  city         text,
  state        text,
  address      text,
  status       record_status NOT NULL DEFAULT 'ACTIVE',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A branch code is unique WITHIN a company, not globally: two firms may both
-- run a "BON" branch and neither should block the other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_company_code
  ON branches (company_id, lower(branch_code)) WHERE branch_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_branches_company ON branches (company_id);

-- Every company gets a default HEAD OFFICE branch. Without one the cascading
-- filter's middle tier is empty on day one and the UI looks broken; more
-- importantly, "branch is mandatory going forward" needs somewhere valid to
-- point on the very first posting.
INSERT INTO branches (company_id, branch_name, branch_code, city, state)
SELECT c.id, 'HEAD OFFICE', 'HO', 'Bongaigaon', 'Assam'
  FROM companies c
 WHERE NOT EXISTS (SELECT 1 FROM branches b WHERE b.company_id = c.id);

-- ── 2. VEHICLE: owned vs attached ───────────────────────────────────────────
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS is_company_owned        boolean,
  ADD COLUMN IF NOT EXISTS vehicle_owner_ledger_id uuid REFERENCES ledgers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS branch_id               uuid REFERENCES branches(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS commission_pct          numeric(6,3),
  ADD COLUMN IF NOT EXISTS commission_flat         numeric(14,2);

-- Derive from the ownership column that already exists rather than defaulting
-- blindly: all 49 rows are 'OWNED' today, and reading the real value means an
-- attached vehicle added before this migration would not be silently
-- reclassified as company-owned.
UPDATE vehicles SET is_company_owned = (ownership = 'OWNED')
 WHERE is_company_owned IS NULL;

ALTER TABLE vehicles
  ALTER COLUMN is_company_owned SET DEFAULT true,
  ALTER COLUMN is_company_owned SET NOT NULL;

-- The validation the brief asks for, as a database rule rather than a UI check:
-- an attached vehicle with no owner ledger cannot be saved, because every rupee
-- it earns and spends has to land in somebody's khata.
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_attached_needs_owner;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_attached_needs_owner CHECK (
  is_company_owned OR vehicle_owner_ledger_id IS NOT NULL
);

-- Commission must be one shape or the other, never both — otherwise the engine
-- has to guess which one wins.
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_commission_shape;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_commission_shape CHECK (
  commission_pct IS NULL OR commission_flat IS NULL
);
ALTER TABLE vehicles DROP CONSTRAINT IF EXISTS vehicles_commission_pct_sane;
ALTER TABLE vehicles ADD CONSTRAINT vehicles_commission_pct_sane CHECK (
  commission_pct IS NULL OR (commission_pct >= 0 AND commission_pct <= 100)
);

CREATE INDEX IF NOT EXISTS idx_vehicles_attached ON vehicles (is_company_owned)
  WHERE is_company_owned = false;

-- ── 3. DIMENSIONS ON THE BOOKS ──────────────────────────────────────────────
ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS branch_id  uuid REFERENCES branches(id)  ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id)  ON DELETE RESTRICT;

ALTER TABLE company_bills
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS branch_id  uuid REFERENCES branches(id)  ON DELETE RESTRICT;

-- Normalise "M/S JAISWAL ENTERPRISE  ", "JAISWAL ENTERPRISE " and
-- "JAISWAL ENTERPRISE" to one thing so they resolve to one company id.
CREATE OR REPLACE FUNCTION norm_company_name(t text) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT nullif(btrim(regexp_replace(
           regexp_replace(lower(coalesce(t, '')), '^\s*m/?s\.?\s*', ''),
           '[^a-z0-9]+', ' ', 'g')), '')
$fn$;

-- The audited exception. See the header.
ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_rewrite;

UPDATE ledger_entries e
   SET company_id = c.id
  FROM companies c
 WHERE e.company_id IS NULL
   AND e.company IS NOT NULL
   AND lower(btrim(e.company)) <> 'all'
   AND norm_company_name(e.company) = norm_company_name(c.company_name);

ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_rewrite;

UPDATE company_bills b
   SET company_id = c.id
  FROM companies c
 WHERE b.company_id IS NULL
   AND norm_company_name(b.company) = norm_company_name(c.company_name);

-- The three questions the P&L filter asks, in the order it asks them.
CREATE INDEX IF NOT EXISTS idx_ledger_company ON ledger_entries (company_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_ledger_branch  ON ledger_entries (branch_id, entry_date);
CREATE INDEX IF NOT EXISTS idx_ledger_vehicle ON ledger_entries (vehicle_id, entry_date);

-- ── 4. COMMISSION INCOME ────────────────────────────────────────────────────
-- Attached-vehicle work earns the company a commission, not freight. Keeping it
-- in its own P&L group is the whole point: "revenue" that is really somebody
-- else's freight passing through would overstate turnover several times over.
INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
SELECT 'Commission Income', 'INCOME', 'PROFIT_AND_LOSS', g.normal_side, 310, true
  FROM account_groups g WHERE g.group_head = 'Freight Income'
   AND NOT EXISTS (SELECT 1 FROM account_groups x WHERE x.group_head = 'Commission Income');

INSERT INTO ledgers (ledger_name, group_head, dr_cr, opening_balance, current_balance, creation_type, status)
SELECT 'Commission Income', 'Commission Income', 'CR', 0, 0, 'SYSTEM', 'ACTIVE'
 WHERE NOT EXISTS (SELECT 1 FROM ledgers WHERE ledger_name = 'Commission Income');

-- Vehicle owners are creditors — the company holds their freight and pays it
-- out — but they are not vendors, and a settlement screen has to be able to
-- list them without also listing every fuel pump. Own group, same statement
-- side as the vendor creditors it sits beside.
INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system)
SELECT 'Sundry Creditors (Vehicle Owners)', g.account_type, g.statement, g.normal_side, 485, true
  FROM account_groups g WHERE g.group_head = 'Sundry Creditors (Vendors)'
   AND NOT EXISTS (SELECT 1 FROM account_groups x WHERE x.group_head = 'Sundry Creditors (Vehicle Owners)');

COMMIT;
