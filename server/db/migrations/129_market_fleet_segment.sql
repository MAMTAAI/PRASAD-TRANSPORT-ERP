-- ═══════════════════════════════════════════════════════════════════════════
-- 129_market_fleet_segment.sql — two fleets, two sides of the books
--
-- Owner's rule (2026-09-02): the INTERNAL fleet (own + permanently attached
-- vehicles, Master Control) and the MARKET fleet (fleet partners, market
-- vehicles, Load Bazaar, Command Deck) are separate businesses inside one
-- company, and their money must never mix. Until now a bazaar advance posted
-- to `Creditors: <vendor>` under 'Sundry Creditors (Vendors)' — the same
-- ledger and group a fuel pump or a tyre shop lives in — and a trip-lock
-- deposit sat in the party's ordinary khata. One vendor payable report would
-- have mixed both fleets without anyone being able to tell.
--
-- Three things, in the database so no code path can forget:
--   1. Four account groups of their own for the market fleet.
--   2. ledger_entries.fleet_segment — MARKET for every BAZAAR_* posting,
--      OWN for everything else — stamped by trigger, never by the caller.
--   3. The crossover guard: a MARKET posting may touch only a Market Fleet
--      group or a bank/cash account (money is money); an OWN posting may
--      never touch a Market Fleet group. Raised as FLEET_CROSSOVER (P0403),
--      the same class as the append-only refusal.
-- v_fleet_segment_totals is what the two dashboards read: one row per
-- segment × group × ledger.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

INSERT INTO account_groups (group_head, account_type, statement, normal_side, sort_order, is_system) VALUES
  ('Market Fleet Payables (Partners)', 'LIABILITY', 'BALANCE_SHEET',   'CR', 215, true),
  ('Market Fleet Deposits Held',       'LIABILITY', 'BALANCE_SHEET',   'CR', 216, true),
  ('Market Fleet Income',              'INCOME',    'PROFIT_AND_LOSS', 'CR', 305, true),
  ('Market Fleet Expenses',            'EXPENSE',   'PROFIT_AND_LOSS', 'DR', 445, true)
ON CONFLICT (group_head) DO NOTHING;

ALTER TABLE ledger_entries
  ADD COLUMN IF NOT EXISTS fleet_segment text NOT NULL DEFAULT 'OWN'
    CHECK (fleet_segment IN ('OWN', 'MARKET'));
CREATE INDEX IF NOT EXISTS ledger_entries_segment_idx ON ledger_entries (fleet_segment, entry_date DESC);

CREATE OR REPLACE FUNCTION ledger_fleet_segment_guard() RETURNS trigger AS $$
DECLARE
  grp text;
  market_group boolean;
  money_group boolean;
BEGIN
  NEW.fleet_segment := CASE WHEN NEW.source_type LIKE 'BAZAAR_%' THEN 'MARKET' ELSE 'OWN' END;

  SELECT l.group_head INTO grp
    FROM ledgers l
   WHERE (NEW.ledger_id IS NOT NULL AND l.id = NEW.ledger_id)
      OR (NEW.ledger_id IS NULL AND lower(l.ledger_name) = lower(NEW.ledger_name))
   ORDER BY (l.id = NEW.ledger_id) DESC NULLS LAST
   LIMIT 1;

  market_group := COALESCE(grp LIKE 'Market Fleet %', false);
  money_group  := COALESCE(grp IN ('Bank Accounts', 'Cash-in-Hand'), false);

  IF NEW.fleet_segment = 'MARKET' AND NOT (market_group OR money_group) THEN
    RAISE EXCEPTION 'FLEET_CROSSOVER: market-fleet voucher % may not post to own-fleet ledger "%" (group %)',
      NEW.source_ref, NEW.ledger_name, COALESCE(grp, '(no ledger)') USING ERRCODE = 'P0403';
  END IF;
  IF NEW.fleet_segment = 'OWN' AND market_group THEN
    RAISE EXCEPTION 'FLEET_CROSSOVER: own-fleet posting % may not touch market-fleet ledger "%"',
      COALESCE(NEW.source_ref, NEW.source_type), NEW.ledger_name USING ERRCODE = 'P0403';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ledger_entries_fleet_segment ON ledger_entries;
CREATE TRIGGER ledger_entries_fleet_segment
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_fleet_segment_guard();

CREATE OR REPLACE VIEW v_fleet_segment_totals AS
SELECT e.fleet_segment,
       l.group_head,
       e.ledger_name,
       COALESCE(sum(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2) AS dr,
       COALESCE(sum(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2) AS cr,
       count(*)::int      AS entries,
       max(e.entry_date)  AS last_entry
  FROM ledger_entries e
  LEFT JOIN ledgers l ON lower(l.ledger_name) = lower(e.ledger_name)
 GROUP BY 1, 2, 3;

COMMIT;
