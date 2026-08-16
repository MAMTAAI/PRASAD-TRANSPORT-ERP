// server/lib/tripEnrich.js
// ─────────────────────────────────────────────────────────────────────────────
// Fill in what an AC5 invoice cannot tell you.
//
// The dispatch invoice carries the load: truck, date, product, quantity, invoice
// number, and the depot it left. It says nothing about where the truck is going,
// how far that is, what the freight rate is, or who is driving — so an imported
// trip lands in the Command Center with driver, rtkm, rate and freight all null,
// and every one of those has to be typed in by hand.
//
// All four are already known to the database, in the 872 trips that came before.
//
// EVIDENCE, NOT THE FIRST MATCH
//
// The temptation is to take the vehicle's most recent destination and copy it.
// That is how JE00107 would have been given a 29 km run to "160738 DSLS & CO" —
// a real row, but ONE row, against seven trips to Imphal Depot at 529 km on its
// sister trucks. A single prior trip is not a route; it is an anecdote.
//
// So a destination is only accepted with MIN_TRIPS behind it, distance is the
// MEDIAN rather than the mean (one mis-keyed 9,000 km trip should not move it),
// and anything short of that is left NULL and reported. A blank field an
// operator fills in is a small cost. A confidently wrong 529 becoming 29 on a
// freight bill is not.
//
// NOTHING IS OVERWRITTEN. Every update is `WHERE column IS NULL`, so a figure a
// human typed always wins, and re-running is free.
import { query, withTransaction } from '../db/pool.js';

// Three prior trips before a destination counts as this vehicle's route.
const MIN_TRIPS = Number(process.env.TRIP_ENRICH_MIN_TRIPS || 3);

/**
 * Enrich trips that are missing route/rate/driver.
 *
 * @param {object} o
 * @param {string[]} [o.tripIds]  restrict to these ids (the sync passes what it created)
 * @param {boolean}  [o.dryRun]   compute and report, change nothing
 */
