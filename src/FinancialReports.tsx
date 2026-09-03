// @ts-nocheck
// 📊 BALANCE SHEET / P&L (CA-READY) — live PostgreSQL, zero Firestore.
//
// The statements are no longer assembled in the browser. They come from the
// chart of accounts in the database (`f_profit_and_loss`, `f_balance_sheet`,
// `f_trial_balance`, migrations 011–021), which matters for one reason: the old
// screen derived revenue from trip fields and expenses from Firestore ledger
// groups, so the P&L and the balance sheet were two independent calculations
// that could — and did — disagree. Now both are projections of the same ledger,
// and the balance sheet returns `balanced` so it announces its own health.
//
// Two filters were dropped rather than faked. The ledger has no vehicle
// dimension, and the old vehicle filter simply blanked most of the balance sheet
// when set; per-vehicle profitability belongs in the trip reports. Branch is not
// carried consistently on postings either. Company IS honoured, via the same
// normalizing match the rest of the ERP uses (M/S PRASAD TRANSPORT ==
// PRASAD TRANSPORT), so a company-scoped statement no longer silently drops the
// 616 postings that carry no company at all.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

import { API_BASE } from './lib/apiBase';
import { useGlobalFilter } from './lib/filterStore';
const API = API_BASE;
const FIN = `${API}/api/v1/finance`;

