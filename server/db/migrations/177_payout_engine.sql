-- ═══════════════════════════════════════════════════════════════════════════
-- 177 — MULTI-COMPANY PAYOUT ENGINE & ANTI-FRAUD LOCKS
--
-- Owner, 6-Sep-2026, approved against the design published before any code was
-- written. Three paying entities already existed (migration 001 companies, 167
-- bank_accounts, 147 three-tier books); what did not exist was a way to PAY
-- from them safely. This migration adds the missing identity, the payout spine
-- and the four locks.
--
-- WHAT THE AUDIT FOUND FIRST, because it changes what this file does:
--   · The three entities and their four SBI accounts are already live and
--     correct. Nothing here re-creates them.
--   · No UPI identity existed anywhere — no vpa/upi_id column in any table.
--   · payOne() RECORDS a payment a human already made. It does not move money,
--     and after this migration it still does not: the owner chose rail-ready
--     without a provider, so an instruction stops at PENDING_BANK and a person
--     completes the transfer and enters the UTR.
--   · postVoucher() ran in its own transaction while the "mark PAID" update ran
--     in a second one, so a crash between them left the ledger holding a payment
--     the settlement did not know about. Fixed in code (tara.js/kamala.js take
--     an optional tx); this file provides the table that makes the whole act
--     one row with one fate.
--
-- THE FOUR LOCKS, and where each actually lives:
--   1. IDEMPOTENCY   a UNIQUE index on idempotency_key. The guarantee belongs
--                    to the database, not to a route author's memory.
--   2. DUAL AUTH     PIN on every payout; PIN *and* OTP when the beneficiary's
--                    bank/UPI details changed inside 24 h. The window is read
--                    from beneficiary_changes, so editing details and paying
--                    from the same screen cannot dodge it.
--   3. ISOLATION     an account may only pay the beneficiary kinds it is
--                    allowed to. Owner's rule: SBI 1934 is Gautam Prasad's
--                    PERSONAL savings account — driver advances and personal
--                    withdrawals only, never a vendor, to keep it out of the
--                    firm's Income-Tax/GST surface.
--   4. FORWARD ONLY  a payout's status never goes backwards. A correction is a
--                    new instruction, because TARA's ledger is append-only.
--
-- GSTIN for Jaiswal Enterprise and Gautam Prasad stays NULL by owner decision.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══ 1. THE MISSING UPI IDENTITY ══════════════════════════════════════════
-- One VPA per paying entity. The QR is built from the PAYING entity's handle,
-- never a global one — that is the whole point of a multi-company payout.
-- Seeded with the owner's values; editable afterwards from Masters → Companies,
-- which is why this is a plain column and not a hard-coded constant in code.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS upi_vpa citext;

DO $$ BEGIN
  ALTER TABLE companies ADD CONSTRAINT companies_upi_vpa_format
    CHECK (upi_vpa IS NULL OR upi_vpa ~ '^[A-Za-z0-9._-]{2,64}@[A-Za-z]{2,32}$');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

UPDATE companies SET upi_vpa = v.vpa
  FROM (VALUES
    ('PRASAD TRANSPORT',  'prasadtransport@sbi'),
    ('JAISWAL ENTERPRISE','jaiswalenterprise@sbi'),
    ('GAUTAM PRASAD',     'gautamprasad@sbi')
  ) AS v(firm, vpa)
 WHERE upper(companies.company_name) LIKE '%' || v.firm || '%'
   AND companies.upi_vpa IS DISTINCT FROM v.vpa::citext;

-- ═══ 2. THE ADMIN PIN ═════════════════════════════════════════════════════
-- Hashed, never plain — the same rule USERS.password already learned the hard
-- way (001_core dropped a plaintext password field). No PIN is seeded: a secret
-- the owner did not choose is not a secret. Each admin sets their own, and
-- until they do, PIN-gated payouts refuse with PIN_NOT_SET rather than passing.
-- salt + hash, the same pair lib/auth.js already uses for passwords and OTP
-- codes (hashCode/verifyCode). A PIN is a short secret, so a per-user salt is
-- what stops one rainbow table from covering every admin at once.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pin_hash        text,
  ADD COLUMN IF NOT EXISTS pin_salt        text,
  ADD COLUMN IF NOT EXISTS pin_set_at      timestamptz,
  ADD COLUMN IF NOT EXISTS pin_fail_count  int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until timestamptz;

-- ═══ 3. WHICH ACCOUNT MAY PAY WHOM ════════════════════════════════════════
-- Owner's decision, 6-Sep-2026: block vendor payouts from Gautam Prasad's
-- personal savings account (SBI 1934); allow driver advances and personal
-- withdrawals only. Every other account keeps the full set. Stored as data, not
-- as an `if` in a route, so a new payout screen inherits the rule for free.
ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS allowed_beneficiary_kinds text[]
    NOT NULL DEFAULT ARRAY['DRIVER','VENDOR','PUMP','FLEET_PARTNER','STAFF','OWNER'];

