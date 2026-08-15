// server/modules/ownerExpense.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Costs the company pays on a vehicle owner's behalf — driver salary and
// bhatta, an EMI paid to the bank for the owner's truck, repairs, tyres, a
// traffic fine.
//
// ALL OF THEM DEBIT THE OWNER'S KHATA. None is a company operating expense, and
// the difference is not cosmetic: an attached fleet's running costs booked as
// ours would inflate company expenses by the whole value of somebody else's
// operation — the same error as booking their diesel as ours, and it survives
// into the P&L and the return.
//
// THREE LAYERS ENFORCE IT, on purpose:
//   1. this handler refuses a company-owned vehicle outright, because those
//      costs genuinely ARE ours and belong on the normal voucher path;
//   2. the legs it builds only ever touch the owner ledger and the paying
//      bank/cash account — no P&L group is reachable from here at all;
//   3. TARA's assertAttachedCostIsolation refuses any P&L expense debit
//      carrying an attached vehicle_id, so a future caller that skips this
//      endpoint entirely still cannot get the wrong entry in.
//
// A DRIVER ON AN ATTACHED TRUCK IS THE OWNER'S EMPLOYEE. Recording which driver
// a bhatta went to is what lets the owner check the deduction; it does not put
// him on our payroll, and his salary never touches our staff cost.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';
import { postVoucher } from '../agents/tara.js';
import { getVehicleAccounting, FleetAccountingError } from '../lib/fleetAccounting.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

const KINDS = ['DRIVER_SALARY', 'DRIVER_BHATTA', 'VEHICLE_EMI', 'MAINTENANCE',
               'TYRE', 'BATTERY', 'TRAFFIC_FINE', 'RTO_PENALTY', 'OTHER'];
