-- ═══════════════════════════════════════════════════════════════════════════
-- 154 — Which bill settled this memo
--
-- The de-duplication itself already works and has for a while: /fuel-reconcile
-- takes only slips whose bill_status is UNBILLED, locks them FOR UPDATE, moves
-- each trip by the DELTA rather than the full amount, and posts under a
-- deterministic ref_no so the same pump and the same slip set cannot post
-- twice. None of that is changed here.
--
-- WHAT WAS MISSING IS THE ANSWER TO "WHICH BILL?". fuel_entries carried
-- bill_status and nothing else, so a memo could say it was settled but not say
-- where. On the reconciliation screen that is the difference between
--
--     "no WhatsApp memo exists for this line"        ← what it said
--     "already settled in the 1–15 July bill"        ← what was true
--
-- and the first of those sends a clerk hunting for a memo that is sitting
-- right there, already paid. On 4-Sep-2026 exactly ONE of 1,042 memos was
-- UNBILLED — 501 BILLED (created by the pump-bill importer itself, so billed by
-- definition) and 540 BILLED_VERIFIED — which is why a scanned bill read as 39
-- ghosts and ₹6,47,352 of unauthorised diesel.
--
-- Stamped going forward. The history cannot be backfilled honestly: nothing
-- recorded the link at the time, and inventing one from dates would be a guess
-- written into the books. A memo settled before today reports that it is
-- settled and that the reference was not kept.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE fuel_entries
  -- The pump_bill_drafts row this memo was settled under, when it came through
  -- the fortnightly bill flow.
  ADD COLUMN IF NOT EXISTS settled_bill_id    uuid REFERENCES pump_bill_drafts(id) ON DELETE SET NULL,
  -- The voucher that carried it to the ledger. This is the one that proves the
  -- money moved, and it is what makes a double-post visible rather than
  -- theoretical.
  ADD COLUMN IF NOT EXISTS settled_voucher_id uuid,
  ADD COLUMN IF NOT EXISTS settled_at         timestamptz,
  -- Free text for the human reference a clerk reads: "B N FILLING · 1–15 Jul".
  ADD COLUMN IF NOT EXISTS settled_ref        text;

CREATE INDEX IF NOT EXISTS fuel_entries_settled_bill_idx
  ON fuel_entries (settled_bill_id) WHERE settled_bill_id IS NOT NULL;

COMMENT ON COLUMN fuel_entries.settled_bill_id IS
  'The 15-day pump bill this memo was settled under. NULL on rows settled '
  'before migration 154 — the link was never recorded and is not guessed at.';

-- ── What the desk needs to see beside every memo ──────────────────────────
--
-- One row per memo with a plain answer to "can this be used again?". The
-- screen reads `reusable`; it must never re-derive the rule from bill_status,
-- because that is how two places end up disagreeing about whether a memo is
-- spent.
CREATE OR REPLACE VIEW v_fuel_memo_settlement AS
SELECT f.id,
       f.memo_no,
       f.entry_date,
       f.vehicle_no,
       f.vendor_id,
       f.vendor_name,
       f.liters,
       f.rate,
       f.amount,
       f.trip_id,
       COALESCE(f.bill_status, 'UNBILLED')                       AS bill_status,
       (COALESCE(f.bill_status, 'UNBILLED') = 'UNBILLED')        AS reusable,
       f.settled_bill_id,
       f.settled_voucher_id,
       f.settled_at,
       COALESCE(
         f.settled_ref,
         (SELECT b.vendor_name || ' · ' || to_char(b.period_from, 'DD Mon')
                 || '–' || to_char(b.period_to, 'DD Mon YYYY')
            FROM pump_bill_drafts b WHERE b.id = f.settled_bill_id),
         CASE WHEN COALESCE(f.bill_status,'UNBILLED') <> 'UNBILLED'
              THEN 'settled before the reference was recorded' END
       )                                                          AS settled_label
  FROM fuel_entries f;

COMMENT ON VIEW v_fuel_memo_settlement IS
  'Every fuel memo with one plain answer: reusable, or already settled and '
  'where. The reconciliation screen must read `reusable` rather than judging '
  'bill_status for itself.';
