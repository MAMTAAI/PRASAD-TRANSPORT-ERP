// @ts-nocheck
// 📱 Shared mobile-chat utilities for the Mamta AI surfaces.
// - useKeyboardInset(): how many px the virtual keyboard covers the layout
//   viewport (visualViewport-based — the only thing that works on iOS Safari,
//   where the layout viewport does NOT resize when the keyboard opens).
// - AssistantText: renders an AI answer with its bullet-point action
//   suggestions as TAP-FRIENDLY chips — on a phone you tap, you don't type.
import React, { useEffect, useState } from 'react';

export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setInset(covered > 60 ? covered : 0); // <60px = browser chrome noise, not a keyboard
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);
  return inset;
}

const BULLET_RE = /^\s*(?:[-•*▪]|\d+[.)])\s+(.+)$/;
const stripMd = (s) => String(s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/, '');

/** AI answer renderer: normal lines wrap as text; bullet lines become
 *  44px-min tappable suggestion chips (tap → asks Mamta about that point). */
export function AssistantText({ text, onTapSuggestion, accent = '#c084fc' }) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let para = [];
  const flush = () => { if (para.length) { blocks.push({ type: 'p', text: para.join('\n') }); para = []; } };
  for (const raw of lines) {
    const m = raw.match(BULLET_RE);
    if (m && stripMd(m[1]).trim().length > 2) { flush(); blocks.push({ type: 'chip', text: stripMd(m[1]).trim() }); }
    else para.push(stripMd(raw));
  }
  flush();

  return (
    <div style={{ overflowWrap: 'anywhere', wordBreak: 'break-word' }}>
      {blocks.map((b, i) => b.type === 'p' ? (
        <div key={i} style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{b.text}</div>
      ) : (
        <button
          key={i}
          onClick={() => onTapSuggestion?.(b.text)}
          title="Tap karke iske baare me aur poochhein"
          style={{
            display: 'flex', alignItems: 'flex-start', gap: '8px', width: '100%', textAlign: 'left',
            background: `${accent}14`, border: `1px solid ${accent}55`, borderRadius: '12px',
            padding: '10px 12px', margin: '6px 0', color: '#e2e8f0', cursor: 'pointer',
            minHeight: '44px', fontSize: 'inherit', lineHeight: 1.45, fontFamily: 'inherit',
            overflowWrap: 'anywhere', wordBreak: 'break-word',
          }}
        >
          <span style={{ color: accent, flexShrink: 0 }}>▸</span>
          <span style={{ flex: 1 }}>{b.text}</span>
          <span style={{ color: accent, flexShrink: 0, fontSize: '12px', alignSelf: 'center' }}>👆</span>
        </button>
      ))}
    </div>
  );
}
