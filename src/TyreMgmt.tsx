import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function TyreMgmt() {
  const [activeTab, setActiveTab] = useState('INVENTORY');
  const [tyres, setTyres] = useState<any[]>([]);
  const [fitments, setFitments] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [isTyreModalOpen, setIsTyreModalOpen] = useState(false);
  const [isFitmentModalOpen, setIsFitmentModalOpen] = useState(false);
  const [isRemoveModalOpen, setIsRemoveModalOpen] = useState(false);
  const [selectedFitment, setSelectedFitment] = useState<any>(null);

  // 📝 Tyre Master (Inventory) State
  const [tyreData, setTyreData] = useState({
    serial_no: '', brand: 'MRF', type: 'NEW', cost: '', status: 'IN STOCK', total_km_run: 0
  });

  // 🚛 Tyre Fitment State
  const [fitmentData, setFitmentData] = useState({
    vehicle_no: '', tyre_serial: '', position: 'Front Left (FL)', fitting_km: '', fitment_date: new Date().toISOString().split('T')[0]
  });

  // ✂️ Tyre Removal State
  const [removeData, setRemoveData] = useState({
    removal_km: '', removal_reason: 'SEND FOR RESOLE', removal_date: new Date().toISOString().split('T')[0]
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const vSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const tSnap = await getDocs(collection(db, "TYRE_MASTER"));
      setTyres(tSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const fSnap = await getDocs(collection(db, "TYRE_FITMENTS"));
      setFitments(fSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => new Date(b.fitment_date).getTime() - new Date(a.fitment_date).getTime()));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 💾 1. ADD NEW TYRE TO INVENTORY
  const handleSaveTyre = async () => {
    if (!tyreData.serial_no || !tyreData.cost) return alert("Serial No and Cost are required!");
    try {
      await addDoc(collection(db, "TYRE_MASTER"), { ...tyreData, total_km_run: 0, createdAt: serverTimestamp() });
      alert("✅ Tyre Added to Inventory!");
      setIsTyreModalOpen(false); setTyreData({ serial_no: '', brand: 'MRF', type: 'NEW', cost: '', status: 'IN STOCK', total_km_run: 0 }); fetchData();
    } catch (e) { alert("Error saving tyre."); }
  };

  // 🚛 2. FIT TYRE ON VEHICLE
  const handleFitTyre = async () => {
    if (!fitmentData.vehicle_no || !fitmentData.tyre_serial || !fitmentData.fitting_km) return alert("Fill all fitment details!");
    try {
      // Find the tyre
      const tyre = tyres.find(t => t.serial_no === fitmentData.tyre_serial);
      if (!tyre) return alert("Tyre not found in inventory!");

      // Save Fitment Record
      await addDoc(collection(db, "TYRE_FITMENTS"), { ...fitmentData, status: 'FITTED', createdAt: serverTimestamp() });
      
      // Update Tyre Master Status
      await updateDoc(doc(db, "TYRE_MASTER", tyre.id), { status: 'FITTED' });

      alert("✅ Tyre Fitted on Vehicle!");
      setIsFitmentModalOpen(false); fetchData();
    } catch (e) { alert("Error fitting tyre."); }
  };

  // ✂️ 3. REMOVE TYRE & CALCULATE KM
  const handleRemoveTyre = async () => {
    if (!removeData.removal_km) return alert("Enter Removal KM!");
    try {
      const fittingKm = parseFloat(selectedFitment.fitting_km);
      const removalKm = parseFloat(removeData.removal_km);
      if (removalKm <= fittingKm) return alert("Removal KM must be greater than Fitting KM!");

      const kmRunThisTime = removalKm - fittingKm;
      
      // Find Tyre in Master
      const tyre = tyres.find(t => t.serial_no === selectedFitment.tyre_serial);
      if (!tyre) return alert("Tyre Master record missing!");

      const newTotalKm = (tyre.total_km_run || 0) + kmRunThisTime;
      const newTyreStatus = removeData.removal_reason === 'SCRAP/AUCTION' ? 'SCRAPPED' : 
                            removeData.removal_reason === 'SEND FOR RESOLE' ? 'SENT FOR RESOLE' : 'IN STOCK';

      // Update Fitment Record as REMOVED
      await updateDoc(doc(db, "TYRE_FITMENTS", selectedFitment.id), { 
        ...removeData, status: 'REMOVED', km_yield: kmRunThisTime 
      });

      // Update Tyre Master (Add KM and change status)
      await updateDoc(doc(db, "TYRE_MASTER", tyre.id), { status: newTyreStatus, total_km_run: newTotalKm });

      alert(`✅ Tyre Removed! It ran for ${kmRunThisTime} KMs in this fitment.`);
      setIsRemoveModalOpen(false); setSelectedFitment(null); fetchData();
    } catch (e) { alert("Error removing tyre."); }
  };

  const availableTyres = tyres.filter(t => t.status === 'IN STOCK' || t.status === 'RESOLED');
  const activeFitments = fitments.filter(f => f.status === 'FITTED');
  const fitmentHistory = fitments.filter(f => f.status === 'REMOVED');

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; }
        .glow-btn { background: linear-gradient(135deg, #10b981, #059669); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { box-shadow: 0 4px 15px rgba(16, 185, 129, 0.4); transform: translateY(-2px); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(255,255,255,0.05); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #38bdf8; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        .badge { padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px' }}>Tyre Management System</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Track Tyre Lifecycle: New ➔ Fitment ➔ Resole ➔ Scrap</p>
        </div>
        <div style={{ display: 'flex', gap: '15px' }}>
          <button className="glow-btn" style={{ background: '#f59e0b' }} onClick={() => setIsFitmentModalOpen(true)}>🚛 Fit Tyre to Vehicle</button>
          <button className="glow-btn" onClick={() => setIsTyreModalOpen(true)}>📦 Add Tyre to Stock</button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'FITMENTS' ? 'active' : ''}`} onClick={() => setActiveTab('FITMENTS')}>🚛 LIVE VEHICLE FITMENTS</button>
        <button className={`tab-btn ${activeTab === 'INVENTORY' ? 'active' : ''}`} onClick={() => setActiveTab('INVENTORY')}>📦 TYRE INVENTORY (STOCK)</button>
        <button className={`tab-btn ${activeTab === 'HISTORY' ? 'active' : ''}`} onClick={() => setActiveTab('HISTORY')}>📜 REMOVAL HISTORY</button>
      </div>

      {/* 🚛 TAB 1: LIVE FITMENTS */}
      {activeTab === 'FITMENTS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          <h3 style={{ color: '#38bdf8', marginTop: 0 }}>Tyres Currently Running on Vehicles</h3>
          {loading ? <p style={{ color: '#38bdf8' }}>Loading Data...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Vehicle No</th>
                  <th>Position</th>
                  <th>Tyre Serial No</th>
                  <th>Fitment Date</th>
                  <th>Fitting KM</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {activeFitments.length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', padding: '30px' }}>No active fitments.</td></tr> : 
                  activeFitments.map((f, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>{f.vehicle_no}</td>
                    <td style={{ color: '#f59e0b', fontWeight: 'bold' }}>{f.position}</td>
                    <td style={{ color: '#38bdf8' }}>{f.tyre_serial}</td>
                    <td>{f.fitment_date}</td>
                    <td>{f.fitting_km} KM</td>
                    <td>
                      <button onClick={() => { setSelectedFitment(f); setIsRemoveModalOpen(true); }} style={{ background: '#ef4444', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '5px', cursor: 'pointer', fontWeight: 'bold', fontSize: '11px' }}>
                        ✂️ Remove / Change
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 📦 TAB 2: TYRE INVENTORY */}
      {activeTab === 'INVENTORY' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          <h3 style={{ color: '#38bdf8', marginTop: 0 }}>All Tyres Master Database</h3>
          {loading ? <p style={{ color: '#38bdf8' }}>Loading Inventory...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Serial No</th>
                  <th>Brand</th>
                  <th>Type</th>
                  <th>Total Cost (₹)</th>
                  <th>Total KM Yield</th>
                  <th>Current Status</th>
                </tr>
              </thead>
              <tbody>
                {tyres.length === 0 ? <tr><td colSpan={6} style={{ textAlign: 'center', padding: '30px' }}>No Tyres in Stock.</td></tr> : 
                  tyres.map((t, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>{t.serial_no}</td>
                    <td>{t.brand}</td>
                    <td><span className="badge" style={{ background: t.type === 'NEW' ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)', color: t.type === 'NEW' ? '#10b981' : '#f59e0b' }}>{t.type}</span></td>
                    <td>₹{t.cost}</td>
                    <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>{t.total_km_run} KM</td>
                    <td>
                      <span className="badge" style={{ 
                        background: t.status === 'IN STOCK' ? 'rgba(16,185,129,0.2)' : t.status === 'FITTED' ? 'rgba(56,189,248,0.2)' : 'rgba(239,68,68,0.2)', 
                        color: t.status === 'IN STOCK' ? '#10b981' : t.status === 'FITTED' ? '#38bdf8' : '#ef4444' 
                      }}>{t.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 📜 TAB 3: REMOVAL HISTORY */}
      {activeTab === 'HISTORY' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          <h3 style={{ color: '#38bdf8', marginTop: 0 }}>Tyre Removal & Lifecycle History</h3>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Vehicle</th>
                <th>Serial No</th>
                <th>Position</th>
                <th>Fit KM ➔ Rem KM</th>
                <th>KM Yield (Run)</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {fitmentHistory.map((f, i) => (
                <tr key={i}>
                  <td>{f.removal_date}</td>
                  <td>{f.vehicle_no}</td>
                  <td style={{ color: '#38bdf8' }}>{f.tyre_serial}</td>
                  <td>{f.position}</td>
                  <td style={{ fontSize: '11px', color: '#94a3b8' }}>{f.fitting_km} ➔ {f.removal_km}</td>
                  <td style={{ color: '#10b981', fontWeight: 'bold' }}>{f.km_yield} KM</td>
                  <td style={{ color: '#ef4444', fontSize: '11px', fontWeight: 'bold' }}>{f.removal_reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 📦 MODAL 1: ADD TYRE TO INVENTORY */}
      {isTyreModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #10b981', background: '#0f172a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, color: '#10b981' }}>📦 Add Tyre to Stock</h2>
              <button onClick={() => setIsTyreModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Tyre Serial No * (Unique ID)</label><input className="modern-input" placeholder="e.g. MRF12345" value={tyreData.serial_no} onChange={e=>setTyreData({...tyreData, serial_no: e.target.value})} /></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Brand / Make</label><input className="modern-input" placeholder="Apollo, MRF, CEAT" value={tyreData.brand} onChange={e=>setTyreData({...tyreData, brand: e.target.value})} /></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Tyre Condition Type</label>
                <select className="modern-input" value={tyreData.type} onChange={e=>setTyreData({...tyreData, type: e.target.value})}>
                  <option value="NEW">🆕 Brand New</option>
                  <option value="RESOLED">♻️ Resoled / Retreaded</option>
                  <option value="SECOND_HAND">🔄 Second Hand / Used</option>
                </select>
              </div>
              <div><label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Purchase / Resole Cost (₹) *</label><input type="number" className="modern-input" value={tyreData.cost} onChange={e=>setTyreData({...tyreData, cost: e.target.value})} /></div>
            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '25px', padding: '15px' }} onClick={handleSaveTyre}>✅ Save to Inventory</button>
          </div>
        </div>
      )}

      {/* 🚛 MODAL 2: FIT TYRE TO VEHICLE */}
      {isFitmentModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #f59e0b', background: '#0f172a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, color: '#f59e0b' }}>🚛 Vehicle Tyre Fitment</h2>
              <button onClick={() => setIsFitmentModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Select Vehicle *</label>
                <select className="modern-input" value={fitmentData.vehicle_no} onChange={e=>setFitmentData({...fitmentData, vehicle_no: e.target.value})}>
                  <option value="">-- Choose Vehicle --</option>
                  {vehicles.map(v => <option key={v.id} value={v.vehicle_no}>{v.vehicle_no}</option>)}
                </select>
              </div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Select Tyre from Stock *</label>
                <select className="modern-input" value={fitmentData.tyre_serial} onChange={e=>setFitmentData({...fitmentData, tyre_serial: e.target.value})}>
                  <option value="">-- Choose Available Tyre --</option>
                  {availableTyres.map(t => <option key={t.id} value={t.serial_no}>{t.serial_no} ({t.type})</option>)}
                </select>
              </div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Position on Vehicle *</label>
                <select className="modern-input" value={fitmentData.position} onChange={e=>setFitmentData({...fitmentData, position: e.target.value})}>
                  <option value="Front Left (FL)">Front Left (FL)</option>
                  <option value="Front Right (FR)">Front Right (FR)</option>
                  <option value="Rear Outer Left (ROL)">Rear Outer Left (ROL)</option>
                  <option value="Rear Inner Left (RIL)">Rear Inner Left (RIL)</option>
                  <option value="Rear Outer Right (ROR)">Rear Outer Right (ROR)</option>
                  <option value="Rear Inner Right (RIR)">Rear Inner Right (RIR)</option>
                  <option value="Lift Axle Left (LAL)">Lift Axle Left (LAL)</option>
                  <option value="Lift Axle Right (LAR)">Lift Axle Right (LAR)</option>
                  <option value="Stepney (Spare)">Stepney (Spare)</option>
                </select>
              </div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Fitment Date</label><input type="date" className="modern-input" value={fitmentData.fitment_date} onChange={e=>setFitmentData({...fitmentData, fitment_date: e.target.value})} /></div>
              <div><label style={{ fontSize:'12px', color:'#f59e0b', fontWeight:'bold' }}>Vehicle Meter KM (Fitting KM) *</label><input type="number" className="modern-input" style={{ border: '1px solid #f59e0b' }} value={fitmentData.fitting_km} onChange={e=>setFitmentData({...fitmentData, fitting_km: e.target.value})} placeholder="e.g. 150000" /></div>
            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '25px', padding: '15px', background: '#f59e0b' }} onClick={handleFitTyre}>🔧 Confirm Fitment</button>
          </div>
        </div>
      )}

      {/* ✂️ MODAL 3: REMOVE TYRE & CALCULATE KM */}
      {isRemoveModalOpen && selectedFitment && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #ef4444', background: '#0f172a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, color: '#ef4444' }}>✂️ Remove Tyre</h2>
              <button onClick={() => setIsRemoveModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '8px', marginBottom: '15px' }}>
              <p style={{ margin: '0 0 5px 0', color: '#94a3b8' }}>Removing Tyre <b>{selectedFitment.tyre_serial}</b> from <b>{selectedFitment.vehicle_no}</b> ({selectedFitment.position})</p>
              <p style={{ margin: 0, color: '#38bdf8', fontSize: '12px' }}>Fitted at: <b>{selectedFitment.fitting_km} KM</b></p>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#ef4444', fontWeight:'bold' }}>Current Vehicle Meter KM (Removal KM) *</label>
                <input type="number" className="modern-input" style={{ border: '1px solid #ef4444', fontSize: '18px', fontWeight: 'bold' }} value={removeData.removal_km} onChange={e=>setRemoveData({...removeData, removal_km: e.target.value})} placeholder="e.g. 210000" />
              </div>
              
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Reason for Removal</label>
                <select className="modern-input" value={removeData.removal_reason} onChange={e=>setRemoveData({...removeData, removal_reason: e.target.value})}>
                  <option value="SEND FOR RESOLE">♻️ Send for Resoling (Retread)</option>
                  <option value="PUNCTURE/REPAIR">🛠️ Puncture / Repair (Keep in Stock)</option>
                  <option value="SCRAP/AUCTION">🗑️ Tyre Damaged / Scrap / Auction</option>
                </select>
              </div>

              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Removal Date</label><input type="date" className="modern-input" value={removeData.removal_date} onChange={e=>setRemoveData({...removeData, removal_date: e.target.value})} /></div>
            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '25px', padding: '15px', background: '#ef4444' }} onClick={handleRemoveTyre}>✂️ Confirm Removal & Calc KM</button>
          </div>
        </div>
      )}

    </div>
  );
}