const fetchJson = async (url: string) => {
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

const inr = (n: any) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (d: any) => (d ? new Date(d).toLocaleDateString('en-GB') : '—');

export default function FinancialReports() {
  const [activeTab, setActiveTab] = useState('PNL');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const [companies, setCompanies] = useState<any[]>([]);
  // Default to the current Indian financial year, which is what a CA asks for.
  const fyStart = useMemo(() => {
    const d = new Date();
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    return `${y}-04-01`;
  }, []);

  // ── SCOPE COMES FROM THE GLOBAL FILTER (2026-09-02) ──────────────────────
  // This screen owned a private company dropdown and its own two dates, so
  // narrowing the dashboard to Gautam Prasad and clicking through to the
  // statements showed the whole group again — two controls answering the same
  // question, neither aware of the other. The dropdown below is still here, but
  // it now READS AND WRITES the app-wide filter, exactly as Company P&L already
  // does, so the two can no longer disagree.
  //
  // The filter carries the company ID; these reports are matched by NAME
  // (canonical_company folds the eight spellings server-side), so the id is
  // resolved to a name here.
  const gf = useGlobalFilter();
  const selectedCompany = useMemo(() => {
    if (!gf.filters.companyId) return 'ALL';
    const hit = companies.find((c: any) => c.id === gf.filters.companyId);
    return hit ? String(hit.company_name).trim() : 'ALL';
  }, [gf.filters.companyId, companies]);
  const setSelectedCompany = (name: string) => {
    const hit = companies.find((c: any) => String(c.company_name).trim() === name);
    gf.set({ companyId: hit ? hit.id : '' });
  };

  const fromDate = gf.filters.from || fyStart;
  const toDate = gf.filters.to || new Date().toISOString().slice(0, 10);
  const setFromDate = (v: string) => gf.set({ from: v });
  const setToDate = (v: string) => gf.set({ to: v });

  // ── WHAT TO DO WITH POSTINGS THAT NAME NO FIRM ───────────────────────────
  // Until 2026-09-02 the server answered this silently and wrongly: every
  // unplaced entry was counted into EVERY company, so the three firms' P&Ls
  // each carried the same orphans and summed to more than the group. The
  // choice is now explicit, defaults to the honest reading, and the banner
  // below says what it cost.
  const [unassigned, setUnassigned] = useState<'exclude' | 'include' | 'only'>('exclude');
  const [coverage, setCoverage] = useState<any>(null);

  const [pnl, setPnl] = useState<any>(null);
  const [bs, setBs] = useState<any>(null);
  const [tb, setTb] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);

  const [expanded, setExpanded] = useState<any>({ inc: true, exp: true, assets: true, liab: true });
  const toggle = (k: string) => setExpanded((p: any) => ({ ...p, [k]: !p[k] }));

  useEffect(() => {
    fetchJson(`${FIN}/masters/companies`)
      .then((m) => setCompanies(m.companies || []))
      .catch(() => setCompanies([]));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    const q = new URLSearchParams();
    if (fromDate) q.set('from', fromDate);
    if (toDate) q.set('to', toDate);
    if (selectedCompany !== 'ALL') {
      q.set('company', selectedCompany);
      q.set('unassigned', unassigned);
    }
    try {
      const [p, b, t] = await Promise.all([
        fetchJson(`${FIN}/reports/profit-and-loss?${q}`),
        fetchJson(`${FIN}/reports/balance-sheet?${q}`),
        fetchJson(`${FIN}/reports/trial-balance?${q}`),
      ]);
      setPnl(p); setBs(b); setTb(t);
    } catch (e: any) {
      setPnl(null); setBs(null); setTb(null);
      setErr(`Statements could not load from ${API} — ${e.message}`);
    }
    // How much of the book could be attributed to ANY firm in this period.
    // Fetched whether or not a company is selected: at group level it is the
    // measure of how much company-wise reporting is possible at all.
    try {
      const c = new URLSearchParams();
      if (fromDate) c.set('from', fromDate);
      if (toDate) c.set('to', toDate);
      setCoverage(await fetchJson(`${FIN}/reports/company-coverage?${c}`));
    } catch { setCoverage(null); }
    // The accounting-health view answers 409 when something is genuinely wrong,
    // so a non-OK response here is information, not a failure to hide.
    try {
      const res = await fetch(`${FIN}/health/accounting`);
      setHealth(await res.json());
    } catch { setHealth(null); }
    setLoading(false);
  }, [fromDate, toDate, selectedCompany, unassigned]);

  useEffect(() => { load(); }, [load]);

  const income = pnl?.income ?? [];
  const expenses = pnl?.expenses ?? [];
  const totalIncome = Number(pnl?.total_income ?? 0);
  const totalExpense = Number(pnl?.total_expense ?? 0);
  const netProfit = Number(pnl?.net_profit ?? 0);

  const assets = bs?.assets ?? [];
  const liabs = bs?.liabilities_and_equity ?? [];
  const totalAssets = Number(bs?.total_assets ?? 0);
  const totalLiab = Number(bs?.total_liabilities_equity ?? 0);

  const pnlChartData = [
    { name: 'Income', Value: totalIncome, fill: '#2fe39b' },
    { name: 'Expenses', Value: totalExpense, fill: '#ff6b81' },
  ];
  const PIE = ['#8b5cf6', '#22d3ee', '#ffb224', '#ec4899', '#2fe39b', '#f43f5e', '#a78bfa'];
  const bsPieData = assets.filter((a: any) => Number(a.amount) > 0)
    .map((a: any, i: number) => ({ name: a.group_head, value: Number(a.amount), color: PIE[i % PIE.length] }));

  const handlePrint = () => window.print();

  const handleDownloadExcel = () => {
    const esc = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let csv = `Company: ${selectedCompany}\n`
      + `Report: ${activeTab === 'PNL' ? 'Profit & Loss' : activeTab === 'BS' ? 'Balance Sheet' : 'Trial Balance'}\n`
      + `Period: ${dmy(fromDate)} to ${dmy(toDate)}\n`
      // THE CAVEAT TRAVELS WITH THE FILE. A CSV outlives the screen it
      // was exported from, and a company-wise statement that silently
      // dropped a third of the book is exactly the file somebody
      // reconciles against six months later.
      + (selectedCompany !== 'ALL'
        ? `Entries with no company: ${unassigned}` + (coverage ? ` (${Number(coverage.unassigned_entries).toLocaleString('en-IN')} of ${Number(coverage.total_entries).toLocaleString('en-IN')} entries in this period name no firm)` : '') + `\n`
        : '')
      + `Source: PostgreSQL general ledger\n\n`;

    if (activeTab === 'PNL') {
      csv += 'Expenses (Dr.),Amount (Rs.),Incomes (Cr.),Amount (Rs.)\n';
      const rows = Math.max(expenses.length, income.length);
      for (let i = 0; i < rows; i++) {
        csv += `${esc(expenses[i]?.group_head ?? '')},${expenses[i]?.amount ?? ''},`
          + `${esc(income[i]?.group_head ?? '')},${income[i]?.amount ?? ''}\n`;
      }
      csv += `${esc(netProfit >= 0 ? 'Net Profit' : 'Net Loss')},${Math.abs(netProfit).toFixed(2)},,\n`;
      csv += `TOTAL,${(totalExpense + Math.max(0, netProfit)).toFixed(2)},TOTAL,${totalIncome.toFixed(2)}\n`;
    } else if (activeTab === 'BS') {
      csv += 'Liabilities & Equity,Amount (Rs.),Assets,Amount (Rs.)\n';
      const rows = Math.max(liabs.length, assets.length);
      for (let i = 0; i < rows; i++) {
        csv += `${esc(liabs[i]?.group_head ?? '')},${liabs[i]?.amount ?? ''},`
          + `${esc(assets[i]?.group_head ?? '')},${assets[i]?.amount ?? ''}\n`;
      }
      csv += `TOTAL,${totalLiab.toFixed(2)},TOTAL,${totalAssets.toFixed(2)}\n`;
      csv += `\nDifference,${bs?.difference ?? ''},Balanced,${bs?.balanced ? 'YES' : 'NO'}\n`;
    } else {
      csv += 'Group,Type,Statement,Debit (Rs.),Credit (Rs.),Dr (voucher era),Cr (voucher era)\n';
      (tb?.rows ?? []).forEach((r: any) => {
        csv += `${esc(r.group_head)},${r.account_type},${r.statement},${r.dr},${r.cr},${r.dr_voucher_era},${r.cr_voucher_era}\n`;
      });
      const t = tb?.totals ?? {};
      csv += `TOTAL,,,${(t.dr ?? 0).toFixed(2)},${(t.cr ?? 0).toFixed(2)},${(t.dr_voucher_era ?? 0).toFixed(2)},${(t.cr_voucher_era ?? 0).toFixed(2)}\n`;
    }

    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `${activeTab === 'PNL' ? 'Profit_Loss' : activeTab === 'BS' ? 'Balance_Sheet' : 'Trial_Balance'}_${selectedCompany.replace(/[^A-Za-z0-9]/g, '_')}_${toDate}.csv`;
    a.click();
  };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: 50, background: 'radial-gradient(circle at top right, #121c38, #0a1024)', minHeight: '100vh', padding: 30 }}>
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .printable-area, .printable-area * { visibility: visible; color: black !important; }
          .printable-area { position: absolute; left: 0; top: 0; width: 100%; background: white !important; padding: 20px; }
          .no-print { display: none !important; }
          .glass-panel { background: white !important; border: none !important; box-shadow: none !important; padding: 0 !important; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          th, td { border: 1px solid #000 !important; padding: 8px !important; color: black !important; }
          th { background: #f0f0f0 !important; -webkit-print-color-adjust: exact; }
          h2, h3, p, div, span { color: black !important; }
          .expand-icon { display: none !important; }
        }
        .modern-table { width: 100%; border-collapse: collapse; }
        .modern-table th { background: rgba(0,0,0,0.3); color: #9aadd4; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; padding: 15px; border-bottom: 2px solid #27395f; }
        .modern-table td { padding: 12px 15px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #dde5f4; font-size: 13px; }
        .expandable-row { cursor: pointer; transition: all .3s ease; background: rgba(18, 28, 56,.4); }
        .expandable-row:hover { background: rgba(34, 211, 238,.1); }
        .metric-card { background: rgba(24, 36, 74,.5); border: 1px solid rgba(255,255,255,.05); border-radius: 12px; padding: 20px; display: flex; align-items: center; justify-content: center; flex-direction: column; box-shadow: 0 4px 20px rgba(0,0,0,.3); }
      `}</style>

      {/* HEADER */}
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 25, flexWrap: 'wrap', gap: 15 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 32, color: '#fff', fontWeight: 900, letterSpacing: '-0.5px' }}>📊 Financial Statements (CA Ready)</h2>
          <p style={{ margin: '5px 0 0', color: '#9aadd4', fontSize: 14 }}>
            Derived from the PostgreSQL general ledger — the P&L and the balance sheet read the same postings
          </p>
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={load} style={btn('#18244a', '#22d3ee', '1px solid #22d3ee')}>🔄 Refresh</button>
          <button onClick={handlePrint} style={btn('#27395f', '#fff')}>🖨️ Print</button>
          <button onClick={handleDownloadExcel} style={btn('linear-gradient(135deg,#2fe39b,#2fe39b)', '#fff')}>📥 CSV</button>
        </div>
      </div>

      {err && (
        <div className="no-print" style={{ background: 'rgba(255, 107, 129,0.1)', border: '1px solid #ff6b81', color: '#fca5a5', padding: '16px 20px', borderRadius: 12, marginBottom: 20, fontSize: 14 }}>
          ⚠️ {err}
          <div style={{ color: '#9aadd4', marginTop: 6, fontSize: 12 }}>Reads <code>{FIN}/reports/*</code>. Check that the ERP API is running.</div>
        </div>
      )}

      {/* FILTERS */}
      <div className="no-print" style={{ background: 'rgba(24, 36, 74,0.5)', border: '1px solid rgba(255,255,255,0.05)', padding: 20, borderRadius: 15, marginBottom: 20, display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 240px' }}>
          <label style={lbl('#9aadd4')}>Operating Company</label>
          <select value={selectedCompany} onChange={(e) => setSelectedCompany(e.target.value)} style={inp('#27395f')}>
            <option value="ALL">-- Consolidated (all companies) --</option>
            {companies.map((c) => <option key={c.company_name} value={c.company_name}>{c.company_name}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label style={lbl('#9aadd4')}>Period From</label>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} style={{ ...inp('#27395f'), colorScheme: 'dark' }} />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label style={lbl('#9aadd4')}>Period To {activeTab === 'BS' && <span style={{ color: '#2fe39b' }}>(as on)</span>}</label>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} style={{ ...inp('#27395f'), colorScheme: 'dark' }} />
        </div>
        <button onClick={() => { setFromDate(fyStart); setToDate(new Date().toISOString().slice(0, 10)); }} style={btn('#27395f', '#c4d1ea')}>This FY</button>

        {/* Only meaningful under a company filter: at group level nothing is
            excluded, because every entry belongs to the group whether or not it
            names a firm. */}
        {selectedCompany !== 'ALL' && (
          <div style={{ flex: '1 1 260px' }}>
            <label style={lbl('#9aadd4')}>Entries with no company</label>
            <select value={unassigned} onChange={(e) => setUnassigned(e.target.value as any)} style={inp('#27395f')}>
              <option value="exclude">Exclude — {selectedCompany} only</option>
              <option value="include">Include — this firm + unplaced (ties to group)</option>
              <option value="only">Only the unplaced — the worklist</option>
            </select>
          </div>
        )}
      </div>

      {/* ── WHAT THIS REPORT COULD NOT PLACE ──────────────────────────────
          A company-wise statement on this ledger is INCOMPLETE and has to say
          so on its face. 4,501 of 6,511 entries carried no company anywhere
          when this was measured (migration 120): not in the text, not in
          company_id, and not on their voucher — of 4,841 untagged, exactly 0
          had a tagged sibling on the same voucher. They cannot be attributed by
          any means available, so they are surfaced, never inferred. */}
      {coverage && Number(coverage.unassigned_entries) > 0 && (
        <div className="no-print" style={{
          background: 'rgba(255, 178, 36,0.08)', border: '1px solid #ffb224', color: '#fcd34d',
          padding: '12px 18px', borderRadius: 10, marginBottom: 20, fontSize: 13, lineHeight: 1.55,
        }}>
          <strong>
            {Number(coverage.unassigned_entries).toLocaleString('en-IN')} of{' '}
            {Number(coverage.total_entries).toLocaleString('en-IN')} ledger entries
            ({coverage.unassigned_pct}%) name no operating company
          </strong>
          {' — '}Dr ₹{inr(coverage.unassigned_dr)} / Cr ₹{inr(coverage.unassigned_cr)}.
          {selectedCompany === 'ALL'
            ? ' Consolidated totals include them, so this page is complete. A company-wise statement cannot be, until they are sourced.'
            : unassigned === 'exclude'
              ? ` They are EXCLUDED from this ${selectedCompany} statement, so the three firms will not add up to the consolidated figures. That difference is these entries.`
              : unassigned === 'include'
                ? ` They are INCLUDED here, so this statement overstates ${selectedCompany} by whatever share of them is not really this firm's. Every firm's report would include the same entries.`
                : ' Showing ONLY these entries — the ones somebody has to attribute.'}
          {' '}Nothing has been guessed: entries are placed by their own company text, then by company_id, and otherwise not at all.
        </div>
      )}

      {/* HEALTH BANNER — the ledger reporting on itself */}
      {health && (
        <div className="no-print" style={{
          background: health.ok ? 'rgba(47, 227, 155,0.08)' : 'rgba(255, 178, 36,0.1)',
          border: `1px solid ${health.ok ? '#2fe39b' : '#ffb224'}`,
          color: health.ok ? '#6ee7b7' : '#fcd34d',
          padding: '12px 18px', borderRadius: 10, marginBottom: 20, fontSize: 13,
        }}>
          {health.ok
            ? '✅ Ledger integrity: every voucher balances, no unresolvable postings, no accounts off the chart.'
            : `⚠️ Ledger integrity checks failing: ${(health.failures || []).join(', ')}`}
        </div>
      )}

      {/* TABS */}
      <div className="no-print" style={{ display: 'flex', gap: 10, marginBottom: 25, flexWrap: 'wrap' }}>
        {[
          { k: 'PNL', label: '📈 Profit & Loss', color: '#22d3ee' },
          { k: 'BS', label: '⚖️ Balance Sheet', color: '#2fe39b' },
          { k: 'TB', label: '📒 Trial Balance', color: '#a78bfa' },
        ].map((t) => (
          <button key={t.k} onClick={() => setActiveTab(t.k)} style={{
            padding: '12px 25px',
            background: activeTab === t.k ? `${t.color}26` : 'rgba(24, 36, 74,0.5)',
            color: activeTab === t.k ? t.color : '#9aadd4',
            border: `1px solid ${activeTab === t.k ? t.color : '#27395f'}`,
            fontWeight: 'bold', cursor: 'pointer', fontSize: 14, borderRadius: 8,
          }}>{t.label}</button>
        ))}
      </div>

      {loading && <div style={{ color: '#22d3ee', fontWeight: 'bold', padding: 20 }}>Loading statements from PostgreSQL…</div>}

      {!loading && !err && (
        <div className="printable-area">
          {/* REPORT HEADING */}
          <div style={{ textAlign: 'center', marginBottom: 25, borderBottom: '2px solid #27395f', paddingBottom: 15 }}>
            <h2 style={{ margin: 0, fontSize: 26, color: '#fff', fontWeight: 900, letterSpacing: 1 }}>
              {selectedCompany === 'ALL' ? 'CONSOLIDATED FINANCIAL REPORT' : selectedCompany.toUpperCase()}
            </h2>
            <h3 style={{ margin: '15px 0 8px', color: activeTab === 'PNL' ? '#22d3ee' : activeTab === 'BS' ? '#2fe39b' : '#a78bfa', fontSize: 20, letterSpacing: 1 }}>
              {activeTab === 'PNL' ? 'STATEMENT OF PROFIT & LOSS (INCOME STATEMENT)'
                : activeTab === 'BS' ? 'BALANCE SHEET (STATEMENT OF FINANCIAL POSITION)'
                : 'TRIAL BALANCE'}
            </h3>
            <p style={{ color: '#9aadd4', fontSize: 13, margin: 0 }}>
              {activeTab === 'BS' ? `As on ${dmy(toDate)}` : `Period: ${dmy(fromDate)} to ${dmy(toDate)}`}
            </p>
          </div>

          {/* ── P&L ── */}
          {activeTab === 'PNL' && (
            <>
              <div className="no-print" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 15, marginBottom: 25 }}>
                {metric('Total Income', totalIncome, '#2fe39b')}
                {metric('Total Expenses', totalExpense, '#ff6b81')}
                {metric(netProfit >= 0 ? 'Net Profit' : 'Net Loss', Math.abs(netProfit), netProfit >= 0 ? '#22d3ee' : '#f43f5e')}
                <div className="metric-card">
                  <div style={{ color: '#a78bfa', fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>Net Margin</div>
                  <div style={{ fontSize: 26, fontWeight: 900, color: '#fff', marginTop: 6 }}>
                    {pnl?.margin_pct == null ? '—' : `${pnl.margin_pct}%`}
                  </div>
                  {pnl?.margin_pct == null && <div style={{ color: '#5d7196', fontSize: 10, marginTop: 4 }}>no revenue in period</div>}
                </div>
              </div>

              <div className="glass-panel" style={panel}>
                <table className="modern-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Expenses (Dr.)</th>
                      <th style={{ textAlign: 'right' }}>Amount (₹)</th>
                      <th style={{ textAlign: 'left' }}>Incomes (Cr.)</th>
                      <th style={{ textAlign: 'right' }}>Amount (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="expandable-row" onClick={() => { toggle('exp'); toggle('inc'); }}>
                      <td style={{ fontWeight: 'bold', color: '#ff6b81' }}>
                        <span className="expand-icon">{expanded.exp ? '▼' : '▶'}</span> Expenses by group
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{inr(totalExpense)}</td>
                      <td style={{ fontWeight: 'bold', color: '#2fe39b' }}>
                        <span className="expand-icon">{expanded.inc ? '▼' : '▶'}</span> Income by group
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 'bold' }}>{inr(totalIncome)}</td>
                    </tr>
                    {(expanded.exp || expanded.inc) && Array.from({ length: Math.max(expenses.length, income.length) }).map((_, i) => (
                      <tr key={i}>
                        <td style={{ paddingLeft: 40, color: '#9aadd4' }}>{expenses[i]?.group_head ?? ''}</td>
                        <td style={{ textAlign: 'right', color: '#9aadd4' }}>{expenses[i] ? inr(expenses[i].amount) : ''}</td>
                        <td style={{ paddingLeft: 40, color: '#9aadd4' }}>{income[i]?.group_head ?? ''}</td>
                        <td style={{ textAlign: 'right', color: '#9aadd4' }}>{income[i] ? inr(income[i].amount) : ''}</td>
                      </tr>
                    ))}
                    {expenses.length === 0 && income.length === 0 && (
                      <tr><td colSpan={4} style={{ textAlign: 'center', color: '#5d7196', padding: 24 }}>No postings in this period.</td></tr>
                    )}
                    <tr style={{ background: 'rgba(34, 211, 238,0.08)', fontWeight: 'bold' }}>
                      <td style={{ color: netProfit >= 0 ? '#2fe39b' : '#f43f5e' }}>{netProfit >= 0 ? 'Net Profit c/d' : 'Net Loss c/d'}</td>
                      <td style={{ textAlign: 'right' }}>{netProfit >= 0 ? inr(netProfit) : '—'}</td>
                      <td style={{ color: '#9aadd4' }}>{netProfit < 0 ? 'Net Loss' : ''}</td>
                      <td style={{ textAlign: 'right' }}>{netProfit < 0 ? inr(Math.abs(netProfit)) : ''}</td>
                    </tr>
                    <tr style={{ background: 'rgba(0,0,0,0.35)', fontWeight: 900, fontSize: 15 }}>
                      <td>TOTAL</td>
                      <td style={{ textAlign: 'right' }}>{inr(totalExpense + Math.max(0, netProfit))}</td>
                      <td>TOTAL</td>
                      <td style={{ textAlign: 'right' }}>{inr(totalIncome + Math.max(0, -netProfit))}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <div className="no-print" style={{ ...panel, marginTop: 25, height: 300 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={pnlChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#27395f" />
                    <XAxis dataKey="name" stroke="#9aadd4" />
                    <YAxis stroke="#9aadd4" tickFormatter={(v) => `${(v / 100000).toFixed(1)}L`} />
                    <Tooltip formatter={(v: any) => `₹${inr(v)}`} contentStyle={{ background: '#121c38', border: '1px solid #27395f', borderRadius: 8 }} />
                    <Legend />
                    <Bar dataKey="Value" name="Amount (₹)" radius={[8, 8, 0, 0]}>
                      {pnlChartData.map((d, i) => <Cell key={i} fill={d.fill} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}

          {/* ── BALANCE SHEET ── */}
          {activeTab === 'BS' && (
            <>
              {bs && !bs.balanced && (
                <div style={{ background: 'rgba(255, 178, 36,0.1)', border: '1px solid #ffb224', color: '#fcd34d', padding: '14px 18px', borderRadius: 10, marginBottom: 20, fontSize: 13 }}>
                  ⚠️ This sheet is out by ₹{inr(bs.difference)}.
                  {/* A COMPANY SLICE OF THIS LEDGER CANNOT FOOT, and saying
                      "check /finance/health/accounting — a real defect" about
                      it would send somebody hunting a bug that is not there.
                      A voucher's two legs are not always tagged the same way:
                      the debit carries a company and the credit does not, or
                      both sit in the unplaced pool. Cut the book by firm and
                      the halves separate. The GROUP sheet foots to the paisa —
                      that is the check that means something. */}
                  {selectedCompany !== 'ALL' ? (
                    <div style={{ marginTop: 6, color: '#fde68a' }}>
                      This is a <strong>company slice</strong> of an append-only ledger, and a slice does not have to foot.
                      A voucher whose debit leg names {selectedCompany} and whose credit leg names no firm is split by this
                      filter — one half is in this sheet and the other is not. The consolidated sheet
                      (Company = “Consolidated”) balances exactly; that is the integrity check that means something here.
                      Nothing is wrong with the vouchers — the entries simply have not all been attributed.
                    </div>
                  ) : Math.abs(Number(bs.legacy_imbalance)) > 0.01 && Math.abs(Number(bs.legacy_imbalance) - Number(bs.difference)) < 0.01 ? (
                    <div style={{ marginTop: 6, color: '#fde68a' }}>
                      The whole difference is the migrated single-entry history: those pre-double-entry rows net to zero only
                      once all of them are included, and this date cuts through them. The voucher era balances exactly
                      (₹{inr(bs.voucher_imbalance)}). Set “as on” to a date after the migrated history — or leave the period
                      open — and the sheet foots.
                    </div>
                  ) : (
                    <div style={{ marginTop: 6, color: '#fde68a' }}>
                      Voucher-era imbalance ₹{inr(bs.voucher_imbalance)}, legacy imbalance ₹{inr(bs.legacy_imbalance)}.
                      A non-zero voucher-era figure is a real defect — check <code>/finance/health/accounting</code>.
                    </div>
                  )}
                </div>
              )}
              {bs?.balanced && (
                <div className="no-print" style={{ background: 'rgba(47, 227, 155,0.08)', border: '1px solid #2fe39b', color: '#6ee7b7', padding: '12px 18px', borderRadius: 10, marginBottom: 20, fontSize: 13 }}>
                  ✅ Balanced — assets equal liabilities and equity to the paisa
                  {selectedCompany !== 'ALL' ? ' for this company slice.' : '.'}
                </div>
              )}

              <div className="glass-panel" style={panel}>
                <table className="modern-table">
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left' }}>Liabilities & Equity</th>
                      <th style={{ textAlign: 'right' }}>Amount (₹)</th>
                      <th style={{ textAlign: 'left' }}>Assets</th>
                      <th style={{ textAlign: 'right' }}>Amount (₹)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: Math.max(liabs.length, assets.length) }).map((_, i) => (
                      <tr key={i}>
                        <td style={{ color: liabs[i]?.account_type === 'EQUITY' ? '#a78bfa' : '#dde5f4' }}>{liabs[i]?.group_head ?? ''}</td>
                        <td style={{ textAlign: 'right', fontWeight: liabs[i] ? 'bold' : 'normal' }}>{liabs[i] ? inr(liabs[i].amount) : ''}</td>
                        <td>{assets[i]?.group_head ?? ''}</td>
                        <td style={{ textAlign: 'right', fontWeight: assets[i] ? 'bold' : 'normal' }}>{assets[i] ? inr(assets[i].amount) : ''}</td>
                      </tr>
                    ))}
                    {liabs.length === 0 && assets.length === 0 && (
                      <tr><td colSpan={4} style={{ textAlign: 'center', color: '#5d7196', padding: 24 }}>No balances as on this date.</td></tr>
                    )}
                    <tr style={{ background: 'rgba(0,0,0,0.35)', fontWeight: 900, fontSize: 15 }}>
                      <td>TOTAL</td>
                      <td style={{ textAlign: 'right' }}>{inr(totalLiab)}</td>
                      <td>TOTAL</td>
                      <td style={{ textAlign: 'right' }}>{inr(totalAssets)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {bsPieData.length > 0 && (
                <div className="no-print" style={{ ...panel, marginTop: 25, height: 340 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={bsPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={110} label={(e: any) => e.name}>
                        {bsPieData.map((d, i) => <Cell key={i} fill={d.color} />)}
                      </Pie>
                      <Tooltip formatter={(v: any) => `₹${inr(v)}`} contentStyle={{ background: '#121c38', border: '1px solid #27395f', borderRadius: 8 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </>
          )}

          {/* ── TRIAL BALANCE ── */}
          {activeTab === 'TB' && (
            <div className="glass-panel" style={panel}>
              <p className="no-print" style={{ color: '#9aadd4', fontSize: 12.5, marginTop: 0 }}>
                Two pairs of columns: everything posted, and the voucher era alone. The voucher-era pair must be equal —
                it is enforced by a deferred database constraint on every voucher. The full pair can differ by the migrated
                single-entry history, which is why both are shown rather than one blended figure.
              </p>
              <table className="modern-table">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left' }}>Account Group</th>
                    <th style={{ textAlign: 'left' }}>Type</th>
                    <th style={{ textAlign: 'right' }}>Debit (₹)</th>
                    <th style={{ textAlign: 'right' }}>Credit (₹)</th>
                    <th style={{ textAlign: 'right' }}>Dr — voucher era</th>
                    <th style={{ textAlign: 'right' }}>Cr — voucher era</th>
                  </tr>
                </thead>
                <tbody>
                  {(tb?.rows ?? []).map((r: any) => (
                    <tr key={r.group_head}>
                      <td>{r.group_head}</td>
                      <td style={{ color: '#5d7196', fontSize: 11 }}>{r.account_type}</td>
                      <td style={{ textAlign: 'right' }}>{inr(r.dr)}</td>
                      <td style={{ textAlign: 'right' }}>{inr(r.cr)}</td>
                      <td style={{ textAlign: 'right', color: '#9aadd4' }}>{inr(r.dr_voucher_era)}</td>
                      <td style={{ textAlign: 'right', color: '#9aadd4' }}>{inr(r.cr_voucher_era)}</td>
                    </tr>
                  ))}
                  {(tb?.rows ?? []).length === 0 && (
                    <tr><td colSpan={6} style={{ textAlign: 'center', color: '#5d7196', padding: 24 }}>No postings in this period.</td></tr>
                  )}
                  <tr style={{ background: 'rgba(0,0,0,0.35)', fontWeight: 900 }}>
                    <td colSpan={2}>TOTAL</td>
                    <td style={{ textAlign: 'right' }}>{inr(tb?.totals?.dr)}</td>
                    <td style={{ textAlign: 'right' }}>{inr(tb?.totals?.cr)}</td>
                    <td style={{ textAlign: 'right', color: Math.abs((tb?.totals?.dr_voucher_era ?? 0) - (tb?.totals?.cr_voucher_era ?? 0)) < 0.01 ? '#2fe39b' : '#f43f5e' }}>
                      {inr(tb?.totals?.dr_voucher_era)}
                    </td>
                    <td style={{ textAlign: 'right', color: Math.abs((tb?.totals?.dr_voucher_era ?? 0) - (tb?.totals?.cr_voucher_era ?? 0)) < 0.01 ? '#2fe39b' : '#f43f5e' }}>
                      {inr(tb?.totals?.cr_voucher_era)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <p style={{ color: '#3d548a', fontSize: 11, textAlign: 'center', marginTop: 25 }}>
            Generated from the PostgreSQL general ledger on {new Date().toLocaleString('en-GB')} · Prasad Transport ERP
          </p>
        </div>
      )}
    </div>
  );
}

const btn = (bg: string, color: string, border = 'none'): React.CSSProperties => ({ background: bg, color, border, padding: '10px 16px', borderRadius: 8, fontWeight: 'bold', cursor: 'pointer', fontSize: 13 });
const lbl = (color: string): React.CSSProperties => ({ color, fontSize: 12, fontWeight: 'bold', textTransform: 'uppercase', display: 'block', marginBottom: 6 });
const inp = (border: string): React.CSSProperties => ({ width: '100%', padding: 12, background: '#121c38', border: `1px solid ${border}`, color: '#fff', borderRadius: 8, outline: 'none', boxSizing: 'border-box', fontWeight: 'bold' });
const panel: React.CSSProperties = { background: 'rgba(24, 36, 74,0.5)', border: '1px solid rgba(255,255,255,0.05)', borderRadius: 15, padding: 20, overflowX: 'auto' };

function metric(label: string, value: number, color: string) {
  return (
    <div className="metric-card" key={label}>
      <div style={{ color, fontSize: 11, fontWeight: 'bold', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 900, color: '#fff', marginTop: 6 }}>₹{inr(value)}</div>
    </div>
  );
}
