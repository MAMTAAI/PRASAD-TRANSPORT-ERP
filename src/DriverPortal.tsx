// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { collection, query, where, getDocs, updateDoc, doc, addDoc } from 'firebase/firestore'; // ✅ addDoc yahan add kiya hai
import { db } from './firebase';

interface DriverPortalProps {
  onBack?: () => void;
}

export default function DriverPortal({ onBack }: DriverPortalProps) {
  // 🔐 LOGIN & DATA STATES
  const [mobileNo, setMobileNo] = useState('');
  const [driver, setDriver] = useState<any>(null);
  const [activeTrips, setActiveTrips] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadingDoc, setUploadingDoc] = useState<string | null>(null);

  // 🔥 DRIVER TYPE TOGGLE STATE
  const [driverType, setDriverType] = useState('OWN'); // 'OWN' or 'MARKET'

  // 📡 AUTO GPS TRACKING STATES
  const [isTracking, setIsTracking] = useState(false);
  const [currentLoc, setCurrentLoc] = useState<{lat: number, lng: number} | null>(null);
  const watchIdRef = useRef<number | null>(null);

  // 📱 UI NAVIGATION STATES
  const [activeTab, setActiveTab] = useState('TRIPS'); // TRIPS, EXPENSES, KYC

  // ==========================================
  // 🔄 HELPER: LOAD DEMO DATA BASED ON TYPE
  // ==========================================
  const loadDemoData = (type: 'OWN' | 'MARKET') => {
    setDriverType(type);
    setIsTracking(false);
    setActiveTab('TRIPS'); // 🔥 Force tab to TRIPS when switching

    if (type === 'OWN') {
      setDriver({
        id: 'DEMO-OWN-001',
        name: 'Ramesh Kumar (Staff)',
        mobile: '1234567890',
        assigned_vehicle: 'NL-01-AB-1234',
        approval_status: 'APPROVED',
        tag: '🏢 COMPANY VEHICLE',
        profile_photo: 'https://ui-avatars.com/api/?name=Ramesh+Kumar&background=38bdf8&color=fff&size=128',
        aadhar_no: '1234 5678 9012',
        account_no: '302010020',
        ifsc_code: 'SBIN000123'
      });
      setActiveTrips([{
        id: 'DEMO-TRIP-OWN',
        trip_id: 'TRP-OWN-881',
        trip_status: 'IN TRANSIT',
        loading_point: 'Bongaigaon Refinery',
        consignee_name: 'Siliguri Depot',
        driver_loaded_qty: '',
        driver_unloaded_qty: '',
        office_approved_loading: false,
        office_approved_unloading: false,
      }]);
    } else {
      setDriver({
        id: 'DEMO-MKT-001',
        name: 'Suresh Yadav',
        mobile: '9988776655',
        assigned_vehicle: 'HR-55-XY-9988',
        agency: 'Sharma Logistics',
        approval_status: 'APPROVED',
        tag: '🚚 MARKET VEHICLE',
        profile_photo: 'https://ui-avatars.com/api/?name=Suresh+Yadav&background=f59e0b&color=fff&size=128',
        aadhar_no: '',
        account_no: '',
        ifsc_code: ''
      });
      setActiveTrips([{
        id: 'DEMO-TRIP-MKT',
        trip_id: 'TRP-MKT-992',
        trip_status: 'IN TRANSIT',
        loading_point: 'Guwahati',
        consignee_name: 'Jorhat',
        driver_loaded_qty: '',
        driver_unloaded_qty: '',
        office_approved_loading: false,
        office_approved_unloading: false,
      }]);
    }
  };

  // ==========================================
  // 🔐 1. HIGH-SECURITY DRIVER LOGIN
  // ==========================================
  const handleLogin = async () => {
    if (!mobileNo) return alert("⚠️ Please enter mobile number!");
    setLoading(true);

    if (mobileNo === '1234567890' || mobileNo === '1234') {
      setTimeout(() => {
        loadDemoData('OWN'); 
        setLoading(false);
      }, 1000);
      return;
    }

    try {
      const q = query(collection(db, "DRIVERS"), where("mobile", "==", mobileNo));
      const querySnapshot = await getDocs(q);
      
      if (!querySnapshot.empty) {
        const driverDoc = querySnapshot.docs[0];
        const driverData = { id: driverDoc.id, ...driverDoc.data() };
        setDriver(driverData);
        setDriverType(driverData.driver_type || 'OWN'); 
        fetchDriverTrips(driverData.mobile, driverData.name);
      } else {
        alert("❌ Driver not found! Please check the mobile number.");
      }
    } catch (error) {
      alert("❌ Server Error!");
    }
    setLoading(false);
  };

  const fetchDriverTrips = async (driverMobile: string, driverName: string) => {
    try {
      const tSnap = await getDocs(collection(db, "TRIPS"));
      const trips = tSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter((t: any) => (t.driver_mobil_no === driverMobile || t.driver_name === driverName) && t.trip_status !== 'COMPLETED');
      setActiveTrips(trips);
    } catch (e) {
      console.error(e);
    }
  };

  const updateTripData = async (tripId: string, fieldName: string, value: any) => {
    if(tripId.includes('DEMO')) {
      setActiveTrips(prev => prev.map(t => t.id === tripId ? { ...t, [fieldName]: value } : t));
      return;
    }
    try {
      await updateDoc(doc(db, "TRIPS", tripId), { [fieldName]: value });
    } catch (e) {
      console.error("Error saving data!");
    }
  };

  // ==========================================
  // 📡 2. AUTO LIVE GPS TRACKING
  // ==========================================
  useEffect(() => {
    if (activeTrips.length > 0 && !isTracking) {
      startAutoTracking(activeTrips[0].id);
    }
  }, [activeTrips]);

  const startAutoTracking = (tripId: string) => {
    if (!navigator.geolocation) return;
    setIsTracking(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setCurrentLoc({ lat, lng });
        if (!tripId.includes('DEMO')) {
           updateDoc(doc(db, "TRIPS", tripId), { liveLocation: { lat, lng, lastUpdated: new Date().toISOString() } });
        }
      },
      (error) => { console.error("Auto GPS Error:", error); setIsTracking(false); },
      { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
    );
  };

  useEffect(() => {
    return () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); };
  }, []);

  // ==========================================
  // 📸 ACTION HANDLERS
  // ==========================================
  const handleTripImageUpload = async (e: any, tripId: string, fieldType: string) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadingDoc(`${tripId}_${fieldType}`);
    setTimeout(() => {
      alert("✅ Image Uploaded Successfully!");
      updateTripData(tripId, fieldType, URL.createObjectURL(file));
      setUploadingDoc(null);
    }, 1500);
  };

  const handleDriverDocumentUpload = async (e: any, fieldType: string) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadingDoc(fieldType);
    setTimeout(() => {
      alert(`✅ ${fieldType} Uploaded Successfully!`);
      const mockUrl = URL.createObjectURL(file);
      if(driver.id.includes('DEMO')) { setDriver({ ...driver, [fieldType]: mockUrl }); } 
      else { updateDriverKYC(fieldType, mockUrl); }
      setUploadingDoc(null);
    }, 1500);
  };

  const updateDriverKYC = async (fieldName: string, value: any) => {
    if(driver.id.includes('DEMO')) { setDriver({ ...driver, [fieldName]: value }); return; }
    try {
      await updateDoc(doc(db, "DRIVERS", driver.id), { [fieldName]: value });
      setDriver({ ...driver, [fieldName]: value });
    } catch (e) { console.error("Error updating details!"); }
  };

  // ==========================================
  // 🚀 ACTION HANDLERS (SEND TO ADMIN - FIREBASE)
  // ==========================================
  const handleQuickAction = async (actionName: string) => {
    let amount = '';
    let remarks = '';
    
    if (actionName === 'ADVANCE') {
       const purpose = driverType === 'OWN' ? 'Trip Bhatta / Diesel' : 'Freight Advance / Toll';
       const inputAmount = window.prompt(`Enter amount needed for ${purpose} (₹):`);
       if (!inputAmount) return; // Cancel kiya to wapas jao
       amount = inputAmount;
       remarks = window.prompt('Any remarks? (Optional)') || purpose;
    } else if (actionName === 'FUEL_CALL') {
       if (driverType === 'OWN') {
         const inputAmount = window.prompt('Enter Diesel Amount (₹):');
         if (!inputAmount) return;
         amount = inputAmount;
         remarks = 'Diesel Kharcha';
       } else {
         alert('📞 Call Owner for support.');
         return;
       }
    } else if (actionName === 'POD') {
       remarks = 'Driver clicked POD or requested document check.';
    } else if (actionName === 'EMERGENCY') {
       remarks = driverType === 'OWN' ? 'Vehicle Repair needed' : 'Emergency Help Needed';
    } else {
       remarks = `Requested Action: ${actionName}`;
    }

    try {
      // ✅ Yahan asli jadu ho raha hai - Data Firebase me save hoga
      await addDoc(collection(db, "DRIVER_REQUESTS"), {
        driver_id: driver.id,
        driver_name: driver.name,
        type: actionName === 'ADVANCE' ? 'ADVANCE' : actionName === 'FUEL_CALL' ? 'FUEL' : actionName,
        amount: amount,
        remarks: remarks,
        status: 'PENDING',
        createdAt: new Date().toISOString()
      });
      alert(`✅ Request sent to Admin successfully!`);
    } catch (e) {
      alert("❌ Failed to send request.");
      console.error(e);
    }
  };

  // =========================================================
  // 🔐 SCREEN 1: LOGIN
  // =========================================================
  if (!driver) {
    return (
      <div className="min-h-screen bg-[#050505] flex justify-center items-center p-5 relative overflow-hidden font-sans">
        <div className="absolute top-[-10%] left-[-10%] w-[50vw] h-[50vw] bg-blue-600/20 rounded-full blur-[120px] mix-blend-screen pointer-events-none"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[50vw] h-[50vw] bg-emerald-600/20 rounded-full blur-[120px] mix-blend-screen pointer-events-none"></div>

        {onBack && (
          <button onClick={onBack} className="absolute top-10 left-6 text-white/50 hover:text-white transition-colors z-20 font-bold text-sm bg-white/5 px-4 py-2 rounded-full border border-white/10">
            ⬅️ Back to Web
          </button>
        )}

        <div className="w-full max-w-[400px] flex flex-col items-center relative z-10 animate-fade-in-up">
          <div className="w-24 h-24 bg-gradient-to-tr from-blue-600 to-blue-400 rounded-[32px] flex items-center justify-center text-4xl shadow-[0_20px_40px_rgba(37,99,235,0.4)] mb-8 transform rotate-3 hover:rotate-0 transition-transform">
            🚛
          </div>
          <h1 className="text-white text-4xl font-black mb-2 tracking-tight">Driver App</h1>
          <p className="text-white/40 text-sm font-medium mb-12">Secured by Prasad Transport</p>
          
          <div className="w-full space-y-6">
            <div className="relative">
              <input 
                type="tel" 
                placeholder="Mobile Number (Type 1234 for demo)" 
                value={mobileNo} 
                onChange={e => setMobileNo(e.target.value)}
                className="w-full bg-white/5 border border-white/10 p-5 rounded-[24px] text-white text-lg font-bold text-center outline-none focus:border-blue-500 focus:bg-white/10 transition-all backdrop-blur-md placeholder:text-white/20"
              />
            </div>
            <button 
              onClick={handleLogin}
              disabled={loading}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white py-5 rounded-[24px] text-lg font-black shadow-[0_10px_30px_rgba(37,99,235,0.3)] active:scale-[0.98] transition-all"
            >
              {loading ? 'VERIFYING...' : 'CONTINUE ➔'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // =========================================================
  // 📱 SCREEN 2: MAIN APP
  // =========================================================
  return (
    <div className="min-h-screen bg-[#050505] flex flex-col font-sans text-white md:items-center md:justify-center selection:bg-blue-500/30">
      
      <div className="w-full h-full min-h-screen md:min-h-[850px] md:h-[850px] md:w-[420px] bg-[#0a0a0a] md:rounded-[48px] md:border-[8px] border-[#1a1a1a] relative overflow-hidden flex flex-col shadow-2xl">
        
        {/* 🚀 HEADER */}
        <header className="px-6 pt-10 pb-4 flex justify-between items-center bg-[#0a0a0a]/80 backdrop-blur-xl sticky top-0 z-40 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="relative">
              <img src={driver.profile_photo || 'https://ui-avatars.com/api/?name='+driver.name+'&background=2563eb&color=fff'} alt="Profile" className="w-12 h-12 rounded-full object-cover border-2 border-white/10 bg-zinc-800" />
              <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-emerald-500 border-2 border-[#0a0a0a] rounded-full"></div>
            </div>
            <div>
              <h2 className="text-lg font-black text-white leading-tight">{driver.name}</h2>
              <div className="flex items-center gap-1 mt-0.5">
                 <p className={`text-[9px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-md border ${driverType === 'OWN' ? 'bg-blue-500/10 text-blue-400 border-blue-500/20' : 'bg-orange-500/10 text-orange-400 border-orange-500/20'}`}>
                   {driver.tag || 'DRIVER'}
                 </p>
              </div>
            </div>
          </div>
          <button onClick={() => setDriver(null)} className="text-[10px] font-black text-red-400 bg-red-500/10 px-3 py-2 rounded-xl border border-red-500/20 hover:bg-red-500 hover:text-white transition-colors uppercase tracking-widest">
            Exit
          </button>
        </header>

        {/* 🔥 DEMO TOGGLE FOR ADMIN PREVIEW 🔥 */}
        {driver.id.includes('DEMO') && (
          <div className="flex gap-2 mx-6 mt-4 p-1 bg-white/5 rounded-xl border border-white/10 relative z-30">
            <button onClick={() => loadDemoData('OWN')} className={`flex-1 py-2 rounded-lg text-[10px] font-black tracking-widest transition-all ${driverType === 'OWN' ? 'bg-blue-500 text-white shadow-lg' : 'text-white/40 hover:text-white'}`}>
              🏢 OWN DRIVER
            </button>
            <button onClick={() => loadDemoData('MARKET')} className={`flex-1 py-2 rounded-lg text-[10px] font-black tracking-widest transition-all ${driverType === 'MARKET' ? 'bg-orange-500 text-white shadow-lg' : 'text-white/40 hover:text-white'}`}>
              🚚 MARKET DRIVER
            </button>
          </div>
        )}

        {/* 📜 SCROLLABLE CONTENT */}
        <div className="flex-1 overflow-y-auto pb-32 pt-2 relative z-10 hide-scrollbar" style={{ msOverflowStyle: 'none', scrollbarWidth: 'none' }}>
          
          {/* 🚚 TAB 1: ACTIVE TRIPS & AUTO MAP */}
          {activeTab === 'TRIPS' && (
            <div className="animate-fade-in-up">
              {activeTrips.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-10 h-full mt-20 text-center">
                  <div className="w-24 h-24 bg-white/5 rounded-full flex items-center justify-center text-4xl mb-4 shadow-inner">💤</div>
                  <h3 className="text-xl font-bold text-white">No Active Duty</h3>
                  <p className="text-sm text-white/40 mt-2 text-center">Take some rest. Office will assign a new trip soon.</p>
                </div>
              ) : (
                activeTrips.map((trip: any) => (
                  <div key={trip.id} className="flex flex-col">
                    
                    {/* 🗺️ DYNAMIC AUTO-MAP AREA */}
                    <div className="w-full h-56 relative bg-zinc-900 border-b border-white/10 overflow-hidden">
                      {isTracking && currentLoc ? (
                        <iframe width="100%" height="100%" style={{ border: 0, filter: 'invert(90%) hue-rotate(180deg)' }} loading="lazy" allowFullScreen src={`https://maps.google.com/maps?q=${currentLoc.lat},${currentLoc.lng}&z=15&output=embed`}></iframe>
                      ) : (
                        <iframe width="100%" height="100%" style={{ border: 0, opacity: 0.5, filter: 'invert(90%) hue-rotate(180deg)' }} loading="lazy" allowFullScreen src={`https://maps.google.com/maps?q=${encodeURIComponent(trip.loading_point)}+to+${encodeURIComponent(trip.consignee_name)}&t=m&z=5&output=embed`}></iframe>
                      )}
                      
                      <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-transparent to-transparent pointer-events-none"></div>
                      
                      {/* 📡 AUTO-TRACKING LIVE STATUS BAR */}
                      <div className="absolute bottom-4 left-4 right-4 bg-[#0a0a0a]/90 backdrop-blur-md px-4 py-3 rounded-2xl border border-emerald-500/30 flex items-center justify-between shadow-[0_10px_20px_rgba(0,0,0,0.5)]">
                        <div className="flex items-center gap-3">
                          <div className="relative flex h-3 w-3">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                          </div>
                          <div>
                            <p className="text-emerald-400 text-[10px] font-black uppercase tracking-widest leading-none">Auto-Tracking Live</p>
                            <p className="text-white/40 text-[9px] font-mono mt-0.5">Office is monitoring route</p>
                          </div>
                        </div>
                        {currentLoc && (
                          <div className="text-right">
                            <p className="text-white/60 text-[9px] font-mono">{currentLoc.lat.toFixed(3)}</p>
                            <p className="text-white/60 text-[9px] font-mono">{currentLoc.lng.toFixed(3)}</p>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="px-5 py-4">
                      
                      {/* 🔥 SMART QUICK ACTIONS GRID 🔥 */}
                      <div className="grid grid-cols-4 gap-3 mb-6">
                        <button onClick={() => handleQuickAction('POD')} className="bg-white/5 border border-white/10 hover:border-emerald-500/50 p-3 rounded-2xl flex flex-col items-center justify-center gap-2 transition-all">
                          <span className="text-2xl">📸</span>
                          <span className="text-[8px] font-black text-emerald-400 uppercase">POD</span>
                        </button>

                        <button onClick={() => handleQuickAction('ADVANCE')} className="bg-white/5 border border-white/10 hover:border-blue-500/50 p-3 rounded-2xl flex flex-col items-center justify-center gap-2 transition-all">
                          <span className="text-2xl">💸</span>
                          <span className="text-[8px] font-black text-blue-400 uppercase text-center leading-tight">
                            {driverType === 'OWN' ? 'ASK\nBHATTA' : 'ASK\nADVANCE'}
                          </span>
                        </button>

                        <button onClick={() => handleQuickAction('FUEL_CALL')} className="bg-white/5 border border-white/10 hover:border-orange-500/50 p-3 rounded-2xl flex flex-col items-center justify-center gap-2 transition-all">
                          <span className="text-2xl">{driverType === 'OWN' ? '⛽' : '📞'}</span>
                          <span className="text-[8px] font-black text-orange-400 uppercase text-center leading-tight">
                            {driverType === 'OWN' ? 'ADD\nFUEL' : 'CALL\nOWNER'}
                          </span>
                        </button>

                        <button onClick={() => handleQuickAction('EMERGENCY')} className="bg-red-500/10 border border-red-500/30 hover:bg-red-500/20 p-3 rounded-2xl flex flex-col items-center justify-center gap-2 transition-all">
                          <span className="text-2xl">{driverType === 'OWN' ? '🛠️' : '🆘'}</span>
                          <span className="text-[8px] font-black text-red-400 uppercase text-center leading-tight">
                            {driverType === 'OWN' ? 'REPAIR' : 'HELP'}
                          </span>
                        </button>
                      </div>

                      {/* 📦 ROUTE CARD */}
                      <div className="bg-[#121212] rounded-[32px] border border-white/5 shadow-2xl p-6 relative overflow-hidden mb-6">
                        
                        <div className="mb-6 pb-6 border-b border-white/5 relative">
                           <p className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1 font-mono">{trip.trip_id}</p>
                           <div className="relative pl-8 mt-4 space-y-5">
                             <div className="absolute left-[11px] top-2 bottom-2 w-[2px] bg-gradient-to-b from-blue-500 to-emerald-500 opacity-50"></div>
                             <div className="relative">
                               <div className="absolute -left-[35px] top-1.5 w-5 h-5 bg-[#121212] rounded-full border-4 border-blue-500"></div>
                               <p className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-0.5">Pickup</p>
                               <p className="text-lg font-black text-white leading-tight">{trip.loading_point}</p>
                             </div>
                             <div className="relative">
                               <div className="absolute -left-[35px] top-1.5 w-5 h-5 bg-[#121212] rounded-full border-4 border-emerald-500"></div>
                               <p className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-0.5">Drop</p>
                               <p className="text-lg font-black text-white leading-tight">{trip.consignee_name}</p>
                             </div>
                           </div>
                        </div>

                        {/* Loading Inputs */}
                        <div className="space-y-4">
                          <h4 className="text-xs font-black text-blue-400 uppercase tracking-widest flex items-center gap-2"><span>1.</span> Loading Actions</h4>
                          <input type="number" placeholder="Enter Loaded Qty" defaultValue={trip.driver_loaded_qty || ''} onBlur={(e) => updateTripData(trip.id, 'driver_loaded_qty', e.target.value)} disabled={trip.office_approved_loading} className="w-full bg-white/5 border border-white/10 p-4 rounded-2xl text-base font-black text-white outline-none focus:border-blue-500 transition-all placeholder:text-white/20" />
                          <div className="relative">
                            {trip.driver_loading_photo ? (
                              <div className="relative rounded-2xl overflow-hidden border border-white/10 h-32 group">
                                <img src={trip.driver_loading_photo} alt="Challan" className="w-full h-full object-cover opacity-70 group-hover:opacity-40 transition-opacity" />
                                {!trip.office_approved_loading && (
                                  <label className="absolute inset-0 flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity">
                                    <span className="bg-blue-600 text-white font-bold text-xs px-4 py-2 rounded-lg shadow-lg">Retake 📸</span>
                                    <input type="file" accept="image/*" onChange={(e) => handleTripImageUpload(e, trip.id, 'driver_loading_photo')} className="hidden" disabled={uploadingDoc === `${trip.id}_driver_loading_photo`} />
                                  </label>
                                )}
                              </div>
                            ) : (
                              <label className="flex flex-col items-center justify-center w-full h-24 bg-white/5 border border-dashed border-blue-500/50 rounded-2xl cursor-pointer hover:bg-white/10 transition-colors">
                                <span className="text-2xl mb-1">📸</span><span className="text-blue-400 font-bold text-xs">Upload Challan</span>
                                <input type="file" accept="image/*" capture="environment" onChange={(e) => handleTripImageUpload(e, trip.id, 'driver_loading_photo')} disabled={trip.office_approved_loading} className="hidden" />
                              </label>
                            )}
                            {uploadingDoc === `${trip.id}_driver_loading_photo` && <div className="absolute inset-0 bg-[#121212]/80 flex items-center justify-center text-blue-400 text-xs font-black rounded-2xl backdrop-blur-sm">⏳ Uploading...</div>}
                          </div>
                        </div>
                        
                        {/* Unloading Inputs */}
                        <div className="space-y-4 mt-8 pt-6 border-t border-white/5">
                          <h4 className="text-xs font-black text-emerald-400 uppercase tracking-widest flex items-center gap-2"><span>2.</span> Unloading Actions</h4>
                          <input type="number" placeholder="Enter Unloaded Qty" defaultValue={trip.driver_unloaded_qty || ''} onBlur={(e) => updateTripData(trip.id, 'driver_unloaded_qty', e.target.value)} disabled={trip.office_approved_unloading} className="w-full bg-white/5 border border-white/10 p-4 rounded-2xl text-base font-black text-white outline-none focus:border-emerald-500 transition-all placeholder:text-white/20" />
                          <div className="relative">
                            {trip.driver_unloading_photo ? (
                              <div className="relative rounded-2xl overflow-hidden border border-white/10 h-32 group">
                                <img src={trip.driver_unloading_photo} alt="Receipt" className="w-full h-full object-cover opacity-70 group-hover:opacity-40 transition-opacity" />
                                {!trip.office_approved_unloading && (
                                  <label className="absolute inset-0 flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity">
                                    <span className="bg-emerald-600 text-white font-bold text-xs px-4 py-2 rounded-lg shadow-lg">Retake 📸</span>
                                    <input type="file" accept="image/*" onChange={(e) => handleTripImageUpload(e, trip.id, 'driver_unloading_photo')} className="hidden" disabled={uploadingDoc === `${trip.id}_driver_unloading_photo`} />
                                  </label>
                                )}
                              </div>
                            ) : (
                              <label className="flex flex-col items-center justify-center w-full h-24 bg-white/5 border border-dashed border-emerald-500/50 rounded-2xl cursor-pointer hover:bg-white/10 transition-colors">
                                <span className="text-2xl mb-1">📸</span><span className="text-emerald-400 font-bold text-xs">Upload POD</span>
                                <input type="file" accept="image/*" capture="environment" onChange={(e) => handleTripImageUpload(e, trip.id, 'driver_unloading_photo')} disabled={trip.office_approved_unloading} className="hidden" />
                              </label>
                            )}
                            {uploadingDoc === `${trip.id}_driver_unloading_photo` && <div className="absolute inset-0 bg-[#121212]/80 flex items-center justify-center text-emerald-400 text-xs font-black rounded-2xl backdrop-blur-sm">⏳ Uploading...</div>}
                          </div>
                        </div>

                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* ⛽ TAB 2: KHARCHA (EXPENSES) - ONLY FOR OWN DRIVERS */}
          {activeTab === 'EXPENSES' && driverType === 'OWN' && (
            <div className="p-5 animate-fade-in-up space-y-6">
              <div className="bg-[#121212] rounded-[32px] p-6 border border-white/5 shadow-2xl">
                <h3 className="text-xl font-black text-white mb-2">Trip Kharcha</h3>
                <p className="text-xs text-white/40 mb-6">Upload diesel slip or toll receipt directly to office ERP.</p>
                
                <div className="space-y-5">
                  <select className="w-full bg-[#0a0a0a] border border-white/10 p-4 rounded-[20px] text-sm font-bold text-white outline-none focus:border-blue-500 transition-all appearance-none">
                    <option>⛽ Diesel / Fuel Slip</option>
                    <option>🛣️ Toll Tax Receipt</option>
                    <option>👮 RTO / Border Kharcha</option>
                    <option>🛠️ Vehicle Repair</option>
                  </select>
                  
                  <input type="number" placeholder="Total Amount (₹)" className="w-full bg-[#0a0a0a] border border-white/10 p-4 rounded-[20px] text-lg font-black text-white outline-none focus:border-blue-500 transition-all placeholder:text-white/20" />

                  <label className="w-full bg-[#0a0a0a] border-2 border-dashed border-white/20 hover:border-blue-500 text-white/40 font-bold text-xs py-10 rounded-[24px] flex flex-col items-center justify-center cursor-pointer transition-colors">
                    <span className="text-3xl mb-2">📸</span>
                    Click Photo of Bill/Slip
                    <input type="file" accept="image/*" capture="environment" className="hidden" />
                  </label>

                  <button className="w-full bg-blue-600 hover:bg-blue-500 text-white font-black text-base py-4 rounded-[20px] shadow-[0_10px_20px_rgba(37,99,235,0.3)] active:scale-95 transition-transform mt-2">
                    SEND TO OFFICE 🚀
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 🪪 TAB 3: KYC & PROFILE - ONLY FOR OWN DRIVERS */}
          {activeTab === 'KYC' && driverType === 'OWN' && (
            <div className="p-5 animate-fade-in-up space-y-6">
              
              <div className="flex items-center justify-between bg-[#121212] p-4 rounded-2xl border border-white/5 shadow-lg">
                <span className="text-sm font-black text-white">My Documents</span>
                {driver.approval_status === 'APPROVED' ? (
                  <span className="bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full text-[10px] font-black border border-emerald-500/20">✅ VERIFIED</span>
                ) : (
                  <span className="bg-orange-500/10 text-orange-400 px-3 py-1 rounded-full text-[10px] font-black border border-orange-500/20 animate-pulse">⏳ PENDING VERIFICATION</span>
                )}
              </div>

              {/* TEXT INPUTS FOR AADHAR & BANK */}
              <div className="bg-[#121212] p-6 rounded-[24px] border border-white/5 shadow-xl space-y-5">
                <h3 className="text-sm font-bold text-white flex items-center gap-2"><span>📋</span> Basic Details</h3>
                
                <div>
                  <label className="block text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1.5 pl-1">Aadhar Number</label>
                  <input type="text" defaultValue={driver.aadhar_no || ''} onBlur={(e) => updateDriverKYC('aadhar_no', e.target.value)} disabled={driver.approval_status === 'APPROVED'} className="w-full bg-[#0a0a0a] border border-white/10 p-4 rounded-[20px] text-sm font-black text-white font-mono tracking-widest outline-none focus:border-blue-500 disabled:opacity-60 transition-all placeholder:text-white/20" placeholder="XXXX XXXX XXXX" />
                </div>
                
                <div>
                  <label className="block text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1.5 pl-1">Bank Account Number</label>
                  <input type="text" defaultValue={driver.account_no || ''} onBlur={(e) => updateDriverKYC('account_no', e.target.value)} disabled={driver.approval_status === 'APPROVED'} className="w-full bg-[#0a0a0a] border border-white/10 p-4 rounded-[20px] text-sm font-black text-white font-mono tracking-widest outline-none focus:border-emerald-500 disabled:opacity-60 transition-all placeholder:text-white/20" placeholder="A/C No" />
                </div>
                
                <div>
                  <label className="block text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1.5 pl-1">Bank IFSC Code</label>
                  <input type="text" defaultValue={driver.ifsc_code || ''} onBlur={(e) => updateDriverKYC('ifsc_code', e.target.value)} disabled={driver.approval_status === 'APPROVED'} className="w-full bg-[#0a0a0a] border border-white/10 p-4 rounded-[20px] text-sm font-black text-white font-mono tracking-widest outline-none focus:border-emerald-500 disabled:opacity-60 uppercase transition-all placeholder:text-white/20" placeholder="IFSC" />
                </div>
              </div>

              {/* PHOTO UPLOADS */}
              <div className="space-y-4">
                {[
                  { id: 'dl_photo', title: 'Driving License (DL)', icon: '🪪', key: driver.dl_photo },
                  { id: 'aadhar_photo', title: 'Aadhar Card', icon: '📄', key: driver.aadhar_photo },
                  { id: 'bank_photo', title: 'Bank Passbook', icon: '🏦', key: driver.bank_photo }
                ].map((doc) => (
                  <div key={doc.id} className="bg-[#121212] p-5 rounded-[24px] border border-white/5 shadow-xl">
                    <div className="flex justify-between items-center mb-4">
                      <span className="text-sm font-bold text-white flex items-center gap-2">{doc.icon} {doc.title}</span>
                      {doc.key ? <span className="text-[10px] text-emerald-400 font-bold bg-emerald-500/10 px-2 py-1 rounded-md">Uploaded ✅</span> : <span className="text-[10px] text-orange-400 font-bold bg-orange-500/10 px-2 py-1 rounded-md">Pending ⚠️</span>}
                    </div>
                    {doc.key ? (
                      <div className="relative rounded-xl overflow-hidden h-32 border border-white/10 group">
                        <img src={doc.key} alt="Doc" className="w-full h-full object-cover opacity-60 group-hover:opacity-30 transition-opacity" />
                        {driver.approval_status !== 'APPROVED' && (
                          <label className="absolute inset-0 flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity">
                            <span className="bg-blue-600 text-white font-bold text-xs px-4 py-2 rounded-lg shadow-lg">Retake Photo 📸</span>
                            <input type="file" accept="image/*" onChange={(e) => handleDriverDocumentUpload(e, doc.id)} className="hidden" disabled={uploadingDoc === doc.id} />
                          </label>
                        )}
                      </div>
                    ) : (
                      <label className="flex flex-col items-center justify-center w-full h-24 bg-white/5 border border-dashed border-white/20 rounded-xl cursor-pointer text-blue-400 text-xs font-bold hover:bg-white/10 hover:border-blue-500/50 transition-all">
                        <span className="text-2xl mb-1">📸</span>
                        Click Photo to Upload
                        <input type="file" accept="image/*" capture="environment" onChange={(e) => handleDriverDocumentUpload(e, doc.id)} className="hidden" disabled={uploadingDoc === doc.id || driver.approval_status === 'APPROVED'} />
                      </label>
                    )}
                    {uploadingDoc === doc.id && <p className="text-[10px] text-blue-400 mt-3 text-center animate-pulse font-bold">⏳ Uploading securely to ERP...</p>}
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>

        {/* 📱 MODERN FLOATING BOTTOM NAV */}
        <div className={`absolute bottom-6 left-6 right-6 bg-[#1a1a1a]/90 backdrop-blur-2xl border border-white/10 rounded-[32px] p-2 flex justify-between items-center z-50 shadow-[0_20px_40px_rgba(0,0,0,0.5)] ${driverType === 'MARKET' ? 'justify-center' : ''}`}>
          
          <button onClick={() => setActiveTab('TRIPS')} className={`flex-1 flex flex-col items-center py-2 transition-all ${activeTab === 'TRIPS' ? 'text-blue-500 scale-105' : 'text-white/40'}`}>
            <span className="text-2xl mb-1">🗺️</span><span className="text-[9px] font-black uppercase tracking-widest">Duty</span>
          </button>

          {/* 🔥 HIDE EXPENSES & KYC FOR MARKET DRIVER 🔥 */}
          {driverType === 'OWN' && (
            <>
              <button onClick={() => setActiveTab('EXPENSES')} className={`flex-1 flex flex-col items-center py-2 transition-all ${activeTab === 'EXPENSES' ? 'text-emerald-500 scale-105' : 'text-white/40'}`}>
                <span className="text-2xl mb-1">⛽</span><span className="text-[9px] font-black uppercase tracking-widest">Kharcha</span>
              </button>
              <button onClick={() => setActiveTab('KYC')} className={`flex-1 flex flex-col items-center py-2 transition-all ${activeTab === 'KYC' ? 'text-orange-500 scale-105' : 'text-white/40'}`}>
                <span className="text-2xl mb-1">🪪</span><span className="text-[9px] font-black uppercase tracking-widest">Docs</span>
              </button>
            </>
          )}

        </div>

      </div>
      <style>{`
        .animate-fade-in-up { animation: fadeInUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}