// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// TDS MANAGEMENT v2 — both directions, per firm, per quarter, from documents.
//
// Owner, 5-Sep-2026 (mock approved): TDS Receivable (what IOCL / BPCL / HPCL
// withhold from our freight, provable against Form 26AS and Form 16A), TDS
// Payable (what we withhold when we pay attached owners and fleet partners,
// deposited by the 7th, filed in Form 26Q), and the Govt. Submission pack
// the CA files. Nothing on this screen is typed for an existing trip: the
// liabilities come from the approved 15-day bills, the credits from the
// advices, AC5 bills and bank credits. A person types only PAN, TAN, the
// 194C(6) declaration, the challan and the return's token.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';
import GlobalPagination, { usePagination } from './components/GlobalPagination';
import { API_BASE } from './lib/apiBase';
import { useIsMobile } from './hooks/useIsMobile';

const API = `${API_BASE}/api/v1/tds`;
const apiJson = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.detail || j.error || `HTTP ${res.status}`), { code: j.error });
  return j;
};
const n2 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const inr = (v) => '₹' + n2(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inr2 = (v) => '₹' + n2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => (d ? String(d).slice(0, 10) : '');
const dmy = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const mon = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : '—');
const C = { ink: '#eef2fd', ink2: '#c4d1ea', mut: '#9aadd4', dim: '#5d7196', line: '#27395f', raised: '#18244a', panel: '#121c38', cyan: '#22d3ee', good: '#2fe39b', crit: '#ff6b81', warn: '#ffb224', ai: '#a78bfa', cust: '#38bdf8' };
const btn = (kind, on = true) => ({ font: 'inherit', fontWeight: 700, fontSize: '12px', borderRadius: '8px', padding: '7px 13px', border: `1px solid ${C.line}`, background: 'transparent', color: C.mut, cursor: on ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap', opacity: on ? 1 : 0.5,
  ...({ good: { background: 'rgba(47,227,155,.10)', borderColor: 'rgba(47,227,155,.55)', color: C.good }, solid: { background: C.good, borderColor: C.good, color: '#0a1024' }, cyan: { background: 'rgba(34,211,238,.12)', borderColor: 'rgba(34,211,238,.5)', color: C.cyan },
        warn: { background: 'rgba(255,178,36,.12)', borderColor: 'rgba(255,178,36,.5)', color: C.warn }, ai: { background: 'rgba(167,139,250,.14)', borderColor: 'rgba(167,139,250,.5)', color: '#c4b5fd' }, crit: { background: 'rgba(255,107,129,.12)', borderColor: 'rgba(255,107,129,.5)', color: C.crit } }[kind] ?? {}) });
const chip = (on) => ({ fontSize: '11px', fontWeight: 700, borderRadius: '999px', padding: '3px 9px', cursor: 'pointer', border: `1px solid ${on ? C.cyan : C.line}`, color: on ? C.cyan : C.mut, background: on ? 'rgba(34,211,238,.12)' : 'transparent', whiteSpace: 'nowrap' });
const th = { padding: '9px 10px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.08em', color: C.dim, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap', background: 'rgba(10,16,36,.5)' };
const td = { padding: '8px 10px', borderBottom: '1px solid #1b2a4e', color: C.ink2, whiteSpace: 'nowrap', verticalAlign: 'top' };
const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const inp = { background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '8px', color: C.ink, padding: '6px 10px', fontSize: '12px' };
const Pill = ({ s, map }) => { const x = map[s] ?? [s, C.dim]; return <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '.05em', borderRadius: '999px', padding: '2px 9px', border: `1px solid ${x[1]}`, color: x[1], whiteSpace: 'nowrap' }}>{x[0]}</span>; };
const LIAB = { DUE: ['DUE', C.warn], PROJECTED: ['PROJECTED', C.ai], BLOCKED: ['BLOCKED', C.crit], EXEMPT: ['NIL (194C(6))', C.good], DEPOSITED: ['DEPOSITED', C.cyan], RETURNED: ['IN RETURN', C.good] };
const CRED = { AWAITING_26AS: ['AWAITING 26AS', C.warn], MATCHED: ['MATCHED', C.good], SHORT_CREDITED: ['SHORT IN 26AS', C.crit], EXCESS_CREDITED: ['EXCESS IN 26AS', C.cust], NOT_IN_26AS: ['NOT IN 26AS', C.crit], ESTIMATE: ['ESTIMATE', C.dim] };
const SRC = { ADVICE: 'Payment advice', AC5_BILL: 'AC5 bill (2%)', BANK_ESTIMATE: 'Bank credit ÷ 0.98', MANUAL: 'Manual' };
const MONTH = { OVERDUE: ['OVERDUE', C.crit], DUE: ['DUE', C.warn], BLOCKED: ['BLOCKED', C.crit], DEPOSITED: ['DEPOSITED', C.good], NOTHING: ['—', C.dim] };
const RET = { DRAFT: ['DRAFT', C.dim], PACK_READY: ['PACK READY', C.cyan], FILED: ['FILED', C.good], CORRECTION: ['CORRECTION', C.warn] };
const dl = (url) => { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); };

