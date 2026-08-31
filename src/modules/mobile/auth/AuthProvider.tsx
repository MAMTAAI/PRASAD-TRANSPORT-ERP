// @ts-nocheck
// ============================================================================
// AuthProvider — JWT + global user state for the 1-App / 5-Role architecture.
//
// Talks to the REAL auth API (server/modules/auth.routes.js):
//   POST /api/v1/auth/login        {email, password}      → staff session
//   POST /api/v1/auth/otp/request  {mobile}               → WhatsApp OTP
//   POST /api/v1/auth/otp/verify   {mobile, code}         → staff OR driver session
//   GET  /api/v1/auth/me           Bearer                 → session check
//
// DEMO fallback: if the API is unreachable (previewing the suite without the
// backend) the provider drops into mock mode — OTP is 123456 and the role is
// inferred from the identifier — so the UI is always demonstrable.
// ============================================================================
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';

import { API_BASE } from '../../../lib/apiBase';
const API = API_BASE;
const TOKEN_KEY = 'pt_mobile_token';
const USER_KEY = 'pt_mobile_user';

export const ROLES = ['ADMIN', 'OFFICE_STAFF', 'CUSTOMER', 'VENDOR', 'DRIVER'];

// Server roles → the 5 app environments. SUPER_ADMIN is the boss of bosses.
export function normalizeRole(raw) {
  const r = String(raw || '').toUpperCase();
  if (r === 'SUPER_ADMIN' || r === 'ADMIN') return 'ADMIN';
  if (r === 'DRIVER') return 'DRIVER';
  if (r === 'CUSTOMER') return 'CUSTOMER';
  if (r === 'VENDOR' || r === 'FLEET_PARTNER') return 'VENDOR';
  return 'OFFICE_STAFF'; // VIEWER / STAFF / anything granular
}

export function decodeJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
  } catch { return null; }
}

const AuthContext = createContext(null);

async function api(path, body, token) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const res = await fetch(`${API}/api/v1/auth${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, ...j };
  } finally { clearTimeout(t); }
}

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
  });
  const [demoMode, setDemoMode] = useState(false);

  // Session guard: a stored token is only trusted after /me confirms it. An
  // expired exp claim is rejected locally without a round-trip.
  useEffect(() => {
    if (!token) return;
    const claims = decodeJwt(token);
    if (claims?.exp && claims.exp * 1000 < Date.now()) { logout(); return; }
    if (String(user?.email || '').endsWith('@demo')) { setDemoMode(true); return; }
    (async () => {
      try {
        const me = await api('/me', null, token);
        if (!me.ok && me.status !== 503) logout(); // 503 = DB down, keep session
      } catch { /* network blip — keep session */ }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = useCallback((tok, usr) => {
    setToken(tok); setUser(usr);
    if (tok) localStorage.setItem(TOKEN_KEY, tok); else localStorage.removeItem(TOKEN_KEY);
    if (usr) localStorage.setItem(USER_KEY, JSON.stringify(usr)); else localStorage.removeItem(USER_KEY);
  }, []);

  const loginPassword = useCallback(async (email, password) => {
    try {
      const r = await api('/login', { email, password });
      // The 2026-08-31 mandate: a correct password answers otp_required and
      // withholds the token until verifyLogin2fa presents the code that went
      // to the registered mobile.
      if (r.ok && r.otp_required) {
        return { ok: true, otpRequired: true, mobile: r.mobile, ttl: r.expires_in_minutes ?? 5 };
      }
      if (r.ok && r.token) {
        const usr = { ...(r.user || {}), role: normalizeRole(r.user?.role) };
        persist(r.token, usr);
        return { ok: true, role: usr.role };
      }
      return { ok: false, error: r.error || `login failed (${r.status})` };
    } catch {
      return demoLogin(email); // API unreachable → demo
    }
  }, [persist]);

  // The second half of a staff password login: /login/verify mints the session
  // the password stage withheld. Bound to the email, not the bare mobile, so a
  // code issued for one account cannot finish a login for another.
  const verifyLogin2fa = useCallback(async (email, code) => {
    try {
      const r = await api('/login/verify', { email, code });
      if (r.ok && r.token) {
        const usr = { ...(r.user || {}), role: normalizeRole(r.user?.role) };
        persist(r.token, usr);
        return { ok: true, role: usr.role };
      }
      return { ok: false, error: r.error || `verify failed (${r.status})` };
    } catch {
      return { ok: false, error: 'network' };
    }
  }, [persist]);

  const requestOtp = useCallback(async (mobile) => {
    try {
      const r = await api('/otp/request', { mobile });
      if (r.ok) return { ok: true, channel: r.channel, ttl: r.expires_in_minutes };
      return { ok: false, error: r.error, detail: r.detail };
    } catch {
      setDemoMode(true);
      return { ok: true, channel: 'demo', ttl: 5, demo: true }; // OTP is 123456
    }
  }, []);

  const verifyOtp = useCallback(async (mobile, code) => {
    if (demoMode) return demoLogin(mobile, code);
    try {
      const r = await api('/otp/verify', { mobile, code });
      if (r.ok && r.token) {
        const source = r.user || r.driver || {};
        const usr = { ...source, role: normalizeRole(r.role || r.user?.role || 'DRIVER') };
        persist(r.token, usr);
        return { ok: true, role: usr.role };
      }
      return { ok: false, error: r.error || `verify failed (${r.status})` };
    } catch {
      return demoLogin(mobile, code);
    }
  }, [demoMode, persist]);

  // Preview without a backend: role from the identifier's first char so every
  // environment is reachable (1x…=DRIVER 2x…=CUSTOMER 3x…=VENDOR 4x…=STAFF
  // anything else=ADMIN). Real API always wins when it answers.
  const demoLogin = useCallback((id, code = '123456') => {
    if (String(code).replace(/\D/g, '') !== '123456') return { ok: false, error: 'OTP_INVALID (demo: 123456)' };
    const first = String(id || '')[0];
    const role = first === '1' ? 'DRIVER' : first === '2' ? 'CUSTOMER' : first === '3' ? 'VENDOR' : first === '4' ? 'OFFICE_STAFF' : 'ADMIN';
    // Demo staff carries realistic granular rows so the approval-mode
    // SaveButton is visible; a real login always uses the DB's rows.
    const permissions = role === 'OFFICE_STAFF'
      ? [
        { name: 'Trip Management', view: true, add: false, edit: true },
        { name: 'Fuel & Maintenance', view: true, add: true, edit: false },
      ]
      : [];
    const usr = { full_name: `Demo ${role}`, email: `${role.toLowerCase()}@demo`, role, permissions };
    setDemoMode(true);
    persist(`demo.${btoa(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 }))}.x`, usr);
    return { ok: true, role, demo: true };
  }, [persist]);

  const logout = useCallback(() => {
    const tok = localStorage.getItem(TOKEN_KEY);
    if (tok && !tok.startsWith('demo.')) {
      fetch(`${API}/api/v1/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, keepalive: true }).catch(() => {});
    }
    persist(null, null);
    setDemoMode(false);
  }, [persist]);

  const value = useMemo(() => ({
    token, user, role: user?.role || null, isAuthenticated: !!token && !!user,
    demoMode, loginPassword, verifyLogin2fa, requestOtp, verifyOtp, logout,
  }), [token, user, demoMode, loginPassword, verifyLogin2fa, requestOtp, verifyOtp, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
