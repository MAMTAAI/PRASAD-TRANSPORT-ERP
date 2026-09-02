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
const OfficeStaffConsole = lazy(() => import('./OfficeStaffConsole'));
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

  if (!isAuthenticated) return <UniversalLogin onAuthenticated={refresh} />;

  const exit = (
    <button onClick={signOut} title="Sign out of this workspace"
      style={{ position: 'fixed', bottom: 14, right: 14, zIndex: 10001, background: 'rgba(15,23,42,.92)', color: '#94a3b8', border: '1px solid #334155', padding: '8px 12px', borderRadius: 10, fontWeight: 900, fontSize: 11, cursor: 'pointer' }}>
      ⏻ Sign out
    </button>
  );

  return (
    <Suspense fallback={<EnvLoader />}>
      {(role === 'ADMIN' || role === 'OFFICE_STAFF') && (
        <ProtectedRoute allowedRoles={['ADMIN', 'OFFICE_STAFF']} onDenied={refresh}>
          <OfficeStaffConsole />
        </ProtectedRoute>
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
          <CustomerApp />
          {exit}
        </ProtectedRoute>
      )}
      {role === 'VENDOR' && (
        <ProtectedRoute allowedRoles={['VENDOR']} onDenied={refresh}>
          <VendorGate />
          {exit}
        </ProtectedRoute>
      )}
    </Suspense>
  );
}

export default function MobileSuiteApp() {
  return (
    <AuthProvider>
      <div className="min-h-full w-full bg-[#080c14] text-slate-200 p-3 sm:p-5"
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
