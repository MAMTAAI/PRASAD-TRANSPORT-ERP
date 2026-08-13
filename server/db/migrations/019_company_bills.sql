-- ═══════════════════════════════════════════════════════════════════════════
-- 019_company_bills.sql — sales invoices (customer bills) + bank-master fields
--
-- Bill Management was the last money-facing screen still reading Firestore
-- (COMPANY_BILLS). A bill is not derivable from the trips it covers: it fixes a
-- period, a location, a chosen rate and a bill number, and it survives the
-- trips being edited afterwards. So it is stored, not computed.
--
-- Shape: header + one row per covered trip. The line rows carry the figures as
-- billed (qty, rate, gross, TDS) rather than joining live trip columns — a bill
-- reprinted next year must show what was actually sent, not what the trip says
-- today. That is the same reason iocl_bill_lines exists alongside trips.
--
-- Settlement money does NOT live here. `POST /bills/:id/settle` posts a RECEIPT
-- through TARA and stores only the voucher id; the ledger stays the single
-- source of truth for cash, and this table can never disagree with it.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS company_bills (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id         text UNIQUE,                    -- Firestore doc id on import
  bill_no           text NOT NULL UNIQUE,
  bill_date         date NOT NULL DEFAULT CURRENT_DATE,
  customer_id       uuid REFERENCES customers(id),
  customer_name     text NOT NULL,
  company           text,
  branch            text,
  -- Oil companies bill per plant/depot; a mixed-location bill will not match
  -- the customer's own document, so the location is part of the bill's identity.
  location          text,
  location_code     text,
  period_from       date,
  period_to         date,
  total_gross       numeric(14,2) NOT NULL DEFAULT 0,
  total_shortage    numeric(14,2) NOT NULL DEFAULT 0,
  total_tds         numeric(14,2) NOT NULL DEFAULT 0,
  total_cgst        numeric(14,2) NOT NULL DEFAULT 0,
  total_sgst        numeric(14,2) NOT NULL DEFAULT 0,
  total_igst        numeric(14,2) NOT NULL DEFAULT 0,
  total_net         numeric(14,2) NOT NULL DEFAULT 0,   -- expected receivable
  received_amount   numeric(14,2) NOT NULL DEFAULT 0,   -- Σ settled, never negative
  status            text NOT NULL DEFAULT 'PENDING_PAYMENT'
                    CHECK (status IN ('PENDING_PAYMENT','PARTIALLY_PAID','SETTLED','CANCELLED')),
  -- GST here is reverse-charge memo only: the customer (IOCL) discharges it.
  -- Recording it as our output tax would overstate the liability.
  gst_reverse_charge boolean NOT NULL DEFAULT true,
  created_by        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_company_bills_customer ON company_bills (customer_name);
CREATE INDEX IF NOT EXISTS idx_company_bills_status   ON company_bills (status);
CREATE INDEX IF NOT EXISTS idx_company_bills_date     ON company_bills (bill_date DESC);

CREATE TABLE IF NOT EXISTS company_bill_trips (
  id                bigserial PRIMARY KEY,
  bill_id           uuid NOT NULL REFERENCES company_bills(id) ON DELETE CASCADE,
  trip_id           uuid REFERENCES trips(id),
  trip_code         text,
  lr_no             text,
  vehicle_no        text,
  driver_name       text,
  loading_date      date,
  unloading_date    date,
  qty               numeric(14,3) NOT NULL DEFAULT 0,
  rate              numeric(14,4) NOT NULL DEFAULT 0,
  rtkm              numeric(14,3) NOT NULL DEFAULT 0,
  billing_type      text NOT NULL DEFAULT 'PER_KL',
  gross_freight     numeric(14,2) NOT NULL DEFAULT 0,
  shortage_amt      numeric(14,2) NOT NULL DEFAULT 0,
  tds_amt           numeric(14,2) NOT NULL DEFAULT 0,
  cgst_amt          numeric(14,2) NOT NULL DEFAULT 0,
  sgst_amt          numeric(14,2) NOT NULL DEFAULT 0,
  igst_amt          numeric(14,2) NOT NULL DEFAULT 0,
  net_payable       numeric(14,2) NOT NULL DEFAULT 0,
  -- Set when the party pays less than net_payable; recovered from the driver
  -- only when recover_from_driver is true.
  extra_shortage_amt   numeric(14,2) NOT NULL DEFAULT 0,
  recover_from_driver  boolean NOT NULL DEFAULT true,
  final_passed_amt     numeric(14,2),
  payment_status     text NOT NULL DEFAULT 'PENDING'
                     CHECK (payment_status IN ('PENDING','SETTLED')),
  settled_voucher_id uuid,
  settled_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- One trip belongs to at most one live bill. Cancelling a bill frees its trips
-- (the row goes with the header via ON DELETE CASCADE), so this cannot wedge.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bill_trip ON company_bill_trips (trip_id)
  WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bill_trips_bill ON company_bill_trips (bill_id);

-- ── Billing linkage on trips ────────────────────────────────────────────────
-- KALI owns `trips`. These two columns are billing linkage, not trip state, and
-- are written only by the bills route — the same narrow exception the IOCL
-- reconciler already takes for its settlement columns. Trip status, dates and
-- quantities stay KALI's alone.
ALTER TABLE trips ADD COLUMN IF NOT EXISTS billing_status text;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS linked_bill_id uuid REFERENCES company_bills(id);
CREATE INDEX IF NOT EXISTS idx_trips_billing_status ON trips (billing_status);

-- ── Bank master fields ──────────────────────────────────────────────────────
-- Cash & Bank Book maintains bank accounts (COMPANY_BANKS in Firestore). A bank
-- account is already a ledger under 'Bank Accounts'; it only lacked the two
-- identifying fields a payment needs.
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS account_no text;
ALTER TABLE ledgers ADD COLUMN IF NOT EXISTS ifsc_code  text;

-- ── Reporting view ──────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_company_bill_summary AS
SELECT b.id, b.bill_no, b.bill_date, b.customer_name, b.company, b.branch,
       b.location, b.location_code, b.period_from, b.period_to,
       b.total_gross, b.total_shortage, b.total_tds, b.total_net,
       b.received_amount,
       (b.total_net - b.received_amount)::numeric(14,2) AS outstanding,
       b.status, b.gst_reverse_charge, b.created_at,
       count(t.id)::int                                        AS trip_count,
       count(t.id) FILTER (WHERE t.payment_status = 'SETTLED')::int AS settled_trips
  FROM company_bills b
  LEFT JOIN company_bill_trips t ON t.bill_id = b.id
 GROUP BY b.id;

COMMIT;
