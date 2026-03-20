// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, doc, updateDoc, addDoc, query, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function LodingDetals() {
  const [activeTab, setActiveTab] = useState('MANUAL'); 
  const [trips, setTrips] = useState<any[]>([]);
  const [rtkmMaster, setRtkmMaster] = useState<any[]>([]); 
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const [selectedTripId, setSelectedTripId] = useState('');
  const [isNewEntry, setIsNewEntry] = useState(false); 
  const [isFetchingEmails, setIsFetchingEmails] = useState(false); 
  const [isScanningFile, setIsScanningFile] = useState(false); // 🤖 AI File Scan State

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
      const tripSnap = await getDocs(collection(db, "TRIPS"));
      setTrips(tripSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
      
      const rtkmMasterSnap = await getDocs(collection(db, "RTKM_MASTER")).catch(() => ({ docs: [] })); 
      setRtkmMaster(rtkmMasterSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      const vehSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vehSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      const drvSnap = await getDocs(collection(db, "DRIVERS"));
      setDrivers(drvSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

    } catch (error) {
      console.error("Error fetching data:", error);
    }
    setLoading(false);
  };

  // 🎤 MAMTA AI - ULTRA PREMIUM NEURAL VOICE
  const speakSmartHinglishReport = async (text: string) => {
      try {
          const response = await fetch("https://prasad-api.onrender.com/speak", {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text })
          });
          const data = await response.json();
          if (data.success && data.audioContent) {
              const audioSrc = `data:audio/mp3;base64,${data.audioContent}`;
              const audio = new Audio(audioSrc);
              audio.play(); 
          }
      } catch (error) { console.error("Voice Error:", error); }
  };

  // ✨ SMART DATE FORMATTER 
  const formatForDatePicker = (dateStr: string) => {
    if (!dateStr) return "";
    try {
      const parts = dateStr.match(/\d+/g);
      if (parts && parts.length >= 3) {
        let d = parts[0], m = parts[1], y = parts[2];
        if (y.length === 4) return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
        if (d.length === 4) return `${d}-${m.padStart(2, '0')}-${y.padStart(2, '0')}`;
      }
      return dateStr;
    } catch (e) { return ""; }
  };

  // 🤖 MAGIC FUNCTION 1: Auto-Fetch Emails
  const handleAutoFetchEmails = async () => {
    setIsFetchingEmails(true);
    try {
      const response = await fetch('https://prasad-api.onrender.com/fetch-iocl-emails', { method: 'POST' });
      const result = await response.json();

      if (result.success && result.aiData) {
        const ai = result.aiData;
        let product = "HSD";
        if(ai.productName && ai.productName.toUpperCase().includes("ATF")) product = "ATF";
        else if(ai.productName && ai.productName.toUpperCase().includes("MS")) product = "MS";

        setIsNewEntry(true);
        setSelectedTripId('NEW');

        setManualData({
          Trip_ID: 'TRP-' + Math.floor(Math.random() * 90000 + 10000), 
          Customer: 'IndianOil Corporation Ltd', 
          Loading_Date: formatForDatePicker(ai.documentDate) || new Date().toISOString().split('T')[0], 
          Challan_No: ai.documentNumber || '', 
          Loading_Point: ai.loadingOrigin || '', 
          Vehical_No: ai.truckNumber || '', 
          Registered_Assessee: 'IOCL', 
          Consignee_Name: ai.loadingDestination || '', 
          Product_Type: product, 
          Loaded_Qty: ai.quantity || '', 
          RTKM: '', Rate: '', Driver_Name: '', Driver_Mobil_No: ''
        });

        alert("🤖 Email AI Success! IOCL Invoice auto-filled.");
        speakSmartHinglishReport(`नमस्कार सर। ईमेल से नया चालान स्कैन हो गया है।`);
      } else {
        alert("⚠️ No new IOCL loading invoices found in Gmail.");
      }
    } catch (error) { alert("❌ Live Server error."); }
    setIsFetchingEmails(false);
  };

  // 🤖 MAGIC FUNCTION 2: MANUAL PDF/IMAGE UPLOAD & SCAN
  const handleManualFileUpload = async (e: any) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsScanningFile(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('driverName', 'Direct_Loading_Slip'); 
    formData.append('docType', 'INVOICE'); 

    try {
      const response = await fetch('https://prasad-api.onrender.com/upload-to-drive', {
        method: 'POST',
        body: formData
      });
      const result = await response.json();

      if (result.success && result.aiData) {
        const ai = result.aiData;
        
        let product = "HSD";
        let rawText = JSON.stringify(ai).toUpperCase();
        if(rawText.includes("ATF")) product = "ATF";
        else if(rawText.includes("MS ") || rawText.includes("PETROL")) product = "MS";

        setIsNewEntry(true);
        setSelectedTripId('NEW');

        setManualData(prev => ({
          ...prev,
          Trip_ID: 'TRP-' + Math.floor(Math.random() * 90000 + 10000),
          Loading_Date: formatForDatePicker(ai.documentDate) || new Date().toISOString().split('T')[0],
          Challan_No: ai.documentNumber || '',
          Vehical_No: ai.vehicleNumber || ai.truckNumber || '',
          Loading_Point: ai.fromLocation || ai.partyName || prev.Loading_Point,
          Consignee_Name: ai.toLocation || prev.Consignee_Name,
          Loaded_Qty: ai.quantity || ai.totalAmount || '',
          Product_Type: product
        }));

        alert("✅ Document Scanned & Auto-Filled Successfully!");
        speakSmartHinglishReport(`नमस्कार सुभाष सर। लोडिंग स्लिप स्कैन हो गई है। गाड़ी नंबर ${ai.vehicleNumber || ai.truckNumber || ''} का डेटा भर दिया गया है। कृपया चेक करके सेव करें।`);
      } else {
        alert("❌ AI could not read the document properly. Try a clearer image.");
      }
    } catch (error) {
      alert("❌ Live Server is unreachable.");
    }
    setIsScanningFile(false);
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
      if(t) {
          setManualData({
            Trip_ID: t.trip_id || t.Trip_ID || t.id, 
            Customer: t.customer_name || t.Customer || '',
            Loading_Date: new Date().toISOString().split('T')[0], 
            Challan_No: t.Challan_No || t.challan_no || '', 
            Loading_Point: t.loading_point || t.Loading_Point || '', 
            Vehical_No: t.vehicle_no || t.vehical_no || t.Vehical_No || '',
            Registered_Assessee: t.registered_assessee || t.customer_name || t.Registered_Assessee || '', 
            Consignee_Name: t.consignee_name || t.Consignee_Name || '',
            Product_Type: t.product_type || t.Product_Type || 'HSD', 
            Loaded_Qty: t.driver_loaded_qty || t.loaded_qty || t.Loaded_Qty || '', 
            RTKM: t.rtkm || t.RTKM || '', 
            Rate: t.rate || t.Rate || '',
            Driver_Name: t.driver_name || t.Driver_Name || '', 
            Driver_Mobil_No: t.driver_mobil_no || t.driver_mobile || t.Driver_Mobil_No || ''
          });
      }
    }
  };

  const handleRouteSelect = (e: any) => {
    const routeId = e.target.value;
    const selectedRoute = rtkmMaster.find(r => r.id === routeId);
    
    if (selectedRoute) {
      setManualData(prev => ({
        ...prev,
        Loading_Point: selectedRoute.Depot_Link || selectedRoute.depot_link || '',
        Consignee_Name: selectedRoute.Consignee_Name || selectedRoute.consignee_name || '',
        Customer: selectedRoute.Registered_Assessee || selectedRoute.customer_name || '',
        Registered_Assessee: selectedRoute.Registered_Assessee || selectedRoute.customer_name || '',
        RTKM: selectedRoute.RTKM_Distance || selectedRoute.rtkm_distance || '',
        Rate: selectedRoute.Rate_Per_Unit || selectedRoute.rate_per_unit || '',
        Product_Type: selectedRoute.Item_Type || selectedRoute.item_type || 'HSD'
      }));
    }
  };

  const handleDriverSelect = (e: any) => {
    const dName = e.target.value;
    const selectedDriver = drivers.find(d => d.name === dName);
    setManualData(prev => ({
      ...prev,
      Driver_Name: dName,
      Driver_Mobil_No: selectedDriver ? (selectedDriver.mobile_no || selectedDriver.mobile || selectedDriver.phone || '') : ''
    }));
  };

  const handleApproveDriverLoading = async (tripId: string, driverQty: string) => {
    try {
      await updateDoc(doc(db, "TRIPS", tripId), {
        office_approved_loading: true, 
        Loaded_Qty: driverQty, 
        loaded_qty: driverQty,
        trip_status: 'IN_TRANSIT', 
        Loading_Date: new Date().toISOString().split('T')[0],
        loading_date: new Date().toISOString().split('T')[0]
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
          ...manualData, 
          trip_id: manualData.Trip_ID, 
          vehicle_no: manualData.Vehical_No, 
          customer_name: manualData.Customer,
          loading_point: manualData.Loading_Point,
          consignee_name: manualData.Consignee_Name,
          driver_name: manualData.Driver_Name,
          driver_mobil_no: manualData.Driver_Mobil_No,
          loaded_qty: manualData.Loaded_Qty,
          loading_date: manualData.Loading_Date,
          challan_no: manualData.Challan_No,
          office_approved_loading: true, 
          trip_status: 'IN_TRANSIT', 
          created_at: Timestamp.now()
        });
        alert("✅ New Direct Loading Entry Created! Trip Started.");
        speakSmartHinglishReport(`डेटा सफलतापूर्वक सेव हो गया है। ट्रिप चालू हो गई है।`);
      } else {
        await updateDoc(doc(db, "TRIPS", selectedTripId), {
          ...manualData, 
          office_approved_loading: true, 
          trip_status: 'IN_TRANSIT', 
          loaded_qty: manualData.Loaded_Qty,
          loading_date: manualData.Loading_Date,
          challan_no: manualData.Challan_No
        });
        alert("✅ Loading Entry Updated Successfully!");
      }
      setSelectedTripId('');
      setIsNewEntry(false);
      fetchTripsAndMaster();
    } catch (e) { alert("❌ Error saving manual entry."); }
  };

  const sendLoadingWhatsApp = (trip: any) => {
    const mobile = trip.Driver_Mobil_No || trip.driver_mobil_no || trip.driver_mobile;
    if (!mobile) return alert("⚠️ No mobile number found for this driver!");

    const tripId = trip.Trip_ID || trip.trip_id;
    const vehicle = trip.Vehical_No || trip.vehicle_no || trip.vehical_no;
    const qty = trip.Loaded_Qty || trip.loaded_qty || trip.driver_loaded_qty;
    const from = trip.Loading_Point || trip.loading_point;
    const to = trip.Consignee_Name || trip.consignee_name;
    const challan = trip.Challan_No || trip.challan_no || '-';

    const message = `🚛 *LOADING CONFIRMATION*\n\nYour vehicle has been successfully loaded.\n\n*Trip ID:* ${tripId}\n*Vehicle:* ${vehicle}\n*Loaded Qty:* ${qty} Ltrs\n*Challan No:* ${challan}\n\n*From:* ${from}\n*To:* ${to}\n\nHave a safe journey! Drive carefully.\n\nRegards,\nPrasad Transport ERP`;
    
    let phone = mobile.replace(/\s+/g, ''); 
    if (phone.length === 10) phone = '91' + phone;

    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(message)}`, '_blank');
  };

  const pendingDriverApprovals = trips.filter(t => t.driver_loaded_qty && !t.office_approved_loading);
  const pendingManualTrips = trips.filter(t => !t.office_approved_loading && t.trip_status !== 'COMPLETED');
  const loadingRegister = trips.filter(t => t.office_approved_loading).sort((a:any, b:any) => new Date(b.Loading_Date || b.loading_date).getTime() - new Date(a.Loading_Date || a.loading_date).getTime());

  const inputStyle = { width: '100%', padding: '10px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', fontSize: '13px', boxSizing: 'border-box' as 'border-box', outline: 'none' };
  const autoFillStyle = { ...inputStyle, background: 'rgba(56, 189, 248, 0.05)', border: '1px dashed #38bdf8', color: '#94a3b8' };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
      
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '28px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>📦 Loading Register</h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Smart Linked with Master Data & AI Scan</p>
        </div>
        
        <button 
          onClick={handleAutoFetchEmails} 
          disabled={isFetchingEmails}
          style={{ 
            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', color: '#fff', border: 'none', padding: '12px 25px', 
            borderRadius: '30px', fontWeight: '900', cursor: isFetchingEmails ? 'not-allowed' : 'pointer', fontSize: '14px', 
            boxShadow: '0 5px 20px rgba(139, 92, 246, 0.4)', display: 'flex', alignItems: 'center', gap: '8px', transition: '0.3s' 
          }}
        >
          {isFetchingEmails ? '⏳ Scanning Gmail...' : '📥 Auto-Fetch from Gmail'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '25px', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>
        <button onClick={() => setActiveTab('MANUAL')} style={{ padding: '10px 20px', background: activeTab === 'MANUAL' ? 'rgba(16, 185, 129, 0.1)' : 'transparent', color: activeTab === 'MANUAL' ? '#10b981' : '#94a3b8', border: 'none', borderBottom: activeTab === 'MANUAL' ? '3px solid #10b981' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>✍️ DIRECT ENTRY</button>
        <button onClick={() => setActiveTab('AUTO')} style={{ padding: '10px 20px', background: activeTab === 'AUTO' ? 'rgba(56, 189, 248, 0.1)' : 'transparent', color: activeTab === 'AUTO' ? '#38bdf8' : '#94a3b8', border: 'none', borderBottom: activeTab === 'AUTO' ? '3px solid #38bdf8' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>📱 APP SYNC {pendingDriverApprovals.length > 0 && <span style={{background:'#ef4444', color:'white', padding:'2px 8px', borderRadius:'10px', marginLeft:'5px', fontSize:'11px'}}>{pendingDriverApprovals.length}</span>}</button>
        <button onClick={() => setActiveTab('REGISTER')} style={{ padding: '10px 20px', background: activeTab === 'REGISTER' ? 'rgba(245, 158, 11, 0.1)' : 'transparent', color: activeTab === 'REGISTER' ? '#f59e0b' : '#94a3b8', border: 'none', borderBottom: activeTab === 'REGISTER' ? '3px solid #f59e0b' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>📋 SHEET VIEW</button>
      </div>

      {activeTab === 'MANUAL' && (
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '15px', padding: '30px' }}>
          
          <div style={{ marginBottom: '20px', background: 'rgba(16, 185, 129, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
            <label style={{ color: '#10b981', fontSize: '13px', fontWeight: 'bold', marginBottom: '8px', display: 'block' }}>🔍 Start Loading Entry *</label>
            <select value={selectedTripId} onChange={handleManualTripSelect} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #10b981', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '15px' }}>
              <option value="">-- Choose Option --</option>
              <option value="NEW" style={{ background: '#10b981', color: '#0f172a', fontWeight: 'bold' }}>➕ CREATE FRESH DIRECT ENTRY</option>
              <optgroup label="Auto-Fill from Pending Trips:">
                {pendingManualTrips.map(t => <option key={t.id} value={t.id}>{t.vehicle_no || t.vehical_no} | {t.loading_point} ➔ {t.consignee_name}</option>)}
              </optgroup>
            </select>
          </div>

          {/* 🌟 NEW AI UPLOAD SECTION */}
          {selectedTripId === 'NEW' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px', marginBottom: '20px', background: 'rgba(56, 189, 248, 0.05)', padding: '15px', border: '1px dashed #38bdf8', borderRadius: '10px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ color: '#38bdf8', fontSize: '14px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>🤖 Mamta AI Scanner</label>
                <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px' }}>Upload IOCL Invoice or Loading Slip (PDF/Photo) to auto-fill the form below instantly.</p>
              </div>
              <label style={{ background: '#38bdf8', color: '#0f172a', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: isScanningFile ? 'not-allowed' : 'pointer', fontSize: '13px', transition: '0.3s', boxShadow: '0 4px 15px rgba(56,189,248,0.4)' }}>
                {isScanningFile ? '⏳ Scanning File...' : '📎 Upload & Scan'}
                <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={handleManualFileUpload} disabled={isScanningFile} />
              </label>
            </div>
          )}

          {selectedTripId && (
            <>
              {isNewEntry && (
                <div style={{ background: 'rgba(245,158,11,0.1)', padding: '15px', borderRadius: '8px', marginBottom: '20px', border: '1px dashed #f59e0b' }}>
                  <label style={{ color: '#f59e0b', fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>🔗 1. Select Route from RTKM Master (Optional if AI filled)</label>
                  <select onChange={handleRouteSelect} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #f59e0b', color: '#fff', borderRadius: '8px', outline: 'none' }}>
                    <option value="">-- Choose Route / Consignee --</option>
                    {rtkmMaster.map(r => (
                      <option key={r.id} value={r.id}>{r.Depot_Link || r.depot_link} ➔ {r.Consignee_Name || r.consignee_name} | Rate: ₹{r.Rate_Per_Unit || r.rate_per_unit}</option>
                    ))}
                  </select>
                </div>
              )}

              <h4 style={{ color: '#38bdf8', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '15px' }}>2. Verify / Edit Details</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '20px' }}>
                
                <div><label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Trip ID</label><input type="text" value={manualData.Trip_ID} readOnly style={autoFillStyle} /></div>
                
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Vehicle No *</label>
                  {isNewEntry ? (
                    <input type="text" value={manualData.Vehical_No} onChange={e=>setManualData({...manualData, Vehical_No: e.target.value})} style={inputStyle} placeholder="AS26C9810" />
                  ) : (
                    <input type="text" value={manualData.Vehical_No} readOnly style={autoFillStyle} />
                  )}
                </div>

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
                
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Customer Name</label><input type="text" value={manualData.Customer} onChange={e=>setManualData({...manualData, Customer: e.target.value})} style={autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Loading Point</label><input type="text" value={manualData.Loading_Point} onChange={e=>setManualData({...manualData, Loading_Point: e.target.value})} style={autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Consignee Name</label><input type="text" value={manualData.Consignee_Name} onChange={e=>setManualData({...manualData, Consignee_Name: e.target.value})} style={autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>RTKM</label><input type="text" value={manualData.RTKM} onChange={e=>setManualData({...manualData, RTKM: e.target.value})} style={autoFillStyle} /></div>
                <div><label style={{ color: '#f59e0b', fontSize: '11px', display: 'block', marginBottom: '5px' }}>Rate</label><input type="text" value={manualData.Rate} onChange={e=>setManualData({...manualData, Rate: e.target.value})} style={autoFillStyle} /></div>
              </div>

              <h4 style={{ color: '#10b981', borderBottom: '1px solid #334155', paddingBottom: '10px', marginBottom: '15px' }}>3. Enter Loading Quantity</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '25px' }}>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Loading Date *</label>
                  <input type="date" value={manualData.Loading_Date} onChange={e => setManualData({...manualData, Loading_Date: e.target.value})} style={{ ...inputStyle, colorScheme: 'dark' }} />
                </div>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Challan / SAP No *</label>
                  <input type="text" value={manualData.Challan_No} onChange={e => setManualData({...manualData, Challan_No: e.target.value})} style={{ ...inputStyle, borderColor: '#f59e0b' }} placeholder="Enter Challan" />
                </div>
                <div>
                  <label style={{ color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Product Type *</label>
                  <select value={manualData.Product_Type} onChange={e => setManualData({...manualData, Product_Type: e.target.value})} style={inputStyle}>
                    <option value="HSD">HSD (Diesel)</option><option value="MS">MS (Petrol)</option><option value="ATF">ATF</option><option value="Other">Other</option>
                  </select>
                </div>
                <div>
                  <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Loaded Qty (Ltrs) *</label>
                  <input type="number" value={manualData.Loaded_Qty} onChange={e => setManualData({...manualData, Loaded_Qty: e.target.value})} style={{ ...inputStyle, borderColor: '#10b981', fontSize: '16px', fontWeight: 'bold', color: '#10b981' }} placeholder="0.00" />
                </div>
              </div>

              <button onClick={handleManualSave} style={{ width: '100%', background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', fontSize: '16px', boxShadow: '0 5px 15px rgba(16,185,129,0.4)' }}>
                {isNewEntry ? '💾 Save Direct Entry' : '💾 Save Update'}
              </button>
            </>
          )}
        </div>
      )}

      {activeTab === 'AUTO' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '20px' }}>
          {pendingDriverApprovals.length === 0 ? <div style={{ color: '#64748b' }}>No pending approvals.</div> : 
            pendingDriverApprovals.map(t => (
              <div key={t.id} style={{ background: '#1e293b', border: '1px solid #38bdf8', borderRadius: '15px', padding: '20px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <span style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '18px' }}>{t.Vehical_No || t.vehicle_no}</span>
                  <span style={{ background: '#334155', padding: '2px 8px', borderRadius: '5px', fontSize: '11px' }}>{t.Trip_ID || t.trip_id}</span>
                </div>
                <div style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '15px' }}>📍 {t.Loading_Point || t.loading_point} ➔ {t.Consignee_Name || t.consignee_name}</div>
                <div style={{ background: 'rgba(56, 189, 248, 0.1)', padding: '15px', borderRadius: '10px', marginBottom: '15px' }}>
                  <div style={{ fontSize: '12px', color: '#94a3b8' }}>Driver Qty:</div>
                  <div style={{ fontSize: '24px', fontWeight: '900', color: '#38bdf8' }}>{t.driver_loaded_qty} Ltrs</div>
                </div>
                <button onClick={() => handleApproveDriverLoading(t.id, t.driver_loaded_qty)} style={{ width: '100%', background: '#38bdf8', color: '#0f172a', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>✅ Verify & Approve</button>
              </div>
          ))}
        </div>
      )}

      {activeTab === 'REGISTER' && (
        <div style={{ background: '#1e293b', borderRadius: '15px', overflowX: 'auto', border: '1px solid #334155' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
            <thead style={{ background: '#0f172a', color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase' }}>
              <tr>
                <th style={{ padding: '15px' }}>Trip_ID</th><th style={{ padding: '15px' }}>Customer</th><th style={{ padding: '15px' }}>Loading_Date</th><th style={{ padding: '15px' }}>Challan_No</th>
                <th style={{ padding: '15px' }}>Loading_Point</th><th style={{ padding: '15px', color: '#38bdf8' }}>Vehical_No</th>
                <th style={{ padding: '15px' }}>Consignee_Name</th><th style={{ padding: '15px' }}>Product_Type</th><th style={{ padding: '15px', color: '#10b981' }}>Loaded_Qty</th>
                <th style={{ padding: '15px' }}>Driver_Name</th><th style={{ padding: '15px', textAlign: 'center' }}>WhatsApp</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={11} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8' }}>Loading Data...</td></tr> : loadingRegister.length === 0 ? <tr><td colSpan={11} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No Data Found.</td></tr> : 
                loadingRegister.map((t) => (
                <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '12px' }}>
                  <td style={{ padding: '12px 15px' }}>{t.Trip_ID || t.trip_id}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Customer || t.customer_name}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Loading_Date || t.loading_date}</td>
                  <td style={{ padding: '12px 15px', fontWeight: 'bold', color: '#fff' }}>{t.Challan_No || t.challan_no || '-'}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Loading_Point || t.loading_point}</td>
                  <td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: 'bold' }}>{t.Vehical_No || t.vehicle_no || t.vehical_no}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Consignee_Name || t.consignee_name}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Product_Type || t.product_type}</td>
                  <td style={{ padding: '12px 15px', color: '#10b981', fontWeight: '900' }}>{t.Loaded_Qty || t.loaded_qty || t.driver_loaded_qty}</td>
                  <td style={{ padding: '12px 15px' }}>{t.Driver_Name || t.driver_name}</td>
                  
                  <td style={{ padding: '12px 15px', textAlign: 'center' }}>
                    <button 
                      onClick={() => sendLoadingWhatsApp(t)} 
                      style={{ background: 'rgba(34, 197, 94, 0.2)', border: '1px solid #22c55e', color: '#22c55e', padding: '6px 12px', borderRadius: '20px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}
                    >
                      💬 Send
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