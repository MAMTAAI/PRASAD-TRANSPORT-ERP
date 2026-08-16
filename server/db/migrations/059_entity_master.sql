-- ═══════════════════════════════════════════════════════════════════════════
-- 059_entity_master.sql — one row per real-world party, and one ledger for it
--
-- WHY A NEW TABLE RATHER THAN CONSTRAINTS ON THE OLD ONES. The same person is
-- currently up to four rows: a `customers` row, a `vendors` row, a `drivers`
-- row and a `ledgers` row, none of them pointing at each other. Bolting UNIQUE
-- onto those four tables would neither merge the duplicates nor stop the next
-- one, because nothing says the vendor and the driver are the same human.
-- entity_master is that statement, and every identifier is unique ACROSS all
-- types: one mobile number is one party, whatever role it is playing today.
--
-- THE CONSTRAINTS ARE ON NORMALISED VALUES, NOT RAW TEXT. "9435 022486",
-- "+919435022486" and "9435022486" are the same phone; "27aaapa1234a1zx" and
-- "27AAAPA1234A1ZX" are the same GSTIN. A UNIQUE index on the raw column would
-- let every one of those through and enforce nothing, so the indexes are on
-- expressions that strip punctuation and case first.
--
-- AADHAAR IS STORED AS A HASH. The Aadhaar Act restricts holding the number,
-- and a plaintext column plus a UNIQUE index over it is a database that leaks
-- every driver's national ID the moment anything reads it. A SHA-256 of the
-- digits blocks duplicates exactly as well — that is all a UNIQUE index needs —
-- while the last four digits are kept separately so a human can still recognise
-- the card in front of them. `drivers.aadhar_no` is left alone by this file;
-- migrating it out of plaintext is a decision with a legal shape, not a schema
-- change to slip into a backfill.
--
-- THE BACKFILL DOES NOT MERGE ANYBODY. Three vendor mobile numbers are already
-- shared by eight rows. Merging them would be inventing a fact — a shared phone
-- is often one proprietor with two firms, and sometimes it is a typo. So the
-- first row claims the identifier, the rest are created WITHOUT it, and every
-- dropped value is recorded in entity_identifier_conflicts with the row it came
-- from. Nothing is lost and nothing is guessed; there is a worklist instead.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── normalisers ────────────────────────────────────────────────────────────
-- IMMUTABLE because an expression index demands it; these are pure text.

