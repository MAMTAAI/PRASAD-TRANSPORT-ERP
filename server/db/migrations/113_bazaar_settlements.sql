-- ═══════════════════════════════════════════════════════════════════════════
-- 113_bazaar_settlements.sql — the money lifecycle behind an awarded load
--
-- Load Bazaar Phase 2. An award used to be the end of the record: the bid
-- flipped to ACCEPTED and everything after — confirmation, the truck, the
-- advance, the POD, the balance — lived on WhatsApp and in heads. This table
-- is that lifecycle, one row per awarded load.
--
-- THE 0%-ERROR RULE, WRITTEN INTO THE SHAPE:
--   * This table is WORKFLOW STATE, never a ledger. Every rupee moves through
--     TARA (postVoucher) into ledger_entries; the *_voucher_id columns are
--     receipts pointing at the books, and the cached amounts exist only so a
--     list screen needn't join the GL. Where they could ever disagree, the
--     voucher is the truth.
--   * Idempotency is the voucher's ref_no (BZADV-<id>, BZBAL-<id>, …) —
--     TARA's duplicate guard makes the same advance unpostable twice.
--   * The status CHECK is the settlement's only path. The balance-release
--     route refuses any row not at POD_VERIFIED, so money cannot leave before
--     the delivery proof is checked — enforced where the voucher is created,
--     not in a screen.
--
-- One settlement per load (UNIQUE): a load awarded twice was already made
-- impossible by uq_bazaar_bid_winner; this holds the same line here.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS bazaar_settlements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id             text NOT NULL UNIQUE REFERENCES bazaar_loads(load_id) ON UPDATE CASCADE,
  bid_id              uuid NOT NULL REFERENCES bazaar_bids(id),
  vendor_id           uuid REFERENCES vendors(id),
  customer_id         uuid REFERENCES customers(id),
  -- Which firm's books take this business. Staff-set; NULL surfaces on
  -- v_accounting_health rather than ever being guessed.
  company_id          uuid REFERENCES companies(id),

  awarded_amount      numeric(14,2) NOT NULL CHECK (awarded_amount > 0),
  -- Market convention: ~90% at loading, balance after POD (R&D 2026-08-31).
  advance_pct         numeric(5,2)  NOT NULL DEFAULT 90 CHECK (advance_pct >= 0 AND advance_pct <= 100),

  status              text NOT NULL DEFAULT 'AWAITING_CONFIRM' CHECK (status IN
                        ('AWAITING_CONFIRM',   -- awarded; vendor must confirm by the deadline
                         'CONFIRMED',          -- vendor said yes
                         'VEHICLE_ASSIGNED',   -- an approved truck (and driver) named
                         'ADVANCE_PAID',       -- advance voucher posted
                         'POD_SUBMITTED',      -- delivery proof uploaded, awaiting check
                         'POD_VERIFIED',       -- office checked the POD — balance may release
                         'SETTLED',            -- balance voucher posted
                         'CANCELLED')),

  confirm_deadline    timestamptz,
  vendor_confirmed_at timestamptz,

  market_vehicle_id   uuid REFERENCES market_vehicles(id),
  market_driver_id    uuid REFERENCES market_drivers(id),

  -- Receipts into the books. Amounts cached for the list screen only.
  vendor_deposit_voucher_id        uuid,
  vendor_deposit_refund_voucher_id uuid,
  customer_deposit_voucher_id        uuid,
  customer_deposit_refund_voucher_id uuid,
  deposit_amount      numeric(14,2),
  advance_voucher_id  uuid,
  advance_amount      numeric(14,2),
  balance_voucher_id  uuid,
  balance_amount      numeric(14,2),

  pod_file            text,
  pod_submitted_at    timestamptz,
  pod_submitted_by    text,
  pod_verified_at     timestamptz,
  pod_verified_by     text,
  pod_note            text,

  cancel_reason       text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bazaar_settlements_status
  ON bazaar_settlements (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bazaar_settlements_vendor
  ON bazaar_settlements (vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bazaar_settlements_customer
  ON bazaar_settlements (customer_id, created_at DESC);

COMMIT;
