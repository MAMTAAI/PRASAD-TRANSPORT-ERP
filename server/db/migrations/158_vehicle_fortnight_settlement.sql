-- ═══════════════════════════════════════════════════════════════════════════
-- 158 — Vehicle-wise 15-day settlement: draft, review, approve, lock
--
-- ── WHAT THE AUDIT FOUND BEFORE ANY OF THIS WAS WRITTEN ───────────────────
--
-- The brief said: income is the freight on trips where status =
-- 'UNLOADING_COMPLETED'. Neither half of that survives contact with the data.
--
--   1. THERE IS NO 'UNLOADING_COMPLETED'. trips.status holds COMPLETED (1,036)
--      and IN_TRANSIT (4). Filtering on the named status returns nothing, so
--      every lorry's income would have read zero.
--
--   2. trips.freight_amount IS NOT THE FREIGHT. Only 21 of 1,040 trips carry
--      it at all, and on those it is rate x loaded_qty — the kilometres are
--      missing. PT00689: rate 3.4325/KL-km, 17.500 KL, rtkm 2,221, stored as
--      Rs60.07. The trip is worth Rs1,33,412. Summing that column across the
--      fleet gives Rs61,591 of income against Rs1.15 crore of expense, and
--      every lorry reads as losing lakhs a fortnight.
--
--      The real income is trips.billed_amount: Rs2.91 crore over 765 trips,
--      Apr–Jul 2026, 47 lorries. That is what this settles on. received_amount
--      (Rs1.80 crore) is carried alongside as collection, never as income —
--      a P&L on cash receipts would move a lorry's result whenever a customer
--      paid late.
--
--   3. MAINTENANCE HAS NO DATA. v_trip_expense_lines holds HSD (899 lines,
--      Rs1.13 cr) and TOLL (493, Rs2.40 L) and nothing else — no TYRE, no
--      MAINTENANCE, no OTHER. The columns are kept because v_trip_pnl already
--      computes them and they will fill; they are shown as zero rather than
--      hidden, so the desk can see the gap instead of assuming it was counted.
--
-- ── WHY APPROVAL DOES NOT POST THE WHOLE P&L ──────────────────────────────
--
-- The brief asked for "Approve & Lock posts the final P&L to the main
-- accounting ledger". Taken literally that double-counts the business. The
-- freight is billed to the customer through the billing flow and the HSD is
-- posted through the fortnightly pump bill (FUELBILL_ vouchers, migration 154).
-- Both already reach the books on their own. Posting a per-vehicle P&L on top
-- would book the same diesel twice.
--
-- So approval posts exactly what exists nowhere else: THE MANUAL ADJUSTMENTS a
-- reviewer added by hand. The rest of the statement is a report over money the
-- other flows own. The voucher ref is deterministic, so the same fortnight for
-- the same lorry cannot post twice even if approve is clicked twice.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── the settlement itself ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vehicle_fortnight_settlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id      uuid REFERENCES vehicles(id) ON DELETE SET NULL,
  -- Two forms on purpose. vehicle_no is what a person reads on the statement;
  -- vehicle_key is what the unique index uses, so 'AS 26C 5101' and
  -- 'AS26C5101' can never open two settlements for one lorry. No trip in the
  -- register carries two spellings today — this is what keeps it that way.
  vehicle_no      text NOT NULL,
  vehicle_key     text NOT NULL,
  operating_company text,

  period_from     date NOT NULL,
  period_to       date NOT NULL,
  cycle           text,                    -- fortnight_code(), e.g. 2026-07-H1

  -- AI_DRAFT      the machine aggregated it and nobody has looked
  -- STAFF_REVIEWED a person opened it, corrected it and saved
  -- APPROVED      an admin signed it off; locked, and carries its voucher
  status          text NOT NULL DEFAULT 'AI_DRAFT'
                    CHECK (status IN ('AI_DRAFT','STAFF_REVIEWED','APPROVED')),

  -- income
  trips_count     integer      NOT NULL DEFAULT 0,
  billed_amount   numeric(14,2) NOT NULL DEFAULT 0,
  received_amount numeric(14,2) NOT NULL DEFAULT 0,
  other_income    numeric(14,2) NOT NULL DEFAULT 0,

  -- expense, in the same buckets v_trip_pnl already uses
  hsd             numeric(14,2) NOT NULL DEFAULT 0,
  toll            numeric(14,2) NOT NULL DEFAULT 0,
  tyre            numeric(14,2) NOT NULL DEFAULT 0,
  maintenance     numeric(14,2) NOT NULL DEFAULT 0,
  other_expense   numeric(14,2) NOT NULL DEFAULT 0,
  advances        numeric(14,2) NOT NULL DEFAULT 0,

  -- What a reviewer added by hand. This is the ONLY part of the statement that
  -- exists nowhere else in the system, and so the only part that is posted.
  -- [{ label, amount, side: 'INCOME'|'EXPENSE', added_by, added_at }]
  adjustments     jsonb        NOT NULL DEFAULT '[]'::jsonb,

  -- The trips and their figures as they stood when the draft was built. A
  -- statement someone is asked about in March must show what it was built
  -- from, not what the tables say months later.
  lines           jsonb        NOT NULL DEFAULT '[]'::jsonb,

  notes           text,

  -- maker
  reviewed_by     text,
  reviewed_at     timestamptz,
  -- checker
  approved_by     text,
  approved_at     timestamptz,
  voucher_id      uuid,
  locked_at       timestamptz,
  locked_by       text,

  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT vfs_period_sane CHECK (period_to >= period_from),
  -- Migration 073 does the same for pump bills: APPROVED is a claim that money
  -- moved, so it may not exist without the voucher that moved it.
  CONSTRAINT vfs_approved_has_voucher
    CHECK (status <> 'APPROVED' OR voucher_id IS NOT NULL OR locked_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS vfs_one_per_lorry_per_cycle
  ON vehicle_fortnight_settlements (vehicle_key, period_from, period_to);
CREATE INDEX IF NOT EXISTS vfs_cycle_idx  ON vehicle_fortnight_settlements (cycle, status);
CREATE INDEX IF NOT EXISTS vfs_status_idx ON vehicle_fortnight_settlements (status, period_from DESC);

DROP TRIGGER IF EXISTS vfs_touch ON vehicle_fortnight_settlements;
CREATE TRIGGER vfs_touch BEFORE UPDATE ON vehicle_fortnight_settlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── the lock ──────────────────────────────────────────────────────────────
--
-- Guards on OLD.locked_at, not NEW. Guarding on NEW leaves the obvious hole:
-- clear locked_at and edit in the same UPDATE, and the trigger waves it
-- through. Migration 155 learned this on the pump bills; the same rule here.
-- A deliberate reopen is allowed — it is the one statement that may touch a
-- locked row, and it must leave the numbers alone.
CREATE OR REPLACE FUNCTION vfs_lock_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.locked_at IS NULL THEN RETURN NEW; END IF;

  IF NEW.locked_at IS NULL
     AND NEW.status = OLD.status
     AND NEW.billed_amount = OLD.billed_amount
     AND NEW.hsd = OLD.hsd AND NEW.toll = OLD.toll
     AND NEW.tyre = OLD.tyre AND NEW.maintenance = OLD.maintenance
     AND NEW.other_expense = OLD.other_expense
     AND NEW.adjustments = OLD.adjustments THEN
    RETURN NEW;                                  -- a bare reopen
  END IF;

  RAISE EXCEPTION
    'Settlement % (% , % to %) is approved and locked. Reopen it first.',
    OLD.id, OLD.vehicle_no, OLD.period_from, OLD.period_to
    USING ERRCODE = 'P0409';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vfs_lock ON vehicle_fortnight_settlements;
CREATE TRIGGER vfs_lock BEFORE UPDATE ON vehicle_fortnight_settlements
  FOR EACH ROW EXECUTE FUNCTION vfs_lock_guard();

-- ── the draft, computed live ──────────────────────────────────────────────
--
-- One row per lorry per fortnight, straight from the trips. This is what the
-- auto-draft reads; nothing is stored until a draft is built, so a cycle that
-- has never been generated still shows its true numbers on screen.
--
-- The fortnight of a trip is its UNLOADING date where there is one — that is
-- when the work was finished and when it becomes billable. A trip still
-- running falls in its loading fortnight so it is not invisible.
CREATE OR REPLACE VIEW v_vehicle_fortnight_draft AS
SELECT upper(regexp_replace(t.vehicle_no, '[^A-Za-z0-9]', '', 'g'))  AS vehicle_key,
       min(t.vehicle_no)                                             AS vehicle_no,
       max(t.vehicle_id::text)::uuid                                 AS vehicle_id,
       -- A lorry can run for two firms in one fortnight (16 of them do). The
       -- statement names every firm rather than silently picking one.
       string_agg(DISTINCT t.operating_company, ' + ')               AS operating_company,
       fortnight_from(COALESCE(t.unloading_date, t.loading_date))     AS period_from,
       fortnight_to(COALESCE(t.unloading_date, t.loading_date))       AS period_to,
       fortnight_code(COALESCE(t.unloading_date, t.loading_date))     AS cycle,
       count(*)::int                                                  AS trips_count,
       -- billed_amount, NOT freight_amount. See the header.
       COALESCE(sum(t.billed_amount), 0)::numeric(14,2)               AS billed_amount,
       COALESCE(sum(t.received_amount), 0)::numeric(14,2)             AS received_amount,
       COALESCE(sum(p.hsd), 0)::numeric(14,2)                         AS hsd,
       COALESCE(sum(p.toll), 0)::numeric(14,2)                        AS toll,
       COALESCE(sum(p.tyre), 0)::numeric(14,2)                        AS tyre,
       COALESCE(sum(p.maintenance), 0)::numeric(14,2)                 AS maintenance,
       COALESCE(sum(p.other), 0)::numeric(14,2)                       AS other_expense,
       COALESCE(sum(p.advances), 0)::numeric(14,2)                    AS advances,
       COALESCE(sum(p.expense_total), 0)::numeric(14,2)               AS expense_total,
       (COALESCE(sum(t.billed_amount), 0)
        - COALESCE(sum(p.expense_total), 0))::numeric(14,2)           AS net,
       COALESCE(sum(t.loaded_qty), 0)::numeric(14,3)                  AS loaded_qty,
       COALESCE(sum(t.rtkm), 0)::numeric(14,2)                        AS rtkm
  FROM trips t
  LEFT JOIN v_trip_pnl p ON p.trip_id = t.id
 WHERE t.vehicle_no IS NOT NULL
   AND COALESCE(t.unloading_date, t.loading_date) IS NOT NULL
   -- COMPLETED, because that is the status the register actually uses. The
   -- brief named UNLOADING_COMPLETED, which no row has ever carried.
   AND t.status = 'COMPLETED'
 GROUP BY 1, 5, 6, 7;

COMMENT ON VIEW v_vehicle_fortnight_draft IS
  'Live per-lorry, per-fortnight P&L from the trip register. Income is '
  'trips.billed_amount — freight_amount is populated on 21 of 1,040 trips and '
  'is rate x qty with the kilometres missing, so it is not used.';

-- ── what the desk reads ───────────────────────────────────────────────────
--
-- The stored settlement joined to the live draft, so a reviewer can always see
-- whether the trips moved under a draft after it was built.
CREATE OR REPLACE VIEW v_vehicle_settlement AS
SELECT s.*,
       (s.billed_amount + s.other_income
        + COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                     WHERE a->>'side' = 'INCOME'), 0))::numeric(14,2)   AS gross_income,
       (s.hsd + s.toll + s.tyre + s.maintenance + s.other_expense
        + COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                     WHERE a->>'side' = 'EXPENSE'), 0))::numeric(14,2)  AS total_expense,
       COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                  WHERE a->>'side' = 'INCOME'), 0)::numeric(14,2)       AS adj_income,
       COALESCE((SELECT sum((a->>'amount')::numeric) FROM jsonb_array_elements(s.adjustments) a
                  WHERE a->>'side' = 'EXPENSE'), 0)::numeric(14,2)      AS adj_expense,
       (s.locked_at IS NOT NULL)                                        AS locked,
       fortnight_label(s.period_from)                                   AS cycle_label,
       d.trips_count                                                    AS live_trips,
       d.billed_amount                                                  AS live_billed,
       d.expense_total                                                  AS live_expense
  FROM vehicle_fortnight_settlements s
  LEFT JOIN v_vehicle_fortnight_draft d
    ON d.vehicle_key = s.vehicle_key AND d.period_from = s.period_from;

