// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function LedgerMgmt() {
  const [activeTab, setActiveTab] = useState('CREATE'); // CREATE or TRIAL
  const [ledgers, setLedgers] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // 🏢 DYNAMIC MASTER DATA STATES (Companies & Branches)
  const [companies, setCompanies] = useState<string[]>(['Loading Companies...']);
  const [branches, setBranches] = useState<string[]>(['Loading Branches...']);

  // 🏢 SMART FILTERS
  const [selectedCompany, setSelectedCompany] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('ALL');

  // 📝 LEDGER FORM STATE
  const [formData, setFormData] = useState({
    name: '',
    group: 'Direct Incomes (Freight/Trip Revenue)',
    op_balance: '0',
    dr_cr: 'Cr (Credit)'
  });

  const accountGroups = [
    "Capital Account",
    "Current Assets",
    "Current Liabilities",
    "Direct Expenses (Fuel, Toll, Driver Bhatta)",
    "Direct Incomes (Freight/Trip Revenue)",
    "Fixed Assets (Trucks, Office)",
    "Indirect Expenses (Office Rent, Salary)",
    "Indirect Incomes",
    "Loans (Liability)",
    "Suspense A/c",
    "Sundry Debtors (Customers)",
    "Sundry Creditors (Vendors)"
  ];

  useEffect(() => {
    fetchMasterData();
    fetchLedgers();
  }, []);

  // 📥 FETCH DYNAMIC COMPANIES & BRANCHES FROM FIREBASE
  const fetchMasterData = async () => {
    try {
      const cSnap1 = await getDocs(collection(db, "COMPANY")).catch(() => ({ docs: [] }));
      const cSnap2 = await getDocs(collection(db, "COMPANIES")).catch(() => ({ docs: [] }));
      let compList = [...cSnap1.docs, ...cSnap2.docs].map(d => d.data().company_name || d.data().name || d.data().Company_Name);
      compList = [...new Set(compList.filter(Boolean))];
      
      if (compList.length === 0) compList = ['Prasad Transport (Default)']; 
      
      setCompanies(compList);
      setSelectedCompany(compList[0]);

      const bSnap = await getDocs(collection(db, "BRANCH")).catch(() => ({ docs: [] }));
      let branchList = bSnap.docs.map(d => d.data().branch_name || d.data().name);
      branchList = [...new Set(branchList.filter(Boolean))];
      
      if (branchList.length === 0) branchList = ['Bongaigaon HQ'];
      setBranches(branchList);
    } catch (error) {
      console.error("Error fetching master data:", error);
    }
  };

  const fetchLedgers = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, "LEDGERS"), orderBy("created_at", "desc"));
      const querySnapshot = await getDocs(q);
      setLedgers(querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) {
      console.error("Error fetching ledgers", error);
    }
    setLoading(false);
  };

  const handleSaveLedger = async () => {
    if (!formData.name) return alert("⚠️ Please enter Ledger Name!");
    if (!selectedCompany) return alert("⚠️ Please select a Company first!");
    
    setLoading(true);
    try {
      await addDoc(collection(db, "LEDGERS"), {
        ...formData,
        company: selectedCompany,
        branch: selectedBranch,
        op_balance: parseFloat(formData.op_balance) || 0,
        created_at: Timestamp.now()
      });
      alert(`✅ Ledger [${formData.name}] created successfully in ${selectedCompany}!`);
      setFormData({ ...formData, name: '', op_balance: '0' }); // Reset form but keep last selected group & Dr/Cr
      fetchLedgers();
    } catch (error) {
      alert("❌ Error saving ledger!");
    }
    setLoading(false);
  };

  // 🗑️ DELETE LEDGER
  const handleDeleteLedger = async (id: string, name: string) => {
    if (window.confirm(`⚠️ Are you sure you want to delete the ledger [${name}]?\nThis might affect Trial Balance if entries exist.`)) {
      try {
        await deleteDoc(doc(db, "LEDGERS", id));
        fetchLedgers();
      } catch (error) {
        alert("❌ Error deleting ledger.");
      }
    }
  };

  // 🧮 FILTER LEDGERS FOR SELECTED COMPANY
  const filteredLedgers = ledgers.filter(l => 
    l.company === selectedCompany && 
    (selectedBranch === 'ALL' || l.branch === selectedBranch || !l.branch)
  );

  // ⚖️ CALCULATE LIVE TRIAL BALANCE
  let totalDr = 0;
  let totalCr = 0;
  filteredLedgers.forEach(l => {
    if (l.dr_cr && l.dr_cr.includes('Dr')) totalDr += parseFloat(l.op_balance) || 0;
    else totalCr += parseFloat(l.op_balance) || 0;
  });

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px', background: 'radial-gradient(circle at top right, #0f172a, #020617)', minHeight: '100vh', padding: '30px' }}>
      
      {/* HEADER SECTION */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '32px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>
            ⚖️ Ledgers & Trial Balance
          </h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Chart of Accounts & Live Dr/Cr Summaries</p>
        </div>
      </div>

      {/* 🏢 SMART FILTERS (Company & Branch Wise) */}
      <div style={{ background: 'rgba(30, 41, 59, 0.5)', border: '1px solid rgba(255,255,255,0.05)', padding: '20px', borderRadius: '15px', marginBottom: '25px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '250px' }}>
          <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>Select Company *</label>
          <select value={selectedCompany} onChange={e => setSelectedCompany(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold' }}>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: '250px' }}>
          <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>Select Branch</label>
          <select value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px' }}>
            <option value="ALL">-- All Branches (Consolidated) --</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>

      {/* MODULE TABS */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '25px', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>
        <button onClick={() => setActiveTab('CREATE')} style={{ padding: '10px 20px', background: activeTab === 'CREATE' ? 'rgba(56, 189, 248, 0.1)' : 'transparent', color: activeTab === 'CREATE' ? '#38bdf8' : '#94a3b8', border: 'none', borderBottom: activeTab === 'CREATE' ? '3px solid #38bdf8' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', transition: '0.3s', borderRadius: '8px 8px 0 0' }}>
          📂 CREATE LEDGER (COA)
        </button>
        <button onClick={() => setActiveTab('TRIAL')} style={{ padding: '10px 20px', background: activeTab === 'TRIAL' ? 'rgba(16, 185, 129, 0.1)' : 'transparent', color: activeTab === 'TRIAL' ? '#10b981' : '#94a3b8', border: 'none', borderBottom: activeTab === 'TRIAL' ? '3px solid #10b981' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', transition: '0.3s', borderRadius: '8px 8px 0 0' }}>
          ⚖️ TRIAL BALANCE (LIVE)
        </button>
      </div>

      {/* 📂 TAB 1: CREATE LEDGER */}
      {activeTab === 'CREATE' && (
        <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
          
          {/* Left: Form */}
          <div style={{ flex: '1 1 400px', background: '#1e293b', borderRadius: '15px', padding: '25px', border: '1px solid #334155' }}>
            <h3 style={{ color: '#fff', margin: '0 0 20px 0', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ color: '#38bdf8' }}>➕</span> Add New Account Head
            </h3>

            <label style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '5px', display: 'block' }}>Ledger Name (e.g. HSD DIESEL) *</label>
            <input type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', marginBottom: '15px', boxSizing: 'border-box' }} />

            <label style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '5px', display: 'block' }}>Account Group *</label>
            <select value={formData.group} onChange={e => setFormData({...formData, group: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', marginBottom: '15px', boxSizing: 'border-box' }}>
              {accountGroups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>

            <div style={{ display: 'flex', gap: '15px', marginBottom: '25px' }}>
              <div style={{ flex: 1 }}>
                <label style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '5px', display: 'block' }}>Opening Balance (₹)</label>
                <input type="number" value={formData.op_balance} onChange={e => setFormData({...formData, op_balance: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', boxSizing: 'border-box' }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '5px', display: 'block' }}>Dr / Cr</label>
                <select value={formData.dr_cr} onChange={e => setFormData({...formData, dr_cr: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', boxSizing: 'border-box' }}>
                  <option value="Dr (Debit)">DR (Debit)</option>
                  <option value="Cr (Credit)">CR (Credit)</option>
                </select>
              </div>
            </div>

            <button onClick={handleSaveLedger} style={{ width: '100%', background: 'linear-gradient(135deg, #38bdf8, #2563eb)', color: '#fff', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '16px', boxShadow: '0 5px 15px rgba(56,189,248,0.4)' }}>
              {loading ? 'Saving...' : '✅ Save Ledger'}
            </button>
          </div>

          {/* Right: List of Ledgers */}
          <div style={{ flex: '2 1 600px', background: '#1e293b', borderRadius: '15px', padding: '25px', border: '1px solid #334155' }}>
            <h3 style={{ color: '#fff', margin: '0 0 20px 0', display: 'flex', justifyContent: 'space-between' }}>
              <span>📋 Chart of Accounts (Existing Ledgers)</span>
              <span style={{ fontSize: '12px', color: '#38bdf8', background: 'rgba(56, 189, 248, 0.1)', padding: '5px 10px', borderRadius: '20px' }}>{selectedCompany}</span>
            </h3>
            
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead style={{ background: '#0f172a', color: '#c084fc', fontSize: '12px' }}>
                  <tr>
                    <th style={{ padding: '12px 15px' }}>Ledger Name</th>
                    <th style={{ padding: '12px 15px' }}>Group</th>
                    <th style={{ padding: '12px 15px', textAlign: 'right' }}>Opening Bal.</th>
                    <th style={{ padding: '12px 15px', textAlign: 'center' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLedgers.length === 0 ? <tr><td colSpan={4} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No Ledgers Created for {selectedCompany}.</td></tr> : 
                    filteredLedgers.map(l => (
                    <tr key={l.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '14px' }}>
                      <td style={{ padding: '12px 15px', fontWeight: 'bold', color: '#fff' }}>{l.name}</td>
                      <td style={{ padding: '12px 15px', fontSize: '12px' }}>{l.group}</td>
                      <td style={{ padding: '12px 15px', textAlign: 'right', color: (l.dr_cr || '').includes('Dr') ? '#38bdf8' : '#f59e0b', fontWeight: 'bold' }}>
                        {parseFloat(l.op_balance).toLocaleString('en-IN')} <span style={{ fontSize: '10px' }}>{(l.dr_cr || '').includes('Dr') ? 'Dr' : 'Cr'}</span>
                      </td>
                      <td style={{ padding: '12px 15px', textAlign: 'center' }}>
                         <span onClick={() => handleDeleteLedger(l.id, l.name)} style={{ cursor: 'pointer', color: '#ef4444', fontSize: '16px' }} title="Delete Ledger">🗑️</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ⚖️ TAB 2: TRIAL BALANCE */}
      {activeTab === 'TRIAL' && (
        <div style={{ background: '#1e293b', borderRadius: '15px', padding: '25px', border: '1px solid #334155' }}>
          
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
             <h3 style={{ color: '#fff', margin: 0 }}>⚖️ Live Trial Balance</h3>
             <span style={{ fontSize: '12px', color: '#10b981', background: 'rgba(16, 185, 129, 0.1)', padding: '5px 15px', borderRadius: '20px', fontWeight: 'bold', border: '1px solid #10b981' }}>Company: {selectedCompany}</span>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead style={{ background: '#0f172a', color: '#94a3b8', fontSize: '12px', textTransform: 'uppercase' }}>
                <tr>
                  <th style={{ padding: '15px 20px' }}>Particulars (Ledger Heads)</th>
                  <th style={{ padding: '15px 20px', textAlign: 'right', color: '#38bdf8' }}>Debit (Dr) ₹</th>
                  <th style={{ padding: '15px 20px', textAlign: 'right', color: '#f59e0b' }}>Credit (Cr) ₹</th>
                </tr>
              </thead>
              <tbody>
                {filteredLedgers.length === 0 ? <tr><td colSpan={3} style={{ padding: '30px', textAlign: 'center', color: '#64748b' }}>No Data Available for Trial Balance.</td></tr> : 
                  filteredLedgers.map(l => (
                  <tr key={l.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '14px' }}>
                    <td style={{ padding: '15px 20px' }}>
                      <div style={{ fontWeight: 'bold', color: '#fff' }}>{l.name}</div>
                      <div style={{ fontSize: '11px', color: '#64748b' }}>{l.group}</div>
                    </td>
                    <td style={{ padding: '15px 20px', textAlign: 'right', fontWeight: 'bold', color: '#38bdf8' }}>
                      {(l.dr_cr || '').includes('Dr') && parseFloat(l.op_balance) > 0 ? parseFloat(l.op_balance).toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}
                    </td>
                    <td style={{ padding: '15px 20px', textAlign: 'right', fontWeight: 'bold', color: '#f59e0b' }}>
                      {(l.dr_cr || '').includes('Cr') && parseFloat(l.op_balance) > 0 ? parseFloat(l.op_balance).toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot style={{ background: '#020617', color: '#fff', fontWeight: '900', fontSize: '18px' }}>
                <tr>
                  <td style={{ padding: '20px', textAlign: 'right' }}>GRAND TOTAL :</td>
                  <td style={{ padding: '20px', textAlign: 'right', color: '#38bdf8' }}>₹ {totalDr.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                  <td style={{ padding: '20px', textAlign: 'right', color: '#f59e0b' }}>₹ {totalCr.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                </tr>
                {totalDr !== totalCr && (
                  <tr>
                    <td colSpan={3} style={{ padding: '15px', textAlign: 'center', color: '#ef4444', fontSize: '14px', background: 'rgba(239,68,68,0.1)', borderTop: '2px dashed #ef4444' }}>
                      ⚠️ Warning: Trial Balance is not tallied. Difference: <b>₹ {Math.abs(totalDr - totalCr).toLocaleString('en-IN', {minimumFractionDigits: 2})}</b>
                    </td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        </div>
      )}

    </div>
  );
}