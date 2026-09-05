// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// GST MANAGEMENT (GTA) 360° — output under reverse / forward charge, input
// tax credit, net payable, GSTR-1 / GSTR-3B packs. Migration 171.
//
// Owner, 5-Sep-2026: classify every customer bill RCM or forward charge; an
// RCM invoice shows the GST but never adds it to our receivable; capture
// GST on spares, insurance, tolls and vehicle purchases as ITC; one dashboard
// showing output (FCM) − ITC = net payable; one click for the government
// files; a deep audit that applies RCM wherever the customer is a registered
// corporate. Nothing on this screen is typed for an existing invoice — the
// documents come from the IOCL AC5 bills and the 15-day customer bills; a
// person supplies GSTINs, the scheme, a purchase invoice and the filing ARN.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { API_BASE } from './lib/apiBase';
import { useIsMobile } from './hooks/useIsMobile';

const API = `${API_BASE}/api/v1/gst`;
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
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const plabel = (p) => (p && p.length === 6 ? `${MON[Number(p.slice(0, 2)) - 1]} ${p.slice(2)}` : p ?? '');
const C = { ink: '#eef2fd', ink2: '#c4d1ea', mut: '#9aadd4', dim: '#5d7196', line: '#27395f', raised: '#18244a', panel: '#121c38', cyan: '#22d3ee', good: '#2fe39b', crit: '#ff6b81', warn: '#ffb224', ai: '#a78bfa', cust: '#f472b6', gold: '#fcd34d' };
const btn = (kind, on = true) => ({ font: 'inherit', fontWeight: 700, fontSize: '12px', borderRadius: '8px', padding: '7px 13px', border: `1px solid ${C.line}`, background: 'transparent', color: C.mut, cursor: on ? 'pointer' : 'not-allowed', opacity: on ? 1 : 0.5, whiteSpace: 'nowrap',
  ...({ good: { background: 'rgba(47,227,155,.10)', borderColor: 'rgba(47,227,155,.55)', color: C.good }, solid: { background: C.good, borderColor: C.good, color: '#0a1024' }, cyan: { background: 'rgba(34,211,238,.12)', borderColor: 'rgba(34,211,238,.5)', color: C.cyan },
    warn: { background: 'rgba(255,178,36,.12)', borderColor: 'rgba(255,178,36,.5)', color: C.warn }, ai: { background: 'rgba(167,139,250,.14)', borderColor: 'rgba(167,139,250,.5)', color: '#c4b5fd' }, crit: { background: 'rgba(255,107,129,.12)', borderColor: 'rgba(255,107,129,.5)', color: C.crit }, gold: { background: 'rgba(252,211,77,.12)', borderColor: 'rgba(252,211,77,.55)', color: C.gold } }[kind] || {}) });
const chip = (on) => ({ fontSize: '11px', fontWeight: 700, borderRadius: '999px', padding: '4px 10px', cursor: 'pointer', border: `1px solid ${on ? C.cyan : C.line}`, color: on ? C.cyan : C.mut, background: on ? 'rgba(34,211,238,.10)' : 'transparent', whiteSpace: 'nowrap' });
const th = { padding: '9px 10px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.08em', color: C.dim, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap', background: 'rgba(10,16,36,.6)', position: 'sticky', top: 0 };
const td = { padding: '8px 10px', borderBottom: '1px solid #1b2a4e', color: C.ink2, whiteSpace: 'nowrap', verticalAlign: 'top' };
const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const inp = { background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '8px', color: C.ink, padding: '6px 10px', fontSize: '12px', font: 'inherit' };
const sel = { ...inp, cursor: 'pointer' };
const panel = { background: C.panel, border: `1px solid ${C.line}`, borderRadius: '12px', padding: '12px 14px', minWidth: 0 };
const wrap = { overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '12px', background: 'rgba(10,16,36,.45)' };
const Pill = ({ s, map }) => { const x = map[s] ?? [s, C.dim]; return <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '.05em', borderRadius: '999px', padding: '2px 9px', border: `1px solid ${x[1]}`, color: x[1], whiteSpace: 'nowrap' }}>{x[0]}</span>; };
const TREAT = { RCM: ['RCM · recipient pays', C.ai], FORWARD: ['FORWARD · we charge', C.warn], EXEMPT: ['EXEMPT', C.dim] };
const SCHEME = { RCM: 'Reverse charge (recipient pays 5%, no ITC)', FCM_5: 'Forward charge 5% (no ITC)', FCM_12: 'Forward charge 12% (with ITC)', UNREGISTERED: 'Not registered' };
const ELIG = { ELIGIBLE: ['ELIGIBLE', C.good], BLOCKED_SCHEME: ['BLOCKED · scheme', C.warn], EXEMPT_SUPPLY: ['EXEMPT SUPPLY', C.dim], NON_GST: ['NON-GST', C.dim], NOT_GST_ITEM: ['NO GST', C.dim], NO_GSTIN: ['NO GSTIN', C.crit], NEEDS_INVOICE: ['NEEDS INVOICE', C.crit] };
const ISTAT = { CAPTURED: ['CAPTURED', C.dim], MATCHED_2B: ['IN 2B', C.good], NOT_IN_2B: ['NOT IN 2B', C.crit], CLAIMED: ['CLAIMED', C.cyan], REVERSED: ['REVERSED', C.warn], EXCLUDED: ['EXCLUDED', C.dim] };
const FSTAT = { DRAFT: ['DRAFT', C.dim], EXPORTED: ['PACK EXPORTED', C.cyan], FILED: ['FILED', C.good], NIL: ['NIL RETURN', C.good] };
const URG = { OVERDUE: ['OVERDUE', C.crit], DUE_SOON: ['DUE SOON', C.warn], OPEN: ['OPEN', C.dim], DONE: ['DONE', C.good] };
const DSTAT = { ISSUED: ['ISSUED', C.good], DRAFT: ['DRAFT', C.dim] };
const CATS = ['SPARES', 'TYRES', 'BATTERY', 'INSURANCE', 'REPAIRS', 'VEHICLE_PURCHASE', 'TOLL', 'FUEL', 'COMPLIANCE', 'OTHER'];
const dl = (url) => { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); };
const ask = (msg) => window.confirm(msg);
const fail = (e) => alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Admin only. ' : ''}${e.message}`);

