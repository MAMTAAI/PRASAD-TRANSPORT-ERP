// @ts-nocheck
// ============================================================================
// SERVICE VENDOR PORTAL — pumps, tyre shops, spares, repairs
//
// The owner's rule (2026-09-02): a FLEET PARTNER supplies market trucks and
// lives in the Load Bazaar (FleetPartnerApp.tsx); a SERVICE VENDOR supplies
// goods and services to the OWN fleet and lives in operational expenses.
// This is the service vendor's whole portal, deliberately small:
//
//   Upload bill   a PDF or photo of an HSD slip, tyre invoice, spares or
//                 repair bill, with its amount and number → lands straight
//                 in the office's Expenses queue (POST /portal/vendor/bills),
//                 the same queue a bill typed by staff waits in.
//   My bills      what was sent, what the office decided, what got paid.
//   Account       the ledger statement PDF and sign-out.
//
// One login role (VENDOR) serves both kinds; VendorGate below reads
// vendor_kind from /portal/me and opens the right app. Under a staff
// preview the server refuses every write, and this screen says so.
// ============================================================================
import React, { useEffect, useState, useCallback, lazy, Suspense } from 'react';
import { API_BASE } from '../lib/apiBase';

const FleetPartnerApp = lazy(() => import('./FleetPartnerApp'));

