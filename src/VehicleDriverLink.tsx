// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc } from 'firebase/firestore';
import { db } from './firebase'; 

export default function VehicleDriverLink() {
  const VEHICLE_COLLECTION_NAME = "VEHICLES"; 
  const DRIVER_COLLECTION_NAME = "DRIVERS";   

  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [records, setRecords] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form States
  const [selectedVehicleName, setSelectedVehicleName] = useState('');
  const [selectedDriverName, setSelectedDriverName] = useState('');
  const [assignDate, setAssignDate] = useState(new Date().toISOString().split('T')[0]);

  // 🌟 NEW: List Search State
  const [listSearch, setListSearch] = useState('');

  const fetchData = async () => {
    try {
      const vSnap = await getDocs(collection(db, VEHICLE_COLLECTION_NAME));
      setVehicles(vSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      const dSnap = await getDocs(collection(db, DRIVER_COLLECTION_NAME));
      setDrivers(dSnap.docs.map(doc => ({ id: doc.id, ...doc.data() })));

      const rSnap = await getDocs(collection(db, 'Vehicle_Assignments'));
      const rData = rSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      rData.sort((a: any, b: any) => new Date(b.assignDate).getTime() - new Date(a.assignDate).getTime());
      setRecords(rData);

    } catch (error) {
      console.error("Data Fetch Error:", error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedVehicleName || !selectedDriverName || !assignDate) {
      alert("⚠️ कृपया सभी जानकारी भरें!"); return;
    }
    
    setIsSubmitting(true);
    try {
      // 🔍 Find IDs based on the typed/selected names
      const vObj = vehicles.find(v => (v.vehicle_no || v.vehical_no || v.registration_no || '').toUpperCase() === selectedVehicleName.toUpperCase());
      
      // Driver list has name + mobile, so we extract just the name part
      const rawDriverName = selectedDriverName.split('(')[0].trim().toUpperCase();
      const dObj = drivers.find(d => (d.name || '').toUpperCase() === rawDriverName || (d.name || '').toUpperCase() === selectedDriverName.toUpperCase());
      
      const vId = vObj ? vObj.id : 'CUSTOM_VEHICLE';
      const dId = dObj ? dObj.id : 'CUSTOM_DRIVER';
      const vName = vObj ? (vObj.vehicle_no || vObj.vehical_no || vObj.registration_no) : selectedVehicleName.toUpperCase();
      const dName = dObj ? dObj.name : rawDriverName;
      const dMobile = dObj ? (dObj.mobile || dObj.mobile_no || dObj.phone || '') : '';

      await addDoc(collection(db, 'Vehicle_Assignments'), {
        vehicleId: vId,
        vehicleName: vName,
        driverId: dId,
        driverName: dName,
        driverMobile: dMobile, // 🔥 Added Mobile Save
        assignDate: assignDate,
        status: 'LINKED',
        assignedAt: new Date().toISOString()
      });

      setSelectedVehicleName(''); 
      setSelectedDriverName(''); 
      fetchData(); 
      alert("✅ सफलतापूर्वक! गाड़ी और ड्राइवर लिंक हो गए हैं।");

    } catch (error) {
      console.error("Save Error:", error);
      alert("❌ डेटा सेव नहीं हो पाया!");
    } finally {
      setIsSubmitting(false);
    }
  };

  // 🔥 FILTER LOGIC FOR THE LIST
  const filteredRecords = records.filter(r => {
    const q = listSearch.toLowerCase();
    const dMob = r.driverMobile || (drivers.find(d => d.name === r.driverName)?.mobile) || '';
    return (
      (r.vehicleName || '').toLowerCase().includes(q) ||
      (r.driverName || '').toLowerCase().includes(q) ||
      dMob.toLowerCase().includes(q)
    );
  });

  if (loading) return <div style={{ color: '#38bdf8', padding: '40px', textAlign: 'center', fontSize: '20px', background: 'radial-gradient(circle at top left, #0f172a, #020617)', height: '100vh' }}>Loading Live Database...</div>;

  const inputStyle = { background: 'rgba(15, 23, 42, 0.6)', color: '#fff', border: '1px solid rgba(51, 65, 85, 0.8)', padding: '12px 16px', borderRadius: '10px', outline: 'none', fontSize: '14px', width: '100%', boxSizing: 'border-box' as const };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)' }}>
      
      {/* 🚀 Header */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: '30px', gap: '15px' }}>
        <h1 style={{ background: 'linear-gradient(135deg, #38bdf8, #818cf8, #c084fc)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontSize: '38px', fontWeight: '900', margin: 0, letterSpacing: '-1px' }}>
          Fleet Command: Assign Driver
        </h1>
        <div style={{ flex: 1, height: '1px', background: 'linear-gradient(90deg, #1e293b, transparent)' }}></div>
      </div>

      {/* 🛸 HORIZONTAL FORM CARD */}
      <div style={{ background: 'rgba(30, 41, 59, 0.4)', backdropFilter: 'blur(12px)', border: '1px solid rgba(56, 189, 248, 0.4)', borderRadius: '20px', padding: '25px', marginBottom: '30px', boxShadow: '0 10px 30px -10px rgba(56, 189, 248, 0.25)' }}>
        <form onSubmit={handleLinkSubmit} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '25px', alignItems: 'end' }}>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ color: '#38bdf8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>Search & Select Vehicle *</label>
            <input 
              list="vehicle-search-list" 
              placeholder="Type Vehicle No..." 
              value={selectedVehicleName} 
              onChange={(e) => setSelectedVehicleName(e.target.value.toUpperCase())} 
              required 
              style={{...inputStyle, borderColor: '#38bdf8'}} 
              autoComplete="off"
            />
            <datalist id="vehicle-search-list">
              {vehicles.map(v => {
                 const vno = v.vehicle_no || v.vehical_no || v.registration_no;
                 return vno ? <option key={v.id} value={vno} /> : null;
              })}
            </datalist>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ color: '#10b981', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>Search & Select Driver *</label>
            <input 
              list="driver-search-list" 
              placeholder="Type Driver Name or Mobile..." 
              value={selectedDriverName} 
              onChange={(e) => setSelectedDriverName(e.target.value)} 
              required 
              style={{...inputStyle, borderColor: '#10b981'}} 
              autoComplete="off"
            />
            <datalist id="driver-search-list">
              {drivers.filter(d => d.status === 'ACTIVE').map(d => (
                <option key={d.id} value={`${d.name} (${d.mobile || d.mobile_no || d.phone || 'No Mobile'})`} />
              ))}
            </datalist>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ color: '#f59e0b', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase' }}>Assignment Date *</label>
            <input 
              type="date" 
              value={assignDate} 
              onChange={(e) => setAssignDate(e.target.value)} 
              required 
              style={{...inputStyle, borderColor: '#f59e0b', colorScheme: 'dark'}} 
            />
          </div>

          <button type="submit" disabled={isSubmitting} style={{ background: 'linear-gradient(135deg, #3b82f6, #6366f1)', color: 'white', border: 'none', padding: '12px 25px', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s', boxShadow: '0 0 15px rgba(59, 130, 246, 0.3)', height: '46px', fontSize: '14px' }} onMouseOver={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 0 25px rgba(59, 130, 246, 0.6)'; }} onMouseOut={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 0 15px rgba(59, 130, 246, 0.3)'; }}>
            {isSubmitting ? '⏳ SAVING...' : '➕ ASSIGN & LINK'}
          </button>

        </form>
      </div>

      {/* 🔍 SMART LIST SEARCH BAR */}
      <div style={{ marginBottom: '20px' }}>
        <input 
          type="text" 
          placeholder="🔍 Search List by Vehicle No, Driver Name, or Mobile No..." 
          value={listSearch} 
          onChange={(e) => setListSearch(e.target.value)} 
          style={{...inputStyle, borderColor: '#64748b', fontSize: '15px'}} 
        />
      </div>

      {/* 📋 RECORDS LIST */}
      <div style={{ background: 'rgba(15, 23, 42, 0.4)', border: '1px solid rgba(255, 255, 255, 0.08)', borderRadius: '20px', overflow: 'hidden' }}>
        
        {/* Table Header */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.5fr 1fr 1fr', padding: '15px 25px', background: 'rgba(0,0,0,0.3)', borderBottom: '2px solid #334155', color: '#f59e0b', fontSize: '11px', fontWeight: '900', textTransform: 'uppercase', letterSpacing: '1px' }}>
          <div>Vehicle Identity</div>
          <div>Assigned Driver</div>
          <div>Date of Assignment</div>
          <div style={{ textAlign: 'right' }}>System Status</div>
        </div>

        {/* Table Body */}
        {filteredRecords.length === 0 ? (
           <div style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>No matching records found.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {filteredRecords.map((r, index) => {
              
              // Get Mobile No (Fallback to Driver DB if old record doesn't have it saved)
              const mob = r.driverMobile || (drivers.find(d => d.name === r.driverName)?.mobile) || (drivers.find(d => d.name === r.driverName)?.mobile_no) || 'N/A';

              return (
              <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1.5fr 1.5fr 1fr 1fr', padding: '20px 25px', borderBottom: index === filteredRecords.length - 1 ? 'none' : '1px solid rgba(255,255,255,0.05)', alignItems: 'center', transition: '0.2s' }} onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'} onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}>
                
                {/* Vehicle Column */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                  <div style={{ width: '45px', height: '45px', borderRadius: '50%', border: '2px solid #38bdf8', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#38bdf8', background: '#1e293b', fontSize: '20px' }}>🚛</div>
                  <div>
                    <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '16px' }}>{r.vehicleName}</div>
                    <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '2px' }}>Asset Attached</div>
                  </div>
                </div>

                {/* Driver Column */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                  <div style={{ width: '45px', height: '45px', borderRadius: '50%', border: '2px solid #10b981', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#10b981', background: '#1e293b', fontSize: '20px' }}>👨‍✈️</div>
                  <div>
                    <div style={{ color: '#fff', fontWeight: 'bold', fontSize: '16px' }}>{r.driverName}</div>
                    {/* 🔥 Added Driver Mobile Display */}
                    <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      📞 {mob}
                    </div>
                  </div>
                </div>

                {/* Date Column */}
                <div style={{ color: '#cbd5e1', fontSize: '14px', fontWeight: 'bold' }}>
                  {r.assignDate}
                </div>

                {/* Status Column */}
                <div style={{ textAlign: 'right' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', padding: '6px 12px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold', border: '1px solid #10b981' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#10b981', boxShadow: '0 0 5px #10b981' }}></span>
                    LINKED ACTIVE
                  </span>
                </div>

              </div>
            )})}
          </div>
        )}
      </div>

    </div>
  );
}