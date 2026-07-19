// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';
import { BILLING_TYPES, resolveRate } from './lib/freightEngine';

// 🛠️ Fleet fuel-economy config (km per litre) by vehicle capacity, used to
// derive Fixed HSD = RTKM ÷ mileage when a route has no saved value.
// Values match the existing master ratios (~3 km/L for tankers). Editable here.
const MILEAGE_BY_CAP: { match: string; kmPerL: number }[] = [
  { match: '12 KL', kmPerL: 3.5 },
  { match: '20 KL', kmPerL: 3.2 },
  { match: '24 KL', kmPerL: 3.0 },
  { match: '29 KL', kmPerL: 2.8 },
  { match: '34 KL', kmPerL: 2.6 },
  { match: '40 KL', kmPerL: 2.4 },
  { match: '18 MT', kmPerL: 3.0 },
  { match: '21 MT', kmPerL: 2.8 },
];
const DEFAULT_KM_PER_L = 3.0;
const DEFAULT_CASH_PER_KM = 2.5; // ₹ per km, fallback when no fixed cash

const kmPerLFor = (cap: string): number => {
  const hit = MILEAGE_BY_CAP.find(m => String(cap || '').includes(m.match));
  return hit ? hit.kmPerL : DEFAULT_KM_PER_L;
};
const calcHsd = (rtkm: any, cap: string): number => {
  const km = parseFloat(rtkm) || 0;
  return km > 0 ? Math.round(km / kmPerLFor(cap)) : 0;
};
const calcCash = (rtkm: any): number => {
  const km = parseFloat(rtkm) || 0;
  return km > 0 ? Math.round(km * DEFAULT_CASH_PER_KM) : 0;
};

