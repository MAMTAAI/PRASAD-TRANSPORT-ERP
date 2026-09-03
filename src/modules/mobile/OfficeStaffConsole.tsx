// @ts-nocheck
// ============================================================================
// <OfficeStaffConsole /> — the [OFFICE_STAFF] / [ADMIN] environment.
// This is where the IS-BOSS doctrine is visible end to end:
//   RBACGuard wraps each module block,
//   usePermissions decides the authority level,
//   SaveButton either writes directly (boss) or feeds the approval queue.
// Admins additionally see the queue itself and can approve/reject inline.
// ============================================================================
import React, { useState } from 'react';
import {
  ClipboardList, IndianRupee, UserCog, CheckCircle2, XCircle, Hourglass,
  LogOut, Landmark, Fuel,
} from 'lucide-react';
import { GlassPanel, StatusPill, Avatar } from '../../mastercontrol/shared';
import { useAuth } from './auth/AuthProvider';
import usePermissions from './auth/usePermissions';
import RBACGuard from './auth/RBACGuard';
import SaveButton from './components/SaveButton';

const SEED_QUEUE = [
  { id: 'AQ-311', module: 'Trip Management', action: 'UPDATE', summary: 'Freight rate PT-2661: ₹48,500 → ₹52,000', requested_by: 'anjali@prasad.com', status: 'PENDING' },
  { id: 'AQ-310', module: 'Ledger & Cash Book', action: 'CREATE', summary: 'Diesel advance ₹15,000 — Driver Vijay', requested_by: 'rahul@prasad.com', status: 'PENDING' },
];

