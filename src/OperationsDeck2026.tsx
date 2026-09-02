// @ts-nocheck
// ============================================================================
// OPERATIONS — COMMAND DECK (Home)
//
// The first screen the office sees. Redesigned 2026-09-02 on the owner's
// instruction ("clean and smart, remove what is not useful"). What went, and
// why:
//   • the "10 Mahavidya agents" panel and KPI — a static list with two agents
//     hard-coded as idle. The AI Agent Fleet screen has the live cards; a copy
//     here was decoration that could contradict it.
//   • three ₹0 rows in Revenue by customer — the same customer under three
//     master names (IOCL / Indian oil corporation / INDIAN OIL CORPORATION LTD).
//     The deck now folds aliases for DISPLAY and says how many names it folded,
//     so the fault is visible and a person merges the masters; nothing is
//     merged in the data (surface, never auto-fix).
//   • the accounting-health strip as a full row — it is one pill now, red only
//     when there is something to look at.
// What came in:
//   • Aaj ki loading — the AC4 daily-loading register beside the AC5 trips,
//     the same figures Master Control shows, because "what loaded today" is
//     the first question of the morning.
//   • Approval desk — the four PENDING queues the office must clear, each a
//     button to the screen that clears it.
// It still reads GET /api/v1/dashboard/v5 (company-scoped) and is additive to
// the detailed console behind "Open full console".
// ============================================================================
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
const kl = (n) => `${Number(n || 0).toFixed(1)} KL`;
const CO_DOT = ['#ff9d2e', '#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#fb7185', '#fbbf24'];

// DISPLAY-ONLY alias folding for the revenue list. The customer master holds
// the same oil company under several spellings; the books are per master row,
// so the fold happens here and only here, and the row says "3 names" so the
// office knows to merge them in Customer Master. Add an alias only for a
// company that genuinely appears under several names — never a generic rule.
const ALIASES = [
  [/INDIAN\s*OIL|\bIOCL?\b/i, 'Indian Oil (IOCL)'],
  [/HINDUSTAN\s*PETROLEUM|\bHPCL\b/i, 'Hindustan Petroleum (HPCL)'],
  [/BHARAT\s*PETROLEUM|\bBPCL\b/i, 'Bharat Petroleum (BPCL)'],
];
const canonical = (name) => {
  const n = String(name || '').trim();
  for (const [re, label] of ALIASES) if (re.test(n)) return label;
  return n.replace(/^M\/S\s+/i, '');
};
const foldCustomers = (rows) => {
  const groups = new Map();
  for (const c of rows) {
    const key = canonical(c.name);
    const g = groups.get(key) ?? { name: key, value: 0, names: [] };
    g.value += Number(c.value || 0);
    g.names.push(c.name);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.value - a.value);
};

const dayLabel = (d) => (d
  ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
  : '');

