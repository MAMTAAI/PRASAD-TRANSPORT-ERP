// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp, onSnapshot } from 'firebase/firestore';
import { db } from './firebase';
import { GoogleGenerativeAI } from '@google/generative-ai';

const GOOGLE_MAPS_API_KEY = "***REMOVED-ROTATE-ME***"; 
const GEMINI_API_KEY = "***REMOVED-ROTATE-ME***"; 

// 🗺️ OLA/UBER MAP WITH LIVE GPRS TRUCK TRACKING
const OlaUberMap = ({ origin, destination, tripId }: any) => {
  const mapRef = useRef<any>(null);
  const [mapObj, setMapObj] = useState<any>(null);
  const [truckMarker, setTruckMarker] = useState<any>(null);

  useEffect(() => {
    if (!window.google || !origin || !destination || !mapRef.current) return;
    const map = new window.google.maps.Map(mapRef.current, {
      zoom: 6, disableDefaultUI: true, backgroundColor: '#0f172a',
      styles: [
        { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
        { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
        { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
        { featureType: "road", elementType: "geometry", stylers: [{ color: "#38414e" }] },
        { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: "#212a37" }] },
        { featureType: "water", elementType: "geometry", stylers: [{ color: "#17263c" }] }
      ]
    });
    setMapObj(map);

    const directionsService = new window.google.maps.DirectionsService();
    const directionsRenderer = new window.google.maps.DirectionsRenderer({ map: map, suppressMarkers: false, polylineOptions: { strokeColor: '#38bdf8', strokeWeight: 5, strokeOpacity: 0.8 } });
    directionsService.route({ origin: origin, destination: destination, travelMode: window.google.maps.TravelMode.DRIVING }, (response: any, status: any) => { if (status === 'OK') directionsRenderer.setDirections(response); });

    const marker = new window.google.maps.Marker({
      map: map,
      icon: { path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: 6, fillColor: '#10b981', fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2, rotation: 0 },
      title: "Live Vehicle Location"
    });
    setTruckMarker(marker);
  }, [origin, destination]);

  useEffect(() => {
    if (!tripId || !truckMarker || !mapObj) return;
    const unsubscribe = onSnapshot(doc(db, "TRIPS", tripId), (docSnap: any) => {
      const data = docSnap.data() || {};
      if (data && data.live_location) { truckMarker.setPosition({ lat: data.live_location.lat, lng: data.live_location.lng }); }
    });
    return () => unsubscribe(); 
  }, [tripId, truckMarker, mapObj]);

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ position: 'absolute', top: '10px', left: '10px', background: 'rgba(0,0,0,0.8)', color: '#10b981', padding: '5px 10px', borderRadius: '20px', fontSize: '10px', zIndex: 10, border: '1px solid #10b981', display: 'flex', alignItems: 'center', gap: '5px' }}>
        <span style={{ width: '8px', height: '8px', background: '#10b981', borderRadius: '50%', boxShadow: '0 0 10px #10b981', animation: 'blink 1s infinite' }}></span> GPRS Radar Active
      </div>
      <div ref={mapRef} style={{ width: '100%', height: '180px', borderRadius: '10px' }}></div>
      <style>{`@keyframes blink { 0% { opacity: 1; } 50% { opacity: 0.4; } 100% { opacity: 1; } }`}</style>
    </div>
  );
};

