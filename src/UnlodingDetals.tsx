// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc, addDoc, query, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function UnlodingDetals() {
  const [activeTab, setActiveTab] = useState('MANUAL'); 
  const [trips, setTrips] = useState<any[]>([]);
  const [rtkmMaster, setRtkmMaster] = useState<any[]>([]); 
  const [vehicles, setVehicles] = useState<any[]>([]); 
  const [drivers, setDrivers] = useState<any[]>([]); 
  const [loading, setLoading] = useState(false);

  const [selectedTripId, setSelectedTripId] = useState('');
  const [isNewEntry, setIsNewEntry] = useState(false);

  const [manualData, setManualData] = useState({
    Trip_ID: '', Customer: '', Loading_Date: new Date().toISOString().split('T')[0], Challan_No: '', 
    Loading_Point: '', Vehical_No: '', Registered_Assessee: '', Consignee_Name: '', 
    Product_Type: 'HSD', Loaded_Qty: '', RTKM: '', Rate: '', Driver_Name: '', Driver_Mobil_No: '', 
    Unloading_Date: new Date().toISOString().split('T')[0], Unloaded_Qty: '', Shortage: '0', Trip_Status: 'COMPLETED'
  });

  useEffect(() => {
    fetchAllData();
  }, []);

  const fetchAllData = async () => {
    setLoading(true);
    try {
      const tripSnap = await getDocs(collection(db, "TRIPS"));
      setTrips(tripSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      
      const rtkmSnap = await getDocs(collection(db, "RTKM_MASTER"));
      setRtkmMaster(rtkmSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      const vehSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vehSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      const drvSnap = await getDocs(collection(db, "DRIVERS"));
      setDrivers(drvSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) {
      console.error("Error fetching data:", error);
    }
    setLoading(false);
  };

  const handleManualTripSelect = (e: any) => {
    const tId = e.target.value;
    setSelectedTripId(tId);
    
    if (tId === 'NEW') {
      setIsNewEntry(true);
      setManualData({
        Trip_ID: 'TRP-' + Math.floor(Math.random() * 90000 + 10000),
        Customer: '', Loading_Date: new Date().toISOString().split('T')[0], Challan_No: '', 
        Loading_Point: '', Vehical_No: '', Registered_Assessee: '', Consignee_Name: '', 
        Product_Type: 'HSD', Loaded_Qty: '', RTKM: '', Rate: '', Driver_Name: '', Driver_Mobil_No: '', 
        Unloading_Date: new Date().toISOString().split('T')[0], Unloaded_Qty: '', Shortage: '0', Trip_Status: 'COMPLETED'
      });
    } else if (tId) {
      setIsNewEntry(false);
      const t = trips.find(trip => trip.id === tId);
      setManualData({
        Trip_ID: t.Trip_ID || t.trip_id || t.id, Customer: t.Customer || t.customer_name || '',
        Loading_Date: t.Loading_Date || t.loading_date || '', Challan_No: t.Challan_No || '',
        Loading_Point: t.Loading_Point || t.loading_point || '', Vehical_No: t.Vehical_No || t.vehicle_no || t.vehical_no || '',
        Registered_Assessee: t.Registered_Assessee || '', Consignee_Name: t.Consignee_Name || t.consignee_name || '',
        Product_Type: t.Product_Type || t.product_type || 'HSD', Loaded_Qty: t.Loaded_Qty || t.loaded_qty || '0',
        RTKM: t.RTKM || t.rtkm || '', Rate: t.Rate || t.rate || '', Driver_Name: t.Driver_Name || t.driver_name || '',
        Driver_Mobil_No: t.Driver_Mobil_No || t.driver_mobil_no || '',
        Unloading_Date: new Date().toISOString().split('T')[0], Unloaded_Qty: '', Shortage: '0', Trip_Status: 'COMPLETED'
      });
    }
  };

  // 🔗 AUTO-FILL ROUTE DATA
  const handleRouteSelect = (e: any) => {
    const routeId = e.target.value;
    const r = rtkmMaster.find(x => x.id === routeId);
    if (r) {
      setManualData(prev => ({
        ...prev, Loading_Point: r.Depot_Link || '', Consignee_Name: r.Consignee_Name || '',
        Customer: r.Registered_Assessee || '', Registered_Assessee: r.Registered_Assessee || '',
        RTKM: r.RTKM_Distance || '', Rate: r.Rate_Per_Unit || '', Product_Type: r.Item_Type || 'HSD'
      }));
    }
  };

  // 🧑‍✈️ AUTO-FILL DRIVER DATA
  const handleDriverSelect = (e: any) => {
    const dName = e.target.value;
    const d = drivers.find(x => x.name === dName);
    setManualData(prev => ({
      ...prev, Driver_Name: dName, Driver_Mobil_No: d ? (d.mobile_no || d.phone || d.contact || '') : ''
    }));
  };

  // 🧮 CALCULATE SHORTAGE DYNAMICALLY
  const handleLoadQtyChange = (val: string) => {
    const lQty = parseFloat(val) || 0;
    const uQty = parseFloat(manualData.Unloaded_Qty) || 0;
    setManualData({ ...manualData, Loaded_Qty: val, Shortage: (lQty - uQty).toString() });
  };

  const handleUnloadQtyChange = (val: string) => {
    const lQty = parseFloat(manualData.Loaded_Qty) || 0;
    const uQty = parseFloat(val) || 0;
    setManualData({ ...manualData, Unloaded_Qty: val, Shortage: (lQty - uQty).toString() });
  };

  const handleApproveDriverUnloading = async (tripId: string, loadedQty: any, driverUnloadedQty: string) => {
    try {
      const lQty = parseFloat(loadedQty) || 0;
      const uQty = parseFloat(driverUnloadedQty) || 0;
      await updateDoc(doc(db, "TRIPS", tripId), {
        office_approved_unloading: true, Unloaded_Qty: driverUnloadedQty, Shortage: (lQty - uQty).toString(),
        Trip_Status: 'COMPLETED', trip_status: 'COMPLETED', Unloading_Date: new Date().toISOString().split('T')[0]
      });
      alert("✅ Unloading Approved! Trip Completed.");
      fetchAllData();
    } catch (e) { alert("❌ Error approving data."); }
  };

  const handleManualSave = async () => {
    if (!manualData.Vehical_No || !manualData.Unloaded_Qty || !manualData.Loaded_Qty) return alert("⚠️ Please enter Vehicle No, Loaded Qty and Unloaded Qty!");
    try {
      if (isNewEntry) {
         await addDoc(collection(db, "TRIPS"), {
          ...manualData, trip_id: manualData.Trip_ID, vehicle_no: manualData.Vehical_No, customer_name: manualData.Customer,
          office_approved_loading: true, office_approved_unloading: true, trip_status: 'COMPLETED', created_at: Timestamp.now()
        });
        alert("✅ Direct Entry Created & Unloaded! Trip Saved as Completed.");
      } else {
        await updateDoc(doc(db, "TRIPS", selectedTripId), {
          ...manualData, office_approved_unloading: true, trip_status: 'COMPLETED'
        });
        alert("✅ Manual Unloading Entry Saved! Trip Completed.");
      }
      setSelectedTripId('');
      setIsNewEntry(false);
      fetchAllData();
    } catch (e) { alert("❌ Error saving manual entry."); }
  };

  const pendingDriverApprovals = trips.filter(t => t.office_approved_loading && t.driver_unloaded_qty && !t.office_approved_unloading);
  const pendingManualTrips = trips.filter(t => t.office_approved_loading && !t.office_approved_unloading);
  const unloadingRegister = trips.filter(t => t.office_approved_unloading || t.Trip_Status === 'COMPLETED');

  const inputStyle = { width: '100%', padding: '10px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', fontSize: '13px', boxSizing: 'border-box' as 'border-box', outline: 'none' };
  const autoFillStyle = { ...inputStyle, background: 'rgba(56, 189, 248, 0.05)', border: '1px dashed #38bdf8', color: '#94a3b8' };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '28px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>🛢️ Unloading Register</h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Direct Entry & Master Linked Shortage Calculation</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '25px', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>
        <button onClick={() => setActiveTab('MANUAL')} style={{ padding: '10px 20px', background: activeTab === 'MANUAL' ? 'rgba(16, 185, 129, 0.1)' : 'transparent', color: activeTab === 'MANUAL' ? '#10b981' : '#94a3b8', border: 'none', borderBottom: activeTab === 'MANUAL' ? '3px solid #10b981' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>✍️ MANUAL ENTRY (Direct/Auto)</button>
        <button onClick={() => setActiveTab('AUTO')} style={{ padding: '10px 20px', background: activeTab === 'AUTO' ? 'rgba(56, 189, 248, 0.1)' : 'transparent', color: activeTab === 'AUTO' ? '#38bdf8' : '#94a3b8', border: 'none', borderBottom: activeTab === 'AUTO' ? '3px solid #38bdf8' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>📱 APP SYNC (Driver) {pendingDriverApprovals.length > 0 && <span style={{background:'#ef4444', color:'white', padding:'2px 8px', borderRadius:'10px', marginLeft:'5px', fontSize:'11px'}}>{pendingDriverApprovals.length} Pending</span>}</button>
        <button onClick={() => setActiveTab('REGISTER')} style={{ padding: '10px 20px', background: activeTab === 'REGISTER' ? 'rgba(245, 158, 11, 0.1)' : 'transparent', color: activeTab === 'REGISTER' ? '#f59e0b' : '#94a3b8', border: 'none', borderBottom: activeTab === 'REGISTER' ? '3px solid #f59e0b' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>📋 SHEET VIEW (Register)</button>
      </div>

      {activeTab === 'MANUAL' && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '15px', padding: '30px' }}>
          <div style={{ marginBottom: '20px', background: 'rgba(245, 158, 11, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
            <label style={{ color: '#f59e0b', fontSize: '13px', fontWeight: 'bold', marginBottom: '8px', display: 'block' }}>🔍 Start Unloading Entry *</label>
            <select value={selectedTripId} onChange={handleManualTripSelect} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #f59e0b', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '15px' }}>
              <option value="">-- Choose Option --</option>
              <option value="NEW" style={{ background: '#f59e0b', color: '#0f172a', fontWeight: 'bold' }}>➕ DIRECT UNLOADING ENTRY (Bypass Loading & Close Trip)</option>
              <optgroup label="Or Select from In-Transit Trips:">
                {pendingManualTrips.map(t => <option key={t.id} value={t.id}>{t.Vehical_No || t.vehicle_no || t.vehical_no} | Loaded: {t.Loaded_Qty || t.loaded_qty}L | ➔ {t.Consignee_Name || t.consignee_name}</option>)}
              </optgroup>
            </select>
          </div>

          {selectedTripId && (
            <>
              {isNewEntry && (
                <div style={{ background: 'rgba(245, 158, 11, 0.1)', padding: '15px', borderRadius: '8px', marginBottom: '20px', border: '1px dashed #f59e0b' }}>
                  <label style={{ color: '#f59e0b', fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>🔗 1. Select Route from RTKM Master (Auto-Fills Details)</label>
                  <select onChange={handleRouteSelect} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #f59e0b', color: '#fff', borderRadius: '8px', outline: 'none' }}>
                    <option value="">-- Choose Route / Consignee --</option>
                    {rtkmMaster.map(r => (
                      <option key={r.id} value={r.id}>{r.Depot_Link} ➔ {r.Consignee_Name} ({r.Registered_Assessee}) | Rate: ₹{r.Rate_Per_Unit}</option>
                    ))}
                  </select>
                </div>
              )}

              <h4 style={{ color: '#38bdf8', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '15px' }}>2. Verify / Edit Trip Details</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '20px' }}>
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Trip ID</label><input type="text" value={manualData.Trip_ID} readOnly style={autoFillStyle} /></div>
                
                {/* 🚛 VEHICLE DROPDOWN */}
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Vehicle No *</label>
                  {isNewEntry ? (
                    <select value={manualData.Vehical_No} onChange={e=>setManualData({...manualData, Vehical_No: e.target.value})} style={inputStyle}>
                      <option value="">-- Select Vehicle --</option>
                      {vehicles.map(v => <option key={v.id} value={v.vehical_no || v.vehicle_no}>{v.vehical_no || v.vehicle_no}</option>)}
                    </select>
                  ) : <input type="text" value={manualData.Vehical_No} readOnly style={autoFillStyle} />}
                </div>

                {/* 🧑‍✈️ DRIVER DROPDOWN */}
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Driver Name</label>
                  {isNewEntry ? (
                    <select value={manualData.Driver_Name} onChange={handleDriverSelect} style={inputStyle}>
                      <option value="">-- Select Driver --</option>
                      {drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                    </select>
                  ) : <input type="text" value={manualData.Driver_Name} readOnly style={autoFillStyle} />}
                </div>

                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Driver Mobile</label><input type="text" value={manualData.Driver_Mobil_No} onChange={e=>setManualData({...manualData, Driver_Mobil_No: e.target.value})} readOnly={!isNewEntry} style={isNewEntry ? inputStyle : autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Customer Name</label><input type="text" value={manualData.Customer} onChange={e=>setManualData({...manualData, Customer: e.target.value})} readOnly={!isNewEntry} style={isNewEntry ? inputStyle : autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Consignee Name</label><input type="text" value={manualData.Consignee_Name} onChange={e=>setManualData({...manualData, Consignee_Name: e.target.value})} readOnly={!isNewEntry} style={isNewEntry ? inputStyle : autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Challan No</label><input type="text" value={manualData.Challan_No} onChange={e=>setManualData({...manualData, Challan_No: e.target.value})} readOnly={!isNewEntry} style={isNewEntry ? inputStyle : autoFillStyle} /></div>
              </div>

              <h4 style={{ color: '#10b981', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '15px' }}>3. Enter Loading & Unloading Quantities</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '25px' }}>
                
                <div>
                  <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Loaded Qty *</label>
                  <input type="number" value={manualData.Loaded_Qty} onChange={e => handleLoadQtyChange(e.target.value)} readOnly={!isNewEntry} style={{ ... (isNewEntry ? inputStyle : autoFillStyle), borderColor: '#10b981', color: '#10b981', fontWeight: 'bold', fontSize: '16px' }} placeholder="e.g. 12000" />
                </div>
                
                <div>
                  <label style={{ color: '#f59e0b', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Unloaded Qty *</label>
                  <input type="number" value={manualData.Unloaded_Qty} onChange={e => handleUnloadQtyChange(e.target.value)} style={{ ...inputStyle, borderColor: '#f59e0b', fontSize: '16px', fontWeight: 'bold', color: '#f59e0b' }} placeholder="e.g. 11980" />
                </div>

                <div>
                  <label style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Shortage (Auto-Calc)</label>
                  <input type="text" value={manualData.Shortage} readOnly style={{ ...inputStyle, background: 'rgba(239,68,68,0.1)', borderColor: '#ef4444', color: '#ef4444', fontWeight: 'bold', fontSize: '16px' }} />
                </div>
                
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Unloading Date *</label>
                  <input type="date" value={manualData.Unloading_Date} onChange={e => setManualData({...manualData, Unloading_Date: e.target.value})} style={{ ...inputStyle, colorScheme: 'dark' }} />
                </div>
              </div>

              <button onClick={handleManualSave} style={{ width: '100%', background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#0f172a', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', fontSize: '16px', boxShadow: '0 5px 15px rgba(245,158,11,0.4)' }}>
                {isNewEntry ? '💾 Save Direct Unloading & Complete Trip' : '💾 Save Unloading & Close Trip'}
              </button>
            </>
          )}
        </div>
      )}

      {/* 📱 TAB 2: AUTO SYNC */}
      {activeTab === 'AUTO' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px' }}>
          {pendingDriverApprovals.length === 0 ? <div style={{ color: '#64748b' }}>No pending unloading approvals from drivers.</div> : 
            pendingDriverApprovals.map(t => {
              const lQty = parseFloat(t.Loaded_Qty || t.loaded_qty) || 0;
              const uQty = parseFloat(t.driver_unloaded_qty) || 0;
              const shortage = lQty - uQty;

              return (
              <div key={t.id} style={{ background: '#1e293b', border: '1px solid #38bdf8', borderRadius: '15px', padding: '20px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <span style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '18px' }}>{t.Vehical_No || t.vehicle_no || t.vehical_no}</span>
                  <span style={{ background: '#334155', padding: '2px 8px', borderRadius: '5px', fontSize: '11px' }}>{t.Trip_ID || t.trip_id}</span>
                </div>
                <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '15px' }}>📍 Unloaded at: {t.Consignee_Name || t.consignee_name}</div>
                
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '15px' }}>
                  <div style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '10px', borderRadius: '8px' }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>Loaded Qty:</div>
                    <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#fff' }}>{lQty} L</div>
                  </div>
                  <div style={{ background: 'rgba(56, 189, 248, 0.1)', padding: '10px', borderRadius: '8px' }}>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>Driver Unloaded Qty:</div>
                    <div style={{ fontSize: '18px', fontWeight: '900', color: '#38bdf8' }}>{t.driver_unloaded_qty} L</div>
                  </div>
                </div>

                <div style={{ background: shortage > 0 ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)', border: `1px solid ${shortage > 0 ? '#ef4444' : '#10b981'}`, padding: '10px', borderRadius: '8px', marginBottom: '15px', textAlign: 'center' }}>
                  <span style={{ color: shortage > 0 ? '#ef4444' : '#10b981', fontWeight: 'bold', fontSize: '14px' }}>
                    {shortage > 0 ? `⚠️ Shortage: ${shortage} Ltrs` : '✅ No Shortage'}
                  </span>
                </div>
                <button onClick={() => handleApproveDriverUnloading(t.id, lQty, t.driver_unloaded_qty)} style={{ width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>✅ Verify & Complete Trip</button>
              </div>
            )})}
        </div>
      )}

      {/* 📋 TAB 3: REGISTER */}
      {activeTab === 'REGISTER' && (
        <div style={{ background: '#1e293b', borderRadius: '15px', overflowX: 'auto', border: '1px solid #334155' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
            <thead style={{ background: '#0f172a', color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase' }}>
              <tr>
                <th style={{ padding: '15px' }}>Trip_ID</th><th style={{ padding: '15px' }}>Customer</th><th style={{ padding: '15px' }}>Loading_Date</th><th style={{ padding: '15px' }}>Challan_No</th>
                <th style={{ padding: '15px' }}>Loading_Point</th><th style={{ padding: '15px', color: '#38bdf8' }}>Vehical_No</th><th style={{ padding: '15px' }}>Registered_Assessee</th>
                <th style={{ padding: '15px' }}>Consignee_Name</th><th style={{ padding: '15px' }}>Product_Type</th><th style={{ padding: '15px', color: '#10b981' }}>Loaded_Qty</th>
                <th style={{ padding: '15px' }}>RTKM</th><th style={{ padding: '15px' }}>Rate</th><th style={{ padding: '15px' }}>Driver_Name</th><th style={{ padding: '15px' }}>Driver_Mobil_No</th>
                <th style={{ padding: '15px', borderLeft: '2px solid #334155' }}>Unloading_Date</th><th style={{ padding: '15px', color: '#f59e0b' }}>Unloaded_Qty</th><th style={{ padding: '15px', color: '#ef4444' }}>Shortage</th><th style={{ padding: '15px' }}>Trip_Status</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={18} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8' }}>Loading Data...</td></tr> : unloadingRegister.length === 0 ? <tr><td colSpan={18} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No Data Found.</td></tr> : 
                unloadingRegister.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '12px' }}>
                  <td style={{ padding: '12px 15px' }}>{t.Trip_ID || t.trip_id}</td><td style={{ padding: '12px 15px' }}>{t.Customer || t.customer_name}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Loading_Date || t.loading_date}</td><td style={{ padding: '12px 15px', fontWeight: 'bold', color: '#fff' }}>{t.Challan_No || '-'}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Loading_Point || t.loading_point}</td><td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: 'bold' }}>{t.Vehical_No || t.vehicle_no || t.vehical_no}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Registered_Assessee || '-'}</td><td style={{ padding: '12px 15px' }}>{t.Consignee_Name || t.consignee_name}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Product_Type || t.product_type}</td><td style={{ padding: '12px 15px', color: '#10b981', fontWeight: '900' }}>{t.Loaded_Qty || t.loaded_qty}</td>
                  <td style={{ padding: '12px 15px' }}>{t.RTKM || t.rtkm || '-'}</td><td style={{ padding: '12px 15px' }}>{t.Rate || t.rate || '-'}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Driver_Name || t.driver_name}</td><td style={{ padding: '12px 15px' }}>{t.Driver_Mobil_No || t.driver_mobil_no}</td>
                  <td style={{ padding: '12px 15px', borderLeft: '2px solid #334155' }}>{t.Unloading_Date || t.unloading_date}</td>
                  <td style={{ padding: '12px 15px', color: '#f59e0b', fontWeight: 'bold' }}>{t.Unloaded_Qty || t.unloaded_qty}</td>
                  <td style={{ padding: '12px 15px', color: parseFloat(t.Shortage || t.shortage) > 0 ? '#ef4444' : '#64748b', fontWeight: 'bold' }}>{t.Shortage || t.shortage || '0'}</td>
                  <td style={{ padding: '12px 15px' }}><span style={{background:'rgba(16,185,129,0.1)', color:'#10b981', padding:'3px 8px', borderRadius:'10px', fontSize:'10px'}}>{t.Trip_Status || t.trip_status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}