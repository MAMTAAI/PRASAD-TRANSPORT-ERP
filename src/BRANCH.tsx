import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function BranchMgmt() {
  const [branches, setBranches] = useState<any[]>([]);
  const [companies, setCompanies] = useState<any[]>([]); // 🏢 कंपनियों की लिस्ट के लिए
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  // 📝 एक्सेल शीट के 5 फील्ड्स
  const [formData, setFormData] = useState({
    branch_name: '',
    city: '',
    company: '',
    manager: '',
    contact: ''
  });

  useEffect(() => { 
    fetchBranches(); 
    fetchCompanies(); // लोड होते ही कंपनियों की लिस्ट भी लाएगा
  }, []);

  const fetchBranches = async () => {
    setLoading(true);
    try {
      const snap = await getDocs(collection(db, "BRANCHES"));
      setBranches(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const fetchCompanies = async () => {
    try {
      const snap = await getDocs(collection(db, "COMPANIES"));
      setCompanies(snap.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (e) { console.error(e); }
  };

  const handleSave = async () => {
    if (!formData.branch_name || !formData.company) return alert("Branch Name and Company are required!");
    try {
      if (editingId) {
        await updateDoc(doc(db, "BRANCHES", editingId), formData);
      } else {
        await addDoc(collection(db, "BRANCHES"), { ...formData, createdAt: serverTimestamp() });
      }
      resetForm(); fetchBranches();
    } catch (err) { alert("Error saving data!"); }
  };

  const handleDelete = async (id: string, name: string) => {
    if (window.confirm(`Are you sure you want to delete ${name}?`)) {
      await deleteDoc(doc(db, "BRANCHES", id));
      fetchBranches();
    }
  };

  const resetForm = () => {
    setFormData({ branch_name: '', city: '', company: '', manager: '', contact: '' });
    setShowForm(false); setEditingId(null);
  };

  const filteredBranches = branches.filter(b => 
    b.branch_name?.toLowerCase().includes(searchTerm.toLowerCase()) || 
    b.city?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    b.company?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top left, #0f172a, #020617)' }}>
      {/* 🟢 2026 Smart UI CSS */}
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); backdrop-filter: blur(12px); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 20px; transition: all 0.4s; }
        .glass-card:hover { transform: translateY(-5px); border-color: rgba(16, 185, 129, 0.5); box-shadow: 0 10px 30px -10px rgba(16, 185, 129, 0.3); }
        .gradient-text { background: linear-gradient(135deg, #10b981, #38bdf8); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .glow-btn { background: linear-gradient(135deg, #10b981, #059669); box-shadow: 0 0 20px rgba(16, 185, 129, 0.4); color: white; border: none; padding: 12px 25px; border-radius: 50px; font-weight: bold; cursor: pointer; transition: 0.3s; display: inline-flex; align-items: center; gap: 8px;}
        .glow-btn:hover { box-shadow: 0 0 35px rgba(16, 185, 129, 0.8); transform: scale(1.05); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 12px; color: white; padding: 12px 16px; outline: none; transition: all 0.3s; width: 100%; box-sizing: border-box; font-size: 14px;}
        .modern-input:focus { border-color: #10b981; box-shadow: 0 0 15px rgba(16, 185, 129, 0.3); }
        ::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-thumb { background: #334155; border-radius: 10px; }
      `}</style>

      {/* 🚀 Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '38px', fontWeight: '900' }}>Smart Branch Network</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Manage all operating locations & managers</p>
        </div>
        <button className="glow-btn" onClick={() => setShowForm(true)}>
          <span style={{ fontSize: '20px' }}>+</span> Add New Branch
        </button>
      </div>

      {/* 🔍 Search Bar & Stats */}
      <div style={{ display: 'flex', gap: '20px', marginBottom: '30px', alignItems: 'center' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input 
            placeholder="🔍 Search by branch name, city or company..." 
            className="modern-input" 
            style={{ paddingLeft: '45px', borderRadius: '50px' }} 
            onChange={(e) => setSearchTerm(e.target.value)} 
          />
        </div>
        <div className="glass-card" style={{ padding: '12px 25px', borderRadius: '50px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontSize: '24px' }}>📍</span>
          <div>
            <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 'bold' }}>Total Branches</div>
            <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#10b981' }}>{branches.length}</div>
          </div>
        </div>
      </div>

      {/* 📍 Futuristic Grid View */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))', gap: '25px' }}>
        {filteredBranches.map((b) => (
          <div key={b.id} className="glass-card" style={{ padding: '25px', position: 'relative' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '15px' }}>
              <h2 style={{ color: '#f8fafc', margin: 0, fontSize: '22px' }}>{b.branch_name}</h2>
              <span style={{ background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', padding: '5px 12px', borderRadius: '8px', fontSize: '12px', fontWeight: 'bold', border: '1px solid rgba(16, 185, 129, 0.3)' }}>
                {b.city || 'No City'}
              </span>
            </div>
            
            <div style={{ background: 'rgba(0,0,0,0.3)', padding: '12px', borderRadius: '10px', marginBottom: '15px', borderLeft: '3px solid #38bdf8' }}>
              <div style={{ fontSize: '11px', color: '#94a3b8', textTransform: 'uppercase', marginBottom: '3px' }}>Parent Company</div>
              <div style={{ fontSize: '15px', color: '#38bdf8', fontWeight: 'bold' }}>
                🏢 {b.company || 'Not Assigned'}
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '13px', color: '#cbd5e1', marginBottom: '20px' }}>
              <div style={{ display: 'flex', gap: '10px' }}><span>👤</span> <b>Manager:</b> {b.manager || '---'}</div>
              <div style={{ display: 'flex', gap: '10px' }}><span>📞</span> <b>Contact:</b> {b.contact || '---'}</div>
            </div>

            <div style={{ display: 'flex', gap: '10px', borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: '15px' }}>
              <button onClick={() => { setFormData(b); setEditingId(b.id); setShowForm(true); }} style={{ background: 'transparent', border: '1px solid #10b981', color: '#10b981', padding: '8px 15px', borderRadius: '8px', cursor: 'pointer', flex: 1, fontWeight: 'bold', transition: '0.3s' }}>
                Edit Details
              </button>
              <button onClick={() => handleDelete(b.id, b.branch_name)} style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', color: '#ef4444', padding: '8px 15px', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', transition: '0.3s' }}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 🛸 Cyberpunk Form Modal */}
      {showForm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(2, 6, 23, 0.85)', backdropFilter: 'blur(10px)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '35px', width: '100%', maxWidth: '600px', border: '1px solid #10b981' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 className="gradient-text" style={{ margin: 0, fontSize: '24px' }}>{editingId ? 'Edit Branch Setup' : 'Add New Branch'}</h2>
              <button onClick={resetForm} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: '5px' }}>Branch Name *</label>
                  <input className="modern-input" placeholder="e.g. Lumading Branch" value={formData.branch_name} onChange={e => setFormData({...formData, branch_name: e.target.value})} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: '5px' }}>City *</label>
                  <input className="modern-input" placeholder="e.g. Lumading" value={formData.city} onChange={e => setFormData({...formData, city: e.target.value})} />
                </div>
              </div>
              
              <div>
                <label style={{ fontSize: '12px', color: '#38bdf8', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Assign to Company *</label>
                <select className="modern-input" value={formData.company} onChange={e => setFormData({...formData, company: e.target.value})} style={{ border: '1px solid #38bdf8' }}>
                  <option value="">-- Select Parent Company --</option>
                  {companies.map(c => (
                    <option key={c.id} value={c.company_name}>{c.company_name}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: '5px' }}>Manager Name</label>
                  <input className="modern-input" placeholder="Branch Manager" value={formData.manager} onChange={e => setFormData({...formData, manager: e.target.value})} />
                </div>
                <div>
                  <label style={{ fontSize: '12px', color: '#94a3b8', display: 'block', marginBottom: '5px' }}>Contact Number</label>
                  <input className="modern-input" placeholder="Phone No." value={formData.contact} onChange={e => setFormData({...formData, contact: e.target.value})} />
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '30px' }}>
              <button className="glow-btn" onClick={handleSave} style={{ padding: '15px 40px', fontSize: '16px' }}>SAVE BRANCH DATA</button>
            </div>
            
          </div>
        </div>
      )}
    </div>
  );
}