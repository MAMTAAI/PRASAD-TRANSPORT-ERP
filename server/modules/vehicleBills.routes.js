// server/modules/vehicleBills.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// THE 15-DAY VEHICLE BILL, PER OWNER — list, open, edit, approve, lock, send.
//
// Owner, 5-Sep-2026: expense columns on the LEFT (HSD, Toll Tax, Trip Fooding
// Allowance, Trip Fixed Allowance, Trip Advance, Doc Exp, Other Exp), the IOCL
// bill details with Commission and TDS on the RIGHT, one bill per owner per
// fortnight, and at approval: Edit / Save / Modify / Print / WhatsApp / Email /
// Approve. After approve the bill is final and the money is in the owner's
// khata.
//
// Maker-checker as in vehicleSettlement.routes.js: any staff edits and saves,
// only an admin approves or reopens. Migration 160 holds the two gates a
// screen cannot: a lorry without a commission rate blocks the bill (P0412),
// and a locked bill refuses every edit but a reasoned reopen (P0411).
//
// WHAT APPROVE POSTS. One journal per owner bill:
//   Dr Attached Vehicle Freight Control        freight (+ manual income)
//   Cr Commission Income - Attached Vehicles   our commission
//   Cr TDS Payable (194C)                      withheld on the owner's share
//   Cr Vehicle Expense Recovery                diesel + tolls + advances + typed expenses
//   Cr Vehicle Owner: <name>                   what they are owed
// The freight and the diesel already reached the books through billing and the
// pump bill; this journal moves the owner's share out of ours. On an OWN-fleet
// statement only the manual adjustments post (migration 158's reasoning).
//
// RE-APPROVE AFTER MODIFY posts the DIFFERENCE against what was posted before,
// under a _R2 / _R3 reference. The first voucher is never rewritten.
// ─────────────────────────────────────────────────────────────────────────────
import { postVoucher } from '../agents/tara.js';
import { query, withTransaction } from '../db/pool.js';
import { requireAuth, requireAdminRole } from './auth.routes.js';
import { send as sendMail } from '../lib/mailChannel.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['FOODING_ALLOWANCE', 'FIXED_ALLOWANCE', 'DOC_EXPENSE', 'OTHER_EXPENSE'];
const r2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => Number(v) || 0;
const clamp = (v, d, max) => Math.min(Math.max(1, Number(v) || d), max);
const isoDate = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d ?? '').slice(0, 10));

/** Money as a reviewer typed it: a number, or nothing at all. */
function money(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? r2(n) : null;
}

const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ── the journal, said once ──────────────────────────────────────────────────
export function journalFor(b) {
  const lines = [];
  const push = (ledger, dr_cr, amount, group) => {
    if (r2(amount) > 0) lines.push({ ledger, dr_cr, amount: r2(amount), group });
  };
  const agency = ['ATTACHED', 'MARKET'].includes(b.class_key);
  if (agency) {
    const freight = r2(num(b.freight) + num(b.adj_income));
    const comm = r2(num(b.commission));
    const tds = r2(num(b.tds));
    const rec = r2(num(b.recovered) + num(b.adj_expense));
    const payable = r2(freight - comm - tds - rec);
    push('Attached Vehicle Freight Control', 'DR', freight, 'Current Liabilities');
    push('Commission Income - Attached Vehicles', 'CR', comm, 'Direct Income');
    push('TDS Payable (194C)', 'CR', tds, 'Duties & Taxes');
    push('Vehicle Expense Recovery', 'CR', rec, 'Direct Expenses - Vehicle Operations');
    if (payable >= 0) push(`Vehicle Owner: ${b.owner_name}`, 'CR', payable, 'Sundry Creditors (Vehicle Owners)');
    else push(`Vehicle Owner: ${b.owner_name}`, 'DR', -payable, 'Sundry Creditors (Vehicle Owners)');
    return { agency: true, lines, freight, commission: comm, tds, recovered: rec, payable };
  }
  // OWN fleet, or a lorry in no master: the freight and the diesel post through
  // their own flows; only what a reviewer keyed by hand exists nowhere else.
  const adjE = r2(num(b.adj_expense));
  const adjI = r2(num(b.adj_income));
  push('Direct Expenses - Vehicle Operations', 'DR', adjE, 'Direct Expenses - Vehicle Operations');
  push('Freight & Trip Income', 'CR', adjI, 'Direct Income');
  const diff = r2(adjE - adjI);
  if (diff > 0) push('Vehicle Settlement Control', 'CR', diff, 'Current Liabilities');
  else if (diff < 0) push('Vehicle Settlement Control', 'DR', -diff, 'Current Liabilities');
  return { agency: false, lines, payable: null, adj_income: adjI, adj_expense: adjE };
}

