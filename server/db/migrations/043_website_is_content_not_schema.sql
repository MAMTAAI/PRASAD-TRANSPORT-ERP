-- ═══════════════════════════════════════════════════════════════════════════
-- 043_website_is_content_not_schema.sql — undo one column per marketing field
--
-- 040 gave website_content a column for each field present in the Firestore
-- export. That was modelling the sample rather than the thing: WebSettings
-- writes the page with a single setDoc of whatever shape the page currently
-- has, and its defaults already carry ~25 fields the export did not contain
-- (heroBadge, aboutVisionDesc, fleetCards[], email1/2, footerText, …). Under a
-- column-per-field table, every copy-edit to the public site would need a
-- migration, and any field without a column would be silently dropped on save.
--
-- The public website is a CMS document, not an entity with relationships. It
-- belongs in app_settings as one jsonb value, which is where the other two
-- singletons already live. Nothing references website_content, so this is a
-- move, not a breaking change.
--
-- The row is carried across in camelCase — the exact shape the two screens read
-- and write — so no field-name adapter is needed on either side.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO app_settings (key, value, updated_at)
SELECT 'website',
       jsonb_strip_nulls(jsonb_build_object(
         'title1',     title1,
         'title2',     title2,
         'desc',       descr,
         'bgImages',   bg_images,
         'link1',      link1,
         'link2',      link2,
         'link3',      link3,
         'link4',      link4,
         'link5',      link5,
         'waNumber',   wa_number,
         'stat1',      stat1,
         'stat1Desc',  stat1_desc,
         'stat2',      stat2,
         'stat2Desc',  stat2_desc,
         'stat3',      stat3,
         'stat3Desc',  stat3_desc,
         'aboutTitle', about_title,
         'aboutDesc',  about_desc
       )),
       updated_at
  FROM website_content
 WHERE id = true
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at;

DROP TABLE IF EXISTS website_content;

COMMIT;