export default function TdsMgmt() {
  const { isPhone } = useIsMobile();
  const [ov, setOv] = useState(null);
  const [tab, setTab] = useState('RECEIVABLE');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(async () => { try { setOv(await apiJson(`${API}/overview`)); } catch (e) { setErr(e.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const rebuild = async () => { setBusy(true); try { const r = await apiJson(`${API}/rebuild`, { method: 'POST', body: JSON.stringify({}) }); alert(`🤖 Rebuilt from documents — ${r.liabilities} liability lines, ${r.credits} credit rows (FY ${r.fy}).`); await load(); } catch (e) { alert(`❌ ${e.message}`); } setBusy(false); };
  const firms = ov?.firms ?? [];
  const fy = ov?.fy ?? '';
  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", padding: isPhone ? '12px' : '20px 24px 50px', background: 'radial-gradient(circle at top right, #121c38, #0a1024)', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '10.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: C.dim }}>Accounts &amp; Admin · Section 194C · FY {fy}</div>
          <h2 style={{ margin: 0, fontSize: isPhone ? '22px' : '28px', color: '#fff' }}>✂️ TDS Management</h2>
          {!isPhone && <div style={{ color: C.mut, fontSize: '12.5px', marginTop: '4px', maxWidth: '96ch' }}>Receivable: what IOCL, BPCL and HPCL withhold from our freight, from their payment advices and bills, proved against Form 26AS. Payable: what we withhold when we pay attached owners and fleet partners, from the approved 15-day bills, deposited by the 7th and filed in Form 26Q. Nothing is typed for an existing trip.</div>}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button onClick={rebuild} disabled={busy} style={btn('ai', !busy)}>🤖 Rebuild from documents</button>
          <button onClick={() => dl(`${API}/export/credit-claim?fy=${fy}`)} style={btn('cyan')}>⬇ TDS credit claim (CSV)</button>
        </div>
      </div>
      {err && <p style={{ color: C.crit, fontSize: '12.5px' }}>{err}</p>}

      {/* per firm */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isPhone ? '240px' : '300px'}, 1fr))`, gap: '10px', marginBottom: '14px' }}>
        {firms.map((f) => (<FirmCard key={f.company_id} f={f} onChanged={load} />))}
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {[['RECEIVABLE', '📥 TDS Receivable (26AS)'], ['PAYABLE', '📤 TDS Payable'], ['DEDUCTEES', '👤 Deductees'], ['CHALLANS', '🏦 Challans'], ['GOVT', '🏛 Govt. Submission']].map((t) => (
          <span key={t[0]} onClick={() => setTab(t[0])} style={chip(tab === t[0])}>{t[1]}</span>))}
      </div>
      {tab === 'RECEIVABLE' && <Receivable fy={fy} firms={firms} onChanged={load} />}
      {tab === 'PAYABLE' && <Payable fy={fy} firms={firms} />}
      {tab === 'DEDUCTEES' && <Deductees onChanged={load} />}
      {tab === 'CHALLANS' && <Challans fy={fy} firms={firms} onChanged={load} />}
      {tab === 'GOVT' && <Govt fy={fy} firms={firms} onChanged={load} />}
    </div>
  );
}

function FirmCard({ f, onChanged }) {
  const [tan, setTan] = useState(f.tan ?? ''); const [edit, setEdit] = useState(false);
  const save = async () => { try { await apiJson(`${API}/firms/${f.company_id}`, { method: 'PATCH', body: JSON.stringify({ tan }) }); setEdit(false); onChanged?.(); } catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Admin only' : e.message}`); } };
  return (
    <div style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: '12px', padding: '12px 14px', minWidth: 0 }}>
      <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>PAN {f.pan_no ?? '—'} · TAN {f.tan ? <span style={{ color: C.good }}>{f.tan}</span> : <span style={{ color: C.crit }}>not on file</span>} {!edit && <span onClick={() => setEdit(true)} style={{ cursor: 'pointer', color: C.cust }}>✏️</span>}</div>
      {edit && <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}><input value={tan} onChange={(e) => setTan(e.target.value.toUpperCase())} placeholder="ABCD12345E" style={{ ...inp, width: '120px' }} /><button onClick={save} style={{ ...btn('solid'), padding: '4px 9px' }}>Save</button><button onClick={() => setEdit(false)} style={{ ...btn('plain'), padding: '4px 9px' }}>✕</button></div>}
      <div style={{ fontSize: '16px', fontWeight: 800, color: C.ink, margin: '2px 0 8px' }}>{f.company_name}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 10px', fontSize: '12px' }}>
        <span style={{ color: C.mut }}>TDS on us · per documents</span><b style={{ color: C.good }}>{inr(f.tds_on_us_documented)}</b>
        <span style={{ color: C.mut }}>TDS on us · estimated (bank credits)</span><b style={{ color: C.warn }}>{inr(f.tds_on_us_estimated)}</b>
        <span style={{ color: C.mut }}>Per Form 26AS</span><b>{n2(f.tds_on_us_26as) ? inr(f.tds_on_us_26as) : <span style={{ color: C.dim }}>upload 26AS</span>}</b>
        <span style={{ color: C.mut }}>In the ledger (TDS Receivable 194C)</span><b>{inr(f.receivable_ledger)}</b>
        <span style={{ color: C.mut, borderTop: '1px solid #1b2a4e', paddingTop: '4px' }}>TDS by us · due</span><b style={{ color: n2(f.tds_by_us_due) ? C.warn : C.ink, borderTop: '1px solid #1b2a4e', paddingTop: '4px' }}>{inr(f.tds_by_us_due)}{n2(f.overdue) ? <span style={{ color: C.crit }}> · {f.overdue} overdue</span> : null}</b>
        <span style={{ color: C.mut }}>TDS by us · deposited</span><b>{inr(f.tds_by_us_deposited)}</b>
        <span style={{ color: C.mut }}>Projected (drafts) · blocked</span><b>{inr(f.tds_by_us_projected)} · <span style={{ color: n2(f.blocked) ? C.crit : C.dim }}>{f.blocked} blocked</span></b>
        <span style={{ color: C.mut }}>Deductees without PAN</span><b style={{ color: n2(f.deductees_without_pan) ? C.crit : C.good }}>{f.deductees_without_pan}</b>
      </div>
    </div>
  );
}

