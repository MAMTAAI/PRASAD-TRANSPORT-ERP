// @ts-nocheck
// Shared bits of the payroll screens (migration 174): API helper, palette,
// pills, the account picker and the pay-config form used by Driver Master's
// Configure modal and by the driver desk.
import React, { useEffect, useState } from 'react';
import { API_BASE } from '../lib/apiBase';

export const API = `${API_BASE}/api/v1/payroll`;
export const apiJson = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.detail || j.error || `HTTP ${res.status}`), { code: j.error });
  return j;
};
export const n2 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
export const inr = (v) => '₹' + n2(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
export const inr2 = (v) => '₹' + n2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const dmy = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const C = { ink: '#eef2fd', ink2: '#c4d1ea', mut: '#9aadd4', dim: '#5d7196', line: '#27395f', raised: '#18244a', panel: '#121c38', cyan: '#22d3ee', good: '#2fe39b', crit: '#ff6b81', warn: '#ffb224', ai: '#a78bfa', cust: '#f472b6', gold: '#fcd34d' };
export const btn = (kind, on = true) => ({ font: 'inherit', fontWeight: 700, fontSize: '12px', borderRadius: '8px', padding: '7px 13px', border: `1px solid ${C.line}`, background: 'transparent', color: C.mut, cursor: on ? 'pointer' : 'not-allowed', opacity: on ? 1 : 0.5, whiteSpace: 'nowrap',
  ...({ good: { background: 'rgba(47,227,155,.10)', borderColor: 'rgba(47,227,155,.55)', color: C.good }, solid: { background: C.good, borderColor: C.good, color: '#0a1024' }, cyan: { background: 'rgba(34,211,238,.12)', borderColor: 'rgba(34,211,238,.5)', color: C.cyan },
    warn: { background: 'rgba(255,178,36,.12)', borderColor: 'rgba(255,178,36,.5)', color: C.warn }, ai: { background: 'rgba(167,139,250,.14)', borderColor: 'rgba(167,139,250,.5)', color: '#c4b5fd' }, crit: { background: 'rgba(255,107,129,.12)', borderColor: 'rgba(255,107,129,.5)', color: C.crit }, gold: { background: 'rgba(252,211,77,.12)', borderColor: 'rgba(252,211,77,.55)', color: C.gold } }[kind] || {}) });
export const chip = (on) => ({ fontSize: '11px', fontWeight: 700, borderRadius: '999px', padding: '4px 10px', cursor: 'pointer', border: `1px solid ${on ? C.cyan : C.line}`, color: on ? C.cyan : C.mut, background: on ? 'rgba(34,211,238,.10)' : 'transparent', whiteSpace: 'nowrap' });
export const th = { padding: '9px 10px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.08em', color: C.dim, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap', background: 'rgba(10,16,36,.6)', position: 'sticky', top: 0 };
export const td = { padding: '8px 10px', borderBottom: '1px solid #1b2a4e', color: C.ink2, whiteSpace: 'nowrap', verticalAlign: 'top' };
export const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
export const inp = { background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '8px', color: C.ink, padding: '6px 10px', fontSize: '12px', font: 'inherit' };
export const sel = { ...inp, cursor: 'pointer' };
export const panel = { background: C.panel, border: `1px solid ${C.line}`, borderRadius: '12px', padding: '12px 14px', minWidth: 0 };
export const wrap = { overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '12px', background: 'rgba(10,16,36,.45)' };
export const Pill = ({ s, map }) => { const x = map[s] ?? [s, C.dim]; return <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '.05em', borderRadius: '999px', padding: '2px 9px', border: `1px solid ${x[1]}`, color: x[1], whiteSpace: 'nowrap' }}>{x[0]}</span>; };
export const SSTAT = { BLOCKED: ['BLOCKED', C.crit], DRAFT: ['READY TO POST', C.warn], POSTED: ['POSTED · PAY NOW', C.cyan], PAID: ['PAID', C.good], CANCELLED: ['CANCELLED', C.dim], SKIPPED: ['SKIPPED', C.dim] };
export const RSTAT = { DRAFT: ['DRAFT', C.warn], POSTED: ['POSTED', C.cyan], PAID: ['PAID', C.good], CANCELLED: ['CANCELLED', C.dim] };
export const MODEL = { TRIP: 'Trip Basis (Instant Settlement)', MONTHLY: 'Fixed Salary (Monthly)' };
export const BASIS = { ROUTE: 'Route bhatta (Route & RTKM master)', PER_TRIP: '₹ per trip', PCT_FREIGHT: '% of trip freight', PER_KM: '₹ per RTKM' };
export const fail = (e) => alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Admin only. ' : ''}${e.message}`);
export const ask = (m) => window.confirm(m);

