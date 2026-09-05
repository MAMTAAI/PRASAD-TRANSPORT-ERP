// @ts-nocheck
// ⏳ PENDING EXPENSES — retroactive trip-expense queue with ADMIN approval.
// Ground reality: the truck unloads today, but the HSD pump bill and toll
// receipts reach the office days later. Staff file them here against the trip;
// nothing touches the books until an Admin approves — then the journal posts,
// the trip's P&L is retro-adjusted and a COMPLETED trip's settlement is
// re-finalized (all idempotent, closed accounts never double-post).
import React, { useState, useEffect, useMemo } from 'react';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
import { currentUser, isAdmin as isAdminRole } from './lib/rbac';
import { extractJsonFromImage } from './lib/aiScanner';
import {
  submitRetroExpense, approveRetroExpense, rejectRetroExpense,
  matchTripForBill, classifyExpenseType, parseDocDate, fetchTripsForMatching,
  EXPENSE_TYPE_META, normalizeVehicleNo,
} from './lib/postTripEngine';
import { getField, toISODate } from './lib/accounting/tripMath';
import BottomSheet from './ui/BottomSheet';
// The Smart Approval Desk drawer (2026-09-02): the bill rendered in place,
// fields editable beside it, Approve / Reject / Print next to the paper.
import ApprovalDrawer from './components/ApprovalDrawer';
import { partnerDocDrawerProps } from './components/ApprovalDesk';

const STATUS_META = {
  PENDING: { label: 'Pending Approval', color: '#ffb224', bg: 'rgba(255, 178, 36,0.12)' },
  APPROVED: { label: 'Approved & Posted', color: '#2fe39b', bg: 'rgba(47, 227, 155,0.12)' },
  REJECTED: { label: 'Rejected', color: '#ff6b81', bg: 'rgba(255, 107, 129,0.12)' },
};

const emptyForm = {
  expense_type: 'FUEL', vendor_name: '', bill_no: '',
  bill_date: new Date().toISOString().split('T')[0], amount: '', gst_amount: '', description: '',
};

// ── Phone uploads from the driver & partner apps ────────────────────────────
// One card per photographed paper. "View" opens the photo (token-fetched);
// Approve verifies it — and for a bill, files it into expense_approvals so it
// appears in the queue below for the money approval. Reject demands the reason
// the uploader is told on WhatsApp.
const DOC_LABEL = {
  LOADING_INVOICE: '📄 Loading invoice', CHALLAN: '🧾 Challan', POD: '📦 POD',
  HSD_BILL: '⛽ HSD bill', TYRE_BILL: '🛞 Tyre bill', MAINTENANCE_BILL: '🔧 Maintenance bill',
  TOLL_BILL: '🛣️ Toll bill', OTHER_BILL: '🧾 Bill', KYC: '🪪 KYC', OTHER_DOC: '📎 Document',
};
const BILL_TYPES = new Set(['HSD_BILL', 'TYRE_BILL', 'MAINTENANCE_BILL', 'TOLL_BILL', 'OTHER_BILL']);

