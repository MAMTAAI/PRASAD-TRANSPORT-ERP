// src/ui/whatsappLink.tsx
// ─────────────────────────────────────────────────────────────────────────────
// Linking this person's WhatsApp — the status line, the dialog, and the code
// or QR inside it. Lifted out of ProfileMenu so the Live Dispatch panel can
// offer the same thing without a second copy of it.
//
// ONE COPY MATTERS HERE MORE THAN USUAL. What this dialog renders is a
// CREDENTIAL: a QR that links a device able to read every chat on the account,
// or a pairing code that does the same. Two copies means two places to get the
// "stop showing it once linked" rule wrong, and a stale credential on screen
// gets used and fails, which reads as a broken link rather than a finished one.
// ─────────────────────────────────────────────────────────────────────────────
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_BASE } from '../lib/apiBase';
import { QRCodeSVG } from 'qrcode.react';

/** Mirrors INTERNAL_ROLES in server/lib/waLinkGuard.js. A courtesy only — so
 *  the row is not offered to someone the server is going to refuse. The server
 *  is the boundary; if these two ever drift, the server wins and the worst case
 *  is a button that answers 403 with a sentence explaining itself. */
export const WA_LINK_ROLES = ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTS', 'DISPATCH'];

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
export function MyWhatsApp({ variant = 'menu' }) {
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
  // ...AND WHILE ONE IS STILL BEING MADE, WHICH IS THE PART THIS MISSED.
  //
  // The condition used to require a QR or a code to already be present, so it
  // refused to poll during the one window where polling is the whole point.
  // Pressing "jodein" returns status STARTING with both fields empty — Chromium
  // has not launched yet and the code is fifteen-odd seconds away — so nothing
  // ever asked again and the dialog sat on its spinner for ever. It was waiting
  // for the thing it was supposed to be waiting FOR.
  //
  // A session is pending whenever the engine reports a live status. OFFLINE with
  // no credential means nothing has been started, and that is the one state that
  // should not hold a timer open.
  const pending = !!(state.qr || state.pairing_code
    || ['STARTING', 'WAITING_FOR_SCAN', 'RECONNECTING'].includes(state.status));

  useEffect(() => {
    if (!open || state.linked || !pending) return;
    const t = setInterval(read, 3000);
    return () => clearInterval(t);
  }, [open, pending, state.linked, read]);

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
      {/* Same row, two homes. In the profile dropdown it closes the card, so
          it carries the top border; in the Live Dispatch panel it opens one and
          carries a bottom border instead. Nothing else differs — the states,
          the wording and the dialog are identical wherever it is mounted. */}
      <div style={variant === 'panel'
        ? { padding: '8px 12px', borderBottom: '1px solid rgba(51,65,85,0.5)', background: 'rgba(255,255,255,0.02)',
            display: 'flex', alignItems: 'center', gap: 10 }
        : { padding: '10px 16px', borderTop: '1px solid #1e293b',
            display: 'flex', alignItems: 'center', gap: 10 }}>
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
            ) : pending ? (
              /* THE WINDOW BETWEEN PRESSING THE BUTTON AND THE CODE ARRIVING.
                 The engine answers the link request in milliseconds with status
                 STARTING and nothing to show: Chromium has yet to launch and the
                 code is fifteen-odd seconds out. Without a branch of its own
                 this fell through to the "jodein" button, so the screen offered
                 to start a session that was already starting. Now it says what
                 is happening and how long it takes, and the poll above replaces
                 it with the code the moment there is one. */
              <>
                <p style={{ fontSize: 12.5, color: '#7dd3fc', fontWeight: 700, marginBottom: 8 }}>
                  Code banaya ja raha hai…
                </p>
                <p style={{ fontSize: 11.5, color: '#94a3b8', lineHeight: 1.55 }}>
                  WhatsApp se code mangwa rahe hain. Isme aam taur par <b style={{ color: '#cbd5e1' }}>15–30 second</b> lagte
                  hain — ye screen khuli rehne dein, code aate hi apne aap dikh jayega.
                </p>
                {state.reason && (
                  <p style={{ fontSize: 11, color: '#fca5a5', marginTop: 10, lineHeight: 1.5 }}>{state.reason}</p>
                )}
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
