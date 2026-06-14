// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, query, where, getDocs, addDoc, serverTimestamp, orderBy } from 'firebase/firestore';
import { db } from './firebase';

interface FleetPartnerPortalProps {
  onBack?: () => void;
}

export default function FleetPartnerPortal({ onBack }: FleetPartnerPortalProps) {
  const [activeTab, setActiveTab] = useState('profile');
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // 🏢 VENDOR PROFILE & KYC STATE
  const [profile, setProfile] = useState({
    agencyName: '',
    ownerName: '',
    mobileNo: '',
    email: '',
    address: '',
    gstNumber: '',
    panNumber: '',
    aadharNumber: '',
    status: 'NEW', // NEW -> PENDING -> APPROVED
    registeredVehicleTypes: ['Open Body Truck', 'Flatbed Trailer'] // For Smart Match
  });

  // 🌍 LIVE BAZAAR STATES
  const [liveLoads, setLiveLoads] = useState([]);
  const [myBids, setMyBids] = useState([]);
  const [filterMode, setFilterMode] = useState('SMART'); // 'SMART' or 'ALL'
  
  // 📝 BIDDING MODAL STATE
  const [selectedLoad, setSelectedLoad] = useState<any>(null);
  const [bidAmount, setBidAmount] = useState('');
  const [bidRemarks, setBidRemarks] = useState('');

  // 🚛 MY FLEET DATA (Mock Data based on your old screenshots)
  const [myVehicles, setMyVehicles] = useState([
    { id: '1', number: 'AS 26C 9808', type: 'Open Body Truck', status: 'ACTIVE', alerts: [{ text: 'MV Tax expiring in 15 days', type: 'warning' }] },
    { id: '2', number: 'AS 26C 5106', type: 'Closed Container', status: 'ACTIVE', alerts: [{ text: 'National Permit expired', type: 'danger' }] }
  ]);

  // 💰 EARNINGS & WALLET DATA
  const [walletTxns, setWalletTxns] = useState([
    { id: 'TXN-001', date: '22 Mar 2026', desc: 'Advance for Trip TRP-8801', type: 'CREDIT', amount: '+ ₹10,000', balance: '₹10,000' },
    { id: 'TXN-002', date: '20 Mar 2026', desc: 'Toll Deduction (Guwahati)', type: 'DEBIT', amount: '- ₹250', balance: '₹9,750' }
  ]);

  useEffect(() => {
    fetchLiveLoads();
    fetchMyBids();
  }, [profile.agencyName]);

  const fetchLiveLoads = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, "BAZAAR_LOADS"), where("status", "==", "OPEN"));
      const snap = await getDocs(q);
      const loadsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      loadsData.sort((a, b) => b.createdAt - a.createdAt);
      setLiveLoads(loadsData);
    } catch (e) { console.error("Error fetching loads:", e); }
    setLoading(false);
  };

  const fetchMyBids = async () => {
    if(!profile.agencyName) return;
    try {
      const q = query(collection(db, "BAZAAR_BIDS"), where("vendor_name", "==", profile.agencyName));
      const snap = await getDocs(q);
      setMyBids(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error("Error fetching bids:", e); }
  };

  const handleKYCSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if(!profile.agencyName || !profile.panNumber) return alert("Fill all mandatory fields (*).");
    setProfile({ ...profile, status: 'PENDING' });
    alert("✅ Agency Profile Submitted! Pending for Admin Approval.");
    setTimeout(() => {
      setProfile(prev => ({ ...prev, status: 'APPROVED' }));
      fetchMyBids(); // Refetch bids after approval (uses agency name)
    }, 3000);
  };

  const handleSubmitBid = async (e: React.FormEvent) => {
    e.preventDefault();
    if(!bidAmount) return alert("Please enter your bidding amount!");
    setLoading(true);
    try {
      await addDoc(collection(db, "BAZAAR_BIDS"), {
        load_id: selectedLoad.load_id,
        vendor_name: profile.agencyName || 'Test Vendor',
        bid_amount: bidAmount,
        remarks: bidRemarks,
        status: 'PENDING',
        createdAt: serverTimestamp()
      });
      alert(`✅ Bid of ₹${bidAmount} submitted successfully for Load ${selectedLoad.load_id}!`);
      setSelectedLoad(null);
      setBidAmount('');
      setBidRemarks('');
      fetchMyBids();
    } catch (err) { alert("❌ Error submitting bid."); }
    setLoading(false);
  };

  // 🔥 AI SMART MATCH FILTER 🔥
  const displayLoads = filterMode === 'SMART' 
    ? liveLoads.filter(load => profile.registeredVehicleTypes.includes(load.vehicle_type))
    : liveLoads;

  return (
    <div className="min-h-screen flex font-sans selection:bg-[#f97316] selection:text-white" style={{ background: '#080c16', color: 'white' }}>
      
      {/* 🚀 LEFT SIDEBAR (VENDOR THEME) */}
      <aside className={`fixed inset-y-0 left-0 z-50 w-64 bg-[#0d1323] text-white flex flex-col shadow-2xl transition-transform duration-300 lg:relative lg:translate-x-0 border-r border-white/5 ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        
        <div className="p-6 border-b border-white/5 bg-[#111827]">
          <h1 className="text-xl font-black tracking-tighter leading-none m-0 text-[#f97316]">PRASAD</h1>
          <h2 className="text-[10px] font-bold text-white uppercase tracking-widest mt-1">FREIGHT EXCHANGE</h2>
          <button onClick={() => setIsMobileMenuOpen(false)} className="lg:hidden absolute top-5 right-5 text-slate-400">✖</button>
        </div>

        <nav className="flex-1 p-4 space-y-1 overflow-y-auto mt-2">
          <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mb-3 ml-2">Partner Dashboard</p>
          
          <button onClick={() => setActiveTab('overview')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-bold text-sm transition-all ${activeTab === 'overview' ? 'bg-[#f97316] text-white shadow-md' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}>
            <span>📊</span> Overview
          </button>
          
          <button onClick={() => setActiveTab('profile')} className={`w-full flex items-center justify-between px-4 py-3 rounded-lg font-bold text-sm transition-all ${activeTab === 'profile' ? 'bg-[#f97316] text-white shadow-md' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}>
            <div className="flex items-center gap-3"><span>📝</span> Agency Profile</div>
            {profile.status === 'PENDING' && <span className="bg-red-500 text-white text-[9px] px-2 py-0.5 rounded-full animate-pulse">!</span>}
            {profile.status === 'APPROVED' && <span className="text-green-400 text-xs">✔</span>}
          </button>

          <button onClick={() => setActiveTab('bazaar')} className={`w-full flex items-center justify-between px-4 py-3 rounded-lg font-bold text-sm transition-all ${activeTab === 'bazaar' ? 'bg-[#f97316] text-white shadow-md' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}>
            <div className="flex items-center gap-3"><span>🎯</span> Live Load Board</div>
            <span className="bg-blue-500 text-white text-[10px] px-2 py-0.5 rounded-full">{liveLoads.length}</span>
          </button>
          
          <button onClick={() => setActiveTab('fleet')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-bold text-sm transition-all ${activeTab === 'fleet' ? 'bg-[#f97316] text-white shadow-md' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}>
            <span>🚛</span> My Fleet & Vault
          </button>

          <button onClick={() => setActiveTab('wallet')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-bold text-sm transition-all ${activeTab === 'wallet' ? 'bg-[#f97316] text-white shadow-md' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}>
            <span>💰</span> Earnings & Wallet
          </button>

          <div className="pt-4 mt-2 border-t border-white/5">
             <button onClick={() => setActiveTab('support')} className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg font-bold text-sm transition-all ${activeTab === 'support' ? 'bg-[#f97316] text-white shadow-md' : 'text-slate-300 hover:bg-white/5 hover:text-white'}`}>
               <span>📞</span> Help & Support
             </button>
          </div>
        </nav>

        <div className="p-4 border-t border-white/5">
          <button onClick={onBack} className="w-full bg-white/5 hover:bg-red-500/20 text-slate-300 hover:text-red-400 border border-white/10 py-2.5 rounded-lg text-sm font-bold flex items-center justify-center gap-2 transition-all">🚪 Logout</button>
        </div>
      </aside>

      {/* 🚀 MAIN CONTENT AREA */}
      <main className="flex-1 flex flex-col h-screen overflow-hidden relative" style={{ background: '#0a0f1c' }}>
        
        {/* HEADER */}
        <header className="h-16 bg-[#0d1323] border-b border-white/5 flex items-center justify-between px-6 shadow-sm z-10 shrink-0">
          <div className="flex items-center gap-4">
            <button onClick={() => setIsMobileMenuOpen(true)} className="lg:hidden text-2xl text-white">☰</button>
            <h2 className="text-lg font-bold text-white">Partner Portal</h2>
          </div>
          <div className="flex items-center">
             <div className="text-right flex flex-col">
               <span className="text-sm font-bold text-white">admin@prasad.com</span>
               {profile.status === 'APPROVED' ? (
                 <span className="text-[10px] text-green-400 font-bold uppercase">PROFILE ACTIVE</span>
               ) : (
                 <span className="text-[10px] text-[#f97316] font-bold uppercase tracking-widest">PROFILE PENDING</span>
               )}
             </div>
          </div>
        </header>

        {/* SCROLLABLE CONTENT */}
        <div className="flex-1 overflow-y-auto p-6 md:p-10 relative">
          
          {/* ⚠️ LOCK SCREEN IF PROFILE IS NOT APPROVED (Except Profile Tab) */}
          {profile.status !== 'APPROVED' && activeTab !== 'profile' ? (
            <div className="flex items-center justify-center h-full animate-fade-in-up">
              <div className="bg-[#111827] border border-white/5 p-10 rounded-2xl text-center max-w-md shadow-2xl">
                 <div className="text-[#f97316] text-6xl mb-4">⚠️</div>
                 <h2 className="text-xl font-bold text-[#f97316] mb-2">Account Verification Pending</h2>
                 <p className="text-sm text-slate-400 mb-6">Your Agency Profile is currently being reviewed by Prasad Transport Admin. Please wait for admin approval to unlock dashboard features.</p>
                 <button onClick={() => setActiveTab('profile')} className="bg-[#f97316] text-white font-bold px-6 py-2.5 rounded-lg hover:bg-orange-600 transition-colors">Check Profile Status</button>
              </div>
            </div>
          ) : (
            <>
              {/* 📊 TAB: OVERVIEW */}
              {activeTab === 'overview' && (
                <div className="space-y-6 animate-fade-in-up">
                   <h2 className="text-2xl font-bold text-white">Overview Dashboard</h2>
                   <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="bg-[#111827] p-6 rounded-2xl border border-white/5 shadow-md">
                         <p className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-2">Active Vehicles</p>
                         <p className="text-3xl font-black text-white">{myVehicles.length}</p>
                      </div>
                      <div className="bg-[#111827] p-6 rounded-2xl border border-white/5 shadow-md">
                         <p className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-2">Live Bids Submitted</p>
                         <p className="text-3xl font-black text-blue-400">{myBids.length}</p>
                      </div>
                      <div className="bg-[#111827] p-6 rounded-2xl border border-white/5 shadow-md border-l-4 border-l-[#f97316]">
                         <p className="text-xs text-slate-400 uppercase tracking-widest font-bold mb-2">Wallet Balance</p>
                         <p className="text-3xl font-black text-green-400">₹10,000</p>
                      </div>
                   </div>
                </div>
              )}

              {/* 📝 TAB: AGENCY PROFILE & KYC */}
              {activeTab === 'profile' && (
                <div className="max-w-4xl mx-auto animate-fade-in-up">
                  <div className="mb-6">
                    <h2 className="text-2xl font-bold text-white">Agency Profile & KYC</h2>
                    <p className="text-sm text-slate-400 mt-1">Register your transport agency to start bidding and adding vehicles.</p>
                  </div>

                  <div className="bg-[#111827] rounded-2xl border border-white/5 p-8 shadow-xl">
                    <form onSubmit={handleKYCSubmit} className="space-y-8">
                      <div>
                        <h3 className="text-sm font-bold text-[#f97316] uppercase tracking-widest mb-4 flex items-center gap-2"><span>🏢</span> Transport Agency Details</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                          <div className="md:col-span-2">
                            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Agency / Transporter Name *</label>
                            <input type="text" value={profile.agencyName} onChange={e => setProfile({...profile, agencyName: e.target.value})} disabled={profile.status !== 'NEW'} className="w-full bg-[#0a0f1c] border border-white/10 p-3 rounded-lg text-sm text-white outline-none focus:border-[#f97316] disabled:opacity-50" />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Owner Name *</label>
                            <input type="text" value={profile.ownerName} onChange={e => setProfile({...profile, ownerName: e.target.value})} disabled={profile.status !== 'NEW'} className="w-full bg-[#0a0f1c] border border-white/10 p-3 rounded-lg text-sm text-white outline-none focus:border-[#f97316] disabled:opacity-50" />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Registered Mobile *</label>
                            <input type="tel" value={profile.mobileNo} onChange={e => setProfile({...profile, mobileNo: e.target.value})} disabled={profile.status !== 'NEW'} className="w-full bg-[#0a0f1c] border border-white/10 p-3 rounded-lg text-sm text-white outline-none focus:border-[#f97316] disabled:opacity-50" />
                          </div>
                        </div>
                      </div>

                      <div>
                        <h3 className="text-sm font-bold text-[#f97316] uppercase tracking-widest mb-4 flex items-center gap-2"><span>📄</span> Tax & Registration Details</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                          <div>
                            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">GST Number (If Any)</label>
                            <input type="text" value={profile.gstNumber} onChange={e => setProfile({...profile, gstNumber: e.target.value})} disabled={profile.status !== 'NEW'} className="w-full bg-[#0a0f1c] border border-white/10 p-3 rounded-lg text-sm text-white outline-none focus:border-[#f97316] disabled:opacity-50 uppercase" />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-emerald-500 uppercase mb-2">PAN Number *</label>
                            <input type="text" value={profile.panNumber} onChange={e => setProfile({...profile, panNumber: e.target.value})} disabled={profile.status !== 'NEW'} className="w-full bg-[#0a0f1c] border border-emerald-500/50 p-3 rounded-lg text-sm text-white outline-none focus:border-emerald-500 disabled:opacity-50 uppercase" />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Aadhar Number</label>
                            <input type="text" value={profile.aadharNumber} onChange={e => setProfile({...profile, aadharNumber: e.target.value})} disabled={profile.status !== 'NEW'} className="w-full bg-[#0a0f1c] border border-white/10 p-3 rounded-lg text-sm text-white outline-none focus:border-[#f97316] disabled:opacity-50" />
                          </div>
                        </div>
                      </div>

                      {profile.status === 'NEW' && (
                        <div className="flex justify-end pt-4">
                          <button type="submit" className="bg-[#f97316] hover:bg-orange-600 text-white font-bold px-8 py-3 rounded-lg transition-all">Submit KYC for Approval</button>
                        </div>
                      )}
                    </form>
                  </div>
                </div>
              )}

              {/* 🎯 TAB: LIVE LOAD BAZAAR (THE SMART MATCHING FEATURE) */}
              {activeTab === 'bazaar' && (
                <div className="space-y-6 animate-fade-in-up">
                  
                  {/* HEADER & SMART FILTER */}
                  <div className="flex flex-col md:flex-row justify-between md:items-end gap-4 mb-6">
                    <div>
                      <h2 className="text-2xl font-bold text-white">Live Load Bazaar</h2>
                      <p className="text-sm text-slate-400 mt-1">Bid on premium loads directly from Prasad Transport.</p>
                    </div>
                    
                    {/* 🔥 THE AI SMART TOGGLE 🔥 */}
                    <div className="flex flex-col items-end">
                       <div className="bg-[#111827] p-1 rounded-lg border border-white/10 flex">
                         <button onClick={() => setFilterMode('SMART')} className={`px-4 py-2 rounded-md text-xs font-bold transition-all ${filterMode === 'SMART' ? 'bg-[#f97316] text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}>🎯 MATCH MY FLEET</button>
                         <button onClick={() => setFilterMode('ALL')} className={`px-4 py-2 rounded-md text-xs font-bold transition-all ${filterMode === 'ALL' ? 'bg-white/10 text-white shadow-lg' : 'text-slate-400 hover:text-white'}`}>🌍 SHOW ALL LOADS</button>
                       </div>
                    </div>
                  </div>

                  {/* ACTIVE FILTER ALERT */}
                  {filterMode === 'SMART' && (
                    <div className="bg-amber-500/10 border border-amber-500/30 p-3 rounded-lg flex items-center gap-3">
                      <span className="text-xl">🤖</span>
                      <div>
                        <p className="text-amber-500 font-bold text-xs">AI is showing loads strictly matching your verified fleet:</p>
                        <p className="text-white text-[10px] font-black mt-1 uppercase">{profile.registeredVehicleTypes.join(' & ')}</p>
                      </div>
                    </div>
                  )}

                  {/* LOADS GRID */}
                  {displayLoads.length === 0 ? (
                    <div className="text-center p-10 bg-[#111827] rounded-2xl border border-white/5">
                      <div className="text-4xl mb-3 opacity-50 grayscale">📭</div>
                      <h3 className="text-lg font-bold text-white mb-2">No Matching Loads Right Now</h3>
                      <p className="text-xs text-slate-400">We will notify you when a load matching your vehicle arrives.</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                      {displayLoads.map(load => {
                        const hasBidded = myBids.some(b => b.load_id === load.load_id);

                        return (
                          <div key={load.id} className="bg-[#111827] border border-white/5 rounded-2xl overflow-hidden hover:border-[#f97316]/50 transition-all shadow-lg flex flex-col">
                            
                            <div className="p-5 border-b border-white/5 bg-white/5 relative">
                              <div className="absolute top-0 right-0 bg-red-500 text-white text-[9px] font-black px-2 py-1 rounded-bl-lg tracking-widest animate-pulse">LIVE</div>
                              <p className="text-[10px] text-slate-400 font-black tracking-widest uppercase mb-3">{load.load_id} • {load.loading_date || 'ASAP'}</p>
                              
                              <div className="flex justify-between items-center">
                                <div>
                                  <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mb-1">Pickup</p>
                                  <h4 className="text-base font-black text-white uppercase">{load.origin}</h4>
                                </div>
                                <div className="text-center text-[#f97316] font-black text-lg px-2">➔</div>
                                <div className="text-right">
                                  <p className="text-[9px] text-slate-500 font-bold uppercase tracking-widest mb-1">Drop</p>
                                  <h4 className="text-base font-black text-white uppercase">{load.destination}</h4>
                                </div>
                              </div>
                            </div>

                            <div className="p-5 flex-1 flex flex-col justify-between">
                               <div className="mb-4">
                                  <div className="flex flex-wrap gap-2 mb-4">
                                    <span className="bg-[#f97316]/10 text-[#f97316] border border-[#f97316]/20 px-2 py-1 rounded text-[10px] font-bold">🚛 {load.vehicle_type}</span>
                                    <span className="bg-blue-500/10 text-blue-400 border border-blue-500/20 px-2 py-1 rounded text-[10px] font-bold">📦 {load.material} ({load.weight}T)</span>
                                  </div>
                                  <p className="text-xs text-slate-400">Target Budget: <span className="text-green-400 font-bold">₹{load.target_rate || 'Open Bidding'}</span></p>
                               </div>

                              {hasBidded ? (
                                <button disabled className="w-full bg-green-500/10 text-green-400 border border-green-500/20 font-bold py-3 rounded-lg text-sm">✅ BID SUBMITTED</button>
                              ) : (
                                <button onClick={() => setSelectedLoad(load)} className="w-full bg-[#f97316] hover:bg-orange-600 text-white font-bold py-3 rounded-lg text-sm transition-colors">PLACE BID 🚀</button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* ⚖️ MY BIDS LIST (Bottom Section) */}
                  <div className="mt-10 pt-6 border-t border-white/10">
                    <h3 className="text-lg font-bold text-white mb-4">My Submitted Bids</h3>
                    {myBids.length === 0 ? (
                      <p className="text-sm text-slate-400">You haven't placed any bids yet.</p>
                    ) : (
                      <div className="space-y-3">
                        {myBids.map(bid => (
                          <div key={bid.id} className="bg-[#111827] border border-white/5 p-4 rounded-xl flex justify-between items-center">
                            <div>
                              <p className="text-[#f97316] font-bold text-xs mb-1">LOAD: {bid.load_id}</p>
                              <p className="text-white font-bold text-sm">Your Bid: ₹ {bid.bid_amount}</p>
                            </div>
                            <div>
                              {bid.status === 'PENDING' && <span className="bg-amber-500/10 text-amber-500 px-2 py-1 rounded text-[10px] font-bold animate-pulse border border-amber-500/20">⏳ PENDING</span>}
                              {bid.status === 'ACCEPTED' && <span className="bg-green-500/10 text-green-400 px-2 py-1 rounded text-[10px] font-bold border border-green-500/20">✅ AWARDED</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* 🚛 TAB: MY FLEET & VAULT (OLD UI RESTORED) */}
              {activeTab === 'fleet' && (
                <div className="max-w-5xl animate-fade-in-up">
                  <div className="flex justify-between items-center mb-6">
                    <div>
                      <h2 className="text-2xl font-bold text-white">My Fleet & Document Vault</h2>
                      <p className="text-sm text-slate-400 mt-1">Manage your trucks and get auto-alerts for document expiry.</p>
                    </div>
                    <button className="bg-white/5 hover:bg-white/10 text-white border border-white/10 px-4 py-2 rounded-lg text-sm font-bold transition-colors">+ Add Vehicle</button>
                  </div>

                  <div className="space-y-4">
                    {myVehicles.map(v => (
                      <div key={v.id} className="bg-[#111827] border border-white/5 p-6 rounded-2xl flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                        <div>
                           <div className="flex items-center gap-3 mb-1">
                             <h3 className="text-xl font-black text-white">{v.number}</h3>
                             <span className="bg-green-500/10 text-green-400 text-[10px] font-bold px-2 py-0.5 rounded border border-green-500/20">{v.status}</span>
                           </div>
                           <p className="text-sm text-slate-400">{v.type}</p>
                        </div>
                        <div className="w-full md:w-auto">
                           {v.alerts.map((a, i) => (
                             <div key={i} className={`text-xs font-bold px-3 py-2 rounded-lg border flex items-center gap-2 ${a.type === 'danger' ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-amber-500/10 text-amber-500 border-amber-500/20'}`}>
                                <span>⚠️</span> {a.text}
                             </div>
                           ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 💰 TAB: EARNINGS & WALLET (OLD UI RESTORED) */}
              {activeTab === 'wallet' && (
                <div className="max-w-4xl animate-fade-in-up">
                  <div className="mb-6">
                    <h2 className="text-2xl font-bold text-white">Earnings & Wallet Ledger</h2>
                    <p className="text-sm text-slate-400 mt-1">View your transaction history and account balance with Prasad Transport.</p>
                  </div>

                  <div className="bg-gradient-to-r from-green-900/40 to-emerald-900/20 border border-green-500/20 rounded-2xl p-8 mb-8">
                     <p className="text-xs text-green-400 font-bold uppercase tracking-widest mb-2">Available Balance</p>
                     <p className="text-4xl font-black text-white">₹ 10,000</p>
                  </div>

                  <div className="bg-[#111827] rounded-2xl border border-white/5 overflow-hidden">
                    <div className="p-5 border-b border-white/5">
                      <h3 className="font-bold text-white">Recent Transactions</h3>
                    </div>
                    <div className="overflow-x-auto">
                       <table className="w-full text-left">
                          <thead className="bg-white/5 text-[10px] text-slate-400 uppercase tracking-widest">
                             <tr>
                               <th className="p-4 font-bold">Date & ID</th>
                               <th className="p-4 font-bold">Description</th>
                               <th className="p-4 font-bold text-right">Amount</th>
                             </tr>
                          </thead>
                          <tbody className="divide-y divide-white/5">
                             {walletTxns.map(t => (
                               <tr key={t.id} className="hover:bg-white/5">
                                 <td className="p-4">
                                   <p className="text-xs font-bold text-white">{t.date}</p>
                                   <p className="text-[10px] text-slate-500">{t.id}</p>
                                 </td>
                                 <td className="p-4 text-sm text-slate-300">{t.desc}</td>
                                 <td className="p-4 text-right">
                                   <span className={`text-sm font-black ${t.type === 'CREDIT' ? 'text-green-400' : 'text-red-400'}`}>{t.amount}</span>
                                 </td>
                               </tr>
                             ))}
                          </tbody>
                       </table>
                    </div>
                  </div>
                </div>
              )}

              {/* 📞 TAB: HELP & SUPPORT (OLD UI RESTORED) */}
              {activeTab === 'support' && (
                <div className="max-w-3xl mx-auto animate-fade-in-up text-center pt-10">
                   <h2 className="text-2xl font-bold text-white mb-2">📞 Help & Support Desk</h2>
                   <p className="text-sm text-slate-400 mb-8">We are here to help you. Contact Prasad Transport Admin directly.</p>
                   
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
                      <div className="bg-[#111827] border border-white/5 p-8 rounded-2xl flex flex-col items-center">
                         <div className="text-3xl mb-3">☎️</div>
                         <p className="text-xs text-slate-400 uppercase tracking-widest mb-1 font-bold">Helpline Number</p>
                         <p className="text-xl font-black text-blue-400">+91 98765 43210</p>
                      </div>
                      <div className="bg-[#111827] border border-white/5 p-8 rounded-2xl flex flex-col items-center">
                         <div className="text-3xl mb-3">✉️</div>
                         <p className="text-xs text-slate-400 uppercase tracking-widest mb-1 font-bold">Email Support</p>
                         <p className="text-xl font-black text-green-400">support@prasad.com</p>
                      </div>
                   </div>

                   <div className="bg-[#111827] border border-[#f97316]/30 p-6 rounded-2xl text-left">
                      <h3 className="font-bold text-[#f97316] mb-2">Raise a Support Ticket</h3>
                      <p className="text-xs text-slate-400 mb-4">Describe your problem below. The Admin team will check your account and reply.</p>
                      <textarea rows={4} placeholder="Type your problem here..." className="w-full bg-[#0a0f1c] border border-white/10 rounded-lg p-4 text-sm text-white outline-none focus:border-[#f97316] resize-none mb-4"></textarea>
                      <div className="text-right">
                         <button className="bg-[#f97316] hover:bg-orange-600 text-white font-bold px-6 py-2 rounded-lg text-sm transition-colors">Send Message to Admin</button>
                      </div>
                   </div>
                </div>
              )}
            </>
          )}

        </div>
      </main>

      {/* 📝 BIDDING MODAL */}
      {selectedLoad && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex justify-center items-center z-[9999] p-4">
          <div className="bg-[#111827] w-full max-w-sm rounded-2xl border border-white/10 shadow-2xl overflow-hidden animate-fade-in-up">
            <div className="p-5 border-b border-white/10 flex justify-between items-center bg-white/5">
              <h2 className="text-lg font-bold text-white">Place Your Bid</h2>
              <button onClick={() => setSelectedLoad(null)} className="text-slate-400 hover:text-red-500 font-bold">✖</button>
            </div>
            
            <div className="p-6">
              <div className="mb-6 flex justify-between items-center">
                <div>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Route</p>
                  <p className="text-sm font-black text-white">{selectedLoad.origin} ➔ {selectedLoad.destination}</p>
                </div>
                <div className="text-right">
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest">Target Rate</p>
                  <p className="text-sm font-black text-green-400">₹ {selectedLoad.target_rate || 'Open'}</p>
                </div>
              </div>

              <form onSubmit={handleSubmitBid} className="space-y-4">
                <div>
                  <label className="block text-xs font-bold text-[#f97316] uppercase mb-2">Your Lowest Rate (₹) *</label>
                  <input type="number" value={bidAmount} onChange={e=>setBidAmount(e.target.value)} placeholder="e.g. 42000" className="w-full bg-[#0a0f1c] border border-white/10 p-3 rounded-lg text-lg font-black text-white outline-none focus:border-[#f97316]" required />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-slate-400 uppercase mb-2">Remarks (Optional)</label>
                  <input type="text" value={bidRemarks} onChange={e=>setBidRemarks(e.target.value)} placeholder="e.g. Open truck available" className="w-full bg-[#0a0f1c] border border-white/10 p-3 rounded-lg text-sm text-white outline-none focus:border-[#f97316]" />
                </div>
                <button type="submit" disabled={loading} className="w-full bg-[#f97316] hover:bg-orange-600 text-white font-bold py-3 rounded-lg mt-2 transition-colors">
                  {loading ? 'SUBMITTING...' : 'SUBMIT BINDING BID'}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .animate-fade-in-up { animation: fadeInUp 0.3s ease-out forwards; }
        @keyframes fadeInUp { from { opacity: 0; transform: translateY(15px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}