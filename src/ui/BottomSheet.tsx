// @ts-nocheck
// 📱 BottomSheet — the design-system replacement for fixed-width modals.
// Phone (<900px): slides up from the bottom, full width, drag-down to dismiss,
// safe-area padded. Desktop: centered dialog capped at min(92vw, maxWidth).
// Kills the 450/800/850px fixed modals that were clipped and unusable on phones.
import React, { useRef, useState, useEffect } from 'react';

export default function BottomSheet({ open, onClose, title, accent = '#38bdf8', maxWidth = 720, children }) {
  const [dragY, setDragY] = useState(0);
  const startRef = useRef(null);

  // Lock body scroll while open
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const onPointerDown = (e) => { startRef.current = e.clientY; };
  const onPointerMove = (e) => {
    if (startRef.current === null) return;
    const dy = e.clientY - startRef.current;
    if (dy > 0) setDragY(dy);
  };
  const onPointerUp = () => {
    if (dragY > 90) onClose?.();
    setDragY(0);
    startRef.current = null;
  };

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.8)', backdropFilter: 'blur(6px)', zIndex: 1000, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
      className="pt-sheet-scrim"
    >
      <style>{`
        .pt-sheet-panel { width: 100%; max-height: 92dvh; border-radius: 16px 16px 0 0; animation: pt-sheet-up .22s ease-out; }
        @keyframes pt-sheet-up { from { transform: translateY(40px); opacity: .6; } to { transform: translateY(0); opacity: 1; } }
        @media (min-width: 900px) {
          .pt-sheet-scrim { align-items: center !important; }
          .pt-sheet-panel { width: min(92vw, var(--sheet-max)) !important; max-height: 88vh; border-radius: 16px !important; }
          .pt-sheet-grip { display: none; }
        }
      `}</style>
      <div
        className="pt-sheet-panel"
        style={{
          '--sheet-max': `${maxWidth}px`,
          background: '#0f172a', border: '1px solid #334155', borderBottom: 'none',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 -10px 40px rgba(0,0,0,0.6)',
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: dragY ? 'none' : 'transform .15s',
        }}
      >
        {/* Drag grip (phone) */}
        <div
          className="pt-sheet-grip"
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          style={{ padding: '10px 0 4px', touchAction: 'none', cursor: 'grab', flexShrink: 0 }}
        >
          <div style={{ width: '44px', height: '5px', borderRadius: '3px', background: '#475569', margin: '0 auto' }} />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 20px', borderBottom: '1px solid #1e293b', flexShrink: 0 }}>
          <h3 style={{ margin: 0, color: accent, fontSize: 'clamp(16px, 4vw, 20px)', fontWeight: 900 }}>{title}</h3>
          <button onClick={onClose} aria-label="Close" style={{ background: 'rgba(239,68,68,0.12)', color: '#ef4444', border: '1px solid #ef4444', borderRadius: '10px', minWidth: '44px', minHeight: '40px', fontSize: '16px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
        </div>

        <div style={{ padding: 'clamp(14px, 3vw, 24px)', overflowY: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 'calc(clamp(14px, 3vw, 24px) + env(safe-area-inset-bottom))' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
