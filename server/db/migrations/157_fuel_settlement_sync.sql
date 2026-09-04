-- ═══════════════════════════════════════════════════════════════════════════
-- 157 — Close the loop: a settled bill marks its own slips settled
--
-- WHAT THE SCREEN SAID AND WHAT WAS TRUE
--
-- ALL SLIPS HISTORY paints "⏳ Pending" on every memo whose bill_status is not
-- BILLED_VERIFIED. On 4-Sep-2026 that was 501 of 1,042 memos, ₹75,21,482 — and
-- the reading of that screen was that settlement had not flowed back to the
-- slips. It had. The 478 memos that a settled fortnight actually names were
-- already BILLED_VERIFIED, every one of them, each named by exactly one bill,
-- ₹54,38,252.81 of lines against ₹54,38,252.80 of bills.
--
-- The 501 are pending because they are stranded, not because a status was
-- missed: EVERY ONE OF THEM HAS vendor_id NULL. They carry the pump's WhatsApp
-- nickname — 'B N filling', 'Hey krishna', 'Pawan' — where the master holds
-- 'B N FILLING STATION', 'HEY KRISHNA BHAGAWAN SERVICE STATION', 'PAWAN
-- SERVICE STATION'. No vendor means no fortnight, no fortnight means no bill,
-- and no bill means they can never settle. Flipping them to SETTLED would have
-- marked ₹75 lakh of unpaid diesel as paid and hidden it from the one screen
-- that could still catch it. They are surfaced instead, as their own state.
--
-- WHAT THIS MIGRATION DOES
--
--  1. Backfills the settlement trail on memos a settled bill NAMES. Migration
--     154 said the history could not be backfilled honestly because nothing
--     recorded the link. That was wrong, and this corrects it: each bill
--     carries its own line snapshot in `lines`, and every line carries the
--     fuel_entries.id it was built from. That is a record made at the time,
--     not a guess from dates — which is why the join here is on that id and
--     never on vendor+period, a join that would sweep in memos the bill never
--     paid for.
--
--  2. Marks BILLED_VERIFIED any memo a settled bill names that somehow is not
--     (today: none — the going-forward guarantee, not a repair).
--
--  3. Gives the desk ONE status per slip instead of a two-way guess, so
--     "not settled" and "cannot be settled" stop looking identical.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1 + 2 · the sweep, from the bills' own snapshots ──────────────────────
--
-- Only APPROVED bills carrying a voucher count as settled: the voucher is what
-- proves the money moved. A bill with no voucher has not paid anybody, and its
-- lines are a draft.
WITH named AS (
  SELECT d.id                                                   AS bill_id,
         d.voucher_id,
         d.vendor_name,
         d.period_from,
         d.period_to,
         COALESCE(d.approved_at, d.updated_at, d.created_at)    AS settled_when,
         (l->>'id')::uuid                                       AS slip_id
    FROM pump_bill_drafts d
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(d.lines, '[]'::jsonb)) l
   WHERE d.status = 'APPROVED'
     AND d.voucher_id IS NOT NULL
     AND l->>'id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
-- A memo named by two different bills is not evidence of anything except a
-- problem. It is left exactly as it is, for a person to look at.
unambiguous AS (
  SELECT slip_id FROM named GROUP BY slip_id HAVING count(DISTINCT bill_id) = 1
)
UPDATE fuel_entries f
   SET settled_bill_id    = n.bill_id,
       settled_voucher_id = COALESCE(f.settled_voucher_id, n.voucher_id),
       settled_at         = COALESCE(f.settled_at, n.settled_when),
       settled_ref        = COALESCE(
                              f.settled_ref,
                              n.vendor_name || ' · '
                                || to_char(n.period_from, 'DD Mon')
                                || '–' || to_char(n.period_to, 'DD Mon YYYY')),
       -- The status follows the evidence. A bill that posted a voucher and
       -- names this memo HAS settled it, whatever the row happened to say.
       bill_status        = 'BILLED_VERIFIED',
       updated_at         = now()
  FROM named n
 WHERE n.slip_id = f.id
   AND n.slip_id IN (SELECT slip_id FROM unambiguous)
   AND f.settled_bill_id IS NULL;

