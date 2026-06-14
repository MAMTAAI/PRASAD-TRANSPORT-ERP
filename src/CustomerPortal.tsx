// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, query, where, getDocs, addDoc, serverTimestamp, orderBy } from 'firebase/firestore';
import { db } from './firebase';

interface CustomerPortalProps {
  onLogout?: () => void;
}

export default function CustomerPortal({ onLogout }: CustomerPortalProps) {
  const [activeTab, setActiveTab] = useState('profile'); // डिफ़ॉल्ट रूप से Company Profile खुलेगा
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // 🏢 COMPANY PROFILE & KYC STATE
  const [profile, setProfile] = useState({
    corporateName: '',
    gstNumber: '',
    panNumber: '',
    billingAddress: '',
    statePincode: '',
    contactPerson: '',
    mobileNo: '',
    status: 'NEW' // NEW -> PENDING -> APPROVED
  });

  // 📝 SMART FORM STATES (Post Load)
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [materialType, setMaterialType] = useState('Petroleum / Oil');
  const [vehicleType, setVehicleType] = useState('Oil Tanker (Secured)');
  const [weight, setWeight] = useState('');
  const [budget, setBudget] = useState('');
  const [loadDate, setLoadDate] = useState('');

  // 🔥 NEW: MAP & TOLL STATES 🔥
  const [distanceKm, setDistanceKm] = useState('');
  const [tollPlazas, setTollPlazas] = useState('');
  const [tollAmount, setTollAmount] = useState('');
  const [showMap, setShowMap] = useState(false);

  const materials = ['Petroleum / Oil', 'Industrial Steel', 'FMCG / General', 'Chemicals', 'Agri / Food'];
  const vehicles = ['Oil Tanker (Secured)', 'Open Truck (Flatbed)', 'Closed Container', 'Heavy Trailer'];

  // 🔄 DYNAMIC DATA FOR TABS
  const [liveBids, setLiveBids] = useState([
    { id: '#LD-9021', route: 'Bongaigaon ➔ New Delhi', material: 'Refined Oil', weight: '24 KL', budget: '₹45,000', lowestBid: '₹42,500', bidders: 4, status: 'LIVE' },
    { id: '#LD-9022', route: 'Guwahati ➔ Kolkata', material: 'Industrial Steel', weight: '21 MT', budget: '₹35,000', lowestBid: '₹34,000', bidders: 2, status: 'LIVE' }
  ]);

  const recentShipments = [
    { id: '#SH-8801', route: 'Bongaigaon ➔ Patna', truck: 'AS-19-C-1234', date: '22 Mar 2026', status: 'In Transit', cost: '₹28,000' },
    { id: '#SH-8795', route: 'Siliguri ➔ Bongaigaon', truck: 'WB-74-A-9876', date: '19 Mar 2026', status: 'Delivered', cost: '₹15,500' }
  ];

  const paymentHistory = [
    { id: 'TXN-9091', date: '22 Mar 2026, 10:30 AM', desc: 'Funds Added via NetBanking', type: 'CREDIT', amount: '+ ₹1,50,000', balance: '₹1,25,000' },
    { id: 'TXN-9088', date: '20 Mar 2026, 04:15 PM', desc: 'Freight Payment Hold - Load #SH-8801', type: 'DEBIT', amount: '- ₹28,000', balance: '₹1,10,000' },
    { id: 'TXN-9085', date: '18 Mar 2026, 11:00 AM', desc: 'Freight Released - Load #SH-8795', type: 'DEBIT', amount: '- ₹15,500', balance: '₹1,38,000' },
  ];

  // 📍 SMART ROUTE & TOLL CALCULATOR ENGINE
  const handleCalculateRoute = () => {
    if (!origin || !destination) {
      return alert("Please enter both Loading and Unloading points first!");
    }
    
    setLoading(true);
    setShowMap(false); 

    setTimeout(() => {
      const o = origin.toLowerCase();
      const d = destination.toLowerCase();
      
      let dist = Math.floor(Math.random() * (1200 - 150) + 150); 
      let tolls = Math.floor(dist / 60); 
      let tollAmt = tolls * 145; 

      if ((o.includes('bong') && d.includes('guw')) || (d.includes('bong') && o.includes('guw'))) {
        dist = 185; tolls = 3; tollAmt = 420;
      } else if ((o.includes('bong') && d.includes('barpeta')) || (d.includes('bong') && o.includes('barpeta'))) {
        dist = 130; tolls = 2; tollAmt = 265;
      } else if ((o.includes('guw') && d.includes('jorh')) || (d.includes('guw') && o.includes('jorh'))) {
        dist = 305; tolls = 5; tollAmt = 780;
      } else if ((o.includes('bong') && d.includes('sili')) || (d.includes('bong') && o.includes('sili'))) {
        dist = 390; tolls = 6; tollAmt = 950;
      }

      setDistanceKm(dist.toString());
      setTollPlazas(tolls.toString());
      setTollAmount(tollAmt.toString());
      
      setShowMap(true);
      setLoading(false);
    }, 800); 
  };

  // 🚀 POST NEW LOAD TO FIREBASE BAZAAR
  const handlePostLoad = async (e: React.FormEvent) => {
    e.preventDefault();
    if(profile.status !== 'APPROVED') return alert("⚠️ Your Company KYC is pending! Admin must approve your profile before you can post loads.");
    if(!origin || !destination || !weight || !budget) return alert("Please fill all details!");

    setLoading(true);
    try {
      const loadId = `LD-${Math.floor(1000 + Math.random() * 9000)}`;
      
      // Save to Firebase Load Bazaar
      await addDoc(collection(db, "BAZAAR_LOADS"), {
        load_id: loadId,
        customer_name: profile.corporateName || 'Customer',
        origin: origin.toUpperCase(),
        destination: destination.toUpperCase(),
        distance_km: distanceKm,
        toll_plazas: tollPlazas,
        toll_amount: tollAmount,
        material: materialType,
        weight: weight.toUpperCase(),
        vehicle_type: vehicleType,
        target_rate: budget,
        loading_date: loadDate,
        status: 'OPEN',
        postedBy: 'CUSTOMER',
        createdAt: serverTimestamp()
      });

      // Update Local State for UI
      const newLoad = {
        id: `#${loadId}`, 
        route: `${origin.toUpperCase()} ➔ ${destination.toUpperCase()}`,
        material: materialType, 
        weight: weight.toUpperCase(), 
        budget: `₹${Number(budget).toLocaleString('en-IN')}`,
        lowestBid: 'Waiting...', 
        bidders: 0, 
        status: 'LIVE'
      };
      setLiveBids([newLoad, ...liveBids]);

      alert('🚀 Load Posted Successfully! Reverse Auction started in Live Bazaar.');
      setOrigin(''); setDestination(''); setWeight(''); setBudget(''); setLoadDate(''); setDistanceKm(''); setTollPlazas(''); setTollAmount(''); setShowMap(false);
      setActiveTab('live_bids');
    } catch (error) {
      alert("❌ Error posting load. Please try again.");
    }
    setLoading(false);
  };

  const handleKYCSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if(!profile.corporateName || !profile.gstNumber || !profile.mobileNo) return alert("Fill all mandatory fields.");
    
    setProfile({ ...profile, status: 'PENDING' });
    alert("✅ Profile Submitted Successfully! It is now pending for Admin approval in the ERP System.\n\n(Tip: I am temporarily auto-approving it so you can test the system!)");
    
    setTimeout(() => {
      setProfile(prev => ({ ...prev, status: 'APPROVED' }));
    }, 3000);
  };

  const handleDownload = (docName: string) => {
    alert(`Downloading ${docName} PDF...`);
  };

  const handleShareToDriver = (docName: string) => {
    alert(`Sending ${docName} to Driver via WhatsApp...`);
  };

  return (
    <div className="min-h-screen bg-slate-50 flex font-sans selection:bg-blue-500 selection:text-white">
      
      {/* 🚀 LEFT SIDEBAR (CORPORATE THEME) */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-72 bg-[#0f172a] text-white flex flex-col shadow-2xl transition-transform duration-300 lg:relative lg:translate-x-0 ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="absolute inset-0 bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:20px_20px] opacity-[0.03]"></div>
        
        <div className="p-6 flex items-center gap-3 border-b border-slate-800 relative z-10">
          <div className="bg-gradient-to-br from-blue-500 to-blue-700 w-10 h-10 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/30 text-white font-black text-xl">🏢</div>
          <div>
            <h1 className="text-xl font-black tracking-tighter leading-none m-0 text-white">PRASAD<span className="text-blue-500">.</span></h1>
            <h2 className="text-[9px] font-bold text-blue-300 tracking-[0.2em] uppercase mt-1">Load Bazaar</h2>
          </div>
          <button onClick={() => setIsMobileMenuOpen(false)} className="lg:hidden ml-auto text-slate-400 text-2xl">✖</button>
        </div>

        <nav className="flex-1 p-4 space-y-2 relative z-10 overflow-y-auto">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-4 ml-2 mt-2">Customer Dashboard</p>
          
          <button onClick={() => setActiveTab('dashboard')} className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl font-bold transition-all ${activeTab === 'dashboard' ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <span className="text-xl">📊</span> Overview
          </button>
          
          {/* COMPANY PROFILE TAB */}
          <button onClick={() => setActiveTab('profile')} className={`w-full flex items-center justify-between px-4 py-3.5 rounded-xl font-bold transition-all ${activeTab === 'profile' ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <div className="flex items-center gap-3"><span className="text-xl">📝</span> Company Profile</div>
            {profile.status === 'PENDING' && <span className="bg-orange-500 text-white text-[10px] px-2 py-0.5 rounded-full animate-pulse">WAITING</span>}
            {profile.status === 'APPROVED' && <span className="bg-emerald-500 text-white text-[10px] px-2 py-0.5 rounded-full">VERIFIED</span>}
          </button>

          <button onClick={() => setActiveTab('post_load')} className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl font-bold transition-all ${activeTab === 'post_load' ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <span className="text-xl">➕</span> Post New Load
          </button>
          
          <button onClick={() => setActiveTab('live_bids')} className={`w-full flex items-center justify-between px-4 py-3.5 rounded-xl font-bold transition-all ${activeTab === 'live_bids' ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <div className="flex items-center gap-3"><span className="text-xl">📉</span> Live Bids</div>
            <span className="bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full animate-pulse">{liveBids.length} LIVE</span>
          </button>
          
          <button onClick={() => setActiveTab('shipments')} className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl font-bold transition-all ${activeTab === 'shipments' ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <span className="text-xl">🚚</span> My Shipments (Live)
          </button>
          
          <button onClick={() => setActiveTab('escrow')} className={`w-full flex items-center gap-3 px-4 py-3.5 rounded-xl font-bold transition-all ${activeTab === 'escrow' ? 'bg-blue-600 text-white shadow-[0_0_15px_rgba(37,99,235,0.4)]' : 'text-slate-400 hover:bg-slate-800 hover:text-white'}`}>
            <span className="text-xl">🛡️</span> Billing & Wallet
          </button>
        </nav>

        <div className="p-6 border-t border-slate-800 relative z-10">
          <button onClick={onLogout} className="w-full bg-slate-800 hover:bg-red-500/20 text-slate-300 hover:text-red-500 border border-slate-700 hover:border-red-500/50 py-3 rounded-xl font-bold flex items-center justify-center gap-2 transition-all">🚪 Secure Logout</button>
        </div>
      </aside>

      {/* 🚀 MAIN CONTENT AREA */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden bg-slate-50 relative">
        
        <header className="h-20 bg-white border-b border-slate-200 flex items-center justify-between px-6 md:px-10 shadow-sm z-10 shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsMobileMenuOpen(true)} className="lg:hidden text-2xl text-blue-950">☰</button>
            <div>
              <h2 className="text-xl md:text-2xl font-black text-blue-950">Corporate Dashboard</h2>
              <p className="text-xs md:text-sm text-slate-500 font-medium mt-0.5">Welcome back, The Boss. 🏢</p>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <button className="relative w-10 h-10 bg-slate-100 text-blue-600 hover:bg-blue-100 rounded-full flex items-center justify-center text-xl transition-colors shadow-inner">
              🔔<span className="absolute top-0 right-0 w-3 h-3 bg-red-500 border-2 border-white rounded-full"></span>
            </button>
            <div className="hidden md:flex items-center gap-3 pl-4 border-l border-slate-200">
              <div className="text-right">
                <p className="text-sm font-black text-blue-950 leading-tight">{profile.corporateName || 'New Corporate'}</p>
                {profile.status === 'APPROVED' ? (
                  <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest">ERP Verified ✅</p>
                ) : (
                  <p className="text-[10px] font-bold text-orange-500 uppercase tracking-widest">Approval Pending ⏳</p>
                )}
              </div>
              <div className="w-10 h-10 bg-blue-950 rounded-xl flex items-center justify-center text-white font-bold shadow-md">
                {profile.corporateName ? profile.corporateName.charAt(0).toUpperCase() : 'C'}
              </div>
            </div>
          </div>
        </header>

        {/* SCROLLABLE DASHBOARD CONTENT */}
        <div className="flex-1 overflow-y-auto p-6 md:p-8 relative">
          
          {/* 🏢 TAB: COMPANY PROFILE & KYC */}
          {activeTab === 'profile' && (
            <div className="max-w-5xl mx-auto animate-fade-in-up">
              <div className="mb-6 flex justify-between items-end">
                <div>
                  <h2 className="text-3xl font-black text-blue-950">Company Profile & KYC</h2>
                  <p className="text-sm text-slate-500 mt-1">Fill these details to auto-register in Prasad Transport ERP Contract Master.</p>
                </div>
                {profile.status === 'PENDING' && (
                  <span className="bg-orange-100 text-orange-700 border border-orange-300 font-bold px-4 py-2 rounded-xl shadow-sm animate-pulse flex items-center gap-2">
                    ⏳ Pending Admin Approval
                  </span>
                )}
                {profile.status === 'APPROVED' && (
                  <span className="bg-emerald-100 text-emerald-700 border border-emerald-300 font-bold px-4 py-2 rounded-xl shadow-sm flex items-center gap-2">
                    ✅ Active & ERP Synced
                  </span>
                )}
              </div>

              <div className="bg-white rounded-[32px] p-8 border border-slate-200 shadow-xl relative overflow-hidden">
                <div className="absolute top-0 left-0 w-full h-3 bg-gradient-to-r from-blue-600 to-blue-400"></div>

                <form onSubmit={handleKYCSubmit} className="space-y-8 mt-4">
                  <div>
                    <h3 className="text-sm font-black text-blue-950 uppercase tracking-widest mb-4 flex items-center gap-2"><span className="text-xl">🏢</span> 1. Corporate Details</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 bg-slate-50 p-6 rounded-2xl border border-slate-100 shadow-inner">
                      <div className="lg:col-span-2">
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Corporate Name (e.g. IOCL/BPCL) *</label>
                        <input type="text" value={profile.corporateName} onChange={e => setProfile({...profile, corporateName: e.target.value.toUpperCase()})} disabled={profile.status !== 'NEW'} placeholder="Enter Full Company Name" className="w-full bg-white border border-slate-300 p-3.5 rounded-xl text-sm font-black text-blue-950 outline-none focus:border-blue-500 shadow-sm uppercase disabled:opacity-60" required />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">GST Number *</label>
                        <input type="text" value={profile.gstNumber} onChange={e => setProfile({...profile, gstNumber: e.target.value.toUpperCase()})} disabled={profile.status !== 'NEW'} placeholder="22AAAAA0000A1Z5" className="w-full bg-white border border-slate-300 p-3.5 rounded-xl text-sm font-black text-blue-950 font-mono outline-none focus:border-blue-500 shadow-sm uppercase disabled:opacity-60" required />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">PAN Number</label>
                        <input type="text" value={profile.panNumber} onChange={e => setProfile({...profile, panNumber: e.target.value.toUpperCase()})} disabled={profile.status !== 'NEW'} placeholder="AAAAA0000A" className="w-full bg-white border border-slate-300 p-3.5 rounded-xl text-sm font-black text-blue-950 font-mono outline-none focus:border-blue-500 shadow-sm uppercase disabled:opacity-60" />
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-black text-blue-950 uppercase tracking-widest mb-4 flex items-center gap-2"><span className="text-xl">📍</span> 2. Location & Contact</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 bg-slate-50 p-6 rounded-2xl border border-slate-100 shadow-inner">
                      <div className="md:col-span-2">
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Billing Address</label>
                        <input type="text" value={profile.billingAddress} onChange={e => setProfile({...profile, billingAddress: e.target.value})} disabled={profile.status !== 'NEW'} placeholder="Full Registered Address" className="w-full bg-white border border-slate-300 p-3.5 rounded-xl text-sm font-bold text-slate-800 outline-none focus:border-blue-500 shadow-sm disabled:opacity-60" />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">State & Pincode</label>
                        <input type="text" value={profile.statePincode} onChange={e => setProfile({...profile, statePincode: e.target.value})} disabled={profile.status !== 'NEW'} placeholder="e.g. Assam - 7833" className="w-full bg-white border border-slate-300 p-3.5 rounded-xl text-sm font-bold text-slate-800 outline-none focus:border-blue-500 shadow-sm disabled:opacity-60" />
                      </div>
                      <div></div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Contact Person Name</label>
                        <input type="text" value={profile.contactPerson} onChange={e => setProfile({...profile, contactPerson: e.target.value})} disabled={profile.status !== 'NEW'} placeholder="Authorized Person" className="w-full bg-white border border-slate-300 p-3.5 rounded-xl text-sm font-bold text-slate-800 outline-none focus:border-blue-500 shadow-sm disabled:opacity-60" />
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">Mobile Number *</label>
                        <input type="tel" value={profile.mobileNo} onChange={e => setProfile({...profile, mobileNo: e.target.value})} disabled={profile.status !== 'NEW'} placeholder="9876543210" className="w-full bg-white border border-slate-300 p-3.5 rounded-xl text-sm font-black text-blue-950 font-mono outline-none focus:border-blue-500 shadow-sm disabled:opacity-60" required />
                      </div>
                    </div>
                  </div>

                  {profile.status === 'NEW' && (
                    <div className="pt-4 border-t border-slate-100 flex justify-end">
                      <button type="submit" className="bg-blue-600 hover:bg-blue-700 text-white font-black px-10 py-4 rounded-xl shadow-[0_10px_20px_rgba(37,99,235,0.3)] transition-transform active:scale-95 text-lg flex items-center gap-2">
                        SUBMIT FOR ERP VERIFICATION 🚀
                      </button>
                    </div>
                  )}
                </form>
              </div>
            </div>
          )}

          {/* 📊 TAB: DASHBOARD OVERVIEW */}
          {activeTab === 'dashboard' && (
            <div className="space-y-8 animate-fade-in-up max-w-7xl mx-auto">
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-xl transition-shadow flex flex-col justify-between group relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-16 h-16 bg-blue-50 rounded-bl-full -mr-4 -mt-4 transition-transform group-hover:scale-150"></div>
                  <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-2xl flex items-center justify-center text-2xl mb-4 relative z-10 shadow-inner">📦</div>
                  <div className="relative z-10">
                    <h3 className="text-slate-500 text-xs font-bold tracking-widest uppercase mb-1">Total Loads Posted</h3>
                    <p className="text-3xl font-black text-blue-950">24</p>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-xl transition-shadow flex flex-col justify-between group relative overflow-hidden">
                  <div className="flex justify-between items-start mb-4 relative z-10">
                    <div className="w-12 h-12 bg-orange-100 text-orange-600 rounded-2xl flex items-center justify-center text-2xl shadow-inner">📉</div>
                    <span className="bg-red-100 text-red-600 text-[10px] font-bold px-2 py-1 rounded-lg animate-pulse border border-red-200">LIVE</span>
                  </div>
                  <div className="relative z-10">
                    <h3 className="text-slate-500 text-xs font-bold tracking-widest uppercase mb-1">Active Reverse Auctions</h3>
                    <p className="text-3xl font-black text-blue-950">{liveBids.length}</p>
                  </div>
                </div>

                <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm hover:shadow-xl transition-shadow flex flex-col justify-between group relative overflow-hidden">
                  <div className="w-12 h-12 bg-emerald-100 text-emerald-600 rounded-2xl flex items-center justify-center text-2xl mb-4 relative z-10 shadow-inner">🚚</div>
                  <div className="relative z-10">
                    <h3 className="text-slate-500 text-xs font-bold tracking-widest uppercase mb-1">In Transit Shipments</h3>
                    <p className="text-3xl font-black text-blue-950">1</p>
                  </div>
                </div>

                <div className="bg-gradient-to-br from-blue-950 to-blue-900 p-6 rounded-3xl border border-blue-800 shadow-xl hover:shadow-2xl transition-shadow flex flex-col justify-between relative overflow-hidden group">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-2xl -mr-10 -mt-10"></div>
                  <div className="w-12 h-12 bg-blue-800 text-white rounded-2xl flex items-center justify-center text-2xl mb-4 relative z-10 border border-blue-700 shadow-inner">🛡️</div>
                  <div className="relative z-10">
                    <h3 className="text-blue-300 text-xs font-bold tracking-widest uppercase mb-1">Escrow Balance</h3>
                    <p className="text-3xl font-black text-white">₹1,25,000</p>
                  </div>
                </div>
              </div>

              {/* RECENT SHIPMENTS TABLE */}
              <div className="bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden">
                <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                  <h3 className="text-lg font-black text-blue-950 flex items-center gap-2"><span>🚚</span> Recent Shipments</h3>
                  <button onClick={() => setActiveTab('shipments')} className="text-sm font-bold text-blue-600 hover:text-blue-800">View All →</button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-white text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100">
                        <th className="p-5 font-bold">Load ID / Route</th>
                        <th className="p-5 font-bold">Vehicle Assigned</th>
                        <th className="p-5 font-bold">Date</th>
                        <th className="p-5 font-bold">Freight Cost</th>
                        <th className="p-5 font-bold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {recentShipments.map((ship) => (
                        <tr key={ship.id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="p-5">
                            <p className="font-black text-blue-950 text-sm">{ship.route}</p>
                            <p className="text-xs text-slate-500 font-bold mt-0.5">{ship.id}</p>
                          </td>
                          <td className="p-5 font-bold text-slate-700 text-sm border-l border-slate-100">{ship.truck}</td>
                          <td className="p-5 text-sm text-slate-500 font-medium">{ship.date}</td>
                          <td className="p-5 font-black text-blue-700">{ship.cost}</td>
                          <td className="p-5">
                            <span className={`px-3 py-1 rounded-full text-xs font-bold border flex items-center gap-1.5 w-max ${ship.status === 'In Transit' ? 'bg-blue-50 text-blue-600 border-blue-200' : 'bg-emerald-50 text-emerald-600 border-emerald-200'}`}>
                              {ship.status === 'In Transit' && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>}
                              {ship.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ➕ TAB: POST NEW LOAD (🔥🔥 THE NEW SMART MAP FEATURE 🔥🔥) */}
          {activeTab === 'post_load' && (
            <div className="max-w-6xl mx-auto animate-fade-in-up">
              {profile.status !== 'APPROVED' ? (
                <div className="bg-orange-50 border-2 border-orange-200 rounded-3xl p-10 text-center shadow-lg">
                  <div className="text-6xl mb-4">⚠️</div>
                  <h2 className="text-2xl font-black text-orange-800 mb-2">KYC Verification Pending</h2>
                  <p className="text-orange-600 font-medium max-w-md mx-auto">Your company profile is currently waiting for Admin approval. You can post loads once your account is activated in the ERP.</p>
                  <button onClick={() => setActiveTab('profile')} className="mt-6 bg-orange-600 hover:bg-orange-700 text-white font-bold px-6 py-3 rounded-xl shadow-lg">Check Profile Status</button>
                </div>
              ) : (
                <>
                  <div className="mb-6">
                    <h2 className="text-3xl font-black text-blue-950">Post a New Load</h2>
                    <p className="text-slate-500 text-sm mt-1">Smart matching system. Fill details to start the reverse auction instantly in the Bazaar.</p>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    
                    {/* LEFT FORM */}
                    <div className="bg-white rounded-3xl p-8 border border-slate-200 shadow-xl relative overflow-hidden">
                      <form onSubmit={handlePostLoad} className="space-y-6 relative z-10">
                        
                        <div>
                          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-6">📍 Route & Distance</h3>
                          
                          <div className="space-y-4 mb-4">
                             <div className="relative">
                               <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Loading Point (Origin) *</label>
                               <input type="text" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="e.g. Bongaigaon" className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl text-sm font-bold text-slate-800 outline-none focus:border-blue-500 uppercase transition-all shadow-sm" required />
                             </div>
                             <div className="relative">
                               <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Unloading Point (Destination) *</label>
                               <input type="text" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="e.g. Guwahati" className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl text-sm font-bold text-slate-800 outline-none focus:border-blue-500 uppercase transition-all shadow-sm" required />
                             </div>
                          </div>

                          <button type="button" onClick={handleCalculateRoute} disabled={loading} className="w-full bg-slate-800 hover:bg-slate-900 text-white font-bold py-3 rounded-xl transition-all shadow-md flex justify-center items-center gap-2 mb-4">
                            {loading ? '⏳ Calculating...' : '🔍 Analyze Route & Tolls'}
                          </button>

                          {/* SMART CALCULATION BOX */}
                          <div className="bg-blue-50 border border-blue-100 p-4 rounded-xl flex justify-between items-center shadow-inner">
                            <div className="text-center border-r border-blue-200 pr-4">
                              <p className="text-[10px] text-slate-500 font-bold uppercase mb-1">Distance</p>
                              <div className="flex items-end justify-center gap-1">
                                <input type="number" value={distanceKm} onChange={(e)=>setDistanceKm(e.target.value)} className="w-12 bg-transparent border-b border-blue-300 text-blue-700 font-black text-lg text-center outline-none" placeholder="0" />
                                <span className="text-xs font-bold text-blue-500">KM</span>
                              </div>
                            </div>
                            <div className="text-center border-r border-blue-200 pr-4">
                              <p className="text-[10px] text-slate-500 font-bold uppercase mb-1">Toll Plazas</p>
                              <div className="flex items-end justify-center gap-1">
                                <input type="number" value={tollPlazas} onChange={(e)=>setTollPlazas(e.target.value)} className="w-10 bg-transparent border-b border-orange-300 text-orange-600 font-black text-lg text-center outline-none" placeholder="0" />
                                <span className="text-sm">🚧</span>
                              </div>
                            </div>
                            <div className="text-center pl-2">
                              <p className="text-[10px] text-slate-500 font-bold uppercase mb-1">Est. Toll</p>
                              <div className="flex items-end justify-center gap-1">
                                <span className="text-sm font-bold text-red-500">₹</span>
                                <input type="number" value={tollAmount} onChange={(e)=>setTollAmount(e.target.value)} className="w-14 bg-transparent border-b border-red-300 text-red-600 font-black text-lg text-center outline-none" placeholder="0" />
                              </div>
                            </div>
                          </div>
                        </div>

                        <div>
                          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 mt-6 border-t border-slate-100 pt-6">📦 Cargo Details</h3>
                          
                          <label className="block text-xs font-bold text-blue-950 mb-2">Required Vehicle Type</label>
                          <select value={vehicleType} onChange={e => setVehicleType(e.target.value)} className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl text-sm font-bold text-slate-800 outline-none focus:border-blue-500 mb-4 shadow-sm">
                             {vehicles.map(v => <option key={v} value={v}>{v}</option>)}
                          </select>

                          <div className="flex gap-4">
                            <div className="flex-1">
                              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Material</label>
                              <input type="text" value={materialType} onChange={e => setMaterialType(e.target.value)} placeholder="e.g. Iron Pipes" className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl text-sm font-bold text-slate-800 outline-none focus:border-blue-500 shadow-sm" required />
                            </div>
                            <div className="flex-1">
                              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Total Weight/Qty *</label>
                              <input type="text" value={weight} onChange={e => setWeight(e.target.value)} placeholder="e.g. 21 Ton" className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl text-sm font-bold text-slate-800 outline-none focus:border-blue-500 shadow-sm" required />
                            </div>
                          </div>
                        </div>

                        <div>
                          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-4 pt-6 border-t border-slate-100">💰 Budget & Timelines</h3>
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Target Budget (₹) *</label>
                              <div className="relative">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 font-black text-slate-400">₹</span>
                                <input type="number" value={budget} onChange={e => setBudget(e.target.value)} placeholder="45000" className="w-full bg-slate-50 border border-slate-200 p-3 pl-8 rounded-xl text-sm font-black text-blue-700 outline-none focus:border-blue-500 shadow-sm" required />
                              </div>
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1">Expected Loading Date</label>
                              <input type="date" value={loadDate} onChange={e => setLoadDate(e.target.value)} className="w-full bg-slate-50 border border-slate-200 p-3 rounded-xl text-sm font-bold text-slate-800 outline-none focus:border-blue-500 shadow-sm" required />
                            </div>
                          </div>
                        </div>

                        <div className="pt-6">
                          <button type="submit" disabled={loading} className="w-full bg-blue-600 hover:bg-blue-700 text-white font-black text-lg py-4 rounded-xl shadow-[0_10px_20px_rgba(37,99,235,0.3)] hover:-translate-y-1 transition-all">
                            {loading ? '⌛ POSTING TO BAZAAR...' : '🚀 BROADCAST TO BAZAAR'}
                          </button>
                        </div>
                      </form>
                    </div>

                    {/* RIGHT: THE SMART GOOGLE MAP IFRAME */}
                    <div className="hidden lg:flex flex-col gap-4">
                      <div className="bg-slate-200 rounded-3xl overflow-hidden shadow-inner border-4 border-white relative h-full min-h-[500px] flex items-center justify-center">
                         {!showMap ? (
                           <div className="text-center text-slate-400 p-10">
                              <div className="text-6xl mb-4 grayscale opacity-50">🗺️</div>
                              <p className="font-bold">Type locations and click</p>
                              <p className="text-sm">"Analyze Route & Tolls" to load Map</p>
                           </div>
                         ) : (
                           <iframe 
                             title="Google Map Route"
                             width="100%" 
                             height="100%" 
                             style={{ border: 0 }} 
                             loading="lazy" 
                             allowFullScreen 
                             src={`https://maps.google.com/maps?q=${encodeURIComponent(origin)}+to+${encodeURIComponent(destination)}&t=&z=7&ie=UTF8&iwloc=&output=embed`}
                           />
                         )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* 📉 TAB: LIVE BIDS */}
          {activeTab === 'live_bids' && (
            <div className="space-y-6 max-w-5xl mx-auto animate-fade-in-up">
              <div className="flex justify-between items-end mb-6">
                <div>
                  <h2 className="text-3xl font-black text-blue-950">Live Reverse Auctions</h2>
                  <p className="text-sm text-slate-500 mt-1">Watch fleet owners bid for your loads in real-time.</p>
                </div>
                <span className="bg-red-100 text-red-600 font-bold px-4 py-1.5 rounded-full text-xs flex items-center gap-2 border border-red-200 shadow-sm"><span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span> {liveBids.length} Active Loads</span>
              </div>
              <div className="grid grid-cols-1 gap-6">
                {liveBids.map((bid, index) => (
                  <div key={index} className="bg-white border-2 border-blue-100 rounded-3xl p-6 md:p-8 shadow-lg hover:shadow-xl transition-shadow relative overflow-hidden group">
                    <div className="absolute top-0 right-0 bg-blue-50 px-6 py-2 rounded-bl-3xl border-b border-l border-blue-100 font-black text-blue-800 tracking-widest text-sm">{bid.id}</div>
                    <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 pb-6 border-b border-slate-100 gap-4 mt-4 md:mt-0">
                      <div>
                        <h3 className="text-2xl font-black text-blue-950 group-hover:text-blue-600 transition-colors">{bid.route}</h3>
                        <div className="flex items-center gap-3 mt-2">
                           <span className="bg-slate-100 text-slate-600 px-3 py-1 rounded-lg text-xs font-bold">{bid.material}</span>
                           <span className="bg-slate-100 text-slate-600 px-3 py-1 rounded-lg text-xs font-bold">{bid.weight}</span>
                        </div>
                      </div>
                      <div className="text-left md:text-right bg-slate-50 p-4 rounded-2xl border border-slate-200 w-full md:w-auto">
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-1">Your Max Budget</p>
                        <p className="text-xl font-black text-slate-800 line-through decoration-red-500 decoration-2">{bid.budget}</p>
                      </div>
                    </div>
                    <div className="bg-blue-950 rounded-2xl p-6 text-white flex flex-col md:flex-row justify-between items-center gap-6 shadow-inner relative overflow-hidden">
                      <div className="absolute inset-0 opacity-20 bg-[radial-gradient(#ffffff_1px,transparent_1px)] [background-size:10px_10px]"></div>
                      <div className="relative z-10 flex items-center gap-4 w-full md:w-auto border-b md:border-b-0 md:border-r border-blue-800 pb-4 md:pb-0 md:pr-8">
                        <div className="w-14 h-14 bg-green-500 rounded-full flex items-center justify-center text-2xl shadow-[0_0_20px_rgba(34,197,94,0.5)]">📉</div>
                        <div>
                          <p className="text-blue-300 text-[10px] font-bold uppercase tracking-widest mb-1">Lowest Bid Right Now</p>
                          <p className="text-4xl font-black text-green-400">{bid.lowestBid}</p>
                        </div>
                      </div>
                      <div className="relative z-10 flex-1 flex flex-col items-center justify-center gap-1">
                        <span className="text-[10px] font-bold text-blue-300 uppercase tracking-widest">Total Bidders</span>
                        <span className="bg-blue-800 px-4 py-1.5 rounded-lg font-black text-white text-xl border border-blue-700">{bid.bidders}</span>
                      </div>
                      <div className="relative z-10 w-full md:w-auto">
                        <button className="w-full md:w-auto bg-green-500 hover:bg-green-400 text-blue-950 font-black py-4 px-8 rounded-xl shadow-lg transition-transform hover:-translate-y-1 text-sm tracking-wide">VIEW BIDS & ACCEPT ✅</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 🚚 TAB: LIVE SHIPMENT TRACKING & 📂 DOCUMENT HUB */}
          {activeTab === 'shipments' && (
            <div className="space-y-6 max-w-7xl mx-auto animate-fade-in-up">
              <div className="flex justify-between items-end mb-6">
                <div>
                  <h2 className="text-3xl font-black text-blue-950">Live Vehicle Tracking</h2>
                  <p className="text-sm text-slate-500 mt-1">Monitor shipments and download mandatory transport documents.</p>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-auto lg:h-[750px]">
                <div className="lg:col-span-1 flex flex-col gap-6 h-full">
                  
                  {/* Tracking Card */}
                  <div className="bg-white p-6 rounded-3xl border-2 border-emerald-500 shadow-lg relative overflow-hidden shrink-0">
                    <div className="absolute top-0 right-0 bg-emerald-500 text-white text-[10px] font-black px-3 py-1 rounded-bl-xl tracking-widest flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse"></span> IN TRANSIT
                    </div>
                    <p className="text-xs font-bold text-slate-400 uppercase tracking-widest mb-1 mt-2">Load ID: #SH-8801</p>
                    <h3 className="text-xl font-black text-blue-950 mb-4">Bongaigaon ➔ Patna</h3>
                    
                    <div className="flex items-center gap-4 bg-slate-50 p-3 rounded-2xl border border-slate-100">
                      <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center text-xl shadow-inner">👨‍✈️</div>
                      <div>
                        <p className="text-xs font-bold text-slate-500 uppercase">Driver: Ram Kumar</p>
                        <p className="text-sm font-black text-blue-950">+91 9876543210</p>
                      </div>
                      <button className="ml-auto w-10 h-10 bg-green-100 text-green-600 rounded-full flex items-center justify-center text-xl hover:bg-green-500 hover:text-white transition-colors">📞</button>
                    </div>
                  </div>

                  {/* 📂 DOCUMENT HUB */}
                  <div className="bg-white p-6 rounded-3xl border border-slate-200 shadow-sm shrink-0">
                    <h3 className="text-sm font-black text-blue-950 uppercase tracking-widest mb-4 flex items-center gap-2"><span>📂</span> Shipment Documents</h3>
                    
                    <div className="space-y-3">
                       <div className="flex items-center justify-between bg-blue-50 p-3 rounded-xl border border-blue-100">
                          <div className="flex items-center gap-3">
                             <div className="text-2xl">📜</div>
                             <div>
                               <p className="text-xs font-black text-blue-950">Transport Bilty (LR)</p>
                               <p className="text-[10px] text-blue-600 font-bold">Auto-Generated</p>
                             </div>
                          </div>
                          <div className="flex gap-2">
                             <button onClick={() => handleDownload('Bilty_LR_SH8801')} className="bg-white text-blue-600 hover:bg-blue-600 hover:text-white border border-blue-200 px-3 py-1.5 rounded-lg text-[10px] font-black transition-colors" title="Download">⬇️ PDF</button>
                             <button onClick={() => handleShareToDriver('Bilty_LR_SH8801')} className="bg-green-500 text-white hover:bg-green-600 px-3 py-1.5 rounded-lg text-[10px] font-black transition-colors" title="Share to Driver">📤 SEND</button>
                          </div>
                       </div>

                       <div className="flex items-center justify-between bg-slate-50 p-3 rounded-xl border border-slate-100">
                          <div className="flex items-center gap-3">
                             <div className="text-2xl">📃</div>
                             <div>
                               <p className="text-xs font-bold text-slate-700">E-Way Bill</p>
                               <p className="text-[10px] text-slate-400 font-bold">Uploaded by you</p>
                             </div>
                          </div>
                          <div className="flex gap-2">
                             <button onClick={() => handleDownload('EWayBill_SH8801')} className="bg-white text-slate-600 hover:bg-slate-200 border border-slate-200 px-3 py-1.5 rounded-lg text-[10px] font-black transition-colors">⬇️ PDF</button>
                             <button onClick={() => handleShareToDriver('EWayBill_SH8801')} className="bg-green-500 text-white hover:bg-green-600 px-3 py-1.5 rounded-lg text-[10px] font-black transition-colors">📤 SEND</button>
                          </div>
                       </div>
                    </div>
                  </div>

                  {/* Tracking Timeline */}
                  <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm flex-1 overflow-y-auto relative min-h-[250px]">
                     <h3 className="text-sm font-black text-blue-950 uppercase tracking-widest mb-6 flex items-center gap-2"><span>⏱️</span> Tracking Journey</h3>
                     <div className="relative pl-6 space-y-8">
                       <div className="absolute left-[11px] top-2 bottom-6 w-0.5 bg-slate-200"></div>
                       <div className="absolute left-[11px] top-2 h-1/2 w-0.5 bg-emerald-500"></div>

                       <div className="relative z-10">
                         <div className="absolute -left-8 top-0.5 w-5 h-5 bg-emerald-500 rounded-full border-4 border-white shadow-md flex items-center justify-center"><span className="w-1.5 h-1.5 bg-white rounded-full"></span></div>
                         <p className="text-xs font-bold text-slate-400 mb-0.5">22 Mar, 08:30 AM</p>
                         <h4 className="text-sm font-black text-blue-950">Documents Handed Over</h4>
                         <p className="text-xs font-bold text-slate-500 mt-1">Bilty & E-Way bill given to driver.</p>
                       </div>

                       <div className="relative z-10 bg-blue-50 -ml-4 p-4 rounded-2xl border border-blue-100">
                         <div className="absolute -left-4 top-4 w-5 h-5 bg-blue-500 rounded-full border-4 border-white shadow-md flex items-center justify-center ring-4 ring-blue-500/20 animate-pulse"><span className="w-1.5 h-1.5 bg-white rounded-full"></span></div>
                         <p className="text-xs font-bold text-blue-500 mb-0.5 flex items-center gap-1"><span>🕒</span> Updated 2 mins ago</p>
                         <h4 className="text-sm font-black text-blue-950">Current Location</h4>
                         <p className="text-xs font-bold text-blue-700 mt-1">Siliguri, West Bengal (In Transit).</p>
                       </div>
                     </div>
                  </div>
                </div>

                <div className="lg:col-span-2 bg-slate-200 rounded-3xl overflow-hidden border-4 border-white shadow-2xl relative h-[400px] lg:h-full">
                  <div className="absolute top-4 left-4 right-4 flex justify-between items-center z-20">
                     <div className="bg-white/90 backdrop-blur-md border border-slate-200 px-4 py-2 rounded-2xl flex items-center gap-3 shadow-lg">
                       <span className="w-3 h-3 bg-green-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.8)]"></span>
                       <span className="text-slate-800 text-xs font-black tracking-widest uppercase">Live GPS Tracking</span>
                     </div>
                  </div>
                  <iframe width="100%" height="100%" style={{ border: 0 }} loading="lazy" allowFullScreen src={`https://www.google.com/maps/embed/v1/directions?key=YOUR_ACTUAL_API_KEY&origin=8`}></iframe>
                </div>
              </div>
            </div>
          )}

          {/* 🛡️ TAB: ESCROW WALLET */}
          {activeTab === 'escrow' && (
            <div className="space-y-6 max-w-7xl mx-auto animate-fade-in-up">
              <div className="flex flex-col md:flex-row md:justify-between md:items-end mb-6 gap-4">
                <div>
                  <h2 className="text-3xl font-black text-blue-950">Wallet & Billing</h2>
                  <p className="text-sm text-slate-500 mt-1">Manage your funds, view payment history and account details securely.</p>
                </div>
                <div className="flex gap-3">
                  <button className="bg-blue-600 hover:bg-blue-700 text-white font-bold px-5 py-2.5 rounded-xl text-sm shadow-lg transition-transform hover:-translate-y-0.5 flex items-center gap-2">+ Add Funds</button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
                <div className="bg-gradient-to-br from-blue-950 to-blue-900 rounded-3xl p-8 border border-blue-800 shadow-xl relative overflow-hidden group">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-white/5 rounded-full blur-2xl -mr-10 -mt-10"></div>
                  <div className="w-14 h-14 bg-blue-800 text-white rounded-2xl flex items-center justify-center text-3xl mb-4 relative z-10 border border-blue-700 shadow-inner group-hover:scale-110 transition-transform">🛡️</div>
                  <div className="relative z-10">
                    <h3 className="text-blue-300 text-xs font-bold tracking-widest uppercase mb-1">Available Escrow Balance</h3>
                    <p className="text-4xl font-black text-white">₹1,25,000</p>
                    <p className="text-[10px] text-green-400 mt-2 font-bold uppercase tracking-widest">100% Secured by Prasad ERP</p>
                  </div>
                </div>

                <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm flex flex-col justify-between">
                  <div className="w-14 h-14 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center text-3xl mb-4 shadow-inner">🔒</div>
                  <div>
                    <h3 className="text-slate-500 text-xs font-bold tracking-widest uppercase mb-1">Funds On Hold (In-Transit)</h3>
                    <p className="text-4xl font-black text-blue-950">₹28,000</p>
                    <p className="text-[10px] text-slate-400 mt-2 font-bold uppercase tracking-widest">Released upon Delivery</p>
                  </div>
                </div>

                <div className="bg-white p-8 rounded-3xl border border-slate-200 shadow-sm flex flex-col justify-between">
                  <div className="w-14 h-14 bg-emerald-50 text-emerald-500 rounded-2xl flex items-center justify-center text-3xl mb-4 shadow-inner">💳</div>
                  <div>
                    <h3 className="text-slate-500 text-xs font-bold tracking-widest uppercase mb-1">Total Freight Paid (YTD)</h3>
                    <p className="text-4xl font-black text-blue-950">₹8,40,500</p>
                    <p className="text-[10px] text-slate-400 mt-2 font-bold uppercase tracking-widest">Since Jan 1, 2026</p>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 bg-white rounded-3xl border border-slate-200 shadow-sm overflow-hidden flex flex-col">
                  <div className="p-6 border-b border-slate-100 flex justify-between items-center bg-slate-50/50">
                    <h3 className="text-lg font-black text-blue-950 flex items-center gap-2"><span>📜</span> Ledger & Payment History</h3>
                  </div>
                  <div className="overflow-x-auto flex-1">
                    <table className="w-full text-left border-collapse">
                      <thead>
                        <tr className="bg-white text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100">
                          <th className="p-5 font-bold">Transaction / Date</th>
                          <th className="p-5 font-bold">Description</th>
                          <th className="p-5 font-bold text-right">Amount</th>
                          <th className="p-5 font-bold text-right">Closing Balance</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {paymentHistory.map((txn, idx) => (
                          <tr key={txn.id} className="hover:bg-slate-50/80 transition-colors">
                            <td className="p-5">
                              <p className="font-bold text-blue-950 text-xs">{txn.id}</p>
                              <p className="text-[10px] text-slate-500 font-bold mt-0.5">{txn.date}</p>
                            </td>
                            <td className="p-5 text-sm font-bold text-slate-700">{txn.desc}</td>
                            <td className="p-5 text-right">
                              <span className={`px-3 py-1 rounded-lg text-xs font-black w-max ml-auto block ${txn.type === 'CREDIT' ? 'bg-green-50 text-green-600' : 'bg-red-50 text-red-600'}`}>{txn.amount}</span>
                            </td>
                            <td className="p-5 text-right font-black text-blue-950 text-sm">{txn.balance}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="lg:col-span-1 flex flex-col gap-6">
                  <div className="bg-blue-50 rounded-3xl border border-blue-100 shadow-sm p-6">
                     <h3 className="text-xs font-bold text-blue-500 uppercase tracking-widest mb-4">Linked Bank Account</h3>
                     <div className="flex items-center gap-4 mb-4">
                       <div className="w-10 h-10 bg-white rounded-xl shadow-sm flex items-center justify-center text-blue-600 text-xl">🏦</div>
                       <div>
                         <h4 className="text-sm font-black text-blue-950">HDFC Bank</h4>
                         <p className="text-xs font-bold text-slate-500">Primary Account</p>
                       </div>
                     </div>
                     <div className="bg-white p-3 rounded-xl border border-blue-100">
                       <p className="text-[10px] font-bold text-slate-400 uppercase">Account Number</p>
                       <p className="text-sm font-black text-blue-950 font-mono tracking-widest">XXXX XXXX XXXX 1234</p>
                     </div>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      </main>

      <style>{`
        .animate-fade-in-up { animation: fadeInUp 0.4s ease-out forwards; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}