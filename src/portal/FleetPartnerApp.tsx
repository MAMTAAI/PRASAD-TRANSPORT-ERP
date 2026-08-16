// @ts-nocheck
// ============================================================================
// FLEET PARTNER APP — the vendor's phone.
//
// BUILT FOR A THUMB IN A TRUCK CAB. Every primary action is a full-width target
// at the bottom of the screen, where a thumb already is; nothing important sits
// in a corner. Type sizes start at 13px because this is read in daylight
// through a windscreen, not on a desk.
//
// THE BID SHEET IS A BOTTOM SHEET, not a centred dialog. A modal in the middle
// of a phone screen puts the keyboard over the input and the confirm button
// under the keyboard. A sheet that rises from the bottom keeps the amount and
// the confirm together above the keyboard, which is the only arrangement that
// works one-handed.
//
// BLIND BIDDING IS SAID OUT LOUD. The board shows how many partners have bid and
// never what they bid — and the sheet says so, because a partner who suspects
// the screen is hiding a number will assume the worst about the auction. The
// server enforces it regardless (v_bazaar_load_feed carries no amounts); this is
// the part that makes it believable.
//
// EVERY WRITE LANDS IN PENDING. Trucks, drivers and bids all go to the office's
// approval desk, and the UI never shows a submitted thing as live. Showing a
// pending truck as active is how a partner sends it to a loading point that is
// not expecting it.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Gavel, Truck, Wallet, Plus, X, MapPin, Package, CalendarDays, Users,
  ShieldCheck, Clock, CheckCircle2, XCircle, Loader2, ArrowRight, Upload, Info,
} from 'lucide-react';
import { API_BASE } from '../lib/apiBase';

// ── money & dates ───────────────────────────────────────────────────────────
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

// ── skeletons ───────────────────────────────────────────────────────────────
// A skeleton in the SHAPE of the card that is coming, so the page does not jump
// when it arrives. A spinner tells you to wait; this tells you what for.
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

// ── bottom sheet ────────────────────────────────────────────────────────────
function Sheet({ open, onClose, title, subtitle, children, footer }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus the first input so the keyboard opens without a second tap.
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
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm fp-fade" onClick={onClose} />
      <div
        ref={ref}
        className="fp-sheet relative w-full max-w-md rounded-t-[28px] border-t border-white/10
                   bg-[#0b0f18]/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-20px_60px_rgba(0,0,0,0.7)]
                   backdrop-blur-2xl"
      >
        {/* grab handle — the affordance that says this can be dragged/dismissed */}
        <div className="flex justify-center pt-2.5 pb-1">
          <span className="h-1 w-10 rounded-full bg-white/20" />
        </div>
        <div className="flex items-start gap-3 px-5 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-black tracking-tight text-white">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[12px] leading-snug text-white/45">{subtitle}</p>}
          </div>
          <button onClick={onClose} aria-label="Close"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/5 text-white/50
                       transition-colors active:bg-white/10">
            <X size={17} />
          </button>
        </div>
        <div className="max-h-[62vh] overflow-y-auto px-5">{children}</div>
        {footer && <div className="border-t border-white/5 px-5 py-4">{footer}</div>}
      </div>
    </div>
  );
}

// ── shared bits ─────────────────────────────────────────────────────────────
const STATUS = {
  'PENDING APPROVAL': { t: 'text-amber-300', b: 'bg-amber-400/10 border-amber-400/25', i: Clock, l: 'Awaiting office' },
  'System Active': { t: 'text-emerald-300', b: 'bg-emerald-400/10 border-emerald-400/25', i: CheckCircle2, l: 'Approved' },
  BLOCKED: { t: 'text-red-300', b: 'bg-red-400/10 border-red-400/25', i: XCircle, l: 'Blocked' },
  REJECTED: { t: 'text-red-300', b: 'bg-red-400/10 border-red-400/25', i: XCircle, l: 'Rejected' },
  PENDING: { t: 'text-amber-300', b: 'bg-amber-400/10 border-amber-400/25', i: Clock, l: 'Pending' },
  ACCEPTED: { t: 'text-emerald-300', b: 'bg-emerald-400/10 border-emerald-400/25', i: CheckCircle2, l: 'Won' },
  WITHDRAWN: { t: 'text-white/40', b: 'bg-white/5 border-white/10', i: XCircle, l: 'Withdrawn' },
};

