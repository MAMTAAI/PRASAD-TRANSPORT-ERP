-- 120_company_partitioning.sql
-- ---------------------------------------------------------------------------
-- Two things the group's books need before any screen can be filtered by
-- company: one spelling per firm, and a record of WHEN a lorry belonged to whom.
--
-- THE LEDGER IS NOT REWRITTEN, AND CANNOT BE. ledger_entries carries
-- `ledger_entries_no_rewrite`, a BEFORE UPDATE OR DELETE trigger that answers
--
--     "ledger_entries is append-only: UPDATE refused. Post a reversing entry
--      instead."
--
-- That is the guardrail of a real ledger and it is doing its job: an accounting
-- record whose past can be edited is not a record. So the eight spellings are
-- normalised on READ, through a function and a view, and every historical row
-- stays exactly as it was written. Nothing here disables a trigger.
--
-- WHAT THE SPELLINGS ACTUALLY ARE, counted before writing this:
--
--     M/S PRASAD TRANSPORT        632  }
--     PRASAD TRANSPORT            365  }  → 997
--     JAISWAL ENTERPRISE          314  }
--     M/S JAISWAL ENTERPRISE      132  }
--     M/S JAISWAL ENTERPRISE␣␣     51  }
--     JAISWAL ENTERPRISE␣          50  }  → 547
--     M/S GAUTAM PRASAD           126     → 126
--     'ALL'                         6     → unassigned, it names no firm
--     NULL                      4,835     → unassigned
--
-- No "JAISNAL" misspelling exists in the data. It was named in the request; it
-- is not there, so nothing merges into it.
--
-- AND 4,501 ENTRIES CANNOT BE ASSIGNED BY ANY MEANS AVAILABLE. Not by their
-- text, not by company_id, and not by their own voucher — checked: of the 4,841
-- untagged, exactly 0 have a tagged sibling on the same voucher, so both sides
-- of those vouchers were written without a company. 340 more can be recovered
-- from company_id. The rest are surfaced as 'UNASSIGNED' rather than pushed
-- into whichever firm is largest: a P&L that quietly swallows 69% of the
-- entries is worse than one that says how much it cannot place.
-- ---------------------------------------------------------------------------

-- ── 1. One spelling per firm ────────────────────────────────────────────────
-- Matched on a distinctive fragment rather than an exact list, so a nineth
-- spelling arriving tomorrow ("Jaiswal Ent.", a stray tab) lands in the right
-- firm instead of silently becoming a fourth company.
CREATE OR REPLACE FUNCTION canonical_company(raw text)
RETURNS text LANGUAGE sql IMMUTABLE AS $fn$
  SELECT CASE
    WHEN raw IS NULL OR btrim(raw) = '' THEN NULL
    WHEN upper(btrim(raw)) LIKE '%JAISWAL%'          THEN 'M/S JAISWAL ENTERPRISE'
    WHEN upper(btrim(raw)) LIKE '%GAUTAM%'           THEN 'M/S GAUTAM PRASAD'
    WHEN upper(btrim(raw)) LIKE '%PRASAD TRANSPORT%' THEN 'M/S PRASAD TRANSPORT'
    ELSE NULL                      -- 'ALL' and anything unrecognised
  END
$fn$;

COMMENT ON FUNCTION canonical_company(text) IS
  'One spelling per operating firm. Returns NULL for a value that names no firm '
  '(NULL, blank, or the sentinel ''ALL'') so callers can count what is unplaced '
  'instead of mis-filing it.';

-- The companies master itself carries the padding that started this: the
-- Jaiswal row is 24 characters for a 22-character name. Safe to fix — this
-- table has no immutability trigger, and every join to it is by id.
UPDATE companies SET company_name = btrim(company_name)
 WHERE company_name <> btrim(company_name);

-- ── 2. The ledger, normalised on read ───────────────────────────────────────
-- Resolution order, most trustworthy first: the row's own text, then its
-- company_id, then nothing. `source` says which one answered, so a report can
-- show its own confidence rather than presenting a guess as a fact.
CREATE OR REPLACE VIEW v_ledger_entries_normalised AS
  SELECT e.*,
         COALESCE(
           canonical_company(e.company),
           canonical_company(c.company_name)
         )                                              AS company_canonical,
         COALESCE(
           canonical_company(e.company),
           canonical_company(c.company_name),
           'UNASSIGNED'
         )                                              AS company_bucket,
         CASE
           WHEN canonical_company(e.company) IS NOT NULL      THEN 'text'
           WHEN canonical_company(c.company_name) IS NOT NULL THEN 'company_id'
           ELSE 'none'
         END                                            AS company_source
    FROM ledger_entries e
    LEFT JOIN companies c ON c.id = e.company_id;

COMMENT ON VIEW v_ledger_entries_normalised IS
  'ledger_entries with one spelling per firm. The base table is append-only and '
  'is never rewritten; company_bucket is UNASSIGNED where no firm can be '
  'established, and company_source names which field answered.';

