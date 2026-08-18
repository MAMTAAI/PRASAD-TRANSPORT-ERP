-- ═══════════════════════════════════════════════════════════════════════════
-- 092_unmapped_documents.sql — the queue for paperwork that could not be filed
--
-- The bulk import of the document tree could prove an owner for 271 files. It
-- could not for the rest: 125 are driver paperwork (Aadhaar, DL, PAN, bank
-- passbook) that belongs to a person and not a lorry, two name a truck that
-- disagrees with the folder they sit in, and a handful carry no recognisable
-- document type at all.
--
-- The first version of the importer SKIPPED those. That is the failure this
-- table exists to end: a skipped file is invisible, and invisible paperwork is
-- indistinguishable from paperwork that was never scanned. Every file the
-- importer cannot place now lands here with the reason and whatever the parser
-- did manage to read, so a human can finish the job from the screen.
--
-- WHY IT DOES NOT GUESS
-- suggested_* columns are exactly that. A suggestion is written by the parser,
-- an assignment is written by a person. Nothing moves into vehicle_documents or
-- onto a driver row until somebody accepts it, because the whole point of the
-- register is that what it says is true.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS unmapped_documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Where it came from and where the bytes are now. source_path is kept even
  -- after assignment: "which folder was this filed under" is the question
  -- asked when a document turns out to be on the wrong truck.
  source_path   text NOT NULL,
  stored_path   text NOT NULL,
  -- Content hash, so re-running the importer over the same tree updates rather
  -- than piling up a second copy of every unresolved file.
  file_hash     text NOT NULL UNIQUE,
  file_size     bigint,

  -- Why it could not be filed automatically.
  reason        text NOT NULL CHECK (reason IN
                  ('DRIVER_DOCUMENT','NO_VEHICLE_PROOF','MISFILED','UNCLASSIFIED','NO_EXPIRY')),
  reason_detail text,

  -- What the parser managed to read. All nullable: a suggestion is allowed to
  -- be partial, and a partial suggestion still saves the clerk typing.
  suggested_scope      text CHECK (suggested_scope IN ('VEHICLE','DRIVER')),
  suggested_doc_type   text,
  suggested_doc_name   text,
  suggested_vehicle_id uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  suggested_driver_id  uuid REFERENCES drivers(id)  ON DELETE SET NULL,
  suggested_expiry     date,
  -- Everything the scanner saw, kept raw. When a suggestion is wrong the first
  -- question is "what did it actually read", and re-running OCR to find out is
  -- both slow and not guaranteed to reproduce.
  scan_text     text,
  scan_result   jsonb,
  scanned_at    timestamptz,

  status        text NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','ASSIGNED','DISMISSED')),
  -- Set when a person accepts it. resolved_ref points at the row that was
  -- created or updated, so the queue can show what happened to a document.
  resolved_kind text CHECK (resolved_kind IN ('VEHICLE_DOCUMENT','DRIVER')),
  resolved_ref  uuid,
  resolved_by   text,
  resolved_at   timestamptz,
  dismiss_note  text,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The screen's default view is "what still needs a human", so that is the index.
CREATE INDEX IF NOT EXISTS idx_unmapped_pending
  ON unmapped_documents (reason, created_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_unmapped_suggested_vehicle
  ON unmapped_documents (suggested_vehicle_id) WHERE suggested_vehicle_id IS NOT NULL;

-- Counts for the queue header, so the badge is a query and not a client-side
-- scan of every row.
CREATE OR REPLACE VIEW v_unmapped_summary AS
SELECT reason,
       count(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
       count(*) FILTER (WHERE status = 'ASSIGNED')::int  AS assigned,
       count(*) FILTER (WHERE status = 'DISMISSED')::int AS dismissed,
       count(*) FILTER (WHERE status = 'PENDING' AND suggested_doc_type IS NOT NULL)::int AS pending_with_suggestion
  FROM unmapped_documents
 GROUP BY reason;

COMMENT ON TABLE unmapped_documents IS
  'Paperwork the importer could not place. A file here is visible and actionable; a file that was skipped was neither.';

COMMIT;
