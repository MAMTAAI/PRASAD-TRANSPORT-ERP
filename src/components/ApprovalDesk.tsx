// @ts-nocheck
// ============================================================================
// THE EMBEDDED APPROVAL DESK (owner directive, 2026-09-02 evening)
//
// "The Smart Approval Desk and the quarantine must be front-and-center, not
//  hidden in a settings menu." So this is the whole quarantine — every staging
//  queue an outside party can fill — as one persistent strip plus one slide-out
//  drawer, mounted on Master Control v5.0 and on the Operations Command Deck.
//
// Nothing here posts anything itself. Every Approve calls the SAME server
// route the full-screen desks call, and that route runs the transaction that
// moves the row from its staging table into the core and posts through TARA:
//   expense bill  → POST /queues/expenses/:id/approve       (JOURNAL voucher, trip P&L)
//   app upload    → POST /queues/partner-documents/:id/approve (bill → expense_approvals)
//   KYC           → POST /masters/... (master row) + /bazaar/onboarding/:id/approve (gate + login)
//   POD           → POST /bazaar/settlements/:id/pod/verify  (unlocks the balance voucher)
//   award request → POST /bazaar/loads/:id/award-review      (awardInTx → settlement)
//   load review   → POST /bazaar/loads/:id/review            (PENDING_REVIEW → OPEN)
//   market truck  → POST /bazaar/market-vehicles/:id/approve
//   market driver → POST /bazaar/market-drivers/:id/approve
//   driver ask    → PATCH /masters/driver-requests/:id        (pay is a second step in Driver Master)
// The viewer, edit and reject live in ApprovalDrawer.tsx — no page change.
// ============================================================================
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../lib/apiBase';
import { currentUser, isAdmin as isAdminRole } from '../lib/rbac';
import ApprovalDrawer from './ApprovalDrawer';

