// @ts-nocheck
// ============================================================================
// <FilterBar /> — the sticky Company → Branch → Fleet/Owner bar.
//
// Sticky because it is the answer to "what am I looking at": scroll down a long
// dashboard and the numbers stop meaning anything if you cannot see the scope
// they were computed under.
//
// The branch dropdown lists only branches OF THE SELECTED COMPANY. That is the
// cascade — offering every branch and returning nothing when the combination is
// impossible reads as "no data" rather than "wrong question".
//
// ONLY THE THREE TRANSPORT ENTITIES APPEAR. Jaiswal Capital Pvt Ltd is a
// separate trading company with its own books; it is not in this database and
// must never be offered here, because selecting it would imply these figures
// include it.
// ============================================================================
import React, { useEffect, useMemo, useState } from 'react';
import { Building2, GitBranch, Truck, X } from 'lucide-react';
import { API_BASE } from '../lib/apiBase';

export default function FilterBar({ filters, set, clear, active }) {
  const [opts, setOpts] = useState({ companies: [], branches: [], owners: [], fleet_types: [] });
  const [err, setErr] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/v1/filters/options`);
        if (!res.ok) throw new Error(`API ${res.status}`);
        const j = await res.json();
        if (alive) setOpts(j);
      } catch (e) { if (alive) setErr(e.message); }
    })();
    return () => { alive = false; };
  }, []);

  // The cascade: branches narrow to the chosen company.
  const branches = useMemo(
    () => (filters.companyId
      ? opts.branches.filter((b) => b.company_id === filters.companyId)
      : opts.branches),
    [opts.branches, filters.companyId]);

  const companyName = opts.companies.find((c) => c.id === filters.companyId)?.company_name;

  return (
    <div className="no-print sticky top-0 z-40 -mx-1 mb-4 px-1">
      <div className="rounded-2xl border border-slate-700/70 bg-[#0a1024]/95 backdrop-blur-md px-3 py-2.5
                      shadow-[0_6px_24px_rgba(0,0,0,0.45)]">
        <div className="flex items-center gap-2 flex-wrap">

          <Select
            icon={Building2}
            title="Operating company"
            value={filters.companyId}
            onChange={(v) => set({ companyId: v })}
            placeholder="All Companies (Group)"
            options={opts.companies.map((c) => ({ value: c.id, label: c.company_name }))}
          />

          <Chevron />

          <Select
            icon={GitBranch}
            title={filters.companyId ? `Branches of ${companyName}` : 'All branches'}
            value={filters.branchId}
            onChange={(v) => set({ branchId: v })}
            placeholder="All Branches"
            options={branches.map((b) => ({
              value: b.id,
              label: b.branch_name + (b.city && !filters.companyId ? ` · ${b.city}` : ''),
            }))}
          />

          <Chevron />

          <Select
            icon={Truck}
            title="Fleet ownership"
            value={filters.fleet}
            onChange={(v) => set({ fleet: v })}
            placeholder="All Fleet"
            options={opts.fleet_types.map((f) => ({ value: f.id, label: f.label }))}
          />

          <Select
            icon={Truck}
            title="Vehicle owner"
            value={filters.owner}
            onChange={(v) => set({ owner: v })}
            placeholder="All Owners"
            options={opts.owners.map((o) => ({
              value: o.owner,
              label: `${o.owner} (${o.trucks})`,
            }))}
          />

          <label title="Period start" className="flex items-center gap-1.5 rounded-lg border border-slate-700/70 bg-slate-900/70 px-2 py-1.5">
            <span className="text-[9px] font-bold text-slate-600">FROM</span>
            <input type="date" value={filters.from || ''} onChange={(e) => set({ from: e.target.value })}
              className="bg-transparent text-[11px] font-semibold text-slate-200 outline-none" />
          </label>
          <label title="Period end" className="flex items-center gap-1.5 rounded-lg border border-slate-700/70 bg-slate-900/70 px-2 py-1.5">
            <span className="text-[9px] font-bold text-slate-600">TO</span>
            <input type="date" value={filters.to || ''} onChange={(e) => set({ to: e.target.value })}
              className="bg-transparent text-[11px] font-semibold text-slate-200 outline-none" />
          </label>

          {active && (
            <button
              onClick={clear}
              title="Clear all filters"
              className="ml-auto flex items-center gap-1 rounded-lg border border-slate-600/70 bg-white/5
                         px-2.5 py-1.5 text-[10px] font-bold text-slate-300 hover:bg-white/10 transition-colors"
            >
              <X size={11} /> CLEAR
            </button>
          )}
        </div>

        {/* What is actually applied, spelled out. A row of dropdowns is easy to
            misread at a glance; this line is not. */}
        <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[10px]">
          <span className="text-slate-600 font-bold uppercase tracking-wider">Showing</span>
          <span className={active ? 'text-cyan-300 font-bold' : 'text-slate-500'}>
            {!active ? 'the whole group — all companies, all branches, all fleet'
              : [
                companyName ?? 'All companies',
                branches.find((b) => b.id === filters.branchId)?.branch_name ?? 'all branches',
                filters.fleet ? (filters.fleet === 'OWNED' ? 'company fleet' : 'attached fleet') : 'all fleet',
                filters.owner || null,
                (filters.from || filters.to) ? `${filters.from || 'start'} → ${filters.to || 'today'}` : null,
              ].filter(Boolean).join(' · ')}
          </span>
          {err && <span className="text-amber-400">· filter list unavailable ({err})</span>}
        </div>
      </div>
    </div>
  );
}

const Chevron = () => <span className="text-slate-700 text-[11px] select-none">›</span>;

function Select({ icon: Icon, value, onChange, placeholder, options, title }) {
  return (
    <label title={title} className="flex items-center gap-1.5 rounded-lg border border-slate-700/70 bg-slate-900/70 px-2 py-1.5">
      <Icon size={12} className={value ? 'text-cyan-400' : 'text-slate-600'} />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-transparent text-[11px] font-semibold text-slate-200 outline-none max-w-[190px]"
      >
        <option value="" className="bg-slate-900">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} className="bg-slate-900">{o.label}</option>
        ))}
      </select>
    </label>
  );
}
