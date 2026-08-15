-- ═══════════════════════════════════════════════════════════════════════════
-- 055_backfill_ledger_company.sql — attribute what CAN be attributed, and
--                                   leave the rest visibly unattributed
--
-- THE PROBLEM. 053 tagged ledger_entries.company_id from a free-text `company`
-- column that was NULL on 848 of 1720 rows — and the Freight Income postings
-- were among the untagged. The effect on screen was severe: filtering the P&L
-- by company dropped the revenue and left the costs, so every firm read as a
-- heavy loss while the group read as a profit. Prasad Transport showed
-- -28,99,025 against a group result of +34,01,427.
--
-- WHAT WAS TRIED AND DID NOT WORK, so nobody repeats it:
--   company_bills   holds 2 rows, and their bill numbers are INV-IND-… , not
--                   the IOCL bills the ledger references. No join.
--   trips.advice_no is NULL on every row, so the ADV-… references match nothing.
--   voucher siblings tagged/untagged never mix — 053 tagged from a per-row text
--                   value that was uniform across each voucher, so propagation
--                   from a tagged sibling gains exactly zero rows.
--
-- WHAT DOES WORK. trips.iocl_bill_no carries the IOCL bill number that the
-- ledger's source_ref embeds ('IOCL-INC-11024699AS26001'), and trips are 100%
-- company-tagged after 054. That path reaches 478 rows.
--
-- BUT 17 IOCL BILLS SPAN TWO COMPANIES. For those, the bill number does not
-- identify one set of books, and picking either would be inventing an
-- attribution for 138 rows of real money. Only bills that map to exactly ONE
-- company are used — 340 rows — and the ambiguous ones are deliberately left
-- NULL so the coverage warning on the P&L keeps telling the truth about them.
--
-- Same append-only exception as 053, for the same reason and with the same
-- narrow scope: no amount, dr_cr or date is touched, and the guard is
-- re-enabled in this transaction.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE ledger_entries DISABLE TRIGGER ledger_entries_no_rewrite;

-- ── 1. IOCL bill number -> the company that ran those trips ─────────────────
WITH bill_co AS (
  SELECT iocl_bill_no,
         (array_agg(DISTINCT company_id))[1] AS company_id
    FROM trips
   WHERE iocl_bill_no IS NOT NULL AND company_id IS NOT NULL
   GROUP BY iocl_bill_no
  HAVING count(DISTINCT company_id) = 1        -- unambiguous only
)
UPDATE ledger_entries e
   SET company_id = b.company_id
  FROM bill_co b
 WHERE e.company_id IS NULL
   AND e.source_ref IS NOT NULL
   AND e.source_ref LIKE '%' || b.iocl_bill_no;

-- ── 2. Propagate within a voucher ───────────────────────────────────────────
-- A voucher is ONE transaction in ONE company's books, so once any leg is
-- attributed the others follow. This gained nothing before step 1 (no voucher
-- had mixed legs); after it, vouchers whose legs carry different source_refs
-- can complete themselves.
--
-- Guarded by the HAVING: if a voucher somehow resolved to two companies, it is
-- left alone rather than having one picked for it.
WITH voucher_co AS (
  SELECT voucher_id,
         (array_agg(DISTINCT company_id))[1] AS company_id
    FROM ledger_entries
   WHERE voucher_id IS NOT NULL AND company_id IS NOT NULL
   GROUP BY voucher_id
  HAVING count(DISTINCT company_id) = 1
)
UPDATE ledger_entries e
   SET company_id = v.company_id
  FROM voucher_co v
 WHERE e.company_id IS NULL
   AND e.voucher_id = v.voucher_id;

ALTER TABLE ledger_entries ENABLE TRIGGER ledger_entries_no_rewrite;

-- ── 3. A voucher must never straddle two companies ──────────────────────────
-- Not a constraint (ledger_entries is append-only and a CHECK cannot see
-- sibling rows) but a view the health screen can assert on: any row here is a
-- transaction booked half into one firm and half into another.
CREATE OR REPLACE VIEW v_voucher_company_conflicts AS
SELECT voucher_id,
       count(DISTINCT company_id) AS companies,
       array_agg(DISTINCT company_id) AS company_ids,
       sum(amount) AS amount
  FROM ledger_entries
 WHERE voucher_id IS NOT NULL AND company_id IS NOT NULL
 GROUP BY voucher_id
HAVING count(DISTINCT company_id) > 1;

COMMENT ON VIEW v_voucher_company_conflicts IS
  'Vouchers whose legs are attributed to more than one company. Must be empty; a row here is one transaction split across two sets of books.';

COMMIT;
