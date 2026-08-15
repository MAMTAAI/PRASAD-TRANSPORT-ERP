// @ts-nocheck
// ============================================================================
// <PortalSwitcher /> — the three "view as" portals behind one control.
//
// They used to sit in the header as three separate full-size buttons (VENDOR /
// CUSTOMER / DRIVER APP), which is three buttons' worth of top bar for
// something used occasionally, by admins only. They are the same KIND of
// action — open somebody else's view — so they belong under one label.
// ============================================================================
import React, { useEffect, useRef, useState } from 'react';

const PORTALS = [
  { id: 'CUSTOMER_PORTAL_PREVIEW', label: 'Customer Portal', hint: 'What a customer sees', icon: '🏢', tint: '#ec4899' },
  { id: 'PARTNER_PORTAL_PREVIEW',  label: 'Vendor Portal',   hint: 'Fleet partner view',   icon: '🚚', tint: '#f97316' },
  { id: 'DRIVER_PORTAL_PREVIEW',   label: 'Driver App',      hint: 'Duty screen preview',  icon: '👨‍✈️', tint: '#3b82f6' },
];

export default function PortalSwitcher({ onOpen, activeComponent }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const activePortal = PORTALS.find((p) => p.id === activeComponent);

  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <style>{`
        @keyframes psIn { from { opacity: 0; transform: translateY(-6px) scale(0.97); } to { opacity: 1; transform: none; } }
        .ps-item:hover { background: rgba(56,189,248,0.09) !important; }
      `}</style>

      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Preview a partner-facing portal"
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '9px 13px', borderRadius: 10,
          background: activePortal ? 'rgba(56,189,248,0.14)' : '#1e293b',
          color: activePortal ? '#7dd3fc' : '#94a3b8',
          border: `1px solid ${activePortal ? 'rgba(56,189,248,0.4)' : 'transparent'}`,
          fontWeight: 800, fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        <span>👁️</span>
        <span>{activePortal ? activePortal.label : 'View As'}</span>
        <span style={{ fontSize: 9, opacity: 0.7, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>▼</span>
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 10px)', right: 0, width: 232,
            background: '#0f172a', border: '1px solid #1e293b', borderRadius: 14,
            boxShadow: '0 1px 3px rgba(0,0,0,0.6), 0 10px 34px rgba(0,0,0,0.55)',
            zIndex: 1200, overflow: 'hidden', animation: 'psIn .14s ease-out', padding: 6,
          }}
        >
          <div style={{ padding: '8px 10px 6px', fontSize: 9.5, fontWeight: 900, letterSpacing: '0.09em', color: '#64748b' }}>
            PREVIEW PORTAL
          </div>
          {PORTALS.map((p) => (
            <button
              key={p.id}
              className="ps-item"
              onClick={() => { setOpen(false); onOpen(p.id); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 11, width: '100%', textAlign: 'left',
                padding: '9px 10px', borderRadius: 9, border: 'none', cursor: 'pointer',
                background: activeComponent === p.id ? 'rgba(56,189,248,0.12)' : 'transparent',
                transition: 'background .12s',
              }}
            >
              <span style={{
                width: 28, height: 28, borderRadius: 8, display: 'grid', placeItems: 'center',
                background: `${p.tint}22`, fontSize: 14, flexShrink: 0,
              }}>{p.icon}</span>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block', color: '#e2e8f0', fontSize: 12.5, fontWeight: 700 }}>{p.label}</span>
                <span style={{ display: 'block', color: '#64748b', fontSize: 10.5 }}>{p.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
