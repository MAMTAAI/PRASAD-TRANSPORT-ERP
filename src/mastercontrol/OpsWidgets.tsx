// @ts-nocheck
// ============================================================================
// Panels that had a KPI number but no list behind it.
//
// "51 pending unloading" and "₹60,731 unbilled" tell you a problem exists.
// Neither tells you WHICH truck is sitting or WHOSE invoice has not gone out,
// which is the only form of those numbers anybody can act on. These are the
// lists — driven by the same 3-tier filter as the cards above them, so the
// count and the rows can never disagree.
// ============================================================================
import React from 'react';
import { PackageOpen, ReceiptText, Scale, AlertTriangle } from 'lucide-react';
import {
  GlassPanel, PanelHeader, StatusPill, useHoverCard, HoverTitle, HoverKv, HoverNote,
} from './shared';
import { inr, inrFull } from './useDashboardData';

const dmy = (d) => {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); }
  catch { return '—'; }
};

/** Age colouring. A truck out three days is normal; three weeks is a question
 *  somebody needs to answer today. */
const ageTone = (d) => (d == null ? 'slate' : d > 21 ? 'red' : d > 7 ? 'amber' : 'emerald');

// ── UNLOADING QUEUE ─────────────────────────────────────────────────────────
export function UnloadingQueue({ live }) {
  const rows = live?.data?.ops?.unloading_queue ?? [];
  const pending = live?.data?.ops?.pending_unloading ?? 0;

  return (
    <GlassPanel className={`h-full flex flex-col ${rows.some((r) => r.days_out > 21) ? 'border-red-500/30' : ''}`}>
      <PanelHeader
        icon={PackageOpen}
        title="Unloading Queue"
        accent="text-amber-400"
        sub="loaded, not yet unloaded"
        right={<StatusPill tone={pending > 0 ? 'amber' : 'emerald'} pulse={pending > 0}>{pending} waiting</StatusPill>}
      />
      <div className="flex-1 min-h-0 px-3 pb-3 max-h-[26rem] overflow-y-auto">
        {rows.length === 0 && <p className="py-4 text-center text-[11px] text-slate-600">Nothing waiting to unload.</p>}
        <div className="flex flex-col gap-1.5">
          {rows.map((r, i) => (
            <QueueRow key={`${r.trip_code}-${i}`} r={r} />
          ))}
        </div>
      </div>
    </GlassPanel>
  );
}

// A queued truck. The row has space for the vehicle, the lane and the age; the
// card carries the rest — which is what somebody chasing a three-week-old load
// actually needs, and it arrives on hover rather than on a trip to another
// screen.
function QueueRow({ r }) {
  const { triggerProps, overlay } = useHoverCard(() => (
    <>
      <HoverTitle sub={r.trip_code ? `Trip ${r.trip_code}` : 'No trip code recorded'}>{r.vehicle}</HoverTitle>
      <HoverKv k="Route" v={r.route || '—'} mono={false} />
      <HoverKv k="Driver" v={r.driver || 'not assigned'} mono={false}
               tone={r.driver ? 'text-slate-200' : 'text-amber-300'} />
      <HoverKv k="Product" v={r.product || '—'} mono={false} />
      <HoverKv k="Quantity" v={r.qty != null ? `${Number(r.qty).toLocaleString('en-IN')} KL` : '—'} />
      <HoverKv k="Loaded on" v={dmy(r.since)} />
      <HoverKv strong k="Standing" v={r.days_out == null ? 'date not recorded' : `${r.days_out} day${r.days_out === 1 ? '' : 's'}`}
               tone={r.days_out > 21 ? 'text-red-400' : r.days_out > 7 ? 'text-amber-300' : 'text-emerald-400'} />
      {r.days_out > 21 && (
        <HoverNote tone="text-red-300/90">
          Over three weeks loaded and not unloaded. Either the unload was never
          entered or this truck is genuinely still holding the consignment.
        </HoverNote>
      )}
      {r.days_out == null && (
        <HoverNote tone="text-amber-300/90">
          No loading date on the trip, so the age cannot be computed — the row is
          shown rather than dropped, because a trip with no date is its own problem.
        </HoverNote>
      )}
    </>
  ), { placement: 'top', width: 280 });

  return (
    <>
      <div
        {...triggerProps}
        tabIndex={0}
        className="touch-manipulation outline-none flex items-center gap-2.5 rounded-lg border border-slate-800/60
                   bg-white/5 px-2.5 py-2 transition-colors duration-100 hover:bg-white/10 hover:border-amber-500/40
                   focus-visible:ring-1 focus-visible:ring-cyan-400/60"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold text-slate-100">{r.vehicle}</span>
            {r.trip_code && <span className="text-[9px] text-slate-500">{r.trip_code}</span>}
          </div>
          <div className="text-[9px] text-slate-500 truncate">{r.route}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[9px] text-slate-500">{dmy(r.since)}</div>
          <StatusPill tone={ageTone(r.days_out)}>
            {r.days_out == null ? 'date?' : `${r.days_out}d out`}
          </StatusPill>
        </div>
      </div>
      {overlay}
    </>
  );
}

