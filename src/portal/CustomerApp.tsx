// @ts-nocheck
// ============================================================================
// CUSTOMER APP — the load provider's phone.
//
// The post-login customer surface, built to the same rules as FleetPartnerApp
// (the vendor app it mirrors): thumb-first, bottom sheets, skeletons, and
// NOTHING invented — every number on this screen came out of the API on this
// visit. The old CustomerPortal showed "24 loads / ₹1.25L escrow" as string
// literals; this app would rather show an honest empty state.
//
// WHAT A CUSTOMER CAN DO HERE, and where the server enforces it:
//   · post a load            POST /portal/customer/loads   (their id from session)
//   · watch bids come in     GET  /portal/customer/loads/:id/bids  (own loads only)
//   · accept one bid         POST /portal/customer/loads/:id/accept-bid
//                            — same reject-rest/accept-one transaction the
//                              office award uses, so a double-award cannot happen
//   · follow shipments       GET  /portal/customer/trips (+ scoped tracking)
//   · read their bills       GET  /portal/customer/bills
// ============================================================================
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Package, Gavel, Truck, ReceiptText, Plus, X, MapPin, CalendarDays,
  ShieldCheck, Clock, CheckCircle2, XCircle, Loader2, Info, Navigation,
  Zap, FileCheck2, Circle, UserRound,
} from 'lucide-react';
import { API_BASE } from '../lib/apiBase';
import ChangePasswordCard from '../ui/ChangePasswordCard';

const inr = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-IN', { maximumFractionDigits: 0 });
};
const dmy = (d) => {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }); }
  catch { return '—'; }
};

const api = async (path, opts = {}) => {
  const token = localStorage.getItem('prasad_token');
  const headers = { ...(opts.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API_BASE}/api/v1${path}`, { ...opts, headers });
  let body = null;
  try { body = await r.json(); } catch { /* empty body */ }
  return { ok: r.ok, status: r.status, body };
};

function CardSkeleton({ lines = 3 }) {
  return (
    <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-4">
      <div className="mb-3 h-3 w-24 animate-pulse rounded bg-white/10" />
      {[...Array(lines)].map((_, i) => (
        <div key={i} className="mb-2 h-2.5 animate-pulse rounded bg-white/[0.07]"
             style={{ width: `${88 - i * 18}%`, animationDelay: `${i * 90}ms` }} />
      ))}
    </div>
  );
}

function Sheet({ open, onClose, title, subtitle, children, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => ref.current?.querySelector('input,select,textarea')?.focus(), 220);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[9000] flex items-end justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm ca-fade" onClick={onClose} />
      <div ref={ref}
        className="ca-sheet relative w-full max-w-md rounded-t-[28px] border-t border-white/10
                   bg-[#0b0f18]/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-20px_60px_rgba(0,0,0,0.7)]
                   backdrop-blur-2xl">
        <div className="flex justify-center pt-2.5 pb-1"><span className="h-1 w-10 rounded-full bg-white/20" /></div>
        <div className="flex items-start gap-3 px-5 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-black tracking-tight text-white">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[12px] leading-snug text-white/45">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/5 text-white/50
                       transition-colors active:bg-white/10"><X size={17} /></button>
        </div>
        <div className="max-h-[62vh] overflow-y-auto px-5">{children}</div>
        {footer && <div className="border-t border-white/5 px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}

const STATUS = {
  PENDING_REVIEW: { t: 'text-amber-300', b: 'bg-amber-400/10 border-amber-400/25', i: Clock, l: 'Office reviewing' },
  OPEN: { t: 'text-sky-300', b: 'bg-sky-400/10 border-sky-400/25', i: Gavel, l: 'Taking bids' },
  AWARDED: { t: 'text-emerald-300', b: 'bg-emerald-400/10 border-emerald-400/25', i: CheckCircle2, l: 'Awarded' },
  CLOSED: { t: 'text-white/40', b: 'bg-white/5 border-white/10', i: XCircle, l: 'Closed' },
  CANCELLED: { t: 'text-red-300', b: 'bg-red-400/10 border-red-400/25', i: XCircle, l: 'Cancelled' },
  PENDING: { t: 'text-amber-300', b: 'bg-amber-400/10 border-amber-400/25', i: Clock, l: 'Pending' },
  ACCEPTED: { t: 'text-emerald-300', b: 'bg-emerald-400/10 border-emerald-400/25', i: CheckCircle2, l: 'Accepted' },
};
function Pill({ status }) {
  const s = STATUS[status] ?? STATUS.PENDING;
  const Icon = s.i;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5
                      text-[10px] font-bold ${s.b} ${s.t}`}><Icon size={10} /> {s.l}</span>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-white/40">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] leading-snug text-white/30">{hint}</span>}
    </label>
  );
}
const inputCls =
  'w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3.5 text-[15px] font-semibold text-white '
  + 'outline-none transition-colors placeholder:text-white/20 focus:border-sky-400/60';

