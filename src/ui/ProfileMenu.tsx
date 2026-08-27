// @ts-nocheck
// ============================================================================
// <ProfileMenu /> — the circular avatar at the far right of the header and the
// card that opens under it.
//
// WHY A COMPONENT AND NOT MORE JSX IN App.tsx. The header previously rendered
// the avatar, the name, the role and a full-width LOGOUT button inline, which
// cost ~260px of the top bar and pushed the module tabs into a second row on a
// laptop. Collapsing that to a 38px circle gives the row back; the detail moves
// into a menu that is only paid for when it is opened.
//
// The session line (IP / device) is the part that matters operationally: it is
// how someone notices a session they did not open. It comes from /auth/me,
// which reads auth_sessions — the address the session was ESTABLISHED from,
// not whatever proxy forwarded the current request.
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/apiBase';
import { isAdmin } from '../lib/rbac';

const ROLE_TONE = {
  SUPER_ADMIN: { bg: 'rgba(168,85,247,0.16)', fg: '#d8b4fe', ring: 'rgba(168,85,247,0.5)' },
  ADMIN:       { bg: 'rgba(56,189,248,0.16)', fg: '#7dd3fc', ring: 'rgba(56,189,248,0.5)' },
  ACCOUNTS:    { bg: 'rgba(16,185,129,0.16)', fg: '#6ee7b7', ring: 'rgba(16,185,129,0.5)' },
  DISPATCH:    { bg: 'rgba(245,158,11,0.16)', fg: '#fcd34d', ring: 'rgba(245,158,11,0.5)' },
  CUSTOMER:    { bg: 'rgba(236,72,153,0.16)', fg: '#f9a8d4', ring: 'rgba(236,72,153,0.5)' },
  VENDOR:      { bg: 'rgba(249,115,22,0.16)', fg: '#fdba74', ring: 'rgba(249,115,22,0.5)' },
  DRIVER:      { bg: 'rgba(59,130,246,0.16)', fg: '#93c5fd', ring: 'rgba(59,130,246,0.5)' },
  VIEWER:      { bg: 'rgba(148,163,184,0.16)', fg: '#cbd5e1', ring: 'rgba(148,163,184,0.5)' },
};
const toneFor = (role) => ROLE_TONE[String(role || '').toUpperCase()] ?? ROLE_TONE.VIEWER;

