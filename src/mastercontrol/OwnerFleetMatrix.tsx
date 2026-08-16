// @ts-nocheck
// ============================================================================
// <OwnerFleetMatrix /> — one row per vehicle owner: fleet size, what it earned,
// what we deducted, and what is left to pay them.
//
// CLICKING A ROW FILTERS THE WHOLE DASHBOARD to that owner's fleet, rather than
// opening a separate drill-down page. The KPI cards, charts and this matrix all
// read the same filter, so they cannot disagree — which is the failure mode
// when a "details" view runs its own query with its own subtly different WHERE.
//
// NET PAYABLE CAN BE NEGATIVE, AND THAT IS REPORTED. Only 489 of 872 trips
// carry a billed amount, so an owner whose trips are not yet billed shows nil
// freight against real advances. The unbilled count sits next to the figure
// instead of being smoothed away: a matrix that hides it looks healthy and
// tells you the wrong thing about who is owed what.
// ============================================================================
import React, { useCallback, useEffect, useState } from 'react';
import { Users, FileText, AlertTriangle } from 'lucide-react';
import {
  GlassPanel, PanelHeader, StatusPill, useHoverCard, HoverTitle, HoverKv, HoverNote,
} from './shared';
import { API_BASE } from '../lib/apiBase';

const money = (n) => Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

export default function OwnerFleetMatrix({ filters, set, onOpenStatement }) {
  const [rows, setRows] = useState([]);
  const [state, setState] = useState('loading');
  const [detail, setDetail] = useState('');
  const [sort, setSort] = useState({ key: 'net_payable', dir: 'desc' });

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (filters?.companyId) p.set('company_id', filters.companyId);
      if (filters?.branchId) p.set('branch_id', filters.branchId);
      const res = await fetch(`${API_BASE}/api/v1/owners/matrix?${p}`);
      if (!res.ok) { setState('error'); setDetail(`API ${res.status}`); return; }
      const j = await res.json();
      setRows(j.rows ?? []);
      setState('ok');
    } catch (e) { setState('error'); setDetail(e.message); }
  }, [filters?.companyId, filters?.branchId]);

  useEffect(() => { load(); }, [load]);

  const sorted = [...rows].sort((a, b) => {
    const av = a[sort.key], bv = b[sort.key];
    const n = Number(av), m = Number(bv);
    const cmp = Number.isFinite(n) && Number.isFinite(m)
      ? n - m
      : String(av ?? '').localeCompare(String(bv ?? ''));
    return sort.dir === 'asc' ? cmp : -cmp;
  });

  const exportCsv = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Owner', 'Trucks', 'Attached', 'Trips', 'Active', 'Unbilled',
                  'Gross Freight', 'Commission', 'Fuel', 'Toll', 'Advances', 'Shortage',
                  'Deductions', 'Net Payable'];
    const csv = [head, ...sorted.map((r) => [
      r.owner, r.trucks, r.attached_trucks, r.trips, r.active_trips, r.unbilled_trips,
      r.gross_freight, r.commission, r.fuel, r.toll, r.advances, r.shortage,
      r.deductions, r.net_payable,
    ])].map((line) => line.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'vehicle-owner-matrix.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  if (state === 'error') {
    return (
      <GlassPanel className="border-amber-500/30">
        <PanelHeader icon={AlertTriangle} title="Vehicle Owner Fleet Matrix" accent="text-amber-400" sub="Not available" />
        <div className="px-4 pb-4 text-[11px] text-amber-300/80">Matrix unreachable — {detail}.</div>
      </GlassPanel>
    );
  }

  const th = (key, label, alignLeft = false) => (
    <th
      onClick={() => setSort((s) => ({ key, dir: s.key === key && s.dir === 'desc' ? 'asc' : 'desc' }))}
      className={`px-2 py-1.5 text-[9px] font-black uppercase tracking-wider text-slate-500 cursor-pointer
                  select-none hover:text-cyan-400 ${alignLeft ? 'text-left' : 'text-right'}`}
    >
      {label}{sort.key === key ? (sort.dir === 'desc' ? ' ▾' : ' ▴') : ''}
    </th>
  );

  return (
    <GlassPanel className="border-violet-500/25">
      <PanelHeader
        icon={Users}
        title="Vehicle Owner Fleet Matrix"
        accent="text-violet-400"
        sub={filters?.owner ? `filtered to ${filters.owner}` : 'click a row to scope the dashboard'}
        right={
          <button onClick={exportCsv}
            className="rounded-lg border border-slate-600/70 bg-white/5 px-2.5 py-1 text-[10px] font-bold text-slate-300 hover:bg-white/10">
            ⬇ CSV
          </button>
        }
      />

      {/* A width FLOOR, not a width. Seven columns of figures cannot share
          less than this without the headings wrapping through the numbers
          underneath them; below the floor the panel scrolls sideways, which is
          legible, instead of compressing, which is not. */}
      <div className="px-3 pb-3 overflow-x-auto">
        <table className="w-full min-w-[860px] text-[11px]">
          <thead>
            <tr className="border-b border-slate-800">
              {th('owner', 'Owner', true)}
              {th('trucks', 'Trucks')}
              {th('active_trips', 'Active')}
              {th('gross_freight', 'Gross Freight')}
              {th('deductions', 'Fuel / Adv. Deduct.')}
              {th('net_payable', 'Net Payable')}
              <th className="px-2 py-1.5 text-right text-[9px] font-black uppercase tracking-wider text-slate-500">Actions</th>
            </tr>
          </thead>
          <tbody>
            {state === 'loading' && (
              <tr><td colSpan={7} className="py-4 text-center text-slate-600">Loading…</td></tr>
            )}
            {state === 'ok' && sorted.length === 0 && (
              <tr><td colSpan={7} className="py-4 text-center text-slate-600">No owners in this scope.</td></tr>
            )}
            {sorted.map((r) => (
              <OwnerRow
                key={r.owner}
                r={r}
                selected={filters?.owner === r.owner}
                onSelect={() => set?.({ owner: filters?.owner === r.owner ? '' : r.owner })}
                onOpenStatement={onOpenStatement}
              />
            ))}
          </tbody>
        </table>
      </div>

      {sorted.some((r) => r.unbilled_trips > 0) && (
        <p className="px-4 pb-3 text-[9.5px] text-amber-400/80">
          ⚠ Owners marked “unbilled” have trips with no billed freight yet — their gross reads nil and the
          net payable can go negative. Billing those trips corrects the figure.
        </p>
      )}
    </GlassPanel>
  );
}

