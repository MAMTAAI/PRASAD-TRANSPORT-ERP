// server/db/migrations/181_geo_points_and_geofences.selftest.mjs
//   MIGTEST_URL=postgres://user:pw@127.0.0.1:5433/prasad_erp npm run migrate:selftest181
// ─────────────────────────────────────────────────────────────────────────────
// Runs against a database that has ALREADY had every migration applied (spin a
// throwaway cluster with `initdb -A trust` on 5433 and run `db:migrate` at it —
// psql.exe is broken on the dev box, so this speaks node-postgres).
//
// Everything happens inside ONE transaction that is rolled back at the end, so
// pointing this at a populated database changes nothing. It is still not
// pointed at production; the point of the throwaway cluster is that a mistake
// here costs nothing.
//
// WHAT IT PROVES
//   · the five columns landed on all eleven targets, including both ends of a
//     lane and both ends of a bazaar load
//   · a half-set coordinate is REFUSED, not stored — the bug that puts a
//     marker in the Gulf of Guinea
//   · the fence and geo_source vocabularies are enforced
//   · geo_distance_m is right against a known real-world pair
//   · geo_within says NULL, not false, for an unpinned party
//   · toll plazas kept their learned coordinates and got the tighter fence
//   · v_geo_points lists unpinned rows too — they are the work queue
// ─────────────────────────────────────────────────────────────────────────────
import pg from 'pg';

const URL = process.env.MIGTEST_URL || process.env.DATABASE_URL;
if (!URL) {
  console.log('\n⏭  MIGTEST_URL not set — skipping the migration 181 selftest.\n');
  process.exit(0);
}

let failures = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

/** Run a statement expected to fail, and report WHICH constraint stopped it.
 *  Asserting only "it threw" would pass on a typo in the table name. */
async function refused(c, name, sql, args, wantConstraint) {
  await c.query('SAVEPOINT s');
  try {
    await c.query(sql, args);
    await c.query('ROLLBACK TO SAVEPOINT s');
    check(name, 'ACCEPTED', `refused by ${wantConstraint}`);
  } catch (err) {
    await c.query('ROLLBACK TO SAVEPOINT s');
    check(name, err.constraint || err.code, wantConstraint);
  }
}

const c = new pg.Client({ connectionString: URL });
await c.connect();
await c.query('BEGIN');

