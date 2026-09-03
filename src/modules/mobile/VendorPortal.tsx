// @ts-nocheck
// ============================================================================
// <VendorPortal /> — fleet partner / vendor environment.
// Credit-bill upload with camera/gallery dropzone, pending-approval ledger,
// and balance metrics. Uploads are held client-side (mock) in the exact shape
// POST /api/v1/vendor/bills will take.
// ============================================================================
import React, { useRef, useState } from 'react';
import {
  Camera, ImagePlus, FileUp, IndianRupee, Hourglass, CheckCircle2,
  XCircle, ReceiptText, LogOut, Wallet,
} from 'lucide-react';
import { GlassPanel, StatusPill, ProgressBar } from '../../mastercontrol/shared';
import { useAuth } from './auth/AuthProvider';

const METRICS = [
  { label: 'Approved Balance', value: '₹4.82 L', icon: Wallet, tone: 'text-emerald-300', ring: 'border-emerald-500/30' },
  { label: 'Under Approval', value: '₹1.26 L', icon: Hourglass, tone: 'text-amber-300', ring: 'border-amber-500/30' },
  { label: 'Paid This Month', value: '₹3.10 L', icon: IndianRupee, tone: 'text-cyan-300', ring: 'border-cyan-500/30' },
];

const INITIAL_PENDING = [
  { id: 'VB-1041', desc: 'Diesel credit — WB 02X 7890', amount: '₹42,300', date: '12 Aug', status: 'PENDING' },
  { id: 'VB-1038', desc: 'Tyre replacement — AS 18A 4531', amount: '₹28,900', date: '10 Aug', status: 'PENDING' },
  { id: 'VB-1032', desc: 'Freight share — Haldia leg', amount: '₹55,000', date: '08 Aug', status: 'APPROVED' },
  { id: 'VB-1029', desc: 'Loading labour advance', amount: '₹8,400', date: '06 Aug', status: 'REJECTED' },
];

