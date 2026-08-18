-- ═══════════════════════════════════════════════════════════════════════════
-- 101_zero_gap_enforced.sql — make the rule structural, not a convention
--
-- 100 added the three columns a reviewer needs. It did not stop anyone from
-- leaving them empty, and the ten exceptions already in the table proved the
-- point immediately: every one carried a title, a detail and a fix in `options`,
-- and every one had a blank `resolution_action` and `context`. The board showed
-- "why it stopped" and then two dashes.
--
-- A rule that depends on every future detector remembering it is not a rule.
-- So the database fills the gaps itself:
--
--   resolution_action  taken from the first option's label. A detector that
--                      already offered "Keep one line and reverse the
--                      overcharge" has stated the action; it should not also
--                      have to write it out again in prose.
--   context            assembled from what the row already knows — who detected
--                      it, what it is about, when. Thinner than a purpose-built
--                      context, and infinitely better than {}.
--   department         derived, as before.
--
-- The trigger only ever FILLS BLANKS. A detector that says something specific
-- keeps its own words.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION exceptions_fill_gaps() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.department IS NULL THEN
    NEW.department := exception_department(NEW.kind, NEW.subject_type);
  END IF;

  -- The action: the detector's own first option, else an honest default that
  -- still tells the reader what kind of act is expected of them.
  IF NEW.resolution_action IS NULL OR btrim(NEW.resolution_action) = '' THEN
    NEW.resolution_action := COALESCE(
      NULLIF(btrim(NEW.options -> 0 ->> 'label'), ''),
      'Review the evidence and either resolve it with one of the offered actions or dismiss it with a note.'
    );
  END IF;

  -- The context: never a stack trace, always the handful of facts that say
  -- where this came from.
  IF NEW.context IS NULL OR NEW.context = '{}'::jsonb THEN
    NEW.context := jsonb_strip_nulls(jsonb_build_object(
      'process',      NEW.detected_by,
      'subject_type', NEW.subject_type,
      'subject_id',   NEW.subject_id,
      'company',      NEW.company,
      'detected_at',  to_char(COALESCE(NEW.detected_at, now()), 'YYYY-MM-DD HH24:MI')
    ));
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_exceptions_fill_gaps ON exceptions;
CREATE TRIGGER trg_exceptions_fill_gaps
  BEFORE INSERT OR UPDATE ON exceptions
  FOR EACH ROW EXECUTE FUNCTION exceptions_fill_gaps();

-- Backfill the rows that predate the rule, through the same logic.
UPDATE exceptions SET
  resolution_action = COALESCE(
    NULLIF(btrim(resolution_action), ''),
    NULLIF(btrim(options -> 0 ->> 'label'), ''),
    'Review the evidence and either resolve it with one of the offered actions or dismiss it with a note.'),
  context = CASE WHEN context = '{}'::jsonb THEN jsonb_strip_nulls(jsonb_build_object(
      'process', detected_by, 'subject_type', subject_type, 'subject_id', subject_id,
      'company', company, 'detected_at', to_char(detected_at, 'YYYY-MM-DD HH24:MI')))
    ELSE context END,
  department = COALESCE(department, exception_department(kind, subject_type))
 WHERE status IN ('OPEN', 'IN_REVIEW');

COMMENT ON FUNCTION exceptions_fill_gaps() IS
  'Zero-Gap: an exception cannot exist without a department, a stated action and a context. Fills blanks only.';

COMMIT;
