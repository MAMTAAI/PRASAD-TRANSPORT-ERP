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
import { GitBranch, Truck, X } from 'lucide-react';
import { API_BASE } from '../lib/apiBase';

/** "M/S PRASAD TRANSPORT" is the master's name and far too long for a tab.
 *  Shortened for the tab only — every match still uses the company id. */
function shortCo(name) {
  const n = String(name || '').replace(/^M\/S\s+/i, '').trim();
  if (/PRASAD TRANSPORT/i.test(n)) return 'Prasad Transport';
  if (/JAISWAL/i.test(n)) return 'Jaiswal Ent';
  if (/GAUTAM/i.test(n)) return 'Gautam Prasad';
  return n;
}

/** One colour per firm, fixed, so a firm looks the same on every screen it
 *  appears on — the register's Sheet View tabs use the same three. */
const TAB_TONE = {
  'Prasad Transport': { on: 'bg-cyan-400 border-cyan-400 text-slate-950', off: 'text-cyan-300 border-cyan-500/40 hover:bg-cyan-500/10' },
  'Jaiswal Ent': { on: 'bg-violet-400 border-violet-400 text-slate-950', off: 'text-violet-300 border-violet-500/40 hover:bg-violet-500/10' },
  'Gautam Prasad': { on: 'bg-amber-400 border-amber-400 text-slate-950', off: 'text-amber-300 border-amber-500/40 hover:bg-amber-500/10' },
};
const TAB_NEUTRAL = { on: 'bg-slate-200 border-slate-200 text-slate-950', off: 'text-slate-300 border-slate-600/60 hover:bg-white/5' };

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

  // Every ACTIVE narrowing, as a removable chip. The company is deliberately
  // NOT one of them — it is the tab strip above, and a chip that duplicates a
  // tab teaches the eye to ignore chips.
  const narrowing = useMemo(() => {
    const out = [];
    if (filters.companyId) {
      out.push({ key: 'company', label: 'Firm', value: shortCo(companyName ?? '') || 'firm',
        clear: () => set({ companyId: '' }) });
    }
    const br = branches.find((b) => b.id === filters.branchId);
    if (filters.branchId) {
      out.push({ key: 'branch', label: 'Branch', value: br?.branch_name ?? 'branch', clear: () => set({ branchId: '' }) });
    }
    if (filters.fleet) {
      out.push({ key: 'fleet', label: 'Fleet', value: filters.fleet === 'OWNED' ? 'company fleet' : 'attached fleet',
        clear: () => set({ fleet: '' }) });
    }
    if (filters.owner) {
      out.push({ key: 'owner', label: 'Owner', value: filters.owner, clear: () => set({ owner: '' }) });
    }
    if (filters.from || filters.to) {
      out.push({ key: 'period', label: 'Period', value: `${filters.from || 'start'} → ${filters.to || 'today'}`,
        clear: () => set({ from: '', to: '' }) });
    }
    return out;
  }, [filters, companyName, branches, set]);

  return (
    <div className="no-print sticky top-0 z-40 -mx-1 mb-4 px-1">
      <div className="rounded-2xl border border-slate-700/70 bg-[#0a1024]/95 backdrop-blur-md px-3 py-2.5
                      shadow-[0_6px_24px_rgba(0,0,0,0.45)]">

        {/* ── ONE TAB PER FIRM (owner, 7-Sep-2026) ─────────────────────────
            The company was already selectable — in a dropdown, third control
            from the left, reading "All Companies (Group)". A dropdown states
            the current value and hides the alternatives, so switching firm was
            a thing you had to know was possible. Every screen under this bar
            is read firm-first, so the firm is now the first thing on it.

            The tabs SET the same filters.companyId the dropdown did, so every
            dashboard, the P&L, the cash book and the owner statement follow
            without any of them changing: the scope is global and lives in
            filterStore, not here. */}
        <div role="tablist" aria-label="Operating company"
             className="mb-2 flex items-center gap-1.5 flex-wrap border-b border-slate-800/80 pb-2">
          {[{ id: '', company_name: 'Saari firm (Group)' }, ...opts.companies].map((c) => {
            const on = filters.companyId === c.id;
            const tone = TAB_TONE[shortCo(c.company_name)] ?? TAB_NEUTRAL;
            return (
              <button key={c.id || 'ALL'} role="tab" aria-selected={on}
                onClick={() => set({ companyId: c.id })}
                title={c.id ? c.company_name : 'All three transport entities together'}
                className={`rounded-lg border px-3 py-1.5 text-[11.5px] font-black transition-colors
                            ${on ? tone.on : `bg-transparent ${tone.off}`}`}>
                {c.id ? shortCo(c.company_name) : 'Saari firm'}
              </button>
            );
          })}
          {!opts.companies.length && (
            <span className="text-[10px] text-slate-600">firm list load ho rahi hai…</span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">

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

        {/* ── WHAT IS NARROWING THIS VIEW, AND HOW TO UNDO IT ──────────────
            This was one sentence of grey text, and on 7-Sep it read
            "M/S GAUTAM PRASAD · all branches · all fleet · PRASAD TRANSPORT".
            The last three words are a VEHICLE OWNER, left over from an earlier
            click and carried across a company switch by sessionStorage — and
            no lorry owned by Prasad Transport has ever run for Gautam Prasad,
            so the Finance Hub answered zero rupees on every tile. The figures
            were right; the question was not, and nothing on the screen looked
            like the reason.

            So each narrowing is now its own chip with its own ×. A filter you
            can see and remove in one click cannot silently empty a dashboard
            for a week. */}
        <div className="mt-1.5 flex items-center gap-1.5 flex-wrap text-[10px]">
          <span className="text-slate-600 font-bold uppercase tracking-wider">Showing</span>
          {!active && <span className="text-slate-500">the whole group — all companies, all branches, all fleet</span>}
          {narrowing.map((n) => (
            <span key={n.key}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10
                         px-1.5 py-0.5 font-bold text-amber-200">
              <span className="text-amber-500/70 uppercase tracking-wider text-[8.5px]">{n.label}</span>
              {n.value}
              <button onClick={n.clear} aria-label={`Remove ${n.label} filter`} title="Hata dein"
                className="grid h-3.5 w-3.5 place-items-center rounded-sm text-amber-300/70 hover:bg-amber-400/20 hover:text-amber-100">
                <X size={9} />
              </button>
            </span>
          ))}
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