/** Initials from a full name: "Sandeep Kumar Prasad" -> "SP". */
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// LABEL ABOVE THE VALUE, NOT BESIDE IT. Side by side, a 62px label column left
// about 178px for the value — narrower than either of the two things this card
// actually shows. A gmail address broke as "sandeepkrprasad03@gmail" / ".com"
// and an IPv6 session address split mid-group, so the card read as damaged
// rather than merely wrapped. Stacking gives the value the card's full width,
// which fits both on one line; `anywhere` still wraps something genuinely
// longer, but now as the exception instead of the rule.
const Row = ({ label, value, mono }) => (
  <div style={{ padding: '6px 0' }}>
    <div style={{ fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#64748b', fontWeight: 700, marginBottom: 3 }}>
      {label}
    </div>
    <div style={{
      fontSize: 12.5, color: '#e2e8f0', fontWeight: 600, overflowWrap: 'anywhere', lineHeight: 1.35,
      fontFamily: mono ? "ui-monospace, 'Cascadia Mono', Menlo, monospace" : 'inherit',
    }}>
      {value ?? <span style={{ color: '#475569', fontWeight: 500 }}>not set</span>}
    </div>
  </div>
);

export default function ProfileMenu({ user, onLogout, compact = false }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(null);
  const wrapRef = useRef(null);

  const role = String(user?.role || 'STAFF').toUpperCase();
  const tone = toneFor(role);
  const name = user?.full_name || user?.name || 'Staff';

  // Session detail is fetched when the menu is first opened, not on mount: the
  // header renders on every screen and this is one request nobody needs until
  // they ask for it.
  useEffect(() => {
    if (!open || session) return;
    let alive = true;
    (async () => {
      try {
        const token = localStorage.getItem('prasad_token');
        if (!token) return;
        const res = await fetch(`${API_BASE}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok || !alive) return;
        const json = await res.json();
        if (alive) setSession(json.session ?? null);
      } catch { /* the menu still shows everything else */ }
    })();
    return () => { alive = false; };
  }, [open, session]);

  // Close on outside click and on Escape. Both, because a menu that only closes
  // one way is a menu that gets stuck open on a touch device.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const logout = useCallback(() => { setOpen(false); onLogout?.(); }, [onLogout]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      <style>{`
        @keyframes pmIn { from { opacity: 0; transform: translateY(-6px) scale(0.97); } to { opacity: 1; transform: none; } }
        .pm-avatar { transition: box-shadow .2s, transform .2s; }
        .pm-avatar:hover { transform: translateY(-1px); }
        .pm-logout:hover { background: #dc2626 !important; }
      `}</style>

      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        title={`${name} · ${role}`}
        className="pm-avatar"
        style={{
          width: compact ? 34 : 38, height: compact ? 34 : 38, borderRadius: '50%',
          background: `linear-gradient(135deg, ${tone.fg}, #38bdf8)`,
          color: '#04121f', fontWeight: 900, fontSize: compact ? 12 : 13, letterSpacing: '0.02em',
          border: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center',
          boxShadow: open ? `0 0 0 3px ${tone.ring}` : '0 2px 8px rgba(0,0,0,0.45)',
          fontFamily: "'Inter', sans-serif",
        }}
      >
        {initials(name)}
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 'calc(100% + 10px)', right: 0, width: 296,
            // A short laptop viewport must not leave LOG OUT below the fold
            // with no way to scroll to it.
            maxHeight: 'calc(100vh - 88px)', overflowY: 'auto',
            background: '#0f172a', border: '1px solid #1e293b', borderRadius: 14,
            // Material elevation: a tight contact shadow plus a wide ambient one.
            boxShadow: '0 1px 3px rgba(0,0,0,0.6), 0 10px 34px rgba(0,0,0,0.55)',
            zIndex: 1200, overflow: 'hidden', animation: 'pmIn .14s ease-out',
          }}
        >
          {/* identity */}
          <div style={{ padding: '15px 16px 13px', borderBottom: '1px solid #1e293b', display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{
              width: 42, height: 42, borderRadius: '50%', flexShrink: 0,
              background: `linear-gradient(135deg, ${tone.fg}, #38bdf8)`,
              color: '#04121f', fontWeight: 900, fontSize: 14, display: 'grid', placeItems: 'center',
            }}>{initials(name)}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: '#f1f5f9', fontSize: 13.5, fontWeight: 800, lineHeight: 1.25, wordBreak: 'break-word' }}>{name}</div>
              <span style={{
                display: 'inline-block', marginTop: 5, padding: '2px 8px', borderRadius: 999,
                background: tone.bg, color: tone.fg, fontSize: 9.5, fontWeight: 900, letterSpacing: '0.09em',
              }}>
                {role.replace(/_/g, ' ')}{isAdmin(user) ? ' · FULL ACCESS' : ''}
              </span>
            </div>
          </div>

          {/* details */}
          <div style={{ padding: '8px 16px 12px' }}>
            <Row label="Email" value={user?.email} />
            <Row label="Branch" value={user?.branch} />
            <Row label="Session" value={session?.ip} mono />
          </div>

          <div style={{ padding: '0 12px 12px' }}>
            <button
              onClick={logout}
              className="pm-logout"
              style={{
                width: '100%', padding: '10px 12px', borderRadius: 10, border: 'none',
                background: '#ef4444', color: '#fff', fontWeight: 800, fontSize: 12.5,
                letterSpacing: '0.04em', cursor: 'pointer', transition: 'background .15s',
              }}
            >
              LOG OUT
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