// ── UNBILLED FREIGHT ────────────────────────────────────────────────────────
export function UnbilledFreight({ live }) {
  const rows = live?.data?.finance?.unbilled_list ?? [];
  const total = live?.data?.finance?.unbilled_freight ?? 0;

  return (
    <GlassPanel className="border-amber-500/25">
      <PanelHeader
        icon={ReceiptText}
        title="Unbilled Freight Ledger"
        accent="text-amber-400"
        sub="delivered, invoice not raised"
        right={<StatusPill tone="amber">₹{inr(total)}</StatusPill>}
      />
      <div className="px-3 pb-3 max-h-72 overflow-y-auto">
        {rows.length === 0 && <p className="py-4 text-center text-[11px] text-slate-600">Everything is billed.</p>}
        <div className="flex flex-col gap-1.5">
          {rows.map((r, i) => (
            <UnbilledRow key={`${r.trip_code}-${i}`} r={r} />
          ))}
        </div>
      </div>
      <p className="px-4 pb-3 text-[9px] text-slate-600">
        Rows showing “no rate” have no freight amount recorded either — those need a rate before they can be billed.
      </p>
    </GlassPanel>
  );
}

// One un-invoiced delivery. "no rate" and "billed but not invoiced" are two
// different jobs for two different people, so the card says which one this is
// instead of leaving the reader to infer it from a blank.
function UnbilledRow({ r }) {
  const priced = Number(r.amount) > 0;
  const { triggerProps, overlay } = useHoverCard(() => (
    <>
      <HoverTitle sub={r.trip_code ? `Trip ${r.trip_code}` : 'No trip code recorded'}>{r.vehicle}</HoverTitle>
      <HoverKv k="Customer" v={r.customer ?? 'not set'} mono={false}
               tone={r.customer ? 'text-slate-200' : 'text-amber-300'} />
      <HoverKv k="Delivered" v={dmy(r.since ?? r.date)} />
      <HoverKv k="Waiting" v={r.age_days == null ? 'date not recorded' : `${r.age_days} day${r.age_days === 1 ? '' : 's'}`}
               tone={r.age_days > 21 ? 'text-red-400' : r.age_days > 7 ? 'text-amber-300' : 'text-slate-200'} />
      <HoverKv strong k="Freight" v={priced ? `₹${inrFull(r.amount)}` : 'no rate'}
               tone={priced ? 'text-amber-300' : 'text-slate-500'} />
      <HoverNote tone={priced ? 'text-slate-400' : 'text-amber-300/90'}>
        {priced
          ? 'Priced and delivered — this one is waiting on an invoice, nothing else.'
          : 'No freight amount on the trip at all. A rate has to be set before this can be invoiced, so it is not an invoicing backlog item yet.'}
      </HoverNote>
    </>
  ), { placement: 'top', width: 280 });

  return (
    <>
      <div
        {...triggerProps}
        tabIndex={0}
        className="touch-manipulation outline-none flex items-center gap-2.5 rounded-lg border border-slate-800/60
                   bg-white/5 px-2.5 py-2 transition-colors duration-100 hover:bg-white/10 hover:border-amber-500/40
                   focus-visible:ring-1 focus-visible:ring-cyan-400/60"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold text-slate-100">{r.vehicle}</span>
            {r.trip_code && <span className="text-[9px] text-slate-500">{r.trip_code}</span>}
          </div>
          <div className="text-[9px] text-slate-500 truncate">{r.customer ?? 'customer not set'}</div>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[10px] font-mono text-slate-300">
            {priced ? `₹${inrFull(r.amount)}` : <span className="text-slate-600">no rate</span>}
          </div>
          <StatusPill tone={ageTone(r.age_days)}>
            {r.age_days == null ? 'date?' : `${r.age_days}d`}
          </StatusPill>
        </div>
      </div>
      {overlay}
    </>
  );
}

