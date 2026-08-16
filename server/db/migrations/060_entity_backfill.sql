-- ═══════════════════════════════════════════════════════════════════════════
-- 060_entity_backfill.sql — give the parties that already exist an Entity_ID
--
-- 18 vendors, 4 customers, 54 drivers and 185 ledgers become entities. The
-- order matters: DRIVER first, then VENDOR, then CUSTOMER, because a driver's
-- mobile is the identifier most likely to be right (54 distinct, no collisions)
-- and whoever inserts first keeps the number.
--
-- THREE VENDOR MOBILES ARE ALREADY SHARED BY EIGHT ROWS — 9435022486 x3,
-- 9435022586 x3, 6001965879 x2. That is exactly the duplication entity_master
-- exists to stop, and it is also why this file does not merge them: a shared
-- phone is frequently one proprietor running two firms, and occasionally a
-- typo, and the database cannot tell which. Each of the eight becomes its own
-- entity; the first keeps the number and the rest are created without it, with
-- the dropped value written to entity_identifier_conflicts against the row it
-- came from. The result is a worklist for a human, not a guess committed as
-- fact — and no vendor silently disappears into another.
--
-- ROLLING THIS BACK is DELETE FROM entity_master, which cascades entity_links
-- and the conflict rows. Nothing outside these tables is modified except the
-- new ledgers.entity_id, which is set to NULL by the same delete's RESTRICT
-- being satisfied first.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── DRIVERS ────────────────────────────────────────────────────────────────
-- Aadhaar arrives hashed. mdm_norm_id strips spaces and dashes so the same card
-- typed two ways produces one hash.
WITH ins AS (
  INSERT INTO entity_master (entity_type, display_name, mobile, aadhaar_hash, aadhaar_last4, notes)
  SELECT 'DRIVER',
         btrim(d.name),
         mdm_norm_mobile(d.mobile),
         CASE WHEN mdm_norm_id(d.aadhar_no) ~ '^[0-9]{12}$'
              THEN encode(digest(mdm_norm_id(d.aadhar_no), 'sha256'), 'hex') END,
         CASE WHEN mdm_norm_id(d.aadhar_no) ~ '^[0-9]{12}$'
              THEN right(mdm_norm_id(d.aadhar_no), 4) END,
         'backfilled from drivers'
    FROM drivers d
   WHERE btrim(COALESCE(d.name,'')) <> ''
   ORDER BY d.created_at NULLS LAST, d.id
  ON CONFLICT DO NOTHING
  RETURNING id, display_name, mobile
)
INSERT INTO entity_links (entity_id, source_table, source_id)
SELECT i.id, 'drivers', d.id
  FROM ins i
  JOIN LATERAL (
    SELECT d.id FROM drivers d
     WHERE btrim(d.name) = i.display_name
       AND (mdm_norm_mobile(d.mobile) IS NOT DISTINCT FROM i.mobile)
     LIMIT 1
  ) d ON true
ON CONFLICT DO NOTHING;

-- ── VENDORS ────────────────────────────────────────────────────────────────
-- One row at a time, because the interesting case is the second row that wants
-- an identifier the first already holds. A set-based INSERT would either fail
-- the whole statement or silently drop the vendor; this keeps the vendor and
-- drops only the contested value.
DO $$
DECLARE
  r         record;
  v_entity  uuid;
  v_mobile  text;
  v_gst     text;
  v_holder  uuid;
BEGIN
  FOR r IN
    SELECT id, vendor_name, mobile_no, gst_no, created_at
      FROM vendors
     WHERE btrim(COALESCE(vendor_name,'')) <> ''
     ORDER BY created_at NULLS LAST, id
  LOOP
    v_mobile := mdm_norm_mobile(r.mobile_no);
    v_gst    := mdm_norm_id(r.gst_no);

    IF v_mobile IS NOT NULL THEN
      SELECT id INTO v_holder FROM entity_master
       WHERE mdm_norm_mobile(mobile) = v_mobile AND status <> 'MERGED' LIMIT 1;
      IF v_holder IS NOT NULL THEN
        INSERT INTO entity_identifier_conflicts
          (source_table, source_id, field, raw_value, held_by, reason)
        VALUES ('vendors', r.id::text, 'mobile', r.mobile_no, v_holder,
                'another entity already holds this mobile; not merged automatically '
                || 'because a shared number may be one proprietor with two firms');
        v_mobile := NULL;
      END IF;
    END IF;

    IF v_gst IS NOT NULL THEN
      SELECT id INTO v_holder FROM entity_master
       WHERE mdm_norm_id(gstin) = v_gst AND status <> 'MERGED' LIMIT 1;
      IF v_holder IS NOT NULL THEN
        INSERT INTO entity_identifier_conflicts
          (source_table, source_id, field, raw_value, held_by, reason)
        VALUES ('vendors', r.id::text, 'gstin', r.gst_no, v_holder,
                'another entity already holds this GSTIN');
        v_gst := NULL;
      END IF;
    END IF;

    -- A malformed GSTIN fails the CHECK; record it rather than abort the file.
    IF v_gst IS NOT NULL AND v_gst !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$' THEN
      INSERT INTO entity_identifier_conflicts
        (source_table, source_id, field, raw_value, reason)
      VALUES ('vendors', r.id::text, 'gstin', r.gst_no, 'not a valid GSTIN format');
      v_gst := NULL;
    END IF;

    INSERT INTO entity_master (entity_type, display_name, mobile, gstin, notes)
    VALUES ('VENDOR', btrim(r.vendor_name), v_mobile, v_gst, 'backfilled from vendors')
    RETURNING id INTO v_entity;

    INSERT INTO entity_links (entity_id, source_table, source_id)
    VALUES (v_entity, 'vendors', r.id) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- ── CUSTOMERS ──────────────────────────────────────────────────────────────
