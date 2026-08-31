-- ═══════════════════════════════════════════════════════════════════════════
-- 114_bazaar_booknow.sql — Book-Now price and a bidding clock (Phase 2)
--
-- Two additions from the 2026 blueprint's bid-flow design:
--   * book_now_rate — the one rate that IS public. A customer may name a price
--     at which any verified partner can take the load instantly, Uber-Freight
--     style. Unlike target_rate (the office's private anchor, never shown),
--     book_now_rate only works if everyone can see it.
--   * bid_close_at — every auction needs an end. Bids after the clock are
--     refused at the bid route (409 BIDDING_CLOSED), not hidden in a screen.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE bazaar_loads
  ADD COLUMN IF NOT EXISTS book_now_rate numeric(14,2)
    CHECK (book_now_rate IS NULL OR book_now_rate > 0),
  ADD COLUMN IF NOT EXISTS bid_close_at timestamptz;

-- The vendor-safe feed gains both fields: book_now_rate is deliberately
-- public, and the closing time tells a bidder how long they have. Still no
-- target_rate and no bid amounts — blindness is unchanged.
CREATE OR REPLACE VIEW v_bazaar_load_feed AS
  SELECT l.id, l.load_id, l.customer_name, l.origin, l.destination, l.distance_km,
         l.material, l.weight, l.vehicle_type, l.rate_type, l.loading_date,
         l.toll_amount, l.status, l.created_at,
         (SELECT count(*) FROM bazaar_bids b
           WHERE b.load_id = l.load_id AND b.status = 'PENDING')::int AS bid_count,
         l.book_now_rate, l.bid_close_at
    FROM bazaar_loads l;

COMMENT ON VIEW v_bazaar_load_feed IS
  'Vendor-safe load feed: no target_rate, no bid amounts, only how many have bid. book_now_rate is public by design.';

COMMIT;
