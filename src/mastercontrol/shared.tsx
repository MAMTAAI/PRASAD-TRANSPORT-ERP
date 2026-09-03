// @ts-nocheck
// ============================================================================
// PRASAD MASTER CONTROL ERP v5.0 — Shared UI Kit
// Glassmorphism design system: dark ground #0a1024, frosted slate panels,
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
      className={`relative rounded-2xl bg-deck-card bg-slate-900/55 backdrop-blur-md border border-slate-700/70 shadow-deck transition-colors duration-200 hover:border-slate-600/80 ${glow} ${className}`}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PanelHeader — icon + title + optional right-side accessory
// ---------------------------------------------------------------------------
// `onTitleClick` makes a whole panel auditable, for panels whose subject is a
// LIST rather than a single number -- the document vault, the ledger book. A
// KpiCard drills from its figure; these have no one figure to attach to, so the
// title is the handle.
export function PanelHeader({ icon: Icon, title, accent = 'text-cyan-400', right = null, sub = '', onTitleClick = null }) {
  return (
    <div className="flex items-center justify-between px-4 pt-4 pb-2">
      <div className="flex items-center gap-2 min-w-0">
        {Icon && (
          <span className={`shrink-0 grid place-items-center w-7 h-7 rounded-lg bg-white/5 border border-slate-700/50 ${accent}`}>
            <Icon size={15} />
          </span>
        )}
        <div className="min-w-0">
          {onTitleClick ? (
            <button
              type="button"
              onClick={onTitleClick}
              title={`Show the rows behind ${title}`}
              className="group/t block max-w-full cursor-pointer text-left focus:outline-none
                         focus-visible:ring-2 focus-visible:ring-cyan-400/70 rounded"
            >
              <h3 className="truncate text-[13px] font-bold uppercase tracking-wide text-slate-100
                             underline-offset-4 transition-colors group-hover/t:text-cyan-200 group-hover/t:underline">
                {title}
              </h3>
            </button>
          ) : (
            <h3 className="text-[13px] font-bold tracking-wide text-slate-100 truncate uppercase">{title}</h3>
          )}
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
// `onDrill` turns a card into a button that opens the rows behind its number.
// Cards WITHOUT it stay inert and show no pointer -- a hover cue that leads
// nowhere teaches people the dashboard is broken.
/**
 * Open the drill-down drawer for `metric`, telling it what the card was showing.
 * MasterControlApp listens; nothing else needs to know the drawer exists.
 *
 * `expected` is not decoration -- the drawer compares it against the rows it
 * fetches and refuses to hide a disagreement.
 */
export const openDrilldown = (metric, expected = null) =>
  window.dispatchEvent(new CustomEvent('pt:drilldown', { detail: { metric, expected } }));

/**
 * Wraps any number that is NOT a KpiCard -- a tile, a figure inside a panel --
 * and makes it open its own rows. Renders children untouched when `metric` is
 * null, so a figure with no row-level query stays inert rather than offering a
 * click that goes nowhere.
 */
export function Drillable({ metric, expected = null, children, className = '' }) {
  if (!metric) return children;
  return (
    <button
      type="button"
      onClick={() => openDrilldown(metric, expected)}
      title="Click to see the rows behind this number"
      className={`block w-full cursor-pointer rounded-xl text-left transition-all duration-150
                  hover:bg-white/[0.06] hover:brightness-110
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 ${className}`}
    >
      {children}
    </button>
  );
}

export function KpiCard({ icon: Icon, label, value, sub, accent = 'cyan', onDrill = null }) {
  const accents = {
    // Glow at 0.12 opacity was invisible against #020617; on navy it is the
    // thing that makes a tile read as live, so each accent now carries its
    // own named glow from tailwind.config.cjs.
    cyan:    { text: 'text-cyan-300',    ring: 'border-live/40',    glowCls: 'shadow-glow-live',    bar: 'from-live to-cyan-300' },
    emerald: { text: 'text-emerald-300', ring: 'border-active/40',  glowCls: 'shadow-glow-active',  bar: 'from-active to-emerald-300' },
    amber:   { text: 'text-amber-300',   ring: 'border-pending/40', glowCls: 'shadow-glow-pending', bar: 'from-pending to-amber-300' },
    red:     { text: 'text-red-300',     ring: 'border-blocked/40', glowCls: 'shadow-glow-blocked', bar: 'from-blocked to-red-300' },
    violet:  { text: 'text-violet-300',  ring: 'border-mamta/40',   glowCls: 'shadow-glow-mamta',   bar: 'from-mamta to-violet-300' },
  };
  const a = accents[accent] || accents.cyan;
  const Tag = onDrill ? 'button' : 'div';
  return (
    <Tag
      {...(onDrill
        ? {
            onClick: onDrill,
            type: 'button',
            title: `Show the rows behind ${label}`,
            'aria-label': `Show the rows behind ${label}`,
          }
        : {})}
      className={`relative overflow-hidden rounded-2xl bg-deck-tile bg-slate-900/55 backdrop-blur-md border ${a.ring} ${a.glowCls} p-4
        ${onDrill
          ? 'w-full cursor-pointer text-left transition-all duration-150 hover:-translate-y-1 hover:shadow-deck-hi hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-live/70'
          : ''}`}
    >
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
      <div className={`absolute bottom-0 left-0 right-0 h-[4px] bg-gradient-to-r ${a.bar}`} />
      {onDrill && (
        <span className="pointer-events-none absolute right-2 bottom-2 text-[9px] font-bold uppercase
                         tracking-wider text-slate-500 opacity-0 transition-opacity group-hover:opacity-100">
          click to audit
        </span>
      )}
    </Tag>
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
    border: '1px solid rgba(39, 57, 95, 0.6)',
    borderRadius: '10px',
    fontSize: '11px',
    color: '#dde5f4',
  },
  labelStyle: { color: '#9aadd4', fontWeight: 700 },
  itemStyle: { color: '#dde5f4' },
};

export const axisStyle = { fontSize: 10, fill: '#7288b3' };

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

// ---------------------------------------------------------------------------
// The left-column panel kit — one row treatment for every stacked panel
// ---------------------------------------------------------------------------
// Today's Loading Activity is the panel that reads correctly in a 340px column,
// so its measurements are the standard here rather than one more variation.
// Driver Command Center, Master Document Vault and Compliance Expiry each had
// their own row height, chip size and hover, which made a stack of three read
// as three unrelated widgets and forced the eye to re-learn the layout at every
// boundary. Import these instead of re-inventing them.
//
// The rule the same panel sets, worth repeating because it is easy to undo:
// a panel is not a click target. Put an explicit button or link in
// PanelHeader's `right`, so the action names itself.
export const TONE_CHIP = {
  red: 'text-red-300 border-red-500/40 bg-red-500/10',
  amber: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
  green: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  emerald: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  slate: 'text-slate-400 border-slate-600/50 bg-slate-700/20',
};

/** One chip scale for the whole column. */
export const chipCls = (tone) =>
  `rounded-md border px-1.5 py-0.5 text-[9.5px] font-bold whitespace-nowrap ${TONE_CHIP[tone] || TONE_CHIP.slate}`;

/** Fixed height + its own scroll, so a long list never pushes the column off
 *  screen. Pair with SCROLL_PANE; the panel must not also be given a height. */
export const PANEL_SHELL = 'flex flex-col overflow-hidden max-h-[340px]';

/** flex-1 + min-h-0 so this pane, and only this pane, absorbs the leftover
 *  height and scrolls instead of stretching the panel. */
export const SCROLL_PANE = 'flex-1 min-h-0 overflow-y-auto mc-thin-scrollbar px-2 py-1.5 flex flex-col gap-1';

/** Transparent border at rest, revealed on hover — a stack of solid cards in a
 *  narrow column reads as noise long before it reads as data. */
export const ROW_CLS = 'flex items-start gap-2 rounded-lg border border-transparent px-1.5 py-1 transition-colors hover:border-slate-700/60 hover:bg-white/5';

/** Small square badge that leads a row and carries its worst state, so a column
 *  can be triaged without reading any text. */
export const BADGE_CLS = (tone) =>
  `mt-px shrink-0 grid place-items-center w-5 h-5 rounded-md border ${TONE_CHIP[tone] || TONE_CHIP.slate}`;