export default function TripManagment() {
  const [trips, setTrips] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]); 

  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<string>('LIVE');

  const [modalType, setModalType] = useState<any>(null);
  const [editingId, setEditingId] = useState<any>(null);

  const getInitialState = () => ({
    trip_id: `TRP-${Date.now().toString().slice(-6)}`, trip_status: 'LOADED',
    customer: '', loading_date: new Date().toISOString().split('T')[0], challan_no: '', loading_point: '', vehicle_no: '', consignee_name: '', product_type: 'MS/HSD', loaded_qty: '', actual_rtkm: '', company_rtkm: '', rate: '', driver_name: '', driver_mobil_no: '',
    multi_advances: [{ id: Date.now(), pump_name: '', hsd_qty: '', cash: '' }],
    advance_cash: '0', advance_hsd_qty: '0',
    unloading_date: new Date().toISOString().split('T')[0], unloaded_qty: '', shortage: '0', shortage_amt: '0',
    toll_amt: '0', gross_freight: '0', net_payable: '0', driver_bhatta: '0', live_location: null 
  });

  const [formData, setFormData] = useState<any>(getInitialState());

  useEffect(() => {
    if (!window.google) {
      const script = document.createElement('script');
      script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places`;
      script.async = true; script.defer = true; document.head.appendChild(script);
    }
    fetchTrips(); fetchMasters(); 
  }, []);

  const fetchTrips = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "TRIPS"));
      const dataArray = snap.docs.map((doc: any) => {
        const d = doc.data() || {};
        return {
          ...d,
          id: doc.id,
          trip_id: d.Trip_ID || d.trip_id || `TRP-${doc.id.slice(-5)}`,
          vehicle_no: d.Vehical_No || d.vehicle_no || d.vehical_no || 'Unknown',
          driver_name: d.Driver_Name || d.driver_name || 'Unassigned',
          loaded_qty: d.Loaded_Qty || d.loaded_qty || '0',
          loading_point: d.Loading_Point || d.loading_point || '',
          consignee_name: d.Consignee_Name || d.consignee_name || '',
          trip_status: d.Trip_Status || d.trip_status || 'LOADED',
          challan_no: d.Challan_No || d.challan_no || ''
        };
      });
      dataArray.sort((a: any, b: any) => (b.trip_id || '').localeCompare(a.trip_id || ''));
      setTrips(dataArray);
    } catch (e) {}
    setLoading(false);
  };

  const fetchMasters = async () => {
    try {
      const vSnap = await getDocs(collection(db, "VEHICLES")); setVehicles(vSnap.docs.map((d: any) => ({ id: d.id, ...(d.data() || {}) })));
      const dSnap = await getDocs(collection(db, "DRIVERS")); setDrivers(dSnap.docs.map((d: any) => ({ id: d.id, ...(d.data() || {}) })));
      const cSnap = await getDocs(collection(db, "CUSTOMERS")); setCustomers(cSnap.docs.map((d: any) => ({ id: d.id, ...(d.data() || {}) })));
      const venSnap = await getDocs(collection(db, "VENDORS")); setVendors(venSnap.docs.map((d: any) => ({ id: d.id, ...(d.data() || {}) })));
    } catch (e) {}
  };

  const closeAll = () => { setModalType(null); setEditingId(null); };

  const openModal = (type: any, trip: any = null) => {
    if (trip) { 
      let existingAdvances = trip.multi_advances;
      if (!existingAdvances || !Array.isArray(existingAdvances) || existingAdvances.length === 0) {
        existingAdvances = [{ id: Date.now(), pump_name: trip.advance_pump_name || '', hsd_qty: trip.advance_hsd_qty || '', cash: trip.advance_cash || '' }];
      }
      setFormData({...getInitialState(), ...trip, multi_advances: existingAdvances}); 
      setEditingId(trip.id); 
    } else { 
      setFormData(getInitialState()); setEditingId(null); 
    }
    setModalType(type); setActiveTab('LIVE');
  };

  const handleAutoRTKM = () => {
    if (!formData.loading_point || !formData.consignee_name) return alert("⚠️ Enter From and To locations!");
    if (!window.google) return alert("⏳ Maps loading...");
    const service = new window.google.maps.DistanceMatrixService();
    service.getDistanceMatrix({ origins: [formData.loading_point || ''], destinations: [formData.consignee_name || ''], travelMode: window.google.maps.TravelMode.DRIVING }, 
      (response: any, status: any) => {
      if (status === 'OK' && response && response.rows && response.rows.length > 0 && response.rows[0].elements && response.rows[0].elements.length > 0 && response.rows[0].elements[0].status === 'OK') {
        const distanceValue = response.rows[0].elements[0].distance.value; 
        const roundTripKm = ((distanceValue / 1000) * 2).toFixed(0); 
        setFormData((prev: any) => ({ ...prev, actual_rtkm: roundTripKm }));
        alert(`✅ Found! Actual RTKM: ${roundTripKm} KM`);
      } else alert("❌ Route not found.");
    });
  };

  const handleAIScan = async (e: any) => {
    const file = e.target.files[0]; if (!file) return; setAiLoading(true);
    try {
      const reader = new FileReader(); reader.readAsDataURL(file);
      reader.onload = async () => {
        const base64Data = (reader.result as string).split(',')[1];
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
        const prompt = `Extract JSON: { "challan_no": "", "vehicle_no": "", "loading_point": "", "consignee_name": "", "loaded_qty": "", "customer": "" }`;
        const result = await model.generateContent([{ inlineData: { data: base64Data, mimeType: file.type } }, prompt]);
        const aiData = JSON.parse(result.response.text().replace(/```json|```/g, "").trim());
        const vNum = (aiData.vehicle_no || '').toUpperCase();
        const linkedDriver: any = (drivers || []).find((d: any) => (d.assigned_vehicle || '') === vNum || (d.vehicle_no || '') === vNum);
        
        setFormData((prev: any) => ({ ...prev, ...aiData, vehicle_no: vNum, driver_name: linkedDriver?.name || linkedDriver?.driver_name || '', driver_mobil_no: linkedDriver?.mobile || linkedDriver?.mobile_no || '' }));
        setModalType('LOADING'); alert("✨ Invoice Auto-Filled!");
      };
    } catch (err) { alert("AI Scan Failed."); } finally { setAiLoading(false); }
  };

  const handleSaveLoading = async () => {
    if (!formData.vehicle_no || !formData.challan_no) return alert("Vehicle No & Challan Required!");
    try {
      const freight = (parseFloat(formData.loaded_qty || '0') * parseFloat(formData.rate || '0')).toFixed(2);
      if (editingId) await updateDoc(doc(db, "TRIPS", editingId), { ...formData, gross_freight: freight });
      else await addDoc(collection(db, "TRIPS"), { ...formData, gross_freight: freight, trip_status: 'LOADED', createdAt: serverTimestamp() });
      closeAll(); fetchTrips();
    } catch (err) { alert("Error saving Trip!"); }
  };

  const handleAddAdvancePump = () => {
    const safeAdvances = formData.multi_advances || [];
    if (safeAdvances.length >= 4) return alert("Maximum 4 pumps allowed!");
    setFormData({ ...formData, multi_advances: [...safeAdvances, { id: Date.now(), pump_name: '', hsd_qty: '', cash: '' }] });
  };
  
  const handleAdvancePumpChange = (id: any, field: string, value: string) => {
    const safeAdvances = formData.multi_advances || [];
    const updated = safeAdvances.map((p: any) => p.id === id ? { ...p, [field]: value } : p);
    setFormData({ ...formData, multi_advances: updated });
  };
  
  const handleRemoveAdvancePump = (id: any) => {
    const safeAdvances = formData.multi_advances || [];
    setFormData({ ...formData, multi_advances: safeAdvances.filter((p: any) => p.id !== id) });
  };

  const handleSaveAdvance = async () => {
    if (!editingId) return;
    try {
      let totalCash = 0; let totalHsd = 0; let advanceDetailsText = '';
      const safeAdvances = formData.multi_advances || [];

      safeAdvances.forEach((adv: any, index: number) => {
        const c = parseFloat(adv.cash || '0'); const h = parseFloat(adv.hsd_qty || '0');
        totalCash += c; totalHsd += h;
        if (adv.pump_name || h > 0 || c > 0) {
          advanceDetailsText += `\n⛽ *Pump ${index+1}:* ${adv.pump_name || 'N/A'}\n   💧 Fuel: ${h > 0 ? h + ' Ltr' : 'No Fuel'}\n   💵 Cash: ${c > 0 ? '₹' + c : 'No Cash'}`;
        }
      });

      await updateDoc(doc(db, "TRIPS", editingId), { 
        multi_advances: safeAdvances, advance_cash: totalCash.toString(), advance_hsd_qty: totalHsd.toString(), 
        trip_status: 'IN_TRANSIT', Trip_Status: 'IN_TRANSIT' 
      });
      
      if (totalCash > 0 && formData.driver_name) {
        try {
          await addDoc(collection(db, "DRIVER_TRANSACTIONS"), { driver_name: formData.driver_name, txn_type: 'ADVANCE_GIVEN', amount: totalCash, date: new Date().toISOString().split('T')[0], remarks: `Trip Advance: ${formData.loading_point || ''} to ${formData.consignee_name || ''} (Trip: ${formData.trip_id || ''})`, createdAt: serverTimestamp() });
        } catch (e) {}
      }

      if (formData.driver_mobil_no) {
        const trackingLink = `https://prasad-transport-grup.web.app/driver-tracking?tripId=${editingId}`;
        const msg = `*PRASAD ERP: NEW TRIP INITIATED* 🚚\n*Vehicle:* ${formData.vehicle_no || ''}\n*Route:* ${formData.loading_point || ''} to ${formData.consignee_name || ''}\n\n*📝 YOUR ADVANCE MEMOS:*${advanceDetailsText}\n\n*Total Trip Advance:* Cash ₹${totalCash} | Fuel ${totalHsd} Ltr\n\n📍 *Click link below to START LIVE GPRS TRACKING:* \n${trackingLink}`;
        window.open(`https://wa.me/91${formData.driver_mobil_no}?text=${encodeURIComponent(msg)}`, '_blank');
      }
      closeAll(); fetchTrips();
    } catch (err) { alert("Error saving Advance!"); }
  };

  const handleSaveUnloading = async () => {
    if (!editingId) return;
    try {
      const loaded = parseFloat(formData.loaded_qty || '0'); const unloaded = parseFloat(formData.unloaded_qty || '0');
      const short = (loaded - unloaded > 0) ? (loaded - unloaded).toFixed(2) : '0';
      await updateDoc(doc(db, "TRIPS", editingId), { unloading_date: formData.unloading_date, unloaded_qty: formData.unloaded_qty, Unloaded_Qty: formData.unloaded_qty, shortage: short, Shortage: short, shortage_amt: formData.shortage_amt, trip_status: 'UNLOADED', Trip_Status: 'UNLOADED', live_location: null });
      closeAll(); fetchTrips();
    } catch (err) { alert("Error saving Unloading!"); }
  };

  // 🔥 FULLY INTEGRATED SETTLEMENT FOR AUTO-BILLING LINK
  const handleSaveSettlement = async () => {
    if (!editingId) return;
    try {
      const freight = parseFloat(formData.gross_freight || '0');
      const cashAdv = parseFloat(formData.advance_cash || '0');
      const toll = parseFloat(formData.toll_amt || '0');
      const shortAmt = parseFloat(formData.shortage_amt || '0');
      const netPay = (freight - cashAdv - toll - shortAmt).toFixed(2);
      
      // 👉 billing_status: 'PENDING' makes it show up in the BillManagement page automatically!
      await updateDoc(doc(db, "TRIPS", editingId), { 
        toll_amt: formData.toll_amt, 
        driver_bhatta: formData.driver_bhatta, 
        net_payable: netPay, 
        trip_status: 'COMPLETED', 
        Trip_Status: 'COMPLETED',
        billing_status: 'PENDING'
      });

      if (formData.driver_name) {
        try {
          if (shortAmt > 0) await addDoc(collection(db, "DRIVER_TRANSACTIONS"), { driver_name: formData.driver_name, txn_type: 'SHORTAGE_DEDUCTION', amount: shortAmt, date: new Date().toISOString().split('T')[0], remarks: `Trip Shortage: ${formData.trip_id || ''}`, createdAt: serverTimestamp() });
          if (parseFloat(formData.driver_bhatta || '0') > 0) await addDoc(collection(db, "DRIVER_TRANSACTIONS"), { driver_name: formData.driver_name, txn_type: 'SALARY_CREDIT', amount: parseFloat(formData.driver_bhatta), date: new Date().toISOString().split('T')[0], remarks: `Trip Bhatta: ${formData.trip_id || ''}`, createdAt: serverTimestamp() });
        } catch (e) { console.warn("Khata update failed."); }
      }
      closeAll(); fetchTrips();
    } catch (err) { alert("Error saving Settlement!"); }
  };

  const getStatusColor = (status: string) => {
    if(status === 'LOADED') return '#38bdf8'; if(status === 'IN_TRANSIT' || status === 'DISPATCHED') return '#10b981'; 
    if(status === 'UNLOADED') return '#f59e0b'; if(status === 'COMPLETED') return '#c084fc'; return '#64748b';
  };

  const filteredTrips = (trips || []).filter((t: any) => {
    const isStatusMatch = activeTab === 'LIVE' ? t.trip_status !== 'COMPLETED' : t.trip_status === 'COMPLETED';
    const vNo = (t.vehicle_no || '').toString().toUpperCase();
    const cNo = (t.challan_no || '').toString().toUpperCase();
    const sTerm = (searchTerm || '').toString().toUpperCase();
    return isStatusMatch && (vNo.includes(sTerm) || cNo.includes(sTerm));
  });

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 16px; transition: all 0.3s; }
        .glass-card:hover { transform: translateY(-3px); box-shadow: 0 10px 30px rgba(0,0,0,0.5); border-color: rgba(56, 189, 248, 0.4); }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .glow-btn { background: linear-gradient(135deg, #0284c7, #3b82f6); color: white; border: none; padding: 12px 25px; border-radius: 10px; font-weight: bold; cursor: pointer; transition: 0.3s; font-size: 14px; box-shadow: 0 4px 15px rgba(59, 130, 246, 0.4); display: flex; align-items: center; gap: 8px;}
        .glow-btn:hover { box-shadow: 0 4px 25px rgba(59, 130, 246, 0.7); transform: scale(1.02); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 12px; outline: none; width: 100%; font-size: 13px; box-sizing: border-box;}
        .modern-input:focus { border-color: #38bdf8; background: rgba(15, 23, 42, 0.9); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; transition: 0.3s; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 10px 10px 0 0; }
        .timeline-container { display: flex; align-items: center; justify-content: space-between; margin-bottom: 15px; position: relative; }
        .timeline-line { position: absolute; top: 50%; left: 10%; right: 10%; height: 2px; background: rgba(255,255,255,0.1); z-index: 1; transform: translateY(-50%); }
        .timeline-dot { width: 12px; height: 12px; border-radius: 50%; background: #334155; z-index: 2; border: 2px solid #0f172a; }
        .timeline-dot.active { box-shadow: 0 0 10px currentColor; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '36px', fontWeight: '900' }}>Live GPS Fleet Command</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0', fontSize: '14px' }}>Fully Synced with Loading, Unloading & Auto-Billing</p>
        </div>
        <div style={{ display: 'flex', gap: '15px' }}>
          <label className="glow-btn" style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', cursor: 'pointer', boxShadow: '0 0 20px rgba(245, 158, 11, 0.4)' }}>
            {aiLoading ? '⏳ AI Parsing...' : '📧 Mamta AI: Auto Trip Start'}
            <input type="file" hidden accept="image/*,application/pdf" onChange={handleAIScan} />
          </label>
          <button className="glow-btn" onClick={() => openModal('LOADING')}>+ Manual Dispatch</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
        <button className={`tab-btn ${activeTab === 'LIVE' ? 'active' : ''}`} onClick={() => setActiveTab('LIVE')}>🚚 LIVE GPRS TRACKING</button>
        <button className={`tab-btn ${activeTab === 'COMPLETED' ? 'active' : ''}`} onClick={() => setActiveTab('COMPLETED')}>✅ SETTLED TRIPS</button>
      </div>

      <div style={{ position: 'relative', marginBottom: '25px' }}>
        <input className="modern-input" placeholder="🔍 Search Vehicle No or Challan No..." style={{ paddingLeft: '45px', borderRadius: '50px' }} onChange={e => setSearchTerm(e.target.value)} />
        <span style={{ position: 'absolute', left: '18px', top: '10px', fontSize: '18px' }}>🔮</span>
      </div>

      {(filteredTrips || []).length === 0 && (
        <div style={{ textAlign: 'center', padding: '80px', background: 'rgba(255,255,255,0.02)', borderRadius: '20px', border: '2px dashed rgba(255,255,255,0.1)' }}>
          <h2 style={{ color: '#38bdf8', margin: '0 0 10px 0', fontSize: '28px' }}>No Vehicles Found 🚚</h2>
        </div>
      )}

      {/* 🗺️ SMART TRIP CARDS */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: '20px' }}>
        {(filteredTrips || []).map((t: any) => {
          const sColor = getStatusColor(t.trip_status);
          const steps = ['LOADED', 'IN_TRANSIT', 'UNLOADED', 'COMPLETED'];
          const currentStepIdx = steps.indexOf(t.trip_status === 'DISPATCHED' ? 'IN_TRANSIT' : t.trip_status);

          return (
            <div key={t.id} className="glass-card" style={{ padding: '20px', borderTop: `4px solid ${sColor}`, position: 'relative', overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                <span style={{ fontSize: '11px', color: '#94a3b8', background: 'rgba(255,255,255,0.05)', padding: '3px 8px', borderRadius: '5px' }}>{t.trip_id || 'N/A'}</span>
                <span style={{ background: `${sColor}20`, color: sColor, padding: '5px 12px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold' }}>
                  {t.trip_status === 'IN_TRANSIT' || t.trip_status === 'DISPATCHED' ? '📡 LIVE ON ROAD' : t.trip_status}
                </span>
              </div>

              <h2 style={{ margin: '0 0 5px 0', color: '#f8fafc', fontSize: '28px', letterSpacing: '1px' }}>{t.vehicle_no || 'Unknown'}</h2>
              <div style={{ color: '#cbd5e1', fontSize: '12px', marginBottom: '15px', display: 'flex', justifyContent: 'space-between' }}>
                <span>Driver: <b style={{color:'#fff'}}>{t.driver_name || 'N/A'}</b></span>
                <span>Qty: <b style={{color:'#f59e0b'}}>{t.loaded_qty || '0'} Lts</b></span>
              </div>
              
              {t.loading_point && t.consignee_name && activeTab === 'LIVE' && (
                <div style={{ marginBottom: '20px', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '10px', overflow: 'hidden' }}>
                  <OlaUberMap origin={t.loading_point} destination={t.consignee_name} tripId={t.id} />
                </div>
              )}

              <div className="timeline-container">
                <div className="timeline-line"><div style={{ width: `${(currentStepIdx / 3) * 100}%`, height: '100%', background: sColor, transition: '0.5s' }}></div></div>
                {steps.map((step, idx) => ( <div key={step} className={`timeline-dot ${idx <= currentStepIdx ? 'active' : ''}`} style={{ background: idx <= currentStepIdx ? sColor : '#334155', color: sColor }} title={step}></div> ))}
              </div>
              
              <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
                <button onClick={() => openModal('LOADING', t)} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid #475569', color: '#cbd5e1', padding: '10px', borderRadius: '8px', cursor: 'pointer', flex: 1, fontSize: '12px' }}>📝 Info</button>
                {t.trip_status === 'LOADED' && ( <button onClick={() => openModal('ADVANCE', t)} style={{ background: '#10b981', border: 'none', color: '#fff', padding: '10px', borderRadius: '8px', cursor: 'pointer', flex: 1, fontWeight: 'bold', fontSize: '12px' }}>🚀 Dispatch</button> )}
                {(t.trip_status === 'IN_TRANSIT' || t.trip_status === 'DISPATCHED') && ( <button onClick={() => openModal('UNLOADING', t)} style={{ background: '#f59e0b', border: 'none', color: '#000', padding: '10px', borderRadius: '8px', cursor: 'pointer', flex: 1, fontWeight: 'bold', fontSize: '12px' }}>📍 Reached</button> )}
                {t.trip_status === 'UNLOADED' && ( <button onClick={() => openModal('SETTLEMENT', t)} style={{ background: '#c084fc', border: 'none', color: '#fff', padding: '10px', borderRadius: '8px', cursor: 'pointer', flex: 1, fontWeight: 'bold', fontSize: '12px' }}>🤝 Settle</button> )}
              </div>
            </div>
          );
        })}
      </div>

      {/* 🔴 MODAL 1: LOADING */}
      {modalType === 'LOADING' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '1000px', border: '1px solid #38bdf8', background: '#0f172a', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h3 style={{ margin: 0, color: '#38bdf8', fontSize: '24px' }}>📝 Step 1: Loading & RTKM Setup</h3>
              <button onClick={closeAll} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px' }}>
              <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Loading Date</label><input type="date" className="modern-input" value={formData.loading_date} onChange={e=>setFormData({...formData, loading_date: e.target.value})} /></div>
              <div><label style={{ fontSize:'11px', color:'#38bdf8', fontWeight: 'bold' }}>Challan / Invoice No *</label><input className="modern-input" value={formData.challan_no} onChange={e=>setFormData({...formData, challan_no: e.target.value.toUpperCase()})} /></div>
              
              <div><label style={{ fontSize:'11px', color:'#38bdf8', fontWeight: 'bold' }}>Vehicle No *</label>
                <select className="modern-input" value={formData.vehicle_no} onChange={e=>setFormData({...formData, vehicle_no: e.target.value})}>
                  <option value="">-- Select Vehicle --</option>
                  {(vehicles || []).map((v: any) => <option key={v.id} value={v.vehicle_no}>{v.vehicle_no}</option>)}
                  {formData.vehicle_no && !(vehicles || []).find((v: any)=>v.vehicle_no === formData.vehicle_no) && <option value={formData.vehicle_no}>{formData.vehicle_no} (Auto-Detected)</option>}
                </select>
              </div>
              
              <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Driver Name</label>
                <select className="modern-input" value={formData.driver_name} onChange={e=>{
                  const selDriver: any = (drivers || []).find((d: any)=>d.name === e.target.value);
                  setFormData({...formData, driver_name: e.target.value, driver_mobil_no: selDriver?.mobile || selDriver?.mobile_no || ''});
                }}>
                  <option value="">-- Select Driver --</option>
                  {(drivers || []).map((d: any) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  {formData.driver_name && !(drivers || []).find((d: any)=>d.name === formData.driver_name) && <option value={formData.driver_name}>{formData.driver_name} (Auto-Detected)</option>}
                </select>
              </div>

              <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Customer / Company</label>
                <select className="modern-input" value={formData.customer} onChange={e=>setFormData({...formData, customer: e.target.value})}>
                  <option value="">-- Select Customer --</option>
                  {(customers || []).map((c: any) => <option key={c.id} value={c.customer_name}>{c.customer_name}</option>)}
                  {formData.customer && !(customers || []).find((c: any)=>c.customer_name === formData.customer) && <option value={formData.customer}>{formData.customer}</option>}
                </select>
              </div>

              <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>From (Loading Depot)</label><input className="modern-input" placeholder="e.g. Guwahati" value={formData.loading_point} onChange={e=>setFormData({...formData, loading_point: e.target.value})} /></div>
              <div style={{ gridColumn: 'span 2' }}><label style={{ fontSize:'11px', color:'#94a3b8' }}>To (Consignee Name / Location)</label><input className="modern-input" placeholder="e.g. Silchar" value={formData.consignee_name} onChange={e=>setFormData({...formData, consignee_name: e.target.value})} /></div>
              
              <div style={{ background: 'rgba(56, 189, 248, 0.05)', padding: '10px', borderRadius: '10px', border: '1px solid rgba(56, 189, 248, 0.3)' }}>
                <label style={{ fontSize:'11px', color:'#38bdf8', fontWeight: 'bold' }}>📍 Actual RTKM (Google Map)</label>
                <div style={{ display: 'flex', gap: '5px', marginTop: '5px' }}>
                  <input type="number" className="modern-input" style={{ flex: 1, padding: '8px' }} value={formData.actual_rtkm} onChange={e=>setFormData({...formData, actual_rtkm: e.target.value})} />
                  <button onClick={handleAutoRTKM} style={{ background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: '8px', padding: '0 10px', cursor: 'pointer', fontWeight: 'bold' }}>Auto</button>
                </div>
              </div>

              <div style={{ background: 'rgba(245, 158, 11, 0.05)', padding: '10px', borderRadius: '10px', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
                <label style={{ fontSize:'11px', color:'#f59e0b', fontWeight: 'bold' }}>🏢 Company Approved RTKM</label>
                <div style={{ marginTop: '5px' }}>
                  <input type="number" className="modern-input" style={{ width: '100%', padding: '8px' }} placeholder="Used for Billing" value={formData.company_rtkm} onChange={e=>setFormData({...formData, company_rtkm: e.target.value})} />
                </div>
              </div>

              <div><label style={{ fontSize:'11px', color:'#10b981', fontWeight:'bold' }}>Loaded Qty (Liters)</label><input type="number" className="modern-input" style={{ border: '1px solid #10b981' }} value={formData.loaded_qty} onChange={e=>setFormData({...formData, loaded_qty: e.target.value})} /></div>
              <div><label style={{ fontSize:'11px', color:'#c084fc' }}>Rate/Unit (₹)</label><input type="number" className="modern-input" value={formData.rate} onChange={e=>setFormData({...formData, rate: e.target.value})} /></div>
            </div>
            
            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', fontSize: '16px', justifyContent: 'center' }} onClick={handleSaveLoading}>🚀 INITIATE TRIP DATA</button>
          </div>
        </div>
      )}

      {/* 🔥 MODAL 2: ADVANCE & MULTI-PUMP WHATSAPP GPRS 🔥 */}
      {modalType === 'ADVANCE' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '650px', border: '1px solid #10b981', background: '#0f172a', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, color: '#10b981' }}>🚀 Step 2: Multi-Pump Advance & Dispatch</h3>
              <button onClick={closeAll} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ background: 'rgba(16, 185, 129, 0.1)', padding: '15px', borderRadius: '10px', marginBottom: '20px', border: '1px dashed #10b981' }}>
              <p style={{ margin: 0, fontSize: '12px', color: '#10b981' }}>Add multiple pumps for this trip. The Total Cash Advance will be debited from Driver's Khata, and a detailed <b>WhatsApp message</b> will be sent.</p>
            </div>

            {(formData.multi_advances || []).map((adv: any, index: number) => (
              <div key={adv.id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '10px', alignItems: 'end', marginBottom: '15px', background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '8px' }}>
                <div>
                  <label style={{ fontSize:'11px', color:'#3b82f6' }}>Pump {index + 1} Name</label>
                  <select className="modern-input" value={adv.pump_name} onChange={e=>handleAdvancePumpChange(adv.id, 'pump_name', e.target.value)}>
                    <option value="">-- Vendor --</option>
                    {(vendors || []).filter((v: any) => v.vendor_type?.includes('Fuel')).map((v: any) => <option key={v.id} value={v.vendor_name}>{v.vendor_name}</option>)}
                    {adv.pump_name && !(vendors || []).find((v: any)=>v.vendor_name === adv.pump_name) && <option value={adv.pump_name}>{adv.pump_name}</option>}
                  </select>
                </div>
                <div><label style={{ fontSize:'11px', color:'#f59e0b', fontWeight:'bold' }}>HSD (Ltr)</label><input type="number" className="modern-input" value={adv.hsd_qty} onChange={e=>handleAdvancePumpChange(adv.id, 'hsd_qty', e.target.value)} /></div>
                <div><label style={{ fontSize:'11px', color:'#10b981', fontWeight:'bold' }}>Cash (₹)</label><input type="number" className="modern-input" style={{ border: '1px solid #10b981' }} value={adv.cash} onChange={e=>handleAdvancePumpChange(adv.id, 'cash', e.target.value)} /></div>
                {(formData.multi_advances || []).length > 1 && (
                  <button onClick={() => handleRemoveAdvancePump(adv.id)} style={{ background: 'transparent', color: '#ef4444', border: 'none', cursor: 'pointer', fontSize: '20px', paddingBottom: '8px' }}>✕</button>
                )}
              </div>
            ))}

            <button onClick={handleAddAdvancePump} style={{ background: 'rgba(56,189,248,0.1)', color: '#38bdf8', border: '1px dashed #38bdf8', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', width: '100%', marginBottom: '20px' }}>+ Add Another Pump</button>

            <button className="glow-btn" style={{ width: '100%', padding: '15px', background: '#10b981', justifyContent: 'center' }} onClick={handleSaveAdvance}>✅ DISPATCH & SEND WHATSAPP INFO</button>
          </div>
        </div>
      )}

      {/* 🏁 MODAL 3: UNLOADING */}
      {modalType === 'UNLOADING' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #f59e0b', background: '#0f172a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, color: '#f59e0b' }}>📍 Step 3: Unloading</h3>
              <button onClick={closeAll} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ background: 'rgba(245,158,11,0.1)', padding: '10px', borderRadius: '10px', color: '#f59e0b', marginBottom: '15px', fontSize: '13px' }}>Loaded Qty was: <b>{formData.loaded_qty} Lts</b></div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Unloading Date</label><input type="date" className="modern-input" value={formData.unloading_date} onChange={e=>setFormData({...formData, unloading_date: e.target.value})} /></div>
              <div><label style={{ fontSize:'11px', color:'#f59e0b', fontWeight:'bold' }}>Actual Unloaded Qty (Liters) *</label><input type="number" className="modern-input" style={{ border: '1px solid #f59e0b' }} value={formData.unloaded_qty} onChange={e=>setFormData({...formData, unloaded_qty: e.target.value})} /></div>
              <div><label style={{ fontSize:'11px', color:'#ef4444' }}>Shortage Amount Deduction (₹)</label><input type="number" className="modern-input" placeholder="If any..." value={formData.shortage_amt} onChange={e=>setFormData({...formData, shortage_amt: e.target.value})} /></div>
            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', background: 'linear-gradient(135deg, #f59e0b, #d97706)', justifyContent: 'center' }} onClick={handleSaveUnloading}>📍 CONFIRM UNLOADING & STOP TRACKING</button>
          </div>
        </div>
      )}

      {/* 🤝 MODAL 4: SETTLEMENT */}
      {modalType === 'SETTLEMENT' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #c084fc', background: '#0f172a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, color: '#c084fc' }}>🤝 Step 4: Settlement & Driver Pay</h3>
              <button onClick={closeAll} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '10px', marginBottom: '20px', fontSize: '12px', color: '#cbd5e1', display: 'flex', flexDirection: 'column', gap: '5px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Gross Freight:</span> <b>₹{formData.gross_freight}</b></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ef4444' }}><span>- Cash Advance:</span> <b>₹{formData.advance_cash || 0}</b></div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ef4444' }}><span>- Shortage Amt:</span> <b>₹{formData.shortage_amt || 0}</b></div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'11px', color:'#f59e0b' }}>Company Toll / Expenses (₹)</label><input type="number" className="modern-input" value={formData.toll_amt} onChange={e=>setFormData({...formData, toll_amt: e.target.value})} /></div>
              
              <div style={{ background: 'rgba(56, 189, 248, 0.1)', padding: '15px', borderRadius: '10px', border: '1px dashed #38bdf8' }}>
                <label style={{ fontSize:'11px', color:'#38bdf8', fontWeight:'bold' }}>👨‍✈️ Driver's Trip Bhatta / Commission (₹)</label>
                <input type="number" className="modern-input" style={{ marginTop: '5px', border: '1px solid #38bdf8' }} placeholder="Will be credited to Driver's Khata" value={formData.driver_bhatta} onChange={e=>setFormData({...formData, driver_bhatta: e.target.value})} />
              </div>

              <div style={{ background: 'rgba(192, 132, 252, 0.1)', padding: '15px', borderRadius: '10px', border: '1px solid #c084fc' }}>
                <label style={{ fontSize:'11px', color:'#c084fc', fontWeight:'bold' }}>Company Net Payable (₹)</label>
                <div style={{ fontSize: '24px', fontWeight: 'bold', color: '#c084fc', marginTop: '5px' }}>
                  ₹{(parseFloat(formData.gross_freight || '0') - parseFloat(formData.advance_cash || '0') - parseFloat(formData.toll_amt || '0') - parseFloat(formData.shortage_amt || '0')).toFixed(2)}
                </div>
              </div>
            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '30px', padding: '15px', background: 'linear-gradient(135deg, #c084fc, #9333ea)', justifyContent: 'center' }} onClick={handleSaveSettlement}>✅ COMPLETE TRIP & PUSH TO BILLING</button>
          </div>
        </div>
      )}

    </div>
  );
}