UPDATE bank_accounts
   SET allowed_beneficiary_kinds = ARRAY['DRIVER','OWNER']
 WHERE account_tail = '1934'
   AND allowed_beneficiary_kinds <> ARRAY['DRIVER','OWNER'];

COMMENT ON COLUMN bank_accounts.allowed_beneficiary_kinds IS
  'Owner rule 6-Sep-2026: SBI 1934 is a personal savings account — driver '
  'advances and personal withdrawals only. Paying a vendor from it would drag '
  'a personal account into the firm''s Income-Tax and GST surface.';

-- ═══ 4. THE 24-HOUR WINDOW THE OTP RULE READS ═════════════════════════════
-- Written by whatever route edits a party's bank or UPI details. The payout
-- gate reads it; it never trusts a flag passed in by the caller.
CREATE TABLE IF NOT EXISTS beneficiary_changes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  party_kind  text NOT NULL CHECK (party_kind IN ('DRIVER','VENDOR','PUMP','FLEET_PARTNER','STAFF','OWNER')),
  party_id    uuid NOT NULL,
  field       text NOT NULL CHECK (field IN ('BANK','UPI')),
  old_value   text,
  new_value   text,
  changed_by  uuid REFERENCES users(id),
  changed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS beneficiary_changes_recent_idx
  ON beneficiary_changes (party_kind, party_id, changed_at DESC);

-- ═══ 5. THE PAYOUT SPINE ══════════════════════════════════════════════════
-- Every payout is a ROW before it is money. The row is created first, carrying
-- the key the browser minted when the form opened, so a double-click, a retry
-- and a refreshed tab all resolve to the same instruction.
CREATE TABLE IF NOT EXISTS payout_instructions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- LOCK 1. Minted by the browser when the form OPENS, not by the server when
  -- it is submitted — a key minted on submit is a new key on every retry and
  -- guards nothing.
  idempotency_key    uuid NOT NULL,

  -- Two companies, always both recorded. They differ only on a deliberate
  -- cross-entity payment, and then `intercompany` is true and two vouchers are
  -- posted so neither firm absorbs the other's expense.
  paying_company_id  uuid NOT NULL REFERENCES companies(id),
  owing_company_id   uuid NOT NULL REFERENCES companies(id),
  intercompany       boolean NOT NULL DEFAULT false,

  bank_account_id    uuid REFERENCES bank_accounts(id),
  rail               text NOT NULL CHECK (rail IN ('UPI_QR','IMPS','NEFT','CASH')),

  beneficiary_kind   text NOT NULL CHECK (beneficiary_kind IN
                       ('DRIVER','VENDOR','PUMP','FLEET_PARTNER','STAFF','OWNER')),
  beneficiary_id     uuid,
  beneficiary_name   text NOT NULL,

  -- Money is numeric and stays numeric. pool.js hands NUMERIC back as text so a
  -- 15-digit rupee value never round-trips through a JS float.
  amount             numeric(14,2) NOT NULL CHECK (amount > 0),

  source_type        text,
  source_ref         text,

  status             text NOT NULL DEFAULT 'DRAFT'
                       CHECK (status IN ('DRAFT','AUTHORIZED','POSTED','PENDING_BANK','SETTLED','FAILED')),

  -- LOCK 2 evidence. Recorded so an auditor can see WHICH factors were demanded
  -- and satisfied, not merely that someone clicked confirm.
  pin_verified_at    timestamptz,
  otp_required       boolean NOT NULL DEFAULT false,
  otp_verified_at    timestamptz,
  authorized_by      uuid REFERENCES users(id),

  voucher_id         uuid,
  contra_voucher_id  uuid,
  utr                text,
  failure_reason     text,

  created_by         uuid REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- LOCK 1, enforced. One key, one payout, for ever.
CREATE UNIQUE INDEX IF NOT EXISTS payout_instructions_idem_uk
  ON payout_instructions (idempotency_key);
CREATE INDEX IF NOT EXISTS payout_instructions_open_idx
  ON payout_instructions (status, created_at DESC) WHERE status <> 'SETTLED';
CREATE INDEX IF NOT EXISTS payout_instructions_company_idx
  ON payout_instructions (paying_company_id, created_at DESC);