export default function GstMgmt() {
  const { isPhone } = useIsMobile();
  const [ov, setOv] = useState(null);
  const [tab, setTab] = useState('OVERVIEW');
  const [firm, setFirm] = useState('');
  const [period, setPeriod] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(async () => { try { const o = await apiJson(`${API}/overview`); setOv(o); setFirm((f) => f || o.firms?.[0]?.company_id || ''); setPeriod((p) => p || o.previous_period || o.current_period); } catch (e) { setErr(e.message); } }, []);
  useEffect(() => { load(); }, [load]);
  const audit = async () => {
    if (!ask('Run the deep audit? It classifies every customer the statutory way (a person’s choice is kept), rebuilds the GST lines of every bill, captures purchase entries into the ITC register and refreshes the filing calendar. Nothing is posted to the ledger.')) return;
    setBusy(true); try { const r = await apiJson(`${API}/audit`, { method: 'POST', body: JSON.stringify({}) }); const s = r.summary; alert(`🔎 Deep audit done — ${s.documents?.issued ?? 0} documents issued (${s.documents?.needing_attention ?? 0} need attention), ${s.bills_backfilled} bills carry their GST lines, ${s.itc_rows} purchase entries in the ITC register, ${s.customers?.length ?? 0} customers classified.`); await load(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const firms = ov?.firms ?? [];
  const F = firms.find((f) => f.company_id === firm);
  const periods = useMemo(() => { const set = new Set((ov?.months ?? []).filter((m) => !firm || m.company_id === firm).map((m) => m.period)); if (ov?.current_period) set.add(ov.current_period); if (ov?.previous_period) set.add(ov.previous_period); return [...set].sort((a, b) => (a.slice(2) + a.slice(0, 2) < b.slice(2) + b.slice(0, 2) ? 1 : -1)); }, [ov, firm]);
  const exp = (kind, fmt) => firm && period && dl(`${API}/export/${kind}?firm=${firm}&period=${period}${fmt ? `&format=${fmt}` : ''}`);

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", padding: isPhone ? '12px' : '20px 24px 50px', background: 'radial-gradient(circle at top right, #121c38, #0a1024)', minHeight: '100vh' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: '14px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '10.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: C.dim }}>Accounts &amp; Admin · Goods Transport Agency · SAC {F?.gst_sac ?? '996791'}</div>
          <h2 style={{ margin: 0, fontSize: isPhone ? '22px' : '28px', color: '#fff' }}>🏛️ GST Management</h2>
          {!isPhone && <div style={{ color: C.mut, fontSize: '12.5px', marginTop: '4px', maxWidth: '100ch' }}>Output: every invoice the recipients hold — IOCL’s AC5 bills and our own 15-day bills — as reverse charge (shown, paid by them) or forward charge (charged by us). Input: GST paid on spares, tyres, insurance and vehicles, with what the law lets this firm claim. Net = forward-charge output − eligible credit, set off in the statutory order. The government files come out in the offline tool’s own format.</div>}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button onClick={audit} disabled={busy} style={btn('ai', !busy)}>🔎 Deep audit</button>
          <button onClick={() => exp('ca-pack')} disabled={!firm || !period} style={btn('gold', !!(firm && period))}>⬇ Download for Govt Portal / CA (Excel)</button>
        </div>
      </div>
      {err && <p style={{ color: C.crit, fontSize: '12.5px' }}>{err}</p>}

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
        <select value={firm} onChange={(e) => setFirm(e.target.value)} style={sel}>{firms.map((f) => <option key={f.company_id} value={f.company_id}>{f.company_name}</option>)}</select>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={sel}>{periods.map((p) => <option key={p} value={p}>{plabel(p)}</option>)}</select>
        {F && <span style={{ fontSize: '11.5px', color: C.mut }}>GSTIN <b style={{ color: F.gstin_valid ? C.good : C.crit }}>{F.gstin ?? 'NOT ON FILE'}</b> · {SCHEME[F.gst_scheme]} · {F.gst_filing === 'QRMP' ? 'quarterly (QRMP)' : 'monthly'}</span>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isPhone ? '240px' : '300px'}, 1fr))`, gap: '10px', marginBottom: '14px' }}>
        {firms.map((f) => <FirmCard key={f.company_id} f={f} active={f.company_id === firm} onPick={() => setFirm(f.company_id)} onChanged={load} />)}
      </div>

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        {[['OVERVIEW', '📊 Net GST by month'], ['OUTPUT', '📤 Output · RCM / FCM'], ['ITC', '📥 Input tax credit'], ['RECON', '🔁 GSTR-2B reconciliation'], ['GOVT', '🏛 Govt. submission']].map((t) => (
          <span key={t[0]} onClick={() => setTab(t[0])} style={chip(tab === t[0])}>{t[1]}</span>))}
      </div>
      {tab === 'OVERVIEW' && <Overview ov={ov} firm={firm} F={F} isPhone={isPhone} onPeriod={(p) => { setPeriod(p); setTab('GOVT'); }} />}
      {tab === 'OUTPUT' && <Output ov={ov} firm={firm} period={period} isPhone={isPhone} onChanged={load} />}
      {tab === 'ITC' && <Itc ov={ov} firm={firm} period={period} isPhone={isPhone} onChanged={load} />}
      {tab === 'RECON' && <Recon firm={firm} period={period} isPhone={isPhone} onChanged={load} />}
      {tab === 'GOVT' && <Govt ov={ov} firm={firm} period={period} F={F} exp={exp} isPhone={isPhone} onChanged={load} />}
    </div>
  );
}

function FirmCard({ f, active, onPick, onChanged }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState({ gstin: f.gstin ?? '', gst_scheme: f.gst_scheme, gst_filing: f.gst_filing, gst_state_code: f.gst_state_code ?? '18', gst_sac: f.gst_sac ?? '996791', gst_invoice_prefix: f.gst_invoice_prefix ?? '' });
  useEffect(() => setV({ gstin: f.gstin ?? '', gst_scheme: f.gst_scheme, gst_filing: f.gst_filing, gst_state_code: f.gst_state_code ?? '18', gst_sac: f.gst_sac ?? '996791', gst_invoice_prefix: f.gst_invoice_prefix ?? '' }), [f]);
  const save = async () => { try { await apiJson(`${API}/firms/${f.company_id}`, { method: 'PATCH', body: JSON.stringify(v) }); setEdit(false); onChanged?.(); } catch (e) { fail(e); } };
  const gap = [!f.gstin && 'no GSTIN', f.customers_without_gstin > 0 && `${f.customers_without_gstin} customer${f.customers_without_gstin === 1 ? '' : 's'} without GSTIN`, f.docs_needing_attention > 0 && `${f.docs_needing_attention} document${f.docs_needing_attention === 1 ? '' : 's'} need attention`, f.itc_needing_invoice > 0 && `${f.itc_needing_invoice} purchase${f.itc_needing_invoice === 1 ? '' : 's'} await an invoice`, f.filings_overdue > 0 && `${f.filings_overdue} filing${f.filings_overdue === 1 ? '' : 's'} overdue`].filter(Boolean);
  return (
    <div onClick={onPick} style={{ ...panel, cursor: 'pointer', borderColor: active ? C.cyan : C.line, boxShadow: active ? '0 0 0 1px rgba(34,211,238,.35)' : 'none' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>PAN {f.pan_no ?? '—'} · {f.state_name ?? 'state?'}</div>
          <div style={{ fontSize: '16px', fontWeight: 800, color: C.ink, margin: '2px 0 2px' }}>{f.company_name}</div>
          <div style={{ fontSize: '12px', fontFamily: 'monospace', color: f.gstin_valid ? C.good : C.crit }}>{f.gstin ?? 'GSTIN not on file'}{f.gstin_source ? <span style={{ color: C.dim, fontFamily: 'inherit' }}> · {f.gstin_source}</span> : null}</div>
        </div>
        <button onClick={(e) => { e.stopPropagation(); setEdit((x) => !x); }} style={btn('cyan')}>{edit ? 'close' : '✎ profile'}</button>
      </div>
      {edit && (
        <div onClick={(e) => e.stopPropagation()} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginTop: '8px' }}>
          <label style={{ gridColumn: '1 / -1', fontSize: '11px', color: C.mut }}>GSTIN<input value={v.gstin} onChange={(e) => setV({ ...v, gstin: e.target.value.toUpperCase() })} placeholder="18AAKFP2339R2ZG" style={{ ...inp, width: '100%', fontFamily: 'monospace' }} /></label>
          <label style={{ gridColumn: '1 / -1', fontSize: '11px', color: C.mut }}>Scheme<select value={v.gst_scheme} onChange={(e) => setV({ ...v, gst_scheme: e.target.value })} style={{ ...sel, width: '100%' }}>{Object.entries(SCHEME).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label style={{ fontSize: '11px', color: C.mut }}>Filing<select value={v.gst_filing} onChange={(e) => setV({ ...v, gst_filing: e.target.value })} style={{ ...sel, width: '100%' }}><option value="MONTHLY">Monthly</option><option value="QRMP">Quarterly (QRMP)</option></select></label>
          <label style={{ fontSize: '11px', color: C.mut }}>State code<input value={v.gst_state_code} onChange={(e) => setV({ ...v, gst_state_code: e.target.value })} style={{ ...inp, width: '100%' }} /></label>
          <label style={{ fontSize: '11px', color: C.mut }}>SAC<input value={v.gst_sac} onChange={(e) => setV({ ...v, gst_sac: e.target.value })} style={{ ...inp, width: '100%' }} /></label>
          <label style={{ fontSize: '11px', color: C.mut }}>Invoice prefix<input value={v.gst_invoice_prefix} onChange={(e) => setV({ ...v, gst_invoice_prefix: e.target.value.toUpperCase() })} placeholder="PT" style={{ ...inp, width: '100%' }} /></label>
          <div style={{ gridColumn: '1 / -1', display: 'flex', gap: '6px', justifyContent: 'flex-end' }}><button onClick={save} style={btn('solid')}>Save</button></div>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 10px', fontSize: '12px', marginTop: '8px' }}>
        <span style={{ color: C.mut }}>RCM supplies this FY · GST shown, paid by recipients</span><b style={{ color: C.ai }}>{inr(f.fy_rcm_taxable)} · {inr(f.fy_rcm_tax)}</b>
        <span style={{ color: C.mut }}>Forward-charge output tax</span><b style={{ color: n2(f.fy_output_tax) ? C.warn : C.ink }}>{inr(f.fy_output_tax)}</b>
        <span style={{ color: C.mut }}>ITC eligible · on record but blocked</span><b>{inr(f.fy_itc_eligible)} · <span style={{ color: C.dim }}>{inr(f.fy_itc_blocked)}</span></b>
        <span style={{ color: C.mut, borderTop: '1px solid #1b2a4e', paddingTop: '4px' }}>Net GST payable (FY)</span><b style={{ color: n2(f.fy_net_payable) ? C.crit : C.good, borderTop: '1px solid #1b2a4e', paddingTop: '4px', fontSize: '14px' }}>{inr(f.fy_net_payable)}</b>
        <span style={{ color: C.mut }}>Documents · filed returns</span><b>{f.fy_docs} · {f.filings_filed}</b>
      </div>
      {gap.length > 0 && <div style={{ marginTop: '8px', fontSize: '11.5px', color: C.crit }}>⚠ {gap.join(' · ')}</div>}
    </div>
  );
}

// ══ OVERVIEW ════════════════════════════════════════════════════════════════
function Overview({ ov, firm, F, isPhone, onPeriod }) {
  const rows = (ov?.months ?? []).filter((m) => m.company_id === firm);
  const last = ov?.last_audit;
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
        <thead><tr><th style={th}>Month</th><th style={{ ...th, textAlign: 'right' }}>Docs</th><th style={{ ...th, textAlign: 'right' }}>RCM taxable</th><th style={{ ...th, textAlign: 'right' }}>GST paid by recipients</th><th style={{ ...th, textAlign: 'right' }}>FCM taxable</th><th style={{ ...th, textAlign: 'right' }}>Output tax</th><th style={{ ...th, textAlign: 'right' }}>ITC eligible</th><th style={{ ...th, textAlign: 'right' }}>ITC blocked</th><th style={{ ...th, textAlign: 'right' }}>Net payable</th><th style={th}>Attention</th></tr></thead>
        <tbody>{rows.length === 0 && <tr><td style={td} colSpan={10}>Nothing for this firm yet — run the deep audit.</td></tr>}
          {rows.map((m) => (<tr key={m.period} onClick={() => onPeriod(m.period)} style={{ cursor: 'pointer' }}>
            <td style={{ ...td, color: C.ink, fontWeight: 700 }}>{plabel(m.period)}</td><td style={tdR}>{m.docs}{m.draft_docs ? <span style={{ color: C.dim }}> +{m.draft_docs} draft</span> : null}</td>
            <td style={tdR}>{inr(m.rcm_taxable)}</td><td style={{ ...tdR, color: C.ai }}>{inr(m.rcm_tax)}</td><td style={tdR}>{inr(m.fcm_taxable)}</td><td style={{ ...tdR, color: n2(m.output_tax) ? C.warn : C.ink2 }}>{inr(m.output_tax)}</td>
            <td style={{ ...tdR, color: C.good }}>{inr(m.itc_eligible)}</td><td style={{ ...tdR, color: C.dim }}>{inr(m.itc_blocked)}</td><td style={{ ...tdR, color: n2(m.net_payable) ? C.crit : C.good, fontWeight: 800 }}>{inr2(m.net_payable)}</td>
            <td style={td}>{m.docs_needing_attention ? <span style={{ color: C.crit }}>{m.docs_needing_attention} docs</span> : null}{m.needs_invoice + m.no_gstin ? <span style={{ color: C.warn }}> {m.needs_invoice + m.no_gstin} purchases</span> : null}</td>
          </tr>))}</tbody></table></div>
      <div style={{ display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1fr 1fr', gap: '12px' }}>
        <div style={panel}>
          <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>How the number is built</div>
          <div style={{ fontSize: '12.5px', color: C.ink2, marginTop: '6px', lineHeight: 1.55 }}>
            <b style={{ color: C.ai }}>Reverse charge</b> — IOCL, BPCL, HPCL, Aadhar Green and every other registered or corporate customer: the invoice shows 5% GST, the recipient pays it to the government, it never enters our receivable (Notification 13/2017).<br />
            <b style={{ color: C.warn }}>Forward charge</b> — customers a person switched to FORWARD: we add 5% (no credit) or 12% (with credit) to the invoice and the receivable.<br />
            <b style={{ color: C.good }}>Input credit</b> — GST on spares, tyres, batteries, insurance, repairs and goods carriages. Claimable only under the 12% option; under reverse charge it stays on record as blocked (Sec 17(3)). Toll is exempt, diesel is outside GST — both go to GSTR-3B table 5.<br />
            <b style={{ color: C.crit }}>Net payable</b> = output tax − eligible credit, set off IGST → CGST → SGST (Rule 88A).
          </div>
        </div>
        <div style={panel}>
          <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>Last deep audit</div>
          {!last && <div style={{ fontSize: '12.5px', color: C.mut, marginTop: '6px' }}>Not run yet.</div>}
          {last && (<div style={{ fontSize: '12.5px', color: C.ink2, marginTop: '6px', lineHeight: 1.55 }}>
            {dmy(last.ran_at)} by {last.ran_by} · {last.summary?.documents?.issued ?? 0} documents issued, {last.summary?.documents?.needing_attention ?? 0} need attention · {last.summary?.bills_backfilled} bills carry GST lines · {last.summary?.itc_rows} purchase entries<br />
            {(last.summary?.gstin_vs_books ?? []).map((x, i) => <div key={i} style={{ color: C.warn }}>⚠ {x.docs} IOCL documents ({inr(x.taxable)}) carry <b>{x.gstin_firm}</b>’s GSTIN but their freight sits in <b>{x.books_firm}</b>’s books — GST follows the GSTIN on the document.</div>)}
            {(last.summary?.invalid_vendor_gstins ?? []).map((x, i) => <div key={i} style={{ color: C.crit }}>✖ Vendor master: {x.vendor} has an invalid GSTIN {x.gstin}</div>)}
            {(last.summary?.firms ?? []).filter((x) => !x.gstin).map((x, i) => <div key={i} style={{ color: C.crit }}>✖ {x.firm}: no GSTIN on file — enter it on the firm card</div>)}
          </div>)}
        </div>
      </div>
    </div>
  );
}

// ══ OUTPUT ══════════════════════════════════════════════════════════════════
function Output({ ov, firm, period, isPhone, onChanged }) {
  const [d, setD] = useState(null); const [cust, setCust] = useState(''); const [allP, setAllP] = useState(false); const [showCust, setShowCust] = useState(false);
  const load = useCallback(async () => { if (!firm) return; try { setD(await apiJson(`${API}/output?firm=${firm}${allP ? '' : `&period=${period}`}${cust ? `&customer=${cust}` : ''}`)); } catch (e) { setD({ error: e.message }); } }, [firm, period, cust, allP]);
  useEffect(() => { load(); }, [load]);
  const T = d?.totals ?? {};
  const customers = ov?.customers ?? [];
  const setDoc = async (r) => {
    const g = window.prompt(`Recipient GSTIN for ${r.doc_no} (${r.customer_name}):`, r.recipient_gstin ?? ''); if (g === null) return;
    const p = window.prompt('Place of supply (state code, e.g. 18 Assam, 14 Manipur):', r.place_of_supply ?? (g ? g.slice(0, 2) : '')); if (p === null) return;
    try { await apiJson(`${API}/docs/${r.doc_kind}/${encodeURIComponent(r.doc_no)}`, { method: 'PUT', body: JSON.stringify({ recipient_gstin: g, place_of_supply: p }) }); await load(); onChanged?.(); } catch (e) { fail(e); }
  };
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={cust} onChange={(e) => setCust(e.target.value)} style={sel}><option value="">All customers</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}</select>
        <span onClick={() => setAllP((x) => !x)} style={chip(allP)}>{allP ? 'whole FY' : plabel(period)}</span>
        <span onClick={() => setShowCust((x) => !x)} style={chip(showCust)}>👤 customer treatment</span>
        <span style={{ fontSize: '11.5px', color: C.mut }}>{T.issued ?? 0} issued · {T.drafts ?? 0} drafts · RCM {inr(T.rcm_taxable)} (GST {inr(T.rcm_tax)} by recipients) · FCM {inr(T.fcm_taxable)} (output {inr(T.fcm_tax)}) · exempt {inr(T.exempt_taxable)}{T.attention ? <b style={{ color: C.crit }}> · {T.attention} need attention</b> : null}</span>
      </div>
      {showCust && <Customers customers={customers} onChanged={async () => { await onChanged?.(); load(); }} isPhone={isPhone} />}
      <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
        <thead><tr><th style={th}>Document</th><th style={th}>Date</th><th style={th}>Customer · GSTIN</th><th style={th}>Treatment</th><th style={th}>Supply · POS</th><th style={{ ...th, textAlign: 'right' }}>Taxable</th><th style={{ ...th, textAlign: 'right' }}>CGST</th><th style={{ ...th, textAlign: 'right' }}>SGST</th><th style={{ ...th, textAlign: 'right' }}>IGST</th><th style={{ ...th, textAlign: 'right' }}>Invoice value</th><th style={th}>Status</th><th style={th}>Needs</th></tr></thead>
        <tbody>{d?.error && <tr><td style={td} colSpan={12}>{d.error}</td></tr>}
          {(d?.rows ?? []).map((r) => (<tr key={r.doc_kind + r.doc_no}>
            <td style={{ ...td, fontFamily: 'monospace', color: C.ink }}>{r.doc_no}<div style={{ fontSize: '10px', color: C.dim, fontFamily: 'inherit' }}>{r.doc_kind === 'AC5' ? `IOCL AC5 bill · ${r.lines} lines` : `our tax invoice · ${r.lines} trips`}</div></td>
            <td style={td}>{dmy(r.doc_date)}</td>
            <td style={td}>{r.customer_name}<div style={{ fontSize: '10px', fontFamily: 'monospace', color: r.recipient_gstin ? C.mut : C.crit }}>{r.recipient_gstin ?? 'no GSTIN'}</div></td>
            <td style={td}><Pill s={r.treatment} map={TREAT} /></td>
            <td style={td}>{r.supply_type} · {r.place_of_supply ?? '?'}</td>
            <td style={tdR}>{inr2(r.taxable)}</td><td style={tdR}>{inr2(r.cgst)}</td><td style={tdR}>{inr2(r.sgst)}</td><td style={tdR}>{inr2(r.igst)}</td>
            <td style={{ ...tdR, color: C.ink, fontWeight: 700 }}>{inr2(r.invoice_value)}<div style={{ fontSize: '10px', color: C.dim, fontWeight: 400 }}>{r.payable_by === 'RECIPIENT' ? `+ ${inr2(r.gst_amount)} GST paid by recipient` : r.payable_by === 'SUPPLIER' ? 'GST included' : 'exempt'}</div></td>
            <td style={td}><Pill s={r.doc_status} map={DSTAT} /></td>
            <td style={{ ...td, whiteSpace: 'normal', minWidth: '160px' }}>{r.needs ? <span style={{ color: C.crit }}>{r.needs} <button onClick={() => setDoc(r)} style={btn('cyan')}>fix</button></span> : <span style={{ color: C.good }}>✓</span>}</td>
          </tr>))}</tbody></table></div>
    </div>
  );
}

function Customers({ customers, onChanged, isPhone }) {
  const save = async (c, patch) => { try { await apiJson(`${API}/customers/${c.id}`, { method: 'PATCH', body: JSON.stringify(patch) }); onChanged?.(); } catch (e) { fail(e); } };
  return (
    <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
      <thead><tr><th style={th}>Customer</th><th style={th}>GSTIN</th><th style={th}>Treatment</th><th style={th}>Rate</th><th style={th}>Why</th><th style={{ ...th, textAlign: 'right' }}>Bills</th></tr></thead>
      <tbody>{customers.map((c) => (<tr key={c.id}>
        <td style={{ ...td, color: C.ink, fontWeight: 700 }}>{c.customer_name}{c.is_body_corporate ? <span style={{ color: C.dim, fontWeight: 400 }}> · body corporate</span> : null}</td>
        <td style={td}><input defaultValue={c.gst_no ?? ''} placeholder="GSTIN" onBlur={(e) => { const v = e.target.value.trim().toUpperCase(); if (v !== (c.gst_no ?? '')) save(c, { gst_no: v }); }} style={{ ...inp, width: '170px', fontFamily: 'monospace', borderColor: c.gst_no && !c.gstin_valid ? C.crit : C.line }} /></td>
        <td style={td}><select value={c.gst_mode} onChange={(e) => save(c, { gst_mode: e.target.value })} style={sel}><option value="RCM">RCM — recipient pays</option><option value="FORWARD">FORWARD — we charge</option><option value="EXEMPT">EXEMPT</option></select>{c.gst_mode_locked ? <span style={{ fontSize: '10px', color: C.dim }}> · chosen</span> : null}</td>
        <td style={td}><select value={String(n2(c.gst_pct))} onChange={(e) => save(c, { gst_pct: Number(e.target.value) })} style={sel}><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="0">0%</option></select></td>
        <td style={{ ...td, whiteSpace: 'normal', minWidth: isPhone ? '180px' : '320px', color: C.mut }}>{c.gst_note ?? '—'}</td>
        <td style={tdR}>{c.bills}</td>
      </tr>))}</tbody></table></div>
  );
}

// ══ ITC ═════════════════════════════════════════════════════════════════════
function Itc({ ov, firm, period, isPhone, onChanged }) {
  const [d, setD] = useState(null); const [all, setAll] = useState(false); const [allP, setAllP] = useState(false); const [edit, setEdit] = useState(null); const [add, setAdd] = useState(false);
  const load = useCallback(async () => { if (!firm) return; try { setD(await apiJson(`${API}/itc?firm=${firm}${allP ? '' : `&period=${period}`}${all ? '&all=1' : ''}`)); } catch (e) { setD({ error: e.message }); } }, [firm, period, all, allP]);
  useEffect(() => { load(); }, [load]);
  const M = (d?.months ?? []).reduce((a, m) => ({ eligible: a.eligible + n2(m.itc_eligible), blocked: a.blocked + n2(m.itc_blocked), exempt: a.exempt + n2(m.exempt_inward), nongst: a.nongst + n2(m.non_gst_inward), needs: a.needs + n2(m.needs_invoice) + n2(m.no_gstin) }), { eligible: 0, blocked: 0, exempt: 0, nongst: 0, needs: 0 });
  const rows = d?.rows ?? [];
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <span onClick={() => setAllP((x) => !x)} style={chip(allP)}>{allP ? 'whole FY' : plabel(period)}</span>
        <span onClick={() => setAll((x) => !x)} style={chip(all)}>show toll &amp; diesel months</span>
        <button onClick={() => setAdd(true)} style={btn('cyan')}>＋ purchase invoice</button>
        <span style={{ fontSize: '11.5px', color: C.mut }}>eligible <b style={{ color: C.good }}>{inr(M.eligible)}</b> · blocked under scheme <b style={{ color: C.dim }}>{inr(M.blocked)}</b> · exempt inward (toll) {inr(M.exempt)} · non-GST (diesel) {inr(M.nongst)}{M.needs ? <b style={{ color: C.crit }}> · {M.needs} await an invoice</b> : null}</span>
      </div>
      {add && <ItcForm firm={firm} onDone={async () => { setAdd(false); await load(); onChanged?.(); }} onClose={() => setAdd(false)} />}
      {edit && <ItcForm firm={firm} row={edit} onDone={async () => { setEdit(null); await load(); onChanged?.(); }} onClose={() => setEdit(null)} />}
      <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
        <thead><tr><th style={th}>Date</th><th style={th}>Category</th><th style={th}>Supplier · GSTIN</th><th style={th}>Invoice</th><th style={th}>Description</th><th style={{ ...th, textAlign: 'right' }}>Total</th><th style={{ ...th, textAlign: 'right' }}>Taxable</th><th style={{ ...th, textAlign: 'right' }}>GST</th><th style={th}>Credit</th><th style={th}>Why</th><th style={th}>2B</th><th style={th}></th></tr></thead>
        <tbody>{d?.error && <tr><td style={td} colSpan={12}>{d.error}</td></tr>}
          {rows.length === 0 && !d?.error && <tr><td style={td} colSpan={12}>No purchase entries in this period.</td></tr>}
          {rows.map((r) => (<tr key={r.id} style={{ opacity: r.status === 'EXCLUDED' ? 0.45 : 1 }}>
            <td style={td}>{dmy(r.invoice_date)}</td><td style={td}>{r.category}</td>
            <td style={td}>{r.supplier_name ?? <span style={{ color: C.dim }}>—</span>}<div style={{ fontSize: '10px', fontFamily: 'monospace', color: r.supplier_gstin ? C.mut : C.dim }}>{r.supplier_gstin ?? 'no GSTIN'}</div></td>
            <td style={{ ...td, fontFamily: 'monospace' }}>{r.invoice_no ?? '—'}</td>
            <td style={{ ...td, whiteSpace: 'normal', minWidth: '180px', color: C.mut }}>{r.description}</td>
            <td style={tdR}>{inr2(r.amount_total)}</td><td style={tdR}>{r.taxable_value == null ? '—' : inr2(r.taxable_value)}</td>
            <td style={{ ...tdR, color: r.gst_known ? C.ink : C.dim }}>{r.gst_known ? inr2(r.gst_amount) : 'not recorded'}</td>
            <td style={td}><Pill s={r.eligibility} map={ELIG} /></td>
            <td style={{ ...td, whiteSpace: 'normal', minWidth: '220px', color: C.mut, fontSize: '11px' }}>{r.eligibility_reason}</td>
            <td style={td}><Pill s={r.status} map={ISTAT} /></td>
            <td style={td}>{r.source_kind !== 'LEDGER_MONTH' && <button onClick={() => setEdit(r)} style={btn('cyan')}>✎</button>}</td>
          </tr>))}</tbody></table></div>
    </div>
  );
}

function ItcForm({ firm, row, onDone, onClose }) {
  const [v, setV] = useState({ supplier_name: row?.supplier_name ?? '', supplier_gstin: row?.supplier_gstin ?? '', invoice_no: row?.invoice_no ?? '', invoice_date: day(row?.invoice_date) || '', category: row?.category ?? 'SPARES', description: row?.description ?? '', amount_total: row?.amount_total ?? '', taxable_value: row?.taxable_value ?? '', gst_rate: row?.gst_rate ?? '18', gst_amount: row?.gst_known ? row.gst_amount : '', inter_state: n2(row?.igst) > 0 });
  const calc = () => { const t = n2(v.taxable_value); const r = n2(v.gst_rate); if (t && r) setV({ ...v, gst_amount: (t * r / 100).toFixed(2), amount_total: v.amount_total || (t + t * r / 100).toFixed(2) }); };
  const save = async () => {
    try {
      if (row) await apiJson(`${API}/itc/${row.id}`, { method: 'PATCH', body: JSON.stringify({ ...v, taxable_value: v.taxable_value === '' ? null : v.taxable_value, gst_amount: v.gst_amount === '' ? 0 : v.gst_amount }) });
      else await apiJson(`${API}/itc`, { method: 'POST', body: JSON.stringify({ ...v, company_id: firm }) });
      onDone?.();
    } catch (e) { fail(e); }
  };
  const exclude = async () => { if (!ask('Exclude this entry from the GST register? (It stays in the books; it just carries no credit.)')) return; try { await apiJson(`${API}/itc/${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: row.status === 'EXCLUDED' ? 'CAPTURED' : 'EXCLUDED' }) }); onDone?.(); } catch (e) { fail(e); } };
  const L = ({ l, children, span }) => <label style={{ fontSize: '11px', color: C.mut, gridColumn: span ? '1 / -1' : undefined }}>{l}{children}</label>;
  return (
    <div style={{ ...panel, borderColor: C.cyan }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}><b style={{ color: C.ink }}>{row ? `Purchase invoice · ${row.source_kind}` : 'New purchase invoice'}</b><button onClick={onClose} style={btn()}>close</button></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px' }}>
        <L l="Supplier"><input value={v.supplier_name} onChange={(e) => setV({ ...v, supplier_name: e.target.value })} style={{ ...inp, width: '100%' }} /></L>
        <L l="Supplier GSTIN"><input value={v.supplier_gstin} onChange={(e) => setV({ ...v, supplier_gstin: e.target.value.toUpperCase() })} placeholder="18AXTPD0252D1ZP" style={{ ...inp, width: '100%', fontFamily: 'monospace' }} /></L>
        <L l="Invoice no"><input value={v.invoice_no} onChange={(e) => setV({ ...v, invoice_no: e.target.value })} style={{ ...inp, width: '100%' }} /></L>
        <L l="Invoice date"><input type="date" value={v.invoice_date} onChange={(e) => setV({ ...v, invoice_date: e.target.value })} style={{ ...inp, width: '100%' }} /></L>
        <L l="Category"><select value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })} style={{ ...sel, width: '100%' }}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></L>
        <L l="Taxable value"><input type="number" value={v.taxable_value} onChange={(e) => setV({ ...v, taxable_value: e.target.value })} onBlur={calc} style={{ ...inp, width: '100%' }} /></L>
        <L l="GST rate %"><select value={String(v.gst_rate)} onChange={(e) => setV({ ...v, gst_rate: e.target.value })} style={{ ...sel, width: '100%' }}>{['0', '5', '12', '18', '28'].map((r) => <option key={r} value={r}>{r}%</option>)}</select></L>
        <L l="GST amount"><input type="number" value={v.gst_amount} onChange={(e) => setV({ ...v, gst_amount: e.target.value })} style={{ ...inp, width: '100%' }} /></L>
        <L l="Total (incl. GST)"><input type="number" value={v.amount_total} onChange={(e) => setV({ ...v, amount_total: e.target.value })} style={{ ...inp, width: '100%' }} /></L>
        <L l="Supply"><select value={v.inter_state ? 'INTER' : 'INTRA'} onChange={(e) => setV({ ...v, inter_state: e.target.value === 'INTER' })} style={{ ...sel, width: '100%' }}><option value="INTRA">Intra-state (CGST + SGST)</option><option value="INTER">Inter-state (IGST)</option></select></L>
        <L l="Description" span><input value={v.description} onChange={(e) => setV({ ...v, description: e.target.value })} style={{ ...inp, width: '100%' }} /></L>
      </div>
      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end', marginTop: '8px' }}>{row && <button onClick={exclude} style={btn('warn')}>{row.status === 'EXCLUDED' ? 'include again' : 'exclude'}</button>}<button onClick={save} style={btn('solid')}>Save</button></div>
    </div>
  );
}