/** The difference between two balanced journals — itself balanced. */
export function deltaLines(before, after) {
  const signed = new Map();
  const groups = new Map();
  const add = (l, sign) => {
    const v = (l.dr_cr === 'DR' ? 1 : -1) * num(l.amount) * sign;
    signed.set(l.ledger, r2((signed.get(l.ledger) ?? 0) + v));
    if (l.group) groups.set(l.ledger, l.group);
  };
  for (const l of before ?? []) add(l, -1);
  for (const l of after ?? []) add(l, 1);
  const out = [];
  for (const [ledger, v] of signed) {
    if (Math.abs(v) < 0.005) continue;
    out.push({ ledger, dr_cr: v > 0 ? 'DR' : 'CR', amount: r2(Math.abs(v)), group: groups.get(ledger) ?? null });
  }
  return out;
}

/** The bill as a WhatsApp / e-mail text. */
function billText(b, lorries) {
  const NL = String.fromCharCode(10);
  const agency = ['ATTACHED', 'MARKET'].includes(b.class_key);
  const L = [
    `*${b.owner_name}* — 15-din ka vehicle bill`,
    `${b.bill_no} · ${b.cycle_label} (${isoDate(b.period_from)} se ${isoDate(b.period_to)})`,
    `${b.lorries} lorry · ${b.trips} trip · ${Number(b.loaded_qty || 0).toFixed(3)} KL`,
    '',
  ];
  for (const v of lorries) {
    const kh = num(v.bill_expense);
    L.push(`🚛 ${v.vehicle_no} — ${v.trips_count} trip · freight ${inr(v.billed_amount)} · kharch ${inr(kh)}`
      + (agency && v.commission_amount !== null ? ` · comm ${inr(v.commission_amount)}` : '')
      + (v.needs_rate ? ' · ⚠️ rate nahi' : ''));
  }
  L.push('');
  L.push(`Freight: ${inr(b.freight)}`);
  if (num(b.adj_income)) L.push(`+ Anya aay: ${inr(b.adj_income)}`);
  L.push(`HSD ${inr(b.hsd)} · Toll ${inr(b.toll)} · Fooding ${inr(b.fooding)} · Fixed ${inr(b.fixed_allowance)}`);
  L.push(`Advance ${inr(b.advances)} · Doc ${inr(b.doc_expense)} · Anya ${inr(b.other_expense)}`);
  if (num(b.adj_expense)) L.push(`+ Manual kharch: ${inr(b.adj_expense)}`);
  L.push(`*Kul kharch: ${inr(b.deductions)}*`);
  if (agency) {
    L.push('');
    L.push(`Commission: ${b.commission === null ? 'rate darj nahi' : inr(b.commission)}`);
    L.push(`TDS 194C: ${b.tds === null ? '—' : inr(b.tds)}`);
    L.push(`*Owner ko dena: ${b.payable === null ? 'rate ke baad' : inr(b.payable)}*`);
  } else {
    const net = num(b.freight) + num(b.adj_income) - num(b.deductions);
    L.push('');
    L.push(`*${net >= 0 ? 'Munafa' : 'Ghata'}: ${inr(Math.abs(net))}*`);
  }
  L.push('');
  L.push(b.status === 'APPROVED' ? `✅ Approved — ${b.approved_by}`
    : b.status === 'STAFF_REVIEWED' ? '📝 Staff ne dekh liya, approval baaki'
    : '🤖 AI draft — abhi kisi ne dekha nahi');
  return L.join(NL);
}

