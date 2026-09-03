// @ts-nocheck
// ============================================================================
// SaveButton — the physical embodiment of the IS-BOSS rule.
//
//   boss              → green "Save"          → onSave(payload)  (direct write)
//   staff w/ rights   → amber "Submit for Boss Approval"
//                       → onSubmitForApproval({module, action, payload,
//                          requested_by, requested_at}) for the approval queue
//   staff w/o rights  → disabled
//
// The queue payload shape matches what PendingExpenses-style approval screens
// consume; posting it is the caller's job (mock here, API later).
// ============================================================================
import React, { useState } from 'react';
import { Save, SendToBack, Ban, Check } from 'lucide-react';
import usePermissions from '../auth/usePermissions';
import { useAuth } from '../auth/AuthProvider';

export default function SaveButton({ module: moduleName, action = 'UPDATE', payload = {}, onSave, onSubmitForApproval, className = '' }) {
  const perms = usePermissions(moduleName);
  const { user } = useAuth();
  const [done, setDone] = useState(false);

  const flash = () => { setDone(true); setTimeout(() => setDone(false), 1600); };

  const allowed = action === 'CREATE' ? perms.canAdd : perms.canEdit;
  if (!perms.isBoss && !allowed) {
    return (
      <button disabled className={`flex items-center justify-center gap-2 rounded-xl border border-slate-700/50 bg-slate-800/40 px-4 py-2.5 text-[12px] font-black text-slate-400 cursor-not-allowed ${className}`}>
        <Ban size={14} /> No {action === 'CREATE' ? 'add' : 'edit'} permission
      </button>
    );
  }

  if (!perms.isBoss && perms.needsApproval) {
    return (
      <button
        onClick={() => {
          onSubmitForApproval?.({
            module: moduleName, action, payload,
            requested_by: user?.email || user?.full_name || 'staff',
            requested_at: new Date().toISOString(),
            status: 'PENDING_BOSS_APPROVAL',
          });
          flash();
        }}
        className={`flex items-center justify-center gap-2 rounded-xl border border-amber-500/50 bg-amber-500/15 px-4 py-2.5 text-[12px] font-black text-amber-300 hover:bg-amber-500/25 transition-colors shadow-[0_0_18px_rgba(251,191,36,0.15)] ${className}`}
      >
        {done ? <Check size={14} /> : <SendToBack size={14} />} {done ? 'Queued for approval' : 'Submit for Boss Approval'}
      </button>
    );
  }

  return (
    <button
      onClick={() => { onSave?.(payload); flash(); }}
      className={`flex items-center justify-center gap-2 rounded-xl border border-emerald-500/50 bg-emerald-500/15 px-4 py-2.5 text-[12px] font-black text-emerald-300 hover:bg-emerald-500/25 transition-colors shadow-[0_0_18px_rgba(52,211,153,0.15)] ${className}`}
    >
      {done ? <Check size={14} /> : <Save size={14} />} {done ? 'Saved' : 'Save'}
    </button>
  );
}
