// src/lib/pumpBillAudit.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Line-by-line audit: the pump's invoice against the memos we actually issued.
//
// TWO SIDES, AND BOTH MATTER. A pump line with no memo is a charge nobody
// authorised. A memo with no pump line is diesel we issued that the pump has
// not billed — money we still owe, and the one a total-only check never finds,
// because the two errors cancel in a sum.
//
// THE MATCH IS ON LORRY + DATE + LITRES, never on amount. Rate revisions land
// mid-fortnight and the office and the pump disagree about the day the new rate
// starts; they cannot disagree about how much diesel went into the tank. Once
// a line and a memo are paired, the rate and the amount are COMPARED rather
// than required — and the disagreement is the finding, stated in rupees.
//
// NOTHING IS AUTO-RESOLVED THAT A PERSON WOULD WANT TO SEE. A line is settled
// by itself only when lorry, date, litres, rate and amount all agree.
// ─────────────────────────────────────────────────────────────────────────────

export const regKey = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const inr = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Days between two ISO dates, or null. */
function dayGap(a, b) {
  if (!a || !b) return null;
  const t1 = Date.parse(`${a}T00:00:00Z`);
  const t2 = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(t1) || Number.isNaN(t2)) return null;
  return Math.round(Math.abs(t1 - t2) / 86400000);
}

/** Litres agree to a tenth — a pump nozzle does not measure finer than that. */
const litresAgree = (a, b) => a != null && b != null && Math.abs(a - b) < 0.05;
/** Money agrees to the rupee; the paisa is round-off. */
const moneyAgrees = (a, b) => a != null && b != null && Math.abs(a - b) <= 1.0;
/** A rate is quoted to the paisa and is compared that way. */
const rateAgrees = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;

export const VERDICTS = {
  MATCHED:        { label: 'Milta hai',        tone: 'ok',    blocks: false },
  RATE_MISMATCH:  { label: 'Rate alag',        tone: 'warn',  blocks: true },
  QTY_MISMATCH:   { label: 'Litre alag',       tone: 'warn',  blocks: true },
  AMOUNT_MISMATCH:{ label: 'Amount alag',      tone: 'warn',  blocks: true },
  GHOST:          { label: 'Memo hi nahi',     tone: 'bad',   blocks: true },
  // A memo that is real but already spent. Distinct from GHOST on purpose:
  // GHOST sends a clerk hunting for a memo that does not exist, while this one
  // says "it exists, it is paid, do not pay it again".
  ALREADY_SETTLED:{ label: 'Pehle hi settle',  tone: 'bad',   blocks: true },
  AMBIGUOUS:      { label: 'Do memo mil rahe', tone: 'warn',  blocks: true },
  UNREADABLE:     { label: 'Line padhi nahi',  tone: 'bad',   blocks: true },
};

/**
 * Audit one parsed bill against the unbilled memos.
 *
 * @param {object[]} lines  from /fuel/parse-pdf (date, vehicle_raw, qty, rate, amount)
 * @param {object[]} slips  our memos (vehicle_no, entry_date|date, liters, rate, amount, id)
 * @param {object}   opts   { dayTolerance = 1 }
 */
