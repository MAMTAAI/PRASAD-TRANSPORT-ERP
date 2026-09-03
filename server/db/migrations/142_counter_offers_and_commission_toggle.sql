-- 142_counter_offers_and_commission_toggle.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- COUNTER-OFFERS, AND THE COMMISSION TOGGLE (owner directive, 3-Sep-2026)
--
-- 1 · COUNTER-OFFERS. "Staff can submit live Counter-Bids to both Customer
--     (asking for a rate increase) and Fleet Partner (asking for a bid
--     reduction) directly inside the system."
--
--     A counter is not an edit of somebody else's number — it is an ASK, with a
--     direction, an amount, and an answer. Storing it as a row rather than
--     overwriting target_rate/bid_amount is what lets the desk see that it
--     asked ₹43,000 and was answered ₹41,500, which is the whole negotiation.
--
-- 2 · COMMISSION VISIBILITY. Two messages ago the rule was "margin is 100%
--     hidden from the partner", and that is still the DEFAULT here — false.
--     The owner now wants a switch, so it is a switch, off until somebody
--     turns it on, per party. A global default lives in toll_settings-style
--     app settings; this column is the per-partner override.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

CREATE TABLE IF NOT EXISTS bazaar_counter_offers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  load_id       text NOT NULL REFERENCES bazaar_loads(load_id) ON DELETE CASCADE,
  -- Who is being asked. CUSTOMER = "please pay more"; PARTNER = "please take less".
  party         text NOT NULL CHECK (party IN ('CUSTOMER', 'PARTNER')),
  -- The partner being countered (NULL for a customer counter).
  bid_id        uuid REFERENCES bazaar_bids(id) ON DELETE SET NULL,
  vendor_id     uuid REFERENCES vendors(id) ON DELETE SET NULL,
  from_amount   numeric(14,2),                 -- what they had said
  ask_amount    numeric(14,2) NOT NULL CHECK (ask_amount > 0),
  note          text,
  status        text NOT NULL DEFAULT 'SENT'
                CHECK (status IN ('SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'WITHDRAWN')),
  answered_amount numeric(14,2),
  answered_at   timestamptz,
  sent_by       uuid,
  sent_at       timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  channel       text                            -- how it was sent: whatsapp / call / email
);

CREATE INDEX IF NOT EXISTS idx_counter_open
  ON bazaar_counter_offers (load_id, party, sent_at DESC) WHERE status = 'SENT';

-- ── 2. THE COMMISSION SWITCH ────────────────────────────────────────────────
-- Per fleet partner, default FALSE — the state the owner asked for first, and
-- the safe one: a switch that defaults to disclosure would leak the spread on
-- every partner created before anybody thought about it.
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS show_commission boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN vendors.show_commission IS
  'Fleet partners only. When true this partner sees the office commission line '
  'on a locked deal; when false (default) it sees only its own net freight.';

-- ── 3. WHAT WAS POSTED WHEN THE DEAL LOCKED ─────────────────────────────────
-- The voucher id, so the deck can show that the commitment reached the books
-- and an auditor can walk from the deal to the ledger without a join guess.
ALTER TABLE bazaar_settlements
  ADD COLUMN IF NOT EXISTS lock_voucher_id uuid;

COMMIT;