// ══ RECON (GSTR-2B) ═════════════════════════════════════════════════════════
function Recon({ firm, period, isPhone, onChanged }) {
  const [d, setD] = useState(null); const [file, setFile] = useState(null); const [busy, setBusy] = useState(false); const [res, setRes] = useState(null);
  const load = useCallback(async () => { if (!firm || !period) return; try { setD(await apiJson(`${API}/2b?firm=${firm}&period=${period}`)); } catch (e) { setD({ error: e.message }); } }, [firm, period]);
  useEffect(() => { load(); }, [load]);
  const upload = async () => {
    if (!file) return; setBusy(true);
    try { const fd = new FormData(); fd.append('firm', firm); fd.append('period', period); fd.append('file', file); const r = await apiJson(`${API}/itc/2b-upload`, { method: 'POST', body: fd }); setRes(r); setFile(null); await load(); onChanged?.(); } catch (e) { fail(e); } finally { setBusy(false); }
  };
  const M2 = { MATCHED: ['MATCHED', C.good], AMOUNT_DIFF: ['AMOUNT DIFFERS', C.warn], UNMATCHED: ['NOT IN OUR BOOKS', C.crit] };
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ ...panel, display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <b style={{ color: C.ink }}>GSTR-2B for {plabel(period)}</b>
        <span style={{ fontSize: '11.5px', color: C.mut }}>Download GSTR-2B from the GST portal (JSON or Excel) and upload it here. Each supplier invoice is matched to the register by GSTIN + invoice number.</span>
        <input type="file" accept=".json,.csv,.xlsx,.xls" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ color: C.mut, fontSize: '12px' }} />
        <button onClick={upload} disabled={!file || busy} style={btn('solid', !!file && !busy)}>Upload &amp; match</button>
        {res && <span style={{ fontSize: '11.5px', color: C.good }}>✓ {res.parsed} lines read · {res.matched} matched · {res.amount_diff} amount differs · {res.unmatched} not in our books · 2B tax {inr(res.tax)}</span>}
      </div>
      <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
        <thead><tr><th style={th}>Match</th><th style={th}>Supplier · GSTIN</th><th style={th}>Invoice</th><th style={th}>Date</th><th style={{ ...th, textAlign: 'right' }}>Taxable</th><th style={{ ...th, textAlign: 'right' }}>GST (2B)</th><th style={{ ...th, textAlign: 'right' }}>GST (books)</th><th style={th}>ITC avl</th><th style={th}>Book entry</th></tr></thead>
        <tbody>{d?.error && <tr><td style={td} colSpan={9}>{d.error}</td></tr>}
          {(d?.rows ?? []).length === 0 && !d?.error && <tr><td style={td} colSpan={9}>No GSTR-2B uploaded for this period.</td></tr>}
          {(d?.rows ?? []).map((t) => (<tr key={t.id}><td style={td}><Pill s={t.match_state} map={M2} /></td><td style={td}>{t.supplier_name ?? '—'}<div style={{ fontSize: '10px', fontFamily: 'monospace', color: C.mut }}>{t.supplier_gstin}</div></td><td style={{ ...td, fontFamily: 'monospace' }}>{t.invoice_no}</td><td style={td}>{dmy(t.invoice_date)}</td><td style={tdR}>{inr2(t.taxable_value)}</td><td style={tdR}>{inr2(n2(t.igst) + n2(t.cgst) + n2(t.sgst))}</td><td style={tdR}>{t.book_gst == null ? '—' : inr2(t.book_gst)}</td><td style={td}>{t.itc_available === null ? '—' : t.itc_available ? 'Y' : 'N'}</td><td style={{ ...td, whiteSpace: 'normal', color: C.mut }}>{t.book_description ?? '—'}</td></tr>))}
        </tbody></table></div>
      {(d?.not_in_2b ?? []).length > 0 && (<div style={panel}><b style={{ color: C.crit }}>In our books, not in GSTR-2B ({d.not_in_2b.length})</b><div style={{ fontSize: '12px', color: C.mut, marginTop: '4px' }}>The supplier has not filed these — no credit until they do. Chase the supplier or drop the claim.</div>
        {d.not_in_2b.map((r) => <div key={r.id} style={{ fontSize: '12px', color: C.ink2, marginTop: '4px' }}>{r.supplier_name ?? '—'} · {r.invoice_no ?? '—'} · {dmy(r.invoice_date)} · GST {inr2(r.gst_amount)}</div>)}</div>)}
    </div>
  );
}

