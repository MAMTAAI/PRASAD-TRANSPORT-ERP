// server/modules/unmappedVehicles.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// LORRIES THAT ARE IN NO MASTER
//
// A trip whose vehicle_no reaches neither `vehicles` nor `market_vehicles` has
// no class, so no commission rule applies to it and its settlement cannot be
// finished. It also cannot be found by anyone looking for that lorry's work.
//
// Today there is exactly one: trip PT00100 carrying "9803" — plainly a
// truncated AS26C9803. The master holds AS26C9801 through AS26C9816 and 9803
// is among them, OWNED by PRASAD TRANSPORT. It is the only registration
// shorter than eight characters in the whole trip register, so this is one
// mistyped entry rather than a pattern.
//
// THE SUGGESTION IS OFFERED, NEVER APPLIED. The registration on a trip is what
// a driver or a clerk actually wrote; rewriting it from a guess would put the
// register and the paperwork out of step silently, and nobody would know which
// of the two to believe later. A person confirms — and then the route moves the
// trip AND its fuel memos together, because a memo left behind is diesel with
// no lorry and a trip whose cost quietly dropped.
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const key = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** A date column from node-postgres, as YYYY-MM-DD in LOCAL time. */
function ymd(d) {
  if (!d) return null;
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  // Not toISOString(): on an IST box that reports the previous day, and the
  // fortnight rebuilt would then be the wrong one.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
       + `-${String(d.getDate()).padStart(2, '0')}`;
}

