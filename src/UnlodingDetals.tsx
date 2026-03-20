// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function UnloadingDetails() {
  const [activeTab, setActiveTab] = useState('MANUAL'); 
  const [trips, setTrips] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedTripId, setSelectedTripId] = useState('');

  const [unloadingData, setUnloadingData] = useState({
    Trip_ID: '', Vehical_No: '', Loading_Point: '', Consignee_Name: '', 
    Loaded_Qty: 0, Unloading_Date: new Date().toISOString().split('T')[0], 
    Unloaded_Qty: '', Shortage_Qty: 0, Remarks: ''
  });

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
        Remarks: ''
      });
    } else {
      setUnloadingData({ Trip_ID: '', Vehical_No: '', Loading_Point: '', Consignee_Name: '', Loaded_Qty: 0, Unloading_Date: new Date().toISOString().split('T')[0], Unloaded_Qty: '', Shortage_Qty: 0, Remarks: '' });
    }
  };

  // 🧮 Auto Calculate Shortage
  const handleUnloadedQtyChange = (e: any) => {
    const unloaded = parseFloat(e.target.value) || 0;
    const shortage = (unloadingData.Loaded_Qty - unloaded).toFixed(2);
    setUnloadingData({ ...unloadingData, Unloaded_Qty: e.target.value, Shortage_Qty: parseFloat(shortage) });
  };

  const handleManualSave = async () => {
    if (!unloadingData.Unloaded_Qty) return alert("⚠️ Please enter Unloaded Quantity!");
    
    try {
      // ✅ Safety Fix: Saving both formats for database safety
      await updateDoc(doc(db, "TRIPS", selectedTripId), {
        office_approved_unloading: true, 
        trip_status: 'COMPLETED', 
        Unloaded_Qty: unloadingData.Unloaded_Qty,
        unloaded_qty: unloadingData.Unloaded_Qty,
        Shortage_Qty: unloadingData.Shortage_Qty,
        shortage_qty: unloadingData.Shortage_Qty,
        Unloading_Date: unloadingData.Unloading_Date,
        unloading_date: unloadingData.Unloading_Date,
        unloading_remarks: unloadingData.Remarks,
        completed_at: Timestamp.now()
      });
      alert("✅ Unloading Saved! Trip is now COMPLETED.");
      setSelectedTripId('');
      fetchTrips();
    } catch (e) { alert("❌ Error saving unloading entry."); }
  };

  const handleApproveDriverUnloading = async (trip: any) => {
    try {
      const loaded = parseFloat(trip.loaded_qty || trip.Loaded_Qty || trip.driver_loaded_qty || 0);
      const unloaded = parseFloat(trip.driver_unloaded_qty || 0);
      const shortage = (loaded - unloaded).toFixed(2);

      await updateDoc(doc(db, "TRIPS", trip.id), {
        office_approved_unloading: true, 
        trip_status: 'COMPLETED', 
        Unloaded_Qty: unloaded,
        unloaded_qty: unloaded,
        Shortage_Qty: parseFloat(shortage),
        shortage_qty: parseFloat(shortage),
        Unloading_Date: new Date().toISOString().split('T')[0],
        unloading_date: new Date().toISOString().split('T')[0],
        completed_at: Timestamp.now()
      });
      alert("✅ Driver Unloading Data Approved! Trip COMPLETED.");
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

    const message = `🏁 *UNLOADING CONFIRMATION*\n\nTrip Completed Successfully.\n\n*Trip ID:* ${tripId}\n*Vehicle:* ${vehicle}\n\n*Loaded Qty:* ${loaded} Ltrs\n*Unloaded Qty:* ${unloaded} Ltrs\n*Shortage:* ${shortage} Ltrs\n\nThank you for your service.\n\nRegards,\nPrasad Transport ERP`;
    
    let phone = mobile.replace(/\s+/g, ''); 
    if (phone.length === 10) phone = '91' + phone;

    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
  };

  // 🔍 Filters
  const inTransitTrips = trips.filter(t => t.trip_status === 'IN_TRANSIT' && !t.office_approved_unloading);
  const pendingDriverApprovals = trips.filter(t => t.driver_unloaded_qty && !t.office_approved_unloading && t.office_approved_loading);
  const completedTrips = trips.filter(t => t.office_approved_unloading || t.trip_status === 'COMPLETED').sort((a:any, b:any) => new Date(b.completed_at?.toDate() || 0).getTime() - new Date(a.completed_at?.toDate() || 0).getTime());

  const inputStyle = { width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' as 'border-box', outline: 'none' };
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                    <span style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '18px' }}>{t.Vehical_No || t.vehicle_no || t.vehical_no}</span>
                    <span style={{ background: '#334155', padding: '2px 8px', borderRadius: '5px', fontSize: '11px' }}>{t.Trip_ID || t.trip_id}</span>
                  </div>
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
                <th style={{ padding: '15px' }}>Driver_Name</th>
                <th style={{ padding: '15px', textAlign: 'center' }}>Notify Driver</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={8} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8' }}>Loading Data...</td></tr> : completedTrips.length === 0 ? <tr><td colSpan={8} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No Completed Trips Found.</td></tr> : 
                completedTrips.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '12px' }}>
                  <td style={{ padding: '12px 15px' }}>{t.Trip_ID || t.trip_id}</td>
                  <td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: 'bold' }}>{t.Vehical_No || t.vehicle_no || t.vehical_no}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Loading_Point || t.loading_point} ➔ {t.Consignee_Name || t.consignee_name}</td>
                  <td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: 'bold' }}>{t.Loaded_Qty || t.loaded_qty || t.driver_loaded_qty}</td>
                  <td style={{ padding: '12px 15px', color: '#10b981', fontWeight: 'bold' }}>{t.Unloaded_Qty || t.unloaded_qty || t.driver_unloaded_qty}</td>
                  <td style={{ padding: '12px 15px', color: '#ef4444', fontWeight: '900' }}>{t.Shortage_Qty || t.shortage_qty || '0'}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Driver_Name || t.driver_name}</td>
                  
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