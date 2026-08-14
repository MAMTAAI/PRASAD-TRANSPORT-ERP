-- ═══════════════════════════════════════════════════════════════════════════
-- 045_expenses_and_email_parser.sql — the last three Firestore collections
--
-- These were missed by the first inventory: it matched collection(db, "NAME")
-- with double quotes only, and these three are written with single quotes.
-- Worth recording, because the same blind spot would hide any future one:
--   grep -rhoE "collection\(db, *['\"][A-Za-z_0-9]+['\"]" src/
--
--   EXPENSE_APPROVALS    the retroactive-expense queue (postTripEngine writes
--                        it when a bill arrives AFTER unloading; PendingExpenses
--                        and the sidebar badge read it)
--   EMAIL_ACCOUNTS       IMAP mailboxes the bill parser polls
--   EMAIL_PARSED_BILLS   what Claude extracted from each PDF, awaiting review
--
-- ⚠️ EMAIL_ACCOUNTS HOLDS LIVE CREDENTIALS. `app_password` is a working Gmail
-- app password. It is stored in its own column so the API can hold exactly one
-- rule — never select it into a response — the same shape toll_settings uses
-- for portal_password. A masked value must never be written back over the real
-- one; that check belongs in the route, and it is there.
--
-- An expense approval does NOT post to the ledger here. Approval is a decision;
-- the money moves when TARA posts the voucher, and `voucher_id` records which.
-- Anything else would give the GL a second writer.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. Retroactive expense approvals ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_approvals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id             text UNIQUE,
  trip_id               uuid REFERENCES trips(id),
  -- The trip code and vehicle as they read on the bill. Kept as text beside the
  -- FK because an expense can arrive for a trip the ERP does not have a row for
  -- — that is precisely the case this queue exists to catch.
  trip_ref              text,
  vehicle_no            text,
  driver_name           text,
  vendor_name           text,
  expense_type          text NOT NULL,
  bill_no               text,
  bill_date             date,
  amount                numeric(14,2) NOT NULL CHECK (amount >= 0),
  description           text,
  source                text NOT NULL DEFAULT 'MANUAL',
  -- How confident the matcher was that this bill belongs to that trip. Null
  -- when a human entered it.
  match_confidence      numeric(5,2),
  trip_status_at_entry  text,
  status                text NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  entered_by            text,
  approved_by           text,
  approved_at           timestamptz,
  rejection_reason      text,
  -- Set when TARA posts the expense. Its presence is what makes an approval
  -- irreversible from this screen.
  voucher_id            uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expense_approvals_status ON expense_approvals (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expense_approvals_trip ON expense_approvals (trip_id) WHERE trip_id IS NOT NULL;

-- ── 2. Mailboxes the parser polls ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id   text UNIQUE,
  email       text NOT NULL UNIQUE,
  app_password text,                      -- SECRET: never selected into a response
  imap_host   text NOT NULL DEFAULT 'imap.gmail.com',
  imap_port   integer NOT NULL DEFAULT 993 CHECK (imap_port BETWEEN 1 AND 65535),
  customer    text,
  status      text NOT NULL DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
  last_result text,
  last_error  text,
  last_run_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN email_accounts.app_password IS
  'SECRET — a live mailbox app password. Never return it from an API response.';

-- ── 3. Parsed bills awaiting review ─────────────────────────────────────────
-- `digest` is the parser''s own idempotency key (sha1 of message-id + filename),
-- which was the Firestore document id. Keeping it UNIQUE is what makes a
-- re-poll of the same mailbox skip instead of duplicating.
CREATE TABLE IF NOT EXISTS email_parsed_bills (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  digest        text NOT NULL UNIQUE,
  source_email  text,
  customer      text,
  mail_subject  text,
  mail_from     text,
  mail_date     timestamptz,
  attachment    text,
  bill_no       text,
  bill_date     text,                     -- as printed; not always a real date
  party_name    text,
  total_amount  numeric(14,2),
  row_sum       numeric(14,2),
  rows          jsonb NOT NULL DEFAULT '[]'::jsonb,
  ai_model      text,
  ai_usage      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        text NOT NULL DEFAULT 'PENDING_REVIEW'
                CHECK (status IN ('PENDING_REVIEW','FILED','REJECTED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_parsed_bills_status ON email_parsed_bills (status, created_at DESC);

COMMIT;