// ══ RECEIVABLE ══════════════════════════════════════════════════════════════
function Receivable({ fy, firms, onChanged }) {
  const [d, setD] = useState(null); const [firm, setFirm] = useState(''); const [file, setFile] = useState(null); const [busy, setBusy] = useState(false); const [res, setRes] = useState(null);
  const load = useCallback(async () => { if (!fy) return; try { setD(await apiJson(`${API}/receivable?fy=${fy}`)); } catch (e) { setD({ error: e.message }); } }, [fy]);
  useEffect(() => { load(); }, [load]);
  const rows = (d?.rows ?? []).filter((r) => !firm || r.company_id === firm);
  const pg = usePagination(rows, { defaultSize: 20 });
  const upload = async () => {
    if (!firm) return alert('Choose the firm this Form 26AS belongs to.'); if (!file) return alert('Choose the 26AS / AIS export (CSV or text).');
    setBusy(true); setRes(null);
    try { const fd = new FormData(); fd.append('file', file); fd.append('company_id', firm); const j = await apiJson(`${API}/receivable/26as-upload`, { method: 'POST', body: fd }); setRes(j.summary); await load(); onChanged?.(); } catch (e) { setRes(`❌ ${e.message}`); }
    setBusy(false);
  };
  const cert = async (r) => { const no = window.prompt(`Form 16A certificate number for ${r.customer_name} · ${r.quarter} ${r.fy}:`, r.form16a_no ?? ''); if (no === null) return; const on = window.prompt('Received on (YYYY-MM-DD):', day(r.form16a_received_at) || new Date().toISOString().slice(0, 10)); try { await apiJson(`${API}/receivable/${r.id}`, { method: 'PATCH', body: JSON.stringify({ form16a_no: no, form16a_received_at: on }) }); await load(); onChanged?.(); } catch (e) { alert(`❌ ${e.message}`); } };
  if (!d) return <p style={{ color: C.mut }}>Loading…</p>;
  const T = rows.reduce((t, r) => ({ base: t.base + n2(r.freight_base), tds: t.tds + (r.source === 'BANK_ESTIMATE' ? 0 : n2(r.tds_amount)), est: t.est + (r.source === 'BANK_ESTIMATE' ? n2(r.tds_amount) : 0), as26: t.as26 + n2(r.amount_26as) }), { base: 0, tds: 0, est: 0, as26: 0 });
  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
        <select value={firm} onChange={(e) => setFirm(e.target.value)} style={inp}><option value="">All firms</option>{firms.map((f) => <option key={f.company_id} value={f.company_id}>{f.company_name}</option>)}</select>
        <input type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ color: C.ink2, fontSize: '12px' }} />
        <button onClick={upload} disabled={busy || !file || !firm} style={btn('cyan', !busy && !!file && !!firm)}>{busy ? '⏳ Matching…' : '📎 Upload Form 26AS / AIS'}</button>
        <span style={{ color: C.dim, fontSize: '11px' }}>TRACES → View Form 26AS → export as text/CSV. One file per firm.</span>
      </div>
      {res && <div style={{ fontSize: '12.5px', color: C.ink2, background: 'rgba(10,16,36,.55)', borderRadius: '8px', padding: '8px 12px', marginBottom: '10px' }}>{res}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '1px', background: C.line, border: `1px solid ${C.line}`, borderRadius: '10px', overflow: 'hidden', marginBottom: '10px' }}>
        {[['Freight base (documents)', inr(T.base), C.ink], ['TDS per documents', inr(T.tds), C.good], ['TDS estimated (bank)', inr(T.est), C.warn], ['TDS per 26AS', T.as26 ? inr(T.as26) : '—', C.cust], ['Form 16A received', `${rows.filter((r) => r.form16a_no).length} / ${rows.filter((r) => r.source !== 'BANK_ESTIMATE').length}`, C.ink]].map((k) => (
          <div key={k[0]} style={{ background: C.panel, padding: '10px 14px' }}><div style={{ fontSize: '10px', letterSpacing: '.1em', textTransform: 'uppercase', color: C.dim }}>{k[0]}</div><div style={{ fontSize: '17px', fontWeight: 700, color: k[2], fontVariantNumeric: 'tabular-nums' }}>{k[1]}</div></div>))}
      </div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
        <table style={{ width: '100%', minWidth: '1100px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
          <thead><tr><th style={th}>Firm</th><th style={th}>Customer (deductor)</th><th style={th}>Quarter</th><th style={{ ...th, textAlign: 'right' }}>Freight paid</th><th style={{ ...th, textAlign: 'right' }}>TDS per documents</th><th style={th}>Source</th><th style={{ ...th, textAlign: 'right' }}>26AS</th><th style={{ ...th, textAlign: 'right' }}>Difference</th><th style={th}>Form 16A</th><th style={th}>State</th></tr></thead>
          <tbody>{pg.slice.length === 0 && <tr><td colSpan={10} style={{ ...td, color: C.dim, textAlign: 'center' }}>Nothing yet — press "Rebuild from documents".</td></tr>}
            {pg.slice.map((r) => (<tr key={r.id}>
              <td style={td}>{(r.company_name ?? '').replace(/^M\/S\s+/i, '')}</td><td style={{ ...td, color: C.ink }}>{r.customer_name}{r.deductor_tan ? <div style={{ fontSize: '10.5px', color: C.dim }}>TAN {r.deductor_tan}</div> : null}</td><td style={td}>{r.quarter} {r.fy}</td>
              <td style={tdR}>{inr2(r.freight_base)}</td><td style={{ ...tdR, color: r.source === 'BANK_ESTIMATE' ? C.warn : C.good, fontWeight: 700 }}>{inr2(r.tds_amount)}</td>
              <td style={td}>{SRC[r.source] ?? r.source}<div style={{ fontSize: '10.5px', color: C.dim }}>{r.documents} document{r.documents === 1 ? '' : 's'}</div></td>
              <td style={tdR}>{r.amount_26as === null ? <span style={{ color: C.dim }}>—</span> : inr2(r.amount_26as)}</td>
              <td style={{ ...tdR, color: r.amount_26as === null ? C.dim : Math.abs(n2(r.amount_26as) - n2(r.tds_amount)) <= 2 ? C.good : C.crit }}>{r.amount_26as === null ? '—' : inr2(n2(r.amount_26as) - n2(r.tds_amount))}</td>
              <td style={td}>{r.form16a_no ? <span style={{ color: C.good }}>{r.form16a_no}<div style={{ fontSize: '10.5px', color: C.dim }}>{dmy(r.form16a_received_at)}</div></span> : <button onClick={() => cert(r)} style={{ ...btn('plain'), padding: '3px 8px', fontSize: '11px' }}>Record 16A</button>}<div style={{ fontSize: '10.5px', color: C.dim }}>due {dmy(r.form16a_due)}</div></td>
              <td style={td}><Pill s={r.matched_state} map={CRED} /></td>
            </tr>))}</tbody>
        </table>
      </div>
      {rows.length > 0 && <GlobalPagination {...pg} label="rows" />}
      <div style={{ color: C.dim, fontSize: '11px', marginTop: '10px', lineHeight: 1.6 }}>Order of truth: the customer's payment advice (its TDS line) → the AC5 bill (2% on the bill) → a bank credit net of 2% (estimate, until the customer's statement or Form 16A arrives). Upload Form 26AS per firm and each row becomes MATCHED, SHORT IN 26AS or NOT IN 26AS; the CA claims the matched amount in the ITR from the "TDS credit claim" export.</div>
    </div>
  );
}