export default function OfficeStaffConsole() {
  const { user, role, logout } = useAuth();
  const perms = usePermissions('Trip Management');
  const [queue, setQueue] = useState(SEED_QUEUE);
  const [freightRate, setFreightRate] = useState('52000');
  const [fuelQty, setFuelQty] = useState('220');

  const enqueue = (item) =>
    setQueue((q) => [{ id: `AQ-${312 + q.length}`, summary: `${item.module} ${item.action}`, ...item, status: 'PENDING' }, ...q]);

  const decide = (id, status) =>
    setQueue((q) => q.map((x) => (x.id === id ? { ...x, status } : x)));

  return (
    <div className="max-w-2xl mx-auto flex flex-col gap-4 p-1">
      {/* header */}
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-3">
          <Avatar name={user?.full_name || 'Staff'} size="w-10 h-10" ring={perms.isBoss ? 'ring-red-500/50' : 'ring-cyan-500/50'} />
          <div>
            <h2 className="text-base font-black text-white">{user?.full_name || 'Office Staff'}</h2>
            <StatusPill tone={perms.isBoss ? 'red' : 'cyan'}>{role}{perms.isBoss ? ' · BOSS' : ''}</StatusPill>
          </div>
        </div>
        <button onClick={logout} className="grid place-items-center w-9 h-9 rounded-xl bg-white/5 border border-slate-700/50 text-slate-400 hover:text-red-400 transition-colors"><LogOut size={15} /></button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* module A — trip freight edit */}
        <GlassPanel className="p-4">
          <p className="flex items-center gap-2 text-[11px] font-black text-cyan-300 uppercase tracking-wider mb-2"><Landmark size={13} /> Trip Freight — PT-2661</p>
          <RBACGuard module="Trip Management">
            <label className="text-[9px] font-bold uppercase text-slate-500">Freight rate (₹)</label>
            <div className="mt-1 mb-3 flex items-center gap-1.5 rounded-xl bg-slate-950/70 border border-slate-700/50 px-3 py-2.5 focus-within:border-cyan-500/60 transition-colors">
              <IndianRupee size={13} className="text-slate-500" />
              <input value={freightRate} onChange={(e) => setFreightRate(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
                className="w-full bg-transparent text-[14px] font-bold text-slate-100 outline-none" />
            </div>
            <SaveButton
              module="Trip Management" action="UPDATE"
              payload={{ trip: 'PT-2661', field: 'freight_rate', value: freightRate }}
              onSave={() => { /* TODO: PUT /api/v1/ops/trips/PT-2661 */ }}
              onSubmitForApproval={enqueue}
              className="w-full"
            />
          </RBACGuard>
        </GlassPanel>

        {/* module B — fuel entry */}
        <GlassPanel className="p-4">
          <p className="flex items-center gap-2 text-[11px] font-black text-amber-300 uppercase tracking-wider mb-2"><Fuel size={13} /> Fuel Entry — AS 25C 9908</p>
          <RBACGuard module="Fuel & Maintenance">
            <label className="text-[9px] font-bold uppercase text-slate-500">HSD litres</label>
            <div className="mt-1 mb-3 rounded-xl bg-slate-950/70 border border-slate-700/50 px-3 py-2.5 focus-within:border-amber-500/60 transition-colors">
              <input value={fuelQty} onChange={(e) => setFuelQty(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
                className="w-full bg-transparent text-[14px] font-bold text-slate-100 outline-none" />
            </div>
            <SaveButton
              module="Fuel & Maintenance" action="CREATE"
              payload={{ vehicle: 'AS 25C 9908', litres: fuelQty }}
              onSave={() => { /* TODO: POST /api/v1/ops/fuel */ }}
              onSubmitForApproval={enqueue}
              className="w-full"
            />
          </RBACGuard>
        </GlassPanel>
      </div>

      {/* the Admin Approval Queue — bosses decide, staff watch their items */}
      <GlassPanel className="p-4 border-violet-500/30">
        <div className="flex items-center justify-between mb-3">
          <p className="flex items-center gap-2 text-[11px] font-black text-violet-300 uppercase tracking-wider"><ClipboardList size={13} /> Admin Approval Queue</p>
          <StatusPill tone="amber" pulse>{queue.filter((q) => q.status === 'PENDING').length} waiting</StatusPill>
        </div>
        <div className="flex flex-col gap-2">
          {queue.map((q) => (
            <div key={q.id} className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl bg-white/5 border border-slate-800/60 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold text-slate-100">{q.id} · <span className="text-slate-400 font-semibold">{q.module}</span></p>
                <p className="text-[10px] text-slate-500 truncate">{q.summary || JSON.stringify(q.payload)}</p>
                <p className="text-[9px] text-slate-400 flex items-center gap-1"><UserCog size={9} /> {q.requested_by}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {q.status === 'PENDING' ? (
                  perms.isBoss ? (
                    <>
                      <button onClick={() => decide(q.id, 'APPROVED')} className="flex items-center gap-1 rounded-lg border border-emerald-500/50 bg-emerald-500/15 px-2.5 py-1.5 text-[10px] font-black text-emerald-300 hover:bg-emerald-500/25 transition-colors"><CheckCircle2 size={11} /> Approve</button>
                      <button onClick={() => decide(q.id, 'REJECTED')} className="flex items-center gap-1 rounded-lg border border-red-500/50 bg-red-500/15 px-2.5 py-1.5 text-[10px] font-black text-red-300 hover:bg-red-500/25 transition-colors"><XCircle size={11} /> Reject</button>
                    </>
                  ) : <StatusPill tone="amber" pulse><Hourglass size={9} /> Awaiting boss</StatusPill>
                ) : q.status === 'APPROVED'
                  ? <StatusPill tone="green"><CheckCircle2 size={9} /> Approved</StatusPill>
                  : <StatusPill tone="red"><XCircle size={9} /> Rejected</StatusPill>}
              </div>
            </div>
          ))}
          {!queue.length && <p className="text-center text-[11px] text-slate-400 py-3">Queue is clear.</p>}
        </div>
        {/* TODO: GET/POST /api/v1/approvals — same queue PendingExpenses consumes */}
      </GlassPanel>
    </div>
  );
}
