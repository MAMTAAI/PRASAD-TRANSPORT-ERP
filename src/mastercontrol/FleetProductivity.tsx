// @ts-nocheck
// ============================================================================
// Two operational panels that replace a chart nobody could act on.
//
// <VehicleRtkmPanel/>   — Top 5 and Bottom 5 vehicles by RTKM, with the full
//                         ranked table behind a click.
// <ShortageRecoveryPanel/> — driver shortages that are still owed, separated
//                         from the ones already taken back.
//
// WHAT REPLACED WHAT. "Best Vehicle Trips" plotted trips-per-weekday, which is
// a shape, not a decision: it never named a vehicle, so nothing followed from
// reading it. RTKM per vehicle names the truck, and the same row carries what
// it earned and what it lost — which is the comparison the yard actually makes.
//
// FREIGHT HERE IS `billed_amount`. The API deliberately reuses the owner
// matrix's COALESCE(NULLIF(billed_amount,0), freight_amount, 0): only 21 trips
// carry freight_amount against 489 with billed_amount, so picking the other
// column would put a second, smaller revenue number on the same screen as the
// matrix. Two revenue figures on one dashboard is worse than none.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Gauge, X, ArrowUpRight, ArrowDownRight, HandCoins, ShieldCheck, Search,
  ShieldAlert, CalendarClock, ChevronLeft, ChevronRight,
} from 'lucide-react';
import {
  GlassPanel, PanelHeader, StatusPill, useHoverCard, HoverTitle, HoverKv, HoverNote,
} from './shared';
import { inr, inrFull } from './useDashboardData';
import { API_BASE } from '../lib/apiBase';

const km = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 }) : '--');

/** Shortage severity. Thresholds are set off the real spread in the books —
 *  penalties run from ₹1,515 to ₹30,081 — so "red" means the top of the range
 *  actually seen, not an arbitrary round number. */
const shortageTone = (n) => {
  const v = Number(n) || 0;
  if (v >= 10000) return 'red';
  if (v >= 5000) return 'amber';
  if (v > 0) return 'slate';
  return 'emerald';
};
const shortageText = (n) => {
  const t = shortageTone(n);
  return t === 'red' ? 'text-red-400' : t === 'amber' ? 'text-amber-300' : t === 'slate' ? 'text-slate-300' : 'text-slate-600';
};

