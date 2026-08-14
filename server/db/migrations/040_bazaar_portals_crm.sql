-- ═══════════════════════════════════════════════════════════════════════════
-- 040_bazaar_portals_crm.sql — the last Firestore-only clusters
--
-- Closes the remaining gap between the ERP and Firestore: the load bazaar, the
-- two self-service portals, the AI letterpad, the audit trail, the WhatsApp CRM
-- and the two settings singletons. After this every collection the SPA reads
-- has a PostgreSQL home, which is what lets `firebase` leave package.json.
--
-- HOW THE SHAPES WERE DERIVED. Six of these collections hold live documents in
-- backups/firestore-backup-2026-08-13, so their columns are the fields actually
-- present, not a guess. The other five (BAZAAR_BIDS, MARKET_VEHICLES,
-- ONBOARDING_APPLICATIONS, WA_CHATS, and the branch registry) have never had a
-- single document written, so their columns come from the writes in the
-- front-end and, for WA_CHATS, from the WhatsApp engine's logChat() call sites.
--
-- WHAT IS DELIBERATELY NOT HERE
--
--   branches   Migration 026 refused this table and the reasoning still holds:
--              the distinct branch values already on ledgers/ledger_entries ARE
--              the list, and a table would let the dropdown offer a branch no
--              record uses. BRANCHES was also never written to — zero documents.
--              What BRANCH.tsx genuinely stores that has no home is the
--              per-branch module toggle map, and that is configuration, not an
--              entity: it lives in `app_settings` under 'branch_modules'.
--
--   Firestore's string money. BAZAAR_LOADS keeps target_rate/toll_amount/weight
--   as strings ('45000', '25 MT'). They land here as numeric, parsed once by
--   the backfill, because a rupee value compared as text sorts '9' above '45000'.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Load bazaar ──────────────────────────────────────────────────────────
-- A load posted for market vendors to bid on. `load_id` is the human code the
-- portals quote at each other (bids reference it, not the surrogate key), so it
-- carries the UNIQUE rather than the uuid.
CREATE TABLE IF NOT EXISTS bazaar_loads (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  load_id       text NOT NULL UNIQUE,
  customer_name text NOT NULL,
  origin        text NOT NULL,
  destination   text NOT NULL,
  distance_km   numeric(10,2),
  toll_plazas   text,
  toll_amount   numeric(14,2) NOT NULL DEFAULT 0,
  material      text,
  weight        text,                     -- '25 MT', '16 KL' — a unit, not a number
  target_rate   numeric(14,2) NOT NULL DEFAULT 0,
  loading_date  date,
  vehicle_type  text,
  rate_type     text,
  status        text NOT NULL DEFAULT 'OPEN'
                CHECK (status IN ('OPEN','AWARDED','CLOSED','CANCELLED')),
  posted_by     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bazaar_loads_status ON bazaar_loads (status, created_at DESC);

-- ── 2. Bids against a load ──────────────────────────────────────────────────
-- FleetPartnerPortal writes these, BazaarAdmin awards one. The award is a
-- status flip, so "one winner per load" has to be enforced here rather than
-- trusted to the screen: a partial unique index allows many PENDING bids but
-- only a single ACCEPTED one.
CREATE TABLE IF NOT EXISTS bazaar_bids (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id   text UNIQUE,
  load_id     text NOT NULL REFERENCES bazaar_loads(load_id) ON UPDATE CASCADE,
  vendor_name text NOT NULL,
  vendor_id   uuid REFERENCES vendors(id),
  bid_amount  numeric(14,2) NOT NULL CHECK (bid_amount >= 0),
  remarks     text,
  status      text NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING','ACCEPTED','REJECTED','WITHDRAWN')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bazaar_bids_load ON bazaar_bids (load_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bazaar_bid_winner
  ON bazaar_bids (load_id) WHERE status = 'ACCEPTED';

-- ── 3. Market (vendor-owned) vehicles ───────────────────────────────────────
-- Distinct from `vehicles` on purpose: these are trucks the firm does not own
-- and does not run compliance on — they are a hiring pool attached to a vendor.
-- Folding them into `vehicles` would put third-party trucks into the fleet
-- reports, the tyre register and the FASTag wallet.
--
-- The expiry dates stay `text`: the form free-types them and they are shown,
-- never computed against. Casting an unvalidated user string to date at load
-- time would fail the backfill on the first '12/13/2026'.
CREATE TABLE IF NOT EXISTS market_vehicles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id       text UNIQUE,
  registration_no text NOT NULL UNIQUE,
  vendor_agency   text NOT NULL,
  vendor_id       uuid REFERENCES vendors(id),
  vehicle_class   text,
  capacity        text,
  driver_name     text,
  driver_mobile   text,
  engine_no       text,
  chassis_no      text,
  rc_expiry       text,
  ins_expiry      text,
  puc_expiry      text,
  fit_expiry      text,
  np_expiry       text,
  -- The screen's own two words, kept verbatim so no display branch has to move.
  system_status   text NOT NULL DEFAULT 'PENDING APPROVAL'
                  CHECK (system_status IN ('System Active','PENDING APPROVAL','BLOCKED')),
  added_by        text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_market_vehicles_status ON market_vehicles (system_status);

-- ── 4. Portal onboarding applications ───────────────────────────────────────
-- Written by CustomerPortal and FleetPartnerPortal, cleared by KycApprovals.
-- `master_id` is the customers/vendors row an approval created, so an approved
-- application can always be traced to the master it produced.
CREATE TABLE IF NOT EXISTS onboarding_applications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id      text UNIQUE,
  type           text NOT NULL CHECK (type IN ('CUSTOMER','VENDOR','FLEET_PARTNER')),
  corporate_name text NOT NULL,
  gst_no         text,
  pan_no         text,
  mobile_no      text,
  address        text,
  contact_person text,
  documents      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'SUBMITTED'
                 CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
  master_id      uuid,
  reject_reason  text,
  approved_by    text,
  approved_at    timestamptz,
  rejected_by    text,
  rejected_at    timestamptz,
  submitted_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_onboarding_status ON onboarding_applications (status, submitted_at DESC);

-- ── 5. AI letterpad output ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS saved_documents (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id  text UNIQUE,
  title      text NOT NULL,
  authority  text,
  vehicle_no text,
  content    text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_saved_documents_created ON saved_documents (created_at DESC);

-- ── 6. Audit trail ──────────────────────────────────────────────────────────
-- src/lib/audit writes this from every screen. Append-only in practice; no
-- trigger is added because unlike ledger_entries this is not money and an
-- operator pruning a year of logs is legitimate.
CREATE TABLE IF NOT EXISTS activity_logs (
  id         bigserial PRIMARY KEY,
  legacy_id  text UNIQUE,
  user_name  text,
  role       text,
  action     text NOT NULL,
  target     text,
  details    text,
  ts         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_logs_ts ON activity_logs (ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_action ON activity_logs (action, ts DESC);

-- ── 7. WhatsApp CRM ─────────────────────────────────────────────────────────
-- The engine (whatsapp-server/) and the dashboard share these. Chats are the
-- only high-volume one; the rest are small configuration sets.
CREATE TABLE IF NOT EXISTS wa_contacts (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text UNIQUE,
  name      text NOT NULL,
  -- Last 10 digits, the form the engine normalises to (last10()). Storing the
  -- normalised value is what makes a contact findable from an inbound message.
  phone     text NOT NULL UNIQUE,
  category  text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_leads (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text UNIQUE,
  name      text NOT NULL,
  req       text,
  status    text NOT NULL DEFAULT 'NEW',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_rules (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text UNIQUE,
  -- The engine looks a rule up by exact lowercased keyword, so two rules with
  -- the same keyword would make the reply depend on row order.
  keyword   text NOT NULL UNIQUE,
  reply     text NOT NULL,
  action    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wa_schedules (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id text UNIQUE,
  phone     text NOT NULL,
  message   text NOT NULL,
  send_at   timestamptz NOT NULL,
  sent_at   timestamptz,
  status    text NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING','SENT','FAILED','CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_schedules_due ON wa_schedules (send_at) WHERE status = 'PENDING';

CREATE TABLE IF NOT EXISTS wa_logs (
  id        bigserial PRIMARY KEY,
  legacy_id text UNIQUE,
  user_name text,
  action    text NOT NULL,
  ts        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_logs_ts ON wa_logs (ts DESC);

-- Both sides of every conversation. `wa_msg_id` is WhatsApp's own id and is the
-- dedupe key for outgoing sends — the engine retries on reconnect, and without
-- this a reconnect storm would double every message in Trip Chat.
CREATE TABLE IF NOT EXISTS wa_chats (
  id             bigserial PRIMARY KEY,
  legacy_id      text UNIQUE,
  phone          text NOT NULL,
  text           text NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('incoming','outgoing')),
  user_id        text,
  sent_by_user_id   text,
  sent_by_user_name text,
  trip_id        uuid REFERENCES trips(id),
  role           text,
  wa_from        text,
  wa_msg_id      text UNIQUE,
  ts             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wa_chats_phone_ts ON wa_chats (phone, ts);
CREATE INDEX IF NOT EXISTS idx_wa_chats_trip ON wa_chats (trip_id, ts) WHERE trip_id IS NOT NULL;

-- ── 8. Public website content ───────────────────────────────────────────────
-- A singleton: one row, edited by WebSettings, rendered by PublicWebsite. The
-- CHECK pins it to one row so a second "draft" cannot appear and leave the two
-- screens disagreeing about which is live.
CREATE TABLE IF NOT EXISTS website_content (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  title1      text,
  title2      text,
  descr       text,
  bg_images   jsonb NOT NULL DEFAULT '[]'::jsonb,
  link1       text, link2 text, link3 text, link4 text, link5 text,
  wa_number   text,
  stat1       text, stat1_desc text,
  stat2       text, stat2_desc text,
  stat3       text, stat3_desc text,
  about_title text,
  about_desc  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ── 9. Application settings ─────────────────────────────────────────────────
-- Replaces the SETTINGS and EMAIL_SETTINGS singletons, and gives BRANCH.tsx's
-- module map a home without resurrecting the `branches` entity 026 rejected.
-- Key/value + jsonb rather than a column per setting: these are read whole by
-- one screen each and adding a setting should not need a migration.
CREATE TABLE IF NOT EXISTS app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
