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

const MODULES = [
  { id: 'ops', label: 'Operations', icon: Truck, accent: 'text-cyan-300', bar: 'from-cyan-500 to-blue-500' },
  { id: 'finance', label: 'Finance', icon: Landmark, accent: 'text-emerald-300', bar: 'from-emerald-500 to-teal-500' },
  { id: 'crm', label: 'CRM / Master Control', icon: BrainCircuit, accent: 'text-violet-300', bar: 'from-violet-500 to-fuchsia-500' },
];

const MODULE_TITLES = {
  ops: { title: 'Command Center: Transport Fleet Ops', sub: 'Bongaigaon Refinery Hub' },
  finance: { title: 'Master Finance Hub', sub: 'Executive Command' },
  crm: { title: 'Prasad Master Control', sub: 'Enterprise ERP' },
};

export default function MasterControlApp({ initialTab = 'ops' }) {
  const [activeTab, setActiveTab] = useState(MODULES.some((m) => m.id === initialTab) ? initialTab : 'ops');
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(new Date());

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
    <div className="min-h-full w-full bg-[#080c14] text-slate-200 rounded-2xl overflow-hidden ring-1 ring-slate-800/60"
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
        @keyframes mcFadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .mc-fade-in { animation: mcFadeIn 0.35s ease-out; }
      `}</style>

      {/* ambient glow backdrop */}
      <div className="relative">
        <div className="pointer-events-none absolute -top-32 -left-32 w-96 h-96 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="pointer-events-none absolute top-0 right-0 w-80 h-80 rounded-full bg-violet-500/10 blur-3xl" />

        {/* ══════════════ TOP NAVIGATION ══════════════ */}
        <header className="relative z-20 flex items-center gap-3 px-3 sm:px-5 py-3 border-b border-slate-800/70 bg-slate-950/60 backdrop-blur-md">

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
            <span className="hidden sm:block text-[10px] font-bold text-slate-500 whitespace-nowrap">{dateStr} · {timeStr} IST</span>
            <button className="relative grid place-items-center w-8 h-8 rounded-xl bg-slate-900/70 border border-slate-700/50 text-slate-400 hover:text-cyan-300 transition-colors">
              <Bell size={14} />
              <span className="absolute -top-1 -right-1 grid place-items-center w-4 h-4 rounded-full bg-red-500 text-[8px] font-black text-white">26</span>
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
        <main key={activeTab} className="relative z-10 p-3 sm:p-5 mc-fade-in">
          {activeTab === 'ops' && <OperationsDashboard />}
          {activeTab === 'finance' && <FinanceDashboard />}
          {activeTab === 'crm' && <MasterControlDashboard />}
        </main>
      </div>
    </div>
  );
}
