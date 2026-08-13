-- ═══════════════════════════════════════════════════════════════════════════
-- 005_ledger.sql — the money. Un-parks TARA.
--
-- Two eras coexist in this ledger, and the schema is explicit about it:
--
--   LEGACY era   voucher_id IS NULL. Rows migrated from Firestore, where the
--                book was effectively single-entry (219 Dr vs 1 Cr in the
--                snapshot). Historical record — loaded verbatim, never judged
--                by double-entry rules it predates.
--
--   VOUCHER era  voucher_id IS NOT NULL. Every new posting. A deferred
--                constraint trigger verifies ΣDr = ΣCr per voucher AT COMMIT,
--                so an unbalanced voucher cannot exist no matter what the
--                application code does. TARA's zero-divergence audit runs over
--                this era only.
--
-- The ledger is append-only: UPDATE/DELETE on ledger_entries is refused by
-- trigger. A correction is a reversing entry, never an edit.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- LEDGERS — account heads. The loader coalesces the legacy field drift
-- (ledger_name/name, group_head/group, opening_balance/op_balance).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE ledgers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       text UNIQUE,
  ledger_name     text NOT NULL,
  group_head      text,
  dr_cr           text CHECK (dr_cr IS NULL OR dr_cr IN ('DR','CR')),
  opening_balance numeric(14,2) DEFAULT 0,
  current_balance numeric(14,2) DEFAULT 0,
  company         text,
  branch          text,
  creation_type   text,
  linked_module   text,
  linked_id       text,
  status          record_status NOT NULL DEFAULT 'ACTIVE',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledgers_name_idx  ON ledgers (lower(ledger_name));
CREATE INDEX ledgers_group_idx ON ledgers (group_head);
CREATE TRIGGER ledgers_touch BEFORE UPDATE ON ledgers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- LEDGER_ENTRIES
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE ledger_entries (
  id           bigserial PRIMARY KEY,
  legacy_id    text UNIQUE,
  ledger_id    uuid REFERENCES ledgers(id) ON DELETE RESTRICT,
  ledger_name  text NOT NULL,              -- denormalised: postings must survive a ledger rename
  voucher_id   uuid,                       -- NULL = legacy era (see header)
  entry_date   date NOT NULL,
  particulars  text,
  dr_cr        text NOT NULL CHECK (dr_cr IN ('DR','CR')),
  amount       numeric(14,2) NOT NULL CHECK (amount >= 0),
  source_type  text,                       -- 'TRIP_SETTLEMENT' | 'FUEL' | 'LEGACY_MIGRATION' | ...
  source_ref   text,
  company      text,
  branch       text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_ledger_idx  ON ledger_entries (ledger_name, entry_date DESC);
CREATE INDEX ledger_entries_voucher_idx ON ledger_entries (voucher_id) WHERE voucher_id IS NOT NULL;
CREATE INDEX ledger_entries_source_idx  ON ledger_entries (source_type, source_ref);

-- ── Append-only guard ───────────────────────────────────────────────────────
-- No UPDATE, no DELETE — ever, for any role the app runs as. A correction is a
-- reversing entry. (Deliberately no admin bypass setting: if a genuine repair
-- is ever required, it is a migration with an audit trail, not a quiet UPDATE.)
CREATE OR REPLACE FUNCTION ledger_entries_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'ledger_entries is append-only: % refused. Post a reversing entry instead.', TG_OP
    USING ERRCODE = 'P0403';
END;
$fn$;
CREATE TRIGGER ledger_entries_no_rewrite
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_entries_immutable();

-- ── Balanced-voucher constraint (deferred to COMMIT) ────────────────────────
-- Checks the WHOLE voucher after the statement batch, so multi-row inserts of
-- one voucher pass regardless of row order, and a lopsided voucher aborts the
-- transaction. This is the rule the browser-side validateEntry() could only
-- ask callers to respect; here it is physics.
CREATE OR REPLACE FUNCTION assert_voucher_balanced() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v uuid;
  diff numeric;
BEGIN
  v := NEW.voucher_id;
  IF v IS NULL THEN RETURN NULL; END IF;   -- legacy era: exempt
  SELECT COALESCE(SUM(amount) FILTER (WHERE dr_cr = 'DR'), 0)
       - COALESCE(SUM(amount) FILTER (WHERE dr_cr = 'CR'), 0)
    INTO diff
    FROM ledger_entries WHERE voucher_id = v;
  IF diff <> 0 THEN
    RAISE EXCEPTION 'voucher % is unbalanced by % — ΣDr must equal ΣCr', v, diff
      USING ERRCODE = 'P0422';
  END IF;
  RETURN NULL;
END;
$fn$;
CREATE CONSTRAINT TRIGGER voucher_must_balance
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_voucher_balanced();

-- ═══════════════════════════════════════════════════════════════════════════
-- TRIP_SETTLEMENTS — one row per settled trip (TARA writes it in the same
-- transaction as the voucher; the unique index makes double-settlement a
-- constraint violation, not a race).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE trip_settlements (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id      uuid NOT NULL REFERENCES trips(id) ON DELETE RESTRICT,
  voucher_id   uuid NOT NULL,
  freight_amount numeric(14,2) NOT NULL,
  settled_by   text,
  settled_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX trip_settlements_once ON trip_settlements (trip_id);

-- ═══════════════════════════════════════════════════════════════════════════
-- LOAN_MASTER — vehicle loans and EMI schedules (slabs/schedule stay jsonb:
-- the EMI UI reads them whole; per-instalment rows come later if needed).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE loan_master (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id         text UNIQUE,
  loan_account_no   text,
  vehicle_no        text,
  owner_name        text,
  company_name      text,
  loan_type         text,
  bank_name         text,
  sanction_date     date,
  rate_of_interest  numeric(8,4),
  principal_amt     numeric(14,2),
  tenure_months     integer,
  emi_amount        numeric(12,2),
  moratorium_months integer,
  first_emi_date    date,
  as_on_date        date,
  emis_completed    integer,
  remaining_principal numeric(14,2),
  total_interest_paid numeric(14,2),
  payment_status    text,
  emi_slabs         jsonb NOT NULL DEFAULT '[]'::jsonb,
  repayment_schedule jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX loan_vehicle_idx ON loan_master (vehicle_no);
CREATE TRIGGER loan_touch BEFORE UPDATE ON loan_master FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
