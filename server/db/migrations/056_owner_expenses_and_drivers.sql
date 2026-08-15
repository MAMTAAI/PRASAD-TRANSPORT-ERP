-- ═══════════════════════════════════════════════════════════════════════════
-- 056_owner_expenses_and_drivers.sql — attached-fleet drivers, and the
--                                      expenses the company pays on an owner's
--                                      behalf
--
-- TWO THINGS THE ATTACHED-FLEET MODEL STILL LACKED.
--
-- 1. A DRIVER WHO IS NOT OURS. A driver on an attached truck is employed by the
--    vehicle owner, not by Prasad Transport. He still needs a full record —
--    licence, HZD, Aadhaar, bank, trip history, cash advances — because we
--    hand him money and load hazardous goods on his say-so. What he must NOT
--    be is company payroll: his salary is the owner's cost, and booking it as
--    ours is the same error as booking the owner's diesel as ours.
--
--    `employed_by_owner_id` records that. NULL keeps today's meaning — our own
--    driver — so nothing is reclassified by this migration.
--
-- 2. WHAT KIND OF DEDUCTION IT WAS. The costs we pay for an owner (driver
--    bhatta, an EMI to the bank, tyres, a traffic fine) all land in the same
--    place: a debit to that owner's khata. That is correct accounting and
--    useless for a statement — the owner wants to see "EMI 28,843" and "bhatta
--    4,000" as separate lines, and ledger_entries cannot tell them apart once
--    posted, because they are the same debit to the same ledger.
--
--    owner_expenses is the itemisation beside the posting. It does NOT hold
--    money of its own: every row points at the voucher TARA created, so the
--    books remain the single source of truth and this is the label on top.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Driver → owner ───────────────────────────────────────────────────────
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS employed_by_owner_id uuid REFERENCES ledgers(id) ON DELETE RESTRICT;

COMMENT ON COLUMN drivers.employed_by_owner_id IS
  'Vehicle-owner ledger this driver is employed by. NULL = own company driver (payroll). Set = attached-fleet driver; his salary/bhatta is the owner''s cost, never a company operating expense.';

CREATE INDEX IF NOT EXISTS idx_drivers_owner ON drivers (employed_by_owner_id)
  WHERE employed_by_owner_id IS NOT NULL;

-- ── 2. Owner expense itemisation ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS owner_expenses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_ledger_id  uuid NOT NULL REFERENCES ledgers(id)   ON DELETE RESTRICT,
  vehicle_id       uuid          REFERENCES vehicles(id)  ON DELETE RESTRICT,
  driver_id        uuid          REFERENCES drivers(id)   ON DELETE RESTRICT,
  company_id       uuid          REFERENCES companies(id) ON DELETE RESTRICT,
  branch_id        uuid          REFERENCES branches(id)  ON DELETE RESTRICT,
  kind             text NOT NULL,
  expense_date     date NOT NULL DEFAULT CURRENT_DATE,
  amount           numeric(14,2) NOT NULL CHECK (amount > 0),
  narration        text,
  reference_no     text,
  -- The posting this row describes. NOT NULL: an itemisation with no voucher
  -- behind it is a claim about money that was never booked.
  voucher_id       uuid NOT NULL,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- The kinds the engine posts. Constrained rather than free text so a typo
-- cannot create a category that silently never appears on any statement.
ALTER TABLE owner_expenses DROP CONSTRAINT IF EXISTS owner_expenses_kind;
ALTER TABLE owner_expenses ADD CONSTRAINT owner_expenses_kind CHECK (
  kind IN ('DRIVER_SALARY', 'DRIVER_BHATTA', 'VEHICLE_EMI', 'MAINTENANCE',
           'TYRE', 'BATTERY', 'TRAFFIC_FINE', 'RTO_PENALTY', 'OTHER')
);

-- A driver only belongs on a driver-shaped expense.
ALTER TABLE owner_expenses DROP CONSTRAINT IF EXISTS owner_expenses_driver_shape;
ALTER TABLE owner_expenses ADD CONSTRAINT owner_expenses_driver_shape CHECK (
  driver_id IS NULL OR kind IN ('DRIVER_SALARY', 'DRIVER_BHATTA')
);

-- Re-posting the same reference for the same owner is a duplicate, not a second
-- payment. TARA refuses the voucher; this refuses the itemisation too, so the
-- two cannot drift.
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_expenses_ref
  ON owner_expenses (owner_ledger_id, kind, reference_no)
  WHERE reference_no IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_owner_expenses_owner ON owner_expenses (owner_ledger_id, expense_date DESC);
CREATE INDEX IF NOT EXISTS idx_owner_expenses_vehicle ON owner_expenses (vehicle_id, expense_date DESC);

COMMENT ON TABLE owner_expenses IS
  'Itemisation of costs the company paid on a vehicle owner''s behalf. Holds no money: every row references the TARA voucher that debited the owner ledger. Exists because those debits are indistinguishable in ledger_entries once posted, and an owner statement has to show EMI apart from bhatta.';

COMMIT;