const api = async (path, opts = {}) => {
  const token = localStorage.getItem('prasad_token');
  const headers = { ...(opts.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const viewAs = localStorage.getItem('prasad_view_as_vendor');
  if (viewAs) headers['X-View-As-Vendor'] = viewAs;
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API_BASE}/api/v1${path}`, { ...opts, headers });
  let body = null;
  try { body = await r.json(); } catch { /* empty body */ }
  return { ok: r.ok, status: r.status, body };
};
const inr = (n) => Number(n || 0).toLocaleString('en-IN');
const dmy = (d) => { try { return d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'; } catch { return '—'; } };

const TYPES = [
  { v: 'FUEL', l: 'HSD / diesel slip', i: '⛽' },
  { v: 'TYRE', l: 'Tyre / retreading bill', i: '🛞' },
  { v: 'MAINTENANCE', l: 'Spares / repair bill', i: '🔧' },
  { v: 'TOLL', l: 'Toll / FASTag bill', i: '🛣️' },
  { v: 'OTHER', l: 'Other bill', i: '🧾' },
];
const STATUS = {
  PENDING: { l: 'With the office', c: 'text-amber-300 bg-amber-400/10 border-amber-400/25' },
  APPROVED: { l: 'Approved', c: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/25' },
  REJECTED: { l: 'Not accepted', c: 'text-red-300 bg-red-400/10 border-red-400/25' },
};

/** Decides which app a VENDOR login gets. */
export function VendorGate() {
  const [kind, setKind] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      const r = await api('/portal/me');
      if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `API ${r.status}`); setKind('SERVICE'); return; }
      setKind(r.body?.vendor_kind === 'FLEET_PARTNER' ? 'FLEET_PARTNER' : 'SERVICE');
    })();
  }, []);
  if (kind === null) return <div className="min-h-screen bg-[#020617] p-8 text-center text-[13px] text-white/50">Opening your portal…</div>;
  if (kind === 'FLEET_PARTNER') return <Suspense fallback={null}><FleetPartnerApp /></Suspense>;
  return <ServiceVendorApp gateError={err} />;
}

export default function ServiceVendorApp({ gateError = '' }) {
  const [tab, setTab] = useState('upload');
  const [me, setMe] = useState(null);
  const [gate, setGate] = useState('loading');
  const [gateMsg, setGateMsg] = useState(gateError);
  const [bills, setBills] = useState(null);
  const [toast, setToast] = useState(null);
  const viewAs = !!localStorage.getItem('prasad_view_as_vendor');

  const flash = (msg, tone = 'ok') => { setToast({ msg, tone }); setTimeout(() => setToast(null), 4500); };

  useEffect(() => {
    (async () => {
      const r = await api('/portal/capabilities');
      if (r.status === 403 && r.body?.error === 'PORTAL_NOT_APPROVED') { setGate('not_approved'); setGateMsg(r.body.detail); return; }
      if (!r.ok) { setGate('error'); setGateMsg(r.body?.detail ?? `API ${r.status}`); return; }
      const m = await api('/portal/me');
      setMe(m.body?.party ?? null);
      setGate('ok');
    })();
  }, []);

  const loadBills = useCallback(async () => {
    const r = await api('/portal/vendor/bills');
    setBills(r.ok ? (r.body.bills ?? []) : []);
  }, []);
  useEffect(() => { if (gate === 'ok' && tab === 'bills') loadBills(); }, [gate, tab, loadBills]);

  const pending = (bills ?? []).filter((b) => b.status === 'PENDING').length;

  if (gate === 'loading') return <Shell tab={tab} setTab={setTab} me={me}><p className="p-6 text-[13px] text-white/45">Loading…</p></Shell>;
  if (gate !== 'ok') {
    return (
      <Shell tab={tab} setTab={setTab} me={me} hideNav>
        <div className="flex min-h-[60vh] flex-col items-center justify-center px-8 text-center">
          <div className="mb-4 text-4xl">🏪</div>
          <h2 className="text-[18px] font-black text-white">{gate === 'not_approved' ? 'Awaiting office approval' : 'Cannot reach the office'}</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-white/45">{gateMsg}</p>
        </div>
      </Shell>
    );
  }

  return (
    <Shell tab={tab} setTab={setTab} me={me} pending={pending}>
      {viewAs && (
        <div className="mx-4 mt-3 rounded-xl border border-violet-400/30 bg-violet-400/10 px-3 py-2 text-[12px] text-violet-200">
          Staff preview — read-only. Nothing you press here is sent in this vendor's name.
        </div>
      )}
      {tab === 'upload' && <UploadBill onDone={(msg) => { flash(msg); setTab('bills'); }} onError={(m) => flash(m, 'err')} />}
      {tab === 'bills' && <Bills bills={bills} onRefresh={loadBills} />}
      {tab === 'account' && <Account me={me} onFlash={flash} />}
      {toast && (
        <div className={`fixed bottom-20 left-1/2 z-50 w-[92%] max-w-md -translate-x-1/2 rounded-xl px-4 py-3 text-[13px] font-semibold shadow-xl ${toast.tone === 'err' ? 'bg-red-500/90 text-white' : 'bg-emerald-500/90 text-black'}`}>
          {toast.msg}
        </div>
      )}
    </Shell>
  );
}

function UploadBill({ onDone, onError }) {
  const [type, setType] = useState('FUEL');
  const [amount, setAmount] = useState('');
  const [billNo, setBillNo] = useState('');
  const [billDate, setBillDate] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [remarks, setRemarks] = useState('');
  const [fileKey, setFileKey] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const pick = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { setErr('File is over 25 MB'); return; }
    setBusy(true); setErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      // The server re-roots every external upload under up/vendor/<id>/ —
      // the path here only names the file inside that tree.
      fd.append('path', `bills/${Date.now()}-${file.name.replace(/[^\w.-]+/g, '_')}`);
      const r = await api('/files', { method: 'POST', body: fd });
      if (!r.ok) { setErr(r.body?.detail ?? `upload failed (${r.status})`); return; }
      setFileKey(r.body?.key ?? r.body?.path ?? ''); setFileName(file.name);
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  const submit = async () => {
    setErr('');
    if (!fileKey) { setErr('Attach the bill first — PDF or a clear photo'); return; }
    if (!(Number(amount) > 0)) { setErr('Enter the bill amount in rupees'); return; }
    setBusy(true);
    const r = await api('/portal/vendor/bills', {
      method: 'POST',
      body: JSON.stringify({ expense_type: type, amount: Number(amount), bill_no: billNo || null, bill_date: billDate || null, vehicle_no: vehicle || null, remarks, file_key: fileKey }),
    });
    setBusy(false);
    if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `failed (${r.status})`); onError?.(r.body?.detail ?? 'Could not send the bill'); return; }
    setAmount(''); setBillNo(''); setBillDate(''); setVehicle(''); setRemarks(''); setFileKey(''); setFileName('');
    onDone(r.body?.detail ?? 'Bill sent to the office.');
  };

  return (
    <div className="px-4 pt-4 pb-24">
      <h1 className="text-[20px] font-black text-white">Upload a bill</h1>
      <p className="mt-1 text-[12.5px] text-white/45">PDF ya photo — seedha Prasad Transport office ki Expenses queue mein jaata hai.</p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        {TYPES.map((t) => (
          <button key={t.v} onClick={() => setType(t.v)}
            className={`rounded-2xl border px-3 py-3 text-left text-[13px] font-bold transition ${type === t.v ? 'border-amber-400/60 bg-amber-400/15 text-amber-200' : 'border-white/10 bg-white/[0.03] text-white/70'}`}>
            <span className="mr-2 text-[18px]">{t.i}</span>{t.l}
          </button>
        ))}
      </div>

      <label className={`mt-4 flex cursor-pointer items-center justify-between rounded-2xl border border-dashed px-4 py-4 text-[13px] ${fileKey ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200' : 'border-white/20 bg-white/[0.03] text-white/70'}`}>
        <span>{busy ? 'Uploading…' : fileKey ? `📎 ${fileName}` : '📎 Attach bill (PDF / photo)'}</span>
        <input type="file" accept="application/pdf,image/*" className="hidden" onChange={pick} disabled={busy} />
        {fileKey && <span className="text-[11px] underline" onClick={(e) => { e.preventDefault(); setFileKey(''); setFileName(''); }}>change</span>}
      </label>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <Field label="Amount (₹)"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={inp} placeholder="0.00" /></Field>
        <Field label="Bill number"><input value={billNo} onChange={(e) => setBillNo(e.target.value)} className={inp} placeholder="e.g. 4521" /></Field>
        <Field label="Bill date"><input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} className={inp} /></Field>
        <Field label="Vehicle (optional)"><input value={vehicle} onChange={(e) => setVehicle(e.target.value)} className={inp} placeholder="AS 26C 9804" /></Field>
      </div>
      <Field label="Note for the office (optional)"><input value={remarks} onChange={(e) => setRemarks(e.target.value)} className={inp} placeholder="e.g. 220 L HSD, slip 4521" /></Field>

      {err && <p className="mt-3 rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-[12.5px] text-red-200">{err}</p>}
      <button onClick={submit} disabled={busy}
        className="mt-4 w-full rounded-2xl bg-amber-400 py-4 text-[15px] font-black text-black disabled:opacity-50">
        {busy ? 'Sending…' : 'Send bill to office →'}
      </button>
    </div>
  );
}

