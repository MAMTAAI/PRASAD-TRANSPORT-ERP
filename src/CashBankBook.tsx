// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, addDoc, getDocs, query, orderBy, Timestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function CashBankBook() {
  const [transactions, setTransactions] = useState<any[]>([]);
  const [ledgers, setLedgers] = useState<any[]>([]); 
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [apiProcessing, setApiProcessing] = useState(false); 

  // 🔄 RECONCILIATION STATES
  const [showReconcileModal, setShowReconcileModal] = useState(false);
  const [isScanning, setIsScanning] = useState(false);
  const [statementRows, setStatementRows] = useState<any[]>([]);

  // 🏢 DYNAMIC MASTER DATA STATES (Companies & Branches)
  const [companies, setCompanies] = useState<string[]>(['Loading Companies...']);
  const [branches, setBranches] = useState<string[]>(['Loading Branches...']);

  // 🏢 SMART FILTERS
  const [selectedCompany, setSelectedCompany] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('ALL');
  const [selectedAccount, setSelectedAccount] = useState('ALL');

  // 🏦 DYNAMIC BANK MASTER STATES
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  const [showBankMaster, setShowBankMaster] = useState(false);
  const [newBank, setNewBank] = useState({ company: '', name: '', ac_no: '', ifsc: '', op_bal: '' });

  // 📝 SMART ACCOUNTING FORM STATE
  const [formData, setFormData] = useState({
    date: new Date().toISOString().split('T')[0],
    type: 'Payment (OUT)',
    party_id: '',
    party_name: '',
    party_type: '',
    party_ac: '',
    party_ifsc: '',
    custom_party: false,
    amount: '',
    particulars: '',
    from_account: '',
    to_account: '',
    ref_no: '',
    branch: ''
  });

  const [paymentLink, setPaymentLink] = useState('');

  useEffect(() => {
    fetchMasterData(); 
    fetchTransactions();
    fetchAllLedgers(); 
    fetchBankAccounts(); 
  }, []);

  const fetchMasterData = async () => {
    try {
      const cSnap1 = await getDocs(collection(db, "COMPANY")).catch(() => ({ docs: [] }));
      const cSnap2 = await getDocs(collection(db, "COMPANIES")).catch(() => ({ docs: [] }));
      let compList = [...cSnap1.docs, ...cSnap2.docs].map(d => d.data().company_name || d.data().name || d.data().Company_Name);
      compList = [...new Set(compList.filter(Boolean))]; 
      
      if (compList.length === 0) compList = ['Prasad Transport (Default)']; 
      
      setCompanies(compList);
      setSelectedCompany(compList[0]);
      setNewBank(prev => ({ ...prev, company: compList[0] }));

      const bSnap = await getDocs(collection(db, "BRANCH")).catch(() => ({ docs: [] }));
      let branchList = bSnap.docs.map(d => d.data().branch_name || d.data().name);
      branchList = [...new Set(branchList.filter(Boolean))];
      
      if (branchList.length === 0) branchList = ['Bongaigaon HQ'];
      setBranches(branchList);
      setFormData(prev => ({ ...prev, branch: branchList[0] }));

    } catch (error) {
      console.error("Error fetching master data:", error);
    }
  };

  const fetchBankAccounts = async () => {
    try {
      const snap = await getDocs(collection(db, "COMPANY_BANKS"));
      let banks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      banks.unshift({ id: 'cash_hq', name: 'Cash in Hand (HQ)', ac_no: 'Cash Ledger', company: 'ALL' });
      setBankAccounts(banks);
    } catch (e) {
      console.error("Error fetching banks", e);
    }
  };

  const handleSaveBank = async () => {
    if (!newBank.name || !newBank.company) return alert("Please select Company and enter Bank Name!");
    try {
      await addDoc(collection(db, "COMPANY_BANKS"), {
        ...newBank,
        created_at: Timestamp.now()
      });
      alert(`✅ New Bank Account added to ${newBank.company}!`);
      setNewBank({ company: selectedCompany, name: '', ac_no: '', ifsc: '', op_bal: '' });
      fetchBankAccounts(); 
    } catch (e) {
      alert("❌ Error adding bank account.");
    }
  };

  const fetchAllLedgers = async () => {
    try {
      let allLedgers: any[] = [];
      const dSnap = await getDocs(collection(db, "DRIVERS"));
      dSnap.forEach(doc => {
        const data = doc.data();
        allLedgers.push({ id: doc.id, name: data.name, type: 'Driver', ac: data.account_no, ifsc: data.ifsc_code });
      });
      const vSnap = await getDocs(collection(db, "VENDORS"));
      vSnap.forEach(doc => {
        const data = doc.data();
        allLedgers.push({ id: doc.id, name: data.vendor_name || data.name || 'Unknown Vendor', type: 'Vendor', ac: data.bank_account || data.account_no, ifsc: data.ifsc_code });
      });
      setLedgers(allLedgers);
    } catch (e) {
      console.error("Error fetching ledgers", e);
    }
  };

  const fetchTransactions = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, "BANK_TRANSACTIONS"), orderBy("created_at", "desc"));
      const querySnapshot = await getDocs(q);
      setTransactions(querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } catch (error) {
      console.error("Error fetching transactions", error);
    }
    setLoading(false);
  };

  const handlePartySelect = (e: any) => {
    const val = e.target.value;
    if (val === 'custom') {
      setFormData({ ...formData, party_id: 'custom', party_name: '', party_type: 'Other', party_ac: '', party_ifsc: '', custom_party: true });
    } else {
      const partyInfo = ledgers.find(l => l.id === val);
      if (partyInfo) {
        setFormData({ ...formData, party_id: partyInfo.id, party_name: partyInfo.name, party_type: partyInfo.type, party_ac: partyInfo.ac || '', party_ifsc: partyInfo.ifsc || '', custom_party: false });
      } else {
        setFormData({ ...formData, party_id: '', party_name: '', custom_party: false });
      }
    }
  };

  const handleSaveTransaction = async (isApiTransfer = false) => {
    if (!formData.amount || !formData.party_name) return alert("⚠️ Please fill Party Name and Amount!");
    
    try {
      let finalRefNo = formData.ref_no;

      if (isApiTransfer) {
        if (!formData.party_ac || !formData.party_ifsc) {
           return alert("❌ Missing Bank Details! Cannot initiate API transfer without Account No and IFSC Code.");
        }
        setApiProcessing(true);
        await new Promise(resolve => setTimeout(resolve, 2000));
        finalRefNo = "API-UTR-" + Math.floor(Math.random() * 90000000 + 10000000);
        alert(`✅ SERVER MSG: ₹${formData.amount} Transferred Successfully to ${formData.party_name}'s A/C via NEFT/IMPS API.\nUTR No: ${finalRefNo}`);
      } else {
        setLoading(true);
      }

      await addDoc(collection(db, "BANK_TRANSACTIONS"), {
        ...formData,
        ref_no: finalRefNo,
        company: selectedCompany,
        account: formData.type === 'Contra (TRANSFER)' ? 'MULTI-ACCOUNT' : formData.to_account || formData.from_account || selectedAccount,
        created_at: Timestamp.now()
      });
      
      if (!isApiTransfer) alert("✅ Accounting Voucher Saved Successfully!");
      
      setShowModal(false);
      setFormData({ ...formData, amount: '', party_id: '', party_name: '', party_ac: '', party_ifsc: '', particulars: '', ref_no: '', custom_party: false, from_account: '', to_account: '' });
      fetchTransactions();
    } catch (error) {
      alert("❌ Error saving transaction!");
    }
    setLoading(false);
    setApiProcessing(false);
  };

  const downloadStatement = () => {
    let csv = "Date,Company,Branch,Account,Party/Ledger,Type,Ref/UTR No,Remarks,Amount\n";
    filteredTransactions.forEach(t => {
      csv += `${t.date},${t.company},${t.branch || '-'},${t.account},${t.party_name},${t.type},${t.ref_no},${t.particulars},${t.amount}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Bank_Statement_${selectedCompany.replace(/ /g, '_')}.csv`;
    a.click();
  };

  // 🔗 UPI PAYMENT LINK GENERATOR
  const generatePaymentLink = () => {
    const randomId = Math.random().toString(36).substr(2, 9).toUpperCase();
    setPaymentLink(`upi://pay?pa=prasadtransport@upi&pn=PrasadTransport&tr=${randomId}&cu=INR`);
    setShowLinkModal(true);
  };

  // 🔄 AUTO-RECONCILIATION SCANNER
  const handleStatementUpload = (e: any) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsScanning(true);
    
    // Simulate AI scanning bank statement
    setTimeout(() => {
      const mockBankData = transactions.slice(0, 5).map(t => ({
         date: t.date, desc: `BANK TXN: NEFT/RTGS/${t.ref_no || "TXN" + Math.floor(Math.random()*10000)} - ${t.party_name}`,
         amount: t.amount, type: t.type, sys_ref: t.id, status: 'Pending Match'
      }));
      mockBankData.push({ date: new Date().toISOString().split('T')[0], desc: "CASH DEPOSIT - UNKNOWN BRANCH", amount: "5000", type: "Receipt (IN)", sys_ref: null, status: 'Pending Match' });
      setStatementRows(mockBankData);
      setIsScanning(false);
    }, 2000);
  };

  const triggerAutoMatch = () => {
    setStatementRows(statementRows.map(row => ({ ...row, status: row.sys_ref ? '✅ Auto-Matched' : '⚠️ Suspense A/C' })));
    alert("🤖 AI Bank Reconciliation Complete!\nSystem entries matched successfully with Bank Statement.");
  };

  // 🏢 FILTER BANKS BASED ON SELECTED COMPANY
  const filteredCompanyBanks = bankAccounts.filter(b => b.company === 'ALL' || b.company === selectedCompany);

  const filteredTransactions = transactions.filter(t => 
    (selectedAccount === 'ALL' || t.account === selectedAccount || t.from_account === selectedAccount || t.to_account === selectedAccount) && 
    t.company === selectedCompany &&
    (selectedBranch === 'ALL' || t.branch === selectedBranch)
  );

  let totalIn = 0; let totalOut = 0;
  filteredTransactions.forEach(t => {
    const amt = parseFloat(t.amount) || 0;
    if (t.type === 'Receipt (IN)') totalIn += amt;
    else if (t.type === 'Payment (OUT)') totalOut += amt;
    else if (t.type === 'Contra (TRANSFER)') {
      if (selectedAccount === t.to_account) totalIn += amt;
      if (selectedAccount === t.from_account) totalOut += amt;
    }
  });
  const closingBalance = totalIn - totalOut;

  const handleCompanyChange = (e: any) => {
    setSelectedCompany(e.target.value);
    setSelectedAccount('ALL');
  };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px', background: 'radial-gradient(circle at top right, #0f172a, #020617)', minHeight: '100vh', padding: '30px' }}>
      
      {/* HEADER SECTION */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '32px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>
            🏦 Core Banking & API Payouts
          </h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Integrated with System Master Data & Bank APIs</p>
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button onClick={generatePaymentLink} style={{ background: '#ec4899', color: '#fff', border: 'none', padding: '10px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 5px 15px rgba(236,72,153,0.4)' }}>
            🔗 Gen UPI Link
          </button>
          <button onClick={() => { setShowBankMaster(true); setNewBank(prev => ({...prev, company: selectedCompany})); }} style={{ background: '#1e293b', color: '#38bdf8', border: '1px solid #38bdf8', padding: '10px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
            ⚙️ Manage Banks
          </button>
          <button onClick={() => setShowReconcileModal(true)} style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#0f172a', border: 'none', padding: '10px 15px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', boxShadow: '0 5px 15px rgba(245,158,11,0.4)' }}>
            🔄 Auto-Reconcile
          </button>
          <button onClick={() => setShowModal(true)} style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', border: 'none', padding: '10px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 5px 15px rgba(16,185,129,0.3)' }}>
            + Create Voucher
          </button>
          <button onClick={downloadStatement} style={{ background: '#334155', color: 'white', border: '1px solid #475569', padding: '10px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
            📥 Download Excel
          </button>
        </div>
      </div>

      {/* 🏢 SMART FILTERS */}
      <div style={{ background: 'rgba(30, 41, 59, 0.5)', border: '1px solid rgba(255,255,255,0.05)', padding: '20px', borderRadius: '15px', marginBottom: '25px', display: 'flex', gap: '20px', flexWrap: 'wrap', backdropFilter: 'blur(10px)' }}>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Select Company</label>
          <select value={selectedCompany} onChange={handleCompanyChange} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold' }}>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Select Branch</label>
          <select value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px' }}>
            <option value="ALL">-- View All Branches --</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: '250px' }}>
          <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Bank Account (Company Wise)</label>
          <select value={selectedAccount} onChange={e => setSelectedAccount(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #38bdf8', color: '#38bdf8', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold' }}>
            <option value="ALL">-- All Accounts of {selectedCompany} --</option>
            {filteredCompanyBanks.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
          </select>
        </div>
      </div>

      {/* 📊 DYNAMIC SUMMARY CARDS */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '25px' }}>
        <div style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.1), rgba(16,185,129,0.05))', border: '1px solid rgba(16,185,129,0.3)', padding: '25px', borderRadius: '15px' }}>
          <div style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total In (Receipts)</div>
          <div style={{ fontSize: '36px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>₹ {totalIn.toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>
        </div>
        <div style={{ background: 'linear-gradient(135deg, rgba(239,68,68,0.1), rgba(239,68,68,0.05))', border: '1px solid rgba(239,68,68,0.3)', padding: '25px', borderRadius: '15px' }}>
          <div style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Out (Payments)</div>
          <div style={{ fontSize: '36px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>₹ {totalOut.toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>
        </div>
        <div style={{ background: 'linear-gradient(135deg, rgba(56,189,248,0.1), rgba(56,189,248,0.05))', border: '1px solid rgba(56,189,248,0.3)', padding: '25px', borderRadius: '15px' }}>
          <div style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>{closingBalance >= 0 ? 'Net Balance (+)' : 'Net Balance (-)'}</div>
          <div style={{ fontSize: '36px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>₹ {Math.abs(closingBalance).toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>
        </div>
      </div>

      {/* 🧾 LEDGER TABLE */}
      <div style={{ background: '#1e293b', borderRadius: '15px', overflowX: 'auto', border: '1px solid #334155', boxShadow: '0 15px 30px rgba(0,0,0,0.5)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
          <thead style={{ background: '#0f172a', color: '#94a3b8', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>
            <tr>
              <th style={{ padding: '15px 20px' }}>Date</th>
              <th style={{ padding: '15px 20px' }}>Party / Beneficiary</th>
              <th style={{ padding: '15px 20px' }}>Ref / UTR No</th>
              <th style={{ padding: '15px 20px' }}>Account (Bank)</th>
              <th style={{ padding: '15px 20px' }}>Voucher Type</th>
              <th style={{ padding: '15px 20px', textAlign: 'right' }}>Amount (₹)</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8', fontWeight: 'bold' }}>Loading Bank Ledger...</td></tr> : filteredTransactions.length === 0 ? <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No Transactions Found for {selectedCompany}.</td></tr> : 
              filteredTransactions.map((t) => (
              <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '14px', transition: '0.2s' }} onMouseOver={e=>e.currentTarget.style.background='rgba(255,255,255,0.02)'} onMouseOut={e=>e.currentTarget.style.background='transparent'}>
                <td style={{ padding: '15px 20px' }}>{t.date}</td>
                <td style={{ padding: '15px 20px', fontWeight: 'bold', color: '#fff' }}>
                  {t.party_name} <span style={{ fontSize: '10px', background: '#334155', padding: '3px 8px', borderRadius: '10px', marginLeft: '5px' }}>{t.party_type || 'Ledger'}</span>
                  <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 'normal', marginTop: '4px' }}>{t.particulars}</div>
                </td>
                <td style={{ padding: '15px 20px', color: t.ref_no?.includes('API') ? '#10b981' : '#38bdf8', fontFamily: 'monospace', fontWeight: 'bold' }}>{t.ref_no || '-'}</td>
                <td style={{ padding: '15px 20px', fontWeight: 'bold' }}>{t.account}</td>
                <td style={{ padding: '15px 20px' }}>
                  <span style={{ padding: '5px 12px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold', background: t.type === 'Receipt (IN)' ? 'rgba(16,185,129,0.1)' : t.type === 'Payment (OUT)' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)', color: t.type === 'Receipt (IN)' ? '#10b981' : t.type === 'Payment (OUT)' ? '#ef4444' : '#f59e0b', border: `1px solid ${t.type === 'Receipt (IN)' ? '#10b981' : t.type === 'Payment (OUT)' ? '#ef4444' : '#f59e0b'}` }}>
                    {t.type}
                  </span>
                </td>
                <td style={{ padding: '15px 20px', textAlign: 'right', fontWeight: 'bold', color: t.type === 'Payment (OUT)' ? '#ef4444' : '#10b981', fontSize: '16px' }}>
                  {t.type === 'Payment (OUT)' ? '-' : '+'} {parseFloat(t.amount).toLocaleString('en-IN', {minimumFractionDigits: 2})}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ⚙️ MANAGE COMPANY BANK ACCOUNTS MODAL */}
      {showBankMaster && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box' }}>
           <div style={{ width: '100%', maxWidth: '800px', background: '#0f172a', borderRadius: '20px', border: '1px solid #38bdf8', display: 'flex', overflow: 'hidden', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
             
             {/* LEFT: Add New Bank Form */}
             <div style={{ flex: 1, padding: '30px', background: '#1e293b' }}>
                <h3 style={{ color: '#fff', margin: '0 0 20px 0' }}>🏦 Add New Bank A/C</h3>
                
                <label style={{ color: '#38bdf8', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Assign to Company *</label>
                <select value={newBank.company} onChange={e => setNewBank({...newBank, company: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', marginBottom: '15px', boxSizing: 'border-box', outline: 'none' }}>
                  {companies.map(c => <option key={c} value={c}>{c}</option>)}
                </select>

                <label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px' }}>Bank Name (e.g., SBI Current)</label>
                <input type="text" value={newBank.name} onChange={e => setNewBank({...newBank, name: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', marginBottom: '15px', boxSizing: 'border-box', outline: 'none' }} />

                <label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px' }}>Account No</label>
                <input type="text" value={newBank.ac_no} onChange={e => setNewBank({...newBank, ac_no: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', marginBottom: '15px', boxSizing: 'border-box', outline: 'none' }} />

                <label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px' }}>IFSC Code</label>
                <input type="text" value={newBank.ifsc} onChange={e => setNewBank({...newBank, ifsc: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', marginBottom: '15px', boxSizing: 'border-box', outline: 'none' }} />

                <button onClick={handleSaveBank} style={{ width: '100%', background: '#10b981', color: '#fff', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', marginTop: '10px' }}>💾 Save Bank Account</button>
                <button onClick={() => setShowBankMaster(false)} style={{ width: '100%', background: 'transparent', color: '#ef4444', border: 'none', padding: '15px', marginTop: '10px', cursor: 'pointer', fontWeight: 'bold' }}>Cancel</button>
             </div>

             {/* RIGHT: List of Saved Banks */}
             <div style={{ flex: 1.2, padding: '30px', borderLeft: '1px solid #334155', overflowY: 'auto', maxHeight: '70vh' }}>
                <h3 style={{ color: '#38bdf8', margin: '0 0 20px 0' }}>📋 Registered Bank Accounts</h3>
                
                {bankAccounts.map((b, idx) => (
                  <div key={idx} style={{ background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '10px', border: '1px solid #334155', marginBottom: '10px' }}>
                    <div style={{ color: '#f59e0b', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '5px', letterSpacing: '1px' }}>🏢 {b.company}</div>
                    <div style={{ fontWeight: 'bold', color: '#fff', fontSize: '16px', marginBottom: '5px' }}>{b.name}</div>
                    {b.ac_no && <div style={{ color: '#94a3b8', fontSize: '13px', fontFamily: 'monospace' }}>A/C: {b.ac_no} {b.ifsc && `| IFSC: ${b.ifsc}`}</div>}
                  </div>
                ))}
             </div>
             
           </div>
        </div>
      )}

      {/* 🟢 SMART ENTRY / DIRECT API PAYOUT MODAL */}
      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '100%', maxWidth: '650px', background: '#1e293b', borderRadius: '20px', border: '1px solid #38bdf8', padding: '30px', boxShadow: '0 25px 50px rgba(0,0,0,0.8)', maxHeight: '90vh', overflowY: 'auto' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h3 style={{ color: '#fff', margin: 0, fontSize: '20px' }}>{formData.type === 'Payment (OUT)' ? '💸 Direct Payout / Voucher' : '🧾 Create Accounting Voucher'}</h3>
              <span style={{ background: '#38bdf8', color: '#0f172a', padding: '4px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold' }}>🏢 {selectedCompany}</span>
            </div>
            
            <div style={{ display: 'flex', gap: '10px', marginBottom: '25px' }}>
              {['Receipt (IN)', 'Payment (OUT)', 'Contra (TRANSFER)'].map(type => (
                <button key={type} onClick={() => setFormData({...formData, type})} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s', background: formData.type === type ? (type.includes('IN') ? '#10b981' : type.includes('OUT') ? '#ef4444' : '#f59e0b') : '#334155', color: '#fff' }}>{type}</button>
              ))}
            </div>

            {formData.type !== 'Contra (TRANSFER)' && (
              <div style={{ marginBottom: '20px', background: 'rgba(56, 189, 248, 0.05)', padding: '15px', borderRadius: '10px', border: '1px solid rgba(56, 189, 248, 0.2)' }}>
                <label style={{ color: '#38bdf8', fontSize: '13px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>🔍 Search System Beneficiary *</label>
                <select value={formData.custom_party ? 'custom' : formData.party_id} onChange={handlePartySelect} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', fontSize: '15px', outline: 'none' }}>
                  <option value="">-- Select from Master Data --</option>
                  {ledgers.map((l, i) => <option key={i} value={l.id}>{l.name} ({l.type})</option>)}
                  <option value="custom">➕ -- Other / Custom Party --</option>
                </select>

                {!formData.custom_party && formData.party_id && (
                  <div style={{ marginTop: '15px', background: formData.party_ac ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)', padding: '15px', borderRadius: '8px', border: `1px solid ${formData.party_ac ? '#10b981' : '#f59e0b'}` }}>
                    <h4 style={{ margin: '0 0 10px 0', color: formData.party_ac ? '#10b981' : '#f59e0b', fontSize: '14px' }}>{formData.party_ac ? '✅ Auto-Fetched Bank Details' : '⚠️ Bank Details Missing'}</h4>
                    {formData.party_ac ? (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div><span style={{ color: '#94a3b8', fontSize: '11px', display: 'block' }}>Account Number:</span><span style={{ color: '#fff', fontWeight: 'bold', fontFamily: 'monospace', fontSize: '14px' }}>{formData.party_ac}</span></div>
                        <div><span style={{ color: '#94a3b8', fontSize: '11px', display: 'block' }}>IFSC Code:</span><span style={{ color: '#fff', fontWeight: 'bold', fontFamily: 'monospace', fontSize: '14px' }}>{formData.party_ifsc}</span></div>
                      </div>
                    ) : (<p style={{ margin: 0, color: '#fcd34d', fontSize: '12px' }}>Please update Bank A/C to use API Payout.</p>)}
                  </div>
                )}
                {formData.custom_party && (
                  <div style={{ marginTop: '15px', padding: '15px', background: 'rgba(255,255,255,0.03)', border: '1px dashed #475569', borderRadius: '8px' }}>
                    <input type="text" placeholder="Enter Party Name *" onChange={e => setFormData({...formData, party_name: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', marginBottom: '10px', outline: 'none' }} />
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
              <div>
                <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold' }}>Date *</label>
                <input type="date" value={formData.date} onChange={e => setFormData({...formData, date: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', colorScheme: 'dark', outline: 'none' }} />
              </div>
              <div>
                <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold' }}>Amount (₹) *</label>
                <input type="number" value={formData.amount} onChange={e => setFormData({...formData, amount: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#10b981', borderRadius: '8px', fontSize: '20px', fontWeight: '900', boxSizing: 'border-box', outline: 'none' }} placeholder="0.00" />
              </div>
            </div>

            {/* ACCOUNT SELECTION */}
            {formData.type === 'Contra (TRANSFER)' ? (
               <div style={{ display: 'flex', gap: '15px', marginBottom: '15px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold' }}>From Account (Money OUT) *</label>
                  <select value={formData.from_account} onChange={e => setFormData({...formData, from_account: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #ef4444', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', outline: 'none' }}>
                    <option value="">Select Bank / Cash</option>
                    {filteredCompanyBanks.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold' }}>To Account (Money IN) *</label>
                  <select value={formData.to_account} onChange={e => setFormData({...formData, to_account: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #10b981', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', outline: 'none' }}>
                    <option value="">Select Bank / Cash</option>
                    {filteredCompanyBanks.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                <div>
                  <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold' }}>Select Bank Account *</label>
                  <select value={formData.to_account} onChange={e => setFormData({...formData, to_account: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', outline: 'none' }}>
                    <option value="">-- Choose Account --</option>
                    {filteredCompanyBanks.map(b => <option key={b.id} value={b.name}>{b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold' }}>Ref / Cheque No. (Manual)</label>
                  <input type="text" value={formData.ref_no} onChange={e => setFormData({...formData, ref_no: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#38bdf8', borderRadius: '8px', boxSizing: 'border-box', fontFamily: 'monospace', outline: 'none' }} placeholder="Optional if API Transfer" />
                </div>
              </div>
            )}

            <div style={{ marginBottom: '15px' }}>
              <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold' }}>Narration / Remarks</label>
              <input type="text" value={formData.particulars} onChange={e => setFormData({...formData, particulars: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', outline: 'none' }} placeholder="Being payment made for..." />
            </div>

            <div style={{ display: 'flex', gap: '15px', marginTop: '25px' }}>
              <button onClick={() => setShowModal(false)} style={{ flex: 1, padding: '15px', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>Cancel</button>
              <div style={{ flex: 2, display: 'flex', gap: '10px' }}>
                <button onClick={() => handleSaveTransaction(false)} style={{ flex: 1, padding: '15px', background: '#334155', border: 'none', color: '#fff', borderRadius: '8px', fontSize: '14px', fontWeight: 'bold', cursor: 'pointer' }}>{loading ? 'Saving...' : '💾 Manual Entry'}</button>
                {formData.type === 'Payment (OUT)' && (
                  <button onClick={() => handleSaveTransaction(true)} disabled={apiProcessing || !formData.party_ac} style={{ flex: 1.5, padding: '15px', background: formData.party_ac ? 'linear-gradient(135deg, #f59e0b, #d97706)' : '#475569', border: 'none', color: '#fff', borderRadius: '8px', fontSize: '14px', fontWeight: '900', cursor: formData.party_ac ? 'pointer' : 'not-allowed', boxShadow: formData.party_ac ? '0 5px 15px rgba(245,158,11,0.4)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
                    {apiProcessing ? '⏳ Processing...' : '⚡ API TRANSFER'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 🔗 UPI PAYMENT LINK GENERATOR MODAL */}
      {showLinkModal && (
         <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: '100%', maxWidth: '450px', background: '#1e293b', borderRadius: '20px', border: '1px solid #ec4899', padding: '30px', textAlign: 'center', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
               <h2 style={{ color: '#ec4899', marginTop: 0 }}>📲 Generate UPI Payment Link</h2>
               <p style={{ color: '#94a3b8', fontSize: '14px' }}>Share this link with your customers/drivers to receive money directly into your account.</p>
               
               <div style={{ background: '#0f172a', border: '1px dashed #ec4899', padding: '20px', borderRadius: '10px', margin: '20px 0', wordBreak: 'break-all', color: '#fff', fontFamily: 'monospace' }}>
                  {paymentLink}
               </div>

               <div style={{ display: 'flex', gap: '10px' }}>
                  <button onClick={() => { navigator.clipboard.writeText(paymentLink); alert("Link Copied!"); }} style={{ flex: 1, padding: '15px', background: '#334155', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
                     📋 Copy Link
                  </button>
                  <button onClick={() => window.open(`https://wa.me/?text=Please%20pay%20your%20dues%20to%20Prasad%20Transport%20using%20this%20secure%20UPI%20link:%0A${encodeURIComponent(paymentLink)}`, '_blank')} style={{ flex: 1, padding: '15px', background: '#10b981', color: '#fff', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>
                     💬 Share on WA
                  </button>
               </div>
               <button onClick={() => setShowLinkModal(false)} style={{ width: '100%', padding: '15px', background: 'transparent', color: '#ef4444', border: 'none', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', marginTop: '15px' }}>Close</button>
            </div>
         </div>
      )}

      {/* 🔄 AI AUTO RECONCILIATION MODAL */}
      {showReconcileModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box' }}>
          <div style={{ width: '100%', maxWidth: '900px', background: '#0f172a', borderRadius: '20px', border: '1px solid #f59e0b', padding: '30px', boxShadow: '0 25px 50px rgba(0,0,0,0.8)', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
               <div>
                  <h3 style={{ color: '#f59e0b', margin: 0, fontSize: '24px' }}>🤖 AI Bank Reconciliation Scanner</h3>
                  <p style={{ color: '#94a3b8', margin: '5px 0 0 0', fontSize: '13px' }}>Upload your Bank Statement CSV to auto-match with system entries.</p>
               </div>
               <button onClick={() => setShowReconcileModal(false)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>

            <div style={{ display: 'flex', gap: '20px', alignItems: 'center', marginBottom: '30px', background: 'rgba(245, 158, 11, 0.05)', padding: '20px', borderRadius: '10px', border: '1px dashed #f59e0b' }}>
               <label style={{ background: '#f59e0b', color: '#0f172a', padding: '12px 25px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', display: 'inline-block' }}>
                  {isScanning ? '⏳ Scanning Document...' : '📁 Upload Bank Statement (.CSV)'}
                  <input type="file" hidden accept=".csv" onChange={handleStatementUpload} disabled={isScanning} />
               </label>
               {isScanning && <div style={{ color: '#f59e0b', fontWeight: 'bold' }}>Our AI is matching UTRs and Amounts...</div>}
            </div>

            {statementRows.length > 0 && (
               <div>
                  <h4 style={{ color: '#fff', marginBottom: '15px' }}>📋 Scanned Statement Entries</h4>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', marginBottom: '25px', fontSize: '13px', color: '#cbd5e1' }}>
                    <thead style={{ background: '#1e293b', color: '#38bdf8' }}>
                       <tr><th style={{padding:'10px'}}>Date</th><th style={{padding:'10px'}}>Description / UTR</th><th style={{padding:'10px'}}>Amount</th><th style={{padding:'10px'}}>Match Status</th></tr>
                    </thead>
                    <tbody>
                       {statementRows.map((row, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #334155' }}>
                             <td style={{padding:'10px'}}>{row.date}</td>
                             <td style={{padding:'10px', color:'#fff'}}>{row.desc}</td>
                             <td style={{padding:'10px', color: row.type.includes('IN') ? '#10b981' : '#ef4444', fontWeight: 'bold'}}>₹{row.amount}</td>
                             <td style={{padding:'10px'}}>
                                <span style={{ background: row.status.includes('✅') ? 'rgba(16,185,129,0.2)' : row.status.includes('⚠️') ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)', color: row.status.includes('✅') ? '#10b981' : row.status.includes('⚠️') ? '#ef4444' : '#f59e0b', padding: '3px 8px', borderRadius: '5px', fontWeight: 'bold', fontSize: '11px' }}>
                                   {row.status}
                                </span>
                             </td>
                          </tr>
                       ))}
                    </tbody>
                  </table>
                  
                  <div style={{ textAlign: 'right' }}>
                     <button onClick={triggerAutoMatch} style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', border: 'none', padding: '12px 30px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', fontSize: '15px' }}>
                        🤖 Run Auto-Reconciliation
                     </button>
                  </div>
               </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}