const api = async (path, opts = {}) => {
  const token = localStorage.getItem('prasad_token');
  const r = await fetch(`${API_BASE}/api/v1${path}`, {
    ...opts,
    headers: {
      ...(opts.headers ?? {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.detail ?? j.error ?? `HTTP ${r.status}`), { status: r.status, code: j.error });
  return j;
};
const firstArray = (j) => (Array.isArray(j) ? j : Object.values(j ?? {}).find(Array.isArray) ?? []);
const rupee = (n) => `₹${Number(n ?? 0).toLocaleString('en-IN')}`;
const when = (v) => (v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const isVaultKey = (v) => typeof v === 'string' && /^(up|drivers|wa-media|bazaar)\//.test(v);

const EXPENSE_TYPES = { FUEL: '⛽ Fuel', TYRE: '🛞 Tyre', MAINTENANCE: '🔧 Maintenance', TOLL: '🛣️ Toll', OTHER: '🧾 Other' };
export const DOC_LABEL = {
  LOADING_INVOICE: '📄 Loading invoice', CHALLAN: '🧾 Challan', POD: '📦 POD',
  HSD_BILL: '⛽ HSD bill', TYRE_BILL: '🛞 Tyre bill', MAINTENANCE_BILL: '🔧 Maintenance bill',
  TOLL_BILL: '🛣️ Toll bill', OTHER_BILL: '🧾 Bill', KYC: '🪪 KYC', OTHER_DOC: '📎 Document',
  // 2026-09-02: the driver's own papers and quantity reports (migration 132)
  DL: '🪪 Driving licence', AADHAAR: '🪪 Aadhaar', BANK_BOOK: '🏦 Bank passbook',
  LOADING_QTY: '⚖️ Loading quantity', UNLOADING_QTY: '⚖️ Unloading quantity',
};
export const BILL_TYPES = new Set(['HSD_BILL', 'TYRE_BILL', 'MAINTENANCE_BILL', 'TOLL_BILL', 'OTHER_BILL']);
const QTY_TYPES = new Set(['LOADING_QTY', 'UNLOADING_QTY']);
const KYC_TYPES = new Set(['DL', 'AADHAAR', 'BANK_BOOK']);

/** What the OCR proposal on a staged paper looks like to the drawer. */
export const partnerDocOcr = (r) => ({
  status: r.ocr_status ?? 'PENDING', engine: r.ocr_engine ?? null, at: r.ocr_at ?? null, error: r.ocr_error ?? null,
  kind: r.ocr_data?.kind ?? null, confident: r.ocr_data?.confident ?? null,
  suggest: r.ocr_data?.suggest ?? {}, raw: r.ocr_data?.raw ?? {}, text: r.ocr_text ?? null,
  match: r.ocr_data?.match ?? null,   // { score, passed, total, checks[] } — the read against the records
});

/** The drawer for one staged paper (partner_documents) — shared by the embedded
 *  desk and the Pending Expenses screen. `decide(action, body)` is the caller's
 *  POST to /queues/partner-documents/:id/<action>; the body carries the admin's
 *  final values, which the server applies to drivers / trips on approve. */
export function partnerDocDrawerProps(r, { userName, decide, isAdmin = true }) {
  const isBill = BILL_TYPES.has(r.doc_type);
  const isQty = QTY_TYPES.has(r.doc_type);
  const d = String(r.bill_date ?? '').slice(0, 10);
  const common = [
    { key: 'vehicle_no', label: 'Vehicle', value: r.vehicle_no ?? '', editable: true },
    ...(r.trip_code || r.trip_id ? [{ key: 'trip', label: 'Trip', value: r.trip_code ?? r.trip_id ?? '' }] : []),
    { key: 'remarks', label: 'Uploader remarks', value: r.remarks ?? '', wide: true },
  ];
  let fields; let approveLabel; let footnote; let amountLabel = 'Bill amount'; let amount = null;
  if (isBill) {
    amount = Number(r.amount ?? 0);
    fields = [
      { key: 'amount', label: 'Amount (₹)', value: r.amount ?? '', editable: true, type: 'number', hint: 'Files into the expense queue on Verify.' },
      { key: 'bill_no', label: 'Bill no', value: r.bill_no ?? '', editable: true },
      { key: 'bill_date', label: 'Bill date', value: d, editable: true, type: 'date' },
      ...common,
    ];
    approveLabel = '✅ Verify & file expense';
    footnote = 'Verify marks the paper checked and tells the uploader on WhatsApp. The bill then waits in Expense bills — TARA posts only on that second approval.';
  } else if (isQty) {
    amountLabel = r.doc_type === 'LOADING_QTY' ? 'Loaded (driver)' : 'Unloaded (driver)';
    amount = r.qty == null ? null : Number(r.qty);
    fields = [
      { key: 'qty', label: r.doc_type === 'LOADING_QTY' ? 'Loaded quantity' : 'Unloaded quantity', value: r.qty ?? '', editable: true, type: 'number',
        hint: r.doc_type === 'LOADING_QTY' ? 'Approve writes trips.driver_loaded_qty.' : 'Approve writes trips.driver_unloaded_qty, keeps the photo on the trip and marks the unloading office-approved.' },
      ...common,
    ];
    approveLabel = '✅ Approve & write to trip';
    footnote = 'The driver\'s figure lands in the trip\'s driver_* columns only — the office quantity from the IOCL documents is untouched, so a shortage stays visible.';
  } else if (r.doc_type === 'DL') {
    fields = [
      { key: 'license_no', label: 'Licence no', value: '', editable: true, hint: 'Blank keeps the number already on file.' },
      { key: 'license_expiry', label: 'Licence expiry', value: '', editable: true, type: 'date' },
      ...common,
    ];
    approveLabel = '✅ Approve & update driver';
    footnote = 'Approve stores the photo on the driver record and updates the licence number / expiry if you fill them (blank keeps the existing value).';
  } else if (r.doc_type === 'AADHAAR') {
    fields = [
      { key: 'aadhaar_last4', label: 'Aadhaar (last 4, read)', value: r.ocr_data?.suggest?.aadhaar_last4 ?? '' },
      { key: 'aadhar_no', label: 'Aadhaar number', value: '', editable: true, hint: 'Stored only if you type it. The reader never proposes the full number.' },
      ...common,
    ];
    approveLabel = '✅ Approve & update driver';
    footnote = 'Approve stores the photo on the driver record; the number is written only if you typed it.';
  } else if (r.doc_type === 'BANK_BOOK') {
    fields = [
      { key: 'bank_name', label: 'Bank', value: '', editable: true },
      { key: 'account_no', label: 'Account no', value: '', editable: true },
      { key: 'ifsc_code', label: 'IFSC', value: '', editable: true },
      ...common,
    ];
    approveLabel = '✅ Approve & update driver';
    footnote = 'Approve stores the passbook photo and updates the bank fields you fill (blank keeps the existing value). Driver payments use these.';
  } else if (r.doc_type === 'PAN') {
    fields = [
      { key: 'pan_no', label: 'PAN number', value: r.ocr_data?.suggest?.pan_no ?? '', editable: true, hint: 'Blank keeps the number already on file.' },
      ...common,
    ];
    approveLabel = '✅ Approve & update driver';
    footnote = 'Approve stores the PAN photo on the driver record and updates the PAN number if you fill it.';
  } else if (r.doc_type === 'HZD') {
    fields = [
      { key: 'hzd_cert_no', label: 'Certificate no', value: r.ocr_data?.suggest?.hzd_cert_no ?? '', editable: true, hint: 'Blank keeps the number already on file.' },
      { key: 'hzd_expiry', label: 'Valid till', value: r.ocr_data?.suggest?.hzd_expiry ?? '', editable: true, type: 'date' },
      ...common,
    ];
    approveLabel = '✅ Approve & update driver';
    footnote = 'Approve stores the Hazardous certificate on the driver record and updates its number / expiry if you fill them. An expired HZD stops the lorry at the first check.';
  } else {
    fields = [
      { key: 'bill_no', label: 'Reference no', value: r.bill_no ?? '', editable: true },
      { key: 'bill_date', label: 'Date', value: d, editable: true, type: 'date' },
      ...common,
    ];
    approveLabel = r.doc_type === 'POD' ? '✅ Verify POD' : '✅ Verify';
    footnote = r.doc_type === 'POD'
      ? 'Verify keeps the POD photo on the trip (driver_unloading_photo) and tells the driver. Freight and settlement are untouched.'
      : 'Verify marks the paper checked and tells the uploader on WhatsApp. This kind of paper writes no core column.';
  }
  const EDIT_KEYS = ['bill_no', 'bill_date', 'vehicle_no', 'qty', 'license_no', 'license_expiry', 'aadhar_no', 'bank_name', 'account_no', 'ifsc_code', 'pan_no', 'hzd_cert_no', 'hzd_expiry'];
  return {
    title: `${DOC_LABEL[r.doc_type] ?? r.doc_type} · ${r.uploader_name}`,
    subtitle: `${String(r.uploader_role ?? '').toLowerCase()} app upload · ${when(r.created_at)}${r.trip_code ? ` · trip ${r.trip_code}` : ''}`,
    accent: KYC_TYPES.has(r.doc_type) ? '#22d3ee' : isQty ? '#2fe39b' : '#ffb224',
    fileKey: r.file_key ?? null,
    fileLabel: DOC_LABEL[r.doc_type] ?? 'Document',
    amount, amountLabel,
    chips: [
      { label: 'PENDING', tone: 'amber' },
      { label: String(r.uploader_role ?? ''), tone: 'cyan' },
      { label: `OCR ${String(r.ocr_status ?? 'PENDING').toLowerCase()}`, tone: r.ocr_status === 'DONE' ? 'violet' : r.ocr_status === 'FAILED' ? 'red' : 'slate' },
    ],
    canDecide: isAdmin,
    fields,
    ocr: partnerDocOcr(r),
    approveLabel,
    onApprove: async (edits) => {
      const body = { reviewed_by: userName };
      if (isBill) {
        const amt = Number(edits.amount ?? r.amount);
        if (!(amt > 0)) throw new Error('Bill ka amount bharein — tabhi expense queue mein jayega.');
        body.amount = amt;
      }
      if (isQty) {
        const q = Number(edits.qty ?? r.qty);
        if (!(q >= 0)) throw new Error('Quantity bharein — tabhi trip par likhega.');
        body.qty = q;
      }
      for (const k of EDIT_KEYS) if (k in edits) body[k] = edits[k] === '' ? null : edits[k];
      await decide('approve', body);
    },
    rejectLabel: '🔁 Needs correction',
    onReject: async (reason) => { await decide('reject', { reason, reviewed_by: userName }); },
    footnote: `${footnote} Reject sends it back to the uploader's own portal as NEEDS CORRECTION with your reason; a corrected photo arrives as a new row.`,
  };
}

// ── The queues. One entry per staging table an outside party can fill. ──────
export const SECTIONS = [
  { key: 'expenses', label: 'Expense bills', icon: '🧾', badge: 'pending_expenses', accent: '#ffb224', screen: 'EXPENSE_APPROVALS',
    list: async () => firstArray(await api('/queues/expenses?status=PENDING&limit=100')) },
  { key: 'docs', label: 'App uploads', icon: '📱', badge: 'pending_partner_docs', accent: '#ffb224', screen: 'EXPENSE_APPROVALS',
    list: async () => firstArray(await api('/queues/partner-documents?status=PENDING')) },
  { key: 'kyc', label: 'KYC applications', icon: '🪪', badge: 'pending_kyc', accent: '#22d3ee', screen: 'ONBOARDING',
    list: async () => firstArray(await api('/bazaar/onboarding?status=PENDING_KYC')) },
  { key: 'pods', label: 'PODs to verify', icon: '📄', badge: 'pending_pods', accent: '#8b5cf6', screen: 'BAZAAR_ADMIN',
    list: async () => firstArray(await api('/bazaar/settlements?status=POD_SUBMITTED')) },
  { key: 'awards', label: 'Award requests', icon: '🏁', badge: 'pending_award_requests', accent: '#fb923c', screen: 'BAZAAR_ADMIN',
    list: async () => {
      const [loads, ov] = await Promise.all([api('/bazaar/loads?status=AWARD_REQUESTED'), api('/bazaar/overview').catch(() => null)]);
      const req = new Map((ov?.loads?.award_requests ?? []).map((r) => [r.load_id, r]));
      return firstArray(loads).map((l) => ({ ...l, requested: req.get(l.load_id) ?? null }));
    } },
  { key: 'review', label: 'Loads to review', icon: '📦', badge: 'pending_loads_review', accent: '#22d3ee', screen: 'BAZAAR_ADMIN',
    list: async () => firstArray(await api('/bazaar/loads?status=PENDING_REVIEW')) },
  { key: 'trucks', label: 'Market trucks', icon: '🚚', badge: 'pending_market_trucks', accent: '#22d3ee', screen: 'MARKET_VEHICLE',
    list: async () => firstArray(await api('/bazaar/market-vehicles')).filter((v) => v.system_status === 'PENDING APPROVAL') },
  { key: 'mdrivers', label: 'Market drivers', icon: '🧑‍✈️', badge: 'pending_market_drivers', accent: '#22d3ee', screen: 'ACCESS_HUB',
    list: async () => firstArray(await api('/bazaar/market-drivers?status=PENDING%20APPROVAL')).filter((d) => (d.system_status ?? 'PENDING APPROVAL') === 'PENDING APPROVAL') },
  { key: 'dreq', label: 'Driver requests', icon: '🙋', badge: 'pending_requests', accent: '#2fe39b', screen: 'DRIVER',
    list: async () => firstArray(await api('/masters/driver-requests?status=PENDING')) },
];
const SECTION = Object.fromEntries(SECTIONS.map((s) => [s.key, s]));

/** Every queue's pending count, from one cheap query, polled while mounted. */
export function useDeskCounts(pollMs = 60000) {
  const [counts, setCounts] = useState(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setCounts(await api('/queues/badges')); setError(''); }
    catch (e) { setError(e.message); }
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, pollMs);
    return () => clearInterval(t);
  }, [refresh, pollMs]);
  const total = useMemo(() => SECTIONS.reduce((s, sec) => s + (Number(counts?.[sec.badge]) || 0), 0), [counts]);
  return { counts, total, error, refresh };
}

const CSS = `
@keyframes apdIn { from { transform: translateX(28px); opacity: 0 } to { transform: none; opacity: 1 } }
@keyframes apdFade { from { opacity: 0 } to { opacity: 1 } }
@keyframes apdRow { from { opacity: 0; transform: translateY(5px) } to { opacity: 1; transform: none } }
.apd-strip { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 9px 12px; border-radius: 14px; border: 1px solid rgba(255, 178, 36,.28); background: linear-gradient(90deg, rgba(255, 178, 36,.08), rgba(18, 28, 56,.35)); font-family: 'Inter', system-ui, sans-serif; }
.apd-strip .t { font-size: 12px; font-weight: 900; color: #fbbf24; letter-spacing: .04em; display: inline-flex; align-items: center; gap: 6px; }
.apd-chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; border: 1px solid #27395f; background: rgba(10, 16, 36,.55); color: #dde5f4; font-size: 11.5px; font-weight: 700; cursor: pointer; transition: transform .12s, border-color .15s; }
.apd-chip:hover { transform: translateY(-1px); border-color: #fbbf24; }
.apd-chip b { color: #fbbf24; font-size: 12.5px; }
.apd-open { margin-left: auto; padding: 6px 12px; border-radius: 10px; border: 0; background: linear-gradient(135deg, #ffb224, #d97706); color: #121c38; font-weight: 900; font-size: 12px; cursor: pointer; transition: transform .12s; white-space: nowrap; }
.apd-open:hover { transform: translateY(-1px); }
.apd-overlay { position: fixed; inset: 0; z-index: 9990; background: rgba(10, 16, 36,.6); backdrop-filter: blur(4px); animation: apdFade .16s ease; display: flex; justify-content: flex-end; }
.apd-panel { width: min(640px, 100vw); height: 100%; background: #0a1024; border-left: 1px solid #18244a; color: #dde5f4; display: grid; grid-template-rows: auto auto 1fr; animation: apdIn .2s cubic-bezier(.2,.8,.2,1); font-family: 'Inter', system-ui, sans-serif; }
.apd-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid #18244a; background: linear-gradient(180deg, #121c38, #0a1024); }
.apd-tabs { display: flex; gap: 6px; overflow-x: auto; padding: 10px 12px; border-bottom: 1px solid #18244a; scrollbar-width: none; }
.apd-tab { flex: none; display: inline-flex; align-items: center; gap: 6px; padding: 7px 11px; border-radius: 10px; border: 1px solid transparent; background: transparent; color: #9aadd4; font-size: 12px; font-weight: 700; cursor: pointer; transition: all .15s; white-space: nowrap; }
.apd-tab:hover { color: #dde5f4; background: rgba(24, 36, 74,.6); }
.apd-tab.on { color: #fff; background: rgba(255, 178, 36,.14); border-color: rgba(255, 178, 36,.4); }
.apd-tab .n { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: #18244a; color: #c4d1ea; }
.apd-tab.on .n { background: #f59e0b; color: #121c38; }
.apd-list { overflow-y: auto; padding: 12px; display: grid; gap: 8px; align-content: start; }
.apd-row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; padding: 11px 13px; border-radius: 13px; border: 1px solid #18244a; background: rgba(18, 28, 56,.65); animation: apdRow .22s ease both; transition: border-color .15s, background .15s; }
.apd-row:hover { border-color: #27395f; background: rgba(18, 28, 56,.95); }
.apd-row .ti { font-size: 13px; font-weight: 800; color: #fff; }
.apd-row .su { font-size: 11.5px; color: #9aadd4; margin-top: 2px; }
.apd-row .amt { font-size: 15px; font-weight: 900; color: #fbbf24; }
.apd-btn { min-height: 34px; padding: 0 11px; border-radius: 9px; border: 1px solid #27395f; background: #121c38; color: #dde5f4; font-weight: 700; font-size: 12px; cursor: pointer; transition: transform .12s, border-color .15s; white-space: nowrap; }
.apd-btn:hover { transform: translateY(-1px); border-color: #3d548a; }
.apd-btn:disabled { opacity: .45; cursor: not-allowed; transform: none; }
.apd-btn--ok { background: linear-gradient(135deg, #2fe39b, #2fe39b); border-color: transparent; color: #fff; }
.apd-btn--view { background: rgba(34, 211, 238,.12); border-color: rgba(34, 211, 238,.35); color: #22d3ee; }
.apd-empty { padding: 34px 16px; text-align: center; color: #5d7196; font-size: 13px; border: 1px dashed #27395f; border-radius: 14px; }
.apd-note { font-size: 11px; color: #5d7196; line-height: 1.5; }
`;
let cssMounted = false;
const useCss = () => useEffect(() => {
  if (cssMounted) return;
  const s = document.createElement('style'); s.textContent = CSS; document.head.appendChild(s); cssMounted = true;
}, []);

// ── The persistent strip on a dashboard ─────────────────────────────────────
export function ApprovalDeskPanel({ counts, total, onOpen, subtitle }) {
  useCss();
  const live = SECTIONS.filter((s) => (Number(counts?.[s.badge]) || 0) > 0);
  return (
    <div className="apd-strip" role="region" aria-label="Pending approvals">
      <span className="t">⏳ PENDING APPROVALS <span style={{ padding: '1px 8px', borderRadius: 999, background: total > 0 ? '#f59e0b' : '#18244a', color: total > 0 ? '#121c38' : '#9aadd4', fontSize: 11 }}>{counts ? total : '…'}</span></span>
      {counts && total === 0 && <span className="apd-note">Quarantine clear — nothing an outside party sent is waiting on the office.</span>}
      {live.map((s) => (
        <button key={s.key} className="apd-chip" onClick={() => onOpen?.(s.key)} title={`open ${s.label} in the desk`}>
          <span>{s.icon}</span><b>{counts[s.badge]}</b> {s.label}
        </button>
      ))}
      {counts?.pending_expenses_amount > 0 && <span className="apd-note">{rupee(counts.pending_expenses_amount)} of bills waiting for the money approval</span>}
      {subtitle && <span className="apd-note">{subtitle}</span>}
      <button className="apd-open" onClick={() => onOpen?.(null)}>Open desk ↗</button>
    </div>
  );
}

// ── Row → what the list shows, what the drawer shows, what the buttons do ───
function describe(section, r) {
  switch (section) {
    case 'expenses': return {
      title: `${EXPENSE_TYPES[r.expense_type] ?? `🧾 ${r.expense_type ?? 'Expense'}`} — ${r.vendor_name || 'no vendor named'}`,
      sub: `${r.trip_id ? `Trip ${r.trip_id} · ${r.vehicle_no ?? ''}` : 'general expense'} · ${r.source ?? 'manual'} · ${r.bill_date ? String(r.bill_date).slice(0, 10) : '—'}`,
      amount: r.amount, fileKey: r.file_key ?? null, quick: true,
    };
    case 'docs': return {
      title: `${DOC_LABEL[r.doc_type] ?? r.doc_type} · ${r.uploader_name}`,
      sub: `${String(r.uploader_role ?? '').toLowerCase()} app · ${when(r.created_at)}${r.trip_code ? ` · trip ${r.trip_code}` : ''} · OCR ${String(r.ocr_status ?? 'pending').toLowerCase()}${r.ocr_data?.kind ? ` (${String(r.ocr_data.kind).toLowerCase().replace(/_/g, ' ')})` : ''}`,
      amount: BILL_TYPES.has(r.doc_type) ? r.amount : QTY_TYPES.has(r.doc_type) ? r.qty : null,
      fileKey: r.file_key ?? null,
      // Quick ✓ only where nothing has to be typed; KYC papers and quantity
      // reports are audited in the drawer against the OCR read.
      quick: !KYC_TYPES.has(r.doc_type) && !QTY_TYPES.has(r.doc_type) && (!BILL_TYPES.has(r.doc_type) || Number(r.amount) > 0),
    };
    case 'kyc': return {
      title: `${r.type === 'CUSTOMER' ? '🏢' : '🚚'} ${r.corporate_name ?? r.agency_name ?? '—'}`,
      sub: `${r.type} · ${r.mobile_no ?? 'no mobile'} · ${r.gst_no ? `GST ${r.gst_no}` : 'no GST'} · ${when(r.created_at)}`,
      amount: null, fileKey: Object.values(r.documents ?? {}).find(isVaultKey) ?? null, quick: false,
    };
    case 'pods': return {
      title: `📄 POD · ${r.load_id} · ${r.vendor_name ?? 'partner'}`,
      sub: `${r.origin ?? ''} → ${r.destination ?? ''} · ${r.customer_name ?? ''} · truck ${r.vehicle_reg ?? '—'}`,
      amount: r.awarded_amount, fileKey: r.pod_file ?? null, quick: true,
    };
    case 'awards': return {
      title: `🏁 ${r.load_id} · ${r.requested?.vendor_name ?? r.assigned_to ?? 'partner'}`,
      sub: `${r.origin} → ${r.destination} · ${r.customer_name ?? 'staff-posted'} · ${r.award_requested_by === 'VENDOR' ? 'partner pressed Book-Now' : 'customer accepted a bid'} · ${when(r.award_requested_at)}`,
      amount: r.requested?.bid_amount ?? null, fileKey: null, quick: true,
    };
    case 'review': return {
      title: `📦 ${r.load_id} · ${r.customer_name ?? 'customer'}`,
      sub: `${r.origin} → ${r.destination} · ${r.material ?? ''} ${r.weight ?? ''} · loading ${r.loading_date ? String(r.loading_date).slice(0, 10) : '—'}`,
      amount: r.target_rate > 0 ? r.target_rate : null, fileKey: null, quick: true,
    };
    case 'trucks': return {
      title: `🚚 ${r.registration_no} · ${r.vendor_agency ?? ''}`,
      sub: `${r.vehicle_class ?? ''} ${r.capacity ?? ''} · driver ${r.driver_name ?? '—'} · added ${when(r.created_at)}`,
      amount: null, fileKey: null, quick: true,
    };
    case 'mdrivers': return {
      title: `🧑‍✈️ ${r.name} · ${r.mobile ?? ''}`,
      sub: `DL ${r.licence_no ?? '—'}${r.licence_expiry ? ` (exp ${String(r.licence_expiry).slice(0, 10)})` : ''} · registered ${when(r.created_at)}`,
      amount: null, fileKey: isVaultKey(r.licence_photo_url) ? r.licence_photo_url : null, quick: true,
    };
    case 'dreq': return {
      title: `🙋 ${r.driver_name} · ${r.request_type}`,
      sub: `${r.remarks ?? ''} · ${when(r.requested_at ?? r.created_at)}`,
      amount: Number(r.amount) > 0 ? r.amount : null, fileKey: isVaultKey(r.photo_url) ? r.photo_url : null, quick: true,
    };
    default: return { title: r.id, sub: '', amount: null, fileKey: null, quick: false };
  }
}

/** The drawer configuration for one row — fields, and what Approve / Reject call. */
function drawerFor(section, r, ctx) {
  const d = describe(section, r);
  const who = ctx.userName;
  const base = { title: d.title, subtitle: d.sub, accent: SECTION[section].accent, fileKey: d.fileKey, amount: d.amount, canDecide: ctx.isAdmin };
  switch (section) {
    case 'expenses': return { ...base,
      fileLabel: r.source === 'VENDOR_PORTAL' ? 'Vendor bill' : r.source === 'PARTNER_APP' ? 'App upload' : 'Bill',
      chips: [{ label: 'PENDING', tone: 'amber' }, ...(r.source === 'VENDOR_PORTAL' ? [{ label: '🏪 Vendor portal', tone: 'cyan' }] : []), ...(r.source === 'PARTNER_APP' ? [{ label: '📱 App upload', tone: 'violet' }] : [])],
      fields: [
        { key: 'amount', label: 'Amount (₹)', value: r.amount ?? '', editable: true, type: 'number' },
        { key: 'expense_type', label: 'Type', value: r.expense_type ?? 'OTHER', editable: true, type: 'select',
          options: [...Object.entries(EXPENSE_TYPES).map(([k, v]) => ({ value: k, label: v })), ...(r.expense_type && !EXPENSE_TYPES[r.expense_type] ? [{ value: r.expense_type, label: r.expense_type }] : [])],
          render: (v) => EXPENSE_TYPES[v] ?? v },
        { key: 'vendor_name', label: 'Vendor / pump', value: r.vendor_name ?? '', editable: true },
        { key: 'bill_no', label: 'Bill no', value: r.bill_no ?? '', editable: true },
        { key: 'bill_date', label: 'Bill date', value: String(r.bill_date ?? '').slice(0, 10), editable: true, type: 'date' },
        { key: 'vehicle_no', label: 'Vehicle', value: r.vehicle_no ?? '', editable: true },
        { key: 'description', label: 'Description', value: r.description ?? '', editable: true, wide: true },
        // WHOSE BOOKS. The three firms keep separate ledgers, and both legs of
        // this voucher are stamped with whatever is chosen here — so the office
        // can correct the vendor at the moment somebody actually reads the bill.
        { key: 'company_id', label: 'Company (books)', value: r.company_id ?? '', editable: true, type: 'select',
          options: [{ value: '', label: '— choose the company —' },
                    ...(ctx.companies ?? []).map((c) => ({ value: c.id, label: c.company_name }))],
          render: (v) => (ctx.companies ?? []).find((c) => c.id === v)?.company_name ?? (v ? String(v).slice(0, 8) : '— not set —') },
      ],
      approveLabel: '✅ Approve & Post',
      onSaveEdits: async (edits) => { await api(`/queues/expenses/${r.id}`, { method: 'PATCH', body: JSON.stringify(nullify(edits)) }); },
      onApprove: async (edits) => {
        if (Object.keys(edits).length) await api(`/queues/expenses/${r.id}`, { method: 'PATCH', body: JSON.stringify(nullify(edits)) });
        if (!(Number(edits.amount ?? r.amount) > 0)) throw new Error('Amount must be more than zero');
        const companyId = edits.company_id ?? r.company_id ?? '';
        if (!companyId) throw new Error('Choose which company this bill belongs to — the ledger posts under it');
        await api(`/queues/expenses/${r.id}/approve`, { method: 'POST', body: JSON.stringify({ approved_by: who, company_id: companyId }) });
      },
      onReject: async (reason) => { await api(`/queues/expenses/${r.id}/reject`, { method: 'POST', body: JSON.stringify({ reason, rejected_by: who }) }); },
      footnote: 'Approve runs one transaction on the server: the row leaves the staging queue, TARA posts the JOURNAL under the chosen company (Dr expense / Cr creditor or cash) and the trip P&L is retro-adjusted. Edits are saved to the pending row first.',
    };
    case 'docs':
      // The Milan view: photo, OCR proposal, the admin's values — one drawer,
      // shared with Pending Expenses. Approve carries the final values; the
      // server applies them to drivers / trips inside its transaction.
      return partnerDocDrawerProps(r, {
        userName: who, isAdmin: ctx.isAdmin,
        decide: (action, body) => api(`/queues/partner-documents/${r.id}/${action}`, { method: 'POST', body: JSON.stringify(body) }),
      });
    case 'kyc': {
      const isCustomer = r.type === 'CUSTOMER';
      const docs = Object.entries(r.documents ?? {});
      return { ...base, fileLabel: 'KYC document',
        chips: [{ label: 'SUBMITTED', tone: 'amber' }, { label: isCustomer ? 'Customer' : 'Fleet partner', tone: 'cyan' }],
        fields: [
          { key: 'name', label: isCustomer ? 'Corporate name' : 'Agency name', value: r.corporate_name ?? r.agency_name ?? '' },
          { key: 'contact', label: isCustomer ? 'Contact person' : 'Owner', value: r.contact_person ?? r.owner_name ?? '' },
          { key: 'mobile', label: 'Mobile (OTP login)', value: r.mobile_no ?? '' },
          { key: 'gst', label: 'GST', value: r.gst_no ?? '' },
          { key: 'pan', label: 'PAN', value: r.pan_no ?? '' },
          { key: 'address', label: 'Address', value: r.address ?? '', wide: true },
          { key: 'docs', label: 'Documents', value: docs.length ? docs.map(([k, v]) => `${k}: ${typeof v === 'string' ? v.split('/').pop() : '✓'}`).join(' · ') : 'none attached', wide: true },
        ],
        approveLabel: `✅ Approve — create ${isCustomer ? 'customer' : 'fleet partner'} + login`,
        onApprove: async () => {
          const j = isCustomer
            ? await api('/masters/customers', { method: 'POST', body: JSON.stringify({
                customer_name: String(r.corporate_name ?? '').toUpperCase(), gst_no: r.gst_no || null, pan_no: r.pan_no || null,
                mobile_no: r.mobile_no || '', address: r.address || '', contact_person: r.contact_person || '',
                status: 'ACTIVE', customer_source: 'PORTAL', approval_status: 'APPROVED', portal_enabled: true }) })
            : await api('/masters/vendors', { method: 'POST', body: JSON.stringify({
                vendor_name: r.agency_name ?? r.corporate_name ?? '', vendor_type: 'FLEET PARTNER', contact_person: r.owner_name ?? r.contact_person ?? '',
                mobile_no: r.mobile_no || '', gst_no: r.gst_no || null, opening_balance: 0, status: 'ACTIVE' }) });
          const masterId = j.customer?.id ?? j.vendor?.id ?? '';
          if (!masterId) throw new Error('master row was not created');
          await api(`/bazaar/onboarding/${r.id}/approve`, { method: 'POST', body: JSON.stringify({ master_id: masterId, approved_by: who }) });
        },
        onReject: async (reason) => { await api(`/bazaar/onboarding/${r.id}/reject`, { method: 'POST', body: JSON.stringify({ reason, rejected_by: who }) }); },
        footnote: 'Approve creates the master row, opens the portal gate and creates the OTP login in one server transaction; the applicant is told on WhatsApp.',
      };
    }
    case 'pods': return { ...base, fileLabel: 'Proof of delivery', amountLabel: 'Awarded',
      chips: [{ label: r.status, tone: 'violet' }],
      fields: [
        { key: 'load', label: 'Load', value: r.load_id ?? '' },
        { key: 'partner', label: 'Fleet partner', value: r.vendor_name ?? '' },
        { key: 'vehicle', label: 'Truck', value: r.vehicle_reg ?? '' },
        { key: 'driver', label: 'Driver named', value: r.driver_name_assigned ?? '' },
        { key: 'note', label: 'Verification note', value: '', editable: true, wide: true },
      ],
      approveLabel: '✅ Verify POD',
      onApprove: async (edits) => { await api(`/bazaar/settlements/${r.id}/pod/verify`, { method: 'POST', body: JSON.stringify({ note: edits.note ?? null, verified_by: who }) }); },
      footnote: 'Verifying unlocks "Release balance" in Bazaar Admin. The rupees move only there — a TARA voucher in the market-fleet segment.',
    };
    case 'awards': return { ...base, fileLabel: 'No document — a decision',
      chips: [{ label: 'AWARD_REQUESTED', tone: 'amber' }, { label: r.award_requested_by === 'VENDOR' ? 'Book-Now' : 'Customer accept', tone: 'cyan' }],
      fields: [
        { key: 'load', label: 'Load', value: `${r.load_id} · ${r.origin} → ${r.destination}`, wide: true },
        { key: 'customer', label: 'Customer', value: r.customer_name ?? 'staff-posted' },
        { key: 'partner', label: 'Partner', value: r.requested?.vendor_name ?? '—' },
        { key: 'offer', label: 'Offer (₹)', value: r.requested?.bid_amount != null ? Number(r.requested.bid_amount).toLocaleString('en-IN') : '—' },
        { key: 'target', label: 'Target rate (₹)', value: r.target_rate > 0 ? Number(r.target_rate).toLocaleString('en-IN') : '—' },
        { key: 'remarks', label: 'Partner remarks', value: r.requested?.remarks ?? '', wide: true },
      ],
      approveLabel: '✅ Confirm award',
      onApprove: async () => { await api(`/bazaar/loads/${r.load_id}/award-review`, { method: 'POST', body: JSON.stringify({ action: 'APPROVE' }) }); },
      onReject: async (reason) => { await api(`/bazaar/loads/${r.load_id}/award-review`, { method: 'POST', body: JSON.stringify({ action: 'REJECT', reason }) }); },
      footnote: 'Confirm accepts the bid, closes the load and opens the settlement (awardInTx). Money still needs the firm named and the deposit / advance / balance steps.',
    };
    case 'review': return { ...base, fileLabel: 'No document — a decision',
      chips: [{ label: 'PENDING_REVIEW', tone: 'amber' }, { label: 'Customer portal', tone: 'cyan' }],
      fields: [
        { key: 'route', label: 'Route', value: `${r.origin} → ${r.destination}`, wide: true },
        { key: 'customer', label: 'Customer', value: r.customer_name ?? '' },
        { key: 'material', label: 'Material', value: `${r.material ?? ''} ${r.weight ?? ''}`.trim() },
        { key: 'vehicle_type', label: 'Vehicle', value: r.vehicle_type ?? '' },
        { key: 'loading_date', label: 'Loading', value: r.loading_date ? String(r.loading_date).slice(0, 10) : '' },
        { key: 'target', label: 'Customer target (₹)', value: r.target_rate > 0 ? Number(r.target_rate).toLocaleString('en-IN') : '—' },
      ],
      approveLabel: '✅ Open for bidding',
      onApprove: async () => { await api(`/bazaar/loads/${r.load_id}/review`, { method: 'POST', body: JSON.stringify({ action: 'APPROVE' }) }); },
      onReject: async (reason) => { await api(`/bazaar/loads/${r.load_id}/review`, { method: 'POST', body: JSON.stringify({ action: 'REJECT', reason }) }); },
      footnote: 'Opening publishes the load to fleet partners for blind bidding; the customer is told either way.',
    };
    case 'trucks': return { ...base, fileLabel: 'No document',
      chips: [{ label: 'PENDING APPROVAL', tone: 'amber' }],
      fields: [
        { key: 'reg', label: 'Registration', value: r.registration_no ?? '' },
        { key: 'agency', label: 'Partner', value: r.vendor_agency ?? '' },
        { key: 'class', label: 'Class / capacity', value: `${r.vehicle_class ?? ''} ${r.capacity ?? ''}`.trim() },
        { key: 'driver', label: 'Driver', value: `${r.driver_name ?? ''} ${r.driver_mobile ?? ''}`.trim() },
        { key: 'exp', label: 'RC / INS / PUC / FIT', value: [r.rc_expiry, r.ins_expiry, r.puc_expiry, r.fit_expiry].map((v) => v || '—').join(' · '), wide: true },
      ],
      approveLabel: '✅ Approve truck',
      onApprove: async () => { await api(`/bazaar/market-vehicles/${r.id}/approve`, { method: 'POST', body: '{}' }); },
      onReject: async (reason) => { await api(`/bazaar/market-vehicles/${r.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); },
      footnote: 'An approved truck can be named on a settlement. The partner sees the reason if rejected.',
    };
    case 'mdrivers': return { ...base, fileLabel: 'Licence photo',
      chips: [{ label: 'PENDING APPROVAL', tone: 'amber' }],
      fields: [
        { key: 'name', label: 'Name', value: r.name ?? '' },
        { key: 'mobile', label: 'Mobile', value: r.mobile ?? '' },
        { key: 'dl', label: 'Licence', value: r.licence_no ?? '' },
        { key: 'exp', label: 'Licence expiry', value: r.licence_expiry ? String(r.licence_expiry).slice(0, 10) : '' },
        { key: 'aadhaar', label: 'Aadhaar (last 4)', value: r.aadhaar_last4 ? `•••• ${r.aadhaar_last4}` : '' },
      ],
      approveLabel: '✅ Approve driver',
      onApprove: async () => { await api(`/bazaar/market-drivers/${r.id}/approve`, { method: 'POST', body: JSON.stringify({ approved_by: who }) }); },
      onReject: async (reason) => { await api(`/bazaar/market-drivers/${r.id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); },
      footnote: "A market driver has no app login; approval lets the partner name them on a truck.",
    };
    case 'dreq': return { ...base, fileLabel: 'Attached photo',
      chips: [{ label: 'PENDING', tone: 'amber' }, { label: r.request_type, tone: 'cyan' }],
      fields: [
        { key: 'driver', label: 'Driver', value: r.driver_name ?? '' },
        { key: 'type', label: 'Type', value: r.request_type ?? '' },
        { key: 'amount', label: 'Amount (₹)', value: Number(r.amount ?? 0).toLocaleString('en-IN') },
        { key: 'trip', label: 'Trip', value: r.trip_id ?? '—' },
        { key: 'remarks', label: 'Remarks', value: r.remarks ?? '', wide: true },
      ],
      approveLabel: '✅ Approve request',
      onApprove: async () => { await api(`/masters/driver-requests/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'APPROVED', by: who }) }); },
      onReject: async (reason) => { await api(`/masters/driver-requests/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'REJECTED', remarks: reason, by: who }) }); },
      footnote: 'Approve marks the ask; the money is paid (and hits the khata) from Driver Master → Pay, which posts the driver transaction.',
    };
    default: return base;
  }
}
const nullify = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v === '' ? null : v]));

