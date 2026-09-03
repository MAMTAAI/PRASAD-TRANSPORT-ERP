// @ts-nocheck
// ============================================================================
// <AccountHoldScreen /> — the wall a PENDING or SUSPENDED account hits.
//
// This is a UI courtesy, not the security control. The control is server-side:
// requireAuth re-reads account_status on every request and refuses with 403, so
// an account that gets past this screen (a stale bundle, a crafted localStorage
// entry, curl) still cannot read a single row. This screen exists so the person
// is told WHY, instead of watching every panel fail.
//
// PENDING and SUSPENDED are deliberately different. "Under verification" is a
// wait with an end; "suspended" is a decision that was made. Showing the same
// copy for both sends suspended users to wait for something that is not coming.
// ============================================================================
import React from 'react';

export default function AccountHoldScreen({ status = 'PENDING', user, onLogout }) {
  const suspended = String(status).toUpperCase() === 'SUSPENDED';

  const tone = suspended
    ? { ring: 'rgba(255, 107, 129,0.35)', glow: 'rgba(255, 107, 129,0.18)', fg: '#fca5a5', icon: '⛔' }
    : { ring: 'rgba(255, 178, 36,0.35)', glow: 'rgba(255, 178, 36,0.18)', fg: '#fcd34d', icon: '🔒' };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 99999, background: '#0a1024',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20, fontFamily: "'Inter', system-ui, sans-serif",
      paddingBottom: 'calc(20px + env(safe-area-inset-bottom))',
    }}>
      <style>{`
        @keyframes ahsIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
        @keyframes ahsPulse { 0%,100% { box-shadow: 0 0 0 0 ${tone.glow}; } 50% { box-shadow: 0 0 0 18px transparent; } }
      `}</style>

      <div style={{
        width: '100%', maxWidth: 420, textAlign: 'center',
        background: 'rgba(18, 28, 56,0.9)', border: `1px solid ${tone.ring}`,
        borderRadius: 22, padding: '38px 28px 30px',
        boxShadow: '0 24px 70px rgba(0,0,0,0.6)', animation: 'ahsIn .35s ease-out',
      }}>
        {/* brand */}
        <div style={{
          width: 68, height: 68, margin: '0 auto 20px', borderRadius: 20,
          background: 'linear-gradient(135deg,#3b82f6,#22d3ee)',
          display: 'grid', placeItems: 'center', fontSize: 32,
          boxShadow: '0 10px 26px rgba(34, 211, 238,0.35)',
        }}>🚛</div>

        <p style={{
          margin: 0, fontSize: 10, fontWeight: 900, letterSpacing: '0.28em',
          color: '#22d3ee', textTransform: 'uppercase',
        }}>Prasad Transport</p>

        <div style={{
          width: 54, height: 54, margin: '22px auto 16px', borderRadius: '50%',
          background: tone.glow, display: 'grid', placeItems: 'center', fontSize: 24,
          animation: suspended ? 'none' : 'ahsPulse 2.4s ease-in-out infinite',
        }}>{tone.icon}</div>

        <h1 style={{
          margin: '0 0 12px', fontSize: 21, fontWeight: 900, color: '#eef3fa', lineHeight: 1.3,
        }}>
          {suspended ? 'Account Suspended' : 'Account Under Verification'}
        </h1>

        <p style={{ margin: '0 0 4px', fontSize: 13.5, color: '#9aadd4', lineHeight: 1.65 }}>
          {suspended
            ? 'Access to this account has been revoked.'
            : 'Your account has been created and is waiting for approval.'}
          <br />
          Please contact the Prasad Transport Office
          {suspended ? ' to restore access.' : ' for approval.'}
        </p>

        {user?.full_name && (
          <div style={{
            marginTop: 22, padding: '12px 14px', borderRadius: 12,
            background: 'rgba(10, 16, 36,0.6)', border: '1px solid #18244a', textAlign: 'left',
          }}>
            <Line label="Name" value={user.full_name} />
            {user.email && <Line label="Login" value={user.email} />}
            <Line label="Status" value={suspended ? 'SUSPENDED' : 'PENDING APPROVAL'} tone={tone.fg} />
          </div>
        )}

        <button
          onClick={onLogout}
          style={{
            marginTop: 22, width: '100%', padding: '11px 14px', borderRadius: 11,
            border: '1px solid #27395f', background: 'rgba(255,255,255,0.04)',
            color: '#c4d1ea', fontWeight: 800, fontSize: 12.5, cursor: 'pointer',
          }}
        >
          SIGN IN WITH A DIFFERENT ACCOUNT
        </button>
      </div>
    </div>
  );
}

const Line = ({ label, value, tone }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0' }}>
    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.07em', color: '#5d7196', textTransform: 'uppercase' }}>{label}</span>
    <span style={{ fontSize: 11.5, fontWeight: 700, color: tone ?? '#dde5f4', wordBreak: 'break-word', textAlign: 'right' }}>{value}</span>
  </div>
);
