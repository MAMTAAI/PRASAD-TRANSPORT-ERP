-- 146_margin_guards_not_valid.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- MAKE THE MARGIN GUARDS DEPLOY-SAFE
--
-- Migration 144 added bazaar_settlements_margin_matches_rates and
-- bazaar_settlements_margin_pct_matches as ordinary (VALIDATED) constraints.
-- That was a mistake for an unattended deploy: PostgreSQL validates a new CHECK
-- against every existing row, so ONE historical settlement on production whose
-- stored margin does not reconcile to its two rates would abort the migration,
-- and the AWS box's pull-migrate-restart cycle would leave the API down.
--
-- The local books are clean (0 leaking rows out of 7), but "the other database
-- is probably the same" is not a deployment strategy.
--
-- NOT VALID gives exactly the behaviour that was wanted anyway:
--   · every INSERT and UPDATE from now on is checked — a route, an import or a
--     correction script still cannot write a margin that does not equal
--     customer_rate − awarded_amount;
--   · existing rows are left alone rather than blocking the release, and any
--     that do not reconcile surface as margin_leak on v_market_margin_audit,
--     which is where a person can see and fix them.
--
-- That is the same "surface it, do not silently rewrite it" rule the untagged
-- lock vouchers get. Once the Finance Hub shows zero leaks on production these
-- can be promoted with VALIDATE CONSTRAINT, which takes no exclusive lock.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

ALTER TABLE bazaar_settlements
  DROP CONSTRAINT IF EXISTS bazaar_settlements_margin_matches_rates;
ALTER TABLE bazaar_settlements
  ADD CONSTRAINT bazaar_settlements_margin_matches_rates CHECK (
    margin_amount IS NULL
    OR customer_rate IS NULL
    OR abs(margin_amount - (customer_rate - awarded_amount)) < 0.005
  ) NOT VALID;

ALTER TABLE bazaar_settlements
  DROP CONSTRAINT IF EXISTS bazaar_settlements_margin_pct_matches;
ALTER TABLE bazaar_settlements
  ADD CONSTRAINT bazaar_settlements_margin_pct_matches CHECK (
    margin_pct IS NULL
    OR customer_rate IS NULL
    OR customer_rate = 0
    OR abs(margin_pct - (margin_amount / customer_rate * 100)) < 0.011
  ) NOT VALID;

COMMIT;