-- ═══ 6. LOCK 3 — AN ACCOUNT MAY ONLY PAY WHOM IT IS ALLOWED TO ════════════
-- A trigger, not a route check. The owner's savings-account rule has to hold
-- for the screen I am about to write AND for the one somebody writes next year.
CREATE OR REPLACE FUNCTION payout_account_policy() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  acct   bank_accounts%ROWTYPE;
BEGIN
  IF NEW.bank_account_id IS NULL THEN
    RETURN NEW;                                   -- cash / UPI-only, no bank leg
  END IF;

  SELECT * INTO acct FROM bank_accounts WHERE id = NEW.bank_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'payout references an unknown bank account'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The account must belong to the entity that is paying. Selecting Jaiswal's
  -- account while paying "as" Prasad is the leak this whole module exists to
  -- prevent, and it is refused here rather than trusted to the dropdown.
  IF acct.company_id IS DISTINCT FROM NEW.paying_company_id THEN
    RAISE EXCEPTION 'bank account % does not belong to the paying entity', acct.account_tail
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (NEW.beneficiary_kind = ANY (acct.allowed_beneficiary_kinds)) THEN
    RAISE EXCEPTION 'account % may not pay a %; allowed: %',
      acct.account_tail, NEW.beneficiary_kind, array_to_string(acct.allowed_beneficiary_kinds, ', ')
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payout_account_policy_t ON payout_instructions;
CREATE TRIGGER payout_account_policy_t
  BEFORE INSERT OR UPDATE OF bank_account_id, beneficiary_kind, paying_company_id
  ON payout_instructions FOR EACH ROW EXECUTE FUNCTION payout_account_policy();

-- ═══ 7. LOCK 4 — FORWARD ONLY ═════════════════════════════════════════════
-- SETTLED and FAILED are terminal. Money that has moved cannot be un-moved by
-- an UPDATE; a correction is a reversing entry and a new instruction.
CREATE OR REPLACE FUNCTION payout_status_forward_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  rank_old int; rank_new int;
BEGIN
  IF NEW.status = OLD.status THEN NEW.updated_at := now(); RETURN NEW; END IF;

  IF OLD.status IN ('SETTLED','FAILED') THEN
    RAISE EXCEPTION 'payout % is % and is final; raise a new instruction instead', OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  rank_old := CASE OLD.status WHEN 'DRAFT' THEN 1 WHEN 'AUTHORIZED' THEN 2
                              WHEN 'POSTED' THEN 3 WHEN 'PENDING_BANK' THEN 4 ELSE 5 END;
  rank_new := CASE NEW.status WHEN 'DRAFT' THEN 1 WHEN 'AUTHORIZED' THEN 2
                              WHEN 'POSTED' THEN 3 WHEN 'PENDING_BANK' THEN 4 ELSE 5 END;

  -- FAILED may be reached from anywhere before terminal; everything else climbs.
  IF NEW.status <> 'FAILED' AND rank_new <= rank_old THEN
    RAISE EXCEPTION 'payout status cannot move % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payout_status_forward_only_t ON payout_instructions;
CREATE TRIGGER payout_status_forward_only_t
  BEFORE UPDATE ON payout_instructions
  FOR EACH ROW EXECUTE FUNCTION payout_status_forward_only();

-- ═══ 8. IS AN OTP REQUIRED? ═══════════════════════════════════════════════
-- One function, so the answer is the same for the API, the desk view and any
-- future screen. 24 hours from the LAST bank/UPI edit on that party.
CREATE OR REPLACE FUNCTION payout_needs_otp(p_kind text, p_party uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM beneficiary_changes
     WHERE party_kind = p_kind AND party_id = p_party
       AND changed_at > now() - interval '24 hours'
  );
$$;

COMMENT ON FUNCTION payout_needs_otp(text, uuid) IS
  'LOCK 2: a payout to a beneficiary whose bank or UPI details changed within '
  '24 hours needs OTP as well as PIN. That window is where payout fraud lives.';

-- ═══ 9. THE DESK VIEW ═════════════════════════════════════════════════════
CREATE OR REPLACE VIEW v_payout_desk AS
SELECT p.id, p.idempotency_key, p.status, p.rail, p.amount,
       p.beneficiary_kind, p.beneficiary_name, p.intercompany,
       pc.company_name AS paying_company, pc.upi_vpa AS paying_vpa,
       oc.company_name AS owing_company,
       b.account_tail, b.bank_name, b.allowed_beneficiary_kinds,
       p.otp_required, p.pin_verified_at, p.otp_verified_at,
       p.utr, p.failure_reason, p.source_type, p.source_ref,
       p.created_at, p.updated_at
  FROM payout_instructions p
  JOIN companies pc ON pc.id = p.paying_company_id
  JOIN companies oc ON oc.id = p.owing_company_id
  LEFT JOIN bank_accounts b ON b.id = p.bank_account_id;

COMMENT ON TABLE payout_instructions IS
  'Every payout is a row before it is money. Created DRAFT with the browser''s '
  'idempotency key, authorized (PIN, +OTP inside the 24h beneficiary window), '
  'POSTED to the ledger in ONE transaction with the status change, then '
  'PENDING_BANK until a person enters the UTR. No provider is connected: the '
  'owner chose rail-ready, so nothing here moves money on its own.';
