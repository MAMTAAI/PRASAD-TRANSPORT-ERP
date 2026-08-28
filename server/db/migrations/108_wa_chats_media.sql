-- ═══════════════════════════════════════════════════════════════════════════
-- 108_wa_chats_media.sql — what arrived when the message was not words
--
-- `wa_chats.text` is NOT NULL and POST /crm/chats rejects an empty one with
-- 400 MISSING_FIELDS. The engine posted `msg.body`, and for a photo, a PDF, a
-- voice note or a pin, whatsapp-web.js sets `body` to the caption — which is
-- usually ''. So every media-only message a driver sent was answered with a
-- 400, swallowed by logChat's catch, and lost. The log line 'WA_CHATS log
-- error: HTTP 400' appears several times a day since 15-08; wa_chats holds 170
-- incoming rows and NOT ONE with an empty text, because none could be written.
--
-- That is the worst possible subset to lose. A driver does not type "loaded" —
-- he photographs the loading slip. The messages this dropped are the ones the
-- trip file is actually made of.
--
-- The engine now always sends a text (the caption, or a label naming what came
-- through), so this pair is a RECORD OF KIND, not a fallback. It is what lets
-- Trip Chat say "📄 Document — slip.pdf" instead of a bare '[document]', and
-- what a later 'fetch the attachment itself' can key on. Nullable on purpose:
-- an ordinary text message has no media and must not be made to claim one.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE wa_chats
  ADD COLUMN IF NOT EXISTS media_type     text,
  ADD COLUMN IF NOT EXISTS media_filename text;

-- "Show me the slips and PODs on this trip" — the only question these columns
-- are asked, and it is always asked with a trip or a number already fixed, so
-- a partial index on the rows that HAVE media is the whole of it.
CREATE INDEX IF NOT EXISTS idx_wa_chats_media
  ON wa_chats (phone, ts DESC) WHERE media_type IS NOT NULL;

COMMIT;