// Module-level so every panel on this screen can open a file from the vault:
// a plain <a href> would arrive without the bearer token and 401, so the file
// is fetched with it and opened as a blob (the same rule as the POD link).
async function viewBillFile(key) {
  try {
    const token = localStorage.getItem('prasad_token');
    const r = await fetch(`${API}/api/v1/files/${key}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!r.ok) { alert(`Bill nahi khuli (${r.status})`); return; }
    const blob = await r.blob();
    window.open(URL.createObjectURL(blob), '_blank', 'noopener');
  } catch (e) { alert('Bill nahi khuli: ' + (e as any).message); }
}

function PartnerDocsQueue({ userName, onFiled }) {
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState('');
  const [amounts, setAmounts] = useState({});
  const [open, setOpen] = useState(null);   // the upload open in the drawer
  const authed = (path, opts = {}) => {
    const token = localStorage.getItem('prasad_token');
    return fetch(`${API}/api/v1${path}`, {
      ...opts,
      headers: { ...(opts.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  };
  const load = async () => {
    try {
      const r = await authed('/queues/partner-documents?status=PENDING');
      if (r.ok) setDocs((await r.json()).documents ?? []);
    } catch (e) { console.error('partner docs read:', e.message); }
  };
  useEffect(() => { load(); }, []);

  // "View" opens the drawer: photo/PDF in place, fields editable beside it,
  // Verify / Reject / Print next to the paper.
  const viewPhoto = (doc) => setOpen(doc);

  const decideWith = async (doc, action, body) => {
    setBusy(doc.id);
    try {
      const r = await authed(`/queues/partner-documents/${doc.id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewed_by: userName, ...body }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.detail ?? j.error ?? `HTTP ${r.status}`);
      if (action === 'approve' && j.expenseId) onFiled?.();
      await load();
      return j;
    } finally { setBusy(''); }
  };

  // The quick buttons on the card keep working without opening the drawer.
  const decide = async (doc, action) => {
    try {
      if (action === 'reject') {
        const reason = window.prompt('Reject kyon? (yeh kaaran uploader ko WhatsApp par jayega)');
        if (!reason) return;
        await decideWith(doc, 'reject', { reason });
      } else {
        const isBill = BILL_TYPES.has(doc.doc_type);
        const amt = Number(amounts[doc.id] ?? doc.amount);
        if (isBill && !(amt > 0)) { alert('⚠️ Bill ka amount bharein — tabhi expense queue mein jayega.'); return; }
        if (!window.confirm(`Approve ${DOC_LABEL[doc.doc_type] ?? doc.doc_type} from ${doc.uploader_name}?${isBill ? ` ₹${amt.toLocaleString('en-IN')} expense queue mein file hoga.` : ''}`)) return;
        await decideWith(doc, 'approve', isBill ? { amount: amt } : {});
      }
    } catch (e) { alert('❌ ' + e.message); }
  };

  return (
    <div className="pt-anim-up" style={{ marginBottom: '22px', padding: '16px 18px', borderRadius: '14px', background: 'rgba(255, 178, 36,0.05)', border: '1px solid rgba(255, 178, 36,0.3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <b style={{ color: '#ffb224', fontSize: '14px' }}>📱 App Uploads — Driver & Partner ({docs.length} pending)</b>
        <button className="pt-btn" style={{ minHeight: '36px', fontSize: '12px' }} onClick={load}>↻ Refresh</button>
      </div>
      {docs.length === 0 ? (
        <div style={{ color: '#5d7196', fontSize: '13px' }}>Koi naya upload nahi. Driver/partner app se bheja har kagaz yahan aayega — approve hone par hi system mein lagega.</div>
      ) : docs.map((d) => (
        <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(10, 16, 36,0.5)', border: '1px solid #18244a', marginBottom: '8px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '220px' }}>
            <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#fff' }}>
              {DOC_LABEL[d.doc_type] ?? d.doc_type} · <span style={{ color: '#22d3ee' }}>{d.uploader_name}</span>
              <span style={{ color: '#5d7196', fontWeight: 'normal' }}> ({d.uploader_role.toLowerCase()})</span>
            </div>
            <div style={{ fontSize: '11px', color: '#9aadd4' }}>
              {new Date(d.created_at).toLocaleString('en-IN')}
              {d.trip_code ? ` · trip ${d.trip_code}` : ''}{d.bill_no ? ` · bill ${d.bill_no}` : ''}
              {d.remarks ? ` · ${d.remarks}` : ''}
            </div>
          </div>
          {BILL_TYPES.has(d.doc_type) && (
            <input className="glass-input" type="number" placeholder="₹ amount"
              style={{ width: '110px', padding: '8px' }}
              value={amounts[d.id] ?? d.amount ?? ''}
              onChange={(e) => setAmounts((p) => ({ ...p, [d.id]: e.target.value }))} />
          )}
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="pt-btn" style={{ minHeight: '36px', fontSize: '12px', color: '#a78bfa' }}
                    onClick={() => viewPhoto(d)}>🔍 View</button>
            <button className="pt-btn pt-btn--success" style={{ minHeight: '36px', fontSize: '12px' }}
                    disabled={busy === d.id} onClick={() => decide(d, 'approve')}>✅ Approve</button>
            <button className="pt-btn" style={{ minHeight: '36px', fontSize: '12px', color: '#ff6b81', borderColor: '#ef444455' }}
                    disabled={busy === d.id} onClick={() => decide(d, 'reject')}>✖ Reject</button>
          </div>
        </div>
      ))}

      {/* The same Milan drawer the embedded desk uses: photo, OCR read, the
          admin's values side by side; the server applies them on approve. */}
      {open && (() => {
        const p = partnerDocDrawerProps({ ...open, amount: amounts[open.id] ?? open.amount }, {
          userName, decide: (action, body) => decideWith(open, action, body),
        });
        return (
          <ApprovalDrawer
            open
            onClose={() => setOpen(null)}
            {...p}
            onApprove={async (edits) => { await p.onApprove(edits); setOpen(null); }}
            onReject={async (reason) => { await p.onReject(reason); setOpen(null); }}
          />
        );
      })()}
    </div>
  );
}

// ── The generic maker-checker deck ──────────────────────────────────────────
// Reads v_approval_queue via /api/v1/approvals/pending: vendor bills, TDS,
// EMI, toll claims, fuel entries — anything under 061's maker-checker that a
// maker has submitted. Approve commits (and posts where postOnApproval
// applies); Reject demands a reason. Both are stamped with who and when, and
// the history is one click away in approval_audit.
function MakerCheckerQueue({ isAdmin }) {
  const [q, setQ] = useState({ rows: [], total: null });
  const [busy, setBusy] = useState('');
  const authed = (path, opts = {}) => {
    const token = localStorage.getItem('prasad_token');
    return fetch(`${API}/api/v1${path}`, {
      ...opts,
      headers: { ...(opts.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  };
  const load = async () => {
    try {
      const r = await authed('/approvals/pending');
      if (r.ok) setQ(await r.json());
    } catch (e) { console.error('approval queue read:', e.message); }
  };
  useEffect(() => { load(); }, []);

  const decide = async (row, action) => {
    let reason = null;
    if (action === 'reject') {
      reason = window.prompt('Reject kyon? (reason maker ko dikhega aur audit me jayega)');
      if (!reason) return;
    } else if (!window.confirm(`Approve "${row.subject ?? row.source_table}"${row.amount ? ` — ₹${Number(row.amount).toLocaleString('en-IN')}` : ''}? Yeh row lock ho jayegi.`)) return;
    setBusy(row.id);
    try {
      const r = await authed(`/approvals/${row.source_table}/${row.id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'reject' ? { reason } : {}),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) alert('❌ ' + (j.detail ?? j.error ?? r.status));
      await load();
    } finally { setBusy(''); }
  };

  return (
    <div className="pt-anim-up" style={{ marginBottom: '22px', padding: '16px 18px', borderRadius: '14px', background: 'rgba(34, 211, 238,0.05)', border: '1px solid rgba(34, 211, 238,0.25)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <b style={{ color: '#22d3ee', fontSize: '14px' }}>
          🛃 Maker-Checker Queue ({q.rows.length}{q.total?.amount ? ` · ₹${Number(q.total.amount).toLocaleString('en-IN')} pending` : ''})
        </b>
        <button className="pt-btn" style={{ minHeight: '36px', fontSize: '12px' }} onClick={load}>↻ Refresh</button>
      </div>
      {q.rows.length === 0 ? (
        <div style={{ color: '#5d7196', fontSize: '13px' }}>Koi submitted entry approval ka intezaar nahi kar rahi. Vendor bills, TDS, EMI, toll claims — sab clear.</div>
      ) : q.rows.map((row) => (
        <div key={`${row.source_table}-${row.id}`} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(10, 16, 36,0.5)', border: '1px solid #18244a', marginBottom: '8px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '220px' }}>
            <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#fff' }}>{row.subject ?? row.source_table}</div>
            <div style={{ fontSize: '11px', color: '#9aadd4' }}>
              {row.source_table} · submitted {row.submitted_at ? new Date(row.submitted_at).toLocaleString('en-IN') : '—'}
            </div>
          </div>
          {row.amount != null && (
            <div style={{ fontSize: '15px', fontWeight: 900, color: '#ffb224' }}>₹{Number(row.amount).toLocaleString('en-IN')}</div>
          )}
          {isAdmin ? (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="pt-btn pt-btn--success" style={{ minHeight: '36px', fontSize: '12px' }}
                      disabled={busy === row.id} onClick={() => decide(row, 'approve')}>✅ Approve</button>
              <button className="pt-btn" style={{ minHeight: '36px', fontSize: '12px', color: '#ff6b81', borderColor: '#ef444455' }}
                      disabled={busy === row.id} onClick={() => decide(row, 'reject')}>✖ Reject</button>
            </div>
          ) : (
            <span style={{ fontSize: '11px', color: '#5d7196' }}>admin approval required</span>
          )}
        </div>
      ))}
    </div>
  );
}

export default function PendingExpenses() {
  const user = currentUser();
  const isAdmin = isAdminRole(user);
  const userName = user?.full_name || user?.name || user?.email || 'staff';

  const [rows, setRows] = useState([]);
  const [statusTab, setStatusTab] = useState('PENDING');
  const [busyId, setBusyId] = useState('');
  // The three operating firms, and the one picked per pending card. Loaded once
  // — the list is three rows and does not change mid-session (owner, 3-Sep).
  const [companies, setCompanies] = useState([]);
  const [pickedCo, setPickedCo] = useState({});
  useEffect(() => {
    fetch(`${API}/api/v1/finance/masters/companies`, {
      headers: { ...(localStorage.getItem('prasad_token') ? { Authorization: `Bearer ${localStorage.getItem('prasad_token')}` } : {}) },
    })
      .then((r) => (r.ok ? r.json() : { companies: [] }))
      .then((j) => setCompanies(j.companies ?? []))
      .catch(() => setCompanies([]));
  }, []);
  const [view, setView] = useState(null);   // the expense open in the approval drawer

  // Edit-before-approve: the pending row is corrected first (PATCH, admin only,
  // refused once it is no longer PENDING), so the voucher carries the fixed figures.
  const patchExpense = async (id, edits) => {
    const token = localStorage.getItem('prasad_token');
    const body = Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, v === '' ? null : v]));
    const r = await fetch(`${API}/api/v1/queues/expenses/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.detail ?? j.error ?? `HTTP ${r.status}`);
    return j;
  };

  // ── Entry form state ──
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [tripSearch, setTripSearch] = useState('');
  const [pickedTrip, setPickedTrip] = useState(null);
  const [allTrips, setAllTrips] = useState([]);
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState('');

  // Was an onSnapshot listener; now a fetch on mount plus after each decision.
  // Exposed as `reload` so approve/reject refresh the queue they just changed.
  const reload = async () => {
    try {
      const res = await fetch(`${API}/api/v1/queues/expenses`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      setRows(j.expenses ?? []);
    } catch (e) { console.error('expense queue read:', (e as any)?.message); }
  };
  useEffect(() => { reload(); }, []);

  // ⛽ FUEL PENDING (2026-07-19 R&D): asli "pending expense" fuel slips hain —
  // memo se liters record hote hain par ₹ value pump ke PHYSICAL BILL ke
  // reconcile hone par hi banti hai. Yahan unka live count dikhta hai taaki
  // "sab 0 hai, system kharab hai" wala confusion na ho.
  const [fuelPending, setFuelPending] = useState({ count: 0, liters: 0, value: 0 });
  useEffect(() => {
    (async () => {
      try {
        // Three integers computed in SQL. The Firestore listener streamed the
        // whole fuel register to the browser to reduce it here.
        const res = await fetch(`${API}/api/v1/queues/fuel-pending`);
        if (!res.ok) return;
        const f = await res.json();
        setFuelPending({
          count: f.count ?? 0,
          liters: Math.round(Number(f.liters) || 0),
          value: Math.round(Number(f.value) || 0),
        });
      } catch (e) { console.error('fuel pending read:', (e as any)?.message); }
    })();
  }, []);

  const ensureTrips = async () => {
    if (allTrips.length) return allTrips;
    const t = await fetchTripsForMatching();
    setAllTrips(t);
    return t;
  };

  // ── AI scan → prefill form + auto-match trip ──
  const handleScan = async (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = '';
    setScanning(true); setScanNote('');
    try {
      const prompt = `Extract from this purchase/vendor/fuel-pump/toll bill and reply ONLY JSON:
{ "vendor_name": "", "bill_no": "", "bill_date": "DD-MM-YYYY", "vehicle_no": "", "total_amount": 0, "gst_amount": 0, "description": "" }
vehicle_no: Indian plate on the bill if printed (e.g. AS26C5102), else "". Empty string / 0 if absent.`;
      const ai = await extractJsonFromImage(file, prompt);
      const amount = Number(String(ai.total_amount).replace(/[^0-9.]/g, '')) || 0;
      const dateISO = parseDocDate(ai.bill_date);
      const etype = classifyExpenseType(`${ai.vendor_name} ${ai.description}`);
      setForm(f => ({
        ...f, expense_type: etype,
        vendor_name: ai.vendor_name || '', bill_no: ai.bill_no || '',
        bill_date: dateISO || f.bill_date, amount: amount ? String(amount) : '',
        gst_amount: ai.gst_amount ? String(ai.gst_amount) : '', description: ai.description || '',
      }));
      const veh = normalizeVehicleNo(ai.vehicle_no);
      if (veh) {
        const trips = await ensureTrips();
        const m = matchTripForBill(trips, veh, dateISO);
        if (m.trip) {
          setPickedTrip(m.trip);
          setScanNote(m.confidence === 'MATCHED'
            ? `🎯 Trip auto-matched: ${getField(m.trip, ['trip_id', 'Trip_ID'])} (${veh})`
            : `⚠️ ${m.candidates.length} trips possible for ${veh} — best guess selected, please verify.`);
        } else {
          setTripSearch(veh);
          setScanNote(`⚠️ ${veh} ka koi trip match nahi mila — neeche se select karein.`);
        }
      }
      setShowForm(true);
    } catch (err) {
      const offline = err?.name === 'LLMOfflineError' || /ollama|engine|reach/i.test(err?.message || '');
      alert(offline ? '❌ Local AI engine (Ollama) band hai.' : '❌ Bill padhi nahi gayi — saaf photo/PDF se try karein.');
    }
    setScanning(false);
  };

  // ── Trip picker ──
  const tripOptions = useMemo(() => {
    const q = tripSearch.trim().toLowerCase();
    if (q.length < 2) return [];
    return allTrips.filter(t => {
      const hay = `${getField(t, ['trip_id', 'Trip_ID']) || ''} ${getField(t, ['vehicle_no', 'Vehical_No', 'vehical_no']) || ''} ${getField(t, ['driver_name', 'Driver_Name']) || ''} ${getField(t, ['consignee_name', 'Consignee_Name']) || ''}`.toLowerCase();
      return hay.includes(q);
    }).slice(0, 8);
  }, [tripSearch, allTrips]);

  const openForm = async () => { setShowForm(true); setScanNote(''); await ensureTrips(); };

  const handleSubmit = async () => {
    const amount = parseFloat(form.amount) || 0;
    if (amount <= 0) return alert('⚠️ Bill amount daalein!');
    if (!pickedTrip) {
      if (!window.confirm('Koi trip select nahi hui — general (bina trip) expense file karein?')) return;
    }
    setSaving(true);
    try {
      await submitRetroExpense({
        ...form, amount, gst_amount: parseFloat(form.gst_amount) || 0,
        source: 'manual', entered_by: userName,
      }, pickedTrip || undefined);
      alert('✅ Expense Pending-Approval queue mein file ho gaya. Admin approval ke baad hi ledger update hoga.');
      setForm(emptyForm); setPickedTrip(null); setTripSearch(''); setShowForm(false);
    } catch (e) { alert('❌ Error: ' + (e?.message || 'save failed')); }
    setSaving(false);
  };

  const handleApprove = async (row) => {
    if (!isAdmin) return alert('🔒 Sirf Admin approve kar sakte hain.');
    // WHOSE BOOKS (owner, 3-Sep). Three firms, three ledgers — a bill with no
    // company posts into none of them, so it is asked for here, on the card,
    // where the person reading the bill already is.
    const company = pickedCo[row.id] ?? row.company_id ?? '';
    if (!company) return alert('⚠️ Pehle company chunein — ledger usi company ke naam par post hoga.');
    if (!window.confirm(`✅ Approve ₹${Number(row.amount).toLocaleString('en-IN')} (${row.expense_type}) ${row.trip_id ? `→ Trip ${row.trip_id} ka P&L retro-adjust hoga` : '(general expense)'}?\n\nJournal + ledger turant post honge.`)) return;
    setBusyId(row.id);
    try {
      await approveRetroExpense(row, userName, company);
      await reload();
      alert(`✅ Posted! ${row.trip_id ? `Trip ${row.trip_id} ki settlement re-finalize ho gayi.` : 'Journal update ho gaya.'}`);
    } catch (e) { alert('❌ Approve failed: ' + (e?.message || '')); }
    setBusyId('');
  };

  const handleReject = async (row) => {
    if (!isAdmin) return alert('🔒 Sirf Admin reject kar sakte hain.');
    const reason = window.prompt('Reject reason (driver ko/staff ko dikhega):', 'Bill unclear / duplicate');
    if (reason === null) return;
    setBusyId(row.id);
    try { await rejectRetroExpense(row.id, reason, userName); await reload(); }
    catch (e) { alert('❌ ' + (e?.message || 'failed')); }
    setBusyId('');
  };

  // status-missing rows PENDING tab me dikhti hain — kisi tab se gayab nahi hotin.
  const filtered = rows.filter(r => (r.status || 'PENDING') === statusTab);
  const pendingTotal = rows.filter(r => (r.status || 'PENDING') === 'PENDING').reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const approvedCount = rows.filter(r => r.status === 'APPROVED').length;

  const S = {
    input: { colorScheme: 'dark' },
  };

  return (
    <div className="pt-anim-fade" style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '60px' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '15px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'clamp(22px, 5vw, 28px)', fontWeight: 900 }}>⏳ Pending Expenses <span className="pt-badge pt-badge--warning" style={{ verticalAlign: 'middle' }}>Admin Approval</span></h2>
          <p style={{ margin: '5px 0 0 0', color: '#9aadd4', fontSize: '14px' }}>Unloading ke baad aaye bills (HSD pump / Toll / Vendor) — approval ke baad hi trip P&L aur ledger mein retro-post honge.</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <label className="pt-btn pt-btn--ai" style={{ cursor: scanning ? 'wait' : 'pointer', minHeight: '48px' }}>
            {scanning ? '⏳ Scanning…' : '🤖 Scan Bill (Mamta AI)'}
            <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleScan} disabled={scanning} />
          </label>
          <button className="pt-btn pt-btn--success" style={{ minHeight: '48px' }} onClick={openForm}>＋ Manual Entry</button>
        </div>
      </div>

      {/* ── KPI strip ── */}
      <div className="pt-stagger" style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '22px' }}>
        <div className="pt-kpi">
          <div className="pt-kpi__label" style={{ color: '#ffb224' }}>Awaiting Approval</div>
          <div className="pt-kpi__value">{rows.filter(r => r.status === 'PENDING').length}</div>
          <div className="pt-kpi__sub">bills queue mein</div>
        </div>
        <div className="pt-kpi">
          <div className="pt-kpi__label" style={{ color: '#ffb224' }}>Pending Value</div>
          <div className="pt-kpi__value" style={{ color: '#ffb224' }}>₹{pendingTotal.toLocaleString('en-IN')}</div>
          <div className="pt-kpi__sub">approval ke baad post hoga</div>
        </div>
        <div className="pt-kpi">
          <div className="pt-kpi__label" style={{ color: '#2fe39b' }}>Posted (All Time)</div>
          <div className="pt-kpi__value" style={{ color: '#2fe39b' }}>{approvedCount}</div>
          <div className="pt-kpi__sub">journal + P&L updated</div>
        </div>
        <div className="pt-kpi" style={{ borderColor: '#ff6b81' }}>
          <div className="pt-kpi__label" style={{ color: '#ff6b81' }}>⛽ Fuel Slips — Bill Pending</div>
          <div className="pt-kpi__value" style={{ color: '#ff6b81' }}>{fuelPending.count}</div>
          <div className="pt-kpi__sub">{fuelPending.liters.toLocaleString('en-IN')} L diesel — pump bill se reconcile baaki</div>
        </div>
      </div>

      {/* ⛽ FUEL PENDING GUIDANCE — yahi wo "missing expenses" hain jo P&L me nahi aa rahe */}
      {fuelPending.count > 0 && (
        <div className="pt-anim-up" style={{ marginBottom: '22px', padding: '16px 18px', borderRadius: '14px', background: 'rgba(255, 107, 129,0.06)', border: '1px dashed #ff6b81', fontSize: '13px', color: '#fca5a5', lineHeight: 1.7 }}>
          <b style={{ color: '#ff6b81' }}>⛽ {fuelPending.count} fuel slips ({fuelPending.liters.toLocaleString('en-IN')} liters) ka PAISA abhi system me nahi hai</b> — memo se sirf LITERS record hote hain; ₹ value pump ke physical bill se aati hai.
          <div style={{ marginTop: '8px', color: '#c4d1ea' }}>
            Kaise poora karein: <b>Fuel (HSD) Mgmt → BILL RECONCILIATION</b> tab → pump/vendor chunein → physical bill ka total bharein → Verify.
            Ab reconcile karte hi har slip ki value uski TRIP ke kharche me AUTO jud jaati hai (P&L complete). Ya <b>AI Bill Scanner → HSD/Pump Bill</b> se bill scan karein — wahi kaam automatic.
          </div>
        </div>
      )}

      {/* ── Phone uploads from drivers & partners (migration 116) — photo
             verified here; a bill auto-files into THIS screen's expense queue
             on approval, so the money still passes the money approval. ── */}
      <PartnerDocsQueue userName={userName} onFiled={reload} />

      {/* ── Generic maker-checker queue (migration 061) — every DRAFT ledger-
             adjacent row an operator submitted, waiting on an admin. The API
             existed since 061; this is its first screen. ── */}
      <MakerCheckerQueue isAdmin={isAdmin} />

      {/* ── Entry form (📱 BottomSheet on phone, centered dialog on desktop) ── */}
      <BottomSheet open={showForm} onClose={() => setShowForm(false)} title="📝 File Retro Expense" accent="#ffb224" maxWidth={760}>
        <div className="pt-anim-fade">
          {scanNote && <div className="pt-anim-pop" style={{ marginBottom: '15px', padding: '12px 14px', borderRadius: '10px', background: 'rgba(34, 211, 238,0.08)', border: '1px dashed #22d3ee', color: '#7dd3fc', fontSize: '13px' }}>{scanNote}</div>}

          {/* 🔗 Trip picker (tap-first: search once, then everything is taps) */}
          <div style={{ marginBottom: '18px', background: 'rgba(47, 227, 155,0.05)', border: '1px solid rgba(47, 227, 155,0.25)', borderRadius: '14px', padding: '15px' }}>
            <label className="pt-label" style={{ color: '#2fe39b' }}>🔗 Link to Trip (search Vehicle / Trip ID / Driver — completed trips included)</label>
            {pickedTrip ? (
              <div className="pt-anim-pop" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <b style={{ color: '#2fe39b', fontSize: '15px' }}>{getField(pickedTrip, ['trip_id', 'Trip_ID']) || pickedTrip.id}</b>
                  <span style={{ color: '#fff', marginLeft: '10px', fontWeight: 'bold' }}>{getField(pickedTrip, ['vehicle_no', 'Vehical_No', 'vehical_no'])}</span>
                  <span style={{ color: '#9aadd4', marginLeft: '10px', fontSize: '12px' }}>
                    {getField(pickedTrip, ['loading_point', 'Loading_Point'])} ➔ {getField(pickedTrip, ['consignee_name', 'Consignee_Name'])} · Ld {toISODate(getField(pickedTrip, ['loading_date', 'Loading_Date', 'start_date'])) || '-'}
                  </span>
                  <span className={`pt-badge ${getField(pickedTrip, ['trip_status']) === 'COMPLETED' ? 'pt-badge--success' : 'pt-badge--info'}`} style={{ marginLeft: '10px' }}>
                    {getField(pickedTrip, ['trip_status', 'Trip_Status']) || 'ACTIVE'}
                  </span>
                </div>
                <button className="pt-btn pt-btn--ghost" style={{ borderColor: '#ff6b81', color: '#ff6b81', minHeight: '44px' }} onClick={() => { setPickedTrip(null); setTripSearch(''); }}>Change</button>
              </div>
            ) : (
              <>
                <input className="pt-input" placeholder="Type vehicle no / trip id / driver…" value={tripSearch} onChange={e => setTripSearch(e.target.value)} onFocus={ensureTrips} />
                {tripOptions.length > 0 && (
                  <div className="pt-anim-up" style={{ marginTop: '8px', border: '1px solid #27395f', borderRadius: '12px', overflow: 'hidden' }}>
                    {tripOptions.map(t => (
                      <div key={t.id} onClick={() => setPickedTrip(t)} style={{ padding: '14px', minHeight: '48px', cursor: 'pointer', borderBottom: '1px solid #18244a', fontSize: '13px', background: '#121c38', transition: 'background .15s' }}
                        onMouseOver={e => e.currentTarget.style.background = '#16233b'} onMouseOut={e => e.currentTarget.style.background = '#121c38'}>
                        <b style={{ color: '#22d3ee' }}>{getField(t, ['trip_id', 'Trip_ID']) || t.id}</b>
                        <span style={{ color: '#fff', margin: '0 8px', fontWeight: 'bold' }}>{getField(t, ['vehicle_no', 'Vehical_No', 'vehical_no'])}</span>
                        <span style={{ color: '#9aadd4' }}>{getField(t, ['loading_point', 'Loading_Point'])} ➔ {getField(t, ['consignee_name', 'Consignee_Name'])} · {getField(t, ['trip_status', 'Trip_Status']) || ''} · Ld {toISODate(getField(t, ['loading_date', 'Loading_Date', 'start_date'])) || '-'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Expense type — big tap-first icon segments (no dropdown) */}
          <label className="pt-label">Expense Type *</label>
          <div className="pt-seg" style={{ marginBottom: '18px' }}>
            {Object.entries(EXPENSE_TYPE_META).map(([k, m]) => (
              <button key={k} type="button" className={`pt-seg__opt ${form.expense_type === k ? 'is-on' : ''}`} onClick={() => setForm({ ...form, expense_type: k })}>
                <span className="pt-seg__icon">{m.icon}</span>
                {m.label}
              </button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '15px' }}>
            <div><label className="pt-label">Vendor / Pump Name</label><input className="pt-input" value={form.vendor_name} onChange={e => setForm({ ...form, vendor_name: e.target.value })} placeholder="e.g. Sharma Filling Station" /></div>
            <div><label className="pt-label">Bill No</label><input className="pt-input" value={form.bill_no} onChange={e => setForm({ ...form, bill_no: e.target.value })} placeholder="Bill / memo no" /></div>
            <div><label className="pt-label">Bill Date</label><input type="date" className="pt-input" style={S.input} value={form.bill_date} onChange={e => setForm({ ...form, bill_date: e.target.value })} /></div>
            <div><label className="pt-label" style={{ color: '#2fe39b' }}>Amount (₹) *</label><input type="number" inputMode="decimal" className="pt-input" style={{ borderColor: '#2fe39b', fontWeight: 'bold', fontSize: '18px' }} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0.00" /></div>
            <div><label className="pt-label">GST (₹)</label><input type="number" inputMode="decimal" className="pt-input" value={form.gst_amount} onChange={e => setForm({ ...form, gst_amount: e.target.value })} placeholder="0.00" /></div>
            <div><label className="pt-label">GST rate</label><select className="pt-input" value={form.gst_rate ?? ''} onChange={e => setForm({ ...form, gst_rate: e.target.value })}><option value="">—</option><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option><option value="28">28%</option></select></div>
            <div><label className="pt-label">Supplier GSTIN</label><input className="pt-input" value={form.supplier_gstin ?? ''} onChange={e => setForm({ ...form, supplier_gstin: e.target.value.toUpperCase() })} placeholder="15-character GSTIN (for input credit)" /></div>
          </div>
          <div style={{ marginTop: '15px' }}>
            <label className="pt-label">Description / Remarks</label>
            <input className="pt-input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. 150L HSD top-up at Jorhat" />
          </div>
          <button disabled={saving} onClick={handleSubmit} style={{ width: '100%', marginTop: '20px', padding: '16px', minHeight: '52px', background: 'linear-gradient(135deg, #ffb224, #d97706)', color: '#121c38', border: 'none', borderRadius: '12px', fontWeight: 900, fontSize: '15px', cursor: 'pointer', boxShadow: '0 6px 20px rgba(255, 178, 36,0.35)', transition: 'transform .15s ease' }}>
            {saving ? '⏳ Filing…' : '📥 FILE FOR ADMIN APPROVAL'}
          </button>
        </div>
      </BottomSheet>

      {/* ── Status tabs (animated underline) ── */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '20px', borderBottom: '1px solid #27395f', overflowX: 'auto' }}>
        {Object.entries(STATUS_META).map(([k, m]) => {
          const n = rows.filter(r => r.status === k).length;
          const activeMod = k === 'APPROVED' ? 'is-active--success' : k === 'REJECTED' ? 'is-active--danger' : 'is-active--warning';
          return (
            <button key={k} className={`pt-tab ${statusTab === k ? `is-active ${activeMod}` : ''}`} onClick={() => setStatusTab(k)}>
              {m.label} {n > 0 && <span className="pt-tab__count" style={{ background: m.color, color: '#121c38' }}>{n}</span>}
            </button>
          );
        })}
      </div>

      {/* ── Queue: smart cards (staggered entrance, re-animates on tab switch) ── */}
      {filtered.length === 0 ? (
        <div className="pt-anim-up" style={{ textAlign: 'center', padding: '50px', color: '#5d7196', background: 'rgba(24, 36, 74,0.3)', borderRadius: '16px', border: '1px dashed #27395f' }}>
          {statusTab === 'PENDING' ? '🎉 Koi bill approval ke liye pending nahi hai.' : 'No records.'}
        </div>
      ) : (
        <div key={statusTab} className="pt-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(340px, 100%), 1fr))', gap: '18px' }}>
          {filtered.map(r => {
            const meta = EXPENSE_TYPE_META[r.expense_type] || EXPENSE_TYPE_META.OTHER;
            const sm = STATUS_META[r.status] || STATUS_META.PENDING;
            const accent = r.status === 'APPROVED' ? 'pt-card--accent-success' : r.status === 'REJECTED' ? 'pt-card--accent-danger' : 'pt-card--accent-warning';
            const badgeMod = r.status === 'APPROVED' ? 'pt-badge--success' : r.status === 'REJECTED' ? 'pt-badge--danger' : 'pt-badge--warning';
            return (
              <div key={r.id} className={`pt-card ${accent}`} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                  <div style={{ fontWeight: 900, fontSize: '16px' }}>{meta.icon} {meta.label}</div>
                  <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                    <button type="button" onClick={() => setView(r)} title="Open in the approval desk — bill, details, decision"
                      style={{ background: 'rgba(34, 211, 238,0.12)', color: '#22d3ee', border: '1px solid rgba(34, 211, 238,0.35)', borderRadius: '8px', padding: '4px 10px', fontSize: '11px', fontWeight: 800, cursor: 'pointer' }}>
                      🔍 View
                    </button>
                    <span className={`pt-badge ${badgeMod}`}>{sm.label}</span>
                  </div>
                </div>
                <div style={{ fontSize: '30px', fontWeight: 900, color: sm.color }}>₹{Number(r.amount || 0).toLocaleString('en-IN')}</div>
                <div style={{ fontSize: '13px', color: '#c4d1ea', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {r.vendor_name && <div>🏪 {r.vendor_name} {r.bill_no && <span style={{ color: '#9aadd4' }}>· Bill {r.bill_no}</span>}</div>}
                  <div style={{ color: '#9aadd4' }}>📅 {r.bill_date || '-'} · by {r.entered_by} {r.source === 'ai_scan' && <span className="pt-badge pt-badge--ai">🤖 AI</span>}
                    {r.source === 'VENDOR_PORTAL' && <span className="pt-badge pt-badge--warning" style={{ marginLeft: '6px' }}>🏪 Vendor portal</span>}
                    {/* A bill a service vendor uploaded from its own portal carries its PDF/photo here (migration 130). */}
                    {r.file_key && (
                      <button type="button" onClick={() => setView(r)}
                        style={{ marginLeft: '8px', background: 'rgba(34, 211, 238,0.12)', color: '#22d3ee', border: '1px solid rgba(34, 211, 238,0.35)', borderRadius: '6px', padding: '2px 8px', fontSize: '11px', fontWeight: 700, cursor: 'pointer' }}>
                        📎 View bill
                      </button>
                    )}
                  </div>
                  {r.description && <div style={{ color: '#9aadd4', fontStyle: 'italic' }}>“{r.description}”</div>}
                </div>
                {r.trip_id ? (
                  <div style={{ background: 'rgba(34, 211, 238,0.06)', border: '1px solid rgba(34, 211, 238,0.25)', borderRadius: '10px', padding: '10px 12px', fontSize: '12px' }}>
                    🔗 <b style={{ color: '#22d3ee' }}>Trip {r.trip_id}</b> · {r.vehicle_no} {r.driver_name && `· ${r.driver_name}`}
                    {r.trip_status_at_entry === 'COMPLETED' && <span className="pt-badge pt-badge--warning" style={{ marginLeft: '6px' }}>Closed Trip · Retro</span>}
                    {r.match_confidence === 'AMBIGUOUS' && <span className="pt-badge pt-badge--warning" style={{ marginLeft: '6px' }}>⚠ Verify</span>}
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: '#5d7196' }}>Bina trip — general expense</div>
                )}
                {r.status === 'PENDING' && isAdmin && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px' }}>
                    <span style={{ color: '#9aadd4', fontWeight: 700 }}>🏢 Company (books)</span>
                    <select
                      value={pickedCo[r.id] ?? r.company_id ?? ''}
                      onChange={(e) => setPickedCo((m) => ({ ...m, [r.id]: e.target.value }))}
                      className="modern-input"
                      // A bare <select> ignores most of .modern-input and paints
                      // itself white, which on this screen reads as a broken
                      // field rather than a choice. colorScheme makes the native
                      // dropdown dark too, not just the closed box.
                      style={{
                        flex: 1, minWidth: '190px', minHeight: '38px', colorScheme: 'dark',
                        background: '#0a1024', color: '#dde5f4', border: '1px solid #27395f',
                        borderRadius: '9px', padding: '6px 10px', fontWeight: 700,
                      }}
                      data-company={r.id}
                    >
                      <option value="">— choose the company —</option>
                      {companies.map((c) => <option key={c.id} value={c.id}>{c.company_name}</option>)}
                    </select>
                  </div>
                )}
                {r.status === 'PENDING' && (
                  isAdmin ? (
                    <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                      <button className={`pt-btn pt-btn--success ${busyId === r.id ? 'is-loading' : ''}`} disabled={busyId === r.id} onClick={() => handleApprove(r)} style={{ flex: 2, minHeight: '48px', fontWeight: 900 }}>
                        {busyId === r.id ? 'Posting…' : '✅ Approve & Post'}
                      </button>
                      <button className="pt-btn pt-btn--ghost" disabled={busyId === r.id} onClick={() => handleReject(r)} style={{ flex: 1, minHeight: '48px', borderColor: '#ff6b81', color: '#ff6b81' }}>Reject</button>
                    </div>
                  ) : (
                    <div style={{ fontSize: '12px', color: '#ffb224', textAlign: 'center', padding: '12px', background: 'rgba(255, 178, 36,0.08)', borderRadius: '10px' }}>🔒 Admin approval awaited</div>
                  )
                )}
                {r.status === 'APPROVED' && <div style={{ fontSize: '11px', color: '#2fe39b' }}>✔ Posted by {r.approved_by} — journal + trip P&L updated</div>}
                {r.status === 'REJECTED' && <div style={{ fontSize: '11px', color: '#ff6b81' }}>✖ {r.rejection_reason || 'Rejected'} — by {r.approved_by}</div>}
              </div>
            );
          })}
        </div>
      )}

      {/* ── The Smart Approval Desk: bill in place, fields editable, decision beside the paper ── */}
      <ApprovalDrawer
        open={!!view}
        onClose={() => setView(null)}
        title={view ? `${(EXPENSE_TYPE_META[view.expense_type] || EXPENSE_TYPE_META.OTHER).icon} ${(EXPENSE_TYPE_META[view.expense_type] || EXPENSE_TYPE_META.OTHER).label} — ${view.vendor_name || 'no vendor named'}` : ''}
        subtitle={view ? `${view.trip_id ? `Trip ${view.trip_id} · ${view.vehicle_no ?? ''}` : 'General expense (no trip)'} · filed by ${view.entered_by ?? '—'} · ${view.source ?? 'manual'}` : ''}
        accent={view?.status === 'APPROVED' ? '#2fe39b' : view?.status === 'REJECTED' ? '#ff6b81' : '#ffb224'}
        fileKey={view?.file_key ?? null}
        fileLabel={view?.source === 'VENDOR_PORTAL' ? 'Vendor bill' : view?.source === 'PARTNER_APP' ? 'App upload' : 'Bill'}
        amount={view ? Number(view.amount ?? 0) : null}
        chips={view ? [
          { label: (STATUS_META[view.status] || STATUS_META.PENDING).label, tone: view.status === 'APPROVED' ? 'green' : view.status === 'REJECTED' ? 'red' : 'amber' },
          ...(view.source === 'VENDOR_PORTAL' ? [{ label: '🏪 Vendor portal', tone: 'cyan' }] : []),
          ...(view.source === 'PARTNER_APP' ? [{ label: '📱 App upload', tone: 'violet' }] : []),
          ...(view.source === 'ai_scan' ? [{ label: '🤖 AI scan', tone: 'violet' }] : []),
          ...(view.trip_status_at_entry === 'COMPLETED' ? [{ label: 'Closed trip · retro', tone: 'amber' }] : []),
          ...(view.match_confidence === 'AMBIGUOUS' ? [{ label: '⚠ verify trip', tone: 'amber' }] : []),
        ] : []}
        canDecide={isAdmin && (view?.status || 'PENDING') === 'PENDING'}
        fields={view ? [
          { key: 'amount', label: 'Amount (₹)', value: view.amount ?? '', editable: true, type: 'number' },
          { key: 'expense_type', label: 'Type', value: view.expense_type ?? 'OTHER', editable: true, type: 'select',
            options: Object.entries(EXPENSE_TYPE_META).map(([k, m]) => ({ value: k, label: `${m.icon} ${m.label}` })),
            render: (v) => { const m = EXPENSE_TYPE_META[v] || EXPENSE_TYPE_META.OTHER; return `${m.icon} ${m.label}`; } },
          { key: 'vendor_name', label: 'Vendor / pump', value: view.vendor_name ?? '', editable: true },
          { key: 'bill_no', label: 'Bill no', value: view.bill_no ?? '', editable: true },
          { key: 'bill_date', label: 'Bill date', value: String(view.bill_date ?? '').slice(0, 10), editable: true, type: 'date' },
          { key: 'vehicle_no', label: 'Vehicle', value: view.vehicle_no ?? '', editable: true },
          { key: 'description', label: 'Description', value: view.description ?? '', editable: true, wide: true },
          ...(view.status === 'APPROVED' ? [{ key: 'approved_by', label: 'Posted by', value: view.approved_by ?? '' }] : []),
          ...(view.status === 'REJECTED' ? [{ key: 'rejection_reason', label: 'Rejected because', value: view.rejection_reason ?? '', wide: true }] : []),
        ] : []}
        approveLabel="✅ Approve & Post"
        onSaveEdits={async (edits) => { await patchExpense(view.id, edits); await reload(); }}
        onApprove={async (edits) => {
          if (Object.keys(edits).length) await patchExpense(view.id, edits);
          const amount = Number(edits.amount ?? view.amount);
          if (!(amount > 0)) throw new Error('Amount must be more than zero');
          await approveRetroExpense({ ...view, ...edits, amount }, userName);
          await reload();
          setView(null);
        }}
        onReject={async (reason) => { await rejectRetroExpense(view.id, reason, userName); await reload(); setView(null); }}
        footnote="Approve posts the JOURNAL through TARA and retro-adjusts the trip's P&L in one transaction. Edits are saved to the pending row first, so the voucher carries the corrected figures."
      />
    </div>
  );
}
