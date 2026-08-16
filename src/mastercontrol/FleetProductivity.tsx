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
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Gauge, X, ArrowUpRight, ArrowDownRight, HandCoins, ShieldCheck, Search,
  ShieldAlert, CalendarClock,
} from 'lucide-react';
import {
  GlassPanel, PanelHeader, StatusPill, useHoverCard, HoverTitle, HoverKv, HoverNote,
} from './shared';
import { inr, inrFull } from './useDashboardData';

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
function RtkmModal({ rows, onClose }) {
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
              {rows.length} vehicle{rows.length === 1 ? '' : 's'} with recorded RTKM · click a heading to re-sort
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
                {th('shortage', 'Total Shortage')}
              </tr>
            </thead>
            <tbody>
              {view.length === 0 && (
                <tr><td colSpan={5} className="py-6 text-center text-[11px] text-slate-600">No vehicle matches “{q}”.</td></tr>
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
                <td className={`px-3 py-2 text-right font-mono font-black ${shortageText(totals.shortage)}`}>₹{inrFull(totals.shortage)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <p className="border-t border-slate-700/60 px-4 py-2 text-[9.5px] leading-relaxed text-slate-500">
          RTKM is the round-trip distance recorded on each trip. Freight is the billed amount — the same figure the
          Owner Fleet Matrix reads, so the two agree. A vehicle showing “not billed” has run trips with no freight
          recorded against them yet; its RTKM is real, its revenue is simply not in the books.
        </p>
      </div>
    </div>,
    document.body,
  );
}

// ── one ranked row ──────────────────────────────────────────────────────────
function RankRow({ r, rank, best }) {
  const { triggerProps, overlay } = useHoverCard(() => (
    <>
      <HoverTitle sub={`${r.trips} trip${r.trips === 1 ? '' : 's'} with recorded RTKM`}>{r.vehicle}</HoverTitle>
      <HoverKv k="Total RTKM" v={`${km(r.rtkm)} km`} tone="text-cyan-300" />
      <HoverKv k="Average per trip" v={`${km(Number(r.rtkm) / Math.max(1, r.trips))} km`} />
      <HoverKv k="Total freight bill" v={Number(r.freight) > 0 ? `₹${inrFull(r.freight)}` : 'not billed'}
               tone={Number(r.freight) > 0 ? 'text-slate-200' : 'text-amber-300'} />
      <HoverKv strong k="Total shortage" v={Number(r.shortage) > 0 ? `₹${inrFull(r.shortage)}` : 'none'}
               tone={shortageText(r.shortage)} />
      {r.unbilled_trips > 0 && (
        <HoverNote tone="text-amber-300/90">
          {r.unbilled_trips} of these trips carry no billed freight, so the revenue
          shown is lower than the distance run would suggest.
        </HoverNote>
      )}
    </>
  ), { placement: 'top', width: 280 });

  return (
    <>
      <div
        {...triggerProps}
        tabIndex={0}
        className="touch-manipulation flex items-center gap-2 rounded-lg border border-slate-800/60 bg-white/5
                   px-2.5 py-1.5 outline-none transition-colors duration-100 hover:bg-white/10
                   focus-visible:ring-1 focus-visible:ring-cyan-400/60"
      >
        <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-md text-[9px] font-black
          ${best ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700/40 text-slate-400'}`}>{rank}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-slate-100">{r.vehicle}</span>
        <span className="shrink-0 font-mono text-[11px] font-black text-cyan-300">{km(r.rtkm)}</span>
        <span className="shrink-0 text-[8.5px] uppercase tracking-wider text-slate-600">km</span>
      </div>
      {overlay}
    </>
  );
}

// ── TOP / BOTTOM 5 BY RTKM ──────────────────────────────────────────────────
export function VehicleRtkmPanel({ live }) {
  const [open, setOpen] = useState(false);
  const data = live?.data?.ops?.vehicle_rtkm;
  const top = data?.top ?? [];
  const bottom = data?.bottom ?? [];
  const all = data?.all ?? [];

  return (
    <GlassPanel className="border-cyan-500/25">
      <PanelHeader
        icon={Gauge}
        title="Vehicle Productivity — RTKM"
        accent="text-cyan-400"
        sub={all.length ? `${all.length} vehicles ranked · click for the full report` : 'no RTKM recorded yet'}
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

      {all.length === 0 ? (
        <p className="px-4 pb-4 text-[11px] leading-relaxed text-slate-500">
          No trip in this scope has a round-trip distance recorded, so there is nothing to rank.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 px-3 pb-3 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[9px] font-black uppercase tracking-wider text-emerald-400">
                <ArrowUpRight size={11} /> Top 5 — highest RTKM
              </p>
              <div className="flex flex-col gap-1">
                {top.map((r, i) => <RankRow key={r.vehicle} r={r} rank={i + 1} best />)}
              </div>
            </div>
            <div>
              <p className="mb-1.5 flex items-center gap-1.5 px-1 text-[9px] font-black uppercase tracking-wider text-amber-400">
                <ArrowDownRight size={11} /> Bottom 5 — lowest RTKM
              </p>
              <div className="flex flex-col gap-1">
                {bottom.map((r, i) => <RankRow key={r.vehicle} r={r} rank={all.length - i} />)}
              </div>
            </div>
          </div>

          {/* With fewer than ten ranked vehicles the two lists share rows. Saying
              so is cheaper than letting someone read the same truck as both the
              best and the worst performer. */}
          {data?.overlap && (
            <p className="px-4 pb-3 text-[9.5px] text-amber-400/80">
              ⚠ Only {all.length} vehicles have RTKM in this scope, so the two lists overlap — some trucks appear in both.
            </p>
          )}
        </>
      )}

      {open && <RtkmModal rows={all} onClose={() => setOpen(false)} />}
    </GlassPanel>
  );
}

// ── DRIVER SHORTAGE RECOVERY ────────────────────────────────────────────────
function ShortageRow({ r, settled }) {
  const { triggerProps, overlay } = useHoverCard(() => (
    <>
      <HoverTitle sub={r.vehicle}>{r.driver}</HoverTitle>
      <HoverKv k="Trips with shortage" v={r.trips} />
      {r.trip_codes && <HoverKv k="Trips" v={r.trip_codes} mono={false} />}
      <HoverKv k="Shortage quantity" v={r.qty != null ? `${Number(r.qty).toLocaleString('en-IN', { maximumFractionDigits: 3 })} KL` : '—'} />
      <HoverKv k="Penalty charged" v={`₹${inrFull(r.penalty)}`} />
      <HoverKv k="Already recovered" v={`₹${inrFull(r.recovered)}`} tone="text-emerald-300" />
      <HoverKv strong k="Still owed" v={`₹${inrFull(r.pending)}`}
               tone={Number(r.pending) > 0 ? shortageText(r.pending) : 'text-emerald-400'} />
      <HoverNote tone={settled ? 'text-emerald-300/80' : 'text-amber-300/90'}>
        {settled
          ? 'Fully recovered through the driver khata — nothing further to collect. Shown for the record, not for action.'
          : 'Not yet taken back. Recovery posts to the driver khata and its GL leg in the same transaction.'}
      </HoverNote>
    </>
  ), { placement: 'top', width: 300 });

  return (
    <>
      <div
        {...triggerProps}
        tabIndex={0}
        className={`touch-manipulation flex items-center gap-2.5 rounded-lg border px-2.5 py-2 outline-none
                    transition-colors duration-100 focus-visible:ring-1 focus-visible:ring-cyan-400/60
          ${settled
            ? 'border-slate-800/60 bg-white/[0.03] hover:bg-white/[0.06]'
            : shortageTone(r.pending) === 'red'
              ? 'border-red-500/50 bg-red-500/10 hover:bg-red-500/15 shadow-[0_0_16px_rgba(248,113,113,0.15)]'
              : shortageTone(r.pending) === 'amber'
                ? 'border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/15'
                : 'border-slate-700/60 bg-white/5 hover:bg-white/10'}`}
      >
        <div className="min-w-0 flex-1">
          <p className={`truncate text-[11px] font-bold ${settled ? 'text-slate-400' : 'text-slate-100'}`}>{r.driver}</p>
          <p className="truncate text-[9px] text-slate-500">
            {r.vehicle} · {r.trips} trip{r.trips === 1 ? '' : 's'}
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
      {overlay}
    </>
  );
}

export function ShortageRecoveryPanel({ live }) {
  const [showSettled, setShowSettled] = useState(false);
  const data = live?.data?.ops?.shortage_recovery;
  const pending = data?.pending ?? [];
  const settled = data?.settled ?? [];

  // Summed for the header pill only. Both figures come from the API as
  // SQL-summed strings; this is display arithmetic, not accounting.
  const owed = pending.reduce((a, r) => a + Number(r.pending || 0), 0);
  const back = settled.reduce((a, r) => a + Number(r.recovered || 0), 0);

  return (
    <GlassPanel className={pending.length ? 'border-red-500/40' : 'border-emerald-500/25'}>
      <PanelHeader
        icon={pending.length ? HandCoins : ShieldCheck}
        title="Driver Shortage Recovery"
        accent={pending.length ? 'text-red-400' : 'text-emerald-400'}
        sub={pending.length ? 'outstanding against drivers' : 'nothing outstanding'}
        right={
          <StatusPill tone={pending.length ? 'red' : 'emerald'} pulse={pending.length > 0}>
            {pending.length ? `₹${inr(owed)} to recover` : 'all recovered'}
          </StatusPill>
        }
      />

      <div className="px-3 pb-3">
        {pending.length === 0 ? (
          // NOT an empty box. Every shortage on the books has been taken back,
          // and the panel has to say that plainly — an empty list reads as
          // "not loaded" and invites someone to go looking for the data.
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-3 py-3">
            <p className="flex items-center gap-1.5 text-[11px] font-black text-emerald-300">
              <ShieldCheck size={13} /> No shortage is outstanding.
            </p>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              All {settled.reduce((a, r) => a + r.trips, 0)} shortage{settled.reduce((a, r) => a + r.trips, 0) === 1 ? '' : 's'} on
              the books — ₹{inrFull(back)} across {settled.length} driver{settled.length === 1 ? '' : 's'} — have been recovered
              through the driver khata. Nothing here needs collecting.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {pending.map((r) => <ShortageRow key={`${r.driver}-${r.vehicle}`} r={r} />)}
          </div>
        )}

        {settled.length > 0 && (
          <>
            <button
              onClick={() => setShowSettled((v) => !v)}
              className="mt-2 w-full rounded-lg border border-slate-700/60 bg-white/5 px-2 py-1.5 text-[9.5px]
                         font-bold uppercase tracking-wider text-slate-400 transition-colors hover:bg-white/10"
            >
              {showSettled ? '▴ hide' : '▾ show'} {settled.length} already recovered · ₹{inrFull(back)}
            </button>
            {showSettled && (
              <div className="mt-1.5 flex flex-col gap-1.5">
                {settled.map((r) => <ShortageRow key={`${r.driver}-${r.vehicle}`} r={r} settled />)}
              </div>
            )}
          </>
        )}
      </div>

      {settled.length > 0 && (
        <p className="px-4 pb-3 text-[9.5px] leading-relaxed text-slate-500">
          Recovered entries are kept behind a fold rather than mixed in. A settled penalty shown as actionable is
          how a driver gets docked for the same shortage twice.
        </p>
      )}
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
