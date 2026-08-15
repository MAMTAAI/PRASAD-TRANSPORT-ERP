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
import { GlassPanel, PanelHeader, StatusPill } from './shared';
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

      <div className="px-3 pb-3 overflow-x-auto">
        <table className="w-full text-[11px]">
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
            {sorted.map((r) => {
              const selected = filters?.owner === r.owner;
              const negative = Number(r.net_payable) < 0;
              return (
                <tr
                  key={r.owner}
                  onClick={() => set?.({ owner: selected ? '' : r.owner })}
                  title={selected ? 'Click to clear this owner filter' : `Scope the dashboard to ${r.owner}`}
                  className={`cursor-pointer border-b border-slate-800/60 transition-colors
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
                  <td className="px-2 py-2 text-right font-bold text-slate-300">{r.trucks}</td>
                  <td className="px-2 py-2 text-right">
                    {r.active_trips > 0
                      ? <StatusPill tone="emerald" pulse>{r.active_trips}</StatusPill>
                      : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-200">₹{money(r.gross_freight)}</td>
                  <td className="px-2 py-2 text-right font-mono text-amber-300/90">₹{money(r.deductions)}</td>
                  <td className={`px-2 py-2 text-right font-mono font-black ${negative ? 'text-red-400' : 'text-emerald-400'}`}>
                    ₹{money(r.net_payable)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={(e) => { e.stopPropagation(); onOpenStatement?.(r.owner); }}
                      title="Open the IOCL-style owner statement"
                      className="rounded-lg border border-cyan-600/50 bg-cyan-500/10 px-2 py-1 text-[9px] font-bold text-cyan-300 hover:bg-cyan-500/20"
                    >
                      <FileText size={9} className="inline mr-1" />KHATA
                    </button>
                  </td>
                </tr>
              );
            })}
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
