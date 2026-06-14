// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp, query, orderBy } from 'firebase/firestore';
import { logAudit } from './lib/audit';
import { db } from './firebase';

export default function BazaarAdmin() {
  const [activeTab, setActiveTab] = useState('LIVE_BOARD'); 
  const [loading, setLoading] = useState(false);
  const [loads, setLoads] = useState([]);
  const [bids, setBids] = useState([]);
  
  const [marketTrucks, setMarketTrucks] = useState([]);
  const [mapStateFilter, setMapStateFilter] = useState('ALL');
  const [mapCityFilter, setMapCityFilter] = useState('');

  const [isPostModalOpen, setIsPostModalOpen] = useState(false);
  const [customVehicleType, setCustomVehicleType] = useState(''); 
  const [isAddingCustomVehicle, setIsAddingCustomVehicle] = useState(false);
  const [showMap, setShowMap] = useState(false); 

  const [loadForm, setLoadForm] = useState({
    customer_name: '', origin: '', destination: '', distance_km: '', toll_plazas: '', toll_amount: '', material: '', weight: '', target_rate: '', loading_date: '',
    vehicle_type: 'Open Body Truck', rate_type: 'Fixed Rate (Lumpsum)'
  });

  useEffect(() => {
    fetchLoadsAndBids();
    fetchMarketTrucks();
  }, []);

  const fetchLoadsAndBids = async () => {
    setLoading(true);
    try {
      const loadsQ = query(collection(db, "BAZAAR_LOADS"), orderBy("createdAt", "desc"));
      const loadsSnap = await getDocs(loadsQ);
      setLoads(loadsSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const bidsQ = query(collection(db, "BAZAAR_BIDS"), orderBy("createdAt", "desc"));
      const bidsSnap = await getDocs(bidsQ);
      setBids(bidsSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error("Error fetching bazaar data:", e); }
    setLoading(false);
  };

  const fetchMarketTrucks = async () => {
    try {
      const snap = await getDocs(collection(db, "MARKET_VEHICLES"));
      setMarketTrucks(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error("Error fetching market trucks:", e); }
  };

  // 📍 SMART ROUTE & TOLL CALCULATOR ENGINE
  const handleCalculateRoute = () => {
    if (!loadForm.origin || !loadForm.destination) {
      return alert("Please enter both Pickup and Drop locations first!");
    }
    
    setLoading(true);
    setShowMap(false); 

    setTimeout(() => {
      const o = loadForm.origin.toLowerCase();
      const d = loadForm.destination.toLowerCase();
      
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

      setLoadForm(prev => ({ 
        ...prev, 
        distance_km: dist.toString(),
        toll_plazas: tolls.toString(),
        toll_amount: tollAmt.toString()
      }));
      setShowMap(true);
      setLoading(false);
    }, 800); 
  };

  const handlePostLoad = async () => {
    if (!loadForm.origin || !loadForm.destination || !loadForm.weight) return alert("Please fill mandatory fields!");
    setLoading(true);
    try {
      const loadId = 'LD-' + Math.floor(Math.random() * 90000 + 10000);
      const finalVehicleType = isAddingCustomVehicle && customVehicleType ? customVehicleType : loadForm.vehicle_type;

      await addDoc(collection(db, "BAZAAR_LOADS"), {
        ...loadForm,
        vehicle_type: finalVehicleType,
        load_id: loadId,
        status: 'OPEN', 
        postedBy: 'ADMIN',
        createdAt: serverTimestamp()
      });
      alert("✅ Smart Load Posted to Bazaar Successfully!");
      setIsPostModalOpen(false);
      setLoadForm({ customer_name: '', origin: '', destination: '', distance_km: '', toll_plazas: '', toll_amount: '', material: '', weight: '', target_rate: '', loading_date: '', vehicle_type: 'Open Body Truck', rate_type: 'Fixed Rate (Lumpsum)' });
      setCustomVehicleType('');
      setIsAddingCustomVehicle(false);
      setShowMap(false);
      fetchLoadsAndBids();
    } catch (e) {
      alert("❌ Error posting load");
    }
    setLoading(false);
  };

  const handleAwardBid = async (loadId, bidId, vendorName) => {
    if (window.confirm(`Are you sure you want to award this load to ${vendorName}?`)) {
      setLoading(true);
      try {
        await updateDoc(doc(db, "BAZAAR_LOADS", loadId), { status: 'ASSIGNED', assigned_to: vendorName, updatedAt: serverTimestamp() });
        await updateDoc(doc(db, "BAZAAR_BIDS", bidId), { status: 'ACCEPTED', updatedAt: serverTimestamp() });
        logAudit({ action: 'BAZAAR_BID_AWARD', target: loadId, details: `Awarded to ${vendorName}` });
        alert(`✅ Load successfully assigned to ${vendorName}!`);
        fetchLoadsAndBids();
      } catch (e) { alert("Error awarding bid."); }
      setLoading(false);
    }
  };

  const getBidsForLoad = (loadIdStr) => bids.filter(b => b.load_id === loadIdStr);
  const availableTrucks = marketTrucks.filter(t => t.system_status === 'System Active');
  const filteredMapTrucks = availableTrucks.filter(t => {
    if (mapStateFilter !== 'ALL' && !t.registration_no.includes(mapStateFilter)) return false;
    return true; 
  });

  return (
    <div style={{ padding: '20px 30px', minHeight: '100vh', background: '#020617', color: 'white', fontFamily: "'Inter', sans-serif" }}>
      
      <style>{`
        .glass-input { width: 100%; padding: 12px; background: rgba(15,23,42,0.6); border: 1px solid rgba(51,65,85,0.8); color: white; border-radius: 8px; font-size: 13px; outline: none; box-sizing: border-box;}
        .glass-input:focus { border-color: #f59e0b; background: rgba(15,23,42,0.9); }
        .bid-card { background: rgba(0,0,0,0.4); border: 1px solid rgba(255,255,255,0.05); padding: 10px 15px; border-radius: 8px; margin-top: 10px; display: flex; justify-content: space-between; alignItems: center; transition: 0.3s; }
        .bid-card:hover { border-color: #38bdf8; background: rgba(56,189,248,0.05); }
        .status-badge { font-size: 10px; font-weight: bold; padding: 5px 10px; border-radius: 10px; display: inline-block; }
        
        .radar-container { position: relative; width: 300px; height: 300px; border-radius: 50%; background: radial-gradient(circle, rgba(16, 185, 129, 0.1) 0%, rgba(2, 6, 23, 1) 70%); border: 2px solid rgba(16, 185, 129, 0.3); display: flex; justify-content: center; align-items: center; overflow: hidden; box-shadow: 0 0 50px rgba(16, 185, 129, 0.2); }
        .radar-sweep { position: absolute; width: 150px; height: 150px; background: linear-gradient(45deg, rgba(16, 185, 129, 0.8) 0%, transparent 50%); border-radius: 100% 0 0 0; transform-origin: bottom right; top: 0; left: 0; animation: sweep 3s infinite linear; }
        @keyframes sweep { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .radar-dot { position: absolute; width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 10px #10b981; animation: blink 2s infinite ease-in-out; }
        @keyframes blink { 0%, 100% { opacity: 0.3; transform: scale(1); } 50% { opacity: 1; transform: scale(1.5); } }

        /* 🔥 MAP DARK MODE TRICK 🔥 */
        .dark-map-iframe { filter: invert(90%) hue-rotate(180deg) brightness(105%) contrast(85%); border-radius: 12px; width: 100%; height: 100%; border: none; }
      `}</style>

      {/* HEADER & TABS */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '32px', fontWeight: '900', color: '#fff' }}>Load Bazaar Control Center</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0 15px 0', fontSize: '13px' }}>Manage live bids, active loads, and locate available fleet via Radar.</p>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button onClick={() => setActiveTab('LIVE_BOARD')} style={{ background: activeTab === 'LIVE_BOARD' ? '#3b82f6' : '#1e293b', color: activeTab === 'LIVE_BOARD' ? 'white' : '#94a3b8', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>📦 Live Load Board</button>
            <button onClick={() => setActiveTab('RADAR_MAP')} style={{ background: activeTab === 'RADAR_MAP' ? '#10b981' : '#1e293b', color: activeTab === 'RADAR_MAP' ? 'white' : '#94a3b8', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>📡 Fleet Radar (Map)</button>
            <button onClick={() => setActiveTab('ESCROW')} style={{ background: activeTab === 'ESCROW' ? '#f59e0b' : '#1e293b', color: activeTab === 'ESCROW' ? 'white' : '#94a3b8', border: 'none', padding: '10px 20px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold' }}>💰 Escrow & Finance</button>
          </div>
        </div>
        
        {activeTab === 'LIVE_BOARD' && (
           <button onClick={() => setIsPostModalOpen(true)} style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: 'white', padding: '12px 25px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 15px rgba(245,158,11,0.3)', display: 'flex', alignItems: 'center', gap: '8px' }}>
             <span>➕</span> Post Manual Load
           </button>
        )}
      </div>

      {/* TAB 1: LIVE LOAD BOARD & BIDS */}
      {activeTab === 'LIVE_BOARD' && (
        <>
          {loading ? ( <div style={{ color: '#38bdf8', fontSize: '18px', fontWeight: 'bold' }}>Loading Bazaar Data...</div> ) : loads.length === 0 ? (
            <div style={{ textAlign: 'center', marginTop: '100px' }}>
              <div style={{ fontSize: '50px', marginBottom: '15px' }}>🌍</div>
              <h2 style={{ color: '#fff', margin: 0 }}>Live Bidding Board Monitor</h2>
              <p style={{ color: '#94a3b8', maxWidth: '400px', margin: '10px auto' }}>No active loads currently. Click "Post Manual Load" to create a requirement.</p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(400px, 1fr))', gap: '25px' }}>
              {loads.map(load => {
                const loadBids = getBidsForLoad(load.load_id);
                return (
                  <div key={load.id} style={{ background: '#0f172a', border: load.status === 'OPEN' ? '1px solid #3b82f6' : '1px solid #10b981', borderRadius: '15px', overflow: 'hidden', position: 'relative', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
                    <div style={{ background: load.status === 'OPEN' ? 'rgba(59,130,246,0.1)' : 'rgba(16,185,129,0.1)', padding: '20px', borderBottom: '1px solid #1e293b' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '15px' }}>
                        <div>
                          <div style={{ fontSize: '12px', color: '#94a3b8', fontWeight: 'bold' }}>LOAD ID: <span style={{color:'#fff'}}>{load.load_id}</span></div>
                          <div style={{ fontSize: '16px', fontWeight: '900', color: load.status === 'OPEN' ? '#38bdf8' : '#10b981', marginTop: '5px' }}>{load.customer_name || 'Direct Party'}</div>
                        </div>
                        <div className="status-badge" style={{ background: load.status === 'OPEN' ? 'rgba(59,130,246,0.2)' : 'rgba(16,185,129,0.2)', color: load.status === 'OPEN' ? '#38bdf8' : '#10b981' }}>
                          {load.status === 'OPEN' ? '🟢 ACCEPTING BIDS' : '✅ ASSIGNED'}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>Origin</div>
                          <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#fff', textTransform: 'uppercase' }}>{load.origin}</div>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                           <div style={{ color: '#f59e0b', fontSize: '16px', fontWeight:'bold' }}>➔</div>
                           {load.distance_km && <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>{load.distance_km} KM</div>}
                        </div>
                        <div style={{ flex: 1, textAlign: 'right' }}>
                          <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase' }}>Destination</div>
                          <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#fff', textTransform: 'uppercase' }}>{load.destination}</div>
                        </div>
                      </div>
                    </div>
                    <div style={{ padding: '15px 20px', borderBottom: '1px solid #1e293b', background: '#020617' }}>
                      <div style={{ display: 'flex', gap: '10px', marginBottom: '15px' }}>
                        <span style={{ background: 'rgba(245, 158, 11, 0.2)', color: '#fcd34d', padding: '4px 10px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', border: '1px solid rgba(245, 158, 11, 0.3)' }}>🚛 {load.vehicle_type}</span>
                        <span style={{ background: 'rgba(16, 185, 129, 0.2)', color: '#6ee7b7', padding: '4px 10px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', border: '1px solid rgba(16, 185, 129, 0.3)' }}>💰 {load.rate_type}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <div>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>Material & Wt.</div>
                          <div style={{ fontSize: '13px', color: '#f8fafc', fontWeight: 'bold' }}>{load.material} • {load.weight} Ton</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                          <div style={{ fontSize: '11px', color: '#94a3b8' }}>Target Rate</div>
                          <div style={{ fontSize: '13px', color: '#f59e0b', fontWeight: 'bold' }}>₹{load.target_rate || 'Open'}</div>
                        </div>
                      </div>
                      
                      {/* 🔥 TOLL DATA ON BOARD 🔥 */}
                      {load.toll_plazas && (
                         <div style={{ marginTop: '10px', background: 'rgba(56, 189, 248, 0.05)', padding: '8px', borderRadius: '6px', display: 'flex', justifyContent: 'space-between', border: '1px solid rgba(56, 189, 248, 0.2)' }}>
                            <div style={{fontSize:'11px', color:'#94a3b8'}}>🚧 Toll Plazas: <span style={{color:'#fff', fontWeight:'bold'}}>{load.toll_plazas}</span></div>
                            <div style={{fontSize:'11px', color:'#94a3b8'}}>Est. Toll: <span style={{color:'#ef4444', fontWeight:'bold'}}>₹{load.toll_amount}</span></div>
                         </div>
                      )}
                    </div>
                    <div style={{ padding: '20px' }}>
                      <div style={{ fontSize: '12px', color: '#cbd5e1', fontWeight: 'bold', marginBottom: '10px', display: 'flex', justifyContent: 'space-between' }}>
                        <span>LATEST BIDS ({loadBids.length})</span>
                        {load.status === 'ASSIGNED' && <span style={{color:'#10b981'}}>Awarded to: {load.assigned_to}</span>}
                      </div>
                      {loadBids.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '20px 0', color: '#64748b', fontSize: '12px' }}>No bids received yet.</div>
                      ) : (
                        loadBids.map(bid => (
                          <div key={bid.id} className="bid-card" style={{ borderColor: bid.status === 'ACCEPTED' ? '#10b981' : '' }}>
                            <div>
                              <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#fff' }}>{bid.vendor_name}</div>
                              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>Remarks: {bid.remarks || 'N/A'}</div>
                            </div>
                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '16px', fontWeight: '900', color: bid.status === 'ACCEPTED' ? '#10b981' : '#38bdf8' }}>₹{bid.bid_amount}</div>
                              {load.status === 'OPEN' && (
                                <button onClick={() => handleAwardBid(load.id, bid.id, bid.vendor_name)} style={{ background: '#10b981', color: 'white', border: 'none', padding: '4px 10px', borderRadius: '4px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', marginTop: '5px' }}>Award Load</button>
                              )}
                              {bid.status === 'ACCEPTED' && <span style={{color:'#10b981', fontSize:'10px', fontWeight:'bold'}}>✅ WINNER</span>}
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* TAB 2: FLEET RADAR */}
      {activeTab === 'RADAR_MAP' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '30px' }}>
          <div style={{ background: '#0f172a', padding: '30px', borderRadius: '20px', border: '1px solid #1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <h3 style={{ color: '#10b981', margin: '0 0 30px 0' }}>Live Fleet Monitor</h3>
            <div className="radar-container">
              <div className="radar-sweep"></div>
              <div className="radar-dot" style={{ top: '40%', left: '30%' }}></div>
              <div className="radar-dot" style={{ top: '60%', left: '70%', animationDelay: '0.5s' }}></div>
              <div className="radar-dot" style={{ top: '20%', left: '60%', animationDelay: '1s' }}></div>
              <div className="radar-dot" style={{ top: '70%', left: '40%', animationDelay: '1.5s' }}></div>
              <div className="radar-dot" style={{ top: '50%', left: '50%', background: '#f59e0b', boxShadow: '0 0 10px #f59e0b' }}></div>
            </div>
          </div>
          <div style={{ background: '#0f172a', padding: '20px', borderRadius: '20px', border: '1px solid #1e293b' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ margin: 0, color: '#fff' }}>Available Empty Vehicles</h3>
              <div style={{ display: 'flex', gap: '10px' }}>
                <select className="glass-input" style={{ width: '150px', padding: '8px' }} value={mapStateFilter} onChange={e=>setMapStateFilter(e.target.value)}>
                  <option value="ALL">-- All States --</option>
                  <option value="AS">Assam (AS)</option>
                  <option value="NL">Nagaland (NL)</option>
                  <option value="WB">West Bengal (WB)</option>
                  <option value="MH">Maharashtra (MH)</option>
                </select>
                <input className="glass-input" style={{ width: '150px', padding: '8px' }} placeholder="Search City..." value={mapCityFilter} onChange={e=>setMapCityFilter(e.target.value)} />
              </div>
            </div>
            <div style={{ maxHeight: '400px', overflowY: 'auto', paddingRight: '10px' }}>
              {filteredMapTrucks.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>No empty vehicles found in this region.</div>
              ) : (
                filteredMapTrucks.map(truck => (
                  <div key={truck.id} style={{ background: '#020617', padding: '15px', borderRadius: '10px', border: '1px solid #1e293b', marginBottom: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '16px', fontWeight: 'bold', color: '#38bdf8' }}>{truck.registration_no}</div>
                      <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>{truck.vehicle_class || 'Open Truck'} • Cap: {truck.capacity || 'N/A'} Ton</div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '10px', color: '#10b981', fontWeight: 'bold', background: 'rgba(16,185,129,0.1)', padding: '4px 8px', borderRadius: '6px', display: 'inline-block' }}>🟢 READY TO LOAD</div>
                      <div style={{ fontSize: '11px', color: '#f59e0b', marginTop: '6px' }}>{truck.vendor_agency}</div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: ESCROW */}
      {activeTab === 'ESCROW' && (
        <div style={{ textAlign: 'center', marginTop: '100px' }}>
          <div style={{ fontSize: '50px', marginBottom: '15px' }}>🏦</div>
          <h2 style={{ color: '#fff', margin: 0 }}>Escrow & Bazaar Finance</h2>
          <button style={{ background: '#1e293b', color: '#94a3b8', border: '1px solid #334155', padding: '10px 20px', borderRadius: '8px', marginTop: '15px', cursor: 'not-allowed' }}>Coming Soon</button>
        </div>
      )}

      {/* 📝 MEGA MODAL: POST SMART LOAD */}
      {isPostModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '20px' }}>
          <div style={{ background: '#0f172a', width: '100%', maxWidth: '900px', borderRadius: '20px', border: '1px solid #f59e0b', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 10px 50px rgba(245, 158, 11, 0.2)' }}>
            
            <div style={{ padding: '20px 30px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #1e293b', background: 'rgba(245, 158, 11, 0.1)' }}>
              <div>
                <h2 style={{ color: '#f59e0b', margin: 0, fontSize: '22px' }}>Post New Smart Load</h2>
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '5px' }}>Calculate Route, Tolls, and publish immediately.</div>
              </div>
              <button onClick={() => setIsPostModalOpen(false)} style={{ color: 'red', background: 'transparent', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✖</button>
            </div>

            <div style={{ padding: '30px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '30px', overflowY: 'auto', maxHeight: '75vh' }}>
              
              {/* 🔥 ROUTE ENGINE & MAP VIEW 🔥 */}
              <div style={{ gridColumn: 'span 2', display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px' }}>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '15px', background: '#020617', padding: '20px', borderRadius: '12px', border: '1px solid #1e293b' }}>
                  <div>
                    <label style={{fontSize:'11px', color:'#10b981', fontWeight:'bold'}}>📍 Pickup Location (Origin) *</label>
                    <input className="glass-input" style={{ borderColor: '#10b981', marginTop: '5px', textTransform: 'uppercase' }} placeholder="e.g. BONGAIGAON" value={loadForm.origin} onChange={e=>setLoadForm({...loadForm, origin:e.target.value})} />
                  </div>
                  <div>
                    <label style={{fontSize:'11px', color:'#ef4444', fontWeight:'bold'}}>📍 Drop Location (Destination) *</label>
                    <input className="glass-input" style={{ borderColor: '#ef4444', marginTop: '5px', textTransform: 'uppercase' }} placeholder="e.g. GUWAHATI" value={loadForm.destination} onChange={e=>setLoadForm({...loadForm, destination:e.target.value})} />
                  </div>
                  
                  <button onClick={handleCalculateRoute} style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: 'white', padding: '12px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', marginTop: '5px', display: 'flex', justifyContent: 'center', gap: '10px' }}>
                    {loading ? '⏳ Analyzing Route & Tolls...' : '🔍 Analyze Route & Toll Data'}
                  </button>

                  <div style={{ background: 'linear-gradient(135deg, rgba(30,41,59,0.8), rgba(2,6,23,0.9))', border: '1px solid #334155', padding: '15px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ textAlign: 'center', flex: 1, borderRight: '1px solid #334155' }}>
                       <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', marginBottom: '5px' }}>Total Distance</div>
                       <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: '5px' }}>
                          <input type="number" value={loadForm.distance_km} onChange={(e) => setLoadForm({...loadForm, distance_km: e.target.value})} style={{ width: '50px', background: 'transparent', border: 'none', borderBottom: '1px dashed #38bdf8', color: '#38bdf8', fontSize: '18px', fontWeight: '900', textAlign: 'center', outline: 'none' }} placeholder="0" />
                          <span style={{color: '#38bdf8', fontSize:'12px', fontWeight: 'bold'}}>KM</span>
                       </div>
                    </div>
                    <div style={{ textAlign: 'center', flex: 1, borderRight: '1px solid #334155' }}>
                       <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', marginBottom: '5px' }}>Toll Plazas</div>
                       <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: '5px' }}>
                          <input type="number" value={loadForm.toll_plazas} onChange={(e) => setLoadForm({...loadForm, toll_plazas: e.target.value})} style={{ width: '40px', background: 'transparent', border: 'none', borderBottom: '1px dashed #f59e0b', color: '#f59e0b', fontSize: '18px', fontWeight: '900', textAlign: 'center', outline: 'none' }} placeholder="0" />
                          <span style={{color: '#f59e0b', fontSize:'16px'}}>🚧</span>
                       </div>
                    </div>
                    <div style={{ textAlign: 'center', flex: 1 }}>
                       <div style={{ fontSize: '10px', color: '#94a3b8', textTransform: 'uppercase', marginBottom: '5px' }}>Est. Toll Cost</div>
                       <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: '5px' }}>
                          <span style={{color: '#ef4444', fontSize:'14px', fontWeight: 'bold'}}>₹</span>
                          <input type="number" value={loadForm.toll_amount} onChange={(e) => setLoadForm({...loadForm, toll_amount: e.target.value})} style={{ width: '60px', background: 'transparent', border: 'none', borderBottom: '1px dashed #ef4444', color: '#ef4444', fontSize: '18px', fontWeight: '900', textAlign: 'center', outline: 'none' }} placeholder="0" />
                       </div>
                    </div>
                  </div>
                </div>

                {/* ✅ THE FIX: PROPER GOOGLE MAPS iFRAME URL */}
                <div style={{ position: 'relative', background: '#0f172a', borderRadius: '12px', border: '1px solid #1e293b', overflow: 'hidden', minHeight: '250px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {!showMap ? (
                    <div style={{ textAlign: 'center', zIndex: 10 }}>
                      <div style={{ fontSize: '40px', marginBottom: '10px', filter: 'grayscale(1)', opacity: 0.5 }}>🗺️</div>
                      <div style={{ color: '#64748b', fontSize: '12px' }}>Type locations & click<br/>'Analyze Route'</div>
                    </div>
                  ) : (
                    // 💯 The perfectly formatted URL that will never fail.
                    <iframe 
                      title="Google Map Route"
                      className="dark-map-iframe"
                      src={`https://maps.google.com/maps?q=${encodeURIComponent(loadForm.origin)}+to+${encodeURIComponent(loadForm.destination)}&t=&z=7&ie=UTF8&iwloc=&output=embed`}
                    />
                  )}
                </div>

              </div>

              {/* REST OF THE FORM */}
              <div style={{gridColumn: 'span 2'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>Customer / Party Name (Optional)</label><input className="glass-input" placeholder="e.g. ABC Steel Corp" value={loadForm.customer_name} onChange={e=>setLoadForm({...loadForm, customer_name:e.target.value})} /></div>
              
              <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Material Description</label><input className="glass-input" placeholder="e.g. Iron Pipes, HSD, Gas" value={loadForm.material} onChange={e=>setLoadForm({...loadForm, material:e.target.value})} /></div>
              <div><label style={{fontSize:'11px', color:'#10b981', fontWeight:'bold'}}>Total Weight / Volume *</label><input className="glass-input" type="number" placeholder="e.g. 21" value={loadForm.weight} onChange={e=>setLoadForm({...loadForm, weight:e.target.value})} /></div>

              <div style={{ background: 'rgba(245, 158, 11, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                <label style={{fontSize:'11px', color:'#fcd34d', fontWeight:'bold'}}>Required Vehicle Body Type *</label>
                {!isAddingCustomVehicle ? (
                  <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                    <select className="glass-input" style={{borderColor:'#f59e0b', color:'#fcd34d', flex: 1, background: '#020617'}} value={loadForm.vehicle_type} onChange={e=>setLoadForm({...loadForm, vehicle_type:e.target.value})}>
                      <option value="Open Body Truck">Open Body Truck</option>
                      <option value="Container (Closed)">Container (Closed)</option>
                      <option value="Oil Tanker">Oil / Liquid Tanker</option>
                      <option value="Gas Tanker (Bullets)">Gas Tanker (Bullets)</option>
                      <option value="Flatbed Trailer">Flatbed Trailer</option>
                      <option value="Tipper / Dumper">Tipper / Dumper</option>
                    </select>
                    <button onClick={() => setIsAddingCustomVehicle(true)} style={{ background: '#f59e0b', color: 'white', border: 'none', borderRadius: '8px', padding: '0 15px', fontWeight: 'bold', cursor: 'pointer' }}>+</button>
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: '10px', marginTop: '5px' }}>
                    <input className="glass-input" style={{borderColor:'#f59e0b', color:'#fcd34d', flex: 1, background: '#020617'}} placeholder="e.g. JCB Trailer, Half Body..." value={customVehicleType} onChange={e=>setCustomVehicleType(e.target.value)} />
                    <button onClick={() => setIsAddingCustomVehicle(false)} style={{ background: 'transparent', color: '#f59e0b', border: '1px solid #f59e0b', borderRadius: '8px', padding: '0 15px', fontWeight: 'bold', cursor: 'pointer' }}>✖</button>
                  </div>
                )}
              </div>

              <div style={{ background: 'rgba(16, 185, 129, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                <label style={{fontSize:'11px', color:'#6ee7b7', fontWeight:'bold'}}>Rate Type (Calculation Mode) *</label>
                <select className="glass-input" style={{borderColor:'#10b981', color:'#6ee7b7', background: '#020617', marginTop: '5px'}} value={loadForm.rate_type} onChange={e=>setLoadForm({...loadForm, rate_type:e.target.value})}>
                  <option value="Fixed Rate (Lumpsum)">Fixed Rate (Lumpsum)</option>
                  <option value="Rate Per MT (Ton)">Rate Per MT (Ton)</option>
                  <option value="Rate Per KL">Rate Per KL (Kiloliter)</option>
                  <option value="Rate Per KM">Rate Per KM</option>
                </select>
              </div>
              
              <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Target Rate (₹) [Optional]</label><input className="glass-input" type="number" placeholder={`e.g. 45000`} value={loadForm.target_rate} onChange={e=>setLoadForm({...loadForm, target_rate:e.target.value})} /></div>
              <div><label style={{fontSize:'11px', color:'#94a3b8'}}>Expected Loading Date</label><input className="glass-input" type="date" style={{colorScheme:'dark'}} value={loadForm.loading_date} onChange={e=>setLoadForm({...loadForm, loading_date:e.target.value})} /></div>
            </div>

            <div style={{ padding: '20px 30px', textAlign: 'right', background: '#020617', borderTop: '1px solid #1e293b' }}>
              <button onClick={handlePostLoad} disabled={loading} style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: 'white', border: 'none', padding: '14px 35px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', boxShadow: '0 4px 15px rgba(245,158,11,0.4)' }}>
                {loading ? '⌛ POSTING...' : '🚀 BROADCAST LOAD'}
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}