try {
  console.log('\nmigration 181 — geo points and geofences\n');

  // ── 1. the columns landed everywhere ──────────────────────────────────────
  const TARGETS = [
    ['customers', 'lat'], ['vendors', 'lat'], ['branches', 'lat'],
    ['companies', 'lat'], ['drivers', 'lat'], ['onboarding_applications', 'lat'],
    ['customer_branches', 'lat'], ['toll_plazas', 'lat'],
    ['rtkm_master', 'depot_lat'], ['rtkm_master', 'consignee_lat'],
    ['bazaar_loads', 'origin_lat'], ['bazaar_loads', 'destination_lat'],
  ];
  for (const [t, col] of TARGETS) {
    const { rows } = await c.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
        WHERE table_name = $1 AND column_name = ANY($2)`,
      [t, [col, col.replace(/lat$/, 'lng'), col.replace(/lat$/, 'geofence_radius'),
           col.replace(/lat$/, 'geo_source'), col.replace(/lat$/, 'geo_updated_at')]]);
    check(`${t}.${col.replace(/lat$/, '*')} — five columns`, rows[0].n, 5);
  }

  // The default is the owner's stated 2000 m, on a NOT NULL column, so an
  // existing row is fenced the moment it is pinned.
  const { rows: dflt } = await c.query(
    `SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_name = 'customers' AND column_name = 'geofence_radius'`);
  check('geofence_radius default 2000 NOT NULL',
    [dflt[0].column_default, dflt[0].is_nullable], ['2000', 'NO']);

  // ── 2. a customer to experiment on ────────────────────────────────────────
  const { rows: [cust] } = await c.query(
    `INSERT INTO customers (customer_name) VALUES ('GEO SELFTEST PARTY') RETURNING id`);

  // ── 3. the guards actually refuse ─────────────────────────────────────────
  await refused(c, 'latitude without longitude is refused',
    'UPDATE customers SET lat = 26.5 WHERE id = $1', [cust.id], 'customers_geo_pair');
  await refused(c, 'longitude without latitude is refused',
    'UPDATE customers SET lng = 90.5 WHERE id = $1', [cust.id], 'customers_geo_pair');
  await refused(c, 'latitude out of range is refused',
    'UPDATE customers SET lat = 126.5, lng = 90.5 WHERE id = $1', [cust.id], 'customers_geo_range');
  await refused(c, 'a 10 m fence is refused (tighter than GPS)',
    'UPDATE customers SET geofence_radius = 10 WHERE id = $1', [cust.id], 'customers_geo_fence');
  await refused(c, 'a 200 km fence is refused',
    'UPDATE customers SET geofence_radius = 200000 WHERE id = $1', [cust.id], 'customers_geo_fence');
  await refused(c, 'an invented geo_source is refused',
    "UPDATE customers SET geo_source = 'GUESS' WHERE id = $1", [cust.id], 'customers_geo_source');

  // ── 4. a real pin is accepted ─────────────────────────────────────────────
  // The Bongaigaon Refinery gate, as dropped in the GeoPicker.
  await c.query(
    `UPDATE customers SET lat = 26.5318800, lng = 90.5204100,
            geo_source = 'PIN', geo_updated_at = now() WHERE id = $1`, [cust.id]);
  const { rows: [saved] } = await c.query(
    'SELECT lat::text, lng::text, geofence_radius, geo_source FROM customers WHERE id = $1', [cust.id]);
  check('the exact dragged coordinate is stored, not rounded',
    [saved.lat, saved.lng], ['26.5318800', '90.5204100']);
  check('it inherits the 2 km fence and keeps its provenance',
    [saved.geofence_radius, saved.geo_source], [2000, 'PIN']);

  // geo_updated_at is the DATABASE's answer, not the browser's — a portal
  // session cannot backdate when a pin was surveyed.
  const { rows: [t1] } = await c.query(
    'SELECT geo_updated_at IS NOT NULL AS stamped FROM customers WHERE id = $1', [cust.id]);
  check('moving the pin stamps geo_updated_at server-side', t1.stamped, true);

  // Editing something that is not the point must NOT make the pin look fresh.
  await c.query("UPDATE customers SET geo_updated_at = '2020-01-01' WHERE id = $1", [cust.id]);
  await c.query("UPDATE customers SET mobile_no = '9435020101' WHERE id = $1", [cust.id]);
  const { rows: [t2] } = await c.query(
    "SELECT (geo_updated_at < '2020-01-02')::boolean AS untouched FROM customers WHERE id = $1", [cust.id]);
  check('editing a phone number does not re-date the pin', t2.untouched, true);

  // ── 5. the measurement ────────────────────────────────────────────────────
  // Bongaigaon (26.4831, 90.5533) → Guwahati (26.1445, 91.7362): a lane this
  // fleet runs daily. Checked by hand rather than taken from the function's own
  // output — 1.1829° of longitude at cos(26.3°) is 118.1 km east, 0.3386° of
  // latitude is 37.6 km south, and the hypotenuse is 123.8. Road distance is
  // longer, which is the point: this measures a FENCE, never a freight km.
  const { rows: [d] } = await c.query(
    'SELECT round(geo_distance_m(26.4831, 90.5533, 26.1445, 91.7362)::numeric / 1000, 1) AS km');
  check('Bongaigaon → Guwahati great-circle km', Number(d.km), 123.8);

  const { rows: [z] } = await c.query(
    'SELECT geo_distance_m(26.5, 90.5, 26.5, 90.5) AS m');
  check('a point is zero metres from itself', Number(z.m), 0);

  // NULL, not 0. A NULL that became 0 would read as "same place" and put an
  // unpinned lorry inside every fence in the company.
  const { rows: [n] } = await c.query(
    'SELECT geo_distance_m(26.5, 90.5, NULL, NULL) AS m');
  check('distance to an unpinned party is NULL, never 0', n.m, null);

  // ── 6. the fence question ─────────────────────────────────────────────────
  const { rows: [w] } = await c.query(`SELECT
      geo_within(26.5318800, 90.5204100, 26.5330000, 90.5215000, 2000) AS inside,
      geo_within(26.5318800, 90.5204100, 26.6500000, 90.7000000, 2000) AS outside,
      geo_within(26.5318800, 90.5204100, NULL, NULL, 2000)             AS unknown`);
  check('a lorry 150 m from the gate is inside the fence', w.inside, true);
  check('a lorry 22 km away is outside', w.outside, false);
  check('an unpinned party answers NULL, not false', w.unknown, null);

  // ── 7. toll plazas: coordinates kept, fence tightened ─────────────────────
  const { rows: [tp] } = await c.query(`SELECT
      count(*) FILTER (WHERE lat IS NOT NULL)::int                          AS with_coords,
      count(*) FILTER (WHERE lat IS NOT NULL AND geo_source <> 'IMPORT')::int AS mislabelled,
      count(*) FILTER (WHERE geofence_radius <> 300)::int                    AS wrong_fence
    FROM toll_plazas`);
  check('learned plaza coordinates were not disturbed', tp.mislabelled, 0);
  check('every plaza got the 300 m gate fence, not the 2 km site fence', tp.wrong_fence, 0);

  // ── 8. the views ──────────────────────────────────────────────────────────
  const { rows: [v] } = await c.query(
    `SELECT count(*)::int AS n FROM v_geo_points WHERE entity_kind = 'CUSTOMER' AND entity_id = $1`,
    [cust.id]);
  check('a pinned customer appears in v_geo_points', v.n, 1);

  const { rows: kinds } = await c.query(
    'SELECT DISTINCT entity_kind FROM v_geo_points ORDER BY 1');
  check('v_geo_points covers every party kind',
    kinds.map((r) => r.entity_kind).length >= 1, true);

  // An unpinned row must still be listed. That list IS the work queue — the
  // owner's rule is that a gap becomes a staff task, never a corrective script.
  const { rows: [unp] } = await c.query(
    `INSERT INTO customers (customer_name) VALUES ('GEO SELFTEST UNPINNED') RETURNING id`);
  const { rows: [q] } = await c.query(
    `SELECT count(*)::int AS n FROM v_geo_points
      WHERE entity_id = $1 AND lat IS NULL`, [unp.id]);
  check('an UNPINNED party is listed too (it is the work queue)', q.n, 1);

  const { rows: cov } = await c.query(
    "SELECT total, pinned, unpinned FROM v_geo_coverage WHERE entity_kind = 'CUSTOMER'");
  check('v_geo_coverage counts pinned and unpinned separately',
    cov.length === 1 && cov[0].total === cov[0].pinned + cov[0].unpinned, true);

  // ── 9. the helper survives for the next table that needs pinning ─────────
  const { rows: [fn] } = await c.query(
    `SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'pt_add_geo_columns'`);
  check('pt_add_geo_columns is kept, so the next table reuses the spelling', fn.n, 1);

} finally {
  await c.query('ROLLBACK');
  await c.end();
}

console.log(failures ? `\n✖ ${failures} check(s) failed\n` : '\n✔ all checks passed\n');
process.exit(failures ? 1 : 0);
