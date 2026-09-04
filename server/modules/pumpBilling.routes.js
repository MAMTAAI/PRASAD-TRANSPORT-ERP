// server/modules/pumpBilling.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// Fortnightly petrol-pump bills: group the slips, price them, compare them with
// the pump's physical bill, and hand the reconciliation to the endpoint that
// already posts it.
//
// THE SLIPS HAVE LITRES BUT ALMOST NO MONEY ON THEM.
// Of 479 unbilled slips, 465 carry amount = 0 and rate = 0. Every one has
// litres. So 56,017 litres of diesel — on the order of 50 lakh at the 90.61/L
// the priced slips average — is sitting in the system at a value of zero.
//
// That single fact decides the design. A "system bill" that simply sums
// `amount` would read 0 against a real pump bill of lakhs, every variance would
// be -100%, and the reconciliation screen would be telling the operator nothing
// they could act on. So the system amount is LITRES x A DERIVED RATE, and the
// derivation is stated on every line:
//
//   SLIP_RATE     the slip's own rate            (14 slips)
//   PUMP_RECENT   this pump's last known rate    — a pump's own price is the
//                 best guess for its next sale
//   FLEET_MEDIAN  median across priced slips     — last resort, and marked
//
// A derived figure is never presented as a fact. Each line says which rule
// priced it, and the bill reports how much of its value rests on each.
//
// WHY THE PHYSICAL BILL STAYS AUTHORITATIVE
// POST /queues/fuel-reconcile already distributes the PHYSICAL amount across
// slips pro-rata BY LITRES, which is exactly right when the slips have litres
// and no money: the pump's invoice is the price, the slips are the quantity.
// This module does not change that. It only makes the comparison possible
// beforehand, so an operator can see a variance before posting rather than
// discovering it in the ledger afterwards.
import { postVoucher } from '../agents/tara.js';
import { createHash } from 'node:crypto';
import { pdfRead, parsePumpBill, toBulkImportRows } from '../lib/pumpBillParse.js';
import { query, withTransaction } from '../db/pool.js';
import { requireAdminOrService } from './auth.routes.js';

