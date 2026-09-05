// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// THE 15-DAY VEHICLE BILL — one per owner, in the shape of the IOCL bill
//
// Owner, 5-Sep-2026 (design v2, approved from docs/mockups/
// vehicle-15day-bill-mock-v2.html): a bill list like Fuel Mgmt's "Settled
// 15-Day Bills", click → the whole bill. Expense columns on the LEFT (HSD ·
// Toll Tax · Trip Fooding Alw · Trip Fixed Alw · Trip Advance · Doc Exp ·
// Other Exp · Kul kharch), the IOCL bill details on the RIGHT (bill no,
// ship-to, KL, RTKM, rate, freight, shortage, net), every trip under its
// lorry, "Subtotal for Vehicle", commission + TDS per lorry, "Total of All
// Bills", and the foot: what the owner is owed and the journal Approve posts.
//
// Buttons: Edit · Save · Print/PDF · WhatsApp · Email · Approve & Post; after
// approval Modify (admin, with a reason) · Print · WhatsApp · Email.
//
// A typed expense on this screen is written to trip_expense_entries WITH the
// trip id (source BILL_DESK) — the bill is where it was keyed, the trip is
// where it lives. The lorry and the bill are recomputed from the register.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import GlobalPagination, { usePagination } from '../components/GlobalPagination';
import { sendWhatsApp } from '../lib/waSend';

