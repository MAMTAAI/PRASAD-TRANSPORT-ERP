-- ═══════════════════════════════════════════════════════════════════════════
-- 121_share_links.sql — a document the ERP can hand to somebody with no login
--
-- WHY THIS TABLE EXISTS. Option A was agreed for WhatsApp attachments on
-- 1-Sep: the engine cannot send media at all (there is no MessageMedia call
-- anywhere in whatsapp-server/), so a photo or a PDF goes into the ERP vault
-- and the driver is sent a LINK. The problem is that every door into the vault
-- needs a session — GET /api/v1/files/* runs behind apiGuard and re-checks
-- object ownership — and a driver tapping a link in WhatsApp has no session
-- and no password (drivers have none by design). A vault link posted to
-- WhatsApp today opens a login screen.
--
-- So the link carries its own credential: 32 random bytes, which is the whole
-- of what the holder can do. That is deliberately the smallest possible grant —
-- ONE object, for a bounded time, revocable, and every open recorded.
--
-- WHAT A TOKEN IS NOT. It is not a session: it cannot list, cannot search,
-- cannot reach a second object, and names no user. Guessing one is a 256-bit
-- search. Its blast radius is one file that the office deliberately sent to
-- that number, which is exactly the exposure of having sent it over WhatsApp
-- in the first place.
--
-- EXPIRY IS NOT OPTIONAL. A link with no end date is a permanent public URL to
-- a company document, sitting in a chat history on a handset that gets sold.
-- The column is NOT NULL and the route refuses an expired token.
--
-- THE TOKEN IS NOT STORED, ONLY ITS SHA-256 — the same discipline
-- driver_login_links (migration 109) already uses, and for the same reason: a
-- copy of this table, in a backup or on a screen, must not be a bundle of
-- working links to company documents.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS share_links (
  -- sha256 of the base64url of 32 random bytes. The token itself is returned
  -- once, at mint time, and never written down here.
  token_hash    text PRIMARY KEY,
  storage_key   text NOT NULL,
  filename      text,
  content_type  text,
  -- What this link is for, so the audit reads as sentences rather than rows:
  -- 'WA_MEDIA' (an attachment the office sent), 'LR_COPY' (a lorry receipt).
  purpose       text NOT NULL DEFAULT 'WA_MEDIA',
  -- The number it was sent to, last ten digits. NULL means minted but not yet
  -- sent — that happens when a preview is generated before the send.
  phone         text,
  trip_id       uuid REFERENCES trips(id) ON DELETE SET NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  -- Set by hand when a document goes out to the wrong number. Checked before
  -- expiry so a revoke is immediate.
  revoked_at    timestamptz,
  opens         integer NOT NULL DEFAULT 0,
  first_open_at timestamptz,
  last_open_at  timestamptz,
  CONSTRAINT share_links_expiry_after_creation CHECK (expires_at > created_at)
);

-- "What did we send this driver" and "what is still live" — the two questions
-- anyone will actually ask of this table.
CREATE INDEX IF NOT EXISTS idx_share_links_phone   ON share_links (phone, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_links_trip    ON share_links (trip_id, created_at DESC) WHERE trip_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_share_links_live    ON share_links (expires_at) WHERE revoked_at IS NULL;

COMMENT ON TABLE share_links IS
  'Single-object, time-bounded, revocable read grants for parties with no ERP '
  'login — the delivery mechanism behind WhatsApp attachments (Option A) and '
  'the LR copy. The token IS the credential (only its hash is stored); it '
  'reaches exactly one storage key and nothing else.';

COMMIT;
