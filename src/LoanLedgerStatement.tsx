// @ts-nocheck
import React, { useState, useEffect, useMemo } from 'react';
// 📜 LOAN LEDGER STATEMENT — one loan, first instalment to last, on one page.
//
// WHAT THIS IS FOR. The EMI screens next door answer "what do we owe this
// month". This one answers the question an auditor asks: show me the whole life
// of this loan, and prove the opening balance. So it is a passbook — every
// instalment the contract will ever raise, in order, with what cleared it and
// when — and it is built to be PRINTED rather than scrolled.
//
// ── WHY THE PRINT PATH IS @media print AND NOT window.open ─────────────────
// Most print buttons in this app open a blank window and write a fresh HTML
// document into it. That works for a one-page voucher. It is the wrong tool for
// a 58-row financial statement, because the printed document is then a SECOND
// implementation of the table — and the moment the two drift, the page an
// auditor signs stops matching the page the operator checked.
//
// Here the printed page IS the page on screen. The dark chrome, the sidebar, the
// nav and the buttons are hidden by media query; what remains is the statement,
// re-inked black on white. One table, one set of numbers, no second renderer to
// keep in step.
//
// The hiding is done with `visibility`, not `display:none` on the app shell.
// This component does not own the shell and cannot know how the sidebar is
// nested; making everything invisible and then turning the statement back on is
// the one technique that does not depend on the layout above it. `visibility`
// also leaves the print engine free to paginate the table properly, which
// display:none on ancestors does not.
//
// ── AND WHY THE OPENING BALANCE IS SPELLED OUT ─────────────────────────────
// A statement that prints one number called "Opening Balance" is not auditable;
// it has to be checkable. So the header prints the arithmetic — instalments due
// before the cut-off, less payments cleared before it, plus penal charges — with
// the counts beside the amounts, so anyone can re-add it from the rows below.
//
// Undated charges sit BESIDE that total, never inside it. TATA states a balance
// for LPC and legal costs without stating when they were raised, and a figure
// with no date cannot be placed on one side of a cut-off. Folding it in would
// make the statement look more precise than the paper it came from.
import { API_BASE } from './lib/apiBase';

const LOANS_API = `${API_BASE}/api/v1/loans`;

const inr = (v: any, dp = 2) =>
  Number(v ?? 0).toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });

const dmy = (d: any) => {
  if (!d) return '—';
  const s = String(d).slice(0, 10);
  const [y, m, dd] = s.split('-');
  return y && m && dd ? `${dd}-${m}-${y}` : s;
};

// Print has no colour to lean on, so status has to read as a word. On screen the
// colour is a shortcut; on paper the word is the whole signal.
const STATUS: Record<string, { label: string; colour: string }> = {
  PAID:       { label: 'Paid',      colour: '#10b981' },
  PAID_LATE:  { label: 'Paid late', colour: '#f59e0b' },
  PART_PAID:  { label: 'Part paid', colour: '#f97316' },
  OVERDUE:    { label: 'Overdue',   colour: '#ef4444' },
  UPCOMING:   { label: 'Upcoming',  colour: '#64748b' },
};

const PRINT_CSS = `
/* ── screen ────────────────────────────────────────────────────────────── */
#loan-ledger-print .lls-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
#loan-ledger-print .lls-table th,
#loan-ledger-print .lls-table td { padding: 6px 8px; border-bottom: 1px solid #334155; white-space: nowrap; }
#loan-ledger-print .lls-table th { text-align: left; color: #94a3b8; font-size: 11px;
  text-transform: uppercase; letter-spacing: .04em; border-bottom: 1px solid #475569; }
#loan-ledger-print .lls-num { text-align: right; font-variant-numeric: tabular-nums; }
#loan-ledger-print .lls-tier-break td { border-top: 2px solid #6366f1; }
#loan-ledger-print h1, #loan-ledger-print h2, #loan-ledger-print h3 { color: #f1f5f9; }
#loan-ledger-print .lls-table td { color: #e2e8f0; }

/* ── print ─────────────────────────────────────────────────────────────── */
@media print {
  @page { size: A4 landscape; margin: 12mm 10mm; }

  /* Blank the application, then bring the statement back. See the header note:
     this component cannot know how the shell around it is nested, and this is
     the one rule that does not care. */
  body * { visibility: hidden !important; }
  #loan-ledger-print, #loan-ledger-print * { visibility: visible !important; }
  #loan-ledger-print {
    position: absolute !important; left: 0; top: 0; width: 100%;
    padding: 0 !important; margin: 0 !important;
  }

  /* Controls, tabs and anything else that only makes sense with a mouse. */
  .no-print, .no-print * { display: none !important; visibility: hidden !important; }

  /* Black on white, everywhere. The screen is a dark glass theme and every one
     of those colours prints as a grey smear or eats a cartridge. */
  html, body { background: #fff !important; }
  #loan-ledger-print, #loan-ledger-print * {
    background: transparent !important; color: #000 !important;
    box-shadow: none !important; text-shadow: none !important;
    border-radius: 0 !important; font-family: Georgia, 'Times New Roman', serif !important;
  }
  #loan-ledger-print .lls-table th,
  #loan-ledger-print .lls-table td { border: 0.5pt solid #000 !important; padding: 3px 5px !important;
    font-size: 8.5pt !important; }
  #loan-ledger-print .lls-table th { background: #e8e8e8 !important;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; font-weight: 700 !important; }

  /* A 58-row statement runs to two pages. The column headings have to repeat on
     the second one, or half the numbers arrive unlabelled — and no row may be
     cut in half across the break. */
  #loan-ledger-print thead { display: table-header-group !important; }
  #loan-ledger-print tfoot { display: table-footer-group !important; }
  #loan-ledger-print tr, #loan-ledger-print .lls-keep { page-break-inside: avoid !important;
    break-inside: avoid !important; }
  #loan-ledger-print .lls-page-break { page-break-before: always !important; }

  /* The contract facts are an auto-fit grid on screen, which lands 6-then-2 on
     a 277mm page and reads as a mistake. Four across, twice, is a block. */
  #loan-ledger-print .lls-facts { grid-template-columns: repeat(4, 1fr) !important; }

  #loan-ledger-print .lls-opening { border: 1.5pt solid #000 !important; padding: 8px !important; }
  #loan-ledger-print .lls-rule { border-top: 1pt solid #000 !important; }
  /* flex, not block: the signature strip is three boxes across the foot of the
     page, and display:block stacked them into three stray underlines. */
  #loan-ledger-print .lls-print-only { display: flex !important; visibility: visible !important; }
}
.lls-print-only { display: none; }
`;

