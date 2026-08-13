-- ═══════════════════════════════════════════════════════════════════════════
-- 035_loans_and_maintenance.sql — loans/EMI, tyres, batteries, maintenance.
--
-- `loan_master` (17 real loans) and `tyres` / `tyre_fitments` already existed.
-- What was missing is everything that RECORDS ACTIVITY against them: the EMI
-- payments, the battery equivalents of the tyre tables, and the service log.
--
-- ── ON THE LOAN COUNTERS ────────────────────────────────────────────────────
-- `remaining_principal`, `emis_completed` and `total_interest_paid` are STORED
-- and stay stored. That is the opposite of the call made for vendors (029) and
-- fleet cards (030), so the reason matters:
--
--   Those balances could be derived because every transaction behind them came
--   across. A loan's DOES NOT — the 17 loans carry EMIs already paid over years
--   in Firestore and earlier on paper, and `emi_payments` starts empty.
--   Deriving would reset every loan to its full sanctioned principal and
--   report lakhs of debt that has already been repaid.
--
-- So the counter is the carry-forward, and `opening_*` below freezes what it
-- was at migration so drift is DETECTABLE rather than invisible:
--
--     expected_remaining = opening_remaining_principal - SUM(principal_part)
--
-- `v_loan_reconciliation` computes exactly that and flags any loan where the
-- stored figure and the payment history disagree. The counter is only ever
-- moved inside the same transaction as the payment that moves it — never
-- read-modify-written from a browser, which is how the Firestore version lost
-- a payment whenever two people paid at once.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Loans: freeze the carry-forward ─────────────────────────────────────
ALTER TABLE loan_master
  ADD COLUMN IF NOT EXISTS opening_remaining_principal numeric(14,2),
  ADD COLUMN IF NOT EXISTS opening_emis_completed      integer,
  ADD COLUMN IF NOT EXISTS opening_as_of               date,
  ADD COLUMN IF NOT EXISTS financier_ledger            text;

-- Stamped once, from the figures the migration brought over.
UPDATE loan_master
   SET opening_remaining_principal = COALESCE(remaining_principal, principal_amt, 0),
       opening_emis_completed      = COALESCE(emis_completed, 0),
       opening_as_of               = CURRENT_DATE
 WHERE opening_remaining_principal IS NULL;

-- ── 2. EMI payments ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS emi_payments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id         text UNIQUE,
  loan_id           uuid NOT NULL REFERENCES loan_master(id) ON DELETE RESTRICT,
  payment_date      date NOT NULL DEFAULT CURRENT_DATE,
  emi_month         text,
  months_paid       integer NOT NULL DEFAULT 1 CHECK (months_paid > 0),
  -- An EMI is principal + interest, and they hit DIFFERENT accounts: principal
  -- reduces the loan liability, interest is a finance cost. Splitting them here
  -- is what lets the voucher be correct.
  principal_part    numeric(14,2) NOT NULL DEFAULT 0 CHECK (principal_part >= 0),
  interest_part     numeric(14,2) NOT NULL DEFAULT 0 CHECK (interest_part >= 0),
  total_paid        numeric(14,2) NOT NULL CHECK (total_paid > 0),
  payment_mode      text,
  ref_no            text,
  paid_from_account text,
  voucher_id        uuid,
  company           text,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- The parts must add up to what left the bank.
  CONSTRAINT emi_parts_sum CHECK (abs(principal_part + interest_part - total_paid) <= 0.05)
);
CREATE INDEX IF NOT EXISTS emi_payments_loan_idx ON emi_payments (loan_id, payment_date DESC);
-- One UTR/cheque pays once.
CREATE UNIQUE INDEX IF NOT EXISTS emi_payments_ref_uniq
  ON emi_payments (loan_id, ref_no) WHERE ref_no IS NOT NULL AND ref_no <> '';

-- ── 3. Does the stored counter still match the payments? ───────────────────
CREATE OR REPLACE VIEW v_loan_reconciliation AS
SELECT l.id, l.loan_account_no, l.vehicle_no, l.bank_name,
       l.principal_amt, l.opening_remaining_principal, l.opening_as_of,
       l.remaining_principal                              AS stored_remaining,
       COALESCE(p.principal_paid, 0)::numeric(14,2)       AS principal_paid_since,
       (l.opening_remaining_principal - COALESCE(p.principal_paid, 0))::numeric(14,2) AS expected_remaining,
       (l.remaining_principal - (l.opening_remaining_principal - COALESCE(p.principal_paid, 0)))::numeric(14,2) AS drift,
       COALESCE(p.n, 0)::int                              AS payments_recorded,
       l.emis_completed, l.opening_emis_completed,
       l.payment_status
  FROM loan_master l
  LEFT JOIN LATERAL (
    SELECT count(*) n, SUM(principal_part) principal_paid
      FROM emi_payments WHERE loan_id = l.id) p ON true;

COMMENT ON VIEW v_loan_reconciliation IS
  'drift <> 0 means the stored remaining_principal and the recorded EMI payments disagree. Investigate; do not silently overwrite either.';