// ══ PAYABLE ═════════════════════════════════════════════════════════════════
function Payable({ fy, firms }) {
  const [d, setD] = useState(null); const [firm, setFirm] = useState(''); const [st, setSt] = useState('');
  useEffect(() => { if (!fy) return; apiJson(`${API}/payable?fy=${fy}${firm ? `&firm=${firm}` : ''}`).then(setD).catch((e) => setD({ error: e.message })); }, [fy, firm]);
  const rows = (d?.rows ?? []).filter((r) => !st || r.status === st);
  const pg = usePagination(rows, { defaultSize: 20 });
  if (!d) return <p style={{ color: C.mut }}>Loading…</p>;
  return (
    <div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
        <select value={firm} onChange={(e) => setFirm(e.target.value)} style={inp}><option value="">All firms</option>{firms.map((f) => <option key={f.company_id} value={f.company_id}>{f.company_name}</option>)}</select>
        {[['', 'All'], ['DUE', 'Due'], ['DEPOSITED', 'Deposited'], ['PROJECTED', 'Projected (drafts)'], ['BLOCKED', 'Blocked'], ['EXEMPT', 'Nil 194C(6)']].map((s) => <span key={s[0]} onClick={() => setSt(s[0])} style={chip(st === s[0])}>{s[1]}</span>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px,1fr))', gap: '8px', marginBottom: '12px' }}>
        {(d.months ?? []).map((m) => (<div key={m.company_id + m.period_month} style={{ background: C.panel, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '10px 12px', fontSize: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}><b style={{ color: C.ink }}>{mon(m.period_month)} · {(m.company_name ?? '').replace(/^M\/S\s+/i, '')}</b><Pill s={m.state} map={MONTH} /></div>
          <div style={{ color: C.mut, marginTop: '4px' }}>due {inr(m.tds_due)} · deposited {inr(m.tds_deposited)} · projected {inr(m.tds_projected)}{n2(m.blocked) ? <span style={{ color: C.crit }}> · {m.blocked} blocked</span> : null}</div>
          <div style={{ color: C.dim, fontSize: '10.5px' }}>deposit by {dmy(m.deposit_due)} · {m.quarter} return by {dmy(m.deposit_due) && ''}{m.quarter}</div>
        </div>))}
        {(d.months ?? []).length === 0 && <div style={{ color: C.dim, fontSize: '12.5px' }}>No liabilities in FY {fy} — nothing approved yet, or press "Rebuild from documents".</div>}
      </div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
        <table style={{ width: '100%', minWidth: '1100px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
          <thead><tr><th style={th}>Month · firm</th><th style={th}>Deductee</th><th style={th}>PAN · type</th><th style={th}>Source</th><th style={{ ...th, textAlign: 'right' }}>Base (commission / freight)</th><th style={{ ...th, textAlign: 'right' }}>Rate</th><th style={{ ...th, textAlign: 'right' }}>TDS</th><th style={th}>Deposit due</th><th style={th}>Challan</th><th style={th}>State</th></tr></thead>
          <tbody>{pg.slice.length === 0 && <tr><td colSpan={10} style={{ ...td, color: C.dim, textAlign: 'center' }}>Nothing here.</td></tr>}
            {pg.slice.map((r) => (<tr key={r.id}>
              <td style={td}>{mon(r.period_month)}<div style={{ fontSize: '10.5px', color: C.dim }}>{(r.company_name ?? '').replace(/^M\/S\s+/i, '')}</div></td>
              <td style={{ ...td, color: C.ink }}>{r.deductee_name}</td>
              <td style={td}>{r.pan ? <span>{r.pan}</span> : <span style={{ color: C.crit }}>PAN missing</span>}<div style={{ fontSize: '10.5px', color: C.dim }}>{r.entity_type ?? 'type?'}{r.declaration_194c6 ? ' · 194C(6)' : ''}</div></td>
              <td style={td}>{r.bill_no ?? r.source_kind}<div style={{ fontSize: '10.5px', color: C.dim }}>{r.source_kind === 'OWNER_BILL' ? 'attached owner 15-day bill' : r.source_kind === 'MARKET_BILL' ? 'fleet partner bill' : r.source_kind}</div></td>
              <td style={tdR}>{inr2(r.base_amount)}</td><td style={tdR}>{r.rate_pct === null ? '—' : `${n2(r.rate_pct)}%`}</td><td style={{ ...tdR, fontWeight: 700, color: C.ink }}>{inr2(r.tds_amount)}</td>
              <td style={{ ...td, color: r.status === 'DUE' && day(r.deposit_due) < new Date().toISOString().slice(0, 10) ? C.crit : C.ink2 }}>{dmy(r.deposit_due)}</td>
              <td style={td}>{r.challan_serial ? <span>{r.challan_serial}<div style={{ fontSize: '10.5px', color: C.dim }}>{dmy(r.challan_paid_on)}</div></span> : <span style={{ color: C.dim }}>—</span>}</td>
              <td style={td}><Pill s={r.status} map={LIAB} />{r.block_reason && <div style={{ fontSize: '10.5px', color: C.crit, whiteSpace: 'normal', maxWidth: '220px' }}>{r.block_reason}</div>}</td>
            </tr>))}</tbody>
        </table>
      </div>
      {rows.length > 0 && <GlobalPagination {...pg} label="lines" />}
      <div style={{ color: C.dim, fontSize: '11px', marginTop: '10px', lineHeight: 1.6 }}>The base is the 15-day bill's commission (our charge to the attached owner) or the fleet partner's freight. Rate: 1% individual / 2% firm / 20% without PAN / nil with a 194C(6) declaration. A liability appears when the bill is approved (Dr Vehicle Owner / Cr TDS Payable (194C)); PROJECTED rows are drafts; BLOCKED rows need a commission rate or a deductee record. Deposit by the 7th of the next month.</div>
    </div>
  );
}

// ══ DEDUCTEES ═══════════════════════════════════════════════════════════════
function Deductees({ onChanged }) {
  const [d, setD] = useState(null); const [edit, setEdit] = useState(null); const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => apiJson(`${API}/deductees${showAll ? '?all=1' : ''}`).then(setD).catch((e) => setD({ error: e.message })), [showAll]);
  useEffect(() => { load(); }, [load]);
  const save = async () => { try { await apiJson(`${API}/deductees/${edit.id}`, { method: 'PATCH', body: JSON.stringify(edit) }); setEdit(null); await load(); onChanged?.(); } catch (e) { alert(`❌ ${e.message}`); } };
  const toggle = async (r) => { const on = !r.is_tds_applicable; if (!window.confirm(on ? `Mark ${r.name} as a TDS deductee (Section 194C applies to what we pay them)?` : `Mark ${r.name} as NOT a deductee (we buy goods from them — fuel, spares — so 194C does not apply)?`)) return; try { await apiJson(`${API}/deductees/${r.id}`, { method: 'PATCH', body: JSON.stringify({ pan: r.pan ?? '', entity_type: r.entity_type, declaration_194c6: r.declaration_194c6, carriages: r.carriages, is_tds_applicable: on, exemption_reason: on ? null : 'Marked not applicable on the desk (goods supplier)' }) }); await load(); onChanged?.(); } catch (e) { alert(`❌ ${e.message}`); } };
  if (!d) return <p style={{ color: C.mut }}>Loading…</p>;
  const rows = d.rows ?? [];
  return (
    <div>
      <div style={{ color: C.mut, fontSize: '12.5px', marginBottom: '8px' }}>Everyone we pay under a contract: attached owners (from the vehicle master), fleet partners and service contractors. PAN and entity type decide the rate; a 194C(6) declaration (transporter with 10 or fewer goods carriages, PAN furnished) makes it nil. <b style={{ color: C.ink2 }}>Fuel pumps, tyre and spares suppliers are goods — Section 194C does not apply and they are kept off this desk</b> ({d.exempt ?? 0} exempt). <span onClick={() => setShowAll((v) => !v)} style={{ ...chip(showAll), marginLeft: '6px' }}>{showAll ? 'Hide exempt' : 'Show exempt'}</span></div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
        <table style={{ width: '100%', minWidth: '1000px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
          <thead><tr><th style={th}>Deductee</th><th style={th}>Kind</th><th style={th}>PAN</th><th style={th}>Entity</th><th style={th}>194C(6)</th><th style={th}>Carriages</th><th style={{ ...th, textAlign: 'right' }}>Rate</th><th style={{ ...th, textAlign: 'right' }}>Base this FY</th><th style={{ ...th, textAlign: 'right' }}>Lines</th><th style={th}></th></tr></thead>
          <tbody>{rows.map((r) => edit?.id === r.id ? (
            <tr key={r.id} style={{ background: 'rgba(56,189,248,.06)' }}>
              <td style={{ ...td, color: C.ink }}>{r.name}</td><td style={td}>{r.deductee_kind}</td>
              <td style={td}><input value={edit.pan ?? ''} onChange={(e) => setEdit({ ...edit, pan: e.target.value.toUpperCase() })} placeholder="ABCDE1234F" style={{ ...inp, width: '120px' }} /></td>
              <td style={td}><select value={edit.entity_type ?? ''} onChange={(e) => setEdit({ ...edit, entity_type: e.target.value || null })} style={inp}><option value="">—</option>{['INDIVIDUAL', 'HUF', 'FIRM', 'COMPANY', 'AOP', 'OTHER'].map((x) => <option key={x} value={x}>{x}</option>)}</select></td>
              <td style={td}><label style={{ fontSize: '12px' }}><input type="checkbox" checked={!!edit.declaration_194c6} onChange={(e) => setEdit({ ...edit, declaration_194c6: e.target.checked })} /> on file</label></td>
              <td style={td}><input value={edit.carriages ?? ''} onChange={(e) => setEdit({ ...edit, carriages: e.target.value === '' ? null : Number(e.target.value) })} style={{ ...inp, width: '60px' }} /></td>
              <td style={tdR}>—</td><td style={tdR}>{inr(r.paid_fy)}</td><td style={tdR}>{r.liabilities}</td>
              <td style={td}><button onClick={save} style={{ ...btn('solid'), padding: '3px 9px' }}>Save</button> <button onClick={() => setEdit(null)} style={{ ...btn('plain'), padding: '3px 9px' }}>✕</button></td>
            </tr>) : (
            <tr key={r.id} style={{ opacity: r.is_tds_applicable ? 1 : 0.6 }}>
              <td style={{ ...td, color: C.ink }}>{r.name}{!r.is_tds_applicable && <div style={{ fontSize: '10.5px', color: C.dim, whiteSpace: 'normal', maxWidth: '260px' }}>Not a deductee — {r.exemption_reason}</div>}</td><td style={td}>{r.deductee_kind}</td>
              <td style={td}>{!r.is_tds_applicable ? <span style={{ color: C.dim }}>n/a</span> : r.pan ? r.pan : <span style={{ color: C.crit }}>missing</span>}</td><td style={td}>{r.entity_type ?? <span style={{ color: C.dim }}>—</span>}</td>
              <td style={td}>{r.declaration_194c6 ? <span style={{ color: C.good }}>✓ nil</span> : <span style={{ color: C.dim }}>no</span>}</td><td style={td}>{r.carriages ?? '—'}</td>
              <td style={{ ...tdR, color: !r.is_tds_applicable ? C.dim : n2(r.rate_pct) === 20 ? C.crit : n2(r.rate_pct) === 0 ? C.good : C.ink }}>{!r.is_tds_applicable ? 'exempt' : `${n2(r.rate_pct)}%`}</td><td style={tdR}>{inr(r.paid_fy)}</td><td style={tdR}>{r.liabilities}</td>
              <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.is_tds_applicable && <button onClick={() => setEdit({ id: r.id, pan: r.pan ?? '', entity_type: r.entity_type, declaration_194c6: r.declaration_194c6, carriages: r.carriages })} style={{ ...btn('cyan'), padding: '3px 9px' }}>✏️ Edit</button>} <button onClick={() => toggle(r)} style={{ ...btn('plain'), padding: '3px 9px' }}>{r.is_tds_applicable ? 'Not a deductee' : 'Make deductee'}</button></td>
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ══ CHALLANS ════════════════════════════════════════════════════════════════
function Challans({ fy, firms, onChanged }) {
  const [d, setD] = useState(null); const [f, setF] = useState({ company_id: '', period_month: '', paid_on: new Date().toISOString().slice(0, 10), amount: '', interest: '', fee: '', bsr_code: '', challan_serial: '', bank_ledger: '' }); const [busy, setBusy] = useState(false);
  const load = useCallback(() => { if (!fy) return; apiJson(`${API}/challans?fy=${fy}`).then(setD).catch((e) => setD({ error: e.message })); }, [fy]);
  useEffect(() => { load(); }, [load]);
  const save = async () => {
    if (!f.company_id || !f.period_month || !f.amount) return alert('Firm, month and amount are required.');
    setBusy(true);
    try { const r = await apiJson(`${API}/challans`, { method: 'POST', body: JSON.stringify({ ...f, period_month: `${f.period_month}-01` }) }); alert(`✅ Challan recorded — ${r.covered} liability line(s) marked deposited${n2(r.uncovered_amount) ? `; ${inr2(r.uncovered_amount)} not matched to a line` : ''}${r.voucher_id ? ' · posted to the ledger' : ''}.`); setF({ ...f, amount: '', bsr_code: '', challan_serial: '' }); load(); onChanged?.(); }
    catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Admin only' : e.message}`); }
    setBusy(false);
  };
  if (!d) return <p style={{ color: C.mut }}>Loading…</p>;
  return (
    <div>
      <div style={{ border: '1px solid rgba(34,211,238,.4)', background: 'rgba(34,211,238,.05)', borderRadius: '12px', padding: '12px 16px', marginBottom: '12px' }}>
        <b style={{ color: C.cyan, fontSize: '13px' }}>🏦 Record an ITNS 281 deposit</b>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '8px' }}>
          <select value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })} style={inp}><option value="">Firm</option>{firms.map((x) => <option key={x.company_id} value={x.company_id}>{x.company_name}{x.tan ? ` · ${x.tan}` : ' · no TAN'}</option>)}</select>
          <input type="month" value={f.period_month} onChange={(e) => setF({ ...f, period_month: e.target.value })} style={inp} title="Month the TDS belongs to" />
          <input value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="TDS ₹" style={{ ...inp, width: '110px', textAlign: 'right' }} />
          <input value={f.interest} onChange={(e) => setF({ ...f, interest: e.target.value })} placeholder="Interest ₹" style={{ ...inp, width: '100px', textAlign: 'right' }} />
          <input value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} placeholder="Fee ₹" style={{ ...inp, width: '90px', textAlign: 'right' }} />
          <input value={f.bsr_code} onChange={(e) => setF({ ...f, bsr_code: e.target.value })} placeholder="BSR code" style={{ ...inp, width: '110px' }} />
          <input value={f.challan_serial} onChange={(e) => setF({ ...f, challan_serial: e.target.value })} placeholder="Challan serial" style={{ ...inp, width: '120px' }} />
          <input type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} style={inp} />
          <input value={f.bank_ledger} onChange={(e) => setF({ ...f, bank_ledger: e.target.value })} placeholder="Bank ledger, e.g. SBI (8490)" style={{ ...inp, width: '170px' }} />
          <button onClick={save} disabled={busy} style={btn('solid', !busy)}>💾 Save &amp; post</button>
        </div>
        <div style={{ color: C.dim, fontSize: '11px', marginTop: '6px' }}>Posts Dr TDS Payable (194C) / Cr bank in the firm's books and marks that month's due lines deposited, oldest first. The bank statement line then links to it on the reconciliation desk.</div>
      </div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
        <table style={{ width: '100%', minWidth: '900px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
          <thead><tr><th style={th}>Paid on</th><th style={th}>Firm · TAN</th><th style={th}>Month</th><th style={{ ...th, textAlign: 'right' }}>TDS</th><th style={{ ...th, textAlign: 'right' }}>Interest · fee</th><th style={th}>BSR · serial</th><th style={th}>Bank</th><th style={{ ...th, textAlign: 'right' }}>Lines covered</th><th style={th}>Ledger</th></tr></thead>
          <tbody>{(d.rows ?? []).length === 0 && <tr><td colSpan={9} style={{ ...td, color: C.dim, textAlign: 'center' }}>No challans recorded in FY {fy}.</td></tr>}
            {(d.rows ?? []).map((r) => (<tr key={r.id}><td style={td}>{dmy(r.paid_on)}</td><td style={td}>{r.company_name}<div style={{ fontSize: '10.5px', color: C.dim }}>{r.tan ?? 'no TAN'}</div></td><td style={td}>{mon(r.period_month)}</td><td style={{ ...tdR, fontWeight: 700 }}>{inr2(r.amount)}</td><td style={tdR}>{inr2(n2(r.interest) + n2(r.fee))}</td><td style={td}>{r.bsr_code ?? '—'} · {r.challan_serial ?? '—'}</td><td style={td}>{r.bank_ledger ?? '—'}</td><td style={tdR}>{r.lines} · {inr(r.covered)}</td><td style={td}>{r.voucher_id ? <span style={{ color: C.good }}>posted</span> : <span style={{ color: C.dim }}>not posted</span>}</td></tr>))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ══ GOVT. SUBMISSION ════════════════════════════════════════════════════════
function Govt({ fy, firms, onChanged }) {
  const [d, setD] = useState(null); const [busy, setBusy] = useState(false);
  const load = useCallback(() => { if (!fy) return; apiJson(`${API}/returns?fy=${fy}`).then(setD).catch((e) => setD({ error: e.message })); }, [fy]);
  useEffect(() => { load(); }, [load]);
  const pack = async (q) => { setBusy(true); try { const r = await apiJson(`${API}/returns/${q.company_id}/${q.fy}/${q.quarter}/pack`, { method: 'POST' }); alert(`📦 Pack ready — ${r.lines} deductee line(s), ${r.undeposited} undeposited.${r.warnings.length ? '\n⚠️ ' + r.warnings.join('\n⚠️ ') : ''}`); load(); onChanged?.(); } catch (e) { alert(`❌ ${e.message}`); } setBusy(false); };
  const filed = async (r) => { const token = window.prompt(`Token / acknowledgement number for ${r.company_name} ${r.quarter} ${r.fy}:`, r.token_no ?? ''); if (token === null) return; const on = window.prompt('Filed on (YYYY-MM-DD):', day(r.filed_on) || new Date().toISOString().slice(0, 10)); try { await apiJson(`${API}/returns/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'FILED', token_no: token, filed_on: on }) }); load(); onChanged?.(); } catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Admin only' : e.message}`); } };
  if (!d) return <p style={{ color: C.mut }}>Loading…</p>;
  const ret = (cid, q) => (d.returns ?? []).find((r) => r.company_id === cid && r.quarter === q);
  return (
    <div>
      <div style={{ color: C.mut, fontSize: '12.5px', marginBottom: '10px', maxWidth: '100ch' }}>One pack per firm per quarter: the Form 26Q deductee annexure (RPU column order), the Form 27A cover figures with the challans, and the Form 16A issue list. The CA validates and files on TRACES / NSDL with the firm's TAN login; record the token here when done. Quarters: Q1 by 31 Jul · Q2 by 31 Oct · Q3 by 31 Jan · Q4 by 31 May.</div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
        <table style={{ width: '100%', minWidth: '1100px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
          <thead><tr><th style={th}>Firm · TAN</th><th style={th}>Quarter</th><th style={th}>Due</th><th style={{ ...th, textAlign: 'right' }}>Deductees</th><th style={{ ...th, textAlign: 'right' }}>Amount paid</th><th style={{ ...th, textAlign: 'right' }}>TDS deducted</th><th style={{ ...th, textAlign: 'right' }}>Deposited</th><th style={{ ...th, textAlign: 'right' }}>Undeposited</th><th style={th}>Return</th><th style={th}>Download</th></tr></thead>
          <tbody>{(d.quarters ?? []).length === 0 && <tr><td colSpan={10} style={{ ...td, color: C.dim, textAlign: 'center' }}>No TDS by us in FY {fy} yet — nothing to file. (Attached-owner bills need a commission rate and approval first.)</td></tr>}
            {(d.quarters ?? []).map((q) => { const r = ret(q.company_id, q.quarter); const overdue = day(q.due) < new Date().toISOString().slice(0, 10) && r?.status !== 'FILED';
              return (<tr key={q.company_id + q.quarter}>
                <td style={td}>{q.company_name}<div style={{ fontSize: '10.5px', color: q.tan ? C.dim : C.crit }}>{q.tan ?? 'TAN missing — cannot file'}</div></td><td style={td}>{q.quarter} {q.fy}</td>
                <td style={{ ...td, color: overdue ? C.crit : C.ink2 }}>{dmy(q.due)}{overdue ? ' · overdue' : ''}</td>
                <td style={tdR}>{q.deductees}</td><td style={tdR}>{inr2(q.amount_paid)}</td><td style={{ ...tdR, fontWeight: 700 }}>{inr2(q.tds_deducted)}</td><td style={tdR}>{inr2(q.tds_deposited)}</td><td style={{ ...tdR, color: n2(q.undeposited) ? C.crit : C.good }}>{q.undeposited}</td>
                <td style={td}>{r ? <span><Pill s={r.status} map={RET} />{r.token_no && <div style={{ fontSize: '10.5px', color: C.dim }}>token {r.token_no} · {dmy(r.filed_on)}</div>}</span> : <span style={{ color: C.dim }}>not started</span>}
                  <div style={{ marginTop: '4px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}><button onClick={() => pack(q)} disabled={busy} style={{ ...btn('cyan'), padding: '3px 8px', fontSize: '11px' }}>📦 Build pack</button>{r && r.status !== 'FILED' && <button onClick={() => filed(r)} style={{ ...btn('good'), padding: '3px 8px', fontSize: '11px' }}>✅ Mark filed</button>}</div></td>
                <td style={td}><div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                  <button onClick={() => dl(`${API}/export/26q?firm=${q.company_id}&fy=${q.fy}&q=${q.quarter}`)} style={{ ...btn('solid'), padding: '3px 8px', fontSize: '11px' }}>⬇ 26Q for CA (CSV)</button>
                  <button onClick={() => dl(`${API}/export/27a?firm=${q.company_id}&fy=${q.fy}&q=${q.quarter}`)} style={{ ...btn('plain'), padding: '3px 8px', fontSize: '11px' }}>27A</button>
                  <button onClick={() => dl(`${API}/export/16a?firm=${q.company_id}&fy=${q.fy}&q=${q.quarter}`)} style={{ ...btn('plain'), padding: '3px 8px', fontSize: '11px' }}>16A list</button></div></td>
              </tr>); })}</tbody>
        </table>
      </div>
      <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <b style={{ color: C.ink2, fontSize: '12.5px' }}>TDS on us, for the ITR:</b>
        {firms.map((f) => <button key={f.company_id} onClick={() => dl(`${API}/export/credit-claim?firm=${f.company_id}&fy=${fy}`)} style={{ ...btn('cyan'), padding: '4px 10px' }}>⬇ Credit claim · {(f.company_name ?? '').replace(/^M\/S\s+/i, '')}</button>)}
      </div>
    </div>
  );
}
