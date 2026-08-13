-- ═══════════════════════════════════════════════════════════════════════════
-- 029_party_and_rate_cluster.sql — columns the party (2b) and rate (2c)
-- screens carry that migrations 016 and 026 did not model.
--
-- Every column below exists because a live screen already collects it and the
-- Firestore document already stores it. Nothing speculative is added.
--
-- What is deliberately NOT added:
--
--   CUSTOMER_PAYMENTS   Still refused, for the reason 026 gave: a customer
--                       receipt is a RECEIPT voucher (Dr bank / Cr debtor)
--                       posted through TARA. CustomerLedger.tsx now posts one
--                       instead of writing a second store of the same cash.
--   MONTHLY_INVOICES    Still superseded by company_bills.
--   customers.total_*   The screen's Total Freight / Received / Shortage / TDS
--                       boxes are already columns here, but they are legacy
--                       stored counters. The API computes the outstanding from
--                       ledger_entries and company_bills instead, and the
--                       screen now shows the computed figure. The columns stay
--                       for the migrated history; nothing new writes them.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Customer contract terms ──────────────────────────────────────────────
-- billing_cycle is the one that carries real consequence: oil companies bill
-- fortnightly (two bills a month, 1-15 and 16-EOM) and everyone else monthly.
-- Auto-billing needs to know which, and until now it lived only in Firestore.
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS credit_limit    numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS account_manager text,
  ADD COLUMN IF NOT EXISTS billing_cycle   text NOT NULL DEFAULT '30_days'
    CHECK (billing_cycle IN ('15_days','30_days')),
  -- Oil companies do not pay detention; monthly contract clients do. A boolean
  -- rather than a rate: the rate belongs to the lane, this is eligibility.
  ADD COLUMN IF NOT EXISTS detention_applicable boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS city text;

-- ── 2. Rate rules: source and destination are the grain, not `route` ────────
-- rate_master.route is a single text field, but every rule the screen writes is
-- keyed on Customer + Source (loading depot) + Destination (consignee), and
-- freightEngine.resolveTripBilling() matches on exactly that triple. Storing it
-- glued into one string made the match impossible to express in SQL.
--
-- The 134 rows already here came from the IOCL bill rate card, where the lane
-- IS the ship-to: they backfill destination from `route` and leave source NULL,
-- which is honest — the bill does not name the loading depot.
ALTER TABLE rate_master
  ADD COLUMN IF NOT EXISTS source        text,
  ADD COLUMN IF NOT EXISTS destination   text,
  ADD COLUMN IF NOT EXISTS calc_type     text NOT NULL DEFAULT 'PER_UNIT'
    CHECK (calc_type IN ('RTKM_KL','RTKM_MT','PER_UNIT','FIXED_RATE')),
  ADD COLUMN IF NOT EXISTS rtkm_distance numeric(10,3);

UPDATE rate_master
   SET destination = route
 WHERE destination IS NULL AND route IS NOT NULL;

-- The derived IOCL card is priced per unit per km, which is the RTKM formula.
UPDATE rate_master
   SET calc_type = 'RTKM_KL'
 WHERE unit = 'RS_PER_UNIT_PER_KM' AND calc_type = 'PER_UNIT';

-- Two ACTIVE rules on one lane with overlapping effective windows make billing
-- ambiguous — the screen has guarded against it in JS since it was written, but
-- a guard that only lives in the browser is not a guard. Postgres cannot
-- express "overlapping ranges" in a plain unique index, so this is the pair
-- that CAN be expressed: one ACTIVE rule per lane per product per start date.
--
-- rate_type is in the key because the derived IOCL rows genuinely price by
-- product as well as lane — BIDANGSHREE carries a MATERIAL_16730 rate and a
-- MATERIAL_50700 rate on the same day, and both are correct. Screen-written
-- rules leave rate_type NULL, so two of those on one lane and window still
-- collide, which is the case the guard is for.
CREATE UNIQUE INDEX IF NOT EXISTS rate_master_lane_window_uniq
  ON rate_master (lower(customer_name), lower(coalesce(source,'')),
                  lower(coalesce(destination,'')), coalesce(rate_type,''),
                  calc_type, valid_from)
  WHERE status = 'ACTIVE';

-- ── 3. Lane billing formula + quarterly rate history ────────────────────────
-- IOCL does not bill Qty x Rate; it bills Qty x RTD x Rate-per-unit-per-km, and
-- the rate is revised quarterly. The screen has collected both for a while and
-- had nowhere to put them.
ALTER TABLE rtkm_master
  ADD COLUMN IF NOT EXISTS billing_type text NOT NULL DEFAULT 'PER_KL',
  -- [{valid_from, valid_to, rate_value}] — the loading date picks the row.
  -- jsonb rather than a child table: it is read whole, written whole, never
  -- joined and never aggregated across lanes.
  ADD COLUMN IF NOT EXISTS rate_history jsonb NOT NULL DEFAULT '[]'::jsonb;

-- ── 4. Vendor opening balance is the carried-forward figure ─────────────────
-- vendors.current_balance holds the balance as it stood at the Firestore
-- migration; opening_balance is 0 for every migrated row. Nothing in PostgreSQL
-- writes current_balance, so /masters/vendors computing
-- `opening_balance + sum(vendor_txns)` returned 0.00 for every vendor and would
-- have wiped Rs.2,89,520 of visible payable off the Vendor Master on cutover.
--
-- The fix is to treat current_balance as what it is — the carry-forward — and
-- keep the derived balance anchored to it. New vendors created through the API
-- get current_balance = opening_balance so the same formula stays correct.
UPDATE vendors
   SET opening_balance = current_balance
 WHERE opening_balance = 0 AND current_balance <> 0;

COMMIT;
