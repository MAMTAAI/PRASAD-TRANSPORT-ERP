// @ts-nocheck
// ============================================================================
// RBACGuard — wraps a piece of staff UI in the module's permission envelope.
// No view right → the content is not rendered at all. Non-boss with write
// rights sees an amber "approval mode" strip so it is never a surprise that
// their Save became "Submit for Boss Approval".
// ============================================================================
import React from 'react';
import { Lock, ShieldCheck, Hourglass } from 'lucide-react';
import usePermissions from './usePermissions';

export default function RBACGuard({ module: moduleName, children }) {
  const perms = usePermissions(moduleName);

  if (!perms.canView) {
    return (
      <div className="rounded-2xl bg-slate-900/40 backdrop-blur-md border border-slate-700/50 p-6 text-center">
        <Lock size={22} className="mx-auto text-slate-500" />
        <p className="mt-2 text-[12px] font-bold text-slate-400">
          No view permission for <span className="text-slate-200">{moduleName}</span>
        </p>
        <p className="text-[10px] text-slate-400">Ask an Admin to grant access in UGER.</p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className={`flex items-center gap-1.5 mb-2 text-[10px] font-black uppercase tracking-wider ${perms.isBoss ? 'text-emerald-400' : 'text-amber-400'}`}>
        {perms.isBoss
          ? (<><ShieldCheck size={11} /> Boss authority — direct writes</>)
          : (<><Hourglass size={11} /> Approval mode — edits route to Admin queue</>)}
      </div>
      {typeof children === 'function' ? children(perms) : children}
    </div>
  );
}
