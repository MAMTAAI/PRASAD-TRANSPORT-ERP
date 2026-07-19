// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc, Timestamp } from 'firebase/firestore';
import { db } from './firebase';
import { postShortageRecovery, buildDraftInvoice } from './lib/postTripEngine';

export default function UnloadingDetails() {
  const [activeTab, setActiveTab] = useState('MANUAL');
  const [trips, setTrips] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTripId, setSelectedTripId] = useState('');

  const [unloadingData, setUnloadingData] = useState({
    Trip_ID: '', Vehical_No: '', Loading_Point: '', Consignee_Name: '',
    Loaded_Qty: 0, Unloading_Date: new Date().toISOString().split('T')[0],
    Unloaded_Qty: '', Shortage_Qty: 0, Penalty_Rate: '', Penalty_Amount: '', Remarks: ''
  });
  // 📱 APP-SYNC cards: per-trip penalty rate (₹/unit) for driver approvals
  const [cardPenaltyRates, setCardPenaltyRates] = useState<any>({});

  useEffect(() => {
    fetchTrips();
  }, []);

  const fetchTrips = async () => {
    setLoading(true);
    try {
      const tripSnap = await getDocs(collection(db, "TRIPS"));
      setTrips(tripSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) {
      console.error("Error fetching trips:", error);
    }
    setLoading(false);
  };

  const handleManualTripSelect = (e: any) => {
    const tId = e.target.value;
    setSelectedTripId(tId);
    
    if (tId) {
      const t = trips.find(trip => trip.id === tId);
      const loaded = parseFloat(t.loaded_qty || t.Loaded_Qty || t.driver_loaded_qty || 0);
      
      setUnloadingData({
        Trip_ID: t.trip_id || t.Trip_ID || t.id,
        Vehical_No: t.vehicle_no || t.vehical_no || t.Vehical_No || '',
        Loading_Point: t.loading_point || t.Loading_Point || '',
        Consignee_Name: t.consignee_name || t.Consignee_Name || '',
        Loaded_Qty: loaded,
        Unloading_Date: new Date().toISOString().split('T')[0],
        Unloaded_Qty: t.driver_unloaded_qty || '',
        Shortage_Qty: 0,
        Penalty_Rate: '', Penalty_Amount: '',
        Remarks: ''
      });
    } else {
      setUnloadingData({ Trip_ID: '', Vehical_No: '', Loading_Point: '', Consignee_Name: '', Loaded_Qty: 0, Unloading_Date: new Date().toISOString().split('T')[0], Unloaded_Qty: '', Shortage_Qty: 0, Penalty_Rate: '', Penalty_Amount: '', Remarks: '' });
    }
  };

  // 🧮 Auto Calculate Shortage + Driver Penalty (Shortage × Rate, override allowed)
  const recalc = (patch: any) => {
    setUnloadingData(prev => {
      const next = { ...prev, ...patch };
      if (patch.Unloaded_Qty !== undefined) {
        const unloaded = parseFloat(patch.Unloaded_Qty) || 0;
        next.Shortage_Qty = parseFloat(Math.max(0, next.Loaded_Qty - unloaded).toFixed(2));
      }
      if (patch.Penalty_Amount === undefined) {
        const rate = parseFloat(next.Penalty_Rate) || 0;
        next.Penalty_Amount = (rate > 0 && next.Shortage_Qty > 0) ? String(Math.round(next.Shortage_Qty * rate)) : next.Penalty_Amount;
      }
      return next;
    });
  };
  const handleUnloadedQtyChange = (e: any) => recalc({ Unloaded_Qty: e.target.value });

  // 🏁 Close trip: shortage → auto driver-khata debit; billing → auto-draft invoice.
  const closeTripCore = async (trip: any, figures: { unloaded: number; shortage: number; penalty: number; date: string; remarks?: string }) => {
    const { unloaded, shortage, penalty, date, remarks } = figures;
    const draft = buildDraftInvoice(trip, { unloaded_qty: unloaded, shortage_qty: shortage, penalty_amount: penalty });
    const alreadyBilled = (trip.billing_status || '') === 'BILLED';
    await updateDoc(doc(db, "TRIPS", trip.id), {
      office_approved_unloading: true,
      trip_status: 'COMPLETED',
      Unloaded_Qty: unloaded, unloaded_qty: unloaded,
      Shortage_Qty: shortage, shortage_qty: shortage,
      // 💸 Driver liability + party-side deduction reflect the same shortage ₹
      shortage_penalty: penalty, shortage_amt: penalty, Shortage_Amt: penalty,
      Unloading_Date: date, unloading_date: date,
      ...(remarks !== undefined ? { unloading_remarks: remarks } : {}),
      // 🧾 Auto-draft invoice → Pending Billing dashboard picks this up
      draft_invoice: draft,
      ...(alreadyBilled ? {} : { billing_status: 'PENDING' }),
      completed_at: Timestamp.now()
    });
    // ⚖️ Auto-Shortage Recovery: debit the driver's khata immediately (idempotent)
    const debited = penalty > 0 ? await postShortageRecovery(trip, { shortage_qty: shortage, penalty_amount: penalty, date }) : false;
    return { draft, debited };
  };

  const handleManualSave = async () => {
    if (!unloadingData.Unloaded_Qty) return alert("⚠️ Please enter Unloaded Quantity!");
    const trip = trips.find(t => t.id === selectedTripId);
    if (!trip) return alert("⚠️ Trip not found — refresh and retry.");
    const penalty = parseFloat(unloadingData.Penalty_Amount) || 0;
    if (unloadingData.Shortage_Qty > 0 && penalty <= 0) {
      if (!window.confirm(`⚠️ Shortage ${unloadingData.Shortage_Qty} units hai par Penalty ₹0 — bina driver-recovery ke close karein?`)) return;
    }
    try {
      const { debited } = await closeTripCore(trip, {
        unloaded: parseFloat(unloadingData.Unloaded_Qty) || 0,
        shortage: unloadingData.Shortage_Qty,
        penalty,
        date: unloadingData.Unloading_Date,
        remarks: unloadingData.Remarks,
      });
      alert(`✅ Unloading Saved! Trip COMPLETED.\n🧾 Draft invoice ready — Pending Billing mein dikhega.${debited ? `\n💸 ₹${penalty.toLocaleString('en-IN')} driver khata (${trip.driver_name || trip.Driver_Name || 'driver'}) mein SHORTAGE debit ho gaya.` : ''}`);
      setSelectedTripId('');
      fetchTrips();
    } catch (e) { alert("❌ Error saving unloading entry."); }
  };

  const handleApproveDriverUnloading = async (trip: any) => {
    try {
      const loaded = parseFloat(trip.loaded_qty || trip.Loaded_Qty || trip.driver_loaded_qty || 0);
      const unloaded = parseFloat(trip.driver_unloaded_qty || 0);
      const shortage = parseFloat(Math.max(0, loaded - unloaded).toFixed(2));
      const rate = parseFloat(cardPenaltyRates[trip.id]) || 0;
      const penalty = shortage > 0 && rate > 0 ? Math.round(shortage * rate) : 0;
      if (shortage > 0 && penalty <= 0) {
        if (!window.confirm(`⚠️ Shortage ${shortage} units hai par Penalty Rate nahi dala — bina driver-recovery ke approve karein?`)) return;
      }
      const { debited } = await closeTripCore(trip, {
        unloaded, shortage, penalty,
        date: new Date().toISOString().split('T')[0],
      });
      alert(`✅ Driver Unloading Approved! Trip COMPLETED.\n🧾 Draft invoice ready.${debited ? `\n💸 ₹${penalty.toLocaleString('en-IN')} driver khata mein SHORTAGE debit ho gaya.` : ''}`);
      fetchTrips();
    } catch (e) { alert("❌ Error approving data."); }
  };

  // 💬 Send WhatsApp Unloading Alert
  const sendUnloadingWhatsApp = (trip: any) => {
    const mobile = trip.Driver_Mobil_No || trip.driver_mobil_no || trip.driver_mobile;
    if (!mobile) return alert("⚠️ No mobile number found for this driver!");

    const tripId = trip.Trip_ID || trip.trip_id;
    const vehicle = trip.Vehical_No || trip.vehicle_no || trip.vehical_no;
    const loaded = trip.Loaded_Qty || trip.loaded_qty || trip.driver_loaded_qty;
    const unloaded = trip.Unloaded_Qty || trip.unloaded_qty || trip.driver_unloaded_qty;
    const shortage = trip.Shortage_Qty || trip.shortage_qty || '0';

    const penaltyAmt = parseFloat(trip.shortage_penalty || trip.shortage_amt || 0) || 0;
    const penaltyLine = penaltyAmt > 0 ? `\n*Shortage Penalty:* ₹${penaltyAmt.toLocaleString('en-IN')} (aapke khata mein debit — hisaab par vasooli hogi)` : '';
    const message = `🏁 *UNLOADING CONFIRMATION*\n\nTrip Completed Successfully.\n\n*Trip ID:* ${tripId}\n*Vehicle:* ${vehicle}\n\n*Loaded Qty:* ${loaded} Ltrs\n*Unloaded Qty:* ${unloaded} Ltrs\n*Shortage:* ${shortage} Ltrs${penaltyLine}\n\nThank you for your service.\n\nRegards,\nPrasad Transport ERP`;
    
    let phone = mobile.replace(/\s+/g, ''); 
    if (phone.length === 10) phone = '91' + phone;

    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
  };

  // 🔍 Filters
  const inTransitTrips = trips.filter(t => t.trip_status === 'IN_TRANSIT' && !t.office_approved_unloading);
  // Guard: a trip already COMPLETED (e.g. closed via Trip Command Center) must
  // never reappear as "pending approval" — approving it again would overwrite
  // the settled quantities and shortage figures.
  const pendingDriverApprovals = trips.filter(t => t.driver_unloaded_qty && !t.office_approved_unloading && t.office_approved_loading && t.trip_status !== 'COMPLETED');
  const completedTrips = trips.filter(t => t.office_approved_unloading || t.trip_status === 'COMPLETED').sort((a:any, b:any) => new Date(b.completed_at?.toDate() || 0).getTime() - new Date(a.completed_at?.toDate() || 0).getTime());

  const inputStyle = { width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' as const, outline: 'none' };
  const autoFillStyle = { ...inputStyle, background: 'rgba(56, 189, 248, 0.05)', border: '1px dashed #38bdf8', color: '#94a3b8' };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '28px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>🏁 Unloading & Shortage Register</h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Close Trips and Auto-Calculate Shortages</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '25px', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>
        <button onClick={() => setActiveTab('MANUAL')} style={{ padding: '10px 20px', background: activeTab === 'MANUAL' ? 'rgba(16, 185, 129, 0.1)' : 'transparent', color: activeTab === 'MANUAL' ? '#10b981' : '#94a3b8', border: 'none', borderBottom: activeTab === 'MANUAL' ? '3px solid #10b981' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>✍️ MANUAL UNLOADING</button>
        <button onClick={() => setActiveTab('AUTO')} style={{ padding: '10px 20px', background: activeTab === 'AUTO' ? 'rgba(56, 189, 248, 0.1)' : 'transparent', color: activeTab === 'AUTO' ? '#38bdf8' : '#94a3b8', border: 'none', borderBottom: activeTab === 'AUTO' ? '3px solid #38bdf8' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>📱 APP SYNC (Driver) {pendingDriverApprovals.length > 0 && <span style={{background:'#ef4444', color:'white', padding:'2px 8px', borderRadius:'10px', marginLeft:'5px', fontSize:'11px'}}>{pendingDriverApprovals.length} Pending</span>}</button>
        <button onClick={() => setActiveTab('REGISTER')} style={{ padding: '10px 20px', background: activeTab === 'REGISTER' ? 'rgba(245, 158, 11, 0.1)' : 'transparent', color: activeTab === 'REGISTER' ? '#f59e0b' : '#94a3b8', border: 'none', borderBottom: activeTab === 'REGISTER' ? '3px solid #f59e0b' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>📋 COMPLETED TRIPS</button>
      </div>

      {/* ✍️ TAB 1: MANUAL UNLOADING */}
      {activeTab === 'MANUAL' && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '15px', padding: '30px' }}>
          
          <div style={{ marginBottom: '20px', background: 'rgba(16, 185, 129, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
            <label style={{ color: '#10b981', fontSize: '13px', fontWeight: 'bold', marginBottom: '8px', display: 'block' }}>🔍 Select "In-Transit" Trip to Unload *</label>
            <select value={selectedTripId} onChange={handleManualTripSelect} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #10b981', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '15px' }}>
              <option value="">-- Choose Active Trip --</option>
              {inTransitTrips.map(t => <option key={t.id} value={t.id}>{t.vehicle_no || t.vehical_no} | {t.loading_point} ➔ {t.consignee_name} | Qty: {t.loaded_qty || t.driver_loaded_qty}</option>)}
            </select>
          </div>

          {selectedTripId && (
            <>
              <h4 style={{ color: '#38bdf8', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '15px' }}>Verify Trip Details</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '30px' }}>
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Trip ID</label><input type="text" value={unloadingData.Trip_ID} readOnly style={autoFillStyle} /></div>
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Vehicle No</label><input type="text" value={unloadingData.Vehical_No} readOnly style={autoFillStyle} /></div>
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Loading Point</label><input type="text" value={unloadingData.Loading_Point} readOnly style={autoFillStyle} /></div>
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Consignee Name</label><input type="text" value={unloadingData.Consignee_Name} readOnly style={autoFillStyle} /></div>
              </div>

              <h4 style={{ color: '#ef4444', borderBottom: '1px dashed #ef4444', paddingBottom: '10px', marginBottom: '15px' }}>Enter Unloading & Calculate Shortage</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '25px', background: 'rgba(239, 68, 68, 0.05)', padding: '20px', borderRadius: '10px' }}>
                <div>
                  <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Original Loaded Qty</label>
                  <input type="text" value={unloadingData.Loaded_Qty} readOnly style={{ ...autoFillStyle, fontSize: '18px', fontWeight: 'bold', color: '#38bdf8' }} />
                </div>
                <div>
                  <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Unloaded Qty (Received) *</label>
                  <input type="number" value={unloadingData.Unloaded_Qty} onChange={handleUnloadedQtyChange} style={{ ...inputStyle, borderColor: '#10b981', fontSize: '18px', fontWeight: 'bold', color: '#10b981' }} placeholder="0.00" />
                </div>
                <div>
                  <label style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>System Shortage Qty</label>
                  <input type="text" value={unloadingData.Shortage_Qty} readOnly style={{ ...autoFillStyle, borderColor: '#ef4444', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', fontSize: '18px', fontWeight: 'bold' }} />
                </div>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', display: 'block', marginBottom: '5px' }}>Unloading Date</label>
                  <input type="date" value={unloadingData.Unloading_Date} onChange={e => setUnloadingData({...unloadingData, Unloading_Date: e.target.value})} style={{ ...inputStyle, colorScheme: 'dark' }} />
                </div>
              </div>

              {/* ⚖️ AUTO-SHORTAGE RECOVERY (Driver Liability) */}
              <h4 style={{ color: '#f59e0b', borderBottom: '1px dashed #f59e0b', paddingBottom: '10px', marginBottom: '15px' }}>⚖️ Driver Shortage Recovery (Auto-Debit to Khata)</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '25px', background: 'rgba(245, 158, 11, 0.05)', padding: '20px', borderRadius: '10px', border: '1px solid rgba(245,158,11,0.2)' }}>
                <div>
                  <label style={{ color: '#f59e0b', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Penalty Rate (₹ per unit short)</label>
                  <input type="number" value={unloadingData.Penalty_Rate} onChange={e => recalc({ Penalty_Rate: e.target.value })} style={{ ...inputStyle, borderColor: '#f59e0b' }} placeholder="e.g. 90 (HSD rate)" />
                </div>
                <div>
                  <label style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Penalty ₹ (Auto = Shortage × Rate, editable)</label>
                  <input type="number" value={unloadingData.Penalty_Amount} onChange={e => recalc({ Penalty_Amount: e.target.value })} style={{ ...inputStyle, borderColor: '#ef4444', color: '#ef4444', fontSize: '18px', fontWeight: 'bold' }} placeholder="0" />
                </div>
                <div style={{ alignSelf: 'end', fontSize: '12px', color: '#94a3b8', lineHeight: 1.6 }}>
                  💸 Save par yeh amount <b style={{ color: '#f59e0b' }}>driver ke khata mein SHORTAGE debit</b> hoga aur client bill se bhi deduct dikhega. ₹0 = koi recovery nahi.
                </div>
              </div>

              <div>
                  <label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px' }}>Remarks / Shortage Note</label>
                  <input type="text" value={unloadingData.Remarks} onChange={e => setUnloadingData({...unloadingData, Remarks: e.target.value})} style={inputStyle} placeholder="e.g. Temperature loss or pilferage" />
              </div>

              <button onClick={handleManualSave} style={{ width: '100%', marginTop: '20px', background: 'linear-gradient(135deg, #ef4444, #b91c1c)', color: '#fff', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', fontSize: '16px', boxShadow: '0 5px 15px rgba(239,68,68,0.4)' }}>
                🏁 SAVE UNLOADING & CLOSE TRIP
              </button>
            </>
          )}
        </div>
      )}

      {/* 📱 TAB 2: AUTO SYNC */}
      {activeTab === 'AUTO' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px' }}>
          {pendingDriverApprovals.length === 0 ? <div style={{ color: '#64748b' }}>No pending unloading approvals from driver app.</div> : 
            pendingDriverApprovals.map(t => {
              const loaded = parseFloat(t.loaded_qty || t.Loaded_Qty || t.driver_loaded_qty || 0);
              const unloaded = parseFloat(t.driver_unloaded_qty || 0);
              const shortage = (loaded - unloaded).toFixed(2);

              return (
                <div key={t.id} style={{ background: '#1e293b', border: '1px solid #38bdf8', borderRadius: '15px', padding: '20px', position: 'relative' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                    <span style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '18px' }}>{t.Vehical_No || t.vehicle_no || t.vehical_no}</span>
                    <span style={{ background: '#334155', padding: '2px 8px', borderRadius: '5px', fontSize: '11px' }}>{t.Trip_ID || t.trip_id}</span>
                  </div>
                  <div style={{ marginBottom: '10px' }}><span className="pt-pill pt-pill--pending-unload">Pending Unload</span></div>
                  <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '15px' }}>📍 {t.Loading_Point || t.loading_point} ➔ {t.Consignee_Name || t.consignee_name}</div>
                  
                  <div style={{ display: 'flex', justifyContent: 'space-between', background: 'rgba(56, 189, 248, 0.05)', padding: '10px', borderRadius: '10px', marginBottom: '10px' }}>
                    <span style={{ fontSize: '12px', color: '#94a3b8' }}>Loaded: <b style={{color: '#38bdf8'}}>{loaded} Ltrs</b></span>
                    <span style={{ fontSize: '12px', color: '#94a3b8' }}>Unloaded: <b style={{color: '#10b981'}}>{unloaded} Ltrs</b></span>
                  </div>

                  <div style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '15px', borderRadius: '10px', marginBottom: '15px', textAlign: 'center', border: '1px dashed #ef4444' }}>
                    <div style={{ fontSize: '12px', color: '#ef4444', textTransform: 'uppercase', fontWeight: 'bold' }}>Calculated Shortage</div>
                    <div style={{ fontSize: '24px', fontWeight: '900', color: '#ef4444' }}>{shortage} Ltrs</div>
                    {t.driver_unloading_photo && (
                      <a href={t.driver_unloading_photo} target="_blank" rel="noreferrer" style={{ fontSize: '12px', color: '#10b981', textDecoration: 'none', marginTop: '5px', display: 'inline-block' }}>📎 View Receipt / Dip Photo</a>
                    )}
                  </div>

                  {parseFloat(shortage) > 0 && (
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px', background: 'rgba(245,158,11,0.08)', border: '1px dashed #f59e0b', borderRadius: '10px', padding: '10px' }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: '10px', color: '#f59e0b', fontWeight: 'bold', display: 'block' }}>PENALTY RATE ₹/Ltr</label>
                        <input type="number" value={cardPenaltyRates[t.id] || ''} onChange={e => setCardPenaltyRates({ ...cardPenaltyRates, [t.id]: e.target.value })} placeholder="e.g. 90"
                          style={{ width: '100%', padding: '8px', background: '#0f172a', border: '1px solid #f59e0b', color: '#fff', borderRadius: '6px', boxSizing: 'border-box' }} />
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '10px', color: '#ef4444', fontWeight: 'bold' }}>DRIVER DEBIT</div>
                        <div style={{ fontSize: '18px', fontWeight: 900, color: '#ef4444' }}>₹{((parseFloat(cardPenaltyRates[t.id]) || 0) * parseFloat(shortage) > 0 ? Math.round((parseFloat(cardPenaltyRates[t.id]) || 0) * parseFloat(shortage)) : 0).toLocaleString('en-IN')}</div>
                      </div>
                    </div>
                  )}

                  <button onClick={() => handleApproveDriverUnloading(t)} style={{ width: '100%', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>✅ Approve & Close Trip</button>
                </div>
              )
            })
          }
        </div>
      )}

      {/* 📋 TAB 3: REGISTER (COMPLETED TRIPS) */}
      {activeTab === 'REGISTER' && (
        <div style={{ background: '#1e293b', borderRadius: '15px', overflowX: 'auto', border: '1px solid #334155' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
            <thead style={{ background: '#0f172a', color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase' }}>
              <tr>
                <th style={{ padding: '15px' }}>Trip_ID</th>
                <th style={{ padding: '15px', color: '#38bdf8' }}>Vehical_No</th>
                <th style={{ padding: '15px' }}>Route (From ➔ To)</th>
                <th style={{ padding: '15px', color: '#38bdf8' }}>Loaded Qty</th>
                <th style={{ padding: '15px', color: '#10b981' }}>Unloaded Qty</th>
                <th style={{ padding: '15px', color: '#ef4444' }}>Shortage</th>
                <th style={{ padding: '15px', color: '#ef4444' }}>Penalty ₹ (Driver)</th>
                <th style={{ padding: '15px' }}>Driver_Name</th>
                <th style={{ padding: '15px', color: '#10b981' }}>Billing</th>
                <th style={{ padding: '15px', textAlign: 'center' }}>Notify Driver</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={10} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8' }}>Loading Data...</td></tr> : completedTrips.length === 0 ? <tr><td colSpan={10} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No Completed Trips Found.</td></tr> :
                completedTrips.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '12px' }}>
                  <td style={{ padding: '12px 15px' }}>{t.Trip_ID || t.trip_id}<br/><span className="pt-pill pt-pill--completed" style={{ marginTop: '4px' }}>Completed</span></td>
                  <td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: 'bold' }}>{t.Vehical_No || t.vehicle_no || t.vehical_no}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Loading_Point || t.loading_point} ➔ {t.Consignee_Name || t.consignee_name}</td>
                  <td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: 'bold' }}>{t.Loaded_Qty || t.loaded_qty || t.driver_loaded_qty}</td>
                  <td style={{ padding: '12px 15px', color: '#10b981', fontWeight: 'bold' }}>{t.Unloaded_Qty || t.unloaded_qty || t.driver_unloaded_qty}</td>
                  <td style={{ padding: '12px 15px', color: '#ef4444', fontWeight: '900' }}>{t.Shortage_Qty || t.shortage_qty || '0'}</td>
                  <td style={{ padding: '12px 15px', color: '#ef4444', fontWeight: '900' }}>{(parseFloat(t.shortage_penalty || t.shortage_amt || 0) || 0) > 0 ? `₹${(parseFloat(t.shortage_penalty || t.shortage_amt || 0)).toLocaleString('en-IN')} 💸` : '—'}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Driver_Name || t.driver_name}</td>
                  <td style={{ padding: '12px 15px' }}>
                    {t.billing_status === 'BILLED'
                      ? <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#10b981', border: '1px solid #10b981', borderRadius: '10px', padding: '2px 8px' }}>BILLED</span>
                      : t.draft_invoice
                        ? <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#38bdf8', border: '1px dashed #38bdf8', borderRadius: '10px', padding: '2px 8px' }}>DRAFT READY</span>
                        : <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#f59e0b', border: '1px solid #f59e0b', borderRadius: '10px', padding: '2px 8px' }}>PENDING</span>}
                  </td>
                  
                  {/* 💬 SMART WHATSAPP NOTIFICATION BUTTON */}
                  <td style={{ padding: '12px 15px', textAlign: 'center' }}>
                    <button 
                      onClick={() => sendUnloadingWhatsApp(t)} 
                      style={{ background: 'rgba(34, 197, 94, 0.2)', border: '1px solid #22c55e', color: '#22c55e', padding: '6px 12px', borderRadius: '20px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', transition: '0.3s' }}
                      onMouseOver={(e) => { e.currentTarget.style.background = '#22c55e'; e.currentTarget.style.color = 'white'; }}
                      onMouseOut={(e) => { e.currentTarget.style.background = 'rgba(34, 197, 94, 0.2)'; e.currentTarget.style.color = '#22c55e'; }}
                    >
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