export async function registerVehicleBillRoutes(app) {
  const staff = { preHandler: requireAuth };
  const admin = { preHandler: requireAdminRole };
  const actor = (req) => req.user?.name ?? req.user?.sub ?? 'desk';

  const billById = async (id) =>
    (await query('SELECT * FROM v_vehicle_owner_bill WHERE id = $1::uuid', [id])).rows[0] ?? null;
  const lorriesOf = async (id) =>
    (await query(`
      SELECT * FROM v_vehicle_settlement
       WHERE owner_bill_id = $1::uuid
       ORDER BY billed_amount DESC, vehicle_no`, [id])).rows;

  // ═══ THE LIST — bills, owner cards, the fortnights ══════════════════════
  app.get('/', staff, async (req) => {
    const q = req.query ?? {};
    const from = DATE_RE.test(String(q.period_from ?? '')) ? q.period_from : null;
    const status = ['AI_DRAFT', 'STAFF_REVIEWED', 'APPROVED'].includes(q.status) ? q.status : null;
    const cls = q.class === 'OWN' ? 'OWN' : q.class === 'AGENCY' ? 'AGENCY' : null;
    const owner = String(q.owner ?? '').trim() || null;
    const limit = clamp(q.limit, 200, 500);

    const { rows } = await query(`
      SELECT * FROM v_vehicle_owner_bill b
       WHERE ($1::date IS NULL OR b.period_from = $1::date)
         AND ($2::text IS NULL OR b.status = $2::text)
         AND ($3::text IS NULL
              OR ($3 = 'OWN' AND b.class_key NOT IN ('ATTACHED','MARKET'))
              OR ($3 = 'AGENCY' AND b.class_key IN ('ATTACHED','MARKET')))
         AND ($4::text IS NULL OR b.owner_name ILIKE '%' || $4 || '%' OR b.bill_no ILIKE '%' || $4 || '%')
       ORDER BY b.period_from DESC,
                CASE WHEN b.class_key IN ('ATTACHED','MARKET') THEN 0 ELSE 1 END,
                b.freight DESC
       LIMIT $5`, [from, status, cls, owner, limit]);

    // One card per owner: what they are owed on approved bills, what is still
    // in draft, and whether a rate is missing anywhere.
    const { rows: cards } = await query(`
      SELECT owner_key, class_key, min(owner_name) AS owner_name,
             count(*)::int AS bills,
             count(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
             COALESCE(sum(payable) FILTER (WHERE status = 'APPROVED'), 0)::numeric(14,2) AS approved_payable,
             COALESCE(sum(payable) FILTER (WHERE status <> 'APPROVED'), 0)::numeric(14,2) AS pending_payable,
             COALESCE(sum(freight), 0)::numeric(14,2) AS freight,
             COALESCE(sum(our_earning), 0)::numeric(14,2) AS our_earning,
             COALESCE(sum(needs_rate), 0)::int AS needs_rate,
             max(period_from) AS latest
        FROM vehicle_owner_bills
       GROUP BY owner_key, class_key
       ORDER BY CASE WHEN class_key IN ('ATTACHED','MARKET') THEN 0 ELSE 1 END,
                approved_payable DESC, pending_payable DESC`);

    const { rows: cycles } = await query(`
      SELECT period_from, period_to, cycle, fortnight_label(period_from) AS cycle_label,
             count(*)::int AS bills,
             count(*) FILTER (WHERE status = 'AI_DRAFT')::int AS drafts,
             count(*) FILTER (WHERE status = 'STAFF_REVIEWED')::int AS reviewed,
             count(*) FILTER (WHERE status = 'APPROVED')::int AS approved,
             COALESCE(sum(freight), 0)::numeric(14,2) AS freight,
             COALESCE(sum(payable), 0)::numeric(14,2) AS payable,
             COALESCE(sum(needs_rate), 0)::int AS needs_rate
        FROM vehicle_owner_bills
       GROUP BY period_from, period_to, cycle
       ORDER BY period_from DESC
       LIMIT 40`);

    const sum = (k) => r2(rows.reduce((a, r) => a + num(r[k]), 0));
    return {
      rows, cards, cycles,
      totals: {
        bills: rows.length,
        lorries: rows.reduce((a, r) => a + num(r.lorries), 0),
        trips: rows.reduce((a, r) => a + num(r.trips), 0),
        freight: sum('freight'), deductions: sum('deductions'),
        commission: sum('commission'), tds: sum('tds'), payable: sum('payable'),
        drafts: rows.filter((r) => r.status === 'AI_DRAFT').length,
        reviewed: rows.filter((r) => r.status === 'STAFF_REVIEWED').length,
        approved: rows.filter((r) => r.status === 'APPROVED').length,
        needs_rate: rows.reduce((a, r) => a + num(r.needs_rate), 0),
      },
    };
  });

  // ═══ BUILD ONE FORTNIGHT (or a range) ═══════════════════════════════════
  app.post('/build', staff, async (req, reply) => {
    const b = req.body ?? {};
    if (!DATE_RE.test(String(b.period_from ?? ''))) {
      return reply.code(400).send({ error: 'BAD_PERIOD', detail: 'period_from must be YYYY-MM-DD' });
    }
    const { rows: [out] } = await query(
      'SELECT * FROM vehicle_fortnight_build($1::date, $2)', [b.period_from, actor(req)]);
    const { rows: [bills] } = await query(`
      SELECT count(*)::int AS bills, COALESCE(sum(needs_rate),0)::int AS needs_rate
        FROM vehicle_owner_bills WHERE period_from = fortnight_from($1::date)`, [b.period_from]);
    return { built: true, ...out, ...bills };
  });

  // The historical run: every fortnight from `from` to `to`. Admin, because it
  // touches months of drafts at once — though never a reviewed or locked one.
  app.post('/build-range', admin, async (req, reply) => {
    const b = req.body ?? {};
    if (!DATE_RE.test(String(b.from ?? '')) || !DATE_RE.test(String(b.to ?? ''))) {
      return reply.code(400).send({ error: 'BAD_RANGE', detail: 'from and to must be YYYY-MM-DD' });
    }
    const { rows: periods } = await query(`
      SELECT DISTINCT fortnight_from(d::date) AS f
        FROM generate_series($1::date, $2::date, interval '1 day') d
       ORDER BY 1`, [b.from, b.to]);
    const results = [];
    for (const p of periods) {
      const f = isoDate(p.f);
      const { rows: [out] } = await query('SELECT * FROM vehicle_fortnight_build($1::date, $2)', [f, actor(req)]);
      const { rows: [bills] } = await query(
        `SELECT count(*)::int AS bills, COALESCE(sum(needs_rate),0)::int AS needs_rate
           FROM vehicle_owner_bills WHERE period_from = $1::date`, [f]);
      results.push({ period_from: f, ...out, ...bills });
    }
    return { built: true, periods: results };
  });

  // ═══ ONE BILL, IN FULL ══════════════════════════════════════════════════
  app.get('/:id', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const bill = await billById(id);
    if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
    const lorries = await lorriesOf(id);

    // The typed-in entries under every trip on this bill, so a reviewer can
    // see what was keyed (and by whom) and remove a wrong one.
    const { rows: entries } = await query(`
      SELECT e.id, e.trip_id, e.kind, e.amount, e.label, e.dated, e.source, e.entered_by, e.created_at
        FROM trip_expense_entries e
       WHERE e.trip_id IN (
         SELECT (l->>'trip_id')::uuid
           FROM vehicle_fortnight_settlements s, jsonb_array_elements(s.lines) l
          WHERE s.owner_bill_id = $1::uuid)
       ORDER BY e.created_at`, [id]);

    return {
      bill,
      lorries: lorries.map((v) => ({
        ...v,
        stale: v.live_trips !== null && (num(v.live_trips) !== num(v.trips_count)
                                        || num(v.live_billed) !== num(v.billed_amount)),
      })),
      entries,
      journal: journalFor(bill),
      posted_lines: bill.posted_lines ?? [],
    };
  });

  // ═══ THE MAKER SAVES ════════════════════════════════════════════════════
  //
  // Nothing posts here. A typed expense goes into trip_expense_entries WITH
  // the trip id — the bill is only where it was keyed — and the lorry and the
  // bill are recomputed from the register, never edited in place.
  app.patch('/:id', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const b = req.body ?? {};
    const bill = await billById(id);
    if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (bill.locked_at) {
      return reply.code(409).send({ error: 'LOCKED', detail: 'Yeh bill approve ho chuka hai. Pehle "Modify" kijiye.' });
    }
    const who = actor(req);

    // Which trips belong to this bill — an entry for any other trip is refused.
    const { rows: tripRows } = await query(`
      SELECT (l->>'trip_id')::uuid AS trip_id, s.id AS settlement_id, s.vehicle_no
        FROM vehicle_fortnight_settlements s, jsonb_array_elements(s.lines) l
       WHERE s.owner_bill_id = $1::uuid AND s.locked_at IS NULL`, [id]);
    const tripToSettlement = new Map(tripRows.map((r) => [r.trip_id, r]));
    const touched = new Set();

    const entries = Array.isArray(b.entries) ? b.entries : [];
    const removes = Array.isArray(b.remove_entry_ids) ? b.remove_entry_ids : [];
    const lorries = Array.isArray(b.lorries) ? b.lorries : [];
    if (!entries.length && !removes.length && !lorries.length && typeof b.notes !== 'string') {
      return reply.code(400).send({ error: 'NOTHING_TO_SAVE' });
    }

    try {
      await withTransaction(async (t) => {
        for (const e of entries) {
          const tripId = String(e?.trip_id ?? '');
          const s = tripToSettlement.get(tripId);
          if (!s) throw Object.assign(new Error(`trip ${tripId} is not on this bill`), { code: 'TRIP_NOT_ON_BILL' });
          if (!KINDS.includes(e?.kind)) throw Object.assign(new Error(`bad kind ${e?.kind}`), { code: 'BAD_KIND' });
          const amt = money(e?.amount);
          if (amt === null || amt < 0) throw Object.assign(new Error('amount must be a number ≥ 0'), { code: 'BAD_AMOUNT' });
          if (amt === 0) continue;
          const label = String(e?.label ?? '').slice(0, 160).trim() || null;
          if (e.kind === 'OTHER_EXPENSE' && !label) {
            throw Object.assign(new Error('Other expense needs a name'), { code: 'LABEL_REQUIRED' });
          }
          const dated = DATE_RE.test(String(e?.dated ?? '')) ? e.dated : null;
          await t.query(`
            INSERT INTO trip_expense_entries (trip_id, vehicle_no, kind, amount, label, dated, source, entered_by)
            VALUES ($1::uuid, $2, $3, $4, $5, COALESCE($6::date, current_date), 'BILL_DESK', $7)`,
            [tripId, s.vehicle_no, e.kind, amt, label, dated, who]);
          touched.add(s.settlement_id);
        }
        for (const rid of removes) {
          if (!UUID_RE.test(String(rid))) continue;
          const { rows } = await t.query(`
            DELETE FROM trip_expense_entries e
             WHERE e.id = $1::uuid
               AND e.trip_id = ANY($2::uuid[])
             RETURNING e.trip_id`, [rid, [...tripToSettlement.keys()]]);
          for (const r of rows) touched.add(tripToSettlement.get(r.trip_id)?.settlement_id);
        }
        for (const l of lorries) {
          const sid = String(l?.id ?? '');
          if (!UUID_RE.test(sid)) continue;
          // $1 = the lorry settlement, $2 = this bill — a row from another
          // bill cannot be reached through this route.
          const sets = []; const args = [sid, id];
          if (Array.isArray(l.adjustments)) {
            const adj = l.adjustments.map((a) => ({
              label: String(a?.label ?? '').slice(0, 120).trim(),
              amount: money(a?.amount) ?? 0,
              side: a?.side === 'INCOME' ? 'INCOME' : 'EXPENSE',
              added_by: a?.added_by ?? who,
              added_at: a?.added_at ?? new Date().toISOString(),
            })).filter((a) => a.label && a.amount !== 0);
            args.push(JSON.stringify(adj)); sets.push(`adjustments = $${args.length}::jsonb`);
          }
          if (typeof l.notes === 'string') { args.push(l.notes.slice(0, 2000)); sets.push(`notes = $${args.length}`); }
          if (!sets.length) continue;
          args.push(who);
          sets.push(`reviewed_by = $${args.length}`, 'reviewed_at = now()',
                    `status = CASE WHEN status = 'AI_DRAFT' THEN 'STAFF_REVIEWED' ELSE status END`);
          await t.query(`UPDATE vehicle_fortnight_settlements SET ${sets.join(', ')}
                          WHERE id = $1::uuid AND owner_bill_id = $2::uuid AND locked_at IS NULL`, args);
          touched.add(sid);
        }
        // Recompute every lorry whose register moved, and the bill's foot.
        for (const sid of touched) {
          if (!sid) continue;
          await t.query('SELECT vehicle_settlement_refresh($1::uuid)', [sid]);
          await t.query(`UPDATE vehicle_fortnight_settlements
                            SET reviewed_by = $2, reviewed_at = now(),
                                status = CASE WHEN status = 'AI_DRAFT' THEN 'STAFF_REVIEWED' ELSE status END
                          WHERE id = $1::uuid AND locked_at IS NULL`, [sid, who]);
        }
        await t.query('SELECT vehicle_owner_bill_refresh($1::uuid)', [id]);
        await t.query(`
          UPDATE vehicle_owner_bills
             SET reviewed_by = $2, reviewed_at = now(),
                 notes = COALESCE($3, notes),
                 status = CASE WHEN status = 'AI_DRAFT' THEN 'STAFF_REVIEWED' ELSE status END
           WHERE id = $1::uuid AND locked_at IS NULL`,
          [id, who, typeof b.notes === 'string' ? b.notes.slice(0, 2000) : null]);
      });
    } catch (e) {
      const known = ['TRIP_NOT_ON_BILL', 'BAD_KIND', 'BAD_AMOUNT', 'LABEL_REQUIRED'];
      if (known.includes(e.code)) return reply.code(400).send({ error: e.code, detail: e.message });
      if (e.code === 'P0405') return reply.code(409).send({ error: 'TRIP_VEHICLE_MISMATCH', detail: e.message });
      if (e.code === '23514') return reply.code(400).send({ error: 'LABEL_REQUIRED', detail: 'Other expense needs a name' });
      throw e;
    }

    return { saved: true, bill: await billById(id), lorries: await lorriesOf(id) };
  });

  // ═══ THE CHECKER APPROVES — posts to the owner's khata and locks ════════
  app.post('/:id/approve', admin, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    let bill = await billById(id);
    if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (bill.locked_at) return reply.code(409).send({ error: 'ALREADY_APPROVED', bill });

    // The foot is recomputed from the lorries right before signing, so a trip
    // that landed since the draft cannot be signed at the old figure.
    await query('SELECT vehicle_owner_bill_refresh($1::uuid)', [id]);
    bill = await billById(id);
    if (num(bill.needs_rate) > 0) {
      const { rows: missing } = await query(`
        SELECT vehicle_no FROM vehicle_fortnight_settlements
         WHERE owner_bill_id = $1::uuid AND fleet_class IN ('ATTACHED','MARKET') AND commission_amount IS NULL`, [id]);
      return reply.code(409).send({
        error: 'NO_COMMISSION_RATE',
        detail: `${missing.map((m) => m.vehicle_no).join(', ')} — commission rate darj nahi hai; `
              + 'Commission Master me 1 Apr 2026 se rate bhariye, tab approve hoga.',
        vehicles: missing.map((m) => m.vehicle_no),
      });
    }

    const journal = journalFor(bill);
    const previously = Array.isArray(bill.posted_lines) ? bill.posted_lines : [];
    const n = num(bill.post_count);
    const lines = n > 0 ? deltaLines(previously, journal.lines) : journal.lines;
    const ref = `VEHBILL_${bill.bill_no}` + (n > 0 ? `_R${n + 1}` : '');

    let voucher = null;
    if (lines.length) {
      const narration = journal.agency
        ? `15-din vehicle bill ${bill.bill_no} — ${bill.owner_name}, ${bill.cycle_label}. `
          + `Freight ${inr(journal.freight)}, commission ${inr(journal.commission)}, TDS ${inr(journal.tds)}, `
          + `kharch wapas ${inr(journal.recovered)}, owner ko ${inr(journal.payable)}.`
          + (n > 0 ? ` (revision ${n + 1}: antar posted)` : '')
        : `15-din vehicle statement ${bill.bill_no} — ${bill.owner_name}, ${bill.cycle_label} `
          + '(manual adjustments only; freight and HSD post through their own flows)';
      try {
        voucher = await postVoucher({
          type: 'JOURNAL',
          source_type: 'VEHICLE_OWNER_BILL',
          company_id: bill.company_id ?? null,
          ref_no: ref,
          entry_date: isoDate(bill.period_to),
          narration,
          lines,
        });
      } catch (e) {
        if (e.code === 'DUPLICATE_REF') return reply.code(409).send({ error: 'ALREADY_POSTED', detail: e.message });
        return reply.code(422).send({ error: e.code ?? 'POSTING_FAILED', detail: e.message });
      }
    }

    const who = actor(req);
    try {
      await withTransaction(async (t) => {
        await t.query(`
          UPDATE vehicle_fortnight_settlements
             SET status = 'APPROVED', approved_by = $2, approved_at = now(),
                 voucher_id = COALESCE($3::uuid, voucher_id), locked_at = now(), locked_by = $2
           WHERE owner_bill_id = $1::uuid AND locked_at IS NULL`, [id, who, voucher?.voucher_id ?? null]);
        await t.query(`
          UPDATE vehicle_owner_bills
             SET status = 'APPROVED', approved_by = $2, approved_at = now(),
                 locked_at = now(), locked_by = $2,
                 voucher_id = COALESCE($3::uuid, voucher_id),
                 voucher_ids = CASE WHEN $3::uuid IS NULL THEN voucher_ids
                                    ELSE voucher_ids || to_jsonb($3::text) END,
                 post_count = CASE WHEN $3::uuid IS NULL THEN post_count ELSE post_count + 1 END,
                 posted_lines = CASE WHEN $3::uuid IS NULL THEN posted_lines ELSE $4::jsonb END
           WHERE id = $1::uuid`, [id, who, voucher?.voucher_id ?? null, JSON.stringify(journal.lines)]);
      });
    } catch (e) {
      if (e.code === 'P0410' || e.code === 'P0412') return reply.code(409).send({ error: 'NO_COMMISSION_RATE', detail: e.message });
      throw e;
    }

    const fresh = await billById(id);
    return {
      approved: true,
      bill: fresh,
      voucher_id: voucher?.voucher_id ?? null,
      posted: lines,
      note: !voucher
        ? 'Post karne ko kuch nahi tha (koi antar / adjustment nahi) — bill approve aur lock ho gaya.'
        : journal.agency
          ? `${fresh?.company_name ?? 'Company'} ki books me commission ${inr(journal.commission)} income gaya; `
            + `owner ${fresh.owner_name} ke khaate me ${inr(journal.payable)} credit; TDS ${inr(journal.tds)} kaata.`
            + (n > 0 ? ' Sirf antar post hua — purana voucher waisa hi hai.' : '')
          : `Ledger me sirf manual adjustment gaya (${inr(journal.adj_expense - journal.adj_income)} net).`,
    };
  });

  // ═══ MODIFY — admin, with a reason; moves no money ══════════════════════
  app.post('/:id/reopen', admin, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 4) return reply.code(400).send({ error: 'REASON_REQUIRED', detail: 'Modify ke liye kaaran likhna zaroori hai.' });
    const who = actor(req);
    const out = await withTransaction(async (t) => {
      const { rows } = await t.query(`
        UPDATE vehicle_owner_bills
           SET locked_at = NULL, locked_by = NULL, status = 'STAFF_REVIEWED',
               reopen_reason = $2, reopened_by = $3, reopened_at = now()
         WHERE id = $1::uuid AND locked_at IS NOT NULL
         RETURNING id, voucher_id, post_count`, [id, reason.slice(0, 500), who]);
      if (!rows.length) return null;
      await t.query(`
        UPDATE vehicle_fortnight_settlements
           SET locked_at = NULL, locked_by = NULL, status = 'STAFF_REVIEWED'
         WHERE owner_bill_id = $1::uuid AND locked_at IS NOT NULL`, [id]);
      return rows[0];
    });
    if (!out) return reply.code(409).send({ error: 'NOT_LOCKED' });
    return {
      reopened: true,
      note: out.post_count > 0
        ? 'Purana voucher waisa hi rehta hai — dobara approve par sirf antar ka naya voucher banega.'
        : null,
    };
  });

  // ═══ THE BILL AS TEXT — WhatsApp, e-mail ════════════════════════════════
  app.get('/:id/summary-text', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const bill = await billById(id);
    if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { text: billText(bill, await lorriesOf(id)), bill };
  });

  app.post('/:id/email', staff, async (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'BAD_ID' });
    const to = String(req.body?.to ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return reply.code(400).send({ error: 'BAD_EMAIL' });
    const bill = await billById(id);
    if (!bill) return reply.code(404).send({ error: 'NOT_FOUND' });
    const text = billText(bill, await lorriesOf(id)).replace(/\*/g, '');
    const subject = `${bill.bill_no} — ${bill.owner_name} — 15-day vehicle bill ${bill.cycle_label}`;
    try {
      const r = await sendMail(to, subject, text);
      return { sent: true, to, channel: r?.channel ?? 'gmail' };
    } catch (e) {
      return reply.code(502).send({ error: e.code ?? 'MAIL_FAILED', detail: e.message });
    }
  });
}
