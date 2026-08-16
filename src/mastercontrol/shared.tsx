// @ts-nocheck
// ============================================================================
// PRASAD MASTER CONTROL ERP v5.0 — Shared UI Kit
// Glassmorphism design system: dark ground #080c14, frosted slate panels,
// neon cyan/emerald/amber accents. Every primitive here is responsive-first.
// ============================================================================
import React, {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
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

// ---------------------------------------------------------------------------
// useHoverCard — detail popovers that open on hover AND on the first touch.
//
// Two separate things were wrong with the affordance this replaces:
//
//   1. It was a native `title=`. The browser sits on that for roughly a second
//      before drawing anything, and on a phone it never draws at all — so the
//      detail behind a row was, in practice, unreachable on the devices the
//      yard actually uses.
//   2. Anything positioned inside these panels gets clipped. The owner matrix
//      lives in `overflow-x-auto`, the queues in `overflow-y-auto`; a popover
//      drawn in flow is cut off at the panel edge exactly when it has something
//      long to say.
//
// So: NO timer anywhere on the open path — pointerenter sets state and nothing
// else — and the card is portalled to <body> at `position: fixed`, measured off
// the trigger's own rect, which no ancestor's overflow can crop.
//
// Touch is handled explicitly instead of being left to pointerenter. On a
// touchscreen the browser fires pointerenter at touch-down and pointerleave the
// instant the finger lifts, so one shared code path makes the card flash and
// vanish. A touch pointer therefore LATCHES the card open until the next tap
// outside, Escape, or unmount — while a mouse keeps plain hover-in/hover-out.
// ---------------------------------------------------------------------------
const HC_GAP = 10;   // px between the trigger and the card
const HC_EDGE = 8;   // px the card keeps clear of the viewport edge

export function useHoverCard(content, { placement = 'top', width = 300 } = {}) {
  const id = useId();
  const triggerRef = useRef(null);
  const cardRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [sticky, setSticky] = useState(false);   // true => opened by touch
  const [pos, setPos] = useState(null);          // null => mounted, not yet measured

  const place = useCallback(() => {
    const t = triggerRef.current?.getBoundingClientRect();
    const card = cardRef.current;
    if (!t || !card) return;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Flip to whichever side actually has room, so the last row of a long
    // table does not open its card off the bottom of the screen.
    let side = placement;
    if (side === 'top' && t.top - ch - HC_GAP < HC_EDGE) side = 'bottom';
    else if (side === 'bottom' && t.bottom + ch + HC_GAP > vh - HC_EDGE) side = 'top';

    const rawTop = side === 'top' ? t.top - ch - HC_GAP : t.bottom + HC_GAP;
    const maxTop = Math.max(HC_EDGE, vh - ch - HC_EDGE);
    const maxLeft = Math.max(HC_EDGE, vw - cw - HC_EDGE);
    const top = Math.min(Math.max(rawTop, HC_EDGE), maxTop);
    const left = Math.min(Math.max(t.left + t.width / 2 - cw / 2, HC_EDGE), maxLeft);
    // Hand back the SAME object when nothing moved. place() runs from a layout
    // effect and again on every scroll frame; a fresh {top,left} each time
    // re-renders on both, and out of a layout effect that is a loop React kills
    // with "Maximum update depth exceeded".
    setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
  }, [placement]);

  const close = useCallback(() => { setOpen(false); setSticky(false); }, []);

  // Measure before paint: the card mounts hidden, this positions it, and the
  // browser paints once — so "instant" stays instant with no visible jump.
  // `content` is deliberately NOT a dependency. Callers build it as an inline
  // arrow, so its identity changes on every render; depending on it would re-run
  // this effect forever. Size changes are picked up by the listener below.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    place();
  }, [open, place]);

  // Follow the trigger while anything scrolls (capture catches inner scrollers
  // too — the matrix and the queues are each their own scroll container).
  useEffect(() => {
    if (!open) return undefined;
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // A latched (touch-opened) card is dismissed by the next tap anywhere else.
  useEffect(() => {
    if (!open || !sticky) return undefined;
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, sticky, close]);

  const triggerProps = {
    ref: triggerRef,
    // Mouse and pen: straight through. No delay, no distance threshold.
    onPointerEnter: (e) => {
      if (e.pointerType === 'touch') return;
      setSticky(false);
      setOpen(true);
    },
    onPointerLeave: (e) => {
      if (e.pointerType === 'touch' || sticky) return;
      setOpen(false);
    },
    // Touch: fires at touch-DOWN, well before a click would land, which is what
    // makes the FIRST tap enough. Tapping the same trigger again closes it.
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch') return;
      setSticky(true);
      setOpen((v) => !v);
    },
    onFocus: () => { setSticky(false); setOpen(true); },
    onBlur: () => { if (!sticky) setOpen(false); },
    'aria-describedby': open ? id : undefined,
  };

  const body = typeof content === 'function' ? (open ? content() : null) : content;

  const overlay = open && body != null && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={cardRef}
          id={id}
          role="tooltip"
          className="fixed z-[9999] pointer-events-none rounded-xl border border-cyan-500/40 bg-slate-950/95 backdrop-blur-md px-3 py-2.5 text-slate-200 shadow-[0_16px_48px_rgba(0,0,0,0.65)] mc-hovercard-in"
          style={{
            top: pos ? pos.top : 0,
            left: pos ? pos.left : 0,
            width,
            maxWidth: `calc(100vw - ${HC_EDGE * 2}px)`,
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          {body}
        </div>,
        document.body,
      )
    : null;

  return { triggerProps, overlay, open };
}

// ---------------------------------------------------------------------------
// HoverCard — the hook wrapped up for anything that is not a table row.
// (A <tr> cannot be wrapped in a <span>, so rows call useHoverCard directly.)
// ---------------------------------------------------------------------------
export function HoverCard({
  content, children, placement = 'top', width = 300, as: Tag = 'span', className = '',
}) {
  const { triggerProps, overlay } = useHoverCard(content, { placement, width });
  return (
    <>
      <Tag
        {...triggerProps}
        tabIndex={0}
        className={`touch-manipulation cursor-help outline-none rounded focus-visible:ring-1 focus-visible:ring-cyan-400/60 ${className}`}
      >
        {children}
      </Tag>
      {overlay}
    </>
  );
}

// ---------------------------------------------------------------------------
// The pieces these cards are built from, so every popover on the dashboard
// reads the same way.
// ---------------------------------------------------------------------------
export function HoverTitle({ children, sub = '' }) {
  return (
    <div className="mb-2 border-b border-slate-700/60 pb-1.5">
      <p className="text-[11px] font-black uppercase tracking-wider text-cyan-300 leading-tight">{children}</p>
      {sub && <p className="mt-0.5 text-[9.5px] text-slate-500 leading-snug">{sub}</p>}
    </div>
  );
}

export function HoverKv({ k, v, tone = 'text-slate-200', mono = true, strong = false }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 py-[1.5px] ${strong ? 'mt-1 border-t border-slate-700/60 pt-1.5' : ''}`}>
      <span className={`text-[10px] truncate ${strong ? 'font-black uppercase tracking-wider text-slate-400' : 'text-slate-500'}`}>{k}</span>
      <span className={`shrink-0 ${strong ? 'text-[11.5px] font-black' : 'text-[10.5px] font-bold'} ${mono ? 'font-mono' : ''} ${tone}`}>{v}</span>
    </div>
  );
}

export function HoverNote({ children, tone = 'text-slate-400' }) {
  return <p className={`mt-2 border-t border-slate-700/60 pt-1.5 text-[9.5px] leading-relaxed ${tone}`}>{children}</p>;
}