export async function enrichTrips({ tripIds = null, dryRun = false, sinceHours = 24 } = {}) {
  // SCOPE, DELIBERATELY NARROW. The first dry run of this matched 753 trips --
  // the entire backlog of anything ever missing a field -- because the filter
  // was 'is something null'. Enriching a two-year-old GP trip from today's
  // vehicle history is not filling a blank, it is rewriting history with a
  // guess. Default scope is what the importer just created; anything wider is
  // an explicit list of ids.
  // One query does the whole analysis: for each candidate trip, the dominant
  // destination for that vehicle and the median distance to it. Doing this per
  // trip in JS would be 26 round trips and the same answer.
  const { rows: plan } = await query(
    `
    WITH candidate AS (
      SELECT id, trip_code, vehicle_no, loaded_qty, driver_name, rtkm, rate,
             freight_amount, unloading_location, consignee_name
        FROM trips
       WHERE status NOT IN ('SETTLED', 'CANCELLED')
         AND (rtkm IS NULL OR rate IS NULL OR driver_name IS NULL OR unloading_location IS NULL)
         AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))
         AND ($1::uuid[] IS NOT NULL OR created_at > now() - ($2 || ' hours')::interval)
    ),
    -- The vehicle's dominant destination, with the evidence behind it.
    hist AS (
      SELECT c.id,
             h.unloading_location,
             h.trips_seen,
             h.median_rtkm,
             h.median_rate
        FROM candidate c
        LEFT JOIN LATERAL (
          SELECT x.unloading_location,
                 count(*)                                                          AS trips_seen,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY x.rtkm)               AS median_rtkm,
                 percentile_cont(0.5) WITHIN GROUP (ORDER BY x.rate)
                   FILTER (WHERE x.rate IS NOT NULL AND x.rate > 0)                AS median_rate
            FROM trips x
           WHERE x.rtkm IS NOT NULL AND x.rtkm > 0
             AND x.unloading_location IS NOT NULL
             AND replace(upper(x.vehicle_no), ' ', '') = replace(upper(c.vehicle_no), ' ', '')
           GROUP BY x.unloading_location
           ORDER BY count(*) DESC, percentile_cont(0.5) WITHIN GROUP (ORDER BY x.rtkm)
           LIMIT 1
        ) h ON true
    ),
    -- Whoever last drove this truck. Only the latest, and only if that trip is
    -- recent enough to still be true.
    drv AS (
      SELECT c.id, d.driver_name, d.driver_id, d.driver_mobile
        FROM candidate c
        LEFT JOIN LATERAL (
          SELECT x.driver_name, x.driver_id, x.driver_mobile
            FROM trips x
           WHERE x.driver_name IS NOT NULL AND x.driver_name <> ''
             AND replace(upper(x.vehicle_no), ' ', '') = replace(upper(c.vehicle_no), ' ', '')
             AND x.loading_date > (CURRENT_DATE - interval '120 days')
           ORDER BY x.loading_date DESC NULLS LAST
           LIMIT 1
        ) d ON true
    )
    SELECT c.id, c.trip_code, c.vehicle_no, c.loaded_qty,
           c.driver_name           AS cur_driver,
           c.rtkm                  AS cur_rtkm,
           c.rate                  AS cur_rate,
           c.unloading_location    AS cur_dest,
           h.unloading_location    AS sug_dest,
           h.trips_seen,
           -- percentile_cont returns double precision, and round(double, int)
           -- has no signature in PostgreSQL -- only round(numeric, int). The
           -- cast is not cosmetic; without it the whole query is a 42883.
           round(h.median_rtkm::numeric)    AS sug_rtkm,
           round(h.median_rate::numeric, 2) AS sug_rate,
           d.driver_name           AS sug_driver,
           d.driver_id             AS sug_driver_id,
           d.driver_mobile         AS sug_driver_mobile
      FROM candidate c
      JOIN hist h ON h.id = c.id
      JOIN drv  d ON d.id = c.id
     ORDER BY c.trip_code
    `,
    [tripIds, String(sinceHours)],
  );

  const applied = [];
  const skipped = [];

  for (const r of plan) {
    const strong = r.trips_seen !== null && Number(r.trips_seen) >= MIN_TRIPS;
    const why = [];
    if (!strong) {
      why.push(r.trips_seen
        ? `only ${r.trips_seen} prior trip(s) for ${r.vehicle_no}, need ${MIN_TRIPS}`
        : `no prior trips with a recorded distance for ${r.vehicle_no}`);
    }
    // The driver is independent of the route evidence: last known driver of this
    // truck stands on its own.
    const wantsDriver = !r.cur_driver && r.sug_driver;
    if (!strong && !wantsDriver) { skipped.push({ ...r, why }); continue; }

    const row = {
      id: r.id, trip_code: r.trip_code, vehicle_no: r.vehicle_no,
      dest: strong && !r.cur_dest ? r.sug_dest : null,
      rtkm: strong && r.cur_rtkm == null ? r.sug_rtkm : null,
      rate: strong && r.cur_rate == null ? r.sug_rate : null,
      driver: wantsDriver ? r.sug_driver : null,
      driver_id: wantsDriver ? r.sug_driver_id : null,
      driver_mobile: wantsDriver ? r.sug_driver_mobile : null,
      evidence: r.trips_seen,
      partial: !strong,
      why,
    };
    // An entry that would write nothing is not an application. Counting those
    // made a dry run claim 753 changes when most were already complete.
    if (!row.dest && row.rtkm == null && row.rate == null && !row.driver) {
      continue;
    }
    applied.push(row);
    if (!strong) skipped.push({ ...r, why: [...why, 'driver applied, route left blank'] });
  }

  if (dryRun) return { dry_run: true, min_trips: MIN_TRIPS, applied, skipped };

  // One transaction for the batch. A half-enriched set is worse than none:
  // an operator seeing distance filled but rate blank cannot tell whether the
  // rate is genuinely unknown or whether the job died halfway.
  let updated = 0;
  await withTransaction(async (t) => {
    for (const a of applied) {
      // COALESCE on every column: a value a human typed while this was running
      // wins. freight is computed in SQL, never in JS -- money is numeric here
      // and a float round-trip is how a rupee goes missing.
      const { rowCount } = await t.query(
        `UPDATE trips SET
            unloading_location = COALESCE(unloading_location, $2),
            rtkm               = COALESCE(rtkm, $3),
            rate               = COALESCE(rate, $4),
            driver_name        = COALESCE(driver_name, $5),
            driver_id          = COALESCE(driver_id, $6::uuid),
            driver_mobile      = COALESCE(driver_mobile, $7),
            -- freight_amount IS DELIBERATELY NOT SET HERE.
            --
            -- It looks like the obvious thing to compute: freight_amount really
            -- does equal rate * loaded_qty on every trip that has one. But only
            -- 15 of 594 billed trips have it at all, and they average 57.34 --
            -- sixty rupees to move 17.5 KL two thousand kilometres. rate sits
            -- at 3.4325 on nearly every row: a per-km-per-KL index, not a
            -- freight rate. The money lives in billed_amount, which averages
            -- 30,961 and is written by the Auto-Billing module at its own
            -- rate per KL.
            --
            -- Reproducing rate * qty here would push sixty-rupee freights into
            -- the bill book with an automation's confidence behind them.
            updated_at = now()
          WHERE id = $1::uuid
            AND status NOT IN ('SETTLED', 'CANCELLED')`,
        [a.id, a.dest, a.rtkm, a.rate, a.driver, a.driver_id, a.driver_mobile],
      );
      updated += rowCount;
    }
  });

  return { dry_run: false, min_trips: MIN_TRIPS, updated, applied, skipped };
}