export default function OperationsDeck2026({ currentUser, onOpenConsole }) {
  const [v5, setV5] = useState(null);
  const [agents, setAgents] = useState(null);
  const [badges, setBadges] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [at, setAt] = useState(null);
  const [showZero, setShowZero] = useState(false);

  const load = useCallback(async (cid) => {
    setLoading(true); setErr(null);
    try {
      const qs = cid ? `?company_id=${encodeURIComponent(cid)}` : '';
      const [d, a, b] = await Promise.all([
        fetch(`${API}/api/v1/dashboard/v5${qs}`).then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))),
        fetch(`${API}/api/agents/`).then((r) => r.ok ? r.json() : null).catch(() => null),
        fetch(`${API}/api/v1/queues/badges`).then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);
      setV5(d); setAgents(a); setBadges(b); setAt(new Date());
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(companyId); }, [companyId, load]);
  useEffect(() => {
    fetch(`${API}/api/v1/finance/companies`).then((r) => r.ok ? r.json() : null)
      .then((j) => { const list = Array.isArray(j) ? j : (j?.companies ?? []); if (list.length) setCompanies(list); })
      .catch(() => {});
  }, []);

  const ops = v5?.ops ?? {};
  const fin = v5?.finance ?? {};
  // The v5 endpoint SPREADS the money block straight into `finance` (…money),
  // so unbilled_freight / freight_income live on `fin` itself, not fin.money.
  const money = fin;
  const health = fin.health ?? {};
  const custsRaw = fin.customers ?? [];
  const custs = foldCustomers(custsRaw);
  const custsShown = showZero ? custs : custs.filter((c) => Number(c.value) > 0);
  const zeroCount = custs.length - custs.filter((c) => Number(c.value) > 0).length;
  const dupNames = custs.reduce((n, c) => n + Math.max(0, c.names.length - 1), 0);
  const liveFleet = ops.live_fleet ?? [];
  const unloadQ = ops.unloading_queue ?? [];
  const rtkm = Array.isArray(ops.vehicle_rtkm) ? ops.vehicle_rtkm : (ops.vehicle_rtkm?.all ?? ops.vehicle_rtkm?.rows ?? []);
  const vault = ops.doc_vault ?? [];
  const alerts = ops.compliance_alerts ?? {};
  const alertCount = (alerts.expired?.length ?? 0) + (alerts.expiring?.length ?? 0);
  const unbilled = fin.unbilled_list ?? [];
  const la = ops.loading_activity ?? {};
  const ac4 = la.ac4 ?? {};
  const custMax = Math.max(1, ...custsShown.map((c) => Number(c.value || 0)));
  const healthIssues = (health.mixed_company_vouchers ?? 0) + (health.bills_spanning_companies ?? 0)
    + (health.unbalanced_vouchers ?? 0) + (health.ledgers_off_chart ?? 0);
  const activeAgents = agents?.active ?? (agents?.count ? agents.count : 10);
  const totalAgents = agents?.count ?? 10;

  // The four queues a person must clear, each with the screen that clears it.
  const desk = [
    { k: 'pending_kyc', label: 'KYC', hint: 'vendor / customer applications', go: 'BAZAAR_ADMIN' },
    { k: 'pending_partner_docs', label: 'App uploads', hint: 'driver & vendor documents', go: 'EXPENSE_APPROVALS' },
    { k: 'pending_requests', label: 'Driver requests', hint: 'advance / fuel / leave', go: 'DRIVER' },
    { k: 'pending_expenses', label: 'Expenses', hint: 'bills waiting for money approval', go: 'EXPENSE_APPROVALS' },
  ].map((d) => ({ ...d, n: Number(badges?.[d.k] ?? 0) }));
  const deskTotal = desk.reduce((s, d) => s + d.n, 0);

  return (
    <div className="od-root">
      <style>{`
        .od-root { --ground:#0b1220; --surface:#131c2e; --surface2:#0f1727; --line:#22304a; --line2:#33455f;
          --ink:#e6edf7; --ink2:#a9b8ce; --ink3:#6b7c96; --accent:#ffb020; --accent-soft:#2a2013;
          --good:#34d399; --good-soft:#10281f; --warn:#f5b445; --crit:#ff7777; --crit-soft:#2c1618; --teal:#2dd4bf; --teal-soft:#0f2a28;
          --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,monospace;
          background:var(--ground); color:var(--ink); min-height:100vh; padding:clamp(14px,2.5vw,28px);
          font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
        .od-root *{box-sizing:border-box;}
        .od-num{font-family:var(--mono);font-variant-numeric:tabular-nums;}
        .od-mast{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;margin-bottom:16px;}
        .od-mast h1{font-size:20px;font-weight:750;letter-spacing:-.01em;margin:0;}
        .od-mast p{margin:2px 0 0;font-size:12px;color:var(--ink3);display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
        .od-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;padding:3px 9px;border-radius:20px;border:1px solid transparent;}
        .od-pill.ok{background:var(--good-soft);color:var(--good);border-color:color-mix(in oklab,var(--good) 30%,var(--line));}
        .od-pill.bad{background:var(--crit-soft);color:var(--crit);border-color:color-mix(in oklab,var(--crit) 35%,var(--line));cursor:pointer;}
        .od-sel{display:flex;gap:5px;background:var(--surface);border:1px solid var(--line);padding:5px;border-radius:12px;flex-wrap:wrap;}
        .od-sel button{font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;border:0;background:transparent;color:var(--ink2);padding:7px 12px;border-radius:8px;display:flex;align-items:center;gap:7px;transition:.15s;}
        .od-sel button[data-on="1"]{background:var(--accent-soft);color:var(--ink);}
        .od-sel button:hover{background:var(--surface2);}
        .od-dot{width:8px;height:8px;border-radius:50%;flex:none;}
        .od-strip{display:flex;flex-wrap:wrap;align-items:center;gap:9px 18px;border-radius:12px;padding:11px 16px;margin-bottom:16px;
          background:var(--crit-soft);border:1px solid color-mix(in oklab,var(--crit) 35%,var(--line));}
        .od-strip .lk{font-weight:700;font-size:13px;color:var(--crit);}
        .od-strip .it{font-size:12.5px;color:var(--ink2);}
        .od-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin-bottom:14px;}
        .od-kpi{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:15px 16px;position:relative;overflow:hidden;}
        .od-kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);opacity:.85;}
        .od-kpi.teal::before{background:var(--teal);}
        .od-kpi .l{font-size:11.5px;color:var(--ink3);font-weight:600;}
        .od-kpi .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:26px;font-weight:650;letter-spacing:-.02em;margin:6px 0 2px;}
        .od-kpi .v small{font-size:13px;color:var(--ink3);font-weight:500;}
        .od-kpi .s{font-size:11.5px;color:var(--ink3);}
        .od-desk{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:10px 14px;margin-bottom:16px;}
        .od-desk .t{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3);font-weight:700;margin-right:6px;}
        .od-desk button{font:inherit;cursor:pointer;display:flex;align-items:center;gap:8px;border:1px solid var(--line);background:var(--surface2);color:var(--ink2);padding:7px 12px;border-radius:10px;font-size:12.5px;font-weight:600;transition:.15s;}
        .od-desk button:hover{border-color:var(--line2);color:var(--ink);}
        .od-desk button b{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:14px;color:var(--ink);}
        .od-desk button[data-hot="1"]{border-color:color-mix(in oklab,var(--accent) 45%,var(--line));background:var(--accent-soft);color:var(--ink);}
        .od-desk button[data-hot="1"] b{color:var(--accent);}
        .od-desk button span.h{font-size:10.5px;color:var(--ink3);font-weight:500;}
        .od-desk .clear{font-size:12.5px;color:var(--good);font-weight:600;}
        .od-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;align-items:start;margin-bottom:16px;}
        .od-panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;}
        .od-panel>header{display:flex;align-items:baseline;justify-content:space-between;gap:10px;padding:14px 16px 11px;border-bottom:1px solid var(--line);}
        .od-panel>header h2{font-size:13.5px;font-weight:700;margin:0;letter-spacing:-.01em;}
        .od-panel>header .m{font-size:11px;color:var(--ink3);text-align:right;}
        .od-body{padding:6px 16px 14px;}
        .od-corow{display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);}
        .od-corow:last-child{border-bottom:0;}
        .od-corow .nm{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;min-width:0;}
        .od-corow .nm span.t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .od-corow .amt{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:650;font-size:13.5px;text-align:right;}
        .od-corow .bar{grid-column:1/-1;height:6px;border-radius:4px;background:var(--surface2);overflow:hidden;}
        .od-corow .bar i{display:block;height:100%;border-radius:4px;}
        .od-note{font-size:11.5px;color:var(--ink3);padding:8px 0 2px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;}
        .od-note button{font:inherit;font-size:11.5px;cursor:pointer;background:none;border:0;color:var(--ink2);text-decoration:underline;padding:0;}
        table.od-tb{width:100%;border-collapse:collapse;font-size:12.5px;}
        table.od-tb th{text-align:left;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink3);font-weight:600;padding:7px 6px 7px 0;border-bottom:1px solid var(--line);}
        table.od-tb td{padding:8px 6px 8px 0;border-bottom:1px solid var(--line);color:var(--ink2);}
        table.od-tb tr:last-child td{border-bottom:0;}
        table.od-tb td.r,table.od-tb th.r{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;}
        .od-chip{font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;display:inline-block;white-space:nowrap;}
        .od-chip.ok{background:var(--good-soft);color:var(--good);} .od-chip.due{background:var(--accent-soft);color:var(--accent);} .od-chip.bad{background:var(--crit-soft);color:var(--crit);}
        .od-chip.n{background:var(--surface2);color:var(--ink3);border:1px solid var(--line);}
        .od-scroll{overflow-x:auto;} .od-empty{color:var(--ink3);font-size:12.5px;padding:14px 0;text-align:center;}
        .od-console{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border:1px solid var(--line2);border-radius:14px;padding:12px 16px;margin-top:4px;}
        .od-console b{font-size:13px;} .od-console p{margin:2px 0 0;font-size:11.5px;color:var(--ink3);}
        .od-console button{font:inherit;font-weight:650;font-size:12.5px;cursor:pointer;border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft);padding:8px 14px;border-radius:10px;white-space:nowrap;}
        .od-foot{margin-top:16px;font-size:11.5px;color:var(--ink3);display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;}
        .od-foot button{font:inherit;font-size:11.5px;cursor:pointer;background:none;border:0;color:var(--ink2);text-decoration:underline;padding:0;}
        @media (max-width:900px){.od-kpis{grid-template-columns:repeat(2,1fr);}.od-grid{grid-template-columns:1fr;}}
      `}</style>

      <header className="od-mast">
        <div>
          <h1>Operations — Command Deck</h1>
          <p>
            <span>Live · Bongaigaon, Assam · {currentUser?.full_name ? `${currentUser.full_name}` : 'Prasad Transport'}</span>
            {/* Books health: one pill, not a row. Red only when there is work. */}
            {healthIssues === 0
              ? <span className="od-pill ok" title="Vouchers balanced, no mixed-company vouchers, no bills spanning firms, no ledgers off-chart">Books: clean</span>
              : <span className="od-pill bad" title="Open Accounts & Admin for the detail" onClick={() => onOpenConsole?.('ACCT_DECK')}>Books: {healthIssues} issue{healthIssues === 1 ? '' : 's'}</span>}
          </p>
        </div>
        <nav className="od-sel" aria-label="Operating company">
          <button data-on={companyId === '' ? '1' : '0'} onClick={() => setCompanyId('')}><span className="od-dot" style={{ background: '#8aa0bf' }} />All</button>
          {companies.map((c, i) => (
            <button key={c.id} data-on={companyId === c.id ? '1' : '0'} onClick={() => setCompanyId(c.id)}>
              <span className="od-dot" style={{ background: CO_DOT[i % CO_DOT.length] }} />{(c.company_name || c.name || '').replace(/^M\/S\s+/i, '')}
            </button>
          ))}
        </nav>
      </header>

      {err && <div className="od-strip"><span className="lk">Could not load live data</span><span className="it">{err} — the detailed console below still works.</span></div>}

      <section className="od-kpis">
        <div className="od-kpi teal">
          <div className="l">Aaj ki loading — AC4</div>
          <div className="v od-num">{loading ? '—' : (ac4.today_count ?? 0)} <small>gaadi · {kl(ac4.today_qty)}</small></div>
          <div className="s">
            {la.is_today
              ? `AC5 trips aaj: ${la.email_count ?? 0} mail · ${la.manual_count ?? 0} staff`
              : (la.day ? `koi trip entry nahi — aakhri ${dayLabel(la.day)}` : 'register khaali')}
          </div>
        </div>
        <div className="od-kpi"><div className="l">Trips in transit</div><div className="v od-num">{loading ? '—' : (ops.active_trips ?? 0)}</div><div className="s">{ops.pending_unloading ?? 0} awaiting unload</div></div>
        <div className="od-kpi"><div className="l">Freight to bill</div><div className="v od-num">{loading ? '—' : rL(money.unbilled_freight)}</div><div className="s">{unbilled.length} loads unbilled</div></div>
        <div className="od-kpi"><div className="l">Active fleet</div><div className="v od-num">{loading ? '—' : (ops.fleet_size ?? 0)}</div><div className="s">{ops.drivers_active ?? 0} drivers active</div></div>
      </section>

      {/* THE APPROVAL DESK. Every external write lands PENDING; these are the
          queues a person clears, and the button goes to the screen that does. */}
      <section className="od-desk" aria-label="Approval desk">
        <span className="t">Approval desk</span>
        {badges === null && <span className="od-chip n">{loading ? 'loading…' : 'queues unavailable'}</span>}
        {badges !== null && deskTotal === 0 && <span className="clear">Sab clear — koi faisla pending nahi.</span>}
        {badges !== null && deskTotal > 0 && desk.filter((d) => d.n > 0).map((d) => (
          <button key={d.k} data-hot="1" onClick={() => onOpenConsole?.(d.go)} title={d.hint}>
            <b>{d.n}</b> {d.label} <span className="h">{d.hint}</span>
          </button>
        ))}
      </section>

      <div className="od-grid">
        <section className="od-panel">
          <header><h2>Active trips — live fleet</h2><span className="m">{liveFleet.length} moving</span></header>
          <div className="od-body od-scroll">
            {liveFleet.length === 0 ? <div className="od-empty">{loading ? 'Loading…' : 'No trips in transit.'}</div> : (
              <table className="od-tb"><thead><tr><th>Vehicle</th><th>Route</th><th>Status</th></tr></thead>
                <tbody>{liveFleet.slice(0, 8).map((t, i) => (
                  <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{t.vehicle}</td><td>{t.route}</td>
                    <td><span className={'od-chip ' + (t.status === 'Unloading' ? 'due' : 'ok')}>{t.status}</span></td></tr>
                ))}</tbody></table>
            )}
          </div>
        </section>

        <section className="od-panel">
          <header><h2>Unloading queue</h2><span className="m">{unloadQ.length} pending</span></header>
          <div className="od-body od-scroll">
            {unloadQ.length === 0 ? <div className="od-empty">{loading ? 'Loading…' : 'Queue clear.'}</div> : (
              <table className="od-tb"><thead><tr><th>Trip</th><th>Vehicle</th><th className="r">Days out</th></tr></thead>
                <tbody>{unloadQ.slice(0, 8).map((t, i) => (
                  <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{t.trip_code}</td><td>{t.vehicle}</td>
                    <td className="r"><span className={'od-chip ' + ((t.days_out ?? 0) > 3 ? 'bad' : 'ok')}>{t.days_out ?? '—'}</span></td></tr>
                ))}</tbody></table>
            )}
          </div>
        </section>
      </div>

      <div className="od-grid">
        <section className="od-panel">
          <header>
            <h2>Revenue by customer</h2>
            <span className="m">{companyId ? 'this firm' : 'all firms'}{dupNames > 0 ? ` · ${dupNames} duplicate master name${dupNames === 1 ? '' : 's'} folded` : ''}</span>
          </header>
          <div className="od-body">
            {custsShown.length === 0 && <div className="od-empty">{loading ? 'Loading…' : 'No revenue in scope.'}</div>}
            {custsShown.map((c, i) => (
              <div className="od-corow" key={c.name}>
                <span className="nm">
                  <span className="od-dot" style={{ background: CO_DOT[i % CO_DOT.length] }} />
                  <span className="t" title={c.names.join(' · ')}>{c.name}</span>
                  {c.names.length > 1 && <span className="od-chip n" title={c.names.join(' · ')}>{c.names.length} names</span>}
                </span>
                <span className="amt">{rL(c.value)}</span>
                <span className="bar"><i style={{ width: Math.max(3, (Number(c.value) / custMax) * 100) + '%', background: CO_DOT[i % CO_DOT.length] }} /></span>
              </div>
            ))}
            {(zeroCount > 0 || dupNames > 0) && (
              <div className="od-note">
                <span>{zeroCount > 0 ? `${zeroCount} customer${zeroCount === 1 ? '' : 's'} with ₹0 in this scope` : ''}</span>
                <span>
                  {zeroCount > 0 && <button onClick={() => setShowZero((v) => !v)}>{showZero ? 'hide ₹0' : 'show ₹0'}</button>}
                  {dupNames > 0 && <> · <button onClick={() => onOpenConsole?.('CUSTOMER')}>merge names in Customer Master</button></>}
                </span>
              </div>
            )}
          </div>
        </section>

        <section className="od-panel">
          <header><h2>Receivables — unbilled loads</h2><span className="m">whose invoice has not gone out</span></header>
          <div className="od-body od-scroll">
            {unbilled.length === 0 ? <div className="od-empty">{loading ? 'Loading…' : 'Every completed load is billed.'}</div> : (
              <table className="od-tb"><thead><tr><th>Trip</th><th>Vehicle</th><th>Customer</th><th className="r">Amount</th><th className="r">Age</th></tr></thead>
                <tbody>{unbilled.slice(0, 8).map((u, i) => (
                  <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{u.trip_code}</td><td>{u.vehicle}</td><td>{canonical(u.customer)}</td>
                    <td className="r">{rL(u.amount)}</td><td className="r"><span className={'od-chip ' + ((u.age_days ?? 0) > 15 ? 'bad' : 'due')}>{u.age_days ?? '—'}d</span></td></tr>
                ))}</tbody></table>
            )}
          </div>
        </section>
      </div>

      {/* Below the fold: only the panels that have something to say. */}
      {(rtkm.length > 0 || alertCount > 0) && (
        <div className="od-grid">
          {rtkm.length > 0 && (
            <section className="od-panel">
              <header><h2>Vehicle productivity</h2><span className="m">by RTKM</span></header>
              <div className="od-body od-scroll">
                <table className="od-tb"><thead><tr><th>Vehicle</th><th className="r">Trips</th><th className="r">Freight</th></tr></thead>
                  <tbody>{rtkm.slice(0, 8).map((v, i) => (
                    <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{v.vehicle}</td><td className="r">{v.trips}</td><td className="r">{rL(v.freight)}</td></tr>
                  ))}</tbody></table>
              </div>
            </section>
          )}
          {alertCount > 0 && (
            <section className="od-panel">
              <header><h2>Documents expiring</h2><span className="m">{(alerts.expired?.length ?? 0)} expired · {(alerts.expiring?.length ?? 0)} due</span></header>
              <div className="od-body od-scroll">
                {vault.length === 0 ? <div className="od-empty">All documents current.</div> : (
                  <table className="od-tb"><thead><tr><th>Document</th><th className="r">Expiry</th><th className="r">Days</th></tr></thead>
                    <tbody>{vault.slice(0, 8).map((d, i) => (
                      <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{d.doc}</td><td className="r">{d.expiry ?? '—'}</td>
                        <td className="r"><span className={'od-chip ' + ((d.days ?? 99) < 0 ? 'bad' : (d.days ?? 99) <= 30 ? 'due' : 'ok')}>{d.days ?? '—'}</span></td></tr>
                    ))}</tbody></table>
                )}
              </div>
            </section>
          )}
        </div>
      )}

      <div className="od-console">
        <div>
          <b>Detailed Operations Console</b>
          <p>Dispatch chat, loading activity, maintenance hub, settlement — every granular tool, unchanged.</p>
        </div>
        <button onClick={() => onOpenConsole?.('MASTER_CONTROL_V5')}>Open full console →</button>
      </div>

      <footer className="od-foot">
        <span>{at ? `Live · updated ${at.toLocaleTimeString('en-IN')}` : 'Loading…'} {v5?.errors?.length ? `· ${v5.errors.length} card(s) on fallback` : ''}</span>
        <span>
          {activeAgents}/{totalAgents} Mahavidya agents active · <button onClick={() => onOpenConsole?.('AGENT_FLEET')}>AI Agent Fleet</button>
          {' '}· company_id scoped
        </span>
      </footer>
    </div>
  );
}
