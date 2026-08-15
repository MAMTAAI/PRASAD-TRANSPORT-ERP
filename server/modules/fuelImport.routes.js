// server/modules/fuelImport.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Import parsed pump-bill rows, match them to trips, and post the fuel.
//
// WHERE THE DIESEL LANDS depends entirely on who owns the truck:
//
//   company-owned   Dr  Direct Expenses - Fuel & HSD     (our cost)
//                       Cr  Creditors: <pump>
//   attached        Dr  <vehicle owner's khata>          (recoverable from him)
//                       Cr  Creditors: <pump>
//
// The attached branch never touches a P&L expense group, and TARA refuses it
// anyway (assertAttachedCostIsolation) — so an attached truck's diesel cannot
// become a company cost even if this file were wrong.
//
// FUZZY VEHICLE MATCHING IS DELIBERATELY NARROW. Five of the parsed
// registrations are one character off a real truck ("AS25C9808" for AS26C9808).
// Correcting those is worth doing; guessing is not. A fuzzy match is accepted
// only at edit distance 1 AND only when exactly ONE truck in the fleet is that
// close — two candidates means nobody can tell, so the row goes to review. Every
// fuzzy match is recorded on the row so it can be audited later.
//
// NOTHING WRITES WITHOUT commit:true, for the same reason as the trip importer:
// ledger_entries is append-only, so a bad fuel import is unwound one reversing
// voucher at a time.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

const FUEL_EXPENSE = 'Direct Expenses - Fuel & HSD';
const FUEL_GROUP = 'Direct Expenses - Fuel & HSD';
const OWNER_GROUP = 'Sundry Creditors (Vehicle Owners)';
const PUMP_GROUP = 'Sundry Creditors (Fuel Pumps)';

/** Levenshtein, capped — we only ever care whether it is 0, 1, or "more". */
function editDistance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
    if (Math.min(...cur) > 1) return 2;   // cannot come back under 2
  }
  return prev[b.length];
}

/** The pump's creditor ledger. Named by the bill's folder, matched loosely
 *  because "B N filling" the folder is "B N FILLING STATION" the ledger. */
function pumpLedger(pumpName, ledgerNames) {
  const key = String(pumpName).toUpperCase().replace(/[^A-Z]/g, '');
  let best = null;
  for (const l of ledgerNames) {
    const lk = l.toUpperCase().replace(/^CREDITORS:/, '').replace(/[^A-Z]/g, '');
    if (lk.startsWith(key) || key.startsWith(lk.slice(0, Math.max(6, key.length)))) {
      if (!best || l.length < best.length) best = l;
    }
  }
  return best;
}

