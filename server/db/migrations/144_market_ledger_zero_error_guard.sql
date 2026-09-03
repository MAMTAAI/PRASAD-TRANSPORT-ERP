-- 144_market_ledger_zero_error_guard.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- MARKET FLEET — 0% ERROR LEDGER GUARD (owner directive, 3-Sep-2026)
--
-- "A single rupee mismatch between Receivables and Payables is unacceptable."
-- A rule that lives only in a route is a rule the next import, correction
-- script or endpoint can walk around. Everything below is therefore a DATABASE
-- constraint, and every one of them was written because an audit of the live
-- books found the hole it closes.
--
-- WHAT THE AUDIT FOUND (read-only queries against the posted books, 3-Sep):
--
--   ✔ The general ledger balances exactly: 2,944 vouchers,
--     DR ₹17,08,91,490.19 = CR ₹17,08,91,490.19, difference ₹0.00.
--   ✔ Every BZLOCK voucher is internally balanced and carries fleet_segment
--     MARKET on both legs.
--   ✔ Stored margin equals customer_rate − awarded_amount on every settlement
--     that has both, to the paisa — including the −₹1,000 loss.
--
--   ✖ FIVE lock vouchers — ₹1,95,000 of Market Fleet Freight Cost and an equal
--     partner payable — were posted with company_id NULL. The existing
--     `company_before_money` CHECK lists the deposit, advance and balance
--     voucher columns but NOT lock_voucher_id, so the commitment posting walked
--     straight past the firm gate. Untagged entries are not harmless: the
--     company filter's company_matches() folds a NULL-company row into EVERY
--     firm, so that ₹1,95,000 is currently being counted three times over.
--   ✖ There is no path at all for the CUSTOMER leg. Six settlements carry a
--     customer_rate; not one rupee of market freight income has ever been
--     recognised, because no route posts it.
--   ✖ The margin exists only as a column on bazaar_settlements. The P&L cannot
--     see it, so "Office Commission / Net Margin" was a number on a screen
--     rather than a figure in the books.
--
-- WHAT THIS MIGRATION DOES NOT DO: it does not touch the five untagged
-- vouchers. Money that posted is a fact, and silently stamping a firm onto
-- somebody else's ₹1,95,000 is precisely the corrective script the owner has
-- ruled out. They are grandfathered by NOT VALID and surfaced as a task on the
-- Market Fleet Finance Hub, where a person names the firm.
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- ── 1 · THE CUSTOMER LEG GETS A HOME ────────────────────────────────────────
-- Dr Sundry Debtors (Customers) / Cr Market Fleet Income, at the customer's
-- rate. One column, so the posting is idempotent and auditable: a settlement
-- with income_voucher_id set has been recognised exactly once.
ALTER TABLE bazaar_settlements
  ADD COLUMN IF NOT EXISTS income_voucher_id uuid,
  ADD COLUMN IF NOT EXISTS income_posted_at  timestamptz;

COMMENT ON COLUMN bazaar_settlements.income_voucher_id IS
  'TARA voucher for Dr Sundry Debtors (Customers) / Cr Market Fleet Income at customer_rate. '
  'Set once, on POD verification — see the income_only_after_delivery CHECK.';

-- ── 2 · THE FIRM GATE, NOW COVERING EVERY MONEY EVENT ───────────────────────
-- The old constraint is replaced rather than added to, so there is one rule and
-- not two that can disagree. NOT VALID: the five pre-existing untagged locks
-- stay put and are fixed by a person, but no NEW row can post any voucher
-- without a firm.
ALTER TABLE bazaar_settlements
  DROP CONSTRAINT IF EXISTS bazaar_settlements_company_before_money;

ALTER TABLE bazaar_settlements
  ADD CONSTRAINT bazaar_settlements_company_before_money CHECK (
    company_id IS NOT NULL
    OR (vendor_deposit_voucher_id          IS NULL
    AND customer_deposit_voucher_id        IS NULL
    AND vendor_deposit_refund_voucher_id   IS NULL
    AND customer_deposit_refund_voucher_id IS NULL
    AND advance_voucher_id                 IS NULL
    AND balance_voucher_id                 IS NULL
    AND lock_voucher_id                    IS NULL   -- the hole the audit found
    AND income_voucher_id                  IS NULL)
  ) NOT VALID;

-- ── 3 · ZERO CALCULATION LEAK, ENFORCED BY THE DATABASE ─────────────────────
-- margin_amount is not allowed to be an independent number. Where both rates
-- are known it MUST equal customer_rate − awarded_amount to the paisa, so no
-- screen, import or future endpoint can store a spread that does not reconcile
-- to the two rates it came from. Half a paisa of tolerance, because these are
-- numeric(_,2) and exact equality on a computed numeric is a trap.
ALTER TABLE bazaar_settlements
  DROP CONSTRAINT IF EXISTS bazaar_settlements_margin_matches_rates;

ALTER TABLE bazaar_settlements
  ADD CONSTRAINT bazaar_settlements_margin_matches_rates CHECK (
    margin_amount IS NULL
    OR customer_rate IS NULL
    OR abs(margin_amount - (customer_rate - awarded_amount)) < 0.005
  );

-- margin_pct must reconcile to the same two numbers. 0.01pp of tolerance for
-- the rounding the desk shows.
ALTER TABLE bazaar_settlements
  DROP CONSTRAINT IF EXISTS bazaar_settlements_margin_pct_matches;

ALTER TABLE bazaar_settlements
  ADD CONSTRAINT bazaar_settlements_margin_pct_matches CHECK (
    margin_pct IS NULL
    OR customer_rate IS NULL
    OR customer_rate = 0
    OR abs(margin_pct - (margin_amount / customer_rate * 100)) < 0.011
  );

