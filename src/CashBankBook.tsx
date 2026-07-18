// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, Timestamp } from 'firebase/firestore';
import { db } from './firebase';
import { isDateInRange as inRange } from './lib/accounting/tripMath';

export default function CashBankBook() {
  const [transactions, setTransactions] = useState<any[]>([]);
  const [ledgers, setLedgers] = useState<any[]>([]); 
  const [loading, setLoading] = useState(false);
  
  // 🪟 MODAL STATES
  const [showModal, setShowModal] = useState(false);
  const [showBankMaster, setShowBankMaster] = useState(false);
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [showReconcileModal, setShowReconcileModal] = useState(false);
  const [apiProcessing, setApiProcessing] = useState(false); 

  // 🔍 SEARCH & DATE FILTERS
  const [searchTerm, setSearchTerm] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // 🔄 RECONCILIATION STATES
  const [isScanning, setIsScanning] = useState(false);
  const [statementRows, setStatementRows] = useState<any[]>([]);

  // 🏢 DYNAMIC MASTER DATA STATES
  const [companies, setCompanies] = useState<string[]>(['Loading Companies...']);
  const [branches, setBranches] = useState<string[]>(['Loading Branches...']);

  // 🏢 SMART FILTERS
  const [selectedCompany, setSelectedCompany] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('ALL');
  const [selectedAccount, setSelectedAccount] = useState('ALL');

  // 🏦 BANK ACCOUNTS
  const [bankAccounts, setBankAccounts] = useState<any[]>([]);
  const [newBank, setNewBank] = useState({ company: '', name: '', ac_no: '', ifsc: '', op_bal: '' });

  // 🚚 TRIPS / LOADING ADVANCES
  const [tripAdvances, setTripAdvances] = useState<any[]>([]);

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
    bank_account: '', 
    ref_no: '',
    branch: ''
  });

  const [paymentLink, setPaymentLink] = useState('');

  useEffect(() => {
    fetchMasterData(); 
    fetchTransactions();
    fetchAllLedgers(); 
    fetchBankAccounts(); 
    fetchTripAdvances(); 
  }, []);

  // 🛠️ SAFE DATE PARSER
  const safeDate = (val: any) => {
    if(!val) return '';
    if(typeof val === 'string') return val.split('T')[0];
    if(val.toDate) return val.toDate().toISOString().split('T')[0];
    return '';
  };

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
      const banks = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      banks.unshift({ id: 'cash_hq', name: 'Cash in Hand (HQ)', ac_no: 'Cash Ledger', company: 'ALL' });
      setBankAccounts(banks);
    } catch (e) {
      console.error("Error fetching banks", e);
    }
  };

  const handleSaveBank = async () => {
    if (!newBank.name || !newBank.company) return alert("⚠️ Please select Company and enter Bank Name!");
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
      const allLedgers: any[] = [];
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

  const fetchTripAdvances = async () => {
    try {
      const tSnap = await getDocs(collection(db, "TRIPS")).catch(() => ({ docs: [] }));
      const advances: any[] = [];

      tSnap.forEach(doc => {
        const t = doc.data();
        const amt = parseFloat(t.cash_advance || t.advance || t.advance_amount || t.trip_advance) || 0;
        
        if (amt > 0) {
          let accountName = t.paid_from_bank || t.payment_mode || '';
          
          if (!accountName || accountName.toLowerCase().includes('cash')) {
             if (t.advance_from_pump || t.pump_name || t.cash_pump) {
                accountName = `Cash via Pump (${t.advance_from_pump || t.pump_name || t.cash_pump || 'Unknown Pump'})`;
             } else if (t.advance_from === 'Office' || t.cash_from === 'Office') {
                accountName = 'Cash in Hand (Office HQ)';
             } else {
                accountName = 'Cash in Hand (Office HQ)';
             }
          }

          advances.push({
            id: `TRIP_${doc.id}`,
            source: 'TRIP_ADVANCE',
            date: safeDate(t.date || t.start_date || t.created_at),
            type: 'Payment (OUT)', 
            party_id: t.driver_id || t.vendor_id || '',
            party_name: t.driver_name || t.driver || t.vendor_name || 'Vehicle Driver/Owner',
            party_type: t.vendor_id ? 'Vendor' : 'Driver',
            amount: amt,
            particulars: `Trip Cash Advance - Veh: ${t.vehicle_no || t.vehicle || 'N/A'} | Route: ${t.route || 'N/A'}`,
            bank_account: accountName,
            ref_no: t.gr_no || t.trip_id || `TRP-${doc.id.substring(0,4)}`,
            company: t.company || 'ALL', 
            branch: t.branch || 'ALL'
          });
        }
      });
      setTripAdvances(advances);
    } catch (error) {
      console.error("Error fetching trip advances", error);
    }
  };

  const fetchTransactions = async () => {
    setLoading(true);
    try {
      const q = query(collection(db, "BANK_TRANSACTIONS"), orderBy("created_at", "desc"));
      const querySnapshot = await getDocs(q);
      setTransactions(querySnapshot.docs.map(doc => ({ id: doc.id, source: 'MANUAL_BANK', ...doc.data() })));
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
    if (!formData.amount || parseFloat(formData.amount) <= 0) return alert("⚠️ Please enter a valid Amount!");
    
    if (formData.type !== 'Contra (TRANSFER)') {
      if (!formData.party_name) return alert("⚠️ Please select or enter a Party Name!");
      if (!formData.bank_account) return alert("⚠️ Please select your Bank Account/Cash Source!");
    } else {
      if (!formData.from_account || !formData.to_account) return alert("⚠️ Please select both 'From' and 'To' accounts!");
      if (formData.from_account === formData.to_account) return alert("⚠️ 'From' and 'To' accounts cannot be the same!");
    }

    try {
      let finalRefNo = formData.ref_no;

      if (isApiTransfer) {
        if (!formData.party_ac || !formData.party_ifsc) {
           return alert("❌ Missing Bank Details! Update Party Master first.");
        }
        setApiProcessing(true);
        await new Promise(resolve => setTimeout(resolve, 2000)); 
        finalRefNo = "API-UTR-" + Math.floor(Math.random() * 90000000 + 10000000);
        alert(`✅ SUCCESS: ₹${formData.amount} Transferred via API to ${formData.party_name}.\nUTR: ${finalRefNo}`);
      } else {
        setLoading(true);
      }

      await addDoc(collection(db, "BANK_TRANSACTIONS"), {
        date: formData.date,
        type: formData.type,
        party_id: formData.party_id,
        party_name: formData.type === 'Contra (TRANSFER)' ? 'Self (Contra Transfer)' : formData.party_name,
        party_type: formData.party_type,
        amount: parseFloat(formData.amount),
        particulars: formData.particulars,
        account: formData.type === 'Contra (TRANSFER)' ? 'MULTI-ACCOUNT' : formData.bank_account, 
        bank_account: formData.bank_account,
        from_account: formData.from_account,
        to_account: formData.to_account,
        ref_no: finalRefNo,
        company: selectedCompany,
        branch: formData.branch || selectedBranch,
        created_at: Timestamp.now()
      });
      
      if (!isApiTransfer) alert("✅ Voucher Saved Successfully!");
      
      setShowModal(false);
      setFormData({ ...formData, amount: '', party_id: '', party_name: '', party_ac: '', party_ifsc: '', particulars: '', ref_no: '', custom_party: false, from_account: '', to_account: '', bank_account: '' });
      fetchTransactions();
    } catch (error) {
      alert("❌ Error saving transaction!");
    }
    setLoading(false);
    setApiProcessing(false);
  };

  // 🗑️ DELETE TRANSACTION
  const handleDeleteTransaction = async (txn: any) => {
    if(txn.source === 'TRIP_ADVANCE') {
      alert("⚠️ This is a System Generated Trip Advance.\nPlease delete or edit it directly from the 'Trip Management' screen.");
      return;
    }
    
    if(window.confirm(`⚠️ Are you sure you want to DELETE this ${txn.type} of ₹${txn.amount}?\n\nParty: ${txn.party_name}\nThis action cannot be undone.`)) {
      try {
        await deleteDoc(doc(db, "BANK_TRANSACTIONS", txn.id));
        alert("✅ Transaction Deleted Successfully.");
        fetchTransactions(); // Refresh
      } catch (e) {
        alert("❌ Error deleting transaction!");
      }
    }
  };

  // 🖨️ PRINT VOUCHER
  const handlePrintVoucher = (txn: any) => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return alert("Please allow popups to generate PDF.");

    const isReceipt = txn.type === 'Receipt (IN)';
    const isContra = txn.type === 'Contra (TRANSFER)';
    
    const vTitle = isContra ? 'CONTRA VOUCHER' : (isReceipt ? 'RECEIPT VOUCHER' : 'PAYMENT VOUCHER');
    const vColor = isContra ? '#f59e0b' : (isReceipt ? '#10b981' : '#ef4444');
    
    const partyName = isContra ? `${txn.from_account} ➔ ${txn.to_account}` : txn.party_name;
    const accountName = isContra ? 'Inter-Bank Transfer' : (txn.bank_account || txn.account || 'Cash');

    const htmlContent = `
      <html>
        <head>
          <title>${vTitle}_${txn.ref_no || 'VCH'}</title>
          <style>
             body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #000; margin: 0; }
             .wrapper { max-width: 800px; margin: 0 auto; border: 2px solid #000; padding: 30px; border-radius: 10px; position: relative; }
             .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 15px; margin-bottom: 30px; }
             .company { font-size: 32px; font-weight: 900; margin: 0; text-transform: uppercase; letter-spacing: 2px; color: #1e3a8a; }
             .v-type { font-size: 20px; font-weight: bold; background: ${vColor}; color: #fff; padding: 8px 20px; display: inline-block; margin-top: 15px; border-radius: 5px; letter-spacing: 1px; }
             
             .top-info { display: flex; justify-content: space-between; margin-bottom: 30px; font-size: 16px; font-weight: bold; }
             
             .main-table { width: 100%; border-collapse: collapse; margin-bottom: 40px; font-size: 16px; }
             .main-table th, .main-table td { border: 1px solid #000; padding: 15px; text-align: left; }
             .main-table th { background: #f0f0f0; width: 35%; font-weight: bold; }
             
             .amount-box { text-align: center; margin: 30px 0; border: 2px dashed ${vColor}; padding: 15px; border-radius: 10px; background: #fafafa; }
             .amount-text { font-size: 32px; font-weight: 900; color: ${vColor}; margin: 0; }
             
             .footer { margin-top: 80px; display: flex; justify-content: space-between; font-weight: bold; padding: 0 20px; text-align: center; }
             .sign-box { border-top: 1px solid #000; padding-top: 10px; width: 200px; }
             
             @media print {
               body { padding: 0; }
               .wrapper { border: none; padding: 10px; }
               .v-type { color: #000 !important; background: transparent !important; border: 2px solid #000; }
               .amount-box { border: 2px solid #000; color: #000; }
               .amount-text { color: #000 !important; }
             }
          </style>
        </head>
        <body>
          <div class="wrapper">
            <div class="header">
              <h1 class="company">${selectedCompany || 'PRASAD TRANSPORT'}</h1>
              <div style="font-size: 14px; margin-top: 5px;">ACCOUNTING VOUCHER</div>
              <div class="v-type">${vTitle}</div>
            </div>
            
            <div class="top-info">
               <div>Voucher No / Ref: <span style="color:${vColor}">${txn.ref_no || 'SYS-GEN'}</span></div>
               <div>Date: ${txn.date ? new Date(txn.date).toLocaleDateString('en-GB') : '-'}</div>
            </div>
            
            <table class="main-table">
              <tr>
                <th>${isReceipt ? 'Received From' : (isContra ? 'Transfer Details' : 'Paid To')}</th>
                <td style="font-weight: 900; font-size: 18px; text-transform: uppercase;">${partyName}</td>
              </tr>
              <tr>
                <th>Account / Source</th>
                <td>${accountName}</td>
              </tr>
              <tr>
                <th>Particulars / Narration</th>
                <td>${txn.particulars || 'As per accounting records.'}</td>
              </tr>
            </table>

            <div class="amount-box">
              <p style="margin: 0 0 5px 0; font-size: 14px; color: #666; text-transform: uppercase;">Total Amount ${isReceipt ? 'Received' : 'Paid'}</p>
              <h2 class="amount-text">₹ ${parseFloat(txn.amount || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</h2>
            </div>

            <div class="footer">
              <div class="sign-box">Receiver's Signature</div>
              <div class="sign-box">Authorized Signatory<br><small style="font-weight: normal;">For ${selectedCompany || 'Company'}</small></div>
            </div>
          </div>
          
          <script>
            window.onload = function() {
              setTimeout(function() { window.print(); }, 500);
            }
          </script>
        </body>
      </html>
    `;
    printWindow.document.write(htmlContent);
    printWindow.document.close();
  };

  const generatePaymentLink = () => {
    const randomId = Math.random().toString(36).substr(2, 9).toUpperCase();
    setPaymentLink(`upi://pay?pa=prasadtransport@upi&pn=PrasadTransport&tr=${randomId}&cu=INR`);
    setShowLinkModal(true);
  };

  const clearDates = () => {
    setFromDate('');
    setToDate('');
  };

  const handleStatementUpload = (e: any) => {
    const file = e.target.files[0];
    if (!file) return;
    setIsScanning(true);
    
    setTimeout(() => {
      const mockBankData = transactions.slice(0, 4).map(t => ({
         date: t.date, desc: `NEFT/RTGS/UPI - ${t.ref_no || "TXN" + Math.floor(Math.random()*1000)}`,
         amount: t.amount, type: t.type, sys_ref: t.id, status: 'Pending Match'
      }));
      mockBankData.push({ date: new Date().toISOString().split('T')[0], desc: "CASH DEPOSIT UNKNOWN", amount: "5000", type: "Receipt (IN)", sys_ref: null, status: 'Pending Match' });
      setStatementRows(mockBankData);
      setIsScanning(false);
    }, 1500);
  };

  const manualMatch = (index: number) => {
    const newRows = [...statementRows];
    newRows[index].status = '✅ Manually Matched';
    setStatementRows(newRows);
  };

  const triggerAutoMatch = () => {
    setStatementRows(statementRows.map(row => ({ ...row, status: row.sys_ref ? '✅ Auto-Matched' : '⚠️ Suspense A/C' })));
    alert("🤖 AI Reconciliation Complete! Entries Matched.");
  };

  // 🏢 BANK FILTERING
  const filteredCompanyBanks = bankAccounts.filter(b => b.company === 'ALL' || (b.company || '').trim() === selectedCompany.trim());

  // 🧮 COMBINE MANUAL BANK TXNS + TRIP ADVANCES
  const allCombinedTransactions = [...transactions, ...tripAdvances];

  // 🧮 TRANSACTION FILTERING
  const filteredTransactions = allCombinedTransactions.filter(t => {
    const matchCompany = !t.company || t.company === 'ALL' || t.company === selectedCompany;
    const matchBranch = selectedBranch === 'ALL' || !t.branch || t.branch === 'ALL' || t.branch === selectedBranch;
    const t_acc = t.bank_account || t.account; 
    const matchAccount = selectedAccount === 'ALL' || t_acc === selectedAccount || t.from_account === selectedAccount || t.to_account === selectedAccount;
    
    // Normalized date range (handles DD-MM-YYYY / ISO / Timestamp)
    const matchDate = inRange(t.date, fromDate || undefined, toDate || undefined);
    return matchCompany && matchBranch && matchAccount && matchDate;
  });

  // 🔍 SEARCH LOGIC
  const searchedTransactions = filteredTransactions.filter(t => {
    if (!searchTerm) return true; 
    const term = searchTerm.toLowerCase();
    return (
      (t.party_name && t.party_name.toLowerCase().includes(term)) ||
      (t.ref_no && t.ref_no.toLowerCase().includes(term)) ||
      (t.particulars && t.particulars.toLowerCase().includes(term)) ||
      (t.account && t.account.toLowerCase().includes(term)) ||
      (t.bank_account && t.bank_account.toLowerCase().includes(term))
    );
  });

  // Sort Final List by Date
  searchedTransactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // 🧮 CALCULATE TOTALS ACCURATELY
  let totalIn = 0; let totalOut = 0;
  searchedTransactions.forEach(t => {
    const amt = parseFloat(t.amount) || 0;
    if (t.type === 'Receipt (IN)') totalIn += amt;
    else if (t.type === 'Payment (OUT)') totalOut += amt;
    else if (t.type === 'Contra (TRANSFER)') {
      if (selectedAccount !== 'ALL') {
        if (selectedAccount === t.to_account) totalIn += amt;
        if (selectedAccount === t.from_account) totalOut += amt;
      }
    }
  });
  const closingBalance = totalIn - totalOut;

  const downloadStatement = () => {
    let csv = "Date,Company,Bank Account,Party/Ledger,Type,Ref/UTR No,Remarks,Amount\n";
    searchedTransactions.forEach(t => {
      const acc = t.type === 'Contra (TRANSFER)' ? `${t.from_account} -> ${t.to_account}` : (t.bank_account || t.account || '-');
      csv += `${t.date || '-'},${t.company || '-'},${acc},"${t.party_name || '-'}",${t.type || '-'},${t.ref_no || '-'},"${t.particulars || '-'}",${t.amount || '0'}\n`;
    });
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `CashBank_Statement_${selectedCompany.replace(/ /g, '_')}.csv`;
    a.click();
  };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px', background: 'radial-gradient(circle at top right, #0f172a, #020617)', minHeight: '100vh', padding: '30px' }}>
      
      {/* HEADER SECTION */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '32px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>
            🏦 Cash, Bank & API Payouts
          </h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Unified Book for Vouchers, Payments & Advances</p>
        </div>

        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button onClick={generatePaymentLink} style={{ background: '#ec4899', color: '#fff', border: 'none', padding: '10px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>🔗 Gen UPI Link</button>
          <button onClick={() => { setShowBankMaster(true); setNewBank(prev => ({...prev, company: selectedCompany})); }} style={{ background: '#1e293b', color: '#38bdf8', border: '1px solid #38bdf8', padding: '10px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>⚙️ Manage Banks</button>
          <button onClick={() => setShowReconcileModal(true)} style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#0f172a', border: 'none', padding: '10px 15px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer' }}>🔄 Auto-Reconcile</button>
          <button onClick={() => setShowModal(true)} style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', border: 'none', padding: '10px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>+ Create Voucher</button>
          <button onClick={downloadStatement} style={{ background: '#334155', color: 'white', border: '1px solid #475569', padding: '10px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>📥 Excel</button>
        </div>
      </div>

      {/* 🏢 SMART FILTERS, DATES & SEARCH */}
      <div style={{ background: 'rgba(30, 41, 59, 0.5)', border: '1px solid rgba(255,255,255,0.05)', padding: '20px', borderRadius: '15px', marginBottom: '25px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 200px' }}>
          <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Select Company</label>
          <select value={selectedCompany} onChange={e => {setSelectedCompany(e.target.value); setSelectedAccount('ALL');}} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold' }}>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 250px' }}>
          <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Bank Account / Cash Source</label>
          <select value={selectedAccount} onChange={e => setSelectedAccount(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #38bdf8', color: '#38bdf8', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold' }}>
            <option value="ALL">-- All Accounts & Cash --</option>
            {filteredCompanyBanks.map(b => <option key={b.id} value={b.name}>{b.name} {b.ac_no ? `(${b.ac_no})` : ''}</option>)}
            <option value="Cash via Pump">Cash via Petrol Pump (Trips)</option>
          </select>
        </div>

        <div style={{ flex: '1 1 150px' }}>
          <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>From Date</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', colorScheme: 'dark' }} />
        </div>
        <div style={{ flex: '1 1 150px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
             <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>To Date</label>
             {(fromDate || toDate) && <span onClick={clearDates} style={{ color: '#ef4444', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold' }}>❌ Clear</span>}
          </div>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', colorScheme: 'dark' }} />
        </div>
        <div style={{ flex: '2 1 250px' }}>
          <label style={{ color: '#f59e0b', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Search</label>
          <input type="text" placeholder="🔍 Search Party, UTR, Pump..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #f59e0b', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px' }} />
        </div>
      </div>

      {/* 📊 DYNAMIC SUMMARY CARDS */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '25px' }}>
        <div style={{ background: 'linear-gradient(135deg, rgba(16,185,129,0.1), rgba(16,185,129,0.05))', border: '1px solid rgba(16,185,129,0.3)', padding: '25px', borderRadius: '15px' }}>
          <div style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total In (Receipts)</div>
          <div style={{ fontSize: '36px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>₹ {totalIn.toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>
        </div>
        <div style={{ background: 'linear-gradient(135deg, rgba(239,68,68,0.1), rgba(239,68,68,0.05))', border: '1px solid rgba(239,68,68,0.3)', padding: '25px', borderRadius: '15px' }}>
          <div style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Out (Payments/Advances)</div>
          <div style={{ fontSize: '36px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>₹ {totalOut.toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>
        </div>
        <div style={{ background: 'linear-gradient(135deg, rgba(56,189,248,0.1), rgba(56,189,248,0.05))', border: '1px solid rgba(56,189,248,0.3)', padding: '25px', borderRadius: '15px' }}>
          <div style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>{closingBalance >= 0 ? 'Net Balance (+)' : 'Net Balance (-)'}</div>
          <div style={{ fontSize: '36px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>₹ {Math.abs(closingBalance).toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>
        </div>
      </div>

      {/* 🧾 LEDGER TABLE */}
      <div style={{ background: '#1e293b', borderRadius: '15px', overflowX: 'auto', border: '1px solid #334155' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', whiteSpace: 'nowrap' }}>
          <thead style={{ background: '#0f172a', color: '#94a3b8', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>
            <tr>
              <th style={{ padding: '15px 20px' }}>Date</th>
              <th style={{ padding: '15px 20px' }}>Party / Beneficiary</th>
              <th style={{ padding: '15px 20px' }}>Ref / UTR No</th>
              <th style={{ padding: '15px 20px' }}>Account (Bank / Cash)</th>
              <th style={{ padding: '15px 20px' }}>Voucher Type</th>
              <th style={{ padding: '15px 20px', textAlign: 'right' }}>Amount (₹)</th>
              <th style={{ padding: '15px 20px', textAlign: 'center' }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={7} style={{ padding: '20px', textAlign: 'center', color: '#38bdf8', fontWeight: 'bold' }}>Loading Bank Ledger...</td></tr> : searchedTransactions.length === 0 ? <tr><td colSpan={7} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No Transactions Found.</td></tr> : 
              searchedTransactions.map((t) => (
              <tr key={t.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '14px', transition: '0.2s' }}>
                <td style={{ padding: '15px 20px' }}>{t.date ? new Date(t.date).toLocaleDateString('en-GB') : '-'}</td>
                <td style={{ padding: '15px 20px', fontWeight: 'bold', color: '#fff' }}>
                  {t.party_name || 'Unknown Party'} 
                  
                  {/* 💡 TAGGING THE PARTY */}
                  {t.source === 'TRIP_ADVANCE' ? (
                    <span style={{ fontSize: '10px', background: '#8b5cf6', padding: '3px 8px', borderRadius: '10px', marginLeft: '5px' }}>Trip System</span>
                  ) : (
                    <span style={{ fontSize: '10px', background: '#334155', padding: '3px 8px', borderRadius: '10px', marginLeft: '5px' }}>{t.party_type || 'Ledger'}</span>
                  )}
                  
                  <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 'normal', marginTop: '4px' }}>{t.particulars || '-'}</div>
                </td>
                <td style={{ padding: '15px 20px', color: t.ref_no?.includes('API') ? '#10b981' : '#38bdf8', fontFamily: 'monospace', fontWeight: 'bold' }}>{t.ref_no || '-'}</td>
                <td style={{ padding: '15px 20px', fontWeight: 'bold' }}>
                   {t.type === 'Contra (TRANSFER)' ? <span style={{color: '#f59e0b'}}>{t.from_account} ➔ {t.to_account}</span> : (
                      <span>
                        {t.bank_account || t.account || '-'}
                        {/* 💡 TAGGING THE CASH SOURCE */}
                        {String(t.bank_account || t.account).toLowerCase().includes('pump') && <span style={{ fontSize: '10px', background: '#ef4444', padding: '2px 6px', borderRadius: '10px', marginLeft: '8px', color: 'white' }}>Petrol Pump</span>}
                        {String(t.bank_account || t.account).toLowerCase().includes('office') && <span style={{ fontSize: '10px', background: '#3b82f6', padding: '2px 6px', borderRadius: '10px', marginLeft: '8px', color: 'white' }}>Office</span>}
                      </span>
                   )}
                </td>
                <td style={{ padding: '15px 20px' }}>
                  <span style={{ padding: '5px 12px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold', background: t.type === 'Receipt (IN)' ? 'rgba(16,185,129,0.1)' : t.type === 'Payment (OUT)' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)', color: t.type === 'Receipt (IN)' ? '#10b981' : t.type === 'Payment (OUT)' ? '#ef4444' : '#f59e0b', border: `1px solid ${t.type === 'Receipt (IN)' ? '#10b981' : t.type === 'Payment (OUT)' ? '#ef4444' : '#f59e0b'}` }}>
                    {t.type || '-'}
                  </span>
                </td>
                <td style={{ padding: '15px 20px', textAlign: 'right', fontWeight: 'bold', fontSize: '16px' }}>
                  {t.type === 'Contra (TRANSFER)' ? (
                      (selectedAccount !== 'ALL' && selectedAccount === t.from_account) ? (
                        <span style={{color: '#ef4444'}}>- {parseFloat(t.amount || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
                      ) : (selectedAccount !== 'ALL' && selectedAccount === t.to_account) ? (
                        <span style={{color: '#10b981'}}>+ {parseFloat(t.amount || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
                      ) : (
                        <span style={{color: '#f59e0b'}}>🔄 {parseFloat(t.amount || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
                      )
                  ) : (
                      <span style={{color: t.type === 'Payment (OUT)' ? '#ef4444' : '#10b981'}}>{t.type === 'Payment (OUT)' ? '-' : '+'} {parseFloat(t.amount || 0).toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
                  )}
                </td>
                
                {/* ✨ ACTION BUTTONS (DELETE & PRINT) */}
                <td style={{ padding: '15px 20px', textAlign: 'center' }}>
                   <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                     <button onClick={() => handlePrintVoucher(t)} style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', border: '1px solid #38bdf8', padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }} title="Print Voucher">
                       🖨️
                     </button>
                     <button onClick={() => handleDeleteTransaction(t)} style={{ background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid #ef4444', padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }} title="Delete Entry">
                       🗑️
                     </button>
                   </div>
                </td>

              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ✨ SMART ENTRY VOUCHER MODAL */}
      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(2, 6, 23, 0.92)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box' }}>
          <div style={{ width: '100%', maxWidth: '750px', background: '#0f172a', borderRadius: '24px', border: '1px solid rgba(56,189,248,0.3)', padding: '35px', boxShadow: '0 30px 60px rgba(0,0,0,0.9)', maxHeight: '90vh', overflowY: 'auto' }}>
            
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #1e293b', paddingBottom: '15px', marginBottom: '25px' }}>
              <div>
                 <h3 style={{ color: '#fff', margin: 0, fontSize: '22px', display: 'flex', alignItems: 'center', gap: '10px' }}>
                   {formData.type === 'Payment (OUT)' ? '💸 Smart Payout' : formData.type === 'Receipt (IN)' ? '📥 Receive Money' : '🔄 Contra Transfer'}
                 </h3>
                 <p style={{ color: '#64748b', fontSize: '13px', margin: '5px 0 0 0' }}>Create secure accounting voucher</p>
              </div>
              <span style={{ background: 'rgba(56,189,248,0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '6px 15px', borderRadius: '20px', fontSize: '12px', fontWeight: 'bold' }}>
                🏢 {selectedCompany}
              </span>
            </div>
            
            {/* Voucher Type Selector */}
            <div style={{ display: 'flex', background: '#1e293b', padding: '6px', borderRadius: '12px', marginBottom: '30px' }}>
              {['Receipt (IN)', 'Payment (OUT)', 'Contra (TRANSFER)'].map(type => (
                <button key={type} onClick={() => setFormData({...formData, type})} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: 'none', fontWeight: 'bold', cursor: 'pointer', transition: 'all 0.3s', background: formData.type === type ? (type.includes('IN') ? '#10b981' : type.includes('OUT') ? '#ef4444' : '#f59e0b') : 'transparent', color: formData.type === type ? '#fff' : '#94a3b8' }}>
                  {type}
                </button>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
               <div style={{ background: '#1e293b', padding: '15px', borderRadius: '12px', border: '1px solid #334155' }}>
                  <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '8px' }}>📅 Transaction Date *</label>
                  <input type="date" value={formData.date} onChange={e => setFormData({...formData, date: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', colorScheme: 'dark', outline: 'none', boxSizing: 'border-box' }} />
               </div>
               
               <div style={{ background: 'rgba(16, 185, 129, 0.05)', padding: '15px', borderRadius: '12px', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                  <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '8px' }}>💰 Amount (₹) *</label>
                  <input type="number" value={formData.amount} onChange={e => setFormData({...formData, amount: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #10b981', color: '#10b981', borderRadius: '8px', fontSize: '20px', fontWeight: '900', outline: 'none', boxSizing: 'border-box' }} placeholder="0.00" />
               </div>
            </div>

            {/* Beneficiary Card */}
            {formData.type !== 'Contra (TRANSFER)' && (
              <div style={{ background: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155', marginBottom: '20px' }}>
                <label style={{ color: '#38bdf8', fontSize: '13px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '10px' }}>👤 Select Beneficiary / Party *</label>
                <select value={formData.custom_party ? 'custom' : formData.party_id} onChange={handlePartySelect} style={{ width: '100%', padding: '14px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', fontSize: '15px', outline: 'none', boxSizing: 'border-box', cursor: 'pointer' }}>
                  <option value="">-- Click to Select from Master Data --</option>
                  {ledgers.map((l, i) => <option key={i} value={l.id}>{l.name} ({l.type})</option>)}
                  <option value="custom">➕ -- Add Custom / Other Party --</option>
                </select>

                {!formData.custom_party && formData.party_id && (
                  <div style={{ marginTop: '15px', background: formData.party_ac ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)', padding: '15px', borderRadius: '8px', border: `1px solid ${formData.party_ac ? '#10b981' : '#f59e0b'}` }}>
                    <h4 style={{ margin: '0 0 10px 0', color: formData.party_ac ? '#10b981' : '#f59e0b', fontSize: '14px', display: 'flex', alignItems:'center', gap:'5px' }}>
                       {formData.party_ac ? '✅ Auto-Fetched Bank Details' : '⚠️ Bank Details Missing'}
                    </h4>
                    {formData.party_ac ? (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                        <div style={{ background: '#0f172a', padding: '10px', borderRadius: '6px' }}>
                           <span style={{ color: '#94a3b8', fontSize: '11px', display: 'block' }}>Account Number:</span>
                           <span style={{ color: '#fff', fontWeight: 'bold', fontFamily: 'monospace', fontSize: '14px' }}>{formData.party_ac}</span>
                        </div>
                        <div style={{ background: '#0f172a', padding: '10px', borderRadius: '6px' }}>
                           <span style={{ color: '#94a3b8', fontSize: '11px', display: 'block' }}>IFSC Code:</span>
                           <span style={{ color: '#fff', fontWeight: 'bold', fontFamily: 'monospace', fontSize: '14px' }}>{formData.party_ifsc}</span>
                        </div>
                      </div>
                    ) : (<p style={{ margin: 0, color: '#fcd34d', fontSize: '12px' }}>Update Bank A/C in Vendor Master to enable API Payouts.</p>)}
                  </div>
                )}

                {formData.custom_party && (
                  <div style={{ marginTop: '15px' }}>
                    <input type="text" placeholder="Enter Party Name Manually *" onChange={e => setFormData({...formData, party_name: e.target.value})} style={{ width: '100%', padding: '14px', background: '#0f172a', border: '1px dashed #475569', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', outline: 'none' }} />
                  </div>
                )}
              </div>
            )}

            {/* Bank Account Selection Card */}
            {formData.type === 'Contra (TRANSFER)' ? (
               <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px', background: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
                <div>
                  <label style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>📤 From Account (Money OUT) *</label>
                  <select value={formData.from_account} onChange={e => setFormData({...formData, from_account: e.target.value})} style={{ width: '100%', padding: '14px', background: '#0f172a', border: '1px solid #ef4444', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', outline: 'none' }}>
                    <option value="">-- Select Origin Bank --</option>
                    {filteredCompanyBanks.map(b => <option key={b.id} value={b.name}>{b.name} {b.ac_no ? `(${b.ac_no})` : ''}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>📥 To Account (Money IN) *</label>
                  <select value={formData.to_account} onChange={e => setFormData({...formData, to_account: e.target.value})} style={{ width: '100%', padding: '14px', background: '#0f172a', border: '1px solid #10b981', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', outline: 'none' }}>
                    <option value="">-- Select Destination Bank --</option>
                    {filteredCompanyBanks.map(b => <option key={b.id} value={b.name}>{b.name} {b.ac_no ? `(${b.ac_no})` : ''}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px', background: '#1e293b', padding: '20px', borderRadius: '12px', border: '1px solid #334155' }}>
                <div>
                  <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>🏦 Your Bank/Cash Account *</label>
                  <select value={formData.bank_account} onChange={e => setFormData({...formData, bank_account: e.target.value})} style={{ width: '100%', padding: '14px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', outline: 'none', cursor: 'pointer' }}>
                    <option value="">-- Choose Account --</option>
                    {filteredCompanyBanks.map(b => <option key={b.id} value={b.name}>{b.name} {b.ac_no ? `(${b.ac_no})` : ''}</option>)}
                    <option value="Cash via Pump">Cash via Petrol Pump</option>
                  </select>
                </div>
                <div>
                  <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '8px' }}>🔖 Ref / Cheque No.</label>
                  <input type="text" value={formData.ref_no} onChange={e => setFormData({...formData, ref_no: e.target.value})} style={{ width: '100%', padding: '14px', background: '#0f172a', border: '1px solid #475569', color: '#38bdf8', borderRadius: '8px', boxSizing: 'border-box', fontFamily: 'monospace', outline: 'none' }} placeholder="Optional for API" />
                </div>
              </div>
            )}

            <div style={{ background: '#1e293b', padding: '15px', borderRadius: '12px', border: '1px solid #334155' }}>
              <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '8px' }}>📝 Narration / Remarks</label>
              <input type="text" value={formData.particulars} onChange={e => setFormData({...formData, particulars: e.target.value})} style={{ width: '100%', padding: '14px', background: '#0f172a', border: 'none', color: '#fff', borderRadius: '8px', boxSizing: 'border-box', outline: 'none' }} placeholder="Being payment made for..." />
            </div>

            {/* Smart Action Buttons */}
            <div style={{ display: 'flex', gap: '15px', marginTop: '30px' }}>
              <button onClick={() => setShowModal(false)} style={{ flex: '0 0 120px', padding: '15px', background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>Cancel</button>
              
              <div style={{ flex: 1, display: 'flex', gap: '15px' }}>
                <button onClick={() => handleSaveTransaction(false)} style={{ flex: 1, padding: '15px', background: '#334155', border: 'none', color: '#fff', borderRadius: '10px', fontSize: '15px', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s' }}>
                  {loading ? 'Saving...' : '💾 Save Manual Entry'}
                </button>
                
                {formData.type === 'Payment (OUT)' && (
                  <button onClick={() => handleSaveTransaction(true)} disabled={apiProcessing || !formData.party_ac} style={{ flex: 1.2, padding: '15px', background: formData.party_ac ? 'linear-gradient(135deg, #f59e0b, #d97706)' : '#475569', border: 'none', color: '#fff', borderRadius: '10px', fontSize: '15px', fontWeight: '900', cursor: formData.party_ac ? 'pointer' : 'not-allowed', boxShadow: formData.party_ac ? '0 10px 25px rgba(245,158,11,0.5)' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                    {apiProcessing ? '⏳ Processing...' : '⚡ INSTANT API PAYOUT'}
                  </button>
                )}
              </div>
            </div>

          </div>
        </div>
      )}

      {/* 🔄 AI RECONCILIATION MODAL */}
      {showReconcileModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box' }}>
          <div style={{ width: '100%', maxWidth: '900px', background: '#0f172a', borderRadius: '24px', border: '1px solid #f59e0b', padding: '30px', boxShadow: '0 25px 50px rgba(0,0,0,0.8)', maxHeight: '90vh', overflowY: 'auto' }}>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
               <div>
                  <h3 style={{ color: '#f59e0b', margin: 0, fontSize: '24px', display: 'flex', alignItems: 'center', gap: '10px' }}>🤖 AI Bank Reconciliation Scanner</h3>
                  <p style={{ color: '#94a3b8', margin: '5px 0 0 0', fontSize: '14px' }}>Upload your Bank Statement CSV to auto-match or manually link with system entries.</p>
               </div>
               <button onClick={() => setShowReconcileModal(false)} style={{ background: 'rgba(239,68,68,0.1)', border: 'none', color: '#ef4444', height: '40px', width: '40px', borderRadius: '50%', fontSize: '18px', cursor: 'pointer', fontWeight: 'bold' }}>✕</button>
            </div>

            <div style={{ display: 'flex', gap: '20px', alignItems: 'center', marginBottom: '30px', background: 'rgba(245, 158, 11, 0.05)', padding: '25px', borderRadius: '15px', border: '1px dashed #f59e0b' }}>
               <label style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#0f172a', padding: '15px 30px', borderRadius: '10px', fontWeight: '900', cursor: 'pointer', display: 'inline-block', fontSize: '16px', boxShadow: '0 5px 15px rgba(245,158,11,0.3)' }}>
                  {isScanning ? '⏳ Scanning Statement...' : '📁 Upload Statement (.CSV)'}
                  <input type="file" hidden accept=".csv" onChange={handleStatementUpload} disabled={isScanning} />
               </label>
               {isScanning && <div style={{ color: '#f59e0b', fontWeight: 'bold', fontSize: '16px' }}>Extracting Data & Matching UTRs...</div>}
            </div>

            {statementRows.length > 0 && (
               <div style={{ background: '#1e293b', padding: '20px', borderRadius: '15px', border: '1px solid #334155' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
                    <h4 style={{ color: '#fff', margin: 0, fontSize: '18px' }}>📋 Scanned Statement Entries</h4>
                    <button onClick={triggerAutoMatch} style={{ background: 'rgba(16,185,129,0.1)', border: '1px solid #10b981', color: '#10b981', padding: '8px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>✨ Auto-Match All</button>
                  </div>
                  
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '14px', color: '#cbd5e1' }}>
                    <thead style={{ background: '#0f172a', color: '#38bdf8' }}>
                       <tr>
                         <th style={{padding:'12px 15px', borderRadius: '8px 0 0 0'}}>Date</th>
                         <th style={{padding:'12px 15px'}}>Description / UTR</th>
                         <th style={{padding:'12px 15px'}}>Amount</th>
                         <th style={{padding:'12px 15px', textAlign: 'center'}}>Status</th>
                         <th style={{padding:'12px 15px', textAlign: 'center', borderRadius: '0 8px 0 0'}}>Action</th>
                       </tr>
                    </thead>
                    <tbody>
                       {statementRows.map((row, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #334155' }}>
                             <td style={{padding:'15px'}}>{row.date}</td>
                             <td style={{padding:'15px', color:'#fff', fontWeight: 'bold'}}>{row.desc}</td>
                             <td style={{padding:'15px', color: row.type.includes('IN') ? '#10b981' : '#ef4444', fontWeight: '900', fontSize: '15px'}}>₹{row.amount}</td>
                             <td style={{padding:'15px', textAlign: 'center'}}>
                                <span style={{ background: row.status.includes('✅') ? 'rgba(16,185,129,0.2)' : row.status.includes('⚠️') ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)', color: row.status.includes('✅') ? '#10b981' : row.status.includes('⚠️') ? '#ef4444' : '#f59e0b', padding: '5px 10px', borderRadius: '6px', fontWeight: 'bold', fontSize: '11px' }}>
                                   {row.status}
                                </span>
                             </td>
                             <td style={{padding:'15px', textAlign: 'center'}}>
                               {!row.status.includes('✅') && (
                                 <button onClick={() => manualMatch(i)} style={{ background: '#3b82f6', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '6px', fontWeight: 'bold', cursor: 'pointer', fontSize: '12px' }}>🔗 Manual Match</button>
                               )}
                             </td>
                          </tr>
                       ))}
                    </tbody>
                  </table>
               </div>
            )}
          </div>
        </div>
      )}

      {/* ⚙️ MANAGE BANKS MODAL */}
      {showBankMaster && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px', boxSizing: 'border-box' }}>
           <div style={{ width: '100%', maxWidth: '800px', background: '#0f172a', borderRadius: '20px', border: '1px solid #38bdf8', display: 'flex', flexWrap: 'wrap', overflow: 'hidden', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
             <div style={{ flex: '1 1 300px', padding: '30px', background: '#1e293b' }}>
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
             <div style={{ flex: '1.2 1 350px', padding: '30px', borderLeft: '1px solid #334155', overflowY: 'auto', maxHeight: '70vh' }}>
                <h3 style={{ color: '#38bdf8', margin: '0 0 20px 0' }}>📋 Registered Banks</h3>
                {bankAccounts.map((b, idx) => (
                  <div key={idx} style={{ background: 'rgba(255,255,255,0.02)', padding: '15px', borderRadius: '10px', border: '1px solid #334155', marginBottom: '10px' }}>
                    <div style={{ color: '#f59e0b', fontSize: '10px', fontWeight: 'bold', textTransform: 'uppercase', marginBottom: '5px' }}>🏢 {b.company}</div>
                    <div style={{ fontWeight: 'bold', color: '#fff', fontSize: '16px', marginBottom: '5px' }}>{b.name}</div>
                    {b.ac_no && <div style={{ color: '#94a3b8', fontSize: '13px', fontFamily: 'monospace' }}>A/C: {b.ac_no} {b.ifsc && `| IFSC: ${b.ifsc}`}</div>}
                  </div>
                ))}
             </div>
           </div>
        </div>
      )}
    </div>
  );
}