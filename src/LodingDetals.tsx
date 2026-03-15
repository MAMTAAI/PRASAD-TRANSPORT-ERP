// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc, addDoc, query, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function LodingDetals() {
  const [activeTab, setActiveTab] = useState('MANUAL'); 
  const [trips, setTrips] = useState<any[]>([]);
  const [rtkmMaster, setRtkmMaster] = useState<any[]>([]); 
  const [vehicles, setVehicles] = useState<any[]>([]); // 🚛 VEHICLES DATA
  const [drivers, setDrivers] = useState<any[]>([]); // 🧑‍✈️ DRIVERS DATA
  const [loading, setLoading] = useState(false);

  const [selectedTripId, setSelectedTripId] = useState('');
  const [isNewEntry, setIsNewEntry] = useState(false); 

  const [manualData, setManualData] = useState({
    Trip_ID: '', Customer: '', Loading_Date: new Date().toISOString().split('T')[0], Challan_No: '', 
    Loading_Point: '', Vehical_No: '', Registered_Assessee: '', Consignee_Name: '', 
    Product_Type: 'HSD', Loaded_Qty: '', RTKM: '', Rate: '', Driver_Name: '', Driver_Mobil_No: ''
  });

  useEffect(() => {
    fetchTripsAndMaster();
  }, []);

  const fetchTripsAndMaster = async () => {
    setLoading(true);
    try {
      // Fetch Trips
      const tripSnap = await getDocs(collection(db, "TRIPS"));
      setTrips(tripSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      
      // Fetch RTKM Master Data
      const rtkmSnap = await getDocs(collection(db, "RTKM_MASTER"));
      setRtkmMaster(rtkmSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      // Fetch Vehicles 🚛
      const vehSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vehSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      // Fetch Drivers 🧑‍✈️
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
        Product_Type: 'HSD', Loaded_Qty: '', RTKM: '', Rate: '', Driver_Name: '', Driver_Mobil_No: ''
      });
    } else if (tId) {
      setIsNewEntry(false);
      const t = trips.find(trip => trip.id === tId);
      setManualData({
        Trip_ID: t.trip_id || t.id, Customer: t.customer_name || t.Customer || '',
        Loading_Date: new Date().toISOString().split('T')[0], Challan_No: '', 
        Loading_Point: t.loading_point || t.Loading_Point || '', Vehical_No: t.vehicle_no || t.vehical_no || t.Vehical_No || '',
        Registered_Assessee: t.registered_assessee || t.customer_name || '', Consignee_Name: t.consignee_name || t.Consignee_Name || '',
        Product_Type: t.product_type || 'HSD', Loaded_Qty: '', RTKM: t.rtkm || t.RTKM || '', Rate: t.rate || t.Rate || '',
        Driver_Name: t.driver_name || t.Driver_Name || '', Driver_Mobil_No: t.driver_mobil_no || t.driver_mobile || t.Driver_Mobil_No || ''
      });
    }
  };

  const handleRouteSelect = (e: any) => {
    const routeId = e.target.value;
    const selectedRoute = rtkmMaster.find(r => r.id === routeId);
    
    if (selectedRoute) {
      setManualData(prev => ({
        ...prev,
        Loading_Point: selectedRoute.Depot_Link || '',
        Consignee_Name: selectedRoute.Consignee_Name || '',
        Customer: selectedRoute.Registered_Assessee || '',
        Registered_Assessee: selectedRoute.Registered_Assessee || '',
        RTKM: selectedRoute.RTKM_Distance || '',
        Rate: selectedRoute.Rate_Per_Unit || '',
        Product_Type: selectedRoute.Item_Type || 'HSD'
      }));
    }
  };

  // 🧑‍✈️ HANDLE DRIVER SELECTION TO AUTO-FILL MOBILE NUMBER
  const handleDriverSelect = (e: any) => {
    const dName = e.target.value;
    const selectedDriver = drivers.find(d => d.name === dName);
    setManualData(prev => ({
      ...prev,
      Driver_Name: dName,
      Driver_Mobil_No: selectedDriver ? (selectedDriver.mobile_no || selectedDriver.phone || selectedDriver.contact || '') : ''
    }));
  };

  const handleApproveDriverLoading = async (tripId: string, driverQty: string) => {
    try {
      await updateDoc(doc(db, "TRIPS", tripId), {
        office_approved_loading: true, Loaded_Qty: driverQty, trip_status: 'IN_TRANSIT', Loading_Date: new Date().toISOString().split('T')[0]
      });
      alert("✅ Driver Loading Data Approved! Vehicle is now IN TRANSIT.");
      fetchTripsAndMaster();
    } catch (e) { alert("❌ Error approving data."); }
  };

  const handleManualSave = async () => {
    if (!manualData.Loaded_Qty || !manualData.Challan_No || !manualData.Vehical_No) return alert("⚠️ Please enter Vehicle No, Loaded Qty and Challan No!");
    
    try {
      if (isNewEntry) {
        await addDoc(collection(db, "TRIPS"), {
          ...manualData, trip_id: manualData.Trip_ID, vehicle_no: manualData.Vehical_No, customer_name: manualData.Customer,
          office_approved_loading: true, trip_status: 'IN_TRANSIT', created_at: Timestamp.now()
        });
        alert("✅ New Direct Loading Entry Created! Trip Started.");
      } else {
        await updateDoc(doc(db, "TRIPS", selectedTripId), {
          ...manualData, office_approved_loading: true, trip_status: 'IN_TRANSIT', loaded_qty: manualData.Loaded_Qty 
        });
        alert("✅ Loading Entry Updated Successfully!");
      }
      setSelectedTripId('');
      setIsNewEntry(false);
      fetchTripsAndMaster();
    } catch (e) { alert("❌ Error saving manual entry."); }
  };

  const pendingDriverApprovals = trips.filter(t => t.driver_loaded_qty && !t.office_approved_loading);
  const pendingManualTrips = trips.filter(t => !t.office_approved_loading && t.trip_status !== 'COMPLETED');
  const loadingRegister = trips.filter(t => t.office_approved_loading);

  const inputStyle = { width: '100%', padding: '10px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', fontSize: '13px', boxSizing: 'border-box' as 'border-box', outline: 'none' };
  const autoFillStyle = { ...inputStyle, background: 'rgba(56, 189, 248, 0.05)', border: '1px dashed #38bdf8', color: '#94a3b8' };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '28px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>📦 Loading Register</h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Smart Linked with Master Data (Vehicles, Drivers & Routes)</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '25px', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>
        <button onClick={() => setActiveTab('MANUAL')} style={{ padding: '10px 20px', background: activeTab === 'MANUAL' ? 'rgba(16, 185, 129, 0.1)' : 'transparent', color: activeTab === 'MANUAL' ? '#10b981' : '#94a3b8', border: 'none', borderBottom: activeTab === 'MANUAL' ? '3px solid #10b981' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>✍️ MANUAL ENTRY (Auto-Fill)</button>
        <button onClick={() => setActiveTab('AUTO')} style={{ padding: '10px 20px', background: activeTab === 'AUTO' ? 'rgba(56, 189, 248, 0.1)' : 'transparent', color: activeTab === 'AUTO' ? '#38bdf8' : '#94a3b8', border: 'none', borderBottom: activeTab === 'AUTO' ? '3px solid #38bdf8' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>📱 APP SYNC (Driver) {pendingDriverApprovals.length > 0 && <span style={{background:'#ef4444', color:'white', padding:'2px 8px', borderRadius:'10px', marginLeft:'5px', fontSize:'11px'}}>{pendingDriverApprovals.length} Pending</span>}</button>
        <button onClick={() => setActiveTab('REGISTER')} style={{ padding: '10px 20px', background: activeTab === 'REGISTER' ? 'rgba(245, 158, 11, 0.1)' : 'transparent', color: activeTab === 'REGISTER' ? '#f59e0b' : '#94a3b8', border: 'none', borderBottom: activeTab === 'REGISTER' ? '3px solid #f59e0b' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>📋 SHEET VIEW (Register)</button>
      </div>

      {activeTab === 'MANUAL' && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '15px', padding: '30px' }}>
          
          <div style={{ marginBottom: '20px', background: 'rgba(16, 185, 129, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
            <label style={{ color: '#10b981', fontSize: '13px', fontWeight: 'bold', marginBottom: '8px', display: 'block' }}>🔍 Start Loading Entry *</label>
            <select value={selectedTripId} onChange={handleManualTripSelect} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #10b981', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '15px' }}>
              <option value="">-- Choose Option --</option>
              <option value="NEW" style={{ background: '#10b981', color: '#0f172a', fontWeight: 'bold' }}>➕ CREATE FRESH DIRECT ENTRY (New Invoice)</option>
              <optgroup label="Or Auto-Fill from Pending Trips:">
                {pendingManualTrips.map(t => <option key={t.id} value={t.id}>{t.vehicle_no || t.vehical_no} | {t.loading_point} ➔ {t.consignee_name}</option>)}
              </optgroup>
            </select>
          </div>

          {selectedTripId && (
            <>
              {isNewEntry && (
                <div style={{ background: 'rgba(245,158,11,0.1)', padding: '15px', borderRadius: '8px', marginBottom: '20px', border: '1px dashed #f59e0b' }}>
                  <label style={{ color: '#f59e0b', fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>🔗 1. Select Route from RTKM Master (Auto-Fills Destination & Rate)</label>
                  <select onChange={handleRouteSelect} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #f59e0b', color: '#fff', borderRadius: '8px', outline: 'none' }}>
                    <option value="">-- Choose Route / Consignee --</option>
                    {rtkmMaster.map(r => (
                      <option key={r.id} value={r.id}>{r.Depot_Link} ➔ {r.Consignee_Name} ({r.Registered_Assessee}) | Rate: ₹{r.Rate_Per_Unit}</option>
                    ))}
                  </select>
                </div>
              )}

              <h4 style={{ color: '#38bdf8', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '15px' }}>2. Verify / Edit Details</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '20px' }}>
                
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Trip ID</label><input type="text" value={manualData.Trip_ID} readOnly style={autoFillStyle} /></div>
                
                {/* 🚛 VEHICLE DROPDOWN MAGIC */}
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Vehicle No *</label>
                  {isNewEntry ? (
                    <select value={manualData.Vehical_No} onChange={e=>setManualData({...manualData, Vehical_No: e.target.value})} style={inputStyle}>
                      <option value="">-- Select Vehicle --</option>
                      {vehicles.map(v => <option key={v.id} value={v.vehical_no || v.vehicle_no}>{v.vehical_no || v.vehicle_no}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={manualData.Vehical_No} readOnly style={autoFillStyle} />
                  )}
                </div>

                {/* 🧑‍✈️ DRIVER DROPDOWN MAGIC */}
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Driver Name</label>
                  {isNewEntry ? (
                    <select value={manualData.Driver_Name} onChange={handleDriverSelect} style={inputStyle}>
                      <option value="">-- Select Driver --</option>
                      {drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
                    </select>
                  ) : (
                    <input type="text" value={manualData.Driver_Name} readOnly style={autoFillStyle} />
                  )}
                </div>

                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Driver Mobile</label><input type="text" value={manualData.Driver_Mobil_No} onChange={e=>setManualData({...manualData, Driver_Mobil_No: e.target.value})} readOnly={!isNewEntry} style={isNewEntry ? inputStyle : autoFillStyle} /></div>
                
                {/* AUTO FILLED FROM MASTER */}
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Customer Name (Auto)</label><input type="text" value={manualData.Customer} onChange={e=>setManualData({...manualData, Customer: e.target.value})} style={autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Loading Point (Auto)</label><input type="text" value={manualData.Loading_Point} onChange={e=>setManualData({...manualData, Loading_Point: e.target.value})} style={autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Consignee Name (Auto)</label><input type="text" value={manualData.Consignee_Name} onChange={e=>setManualData({...manualData, Consignee_Name: e.target.value})} style={autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>RTKM (Auto)</label><input type="text" value={manualData.RTKM} onChange={e=>setManualData({...manualData, RTKM: e.target.value})} style={autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Rate (Auto)</label><input type="text" value={manualData.Rate} onChange={e=>setManualData({...manualData, Rate: e.target.value})} style={autoFillStyle} /></div>
              </div>

              <h4 style={{ color: '#10b981', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '15px' }}>3. Enter Loading Quantity</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '25px' }}>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Loading Date *</label>
                  <input type="date" value={manualData.Loading_Date} onChange={e => setManualData({...manualData, Loading_Date: e.target.value})} style={{ ...inputStyle, colorScheme: 'dark' }} />
                </div>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Challan / Invoice No *</label>
                  <input type="text" value={manualData.Challan_No} onChange={e => setManualData({...manualData, Challan_No: e.target.value})} style={{ ...inputStyle, borderColor: '#f59e0b' }} placeholder="Enter Challan" />
                </div>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Product Type *</label>
                  <select value={manualData.Product_Type} onChange={e => setManualData({...manualData, Product_Type: e.target.value})} style={inputStyle}>
                    <option value="HSD">HSD (Diesel)</option><option value="MS">MS (Petrol)</option><option value="ATF">ATF</option><option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Loaded Qty (Ltrs/Tons) *</label>
                  <input type="number" value={manualData.Loaded_Qty} onChange={e => setManualData({...manualData, Loaded_Qty: e.target.value})} style={{ ...inputStyle, borderColor: '#10b981', fontSize: '16px', fontWeight: 'bold', color: '#10b981' }} placeholder="0.00" />
                </div>
              </div>

              <button onClick={handleManualSave} style={{ width: '100%', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', fontSize: '16px', boxShadow: '0 5px 15px rgba(16,185,129,0.4)' }}>
                {isNewEntry ? '💾 Create Trip & Save Loading' : '💾 Save Loading Entry'}
              </button>
            </>
          )}
        </div>
      )}

      {/* 📱 TAB 2: AUTO SYNC */}
      {activeTab === 'AUTO' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
          {pendingDriverApprovals.length === 0 ? <div style={{ color: '#64748b' }}>No pending approvals.</div> : 
            pendingDriverApprovals.map(t => (
              <div key={t.id} style={{ background: '#1e293b', border: '1px solid #38bdf8', borderRadius: '15px', padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <span style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '18px' }}>{t.Vehical_No || t.vehicle_no || t.vehical_no}</span>
                  <span style={{ background: '#334155', padding: '2px 8px', borderRadius: '5px', fontSize: '11px' }}>{t.Trip_ID || t.trip_id}</span>
                </div>
                <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '15px' }}>📍 {t.Loading_Point || t.loading_point} ➔ {t.Consignee_Name || t.consignee_name}</div>
                <div style={{ background: 'rgba(56, 189, 248, 0.1)', padding: '15px', borderRadius: '10px', marginBottom: '15px' }}>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>Driver Entered Qty:</div>
                  <div style={{ fontSize: '24px', fontWeight: '900', color: '#38bdf8' }}>{t.driver_loaded_qty} Ltrs</div>
                </div>
                <button onClick={() => handleApproveDriverLoading(t.id, t.driver_loaded_qty)} style={{ width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>✅ Verify & Approve</button>
              </div>
          ))}
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
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={14} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8' }}>Loading Data...</td></tr> : loadingRegister.length === 0 ? <tr><td colSpan={14} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No Data Found.</td></tr> : 
                loadingRegister.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '12px' }}>
                  <td style={{ padding: '12px 15px' }}>{t.Trip_ID || t.trip_id}</td><td style={{ padding: '12px 15px' }}>{t.Customer || t.customer_name}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Loading_Date || t.loading_date}</td><td style={{ padding: '12px 15px', fontWeight: 'bold', color: '#fff' }}>{t.Challan_No || '-'}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Loading_Point || t.loading_point}</td><td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: 'bold' }}>{t.Vehical_No || t.vehicle_no || t.vehical_no}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Registered_Assessee || '-'}</td><td style={{ padding: '12px 15px' }}>{t.Consignee_Name || t.consignee_name}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Product_Type || t.product_type}</td><td style={{ padding: '12px 15px', color: '#10b981', fontWeight: '900' }}>{t.Loaded_Qty || t.loaded_qty}</td>
                  <td style={{ padding: '12px 15px' }}>{t.RTKM || t.rtkm || '-'}</td><td style={{ padding: '12px 15px' }}>{t.Rate || t.rate || '-'}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Driver_Name || t.driver_name}</td><td style={{ padding: '12px 15px' }}>{t.Driver_Mobil_No || t.driver_mobil_no}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}