-- ═══════════════════════════════════════════════════════════════════════════
-- 122_company_scoped_reports.sql — the company filter tells the truth
--
-- THE FAULT, IN ONE LINE. company_matches() (migration 020) returns TRUE when
-- the RECORD has no company:
--
--     WHEN norm_company(record_val) IN ('', 'ALL') THEN true
--
-- That was a deliberate choice in 020 and a reasonable one at the time: with
-- 616 of 910 entries unspelled, an `=` filter returned an empty report and read
-- as "no data" rather than "wrong question". But the book has grown to 6,511
-- entries and 4,501 of them carry no company anywhere (measured 1-Sep-2026;
-- migration 120 documents the count and why none of them can be recovered).
-- So today that clause means:
--
--   · Prasad's P&L contains all 4,501 unplaced entries.
--   · Jaiswal's P&L contains the SAME 4,501 entries.
--   · Gautam's too.
--   · The three "company" P&Ls therefore sum to far more than the group's.
--
-- A company filter that shows one firm's report and quietly folds in every
-- posting that belongs to nobody is worse than no filter: the number looks
-- specific. This migration does not change company_matches — other callers
-- depend on its "never hide a row" semantics — it adds a SCOPED family beside
-- it that resolves the company properly and lets the caller say what to do with
-- what cannot be placed.
--
-- NOTHING IS REWRITTEN AND NOTHING IS GUESSED. ledger_entries stays append-only
-- (ledger_entries_no_rewrite is untouched, as 120 insists). No entry is
-- assigned to a firm by inference. The unplaced ones are counted, named
-- 'UNASSIGNED', and reported — which is the whole point.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. The resolved view learns which firm an entry belongs to ──────────────
-- CREATE OR REPLACE VIEW may add columns at the END of the select list, so the
-- dependants (v_ledger_balances, v_trial_balance, …) are undisturbed.
--
-- Resolution order, most trustworthy first: the row's own text, then its
-- company_id, then nothing. That second step is not cosmetic — it recovers the
-- 340 entries that carry a company_id and no text, which the text-only filter
-- has never been able to place.
CREATE OR REPLACE VIEW v_ledger_entries_resolved AS
SELECT e.id, e.voucher_id, e.entry_date, e.dr_cr, e.amount,
       e.particulars, e.source_type, e.source_ref, e.company, e.branch,
       e.ledger_name                         AS posted_as,
       COALESCE(c.ledger_name, e.ledger_name) AS ledger_name,
       COALESCE(c.group_head, 'Suspense A/c') AS group_head,
       g.account_type, g.statement, g.normal_side,
       (e.voucher_id IS NULL)                AS is_legacy,
       e.company_id,
       COALESCE(canonical_company(e.company), canonical_company(co.company_name))
                                             AS company_canonical,
       COALESCE(canonical_company(e.company), canonical_company(co.company_name),
                'UNASSIGNED')                AS company_bucket,
       CASE
         WHEN canonical_company(e.company) IS NOT NULL       THEN 'text'
         WHEN canonical_company(co.company_name) IS NOT NULL THEN 'company_id'
         ELSE 'none'
       END                                   AS company_source
  FROM ledger_entries e
  -- ::citext IS THE 014 FIX AND IT MUST NOT BE LOST HERE. citext = text picks
  -- the text operator and compares case-sensitively, so 'Indian Oil' and
  -- 'INDIAN OIL' resolved to different ledgers and one of them fell out of
  -- every report, silently. This view is being replaced, so the cast is carried
  -- forward deliberately rather than copied from 011, which predates the fix.
  LEFT JOIN ledger_aliases a ON a.alias_name = e.ledger_name::citext
  LEFT JOIN ledgers        c ON c.id = a.canonical_id
  LEFT JOIN account_groups g ON g.group_head = COALESCE(c.group_head, 'Suspense A/c')
  LEFT JOIN companies     co ON co.id = e.company_id;

