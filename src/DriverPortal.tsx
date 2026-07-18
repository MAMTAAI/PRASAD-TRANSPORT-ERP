// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { collection, query, where, getDocs, updateDoc, doc, addDoc, or } from 'firebase/firestore'; // ✅ addDoc yahan add kiya hai
import { db } from './firebase';
import { uploadMedia, slug } from './lib/uploadMedia';
import BottomSheet from './ui/BottomSheet';

const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');
// Request status → Hindi chip (the driver finally SEES what happened to his request)
const REQ_STATUS = {
  PENDING:  { label: '📨 भेजा गया', color: '#f59e0b' },
  APPROVED: { label: '✅ मंज़ूर', color: '#38bdf8' },
  PAID:     { label: '💰 मिल गया', color: '#10b981' },
  REJECTED: { label: '❌ रद्द', color: '#ef4444' },
};

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
  const lastPingRef = useRef<{ t: number, lat: number, lng: number } | null>(null);

  // 📱 UI NAVIGATION STATES
  const [activeTab, setActiveTab] = useState('TRIPS'); // TRIPS, EXPENSES, KYC

  // 💸 Money-request sheet (replaces window.prompt) + driver's own data
  const [askSheet, setAskSheet] = useState(null); // {type, title} | null
  const [askAmount, setAskAmount] = useState('');
  const [askRemarks, setAskRemarks] = useState('');
  const [sendingReq, setSendingReq] = useState(false);
  const [myRequests, setMyRequests] = useState([]);
  const [khataTxns, setKhataTxns] = useState([]);
  // ⛽ Kharcha (expense) form — was dead UI with no handlers at all
  const [expType, setExpType] = useState('⛽ Diesel / Fuel Slip');
  const [expAmount, setExpAmount] = useState('');
  const [expFile, setExpFile] = useState(null);
  const [sendingExp, setSendingExp] = useState(false);

  const fetchDriverExtras = async (drv) => {
    if (!drv || String(drv.id).includes('DEMO')) return;
    try {
      const [reqSnap, txnSnap] = await Promise.all([
        getDocs(query(collection(db, 'DRIVER_REQUESTS'), where('driver_name', '==', drv.name))).catch(() => ({ docs: [] })),
        getDocs(query(collection(db, 'DRIVER_TRANSACTIONS'), where('driver_name', '==', drv.name))).catch(() => ({ docs: [] })),
      ]);
      setMyRequests(reqSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 20));
      setKhataTxns(txnSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
  };
  useEffect(() => { if (driver) fetchDriverExtras(driver); }, [driver?.id]);

  // खाता summary: paisa mila (advances/payments TO driver) — office se hisaab
  const khataGiven = khataTxns.filter(t => ['ADVANCE_GIVEN', 'PAYMENT_GIVEN'].includes(t.txn_type)).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);
  const khataRecovered = khataTxns.filter(t => !['ADVANCE_GIVEN', 'PAYMENT_GIVEN'].includes(t.txn_type)).reduce((s, t) => s + (parseFloat(t.amount) || 0), 0);

  const sendRequest = async (type, amount, remarks) => {
    setSendingReq(true);
    try {
      await addDoc(collection(db, 'DRIVER_REQUESTS'), {
        driver_id: driver.id, driver_name: driver.name,
        type, amount: String(amount || ''), remarks: remarks || '',
        status: 'PENDING', createdAt: new Date().toISOString(),
      });
      alert('✅ Request office ko chali gayi! Status "खाता" tab me dikhega.');
      setAskSheet(null); setAskAmount(''); setAskRemarks('');
      fetchDriverExtras(driver);
    } catch (e) { console.error(e); alert('❌ Request nahi gayi — network check karke dobara try karein.'); }
    setSendingReq(false);
  };

  // ⛽ REAL expense submit (photo → Storage, request → office approval queue)
  const submitExpense = async () => {
    const amt = parseFloat(expAmount);
    if (!Number.isFinite(amt) || amt <= 0) return alert('⚠️ Sahi amount daalein!');
    setSendingExp(true);
    try {
      let billUrl = '';
      if (expFile) {
        const { url } = await uploadMedia(expFile, `driver-expenses/${slug(driver.id)}/${Date.now()}.jpg`);
        billUrl = url;
      }
      await addDoc(collection(db, 'DRIVER_REQUESTS'), {
        driver_id: driver.id, driver_name: driver.name,
        type: 'EXPENSE', amount: String(amt), remarks: expType,
        bill_photo: billUrl, status: 'PENDING', createdAt: new Date().toISOString(),
      });
      alert('✅ Kharcha office ko pahunch gaya! Approval ke baad khata me judega.');
      setExpAmount(''); setExpFile(null);
      fetchDriverExtras(driver);
    } catch (e) { console.error(e); alert('❌ Nahi gaya — network check karke dobara try karein.'); }
    setSendingExp(false);
  };

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
      // 🔐 Server-side scoped query: only THIS driver's trips leave the server.
      // The old full-collection fetch downloaded the whole company's trip
      // history (all customers, all rates) onto every driver's phone.
      const clauses = [];
      if (driverMobile) clauses.push(where('driver_mobil_no', '==', driverMobile));
      if (driverName) clauses.push(where('driver_name', '==', driverName));
      if (!clauses.length) { setActiveTrips([]); return; }
      const tSnap = await getDocs(query(collection(db, "TRIPS"), clauses.length > 1 ? or(...clauses) : clauses[0]));
      const trips = tSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter((t: any) => t.trip_status !== 'COMPLETED');
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

  // Throttle: write a ping at most every 3 min, or sooner if the truck moved
  // ≥500 m. Unthrottled watchPosition was writing to Firestore every few
  // seconds per moving truck (battery + data + billing burn).
  const PING_MIN_MS = 3 * 60 * 1000;
  const PING_MIN_METERS = 500;
  const metersBetween = (a: {lat:number,lng:number}, b: {lat:number,lng:number}) => {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const s = Math.sin(dLat/2)**2 + Math.cos(a.lat*rad) * Math.cos(b.lat*rad) * Math.sin(dLng/2)**2;
    return 2 * R * Math.asin(Math.sqrt(s));
  };

  const startAutoTracking = (tripId: string) => {
    if (!navigator.geolocation) return;
    setIsTracking(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        setCurrentLoc({ lat, lng });
        if (tripId.includes('DEMO')) return;
        const last = lastPingRef.current;
        const now = Date.now();
        const due = !last || (now - last.t) >= PING_MIN_MS || metersBetween(last, { lat, lng }) >= PING_MIN_METERS;
        if (!due) return;
        lastPingRef.current = { t: now, lat, lng };
        updateDoc(doc(db, "TRIPS", tripId), { liveLocation: { lat, lng, lastUpdated: new Date().toISOString() } })
          .catch(() => { lastPingRef.current = last; }); // failed write → retry on next fix
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
  // 📸 REAL uploads (Truth Sprint): photos now go to Firebase Storage and the
  // permanent downloadURL is stored — the office can actually open them. The
  // old flow stored a device-local blob: URL behind a fake success alert, so
  // every POD/challan photo silently died on the driver's phone.
  const handleTripImageUpload = async (e: any, tripId: string, fieldType: string) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = ''; // allow re-selecting the same file after a failure
    setUploadingDoc(`${tripId}_${fieldType}`);
    try {
      if (tripId.includes('DEMO')) {
        updateTripData(tripId, fieldType, URL.createObjectURL(file));
      } else {
        const { url } = await uploadMedia(file, `trips/${slug(tripId)}/${slug(fieldType)}_${Date.now()}.jpg`);
        await updateTripData(tripId, fieldType, url);
        alert("✅ Photo office ko pahunch gayi! (Uploaded)");
      }
    } catch (err) {
      console.error(err);
      alert("❌ Upload nahi hua — network check karke dobara try karein.\n(Upload failed — please retry)");
    }
    setUploadingDoc(null);
  };

  const handleDriverDocumentUpload = async (e: any, fieldType: string) => {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    setUploadingDoc(fieldType);
    try {
      if (driver.id.includes('DEMO')) {
        setDriver({ ...driver, [fieldType]: URL.createObjectURL(file) });
      } else {
        const { url } = await uploadMedia(file, `drivers/${slug(driver.id)}/${slug(fieldType)}_${Date.now()}.jpg`);
        await updateDriverKYC(fieldType, url);
        alert(`✅ ${fieldType} upload ho gaya! (Uploaded)`);
      }
    } catch (err) {
      console.error(err);
      alert("❌ Upload nahi hua — network check karke dobara try karein.\n(Upload failed — please retry)");
    }
    setUploadingDoc(null);
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
    // Money asks open a proper numeric sheet (window.prompt was a tiny English
    // system dialog with no numeric keypad — hostile to the target user).
    if (actionName === 'ADVANCE') {
      setAskSheet({ type: 'ADVANCE', title: driverType === 'OWN' ? '💸 भत्ता / एडवांस माँगो' : '💸 एडवांस माँगो' });
      return;
    }
    if (actionName === 'FUEL_CALL') {
      if (driverType === 'OWN') { setAskSheet({ type: 'FUEL', title: '⛽ डीज़ल का पैसा माँगो' }); }
      else { alert('📞 Owner ko call karein.'); }
      return;
    }
    const remarks = actionName === 'POD' ? 'Driver clicked POD or requested document check.'
      : actionName === 'EMERGENCY' ? (driverType === 'OWN' ? 'Vehicle Repair needed' : 'Emergency Help Needed')
      : `Requested Action: ${actionName}`;
    await sendRequest(actionName === 'POD' ? 'POD' : actionName, '', remarks);
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
              {driver.profile_photo ? (
                <img src={driver.profile_photo} alt="Profile" className="w-12 h-12 rounded-full object-cover border-2 border-white/10 bg-zinc-800" />
              ) : (
                <div className="w-12 h-12 rounded-full border-2 border-white/10 bg-blue-600 flex items-center justify-center text-lg font-black text-white">{String(driver.name || '?').trim().charAt(0).toUpperCase()}</div>
              )}
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
                  <h3 className="text-2xl font-black text-white">अभी कोई ड्यूटी नहीं</h3>
                  <p className="text-base text-white/70 mt-2 text-center">आराम करें — ऑफिस नई ट्रिप देगा तो यहाँ दिखेगी।</p>
                </div>
              ) : (
                activeTrips.map((trip: any) => (
                  <div key={trip.id} className="flex flex-col">
                    
                    {/* 🗺️ DYNAMIC AUTO-MAP AREA */}
                    <div className="w-full h-56 relative bg-zinc-900 border-b border-white/10 overflow-hidden">
                      {/* Map shown in NORMAL colors — the old invert filter made it unreadable in sunlight */}
                      {isTracking && currentLoc ? (
                        <iframe width="100%" height="100%" style={{ border: 0 }} loading="lazy" allowFullScreen src={`https://maps.google.com/maps?q=${currentLoc.lat},${currentLoc.lng}&z=15&output=embed`}></iframe>
                      ) : (
                        <iframe width="100%" height="100%" style={{ border: 0, opacity: 0.85 }} loading="lazy" allowFullScreen src={`https://maps.google.com/maps?saddr=${encodeURIComponent(trip.loading_point)}&daddr=${encodeURIComponent(trip.consignee_name)}&z=5&output=embed`}></iframe>
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
                      {/* बड़े हिंदी tiles — 8px English labels थे, driver पढ़ ही नहीं पाता था */}
                      <div className="grid grid-cols-2 gap-3 mb-6">
                        <button onClick={() => handleQuickAction('ADVANCE')} className="bg-blue-500/10 border border-blue-500/30 active:scale-95 p-4 rounded-2xl flex flex-col items-center justify-center gap-1.5 transition-all min-h-[88px]">
                          <span className="text-3xl">💸</span>
                          <span className="text-[13px] font-black text-blue-300">पैसा माँगो</span>
                        </button>
                        <button onClick={() => handleQuickAction('POD')} className="bg-emerald-500/10 border border-emerald-500/30 active:scale-95 p-4 rounded-2xl flex flex-col items-center justify-center gap-1.5 transition-all min-h-[88px]">
                          <span className="text-3xl">📸</span>
                          <span className="text-[13px] font-black text-emerald-300">पर्ची / POD</span>
                        </button>
                        <button onClick={() => handleQuickAction('FUEL_CALL')} className="bg-orange-500/10 border border-orange-500/30 active:scale-95 p-4 rounded-2xl flex flex-col items-center justify-center gap-1.5 transition-all min-h-[88px]">
                          <span className="text-3xl">{driverType === 'OWN' ? '⛽' : '📞'}</span>
                          <span className="text-[13px] font-black text-orange-300">{driverType === 'OWN' ? 'डीज़ल का पैसा' : 'मालिक को फ़ोन'}</span>
                        </button>
                        <button onClick={() => handleQuickAction('EMERGENCY')} className="bg-red-500/15 border border-red-500/40 active:scale-95 p-4 rounded-2xl flex flex-col items-center justify-center gap-1.5 transition-all min-h-[88px]">
                          <span className="text-3xl">🆘</span>
                          <span className="text-[13px] font-black text-red-300">{driverType === 'OWN' ? 'गाड़ी ख़राब / मदद' : 'मदद चाहिए'}</span>
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
                               <p className="text-[11px] font-bold text-white/70 tracking-widest mb-0.5">कहाँ से (Loading)</p>
                               <p className="text-lg font-black text-white leading-tight">{trip.loading_point}</p>
                             </div>
                             <div className="relative">
                               <div className="absolute -left-[35px] top-1.5 w-5 h-5 bg-[#121212] rounded-full border-4 border-emerald-500"></div>
                               <p className="text-[11px] font-bold text-white/70 tracking-widest mb-0.5">कहाँ तक (Drop)</p>
                               <p className="text-lg font-black text-white leading-tight">{trip.consignee_name}</p>
                             </div>
                           </div>
                        </div>

                        {/* Loading Inputs */}
                        <div className="space-y-4">
                          <h4 className="text-sm font-black text-blue-400 tracking-widest flex items-center gap-2"><span>1.</span> लोडिंग — कितना माल भरा?</h4>
                          <input type="number" inputMode="decimal" placeholder="माल की मात्रा डालें (Loaded Qty)" defaultValue={trip.driver_loaded_qty || ''} onBlur={(e) => updateTripData(trip.id, 'driver_loaded_qty', e.target.value)} disabled={trip.office_approved_loading} className="w-full bg-white/5 border border-white/10 p-4 rounded-2xl text-base font-black text-white outline-none focus:border-blue-500 transition-all placeholder:text-white/20" />
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
                                <span className="text-2xl mb-1">📸</span><span className="text-blue-400 font-bold text-sm">चालान की फोटो भेजो</span>
                                <input type="file" accept="image/*" capture="environment" onChange={(e) => handleTripImageUpload(e, trip.id, 'driver_loading_photo')} disabled={trip.office_approved_loading} className="hidden" />
                              </label>
                            )}
                            {uploadingDoc === `${trip.id}_driver_loading_photo` && <div className="absolute inset-0 bg-[#121212]/80 flex items-center justify-center text-blue-400 text-xs font-black rounded-2xl backdrop-blur-sm">⏳ Uploading...</div>}
                          </div>
                        </div>
                        
                        {/* Unloading Inputs */}
                        <div className="space-y-4 mt-8 pt-6 border-t border-white/5">
                          <h4 className="text-sm font-black text-emerald-400 tracking-widest flex items-center gap-2"><span>2.</span> अनलोडिंग — कितना माल उतरा?</h4>
                          <input type="number" inputMode="decimal" placeholder="उतरा हुआ माल डालें (Unloaded Qty)" defaultValue={trip.driver_unloaded_qty || ''} onBlur={(e) => updateTripData(trip.id, 'driver_unloaded_qty', e.target.value)} disabled={trip.office_approved_unloading} className="w-full bg-white/5 border border-white/10 p-4 rounded-2xl text-base font-black text-white outline-none focus:border-emerald-500 transition-all placeholder:text-white/20" />
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
                                <span className="text-2xl mb-1">📸</span><span className="text-emerald-400 font-bold text-sm">उतराई की पर्ची भेजो (POD)</span>
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

          {/* 📒 TAB 2: खाता — balance + kharcha + request status (was DEAD UI: the
              submit button had no onClick and the driver never saw any status) */}
          {activeTab === 'EXPENSES' && driverType === 'OWN' && (
            <div className="p-5 animate-fade-in-up space-y-6">

              {/* 📒 खाता summary — office se kitna mila */}
              <div className="bg-[#121212] rounded-[28px] p-6 border border-white/5 shadow-2xl">
                <h3 className="text-xl font-black text-white mb-4">📒 मेरा खाता</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-2xl p-4 text-center">
                    <p className="text-[12px] font-bold text-emerald-300">पैसा मिला (Advance)</p>
                    <p className="text-2xl font-black text-emerald-400 mt-1">{inr(khataGiven)}</p>
                  </div>
                  <div className="bg-blue-500/10 border border-blue-500/20 rounded-2xl p-4 text-center">
                    <p className="text-[12px] font-bold text-blue-300">हिसाब हुआ</p>
                    <p className="text-2xl font-black text-blue-400 mt-1">{inr(khataRecovered)}</p>
                  </div>
                </div>
                <p className="text-[11px] text-white/50 mt-3 text-center">पूरा हिसाब ऑफिस के पास है — कुछ गड़बड़ लगे तो 🆘 दबाओ।</p>
              </div>

              {/* ⛽ Kharcha form — REAL now */}
              <div className="bg-[#121212] rounded-[28px] p-6 border border-white/5 shadow-2xl">
                <h3 className="text-lg font-black text-white mb-1">⛽ खर्चा भेजो</h3>
                <p className="text-[12px] text-white/60 mb-5">डीज़ल / टोल की पर्ची की फोटो के साथ ऑफिस को भेजें।</p>
                <div className="space-y-4">
                  <select value={expType} onChange={e => setExpType(e.target.value)} className="w-full bg-[#0a0a0a] border border-white/10 p-4 rounded-[18px] text-base font-bold text-white outline-none focus:border-blue-500 transition-all appearance-none">
                    <option>⛽ Diesel / Fuel Slip</option>
                    <option>🛣️ Toll Tax Receipt</option>
                    <option>👮 RTO / Border Kharcha</option>
                    <option>🛠️ Vehicle Repair</option>
                  </select>
                  <input type="number" inputMode="decimal" value={expAmount} onChange={e => setExpAmount(e.target.value)} placeholder="कितने रुपये? (₹)" className="w-full bg-[#0a0a0a] border border-white/10 p-4 rounded-[18px] text-lg font-black text-white outline-none focus:border-blue-500 transition-all placeholder:text-white/30" />
                  <label className={`w-full bg-[#0a0a0a] border-2 border-dashed ${expFile ? 'border-emerald-500 text-emerald-400' : 'border-white/20 text-white/60'} font-bold text-sm py-8 rounded-[20px] flex flex-col items-center justify-center cursor-pointer transition-colors`}>
                    <span className="text-3xl mb-2">📸</span>
                    {expFile ? '✅ पर्ची की फोटो लग गयी — बदलने के लिए दबाओ' : 'पर्ची की फोटो खींचो'}
                    <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { setExpFile(e.target.files?.[0] || null); e.target.value = ''; }} />
                  </label>
                  <button onClick={submitExpense} disabled={sendingExp} className="w-full bg-blue-600 active:bg-blue-500 disabled:bg-zinc-700 text-white font-black text-lg py-4 rounded-[18px] shadow-[0_10px_20px_rgba(37,99,235,0.3)] active:scale-95 transition-transform min-h-[56px]">
                    {sendingExp ? '⏳ भेज रहे हैं…' : 'ऑफिस को भेजो 🚀'}
                  </button>
                </div>
              </div>

              {/* 📨 मेरी रिक्वेस्ट — status timeline (closes the phone-call loop) */}
              <div className="bg-[#121212] rounded-[28px] p-6 border border-white/5 shadow-2xl">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-black text-white">📨 मेरी रिक्वेस्ट</h3>
                  <button onClick={() => fetchDriverExtras(driver)} className="text-[12px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 px-3 py-2 rounded-xl">🔄 ताज़ा करो</button>
                </div>
                {myRequests.length === 0 ? (
                  <p className="text-sm text-white/50 text-center py-4">अभी कोई रिक्वेस्ट नहीं भेजी।</p>
                ) : (
                  <div className="space-y-3">
                    {myRequests.map(r => {
                      const st = REQ_STATUS[r.status] || REQ_STATUS.PENDING;
                      return (
                        <div key={r.id} className="flex justify-between items-center bg-[#0a0a0a] border border-white/5 rounded-2xl p-4">
                          <div className="min-w-0">
                            <p className="text-sm font-black text-white truncate">{r.type === 'EXPENSE' ? '⛽ खर्चा' : r.type === 'ADVANCE' ? '💸 एडवांस' : r.type === 'FUEL' ? '⛽ डीज़ल' : r.type} {r.amount ? `· ${inr(r.amount)}` : ''}</p>
                            <p className="text-[11px] text-white/50 truncate">{String(r.createdAt || '').slice(0, 10)} · {r.remarks || ''}</p>
                          </div>
                          <span className="text-[12px] font-black px-3 py-1.5 rounded-full whitespace-nowrap" style={{ color: st.color, background: st.color + '1a', border: `1px solid ${st.color}55` }}>{st.label}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
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
          
          <button onClick={() => setActiveTab('TRIPS')} className={`flex-1 flex flex-col items-center py-2.5 transition-all min-h-[56px] ${activeTab === 'TRIPS' ? 'text-blue-400 scale-105' : 'text-white/60'}`}>
            <span className="text-2xl mb-0.5">🗺️</span><span className="text-[12px] font-black">ड्यूटी</span>
          </button>

          {/* 🔥 HIDE EXPENSES & KYC FOR MARKET DRIVER 🔥 */}
          {driverType === 'OWN' && (
            <>
              <button onClick={() => setActiveTab('EXPENSES')} className={`flex-1 flex flex-col items-center py-2.5 transition-all min-h-[56px] ${activeTab === 'EXPENSES' ? 'text-emerald-400 scale-105' : 'text-white/60'}`}>
                <span className="text-2xl mb-0.5">📒</span><span className="text-[12px] font-black">खाता</span>
              </button>
              <button onClick={() => setActiveTab('KYC')} className={`flex-1 flex flex-col items-center py-2.5 transition-all min-h-[56px] ${activeTab === 'KYC' ? 'text-orange-400 scale-105' : 'text-white/60'}`}>
                <span className="text-2xl mb-0.5">🪪</span><span className="text-[12px] font-black">कागज़</span>
              </button>
            </>
          )}

        </div>

      </div>

      {/* 💸 पैसा माँगो sheet — proper numeric keypad, no window.prompt */}
      <BottomSheet open={!!askSheet} onClose={() => setAskSheet(null)} title={askSheet?.title || ''} accent="#3b82f6" maxWidth={440}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '14px', fontWeight: 'bold', color: '#93c5fd', marginBottom: '8px' }}>कितने रुपये चाहिए?</label>
            <input type="number" inputMode="decimal" autoFocus value={askAmount} onChange={e => setAskAmount(e.target.value)}
              placeholder="₹ 0"
              style={{ width: '100%', boxSizing: 'border-box', background: '#0a0a0a', border: '2px solid #3b82f6', borderRadius: '16px', color: 'white', fontSize: '32px', fontWeight: 900, textAlign: 'center', padding: '16px', outline: 'none' }} />
            <div style={{ display: 'flex', gap: '8px', marginTop: '10px', justifyContent: 'center', flexWrap: 'wrap' }}>
              {[500, 1000, 2000, 5000].map(v => (
                <button key={v} onClick={() => setAskAmount(String(v))} style={{ background: 'rgba(59,130,246,0.12)', color: '#93c5fd', border: '1px solid rgba(59,130,246,0.4)', borderRadius: '999px', padding: '10px 16px', fontWeight: 'bold', cursor: 'pointer', minHeight: '44px' }}>₹{v.toLocaleString('en-IN')}</button>
              ))}
            </div>
          </div>
          <input type="text" value={askRemarks} onChange={e => setAskRemarks(e.target.value)} placeholder="किस लिए? (optional)"
            style={{ width: '100%', boxSizing: 'border-box', background: '#0a0a0a', border: '1px solid #334155', borderRadius: '14px', color: 'white', fontSize: '15px', padding: '14px', outline: 'none' }} />
          <button onClick={() => { const a = parseFloat(askAmount); if (!Number.isFinite(a) || a <= 0) return alert('⚠️ Sahi amount daalein!'); sendRequest(askSheet.type, a, askRemarks || askSheet.title); }} disabled={sendingReq}
            style={{ width: '100%', background: sendingReq ? '#3f3f46' : '#3b82f6', color: 'white', border: 'none', borderRadius: '16px', padding: '18px', fontSize: '18px', fontWeight: 900, cursor: 'pointer', minHeight: '56px' }}>
            {sendingReq ? '⏳ भेज रहे हैं…' : 'ऑफिस को भेजो 🚀'}
          </button>
        </div>
      </BottomSheet>

      <style>{`
        .animate-fade-in-up { animation: fadeInUp 0.4s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}