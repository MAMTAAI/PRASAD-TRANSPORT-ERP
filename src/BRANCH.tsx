// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase'; 

export default function BRANCH() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [branchesList, setBranchesList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState(null);

  // 📝 BRANCH CORE DETAILS
  const [formData, setFormData] = useState({
    branch_name: '',
    branch_code: '',
    city: '',
    address: '',
    contact_no: '',
    status: 'ACTIVE'
  });

  // 🛡️ ALL SYSTEM MODULES (सिर्फ़ यह तय करने के लिए कि ब्रांच में यह चालू रहेगा या बंद)
  const getAllSystemModules = () => [
    // 🚛 OPERATIONS
    { id: 'DASHBOARD', name: 'Operations Dashboard', category: '🚛 OPERATIONS', isEnabled: true },
    { id: 'TRIP', name: 'Trip Management', category: '🚛 OPERATIONS', isEnabled: true },
    { id: 'VEHICLE', name: 'Vehicle Fleet', category: '🚛 OPERATIONS', isEnabled: true },
    { id: 'MARKET_VEHICLE', name: 'Market Vehicles (Vendors)', category: '🚛 OPERATIONS', isEnabled: true },
    { id: 'DRIVER', name: 'Driver Master (DL)', category: '🚛 OPERATIONS', isEnabled: true },
    { id: 'LOADING', name: 'Loading / Unloading', category: '🚛 OPERATIONS', isEnabled: true },
    { id: 'DOCS', name: 'Vehicle Documents', category: '🚛 OPERATIONS', isEnabled: true },
    { id: 'FUEL', name: 'Fuel & Maintenance', category: '🚛 OPERATIONS', isEnabled: true },
    { id: 'LOCATION_RTKM', name: 'Route & RTKM Master', category: '🚛 OPERATIONS', isEnabled: true },

    // 💰 ACCOUNTS & ADMIN
    { id: 'BANK', name: 'Cash & Bank Book', category: '💰 ACCOUNTS', isEnabled: true },
    { id: 'LEDGER', name: 'Ledger Management', category: '💰 ACCOUNTS', isEnabled: true },
    { id: 'PNL', name: 'Finance Hub (P&L)', category: '💰 ACCOUNTS', isEnabled: true },
    { id: 'BILLING', name: 'Billing & Invoicing', category: '💰 ACCOUNTS', isEnabled: true },
    { id: 'GST', name: 'GST & TDS Management', category: '💰 ACCOUNTS', isEnabled: true },
    { id: 'VENDOR', name: 'Vendor Master', category: '💰 ACCOUNTS', isEnabled: true },
    { id: 'LOAN', name: 'Loan & EMI Mgmt', category: '💰 ACCOUNTS', isEnabled: true },

    // 🤝 CRM & TOOLS
    { id: 'CUSTOMER', name: 'Customer CRM', category: '🤝 CRM & TOOLS', isEnabled: true },
    { id: 'WHATSAPP', name: 'WhatsApp AI Dashboard', category: '🤝 CRM & TOOLS', isEnabled: true },
    { id: 'INBOX', name: 'Company Inbox', category: '🤝 CRM & TOOLS', isEnabled: true },
    { id: 'WEB_SETTINGS', name: 'Website Builder', category: '🤝 CRM & TOOLS', isEnabled: true },

    // 🌐 EXTERNAL PORTALS
    { id: 'CUSTOMER_PORTAL', name: 'Customer External Login', category: '🌐 PORTALS', isEnabled: true },
    { id: 'DRIVER_PORTAL', name: 'Driver External Login', category: '🌐 PORTALS', isEnabled: true },
    { id: 'PARTNER_PORTAL', name: 'Fleet Partner Login', category: '🌐 PORTALS', isEnabled: true }
  ];

  const [branchModules, setBranchModules] = useState(getAllSystemModules());

  // 🔄 FETCH BRANCHES
  useEffect(() => { fetchBranches(); }, []);
  const fetchBranches = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "BRANCHES"));
      setBranchesList(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 💾 SAVE / UPDATE BRANCH
  const handleSave = async () => {
    if (!formData.branch_name || !formData.city) return alert("⚠️ Branch Name and City are required!");
    setLoading(true);
    try {
      const finalData = { ...formData, allowedModules: branchModules, updatedAt: serverTimestamp() };
      if (editingId) {
        await updateDoc(doc(db, "BRANCHES", editingId), finalData);
      } else {
        await addDoc(collection(db, "BRANCHES"), { ...finalData, createdAt: serverTimestamp() });
      }
      setIsModalOpen(false); fetchBranches(); alert("✅ Branch Settings Saved!");
    } catch (e) { alert("❌ Error saving branch!"); }
    setLoading(false);
  };

  // ✏️ EDIT BRANCH
  const handleEdit = (branch) => {
    setFormData({ ...branch });
    
    // Merge existing module settings with the master list
    if (branch.allowedModules) {
      const mergedModules = getAllSystemModules().map(sysMod => {
        const existing = branch.allowedModules.find(bMod => bMod.id === sysMod.id);
        return existing ? { ...sysMod, isEnabled: existing.isEnabled } : sysMod;
      });
      setBranchModules(mergedModules);
    } else {
      setBranchModules(getAllSystemModules());
    }
    
    setEditingId(branch.id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id, name) => {
    if (window.confirm(`Are you sure you want to delete ${name}?`)) {
      await deleteDoc(doc(db, "BRANCHES", id));
      fetchBranches();
    }
  };

  const toggleStatus = async (branch) => {
    const newStatus = branch.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await updateDoc(doc(db, "BRANCHES", branch.id), { status: newStatus });
    fetchBranches();
  };

  // 🛡️ TOGGLE MODULE FOR BRANCH
  const handleModuleToggle = (idx, checked) => {
    const updated = [...branchModules];
    updated[idx].isEnabled = checked;
    setBranchModules(updated);
  };

  const categories = Array.from(new Set(branchModules.map(m => m.category)));

  return (
    <div style={{ padding: '20px 30px', minHeight: '100vh', background: '#020617', color: 'white', fontFamily: "'Inter', sans-serif" }}>
      
      <style>{`
        .input-box { width: 100%; padding: 10px; background: #0f172a; border: 1px solid #1e293b; color: white; border-radius: 8px; box-sizing: border-box; margin-top: 5px; }
        .input-box:focus { border-color: #38bdf8; outline: none; }
        .action-btn { background: transparent; border: 1px solid #38bdf8; color: #38bdf8; padding: 4px 8px; border-radius: 5px; cursor: pointer; margin-right: 5px; font-size: 11px; }
        input[type="checkbox"] { cursor: pointer; accent-color: #38bdf8; width: 16px; height: 16px; }
        .module-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px dotted #1e293b; font-size: 13px; }
      `}</style>

      {/* HEADER */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '28px', color: '#10b981' }}>🏢 BRANCH MASTER & SETUP</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0', fontSize: '14px' }}>Control which modules are available for each branch</p>
        </div>
        <button onClick={() => { setEditingId(null); setFormData({branch_name:'', branch_code:'', city:'', address:'', contact_no:'', status:'ACTIVE'}); setBranchModules(getAllSystemModules()); setIsModalOpen(true); }} style={{ background: '#10b981', color: 'white', padding: '10px 20px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>+ Add New Branch</button>
      </div>

      {/* BRANCHES TABLE */}
      <div style={{ background: 'rgba(30, 41, 59, 0.5)', padding: '20px', borderRadius: '15px', border: '1px solid #1e293b', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
          <thead>
            <tr style={{ color: '#10b981', borderBottom: '2px solid #1e293b' }}>
              <th style={{ padding: '12px' }}>Branch Name & Code</th>
              <th style={{ padding: '12px' }}>Location / City</th>
              <th style={{ padding: '12px' }}>Modules Allowed</th>
              <th style={{ padding: '12px' }}>Status</th>
              <th style={{ padding: '12px' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan="5">Loading...</td></tr> : branchesList.map(b => {
              const activeModsCount = b.allowedModules?.filter(m => m.isEnabled).length || 0;
              return (
              <tr key={b.id} style={{ borderBottom: '1px solid #0f172a' }}>
                <td style={{ padding: '12px' }}>
                  <b style={{color: '#38bdf8', fontSize: '15px'}}>{b.branch_name}</b><br/>
                  <small style={{color:'#64748b'}}>Code: {b.branch_code || 'N/A'}</small>
                </td>
                <td style={{ padding: '12px' }}>{b.city}<br/><small style={{color:'#94a3b8'}}>{b.contact_no}</small></td>
                <td style={{ padding: '12px' }}>
                  <span style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', padding: '4px 10px', borderRadius: '10px', fontSize: '12px', fontWeight: 'bold' }}>
                    {activeModsCount} Modules ON
                  </span>
                </td>
                <td style={{ padding: '12px' }}>
                  <button onClick={() => toggleStatus(b)} style={{ background: b.status==='ACTIVE'?'rgba(16,185,129,0.1)':'rgba(239,68,68,0.1)', color: b.status==='ACTIVE'?'#10b981':'#ef4444', border: `1px solid ${b.status==='ACTIVE'?'#10b981':'#ef4444'}`, padding:'4px 10px', borderRadius:'15px', fontSize:'11px', cursor:'pointer', fontWeight:'bold' }}>{b.status}</button>
                </td>
                <td style={{ padding: '12px' }}>
                  <button className="action-btn" onClick={() => handleEdit(b)}>⚙️ Setup</button>
                  <button className="action-btn" style={{borderColor:'#ef4444', color:'#ef4444'}} onClick={() => handleDelete(b.id, b.branch_name)}>🗑️</button>
                </td>
              </tr>
            )})}
          </tbody>
        </table>
      </div>

      {/* FULL SCREEN MODAL */}
      {isModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div style={{ background: '#020617', width: '100%', maxWidth: '1200px', maxHeight: '95vh', borderRadius: '20px', border: '1px solid #10b981', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            
            <div style={{ padding: '15px 25px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #1e293b' }}>
              <h2 style={{ color: '#10b981', margin: 0, fontSize:'20px' }}>⚙️ Setup Branch & Module Limits</h2>
              <button onClick={() => setIsModalOpen(false)} style={{ color: 'red', background: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer' }}>✖</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '350px 1fr', gap: '25px', padding: '25px', overflowY: 'auto' }}>
              
              {/* LEFT: BRANCH INFO */}
              <div style={{ borderRight: '1px solid #1e293b', paddingRight: '20px' }}>
                <h4 style={{ color: '#38bdf8', marginTop: 0, borderBottom: '1px solid #1e293b', paddingBottom:'5px' }}>📍 BRANCH DETAILS</h4>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>BRANCH NAME *</label><input className="input-box" value={formData.branch_name} onChange={e => setFormData({...formData, branch_name: e.target.value})} placeholder="e.g. Siliguri Branch" /></div>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>BRANCH CODE</label><input className="input-box" value={formData.branch_code} onChange={e => setFormData({...formData, branch_code: e.target.value})} placeholder="e.g. SLG-01" /></div>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>CITY / LOCATION *</label><input className="input-box" value={formData.city} onChange={e => setFormData({...formData, city: e.target.value})} placeholder="e.g. Siliguri" /></div>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>CONTACT NUMBER</label><input className="input-box" value={formData.contact_no} onChange={e => setFormData({...formData, contact_no: e.target.value})} /></div>
                <div style={{marginBottom:'10px'}}><label style={{fontSize:'11px', color:'#94a3b8'}}>FULL ADDRESS</label>
                  <textarea className="input-box" style={{height:'80px', resize:'none'}} value={formData.address} onChange={e => setFormData({...formData, address: e.target.value})}></textarea>
                </div>
              </div>

              {/* RIGHT: MODULE TOGGLES */}
              <div>
                <h4 style={{ textAlign: 'center', color: '#f59e0b', margin: '0 0 15px 0' }}>📊 ALLOWED MODULES FOR THIS BRANCH</h4>
                <p style={{textAlign: 'center', fontSize: '12px', color: '#94a3b8', marginTop: '-10px', marginBottom: '20px'}}>
                  Turn OFF modules that should NOT be visible to staff of this branch.
                </p>

                {categories.map(cat => (
                  <div key={cat} style={{ marginBottom: '20px', background: 'rgba(15, 23, 42, 0.4)', padding: '15px', borderRadius: '12px', border: '1px solid #1e293b' }}>
                    <div style={{ color: '#10b981', fontWeight: 'bold', fontSize: '13px', borderBottom: '1px solid #334155', paddingBottom: '5px', marginBottom: '10px' }}>{cat}</div>
                    
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                      {branchModules.filter(m => m.category === cat).map((mod, i) => {
                        const idx = branchModules.findIndex(x => x.id === mod.id);
                        return (
                          <div key={i} className="module-row">
                            <span style={{ fontWeight: '500', color: mod.isEnabled ? 'white' : '#475569' }}>{mod.name}</span>
                            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', background: mod.isEnabled ? 'rgba(56, 189, 248, 0.1)' : 'transparent', padding: '3px 8px', borderRadius: '5px', border: mod.isEnabled ? '1px solid #38bdf8' : '1px solid #334155' }}>
                              <input type="checkbox" checked={mod.isEnabled} onChange={e => handleModuleToggle(idx, e.target.checked)} style={{ marginRight: '8px' }} />
                              <span style={{ fontSize: '11px', color: mod.isEnabled ? '#38bdf8' : '#64748b', fontWeight: 'bold' }}>{mod.isEnabled ? 'ON' : 'OFF'}</span>
                            </label>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>

            </div>

            {/* MODAL FOOTER */}
            <div style={{ padding: '15px 30px', textAlign: 'right', background: '#020617', borderTop: '1px solid #1e293b' }}>
              <button onClick={handleSave} disabled={loading} style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', padding: '12px 50px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px' }}>
                {loading ? '⌛ SAVING...' : '✅ SAVE BRANCH SETTINGS'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}