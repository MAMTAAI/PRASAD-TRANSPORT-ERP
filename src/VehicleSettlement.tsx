// @ts-nocheck
// ════════════════════════════════════════════════════════════════════════════
// VEHICLE-WISE 15-DAY SETTLEMENT — the fortnight P&L desk
//
// Split screen, the same shape as the HSD reconciliation the staff already
// work: what the lorry EARNED on the left, what it COST on the right, and the
// net between them. Then maker-checker — staff corrects, admin signs.
//
// TWO THINGS THE AUDIT CHANGED BEFORE THIS SCREEN WAS DRAWN, both stated on
// the screen itself rather than buried here:
//
//   1. Income is trips.billed_amount. trips.freight_amount is populated on 21
//      of 1,040 trips and is rate x qty with the kilometres left out — Rs60.07
//      on a trip worth Rs1,33,412. Summing it fleet-wide gives Rs61,591 of
//      income against Rs1.15 crore of cost, and every lorry reads as ruined.
//
//   2. The trip filter is status = 'COMPLETED'. There is no
//      'UNLOADING_COMPLETED' in the register and never has been; filtering on
//      it returns nothing at all.
//
// And one thing this screen deliberately does NOT do: post the whole P&L to the
// ledger. The freight goes to the books through billing and the diesel through
// the pump bill. Approval posts only the manual adjustments, which exist
// nowhere else. The Approve button says so.
// ════════════════════════════════════════════════════════════════════════════
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import GlobalPagination, { usePagination } from './components/GlobalPagination';
import { sendWhatsApp } from './lib/waSend';
import { API_BASE } from './lib/apiBase';
import BillReport from './settlement/BillReport';
import OwnerStatement from './settlement/OwnerStatement';
import CommissionTerms from './settlement/CommissionTerms';

const API = `${API_BASE}/api/v1/vehicle-settlement`;

// Plain fetch on purpose: src/lib/authFetch.ts patches window.fetch and puts
// the bearer on every request. Reading the token here would mean guessing at
// the storage key and going stale the day it changes — and a hand-rolled header
// is exactly how the driver app's uploads ended up 401 (they went out over XHR,
// which the wrapper does not cover; this is fetch, so it is covered).
const apiJson = async (url, opts = {}) => {
  const res = await fetch(url, {
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers || {}),
    },
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.detail || j.error || `HTTP ${res.status}`), { code: j.error });
  return j;
};

