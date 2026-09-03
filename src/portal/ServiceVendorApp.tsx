// @ts-nocheck
// ============================================================================
// VENDOR APP v1 — pumps, tyre shops, spares, repairs (Super-App role 2 of 4)
//
// Approved by the owner on 2026-09-03 from docs/mockups/vendor-app-mock-v1.html,
// with these rules:
//   · "loading slip" = the pump's per-truck HSD fill slip: one photo, the
//     truck, the litres and the rupees → a PENDING partner_documents row that
//     the office reviews (BHUVANESHWARI reads the photo after submit and the
//     slip row shows what OCR saw next to what was typed);
//   · expense bill = the same camera with the real expense_type chips
//     (FUEL / TYRE / MAINTENANCE / TOLL / OTHER) → the office's Expenses queue,
//     shown here with a Submitted → Approved → Posted stepper and the office's
//     reject reason plus a "send again" button;
//   · money stays per-vendor switchable: the payments khata and the balance
//     are drawn ONLY when the server says vend.bills is on for this vendor
//     (role matrix AND portal_features); otherwise the tab says "ask the
//     office" and shows no numbers — not zeros;
//   · home = a payment-status card exactly like the driver's allowance card;
//   · Hindi first with an EN toggle, 46 px targets, emoji, black call bar.
//
// Same family as DriverPortal.tsx (light theme, Segoe/Nirmala UI). One login
// role (VENDOR) serves two businesses; VendorGate below reads vendor_kind from
// /portal/me and opens the Fleet Partner app or this one. Under a staff
// preview the server refuses every write, and this screen says so.
// ============================================================================
import React, { useEffect, useMemo, useRef, useState, useCallback, lazy, Suspense } from 'react';
import { API_BASE } from '../lib/apiBase';
import { uploadMedia } from '../lib/uploadMedia';
import { DISPATCH_TEL, DISPATCH_DISPLAY } from '../lib/dispatchContact';

const FleetPartnerApp = lazy(() => import('./FleetPartnerApp'));

