-- ═══════════════════════════════════════════════════════════════════════════
-- 110_company_bills_company_id.sql
--   Give a customer invoice the company FK it never had, and make the
--   two-company IOCL bills VISIBLE instead of silently mis-stamped.
--
-- WHY THIS FILE. company_bills has only a free-text `company` column (019). Every
-- per-company question about a bill was therefore answered by string-matching,
-- and a bill raised with a blank/typo company printed a random firm's GSTIN on a
-- real invoice (billing audit F-01..F-04). ledger_entries got its company_id in
-- 053; the sales side never did. This adds it.
--
-- WHY IT DOES NOT GUESS. 055 recorded that 17 IOCL bills span two operating
-- companies — "picking either would be inventing an attribution for 138 rows of
-- real money." So the backfill sets company_id ONLY where every linked trip
-- agrees on one company (or the free-text name resolves cleanly). A bill whose
-- trips genuinely straddle two firms is LEFT NULL and listed in
-- v_company_bill_company_conflicts, a worklist a human resolves — the same
-- surface-don't-autofix rule the rest of this system follows.
--
-- WHY THE VOUCHER DETECTOR IS WIRED HERE. 055 created v_voucher_company_conflicts
-- ("must be empty; a row here is one transaction split across two sets of
-- books") and nothing ever read it — dead code. It, and the new bill conflict
-- view, are now surfaced on v_accounting_health, so /finance/health/accounting
-- turns them into a failure the office actually sees.
--
-- company_bills is NOT append-only (only ledger_entries carries the no-rewrite
-- trigger), so these UPDATEs need no trigger dance.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. BACKFILL trips.company_id THE IMPORTER LEFT NULL ─────────────────────
-- 054 stamped company_id once; every trip the IOCL route created since then
-- landed NULL, because POST /ops/trips never set it (now fixed at the write
-- path). Resolve the clean free-text name to the FK so existing imported trips
-- are billable and consistent. 'ALL'/blank stay NULL — no company to resolve to.
-- trips is not append-only, so a plain UPDATE is correct here.
UPDATE trips t
   SET company_id = c.id
  FROM companies c
 WHERE t.company_id IS NULL
   AND t.operating_company IS NOT NULL
   AND lower(btrim(t.operating_company)) NOT IN ('', 'all')
   AND norm_company_name(t.operating_company) = norm_company_name(c.company_name);

-- ── 1. THE COLUMN ───────────────────────────────────────────────────────────
ALTER TABLE company_bills
  ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_company_bills_company
  ON company_bills (company_id, bill_date DESC);

-- ── 2. BACKFILL FROM THE TRIPS, WHERE THEY AGREE ────────────────────────────
-- The trip is where the company is a fact (054). A bill's company is the one
-- its trips share; if they share exactly one, that is the answer.
WITH bill_co AS (
  SELECT bt.bill_id,
         count(DISTINCT t.company_id) FILTER (WHERE t.company_id IS NOT NULL) AS n,
         (array_agg(DISTINCT t.company_id)
            FILTER (WHERE t.company_id IS NOT NULL))[1] AS only_co
    FROM company_bill_trips bt
    JOIN trips t ON t.id = bt.trip_id
   GROUP BY bt.bill_id
)
UPDATE company_bills b
   SET company_id = bc.only_co
  FROM bill_co bc
 WHERE b.id = bc.bill_id
   AND bc.n = 1
   AND b.company_id IS NULL;

-- ── 3. FALL BACK TO THE CLEAN FREE-TEXT NAME ────────────────────────────────
-- For bills whose trips carry no company_id yet (the IOCL importer never stamped
-- it — a separate fix), the free-text `company` still resolves when it is one of
-- the three known names spelled cleanly. norm_company_name() (053) collapses the
-- trailing-space / "M/S " variants. 'ALL'/blank are left NULL on purpose.
UPDATE company_bills b
   SET company_id = c.id
  FROM companies c
 WHERE b.company_id IS NULL
   AND b.company IS NOT NULL
   AND lower(btrim(b.company)) NOT IN ('', 'all')
   AND norm_company_name(b.company) = norm_company_name(c.company_name);

-- ── 4. THE WORKLIST: BILLS WHOSE TRIPS STRADDLE TWO FIRMS ───────────────────
-- Not guessed above; surfaced here. A row is a bill that must be split before it
-- can carry one honest company_id.
CREATE OR REPLACE VIEW v_company_bill_company_conflicts AS
SELECT b.id AS bill_id,
       b.bill_no,
       b.bill_date,
       b.customer_name,
       count(DISTINCT t.company_id) AS companies,
       array_agg(DISTINCT t.company_id) AS company_ids,
       b.total_net
  FROM company_bill_trips bt
  JOIN trips t         ON t.id = bt.trip_id
  JOIN company_bills b ON b.id = bt.bill_id
 WHERE t.company_id IS NOT NULL
 GROUP BY b.id, b.bill_no, b.bill_date, b.customer_name, b.total_net
HAVING count(DISTINCT t.company_id) > 1;

COMMENT ON VIEW v_company_bill_company_conflicts IS
  'Customer invoices whose linked trips belong to more than one operating company. Each must be split into per-company invoices; left with company_id NULL until then.';

-- ── 5. WIRE BOTH DETECTORS INTO THE HEALTH SCREEN ───────────────────────────
-- Reproduces 014_alias_citext_fix.sql's view verbatim and appends two counts, so
-- /finance/health/accounting (which reads SELECT * and fails on any nonzero)
-- now shows a split voucher or a split bill instead of hiding it.
DROP VIEW IF EXISTS v_accounting_health;
CREATE VIEW v_accounting_health AS
SELECT
  (SELECT count(*) FROM (
     SELECT voucher_id FROM ledger_entries WHERE voucher_id IS NOT NULL
      GROUP BY voucher_id
     HAVING SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END) <> 0) x
  ) AS unbalanced_vouchers,
  (SELECT COALESCE(SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0)::numeric(14,2)
     FROM ledger_entries WHERE voucher_id IS NOT NULL) AS voucher_era_imbalance,
  (SELECT COALESCE(SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0)::numeric(14,2)
     FROM ledger_entries WHERE voucher_id IS NULL) AS legacy_imbalance,
  (SELECT COALESCE(SUM(CASE WHEN dr_cr='DR' THEN amount ELSE -amount END),0)::numeric(14,2)
     FROM ledger_entries) AS total_imbalance,
  (SELECT count(*) FROM ledger_entries e
    WHERE NOT EXISTS (SELECT 1 FROM ledger_aliases a WHERE a.alias_name = e.ledger_name::citext)
  ) AS unresolvable_entries,
  (SELECT count(*) FROM ledgers l WHERE l.status='ACTIVE'
    AND NOT EXISTS (SELECT 1 FROM ledger_aliases a WHERE a.alias_name = l.ledger_name::citext)
  ) AS ledgers_without_alias,
  (SELECT count(*) FROM (
     SELECT party_key(ledger_name) k FROM ledgers WHERE status='ACTIVE' AND party_key(ledger_name) <> ''
      GROUP BY 1 HAVING count(*) > 1) d
  ) AS duplicate_parties_remaining,
  (SELECT count(*) FROM ledgers WHERE status='ACTIVE'
      AND group_head NOT IN (SELECT group_head FROM account_groups)) AS ledgers_off_chart,
  (SELECT count(*) FROM ledger_aliases WHERE reason <> 'canonical') AS merged_aliases,
  -- NEW: one transaction booked into two firms' books.
  (SELECT count(*) FROM v_voucher_company_conflicts)     AS mixed_company_vouchers,
  -- NEW: one invoice raised over two firms' trips.
  (SELECT count(*) FROM v_company_bill_company_conflicts) AS bills_spanning_companies;

COMMIT;
