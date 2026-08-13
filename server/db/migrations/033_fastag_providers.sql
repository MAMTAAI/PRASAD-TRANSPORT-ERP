-- ═══════════════════════════════════════════════════════════════════════════
-- 033_fastag_providers.sql — the FASTag provider integration, off Firestore.
--
-- This is the migration that lets the toll DUAL WRITER be shut off. Until now
-- `toll_transactions` had two writers: the browser screen and `toll-sync.cjs`,
-- a Node runner using the Firebase Admin SDK. They wrote the same tolls to
-- different databases. A toll present in only one gets billed twice or never,
-- which is why the screen was held back through cluster 3.
--
-- Both sides now read provider config and write tolls here.
--
-- ⚠️ CREDENTIALS. auth_token and password are provider API secrets and are
-- stored in the clear, exactly as they were in Firestore (which protected them
-- with admin-only rules rather than encryption). The exposure is unchanged by
-- this migration, but it is now OUR table, so state the rules plainly:
--   • /api/v1/toll/providers MASKS both fields on every read. The browser is
--     never sent a secret, and a masked value written back is ignored.
--   • Only the runner reads them raw, over a loopback PostgreSQL connection on
--     the same host. Nothing exposes them over HTTP.
-- Encrypting them at rest needs a key-management decision that does not exist
-- on this box yet; moving them without saying so would have hidden that.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS fastag_providers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id        text UNIQUE,
  name             text NOT NULL,
  type             text NOT NULL DEFAULT 'gtropy',
  base_url         text NOT NULL,
  -- Secrets. See the header before touching how these are read.
  auth_token       text,
  username         text,
  password         text,
  company          text NOT NULL DEFAULT 'PRASAD TRANSPORT',
  active           boolean NOT NULL DEFAULT false,
  -- How far back each sync looks. 2 days by default: providers backfill late,
  -- and re-reading a day is free because the import is idempotent.
  sync_window_days integer NOT NULL DEFAULT 2 CHECK (sync_window_days BETWEEN 1 AND 90),
  last_sync_at     timestamptz,
  last_sync_result text,
  last_sync_error  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS fastag_providers_name_uniq ON fastag_providers (lower(name));
CREATE INDEX IF NOT EXISTS fastag_providers_active_idx ON fastag_providers (active) WHERE active;

-- Per-tag wallet balances, maintained by the runner from the provider's own
-- account feed. Reported, never posted — the GL leg is the toll expense.
CREATE TABLE IF NOT EXISTS fastag_accounts (
  account_id     text PRIMARY KEY,
  vehicle_number text,
  balance        numeric(14,2) NOT NULL DEFAULT 0,
  total_debit    numeric(14,2) NOT NULL DEFAULT 0,
  total_credit   numeric(14,2) NOT NULL DEFAULT 0,
  last_txn_at    timestamptz,
  provider       text,
  provider_type  text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fastag_accounts_vehicle_idx ON fastag_accounts (vehicle_number);

-- Wallet top-ups the provider reports (distinct from toll_recharges, which is
-- what an operator records). Kept so a recharge seen on the portal can be
-- reconciled against one entered by hand instead of silently duplicating it.
CREATE TABLE IF NOT EXISTS fastag_credits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ext_credit_id text UNIQUE,
  account_id    text,
  vehicle_no    text,
  amount        numeric(14,2) NOT NULL,
  credit_date   date,
  credit_at     timestamptz,
  provider      text,
  remarks       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fastag_credits_date_idx ON fastag_credits (credit_date DESC);

-- Single-row settings, keyed so a second settings blob can be added without a
-- migration. The runner polls `force_sync_requested`; the screen sets it.
CREATE TABLE IF NOT EXISTS toll_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO toll_settings (key, value)
VALUES ('auto_sync', '{"enabled": false, "force_sync_requested": false}'::jsonb)
ON CONFLICT (key) DO NOTHING;

DROP TRIGGER IF EXISTS fastag_providers_touch ON fastag_providers;
CREATE TRIGGER fastag_providers_touch BEFORE UPDATE ON fastag_providers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS toll_settings_touch ON toll_settings;
CREATE TRIGGER toll_settings_touch BEFORE UPDATE ON toll_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
