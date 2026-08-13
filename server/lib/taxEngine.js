// server/lib/taxEngine.js
// ─────────────────────────────────────────────────────────────────────────────
// Deterministic TDS / GST computation for vendor & freight payments.
//
// Deliberately a pure, rule-table module — no AI, no float drift (paise math in
// integers). "Zero manual tax math" must mean the same answer every time; an
// LLM guessing tax is the opposite of that. Rates/thresholds live in one table
// an accountant can read and correct.
//
// Covered (the firm's actual cases):
//   TDS 194C  — payments to transport contractors: 1% (individual/HUF with
//               PAN), 2% (others with PAN), 20% (no PAN). Threshold: single
//               payment > ₹30,000 or ₹1,00,000 aggregate in the FY.
//               NOTE: a transporter owning ≤10 goods carriages who furnishes a
//               declaration u/s 194C(6) is EXEMPT — surfaced as an option.
//   TDS 194Q  — purchase of goods (HSD bulk buys): 0.1% on the amount
//               exceeding ₹50,00,000 aggregate per seller per FY (buyer
//               turnover > ₹10 Cr). Needs the FY aggregate, passed by caller.
//   GST RCM   — GTA freight under reverse charge: 5% (no ITC) payable by the
//               recipient; shown as a liability memo, not deducted from the
//               payment.
// This computes and explains; the accountant can override — the override is
// recorded in the voucher narration. Statutory rates as of FY 2026-27; update
// RATE_TABLE when the Finance Act changes them.
// ─────────────────────────────────────────────────────────────────────────────

const paise = (n) => Math.round(Number(n) * 100);
const rupees = (p) => (p / 100).toFixed(2);

export const RATE_TABLE = Object.freeze({
  TDS_194C: { individual_pct: 1, other_pct: 2, no_pan_pct: 20, single_threshold: 30_000, fy_threshold: 100_000 },
  TDS_194Q: { pct: 0.1, fy_threshold: 5_000_000 * 10 / 10 }, // ₹50,00,000
  GST_RCM_GTA: { pct: 5 },
});

/**
 * @param {object} p
 * @param {number} p.amount            payment amount (₹)
 * @param {'194C'|'194Q'|null} p.section
 * @param {boolean} p.hasPan
 * @param {'INDIVIDUAL'|'COMPANY'} p.deducteeType
 * @param {number} p.fyAggregate       amount already paid/purchased this FY (₹)
 * @param {boolean} p.transporterDeclaration  194C(6) small-transporter declaration on file
 * @param {boolean} p.gtaReverseCharge include GST RCM memo (freight to a GTA)
 */
export function computeTax(p) {
  const amt = paise(p.amount ?? 0);
  const agg = paise(p.fyAggregate ?? 0);
  const out = { tds: null, gst_rcm: null, notes: [] };

  if (p.section === '194C') {
    const r = RATE_TABLE.TDS_194C;
    if (p.transporterDeclaration) {
      out.notes.push('194C(6): transporter declaration on file (≤10 carriages + PAN) — NO TDS.');
    } else if (amt <= paise(r.single_threshold) && agg + amt <= paise(r.fy_threshold)) {
      out.notes.push(`194C below thresholds (single ≤ ₹${r.single_threshold.toLocaleString('en-IN')}, FY ≤ ₹${r.fy_threshold.toLocaleString('en-IN')}) — no TDS due.`);
    } else {
      const pct = !p.hasPan ? r.no_pan_pct : p.deducteeType === 'INDIVIDUAL' ? r.individual_pct : r.other_pct;
      const tdsP = Math.round((amt * pct * 100) / 10000);
      out.tds = {
        section: '194C', pct,
        amount: rupees(tdsP),
        net_payable: rupees(amt - tdsP),
        ledger: `TDS Payable 194C`,
        basis: !p.hasPan ? 'NO PAN — 20%' : p.deducteeType === 'INDIVIDUAL' ? 'individual/HUF with PAN' : 'company/firm with PAN',
      };
    }
  }

  if (p.section === '194Q') {
    const r = RATE_TABLE.TDS_194Q;
    const threshold = paise(r.fy_threshold);
    const excessBefore = Math.max(0, agg - threshold);
    const excessAfter = Math.max(0, agg + amt - threshold);
    const taxableP = excessAfter - excessBefore;
    if (taxableP <= 0) {
      out.notes.push(`194Q: FY aggregate with this payment (₹${rupees(agg + amt)}) is within the ₹50,00,000 threshold — no TDS due.`);
    } else {
      const tdsP = Math.round((taxableP * r.pct * 100) / 10000);
      out.tds = {
        section: '194Q', pct: r.pct,
        amount: rupees(tdsP),
        net_payable: rupees(amt - tdsP),
        ledger: `TDS Payable 194Q`,
        basis: `0.1% on ₹${rupees(taxableP)} exceeding the ₹50L FY threshold`,
      };
    }
  }

  if (p.gtaReverseCharge) {
    const r = RATE_TABLE.GST_RCM_GTA;
    const gstP = Math.round((amt * r.pct * 100) / 10000);
    out.gst_rcm = {
      pct: r.pct,
      amount: rupees(gstP),
      ledger: 'GST RCM Payable (GTA 5%)',
      note: 'Reverse charge: payable by recipient directly to the government — NOT deducted from the vendor payment.',
    };
  }

  return out;
}

export default { computeTax, RATE_TABLE };
