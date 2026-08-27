-- ═══════════════════════════════════════════════════════════════════════════
-- 107_wa_session.sql — which linked WhatsApp account a message came through
--
-- The engine used to hold exactly one WhatsApp client, so there was nothing to
-- record: every row in wa_chats arrived on the company number. Staff can now
-- link their own number, which makes "who sent this, and from which account"
-- two different questions. sent_by_user_name already answered the first;
-- wa_session answers the second.
--
-- IT IS ALSO A PRIVACY BOUNDARY. A staff member's linked personal number
-- receives their private life, and the engine's message handler posts
-- everything it sees. POST /crm/chats uses this column to decide what to KEEP:
-- from a user session, only conversations with a number the ERP already knows
-- (driver, customer or vendor) are stored. Everything else is dropped at the
-- door and never reaches the table.
--
-- 'company' is the backfill because that is factually where every existing row
-- came from.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE wa_chats
  ADD COLUMN IF NOT EXISTS wa_session      text NOT NULL DEFAULT 'company',
  ADD COLUMN IF NOT EXISTS wa_session_kind text NOT NULL DEFAULT 'company'
    CHECK (wa_session_kind IN ('company', 'user'));

-- "This staff member's dispatch traffic" is the question the linking screen
-- asks, and it is the only one that needs an index of its own.
CREATE INDEX IF NOT EXISTS idx_wa_chats_session
  ON wa_chats (wa_session, ts DESC);

COMMIT;