-- ── 4. Batteries — the tyre tables, one component over ─────────────────────
CREATE TABLE IF NOT EXISTS batteries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       text UNIQUE,
  serial_no       text NOT NULL,
  brand           text,
  model           text,
  capacity_ah     numeric(8,2),
  warranty_months integer,
  purchase_date   date,
  purchase_cost   numeric(12,2),
  base_cost       numeric(12,2),
  gst_amount      numeric(12,2),
  gst_percent     numeric(5,2),
  invoice_no      text,
  invoice_url     text,
  vendor_name     text,
  -- Same spelling as tyres_status_check, which is the incumbent: underscores,
  -- not spaces. Two tables describing the same life cycle with two different
  -- vocabularies is a join waiting to silently return nothing.
  status          text NOT NULL DEFAULT 'IN_STOCK'
                  CHECK (status IN ('IN_STOCK','FITTED','SCRAPPED','WARRANTY_CLAIM')),
  removal_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS batteries_serial_uniq
  ON batteries (upper(regexp_replace(serial_no, '[^A-Za-z0-9]', '', 'g')));

CREATE TABLE IF NOT EXISTS battery_fitments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id      text UNIQUE,
  battery_id     uuid REFERENCES batteries(id) ON DELETE CASCADE,
  battery_serial text,
  vehicle_id     uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  vehicle_no     text,
  position       text,
  fitment_date   date NOT NULL DEFAULT CURRENT_DATE,
  fitment_km     numeric(12,2),
  removal_date   date,
  removal_km     numeric(12,2),
  removal_reason text,
  cost           numeric(12,2),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS battery_fitments_vehicle_idx ON battery_fitments (vehicle_no, fitment_date DESC);
-- A battery is in one place at a time.
CREATE UNIQUE INDEX IF NOT EXISTS battery_fitments_live_uniq
  ON battery_fitments (battery_id) WHERE removal_date IS NULL;

-- ── 5. Tyres: the invoice detail the screen already collects ───────────────
ALTER TABLE tyres
  ADD COLUMN IF NOT EXISTS tyre_type    text,
  ADD COLUMN IF NOT EXISTS base_cost    numeric(12,2),
  ADD COLUMN IF NOT EXISTS gst_amount   numeric(12,2),
  ADD COLUMN IF NOT EXISTS gst_percent  numeric(5,2),
  ADD COLUMN IF NOT EXISTS invoice_no   text,
  ADD COLUMN IF NOT EXISTS invoice_url  text,
  ADD COLUMN IF NOT EXISTS total_km_run numeric(12,2) NOT NULL DEFAULT 0;

-- tyre_fitments keyed only on vehicle_id, but every screen and every operator
-- works in plates, and a fitment recorded against a vehicle the master does not
-- have yet would have been orphaned. battery_fitments above carries both for
-- the same reason; this brings tyres level.
ALTER TABLE tyre_fitments
  ADD COLUMN IF NOT EXISTS vehicle_no text;

UPDATE tyre_fitments f SET vehicle_no = v.vehicle_no
  FROM vehicles v WHERE v.id = f.vehicle_id AND f.vehicle_no IS NULL;

CREATE INDEX IF NOT EXISTS tyre_fitments_vehicle_idx ON tyre_fitments (vehicle_no, fitment_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS tyres_serial_uniq
  ON tyres (upper(regexp_replace(serial_no, '[^A-Za-z0-9]', '', 'g')));
CREATE UNIQUE INDEX IF NOT EXISTS tyre_fitments_live_uniq
  ON tyre_fitments (tyre_id) WHERE removal_date IS NULL;

-- A tyre can also come back from the retreader as a warranty claim; batteries
-- have no retreading. The two lists differ only where the domain differs.
ALTER TABLE tyres DROP CONSTRAINT IF EXISTS tyres_status_check;
ALTER TABLE tyres ADD CONSTRAINT tyres_status_check
  CHECK (status IN ('IN_STOCK','FITTED','RETREADING','SCRAPPED','WARRANTY_CLAIM'));

-- ── 6. Maintenance log ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS maintenance_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  vehicle_id    uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  vehicle_no    text NOT NULL,
  service_date  date NOT NULL DEFAULT CURRENT_DATE,
  service_type  text,
  garage_name   text,
  vendor_id     uuid REFERENCES vendors(id) ON DELETE SET NULL,
  bill_no       text,
  bill_amount   numeric(14,2) NOT NULL DEFAULT 0,
  odometer_km   numeric(12,2),
  next_due_km   numeric(12,2),
  next_due_date date,
  parts         jsonb NOT NULL DEFAULT '[]'::jsonb,
  remarks       text,
  bill_url      text,
  voucher_id    uuid,
  company       text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_vehicle_idx ON maintenance_logs (vehicle_no, service_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_bill_uniq
  ON maintenance_logs (lower(garage_name), bill_no) WHERE bill_no IS NOT NULL AND bill_no <> '';

DROP TRIGGER IF EXISTS batteries_touch ON batteries;
CREATE TRIGGER batteries_touch BEFORE UPDATE ON batteries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS maintenance_logs_touch ON maintenance_logs;
CREATE TRIGGER maintenance_logs_touch BEFORE UPDATE ON maintenance_logs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