-- ── 2. The scoping rule, written once ───────────────────────────────────────
-- p_unassigned:
--   'exclude' — the honest default for a single firm. An entry that names no
--               company is not this firm's, and pretending otherwise is the
--               bug above.
--   'include' — the CA's view when reconciling: show me my firm PLUS everything
--               nobody has placed, so the total ties back to the group.
--   'only'    — the worklist. Exactly the entries somebody has to look at.
-- A NULL/blank/'ALL' selector is the whole group and ignores this entirely:
-- at group level there is nothing to exclude, because every entry belongs to
-- the group whether or not it names a firm.
CREATE OR REPLACE FUNCTION company_in_scope(
  p_bucket text, p_company text, p_unassigned text DEFAULT 'exclude')
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT CASE
    WHEN p_company IS NULL OR btrim(p_company) = '' OR upper(btrim(p_company)) = 'ALL'
      THEN true
    WHEN lower(COALESCE(p_unassigned, 'exclude')) = 'only'
      THEN p_bucket = 'UNASSIGNED'
    WHEN p_bucket = 'UNASSIGNED'
      THEN lower(COALESCE(p_unassigned, 'exclude')) = 'include'
    -- canonical_company() folds the eight spellings, so a filter written
    -- 'JAISWAL ENTERPRISE' matches rows written 'M/S JAISWAL ENTERPRISE  '.
    ELSE p_bucket = canonical_company(p_company)
  END
$fn$;

COMMENT ON FUNCTION company_in_scope(text, text, text) IS
  'Whether a ledger entry in company bucket p_bucket belongs in a report scoped '
  'to p_company. Unlike company_matches(), an entry that names NO firm is not '
  'silently counted into every firm — p_unassigned says what to do with it.';

-- ── 3. What cannot be placed, in figures ────────────────────────────────────
-- Every screen that filters by company has to be able to say how much of the
-- book it could not attribute. Guessing that from the report itself is
-- impossible: an excluded entry leaves no trace in the numbers.
CREATE OR REPLACE FUNCTION f_company_coverage(
  p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS TABLE (company_bucket text, company_source text, entries bigint,
               dr numeric, cr numeric)
LANGUAGE sql STABLE AS $fn$
  SELECT e.company_bucket, e.company_source, count(*)::bigint,
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2)
    FROM v_ledger_entries_resolved e
   WHERE (p_from IS NULL OR e.entry_date >= p_from)
     AND (p_to   IS NULL OR e.entry_date <= p_to)
   GROUP BY e.company_bucket, e.company_source
   ORDER BY e.company_bucket, e.company_source
$fn$;

COMMENT ON FUNCTION f_company_coverage(date, date) IS
  'How much of the ledger can be attributed to a firm over a period, and by '
  'which field. UNASSIGNED is the part no company-wise report can honestly '
  'include.';

-- ── 4. The three statements, scoped ─────────────────────────────────────────
-- Deliberately NEW functions rather than edits to f_trial_balance /
-- f_profit_and_loss / f_balance_sheet. Those three are the group-level
-- definitions, they are what v_trial_balance and friends mirror, and silently
-- changing what they return would move numbers under anybody still calling
-- them. The scoped family is what a company-filtered screen asks for.

CREATE OR REPLACE FUNCTION f_trial_balance_scoped(
  p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_company text DEFAULT NULL, p_unassigned text DEFAULT 'exclude')
RETURNS TABLE (group_head text, account_type text, statement text, sort_order int,
               dr numeric, cr numeric, dr_voucher_era numeric, cr_voucher_era numeric)
LANGUAGE sql STABLE AS $fn$
  SELECT g.group_head, g.account_type, g.statement, g.sort_order,
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR' AND NOT e.is_legacy), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR' AND NOT e.is_legacy), 0)::numeric(14,2)
    FROM account_groups g
    LEFT JOIN v_ledger_entries_resolved e
           ON e.group_head = g.group_head
          AND (p_from IS NULL OR e.entry_date >= p_from)
          AND (p_to   IS NULL OR e.entry_date <= p_to)
          AND company_in_scope(e.company_bucket, p_company, p_unassigned)
   GROUP BY g.group_head, g.account_type, g.statement, g.sort_order
   ORDER BY g.sort_order
$fn$;

CREATE OR REPLACE FUNCTION f_profit_and_loss_scoped(
  p_from date DEFAULT NULL, p_to date DEFAULT NULL,
  p_company text DEFAULT NULL, p_unassigned text DEFAULT 'exclude')
RETURNS TABLE (group_head text, account_type text, sort_order int, amount numeric)
LANGUAGE sql STABLE AS $fn$
  SELECT g.group_head, g.account_type, g.sort_order,
         CASE WHEN g.account_type = 'INCOME'
              THEN COALESCE(SUM(CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END), 0)
              ELSE COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)
         END::numeric(14,2)
    FROM account_groups g
    LEFT JOIN v_ledger_entries_resolved e
           ON e.group_head = g.group_head AND NOT e.is_legacy
          AND (p_from IS NULL OR e.entry_date >= p_from)
          AND (p_to   IS NULL OR e.entry_date <= p_to)
          AND company_in_scope(e.company_bucket, p_company, p_unassigned)
   WHERE g.statement = 'PROFIT_AND_LOSS'
   GROUP BY g.group_head, g.account_type, g.sort_order
   ORDER BY g.sort_order