-- ── 3. Which firm ran a lorry, and WHEN ─────────────────────────────────────
-- vehicles.company_id is a single current value, so changing it moves that
-- truck's ENTIRE history to the new firm — last year's P&L included. 17 of the
-- 49 lorries have already run for more than one company, so this is not a
-- hypothetical: it is the normal case.
--
-- A trip belongs to whoever operated the lorry on its LOADING DATE. Closed
-- books then stay closed, and a transfer only moves work done after it.
CREATE TABLE IF NOT EXISTS vehicle_company_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id     uuid NOT NULL REFERENCES vehicles(id) ON DELETE CASCADE,
  company_id     uuid NOT NULL REFERENCES companies(id),
  effective_from date NOT NULL,
  -- NULL means "still there". Half-open [from, to): a lorry transferred on the
  -- 1st is the old firm's up to the 1st and the new firm's from the 1st, with
  -- no day belonging to both and none to neither.
  effective_to   date,
  reason         text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vch_dates_ordered CHECK (effective_to IS NULL OR effective_to > effective_from)
);

-- One open tenancy per lorry: a truck cannot be operated by two firms at once,
-- and this is the constraint that makes company_at() single-valued.
CREATE UNIQUE INDEX IF NOT EXISTS uq_vch_one_open_per_vehicle
  ON vehicle_company_history (vehicle_id) WHERE effective_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_vch_lookup
  ON vehicle_company_history (vehicle_id, effective_from DESC);

COMMENT ON TABLE vehicle_company_history IS
  'Which operating company ran a vehicle over which dates. Half-open intervals; '
  'effective_to NULL means current. Transfers are recorded by closing the open '
  'row and inserting a new one, never by editing history.';

-- ── Seeding, and why not from vehicles.company_id ──────────────────────────
-- The obvious seed is today's company_id backdated to the lorry's first trip.
-- It was written that way first and the check caught it: resolving trips
-- through it gave Prasad 687 / Jaiswal 302 / Gautam 9, against the trips' OWN
-- record of Prasad 764 / Jaiswal 190 / Gautam 84. Two hundred trips changed
-- hands — because 17 lorries have run for more than one firm and backdating
-- today's owner hands their whole past to whoever holds them now. That is
-- precisely the corruption this table exists to prevent, so seeding it that way
-- would have built the fix on the bug.
--
-- The trips already know. Each trip carries the company that ran it, so the
-- history is the RUNS of consecutive trips under one firm: a change of company
-- between two consecutive loading dates is a transfer, dated at the first trip
-- of the new firm. gaps-and-islands, in one pass.
-- ONE COMPANY PER VEHICLE PER DAY FIRST. A lorry can carry for two firms on the
-- same date — it happens here — and running gaps-and-islands over the raw trips
-- then produces two runs starting on the same day, i.e. a zero-length interval.
-- The check constraint caught exactly that on the first attempt. The day is the
-- smallest unit this model can express, so the day is where the tie is broken:
-- the last trip loaded that day wins, and the earlier one is simply attributed
-- to the same firm for that date.
WITH per_day AS (
  SELECT DISTINCT ON (t.vehicle_id, t.loading_date)
         t.vehicle_id, t.loading_date, t.company_id
    FROM trips t
   WHERE t.vehicle_id IS NOT NULL AND t.company_id IS NOT NULL AND t.loading_date IS NOT NULL
   ORDER BY t.vehicle_id, t.loading_date, t.created_at DESC
),
ordered AS (
  SELECT p.vehicle_id, p.company_id, p.loading_date,
         lag(p.company_id) OVER (PARTITION BY p.vehicle_id ORDER BY p.loading_date) AS prev
    FROM per_day p
),
marked AS (
  SELECT *, count(*) FILTER (WHERE prev IS DISTINCT FROM company_id)
              OVER (PARTITION BY vehicle_id ORDER BY loading_date
                    ROWS UNBOUNDED PRECEDING) AS run_id
    FROM ordered
),
runs AS (
  SELECT vehicle_id, company_id, run_id, min(loading_date) AS starts
    FROM marked GROUP BY vehicle_id, company_id, run_id
)
INSERT INTO vehicle_company_history (vehicle_id, company_id, effective_from, effective_to, reason)
SELECT r.vehicle_id, r.company_id, r.starts,
       -- Closed by the start of the next run; the newest run stays open.
       lead(r.starts) OVER (PARTITION BY r.vehicle_id ORDER BY r.starts),
       'seeded from trip history at migration 120'
  FROM runs r
 WHERE NOT EXISTS (SELECT 1 FROM vehicle_company_history h WHERE h.vehicle_id = r.vehicle_id);

-- A lorry that has never run a trip has no history to infer, so it falls back
-- to its current company_id, open-ended from a floor date. This is a claim
-- about ownership only, never about work done.
INSERT INTO vehicle_company_history (vehicle_id, company_id, effective_from, reason)
SELECT v.id, v.company_id, DATE '1900-01-01',
       'no trips — seeded from vehicles.company_id at migration 120'
  FROM vehicles v
 WHERE v.company_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM vehicle_company_history h WHERE h.vehicle_id = v.id);

-- Which firm operated this lorry on this date. Used by trip and financial
-- queries so that "whose trip was this" is answered by the date it loaded and
-- not by whoever owns the truck today.
CREATE OR REPLACE FUNCTION company_at(p_vehicle uuid, p_on date)
RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT h.company_id
    FROM vehicle_company_history h
   WHERE h.vehicle_id = p_vehicle
     AND p_on >= h.effective_from
     AND (h.effective_to IS NULL OR p_on < h.effective_to)
   ORDER BY h.effective_from DESC
   LIMIT 1
$fn$;

COMMENT ON FUNCTION company_at(uuid, date) IS
  'The operating company of a vehicle on a given date, from '
  'vehicle_company_history. Half-open interval, so a transfer date belongs to '
  'the incoming firm.';
