// server/lib/monthEnd.js
// ─────────────────────────────────────────────────────────────────────────────
// Month-end in DRAFT mode (migration 175): settle every trip of the month,
// build both payroll runs, write one slip per person and render its PDF —
// and stop there. Nothing here posts a voucher. The scheduler's 1st-of-month
// agent and the "Run Monthly Settlement" button both call prepareMonth(); a
// manager posts from the Approval Queue (payroll.routes.js).
// ─────────────────────────────────────────────────────────────────────────────
import { query } from '../db/pool.js';
import { payslipPdf } from './payslipPdf.js';
import { put } from './storage.js';

const slug = (s) => String(s ?? '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
export const money = (n) => '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Render (or re-render) the PDF of every slip of a firm-month; returns counts. */
export async function renderSlips(firm, period, onlyId = null) {
  const { rows: [f] } = await query(`SELECT company_name, address, city, state, gstin::text AS gstin, pan_no::text AS pan_no FROM companies WHERE id = $1::uuid`, [firm]);
  const { rows: slips } = await query(`SELECT * FROM payroll_slips WHERE company_id = $1::uuid AND period = $2 AND ($3::uuid IS NULL OR id = $3::uuid)`, [firm, period, onlyId]);
  let ok = 0, failed = 0; const errors = [];
  for (const s of slips) {
    try {
      const bytes = await payslipPdf(s, f ?? {});
      const key = `payslips/${period}/${slug(f?.company_name ?? 'firm')}/${slug(s.person_name)}-${s.id.slice(0, 8)}.pdf`;
      await put(key, Buffer.from(bytes), 'application/pdf');
      await query(`UPDATE payroll_slips SET file_key = $2 WHERE id = $1::uuid`, [s.id, key]);
      ok += 1;
    } catch (e) { failed += 1; errors.push(`${s.person_name}: ${e.message}`); }
  }
  return { rendered: ok, failed, total: slips.length, errors: errors.slice(0, 5) };
}

/** Draft the month for one firm: settlements, runs, slips, PDFs. Returns the month_end_runs row. */
export async function prepareMonth(firm, period, by = 'agent') {
  const { rows: [p] } = await query(`SELECT month_end_prepare($1::uuid, $2, $3) AS id`, [firm, period, by]);
  const pdfs = await renderSlips(firm, period);
  await query(`UPDATE month_end_runs SET prepared_at = coalesce(prepared_at, now()), prepared_by = coalesce(prepared_by, $2), summary = coalesce(summary, '{}'::jsonb) || $3::jsonb, updated_at = now() WHERE id = $1::uuid`, [p.id, by, JSON.stringify({ pdfs, prepared_by: by })]);
  const { rows: [run] } = await query(`SELECT m.*, c.company_name FROM month_end_runs m JOIN companies c ON c.id = m.company_id WHERE m.id = $1::uuid`, [p.id]);
  return { run, pdfs };
}

/** The message a driver reads on WhatsApp for one slip. */
export function slipText(slip, firmName) {
  const lines = Array.isArray(slip.lines) ? slip.lines : [];
  const head = `*${firmName}*\n${slip.kind === 'TRIP' ? 'Trip settlement' : slip.kind === 'MONTHLY' ? 'Monthly salary' : 'Salary / remuneration'} · ${slip.period}\n${slip.person_name}`;
  if (slip.kind === 'TRIP') {
    const trips = lines.map((l) => `• ${l.trip} ${l.vehicle ?? ''}: earned ${money(l.earning)} − korki ${money(Number(l.advances || 0) + Number(l.shortage || 0) + Number(l.challans || 0) + Number(l.manual || 0))} = ${money(l.net)} (${l.status === 'PAID' ? 'paid' : l.status === 'BLOCKED' ? 'blocked' : 'due'})`).join('\n');
    return `${head}\n\nTrips this month: ${slip.trips}\n${trips}\n\nEarned: ${money(slip.earned)}\nAdvances / cash taken: ${money(slip.advances)}\nShortage / challans: ${money(slip.korki)}\nPaid to you: ${money(slip.paid)}\nClosing balance: ${money(Math.abs(Number(slip.closing)))} ${Number(slip.closing) > 0 ? '(you owe the company)' : Number(slip.closing) < 0 ? '(company owes you)' : '(settled — zero balance)'}${slip.note ? `\n\nNote: ${slip.note}` : ''}`;
  }
  const l = lines[0] ?? {};
  return `${head}\n\nGross: ${money(slip.earned)}\nAdvances recovered: ${money(slip.advances)}\nOther deductions: ${money(Math.max(0, Number(slip.korki) - Number(slip.advances)))}\nNet payable: ${money(l.net ?? Number(slip.earned) - Number(slip.korki))}\nStatus: ${l.status === 'PAID' ? 'paid' : l.status === 'POSTED' ? 'approved, awaiting payment' : 'draft'}${slip.note ? `\n\nNote: ${slip.note}` : ''}`;
}
