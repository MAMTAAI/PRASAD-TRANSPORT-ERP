// @ts-nocheck
// ============================================================================
// ProtectedRoute — role wall around each of the 5 isolated environments.
// Unauthenticated → onDenied() (kick to login). Wrong role → ACCESS DENIED
// panel, never the protected children. Because every environment behind this
// wall is a React.lazy() import, a device that never passes the wall never
// downloads that environment's JS chunk — a driver's phone cannot even fetch
// the Admin bundle.
// ============================================================================
import React, { useEffect } from 'react';
import { ShieldOff } from 'lucide-react';
import { useAuth } from './AuthProvider';

export default function ProtectedRoute({ allowedRoles = [], onDenied, children }) {
  const { isAuthenticated, role, logout } = useAuth();

  // Kick to /login: not a render decision but an effect — calling the
  // navigation callback during render would tear the tree mid-commit.
  useEffect(() => {
    if (!isAuthenticated && onDenied) onDenied();
  }, [isAuthenticated, onDenied]);

  if (!isAuthenticated) return null;

  if (allowedRoles.length && !allowedRoles.includes(role)) {
    return (
      <div className="min-h-[60vh] grid place-items-center p-6">
        <div className="max-w-sm w-full rounded-2xl bg-slate-900/40 backdrop-blur-md border border-red-500/40 p-8 text-center shadow-[0_0_35px_rgba(248,113,113,0.15)]">
          <ShieldOff size={40} className="mx-auto text-red-400" />
          <h2 className="mt-4 text-lg font-black text-red-300">ACCESS DENIED</h2>
          <p className="mt-2 text-[12px] text-slate-400 leading-relaxed">
            Your role <span className="font-bold text-slate-200">{role}</span> is not authorized for this
            environment. Allowed: {allowedRoles.join(', ')}.
          </p>
          <button
            onClick={logout}
            className="mt-5 w-full rounded-xl border border-slate-600/60 bg-white/5 px-4 py-2.5 text-[12px] font-bold text-slate-200 hover:bg-white/10 transition-colors"
          >
            Switch account
          </button>
        </div>
      </div>
    );
  }

  return children;
}
