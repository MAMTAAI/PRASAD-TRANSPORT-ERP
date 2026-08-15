// @ts-nocheck
// ============================================================================
// <GlobalHeaderNav /> — the three module tabs, on every screen.
//
// These already lived in the shell header, so they were already persistent;
// what they were not was a component. Extracting them buys three things the
// inline version could not have: one place that defines what a module IS, an
// active state that is described once instead of repeated per button, and a
// shape the mobile bottom bar can share so the two can never drift apart.
//
// ACTIVE STATE IS SHOWN THREE WAYS ON PURPOSE — fill, border and glow. Colour
// alone fails for the ~8% of men with colour-vision deficiency, and this is the
// control that tells you which set of books you are looking at. Getting that
// wrong is not a cosmetic error.
// ============================================================================
import React from 'react';

export const MODULES = [
  { id: 'OPERATION', label: 'OPERATIONS',       icon: '🚛', from: '#3b82f6', to: '#6366f1', rgb: '59,130,246' },
  { id: 'ACCOUNTS',  label: 'ACCOUNTS & ADMIN', icon: '💰', from: '#10b981', to: '#059669', rgb: '16,185,129' },
  { id: 'CRM',       label: 'CRM (MAMTA AI)',   icon: '🤝', from: '#f59e0b', to: '#d97706', rgb: '245,158,11' },
];

export default function GlobalHeaderNav({ activeModule, onChange, compact = false }) {
  return (
    <div style={{ display: 'flex', gap: compact ? 6 : 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <style>{`
        @keyframes ghnGlow {
          0%,100% { box-shadow: 0 4px 15px rgba(var(--ghn-rgb), .40); }
          50%     { box-shadow: 0 4px 22px rgba(var(--ghn-rgb), .62); }
        }
        .ghn-tab { position: relative; border: 1px solid transparent; border-radius: 10px;
                   font-weight: 800; cursor: pointer; white-space: nowrap;
                   transition: background .2s, color .2s, border-color .2s, transform .15s; }
        .ghn-tab:hover { transform: translateY(-1px); }
        .ghn-tab:focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }
        .ghn-tab.is-active { animation: ghnGlow 2.6s ease-in-out infinite; }
        /* The underline is the third signal — it survives a greyscale print and
           a monochrome display, where fill and glow both disappear. */
        .ghn-tab.is-active::after {
          content: ''; position: absolute; left: 14px; right: 14px; bottom: -6px;
          height: 3px; border-radius: 3px; background: #fff; opacity: .9;
        }
      `}</style>

      {MODULES.map((m) => {
        const on = activeModule === m.id;
        return (
          <button
            key={m.id}
            onClick={() => onChange(m.id)}
            aria-current={on ? 'page' : undefined}
            title={`Switch to ${m.label}`}
            className={`ghn-tab${on ? ' is-active' : ''}`}
            style={{
              '--ghn-rgb': m.rgb,
              padding: compact ? '8px 12px' : '12px 20px',
              fontSize: compact ? 11 : 13,
              background: on ? `linear-gradient(135deg, ${m.from}, ${m.to})` : '#1e293b',
              color: on ? '#fff' : '#94a3b8',
              borderColor: on ? `rgba(${m.rgb}, .85)` : 'transparent',
            }}
          >
            {m.icon} {m.label}
          </button>
        );
      })}
    </div>
  );
}