const n2 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const inr = (v) => '₹' + n2(v).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inr2 = (v) => '₹' + n2(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const STATUS = {
  AI_DRAFT:       { t: '🤖 AI Draft',       c: '#c4b5fd', bg: 'rgba(167,139,250,0.15)', b: 'rgba(167,139,250,0.5)' },
  STAFF_REVIEWED: { t: '📝 Staff Reviewed', c: '#ffb224', bg: 'rgba(255,178,36,0.15)',  b: 'rgba(255,178,36,0.5)' },
  APPROVED:       { t: '✅ Admin Approved', c: '#2fe39b', bg: 'rgba(47,227,155,0.15)',  b: 'rgba(47,227,155,0.5)' },
};
const NOT_BUILT = { t: '⚪ Nahi bana', c: '#5d7196', bg: 'rgba(93,113,150,0.12)', b: '#27395f' };
const badgeOf = (s) => STATUS[s] ?? NOT_BUILT;

function Badge({ status, small }) {
  const s = badgeOf(status);
  return (
    <span style={{ background: s.bg, color: s.c, border: `1px solid ${s.b}`, borderRadius: '6px',
                   padding: small ? '2px 7px' : '3px 10px', fontSize: small ? '10.5px' : '11.5px',
                   fontWeight: 700, whiteSpace: 'nowrap', display: 'inline-block' }}>
      {s.t}
    </span>
  );
}

// ══ THE SCREEN ══════════════════════════════════════════════════════════════
export default function VehicleSettlement() {
  const [cycles, setCycles] = useState([]);
  const [cycle, setCycle] = useState(null);          // { period_from, ... }
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [openId, setOpenId] = useState(null);
  // LIST is the working screen, BILL is the whole fortnight as one document —
  // the shape of the IOCL transportation bill the owner reads every fortnight.
  const [view, setView] = useState('BILL');

  const loadCycles = useCallback(async () => {
    setErr('');
    try {
      const j = await apiJson(`${API}/cycles`);
      setCycles(j.cycles ?? []);
      // The newest fortnight is the one being worked.
      setCycle((c) => c ?? (j.cycles?.[0] ?? null));
    } catch (e) { setErr(e?.message ?? 'cycle list nahi aayi'); }
  }, []);

  const loadRows = useCallback(async () => {
    if (!cycle?.period_from) return;
    setLoading(true); setErr('');
    try {
      const qs = new URLSearchParams({ period_from: String(cycle.period_from).slice(0, 10) });
      if (statusFilter) qs.set('status', statusFilter);
      const j = await apiJson(`${API}/drafts?${qs}`);
      setRows(j.rows ?? []); setTotals(j.totals ?? {});
    } catch (e) { setErr(e?.message ?? 'list nahi aayi'); setRows([]); }
    setLoading(false);
  }, [cycle, statusFilter]);

  useEffect(() => { loadCycles(); }, [loadCycles]);
  useEffect(() => { loadRows(); }, [loadRows]);

  /** Generate the drafts for this fortnight. Safe to press twice. */
  const build = async () => {
    if (!cycle?.period_from) return;
    setBusy(true);
    try {
      const j = await apiJson(`${API}/build`, {
        method: 'POST',
        body: JSON.stringify({ period_from: String(cycle.period_from).slice(0, 10) }),
      });
      const NL = String.fromCharCode(10);
      alert(`🤖 ${j.created} naye draft bane, ${j.refreshed} refresh hue.` + NL
        + (j.note ? j.note : 'Kisi ka kaam nahi chhua gaya.'));
      await Promise.all([loadRows(), loadCycles()]);
    } catch (e) { alert(`❌ ${e?.message ?? 'draft nahi bane'}`); }
    setBusy(false);
  };

  const pg = usePagination(rows, { defaultSize: 10 });
  useEffect(() => { pg.setPage(1); }, [cycle, statusFilter]);

  const th = { padding: '9px 11px', textAlign: 'left', fontSize: '10px', textTransform: 'uppercase',
               letterSpacing: '0.08em', color: '#5d7196', borderBottom: '1px solid #27395f',
               whiteSpace: 'nowrap' };
  const td = { padding: '10px 11px', borderBottom: '1px solid #18244a', color: '#c4d1ea' };
  const tdR = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

  return (
    <div style={{ padding: '20px', maxWidth: '1500px', margin: '0 auto' }}>

      {/* ── masthead ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px',
                    flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: '18px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'clamp(21px, 4vw, 27px)', color: '#fff' }}>
            🚛 Vehicle 15-Day Settlement
          </h2>
          <p style={{ color: '#9aadd4', fontSize: '12.5px', margin: '5px 0 0', maxWidth: '70ch', lineHeight: 1.55 }}>
            Har lorry ka 15-din ka hisaab — kamai, kharch aur bacha hua paisa. Machine draft
            banati hai, staff sudhaarta hai, admin approve karke lock karta hai.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', border: '1px solid #27395f', borderRadius: '9px',
                        overflow: 'hidden' }}>
            {[['BILL', '📄 Bill Report'], ['OWNER', '👥 Owner Statement'],
              ['TERMS', '💼 Commission'], ['LIST', '📋 Kaam ki list']].map((v) => (
              <button key={v[0]} onClick={() => setView(v[0])}
                style={{ background: view === v[0] ? 'rgba(34,211,238,0.14)' : 'transparent',
                         color: view === v[0] ? '#22d3ee' : '#9aadd4', border: 'none',
                         padding: '10px 15px', fontSize: '12.5px', fontWeight: 700,
                         cursor: 'pointer' }}>
                {v[1]}
              </button>
            ))}
          </div>
          <button onClick={build} disabled={busy || !cycle}
            style={{ background: 'rgba(167,139,250,0.16)', color: '#c4b5fd',
                     border: '1px solid rgba(167,139,250,0.5)', borderRadius: '9px',
                     padding: '10px 17px', fontSize: '13px', fontWeight: 700,
                     cursor: busy ? 'wait' : 'pointer' }}>
            {busy ? '⏳ ban raha hai…' : '🤖 Draft banayein'}
          </button>
        </div>
      </div>

      {/* ── the fortnight picker ─────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '10px', marginBottom: '4px' }}>
        {cycles.map((c) => {
          const on = cycle?.cycle === c.cycle;
          const net = n2(c.net);
          return (
            <button key={c.cycle} onClick={() => setCycle(c)}
              style={{ flex: 'none', textAlign: 'left', minWidth: '178px', cursor: 'pointer',
                       background: on ? 'rgba(34,211,238,0.12)' : 'rgba(18,28,56,0.5)',
                       border: '1px solid ' + (on ? '#22d3ee' : '#27395f'),
                       borderRadius: '10px', padding: '10px 13px' }}>
              <div style={{ color: on ? '#22d3ee' : '#eef3ff', fontWeight: 700, fontSize: '13px' }}>
                {c.cycle_label}
              </div>
              <div style={{ color: '#5d7196', fontSize: '10.5px', marginTop: '2px' }}>
                {c.lorries} lorry · {c.trips} trip
              </div>
              <div style={{ color: net >= 0 ? '#2fe39b' : '#ff6b81', fontSize: '12.5px',
                            fontWeight: 700, marginTop: '4px', fontVariantNumeric: 'tabular-nums' }}>
                {net >= 0 ? '▲' : '▼'} {inr(Math.abs(net))}
              </div>
              {(c.reviewed > 0 || c.approved > 0) && (
                <div style={{ fontSize: '10px', color: '#5d7196', marginTop: '3px' }}>
                  {c.approved > 0 && <span style={{ color: '#2fe39b' }}>✅{c.approved} </span>}
                  {c.reviewed > 0 && <span style={{ color: '#ffb224' }}>📝{c.reviewed}</span>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {err && (
        <p style={{ color: '#ff6b81', fontSize: '13px', background: 'rgba(255,107,129,0.08)',
                    border: '1px solid rgba(255,107,129,0.35)', borderRadius: '8px', padding: '10px 13px' }}>
          {err}
        </p>
      )}

      {/* ── how the income is worked out ─────────────────────────────── */}
      {/* Not a footnote. The number on this screen is different from the one a
          literal reading of "freight" would give, and the desk has to know
          which column it is looking at before they sign anything. */}
      <div style={{ border: '1px solid rgba(34,211,238,0.3)', background: 'rgba(34,211,238,0.05)',
                    borderRadius: '9px', padding: '11px 14px', margin: '4px 0 16px',
                    fontSize: '12px', color: '#9aadd4', lineHeight: 1.6 }}>
        <b style={{ color: '#22d3ee' }}>Aamdani kahan se aa rahi hai:</b>{' '}
        trip ka <b style={{ color: '#eef3ff' }}>billed amount</b> (₹2.91 crore, 765 trip).
        Purana <code style={{ color: '#ffb224' }}>freight_amount</code> column sirf 21 trip par
        bhara hai aur usme kilometre chhoot gaye hain — PT00689 me ₹60.07 likha hai jabki
        trip ₹1,33,412 ka hai. Kharch <b style={{ color: '#eef3ff' }}>HSD + Toll</b> se aata hai;
        maintenance ka abhi koi data nahi hai, isliye wo ₹0 dikhta hai — chhupaya nahi gaya.
      </div>

      {view === 'BILL' && cycle && (
        <BillReport api={API} apiJson={apiJson} Badge={Badge}
                    periodFrom={String(cycle.period_from).slice(0, 10)}
                    onOpen={(id) => id && setOpenId(id)} />
      )}

      {/* Attached and market lorries, grouped by whose they are. An owner with
          eleven lorries reads one sheet, not eleven. */}
      {view === 'OWNER' && cycle && (
        <OwnerStatement api={API} apiJson={apiJson}
                        periodFrom={String(cycle.period_from).slice(0, 10)}
                        onNeedRate={() => setView('TERMS')} />
      )}

      {/* The rates. Defaulted to the fortnight on screen, because a rate dated
          today would not price it and nothing would appear to happen. */}
      {view === 'TERMS' && (
        <CommissionTerms api={API} apiJson={apiJson}
                         defaultFrom={cycle ? String(cycle.period_from).slice(0, 10) : undefined} />
      )}

      {view === 'LIST' && (<>
      {/* ── the cycle's own split screen ─────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
                    gap: '1px', background: '#27395f', border: '1px solid #27395f',
                    borderRadius: '12px', overflow: 'hidden', marginBottom: '18px' }}>
        {[
          ['⬅️ Kamai (Income)', totals.income, '#2fe39b', `${totals.trips ?? 0} trip`],
          ['➡️ Kharch (Expense)', totals.expense, '#ff6b81', 'HSD + Toll + manual'],
          [n2(totals.net) >= 0 ? '💰 Munafa' : '🔻 Ghata', Math.abs(n2(totals.net)),
            n2(totals.net) >= 0 ? '#2fe39b' : '#ff6b81', `${totals.lorries ?? 0} lorry`],
        ].map((t) => (
          <div key={t[0]} style={{ background: 'rgba(18,28,56,0.75)', padding: '15px 17px' }}>
            <div style={{ fontSize: '11px', color: '#9aadd4', marginBottom: '7px' }}>{t[0]}</div>
            <div style={{ fontSize: '25px', fontWeight: 800, color: t[2],
                          fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
              {inr(t[1])}
            </div>
            <div style={{ fontSize: '10.5px', color: '#5d7196', marginTop: '6px' }}>{t[3]}</div>
          </div>
        ))}
        <div style={{ background: 'rgba(18,28,56,0.75)', padding: '15px 17px' }}>
          <div style={{ fontSize: '11px', color: '#9aadd4', marginBottom: '7px' }}>Kahan tak pahuncha</div>
          <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap' }}>
            {[['AI_DRAFT', totals.drafts], ['STAFF_REVIEWED', totals.reviewed],
              ['APPROVED', totals.approved]].map((s) => (
              <button key={s[0]} onClick={() => setStatusFilter(statusFilter === s[0] ? '' : s[0])}
                style={{ background: statusFilter === s[0] ? badgeOf(s[0]).bg : 'transparent',
                         border: `1px solid ${statusFilter === s[0] ? badgeOf(s[0]).b : '#27395f'}`,
                         color: badgeOf(s[0]).c, borderRadius: '7px', padding: '4px 9px',
                         fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                {badgeOf(s[0]).t.split(' ')[0]} {s[1] ?? 0}
              </button>
            ))}
          </div>
          {statusFilter && (
            <button onClick={() => setStatusFilter('')}
              style={{ background: 'none', border: 'none', color: '#5d7196', fontSize: '10.5px',
                       cursor: 'pointer', padding: '6px 0 0', textDecoration: 'underline' }}>
              filter hatayein
            </button>
          )}
        </div>
      </div>

      {/* ── lorry by lorry ───────────────────────────────────────────── */}
      <div className="glass-card" style={{ padding: '16px', overflowX: 'auto' }}>
        {loading ? (
          <p style={{ color: '#ffb224', textAlign: 'center', padding: '26px' }}>Hisaab khul raha hai…</p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#5d7196', textAlign: 'center', padding: '26px', fontSize: '13px' }}>
            Is cycle me koi COMPLETED trip nahi mila.
          </p>
        ) : (
          <>
            <table style={{ width: '100%', minWidth: '1020px', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr>
                  <th style={th}>Lorry</th>
                  <th style={{ ...th, textAlign: 'right' }}>Trip</th>
                  <th style={{ ...th, textAlign: 'right', color: '#2fe39b' }}>Kamai</th>
                  <th style={{ ...th, textAlign: 'right' }}>HSD</th>
                  <th style={{ ...th, textAlign: 'right' }}>Toll</th>
                  <th style={{ ...th, textAlign: 'right' }}>Anya</th>
                  <th style={{ ...th, textAlign: 'right', color: '#ff6b81' }}>Kul kharch</th>
                  <th style={{ ...th, textAlign: 'right' }}>Net</th>
                  <th style={th}>Halat</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {pg.slice.map((r) => {
                  const net = n2(r.net);
                  const other = n2(r.tyre) + n2(r.maintenance) + n2(r.other_expense);
                  return (
                    <tr key={r.vehicle_key + r.period_from}
                        style={{ cursor: r.id ? 'pointer' : 'default' }}
                        onClick={() => r.id && setOpenId(r.id)}
                        title={r.id ? 'Kholne ke liye click karein' : 'Pehle draft banayein'}>
                      <td style={{ ...td, fontWeight: 700, color: '#fff', fontFamily: 'monospace' }}>
                        {r.vehicle_no}
                        <div style={{ fontSize: '10px', color: '#5d7196', fontWeight: 400,
                                      fontFamily: 'system-ui' }}>
                          {r.operating_company}
                        </div>
                      </td>
                      <td style={tdR}>{r.trips_count}</td>
                      <td style={{ ...tdR, color: '#2fe39b', fontWeight: 700 }}>{inr(r.gross_income)}</td>
                      <td style={tdR}>{inr(r.hsd)}</td>
                      <td style={tdR}>{inr(r.toll)}</td>
                      <td style={{ ...tdR, color: other ? '#c4d1ea' : '#3d548a' }}>{inr(other)}</td>
                      <td style={{ ...tdR, color: '#ff6b81' }}>{inr(r.total_expense)}</td>
                      <td style={{ ...tdR, fontWeight: 800, color: net >= 0 ? '#2fe39b' : '#ff6b81' }}>
                        {net >= 0 ? '' : '−'}{inr(Math.abs(net))}
                      </td>
                      <td style={td}>
                        <Badge status={r.status} small />
                        {/* A draft built before a late trip landed. Refreshing
                            it silently would move a reviewer's numbers under
                            them, so it is reported instead. */}
                        {r.stale && (
                          <div style={{ fontSize: '9.5px', color: '#ffb224', marginTop: '3px' }}
                               title={`Ab ${r.live_trips} trip hain, draft me ${r.trips_count}`}>
                            ⚠️ trip badle hain
                          </div>
                        )}
                      </td>
                      <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <span style={{ color: r.id ? '#22d3ee' : '#3d548a', fontSize: '11.5px',
                                       fontWeight: 700 }}>
                          {r.id ? 'Kholein →' : 'draft nahi'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <GlobalPagination {...pg} label="lorry" />
          </>
        )}
      </div>
      </>)}

      {openId && (
        <SettlementDrawer id={openId} onClose={() => setOpenId(null)}
          onChanged={() => { loadRows(); loadCycles(); }} />
      )}
    </div>
  );
}

// ══ ONE LORRY, ONE FORTNIGHT — the split screen and the sign-off ═══════════
//
// Left is what the lorry earned, right is what it cost, and both sides are
// editable while the settlement is unlocked. The trip list underneath is read
// only: if a trip's billed amount is wrong, the trip is wrong, and correcting
// it here would put this statement and the trip register out of step silently.
function SettlementDrawer({ id, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [edits, setEdits] = useState({});
  const [adj, setAdj] = useState([]);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setErr('');
    try {
      const j = await apiJson(`${API}/${id}`);
      setData(j);
      setAdj(Array.isArray(j.settlement.adjustments) ? j.settlement.adjustments : []);
      setNotes(j.settlement.notes ?? '');
      setEdits({});
    } catch (e) { setErr(e?.message ?? 'nahi khula'); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const s = data?.settlement;
  const locked = !!s?.locked_at;

  // Totals recomputed as the reviewer types, because a statement whose header
  // disagrees with its own rows is the thing this screen exists to prevent.
  const live = useMemo(() => {
    if (!s) return null;
    const g = (f) => (edits[f] !== undefined ? n2(edits[f]) : n2(s[f]));
    const adjIn = adj.filter((a) => a.side === 'INCOME').reduce((n, a) => n + n2(a.amount), 0);
    const adjEx = adj.filter((a) => a.side === 'EXPENSE').reduce((n, a) => n + n2(a.amount), 0);
    const income = n2(s.billed_amount) + g('other_income') + adjIn;
    const expense = g('hsd') + g('toll') + g('tyre') + g('maintenance') + g('other_expense') + adjEx;
    return { income, expense, net: income - expense, adjIn, adjEx, g };
  }, [s, edits, adj]);

  const dirty = Object.keys(edits).length > 0
    || JSON.stringify(adj) !== JSON.stringify(s?.adjustments ?? [])
    || notes !== (s?.notes ?? '');

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const j = await apiJson(`${API}/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...edits, adjustments: adj, notes }),
      });
      setData((d) => ({ ...d, settlement: j.settlement }));
      setEdits({});
      onChanged?.();
      alert('💾 Draft save ho gaya. Ledger me kuch nahi gaya — approval par jaayega.');
    } catch (e) { setErr(e?.message ?? 'save nahi hua'); }
    setBusy(false);
  };

  const approve = async () => {
    const net = live?.net ?? 0;
    const NL = String.fromCharCode(10);
    if (!window.confirm(
      `${s.vehicle_no} — ${s.cycle_label}` + NL
      + `${net >= 0 ? 'Munafa' : 'Ghata'}: ${inr2(Math.abs(net))}` + NL + NL
      + `Approve karke LOCK kar dein?` + NL
      + `Ledger me sirf manual adjustment jaayega (${inr2(live.adjEx - live.adjIn)} net).` + NL
      + `Freight aur HSD apne apne flow se jaate hain — dobara post nahi honge.`)) return;
    setBusy(true); setErr('');
    try {
      const j = await apiJson(`${API}/${id}/approve`, { method: 'POST' });
      alert(`✅ Approve ho gaya.` + NL + (j.note ?? ''));
      await load(); onChanged?.();
    } catch (e) {
      setErr(e?.code === 'FORBIDDEN'
        ? 'Approve sirf admin kar sakte hain.'
        : (e?.message ?? 'approve nahi hua'));
    }
    setBusy(false);
  };

  const reopen = async () => {
    if (!window.confirm('Lock kholein? Purana voucher waisa hi rahega.')) return;
    setBusy(true);
    try { await apiJson(`${API}/${id}/reopen`, { method: 'POST' }); await load(); onChanged?.(); }
    catch (e) {
      setErr(e?.code === 'FORBIDDEN' ? 'Reopen sirf admin kar sakte hain.' : (e?.message ?? 'nahi khula'));
    }
    setBusy(false);
  };

  const whatsapp = async () => {
    try {
      const j = await apiJson(`${API}/${id}/summary-text`);
      const phone = window.prompt('Kis number par bhejein? (10 digit)', '');
      if (!phone) return;
      // sendWhatsApp never throws: it posts through the engine when one is
      // online and otherwise opens wa.me, and `via` says which happened.
      const r = await sendWhatsApp({ phone, message: j.text, role: 'OWNER' });
      alert(r?.via === 'server'
        ? '🟢 Bhej diya.'
        : '📱 WhatsApp khul gaya — wahan se bhej dijiye (engine offline hai).');
    } catch (e) { alert(`❌ ${e?.message ?? 'nahi bana'}`); }
  };

  const printSheet = () => {
    if (!s) return;
    const w = window.open('', '_blank');
    if (!w) return;
    const row = (a, b) => `<tr><td>${a}</td><td class="r">${inr2(b)}</td></tr>`;
    w.document.write(`<html><head><title>${s.vehicle_no} — ${s.cycle_label}</title>
      <style>body{font-family:system-ui;margin:26px;color:#111}
      h1{font-size:19px;margin:0 0 3px}h2{font-size:13px;font-weight:600;margin:18px 0 6px;color:#444}
      .sub{color:#666;font-size:12px;margin-bottom:16px}
      table{border-collapse:collapse;width:100%;max-width:560px;font-size:13px}
      td{padding:5px 8px;border-bottom:1px solid #e5e5e5}
      td.r{text-align:right;font-variant-numeric:tabular-nums}
      tr.tot td{font-weight:700;border-top:2px solid #333;border-bottom:none}
      .net{font-size:17px;font-weight:800;margin-top:14px}
      .note{margin-top:20px;font-size:11px;color:#666;max-width:560px;line-height:1.5}</style>
      </head><body>
      <h1>${s.vehicle_no}</h1>
      <div class="sub">${s.cycle_label} · ${s.period_from} – ${s.period_to} · ${s.operating_company ?? ''}<br>
        ${s.trips_count} trip · ${badgeOf(s.status).t}${s.approved_by ? ' by ' + s.approved_by : ''}</div>
      <h2>Kamai</h2><table>
        ${row('Billed (' + s.trips_count + ' trip)', s.billed_amount)}
        ${n2(s.other_income) ? row('Anya aay', s.other_income) : ''}
        ${n2(s.adj_income) ? row('Manual adjustment', s.adj_income) : ''}
        <tr class="tot"><td>Kul kamai</td><td class="r">${inr2(s.gross_income)}</td></tr>
      </table>
      <h2>Kharch</h2><table>
        ${row('HSD (diesel)', s.hsd)}${row('Toll', s.toll)}
        ${n2(s.tyre) ? row('Tyre', s.tyre) : ''}
        ${n2(s.maintenance) ? row('Maintenance', s.maintenance) : ''}
        ${n2(s.other_expense) ? row('Anya', s.other_expense) : ''}
        ${n2(s.adj_expense) ? row('Manual adjustment', s.adj_expense) : ''}
        <tr class="tot"><td>Kul kharch</td><td class="r">${inr2(s.total_expense)}</td></tr>
      </table>
      <div class="net">${n2(s.gross_income) - n2(s.total_expense) >= 0 ? 'Munafa' : 'Ghata'}:
        ${inr2(Math.abs(n2(s.gross_income) - n2(s.total_expense)))}</div>
      <div class="note">Kamai trip ke billed amount se li gayi hai. Ledger me is statement se
        sirf manual adjustment post hota hai — freight aur HSD apne apne flow se jaate hain,
        isliye dobara nahi ginte.</div>
      </body></html>`);
    w.document.close(); w.focus(); w.print();
  };

  const cell = (field, color) => (
    <input value={edits[field] ?? (s?.[field] ?? '')} disabled={locked}
      onChange={(e) => setEdits((x) => ({ ...x, [field]: e.target.value }))}
      style={{ width: '112px', background: locked ? 'transparent' : '#0a1024',
               border: '1px solid ' + (locked ? 'transparent' : '#3d548a'), borderRadius: '5px',
               color: color ?? '#eef3ff', padding: '4px 7px', fontSize: '13px', textAlign: 'right',
               fontVariantNumeric: 'tabular-nums', cursor: locked ? 'default' : 'text' }} />
  );

  const panel = { background: 'rgba(18,28,56,0.6)', border: '1px solid #27395f',
                  borderRadius: '11px', padding: '15px' };
  const line = { display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                 gap: '10px', padding: '6px 0', borderBottom: '1px solid #18244a' };

  return (
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,8,20,0.82)', zIndex: 900,
               display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
               padding: '26px 16px', overflowY: 'auto' }}>
      <div onClick={(e) => e.stopPropagation()} className="glass-card"
        style={{ width: '100%', maxWidth: '1080px', padding: '20px', borderTop: '3px solid #22d3ee' }}>

        {!s ? (
          <p style={{ color: '#9aadd4' }}>{err || 'khul raha hai…'}</p>
        ) : (
          <>
            {/* ── header + the action toolbar ────────────────────────── */}
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '14px',
                          flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <div>
                <h3 style={{ margin: 0, color: '#fff', fontSize: '19px', fontFamily: 'monospace' }}>
                  {s.vehicle_no}
                </h3>
                <div style={{ color: '#9aadd4', fontSize: '12px', marginTop: '4px' }}>
                  {s.cycle_label} · {s.period_from} – {s.period_to} · {s.trips_count} trip
                  {s.operating_company ? ` · ${s.operating_company}` : ''}
                </div>
                <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <Badge status={s.status} />
                  {locked && <span style={{ color: '#5d7196', fontSize: '11px' }}>🔒 lock — {s.approved_by}</span>}
                  {s.voucher_id && <span style={{ color: '#c4b5fd', fontSize: '11px' }}>📘 voucher posted</span>}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {locked ? (
                  <button onClick={reopen} disabled={busy}
                    style={{ background: 'rgba(255,178,36,0.13)', color: '#ffb224',
                             border: '1px solid rgba(255,178,36,0.5)', borderRadius: '8px',
                             padding: '7px 13px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
                    🔓 Reopen
                  </button>
                ) : (
                  <>
                    <button onClick={save} disabled={busy || !dirty}
                      style={{ background: dirty ? '#2fe39b' : 'transparent',
                               color: dirty ? '#0a1024' : '#5d7196',
                               border: '1px solid ' + (dirty ? '#2fe39b' : '#27395f'),
                               borderRadius: '8px', padding: '7px 13px', fontSize: '12px',
                               fontWeight: 700, cursor: dirty ? 'pointer' : 'not-allowed' }}>
                      💾 Save
                    </button>
                    <button onClick={approve} disabled={busy}
                      title="Sirf admin. Ledger me manual adjustment hi jaata hai."
                      style={{ background: 'rgba(47,227,155,0.15)', color: '#2fe39b',
                               border: '1px solid rgba(47,227,155,0.55)', borderRadius: '8px',
                               padding: '7px 13px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
                      ✅ Approve & Lock
                    </button>
                  </>
                )}
                <button onClick={printSheet}
                  style={{ background: 'transparent', color: '#9aadd4', border: '1px solid #3d548a',
                           borderRadius: '8px', padding: '7px 13px', fontSize: '12px',
                           fontWeight: 700, cursor: 'pointer' }}>
                  🖨️ Print P&L
                </button>
                <button onClick={whatsapp}
                  style={{ background: 'rgba(47,227,155,0.12)', color: '#2fe39b',
                           border: '1px solid rgba(47,227,155,0.45)', borderRadius: '8px',
                           padding: '7px 13px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
                  🟢 WhatsApp
                </button>
                <button onClick={onClose}
                  style={{ background: 'transparent', color: '#5d7196', border: '1px solid #27395f',
                           borderRadius: '8px', padding: '7px 12px', fontSize: '12px', cursor: 'pointer' }}>
                  ✕
                </button>
              </div>
            </div>

            {err && <p style={{ color: '#ff6b81', fontSize: '12.5px', marginTop: '12px' }}>{err}</p>}

            {/* ── SPLIT SCREEN ──────────────────────────────────────── */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))',
                          gap: '14px', marginTop: '18px' }}>

              {/* LEFT — what it earned */}
              <div style={{ ...panel, borderLeft: '3px solid #2fe39b' }}>
                <h4 style={{ margin: '0 0 10px', color: '#2fe39b', fontSize: '13.5px' }}>
                  ⬅️ Kamai
                </h4>
                <div style={line}>
                  <span style={{ color: '#c4d1ea', fontSize: '13px' }}>
                    Billed <span style={{ color: '#5d7196', fontSize: '11px' }}>({s.trips_count} trip)</span>
                  </span>
                  <span style={{ color: '#eef3ff', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {inr2(s.billed_amount)}
                  </span>
                </div>
                <div style={{ ...line, color: '#5d7196' }}>
                  <span style={{ fontSize: '12px' }}>
                    Vasool hua <span style={{ fontSize: '10.5px' }}>(hisaab me nahi)</span>
                  </span>
                  <span style={{ fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
                    {inr2(s.received_amount)}
                  </span>
                </div>
                <div style={line}>
                  <span style={{ color: '#c4d1ea', fontSize: '13px' }}>Anya aay</span>
                  {cell('other_income', '#2fe39b')}
                </div>
                {live?.adjIn > 0 && (
                  <div style={line}>
                    <span style={{ color: '#c4b5fd', fontSize: '12.5px' }}>Manual adjustment</span>
                    <span style={{ color: '#c4b5fd', fontVariantNumeric: 'tabular-nums' }}>
                      {inr2(live.adjIn)}
                    </span>
                  </div>
                )}
                <div style={{ ...line, borderBottom: 'none', borderTop: '2px solid #27395f',
                              marginTop: '6px', paddingTop: '10px' }}>
                  <b style={{ color: '#2fe39b', fontSize: '13px' }}>Kul kamai</b>
                  <b style={{ color: '#2fe39b', fontSize: '16px', fontVariantNumeric: 'tabular-nums' }}>
                    {inr2(live?.income)}
                  </b>
                </div>
              </div>

              {/* RIGHT — what it cost */}
              <div style={{ ...panel, borderLeft: '3px solid #ff6b81' }}>
                <h4 style={{ margin: '0 0 10px', color: '#ff6b81', fontSize: '13.5px' }}>
                  ➡️ Kharch
                </h4>
                {[['hsd', 'HSD (diesel)'], ['toll', 'Toll'], ['tyre', 'Tyre'],
                  ['maintenance', 'Maintenance'], ['other_expense', 'Anya kharch']].map((f) => (
                  <div key={f[0]} style={line}>
                    <span style={{ color: '#c4d1ea', fontSize: '13px' }}>
                      {f[1]}
                      {/* Said out loud rather than shown as a plain zero: no
                          maintenance line exists in the whole register yet. */}
                      {f[0] === 'maintenance' && !n2(s.maintenance) && (
                        <span style={{ color: '#5d7196', fontSize: '10.5px' }}> · data nahi hai</span>
                      )}
                    </span>
                    {cell(f[0])}
                  </div>
                ))}
                {live?.adjEx > 0 && (
                  <div style={line}>
                    <span style={{ color: '#c4b5fd', fontSize: '12.5px' }}>Manual adjustment</span>
                    <span style={{ color: '#c4b5fd', fontVariantNumeric: 'tabular-nums' }}>
                      {inr2(live.adjEx)}
                    </span>
                  </div>
                )}
                <div style={{ ...line, borderBottom: 'none', borderTop: '2px solid #27395f',
                              marginTop: '6px', paddingTop: '10px' }}>
                  <b style={{ color: '#ff6b81', fontSize: '13px' }}>Kul kharch</b>
                  <b style={{ color: '#ff6b81', fontSize: '16px', fontVariantNumeric: 'tabular-nums' }}>
                    {inr2(live?.expense)}
                  </b>
                </div>
              </div>
            </div>

            {/* ── the number the whole screen is for ─────────────────── */}
            <div style={{ marginTop: '14px', padding: '15px 18px', borderRadius: '11px',
                          background: (live?.net ?? 0) >= 0 ? 'rgba(47,227,155,0.09)' : 'rgba(255,107,129,0.09)',
                          border: '1px solid ' + ((live?.net ?? 0) >= 0 ? 'rgba(47,227,155,0.4)' : 'rgba(255,107,129,0.4)'),
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          gap: '12px', flexWrap: 'wrap' }}>
              <span style={{ color: '#9aadd4', fontSize: '13px' }}>
                {(live?.net ?? 0) >= 0 ? '💰 Is 15 din ka munafa' : '🔻 Is 15 din ka ghata'}
              </span>
              <b style={{ fontSize: '27px', fontVariantNumeric: 'tabular-nums',
                          color: (live?.net ?? 0) >= 0 ? '#2fe39b' : '#ff6b81' }}>
                {inr2(Math.abs(live?.net ?? 0))}
              </b>
            </div>

            {/* ── manual adjustments ────────────────────────────────── */}
            <AdjustmentEditor adj={adj} setAdj={setAdj} locked={locked} />

            <div style={{ marginTop: '12px' }}>
              <label style={{ fontSize: '11px', color: '#9aadd4' }}>Note</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} disabled={locked}
                rows={2} placeholder="Kuch likhna ho to yahan…"
                style={{ width: '100%', background: '#0a1024', border: '1px solid #27395f',
                         borderRadius: '8px', color: '#eef3ff', padding: '8px 10px',
                         fontSize: '12.5px', marginTop: '4px', resize: 'vertical' }} />
            </div>

            {/* ── the trips it is built from ────────────────────────── */}
            <h4 style={{ margin: '20px 0 8px', color: '#9aadd4', fontSize: '12.5px',
                         textTransform: 'uppercase', letterSpacing: '0.08em' }}>
              Is hisaab ke trip ({data.trips.length})
            </h4>
            <div style={{ overflowX: 'auto', border: '1px solid #27395f', borderRadius: '9px' }}>
              <table style={{ width: '100%', minWidth: '760px', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr>
                    {['Trip', 'Tareekh', 'Customer', 'Billed', 'HSD', 'Toll', 'Kharch', 'Net'].map((h, i) => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: i >= 3 ? 'right' : 'left',
                                           fontSize: '10px', textTransform: 'uppercase',
                                           letterSpacing: '0.07em', color: '#5d7196',
                                           borderBottom: '1px solid #27395f', whiteSpace: 'nowrap' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.trips.map((t) => {
                    const net = n2(t.billed_amount) - n2(t.expense_total);
                    return (
                      <tr key={t.trip_id}>
                        <td style={{ padding: '8px 10px', borderBottom: '1px solid #18244a',
                                     color: '#22d3ee', fontFamily: 'monospace' }}>{t.trip_code}</td>
                        <td style={{ padding: '8px 10px', borderBottom: '1px solid #18244a',
                                     color: '#9aadd4', whiteSpace: 'nowrap' }}>
                          {t.unloading_date ?? t.loading_date}
                        </td>
                        <td style={{ padding: '8px 10px', borderBottom: '1px solid #18244a',
                                     color: '#c4d1ea', maxWidth: '190px', overflow: 'hidden',
                                     textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t.customer_name}
                        </td>
                        {[t.billed_amount, t.hsd, t.toll, t.expense_total].map((v, i) => (
                          <td key={i} style={{ padding: '8px 10px', borderBottom: '1px solid #18244a',
                                               textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                               color: i === 0 ? '#2fe39b' : '#c4d1ea' }}>
                            {inr(v)}
                          </td>
                        ))}
                        <td style={{ padding: '8px 10px', borderBottom: '1px solid #18244a',
                                     textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                     fontWeight: 700, color: net >= 0 ? '#2fe39b' : '#ff6b81' }}>
                          {net >= 0 ? '' : '−'}{inr(Math.abs(net))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p style={{ color: '#5d7196', fontSize: '11px', marginTop: '12px', lineHeight: 1.6 }}>
              Trip ke aankde yahan se badle nahi jaa sakte — agar trip galat hai to Trip
              Management me sudhaariye, warna yeh statement aur trip register alag-alag ho
              jaayenge. Yahan sirf kharch ke bucket aur manual adjustment badalte hain.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ══ MANUAL ADJUSTMENTS — the only part that reaches the ledger ══════════════
function AdjustmentEditor({ adj, setAdj, locked }) {
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [side, setSide] = useState('EXPENSE');

  const add = () => {
    const a = n2(amount);
    if (!label.trim() || !a) return;
    setAdj([...adj, { label: label.trim(), amount: a, side }]);
    setLabel(''); setAmount('');
  };

  return (
    <div style={{ marginTop: '14px', border: '1px solid rgba(167,139,250,0.35)',
                  background: 'rgba(167,139,250,0.05)', borderRadius: '11px', padding: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px',
                    flexWrap: 'wrap', alignItems: 'baseline', marginBottom: '9px' }}>
        <b style={{ color: '#c4b5fd', fontSize: '13px' }}>✏️ Manual adjustment</b>
        <span style={{ color: '#5d7196', fontSize: '11px' }}>
          Sirf yahi ledger me jaata hai — baaki sab apne flow se already jaata hai
        </span>
      </div>

      {adj.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginBottom: '10px' }}>
          {adj.map((a, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '9px',
                                  padding: '5px 9px', background: 'rgba(10,16,36,0.6)',
                                  borderRadius: '7px', fontSize: '12.5px' }}>
              <span style={{ color: a.side === 'INCOME' ? '#2fe39b' : '#ff6b81', fontWeight: 700,
                             fontSize: '10.5px', minWidth: '52px' }}>
                {a.side === 'INCOME' ? '+ AAY' : '− KHARCH'}
              </span>
              <span style={{ color: '#eef3ff', flex: 1 }}>{a.label}</span>
              <span style={{ color: '#c4d1ea', fontVariantNumeric: 'tabular-nums' }}>{inr2(a.amount)}</span>
              {!locked && (
                <button onClick={() => setAdj(adj.filter((_, j) => j !== i))}
                  style={{ background: 'none', border: 'none', color: '#5d7196', cursor: 'pointer',
                           fontSize: '14px', padding: '0 2px' }} title="Hataayein">×</button>
              )}
            </div>
          ))}
        </div>
      )}

      {!locked && (
        <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={side} onChange={(e) => setSide(e.target.value)}
            style={{ background: '#0a1024', border: '1px solid #3d548a', borderRadius: '6px',
                     color: '#eef3ff', padding: '6px 8px', fontSize: '12px' }}>
            <option value="EXPENSE">− Kharch</option>
            <option value="INCOME">+ Aay</option>
          </select>
          <input value={label} onChange={(e) => setLabel(e.target.value)}
            placeholder="Kis cheez ka? (jaise: driver bonus, detention)"
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            style={{ flex: 1, minWidth: '210px', background: '#0a1024', border: '1px solid #3d548a',
                     borderRadius: '6px', color: '#eef3ff', padding: '6px 9px', fontSize: '12.5px' }} />
          <input value={amount} onChange={(e) => setAmount(e.target.value)}
            placeholder="₹" onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
            style={{ width: '110px', background: '#0a1024', border: '1px solid #3d548a',
                     borderRadius: '6px', color: '#eef3ff', padding: '6px 9px', fontSize: '12.5px',
                     textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} />
          <button onClick={add}
            style={{ background: 'rgba(167,139,250,0.18)', color: '#c4b5fd',
                     border: '1px solid rgba(167,139,250,0.5)', borderRadius: '7px',
                     padding: '6px 13px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>
            + Jodein
          </button>
        </div>
      )}
    </div>
  );
}