export function auditBill(lines, slips, { dayTolerance = 1 } = {}) {
  const pool = (slips ?? []).map((s) => ({
    id: String(s.id),
    key: regKey(s.vehicle_no ?? s.vehicle_raw ?? s.vehicle),
    date: String(s.entry_date ?? s.date ?? '').slice(0, 10),
    liters: num(s.liters ?? s.qty),
    rate: num(s.rate),
    amount: num(s.amount),
    memo_no: s.memo_no ?? null,
    // THE DE-DUPLICATION SHIELD. A memo already carried into a pump bill must
    // never be applied to a second one. `reusable` comes from the server
    // (v_fuel_memo_settlement); anything that is not explicitly reusable is
    // treated as spent, because the safe default when the flag is missing is
    // "do not spend it twice".
    reusable: s.reusable === undefined
      ? String(s.bill_status ?? 'UNBILLED') === 'UNBILLED'
      : s.reusable === true,
    settled_label: s.settled_label ?? null,
    bill_status: s.bill_status ?? null,
    raw: s,
    taken_by: null,
  }));

  const audited = (lines ?? []).map((l, i) => {
    const key = regKey(l.vehicle_norm ?? l.vehicle_raw ?? l.vehicle_no);
    const date = String(l.date ?? '').slice(0, 10);
    const qty = num(l.qty);
    const rate = num(l.rate);
    const amount = num(l.amount);

    const base = {
      idx: i,
      sno: l.sno ?? i + 1,
      date,
      vehicle_raw: l.vehicle_raw ?? l.vehicle_no ?? null,
      vehicle_key: key,
      qty,
      rate,
      amount,
      slip_id: null,
      slip: null,
      candidates: [],
      notes: [],
    };

    if (!date || !key || qty == null) {
      return { ...base, verdict: 'UNREADABLE',
        notes: ['This line could not be read completely — check the bill by eye.'] };
    }

    // Same lorry, within a day. Free memos only — one memo cannot pay for two
    // billed fills.
    // `s.taken_by == null`, NOT `!s.taken_by`. The first line's index is 0, and
    // `!0` is true — so the memo it had already claimed looked free again and
    // the second billed fill matched the same memo. One memo paying for two
    // fills is the exact error this whole file exists to prevent.
    const near = pool.filter((s) => s.taken_by == null && s.key === key
      && dayGap(s.date, date) != null && dayGap(s.date, date) <= dayTolerance);

    // A SPENT MEMO NEVER COMPETES WITH A LIVE ONE. Splitting the pool here,
    // before anything else, is what stops an already-settled memo from making
    // a perfectly clean live memo look ambiguous — which is exactly what it did
    // until the selftest caught it. Spent memos are kept only to answer "it
    // exists, it is paid", and only when no live memo can serve the line.
    const live = near.filter((s) => s.reusable);
    const spent = near.filter((s) => !s.reusable);

    if (live.length === 0 && spent.length > 0) {
      const sp = spent[0];
      sp.taken_by = i;
      return { ...base, verdict: 'ALREADY_SETTLED', slip_id: sp.id, slip: sp.raw,
               slip_liters: sp.liters, slip_rate: sp.rate, slip_amount: sp.amount,
               settled_label: sp.settled_label,
               notes: ['⚠️ Already Settled in Bill '
                     + (sp.settled_label ? '#' + sp.settled_label : '(reference not recorded)')
                     + ' — is memo ko dobara nahi lagaya ja sakta.'] };
    }

    if (!near.length) {
      return { ...base, verdict: 'GHOST',
        notes: [`Pump billed this truck ${l.vehicle_raw ?? key} on ${date}, `
              + 'but no WhatsApp memo exists in the system.'] };
    }

    // Prefer a memo whose litres agree; that is the pairing key.
    const exactLitres = live.filter((s) => litresAgree(s.liters, qty));
    let chosen = null;
    let verdict = null;
    const notes = [];

    if (exactLitres.length === 1) {
      chosen = exactLitres[0];
    } else if (exactLitres.length > 1) {
      // Two memos for the same lorry, day and litres. A machine must not pick.
      return { ...base, verdict: 'AMBIGUOUS', candidates: exactLitres.map((s) => s.id),
        notes: [`${exactLitres.length} memos match this truck, date and quantity — `
              + 'a person must say which one this line is.'] };
    } else {
      // Litres differ. Pair with the closest so the difference can be shown,
      // and say so — this is the quantity dispute, not a match.
      chosen = live.reduce((best, s) =>
        (best == null || Math.abs((s.liters ?? 0) - qty) < Math.abs((best.liters ?? 0) - qty)) ? s : best, null);
      verdict = 'QTY_MISMATCH';
      notes.push(`Pump billed ${qty}L, Slip authorized ${chosen.liters ?? '—'}L`
        + (chosen.liters != null ? ` (${(qty - chosen.liters) > 0 ? '+' : ''}${Number((qty - chosen.liters).toFixed(2))}L)` : ''));
    }

    // Compare the rest against whichever memo was paired.
    if (!verdict && !rateAgrees(chosen.rate, rate) && chosen.rate != null && rate != null) {
      verdict = 'RATE_MISMATCH';
      notes.push(`Pump billed ${inr(rate)}, Slip authorized ${inr(chosen.rate)}`
        + ` (${rate > chosen.rate ? '+' : ''}${Number((rate - chosen.rate).toFixed(2))} per litre`
        + (qty != null ? `, ${inr((rate - chosen.rate) * qty)} on this line` : '') + ')');
    }
    if (!verdict && !moneyAgrees(chosen.amount, amount) && chosen.amount != null && amount != null) {
      verdict = 'AMOUNT_MISMATCH';
      notes.push(`Pump billed ${inr(amount)}, Slip authorized ${inr(chosen.amount)}`
        + ` (${amount > chosen.amount ? '+' : ''}${inr(Math.abs(amount - chosen.amount)).replace('₹', '₹')})`);
    }

    // A quantity dispute usually drags a rate or amount difference behind it;
    // both are shown so the desk sees the whole disagreement at once.
    if (verdict === 'QTY_MISMATCH') {
      if (chosen.rate != null && rate != null && !rateAgrees(chosen.rate, rate)) {
        notes.push(`Pump billed ${inr(rate)}, Slip authorized ${inr(chosen.rate)}`);
      }
      if (chosen.amount != null && amount != null && !moneyAgrees(chosen.amount, amount)) {
        notes.push(`Pump billed ${inr(amount)}, Slip authorized ${inr(chosen.amount)}`);
      }
    }

    // A spent memo does not become a match, however well it agrees. It is
    // reported as already settled, with the bill that settled it, so the desk
    // stops looking for it — and it still blocks the fortnight.
    if (!chosen.reusable) {
      chosen.taken_by = i;
      return { ...base, verdict: 'ALREADY_SETTLED', slip_id: chosen.id, slip: chosen.raw,
               slip_liters: chosen.liters, slip_rate: chosen.rate, slip_amount: chosen.amount,
               settled_label: chosen.settled_label,
               notes: [`⚠️ Already Settled in Bill ${chosen.settled_label
                        ? '#' + chosen.settled_label : '(reference not recorded)'} — `
                     + 'is memo ko dobara nahi lagaya ja sakta.'] };
    }

    if (!verdict) verdict = 'MATCHED';
    chosen.taken_by = i;
    return { ...base, verdict, notes, slip_id: chosen.id, slip: chosen.raw,
             slip_liters: chosen.liters, slip_rate: chosen.rate, slip_amount: chosen.amount };
  });

  // The other side: memos the pump has not billed at all.
  const unbilled = pool.filter((s) => s.taken_by == null && s.reusable).map((s) => ({
    ...s,
    note: `Memo ${s.memo_no ?? s.id} for ${s.key} on ${s.date} is not on this bill.`,
  }));

  const billed = audited.reduce((a, l) => a + (l.amount ?? 0), 0);
  const authorised = audited.reduce((a, l) => a + (l.slip_amount ?? 0), 0);
  const blocking = audited.filter((l) => VERDICTS[l.verdict]?.blocks);

  return {
    lines: audited,
    unbilled_slips: unbilled,
    summary: {
      lines: audited.length,
      matched: audited.filter((l) => l.verdict === 'MATCHED').length,
      rate_mismatch: audited.filter((l) => l.verdict === 'RATE_MISMATCH').length,
      qty_mismatch: audited.filter((l) => l.verdict === 'QTY_MISMATCH').length,
      amount_mismatch: audited.filter((l) => l.verdict === 'AMOUNT_MISMATCH').length,
      ghost: audited.filter((l) => l.verdict === 'GHOST').length,
      already_settled: audited.filter((l) => l.verdict === 'ALREADY_SETTLED').length,
      ambiguous: audited.filter((l) => l.verdict === 'AMBIGUOUS').length,
      unreadable: audited.filter((l) => l.verdict === 'UNREADABLE').length,
      unbilled_slips: unbilled.length,
      billed_amount: Number(billed.toFixed(2)),
      authorised_amount: Number(authorised.toFixed(2)),
      difference: Number((billed - authorised).toFixed(2)),
      blocking: blocking.length,
    },
  };
}

