// @ts-nocheck
// ⏳ PENDING EXPENSES — retroactive trip-expense queue with ADMIN approval.
// Ground reality: the truck unloads today, but the HSD pump bill and toll
// receipts reach the office days later. Staff file them here against the trip;
// nothing touches the books until an Admin approves — then the journal posts,
// the trip's P&L is retro-adjusted and a COMPLETED trip's settlement is
// re-finalized (all idempotent, closed accounts never double-post).
import React, { useState, useEffect, useMemo } from 'react';
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore';
import { db } from './firebase';
import { currentUser } from './lib/rbac';
import { extractJsonFromImage } from './lib/aiScanner';
import {
  submitRetroExpense, approveRetroExpense, rejectRetroExpense,
  matchTripForBill, classifyExpenseType, parseDocDate, fetchTripsForMatching,
  EXPENSE_TYPE_META, normalizeVehicleNo,
} from './lib/postTripEngine';
import { getField, toISODate } from './lib/accounting/tripMath';

const STATUS_META = {
  PENDING: { label: 'Pending Approval', color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  APPROVED: { label: 'Approved & Posted', color: '#10b981', bg: 'rgba(16,185,129,0.12)' },
  REJECTED: { label: 'Rejected', color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
};

const emptyForm = {
  expense_type: 'FUEL', vendor_name: '', bill_no: '',
  bill_date: new Date().toISOString().split('T')[0], amount: '', gst_amount: '', description: '',
};

export default function PendingExpenses() {
  const user = currentUser();
  const isAdmin = user?.role === 'ADMIN' || user?.role === 'Super Admin';
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

  useEffect(() => {
    const un = onSnapshot(query(collection(db, 'EXPENSE_APPROVALS'), orderBy('created_at', 'desc')),
      s => setRows(s.docs.map(d => ({ id: d.id, ...d.data() }))), () => {});
    return () => un();
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
      alert(`✅ Posted! ${row.trip_id ? `Trip ${row.trip_id} ki settlement re-finalize ho gayi.` : 'Journal update ho gaya.'}`);
    } catch (e) { alert('❌ Approve failed: ' + (e?.message || '')); }
    setBusyId('');
  };

  const handleReject = async (row) => {
    if (!isAdmin) return alert('🔒 Sirf Admin reject kar sakte hain.');
    const reason = window.prompt('Reject reason (driver ko/staff ko dikhega):', 'Bill unclear / duplicate');
    if (reason === null) return;
    setBusyId(row.id);
    try { await rejectRetroExpense(row.id, reason, userName); }
    catch (e) { alert('❌ ' + (e?.message || 'failed')); }
    setBusyId('');
  };

  const filtered = rows.filter(r => r.status === statusTab);
  const pendingTotal = rows.filter(r => r.status === 'PENDING').reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const approvedCount = rows.filter(r => r.status === 'APPROVED').length;

  const S = {
    input: { width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box', outline: 'none', colorScheme: 'dark' },
    label: { color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', display: 'block', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.5px' },
    kpi: { flex: '1 1 160px', background: 'rgba(30,41,59,0.5)', border: '1px solid #334155', borderRadius: '14px', padding: '16px 20px' },
  };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '60px' }}>
      {/* ── Header ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '15px', marginBottom: '20px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '28px', fontWeight: 900 }}>⏳ Pending Expenses <span style={{ fontSize: '12px', color: '#f59e0b', border: '1px solid #f59e0b', borderRadius: '12px', padding: '2px 10px', verticalAlign: 'middle' }}>ADMIN APPROVAL</span></h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Unloading ke baad aaye bills (HSD pump / Toll / Vendor) — approval ke baad hi trip P&L aur ledger mein retro-post honge.</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <label className="pt-btn pt-btn--ai" style={{ cursor: scanning ? 'wait' : 'pointer' }}>
            {scanning ? '⏳ Scanning…' : '🤖 Scan Bill (Mamta AI)'}
            <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleScan} disabled={scanning} />
          </label>
          <button className="pt-btn pt-btn--success" onClick={openForm}>＋ Manual Entry</button>
        </div>
      </div>

      {/* ── KPI strip ── */}
      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '22px' }}>
        <div style={S.kpi}>
          <div style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 'bold', textTransform: 'uppercase' }}>Awaiting Approval</div>
          <div style={{ fontSize: '28px', fontWeight: 900 }}>{rows.filter(r => r.status === 'PENDING').length}</div>
        </div>
        <div style={S.kpi}>
          <div style={{ fontSize: '11px', color: '#f59e0b', fontWeight: 'bold', textTransform: 'uppercase' }}>Pending Value</div>
          <div style={{ fontSize: '28px', fontWeight: 900, color: '#f59e0b' }}>₹{pendingTotal.toLocaleString('en-IN')}</div>
        </div>
        <div style={S.kpi}>
          <div style={{ fontSize: '11px', color: '#10b981', fontWeight: 'bold', textTransform: 'uppercase' }}>Posted (All Time)</div>
          <div style={{ fontSize: '28px', fontWeight: 900, color: '#10b981' }}>{approvedCount}</div>
        </div>
      </div>

      {/* ── Entry form ── */}
      {showForm && (
        <div style={{ background: '#1e293b', border: '1px solid #f59e0b', borderRadius: '15px', padding: '25px', marginBottom: '25px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
            <h3 style={{ margin: 0, color: '#f59e0b' }}>📝 File Retro Expense (Bill Back-Entry)</h3>
            <button onClick={() => setShowForm(false)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '22px', cursor: 'pointer' }}>✕</button>
          </div>
          {scanNote && <div style={{ marginBottom: '15px', padding: '10px 14px', borderRadius: '8px', background: 'rgba(56,189,248,0.08)', border: '1px dashed #38bdf8', color: '#7dd3fc', fontSize: '13px' }}>{scanNote}</div>}

          {/* Trip picker */}
          <div style={{ marginBottom: '18px', background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.25)', borderRadius: '10px', padding: '15px' }}>
            <label style={{ ...S.label, color: '#10b981' }}>🔗 Link to Trip (search Vehicle / Trip ID / Driver — completed trips included)</label>
            {pickedTrip ? (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                <div>
                  <b style={{ color: '#10b981', fontSize: '15px' }}>{getField(pickedTrip, ['trip_id', 'Trip_ID']) || pickedTrip.id}</b>
                  <span style={{ color: '#fff', marginLeft: '10px', fontWeight: 'bold' }}>{getField(pickedTrip, ['vehicle_no', 'Vehical_No', 'vehical_no'])}</span>
                  <span style={{ color: '#94a3b8', marginLeft: '10px', fontSize: '12px' }}>
                    {getField(pickedTrip, ['loading_point', 'Loading_Point'])} ➔ {getField(pickedTrip, ['consignee_name', 'Consignee_Name'])} · Ld {toISODate(getField(pickedTrip, ['loading_date', 'Loading_Date', 'start_date'])) || '-'}
                  </span>
                  <span style={{ marginLeft: '10px', fontSize: '10px', fontWeight: 'bold', padding: '2px 8px', borderRadius: '10px', background: getField(pickedTrip, ['trip_status']) === 'COMPLETED' ? 'rgba(16,185,129,0.15)' : 'rgba(56,189,248,0.15)', color: getField(pickedTrip, ['trip_status']) === 'COMPLETED' ? '#10b981' : '#38bdf8' }}>
                    {getField(pickedTrip, ['trip_status', 'Trip_Status']) || 'ACTIVE'}
                  </span>
                </div>
                <button onClick={() => { setPickedTrip(null); setTripSearch(''); }} style={{ background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}>Change</button>
              </div>
            ) : (
              <>
                <input style={S.input} placeholder="Type vehicle no / trip id / driver…" value={tripSearch} onChange={e => setTripSearch(e.target.value)} onFocus={ensureTrips} />
                {tripOptions.length > 0 && (
                  <div style={{ marginTop: '8px', border: '1px solid #334155', borderRadius: '8px', overflow: 'hidden' }}>
                    {tripOptions.map(t => (
                      <div key={t.id} onClick={() => setPickedTrip(t)} style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid #1e293b', fontSize: '13px', background: '#0f172a' }}
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

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '15px' }}>
            <div>
              <label style={S.label}>Expense Type *</label>
              <select style={S.input} value={form.expense_type} onChange={e => setForm({ ...form, expense_type: e.target.value })}>
                {Object.entries(EXPENSE_TYPE_META).map(([k, m]) => <option key={k} value={k}>{m.icon} {m.label}</option>)}
              </select>
            </div>
            <div><label style={S.label}>Vendor / Pump Name</label><input style={S.input} value={form.vendor_name} onChange={e => setForm({ ...form, vendor_name: e.target.value })} placeholder="e.g. Sharma Filling Station" /></div>
            <div><label style={S.label}>Bill No</label><input style={S.input} value={form.bill_no} onChange={e => setForm({ ...form, bill_no: e.target.value })} placeholder="Bill / memo no" /></div>
            <div><label style={S.label}>Bill Date</label><input type="date" style={S.input} value={form.bill_date} onChange={e => setForm({ ...form, bill_date: e.target.value })} /></div>
            <div><label style={{ ...S.label, color: '#10b981' }}>Amount (₹) *</label><input type="number" style={{ ...S.input, borderColor: '#10b981', fontWeight: 'bold', fontSize: '16px' }} value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0.00" /></div>
            <div><label style={S.label}>GST (₹)</label><input type="number" style={S.input} value={form.gst_amount} onChange={e => setForm({ ...form, gst_amount: e.target.value })} placeholder="0.00" /></div>
          </div>
          <div style={{ marginTop: '15px' }}>
            <label style={S.label}>Description / Remarks</label>
            <input style={S.input} value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="e.g. 150L HSD top-up at Jorhat" />
          </div>
          <button disabled={saving} onClick={handleSubmit} style={{ width: '100%', marginTop: '20px', padding: '15px', background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#0f172a', border: 'none', borderRadius: '10px', fontWeight: 900, fontSize: '15px', cursor: 'pointer' }}>
            {saving ? '⏳ Filing…' : '📥 FILE FOR ADMIN APPROVAL'}
          </button>
        </div>
      )}

      {/* ── Status tabs ── */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>
        {Object.entries(STATUS_META).map(([k, m]) => {
          const n = rows.filter(r => r.status === k).length;
          return (
            <button key={k} onClick={() => setStatusTab(k)} style={{ padding: '10px 20px', background: statusTab === k ? m.bg : 'transparent', color: statusTab === k ? m.color : '#94a3b8', border: 'none', borderBottom: statusTab === k ? `3px solid ${m.color}` : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer' }}>
              {m.label} {n > 0 && <span style={{ background: m.color, color: '#0f172a', padding: '1px 8px', borderRadius: '10px', marginLeft: '6px', fontSize: '11px' }}>{n}</span>}
            </button>
          );
        })}
      </div>

      {/* ── Queue cards ── */}
      {filtered.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '50px', color: '#64748b', background: 'rgba(30,41,59,0.3)', borderRadius: '15px', border: '1px dashed #334155' }}>
          {statusTab === 'PENDING' ? '🎉 Koi bill approval ke liye pending nahi hai.' : 'No records.'}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '18px' }}>
          {filtered.map(r => {
            const meta = EXPENSE_TYPE_META[r.expense_type] || EXPENSE_TYPE_META.OTHER;
            const sm = STATUS_META[r.status] || STATUS_META.PENDING;
            return (
              <div key={r.id} style={{ background: '#1e293b', border: `1px solid ${sm.color}44`, borderRadius: '15px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ fontWeight: 900, fontSize: '16px' }}>{meta.icon} {meta.label}</div>
                  <span style={{ fontSize: '10px', fontWeight: 'bold', color: sm.color, background: sm.bg, padding: '3px 10px', borderRadius: '12px' }}>{sm.label.toUpperCase()}</span>
                </div>
                <div style={{ fontSize: '30px', fontWeight: 900, color: sm.color }}>₹{Number(r.amount || 0).toLocaleString('en-IN')}</div>
                <div style={{ fontSize: '13px', color: '#cbd5e1' }}>
                  {r.vendor_name && <div>🏪 {r.vendor_name} {r.bill_no && <span style={{ color: '#94a3b8' }}>· Bill {r.bill_no}</span>}</div>}
                  <div style={{ color: '#94a3b8' }}>📅 {r.bill_date || '-'} · by {r.entered_by} {r.source === 'ai_scan' && <span style={{ color: '#c084fc' }}>· 🤖 AI scanned</span>}</div>
                  {r.description && <div style={{ color: '#94a3b8', fontStyle: 'italic' }}>“{r.description}”</div>}
                </div>
                {r.trip_id ? (
                  <div style={{ background: 'rgba(56,189,248,0.06)', border: '1px solid rgba(56,189,248,0.25)', borderRadius: '8px', padding: '8px 12px', fontSize: '12px' }}>
                    🔗 <b style={{ color: '#38bdf8' }}>Trip {r.trip_id}</b> · {r.vehicle_no} {r.driver_name && `· ${r.driver_name}`}
                    {r.trip_status_at_entry === 'COMPLETED' && <span style={{ color: '#f59e0b', fontWeight: 'bold' }}> · CLOSED TRIP (retro-adjust)</span>}
                    {r.match_confidence === 'AMBIGUOUS' && <span style={{ color: '#f59e0b' }}> · ⚠ verify trip</span>}
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: '#64748b' }}>Bina trip — general expense</div>
                )}
                {r.status === 'PENDING' && (
                  isAdmin ? (
                    <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                      <button disabled={busyId === r.id} onClick={() => handleApprove(r)} style={{ flex: 2, padding: '12px', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 900, cursor: 'pointer' }}>
                        {busyId === r.id ? '⏳' : '✅ Approve & Post'}
                      </button>
                      <button disabled={busyId === r.id} onClick={() => handleReject(r)} style={{ flex: 1, padding: '12px', background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>Reject</button>
                    </div>
                  ) : (
                    <div style={{ fontSize: '12px', color: '#f59e0b', textAlign: 'center', padding: '8px', background: 'rgba(245,158,11,0.08)', borderRadius: '8px' }}>🔒 Admin approval awaited</div>
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
