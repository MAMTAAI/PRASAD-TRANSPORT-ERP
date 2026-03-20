// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function LocationRtkmMaster() {
  const [routes, setRoutes] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [companies, setCompanies] = useState<string[]>(['Loading...']);

  const [formData, setFormData] = useState({
    Company: '',
    Consignee_ID: 'CON-' + Math.floor(Math.random() * 9000 + 1000),
    Depot_Link: '', // Loading Point
    Registered_Assessee: '', // Customer Name
    Consignee_Name: '', // Petrol Pump / Destination
    Item_Type: 'MS/HSD',
    RTKM_Distance: '',
    Rate_Per_Unit: '',
    Fixed_HSD_Qty: '',
    Fixed_Cash_Amt: '',
    Toll_Amt: ''
  });

  useEffect(() => {
    fetchMasterData();
    fetchRoutes();
  }, []);

  const fetchMasterData = async () => {
    try {
      const cSnap = await getDocs(collection(db, "COMPANY")).catch(() => ({ docs: [] }));
      const cSnap2 = await getDocs(collection(db, "COMPANIES")).catch(() => ({ docs: [] }));
      let compList = [...cSnap.docs, ...cSnap2.docs].map(d => d.data().company_name || d.data().name);
      compList = [...new Set(compList.filter(Boolean))];
      if (compList.length === 0) compList = ['Prasad Transport Pvt Ltd'];
      setCompanies(compList);
      setFormData(prev => ({ ...prev, Company: compList[0] }));
    } catch (error) { console.error(error); }
  };

  const fetchRoutes = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, "RTKM_MASTER"), orderBy("created_at", "desc"));
      const snap = await getDocs(q);
      setRoutes(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) { console.error(error); }
    setLoading(false);
  };

  const handleSaveRoute = async () => {
    if (!formData.Depot_Link || !formData.Consignee_Name || !formData.RTKM_Distance || !formData.Rate_Per_Unit) {
      return alert("⚠️ Please fill Depot, Consignee, RTKM, and Rate!");
    }
    try {
      await addDoc(collection(db, "RTKM_MASTER"), {
        ...formData,
        // Save names in Uppercase for better reporting and matching
        Depot_Link: formData.Depot_Link.toUpperCase(),
        Consignee_Name: formData.Consignee_Name.toUpperCase(),
        Registered_Assessee: formData.Registered_Assessee.toUpperCase(),
        created_at: Timestamp.now()
      });
      alert("✅ Route & Rate Master Saved Successfully!");
      setFormData({
        Company: formData.Company, Consignee_ID: 'CON-' + Math.floor(Math.random() * 9000 + 1000),
        Depot_Link: '', Registered_Assessee: '', Consignee_Name: '', Item_Type: 'MS/HSD',
        RTKM_Distance: '', Rate_Per_Unit: '', Fixed_HSD_Qty: '', Fixed_Cash_Amt: '', Toll_Amt: ''
      });
      fetchRoutes();
    } catch (e) {
      alert("❌ Error saving data.");
    }
  };

  const handleDeleteRoute = async (id: string, routeName: string) => {
    if (window.confirm(`⚠️ Are you sure you want to delete the Master Route: ${routeName}?`)) {
      try {
        await deleteDoc(doc(db, "RTKM_MASTER", id));
        fetchRoutes();
      } catch (error) {
        alert("❌ Error deleting route.");
      }
    }
  };

  const inputStyle = { width: '100%', padding: '10px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', fontSize: '13px', boxSizing: 'border-box' as 'border-box', outline: 'none' };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px', background: 'radial-gradient(circle at top right, #0f172a, #020617)', minHeight: '100vh', padding: '30px' }}>
      
      <div style={{ marginBottom: '25px' }}>
        <h2 style={{ margin: 0, fontSize: '32px', color: '#fff', background: 'linear-gradient(135deg, #38bdf8, #c084fc)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>📍 Customer Location & RTKM Master</h2>
        <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Centralized Database for Routes, Consignees, Distances, and Rates</p>
      </div>

      {/* ✍️ MASTER DATA ENTRY FORM */}
      <div style={{ background: 'rgba(30, 41, 59, 0.4)', border: '1px solid rgba(255, 255, 255, 0.1)', borderRadius: '15px', padding: '25px', marginBottom: '30px', backdropFilter: 'blur(10px)' }}>
        <h3 style={{ margin: '0 0 20px 0', color: '#38bdf8' }}>➕ Add New Route & Rate Contract</h3>
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '20px' }}>
          <div><label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Company</label>
            <select value={formData.Company} onChange={e=>setFormData({...formData, Company: e.target.value})} style={inputStyle}>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div><label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Consignee ID</label><input type="text" value={formData.Consignee_ID} readOnly style={{...inputStyle, background: 'rgba(255,255,255,0.05)', color: '#64748b'}} /></div>
          <div><label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Depot / Loading Point *</label><input type="text" value={formData.Depot_Link} onChange={e=>setFormData({...formData, Depot_Link: e.target.value})} style={{...inputStyle, borderColor: '#10b981'}} placeholder="e.g. GUWAHATI" /></div>
          <div><label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Consignee / Unloading Point *</label><input type="text" value={formData.Consignee_Name} onChange={e=>setFormData({...formData, Consignee_Name: e.target.value})} style={{...inputStyle, borderColor: '#10b981'}} placeholder="e.g. RELIANCE PUMP" /></div>
          <div><label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Customer (Registered Assessee)</label><input type="text" value={formData.Registered_Assessee} onChange={e=>setFormData({...formData, Registered_Assessee: e.target.value})} style={inputStyle} placeholder="Billing Party Name" /></div>
          <div><label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Item Type</label><input type="text" value={formData.Item_Type} onChange={e=>setFormData({...formData, Item_Type: e.target.value})} style={inputStyle} /></div>
          <div><label style={{ color: '#f59e0b', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>RTKM Distance *</label><input type="number" value={formData.RTKM_Distance} onChange={e=>setFormData({...formData, RTKM_Distance: e.target.value})} style={{...inputStyle, borderColor: '#f59e0b', color: '#f59e0b', fontWeight: 'bold'}} placeholder="e.g. 450" /></div>
          <div><label style={{ color: '#f59e0b', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Rate Per Unit (₹) *</label><input type="number" value={formData.Rate_Per_Unit} onChange={e=>setFormData({...formData, Rate_Per_Unit: e.target.value})} style={{...inputStyle, borderColor: '#f59e0b', color: '#f59e0b', fontWeight: 'bold'}} placeholder="e.g. 2.50" /></div>
          <div><label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Fixed HSD Qty (Ltrs)</label><input type="number" value={formData.Fixed_HSD_Qty} onChange={e=>setFormData({...formData, Fixed_HSD_Qty: e.target.value})} style={inputStyle} /></div>
          <div><label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Fixed Cash Amt (₹)</label><input type="number" value={formData.Fixed_Cash_Amt} onChange={e=>setFormData({...formData, Fixed_Cash_Amt: e.target.value})} style={inputStyle} /></div>
          <div><label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Toll Amt (₹)</label><input type="number" value={formData.Toll_Amt} onChange={e=>setFormData({...formData, Toll_Amt: e.target.value})} style={inputStyle} /></div>
        </div>

        <button onClick={handleSaveRoute} style={{ background: 'linear-gradient(135deg, #38bdf8, #2563eb)', color: '#fff', border: 'none', padding: '15px 30px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', boxShadow: '0 4px 15px rgba(56, 189, 248, 0.4)', transition: '0.3s' }}>
          💾 SAVE TO MASTER DATABASE
        </button>
      </div>

      {/* 📋 REGISTER TABLE */}
      <div style={{ background: 'rgba(30, 41, 59, 0.4)', borderRadius: '15px', overflowX: 'auto', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(10px)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
          <thead style={{ background: 'rgba(0,0,0,0.5)', color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px' }}>
            <tr>
              <th style={{ padding: '15px' }}>Company</th><th style={{ padding: '15px' }}>Consignee_ID</th>
              <th style={{ padding: '15px', color: '#10b981' }}>Loading Depot</th><th style={{ padding: '15px', color: '#10b981' }}>Consignee Name</th>
              <th style={{ padding: '15px' }}>Customer (Assessee)</th><th style={{ padding: '15px' }}>Item Type</th>
              <th style={{ padding: '15px', color: '#38bdf8' }}>RTKM</th><th style={{ padding: '15px', color: '#38bdf8' }}>Rate/Unit</th>
              <th style={{ padding: '15px' }}>Fix HSD</th><th style={{ padding: '15px' }}>Fix Cash</th><th style={{ padding: '15px' }}>Toll</th>
              <th style={{ padding: '15px', textAlign: 'center' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={12} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8', fontWeight: 'bold' }}>Loading Master Data...</td></tr> : routes.length === 0 ? <tr><td colSpan={12} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No Master Data Found.</td></tr> : 
              routes.map((r) => (
              <tr key={r.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '12px', transition: '0.2s' }}>
                <td style={{ padding: '12px 15px' }}>{r.Company}</td><td style={{ padding: '12px 15px', color: '#64748b' }}>{r.Consignee_ID}</td>
                <td style={{ padding: '12px 15px', fontWeight: 'bold', color: '#10b981' }}>{r.Depot_Link}</td>
                <td style={{ padding: '12px 15px', fontWeight: 'bold', color: '#10b981' }}>{r.Consignee_Name}</td>
                <td style={{ padding: '12px 15px', color: '#fff' }}>{r.Registered_Assessee || '-'}</td><td style={{ padding: '12px 15px' }}>{r.Item_Type}</td>
                <td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: '900', fontSize: '14px' }}>{r.RTKM_Distance}</td>
                <td style={{ padding: '12px 15px', color: '#38bdf8', fontWeight: '900', fontSize: '14px' }}>₹{r.Rate_Per_Unit}</td>
                <td style={{ padding: '12px 15px' }}>{r.Fixed_HSD_Qty || '-'}</td><td style={{ padding: '12px 15px' }}>{r.Fixed_Cash_Amt || '-'}</td><td style={{ padding: '12px 15px' }}>{r.Toll_Amt || '-'}</td>
                <td style={{ padding: '12px 15px', textAlign: 'center' }}>
                  <span 
                    onClick={() => handleDeleteRoute(r.id, `${r.Depot_Link} to ${r.Consignee_Name}`)} 
                    style={{ cursor: 'pointer', color: '#64748b', fontSize: '16px', transition: '0.2s' }}
                    onMouseOver={(e) => e.currentTarget.style.color = '#ef4444'}
                    onMouseOut={(e) => e.currentTarget.style.color = '#64748b'}
                    title="Delete Route"
                  >
                    🗑️
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}