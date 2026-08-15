-- ═══════════════════════════════════════════════════════════════════════════
-- 057_fuel_import_review.sql — the queue for fuel rows that must NOT post
--
-- Parsing 132 pump bills produced 412 rows. 314 are clean, 98 carry a defect
-- the parser could see (no vehicle, a truncated lorry number, an amount that
-- does not equal qty x rate, a date outside the bill's own period), and a
-- further 36 collide with fuel already in the books on the same vehicle and
-- date for a different amount.
--
-- NONE OF THOSE MAY REACH A LEDGER. Diesel is a direct cost on somebody's
-- khata — the company's for its own trucks, a vehicle owner's for an attached
-- one — so a wrong litre is a wrong rupee in a real person's account. They land
-- here instead, with the reason and the original parsed values, for a human to
-- correct or discard.
--
-- The queue holds the PARSE, not money. Nothing here is posted; resolving a row
-- means editing it and sending it back through the importer, which is the only
-- path that touches ledger_entries.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS fuel_import_review (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id      uuid,
  pump          text NOT NULL,
  company_hint  text,
  source_file   text,
  -- Exactly as parsed, so a reviewer can see what the bill said rather than a
  -- cleaned-up guess at what it meant.
  entry_date    date,
  vehicle_raw   text,
  vehicle_norm  text,
  memo_no       text,
  qty           numeric(12,3),
  rate          numeric(12,3),
  amount        numeric(14,2),
  cash          numeric(14,2),
  reasons       text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'PENDING',
  resolved_note text,
  resolved_by   text,
  resolved_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fuel_import_review DROP CONSTRAINT IF EXISTS fuel_review_status;
ALTER TABLE fuel_import_review ADD CONSTRAINT fuel_review_status CHECK (
  status IN ('PENDING', 'RESOLVED', 'DISCARDED')
);

CREATE INDEX IF NOT EXISTS idx_fuel_review_status ON fuel_import_review (status, pump);
-- Re-running the parser must not pile up the same defective row again.
CREATE UNIQUE INDEX IF NOT EXISTS idx_fuel_review_natural
  ON fuel_import_review (pump, source_file, COALESCE(vehicle_raw, ''), COALESCE(entry_date, '1900-01-01'), COALESCE(amount, 0));

-- Batches, so an import can be described and — if it was wrong — found again in
-- one query rather than by date-guessing across 300 rows.
CREATE TABLE IF NOT EXISTS fuel_import_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL DEFAULT 'PUMP_PDF',
  note         text,
  rows_total   integer NOT NULL DEFAULT 0,
  rows_posted  integer NOT NULL DEFAULT 0,
  rows_review  integer NOT NULL DEFAULT 0,
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE fuel_entries ADD COLUMN IF NOT EXISTS import_batch_id uuid REFERENCES fuel_import_batches(id);
CREATE INDEX IF NOT EXISTS idx_fuel_entries_batch ON fuel_entries (import_batch_id);

-- ── pump creditor ledgers ───────────────────────────────────────────────────
-- Five pumps already have one. The bills name six more; without a ledger the
-- credit side of a fuel posting has nowhere to go and would fall into Suspense.
INSERT INTO ledgers (ledger_name, group_head, dr_cr, opening_balance, current_balance, creation_type, status)
SELECT v.name, 'Sundry Creditors (Fuel Pumps)', 'CR', 0, 0, 'SYSTEM', 'ACTIVE'
  FROM (VALUES
        ('Creditors: B N FILLING STATION'),
        ('Creditors: NIRMALA PETROLEUM'),
        ('Creditors: HEY KRISHNA BHAGAWAN SERVICE STATION'),
        ('Creditors: SHIVAM SERVICE CENTRE'),
        ('Creditors: HATSINGIMARI FUEL'),
        ('Creditors: K & K ENERGY STATION')
       ) AS v(name)
 WHERE NOT EXISTS (SELECT 1 FROM ledgers l WHERE l.ledger_name = v.name);

COMMIT;
