-- 131_access_hub.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- THE ADMIN CONTROL HUB'S OWN AUDIT TRAIL (2026-09-02).
--
-- Every decision the office takes on an outside party's access — activate,
-- block, archive, edit, feature toggles, session revocation — is one row here,
-- with the before/after snapshot and the reason the party is told. The Hub's
-- "BLOCKED" state is derived from the LATEST row for a party, so a block is a
-- fact with an author and a reason, not just a flag that happens to be false.
--
-- portal_access_audit (068) keeps recording the role-matrix toggles; this table
-- is per PARTY, that one is per MODULE. Neither is ever deleted from.
-- ═══════════════════════════════════════════════════════════════════════════
BEGIN;

CREATE TABLE IF NOT EXISTS access_hub_audit (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('CUSTOMER','FLEET_PARTNER','SERVICE_VENDOR','DRIVER','MARKET_DRIVER')),
  party_id    uuid NOT NULL,
  action      text NOT NULL CHECK (action IN ('ACTIVATE','BLOCK','ARCHIVE','EDIT','FEATURES','REVOKE_SESSIONS','LOGIN_CREATED')),
  before      jsonb,
  after       jsonb,
  reason      text,
  actor_id    uuid,
  actor_name  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_hub_audit_party ON access_hub_audit (party_id, created_at DESC);

COMMIT;