export async function registerUnmappedVehicleRoutes(app) {
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };
  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';

  app.get('/unmapped-vehicles', staff, async () => {
    const { rows } = await query(`
      WITH orphan AS (
        SELECT upper(regexp_replace(t.vehicle_no,'[^A-Za-z0-9]','','g')) AS k,
               min(t.vehicle_no)                                   AS vehicle_no,
               count(*)::int                                       AS trips,
               min(COALESCE(t.unloading_date,t.loading_date))       AS first_trip,
               max(COALESCE(t.unloading_date,t.loading_date))       AS last_trip,
               COALESCE(sum(t.billed_amount),0)::numeric(14,2)      AS freight,
               COALESCE(sum(t.total_expense),0)::numeric(14,2)      AS expense,
               string_agg(DISTINCT t.driver_name, ', ')             AS drivers,
               string_agg(DISTINCT t.trip_code, ', ')               AS trip_codes,
               string_agg(DISTINCT t.operating_company, ', ')       AS companies
          FROM trips t
         WHERE t.vehicle_no IS NOT NULL
           AND vehicle_class(t.vehicle_no) IS NULL
         GROUP BY 1
      )
      SELECT o.*,
             (SELECT count(*)::int FROM fuel_entries f
               WHERE upper(regexp_replace(f.vehicle_no,'[^A-Za-z0-9]','','g')) = o.k) AS fuel_memos,
             (SELECT COALESCE(sum(f.amount),0)::numeric(14,2) FROM fuel_entries f
               WHERE upper(regexp_replace(f.vehicle_no,'[^A-Za-z0-9]','','g')) = o.k) AS fuel_amount,
             -- A SUFFIX match: "9803" inside "AS26C9803". Offered only when
             -- exactly one lorry in the master ends that way — two candidates
             -- would be a coin flip on a real trip, so the desk chooses.
             (SELECT count(*)::int FROM vehicles v
               WHERE v.vehicle_no_norm LIKE '%' || o.k)                    AS candidates,
             (SELECT min(v.vehicle_no) FROM vehicles v
               WHERE v.vehicle_no_norm LIKE '%' || o.k)                    AS suggested_vehicle_no,
             (SELECT min(v.id::text)::uuid FROM vehicles v
               WHERE v.vehicle_no_norm LIKE '%' || o.k)                    AS suggested_vehicle_id,
             (SELECT min(v.owner_name) FROM vehicles v
               WHERE v.vehicle_no_norm LIKE '%' || o.k)                    AS suggested_owner,
             (SELECT min(v.ownership::text) FROM vehicles v
               WHERE v.vehicle_no_norm LIKE '%' || o.k)                    AS suggested_ownership
        FROM orphan o
       ORDER BY o.trips DESC, o.expense DESC`);

    return {
      rows: rows.map((r) => ({
        ...r,
        advice: Number(r.candidates) === 1
          ? 'master me ek hi lorry is number par khatm hoti hai — confirm karke jod dijiye'
          : Number(r.candidates) > 1
            ? `master me ${r.candidates} lorry milti hain — khud chuniye`
            : 'master me koi lorry nahi milti — Vehicle Master me nayi banaiye',
      })),
      totals: {
        vehicles: rows.length,
        trips: rows.reduce((n, r) => n + Number(r.trips || 0), 0),
        expense: rows.reduce((n, r) => n + Number(r.expense || 0), 0),
        fuel_memos: rows.reduce((n, r) => n + Number(r.fuel_memos || 0), 0),
      },
    };
  });

  /** Which lorries in the master could this registration be? */
  app.get('/unmapped-vehicles/:reg/candidates', staff, async (req) => {
    const k = key(req.params.reg);
    const { rows } = await query(`
      SELECT id, vehicle_no, ownership::text AS ownership, owner_name, status::text AS status,
             (vehicle_no_norm LIKE '%' || $1) AS suffix_match
        FROM vehicles
       WHERE vehicle_no_norm LIKE '%' || $1 OR vehicle_no_norm LIKE $1 || '%'
       ORDER BY 6 DESC, vehicle_no LIMIT 20`, [k]);
    return { registration: k, candidates: rows };
  });

  /**
   * Point an unmapped registration at a real lorry.
   *
   * Trips and fuel memos move in ONE transaction. Splitting them would leave
   * diesel attached to a registration no trip carries any more: the trip's cost
   * would silently drop and the memo would become an orphan of its own.
   *
   * Settled memos move too, deliberately. Their money is already posted against
   * the pump; this changes only which lorry burned the diesel. The pump bill and
   * its voucher are not touched.
   */
  app.post('/unmapped-vehicles/resolve', admin, async (req, reply) => {
    const b = req.body ?? {};
    const from = key(b.from_vehicle_no);
    if (!from) return reply.code(400).send({ error: 'NO_SOURCE' });
    if (!UUID_RE.test(String(b.vehicle_id ?? ''))) {
      return reply.code(400).send({ error: 'BAD_VEHICLE', detail: 'kis lorry se jodna hai, wo chuniye' });
    }

    const { rows: v } = await query(
      `SELECT id, vehicle_no, ownership::text AS ownership, owner_name
         FROM vehicles WHERE id = $1::uuid`, [b.vehicle_id]);
    if (!v.length) return reply.code(404).send({ error: 'NO_SUCH_VEHICLE' });
    const target = v[0];

    // Refuse to move work onto a lorry that is itself unclassified — that would
    // trade one orphan for another.
    const { rows: [cls] } = await query('SELECT vehicle_class($1)::text c', [target.vehicle_no]);
    if (!cls?.c) {
      return reply.code(409).send({
        error: 'TARGET_UNCLASSIFIED',
        detail: `${target.vehicle_no} khud kisi master me nahi hai`,
      });
    }

    // A LOCKED settlement was signed against these trips. Moving them would
    // change a statement somebody approved, so the lock is respected and the
    // desk is told which one to reopen.
    const { rows: locked } = await query(`
      SELECT vehicle_no, cycle FROM vehicle_fortnight_settlements
       WHERE vehicle_key IN ($1, upper(regexp_replace($2,'[^A-Za-z0-9]','','g')))
         AND locked_at IS NOT NULL`, [from, target.vehicle_no]);
    if (locked.length) {
      return reply.code(409).send({
        error: 'SETTLEMENT_LOCKED',
        detail: `${locked.map((l) => `${l.vehicle_no} ${l.cycle}`).join(', ')} lock hai — `
              + 'pehle usse Reopen kijiye, tab yeh trip hilenge',
        locked,
      });
    }

    const out = await withTransaction(async (c) => {
      const { rows: trips } = await c.query(`
        UPDATE trips
           SET vehicle_no = $2, vehicle_id = $3::uuid, updated_at = now()
         WHERE upper(regexp_replace(vehicle_no,'[^A-Za-z0-9]','','g')) = $1
         RETURNING id, trip_code, COALESCE(unloading_date, loading_date) AS dt`,
        [from, target.vehicle_no, target.id]);

      const { rows: fuel } = await c.query(`
        UPDATE fuel_entries
           SET vehicle_no = $2, updated_at = now()
         WHERE upper(regexp_replace(vehicle_no,'[^A-Za-z0-9]','','g')) = $1
         RETURNING id, memo_no, amount`,
        [from, target.vehicle_no]);

      // The draft built under the old registration is now a statement for a
      // lorry with no trips. It is only a draft, so it goes and is rebuilt.
      const { rows: killed } = await c.query(`
        DELETE FROM vehicle_fortnight_settlements
         WHERE vehicle_key = $1 AND status = 'AI_DRAFT' AND locked_at IS NULL
         RETURNING period_from`, [from]);

      return { trips, fuel, killed };
    });

    if (!out.trips.length && !out.fuel.length) {
      return reply.code(404).send({ error: 'NOTHING_TO_MOVE', detail: `"${from}" par koi trip nahi mila` });
    }

    // Rebuild every fortnight the moved trips touch, so the target lorry's
    // draft picks them up straight away.
    const periods = [...new Set(out.trips.map((t) => ymd(t.dt)).filter(Boolean))];
    for (const p of periods) {
      await query('SELECT vehicle_fortnight_build($1::date, $2)', [p, actor(req)]);
    }

    return {
      resolved: true,
      from,
      to: { vehicle_no: target.vehicle_no, ownership: target.ownership, owner_name: target.owner_name },
      trips_moved: out.trips.length,
      trip_codes: out.trips.map((t) => t.trip_code),
      fuel_memos_moved: out.fuel.length,
      fuel_amount: out.fuel.reduce((n, f) => n + (Number(f.amount) || 0), 0),
      drafts_rebuilt: periods.length,
      note: `${out.trips.length} trip aur ${out.fuel.length} diesel memo ab ${target.vehicle_no} `
          + `(${target.ownership}) par hain. ${periods.length} fortnight ka draft dobara bana.`,
    };
  });
}