DO $$
DECLARE
  r record; v_entity uuid; v_mobile text; v_gst text; v_pan text; v_holder uuid;
BEGIN
  FOR r IN
    SELECT id, customer_name, mobile_no, gst_no, pan_no, created_at
      FROM customers
     WHERE btrim(COALESCE(customer_name,'')) <> ''
     ORDER BY created_at NULLS LAST, id
  LOOP
    v_mobile := mdm_norm_mobile(r.mobile_no);
    v_gst    := mdm_norm_id(r.gst_no);
    v_pan    := mdm_norm_id(r.pan_no);

    IF v_mobile IS NOT NULL THEN
      SELECT id INTO v_holder FROM entity_master
       WHERE mdm_norm_mobile(mobile) = v_mobile AND status <> 'MERGED' LIMIT 1;
      IF v_holder IS NOT NULL THEN
        INSERT INTO entity_identifier_conflicts
          (source_table, source_id, field, raw_value, held_by, reason)
        VALUES ('customers', r.id::text, 'mobile', r.mobile_no, v_holder,
                'another entity already holds this mobile');
        v_mobile := NULL;
      END IF;
    END IF;

    IF v_gst IS NOT NULL AND v_gst !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$' THEN
      INSERT INTO entity_identifier_conflicts (source_table, source_id, field, raw_value, reason)
      VALUES ('customers', r.id::text, 'gstin', r.gst_no, 'not a valid GSTIN format');
      v_gst := NULL;
    END IF;
    IF v_pan IS NOT NULL AND v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
      INSERT INTO entity_identifier_conflicts (source_table, source_id, field, raw_value, reason)
      VALUES ('customers', r.id::text, 'pan', r.pan_no, 'not a valid PAN format');
      v_pan := NULL;
    END IF;
    -- The PAN-inside-GSTIN check would reject the row; keep the GSTIN (it is
    -- the stronger identifier) and flag the PAN.
    IF v_pan IS NOT NULL AND v_gst IS NOT NULL AND substr(v_gst, 3, 10) <> v_pan THEN
      INSERT INTO entity_identifier_conflicts (source_table, source_id, field, raw_value, reason)
      VALUES ('customers', r.id::text, 'pan', r.pan_no,
              'PAN does not match the PAN embedded in this GSTIN; one of the two is wrong');
      v_pan := NULL;
    END IF;

    IF v_gst IS NOT NULL THEN
      SELECT id INTO v_holder FROM entity_master
       WHERE mdm_norm_id(gstin) = v_gst AND status <> 'MERGED' LIMIT 1;
      IF v_holder IS NOT NULL THEN
        INSERT INTO entity_identifier_conflicts
          (source_table, source_id, field, raw_value, held_by, reason)
        VALUES ('customers', r.id::text, 'gstin', r.gst_no, v_holder,
                'another entity already holds this GSTIN');
        v_gst := NULL;
      END IF;
    END IF;

    INSERT INTO entity_master (entity_type, display_name, mobile, gstin, pan, notes)
    VALUES ('CUSTOMER', btrim(r.customer_name), v_mobile, v_gst, v_pan, 'backfilled from customers')
    RETURNING id INTO v_entity;

    INSERT INTO entity_links (entity_id, source_table, source_id)
    VALUES (v_entity, 'customers', r.id) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;

-- ── ONE MASTER LEDGER PER ENTITY ───────────────────────────────────────────
-- Match by name, because that is the only join the data actually supports —
-- ledger_aliases already links ledgers to parties BY NAME. Ambiguous names are
-- left unlinked rather than attached to whichever row sorted first: a ledger
-- pointed at the wrong party is worse than one pointed at nobody.
WITH candidate AS (
  SELECT l.id AS ledger_id, e.id AS entity_id,
         count(*) OVER (PARTITION BY l.id) AS entities_for_ledger,
         count(*) OVER (PARTITION BY e.id) AS ledgers_for_entity
    FROM ledgers l
    JOIN entity_master e
      ON lower(btrim(e.display_name)) = lower(btrim(l.ledger_name))
   WHERE l.entity_id IS NULL
)
UPDATE ledgers l
   SET entity_id = c.entity_id, is_master_ledger = true
  FROM candidate c
 WHERE l.id = c.ledger_id
   AND c.entities_for_ledger = 1
   AND c.ledgers_for_entity = 1;

-- Whatever stayed unmatched is reported, not silently dropped.
INSERT INTO entity_identifier_conflicts (entity_id, source_table, source_id, field, raw_value, reason)
SELECT e.id, 'ledgers', e.entity_code, 'ledger', e.display_name,
       'no unambiguous ledger of this name; entity has no master ledger yet'
  FROM entity_master e
 WHERE NOT EXISTS (SELECT 1 FROM ledgers l WHERE l.entity_id = e.id)
ON CONFLICT DO NOTHING;

COMMIT;
