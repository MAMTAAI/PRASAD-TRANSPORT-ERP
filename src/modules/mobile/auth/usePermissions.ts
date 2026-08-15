// @ts-nocheck
// ============================================================================
// usePermissions(moduleName) — the "IS BOSS" doctrine for [OFFICE_STAFF].
//
//   canView / canAdd / canEdit  granular flags from the user's permission rows
//   isBoss                      ADMIN & SUPER_ADMIN — writes go straight to DB
//   needsApproval               staff with edit rights but no boss authority:
//                               their writes become approval-queue payloads
//
// The permission rows come from the real users.permissions jsonb
// (see /api/v1/auth — permsOut). Shape: [{name, view, add, edit}].
// ============================================================================
import { useMemo } from 'react';
import { useAuth } from './AuthProvider';

export default function usePermissions(moduleName) {
  const { user, role } = useAuth();

  return useMemo(() => {
    const isBoss = role === 'ADMIN'; // normalizeRole folds SUPER_ADMIN in here

    // Bosses hold every permission implicitly — a module missing from their
    // rows must never silently lock them out (same bug class App.tsx fixed).
    if (isBoss) {
      return { canView: true, canAdd: true, canEdit: true, isBoss: true, needsApproval: false, role };
    }

    const row = (user?.permissions || []).find(
      (p) => String(p?.name || '').toLowerCase() === String(moduleName || '').toLowerCase()
    );

    const canView = !!row?.view;
    const canAdd = !!row?.add;
    const canEdit = !!row?.edit;

    return {
      canView, canAdd, canEdit,
      isBoss: false,
      // Any write authority held by a non-boss is exercised THROUGH the
      // approval queue — the write itself is the boss's to commit.
      needsApproval: canAdd || canEdit,
      role,
    };
  }, [user, role, moduleName]);
}
