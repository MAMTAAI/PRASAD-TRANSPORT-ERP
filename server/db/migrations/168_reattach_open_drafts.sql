-- ═══════════════════════════════════════════════════════════════════════════
-- 168 — Put every unassigned, billable trip onto the open draft of its
--       unloading fortnight.
--
-- 166 reset the open drafts' trips (customer_bill_id = NULL) so the
-- unloading rule could re-place them, but left the re-placing to the next
-- build. On production the 32 open drafts sat at ₹0 until a person ran the
-- build by hand. This is that step, as a migration of its own (166 was
-- already applied and must not be edited — the runner refuses that).
-- Idempotent: a trip already on a bill is left alone.
-- ═══════════════════════════════════════════════════════════════════════════
UPDATE trips t
   SET customer_bill_id = b.id
  FROM v_customer_trip_recon r
  JOIN customer_bills b
    ON b.customer_id = r.customer_id AND b.books_key = r.books_key
   AND b.locked_at IS NULL AND b.status IN ('AI_DRAFT', 'STAFF_REVIEWED')
   AND r.bill_date BETWEEN b.period_from AND b.period_to
 WHERE r.trip_id = t.id AND t.customer_bill_id IS NULL;

SELECT customer_bill_refresh(id) FROM customer_bills WHERE locked_at IS NULL AND status <> 'CANCELLED';
