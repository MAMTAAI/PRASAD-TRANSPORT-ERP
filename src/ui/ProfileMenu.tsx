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
import { createPortal } from 'react-dom';
import { API_BASE } from '../lib/apiBase';
import { QRCodeSVG } from 'qrcode.react';
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

/** Mirrors INTERNAL_ROLES in server/lib/waLinkGuard.js. A courtesy only — so
 *  the row is not offered to someone the server is going to refuse. The server
 *  is the boundary; if these two ever drift, the server wins and the worst case
 *  is a button that answers 403 with a sentence explaining itself. */
const WA_LINK_ROLES = ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTS', 'DISPATCH'];

/** My WhatsApp.
 *
 *  IN THE PROFILE MENU BECAUSE IT IS A PROPERTY OF THE PERSON, NOT A SCREEN.
 *  The module tabs are filtered by permission, so anywhere else would have
 *  hidden it from the people who actually do the dispatching.
 *
 *  IT NO LONGER REACHES EVERY ROLE, AND THAT IS A REVERSAL. The note here used
 *  to say a VIEWER still needs to link, and the route behind it asked only for
 *  a token — which drivers hold too, since /otp/verify issues them. Linking is
 *  now the internal set only (server/lib/waLinkGuard.js). The row is hidden for
 *  everyone else rather than offering a button that answers 403, but the server
 *  is the authority: the check below is a courtesy, not the boundary.
 *
 *  THE QR IS NOT IN THE MENU, AND THAT IS THE WHOLE LAYOUT DECISION. A 168px
 *  code plus its instructions inside a 296px dropdown pushed the card past the
 *  height of a laptop viewport — identity block, three detail rows, a QR and
 *  LOG OUT stacked in a column that had to scroll to reach its own primary
 *  action. A dropdown should be glanceable. So the menu carries one status line
 *  and one button, and the code opens in a dialog with room to be scanned.
 *
 *  A QR IS A CREDENTIAL: whoever scans it becomes a linked device that can read
 *  every chat on that account. It is fetched from the ERP (which derives the
 *  session from the caller's own token — no id travels in the request) and drawn
 *  client-side by qrcode.react, never handed to an external QR image service.
 */
