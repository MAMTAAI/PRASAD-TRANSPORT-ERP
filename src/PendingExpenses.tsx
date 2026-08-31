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

const STATUS_META = {
  PENDING: { label: 'Pending Approval', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  APPROVED: { label: 'Approved & Posted', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  REJECTED: { label: 'Rejected', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
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

function PartnerDocsQueue({ userName, onFiled }) {
  const [docs, setDocs] = useState([]);
  const [busy, setBusy] = useState('');
  const [amounts, setAmounts] = useState({});
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

  const viewPhoto = async (key) => {
    try {
      const r = await authed(`/files/${key}`);
      if (!r.ok) { alert(`Photo nahi khuli (${r.status})`); return; }
      const blob = await r.blob();
      window.open(URL.createObjectURL(blob), '_blank', 'noopener');
    } catch (e) { alert('Photo nahi khuli: ' + e.message); }
  };

  const decide = async (doc, action) => {
    let body = { reviewed_by: userName };
    if (action === 'reject') {
      const reason = window.prompt('Reject kyon? (yeh kaaran uploader ko WhatsApp par jayega)');
      if (!reason) return;
      body.reason = reason;
    } else {
      const isBill = BILL_TYPES.has(doc.doc_type);
      const amt = Number(amounts[doc.id] ?? doc.amount);
      if (isBill && !(amt > 0)) { alert('⚠️ Bill ka amount bharein — tabhi expense queue mein jayega.'); return; }
      if (isBill) body.amount = amt;
      if (!window.confirm(`Approve ${DOC_LABEL[doc.doc_type] ?? doc.doc_type} from ${doc.uploader_name}?${isBill ? ` ₹${amt.toLocaleString('en-IN')} expense queue mein file hoga.` : ''}`)) return;
    }
    setBusy(doc.id);
    try {
      const r = await authed(`/queues/partner-documents/${doc.id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) alert('❌ ' + (j.detail ?? j.error ?? r.status));
      else if (action === 'approve' && j.expenseId) onFiled?.();
      await load();
    } finally { setBusy(''); }
  };

  return (
    <div className="pt-anim-up" style={{ marginBottom: '22px', padding: '16px 18px', borderRadius: '14px', background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.3)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <b style={{ color: '#f59e0b', fontSize: '14px' }}>📱 App Uploads — Driver & Partner ({docs.length} pending)</b>
        <button className="pt-btn" style={{ minHeight: '36px', fontSize: '12px' }} onClick={load}>↻ Refresh</button>
      </div>
      {docs.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: '13px' }}>Koi naya upload nahi. Driver/partner app se bheja har kagaz yahan aayega — approve hone par hi system mein lagega.</div>
      ) : docs.map((d) => (
        <div key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', marginBottom: '8px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '220px' }}>
            <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#fff' }}>
              {DOC_LABEL[d.doc_type] ?? d.doc_type} · <span style={{ color: '#38bdf8' }}>{d.uploader_name}</span>
              <span style={{ color: '#64748b', fontWeight: 'normal' }}> ({d.uploader_role.toLowerCase()})</span>
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>
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
                    onClick={() => viewPhoto(d.file_key)}>📷 View</button>
            <button className="pt-btn pt-btn--success" style={{ minHeight: '36px', fontSize: '12px' }}
                    disabled={busy === d.id} onClick={() => decide(d, 'approve')}>✅ Approve</button>
            <button className="pt-btn" style={{ minHeight: '36px', fontSize: '12px', color: '#ef4444', borderColor: '#ef444455' }}
                    disabled={busy === d.id} onClick={() => decide(d, 'reject')}>✖ Reject</button>
          </div>
        </div>
      ))}
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
    <div className="pt-anim-up" style={{ marginBottom: '22px', padding: '16px 18px', borderRadius: '14px', background: 'rgba(56,189,248,0.05)', border: '1px solid rgba(56,189,248,0.25)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <b style={{ color: '#38bdf8', fontSize: '14px' }}>
          🛃 Maker-Checker Queue ({q.rows.length}{q.total?.amount ? ` · ₹${Number(q.total.amount).toLocaleString('en-IN')} pending` : ''})
        </b>
        <button className="pt-btn" style={{ minHeight: '36px', fontSize: '12px' }} onClick={load}>↻ Refresh</button>
      </div>
      {q.rows.length === 0 ? (
        <div style={{ color: '#64748b', fontSize: '13px' }}>Koi submitted entry approval ka intezaar nahi kar rahi. Vendor bills, TDS, EMI, toll claims — sab clear.</div>
      ) : q.rows.map((row) => (
        <div key={`${row.source_table}-${row.id}`} style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '10px 12px', borderRadius: '10px', background: 'rgba(2,6,23,0.5)', border: '1px solid #1e293b', marginBottom: '8px', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '220px' }}>
            <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#fff' }}>{row.subject ?? row.source_table}</div>
            <div style={{ fontSize: '11px', color: '#94a3b8' }}>
              {row.source_table} · submitted {row.submitted_at ? new Date(row.submitted_at).toLocaleString('en-IN') : '—'}
            </div>
          </div>
          {row.amount != null && (
            <div style={{ fontSize: '15px', fontWeight: 900, color: '#f59e0b' }}>₹{Number(row.amount).toLocaleString('en-IN')}</div>
          )}
          {isAdmin ? (
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="pt-btn pt-btn--success" style={{ minHeight: '36px', fontSize: '12px' }}
                      disabled={busy === row.id} onClick={() => decide(row, 'approve')}>✅ Approve</button>
              <button className="pt-btn" style={{ minHeight: '36px', fontSize: '12px', color: '#ef4444', borderColor: '#ef444455' }}
                      disabled={busy === row.id} onClick={() => decide(row, 'reject')}>✖ Reject</button>
            </div>
          ) : (
            <span style={{ fontSize: '11px', color: '#64748b' }}>admin approval required</span>
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
    if (!window.confirm(`✅ Approve ₹${Number(row.amount).toLocaleString('en-IN')} (${row.expense_type}) ${row.trip_id ? `→ Trip ${row.trip_id} ka P&L retro-adjust hoga` : '(general expense)'}?\n\nJournal + ledger turant post honge.`)) return;
    setBusyId(row.id);
    try {
      await approveRetroExpense(row, userName);
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
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Unloading ke baad aaye bills (HSD pump / Toll / Vendor) — approval ke baad hi trip P&L aur ledger mein retro-post honge.</p>
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
          <div className="pt-kpi__label" style={{ color: '#f59e0b' }}>Awaiting Approval</div>
          <div className="pt-kpi__value">{rows.filter(r => r.status === 'PENDING').length}</div>
          <div className="pt-kpi__sub">bills queue mein</div>
        </div>
        <div className="pt-kpi">
          <div className="pt-kpi__label" style={{ color: '#f59e0b' }}>Pending Value</div>
          <div className="pt-kpi__value" style={{ color: '#f59e0b' }}>₹{pendingTotal.toLocaleString('en-IN')}</div>
          <div className="pt-kpi__sub">approval ke baad post hoga</div>
        </div>
        <div className="pt-kpi">
          <div className="pt-kpi__label" style={{ color: '#10b981' }}>Posted (All Time)</div>
          <div className="pt-kpi__value" style={{ color: '#10b981' }}>{approvedCount}</div>
          <div className="pt-kpi__sub">journal + P&L updated</div>
        </div>
        <div className="pt-kpi" style={{ borderColor: '#ef4444' }}>
          <div className="pt-kpi__label" style={{ color: '#ef4444' }}>⛽ Fuel Slips — Bill Pending</div>
          <div className="pt-kpi__value" style={{ color: '#ef4444' }}>{fuelPending.count}</div>
          <div className="pt-kpi__sub">{fuelPending.liters.toLocaleString('en-IN')} L diesel — pump bill se reconcile baaki</div>
        </div>
      </div>

      {/* ⛽ FUEL PENDING GUIDANCE — yahi wo "missing expenses" hain jo P&L me nahi aa rahe */}
      {fuelPending.count > 0 && (
        <div className="pt-anim-up" style={{ marginBottom: '22px', padding: '16px 18px', borderRadius: '14px', background: 'rgba(239,68,68,0.06)', border: '1px dashed #ef4444', fontSize: '13px', color: '#fca5a5', lineHeight: 1.7 }}>
          <b style={{ color: '#ef4444' }}>⛽ {fuelPending.count} fuel slips ({fuelPending.liters.toLocaleString('en-IN')} liters) ka PAISA abhi system me nahi hai</b> — memo se sirf LITERS record hote hain; ₹ value pump ke physical bill se aati hai.
          <div style={{ marginTop: '8px', color: '#cbd5e1' }}>
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
      <BottomSheet open={showForm} onClose={() => setShowForm(false)} title="📝 File Retro Expense" accent="#f59e0b" maxWidth={760}>
        <div className="pt-anim-fade">
          {scanNote && <div className="pt-anim-pop" style={{ marginBottom: '15px', padding: '12px 14px', borderRadius: '10px', background: 'rgba(56,189,248,0.08)', border: '1px dashed #38bdf8', color: '#7dd3fc', fontSize: '13px' }}>{scanNote}</div>}

          {/* 🔗 Trip picker (tap-first: search once, then everything is taps) */}
          <div style={{ marginBottom: '18px', background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '14px', padding: '15px' }}>
            <label className="pt-label" style={{ color: '#10b981' }}>🔗 Link to Trip (search Vehicle / Trip ID / Driver — completed trips included)</label>
            {pickedTrip ? (
              <div className="pt-anim-pop" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <b style={{ color: '#10b981', fontSize: '15px' }}>{getField(pickedTrip, ['trip_id', 'Trip_ID']) || pickedTrip.id}</b>
                  <span style={{ color: '#fff', marginLeft: '10px', fontWeight: 'bold' }}>{getField(pickedTrip, ['vehicle_no', 'Vehical_No', 'vehical_no'])}</span>
                  <span style={{ color: '#94a3b8', marginLeft: '10px', fontSize: '12px' }}>
                    {getField(pickedTrip, ['loading_point', 'Loading_Point'])} ➔ {getField(pickedTrip, ['consignee_name', 'Consignee_Name'])} · Ld {toISODate(getField(pickedTrip, ['loading_date', 'Loading_Date', 'start_date'])) || '-'}
                  </span>
                  <span className={`pt-badge ${getField(pickedTrip, ['trip_status']) === 'COMPLETED' ? 'pt-badge--success' : 'pt-badge--info'}`} style={{ marginLeft: '10px' }}>
                    {getField(pickedTrip, ['trip_status', 'Trip_Status']) || 'ACTIVE'}
                  </span>
                </div>
                <button className="pt-btn pt-btn--ghost" style={{ borderColor: '#ef4444', color: '#ef4444', minHeight: '44px' }} onClick={() => { setPickedTrip(null); setTripSearch(''); }}>Change</button>
              </div>
            ) : (
              <>
                <input className="pt-input" placeholder="Type vehicle no / trip id / driver…" value={tripSearch} onChange={e => setTripSearch(e.target.value)} onFocus={ensureTrips} />
                {tripOptions.length > 0 && (
                  <div className="pt-anim-up" style={{ marginTop: '8px', border: '1px solid #334155', borderRadius: '12px', overflow: 'hidden' }}>
                    {tripOptions.map(t => (
                      <div key={t.id} onClick={() => setPickedTrip(t)} style={{ padding: '14px', minHeight: '48px', cursor: 'pointer', borderBottom: '1px solid #1e293b', fontSize: '13px', background: '#0f172a', transition: 'background .15s' }}
                        onMouseOver={e => e.currentTarget.style.background = '#16233b'} onMouseOut={e => e.currentTarget.style.background = '#0f172a'}>
                        <b style={{ color: '#38bdf8' }}>{getField(t, ['trip_id', 'Trip_ID']) || t.id}</b>
                        <span style={{ color: '#fff', margin: '0 8px', fontWeight: 'bold' }}>{getField(t, ['vehicle_no', 'Vehical_No', 'vehical_no'])}</span>
                        <span style={{ color: '#94a3b8' }}>{getField(t, ['loading_point', 'Loading_Point'])} ➔ {getField(t, ['consignee_name', 'Consignee_Name'])} · {getField(t, ['trip_status', 'Trip_Status']) || ''} · Ld {toISODate(getField(t, ['loading_date', 'Loading_Date', 'start_date'])) || '-'}</span>
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
            <div><label className="pt-label" style={{ color: '#10b981' }}>Amount (₹) *</label><input type="number" inputMode="decimal" className="pt-input" style={{ borderColor: '#10b981', fontWeight: 'bold', fontSize: '18px' }} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0.00" /></div>
            <div><label className="pt-label">GST (₹)</label><input type="number" inputMode="decimal" className="pt-input" value={form.gst_amount} onChange={e => setForm({ ...form, gst_amount: e.target.value })} placeholder="0.00" /></div>
          </div>
          <div style={{ marginTop: '15px' }}>
            <label className="pt-label">Description / Remarks</label>
            <input className="pt-input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. 150L HSD top-up at Jorhat" />
          </div>
          <button disabled={saving} onClick={handleSubmit} style={{ width: '100%', marginTop: '20px', padding: '16px', minHeight: '52px', background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#0f172a', border: 'none', borderRadius: '12px', fontWeight: 900, fontSize: '15px', cursor: 'pointer', boxShadow: '0 6px 20px rgba(245,158,11,0.35)', transition: 'transform .15s ease' }}>
            {saving ? '⏳ Filing…' : '📥 FILE FOR ADMIN APPROVAL'}
          </button>
        </div>
      </BottomSheet>

      {/* ── Status tabs (animated underline) ── */}
      <div style={{ display: 'flex', gap: '6px', marginBottom: '20px', borderBottom: '1px solid #334155', overflowX: 'auto' }}>
        {Object.entries(STATUS_META).map(([k, m]) => {
          const n = rows.filter(r => r.status === k).length;
          const activeMod = k === 'APPROVED' ? 'is-active--success' : k === 'REJECTED' ? 'is-active--danger' : 'is-active--warning';
          return (
            <button key={k} className={`pt-tab ${statusTab === k ? `is-active ${activeMod}` : ''}`} onClick={() => setStatusTab(k)}>
              {m.label} {n > 0 && <span className="pt-tab__count" style={{ background: m.color, color: '#0f172a' }}>{n}</span>}
            </button>
          );
        })}
      </div>

      {/* ── Queue: smart cards (staggered entrance, re-animates on tab switch) ── */}
      {filtered.length === 0 ? (
        <div className="pt-anim-up" style={{ textAlign: 'center', padding: '50px', color: '#64748b', background: 'rgba(30,41,59,0.3)', borderRadius: '16px', border: '1px dashed #334155' }}>
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
                  <span className={`pt-badge ${badgeMod}`}>{sm.label}</span>
                </div>
                <div style={{ fontSize: '30px', fontWeight: 900, color: sm.color }}>₹{Number(r.amount || 0).toLocaleString('en-IN')}</div>
                <div style={{ fontSize: '13px', color: '#cbd5e1', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {r.vendor_name && <div>🏪 {r.vendor_name} {r.bill_no && <span style={{ color: '#94a3b8' }}>· Bill {r.bill_no}</span>}</div>}
                  <div style={{ color: '#94a3b8' }}>📅 {r.bill_date || '-'} · by {r.entered_by} {r.source === 'ai_scan' && <span className="pt-badge pt-badge--ai">🤖 AI</span>}</div>
                  {r.description && <div style={{ color: '#94a3b8', fontStyle: 'italic' }}>“{r.description}”</div>}
                </div>
                {r.trip_id ? (
                  <div style={{ background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.25)', borderRadius: '10px', padding: '10px 12px', fontSize: '12px' }}>
                    🔗 <b style={{ color: '#38bdf8' }}>Trip {r.trip_id}</b> · {r.vehicle_no} {r.driver_name && `· ${r.driver_name}`}
                    {r.trip_status_at_entry === 'COMPLETED' && <span className="pt-badge pt-badge--warning" style={{ marginLeft: '6px' }}>Closed Trip · Retro</span>}
                    {r.match_confidence === 'AMBIGUOUS' && <span className="pt-badge pt-badge--warning" style={{ marginLeft: '6px' }}>⚠ Verify</span>}
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: '#64748b' }}>Bina trip — general expense</div>
                )}
                {r.status === 'PENDING' && (
                  isAdmin ? (
                    <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                      <button className={`pt-btn pt-btn--success ${busyId === r.id ? 'is-loading' : ''}`} disabled={busyId === r.id} onClick={() => handleApprove(r)} style={{ flex: 2, minHeight: '48px', fontWeight: 900 }}>
                        {busyId === r.id ? 'Posting…' : '✅ Approve & Post'}
                      </button>
                      <button className="pt-btn pt-btn--ghost" disabled={busyId === r.id} onClick={() => handleReject(r)} style={{ flex: 1, minHeight: '48px', borderColor: '#ef4444', color: '#ef4444' }}>Reject</button>
                    </div>
                  ) : (
                    <div style={{ fontSize: '12px', color: '#f59e0b', textAlign: 'center', padding: '12px', background: 'rgba(245,158,11,0.08)', borderRadius: '10px' }}>🔒 Admin approval awaited</div>
                  )
                )}
                {r.status === 'APPROVED' && <div style={{ fontSize: '11px', color: '#10b981' }}>✔ Posted by {r.approved_by} — journal + trip P&L updated</div>}
                {r.status === 'REJECTED' && <div style={{ fontSize: '11px', color: '#ef4444' }}>✖ {r.rejection_reason || 'Rejected'} — by {r.approved_by}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
