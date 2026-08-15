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
import React, { Suspense, lazy, useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import ProtectedRoute from './auth/ProtectedRoute';
import UniversalLogin from './UniversalLogin';

// Role-isolated bundles — one chunk per environment.
const OfficeStaffConsole = lazy(() => import('./OfficeStaffConsole'));
const DriverLiveRadar = lazy(() => import('./DriverLiveRadar'));
const CustomerLiveTracking = lazy(() => import('./CustomerLiveTracking'));
const VendorPortal = lazy(() => import('./VendorPortal'));

const EnvLoader = () => (
  <div className="min-h-[50vh] grid place-items-center text-cyan-400">
    <span className="flex items-center gap-2 text-[12px] font-black"><Loader2 size={16} className="animate-spin" /> Loading secure environment…</span>
  </div>
);

function Router() {
  const { isAuthenticated, role } = useAuth();
  // A state tick so onAuthenticated re-renders the router immediately after
  // the provider persists the session.
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  if (!isAuthenticated) return <UniversalLogin onAuthenticated={refresh} />;

  return (
    <Suspense fallback={<EnvLoader />}>
      {(role === 'ADMIN' || role === 'OFFICE_STAFF') && (
        <ProtectedRoute allowedRoles={['ADMIN', 'OFFICE_STAFF']} onDenied={refresh}>
          <OfficeStaffConsole />
        </ProtectedRoute>
      )}
      {role === 'DRIVER' && (
        <ProtectedRoute allowedRoles={['DRIVER']} onDenied={refresh}>
          <DriverLiveRadar />
        </ProtectedRoute>
      )}
      {role === 'CUSTOMER' && (
        <ProtectedRoute allowedRoles={['CUSTOMER']} onDenied={refresh}>
          <CustomerLiveTracking />
        </ProtectedRoute>
      )}
      {role === 'VENDOR' && (
        <ProtectedRoute allowedRoles={['VENDOR']} onDenied={refresh}>
          <VendorPortal />
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