/** Cash / bank ledger picker with balances. */
export function AccountPicker({ firm, value, onChange }) {
  const [rows, setRows] = useState([]);
  useEffect(() => { apiJson(`${API}/accounts${firm ? `?firm=${firm}` : ''}`).then((r) => setRows(r.rows ?? [])).catch(() => setRows([])); }, [firm]);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={sel}>
      <option value="">— pay from —</option>
      {rows.map((a) => <option key={a.ledger_name} value={a.ledger_name}>{a.ledger_name} · {inr(a.balance)}{a.company ? ` · ${a.company.trim()}` : ''}</option>)}
    </select>
  );
}

/** Ask for the paying account, then call onPay(account, paid_on). */
export function PayDialog({ firm, title, amount, onPay, onClose }) {
  const [account, setAccount] = useState(''); const [day, setDay] = useState(new Date().toISOString().slice(0, 10)); const [busy, setBusy] = useState(false);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(10,16,36,.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...panel, width: 'min(520px, 94vw)', borderColor: C.cyan }}>
        <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>Disbursal</div>
        <div style={{ fontSize: '16px', fontWeight: 800, color: C.ink, margin: '4px 0 10px' }}>{title}</div>
        <div style={{ fontSize: '26px', fontWeight: 900, color: C.good, marginBottom: '10px' }}>{inr2(amount)}</div>
        <div style={{ display: 'grid', gap: '8px' }}>
          <label style={{ fontSize: '11px', color: C.mut }}>From account<br /><AccountPicker firm={firm} value={account} onChange={setAccount} /></label>
          <label style={{ fontSize: '11px', color: C.mut }}>Paid on<br /><input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={inp} /></label>
        </div>
        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '12px' }}>
          <button onClick={onClose} style={btn()}>cancel</button>
          <button disabled={!account || busy} onClick={async () => { setBusy(true); try { await onPay(account, day); onClose(); } catch (e) { fail(e); } finally { setBusy(false); } }} style={btn('solid', !!account && !busy)}>💸 Pay &amp; post voucher</button>
        </div>
      </div>
    </div>
  );
}

