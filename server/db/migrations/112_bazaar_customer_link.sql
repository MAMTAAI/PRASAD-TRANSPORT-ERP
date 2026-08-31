-- ═══════════════════════════════════════════════════════════════════════════
-- 112_bazaar_customer_link.sql — a load knows whose load it is
--
-- Load Bazaar Phase 1 (R&D 2026-08-31). bazaar_loads has only a free-text
-- customer_name, because until now only staff posted loads. The customer
-- portal's own posting/bid routes need a real FK to answer "whose load" the
-- same way every other scoped portal route does — by id from the session's
-- party, never by name matching.
--
-- Nullable on purpose: staff-posted loads for walk-in parties have no portal
-- customer behind them, and that is a fact, not a fault.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE bazaar_loads
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bazaar_loads_customer
  ON bazaar_loads (customer_id, created_at DESC);

-- Backfill where the free-text name resolves to exactly one portal customer —
-- same normalisation the company backfills use (053).
UPDATE bazaar_loads l
   SET customer_id = c.id
  FROM customers c
 WHERE l.customer_id IS NULL
   AND l.customer_name IS NOT NULL
   AND upper(btrim(l.customer_name)) = upper(btrim(c.customer_name));

COMMIT;
