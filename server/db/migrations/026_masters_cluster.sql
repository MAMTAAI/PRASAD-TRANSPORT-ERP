-- ═══════════════════════════════════════════════════════════════════════════
-- 026_masters_cluster.sql — fleet & party masters
--
-- The masters screens referenced seven Firestore collections with no PostgreSQL
-- home. Five of them do not need one, and saying why matters more than adding
-- them:
--
--   ASSETS              A legacy collection that Vehical.tsx merged into
--                       VEHICLES ("ho to merge, na ho to skip"). The migration
--                       already folded that data into `vehicles`; a table now
--                       would resurrect a split that was deliberately closed.
--   BRANCHES            Not an entity — the distinct branch values already on
--                       ledgers and ledger_entries ARE the list, and
--                       /finance/masters/companies already returns them. A
--                       table would let the dropdown offer a branch no record
--                       uses.
--   CUSTOMER_PAYMENTS   A customer payment is a RECEIPT voucher. TARA already
--                       posts those (Dr bank / Cr debtor) from Cash & Bank Book
--                       and from bill settlement. A second store of the same
--                       cash is exactly how BANK_TRANSACTIONS came to disagree
--                       with the ledger.
--   MONTHLY_INVOICES    Superseded by company_bills (migration 019).
--   EXTERNAL_CUSTOMERS  A portal-registered customer IS a customer, with extra
--                       provenance. `customers` already carries
--                       portal_features jsonb, consignees and locations, so it
--                       gains a source discriminator instead of a twin table
--                       that would need its own ledger, its own dedup and its
--                       own billing link.
--
-- What genuinely is missing: the driver app's request queue, and a vendor
-- subsidiary ledger to match the driver one.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Portal customers folded into `customers` ─────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS customer_source text NOT NULL DEFAULT 'INTERNAL'
    CHECK (customer_source IN ('INTERNAL','PORTAL')),
  -- Only meaningful for PORTAL rows: a self-registered customer is not visible
  -- to billing until a human approves it. INTERNAL rows are approved by
  -- definition, which the default expresses rather than leaving NULL to guess.
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'APPROVED'
    CHECK (approval_status IN ('PENDING','APPROVED','BLOCKED')),
  ADD COLUMN IF NOT EXISTS portal_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS portal_email   citext;

CREATE INDEX IF NOT EXISTS idx_customers_portal
  ON customers (approval_status) WHERE customer_source = 'PORTAL';
CREATE UNIQUE INDEX IF NOT EXISTS uq_customers_portal_email
  ON customers (portal_email) WHERE portal_email IS NOT NULL;

-- ── 2. Driver app request queue ─────────────────────────────────────────────
-- The driver asks for cash/fuel from the app; the office pays or refuses. The
-- request is NOT the money — paying one writes a driver_transactions row (and,
-- through the trip screens, a ledger journal). Keeping them separate is what
-- lets a request be refused without leaving an accounting trace.
CREATE TABLE IF NOT EXISTS driver_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id    text UNIQUE,
  driver_id    uuid REFERENCES drivers(id),
  driver_name  text NOT NULL,
  trip_id      uuid REFERENCES trips(id),
  request_type text NOT NULL CHECK (request_type IN ('ADVANCE','FUEL','EXPENSE','LEAVE','OTHER')),
  amount       numeric(14,2) NOT NULL DEFAULT 0,
  remarks      text,
  photo_url    text,
  status       text NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','PAID','REJECTED')),
  payment_mode text,
  -- The subsidiary row this request produced when paid, so a request can never
  -- be double-paid and the khata entry can be traced back to its request.
  txn_id       uuid REFERENCES driver_transactions(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  settled_at   timestamptz,
  settled_by   text
);

CREATE INDEX IF NOT EXISTS idx_driver_req_pending
  ON driver_requests (requested_at DESC) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_driver_req_driver
  ON driver_requests (driver_name, requested_at DESC);

-- ── 3. Vendor subsidiary ledger ─────────────────────────────────────────────
-- The mirror of driver_transactions for pumps and suppliers. Like that table
-- this is a subsidiary record, not the general ledger: vendor payments post to
-- the GL as PAYMENT vouchers through TARA.
CREATE TABLE IF NOT EXISTS vendor_txns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id    text UNIQUE,
  vendor_id    uuid NOT NULL REFERENCES vendors(id),
  vendor_name  text NOT NULL,
  txn_date     date NOT NULL DEFAULT CURRENT_DATE,
  txn_type     text NOT NULL CHECK (txn_type IN ('PAYMENT_GIVEN','BILL_RECEIVED','OPENING','ADJUSTMENT','CREDIT_NOTE')),
  amount       numeric(14,2) NOT NULL,
  payment_mode text,
  remarks      text,
  voucher_id   uuid,                       -- the GL voucher, when one was posted
  created_at   timestamptz NOT NULL DEFAULT now(),
  created_by   text
);

CREATE INDEX IF NOT EXISTS idx_vendor_txns_vendor ON vendor_txns (vendor_id, txn_date DESC);

COMMENT ON COLUMN vendor_txns.amount IS
  'Signed by txn_type: PAYMENT_GIVEN reduces what we owe, BILL_RECEIVED increases it.';

COMMIT;
