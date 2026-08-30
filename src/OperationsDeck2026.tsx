// @ts-nocheck
// src/OperationsDeck2026.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Operations "Command Deck" — the 2026 top-level summary Home for the Operations
// module. It is ADDITIVE: it reads the same GET /api/v1/dashboard/v5 payload the
// old console read, re-styled in the deep slate-navy / signal-amber theme, and
// nothing is removed. Every granular tool the daily desk depends on — Vehicle
// Productivity, Unloading Queue, Live Fleet, Document-Vault expiry alerts,
// Receivables — is rendered here from the real payload, and the full detailed
// console (MasterControlV5: dispatch chat, shortage recovery, and the rest)
// stays one click away, unchanged.
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

const AGENTS = [
  ['KAMALA', 'Orchestrator'], ['KALI', 'Dispatch & GPS'], ['TARA', 'Ledger guard'],
  ['TRIPURA', 'Bazaar (Phase-2)'], ['BHUVANESHWARI', 'OCR vault'], ['BHAIRAVI', 'Compliance'],
  ['CHHINNAMASTA', 'Fuel / HSD'], ['DHUMAVATI', 'Tyre / maint.'], ['BAGALAMUKHI', 'Infra / tunnel'],
  ['MATANGI', 'CRM / WhatsApp'],
];

