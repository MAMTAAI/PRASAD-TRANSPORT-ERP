-- ═══════════════════════════════════════════════════════════════════════════
-- 099_driver_document_history.sql — what was there before it was replaced
--
-- `drivers` holds ONE slot per document: dl_photo_url, aadhar_photo_url and so
-- on. Filing a newer licence means the previous pointer is gone, and with it any
-- way to answer "which copy did we have on file in March".
--
-- The operator's rule is "the newer file always wins", which is a sound filing
-- rule and a bad deletion rule. The bytes are not being destroyed — the old file
-- still sits in the vault under its own path — but the only record of WHICH file
-- it was lives in the column being overwritten. So it is written here first.
--
-- This is not an audit log for its own sake. A driver's licence copy being
-- replaced is exactly the kind of thing that gets questioned months later by
-- someone holding a different copy, and "we replaced it on 18 August with the
-- file from AS 26AC 0403's folder" is the answer.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS driver_document_history (
  id           bigserial PRIMARY KEY,
  driver_id    uuid NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  -- The column that was rewritten, e.g. 'dl_photo_url'.
  slot         text NOT NULL,
  doc_type     text,
  previous_url text,          -- may be NULL: the slot was empty, this is a first fill
  new_url      text NOT NULL,
  -- Where the replacement came from, so the change can be traced to a source
  -- document rather than just a timestamp.
  source_path  text,
  replaced_by  text,
  replaced_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_doc_history_driver
  ON driver_document_history (driver_id, replaced_at DESC);

COMMENT ON TABLE driver_document_history IS
  'Every time a driver document slot was repointed. The old file is not deleted; this records which one it was.';

COMMIT;
