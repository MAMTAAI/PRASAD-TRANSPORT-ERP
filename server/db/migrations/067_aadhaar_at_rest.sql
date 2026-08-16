-- ═══════════════════════════════════════════════════════════════════════════
-- 067_aadhaar_at_rest.sql — take 29 national ID numbers out of plaintext
--
-- entity_master has stored Aadhaar as a SHA-256 hash since 059. `drivers` kept
-- the full 12 digits, which is where they actually came from and where every
-- screen still reads them: the driver master lists "UID: <number>" and the
-- driver portal renders it in a KYC field. So this is not a DROP COLUMN.
--
-- WHAT HAPPENS TO THE COLUMN. aadhar_no keeps a MASKED value — "XXXX XXXX 9460"
-- — because the number on screen is doing a real job: an operator with the card
-- in hand checks the last four to confirm they have the right driver. Blanking
-- it would break that and teach people to keep the number somewhere worse, like
-- a WhatsApp thread. The full value moves to aadhar_hash, which is what
-- uniqueness and matching now use.
--
-- ONE-WAY. There is no path back from the hash to the number, by design. If a
-- process ever needs the digits again it must ask the driver for the card; that
-- is the point of holding a hash rather than a cipher we would also have to
-- hold the key for.
--
-- THE HASHES ARE THE SAME ONES entity_master ALREADY HOLDS: same normalisation
-- (digits only), same SHA-256, so a driver row and its entity row still agree
-- and the 29 existing entity hashes are not orphaned.
--
-- NOT COVERED, deliberately: aadhar_photo_url still points at a scan of the
-- card, which carries the number as an image. Hashing a column does nothing
-- about that, and pretending otherwise would be the more dangerous outcome —
-- it is called out in the report rather than silently left to look solved.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS aadhar_hash  text,
  ADD COLUMN IF NOT EXISTS aadhar_last4 text;

-- The existing constraint REQUIRED twelve digits — it would have rejected the
-- masked value and forced the plaintext to stay. Worth noticing what it means:
-- a column constrained to be a valid Aadhaar is a column the schema itself
-- insists must hold one. It is replaced below by the inverse rule.
ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_aadhar_format;

-- Populate from the plaintext, then mask it, in one statement so there is no
-- window in which the hash exists and the plaintext is still readable.
UPDATE drivers
   SET aadhar_hash  = encode(digest(regexp_replace(aadhar_no, '[^0-9]', '', 'g'), 'sha256'), 'hex'),
       aadhar_last4 = right(regexp_replace(aadhar_no, '[^0-9]', '', 'g'), 4),
       aadhar_no    = 'XXXX XXXX ' || right(regexp_replace(aadhar_no, '[^0-9]', '', 'g'), 4)
 WHERE aadhar_no IS NOT NULL
   AND regexp_replace(aadhar_no, '[^0-9]', '', 'g') ~ '^[0-9]{12}$';

CREATE UNIQUE INDEX IF NOT EXISTS drivers_aadhar_hash_uq
  ON drivers (aadhar_hash) WHERE aadhar_hash IS NOT NULL;

-- The column must never hold twelve consecutive digits again. This is the part
-- that makes the migration stick: without it the next KYC save from the portal
-- writes a full number straight back in and the cleanup silently undoes itself.
-- The API masks on write (masters.routes.js); this is the backstop for every
-- other path, including a hand-run UPDATE.
ALTER TABLE drivers DROP CONSTRAINT IF EXISTS drivers_aadhar_masked;
ALTER TABLE drivers ADD CONSTRAINT drivers_aadhar_masked CHECK (
  aadhar_no IS NULL
  OR regexp_replace(aadhar_no, '[^0-9]', '', 'g') !~ '^[0-9]{12}$'
);

COMMENT ON COLUMN drivers.aadhar_no IS
  'MASKED display value only (XXXX XXXX 1234). The full number is not stored; aadhar_hash is.';
COMMENT ON COLUMN drivers.aadhar_hash IS
  'SHA-256 of the 12 digits. Same normalisation as entity_master.aadhaar_hash, so the two agree.';

COMMIT;