export default function LocationRtkmMaster() {
  const [routes, setRoutes] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]); 
  const [loading, setLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');

  // 🌟 NEW: Custom added items during session
  const [customItems, setCustomItems] = useState<string[]>([]);
  const [customCapacities, setCustomCapacities] = useState<string[]>([]);

  const [formData, setFormData] = useState({
    Customer: '',
    Depot_Link: '',
    Consignee_Name: '',
    Item_Type: 'HSD (Diesel)',
    Vehicle_Capacity: '20 KL (10 Wheeler)',
    RTKM_Distance: '',
    Fixed_HSD: '',
    Fixed_Cash: '',
    Status: 'Active',
    // 💰 SMART FREIGHT ENGINE: billing formula (oil companies simple Qty×Rate
    // use nahi kartin — IOCL me Qty × RTD × Rate/tonne-km hota hai)
    Billing_Type: 'PER_KL'
  });
  // 🗓️ Quarterly date-effective rates: [{valid_from, valid_to, rate_value}] —
  // trip ki LOADING DATE jis quarter me girti hai, wahi rate billing me lagta hai.
  const [rateHistory, setRateHistory] = useState<any[]>([]);

  useEffect(() => {
    fetchRoutes();
    fetchCustomers(); 
  }, []);

  const fetchCustomers = async () => {
    try {
      const snap = await getDocs(collection(db, "CUSTOMERS"));
      const custData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setCustomers(custData);
    } catch (error) {
      console.error("Error fetching Customers:", error);
    }
  };

  const fetchRoutes = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "RTKM_MASTER"));
      const routeData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      routeData.sort((a: any, b: any) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      setRoutes(routeData);
    } catch (error) {
      console.error("Error fetching RTKM:", error);
    } finally {
      setLoading(false);
    }
  };

  const uniqueDepots = Array.from(new Set(routes.map(r => r.Depot_Link || r.depot_link).filter(Boolean)));
  const uniqueConsignees = Array.from(new Set(routes.map(r => r.Consignee_Name || r.consignee_name).filter(Boolean)));
  
  // 🔥 SMART LISTS (Combines default + database saved + currently added)
  const allItems = Array.from(new Set([
    "HSD (Diesel)", "MS (Petrol)", "Part Load (MS+HSD)", "ATF", "LPG Bulk", "LPG Cylinder", "Iron/Steel (Pipes, TMT)", "Cement / Coal", "FMCG / General Goods",
    ...routes.map(r => r.Item_Type).filter(Boolean),
    ...customItems
  ]));

  const allCapacities = Array.from(new Set([
    "12 KL (6 Wheeler)", "20 KL (10 Wheeler)", "24 KL (12 Wheeler)", "29 KL (14 Wheeler)", "34 KL (16 Wheeler)", "40 KL (18 Wheeler)", 
    "18 MT (LPG Bulk)", "21 MT (LPG Bulk)", "ALL (Standard)",
    ...routes.map(r => r.Vehicle_Capacity).filter(Boolean),
    ...customCapacities
  ]));

  // 🔥 HANDLE "ADD NEW" FOR ITEM TYPE
  const handleItemChange = (e: any) => {
    if (e.target.value === "ADD_NEW") {
      const newItem = window.prompt("➕ Enter New Item Type / Product Name:");
      if (newItem && newItem.trim() !== "") {
        setCustomItems([...customItems, newItem.trim()]);
        setFormData({ ...formData, Item_Type: newItem.trim() });
      } else {
        setFormData({ ...formData, Item_Type: "HSD (Diesel)" }); // Fallback
      }
    } else {
      setFormData({ ...formData, Item_Type: e.target.value });
    }
  };

  // 🔥 HANDLE "ADD NEW" FOR VEHICLE CAPACITY
  const handleCapacityChange = (e: any) => {
    if (e.target.value === "ADD_NEW") {
      const newCap = window.prompt("➕ Enter New Vehicle Capacity / Model (e.g. 15 MT Gas Tanker):");
      if (newCap && newCap.trim() !== "") {
        setCustomCapacities([...customCapacities, newCap.trim()]);
        setFormData({ ...formData, Vehicle_Capacity: newCap.trim() });
      } else {
        setFormData({ ...formData, Vehicle_Capacity: "20 KL (10 Wheeler)" }); // Fallback
      }
    } else {
      setFormData({ ...formData, Vehicle_Capacity: e.target.value });
    }
  };

  const handleSaveRoute = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.Customer || !formData.Depot_Link || !formData.Consignee_Name || !formData.RTKM_Distance || !formData.Item_Type || !formData.Vehicle_Capacity) {
      alert("⚠️ कृपया Customer, Depot, Consignee, Item Type, Vehicle Capacity और RTKM ज़रूर भरें!");
      return;
    }

    // 🚫 Duplicate check (Customer + Depot + Consignee + Item Type must be unique).
    const norm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const dup = routes.find(r =>
      r.id !== editingId &&
      norm(r.Customer || r.customer_name) === norm(formData.Customer) &&
      norm(r.Depot_Link || r.depot_link) === norm(formData.Depot_Link) &&
      norm(r.Consignee_Name || r.consignee_name) === norm(formData.Consignee_Name) &&
      norm(r.Item_Type) === norm(formData.Item_Type)
    );
    if (dup) {
      alert("⚠️ Yeh route pehle se master mein hai (same Customer + Depot + Consignee + Item Type). Duplicate save nahi hoga.");
      return;
    }

    // 🗓️ Rate history clean-up: khali/0 rows hatao, dates validate karo.
    const cleanRates = rateHistory
      .filter(r => r.valid_from && parseFloat(r.rate_value) > 0)
      .map(r => ({ valid_from: r.valid_from, valid_to: r.valid_to || '', rate_value: parseFloat(r.rate_value) }))
      .sort((a, b) => a.valid_from.localeCompare(b.valid_from));
    const badRange = cleanRates.find(r => r.valid_to && r.valid_to < r.valid_from);
    if (badRange) { alert(`⚠️ Rate period galat hai: Valid-To (${badRange.valid_to}) Valid-From (${badRange.valid_from}) se pehle nahi ho sakta!`); return; }
    if (formData.Billing_Type !== 'PER_KL' && cleanRates.length === 0) {
      if (!window.confirm('⚠️ Aapne special Billing Type chuna hai par koi Quarterly Rate nahi bhara — billing me rate 0 aayega.\n\nPhir bhi save karein?')) return;
    }

    setIsSubmitting(true);
    try {
      const payload = {
        ...formData,
        rate_history: cleanRates,
        customer_name: formData.Customer,
        depot_link: formData.Depot_Link,
        consignee_name: formData.Consignee_Name,
        rtkm_distance: formData.RTKM_Distance,
      };
      if (editingId) {
        await updateDoc(doc(db, "RTKM_MASTER", editingId), { ...payload, updatedAt: serverTimestamp() });
        alert("✅ मास्टर डेटा सफलतापूर्वक अपडेट हो गया!");
      } else {
        await addDoc(collection(db, "RTKM_MASTER"), { ...payload, createdAt: serverTimestamp() });
        alert(`✅ नया रूट सफलतापूर्वक सेव हुआ!`);
      }
      
      resetForm();
      fetchRoutes();

    } catch (error) {
      console.error("Error saving:", error);
      alert("❌ डेटा सेव या अपडेट नहीं हो पाया!");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleEdit = (r: any) => {
    setEditingId(r.id);
    setFormData({
      Customer: r.Customer || r.customer_name || '',
      Depot_Link: r.Depot_Link || r.depot_link || '',
      Consignee_Name: r.Consignee_Name || r.consignee_name || '',
      Item_Type: r.Item_Type || 'HSD (Diesel)',
      Vehicle_Capacity: r.Vehicle_Capacity || 'ALL (Standard)',
      RTKM_Distance: r.RTKM_Distance || r.rtkm_distance || '',
      Fixed_HSD: r.Fixed_HSD || '',
      Fixed_Cash: r.Fixed_Cash || '',
      Status: r.Status || 'Active',
      Billing_Type: r.Billing_Type || 'PER_KL'
    });
    setRateHistory(Array.isArray(r.rate_history) ? r.rate_history.map(x => ({ ...x })) : []);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleToggleStatus = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'Active' ? 'Inactive' : 'Active';
    try {
      await updateDoc(doc(db, "RTKM_MASTER", id), { Status: newStatus });
      fetchRoutes();
    } catch (error) {
      alert("❌ स्टेटस बदलने में समस्या आई!");
    }
  };

  const handleDelete = async (id: string) => {
    if (window.confirm("⚠️ क्या आप वाकई इस रूट रिकॉर्ड को हमेशा के लिए मिटाना चाहते हैं?")) {
      try {
        await deleteDoc(doc(db, "RTKM_MASTER", id));
        fetchRoutes();
      } catch (error) {
        alert("❌ डिलीट करने में समस्या आई!");
      }
    }
  };

  const resetForm = () => {
    setEditingId(null);
    setFormData(prev => ({
      ...prev,
      Consignee_Name: '',
      RTKM_Distance: '',
      Fixed_HSD: '',
      Fixed_Cash: '',
      Status: 'Active',
      Billing_Type: 'PER_KL'
    }));
    setRateHistory([]);
  };

  let filteredRoutes = routes;

  if (customerFilter) {
    filteredRoutes = filteredRoutes.filter(r => 
      (r.Customer || r.customer_name || '').toUpperCase() === customerFilter.toUpperCase()
    );
  }

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    filteredRoutes = filteredRoutes.filter(r => 
      (r.Customer || r.customer_name || '').toLowerCase().includes(q) ||
      (r.Depot_Link || r.depot_link || '').toLowerCase().includes(q) ||
      (r.Consignee_Name || r.consignee_name || '').toLowerCase().includes(q) ||
      (r.Item_Type || '').toLowerCase().includes(q)
    );
  }

  const inputStyle = { width: '100%', padding: '12px 15px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', fontSize: '14px', boxSizing: 'border-box' as const };
  const labelStyle = { color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '6px' };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)', fontFamily: "'Inter', sans-serif" }}>
      
      {/* HEADER */}
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h1 style={{ color: '#38bdf8', fontSize: '32px', margin: '0 0 10px 0', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px' }}>
          📍 Customer Location & RTKM Master
        </h1>
        <p style={{ color: '#94a3b8', margin: 0 }}>Manage Routes, Vehicle Capacities, and Fixed Expenses</p>
      </div>

      {/* FORM CARD */}
      <div style={{ background: 'rgba(30, 41, 59, 0.4)', backdropFilter: 'blur(12px)', border: editingId ? '2px solid #f59e0b' : '1px solid #1e293b', borderRadius: '15px', padding: '30px', marginBottom: '40px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', transition: '0.3s' }}>
        
        {editingId && (
          <div style={{ background: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b', padding: '10px', borderRadius: '8px', marginBottom: '20px', fontWeight: 'bold', textAlign: 'center', border: '1px dashed #f59e0b' }}>
            ✏️ EDITING MODE: You are updating an existing route.
          </div>
        )}

        <form onSubmit={handleSaveRoute}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '20px' }}>
            
            <div>
              <label style={labelStyle}>Customer *</label>
              <select style={inputStyle} value={formData.Customer} onChange={e => setFormData({...formData, Customer: e.target.value})} required>
                <option value="">-- Select Customer --</option>
                {customers.map(c => {
                  const cName = c.customer_name || c.name || c.company_name || c.Customer_Name || c.id;
                  return <option key={c.id} value={cName}>{cName}</option>
                })}
              </select>
            </div>

            <div>
              <label style={labelStyle}>Depot / Loading Point *</label>
              <input 
                list="depot-list" 
                placeholder="Type or Select Depot" 
                style={inputStyle} 
                value={formData.Depot_Link} 
                onChange={e => setFormData({...formData, Depot_Link: e.target.value.toUpperCase()})} 
                required 
                autoComplete="off"
              />
              <datalist id="depot-list">
                {uniqueDepots.map((d, i) => <option key={i} value={d as string} />)}
              </datalist>
            </div>

            <div>
              <label style={labelStyle}>Consignee *</label>
              <input 
                list="consignee-list" 
                placeholder="Type or Select Consignee" 
                style={inputStyle} 
                value={formData.Consignee_Name} 
                onChange={e => setFormData({...formData, Consignee_Name: e.target.value.toUpperCase()})} 
                required 
                autoComplete="off"
              />
              <datalist id="consignee-list">
                {uniqueConsignees.map((c, i) => <option key={i} value={c as string} />)}
              </datalist>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '30px', padding: '20px', background: 'rgba(56, 189, 248, 0.05)', borderRadius: '10px', border: '1px dashed #334155' }}>
            
            {/* 🔥 SMART DROPDOWN WITH ADD NEW BUTTON (Item Type) */}
            <div>
              <label style={{...labelStyle, color: '#f59e0b'}}>Item Type / Product *</label>
              <select style={{...inputStyle, borderColor: '#f59e0b'}} value={formData.Item_Type} onChange={handleItemChange} required>
                <option value="">-- Select Item --</option>
                {allItems.map((item, i) => <option key={i} value={item as string}>{item}</option>)}
                <option value="ADD_NEW" style={{ background: '#f59e0b', color: '#0f172a', fontWeight: 'bold' }}>➕ Add New Item Type...</option>
              </select>
            </div>

            {/* 🔥 SMART DROPDOWN WITH ADD NEW BUTTON (Vehicle Capacity) */}
            <div>
              <label style={{...labelStyle, color: '#f59e0b'}}>Vehicle Capacity (KL/MT) *</label>
              <select style={{...inputStyle, borderColor: '#f59e0b', color: '#f59e0b', fontWeight: 'bold'}} value={formData.Vehicle_Capacity} onChange={handleCapacityChange} required>
                <option value="">-- Select Capacity --</option>
                {allCapacities.map((cap, i) => <option key={i} value={cap as string}>{cap}</option>)}
                <option value="ADD_NEW" style={{ background: '#f59e0b', color: '#0f172a', fontWeight: 'bold' }}>➕ Add New Capacity/Model...</option>
              </select>
            </div>

            <div>
              <label style={{...labelStyle, color: '#f59e0b'}}>RTKM Distance *</label>
              <input type="number" placeholder="Distance" style={{...inputStyle, borderColor: '#f59e0b'}} value={formData.RTKM_Distance} onChange={e => {
                const rtkm = e.target.value;
                setFormData(prev => ({
                  ...prev,
                  RTKM_Distance: rtkm,
                  // Auto-fill HSD/Cash only when the user hasn't typed their own.
                  Fixed_HSD: (!prev.Fixed_HSD || parseFloat(prev.Fixed_HSD) === 0) ? String(calcHsd(rtkm, prev.Vehicle_Capacity) || '') : prev.Fixed_HSD,
                  Fixed_Cash: (!prev.Fixed_Cash || parseFloat(prev.Fixed_Cash) === 0) ? String(calcCash(rtkm) || '') : prev.Fixed_Cash,
                }));
              }} required />
            </div>

            <div>
              <label style={{...labelStyle, color: '#10b981'}}>Fixed HSD (Liters)</label>
              <input type="number" placeholder="e.g. 290" style={{...inputStyle, borderColor: '#10b981'}} value={formData.Fixed_HSD} onChange={e => setFormData({...formData, Fixed_HSD: e.target.value})} />
            </div>

            <div>
              <label style={{...labelStyle, color: '#10b981'}}>Fixed Cash (₹)</label>
              <input type="number" placeholder="e.g. 2000" style={{...inputStyle, borderColor: '#10b981'}} value={formData.Fixed_Cash} onChange={e => setFormData({...formData, Fixed_Cash: e.target.value})} />
            </div>
          </div>

          {/* 💰 SMART FREIGHT ENGINE: billing formula + date-effective quarterly rates */}
          <div style={{ padding: '20px', background: 'rgba(16, 185, 129, 0.05)', borderRadius: '10px', border: '1px dashed #10b981', marginBottom: '30px' }}>
            <label style={{ ...labelStyle, color: '#10b981', fontSize: '14px' }}>💰 Smart Freight Calculation (Billing Formula + Quarterly Rates)</label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px', marginTop: '10px' }}>
              <div>
                <label style={labelStyle}>Billing Type / Formula *</label>
                <select style={{ ...inputStyle, borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }} value={formData.Billing_Type} onChange={e => setFormData({ ...formData, Billing_Type: e.target.value })}>
                  {BILLING_TYPES.map(bt => <option key={bt.key} value={bt.key}>{bt.label} — {bt.formula}</option>)}
                </select>
                <small style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginTop: '5px' }}>
                  IOCL LPG bills: Qty(TO) × RTD(km) × Rate/t-km — "RTKM × Qty" chunein.
                </small>
              </div>
            </div>

            <div style={{ marginTop: '15px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ ...labelStyle, color: '#c084fc' }}>🗓️ Quarterly Rate Revisions (trip ki Loading Date se sahi rate auto-lagta hai)</label>
                <button type="button" onClick={() => setRateHistory([...rateHistory, { valid_from: '', valid_to: '', rate_value: '' }])}
                  style={{ background: 'rgba(192,132,252,0.15)', color: '#c084fc', border: '1px solid #c084fc', padding: '6px 14px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}>
                  ➕ Add Rate Period
                </button>
              </div>
              {rateHistory.length === 0 && (
                <p style={{ color: '#64748b', fontSize: '12px', margin: '10px 0 0' }}>Koi rate period nahi — billing me trip par manual/default rate lagega. Har quarter ka naya rate yahan add karein.</p>
              )}
              {rateHistory.map((rh, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 44px', gap: '10px', marginTop: '10px', alignItems: 'center' }}>
                  <div>
                    <label style={{ ...labelStyle, fontSize: '10px', marginBottom: '3px' }}>Valid From *</label>
                    <input type="date" style={{ ...inputStyle, padding: '9px', colorScheme: 'dark' }} value={rh.valid_from}
                      onChange={e => setRateHistory(rateHistory.map((x, i) => i === idx ? { ...x, valid_from: e.target.value } : x))} />
                  </div>
                  <div>
                    <label style={{ ...labelStyle, fontSize: '10px', marginBottom: '3px' }}>Valid To (khaali = current)</label>
                    <input type="date" style={{ ...inputStyle, padding: '9px', colorScheme: 'dark' }} value={rh.valid_to}
                      onChange={e => setRateHistory(rateHistory.map((x, i) => i === idx ? { ...x, valid_to: e.target.value } : x))} />
                  </div>
                  <div>
                    <label style={{ ...labelStyle, fontSize: '10px', marginBottom: '3px', color: '#10b981' }}>Rate Value *</label>
                    <input type="number" step="any" placeholder="e.g. 3.432495" style={{ ...inputStyle, padding: '9px', borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }} value={rh.rate_value}
                      onChange={e => setRateHistory(rateHistory.map((x, i) => i === idx ? { ...x, rate_value: e.target.value } : x))} />
                  </div>
                  <button type="button" title="Remove period" onClick={() => setRateHistory(rateHistory.filter((_, i) => i !== idx))}
                    style={{ background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '8px', height: '38px', marginTop: '16px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '15px' }}>
            {editingId && (
              <button type="button" onClick={resetForm} style={{ flex: 1, background: 'transparent', color: '#ef4444', border: '1px solid #ef4444', padding: '15px', borderRadius: '8px', fontWeight: '900', fontSize: '16px', cursor: 'pointer', transition: '0.3s' }}>
                ❌ CANCEL EDIT
              </button>
            )}
            <button type="submit" disabled={isSubmitting} style={{ flex: 2, background: editingId ? 'linear-gradient(135deg, #f59e0b, #d97706)' : 'linear-gradient(135deg, #38bdf8, #3b82f6)', color: '#0f172a', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: '900', fontSize: '16px', cursor: 'pointer', transition: '0.3s', boxShadow: editingId ? '0 5px 15px rgba(245, 158, 11, 0.4)' : '0 5px 15px rgba(56, 189, 248, 0.4)' }}>
              {isSubmitting ? '⏳ SAVING...' : (editingId ? '💾 UPDATE ROUTE MASTER' : '💾 SAVE TO MASTER')}
            </button>
          </div>
        </form>
      </div>

      {/* 🌟 SEARCH BAR FOR TABLE */}
      <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', background: '#1e293b', padding: '15px', borderRadius: '10px', border: '1px solid #334155' }}>
        <input 
          type="text" 
          placeholder="🔍 Search Depot, Consignee, Item..." 
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{ ...inputStyle, flex: 2, borderColor: '#38bdf8', background: '#0f172a' }}
        />
        <select 
          value={customerFilter} 
          onChange={(e) => setCustomerFilter(e.target.value)} 
          style={{ ...inputStyle, flex: 1, borderColor: '#f59e0b', color: '#f59e0b', background: '#0f172a' }}
        >
          <option value="">🏢 All Customers</option>
          {customers.map(c => {
             const cName = c.customer_name || c.name || c.company_name || c.Customer_Name || c.id;
             return <option key={c.id} value={cName}>{cName}</option>
          })}
        </select>
      </div>

      {/* DATA TABLE */}
      <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '15px', overflowX: 'auto', padding: '20px' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
          <thead style={{ color: '#f59e0b', fontSize: '11px', textTransform: 'uppercase', borderBottom: '2px solid #334155' }}>
            <tr>
              <th style={{ padding: '15px 10px' }}>CUSTOMER</th>
              <th style={{ padding: '15px 10px', color: '#10b981' }}>DEPOT</th>
              <th style={{ padding: '15px 10px' }}>CONSIGNEE</th>
              <th style={{ padding: '15px 10px', color: '#38bdf8' }}>ITEM TYPE</th>
              <th style={{ padding: '15px 10px', color: '#c084fc' }}>VEHICLE CAP.</th>
              <th style={{ padding: '15px 10px', color: '#f59e0b' }}>RTKM</th>
              <th style={{ padding: '15px 10px', color: '#10b981' }}>BILLING / RATE</th>
              <th style={{ padding: '15px 10px', color: '#f59e0b' }}>HSD</th>
              <th style={{ padding: '15px 10px', color: '#f59e0b' }}>CASH</th>
              <th style={{ padding: '15px 10px', textAlign: 'center' }}>STATUS</th>
              <th style={{ padding: '15px 10px', textAlign: 'center' }}>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={11} style={{ padding: '30px', textAlign: 'center', color: '#38bdf8' }}>Loading Data...</td></tr>
            ) : filteredRoutes.length === 0 ? (
              <tr><td colSpan={11} style={{ padding: '30px', textAlign: 'center', color: '#ef4444' }}>No matching routes found!</td></tr>
            ) : (
              filteredRoutes.map(r => {
                const isActive = r.Status !== 'Inactive';
                return (
                  <tr key={r.id} style={{ borderBottom: '1px solid #1e293b', color: isActive ? '#cbd5e1' : '#64748b', fontSize: '13px', transition: '0.2s', opacity: isActive ? 1 : 0.6 }} onMouseOver={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.02)'} onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}>
                    <td style={{ padding: '15px 10px' }}>{r.Customer || r.customer_name}</td>
                    <td style={{ padding: '15px 10px', color: isActive ? '#10b981' : '#64748b', fontWeight: 'bold' }}>{r.Depot_Link || r.depot_link}</td>
                    <td style={{ padding: '15px 10px' }}>{r.Consignee_Name || r.consignee_name}</td>
                    <td style={{ padding: '15px 10px', color: isActive ? '#38bdf8' : '#64748b' }}>{r.Item_Type || 'N/A'}</td>
                    
                    <td style={{ padding: '15px 10px', color: isActive ? '#c084fc' : '#64748b', fontWeight: 'bold' }}>
                      {r.Vehicle_Capacity || 'ALL (Standard)'}
                    </td>
                    
                    <td style={{ padding: '15px 10px', fontWeight: 'bold', color: isActive ? '#fff' : '#64748b' }}>{r.RTKM_Distance || r.rtkm_distance}</td>
                    <td style={{ padding: '15px 10px' }}>
                      {(() => {
                        const bt = BILLING_TYPES.find(b => b.key === (r.Billing_Type || 'PER_KL'));
                        const cur = resolveRate(r, new Date().toISOString().slice(0, 10));
                        return (
                          <div title={bt?.formula}>
                            <span style={{ fontSize: '10px', fontWeight: 'bold', color: '#10b981', border: '1px solid #10b981', borderRadius: '10px', padding: '1px 8px' }}>{bt?.label || 'Per KL'}</span>
                            <div style={{ fontSize: '12px', marginTop: '4px', color: cur.rate > 0 ? '#10b981' : '#64748b', fontWeight: 'bold' }}>
                              {cur.rate > 0 ? `₹${cur.rate}` : 'No rate'}
                              {cur.source === 'history' && <span style={{ color: '#c084fc', fontSize: '9px' }}> ·Q</span>}
                            </div>
                          </div>
                        );
                      })()}
                    </td>
                    <td style={{ padding: '15px 10px' }}>
                      {(r.Fixed_HSD && parseFloat(r.Fixed_HSD) > 0)
                        ? `${r.Fixed_HSD} L`
                        : <span style={{ color: '#64748b' }} title="Auto-estimated from RTKM ÷ mileage">~{calcHsd(r.RTKM_Distance || r.rtkm_distance, r.Vehicle_Capacity)} L</span>}
                    </td>
                    <td style={{ padding: '15px 10px' }}>
                      {(r.Fixed_Cash && parseFloat(r.Fixed_Cash) > 0)
                        ? `₹${r.Fixed_Cash}`
                        : <span style={{ color: '#64748b' }} title="Auto-estimated from RTKM × cash/km">~₹{calcCash(r.RTKM_Distance || r.rtkm_distance)}</span>}
                    </td>
                    
                    <td style={{ padding: '15px 10px', textAlign: 'center' }}>
                      <button 
                        onClick={() => handleToggleStatus(r.id, r.Status || 'Active')}
                        style={{ background: isActive ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', color: isActive ? '#10b981' : '#ef4444', border: `1px solid ${isActive ? '#10b981' : '#ef4444'}`, padding: '4px 10px', borderRadius: '20px', fontSize: '10px', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}
                      >
                        {isActive ? '🟢 ACTIVE' : '🔴 INACTIVE'}
                      </button>
                    </td>

                    <td style={{ padding: '15px 10px', textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                        <button onClick={() => handleEdit(r)} style={{ background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '6px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', transition: '0.2s' }} title="Edit">
                          ✏️ Edit
                        </button>
                        <button onClick={() => handleDelete(r.id)} style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', padding: '6px 10px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', transition: '0.2s' }} title="Delete">
                          🗑️ Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

    </div>
  );
}