const API = API_BASE;
const LANG_KEY = 'prasad_vendor_lang';
const authHeaders = () => {
  const h = {};
  const token = localStorage.getItem('prasad_token');
  if (token) h.Authorization = `Bearer ${token}`;
  const viewAs = localStorage.getItem('prasad_view_as_vendor');
  if (viewAs) h['X-View-As-Vendor'] = viewAs;
  return h;
};
const api = async (path, opts = {}) => {
  const headers = { ...authHeaders(), ...(opts.headers ?? {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API}/api/v1${path}`, { ...opts, headers });
  let body = null;
  try { body = await r.json(); } catch { /* empty body */ }
  return { ok: r.ok, status: r.status, body };
};
/** Open a vault file (photo / PDF) — the GET needs the bearer, so fetch → blob. */
const openFile = async (path) => {
  const r = await fetch(`${API}/api/v1${path}`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  window.open(URL.createObjectURL(blob), '_blank', 'noopener');
};

const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const inrShort = (n) => { const v = Number(n) || 0; return Math.abs(v) >= 100000 ? `₹${(v / 100000).toFixed(2)}L` : inr(v); };
const litres = (n) => `${(Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })} L`;
const dmy = (v) => { try { return v ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''; } catch { return ''; } };
const dmyt = (v) => { try { return v ? new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : ''; } catch { return ''; } };
const today = () => new Date().toISOString().slice(0, 10);

// ── words, Hindi first ──────────────────────────────────────────────────────
const T = {
  hi: {
    brand: 'प्रसाद ट्रांसपोर्ट · वेंडर ऐप', vendor: 'वेंडर', home: 'होम', slips: 'पर्ची', bills: 'बिल', pay: 'भुगतान', acct: 'खाता',
    kSlips: 'पर्ची इस महीने', kPending: 'बिल pending', kDue: 'बकाया · due', locked: 'ऑफिस से पूछो',
    payStatus: 'भुगतान स्थिति · Payment status', raised: 'बिल भेजे · Bills raised', approved: 'मंज़ूर · Approved', posted: 'खाते में · Posted', paid: 'भुगतान मिला · Paid',
    due: 'बकाया · Balance due', officeOwes: 'ऑफिस देगा', terms: 'भुगतान शर्त', days: 'दिन', bills_n: 'बिल', pendingOffice: 'ऑफिस के पास',
    tSlip: 'Loading Slip', tSlipSub: 'ट्रक की पर्ची · photo', tBill: 'Expense Bill', tBillSub: 'खर्चे का बिल', tPay: 'Payments', tPaySub: 'भुगतान · खाता', tStmt: 'Statement', tStmtSub: 'PDF · दस्तावेज़',
    call: 'ऑफिस को कॉल करो · Call office', officeSaid: 'ऑफिस', rejectedSlip: 'पर्ची वापस आई', rejectedBill: 'बिल वापस आया',
    slipsTitle: 'Loading Slips · पर्ची', slipsSub: 'इस महीने', tapOpen: 'पर्ची खोलने के लिए दबाओ', newSlip: 'नई पर्ची · New slip', all: 'सब', pending: 'Pending', approvedS: 'Approved', rejected: 'Rejected',
    noSlips: 'अभी कोई पर्ची नहीं — कैमरा दबाओ', ocrRead: 'OCR ने पढ़ा', ocrWait: 'OCR पढ़ रहा है…', ocrDiff: 'OCR और टाइप में फ़र्क — ऑफिस देखेगा', view: 'देखो', resend: 'फिर से भेजो',
    billsTitle: 'मेरे बिल · My bills', billsSub: 'भेजा → मंज़ूर → खाते में', noBills: 'अभी कोई बिल नहीं', stSent: 'भेजा', stApproved: 'मंज़ूर', stPosted: 'खाते में',
    submitted: 'भेजा', approvedAt: 'मंज़ूर हुआ', postedAt: 'खाते में गया', voucher: 'वाउचर', reviewing: 'ऑफिस देख रहा है', note: 'टिप्पणी', truck: 'ट्रक',
    payTitle: 'भुगतान · Payments', paySub: 'प्रसाद ट्रांसपोर्ट के साथ आपका खाता', payLocked: 'बकाया और भुगतान की जानकारी ऑफिस से पूछो', payLockedSub: 'यह हिस्सा आपके खाते के लिए चालू नहीं है। ऑफिस चालू कर सकता है।',
    account: 'खाता · Account', billsIn: 'बिल दिए · Bills received by office', paidIn: 'भुगतान मिला · Payments given', statement: 'Statement PDF', txns: 'लेन-देन · Transactions', noTxns: 'कोई लेन-देन नहीं', awaiting: 'ऑफिस की मंज़ूरी बाकी',
    payment: 'भुगतान', billRecv: 'बिल मिला', creditNote: 'क्रेडिट नोट', adjustment: 'एडजस्टमेंट', opening: 'ओपनिंग',
    profile: 'वेंडर प्रोफाइल · ऑफिस बदलता है', approvedPortal: 'Portal approved', name: 'नाम', type: 'प्रकार', gst: 'GST', mobile: 'मोबाइल', language: 'भाषा', address: 'पता',
    profileNote: 'प्रोफाइल बदलनी हो तो ऑफिस को कॉल करो। फोन से मास्टर नहीं बदलता।', logout: 'बाहर निकलो · Logout',
    camSlip: 'पर्ची की फोटो लो', camSlipSub: 'ट्रक नंबर और लीटर साफ़ दिखें', camBill: 'बिल की फोटो लो', camBillSub: 'GST बिल या जॉब-कार्ड · PDF भी चलेगा',
    frame: 'पर्ची को पीली चौखट के अंदर रखो', gallery: 'गैलरी', shoot: 'फोटो खींचो', back: 'वापस',
    confirmSlip: 'पर्ची कन्फ़र्म करो', confirmSlipSub: 'ट्रक · लीटर · रकम — फिर भेजो', confirmBill: 'बिल भेजो · Submit bill', confirmBillSub: 'ऑफिस की Expenses queue में जाएगा',
    truckLbl: 'ट्रक · Truck', more: 'और', typeLbl: 'किस चीज़ की पर्ची · Type', expLbl: 'खर्चे का प्रकार · Expense type', litresLbl: 'लीटर · Litres', amountLbl: 'रकम · Amount', slipNo: 'पर्ची नं · Slip no', billNo: 'बिल नं · Bill no',
    dateLbl: 'तारीख · Date', remarks: 'टिप्पणी · Remarks', photoOn: 'फोटो लगी · photo attached', retake: 'दोबारा खींचो',
    sendSlip: 'ऑफिस को भेजो', sendBill: 'बिल ऑफिस को भेजो', sending: 'भेज रहे हैं…', needAmount: 'रकम भरो', needTruck: 'ट्रक नंबर चुनो या लिखो', needPhoto: 'पहले फोटो लो',
    confirmNote: 'ऑफिस चेक करेगा, फिर बिल में जुड़ेगा। फोन पर कुछ फाइनल नहीं होता।', ocrNote: 'भेजने के बाद OCR फोटो पढ़कर ऑफिस को दिखाएगा कि लिखा हुआ मिलता है या नहीं।',
    sent: 'भेज दिया!', sentSub: 'Submitted to office', sentPill: 'PENDING · ऑफिस की मंज़ूरी बाकी', sentNote: 'मंज़ूर होते ही WhatsApp आएगा, और यहाँ स्टेटस बदलेगा।', oneMore: 'एक और पर्ची', homeBtn: 'होम',
    preview: 'स्टाफ प्रीव्यू — सिर्फ़ देखने के लिए। यहाँ कुछ भी वेंडर के नाम से नहीं जाता।', notApproved: 'ऑफिस की मंज़ूरी बाकी', cantReach: 'ऑफिस से संपर्क नहीं हो रहा', loading: 'खुल रहा है…',
    type_HSD_BILL: 'HSD', type_TYRE_BILL: 'Tyre', type_MAINTENANCE_BILL: 'Repair', type_TOLL_BILL: 'Toll', type_OTHER_BILL: 'Other', type_LOADING_INVOICE: 'Invoice', type_CHALLAN: 'Challan',
    fy: 'वित्त वर्ष', month: 'इस महीने', lastPay: 'पिछला भुगतान',
  },
  en: {
    brand: 'Prasad Transport · Vendor App', vendor: 'Vendor', home: 'Home', slips: 'Slips', bills: 'Bills', pay: 'Payments', acct: 'Account',
    kSlips: 'slips this month', kPending: 'bills pending', kDue: 'balance due', locked: 'ask office',
    payStatus: 'Payment status', raised: 'Bills raised', approved: 'Approved', posted: 'Posted to books', paid: 'Payments received',
    due: 'Balance due', officeOwes: 'office owes', terms: 'payment terms', days: 'days', bills_n: 'bills', pendingOffice: 'with the office',
    tSlip: 'Loading Slip', tSlipSub: 'per-truck slip · photo', tBill: 'Expense Bill', tBillSub: 'GST bill / job-card', tPay: 'Payments', tPaySub: 'khata · balance', tStmt: 'Statement', tStmtSub: 'PDF · documents',
    call: 'Call office', officeSaid: 'Office', rejectedSlip: 'Slip returned', rejectedBill: 'Bill returned',
    slipsTitle: 'Loading Slips', slipsSub: 'this month', tapOpen: 'tap a slip to open', newSlip: 'New slip', all: 'All', pending: 'Pending', approvedS: 'Approved', rejected: 'Rejected',
    noSlips: 'No slip yet — tap the camera', ocrRead: 'OCR read', ocrWait: 'OCR reading…', ocrDiff: 'OCR differs from what was typed — the office will check', view: 'View', resend: 'Send again',
    billsTitle: 'My bills', billsSub: 'Submitted → Approved → Posted', noBills: 'No bill yet', stSent: 'Sent', stApproved: 'Approved', stPosted: 'Posted',
    submitted: 'Submitted', approvedAt: 'Approved', postedAt: 'Posted', voucher: 'Voucher', reviewing: 'office reviewing', note: 'Note', truck: 'Truck',
    payTitle: 'Payments', paySub: 'Your khata with Prasad Transport', payLocked: 'Ask the office for balance and payments', payLockedSub: 'This section is not switched on for your account. The office can enable it.',
    account: 'Account', billsIn: 'Bills received by office', paidIn: 'Payments given', statement: 'Statement PDF', txns: 'Transactions', noTxns: 'No transactions', awaiting: 'awaiting office approval',
    payment: 'Payment', billRecv: 'Bill received', creditNote: 'Credit note', adjustment: 'Adjustment', opening: 'Opening',
    profile: 'Vendor profile · office edits', approvedPortal: 'Portal approved', name: 'Name', type: 'Type', gst: 'GST', mobile: 'Mobile', language: 'Language', address: 'Address',
    profileNote: 'Call the office to change the profile. Nothing on the phone edits the master.', logout: 'Logout',
    camSlip: 'Photograph the slip', camSlipSub: 'truck no + litres must be visible', camBill: 'Photograph the bill', camBillSub: 'GST bill or job-card · PDF works too',
    frame: 'Keep the slip inside the yellow frame', gallery: 'Gallery', shoot: 'Take photo', back: 'Back',
    confirmSlip: 'Confirm slip', confirmSlipSub: 'truck · litres · amount — then send', confirmBill: 'Submit bill', confirmBillSub: 'goes to the office Expenses queue',
    truckLbl: 'Truck', more: 'more', typeLbl: 'Slip type', expLbl: 'Expense type', litresLbl: 'Litres', amountLbl: 'Amount', slipNo: 'Slip no', billNo: 'Bill no',
    dateLbl: 'Date', remarks: 'Remarks', photoOn: 'photo attached', retake: 'Retake',
    sendSlip: 'Send to office', sendBill: 'Send bill to office', sending: 'Sending…', needAmount: 'Enter the amount', needTruck: 'Pick or type the truck number', needPhoto: 'Take the photo first',
    confirmNote: 'The office verifies; nothing is final on the phone.', ocrNote: 'After sending, OCR reads the photo and shows the office whether it matches what was typed.',
    sent: 'Sent!', sentSub: 'Submitted to office', sentPill: 'PENDING · office approval', sentNote: 'You get a WhatsApp on approval and the status changes here.', oneMore: 'One more slip', homeBtn: 'Home',
    preview: 'Staff preview — read-only. Nothing you press here is sent in this vendor\'s name.', notApproved: 'Awaiting office approval', cantReach: 'Cannot reach the office', loading: 'Opening…',
    type_HSD_BILL: 'HSD', type_TYRE_BILL: 'Tyre', type_MAINTENANCE_BILL: 'Repair', type_TOLL_BILL: 'Toll', type_OTHER_BILL: 'Other', type_LOADING_INVOICE: 'Invoice', type_CHALLAN: 'Challan',
    fy: 'FY', month: 'this month', lastPay: 'last payment',
  },
};

const SLIP_TYPES = [
  { v: 'HSD_BILL', i: '⛽' }, { v: 'TYRE_BILL', i: '⭕' }, { v: 'MAINTENANCE_BILL', i: '🔧' }, { v: 'TOLL_BILL', i: '🛣️' }, { v: 'OTHER_BILL', i: '🧾' },
];
const EXP_TYPES = [
  { v: 'FUEL', i: '⛽' }, { v: 'TYRE', i: '⭕' }, { v: 'MAINTENANCE', i: '🔧' }, { v: 'TOLL', i: '🛣️' }, { v: 'OTHER', i: '📦' },
];
const ICON = { HSD_BILL: '⛽', TYRE_BILL: '⭕', MAINTENANCE_BILL: '🔧', TOLL_BILL: '🛣️', OTHER_BILL: '🧾', LOADING_INVOICE: '📄', CHALLAN: '📄', POD: '📦', KYC: '🆔', OTHER_DOC: '📎',
  FUEL: '⛽', TYRE: '⭕', MAINTENANCE: '🔧', TOLL: '🛣️', OTHER: '📦' };
const PILL = {
  PENDING: 'bg-amber-100 text-amber-800', APPROVED: 'bg-green-100 text-green-800', REJECTED: 'bg-red-100 text-red-800', POSTED: 'bg-green-600 text-white',
};

/** Decides which app a VENDOR login gets. */
export function VendorGate({ exit = null }) {
  const [kind, setKind] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    (async () => {
      const r = await api('/portal/me');
      if (!r.ok) { setErr(r.body?.detail ?? r.body?.error ?? `API ${r.status}`); setKind('SERVICE'); return; }
      setKind(r.body?.vendor_kind === 'FLEET_PARTNER' ? 'FLEET_PARTNER' : 'SERVICE');
    })();
  }, []);
  if (kind === null) return <div className="grid min-h-screen place-items-center bg-[#f8fafc] text-[13px] text-slate-500">…</div>;
  // Both apps are light and full-bleed since 3-Sep, so both undo the suite
  // shell's dark padding. The Fleet Partner app carries its own Sign out under
  // Money and its own bottom nav, so the floating `exit` is not rendered over
  // it — the same call the vendor app made when it went light.
  if (kind === 'FLEET_PARTNER') {
    return (
      <div style={{ margin: '-12px -12px 0', minHeight: '100vh' }}>
        <Suspense fallback={null}><FleetPartnerApp /></Suspense>
      </div>
    );
  }
  return <div style={{ margin: '-12px -12px 0', minHeight: '100vh' }}><ServiceVendorApp gateError={err} /></div>;
}

const FONT = { fontFamily: '"Segoe UI","Nirmala UI",system-ui,-apple-system,Roboto,sans-serif' };
const SHELL = 'mx-auto flex min-h-screen w-full max-w-md flex-col bg-[#f8fafc] text-slate-900';
const CARD = 'rounded-2xl border-2 border-slate-200 bg-white';

export default function ServiceVendorApp({ gateError = '' }) {
  const [lang, setLang] = useState(() => (localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'hi'));
  const t = T[lang];
  const toggleLang = () => { const n = lang === 'hi' ? 'en' : 'hi'; setLang(n); try { localStorage.setItem(LANG_KEY, n); } catch { /* private mode */ } };

  const [gate, setGate] = useState('loading');
  const [gateMsg, setGateMsg] = useState(gateError);
  const [vis, setVis] = useState({});
  const [me, setMe] = useState(null);
  const [sum, setSum] = useState(null);
  const [docs, setDocs] = useState(null);
  const [bills, setBills] = useState(null);
  const [txns, setTxns] = useState(null);
  const [tab, setTab] = useState('home');
  const [seg, setSeg] = useState('ALL');
  const [bseg, setBseg] = useState('ALL');
  const [openBill, setOpenBill] = useState(null);
  const [toast, setToast] = useState(null);

  // camera flow
  const [screen, setScreen] = useState('TABS');        // TABS | CAMERA | CONFIRM | SENT
  const [mode, setMode] = useState('SLIP');            // SLIP | BILL
  const [shot, setShot] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const camRef = useRef(null);
  const galRef = useRef(null);
  const viewAs = !!localStorage.getItem('prasad_view_as_vendor');

  const say = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3500); };

  const loadAll = useCallback(async (v = vis) => {
    const [s, d, b] = await Promise.all([api('/portal/vendor/summary'), api('/portal/vendor/documents'), api('/portal/vendor/expense-bills')]);
    if (s.ok) setSum(s.body);
    setDocs(d.ok ? (d.body?.documents ?? []) : []);
    setBills(b.ok ? (b.body?.bills ?? []) : []);
    if (v['vend.bills']) { const p = await api('/portal/vendor/bills?limit=100'); setTxns(p.ok ? p.body : null); }
  }, [vis]);

  useEffect(() => {
    (async () => {
      const r = await api('/portal/capabilities');
      if (r.status === 403 && r.body?.error === 'PORTAL_NOT_APPROVED') { setGate('not_approved'); setGateMsg(r.body.detail); return; }
      if (!r.ok) { setGate('error'); setGateMsg(r.body?.detail ?? `API ${r.status}`); return; }
      const v = r.body?.visible ?? {};
      setVis(v);
      const m = await api('/portal/me');
      setMe(m.body?.party ?? null);
      setGate('ok');
      await loadAll(v);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recentTrucks = sum?.recent_vehicles ?? [];
  const ledger = sum?.ledger ?? null;
  const showLedger = !!vis['vend.bills'];

  // ── camera flow ───────────────────────────────────────────────────────────
  const openCamera = (m, prefill = {}) => {
    setMode(m); setShot(null); setErr('');
    setForm(m === 'SLIP'
      ? { doc_type: 'HSD_BILL', vehicle_no: recentTrucks[0] ?? '', qty: '', amount: '', bill_no: '', bill_date: today(), remarks: '', ...prefill }
      : { expense_type: 'FUEL', vehicle_no: '', amount: '', bill_no: '', bill_date: today(), remarks: '', ...prefill });
    setScreen('CAMERA');
  };
  const onPick = (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setShot(f); setScreen('CONFIRM'); };
  const F = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const send = async () => {
    setErr('');
    if (!shot) { setErr(t.needPhoto); return; }
    if (mode === 'SLIP' && !String(form.vehicle_no ?? '').trim()) { setErr(t.needTruck); return; }
    if (mode === 'BILL' && !(Number(form.amount) > 0)) { setErr(t.needAmount); return; }
    setBusy(true);
    try {
      const isPdf = shot.type === 'application/pdf' || /\.pdf$/i.test(shot.name || '');
      const folder = mode === 'SLIP' ? 'vendor-slips' : 'bills';
      const tag = mode === 'SLIP' ? form.doc_type : form.expense_type;
      const up = await uploadMedia(shot, `${folder}/${String(tag).toLowerCase()}_${Date.now()}${isPdf ? '.pdf' : '.jpg'}`);
      const r = mode === 'SLIP'
        ? await api('/portal/vendor/documents', { method: 'POST', body: JSON.stringify({
            doc_type: form.doc_type, file_key: up.path, vehicle_no: form.vehicle_no, qty: form.qty === '' ? null : Number(form.qty),
            amount: form.amount === '' ? null : Number(form.amount), bill_no: form.bill_no || null, bill_date: form.bill_date || null,
            remarks: `vendor app v1 · ${form.doc_type}${form.remarks ? ' · ' + form.remarks : ''}` }) })
        : await api('/portal/vendor/expense-bills', { method: 'POST', body: JSON.stringify({
            expense_type: form.expense_type, amount: Number(form.amount), bill_no: form.bill_no || null, bill_date: form.bill_date || null,
            vehicle_no: form.vehicle_no || null, remarks: form.remarks || '', file_key: up.path }) });
      if (!r.ok) throw new Error(r.body?.detail ?? r.body?.error ?? `HTTP ${r.status}`);
      setScreen('SENT');
      loadAll();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // ── small pieces ──────────────────────────────────────────────────────────
  const Bar = ({ title, sub, back }) => (
    <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-2.5">
      {back && <button onClick={back} className="min-h-[42px] rounded-full bg-slate-100 px-4 text-[16px] font-bold">‹</button>}
      <div className="min-w-0 flex-1"><div className="truncate text-[18px] font-extrabold leading-tight">{title}</div>{sub && <div className="text-[11.5px] font-semibold text-slate-500">{sub}</div>}</div>
      <button onClick={toggleLang} className="min-h-[38px] rounded-full bg-slate-100 px-3 text-[12px] font-bold">{lang === 'hi' ? 'हिं · EN' : 'EN · हिं'}</button>
    </div>
  );
  const Pill = ({ s, label }) => <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-1 text-[11.5px] font-extrabold ${PILL[s] ?? 'bg-slate-100 text-slate-600'}`}>{label ?? s}</span>;
  const Truck = ({ n }) => n ? <span className="inline-block rounded-md bg-amber-100 px-1.5 py-0.5 font-mono text-[11.5px] font-bold text-amber-900">{n}</span> : null;
  const Tile = ({ tone, icon, label, sub, badge, onClick }) => (
    <button onClick={onClick} className={`relative flex min-h-[104px] flex-col items-center justify-center gap-0.5 rounded-2xl px-2 py-2 shadow-[0_5px_0_rgba(0,0,0,0.18)] active:translate-y-1 active:shadow-none ${tone}`}>
      <span className="text-[32px] leading-none">{icon}</span>
      <span className="mt-1 text-center text-[15.5px] font-extrabold leading-tight">{label}</span>
      <span className="text-[10.5px] font-semibold opacity-90">{sub}</span>
      {badge ? <span className="absolute right-2 top-2 rounded-full bg-red-500 px-2 py-0.5 text-[10.5px] font-extrabold text-white">{badge}</span> : null}
    </button>
  );
  const Seg = ({ items, value, onChange }) => (
    <div className="flex gap-1 rounded-xl bg-slate-200 p-[3px]">
      {items.map(([k, l]) => <button key={k} onClick={() => onChange(k)} className={`min-h-[38px] flex-1 rounded-[10px] px-1 text-[12.5px] font-extrabold ${value === k ? 'bg-white text-slate-900 shadow' : 'text-slate-600'}`}>{l}</button>)}
    </div>
  );
  const Steps = ({ n }) => {
    const labels = [t.stSent, t.stApproved, t.stPosted];
    return (
      <div className="flex items-center px-0.5">
        {labels.map((l, i) => (
          <div key={l} className="relative flex flex-1 flex-col items-center gap-0.5 text-center text-[9.5px] font-extrabold">
            <i className={`grid h-[22px] w-[22px] place-items-center rounded-full not-italic text-[11px] ${i < n ? 'bg-green-600 text-white' : i === n ? 'bg-blue-600 text-white ring-4 ring-blue-200' : 'bg-slate-200 text-slate-500'}`}>{i < n ? '✓' : i + 1}</i>
            <span className={i <= n ? 'text-slate-900' : 'text-slate-400'}>{l}</span>
            {i < labels.length - 1 && <span className={`absolute left-[calc(50%+12px)] top-[11px] h-[2px] w-[calc(100%-24px)] ${i < n ? 'bg-green-600' : 'bg-slate-200'}`} />}
          </div>
        ))}
      </div>
    );
  };
  const CallBar = () => <a href={DISPATCH_TEL} className="block min-h-[46px] rounded-2xl bg-slate-900 py-3 text-center text-[16px] font-extrabold text-white">📞 {t.call}</a>;
  const Nav = () => {
    const items = [['home', '🏠', t.home, 0], ['slips', '🧾', t.slips, sum?.slips?.rejected ?? 0], ['bills', '📑', t.bills, sum?.bills?.rejected ?? 0], ['pay', '💰', t.pay, 0], ['acct', '👤', t.acct, 0]];
    return (
      <nav className="fixed bottom-0 left-1/2 z-40 grid w-full max-w-md -translate-x-1/2 grid-cols-5 border-t border-slate-200 bg-white px-1 pb-2.5 pt-1.5">
        {items.map(([k, i, l, n]) => (
          <button key={k} onClick={() => { setTab(k); setScreen('TABS'); }} className={`relative flex min-h-[48px] flex-col items-center gap-0.5 py-1 text-[10.5px] font-extrabold ${tab === k ? 'text-blue-600' : 'text-slate-500'}`}>
            <span className="text-[22px] leading-none">{i}</span>{l}
            {n > 0 && <span className="absolute right-3 top-0 rounded-full bg-red-500 px-1.5 text-[9.5px] font-extrabold text-white">{n}</span>}
          </button>
        ))}
      </nav>
    );
  };

  // ── gate screens ──────────────────────────────────────────────────────────
  if (gate === 'loading') return <div className="grid min-h-screen place-items-center bg-[#f8fafc] text-slate-500" style={FONT}>{t.loading}</div>;
  if (gate !== 'ok') {
    return (
      <div className={SHELL} style={FONT}>
        <Bar title={t.brand} />
        <div className="grid flex-1 place-items-center px-8 text-center">
          <div><div className="text-5xl">🏪</div>
            <h2 className="mt-3 text-[20px] font-extrabold">{gate === 'not_approved' ? t.notApproved : t.cantReach}</h2>
            <p className="mt-2 text-[13.5px] font-semibold text-slate-500">{gateMsg}</p>
            <a href={DISPATCH_TEL} className="mt-6 block rounded-2xl bg-slate-900 py-3 text-[16px] font-extrabold text-white">📞 {t.call}</a></div>
        </div>
      </div>
    );
  }

  // ── camera ────────────────────────────────────────────────────────────────
  if (screen === 'CAMERA') {
    const slip = mode === 'SLIP';
    return (
      <div className="mx-auto flex min-h-screen w-full max-w-md flex-col bg-black text-white" style={FONT} data-screen="camera">
        <div className="flex items-center gap-3 px-4 pt-4">
          <button onClick={() => setScreen('TABS')} className="rounded-full bg-white/10 px-4 py-2.5 text-[16px] font-bold">‹ {t.back}</button>
          <div className="min-w-0"><div className="text-[18px] font-extrabold leading-tight">{slip ? '🧾 ' + t.camSlip : '📑 ' + t.camBill}</div><div className="text-[12px] font-semibold text-neutral-400">{slip ? t.camSlipSub : t.camBillSub}</div></div>
        </div>
        <div className="mx-4 my-3 flex flex-1 flex-col items-center justify-center gap-3 rounded-2xl bg-[radial-gradient(#3a3f4a,#15181f)]">
          <div className="grid h-[52vh] w-[70%] place-items-center rounded-xl border-[3px] border-dashed border-yellow-300"><span className="text-6xl opacity-60">{slip ? '🧾' : '📑'}</span></div>
          <p className="text-[15px] font-bold text-yellow-300">{t.frame}</p>
        </div>
        <div className="flex items-center justify-around pb-2 pt-1">
          <button onClick={() => galRef.current?.click()} className="text-[15px] font-bold text-neutral-200">🖼️ {t.gallery}</button>
          <button onClick={() => camRef.current?.click()} aria-label={t.shoot} className="h-[88px] w-[88px] rounded-full border-[6px] border-neutral-400 bg-white" data-shutter />
          <span className="w-16" />
        </div>
        <p className="pb-6 text-center text-[18px] font-extrabold">{t.shoot}</p>
        <input ref={camRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} data-cam />
        <input ref={galRef} type="file" accept={slip ? 'image/*' : 'image/*,application/pdf'} className="hidden" onChange={onPick} data-gal />
      </div>
    );
  }

  // ── confirm (slip / bill form) ────────────────────────────────────────────
  if (screen === 'CONFIRM') {
    const slip = mode === 'SLIP';
    const isPdf = shot && (shot.type === 'application/pdf' || /\.pdf$/i.test(shot.name || ''));
    const url = shot && !isPdf ? URL.createObjectURL(shot) : null;
    const chips = Array.from(new Set([...(recentTrucks), ...(form.vehicle_no ? [form.vehicle_no] : [])])).slice(0, 6);
    const Lbl = ({ children }) => <div className="mb-1 text-[11px] font-extrabold text-slate-500">{children}</div>;
    const Inp = (props) => <input {...props} className={`min-h-[46px] w-full rounded-xl border-2 border-slate-300 bg-white px-3 text-[16px] font-bold outline-none focus:border-blue-500 ${props.className ?? ''}`} />;
    const Chip = ({ on, children, onClick }) => <button type="button" onClick={onClick} className={`min-h-[38px] rounded-full border-2 px-3 text-[13px] font-extrabold ${on ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 bg-white text-slate-800'}`}>{children}</button>;
    return (
      <div className={SHELL} style={FONT} data-screen="confirm">
        <Bar title={slip ? t.confirmSlip : t.confirmBill} sub={slip ? t.confirmSlipSub : t.confirmBillSub} back={() => setScreen('CAMERA')} />
        <div className="flex flex-1 flex-col gap-2.5 px-3 pb-6 pt-3">
          <div className="flex items-center gap-3 rounded-2xl border-2 border-green-300 bg-green-50 px-3 py-2">
            {url ? <img src={url} alt="" className="h-16 w-12 rounded-md object-cover shadow" onLoad={() => URL.revokeObjectURL(url)} /> : <span className="text-3xl">📄</span>}
            <div className="min-w-0 flex-1 text-[13px] font-extrabold text-green-800">✅ {t.photoOn}<div className="truncate text-[11px] font-semibold text-green-700">{shot?.name}</div></div>
            <button onClick={() => setScreen('CAMERA')} className="min-h-[38px] rounded-full border-2 border-slate-300 bg-white px-3 text-[12px] font-extrabold">🔁 {t.retake}</button>
          </div>
          <div className={`${CARD} flex flex-col gap-2.5 px-3 py-3`}>
            {slip ? (
              <div><Lbl>{t.typeLbl}</Lbl><div className="flex flex-wrap gap-1.5">{SLIP_TYPES.map((s) => <Chip key={s.v} on={form.doc_type === s.v} onClick={() => F('doc_type', s.v)}>{s.i} {t['type_' + s.v]}</Chip>)}</div></div>
            ) : (
              <div><Lbl>{t.expLbl}</Lbl><div className="flex flex-wrap gap-1.5">{EXP_TYPES.map((s) => <Chip key={s.v} on={form.expense_type === s.v} onClick={() => F('expense_type', s.v)}>{s.i} {s.v}</Chip>)}</div></div>
            )}
            <div><Lbl>{t.truckLbl}</Lbl>
              <div className="flex flex-wrap gap-1.5">{chips.map((c) => <Chip key={c} on={form.vehicle_no === c} onClick={() => F('vehicle_no', c)}>{c}</Chip>)}</div>
              <Inp value={form.vehicle_no ?? ''} onChange={(e) => F('vehicle_no', e.target.value.toUpperCase())} placeholder="AS 01 …" className="mt-1.5 font-mono uppercase" data-truck />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {slip && form.doc_type === 'HSD_BILL' && <div><Lbl>{t.litresLbl}</Lbl><Inp inputMode="decimal" value={form.qty ?? ''} onChange={(e) => F('qty', e.target.value)} placeholder="L" data-qty /></div>}
              <div className={slip && form.doc_type === 'HSD_BILL' ? '' : 'col-span-2'}><Lbl>{t.amountLbl}</Lbl><Inp inputMode="decimal" value={form.amount ?? ''} onChange={(e) => F('amount', e.target.value)} placeholder="₹" data-amount /></div>
              <div><Lbl>{slip ? t.slipNo : t.billNo}</Lbl><Inp value={form.bill_no ?? ''} onChange={(e) => F('bill_no', e.target.value)} placeholder="#" /></div>
              <div><Lbl>{t.dateLbl}</Lbl><Inp type="date" value={form.bill_date ?? ''} onChange={(e) => F('bill_date', e.target.value)} /></div>
            </div>
            <div><Lbl>{t.remarks}</Lbl><Inp value={form.remarks ?? ''} onChange={(e) => F('remarks', e.target.value)} placeholder="…" /></div>
          </div>
          <div className="rounded-2xl bg-blue-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-blue-900">{t.confirmNote}{slip ? ' ' + t.ocrNote : ''}</div>
          {err && <div className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[13px] font-extrabold text-red-800">{err}</div>}
          <button onClick={send} disabled={busy || viewAs} className={`min-h-[66px] rounded-2xl text-[20px] font-extrabold shadow-[0_6px_0_rgba(0,0,0,0.18)] disabled:opacity-60 ${slip ? 'bg-green-600 text-white' : 'bg-amber-500 text-[#1f1300]'}`} data-send>
            {busy ? t.sending : slip ? `✅ ${t.sendSlip}` : `📤 ${t.sendBill}`}
          </button>
        </div>
      </div>
    );
  }

  if (screen === 'SENT') {
    return (
      <div className={`${SHELL} items-center justify-center bg-white px-6 text-center`} style={FONT} data-screen="sent">
        <div className="grid h-[120px] w-[120px] place-items-center rounded-full bg-green-600 text-[76px] font-black text-white">✓</div>
        <h2 className="mt-4 text-[30px] font-extrabold">{t.sent}</h2>
        <p className="text-[17px] font-semibold text-slate-600">{t.sentSub}</p>
        <span className="mt-3 rounded-full bg-amber-100 px-3 py-1.5 text-[12px] font-extrabold text-amber-800">{t.sentPill}</span>
        <p className="mt-4 text-[13.5px] text-slate-500">{t.sentNote}</p>
        <button onClick={() => openCamera(mode)} className="mt-8 w-full min-h-[64px] rounded-2xl border-[3px] border-slate-300 bg-white text-[20px] font-extrabold">📷 {t.oneMore}</button>
        <button onClick={() => { setScreen('TABS'); setTab(mode === 'SLIP' ? 'slips' : 'bills'); }} className="mt-3 w-full min-h-[64px] rounded-2xl bg-slate-900 text-[20px] font-extrabold text-white">{t.homeBtn}</button>
      </div>
    );
  }

  // ── tabs ──────────────────────────────────────────────────────────────────
  const notices = sum?.notices ?? [];
  const Home = () => (
    <div className="flex flex-col gap-2.5 px-3 pb-28 pt-2.5">
      {notices.length > 0 && notices.map((n, i) => (
        <div key={i} className="rounded-2xl border-2 border-red-300 bg-red-50 px-3 py-2.5 text-[13px] font-extrabold leading-snug text-red-800">
          ❌ {n.kind === 'SLIP' ? t.rejectedSlip : t.rejectedBill} · {ICON[n.what] ?? ''} {n.amount ? inr(n.amount) : ''} — {t.officeSaid}: “{n.reason || '—'}”
        </div>
      ))}
      <div className="grid grid-cols-3 gap-2">
        <div className={`${CARD} px-1.5 py-2 text-center`}><div className="text-[19px] font-black text-blue-600">{sum?.slips?.month ?? 0}</div><div className="mt-0.5 text-[10px] font-bold text-slate-500">{t.kSlips}</div></div>
        <div className={`${CARD} px-1.5 py-2 text-center`}><div className="text-[19px] font-black text-amber-700">{sum?.bills?.pending ?? 0}</div><div className="mt-0.5 text-[10px] font-bold text-slate-500">{t.kPending}</div></div>
        <div className={`${CARD} px-1.5 py-2 text-center`}><div className={`text-[19px] font-black ${showLedger ? 'text-red-600' : 'text-slate-400'}`}>{showLedger ? inrShort(ledger?.current_balance) : '🔒'}</div><div className="mt-0.5 text-[10px] font-bold text-slate-500">{showLedger ? t.kDue : t.locked}</div></div>
      </div>
      <div className={`${CARD} px-3 pb-1 pt-2`}>
        <div className="flex items-center justify-between text-[12.5px] font-extrabold text-slate-700">{t.payStatus}<span className="text-[10.5px] font-semibold text-slate-500">{sum?.fy_label ?? ''}</span></div>
        <Row ic="🧾" l={t.raised} s={`${sum?.bills?.fy_count ?? 0} ${t.bills_n} · ${sum?.bills?.pending ?? 0} ${t.pendingOffice}`} v={inr(sum?.bills?.fy_raised)} tone="text-blue-600" />
        <Row ic="✅" l={t.approved} s="" v={inr(sum?.bills?.fy_approved)} tone="text-green-700" />
        <Row ic="📒" l={t.posted} s={showLedger && ledger?.last_payment ? `${t.lastPay}: ${dmy(ledger.last_payment.txn_date)} · ${inr(ledger.last_payment.amount)}` : ''} v={inr(sum?.bills?.fy_posted)} tone="text-green-700" />
        {showLedger ? (
          <Row ic="⏳" l={t.due} s={me?.payment_terms ? `${t.terms} ${me.payment_terms}` : ''} v={inr(ledger?.current_balance)} tone="text-red-600" sub={t.officeOwes}
            bar={ledger && Number(ledger.fy_billed) > 0 ? Math.min(1, Number(ledger.fy_paid) / Number(ledger.fy_billed)) : 0} />
        ) : (
          <div className="flex items-center gap-2 border-t border-slate-100 py-2 text-[12px] font-bold text-slate-500">🔒 {t.due} — {t.locked}</div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Tile tone="bg-violet-600 text-white" icon="🧾" label={t.tSlip} sub={t.tSlipSub} onClick={() => openCamera('SLIP')} />
        <Tile tone="bg-amber-500 text-[#1f1300]" icon="📑" label={t.tBill} sub={t.tBillSub} badge={sum?.bills?.rejected || null} onClick={() => openCamera('BILL')} />
        <Tile tone="bg-green-600 text-white" icon="💰" label={t.tPay} sub={t.tPaySub} onClick={() => setTab('pay')} />
        <Tile tone="bg-blue-600 text-white" icon="📂" label={t.tStmt} sub={t.tStmtSub} onClick={() => setTab('acct')} />
      </div>
      <CallBar />
    </div>
  );
  const Row = ({ ic, l, s, v, tone, sub, bar }) => (
    <div className="grid grid-cols-[22px_1fr_auto] items-center gap-2 border-t border-slate-100 py-1.5">
      <span className="text-[18px]">{ic}</span>
      <div><div className="text-[12.5px] font-extrabold leading-tight">{l}</div>{s && <div className="text-[10.5px] font-semibold text-slate-500">{s}</div>}
        {bar != null && <div className="mt-1 h-[5px] overflow-hidden rounded bg-slate-200"><i className="block h-full bg-blue-600" style={{ width: `${Math.round(bar * 100)}%` }} /></div>}</div>
      <div className={`min-w-[64px] text-right text-[18px] font-black leading-none ${tone}`}>{v}{sub && <div className="mt-0.5 text-[9.5px] font-bold text-slate-500">{sub}</div>}</div>
    </div>
  );

  const slipList = (docs ?? []).filter((d) => seg === 'ALL' || d.status === seg);
  const Slips = () => (
    <div className="relative flex flex-col gap-2 px-3 pb-28 pt-2.5">
      <Seg value={seg} onChange={setSeg} items={[['ALL', t.all], ['PENDING', `${t.pending} ${sum?.slips?.pending ?? 0}`], ['APPROVED', t.approvedS], ['REJECTED', `${t.rejected} ${sum?.slips?.rejected ?? 0}`]]} />
      {docs == null && <p className="p-4 text-center text-[13px] text-slate-500">…</p>}
      {docs && slipList.length === 0 && <p className="p-6 text-center text-[13.5px] font-semibold text-slate-500">{t.noSlips}</p>}
      {slipList.map((d) => {
        const ocr = d.ocr;
        const diff = ocr && ((ocr.amount != null && d.amount != null && Math.abs(Number(ocr.amount) - Number(d.amount)) >= 1) || (ocr.qty != null && d.qty != null && Math.abs(Number(ocr.qty) - Number(d.qty)) >= 0.5));
        const tone = d.status === 'REJECTED' ? 'border-red-300 bg-red-50' : d.status === 'PENDING' ? 'border-amber-300 bg-amber-50' : d.expense_approval_id ? 'border-green-300 bg-green-50' : 'border-slate-200 bg-white';
        return (
          <div key={d.id} className={`flex flex-col gap-1.5 rounded-2xl border-2 px-3 py-2.5 ${tone}`} data-slip={d.id}>
            <div className="flex items-center gap-2.5">
              <span className="text-[28px] leading-none">{ICON[d.doc_type] ?? '🧾'}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-extrabold leading-tight"><Truck n={d.vehicle_no} /> {!d.vehicle_no && (t['type_' + d.doc_type] ?? d.doc_type)}</div>
                <div className="text-[11.5px] font-semibold text-slate-500">{dmy(d.bill_date ?? d.created_at)}{d.qty != null ? ` · ${litres(d.qty)}` : ''}{d.bill_no ? ` · #${d.bill_no}` : ''} · {t['type_' + d.doc_type] ?? d.doc_type}</div>
              </div>
              <div className="text-right"><div className="text-[16px] font-black leading-none">{d.amount != null ? inr(d.amount) : ''}</div><div className="mt-1"><Pill s={d.status} label={d.status === 'APPROVED' && d.expense_approval_id ? 'IN BILL' : d.status} /></div></div>
            </div>
            {d.status === 'PENDING' && d.ocr_status !== 'DONE' && <div className="text-[11px] font-bold text-slate-500">🤖 {t.ocrWait}</div>}
            {ocr && <div className={`rounded-xl px-2.5 py-1.5 text-[11.5px] font-bold ${diff ? 'bg-amber-100 text-amber-900' : 'bg-cyan-50 text-cyan-900'}`}>🤖 {t.ocrRead}: {ocr.vehicle_no ?? ''} {ocr.qty != null ? litres(ocr.qty) : ''} {ocr.amount != null ? inr(ocr.amount) : ''}{ocr.score != null ? ` · ${ocr.score}%` : ''}{diff ? ` — ${t.ocrDiff}` : ''}</div>}
            {d.status === 'REJECTED' && <div className="rounded-xl border-2 border-red-300 bg-white px-2.5 py-1.5 text-[12.5px] font-extrabold text-red-800">❌ {t.officeSaid}: “{d.reject_reason || '—'}”</div>}
            <div className="flex gap-2">
              <button onClick={() => openFile(`/files/${d.file_key}`).catch((e) => say(e.message))} className="min-h-[40px] flex-1 rounded-xl border-2 border-slate-300 bg-white text-[13.5px] font-extrabold">👁 {t.view}</button>
              {d.status === 'REJECTED' && <button onClick={() => openCamera('SLIP', { doc_type: d.doc_type, vehicle_no: d.vehicle_no ?? '', qty: d.qty ?? '', amount: d.amount ?? '', bill_no: d.bill_no ?? '' })} className="min-h-[40px] flex-1 rounded-xl bg-blue-600 text-[13.5px] font-extrabold text-white">📷 {t.resend}</button>}
            </div>
          </div>
        );
      })}
      <button onClick={() => openCamera('SLIP')} className="fixed bottom-[86px] right-4 z-30 min-h-[52px] rounded-full bg-blue-600 px-5 text-[15px] font-extrabold text-white shadow-[0_8px_20px_rgba(37,99,235,0.45)]" data-fab>📷 {lang === 'hi' ? 'नई पर्ची' : 'New slip'}</button>
    </div>
  );

  const billList = (bills ?? []).filter((b) => bseg === 'ALL' || (bseg === 'POSTED' ? b.posted : b.status === bseg));
  const stepOf = (b) => (b.status === 'REJECTED' ? 0 : b.posted ? 3 : b.status === 'APPROVED' ? 2 : 1);
  const Bills = () => (
    <div className="flex flex-col gap-2 px-3 pb-28 pt-2.5">
      <Seg value={bseg} onChange={setBseg} items={[['ALL', t.all], ['PENDING', `${t.pending} ${sum?.bills?.pending ?? 0}`], ['APPROVED', t.approvedS], ['POSTED', t.stPosted]]} />
      {bills == null && <p className="p-4 text-center text-[13px] text-slate-500">…</p>}
      {bills && billList.length === 0 && <p className="p-6 text-center text-[13.5px] font-semibold text-slate-500">{t.noBills}</p>}
      {billList.map((b) => {
        const tone = b.status === 'REJECTED' ? 'border-red-300 bg-red-50' : b.posted ? 'border-green-300 bg-green-50' : b.status === 'PENDING' ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white';
        const open = openBill === b.id;
        return (
          <div key={b.id} className={`flex flex-col gap-1.5 rounded-2xl border-2 px-3 py-2.5 ${tone}`} onClick={() => setOpenBill(open ? null : b.id)} data-bill={b.id}>
            <div className="flex items-center gap-2.5">
              <span className="text-[28px] leading-none">{ICON[b.expense_type] ?? '🧾'}</span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-extrabold leading-tight">{b.bill_no ? `Bill ${b.bill_no}` : b.expense_type} · {b.expense_type}</div>
                <div className="text-[11.5px] font-semibold text-slate-500"><Truck n={b.vehicle_no} /> {dmy(b.bill_date ?? b.created_at)}{b.posted ? ' · ' + t.postedAt : ''}</div>
              </div>
              <div className="text-[16px] font-black">{inr(b.amount)}</div>
            </div>
            <Steps n={stepOf(b)} />
            {b.status === 'REJECTED' && (
              <>
                <div className="rounded-xl border-2 border-red-300 bg-white px-2.5 py-1.5 text-[12.5px] font-extrabold text-red-800">❌ {t.officeSaid}: “{b.reject_reason || '—'}”</div>
                <button onClick={(e) => { e.stopPropagation(); openCamera('BILL', { expense_type: b.expense_type, amount: b.amount ?? '', bill_no: b.bill_no ?? '', vehicle_no: b.vehicle_no ?? '', bill_date: b.bill_date ? String(b.bill_date).slice(0, 10) : today() }); }} className="min-h-[42px] rounded-xl bg-blue-600 text-[14.5px] font-extrabold text-white">📷 {t.resend}</button>
              </>
            )}
            {open && (
              <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 rounded-xl bg-white/70 px-2.5 py-2 text-[12.5px]">
                <span className="text-slate-500">{t.submitted}</span><b>{dmyt(b.created_at)}</b>
                <span className="text-slate-500">{t.approvedAt}</span><b className={b.approved_at ? '' : 'text-amber-700'}>{b.status === 'REJECTED' ? '—' : b.approved_at ? dmyt(b.approved_at) : '⏳ ' + t.reviewing}</b>
                <span className="text-slate-500">{t.postedAt}</span><b>{b.posted ? '✓' : '—'}</b>
                {b.description && <><span className="text-slate-500">{t.note}</span><b className="text-right">{String(b.description).replace(/^\[[^\]]*\]\s*/, '')}</b></>}
                {b.file_key && <button onClick={(e) => { e.stopPropagation(); openFile(`/files/${b.file_key}`).catch((er) => say(er.message)); }} className="col-span-2 mt-1 min-h-[40px] rounded-xl border-2 border-slate-300 bg-white text-[13.5px] font-extrabold">👁 {t.view}</button>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  const TXN = { PAYMENT_GIVEN: ['🏦', 'payment', '+', 'text-green-700'], BILL_RECEIVED: ['🧾', 'billRecv', '', ''], CREDIT_NOTE: ['↩️', 'creditNote', '−', 'text-red-600'], ADJUSTMENT: ['⚖️', 'adjustment', '', ''], OPENING: ['📘', 'opening', '', ''] };
  const statement = async () => { try { await openFile('/portal/vendor/statement.pdf'); } catch (e) { say(e.message); } };
  const Pay = () => (
    <div className="flex flex-col gap-2.5 px-3 pb-28 pt-2.5">
      {!showLedger ? (
        <div className="grid min-h-[50vh] place-items-center text-center">
          <div><div className="text-5xl">🔒</div><h3 className="mt-3 text-[18px] font-extrabold">{t.payLocked}</h3><p className="mt-2 text-[13px] font-semibold text-slate-500">{t.payLockedSub}</p>
            <a href={DISPATCH_TEL} className="mt-5 block rounded-2xl bg-slate-900 py-3 text-[16px] font-extrabold text-white">📞 {t.call}</a></div>
        </div>
      ) : (
        <>
          <div className={`${CARD} px-3 pb-1 pt-2`}>
            <div className="flex items-center justify-between text-[12.5px] font-extrabold text-slate-700">{t.account}<span className="text-[10.5px] font-semibold text-slate-500">{sum?.fy_label ?? ''}</span></div>
            <Row ic="🧾" l={t.billsIn} s="" v={inr(ledger?.fy_billed)} tone="text-blue-600" />
            <Row ic="🏦" l={t.paidIn} s={`${ledger?.fy_payments ?? 0} ${t.payment}`} v={inr(ledger?.fy_paid)} tone="text-green-700" />
            <Row ic="⏳" l={t.due} s={me?.payment_terms ? `${t.terms} ${me.payment_terms}` : ''} v={inr(ledger?.current_balance)} tone="text-red-600" />
          </div>
          <button onClick={statement} className="min-h-[44px] rounded-xl bg-blue-600 text-[14.5px] font-extrabold text-white">📄 {t.statement}</button>
          <div className="mt-1 text-[12px] font-extrabold text-slate-700">{t.txns}</div>
          {txns == null && <p className="p-3 text-center text-[13px] text-slate-500">…</p>}
          {txns && (txns.transactions ?? []).length === 0 && <p className="p-4 text-center text-[13px] font-semibold text-slate-500">{t.noTxns}</p>}
          {(txns?.transactions ?? []).map((x) => {
            const [ic, key, sign, tone] = TXN[x.txn_type] ?? ['📎', 'adjustment', '', ''];
            const ok = x.approval_status === 'APPROVED';
            return (
              <div key={x.id} className={`flex items-center gap-2.5 rounded-2xl border-2 px-3 py-2.5 ${x.txn_type === 'PAYMENT_GIVEN' && ok ? 'border-green-300 bg-green-50' : 'border-slate-200 bg-white'}`}>
                <span className="text-[26px] leading-none">{ic}</span>
                <div className="min-w-0 flex-1"><div className="text-[14.5px] font-extrabold leading-tight">{t[key]}{x.payment_mode ? ` · ${x.payment_mode}` : ''}</div>
                  <div className="truncate text-[11.5px] font-semibold text-slate-500">{dmy(x.txn_date)}{x.remarks ? ` · ${x.remarks}` : ''}{!ok ? ` · ${t.awaiting}` : ''}</div></div>
                <div className={`text-[16px] font-black ${ok ? tone : 'text-slate-400'}`}>{sign}{inr(x.amount)}</div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );

  const logout = async () => {
    try { await api('/auth/logout', { method: 'POST', body: '{}' }); } catch { /* best effort */ }
    localStorage.removeItem('prasad_token');
    window.location.reload();
  };
  const KV = ({ k, v }) => <><span className="text-slate-500">{k}</span><b className="text-right">{v ?? '—'}</b></>;
  const Acct = () => (
    <div className="flex flex-col gap-2.5 px-3 pb-28 pt-2.5">
      <div className="rounded-2xl border-2 border-green-300 bg-green-50 px-3 py-2.5 text-[13px] font-extrabold text-green-800">✅ {t.approvedPortal} · {me?.gst_no ? `GST ${me.gst_no}` : ''}</div>
      <div className={`${CARD} grid grid-cols-[1fr_auto] gap-x-3 gap-y-1.5 px-3 py-3 text-[12.5px]`}>
        <KV k={t.name} v={me?.name} /><KV k={t.type} v={`${t.vendor} · ${me?.vendor_type ?? 'SERVICE'}`} /><KV k={t.terms} v={me?.payment_terms} /><KV k={t.mobile} v={me?.mobile_no} /><KV k={t.address} v={me?.address} />
        <span className="text-slate-500">{t.language}</span><button onClick={toggleLang} className="text-right font-extrabold text-blue-700">{lang === 'hi' ? 'हिंदी · EN' : 'English · हिं'}</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Tile tone={showLedger ? 'bg-blue-600 text-white' : 'bg-slate-300 text-slate-600'} icon="📄" label={t.tStmt} sub={showLedger ? 'PDF' : t.locked} onClick={showLedger ? statement : () => setTab('pay')} />
        <Tile tone="bg-teal-600 text-white" icon="📞" label={t.officeSaid} sub={DISPATCH_DISPLAY} onClick={() => { window.location.href = DISPATCH_TEL; }} />
      </div>
      <div className="rounded-2xl bg-blue-50 px-3 py-2.5 text-[12.5px] font-semibold leading-snug text-blue-900">{t.profileNote}</div>
      <button onClick={logout} className="min-h-[46px] rounded-2xl border-2 border-slate-300 bg-white text-[15px] font-extrabold">🚪 {t.logout}</button>
    </div>
  );

  const titles = { home: null, slips: [t.slipsTitle, `${sum?.slips?.month ?? 0} ${t.slipsSub} · ${t.tapOpen}`], bills: [t.billsTitle, t.billsSub], pay: [t.payTitle, t.paySub], acct: [t.account, t.profile] };
  return (
    <div className={SHELL} style={FONT} data-screen={tab}>
      {tab === 'home' ? (
        <div className="flex items-center gap-2.5 border-b border-slate-200 bg-white px-4 py-2.5">
          <div className="min-w-0 flex-1"><div className="text-[10px] font-bold tracking-wide text-slate-500">{t.brand}</div><div className="truncate text-[17px] font-extrabold leading-tight">{me?.name ?? sum?.vendor?.name ?? t.vendor}</div>
            <div className="text-[11px] font-semibold text-slate-500">{t.vendor} · {me?.vendor_type ?? 'Service'}{me?.address ? ` · ${String(me.address).split(',')[0]}` : ''}</div></div>
          <button onClick={toggleLang} className="min-h-[38px] rounded-full bg-slate-100 px-3 text-[12px] font-bold">{lang === 'hi' ? 'हिं · EN' : 'EN · हिं'}</button>
        </div>
      ) : <Bar title={titles[tab][0]} sub={titles[tab][1]} back={() => setTab('home')} />}
      {viewAs && <div className="mx-3 mt-2 rounded-xl border-2 border-violet-300 bg-violet-50 px-3 py-2 text-[12px] font-bold text-violet-900">👁 {t.preview}</div>}
      {tab === 'home' && <Home />}
      {tab === 'slips' && <Slips />}
      {tab === 'bills' && <Bills />}
      {tab === 'pay' && <Pay />}
      {tab === 'acct' && <Acct />}
      {toast && <div className="fixed bottom-24 left-1/2 z-50 w-[90%] max-w-md -translate-x-1/2 rounded-2xl bg-slate-900 px-4 py-3 text-[15px] font-extrabold text-white shadow-xl">{toast}</div>}
      <Nav />
    </div>
  );
}
