// server/modules/commissionTerms.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// WHAT WE CHARGE AN ATTACHED OR MARKET LORRY, AND WHAT WE WITHHOLD.
//
// 16 of 49 lorries are ATTACHED — the family's: SANDEEP KUMAR PRASAD (11),
// GAUTAM PRASAD (3), SANTOSH PRASAD (1), PRASAD TRANSPORT (1) — and in one
// fortnight they carried Rs18,66,187 of Rs41,08,389. On those the freight is
// the owner's money; only our commission is income. Nothing in the database
// recorded that commission: vehicles.commission_pct and .commission_flat are
// NULL on all 49 rows. This is where it goes.
//
// TWO RULES THIS MODULE EXISTS TO ENFORCE.
//
//  1. A MISSING RATE IS NOT A RATE OF ZERO. Everything here leaves the
//     commission NULL when no term covers the period, and migration 159's
//     trigger refuses to approve such a settlement (P0410). Zero would be a
//     claim that we earned nothing on lakhs of freight, and it would post.
//
//  2. A TERM IS DATED, AND THE DATE IS THE DESK'S DECISION. A rate keyed in
//     today does not reach back over a fortnight worked in July — correctly,
//     but surprisingly. So `effective_from` is REQUIRED here rather than
//     defaulted, and the screen offers the start of the fortnight being
//     settled. A rate that silently failed to apply is worse than one refused.
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BASES = ['PCT', 'PER_TON', 'PER_KL', 'FLAT_TRIP'];
const key = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function registerCommissionTermsRoutes(app) {
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };
  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';

  // ═══ EVERY LORRY THAT NEEDS A TERM, AND WHETHER IT HAS ONE ══════════════
  app.get('/terms', staff, async (req) => {
    const { rows } = await query(`
      SELECT v.vehicle_no,
             v.vehicle_no_norm                       AS vehicle_key,
             v.ownership::text                       AS ownership,
             vehicle_class(v.vehicle_no)::text       AS fleet_class,
             v.owner_name,
             c.id AS term_id, c.basis, c.rate, c.tds_pct, c.tds_section,
             c.recover_expenses, c.effective_from, c.effective_to, c.note,
             (SELECT count(*)::int FROM trips t
               WHERE upper(regexp_replace(t.vehicle_no,'[^A-Za-z0-9]','','g')) = v.vehicle_no_norm
                 AND t.status='COMPLETED')            AS trips_ever,
             (SELECT COALESCE(sum(t.billed_amount),0)::numeric(14,2) FROM trips t
               WHERE upper(regexp_replace(t.vehicle_no,'[^A-Za-z0-9]','','g')) = v.vehicle_no_norm
                 AND t.status='COMPLETED')            AS freight_ever
        FROM vehicles v
        LEFT JOIN vehicle_commission_terms c
          ON c.vehicle_key = v.vehicle_no_norm AND c.effective_to IS NULL
       WHERE v.ownership = 'ATTACHED'
       UNION ALL
      SELECT m.registration_no,
             upper(regexp_replace(m.registration_no,'[^A-Za-z0-9]','','g')),
             'MARKET', 'MARKET', m.vendor_agency,
             c.id, c.basis, c.rate, c.tds_pct, c.tds_section,
             c.recover_expenses, c.effective_from, c.effective_to, c.note,
             0, 0
        FROM market_vehicles m
        LEFT JOIN vehicle_commission_terms c
          ON c.vehicle_key = upper(regexp_replace(m.registration_no,'[^A-Za-z0-9]','','g'))
         AND c.effective_to IS NULL
       ORDER BY 12 DESC NULLS FIRST, 5, 1`);

    return {
      rows,
      totals: {
        vehicles: rows.length,
        with_rate: rows.filter((r) => r.term_id).length,
        without_rate: rows.filter((r) => !r.term_id).length,
        freight_at_risk: rows.filter((r) => !r.term_id)
          .reduce((n, r) => n + (Number(r.freight_ever) || 0), 0),
      },
    };
  });

  /** The history behind one lorry's rate — what was charged, and when. */
  app.get('/terms/:vehicleKey/history', staff, async (req) => {
    const { rows } = await query(
      `SELECT * FROM vehicle_commission_terms WHERE vehicle_key = $1
        ORDER BY effective_from DESC`, [key(req.params.vehicleKey)]);
    return { terms: rows };
  });

  // ═══ RECORD A TERM ══════════════════════════════════════════════════════
  //
  // Admin only: this decides how much of every attached lorry's freight is our
  // income, so it moves more money than most postings do.
  //
  // A new term CLOSES the open one the day before it starts, rather than
  // replacing it. The old fortnight keeps the rate it was worked under, which
  // is the whole reason these rows are dated.
  app.post('/terms', admin, async (req, reply) => {
    const b = req.body ?? {};
    const vKey = key(b.vehicle_key ?? b.vehicle_no);
    if (!vKey) return reply.code(400).send({ error: 'NO_VEHICLE' });
    if (!BASES.includes(b.basis)) {
      return reply.code(400).send({ error: 'BAD_BASIS', detail: `basis must be one of ${BASES.join(', ')}` });
    }
    const rate = Number(b.rate);
    if (!Number.isFinite(rate) || rate < 0) return reply.code(400).send({ error: 'BAD_RATE' });
    if (b.basis === 'PCT' && rate > 100) {
      return reply.code(400).send({ error: 'BAD_RATE', detail: 'a percentage over 100 is not a commission' });
    }
    const tds = Number(b.tds_pct ?? 0);
    if (!Number.isFinite(tds) || tds < 0 || tds > 100) return reply.code(400).send({ error: 'BAD_TDS' });
    // Required, not defaulted. See the header.
    if (!DATE_RE.test(String(b.effective_from ?? ''))) {
      return reply.code(400).send({
        error: 'NO_EFFECTIVE_FROM',
        detail: 'kis tareekh se yeh rate lagega — batana zaroori hai, warna purane fortnight par nahi lagega',
      });
    }

    let term;
    try {
      // withTransaction, not query('BEGIN'): the pool hands out a different
      // connection per call, so a bare BEGIN would open a transaction on one
      // connection and COMMIT on another — leaving the close half applied.
      term = await withTransaction(async (c) => {
        // Close whatever is open, the day before this one starts.
        await c.query(`
          UPDATE vehicle_commission_terms
             SET effective_to = ($2::date - 1), updated_at = now()
           WHERE vehicle_key = $1 AND effective_to IS NULL
             AND effective_from < $2::date`, [vKey, b.effective_from]);
        // An open term starting on or after the new one would leave two live
        // rows with no sensible ordering between them, so it is refused rather
        // than silently picked between.
        const { rows: clash } = await c.query(
          `SELECT id, effective_from FROM vehicle_commission_terms
            WHERE vehicle_key = $1 AND effective_to IS NULL`, [vKey]);
        if (clash.length) {
          throw Object.assign(new Error(
            `is lorry ka ek term pehle se ${clash[0].effective_from} se khula hai`),
            { code: 'TERM_CLASH' });
        }
        const { rows } = await c.query(`
          INSERT INTO vehicle_commission_terms
            (vehicle_key, vehicle_no, basis, rate, tds_pct, tds_section, recover_expenses,
             owner_name, owner_ledger_id, effective_from, note, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid,$10::date,$11,$12)
          RETURNING *`,
          [vKey, b.vehicle_no ?? null, b.basis, rate, tds, b.tds_section ?? '194C',
           b.recover_expenses !== false,
           b.owner_name ?? null, UUID_RE.test(String(b.owner_ledger_id ?? '')) ? b.owner_ledger_id : null,
           b.effective_from, b.note ?? null, actor(req)]);
        return rows[0];
      });

      // Any AI draft already built for a covered fortnight is stale the moment
      // a rate lands. Rebuilding here means the desk sees the commission
      // immediately instead of wondering why nothing changed.
      const { rows: refreshed } = await query(`
        SELECT DISTINCT period_from FROM vehicle_fortnight_settlements
         WHERE vehicle_key = $1 AND status = 'AI_DRAFT' AND locked_at IS NULL
           AND period_to >= $2::date`, [vKey, b.effective_from]);

      for (const r of refreshed) {
        await query('SELECT vehicle_fortnight_build($1::date, $2)', [r.period_from, actor(req)]);
      }

      return { saved: true, term, drafts_refreshed: refreshed.length };
    } catch (e) {
      if (e.code === 'TERM_CLASH' || e.code === '23505') {
        return reply.code(409).send({ error: 'TERM_CLASH', detail: e.message });
      }
      return reply.code(422).send({ error: e.code ?? 'SAVE_FAILED', detail: e.message });
    }
  });

  /** Correct a term that has not priced anything yet, or add a note to one. */
  app.patch('/terms/:id', admin, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {};

    // A term that a LOCKED settlement was priced from is history. Editing it
    // would change a statement someone has already signed.
    const { rows: used } = await query(`
      SELECT count(*)::int n FROM vehicle_fortnight_settlements
       WHERE terms_id = $1::uuid AND locked_at IS NOT NULL`, [id]);
    if (used[0].n > 0) {
      return reply.code(409).send({
        error: 'TERM_IN_USE',
        detail: `${used[0].n} settlement is term par lock ho chuke hain — naya term banaiye, purana mat badliye`,
      });
    }

    const sets = []; const args = [id];
    if (BASES.includes(b.basis)) { args.push(b.basis); sets.push(`basis = $${args.length}`); }
    if (Number.isFinite(Number(b.rate))) { args.push(Number(b.rate)); sets.push(`rate = $${args.length}`); }
    if (Number.isFinite(Number(b.tds_pct))) { args.push(Number(b.tds_pct)); sets.push(`tds_pct = $${args.length}`); }
    if (typeof b.recover_expenses === 'boolean') {
      args.push(b.recover_expenses); sets.push(`recover_expenses = $${args.length}`);
    }
    if (DATE_RE.test(String(b.effective_from ?? ''))) {
      args.push(b.effective_from); sets.push(`effective_from = $${args.length}::date`);
    }
    if (typeof b.note === 'string') { args.push(b.note.slice(0, 500)); sets.push(`note = $${args.length}`); }
    if (!sets.length) return reply.code(400).send({ error: 'NOTHING_TO_SAVE' });

    const { rows } = await query(
      `UPDATE vehicle_commission_terms SET ${sets.join(', ')} WHERE id = $1::uuid RETURNING *`, args);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });

    const { rows: drafts } = await query(`
      SELECT DISTINCT period_from FROM vehicle_fortnight_settlements
       WHERE terms_id = $1::uuid AND status = 'AI_DRAFT' AND locked_at IS NULL`, [id]);
    for (const d of drafts) {
      await query('SELECT vehicle_fortnight_build($1::date, $2)', [d.period_from, actor(req)]);
    }
    return { saved: true, term: rows[0], drafts_refreshed: drafts.length };
  });

  /** Close a term without opening a new one — the arrangement has ended. */
  app.post('/terms/:id/close', admin, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const on = DATE_RE.test(String(req.body?.effective_to ?? ''))
      ? req.body.effective_to : new Date().toISOString().slice(0, 10);
    const { rows } = await query(`
      UPDATE vehicle_commission_terms SET effective_to = $2::date, updated_at = now()
       WHERE id = $1::uuid AND effective_to IS NULL AND effective_from <= $2::date
       RETURNING *`, [id, on]);
    if (!rows.length) {
      return reply.code(409).send({
        error: 'CANNOT_CLOSE',
        detail: 'term pehle se band hai, ya band karne ki tareekh shuru hone se pehle ki hai',
      });
    }
    return { closed: true, term: rows[0] };
  });

  // ═══ ONE OWNER, EVERY LORRY THEY RUN FOR US ═════════════════════════════
  //
  // "Agar kisi vehicle ka owner ka attached/market ka max vehicle ho to ek
  // report me har vehicle ka report aa jaye" — the IOCL grouping, one level up:
  // owner, then lorry, then the money.
  app.get('/owner-statement', staff, async (req, reply) => {
    const q = req.query ?? {};
    if (!DATE_RE.test(String(q.period_from ?? ''))) {
      return reply.code(400).send({ error: 'BAD_PERIOD' });
    }
    const owner = String(q.owner ?? '').trim();

    const { rows: heads } = await query(`
      SELECT * FROM v_owner_fortnight_statement
       WHERE period_from = $1::date AND ($2 = '' OR owner_name = $2)
       ORDER BY freight DESC NULLS LAST`, [q.period_from, owner]);

    const { rows: lorries } = await query(`
      SELECT COALESCE(c.owner_name,'(owner darj nahi)') AS owner_name,
             c.vehicle_key, c.vehicle_no, c.fleet_class::text AS fleet_class,
             c.trips_count, c.loaded_qty, c.rtkm,
             c.billed_amount, c.expense_total,
             c.basis AS commission_basis, c.rate AS commission_rate,
             c.commission_amount, c.tds_pct, c.tds_amount,
             c.expenses_recovered, c.payable_to_owner, c.our_earning, c.needs_rate,
             s.id AS settlement_id, s.status, s.locked_at
        FROM v_vehicle_fortnight_class c
        LEFT JOIN vehicle_fortnight_settlements s
          ON s.vehicle_key = c.vehicle_key AND s.period_from = c.period_from
       WHERE c.period_from = $1::date
         AND c.fleet_class IN ('ATTACHED','MARKET')
         AND ($2 = '' OR COALESCE(c.owner_name,'(owner darj nahi)') = $2)
       ORDER BY 1, c.billed_amount DESC`, [q.period_from, owner]);

    const byOwner = new Map();
    for (const h of heads) byOwner.set(h.owner_name, { ...h, vehicles: [] });
    for (const l of lorries) byOwner.get(l.owner_name)?.vehicles.push(l);

    const { rows: [meta] } = await query(
      `SELECT fortnight_label($1::date) label, fortnight_to($1::date) period_to`, [q.period_from]);

    const n = (k) => heads.reduce((a, h) => a + (Number(h[k]) || 0), 0);
    const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

    return {
      period: { from: q.period_from, to: meta?.period_to, label: meta?.label },
      owners: [...byOwner.values()],
      grand: {
        owners: heads.length,
        lorries: heads.reduce((a, h) => a + (Number(h.lorries) || 0), 0),
        trips: heads.reduce((a, h) => a + (Number(h.trips) || 0), 0),
        freight: r2(n('freight')), expenses: r2(n('expenses')),
        commission: r2(n('commission')), tds: r2(n('tds')),
        recovered: r2(n('recovered')), payable: r2(n('payable')),
        our_earning: r2(n('our_earning')),
        without_rate: heads.reduce((a, h) => a + (Number(h.without_rate) || 0), 0),
      },
    };
  });
}