-- ── 3 · one honest status per slip ────────────────────────────────────────
--
-- The history screen used to decide this for itself with
-- `bill_status === 'BILLED_VERIFIED' ? ✅ : ⏳`, which folded two completely
-- different situations into one amber badge: a memo waiting for its pump's
-- fortnight to close, and a memo that has no pump at all and will wait
-- forever. The desk can act on the second one; it could not see it.
-- Every column of the table, in its own order, then the computed ones. Not
-- `f.*`: that expands at creation time, so the next ALTER TABLE ADD COLUMN
-- would push a new name into the middle of this list and CREATE OR REPLACE
-- VIEW would refuse to run — a migration that breaks the next migration.
-- Listing them means the endpoint can serve this view in place of the table
-- without a caller losing a field it reads.
CREATE OR REPLACE VIEW v_fuel_slip_status AS
SELECT f.id,
       f.legacy_id,
       f.entry_date,
       f.vehicle_id,
       f.vehicle_no,
       f.trip_id,
       f.trip_legacy_id,
       f.route_name,
       f.driver_name,
       f.vendor_id,
       f.vendor_name,
       f.memo_no,
       f.fuel_type,
       f.liters,
       f.rate,
       f.amount,
       f.cash_given_to_pump,
       f.pump_mobile,
       COALESCE(f.bill_status, 'UNBILLED')                        AS bill_status,
       f.created_at,
       f.updated_at,
       f.import_batch_id,
       f.approval_status,
       f.is_locked,
       f.submitted_by,
       f.submitted_at,
       f.approved_by,
       f.approved_at,
       f.rejected_by,
       f.rejected_at,
       f.reject_reason,
       f.settled_ref,
       CASE
         WHEN COALESCE(f.bill_status, 'UNBILLED') = 'BILLED_VERIFIED' THEN 'SETTLED'
         -- Checked only after SETTLED: a memo already paid for is settled even
         -- if its pump link was tidied away afterwards.
         WHEN f.vendor_id IS NULL                                     THEN 'NO_PUMP'
         ELSE 'PENDING'
       END                                                        AS slip_status,
       f.settled_bill_id,
       f.settled_voucher_id,
       f.settled_at,
       b.invoice_no                                               AS settled_invoice_no,
       b.period_from                                              AS settled_period_from,
       b.period_to                                                AS settled_period_to,
       COALESCE(
         b.invoice_no,
         f.settled_ref,
         CASE WHEN b.id IS NOT NULL
              THEN b.vendor_name || ' · ' || to_char(b.period_from, 'DD Mon')
                   || '–' || to_char(b.period_to, 'DD Mon YYYY') END,
         CASE WHEN COALESCE(f.bill_status,'UNBILLED') = 'BILLED_VERIFIED'
              THEN 'settled before the reference was recorded' END,
         CASE WHEN f.vendor_id IS NULL
              THEN 'pump master se juda nahi — bill nahi ban sakta' END
       )                                                          AS status_label
  FROM fuel_entries f
  LEFT JOIN pump_bill_drafts b ON b.id = f.settled_bill_id;

COMMENT ON VIEW v_fuel_slip_status IS
  'One status per fuel memo for the history screen: SETTLED / PENDING / '
  'NO_PUMP. NO_PUMP is not a kind of pending — those memos carry a pump '
  'nickname that reaches no vendor, so no fortnight can ever pick them up.';

-- ── the stranded memos, grouped so a person can fix them ──────────────────
--
-- The nickname is a PREFIX of the real name in every case seen so far, so the
-- suggestion below is a prefix match and is offered as a suggestion only. Where
-- the prefix reaches two vendors (the master holds 'NIRMALA PETROLUM' three
-- times and 'JOHN N WELL SERVICE STATION' twice) there is no suggestion at
-- all — picking one would be a coin flip on 104 memos, and the duplicate
-- vendor rows are themselves the thing to fix.
CREATE OR REPLACE VIEW v_fuel_slip_unlinked AS
WITH stranded AS (
  SELECT f.vendor_name,
         count(*)::int                      AS slips,
         sum(f.amount)::numeric(14,2)       AS amount,
         min(f.entry_date)                  AS first_slip,
         max(f.entry_date)                  AS last_slip
    FROM fuel_entries f
   WHERE f.vendor_id IS NULL
     AND COALESCE(f.bill_status, 'UNBILLED') <> 'BILLED_VERIFIED'
     AND COALESCE(f.vendor_name, '') <> ''
   GROUP BY 1
),
guess AS (
  SELECT s.vendor_name,
         count(v.id)::int                   AS candidates,
         min(v.id::text)                    AS any_vendor_id,
         min(v.vendor_name)                 AS any_vendor_name
    FROM stranded s
    LEFT JOIN vendors v
      ON pump_key(v.vendor_name) LIKE pump_key(s.vendor_name) || '%'
   GROUP BY 1
)
SELECT s.vendor_name,
       s.slips,
       s.amount,
       s.first_slip,
       s.last_slip,
       g.candidates,
       CASE WHEN g.candidates = 1 THEN g.any_vendor_id::uuid END AS suggested_vendor_id,
       CASE WHEN g.candidates = 1 THEN g.any_vendor_name    END AS suggested_vendor_name,
       CASE
         WHEN g.candidates = 1 THEN 'ek hi pump milta hai — confirm karke jod dijiye'
         WHEN g.candidates > 1 THEN 'master me ' || g.candidates || ' pump is naam se hain — pehle wo saaf kijiye'
         ELSE 'is naam ka koi pump master me nahi — naya banana hoga'
       END                                                  AS advice
  FROM stranded s
  JOIN guess g USING (vendor_name)
 ORDER BY s.amount DESC;

COMMENT ON VIEW v_fuel_slip_unlinked IS
  'Fuel memos that name a pump the vendor master does not hold, grouped by the '
  'name as typed. The suggestion is a prefix match and is never applied '
  'automatically — an ambiguous name gets no suggestion at all.';

CREATE INDEX IF NOT EXISTS fuel_entries_no_vendor_idx
  ON fuel_entries (entry_date DESC) WHERE vendor_id IS NULL;
