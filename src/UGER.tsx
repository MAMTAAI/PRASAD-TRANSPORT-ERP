// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function UserMgmt() {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [usersList, setUsersList] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // 🔐 पासवर्ड फील्ड को यहाँ जोड़ दिया गया है
  const [formData, setFormData] = useState({
    full_name: '', mobile: '', email: '', password: '', role: 'DATA ENTRY STAFF', status: 'ACTIVE'
  });

  // 🛡️ ADVANCED PERMISSIONS WITH CATEGORIES
  const getDefaultModules = () => [
    // 🚛 OPERATIONS MODULE
    { name: 'Operations Dashboard', category: '🚛 OPERATIONS', view: true, add: false, edit: false, delete: false, approve: false },
    { name: 'Vehicle Fleet', category: '🚛 OPERATIONS', view: false, add: false, edit: false, delete: false, approve: false },
    { name: 'Driver Master', category: '🚛 OPERATIONS', view: false, add: false, edit: false, delete: false, approve: false },
    { name: 'Trip Management', category: '🚛 OPERATIONS', view: false, add: false, edit: false, delete: false, approve: false },
    { name: 'Fuel & Maintenance', category: '🚛 OPERATIONS', view: false, add: false, edit: false, delete: false, approve: false },
    { name: 'Loading / Unloading', category: '🚛 OPERATIONS', view: false, add: false, edit: false, delete: false, approve: false },

    // 💰 ACCOUNTS & ADMIN MODULE
    { name: 'Finance Hub', category: '💰 ACCOUNTS & ADMIN', view: false, add: false, edit: false, delete: false, approve: false },
    { name: 'User & Role Mgmt', category: '💰 ACCOUNTS & ADMIN', view: false, add: false, edit: false, delete: false, approve: false },
    { name: 'Billing & Invoicing', category: '💰 ACCOUNTS & ADMIN', view: false, add: false, edit: false, delete: false, approve: false },
    { name: 'Ledger & Cash Book', category: '💰 ACCOUNTS & ADMIN', view: false, add: false, edit: false, delete: false, approve: false },
    { name: 'Tax (GST/TDS) & Toll', category: '💰 ACCOUNTS & ADMIN', view: false, add: false, edit: false, delete: false, approve: false },

    // 🤝 CUSTOMER (CRM) MODULE
    { name: 'CRM Dashboard', category: '🤝 CUSTOMER (CRM)', view: false, add: false, edit: false, delete: false, approve: false },
    { name: 'Customer Master', category: '🤝 CUSTOMER (CRM)', view: false, add: false, edit: false, delete: false, approve: false },
  ];
  
  const [modules, setModules] = useState(getDefaultModules());

  useEffect(() => { fetchUsers(); }, []);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "USERS"));
      setUsersList(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleAddNew = () => {
    setFormData({ full_name: '', mobile: '', email: '', password: '', role: 'DATA ENTRY STAFF', status: 'ACTIVE' });
    setModules(getDefaultModules());
    setEditingId(null);
    setIsModalOpen(true); 
  };

  const handleSave = async () => {
    // ✅ चेक करें कि लॉगिन के लिए ईमेल और पासवर्ड भरा हुआ है या नहीं
    if (!formData.email || !formData.password) return alert("⚠️ Login Email ID and Password are required!");
    if (!formData.full_name) return alert("⚠️ Name is required!");
    
    try {
      if (editingId) {
        await updateDoc(doc(db, "USERS", editingId), { ...formData, permissions: modules });
        alert("✅ User Profile Updated!");
      } else {
        await addDoc(collection(db, "USERS"), { ...formData, permissions: modules, createdAt: serverTimestamp() });
        alert("✅ New Staff Added Successfully! They can now login with this Email and Password.");
      }
      setIsModalOpen(false); 
      fetchUsers(); 
    } catch (err) { alert("❌ Error saving data!"); console.error(err); }
  };

  const handleEdit = (user: any) => {
    // ✏️ एडिट करते समय पुराना पासवर्ड भी फॉर्म में ले आएं
    setFormData({ full_name: user.full_name, mobile: user.mobile, email: user.email || '', password: user.password || '', role: user.role, status: user.status || 'ACTIVE' });
    
    const userPerms = user.permissions || [];
    const defaultPerms = getDefaultModules();
    const mergedPerms = defaultPerms.map(defMod => {
      const existing = userPerms.find((p: any) => p.name === defMod.name);
      return existing ? { ...defMod, ...existing } : defMod;
    });

    setModules(mergedPerms);
    setEditingId(user.id);
    setIsModalOpen(true);
  };

  const handleDelete = async (id: string, name: string) => {
    if (window.confirm(`Are you sure you want to permanently delete ${name}?`)) {
      await deleteDoc(doc(db, "USERS", id));
      fetchUsers();
    }
  };

  const toggleStatus = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    await updateDoc(doc(db, "USERS", id), { status: newStatus });
    fetchUsers();
  };

  const handlePermissionChange = (index: number, field: string, value: boolean) => {
    const newModules = [...modules];
    newModules[index] = { ...newModules[index], [field]: value };
    setModules(newModules);
  };

  const categories = ['🚛 OPERATIONS', '💰 ACCOUNTS & ADMIN', '🤝 CUSTOMER (CRM)'];

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)', color: 'white' }}>
      
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; transition: all 0.4s; }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .glow-btn { background: linear-gradient(135deg, #3b82f6, #6366f1); color: white; border: none; padding: 12px 25px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { box-shadow: 0 0 20px rgba(99, 102, 241, 0.6); transform: scale(1.05); }
        .action-btn { background: transparent; border: 1px solid #475569; color: #cbd5e1; padding: 6px 10px; border-radius: 5px; cursor: pointer; transition: 0.3s; margin-right: 5px; font-size: 12px; }
        .action-btn:hover { background: #334155; color: white; border-color: #94a3b8; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px 15px; outline: none; width: 100%; box-sizing: border-box; font-size: 13px; margin-top: 5px; }
        .modern-input:focus { border-color: #38bdf8; box-shadow: 0 0 10px rgba(56, 189, 248, 0.3); }
        
        .perm-scroll::-webkit-scrollbar { width: 6px; }
        .perm-scroll::-webkit-scrollbar-track { background: transparent; }
        .perm-scroll::-webkit-scrollbar-thumb { background: #475569; border-radius: 10px; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '38px', fontWeight: '900' }}>👑 ADMIN CONTROL ROOM</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Manage System Users, Passwords & Permissions</p>
        </div>
        <button className="glow-btn" onClick={handleAddNew}>+ Add New Staff</button>
      </div>

      {/* 👤 Users List Table */}
      <div className="glass-card" style={{ padding: '25px', overflowX: 'auto' }}>
        <h3 style={{ color: '#94a3b8', marginTop: 0 }}>Active System Users</h3>
        {usersList.length === 0 ? (
          <p style={{ color: '#64748b' }}>No users found. Click "+ Add New Staff".</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '800px' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #334155', color: '#38bdf8' }}>
                <th style={{ padding: '12px' }}>Name & Email ID (User ID)</th>
                <th style={{ padding: '12px' }}>Mobile</th>
                <th style={{ padding: '12px' }}>System Role</th>
                <th style={{ padding: '12px' }}>Account Status</th>
                <th style={{ padding: '12px' }}>Actions (Edit/Delete)</th>
              </tr>
            </thead>
            <tbody>
              {usersList.map((user) => (
                <tr key={user.id} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '12px' }}>
                    <div style={{ fontWeight: 'bold', color: '#f8fafc' }}>{user.full_name}</div>
                    <div style={{ fontSize: '12px', color: '#64748b', marginTop: '4px' }}>{user.email || 'No Login ID'}</div>
                  </td>
                  <td style={{ padding: '12px', color: '#cbd5e1' }}>{user.mobile}</td>
                  <td style={{ padding: '12px' }}>
                    <span style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', padding: '4px 8px', borderRadius: '5px', fontSize: '11px', fontWeight: 'bold', border: '1px solid rgba(56, 189, 248, 0.3)' }}>
                      {user.role}
                    </span>
                  </td>
                  <td style={{ padding: '12px' }}>
                    <button onClick={() => toggleStatus(user.id, user.status || 'ACTIVE')} style={{ background: user.status === 'INACTIVE' ? 'rgba(239, 68, 68, 0.1)' : 'rgba(16, 185, 129, 0.1)', color: user.status === 'INACTIVE' ? '#ef4444' : '#10b981', border: `1px solid ${user.status === 'INACTIVE' ? '#ef4444' : '#10b981'}`, padding: '4px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold', cursor: 'pointer' }}>
                      {user.status === 'INACTIVE' ? '🔴 INACTIVE' : '🟢 ACTIVE'}
                    </button>
                  </td>
                  <td style={{ padding: '12px' }}>
                    <button className="action-btn" onClick={() => handleEdit(user)}>✏️ Edit & Set Pass</button>
                    <button className="action-btn" onClick={() => handleDelete(user.id, user.full_name)} style={{ color: '#ef4444', borderColor: 'rgba(239, 68, 68, 0.3)' }}>🗑️ Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 🚀 MODAL: ADD/EDIT USER */}
      {isModalOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(2, 6, 23, 0.85)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, backdropFilter: 'blur(10px)', padding: '20px' }}>
          <div className="glass-card" style={{ width: '100%', maxWidth: '1000px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', border: '1px solid #c084fc', overflow: 'hidden' }}>
            
            {/* Modal Header */}
            <div style={{ padding: '20px 30px', borderBottom: '1px solid #1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(15, 23, 42, 0.8)' }}>
              <h2 className="gradient-text" style={{ margin: 0 }}>{editingId ? '✏️ Edit User & Password' : '✨ Create New User Profile'}</h2>
              <button onClick={() => setIsModalOpen(false)} style={{ background: 'transparent', color: '#ef4444', border: 'none', fontSize: '24px', cursor: 'pointer' }}>✖</button>
            </div>

            {/* Modal Body */}
            <div style={{ display: 'grid', gridTemplateColumns: window.innerWidth > 850 ? '1fr 2fr' : '1fr', gap: '30px', padding: '30px', overflowY: 'auto' }} className="perm-scroll">
              
              {/* 🧑‍💻 LEFT: CORE IDENTITY */}
              <div>
                <h4 style={{ color: '#38bdf8', marginTop: 0, borderBottom: '1px solid #334155', paddingBottom: '10px' }}>CORE IDENTITY</h4>
                <div style={{ marginBottom: '15px' }}><label style={{ fontSize: '12px', color: '#94a3b8' }}>Full Name *</label><input className="modern-input" value={formData.full_name} onChange={e => setFormData({...formData, full_name: e.target.value})} placeholder="Staff Name" /></div>
                <div style={{ marginBottom: '15px' }}><label style={{ fontSize: '12px', color: '#94a3b8' }}>Mobile Number *</label><input className="modern-input" value={formData.mobile} onChange={e => setFormData({...formData, mobile: e.target.value})} placeholder="10-digit number" /></div>
                
                {/* 📧 LOGIN CREDENTIALS */}
                <h4 style={{ color: '#10b981', marginTop: '25px', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>LOGIN CREDENTIALS</h4>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Login ID (Email) *</label>
                  <input className="modern-input" type="email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} placeholder="staff@company.com" style={{borderColor: '#10b981'}} />
                </div>
                
                <div style={{ marginBottom: '20px' }}>
                  <label style={{ fontSize: '12px', color: '#94a3b8' }}>Login Password *</label>
                  <input className="modern-input" type="text" value={formData.password} onChange={e => setFormData({...formData, password: e.target.value})} placeholder="Set a strong password" style={{borderColor: '#10b981'}} />
                </div>
                
                <div style={{ display: 'flex', gap: '10px' }}>
                  <div style={{ flex: 1 }}>
                    <label style={{ fontSize: '12px', color: '#94a3b8' }}>System Role *</label>
                    <input className="modern-input" list="role-options" value={formData.role} onChange={e => setFormData({...formData, role: e.target.value.toUpperCase()})} placeholder="Role..." />
                    <datalist id="role-options"><option value="ADMIN" /><option value="MANAGER" /><option value="ACCOUNTANT" /><option value="DATA ENTRY STAFF" /></datalist>
                  </div>
                  <div style={{ width: '100px' }}>
                    <label style={{ fontSize: '12px', color: '#94a3b8' }}>Status</label>
                    <select className="modern-input" value={formData.status} onChange={e => setFormData({...formData, status: e.target.value})} style={{ color: formData.status === 'ACTIVE' ? '#10b981' : '#ef4444', fontWeight: 'bold' }}>
                      <option value="ACTIVE">ACTIVE</option>
                      <option value="INACTIVE">INACTIVE</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* 🛡️ RIGHT: MODULE PERMISSIONS (Grouped by Category) */}
              <div style={{ background: 'rgba(0,0,0,0.3)', padding: '20px', borderRadius: '15px', border: '1px solid #334155' }}>
                <h4 style={{ color: '#f59e0b', marginTop: 0, textAlign: 'center' }}>ADVANCED MODULE PERMISSIONS</h4>
                <p style={{ fontSize: '11px', color: '#64748b', marginBottom: '20px', textAlign: 'center' }}>Grant specific rights including Delete & Approval powers.</p>
                
                {/* 📂 Mapping Categories */}
                {categories.map((catName) => (
                  <div key={catName} style={{ marginBottom: '25px' }}>
                    <div style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#e2e8f0', padding: '8px 15px', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold', marginBottom: '10px', borderLeft: '4px solid #38bdf8' }}>
                      {catName}
                    </div>
                    
                    <div style={{ paddingLeft: '10px' }}>
                      {modules.map((mod, index) => {
                        if (mod.category !== catName) return null; 
                        return (
                          <div key={index} style={{ marginBottom: '10px', paddingBottom: '10px', borderBottom: '1px dotted #1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                            <div style={{ fontWeight: 'bold', color: '#cbd5e1', fontSize: '13px', width: '160px' }}>{mod.name}</div>
                            <div style={{ display: 'flex', gap: '15px', fontSize: '12px', color: '#94a3b8' }}>
                              <label style={{ cursor: 'pointer' }}><input type="checkbox" checked={mod.view} onChange={(e) => handlePermissionChange(index, 'view', e.target.checked)} /> View</label>
                              <label style={{ cursor: 'pointer' }}><input type="checkbox" checked={mod.add} onChange={(e) => handlePermissionChange(index, 'add', e.target.checked)} /> Add</label>
                              <label style={{ cursor: 'pointer' }}><input type="checkbox" checked={mod.edit} onChange={(e) => handlePermissionChange(index, 'edit', e.target.checked)} /> Edit</label>
                              <label style={{ cursor: 'pointer', color: '#ef4444' }}><input type="checkbox" checked={mod.delete} onChange={(e) => handlePermissionChange(index, 'delete', e.target.checked)} /> Delete</label>
                              <label style={{ cursor: 'pointer', color: '#10b981', fontWeight: 'bold' }}><input type="checkbox" checked={mod.approve} onChange={(e) => handlePermissionChange(index, 'approve', e.target.checked)} /> Approve</label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

            </div>

            {/* Modal Footer */}
            <div style={{ padding: '20px 30px', textAlign: 'right', borderTop: '1px solid #1e293b', background: 'rgba(15, 23, 42, 0.8)' }}>
              <button className="glow-btn" onClick={handleSave} style={{ padding: '12px 30px' }}>{editingId ? '💾 UPDATE PROFILE' : '✅ GRANT ACCESS & SAVE'}</button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}