/**
 * May this bill be settled?
 *
 * THE GATE. Every flagged line has to be resolved by a person — paired to a
 * memo, accepted as the pump billed it, or disputed — before the fortnight can
 * be posted. Without this a bill with six ghost lines settles as quietly as a
 * clean one, and the pump is paid for diesel nobody issued.
 *
 * @param {object}  audit       from auditBill()
 * @param {object}  resolutions { [lineIdx]: 'LINKED' | 'ACCEPTED' | 'DISPUTED' }
 */
export function settlementGate(audit, resolutions = {}) {
  const open = audit.lines.filter((l) => VERDICTS[l.verdict]?.blocks && !resolutions[l.idx]);
  const disputed = audit.lines.filter((l) => resolutions[l.idx] === 'DISPUTED');
  return {
    ok: open.length === 0,
    open: open.length,
    open_lines: open.map((l) => ({ sno: l.sno, date: l.date, vehicle: l.vehicle_raw, verdict: l.verdict })),
    disputed: disputed.length,
    // A disputed line is resolved, but it must not be paid. The amount that may
    // be settled is the bill less what is under dispute.
    settleable_amount: Number(audit.lines
      .filter((l) => resolutions[l.idx] !== 'DISPUTED')
      .reduce((a, l) => a + (l.amount ?? 0), 0).toFixed(2)),
    why: open.length === 0 ? null
      : `${open.length} line(s) still need a decision before this 15-day bill can be settled.`,
  };
}