export default function VendorPortal() {
  const { user, logout } = useAuth();
  const [bills, setBills] = useState(INITIAL_PENDING);
  const [dragOver, setDragOver] = useState(false);
  const [staged, setStaged] = useState(null); // {name, size, preview}
  const [amount, setAmount] = useState('');
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);

  const stage = (file) => {
    if (!file) return;
    setStaged({
      name: file.name, size: `${Math.max(1, Math.round(file.size / 1024))} KB`,
      preview: file.type?.startsWith('image/') ? URL.createObjectURL(file) : null,
    });
  };

  const submit = () => {
    if (!staged) return;
    // TODO: POST /api/v1/vendor/bills — multipart {file, amount}; the API
    // routes it into the same approval queue the office sees.
    setBills((b) => [{
      id: `VB-${1041 + b.length}`, desc: staged.name,
      amount: amount ? `₹${amount}` : '₹—', date: 'now', status: 'PENDING',
    }, ...b]);
    setStaged(null); setAmount('');
  };

  const statusPill = (s) =>
    s === 'APPROVED' ? <StatusPill tone="green"><CheckCircle2 size={9} /> Approved</StatusPill>
      : s === 'REJECTED' ? <StatusPill tone="red"><XCircle size={9} /> Rejected</StatusPill>
        : <StatusPill tone="amber" pulse><Hourglass size={9} /> Pending</StatusPill>;

  return (
    <div className="max-w-md mx-auto flex flex-col gap-4 p-1">
      <div className="flex items-center justify-between px-1">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-amber-400">Fleet Partner Portal</p>
          <h2 className="text-lg font-black text-white">{user?.full_name || 'Vendor'}</h2>
        </div>
        <button onClick={logout} className="grid place-items-center w-9 h-9 rounded-xl bg-white/5 border border-slate-700/50 text-slate-400 hover:text-red-400 transition-colors"><LogOut size={15} /></button>
      </div>

      {/* balance metrics */}
      <div className="grid grid-cols-3 gap-2">
        {METRICS.map((m) => (
          <GlassPanel key={m.label} className={`p-3 text-center ${m.ring}`}>
            <m.icon size={15} className={`mx-auto ${m.tone}`} />
            <p className="mt-1 text-[15px] font-black text-white">{m.value}</p>
            <p className="text-[8px] uppercase text-slate-500 leading-tight">{m.label}</p>
          </GlassPanel>
        ))}
      </div>

      {/* credit bill upload */}
      <GlassPanel className="p-4 border-amber-500/30">
        <p className="flex items-center gap-2 text-[11px] font-black text-amber-300 uppercase tracking-wider mb-3"><ReceiptText size={13} /> Upload Credit Bill</p>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); stage(e.dataTransfer.files?.[0]); }}
          className={`rounded-2xl border-2 border-dashed px-4 py-6 text-center transition-all
            ${dragOver ? 'border-amber-400/80 bg-amber-500/10' : 'border-slate-700/60 bg-slate-950/40'}`}
        >
          {staged ? (
            <div className="flex items-center gap-3 text-left">
              {staged.preview
                ? <img src={staged.preview} alt="bill" className="w-14 h-14 rounded-xl object-cover border border-slate-700/60" />
                : <span className="grid place-items-center w-14 h-14 rounded-xl bg-white/5 border border-slate-700/60"><FileUp size={20} className="text-amber-300" /></span>}
              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-bold text-slate-100 truncate">{staged.name}</p>
                <p className="text-[10px] text-slate-500">{staged.size} · staged</p>
              </div>
              <button onClick={() => setStaged(null)} className="text-slate-500 hover:text-red-400"><XCircle size={17} /></button>
            </div>
          ) : (
            <>
              <FileUp size={22} className="mx-auto text-slate-500" />
              <p className="mt-2 text-[11px] font-bold text-slate-400">Drop the bill here, or</p>
              <div className="mt-3 flex justify-center gap-2">
                <button onClick={() => cameraRef.current?.click()} className="flex items-center gap-1.5 rounded-xl border border-amber-500/50 bg-amber-500/15 px-3 py-2 text-[11px] font-black text-amber-300 hover:bg-amber-500/25 transition-colors">
                  <Camera size={13} /> Camera
                </button>
                <button onClick={() => galleryRef.current?.click()} className="flex items-center gap-1.5 rounded-xl border border-cyan-500/50 bg-cyan-500/15 px-3 py-2 text-[11px] font-black text-cyan-300 hover:bg-cyan-500/25 transition-colors">
                  <ImagePlus size={13} /> Gallery
                </button>
              </div>
            </>
          )}
          {/* capture="environment" opens the rear camera on mobile */}
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => stage(e.target.files?.[0])} />
          <input ref={galleryRef} type="file" accept="image/*,.pdf" className="hidden" onChange={(e) => stage(e.target.files?.[0])} />
        </div>

        <div className="mt-3 flex gap-2">
          <div className="flex items-center gap-1.5 flex-1 rounded-xl bg-slate-950/70 border border-slate-700/50 px-3 py-2.5 focus-within:border-amber-500/60 transition-colors">
            <IndianRupee size={13} className="text-slate-500" />
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d,]/g, ''))} placeholder="Bill amount" inputMode="numeric"
              className="w-full bg-transparent text-[13px] text-slate-100 placeholder-slate-600 outline-none" />
          </div>
          <button onClick={submit} disabled={!staged}
            className="rounded-xl bg-gradient-to-r from-amber-600 to-orange-600 px-4 py-2.5 text-[12px] font-black text-white shadow-[0_0_18px_rgba(251,191,36,0.25)] hover:brightness-110 transition-all disabled:opacity-40">
            Submit
          </button>
        </div>
        <p className="mt-2 text-[9px] text-slate-400">Bills route to the office approval queue — payment follows approval.</p>
      </GlassPanel>

      {/* pending approval list */}
      <GlassPanel className="p-4">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[10px] font-black uppercase tracking-wider text-slate-500">Bill Status</p>
          <span className="text-[9px] font-bold text-amber-400">{bills.filter((b) => b.status === 'PENDING').length} pending</span>
        </div>
        <div className="flex flex-col gap-2">
          {bills.map((b) => (
            <div key={b.id} className="flex items-center gap-3 rounded-xl bg-white/5 border border-slate-800/60 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-bold text-slate-100 truncate">{b.id} · {b.desc}</p>
                <p className="text-[9px] text-slate-500">{b.date}</p>
              </div>
              <span className="text-[12px] font-black text-white shrink-0">{b.amount}</span>
              {statusPill(b.status)}
            </div>
          ))}
        </div>
        <div className="mt-3">
          <ProgressBar pct={62} gradient="from-amber-500 to-orange-400" />
          <p className="mt-1 text-[9px] text-slate-400">Monthly credit limit used: 62% of ₹10 L</p>
        </div>
      </GlassPanel>
    </div>
  );
}
