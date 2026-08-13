-- 007_sync_cursor.sql — composite sync cursor.
--
-- The watermark alone cannot page through rows that share one timestamp (bulk
-- loads stamp a whole collection with the same transaction time), and a JS
-- Date round-trip truncates PostgreSQL microseconds — both fixed by keeping
-- the timestamp textual end-to-end and adding the row id as a tiebreaker.
BEGIN;
ALTER TABLE sync_state ADD COLUMN IF NOT EXISTS watermark_id text NOT NULL DEFAULT '';
COMMIT;
