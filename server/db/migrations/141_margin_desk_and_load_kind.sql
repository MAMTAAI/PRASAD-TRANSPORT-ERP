-- 141_margin_desk_and_load_kind.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE MARGIN DESK, AND TWO KINDS OF LOAD (owner directive, 2026-09-03)
--
-- 1 · MARGIN. "Neither the Customer nor the Fleet Partner sees the margin split.
--     Customer sees total landed freight; Fleet Partner sees their winning bid.
--     Margin is 100% hidden and visible only to Office Staff."
--
--     So the two rates live on the DEAL, not on the parties' own rows, and the
--     portals never select them. `customer_rate` is what the customer is billed;
--     `awarded_amount` (already here) is what the partner is paid; the margin is
--     the difference, stored so a later rate correction cannot silently rewrite
--     history, and so the deck can sum it without recomputing from two tables.
--
--     A negative margin is allowed — the owner takes one to keep a client — but
--     only with a typed reason, enforced by a CHECK so no route can skip it.
--
-- 2 · LOAD KIND. "Contract loads (IOCL / oil companies / fleet agreement) skip
--     the Load Bazaar completely: fixed rate master, direct allocation. Market
--     loads route through the 3-player bidding engine."
--
--     One column decides which engine a load enters. It is NOT derived from the
--     customer: the same firm can hand us a contract lane in the morning and a
--     spot load in the afternoon, and guessing from `customers` is how a spot
--     load quietly gets billed at a contract rate.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- ── 1. WHICH ENGINE ──────────────────────────────────────────────────────────
ALTER TABLE bazaar_loads
  ADD COLUMN IF NOT EXISTS load_kind text NOT NULL DEFAULT 'MARKET',
  -- The operating company whose books this deal belongs to. Same reason as the
  -- vendor bills (migration 140): three firms, three ledgers.
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  -- Contract loads: the rate that was fetched, and what it was fetched from, so
  -- an invoice can always be traced back to the agreement it came from.
  ADD COLUMN IF NOT EXISTS contract_rate      numeric(14,2),
  ADD COLUMN IF NOT EXISTS contract_rate_type text,          -- RTKM | PER_MT | PER_KL | LUMPSUM
  ADD COLUMN IF NOT EXISTS contract_rate_ref  text;          -- which rate_master row / slab

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bazaar_loads_load_kind_check') THEN
    ALTER TABLE bazaar_loads ADD CONSTRAINT bazaar_loads_load_kind_check
      CHECK (load_kind IN ('MARKET', 'CONTRACT'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bazaar_loads_kind
  ON bazaar_loads (load_kind, status, created_at DESC);

-- ── 2. THE DEAL'S TWO RATES AND ITS SPREAD ──────────────────────────────────
ALTER TABLE bazaar_settlements
  ADD COLUMN IF NOT EXISTS customer_rate  numeric(14,2),
  ADD COLUMN IF NOT EXISTS margin_amount  numeric(14,2),
  ADD COLUMN IF NOT EXISTS margin_pct     numeric(6,2),
  ADD COLUMN IF NOT EXISTS margin_reason  text,
  ADD COLUMN IF NOT EXISTS locked_by      uuid,
  ADD COLUMN IF NOT EXISTS locked_at      timestamptz,
  ADD COLUMN IF NOT EXISTS company_id     uuid REFERENCES companies(id) ON DELETE SET NULL;

-- A loss must be a decision somebody signed, not a rounding accident. The rule
-- lives here rather than in a route so that no future path — an import, a
-- correction script, a second endpoint — can write one silently.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bazaar_settlements_negative_margin_needs_reason') THEN
    ALTER TABLE bazaar_settlements ADD CONSTRAINT bazaar_settlements_negative_margin_needs_reason
      CHECK (margin_amount IS NULL OR margin_amount >= 0
             OR (margin_reason IS NOT NULL AND length(btrim(margin_reason)) >= 5));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_bazaar_settlements_locked
  ON bazaar_settlements (locked_at DESC) WHERE locked_at IS NOT NULL;

-- ── 3. THE MARGIN IS NEVER IN A PORTAL VIEW ─────────────────────────────────
-- v_bazaar_load_feed is what a fleet partner reads. It has never carried the
-- customer's target and must never carry the margin either; this comment is the
-- reminder for whoever extends it next. The columns above live on tables the
-- portal routes select from BY NAME, never with SELECT * — see
-- vendorPortal.routes.js and customerPortal.routes.js.

COMMENT ON COLUMN bazaar_settlements.margin_amount IS
  'OFFICE ONLY. customer_rate - awarded_amount. Never selected by a portal route.';
COMMENT ON COLUMN bazaar_settlements.customer_rate IS
  'What the customer is billed. The partner never sees it; they see awarded_amount.';

COMMIT;
