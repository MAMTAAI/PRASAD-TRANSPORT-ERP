-- ═══════════════════════════════════════════════════════════════════════════
-- 048_audit_and_sessions.sql — portal identity, live sessions, and an audit
--                              trail that cannot be edited afterwards
--
-- THREE THINGS, ONE FILE, because they are one story: knowing WHO someone is
-- (party link), WHETHER they are here right now (sessions), and WHAT they did
-- (audit).
--
-- 1. PARTY LINK. A CUSTOMER or VENDOR login is only safe if the row knows which
--    customer/vendor it speaks for — otherwise "show me my loads" has no way to
--    mean *mine*. Scope lives in a real foreign key, not a name string: parties
--    get renamed, and a scope that drifts silently shows one customer another
--    customer's freight. A CHECK makes the link mandatory for exactly the two
--    roles that need it, so a portal account cannot exist unscoped.
--
-- 2. SESSIONS. auth_sessions already records every login with its jti, IP and
--    user agent — it IS the session table, so `user_sessions` is a VIEW over it
--    rather than a second copy. Two tables both claiming to know who is online
--    is how you get a monitor that disagrees with the thing it monitors. The
--    only new column is last_seen_at, which is what separates "logged in three
--    hours ago" from "is looking at the screen now".
--
-- 3. AUDIT. audit_logs is append-only by trigger, on the same reasoning as
--    ledger_entries: a trail that can be edited by whoever is being audited is
--    decoration. before/after are jsonb so a correction is legible without
--    joining anything, and the actor is denormalised (name + role copied in) so
--    the trail still reads correctly after a user is renamed or deleted.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Portal identity ──────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS vendor_id   uuid REFERENCES vendors(id)   ON DELETE RESTRICT;

-- One party per login, and only for the roles that mean anything by it.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_portal_scope;
ALTER TABLE users ADD CONSTRAINT users_portal_scope CHECK (
  (role = 'CUSTOMER' AND customer_id IS NOT NULL AND vendor_id IS NULL) OR
  (role = 'VENDOR'   AND vendor_id   IS NOT NULL AND customer_id IS NULL) OR
  (role NOT IN ('CUSTOMER','VENDOR') AND customer_id IS NULL AND vendor_id IS NULL)
);

-- A party gets one portal login, not five.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_customer_portal ON users (customer_id)
  WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_vendor_portal   ON users (vendor_id)
  WHERE vendor_id IS NOT NULL;

-- ── 2. Live sessions ────────────────────────────────────────────────────────
ALTER TABLE auth_sessions
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();

-- The tracker asks "who is live?": unexpired sessions, most recent first.
-- Both columns are in the index rather than a `WHERE expires_at > now()`
-- predicate — now() is STABLE, not IMMUTABLE, and Postgres rejects it in an
-- index predicate (the index would silently mean a different thing every day).
CREATE INDEX IF NOT EXISTS idx_auth_sessions_last_seen
  ON auth_sessions (expires_at, last_seen_at DESC);

-- `user_sessions` is the monitoring shape: one row per live session with the
-- human attached. Expired rows are filtered here so no caller has to remember
-- to — a monitor that forgets that predicate reports the whole office as
-- permanently online.
CREATE OR REPLACE VIEW user_sessions AS
SELECT
  s.jti,
  s.user_id,
  s.driver_id,
  COALESCE(u.full_name, d.name, 'unknown')      AS actor_name,
  COALESCE(u.role::text, CASE WHEN s.driver_id IS NOT NULL THEN 'DRIVER' END, 'UNKNOWN') AS actor_role,
  u.branch,
  u.email::text                                 AS email,
  s.ip,
  s.user_agent,
  s.issued_at,
  s.last_seen_at,
  s.expires_at,
  (s.last_seen_at > now() - interval '5 minutes') AS is_online
FROM auth_sessions s
LEFT JOIN users   u ON u.id = s.user_id
LEFT JOIN drivers d ON d.id = s.driver_id
WHERE s.expires_at > now();

-- ── 3. Audit trail ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_logs (
  id              bigserial PRIMARY KEY,
  at              timestamptz NOT NULL DEFAULT now(),
  request_id      text,
  -- Actor, by reference AND by value. The FKs are ON DELETE SET NULL so
  -- removing a user never removes the record of what they did; the copied
  -- name/role are what the trail still reads by afterwards.
  actor_user_id   uuid REFERENCES users(id)   ON DELETE SET NULL,
  actor_driver_id uuid REFERENCES drivers(id) ON DELETE SET NULL,
  actor_name      text NOT NULL DEFAULT 'anonymous',
  actor_role      text NOT NULL DEFAULT 'ANONYMOUS',
  ip              text,
  user_agent      text,
  -- What was asked
  method          text NOT NULL,
  path            text NOT NULL,
  route           text,
  action          text NOT NULL,
  entity          text,
  entity_id       text,
  -- What changed. NULL before = a create; NULL after = a delete.
  before          jsonb,
  after           jsonb,
  -- How it ended
  status_code     smallint,
  duration_ms     integer,
  error           text
);

CREATE INDEX IF NOT EXISTS idx_audit_at        ON audit_logs (at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor     ON audit_logs (actor_user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity    ON audit_logs (entity, entity_id, at DESC);
-- The Boss view filters to writes that actually landed.
CREATE INDEX IF NOT EXISTS idx_audit_effective ON audit_logs (at DESC)
  WHERE status_code < 400;

-- Append-only, same rule and same reasoning as ledger_entries: an audit trail
-- the audited party can rewrite is not evidence of anything. Retention is a
-- separate, deliberate migration — never a quiet DELETE.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % refused.', TG_OP
    USING ERRCODE = 'P0403';
END;
$fn$;

DROP TRIGGER IF EXISTS audit_logs_no_rewrite ON audit_logs;
CREATE TRIGGER audit_logs_no_rewrite
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

COMMIT;