function Pill({ status }) {
  const s = STATUS[status] ?? STATUS.PENDING;
  const Icon = s.i;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5
                      text-[10px] font-bold ${s.b} ${s.t}`}>
      <Icon size={10} /> {s.l}
    </span>
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
  + 'outline-none transition-colors placeholder:text-white/20 focus:border-cyan-400/60';

// ── document upload with a skeleton while it flies ──────────────────────────
function DocUpload({ label, value, onUploaded, hint }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const id = useMemo(() => `up-${Math.random().toString(36).slice(2)}`, []);

  const pick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('path', `partner-docs/${Date.now()}-${file.name}`);
      const token = localStorage.getItem('prasad_token');
      const r = await fetch(`${API_BASE}/api/v1/files`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) { setErr(j?.detail ?? `upload failed (${r.status})`); return; }
      onUploaded(j.key ?? j.path ?? j.url ?? '');
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="mb-3">
      <span className="mb-1.5 block text-[11px] font-bold uppercase tracking-wider text-white/40">{label}</span>
      {busy ? (
        // The skeleton occupies exactly the button's box, so nothing reflows
        // when the upload lands.
        <div className="flex h-[52px] items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4">
          <Loader2 size={16} className="animate-spin text-cyan-400" />
          <div className="h-2.5 flex-1 animate-pulse rounded bg-white/10" />
        </div>
      ) : value ? (
        <div className="flex h-[52px] items-center gap-3 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-4">
          <CheckCircle2 size={17} className="text-emerald-400" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-bold text-emerald-200">Uploaded</span>
          <button onClick={() => onUploaded('')} className="text-[12px] font-bold text-white/40">Change</button>
        </div>
      ) : (
        <>
          <input id={id} type="file" accept="image/*,application/pdf" capture="environment"
                 onChange={pick} className="sr-only" />
          <label htmlFor={id}
            className="flex h-[52px] cursor-pointer items-center justify-center gap-2 rounded-2xl border
                       border-dashed border-white/15 bg-white/[0.03] text-[13px] font-bold text-white/50
                       transition-colors active:bg-white/[0.07]">
            <Upload size={16} /> Take photo or choose file
          </label>
        </>
      )}
      {hint && !value && <span className="mt-1 block text-[11px] text-white/30">{hint}</span>}
      {err && <span className="mt-1 block text-[11px] font-semibold text-red-400">{err}</span>}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
export default function FleetPartnerApp() {
  const [tab, setTab] = useState('board');
  const [gate, setGate] = useState('loading');   // loading | ok | not_approved | error
  const [gateMsg, setGateMsg] = useState('');
  const [caps, setCaps] = useState({});

  const [loads, setLoads] = useState(null);
  const [targetVisible, setTargetVisible] = useState(false);
  const [bids, setBids] = useState(null);
  const [fleet, setFleet] = useState(null);
  const [earn, setEarn] = useState(null);

  const [bidFor, setBidFor] = useState(null);
  const [addWhat, setAddWhat] = useState(null);   // 'vehicle' | 'driver'
  const [toast, setToast] = useState(null);

  const flash = (msg, tone = 'ok') => {
    setToast({ msg, tone });
    setTimeout(() => setToast(null), 4200);
  };

  // ── boot: the gate first ──────────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const r = await api('/portal/capabilities');
      if (r.status === 403 && r.body?.error === 'PORTAL_NOT_APPROVED') {
        setGate('not_approved'); setGateMsg(r.body.detail); return;
      }
      if (!r.ok) { setGate('error'); setGateMsg(r.body?.detail ?? `API ${r.status}`); return; }
      setCaps(r.body.visible ?? {});
      setGate('ok');
    })();
  }, []);

  const loadBoard = useCallback(async () => {
    const r = await api('/portal/vendor/loads');
    if (r.ok) { setLoads(r.body.loads ?? []); setTargetVisible(!!r.body.target_visible); }
    else setLoads([]);
    const b = await api('/portal/vendor/bids');
    setBids(b.ok ? (b.body.bids ?? []) : []);
  }, []);
  const loadFleet = useCallback(async () => {
    const r = await api('/portal/vendor/fleet');
    setFleet(r.ok ? r.body : { vehicles: [], drivers: [], pending: 0 });
  }, []);
  const loadEarn = useCallback(async () => {
    const r = await api('/portal/vendor/earnings');
    setEarn(r.ok ? r.body : null);
  }, []);

  useEffect(() => {
    if (gate !== 'ok') return;
    if (tab === 'board') loadBoard();
    if (tab === 'fleet') loadFleet();
    if (tab === 'wallet') loadEarn();
  }, [gate, tab, loadBoard, loadFleet, loadEarn]);

  // ── the gate ──────────────────────────────────────────────────────────────
  if (gate === 'loading') {
    return (
      <Shell>
        <div className="space-y-3 px-4 pt-6">
          <CardSkeleton /><CardSkeleton /><CardSkeleton lines={2} />
        </div>
      </Shell>
    );
  }
  if (gate !== 'ok') {
    return (
      <Shell>
        <div className="flex min-h-[70vh] flex-col items-center justify-center px-8 text-center">
          <div className="mb-5 grid h-16 w-16 place-items-center rounded-3xl border border-amber-400/25 bg-amber-400/10">
            <ShieldCheck size={28} className="text-amber-300" />
          </div>
          <h2 className="text-[19px] font-black text-white">
            {gate === 'not_approved' ? 'Awaiting office approval' : 'Cannot reach the office'}
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-white/45">{gateMsg}</p>
          {gate === 'not_approved' && (
            <p className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[12px] leading-relaxed text-white/40">
              Nothing is hidden from you here — the account simply is not switched on yet.
              Prasad Transport office enables it once your papers are checked.
            </p>
          )}
        </div>
      </Shell>
    );
  }

  const bidByLoad = {};
  for (const b of bids ?? []) if (b.status === 'PENDING') bidByLoad[b.load_id] = b;

  return (
    <Shell>
      {/* ── LOAD BOARD ─────────────────────────────────────────────────── */}
      {tab === 'board' && (
        <div className="px-4 pt-4">
          <Header
            title="Load Board"
            sub={loads == null ? 'loading…' : `${loads.length} open ${loads.length === 1 ? 'load' : 'loads'}`}
          />

          {/* The promise, made explicitly. A partner who suspects the screen is
              hiding a number assumes the worst about the auction. */}
          <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.06] px-4 py-3">
            <Info size={15} className="mt-0.5 shrink-0 text-cyan-400" />
            <p className="text-[12px] leading-relaxed text-cyan-100/70">
              <span className="font-black text-cyan-200">Blind bidding.</span> You can see how many
              partners have bid on a load, never what they bid — and they cannot see yours.
              {!targetVisible && ' The office target rate is not shown to anyone.'}
            </p>
          </div>

          {loads == null && <div className="space-y-3"><CardSkeleton /><CardSkeleton /></div>}
          {loads?.length === 0 && (
            <Empty icon={Package} title="No open loads"
                   body="When the office posts a load to the bazaar it appears here straight away." />
          )}

          <div className="space-y-3">
            {loads?.map((l) => {
              const mine = bidByLoad[l.load_id];
              return (
                <div key={l.load_id}
                  className="fp-rise overflow-hidden rounded-[22px] border border-white/[0.07]
                             bg-gradient-to-b from-white/[0.06] to-white/[0.02] backdrop-blur-xl">
                  <div className="flex items-start gap-3 px-4 pt-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[15px] font-black text-white">
                        <span className="truncate">{l.origin}</span>
                        <ArrowRight size={14} className="shrink-0 text-cyan-400" />
                        <span className="truncate">{l.destination}</span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-white/40">{l.customer_name}</p>
                    </div>
                    {mine && <Pill status={mine.status} />}
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden border-y border-white/5 bg-white/5">
                    <Cell icon={Package} label="Material" value={l.material || '—'} />
                    <Cell icon={Truck} label="Weight" value={l.weight || '—'} />
                    <Cell icon={CalendarDays} label="Loading" value={dmy(l.loading_date)} />
                  </div>

                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      {mine ? (
                        <>
                          <p className="text-[11px] uppercase tracking-wider text-white/35">Your bid</p>
                          <p className="text-[17px] font-black text-emerald-300">₹{inr(mine.bid_amount)}</p>
                        </>
                      ) : (
                        <>
                          <p className="text-[11px] uppercase tracking-wider text-white/35">
                            {l.bid_count === 0 ? 'No bids yet' : `${l.bid_count} partner${l.bid_count === 1 ? '' : 's'} bidding`}
                          </p>
                          <p className="text-[12px] text-white/30">
                            {l.distance_km ? `${inr(l.distance_km)} km` : 'distance not set'}
                            {targetVisible && l.target_rate ? ` · target ₹${inr(l.target_rate)}` : ''}
                          </p>
                        </>
                      )}
                    </div>
                    <button
                      onClick={() => setBidFor(l)}
                      className="shrink-0 rounded-2xl bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-3
                                 text-[13px] font-black text-white shadow-[0_8px_24px_rgba(34,211,238,0.25)]
                                 transition-transform active:scale-[0.97]">
                      {mine ? 'Revise bid' : 'Submit bid'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {(bids?.length ?? 0) > 0 && (
            <>
              <Header title="My bids" sub={`${bids.length} submitted`} className="mt-7" />
              <div className="space-y-2 pb-4">
                {bids.map((b) => (
                  <div key={b.id} className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-bold text-white">{b.origin} → {b.destination}</p>
                      <p className="text-[11px] text-white/35">{b.load_id} · {dmy(b.created_at)}</p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-[14px] font-black text-white">₹{inr(b.bid_amount)}</p>
                      <Pill status={b.status} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── MY FLEET ───────────────────────────────────────────────────── */}
      {tab === 'fleet' && (
        <div className="px-4 pt-4">
          <Header title="My Fleet" sub={fleet == null ? 'loading…'
            : `${fleet.vehicles.length} trucks · ${fleet.drivers.length} drivers`} />

          {fleet?.pending > 0 && (
            <div className="mb-4 flex items-start gap-2.5 rounded-2xl border border-amber-400/25 bg-amber-400/[0.07] px-4 py-3">
              <Clock size={15} className="mt-0.5 shrink-0 text-amber-400" />
              <p className="text-[12px] leading-relaxed text-amber-100/70">
                <span className="font-black text-amber-200">{fleet.pending} waiting on the office.</span>{' '}
                Nothing you add can take a trip until it is approved — so it is not shown as
                available anywhere until then.
              </p>
            </div>
          )}

          <div className="mb-4 grid grid-cols-2 gap-3">
            <button onClick={() => setAddWhat('vehicle')}
              className="flex items-center justify-center gap-2 rounded-2xl border border-white/10
                         bg-white/[0.04] py-4 text-[13px] font-black text-white transition-transform active:scale-[0.97]">
              <Plus size={16} className="text-cyan-400" /> Add truck
            </button>
            <button onClick={() => setAddWhat('driver')}
              className="flex items-center justify-center gap-2 rounded-2xl border border-white/10
                         bg-white/[0.04] py-4 text-[13px] font-black text-white transition-transform active:scale-[0.97]">
              <Plus size={16} className="text-violet-400" /> Add driver
            </button>
          </div>

          {fleet == null && <div className="space-y-3"><CardSkeleton lines={2} /><CardSkeleton lines={2} /></div>}

          {fleet?.vehicles.length === 0 && fleet?.drivers.length === 0 && (
            <Empty icon={Truck} title="Nothing added yet"
                   body="Add your trucks and drivers here. Each one goes to the office for approval before it can be given a load." />
          )}

          {fleet?.vehicles.map((v) => (
            <div key={v.id} className="mb-2 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-black tracking-wide text-white">{v.registration_no}</p>
                  <p className="truncate text-[11px] text-white/35">
                    {[v.vehicle_class, v.capacity, v.driver_name].filter(Boolean).join(' · ') || 'no details yet'}
                  </p>
                </div>
                <Pill status={v.system_status} />
              </div>
              {v.reject_reason && (
                <p className="mt-2 rounded-xl border border-red-400/20 bg-red-400/[0.07] px-3 py-2 text-[11.5px] text-red-200/80">
                  Office note: {v.reject_reason}
                </p>
              )}
            </div>
          ))}

          {fleet?.drivers.map((d) => (
            <div key={d.id} className="mb-2 flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
              <div className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-violet-500/15 text-[12px] font-black text-violet-300">
                {d.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13.5px] font-bold text-white">{d.name}</p>
                <p className="truncate text-[11px] text-white/35">
                  {d.mobile || 'no mobile'}{d.aadhaar_last4 ? ` · Aadhaar ••••${d.aadhaar_last4}` : ''}
                </p>
              </div>
              <Pill status={d.system_status} />
            </div>
          ))}
        </div>
      )}

      {/* ── WALLET ─────────────────────────────────────────────────────── */}
      {tab === 'wallet' && (
        <div className="px-4 pt-4">
          <Header title="Earnings" sub={earn?.vendor ?? 'loading…'} />
          {earn == null && <div className="space-y-3"><CardSkeleton /><CardSkeleton lines={2} /></div>}

          {earn && (
            <>
              {earn.ledger_visible && earn.ledger ? (
                <div className="mb-4 overflow-hidden rounded-[24px] border border-emerald-400/20
                                bg-gradient-to-br from-emerald-500/[0.13] via-emerald-500/[0.05] to-transparent
                                p-5 backdrop-blur-xl">
                  <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-emerald-300/60">Ledger balance</p>
                  <p className="mt-1 text-[34px] font-black leading-none text-white">
                    ₹{inr(earn.ledger.current_balance)}
                  </p>
                  <p className="mt-1 text-[12px] text-white/40">
                    {earn.payment_terms ? `Terms: ${earn.payment_terms}` : 'Payment terms not set'}
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-3">
                    <Mini label="Posted to books" value={`₹${inr(earn.ledger.posted)}`} tone="text-emerald-300" />
                    <Mini label="Awaiting approval" value={`₹${inr(earn.ledger.awaiting_approval)}`} tone="text-amber-300" />
                  </div>
                  <p className="mt-3 text-[11px] leading-relaxed text-white/30">
                    “Awaiting approval” is money you have billed that the office has not yet passed.
                    It is not owed to you until it clears.
                  </p>
                </div>
              ) : (
                <div className="mb-4 rounded-[24px] border border-white/10 bg-white/[0.03] p-5">
                  <p className="text-[13px] font-bold text-white/70">Ledger not shared</p>
                  <p className="mt-1 text-[12px] leading-relaxed text-white/35">
                    The office has not enabled ledger visibility for partners. Your trips and bids are below.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-3 gap-3">
                <Stat label="Trucks" value={earn.fleet.total} sub={`${earn.fleet.active} approved`} />
                <Stat label="Bids won" value={earn.bids.won} sub={`${earn.bids.pending} pending`} tone="text-emerald-300" />
                <Stat label="Pending" value={earn.fleet.pending} sub="awaiting office" tone="text-amber-300" />
              </div>
            </>
          )}
        </div>
      )}

      {/* ── BID SHEET ──────────────────────────────────────────────────── */}
      <BidSheet
        load={bidFor}
        existing={bidFor ? bidByLoad[bidFor.load_id] : null}
        onClose={() => setBidFor(null)}
        onDone={(msg) => { setBidFor(null); flash(msg); loadBoard(); }}
      />

      <AddSheet
        what={addWhat}
        drivers={fleet?.drivers ?? []}
        onClose={() => setAddWhat(null)}
        onDone={(msg) => { setAddWhat(null); flash(msg); loadFleet(); }}
      />

      {toast && (
        <div className="fixed inset-x-4 bottom-24 z-[9500] fp-rise">
          <div className={`rounded-2xl border px-4 py-3 text-[12.5px] font-semibold backdrop-blur-xl
            ${toast.tone === 'err'
              ? 'border-red-400/30 bg-red-500/15 text-red-100'
              : 'border-emerald-400/30 bg-emerald-500/15 text-emerald-100'}`}>
            {toast.msg}
          </div>
        </div>
      )}

      {/* ── BOTTOM NAV — where the thumb already is ────────────────────── */}
      <nav className="fixed inset-x-0 bottom-0 z-[8000] border-t border-white/[0.07]
                      bg-[#0b0f18]/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl">
        <div className="mx-auto flex max-w-md">
          {[
            { k: 'board', icon: Gavel, label: 'Loads' },
            { k: 'fleet', icon: Truck, label: 'My Fleet' },
            { k: 'wallet', icon: Wallet, label: 'Earnings' },
          ].map((t) => {
            const on = tab === t.k;
            return (
              <button key={t.k} onClick={() => setTab(t.k)}
                className={`relative flex flex-1 flex-col items-center gap-1 py-3 transition-colors
                            ${on ? 'text-cyan-300' : 'text-white/35'}`}>
                {on && <span className="absolute top-0 h-0.5 w-9 rounded-full bg-cyan-400" />}
                <t.icon size={19} />
                <span className="text-[10.5px] font-bold">{t.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </Shell>
  );
}

// ── the bid sheet ───────────────────────────────────────────────────────────
function BidSheet({ load, existing, onClose, onDone }) {
  const [amount, setAmount] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    setAmount(existing ? String(existing.bid_amount ?? '') : '');
    setRemarks(''); setErr('');
  }, [load, existing]);

  if (!load) return null;
  const n = Number(amount);
  const valid = Number.isFinite(n) && n > 0;

  const submit = async () => {
    if (!valid) { setErr('Enter the rate you want for this load.'); return; }
    setBusy(true); setErr('');
    const r = await api(`/portal/vendor/loads/${encodeURIComponent(load.load_id)}/bid`, {
      method: 'POST',
      body: JSON.stringify({ bid_amount: n, remarks: remarks || null }),
    });
    setBusy(false);
    if (!r.ok) { setErr(r.body?.detail ?? `Could not submit (${r.status})`); return; }
    onDone(r.body.revised ? 'Bid revised and sent to the office.' : 'Bid sent to the office.');
  };

  return (
    <Sheet
      open={!!load}
      onClose={onClose}
      title={existing ? 'Revise your bid' : 'Submit a bid'}
      subtitle={`${load.origin} → ${load.destination}`}
      footer={
        <button onClick={submit} disabled={busy || !valid}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r
                     from-cyan-500 to-blue-600 py-4 text-[15px] font-black text-white
                     shadow-[0_10px_30px_rgba(34,211,238,0.3)] transition-transform
                     active:scale-[0.98] disabled:opacity-40 disabled:shadow-none">
          {busy ? <><Loader2 size={17} className="animate-spin" /> Sending…</>
                : existing ? 'Replace my bid' : 'Send bid to office'}
        </button>
      }
    >
      <div className="mb-3 grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-white/5 bg-white/5">
        <Cell icon={Package} label="Material" value={load.material || '—'} />
        <Cell icon={Truck} label="Weight" value={load.weight || '—'} />
        <Cell icon={MapPin} label="Distance" value={load.distance_km ? `${inr(load.distance_km)} km` : '—'} />
      </div>

      <Field label="Your rate (₹)" hint="The all-in figure you want for this trip.">
        <input
          type="number" inputMode="decimal" min="1" value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="e.g. 42000" className={inputCls} />
      </Field>

      <Field label="Note to the office (optional)">
        <input value={remarks} onChange={(e) => setRemarks(e.target.value)}
               placeholder="Empty truck at Bongaigaon" className={inputCls} />
      </Field>

      {existing && (
        <p className="mb-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.07] px-4 py-3 text-[12px] leading-relaxed text-amber-100/70">
          You already have a live bid of <b className="text-amber-200">₹{inr(existing.bid_amount)}</b>.
          Sending a new one withdraws it — the office sees one offer from you, not two.
        </p>
      )}

      <p className="mb-2 flex items-start gap-2 text-[11.5px] leading-relaxed text-white/35">
        <ShieldCheck size={14} className="mt-0.5 shrink-0 text-cyan-400/70" />
        Sealed bid. No other partner sees this figure, and you do not see theirs.
        It goes straight to the office's approval desk — it is not an award, and nothing is agreed until they respond.
      </p>

      {err && <p className="mb-2 text-[12px] font-semibold text-red-400">{err}</p>}
    </Sheet>
  );
}

// ── add truck / driver ──────────────────────────────────────────────────────
function AddSheet({ what, drivers, onClose, onDone }) {
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { setF({}); setErr(''); }, [what]);
  if (!what) return null;

  const isVehicle = what === 'vehicle';
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async () => {
    setBusy(true); setErr('');
    const path = isVehicle ? '/portal/vendor/fleet/vehicle' : '/portal/vendor/fleet/driver';
    const r = await api(path, { method: 'POST', body: JSON.stringify(f) });
    setBusy(false);
    if (!r.ok) { setErr(r.body?.detail ?? `Could not submit (${r.status})`); return; }
    onDone(r.body.detail ?? 'Sent to the office for approval.');
  };

  const ok = isVehicle ? !!f.registration_no?.trim() : !!f.name?.trim();

  return (
    <Sheet
      open
      onClose={onClose}
      title={isVehicle ? 'Add a truck' : 'Add a driver'}
      subtitle="Goes to the office for approval before it can take a load"
      footer={
        <button onClick={submit} disabled={busy || !ok}
          className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r
                     from-violet-500 to-fuchsia-600 py-4 text-[15px] font-black text-white
                     shadow-[0_10px_30px_rgba(167,139,250,0.28)] transition-transform
                     active:scale-[0.98] disabled:opacity-40 disabled:shadow-none">
          {busy ? <><Loader2 size={17} className="animate-spin" /> Sending…</> : 'Send for approval'}
        </button>
      }
    >
      {isVehicle ? (
        <>
          <Field label="Registration number" hint="As printed on the RC.">
            {/* uppercase + no autocorrect: a plate is not a word */}
            <input value={f.registration_no ?? ''} onChange={set('registration_no')}
                   autoCapitalize="characters" autoCorrect="off" spellCheck={false}
                   placeholder="AS 25C 9908" className={`${inputCls} uppercase tracking-wider`} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              <select value={f.vehicle_class ?? ''} onChange={set('vehicle_class')} className={inputCls}>
                <option value="">Select…</option>
                {['Tanker', 'Trailer', 'Open Body', 'Container', 'Tipper'].map((o) => <option key={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Capacity">
              <select value={f.capacity ?? ''} onChange={set('capacity')} className={inputCls}>
                <option value="">Select…</option>
                {['9 MT', '16 MT', '21 MT', '25 MT', '12 KL', '16 KL', '20 KL', '24 KL'].map((o) => <option key={o}>{o}</option>)}
              </select>
            </Field>
          </div>
          {drivers.length > 0 && (
            <Field label="Driver" hint="Only drivers the office has approved can be assigned.">
              <select value={f.market_driver_id ?? ''} onChange={set('market_driver_id')} className={inputCls}>
                <option value="">Assign later</option>
                {drivers.filter((d) => d.system_status === 'System Active')
                  .map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Insurance expiry"><input type="date" value={f.ins_expiry ?? ''} onChange={set('ins_expiry')} className={inputCls} style={{ colorScheme: 'dark' }} /></Field>
            <Field label="Fitness expiry"><input type="date" value={f.fit_expiry ?? ''} onChange={set('fit_expiry')} className={inputCls} style={{ colorScheme: 'dark' }} /></Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Driver name">
            <input value={f.name ?? ''} onChange={set('name')} autoCapitalize="words"
                   placeholder="Full name as on the licence" className={inputCls} />
          </Field>
          <Field label="Mobile">
            <input type="tel" inputMode="numeric" value={f.mobile ?? ''} onChange={set('mobile')}
                   placeholder="10 digits" className={inputCls} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Licence no"><input value={f.licence_no ?? ''} onChange={set('licence_no')} autoCapitalize="characters" className={`${inputCls} uppercase`} /></Field>
            <Field label="Licence expiry"><input type="date" value={f.licence_expiry ?? ''} onChange={set('licence_expiry')} className={inputCls} style={{ colorScheme: 'dark' }} /></Field>
          </div>
          <Field label="Aadhaar" hint="Stored as a one-way hash. Only the last four digits are kept.">
            <input inputMode="numeric" value={f.aadhaar ?? ''} onChange={set('aadhaar')}
                   placeholder="12 digits" className={inputCls} />
          </Field>
          <DocUpload label="Licence photo" value={f.licence_photo_url}
                     onUploaded={(v) => setF((p) => ({ ...p, licence_photo_url: v }))}
                     hint="Photograph the licence — the office checks it before approving." />
        </>
      )}
      {err && <p className="mb-2 text-[12px] font-semibold text-red-400">{err}</p>}
    </Sheet>
  );
}

// ── layout bits ─────────────────────────────────────────────────────────────
function Shell({ children }) {
  return (
    <div className="min-h-screen bg-[#070a11] pb-24 text-white"
         style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
      <style>{`
        @keyframes fpRise { from { opacity:0; transform: translateY(10px); } to { opacity:1; transform:none; } }
        .fp-rise { animation: fpRise .28s cubic-bezier(.22,1,.36,1); }
        @keyframes fpSheet { from { transform: translateY(100%); } to { transform: translateY(0); } }
        .fp-sheet { animation: fpSheet .32s cubic-bezier(.22,1,.36,1); }
        @keyframes fpFade { from { opacity:0; } to { opacity:1; } }
        .fp-fade { animation: fpFade .2s ease-out; }
        @media (prefers-reduced-motion: reduce) {
          .fp-rise, .fp-sheet, .fp-fade { animation: none; }
        }
        /* A bid is money. Nothing here should be draggable or long-press
           selectable by accident on a phone in a moving cab. */
        .fp-sheet input, .fp-sheet select { font-size: 16px; } /* iOS zooms below 16 */
      `}</style>
      <div className="mx-auto max-w-md">{children}</div>
    </div>
  );
}

function Header({ title, sub, className = '' }) {
  return (
    <div className={`mb-3 ${className}`}>
      <h1 className="text-[22px] font-black tracking-tight text-white">{title}</h1>
      {sub && <p className="text-[12.5px] text-white/40">{sub}</p>}
    </div>
  );
}

function Cell({ icon: Icon, label, value }) {
  return (
    <div className="bg-[#0b0f18] px-3 py-2.5">
      <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-white/30">
        <Icon size={10} /> {label}
      </p>
      <p className="mt-0.5 truncate text-[12.5px] font-bold text-white/85">{value}</p>
    </div>
  );
}

function Mini({ label, value, tone = 'text-white' }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-black/25 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-white/35">{label}</p>
      <p className={`mt-0.5 text-[15px] font-black ${tone}`}>{value}</p>
    </div>
  );
}

function Stat({ label, value, sub, tone = 'text-white' }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-3 py-3.5 text-center">
      <p className={`text-[22px] font-black leading-none ${tone}`}>{value}</p>
      <p className="mt-1 text-[10.5px] font-bold uppercase tracking-wider text-white/40">{label}</p>
      {sub && <p className="text-[10px] text-white/25">{sub}</p>}
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