-- ── 4 · REVENUE RECOGNITION, ENFORCED BY THE DATABASE ───────────────────────
-- At lock the truck has not moved. Booking the customer's freight income then
-- would overstate the month and raise a receivable for a service not delivered
-- — which is itself an accounting error, not a stricter one. Income may only
-- exist once the POD is verified. The commitment to the partner is different:
-- that liability is real at award, and posts at lock.
ALTER TABLE bazaar_settlements
  DROP CONSTRAINT IF EXISTS bazaar_settlements_income_only_after_delivery;

ALTER TABLE bazaar_settlements
  ADD CONSTRAINT bazaar_settlements_income_only_after_delivery CHECK (
    income_voucher_id IS NULL
    OR status IN ('POD_VERIFIED', 'SETTLED')
  ) NOT VALID;

-- Income requires a rate to recognise.
ALTER TABLE bazaar_settlements
  DROP CONSTRAINT IF EXISTS bazaar_settlements_income_needs_rate;

ALTER TABLE bazaar_settlements
  ADD CONSTRAINT bazaar_settlements_income_needs_rate CHECK (
    income_voucher_id IS NULL OR (customer_rate IS NOT NULL AND customer_rate > 0)
  ) NOT VALID;

-- ── 5 · THE RECONCILIATION VIEW ─────────────────────────────────────────────
-- The margin is deliberately NOT a third journal entry: posting the spread
-- separately on top of income and cost would count it twice and inflate the
-- P&L. It is the difference between two postings, and this view proves that
-- difference against the stored figure per settlement — so "0% leak" is a
-- query anybody can run, not an assurance.
--
-- Legs are matched by ledger NAME, which is how this schema's GL links
-- (6,229 of 6,517 non-market entries carry a NULL ledger_id — ledger_name is
-- the join key, and both market ledgers exist in the master under the right
-- group_head).
CREATE OR REPLACE VIEW v_market_margin_audit AS
WITH legs AS (
  SELECT
    le.voucher_id,
    SUM(CASE WHEN le.dr_cr = 'DR' THEN le.amount ELSE 0 END) AS dr,
    SUM(CASE WHEN le.dr_cr = 'CR' THEN le.amount ELSE 0 END) AS cr,
    COUNT(*) FILTER (WHERE le.company_id IS NULL)            AS untagged_lines
  FROM ledger_entries le
  GROUP BY le.voucher_id
)
SELECT
  s.id                                   AS settlement_id,
  s.load_id,
  s.status,
  s.company_id,
  -- ids, not names: bazaar_settlements stores the parties by uuid and the
  -- settlements API already joins them for display. A view that re-joins them
  -- would be a second source of truth for a partner's name.
  s.vendor_id,
  s.customer_id,
  s.awarded_amount                       AS partner_rate,
  s.customer_rate,
  s.margin_amount                        AS stored_margin,
  (s.customer_rate - s.awarded_amount)   AS computed_margin,
  -- The leak. Anything but 0.00 here is the mismatch the owner will not accept.
  COALESCE(s.margin_amount, 0) - COALESCE(s.customer_rate - s.awarded_amount, 0) AS margin_leak,
  s.lock_voucher_id,
  s.income_voucher_id,
  lock_legs.dr                           AS cost_posted,
  inc_legs.cr                            AS income_posted,
  -- Income recognised minus cost committed: must equal the stored margin once
  -- both legs are posted.
  CASE WHEN s.lock_voucher_id IS NOT NULL AND s.income_voucher_id IS NOT NULL
       THEN COALESCE(inc_legs.cr, 0) - COALESCE(lock_legs.dr, 0)
  END                                    AS ledger_margin,
  CASE WHEN s.lock_voucher_id IS NOT NULL AND s.income_voucher_id IS NOT NULL
       THEN (COALESCE(inc_legs.cr, 0) - COALESCE(lock_legs.dr, 0)) - COALESCE(s.margin_amount, 0)
  END                                    AS ledger_vs_stored_leak,
  -- Balance integrity of each posting, straight off the entries.
  (lock_legs.dr IS NOT DISTINCT FROM lock_legs.cr) AS lock_balanced,
  (inc_legs.dr  IS NOT DISTINCT FROM inc_legs.cr)  AS income_balanced,
  -- The task list: what a person has to fix.
  (s.company_id IS NULL AND (s.lock_voucher_id IS NOT NULL OR s.income_voucher_id IS NOT NULL))
                                         AS posted_without_firm,
  (s.company_id IS NULL)                 AS firm_missing,
  (s.lock_voucher_id IS NULL AND s.customer_rate IS NOT NULL)
                                         AS commitment_unposted,
  (s.status IN ('POD_VERIFIED','SETTLED') AND s.income_voucher_id IS NULL)
                                         AS income_unposted,
  COALESCE(lock_legs.untagged_lines, 0) + COALESCE(inc_legs.untagged_lines, 0)
                                         AS untagged_ledger_lines,
  s.advance_amount,
  s.balance_amount,
  s.deposit_amount,
  s.pod_verified_at,
  s.locked_at,
  s.created_at
FROM bazaar_settlements s
LEFT JOIN legs lock_legs ON lock_legs.voucher_id = s.lock_voucher_id
LEFT JOIN legs inc_legs  ON inc_legs.voucher_id  = s.income_voucher_id;

COMMENT ON VIEW v_market_margin_audit IS
  'Per-settlement 0%-error proof for the Market Fleet: margin_leak and '
  'ledger_vs_stored_leak must both be 0.00, and the four *_unposted / '
  '*_without_firm flags are the desk''s task list. Read by the Market Fleet '
  'Finance Hub.';

COMMIT;
