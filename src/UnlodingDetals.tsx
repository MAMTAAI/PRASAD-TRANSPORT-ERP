// @ts-nocheck
// 🏁 UNLOADING & SHORTAGE REGISTER — live PostgreSQL, zero Firestore.
//
// Closing a trip is a money event, so the arithmetic moved to the server. The
// shortage is derived from loaded − unloaded in SQL and never accepted from the
// browser: it is the figure a driver gets charged for. `POST /ops/trips/:id/unload`
// does the whole close in one transaction — quantities, shortage, penalty, the
// driver's khata debit, and (new) the matching general-ledger journal that the
// Firestore version never posted.
//
// The driver-app approval queue survives intact. `driver_unloaded_qty` is what the
// driver submitted and `unloaded_qty` is what the office approved; migration 024
// keeps both, because collapsing them would delete the approval step.
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { sendWhatsApp, waResultText } from './lib/waSend';
import { useIsMobile } from './hooks/useIsMobile';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;
const OPS = `${API}/api/v1/ops`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

const inr = (n: any) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const today = () => new Date().toISOString().slice(0, 10);
const num = (v: any) => Number(v) || 0;

export default function UnloadingDetails() {
  const { isPhone } = useIsMobile();
  const [activeTab, setActiveTab] = useState('MANUAL');
  const [trips, setTrips] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [selectedTripId, setSelectedTripId] = useState('');

  const [unloadingData, setUnloadingData] = useState<any>({
    trip_code: '', vehicle_no: '', loading_point: '', consignee_name: '',
    loaded_qty: 0, unloading_date: today(), unloaded_qty: '',
    shortage_qty: 0, penalty_rate: '', penalty_amount: '', remarks: '',
  });
  const [cardPenaltyRates, setCardPenaltyRates] = useState<any>({});

  // One fetch covers all three tabs: in-transit to unload, driver submissions
  // awaiting approval, and the completed register.
  const fetchTrips = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const j = await fetchJson(`${OPS}/trips?limit=2000`);
      setTrips(j.trips || []);
    } catch (e: any) {
      setTrips([]);
      setErr(`Trips could not load from ${API} — ${e.message}`);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchTrips(); }, [fetchTrips]);

  const handleManualTripSelect = (e: any) => {
    const tId = e.target.value;
    setSelectedTripId(tId);
    if (!tId) {
      setUnloadingData({
        trip_code: '', vehicle_no: '', loading_point: '', consignee_name: '',
        loaded_qty: 0, unloading_date: today(), unloaded_qty: '',
        shortage_qty: 0, penalty_rate: '', penalty_amount: '', remarks: '',
      });
      return;
    }
    const t = trips.find((x) => x.id === tId);
    setUnloadingData({
      trip_code: t.trip_code ?? '',
      vehicle_no: t.vehicle_no ?? '',
      loading_point: t.loading_point ?? '',
      consignee_name: t.consignee_name ?? t.unloading_location ?? '',
      loaded_qty: num(t.loaded_qty) || num(t.driver_loaded_qty),
      unloading_date: today(),
      unloaded_qty: t.driver_unloaded_qty ?? '',
      shortage_qty: 0, penalty_rate: '', penalty_amount: '', remarks: '',
    });
  };

  // Shown live so the user sees the shortage as they type. The server recomputes
  // it on save — this is a preview, not the figure of record.
  const recalc = (patch: any) => {
    setUnloadingData((prev: any) => {
      const next = { ...prev, ...patch };
      if (patch.unloaded_qty !== undefined) {
        next.shortage_qty = Math.max(0, Number((next.loaded_qty - num(patch.unloaded_qty)).toFixed(3)));
      }
      if (patch.penalty_amount === undefined) {
        const rate = num(next.penalty_rate);
        next.penalty_amount = rate > 0 && next.shortage_qty > 0
          ? String(Math.round(next.shortage_qty * rate))
          : next.penalty_amount;
      }
      return next;
    });
  };

  const closeTrip = async (tripId: string, body: any, label: string) => {
    setSaving(true);
    try {
      const out = await fetchJson(`${OPS}/trips/${tripId}/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const rec = out.driver_recovery;
      alert(`✅ ${label}\n\n`
        + `Unloaded ${out.trip.unloaded_qty} · shortage ${out.shortage_qty}\n`
        + (num(out.shortage_penalty) > 0 ? `Penalty ₹${inr(out.shortage_penalty)}\n` : '')
        + (rec
          ? rec.already_posted
            ? `\n💸 ₹${inr(rec.amount)} was already debited to ${rec.driver}'s khata.`
            : rec.ledger_note
              ? `\n💸 ₹${inr(rec.amount)} debited to ${rec.driver}'s khata.\n⚠️ Ledger journal: ${rec.ledger_note}`
              : `\n💸 ₹${inr(rec.amount)} debited to ${rec.driver}'s khata, and posted to the ledger.`
          : '')
        + `\n\nThe trip is now COMPLETED and appears in Bill Management.`);
      setSelectedTripId('');
      fetchTrips();
    } catch (e: any) {
      alert(`❌ ${e.code === 'TRIP_SETTLED' ? 'This trip is already settled and cannot be re-unloaded.' : 'Unloading not saved.'}\n\n${e.message}`);
    }
    setSaving(false);
  };

  const handleManualSave = async () => {
    if (unloadingData.unloaded_qty === '' || unloadingData.unloaded_qty === null) {
      return alert('⚠️ Enter the unloaded quantity.');
    }
    const penalty = num(unloadingData.penalty_amount);
    if (unloadingData.shortage_qty > 0 && penalty <= 0) {
      if (!window.confirm(`⚠️ Shortage of ${unloadingData.shortage_qty} unit(s) with ₹0 penalty.\n\nClose the trip with no driver recovery?`)) return;
    }
    await closeTrip(selectedTripId, {
      unloading_date: unloadingData.unloading_date,
      unloaded_qty: num(unloadingData.unloaded_qty),
      shortage_penalty: penalty,
      unloading_remarks: unloadingData.remarks || null,
      complete: true,
      recover_from_driver: penalty > 0,
    }, 'Unloading saved — trip closed.');
  };

  const handleApproveDriverUnloading = async (t: any) => {
    const loaded = num(t.loaded_qty) || num(t.driver_loaded_qty);
    const unloaded = num(t.driver_unloaded_qty);
    const shortage = Math.max(0, Number((loaded - unloaded).toFixed(3)));
    const rate = num(cardPenaltyRates[t.id]);
    const penalty = shortage > 0 && rate > 0 ? Math.round(shortage * rate) : 0;
    if (shortage > 0 && penalty <= 0) {
      if (!window.confirm(`⚠️ Shortage of ${shortage} unit(s) but no penalty rate entered.\n\nApprove with no driver recovery?`)) return;
    }
    await closeTrip(t.id, {
      unloading_date: today(),
      unloaded_qty: unloaded,
      shortage_penalty: penalty,
      complete: true,
      recover_from_driver: penalty > 0,
    }, `Driver unloading approved for ${t.vehicle_no}.`);
  };

  const sendUnloadingWhatsApp = (t: any) => {
    const mobile = t.driver_mobile;
    if (!mobile) return alert('⚠️ No mobile number on record for this driver.');
    const penaltyAmt = num(t.shortage_penalty);
    const penaltyLine = penaltyAmt > 0
      ? `\n*Shortage Penalty:* ₹${inr(penaltyAmt)} (aapke khata mein debit — hisaab par vasooli hogi)` : '';
    const message = `🏁 *UNLOADING CONFIRMATION*\n\nTrip Completed Successfully.\n\n`
      + `*Trip ID:* ${t.trip_code}\n*Vehicle:* ${t.vehicle_no}\n\n`
      + `*Loaded Qty:* ${t.loaded_qty ?? '-'}\n*Unloaded Qty:* ${t.unloaded_qty ?? '-'}\n`
      + `*Shortage:* ${t.shortage_qty ?? 0}${penaltyLine}\n\n`
      + `Thank you for your service.\n\nRegards,\nPrasad Transport ERP`;
    sendWhatsApp({ phone: mobile, message, tripId: t.trip_code, role: 'Driver' }).then((r) => alert(waResultText(r)));
  };

  // ── Tab data ───────────────────────────────────────────────────────────────
  const inTransitTrips = useMemo(
    () => trips.filter((t) => ['LOADED', 'IN_TRANSIT', 'UNLOADING'].includes(t.status) && !t.office_approved_unloading),
    [trips]);

  // A trip already COMPLETED must never reappear here: approving it again would
  // overwrite the settled quantities and the shortage already recovered.
  const pendingDriverApprovals = useMemo(
    () => trips.filter((t) => t.driver_unloaded_qty != null && !t.office_approved_unloading
      && t.office_approved_loading && t.status !== 'COMPLETED' && t.status !== 'SETTLED'),
    [trips]);

  const completedTrips = useMemo(
    () => trips.filter((t) => t.status === 'COMPLETED' || t.status === 'SETTLED' || t.office_approved_unloading)
      .sort((a, b) => String(b.unloading_date ?? '').localeCompare(String(a.unloading_date ?? ''))),
    [trips]);

  const inputStyle = { width: '100%', padding: '12px 14px', minHeight: '48px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '12px', fontSize: '15px', boxSizing: 'border-box' as const, outline: 'none', colorScheme: 'dark' as const };
  const autoFillStyle = { ...inputStyle, background: 'rgba(56, 189, 248, 0.05)', border: '1px dashed #38bdf8', color: '#94a3b8' };

  const billingBadge = (t: any) => t.billing_status === 'BILLED' || t.bill_no
    ? <span className="pt-badge pt-badge--success">Billed{t.bill_no ? ` ${t.bill_no}` : ''}</span>
    : num(t.freight_amount) > 0
      ? <span className="pt-badge pt-badge--info">🧾 Priced</span>
      : <span className="pt-badge pt-badge--warning">Billing Pending</span>;

  return (
    <div className="pt-anim-fade" style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'clamp(22px, 5vw, 28px)', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>🏁 Unloading & Shortage Register</h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>
            Live PostgreSQL · shortage computed server-side, driver khata and ledger posted together
          </p>
        </div>
        <button onClick={fetchTrips} className="pt-btn pt-btn--ghost" style={{ minHeight: 44 }}>🔄 Refresh</button>
      </div>

      {err && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid #ef4444', color: '#fca5a5', padding: '14px 18px', borderRadius: 12, marginBottom: 18, fontSize: 14 }}>
          ⚠️ {err}
          <div style={{ color: '#94a3b8', marginTop: 6, fontSize: 12 }}>Reads <code>{OPS}/trips</code>. Check that the ERP API is running.</div>
        </div>
      )}

      <div style={{ display: 'flex', gap: '6px', marginBottom: '25px', borderBottom: '1px solid #334155', overflowX: 'auto' }}>
        <button className={`pt-tab ${activeTab === 'MANUAL' ? 'is-active is-active--success' : ''}`} onClick={() => setActiveTab('MANUAL')}>✍️ MANUAL UNLOADING</button>
        <button className={`pt-tab ${activeTab === 'AUTO' ? 'is-active' : ''}`} onClick={() => setActiveTab('AUTO')}>
          📱 APP SYNC (Driver) {pendingDriverApprovals.length > 0 && <span className="pt-tab__count">{pendingDriverApprovals.length}</span>}
        </button>
        <button className={`pt-tab ${activeTab === 'REGISTER' ? 'is-active is-active--warning' : ''}`} onClick={() => setActiveTab('REGISTER')}>
          📋 COMPLETED TRIPS {completedTrips.length > 0 && <span className="pt-tab__count">{completedTrips.length}</span>}
        </button>
      </div>

      {/* ✍️ TAB 1: MANUAL UNLOADING */}
      {activeTab === 'MANUAL' && (
        <div className="pt-anim-up" style={{ background: 'linear-gradient(180deg, rgba(30,41,59,0.7), rgba(15,23,42,0.9))', border: '1px solid #334155', borderRadius: '18px', padding: 'clamp(16px, 3vw, 30px)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}>

          <div style={{ marginBottom: '20px', background: 'rgba(16, 185, 129, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
            <label style={{ color: '#10b981', fontSize: '13px', fontWeight: 'bold', marginBottom: '8px', display: 'block' }}>
              🔍 Select an on-road trip to unload * {loading && <span style={{ color: '#38bdf8' }}>(loading…)</span>}
            </label>
            <select value={selectedTripId} onChange={handleManualTripSelect} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #10b981', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '15px' }}>
              <option value="">-- Choose Active Trip --</option>
              {inTransitTrips.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.vehicle_no} | {t.loading_point ?? '?'} ➔ {t.consignee_name ?? t.unloading_location ?? '?'} | Qty: {t.loaded_qty ?? t.driver_loaded_qty ?? '-'}
                </option>
              ))}
            </select>
            {!loading && inTransitTrips.length === 0 && (
              <div style={{ color: '#64748b', fontSize: 12, marginTop: 8 }}>No trips are on the road. Dispatch one from Loading Details first.</div>
            )}
          </div>

          {selectedTripId && (
            <>
              <h4 style={{ color: '#38bdf8', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '15px' }}>Verify Trip Details</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '30px' }}>
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Trip Code</label><input type="text" value={unloadingData.trip_code} readOnly style={autoFillStyle} /></div>
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Vehicle No</label><input type="text" value={unloadingData.vehicle_no} readOnly style={autoFillStyle} /></div>
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Loading Point</label><input type="text" value={unloadingData.loading_point} readOnly style={autoFillStyle} /></div>
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Consignee</label><input type="text" value={unloadingData.consignee_name} readOnly style={autoFillStyle} /></div>
              </div>

              <h4 style={{ color: '#ef4444', borderBottom: '1px dashed #ef4444', paddingBottom: '10px', marginBottom: '15px' }}>Enter Unloading & Calculate Shortage</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '25px', background: 'rgba(239, 68, 68, 0.05)', padding: '20px', borderRadius: '10px' }}>
                <div>
                  <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Original Loaded Qty</label>
                  <input type="text" value={unloadingData.loaded_qty} readOnly style={{ ...autoFillStyle, fontSize: '18px', fontWeight: 'bold', color: '#38bdf8' }} />
                </div>
                <div>
                  <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Unloaded Qty (Received) *</label>
                  <input type="number" inputMode="decimal" value={unloadingData.unloaded_qty} onChange={(e) => recalc({ unloaded_qty: e.target.value })} style={{ ...inputStyle, borderColor: '#10b981', fontSize: '18px', fontWeight: 'bold', color: '#10b981' }} placeholder="0.00" />
                  <button type="button" className={`pt-chip ${num(unloadingData.unloaded_qty) === unloadingData.loaded_qty && unloadingData.loaded_qty > 0 ? 'is-on is-on--success' : ''}`} style={{ marginTop: '8px', width: '100%' }}
                    onClick={() => recalc({ unloaded_qty: String(unloadingData.loaded_qty) })}>
                    ✅ Full Unload — No Shortage
                  </button>
                </div>
                <div>
                  <label style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Shortage Qty (server recomputes)</label>
                  <input type="text" value={unloadingData.shortage_qty} readOnly style={{ ...autoFillStyle, borderColor: '#ef4444', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', fontSize: '18px', fontWeight: 'bold' }} />
                </div>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', display: 'block', marginBottom: '5px' }}>Unloading Date</label>
                  <input type="date" value={unloadingData.unloading_date} onChange={(e) => setUnloadingData({ ...unloadingData, unloading_date: e.target.value })} style={{ ...inputStyle, colorScheme: 'dark' }} />
                </div>
              </div>

              <h4 style={{ color: '#f59e0b', borderBottom: '1px dashed #f59e0b', paddingBottom: '10px', marginBottom: '15px' }}>⚖️ Driver Shortage Recovery (khata + ledger)</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '25px', background: 'rgba(245, 158, 11, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(245,158,11,0.2)' }}>
                <div>
                  <label style={{ color: '#f59e0b', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Penalty Rate (₹ per unit short)</label>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                    {[['₹50', '50'], ['₹90 HSD', '90'], ['₹100 MS', '100'], ['₹110 ATF', '110']].map(([lbl, v]) => (
                      <button key={v} type="button" className={`pt-chip ${unloadingData.penalty_rate === v ? 'is-on is-on--warning' : ''}`} onClick={() => recalc({ penalty_rate: v })}>{lbl}</button>
                    ))}
                  </div>
                  <input type="number" inputMode="decimal" value={unloadingData.penalty_rate} onChange={(e) => recalc({ penalty_rate: e.target.value })} style={{ ...inputStyle, borderColor: '#f59e0b' }} placeholder="or type a custom rate" />
                </div>
                <div>
                  <label style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Penalty ₹ (shortage × rate, editable)</label>
                  <input type="number" value={unloadingData.penalty_amount} onChange={(e) => recalc({ penalty_amount: e.target.value })} style={{ ...inputStyle, borderColor: '#ef4444', color: '#ef4444', fontSize: '18px', fontWeight: 'bold' }} placeholder="0" />
                </div>
                <div style={{ alignSelf: 'end', fontSize: '12px', color: '#94a3b8', lineHeight: 1.6 }}>
                  💸 On save this is debited to the driver's khata <b style={{ color: '#f59e0b' }}>and posted to the ledger</b> (Dr driver advance / Cr shortage expense). ₹0 = no recovery.
                </div>
              </div>

              <div>
                <label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px' }}>Remarks / Shortage Note</label>
                <input type="text" value={unloadingData.remarks} onChange={(e) => setUnloadingData({ ...unloadingData, remarks: e.target.value })} style={inputStyle} placeholder="e.g. temperature loss or pilferage" />
              </div>

              <button onClick={handleManualSave} disabled={saving} className="pt-anim-pop" style={{ width: '100%', marginTop: '20px', minHeight: '54px', background: saving ? '#334155' : 'linear-gradient(135deg, #ef4444, #b91c1c)', color: '#fff', border: 'none', padding: '15px', borderRadius: '14px', fontWeight: '900', cursor: saving ? 'not-allowed' : 'pointer', fontSize: '16px', boxShadow: '0 8px 24px rgba(239,68,68,0.4)' }}>
                {saving ? 'Saving…' : '🏁 SAVE UNLOADING & CLOSE TRIP'}
              </button>
            </>
          )}
        </div>
      )}

      {/* 📱 TAB 2: APP SYNC */}
      {activeTab === 'AUTO' && (
        <div className="pt-stagger" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(320px, 100%), 1fr))', gap: '20px' }}>
          {pendingDriverApprovals.length === 0 ? (
            <div className="pt-anim-up" style={{ color: '#64748b', padding: '40px', textAlign: 'center', background: 'rgba(30,41,59,0.3)', borderRadius: '16px', border: '1px dashed #334155', gridColumn: '1 / -1' }}>
              🎉 No pending unloading approvals from the driver app.
            </div>
          ) : pendingDriverApprovals.map((t) => {
            const loaded = num(t.loaded_qty) || num(t.driver_loaded_qty);
            const unloaded = num(t.driver_unloaded_qty);
            const shortage = Number((loaded - unloaded).toFixed(3));
            const rate = num(cardPenaltyRates[t.id]);
            return (
              <div key={t.id} className="pt-card pt-card--accent-primary" style={{ position: 'relative' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <span style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '18px' }}>{t.vehicle_no}</span>
                  <span style={{ background: '#334155', padding: '2px 8px', borderRadius: '5px', fontSize: '11px' }}>{t.trip_code}</span>
                </div>
                <div style={{ marginBottom: '10px' }}><span className="pt-pill pt-pill--pending-unload">Pending Unload</span></div>
                <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '15px' }}>📍 {t.loading_point} ➔ {t.consignee_name ?? t.unloading_location}</div>

                <div style={{ display: 'flex', justifyContent: 'space-between', background: 'rgba(56, 189, 248, 0.05)', padding: '10px', borderRadius: '10px', marginBottom: '10px' }}>
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>Loaded: <b style={{ color: '#38bdf8' }}>{loaded}</b></span>
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>Driver says: <b style={{ color: '#10b981' }}>{unloaded}</b></span>
                </div>

                <div style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '15px', borderRadius: '10px', marginBottom: '15px', textAlign: 'center', border: '1px dashed #ef4444' }}>
                  <div style={{ fontSize: '12px', color: '#ef4444', textTransform: 'uppercase', fontWeight: 'bold' }}>Calculated Shortage</div>
                  <div style={{ fontSize: '24px', fontWeight: '900', color: '#ef4444' }}>{shortage}</div>
                  {t.driver_unloading_photo && (
                    <a href={t.driver_unloading_photo} target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: '#10b981', textDecoration: 'none', marginTop: '5px', display: 'inline-block' }}>📎 View Receipt / Dip Photo</a>
                  )}
                </div>

                {shortage > 0 && (
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px', background: 'rgba(245,158,11,0.08)', border: '1px dashed #f59e0b', borderRadius: '10px', padding: '10px' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 'bold', display: 'block' }}>PENALTY RATE ₹/unit</label>
                      <input type="number" value={cardPenaltyRates[t.id] || ''} onChange={(e) => setCardPenaltyRates({ ...cardPenaltyRates, [t.id]: e.target.value })} placeholder="e.g. 90"
                        style={{ width: '100%', padding: '8px', background: '#0f172a', border: '1px solid #f59e0b', color: '#fff', borderRadius: '6px', boxSizing: 'border-box' }} />
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '10px', color: '#ef4444', fontWeight: 'bold' }}>DRIVER DEBIT</div>
                      <div style={{ fontSize: '18px', fontWeight: 900, color: '#ef4444' }}>₹{inr(rate > 0 ? Math.round(rate * shortage) : 0)}</div>
                    </div>
                  </div>
                )}

                <button onClick={() => handleApproveDriverUnloading(t)} disabled={saving} className="pt-btn pt-btn--success" style={{ width: '100%', minHeight: '50px', fontWeight: 900, fontSize: '15px' }}>
                  {saving ? 'Saving…' : '✅ Approve & Close Trip'}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* 📋 TAB 3: COMPLETED REGISTER */}
      {activeTab === 'REGISTER' && isPhone && (
        <div className="pt-stagger" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {loading ? <div style={{ color: '#38bdf8', textAlign: 'center', padding: '30px' }}>Loading…</div>
            : completedTrips.length === 0 ? <div style={{ color: '#64748b', textAlign: 'center', padding: '30px' }}>No completed trips found.</div>
            : completedTrips.map((t) => {
              const penaltyAmt = num(t.shortage_penalty);
              return (
                <div key={t.id} className={`pt-card ${penaltyAmt > 0 ? 'pt-card--accent-danger' : 'pt-card--accent-success'}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <b style={{ color: '#38bdf8', fontSize: '17px' }}>{t.vehicle_no}</b>
                    <span className="pt-badge pt-badge--success">{t.status}</span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '10px' }}>
                    {t.trip_code} · {t.driver_name}<br />
                    📍 {t.loading_point} ➔ {t.consignee_name ?? t.unloading_location}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
                    <span className="pt-badge pt-badge--info">Ld {t.loaded_qty ?? '-'}</span>
                    <span className="pt-badge pt-badge--success">Un {t.unloaded_qty ?? '-'}</span>
                    {num(t.shortage_qty) > 0 && <span className="pt-badge pt-badge--danger">Short {t.shortage_qty}</span>}
                    {penaltyAmt > 0 && <span className="pt-badge pt-badge--danger">💸 ₹{inr(penaltyAmt)} Driver</span>}
                    {billingBadge(t)}
                  </div>
                  <button onClick={() => sendUnloadingWhatsApp(t)} className="pt-btn pt-btn--ghost" style={{ width: '100%', minHeight: '46px', borderColor: '#22c55e', color: '#22c55e' }}>💬 Send WhatsApp Alert</button>
                </div>
              );
            })}
        </div>
      )}

      {activeTab === 'REGISTER' && !isPhone && (
        <div className="pt-anim-up" style={{ background: '#1e293b', borderRadius: '16px', overflowX: 'auto', border: '1px solid #334155', boxShadow: '0 8px 24px rgba(0,0,0,0.3)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
            <thead style={{ background: '#0f172a', color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase' }}>
              <tr>
                <th style={{ padding: '15px' }}>Trip</th>
                <th style={{ padding: '15px', color: '#38bdf8' }}>Vehicle</th>
                <th style={{ padding: '15px' }}>Route (From ➔ To)</th>
                <th style={{ padding: '15px', color: '#38bdf8' }}>Loaded</th>
                <th style={{ padding: '15px', color: '#10b981' }}>Unloaded</th>
                <th style={{ padding: '15px', color: '#ef4444' }}>Shortage</th>
                <th style={{ padding: '15px', color: '#ef4444' }}>Penalty ₹ (Driver)</th>
                <th style={{ padding: '15px' }}>Driver</th>
                <th style={{ padding: '15px', color: '#10b981' }}>Billing</th>
                <th style={{ padding: '15px', textAlign: 'center' }}>Notify Driver</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={10} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8' }}>Loading from PostgreSQL…</td></tr>
                : completedTrips.length === 0 ? <tr><td colSpan={10} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No completed trips found.</td></tr>
                : completedTrips.map((t) => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '12px' }}>
                    <td style={{ padding: '12px 15px' }}>{t.trip_code}<br /><span className="pt-pill pt-pill--completed" style={{ marginTop: '4px' }}>{t.status}</span></td>
                    <td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: 'bold' }}>{t.vehicle_no}</td>
                    <td style={{ padding: '12px 15px' }}>{t.loading_point} ➔ {t.consignee_name ?? t.unloading_location}</td>
                    <td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: 'bold' }}>{t.loaded_qty ?? '-'}</td>
                    <td style={{ padding: '12px 15px', color: '#10b981', fontWeight: 'bold' }}>{t.unloaded_qty ?? '-'}</td>
                    <td style={{ padding: '12px 15px', color: '#ef4444', fontWeight: '900' }}>{t.shortage_qty ?? '0'}</td>
                    <td style={{ padding: '12px 15px', color: '#ef4444', fontWeight: '900' }}>{num(t.shortage_penalty) > 0 ? `₹${inr(t.shortage_penalty)} 💸` : '—'}</td>
                    <td style={{ padding: '12px 15px' }}>{t.driver_name}</td>
                    <td style={{ padding: '12px 15px' }}>{billingBadge(t)}</td>
                    <td style={{ padding: '12px 15px', textAlign: 'center' }}>
                      <button onClick={() => sendUnloadingWhatsApp(t)}
                        style={{ background: 'rgba(34, 197, 94, 0.2)', border: '1px solid #22c55e', color: '#22c55e', padding: '6px 12px', borderRadius: '20px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>
                        💬 Send Alert
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