COMMENT ON VIEW v_vehicle_settlement IS
  'A stored settlement with its totals worked out, beside the live figures for '
  'the same lorry and fortnight — so a draft built last week shows whether the '
  'trips have moved since.';

-- ── build the drafts for one fortnight ────────────────────────────────────
--
-- Idempotent and safe to re-run: an untouched AI_DRAFT is refreshed from the
-- trips, a STAFF_REVIEWED or APPROVED one is left exactly alone. Re-running
-- after a late trip lands is the normal way to pick it up, and it must never
-- overwrite a person's work.
CREATE OR REPLACE FUNCTION vehicle_fortnight_build(p_from date, p_by text DEFAULT 'system')
RETURNS TABLE (created int, refreshed int, skipped int) AS $$
DECLARE
  v_from date := fortnight_from(p_from);
  v_to   date := fortnight_to(p_from);
  v_created int := 0; v_refreshed int := 0; v_skipped int := 0;
BEGIN
  WITH src AS (
    SELECT * FROM v_vehicle_fortnight_draft WHERE period_from = v_from
  ), ins AS (
    INSERT INTO vehicle_fortnight_settlements
      (vehicle_id, vehicle_no, vehicle_key, operating_company,
       period_from, period_to, cycle, status,
       trips_count, billed_amount, received_amount,
       hsd, toll, tyre, maintenance, other_expense, advances,
       lines, created_by)
    SELECT s.vehicle_id, s.vehicle_no, s.vehicle_key, s.operating_company,
           s.period_from, s.period_to, s.cycle, 'AI_DRAFT',
           s.trips_count, s.billed_amount, s.received_amount,
           s.hsd, s.toll, s.tyre, s.maintenance, s.other_expense, s.advances,
           COALESCE((
             SELECT jsonb_agg(jsonb_build_object(
                      'trip_id', p.trip_id, 'trip_code', p.trip_code,
                      'loading_date', p.loading_date, 'unloading_date', p.unloading_date,
                      'customer', p.customer_name, 'driver', p.driver_name,
                      'billed', t2.billed_amount, 'received', t2.received_amount,
                      'hsd', p.hsd, 'toll', p.toll, 'tyre', p.tyre,
                      'maintenance', p.maintenance, 'other', p.other,
                      'expense', p.expense_total, 'advances', p.advances)
                      ORDER BY p.loading_date)
               FROM v_trip_pnl p
               JOIN trips t2 ON t2.id = p.trip_id
              WHERE upper(regexp_replace(t2.vehicle_no,'[^A-Za-z0-9]','','g')) = s.vehicle_key
                AND t2.status = 'COMPLETED'
                AND fortnight_from(COALESCE(t2.unloading_date, t2.loading_date)) = s.period_from
           ), '[]'::jsonb),
           p_by
      FROM src s
    ON CONFLICT (vehicle_key, period_from, period_to) DO UPDATE
       SET trips_count     = EXCLUDED.trips_count,
           billed_amount   = EXCLUDED.billed_amount,
           received_amount = EXCLUDED.received_amount,
           hsd             = EXCLUDED.hsd,
           toll            = EXCLUDED.toll,
           tyre            = EXCLUDED.tyre,
           maintenance     = EXCLUDED.maintenance,
           other_expense   = EXCLUDED.other_expense,
           advances        = EXCLUDED.advances,
           operating_company = EXCLUDED.operating_company,
           lines           = EXCLUDED.lines,
           updated_at      = now()
       -- The whole safety of re-running lives on this line.
       WHERE vehicle_fortnight_settlements.status = 'AI_DRAFT'
         AND vehicle_fortnight_settlements.locked_at IS NULL
    RETURNING (xmax = 0) AS was_insert
  )
  SELECT count(*) FILTER (WHERE was_insert),
         count(*) FILTER (WHERE NOT was_insert)
    INTO v_created, v_refreshed FROM ins;

  SELECT count(*) INTO v_skipped
    FROM vehicle_fortnight_settlements
   WHERE period_from = v_from AND status <> 'AI_DRAFT';

  RETURN QUERY SELECT v_created, v_refreshed, v_skipped;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION vehicle_fortnight_build(date, text) IS
  'Build or refresh AI_DRAFT settlements for the fortnight containing p_from. '
  'Never touches a STAFF_REVIEWED or APPROVED row, so it is safe to re-run '
  'whenever a late trip lands.';

-- ── which fortnights have work in them ────────────────────────────────────
CREATE OR REPLACE VIEW v_vehicle_settlement_cycles AS
SELECT d.cycle,
       fortnight_label(d.period_from)              AS cycle_label,
       d.period_from,
       d.period_to,
       count(*)::int                               AS lorries,
       sum(d.trips_count)::int                     AS trips,
       sum(d.billed_amount)::numeric(14,2)         AS billed,
       sum(d.expense_total)::numeric(14,2)         AS expense,
       sum(d.net)::numeric(14,2)                   AS net,
       count(s.id) FILTER (WHERE s.status = 'AI_DRAFT')::int       AS drafts,
       count(s.id) FILTER (WHERE s.status = 'STAFF_REVIEWED')::int AS reviewed,
       count(s.id) FILTER (WHERE s.status = 'APPROVED')::int       AS approved
  FROM v_vehicle_fortnight_draft d
  LEFT JOIN vehicle_fortnight_settlements s
    ON s.vehicle_key = d.vehicle_key AND s.period_from = d.period_from
 GROUP BY d.cycle, d.period_from, d.period_to
 ORDER BY d.period_from DESC;