// ── the drill-down ──────────────────────────────────────────────────────────
// Portalled to <body> and fixed, for the same reason the hover cards are: the
// panel it opens from is inside a scroll container that would crop it.
function RtkmModal({ rows, period, onClose }) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState({ key: 'rtkm', dir: 'desc' });

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Freeze the page behind the modal; a dialog that scrolls the list under it
    // is how you lose your place in a 47-row table.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? rows.filter((r) => String(r.vehicle ?? '').toLowerCase().includes(needle))
      : rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      const n = Number(av), m = Number(bv);
      if (Number.isFinite(n) && Number.isFinite(m)) return (n - m) * dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
    });
  }, [rows, q, sort]);

  // Totals are summed here only to show a footer for the CURRENT filter. The
  // per-row figures are the API's SQL-summed strings and are never recomputed.
  const totals = useMemo(() => view.reduce((a, r) => ({
    trips: a.trips + Number(r.trips || 0),
    rtkm: a.rtkm + Number(r.rtkm || 0),
    freight: a.freight + Number(r.freight || 0),
    shortage: a.shortage + Number(r.shortage || 0),
  }), { trips: 0, rtkm: 0, freight: 0, shortage: 0 }), [view]);

  const th = (key, label, alignLeft = false) => (
    <th
      onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
      className={`sticky top-0 z-10 bg-slate-950/95 backdrop-blur px-3 py-2 text-[9.5px] font-black uppercase
                  tracking-wider text-slate-500 cursor-pointer select-none hover:text-cyan-400
                  ${alignLeft ? 'text-left' : 'text-right'}`}
    >
      {label}{sort.key === key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
    </th>
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center p-3 sm:p-6 bg-slate-950/80 backdrop-blur-sm mc-fade-in"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Vehicle productivity detail"
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-5xl max-h-full flex-col overflow-hidden rounded-2xl border
                   border-cyan-500/30 bg-slate-900/95 shadow-[0_24px_80px_rgba(0,0,0,0.7)]"
      >
        <div className="flex items-center gap-3 border-b border-slate-700/60 px-4 py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-slate-700/50 bg-white/5 text-cyan-400">
            <Gauge size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-black uppercase tracking-wide text-slate-100">Vehicle Productivity — full fleet</h3>
            <p className="text-[10px] text-slate-500">
              {period?.label ?? 'all time'}
              {period?.from ? ` (${period.from} to ${period.to})` : ''}
              {' · '}{rows.length} vehicle{rows.length === 1 ? '' : 's'} · click a heading to re-sort
            </p>
          </div>
          <label className="hidden items-center gap-1.5 rounded-lg border border-slate-700/60 bg-slate-950/60 px-2 py-1.5 sm:flex">
            <Search size={12} className="text-slate-500" />
            <input
              value={q} onChange={(e) => setQ(e.target.value)} placeholder="vehicle no…"
              className="w-32 bg-transparent text-[11px] text-slate-200 placeholder-slate-600 outline-none"
            />
          </label>
          <button
            onClick={onClose}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-slate-700/60
                       bg-white/5 text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[640px] text-[11px]">
            <thead>
              <tr className="border-b border-slate-800">
                {th('vehicle', 'Vehicle No', true)}
                {th('trips', 'Trips')}
                {th('rtkm', 'Total RTKM')}
                {th('freight', 'Total Freight Bill')}
                {th('per_km', '₹ / km')}
                {th('rtkm_delta_pct', 'vs prev')}
                {th('shortage', 'Total Shortage')}
              </tr>
            </thead>
            <tbody>
              {view.length === 0 && (
                <tr><td colSpan={7} className="py-6 text-center text-[11px] text-slate-600">No vehicle matches “{q}”.</td></tr>
              )}
              {view.map((r) => (
                <tr key={r.vehicle} className="border-b border-slate-800/60 transition-colors duration-100 hover:bg-white/5">
                  <td className="px-3 py-2 text-left">
                    <span className="font-bold text-slate-100">{r.vehicle}</span>
                    {r.unbilled_trips > 0 && (
                      <span className="ml-2 text-[9px] text-amber-400/80">{r.unbilled_trips} unbilled</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-300">{r.trips}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono font-bold text-cyan-300">{km(r.rtkm)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-200">
                    {Number(r.freight) > 0 ? `₹${inrFull(r.freight)}` : <span className="text-slate-600">not billed</span>}
                  </td>
                  {/* Rupees per kilometre is the figure that separates a long
                      truck from a productive one — a lorry can run the most
                      distance in the fleet and earn the least on it. */}
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-emerald-300">
                    {r.per_km ? `₹${r.per_km}` : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono">
                    {r.rtkm_delta_pct == null
                      ? <span className="text-slate-600" title="no comparable previous period">new</span>
                      : (
                        <span className={r.rtkm_delta_pct >= 0 ? 'text-emerald-400' : 'text-amber-400'}>
                          {r.rtkm_delta_pct >= 0 ? '+' : ''}{r.rtkm_delta_pct}%
                        </span>
                      )}
                  </td>
                  <td className={`whitespace-nowrap px-3 py-2 text-right font-mono font-bold ${shortageText(r.shortage)}`}>
                    {Number(r.shortage) > 0 ? `₹${inrFull(r.shortage)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-700 bg-slate-950/60">
                <td className="px-3 py-2 text-left text-[9.5px] font-black uppercase tracking-wider text-slate-500">
                  {q ? 'Filtered total' : 'Fleet total'}
                </td>
                <td className="px-3 py-2 text-right font-mono font-bold text-slate-300">{totals.trips}</td>
                <td className="px-3 py-2 text-right font-mono font-black text-cyan-300">{km(totals.rtkm)}</td>
                <td className="px-3 py-2 text-right font-mono font-black text-slate-100">₹{inrFull(totals.freight)}</td>
                <td className="px-3 py-2 text-right font-mono font-black text-emerald-300">
                  {totals.rtkm > 0 ? `₹${(totals.freight / totals.rtkm).toFixed(2)}` : '—'}
                </td>
                <td className="px-3 py-2" />
                <td className={`px-3 py-2 text-right font-mono font-black ${shortageText(totals.shortage)}`}>₹{inrFull(totals.shortage)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p className="border-t border-slate-700/60 px-4 py-2 text-[9.5px] leading-relaxed text-slate-500">
          RTKM is the round-trip distance recorded on each trip, counted by LOADING date — a trip that crossed a
          fortnight boundary belongs to the period whose kilometres it ran, not the one it finished in. Freight is the
          billed amount, the same figure the Owner Fleet Matrix reads, so the two agree. “Not billed” means trips with
          no freight recorded yet: the distance is real, the revenue simply is not in the books. “vs prev” compares the
          same length of window one step back — fortnight against fortnight, never against a half-finished one.
        </p>
      </div>
    </div>,
    document.body,
  );
}

// ── one ranked row ──────────────────────────────────────────────────────────
// One ranked vehicle, drawn as a BAR rather than a number in a column.
// The eye compares lengths far faster than it compares five-digit figures, and
// the whole point of a top/bottom list is the comparison.
function RankRow({ r, rank, max, tone }) {
  const pct = Number(max) > 0 ? Math.max(2, (Number(r.rtkm) / Number(max)) * 100) : 0;
  const delta = r.rtkm_delta_pct;

  const { triggerProps, overlay } = useHoverCard(() => (
    <>
      <HoverTitle sub={`${r.trips} trip${r.trips === 1 ? '' : 's'} in this period`}>{r.vehicle}</HoverTitle>
      <HoverKv k="RTKM" v={`${km(r.rtkm)} km`} tone="text-cyan-300" />
      <HoverKv k="Average per trip" v={`${km(Number(r.rtkm) / Math.max(1, r.trips))} km`} />
      <HoverKv k="Freight billed" v={Number(r.freight) > 0 ? `₹${inrFull(r.freight)}` : 'not billed'}
               tone={Number(r.freight) > 0 ? 'text-slate-200' : 'text-amber-300'} />
      {r.per_km && <HoverKv k="Earned per km" v={`₹${r.per_km}`} tone="text-emerald-300" />}
      {Number(r.qty) > 0 && <HoverKv k="Quantity carried" v={`${Number(r.qty).toLocaleString('en-IN')} KL`} />}
      <HoverKv strong k="Shortage" v={Number(r.shortage) > 0 ? `₹${inrFull(r.shortage)}` : 'none'}
               tone={shortageText(r.shortage)} />
      {delta != null && (
        <HoverNote tone={delta >= 0 ? 'text-emerald-300/85' : 'text-amber-300/85'}>
          {delta >= 0 ? 'Up' : 'Down'} {Math.abs(delta)}% on the previous period
          ({km(r.prev_rtkm)} km). Like-for-like — same length of window, one step back.
        </HoverNote>
      )}
      {r.unbilled_trips > 0 && (
        <HoverNote tone="text-amber-300/90">
          {r.unbilled_trips} of these trips carry no billed freight, so the revenue
          shown is lower than the distance run would suggest.
        </HoverNote>
      )}
    </>
  ), { placement: 'top', width: 290 });

  return (
    <>
      <div
        {...triggerProps}
        tabIndex={0}
        className="touch-manipulation group relative overflow-hidden rounded-lg border border-slate-800/60
                   bg-white/[0.03] px-2.5 py-1.5 outline-none transition-colors duration-100
                   hover:bg-white/[0.07] focus-visible:ring-1 focus-visible:ring-cyan-400/60"
      >
        {/* the bar, behind the text rather than beside it — no column stolen */}
        <span
          aria-hidden
          className={`absolute inset-y-0 left-0 transition-all duration-500
            ${tone === 'top' ? 'bg-gradient-to-r from-emerald-500/25 to-emerald-500/[0.04]'
                             : 'bg-gradient-to-r from-amber-500/20 to-amber-500/[0.03]'}`}
          style={{ width: `${pct}%` }}
        />
        <div className="relative flex items-center gap-2">
          <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md text-[9px] font-black
            ${tone === 'top' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`}>
            {rank}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-100">{r.vehicle}</span>

          {delta != null && (
            <span className={`hidden shrink-0 items-center gap-0.5 text-[9px] font-black sm:flex
              ${delta >= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
              {delta >= 0 ? <ArrowUpRight size={9} /> : <ArrowDownRight size={9} />}{Math.abs(delta)}%
            </span>
          )}
          <span className="shrink-0 font-mono text-[11px] font-black text-cyan-300">{km(r.rtkm)}</span>
          <span className="shrink-0 text-[8px] uppercase tracking-wider text-slate-600">km</span>
          <span className="hidden w-20 shrink-0 text-right font-mono text-[10px] text-slate-400 md:block">
            {Number(r.freight) > 0 ? `₹${inr(r.freight)}` : '—'}
          </span>
        </div>
      </div>
      {overlay}
    </>
  );
}

// ── TOP / BOTTOM 5 BY RTKM, PER PERIOD ──────────────────────────────────────
// THE FORTNIGHT IS 1–15 AND 16–END OF MONTH, not "the last 15 days". A sliding
// window shifts every time you look at it and can never be compared with the
// one before; these are the same boundaries the billing cycles and the IOCL
// invoices use, so a fortnight here is the fortnight that gets billed.
export function VehicleRtkmPanel({ live, filter }) {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState('FORTNIGHT');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');

  const qs = useMemo(() => {
    const q = new URLSearchParams({ period, offset: String(offset) });
    const f = filter?.filters ?? {};
    if (f.companyId) q.set('company_id', f.companyId);
    if (f.branchId) q.set('branch_id', f.branchId);
    if (f.owner) q.set('owner', f.owner);
    if (f.fleet) q.set('fleet', f.fleet);
    return q.toString();
  }, [period, offset, filter?.filters]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState('loading');
    try {
      const r = await fetch(`${API_BASE}/api/v1/dashboard/vehicle-productivity?${qs}`);
      if (!r.ok) { setState('error'); return; }
      setData(await r.json());
      setState('ok');
    } catch { setState('error'); }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  // Live, but quietly: a background refresh must not blank the panel somebody
  // is reading. 45s because trips are entered by hand, not streamed.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, 45000);
    // Same reason as the shortage panel: a hidden tab stops polling, so without
    // this you come back to figures from whenever you wandered off.
    const onVis = () => { if (document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', onVis);
    // A save anywhere in the ERP refreshes this panel at once. The wrapper in
    // lib/dataChangeBus fires this after any successful write to /api/v1, so
    // the poll below is only the floor for changes made on ANOTHER machine.
    const onChanged = () => load(true);
    window.addEventListener('erp:data-changed', onChanged);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('erp:data-changed', onChanged);
    };
  }, [load]);

  const top = data?.top ?? [];
  const bottom = data?.bottom ?? [];
  const all = data?.all ?? [];
  const tot = data?.totals;
  const maxRtkm = top[0]?.rtkm ?? 0;
  const totalDelta = tot && Number(tot.prev_rtkm) > 0
    ? Math.round(((Number(tot.rtkm) - Number(tot.prev_rtkm)) / Number(tot.prev_rtkm)) * 100)
    : null;

  const TABS = [
    { k: 'FORTNIGHT', label: 'Fortnight' },
    { k: 'MONTH', label: 'Month' },
    { k: 'YEAR', label: 'Year' },
    { k: 'ALL', label: 'All' },
  ];

  return (
    <GlassPanel className="border-cyan-500/25">
      <PanelHeader
        icon={Gauge}
        title="Vehicle Productivity — RTKM"
        accent="text-cyan-400"
        sub={data ? `${data.vehicles} vehicles · ${data.period?.label}` : 'loading…'}
        right={
          <button
            onClick={() => setOpen(true)}
            disabled={all.length === 0}
            className="rounded-lg border border-cyan-600/50 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-bold
                       text-cyan-300 transition-colors hover:bg-cyan-500/20 disabled:opacity-40"
          >
            FULL REPORT
          </button>
        }
      />

      <div className="px-3 pb-3">
        {/* period selector + stepper */}
        <div className="mb-2.5 flex items-center gap-1.5">
          <div className="flex flex-1 gap-1 rounded-xl bg-black/30 p-1">
            {TABS.map((t) => (
              <button
                key={t.k}
                onClick={() => { setPeriod(t.k); setOffset(0); }}
                className={`flex-1 rounded-lg px-2 py-1.5 text-[10.5px] font-black transition-all duration-150
                  ${period === t.k
                    ? 'bg-cyan-500/20 text-cyan-200 shadow-[inset_0_0_0_1px_rgba(34,211,238,0.35)]'
                    : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {period !== 'ALL' && (
            <div className="flex shrink-0 items-center gap-0.5 rounded-xl bg-black/30 p-1">
              <button onClick={() => setOffset((o) => o + 1)} aria-label="Previous period"
                className="grid h-6 w-6 place-items-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-cyan-300">
                <ChevronLeft size={13} />
              </button>
              <button onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={offset === 0}
                aria-label="Next period"
                className="grid h-6 w-6 place-items-center rounded-lg text-slate-400 transition-colors
                           hover:bg-white/10 hover:text-cyan-300 disabled:opacity-25">
                <ChevronRight size={13} />
              </button>
            </div>
          )}
        </div>

        {/* the period's own totals — distance, money, and rupees per km */}
        {/* Suppressed when the period is empty: three tiles reading 0 km and
            Rs.0 look like a measured result, and this panel's whole failure mode
            is a zero that gets believed. The empty state below says why instead. */}
        {tot && !(state === 'ok' && all.length === 0) && (
          <div className="mb-2.5 grid grid-cols-3 gap-1.5">
            <Tile label="Total RTKM" value={km(tot.rtkm)} unit="km" tone="text-cyan-300"
                  delta={totalDelta} sub={data.previous ? `vs ${data.previous.label}` : null} />
            <Tile label="Freight" value={`₹${inr(tot.freight)}`} tone="text-emerald-300"
                  sub={`${tot.trips} trip${tot.trips === 1 ? '' : 's'}`} />
            <Tile label="Per km" value={tot.per_km ? `₹${tot.per_km}` : '—'} tone="text-violet-300"
                  sub={Number(tot.shortage) > 0 ? `₹${inr(tot.shortage)} shortage` : 'no shortage'} />
          </div>
        )}

        {state === 'loading' && (
          <div className="flex flex-col gap-1.5">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded-lg bg-white/5" style={{ animationDelay: `${i * 70}ms` }} />
            ))}
          </div>
        )}

        {state === 'error' && (
          <p className="py-3 text-center text-[11px] text-amber-400/80">Could not load productivity for this period.</p>
        )}

        {/* THE 16th OF THE MONTH PROBLEM. A fortnight here is 1-15 and 16-end,
            the boundaries IOCL bills on. Open this on the 16th and the current
            fortnight is one day old and legitimately empty, while the previous
            one holds everything. That is arithmetic, not a fault -- but a panel
            that answers it with a bare 0 is indistinguishable from a broken one,
            which is exactly how this got reported as a date-filter bug. So say
            what IS there, with the figure, and make it one click away. */}
        {state === 'ok' && all.length === 0 && (
          <div className="py-4 text-center">
            <p className="text-[11px] leading-relaxed text-slate-500">
              No trip with a recorded RTKM ran in {data.period?.label}.
            </p>
            {offset === 0 && Number(tot?.prev_rtkm) > 0 && data.previous && (
              <>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                  {data.previous.label} has{' '}
                  <span className="font-bold text-cyan-300">{km(tot.prev_rtkm)} km</span>.
                </p>
                <button
                  onClick={() => setOffset(1)}
                  className="mt-2 rounded-lg border border-cyan-600/50 bg-cyan-500/10 px-3 py-1.5
                             text-[10px] font-bold text-cyan-300 transition-colors hover:bg-cyan-500/20"
                >
                  Show {data.previous.label}
                </button>
              </>
            )}
            {offset === 0 && !(Number(tot?.prev_rtkm) > 0) && (
              <p className="mt-1 text-[11px] text-slate-500">
                The period before it is empty too, so this is a gap in the data, not the calendar.
              </p>
            )}
          </div>
        )}

        {state === 'ok' && all.length > 0 && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[9px] font-black uppercase tracking-wider text-emerald-400">
                  <ArrowUpRight size={11} /> Top 5 — highest RTKM
                </p>
                <div className="flex flex-col gap-1">
                  {top.map((r, i) => <RankRow key={r.vehicle} r={r} rank={i + 1} max={maxRtkm} tone="top" />)}
                </div>
              </div>
              <div>
                <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[9px] font-black uppercase tracking-wider text-amber-400">
                  <ArrowDownRight size={11} /> Bottom 5 — lowest RTKM
                </p>
                <div className="flex flex-col gap-1">
                  {bottom.map((r, i) => (
                    <RankRow key={r.vehicle} r={r} rank={all.length - i} max={maxRtkm} tone="bottom" />
                  ))}
                </div>
              </div>
            </div>

            {data.overlap && (
              <p className="mt-2 px-1 text-[9.5px] text-amber-400/80">
                ⚠ Only {all.length} vehicles have RTKM in this scope, so the two lists overlap — some trucks appear in both.
              </p>
            )}
          </>
        )}
      </div>

      {open && <RtkmModal rows={all} period={data?.period} onClose={() => setOpen(false)} />}
    </GlassPanel>
  );
}

/** One headline figure with an optional period-on-period delta. */
function Tile({ label, value, unit, sub, tone = 'text-slate-100', delta }) {
  return (
    <div className="rounded-xl border border-slate-800/70 bg-black/25 px-2.5 py-2">
      <p className="text-[8.5px] font-black uppercase tracking-wider text-slate-600">{label}</p>
      <p className={`mt-0.5 flex items-baseline gap-1 text-[15px] font-black leading-none ${tone}`}>
        {value}
        {unit && <span className="text-[8.5px] font-bold uppercase text-slate-600">{unit}</span>}
        {delta != null && (
          <span className={`ml-auto flex items-center gap-0.5 text-[9px] ${delta >= 0 ? 'text-emerald-400' : 'text-amber-400'}`}>
            {delta >= 0 ? <ArrowUpRight size={9} /> : <ArrowDownRight size={9} />}{Math.abs(delta)}%
          </span>
        )}
      </p>
      {sub && <p className="mt-0.5 truncate text-[9px] text-slate-600">{sub}</p>}
    </div>
  );
}


// ── DRIVER SHORTAGE RECOVERY ────────────────────────────────────────────────
//
// PENDING IS CHARGED MINUS RECOVERED, never "has a penalty". Every recovery is a
// driver_transactions row keyed on the trip, so what is still owed is arithmetic
// over two real tables — which is also what makes this self-updating: the moment
// a recovery is posted, the figure drops on the next read. Nothing to tick off.
//
// A SETTLED PENALTY IS NEVER SHOWN AS ACTIONABLE. It is kept, behind a fold,
// because showing one as outstanding is how a driver gets docked twice for the
// same shortage.
function ShortageRow({ r, settled, max }) {
  const pct = Number(max) > 0 ? Math.max(2, (Number(settled ? r.penalty : r.pending) / Number(max)) * 100) : 0;
  const recPct = Number(r.penalty) > 0 ? Math.round((Number(r.recovered) / Number(r.penalty)) * 100) : 0;

  const { triggerProps, overlay } = useHoverCard(() => (
    <>
      <HoverTitle sub={r.vehicle}>{r.driver}</HoverTitle>
      <HoverKv k="Trips with shortage" v={r.trips} />
      {r.trip_codes?.length > 0 && <HoverKv k="Trips" v={r.trip_codes.join(', ')} mono={false} />}
      <HoverKv k="Quantity short" v={`${Number(r.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 })} KL`} />
      <HoverKv k="Penalty charged" v={`₹${inrFull(r.penalty)}`} />
      <HoverKv k="Recovered so far" v={`₹${inrFull(r.recovered)}`} tone="text-emerald-300" />
      <HoverKv strong k="Still owed" v={`₹${inrFull(r.pending)}`}
               tone={Number(r.pending) > 0 ? shortageText(r.pending) : 'text-emerald-400'} />
      {r.last_recovery_at && (
        <HoverKv k="Last recovery" v={String(r.last_recovery_at).slice(0, 10)} />
      )}
      <HoverNote tone={settled ? 'text-emerald-300/80' : 'text-amber-300/90'}>
        {settled
          ? 'Fully recovered through the driver khata — nothing further to collect. Shown for the record, not for action.'
          : `${recPct}% recovered so far. Recovery posts to the khata and its GL leg in the same transaction.`}
      </HoverNote>
    </>
  ), { placement: 'top', width: 300 });

  const tone = settled ? 'settled' : shortageTone(r.pending);
  return (
    <>
      <div
        {...triggerProps}
        tabIndex={0}
        className={`touch-manipulation relative overflow-hidden rounded-lg border px-2.5 py-2 outline-none
                    transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-cyan-400/60
          ${settled ? 'border-slate-800/60 bg-white/[0.02] hover:bg-white/[0.05]'
            : tone === 'red' ? 'border-red-500/50 bg-red-500/[0.07] hover:bg-red-500/[0.12] shadow-[0_0_16px_rgba(248,113,113,0.12)]'
            : tone === 'amber' ? 'border-amber-500/40 bg-amber-500/[0.07] hover:bg-amber-500/[0.12]'
            : 'border-slate-700/60 bg-white/5 hover:bg-white/10'}`}
      >
        <span aria-hidden
          className={`absolute inset-y-0 left-0 transition-all duration-500
            ${settled ? 'bg-gradient-to-r from-emerald-500/12 to-transparent'
                      : 'bg-gradient-to-r from-red-500/18 to-transparent'}`}
          style={{ width: `${pct}%` }} />
        <div className="relative flex items-center gap-2.5">
          <div className="min-w-0 flex-1">
            <p className={`truncate text-[11px] font-bold ${settled ? 'text-slate-400' : 'text-slate-100'}`}>
              {r.driver}
            </p>
            <p className="truncate text-[9px] text-slate-500">
              {r.vehicle} · {r.trips} trip{r.trips === 1 ? '' : 's'}
              {Number(r.recovered) > 0 && !settled && ` · ${recPct}% back`}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <p className={`font-mono text-[11.5px] font-black ${settled ? 'text-slate-500' : shortageText(r.pending)}`}>
              ₹{inrFull(settled ? r.penalty : r.pending)}
            </p>
            <p className="text-[8.5px] uppercase tracking-wider text-slate-600">
              {settled ? 'recovered' : 'to recover'}
            </p>
          </div>
        </div>
      </div>
      {overlay}
    </>
  );
}

/** Trip-wise detail — the level somebody can actually act on. */
function ShortageModal({ data, onClose }) {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState('trips');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  const needle = q.trim().toLowerCase();
  const trips = (data?.trips ?? []).filter((t) => !needle
    || `${t.driver} ${t.vehicle} ${t.trip_code ?? ''}`.toLowerCase().includes(needle));
  const tot = trips.reduce((a, t) => ({
    penalty: a.penalty + Number(t.penalty || 0),
    recovered: a.recovered + Number(t.recovered || 0),
    pending: a.pending + Number(t.pending || 0),
  }), { penalty: 0, recovered: 0, pending: 0 });

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/80 p-3 backdrop-blur-sm mc-fade-in sm:p-6"
         onClick={onClose} role="presentation">
      <div role="dialog" aria-modal="true" aria-label="Shortage recovery detail"
           onClick={(e) => e.stopPropagation()}
           className="flex w-full max-w-5xl max-h-full flex-col overflow-hidden rounded-2xl border
                      border-red-500/30 bg-slate-900/95 shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
        <div className="flex items-center gap-3 border-b border-slate-700/60 px-4 py-3">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-slate-700/50 bg-white/5 text-red-400">
            <HandCoins size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-[13px] font-black uppercase tracking-wide text-slate-100">Shortage Recovery — trip by trip</h3>
            <p className="text-[10px] text-slate-500">
              {data?.period?.label}
              {data?.period?.from ? ` (${data.period.from} to ${data.period.to})` : ''}
              {' · '}{data?.totals?.trips} trips · {data?.totals?.drivers} drivers
            </p>
          </div>
          <div className="hidden gap-1 rounded-lg bg-black/30 p-1 sm:flex">
            {[['trips', 'Trips'], ['recoveries', 'Recoveries']].map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`rounded-md px-2.5 py-1 text-[10px] font-bold transition-colors
                  ${tab === k ? 'bg-red-500/20 text-red-200' : 'text-slate-500 hover:text-slate-300'}`}>
                {l}
              </button>
            ))}
          </div>
          <label className="hidden items-center gap-1.5 rounded-lg border border-slate-700/60 bg-slate-950/60 px-2 py-1.5 sm:flex">
            <Search size={12} className="text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="driver, truck, trip…"
                   className="w-32 bg-transparent text-[11px] text-slate-200 placeholder-slate-600 outline-none" />
          </label>
          <button onClick={onClose} aria-label="Close"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-slate-700/60 bg-white/5
                       text-slate-400 transition-colors hover:bg-white/10 hover:text-slate-100">
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          {tab === 'trips' ? (
            <table className="w-full min-w-[780px] text-[11px]">
              <thead>
                <tr className="border-b border-slate-800">
                  {['Trip', 'Date', 'Vehicle', 'Driver', 'Short (KL)', 'Penalty', 'Recovered', 'Still owed'].map((h, i) => (
                    <th key={h} className={`sticky top-0 z-10 bg-slate-950/95 px-3 py-2 text-[9.5px] font-black uppercase
                                            tracking-wider text-slate-500 backdrop-blur ${i < 4 ? 'text-left' : 'text-right'}`}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trips.length === 0 && (
                  <tr><td colSpan={8} className="py-6 text-center text-[11px] text-slate-600">
                    {q ? `Nothing matches “${q}”.` : 'No shortage recorded in this period.'}
                  </td></tr>
                )}
                {trips.map((t) => (
                  <tr key={t.trip_id} className={`border-b border-slate-800/60 transition-colors duration-100 hover:bg-white/5
                                                  ${t.settled ? 'opacity-60' : ''}`}>
                    <td className="px-3 py-2 font-bold text-slate-100">{t.trip_code ?? '—'}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-400">{String(t.date ?? '').slice(0, 10)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-slate-300">{t.vehicle}</td>
                    <td className="px-3 py-2 text-slate-300">{t.driver}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-400">
                      {Number(t.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 })}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-slate-200">₹{inrFull(t.penalty)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-emerald-300">₹{inrFull(t.recovered)}</td>
                    <td className={`whitespace-nowrap px-3 py-2 text-right font-mono font-black
                                    ${t.settled ? 'text-slate-600' : shortageText(t.pending)}`}>
                      {t.settled ? 'settled' : `₹${inrFull(t.pending)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-slate-700 bg-slate-950/60">
                  <td colSpan={5} className="px-3 py-2 text-[9.5px] font-black uppercase tracking-wider text-slate-500">
                    {q ? 'Filtered total' : 'Period total'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-black text-slate-100">₹{inrFull(tot.penalty)}</td>
                  <td className="px-3 py-2 text-right font-mono font-black text-emerald-300">₹{inrFull(tot.recovered)}</td>
                  <td className={`px-3 py-2 text-right font-mono font-black ${shortageText(tot.pending)}`}>₹{inrFull(tot.pending)}</td>
                </tr>
              </tfoot>
            </table>
          ) : (
            // The feed that answers "has anybody paid since I last looked".
            <div className="p-3">
              {(data?.recent_recoveries ?? []).length === 0 && (
                <p className="py-6 text-center text-[11px] text-slate-600">No recovery has been posted yet.</p>
              )}
              {(data?.recent_recoveries ?? []).map((r, i) => (
                <div key={i} className="mb-1.5 flex items-center gap-3 rounded-lg border border-slate-800/60 bg-white/[0.03] px-3 py-2">
                  <span className="shrink-0 font-mono text-[10px] text-slate-600">{String(r.txn_date ?? '').slice(0, 10)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11.5px] font-bold text-slate-200">{r.driver_name}</p>
                    <p className="truncate text-[9.5px] text-slate-500">
                      {[r.trip_code, r.vehicle_no, r.mode].filter(Boolean).join(' · ') || 'no trip linked'}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono text-[12px] font-black text-emerald-300">₹{inrFull(r.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="border-t border-slate-700/60 px-4 py-2 text-[9.5px] leading-relaxed text-slate-500">
          “Still owed” is the penalty charged minus what the driver khata has already taken back — arithmetic over two
          tables, not a flag somebody has to remember to clear. Post a recovery and this figure drops on the next
          refresh. Settled rows are dimmed rather than hidden: a settled penalty shown as outstanding is how a driver
          gets docked twice for the same shortage.
        </p>
      </div>
    </div>,
    document.body,
  );
}

export function ShortageRecoveryPanel({ live, filter }) {
  const [showSettled, setShowSettled] = useState(false);
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState('ALL');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading');

  const qs = useMemo(() => {
    const q = new URLSearchParams({ period, offset: String(offset) });
    const f = filter?.filters ?? {};
    if (f.companyId) q.set('company_id', f.companyId);
    if (f.branchId) q.set('branch_id', f.branchId);
    if (f.owner) q.set('owner', f.owner);
    if (f.fleet) q.set('fleet', f.fleet);
    return q.toString();
  }, [period, offset, filter?.filters]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setState('loading');
    try {
      const r = await fetch(`${API_BASE}/api/v1/dashboard/shortage-recovery?${qs}`);
      if (!r.ok) { setState('error'); return; }
      setData(await r.json());
      setState('ok');
    } catch { setState('error'); }
  }, [qs]);

  useEffect(() => { load(); }, [load]);

  // Auto-update: a recovery posted anywhere in the ERP shows up here without a
  // reload. Quietly, so it never blanks a panel somebody is reading.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') load(true);
    }, 30000);
    // A hidden tab deliberately stops polling — but that means coming back to
    // it shows figures from whenever you left, which for money is worse than
    // showing nothing. Refresh on return, so what you look at is what is true.
    const onVis = () => { if (document.visibilityState === 'visible') load(true); };
    document.addEventListener('visibilitychange', onVis);
    // A save anywhere in the ERP refreshes this panel at once. The wrapper in
    // lib/dataChangeBus fires this after any successful write to /api/v1, so
    // the poll below is only the floor for changes made on ANOTHER machine.
    const onChanged = () => load(true);
    window.addEventListener('erp:data-changed', onChanged);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('erp:data-changed', onChanged);
    };
  }, [load]);

  const tot = data?.totals;
  const pending = data?.pending ?? [];
  const settled = data?.settled ?? [];
  const maxPending = Number(pending[0]?.pending ?? 0) || Number(settled[0]?.penalty ?? 0);
  const trend = data?.trend ?? [];
  const trendMax = Math.max(1, ...trend.map((x) => Number(x.charged)));

  const TABS = [
    { k: 'FORTNIGHT', label: 'Fortnight' },
    { k: 'MONTH', label: 'Month' },
    { k: 'YEAR', label: 'Year' },
    { k: 'ALL', label: 'All' },
  ];

  return (
    <GlassPanel className={pending.length ? 'border-red-500/40' : 'border-emerald-500/25'}>
      <PanelHeader
        icon={pending.length ? HandCoins : ShieldCheck}
        title="Driver Shortage Recovery"
        accent={pending.length ? 'text-red-400' : 'text-emerald-400'}
        sub={data ? `${data.period?.label} · ${tot?.trips ?? 0} trips · ${tot?.drivers ?? 0} drivers` : 'loading…'}
        right={
          <button onClick={() => setOpen(true)} disabled={!data?.trips?.length}
            className="rounded-lg border border-red-600/50 bg-red-500/10 px-2.5 py-1 text-[10px] font-bold
                       text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-40">
            ALL DETAILS
          </button>
        }
      />

      <div className="px-3 pb-3">
        <div className="mb-2.5 flex items-center gap-1.5">
          <div className="flex flex-1 gap-1 rounded-xl bg-black/30 p-1">
            {TABS.map((t) => (
              <button key={t.k} onClick={() => { setPeriod(t.k); setOffset(0); }}
                className={`flex-1 rounded-lg px-2 py-1.5 text-[10.5px] font-black transition-all duration-150
                  ${period === t.k ? 'bg-red-500/20 text-red-200 shadow-[inset_0_0_0_1px_rgba(248,113,113,0.35)]'
                                   : 'text-slate-500 hover:bg-white/5 hover:text-slate-300'}`}>
                {t.label}
              </button>
            ))}
          </div>
          {period !== 'ALL' && (
            <div className="flex shrink-0 items-center gap-0.5 rounded-xl bg-black/30 p-1">
              <button onClick={() => setOffset((o) => o + 1)} aria-label="Previous period"
                className="grid h-6 w-6 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-red-300">
                <ChevronLeft size={13} />
              </button>
              <button onClick={() => setOffset((o) => Math.max(0, o - 1))} disabled={offset === 0}
                aria-label="Next period"
                className="grid h-6 w-6 place-items-center rounded-lg text-slate-400 hover:bg-white/10 hover:text-red-300 disabled:opacity-25">
                <ChevronRight size={13} />
              </button>
            </div>
          )}
        </div>

        {tot && (
          <>
            <div className="mb-2 grid grid-cols-3 gap-1.5">
              <Tile label="Charged" value={`₹${inr(tot.charged)}`} tone="text-slate-100"
                    sub={`${Number(tot.qty).toLocaleString('en-IN', { maximumFractionDigits: 2 })} KL short`} />
              <Tile label="Recovered" value={`₹${inr(tot.recovered)}`} tone="text-emerald-300"
                    sub={tot.recovery_pct != null ? `${tot.recovery_pct}% of charged` : null} />
              <Tile label="Still owed" value={`₹${inr(tot.pending)}`}
                    tone={Number(tot.pending) > 0 ? 'text-red-400' : 'text-emerald-400'}
                    sub={pending.length ? `${pending.length} driver${pending.length === 1 ? '' : 's'}` : 'nothing outstanding'} />
            </div>

            {/* recovery rate, as a bar rather than a percentage nobody reads */}
            {tot.recovery_pct != null && (
              <div className="mb-2.5">
                <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-300 transition-all duration-700"
                       style={{ width: `${tot.recovery_pct}%` }} />
                </div>
              </div>
            )}
          </>
        )}

        {/* fortnight trend — charged against recovered. A period where the two
            diverge is one where money stopped coming back. */}
        {trend.length > 1 && (
          <div className="mb-2.5 rounded-xl border border-slate-800/70 bg-black/25 px-2.5 py-2">
            <p className="mb-1.5 text-[8.5px] font-black uppercase tracking-wider text-slate-600">
              By fortnight · charged vs recovered
            </p>
            <div className="flex h-12 items-end gap-1">
              {trend.map((x) => {
                const ch = (Number(x.charged) / trendMax) * 100;
                const rc = (Number(x.recovered) / trendMax) * 100;
                return (
                  <div key={x.label} className="group relative flex flex-1 items-end justify-center gap-px"
                       title={`${x.label}: charged ₹${inrFull(x.charged)}, recovered ₹${inrFull(x.recovered)}`}>
                    <span className="w-1/2 rounded-t-sm bg-slate-600/70" style={{ height: `${Math.max(2, ch)}%` }} />
                    <span className="w-1/2 rounded-t-sm bg-emerald-500/80" style={{ height: `${Math.max(2, rc)}%` }} />
                  </div>
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-[7.5px] text-slate-600">
              <span>{trend[0]?.label}</span><span>{trend[trend.length - 1]?.label}</span>
            </div>
          </div>
        )}

        {state === 'loading' && (
          <div className="flex flex-col gap-1.5">
            {[...Array(3)].map((_, i) => <div key={i} className="h-10 animate-pulse rounded-lg bg-white/5" />)}
          </div>
        )}

        {state === 'ok' && pending.length === 0 && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-3">
            <p className="flex items-center gap-1.5 text-[11px] font-black text-emerald-300">
              <ShieldCheck size={13} /> Nothing outstanding in {data.period?.label}.
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              {settled.length > 0
                ? `All ${tot.trips} shortage${tot.trips === 1 ? '' : 's'} — ₹${inrFull(tot.charged)} across ${settled.length} driver${settled.length === 1 ? '' : 's'} — have been recovered through the driver khata.`
                : 'No shortage was recorded in this period at all.'}
            </p>
          </div>
        )}

        {state === 'ok' && pending.length > 0 && (
          <div className="flex flex-col gap-1.5">
            {pending.map((r) => <ShortageRow key={`${r.driver}-${r.vehicle}`} r={r} max={maxPending} />)}
          </div>
        )}

        {settled.length > 0 && (
          <>
            <button onClick={() => setShowSettled((v) => !v)}
              className="mt-2 w-full rounded-lg border border-slate-700/60 bg-white/5 px-2 py-1.5 text-[9.5px]
                         font-bold uppercase tracking-wider text-slate-400 transition-colors hover:bg-white/10">
              {showSettled ? '▴ hide' : '▾ show'} {settled.length} already recovered · ₹{inrFull(tot.recovered)}
            </button>
            {showSettled && (
              <div className="mt-1.5 flex flex-col gap-1.5">
                {settled.map((r) => <ShortageRow key={`${r.driver}-${r.vehicle}`} r={r} settled max={maxPending} />)}
              </div>
            )}
          </>
        )}
      </div>

      {open && <ShortageModal data={data} onClose={() => setOpen(false)} />}
    </GlassPanel>
  );
}


// ── COMPLIANCE EXPIRY ALERTS ────────────────────────────────────────────────
// The Master Document Vault above shows the soonest expiry per document TYPE
// across the fleet. That is a summary and cannot be acted on: it never names
// the lorry or the driver. This does, for everything inside the operator's own
// 10-day window, and it separates ALREADY EXPIRED from EXPIRING — the first is
// not a warning, it is a vehicle that should not be on the road today.
export function ComplianceAlertsPanel({ live }) {
  const data = live?.data?.ops?.compliance_alerts;
  const expired = data?.expired ?? [];
  const expiring = data?.expiring ?? [];
  const total = expired.length + expiring.length;
  const sweep = data?.last_sweep ?? null;

  // An empty list means "nothing expires soon" AND "the background sweep died
  // three weeks ago". The sweep's own date is the only thing that tells them
  // apart, so it is shown rather than assumed.
  const sweepToday = sweep?.ran_on
    ? String(sweep.ran_on).slice(0, 10) === new Date().toISOString().slice(0, 10)
    : false;

  return (
    <GlassPanel className={expired.length ? 'border-red-500/50' : total ? 'border-amber-500/40' : 'border-slate-700/50'}>
      <PanelHeader
        icon={expired.length ? ShieldAlert : CalendarClock}
        title="Compliance Expiry — 10 Day Watch"
        accent={expired.length ? 'text-red-400' : total ? 'text-amber-400' : 'text-slate-400'}
        sub={`vehicles and drivers · threshold ${data?.threshold_days ?? 10} days`}
        right={
          <StatusPill tone={expired.length ? 'red' : total ? 'amber' : 'emerald'} pulse={expired.length > 0}>
            {expired.length ? `${expired.length} EXPIRED` : total ? `${total} due` : 'all current'}
          </StatusPill>
        }
      />

      <div className="px-3 pb-3">
        {expired.length > 0 && (
          <div className="mb-2 rounded-xl border border-red-500/50 bg-red-500/10 px-3 py-2 shadow-[0_0_20px_rgba(248,113,113,0.18)]">
            <p className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-wider text-red-300">
              <ShieldAlert size={13} /> {expired.length} document{expired.length === 1 ? '' : 's'} already expired
            </p>
            <p className="mt-0.5 text-[9.5px] leading-relaxed text-red-200/80">
              These are not reminders. A lapsed licence or fitness certificate stops the vehicle at the first check.
            </p>
          </div>
        )}

        {total === 0 ? (
          <p className="py-3 text-center text-[11px] text-slate-500">
            Nothing expires within {data?.threshold_days ?? 10} days.
          </p>
        ) : (
          <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
            {[...expired, ...expiring].map((r, i) => (
              <AlertRow key={`${r.kind}-${r.subject}-${r.doc_type}-${i}`} r={r} />
            ))}
          </div>
        )}

        <p className={`mt-2 border-t border-slate-800 pt-1.5 text-[9px] ${sweepToday ? 'text-slate-600' : 'text-amber-400/80'}`}>
          {sweep
            ? `Background sweep last ran ${String(sweep.ran_on).slice(0, 10)} — checked ${sweep.checked}, ${sweep.expired} expired.`
              + (sweepToday ? '' : ' ⚠ That is not today; the check may not be running.')
            : '⚠ The background sweep has never recorded a run — this list is live, but nothing is watching it.'}
        </p>
      </div>
    </GlassPanel>
  );
}

function AlertRow({ r }) {
  const gone = r.days < 0;
  const { triggerProps, overlay } = useHoverCard(() => (
    <>
      <HoverTitle sub={r.kind === 'DRIVER' ? 'Driver document' : 'Vehicle document'}>{r.subject}</HoverTitle>
      <HoverKv k="Document" v={r.doc_name} mono={false} />
      <HoverKv k="Expires on" v={String(r.expires_on).slice(0, 10)} />
      <HoverKv strong k={gone ? 'Expired' : 'Days left'}
               v={gone ? `${Math.abs(r.days)} day${Math.abs(r.days) === 1 ? '' : 's'} ago` : `${r.days}`}
               tone={gone ? 'text-red-400' : r.days <= 3 ? 'text-red-300' : 'text-amber-300'} />
      {r.owner && <HoverKv k="Owner" v={r.owner} mono={false} />}
      <HoverNote tone={gone ? 'text-red-300/90' : 'text-amber-300/90'}>
        {gone
          ? 'Already lapsed. Renewing it posts the fee as a PENDING expense — it reaches the cashbook only after an admin approves it.'
          : 'Renew before the date. The fee entered on the vault screen queues for approval rather than posting itself.'}
      </HoverNote>
      <HoverNote>Source: {r.source}</HoverNote>
    </>
  ), { placement: 'top', width: 290 });

  return (
    <>
      <div
        {...triggerProps}
        tabIndex={0}
        className={`touch-manipulation flex items-center gap-2.5 rounded-lg border px-2.5 py-2 outline-none
                    transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-cyan-400/60
          ${gone
            ? 'border-red-500/50 bg-red-500/10 hover:bg-red-500/15'
            : r.days <= 3
              ? 'border-orange-500/50 bg-orange-500/10 hover:bg-orange-500/15'
              : 'border-amber-500/40 bg-amber-500/5 hover:bg-amber-500/10'}`}
      >
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider
          ${r.kind === 'DRIVER' ? 'bg-violet-500/20 text-violet-300' : 'bg-cyan-500/20 text-cyan-300'}`}>
          {r.kind === 'DRIVER' ? 'DRV' : 'VEH'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-bold text-slate-100">{r.subject}</p>
          <p className="truncate text-[9px] text-slate-500">{r.doc_name}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className={`text-[11px] font-black ${gone ? 'text-red-400' : r.days <= 3 ? 'text-orange-300' : 'text-amber-300'}`}>
            {gone ? `${Math.abs(r.days)}d ago` : `${r.days}d`}
          </p>
          <p className="text-[8.5px] uppercase tracking-wider text-slate-600">
            {gone ? 'expired' : 'left'}
          </p>
        </div>
      </div>
      {overlay}
    </>
  );
}
