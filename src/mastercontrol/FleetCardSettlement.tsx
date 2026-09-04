// @ts-nocheck
// ============================================================================
// FLEET CARD & SETTLEMENT — the milan desk
//
// THE RULE THIS SCREEN EXISTS FOR (owner, 4-Sep-2026): a card swipe is often
// used to pay off an accumulated 15-day pump credit bill, not one trip's fill.
// So the machine places only what it is certain of — same lorry, date within a
// day, litres AND rupees exactly equal — and everything else waits here for a
// person, in the clearing account, visibly.
//
// An unallocated swipe is NOT an error. It is work, and this is the work list.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CreditCard, Fuel, Receipt, Truck, Split, Ban, Search, X, Filter,
  AlertTriangle, CheckCircle2, Loader2, Undo2, Wand2, ChevronRight, Building2, Download,
} from 'lucide-react';
import { GlassPanel, PanelHeader, StatusPill } from './shared';
import { API_BASE } from '../lib/apiBase';

const API = `${API_BASE}/api/v1/fleet-card`;

// ── money, the way the office reads it ──────────────────────────────────────
const inr = (n) => {
  const v = Number(n) || 0;
  return `₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
};
const inrFull = (n) =>
  `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');
const dayLong = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

// Why a swipe is waiting. The wording is the desk's, not the database's — a
// clerk should not have to learn what MEMO_NEARBY_NOT_EXACT means.
const REASONS = {
  LIKELY_BILL_SETTLEMENT: {
    label: '15-din bill settlement',
    tone: 'text-violet-300 border-violet-400/40 bg-violet-500/10',
    hint: 'Is swipe ki tareekh ek pump bill ke andar aati hai — shayad poora bill chukaya gaya hai, ek bharai nahi.',
  },
  MEMO_NEARBY_NOT_EXACT: {
    label: 'Memo paas hai, milta nahi',
    tone: 'text-amber-300 border-amber-400/40 bg-amber-500/10',
    hint: 'Us lorry ka memo aas-paas hai par litre ya rupaye bilkul nahi milte.',
  },
  EXACT_BUT_CONTESTED: {
    label: 'Do swipe, ek memo',
    tone: 'text-sky-300 border-sky-400/40 bg-sky-500/10',
    hint: 'Memo bilkul milta hai — par doosri swipe bhi wahi memo maang rahi hai. Aadmi hi bata sakta hai.',
  },
  NO_VEHICLE: {
    label: 'Lorry nahi mili',
    tone: 'text-yellow-300 border-yellow-400/40 bg-yellow-500/10',
    hint: 'Card par jo likha hai wo fleet master me nahi hai — ya wo firm ke naam ka pooled card hai.',
  },
  NO_MEMO: {
    label: 'Memo nahi hai',
    tone: 'text-rose-300 border-rose-400/40 bg-rose-500/10',
    hint: 'Us lorry ka koi memo aas-paas nahi hai.',
  },
};

const TARGETS = {
  PUMP_BILL:   { label: '15-din pump bill', icon: Receipt },
  TRIP:        { label: 'Trip',             icon: Truck },
  FUEL_ENTRY:  { label: 'Fuel memo',        icon: Fuel },
  REVIEW_SLIP: { label: 'Parked slip',      icon: Filter },
  WRITE_OFF:   { label: 'Write off',        icon: Ban },
};

async function api(path, opts) {
  const res = await fetch(`${API}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(body.detail || body.error || `HTTP ${res.status}`);
    e.code = body.error;
    throw e;
  }
  return body;
}

// ── a reason chip ───────────────────────────────────────────────────────────
function ReasonPill({ reason }) {
  const r = REASONS[reason] ?? { label: reason, tone: 'text-slate-300 border-slate-500/40 bg-slate-500/10' };
  return (
    <span
      title={r.hint}
      className={`inline-block rounded-full border px-2 py-[2px] text-[10px] font-semibold tracking-wide whitespace-nowrap ${r.tone}`}
    >
      {r.label}
    </span>
  );
}

// ══ THE ALLOCATION DRAWER ═══════════════════════════════════════════════════
//
// One swipe, and everything it could belong to. The three candidate lists are
// deliberately separate rather than one ranked list: they are three different
// KINDS of answer, and a clerk choosing between "a bill" and "a memo" is making
// a real decision about what this money was, not picking the top row.
function AllocateDrawer({ txnId, onClose, onDone }) {
  const [data, setData] = useState(null);
  const [existing, setExisting] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [picked, setPicked] = useState(null);   // { kind, id, label }

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [c, a] = await Promise.all([
        api(`/candidates/${txnId}`),
        api(`/allocations?txn_id=${txnId}`),
      ]);
      setData(c);
      setExisting(a.allocations ?? []);
      setAmount(String(c.txn.unallocated ?? ''));
    } catch (e) { setErr(e.message); }
  }, [txnId]);

  useEffect(() => { load(); }, [load]);

  // Escape closes. A drawer that traps the clerk is a drawer they stop opening.
  useEffect(() => {
    const h = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const t = data?.txn;
  const remaining = Number(t?.unallocated ?? 0);

  const submit = async () => {
    if (!picked) return;
    const amt = Number(amount);
    if (!(amt > 0)) { setErr('Kitna paisa lagana hai, wo likhna hoga.'); return; }
    if (amt > remaining + 0.005) {
      setErr(`Is swipe me sirf ${inrFull(remaining)} bacha hai.`);
      return;
    }
    if (picked.kind === 'WRITE_OFF' && !note.trim()) {
      setErr('Write off ka kaaran likhna zaroori hai — is paise ko phir koi nahi dhoondhega.');
      return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await api('/allocations', {
        method: 'POST',
        body: JSON.stringify({
          txn_id: txnId, target_kind: picked.kind,
          target_id: picked.kind === 'WRITE_OFF' ? null : picked.id,
          amount: amt, note: note.trim() || null,
        }),
      });
      if (Number(r.still_unallocated) > 0.005) {
        // Partly placed — stay open so the rest can go somewhere else. This is
        // the settlement case: one swipe across two fortnights.
        setPicked(null); setNote('');
        await load();
        onDone({ quiet: true });
      } else {
        onDone({ quiet: false });
        onClose();
      }
    } catch (e) {
      setErr(e.code === 'OVER_ALLOCATION'
        ? `Itna paisa is swipe me nahi hai. ${e.message}`
        : e.message);
      await load();
    } finally { setBusy(false); }
  };

  const undo = async (id) => {
    setBusy(true);
    try { await api(`/allocations/${id}`, { method: 'DELETE' }); await load(); onDone({ quiet: true }); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const Row = ({ active, onClick, children }) => (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border px-3 py-2 transition
        ${active
          ? 'border-cyan-400/70 bg-cyan-500/10'
          : 'border-slate-700/70 bg-slate-900/40 hover:border-slate-500'}`}
    >
      {children}
    </button>
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/70 backdrop-blur-sm">
      <div className="h-full w-full max-w-2xl overflow-y-auto border-l border-slate-700 bg-[#0d1530] shadow-2xl">

        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-slate-700 bg-[#0d1530]/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Swipe kahan lagani hai
            </div>
            {t && (
              <>
                <div className="mt-1 truncate text-lg font-semibold text-slate-100">
                  {t.merchant_name || '—'}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-slate-400">
                  <span>{dayLong(t.txn_date)}</span>
                  <span className="font-mono text-slate-300">{t.vehicle_no || t.vehicle_raw || '—'}</span>
                  <span>{Number(t.quantity).toFixed(2)} L</span>
                  <span className="font-mono">@ {Number(t.rate).toFixed(2)}</span>
                  <ReasonPill reason={t.reason} />
                </div>
              </>
            )}
          </div>
          <button onClick={onClose} className="shrink-0 rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-slate-200">
            <X size={18} />
          </button>
        </div>

        {t && (
          <div className="grid grid-cols-3 gap-px border-b border-slate-700 bg-slate-700/60">
            {[
              ['Swipe', inrFull(t.amount), 'text-slate-100'],
              ['Lag chuka', inrFull(t.allocated), 'text-emerald-300'],
              ['Bacha hua', inrFull(t.unallocated), 'text-amber-300'],
            ].map(([k, v, c]) => (
              <div key={k} className="bg-[#0d1530] px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{k}</div>
                <div className={`mt-1 font-mono text-[15px] font-semibold tabular-nums ${c}`}>{v}</div>
              </div>
            ))}
          </div>
        )}

        {err && (
          <div className="mx-5 mt-4 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200">
            <AlertTriangle size={15} className="mt-[2px] shrink-0" />
            <span>{err}</span>
          </div>
        )}

        {!data && !err && (
          <div className="flex items-center gap-2 px-5 py-10 text-slate-400">
            <Loader2 size={16} className="animate-spin" /> Candidates dhoond raha hoon…
          </div>
        )}

        {existing.length > 0 && (
          <div className="px-5 pt-5">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">
              Pehle se laga hua
            </div>
            <div className="space-y-1.5">
              {existing.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-700/70 bg-slate-900/40 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] text-slate-200">{a.target_label}</div>
                    <div className="text-[11px] text-slate-500">
                      {TARGETS[a.target_kind]?.label ?? a.target_kind}
                      {a.method === 'AUTO_EXACT' ? ' · apne aap' : ` · ${a.allocated_by || 'desk'}`}
                      {a.note ? ` · ${a.note}` : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-[13px] tabular-nums text-emerald-300">{inrFull(a.amount)}</span>
                    <button
                      onClick={() => undo(a.id)}
                      disabled={busy}
                      title="Hata dein"
                      className="rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-rose-300 disabled:opacity-40"
                    >
                      <Undo2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {data && (
          <div className="space-y-6 px-5 py-5">

            {/* the settlement case, first — it is the one the owner named */}
            <section>
              <div className="mb-2 flex items-center gap-2">
                <Receipt size={14} className="text-violet-300" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-300">
                  15-din ke pump bill
                </span>
                <span className="text-[11px] text-slate-500">({data.candidates.pump_bills.length})</span>
              </div>
              {data.candidates.pump_bills.length === 0 && (
                <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-3 text-[12px] text-slate-500">
                  Is tareekh ke aas-paas koi pump bill nahi hai.
                </div>
              )}
              <div className="space-y-1.5">
                {data.candidates.pump_bills.map((b) => (
                  <Row
                    key={b.id}
                    active={picked?.kind === 'PUMP_BILL' && picked.id === b.id}
                    onClick={() => setPicked({ kind: 'PUMP_BILL', id: b.id })}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-slate-200">
                          {b.vendor_name} <span className="text-slate-500">· {b.ref_no}</span>
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {day(b.period_from)} – {dayLong(b.period_to)} · {b.slip_count ?? 0} slip · {b.status}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="font-mono text-[13px] tabular-nums text-slate-200">
                          {inr(b.physical_amount ?? b.system_amount)}
                        </div>
                        {Number(b.already_paid) > 0 && (
                          <div className="font-mono text-[10.5px] tabular-nums text-emerald-400">
                            {inr(b.already_paid)} paid · {inr(b.still_due)} baki
                          </div>
                        )}
                      </div>
                    </div>
                  </Row>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center gap-2">
                <Fuel size={14} className="text-cyan-300" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-300">
                  Us lorry ke memo
                </span>
                <span className="text-[11px] text-slate-500">({data.candidates.memos.length})</span>
              </div>
              {data.candidates.memos.length === 0 && (
                <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-3 text-[12px] text-slate-500">
                  {t?.vehicle_no
                    ? 'Saat din ke andar us lorry ka koi memo nahi.'
                    : 'Card par lorry likhi hi nahi hai, isliye memo dhoondha nahi ja sakta.'}
                </div>
              )}
              <div className="space-y-1.5">
                {data.candidates.memos.map((m) => (
                  <Row
                    key={m.id}
                    active={picked?.kind !== 'WRITE_OFF' && picked?.id === (m.trip_id || m.id)}
                    onClick={() => setPicked({ kind: m.trip_id ? 'TRIP' : 'FUEL_ENTRY', id: m.trip_id || m.id })}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-slate-200">
                            {m.memo_no || '(memo no nahi)'} <span className="text-slate-500">· {m.vendor_name}</span>
                          </span>
                          {m.exact && (
                            <span className="rounded-full border border-emerald-400/40 bg-emerald-500/10 px-1.5 py-[1px] text-[9.5px] font-semibold text-emerald-300">
                              BILKUL MILTA HAI
                            </span>
                          )}
                          {m.already_claimed && (
                            <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-1.5 py-[1px] text-[9.5px] font-semibold text-amber-300">
                              PEHLE SE LAGA
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {dayLong(m.entry_date)} · {Number(m.liters).toFixed(2)} L
                          {m.trip_code ? ` · Trip ${m.trip_code}` : ' · trip se juda nahi'}
                        </div>
                      </div>
                      <div className="shrink-0 font-mono text-[13px] tabular-nums text-slate-200">
                        {inr(m.amount)}
                      </div>
                    </div>
                  </Row>
                ))}
              </div>
            </section>

            <section>
              <div className="mb-2 flex items-center gap-2">
                <Filter size={14} className="text-amber-300" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-300">
                  Import review me parked slip
                </span>
                <span className="text-[11px] text-slate-500">({data.candidates.parked_slips.length})</span>
              </div>
              <div className="space-y-1.5">
                {data.candidates.parked_slips.length === 0 && (
                  <div className="rounded-lg border border-slate-800 bg-slate-900/30 px-3 py-3 text-[12px] text-slate-500">
                    Aas-paas koi parked slip nahi.
                  </div>
                )}
                {data.candidates.parked_slips.map((s) => (
                  <Row
                    key={s.id}
                    active={picked?.kind === 'REVIEW_SLIP' && picked.id === s.id}
                    onClick={() => setPicked({ kind: 'REVIEW_SLIP', id: s.id })}
                  >
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium text-slate-200">
                          {s.memo_no || '(memo no nahi)'} <span className="text-slate-500">· {s.pump}</span>
                        </div>
                        <div className="text-[11px] text-slate-500">
                          {dayLong(s.entry_date)} · {s.vehicle_raw || '—'} · {Number(s.qty || 0).toFixed(2)} L
                        </div>
                      </div>
                      <div className="shrink-0 font-mono text-[13px] tabular-nums text-slate-200">
                        {inr(s.amount)}
                      </div>
                    </div>
                  </Row>
                ))}
              </div>
            </section>

            <section>
              <Row
                active={picked?.kind === 'WRITE_OFF'}
                onClick={() => setPicked({ kind: 'WRITE_OFF', id: null })}
              >
                <div className="flex items-center gap-2">
                  <Ban size={14} className="text-rose-300" />
                  <span className="text-[13px] text-slate-200">Write off — yah paisa hamara nahi hai</span>
                </div>
                <div className="mt-0.5 text-[11px] text-slate-500">
                  Kaaran likhna zaroori hai. Iske baad koi ise nahi dhoondhega.
                </div>
              </Row>
            </section>
          </div>
        )}

        {/* the action bar sticks, so a long candidate list never hides it */}
        {data && (
          <div className="sticky bottom-0 border-t border-slate-700 bg-[#0d1530]/95 px-5 py-4 backdrop-blur">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex-1 min-w-[140px]">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  Kitna lagana hai
                </span>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-[14px] tabular-nums text-slate-100 outline-none focus:border-cyan-400"
                />
              </label>
              <label className="flex-[2] min-w-[180px]">
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                  Note {picked?.kind === 'WRITE_OFF' ? '(zaroori)' : '(optional)'}
                </span>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={picked?.kind === 'WRITE_OFF' ? 'Kyun write off kar rahe hain?' : ''}
                  className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-[13px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400"
                />
              </label>
              <button
                onClick={submit}
                disabled={!picked || busy}
                className="rounded-lg bg-cyan-500 px-5 py-2 text-[13px] font-semibold text-slate-950 transition hover:bg-cyan-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
              >
                {busy ? <Loader2 size={15} className="animate-spin" /> : 'Laga do'}
              </button>
            </div>
            {!picked && (
              <div className="mt-2 text-[11.5px] text-slate-500">
                Upar se ek bill, memo ya slip chunein.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ══ TABLE FURNITURE, THE WAY THE OIL COMPANY'S OWN PORTAL DOES IT ═══════════
//
// The owner asked for this explicitly, pointing at the IOCL XTRAPOWER portal:
// ten rows at a time, newest first, "Total N records found", a sort arrow on
// every column, and Prev / 1 2 3 … / Next with a page-size box and a jump-to.
// The staff already read that layout every day on the portal — matching it
// means there is nothing new to learn here, which for a screen someone works
// 300 rows through is worth more than any novelty.
//
// The paging is SERVER-side. A thousand rows shipped to the browser so it can
// show ten is how a queue screen becomes the slowest page in the app.

/** One sortable column header. Click to sort; click again to flip. */
function Th({ col, sort, dir, onSort, align = 'left', children }) {
  const active = sort === col;
  return (
    <th
      onClick={col ? () => onSort(col) : undefined}
      className={`py-2 pr-3 text-[10px] font-semibold uppercase tracking-[0.1em] whitespace-nowrap
        ${align === 'right' ? 'text-right' : 'text-left'}
        ${col ? 'cursor-pointer select-none hover:text-slate-300' : ''}
        ${active ? 'text-cyan-300' : 'text-slate-500'}`}
    >
      {children}
      {col && (
        <span className={`ml-1 inline-block ${active ? 'opacity-100' : 'opacity-30'}`}>
          {active && dir === 'asc' ? '▲' : '▼'}
        </span>
      )}
    </th>
  );
}

/**
 * The pager, laid out like the portal's: « Prev  1 2 3 … N  Next »  [10 ▾]  [__] Go
 *
 * The window of page numbers slides so the current page keeps its neighbours;
 * first and last are always reachable, because "go to the oldest" is a real
 * thing a clerk wants and 100 clicks is not a way to get there.
 */
function Pager({ page, pages, size, total, onPage, onSize }) {
  const [jump, setJump] = useState('');
  const win = useMemo(() => {
    const out = [];
    const span = 2;
    const lo = Math.max(1, Math.min(page - span, pages - span * 2));
    const hi = Math.min(pages, Math.max(page + span, span * 2 + 1));
    if (lo > 1) out.push(1);
    if (lo > 2) out.push('…');
    for (let i = lo; i <= hi; i += 1) out.push(i);
    if (hi < pages - 1) out.push('…');
    if (hi < pages) out.push(pages);
    return out;
  }, [page, pages]);

  const go = () => {
    const n = Number(jump);
    if (Number.isFinite(n) && n >= 1 && n <= pages) { onPage(n); setJump(''); }
  };

  const btn = (extra) =>
    `min-w-[28px] rounded-md border px-2 py-[3px] text-[11.5px] font-semibold transition ${extra}`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/70 px-1 pt-3">
      <div className="text-[11.5px] text-slate-500">
        {total === 0
          ? 'Koi record nahi'
          : <>Showing <b className="font-mono text-slate-300">{(page - 1) * size + 1}</b>
             –<b className="font-mono text-slate-300">{Math.min(page * size, total)}</b>
             {' '}of <b className="font-mono text-slate-300">{total.toLocaleString('en-IN')}</b></>}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => onPage(page - 1)} disabled={page <= 1}
          className={btn('border-slate-600 text-slate-300 hover:border-slate-400 disabled:opacity-35 disabled:hover:border-slate-600')}
        >
          « Prev
        </button>

        {win.map((n, i) =>
          n === '…' ? (
            <span key={`gap${i}`} className="px-1 text-slate-600">…</span>
          ) : (
            <button
              key={n}
              onClick={() => onPage(n)}
              className={btn(n === page
                ? 'border-cyan-400 bg-cyan-500/15 text-cyan-200'
                : 'border-slate-600 text-slate-400 hover:border-slate-400 hover:text-slate-200')}
            >
              {n}
            </button>
          ))}

        <button
          onClick={() => onPage(page + 1)} disabled={page >= pages}
          className={btn('border-slate-600 text-slate-300 hover:border-slate-400 disabled:opacity-35 disabled:hover:border-slate-600')}
        >
          Next »
        </button>

        <select
          value={size} onChange={(e) => onSize(Number(e.target.value))}
          title="Ek page par kitne rows"
          className="ml-1 rounded-md border border-slate-600 bg-slate-900 px-1.5 py-[3px] text-[11.5px] text-slate-200 outline-none focus:border-cyan-400"
        >
          {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
        </select>

        <input
          value={jump}
          onChange={(e) => setJump(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => { if (e.key === 'Enter') go(); }}
          placeholder="Page"
          className="w-14 rounded-md border border-slate-600 bg-slate-900 px-2 py-[3px] text-[11.5px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400"
        />
        <button
          onClick={go}
          className={btn('border-cyan-400/60 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20')}
        >
          Go
        </button>
      </div>
    </div>
  );
}

// ══ THE SCREEN ══════════════════════════════════════════════════════════════
export default function FleetCardSettlement() {
  const [accounts, setAccounts] = useState([]);
  const [clearing, setClearing] = useState([]);
  const [queue, setQueue] = useState([]);
  const [total, setTotal] = useState({ rows: 0, amount: 0 });
  const [unfiltered, setUnfiltered] = useState({ rows: 0, amount: 0 });
  const [byReason, setByReason] = useState([]);
  const [pages, setPages] = useState(1);

  const [reason, setReason] = useState('');
  const [provider, setProvider] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(10);
  const [sort, setSort] = useState('txn_date');
  const [dir, setDir] = useState('desc');

  const [open, setOpen] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [autoMsg, setAutoMsg] = useState(null);
  const [autoBusy, setAutoBusy] = useState(false);

  // Typing should not fire a query per keystroke against a table of a thousand.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Any change to WHAT is being listed returns to page 1. Staying on page 14 of
  // a filter that now has two pages shows an empty table and looks broken.
  useEffect(() => { setPage(1); }, [reason, provider, debounced, size]);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const qs = new URLSearchParams();
      if (reason) qs.set('reason', reason);
      if (provider) qs.set('provider', provider);
      if (debounced) qs.set('search', debounced);
      qs.set('limit', String(size));
      qs.set('offset', String((page - 1) * size));
      qs.set('sort', sort);
      qs.set('dir', dir);
      const [a, c, u] = await Promise.all([
        api('/accounts'),
        api('/clearing'),
        api(`/unallocated?${qs}`),
      ]);
      setAccounts(a.accounts ?? []);
      setClearing(c.clearing ?? []);
      setQueue(u.queue ?? []);
      setTotal(u.total ?? { rows: 0, amount: 0 });
      setUnfiltered(u.unfiltered ?? u.total ?? { rows: 0, amount: 0 });
      setByReason(u.by_reason ?? []);
      setPages(u.page?.pages ?? 1);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }, [reason, provider, debounced, page, size, sort, dir]);

  useEffect(() => { load(); }, [load]);

  const onSort = (col) => {
    if (sort === col) setDir(dir === 'desc' ? 'asc' : 'desc');
    else { setSort(col); setDir(col === 'txn_date' ? 'desc' : 'desc'); }
    setPage(1);
  };

  const runAuto = async () => {
    setAutoBusy(true); setAutoMsg(null);
    try {
      const r = await api('/auto-allocate', { method: 'POST', body: JSON.stringify({}) });
      setAutoMsg(
        r.allocated === 0
          ? `Kuch bhi apne aap nahi laga — ${r.skipped_ambiguous} swipe aise hain jinka memo do swipe maang rahe hain.`
          : `${r.allocated} swipe apne aap lag gaye. ${r.still_waiting.rows} abhi bhi intezaar me.`
      );
      setPage(1);
      await load();
    } catch (e) { setAutoMsg(e.message); }
    finally { setAutoBusy(false); }
  };

  /** The current filter, as a file. Exports the WHOLE filtered set, not the page. */
  const exportCsv = async () => {
    const qs = new URLSearchParams();
    if (reason) qs.set('reason', reason);
    if (provider) qs.set('provider', provider);
    if (debounced) qs.set('search', debounced);
    qs.set('limit', '1000');
    qs.set('sort', sort); qs.set('dir', dir);
    const all = await api(`/unallocated?${qs}`);
    const head = ['Date', 'Vehicle', 'Pump', 'Litres', 'Rate', 'Swipe', 'Allocated', 'Pending', 'Reason', 'Card', 'Account'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const body = (all.queue ?? []).map((r) => [
      r.txn_date, r.vehicle_no || r.vehicle_raw, r.merchant_name, r.quantity, r.rate,
      r.amount, r.allocated, r.unallocated,
      REASONS[r.reason]?.label ?? r.reason, r.provider, r.account_no,
    ].map(esc).join(','));
    const blob = new Blob([[head.map(esc).join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pending-manual-match-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const diesel = accounts.reduce((s, a) => s + Number(a.spent ?? 0), 0);
  // The clearing figures are the WHOLE clearing account, never the filtered
  // page — a headline that moves when someone clicks a chip is not a headline.
  const waiting = clearing.reduce((s, c) => s + Number(c.unallocated_amount ?? 0), 0);
  const waitingRows = clearing.reduce((s, c) => s + Number(c.swipes_waiting ?? 0), 0);
  const placed = diesel - waiting;

  return (
    <div className="space-y-5">

      {/* ── the four figures ─────────────────────────────────────────────── */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { k: 'Card par diesel', v: inr(diesel), s: `${accounts.reduce((n, a) => n + Number(a.txns ?? 0), 0)} rows`, i: Fuel, c: 'text-cyan-300' },
          { k: 'Lag chuka', v: inr(placed), s: diesel ? `${((placed / diesel) * 100).toFixed(1)}% of diesel` : '—', i: CheckCircle2, c: 'text-emerald-300' },
          { k: 'Clearing me', v: inr(waiting), s: `${waitingRows} swipe intezaar me`, i: Split, c: 'text-amber-300' },
          { k: 'Firm', v: String(clearing.length || accounts.length), s: clearing.map((c) => c.operating_company?.replace('M/S ', '')).join(' · ') || '—', i: Building2, c: 'text-violet-300' },
        ].map((t) => (
          <GlassPanel key={t.k}>
            <div className="px-4 py-3.5">
              <div className="flex items-center gap-2">
                <t.i size={14} className={t.c} />
                <span className="text-[10.5px] font-semibold uppercase tracking-[0.13em] text-slate-400">{t.k}</span>
              </div>
              <div className={`mt-1.5 font-mono text-[26px] font-semibold leading-none tabular-nums ${t.c}`}>{t.v}</div>
              <div className="mt-1.5 truncate text-[11.5px] text-slate-500">{t.s}</div>
            </div>
          </GlassPanel>
        ))}
      </div>

      {/* ── the cards ────────────────────────────────────────────────────── */}
      <GlassPanel>
        <PanelHeader
          icon={CreditCard}
          title="Fleet Card & Settlement"
          sub="IOCL · BPCL · HPCL — company wise"
          right={
            <button
              onClick={runAuto}
              disabled={autoBusy}
              title="Sirf wahi lagata hai jo bilkul milta hai: wahi lorry, ek din ke andar, litre aur rupaye dono barabar"
              className="flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-500/10 px-3 py-1.5 text-[12px] font-semibold text-cyan-200 transition hover:bg-cyan-500/20 disabled:opacity-50"
            >
              {autoBusy ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />}
              Pakka milan chalao
            </button>
          }
        />
        <div className="px-4 pb-4">
          {autoMsg && (
            <div className="mb-3 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-[12.5px] text-cyan-100">
              {autoMsg}
            </div>
          )}
          <div className="grid gap-3 md:grid-cols-3">
            {accounts.map((a) => (
              <div key={a.account_id ?? a.account_no} className="rounded-xl border border-slate-700/70 bg-slate-900/40 p-3.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded px-1.5 py-[2px] text-[10px] font-bold tracking-wide text-slate-950"
                        style={{ background: a.provider === 'IOCL' ? '#f0736a' : a.provider === 'BPCL' ? '#6cc0d8' : '#9aa4b8' }}>
                    {a.provider}
                  </span>
                  <StatusPill tone={Number(a.txns) ? 'emerald' : 'slate'}>
                    {Number(a.txns) ? `${a.txns} rows` : 'koi statement nahi'}
                  </StatusPill>
                </div>
                <div className="mt-2 font-mono text-[12px] text-slate-400">{a.account_no}</div>
                <div className="truncate text-[12.5px] text-slate-300">{a.operating_company || '—'}</div>
                <div className="mt-2.5 space-y-1 border-t border-slate-700/60 pt-2.5">
                  {[['Diesel', a.spent], ['Recharge', a.recharged]].map(([k, v]) => (
                    <div key={k} className="flex justify-between text-[12px]">
                      <span className="text-slate-500">{k}</span>
                      <span className="font-mono tabular-nums text-slate-200">{inr(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </GlassPanel>

      {/* ── the queue ────────────────────────────────────────────────────── */}
      <GlassPanel>
        <PanelHeader
          icon={Split}
          title="Pending Manual Match"
          sub={`${waitingRows} swipe · ${inr(waiting)} clearing me`}
          accent="text-amber-400"
          right={
            <button
              onClick={exportCsv}
              title="Is filter ka poora data CSV me"
              className="flex items-center gap-1.5 rounded-lg border border-slate-600 px-2.5 py-1.5 text-[11.5px] font-semibold text-slate-300 transition hover:border-slate-400"
            >
              <Download size={13} /> CSV
            </button>
          }
        />

        <div className="px-4 pb-2">
          <div className="mb-3 rounded-lg border border-slate-700/60 bg-slate-900/40 px-3 py-2.5 text-[12.5px] leading-relaxed text-slate-400">
            <b className="text-slate-300">Yeh galti nahi hai — yeh kaam hai.</b>{' '}
            Card ki swipe kai baar pump ka 15-din ka udhaar chukane ke liye hoti hai, ek bharai ke liye nahi.
            Aise me machine ko zabardasti kisi memo par nahi lagana chahiye — diesel do baar chadh jayega,
            kyunki kharcha to memo se pehle hi chadh chuka hai. Isliye jo bilkul milta hai wahi apne aap lagta
            hai, baaki yahan aapke faisle ka intezaar karta hai.
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Lorry ya pump dhoondein"
                className="w-56 rounded-lg border border-slate-600 bg-slate-900 py-1.5 pl-7 pr-2 text-[12.5px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-cyan-400"
              />
            </div>
            <select
              value={provider} onChange={(e) => setProvider(e.target.value)}
              className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1.5 text-[12.5px] text-slate-200 outline-none focus:border-cyan-400"
            >
              <option value="">Sab card</option>
              <option value="IOCL">IOCL</option>
              <option value="BPCL">BPCL</option>
              <option value="HPCL">HPCL</option>
            </select>
            <button
              onClick={() => setReason('')}
              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition
                ${reason === '' ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200' : 'border-slate-600 text-slate-400 hover:border-slate-500'}`}
            >
              Sab ({unfiltered.rows})
            </button>
            {byReason.map((r) => (
              <button
                key={r.reason}
                onClick={() => setReason(r.reason === reason ? '' : r.reason)}
                title={REASONS[r.reason]?.hint}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold transition
                  ${reason === r.reason
                    ? 'border-cyan-400/60 bg-cyan-500/15 text-cyan-200'
                    : 'border-slate-600 text-slate-400 hover:border-slate-500'}`}
              >
                {REASONS[r.reason]?.label ?? r.reason} ({r.rows})
              </button>
            ))}
          </div>

          {/* the portal's own line, because the staff look for it */}
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <div className="text-[12px] text-slate-400">
              Total <b className="font-mono text-slate-200">{Number(total.rows).toLocaleString('en-IN')}</b> records found
              {reason || provider || debounced ? <span className="text-slate-600"> (filtered)</span> : null}
            </div>
            <div className="font-mono text-[12px] text-amber-300/90">{inr(total.amount)}</div>
          </div>
        </div>

        {err && (
          <div className="mx-4 mb-4 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200">
            <AlertTriangle size={15} className="mt-[2px] shrink-0" /> <span>{err}</span>
          </div>
        )}

        <div className="px-4 pb-4">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-[12.5px]">
              <thead>
                <tr className="border-b border-slate-700">
                  <Th col="txn_date" sort={sort} dir={dir} onSort={onSort}>Tareekh</Th>
                  <Th col="vehicle" sort={sort} dir={dir} onSort={onSort}>Lorry</Th>
                  <Th col="merchant" sort={sort} dir={dir} onSort={onSort}>Pump</Th>
                  <Th col="quantity" sort={sort} dir={dir} onSort={onSort} align="right">Litre</Th>
                  <Th col="amount" sort={sort} dir={dir} onSort={onSort} align="right">Swipe</Th>
                  <Th col="unallocated" sort={sort} dir={dir} onSort={onSort} align="right">Bacha hua</Th>
                  <Th col="reason" sort={sort} dir={dir} onSort={onSort}>Kyun ruka hai</Th>
                  <Th>{''}</Th>
                </tr>
              </thead>
              <tbody className={loading ? 'opacity-40 transition-opacity' : 'transition-opacity'}>
                {queue.map((r) => (
                  <tr
                    key={r.txn_id}
                    onClick={() => setOpen(r.txn_id)}
                    className="cursor-pointer border-b border-slate-800/70 transition hover:bg-slate-800/40"
                  >
                    <td className="py-2 pr-3 whitespace-nowrap text-slate-400">{dayLong(r.txn_date)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap font-mono text-slate-200">
                      {r.vehicle_no || <span className="text-yellow-300/80">{r.vehicle_raw || '—'}</span>}
                    </td>
                    <td className="py-2 pr-3 max-w-[210px] truncate text-slate-300">{r.merchant_name || '—'}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-400">
                      {Number(r.quantity ?? 0).toFixed(0)}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-400">{inr(r.amount)}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums font-semibold text-amber-300">
                      {inr(r.unallocated)}
                      {Number(r.allocated) > 0 && (
                        <div className="text-[10px] font-normal text-emerald-400">
                          {inr(r.allocated)} lag chuka
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3"><ReasonPill reason={r.reason} /></td>
                    <td className="py-2 text-right text-slate-600"><ChevronRight size={14} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!loading && queue.length === 0 && (
            <div className="py-5 text-[13px] text-slate-400">
              {unfiltered.rows === 0
                ? 'Clearing khaali hai — har swipe kahin na kahin lag chuki hai.'
                : 'Is filter me kuch nahi mila.'}
            </div>
          )}

          {loading && queue.length === 0 && (
            <div className="flex items-center gap-2 py-5 text-slate-400">
              <Loader2 size={16} className="animate-spin" /> Queue khul rahi hai…
            </div>
          )}

          {total.rows > 0 && (
            <Pager
              page={page} pages={pages} size={size} total={Number(total.rows)}
              onPage={(n) => setPage(Math.min(Math.max(1, n), pages))}
              onSize={setSize}
            />
          )}

          {/* the portal puts its code legend under the table; so does this */}
          <div className="mt-3 rounded-lg border border-slate-700/50 bg-slate-900/30 px-3 py-2.5">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">
              Kyun ruka hai — matlab
            </div>
            <div className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
              {Object.entries(REASONS).map(([k, v]) => (
                <div key={k} className="flex items-start gap-2 text-[11.5px] leading-snug">
                  <span className="mt-[1px] shrink-0"><ReasonPill reason={k} /></span>
                  <span className="text-slate-500">{v.hint}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </GlassPanel>

      {/* ── vehicle-wise / card-wise ─────────────────────────────────────── */}
      <Breakdown />

      {open && (
        <AllocateDrawer
          txnId={open}
          onClose={() => setOpen(null)}
          onDone={() => load()}
        />
      )}
    </div>
  );
}


// ══ VEHICLE-WISE AND CARD-WISE ══════════════════════════════════════════════
//
// The totals come from the server over the whole date range, not from the rows
// this page happens to be holding — a screen showing 300 of 1,086 swipes would
// otherwise report a lorry's diesel as a third of what it was.
function Breakdown() {
  const [from, setFrom] = useState('2026-04-01');
  const [to, setTo] = useState('2026-09-01');
  const [tab, setTab] = useState('vehicle');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    let dead = false;
    setBusy(true); setErr(null);
    api(`/breakdown?from=${from}&to=${to}&limit=400`)
      .then((d) => { if (!dead) setData(d); })
      .catch((e) => { if (!dead) setErr(e.message); })
      .finally(() => { if (!dead) setBusy(false); });
    return () => { dead = true; };
  }, [from, to]);

  const vehicles = useMemo(() => {
    const rows = data?.vehicles ?? [];
    const s = q.trim().toLowerCase();
    return s ? rows.filter((v) => (v.vehicle ?? '').toLowerCase().includes(s)) : rows;
  }, [data, q]);

  // The bar is drawn against the biggest row, so the shape reads even when one
  // lorry dwarfs the rest — which, with a pooled firm card in the list, it does.
  const maxAmt = Math.max(1, ...(data?.vehicles ?? []).map((v) => Number(v.amount)));

  return (
    <GlassPanel>
      <PanelHeader
        icon={Truck}
        title="Vehicle-wise / Card-wise"
        sub={data ? `${dayLong(data.period.from)} – ${dayLong(data.period.to)}` : '—'}
        accent="text-violet-400"
        right={
          <div className="flex items-center gap-1.5">
            {['vehicle', 'card'].map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-lg px-2.5 py-1 text-[11.5px] font-semibold transition
                  ${tab === t ? 'bg-violet-500/20 text-violet-200' : 'text-slate-400 hover:text-slate-200'}`}
              >
                {t === 'vehicle' ? 'Lorry' : 'Card'}
              </button>
            ))}
          </div>
        }
      />

      <div className="px-4 pb-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {[['From', from, setFrom], ['To', to, setTo]].map(([lbl, val, set]) => (
            <label key={lbl} className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{lbl}</span>
              <input
                type="date" value={val} onChange={(e) => set(e.target.value)}
                className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-[12px] text-slate-200 outline-none focus:border-violet-400"
              />
            </label>
          ))}
          {tab === 'vehicle' && (
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={q} onChange={(e) => setQ(e.target.value)} placeholder="Lorry"
                className="w-40 rounded-lg border border-slate-600 bg-slate-900 py-1 pl-7 pr-2 text-[12px] text-slate-100 outline-none placeholder:text-slate-600 focus:border-violet-400"
              />
            </div>
          )}
          {data && (
            <span className="ml-auto text-[11.5px] text-slate-500">
              {data.totals.vehicles} lorry · {data.totals.swipes} swipe ·{' '}
              {Number(data.totals.litres).toLocaleString('en-IN', { maximumFractionDigits: 0 })} L ·{' '}
              <span className="font-mono text-slate-300">{inr(data.totals.amount)}</span>
            </span>
          )}
        </div>

        {err && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[13px] text-rose-200">
            <AlertTriangle size={15} className="mt-[2px] shrink-0" /> <span>{err}</span>
          </div>
        )}

        {busy && !data && (
          <div className="flex items-center gap-2 py-6 text-slate-400">
            <Loader2 size={16} className="animate-spin" /> Nikal raha hoon…
          </div>
        )}

        {data && tab === 'vehicle' && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-[12.5px]">
              <thead>
                <tr className="border-b border-slate-700 text-left text-[10px] uppercase tracking-[0.1em] text-slate-500">
                  <th className="py-2 pr-3 font-semibold">Lorry</th>
                  <th className="py-2 pr-3 text-right font-semibold">Swipe</th>
                  <th className="py-2 pr-3 text-right font-semibold">Litre</th>
                  <th className="py-2 pr-3 text-right font-semibold">Avg ₹/L</th>
                  <th className="py-2 pr-3 text-right font-semibold">Diesel</th>
                  <th className="py-2 pr-3 text-right font-semibold">Baki</th>
                  <th className="py-2 pr-3 font-semibold">Card · Pump</th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.vehicle} className="border-b border-slate-800/70">
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span className={`font-mono ${v.in_fleet ? 'text-slate-200' : 'text-yellow-300'}`}>
                        {v.vehicle}
                      </span>
                      {!v.in_fleet && (
                        <span
                          title="Card par yeh likha hai, par fleet master me nahi hai"
                          className="ml-2 rounded-full border border-yellow-400/40 bg-yellow-500/10 px-1.5 py-[1px] text-[9.5px] font-semibold text-yellow-300"
                        >
                          FLEET ME NAHI
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-400">{v.swipes}</td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-300">
                      {Number(v.litres).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums text-slate-400">
                      {v.avg_rate ? Number(v.avg_rate).toFixed(2) : '—'}
                    </td>
                    <td className="py-2 pr-3 text-right">
                      <div className="font-mono tabular-nums text-slate-100">{inr(v.amount)}</div>
                      <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-slate-800">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-cyan-500 to-violet-400"
                          style={{ width: `${Math.max(2, (Number(v.amount) / maxAmt) * 100)}%` }}
                        />
                      </div>
                    </td>
                    <td className={`py-2 pr-3 text-right font-mono tabular-nums ${Number(v.pending) > 0 ? 'text-amber-300' : 'text-emerald-400'}`}>
                      {Number(v.pending) > 0 ? inr(v.pending) : '✓'}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-[11.5px] text-slate-500">
                      {v.providers} · {v.pumps} pump
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {vehicles.length === 0 && (
              <div className="py-5 text-[13px] text-slate-500">Is range me kuch nahi mila.</div>
            )}
          </div>
        )}

        {data && tab === 'card' && (
          <div className="grid gap-3 md:grid-cols-3">
            {data.cards.map((c) => (
              <div key={c.account_id} className="rounded-xl border border-slate-700/70 bg-slate-900/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded px-1.5 py-[2px] text-[10px] font-bold tracking-wide text-slate-950"
                        style={{ background: c.provider === 'IOCL' ? '#f0736a' : c.provider === 'BPCL' ? '#6cc0d8' : '#9aa4b8' }}>
                    {c.provider}
                  </span>
                  <span className="font-mono text-[11px] text-slate-500">{c.account_no}</span>
                </div>
                <div className="mt-2 text-[13px] font-medium text-slate-200">{c.account_name}</div>
                <div className="truncate text-[11.5px] text-slate-500">{c.operating_company || '—'}</div>

                <div className="mt-3 space-y-1.5 border-t border-slate-700/60 pt-3">
                  {[
                    ['Diesel', c.diesel, 'text-slate-100'],
                    ['Litre', Number(c.litres).toLocaleString('en-IN', { maximumFractionDigits: 0 }), 'text-slate-300', true],
                    ['Recharge', c.recharged, 'text-cyan-300'],
                    ['Wallet settlement', c.wallet_settlement, 'text-slate-400'],
                    ['Lag chuka', c.allocated, 'text-emerald-300'],
                    ['Clearing me', c.pending, 'text-amber-300'],
                  ].map(([k, v, cl, raw]) => (
                    <div key={k} className="flex justify-between text-[12px]">
                      <span className="text-slate-500">{k}</span>
                      <span className={`font-mono tabular-nums ${cl}`}>{raw ? v : inr(v)}</span>
                    </div>
                  ))}
                </div>

                <div className="mt-3 flex items-center justify-between border-t border-slate-700/60 pt-2.5 text-[11px]">
                  <span className="text-slate-500">{c.swipes} swipe · {c.vehicles} lorry</span>
                  {Number(c.diesel) > 0 && (
                    <span className="font-mono text-slate-400">
                      {((Number(c.allocated) / Number(c.diesel)) * 100).toFixed(0)}% laga
                    </span>
                  )}
                </div>

                {!c.clearing_ledger && (
                  <div className="mt-2 text-[11px] text-amber-300/80">
                    Clearing ledger ka naam nahi hua.
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