// ---------------------------------------------------------------------------
// One owner. The table can only afford six of the fourteen figures the API
// returns per owner, so the rest used to be reachable only by exporting the
// CSV. They are on the row now: hovering it — or, on a phone, the first tap —
// opens the full settlement breakdown instantly, and the row still filters the
// dashboard on click exactly as before.
// ---------------------------------------------------------------------------
function OwnerRow({ r, selected, onSelect, onOpenStatement }) {
  const negative = Number(r.net_payable) < 0;

  // Built lazily — this only runs for the one row actually under the pointer,
  // not for all of them on every re-render.
  const card = () => (
    <>
      <HoverTitle sub={selected ? 'Dashboard is scoped to this owner · click to clear' : 'Click the row to scope the dashboard'}>
        {r.owner}
      </HoverTitle>

      <p className="mb-1 text-[9px] font-black uppercase tracking-wider text-slate-600">Fleet</p>
      <HoverKv k="Trucks" v={r.trucks} />
      <HoverKv k="Attached (not company-owned)" v={r.attached_trucks}
               tone={r.attached_trucks > 0 ? 'text-amber-300' : 'text-slate-400'} />

      <p className="mt-2 mb-1 text-[9px] font-black uppercase tracking-wider text-slate-600">Trips in scope</p>
      <HoverKv k="Total" v={r.trips} />
      <HoverKv k="In transit now" v={r.active_trips}
               tone={r.active_trips > 0 ? 'text-emerald-300' : 'text-slate-400'} />
      <HoverKv k="Unbilled (no freight yet)" v={r.unbilled_trips}
               tone={r.unbilled_trips > 0 ? 'text-amber-300' : 'text-slate-400'} />

      <p className="mt-2 mb-1 text-[9px] font-black uppercase tracking-wider text-slate-600">Settlement</p>
      <HoverKv k="Gross freight" v={`₹${money(r.gross_freight)}`} />
      <HoverKv k="Less commission" v={`−₹${money(r.commission)}`} tone="text-slate-400" />
      <HoverKv k="Less fuel" v={`−₹${money(r.fuel)}`} tone="text-slate-400" />
      <HoverKv k="Less toll" v={`−₹${money(r.toll)}`} tone="text-slate-400" />
      <HoverKv k="Less advances" v={`−₹${money(r.advances)}`} tone="text-slate-400" />
      <HoverKv k="Less shortage" v={`−₹${money(r.shortage)}`}
               tone={Number(r.shortage) > 0 ? 'text-red-300' : 'text-slate-400'} />
      <HoverKv strong k="Net payable" v={`₹${money(r.net_payable)}`}
               tone={negative ? 'text-red-400' : 'text-emerald-400'} />

      {negative && (
        <HoverNote tone="text-amber-300/90">
          Negative because {r.unbilled_trips > 0
            ? `${r.unbilled_trips} of these trips carry no billed freight yet — real deductions are sitting against nil income.`
            : 'the deductions above exceed the freight billed in this period.'}
        </HoverNote>
      )}
    </>
  );

  const { triggerProps, overlay } = useHoverCard(card, { placement: 'top', width: 320 });

  return (
    <>
      <tr
        {...triggerProps}
        onClick={onSelect}
        className={`cursor-pointer border-b border-slate-800/60 transition-colors duration-100
          ${selected ? 'bg-violet-500/15' : 'hover:bg-white/5'}`}
      >
        <td className="px-2 py-2 text-left">
          <div className="font-bold text-slate-100">{r.owner}</div>
          <div className="text-[9px] text-slate-500">
            {r.trucks} truck{r.trucks === 1 ? '' : 's'}
            {r.attached_trucks > 0 && <span className="text-amber-400"> · {r.attached_trucks} attached</span>}
            {r.unbilled_trips > 0 && <span className="text-amber-400/80"> · {r.unbilled_trips} unbilled</span>}
          </div>
        </td>
        <td className="px-2 py-2 text-right font-bold text-slate-300 whitespace-nowrap">{r.trucks}</td>
        <td className="px-2 py-2 text-right whitespace-nowrap">
          {r.active_trips > 0
            ? <StatusPill tone="emerald" pulse>{r.active_trips}</StatusPill>
            : <span className="text-slate-600">—</span>}
        </td>
        <td className="px-2 py-2 text-right font-mono text-slate-200 whitespace-nowrap">₹{money(r.gross_freight)}</td>
        <td className="px-2 py-2 text-right font-mono text-amber-300/90 whitespace-nowrap">₹{money(r.deductions)}</td>
        <td className={`px-2 py-2 text-right font-mono font-black whitespace-nowrap ${negative ? 'text-red-400' : 'text-emerald-400'}`}>
          ₹{money(r.net_payable)}
        </td>
        <td className="px-2 py-2 text-right whitespace-nowrap">
          <button
            onClick={(e) => { e.stopPropagation(); onOpenStatement?.(r.owner); }}
            onPointerDown={(e) => e.stopPropagation()}
            title="Open the IOCL-style owner statement"
            className="rounded-lg border border-cyan-600/50 bg-cyan-500/10 px-2 py-1 text-[9px] font-bold text-cyan-300 hover:bg-cyan-500/20"
          >
            <FileText size={9} className="inline mr-1" />KHATA
          </button>
        </td>
      </tr>
      {overlay}
    </>
  );
}
