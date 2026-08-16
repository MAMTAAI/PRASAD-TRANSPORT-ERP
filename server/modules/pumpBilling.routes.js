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
}
