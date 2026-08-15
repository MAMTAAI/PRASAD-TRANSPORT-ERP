// @ts-nocheck
// ============================================================================
// PRASAD MASTER CONTROL ERP v5.0 — Shared UI Kit
// Glassmorphism design system: dark ground #080c14, frosted slate panels,
// neon cyan/emerald/amber accents. Every primitive here is responsive-first.
// ============================================================================
import React from 'react';
import { MoreHorizontal } from 'lucide-react';

// ---------------------------------------------------------------------------
// GlassPanel — the base frosted card every widget sits on
// ---------------------------------------------------------------------------
export function GlassPanel({ children, className = '', glow = '' }) {
  return (
    <div
      className={`relative rounded-2xl bg-slate-900/40 backdrop-blur-md border border-slate-700/50 shadow-[0_8px_32px_rgba(0,0,0,0.35)] ${glow} ${className}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PanelHeader — icon + title + optional right-side accessory
// ---------------------------------------------------------------------------
export function PanelHeader({ icon: Icon, title, accent = 'text-cyan-400', right = null, sub = '' }) {
  return (
    <div className="flex items-center justify-between px-4 pt-4 pb-2">
      <div className="flex items-center gap-2 min-w-0">
        {Icon && (
          <span className={`shrink-0 grid place-items-center w-7 h-7 rounded-lg bg-white/5 border border-slate-700/50 ${accent}`}>
            <Icon size={15} />
          </span>
        )}
        <div className="min-w-0">
          <h3 className="text-[13px] font-bold tracking-wide text-slate-100 truncate uppercase">{title}</h3>
          {sub && <p className="text-[10px] text-slate-500 truncate">{sub}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {right}
        <MoreHorizontal size={16} className="text-slate-600" />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// KpiCard — big-number stat card with accent glow
// ---------------------------------------------------------------------------
export function KpiCard({ icon: Icon, label, value, sub, accent = 'cyan' }) {
  const accents = {
    cyan:    { text: 'text-cyan-300',    ring: 'border-cyan-500/30',    glowCls: 'shadow-[0_0_25px_rgba(34,211,238,0.12)]',  bar: 'from-cyan-500 to-cyan-300' },
    emerald: { text: 'text-emerald-300', ring: 'border-emerald-500/30', glowCls: 'shadow-[0_0_25px_rgba(52,211,153,0.12)]',  bar: 'from-emerald-500 to-emerald-300' },
    amber:   { text: 'text-amber-300',   ring: 'border-amber-500/30',   glowCls: 'shadow-[0_0_25px_rgba(251,191,36,0.12)]',  bar: 'from-amber-500 to-amber-300' },
    red:     { text: 'text-red-300',     ring: 'border-red-500/30',     glowCls: 'shadow-[0_0_25px_rgba(248,113,113,0.12)]', bar: 'from-red-500 to-red-300' },
    violet:  { text: 'text-violet-300',  ring: 'border-violet-500/30',  glowCls: 'shadow-[0_0_25px_rgba(167,139,250,0.12)]', bar: 'from-violet-500 to-violet-300' },
  };
  const a = accents[accent] || accents.cyan;
  return (
    <div className={`relative overflow-hidden rounded-2xl bg-slate-900/40 backdrop-blur-md border ${a.ring} ${a.glowCls} p-4`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider truncate">{label}</p>
          <p className={`mt-1 text-2xl sm:text-3xl font-black ${a.text} leading-tight`}>{value}</p>
          {sub && <p className="mt-1 text-[11px] text-slate-500 truncate">{sub}</p>}
        </div>
        {Icon && (
          <span className={`shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/5 border border-slate-700/50 ${a.text}`}>
            <Icon size={20} />
          </span>
        )}
      </div>
      <div className={`absolute bottom-0 left-0 right-0 h-[3px] bg-gradient-to-r ${a.bar} opacity-70`} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusPill — compact colored capsule (Expired / Amber / En Route / …)
// ---------------------------------------------------------------------------
export function StatusPill({ tone = 'slate', children, pulse = false }) {
  const tones = {
    red:     'bg-red-500/15 text-red-300 border-red-500/40',
    amber:   'bg-amber-500/15 text-amber-300 border-amber-500/40',
    green:   'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    cyan:    'bg-cyan-500/15 text-cyan-300 border-cyan-500/40',
    violet:  'bg-violet-500/15 text-violet-300 border-violet-500/40',
    slate:   'bg-slate-500/15 text-slate-300 border-slate-500/40',
  };
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] font-bold whitespace-nowrap ${tones[tone] || tones.slate} ${pulse ? 'mc-glow-pulse' : ''}`}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Dot — tiny status LED, optionally pulsing (Tally sync, agent optimal, …)
// ---------------------------------------------------------------------------
export function Dot({ color = 'bg-emerald-400', pulse = false, size = 'w-2 h-2' }) {
  return (
    <span className="relative inline-flex">
      {pulse && <span className={`absolute inline-flex ${size} rounded-full ${color} opacity-60 animate-ping`} />}
      <span className={`relative inline-flex ${size} rounded-full ${color}`} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// ProgressBar — thin gradient bar for EMI / task-load meters
// ---------------------------------------------------------------------------
export function ProgressBar({ pct, gradient = 'from-cyan-500 to-emerald-400' }) {
  return (
    <div className="w-full h-1.5 rounded-full bg-slate-800/80 overflow-hidden">
      <div
        className={`h-full rounded-full bg-gradient-to-r ${gradient} transition-all duration-700`}
        style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avatar — initials disc (no external image dependency)
// ---------------------------------------------------------------------------
export function Avatar({ name, size = 'w-9 h-9', ring = 'ring-slate-600/60', textSize = 'text-[11px]' }) {
  const initials = String(name || '?')
    .split(' ')
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const palette = ['from-cyan-600 to-blue-700', 'from-emerald-600 to-teal-700', 'from-amber-600 to-orange-700', 'from-violet-600 to-purple-700', 'from-rose-600 to-pink-700'];
  const hue = palette[(String(name).charCodeAt(0) || 0) % palette.length];
  return (
    <span className={`shrink-0 grid place-items-center ${size} rounded-full bg-gradient-to-br ${hue} ring-2 ${ring} ${textSize} font-black text-white select-none`}>
      {initials}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Recharts shared bits
// ---------------------------------------------------------------------------
export const chartTooltipStyle = {
  contentStyle: {
    background: 'rgba(8, 12, 20, 0.95)',
    border: '1px solid rgba(51, 65, 85, 0.6)',
    borderRadius: '10px',
    fontSize: '11px',
    color: '#e2e8f0',
  },
  labelStyle: { color: '#94a3b8', fontWeight: 700 },
  itemStyle: { color: '#e2e8f0' },
};

export const axisStyle = { fontSize: 10, fill: '#64748b' };
