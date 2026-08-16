// ═══════════════════════════════════════════════════════════════════════════
// periods.js — the operator's calendar, in one place.
//
// A FORTNIGHT HERE IS 1–15 AND 16–END OF MONTH. Not "the last 15 days", which
// slides every time you look at it and can never be compared with the fortnight
// before. This is the same boundary billing_cycles uses (migration 062) and the
// same one IOCL bills on, so a fortnight on this screen is the fortnight the
// invoice will cover.
//
// "16–31" IS COMPUTED, NEVER HARD-CODED. February has no 31st and a hard-coded
// one silently drops the last days of every 30-day month — which is exactly the
// kind of arithmetic that makes a report quietly wrong rather than obviously
// broken.
//
// The maths lives in JS rather than in the SQL because stepping back N
// fortnights across a year boundary is a loop, and a loop written in a CASE
// expression is a loop nobody can read.
// ═══════════════════════════════════════════════════════════════════════════

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const lastDayOf = (y, m) => new Date(y, m + 1, 0).getDate();

export const PERIODS = ['FORTNIGHT', 'MONTH', 'YEAR', 'ALL'];

/** Bounds for a period, `offset` whole periods back from today (0 = current). */
export function periodBounds(period = 'FORTNIGHT', offset = 0, now = new Date()) {
  const off = Math.max(0, Math.min(Number(offset) || 0, 120));

  if (period === 'ALL') {
    return { period, offset: 0, from: null, to: null, label: 'All time', short: 'ALL' };
  }

  if (period === 'YEAR') {
    const y = now.getFullYear() - off;
    return {
      period, offset: off,
      from: `${y}-01-01`, to: `${y}-12-31`,
      label: String(y), short: String(y),
    };
  }

  if (period === 'MONTH') {
    const d = new Date(now.getFullYear(), now.getMonth() - off, 1);
    const y = d.getFullYear(); const m = d.getMonth();
    return {
      period, offset: off,
      from: iso(new Date(y, m, 1)), to: iso(new Date(y, m, lastDayOf(y, m))),
      label: `${MONTHS[m]} ${y}`, short: `${MONTHS[m]} ${String(y).slice(2)}`,
    };
  }

  // FORTNIGHT — walk back one half-month at a time so a year boundary is just
  // another step rather than a special case.
  let y = now.getFullYear();
  let m = now.getMonth();
  let half = now.getDate() <= 15 ? 1 : 2;
  for (let i = 0; i < off; i += 1) {
    if (half === 2) half = 1;
    else { half = 2; m -= 1; if (m < 0) { m = 11; y -= 1; } }
  }
  const last = lastDayOf(y, m);
  const from = half === 1 ? new Date(y, m, 1) : new Date(y, m, 16);
  const to = half === 1 ? new Date(y, m, 15) : new Date(y, m, last);
  return {
    period: 'FORTNIGHT', offset: off,
    from: iso(from), to: iso(to),
    label: `${MONTHS[m]} ${y} · ${half === 1 ? '1–15' : `16–${last}`}`,
    short: `${MONTHS[m]} ${half === 1 ? 'H1' : 'H2'}`,
    half,
  };
}

/** The period immediately before `b`, for period-on-period comparison. */
export const previousOf = (b, now = new Date()) =>
  (b.period === 'ALL' ? null : periodBounds(b.period, b.offset + 1, now));