// ── The slide-out drawer ────────────────────────────────────────────────────
export function ApprovalDeskDrawer({ open, onClose, initialSection = null, counts, onDecided, onNavigate }) {
  useCss();
  const user = currentUser();
  // The operating companies, for the expense drawer's company picker (owner,
  // 3-Sep). Loaded once: the list is three rows and never changes mid-session.
  const [companies, setCompanies] = useState([]);
  useEffect(() => {
    // /finance/masters/companies, not /masters/companies — this list lives on
    // the cashbook module's prefix, and it already returns only ACTIVE rows.
    api('/finance/masters/companies')
      .then((j) => setCompanies(j.companies ?? []))
      .catch(() => setCompanies([]));
  }, []);
  const ctx = useMemo(() => ({
    isAdmin: isAdminRole(user),
    userName: user?.full_name || user?.name || user?.email || 'staff',
    companies,
  }), [user, companies]);
  const [section, setSection] = useState(initialSection ?? 'expenses');
  const [rows, setRows] = useState({});          // key → array | { error }
  const [loading, setLoading] = useState('');
  const [viewing, setViewing] = useState(null);  // row
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');

  const load = useCallback(async (key) => {
    setLoading(key);
    try { const list = await SECTION[key].list(); setRows((r) => ({ ...r, [key]: list })); }
    catch (e) { setRows((r) => ({ ...r, [key]: { error: e.status === 403 ? 'Admin only — this queue is decided by an Admin.' : e.message } })); }
    finally { setLoading(''); }
  }, []);

  useEffect(() => { if (open) { const k = initialSection ?? section; setSection(k); load(k); } /* eslint-disable-line */ }, [open, initialSection]);
  useEffect(() => { if (open && !rows[section]) load(section); /* eslint-disable-line */ }, [section, open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === 'Escape' && !viewing) onClose?.(); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, [open, viewing, onClose]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); }, [toast]);

  const decided = async (label) => {
    setViewing(null); setToast(label);
    await load(section); onDecided?.();
  };
  const quickApprove = async (r) => {
    const cfg = drawerFor(section, r, ctx);
    if (!cfg.onApprove) return;
    if (!window.confirm(`${cfg.approveLabel ?? 'Approve'} — ${cfg.title}?`)) return;
    setBusy(r.id ?? r.load_id);
    try { await cfg.onApprove({}); await decided(`✅ ${cfg.title}`); }
    catch (e) { alert('❌ ' + e.message); }
    finally { setBusy(''); }
  };

  if (!open) return null;
  const list = rows[section];
  const sec = SECTION[section];
  const cfg = viewing ? drawerFor(section, viewing, ctx) : null;
  const total = SECTIONS.reduce((s, x) => s + (Number(counts?.[x.badge]) || 0), 0);

  return (
    <>
      <div className="apd-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
        <div className="apd-panel" role="dialog" aria-modal="true" aria-label="Approval desk">
          <div className="apd-head">
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 900 }}>⏳ Approval Desk <span style={{ marginLeft: 6, padding: '1px 8px', borderRadius: 999, background: total > 0 ? '#f59e0b' : '#18244a', color: total > 0 ? '#121c38' : '#9aadd4', fontSize: 11, fontWeight: 900 }}>{counts ? total : '…'}</span></div>
              <div className="apd-note">Everything an outside party sent, waiting on the office. Approve here runs the server transaction — nothing moves without it.</div>
            </div>
            <button className="apd-btn" onClick={() => load(section)} disabled={!!loading}>{loading ? '…' : '↻'}</button>
            <button className="apd-btn" onClick={onClose} aria-label="Close" style={{ fontSize: 16 }}>✕</button>
          </div>
          <div className="apd-tabs">
            {SECTIONS.map((s) => (
              <button key={s.key} className={`apd-tab ${section === s.key ? 'on' : ''}`} onClick={() => setSection(s.key)}>
                <span>{s.icon}</span>{s.label}<span className="n">{counts ? (counts[s.badge] ?? 0) : '…'}</span>
              </button>
            ))}
          </div>
          <div className="apd-list">
            {!list && <div className="apd-empty">Loading {sec.label.toLowerCase()}…</div>}
            {list?.error && <div className="apd-empty">🔒 {list.error}</div>}
            {Array.isArray(list) && list.length === 0 && <div className="apd-empty">{sec.icon} Nothing waiting in {sec.label.toLowerCase()}.</div>}
            {Array.isArray(list) && list.map((r, i) => {
              const d = describe(section, r);
              const id = r.id ?? r.load_id;
              return (
                <div key={id} className="apd-row" style={{ animationDelay: `${Math.min(i, 12) * 22}ms` }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="ti">{d.title}</div>
                    <div className="su">{d.sub}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {d.amount != null && Number.isFinite(Number(d.amount)) && <span className="amt">{rupee(d.amount)}</span>}
                    <button className="apd-btn apd-btn--view" onClick={() => setViewing(r)}>{d.fileKey ? '🔍 View' : '🔍 Open'}</button>
                    {ctx.isAdmin && d.quick && (
                      <button className="apd-btn apd-btn--ok" disabled={busy === id} onClick={() => quickApprove(r)}>{busy === id ? '…' : '✓'}</button>
                    )}
                  </div>
                </div>
              );
            })}
            {onNavigate && sec.screen && (
              <div style={{ textAlign: 'center', marginTop: 6 }}>
                <button className="apd-btn" style={{ fontSize: 11 }} onClick={() => { onClose?.(); onNavigate(sec.screen); }}>open the full {sec.label.toLowerCase()} screen ↗</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {viewing && cfg && (
        <ApprovalDrawer
          open
          onClose={() => setViewing(null)}
          {...cfg}
          onApprove={cfg.onApprove ? async (edits) => { await cfg.onApprove(edits); await decided(`✅ ${cfg.title}`); } : undefined}
          onReject={cfg.onReject ? async (reason) => { await cfg.onReject(reason); await decided(`✖ ${cfg.title}`); } : undefined}
        />
      )}
      {toast && (
        <div style={{ position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 10002, background: '#121c38', border: '1px solid #27395f', color: '#dde5f4', padding: '10px 16px', borderRadius: 12, fontSize: 13, boxShadow: '0 10px 30px rgba(0,0,0,.4)', maxWidth: '90vw' }}>
          {toast}
        </div>
      )}
    </>
  );
}

/** Strip + drawer + counts in one — the thing a dashboard mounts. */
export default function ApprovalDesk({ onNavigate, subtitle, renderTrigger }) {
  const { counts, total, refresh } = useDeskCounts();
  const [desk, setDesk] = useState(null);   // null closed · true open · 'key' open on a queue
  return (
    <>
      {renderTrigger ? renderTrigger({ counts, total, open: (k) => setDesk(k ?? true) }) : null}
      <ApprovalDeskPanel counts={counts} total={total} subtitle={subtitle} onOpen={(k) => setDesk(k ?? true)} />
      <ApprovalDeskDrawer open={!!desk} initialSection={typeof desk === 'string' ? desk : null} counts={counts}
        onClose={() => setDesk(null)} onDecided={refresh} onNavigate={onNavigate} />
    </>
  );
}
