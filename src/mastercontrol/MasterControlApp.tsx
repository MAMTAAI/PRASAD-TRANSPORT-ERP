// @ts-nocheck
// ============================================================================
// PRASAD MASTER CONTROL ERP v5.0 — Parent Shell
// Owns the active-module tab state and the responsive top navigation
// (inline tabs on desktop, collapsible menu on mobile). Renders one of:
//   <OperationsDashboard/> · <FinanceDashboard/> · <MasterControlDashboard/>
// ============================================================================
import React, { useEffect, useState } from 'react';
import {
  Truck, Landmark, BrainCircuit, Bell, Search, Menu, X, Hexagon,
} from 'lucide-react';
import OperationsDashboard from './OperationsDashboard';
import FinanceDashboard from './FinanceDashboard';
import MasterControlDashboard from './MasterControlDashboard';
import useDashboardData from './useDashboardData';
import { useGlobalFilter } from '../lib/filterStore';
import FilterBar from './FilterBar';
import DrillDownViewer from './DrillDownViewer';
// The embedded Approval Desk (owner directive, 2026-09-02): the quarantine
// strip under the header, the bell opens the slide-out, decisions in place.
import { ApprovalDeskPanel, ApprovalDeskDrawer, useDeskCounts } from '../components/ApprovalDesk';

const MODULES = [
  { id: 'ops', label: 'Operations', icon: Truck, accent: 'text-cyan-300', bar: 'from-cyan-500 to-blue-500' },
  { id: 'finance', label: 'Finance', icon: Landmark, accent: 'text-emerald-300', bar: 'from-emerald-500 to-teal-500' },
  { id: 'crm', label: 'CRM / Master Control', icon: BrainCircuit, accent: 'text-violet-300', bar: 'from-violet-500 to-fuchsia-500' },
];

const MODULE_TITLES = {
  // The OWN + permanently attached fleet — the family's trucks. Market
  // vehicles and fleet partners live on the Command Deck (owner, 2-Sep-2026).
  ops: { title: 'Command Center: Transport Fleet Ops', sub: 'Own & attached fleet · Bongaigaon Refinery Hub' },
  finance: { title: 'Master Finance Hub', sub: 'Executive Command' },
  crm: { title: 'Prasad Master Control', sub: 'Enterprise ERP' },
};

