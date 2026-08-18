-- ═══════════════════════════════════════════════════════════════════════════
-- 098_queue_hold_reason.sql — why a queued document is still sitting there
--
-- `reason` already says why the IMPORTER could not place a file: it was driver
-- paperwork, or misfiled, or unclassified. That answers "how did it get here".
--
-- It does not answer the question the clerk actually has, which is "why is this
-- one still here when the others went through". A driver document with a name
-- against it and an empty slot files itself; one whose slot already holds a
-- file, or one of three Aadhaars queued for the same person, cannot — and those
-- are completely different jobs. Without somewhere to record that, the screen
-- shows sixty identical-looking rows and the clerk works out the distinction
-- again for each one.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE unmapped_documents
  ADD COLUMN IF NOT EXISTS hold_reason text
    CHECK (hold_reason IN ('WOULD_OVERWRITE','MULTIPLE_CANDIDATES','NO_COLUMN','NO_DRIVER','NEEDS_REVIEW')),
  ADD COLUMN IF NOT EXISTS hold_detail text;

COMMENT ON COLUMN unmapped_documents.hold_reason IS
  'Why this one could not be filed automatically, as opposed to why it was queued. The clerk sorts by this.';

CREATE INDEX IF NOT EXISTS idx_unmapped_hold
  ON unmapped_documents (hold_reason) WHERE status = 'PENDING';

-- The queue summary the dashboard reads, now split by the actionable reason
-- rather than only by how the file arrived.
--
-- Dropped rather than replaced: CREATE OR REPLACE VIEW cannot insert a column
-- in the middle of the existing list, and hold_reason belongs beside reason
-- rather than tacked on at the end where nobody reading the row would pair them.
DROP VIEW IF EXISTS v_unmapped_summary;
CREATE VIEW v_unmapped_summary AS
SELECT reason,
       COALESCE(hold_reason, 'NEEDS_REVIEW') AS hold_reason,
       count(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
       count(*) FILTER (WHERE status = 'ASSIGNED')::int  AS assigned,
       count(*) FILTER (WHERE status = 'DISMISSED')::int AS dismissed,
       count(*) FILTER (WHERE status = 'PENDING' AND suggested_doc_type IS NOT NULL)::int AS pending_with_suggestion
  FROM unmapped_documents
 GROUP BY 1, 2;

COMMIT;