function MyWhatsApp() {
  const [state, setState] = useState({ loading: true });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async () => {
    try {
      const token = localStorage.getItem('prasad_token');
      const res = await fetch(`${API_BASE}/api/v1/auth/whatsapp/my-session`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json().catch(() => ({}));
      setState({ loading: false, ...j });
      return j;
    } catch {
      setState({ loading: false, reachable: false, reason: 'network' });
      return null;
    }
  }, []);

  useEffect(() => { read(); }, [read]);

  // Polled ONLY while a credential is on screen waiting to be used. The engine
  // stops emitting both once the device is linked, so there is nothing to watch
  // after that and a timer left running is just load.
  //
  // Watches the pairing code as well as the QR, and it has to: the code is
  // requested asynchronously when the client reaches its auth screen, so there
  // is a window where the QR is present and the code is not yet. Polling only
  // on `qr` would still cover that window — but not a session that comes back
  // with a code and no QR at all.
  useEffect(() => {
    if (!open || state.linked || !(state.qr || state.pairing_code)) return;
    const t = setInterval(read, 4000);
    return () => clearInterval(t);
  }, [open, state.qr, state.pairing_code, state.linked, read]);

  const link = async () => {
    setBusy(true);
    try {
      const token = localStorage.getItem('prasad_token');
      const res = await fetch(`${API_BASE}/api/v1/auth/whatsapp/my-session/link`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setState((s) => ({ ...s, error: j.error, reason: j.detail }));
      else setState({ loading: false, ...j, multi_session: true });
    } finally { setBusy(false); }
  };

  const unlink = async () => {
    if (!window.confirm('Apna WhatsApp ERP se hata dein?\n\nUske baad aapke bheje messages company number se jayenge.')) return;
    setBusy(true);
    try {
      const token = localStorage.getItem('prasad_token');
      await fetch(`${API_BASE}/api/v1/auth/whatsapp/my-session/unlink`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      });
      await read();
    } finally { setBusy(false); }
  };

  // One line, in the menu. Everything else lives in the dialog.
  let dot = '#64748b';
  let line = 'checking…';
  let action = null;

  if (!state.loading) {
    // Every settled state gets a way into the dialog, including the broken
    // ones. A row that says "Engine offline" and offers nothing to click is a
    // dead end: the person can see that something is wrong and has no way to
    // find out what, which is the state this whole panel was reported in.
    action = 'VIEW';
    if (state.reachable === false) {
      dot = '#f59e0b';
      line = 'Engine offline';
    } else if (state.multi_session === false) {
      // The single-session engine answers /api/status/:userId by ignoring the
      // id and returning the COMPANY line's state. Saying "linked" there would
      // be a confident lie, so it is named for what it is.
      dot = '#f59e0b';
      line = 'Engine purana — restart chahiye';
    } else if (state.linked) {
      dot = '#34d399';
      line = 'Juda hua';
      action = 'MANAGE';
    } else {
      dot = '#64748b';
      line = 'Juda nahi';
      action = 'LINK';
    }
  }

  return (
    <>
      <div style={{ padding: '10px 16px', borderTop: '1px solid #1e293b', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#64748b', fontWeight: 700 }}>
            My WhatsApp
          </div>
          <div style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 600, overflowWrap: 'anywhere' }}>{line}</div>
        </div>
        {action && (
          <button onClick={() => setOpen(true)}
            style={{ flexShrink: 0, padding: '5px 10px', borderRadius: 8, border: '1px solid #334155',
                     background: 'transparent', color: '#7dd3fc', fontWeight: 800, fontSize: 10.5, cursor: 'pointer' }}>
            {action === 'LINK' ? 'JODEIN' : 'DEKHEIN'}

          </button>
        )}
      </div>

      {/* PORTALLED TO document.body, AND IT HAS TO BE.
          `position: fixed` is normally relative to the viewport — but an
          ancestor with a transform, a filter or a BACKDROP-FILTER becomes its
          containing block instead, and the shell header carries
          backdrop-filter: blur(10px). Rendered in place, this overlay resolved
          `inset: 0` against the header and came out 2034x75: a thin strip
          across the top bar with the dialog squashed inside it, measured in the
          browser rather than guessed at. A portal leaves that subtree entirely,
          which also frees it from the dropdown's own z-index and its
          overflow: hidden. */}
      {open && createPortal(
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.82)', zIndex: 1400,
            display: 'grid', placeItems: 'center', padding: 20,
          }}
        >
          {/* 1400 clears the header's 100 and every in-page layer, and stays
              under the portal previews at 9999. */}
          <div onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(340px, 100%)', maxHeight: 'calc(100vh - 48px)', overflowY: 'auto',
                     background: '#0f172a', border: '1px solid #1e293b', borderRadius: 18, padding: 20,
                     boxShadow: '0 20px 60px rgba(0,0,0,0.6)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <span style={{ fontSize: 14, fontWeight: 900, color: '#f1f5f9' }}>My WhatsApp</span>
              <button onClick={() => setOpen(false)}
                style={{ background: 'transparent', border: 'none', color: '#64748b', fontSize: 20, cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>

            {state.linked ? (
              <>
                <p style={{ fontSize: 12.5, color: '#6ee7b7', fontWeight: 700, marginBottom: 6 }}>● Juda hua</p>
                <p style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.5, marginBottom: 14 }}>
                  Aapke bheje dispatch messages aapke apne WhatsApp number se jayenge, company number se nahi.
                </p>
                <button onClick={unlink} disabled={busy}
                  style={{ width: '100%', padding: '10px', borderRadius: 10, border: '1px solid #7f1d1d',
                           background: 'transparent', color: '#fca5a5', fontWeight: 800, fontSize: 12, cursor: 'pointer' }}>
                  {busy ? '…' : 'WhatsApp hataayein'}
                </button>
              </>
            ) : state.pairing_code ? (
              <>
                {/* THE CODE, NOT A QR — AND ON THE MOBILE APP THAT IS THE ONLY
                    FLOW THAT WORKS. A phone cannot photograph its own screen,
                    so the QR branch below is unreachable in practice there.
                    WhatsApp takes this under "Link with phone number instead".

                    It is not an auto-link and cannot be: matching a number
                    against a staff row proves nothing to WhatsApp: only the
                    account holder acting on their own handset is
                    authentication. What this removes is the second device, not
                    the person. */}
                <div style={{ background: '#020617', border: '1px solid #1e293b', borderRadius: 14,
                              padding: '20px 12px', display: 'grid', placeItems: 'center' }}>
                  <div style={{ fontSize: 27, fontWeight: 900, letterSpacing: '0.26em',
                                color: '#7dd3fc', fontFamily: 'ui-monospace, SFMono-Regular, monospace' }}>
                    {state.pairing_code}
                  </div>
                </div>
                <ol style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.7, margin: '14px 0 0', paddingLeft: 18 }}>
                  <li>Apne phone par WhatsApp kholein</li>
                  <li><b style={{ color: '#cbd5e1' }}>Settings → Linked devices</b></li>
                  <li><b style={{ color: '#cbd5e1' }}>Link a device</b> dabayein</li>
                  <li><b style={{ color: '#cbd5e1' }}>Link with phone number instead</b> chunein</li>
                  <li>Ye code daalein</li>
                </ol>
                <p style={{ fontSize: 10.5, color: '#64748b', marginTop: 12, lineHeight: 1.5 }}>
                  Code daalte hi ye screen apne aap badal jayegi.
                </p>
              </>
            ) : state.qr ? (
              <>
                <div style={{ background: '#fff', padding: 12, borderRadius: 14, display: 'grid', placeItems: 'center' }}>
                  <QRCodeSVG value={state.qr} size={220} />
                </div>
                <ol style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.7, margin: '14px 0 0', paddingLeft: 18 }}>
                  <li>Apne phone par WhatsApp kholein</li>
                  <li><b style={{ color: '#cbd5e1' }}>Settings → Linked devices</b></li>
                  <li><b style={{ color: '#cbd5e1' }}>Link a device</b> dabayein</li>
                  <li>Ye code scan karein</li>
                </ol>
                <p style={{ fontSize: 10.5, color: '#64748b', marginTop: 12, lineHeight: 1.5 }}>
                  Scan hote hi ye screen apne aap badal jayegi.
                </p>
              </>
            ) : state.error === 'ENGINE_OUTDATED' || state.multi_session === false ? (
              <>
                <p style={{ fontSize: 12.5, color: '#fcd34d', fontWeight: 700, marginBottom: 8 }}>
                  Engine abhi purana version chala raha hai
                </p>
                <p style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.55 }}>
                  Per-user WhatsApp ka code server par pahunch chuka hai, par WhatsApp engine ka process
                  restart nahi hua — isliye woh abhi bhi sirf company number jaanta hai.
                </p>
                <pre style={{ fontSize: 11, color: '#7dd3fc', background: '#020617', border: '1px solid #1e293b',
                              borderRadius: 10, padding: 10, marginTop: 12, overflowX: 'auto' }}>
pm2 restart prasad-wa-engine</pre>
              </>
            ) : state.reachable === false ? (
              <p style={{ fontSize: 12, color: '#fcd34d', lineHeight: 1.55 }}>
                WhatsApp engine se sampark nahi ho pa raha{state.reason ? ` (${state.reason})` : ''}.
              </p>
            ) : (
              <>
                <p style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.55, marginBottom: 14 }}>
                  Abhi aapke messages company number se jate hain. Apna number jodein to driver ko
                  seedhe aapke naam aur number se message jayega.
                </p>
                <button onClick={link} disabled={busy}
                  style={{ width: '100%', padding: '11px', borderRadius: 10, border: 'none',
                           background: '#059669', color: '#fff', fontWeight: 800, fontSize: 12.5, cursor: 'pointer' }}>
                  {busy ? 'QR la rahe hain…' : 'Apna WhatsApp jodein'}
                </button>
                {state.reason && (
                  <p style={{ fontSize: 11, color: '#fca5a5', marginTop: 10, lineHeight: 1.5 }}>{state.reason}</p>
                )}
              </>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

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

          {WA_LINK_ROLES.includes(role) && <MyWhatsApp />}

          <div style={{ padding: '12px 12px 12px' }}>
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