export default function MasterControlApp({ initialTab = 'ops' }) {
  const valid = (t) => (MODULES.some((m) => m.id === t) ? t : 'ops');
  const [activeTab, setActiveTab] = useState(() => valid(initialTab));
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(new Date());

  // FOLLOW THE MODULE BUTTONS. useState reads `initialTab` only on the first
  // mount, so switching OPERATIONS -> ACCOUNTS -> CRM in the top bar changed
  // the prop while this component stayed on whichever tab it opened with —
  // the module button looked dead. Re-sync whenever the prop actually changes.
  useEffect(() => { setActiveTab(valid(initialTab)); }, [initialTab]);

  // The filter now lives at APP level (lib/filterStore), not here. Holding it in
  // this component made it die whenever Master Control unmounted — open the P&L
  // or the Owner Statement and the scope was silently gone. Same object, wider
  // lifetime; this screen is now just another consumer.
  const filter = useGlobalFilter();
  const live = useDashboardData(filter.qs());

  // ONE drawer for all three hubs. Any card anywhere dispatches
  //     window.dispatchEvent(new CustomEvent('pt:drilldown',
  //       { detail: { metric: 'ops.active_trips', expected: 17 } }))
  // and lands here. An event rather than prop-drilling because the cards are
  // nested several levels down inside three different dashboards, and a context
  // just to carry one modal would be threaded through every one of them.
  //
  // `expected` is the figure the card was DISPLAYING. The drawer compares it
  // against the rows it fetches and shouts if they differ -- that comparison is
  // the whole reason this is worth building.
  const [drill, setDrill] = useState(null);
  const deskCounts = useDeskCounts();
  const [deskOpen, setDeskOpen] = useState(null);   // null · true · 'queue key'
  useEffect(() => {
    const open = (e) => {
      const d = e?.detail ?? {};
      if (d.metric) setDrill({ metric: d.metric, expected: d.expected ?? null });
    };
    window.addEventListener('pt:drilldown', open);
    return () => window.removeEventListener('pt:drilldown', open);
  }, []);

  useEffect(() => {
    // TODO: Fetch from AWS PostgreSQL — global alert count + session context
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const active = MODULES.find((m) => m.id === activeTab);
  const heading = MODULE_TITLES[activeTab];

  return (
    <div className="mc-shell min-h-full w-full bg-deck-ground text-slate-200 rounded-2xl overflow-hidden ring-1 ring-slate-700/70"
      style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Shared keyframes for the whole v5.0 module */}
      <style>{`
        @keyframes mcGlowPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
        .mc-glow-pulse { animation: mcGlowPulse 1.6s ease-in-out infinite; }
        @keyframes mcTicker { 0% { transform: translateX(0); } 100% { transform: translateX(-50%); } }
        .mc-ticker { animation: mcTicker 40s linear infinite; }
        .mc-ticker:hover { animation-play-state: paused; }
        @keyframes mcDashFlow { to { stroke-dashoffset: -20; } }
        .mc-dash-flow { animation: mcDashFlow 2.2s linear infinite; }
        @keyframes mcNodePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }
        .mc-node-pulse { animation: mcNodePulse 2s ease-in-out infinite; }
        .mc-hide-scrollbar::-webkit-scrollbar { display: none; }
        .mc-hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

        /* THIN, NOT HIDDEN. mc-hide-scrollbar above is right for a horizontal
           tab strip, where the overflow is obvious from the cut-off chip. It is
           wrong for the dispatch chat: that pane is now height-capped, so the
           scrollbar is the only thing on screen saying there is more
           conversation above. Narrow enough not to eat the bubble width,
           visible enough to be found. */
        .mc-thin-scrollbar { scrollbar-width: thin; scrollbar-color: #3d548a transparent; }
        .mc-thin-scrollbar::-webkit-scrollbar { width: 6px; height: 6px; }
        .mc-thin-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .mc-thin-scrollbar::-webkit-scrollbar-thumb { background: #27395f; border-radius: 3px; }
        .mc-thin-scrollbar:hover::-webkit-scrollbar-thumb { background: #3d548a; }
        @keyframes mcFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .mc-fade-in { animation: mcFadeIn 0.35s ease-out; }

        /* Hover-card entry. 90ms is a fade-IN on something already positioned,
           not a delay before it appears — the card is in the DOM and placed on
           the same frame as the pointerenter. Anyone who prefers no motion gets
           it with no animation at all, still instantly. */
        @keyframes mcHoverCardIn { from { opacity: 0; transform: translateY(3px) scale(0.985); } to { opacity: 1; transform: none; } }
        .mc-hovercard-in { animation: mcHoverCardIn 90ms ease-out; }
        @media (prefers-reduced-motion: reduce) { .mc-hovercard-in { animation: none; } }

        /* Kill the ~300ms synthetic-click delay so a tap on a truck row reacts
           on touch-down like the hover card does. Scoped to the things that are
           actually tappable — a blanket `*` would also land on the Google Maps
           canvas, whose own gesture handling is not ours to override. */
        .mc-shell button,
        .mc-shell a,
        .mc-shell tr,
        .mc-shell [role="switch"],
        .mc-shell .touch-manipulation { touch-action: manipulation; }
      `}</style>

      {/* ambient glow backdrop */}
      <div className="relative">
        {/* Room lighting. At 10% of a mid cyan on #020617 these were invisible;
            on navy they are what stops a full screen of panels reading flat. */}
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-live/20 blur-3xl" />
        <div className="pointer-events-none absolute top-0 right-0 w-80 h-80 rounded-full bg-mamta/20 blur-3xl" />

        {/* ══════════════ TOP NAVIGATION ══════════════ */}
        <header className="relative z-20 flex items-center gap-3 px-3 sm:px-5 py-3 border-b border-slate-700/70 bg-slate-900/70 backdrop-blur-md shadow-deck">

          {/* brand */}
          <div className="flex items-center gap-2.5 shrink-0">
            <span className="relative grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-700 shadow-[0_0_18px_rgba(34,211,238,0.4)]">
              <Hexagon size={18} className="text-white" />
            </span>
            <div className="leading-tight">
              <p className="text-[13px] font-black tracking-wide text-white">
                PRASAD <span className="text-cyan-400">TRANSPORT ERP</span>
              </p>
              <p className="text-[9px] font-bold text-slate-500 tracking-[0.25em]">MASTER CONTROL · v5.0</p>
            </div>
          </div>

          {/* desktop tabs */}
          <nav className="hidden md:flex items-center gap-1.5 mx-auto">
            {MODULES.map((m) => {
              const on = m.id === activeTab;
              return (
                <button
                  key={m.id}
                  onClick={() => setActiveTab(m.id)}
                  className={`relative flex items-center gap-2 px-4 py-2 rounded-xl text-[12px] font-bold transition-all
                    ${on ? `bg-white/10 ${m.accent} shadow-inner` : 'text-slate-500 hover:text-slate-300 hover:bg-white/5'}`}
                >
                  <m.icon size={14} />
                  [ {m.label} ]
                  {on && <span className={`absolute -bottom-[13px] left-3 right-3 h-[2px] rounded-full bg-gradient-to-r ${m.bar}`} />}
                </button>
              );
            })}
          </nav>

          {/* right cluster */}
          <div className="flex items-center gap-2 sm:gap-3 ml-auto md:ml-0 shrink-0">
            <div className="hidden lg:flex items-center gap-1.5 rounded-xl bg-slate-900/70 border border-slate-700/50 px-3 py-1.5">
              <Search size={13} className="text-slate-500" />
              <input placeholder="Search…" className="w-28 xl:w-40 bg-transparent text-[11px] text-slate-300 placeholder-slate-600 outline-none" />
            </div>
            {/* Live/offline is stated plainly — a stale dashboard that looks
                live is how someone acts on a number that is hours old. */}
            <span className={`hidden md:inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-black border ${
              live.error ? 'bg-red-500/10 text-red-300 border-red-500/40'
                : live.loading ? 'bg-slate-500/10 text-slate-300 border-slate-600/40'
                  : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${live.error ? 'bg-red-400' : live.loading ? 'bg-slate-400' : 'bg-emerald-400'}`} />
              {live.error ? 'DATA OFFLINE' : live.loading ? 'LOADING' : 'LIVE DATA'}
            </span>
            <span className="hidden sm:block text-[10px] font-bold text-slate-500 whitespace-nowrap">{dateStr} · {timeStr} IST</span>
            <button onClick={() => setDeskOpen(true)} title="Approval desk — everything waiting on the office"
              className="relative grid place-items-center w-8 h-8 rounded-xl bg-slate-900/70 border border-slate-700/50 text-slate-400 hover:text-amber-300 transition-colors">
              <Bell size={14} />
              {deskCounts.total > 0 && (
                <span className="absolute -top-1 -right-1 grid place-items-center min-w-4 h-4 px-1 rounded-full bg-amber-500 text-[8px] font-black text-slate-950">{deskCounts.total}</span>
              )}
            </button>
            <span className="hidden sm:grid place-items-center w-8 h-8 rounded-full bg-gradient-to-br from-amber-500 to-orange-700 ring-2 ring-slate-700/60 text-[10px] font-black text-white">PS</span>
            {/* mobile menu toggle */}
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className="md:hidden grid place-items-center w-8 h-8 rounded-xl bg-slate-900/70 border border-slate-700/50 text-cyan-300"
            >
              {menuOpen ? <X size={16} /> : <Menu size={16} />}
            </button>
          </div>
        </header>

        {/* mobile collapsible nav */}
        {menuOpen && (
          <nav className="md:hidden relative z-20 flex flex-col gap-1 px-3 py-2 border-b border-slate-800/70 bg-slate-950/80 backdrop-blur-md mc-fade-in">
            {MODULES.map((m) => {
              const on = m.id === activeTab;
              return (
                <button
                  key={m.id}
                  onClick={() => { setActiveTab(m.id); setMenuOpen(false); }}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13px] font-bold transition-colors
                    ${on ? `bg-white/10 ${m.accent}` : 'text-slate-400 hover:bg-white/5'}`}
                >
                  <m.icon size={15} /> {m.label}
                  {on && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-current" />}
                </button>
              );
            })}
          </nav>
        )}

        {/* ══════════════ MODULE HEADING ══════════════ */}
        <div className="relative z-10 flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 sm:px-6 pt-4">
          <h1 className={`text-lg sm:text-xl font-black tracking-tight ${active.accent}`}>{heading.title}</h1>
          <span className="text-[11px] font-semibold text-slate-500">{heading.sub}</span>
        </div>

        {/* ══════════════ ACTIVE MODULE ══════════════ */}
        {/* One fetch feeds all three tabs; switching tabs never re-queries. */}
        <main key={activeTab} className="relative z-10 p-3 sm:p-5 mc-fade-in">
          {/* Sticky above every tab: the scope has to stay visible while you
              scroll, or the numbers below it lose their meaning. */}
          {/* Persistent, above every tab: the quarantine — what outside parties
              sent and the office has not yet approved. Decisions happen in the
              slide-out, never on another page. */}
          <div className="mb-3">
            <ApprovalDeskPanel counts={deskCounts.counts} total={deskCounts.total} onOpen={(k) => setDeskOpen(k ?? true)} />
          </div>
          <FilterBar filters={filter.filters} set={filter.set} clear={filter.clear} active={filter.active} />

          {activeTab === 'ops' && <OperationsDashboard live={live} filter={filter} />}
          {activeTab === 'finance' && <FinanceDashboard live={live} filter={filter} />}
          {activeTab === 'crm' && <MasterControlDashboard live={live} filter={filter} />}
        </main>
      </div>

      {drill && (
        <DrillDownViewer
          metric={drill.metric}
          expected={drill.expected}
          /* The drawer must obey the SAME scope as the card that opened it, or
             it explains a different number than the one clicked. qs() carries a
             leading '?'; the viewer appends to an existing query string. */
          filterQs={filter.qs().replace(/^\?/, '')}
          onClose={() => setDrill(null)}
        />
      )}

      {/* Driver Control Dashboard: its host is mounted once in App.tsx, so a
          driver name here opens the same slide-out as everywhere else. */}

      <ApprovalDeskDrawer
        open={!!deskOpen}
        initialSection={typeof deskOpen === 'string' ? deskOpen : null}
        counts={deskCounts.counts}
        onClose={() => setDeskOpen(null)}
        onDecided={deskCounts.refresh}
      />
    </div>
  );
}