export function registerFuelImportRoutes(app) {
  app.post('/fuel/bulk-import', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const body = req.body ?? {};
    const rows = Array.isArray(body.rows) ? body.rows : null;
    if (!rows?.length) return reply.code(400).send({ error: 'NO_ROWS' });
    const commit = body.commit === true;
    const paidBy = body.paid_from ?? null;      // null = credit the pump (normal)

    const [veh, led] = await Promise.all([
      query(`SELECT v.id, v.vehicle_no, v.vehicle_no_norm, v.is_company_owned,
                    v.company_id, v.branch_id, l.ledger_name AS owner_ledger
               FROM vehicles v LEFT JOIN ledgers l ON l.id = v.vehicle_owner_ledger_id`),
      query(`SELECT ledger_name FROM ledgers WHERE group_head = $1`, [PUMP_GROUP]),
    ]);
    const byNorm = new Map(veh.rows.map((v) => [v.vehicle_no_norm, v]));
    const allNorms = [...byNorm.keys()];
    const pumpNames = led.rows.map((r) => r.ledger_name);

    const posted = [];
    const review = [];
    const errors = [];

    for (const r of rows) {
      const flags = Array.isArray(r.flags) ? [...r.flags] : [];
      const push = (reason) => { flags.push(reason); review.push({ ...r, reasons: flags }); };

      // 1. the parser already judged these unusable
      if (r.confidence !== 'OK') { review.push({ ...r, reasons: flags.length ? flags : ['PARSER_REVIEW'] }); continue; }
      if (!r.date || !r.vehicle_norm || !(Number(r.amount) > 0)) { push('INCOMPLETE_ROW'); continue; }

      // 2. resolve the truck — exact, then a single edit-distance-1 candidate
      let vehicle = byNorm.get(r.vehicle_norm);
      let fuzzy = null;
      if (!vehicle) {
        const near = allNorms.filter((n) => editDistance(r.vehicle_norm, n) === 1);
        if (near.length === 1) { vehicle = byNorm.get(near[0]); fuzzy = near[0]; flags.push(`FUZZY_FROM_${r.vehicle_norm}`); }
        else { push(near.length ? 'AMBIGUOUS_VEHICLE' : 'VEHICLE_NOT_IN_MASTER'); continue; }
      }

      // 3. does this fuel already exist in the books?
      const dup = await query(
        `SELECT id FROM fuel_entries
          WHERE vehicle_id = $1::uuid AND entry_date = $2::date
            AND abs(COALESCE(amount,0) - $3::numeric) < 1 LIMIT 1`,
        [vehicle.id, r.date, r.amount]);
      if (dup.rows.length) { push('ALREADY_IMPORTED'); continue; }

      // Same truck, same day, a different amount. Could be a second fill or the
      // same fill recorded differently — a machine cannot tell, and getting it
      // wrong either double-charges or loses a real cost.
      const sameDay = await query(
        `SELECT id, amount FROM fuel_entries WHERE vehicle_id = $1::uuid AND entry_date = $2::date LIMIT 1`,
        [vehicle.id, r.date]);
      if (sameDay.rows.length) { push('POSSIBLE_DUPLICATE_SAME_DAY'); continue; }

      // 4. the pump's creditor account
      const pump = pumpLedger(r.pump, pumpNames);
      if (!pump) { push('NO_PUMP_LEDGER'); continue; }

      // 5. link to the trip that was running that day
      const trip = await query(
        `SELECT id, trip_code FROM trips
          WHERE vehicle_id = $1::uuid
            AND $2::date BETWEEN loading_date AND COALESCE(unloading_date, loading_date + 15)
          ORDER BY loading_date DESC LIMIT 1`, [vehicle.id, r.date]);
      const tripId = trip.rows[0]?.id ?? null;
      if (!tripId) flags.push('STANDALONE_NO_TRIP');

      const rec = {
        pump, vehicle, trip_id: tripId, trip_code: trip.rows[0]?.trip_code ?? null,
        date: r.date, qty: r.qty, rate: r.rate, amount: Number(r.amount),
        cash: Number(r.cash ?? 0) || null, memo: r.memo_no ?? null,
        fuzzy, flags,
        mode: vehicle.is_company_owned ? 'OWNED' : 'ATTACHED',
      };

      if (!commit) { posted.push(rec); continue; }

      try {
        // ── the dual-accounting decision ────────────────────────────────────
        const debit = vehicle.is_company_owned
          ? { ledger: FUEL_EXPENSE, group: FUEL_GROUP }
          : { ledger: vehicle.owner_ledger, group: OWNER_GROUP };
        if (!vehicle.is_company_owned && !vehicle.owner_ledger) { push('ATTACHED_WITHOUT_OWNER_LEDGER'); continue; }

        const ref = `FUEL-${vehicle.vehicle_no_norm}-${r.date}-${Math.round(Number(r.amount))}`;
        const voucher = await postVoucher({
          type: 'JOURNAL',
          source_type: 'FUEL_BILL',
          ref_no: ref,
          entry_date: r.date,
          narration: `Diesel ${r.qty ?? ''}L @ ${r.rate ?? ''} — ${vehicle.vehicle_no} (${r.pump})`.replace(/\s+/g, ' ').trim(),
          vehicle_id: vehicle.id,
          company_id: vehicle.company_id,
          branch_id: vehicle.branch_id,
          created_by: body.created_by ?? 'fuel-import',
          lines: [
            { ledger: debit.ledger, dr_cr: 'DR', amount: Number(r.amount), group: debit.group, vehicle_id: vehicle.id },
            { ledger: paidBy ?? pump, dr_cr: 'CR', amount: Number(r.amount), group: paidBy ? null : PUMP_GROUP },
          ],
        });

        const ins = await query(
          `INSERT INTO fuel_entries
             (entry_date, vehicle_id, vehicle_no, trip_id, vendor_name, memo_no,
              fuel_type, liters, rate, amount, cash_given_to_pump, bill_status)
           VALUES ($1::date,$2::uuid,$3,$4::uuid,$5,$6,'HSD',$7,$8,$9,$10,'BILLED')
           RETURNING id`,
          [r.date, vehicle.id, vehicle.vehicle_no, tripId, r.pump, r.memo_no ?? null,
           r.qty ?? null, r.rate ?? null, r.amount, rec.cash]);

        posted.push({ ...rec, fuel_entry_id: ins.rows[0].id, voucher_id: voucher?.voucher_id ?? null });
      } catch (e) {
        if (e.code === 'DUPLICATE_REF') { push('ALREADY_POSTED'); continue; }
        errors.push({ vehicle: r.vehicle_norm, date: r.date, code: e.code ?? 'POST_FAILED', detail: e.message });
      }
    }

    // ── park the rejects where a human will see them ────────────────────────
    if (commit && review.length) {
      for (const q of review) {
        await query(
          `INSERT INTO fuel_import_review
             (pump, company_hint, source_file, entry_date, vehicle_raw, vehicle_norm,
              memo_no, qty, rate, amount, cash, reasons)
           VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12::text[])
           ON CONFLICT DO NOTHING`,
          [q.pump, q.company_hint ?? null, q.source_file ?? null,
           /^\d{4}-\d{2}-\d{2}$/.test(q.date ?? '') ? q.date : null,
           q.vehicle_raw ?? null, q.vehicle_norm ?? null, q.memo_no ?? null,
           q.qty ?? null, q.rate ?? null, q.amount ?? null, q.cash ?? null,
           q.reasons ?? []]).catch(() => { /* the queue must not fail the import */ });
      }
    }

    const byMode = posted.reduce((a, p) => { a[p.mode] = (a[p.mode] ?? 0) + 1; return a; }, {});
    return {
      ok: true,
      dry_run: !commit,
      summary: {
        received: rows.length,
        postable: posted.length,
        to_review: review.length,
        errors: errors.length,
        by_fleet: byMode,
        value: Number(posted.reduce((n, p) => n + p.amount, 0).toFixed(2)),
        litres: Number(posted.reduce((n, p) => n + (Number(p.qty) || 0), 0).toFixed(2)),
        matched_to_trip: posted.filter((p) => p.trip_id).length,
        standalone: posted.filter((p) => !p.trip_id).length,
        fuzzy_corrected: posted.filter((p) => p.fuzzy).length,
      },
      review_reasons: review.reduce((a, q) => {
        for (const x of (q.reasons ?? [])) a[x] = (a[x] ?? 0) + 1;
        return a;
      }, {}),
      errors,
      sample: posted.slice(0, 10),
    };
  });

  // ── the manual verification queue ─────────────────────────────────────────
  app.get('/fuel/review-queue', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const status = String(req.query?.status ?? 'PENDING').toUpperCase();
    const { rows } = await query(
      `SELECT * FROM fuel_import_review WHERE status = $1 ORDER BY pump, entry_date NULLS LAST LIMIT 1000`,
      [status]);
    const byReason = {};
    const byPump = {};
    for (const r of rows) {
      for (const x of r.reasons ?? []) byReason[x] = (byReason[x] ?? 0) + 1;
      byPump[r.pump] = (byPump[r.pump] ?? 0) + 1;
    }
    return { count: rows.length, by_reason: byReason, by_pump: byPump, rows };
  });

  app.post('/fuel/review-queue/:id/resolve', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const status = String(req.body?.status ?? 'RESOLVED').toUpperCase();
    if (!['RESOLVED', 'DISCARDED'].includes(status)) {
      return reply.code(400).send({ error: 'BAD_STATUS', detail: 'RESOLVED or DISCARDED' });
    }
    const { rows } = await query(
      `UPDATE fuel_import_review
          SET status = $2, resolved_note = $3, resolved_by = $4, resolved_at = now()
        WHERE id = $1::uuid RETURNING id, status`,
      [req.params.id, status, req.body?.note ?? null, req.body?.by ?? null]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true, row: rows[0] };
  });
}