const n2 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const inr = (v) => '₹' + n2(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inr2 = (v) => '₹' + n2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num2 = (v) => n2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => (d ? String(d).slice(0, 10) : '');
const dmy = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');

const C = {
  ink: '#eef2fd', ink2: '#c4d1ea', mut: '#9aadd4', dim: '#5d7196', line: '#27395f', raised: '#18244a',
  panel: '#121c38', cyan: '#22d3ee', good: '#2fe39b', crit: '#ff6b81', warn: '#ffb224', ai: '#a78bfa', zero: '#3d548a',
  mkt: '#f472b6',
};
const STATUS = {
  AI_DRAFT:       { t: '🤖 AI DRAFT', c: '#c4b5fd', b: 'rgba(167,139,250,0.5)' },
  STAFF_REVIEWED: { t: '📝 REVIEW',   c: '#ffb224', b: 'rgba(255,178,36,0.5)' },
  APPROVED:       { t: '✅ APPROVED 🔒', c: '#2fe39b', b: 'rgba(47,227,155,0.5)' },
};
const Pill = ({ status, extra }) => {
  const s = STATUS[status] ?? { t: status ?? '—', c: C.dim, b: C.line };
  return (
    <span style={{ display: 'inline-block', fontSize: '10px', fontWeight: 800, letterSpacing: '.05em',
                   borderRadius: '999px', padding: '2px 9px', border: `1px solid ${s.b}`, color: s.c, whiteSpace: 'nowrap' }}>
      {s.t}{extra}
    </span>
  );
};
const KINDS = [
  ['FOODING_ALLOWANCE', 'Trip Fooding Alw.'], ['FIXED_ALLOWANCE', 'Trip Fixed Alw.'],
  ['DOC_EXPENSE', 'Doc Exp'], ['OTHER_EXPENSE', 'Other Exp'],
];
const isAgency = (b) => ['ATTACHED', 'MARKET'].includes(b?.class_key);

const btn = (kind, on = true) => {
  const base = { font: 'inherit', fontWeight: 700, fontSize: '12px', borderRadius: '8px', padding: '7px 13px',
                 border: `1px solid ${C.line}`, background: 'transparent', color: C.mut, cursor: on ? 'pointer' : 'not-allowed',
                 whiteSpace: 'nowrap', opacity: on ? 1 : 0.5 };
  const v = {
    cyan:  { background: 'rgba(34,211,238,0.12)', borderColor: 'rgba(34,211,238,0.5)', color: C.cyan },
    good:  { background: 'rgba(47,227,155,0.10)', borderColor: 'rgba(47,227,155,0.55)', color: C.good },
    solid: { background: C.good, borderColor: C.good, color: '#0a1024' },
    warn:  { background: 'rgba(255,178,36,0.12)', borderColor: 'rgba(255,178,36,0.5)', color: C.warn },
    ai:    { background: 'rgba(167,139,250,0.14)', borderColor: 'rgba(167,139,250,0.5)', color: '#c4b5fd' },
    mkt:   { background: 'rgba(244,114,182,0.12)', borderColor: 'rgba(244,114,182,0.5)', color: '#f472b6' },
    plain: {},
  }[kind] ?? {};
  return { ...base, ...v };
};

// ══ THE LIST ════════════════════════════════════════════════════════════════
export default function OwnerBills({ api, apiJson, periodFrom, onNeedRate, onChanged }) {
  const [data, setData] = useState({ rows: [], cards: [], cycles: [], totals: {} });
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [status, setStatus] = useState('');
  const [cls, setCls] = useState('');
  const [owner, setOwner] = useState('');
  const [onlyCycle, setOnlyCycle] = useState(true);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const qs = new URLSearchParams();
      if (onlyCycle && periodFrom) qs.set('period_from', periodFrom);
      if (status) qs.set('status', status);
      if (cls) qs.set('class', cls);
      if (owner.trim()) qs.set('owner', owner.trim());
      const j = await apiJson(`${api}?${qs}`);
      setData({ rows: j.rows ?? [], cards: j.cards ?? [], cycles: j.cycles ?? [], totals: j.totals ?? {} });
    } catch (e) { setErr(e?.message ?? 'bill list nahi aayi'); }
    setLoading(false);
  }, [api, apiJson, periodFrom, status, cls, owner, onlyCycle]);
  useEffect(() => { load(); }, [load]);

  const pg = usePagination(data.rows, { defaultSize: 12 });
  useEffect(() => { pg.setPage(1); }, [periodFrom, status, cls, owner, onlyCycle]);

  // The historical run — every fortnight from 1 Apr to today. Admin on the
  // server; anyone can press it and be told.
  const buildAll = async () => {
    const NL = String.fromCharCode(10);
    if (!window.confirm('1 Apr 2026 se aaj tak har pakhwade ke bill draft banayein / refresh karein?' + NL
      + 'Review ya approve kiye hue bill ko haath nahi lagega.')) return;
    setBusy(true);
    try {
      const j = await apiJson(`${api}/build-range`, {
        method: 'POST', body: JSON.stringify({ from: '2026-04-01', to: new Date().toISOString().slice(0, 10) }),
      });
      const tot = (j.periods ?? []).reduce((a, p) => ({ bills: a.bills + n2(p.bills), c: a.c + n2(p.created), r: a.r + n2(p.refreshed) }), { bills: 0, c: 0, r: 0 });
      alert(`🤖 TARA ne ${j.periods?.length ?? 0} pakhwade dekhe: ${tot.bills} bill, ${tot.c} naye lorry draft, ${tot.r} refresh.`);
      await load(); onChanged?.();
    } catch (e) { alert(`❌ ${e?.code === 'FORBIDDEN' ? 'Sirf admin poora saal bana sakte hain.' : (e?.message ?? 'nahi bana')}`); }
    setBusy(false);
  };

  const th = { padding: '9px 10px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.08em',
               color: C.dim, borderBottom: `1px solid ${C.line}`, whiteSpace: 'nowrap', background: 'rgba(10,16,36,0.5)' };
  const td = { padding: '9px 10px', borderBottom: '1px solid #1b2a4e', color: C.ink2, whiteSpace: 'nowrap', verticalAlign: 'top' };
  const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const chip = (on) => ({ fontSize: '11px', fontWeight: 700, borderRadius: '999px', padding: '3px 9px', cursor: 'pointer',
                          border: `1px solid ${on ? C.cyan : C.line}`, color: on ? C.cyan : C.mut,
                          background: on ? 'rgba(34,211,238,0.12)' : 'transparent' });
  const T = data.totals;

  return (
    <div className="glass-card" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: '12px' }}>
        <div>
          <h3 style={{ margin: 0, color: '#fff', fontSize: '19px' }}>🧾 Vehicle 15-Day Bills</h3>
          <div style={{ color: C.mut, fontSize: '12.5px', marginTop: '3px' }}>
            Har malik ka ek bill, IOCL format me — click karein, poora bill khulega. TARA har 1 aur 16 tareekh
            03:00 baje draft banati hai; desk sudhaarta hai, admin approve karke owner ke khaate me post karta hai.
          </div>
        </div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          <span onClick={() => setOnlyCycle(true)} style={chip(onlyCycle)}>Sirf yeh cycle</span>
          <span onClick={() => setOnlyCycle(false)} style={chip(!onlyCycle)}>Sab cycles</span>
          <span style={{ width: '6px' }} />
          {[['', 'Sab'], ['AI_DRAFT', `Draft ${T.drafts ?? 0}`], ['STAFF_REVIEWED', `Review ${T.reviewed ?? 0}`], ['APPROVED', `Approved ${T.approved ?? 0}`]].map((s) => (
            <span key={s[0]} onClick={() => setStatus(s[0])} style={chip(status === s[0])}>{s[1]}</span>
          ))}
          <span style={{ width: '6px' }} />
          {[['', 'Sab'], ['AGENCY', 'Attached'], ['OWN', 'Apni gaadi'], ['MARKET', '🛒 Market (fleet partner)']].map((s) => (
            <span key={s[0]} onClick={() => setCls(s[0])} style={chip(cls === s[0])}>{s[1]}</span>
          ))}
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="malik / bill no khojein"
            style={{ background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '8px', color: C.ink, padding: '6px 10px', fontSize: '12px', width: '190px' }} />
          <button onClick={buildAll} disabled={busy} style={btn('ai', !busy)} title="1 Apr 2026 se aaj tak, admin">
            {busy ? '⏳ ban raha hai…' : '📅 Apr se ab tak sab draft'}
          </button>
        </div>
      </div>

      {/* owner cards — what each is owed on approved bills, what is still in draft */}
      {data.cards.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', margin: '0 0 14px' }}>
          {data.cards.slice(0, 6).map((c) => {
            const agency = ['ATTACHED', 'MARKET'].includes(c.class_key);
            const owed = n2(c.approved_payable);
            return (
              <div key={c.owner_key + c.class_key} onClick={() => setOwner(c.owner_name)} title="Is malik ke bill dikhayein"
                style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '11px 13px', cursor: 'pointer', minWidth: 0 }}>
                <div style={{ fontSize: '12px', color: C.ink2, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {c.owner_name}{!agency && <span style={{ color: C.dim, fontWeight: 500 }}> · apni gaadi</span>}
                </div>
                <div style={{ fontSize: '21px', fontWeight: 800, marginTop: '2px', fontVariantNumeric: 'tabular-nums',
                              color: !agency ? C.good : n2(c.needs_rate) > 0 && !owed ? C.dim : owed > 0 ? C.warn : C.good }}>
                  {!agency ? 'P&L' : owed > 0 ? inr(owed) : n2(c.needs_rate) > 0 ? 'rate nahi' : inr(c.pending_payable)}
                </div>
                <div style={{ fontSize: '10.5px', color: C.dim, marginTop: '3px' }}>
                  {agency
                    ? `${c.approved} approved · dena ${inr(owed)} · draft me ${inr(c.pending_payable)}${n2(c.needs_rate) > 0 ? ` · ${c.needs_rate} lorry bina rate` : ''}`
                    : `${c.bills} bill · freight ${inr(c.freight)} · kamai ${inr(c.our_earning)}`}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {err && <p style={{ color: C.crit, fontSize: '12.5px' }}>{err}</p>}

      <div style={{ overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px' }}>
        {loading ? (
          <p style={{ color: C.warn, textAlign: 'center', padding: '26px' }}>Bill khul rahe hain…</p>
        ) : data.rows.length === 0 ? (
          <p style={{ color: C.dim, textAlign: 'center', padding: '26px', fontSize: '13px' }}>
            Koi bill nahi — upar "🤖 Draft banayein" ya "📅 Apr se ab tak sab draft" dabaiye.
          </p>
        ) : (
          <table style={{ width: '100%', minWidth: '1080px', borderCollapse: 'collapse', fontSize: '12.5px' }}>
            <thead>
              <tr>
                <th style={th}>Bill No</th><th style={th}>Malik / Partner</th><th style={th}>Cycle</th>
                <th style={{ ...th, textAlign: 'right' }}>Lorry / Truck</th><th style={{ ...th, textAlign: 'right' }}>Trip / Load</th>
                <th style={{ ...th, textAlign: 'right' }}>Freight</th><th style={{ ...th, textAlign: 'right' }}>Kul kharch / Partner freight</th>
                <th style={{ ...th, textAlign: 'right' }}>Commission / Margin</th><th style={{ ...th, textAlign: 'right' }}>TDS</th>
                <th style={{ ...th, textAlign: 'right' }}>Payable</th><th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {pg.slice.map((b) => {
                const agency = isAgency(b);
                const market = b.class_key === 'MARKET';
                const net = n2(b.freight) + n2(b.adj_income) - n2(b.deductions);
                return (
                  <tr key={b.id} onClick={() => setOpenId(b.id)} style={{ cursor: 'pointer', background: market ? 'rgba(244,114,182,0.04)' : 'transparent' }} title="Bill kholne ke liye click karein">
                    <td style={{ ...td, fontFamily: 'monospace', color: market ? C.mkt : C.cyan }}>{b.bill_no}</td>
                    <td style={{ ...td, color: C.ink, whiteSpace: 'normal', minWidth: '200px' }}>
                      {b.owner_name}
                      <div style={{ fontSize: '10.5px', color: C.dim }}>
                        {market ? `🛒 MARKET · fleet partner · ${b.company_name ?? ''} ki books`
                          : agency ? `${b.class_key} · ${b.company_name ?? b.operating_company ?? ''} ki books` : `OWN · payable nahi, sirf P&L`}
                      </div>
                    </td>
                    <td style={td}>{b.cycle_label}</td>
                    <td style={tdR}>{b.lorries}</td>
                    <td style={tdR}>{b.trips}</td>
                    <td style={{ ...tdR, color: C.ink }}>{inr2(b.freight)}</td>
                    <td style={{ ...tdR, color: market ? C.mkt : C.crit }}>{market ? inr2(b.partner_freight) : inr2(b.deductions)}</td>
                    <td style={{ ...tdR, color: market ? (b.margin === null ? C.dim : C.good) : (b.commission === null ? C.dim : C.ink2) }}>
                      {market ? (b.margin === null ? '—' : inr2(b.margin)) : agency ? (b.commission === null ? '—' : inr2(b.commission)) : '—'}
                    </td>
                    <td style={{ ...tdR, color: b.tds === null ? C.dim : C.ink2 }}>{agency ? (b.tds === null ? '—' : inr2(b.tds)) : '—'}</td>
                    <td style={{ ...tdR, fontWeight: 700, color: agency ? (b.payable === null ? C.dim : C.good) : (net >= 0 ? C.good : C.crit) }}>
                      {agency ? (b.payable === null ? '—' : inr2(b.payable)) : `${net >= 0 ? 'munafa' : 'ghata'} ${inr(Math.abs(net))}`}
                    </td>
                    <td style={td}>
                      <Pill status={b.status} />
                      {n2(b.needs_rate) > 0 && (
                        <span onClick={(e) => { e.stopPropagation(); onNeedRate?.(); }}
                          style={{ marginLeft: '5px', fontSize: '10px', fontWeight: 800, color: C.crit, border: `1px solid ${C.crit}`, borderRadius: '999px', padding: '2px 8px' }}
                          title="Commission Master kholein">RATE? {b.needs_rate}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {data.rows.length > 0 && <GlobalPagination {...pg} label="bill" />}

      <p style={{ color: C.dim, fontSize: '11px', marginTop: '10px', lineHeight: 1.6 }}>
        Bill no = malik ke initials + pakhwada (jaise pump ka AFS-JUL-H2-2026). Kul kharch = HSD + Toll + Fooding + Fixed +
        Doc + Anya (+ attached lorry par Trip Advance). RATE? = Commission Master me us lorry ka rate darj nahi —
        tab tak approve nahi hoga.
      </p>

      {openId && (
        <BillDrawer api={api} apiJson={apiJson} id={openId} onClose={() => setOpenId(null)}
                    onNeedRate={onNeedRate} onChanged={() => { load(); onChanged?.(); }} />
      )}
    </div>
  );
}

// ══ ONE BILL ════════════════════════════════════════════════════════════════
function BillDrawer({ api, apiJson, id, onClose, onNeedRate, onChanged }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adds, setAdds] = useState({});        // `${trip_id}|${kind}` → { amount, label }
  const [removes, setRemoves] = useState([]);  // entry ids
  const [adj, setAdj] = useState({});          // settlement id → adjustments[]
  const [notes, setNotes] = useState('');
  const [openLorry, setOpenLorry] = useState({});
  const [billAdj, setBillAdj] = useState([]);   // market bills: bill-level adjustments

  const load = useCallback(async () => {
    setErr('');
    try {
      const j = await apiJson(`${api}/${id}`);
      setData(j);
      setNotes(j.bill?.notes ?? '');
      setBillAdj(Array.isArray(j.bill?.adjustments) ? j.bill.adjustments : []);
      const a = {}; for (const v of j.lorries ?? []) a[v.id] = Array.isArray(v.adjustments) ? v.adjustments : [];
      setAdj(a); setAdds({}); setRemoves([]);
      // The first three lorries open, the rest folded — a fleet of eleven
      // must still fit on one screen.
      const o = {}; (j.lorries ?? []).forEach((v, i) => { o[v.id] = i < 3; }); setOpenLorry(o);
    } catch (e) { setErr(e?.message ?? 'bill nahi khula'); }
  }, [api, apiJson, id]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const b = data?.bill;
  const lorries = data?.lorries ?? [];
  const entries = data?.entries ?? [];
  const locked = !!b?.locked_at;
  const agency = isAgency(b);
  // A MARKET bill (fleet partner, migration 162): loads under trucks, no
  // expense columns, TDS on approve, one balance payment after.
  const market = b?.class_key === 'MARKET';

  const dirty = Object.values(adds).some((x) => n2(x.amount) > 0) || removes.length > 0
    || notes !== (b?.notes ?? '')
    || lorries.some((v) => JSON.stringify(adj[v.id] ?? []) !== JSON.stringify(v.adjustments ?? []))
    || (market && JSON.stringify(billAdj) !== JSON.stringify(b?.adjustments ?? []));

  const payBalance = async () => {
    if (!b) return;
    let accounts = [];
    try { accounts = (await apiJson(`${api}/accounts`)).accounts ?? []; } catch { /* prompt anyway */ }
    const NL = String.fromCharCode(10);
    const hint = accounts.length ? NL + NL + 'Khaate: ' + accounts.map((a) => a.ledger_name).join(' · ') : '';
    const account = window.prompt(`${b.owner_name} ko balance ${inr2(b.payable)} kis bank / cash account se bhejein? (ledger ka naam)` + hint,
      accounts[0]?.ledger_name ?? '');
    if (!account) return;
    if (!window.confirm(`${inr2(b.payable)} → ${b.owner_name}, "${account}" se.` + NL
      + `Ek PAYMENT voucher banega, ${b.loads} load SETTLED honge, partner ko WhatsApp jaayega. Pakka?`)) return;
    setBusy(true); setErr('');
    try {
      const j = await apiJson(`${api}/${id}/pay-balance`, { method: 'POST', body: JSON.stringify({ account }) });
      alert(`💸 Bhej diya — ${inr2(j.amount)}. ${j.loads_settled} load settled.`);
      await load(); onChanged?.();
    } catch (e) { setErr(e?.code === 'FORBIDDEN' ? 'Balance sirf admin bhej sakte hain.' : (e?.message ?? 'nahi gaya')); }
    setBusy(false);
  };

  const save = async () => {
    setBusy(true); setErr('');
    if (market) {
      try {
        await apiJson(`${api}/${id}`, { method: 'PATCH', body: JSON.stringify({ notes, adjustments: billAdj }) });
        await load(); onChanged?.(); setEditing(false);
        alert('💾 Save ho gaya. Ledger me kuch nahi gaya — approval par TDS jaayega.');
      } catch (e) { setErr(e?.message ?? 'save nahi hua'); }
      setBusy(false);
      return;
    }
    try {
      const entriesOut = Object.entries(adds)
        .filter(([, x]) => n2(x.amount) > 0)
        .map(([k, x]) => ({ trip_id: k.split('|')[0], kind: k.split('|')[1], amount: n2(x.amount), label: x.label || null }));
      const lorriesOut = lorries
        .filter((v) => JSON.stringify(adj[v.id] ?? []) !== JSON.stringify(v.adjustments ?? []))
        .map((v) => ({ id: v.id, adjustments: adj[v.id] ?? [] }));
      const j = await apiJson(`${api}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ entries: entriesOut, remove_entry_ids: removes, lorries: lorriesOut, notes }),
      });
      await load(); onChanged?.();
      setEditing(false);
      alert(`💾 Save ho gaya. ${entriesOut.length ? entriesOut.length + ' kharch trip ke neeche darj hua. ' : ''}Ledger me kuch nahi gaya — approval par jaayega.`);
      void j;
    } catch (e) { setErr(e?.message ?? 'save nahi hua'); }
    setBusy(false);
  };

  const approve = async () => {
    if (!b) return;
    const NL = String.fromCharCode(10);
    if (n2(b.needs_rate) > 0) {
      if (market) { alert('⚠️ Partner ka TDS rate pata nahi — Fleet Partner master me "Individual ya Firm" chuniye (ya 194C(6) declaration tick kijiye).'); return; }
      alert(`⚠️ ${b.needs_rate} lorry ka commission rate darj nahi hai — pehle Commission Master me rate bhariye.`);
      onNeedRate?.(); return;
    }
    const msg = market
      ? `${b.owner_name} (fleet partner) — ${b.cycle_label}` + NL
        + `Partner freight ${inr2(b.partner_freight)} − advance ${inr2(b.advances_paid)} − TDS ${inr2(b.tds)} = balance ${inr2(b.payable)}` + NL + NL
        + `Approve karke LOCK kar dein? Sirf TDS ${inr2(b.tds)} post hoga (partner ke khaate se kat kar). Balance alag se "💸 Balance bhejein" se jaayega.`
      : agency
      ? `${b.owner_name} — ${b.cycle_label}` + NL + `Owner ko dena: ${inr2(b.payable)}` + NL + NL
        + `Approve karke LOCK kar dein? Owner ke khaate me ${inr2(b.payable)} credit hoga, commission ${inr2(b.commission)} hamari income, TDS ${inr2(b.tds)}.`
      : `${b.owner_name} (apni gaadi) — ${b.cycle_label}` + NL + NL
        + 'Approve karke LOCK kar dein? Ledger me sirf manual adjustment jaayega — freight aur HSD apne flow se jaate hain.';
    if (!window.confirm(msg)) return;
    setBusy(true); setErr('');
    try {
      const j = await apiJson(`${api}/${id}/approve`, { method: 'POST' });
      alert('✅ Approve ho gaya.' + NL + (j.note ?? ''));
      await load(); onChanged?.();
    } catch (e) {
      if (e?.code === 'NO_COMMISSION_RATE') { setErr(e.message); onNeedRate?.(); }
      else setErr(e?.code === 'FORBIDDEN' ? 'Approve sirf admin kar sakte hain.' : (e?.message ?? 'approve nahi hua'));
    }
    setBusy(false);
  };

  const reopen = async () => {
    const reason = window.prompt('Modify kyon? (kaaran likhna zaroori hai — audit me rahega)', '');
    if (!reason || reason.trim().length < 4) return;
    setBusy(true); setErr('');
    try {
      const j = await apiJson(`${api}/${id}/reopen`, { method: 'POST', body: JSON.stringify({ reason }) });
      alert('🔓 Bill khul gaya.' + (j.note ? String.fromCharCode(10) + j.note : ''));
      await load(); onChanged?.(); setEditing(true);
    } catch (e) { setErr(e?.code === 'FORBIDDEN' ? 'Modify sirf admin kar sakte hain.' : (e?.message ?? 'nahi khula')); }
    setBusy(false);
  };

  const whatsapp = async () => {
    try {
      const j = await apiJson(`${api}/${id}/summary-text`);
      const phone = window.prompt('Kis number par bhejein? (10 digit)', '');
      if (!phone) return;
      const r = await sendWhatsApp({ phone, message: j.text, role: 'OWNER' });
      alert(r?.via === 'server' ? '🟢 Bhej diya.' : '📱 WhatsApp khul gaya — wahan se bhej dijiye (engine offline hai).');
    } catch (e) { alert(`❌ ${e?.message ?? 'nahi bana'}`); }
  };

  const email = async () => {
    const to = window.prompt('Kis e-mail par bhejein?', '');
    if (!to) return;
    setBusy(true);
    try {
      const j = await apiJson(`${api}/${id}/email`, { method: 'POST', body: JSON.stringify({ to }) });
      alert(`✉️ Bhej diya — ${j.to}`);
    } catch (e) { alert(`❌ E-mail nahi gaya: ${e?.message ?? ''}`); }
    setBusy(false);
  };

  // ── the rows, derived once ──────────────────────────────────────────────
  const rate = (l) => {
    if (l.rate !== null && l.rate !== undefined && n2(l.rate) > 0) return { v: n2(l.rate).toFixed(4), derived: false };
    const d = n2(l.qty) * n2(l.rtkm);
    return d > 0 ? { v: (n2(l.billed) / d).toFixed(3) + '*', derived: true } : { v: '—', derived: true };
  };
  const otherOf = (l) => n2(l.other) + n2(l.tyre) + n2(l.maintenance);
  const kharchOf = (l) => n2(l.hsd) + n2(l.toll) + n2(l.fooding) + n2(l.fixed) + n2(l.doc) + otherOf(l) + (agency ? n2(l.advances) : 0);
  const addedFor = (tripId, kind) => n2(adds[`${tripId}|${kind}`]?.amount);
  const entriesOf = (tripId) => entries.filter((e) => e.trip_id === tripId && !removes.includes(e.id));

  const printSheet = () => {
    if (!b) return;
    const w = window.open('', '_blank'); if (!w) return;
    const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    // A partner's printed bill carries ONLY the partner side — never the
    // customer's rate or the margin (migration 141's rule).
    if (market) {
      const loads = data?.loads ?? [];
      const pct = n2(b.tds_pct);
      let body = ''; let truck = null;
      for (const l of loads) {
        if (l.truck !== truck) { truck = l.truck; body += `<tr class="veh"><td colspan="7">${esc(truck || 'truck')}${l.driver ? ' — ' + esc(l.driver) : ''}</td></tr>`; }
        const tds = n2(l.partner_rate) * pct / 100;
        body += `<tr><td>${esc(l.load_id)}<br><small>POD ${esc(l.pod_date ?? '')}</small></td><td>${esc(l.origin ?? '')} → ${esc(l.destination ?? '')}<br><small>${esc(l.material ?? '')} ${esc(l.weight ?? '')}</small></td>`
          + `<td class="r">${num2(l.partner_rate)}</td><td class="r">${num2(l.advance)}</td><td class="r">${num2(tds)}</td><td class="r b">${num2(n2(l.partner_rate) - n2(l.advance) - tds)}</td><td>${l.status === 'SETTLED' ? 'settled' : 'POD ✓'}</td></tr>`;
      }
      w.document.write(`<html><head><title>${esc(b.bill_no)} — ${esc(b.owner_name)}</title>
        <style>body{font-family:system-ui,Segoe UI,sans-serif;color:#111;margin:18px;font-size:11px}h1{font-size:16px;margin:0}.sub{color:#555;margin:3px 0 10px}
        table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:4px 6px;vertical-align:top}th{background:#eee;font-size:9px;text-transform:uppercase}
        td.r{text-align:right;font-variant-numeric:tabular-nums}td.b{font-weight:700}small{color:#666;font-size:9px}tr.veh td{background:#f2f2f2;font-weight:700}
        table.foot{width:auto;min-width:380px;margin-top:12px}table.foot tr.tot td{font-weight:800;border-top:2px solid #333}</style></head><body>
        <h1>${esc(b.owner_name)} — 15-Day Bill (market load)</h1>
        <div class="sub">${esc(b.bill_no)} · ${esc(b.cycle_label)} · ${day(b.period_from)} → ${day(b.period_to)} · ${b.trucks} truck · ${b.loads} load · ${esc(b.company_name ?? '')}</div>
        <table><thead><tr><th>Load</th><th>Route</th><th>Freight</th><th>Advance</th><th>TDS ${pct}%</th><th>Balance</th><th>POD</th></tr></thead><tbody>${body}</tbody></table>
        <table class="foot"><tr><td>Kul freight (${b.loads} load)</td><td class="r">${inr2(b.partner_freight)}</td></tr>
        <tr><td>− Advance pehle diya</td><td class="r">${inr2(b.advances_paid)}</td></tr>
        <tr><td>− TDS 194C ${pct}%</td><td class="r">${b.tds === null ? '—' : inr2(b.tds)}</td></tr>
        ${n2(b.adj_income) ? `<tr><td>+ Anya</td><td class="r">${inr2(b.adj_income)}</td></tr>` : ''}${n2(b.adj_expense) ? `<tr><td>− Kataauti</td><td class="r">${inr2(b.adj_expense)}</td></tr>` : ''}
        <tr class="tot"><td>Balance</td><td class="r">${b.payable === null ? '—' : inr2(b.payable)}</td></tr></table>
        <div style="margin-top:10px;color:#555;font-size:10px">${b.pay_voucher_id ? 'Balance bhej diya ' + inr2(b.paid_amount) + ' (' + day(b.paid_at) + ')' : b.status === 'APPROVED' ? 'Approved — bhugtan baaki' : esc(STATUS[b.status]?.t ?? b.status)}</div>
        </body></html>`);
      w.document.close(); w.focus(); w.print();
      return;
    }
    const cell = (v, cls = '') => `<td class="r ${cls}">${num2(v)}</td>`;
    let body = '';
    for (const v of lorries) {
      const lines = Array.isArray(v.lines) ? v.lines : [];
      body += `<tr class="veh"><td colspan="16">${esc(v.vehicle_no)} — ${esc(v.fleet_class ?? '')} · ${v.trips_count} trip</td></tr>`;
      for (const l of lines) {
        body += `<tr><td>${esc(l.iocl_bill_no || l.trip_code)}<br><small>${esc(l.trip_code)} · ${dmy(l.loading_date)} → ${dmy(l.unloading_date)}</small></td>`
          + cell(l.hsd) + cell(l.toll) + cell(l.fooding) + cell(l.fixed) + cell(agency ? l.advances : 0) + cell(l.doc) + cell(otherOf(l)) + cell(kharchOf(l), 'b')
          + `<td class="fold">${esc(l.dest || l.customer || '')}<br><small>${esc(l.product ?? '')}${l.challan_no ? ' · ' + esc(l.challan_no) : ''}</small></td>`
          + `<td class="r">${n2(l.qty).toFixed(3)}</td><td class="r">${n2(l.rtkm).toFixed(1)}</td><td class="r">${rate(l).v}</td>`
          + cell(l.billed) + cell(l.penalty) + cell(l.billed, 'b') + '</tr>';
      }
      body += `<tr class="sub"><td>Subtotal for Vehicle: ${esc(v.vehicle_no)}</td>`
        + cell(v.hsd) + cell(v.toll) + cell(v.fooding) + cell(v.fixed_allowance) + cell(agency ? v.advances : 0) + cell(v.doc_expense)
        + cell(n2(v.tyre) + n2(v.maintenance) + n2(v.other_expense)) + cell(v.bill_expense, 'b')
        + `<td class="fold">${v.trips_count} trip</td><td class="r">${n2(v.loaded_qty).toFixed(3)}</td><td class="r">${n2(v.rtkm).toFixed(1)}</td><td></td>`
        + cell(v.billed_amount) + cell(v.shortage_penalty) + cell(v.billed_amount, 'b') + '</tr>';
      if (agency) {
        body += `<tr class="terms"><td colspan="9"></td><td colspan="7" class="r">Commission ${v.commission_basis === 'PCT' ? n2(v.commission_rate) + '%' : (v.commission_basis ?? '')} <b>${v.commission_amount === null ? 'rate nahi' : inr2(v.commission_amount)}</b>
          &nbsp;·&nbsp; TDS ${n2(v.tds_pct)}% <b>${v.tds_amount === null ? '—' : inr2(v.tds_amount)}</b> &nbsp;·&nbsp; kharch wapas <b>${inr2(v.expenses_recovered)}</b> &nbsp;·&nbsp; owner ko <b>${v.payable_to_owner === null ? '—' : inr2(v.payable_to_owner)}</b></td></tr>`;
      }
    }
    body += `<tr class="grand"><td>Total of All Bills · ${b.lorries} lorry · ${b.trips} trip</td>`
      + cell(b.hsd) + cell(b.toll) + cell(b.fooding) + cell(b.fixed_allowance) + cell(agency ? b.advances : 0) + cell(b.doc_expense) + cell(b.other_expense) + cell(b.deductions, 'b')
      + `<td class="fold"></td><td class="r">${n2(b.loaded_qty).toFixed(3)}</td><td class="r">${n2(b.rtkm).toFixed(1)}</td><td></td>`
      + cell(b.freight) + cell(b.penalty) + cell(b.freight, 'b') + '</tr>';
    const foot = agency
      ? `<table class="foot"><tr><td>Freight (${b.trips} trip)</td><td class="r">${inr2(b.freight)}</td></tr>
         ${n2(b.adj_income) ? `<tr><td>+ Anya aay (manual)</td><td class="r">${inr2(b.adj_income)}</td></tr>` : ''}
         <tr><td>− Commission</td><td class="r">${b.commission === null ? 'rate nahi' : inr2(b.commission)}</td></tr>
         <tr><td>− TDS 194C</td><td class="r">${b.tds === null ? '—' : inr2(b.tds)}</td></tr>
         <tr><td>− Kharch wapas (HSD, toll, advance, fooding, fixed, doc, anya)</td><td class="r">${inr2(b.recovered)}</td></tr>
         ${n2(b.adj_expense) ? `<tr><td>− Manual kharch</td><td class="r">${inr2(b.adj_expense)}</td></tr>` : ''}
         <tr class="tot"><td>Owner ko dena</td><td class="r">${b.payable === null ? '—' : inr2(b.payable)}</td></tr></table>`
      : `<table class="foot"><tr><td>Freight</td><td class="r">${inr2(b.freight)}</td></tr>
         <tr><td>− Kul kharch</td><td class="r">${inr2(b.deductions)}</td></tr>
         <tr class="tot"><td>${n2(b.freight) + n2(b.adj_income) - n2(b.deductions) >= 0 ? 'Munafa' : 'Ghata'}</td><td class="r">${inr2(Math.abs(n2(b.freight) + n2(b.adj_income) - n2(b.deductions)))}</td></tr></table>`;
    w.document.write(`<html><head><title>${esc(b.bill_no)} — ${esc(b.owner_name)}</title>
      <style>@page{size:A4 landscape;margin:10mm}body{font-family:system-ui,Segoe UI,sans-serif;color:#111;margin:14px;font-size:10.5px}
      h1{font-size:16px;margin:0}.sub{color:#555;margin:3px 0 10px;font-size:11px}
      table{border-collapse:collapse;width:100%}th,td{border:1px solid #bbb;padding:3px 5px;vertical-align:top}
      th{background:#eee;font-size:9px;text-transform:uppercase}th.k{background:#fde8ea}th.i{background:#e3f6ee}
      td.r{text-align:right;font-variant-numeric:tabular-nums}td.b{font-weight:700}small{color:#666;font-size:9px}
      tr.veh td{background:#f2f2f2;font-weight:700}tr.sub td{background:#f7f7f7;font-weight:700}tr.terms td{font-size:9.5px;color:#444;background:#fafafa}
      tr.grand td{background:#e8e8e8;font-weight:800}td.fold{border-left:2px solid #333}th.fold{border-left:2px solid #333}
      table.foot{width:auto;min-width:420px;margin-top:12px;font-size:11px}table.foot tr.tot td{font-weight:800;border-top:2px solid #333}
      .note{margin-top:10px;color:#555;font-size:9.5px}</style></head><body>
      <h1>${esc(b.owner_name)} — 15-Day Vehicle Bill</h1>
      <div class="sub">${esc(b.bill_no)} · ${esc(b.cycle_label)} · ${day(b.period_from)} → ${day(b.period_to)} · books: ${esc(b.company_name ?? b.operating_company ?? '')} · ${esc(STATUS[b.status]?.t ?? b.status)}${b.approved_by ? ' by ' + esc(b.approved_by) : ''}</div>
      <table><thead><tr><th rowspan="2">Trip / Bill No</th><th class="k" colspan="8">KHARCH (EXPENSE)</th><th class="i fold" colspan="7">BILL DETAILS</th></tr>
      <tr><th class="k">HSD</th><th class="k">Toll Tax</th><th class="k">Trip Fooding Alw.</th><th class="k">Trip Fixed Alw.</th><th class="k">Trip Advance</th><th class="k">Doc Exp</th><th class="k">Other Exp</th><th class="k">Kul kharch</th>
      <th class="i fold">Ship-to-party</th><th class="i">Qty (KL)</th><th class="i">RTKM</th><th class="i">Rate</th><th class="i">Freight</th><th class="i">Shortage</th><th class="i">Net freight</th></tr></thead>
      <tbody>${body}</tbody></table>
      ${foot}
      <div class="note">* Rate = freight ÷ (KL × RTKM) jahan trip par rate darj nahi. Shortage = IOCL ki penalty, jaankari ke liye. ${agency ? 'Trip Advance owner ki taraf se diya gaya, isliye kharch me ginaa.' : 'Apni gaadi par advance driver ke khaate me rehta hai.'}</div>
      </body></html>`);
    w.document.close(); w.focus(); w.print();
  };

  // ── styles ──────────────────────────────────────────────────────────────
  const th = (side, align = 'left') => ({
    padding: '7px 8px', textAlign: align, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.07em',
    whiteSpace: 'nowrap', borderBottom: `1px solid ${C.line}`, position: 'sticky', top: 0,
    background: side === 'k' ? 'rgba(255,107,129,0.06)' : side === 'i' ? 'rgba(47,227,155,0.06)' : 'rgba(10,16,36,0.6)',
    color: side === 'k' ? '#ff8f9f' : side === 'i' ? '#5eead4' : C.dim,
  });
  const td = (side, align = 'left', extra = {}) => ({
    padding: '7px 8px', textAlign: align, whiteSpace: 'nowrap', borderBottom: '1px solid #1b2a4e', color: C.ink2,
    fontVariantNumeric: 'tabular-nums', verticalAlign: 'top',
    background: side === 'k' ? 'rgba(255,107,129,0.05)' : side === 'i' ? 'rgba(47,227,155,0.05)' : 'transparent', ...extra,
  });
  const fold = { borderLeft: `2px solid ${C.line}` };
  const money = (v, opts = {}) => (
    <span style={{ color: n2(v) === 0 ? C.zero : (opts.color ?? C.ink2), fontWeight: opts.bold ? 700 : 400 }}>
      {n2(v) === 0 ? '0' : num2(v)}
    </span>
  );
  const editCell = (l, kind, current) => {
    const key = `${l.trip_id}|${kind}`;
    const a = adds[key] ?? { amount: '', label: '' };
    return (
      <div>
        {money(current)}
        {editing && !locked && (
          <div style={{ display: 'flex', gap: '3px', marginTop: '3px', alignItems: 'center' }}>
            <input value={a.amount} placeholder="+ ₹" onChange={(e) => setAdds((x) => ({ ...x, [key]: { ...a, amount: e.target.value } }))}
              style={{ width: '64px', background: '#0a1024', border: `1px dashed rgba(34,211,238,0.6)`, borderRadius: '5px', color: C.ink, padding: '2px 5px', fontSize: '11px', textAlign: 'right' }} />
            {kind === 'OTHER_EXPENSE' && (
              <input value={a.label} placeholder="kis cheez ka" onChange={(e) => setAdds((x) => ({ ...x, [key]: { ...a, label: e.target.value } }))}
                style={{ width: '86px', background: '#0a1024', border: `1px dashed rgba(34,211,238,0.6)`, borderRadius: '5px', color: C.ink, padding: '2px 5px', fontSize: '11px' }} />
            )}
          </div>
        )}
      </div>
    );
  };

  const kpi = (k, v, color) => (
    <div style={{ background: C.panel, padding: '11px 14px' }}>
      <div style={{ fontSize: '10px', letterSpacing: '0.1em', textTransform: 'uppercase', color: C.dim }}>{k}</div>
      <div style={{ fontSize: '17px', fontWeight: 700, marginTop: '3px', color, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
    </div>
  );
  const netOwn = b ? n2(b.freight) + n2(b.adj_income) - n2(b.deductions) : 0;

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,8,20,0.84)', zIndex: 900, display: 'flex',
               justifyContent: 'center', alignItems: 'flex-start', padding: '20px 12px', overflowY: 'auto', backdropFilter: 'blur(3px)' }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(1500px, 100%)', background: '#0d1530', border: `1px solid ${C.line}`, borderRadius: '14px',
                 overflow: 'hidden', boxShadow: '0 24px 70px rgba(0,0,0,0.6)', borderTop: `3px solid ${C.cyan}` }}>
        {!b ? (
          <p style={{ color: C.mut, padding: '24px' }}>{err || 'bill khul raha hai…'}</p>
        ) : (
          <>
            {/* ── header + toolbar ─────────────────────────────────── */}
            <div style={{ padding: '16px 20px', borderBottom: `1px solid ${C.line}`, display: 'flex', justifyContent: 'space-between', gap: '14px', flexWrap: 'wrap' }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: '10.5px', letterSpacing: '0.14em', textTransform: 'uppercase', color: C.dim }}>15-Day Vehicle Bill · Audit &amp; Approval</div>
                <div style={{ fontSize: '21px', fontWeight: 800, color: C.ink, marginTop: '2px' }}>{b.owner_name}{!agency && <span style={{ color: C.mut, fontWeight: 500, fontSize: '14px' }}> · apni gaadi (OWN)</span>}</div>
                <div style={{ fontSize: '12.5px', color: C.mut, marginTop: '2px' }}>
                  <span style={{ fontFamily: 'monospace', color: C.cyan }}>{b.bill_no}</span>
                  {' · '}{b.cycle_label}{' · '}{day(b.period_from)} → {day(b.period_to)}{' · '}{b.lorries} lorry · {b.trips} trip
                  {' · books: '}{b.company_name ?? b.operating_company ?? '—'}
                </div>
                <div style={{ marginTop: '7px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Pill status={b.status} />
                  {locked && <span style={{ color: C.dim, fontSize: '11px' }}>🔒 {b.approved_by} · {day(b.approved_at)}</span>}
                  {b.voucher_id && <span style={{ color: '#c4b5fd', fontSize: '11px' }}>📘 voucher posted{n2(b.post_count) > 1 ? ` ×${b.post_count}` : ''}</span>}
                  {b.reopen_reason && !locked && <span style={{ color: C.warn, fontSize: '11px' }}>🔓 modify: {b.reopen_reason}</span>}
                  {n2(b.needs_rate) > 0 && (
                    <span onClick={() => onNeedRate?.()} style={{ color: C.crit, fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                      ⚠️ {b.needs_rate} lorry ka commission rate nahi — Commission Master →
                    </span>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                {locked ? (
                  <button onClick={reopen} disabled={busy} style={btn('warn', !busy)} title="Sirf admin · kaaran zaroori">🔓 Modify</button>
                ) : (
                  <>
                    <button onClick={() => setEditing((v) => !v)} style={btn(editing ? 'warn' : 'cyan')}>{editing ? '✏️ Edit band' : '✏️ Edit'}</button>
                    <button onClick={save} disabled={busy || !dirty} style={btn(dirty ? 'solid' : 'plain', dirty && !busy)}>💾 Save</button>
                  </>
                )}
                <button onClick={printSheet} style={btn('plain')}>🖨️ Print / PDF</button>
                <button onClick={whatsapp} style={btn('good')}>🟢 WhatsApp</button>
                <button onClick={email} disabled={busy} style={btn('plain', !busy)}>✉️ Email bill</button>
                {!locked && (
                  <button onClick={approve} disabled={busy || dirty} style={btn('good', !busy && !dirty)}
                    title={dirty ? 'Pehle Save kijiye' : market ? 'Sirf admin · TDS post + lock' : 'Sirf admin · owner ke khaate me post + lock'}>
                    {market ? '✅ Approve (TDS + lock)' : '✅ Approve & Post'}
                  </button>
                )}
                {market && locked && !b.pay_voucher_id && (
                  <button onClick={payBalance} disabled={busy} style={btn('mkt', !busy)} title="Sirf admin · ek PAYMENT voucher, bank se">💸 Balance bhejein</button>
                )}
                {market && b.pay_voucher_id && (
                  <span style={{ color: C.mkt, fontSize: '11.5px', fontWeight: 700, alignSelf: 'center' }}>💸 bheja {inr2(b.paid_amount)} · {day(b.paid_at)}</span>
                )}
                <button onClick={onClose} style={btn('plain')}>✕ Band karein</button>
              </div>
            </div>

            {err && <p style={{ color: C.crit, fontSize: '12.5px', margin: '10px 20px 0' }}>{err}</p>}

            {/* ── KPI strip ─────────────────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px,1fr))', gap: '1px', background: C.line, borderBottom: `1px solid ${C.line}` }}>
              {market ? (<>
                {kpi(`Customer freight (${b.loads} load)`, inr2(b.freight), C.ink)}
                {kpi('Partner freight (lagat)', inr2(b.partner_freight), C.mkt)}
                {kpi('Margin · office only', b.margin === null ? 'rate adhoora' : `${inr2(b.margin)}${n2(b.freight) ? ` · ${(n2(b.margin) / n2(b.freight) * 100).toFixed(1)}%` : ''}`, b.margin === null ? C.dim : C.good)}
                {kpi('Advance diya', inr2(b.advances_paid), C.ink2)}
                {kpi(`TDS 194C${b.tds_pct !== null && b.tds_pct !== undefined ? ` ${n2(b.tds_pct)}%` : ''}`, b.tds === null ? 'rate nahi' : inr2(b.tds), b.tds === null ? C.dim : C.ink)}
                {kpi('Partner ko dena (balance)', b.payable === null ? 'rate ke baad' : inr2(b.payable), b.payable === null ? C.dim : C.good)}
              </>) : (<>
              {kpi(`Freight (${b.trips} trip)`, inr2(b.freight), C.ink)}
              {kpi('Kul kharch', inr2(b.deductions), C.crit)}
              {agency ? kpi('Commission', b.commission === null ? 'rate nahi' : inr2(b.commission), b.commission === null ? C.dim : C.ink)
                      : kpi('Manual adj.', `${inr(b.adj_income)} / ${inr(b.adj_expense)}`, C.ai)}
              {agency ? kpi('TDS 194C', b.tds === null ? '—' : inr2(b.tds), b.tds === null ? C.dim : C.ink)
                      : kpi('Vasool hua', inr2(b.received), C.mut)}
              {agency ? kpi('Owner ko dena', b.payable === null ? 'rate ke baad' : inr2(b.payable), b.payable === null ? C.dim : C.good)
                      : kpi(netOwn >= 0 ? 'Munafa' : 'Ghata', inr2(Math.abs(netOwn)), netOwn >= 0 ? C.good : C.crit)}
              </>)}
              {kpi('Status', STATUS[b.status]?.t ?? b.status, STATUS[b.status]?.c ?? C.mut)}
            </div>

            {editing && !locked && (
              <div style={{ margin: '12px 20px 0', padding: '9px 13px', border: '1px solid rgba(34,211,238,0.35)', background: 'rgba(34,211,238,0.06)', borderRadius: '9px', fontSize: '12px', color: C.ink2 }}>
                ✏️ Dashed box me rakam likhiye — wo us <b>trip ke neeche</b> darj hogi (fooding / fixed / doc / anya). HSD pump slip se, Toll FASTag se, Advance driver khata se aata hai — wo yahan se nahi badalte.
                Neeche har lorry ke saath manual adjustment (detention, bonus) bhi jod sakte hain. Phir <b>Save</b>.
              </div>
            )}

            {market && (
              <MarketLoads b={b} loads={data?.loads ?? []} vendor={data?.vendor} running={data?.running}
                           editing={editing && !locked} billAdj={billAdj} setBillAdj={setBillAdj} />
            )}
            {!market && (<>
            {/* ── THE BILL ──────────────────────────────────────────── */}
            <div style={{ margin: '12px 20px 0', overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px', maxHeight: '62vh', overflowY: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', minWidth: '1560px', width: '100%', fontSize: '12px' }}>
                <thead>
                  <tr>
                    <th rowSpan={2} style={{ ...th('n'), minWidth: '170px' }}>Trip / Bill No<br /><span style={{ letterSpacing: 0, fontWeight: 500, textTransform: 'none' }}>tareekh · driver</span></th>
                    <th colSpan={8} style={{ ...th('k', 'center'), letterSpacing: '0.12em' }}>◀ KHARCH (EXPENSE) — trip ID ke neeche</th>
                    <th colSpan={7} style={{ ...th('i', 'center'), ...fold, letterSpacing: '0.12em' }}>BILL DETAILS (IOCL format) ▶</th>
                  </tr>
                  <tr>
                    {['HSD', 'Toll Tax', 'Trip Fooding Alw.', 'Trip Fixed Alw.', 'Trip Advance', 'Doc Exp', 'Other Exp', 'Kul kharch'].map((h) => (
                      <th key={h} style={th('k', 'right')}>{h}</th>
                    ))}
                    <th style={{ ...th('i'), ...fold }}>Ship-to-party</th>
                    {['Qty (KL)', 'RTKM', 'Rate', 'Freight', 'Shortage', 'Net freight'].map((h) => <th key={h} style={th('i', 'right')}>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {lorries.map((v) => {
                    const lines = Array.isArray(v.lines) ? v.lines : [];
                    const open = !!openLorry[v.id];
                    const otherSub = n2(v.tyre) + n2(v.maintenance) + n2(v.other_expense);
                    const adjList = adj[v.id] ?? [];
                    return (
                      <React.Fragment key={v.id}>
                        <tr onClick={() => setOpenLorry((o) => ({ ...o, [v.id]: !open }))} style={{ cursor: 'pointer' }}>
                          <td colSpan={16} style={{ ...td('n'), background: C.raised, color: C.ink, fontWeight: 700, borderTop: `1px solid ${C.line}` }}>
                            {open ? '▾' : '▸'} 🚛 {v.vehicle_no}
                            <span style={{ fontWeight: 500, color: C.mut, fontSize: '11px', marginLeft: '8px' }}>
                              {v.fleet_class ?? 'master me nahi'} · {v.trips_count} trip · freight {inr(v.billed_amount)} · kharch {inr(v.bill_expense)}
                              {v.needs_rate && <span style={{ color: C.crit, marginLeft: '8px' }}>⚠️ rate nahi</span>}
                              {v.stale && <span style={{ color: C.warn, marginLeft: '8px' }}>⚠️ trip badle hain — Draft banayein</span>}
                              {n2(v.billed_amount) === 0 && <span style={{ color: C.crit, marginLeft: '8px' }}>freight ₹0 — billing baaki</span>}
                            </span>
                          </td>
                        </tr>
                        {open && lines.map((l) => {
                          const r = rate(l);
                          const es = entriesOf(l.trip_id);
                          return (
                            <tr key={l.trip_id}>
                              <td style={td('n')}>
                                <span style={{ fontFamily: 'monospace', color: l.iocl_bill_no ? C.cyan : C.warn }}>{l.iocl_bill_no || l.trip_code}</span>
                                <div style={{ fontSize: '10.5px', color: C.dim }}>{l.iocl_bill_no ? l.trip_code + ' · ' : 'IOCL bill no baaki · '}{dmy(l.loading_date)} → {dmy(l.unloading_date)}</div>
                                {l.driver && <div style={{ fontSize: '10.5px', color: C.dim }}>{l.driver}</div>}
                                {es.length > 0 && (
                                  <div style={{ fontSize: '10px', color: C.ai, marginTop: '2px' }}>
                                    {es.map((e) => (
                                      <div key={e.id}>{KINDS.find((k) => k[0] === e.kind)?.[1] ?? e.kind} {inr(e.amount)}{e.label ? ` · ${e.label}` : ''} <span style={{ color: C.dim }}>· {e.entered_by}</span>
                                        {editing && !locked && <span onClick={() => setRemoves((x) => [...x, e.id])} style={{ color: C.crit, cursor: 'pointer', marginLeft: '4px' }} title="Hataayein">×</span>}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </td>
                              <td style={td('k', 'right')}>{money(l.hsd)}</td>
                              <td style={td('k', 'right')}>{money(l.toll)}</td>
                              <td style={td('k', 'right')}>{editCell(l, 'FOODING_ALLOWANCE', l.fooding)}</td>
                              <td style={td('k', 'right')}>{editCell(l, 'FIXED_ALLOWANCE', l.fixed)}</td>
                              <td style={td('k', 'right')}>{agency ? money(l.advances) : <span style={{ color: C.dim }} title="Apni gaadi: driver khata me, kharch me nahi">{n2(l.advances) ? num2(l.advances) + ' ⓘ' : '0'}</span>}</td>
                              <td style={td('k', 'right')}>{editCell(l, 'DOC_EXPENSE', l.doc)}</td>
                              <td style={td('k', 'right')}>{editCell(l, 'OTHER_EXPENSE', otherOf(l))}</td>
                              <td style={td('k', 'right')}>{money(kharchOf(l) + addedFor(l.trip_id, 'FOODING_ALLOWANCE') + addedFor(l.trip_id, 'FIXED_ALLOWANCE') + addedFor(l.trip_id, 'DOC_EXPENSE') + addedFor(l.trip_id, 'OTHER_EXPENSE'), { color: C.ink, bold: true })}</td>
                              <td style={{ ...td('i'), ...fold, whiteSpace: 'normal', minWidth: '180px' }}>
                                {l.dest || l.customer || <span style={{ color: C.dim }}>ship-to darj nahi</span>}
                                <div style={{ fontSize: '10.5px', color: C.dim }}>{l.product ?? ''}{l.challan_no ? ` · challan ${l.challan_no}` : ''}</div>
                              </td>
                              <td style={td('i', 'right')}>{n2(l.qty).toFixed(3)}</td>
                              <td style={td('i', 'right')}>{n2(l.rtkm).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
                              <td style={td('i', 'right', { color: r.derived ? C.dim : C.ink2 })}>{r.v}</td>
                              <td style={td('i', 'right')}>{money(l.billed, { color: C.ink })}</td>
                              <td style={td('i', 'right')}>{money(l.penalty)}</td>
                              <td style={td('i', 'right')}>{money(l.billed, { color: C.good })}</td>
                            </tr>
                          );
                        })}
                        <tr>
                          <td style={{ ...td('n'), background: 'rgba(24,36,74,0.55)', color: C.ink, fontWeight: 700 }}>Subtotal for Vehicle: {v.vehicle_no}</td>
                          {[v.hsd, v.toll, v.fooding, v.fixed_allowance, agency ? v.advances : 0, v.doc_expense, otherSub].map((x, i) => (
                            <td key={i} style={{ ...td('k', 'right'), background: 'rgba(24,36,74,0.55)', fontWeight: 700 }}>{money(x, { color: C.ink })}</td>
                          ))}
                          <td style={{ ...td('k', 'right'), background: 'rgba(24,36,74,0.55)' }}>{money(v.bill_expense, { color: C.crit, bold: true })}{n2(v.adj_expense) > 0 && <div style={{ fontSize: '10px', color: C.ai }}>incl. manual {inr(v.adj_expense)}</div>}</td>
                          <td style={{ ...td('i'), ...fold, background: 'rgba(24,36,74,0.55)', color: C.dim }}>{v.trips_count} trip{n2(v.adj_income) > 0 && <div style={{ fontSize: '10px', color: C.ai }}>+ manual aay {inr(v.adj_income)}</div>}</td>
                          <td style={{ ...td('i', 'right'), background: 'rgba(24,36,74,0.55)', fontWeight: 700 }}>{n2(v.loaded_qty).toFixed(3)}</td>
                          <td style={{ ...td('i', 'right'), background: 'rgba(24,36,74,0.55)', fontWeight: 700 }}>{n2(v.rtkm).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
                          <td style={{ ...td('i'), background: 'rgba(24,36,74,0.55)' }} />
                          <td style={{ ...td('i', 'right'), background: 'rgba(24,36,74,0.55)', fontWeight: 700 }}>{money(v.billed_amount, { color: C.ink })}</td>
                          <td style={{ ...td('i', 'right'), background: 'rgba(24,36,74,0.55)' }}>{money(v.shortage_penalty)}</td>
                          <td style={{ ...td('i', 'right'), background: 'rgba(24,36,74,0.55)' }}>{money(v.billed_amount, { color: C.good, bold: true })}</td>
                        </tr>
                        {(agency || editing || adjList.length > 0) && (
                          <tr>
                            <td colSpan={9} style={{ ...td('n'), background: 'rgba(24,36,74,0.3)', borderBottom: `2px solid ${C.line}`, whiteSpace: 'normal' }}>
                              {(editing && !locked) ? (
                                <AdjustmentEditor adj={adjList} setAdj={(x) => setAdj((a) => ({ ...a, [v.id]: x }))} />
                              ) : adjList.length > 0 ? (
                                <span style={{ fontSize: '11px', color: C.ai }}>✏️ manual: {adjList.map((a) => `${a.side === 'INCOME' ? '+' : '−'} ${a.label} ${inr(a.amount)}`).join(' · ')}</span>
                              ) : null}
                            </td>
                            <td colSpan={7} style={{ ...td('i', 'right'), ...fold, background: 'rgba(24,36,74,0.3)', borderBottom: `2px solid ${C.line}`, fontSize: '11.5px', color: C.mut, whiteSpace: 'normal' }}>
                              {agency ? (
                                v.commission_amount === null
                                  ? <span style={{ color: C.crit }}>⚠️ commission rate darj nahi — <span onClick={() => onNeedRate?.()} style={{ textDecoration: 'underline', cursor: 'pointer' }}>Commission Master</span></span>
                                  : <>Commission {v.commission_basis === 'PCT' ? `${n2(v.commission_rate)}%` : `${v.commission_basis} ${n2(v.commission_rate)}`} <b style={{ color: C.ink }}>{inr2(v.commission_amount)}</b>
                                     &nbsp;·&nbsp; TDS {n2(v.tds_pct)}% <b style={{ color: C.ink }}>{inr2(v.tds_amount)}</b>
                                     &nbsp;·&nbsp; kharch wapas <b style={{ color: C.ink }}>{inr2(v.expenses_recovered)}</b>
                                     &nbsp;·&nbsp; owner ko <b style={{ color: C.good }}>{inr2(v.payable_to_owner)}</b></>
                              ) : null}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  <tr>
                    <td style={{ ...td('n'), background: C.raised, color: C.ink, fontWeight: 800, fontSize: '13px', borderTop: `2px solid ${C.line}` }}>Total of All Bills · {b.lorries} lorry · {b.trips} trip</td>
                    {[b.hsd, b.toll, b.fooding, b.fixed_allowance, agency ? b.advances : 0, b.doc_expense, b.other_expense].map((x, i) => (
                      <td key={i} style={{ ...td('k', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{money(x, { color: C.ink })}</td>
                    ))}
                    <td style={{ ...td('k', 'right'), background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.deductions, { color: C.crit, bold: true })}</td>
                    <td style={{ ...td('i'), ...fold, background: C.raised, borderTop: `2px solid ${C.line}` }} />
                    <td style={{ ...td('i', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{n2(b.loaded_qty).toFixed(3)}</td>
                    <td style={{ ...td('i', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{n2(b.rtkm).toLocaleString('en-IN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</td>
                    <td style={{ ...td('i'), background: C.raised, borderTop: `2px solid ${C.line}` }} />
                    <td style={{ ...td('i', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{money(b.freight, { color: C.ink })}</td>
                    <td style={{ ...td('i', 'right'), background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.penalty)}</td>
                    <td style={{ ...td('i', 'right'), background: C.raised, borderTop: `2px solid ${C.line}` }}>{money(b.freight, { color: C.good, bold: true })}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p style={{ color: C.dim, fontSize: '11px', margin: '8px 20px 0', lineHeight: 1.6 }}>
              * Rate = freight ÷ (KL × RTKM) jahan trip par rate darj nahi. Shortage = IOCL ki penalty (jaankari). HSD pump slip se, Toll FASTag se
              (jo crossing trip se judi hain), Trip Advance driver khata se{agency ? ' — attached lorry par owner ki taraf se diya, isliye kharch me' : ' — apni gaadi par driver ke khaate me rehta hai, kharch me nahi'}.
            </p>
            </>)}

            {/* ── the foot: hisaab + journal ────────────────────────── */}
            {market ? (
              <MarketFoot b={b} journal={data?.journal} running={data?.running} vendor={data?.vendor} locked={locked} />
            ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '14px', margin: '14px 20px 0' }}>
              <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '14px 16px' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '12.5px', color: C.mut, letterSpacing: '.04em' }}>{agency ? 'HISAAB — owner ko kitna dena hai' : 'HISAAB — apni gaadi ka munafa'}</h4>
                {[
                  ['Freight', `${b.trips} trip · billed amount`, b.freight, C.ink],
                  n2(b.adj_income) ? ['+ Anya aay', 'manual', b.adj_income, C.ai] : null,
                  agency ? ['− Commission', b.commission === null ? 'rate darj nahi' : `${lorries.filter((v) => v.commission_basis === 'PCT').length ? 'PCT basis' : 'as per term'}`, b.commission, C.ink2] : null,
                  agency ? ['− TDS 194C', 'on (freight − commission)', b.tds, C.ink2] : null,
                  agency ? ['− Kharch wapas', `HSD ${inr(b.hsd)} · toll ${inr(b.toll)} · advance ${inr(b.advances)} · typed ${inr(n2(b.fooding) + n2(b.fixed_allowance) + n2(b.doc_expense) + n2(b.other_expense))}`, b.recovered, C.crit]
                         : ['− Kul kharch', `HSD ${inr(b.hsd)} · toll ${inr(b.toll)} · typed ${inr(n2(b.fooding) + n2(b.fixed_allowance) + n2(b.doc_expense) + n2(b.other_expense))}`, b.expense_total, C.crit],
                  n2(b.adj_expense) ? ['− Manual kharch', 'reviewer ne joda', b.adj_expense, C.ai] : null,
                ].filter(Boolean).map((r) => (
                  <div key={r[0]} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', borderBottom: '1px solid #1b2a4e', fontSize: '13px' }}>
                    <span style={{ color: C.ink2 }}>{r[0]} <span style={{ color: C.dim, fontSize: '11px', marginLeft: '6px' }}>{r[1]}</span></span>
                    <span style={{ color: r[2] === null ? C.dim : r[3], fontVariantNumeric: 'tabular-nums' }}>{r[2] === null ? '—' : inr2(r[2])}</span>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 0 0', marginTop: '4px', borderTop: `2px solid ${C.line}`, fontWeight: 800, fontSize: '15px' }}>
                  <span style={{ color: C.ink2 }}>{agency ? 'Owner ko dena' : (netOwn >= 0 ? 'Munafa' : 'Ghata')}</span>
                  <span style={{ color: agency ? (b.payable === null ? C.dim : C.good) : (netOwn >= 0 ? C.good : C.crit), fontVariantNumeric: 'tabular-nums' }}>
                    {agency ? (b.payable === null ? 'rate ke baad' : inr2(b.payable)) : inr2(Math.abs(netOwn))}
                  </span>
                </div>
              </div>
              <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '14px 16px' }}>
                <h4 style={{ margin: '0 0 8px', fontSize: '12.5px', color: C.mut, letterSpacing: '.04em' }}>
                  {locked ? 'JO POST HUA' : 'APPROVE PAR YEH POST HOGA'} — {b.company_name ?? b.operating_company ?? 'company'} ki books
                </h4>
                {(locked && Array.isArray(b.posted_lines) && b.posted_lines.length ? b.posted_lines : data?.journal?.lines ?? []).length === 0 ? (
                  <div style={{ color: C.dim, fontSize: '12.5px' }}>Post karne ko kuch nahi — {agency ? 'freight ₹0 ya rate baaki' : 'koi manual adjustment nahi'}. Approve sirf lock karega.</div>
                ) : (locked && Array.isArray(b.posted_lines) && b.posted_lines.length ? b.posted_lines : data.journal.lines).map((l, i) => (
                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '30px 1fr auto', gap: '8px', padding: '5px 0', borderBottom: '1px solid #1b2a4e', fontSize: '12.5px', alignItems: 'baseline' }}>
                    <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '11px', color: C.dim }}>{l.dr_cr === 'DR' ? 'Dr' : 'Cr'}</span>
                    <span style={{ color: /^Vehicle Owner:/.test(l.ledger) ? C.good : C.ink2, whiteSpace: 'normal' }}>{l.ledger}<div style={{ fontSize: '10.5px', color: C.dim }}>{l.group}</div></span>
                    <span style={{ color: /^Vehicle Owner:/.test(l.ledger) ? C.good : C.ink, fontVariantNumeric: 'tabular-nums' }}>{num2(l.amount)}</span>
                  </div>
                ))}
                <div style={{ color: C.dim, fontSize: '11px', marginTop: '8px', lineHeight: 1.6 }}>
                  Voucher ref <span style={{ fontFamily: 'monospace' }}>VEHBILL_{b.bill_no}</span> — ek hi baar post hota hai. Modify ke baad dobara approve par sirf antar ka naya voucher (_R2) banta hai; purana waisa hi rehta hai.
                </div>
              </div>
            </div>
            )}

            <div style={{ margin: '12px 20px 18px' }}>
              <label style={{ fontSize: '11px', color: C.mut }}>Note</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={locked} rows={2}
                placeholder="Kuch likhna ho to yahan…"
                style={{ width: '100%', background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '8px', color: C.ink, padding: '8px 10px', fontSize: '12.5px', marginTop: '4px', resize: 'vertical' }} />
              <div style={{ fontSize: '10.5px', color: C.dim, marginTop: '6px' }}>
                {b.reviewed_by ? `Reviewed: ${b.reviewed_by} · ${day(b.reviewed_at)} · ` : ''}{b.created_by ? `Draft: ${b.created_by} · ${day(b.created_at)}` : ''}
                {locked && ' · Approve ke baad sirf Modify (admin, kaaran ke saath), Print, WhatsApp, Email.'}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ══ A MARKET (FLEET PARTNER) BILL — loads under their trucks ═══════════════
//
// Customer side left (green, office only), partner side right (pink). The
// partner bears diesel, toll and driver, so there are no expense columns; what
// we owe him is the awarded freight less the advance and TDS.
function MarketLoads({ b, loads, vendor, running, editing, billAdj, setBillAdj }) {
  const pct = n2(b.tds_pct);
  const hasPct = b.tds_pct !== null && b.tds_pct !== undefined;
  const th = (side, align = 'left') => ({
    padding: '7px 8px', textAlign: align, fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.07em',
    whiteSpace: 'nowrap', borderBottom: `1px solid ${C.line}`, position: 'sticky', top: 0,
    background: side === 'c' ? 'rgba(47,227,155,0.06)' : side === 'p' ? 'rgba(244,114,182,0.06)' : 'rgba(10,16,36,0.6)',
    color: side === 'c' ? '#5eead4' : side === 'p' ? '#f9a8d4' : C.dim,
  });
  const td = (side, align = 'left', extra = {}) => ({
    padding: '7px 8px', textAlign: align, whiteSpace: 'nowrap', borderBottom: '1px solid #1b2a4e', color: C.ink2,
    fontVariantNumeric: 'tabular-nums', verticalAlign: 'top',
    background: side === 'c' ? 'rgba(47,227,155,0.05)' : side === 'p' ? 'rgba(244,114,182,0.05)' : 'transparent', ...extra,
  });
  const fold = { borderLeft: `2px solid ${C.line}` };
  const sub = { background: 'rgba(24,36,74,0.55)', fontWeight: 700, color: C.ink, borderBottom: `2px solid ${C.line}` };
  const money = (v, color = C.ink2, bold = false) => (
    <span style={{ color: n2(v) === 0 ? C.zero : color, fontWeight: bold ? 700 : 400 }}>{n2(v) === 0 ? '0' : num2(v)}</span>
  );
  const groups = [];
  for (const l of loads) {
    const key = l.truck ?? '(truck darj nahi)';
    let g = groups.find((x) => x.truck === key);
    if (!g) { g = { truck: key, driver: l.driver, rows: [] }; groups.push(g); }
    g.rows.push(l);
  }
  const tdsOf = (l) => (hasPct ? n2(l.partner_rate) * pct / 100 : 0);
  const balOf = (l) => n2(l.partner_rate) - n2(l.advance) - tdsOf(l);
  const sum = (rows, f) => rows.reduce((a, l) => a + f(l), 0);

  return (
    <>
      <div style={{ margin: '12px 20px 0', overflowX: 'auto', border: `1px solid ${C.line}`, borderRadius: '10px', maxHeight: '62vh', overflowY: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', minWidth: '1400px', width: '100%', fontSize: '12px' }}>
          <thead>
            <tr>
              <th rowSpan={2} style={{ ...th('n'), minWidth: '170px' }}>Load ID<br /><span style={{ letterSpacing: 0, fontWeight: 500, textTransform: 'none' }}>POD tareekh · route</span></th>
              <th colSpan={4} style={{ ...th('c', 'center'), letterSpacing: '0.12em' }}>◀ CUSTOMER SIDE (hamari aay · office only)</th>
              <th colSpan={7} style={{ ...th('p', 'center'), ...fold, letterSpacing: '0.12em' }}>PARTNER SIDE (hum partner ko) ▶</th>
            </tr>
            <tr>
              <th style={th('c')}>Customer</th><th style={th('c')}>Material · Wt</th><th style={th('c', 'right')}>Customer freight</th><th style={th('c', 'right')}>Margin</th>
              <th style={{ ...th('p', 'right'), ...fold }}>Partner freight</th><th style={th('p', 'right')}>Advance diya</th><th style={th('p')}>Advance date</th>
              <th style={th('p', 'right')}>TDS{hasPct ? ` ${pct}%` : ''}</th><th style={th('p', 'right')}>Balance due</th><th style={th('p')}>POD</th><th style={th('p')}>Khata</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g.truck}>
                <tr><td colSpan={12} style={{ ...td('n'), background: C.raised, color: C.ink, fontWeight: 700, borderTop: `1px solid ${C.line}` }}>
                  🚛 {g.truck} <span style={{ fontWeight: 500, color: C.mut, fontSize: '11px', marginLeft: '8px' }}>market truck{g.driver ? ` · driver ${g.driver}` : ''} · {g.rows.length} load</span>
                </td></tr>
                {g.rows.map((l) => (
                  <tr key={l.settlement_id ?? l.load_id}>
                    <td style={td('n')}>
                      <span style={{ fontFamily: 'monospace', color: C.mkt }}>{l.load_id}</span>
                      <div style={{ fontSize: '10.5px', color: C.dim }}>POD {dmy(l.pod_date)} · {l.origin} → {l.destination}{l.distance_km ? ` · ${n2(l.distance_km)} km` : ''}</div>
                    </td>
                    <td style={td('c')}>{l.customer}<div style={{ fontSize: '10.5px', color: C.dim }}>{l.load_kind === 'CONTRACT' ? 'contract load' : 'market load'}</div></td>
                    <td style={td('c')}>{l.material ?? ''}{l.weight ? ` · ${l.weight}` : ''}</td>
                    <td style={td('c', 'right')}>{l.customer_rate === null || l.customer_rate === undefined ? <span style={{ color: C.warn }}>rate baaki</span> : money(l.customer_rate, C.ink)}</td>
                    <td style={td('c', 'right')}>{l.margin === null || l.margin === undefined ? <span style={{ color: C.dim }}>—</span> : money(l.margin, C.good)}</td>
                    <td style={{ ...td('p', 'right'), ...fold }}>{money(l.partner_rate, C.mkt)}</td>
                    <td style={td('p', 'right')}>{money(l.advance)}</td>
                    <td style={td('p')}>{l.advance_date ? dmy(l.advance_date) + ' · BZADV' : <span style={{ color: C.dim }}>—</span>}</td>
                    <td style={td('p', 'right')}>{hasPct ? money(tdsOf(l)) : <span style={{ color: C.crit }}>rate nahi</span>}</td>
                    <td style={td('p', 'right')}>{money(balOf(l), C.good)}</td>
                    <td style={td('p')}>{l.status === 'SETTLED' ? '💸 settled' : `✅ ${dmy(l.pod_date)}`}</td>
                    <td style={{ ...td('p'), color: C.dim, fontSize: '10.5px' }}>{l.lock_posted ? 'BZLOCK ✓' : 'BZLOCK ✗'} · {l.income_posted ? 'BZINC ✓' : 'BZINC ✗'}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ ...td('n'), ...sub }}>Subtotal for Truck: {g.truck}</td>
                  <td style={{ ...td('c'), ...sub, color: C.dim, fontWeight: 500 }}>{g.rows.length} load</td>
                  <td style={{ ...td('c'), ...sub }} />
                  <td style={{ ...td('c', 'right'), ...sub }}>{money(sum(g.rows, (l) => n2(l.customer_rate)), C.ink, true)}</td>
                  <td style={{ ...td('c', 'right'), ...sub }}>{money(sum(g.rows, (l) => n2(l.margin)), C.good, true)}</td>
                  <td style={{ ...td('p', 'right'), ...sub, ...fold }}>{money(sum(g.rows, (l) => n2(l.partner_rate)), C.mkt, true)}</td>
                  <td style={{ ...td('p', 'right'), ...sub }}>{money(sum(g.rows, (l) => n2(l.advance)), C.ink, true)}</td>
                  <td style={{ ...td('p'), ...sub }} />
                  <td style={{ ...td('p', 'right'), ...sub }}>{money(sum(g.rows, tdsOf), C.ink, true)}</td>
                  <td style={{ ...td('p', 'right'), ...sub }}>{money(sum(g.rows, balOf), C.good, true)}</td>
                  <td style={{ ...td('p'), ...sub }} colSpan={2} />
                </tr>
              </React.Fragment>
            ))}
            <tr>
              <td style={{ ...td('n'), background: C.raised, color: C.ink, fontWeight: 800, fontSize: '13px', borderTop: `2px solid ${C.line}` }}>Total of All Loads · {b.trucks} truck · {b.loads} load</td>
              <td style={{ ...td('c'), background: C.raised, borderTop: `2px solid ${C.line}` }} colSpan={2} />
              <td style={{ ...td('c', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{money(b.freight, C.ink, true)}</td>
              <td style={{ ...td('c', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{b.margin === null ? '—' : money(b.margin, C.good, true)}</td>
              <td style={{ ...td('p', 'right'), ...fold, background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{money(b.partner_freight, C.mkt, true)}</td>
              <td style={{ ...td('p', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{money(b.advances_paid, C.ink, true)}</td>
              <td style={{ ...td('p'), background: C.raised, borderTop: `2px solid ${C.line}` }} />
              <td style={{ ...td('p', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{b.tds === null ? 'rate nahi' : money(b.tds, C.ink, true)}</td>
              <td style={{ ...td('p', 'right'), background: C.raised, fontWeight: 800, borderTop: `2px solid ${C.line}` }}>{b.payable === null ? '—' : money(n2(b.partner_freight) - n2(b.advances_paid) - n2(b.tds), C.good, true)}</td>
              <td style={{ ...td('p'), background: C.raised, borderTop: `2px solid ${C.line}` }} colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
      <p style={{ color: C.dim, fontSize: '11px', margin: '8px 20px 0', lineHeight: 1.6 }}>
        Partner apna diesel, toll, driver khud bharta hai — isliye kharch ke column nahi. TDS 194C poore partner freight par ek baar, is bill par
        {vendor ? ` (${vendor.entity_type === 'FIRM' ? 'firm 2%' : vendor.entity_type === 'INDIVIDUAL' ? 'individual 1%' : vendor.tds_declaration_194c ? '194C(6) declaration — NIL' : vendor.pan_no ? 'individual/firm chuna nahi' : 'PAN nahi — 20%'})` : ''}.
        Customer side aur margin partner ko kabhi nahi dikhta — Print / WhatsApp / Email me sirf partner side jaata hai.
        {running && n2(running.n) > 0 && <> Chal rahe load (POD baaki, is bill me nahi): <b style={{ color: C.ink2 }}>{running.n} · {inr(running.partner_freight)}</b>.</>}
      </p>
      {(editing || billAdj.length > 0) && (
        <div style={{ margin: '10px 20px 0', padding: '10px 14px', border: `1px solid rgba(167,139,250,0.35)`, background: 'rgba(167,139,250,0.05)', borderRadius: '10px' }}>
          {editing ? (
            <AdjustmentEditor adj={billAdj} setAdj={setBillAdj} labels={{ income: '+ Partner ko', expense: '− Kataauti' }} />
          ) : (
            <span style={{ fontSize: '11.5px', color: C.ai }}>✏️ manual: {billAdj.map((a) => `${a.side === 'INCOME' ? '+' : '−'} ${a.label} ${inr(a.amount)}`).join(' · ')}</span>
          )}
        </div>
      )}
    </>
  );
}

function MarketFoot({ b, journal, running, locked }) {
  const rows = [
    ['Partner freight', `${b.loads} load · awarded amount`, b.partner_freight, C.ink],
    ['− Advance pehle diya', 'BZADV voucher, loading par', b.advances_paid, C.ink2],
    ['− TDS 194C' + (b.tds_pct !== null && b.tds_pct !== undefined ? ` ${n2(b.tds_pct)}%` : ''), 'poore partner freight par, ek baar', b.tds, C.ink2],
    n2(b.adj_income) ? ['+ Partner ko (manual)', 'reviewer ne joda', b.adj_income, C.ai] : null,
    n2(b.adj_expense) ? ['− Kataauti (manual)', 'damage, deposit, etc.', b.adj_expense, C.ai] : null,
  ].filter(Boolean);
  const lines = journal?.lines ?? [];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '14px', margin: '14px 20px 0' }}>
      <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '14px 16px' }}>
        <h4 style={{ margin: '0 0 8px', fontSize: '12.5px', color: C.mut, letterSpacing: '.04em' }}>HISAAB — partner ko kitna dena hai</h4>
        {rows.map((r) => (
          <div key={r[0]} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', borderBottom: '1px solid #1b2a4e', fontSize: '13px' }}>
            <span style={{ color: C.ink2 }}>{r[0]} <span style={{ color: C.dim, fontSize: '11px', marginLeft: '6px' }}>{r[1]}</span></span>
            <span style={{ color: r[2] === null ? C.dim : r[3], fontVariantNumeric: 'tabular-nums' }}>{r[2] === null ? '—' : inr2(r[2])}</span>
          </div>
        ))}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '10px 0 0', marginTop: '4px', borderTop: `2px solid ${C.line}`, fontWeight: 800, fontSize: '15px' }}>
          <span style={{ color: C.ink2 }}>Balance bhejna</span>
          <span style={{ color: b.payable === null ? C.dim : C.good, fontVariantNumeric: 'tabular-nums' }}>{b.payable === null ? 'rate ke baad' : inr2(b.payable)}</span>
        </div>
        <div style={{ borderTop: `1px dashed ${C.line}`, marginTop: '8px', paddingTop: '6px' }}>
          {[
            ['Hamari kamai (margin)', 'office only · income − cost, teesri entry nahi', b.margin, C.good],
            ['Customer se lena', 'Market Debtors · POD par posted', b.freight, C.ink2],
            running && n2(running.n) > 0 ? ['Chal rahe load (POD baaki)', 'bill me nahi', running.partner_freight, C.dim] : null,
          ].filter(Boolean).map((r) => (
            <div key={r[0]} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '5px 0', fontSize: '12.5px' }}>
              <span style={{ color: C.ink2 }}>{r[0]} <span style={{ color: C.dim, fontSize: '11px', marginLeft: '6px' }}>{r[1]}</span></span>
              <span style={{ color: r[2] === null ? C.dim : r[3], fontVariantNumeric: 'tabular-nums' }}>{r[2] === null ? '—' : inr2(r[2])}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ background: C.raised, border: `1px solid ${C.line}`, borderRadius: '10px', padding: '14px 16px' }}>
        <h4 style={{ margin: '0 0 8px', fontSize: '12.5px', color: C.mut, letterSpacing: '.04em' }}>
          {locked ? 'JO POST HUA' : 'APPROVE PAR'} — sirf TDS · {b.company_name ?? 'company'} ki books
        </h4>
        {(locked && Array.isArray(b.posted_lines) && b.posted_lines.length ? b.posted_lines : lines).length === 0 ? (
          <div style={{ color: C.dim, fontSize: '12.5px' }}>TDS shunya ya rate baaki — approve sirf lock karega.</div>
        ) : (locked && Array.isArray(b.posted_lines) && b.posted_lines.length ? b.posted_lines : lines).map((l, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '30px 1fr auto', gap: '8px', padding: '5px 0', borderBottom: '1px solid #1b2a4e', fontSize: '12.5px', alignItems: 'baseline' }}>
            <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '11px', color: C.dim }}>{l.dr_cr === 'DR' ? 'Dr' : 'Cr'}</span>
            <span style={{ color: /TDS/.test(l.ledger) ? C.mkt : C.ink2, whiteSpace: 'normal' }}>{l.ledger}<div style={{ fontSize: '10.5px', color: C.dim }}>{l.group}</div></span>
            <span style={{ color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{num2(l.amount)}</span>
          </div>
        ))}
        <h4 style={{ margin: '12px 0 6px', fontSize: '12.5px', color: C.mut, letterSpacing: '.04em' }}>💸 BALANCE BHEJEIN PAR — ek PAYMENT voucher</h4>
        {b.pay_voucher_id ? (
          <div style={{ fontSize: '12.5px', color: C.good }}>Bhej diya {inr2(b.paid_amount)} · {day(b.paid_at)} · {b.paid_by} · saare load SETTLED · partner ko WhatsApp gaya.</div>
        ) : (
          <div style={{ fontSize: '12.5px', color: C.ink2 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '30px 1fr auto', gap: '8px', padding: '4px 0' }}><span style={{ fontFamily: 'monospace', color: C.dim, fontSize: '11px' }}>Dr</span><span>Market Partner: {b.owner_name}</span><span className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>{b.payable === null ? '—' : num2(b.payable)}</span></div>
            <div style={{ display: 'grid', gridTemplateColumns: '30px 1fr auto', gap: '8px', padding: '4px 0' }}><span style={{ fontFamily: 'monospace', color: C.dim, fontSize: '11px' }}>Cr</span><span>Bank / Cash <span style={{ color: C.dim, fontSize: '11px' }}>(bhejte waqt chunna)</span></span><span style={{ fontVariantNumeric: 'tabular-nums' }}>{b.payable === null ? '—' : num2(b.payable)}</span></div>
          </div>
        )}
        <div style={{ color: C.dim, fontSize: '11px', marginTop: '8px', lineHeight: 1.6 }}>
          Pehle se posted: BZLOCK (cost) award par, BZINC (income) POD par, BZADV advance loading par — bill inhe dobara nahi chhoota.
          Refs <span style={{ fontFamily: 'monospace' }}>MBTDS_{b.bill_no}</span> · <span style={{ fontFamily: 'monospace' }}>MBPAY_{b.bill_no}</span>, ek hi baar.
        </div>
      </div>
    </div>
  );
}

// ══ MANUAL ADJUSTMENT, PER LORRY (or per market bill) ══════════════════════
function AdjustmentEditor({ adj, setAdj, labels }) {
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [side, setSide] = useState('EXPENSE');
  const add = () => {
    const a = n2(amount);
    if (!label.trim() || !a) return;
    setAdj([...adj, { label: label.trim(), amount: a, side }]);
    setLabel(''); setAmount('');
  };
  const inp = { background: '#0a1024', border: `1px solid ${C.line}`, borderRadius: '6px', color: C.ink, padding: '4px 8px', fontSize: '11.5px' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      {adj.map((a, i) => (
        <div key={i} style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '11.5px' }}>
          <span style={{ color: a.side === 'INCOME' ? C.good : C.crit, fontWeight: 700, minWidth: '54px' }}>{a.side === 'INCOME' ? (labels?.income ?? '+ AAY') : (labels?.expense ?? '− KHARCH')}</span>
          <span style={{ color: C.ink, flex: 1 }}>{a.label}</span>
          <span style={{ color: C.ink2 }}>{inr2(a.amount)}</span>
          <span onClick={() => setAdj(adj.filter((_, j) => j !== i))} style={{ color: C.dim, cursor: 'pointer' }}>×</span>
        </div>
      ))}
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ color: '#c4b5fd', fontSize: '11px', fontWeight: 700 }}>✏️ Manual</span>
        <select value={side} onChange={(e) => setSide(e.target.value)} style={inp}>
          <option value="EXPENSE">{labels?.expense ?? '− Kharch'}</option><option value="INCOME">{labels?.income ?? '+ Aay'}</option>
        </select>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="detention, bonus…" onKeyDown={(e) => { if (e.key === 'Enter') add(); }} style={{ ...inp, minWidth: '160px' }} />
        <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="₹" onKeyDown={(e) => { if (e.key === 'Enter') add(); }} style={{ ...inp, width: '90px', textAlign: 'right' }} />
        <button onClick={add} style={btn('ai')}>+ Jodein</button>
      </div>
    </div>
  );
}