/** The compensation model form. `driver` carries the current config; onSaved gets the API answer. */
export function PayConfigForm({ driver, firms, onSaved, compact = false }) {
  const [v, setV] = useState({ pay_model: driver?.pay_model ?? '', trip_rate_mode: driver?.trip_rate_mode ?? 'ROUTE', trip_rate: driver?.trip_rate ?? '', monthly_salary: driver?.monthly_salary ?? '', shortage_recovery_pct: driver?.shortage_recovery_pct ?? 100, pay_company_id: driver?.pay_company_id ?? '', pay_notes: driver?.pay_notes ?? '' });
  useEffect(() => { setV({ pay_model: driver?.pay_model ?? '', trip_rate_mode: driver?.trip_rate_mode ?? 'ROUTE', trip_rate: driver?.trip_rate ?? '', monthly_salary: driver?.monthly_salary ?? '', shortage_recovery_pct: driver?.shortage_recovery_pct ?? 100, pay_company_id: driver?.pay_company_id ?? '', pay_notes: driver?.pay_notes ?? '' }); }, [driver?.id, driver?.pay_configured_at]);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!v.pay_model) return alert('⚠️ Choose the compensation model — it is mandatory.');
    setBusy(true);
    try { const r = await apiJson(`${API}/drivers/${driver.id}/pay`, { method: 'PATCH', body: JSON.stringify(v) }); onSaved?.(r); alert(`✅ ${driver.name}: ${MODEL[v.pay_model]} saved.${r.resettled ? ` ${r.resettled} open trip settlement(s) recomputed.` : ''}`); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const L = ({ l, children, span }) => <label style={{ fontSize: '11px', color: C.mut, gridColumn: span ? '1 / -1' : undefined, display: 'grid', gap: '3px' }}>{l}{children}</label>;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: compact ? '1fr 1fr' : 'repeat(auto-fit, minmax(190px, 1fr))', gap: '8px' }}>
      <L l="Compensation model *" span><select value={v.pay_model} onChange={(e) => setV({ ...v, pay_model: e.target.value })} style={{ ...sel, width: '100%', borderColor: v.pay_model ? C.line : C.crit }}><option value="">— choose —</option><option value="TRIP">{MODEL.TRIP}</option><option value="MONTHLY">{MODEL.MONTHLY}</option></select></L>
      {v.pay_model === 'TRIP' && (<>
        <L l="Trip pay basis"><select value={v.trip_rate_mode} onChange={(e) => setV({ ...v, trip_rate_mode: e.target.value })} style={{ ...sel, width: '100%' }}>{Object.entries(BASIS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></L>
        {v.trip_rate_mode !== 'ROUTE' && <L l={v.trip_rate_mode === 'PCT_FREIGHT' ? 'Rate (% of freight)' : v.trip_rate_mode === 'PER_KM' ? 'Rate (₹ per RTKM)' : 'Rate (₹ per trip)'}><input type="number" value={v.trip_rate} onChange={(e) => setV({ ...v, trip_rate: e.target.value })} style={{ ...inp, width: '100%' }} /></L>}
      </>)}
      {v.pay_model === 'MONTHLY' && <L l="Monthly salary (₹)"><input type="number" value={v.monthly_salary} onChange={(e) => setV({ ...v, monthly_salary: e.target.value })} style={{ ...inp, width: '100%' }} /></L>}
      {v.pay_model && (<>
        <L l="Shortage recovered from driver (%)"><input type="number" min="0" max="100" value={v.shortage_recovery_pct} onChange={(e) => setV({ ...v, shortage_recovery_pct: e.target.value })} style={{ ...inp, width: '100%' }} /></L>
        <L l="Paying firm (books)"><select value={v.pay_company_id} onChange={(e) => setV({ ...v, pay_company_id: e.target.value })} style={{ ...sel, width: '100%' }}><option value="">— the trip's firm —</option>{(firms ?? []).map((f) => <option key={f.id ?? f.company_id} value={f.id ?? f.company_id}>{f.company_name}</option>)}</select></L>
        <L l="Notes" span><input value={v.pay_notes} onChange={(e) => setV({ ...v, pay_notes: e.target.value })} placeholder="e.g. ₹300/trip from Oct, agreed with owner" style={{ ...inp, width: '100%' }} /></L>
      </>)}
      <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '11px', color: C.dim }}>{v.pay_model === 'TRIP' ? 'Every completed trip settles at once: earning − korki (advances on the trip, shortage, challans) = net payable.' : v.pay_model === 'MONTHLY' ? 'Flat salary; advances, shortages and challans accumulate and come off at month end.' : 'Without a model no trip can be settled — the desk shows it as BLOCKED.'}</span>
        <button onClick={save} disabled={busy || !driver?.id} style={btn('solid', !busy && !!driver?.id)}>Save compensation</button>
      </div>
    </div>
  );
}
