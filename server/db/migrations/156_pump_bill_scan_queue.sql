-- ═══════════════════════════════════════════════════════════════════════════
-- 156 — The manual queue: bills the parser could not read
--
-- 56 of the firm's 74 pump invoices are photographs. Two pumps cannot be parsed
-- at all — Highway's scans lose every lorry registration, Alam's lose the table
-- that ties a date to an amount — and those bills still have to be entered by
-- somebody. Until now there was nowhere for them to wait: the files sat in a
-- folder on one PC and the system did not know they existed.
--
-- SO THE QUEUE RECORDS THE ATTEMPT, NOT THE FILE. Every scan that is tried is
-- written down with what happened to it — read, or refused and why. A bill that
-- was never tried is absent, which is different from one that failed, and the
-- difference matters when somebody asks "did we do June?".
--
-- THE CYCLE AND THE PUMP ARE A HINT, NOT A FACT. For an unreadable scan they
-- come from the filename and the folder ("Alam/June 30.06.2026.pdf"), because
-- there is nothing else to go on — the whole reason it is here is that its
-- contents could not be read. They are good enough to sort a work queue and
-- never good enough to post money, so they are named *_hint and the entry
-- screen makes the clerk confirm them.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pump_bill_scan_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  source_file  text NOT NULL,
  -- THE SAME FILE IS NOT QUEUED TWICE. A clerk re-uploading the folder is the
  -- ordinary case; the hash makes that harmless instead of doubling the queue.
  content_sha  text NOT NULL,
  pages        integer,
  bytes        integer,

  -- What the filename and folder suggest. Confirmed by a person before use.
  pump_hint    text,
  vendor_id    uuid REFERENCES vendors(id) ON DELETE SET NULL,
  bill_no_hint text,
  period_from  date,
  period_to    date,
  cycle        text,

  -- PARSED       read cleanly and reconciled to its own printed total
  -- NEEDS_ENTRY  refused — a person has to key it in
  -- ENTERED      keyed in and turned into a bill
  -- DISCARDED    not ours, a duplicate, or superseded
  status       text NOT NULL DEFAULT 'NEEDS_ENTRY'
               CHECK (status IN ('PARSED','NEEDS_ENTRY','ENTERED','DISCARDED')),
  -- Why it could not be read, in the parser's own words.
  reason       text,
  reason_code  text,
  rows_found   integer NOT NULL DEFAULT 0,
  -- How much text the page yielded at all. Zero means a pure photograph; a high
  -- count with no rows means the OCR ran and produced something unusable, which
  -- is a different conversation with the pump.
  text_lines   integer,

  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  linked_bill_id uuid REFERENCES pump_bill_drafts(id) ON DELETE SET NULL,

  uploaded_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  resolved_by  text,
  notes        text
);

CREATE UNIQUE INDEX IF NOT EXISTS pump_bill_scan_sha_uq
  ON pump_bill_scan_queue (content_sha);
CREATE INDEX IF NOT EXISTS pump_bill_scan_open_idx
  ON pump_bill_scan_queue (cycle, pump_hint) WHERE status = 'NEEDS_ENTRY';

COMMENT ON TABLE pump_bill_scan_queue IS
  'Every pump invoice the system has been shown, and what happened to it. '
  'NEEDS_ENTRY rows are the manual queue: scans the parser refused, waiting to '
  'be keyed in. pump_hint and the period come from the filename for those, so '
  'they sort the queue and never post money.';

-- ── The queue, grouped the way it is worked ───────────────────────────────
--
-- By fortnight first, then by pump. A clerk works a cycle at a time because a
-- pump bills a cycle at a time; sorting by upload date would scatter one
-- fortnight's paper across the whole list.
CREATE OR REPLACE VIEW v_pump_bill_queue AS
SELECT q.id,
       q.status,
       COALESCE(q.cycle,
                CASE WHEN q.period_from IS NOT NULL
                     THEN fortnight_code(q.period_from) END,
                'UNDATED')                                   AS cycle,
       CASE WHEN q.period_from IS NOT NULL
            THEN fortnight_label(q.period_from)
            ELSE 'Tareekh pata nahi' END                     AS cycle_label,
       q.period_from,
       q.period_to,
       COALESCE(q.pump_hint, 'Pump pata nahi')               AS pump,
       q.vendor_id,
       q.bill_no_hint,
       q.source_file,
       q.pages,
       q.text_lines,
       q.rows_found,
       q.reason,
       q.reason_code,
       -- Said in one phrase a clerk can act on, rather than a parser code.
       CASE
         WHEN q.status = 'PARSED'                THEN 'Padh li gayi'
         WHEN COALESCE(q.text_lines, 0) = 0      THEN 'Poori photo — koi text nahi'
         WHEN q.reason_code = 'UNKNOWN_PUMP_FORMAT'
              AND COALESCE(q.text_lines, 0) > 0  THEN 'Layout tooti hui — OCR ne table bigaad di'
         WHEN q.reason_code = 'NO_LINES'         THEN 'Text hai par ek bhi row nahi mili'
         WHEN q.reason_code = 'BILL_DOES_NOT_BALANCE'
                                                 THEN 'Rows apne hi total se nahi milte'
         ELSE COALESCE(q.reason, 'Padhi nahi ja saki')
       END                                                   AS issue,
       q.linked_bill_id,
       q.uploaded_by,
       q.created_at,
       q.resolved_at,
       q.resolved_by,
       q.notes
  FROM pump_bill_scan_queue q;

COMMENT ON VIEW v_pump_bill_queue IS
  'The manual review queue, grouped by fortnight then pump. `issue` says what '
  'is wrong in one phrase a clerk can act on rather than a parser error code.';