$fn$;

-- Cumulative to p_to, exactly as 021 established: equity is retained earnings,
-- not one period's trading result, and bounding the profit line while the asset
-- side stays cumulative is what put the sheet out of balance in 020.
CREATE OR REPLACE FUNCTION f_balance_sheet_scoped(
  p_to date DEFAULT NULL, p_company text DEFAULT NULL,
  p_unassigned text DEFAULT 'exclude')
RETURNS TABLE (group_head text, account_type text, sort_order int,
               amount numeric, side text)
LANGUAGE sql STABLE AS $fn$
  WITH bal AS (
    SELECT g.group_head, g.account_type, g.sort_order,
           COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)::numeric(14,2) AS dr_net
      FROM account_groups g
      LEFT JOIN v_ledger_entries_resolved e
             ON e.group_head = g.group_head
            AND (p_to IS NULL OR e.entry_date <= p_to)
            AND company_in_scope(e.company_bucket, p_company, p_unassigned)
     WHERE g.statement = 'BALANCE_SHEET'
     GROUP BY g.group_head, g.account_type, g.sort_order
  ),
  pl_current AS (
    SELECT COALESCE(SUM(CASE WHEN account_type = 'INCOME' THEN amount ELSE -amount END), 0)::numeric(14,2) AS profit
      FROM f_profit_and_loss_scoped(NULL, p_to, p_company, p_unassigned)
  ),
  pl_legacy AS (
    SELECT COALESCE(SUM(CASE WHEN e.account_type = 'INCOME'
                             THEN CASE WHEN e.dr_cr = 'CR' THEN e.amount ELSE -e.amount END
                             ELSE CASE WHEN e.dr_cr = 'DR' THEN -e.amount ELSE e.amount END
                        END), 0)::numeric(14,2) AS profit
      FROM v_ledger_entries_resolved e
      JOIN account_groups g ON g.group_head = e.group_head
     WHERE e.is_legacy AND g.statement = 'PROFIT_AND_LOSS'
       AND (p_to IS NULL OR e.entry_date <= p_to)
       AND company_in_scope(e.company_bucket, p_company, p_unassigned)
  )
  SELECT b.group_head, b.account_type, b.sort_order,
         (CASE WHEN b.account_type = 'ASSET' THEN b.dr_net ELSE -b.dr_net END)::numeric(14,2),
         CASE WHEN b.account_type = 'ASSET' THEN 'ASSETS' ELSE 'LIABILITIES_AND_EQUITY' END
    FROM bal b
   WHERE b.dr_net <> 0
  UNION ALL
  SELECT 'Profit for the period', 'EQUITY', 998, profit, 'LIABILITIES_AND_EQUITY'
    FROM pl_current WHERE profit <> 0
  UNION ALL
  SELECT 'Accumulated result brought forward (pre-migration)', 'EQUITY', 999, profit, 'LIABILITIES_AND_EQUITY'
    FROM pl_legacy WHERE profit <> 0
   ORDER BY 5, 3
$fn$;

-- ── 5. Ledger hub and statement, scoped the same way ────────────────────────
-- GET /finance/ledgers and /finance/ledgers/statement had no company parameter
-- at all: the ledger screen showed the group's book whatever the dashboard
-- filter said. This is what the routes filter on.
CREATE OR REPLACE FUNCTION f_ledger_balances_scoped(
  p_company text DEFAULT NULL, p_unassigned text DEFAULT 'exclude')
RETURNS TABLE (ledger_name text, group_head text, entries bigint,
               total_dr numeric, total_cr numeric, balance_dr numeric,
               last_entry date)
LANGUAGE sql STABLE AS $fn$
  SELECT e.ledger_name, e.group_head, count(*)::bigint,
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'DR'), 0)::numeric(14,2),
         COALESCE(SUM(e.amount) FILTER (WHERE e.dr_cr = 'CR'), 0)::numeric(14,2),
         COALESCE(SUM(CASE WHEN e.dr_cr = 'DR' THEN e.amount ELSE -e.amount END), 0)::numeric(14,2),
         max(e.entry_date)
    FROM v_ledger_entries_resolved e
   WHERE company_in_scope(e.company_bucket, p_company, p_unassigned)
   GROUP BY e.ledger_name, e.group_head
$fn$;

COMMIT;
