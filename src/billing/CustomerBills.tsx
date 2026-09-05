// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// THE CUSTOMER 15-DAY BILL — branch-wise, IOCL-format core, trip-wise milaan
//
// Owner, 5-Sep-2026 (design v1 approved): one bill per customer × books ×
// cycle, every branch a block, every trip a line with the flag the advice
// pipeline earned it — PAID / SHORT / PENDING / MISSING / UNPRICED. Print by
// customer type. Raise posts revenue (once); receipts come from the pipeline.
// The mapping desk is where a person gives 100 trips their customer, ties a
// spelling to a master, confirms a branch, sets a customer's type and cycle.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback } from 'react';
import GlobalPagination, { usePagination } from '../components/GlobalPagination';
import { sendWhatsApp } from '../lib/waSend';
import { API_BASE } from '../lib/apiBase';

const API = `${API_BASE}/api/v1/customer-bills`;
const apiJson = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: { ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.detail || j.error || `HTTP ${res.status}`), { code: j.error });
  return j;
};
const n2 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const inr = (v) => '₹' + n2(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inr2 = (v) => '₹' + n2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num2 = (v) => n2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => (d ? String(d).slice(0, 10) : '');
const dmy = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');
const C = { ink: '#eef2fd', ink2: '#c4d1ea', mut: '#9aadd4', dim: '#5d7196', line: '#27395f', raised: '#18244a', panel: '#121c38',
            cyan: '#22d3ee', good: '#2fe39b', crit: '#ff6b81', warn: '#ffb224', ai: '#a78bfa', cust: '#38bdf8', zero: '#3d548a' };
const STATUS = {
  AI_DRAFT: ['🤖 AI DRAFT', C.ai], STAFF_REVIEWED: ['📝 REVIEW', C.warn], RAISED: ['📤 RAISED', C.cyan],
  PART_PAID: ['🟡 PART-PAID', C.warn], PAID: ['✅ PAID', C.good], DISPUTED: ['⚠️ DISPUTE', C.crit], CANCELLED: ['✕ CANCELLED', C.dim],
};
const FLAG = {
  PAID: ['✅ Paid', C.good, 'rgba(47,227,155,.15)'], SHORT: ['⚠️ Short', C.warn, 'rgba(255,178,36,.15)'],
  MISSING: ['❌ Missing', C.crit, 'rgba(255,107,129,.15)'], PENDING: ['🕒 Pending', C.mut, 'rgba(93,113,150,.2)'],
  UNPRICED: ['rate nahi', C.crit, 'rgba(255,107,129,.12)'],
};
const TYPE = { OIL_COMPANY: '🛢 Oil Company', CONTRACT: '📜 Contract', MARKET: '🛒 Market' };
const Pill = ({ status }) => { const s = STATUS[status] ?? [status, C.dim]; return <span style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '.05em', borderRadius: '999px', padding: '2px 9px', border: `1px solid ${s[1]}`, color: s[1], whiteSpace: 'nowrap' }}>{s[0]}</span>; };
const Flag = ({ f, n }) => { const s = FLAG[f] ?? [f, C.dim, 'transparent']; return <span style={{ fontSize: '10px', fontWeight: 800, borderRadius: '6px', padding: '2px 7px', background: s[2], color: s[1], whiteSpace: 'nowrap', marginRight: '3px' }}>{n !== undefined ? `${n} ` : ''}{s[0]}</span>; };
const btn = (kind, on = true) => ({
  font: 'inherit', fontWeight: 700, fontSize: '12px', borderRadius: '8px', padding: '7px 13px', border: `1px solid ${C.line}`, background: 'transparent',
  color: C.mut, cursor: on ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap', opacity: on ? 1 : 0.5,
  ...({ cyan: { background: 'rgba(34,211,238,.12)', borderColor: 'rgba(34,211,238,.5)', color: C.cyan },
        good: { background: 'rgba(47,227,155,.10)', borderColor: 'rgba(47,227,155,.55)', color: C.good },
        solid: { background: C.good, borderColor: C.good, color: '#0a1024' },
        warn: { background: 'rgba(255,178,36,.12)', borderColor: 'rgba(255,178,36,.5)', color: C.warn },
        ai: { background: 'rgba(167,139,250,.14)', borderColor: 'rgba(167,139,250,.5)', color: '#c4b5fd' },
        cust: { background: 'rgba(56,189,248,.12)', borderColor: 'rgba(56,189,248,.5)', color: C.cust },
        crit: { background: 'rgba(255,107,129,.12)', borderColor: 'rgba(255,107,129,.5)', color: C.crit } }[kind] ?? {}),
});
const chip = (on) => ({ fontSize: '11px', fontWeight: 700, borderRadius: '999px', padding: '3px 9px', cursor: 'pointer', border: `1px solid ${on ? C.cyan : C.line}`, color: on ? C.cyan : C.mut, background: on ? 'rgba(34,211,238,.12)' : 'transparent' });
const th = { padding: '9px 10px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.08em', color: C.dim, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap', background: 'rgba(10,16,36,.5)' };
const td = { padding: '9px 10px', borderBottom: '1px solid #1b2a4e', color: C.ink2, whiteSpace: 'nowrap', verticalAlign: 'top' };
const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

// ══ THE LIST ════════════════════════════════════════════════════════════════
export default function CustomerBills() {
  const [data, setData] = useState({ rows: [], cards: [], cycles: [], totals: {}, audit: {} });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [cycle, setCycle] = useState(null);      // period_from or null = all
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const [panel, setPanel] = useState('');        // '' | 'MAP' | 'TAX' | 'LEDGER'
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const qs = new URLSearchParams();
      if (cycle) qs.set('period_from', cycle);
      if (status) qs.set('status', status);
      if (type) qs.set('type', type);
      if (q.trim()) qs.set('q', q.trim());
      const j = await apiJson(`${API}?${qs}`);
      setData(j);
      if (cycle === null && j.cycles?.length && !status && !q) setCycle(day(j.cycles[0].period_from));
    } catch (e) { setErr(e?.message ?? 'bill list nahi aayi'); }
    setLoading(false);
  }, [cycle, status, type, q]);
  useEffect(() => { load(); }, [load]);
  const pg = usePagination(data.rows, { defaultSize: 12 });
  useEffect(() => { pg.setPage(1); }, [cycle, status, type, q]);

  const build = async (range) => {
    const NL = String.fromCharCode(10);
    setBusy(true);
    try {
      if (range) {
        if (!window.confirm('1 Apr 2026 se aaj tak har customer ka har cycle draft banayein / refresh karein?' + NL + 'Raise kiye hue bill par sirf vasool badlegi.')) { setBusy(false); return; }
        const j = await apiJson(`${API}/build-range`, { method: 'POST', body: JSON.stringify({ from: '2026-04-01', to: new Date().toISOString().slice(0, 10) }) });
        const t = (j.periods ?? []).reduce((a, p) => ({ c: a.c + n2(p.created), r: a.r + n2(p.refreshed) }), { c: 0, r: 0 });
        alert(`🤖 TARA: ${j.periods?.length ?? 0} pakhwade — ${t.c} naye customer bill, ${t.r} refresh.`);
      } else {
        const j = await apiJson(`${API}/build`, { method: 'POST', body: JSON.stringify({ period_from: cycle ?? new Date().toISOString().slice(0, 10) }) });
        alert(`🤖 ${j.created} naye, ${j.refreshed} refresh, ${j.skipped} raised (sirf vasool badli).`);
      }
      await load();
    } catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Sirf admin poora saal bana sakte hain.' : (e?.message ?? 'nahi bana')}`); }
    setBusy(false);
  };

  const T = data.totals; const A = data.audit ?? {};
  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: '12px' }}>
        <div>
          <h3 style={{ margin: 0, color: '#fff', fontSize: '19px' }}>🧾 Customer 15-Day Bills</h3>
          <div style={{ color: C.mut, fontSize: '12.5px', marginTop: '3px', maxWidth: '90ch' }}>
            Har customer ka ek bill, branch-wise, IOCL format. TARA har 1 aur 16 tareekh draft banati hai (contract customer mahine ka); BHUVANESHWARI mail se unke bill/advice laati hai;
            har trip par jhanda — Paid / Short / Missing / Pending. Admin "Raise" karta hai (revenue post), vasool advice se apne aap.
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => setPanel(panel === 'MAP' ? '' : 'MAP')} style={btn(panel === 'MAP' ? 'warn' : 'plain')}>⚖️ Mapping desk{A.findings ? ` (${A.findings})` : ''}</button>
          <button onClick={() => setPanel(panel === 'TAX' ? '' : 'TAX')} style={btn(panel === 'TAX' ? 'cust' : 'plain')}>📊 GST / TDS</button>
          <button onClick={() => setPanel(panel === 'LEDGER' ? '' : 'LEDGER')} style={btn(panel === 'LEDGER' ? 'crit' : 'plain')}>🧮 Ledger audit</button>
          <button onClick={() => build(false)} disabled={busy} style={btn('ai', !busy)}>🤖 Draft banayein</button>
          <button onClick={() => build(true)} disabled={busy} style={btn('ai', !busy)} title="admin">📅 Apr se ab tak</button>
        </div>
      </div>

      {panel === 'MAP' && <MappingDesk onChanged={load} />}
      {panel === 'TAX' && <TaxSummary />}
      {panel === 'LEDGER' && <LedgerAudit />}

      {/* cycles + filters */}
      <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '8px', marginBottom: '6px' }}>
        <span onClick={() => setCycle('')} style={{ ...chip(cycle === ''), flex: 'none', alignSelf: 'center' }}>Sab cycles</span>
        {data.cycles.map((c) => (
          <button key={c.period_from + c.cycle_kind} onClick={() => setCycle(day(c.period_from))}
            style={{ flex: 'none', textAlign: 'left', minWidth: '168px', cursor: 'pointer', background: cycle === day(c.period_from) ? 'rgba(56,189,248,.12)' : 'rgba(18,28,56,.5)',
                     border: `1px solid ${cycle === day(c.period_from) ? C.cust : C.line}`, borderRadius: '10px', padding: '8px 12px' }}>
            <div style={{ color: cycle === day(c.period_from) ? C.cust : C.ink, fontWeight: 700, fontSize: '12.5px' }}>{c.cycle_label}</div>
            <div style={{ color: C.dim, fontSize: '10.5px' }}>{c.bills} bill · {c.drafts} draft · {c.raised} raised · {c.paid} paid</div>
            <div style={{ color: n2(c.balance) > 0 ? C.warn : C.good, fontSize: '12px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>baaki {inr(c.balance)}{n2(c.missing) ? <span style={{ color: C.crit }}> · ❌ {c.missing}</span> : null}</div>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
        {[['', 'Sab'], ['AI_DRAFT', `Draft`], ['STAFF_REVIEWED', 'Review'], ['RAISED', 'Raised'], ['PART_PAID', 'Part-paid'], ['PAID', 'Paid'], ['DISPUTED', 'Dispute']].map((s) => (
          <span key={s[0]} onClick={() => setStatus(s[0])} style={chip(status === s[0])}>{s[1]}</span>))}
        <span style={{ width: '8px' }} />
        {[['', 'Sab customer'], ['OIL_COMPANY', '🛢 Oil Company'], ['CONTRACT', '📜 Contract'], ['MARKET', '🛒 Market']].map((s) => (
          <span key={s[0]} onClick={() => setType(s[0])} style={chip(type === s[0])}>{s[1]}</span>))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="customer / bill no"
          style={{ background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '8px', color: C.ink, padding: '6px 10px', fontSize: '12px', width: '180px' }} />
      </div>

      {/* customer cards */}
      {data.cards.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '10px', marginBottom: '14px' }}>
          {data.cards.slice(0, 6).map((c) => (
            <div key={c.customer_id} onClick={() => setQ(c.customer_name)} style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '11px 13px', cursor: 'pointer', minWidth: 0 }}>
              <div style={{ fontSize: '12px', color: C.ink2, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.customer_name}</div>
              <div style={{ fontSize: '20px', fontWeight: 800, marginTop: '2px', fontVariantNumeric: 'tabular-nums', color: n2(c.outstanding_raised) > 0 ? C.warn : n2(c.unpriced) > 0 ? C.crit : C.good }}>
                {n2(c.outstanding_raised) > 0 ? inr(c.outstanding_raised) : n2(c.unpriced) > 0 ? `${c.unpriced} unpriced` : c.bills ? 'sab vasool' : 'koi bill nahi'}
              </div>
              <div style={{ fontSize: '10.5px', color: C.dim, marginTop: '3px' }}>
                {TYPE[c.customer_type] ?? 'prakaar tay nahi'} · {c.bills} bill · gross {inr(c.gross)} · vasool {inr(c.received)}{n2(c.missing_count) ? <span style={{ color: C.crit }}> · ❌ {c.missing_count} missing {inr(c.missing_amount)}</span> : null} · {c.branches_confirmed}/{c.branches} branch ✓
              </div>
            </div>
          ))}
        </div>
      )}
      {err && <p style={{ color: C.crit, fontSize: '12.5px' }}>{err}</p>}

      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
        {loading ? <p style={{ color: C.warn, textAlign: 'center', padding: '26px' }}>Bill khul rahe hain…</p>
        : data.rows.length === 0 ? <p style={{ color: C.dim, textAlign: 'center', padding: '26px', fontSize: '13px' }}>Koi bill nahi — "🤖 Draft banayein" ya "📅 Apr se ab tak" dabaiye. Bina customer ke trip Mapping desk me hain.</p>
        : (
          <table style={{ width: '100%', minWidth: '1180px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead><tr>
              <th style={th}>Bill No</th><th style={th}>Customer · books</th><th style={th}>Cycle</th>
              <th style={{ ...th, textAlign: 'right' }}>Branch</th><th style={{ ...th, textAlign: 'right' }}>Trip</th>
              <th style={{ ...th, textAlign: 'right' }}>Gross</th><th style={{ ...th, textAlign: 'right' }}>Shortage</th><th style={{ ...th, textAlign: 'right' }}>TDS</th>
              <th style={{ ...th, textAlign: 'right' }}>Net receivable</th><th style={{ ...th, textAlign: 'right' }}>Vasool</th><th style={{ ...th, textAlign: 'right' }}>Baaki</th><th style={th}>Milaan</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {pg.slice.map((b) => (
                <tr key={b.id} onClick={() => setOpenId(b.id)} style={{ cursor: 'pointer' }}>
                  <td style={{ ...td, fontFamily: 'monospace', color: C.cust }}>{b.bill_no}</td>
                  <td style={{ ...td, color: C.ink, whiteSpace: 'normal', minWidth: '220px' }}>{b.customer_name}
                    <div style={{ fontSize: '10.5px', color: C.dim }}>{TYPE[b.customer_type] ?? '—'} · {b.company_name ?? b.operating_company ?? '(books?)'} ki books{b.customer_code ? ` · code ${b.customer_code}` : ''}</div></td>
                  <td style={td}>{b.cycle_label}</td>
                  <td style={tdR}>{b.branches}</td><td style={tdR}>{b.trips}</td>
                  <td style={{ ...tdR, color: C.ink }}>{inr2(b.gross)}</td>
                  <td style={{ ...tdR, color: n2(b.shortage_penalty) ? C.warn : C.zero }}>{n2(b.shortage_penalty) ? inr2(b.shortage_penalty) : '0'}</td>
                  <td style={tdR}>{inr2(b.tds)}</td>
                  <td style={{ ...tdR, color: C.ink }}>{inr2(b.net_receivable)}</td>
                  <td style={{ ...tdR, color: C.good }}>{inr2(b.received)}</td>
                  <td style={{ ...tdR, color: n2(b.balance) > 2 ? C.warn : C.good, fontWeight: 700 }}>{inr2(b.balance)}</td>
                  <td style={td}>
                    {n2(b.paid_count) > 0 && <Flag f="PAID" n={b.paid_count} />}{n2(b.short_count) > 0 && <Flag f="SHORT" n={b.short_count} />}
                    {n2(b.missing_count) > 0 && <Flag f="MISSING" n={b.missing_count} />}{n2(b.pending_count) > 0 && <Flag f="PENDING" n={b.pending_count} />}
                    {n2(b.unpriced_count) > 0 && <Flag f="UNPRICED" n={b.unpriced_count} />}
                    {n2(b.their_unmatched) > 0 && <span style={{ fontSize: '10px', color: '#c4b5fd', fontWeight: 800 }}>❓ {b.their_unmatched} unki</span>}
                  </td>
                  <td style={td}><Pill status={b.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {data.rows.length > 0 && <GlobalPagination {...pg} label="bill" />}
      <p style={{ color: C.dim, fontSize: '11px', marginTop: '10px', lineHeight: 1.6 }}>
        Is filter me: gross {inr(T.gross)} · vasool {inr(T.received)} · baaki {inr(T.balance)} · TDS {inr(T.tds)} · GST RCM memo {inr(T.gst_memo)} · ❌ missing {inr(T.missing)} · 🕒 pending {inr(T.pending)}.
        Bill no = customer initials + pakhwada (mahina contract ke liye); "-GP"/"-JE" = doosri firm ki books. Vasool trip par advice pipeline se aati hai — yahan sirf padhi jaati hai.
      </p>
      {openId && <BillDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

// ══ ONE BILL ════════════════════════════════════════════════════════════════
function BillDrawer({ id, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adj, setAdj] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [notes, setNotes] = useState('');
  const [open, setOpen] = useState({});
  const [tab, setTab] = useState('BILL');       // BILL | RECON

  const load = useCallback(async () => {
    setErr('');
    try {
      const j = await apiJson(`${API}/${id}`);
      setData(j); setNotes(j.bill?.notes ?? '');
      setAdj(Array.isArray(j.bill?.adjustments) ? j.bill.adjustments : []);
      setDisputes(Array.isArray(j.bill?.disputes) ? j.bill.disputes : []);
      const o = {}; (j.blocks ?? []).forEach((b, i) => { o[b.branch_key] = i < 3; }); setOpen(o);
    } catch (e) { setErr(e?.message ?? 'bill nahi khula'); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);

  const b = data?.bill; const blocks = data?.blocks ?? [];
  const locked = !!b?.locked_at;
  const dirty = b && (notes !== (b.notes ?? '') || JSON.stringify(adj) !== JSON.stringify(b.adjustments ?? []) || JSON.stringify(disputes) !== JSON.stringify(b.disputes ?? []));

  const save = async () => {
    setBusy(true); setErr('');
    try { await apiJson(`${API}/${id}`, { method: 'PATCH', body: JSON.stringify({ notes, adjustments: adj, disputes }) }); await load(); onChanged?.(); setEditing(false); }
    catch (e) { setErr(e?.message ?? 'save nahi hua'); }
    setBusy(false);
  };
  const raise = async () => {
    const NL = String.fromCharCode(10);
    if (n2(b.unpriced_count) > 0) return alert(`⚠️ ${b.unpriced_count} trip ka rate/amount nahi — Pending Billing me qty × rate bhariye, phir raise.`);
    if (!window.confirm(`${b.customer_name} — ${b.cycle_label}` + NL + `Gross ${inr2(b.gross)} · net receivable ${inr2(b.net_receivable)}` + NL + NL
      + `Raise karein? Revenue ${inr2(data.journal?.amount)} post hoga (Dr Debtors / Cr Freight Income)${n2(data.journal?.legacy) ? `; ${inr2(data.journal.legacy)} pehle ke bill se already posted, dobara nahi` : ''}. Bill lock hoga; vasool advice se aati rahegi.`)) return;
    setBusy(true); setErr('');
    try { const j = await apiJson(`${API}/${id}/raise`, { method: 'POST' }); alert('📤 Raise ho gaya.' + NL + (j.note ?? '')); await load(); onChanged?.(); }
    catch (e) { setErr(e?.code === 'FORBIDDEN' ? 'Raise sirf admin kar sakte hain.' : (e?.message ?? 'raise nahi hua')); }
    setBusy(false);
  };
  const reopen = async () => {
    const reason = window.prompt('Modify kyon? (kaaran zaroori)', ''); if (!reason || reason.trim().length < 4) return;
    setBusy(true); try { await apiJson(`${API}/${id}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) }); await load(); onChanged?.(); setEditing(true); }
    catch (e) { setErr(e?.code === 'FORBIDDEN' ? 'Modify sirf admin.' : (e?.message ?? 'nahi khula')); }
    setBusy(false);
  };
  const refresh = async () => { setBusy(true); try { await apiJson(`${API}/${id}/refresh`, { method: 'POST' }); await load(); onChanged?.(); } catch (e) { setErr(e?.message); } setBusy(false); };
  const whatsapp = async () => {
    try { const j = await apiJson(`${API}/${id}/summary-text`); const phone = window.prompt('Kis number par?', ''); if (!phone) return;
      const r = await sendWhatsApp({ phone, message: j.text, role: 'CUSTOMER' }); alert(r?.via === 'server' ? '🟢 Bhej diya.' : '📱 WhatsApp khul gaya.'); }
    catch (e) { alert(`❌ ${e?.message ?? ''}`); }
  };
  const email = async () => { const to = window.prompt('Kis e-mail par?', ''); if (!to) return; setBusy(true); try { const j = await apiJson(`${API}/${id}/email`, { method: 'POST', body: JSON.stringify({ to }) }); alert(`✉️ Bhej diya — ${j.to}`); } catch (e) { alert(`❌ ${e?.message ?? ''}`); } setBusy(false); };
  const dispute = (t, kind) => {
    const amount = kind === 'MISSING' ? n2(t.gross) : n2(t.gross) - n2(t.penalty) - n2(t.received);
    const note = window.prompt(`${t.trip_code} — ${kind === 'MISSING' ? 'IOCL ke bill me nahi' : 'kam diya'} ${inr2(amount)}. Note:`, ''); if (note === null) return;
    setDisputes((d) => [...d.filter((x) => x.trip_id !== t.trip_id), { trip_id: t.trip_id, trip_code: t.trip_code, kind, amount, note }]);
  };

  const print = () => {
    if (!b) return;
    const w = window.open('', '_blank'); if (!w) return;
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const fmt = b.print_format ?? 'OIL_CO';
    let body = '';
    if (fmt === 'CONTRACT_RCM') {
      // Tax Invoice (Transportation Bill RCM) — the Aadhar shape: numbered CN lines, HSN 996791, CGST + SGST.
      let i = 0;
      for (const blk of blocks) for (const t of blk.trips) { i += 1; body += `<tr><td>${i}</td><td>${esc(t.trip_code)}<br><small>${esc(t.vehicle_no)} · ${day(t.loading_date)}</small></td><td>${esc(blk.branch_name)}</td><td class="r">${n2(t.qty).toFixed(3)}</td><td class="r">${t.rate ? n2(t.rate).toFixed(2) : (n2(t.qty) ? (n2(t.gross) / n2(t.qty)).toFixed(2) : '')}</td><td class="r">${num2(t.gross)}</td></tr>`; }
      const half = n2(b.gst_memo) / 2;
      body = `<table><thead><tr><th>Sl</th><th>CN / Trip</th><th>Destination</th><th>Qty (KL)</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${body}</tbody>
        <tfoot><tr><td colspan="5" class="r">Taxable value (HSN 996791)</td><td class="r b">${num2(b.gross)}</td></tr>
        <tr><td colspan="5" class="r">CGST ${(n2(b.gst_pct) / 2).toFixed(1)}% (RCM)</td><td class="r">${num2(half)}</td></tr>
        <tr><td colspan="5" class="r">SGST ${(n2(b.gst_pct) / 2).toFixed(1)}% (RCM)</td><td class="r">${num2(half)}</td></tr>
        <tr><td colspan="5" class="r b">Total (GST payable by recipient under RCM)</td><td class="r b">${num2(n2(b.gross) + n2(b.gst_memo))}</td></tr></tfoot></table>
        <p class="note">GST payable by the recipient under reverse charge (Notification 13/2017-CT(R)). MSME registered. Detention, if any, on a separate annexure.</p>`;
    } else if (fmt === 'MARKET_LR') {
      for (const blk of blocks) for (const t of blk.trips) body += `<tr><td>${esc(t.trip_code)}</td><td>${day(t.loading_date)} → ${day(t.unloading_date)}</td><td>${esc(blk.branch_name)}</td><td>${esc(t.vehicle_no)}</td><td>${esc(t.product ?? '')} ${n2(t.qty) ? n2(t.qty).toFixed(3) : ''}</td><td class="r">${num2(t.gross)}</td></tr>`;
      body = `<table><thead><tr><th>LR / Trip</th><th>Dates</th><th>Destination</th><th>Truck</th><th>Material · Qty</th><th>Freight</th></tr></thead><tbody>${body}</tbody>
        <tfoot><tr><td colspan="5" class="r b">Total freight</td><td class="r b">${num2(b.gross)}</td></tr></tfoot></table>`;
    } else {
      // Oil company — the mirror of their transportation bill, branch-wise.
      for (const blk of blocks) {
        body += `<tr class="veh"><td colspan="12">${esc(blk.branch_code ? blk.branch_code + ' – ' : '')}${esc(blk.branch_name)} · ${blk.subtotal.trips} trip</td></tr>`;
        for (const t of blk.trips) body += `<tr><td>${esc(t.iocl_bill_no || t.trip_code)}<br><small>${esc(t.trip_code)} · ${day(t.loading_date)} → ${day(t.unloading_date)}</small></td><td>${esc(t.vehicle_no)}</td><td>${esc(t.product ?? '')}</td><td class="r">${n2(t.qty).toFixed(3)}</td><td class="r">${n2(t.shortage_qty).toFixed(3)}</td><td class="r">${n2(t.rtkm).toFixed(1)}</td><td class="r">${t.rate ? n2(t.rate).toFixed(4) : (n2(t.qty) * n2(t.rtkm) ? (n2(t.gross) / (n2(t.qty) * n2(t.rtkm))).toFixed(3) + '*' : '')}</td><td class="r">${num2(t.gross)}</td><td class="r">${num2(t.penalty)}</td><td class="r">${num2(t.tds)}</td><td class="r b">${num2(n2(t.gross) - n2(t.penalty) - n2(t.tds))}</td><td>${(FLAG[t.flag] ?? [t.flag])[0]}</td></tr>`;
        const s = blk.subtotal;
        body += `<tr class="sub"><td>Subtotal for Branch: ${esc(blk.branch_name)}</td><td colspan="2">${s.trips} trip</td><td class="r">${n2(s.qty).toFixed(3)}</td><td></td><td class="r">${n2(s.rtkm).toFixed(1)}</td><td></td><td class="r">${num2(s.gross)}</td><td class="r">${num2(s.penalty)}</td><td class="r">${num2(s.tds)}</td><td class="r b">${num2(n2(s.gross) - n2(s.penalty) - n2(s.tds))}</td><td></td></tr>`;
      }
      body = `<table><thead><tr><th>Invoice / Trip</th><th>Vehicle</th><th>Material</th><th>Qty (KL)</th><th>Short (KL)</th><th>RTKM</th><th>Rate</th><th>Gross</th><th>Penalty</th><th>TDS ${n2(b.tds_pct)}%</th><th>Net</th><th>Recon</th></tr></thead><tbody>${body}
        <tr class="grand"><td>Total of All Branches · ${b.branches} branch · ${b.trips} trip</td><td colspan="2"></td><td class="r">${n2(b.loaded_qty).toFixed(3)}</td><td></td><td class="r">${n2(b.rtkm).toFixed(1)}</td><td></td><td class="r">${num2(b.gross)}</td><td class="r">${num2(b.shortage_penalty)}</td><td class="r">${num2(b.tds)}</td><td class="r b">${num2(b.net_receivable)}</td><td></td></tr></tbody></table>
        <p class="note">GST ${n2(b.gst_pct)}% under RCM (memo ${num2(b.gst_memo)}) — payable by the recipient. * rate derived = gross ÷ (KL × RTKM). Vendor code ${esc(b.customer_code ?? '')}.</p>`;
    }
    w.document.write(`<html><head><title>${esc(b.bill_no)} — ${esc(b.customer_name)}</title><style>@page{size:A4 landscape;margin:10mm}body{font-family:system-ui,Segoe UI,sans-serif;color:#111;margin:14px;font-size:10.5px}h1{font-size:16px;margin:0}.sub{color:#555;margin:3px 0 10px;font-size:11px}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:3px 5px;vertical-align:top}th{background:#eee;font-size:9px;text-transform:uppercase}td.r{text-align:right;font-variant-numeric:tabular-nums}td.b{font-weight:700}small{color:#666;font-size:9px}
      tr.veh td{background:#f2f2f2;font-weight:700}tr.sub td{background:#f7f7f7;font-weight:700}tr.grand td{background:#e8e8e8;font-weight:800}.note{margin-top:10px;color:#555;font-size:9.5px}</style></head><body>
      <h1>${esc(b.company_name ?? b.operating_company ?? '')} — ${fmt === 'CONTRACT_RCM' ? 'Tax Invoice (Transportation Bill · RCM)' : fmt === 'MARKET_LR' ? 'Freight Bill' : 'Transportation Bill · 15-day'}</h1>
      <div class="sub">To: ${esc(b.customer_name)}${b.gst_no ? ' · GSTIN ' + esc(b.gst_no) : ''} · Bill ${esc(b.bill_no)} · ${esc(b.cycle_label)} · ${day(b.period_from)} → ${day(b.period_to)} · ${esc((STATUS[b.status] ?? [b.status])[0])}</div>
      ${body}</body></html>`);
    w.document.close(); w.focus(); w.print();
  };

  const kpi = (k, v, color) => (<div style={{ background: C.panel, padding: '11px 14px' }}><div style={{ fontSize: '10px', letterSpacing: '.1em', textTransform: 'uppercase', color: C.dim }}>{k}</div><div style={{ fontSize: '17px', fontWeight: 700, marginTop: '3px', color, fontVariantNumeric: 'tabular-nums' }}>{v}</div></div>);
  const money = (v, color = C.ink2, bold = false) => <span style={{ color: n2(v) === 0 ? C.zero : color, fontWeight: bold ? 700 : 400 }}>{n2(v) === 0 ? '0' : num2(v)}</span>;
  const thb = (side, align = 'left') => ({ padding: '7px 8px', textAlign: align, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.07em', whiteSpace: 'nowrap', borderBottom: `1px solid ${C.line}`, position: 'sticky', top: 0,
    background: side === 'i' ? 'rgba(47,227,155,.06)' : side === 'd' ? 'rgba(255,107,129,.06)' : 'rgba(10,16,36,.6)', color: side === 'i' ? '#5eead4' : side === 'd' ? '#ff8f9f' : C.dim });
  const tdb = (side, align = 'left', extra = {}) => ({ padding: '7px 8px', textAlign: align, whiteSpace: 'nowrap', borderBottom: '1px solid #1b2a4e', color: C.ink2, fontVariantNumeric: 'tabular-nums', verticalAlign: 'top',
    background: side === 'i' ? 'rgba(47,227,155,.05)' : side === 'd' ? 'rgba(255,107,129,.05)' : 'transparent', ...extra });
  const fold = { borderLeft: `2px solid ${C.line}` };

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,8,20,.84)', zIndex: 900, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '20px 12px', overflowY: 'auto', backdropFilter: 'blur(3px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(1520px, 100%)', background: '#0d1530', border: `1px solid ${C.line}`, borderRadius: '14px', overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,.6)', borderTop: `3px solid ${C.cust}` }}>
        {!b ? <p style={{ color: C.mut, padding: '24px' }}>{err || 'bill khul raha hai…'}</p> : (<>
          <div style={{ padding: '16px 20px', borderBottom: `1px solid ${C.line}`, display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '10.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: C.dim }}>15-Day Customer Bill · Review, Raise &amp; Reconcile</div>
              <div style={{ fontSize: '21px', fontWeight: 800, color: C.ink, marginTop: '2px' }}>{b.customer_name} <span style={{ fontSize: '13px', color: C.mut, fontWeight: 500 }}>{TYPE[b.customer_type] ?? ''}</span></div>
              <div style={{ fontSize: '12.5px', color: C.mut, marginTop: '2px' }}><span style={{ fontFamily: 'monospace', color: C.cust }}>{b.bill_no}</span> · {b.cycle_label} · {day(b.period_from)} → {day(b.period_to)} · {b.branches} branch · {b.trips} trip · books {b.company_name ?? b.operating_company ?? '—'}{b.gst_no ? ` · GSTIN ${b.gst_no}` : ''}{b.customer_code ? ` · vendor code ${b.customer_code}` : ''}</div>
              <div style={{ marginTop: '7px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <Pill status={b.status} />
                {locked && <span style={{ color: C.dim, fontSize: '11px' }}>🔒 raised {b.raised_by} · {day(b.raised_at)}</span>}
                {b.voucher_id && <span style={{ color: '#c4b5fd', fontSize: '11px' }}>📘 revenue posted</span>}
                {n2(b.revenue_posted_legacy) > 0 && <span style={{ color: C.dim, fontSize: '11px' }}>· {inr(b.revenue_posted_legacy)} pehle ke bill se posted</span>}
                {n2(b.unpriced_count) > 0 && <span style={{ color: C.crit, fontSize: '11px', fontWeight: 700 }}>⚠️ {b.unpriced_count} trip unpriced — raise nahi hoga</span>}
                {b.reopen_reason && !locked && <span style={{ color: C.warn, fontSize: '11px' }}>🔓 modify: {b.reopen_reason}</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <span onClick={() => setTab('BILL')} style={chip(tab === 'BILL')}>🧾 Bill</span>
              <span onClick={() => setTab('RECON')} style={chip(tab === 'RECON')}>🔁 Milaan{n2(b.missing_count) + n2(b.short_count) + n2(b.their_unmatched) > 0 ? ` (${n2(b.missing_count) + n2(b.short_count) + n2(b.their_unmatched)})` : ''}</span>
              <span style={{ width: '6px' }} />
              {locked ? <button onClick={reopen} disabled={busy} style={btn('warn', !busy)}>🔓 Modify</button>
                : <><button onClick={() => setEditing((v) => !v)} style={btn(editing ? 'warn' : 'cyan')}>{editing ? '✏️ Edit band' : '✏️ Edit'}</button>
                    <button onClick={save} disabled={busy || !dirty} style={btn(dirty ? 'solid' : 'plain', dirty && !busy)}>💾 Save</button></>}
              {locked && dirty && <button onClick={save} disabled={busy} style={btn('solid', !busy)}>💾 Save dispute</button>}
              <button onClick={refresh} disabled={busy} style={btn('plain', !busy)} title="advice ke baad flags taaza">🔄 Refresh</button>
              <button onClick={print} style={btn('plain')} title={`Format: ${b.print_format}`}>🖨️ Print / PDF · {b.print_format === 'CONTRACT_RCM' ? 'Tax Invoice' : b.print_format === 'MARKET_LR' ? 'LR bill' : 'Oil Co'}</button>
              <button onClick={whatsapp} style={btn('good')}>🟢 WhatsApp</button>
              <button onClick={email} disabled={busy} style={btn('plain', !busy)}>✉️ Email</button>
              {!locked && <button onClick={raise} disabled={busy || dirty} style={btn('good', !busy && !dirty)} title={dirty ? 'Pehle Save' : 'Sirf admin · revenue post + lock'}>✅ Approve &amp; Raise</button>}
              <button onClick={onClose} style={btn('plain')}>✕ Band karein</button>
            </div>
          </div>
          {err && <p style={{ color: C.crit, fontSize: '12.5px', margin: '10px 20px 0' }}>{err}</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '1px', background: C.line, borderBottom: `1px solid ${C.line}` }}>
            {kpi(`Gross (${b.trips} trip)`, inr2(b.gross), C.ink)}{kpi('Shortage penalty', inr2(b.shortage_penalty), n2(b.shortage_penalty) ? C.warn : C.dim)}
            {kpi(`TDS 194C ${n2(b.tds_pct)}%`, inr2(b.tds), C.ink2)}{kpi('Net receivable', inr2(b.net_receivable), C.ink)}
            {kpi('Vasool (advice se)', inr2(b.received), C.good)}{kpi('Baaki', inr2(b.balance), n2(b.balance) > 2 ? C.warn : C.good)}
            {kpi('Milaan', <span><Flag f="PAID" n={b.paid_count} /><Flag f="SHORT" n={b.short_count} /><Flag f="MISSING" n={b.missing_count} /><Flag f="PENDING" n={b.pending_count} /></span>, C.ink)}
          </div>

          {tab === 'BILL' && (<>
            <div style={{ margin: '12px 20px 0', overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px', maxHeight: '60vh', overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', minWidth: '1500px', width: '100%', fontSize: '12px' }}>
                <thead>
                  <tr><th rowSpan={2} style={{ ...thb('n'), minWidth: '180px' }}>Invoice / AC5 No<br /><span style={{ letterSpacing: 0, fontWeight: 500, textTransform: 'none' }}>trip · load → unload</span></th>
                    <th colSpan={7} style={{ ...thb('i', 'center'), letterSpacing: '.12em' }}>◀ FREIGHT (IOCL format — hamari aay)</th>
                    <th colSpan={4} style={{ ...thb('d', 'center'), ...fold, letterSpacing: '.12em' }}>KATAAUTI &amp; NET ▶</th><th rowSpan={2} style={thb('n')}>Milaan</th></tr>
                  <tr><th style={thb('i')}>Vehicle</th><th style={thb('i')}>Material</th><th style={thb('i', 'right')}>Qty (KL)</th><th style={thb('i', 'right')}>Short (KL)</th><th style={thb('i', 'right')}>RTKM</th><th style={thb('i', 'right')}>Rate</th><th style={thb('i', 'right')}>Gross</th>
                    <th style={{ ...thb('d', 'right'), ...fold }}>Penalty</th><th style={thb('d', 'right')}>TDS</th><th style={thb('d', 'right')}>Net</th><th style={thb('d', 'right')}>Vasool</th></tr>
                </thead>
                <tbody>
                  {blocks.map((blk) => {
                    const isOpen = !!open[blk.branch_key]; const s = blk.subtotal ?? {};
                    return (<React.Fragment key={blk.branch_key}>
                      <tr onClick={() => setOpen((o) => ({ ...o, [blk.branch_key]: !isOpen }))} style={{ cursor: 'pointer' }}>
                        <td colSpan={13} style={{ ...tdb('n'), background: C.raised, color: C.ink, fontWeight: 700, borderTop: `1px solid ${C.line}` }}>
                          {isOpen ? '▾' : '▸'} 📍 {blk.branch_code ? `${blk.branch_code} – ` : ''}{blk.branch_name}
                          <span style={{ fontWeight: 500, color: C.mut, fontSize: '11px', marginLeft: '8px' }}>branch{blk.confirmed ? ' ✓' : ' · confirm baaki'} · {s.trips} trip · {n2(s.qty).toFixed(3)} KL · gross {inr(s.gross)} · vasool {inr(s.received)}</span>
                        </td>
                      </tr>
                      {isOpen && blk.trips.map((t) => {
                        const rate = t.rate ? n2(t.rate).toFixed(4) : (n2(t.qty) * n2(t.rtkm) ? (n2(t.gross) / (n2(t.qty) * n2(t.rtkm))).toFixed(3) + '*' : '—');
                        const d = disputes.find((x) => x.trip_id === t.trip_id);
                        return (<tr key={t.trip_id}>
                          <td style={tdb('n')}><span style={{ fontFamily: 'monospace', color: t.iocl_bill_no ? C.cust : C.warn }}>{t.iocl_bill_no || t.trip_code}</span>
                            <div style={{ fontSize: '10.5px', color: C.dim }}>{t.iocl_bill_no ? t.trip_code + ' · ' : 'unka invoice no baaki · '}{dmy(t.loading_date)} → {dmy(t.unloading_date)}{t.legacy_bill ? ' · purana bill' : ''}</div></td>
                          <td style={tdb('i')}>{t.vehicle_no}</td><td style={tdb('i')}>{t.product ?? ''}</td>
                          <td style={tdb('i', 'right')}>{n2(t.qty).toFixed(3)}</td><td style={tdb('i', 'right')}>{money(t.shortage_qty, C.warn)}</td><td style={tdb('i', 'right')}>{n2(t.rtkm).toFixed(1)}</td>
                          <td style={tdb('i', 'right', { color: C.dim })}>{rate}</td><td style={tdb('i', 'right')}>{money(t.gross, C.ink)}</td>
                          <td style={{ ...tdb('d', 'right'), ...fold }}>{money(t.penalty, C.warn)}</td><td style={tdb('d', 'right')}>{money(t.tds)}</td>
                          <td style={tdb('d', 'right')}>{money(n2(t.gross) - n2(t.penalty) - n2(t.tds), C.ink)}</td><td style={tdb('d', 'right')}>{money(t.received, C.good)}</td>
                          <td style={tdb('n')}><Flag f={t.flag} />{t.their_bill_no && <span style={{ color: C.dim, fontSize: '10px' }}>{t.their_bill_no}</span>}
                            {d && <span style={{ color: C.crit, fontSize: '10px', fontWeight: 700 }}> · dispute {inr(d.amount)}</span>}
                            {['MISSING', 'SHORT'].includes(t.flag) && !d && <button onClick={() => dispute(t, t.flag)} style={{ ...btn('crit'), padding: '2px 7px', fontSize: '10px', marginLeft: '4px' }}>Dispute</button>}</td>
                        </tr>);
                      })}
                      <tr><td style={{ ...tdb('n'), background: 'rgba(24,36,74,.55)', color: C.ink, fontWeight: 700, borderBottom: `2px solid ${C.line}` }}>Subtotal for Branch: {blk.branch_name}</td>
                        <td style={{ ...tdb('i'), background: 'rgba(24,36,74,.55)', color: C.dim }} colSpan={2}>{s.trips} trip</td>
                        <td style={{ ...tdb('i', 'right'), background: 'rgba(24,36,74,.55)', fontWeight: 700 }}>{n2(s.qty).toFixed(3)}</td><td style={{ ...tdb('i'), background: 'rgba(24,36,74,.55)' }} />
                        <td style={{ ...tdb('i', 'right'), background: 'rgba(24,36,74,.55)', fontWeight: 700 }}>{n2(s.rtkm).toFixed(1)}</td><td style={{ ...tdb('i'), background: 'rgba(24,36,74,.55)' }} />
                        <td style={{ ...tdb('i', 'right'), background: 'rgba(24,36,74,.55)', fontWeight: 700 }}>{money(s.gross, C.ink, true)}</td>
                        <td style={{ ...tdb('d', 'right'), ...fold, background: 'rgba(24,36,74,.55)' }}>{money(s.penalty, C.warn, true)}</td><td style={{ ...tdb('d', 'right'), background: 'rgba(24,36,74,.55)' }}>{money(s.tds, C.ink2, true)}</td>
                        <td style={{ ...tdb('d', 'right'), background: 'rgba(24,36,74,.55)' }}>{money(n2(s.gross) - n2(s.penalty) - n2(s.tds), C.ink, true)}</td><td style={{ ...tdb('d', 'right'), background: 'rgba(24,36,74,.55)' }}>{money(s.received, C.good, true)}</td><td style={{ ...tdb('n'), background: 'rgba(24,36,74,.55)' }} /></tr>
                    </React.Fragment>);
                  })}
                  <tr><td style={{ ...tdb('n'), background: C.raised, color: C.ink, fontWeight: 800, fontSize: '13px', borderTop: `2px solid ${C.line}` }}>Total of All Branches · {b.branches} branch · {b.trips} trip</td>
                    <td style={{ ...tdb('i'), background: C.raised, borderTop: `2px solid ${C.line}` }} colSpan={2} /><td style={{ ...tdb('i', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{n2(b.loaded_qty).toFixed(3)}</td><td style={{ ...tdb('i'), background: C.raised, borderTop: `2px solid ${C.line}` }} />
                    <td style={{ ...tdb('i', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{n2(b.rtkm).toFixed(1)}</td><td style={{ ...tdb('i'), background: C.raised, borderTop: `2px solid ${C.line}` }} />
                    <td style={{ ...tdb('i', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{money(b.gross, C.ink, true)}</td>
                    <td style={{ ...tdb('d', 'right'), ...fold, background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.shortage_penalty, C.warn, true)}</td><td style={{ ...tdb('d', 'right'), background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.tds, C.ink2, true)}</td>
                    <td style={{ ...tdb('d', 'right'), background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.net_receivable, C.ink, true)}</td><td style={{ ...tdb('d', 'right'), background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.received, C.good, true)}</td><td style={{ ...tdb('n'), background: C.raised, borderTop: `2px solid ${C.line}` }} /></tr>
                </tbody>
              </table>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '14px', margin: '14px 20px 0' }}>
              <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '14px 16px' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '12.5px', color: C.mut }}>HISAAB — customer se kitna lena hai</h4>
                {[['Gross freight', `${b.trips} trip`, b.gross, C.ink], n2(b.adj_income) ? ['+ Anya aay (manual)', '', b.adj_income, C.ai] : null, ['− Shortage penalty', 'unloading par kataauti', b.shortage_penalty, C.warn],
                  [`− TDS 194C ${n2(b.tds_pct)}%`, 'TDS Receivable — hamara asset', b.tds, C.ink2], n2(b.adj_expense) ? ['− Manual kataauti', '', b.adj_expense, C.ai] : null,
                  [`GST ${n2(b.gst_pct)}% ${b.gst_mode}`, b.gst_mode === 'RCM' ? 'memo — customer bharta hai' : 'output tax', b.gst_memo, C.dim]].filter(Boolean).map((r) => (
                  <div key={r[0]} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', borderBottom: '1px solid #1b2a4e', fontSize: '13px' }}><span style={{ color: C.ink2 }}>{r[0]} <span style={{ color: C.dim, fontSize: '11px', marginLeft: '6px' }}>{r[1]}</span></span><span style={{ color: r[3], fontVariantNumeric: 'tabular-nums' }}>{inr2(r[2])}</span></div>))}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', marginTop: '4px', borderTop: `2px solid ${C.line}`, fontWeight: 800, fontSize: '15px' }}><span style={{ color: C.ink2 }}>Net receivable</span><span style={{ color: C.ink }}>{inr2(b.net_receivable)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', fontSize: '13px' }}><span style={{ color: C.ink2 }}>− Vasool (advice) <span style={{ color: C.dim, fontSize: '11px' }}>gross-basis, jaise pipeline likhta hai</span></span><span style={{ color: C.good }}>{inr2(b.received)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', fontWeight: 800, fontSize: '14px' }}><span style={{ color: C.ink2 }}>Baaki</span><span style={{ color: n2(b.balance) > 2 ? C.warn : C.good }}>{inr2(b.balance)}</span></div>
              </div>
              <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '14px 16px' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '12.5px', color: C.mut }}>{locked ? 'JO POST HUA (raise par)' : 'RAISE PAR YEH POST HOGA'} — {b.company_name ?? 'company'} ki books</h4>
                {(locked && Array.isArray(b.posted_lines) && b.posted_lines.length ? b.posted_lines : data.journal?.lines ?? []).length === 0
                  ? <div style={{ color: C.dim, fontSize: '12.5px' }}>{n2(b.revenue_posted_legacy) > 0 ? `Poora revenue ${inr(b.revenue_posted_legacy)} pehle ke bill (INV-…) se already posted — raise sirf lock karega.` : 'Post karne ko kuch nahi.'}</div>
                  : (locked && Array.isArray(b.posted_lines) && b.posted_lines.length ? b.posted_lines : data.journal.lines).map((l, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '30px 1fr auto', gap: '8px', padding: '5px 0', borderBottom: '1px solid #1b2a4e', fontSize: '12.5px' }}><span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '11px', color: C.dim }}>{l.dr_cr === 'DR' ? 'Dr' : 'Cr'}</span><span style={{ color: C.ink2 }}>{l.ledger}<div style={{ fontSize: '10.5px', color: C.dim }}>{l.group}</div></span><span style={{ color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{num2(l.amount)}</span></div>))}
                <div style={{ color: C.dim, fontSize: '11px', marginTop: '8px', lineHeight: 1.6 }}>
                  {n2(b.revenue_posted_legacy) > 0 && <>Pehle ke bill (INV-…) se {inr(b.revenue_posted_legacy)} already posted — dobara nahi. </>}
                  Vasool aane par advice pipeline post karta hai: Dr Bank · Dr TDS Receivable 194C · <b style={{ color: C.cust }}>Dr IOCL fleet card (CCMS diesel — owner ka niyam)</b> · Dr Toll · Dr Shortage &amp; Penalty · Cr Debtors: {b.customer_name}.
                </div>
              </div>
            </div>
            {(editing && !locked) && (
              <div style={{ margin: '12px 20px 0', padding: '10px 14px', border: '1px solid rgba(167,139,250,.35)', background: 'rgba(167,139,250,.05)', borderRadius: '10px' }}>
                <AdjEditor adj={adj} setAdj={setAdj} />
              </div>)}
            {!editing && adj.length > 0 && <div style={{ margin: '10px 20px 0', fontSize: '11.5px', color: C.ai }}>✏️ manual: {adj.map((a) => `${a.side === 'INCOME' ? '+' : '−'} ${a.label} ${inr(a.amount)}`).join(' · ')}</div>}
          </>)}

          {tab === 'RECON' && <Recon b={b} blocks={blocks} data={data} disputes={disputes} dispute={dispute} setDisputes={setDisputes} />}

          <div style={{ margin: '12px 20px 18px' }}>
            <label style={{ fontSize: '11px', color: C.mut }}>Note</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Kuch likhna ho to yahan…"
              style={{ width: '100%', background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '8px', color: C.ink, padding: '8px 10px', fontSize: '12.5px', marginTop: '4px', resize: 'vertical' }} />
          </div>
        </>)}
      </div>
    </div>
  );
}

function Recon({ b, blocks, data, disputes, dispute, setDisputes }) {
  const trips = blocks.flatMap((blk) => blk.trips.map((t) => ({ ...t, branch: blk.branch_name })));
  const bad = trips.filter((t) => ['MISSING', 'SHORT', 'PENDING'].includes(t.flag));
  const theirs = data?.their_unmatched ?? []; const adv = data?.advices ?? [];
  return (
    <div style={{ margin: '12px 20px 0' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '1px', background: C.line, border: `1px solid ${C.line}`, borderRadius: '10px', overflow: 'hidden', marginBottom: '12px' }}>
        {[['✅ Paid', `${b.paid_count} trip`, C.good], ['⚠️ Short-paid', `${b.short_count} · ${inr(b.short_amount)}`, C.warn], ['❌ Missing freight', `${b.missing_count} · ${inr(b.missing_amount)}`, C.crit],
          ['🕒 Pending', `${b.pending_count} · ${inr(b.pending_amount)}`, C.mut], ['❓ Unki line, hamara trip nahi', `${b.their_unmatched} · ${inr(b.their_unmatched_amount)}`, '#c4b5fd'],
          ['🧾 Kataauti (advice)', adv.length ? `CCMS ${inr(adv.reduce((n, a) => n + n2(a.ccms), 0))} · toll ${inr(adv.reduce((n, a) => n + n2(a.toll), 0))}` : '—', C.cust]].map((k) => (
          <div key={k[0]} style={{ background: C.panel, padding: '11px 14px' }}><div style={{ fontSize: '10px', letterSpacing: '.1em', textTransform: 'uppercase', color: C.dim }}>{k[0]}</div><div style={{ fontSize: '15px', fontWeight: 700, marginTop: '3px', color: k[2] }}>{k[1]}</div></div>))}
      </div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
        <table style={{ width: '100%', minWidth: '1100px', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead><tr><th style={th}>Hamara trip</th><th style={th}>Branch</th><th style={{ ...th, textAlign: 'right' }}>Hamara net</th><th style={th}>Unka bill (AC5)</th><th style={{ ...th, textAlign: 'right' }}>Vasool</th><th style={{ ...th, textAlign: 'right' }}>Antar</th><th style={th}>Jhanda</th><th style={th}>Karya</th></tr></thead>
          <tbody>
            {bad.length === 0 && <tr><td colSpan={8} style={{ ...td, color: C.good, textAlign: 'center' }}>Sab trip paid ✓</td></tr>}
            {bad.map((t) => { const net = n2(t.gross) - n2(t.penalty) - n2(t.tds); const d = disputes.find((x) => x.trip_id === t.trip_id);
              return (<tr key={t.trip_id}>
                <td style={td}><span style={{ fontFamily: 'monospace', color: C.cust }}>{t.trip_code}</span><div style={{ fontSize: '10.5px', color: C.dim }}>{t.vehicle_no} · {dmy(t.unloading_date)}</div></td>
                <td style={td}>{t.branch}</td><td style={tdR}>{num2(net)}</td>
                <td style={td}>{t.iocl_bill_no ? <span style={{ fontFamily: 'monospace' }}>{t.iocl_bill_no}</span> : <span style={{ color: C.crit }}>unke bill me nahi</span>}{t.their_bill_no && <div style={{ fontSize: '10.5px', color: C.dim }}>bill {t.their_bill_no}</div>}</td>
                <td style={{ ...tdR, color: n2(t.received) ? C.good : C.dim }}>{num2(t.received)}</td>
                <td style={{ ...tdR, color: C.crit }}>{t.flag === 'PENDING' ? '—' : num2(n2(t.received) - (n2(t.gross) - n2(t.penalty)))}</td>
                <td style={td}><Flag f={t.flag} /></td>
                <td style={td}>{d ? <span style={{ color: C.crit, fontSize: '11px' }}>dispute {inr(d.amount)} <span onClick={() => setDisputes((x) => x.filter((y) => y.trip_id !== t.trip_id))} style={{ cursor: 'pointer', color: C.dim }}>×</span></span>
                  : t.flag === 'PENDING' ? <span style={{ color: C.dim, fontSize: '11px' }}>agle advice ka intezaar</span>
                  : <button onClick={() => dispute(t, t.flag)} style={{ ...btn('crit'), padding: '3px 9px' }}>Dispute</button>}</td>
              </tr>); })}
            {theirs.map((m, i) => (<tr key={'m' + i}>
              <td style={{ ...td, color: C.dim }}>— koi trip nahi —</td><td style={td}>{m.ship_to_name ?? m.ship_to_code ?? ''}</td><td style={{ ...tdR, color: C.dim }}>—</td>
              <td style={td}><span style={{ fontFamily: 'monospace' }}>{m.bill_no}</span><div style={{ fontSize: '10.5px', color: C.dim }}>{m.vehicle_no_raw} · {day(m.trip_date)} · {m.match_status}</div></td>
              <td style={{ ...tdR, color: C.dim }}>—</td><td style={{ ...tdR, color: '#c4b5fd' }}>+{num2(m.gross_amt)}</td>
              <td style={td}><span style={{ fontSize: '10px', fontWeight: 800, borderRadius: '6px', padding: '2px 7px', background: 'rgba(167,139,250,.15)', color: '#c4b5fd' }}>❓ Unmatched</span></td>
              <td style={{ ...td, color: C.dim, fontSize: '11px' }}>Trip Management me trip banao / lorry-tareekh sudhaaro</td></tr>))}
          </tbody>
        </table>
      </div>
      {adv.length > 0 && (
        <div style={{ marginTop: '12px', overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
          <table style={{ width: '100%', minWidth: '900px', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead><tr><th style={th}>Advice (ODN)</th><th style={th}>Tareekh</th><th style={{ ...th, textAlign: 'right' }}>Freight</th><th style={{ ...th, textAlign: 'right' }}>TDS</th><th style={{ ...th, textAlign: 'right' }}>CCMS diesel → fleet card</th><th style={{ ...th, textAlign: 'right' }}>Toll</th><th style={{ ...th, textAlign: 'right' }}>Misc</th><th style={{ ...th, textAlign: 'right' }}>Anya aay</th><th style={{ ...th, textAlign: 'right' }}>Bank me aaya</th></tr></thead>
            <tbody>{adv.map((a) => (<tr key={a.odn}><td style={{ ...td, fontFamily: 'monospace', color: C.cust }}>{a.odn}</td><td style={td}>{day(a.advice_date)}</td><td style={tdR}>{num2(a.freight)}</td><td style={tdR}>{num2(a.tds)}</td><td style={{ ...tdR, color: C.cust }}>{num2(a.ccms)}</td><td style={tdR}>{num2(a.toll)}</td><td style={tdR}>{num2(a.misc)}</td><td style={tdR}>{num2(a.other_income)}</td><td style={{ ...tdR, color: C.good, fontWeight: 700 }}>{num2(a.remitted)}</td></tr>))}</tbody>
          </table>
          <p style={{ color: C.dim, fontSize: '11px', margin: '8px 10px', lineHeight: 1.6 }}>Owner ka niyam: CCMS diesel = IOCL hamara fleet card recharge karta hai → card ke khaate me (asset), kharch nahi; baaki bank me. Advice ka jo hissa is pakhwade ke bill ko chhoota hai wahi yahan (advice ek se zyada pakhwade ka ho sakta hai).</p>
        </div>)}
    </div>
  );
}

function AdjEditor({ adj, setAdj }) {
  const [label, setLabel] = useState(''); const [amount, setAmount] = useState(''); const [side, setSide] = useState('INCOME');
  const inp = { background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '6px', color: C.ink, padding: '4px 8px', fontSize: '11.5px' };
  const add = () => { const a = n2(amount); if (!label.trim() || !a) return; setAdj([...adj, { label: label.trim(), amount: a, side }]); setLabel(''); setAmount(''); };
  return (<div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
    {adj.map((a, i) => (<div key={i} style={{ display: 'flex', gap: '8px', fontSize: '11.5px' }}><span style={{ color: a.side === 'INCOME' ? C.good : C.crit, fontWeight: 700, minWidth: '80px' }}>{a.side === 'INCOME' ? '+ Aay (detention…)' : '− Kataauti'}</span><span style={{ color: C.ink, flex: 1 }}>{a.label}</span><span>{inr2(a.amount)}</span><span onClick={() => setAdj(adj.filter((_, j) => j !== i))} style={{ color: C.dim, cursor: 'pointer' }}>×</span></div>))}
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}><span style={{ color: '#c4b5fd', fontSize: '11px', fontWeight: 700 }}>✏️ Manual</span>
      <select value={side} onChange={(e) => setSide(e.target.value)} style={inp}><option value="INCOME">+ Aay (detention, anya)</option><option value="EXPENSE">− Kataauti</option></select>
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="kis cheez ka" style={{ ...inp, minWidth: '160px' }} /><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹" style={{ ...inp, width: '90px', textAlign: 'right' }} /><button onClick={add} style={btn('ai')}>+ Jodein</button></div>
  </div>);
}

// ══ THE MAPPING DESK ════════════════════════════════════════════════════════
function MappingDesk({ onChanged }) {
  const [d, setD] = useState(null); const [busy, setBusy] = useState(false); const [sel, setSel] = useState({});
  const load = useCallback(async () => { try { setD(await apiJson(`${API}/mapping-audit`)); } catch (e) { setD({ error: e.message }); } }, []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <p style={{ color: C.mut }}>Mapping desk khul raha hai…</p>;
  const customers = d.customers ?? [];
  const assign = async (g) => {
    const cid = sel[g.name + g.company]; if (!cid) return alert('Pehle customer chuniye.');
    setBusy(true); try { const j = await apiJson(`${API}/mapping/assign-customer`, { method: 'POST', body: JSON.stringify({ customer_id: cid, trip_ids: g.trip_ids, alias: g.name || null }) }); alert(`✅ ${j.assigned} trip → ${j.customer}${j.alias_saved ? ' · spelling yaad rakhi' : ''}`); await load(); onChanged?.(); } catch (e) { alert(`❌ ${e.message}`); } setBusy(false);
  };
  const confirm = async (br) => { setBusy(true); try { await apiJson(`${API}/mapping/branch-confirm`, { method: 'POST', body: JSON.stringify({ branch_id: br.id }) }); await load(); } catch (e) { alert(`❌ ${e.message}`); } setBusy(false); };
  const setCust = async (c, patch) => { setBusy(true); try { await apiJson(`${API}/customers/${c.id}`, { method: 'PATCH', body: JSON.stringify(patch) }); await load(); onChanged?.(); } catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Sirf admin' : e.message}`); } setBusy(false); };
  const sel1 = { background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '6px', color: C.ink, padding: '4px 6px', fontSize: '11.5px' };
  return (
    <div style={{ border: '1px solid rgba(255,178,36,.45)', background: 'rgba(255,178,36,.05)', borderRadius: '12px', padding: '14px 18px', marginBottom: '14px' }}>
      <b style={{ color: C.warn, fontSize: '14px' }}>⚖️ Mapping desk — jo aap tay karein, system anuman nahi lagata</b>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: '14px', marginTop: '10px' }}>
        <div>
          <div style={{ fontSize: '11px', color: C.mut, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '6px' }}>Trip bina customer / anjaan spelling ({(d.unknown_trips ?? []).length})</div>
          {(d.unknown_trips ?? []).length === 0 && <div style={{ color: C.good, fontSize: '12px' }}>Sab trip ka customer tay hai ✓</div>}
          {(d.unknown_trips ?? []).map((g) => (
            <div key={g.name + g.company} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '8px', alignItems: 'center', padding: '7px 10px', background: 'rgba(10,16,36,.55)', borderRadius: '8px', marginBottom: '5px', fontSize: '12px' }}>
              <div><b style={{ color: g.name ? C.warn : C.crit }}>{g.name || '(customer nahi)'}</b> <span style={{ color: C.dim }}>· {g.company} · {g.trips} trip · {day(g.first)}→{day(g.last)}{g.with_iocl_no ? ` · ${g.with_iocl_no} IOCL no` : ''}</span>
                <div style={{ fontSize: '10.5px', color: C.dim }}>{(g.locations ?? []).slice(0, 4).join(' · ')}{(g.locations ?? []).length > 4 ? ' …' : ''}</div></div>
              <select value={sel[g.name + g.company] ?? ''} onChange={(e) => setSel((s) => ({ ...s, [g.name + g.company]: e.target.value }))} style={sel1}><option value="">customer chuniye</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}</select>
              <button onClick={() => assign(g)} disabled={busy} style={btn('cust', !busy)}>Jodo</button>
            </div>))}
          <div style={{ fontSize: '11px', color: C.mut, textTransform: 'uppercase', letterSpacing: '.06em', margin: '12px 0 6px' }}>Customer master — prakaar · cycle · print · TDS · GST</div>
          {customers.map((c) => (
            <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr .6fr .7fr .6fr', gap: '6px', alignItems: 'center', padding: '6px 10px', background: 'rgba(10,16,36,.55)', borderRadius: '8px', marginBottom: '4px', fontSize: '11.5px' }}>
              <span style={{ color: C.ink, fontWeight: 700 }}>{c.customer_name}<div style={{ fontSize: '10px', color: C.dim, fontWeight: 400 }}>{c.customer_code ? `code ${c.customer_code}` : ''}{c.gst_no ? ` · ${c.gst_no}` : ''}</div></span>
              <select value={c.customer_type ?? ''} onChange={(e) => setCust(c, { customer_type: e.target.value })} style={{ ...sel1, borderColor: c.customer_type ? C.line : C.crit }}><option value="">prakaar?</option><option value="OIL_COMPANY">🛢 Oil Company</option><option value="CONTRACT">📜 Contract</option><option value="MARKET">🛒 Market</option></select>
              <select value={c.bill_cycle} onChange={(e) => setCust(c, { bill_cycle: e.target.value })} style={sel1}><option value="FORTNIGHT">15 din</option><option value="MONTH">Mahina</option><option value="PER_LOAD">Load-wise</option></select>
              <select value={c.print_format} onChange={(e) => setCust(c, { print_format: e.target.value })} style={sel1}><option value="OIL_CO">Print: Oil Co</option><option value="CONTRACT_RCM">Print: Tax Invoice RCM</option><option value="MARKET_LR">Print: LR bill</option></select>
              <input value={c.tds_pct_deducted} onChange={(e) => setCust(c, { tds_pct_deducted: e.target.value })} title="TDS % unka" style={{ ...sel1, width: '52px', textAlign: 'right' }} />
              <input defaultValue={c.contract_rate_per_kl ?? ''} onBlur={(e) => { if ((e.target.value || '') !== String(c.contract_rate_per_kl ?? '')) setCust(c, { contract_rate_per_kl: e.target.value }); }} placeholder="₹/KL" title="Contract ₹ per KL — jab trip par amount na ho to KL × rate (Aadhar 1500); oil company ke liye khali" style={{ ...sel1, width: '64px', textAlign: 'right', borderColor: c.customer_type === 'CONTRACT' && !c.contract_rate_per_kl ? C.crit : C.line }} />
              <select value={c.gst_mode} onChange={(e) => setCust(c, { gst_mode: e.target.value })} style={sel1}><option value="RCM">RCM</option><option value="FORWARD">GST</option><option value="EXEMPT">Exempt</option></select>
            </div>))}
        </div>
        <div>
          <div style={{ fontSize: '11px', color: C.mut, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '6px' }}>Branch — trip se seekhi, confirm kijiye ({(d.branches ?? []).filter((x) => x.source === 'LEARNED').length} baaki)</div>
          <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {(d.branches ?? []).map((br) => (
              <div key={br.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'center', padding: '5px 10px', background: 'rgba(10,16,36,.55)', borderRadius: '8px', marginBottom: '4px', fontSize: '11.5px' }}>
                <span><span style={{ color: C.dim }}>{br.customer_name.split(' ')[0]}</span> · <b style={{ color: C.ink }}>{br.branch_code ? `${br.branch_code} – ` : ''}{br.branch_name}</b> <span style={{ color: C.dim }}>· {br.trips} trip</span></span>
                {br.source === 'CONFIRMED' ? <span style={{ color: C.good, fontSize: '11px' }}>✓ {br.confirmed_by}</span> : <button onClick={() => confirm(br)} disabled={busy} style={{ ...btn('good'), padding: '3px 9px' }}>Confirm</button>}
              </div>))}
          </div>
          <div style={{ fontSize: '11px', color: C.mut, textTransform: 'uppercase', letterSpacing: '.06em', margin: '12px 0 6px' }}>Baaki baatein</div>
          {(d.rows ?? []).filter((r) => !['NO_CUSTOMER', 'UNKNOWN_NAME', 'BRANCH_UNCONFIRMED'].includes(r.finding)).map((r, i) => (
            <div key={i} style={{ fontSize: '11.5px', color: C.ink2, padding: '4px 0', borderBottom: '1px solid #1b2a4e' }}><b style={{ color: r.severity === 'HIGH' ? C.crit : C.warn }}>{r.finding}</b> · {r.subject} · {r.detail}{n2(r.amount) ? ` · ${inr(r.amount)}` : ''}</div>))}
        </div>
      </div>
    </div>
  );
}

function TaxSummary() {
  const [d, setD] = useState(null);
  useEffect(() => { apiJson(`${API}/tax-summary`).then(setD).catch((e) => setD({ error: e.message })); }, []);
  if (!d) return <p style={{ color: C.mut }}>GST/TDS…</p>;
  return (
    <div style={{ border: `1px solid rgba(56,189,248,.4)`, background: 'rgba(56,189,248,.05)', borderRadius: '12px', padding: '14px 18px', marginBottom: '14px' }}>
      <b style={{ color: C.cust, fontSize: '14px' }}>📊 GST / TDS — {d.from} → {d.to}</b>
      <div style={{ overflowX: 'auto', marginTop: '8px' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead><tr><th style={th}>Mahina</th><th style={th}>Customer</th><th style={th}>GST</th><th style={{ ...th, textAlign: 'right' }}>Bills</th><th style={{ ...th, textAlign: 'right' }}>Gross (taxable)</th><th style={{ ...th, textAlign: 'right' }}>GST RCM memo</th><th style={{ ...th, textAlign: 'right' }}>TDS expected</th><th style={{ ...th, textAlign: 'right' }}>Vasool</th></tr></thead>
        <tbody>{(d.rows ?? []).map((r, i) => (<tr key={i}><td style={td}>{r.month}</td><td style={td}>{r.customer_name}</td><td style={td}>{r.gst_mode}</td><td style={tdR}>{r.bills}</td><td style={tdR}>{num2(r.gross)}</td><td style={tdR}>{num2(r.gst_rcm_memo)}</td><td style={tdR}>{num2(r.tds_expected)}</td><td style={{ ...tdR, color: C.good }}>{num2(r.received)}</td></tr>))}</tbody></table></div>
      <div style={{ fontSize: '11.5px', color: C.ink2, marginTop: '8px' }}>TDS Receivable 194C posted (ledger): <b>{inr2(d.tds_receivable_posted)}</b>{d.tds_per_advices !== null ? <> · advice lines me TDS: <b>{inr2(d.tds_per_advices)}</b></> : null} · <span style={{ color: C.dim }}>{d.note}</span></div>
    </div>
  );
}

function LedgerAudit() {
  const [d, setD] = useState(null); const [busy, setBusy] = useState(false); const [card, setCard] = useState('');
  const load = useCallback(async () => { try { const j = await apiJson(`${API}/ledger-audit`); setD(j); if (!card) setCard(j.default_card ?? j.fleet_card_ledgers?.find((x) => /IOCL/i.test(x)) ?? j.fleet_card_ledgers?.[0] ?? ''); } catch (e) { setD({ error: e.message }); } }, [card]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <p style={{ color: C.mut }}>Ledger audit…</p>;
  const fix = async (customer) => {
    const NL = String.fromCharCode(10);
    if (!window.confirm(`${customer}:` + NL + `1) '${customer}' ledger ke credit → 'Debtors: ${customer}' me` + NL + `2) ADVICE ka CCMS diesel 'Fuel & HSD' se → '${card}' (fleet card asset) me` + NL + NL + 'Do correction journal (TARA, append-only, ek hi baar). Pakka?')) return;
    setBusy(true); try { const j = await apiJson(`${API}/ledger-audit/fix`, { method: 'POST', body: JSON.stringify({ customer_name: customer, fleet_card_ledger: card }) }); alert(j.posted.length ? '✅ ' + j.posted.map((p) => `${p.what} ${inr2(p.amount)}`).join(' · ') : 'Kuch post karne ko nahi tha.'); await load(); } catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Sirf admin' : e.message}`); } setBusy(false);
  };
  return (
    <div style={{ border: `1px solid rgba(255,107,129,.45)`, background: 'rgba(255,107,129,.05)', borderRadius: '12px', padding: '14px 18px', marginBottom: '14px' }}>
      <b style={{ color: C.crit, fontSize: '14px' }}>🧮 Ledger audit — customer ka khata ek hi hona chahiye</b>
      <div style={{ fontSize: '12px', color: C.ink2, margin: '6px 0 10px' }}>{d.rule}</div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead><tr><th style={th}>Customer</th><th style={{ ...th, textAlign: 'right' }}>"Debtors: X" balance (revenue yahan)</th><th style={{ ...th, textAlign: 'right' }}>"X" plain ledger balance (receipts yahan gaye)</th><th style={th}></th></tr></thead>
        <tbody>{(d.pairs ?? []).map((p) => (<tr key={p.customer_name}><td style={{ ...td, color: C.ink }}>{p.customer_name}</td><td style={tdR}>{num2(p.debtor_balance)}</td><td style={{ ...tdR, color: n2(p.plain_balance) !== 0 ? C.crit : C.dim }}>{num2(p.plain_balance)} <span style={{ color: C.dim }}>({p.plain_entries})</span></td>
          <td style={td}>{n2(p.plain_balance) !== 0 && <button onClick={() => fix(p.customer_name)} disabled={busy} style={{ ...btn('crit'), padding: '3px 9px' }}>Correction post karo</button>}</td></tr>))}</tbody></table>
      <div style={{ fontSize: '12px', color: C.ink2, marginTop: '10px' }}>CCMS diesel abhi 'Direct Expenses - Fuel & HSD' me (advice se): <b style={{ color: C.crit }}>{inr2(d.ccms?.fuel_expense_from_advices)}</b> ({d.ccms?.entries} entries) → fleet card:
        <select value={card} onChange={(e) => setCard(e.target.value)} style={{ background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '6px', color: C.ink, padding: '3px 6px', fontSize: '11.5px', marginLeft: '6px' }}>{(d.fleet_card_ledgers ?? []).map((l) => <option key={l} value={l}>{l}</option>)}</select></div>
      {(d.fixes ?? []).length > 0 && <div style={{ fontSize: '11.5px', color: C.good, marginTop: '8px' }}>Posted corrections: {d.fixes.map((f) => `${f.source_ref} ${inr(f.amount)} (${day(f.entry_date)})`).join(' · ')}</div>}
    </div>
  );
}