// ══ GOVT ════════════════════════════════════════════════════════════════════
function Govt({ ov, firm, period, F, exp, isPhone, onChanged }) {
  const [d, setD] = useState(null);
  const load = useCallback(async () => { if (!firm) return; try { setD(await apiJson(`${API}/returns?firm=${firm}`)); } catch (e) { setD({ error: e.message }); } }, [firm]);
  useEffect(() => { load(); }, [load]);
  const filed = async (f) => {
    const arn = window.prompt(`ARN / acknowledgement for ${f.form} ${plabel(f.period)} (${f.company_name}):`, f.arn ?? ''); if (arn === null) return;
    const when = window.prompt('Filed on (YYYY-MM-DD):', new Date().toISOString().slice(0, 10)); if (when === null) return;
    try { await apiJson(`${API}/returns/${f.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'FILED', arn, filed_at: when }) }); await load(); onChanged?.(); } catch (e) { fail(e); }
  };
  const nil = async (f) => { if (!ask(`Mark ${f.form} ${plabel(f.period)} as a NIL return?`)) return; try { await apiJson(`${API}/returns/${f.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'NIL' }) }); await load(); onChanged?.(); } catch (e) { fail(e); } };
  const rows = d?.rows ?? [];
  const cur = rows.filter((r) => r.period === period);
  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <div style={{ ...panel, display: 'grid', gridTemplateColumns: isPhone ? '1fr' : '1.2fr 1fr', gap: '12px' }}>
        <div>
          <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>Download for Govt Portal · {F?.company_name} · {plabel(period)}</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' }}>
            <button onClick={() => exp('gstr1', 'xlsx')} style={btn('gold')}>⬇ GSTR-1 (Excel · b2b, exemp, hsn, docs)</button>
            <button onClick={() => exp('gstr1', 'json')} style={btn('cyan')}>⬇ GSTR-1 JSON (portal / offline tool)</button>
            <button onClick={() => exp('gstr1', 'csv')} style={btn('cyan')}>⬇ GSTR-1 b2b.csv</button>
            <button onClick={() => exp('gstr3b', 'xlsx')} style={btn('gold')}>⬇ GSTR-3B summary (Excel)</button>
            <button onClick={() => exp('gstr3b', 'csv')} style={btn('cyan')}>⬇ GSTR-3B CSV</button>
            <button onClick={() => exp('itc')} style={btn('cyan')}>⬇ ITC register CSV</button>
            <button onClick={() => exp('ca-pack')} style={btn('solid')}>⬇ Complete CA pack (one Excel)</button>
          </div>
          <div style={{ fontSize: '11.5px', color: C.mut, marginTop: '8px', lineHeight: 1.5 }}>GSTR-1 table 4B carries the reverse-charge invoices with “Reverse Charge = Y”; forward-charge invoices go to 4A; exempt supplies to table 8; HSN summary under SAC {F?.gst_sac ?? '996791'}. Documents flagged “needs attention” are listed on the Attention sheet and left out of the b2b sheet until fixed — never filed with a blank GSTIN. GTA is exempt from e-invoicing.</div>
        </div>
        <div>
          <div style={{ fontSize: '10.5px', letterSpacing: '.12em', textTransform: 'uppercase', color: C.dim }}>This period</div>
          {cur.length === 0 && <div style={{ fontSize: '12px', color: C.mut, marginTop: '6px' }}>No filing rows yet for {plabel(period)} — they appear once the month has documents or purchases.</div>}
          {cur.map((f) => (<div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginTop: '6px', fontSize: '12px' }}>
            <span><b style={{ color: C.ink }}>{f.form === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'}</b> · due {dmy(f.due_date)} · <Pill s={f.urgency} map={URG} /> <Pill s={f.status} map={FSTAT} />{f.arn ? <span style={{ color: C.dim }}> · {f.arn}</span> : null}</span>
            {!['FILED', 'NIL'].includes(f.status) && <span style={{ display: 'flex', gap: '4px' }}><button onClick={() => filed(f)} style={btn('good')}>filed ✓</button><button onClick={() => nil(f)} style={btn()}>nil</button></span>}
          </div>))}
        </div>
      </div>
      <div style={wrap}><table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '12px' }}>
        <thead><tr><th style={th}>Period</th><th style={th}>Form</th><th style={th}>Due</th><th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }}>Docs</th><th style={{ ...th, textAlign: 'right' }}>RCM taxable</th><th style={{ ...th, textAlign: 'right' }}>Output tax</th><th style={{ ...th, textAlign: 'right' }}>ITC</th><th style={{ ...th, textAlign: 'right' }}>Net payable</th><th style={th}>Attention</th><th style={th}>ARN</th><th style={th}></th></tr></thead>
        <tbody>{d?.error && <tr><td style={td} colSpan={12}>{d.error}</td></tr>}
          {rows.map((f) => (<tr key={f.id}>
            <td style={{ ...td, color: C.ink, fontWeight: 700 }}>{f.label}</td><td style={td}>{f.form === 'GSTR1' ? 'GSTR-1' : 'GSTR-3B'}</td><td style={td}>{dmy(f.due_date)} <Pill s={f.urgency} map={URG} /></td><td style={td}><Pill s={f.status} map={FSTAT} /></td>
            <td style={tdR}>{f.docs ?? 0}</td><td style={tdR}>{inr(f.rcm_taxable)}</td><td style={tdR}>{inr(f.output_tax)}</td><td style={tdR}>{inr(f.itc_eligible)}</td><td style={{ ...tdR, fontWeight: 800, color: n2(f.net_payable) ? C.crit : C.good }}>{inr2(f.net_payable)}</td>
            <td style={td}>{f.docs_needing_attention ? <span style={{ color: C.crit }}>{f.docs_needing_attention} docs</span> : null}{n2(f.needs_invoice) + n2(f.no_gstin) ? <span style={{ color: C.warn }}> {n2(f.needs_invoice) + n2(f.no_gstin)} purchases</span> : null}</td>
            <td style={{ ...td, fontFamily: 'monospace', color: C.mut }}>{f.arn ?? '—'}{f.filed_at ? <div style={{ fontSize: '10px', fontFamily: 'inherit' }}>{dmy(f.filed_at)}</div> : null}</td>
            <td style={td}>{!['FILED', 'NIL'].includes(f.status) && <button onClick={() => filed(f)} style={btn('good')}>filed ✓</button>}</td>
          </tr>))}</tbody></table></div>
    </div>
  );
}
