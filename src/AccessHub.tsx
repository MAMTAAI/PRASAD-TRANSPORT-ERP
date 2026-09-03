// @ts-nocheck
// ============================================================================
// ACCESS CONTROL HUB — the office's one screen over every outside party
//
// Customers · Fleet Partners · Service Vendors · Drivers · Market Drivers.
// For each row: the derived access state (ACTIVE / PENDING / BLOCKED /
// ARCHIVED), whether a login exists and when it was last used, live sessions,
// inline edit of name / mobile / email, per-party feature toggles, the audit
// trail, and the four decisions — Activate, Block, Archive, Edit. The
// quarantine strip on top counts every staging queue waiting for an APPROVE.
//
// API: server/modules/access.routes.js (admin only). Analysis and the rules
// behind every button: docs/ACCESS-CONTROL-MATRIX.md.
// ============================================================================
import React, { useEffect, useMemo, useState, lazy, Suspense } from 'react';
import { API_BASE } from './lib/apiBase';
import { currentUser, isAdmin as isAdminRole } from './lib/rbac';

const PortalAccessControl = lazy(() => import('./mastercontrol/PortalAccessControl'));
const API = API_BASE;

const authed = async (path, opts = {}) => {
  const token = localStorage.getItem('prasad_token');
  const r = await fetch(`${API}/api/v1${path}`, {
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail ?? j.error ?? `HTTP ${r.status}`);
  return j;
};

const KIND_TABS = [
  { key: 'CUSTOMER', label: 'Customers', icon: '🏢', role: 'CUSTOMER', hint: 'Customer app — loads, tracking, PODs, ledger' },
  { key: 'FLEET_PARTNER', label: 'Fleet Partners', icon: '🚚', role: 'VENDOR', hint: 'Partner app — Load Bazaar, trucks, earnings' },
  { key: 'SERVICE_VENDOR', label: 'Service Vendors', icon: '⛽', role: 'VENDOR', hint: 'Pumps, tyre shops, spares — bill uploads' },
  { key: 'DRIVER', label: 'Drivers', icon: '🧑‍✈️', role: 'DRIVER', hint: 'Own & attached fleet — duty, uploads, khata' },
  { key: 'MARKET_DRIVER', label: 'Market Drivers', icon: '🪪', role: null, hint: "A partner's drivers — approve, block, reject. No login." },
  // Owner, 3-Sep: the office must be able to switch an individual truck off,
  // not only the partner who owns it. Same door, same audit trail.
  { key: 'MARKET_VEHICLE', label: 'Market Trucks', icon: '🚛', role: null, hint: "A partner's trucks — activate, deactivate with a reason. A deactivated truck cannot take a load." },
  { key: 'MATRIX', label: 'Role Matrix', icon: '🧩', role: null, hint: 'Which pages and fields each role may see at all' },
];
const STATE = {
  ACTIVE:   { label: 'Active',   color: '#34d399', bg: 'rgba(16,185,129,.12)', br: 'rgba(16,185,129,.35)' },
  PENDING:  { label: 'Pending',  color: '#fbbf24', bg: 'rgba(245,158,11,.12)', br: 'rgba(245,158,11,.35)' },
  BLOCKED:  { label: 'Blocked',  color: '#f87171', bg: 'rgba(239,68,68,.12)',  br: 'rgba(239,68,68,.35)' },
  ARCHIVED: { label: 'Archived', color: '#94a3b8', bg: 'rgba(148,163,184,.12)', br: 'rgba(148,163,184,.3)' },
};
const QUARANTINE = [
  { key: 'expense_bills', label: 'Expense bills', icon: '🧾', go: 'EXPENSE_APPROVALS' },
  { key: 'app_uploads', label: 'App uploads', icon: '📱', go: 'EXPENSE_APPROVALS' },
  { key: 'kyc', label: 'KYC applications', icon: '🪪', go: 'ONBOARDING' },
  { key: 'driver_requests', label: 'Driver requests', icon: '🙋', go: 'DRIVER' },
  { key: 'market_trucks', label: 'Market trucks', icon: '🚚', tab: 'MARKET_VEHICLE' },
  { key: 'market_drivers', label: 'Market drivers', icon: '🧑‍✈️', tab: 'MARKET_DRIVER' },
  { key: 'loads_review', label: 'Loads to review', icon: '📦', go: 'BAZAAR_ADMIN' },
  { key: 'award_requests', label: 'Award requests', icon: '🏁', go: 'BAZAAR_ADMIN' },
  { key: 'pods', label: 'PODs submitted', icon: '📄', go: 'BAZAAR_ADMIN' },
];

const CSS = `
@keyframes ahUp { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
@keyframes ahIn { from { opacity: 0; transform: scale(.98) } to { opacity: 1; transform: none } }
.ah { color: #e2e8f0; font-family: 'Inter', system-ui, sans-serif; padding-bottom: 60px; }
.ah-card { background: rgba(15,23,42,.7); border: 1px solid #1e293b; border-radius: 16px; }
.ah-tab { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 12px; border: 1px solid transparent; background: transparent; color: #94a3b8; font-weight: 700; font-size: 13px; cursor: pointer; transition: all .15s ease; white-space: nowrap; }
.ah-tab:hover { color: #e2e8f0; background: rgba(30,41,59,.6); }
.ah-tab.on { color: #fff; background: linear-gradient(135deg, rgba(56,189,248,.18), rgba(139,92,246,.18)); border-color: rgba(56,189,248,.35); }
.ah-count { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: #1e293b; color: #cbd5e1; }
.ah-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 800; letter-spacing: .04em; border: 1px solid; transition: all .2s; }
.ah-btn { min-height: 34px; padding: 0 12px; border-radius: 9px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; font-weight: 700; font-size: 12px; cursor: pointer; transition: transform .12s, border-color .15s, background .15s, opacity .15s; white-space: nowrap; }
.ah-btn:hover { transform: translateY(-1px); border-color: #475569; }
.ah-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.ah-btn--ok { background: linear-gradient(135deg,#10b981,#059669); border-color: transparent; color: #fff; }
.ah-btn--no { background: rgba(239,68,68,.1); border-color: rgba(239,68,68,.45); color: #fca5a5; }
.ah-btn--warn { background: rgba(245,158,11,.1); border-color: rgba(245,158,11,.45); color: #fcd34d; }
.ah-btn--ghost { background: transparent; }
.ah-input { background: #020617; border: 1px solid #334155; color: #f1f5f9; border-radius: 9px; padding: 8px 10px; font-size: 13px; color-scheme: dark; transition: border-color .15s, box-shadow .15s; }
.ah-input:focus { outline: none; border-color: #38bdf8; box-shadow: 0 0 0 3px rgba(56,189,248,.18); }
.ah-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; }
.ah-table th { text-align: left; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: #64748b; padding: 10px 12px; border-bottom: 1px solid #1e293b; position: sticky; top: 0; background: #0b1220; z-index: 1; }
.ah-table td { padding: 11px 12px; border-bottom: 1px solid rgba(30,41,59,.7); vertical-align: middle; }
.ah-row { animation: ahUp .25s ease both; transition: background .15s; }
.ah-row:hover { background: rgba(30,41,59,.35); }
.ah-sub { font-size: 11.5px; color: #94a3b8; }
.ah-expand { animation: ahIn .2s ease; background: rgba(2,6,23,.55); }
.ah-switch { position: relative; width: 38px; height: 22px; border-radius: 999px; background: #334155; border: 0; cursor: pointer; transition: background .2s; flex: none; }
.ah-switch::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .2s; }
.ah-switch.on { background: #10b981; } .ah-switch.on::after { transform: translateX(16px); }
.ah-switch:disabled { opacity: .4; cursor: not-allowed; }
.ah-q { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.ah-qcard { padding: 12px 14px; border-radius: 14px; border: 1px solid #1e293b; background: rgba(2,6,23,.5); cursor: pointer; transition: transform .15s, border-color .15s; }
.ah-qcard:hover { transform: translateY(-2px); border-color: #38bdf8; }
.ah-toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); z-index: 10001; background: #0f172a; border: 1px solid #334155; color: #e2e8f0; padding: 10px 16px; border-radius: 12px; font-size: 13px; box-shadow: 0 10px 30px rgba(0,0,0,.4); animation: ahUp .2s ease; max-width: 90vw; }
`;
let cssMounted = false;

const Pill = ({ state }) => {
  const m = STATE[state] ?? STATE.PENDING;
  return <span className="ah-pill" style={{ color: m.color, background: m.bg, borderColor: m.br }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: m.color, boxShadow: state === 'ACTIVE' ? `0 0 8px ${m.color}` : 'none' }} />{m.label}</span>;
};
const fmtDt = (v) => (v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const rel = (v) => {
  if (!v) return 'never';
  const d = (Date.now() - new Date(v).getTime()) / 36e5;
  if (d < 1) return `${Math.max(1, Math.round(d * 60))} min ago`;
  if (d < 48) return `${Math.round(d)} h ago`;
  return `${Math.round(d / 24)} d ago`;
};

export default function AccessHub({ onNavigate }) {
  const user = currentUser();
  const admin = isAdminRole(user);
  const [kind, setKind] = useState('CUSTOMER');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState(null);
  const [q, setQ] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [busy, setBusy] = useState('');
  const [editing, setEditing] = useState(null);      // { id, draft }
  const [asking, setAsking] = useState(null);        // { id, action: 'block'|'archive', reason }
  const [expanded, setExpanded] = useState(null);    // id
  const [detail, setDetail] = useState({});          // id → { modules, audit }
  const [toast, setToast] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (cssMounted) return;
    const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); cssMounted = true;
  }, []);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 4200); return () => clearTimeout(t); }, [toast]);

  const loadSummary = async () => { try { setSummary(await authed('/access/summary')); } catch (e) { setErr(e.message); } };
  const load = async (k = kind) => {
    if (k === 'MATRIX') return;
    setLoading(true); setErr('');
    try { const j = await authed(`/access/parties?kind=${k}&limit=1000`); setRows(j.parties ?? []); }
    catch (e) { setErr(e.message); setRows([]); }
    finally { setLoading(false); }
  };
  useEffect(() => { loadSummary(); }, []);
  useEffect(() => { setExpanded(null); setEditing(null); setAsking(null); load(kind); /* eslint-disable-line */ }, [kind]);

  const tab = KIND_TABS.find((t) => t.key === kind);
  // Market drivers and market trucks are the two kinds with no login at all:
  // they are switched on and off through system_status, and the columns that
  // describe a session are meaningless for them.
  const isMarket = kind === 'MARKET_DRIVER' || kind === 'MARKET_VEHICLE';
  const counts = useMemo(() => {
    const by = { ALL: rows.length, ACTIVE: 0, PENDING: 0, BLOCKED: 0, ARCHIVED: 0 };
    for (const r of rows) by[r.access] = (by[r.access] ?? 0) + 1;
    return by;
  }, [rows]);
  const visible = useMemo(() => {
    const s = q.trim().toLowerCase();
    return rows.filter((r) => (stateFilter === 'ALL' || r.access === stateFilter)
      && (!s || `${r.name ?? ''} ${r.mobile ?? ''} ${r.email ?? ''} ${r.partner_name ?? ''}`.toLowerCase().includes(s)));
  }, [rows, q, stateFilter]);

  const act = async (r, action, body = {}) => {
    setBusy(r.id); setErr('');
    try {
      const j = await authed(`/access/${kind}/${r.id}/${action}`, { method: 'POST', body: JSON.stringify(body) });
      const note = (j.notes ?? []).join(' · ');
      setToast(`${STATE[j.access]?.label ?? action} — ${r.name}${note ? ` · ${note}` : ''}${j.sessions_revoked ? ` · ${j.sessions_revoked} session(s) ended` : ''}`);
      setAsking(null);
      await Promise.all([load(), loadSummary()]);
    } catch (e) { setErr(`${r.name}: ${e.message}`); }
    finally { setBusy(''); }
  };
  const saveEdit = async (r) => {
    setBusy(r.id); setErr('');
    try {
      const d = editing.draft; const body = {};
      for (const k of Object.keys(d)) if (String(d[k] ?? '') !== String(r[k] ?? '')) body[k] = d[k];
      if (Object.keys(body).length) await authed(`/access/${kind}/${r.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      setEditing(null); setToast(`Saved — ${d.name ?? r.name}`);
      await load();
    } catch (e) { setErr(`${r.name}: ${e.message}`); }
    finally { setBusy(''); }
  };
  const revoke = async (r) => {
    setBusy(r.id);
    try { const j = await authed(`/access/${kind}/${r.id}/sessions/revoke`, { method: 'POST', body: '{}' }); setToast(`${j.sessions_revoked} live session(s) ended — ${r.name}`); await load(); }
    catch (e) { setErr(e.message); } finally { setBusy(''); }
  };
  const openDetail = async (r) => {
    if (expanded === r.id) { setExpanded(null); return; }
    setExpanded(r.id);
    if (detail[r.id]) return;
    try {
      const [audit, mods] = await Promise.all([
        authed(`/access/${kind}/${r.id}/audit`),
        tab?.role && kind !== 'DRIVER' ? authed(`/access/modules?role=${tab.role}`) : Promise.resolve({ modules: [] }),
      ]);
      setDetail((d) => ({ ...d, [r.id]: { audit, modules: mods.modules ?? [] } }));
    } catch (e) { setErr(e.message); }
  };
  const toggleFeature = async (r, short, on) => {
    setBusy(r.id);
    try {
      await authed(`/access/${kind}/${r.id}/features`, { method: 'POST', body: JSON.stringify({ features: { [short]: on } }) });
      setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, features: { ...(x.features ?? {}), [short]: on } } : x)));
      setDetail((d) => ({ ...d, [r.id]: undefined }));
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  };

  if (!admin) {
    return <div className="ah" style={{ padding: 40, textAlign: 'center', color: '#f59e0b' }}>🔒 The Access Control Hub is for Admin / Super Admin only.</div>;
  }

  const stagingTotal = summary ? Object.values(summary.staging ?? {}).reduce((s, n) => s + (Number(n) || 0), 0) : 0;

  return (
    <div className="ah pt-anim-fade">
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14, marginBottom: 18 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'clamp(22px, 5vw, 28px)', fontWeight: 900 }}>🛂 Access Control Hub <span className="pt-badge pt-badge--ai" style={{ verticalAlign: 'middle' }}>Admin</span></h2>
          <p style={{ margin: '5px 0 0', color: '#94a3b8', fontSize: 14 }}>Who may enter which portal and what they see — decided here, checked by the server on every request. Nothing an outside party sends touches the books until an APPROVE below.</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {summary?.guard && (
            <span className="ah-pill" style={{ color: summary.guard.mode === 'enforce' ? '#34d399' : '#fbbf24', background: 'rgba(2,6,23,.6)', borderColor: '#1e293b' }}>
              🛡 quarantine fence: {summary.guard.mode}
            </span>
          )}
          <button className="ah-btn" onClick={() => { load(); loadSummary(); }}>↻ Refresh</button>
        </div>
      </div>

      {/* ── Quarantine strip ── */}
      <div className="ah-card" style={{ padding: '14px 16px', marginBottom: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <b style={{ fontSize: 13, color: '#fbbf24' }}>⏳ Quarantine — waiting for an APPROVE ({stagingTotal})</b>
          <span className="ah-sub">Everything an outside party sends lands here first. Click a card to go to its desk.</span>
        </div>
        <div className="ah-q">
          {QUARANTINE.map((c) => {
            const n = Number(summary?.staging?.[c.key] ?? 0);
            return (
              <div key={c.key} className="ah-qcard" style={{ borderColor: n > 0 ? 'rgba(245,158,11,.45)' : undefined }}
                   onClick={() => (c.tab ? setKind(c.tab) : onNavigate?.(c.go))}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 18 }}>{c.icon}</span>
                  <span style={{ fontSize: 22, fontWeight: 900, color: n > 0 ? '#fbbf24' : '#475569' }}>{summary ? n : '…'}</span>
                </div>
                <div style={{ fontSize: 12, color: '#cbd5e1', marginTop: 4, fontWeight: 600 }}>{c.label}</div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6, marginBottom: 12 }}>
        {KIND_TABS.map((t) => {
          const s = summary?.kinds?.[t.key];
          return (
            <button key={t.key} className={`ah-tab ${kind === t.key ? 'on' : ''}`} onClick={() => setKind(t.key)} title={t.hint}>
              <span>{t.icon}</span>{t.label}
              {s && <span className="ah-count">{s.total}</span>}
              {s?.PENDING > 0 && <span className="ah-count" style={{ background: 'rgba(245,158,11,.2)', color: '#fbbf24' }}>{s.PENDING} pending</span>}
            </button>
          );
        })}
      </div>

      {kind === 'MATRIX' ? (
        <div className="ah-card" style={{ padding: 16 }}>
          <div className="ah-sub" style={{ marginBottom: 10 }}>Role-wide pages and fields. Sensitive fields (freight, driver phone, balances, target price) are off until switched on here. A party's own toggles (in its row) can only narrow this further.</div>
          <Suspense fallback={<div style={{ padding: 30, color: '#94a3b8' }}>Loading the matrix…</div>}><PortalAccessControl /></Suspense>
        </div>
      ) : (
        <div className="ah-card" style={{ overflow: 'hidden' }}>
          {/* ── Toolbar ── */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '12px 14px', borderBottom: '1px solid #1e293b' }}>
            <input className="ah-input" style={{ width: 240 }} placeholder={`Search ${tab?.label?.toLowerCase()} — name, mobile, email`} value={q} onChange={(e) => setQ(e.target.value)} />
            <div style={{ display: 'flex', gap: 4 }}>
              {['ALL', 'ACTIVE', 'PENDING', 'BLOCKED', 'ARCHIVED'].map((s) => (
                <button key={s} className={`ah-tab ${stateFilter === s ? 'on' : ''}`} style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => setStateFilter(s)}>
                  {s === 'ALL' ? 'All' : STATE[s].label} <span className="ah-count">{counts[s] ?? 0}</span>
                </button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <span className="ah-sub">{tab?.hint}</span>
          </div>
          {err && <div style={{ margin: 12, padding: '8px 12px', borderRadius: 10, background: 'rgba(239,68,68,.08)', border: '1px solid rgba(239,68,68,.35)', color: '#fca5a5', fontSize: 12.5 }}>❌ {err}</div>}

          <div style={{ overflowX: 'auto', maxHeight: '68vh', overflowY: 'auto' }}>
            <table className="ah-table">
              <thead><tr>
                <th style={{ minWidth: 240 }}>Party</th>
                <th>{isMarket ? 'Partner' : 'Login'}</th>
                <th>Sessions</th>
                <th>Access</th>
                <th style={{ minWidth: 300 }}>Decisions</th>
              </tr></thead>
              <tbody>
                {loading && rows.length === 0 && <tr><td colSpan={5} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>Loading…</td></tr>}
                {!loading && visible.length === 0 && <tr><td colSpan={5} style={{ padding: 30, textAlign: 'center', color: '#64748b' }}>Nothing here{q ? ' for that search' : ''}.</td></tr>}
                {visible.map((r, i) => {
                  const isEd = editing?.id === r.id;
                  const d = editing?.draft ?? {};
                  const busyRow = busy === r.id;
                  const isPartner = kind === 'FLEET_PARTNER';
                  return (
                    <React.Fragment key={r.id}>
                      <tr className="ah-row" style={{ animationDelay: `${Math.min(i, 20) * 18}ms`, opacity: r.access === 'ARCHIVED' ? 0.6 : 1 }}>
                        {/* Party */}
                        <td>
                          {isEd ? (
                            <div style={{ display: 'grid', gap: 6, maxWidth: 320 }}>
                              <input className="ah-input" value={d.name ?? ''} onChange={(e) => setEditing({ ...editing, draft: { ...d, name: e.target.value } })} placeholder="Name" />
                              <div style={{ display: 'flex', gap: 6 }}>
                                <input className="ah-input" style={{ width: 130 }} value={d.mobile ?? ''} onChange={(e) => setEditing({ ...editing, draft: { ...d, mobile: e.target.value } })} placeholder="10-digit mobile" />
                                {kind !== 'DRIVER' && !isMarket && <input className="ah-input" style={{ flex: 1 }} value={d.email ?? ''} onChange={(e) => setEditing({ ...editing, draft: { ...d, email: e.target.value } })} placeholder="email" />}
                              </div>
                              {isPartner && (
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <select className="ah-input" value={d.subscription_plan ?? 'FREE'} onChange={(e) => setEditing({ ...editing, draft: { ...d, subscription_plan: e.target.value } })}>
                                    {['FREE', 'SILVER', 'GOLD', 'PLATINUM'].map((p) => <option key={p}>{p}</option>)}
                                  </select>
                                  <input className="ah-input" type="number" style={{ width: 110 }} value={d.max_vehicle_limit ?? 0} onChange={(e) => setEditing({ ...editing, draft: { ...d, max_vehicle_limit: e.target.value } })} placeholder="truck ceiling (0 = none)" />
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <div style={{ fontWeight: 800, color: '#fff', display: 'flex', alignItems: 'center', gap: 8 }}>
                                {r.name}
                                {r.vendor_kind === 'FLEET_PARTNER' && r.subscription_plan && <span className="ah-count">{r.subscription_plan}{r.max_vehicle_limit ? ` · ${r.max_vehicle_limit} trucks` : ''}</span>}
                              </div>
                              <div className="ah-sub">
                                {/* A truck has no mobile and never will — saying
                                    "cannot log in" about a lorry is noise, so it
                                    shows what it actually is instead. */}
                                {kind === 'MARKET_VEHICLE'
                                  ? <span style={{ color: '#94a3b8' }}>{[r.vehicle_class, r.capacity ? `${r.capacity} T` : null].filter(Boolean).join(' · ') || 'truck'}</span>
                                  : r.mobile ? `📱 ${r.mobile}` : <span style={{ color: '#f87171' }}>no mobile — cannot log in</span>}
                                {r.email && !String(r.email).includes('@login.prasadtransport.com') ? ` · ${r.email}` : ''}
                                {kind === 'DRIVER' && r.license_no ? ` · DL ${r.license_no}` : ''}
                                {kind === 'MARKET_DRIVER' && r.licence_no ? ` · DL ${r.licence_no}` : ''}
                                {kind === 'MARKET_VEHICLE' ? [r.vehicle_class, r.capacity ? `${r.capacity} T` : null].filter(Boolean).map((x) => ` · ${x}`).join('') : ''}
                                {r.vendor_type && kind === 'SERVICE_VENDOR' ? ` · ${r.vendor_type}` : ''}
                              </div>
                              <div className="ah-sub" style={{ color: '#64748b' }}>
                                {kind === 'FLEET_PARTNER' ? `${r.trucks ?? 0} trucks` : kind === 'SERVICE_VENDOR' ? `${r.bills ?? 0} bills` : kind === 'CUSTOMER' ? `${r.activity ?? 0} loads` : kind === 'DRIVER' ? `${r.activity ?? 0} trips` : kind === 'MARKET_VEHICLE' ? `${r.activity ?? 0} trips` : `${r.activity ?? 0} trucks named`}
                                {r.record_status && r.record_status !== 'ACTIVE' ? ` · master: ${r.record_status}` : ''}
                              </div>
                            </>
                          )}
                        </td>
                        {/* Login / Partner */}
                        <td>
                          {isMarket ? (
                            <div><div style={{ color: '#cbd5e1' }}>{r.partner_name ?? '—'}</div><div className="ah-sub">registered {rel(r.created_at)}</div></div>
                          ) : kind === 'DRIVER' ? (
                            <div><div style={{ color: '#cbd5e1' }}>OTP / login link</div><div className="ah-sub">last seen {rel(r.last_seen)}</div></div>
                          ) : r.login_id ? (
                            <div>
                              <span className="ah-pill" style={r.login_status === 'ACTIVE' && r.account_status !== 'SUSPENDED' ? { color: '#34d399', background: 'rgba(16,185,129,.1)', borderColor: 'rgba(16,185,129,.3)' } : { color: '#f87171', background: 'rgba(239,68,68,.1)', borderColor: 'rgba(239,68,68,.3)' }}>
                                {r.login_status === 'ACTIVE' && r.account_status !== 'SUSPENDED' ? 'login ✓' : 'login suspended'}
                              </span>
                              <div className="ah-sub" style={{ marginTop: 4 }}>last login {rel(r.last_login_at ?? r.last_seen)}{r.must_change_password ? ' · first login pending' : ''}</div>
                            </div>
                          ) : (
                            <div><span className="ah-pill" style={{ color: '#94a3b8', background: 'rgba(148,163,184,.1)', borderColor: 'rgba(148,163,184,.3)' }}>no login</span><div className="ah-sub" style={{ marginTop: 4 }}>Activate creates it</div></div>
                          )}
                        </td>
                        {/* Sessions */}
                        <td>
                          {isMarket ? <span className="ah-sub">—</span> : (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span style={{ fontWeight: 800, color: r.live_sessions > 0 ? '#34d399' : '#475569' }}>{r.live_sessions ?? 0}</span>
                              {r.live_sessions > 0 && <button className="ah-btn ah-btn--ghost" style={{ minHeight: 28, fontSize: 11 }} disabled={busyRow} onClick={() => revoke(r)}>end all</button>}
                            </div>
                          )}
                        </td>
                        {/* Access */}
                        <td>
                          <Pill state={r.access} />
                          {r.last_action && (
                            <div className="ah-sub" style={{ marginTop: 4, maxWidth: 220 }}>
                              {r.last_action.toLowerCase()} by {r.last_actor ?? 'office'} · {rel(r.last_action_at)}
                              {r.last_reason ? <div style={{ color: '#fca5a5' }}>“{r.last_reason}”</div> : null}
                            </div>
                          )}
                          {isMarket && r.reject_reason && !r.last_reason && <div className="ah-sub" style={{ color: '#fca5a5' }}>“{r.reject_reason}”</div>}
                        </td>
                        {/* Decisions */}
                        <td>
                          {isEd ? (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button className="ah-btn ah-btn--ok" disabled={busyRow} onClick={() => saveEdit(r)}>{busyRow ? 'Saving…' : '💾 Save'}</button>
                              <button className="ah-btn ah-btn--ghost" onClick={() => setEditing(null)}>Cancel</button>
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {r.access !== 'ACTIVE' && <button className="ah-btn ah-btn--ok" disabled={busyRow} onClick={() => act(r, 'activate')}>{busyRow ? '…' : '✅ Activate'}</button>}
                              {r.access !== 'BLOCKED' && r.access !== 'ARCHIVED' && <button className="ah-btn ah-btn--warn" disabled={busyRow} onClick={() => setAsking({ id: r.id, action: 'block', reason: '' })}>⛔ Block</button>}
                              {r.access !== 'ARCHIVED' && <button className="ah-btn ah-btn--no" disabled={busyRow} onClick={() => setAsking({ id: r.id, action: 'archive', reason: '' })}>🗄 Archive</button>}
                              <button className="ah-btn" disabled={busyRow} onClick={() => setEditing({ id: r.id, draft: { name: r.name ?? '', mobile: r.mobile ?? '', ...(kind !== 'DRIVER' && kind !== 'MARKET_DRIVER' ? { email: r.email && !String(r.email).includes('@login.prasadtransport.com') ? r.email : '' } : {}), ...(isPartner ? { subscription_plan: r.subscription_plan ?? 'FREE', max_vehicle_limit: r.max_vehicle_limit ?? 0 } : {}) } })}>✎ Edit</button>
                              <button className="ah-btn ah-btn--ghost" onClick={() => openDetail(r)}>{expanded === r.id ? '▴ Less' : '▾ Details'}</button>
                            </div>
                          )}
                        </td>
                      </tr>

                      {/* Reason prompt for block / archive */}
                      {asking?.id === r.id && (
                        <tr className="ah-expand"><td colSpan={5} style={{ padding: '10px 14px' }}>
                          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: 12, borderRadius: 12, border: `1px dashed ${asking.action === 'archive' ? 'rgba(239,68,68,.5)' : 'rgba(245,158,11,.5)'}` }}>
                            <b style={{ color: asking.action === 'archive' ? '#fca5a5' : '#fcd34d', fontSize: 13 }}>
                              {asking.action === 'archive' ? '🗄 Archive' : '⛔ Block'} {r.name} — why?
                            </b>
                            <input className="ah-input" style={{ flex: 1, minWidth: 240 }} autoFocus value={asking.reason} onChange={(e) => setAsking({ ...asking, reason: e.target.value })}
                              placeholder={asking.action === 'archive' ? 'e.g. relationship ended — history stays, nothing is deleted' : 'e.g. unpaid dues / KYC mismatch — the party sees this'} />
                            <button className={`ah-btn ${asking.action === 'archive' ? 'ah-btn--no' : 'ah-btn--warn'}`} disabled={!asking.reason.trim() || busyRow}
                              onClick={() => act(r, asking.action, { reason: asking.reason.trim() })}>
                              Confirm {asking.action}
                            </button>
                            <button className="ah-btn ah-btn--ghost" onClick={() => setAsking(null)}>Cancel</button>
                            <div className="ah-sub" style={{ width: '100%' }}>
                              {asking.action === 'archive'
                                ? 'Gate closed, login suspended, sessions ended, master row marked ARCHIVED. Never a delete — a party with ledger history must stay referenceable. Activate reverses it.'
                                : 'Gate closed, login suspended, every live session ended on the next request. The business relationship goes on; only the portal shuts. Activate reverses it.'}
                            </div>
                          </div>
                        </td></tr>
                      )}

                      {/* Details: features + audit */}
                      {expanded === r.id && (
                        <tr className="ah-expand"><td colSpan={5} style={{ padding: '12px 16px 16px' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}>
                            <div>
                              <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: '#64748b', fontWeight: 800, marginBottom: 8 }}>What this party sees</div>
                              {kind === 'DRIVER' || kind === 'MARKET_DRIVER' ? (
                                <div className="ah-sub">{kind === 'DRIVER' ? 'Drivers have the gate only: duty screen, own uploads, own khata — no freight, no rates. Per-page toggles for drivers are a follow-up (the driver app does not read the matrix yet).' : 'A market driver has no app. Approval lets the partner name them on a truck.'}</div>
                              ) : !detail[r.id] ? <div className="ah-sub">Loading…</div> : (
                                <div style={{ display: 'grid', gap: 6 }}>
                                  {detail[r.id].modules.map((m) => {
                                    const partyOff = (r.features ?? {})[m.short] === false;
                                    const roleOff = !m.is_visible;
                                    const isField = !!m.parent_key;
                                    return (
                                      <div key={m.module_key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderRadius: 10, background: 'rgba(15,23,42,.6)', marginLeft: isField ? 18 : 0, opacity: roleOff ? 0.55 : 1 }}>
                                        <button className={`ah-switch ${!partyOff && !roleOff ? 'on' : ''}`} disabled={roleOff || busyRow} onClick={() => toggleFeature(r, m.short, partyOff)} title={roleOff ? 'hidden for every ' + tab.role.toLowerCase() + ' in the Role Matrix' : partyOff ? 'switch on for this party' : 'hide for this party'} />
                                        <div style={{ flex: 1 }}>
                                          <div style={{ fontSize: 12.5, color: '#e2e8f0', fontWeight: isField ? 500 : 700 }}>{String(m.label).trim()}{m.sensitive ? <span style={{ color: '#fbbf24', marginLeft: 6, fontSize: 10 }}>sensitive</span> : null}</div>
                                          {roleOff && <div className="ah-sub" style={{ fontSize: 10.5 }}>off for the whole role — open it in the Role Matrix first</div>}
                                        </div>
                                      </div>
                                    );
                                  })}
                                  {detail[r.id].modules.length === 0 && <div className="ah-sub">No modules seeded for this role.</div>}
                                </div>
                              )}
                            </div>
                            <div>
                              <div style={{ fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', color: '#64748b', fontWeight: 800, marginBottom: 8 }}>Audit trail</div>
                              {!detail[r.id] ? <div className="ah-sub">Loading…</div> : (
                                <div style={{ display: 'grid', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
                                  {[...(detail[r.id].audit.hub ?? []).map((a) => ({ t: a.created_at, who: a.actor_name, what: a.action, why: a.reason, extra: a.after?.note ?? (a.after?.changes ? Object.entries(a.after.changes).map(([k, v]) => `${k} → ${v ?? '—'}`).join(', ') : null) })),
                                    ...(detail[r.id].audit.gate ?? []).map((g) => ({ t: g.created_at, who: g.actor_name, what: g.now_visible ? 'GATE OPENED' : 'GATE CLOSED', why: null }))]
                                    .sort((a, b) => new Date(b.t) - new Date(a.t))
                                    .map((e, i) => (
                                      <div key={i} style={{ display: 'flex', gap: 10, fontSize: 12, padding: '6px 10px', borderRadius: 10, background: 'rgba(15,23,42,.6)' }}>
                                        <span style={{ color: '#64748b', whiteSpace: 'nowrap' }}>{fmtDt(e.t)}</span>
                                        <span style={{ fontWeight: 800, color: e.what.includes('BLOCK') || e.what.includes('ARCHIVE') || e.what.includes('CLOSED') ? '#f87171' : e.what.includes('ACTIVATE') || e.what.includes('OPENED') ? '#34d399' : '#cbd5e1' }}>{e.what}</span>
                                        <span style={{ color: '#94a3b8', flex: 1 }}>{e.who ?? 'office'}{e.why ? ` — “${e.why}”` : ''}{e.extra ? ` — ${e.extra}` : ''}</span>
                                      </div>
                                    ))}
                                  {(detail[r.id].audit.hub?.length ?? 0) + (detail[r.id].audit.gate?.length ?? 0) === 0 && <div className="ah-sub">No decisions recorded yet for this party.</div>}
                                </div>
                              )}
                            </div>
                          </div>
                        </td></tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {toast && <div className="ah-toast">{toast}</div>}
    </div>
  );
}