// ── REAL-TIME P&L ───────────────────────────────────────────────────────────
export function LivePnl({ live }) {
  const p = live?.data?.finance?.pnl;
  if (!p) {
    return (
      <GlassPanel className="border-amber-500/30">
        <PanelHeader icon={AlertTriangle} title="Real-time P&L" accent="text-amber-400" sub="not available" />
        <div className="px-4 pb-4 text-[11px] text-slate-500">The books did not return a statement for this scope.</div>
      </GlassPanel>
    );
  }
  const profit = Number(p.net) >= 0;
  // A company-scoped statement is only as good as the tagging behind it. Most
  // Freight Income postings carry no company, so a filtered P&L drops nearly
  // all income and every firm reads as a heavy loss. That is unattributed data,
  // not a loss, and the screen has to say so before anyone acts on it.
  const cov = p.coverage;
  const unreliable = cov && cov.pct < 90;

  return (
    <GlassPanel className={unreliable ? 'border-amber-500/50' : profit ? 'border-emerald-500/25' : 'border-red-500/30'}>
      <PanelHeader
        icon={Scale}
        title="Real-time P&L"
        accent={profit ? 'text-emerald-400' : 'text-red-400'}
        sub="posted books, live"
        right={
          <StatusPill tone={profit ? 'emerald' : 'red'}>
            {profit ? 'PROFIT' : 'LOSS'} ₹{inr(Math.abs(p.net))}
          </StatusPill>
        }
      />
      {unreliable && (
        <div className="mx-4 mb-3 rounded-xl border border-amber-500/50 bg-amber-500/10 px-3 py-2.5">
          <p className="text-[11px] font-black text-amber-300">
            ⚠ This company-wise P&amp;L is INCOMPLETE — do not read it as a result.
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-amber-200/80">
            Only {cov.pct}% of profit-and-loss postings carry a company tag
            ({cov.untagged} of {cov.total} untagged, ₹{inrFull(cov.untagged_amount)}).
            The untagged entries include most Freight Income, so filtering by company
            drops the revenue and leaves the costs — which is why this reads as a loss.
            Clear the company filter for the true group result.
          </p>
        </div>
      )}

      <div className="px-4 pb-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Column title="Income" rows={p.income} total={p.total_income} tone="text-emerald-300" />
        <Column title="Expenses" rows={p.expense} total={p.total_expense} tone="text-red-300" />
      </div>
      <div className="mx-4 mb-4 flex items-center justify-between rounded-xl border border-slate-700/70 bg-white/5 px-3 py-2.5">
        <span className="text-[10px] font-black uppercase tracking-wider text-slate-500">Net Result</span>
        <span className={`font-mono text-sm font-black ${profit ? 'text-emerald-400' : 'text-red-400'}`}>
          ₹{inrFull(p.net)}
        </span>
      </div>
    </GlassPanel>
  );
}

function Column({ title, rows, total, tone }) {
  return (
    <div>
      <div className="mb-1.5 text-[9px] font-black uppercase tracking-wider text-slate-600">{title}</div>
      <div className="flex flex-col gap-1">
        {rows.length === 0 && <p className="text-[10px] text-slate-600 py-1">Nothing posted.</p>}
        {rows.map((r) => (
          <div key={r.group} className="flex items-baseline justify-between gap-2">
            <span className="text-[10.5px] text-slate-400 truncate">{r.group}</span>
            <span className={`font-mono text-[11px] font-bold shrink-0 ${tone}`}>₹{inrFull(r.amount)}</span>
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 border-t border-slate-800 pt-1.5">
        <span className="text-[9px] font-black uppercase tracking-wider text-slate-500">Total</span>
        <span className={`font-mono text-[11.5px] font-black ${tone}`}>₹{inrFull(total)}</span>
      </div>
    </div>
  );
}
