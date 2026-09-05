// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// THE CUSTOMER 15-DAY BILL — branch-wise, IOCL-format core, trip-wise reconciliation
//
// Owner, 5-Sep-2026: one bill per customer × books × fortnight, every branch a
// block, every trip carrying the flag the payment advice earned it — PAID /
// SHORT / PENDING / MISSING / UNPRICED. A trip joins the fortnight it was
// UNLOADED in. Clean drafts are raised by the agent; the desk sees only the
// bills that need a decision ("Needs attention" is the default view). The
// customer's own bill or payment advice can be uploaded here as a PDF and is
// parsed straight into the reconciliation.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback, useRef } from 'react';
import GlobalPagination, { usePagination } from '../components/GlobalPagination';
import { sendWhatsApp } from '../lib/waSend';
import { API_BASE } from '../lib/apiBase';
import { useIsMobile } from '../hooks/useIsMobile';

const API = `${API_BASE}/api/v1/customer-bills`;
const apiJson = async (url, opts = {}) => {
  const res = await fetch(url, { ...opts, headers: { ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
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
  PAID: ['✅ Paid', C.good, 'rgba(47,227,155,.15)'], SHORT: ['⚠️ Short-paid', C.warn, 'rgba(255,178,36,.15)'],
  MISSING: ['❌ Missing', C.crit, 'rgba(255,107,129,.15)'], PENDING: ['🕒 Pending', C.mut, 'rgba(93,113,150,.2)'],
  UNPRICED: ['Unpriced', C.crit, 'rgba(255,107,129,.12)'],
};
const TYPE = { OIL_COMPANY: '🛢 Oil Company', CONTRACT: '📜 Contract', MARKET: '🛒 Market' };
const needsAttention = (b) => n2(b.missing_count) + n2(b.short_count) + n2(b.unpriced_count) + n2(b.their_unmatched) > 0 || b.status === 'DISPUTED';
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
const chip = (on) => ({ fontSize: '11px', fontWeight: 700, borderRadius: '999px', padding: '3px 9px', cursor: 'pointer', border: `1px solid ${on ? C.cyan : C.line}`, color: on ? C.cyan : C.mut, background: on ? 'rgba(34,211,238,.12)' : 'transparent', whiteSpace: 'nowrap' });
const th = { padding: '9px 10px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '.08em', color: C.dim, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap', background: 'rgba(10,16,36,.5)' };
const td = { padding: '9px 10px', borderBottom: '1px solid #1b2a4e', color: C.ink2, whiteSpace: 'nowrap', verticalAlign: 'top' };
const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
const inputStyle = { background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '8px', color: C.ink, padding: '6px 10px', fontSize: '12px' };

// ══ THE LIST ════════════════════════════════════════════════════════════════
export default function CustomerBills() {
  const { isPhone } = useIsMobile();
  const [data, setData] = useState({ rows: [], cards: [], cycles: [], totals: {}, audit: {} });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [cycle, setCycle] = useState('');            // '' = all cycles
  const [view, setView] = useState('ATTENTION');     // ATTENTION | ALL | <status>
  const [type, setType] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const [panel, setPanel] = useState('');            // '' | 'MAP' | 'TAX' | 'LEDGER' | 'UPLOAD'
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const qs = new URLSearchParams();
      if (cycle) qs.set('period_from', cycle);
      if (!['ATTENTION', 'ALL'].includes(view)) qs.set('status', view);
      if (type) qs.set('type', type);
      if (q.trim()) qs.set('q', q.trim());
      qs.set('limit', '500');
      setData(await apiJson(`${API}?${qs}`));
    } catch (e) { setErr(e?.message ?? 'Could not load the bill list'); }
    setLoading(false);
  }, [cycle, view, type, q]);
  useEffect(() => { load(); }, [load]);
  const rows = view === 'ATTENTION' ? data.rows.filter(needsAttention) : data.rows;
  const pg = usePagination(rows, { defaultSize: 12 });
  useEffect(() => { pg.setPage(1); }, [cycle, view, type, q]);

  const build = async (range) => {
    const NL = String.fromCharCode(10);
    setBusy(true);
    try {
      if (range) {
        if (!window.confirm('Draft or refresh every customer bill for every fortnight from 1 Apr 2026 to today?' + NL + 'Raised bills only take in newly received money.')) { setBusy(false); return; }
        const j = await apiJson(`${API}/build-range`, { method: 'POST', body: JSON.stringify({ from: '2026-04-01', to: new Date().toISOString().slice(0, 10) }) });
        const t = (j.periods ?? []).reduce((a, p) => ({ c: a.c + n2(p.created), r: a.r + n2(p.refreshed) }), { c: 0, r: 0 });
        alert(`🤖 TARA: ${j.periods?.length ?? 0} fortnights — ${t.c} new customer bills, ${t.r} refreshed.`);
      } else {
        const j = await apiJson(`${API}/build`, { method: 'POST', body: JSON.stringify({ period_from: cycle || new Date().toISOString().slice(0, 10) }) });
        alert(`🤖 ${j.created} new, ${j.refreshed} refreshed, ${j.skipped} already raised (money only).`);
      }
      await load();
    } catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Only an admin can build the whole year.' : (e?.message ?? 'Build failed')}`); }
    setBusy(false);
  };

  const T = data.totals; const A = data.audit ?? {};
  const attentionCount = data.rows.filter(needsAttention).length;
  return (
    <div style={{ padding: '4px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: '12px' }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, color: '#fff', fontSize: isPhone ? '17px' : '19px' }}>🧾 Customer 15-Day Bills</h3>
          {!isPhone && (
            <div style={{ color: C.mut, fontSize: '12.5px', marginTop: '3px', maxWidth: '92ch' }}>
              One bill per customer per fortnight, branch-wise in the IOCL layout. A trip joins the fortnight it was unloaded in. TARA drafts on the 1st and 16th,
              BHUVANESHWARI collects the customer's bills and payment advices from the mailbox, and every trip carries its flag — Paid / Short-paid / Missing / Pending.
              Clean bills are raised automatically; this list shows the ones that need a decision.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={() => setPanel(panel === 'UPLOAD' ? '' : 'UPLOAD')} style={btn(panel === 'UPLOAD' ? 'good' : 'plain')}>📎 Upload bill / advice PDF</button>
          <button onClick={() => setPanel(panel === 'MAP' ? '' : 'MAP')} style={btn(panel === 'MAP' ? 'warn' : 'plain')}>⚖️ Mapping desk{A.findings ? ` (${A.findings})` : ''}</button>
          <button onClick={() => setPanel(panel === 'TAX' ? '' : 'TAX')} style={btn(panel === 'TAX' ? 'cust' : 'plain')}>📊 GST / TDS</button>
          <button onClick={() => setPanel(panel === 'LEDGER' ? '' : 'LEDGER')} style={btn(panel === 'LEDGER' ? 'crit' : 'plain')}>🧮 Ledger audit</button>
          <button onClick={() => build(false)} disabled={busy} style={btn('ai', !busy)}>🤖 Build drafts</button>
          <button onClick={() => build(true)} disabled={busy} style={btn('ai', !busy)} title="admin">📅 Draft all since April</button>
        </div>
      </div>

      {panel === 'UPLOAD' && <UploadDesk onChanged={load} />}
      {panel === 'MAP' && <MappingDesk onChanged={load} />}
      {panel === 'TAX' && <TaxSummary />}
      {panel === 'LEDGER' && <LedgerAudit />}

      {/* cycles */}
      <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '8px', marginBottom: '6px' }}>
        <span onClick={() => setCycle('')} style={{ ...chip(cycle === ''), flex: 'none', alignSelf: 'center' }}>All cycles</span>
        {data.cycles.map((c) => (
          <button key={c.period_from + c.cycle_kind} onClick={() => setCycle(day(c.period_from))}
            style={{ flex: 'none', textAlign: 'left', minWidth: isPhone ? '150px' : '168px', cursor: 'pointer', background: cycle === day(c.period_from) ? 'rgba(56,189,248,.12)' : 'rgba(18,28,56,.5)',
                     border: `1px solid ${cycle === day(c.period_from) ? C.cust : C.line}`, borderRadius: '10px', padding: '8px 12px' }}>
            <div style={{ color: cycle === day(c.period_from) ? C.cust : C.ink, fontWeight: 700, fontSize: '12.5px' }}>{c.cycle_label}</div>
            <div style={{ color: C.dim, fontSize: '10.5px' }}>{c.bills} bills · {c.drafts} draft · {c.raised} raised · {c.paid} paid</div>
            <div style={{ color: n2(c.balance) > 0 ? C.warn : C.good, fontSize: '12px', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>balance {inr(c.balance)}{n2(c.missing) ? <span style={{ color: C.crit }}> · ❌ {c.missing}</span> : null}</div>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
        {[['ATTENTION', `⚠️ Needs attention${attentionCount ? ` (${attentionCount})` : ''}`], ['ALL', 'All'], ['AI_DRAFT', 'Draft'], ['STAFF_REVIEWED', 'Review'], ['RAISED', 'Raised'], ['PART_PAID', 'Part-paid'], ['PAID', 'Paid'], ['DISPUTED', 'Dispute']].map((s) => (
          <span key={s[0]} onClick={() => setView(s[0])} style={chip(view === s[0])}>{s[1]}</span>))}
        <span style={{ width: '8px' }} />
        {[['', 'All customers'], ['OIL_COMPANY', '🛢 Oil Company'], ['CONTRACT', '📜 Contract'], ['MARKET', '🛒 Market']].map((s) => (
          <span key={s[0]} onClick={() => setType(s[0])} style={chip(type === s[0])}>{s[1]}</span>))}
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer / bill no" style={{ ...inputStyle, width: isPhone ? '100%' : '180px' }} />
      </div>

      {/* customer cards */}
      {data.cards.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${isPhone ? '160px' : '210px'}, 1fr))`, gap: '10px', marginBottom: '14px' }}>
          {data.cards.slice(0, 6).map((c) => (
            <div key={c.customer_id} onClick={() => setQ(c.customer_name)} style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '11px 13px', cursor: 'pointer', minWidth: 0 }}>
              <div style={{ fontSize: '12px', color: C.ink2, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.customer_name}</div>
              <div style={{ fontSize: '20px', fontWeight: 800, marginTop: '2px', fontVariantNumeric: 'tabular-nums', color: n2(c.outstanding_raised) > 0 ? C.warn : n2(c.unpriced) > 0 ? C.crit : C.good }}>
                {n2(c.outstanding_raised) > 0 ? inr(c.outstanding_raised) : n2(c.unpriced) > 0 ? `${c.unpriced} unpriced` : c.bills ? 'fully received' : 'no bills'}
              </div>
              <div style={{ fontSize: '10.5px', color: C.dim, marginTop: '3px' }}>
                {TYPE[c.customer_type] ?? 'type not set'} · {c.bills} bills · gross {inr(c.gross)} · received {inr(c.received)}{n2(c.missing_count) ? <span style={{ color: C.crit }}> · ❌ {c.missing_count} missing {inr(c.missing_amount)}</span> : null} · {c.branches_confirmed}/{c.branches} branches ✓
              </div>
            </div>
          ))}
        </div>
      )}
      {err && <p style={{ color: C.crit, fontSize: '12.5px' }}>{err}</p>}

      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
        {loading ? <p style={{ color: C.warn, textAlign: 'center', padding: '26px' }}>Loading bills…</p>
        : rows.length === 0 ? <p style={{ color: view === 'ATTENTION' ? C.good : C.dim, textAlign: 'center', padding: '26px', fontSize: '13px' }}>
            {view === 'ATTENTION' ? '✅ Nothing needs attention — every bill in this view is clean. Choose "All" to see them.' : 'No bills — use "🤖 Build drafts" or "📅 Draft all since April". Trips without a customer are on the Mapping desk.'}
          </p>
        : (
          <table style={{ width: '100%', minWidth: '1180px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead><tr>
              <th style={th}>Bill No</th><th style={th}>Customer · books</th><th style={th}>Cycle</th>
              <th style={{ ...th, textAlign: 'right' }}>Branches</th><th style={{ ...th, textAlign: 'right' }}>Trips</th>
              <th style={{ ...th, textAlign: 'right' }}>Gross</th><th style={{ ...th, textAlign: 'right' }}>Shortage</th><th style={{ ...th, textAlign: 'right' }}>TDS</th>
              <th style={{ ...th, textAlign: 'right' }}>Net receivable</th><th style={{ ...th, textAlign: 'right' }}>Received</th><th style={{ ...th, textAlign: 'right' }}>Balance</th><th style={th}>Reconciliation</th><th style={th}>Status</th>
            </tr></thead>
            <tbody>
              {pg.slice.map((b) => (
                <tr key={b.id} onClick={() => setOpenId(b.id)} style={{ cursor: 'pointer' }}>
                  <td style={{ ...td, fontFamily: 'monospace', color: C.cust }}>{b.bill_no}</td>
                  <td style={{ ...td, color: C.ink, whiteSpace: 'normal', minWidth: '220px' }}>{b.customer_name}
                    <div style={{ fontSize: '10.5px', color: C.dim }}>{TYPE[b.customer_type] ?? '—'} · books of {b.company_name ?? b.operating_company ?? '(unknown)'}{b.customer_code ? ` · vendor code ${b.customer_code}` : ''}</div></td>
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
                    {n2(b.their_unmatched) > 0 && <span style={{ fontSize: '10px', color: '#c4b5fd', fontWeight: 800 }}>❓ {b.their_unmatched} unmatched</span>}
                  </td>
                  <td style={td}><Pill status={b.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {rows.length > 0 && <GlobalPagination {...pg} label="bills" />}
      <p style={{ color: C.dim, fontSize: '11px', marginTop: '10px', lineHeight: 1.6 }}>
        This view: gross {inr(T.gross)} · received {inr(T.received)} · balance {inr(T.balance)} · TDS {inr(T.tds)} · GST RCM memo {inr(T.gst_memo)} · ❌ missing {inr(T.missing)} · 🕒 pending {inr(T.pending)}.
        Bill no = customer initials + fortnight; a "-PT" / "-JE" tail marks a second firm's books. Received amounts come from the customer's payment advices — they are read here, never typed.
      </p>
      {openId && <BillDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
  );
}

// ══ UPLOAD THE CUSTOMER'S OWN DOCUMENT ══════════════════════════════════════
// The mailbox is the usual road; this is the hand-carried one. A transportation
// bill or a payment advice PDF goes through the same parser the mail sweep
// uses, lands in the same tables, and every affected bill re-reads its trips.
function UploadDesk({ onChanged }) {
  const [kind, setKind] = useState('BILL');
  const [firm, setFirm] = useState('prasad');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const ref = useRef(null);
  const send = async () => {
    if (!file) return alert('Choose a PDF first.');
    setBusy(true); setResult(null);
    try {
      const fd = new FormData(); fd.append('file', file); fd.append('kind', kind); fd.append('firm', firm);
      const j = await apiJson(`${API}/documents/upload`, { method: 'POST', body: fd });
      setResult(j); onChanged?.();
    } catch (e) { setResult({ error: e?.message ?? 'Upload failed' }); }
    setBusy(false);
  };
  return (
    <div style={{ border: '1px solid rgba(47,227,155,.45)', background: 'rgba(47,227,155,.05)', borderRadius: '12px', padding: '14px 18px', marginBottom: '14px' }}>
      <b style={{ color: C.good, fontSize: '14px' }}>📎 Upload the customer's bill or payment advice (PDF)</b>
      <div style={{ color: C.mut, fontSize: '12px', margin: '4px 0 10px', maxWidth: '90ch' }}>
        Manual reconciliation: the PDF is read by the same IOCL parser the mailbox sweep uses. A <b>transportation bill</b> adds its lines and matches them to trips;
        a <b>payment advice</b> is loaded, posted to the firm's books and marks the trips paid. Every affected 15-day bill then re-reads its trips.
      </div>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={kind} onChange={(e) => setKind(e.target.value)} style={inputStyle}><option value="BILL">Transportation bill (AC5)</option><option value="ADVICE">Payment advice</option></select>
        <select value={firm} onChange={(e) => setFirm(e.target.value)} style={inputStyle}><option value="prasad">Books: Prasad Transport</option><option value="jaiswal">Books: Jaiswal Enterprise</option></select>
        <input ref={ref} type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} style={{ color: C.ink2, fontSize: '12px' }} />
        <button onClick={send} disabled={busy || !file} style={btn('good', !busy && !!file)}>{busy ? '⏳ Reading…' : '📥 Read & reconcile'}</button>
      </div>
      {result && (
        <div style={{ marginTop: '10px', fontSize: '12.5px', color: result.error ? C.crit : C.ink2, whiteSpace: 'pre-wrap', fontFamily: result.error ? 'inherit' : 'monospace', maxHeight: '260px', overflowY: 'auto', background: 'rgba(10,16,36,.55)', borderRadius: '8px', padding: '10px 12px' }}>
          {result.error ? `❌ ${result.error}` : `${result.ok ? '✅' : '⚠️'} ${result.summary ?? ''}\n${result.tail ?? ''}`}
        </div>
      )}
    </div>
  );
}

// ══ ONE BILL ════════════════════════════════════════════════════════════════
function BillDrawer({ id, onClose, onChanged }) {
  const { isPhone } = useIsMobile();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adj, setAdj] = useState([]);
  const [disputes, setDisputes] = useState([]);
  const [notes, setNotes] = useState('');
  const [open, setOpen] = useState({});
  const [tab, setTab] = useState('BILL');

  const load = useCallback(async () => {
    setErr('');
    try {
      const j = await apiJson(`${API}/${id}`);
      setData(j); setNotes(j.bill?.notes ?? '');
      setAdj(Array.isArray(j.bill?.adjustments) ? j.bill.adjustments : []);
      setDisputes(Array.isArray(j.bill?.disputes) ? j.bill.disputes : []);
      const o = {}; (j.blocks ?? []).forEach((b, i) => { o[b.branch_key] = i < 3; }); setOpen(o);
      if (needsAttention(j.bill ?? {})) setTab('RECON');
    } catch (e) { setErr(e?.message ?? 'Could not open the bill'); }
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const h = (e) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [onClose]);

  const b = data?.bill; const blocks = data?.blocks ?? [];
  const locked = !!b?.locked_at;
  const dirty = b && (notes !== (b.notes ?? '') || JSON.stringify(adj) !== JSON.stringify(b.adjustments ?? []) || JSON.stringify(disputes) !== JSON.stringify(b.disputes ?? []));

  const save = async () => {
    setBusy(true); setErr('');
    try { await apiJson(`${API}/${id}`, { method: 'PATCH', body: JSON.stringify({ notes, adjustments: adj, disputes }) }); await load(); onChanged?.(); setEditing(false); }
    catch (e) { setErr(e?.message ?? 'Save failed'); }
    setBusy(false);
  };
  const raise = async () => {
    const NL = String.fromCharCode(10);
    if (n2(b.unpriced_count) > 0) return alert(`⚠️ ${b.unpriced_count} trip(s) have no rate or amount — price them in Pending Billing (quantity × rate), then raise.`);
    if (!window.confirm(`${b.customer_name} — ${b.cycle_label}` + NL + `Gross ${inr2(b.gross)} · net receivable ${inr2(b.net_receivable)}` + NL + NL
      + `Raise this bill? Revenue ${inr2(data.journal?.amount)} posts (Dr Debtors / Cr Freight Income)${n2(data.journal?.legacy) ? `; ${inr2(data.journal.legacy)} was already posted by earlier bills and is not repeated` : ''}. The bill locks; receipts keep arriving from the advices.`)) return;
    setBusy(true); setErr('');
    try { const j = await apiJson(`${API}/${id}/raise`, { method: 'POST' }); alert('📤 Raised.' + NL + (j.note ?? '')); await load(); onChanged?.(); }
    catch (e) { setErr(e?.code === 'FORBIDDEN' ? 'Only an admin can raise a bill.' : (e?.message ?? 'Raise failed')); }
    setBusy(false);
  };
  const reopen = async () => {
    const reason = window.prompt('Why modify? (a reason is required)', ''); if (!reason || reason.trim().length < 4) return;
    setBusy(true); try { await apiJson(`${API}/${id}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) }); await load(); onChanged?.(); setEditing(true); }
    catch (e) { setErr(e?.code === 'FORBIDDEN' ? 'Only an admin can modify.' : (e?.message ?? 'Could not reopen')); }
    setBusy(false);
  };
  const refresh = async () => { setBusy(true); try { await apiJson(`${API}/${id}/refresh`, { method: 'POST' }); await load(); onChanged?.(); } catch (e) { setErr(e?.message); } setBusy(false); };
  const whatsapp = async () => {
    try { const j = await apiJson(`${API}/${id}/summary-text`); const phone = window.prompt('Send to which number?', ''); if (!phone) return;
      const r = await sendWhatsApp({ phone, message: j.text, role: 'CUSTOMER' }); alert(r?.via === 'server' ? '🟢 Sent.' : '📱 WhatsApp opened.'); }
    catch (e) { alert(`❌ ${e?.message ?? ''}`); }
  };
  const email = async () => { const to = window.prompt('Send to which e-mail address?', ''); if (!to) return; setBusy(true); try { const j = await apiJson(`${API}/${id}/email`, { method: 'POST', body: JSON.stringify({ to }) }); alert(`✉️ Sent — ${j.to}`); } catch (e) { alert(`❌ ${e?.message ?? ''}`); } setBusy(false); };
  const dispute = (t, kind) => {
    const amount = kind === 'MISSING' ? n2(t.gross) : n2(t.gross) - n2(t.penalty) - n2(t.received);
    const note = window.prompt(`${t.trip_code} — ${kind === 'MISSING' ? 'not on the customer’s bill' : 'short-paid'} ${inr2(amount)}. Note:`, ''); if (note === null) return;
    setDisputes((d) => [...d.filter((x) => x.trip_id !== t.trip_id), { trip_id: t.trip_id, trip_code: t.trip_code, kind, amount, note }]);
  };

  const print = () => {
    if (!b) return;
    const w = window.open('', '_blank'); if (!w) return;
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const fmt = b.print_format ?? 'OIL_CO';
    let body = '';
    if (fmt === 'CONTRACT_RCM') {
      let i = 0;
      for (const blk of blocks) for (const t of blk.trips) { i += 1; body += `<tr><td>${i}</td><td>${esc(t.trip_code)}<br><small>${esc(t.vehicle_no)} · ${day(t.unloading_date)}</small></td><td>${esc(blk.branch_name)}</td><td class="r">${n2(t.qty).toFixed(3)}</td><td class="r">${t.rate ? n2(t.rate).toFixed(2) : (n2(t.qty) ? (n2(t.gross) / n2(t.qty)).toFixed(2) : '')}</td><td class="r">${num2(t.gross)}</td></tr>`; }
      const gstFoot = gstFooter(b, 5);
      body = `<table><thead><tr><th>Sl</th><th>CN / Trip</th><th>Destination</th><th>Qty (KL)</th><th>Rate</th><th>Amount</th></tr></thead><tbody>${body}</tbody>
        <tfoot><tr><td colspan="5" class="r">Taxable value (SAC ${esc(b.hsn_sac ?? '996791')})</td><td class="r b">${num2(b.gross)}</td></tr>
        ${gstFoot}</tfoot></table>
        <p class="note">${gstNote(b)} MSME registered. Detention, if any, on a separate annexure.</p>`;
    } else if (fmt === 'MARKET_LR') {
      for (const blk of blocks) for (const t of blk.trips) body += `<tr><td>${esc(t.trip_code)}</td><td>${day(t.loading_date)} → ${day(t.unloading_date)}</td><td>${esc(blk.branch_name)}</td><td>${esc(t.vehicle_no)}</td><td>${esc(t.product ?? '')} ${n2(t.qty) ? n2(t.qty).toFixed(3) : ''}</td><td class="r">${num2(t.gross)}</td></tr>`;
      body = `<table><thead><tr><th>LR / Trip</th><th>Dates</th><th>Destination</th><th>Truck</th><th>Material · Qty</th><th>Freight</th></tr></thead><tbody>${body}</tbody>
        <tfoot><tr><td colspan="5" class="r b">Total freight</td><td class="r b">${num2(b.gross)}</td></tr></tfoot></table>`;
    } else {
      for (const blk of blocks) {
        body += `<tr class="veh"><td colspan="12">${esc(blk.branch_code ? blk.branch_code + ' – ' : '')}${esc(blk.branch_name)} · ${blk.subtotal.trips} trips</td></tr>`;
        for (const t of blk.trips) body += `<tr><td>${esc(t.iocl_bill_no || t.trip_code)}<br><small>${esc(t.trip_code)} · ${day(t.loading_date)} → ${day(t.unloading_date)}</small></td><td>${esc(t.vehicle_no)}</td><td>${esc(t.product ?? '')}</td><td class="r">${n2(t.qty).toFixed(3)}</td><td class="r">${n2(t.shortage_qty).toFixed(3)}</td><td class="r">${n2(t.rtkm).toFixed(1)}</td><td class="r">${t.rate ? n2(t.rate).toFixed(4) : (n2(t.qty) * n2(t.rtkm) ? (n2(t.gross) / (n2(t.qty) * n2(t.rtkm))).toFixed(3) + '*' : '')}</td><td class="r">${num2(t.gross)}</td><td class="r">${num2(t.penalty)}</td><td class="r">${num2(t.tds)}</td><td class="r b">${num2(n2(t.gross) - n2(t.penalty) - n2(t.tds))}</td><td>${(FLAG[t.flag] ?? [t.flag])[0]}</td></tr>`;
        const s = blk.subtotal;
        body += `<tr class="sub"><td>Subtotal for Branch: ${esc(blk.branch_name)}</td><td colspan="2">${s.trips} trips</td><td class="r">${n2(s.qty).toFixed(3)}</td><td></td><td class="r">${n2(s.rtkm).toFixed(1)}</td><td></td><td class="r">${num2(s.gross)}</td><td class="r">${num2(s.penalty)}</td><td class="r">${num2(s.tds)}</td><td class="r b">${num2(n2(s.gross) - n2(s.penalty) - n2(s.tds))}</td><td></td></tr>`;
      }
      body = `<table><thead><tr><th>Invoice / Trip</th><th>Vehicle</th><th>Material</th><th>Qty (KL)</th><th>Short (KL)</th><th>RTKM</th><th>Rate</th><th>Gross</th><th>Penalty</th><th>TDS ${n2(b.tds_pct)}%</th><th>Net</th><th>Reconciliation</th></tr></thead><tbody>${body}
        <tr class="grand"><td>Total of All Branches · ${b.branches} branches · ${b.trips} trips</td><td colspan="2"></td><td class="r">${n2(b.loaded_qty).toFixed(3)}</td><td></td><td class="r">${n2(b.rtkm).toFixed(1)}</td><td></td><td class="r">${num2(b.gross)}</td><td class="r">${num2(b.shortage_penalty)}</td><td class="r">${num2(b.tds)}</td><td class="r b">${num2(b.net_receivable)}</td><td></td></tr></tbody></table>
        <p class="note">${gstNote(b)} * rate derived = gross ÷ (KL × RTKM). Vendor code ${esc(b.customer_code ?? '')}.</p>`;
    }
    w.document.write(`<html><head><title>${esc(b.bill_no)} — ${esc(b.customer_name)}</title><style>@page{size:A4 landscape;margin:10mm}body{font-family:system-ui,Segoe UI,sans-serif;color:#111;margin:14px;font-size:10.5px}h1{font-size:16px;margin:0}.sub{color:#555;margin:3px 0 10px;font-size:11px}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:3px 5px;vertical-align:top}th{background:#eee;font-size:9px;text-transform:uppercase}td.r{text-align:right;font-variant-numeric:tabular-nums}td.b{font-weight:700}small{color:#666;font-size:9px}
      tr.veh td{background:#f2f2f2;font-weight:700}tr.sub td{background:#f7f7f7;font-weight:700}tr.grand td{background:#e8e8e8;font-weight:800}.note{margin-top:10px;color:#555;font-size:9.5px}</style></head><body>
      <h1>${esc(b.company_name ?? b.operating_company ?? '')} — ${fmt === 'CONTRACT_RCM' ? 'Tax Invoice (Transportation Bill · RCM)' : fmt === 'MARKET_LR' ? 'Freight Bill' : 'Transportation Bill · 15-day'}</h1>
      <div class="sub">To: ${esc(b.customer_name)}${b.gst_no ? ' · GSTIN ' + esc(b.gst_no) : ''} · Bill ${esc(b.bill_no)}${b.gst_invoice_no ? ' · Tax invoice ' + esc(b.gst_invoice_no) : ''} · ${esc(b.cycle_label)} · ${day(b.period_from)} → ${day(b.period_to)} · ${esc((STATUS[b.status] ?? [b.status])[0])}</div>
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
  const pad = isPhone ? '10px' : '20px';

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(4,8,20,.84)', zIndex: 900, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: isPhone ? '6px' : '20px 12px', overflowY: 'auto', backdropFilter: 'blur(3px)' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(1520px, 100%)', background: '#0d1530', border: `1px solid ${C.line}`, borderRadius: '14px', overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,.6)', borderTop: `3px solid ${C.cust}` }}>
        {!b ? <p style={{ color: C.mut, padding: '24px' }}>{err || 'Opening bill…'}</p> : (<>
          <div style={{ padding: `16px ${pad}`, borderBottom: `1px solid ${C.line}`, display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '10.5px', letterSpacing: '.14em', textTransform: 'uppercase', color: C.dim }}>15-Day Customer Bill · Review, Raise &amp; Reconcile</div>
              <div style={{ fontSize: isPhone ? '17px' : '21px', fontWeight: 800, color: C.ink, marginTop: '2px' }}>{b.customer_name} <span style={{ fontSize: '13px', color: C.mut, fontWeight: 500 }}>{TYPE[b.customer_type] ?? ''}</span></div>
              <div style={{ fontSize: '12.5px', color: C.mut, marginTop: '2px' }}><span style={{ fontFamily: 'monospace', color: C.cust }}>{b.bill_no}</span> · {b.cycle_label} · {day(b.period_from)} → {day(b.period_to)} · {b.branches} branches · {b.trips} trips · books of {b.company_name ?? b.operating_company ?? '—'}{b.gst_no ? ` · GSTIN ${b.gst_no}` : ''}{b.customer_code ? ` · vendor code ${b.customer_code}` : ''}</div>
              <div style={{ marginTop: '7px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <Pill status={b.status} />
                {locked && <span style={{ color: C.dim, fontSize: '11px' }}>🔒 raised by {b.raised_by} · {day(b.raised_at)}</span>}
                {b.voucher_id && <span style={{ color: '#c4b5fd', fontSize: '11px' }}>📘 revenue posted</span>}
                {n2(b.revenue_posted_legacy) > 0 && <span style={{ color: C.dim, fontSize: '11px' }}>· {inr(b.revenue_posted_legacy)} posted by earlier bills</span>}
                {n2(b.unpriced_count) > 0 && <span style={{ color: C.crit, fontSize: '11px', fontWeight: 700 }}>⚠️ {b.unpriced_count} unpriced trip(s) — cannot raise</span>}
                {b.reopen_reason && !locked && <span style={{ color: C.warn, fontSize: '11px' }}>🔓 modified: {b.reopen_reason}</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <span onClick={() => setTab('BILL')} style={chip(tab === 'BILL')}>🧾 Bill</span>
              <span onClick={() => setTab('RECON')} style={chip(tab === 'RECON')}>🔁 Reconciliation{n2(b.missing_count) + n2(b.short_count) + n2(b.their_unmatched) > 0 ? ` (${n2(b.missing_count) + n2(b.short_count) + n2(b.their_unmatched)})` : ''}</span>
              <span style={{ width: '6px' }} />
              {locked ? <button onClick={reopen} disabled={busy} style={btn('warn', !busy)}>🔓 Modify</button>
                : <><button onClick={() => setEditing((v) => !v)} style={btn(editing ? 'warn' : 'cyan')}>{editing ? '✏️ Stop editing' : '✏️ Edit'}</button>
                    <button onClick={save} disabled={busy || !dirty} style={btn(dirty ? 'solid' : 'plain', dirty && !busy)}>💾 Save</button></>}
              {locked && dirty && <button onClick={save} disabled={busy} style={btn('solid', !busy)}>💾 Save dispute</button>}
              <button onClick={refresh} disabled={busy} style={btn('plain', !busy)} title="Re-read the trips after an advice">🔄 Refresh</button>
              <button onClick={print} style={btn('plain')} title={`Format: ${b.print_format}`}>🖨️ Print / PDF · {b.print_format === 'CONTRACT_RCM' ? 'Tax Invoice' : b.print_format === 'MARKET_LR' ? 'LR bill' : 'Oil Co'}</button>
              <button onClick={whatsapp} style={btn('good')}>🟢 WhatsApp</button>
              <button onClick={email} disabled={busy} style={btn('plain', !busy)}>✉️ Email</button>
              {!locked && <button onClick={raise} disabled={busy || dirty} style={btn('good', !busy && !dirty)} title={dirty ? 'Save first' : 'Admin only · posts revenue and locks'}>✅ Approve &amp; Raise</button>}
              <button onClick={onClose} style={btn('plain')}>✕ Close</button>
            </div>
          </div>
          {err && <p style={{ color: C.crit, fontSize: '12.5px', margin: `10px ${pad} 0` }}>{err}</p>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '1px', background: C.line, borderBottom: `1px solid ${C.line}` }}>
            {kpi(`Gross (${b.trips} trips)`, inr2(b.gross), C.ink)}{kpi('Shortage penalty', inr2(b.shortage_penalty), n2(b.shortage_penalty) ? C.warn : C.dim)}
            {kpi(`TDS 194C ${n2(b.tds_pct)}%`, inr2(b.tds), C.ink2)}{kpi('Net receivable', inr2(b.net_receivable), C.ink)}
            {kpi('Received (per advices)', inr2(b.received), C.good)}{kpi('Balance', inr2(b.balance), n2(b.balance) > 2 ? C.warn : C.good)}
            {kpi('Reconciliation', <span><Flag f="PAID" n={b.paid_count} /><Flag f="SHORT" n={b.short_count} /><Flag f="MISSING" n={b.missing_count} /><Flag f="PENDING" n={b.pending_count} /></span>, C.ink)}
          </div>

          {tab === 'BILL' && (<>
            <div style={{ margin: `12px ${pad} 0`, overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px', maxHeight: '60vh', overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', minWidth: '1500px', width: '100%', fontSize: '12px' }}>
                <thead>
                  <tr><th rowSpan={2} style={{ ...thb('n'), minWidth: '180px' }}>Invoice / AC5 No<br /><span style={{ letterSpacing: 0, fontWeight: 500, textTransform: 'none' }}>trip · loaded → unloaded</span></th>
                    <th colSpan={7} style={{ ...thb('i', 'center'), letterSpacing: '.12em' }}>◀ FREIGHT (IOCL format — our income)</th>
                    <th colSpan={4} style={{ ...thb('d', 'center'), ...fold, letterSpacing: '.12em' }}>DEDUCTIONS &amp; NET ▶</th><th rowSpan={2} style={thb('n')}>Reconciliation</th></tr>
                  <tr><th style={thb('i')}>Vehicle</th><th style={thb('i')}>Material</th><th style={thb('i', 'right')}>Qty (KL)</th><th style={thb('i', 'right')}>Short (KL)</th><th style={thb('i', 'right')}>RTKM</th><th style={thb('i', 'right')}>Rate</th><th style={thb('i', 'right')}>Gross</th>
                    <th style={{ ...thb('d', 'right'), ...fold }}>Penalty</th><th style={thb('d', 'right')}>TDS</th><th style={thb('d', 'right')}>Net</th><th style={thb('d', 'right')}>Received</th></tr>
                </thead>
                <tbody>
                  {blocks.map((blk) => {
                    const isOpen = !!open[blk.branch_key]; const s = blk.subtotal ?? {};
                    return (<React.Fragment key={blk.branch_key}>
                      <tr onClick={() => setOpen((o) => ({ ...o, [blk.branch_key]: !isOpen }))} style={{ cursor: 'pointer' }}>
                        <td colSpan={13} style={{ ...tdb('n'), background: C.raised, color: C.ink, fontWeight: 700, borderTop: `1px solid ${C.line}` }}>
                          {isOpen ? '▾' : '▸'} 📍 {blk.branch_code ? `${blk.branch_code} – ` : ''}{blk.branch_name}
                          <span style={{ fontWeight: 500, color: C.mut, fontSize: '11px', marginLeft: '8px' }}>branch{blk.confirmed ? ' ✓' : ' · confirmation pending'} · {s.trips} trips · {n2(s.qty).toFixed(3)} KL · gross {inr(s.gross)} · received {inr(s.received)}</span>
                        </td>
                      </tr>
                      {isOpen && blk.trips.map((t) => {
                        const rate = t.rate ? n2(t.rate).toFixed(4) : (n2(t.qty) * n2(t.rtkm) ? (n2(t.gross) / (n2(t.qty) * n2(t.rtkm))).toFixed(3) + '*' : '—');
                        const d = disputes.find((x) => x.trip_id === t.trip_id);
                        return (<tr key={t.trip_id}>
                          <td style={tdb('n')}><span style={{ fontFamily: 'monospace', color: t.iocl_bill_no ? C.cust : C.warn }}>{t.iocl_bill_no || t.trip_code}</span>
                            <div style={{ fontSize: '10.5px', color: C.dim }}>{t.iocl_bill_no ? t.trip_code + ' · ' : 'customer invoice no pending · '}{dmy(t.loading_date)} → {dmy(t.unloading_date)}{t.legacy_bill ? ' · earlier bill' : ''}</div></td>
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
                        <td style={{ ...tdb('i'), background: 'rgba(24,36,74,.55)', color: C.dim }} colSpan={2}>{s.trips} trips</td>
                        <td style={{ ...tdb('i', 'right'), background: 'rgba(24,36,74,.55)', fontWeight: 700 }}>{n2(s.qty).toFixed(3)}</td><td style={{ ...tdb('i'), background: 'rgba(24,36,74,.55)' }} />
                        <td style={{ ...tdb('i', 'right'), background: 'rgba(24,36,74,.55)', fontWeight: 700 }}>{n2(s.rtkm).toFixed(1)}</td><td style={{ ...tdb('i'), background: 'rgba(24,36,74,.55)' }} />
                        <td style={{ ...tdb('i', 'right'), background: 'rgba(24,36,74,.55)', fontWeight: 700 }}>{money(s.gross, C.ink, true)}</td>
                        <td style={{ ...tdb('d', 'right'), ...fold, background: 'rgba(24,36,74,.55)' }}>{money(s.penalty, C.warn, true)}</td><td style={{ ...tdb('d', 'right'), background: 'rgba(24,36,74,.55)' }}>{money(s.tds, C.ink2, true)}</td>
                        <td style={{ ...tdb('d', 'right'), background: 'rgba(24,36,74,.55)' }}>{money(n2(s.gross) - n2(s.penalty) - n2(s.tds), C.ink, true)}</td><td style={{ ...tdb('d', 'right'), background: 'rgba(24,36,74,.55)' }}>{money(s.received, C.good, true)}</td><td style={{ ...tdb('n'), background: 'rgba(24,36,74,.55)' }} /></tr>
                    </React.Fragment>);
                  })}
                  <tr><td style={{ ...tdb('n'), background: C.raised, color: C.ink, fontWeight: 800, fontSize: '13px', borderTop: `2px solid ${C.line}` }}>Total of All Branches · {b.branches} branches · {b.trips} trips</td>
                    <td style={{ ...tdb('i'), background: C.raised, borderTop: `2px solid ${C.line}` }} colSpan={2} /><td style={{ ...tdb('i', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{n2(b.loaded_qty).toFixed(3)}</td><td style={{ ...tdb('i'), background: C.raised, borderTop: `2px solid ${C.line}` }} />
                    <td style={{ ...tdb('i', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{n2(b.rtkm).toFixed(1)}</td><td style={{ ...tdb('i'), background: C.raised, borderTop: `2px solid ${C.line}` }} />
                    <td style={{ ...tdb('i', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{money(b.gross, C.ink, true)}</td>
                    <td style={{ ...tdb('d', 'right'), ...fold, background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.shortage_penalty, C.warn, true)}</td><td style={{ ...tdb('d', 'right'), background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.tds, C.ink2, true)}</td>
                    <td style={{ ...tdb('d', 'right'), background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.net_receivable, C.ink, true)}</td><td style={{ ...tdb('d', 'right'), background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.received, C.good, true)}</td><td style={{ ...tdb('n'), background: C.raised, borderTop: `2px solid ${C.line}` }} /></tr>
                </tbody>
              </table>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '14px', margin: `14px ${pad} 0` }}>
              <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '14px 16px' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '12.5px', color: C.mut }}>SETTLEMENT — receivable from the customer</h4>
                {[['Gross freight', `${b.trips} trips`, b.gross, C.ink], n2(b.adj_income) ? ['+ Other income (manual)', '', b.adj_income, C.ai] : null, ['− Shortage penalty', 'deducted at unloading', b.shortage_penalty, C.warn],
                  [`− TDS 194C ${n2(b.tds_pct)}%`, 'TDS Receivable — our asset', b.tds, C.ink2], n2(b.adj_expense) ? ['− Manual deductions', '', b.adj_expense, C.ai] : null,
                  [`GST ${n2(b.gst_pct)}% ${b.gst_treatment ?? b.gst_mode}`, (b.gst_treatment ?? b.gst_mode) === 'RCM' ? 'shown — paid by the customer under reverse charge, not in the receivable' : (b.gst_treatment ?? b.gst_mode) === 'FORWARD' ? 'charged — in the receivable' : 'exempt', n2(b.gst_amount) || b.gst_memo, C.dim]].filter(Boolean).map((r) => (
                  <div key={r[0]} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', borderBottom: '1px solid #1b2a4e', fontSize: '13px' }}><span style={{ color: C.ink2 }}>{r[0]} <span style={{ color: C.dim, fontSize: '11px', marginLeft: '6px' }}>{r[1]}</span></span><span style={{ color: r[3], fontVariantNumeric: 'tabular-nums' }}>{inr2(r[2])}</span></div>))}
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0 0', marginTop: '4px', borderTop: `2px solid ${C.line}`, fontWeight: 800, fontSize: '15px' }}><span style={{ color: C.ink2 }}>Net receivable</span><span style={{ color: C.ink }}>{inr2(b.net_receivable)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', fontSize: '13px' }}><span style={{ color: C.ink2 }}>− Received <span style={{ color: C.dim, fontSize: '11px' }}>per payment advices, gross basis</span></span><span style={{ color: C.good }}>{inr2(b.received)}</span></div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0 0', fontWeight: 800, fontSize: '14px' }}><span style={{ color: C.ink2 }}>Balance</span><span style={{ color: n2(b.balance) > 2 ? C.warn : C.good }}>{inr2(b.balance)}</span></div>
              </div>
              <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '14px 16px' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '12.5px', color: C.mut }}>{locked ? 'POSTED (on raise)' : 'POSTS ON RAISE'} — books of {b.company_name ?? 'the company'}</h4>
                {(locked && Array.isArray(b.posted_lines) && b.posted_lines.length ? b.posted_lines : data.journal?.lines ?? []).length === 0
                  ? <div style={{ color: C.dim, fontSize: '12.5px' }}>{n2(b.revenue_posted_legacy) > 0 ? `All revenue ${inr(b.revenue_posted_legacy)} was already posted by earlier bills (INV-…) — raising only locks the bill.` : 'Nothing to post.'}</div>
                  : (locked && Array.isArray(b.posted_lines) && b.posted_lines.length ? b.posted_lines : data.journal.lines).map((l, i) => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '30px 1fr auto', gap: '8px', padding: '5px 0', borderBottom: '1px solid #1b2a4e', fontSize: '12.5px' }}><span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '11px', color: C.dim }}>{l.dr_cr === 'DR' ? 'Dr' : 'Cr'}</span><span style={{ color: C.ink2 }}>{l.ledger}<div style={{ fontSize: '10.5px', color: C.dim }}>{l.group}</div></span><span style={{ color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{num2(l.amount)}</span></div>))}
                <div style={{ color: C.dim, fontSize: '11px', marginTop: '8px', lineHeight: 1.6 }}>
                  {n2(b.revenue_posted_legacy) > 0 && <>{inr(b.revenue_posted_legacy)} was already posted by earlier bills (INV-…) and is not repeated. </>}
                  When money arrives the advice pipeline posts: Dr Bank · Dr TDS Receivable 194C · <b style={{ color: C.cust }}>Dr IOCL fleet card wallet (CCMS diesel — owner's rule)</b> · Dr Toll · Dr Shortage &amp; Penalty · Cr Debtors: {b.customer_name}.
                </div>
              </div>
            </div>
            {(editing && !locked) && (
              <div style={{ margin: `12px ${pad} 0`, padding: '10px 14px', border: '1px solid rgba(167,139,250,.35)', background: 'rgba(167,139,250,.05)', borderRadius: '10px' }}>
                <AdjEditor adj={adj} setAdj={setAdj} />
              </div>)}
            {!editing && adj.length > 0 && <div style={{ margin: `10px ${pad} 0`, fontSize: '11.5px', color: C.ai }}>✏️ manual: {adj.map((a) => `${a.side === 'INCOME' ? '+' : '−'} ${a.label} ${inr(a.amount)}`).join(' · ')}</div>}
          </>)}

          {tab === 'RECON' && <Recon b={b} blocks={blocks} data={data} disputes={disputes} dispute={dispute} setDisputes={setDisputes} pad={pad} onSaved={async () => { await load(); onChanged?.(); }} />}

          <div style={{ margin: `12px ${pad} 18px` }}>
            <label style={{ fontSize: '11px', color: C.mut }}>Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Notes…"
              style={{ width: '100%', background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '8px', color: C.ink, padding: '8px 10px', fontSize: '12.5px', marginTop: '4px', resize: 'vertical' }} />
          </div>
        </>)}
      </div>
    </div>
  );
}

// Staff settle a trip by hand: the customer's invoice number, the penalty, a
// receipt the advice pipeline cannot see (cheque, missing advice) with its
// reference. Saved against the trip with who and when; clearing the amount
// hands the trip back to the advice.
function TripEditor({ billId, t, onSaved, onClose }) {
  const [f, setF] = useState({ iocl_bill_no: t.iocl_bill_no ?? '', shortage_penalty: t.penalty ?? '', received: t.manual_ref ? (t.received ?? '') : '', settled_on: '', reference: t.manual_ref ?? '', note: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const inp = { ...inputStyle, padding: '5px 8px', fontSize: '11.5px' };
  const save = async () => {
    setBusy(true); setErr('');
    try { await apiJson(`${API}/${billId}/trips/${t.trip_id}`, { method: 'PATCH', body: JSON.stringify(f) }); await onSaved?.(); onClose?.(); }
    catch (e) { setErr(e?.message ?? 'Save failed'); }
    setBusy(false);
  };
  return (
    <tr><td colSpan={8} style={{ ...td, whiteSpace: 'normal', background: 'rgba(56,189,248,.06)', borderLeft: `3px solid ${C.cust}` }}>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <b style={{ color: C.cust, fontSize: '12px', alignSelf: 'center' }}>✏️ {t.trip_code}</b>
        <label style={{ fontSize: '10.5px', color: C.dim }}>Customer invoice no<br /><input value={f.iocl_bill_no} onChange={(e) => setF({ ...f, iocl_bill_no: e.target.value })} placeholder="11024699AS26…" style={{ ...inp, width: '160px' }} /></label>
        <label style={{ fontSize: '10.5px', color: C.dim }}>Penalty ₹<br /><input value={f.shortage_penalty} onChange={(e) => setF({ ...f, shortage_penalty: e.target.value })} style={{ ...inp, width: '90px', textAlign: 'right' }} /></label>
        <label style={{ fontSize: '10.5px', color: C.dim }}>Received ₹ (manual)<br /><input value={f.received} onChange={(e) => setF({ ...f, received: e.target.value })} placeholder="blank = per advice" style={{ ...inp, width: '120px', textAlign: 'right' }} /></label>
        <label style={{ fontSize: '10.5px', color: C.dim }}>Received on<br /><input type="date" value={f.settled_on} onChange={(e) => setF({ ...f, settled_on: e.target.value })} style={inp} /></label>
        <label style={{ fontSize: '10.5px', color: C.dim }}>Reference (ODN / UTR / cheque)<br /><input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} style={{ ...inp, width: '160px' }} /></label>
        <label style={{ fontSize: '10.5px', color: C.dim, flex: 1, minWidth: '160px' }}>Note<br /><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} style={{ ...inp, width: '100%' }} /></label>
        <button onClick={save} disabled={busy} style={btn('solid', !busy)}>💾 Save</button>
        <button onClick={onClose} style={btn('plain')}>Cancel</button>
      </div>
      {err && <div style={{ color: C.crit, fontSize: '11.5px', marginTop: '6px' }}>{err}</div>}
      <div style={{ color: C.dim, fontSize: '10.5px', marginTop: '6px' }}>A manual received amount overrides the advice for this trip only and is recorded with your name. Leave it blank to keep the advice-derived figure.</div>
    </td></tr>
  );
}

function Recon({ b, blocks, data, disputes, dispute, setDisputes, pad, onSaved }) {
  const trips = blocks.flatMap((blk) => blk.trips.map((t) => ({ ...t, branch: blk.branch_name })));
  const [showAll, setShowAll] = useState(false);
  const [editId, setEditId] = useState(null);
  const bad = showAll ? trips : trips.filter((t) => ['MISSING', 'SHORT', 'PENDING'].includes(t.flag));
  const theirs = data?.their_unmatched ?? []; const adv = data?.advices ?? [];
  return (
    <div style={{ margin: `12px ${pad} 0` }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '8px', flexWrap: 'wrap' }}>
        <span onClick={() => setShowAll(false)} style={chip(!showAll)}>Problems only</span>
        <span onClick={() => setShowAll(true)} style={chip(showAll)}>All trips ({trips.length})</span>
        <span style={{ color: C.dim, fontSize: '11px' }}>Click ✏️ on a trip to set the customer's invoice number, the penalty, or record a receipt by hand.</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '1px', background: C.line, border: `1px solid ${C.line}`, borderRadius: '10px', overflow: 'hidden', marginBottom: '12px' }}>
        {[['✅ Paid', `${b.paid_count} trips`, C.good], ['⚠️ Short-paid', `${b.short_count} · ${inr(b.short_amount)}`, C.warn], ['❌ Missing freight', `${b.missing_count} · ${inr(b.missing_amount)}`, C.crit],
          ['🕒 Pending', `${b.pending_count} · ${inr(b.pending_amount)}`, C.mut], ['❓ Their line, no trip of ours', `${b.their_unmatched} · ${inr(b.their_unmatched_amount)}`, '#c4b5fd'],
          ['🧾 Deductions (per advice)', adv.length ? `CCMS ${inr(adv.reduce((n, a) => n + n2(a.ccms), 0))} · toll ${inr(adv.reduce((n, a) => n + n2(a.toll), 0))}` : '—', C.cust]].map((k) => (
          <div key={k[0]} style={{ background: C.panel, padding: '11px 14px' }}><div style={{ fontSize: '10px', letterSpacing: '.1em', textTransform: 'uppercase', color: C.dim }}>{k[0]}</div><div style={{ fontSize: '15px', fontWeight: 700, marginTop: '3px', color: k[2] }}>{k[1]}</div></div>))}
      </div>
      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
        <table style={{ width: '100%', minWidth: '1100px', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead><tr><th style={th}>Our trip</th><th style={th}>Branch</th><th style={{ ...th, textAlign: 'right' }}>Our net</th><th style={th}>Their bill (AC5)</th><th style={{ ...th, textAlign: 'right' }}>Received</th><th style={{ ...th, textAlign: 'right' }}>Difference</th><th style={th}>Flag</th><th style={th}>Action</th></tr></thead>
          <tbody>
            {bad.length === 0 && <tr><td colSpan={8} style={{ ...td, color: C.good, textAlign: 'center' }}>Every trip is paid ✓</td></tr>}
            {bad.map((t) => { const net = n2(t.gross) - n2(t.penalty) - n2(t.tds); const d = disputes.find((x) => x.trip_id === t.trip_id);
              return (<React.Fragment key={t.trip_id}><tr>
                <td style={td}><span style={{ fontFamily: 'monospace', color: C.cust }}>{t.trip_code}</span><div style={{ fontSize: '10.5px', color: C.dim }}>{t.vehicle_no} · {dmy(t.unloading_date)}{t.manual_ref ? ` · manual: ${t.manual_ref}` : ''}</div></td>
                <td style={td}>{t.branch}</td><td style={tdR}>{num2(net)}</td>
                <td style={td}>{t.iocl_bill_no ? <span style={{ fontFamily: 'monospace' }}>{t.iocl_bill_no}</span> : <span style={{ color: C.crit }}>not on their bill</span>}{t.their_bill_no && <div style={{ fontSize: '10.5px', color: C.dim }}>bill {t.their_bill_no}</div>}</td>
                <td style={{ ...tdR, color: n2(t.received) ? C.good : C.dim }}>{num2(t.received)}</td>
                <td style={{ ...tdR, color: C.crit }}>{t.flag === 'PENDING' ? '—' : num2(n2(t.received) - (n2(t.gross) - n2(t.penalty)))}</td>
                <td style={td}><Flag f={t.flag} /></td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  <button onClick={() => setEditId(editId === t.trip_id ? null : t.trip_id)} style={{ ...btn('cust'), padding: '3px 8px', marginRight: '4px' }} title="Set invoice no / penalty / manual receipt">✏️</button>
                  {d ? <span style={{ color: C.crit, fontSize: '11px' }}>dispute {inr(d.amount)} <span onClick={() => setDisputes((x) => x.filter((y) => y.trip_id !== t.trip_id))} style={{ cursor: 'pointer', color: C.dim }}>×</span></span>
                  : t.flag === 'PENDING' ? <span style={{ color: C.dim, fontSize: '11px' }}>awaiting the next advice</span>
                  : t.flag === 'PAID' ? null
                  : <button onClick={() => dispute(t, t.flag)} style={{ ...btn('crit'), padding: '3px 9px' }}>Dispute</button>}</td>
              </tr>
              {editId === t.trip_id && <TripEditor billId={b.id} t={t} onSaved={onSaved} onClose={() => setEditId(null)} />}
              </React.Fragment>); })}
            {theirs.map((m, i) => (<tr key={'m' + i}>
              <td style={{ ...td, color: C.dim }}>— no trip —</td><td style={td}>{m.ship_to_name ?? m.ship_to_code ?? ''}</td><td style={{ ...tdR, color: C.dim }}>—</td>
              <td style={td}><span style={{ fontFamily: 'monospace' }}>{m.bill_no}</span><div style={{ fontSize: '10.5px', color: C.dim }}>{m.vehicle_no_raw} · {day(m.trip_date)} · {m.match_status}</div></td>
              <td style={{ ...tdR, color: C.dim }}>—</td><td style={{ ...tdR, color: '#c4b5fd' }}>+{num2(m.gross_amt)}</td>
              <td style={td}><span style={{ fontSize: '10px', fontWeight: 800, borderRadius: '6px', padding: '2px 7px', background: 'rgba(167,139,250,.15)', color: '#c4b5fd' }}>❓ Unmatched</span></td>
              <td style={{ ...td, color: C.dim, fontSize: '11px' }}>Create the trip in Trip Management or correct the vehicle / date</td></tr>))}
          </tbody>
        </table>
      </div>
      {adv.length > 0 && (
        <div style={{ marginTop: '12px', overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
          <table style={{ width: '100%', minWidth: '900px', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead><tr><th style={th}>Advice (ODN)</th><th style={th}>Date</th><th style={{ ...th, textAlign: 'right' }}>Freight</th><th style={{ ...th, textAlign: 'right' }}>TDS</th><th style={{ ...th, textAlign: 'right' }}>CCMS diesel → fleet card</th><th style={{ ...th, textAlign: 'right' }}>Toll</th><th style={{ ...th, textAlign: 'right' }}>Misc</th><th style={{ ...th, textAlign: 'right' }}>Other income</th><th style={{ ...th, textAlign: 'right' }}>Remitted to bank</th></tr></thead>
            <tbody>{adv.map((a) => (<tr key={a.odn}><td style={{ ...td, fontFamily: 'monospace', color: C.cust }}>{a.odn}</td><td style={td}>{day(a.advice_date)}</td><td style={tdR}>{num2(a.freight)}</td><td style={tdR}>{num2(a.tds)}</td><td style={{ ...tdR, color: C.cust }}>{num2(a.ccms)}</td><td style={tdR}>{num2(a.toll)}</td><td style={tdR}>{num2(a.misc)}</td><td style={tdR}>{num2(a.other_income)}</td><td style={{ ...tdR, color: C.good, fontWeight: 700 }}>{num2(a.remitted)}</td></tr>))}</tbody>
          </table>
          <p style={{ color: C.dim, fontSize: '11px', margin: '8px 10px', lineHeight: 1.6 }}>Owner's rule: the CCMS diesel deduction is the customer recharging our fleet card — an asset, not an expense; the rest is remitted to the bank. Only the part of each advice that touches this fortnight's bill is shown (one advice can cover several fortnights).</p>
        </div>)}
    </div>
  );
}

function AdjEditor({ adj, setAdj }) {
  const [label, setLabel] = useState(''); const [amount, setAmount] = useState(''); const [side, setSide] = useState('INCOME');
  const inp = { background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '6px', color: C.ink, padding: '4px 8px', fontSize: '11.5px' };
  const add = () => { const a = n2(amount); if (!label.trim() || !a) return; setAdj([...adj, { label: label.trim(), amount: a, side }]); setLabel(''); setAmount(''); };
  return (<div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
    {adj.map((a, i) => (<div key={i} style={{ display: 'flex', gap: '8px', fontSize: '11.5px' }}><span style={{ color: a.side === 'INCOME' ? C.good : C.crit, fontWeight: 700, minWidth: '80px' }}>{a.side === 'INCOME' ? '+ Income (detention…)' : '− Deduction'}</span><span style={{ color: C.ink, flex: 1 }}>{a.label}</span><span>{inr2(a.amount)}</span><span onClick={() => setAdj(adj.filter((_, j) => j !== i))} style={{ color: C.dim, cursor: 'pointer' }}>×</span></div>))}
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}><span style={{ color: '#c4b5fd', fontSize: '11px', fontWeight: 700 }}>✏️ Manual</span>
      <select value={side} onChange={(e) => setSide(e.target.value)} style={inp}><option value="INCOME">+ Income (detention, other)</option><option value="EXPENSE">− Deduction</option></select>
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Description" style={{ ...inp, minWidth: '160px' }} /><input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹" style={{ ...inp, width: '90px', textAlign: 'right' }} /><button onClick={add} style={btn('ai')}>+ Add</button></div>
  </div>);
}

// ══ THE MAPPING DESK ════════════════════════════════════════════════════════
function MappingDesk({ onChanged }) {
  const [d, setD] = useState(null); const [busy, setBusy] = useState(false); const [sel, setSel] = useState({});
  const load = useCallback(async () => { try { setD(await apiJson(`${API}/mapping-audit`)); } catch (e) { setD({ error: e.message }); } }, []);
  useEffect(() => { load(); }, [load]);
  if (!d) return <p style={{ color: C.mut }}>Loading the mapping desk…</p>;
  const customers = d.customers ?? [];
  const assign = async (g) => {
    const cid = sel[g.name + g.company]; if (!cid) return alert('Choose a customer first.');
    setBusy(true); try { const j = await apiJson(`${API}/mapping/assign-customer`, { method: 'POST', body: JSON.stringify({ customer_id: cid, trip_ids: g.trip_ids, alias: g.name || null }) }); alert(`✅ ${j.assigned} trip(s) → ${j.customer}${j.alias_saved ? ' · spelling remembered' : ''}`); await load(); onChanged?.(); } catch (e) { alert(`❌ ${e.message}`); } setBusy(false);
  };
  const confirm = async (br) => { setBusy(true); try { await apiJson(`${API}/mapping/branch-confirm`, { method: 'POST', body: JSON.stringify({ branch_id: br.id }) }); await load(); } catch (e) { alert(`❌ ${e.message}`); } setBusy(false); };
  const setCust = async (c, patch) => { setBusy(true); try { await apiJson(`${API}/customers/${c.id}`, { method: 'PATCH', body: JSON.stringify(patch) }); await load(); onChanged?.(); } catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Admin only' : e.message}`); } setBusy(false); };
  const sel1 = { background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '6px', color: C.ink, padding: '4px 6px', fontSize: '11.5px' };
  return (
    <div style={{ border: '1px solid rgba(255,178,36,.45)', background: 'rgba(255,178,36,.05)', borderRadius: '12px', padding: '14px 18px', marginBottom: '14px' }}>
      <b style={{ color: C.warn, fontSize: '14px' }}>⚖️ Mapping desk — decided by you, never guessed by the system</b>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '14px', marginTop: '10px' }}>
        <div>
          <div style={{ fontSize: '11px', color: C.mut, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '6px' }}>Trips with no customer / unknown spelling ({(d.unknown_trips ?? []).length})</div>
          {(d.unknown_trips ?? []).length === 0 && <div style={{ color: C.good, fontSize: '12px' }}>Every trip has a customer ✓</div>}
          {(d.unknown_trips ?? []).map((g) => (
            <div key={g.name + g.company} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: '8px', alignItems: 'center', padding: '7px 10px', background: 'rgba(10,16,36,.55)', borderRadius: '8px', marginBottom: '5px', fontSize: '12px' }}>
              <div><b style={{ color: g.name ? C.warn : C.crit }}>{g.name || '(no customer)'}</b> <span style={{ color: C.dim }}>· {g.company} · {g.trips} trips · {day(g.first)}→{day(g.last)}{g.with_iocl_no ? ` · ${g.with_iocl_no} with IOCL no` : ''}</span>
                <div style={{ fontSize: '10.5px', color: C.dim }}>{(g.locations ?? []).slice(0, 4).join(' · ')}{(g.locations ?? []).length > 4 ? ' …' : ''}</div></div>
              <select value={sel[g.name + g.company] ?? ''} onChange={(e) => setSel((s) => ({ ...s, [g.name + g.company]: e.target.value }))} style={sel1}><option value="">choose customer</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}</select>
              <button onClick={() => assign(g)} disabled={busy} style={btn('cust', !busy)}>Link</button>
            </div>))}
          <div style={{ fontSize: '11px', color: C.mut, textTransform: 'uppercase', letterSpacing: '.06em', margin: '12px 0 6px' }}>Customer master — type · cycle · print · TDS % · contract ₹/KL · GST</div>
          {customers.map((c) => (
            <div key={c.id} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr .6fr .7fr .6fr', gap: '6px', alignItems: 'center', padding: '6px 10px', background: 'rgba(10,16,36,.55)', borderRadius: '8px', marginBottom: '4px', fontSize: '11.5px' }}>
              <span style={{ color: C.ink, fontWeight: 700 }}>{c.customer_name}<div style={{ fontSize: '10px', color: C.dim, fontWeight: 400 }}>{c.customer_code ? `code ${c.customer_code}` : ''}{c.gst_no ? ` · ${c.gst_no}` : ''}</div></span>
              <select value={c.customer_type ?? ''} onChange={(e) => setCust(c, { customer_type: e.target.value })} style={{ ...sel1, borderColor: c.customer_type ? C.line : C.crit }}><option value="">type?</option><option value="OIL_COMPANY">🛢 Oil Company</option><option value="CONTRACT">📜 Contract</option><option value="MARKET">🛒 Market</option></select>
              <select value={c.bill_cycle} onChange={(e) => setCust(c, { bill_cycle: e.target.value })} style={sel1}><option value="FORTNIGHT">15 days</option><option value="MONTH">Monthly</option><option value="PER_LOAD">Per load</option></select>
              <select value={c.print_format} onChange={(e) => setCust(c, { print_format: e.target.value })} style={sel1}><option value="OIL_CO">Print: Oil Co</option><option value="CONTRACT_RCM">Print: Tax Invoice RCM</option><option value="MARKET_LR">Print: LR bill</option></select>
              <input value={c.tds_pct_deducted} onChange={(e) => setCust(c, { tds_pct_deducted: e.target.value })} title="TDS % deducted by the customer" style={{ ...sel1, width: '52px', textAlign: 'right' }} />
              <input defaultValue={c.contract_rate_per_kl ?? ''} onBlur={(e) => { if ((e.target.value || '') !== String(c.contract_rate_per_kl ?? '')) setCust(c, { contract_rate_per_kl: e.target.value }); }} placeholder="₹/KL" title="Contract ₹ per KL — used as KL × rate when a trip carries no amount (Aadhar 1500); blank for oil companies" style={{ ...sel1, width: '64px', textAlign: 'right', borderColor: c.customer_type === 'CONTRACT' && !c.contract_rate_per_kl ? C.crit : C.line }} />
              <select value={c.gst_mode} onChange={(e) => setCust(c, { gst_mode: e.target.value })} style={sel1}><option value="RCM">RCM</option><option value="FORWARD">GST</option><option value="EXEMPT">Exempt</option></select>
            </div>))}
        </div>
        <div>
          <div style={{ fontSize: '11px', color: C.mut, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: '6px' }}>Branches learned from trips — please confirm ({(d.branches ?? []).filter((x) => x.source === 'LEARNED').length} pending)</div>
          <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {(d.branches ?? []).map((br) => (
              <div key={br.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px', alignItems: 'center', padding: '5px 10px', background: 'rgba(10,16,36,.55)', borderRadius: '8px', marginBottom: '4px', fontSize: '11.5px' }}>
                <span><span style={{ color: C.dim }}>{br.customer_name.split(' ')[0]}</span> · <b style={{ color: C.ink }}>{br.branch_code ? `${br.branch_code} – ` : ''}{br.branch_name}</b> <span style={{ color: C.dim }}>· {br.trips} trips</span></span>
                {br.source === 'CONFIRMED' ? <span style={{ color: C.good, fontSize: '11px' }}>✓ {br.confirmed_by}</span> : <button onClick={() => confirm(br)} disabled={busy} style={{ ...btn('good'), padding: '3px 9px' }}>Confirm</button>}
              </div>))}
          </div>
          <div style={{ fontSize: '11px', color: C.mut, textTransform: 'uppercase', letterSpacing: '.06em', margin: '12px 0 6px' }}>Other findings</div>
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
  if (!d) return <p style={{ color: C.mut }}>Loading GST / TDS…</p>;
  return (
    <div style={{ border: `1px solid rgba(56,189,248,.4)`, background: 'rgba(56,189,248,.05)', borderRadius: '12px', padding: '14px 18px', marginBottom: '14px' }}>
      <b style={{ color: C.cust, fontSize: '14px' }}>📊 GST / TDS — {d.from} → {d.to}</b>
      <div style={{ overflowX: 'auto', marginTop: '8px' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead><tr><th style={th}>Month</th><th style={th}>Customer</th><th style={th}>GST</th><th style={{ ...th, textAlign: 'right' }}>Bills</th><th style={{ ...th, textAlign: 'right' }}>Gross (taxable)</th><th style={{ ...th, textAlign: 'right' }}>GST RCM memo</th><th style={{ ...th, textAlign: 'right' }}>TDS expected</th><th style={{ ...th, textAlign: 'right' }}>Received</th></tr></thead>
        <tbody>{(d.rows ?? []).map((r, i) => (<tr key={i}><td style={td}>{r.month}</td><td style={td}>{r.customer_name}</td><td style={td}>{r.gst_mode}</td><td style={tdR}>{r.bills}</td><td style={tdR}>{num2(r.gross)}</td><td style={tdR}>{num2(r.gst_rcm_memo)}</td><td style={tdR}>{num2(r.tds_expected)}</td><td style={{ ...tdR, color: C.good }}>{num2(r.received)}</td></tr>))}</tbody></table></div>
      <div style={{ fontSize: '11.5px', color: C.ink2, marginTop: '8px' }}>TDS Receivable 194C posted (ledger): <b>{inr2(d.tds_receivable_posted)}</b>{d.tds_per_advices !== null ? <> · TDS on advice lines: <b>{inr2(d.tds_per_advices)}</b></> : null} · <span style={{ color: C.dim }}>{d.note}</span></div>
    </div>
  );
}

function LedgerAudit() {
  const [d, setD] = useState(null); const [busy, setBusy] = useState(false); const [card, setCard] = useState('');
  const load = useCallback(async () => { try { const j = await apiJson(`${API}/ledger-audit`); setD(j); if (!card) setCard(j.default_card ?? j.fleet_card_ledgers?.find((x) => /IOCL/i.test(x)) ?? j.fleet_card_ledgers?.[0] ?? ''); } catch (e) { setD({ error: e.message }); } }, [card]);
  useEffect(() => { load(); }, [load]);
  if (!d) return <p style={{ color: C.mut }}>Loading the ledger audit…</p>;
  const fix = async (customer) => {
    const NL = String.fromCharCode(10);
    if (!window.confirm(`${customer}:` + NL + `1) credits on the '${customer}' ledger → 'Debtors: ${customer}'` + NL + `2) CCMS diesel from ADVICE settlements: 'Fuel & HSD' → '${card}' (fleet card asset)` + NL + NL + 'Two correction journals (TARA, append-only, posted once). Continue?')) return;
    setBusy(true); try { const j = await apiJson(`${API}/ledger-audit/fix`, { method: 'POST', body: JSON.stringify({ customer_name: customer, fleet_card_ledger: card }) }); alert(j.posted.length ? '✅ ' + j.posted.map((p) => `${p.what} ${inr2(p.amount)}`).join(' · ') : 'Nothing to post.'); await load(); } catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Admin only' : e.message}`); } setBusy(false);
  };
  return (
    <div style={{ border: `1px solid rgba(255,107,129,.45)`, background: 'rgba(255,107,129,.05)', borderRadius: '12px', padding: '14px 18px', marginBottom: '14px' }}>
      <b style={{ color: C.crit, fontSize: '14px' }}>🧮 Ledger audit — one ledger per customer</b>
      <div style={{ fontSize: '12px', color: C.ink2, margin: '6px 0 10px' }}>{d.rule}</div>
      <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
        <thead><tr><th style={th}>Customer</th><th style={{ ...th, textAlign: 'right' }}>"Debtors: X" balance (revenue)</th><th style={{ ...th, textAlign: 'right' }}>"X" plain ledger balance (receipts)</th><th style={th}></th></tr></thead>
        <tbody>{(d.pairs ?? []).map((p) => (<tr key={p.customer_name}><td style={{ ...td, color: C.ink }}>{p.customer_name}</td><td style={tdR}>{num2(p.debtor_balance)}</td><td style={{ ...tdR, color: n2(p.plain_balance) !== 0 ? C.crit : C.dim }}>{num2(p.plain_balance)} <span style={{ color: C.dim }}>({p.plain_entries})</span></td>
          <td style={td}>{n2(p.plain_balance) !== 0 && <button onClick={() => fix(p.customer_name)} disabled={busy} style={{ ...btn('crit'), padding: '3px 9px' }}>Post correction</button>}</td></tr>))}</tbody></table></div>
      <div style={{ fontSize: '12px', color: C.ink2, marginTop: '10px' }}>CCMS diesel currently in 'Direct Expenses - Fuel & HSD' (from advices): <b style={{ color: C.crit }}>{inr2(d.ccms?.fuel_expense_from_advices)}</b> ({d.ccms?.entries} entries) → fleet card:
        <select value={card} onChange={(e) => setCard(e.target.value)} style={{ ...inputStyle, padding: '3px 6px', fontSize: '11.5px', marginLeft: '6px' }}>{(d.fleet_card_ledgers ?? []).map((l) => <option key={l} value={l}>{l}</option>)}</select></div>
      {(d.fixes ?? []).length > 0 && <div style={{ fontSize: '11.5px', color: C.good, marginTop: '8px' }}>Posted corrections: {d.fixes.map((f) => `${f.source_ref} ${inr(f.amount)} (${day(f.entry_date)})`).join(' · ')}</div>}
    </div>
  );
}

// GST on the printed bill (migration 171): the rows follow the customer's
// treatment — reverse charge shows the tax the recipient pays and keeps it
// out of the total payable to us; forward charge adds it; exempt says so.
function gstFooter(b, colspan) {
  const t = b.gst_treatment ?? b.gst_mode ?? 'RCM';
  const gst = n2(b.gst_amount) || n2(b.gst_memo);
  const inter = b.supply_type === 'INTER';
  const tag = t === 'RCM' ? ' (reverse charge)' : '';
  const pct = n2(b.gst_pct);
  let rows = '';
  if (t === 'EXEMPT') rows = `<tr><td colspan="${colspan}" class="r">GST</td><td class="r">Exempt — Notification 12/2017 entry 21A</td></tr>`;
  else if (inter) rows = `<tr><td colspan="${colspan}" class="r">IGST ${pct.toFixed(1)}%${tag}</td><td class="r">${num2(n2(b.igst) || gst)}</td></tr>`;
  else rows = `<tr><td colspan="${colspan}" class="r">CGST ${(pct / 2).toFixed(1)}%${tag}</td><td class="r">${num2(n2(b.cgst) || gst / 2)}</td></tr><tr><td colspan="${colspan}" class="r">SGST ${(pct / 2).toFixed(1)}%${tag}</td><td class="r">${num2(n2(b.sgst) || gst - gst / 2)}</td></tr>`;
  if (t === 'FORWARD') return rows + `<tr><td colspan="${colspan}" class="r b">Invoice total (incl. GST)</td><td class="r b">${num2(n2(b.invoice_value) || n2(b.gross) + gst)}</td></tr>`;
  if (t === 'RCM') return rows + `<tr><td colspan="${colspan}" class="r">Invoice value incl. GST (GST payable by the recipient)</td><td class="r">${num2(n2(b.gross) + gst)}</td></tr><tr><td colspan="${colspan}" class="r b">Amount payable to us (GST not added)</td><td class="r b">${num2(b.gross)}</td></tr>`;
  return rows + `<tr><td colspan="${colspan}" class="r b">Total</td><td class="r b">${num2(b.gross)}</td></tr>`;
}
function gstNote(b) {
  const t = b.gst_treatment ?? b.gst_mode ?? 'RCM';
  if (t === 'RCM') return `GST ${n2(b.gst_pct)}% payable by the recipient under reverse charge (Notification 13/2017-CT(R)) — shown for information, not added to this bill.`;
  if (t === 'FORWARD') return `GST ${n2(b.gst_pct)}% charged under forward charge and included in the invoice total.`;
  return 'GST exempt — service to an unregistered person (Notification 12/2017 entry 21A).';
}
