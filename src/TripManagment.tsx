// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function TripManagment() {
  const [activeTab, setActiveTab] = useState('ACTIVE'); 
  const [trips, setTrips] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  
  // 🗺️ Google Maps States
  const [selectedMapTrip, setSelectedMapTrip] = useState<any>(null);
  const GOOGLE_MAPS_API_KEY = "***REMOVED-ROTATE-ME***"; // अपनी Key यहाँ डालें

  const [formData, setFormData] = useState({
    trip_id: 'TRP-' + Math.floor(Math.random() * 90000 + 10000),
    vehicle_no: '',
    driver_name: '',
    loading_point: '',
    consignee_name: '',
    start_date: new Date().toISOString().split('T')[0],
    gross_freight: '',
    advance_given: '',
    trip_status: 'IN_TRANSIT',
    billing_status: 'PENDING',
    current_lat: '', // फॉर मैप
    current_lng: ''  // फॉर मैप
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const tripSnap = await getDocs(collection(db, "TRIPS"));
      setTrips(tripSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a:any, b:any) => new Date(b.start_date || b.Loading_Date).getTime() - new Date(a.start_date || a.Loading_Date).getTime()));

      const vehSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vehSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const drvSnap = await getDocs(collection(db, "DRIVERS"));
      setDrivers(drvSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleInputChange = (e: any) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleSaveTrip = async () => {
    if (!formData.vehicle_no || !formData.loading_point) return alert("⚠️ Vehicle No and Loading Point are required!");
    try {
      await addDoc(collection(db, "TRIPS"), { ...formData, created_at: serverTimestamp() });
      alert("✅ New Trip Started & Tracked on Map!");
      setFormData({
        trip_id: 'TRP-' + Math.floor(Math.random() * 90000 + 10000),
        vehicle_no: '', driver_name: '', loading_point: '', consignee_name: '',
        start_date: new Date().toISOString().split('T')[0], gross_freight: '', advance_given: '', trip_status: 'IN_TRANSIT', billing_status: 'PENDING'
      });
      setActiveTab('ACTIVE');
      fetchData();
    } catch (e) { alert("❌ Error saving trip."); }
  };

  const markAsCompleted = async (id: string) => {
    if(window.confirm("Are you sure you want to mark this trip as COMPLETED?")) {
      try {
        await updateDoc(doc(db, "TRIPS", id), { 
          trip_status: 'COMPLETED', 
          unloading_date: new Date().toISOString().split('T')[0] 
        });
        alert("✅ Trip Completed!");
        fetchData();
      } catch(e) { alert("Error completing trip"); }
    }
  };

  // 🗺️ Function to open Google Maps link
  const openLiveTracking = (trip: any) => {
    const origin = encodeURIComponent(trip.loading_point || "");
    const destination = encodeURIComponent(trip.consignee_name || "");
    const url = `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=driving`;
    window.open(url, '_blank');
  };

  const activeTrips = trips.filter(t => t.trip_status !== 'COMPLETED' && t.trip_status !== 'UNLOADED');
  const completedTrips = trips.filter(t => t.trip_status === 'COMPLETED' || t.trip_status === 'UNLOADED');

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; padding: 25px; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 12px; width: 100%; box-sizing: border-box; outline: none; transition: 0.3s; }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; transition: 0.3s; }
        .tab-btn.active { color: #38bdf8; border-bottom: 3px solid #38bdf8; background: rgba(56, 189, 248, 0.1); border-radius: 8px 8px 0 0; }
        .map-frame { width: 100%; height: 400px; border-radius: 15px; border: 2px solid #334155; margin-top: 20px; }
        tr:hover { background: rgba(255,255,255,0.02); }
      `}</style>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px', fontWeight: '900' }}>🚛 Trip Command Center</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Live Tracking & Trip Management with Google Maps</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'ACTIVE' ? 'active' : ''}`} onClick={() => setActiveTab('ACTIVE')}>🟢 LIVE TRACKING ({activeTrips.length})</button>
        <button className={`tab-btn ${activeTab === 'NEW' ? 'active' : ''}`} onClick={() => setActiveTab('NEW')}>➕ START NEW TRIP</button>
        <button className={`tab-btn ${activeTab === 'COMPLETED' ? 'active' : ''}`} onClick={() => setActiveTab('COMPLETED')}>✅ TRIP HISTORY</button>
      </div>

      {activeTab === 'NEW' && (
        <div className="glass-card" style={{ borderTop: '4px solid #38bdf8' }}>
          <h3 style={{ color: '#38bdf8', marginTop: 0, marginBottom: '20px' }}>Dispatch New Vehicle</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px' }}>
            <div><label style={{ color: '#fff', fontSize: '12px' }}>Trip ID</label><input name="trip_id" value={formData.trip_id} readOnly className="modern-input" style={{color:'#64748b'}} /></div>
            <div>
              <label style={{ color: '#fff', fontSize: '12px' }}>Vehicle No *</label>
              <select name="vehicle_no" value={formData.vehicle_no} onChange={handleInputChange} className="modern-input">
                <option value="">-- Choose --</option>
                {vehicles.map(v => <option key={v.id} value={v.vehical_no || v.vehicle_no}>{v.vehical_no || v.vehicle_no}</option>)}
              </select>
            </div>
            <div>
              <label style={{ color: '#fff', fontSize: '12px' }}>Driver</label>
              <select name="driver_name" value={formData.driver_name} onChange={handleInputChange} className="modern-input">
                <option value="">-- Choose --</option>
                {drivers.map(d => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
            </div>
            <div><label style={{ color: '#fff', fontSize: '12px' }}>Origin (From) *</label><input name="loading_point" value={formData.loading_point} onChange={handleInputChange} className="modern-input" placeholder="e.g. Lumding" /></div>
            <div><label style={{ color: '#fff', fontSize: '12px' }}>Destination (To) *</label><input name="consignee_name" value={formData.consignee_name} onChange={handleInputChange} className="modern-input" placeholder="e.g. Chabua" /></div>
            <div><label style={{ color: '#10b981', fontSize: '12px' }}>Freight (₹)</label><input type="number" name="gross_freight" value={formData.gross_freight} onChange={handleInputChange} className="modern-input" /></div>
            <div><label style={{ color: '#f59e0b', fontSize: '12px' }}>Advance (₹)</label><input type="number" name="advance_given" value={formData.advance_given} onChange={handleInputChange} className="modern-input" /></div>
          </div>
          <button onClick={handleSaveTrip} style={{ marginTop: '25px', width: '100%', background: 'linear-gradient(135deg, #3b82f6, #6366f1)', color: '#fff', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '16px' }}>
            🚀 Start Trip & Track Location
          </button>
        </div>
      )}

      {activeTab === 'ACTIVE' && (
        <div style={{ display: 'grid', gridTemplateColumns: selectedMapTrip ? '1fr 1.5fr' : '1fr', gap: '20px' }}>
          <div className="glass-card">
            <h3 style={{ color: '#38bdf8', marginTop: 0 }}>On-Road Vehicles</h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', color: '#cbd5e1', fontSize: '13px' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#38bdf8', borderBottom: '2px solid #334155' }}>
                  <th style={{ padding: '12px' }}>Vehicle</th><th>Route</th><th>Map</th><th>Action</th>
                </tr>
              </thead>
              <tbody>
                {activeTrips.map(t => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #334155' }}>
                    <td style={{ padding: '12px' }}><b style={{color:'#fff'}}>{t.vehicle_no}</b><br/><small>{t.driver_name}</small></td>
                    <td>{t.loading_point} ➔ {t.consignee_name}</td>
                    <td>
                      <button onClick={() => setSelectedMapTrip(t)} style={{ background: 'rgba(56, 189, 248, 0.2)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '4px 8px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px' }}>📍 View</button>
                    </td>
                    <td>
                      <button onClick={() => markAsCompleted(t.id)} style={{ background: '#10b981', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px' }}>Unload</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 🗺️ LIVE GOOGLE MAPS EMBED SECTION */}
          {selectedMapTrip && (
            <div className="glass-card" style={{ borderLeft: '4px solid #38bdf8' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ color: '#fff', margin: 0 }}>📍 Tracking: {selectedMapTrip.vehicle_no}</h3>
                <button onClick={() => setSelectedMapTrip(null)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontWeight: 'bold' }}>Close ✕</button>
              </div>
              <p style={{ color: '#94a3b8', fontSize: '12px', margin: '5px 0' }}>Route: {selectedMapTrip.loading_point} To {selectedMapTrip.consignee_name}</p>
              
              {/* Google Map Iframe for Live Direction */}
              <iframe 
                className="map-frame"
                src={`https://www.google.com/maps/embed/v1/directions?key=${GOOGLE_MAPS_API_KEY}&origin=${selectedMapTrip.loading_point}&destination=${selectedMapTrip.consignee_name}&mode=driving`}
                allowFullScreen
              ></iframe>
              
              <button onClick={() => openLiveTracking(selectedMapTrip)} style={{ width: '100%', marginTop: '15px', background: '#38bdf8', color: '#0f172a', border: 'none', padding: '12px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
                🌐 Open in Google Maps App (Live GPS)
              </button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'COMPLETED' && (
        <div className="glass-card">
          <h3 style={{ color: '#10b981', marginTop: 0 }}>Trip History (Last 50)</h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', color: '#cbd5e1', fontSize: '12px' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#38bdf8', borderBottom: '2px solid #334155' }}>
                <th style={{ padding: '12px' }}>Date</th><th>Trip ID</th><th>Vehicle</th><th>Route</th><th>Freight</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {completedTrips.map(t => (
                <tr key={t.id} style={{ borderBottom: '1px solid #334155' }}>
                  <td style={{ padding: '12px' }}>{t.start_date || t.Loading_Date}</td>
                  <td>{t.trip_id}</td>
                  <td><b>{t.vehicle_no}</b></td>
                  <td>{t.loading_point} ➔ {t.consignee_name}</td>
                  <td style={{ color: '#10b981', fontWeight: 'bold' }}>₹{t.gross_freight}</td>
                  <td><span style={{ background: 'rgba(16,185,129,0.2)', color: '#10b981', padding: '4px 10px', borderRadius: '10px' }}>DELIVERED</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}