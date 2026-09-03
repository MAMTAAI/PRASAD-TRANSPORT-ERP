// @ts-nocheck
// ============================================================================
// <MobileSuiteApp /> — the 1-App / 5-Role Super-App shell.
//
// SECURITY SHAPE: each environment below is its own React.lazy() chunk, and
// the import only ever executes INSIDE a ProtectedRoute that has already
// verified the JWT role. Vite splits these into separate files — so a phone
// logged in as DRIVER downloads DriverLiveRadar's chunk and nothing else; the
// Admin console's JS never crosses the wire to it.
// ============================================================================
import React, { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import ProtectedRoute from './auth/ProtectedRoute';
import UniversalLogin from './UniversalLogin';

// Role-isolated bundles — one chunk per environment.
// THE ARCHITECTURAL LOCK (owner, 2026-09-02): the gateway routes an outside
// party to its REAL workspace — the same apps the staff previews show — never
// to a mobile-suite stand-in. One login, four isolated portals:
//   CUSTOMER → Customer App · VENDOR → Fleet Partner or Service Vendor app
//   (VendorGate decides by vendor_kind) · DRIVER → the Driver App.
const CustomerApp = lazy(() => import('../../portal/CustomerApp'));
const VendorGate = lazy(() => import('../../portal/ServiceVendorApp').then((m) => ({ default: m.VendorGate })));
const DriverPortal = lazy(() => import('../../DriverPortal'));

const EnvLoader = () => (
  <div className="min-h-[50vh] grid place-items-center text-cyan-400">
    <span className="flex items-center gap-2 text-[12px] font-black"><Loader2 size={16} className="animate-spin" /> Loading secure environment…</span>
  </div>
);

const EXTERNAL = new Set(['CUSTOMER', 'VENDOR', 'DRIVER']);

function Router() {
  const { isAuthenticated, role, token, user, logout } = useAuth();
  // A state tick so onAuthenticated re-renders the router immediately after
  // the provider persists the session.
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  // HAND THE SESSION TO THE REAL APP. The portals read `prasad_token` (and the
  // Driver App its own two keys); the gateway keeps its own copy. Mirrored
  // before the app mounts, so its first request already carries the bearer.
  const handoff = isAuthenticated && EXTERNAL.has(role) && !!token;
  if (handoff) {
    try {
      localStorage.setItem('prasad_token', token);
      if (role === 'DRIVER') {
        localStorage.setItem('prasad_driver_token', token);
        localStorage.setItem('prasad_driver', JSON.stringify(user ?? {}));
      }
    } catch { /* private mode */ }
  }
  const signOut = useCallback(() => {
    try {
      for (const k of ['prasad_token', 'prasad_driver_token', 'prasad_driver', 'prasad_view_as_customer', 'prasad_view_as_vendor']) localStorage.removeItem(k);
    } catch { /* private mode */ }
    logout?.();
    refresh();
  }, [logout, refresh]);
  useEffect(() => { /* keeps the handoff in step with a token refresh */ }, [token, role]);

  // Gate 2 paints its own full light screen; undo the shell's dark padding.
  if (!isAuthenticated) return <div className="-m-3 sm:-m-5"><UniversalLogin onAuthenticated={refresh} /></div>;

  const exit = (
    <button onClick={signOut} title="Sign out of this workspace"
      style={{ position: 'fixed', bottom: 14, right: 14, zIndex: 10001, background: 'rgba(15,23,42,.92)', color: '#94a3b8', border: '1px solid #334155', padding: '8px 12px', borderRadius: 10, fontWeight: 900, fontSize: 11, cursor: 'pointer' }}>
      ⏻ Sign out
    </button>
  );

  return (
    <Suspense fallback={<EnvLoader />}>
      {/* STRICT SEPARATION (owner, 2026-09-03): the mobile gateway never opens
          a staff workspace. The server already refuses a staff number at
          /otp/verify (external_only); this is the belt to that brace, for a
          staff session that arrived here by any other path. */}
      {(role === 'ADMIN' || role === 'OFFICE_STAFF') && (
        <div className="grid min-h-screen place-items-center p-6 text-center">
          <div className="w-full max-w-sm rounded-3xl border border-cyan-500/40 bg-cyan-500/10 p-6">
            <p className="text-3xl">🏢</p>
            <h2 className="mt-2 text-[17px] font-black text-white">Office staff sign in on the desktop ERP</h2>
            <p className="mt-2 text-[13px] leading-relaxed text-slate-300">This mobile gateway is for drivers, vendors, customers and fleet partners only. No workspace was opened for this session.</p>
            <a href="/login" className="mt-4 block rounded-xl bg-cyan-400 px-4 py-3 text-[13px] font-black text-[#02131a]">Open the office login →</a>
            <button onClick={signOut} className="mt-2 w-full rounded-xl border border-slate-700 px-4 py-3 text-[13px] font-bold text-slate-300">Sign out</button>
          </div>
        </div>
      )}
      {role === 'DRIVER' && (
        <ProtectedRoute allowedRoles={['DRIVER']} onDenied={refresh}>
          <div style={{ margin: '-12px -12px 0', minHeight: '100vh' }}>
            <DriverPortal session={{ token, driver: user }} />
          </div>
          {exit}
        </ProtectedRoute>
      )}
      {role === 'CUSTOMER' && (
        <ProtectedRoute allowedRoles={['CUSTOMER']} onDenied={refresh}>
          {/* The Customer app (v1, 3-Sep-2026) paints its own light full-bleed
              screen and carries Logout under Account — the floating sign-out
              would sit on its bottom nav, same as the vendor app. */}
          <div style={{ margin: '-12px -12px 0', minHeight: '100vh' }}>
            <CustomerApp />
          </div>
        </ProtectedRoute>
      )}
      {role === 'VENDOR' && (
        <ProtectedRoute allowedRoles={['VENDOR']} onDenied={refresh}>
          {/* The Service Vendor app (v1, 3-Sep-2026) is light, full-bleed and
              carries its own Logout under Account — the floating sign-out
              would sit on its bottom nav. VendorGate keeps it for the Fleet
              Partner app, which still relies on it. */}
          <VendorGate exit={exit} />
        </ProtectedRoute>
      )}
    </Suspense>
  );
}

export default function MobileSuiteApp() {
  return (
    <AuthProvider>
      {/* Near-black behind a light app makes it look like a strip in a void on
          a monitor (owner, 3-Sep). A neutral ground reads as a centred
          document instead, and costs the phone nothing. */}
      {/* KEEP p-3 ON PHONES. The gates below un-pad themselves with
          `margin: -12px` so a light app can run edge to edge; drop this padding
          and that negative margin pushes the app 12 px past both edges — a
          414 px shell in a 390 px window. The two numbers are a pair. */}
      <div className="min-h-full w-full bg-[#dfe3ea] text-slate-200 p-3 sm:p-4"
        style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
        {/* keyframes shared with the master-control kit */}
        <style>{`
          @keyframes mcGlowPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
          .mc-glow-pulse { animation: mcGlowPulse 1.6s ease-in-out infinite; }
        `}</style>
        <Router />
      </div>
    </AuthProvider>
  );
}