function Bills({ bills, onRefresh }) {
  return (
    <div className="px-4 pt-4 pb-24">
      <div className="flex items-baseline justify-between">
        <h1 className="text-[20px] font-black text-white">My bills</h1>
        <button onClick={onRefresh} className="text-[12px] text-white/50 underline">refresh</button>
      </div>
      {bills == null && <p className="mt-6 text-[13px] text-white/45">Loading…</p>}
      {bills?.length === 0 && <p className="mt-6 text-[13px] text-white/45">No bill sent yet. Upload one from the first tab.</p>}
      <div className="mt-3 space-y-2">
        {(bills ?? []).map((b) => {
          const st = STATUS[b.status] ?? STATUS.PENDING;
          const t = TYPES.find((x) => x.v === b.expense_type);
          return (
            <div key={b.id} className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[14px] font-black text-white">{t?.i ?? '🧾'} ₹{inr(b.amount)} <span className="text-[12px] font-semibold text-white/50">{t?.l ?? b.expense_type}</span></div>
                  <div className="mt-0.5 text-[12px] text-white/45">{b.bill_no ? `Bill ${b.bill_no} · ` : ''}{dmy(b.bill_date ?? b.created_at)}{b.vehicle_no ? ` · ${b.vehicle_no}` : ''}</div>
                </div>
                <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-bold ${st.c}`}>{b.posted ? 'Paid / posted' : st.l}</span>
              </div>
              {b.status === 'REJECTED' && b.reject_reason && <div className="mt-2 text-[12px] text-red-200">Office: {b.reject_reason}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Account({ me, onFlash }) {
  const statement = async () => {
    try {
      const token = localStorage.getItem('prasad_token');
      const viewAs = localStorage.getItem('prasad_view_as_vendor');
      const r = await fetch(`${API_BASE}/api/v1/portal/vendor/statement.pdf`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(viewAs ? { 'X-View-As-Vendor': viewAs } : {}) } });
      if (!r.ok) { onFlash(`Statement not available (${r.status})`, 'err'); return; }
      const blob = await r.blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) { onFlash(e.message, 'err'); }
  };
  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST', body: '{}' }); } catch { /* best effort */ }
    localStorage.removeItem('prasad_token');
    window.location.reload();
  };
  return (
    <div className="px-4 pt-4 pb-24">
      <h1 className="text-[20px] font-black text-white">{me?.name ?? 'Your account'}</h1>
      <p className="mt-1 text-[12.5px] text-white/45">{me?.vendor_type ?? 'Service vendor'} · {me?.mobile_no ?? ''}</p>
      <div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4">
        <div className="text-[11px] font-bold uppercase tracking-wider text-white/40">Balance with Prasad Transport</div>
        <div className="mt-1 text-[26px] font-black text-white">₹{inr(me?.current_balance)}</div>
        <div className="text-[12px] text-white/45">as per the office books · payment terms {me?.payment_terms ?? '—'}</div>
      </div>
      <button onClick={statement} className="mt-4 w-full rounded-2xl border border-white/15 bg-white/[0.04] py-3 text-[14px] font-bold text-white">📄 Ledger statement (PDF)</button>
      <button onClick={logout} className="mt-3 w-full rounded-2xl border border-red-400/30 bg-red-400/10 py-3 text-[14px] font-bold text-red-200">Sign out</button>
    </div>
  );
}

const inp = 'mt-1 w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5 text-[14px] text-white outline-none focus:border-amber-400/60';
function Field({ label, children }) {
  return <label className="mt-3 block text-[11px] font-bold uppercase tracking-wider text-white/40">{label}{children}</label>;
}

function Shell({ children, tab, setTab, me, hideNav = false, pending = 0 }) {
  const tabs = [
    { k: 'upload', l: 'Upload bill', i: '📎' },
    { k: 'bills', l: 'My bills', i: '🧾', n: pending },
    { k: 'account', l: 'Account', i: '🏪' },
  ];
  return (
    <div className="mx-auto min-h-screen max-w-md bg-[#020617] text-white" style={{ fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }}>
      <header className="sticky top-0 z-40 flex items-center justify-between border-b border-white/10 bg-[#020617]/95 px-4 py-3 backdrop-blur">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-wider text-amber-300">Prasad Transport · Vendor Portal</div>
          <div className="text-[14px] font-black">{me?.name ?? 'Service vendor'}</div>
        </div>
        <div className="text-2xl">🏪</div>
      </header>
      <main>{children}</main>
      {!hideNav && (
        <nav className="fixed bottom-0 left-1/2 z-40 flex w-full max-w-md -translate-x-1/2 border-t border-white/10 bg-[#0b1220]">
          {tabs.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)} className={`flex flex-1 flex-col items-center py-2.5 text-[11px] font-bold ${tab === t.k ? 'text-amber-300' : 'text-white/45'}`}>
              <span className="text-[18px]">{t.i}</span>{t.l}{t.n > 0 && <span className="mt-0.5 rounded-full bg-amber-400 px-1.5 text-[10px] text-black">{t.n}</span>}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}