/** Fortnight bounds; the 2nd half ends on the real last day of the month. */
function fortnight(year, month, half) {
  const last = new Date(year, month, 0).getDate();
  const [a, b] = half === 'SECOND' ? [16, last] : [1, 15];
  const iso = (d) => `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { from: iso(a), to: iso(b), label: `${iso(a)}..${iso(b)}`, half, year, month };
}

function fortnightsBetween(from, to) {
  const out = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  const endY = Number(to.slice(0, 4)), endM = Number(to.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    for (const half of ['FIRST', 'SECOND']) {
      const f = fortnight(y, m, half);
      if (f.to >= from && f.from <= to) out.push(f);
    }
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export async function registerPumpBillingRoutes(app, opts = {}) {
  const guard = opts.requireAdmin || requireAdminOrService;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // ── Plan: every pump x fortnight with unbilled slips, priced ───────────────
  app.post('/pump-bill-plan', { preHandler: guard }, async (req, reply) => {
    const from = req.body?.from, to = req.body?.to;
    if (!from || !to) return reply.code(400).send({ error: 'BAD_RANGE', detail: 'from and to are required' });

    // Rates used to price litres-only slips, computed once for the whole run.
    const { rows: [fleet] } = await query(
      `SELECT round(percentile_cont(0.5) WITHIN GROUP (
                ORDER BY amount / NULLIF(liters, 0))::numeric, 2) AS median_rate
         FROM fuel_entries
        WHERE COALESCE(amount, 0) > 0 AND COALESCE(liters, 0) > 0
          AND amount / NULLIF(liters, 0) BETWEEN 50 AND 150`);   // diesel, not a typo
    const fleetRate = Number(fleet?.median_rate) || null;

    const { rows: pumpRates } = await query(
      `SELECT DISTINCT ON (vendor_id) vendor_id,
              round((amount / NULLIF(liters, 0))::numeric, 2) AS rate, entry_date
         FROM fuel_entries
        WHERE COALESCE(amount, 0) > 0 AND COALESCE(liters, 0) > 0
          AND amount / NULLIF(liters, 0) BETWEEN 50 AND 150
        ORDER BY vendor_id, entry_date DESC`);
    const byPump = new Map(pumpRates.map((r) => [r.vendor_id, Number(r.rate)]));

    const periods = fortnightsBetween(from, to);
    const out = [];

    for (const p of periods) {
      const { rows: slips } = await query(
        `SELECT f.id, f.entry_date, f.vehicle_no, f.driver_name, f.trip_id,
                f.liters, f.rate, f.amount, f.vendor_id,
                v.vendor_name, v.vendor_type
           FROM fuel_entries f
           JOIN vendors v ON v.id = f.vendor_id
          WHERE COALESCE(f.bill_status, 'UNBILLED') = 'UNBILLED'
            AND f.entry_date BETWEEN $1::date AND $2::date
            AND COALESCE(f.liters, 0) > 0
          ORDER BY v.vendor_name, f.entry_date`,
        [p.from, p.to]);
      if (!slips.length) continue;

      const groups = new Map();
      for (const s of slips) {
        if (!groups.has(s.vendor_id)) {
          groups.set(s.vendor_id, {
            vendor_id: s.vendor_id, vendor_name: s.vendor_name,
            period: p, slips: [], totals: {},
          });
        }
        const liters = Number(s.liters) || 0;
        const own = Number(s.amount) > 0 && liters > 0 ? Number(s.amount) / liters : null;
        const pumpRate = byPump.get(s.vendor_id) ?? null;
        const rate = own ?? pumpRate ?? fleetRate;
        const basis = own ? 'SLIP_RATE' : pumpRate ? 'PUMP_RECENT' : fleetRate ? 'FLEET_MEDIAN' : null;

        groups.get(s.vendor_id).slips.push({
          id: s.id, entry_date: s.entry_date, vehicle_no: s.vehicle_no,
          driver_name: s.driver_name, trip_id: s.trip_id,
          liters, slip_amount: Number(s.amount) || 0,
          rate_used: rate == null ? null : Math.round(rate * 100) / 100,
          rate_basis: basis,
          system_amount: rate == null ? null : Math.round(liters * rate * 100) / 100,
        });
      }

      for (const g of groups.values()) {
        const sum = (f) => g.slips.reduce((a, s) => a + (Number(s[f]) || 0), 0);
        const byBasis = {};
        for (const s of g.slips) byBasis[s.rate_basis ?? 'UNPRICED'] = (byBasis[s.rate_basis ?? 'UNPRICED'] || 0) + 1;
        g.totals = {
          slips: g.slips.length,
          liters: Math.round(sum('liters') * 100) / 100,
          slip_amount: Math.round(sum('slip_amount') * 100) / 100,
          system_amount: Math.round(sum('system_amount') * 100) / 100,
          rate_basis_counts: byBasis,
          // How much of this bill is a guess. An operator about to post to a
          // vendor ledger should see that before they see the total.
          derived_pct: Math.round(
            100 * g.slips.filter((s) => s.rate_basis !== 'SLIP_RATE').length / g.slips.length),
        };
      }
      out.push({ period: p, pumps: [...groups.values()] });
    }

    const totals = out.reduce((a, p) => {
      for (const g of p.pumps) {
        a.bills += 1; a.slips += g.totals.slips;
        a.liters += g.totals.liters; a.system_amount += g.totals.system_amount;
      }
      return a;
    }, { bills: 0, slips: 0, liters: 0, system_amount: 0 });
    totals.liters = Math.round(totals.liters * 100) / 100;
    totals.system_amount = Math.round(totals.system_amount * 100) / 100;

    return {
      ok: true, range: [from, to],
      pricing: { fleet_median_rate: fleetRate, pumps_with_own_rate: byPump.size },
      totals, periods: out,
    };
  });

  // ── Variance against a physical bill ───────────────────────────────────────
  // Line by line, before anything is posted.
  app.post('/pump-bill-variance', { preHandler: guard }, async (req, reply) => {
    const vendorId = req.body?.vendor_id;
    const from = req.body?.from, to = req.body?.to;
    const physicalAmount = Number(req.body?.physical_amount);
    const physicalLiters = req.body?.physical_liters == null ? null : Number(req.body.physical_liters);
    if (!vendorId || !from || !to) return reply.code(400).send({ error: 'BAD_INPUT', detail: 'vendor_id, from and to are required' });
    if (!(physicalAmount > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT', detail: 'physical_amount must be > 0' });

    const plan = await app.inject({
      method: 'POST', url: '/api/v1/fuel/pump-bill-plan',
      headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' },
      payload: { from, to },
    });
    if (plan.statusCode !== 200) return reply.code(502).send({ error: 'PLAN_FAILED', detail: plan.body.slice(0, 300) });

    const pump = plan.json().periods.flatMap((p) => p.pumps).find((g) => g.vendor_id === vendorId);
    if (!pump) return reply.code(404).send({ error: 'NO_UNBILLED_SLIPS', detail: 'this pump has no unbilled slips in that period' });

    const sysAmount = pump.totals.system_amount;
    const sysLiters = pump.totals.liters;
    const amountDelta = Math.round((physicalAmount - sysAmount) * 100) / 100;
    const litersDelta = physicalLiters == null ? null : Math.round((physicalLiters - sysLiters) * 100) / 100;

    // Per-slip share of the physical bill, by litres — the same rule
    // /fuel-reconcile will apply, shown before it is applied rather than after.
    const lines = pump.slips.map((s) => {
      const share = sysLiters > 0 ? Math.round(physicalAmount * s.liters / sysLiters * 100) / 100 : 0;
      return {
        ...s,
        physical_share: share,
        line_delta: Math.round((share - (s.system_amount ?? 0)) * 100) / 100,
        effective_rate: s.liters > 0 ? Math.round(share / s.liters * 100) / 100 : null,
      };
    });

    return {
      ok: true,
      vendor: { id: pump.vendor_id, name: pump.vendor_name },
      period: { from, to },
      system: { slips: pump.totals.slips, liters: sysLiters, amount: sysAmount,
                derived_pct: pump.totals.derived_pct, rate_basis_counts: pump.totals.rate_basis_counts },
      physical: { amount: physicalAmount, liters: physicalLiters },
      variance: {
        amount_delta: amountDelta,
        amount_delta_pct: sysAmount > 0 ? Math.round(amountDelta / sysAmount * 10000) / 100 : null,
        liters_delta: litersDelta,
        // A variance against a mostly-derived system amount says more about the
        // derivation than about the pump. Say so rather than let a red number
        // imply the pump overcharged.
        meaningful: pump.totals.derived_pct < 50,
        note: pump.totals.derived_pct >= 50
          ? `${pump.totals.derived_pct}% of the system amount is a derived rate, not a recorded one -- this variance measures the estimate, not the pump`
          : null,
      },
      slip_ids: pump.slips.map((s) => s.id),
      lines,
    };
  });

  // ── Reference key ─────────────────────────────────────────────────────────
  // Period-derived, NOT slip-derived. The old FUELBILL_<vendor>_<slip ids>
  // minted a fresh reference whenever the slip list changed, so adding one slip
  // let a second voucher post for the same pump and the same fortnight.
  const refFor = (vendorId, period) =>
    `PUMPBILL_${vendorId}_${period.year}${String(period.month).padStart(2, '0')}_` +
    `${period.half === 'FIRST' ? 'H1' : 'H2'}`;

  // ── 1. Create a DRAFT. Writes to pump_bill_drafts and nothing else. ───────
  app.post('/pump-bill-draft', { preHandler: guard }, async (req, reply) => {
    const { vendor_id: vendorId, year, month, half } = req.body ?? {};
    if (!vendorId || !year || !month || !half) {
      return reply.code(400).send({ error: 'BAD_INPUT', detail: 'vendor_id, year, month and half (FIRST|SECOND) are required' });
    }
    const period = fortnight(Number(year), Number(month), String(half).toUpperCase());
    const ref = refFor(vendorId, period);

    // Refuse before doing any work if this fortnight is already posted. The
    // unique index would catch it at approval anyway, but failing here means an
    // operator is never shown a draft they can never approve.
    const { rows: existing } = await query(
      `SELECT id, status, ref_no, approved_at FROM pump_bill_drafts
        WHERE vendor_id = $1::uuid AND period_from = $2::date AND period_to = $3::date
          AND status IN ('APPROVED', 'DRAFT')`,
      [vendorId, period.from, period.to]);
    const approved = existing.find((r) => r.status === 'APPROVED');
    if (approved) {
      return reply.code(409).send({
        error: 'PERIOD_ALREADY_POSTED',
        detail: `${period.label} is already posted for this pump (${approved.ref_no})`,
        bill_id: approved.id,
      });
    }
    const openDraft = existing.find((r) => r.status === 'DRAFT');

    const plan = await app.inject({
      method: 'POST', url: '/api/v1/fuel/pump-bill-plan',
      headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' },
      payload: { from: period.from, to: period.to },
    });
    if (plan.statusCode !== 200) return reply.code(502).send({ error: 'PLAN_FAILED', detail: plan.body.slice(0, 300) });
    const pump = plan.json().periods.flatMap((x) => x.pumps).find((g) => g.vendor_id === vendorId);
    if (!pump) return reply.code(404).send({ error: 'NO_UNBILLED_SLIPS', detail: `no unbilled slips for this pump in ${period.label}` });

    const slipIds = pump.slips.map((x) => x.id);
    const linesJson = JSON.stringify(pump.slips);

    const sql = openDraft
      ? `UPDATE pump_bill_drafts SET vendor_name=$2, slip_ids=$3::uuid[], slip_count=$4,
             system_liters=$5, system_amount=$6, derived_pct=$7, lines=$8::jsonb, updated_at=now()
           WHERE id=$1::uuid RETURNING *`
      : `INSERT INTO pump_bill_drafts
             (vendor_id, vendor_name, period_from, period_to, half, ref_no,
              slip_ids, slip_count, system_liters, system_amount, derived_pct, lines, created_by)
           VALUES ($1::uuid,$2,$3::date,$4::date,$5,$6,$7::uuid[],$8,$9,$10,$11,$12::jsonb,$13)
           RETURNING *`;
    const args = openDraft
      ? [openDraft.id, pump.vendor_name, slipIds, pump.totals.slips, pump.totals.liters,
         pump.totals.system_amount, pump.totals.derived_pct, linesJson]
      : [vendorId, pump.vendor_name, period.from, period.to, period.half, ref,
         slipIds, pump.totals.slips, pump.totals.liters, pump.totals.system_amount,
         pump.totals.derived_pct, linesJson, req.user?.name ?? 'api'];
    const { rows: [draft] } = await query(sql, args);

    return { ok: true, mode: 'DRAFT', refreshed: !!openDraft, ref_no: ref, period, draft };
  });

  // ── 2. Review: physical bill + hand-typed rates. Still only the draft. ────
  app.patch('/pump-bill-draft/:id', { preHandler: guard }, async (req, reply) => {
    const { rows: [d] } = await query('SELECT * FROM pump_bill_drafts WHERE id = $1::uuid', [req.params.id]);
    if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (d.status !== 'DRAFT') return reply.code(409).send({ error: 'NOT_A_DRAFT', detail: `this bill is ${d.status}` });

    // A rate typed by a human beats every derived rate, and re-prices its line.
    // 465 of 479 slips carry no rate at all, so this is the field that makes a
    // system bill mean anything before a physical bill arrives.
    const overrides = { ...(d.rate_overrides ?? {}), ...(req.body?.rate_overrides ?? {}) };
    const lines = (d.lines ?? []).map((l) => {
      const ov = overrides[l.id];
      if (ov == null) return l;
      const rate = Number(ov);
      return { ...l, rate_used: rate, rate_basis: 'MANUAL', system_amount: Math.round(l.liters * rate * 100) / 100 };
    });
    const sysAmount = Math.round(lines.reduce((a, l) => a + (Number(l.system_amount) || 0), 0) * 100) / 100;
    const solid = (l) => l.rate_basis === 'SLIP_RATE' || l.rate_basis === 'MANUAL';
    const derivedPct = lines.length
      ? Math.round(100 * lines.filter((l) => !solid(l)).length / lines.length) : 0;

    const { rows: [updated] } = await query(
      `UPDATE pump_bill_drafts
          SET physical_amount = COALESCE($2, physical_amount),
              physical_liters = COALESCE($3, physical_liters),
              rate_overrides  = $4::jsonb,
              lines           = $5::jsonb,
              system_amount   = $6,
              derived_pct     = $7,
              notes           = COALESCE($8, notes),
              updated_at      = now()
        WHERE id = $1::uuid RETURNING *`,
      [req.params.id, req.body?.physical_amount ?? null, req.body?.physical_liters ?? null,
       JSON.stringify(overrides), JSON.stringify(lines), sysAmount, derivedPct, req.body?.notes ?? null]);

    const phys = updated.physical_amount == null ? null : Number(updated.physical_amount);
    return {
      ok: true, mode: 'DRAFT', draft: updated,
      comparison: {
        system:   { liters: Number(updated.system_liters), amount: Number(updated.system_amount), derived_pct: derivedPct },
        physical: { liters: updated.physical_liters == null ? null : Number(updated.physical_liters), amount: phys },
        variance: phys == null ? null : {
          amount_delta: Math.round((phys - Number(updated.system_amount)) * 100) / 100,
          liters_delta: updated.physical_liters == null ? null
            : Math.round((Number(updated.physical_liters) - Number(updated.system_liters)) * 100) / 100,
          meaningful: derivedPct < 50,
          note: derivedPct >= 50
            ? `${derivedPct}% of the system amount is still a derived rate -- enter the rates and this variance starts measuring the pump instead of the estimate`
            : null,
        },
      },
    };
  });

  // ── 3. Approve. The only step that writes outside the draft. ──────────────
  app.post('/pump-bill-draft/:id/approve', { preHandler: guard }, async (req, reply) => {
    const { rows: [d] } = await query('SELECT * FROM pump_bill_drafts WHERE id = $1::uuid', [req.params.id]);
    if (!d) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (d.status === 'APPROVED') {
      return reply.code(409).send({ error: 'ALREADY_APPROVED', detail: `posted as ${d.ref_no}`, voucher_id: d.voucher_id });
    }
    if (d.status !== 'DRAFT') return reply.code(409).send({ error: 'NOT_A_DRAFT', detail: `this bill is ${d.status}` });

    const amount = Number(req.body?.physical_amount ?? d.physical_amount);
    if (!(amount > 0)) {
      return reply.code(400).send({ error: 'NO_PHYSICAL_AMOUNT', detail: 'the pump bill amount is what gets posted; enter it before approving' });
    }

    // Delegate posting and slip locking to /queues/fuel-reconcile, which already
    // distributes pro-rata by litres and posts DR fuel / CR creditor through
    // TARA. Approval is a gate in front of it, not a second way to do it.
    const res = await app.inject({
      method: 'POST', url: '/api/v1/queues/fuel-reconcile',
      headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' },
      payload: {
        vendor_id: d.vendor_id, slip_ids: d.slip_ids, bill_amount: amount,
        from: d.period_from, to: d.period_to,
      },
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      return reply.code(res.statusCode).send({ error: 'POST_FAILED', detail: res.body.slice(0, 400) });
    }
    const posted = res.json();

    try {
      const { rows: [approved] } = await query(
        `UPDATE pump_bill_drafts
            SET status='APPROVED', physical_amount=$2, voucher_id=$3::uuid,
                approved_by=$4, approved_at=now(), updated_at=now()
          WHERE id=$1::uuid AND status='DRAFT' RETURNING *`,
        [req.params.id, amount, posted.voucher_id ?? posted.voucher?.id ?? null, req.user?.name ?? 'api']);
      return { ok: true, mode: 'APPROVED', ref_no: d.ref_no, draft: approved, posted };
    } catch (e) {
      // The unique index fired between the check and the write: somebody else
      // approved this fortnight first. TARA is idempotent on ref_no, so nothing
      // has been double-posted.
      if (String(e.code) === '23505') {
        return reply.code(409).send({ error: 'PERIOD_ALREADY_POSTED', detail: 'another approval for this pump and fortnight landed first' });
      }
      throw e;
    }
  });

  app.get('/pump-bill-drafts', { preHandler: guard }, async (req) => {
    const { rows } = await query(
      `SELECT id, vendor_name, period_from, period_to, half, ref_no, status,
              slip_count, system_liters, system_amount, physical_amount, derived_pct,
              approved_at, voucher_id
         FROM pump_bill_drafts
        WHERE ($1::text IS NULL OR status = $1::text)
        ORDER BY period_from DESC, vendor_name
        LIMIT 200`, [req.query?.status ?? null]);
    return { ok: true, count: rows.length, drafts: rows };
  });

  /**
   * Settle one 15-day pump bill: consolidate, post, lock.
   *
   * THE PAYABLE IS THE BILL LESS WHAT IS DISPUTED, and that is the whole point
   * of this endpoint existing rather than the screen calling /fuel-reconcile
   * directly. The screen used to post the FULL physical amount even when the
   * desk had marked lines as disputed — crediting the pump for exactly the
   * money the office was refusing to pay.
   *
   * The disputed lines' slips are left out of the slip set too, so the pro-rata
   * distribution inside /fuel-reconcile stays consistent: the slips that are
   * paid for are the slips that are posted.
   *
   * THE LEDGER LEGS ARE NOT REBUILT HERE. /queues/fuel-reconcile already posts
   * the one journal (Dr Direct Expenses - Fuel & HSD, Cr Creditors: <pump>)
   * under a deterministic ref, moves each trip by the delta, and writes the
   * pump's khata row. This wraps it, records the fortnight, and closes it.
   */
  app.post('/pump-bill-settle', { preHandler: guard }, async (req, reply) => {
        const b = req.body ?? {};
    const vendorId = String(b.vendor_id ?? '');
    if (!UUID_RE.test(vendorId)) return reply.code(400).send({ error: 'BAD_VENDOR' });
    if (!b.period_from || !b.period_to) return reply.code(400).send({ error: 'NO_PERIOD' });

    const slipIds = Array.isArray(b.slip_ids) ? b.slip_ids.filter((x) => UUID_RE.test(String(x))) : [];
    const billAmount = Number(b.bill_amount);
    const disputed = Math.max(0, Number(b.disputed_amount) || 0);
    const payable = Number((billAmount - disputed).toFixed(2));

    if (!(billAmount > 0)) return reply.code(400).send({ error: 'BAD_AMOUNT' });
    if (payable < 0) {
      return reply.code(400).send({
        error: 'DISPUTE_EXCEEDS_BILL',
        detail: `disputed ${disputed} is more than the bill ${billAmount}`,
      });
    }

    const { rows: vRows } = await query(
      'SELECT id, vendor_name FROM vendors WHERE id = $1::uuid', [vendorId]);
    if (!vRows.length) return reply.code(404).send({ error: 'NO_SUCH_VENDOR' });
    const vendor = vRows[0];

    // ── THE LOCK, checked before anything is posted ────────────────────────
    const { rows: already } = await query(`
      SELECT id, invoice_no, locked_at, payable_amount
        FROM pump_bill_drafts
       WHERE vendor_id = $1::uuid AND period_from = $2::date AND period_to = $3::date
         AND locked_at IS NOT NULL`, [vendorId, b.period_from, b.period_to]);
    if (already.length) {
      return reply.code(409).send({
        error: 'PERIOD_LOCKED',
        detail: `${vendor.vendor_name} ${b.period_from} to ${b.period_to} is already settled `
              + `and locked as ${already[0].invoice_no ?? already[0].id}`,
        bill: already[0],
      });
    }

    if (!slipIds.length) {
      return reply.code(400).send({
        error: 'NO_SLIPS',
        detail: 'no slip was selected to post against this bill',
      });
    }
    // NOTHING PAYABLE MEANS NOTHING TO SETTLE. The schema says a bill is
    // APPROVED if and only if it carries a voucher (073's
    // pump_draft_approved_has_voucher), so a fully disputed fortnight cannot be
    // "settled" — there is no posting to attach. The dispute IS the outcome,
    // and the bill stays open until the pump answers it.
    if (payable <= 0) {
      return reply.code(409).send({
        error: 'NOTHING_PAYABLE',
        detail: `the whole bill of ₹${billAmount.toFixed(2)} is disputed — there is nothing to `
              + 'post, so the fortnight stays open until the pump answers it',
      });
    }

    // ── post the payable through the path that already works ───────────────
    let recon = null;
    if (payable > 0) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/queues/fuel-reconcile',
        headers: { 'content-type': 'application/json',
                   authorization: req.headers.authorization ?? '' },
        payload: {
          vendor_id: vendorId,
          slip_ids: slipIds,
          bill_amount: payable,
          from: b.period_from,
          to: b.period_to,
          created_by: b.created_by ?? null,
        },
      });
      recon = res.json();
      if (res.statusCode >= 400) {
        return reply.code(res.statusCode).send(recon);
      }
    }

    // ── record the fortnight and close it ──────────────────────────────────
    const { rows: [bill] } = await query(`
      INSERT INTO pump_bill_drafts
        (vendor_id, vendor_name, ref_no, invoice_no, period_from, period_to, half, status,
         slip_count, system_liters, system_amount, physical_liters, physical_amount,
         disputed_amount, payable_amount, resolutions, lines, voucher_id,
         locked_at, locked_by, created_by, approved_by, approved_at)
      VALUES ($1::uuid, $2,
              COALESCE($3, pump_invoice_no($2, $4::date)),
              pump_invoice_no($2, $4::date),
              $4::date, $5::date,
              CASE WHEN extract(day FROM $4::date) <= 15 THEN 'FIRST' ELSE 'SECOND' END,
              'APPROVED',
              $6, $7, $8, $7, $9, $10, $11, $12::jsonb, $13::jsonb, $14::uuid,
              now(), $15, $15, $15, now())
      ON CONFLICT (vendor_id, period_from, period_to) WHERE status IN ('DRAFT','PENDING')
      DO UPDATE SET
        invoice_no      = EXCLUDED.invoice_no,
        status          = 'APPROVED',
        slip_count      = EXCLUDED.slip_count,
        system_liters   = EXCLUDED.system_liters,
        system_amount   = EXCLUDED.system_amount,
        physical_amount = EXCLUDED.physical_amount,
        disputed_amount = EXCLUDED.disputed_amount,
        payable_amount  = EXCLUDED.payable_amount,
        resolutions     = EXCLUDED.resolutions,
        lines           = EXCLUDED.lines,
        voucher_id      = EXCLUDED.voucher_id,
        locked_at       = now(),
        locked_by       = EXCLUDED.locked_by,
        updated_at      = now()
      RETURNING *`,
      [vendorId, vendor.vendor_name, b.ref_no ?? null, b.period_from, b.period_to,
       Number(b.slip_count) || slipIds.length,
       Number(b.total_liters) || 0, payable,
       billAmount, disputed, payable,
       JSON.stringify(b.resolutions ?? {}), JSON.stringify(b.lines ?? []),
       recon?.voucher_id ?? null, b.created_by ?? 'desk']);

    // ── point the slips back at the bill that just paid them ──────────────
    //
    // /fuel-reconcile stamps settled_voucher_id and settled_at, but it cannot
    // stamp settled_bill_id: the bill row does not exist yet when it runs — it
    // is written directly above. So the last step of settling a fortnight is
    // telling its slips which fortnight it was. Without this the memo knows it
    // was paid and cannot say by what, and the history screen falls back to
    // "settled before the reference was recorded" on a bill settled minutes
    // ago.
    //
    // Scoped to the slips this call posted, and only where the link is still
    // missing — a slip already pointing at an earlier bill is not re-pointed.
    const { rowCount: linked } = await query(
      `UPDATE fuel_entries
          SET settled_bill_id = $1::uuid, updated_at = now()
        WHERE id = ANY($2::uuid[]) AND settled_bill_id IS NULL`,
      [bill.id, slipIds]);

    const { rows: [out] } = await query(
      `SELECT * FROM v_pump_outstanding WHERE vendor_id = $1::uuid`, [vendorId]);

    return {
      settled: true,
      bill: {
        id: bill.id,
        invoice_no: bill.invoice_no,
        vendor_name: bill.vendor_name,
        period: { from: bill.period_from, to: bill.period_to },
        total_liters: Number(bill.system_liters) || 0,
        bill_amount: Number(bill.physical_amount) || 0,
        disputed_amount: Number(bill.disputed_amount) || 0,
        payable_amount: Number(bill.payable_amount) || 0,
        locked: true,
        locked_at: bill.locked_at,
      },
      voucher_id: recon?.voucher_id ?? null,
      slips_posted: recon?.slips ?? 0,
      slips_linked: linked,
      trips_adjusted: recon?.trips_adjusted ?? 0,
      pump_outstanding: out ?? null,
      note: disputed > 0
        ? `₹${disputed.toFixed(2)} disputed — not posted, and the pump is not credited for it.`
        : null,
    };
  });

  /** Every settled fortnight, and what each pump is still owed. */
  app.get('/pump-bill-settled', { preHandler: guard }, async (req, reply) => {
        const { rows: bills } = await query(
      `SELECT * FROM v_pump_fortnight_bill
        WHERE ($1::uuid IS NULL OR vendor_id = $1::uuid)
        ORDER BY period_to DESC, vendor_name LIMIT 200`,
      [UUID_RE.test(String(req.query?.vendor_id ?? '')) ? req.query.vendor_id : null]);
    const { rows: outstanding } = await query(
      `SELECT * FROM v_pump_outstanding ORDER BY outstanding DESC`);
    return { bills, outstanding };
  });

  /**
   * Unlock a settled fortnight. Deliberate, reasoned, and recorded.
   *
   * The voucher it posted is NOT reversed here — a posted voucher is undone by
   * a correcting entry through TARA, never by editing history. Unlocking only
   * reopens the bill so the desk can restate it.
   */
  app.post('/pump-bill-unlock/:id', { preHandler: guard }, async (req, reply) => {
        const reason = String(req.body?.reason ?? '').trim();
    if (reason.length < 6) {
      return reply.code(400).send({
        error: 'REASON_REQUIRED',
        detail: 'unlocking a settled fortnight has to say why',
      });
    }
    const { rows } = await query(`
      UPDATE pump_bill_drafts
         SET locked_at = NULL,
             notes = COALESCE(notes, '') || ' | unlocked: ' || $2,
             updated_at = now()
       WHERE id = $1::uuid AND locked_at IS NOT NULL
      RETURNING id, invoice_no, voucher_id`, [req.params.id, reason]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_LOCKED' });
    return {
      unlocked: rows[0],
      note: rows[0].voucher_id
        ? 'The voucher this bill posted still stands. Reverse it through TARA if the money was wrong.'
        : null,
    };
  });

  /**
   * One settled fortnight, itemised — and it must never come back empty.
   *
   * THREE SOURCES, IN ORDER OF HOW CLOSE THEY ARE TO THE PAPER:
   *
   *   1. `lines` — what was recorded when the bill was made. Two shapes exist
   *      and both are read: the audit shape written by the reconciliation
   *      screen (date / vehicle_raw / qty / rate / amount), and the older shape
   *      the pump-bill planner wrote (entry_date / vehicle_no / liters /
   *      rate_used / rate_basis / system_amount). All 49 historical bills carry
   *      the second one.
   *   2. `slip_ids` — the memos the bill was actually built from. Exact, just
   *      without the pump's own figures beside them.
   *   3. the pump's memos over that date range — the last resort, and marked as
   *      such, because it is a reconstruction rather than a record.
   *
   * A DERIVED RATE IS NEVER PRESENTED AS THE PUMP'S RATE. Most of these slips
   * were issued with no money on them at all — 465 of 479, per the planner's
   * own note — so their rate was derived (PUMP_RECENT, SLIP_RATE, FLEET_MEDIAN)
   * and every line says which rule priced it. Showing that as "billed rate"
   * would turn an estimate into a fact on a printed audit sheet.
   */
  app.get('/pump-bill/:id/details', { preHandler: guard }, async (req, reply) => {
    const { rows: [bill] } = await query(
      `SELECT d.*, COALESCE(d.invoice_no, pump_invoice_no(d.vendor_name, d.period_from)) AS invoice_no,
              fortnight_label(d.period_from) AS cycle_label
         FROM pump_bill_drafts d WHERE d.id = $1::uuid`, [req.params.id]);
    if (!bill) return reply.code(404).send({ error: 'NO_SUCH_BILL' });

    const raw = Array.isArray(bill.lines) ? bill.lines : [];
    let source = 'RECORDED';
    let rows = [];

    if (raw.length) {
      rows = raw.map((l, i) => ({
        sno: l.sno ?? i + 1,
        idx: l.idx ?? i,
        date: String(l.date ?? l.entry_date ?? '').slice(0, 10),
        vehicle: l.vehicle_raw ?? l.vehicle_no ?? null,
        driver: l.driver_name ?? null,
        liters: Number(l.qty ?? l.liters ?? 0) || null,
        // The pump's own printed rate if the bill was read from a PDF;
        // otherwise the derived one, carrying the rule that derived it.
        billed_rate: l.rate ?? l.rate_used ?? null,
        rate_basis: l.rate_basis ?? (l.rate != null ? 'FROM_BILL' : null),
        authorised_rate: l.slip_rate ?? null,
        amount: Number(l.amount ?? l.system_amount ?? 0) || null,
        memo_id: l.fuel_entry_id ?? l.slip_id ?? l.id ?? null,
        memo_no: l.memo_no ?? l.slip?.memo_no ?? null,
        trip_id: l.trip_id ?? null,
        verdict: l.verdict ?? null,
        notes: Array.isArray(l.notes) ? l.notes : [],
      }));
    } else if (Array.isArray(bill.slip_ids) && bill.slip_ids.length) {
      source = 'FROM_SLIPS';
      const { rows: sl } = await query(`
        SELECT f.id, f.entry_date, f.vehicle_no, f.driver_name, f.liters, f.rate, f.amount,
               f.memo_no, f.trip_id
          FROM fuel_entries f WHERE f.id = ANY($1::uuid[])
         ORDER BY f.entry_date, f.id`, [bill.slip_ids]);
      rows = sl.map((f, i) => ({
        sno: i + 1, idx: i,
        date: String(f.entry_date ?? '').slice(0, 10),
        vehicle: f.vehicle_no, driver: f.driver_name,
        liters: Number(f.liters) || null,
        billed_rate: Number(f.rate) || null, rate_basis: 'SLIP_RATE',
        authorised_rate: Number(f.rate) || null,
        amount: Number(f.amount) || null,
        memo_id: f.id, memo_no: f.memo_no, trip_id: f.trip_id,
        verdict: null, notes: [],
      }));
    } else {
      source = 'RECONSTRUCTED';
      const { rows: sl } = await query(`
        SELECT f.id, f.entry_date, f.vehicle_no, f.driver_name, f.liters, f.rate, f.amount,
               f.memo_no, f.trip_id
          FROM fuel_entries f
         WHERE (f.vendor_id = $1::uuid OR pump_key(f.vendor_name) = pump_key($2))
           AND f.entry_date BETWEEN $3::date AND $4::date
         ORDER BY f.entry_date, f.id
         LIMIT 500`, [bill.vendor_id, bill.vendor_name, bill.period_from, bill.period_to]);
      rows = sl.map((f, i) => ({
        sno: i + 1, idx: i,
        date: String(f.entry_date ?? '').slice(0, 10),
        vehicle: f.vehicle_no, driver: f.driver_name,
        liters: Number(f.liters) || null,
        billed_rate: Number(f.rate) || null, rate_basis: 'SLIP_RATE',
        authorised_rate: Number(f.rate) || null,
        amount: Number(f.amount) || null,
        memo_id: f.id, memo_no: f.memo_no, trip_id: f.trip_id,
        verdict: null, notes: [],
      }));
    }

    // Whatever the source, say what each memo is doing NOW — settled where, and
    // whether it could still be used. A drill-down that shows a memo without
    // its current standing invites it being applied to a second bill.
    const ids = rows.map((r) => r.memo_id).filter(Boolean);
    if (ids.length) {
      const { rows: st } = await query(
        `SELECT id, memo_no, bill_status, reusable, settled_label
           FROM v_fuel_memo_settlement WHERE id = ANY($1::uuid[])`, [ids]);
      const by = new Map(st.map((x) => [String(x.id), x]));
      for (const r of rows) {
        const s = by.get(String(r.memo_id));
        if (!s) continue;
        r.memo_no = r.memo_no ?? s.memo_no;
        r.bill_status = s.bill_status;
        r.reusable = s.reusable;
        r.settled_label = s.settled_label;
      }
    }

    const res = bill.resolutions ?? {};
    for (const r of rows) {
      const d = res[String(r.idx)];
      r.decision = d ?? null;
      r.status = d === 'DISPUTED' ? 'DISPUTED'
               : d === 'ACCEPTED' ? 'ACCEPTED'
               : d === 'LINKED'   ? 'ADJUSTED'
               : r.verdict === 'MATCHED' ? 'MATCHED'
               : r.verdict ?? (source === 'RECORDED' ? 'RECORDED' : 'FROM_MEMO');
    }

    return {
      bill: {
        id: bill.id,
        invoice_no: bill.invoice_no,
        vendor_id: bill.vendor_id,
        vendor_name: bill.vendor_name,
        period_from: bill.period_from,
        period_to: bill.period_to,
        cycle_label: bill.cycle_label,
        status: bill.status,
        locked: bill.locked_at != null,
        locked_at: bill.locked_at,
        locked_by: bill.locked_by ?? bill.approved_by ?? bill.created_by,
        voucher_id: bill.voucher_id,
        total_liters: Number(bill.system_liters) || rows.reduce((a, r) => a + (r.liters || 0), 0),
        bill_amount: Number(bill.physical_amount) || 0,
        disputed_amount: Number(bill.disputed_amount) || 0,
        payable_amount: Number(bill.payable_amount
          ?? (Number(bill.physical_amount) || 0) - (Number(bill.disputed_amount) || 0)),
        created_at: bill.created_at,
        notes: bill.notes,
      },
      lines: rows,
      source,
      source_note: source === 'RECORDED'
        ? 'These are the lines recorded when the bill was settled.'
        : source === 'FROM_SLIPS'
          ? 'Built from the memos this bill was posted against — the pump’s own '
          + 'printed figures were not kept at the time.'
          : 'Reconstructed from this pump’s memos over the period. Nothing was '
          + 'recorded against the bill itself, so treat this as evidence, not as the bill.',
      // Every derived rate on the sheet, so a reader can see how much of it is
      // an estimate rather than the pump's own number.
      rate_bases: rows.reduce((a, r) => {
        if (!r.rate_basis) return a;
        a[r.rate_basis] = (a[r.rate_basis] ?? 0) + 1;
        return a;
      }, {}),
    };
  });

  /**
   * Show the system a pump invoice, and record what happened to it.
   *
   * Every attempt is written down — read, or refused and why — because "we
   * never tried June" and "June would not read" are different problems and
   * only one of them is the pump's fault. A bill that was never shown is
   * absent from the queue; a bill that failed is in it, with its reason.
   *
   * The same file shown twice does not queue twice: the content hash sees to
   * that, and re-uploading a folder is the ordinary case, not a mistake.
   */
  app.post('/pump-bill-scan', { preHandler: guard }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.pdf_base64) return reply.code(400).send({ error: 'NO_PDF' });

    let data;
    try {
      data = Buffer.from(String(b.pdf_base64).replace(/^data:[^,]*,/, ''), 'base64');
    } catch { return reply.code(400).send({ error: 'BAD_BASE64' }); }
    if (!data.length || data.length > 25 * 1024 * 1024) {
      return reply.code(400).send({ error: 'BAD_SIZE' });
    }

    const sha = createHash('sha256').update(data).digest('hex');
    const { rows: seen } = await query(
      `SELECT * FROM v_pump_bill_queue WHERE id = (
         SELECT id FROM pump_bill_scan_queue WHERE content_sha = $1)`, [sha]);
    if (seen.length) return { queued: false, already: true, entry: seen[0] };

    const sourceFile = String(b.source_file ?? '').slice(0, 300) || 'unnamed.pdf';

    // ── what the FILENAME says, for a scan whose contents cannot be read ──
    //
    // "Alam/June 30.06.2026.pdf" carries the pump in its folder and the period
    // in its name. That is the only handle an unreadable photograph gives, and
    // it is a hint: good enough to sort a work queue, never good enough to post
    // money. The entry screen makes a person confirm both.
    const hintPump = String(b.pump_hint ?? '').trim()
      || (sourceFile.includes('/') ? sourceFile.split('/')[0].trim() : '');
    // "Apr 01-15 2026.pdf" matches the dd-mm-yyyy shape as day=01, MONTH=15 —
    // which is not a month. An invalid month means this is not a date at all,
    // so it must fall through to the range form rather than give up; four real
    // April bills landed undated in the queue before this guard was added.
    const dmRaw = /(\d{1,2})[.\-_ ](\d{1,2})[.\-_ ](\d{4})/.exec(sourceFile);
    const dm = dmRaw && Number(dmRaw[2]) >= 1 && Number(dmRaw[2]) <= 12 ? dmRaw : null;
    const range = /(\d{1,2})\s*-\s*(\d{1,2})/.exec(sourceFile.replace(/\d{4}/g, ''));
    let pf = null; let pt = null;
    if (dm) {
      const end = `${dm[3]}-${String(dm[2]).padStart(2, '0')}-${String(dm[1]).padStart(2, '0')}`;
      if (/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(end)) {
        // A bill dated the 15th covers 1–15; one dated the month end covers the
        // second half. The date on a pump bill is when it was raised.
        const d = Number(dm[1]);
        pt = end;
        pf = d <= 16
          ? `${dm[3]}-${String(dm[2]).padStart(2, '0')}-01`
          : `${dm[3]}-${String(dm[2]).padStart(2, '0')}-16`;
        if (d <= 16) pt = `${dm[3]}-${String(dm[2]).padStart(2, '0')}-15`;
      }
    } else if (range) {
      const mn = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.exec(sourceFile);
      const yr = /(20\d{2})/.exec(sourceFile);
      if (mn && yr) {
        const mi = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
          .indexOf(mn[1].toLowerCase()) + 1;
        const mm = String(mi).padStart(2, '0');
        pf = `${yr[1]}-${mm}-${String(range[1]).padStart(2, '0')}`;
        pt = `${yr[1]}-${mm}-${String(range[2]).padStart(2, '0')}`;
      }
    }

    // ── try to read it ────────────────────────────────────────────────────
    let lines = [];
    let pages = null;
    let bill = null;
    let reason = null;
    let reasonCode = null;
    try {
      ({ lines, pages } = await pdfRead(data));
    } catch (e) {
      reasonCode = 'PDF_UNREADABLE';
      reason = e.message?.slice(0, 200) ?? 'the PDF could not be opened';
    }
    if (!reasonCode) {
      try {
        bill = parsePumpBill(lines);
        if (!bill.check.ok) {
          reasonCode = 'BILL_DOES_NOT_BALANCE';
          reason = bill.check.why;
          bill = null;
        }
      } catch (e) {
        reasonCode = e.code ?? 'PARSE_FAILED';
        reason = e.message?.slice(0, 300) ?? null;
      }
    }

    const { rows: [row] } = await query(`
      INSERT INTO pump_bill_scan_queue
        (source_file, content_sha, pages, bytes, pump_hint, vendor_id, bill_no_hint,
         period_from, period_to, cycle, status, reason, reason_code, rows_found,
         text_lines, detail, uploaded_by)
      VALUES ($1,$2,$3,$4,$5,
              (SELECT id FROM vendors WHERE pump_key(vendor_name) = pump_key($5) LIMIT 1),
              $6,$7::date,$8::date,
              CASE WHEN $7::date IS NOT NULL THEN fortnight_code($7::date) END,
              $9,$10,$11,$12,$13,$14::jsonb,$15)
      ON CONFLICT (content_sha) DO NOTHING
      RETURNING id`,
      [sourceFile, sha, pages, data.length,
       hintPump || null, bill?.invoice_no ?? null,
       bill?.period_from ?? pf, bill?.period_to ?? pt,
       bill ? 'PARSED' : 'NEEDS_ENTRY', reason, reasonCode,
       bill?.rows.length ?? 0, lines.length,
       JSON.stringify(bill
         ? { format: bill.format, check: bill.check, anomalies: bill.anomalies }
         : { first_lines: lines.slice(0, 6) }),
       b.uploaded_by ?? 'desk']);

    const { rows: [entry] } = await query(
      `SELECT * FROM v_pump_bill_queue WHERE id = $1::uuid`, [row?.id ?? null]);

    return {
      queued: true,
      readable: !!bill,
      entry,
      // When it DID read, hand back the rows so the same upload can go straight
      // into the audit rather than asking for the file a second time.
      bill: bill ? {
        pump: bill.pump, invoice_no: bill.invoice_no,
        period: { from: bill.period_from, to: bill.period_to },
        check: bill.check, rows: toBulkImportRows(bill, { sourceFile }),
      } : null,
    };
  });

  /**
   * The manual queue, grouped the way it is worked: fortnight, then pump.
   *
   * A clerk works one cycle at a time because a pump BILLS one cycle at a time.
   * Sorting by upload date would scatter a single fortnight's paper down the
   * whole list and there would be no way to tell when June was finished.
   */
  app.get('/pump-bill-queue', { preHandler: guard }, async (req, reply) => {
    const status = String(req.query?.status ?? 'NEEDS_ENTRY');
    const { rows } = await query(`
      SELECT * FROM v_pump_bill_queue
       WHERE ($1 = 'ALL' OR status = $1)
       ORDER BY period_from DESC NULLS LAST, pump, bill_no_hint NULLS LAST, source_file`,
      [status]);

    // Grouped on the server so every screen that shows this queue groups it the
    // same way — and so the counts are of the whole queue, not of a page.
    const byCycle = new Map();
    for (const r of rows) {
      if (!byCycle.has(r.cycle)) {
        byCycle.set(r.cycle, {
          cycle: r.cycle, cycle_label: r.cycle_label,
          period_from: r.period_from, period_to: r.period_to,
          bills: 0, pages: 0, pumps: new Map(),
        });
      }
      const c = byCycle.get(r.cycle);
      c.bills += 1;
      c.pages += Number(r.pages) || 0;
      if (!c.pumps.has(r.pump)) c.pumps.set(r.pump, { pump: r.pump, vendor_id: r.vendor_id, bills: [] });
      c.pumps.get(r.pump).bills.push(r);
    }

    const cycles = [...byCycle.values()].map((c) => ({
      ...c,
      pumps: [...c.pumps.values()].sort((a, b) => a.pump.localeCompare(b.pump)),
    }));
    // Undated bills last: they cannot be worked as part of a cycle and would
    // otherwise sit at the top pretending to be the newest.
    cycles.sort((a, b) => (a.cycle === 'UNDATED' ? 1 : b.cycle === 'UNDATED' ? -1
      : String(b.cycle).localeCompare(String(a.cycle))));

    const { rows: [tot] } = await query(`
      SELECT count(*) FILTER (WHERE status='NEEDS_ENTRY')::int needs_entry,
             count(*) FILTER (WHERE status='PARSED')::int      parsed,
             count(*) FILTER (WHERE status='ENTERED')::int     entered,
             count(*) FILTER (WHERE status='DISCARDED')::int   discarded
        FROM pump_bill_scan_queue`);

    return { cycles, rows, totals: tot };
  });

  /** Mark one queued bill entered, or set it aside. */
  app.post('/pump-bill-queue/:id/resolve', { preHandler: guard }, async (req, reply) => {
    const status = String(req.body?.status ?? '');
    if (!['ENTERED', 'DISCARDED', 'NEEDS_ENTRY'].includes(status)) {
      return reply.code(400).send({ error: 'BAD_STATUS' });
    }
    // Setting a bill aside has to say why — otherwise "discarded" becomes the
    // quiet way a fortnight of diesel stops being anybody's problem.
    const note = String(req.body?.notes ?? '').trim();
    if (status === 'DISCARDED' && note.length < 4) {
      return reply.code(400).send({
        error: 'REASON_REQUIRED',
        detail: 'discard karne ka kaaran likhna hoga',
      });
    }
    const { rows } = await query(`
      UPDATE pump_bill_scan_queue
         SET status = $2,
             linked_bill_id = COALESCE($3::uuid, linked_bill_id),
             notes = COALESCE(NULLIF($4,''), notes),
             resolved_at = CASE WHEN $2 = 'NEEDS_ENTRY' THEN NULL ELSE now() END,
             resolved_by = CASE WHEN $2 = 'NEEDS_ENTRY' THEN NULL ELSE $5 END
       WHERE id = $1::uuid
      RETURNING id`, [req.params.id, status,
       UUID_RE.test(String(req.body?.bill_id ?? '')) ? req.body.bill_id : null,
       note, req.body?.by ?? 'desk']);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_IN_QUEUE' });
    const { rows: [entry] } = await query(
      `SELECT * FROM v_pump_bill_queue WHERE id = $1::uuid`, [req.params.id]);
    return { updated: entry };
  });

  /**
   * Save corrected lines onto a bill.
   *
   * ONLY WHILE IT IS UNLOCKED. A settled fortnight sits under a posted voucher
   * and migration 155's trigger refuses to let its figures move; this checks
   * first so the clerk gets "unlock it" rather than a database error.
   *
   * THE BILL AMOUNT FOLLOWS THE LINES. physical_amount is recomputed from what
   * the lines now say — otherwise a corrected line would leave the header
   * saying one thing and the rows another, and the header is what gets paid.
   * The disputed amount is left alone: it is a decision, not an arithmetic
   * result.
   *
   * Saving lines onto a bill that had none MATERIALISES them. That is an
   * improvement — a reconstruction becomes a record — but it is also an
   * assertion, so the response says which happened.
   */
  app.patch('/pump-bill/:id/lines', { preHandler: guard }, async (req, reply) => {
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : null;
    if (!lines) return reply.code(400).send({ error: 'NO_LINES' });

    const { rows: [bill] } = await query(
      `SELECT * FROM pump_bill_drafts WHERE id = $1::uuid`, [req.params.id]);
    if (!bill) return reply.code(404).send({ error: 'NO_SUCH_BILL' });
    if (bill.locked_at) {
      return reply.code(409).send({
        error: 'FORTNIGHT_LOCKED',
        detail: `${bill.invoice_no ?? bill.ref_no} settle ho chuka hai — pehle "Modify Bill" `
              + 'se unlock kijiye, tab lines badal sakti hain',
      });
    }

    const had = Array.isArray(bill.lines) && bill.lines.length > 0;
    const clean = lines.map((l, i) => ({
      sno: Number(l.sno) || i + 1,
      idx: Number.isFinite(Number(l.idx)) ? Number(l.idx) : i,
      date: String(l.date ?? '').slice(0, 10) || null,
      vehicle_no: l.vehicle ?? l.vehicle_no ?? l.vehicle_raw ?? null,
      vehicle_raw: l.vehicle ?? l.vehicle_raw ?? null,
      driver_name: l.driver ?? l.driver_name ?? null,
      liters: Number(l.liters ?? l.qty) || null,
      qty: Number(l.liters ?? l.qty) || null,
      rate: Number(l.billed_rate ?? l.rate) || null,
      rate_used: Number(l.billed_rate ?? l.rate) || null,
      rate_basis: l.rate_basis ?? 'EDITED',
      slip_rate: Number(l.authorised_rate ?? l.slip_rate) || null,
      amount: Number(l.amount) || 0,
      system_amount: Number(l.amount) || 0,
      id: l.memo_id ?? l.id ?? null,
      memo_no: l.memo_no ?? null,
      trip_id: l.trip_id ?? null,
      verdict: l.verdict ?? null,
      notes: Array.isArray(l.notes) ? l.notes : [],
      edited_at: l.edited ? new Date().toISOString() : (l.edited_at ?? null),
    }));

    const sumAmount = Number(clean.reduce((a, l) => a + (l.amount || 0), 0).toFixed(2));
    const sumLitres = Number(clean.reduce((a, l) => a + (l.liters || 0), 0).toFixed(3));
    const disputed = Number(bill.disputed_amount) || 0;

    const { rows: [saved] } = await query(`
      UPDATE pump_bill_drafts
         SET lines = $2::jsonb,
             slip_count = $3,
             system_liters = $4,
             physical_liters = $4,
             physical_amount = $5,
             payable_amount = $5 - COALESCE(disputed_amount, 0),
             notes = COALESCE(notes, '') || ' | lines edited ' || to_char(now(), 'DD Mon HH24:MI'),
             updated_at = now()
       WHERE id = $1::uuid
      RETURNING *`,
      [req.params.id, JSON.stringify(clean), clean.length, sumLitres, sumAmount]);

    return {
      saved: true,
      materialised: !had,
      lines: clean.length,
      total_liters: sumLitres,
      bill_amount: sumAmount,
      disputed_amount: disputed,
      payable_amount: Number((sumAmount - disputed).toFixed(2)),
      posted_payable: Number(bill.payable_amount) || 0,
      // What the ledger is still carrying versus what the bill now says. The
      // clerk sees this before deciding to post a correction.
      ledger_gap: Number(((sumAmount - disputed) - (Number(bill.payable_amount) || 0)).toFixed(2)),
      note: had ? null : 'These lines were reconstructed; saving them makes them this bill’s record.',
    };
  });

  /**
   * Bring the ledger into line with a corrected bill.
   *
   * A POSTED VOUCHER IS NEVER REWRITTEN. ledger_entries is append-only and the
   * original journal is what somebody's audit will find; the correction is a
   * SECOND journal for the difference only, which is how a correction is
   * supposed to look on paper.
   *
   *   payable went UP    Dr Fuel & HSD        Cr Creditors: <pump>
   *   payable went DOWN  Dr Creditors: <pump> Cr Fuel & HSD
   *
   * The reference carries the bill and the delta, so pressing the button twice
   * posts once.
   *
   * WHAT THIS DOES NOT DO: re-spread the change across the trips. The original
   * reconciliation moved each trip by its share; working out which trip a
   * corrected line belongs to is a per-line decision, and doing it silently
   * here would move a lorry's P&L without anybody choosing to. The response
   * says so plainly.
   */
  app.post('/pump-bill/:id/post-correction', { preHandler: guard }, async (req, reply) => {
    const { rows: [bill] } = await query(
      `SELECT b.*, v.vendor_type FROM pump_bill_drafts b
         LEFT JOIN vendors v ON v.id = b.vendor_id WHERE b.id = $1::uuid`, [req.params.id]);
    if (!bill) return reply.code(404).send({ error: 'NO_SUCH_BILL' });

    const lineSum = Array.isArray(bill.lines)
      ? Number(bill.lines.reduce((a, l) => a + (Number(l.amount ?? l.system_amount) || 0), 0).toFixed(2))
      : Number(bill.physical_amount) || 0;
    const disputed = Number(bill.disputed_amount) || 0;
    const shouldBe = Number((lineSum - disputed).toFixed(2));
    const posted = Number(bill.payable_amount) || 0;
    const delta = Number((shouldBe - posted).toFixed(2));

    if (Math.abs(delta) < 0.01) {
      return reply.code(409).send({
        error: 'NOTHING_TO_CORRECT',
        detail: `ledger pehle se ${posted.toFixed(2)} par hai — koi antar nahi`,
        payable_amount: posted,
      });
    }

    const up = delta > 0;
    const amt = Math.abs(delta);
    let voucher;
    try {
      voucher = await postVoucher({
        type: 'JOURNAL',
        source_type: 'FUEL_BILL_CORRECTION',
        // Deterministic on the bill AND the delta: pressing twice posts once,
        // and a genuinely different correction later still gets through.
        ref_no: `FUELCORR_${bill.id}_${amt.toFixed(2)}_${up ? 'DR' : 'CR'}`,
        entry_date: new Date().toISOString().slice(0, 10),
        narration: `Fuel bill correction — ${bill.vendor_name} `
                 + `${bill.period_from} to ${bill.period_to} `
                 + `(${bill.invoice_no ?? bill.ref_no}): payable ${posted.toFixed(2)} → ${shouldBe.toFixed(2)}`,
        lines: up
          ? [{ ledger: 'Direct Expenses - Fuel & HSD', dr_cr: 'DR', amount: amt,
               group: 'Direct Expenses - Fuel & HSD' },
             { ledger: `Creditors: ${bill.vendor_name}`, dr_cr: 'CR', amount: amt,
               group: /fuel|pump/i.test(bill.vendor_type ?? '') ? 'Sundry Creditors (Fuel Pumps)' : 'Sundry Creditors (Vendors)' }]
          : [{ ledger: `Creditors: ${bill.vendor_name}`, dr_cr: 'DR', amount: amt,
               group: /fuel|pump/i.test(bill.vendor_type ?? '') ? 'Sundry Creditors (Fuel Pumps)' : 'Sundry Creditors (Vendors)' },
             { ledger: 'Direct Expenses - Fuel & HSD', dr_cr: 'CR', amount: amt,
               group: 'Direct Expenses - Fuel & HSD' }],
      });
    } catch (e) {
      if (e.code === 'DUPLICATE_REF') {
        return reply.code(409).send({ error: 'ALREADY_CORRECTED', detail: e.message });
      }
      return reply.code(422).send({ error: e.code ?? 'POSTING_FAILED', detail: e.message });
    }

    // The pump's own khata moves with it.
    await query(`
      INSERT INTO vendor_txns (vendor_id, vendor_name, txn_date, txn_type, amount, remarks, voucher_id, created_by)
      VALUES ($1::uuid,$2,CURRENT_DATE,$3,$4,$5,$6::uuid,$7)`,
      [bill.vendor_id, bill.vendor_name, up ? 'BILL_RECEIVED' : 'CREDIT_NOTE', amt,
       `Correction — ${bill.invoice_no ?? bill.ref_no}: ${posted.toFixed(2)} → ${shouldBe.toFixed(2)}`,
       voucher?.voucher_id ?? null, req.body?.by ?? 'desk']).catch(() => {});

    const { rows: [after] } = await query(`
      UPDATE pump_bill_drafts
         SET physical_amount = $2, payable_amount = $3,
             notes = COALESCE(notes,'') || ' | corrected ' || to_char(now(),'DD Mon HH24:MI'),
             locked_at = now(), locked_by = $4, updated_at = now()
       WHERE id = $1::uuid RETURNING *`,
      [bill.id, lineSum, shouldBe, req.body?.by ?? 'desk']);

    const { rows: [out] } = await query(
      `SELECT * FROM v_pump_outstanding WHERE vendor_id = $1::uuid`, [bill.vendor_id]);

    return {
      corrected: true,
      delta,
      direction: up ? 'INCREASED' : 'REDUCED',
      was: posted,
      now: shouldBe,
      voucher_id: voucher?.voucher_id ?? null,
      relocked: true,
      pump_outstanding: out ?? null,
      trips_note: 'Trip-level shares were NOT re-spread. The original reconciliation '
                + 'moved each trip by its own share; which trip a corrected line belongs '
                + 'to is a per-line decision and is not made here.',
    };
  });

  /** The bill as a message a pump can read on WhatsApp. */
  app.get('/pump-bill/:id/summary-text', { preHandler: guard }, async (req, reply) => {
    const { rows: [b] } = await query(`
      SELECT d.*, COALESCE(d.invoice_no, pump_invoice_no(d.vendor_name, d.period_from)) AS invoice_no,
             fortnight_label(d.period_from) AS cycle_label, v.mobile_no
        FROM pump_bill_drafts d LEFT JOIN vendors v ON v.id = d.vendor_id
       WHERE d.id = $1::uuid`, [req.params.id]);
    if (!b) return reply.code(404).send({ error: 'NO_SUCH_BILL' });

    const inr = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const NL = String.fromCharCode(10);
    const disputed = Number(b.disputed_amount) || 0;
    const lines = Array.isArray(b.lines) ? b.lines : [];

    // Short enough to read on a phone. The pump wants the four figures and, if
    // we are holding money back, WHY — a deduction with no reason is a phone
    // call, and this message exists to prevent that call.
    let msg = `*${b.vendor_name}*${NL}`
      + `15-din ka bill — ${b.cycle_label}${NL}`
      + `Invoice: ${b.invoice_no}${NL}`
      + `Period: ${b.period_from} se ${b.period_to}${NL}${NL}`
      + `Litre: ${Number(b.system_liters || 0).toLocaleString('en-IN')}${NL}`
      + `Bill: Rs ${inr(b.physical_amount)}${NL}`;
    if (disputed > 0) {
      msg += `Rok liya: Rs ${inr(disputed)}${NL}`;
      const d = lines.filter((l) => l.verdict === 'DISPUTED' || l._disputed);
      for (const l of d.slice(0, 6)) {
        msg += `  • ${l.date ?? ''} ${l.vehicle_no ?? l.vehicle_raw ?? ''} `
             + `${l.liters ?? l.qty ?? ''}L — Rs ${inr(l.amount)}${NL}`;
      }
    }
    msg += `*Dene hain: Rs ${inr(b.payable_amount ?? (Number(b.physical_amount) || 0) - disputed)}*${NL}`;
    if (b.locked_at) msg += `${NL}(Settle ho chuka — ${new Date(b.locked_at).toLocaleDateString('en-IN')})`;

    const digits = String(b.mobile_no ?? '').replace(/\D/g, '');
    return {
      text: msg,
      mobile: b.mobile_no ?? null,
      // 91 is added only to a bare 10-digit Indian number; anything already
      // carrying a country code is left as the office entered it.
      wa_number: digits ? (digits.length === 10 ? `91${digits}` : digits) : null,
      wa_url: digits
        ? `https://wa.me/${digits.length === 10 ? `91${digits}` : digits}?text=${encodeURIComponent(msg)}`
        : null,
      note: digits ? null : `${b.vendor_name} ka mobile number vendor master me nahi hai`,
    };
  });
}