CREATE OR REPLACE FUNCTION mdm_norm_id(v text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT NULLIF(regexp_replace(upper(COALESCE(v, '')), '[^A-Z0-9]', '', 'g'), '')
  $$;

-- A 10-digit Indian mobile, with 0/91/+91 prefixes shaved off so the same phone
-- written four ways collides once.
CREATE OR REPLACE FUNCTION mdm_norm_mobile(v text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $$
    SELECT NULLIF(
      regexp_replace(
        regexp_replace(COALESCE(v, ''), '[^0-9]', '', 'g'),
        '^(0|91|091)(?=[6-9][0-9]{9}$)', ''),
      '')
  $$;

-- ── the master ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS entity_master (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_code    text NOT NULL UNIQUE,          -- VEND-1001, CUST-1001, DRV-1001
  entity_type    text NOT NULL
                 CHECK (entity_type IN ('VENDOR','CUSTOMER','DRIVER','OWNER',
                                        'EMPLOYEE','TRANSPORTER','BANK','OTHER')),
  display_name   text NOT NULL CHECK (length(btrim(display_name)) > 0),

  -- Primary identifiers. All nullable: a party is real before its paperwork is.
  mobile         text,
  pan            text CHECK (pan IS NULL OR mdm_norm_id(pan) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  aadhaar_hash   text CHECK (aadhaar_hash IS NULL OR aadhaar_hash ~ '^[a-f0-9]{64}$'),
  aadhaar_last4  text CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 ~ '^[0-9]{4}$'),
  gstin          text CHECK (gstin IS NULL OR mdm_norm_id(gstin) ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$'),

  -- A GSTIN carries its holder's PAN in positions 3-12. When both are present
  -- and they disagree, one of them is wrong, and letting that through defeats
  -- the point of holding either.
  CONSTRAINT entity_pan_matches_gstin CHECK (
    pan IS NULL OR gstin IS NULL
    OR substr(mdm_norm_id(gstin), 3, 10) = mdm_norm_id(pan)
  ),

  status         text NOT NULL DEFAULT 'ACTIVE'
                 CHECK (status IN ('ACTIVE','INACTIVE','MERGED')),
  merged_into    uuid REFERENCES entity_master(id) ON DELETE RESTRICT,
  CONSTRAINT entity_merged_needs_target CHECK (
    (status = 'MERGED') = (merged_into IS NOT NULL)
  ),
  CONSTRAINT entity_not_merged_into_self CHECK (merged_into IS NULL OR merged_into <> id),

  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ── THE STRICT UNIQUENESS ──────────────────────────────────────────────────
-- Partial (WHERE ... IS NOT NULL) so any number of parties may have no PAN yet,
-- while no two may share one. A MERGED entity keeps its identifiers out of the
-- way so the surviving row can hold them.

CREATE UNIQUE INDEX IF NOT EXISTS entity_mobile_uq
  ON entity_master (mdm_norm_mobile(mobile))
  WHERE mdm_norm_mobile(mobile) IS NOT NULL AND status <> 'MERGED';

CREATE UNIQUE INDEX IF NOT EXISTS entity_pan_uq
  ON entity_master (mdm_norm_id(pan))
  WHERE mdm_norm_id(pan) IS NOT NULL AND status <> 'MERGED';

CREATE UNIQUE INDEX IF NOT EXISTS entity_gstin_uq
  ON entity_master (mdm_norm_id(gstin))
  WHERE mdm_norm_id(gstin) IS NOT NULL AND status <> 'MERGED';

CREATE UNIQUE INDEX IF NOT EXISTS entity_aadhaar_uq
  ON entity_master (aadhaar_hash)
  WHERE aadhaar_hash IS NOT NULL AND status <> 'MERGED';

CREATE INDEX IF NOT EXISTS entity_type_idx ON entity_master (entity_type, status);
CREATE INDEX IF NOT EXISTS entity_name_idx ON entity_master (lower(display_name));

CREATE TRIGGER entity_master_touch BEFORE UPDATE ON entity_master
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── entity codes ───────────────────────────────────────────────────────────
-- A counter table rather than one sequence per type: the prefixes are data, and
-- adding ENTITY_TYPE 'BANK' should not require a DDL change. UPDATE ... RETURNING
-- takes a row lock, so two concurrent inserts cannot draw the same number.

CREATE TABLE IF NOT EXISTS entity_code_seq (
  entity_type text PRIMARY KEY,
  prefix      text NOT NULL,
  next_val    bigint NOT NULL DEFAULT 1001
);

INSERT INTO entity_code_seq (entity_type, prefix) VALUES
  ('VENDOR','VEND'), ('CUSTOMER','CUST'), ('DRIVER','DRV'), ('OWNER','OWNR'),
  ('EMPLOYEE','EMP'), ('TRANSPORTER','TRNS'), ('BANK','BANK'), ('OTHER','ENT')
ON CONFLICT (entity_type) DO NOTHING;

CREATE OR REPLACE FUNCTION next_entity_code(p_type text) RETURNS text
  LANGUAGE plpgsql AS $$
DECLARE v_prefix text; v_next bigint;
BEGIN
  UPDATE entity_code_seq SET next_val = next_val + 1
   WHERE entity_type = p_type
   RETURNING prefix, next_val - 1 INTO v_prefix, v_next;
  IF v_prefix IS NULL THEN
    RAISE EXCEPTION 'unknown entity_type %, add it to entity_code_seq first', p_type;
  END IF;
  RETURN v_prefix || '-' || v_next;
END $$;

CREATE OR REPLACE FUNCTION entity_code_default() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.entity_code IS NULL OR btrim(NEW.entity_code) = '' THEN
    NEW.entity_code := next_entity_code(NEW.entity_type);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER entity_master_code BEFORE INSERT ON entity_master
  FOR EACH ROW EXECUTE FUNCTION entity_code_default();

-- ── what the backfill could not carry ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS entity_identifier_conflicts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id    uuid REFERENCES entity_master(id) ON DELETE CASCADE,
  source_table text NOT NULL,
  source_id    text NOT NULL,
  field        text NOT NULL,
  raw_value    text NOT NULL,
  held_by      uuid REFERENCES entity_master(id) ON DELETE SET NULL,
  reason       text NOT NULL,
  resolved     boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS entity_conflict_open_idx
  ON entity_identifier_conflicts (source_table, field) WHERE NOT resolved;

-- ── provenance: which legacy row became which entity ───────────────────────

CREATE TABLE IF NOT EXISTS entity_links (
  entity_id    uuid NOT NULL REFERENCES entity_master(id) ON DELETE CASCADE,
  source_table text NOT NULL,
  source_id    uuid NOT NULL,
  PRIMARY KEY (source_table, source_id)
);
CREATE INDEX IF NOT EXISTS entity_links_entity_idx ON entity_links (entity_id);

-- ── LEDGER_MASTER: exactly one master ledger per entity ────────────────────
-- The UNIQUE is the whole restructure. `ledgers` keeps its 185 rows and its
-- name-based aliases (ledger_aliases links BY NAME, and rewiring that is a
-- separate job); what changes is that a ledger may now name its entity, and an
-- entity can be named by at most one ledger.

ALTER TABLE ledgers
  ADD COLUMN IF NOT EXISTS entity_id uuid REFERENCES entity_master(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS is_master_ledger boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS ledgers_entity_uq
  ON ledgers (entity_id) WHERE entity_id IS NOT NULL;

COMMENT ON COLUMN ledgers.entity_id IS
  'The party this ledger belongs to. UNIQUE: one entity, one master ledger.';

COMMIT;