const DRIVER_KINDS = new Set(['DRIVER_SALARY', 'DRIVER_BHATTA']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function registerOwnerExpenseRoutes(app) {
  app.post('/owner-expense', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};

    const kind = String(b.kind ?? '').toUpperCase();
    if (!KINDS.includes(kind)) {
      return reply.code(400).send({ error: 'BAD_KIND', detail: `kind must be one of ${KINDS.join(', ')}` });
    }
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'amount must be greater than zero' });
    }
    if (!b.vehicle_id) return reply.code(400).send({ error: 'MISSING_VEHICLE' });
    if (!b.paid_from) {
      return reply.code(400).send({ error: 'MISSING_PAID_FROM', detail: 'the bank or cash ledger the money left' });
    }

    let vehicle;
    try {
      vehicle = await getVehicleAccounting((sql, p) => query(sql, p), b.vehicle_id);
    } catch (e) {
      if (e instanceof FleetAccountingError) return reply.code(400).send({ error: e.code, detail: e.message });
      throw e;
    }

    // The refusal that makes everything below safe.
    if (vehicle.is_company_owned) {
      return reply.code(409).send({
        error: 'VEHICLE_IS_COMPANY_OWNED',
        detail: `${vehicle.vehicle_no} is a company vehicle — its running costs ARE company expenses. `
              + 'Post them through the normal voucher path, not an owner khata.',
      });
    }

    let driverId = DRIVER_KINDS.has(kind) ? (b.driver_id ?? null) : null;
    if (driverId) {
      const { rows } = await query('SELECT id FROM drivers WHERE id = $1::uuid', [driverId]);
      if (!rows.length) return reply.code(404).send({ error: 'DRIVER_NOT_FOUND' });
    }

    const owner = vehicle.owner_ledger_name;
    const entryDate = ISO_DATE.test(b.expense_date ?? '') ? b.expense_date : undefined;
    const narration = String(b.narration ?? '').trim() || `${kind.replace(/_/g, ' ')} — ${vehicle.vehicle_no}`;
    // A stable reference so a double submit is refused rather than paid twice.
    const ref = b.reference_no ? String(b.reference_no).slice(0, 80) : null;
    const companyId = b.company_id ?? vehicle.company_id ?? null;
    const branchId = b.branch_id ?? vehicle.branch_id ?? null;

    try {
      const voucher = await postVoucher({
        type: 'JOURNAL',
        source_type: 'OWNER_EXPENSE',
        ref_no: ref,
        entry_date: entryDate,
        narration,
        vehicle_id: vehicle.id,
        company_id: companyId,
        branch_id: branchId,
        created_by: b.created_by ?? null,
        dry_run: !!b.dry_run,
        lines: [
          // Recoverable from the owner: a balance-sheet movement, not a cost.
          { ledger: owner, dr_cr: 'DR', amount, group: 'Sundry Creditors (Vehicle Owners)' },
          { ledger: String(b.paid_from), dr_cr: 'CR', amount },
        ],
      });

      if (b.dry_run) {
        return { ok: true, dry_run: true, would_post: { owner_ledger: owner, kind, amount } };
      }

      const voucherId = voucher?.voucher_id ?? voucher?.id ?? null;
      const { rows } = await query(
        `INSERT INTO owner_expenses
           (owner_ledger_id, vehicle_id, driver_id, company_id, branch_id, kind,
            expense_date, amount, narration, reference_no, voucher_id, created_by)
         VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,
                 COALESCE($7::date, CURRENT_DATE),$8,$9,$10,$11::uuid,$12)
         RETURNING id, kind, amount, expense_date, narration`,
        [vehicle.vehicle_owner_ledger_id, vehicle.id, driverId, companyId, branchId,
         kind, entryDate ?? null, amount, narration, ref, voucherId, b.created_by ?? null]);

      reply.code(201);
      return { ok: true, expense: rows[0], voucher_id: voucherId, owner_ledger: owner, vehicle: vehicle.vehicle_no };
    } catch (e) {
      // TARA's refusals are meaningful to the caller; surfacing them as 500s
      // would turn "you already posted this" into "the server is broken".
      if (e.code === 'DUPLICATE_REF') return reply.code(409).send({ error: 'DUPLICATE_REF', detail: e.message });
      if (e.code === '23505') {
        return reply.code(409).send({ error: 'DUPLICATE_EXPENSE', detail: 'that reference is already recorded for this owner' });
      }
      if (e.code === 'ATTACHED_COST_IN_PNL' || e instanceof FleetAccountingError) {
        return reply.code(422).send({ error: e.code, detail: e.message });
      }
      throw e;
    }
  });

  // ── Deduction breakdown for the statement ─────────────────────────────────
  app.get('/owner-expense/summary', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const owner = String(req.query?.owner ?? '').trim();
    if (!owner) return reply.code(400).send({ error: 'MISSING_OWNER' });
    const companyId = req.query?.company_id || null;
    const from = ISO_DATE.test(req.query?.from ?? '') ? req.query.from : null;
    const to = ISO_DATE.test(req.query?.to ?? '') ? req.query.to : null;

    const { rows } = await query(
      `SELECT oe.kind, v.vehicle_no,
              count(*)::int                  AS entries,
              sum(oe.amount)::numeric(16,2)  AS amount
         FROM owner_expenses oe
         JOIN ledgers l ON l.id = oe.owner_ledger_id
         LEFT JOIN vehicles v ON v.id = oe.vehicle_id
        WHERE l.ledger_name = $1
          AND ($2::uuid IS NULL OR oe.company_id = $2::uuid)
          AND ($3::date IS NULL OR oe.expense_date >= $3::date)
          AND ($4::date IS NULL OR oe.expense_date <= $4::date)
        GROUP BY oe.kind, v.vehicle_no
        ORDER BY oe.kind, v.vehicle_no`, [owner, companyId, from, to]);

    const byKind = {};
    const byVehicleKind = {};
    for (const r of rows) {
      byKind[r.kind] = Number((Number(byKind[r.kind] ?? 0) + Number(r.amount)).toFixed(2));
      const k = r.vehicle_no ?? '—';
      byVehicleKind[k] = byVehicleKind[k] ?? {};
      byVehicleKind[k][r.kind] = Number(r.amount);
    }
    return { rows, by_kind: byKind, by_vehicle: byVehicleKind };
  });

  // ── Printable voucher for one deduction ───────────────────────────────────
  // The owner is entitled to see the paper behind a line on his statement —
  // which driver, which truck, which bank reference — not just a number.
  app.get('/owner-expense/:id/voucher', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(
      `SELECT oe.id, oe.kind, oe.amount, oe.expense_date, oe.narration, oe.reference_no,
              oe.voucher_id, oe.created_at, oe.created_by,
              l.ledger_name AS owner_ledger,
              v.vehicle_no, d.name AS driver_name, d.mobile AS driver_mobile,
              btrim(c.company_name) AS company_name
         FROM owner_expenses oe
         JOIN ledgers l ON l.id = oe.owner_ledger_id
         LEFT JOIN vehicles v  ON v.id = oe.vehicle_id
         LEFT JOIN drivers d   ON d.id = oe.driver_id
         LEFT JOIN companies c ON c.id = oe.company_id
        WHERE oe.id = $1::uuid`, [req.params.id]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });

    // The posted legs, so the printed voucher shows the actual double entry
    // rather than a restatement of the request.
    const legs = await query(
      `SELECT ledger_name, dr_cr, amount, entry_date, particulars
         FROM ledger_entries WHERE voucher_id = $1::uuid ORDER BY dr_cr DESC`,
      [rows[0].voucher_id]);

    return { expense: rows[0], legs: legs.rows };
  });
}