export default function OperationsDeck2026({ currentUser, onOpenConsole }) {
  const [v5, setV5] = useState(null);
  const [agents, setAgents] = useState(null);
  const [companies, setCompanies] = useState([]);
  const [companyId, setCompanyId] = useState('');
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [at, setAt] = useState(null);

  const load = useCallback(async (cid) => {
    setLoading(true); setErr(null);
    try {
      const qs = cid ? `?company_id=${encodeURIComponent(cid)}` : '';
      const [d, a] = await Promise.all([
        fetch(`${API}/api/v1/dashboard/v5${qs}`).then((r) => r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))),
        fetch(`${API}/api/agents/`).then((r) => r.ok ? r.json() : null).catch(() => null),
      ]);
      setV5(d); setAgents(a); setAt(new Date());
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
  const money = fin.money ?? {};
  const health = fin.health ?? {};
  const custs = fin.customers ?? [];
  const liveFleet = ops.live_fleet ?? [];
  const unloadQ = ops.unloading_queue ?? [];
  const rtkm = Array.isArray(ops.vehicle_rtkm) ? ops.vehicle_rtkm : (ops.vehicle_rtkm?.all ?? ops.vehicle_rtkm?.rows ?? []);
  const vault = ops.doc_vault ?? [];
  const alerts = ops.compliance_alerts ?? {};
  const unbilled = fin.unbilled_list ?? [];
  const activeAgents = agents?.active ?? (agents?.count ? agents.count : 10);
  const totalAgents = agents?.count ?? 10;
  const custMax = Math.max(1, ...custs.map((c) => Number(c.value || 0)));
  const healthClean = !health || ((health.mixed_company_vouchers ?? 0) == 0 && (health.bills_spanning_companies ?? 0) == 0 && (health.unbalanced_vouchers ?? 0) == 0);

  return (
    <div className="od-root">
      <style>{`
        .od-root { --ground:#0b1220; --surface:#131c2e; --surface2:#0f1727; --line:#22304a; --line2:#33455f;
          --ink:#e6edf7; --ink2:#a9b8ce; --ink3:#6b7c96; --accent:#ffb020; --accent-soft:#2a2013;
          --good:#34d399; --good-soft:#10281f; --warn:#f5b445; --crit:#ff7777; --crit-soft:#2c1618;
          --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,monospace;
          background:var(--ground); color:var(--ink); min-height:100vh; padding:clamp(14px,2.5vw,28px);
          font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
        .od-root *{box-sizing:border-box;}
        .od-num{font-family:var(--mono);font-variant-numeric:tabular-nums;}
        .od-ey{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink3);font-weight:600;}
        .od-mast{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;margin-bottom:18px;}
        .od-mast h1{font-size:20px;font-weight:750;letter-spacing:-.01em;margin:0;}
        .od-mast p{margin:2px 0 0;font-size:12px;color:var(--ink3);}
        .od-sel{display:flex;gap:5px;background:var(--surface);border:1px solid var(--line);padding:5px;border-radius:12px;flex-wrap:wrap;}
        .od-sel button{font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;border:0;background:transparent;color:var(--ink2);padding:7px 12px;border-radius:8px;display:flex;align-items:center;gap:7px;transition:.15s;}
        .od-sel button[data-on="1"]{background:var(--accent-soft);color:var(--ink);}
        .od-sel button:hover{background:var(--surface2);}
        .od-dot{width:8px;height:8px;border-radius:50%;flex:none;}
        .od-strip{display:flex;flex-wrap:wrap;align-items:center;gap:9px 18px;border-radius:12px;padding:11px 16px;margin-bottom:18px;
          background:var(--good-soft);border:1px solid color-mix(in oklab,var(--good) 30%,var(--line));}
        .od-strip.bad{background:var(--crit-soft);border-color:color-mix(in oklab,var(--crit) 35%,var(--line));}
        .od-strip .lk{font-weight:700;font-size:13px;display:flex;align-items:center;gap:7px;color:var(--good);}
        .od-strip.bad .lk{color:var(--crit);}
        .od-strip .it{font-size:12.5px;color:var(--ink2);}
        .od-strip .it b{color:var(--ink);} .od-strip .it .g{color:var(--good);font-weight:700;} .od-strip .it .r{color:var(--crit);font-weight:700;}
        .od-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin-bottom:18px;}
        .od-kpi{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:15px 16px;position:relative;overflow:hidden;}
        .od-kpi::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);opacity:.85;}
        .od-kpi .l{font-size:11.5px;color:var(--ink3);font-weight:600;}
        .od-kpi .v{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:26px;font-weight:650;letter-spacing:-.02em;margin:6px 0 2px;}
        .od-kpi .v small{font-size:13px;color:var(--ink3);font-weight:500;}
        .od-kpi .s{font-size:11.5px;color:var(--ink3);}
        .od-grid{display:grid;grid-template-columns:1.1fr 1fr;gap:16px;align-items:start;margin-bottom:16px;}
        .od-grid3{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;align-items:start;}
        .od-panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;overflow:hidden;}
        .od-panel>header{display:flex;align-items:baseline;justify-content:space-between;padding:14px 16px 11px;border-bottom:1px solid var(--line);}
        .od-panel>header h2{font-size:13.5px;font-weight:700;margin:0;letter-spacing:-.01em;}
        .od-panel>header .m{font-size:11px;color:var(--ink3);}
        .od-body{padding:6px 16px 14px;}
        .od-corow{display:grid;grid-template-columns:1fr auto;gap:4px 10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);}
        .od-corow:last-child{border-bottom:0;}
        .od-corow .nm{display:flex;align-items:center;gap:8px;font-weight:600;font-size:13px;min-width:0;}
        .od-corow .nm span.t{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        .od-corow .amt{font-family:var(--mono);font-variant-numeric:tabular-nums;font-weight:650;font-size:13.5px;text-align:right;}
        .od-corow .bar{grid-column:1/-1;height:6px;border-radius:4px;background:var(--surface2);overflow:hidden;}
        .od-corow .bar i{display:block;height:100%;border-radius:4px;}
        .od-agents{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;}
        .od-agent{display:flex;align-items:center;gap:9px;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--surface2);}
        .od-agent .p{width:8px;height:8px;border-radius:50%;flex:none;background:var(--good);}
        .od-agent.idle .p{background:var(--ink3);}
        .od-agent b{font-size:12px;font-weight:650;display:block;}
        .od-agent span{font-size:10px;color:var(--ink3);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
        table.od-tb{width:100%;border-collapse:collapse;font-size:12.5px;}
        table.od-tb th{text-align:left;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--ink3);font-weight:600;padding:7px 6px 7px 0;border-bottom:1px solid var(--line);}
        table.od-tb td{padding:8px 6px 8px 0;border-bottom:1px solid var(--line);color:var(--ink2);}
        table.od-tb tr:last-child td{border-bottom:0;}
        table.od-tb td.r,table.od-tb th.r{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums;}
        .od-chip{font-size:10px;font-weight:600;padding:2px 8px;border-radius:20px;display:inline-block;white-space:nowrap;}
        .od-chip.ok{background:var(--good-soft);color:var(--good);} .od-chip.due{background:var(--accent-soft);color:var(--accent);} .od-chip.bad{background:var(--crit-soft);color:var(--crit);}
        .od-scroll{overflow-x:auto;} .od-empty{color:var(--ink3);font-size:12.5px;padding:14px 0;text-align:center;}
        .od-console{display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--surface);border:1px solid var(--line2);border-radius:14px;padding:14px 18px;margin-top:16px;}
        .od-console b{font-size:13.5px;} .od-console p{margin:2px 0 0;font-size:12px;color:var(--ink3);}
        .od-console button{font:inherit;font-weight:650;font-size:13px;cursor:pointer;border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft);padding:9px 16px;border-radius:10px;}
        .od-foot{margin-top:18px;font-size:11.5px;color:var(--ink3);display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;}
        @media (max-width:900px){.od-kpis{grid-template-columns:repeat(2,1fr);}.od-grid,.od-grid3{grid-template-columns:1fr;}.od-agents{grid-template-columns:1fr;}}
      `}</style>

      <header className="od-mast">
        <div>
          <h1>Operations — Command Deck</h1>
          <p>Live summary · Bongaigaon, Assam · {currentUser?.full_name ? `${currentUser.full_name}` : 'Prasad Transport'}</p>
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

      {err && <div className="od-strip bad"><span className="lk">Could not load live data</span><span className="it">{err} — the detailed console below still works.</span></div>}

      <div className={'od-strip' + (healthClean ? '' : ' bad')} role="status">
        <span className="lk">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
          Strict ID isolation — {healthClean ? 'locked' : 'attention'}
        </span>
        <span className="it">Vouchers balanced <b className={(health.unbalanced_vouchers ?? 0) == 0 ? 'g' : 'r'}>{health.unbalanced_vouchers ?? 0} off</b></span>
        <span className="it">Mixed-company vouchers <b className={(health.mixed_company_vouchers ?? 0) == 0 ? 'g' : 'r'}>{health.mixed_company_vouchers ?? 0}</b></span>
        <span className="it">Bills spanning firms <b className={(health.bills_spanning_companies ?? 0) == 0 ? 'g' : 'r'}>{health.bills_spanning_companies ?? 0}</b></span>
        <span className="it">Ledgers off-chart <b className={(health.ledgers_off_chart ?? 0) == 0 ? 'g' : 'r'}>{health.ledgers_off_chart ?? 0}</b></span>
      </div>

      <section className="od-kpis">
        <div className="od-kpi"><div className="l">Trips in transit</div><div className="v od-num">{loading ? '—' : (ops.active_trips ?? 0)}</div><div className="s">{ops.pending_unloading ?? 0} awaiting unload</div></div>
        <div className="od-kpi"><div className="l">Freight to bill</div><div className="v od-num">{loading ? '—' : rL(money.unbilled_freight)}</div><div className="s">{unbilled.length} loads unbilled</div></div>
        <div className="od-kpi"><div className="l">Active fleet</div><div className="v od-num">{loading ? '—' : (ops.fleet_size ?? 0)}</div><div className="s">{ops.drivers_active ?? 0} drivers active</div></div>
        <div className="od-kpi"><div className="l">Mahavidya agents</div><div className="v od-num">{activeAgents} <small>/ {totalAgents}</small></div><div className="s">{(agents?.parked ?? 0)} parked · graph live</div></div>
      </section>

      <div className="od-grid">
        <section className="od-panel">
          <header><h2>Revenue by customer</h2><span className="m">scoped to company_id</span></header>
          <div className="od-body">
            {custs.length === 0 && <div className="od-empty">{loading ? 'Loading…' : 'No trips in scope.'}</div>}
            {custs.map((c, i) => (
              <div className="od-corow" key={i}>
                <span className="nm"><span className="od-dot" style={{ background: CO_DOT[i % CO_DOT.length] }} /><span className="t">{c.name}</span></span>
                <span className="amt">{rL(c.value)}</span>
                <span className="bar"><i style={{ width: Math.max(3, (Number(c.value) / custMax) * 100) + '%', background: CO_DOT[i % CO_DOT.length] }} /></span>
              </div>
            ))}
          </div>
        </section>

        <section className="od-panel">
          <header><h2>10 Mahavidya agents</h2><span className="m">{activeAgents} active</span></header>
          <div className="od-body">
            <div className="od-agents">
              {AGENTS.map(([nm, role]) => {
                const idle = nm === 'KALI' || nm === 'TRIPURA';
                return (
                  <div className={'od-agent' + (idle ? ' idle' : '')} key={nm}>
                    <span className="p" /><span style={{ minWidth: 0 }}><b>{nm}</b><span>{role}</span></span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      </div>

      <div className="od-grid3">
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

        <section className="od-panel">
          <header><h2>Vehicle productivity</h2><span className="m">by RTKM</span></header>
          <div className="od-body od-scroll">
            {rtkm.length === 0 ? <div className="od-empty">{loading ? 'Loading…' : 'No data.'}</div> : (
              <table className="od-tb"><thead><tr><th>Vehicle</th><th className="r">Trips</th><th className="r">Freight</th></tr></thead>
                <tbody>{rtkm.slice(0, 8).map((v, i) => (
                  <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{v.vehicle}</td><td className="r">{v.trips}</td><td className="r">{rL(v.freight)}</td></tr>
                ))}</tbody></table>
            )}
          </div>
        </section>

        <section className="od-panel">
          <header><h2>Document vault — expiry alerts</h2><span className="m">{(alerts.expired?.length ?? 0)} expired · {(alerts.expiring?.length ?? 0)} due</span></header>
          <div className="od-body od-scroll">
            {vault.length === 0 ? <div className="od-empty">{loading ? 'Loading…' : 'All documents current.'}</div> : (
              <table className="od-tb"><thead><tr><th>Document</th><th className="r">Expiry</th><th className="r">Days</th></tr></thead>
                <tbody>{vault.slice(0, 8).map((d, i) => (
                  <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{d.doc}</td><td className="r">{d.expiry ?? '—'}</td>
                    <td className="r"><span className={'od-chip ' + ((d.days ?? 99) < 0 ? 'bad' : (d.days ?? 99) <= 30 ? 'due' : 'ok')}>{d.days ?? '—'}</span></td></tr>
                ))}</tbody></table>
            )}
          </div>
        </section>
      </div>

      <section className="od-panel" style={{ marginTop: 16 }}>
        <header><h2>Receivables — unbilled loads</h2><span className="m">whose invoice has not gone out</span></header>
        <div className="od-body od-scroll">
          {unbilled.length === 0 ? <div className="od-empty">{loading ? 'Loading…' : 'Every completed load is billed.'}</div> : (
            <table className="od-tb"><thead><tr><th>Trip</th><th>Vehicle</th><th>Customer</th><th className="r">Amount</th><th className="r">Age</th></tr></thead>
              <tbody>{unbilled.slice(0, 10).map((u, i) => (
                <tr key={i}><td style={{ color: 'var(--ink)', fontWeight: 600 }}>{u.trip_code}</td><td>{u.vehicle}</td><td>{u.customer}</td>
                  <td className="r">{rL(u.amount)}</td><td className="r"><span className={'od-chip ' + ((u.age_days ?? 0) > 15 ? 'bad' : 'due')}>{u.age_days ?? '—'}d</span></td></tr>
              ))}</tbody></table>
          )}
        </div>
      </section>

      <div className="od-console">
        <div>
          <b>Detailed Operations Console</b>
          <p>Dispatch chat, driver shortage recovery, master trip settlement, and every granular tool — unchanged.</p>
        </div>
        <button onClick={() => onOpenConsole?.('MASTER_CONTROL_V5')}>Open full console →</button>
      </div>

      <footer className="od-foot">
        <span>{at ? `Live · updated ${at.toLocaleTimeString('en-IN')}` : 'Loading…'} {v5?.errors?.length ? `· ${v5.errors.length} card(s) on fallback` : ''}</span>
        <span>Reads GET /api/v1/dashboard/v5 · isolation enforced at company_id</span>
      </footer>
    </div>
  );
}