// ════════════════════════════════════════════════════════════════════════════
export default function CustomerApp() {
  const [tab, setTab] = useState('loads');
  const [gate, setGate] = useState('loading');
  const [gateMsg, setGateMsg] = useState('');

  const [loads, setLoads] = useState(null);
  const [trips, setTrips] = useState(null);
  const [bills, setBills] = useState(null);

  const [posting, setPosting] = useState(false);
  const [bidsFor, setBidsFor] = useState(null);   // load row whose bids sheet is open
  const [statusFor, setStatusFor] = useState(null); // awarded load whose stepper is open
  const [trackFor, setTrackFor] = useState(null); // trip row whose tracking sheet is open
  const [toast, setToast] = useState(null);

  const flash = (msg, tone = 'ok') => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 4200);
  };

  useEffect(() => {
    (async () => {
      const r = await api('/portal/capabilities');
      if (r.status === 403 && r.body?.error === 'PORTAL_NOT_APPROVED') {
        setGate('not_approved'); setGateMsg(r.body.detail); return;
      }
      if (!r.ok) { setGate('error'); setGateMsg(r.body?.detail ?? `API ${r.status}`); return; }
      setGate('ok');
    })();
  }, []);

  const loadLoads = useCallback(async () => {
    const r = await api('/portal/customer/loads');
    setLoads(r.ok ? (r.body.loads ?? []) : []);
  }, []);
  const loadTrips = useCallback(async () => {
    const r = await api('/portal/customer/trips');
    setTrips(r.ok ? (r.body.trips ?? []) : []);
  }, []);
  const loadBills = useCallback(async () => {
    const r = await api('/portal/customer/bills');
    setBills(r.ok ? (r.body.bills ?? []) : []);
  }, []);

  useEffect(() => {
    if (gate !== 'ok') return;
    if (tab === 'loads') loadLoads();
    if (tab === 'trips') loadTrips();
    if (tab === 'bills') loadBills();
  }, [gate, tab, loadLoads, loadTrips, loadBills]);

  if (gate === 'loading') {
    return (
      <Shell tab={tab} setTab={setTab}>
        <div className="space-y-3 px-4 pt-6"><CardSkeleton /><CardSkeleton /><CardSkeleton lines={2} /></div>
      </Shell>
    );
  }
  if (gate !== 'ok') {
    return (
      <Shell tab={tab} setTab={setTab} hideNav>
        <div className="flex min-h-[70vh] flex-col items-center justify-center px-8 text-center">
          <div className="mb-5 grid h-16 w-16 place-items-center rounded-3xl border border-amber-400/25 bg-amber-400/10">
            <ShieldCheck size={28} className="text-amber-300" />
          </div>
          <h2 className="text-[19px] font-black text-white">
            {gate === 'not_approved' ? 'Awaiting office approval' : 'Cannot reach the office'}
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-white/45">{gateMsg}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell tab={tab} setTab={setTab}>
      {tab === 'loads' && (
        <div className="px-4 pt-4">
          <Header title="My Loads"
            sub={loads == null ? 'loading…' : `${loads.length} ${loads.length === 1 ? 'load' : 'loads'} posted`} />
          {loads == null && <div className="space-y-3"><CardSkeleton /><CardSkeleton /></div>}
          {loads?.length === 0 && (
            <Empty icon={Package} title="No loads yet"
              body="Post your first load below — verified fleet partners will bid on it, and every bid lands here for you to compare." />
          )}
          {loads?.map((l) => (
            <button key={l.load_id}
              onClick={() => l.status === 'AWARDED' ? setStatusFor(l) : l.status === 'OPEN' ? setBidsFor(l) : null}
              className="ca-rise mb-3 block w-full rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4 text-left
                         transition-colors active:bg-white/[0.06]">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] font-bold tracking-wider text-white/40">{l.load_id}</span>
                <Pill status={l.status} />
              </div>
              <p className="flex items-center gap-1.5 text-[14px] font-black text-white">
                <MapPin size={13} className="shrink-0 text-sky-400" />
                <span className="truncate">{l.origin}</span>
                <span className="text-white/30">→</span>
                <span className="truncate">{l.destination}</span>
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-white/45">
                {l.material && <span>{l.material}{l.weight ? ` · ${l.weight}` : ''}</span>}
                {l.loading_date && <span className="inline-flex items-center gap-1"><CalendarDays size={11} /> {dmy(l.loading_date)}</span>}
              </div>
              <div className="mt-2.5 border-t border-white/5 pt-2.5 text-[12.5px]">
                {l.status === 'AWARDED' ? (
                  <span className="font-bold text-emerald-300">
                    Awarded to {l.awarded_to} — ₹{inr(l.awarded_amount)} · tap for status
                  </span>
                ) : (
                  <span className={l.pending_bids > 0 ? 'font-bold text-sky-300' : 'text-white/35'}>
                    {l.pending_bids > 0
                      ? `${l.pending_bids} ${l.pending_bids === 1 ? 'bid' : 'bids'} waiting — tap to compare`
                      : 'No bids yet — partners have been told'}
                  </span>
                )}
              </div>
            </button>
          ))}
          <button onClick={() => setPosting(true)}
            className="fixed bottom-24 right-5 z-40 flex h-14 items-center gap-2 rounded-full bg-gradient-to-r
                       from-sky-500 to-blue-600 px-5 text-[14px] font-black text-white
                       shadow-[0_10px_30px_rgba(56,189,248,0.35)] transition-transform active:scale-95">
            <Plus size={18} /> Post Load
          </button>
        </div>
      )}

      {tab === 'trips' && (
        <div className="px-4 pt-4">
          <Header title="My Shipments" sub={trips == null ? 'loading…' : `${trips.length} on record`} />
          {trips == null && <div className="space-y-3"><CardSkeleton /><CardSkeleton /></div>}
          {trips?.length === 0 && (
            <Empty icon={Truck} title="No shipments yet"
              body="Once the office loads your consignment onto a truck, it appears here with its live status." />
          )}
          {trips?.map((t) => (
            <button key={t.trip_code} onClick={() => setTrackFor(t)}
              className="ca-rise mb-3 block w-full rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4 text-left
                         transition-colors active:bg-white/[0.06]">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="font-mono text-[11px] font-bold tracking-wider text-white/40">{t.trip_code}</span>
                <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold text-white/60">{t.status}</span>
              </div>
              <p className="text-[14px] font-black text-white">{t.vehicle_no} · {t.product_type ?? 'load'}</p>
              <p className="mt-1 text-[12px] text-white/45">
                {t.loading_point ?? '—'} {t.unloading_location ? `→ ${t.unloading_location}` : ''} · loaded {dmy(t.loading_date)}
              </p>
            </button>
          ))}
        </div>
      )}

      {tab === 'bills' && (
        <div className="px-4 pt-4">
          <Header title="Bills" sub={bills == null ? 'loading…' : `${bills.length} on record`} />
          <StatementButton path="/portal/customer/statement.pdf" />
          {bills == null && <div className="space-y-3"><CardSkeleton /><CardSkeleton /></div>}
          {bills?.length === 0 && (
            <Empty icon={ReceiptText} title="No bills yet"
              body="Invoices raised to your company appear here with their amounts and payment status." />
          )}
          {bills?.map((b, i) => (
            <div key={i} className="ca-rise mb-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] font-bold text-white/70">{b.bill_no}</span>
                <span className="text-[11px] text-white/35">{dmy(b.bill_date)}</span>
              </div>
              <div className="mt-2 flex items-end justify-between gap-2">
                <span className="text-[18px] font-black text-white">₹{inr(b.total_net)}</span>
                <span className={`text-[11px] font-bold ${Number(b.received_amount) >= Number(b.total_net) ? 'text-emerald-300' : 'text-amber-300'}`}>
                  {Number(b.received_amount) >= Number(b.total_net) ? 'PAID' : `₹${inr(b.received_amount)} received`}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'account' && (
        <div className="px-4 pt-4">
          <Header title="Account" sub="Profile Settings" />
          {/* 🔑 Self-service password change (2026-08-31 mandate) — the OTP
              goes to the mobile this account is registered with. */}
          <ChangePasswordCard />
        </div>
      )}

      <PostLoadSheet open={posting} onClose={() => setPosting(false)}
        onDone={(msg) => { setPosting(false); flash(msg); loadLoads(); }} />
      <BidsSheet load={bidsFor} onClose={() => setBidsFor(null)}
        onAccepted={(msg) => { setBidsFor(null); flash(msg); loadLoads(); }} />
      <StatusSheet load={statusFor} onClose={() => setStatusFor(null)} />
      <TrackSheet trip={trackFor} onClose={() => setTrackFor(null)} />

      {toast && (
        <div className={`ca-fade fixed left-1/2 top-5 z-[9500] w-[calc(100%-2.5rem)] max-w-sm -translate-x-1/2 rounded-2xl
                         border px-4 py-3 text-[13px] font-bold shadow-2xl backdrop-blur-xl
                         ${toast.tone === 'ok'
                           ? 'border-emerald-400/30 bg-emerald-950/90 text-emerald-100'
                           : 'border-red-400/30 bg-red-950/90 text-red-100'}`}>
          {toast.msg}
        </div>
      )}
    </Shell>
  );
}

// ── Post a load ─────────────────────────────────────────────────────────────
function PostLoadSheet({ open, onClose, onDone }) {
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const ok = (f.origin ?? '').trim() && (f.destination ?? '').trim();

  const submit = async () => {
    setBusy(true); setErr('');
    const r = await api('/portal/customer/loads', { method: 'POST', body: JSON.stringify(f) });
    setBusy(false);
    if (!r.ok) { setErr(r.body?.detail ?? `failed (${r.status})`); return; }
    setF({});
    onDone(`Load ${r.body.load.load_id} posted — partners are being notified.`);
  };

  return (
    <Sheet open={open} onClose={onClose} title="Post a new load"
      subtitle="Verified fleet partners see this and bid. You choose the winner."
      footer={
        <button onClick={submit} disabled={busy || !ok}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r
                     from-sky-500 to-blue-600 py-4 text-[15px] font-black text-white
                     shadow-[0_10px_30px_rgba(56,189,248,0.28)] transition-transform
                     active:scale-[0.98] disabled:opacity-40 disabled:shadow-none">
          {busy ? <><Loader2 size={17} className="animate-spin" /> Posting…</> : 'Post to Load Bazaar'}
        </button>
      }>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From"><input value={f.origin ?? ''} onChange={set('origin')} placeholder="Bongaigaon" className={inputCls} /></Field>
        <Field label="To"><input value={f.destination ?? ''} onChange={set('destination')} placeholder="Guwahati" className={inputCls} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Material"><input value={f.material ?? ''} onChange={set('material')} placeholder="HSD / cement / …" className={inputCls} /></Field>
        <Field label="Weight / qty"><input value={f.weight ?? ''} onChange={set('weight')} placeholder="20 MT / 12 KL" className={inputCls} /></Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Vehicle type">
          <select value={f.vehicle_type ?? ''} onChange={set('vehicle_type')} className={inputCls}>
            <option value="">Any</option>
            {['Oil Tanker', 'Trailer', 'Open Body', 'Container', 'Tipper'].map((o) => <option key={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Loading date">
          <input type="date" value={f.loading_date ?? ''} onChange={set('loading_date')} className={inputCls} style={{ colorScheme: 'dark' }} />
        </Field>
      </div>
      <Field label="Target rate (optional)" hint="Kept with the office — partners never see it. It anchors what the office accepts.">
        <input type="number" inputMode="numeric" value={f.target_rate ?? ''} onChange={set('target_rate')}
               placeholder="₹" className={inputCls} />
      </Field>
      <Field label="Book-Now rate (optional)"
        hint="This one IS shown to every partner: any verified partner can take the load instantly at this price — no waiting for bids.">
        <input type="number" inputMode="numeric" value={f.book_now_rate ?? ''} onChange={set('book_now_rate')}
               placeholder="₹" className={inputCls} />
      </Field>
      <Field label="Bidding closes in" hint="After the clock runs out no new bids land; you pick from what came.">
        <select value={f.bid_close_hours ?? ''} onChange={set('bid_close_hours')} className={inputCls}>
          <option value="">No time limit</option>
          <option value="4">4 hours</option>
          <option value="12">12 hours</option>
          <option value="24">24 hours</option>
          <option value="48">2 days</option>
          <option value="96">4 days</option>
        </select>
      </Field>
      {err && <p className="mb-2 text-[12px] font-semibold text-red-400">{err}</p>}
    </Sheet>
  );
}

// ── Shipment status — the settlement stepper on an awarded load ─────────────
// Every station is a fact the server reported; the customer's view carries no
// vendor money (that is the office's cost side), only progress and the truck.
const STEPS = [
  ['CONFIRMED', 'Partner confirmed the trip'],
  ['VEHICLE_ASSIGNED', 'Truck & driver assigned'],
  ['ADVANCE_PAID', 'Loading & dispatch'],
  ['POD_SUBMITTED', 'Delivered — proof received'],
  ['POD_VERIFIED', 'Proof verified by office'],
  ['SETTLED', 'Trip completed & closed'],
];
const STEP_ORDER = ['AWAITING_CONFIRM', ...STEPS.map(([k]) => k)];

function StatusSheet({ load, onClose }) {
  const [s, setS] = useState(undefined);   // undefined=loading, null=none

  useEffect(() => {
    if (!load) return;
    setS(undefined);
    (async () => {
      const r = await api(`/portal/customer/loads/${encodeURIComponent(load.load_id)}/settlement`);
      setS(r.ok ? (r.body.settlement ?? null) : null);
    })();
  }, [load]);

  if (!load) return null;
  const reached = s && s.status !== 'CANCELLED' ? STEP_ORDER.indexOf(s.status) : -1;

  return (
    <Sheet open={!!load} onClose={onClose}
      title={`Shipment — ${load.load_id}`}
      subtitle={`${load.origin} → ${load.destination}`}>
      {s === undefined && <CardSkeleton lines={4} />}
      {s === null && (
        <Empty icon={Truck} title="Status not started"
          body="The award is recorded; the office opens the trip lifecycle next. Check back shortly." />
      )}
      {s && (
        <>
          <div className="mb-4 rounded-2xl border border-emerald-400/20 bg-emerald-400/[0.06] px-4 py-3">
            <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-300/60">Awarded to</p>
            <p className="mt-0.5 text-[15px] font-black text-white">{s.vendor_name}</p>
            <p className="text-[12.5px] font-bold text-emerald-300">₹{inr(s.awarded_amount)}</p>
            {(s.vehicle_reg || s.driver_name) && (
              <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-white/60">
                <Truck size={12} className="text-emerald-400" />
                {s.vehicle_reg ?? 'truck TBD'}{s.driver_name ? ` · ${s.driver_name}` : ''}
                {s.driver_mobile ? ` · ${s.driver_mobile}` : ''}
              </p>
            )}
          </div>

          {s.status === 'CANCELLED' ? (
            <p className="mb-4 rounded-2xl border border-red-400/20 bg-red-400/[0.07] px-4 py-3
                          text-[12.5px] leading-relaxed text-red-200/80">
              This award was cancelled{s.cancel_reason ? ` — ${s.cancel_reason}` : ''}. The load reopened
              for fresh bids; you will see new offers under it.
            </p>
          ) : (
            <div className="mb-4">
              {STEPS.map(([key, label], i) => {
                const idx = STEP_ORDER.indexOf(key);
                const done = reached >= idx;
                const current = reached === idx - 1;
                return (
                  <div key={key} className="flex gap-3">
                    <div className="flex flex-col items-center">
                      {done
                        ? <CheckCircle2 size={18} className="text-emerald-400" />
                        : current
                          ? <Clock size={18} className="text-amber-300" />
                          : <Circle size={18} className="text-white/15" />}
                      {i < STEPS.length - 1 && (
                        <span className={`my-0.5 w-px flex-1 ${done ? 'bg-emerald-400/40' : 'bg-white/10'}`}
                              style={{ minHeight: 14 }} />
                      )}
                    </div>
                    <p className={`pb-3 text-[13px] leading-snug
                        ${done ? 'font-bold text-white' : current ? 'font-bold text-amber-200' : 'text-white/35'}`}>
                      {label}
                      {key === 'POD_SUBMITTED' && s.pod_submitted_at && done &&
                        <span className="block text-[11px] font-normal text-white/40">{dmy(s.pod_submitted_at)}</span>}
                      {key === 'POD_VERIFIED' && s.pod_verified_at && done &&
                        <span className="block text-[11px] font-normal text-white/40">{dmy(s.pod_verified_at)}</span>}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {s.pod_file && <PodLink podKey={s.pod_file} />}
        </>
      )}
      <div className="pb-4" />
    </Sheet>
  );
}

// ── Bids on one load ────────────────────────────────────────────────────────
function BidsSheet({ load, onClose, onAccepted }) {
  const [bids, setBids] = useState(null);
  const [confirming, setConfirming] = useState(null);  // bid being confirmed
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!load) return;
    setBids(null); setConfirming(null); setErr('');
    (async () => {
      const r = await api(`/portal/customer/loads/${load.load_id}/bids`);
      setBids(r.ok ? (r.body.bids ?? []) : []);
    })();
  }, [load]);

  const accept = async (bid) => {
    setBusy(true); setErr('');
    const r = await api(`/portal/customer/loads/${load.load_id}/accept-bid`,
      { method: 'POST', body: JSON.stringify({ bid_id: bid.id }) });
    setBusy(false);
    if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `failed (${r.status})`); return; }
    onAccepted(`${bid.vendor_name} ko award ho gaya — ₹${inr(bid.bid_amount)}. Office agla step karega.`);
  };

  return (
    <Sheet open={!!load} onClose={onClose}
      title={load ? `Bids — ${load.load_id}` : ''}
      subtitle={load ? `${load.origin} → ${load.destination}. Lowest first; accepting one closes the rest.` : ''}>
      {bids == null && <div className="space-y-3 pb-4"><CardSkeleton lines={2} /><CardSkeleton lines={2} /></div>}
      {bids?.length === 0 && (
        <Empty icon={Gavel} title="No bids yet"
          body="Partners have been notified. Bids land here the moment they come in." />
      )}
      {bids?.map((b, i) => (
        <div key={b.id} className={`mb-3 rounded-2xl border p-4 ${b.status === 'ACCEPTED'
          ? 'border-emerald-400/30 bg-emerald-400/[0.06]'
          : 'border-white/[0.07] bg-white/[0.03]'}`}>
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-[13.5px] font-black text-white">{b.vendor_name}</p>
              <p className="text-[11px] text-white/35">{i === 0 && b.status === 'PENDING' ? 'Lowest offer · ' : ''}{dmy(b.created_at)}</p>
            </div>
            <p className="text-[18px] font-black text-white">₹{inr(b.bid_amount)}</p>
          </div>
          {b.remarks && <p className="mt-1.5 text-[12px] italic text-white/40">“{b.remarks}”</p>}
          {b.status === 'PENDING' && load?.status === 'OPEN' && (
            confirming === b.id ? (
              <div className="mt-3 flex gap-2">
                <button onClick={() => accept(b)} disabled={busy}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-500 py-2.5
                             text-[13px] font-black text-white active:scale-[0.98] disabled:opacity-40">
                  {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Confirm award
                </button>
                <button onClick={() => setConfirming(null)} disabled={busy}
                  className="rounded-xl border border-white/10 px-4 text-[13px] font-bold text-white/50">Back</button>
              </div>
            ) : (
              <button onClick={() => setConfirming(b.id)}
                className="mt-3 w-full rounded-xl border border-emerald-400/30 bg-emerald-400/10 py-2.5
                           text-[13px] font-black text-emerald-300 active:bg-emerald-400/20">
                Accept this bid
              </button>
            )
          )}
          {b.status === 'ACCEPTED' && (
            <p className="mt-2 text-[11.5px] font-bold text-emerald-300">✓ Awarded — the office takes it from here.</p>
          )}
        </div>
      ))}
      {err && <p className="mb-3 text-[12px] font-semibold text-red-400">{err}</p>}
      <div className="pb-4" />
    </Sheet>
  );
}

// Full account statement as a server-built PDF — FY to date, ledger + bills +
// totals. Fetched with the bearer token, saved via a blob link.
function StatementButton({ path }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const token = localStorage.getItem('prasad_token');
      const r = await fetch(`${API_BASE}/api/v1${path}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) return;
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'account-statement.pdf';
      a.click();
      URL.revokeObjectURL(a.href);
    } finally { setBusy(false); }
  };
  return (
    <button onClick={download} disabled={busy}
      className="mb-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-sky-400/30
                 bg-sky-400/10 py-3 text-[13px] font-black text-sky-300 disabled:opacity-40">
      {busy ? <Loader2 size={15} className="animate-spin" /> : <ReceiptText size={15} />}
      Download full statement (PDF)
    </button>
  );
}

// A plain <a href> would arrive without the bearer token and 401 — so the POD
// is fetched with the token and opened as a blob URL.
function PodLink({ podKey }) {
  const [busy, setBusy] = useState(false);
  const open = async () => {
    setBusy(true);
    try {
      const token = localStorage.getItem('prasad_token');
      const r = await fetch(`${API_BASE}/api/v1/files/${podKey}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!r.ok) return;
      const blob = await r.blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } finally { setBusy(false); }
  };
  return (
    <button onClick={open} disabled={busy}
      className="mb-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-violet-400/30
                 bg-violet-400/10 py-3 text-[13px] font-black text-violet-300 disabled:opacity-40">
      {busy ? <Loader2 size={15} className="animate-spin" /> : <FileCheck2 size={15} />} View proof of delivery
    </button>
  );
}

// ── Where is my shipment ────────────────────────────────────────────────────
function TrackSheet({ trip, onClose }) {
  const [pos, setPos] = useState(undefined);   // undefined=loading, null=no fix

  useEffect(() => {
    if (!trip) return;
    setPos(undefined);
    (async () => {
      const r = await api(`/portal/customer/trips/${encodeURIComponent(trip.trip_code)}/tracking`);
      setPos(r.ok ? (r.body.position ?? null) : null);
    })();
  }, [trip]);

  return (
    <Sheet open={!!trip} onClose={onClose}
      title={trip ? `${trip.vehicle_no}` : ''} subtitle={trip ? `${trip.trip_code} · ${trip.status}` : ''}>
      {pos === undefined && <CardSkeleton lines={2} />}
      {pos === null && (
        <Empty icon={Navigation} title="Position not reported yet"
          body="The truck has not sent a live position for this trip. The office can still tell you where it is — this screen never invents a location." />
      )}
      {pos && (
        <div className="mb-4 rounded-2xl border border-sky-400/20 bg-sky-400/[0.06] p-4">
          <p className="text-[12px] font-bold uppercase tracking-wider text-sky-300">Last reported</p>
          <p className="mt-1 text-[15px] font-black text-white">
            {pos.checkpoint ?? `${Number(pos.lat).toFixed(4)}, ${Number(pos.lng).toFixed(4)}`}
          </p>
          <p className="mt-1 text-[12px] text-white/45">
            {new Date(pos.recorded_at).toLocaleString('en-IN')} · via {pos.source === 'FASTAG' ? 'toll plaza' : pos.source === 'DRIVER_APP' ? 'driver app' : 'GPS'}
            {pos.speed_kmh != null ? ` · ${Math.round(pos.speed_kmh)} km/h` : ''}
          </p>
          <a target="_blank" rel="noreferrer"
             href={`https://maps.google.com/?q=${pos.lat},${pos.lng}`}
             className="mt-3 flex items-center justify-center gap-2 rounded-xl border border-sky-400/30 bg-sky-400/10
                        py-2.5 text-[13px] font-black text-sky-300">
            <MapPin size={14} /> Open in Google Maps
          </a>
        </div>
      )}
      <div className="pb-4" />
    </Sheet>
  );
}

// ── layout ──────────────────────────────────────────────────────────────────
function Shell({ children, tab, setTab, hideNav = false }) {
  return (
    <div className="min-h-screen bg-[#070a11] pb-24 text-white"
         style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`
        @keyframes caRise { from { opacity:0; transform: translateY(10px); } to { opacity:1; transform:none; } }
        .ca-rise { animation: caRise .28s cubic-bezier(.22,1,.36,1); }
        @keyframes caSheet { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .ca-sheet { animation: caSheet .32s cubic-bezier(.22,1,.36,1); }
        @keyframes caFade { from { opacity:0; } to { opacity:1; } }
        .ca-fade { animation: caFade .2s ease-out; }
        @media (prefers-reduced-motion: reduce) { .ca-rise, .ca-sheet, .ca-fade { animation: none; } }
        .ca-sheet input, .ca-sheet select { font-size: 16px; }
      `}</style>
      <div className="mx-auto max-w-md">{children}</div>
      {!hideNav && (
        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.07] bg-[#0b0f18]/95
                        pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl">
          <div className="mx-auto flex max-w-md">
            {[['loads', Package, 'Loads'], ['trips', Truck, 'Shipments'], ['bills', ReceiptText, 'Bills'], ['account', UserRound, 'Account']].map(([id, Icon, label]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`flex flex-1 flex-col items-center gap-1 py-3 text-[10.5px] font-bold transition-colors
                            ${tab === id ? 'text-sky-400' : 'text-white/35'}`}>
                <Icon size={20} /> {label}
              </button>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}

function Header({ title, sub }) {
  return (
    <div className="mb-3">
      <h1 className="text-[22px] font-black tracking-tight text-white">{title}</h1>
      {sub && <p className="text-[12.5px] text-white/40">{sub}</p>}
    </div>
  );
}

function Empty({ icon: Icon, title, body }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[0.03]">
        <Icon size={24} className="text-white/25" />
      </div>
      <p className="text-[15px] font-black text-white/70">{title}</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-white/35">{body}</p>
    </div>
  );
}
