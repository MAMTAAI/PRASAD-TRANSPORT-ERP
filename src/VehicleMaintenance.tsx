// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, deleteDoc, doc, serverTimestamp, query, orderBy } from 'firebase/firestore';
import { db } from './firebase';
import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = "***REMOVED-ROTATE-ME***"; // Update with your actual key if needed

export default function VehicleMaintenance() {
  const [activeTab, setActiveTab] = useState('ALERTS_DASHBOARD'); 
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [serviceLogs, setServiceLogs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);

  const getInitialState = () => ({
    Vehicle_No: '',
    Service_Date: new Date().toISOString().split('T')[0],
    Current_KM: '',
    Service_Type: 'General Servicing',
    Service_Center_Type: 'LOCAL_GARAGE', // AUTHORIZED or LOCAL_GARAGE
    Work_Done: '',
    Garage_Name: '',
    Bill_Amount: '',
    Next_Service_Date: '',
    Next_Service_KM: '',
    Parts_Used: [] // [{ part_name: '', qty: 1, price: 0 }]
  });

  const [formData, setFormData] = useState(getInitialState());

  const serviceCategories = ['General Servicing', 'Mobil / Engine Oil Change', 'Greasing / Lubrication', 'Tyre Replacement', 'Engine Repair', 'Body / Accidental Repair', 'Electrical Work', 'Other'];

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const vSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const logSnap = await getDocs(query(collection(db, "MAINTENANCE_LOGS"), orderBy("created_at", "desc")));
      setServiceLogs(logSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.error("Error fetching data:", e);
    }
    setLoading(false);
  };

  // 🤖 MAMTA AI BILL SCANNER LOGIC (Robust & Safe)
  const handleAIScan = async (e: any) => {
    const file = e.target.files[0]; 
    if (!file) return; 
    setAiLoading(true);
    
    try {
      const reader = new FileReader(); 
      reader.readAsDataURL(file);
      reader.onload = async () => {
        const base64Data = (reader.result as string).split(',')[1];
        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });
        
        const prompt = `You are an expert AI assistant for Prasad Transport ERP. Extract data from this mechanic/showroom bill and STRICTLY return ONLY a JSON object (no markdown, no backticks). 
Format: { "vehicle_no": "Extracted or empty", "garage_name": "Extracted name", "service_center_type": "AUTHORIZED" or "LOCAL_GARAGE", "parts_used": [{"part_name": "string", "qty": number, "price": number}], "total_bill": number, "work_done": "summary of work" }`;
        
        const result = await model.generateContent([{ inlineData: { data: base64Data, mimeType: file.type } }, prompt]);
        
        // 🛡️ Safe JSON Parsing (Removes Markdown backticks if AI hallucinates)
        const cleanText = result.response.text().replace(/```json/gi, '').replace(/```/g, '').trim();
        const aiData = JSON.parse(cleanText);
        
        const vNum = (aiData.vehicle_no || '').toUpperCase();
        
        setFormData(prev => ({ 
          ...prev, 
          Vehicle_No: vNum,
          Garage_Name: aiData.garage_name || '',
          Service_Center_Type: aiData.service_center_type || 'LOCAL_GARAGE',
          Parts_Used: aiData.parts_used || [],
          Bill_Amount: aiData.total_bill || '',
          Work_Done: aiData.work_done || 'Auto-scanned from bill'
        }));
        
        alert("✨ Mamta AI: Bill Scanned Successfully! Parts and Amount Auto-Filled.");
      };
    } catch (err) { 
      console.error(err);
      alert("❌ Mamta AI Scan Failed. The image might be too blurry or not a valid bill. Please enter manually."); 
    } finally { 
      setAiLoading(false); 
    }
  };

  // 🛠️ PARTS MANAGEMENT LOGIC
  const handleAddPart = () => {
    setFormData({ ...formData, Parts_Used: [...formData.Parts_Used, { part_name: '', qty: 1, price: '' }] });
  };

  const handlePartChange = (index: number, field: string, value: any) => {
    const updatedParts = [...formData.Parts_Used];
    updatedParts[index][field] = value;
    
    // Auto calculate total bill if parts are entered manually
    let newTotal = 0;
    updatedParts.forEach(p => { newTotal += (parseFloat(p.qty || 0) * parseFloat(p.price || 0)); });
    
    setFormData({ ...formData, Parts_Used: updatedParts, Bill_Amount: newTotal > 0 ? newTotal.toFixed(2).toString() : formData.Bill_Amount });
  };

  const handleRemovePart = (index: number) => {
    const updatedParts = formData.Parts_Used.filter((_, i) => i !== index);
    let newTotal = 0;
    updatedParts.forEach(p => { newTotal += (parseFloat(p.qty || 0) * parseFloat(p.price || 0)); });
    setFormData({ ...formData, Parts_Used: updatedParts, Bill_Amount: newTotal > 0 ? newTotal.toFixed(2).toString() : '' });
  };

  const handleSaveService = async () => {
    if (!formData.Vehicle_No || !formData.Work_Done || !formData.Bill_Amount) {
      return alert("⚠️ Vehicle No, Work Done and Bill Amount are mandatory!");
    }

    try {
      await addDoc(collection(db, "MAINTENANCE_LOGS"), {
        ...formData,
        Bill_Amount: parseFloat(formData.Bill_Amount),
        created_at: serverTimestamp()
      });
      alert("✅ Maintenance & Parts Record Saved Successfully!");
      setFormData(getInitialState());
      fetchData();
      setActiveTab('HISTORY');
    } catch (e) {
      alert("❌ Error saving record!");
    }
  };

  // 🗑️ DELETE SERVICE LOG
  const handleDeleteLog = async (id: string, vNo: string) => {
    if (window.confirm(`⚠️ Are you sure you want to delete the maintenance record for Vehicle: ${vNo}?`)) {
      try {
        await deleteDoc(doc(db, "MAINTENANCE_LOGS", id));
        fetchData();
      } catch (error) { alert("❌ Error deleting record."); }
    }
  };

  // ALERTS LOGIC
  const today = new Date();
  const next7Days = new Date();
  next7Days.setDate(today.getDate() + 7);

  const upcomingServices: any[] = [];
  const vehicleCostMap: Record<string, number> = {};
  let totalMaintenanceCost = 0;

  serviceLogs.forEach(log => {
    const vNo = log.Vehicle_No;
    const cost = parseFloat(log.Bill_Amount || 0);
    
    vehicleCostMap[vNo] = (vehicleCostMap[vNo] || 0) + cost;
    totalMaintenanceCost += cost;

    if (log.Next_Service_Date) {
      const dueDate = new Date(log.Next_Service_Date);
      if (dueDate <= next7Days && !upcomingServices.find(s => s.Vehicle_No === vNo && s.Service_Type === log.Service_Type)) {
        upcomingServices.push({
          Vehicle_No: vNo, Service_Type: log.Service_Type, Due_Date: log.Next_Service_Date,
          Due_KM: log.Next_Service_KM, Last_Garage: log.Garage_Name,
          Status: dueDate < today ? 'OVERDUE 🚨' : 'DUE SOON ⚠️'
        });
      }
    }
  });

  const vehicleWiseAccounting = Object.keys(vehicleCostMap)
    .map(v => ({ vehicle: v, cost: vehicleCostMap[v] })).sort((a, b) => b.cost - a.cost);

  const inputStyle = { width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', fontSize: '13px', boxSizing: 'border-box' as const, outline: 'none' };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px', background: 'radial-gradient(circle at top right, #0f172a, #020617)', minHeight: '100vh', padding: '30px' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; backdrop-filter: blur(10px); }
        .glow-btn { background: linear-gradient(135deg, #f59e0b, #d97706); color: #000; border: none; padding: 12px 25px; border-radius: 8px; font-weight: 900; cursor: pointer; transition: 0.3s; display: inline-flex; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 4px 15px rgba(245, 158, 11, 0.4); }
        .glow-btn:hover { box-shadow: 0 8px 25px rgba(245, 158, 11, 0.6); transform: translateY(-2px); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; transition: 0.3s; }
        .tab-btn.active { color: #f59e0b; border-bottom: 3px solid #f59e0b; background: rgba(245, 158, 11, 0.1); border-radius: 8px 8px 0 0; }
        table { width: 100%; border-collapse: collapse; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(0,0,0,0.3); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #f59e0b; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .radio-group label { display: flex; align-items: center; gap: 5px; cursor: pointer; font-size: 13px; color: #cbd5e1; }
      `}</style>

      {/* HEADER */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px', fontWeight: '900', letterSpacing: '-0.5px' }}>🛠️ Fleet Maintenance Hub</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Vehicle Wise Reminders, Parts Management & Accounting</p>
        </div>
      </div>

      {/* TABS */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '25px', borderBottom: '1px solid #334155', overflowX: 'auto', whiteSpace: 'nowrap' }}>
        <button className={`tab-btn ${activeTab === 'ALERTS_DASHBOARD' ? 'active' : ''}`} onClick={() => setActiveTab('ALERTS_DASHBOARD')}>🚨 ALERTS & COST DASHBOARD</button>
        <button className={`tab-btn ${activeTab === 'ADD_SERVICE' ? 'active' : ''}`} onClick={() => setActiveTab('ADD_SERVICE')}>➕ ADD SERVICE & PARTS LOG</button>
        <button className={`tab-btn ${activeTab === 'HISTORY' ? 'active' : ''}`} onClick={() => setActiveTab('HISTORY')}>📋 MAINTENANCE HISTORY</button>
      </div>

      {/* 🚨 TAB 1: ALERTS & DASHBOARD */}
      {activeTab === 'ALERTS_DASHBOARD' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px', marginBottom: '30px' }}>
            <div style={{ background: 'linear-gradient(135deg, rgba(239,68,68,0.1), #1e293b)', borderLeft: '5px solid #ef4444', padding: '20px', borderRadius: '12px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' }}>
              <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Maintenance Cost</div>
              <div style={{ fontSize: '34px', fontWeight: '900', color: '#ef4444', marginTop: '5px' }}>₹ {totalMaintenanceCost.toLocaleString('en-IN', {minimumFractionDigits:2})}</div>
            </div>
            <div style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.1), #1e293b)', borderLeft: '5px solid #f59e0b', padding: '20px', borderRadius: '12px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' }}>
              <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Services Due / Overdue</div>
              <div style={{ fontSize: '34px', fontWeight: '900', color: '#f59e0b', marginTop: '5px' }}>{upcomingServices.length} 🚨</div>
            </div>
            <div style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.1), #1e293b)', borderLeft: '5px solid #10b981', padding: '20px', borderRadius: '12px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' }}>
              <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Vehicles in Fleet</div>
              <div style={{ fontSize: '34px', fontWeight: '900', color: '#10b981', marginTop: '5px' }}>{vehicles.length} 🚛</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '25px' }}>
            <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #ef4444' }}>
              <h3 style={{ margin: '0 0 20px 0', color: '#ef4444' }}>⏰ Upcoming & Overdue Services</h3>
              {upcomingServices.length === 0 ? ( <div style={{ color: '#10b981', fontWeight: 'bold', background: 'rgba(16,185,129,0.1)', padding: '15px', borderRadius: '8px' }}>✅ All vehicles are fully serviced and up to date!</div> ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '350px', overflowY: 'auto', paddingRight: '5px' }}>
                  {upcomingServices.map((s, i) => (
                    <div key={i} style={{ background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.2)', padding: '15px', borderRadius: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <div style={{ fontWeight: '900', color: '#fff', fontSize: '16px' }}>🚛 {s.Vehicle_No}</div>
                        <div style={{ color: '#f59e0b', fontSize: '12px', marginTop: '3px', fontWeight: 'bold' }}>{s.Service_Type}</div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ background: s.Status.includes('OVERDUE') ? '#ef4444' : '#f59e0b', color: '#fff', padding: '4px 10px', borderRadius: '12px', fontSize: '10px', fontWeight: '900', letterSpacing: '1px' }}>{s.Status}</div>
                        <div style={{ color: '#fff', fontSize: '12px', marginTop: '5px' }}>Due Date: <b style={{color: s.Status.includes('OVERDUE') ? '#ef4444' : '#f59e0b'}}>{s.Due_Date}</b></div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="glass-card" style={{ padding: '25px', borderTop: '4px solid #38bdf8' }}>
              <h3 style={{ margin: '0 0 20px 0', color: '#38bdf8' }}>💰 Vehicle-Wise Maintenance Accounting</h3>
              <div style={{ maxHeight: '350px', overflowY: 'auto', paddingRight: '5px' }}>
                <table style={{ background: '#0f172a', borderRadius: '8px', overflow: 'hidden' }}>
                  <thead><tr><th>Vehicle No</th><th style={{textAlign:'right'}}>Total Expense (YTD)</th></tr></thead>
                  <tbody>
                    {vehicleWiseAccounting.length === 0 ? <tr><td colSpan={2} style={{textAlign:'center', padding: '20px'}}>No expenses recorded yet.</td></tr> : 
                      vehicleWiseAccounting.map((v, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                        <td style={{ fontWeight: 'bold', color: '#fff', fontSize: '14px' }}>🚛 {v.vehicle}</td>
                        <td style={{ textAlign: 'right', fontWeight: '900', color: '#ef4444', fontSize: '16px' }}>₹ {v.cost.toLocaleString('en-IN', {minimumFractionDigits:2})}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ➕ TAB 2: ADD SERVICE LOG */}
      {activeTab === 'ADD_SERVICE' && (
        <div className="glass-card" style={{ padding: '30px', maxWidth: '900px', margin: '0 auto', borderTop: '4px solid #f59e0b' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '20px', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
            <h3 style={{ color: '#f59e0b', margin: 0, fontSize: '20px' }}>➕ Create New Service & Parts Record</h3>
            <label className="glow-btn" style={{ cursor: 'pointer', background: 'linear-gradient(135deg, #8b5cf6, #c084fc)', color: 'white', boxShadow: '0 4px 15px rgba(139, 92, 246, 0.4)' }}>
              {aiLoading ? '⏳ Mamta AI Scanning...' : '🤖 AI Auto-Scan Bill'}
              <input type="file" hidden accept="image/*,application/pdf" onChange={handleAIScan} />
            </label>
          </div>
          
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px', marginBottom: '25px' }}>
            
            {/* Service Center Type Selection */}
            <div style={{ gridColumn: '1 / -1', background: 'rgba(255,255,255,0.05)', padding: '20px', borderRadius: '10px', border: '1px dashed #475569' }}>
              <label style={{ fontSize: '13px', color: '#38bdf8', fontWeight: 'bold', marginBottom: '15px', display: 'block' }}>Service Center Type *</label>
              <div className="radio-group" style={{ display: 'flex', gap: '30px' }}>
                <label>
                  <input type="radio" name="centerType" value="AUTHORIZED" checked={formData.Service_Center_Type === 'AUTHORIZED'} onChange={e => setFormData({...formData, Service_Center_Type: e.target.value})} style={{ accentColor: '#38bdf8', transform: 'scale(1.2)' }} />
                  <span style={{ fontWeight: 'bold' }}>🏢 Authorized Showroom</span>
                </label>
                <label>
                  <input type="radio" name="centerType" value="LOCAL_GARAGE" checked={formData.Service_Center_Type === 'LOCAL_GARAGE'} onChange={e => setFormData({...formData, Service_Center_Type: e.target.value})} style={{ accentColor: '#38bdf8', transform: 'scale(1.2)' }} />
                  <span style={{ fontWeight: 'bold' }}>🛠️ Local Garage / Market</span>
                </label>
              </div>
            </div>

            <div>
              <label style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '5px', display: 'block', fontWeight: 'bold' }}>Vehicle No *</label>
              <select value={formData.Vehicle_No} onChange={e=>setFormData({...formData, Vehicle_No: e.target.value})} style={inputStyle}>
                <option value="">-- Select Vehicle --</option>
                {vehicles.map(v => <option key={v.id} value={v.vehical_no || v.vehicle_no}>{v.vehical_no || v.vehicle_no}</option>)}
                {formData.Vehicle_No && !(vehicles || []).find((v: any)=>(v.vehical_no || v.vehicle_no) === formData.Vehicle_No) && <option value={formData.Vehicle_No}>{formData.Vehicle_No} (Auto-Detected)</option>}
              </select>
            </div>
            
            <div><label style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '5px', display: 'block', fontWeight: 'bold' }}>Service Date</label><input type="date" value={formData.Service_Date} onChange={e=>setFormData({...formData, Service_Date: e.target.value})} style={{...inputStyle, colorScheme: 'dark'}} /></div>
            
            <div>
              <label style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '5px', display: 'block', fontWeight: 'bold' }}>Service Category</label>
              <select value={formData.Service_Type} onChange={e=>setFormData({...formData, Service_Type: e.target.value})} style={inputStyle}>
                {serviceCategories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            
            <div><label style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '5px', display: 'block', fontWeight: 'bold' }}>Current Odometer (KM)</label><input type="number" value={formData.Current_KM} onChange={e=>setFormData({...formData, Current_KM: e.target.value})} style={inputStyle} placeholder="e.g. 45000" /></div>
            
            <div style={{ gridColumn: '1 / -1' }}><label style={{ fontSize: '12px', color: '#fff', fontWeight: 'bold', marginBottom: '5px', display: 'block' }}>Work Done Summary *</label><input type="text" value={formData.Work_Done} onChange={e=>setFormData({...formData, Work_Done: e.target.value})} style={{...inputStyle, border: '1px solid #38bdf8'}} placeholder="Detailed description of work done..." /></div>
            
            <div style={{ gridColumn: '1 / -1' }}><label style={{ fontSize: '12px', color: '#94a3b8', marginBottom: '5px', display: 'block', fontWeight: 'bold' }}>Garage / Showroom Name</label><input type="text" value={formData.Garage_Name} onChange={e=>setFormData({...formData, Garage_Name: e.target.value})} style={inputStyle} placeholder="E.g. Tata Motors / Sharma Garage" /></div>
          </div>

          {/* ⚙️ SPARE PARTS MANAGEMENT INVENTORY */}
          <div style={{ background: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.3)', padding: '20px', borderRadius: '10px', marginBottom: '25px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', borderBottom: '1px dashed rgba(16, 185, 129, 0.3)', paddingBottom: '10px' }}>
              <h4 style={{ margin: 0, color: '#10b981', fontSize: '16px' }}>⚙️ Spare Parts / Materials Used</h4>
              <button onClick={handleAddPart} style={{ background: '#10b981', color: '#fff', border: 'none', borderRadius: '6px', padding: '6px 12px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', boxShadow: '0 4px 10px rgba(16,185,129,0.3)' }}>+ Add Part</button>
            </div>

            {formData.Parts_Used.length === 0 ? (
              <div style={{ color: '#64748b', fontSize: '13px', textAlign: 'center', padding: '20px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px' }}>No parts added. Click '+ Add Part' or scan a bill using Mamta AI.</div>
            ) : (
              formData.Parts_Used.map((part: any, index: number) => (
                <div key={index} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.5fr auto', gap: '15px', marginBottom: '15px', alignItems: 'end' }}>
                  <div>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>Part Name</label>
                    <input type="text" className="modern-input" style={{...inputStyle, marginTop: '5px'}} value={part.part_name} onChange={e => handlePartChange(index, 'part_name', e.target.value)} placeholder="e.g. Engine Oil (15W40)" />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>Qty</label>
                    <input type="number" className="modern-input" style={{...inputStyle, marginTop: '5px'}} value={part.qty} onChange={e => handlePartChange(index, 'qty', e.target.value)} min="1" />
                  </div>
                  <div>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 'bold' }}>Price/Unit (₹)</label>
                    <input type="number" className="modern-input" style={{...inputStyle, marginTop: '5px'}} value={part.price} onChange={e => handlePartChange(index, 'price', e.target.value)} min="0" />
                  </div>
                  <button onClick={() => handleRemovePart(index)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '20px', cursor: 'pointer', paddingBottom: '10px', transition: '0.2s' }} onMouseOver={e=>e.currentTarget.style.transform='scale(1.2)'} onMouseOut={e=>e.currentTarget.style.transform='scale(1)'} title="Remove Part">✕</button>
                </div>
              ))
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '25px' }}>
            <div style={{ width: '300px', background: 'rgba(239, 68, 68, 0.05)', padding: '15px', borderRadius: '10px', border: '1px dashed #ef4444' }}>
              <label style={{ fontSize: '13px', color: '#ef4444', fontWeight: 'bold', marginBottom: '5px', display: 'block' }}>Final Total Bill Amount (₹) *</label>
              <input type="number" value={formData.Bill_Amount} onChange={e=>setFormData({...formData, Bill_Amount: e.target.value})} style={{...inputStyle, border: '1px solid #ef4444', fontSize: '24px', fontWeight: '900', color: '#ef4444', textAlign: 'right'}} placeholder="0.00" />
            </div>
          </div>

          {/* ⏰ SMART REMINDER SETUP */}
          <div style={{ background: 'rgba(56, 189, 248, 0.05)', border: '1px dashed #38bdf8', padding: '25px', borderRadius: '12px', marginBottom: '30px' }}>
            <h4 style={{ margin: '0 0 15px 0', color: '#38bdf8', fontSize: '16px' }}>⏰ Set Next Service Reminder (Optional)</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
              <div><label style={{ fontSize: '12px', color: '#38bdf8', marginBottom: '5px', display: 'block', fontWeight: 'bold' }}>Next Due Date</label><input type="date" value={formData.Next_Service_Date} onChange={e=>setFormData({...formData, Next_Service_Date: e.target.value})} style={{...inputStyle, colorScheme: 'dark'}} /></div>
              <div><label style={{ fontSize: '12px', color: '#38bdf8', marginBottom: '5px', display: 'block', fontWeight: 'bold' }}>Next Due Odometer (KM)</label><input type="number" value={formData.Next_Service_KM} onChange={e=>setFormData({...formData, Next_Service_KM: e.target.value})} style={inputStyle} placeholder="e.g. 55000" /></div>
            </div>
          </div>

          <button className="glow-btn" style={{ width: '100%', fontSize: '16px', padding: '15px' }} onClick={handleSaveService}>💾 Save Maintenance & Parts Record</button>
        </div>
      )}

      {/* 📋 TAB 3: HISTORY */}
      {activeTab === 'HISTORY' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto', borderTop: '4px solid #10b981' }}>
          <h3 style={{ color: '#10b981', marginTop: 0, marginBottom: '20px' }}>📋 Vehicle Maintenance Ledger</h3>
          <table>
            <thead>
              <tr>
                <th>Vehicle_No</th>
                <th>Service Center</th>
                <th>Date & Category</th>
                <th>Work & Parts Used</th>
                <th>Next_Due</th>
                <th style={{ textAlign: 'right', color: '#ef4444' }}>Total_Bill</th>
                <th style={{ textAlign: 'center' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={7} style={{textAlign:'center', padding: '30px', fontWeight: 'bold', color: '#38bdf8'}}>Loading Data...</td></tr> : serviceLogs.length === 0 ? <tr><td colSpan={7} style={{textAlign:'center', padding: '30px', color: '#64748b'}}>No records found.</td></tr> : 
                serviceLogs.map((log) => (
                <tr key={log.id} style={{ transition: '0.2s' }}>
                  <td style={{ fontWeight: '900', color: '#fff', fontSize: '16px' }}>🚛 {log.Vehicle_No}</td>
                  <td>
                    <span style={{ background: log.Service_Center_Type === 'AUTHORIZED' ? 'rgba(56,189,248,0.2)' : 'rgba(16,185,129,0.2)', color: log.Service_Center_Type === 'AUTHORIZED' ? '#38bdf8' : '#10b981', padding: '4px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: '900', display: 'inline-block', marginBottom: '5px', letterSpacing: '1px' }}>
                      {log.Service_Center_Type === 'AUTHORIZED' ? '🏢 AUTHORIZED' : '🛠️ LOCAL GARAGE'}
                    </span>
                    <br/>
                    <span style={{ fontSize: '12px', color: '#cbd5e1', fontWeight: 'bold' }}>{log.Garage_Name || '-'}</span>
                  </td>
                  <td>
                    <div style={{ color: '#fff', fontWeight: 'bold' }}>{log.Service_Date}</div>
                    <div style={{ color: '#f59e0b', fontSize: '11px', marginTop: '4px', fontWeight: 'bold' }}>{log.Service_Type}</div>
                  </td>
                  <td style={{ maxWidth: '250px' }}>
                    <div style={{ color: '#cbd5e1', marginBottom: '5px', fontSize: '13px' }}>{log.Work_Done}</div>
                    {log.Parts_Used && log.Parts_Used.length > 0 && (
                      <details style={{ fontSize: '11px', color: '#10b981', cursor: 'pointer', outline: 'none' }}>
                        <summary style={{ fontWeight: 'bold' }}>View Parts ({log.Parts_Used.length})</summary>
                        <ul style={{ margin: '5px 0 0 0', paddingLeft: '15px', color: '#94a3b8', background: 'rgba(0,0,0,0.2)', padding: '10px', borderRadius: '5px' }}>
                          {log.Parts_Used.map((p: any, idx: number) => (
                            <li key={idx} style={{ marginBottom: '3px' }}>{p.part_name} - {p.qty} x ₹{p.price}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </td>
                  <td>
                    {log.Next_Service_Date && <div style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold' }}>📅 {log.Next_Service_Date}</div>}
                    {log.Next_Service_KM && <div style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', marginTop: '4px' }}>🛣️ {parseFloat(log.Next_Service_KM).toLocaleString('en-IN')} KM</div>}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: '900', color: '#ef4444', fontSize: '18px' }}>₹ {parseFloat(log.Bill_Amount).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                  <td style={{ textAlign: 'center' }}>
                     <span onClick={() => handleDeleteLog(log.id, log.Vehicle_No)} style={{ cursor: 'pointer', color: '#64748b', fontSize: '18px', transition: '0.2s' }} onMouseOver={e=>e.currentTarget.style.color='#ef4444'} onMouseOut={e=>e.currentTarget.style.color='#64748b'} title="Delete Record">🗑️</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}