/**
 * Download what is on the page as CSV.
 *
 * Built from the SAME rows the tables render, not re-fetched and not
 * recomputed — a download that runs its own query is a second implementation
 * that drifts, and the whole point of the file is that it agrees with the
 * statement the operator just read.
 *
 * Quoting is not optional here: a lender's name carries commas
 * ("TATA CAPITAL LIMITED, GUWAHATI") and a narration carries quotes. Excel
 * reads RFC-4180, so a value is wrapped and its quotes doubled.
 */
function downloadCsv(filename: string, header: string[], rows: any[][]) {
  const cell = (v: any) => {
    const t = v == null ? '' : String(v);
    return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  const body = [header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  // The BOM is what makes Excel open a UTF-8 file as UTF-8. Without it the
  // rupee sign and the en-dashes in the year labels arrive as mojibake.
  const blob = new Blob(['﻿' + body], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const FY_HEADER = ['Financial year', 'From', 'To', 'Instalments', 'Opening liability',
  'EMI due', 'Principal repaid', 'Interest charged', 'Closing liability',
  'Cleared', 'Unpaid in year', 'Closing arrears'];

const fyRow = (y: any) => [y.fy_label, y.fy_from, y.fy_to, y.instalments,
  y.opening_liability, y.emi_due, y.principal_repaid ?? y.principal,
  y.interest_charged ?? y.interest, y.closing_liability,
  y.cleared, y.unpaid_in_year, y.closing_arrears];

const LEDGER_HEADER = ['Loan', 'Vehicle', 'Financier', 'Instalment', 'FY', 'Due date',
  'EMI due', 'Principal', 'Interest', 'Cleared on', 'Cleared amount', 'Delay days',
  'LPC / ODC', 'Outstanding', 'Status'];

const ledgerRow = (d: any, r: any) => [d.loan_account_no, d.vehicle_no, d.financier,
  r.instalment_no, r.fy_start + '-' + String((r.fy_start + 1) % 100).padStart(2, '0'),
  r.due_date, r.due_amount, r.principal_part, r.interest_part, r.cleared_date,
  r.cleared_amount, r.delay_days, r.overdue_interest, r.outstanding_after, r.status];

// The text colour is set explicitly rather than inherited. This screen sits
// inside a dark shell whose headings are styled dark-on-light elsewhere, and
// inheriting put a near-black opening balance on a near-black card — the one
// number on the page that has to be readable. Print overrides all of it to
// black on white anyway.
const card: React.CSSProperties = {
  background: '#0f172a', border: '1px solid #334155', borderRadius: 12, padding: 18,
  color: '#e2e8f0',
};
const label: React.CSSProperties = { color: '#94a3b8', fontSize: 11, textTransform: 'uppercase',
  letterSpacing: '.05em', margin: 0 };

/**
 * A loan (or a lender's whole book) read one financial year at a time.
 *
 * The Indian year runs 1 April to 31 March and the year is taken from the DUE
 * date, never the payment date — these accounts settle two and three months in
 * arrears, so a February instalment paid in May belongs to the year it fell due
 * in. Interest and principal are the contract's own split, which is what makes
 * this answer "what did this truck's finance cost in 2024-25".
 */
function FyTable({ years, showLoanColumn = false }: any) {
  if (!years?.length) return null;
  const sum = (k: string) => years.reduce((a: number, y: any) => a + Number(y[k] ?? 0), 0);
  return (
    <table className="lls-table">
      <thead>
        <tr>
          <th>Financial year</th>
          {showLoanColumn && <th>Loans</th>}
          <th style={{ textAlign: 'right' }}>EMIs</th>
          {!showLoanColumn && <th>Instalment #</th>}
          <th style={{ textAlign: 'right' }}>Opening liability</th>
          <th style={{ textAlign: 'right' }}>EMI due</th>
          <th style={{ textAlign: 'right' }}>Principal repaid</th>
          <th style={{ textAlign: 'right' }}>Interest charged</th>
          <th style={{ textAlign: 'right' }}>Closing liability</th>
          <th style={{ textAlign: 'right' }}>Cleared</th>
          <th style={{ textAlign: 'right' }}>Unpaid</th>
          <th style={{ textAlign: 'right' }}>Closing arrears</th>
          <th style={{ textAlign: 'right' }}>Closing principal</th>
        </tr>
      </thead>
      <tbody>
        {years.map((y: any) => (
          <tr key={y.fy_start}>
            <td><b>{y.fy_label}</b><br />
              <small style={{ color: '#94a3b8' }}>{dmy(y.fy_from)} → {dmy(y.fy_to)}</small></td>
            {showLoanColumn && <td>{y.loans}</td>}
            <td className="lls-num">{y.instalments}</td>
            {!showLoanColumn && (
              <td>{y.first_instalment_no != null
                ? `${String(y.first_instalment_no).padStart(3, '0')}–${String(y.last_instalment_no).padStart(3, '0')}`
                : '—'}</td>
            )}
            <td className="lls-num">{y.opening_liability == null ? '—' : inr(y.opening_liability)}</td>
            <td className="lls-num">{inr(y.emi_due)}</td>
            {/* Principal reduces the liability; interest is a finance cost and
                never touches it. Booking the moratorium year's 2,93,668 of
                interest as principal would overstate that year's profit by the
                same amount, per truck. */}
            <td className="lls-num">{inr(y.principal_repaid ?? y.principal)}</td>
            <td className="lls-num" style={{ color: '#f59e0b' }}>
              {inr(y.interest_charged ?? y.interest)}
            </td>
            <td className="lls-num">{y.closing_liability == null ? '—' : inr(y.closing_liability)}</td>
            <td className="lls-num">{inr(y.cleared)}</td>
            <td className="lls-num" style={{ color: Number(y.unpaid_in_year) > 0 ? '#ef4444' : undefined }}>
              {Number(y.unpaid_in_year) > 0 ? inr(y.unpaid_in_year) : '—'}
            </td>
            <td className="lls-num">{inr(y.closing_arrears)}</td>
            <td className="lls-num">{y.closing_principal == null ? '—' : inr(y.closing_principal)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr style={{ fontWeight: 900, borderTop: '2px solid #475569' }}>
          <td colSpan={showLoanColumn ? 3 : 3}>Whole term — {sum('instalments')} instalments</td>
          <td />
          <td className="lls-num">{inr(sum('emi_due'))}</td>
          <td className="lls-num">{inr(sum('principal_repaid') || sum('principal'))}</td>
          <td className="lls-num">{inr(sum('interest_charged') || sum('interest'))}</td>
          <td />
          <td className="lls-num">{inr(sum('cleared'))}</td>
          <td className="lls-num">{inr(sum('unpaid_in_year'))}</td>
          <td colSpan={2} />
        </tr>
      </tfoot>
    </table>
  );
}

export default function LoanLedgerStatement({ loans = [], initialLoanNo = null }) {
  // The selection is a SCOPE, not a loan number. A finance company is as
  // legitimate a thing to ask about as a truck — one RTGS settles thirteen of
  // them, one statement covers twenty-seven contracts — so the picker offers
  // both and the response says which it answered.
  const [sel, setSel] = useState(initialLoanNo ? { kind: 'LOAN', value: initialLoanNo } : null);
  const [asOf, setAsOf] = useState('2026-04-01');
  const [view, setView] = useState('BOTH');          // YEARS | LEDGER | BOTH
  // '' = the whole term. A year is picked to print or export ONE financial
  // year, which is what a return or an audit actually asks for; the statement
  // still holds every year so switching costs nothing.
  const [fy, setFy] = useState('');
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // The loan list comes from the parent where there is one — LoanEmiMgmt has
  // already paid for that fetch — and is fetched here only when this component
  // is used on its own.
  const [ownLoans, setOwnLoans] = useState([]);
  const [financiers, setFinanciers] = useState([]);
  // Whether the financier list has ANSWERED, not whether it is non-empty.
  // The auto-selection below prefers a lender's whole book, and without
  // this it raced: the loan list arrives from the parent synchronously, so
  // the picker settled on one arbitrary contract before the groups existed
  // and then never moved, because a selection had been made.
  const [financiersLoaded, setFinanciersLoaded] = useState(false);

  const options = useMemo(() => {
    const src = loans?.length ? loans : ownLoans;
    return src
      .map((l: any) => ({
        loan_no: l.loan_account_no ?? l.Loan_Account_No ?? '',
        vehicle: l.vehicle_no ?? l.Vehicle_No ?? '',
        bank: l.bank_name ?? l.Bank_Name ?? '',
        type: l.loan_type ?? l.Loan_Type ?? '',
      }))
      .filter((o) => o.loan_no)
      .sort((a, b) => (a.vehicle + a.loan_no).localeCompare(b.vehicle + b.loan_no));
  }, [loans, ownLoans]);

  useEffect(() => {
    fetch(`${LOANS_API}/financiers`)
      .then((r) => r.json())
      .then((j) => setFinanciers(j.financiers ?? []))
      .catch(() => {})
      .finally(() => setFinanciersLoaded(true));
  }, []);

  useEffect(() => {
    if (loans?.length) return;
    fetch(`${LOANS_API}/emi-tracker?months_ahead=0`)
      .then((r) => r.json())
      .then((j) => setOwnLoans((j.tracker ?? []).map((t: any) => ({
        loan_account_no: t.loan_no, vehicle_no: t.vehicle,
        bank_name: t.financier, loan_type: t.loan_type }))))
      .catch(() => {});
  }, [loans]);

  // Open on the biggest lender's whole book rather than one arbitrary contract:
  // the first thing anyone wants is the shape of what is owed, not truck one.
  useEffect(() => {
    if (sel || !financiersLoaded) return;
    if (financiers.length) setSel({ kind: 'FINANCIER', value: financiers[0].financier });
    else if (options.length) setSel({ kind: 'LOAN', value: options[0].loan_no });
  }, [financiers, financiersLoaded, options, sel]);

  useEffect(() => {
    if (!sel) return;
    let dead = false;
    setLoading(true); setError(null);
    const param = sel.kind === 'FINANCIER' ? 'financier' : 'loan_no';
    fetch(`${LOANS_API}/ledger?${param}=${encodeURIComponent(sel.value)}&as_of=${asOf}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.detail || j.error || `HTTP ${r.status}`);
        return j;
      })
      .then((j) => { if (!dead) setPayload(j); })
      .catch((e) => { if (!dead) { setError(e.message); setPayload(null); } })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [sel, asOf]);

  const statement = payload?.statement ?? [];
  const isGroup = payload?.scope === 'FINANCIER';
  const data = statement[0] ?? null;

  // Every year the selection spans, in order. Taken from the statement rather
  // than assumed, because a body loan runs five years and the chassis loan
  // beside it runs six.
  const fyOptions = useMemo(() => {
    const seen = new Map<number, string>();
    for (const l of statement) {
      for (const y of (l.financial_years ?? [])) seen.set(y.fy_start, y.fy_label);
    }
    return [...seen.entries()].sort((x, y) => x[0] - y[0])
      .map(([start, labelText]) => ({ start, label: labelText }));
  }, [statement]);

  // A year that is no longer in range stops being selected, rather than
  // silently filtering everything away and showing an empty statement.
  useEffect(() => {
    if (fy && !fyOptions.some((o) => String(o.start) === fy)) setFy('');
  }, [fyOptions, fy]);

  const scopeName = (isGroup ? (payload?.financier ?? 'group') : (data?.loan_account_no ?? 'loan'))
    .replace(/[^A-Za-z0-9]+/g, '-');
  const yearTag = fy ? '-' + (fyOptions.find((o) => String(o.start) === fy)?.label ?? fy) : '';
  const keep = (y: any) => !fy || String(y.fy_start) === fy;

  const downloadYears = () => {
    const rows: any[][] = [];
    // The group's own totals lead the file when a group is on screen, so the
    // figure the balance sheet carries is the first thing in it.
    if (isGroup) {
      for (const y of (payload.group_financial_years ?? []).filter(keep)) {
        rows.push([payload.financier + ' — ALL LOANS', ...fyRow(y).slice(0)]);
      }
    }
    for (const l of statement) {
      for (const y of (l.financial_years ?? []).filter(keep)) {
        rows.push([l.vehicle_no + ' ' + l.loan_account_no + ' (' + (l.loan_type ?? '') + ')',
          ...fyRow(y)]);
      }
    }
    downloadCsv('loan-year-summary-' + scopeName + yearTag + '.csv',
      ['Loan', ...FY_HEADER], rows);
  };

  const downloadLedger = () => {
    const rows: any[][] = [];
    for (const l of statement) {
      for (const r of (l.rows ?? [])) {
        if (fy && String(r.fy_start) !== fy) continue;
        rows.push(ledgerRow(l, r));
      }
    }
    downloadCsv('loan-ledger-' + scopeName + yearTag + '.csv', LEDGER_HEADER, rows);
  };

  return (
    <div>
      <style>{PRINT_CSS}</style>

      {/* ── controls: on screen only ─────────────────────────────────────── */}
      <div className="no-print" style={{ display: 'flex', gap: 12, flexWrap: 'wrap',
        alignItems: 'flex-end', marginBottom: 16 }}>
        <div>
          <p style={label}>Finance company / loan</p>
          {/* Groups first. Most questions about these accounts are asked about a
              LENDER, not a truck: one RTGS settles thirteen of them and one
              statement covers twenty-seven contracts. */}
          <select
            className="modern-input"
            value={sel ? sel.kind + ':' + sel.value : ''}
            onChange={(e) => {
              const raw = e.target.value;
              const i = raw.indexOf(':');
              setSel({ kind: raw.slice(0, i), value: raw.slice(i + 1) });
            }}
            style={{ background: '#1e293b', minWidth: 380 }}>
            {!!financiers.length && (
              <optgroup label="Finance company — whole book">
                {financiers.map((f: any) => (
                  <option key={f.financier} value={'FINANCIER:' + f.financier}>
                    📁 {f.financier} — {f.loans} loans, {f.vehicles} vehicles
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="Single loan">
              {options.map((o) => (
                <option key={o.loan_no} value={'LOAN:' + o.loan_no}>
                  {o.vehicle} — {o.loan_no} — {o.type || o.bank}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <div>
          <p style={label}>Opening balance struck at</p>
          <input type="date" className="modern-input" value={asOf}
            onChange={(e) => setAsOf(e.target.value)} style={{ background: '#1e293b' }} />
        </div>
        <div>
          <p style={label}>Show</p>
          <select className="modern-input" value={view} onChange={(e) => setView(e.target.value)}
            style={{ background: '#1e293b' }}>
            <option value="BOTH">Year summary + full ledger</option>
            <option value="YEARS">Financial year summary only</option>
            <option value="LEDGER">Full ledger only (start to end)</option>
          </select>
        </div>
        <div>
          <p style={label}>Financial year</p>
          <select className="modern-input" value={fy} onChange={(e) => setFy(e.target.value)}
            style={{ background: '#1e293b' }}>
            <option value="">Whole term — every year</option>
            {fyOptions.map((o) => (
              <option key={o.start} value={String(o.start)}>{o.label}</option>
            ))}
          </select>
        </div>
        <button className="glow-btn" onClick={() => window.print()}
          style={{ background: '#334155', border: '1px solid #475569' }}>
          🖨️ Print {fy ? fyOptions.find((o) => String(o.start) === fy)?.label : 'PDF'}
        </button>
        <button className="glow-btn" onClick={downloadYears}
          style={{ background: '#0f766e', border: '1px solid #14b8a6' }}>
          ⬇️ Year summary CSV
        </button>
        <button className="glow-btn" onClick={downloadLedger}
          style={{ background: '#0f766e', border: '1px solid #14b8a6' }}>
          ⬇️ Full ledger CSV
        </button>
      </div>

      {loading && <p style={{ color: '#818cf8' }}>Building statement…</p>}
      {error && <p style={{ color: '#ef4444' }}>Could not load the ledger: {error}</p>}
      {!loading && !error && !statement.length && (
        <p style={{ color: '#94a3b8' }}>Select a finance company or a loan.</p>
      )}

      {!!statement.length && (
        <div id="loan-ledger-print" style={{ ...card }}>

          {/* ── GROUP: the lender's whole book, before the contracts ───── */}
          {isGroup && payload.group && (
            <div className="lls-keep" style={{ marginBottom: 22 }}>
              <div style={{ textAlign: 'center', paddingBottom: 12,
                borderBottom: '2px solid #334155', marginBottom: 16 }}>
                <h1 style={{ margin: 0, fontSize: 26, fontWeight: 900, letterSpacing: 2 }}>
                  PRASAD TRANSPORT
                </h1>
                <div style={{ fontSize: 13, marginTop: 4, letterSpacing: 1 }}>
                  LOAN LEDGER STATEMENT — {payload.group.financier}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                  {payload.group.loans} contracts · {payload.group.vehicles} vehicles ·
                  {' '}{dmy(payload.group.first_disbursal)} → {dmy(payload.group.last_maturity)}
                </div>
              </div>

              <div className="lls-facts" style={{ display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
                {[
                  ['Financed', '₹' + inr(payload.group.financed)],
                  ['Contracted interest', '₹' + inr(payload.group.contracted_interest)],
                  ['Contract value', '₹' + inr(payload.group.contract_value)],
                  ['Principal outstanding', '₹' + inr(payload.group.principal_outstanding)],
                  ['Received to date', '₹' + inr(payload.group.total_received)],
                  ['Payable now', '₹' + inr(payload.group.payable_now)],
                  ['Penal outstanding', '₹' + inr(payload.group.penal_outstanding)],
                  ['Worst delay', payload.group.worst_days_overdue != null
                    ? payload.group.worst_days_overdue + ' days' : '—'],
                ].map(([k, v]) => (
                  <div key={k as string}>
                    <p style={label}>{k}</p>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{v as any}</div>
                  </div>
                ))}
              </div>

              {/* A group whose figure is partly modelled says so on its own face.
                  IndusInd's three arrive as photographs — no instalment ledger,
                  nothing to reconcile — and averaged into one number they would
                  quietly poison it. */}
              {payload.group.loans_with_ledger < payload.group.loans && (
                <div style={{ padding: 10, border: '1px solid #f59e0b', borderRadius: 6,
                  fontSize: 12, marginBottom: 14 }}>
                  <b>{payload.group.loans - payload.group.loans_with_ledger} of{' '}
                  {payload.group.loans} contracts in this group have no lender ledger.</b>
                  {' '}Their figures are modelled from the contract, not read off a statement,
                  so this group's arrears cannot be reconciled against the lender end to end.
                </div>
              )}

              {view !== 'LEDGER' && (
                <>
                  <p style={label}>
                    Financial year summary — whole group
                    {fy ? ' — ' + (fyOptions.find((o) => String(o.start) === fy)?.label ?? '') : ''}
                  </p>
                  <FyTable showLoanColumn
                    years={(payload.group_financial_years ?? [])
                      .filter((y: any) => !fy || String(y.fy_start) === fy)} />
                </>
              )}
            </div>
          )}

          {statement.map((d: any, idx: number) => (
            <LoanBlock key={d.loan_id} data={d} asOf={asOf} view={view} fy={fy}
              pageBreak={isGroup && idx > 0} />
          ))}

          {/* No `display` in this inline style. An inline display beats the
              `.lls-print-only { display: none }` rule and the signature strip
              would sit on the screen too, where it means nothing — the print
              block sets `display: flex !important` instead. */}
          <div className="lls-print-only" style={{ marginTop: 26,
            justifyContent: 'space-between', fontSize: 11 }}>
            <div style={{ borderTop: '1px solid #000', paddingTop: 6, width: 200,
              textAlign: 'center' }}>Prepared by</div>
            <div style={{ borderTop: '1px solid #000', paddingTop: 6, width: 200,
              textAlign: 'center' }}>Checked by</div>
            <div style={{ borderTop: '1px solid #000', paddingTop: 6, width: 200,
              textAlign: 'center' }}>Authorised signatory</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One contract: its facts, its opening balance, its years and its instalments. */
function LoanBlock({ data, asOf, view, fy, pageBreak }: any) {
  // One year, or the whole term. Filtered here rather than at the fetch so the
  // year can be changed without another round trip, and so the totals below
  // are the totals OF WHAT IS SHOWN — a footer that sums rows the reader
  // cannot see is worse than no footer.
  const allRows = data?.rows ?? [];
  const rows = fy ? allRows.filter((r: any) => String(r.fy_start) === fy) : allRows;
  const years = (data?.financial_years ?? []).filter(
    (y: any) => !fy || String(y.fy_start) === fy);
  const open = data?.opening ?? null;
  const tot = data?.totals ?? {};

  // Where the instalment amount changes, the statement says so. A reader who
  // sees 30,285 for five rows and then 1,12,987 should not have to wonder
  // whether the sixth row is a typo.
  const tierStarts = useMemo(() => {
    const s = new Set<number>();
    (data?.tiers ?? []).forEach((t: any) => { if (t.from_instalment > 1) s.add(t.from_instalment); });
    return s;
  }, [data]);

  return (
    <section className={pageBreak ? 'lls-page-break' : ''} style={{ marginBottom: 26 }}>

      {/* ── letterhead ────────────────────────────────────────────── */}
      <div className="lls-keep" style={{ textAlign: 'center', paddingBottom: 12,
        borderBottom: '2px solid #334155', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 900, letterSpacing: 2 }}>
          {data.vehicle_no} · {data.loan_type || 'Loan'}
        </h1>
        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>
          {data.financier} · Contract {data.loan_account_no}
          {data.company_name ? ' · ' + data.company_name : ''}
        </div>
      </div>

      {/* ── contract facts, including the moratorium ──────────────── */}
      <div className="lls-keep lls-facts" style={{ display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        {[
          ['Disbursed', dmy(data.disbursal_date)],
          ['First instalment', dmy(data.first_emi_date)],
          // The moratorium is a contract fact, not a footnote: these two dates
          // are not one month apart and every date below depends on it.
          ['Moratorium', data.lead_period_days == null ? '—'
            : data.lead_period_days + ' days (' + (data.moratorium_months ?? 0) + ' mo)'],
          ['Maturity', dmy(data.maturity_date)],
          ['Finance amount', '₹' + inr(data.principal_amt)],
          ['Contracted interest', data.interest_amt ? '₹' + inr(data.interest_amt) : '—'],
          ['Contract value', data.contract_value ? '₹' + inr(data.contract_value) : '—'],
          ['Instalments', data.instalment_count ?? data.instalments_total],
          ['Rate (solved)', data.rate_of_interest
            ? Number(data.rate_of_interest).toFixed(4) + '%' : '—'],
        ].map(([k, v]) => (
          <div key={k as string}>
            <p style={label}>{k}</p>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{v as any}</div>
          </div>
        ))}
      </div>

      {/* ── the step-up pattern, stated ───────────────────────────── */}
      {!!(data.tiers ?? []).length && (
        <div className="lls-keep" style={{ marginBottom: 14, fontSize: 12 }}>
          <p style={label}>Instalment pattern</p>
          {(data.tiers ?? []).map((t: any) => (
            <span key={t.from_instalment} style={{ marginRight: 18 }}>
              <b>{String(t.from_instalment).padStart(3, '0')}–{String(t.to_instalment).padStart(3, '0')}</b>
              {' '}₹{inr(t.emi_amount)}
            </span>
          ))}
        </div>
      )}

      {/* ── OPENING BALANCE, with its arithmetic ──────────────────── */}
      <div className="lls-opening lls-keep" style={{ border: '2px solid #6366f1', borderRadius: 10,
        padding: 14, marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 15, letterSpacing: 1 }}>
            OPENING BALANCE AS ON {dmy(asOf)}
          </h2>
          <div style={{ fontSize: 24, fontWeight: 900 }}>
            {data.has_ledger_history ? '₹' + inr(open?.opening_balance) : 'NOT ON RECORD'}
          </div>
        </div>

        {/* ZERO ARREARS AND ZERO HISTORY ARE NOT THE SAME THING, and this is the
            one place a statement could quietly say they are. */}
        {!data.has_ledger_history && (
          <div style={{ marginTop: 10, padding: 10, border: '1px solid #f59e0b',
            borderRadius: 6, fontSize: 12 }}>
            <b>No transaction history is held for this loan</b>, so arrears cannot be
            struck at a cut-off and the figures below are not evidence of anything.
            {Number(data.book_principal_outstanding) > 0 && (
              <> The principal outstanding carried in the books is{' '}
                <b>₹{inr(data.book_principal_outstanding)}</b>
                {data.book_position_as_of ? ' as on ' + dmy(data.book_position_as_of) : ''},
                taken from the lender's own stated position.</>
            )}
            {' '}Principal outstanding is what is owed; arrears are what is overdue.
            They are different figures and neither substitutes for the other.
          </div>
        )}

        <table style={{ width: '100%', marginTop: 10, fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          opacity: data.has_ledger_history ? 1 : 0.55 }}>
          <tbody>
            <tr>
              <td>Instalments due before {dmy(asOf)} ({open?.emis_due_count ?? 0} EMIs)</td>
              <td className="lls-num" style={{ textAlign: 'right' }}>₹{inr(open?.emis_due_before)}</td>
            </tr>
            <tr>
              <td>Less: payments cleared before {dmy(asOf)} ({open?.payments_count ?? 0} receipts)</td>
              <td className="lls-num" style={{ textAlign: 'right' }}>(₹{inr(open?.payments_before)})</td>
            </tr>
            <tr>
              <td>Add: LPC / bounce &amp; penal charges raised before {dmy(asOf)}</td>
              <td className="lls-num" style={{ textAlign: 'right' }}>₹{inr(open?.penal_charges_before)}</td>
            </tr>
            <tr className="lls-rule" style={{ borderTop: '1px solid #475569', fontWeight: 900 }}>
              <td style={{ paddingTop: 6 }}>Opening balance (arrears carried forward)</td>
              <td className="lls-num" style={{ textAlign: 'right', paddingTop: 6 }}>
                ₹{inr(open?.opening_balance)}
              </td>
            </tr>
          </tbody>
        </table>

        {/* Reported beside the total, never inside it — the lender states a
            balance for these and no date, and a cut-off cannot be applied to a
            figure that has none. */}
        {(Number(open?.undated_penal_outstanding) > 0
          || Number(open?.accrued_overdue_interest) > 0) && (
          <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px dashed #475569',
            fontSize: 11, color: '#94a3b8' }}>
            {Number(open?.undated_penal_outstanding) > 0 && (
              <div>Memo — penal charges outstanding, undated on the lender's statement:{' '}
                <b style={{ color: '#e2e8f0' }}>₹{inr(open?.undated_penal_outstanding)}</b>.
                {' '}Excluded above because the lender does not state when they were raised.</div>
            )}
            {Number(open?.accrued_overdue_interest) > 0 && (
              <div style={{ marginTop: 3 }}>Memo — overdue interest accrued on instalments due
                before the cut-off: <b style={{ color: '#e2e8f0' }}>₹{inr(open?.accrued_overdue_interest)}</b>.
                {' '}The lender discloses this as an accrual; it is not a sum it has debited.</div>
            )}
          </div>
        )}
      </div>

      {/* ── year by year ─────────────────────────────────────────── */}
      {view !== 'LEDGER' && !!years.length && (
        <div style={{ marginBottom: 18 }}>
          <p style={label}>
            Financial year summary — {years.length} year{years.length === 1 ? '' : 's'},{' '}
            {dmy(years[0].fy_from)} to {dmy(years[years.length - 1].fy_to)}
          </p>
          <FyTable years={years} />
        </div>
      )}

      {/* ── the passbook, first instalment to last ───────────────── */}
      {view !== 'YEARS' && (
        <table className="lls-table">
          <thead>
            <tr>
              <th>#</th>
              <th>EMI due date</th>
              <th>FY</th>
              <th style={{ textAlign: 'right' }}>EMI due</th>
              <th style={{ textAlign: 'right' }}>Principal</th>
              <th style={{ textAlign: 'right' }}>Interest</th>
              <th>Cleared on</th>
              <th style={{ textAlign: 'right' }}>Cleared amt</th>
              <th style={{ textAlign: 'right' }}>Delay (d)</th>
              <th style={{ textAlign: 'right' }}>LPC / ODC</th>
              <th style={{ textAlign: 'right' }}>Outstanding</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: any, i: number) => {
              const st = STATUS[r.status] ?? { label: r.status, colour: '#94a3b8' };
              const preCutoff = String(r.due_date).slice(0, 10) < asOf;
              // A rule where the financial year turns, so a reader can find
              // 2024-25 in a 58-row list without counting.
              const fyTurn = i > 0 && rows[i - 1].fy_start !== r.fy_start;
              return (
                <tr key={r.instalment_no}
                    className={(fyTurn || tierStarts.has(r.instalment_no)) ? 'lls-tier-break' : ''}
                    style={{ opacity: preCutoff ? 0.75 : 1 }}>
                  <td>{String(r.instalment_no).padStart(3, '0')}</td>
                  <td>{dmy(r.due_date)}</td>
                  <td style={{ color: '#94a3b8' }}>
                    {r.fy_start}-{String((r.fy_start + 1) % 100).padStart(2, '0')}
                  </td>
                  <td className="lls-num">{inr(r.due_amount)}</td>
                  <td className="lls-num">{r.principal_part == null ? '—' : inr(r.principal_part)}</td>
                  <td className="lls-num">{r.interest_part == null ? '—' : inr(r.interest_part)}</td>
                  <td>{dmy(r.cleared_date)}</td>
                  <td className="lls-num">
                    {Number(r.cleared_amount) > 0 ? inr(r.cleared_amount) : '—'}
                  </td>
                  <td className="lls-num">{r.delay_days ?? '—'}</td>
                  <td className="lls-num">
                    {Number(r.overdue_interest) > 0 ? inr(r.overdue_interest) : '—'}
                  </td>
                  <td className="lls-num">{inr(r.outstanding_after)}</td>
                  <td style={{ color: st.colour }}>{st.label}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 900, borderTop: '2px solid #475569' }}>
              <td colSpan={3}>
                {fy ? 'Year' : 'Total'} — {rows.length} instalment{rows.length === 1 ? '' : 's'}
              </td>
              <td className="lls-num">
                {inr(rows.reduce((a: number, r: any) => a + Number(r.due_amount ?? 0), 0))}
              </td>
              <td className="lls-num">
                {inr(rows.reduce((a: number, r: any) => a + Number(r.principal_part ?? 0), 0))}
              </td>
              <td className="lls-num">
                {inr(rows.reduce((a: number, r: any) => a + Number(r.interest_part ?? 0), 0))}
              </td>
              <td />
              <td className="lls-num">
                {inr(rows.reduce((a: number, r: any) => a + Number(r.cleared_amount ?? 0), 0))}
              </td>
              <td />
              <td className="lls-num">
                {inr(rows.reduce((a: number, r: any) => a + Number(r.overdue_interest ?? 0), 0))}
              </td>
              <td className="lls-num">
                {rows.length ? inr(rows[rows.length - 1].outstanding_after) : inr(0)}
              </td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}

      {/* ── charges, and the reconciliation the statement rests on ── */}
      {!!(data.charges ?? []).length && (
        <div className="lls-keep" style={{ marginTop: 18 }}>
          <p style={label}>Charges on the account</p>
          <table className="lls-table" style={{ maxWidth: 640 }}>
            <thead>
              <tr>
                <th>Head</th>
                <th style={{ textAlign: 'right' }}>Charged</th>
                <th style={{ textAlign: 'right' }}>Recovered</th>
                <th style={{ textAlign: 'right' }}>Outstanding</th>
                <th>Penal?</th>
              </tr>
            </thead>
            <tbody>
              {(data.charges ?? []).map((c: any, i: number) => (
                <tr key={i}>
                  <td>{c.head}</td>
                  <td className="lls-num">{inr(c.charged)}</td>
                  <td className="lls-num">{inr(c.recovered)}</td>
                  <td className="lls-num">{inr(c.outstanding)}</td>
                  <td>{c.is_penal ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="lls-keep" style={{ marginTop: 18, paddingTop: 10,
        borderTop: '1px solid #334155', fontSize: 11, color: '#94a3b8',
        display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
        <div>
          {data.from_lender_statement
            ? 'Instalments and receipts as recorded by ' + data.financier
              + (data.statement_as_of ? ', statement dated ' + dmy(data.statement_as_of) : '') + '.'
            : 'Instalments modelled from the contract; no lender statement loaded.'}
          {data.health && (
            <>
              {' '}Reconciliation against the lender's closing balance:{' '}
              <b style={{ color: Number(data.health.drift) === 0 ? '#10b981' : '#ef4444' }}>
                {Number(data.health.drift) === 0
                  ? 'agrees' : 'differs by ₹' + inr(data.health.drift)}
              </b>.
            </>
          )}
        </div>
        <div>
          Payments are applied first-in-first-out; the lender does not allocate
          receipts to instalments.
        </div>
      </div>
    </section>
  );
}
