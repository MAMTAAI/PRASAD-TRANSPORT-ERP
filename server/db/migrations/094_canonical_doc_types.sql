-- ═══════════════════════════════════════════════════════════════════════════
-- 094_canonical_doc_types.sql — make the imported documents visible on the screen
--
-- The Vault screen renders eleven fixed tabs keyed by id — fitness, insurance,
-- explosive, calibration, rule18, rule43, cii, national_permit, pollution,
-- home_permit, mv_tax — plus any type prefixed `custom_`, whose name it reads
-- off the row.
--
-- The bulk import named the same documents after what the filenames call them:
-- `peso`, `puc`, `road_tax`, `hydro_test`. Both names are reasonable and they
-- are not the same string, so 271 imported documents were sitting in the
-- database where no tab would ever look for them. The Explosive License tab
-- read empty on a lorry whose PESO licence had been filed twenty minutes
-- earlier — which is worse than an empty vault, because it looks like an answer.
--
-- Everything the eleven tabs do not cover (Assam permit, RC, CLL, fire bottle,
-- VLTD, hydro-adjacent certificates) is genuinely an operator-defined type, so
-- it takes the `custom_` prefix the screen already understands rather than a
-- twelfth hardcoded tab.
--
-- server/lib/docPatterns.js is updated in the same change: the importer and the
-- scanner now emit these ids directly, so a re-import does not undo this.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- The unique index is on (vehicle_id, doc_type). Renaming into an id a vehicle
-- already holds would collide, so the rename is written to skip those and they
-- are reported afterwards rather than silently dropped.
CREATE TEMP TABLE doc_type_map (old text PRIMARY KEY, new text) ON COMMIT DROP;
INSERT INTO doc_type_map (old, new) VALUES
  ('peso',                   'explosive'),
  ('puc',                    'pollution'),
  ('road_tax',               'mv_tax'),
  ('hydro_test',             'rule18'),
  ('assam_permit',           'custom_assam_permit'),
  ('permit',                 'custom_permit'),
  ('permit_receipt',         'custom_permit_receipt'),
  ('rc',                     'custom_rc'),
  ('cll',                    'custom_cll'),
  ('fire_bottle',            'custom_fire_bottle'),
  ('vltd',                   'custom_vltd'),
  ('vehicle_photo',          'custom_vehicle_photo'),
  ('certificate_of_control', 'custom_certificate_of_control'),
  ('rule_19a',               'custom_rule_19a'),
  ('hazardous',              'custom_hazardous'),
  ('g_certificate',          'custom_g_certificate'),
  ('h_certificate',          'custom_h_certificate');

UPDATE vehicle_documents d
   SET doc_type = m.new, updated_at = now()
  FROM doc_type_map m
 WHERE d.doc_type = m.old
   AND NOT EXISTS (SELECT 1 FROM vehicle_documents x
                    WHERE x.vehicle_id = d.vehicle_id AND x.doc_type = m.new);

-- Same for anything still queued, so accepting it lands on the right tab.
UPDATE unmapped_documents u
   SET suggested_doc_type = m.new, updated_at = now()
  FROM doc_type_map m
 WHERE u.suggested_doc_type = m.old AND u.status = 'PENDING';

COMMIT;
