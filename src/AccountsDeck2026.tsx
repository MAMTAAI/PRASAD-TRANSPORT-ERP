// @ts-nocheck
// src/AccountsDeck2026.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Accounts "Command Deck" — the 2026 top-level summary Home for the Accounts
// module, mirroring OperationsDeck2026. It is ADDITIVE: it reads the same
// GET /api/v1/dashboard/v5 payload (the `finance` block — money is SPREAD onto
// `finance` directly, so freight_income / received / unbilled_freight live on
// the block itself), re-styled in the deep slate-navy / signal-amber theme, and
// nothing is removed. Every granular tool the accounts desk depends on —
// Ledger & Cash Book, P&L, Balance Sheet, Billing, Loan/EMI, GST/TDS, Fleet
// Card, Customer/Owner statements — stays one click away, unchanged, on the
// tools rail below the live panels.
//
// ZERO FUNCTIONALITY LOSS is the rule: this is a smarter front door, not a
// replacement for the rooms behind it.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useEffect, useState, useCallback } from 'react';
import { API_BASE } from './lib/apiBase';

const API = API_BASE;
const rs = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
const rL = (n) => {                                   // ₹ in lakh/crore, compact
  const v = Number(n || 0);
  if (v >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr';
  if (v >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L';
  return rs(v);
};
const CO_DOT = ['#ff9d2e', '#38bdf8', '#a78bfa', '#34d399', '#f472b6'];

// Every existing Accounts screen, unchanged behind its tile. Ids must match the
// App.tsx render switch and the SIDEBAR ACCOUNTS group — this rail is a second
// door to the same rooms, not a new registry.
const TOOLS = [
  ['BANK', '🏦', 'Cash & Bank Book'], ['LEDGER', '📖', 'Ledgers & Party'],
  ['CUST_LEDGER', '🧾', 'Customer Khata'], ['OWNER_STATEMENT', '🚛', 'Owner Khata'],
  ['PNL', '📊', 'Balance Sheet / P&L'], ['CA_PNL', '📈', 'Company P&L (Live)'],
  ['BILLING', '🧾', 'Bill Management'], ['AUTO_BILLING', '⚡', 'Auto Billing'],
  ['RATE_MASTER', '💹', 'Rate Master'], ['AI_SCANNER', '🤖', 'AI Bill Scanner'],
  ['EXPENSE_APPROVALS', '⏳', 'Pending Expenses'], ['FUEL_REVIEW', '⛽', 'Fuel Import Review'],
  ['FLEET_CARD', '💳', 'Fleet Card'], ['LOAN', '💸', 'Loan & EMI'],
  ['EXCEPTIONS', '🛠️', 'Exceptions'], ['TOLL', '🛣️', 'Toll & Fastag'],
  ['GST', '🏛️', 'GST'], ['TDS', '✂️', 'TDS'], ['VENDOR', '🤝', 'Vendor Master'],
];

export default function AccountsDeck2026({ currentUser, onOpenTool }) {
  const [v5, setV5] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [at, setAt] = useState(null);

  const load = useCallback(async (cid) => {
    setLoading(true); setErr(null);
    try {
      const qs = cid ? `?company_id=${encodeURIComponent(cid)}` : '';
      const d = await fetch(`${API}/api/v1/dashboard/v5${qs}`)
        .then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)));
      setV5(d); setAt(new Date());
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(companyId); }, [companyId, load]);
  useEffect(() => {
    fetch(`${API}/api/v1/finance/companies`).then((r) => r.ok ? r.json() : null)
      .then((j) => { const list = Array.isArray(j) ? j : (j?.companies ?? []); if (list.length) setCompanies(list); })
      .catch(() => {});
  }, []);

  const fin = v5?.finance ?? {};
  // v5 SPREADS the money block straight into `finance` (…money), so
  // freight_income / received / unbilled_freight live on `fin` itself.
  const health = fin.health ?? {};
  const pnl = fin.pnl ?? {};
  const banks = fin.banks ?? [];
  const monthly = fin.monthly ?? [];
  const emi = fin.emi ?? {};
  const toll = fin.toll ?? {};
  const book = fin.ledger_book ?? [];
  const totals = fin.book_totals ?? {};
  const unbilled = fin.unbilled_list ?? [];
  const outstanding = Number(fin.freight_income || 0) - Number(fin.received || 0);
  const bankMax = Math.max(1, ...banks.map((b) => Math.abs(Number(b.balance || 0))));
  const monMax = Math.max(1, ...monthly.map((m) => Number(m.revenue || 0)));
  const healthClean = !health || ((health.mixed_company_vouchers ?? 0) == 0 && (health.bills_spanning_companies ?? 0) == 0 && (health.unbalanced_vouchers ?? 0) == 0);
  const coverage = pnl.coverage;

  return (
    <div className="ad-root">
      <style>{`
        .ad-root { --ground:#0b1220; --surface:#131c2e; --surface2:#0f1727; --line:#22304a; --line2:#33455f;
          --ink:#e6edf7; --ink2:#a9b8ce; --ink3:#6b7c96; --accent:#ffb020; --accent-soft:#2a2013;
          --good:#34d399; --good-soft:#10281f; --warn:#f5b445; --crit:#ff7777; --crit-soft:#2c1618;
          --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,monospace;
          background:var(--ground); color:var(--ink); min-height:100vh; padding:clamp(14px,2.5vw,28px);
          font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
        .ad-root *{box-sizing:border-box;}
        .ad-num{font-family:var(--mono);font-variant-numeric:tabular-nums;}
        .ad-mast{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;margin-bottom:18px;}
        .ad-mast h1{font-size:20px;font-weight:750;letter-spacing:-.01em;margin:0;}
        .ad-mast p{margin:2px 0 0;font-size:12px;color:var(--ink3);}
        .ad-sel{display:flex;gap:5px;background:var(--surface);border:1px solid var(--line);padding:5px;border-radius:12px;flex-wrap:wrap;}
        .ad-sel button{font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;border:0;background:transparent;color:var(--ink2);padding:7px 12px;border-radius:8px;display:flex;align-items:center;gap:7px;transition:.15s;}
        .ad-sel button[data-on="1"]{background:var(--accent-soft);color:var(--ink);}
        .ad-sel button:hover{background:var(--surface2);}
        .ad-dot{width:8px;height:8px;border-radius:50%;flex:none;}
        .ad-strip{display:flex;flex-wrap:wrap;align-items:center;gap:9px 18px;border-radius:12px;padding:11px 16px;margin-bottom:18px;
          background:var(--good-soft);border:1px solid color-mix(in oklab,var(--good) 30%,var(--line));}
        .ad-strip.bad{background:var(--crit-soft);border-color:color-mix(in oklab,var(--crit) 35%,var(--line));}
        .ad-strip .lk{font-weight:700;font-size:13px;display:flex;align-items:center;gap:7px;color:var(--good);}
        .ad-strip.bad .lk{color:var(--crit);}
        .ad-strip .it{font-size:12.5px;color:var(--ink2);}
        .ad-strip .it b{color:var(--ink);} .ad-strip .it .g{color:var(--good);font-weight:700;} .ad-strip .it .r{color:var(--crit);font-weight:700;}
        .ad-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin-bottom:18px;}
        .ad-kpi{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:15px 16px;position:relative;overflow:hidden;}
        .ad-kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);opacity:.85;}
        .ad-kpi .l{font-size:11.5px;color:var(--ink3);font-weight:600;}
        .ad-kpi .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:26px;font-weight:650;letter-spacing:-.02em;margin:6px 0 2px;}
        .ad-kpi .v small{font-size:13px;color:var(--ink3);font-weight:500;}
        .ad-kpi .s{font-size:11.5px;color:var(--ink3);}
        .ad-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:16px;align-items:start;margin-bottom:16px;}
        .ad-grid3{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;align-items:start;}
        .ad-panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;}
        .ad-panel>header{display:flex;align-items:baseline;justify-content:space-between;padding:14px 16px 11px;border-bottom:1px solid var(--line);}
        .ad-panel>header h2{font-size:13.5px;font-weight:700;margin:0;letter-spacing:-.01em;}
        .ad-panel>header .m{font-size:11px;color:var(--ink3);}
        .ad-body{padding:6px 16px 14px;}
        .ad-corow{display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);}
        .ad-corow:last-child{border-bottom:0;}
        .ad-corow .nm{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;min-width:0;}
        .ad-corow .nm span.t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .ad-corow .amt{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:650;font-size:13.5px;text-align:right;}
        .ad-corow .bar{grid-column:1/-1;height:6px;border-radius:4px;background:var(--surface2);overflow:hidden;}
        .ad-corow .bar i{display:block;height:100%;border-radius:4px;}
        table.ad-tb{width:100%;border-collapse:collapse;font-size:12.5px;}
        table.ad-tb th{text-align:left;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink3);font-weight:600;padding:7px 6px 7px 0;border-bottom:1px solid var(--line);}
        table.ad-tb td{padding:8px 6px 8px 0;border-bottom:1px solid var(--line);color:var(--ink2);}
        table.ad-tb tr:last-child td{border-bottom:0;}
        table.ad-tb td.r,table.ad-tb th.r{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;}
        .ad-chip{font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;display:inline-block;white-space:nowrap;}
        .ad-chip.ok{background:var(--good-soft);color:var(--good);} .ad-chip.due{background:var(--accent-soft);color:var(--accent);} .ad-chip.bad{background:var(--crit-soft);color:var(--crit);}
        .ad-scroll{overflow-x:auto;} .ad-empty{color:var(--ink3);font-size:12.5px;padding:14px 0;text-align:center;}
        .ad-pl{display:flex;justify-content:space-between;gap:10px;font-size:12.5px;padding:7px 0;border-bottom:1px solid var(--line);}
        .ad-pl:last-child{border-bottom:0;}
        .ad-pl .g{color:var(--ink2);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .ad-pl .a{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:650;}
        .ad-pl.total{font-weight:750;color:var(--ink);border-top:1px solid var(--line2);}
        .ad-cover{margin-top:10px;font-size:11.5px;color:var(--warn);background:var(--accent-soft);border:1px solid color-mix(in oklab,var(--warn) 30%,var(--line));border-radius:9px;padding:8px 10px;}
        .ad-tools{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px;}
        .ad-tool{display:flex;align-items:center;gap:9px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);cursor:pointer;font:inherit;color:var(--ink2);text-align:left;transition:.15s;}
        .ad-tool:hover{border-color:var(--accent);color:var(--ink);background:var(--accent-soft);}
        .ad-tool b{font-size:12px;font-weight:650;}
        .ad-console{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border:1px solid var(--line2);border-radius:14px;padding:14px 18px;margin-top:16px;}
        .ad-console b{font-size:13.5px;} .ad-console p{margin:2px 0 0;font-size:12px;color:var(--ink3);}
        .ad-console button{font:inherit;font-weight:650;font-size:13px;cursor:pointer;border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft);padding:9px 16px;border-radius:10px;}
        .ad-foot{margin-top:18px;font-size:11.5px;color:var(--ink3);display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;}
        @media (max-width:900px){.ad-kpis{grid-template-columns:repeat(2,1fr);}.ad-grid,.ad-grid3{grid-template-columns:1fr;}}
      `}</style>

      <header className="ad-mast">
        <div>
          <h1>Accounts — Command Deck</h1>
          <p>Live books · Bongaigaon, Assam · {currentUser?.full_name ? `${currentUser.full_name}` : 'Prasad Transport'}</p>
        </div>
        <nav className="ad-sel" aria-label="Operating company">
          <button data-on={companyId === '' ? '1' : '0'} onClick={() => setCompanyId('')}><span className="ad-dot" style={{ background: '#8aa0bf' }} />All</button>
          {companies.map((c, i) => (
            <button key={c.id} data-on={companyId === c.id ? '1' : '0'} onClick={() => setCompanyId(c.id)}>
              <span className="ad-dot" style={{ background: CO_DOT[i % CO_DOT.length] }} />{(c.company_name || c.name || '').replace(/^M\/S\s+/i, '')}
            </button>
          ))}
        </nav>
      </header>

      {err && <div className="ad-strip bad"><span className="lk">Could not load live data</span><span className="it">{err} — every tool on the rail below still works.</span></div>}

      <div className={'ad-strip' + (healthClean ? '' : ' bad')} role="status">
        <span className="lk">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
          Books integrity — {healthClean ? 'locked' : 'attention'}
        </span>
        <span className="it">Vouchers balanced <b className={(health.unbalanced_vouchers ?? 0) == 0 ? 'g' : 'r'}>{health.unbalanced_vouchers ?? 0} off</b></span>
        <span className="it">Mixed-company vouchers <b className={(health.mixed_company_vouchers ?? 0) == 0 ? 'g' : 'r'}>{health.mixed_company_vouchers ?? 0}</b></span>
        <span className="it">Bills spanning firms <b className={(health.bills_spanning_companies ?? 0) == 0 ? 'g' : 'r'}>{health.bills_spanning_companies ?? 0}</b></span>
        <span className="it">Ledgers off-chart <b className={(health.ledgers_off_chart ?? 0) == 0 ? 'g' : 'r'}>{health.ledgers_off_chart ?? 0}</b></span>
      </div>

      <section className="ad-kpis">
        <div className="ad-kpi"><div className="l">Freight income (billed)</div><div className="v ad-num">{loading ? '—' : rL(fin.freight_income)}</div><div className="s">TDS {rL(fin.tds)}</div></div>
        <div className="ad-kpi"><div className="l">Received</div><div className="v ad-num">{loading ? '—' : rL(fin.received)}</div><div className="s">{rL(Math.max(0, outstanding))} still to collect</div></div>
        <div className="ad-kpi"><div className="l">Freight to bill</div><div className="v ad-num">{loading ? '—' : rL(fin.unbilled_freight)}</div><div className="s">{unbilled.length} loads unbilled</div></div>
        <div className="ad-kpi"><div className="l">Loan outstanding</div><div className="v ad-num">{loading ? '—' : rL(emi.total_outstanding)}</div><div className="s">{emi.active_loans ?? 0} loans · {rL(emi.total_monthly)}/mo EMI</div></div>
      </section>

      <div className="ad-grid">
        <section className="ad-panel">
          <header><h2>Profit &amp; Loss — posted books</h2><span className="m">net {loading ? '—' : rL(pnl.net)}</span></header>
          <div className="ad-body">
            {(pnl.income ?? []).length === 0 && (pnl.expense ?? []).length === 0 && <div className="ad-empty">{loading ? 'Loading…' : 'No P&L postings in scope.'}</div>}
            {(pnl.income ?? []).map((r, i) => (
              <div className="ad-pl" key={'i' + i}><span className="g">{r.group}</span><span className="a" style={{ color: 'var(--good)' }}>{rL(r.amount)}</span></div>
            ))}
            {(pnl.expense ?? []).map((r, i) => (
              <div className="ad-pl" key={'e' + i}><span className="g">{r.group}</span><span className="a" style={{ color: 'var(--crit)' }}>−{rL(r.amount)}</span></div>
            ))}
            {((pnl.income ?? []).length > 0 || (pnl.expense ?? []).length > 0) && (
              <div className="ad-pl total"><span className="g">Net</span><span className="a" style={{ color: Number(pnl.net) >= 0 ? 'var(--good)' : 'var(--crit)' }}>{rL(pnl.net)}</span></div>
            )}
            {coverage && (
              <div className="ad-cover">
                ⚠ Company filter sees {coverage.pct}% of P&amp;L postings — {coverage.untagged} entries worth {rL(coverage.untagged_amount)} carry no firm tag yet, so this split understates the truth. The all-companies view is complete.
              </div>
            )}
          </div>
        </section>

        <section className="ad-panel">
          <header><h2>Cash, bank &amp; wallet balances</h2><span className="m">from posted entries</span></header>
          <div className="ad-body">
            {banks.length === 0 && <div className="ad-empty">{loading ? 'Loading…' : 'No bank/cash ledgers found.'}</div>}
            {banks.map((b, i) => (
              <div className="ad-corow" key={i}>
                <span className="nm"><span className="ad-dot" style={{ background: CO_DOT[i % CO_DOT.length] }} /><span className="t">{b.name}</span></span>
                <span className="amt" style={{ color: Number(b.balance) < 0 ? 'var(--crit)' : 'var(--ink)' }}>{rL(b.balance)}</span>
                <span className="bar"><i style={{ width: Math.max(3, (Math.abs(Number(b.balance)) / bankMax) * 100) + '%', background: CO_DOT[i % CO_DOT.length] }} /></span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="ad-grid3">
        <section className="ad-panel">
          <header><h2>Loan &amp; EMI — by bank</h2><span className="m">{(emi.banks ?? []).length} lenders</span></header>
          <div className="ad-body ad-scroll">
            {(emi.banks ?? []).length === 0 ? <div className="ad-empty">{loading ? 'Loading…' : 'No live loans.'}</div> : (
              <table className="ad-tb"><thead><tr><th>Bank</th><th className="r">Loans</th><th className="r">Outstanding</th><th className="r">EMI/mo</th><th className="r">Paid</th></tr></thead>
                <tbody>{(emi.banks ?? []).slice(0, 8).map((b, i) => (
                  <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{b.bank}</td><td className="r">{b.loans}</td>
                    <td className="r">{rL(b.outstanding)}</td><td className="r">{rL(b.monthly_emi)}</td>
                    <td className="r"><span className={'ad-chip ' + (b.pct >= 75 ? 'ok' : b.pct >= 40 ? 'due' : 'bad')}>{b.pct}%</span></td></tr>
                ))}</tbody></table>
            )}
          </div>
        </section>

        <section className="ad-panel">
          <header><h2>Toll &amp; FASTag</h2><span className="m">{toll.txns ?? 0} crossings</span></header>
          <div className="ad-body ad-scroll">
            <div className="ad-pl"><span className="g">Spent (all time)</span><span className="a">{rL(toll.spent_total)}</span></div>
            <div className="ad-pl"><span className="g">This month</span><span className="a">{rL(toll.this_month)}</span></div>
            <div className="ad-pl"><span className="g">Claimed back</span><span className="a" style={{ color: 'var(--good)' }}>{rL(toll.claimed)}</span></div>
            <div className="ad-pl"><span className="g">Not yet claimed</span><span className="a" style={{ color: Number(toll.unclaimed) > 0 ? 'var(--warn)' : 'var(--ink)' }}>{rL(toll.unclaimed)}</span></div>
            <div className="ad-pl"><span className="g">Wallet credits loaded</span><span className="a">{rL(toll.credited)} <small style={{ color: 'var(--ink3)' }}>({toll.credit_count ?? 0})</small></span></div>
            {(toll.providers ?? []).length > 0 && (
              <table className="ad-tb" style={{ marginTop: 8 }}><thead><tr><th>Provider</th><th className="r">Txns</th><th className="r">Amount</th></tr></thead>
                <tbody>{(toll.providers ?? []).map((p, i) => (
                  <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{p.provider}</td><td className="r">{p.txns}</td><td className="r">{rL(p.amount)}</td></tr>
                ))}</tbody></table>
            )}
          </div>
        </section>

        <section className="ad-panel">
          <header><h2>Monthly freight revenue</h2><span className="m">last 7 months</span></header>
          <div className="ad-body">
            {monthly.length === 0 && <div className="ad-empty">{loading ? 'Loading…' : 'No postings yet.'}</div>}
            {monthly.map((m, i) => (
              <div className="ad-corow" key={i}>
                <span className="nm"><span className="t">{m.month}</span></span>
                <span className="amt">{rL(m.revenue)}</span>
                <span className="bar"><i style={{ width: Math.max(3, (Number(m.revenue) / monMax) * 100) + '%', background: 'var(--accent)' }} /></span>
              </div>
            ))}
          </div>
        </section>

        <section className="ad-panel">
          <header><h2>Ledger book — most active</h2><span className="m">{totals.vouchers ?? 0} vouchers · {totals.entries ?? 0} entries</span></header>
          <div className="ad-body ad-scroll">
            {book.length === 0 ? <div className="ad-empty">{loading ? 'Loading…' : 'No ledger activity.'}</div> : (
              <table className="ad-tb"><thead><tr><th>Ledger</th><th className="r">Debit</th><th className="r">Credit</th></tr></thead>
                <tbody>{book.slice(0, 8).map((l, i) => (
                  <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{l.name}<br /><small style={{ color: 'var(--ink3)' }}>{l.type}</small></td>
                    <td className="r">{rL(l.debit)}</td><td className="r">{rL(l.credit)}</td></tr>
                ))}</tbody></table>
            )}
            {(totals.debit ?? 0) > 0 && (
              <div className="ad-pl total" style={{ marginTop: 6 }}>
                <span className="g">Book totals</span>
                <span className="a">DR {rL(totals.debit)} · CR {rL(totals.credit)}</span>
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="ad-panel" style={{ marginTop: 16 }}>
        <header><h2>Every accounts tool — unchanged</h2><span className="m">one click, same rooms as the sidebar</span></header>
        <div className="ad-body">
          <div className="ad-tools">
            {TOOLS.map(([id, icon, label]) => (
              <button className="ad-tool" key={id} onClick={() => onOpenTool?.(id)}>
                <span style={{ fontSize: 16 }}>{icon}</span><b>{label}</b>
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="ad-console">
        <div>
          <b>Master Control v5.0 — Finance tab</b>
          <p>The full detailed console: voucher drill-downs, tally connector, exception queues — unchanged.</p>
        </div>
        <button onClick={() => onOpenTool?.('MASTER_CONTROL_V5')}>Open full console →</button>
      </div>

      <footer className="ad-foot">
        <span>{at ? `Live · updated ${at.toLocaleTimeString('en-IN')}` : 'Loading…'} {v5?.errors?.length ? `· ${v5.errors.length} card(s) on fallback` : ''}</span>
        <span>Reads GET /api/v1/dashboard/v5 finance block · figures come off the posted books</span>
      </footer>
    </div>
  );
}
