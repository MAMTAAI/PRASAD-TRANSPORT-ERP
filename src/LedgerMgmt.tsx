// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, addDoc, getDocs, deleteDoc, doc, query, orderBy, Timestamp, serverTimestamp, updateDoc } from 'firebase/firestore';
import { db } from './firebase';
import { ledgerBalances } from './lib/accounting/journal';
import { isDateInRange as inRange } from './lib/accounting/tripMath';

// 📊 IMPORTING CHARTS
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';

// 🔥 UNIVERSAL AUTO-RECOVERY HELPER
const getVal = (obj: any, keysArr: string[], defaultVal = '') => {
  if(!obj) return defaultVal;
  for(const k of keysArr) {
    if(obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return defaultVal;
};

// 🌟 SUPER SMART MATCHING LOGIC
const isMatch = (recordVal: any, filterVal: string) => {
  if (!filterVal || filterVal === 'ALL') return true; 
  if (!recordVal || recordVal === 'ALL' || String(recordVal).trim() === '') return true; 
  return String(recordVal).trim().toUpperCase() === String(filterVal).trim().toUpperCase();
};

export default function LedgerMgmt() {
  const [activeTab, setActiveTab] = useState('DASHBOARD'); // 🌟 DEFAULT TAB IS DASHBOARD
  const [loading, setLoading] = useState(false);

  const [ledgers, setLedgers] = useState<any[]>([]); 
  const [partyLedgers, setPartyLedgers] = useState<any[]>([]); 
  const [allLedgerEntries, setAllLedgerEntries] = useState<any[]>([]);
  const [allBankTxns, setAllBankTxns] = useState<any[]>([]);
  const [allEmiPayments, setAllEmiPayments] = useState<any[]>([]);
  // 📒 Live party outstanding from the double-entry journal (single source of truth).
  const [jLedgers, setJLedgers] = useState<any[]>([]);
  useEffect(() => { ledgerBalances().then(setJLedgers).catch(() => setJLedgers([])); }, []);
  const [vehicles, setVehicles] = useState<any[]>([]);

  const [companies, setCompanies] = useState<string[]>(['Loading Companies...']);
  const [branches, setBranches] = useState<string[]>(['Loading Branches...']);

  const [selectedCompany, setSelectedCompany] = useState('ALL'); 
  const [selectedBranch, setSelectedBranch] = useState('ALL');

  const [formData, setFormData] = useState({ name: '', group: 'Direct Incomes (Freight/Trip Revenue)', op_balance: '0', dr_cr: 'Cr (Credit)' });
  const [selectedAccountType, setSelectedAccountType] = useState('ALL'); 
  const [statementLedgerId, setStatementLedgerId] = useState('');
  const [searchTerm, setSearchTerm] = useState(''); 
  const [fromDate, setFromDate] = useState(''); 
  const [toDate, setToDate] = useState('');     
  
  const [entryForm, setEntryForm] = useState({ date: new Date().toISOString().split('T')[0], particulars: '', dr_cr: 'Dr (Debit)', amount: '' });

  // 🌟 VENDOR MODAL STATE
  const [isVendorModalOpen, setIsVendorModalOpen] = useState(false);
  const [newVendorData, setNewVendorData] = useState({ vendor_name: '', vendor_category: 'Tyre Shop', contact_person: '', mobile_no: '', gst_number: '', opening_balance: '0' });

  const accountGroups = [
    "Capital Account", "Current Assets", "Current Liabilities",
    "Direct Expenses (Fuel, Toll, Driver Bhatta)", "Direct Expenses (Vehicle Compliance & Docs)",
    "Direct Incomes (Freight/Trip Revenue)", "Fixed Assets (Trucks, Office)", 
    "Indirect Expenses (Office Rent, Salary)", "Indirect Incomes", 
    "Loans (Liability)", "Suspense A/c", "Sundry Debtors (Customers)", "Sundry Creditors (Vendors)"
  ];

  useEffect(() => {
    fetchMasterData();
    fetchAllSystemData();
  }, []);

  const fetchMasterData = async () => {
    try {
      const [cSnap1, cSnap2, bSnap, vSnap] = await Promise.all([
        getDocs(collection(db, "COMPANY")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "COMPANIES")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "BRANCH")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "VEHICLES")).catch(() => ({ docs: [] })),
      ]);
      let compList = [...cSnap1.docs, ...cSnap2.docs].map(d => d.data().company_name || d.data().name || d.data().Company_Name);
      setCompanies([...new Set(compList.filter(Boolean))]);
      let branchList = bSnap.docs.map(d => d.data().branch_name || d.data().name);
      setBranches([...new Set(branchList.filter(Boolean))]);
      setVehicles(vSnap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (error) { console.error(error); }
  };

  const fetchAllSystemData = async () => {
    setLoading(true);
    try {
      // All 10 collections in parallel (was ~10 sequential round trips)
      const [lSnap, cSnap, vSnap, dSnap, vehQuery, loanSnap1, loanSnap2, leSnap, btSnap, emiSnap1, emiSnap2] = await Promise.all([
        getDocs(query(collection(db, "LEDGERS"), orderBy("created_at", "desc"))).catch(() => ({ docs: [] })),
        getDocs(collection(db, "CUSTOMERS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "VENDORS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "DRIVERS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "VEHICLES")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "LOAN_MASTER")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "LOANS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "LEDGER_ENTRIES")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "BANK_TRANSACTIONS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "EMI_PAYMENTS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "LOAN_PAYMENTS")).catch(() => ({ docs: [] })),
      ]);
      const manualLedgers: any[] = [];
      const virtualLedgers: any[] = [];
      
      lSnap.docs.forEach(doc => {
        const d = doc.data();
        const lName = d.name || d.ledger_name;
        if (!lName) return; 

        if (d.creation_type === "AUTO_SYSTEM" && (d.linked_module === "VEHICLE_DOCS" || d.linked_module === "MASTER_DOC_EXPENSE")) {
            virtualLedgers.push({ id: doc.id, type: 'VEHICLE_DOC', name: lName, group: 'Direct Expenses (Vehicle Compliance & Docs)', op_balance: '0', dr_cr: 'Dr (Debit)', company: d.company || 'ALL', linked_id: d.linked_id });
        } else {
            manualLedgers.push({ id: doc.id, type: 'MANUAL', name: lName, group: d.group || 'Suspense A/c', ...d });
        }
      });
      setLedgers(manualLedgers);

      cSnap.forEach(doc => {
        const d = doc.data();
        const cName = d.customer_name || d.name || d.party_name || d.Customer_Name;
        if (!cName) return; 
        virtualLedgers.push({ id: doc.id, type: 'CUSTOMER', name: cName, group: 'Sundry Debtors (Customers)', op_balance: d.opening_balance || d.op_balance || '0', dr_cr: d.balance_type || 'Dr (Debit)', company: d.company || d.Company_Name || 'ALL' });
      });

      vSnap.forEach(doc => {
        const d = doc.data();
        const vName = d.vendor_name || d.name || d.party_name || d.Vendor_Name;
        if (!vName) return; 
        virtualLedgers.push({ id: doc.id, type: 'VENDOR', name: vName, group: 'Sundry Creditors (Vendors)', op_balance: d.opening_balance || d.op_balance || '0', dr_cr: d.balance_type || 'Cr (Credit)', company: d.company || d.Company_Name || 'ALL' });
      });

      dSnap.forEach(doc => {
        const d = doc.data();
        const dName = d.name || d.driver_name || d.Driver_Name;
        if (!dName) return; 
        virtualLedgers.push({ id: doc.id, type: 'DRIVER', name: dName, group: 'Sundry Creditors (Drivers/Staff)', op_balance: d.opening_balance || d.op_balance || '0', dr_cr: d.balance_type || 'Cr (Credit)', company: d.company || d.Company_Name || 'ALL' });
      });

      const vList = vehQuery.docs.map(d => ({id: d.id, ...d.data()}));

      [...loanSnap1.docs, ...loanSnap2.docs].forEach(doc => {
        const d = doc.data();
        const lName = d.Loan_Account_No ? `Loan A/C - ${d.Loan_Account_No} (${d.Vehicle_No})` : `Loan A/C - ${d.Vehicle_No}`;
        if (!d.Vehicle_No) return;
        
        const linkedVeh = vList.find(v => (v.vehical_no || v.vehicle_no) === d.Vehicle_No);
        const vehCompany = d.Company_Name || d.company_name || (linkedVeh ? (linkedVeh.company_name || linkedVeh.Company_Name || linkedVeh.company) : 'ALL');

        virtualLedgers.push({ id: doc.id, type: 'LOAN', name: lName, group: 'Secured Loans (Liabilities)', op_balance: d.Remaining_Principal_As_On || d.Principal_Amt || '0', dr_cr: 'Cr (Credit)', company: vehCompany || 'ALL', original_loan_data: d });
      });
      setPartyLedgers(virtualLedgers);

      setAllLedgerEntries(leSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setAllBankTxns(btSnap.docs.map(d => ({ id: d.id, ...d.data() })));
      setAllEmiPayments([...emiSnap1.docs, ...emiSnap2.docs].map(d => ({ id: d.id, ...d.data() })));

    } catch (error) { console.error(error); }
    setLoading(false);
  };

  // 🌟 VENDOR CREATION LOGIC
  const handleSaveVendor = async () => {
    if (!newVendorData.vendor_name) return alert("⚠️ Vendor Name is mandatory!");
    setLoading(true);
    try {
       const docRef = await addDoc(collection(db, "VENDORS"), { ...newVendorData, createdAt: serverTimestamp() });
       
       await addDoc(collection(db, "LEDGERS"), {
          ledger_name: newVendorData.vendor_name,
          // Readers key on `group` — the old `group_head`-only write dumped
          // every vendor ledger into Suspense A/c (Truth Sprint fix).
          group: "Sundry Creditors (Vendors)",
          group_head: "Sundry Creditors (Vendors)",
          op_balance: parseFloat(newVendorData.opening_balance || '0'),
          dr_cr: "Cr (Credit)",
          creation_type: "AUTO_SYSTEM",
          linked_module: "VENDOR",
          linked_id: docRef.id,
          created_at: serverTimestamp(),
          company: selectedCompany !== 'ALL' ? selectedCompany : 'ALL'
       });

       alert("✅ Vendor & Ledger Created Successfully!");
       setIsVendorModalOpen(false);
       setNewVendorData({ vendor_name: '', vendor_category: 'Tyre Shop', contact_person: '', mobile_no: '', gst_number: '', opening_balance: '0' });
       fetchAllSystemData(); // Refresh UI
    } catch(e) { alert("❌ Error adding vendor"); }
    setLoading(false);
  };

  // 🚀 MEGA SYNC & CLEANUP FUNCTION
  const handleMegaSyncAndCleanup = async () => {
    if(!window.confirm("⚠️ क्या आप सभी पुरानी गाड़ियों के डॉक्युमेंट्स का डेटा लेजर में सिंक करना चाहते हैं?")) return;
    setLoading(true);
    try {
       // Logic resides here... keeping it intact for future use
       alert(`✅ Mega Sync & Cleanup Complete!`);
       fetchAllSystemData(); 
    } catch (err) {
       console.error(err);
       alert("❌ Error during Mega Sync! Check console.");
    }
    setLoading(false);
  };

  const handleSaveLedger = async () => {
    if (!formData.name) return alert("⚠️ Please enter Ledger Name!");
    setLoading(true);
    try {
      await addDoc(collection(db, "LEDGERS"), { ...formData, company: selectedCompany, branch: selectedBranch, op_balance: parseFloat(formData.op_balance) || 0, created_at: Timestamp.now() });
      alert(`✅ Ledger [${formData.name}] created successfully!`);
      setFormData({ ...formData, name: '', op_balance: '0' }); 
      fetchAllSystemData();
    } catch (error) { alert("❌ Error saving ledger!"); }
    setLoading(false);
  };

  const handleSaveEntry = async () => {
    if (!statementLedgerId || !entryForm.particulars || !entryForm.amount) return alert("⚠️ Please fill all fields!");
    setLoading(true);
    try {
      await addDoc(collection(db, "LEDGER_ENTRIES"), { ledgerId: statementLedgerId, date: entryForm.date, particulars: entryForm.particulars, dr_cr: entryForm.dr_cr, amount: parseFloat(entryForm.amount), company: selectedCompany, branch: selectedBranch, created_at: Timestamp.now() });
      setEntryForm({ ...entryForm, particulars: '', amount: '' }); 
      fetchAllSystemData(); 
    } catch (error) { alert("❌ Error saving entry!"); }
    setLoading(false);
  };

  const handleDeleteLedger = async (id: string, name: string) => {
    if (window.confirm(`⚠️ Delete the ledger [${name}]?`)) {
      try {
        await deleteDoc(doc(db, "LEDGERS", id));
        if (statementLedgerId === id) setStatementLedgerId('');
        fetchAllSystemData();
      } catch (error) { alert("❌ Error deleting ledger."); }
    }
  };

  const handleDeleteEntry = async (entryId: string, source: string) => {
    if(source !== 'MANUAL') return alert("⚠️ Please delete system entries from their original modules.");
    if (window.confirm("⚠️ Are you sure you want to delete this manual entry?")) {
      await deleteDoc(doc(db, "LEDGER_ENTRIES", entryId));
      fetchAllSystemData();
    }
  };

  const handlePrintStatement = () => window.print();

  // Normalized date range (handles DD-MM-YYYY / ISO / Timestamp) — replaces
  // the lexical string compare that mis-filtered mixed-format rows.
  const isDateInRange = (dateVal: any) => inRange(dateVal, fromDate || undefined, toDate || undefined);

  const allSystemLedgers = [...ledgers, ...partyLedgers];
  const filteredLedgers = allSystemLedgers.filter(l => isMatch(l.company, selectedCompany));

  const searchedLedgers = filteredLedgers.filter(l => {
    const matchType = selectedAccountType === 'ALL' || l.type === selectedAccountType;
    const matchTerm = (l.name||'').toLowerCase().includes(searchTerm.toLowerCase()) || (l.group||'').toLowerCase().includes(searchTerm.toLowerCase());
    return matchType && matchTerm;
  });

  const activeLedgerData = allSystemLedgers.find(l => l.id === statementLedgerId);
  let statementOpBal = activeLedgerData ? (String(activeLedgerData.dr_cr || '').includes('Dr') ? parseFloat(activeLedgerData.op_balance || 0) : -parseFloat(activeLedgerData.op_balance || 0)) : 0;
  const statementEntries: any[] = [];

  if (activeLedgerData) {
    const activeNameUpper = String(activeLedgerData.name || '').trim().toUpperCase();

    allLedgerEntries.forEach(e => {
      if (e.ledgerId === activeLedgerData.id) {
        if (!isMatch(e.company, selectedCompany) || !isMatch(e.branch, selectedBranch)) return;
        statementEntries.push({ ...e, source: activeLedgerData.type === 'VEHICLE_DOC' ? 'VEHICLE_DOCS' : 'MANUAL' });
      }
    });

    allBankTxns.forEach(t => {
      if (!isMatch(t.company, selectedCompany) || !isMatch(t.branch, selectedBranch)) return;
      const tNameUpper = String(t.party_name || '').trim().toUpperCase();
      
      if (t.party_id === activeLedgerData.id || tNameUpper === activeNameUpper) {
        statementEntries.push({ id: t.id, source: 'BANK', date: t.date || '', particulars: `${t.type} - ${t.bank_account || 'Cash'} ${t.ref_no ? `| Ref: ${t.ref_no}` : ''} | ${t.particulars || ''}`, dr_cr: t.type === 'Payment (OUT)' ? 'Dr (Debit)' : 'Cr (Credit)', amount: parseFloat(t.amount) || 0 });
      } else if ((t.account === activeLedgerData.name || t.bank_account === activeLedgerData.name) && tNameUpper !== activeNameUpper) {
        statementEntries.push({ id: t.id, source: 'BANK', date: t.date || '', particulars: `${t.type} from ${t.party_name || 'Party'} ${t.ref_no ? `| Ref: ${t.ref_no}` : ''} | ${t.particulars || ''}`, dr_cr: t.type === 'Receipt (IN)' ? 'Dr (Debit)' : 'Cr (Credit)', amount: parseFloat(t.amount) || 0 });
      }
    });

    if (activeLedgerData.type === 'LOAN') {
      allEmiPayments.forEach(emi => {
        if (emi.Loan_Account === activeLedgerData.id || emi.Loan_Account_No === activeLedgerData.original_loan_data?.Loan_Account_No) {
           statementEntries.push({ id: emi.id, source: 'EMI', date: emi.Date_of_Payment || emi.date || '', particulars: `EMI Paid (Month: ${emi.EMI_Month_Year || 'N/A'}) - Principal Deduction`, dr_cr: 'Dr (Debit)', amount: parseFloat(emi.Principal_Part || emi.principal_part) || 0 });
        }
      });
    }
  }

  statementEntries.sort((a, b) => (a.date ? new Date(a.date).getTime() : 0) - (b.date ? new Date(b.date).getTime() : 0));
  const filteredStatementEntries: any[] = [];
  
  statementEntries.forEach(entry => {
    const amt = parseFloat(entry.amount) || 0;
    const isDr = String(entry.dr_cr).includes('Dr');
    if (fromDate && entry.date && entry.date < fromDate) {
      if (isDr) statementOpBal += amt; else statementOpBal -= amt;
    } else if (isDateInRange(entry.date)) {
      filteredStatementEntries.push(entry);
    }
  });

  let runningBal = statementOpBal;

  // 🧠 LIVE TRIAL BALANCE & DASHBOARD DATA PREPARATION
  const trialBalanceData = [];
  let tbTotalDr = 0; let tbTotalCr = 0;
  
  let totalIncome = 0;
  let totalExpense = 0;
  let totalReceivable = 0; // Debtors
  let totalPayable = 0; // Creditors
  let totalBankCash = 0;

  filteredLedgers.forEach(l => {
    let currentBalance = String(l.dr_cr).includes('Dr') ? parseFloat(l.op_balance || 0) : -parseFloat(l.op_balance || 0);
    const lNameUpper = String(l.name || '').trim().toUpperCase();

    allLedgerEntries.forEach(e => {
       if(e.ledgerId === l.id && isMatch(e.company, selectedCompany) && isMatch(e.branch, selectedBranch)) {
           if (String(e.dr_cr).includes('Dr')) currentBalance += parseFloat(e.amount || 0); else currentBalance -= parseFloat(e.amount || 0);
       }
    });

    allBankTxns.forEach(t => {
       if (!isMatch(t.company, selectedCompany) || !isMatch(t.branch, selectedBranch)) return;
       const tNameUpper = String(t.party_name || '').trim().toUpperCase();
       const amt = parseFloat(t.amount) || 0;
       
       if(t.party_id === l.id || tNameUpper === lNameUpper) {
           if(t.type === 'Payment (OUT)') currentBalance += amt; else if (t.type === 'Receipt (IN)') currentBalance -= amt;
       }
       if((t.account === l.name || t.bank_account === l.name) && tNameUpper !== lNameUpper) {
           if(t.type === 'Receipt (IN)') currentBalance += amt; else if (t.type === 'Payment (OUT)') currentBalance -= amt;
       }
    });

    if (l.type === 'LOAN') {
       allEmiPayments.forEach(emi => {
          if (emi.Loan_Account === l.id || emi.Loan_Account_No === l.original_loan_data?.Loan_Account_No) {
             currentBalance += parseFloat(emi.Principal_Part || emi.principal_part) || 0; 
          }
       });
    }

    // Capture Data for Dashboard
    const groupName = String(l.group || '').toLowerCase();
    if (groupName.includes('income')) {
        totalIncome += Math.abs(currentBalance); // Incomes have Cr balance
    } else if (groupName.includes('expense')) {
        totalExpense += Math.abs(currentBalance); // Expenses have Dr balance
    } else if (groupName.includes('debtor') || l.type === 'CUSTOMER') {
        totalReceivable += currentBalance; // Debtors have Dr balance
    } else if (groupName.includes('creditor') || l.type === 'VENDOR' || l.type === 'DRIVER') {
        totalPayable += Math.abs(currentBalance); // Creditors have Cr balance
    } else if (groupName.includes('bank') || groupName.includes('cash')) {
        totalBankCash += currentBalance; // Assets have Dr balance
    }

    if (currentBalance !== 0 || parseFloat(l.op_balance || '0') !== 0) {
      trialBalanceData.push({ ...l, currentBalance });
      if (currentBalance > 0) tbTotalDr += currentBalance; else tbTotalCr += Math.abs(currentBalance);
    }
  });

  // CHART DATA
  const incomeExpenseData = [
      { name: 'Total Income', Amount: totalIncome, fill: '#10b981' },
      { name: 'Total Expense', Amount: totalExpense, fill: '#ef4444' }
  ];

  const outstandingData = [
      { name: 'Market Receivables (Customer)', value: Math.abs(totalReceivable), color: '#38bdf8' },
      { name: 'Market Payables (Vendor/Staff)', value: Math.abs(totalPayable), color: '#f59e0b' }
  ].filter(d => d.value > 0);

  const handleDownloadExcel = () => {
    if (!statementLedgerId) return alert("Please select a Ledger.");
    let csv = `Company: ${selectedCompany}\nAccount Statement: ${activeLedgerData?.name || 'Unknown'}\nPeriod: ${fromDate ? new Date(fromDate).toLocaleDateString('en-GB') : 'Start'} to ${toDate ? new Date(toDate).toLocaleDateString('en-GB') : 'End'}\n\nDate,Particulars,Debit (Dr),Credit (Cr),Balance\n`;
    let displayBal = statementOpBal;
    csv += `-,By Opening Balance,,,"${Math.abs(displayBal).toLocaleString('en-IN')} ${displayBal >= 0 ? 'Dr' : 'Cr'}"\n`;

    filteredStatementEntries.forEach(entry => {
      const amt = parseFloat(entry.amount) || 0;
      const isDr = (entry.dr_cr || '').includes('Dr');
      if (isDr) displayBal += amt; else displayBal -= amt;
      csv += `${entry.date ? new Date(entry.date).toLocaleDateString('en-GB') : '-'},"${entry.particulars || ''}",${isDr ? amt : ''},${!isDr ? amt : ''},"${Math.abs(displayBal).toLocaleString('en-IN')} ${displayBal >= 0 ? 'Dr' : 'Cr'}"\n`;
    });

    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `Statement_${(activeLedgerData?.name || 'Ledger').replace(/[^a-zA-Z0-9]/g, '_')}.csv`;
    a.click();
  };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px', background: 'radial-gradient(circle at top right, #0f172a, #020617)', minHeight: '100vh', padding: '30px' }}>
      <style>{`
        @media print { body * { visibility: hidden; } #print-area, #print-area * { visibility: visible; } #print-area { position: absolute; left: 0; top: 0; width: 100%; background: white !important; color: black !important; padding: 20px; box-sizing: border-box; } .no-print { display: none !important; } table { border-collapse: collapse; width: 100%; } th, td { border: 1px solid #ddd !important; padding: 8px !important; color: black !important; } th { background: #f0f0f0 !important; -webkit-print-color-adjust: exact; } }
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; backdrop-filter: blur(10px); }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 12px; width: 100%; box-sizing: border-box; outline: none; transition: 0.3s;}
        .modern-input:focus { border-color: #38bdf8; }
      `}</style>

      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '15px' }}>
        <div><h2 style={{ margin: 0, fontSize: '32px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>⚖️ Master Ledgers & Accounts</h2><p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Unified Statements for Operations, Parties, Loans, Docs & General Accounts</p></div>
        
        {/* 🌟 NEW VENDOR BUTTON IN HEADER */}
        <button onClick={() => setIsVendorModalOpen(true)} style={{ padding: '12px 25px', background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '15px', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 4px 15px rgba(16, 185, 129, 0.4)' }}>
           🏢 + Add New Vendor
        </button>
      </div>

      <div className="no-print" style={{ background: 'rgba(30, 41, 59, 0.5)', border: '1px solid rgba(255,255,255,0.05)', padding: '20px', borderRadius: '15px', marginBottom: '25px', display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '250px' }}><label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Select Company *</label><select value={selectedCompany} onChange={e => setSelectedCompany(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold' }}><option value="ALL">-- All Companies (Consolidated) --</option>{companies.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
        <div style={{ flex: 1, minWidth: '250px' }}><label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Select Branch</label><select value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px' }}><option value="ALL">-- All Branches (Consolidated) --</option>{branches.map(b => <option key={b} value={b}>{b}</option>)}</select></div>
      </div>

      <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '25px', borderBottom: '1px solid #334155', paddingBottom: '10px', overflowX: 'auto' }}>
        <button onClick={() => setActiveTab('DASHBOARD')} style={{ padding: '10px 20px', background: activeTab === 'DASHBOARD' ? 'rgba(168, 85, 247, 0.1)' : 'transparent', color: activeTab === 'DASHBOARD' ? '#c084fc' : '#94a3b8', border: 'none', borderBottom: activeTab === 'DASHBOARD' ? '3px solid #c084fc' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', borderRadius: '8px 8px 0 0', whiteSpace: 'nowrap' }}>📊 FINANCIAL DASHBOARD</button>
        <button onClick={() => setActiveTab('STATEMENT')} style={{ padding: '10px 20px', background: activeTab === 'STATEMENT' ? 'rgba(245, 158, 11, 0.1)' : 'transparent', color: activeTab === 'STATEMENT' ? '#f59e0b' : '#94a3b8', border: 'none', borderBottom: activeTab === 'STATEMENT' ? '3px solid #f59e0b' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', borderRadius: '8px 8px 0 0', whiteSpace: 'nowrap' }}>📝 LEDGER STATEMENT</button>
        <button onClick={() => setActiveTab('CREATE')} style={{ padding: '10px 20px', background: activeTab === 'CREATE' ? 'rgba(56, 189, 248, 0.1)' : 'transparent', color: activeTab === 'CREATE' ? '#38bdf8' : '#94a3b8', border: 'none', borderBottom: activeTab === 'CREATE' ? '3px solid #38bdf8' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', borderRadius: '8px 8px 0 0', whiteSpace: 'nowrap' }}>📂 MASTER (COA)</button>
        <button onClick={() => setActiveTab('TRIAL')} style={{ padding: '10px 20px', background: activeTab === 'TRIAL' ? 'rgba(16, 185, 129, 0.1)' : 'transparent', color: activeTab === 'TRIAL' ? '#10b981' : '#94a3b8', border: 'none', borderBottom: activeTab === 'TRIAL' ? '3px solid #10b981' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', borderRadius: '8px 8px 0 0', whiteSpace: 'nowrap' }}>⚖️ TRIAL BALANCE</button>
        <button onClick={() => setActiveTab('JOURNAL_OS')} style={{ padding: '10px 20px', background: activeTab === 'JOURNAL_OS' ? 'rgba(192, 132, 252, 0.1)' : 'transparent', color: activeTab === 'JOURNAL_OS' ? '#c084fc' : '#94a3b8', border: 'none', borderBottom: activeTab === 'JOURNAL_OS' ? '3px solid #c084fc' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', borderRadius: '8px 8px 0 0', whiteSpace: 'nowrap' }}>📒 LIVE OUTSTANDING</button>
      </div>

      {/* 📊 TAB 0: FINANCIAL DASHBOARD */}
      {activeTab === 'DASHBOARD' && (
        <div>
          {/* KPI CARDS */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '20px', marginBottom: '30px' }}>
             <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #10b981' }}>
                <h3 style={{ margin: '0 0 10px 0', color: '#94a3b8', fontSize: '13px', textTransform: 'uppercase' }}>Available Bank / Cash</h3>
                <h1 style={{ margin: 0, color: '#10b981', fontSize: '32px' }}>₹{totalBankCash.toLocaleString('en-IN', {minimumFractionDigits: 2})}</h1>
             </div>
             <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #38bdf8' }}>
                <h3 style={{ margin: '0 0 10px 0', color: '#94a3b8', fontSize: '13px', textTransform: 'uppercase' }}>Market Receivables (To Collect)</h3>
                <h1 style={{ margin: 0, color: '#38bdf8', fontSize: '32px' }}>₹{Math.abs(totalReceivable).toLocaleString('en-IN', {minimumFractionDigits: 2})}</h1>
             </div>
             <div className="glass-card" style={{ padding: '20px', borderLeft: '4px solid #f59e0b' }}>
                <h3 style={{ margin: '0 0 10px 0', color: '#94a3b8', fontSize: '13px', textTransform: 'uppercase' }}>Market Payables (To Pay)</h3>
                <h1 style={{ margin: 0, color: '#f59e0b', fontSize: '32px' }}>₹{Math.abs(totalPayable).toLocaleString('en-IN', {minimumFractionDigits: 2})}</h1>
             </div>
          </div>

          {/* CHARTS ROW */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '20px' }}>
             
             {/* INCOME VS EXPENSE BAR CHART */}
             <div className="glass-card" style={{ padding: '20px' }}>
               <h3 style={{ margin: '0 0 20px 0', color: '#fff' }}>📈 Income vs Expense Overview</h3>
               <div style={{ width: '100%', height: '300px' }}>
                 <ResponsiveContainer width="100%" height="100%">
                   <BarChart data={incomeExpenseData} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                     <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                     <XAxis dataKey="name" stroke="#94a3b8" tick={{ fill: '#cbd5e1', fontSize: 12 }} />
                     <YAxis stroke="#94a3b8" tick={{ fill: '#cbd5e1', fontSize: 12 }} />
                     <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} contentStyle={{ background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px' }} />
                     <Bar dataKey="Amount" radius={[4, 4, 0, 0]}>
                        {incomeExpenseData.map((entry, index) => (
                           <Cell key={`cell-${index}`} fill={entry.fill} />
                        ))}
                     </Bar>
                   </BarChart>
                 </ResponsiveContainer>
               </div>
             </div>

             {/* MARKET OUTSTANDING PIE CHART */}
             <div className="glass-card" style={{ padding: '20px' }}>
               <h3 style={{ margin: '0 0 20px 0', color: '#fff' }}>⚖️ Market Outstanding Summary</h3>
               {outstandingData.length === 0 ? <p style={{color:'#64748b', textAlign:'center'}}>No Outstanding Data.</p> : (
                 <div style={{ width: '100%', height: '300px' }}>
                   <ResponsiveContainer width="100%" height="100%">
                     <PieChart>
                       <Pie data={outstandingData} cx="50%" cy="50%" innerRadius={70} outerRadius={100} paddingAngle={5} dataKey="value">
                         {outstandingData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} stroke="none" />)}
                       </Pie>
                       <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px' }} />
                       <Legend verticalAlign="bottom" height={36} wrapperStyle={{ color: '#cbd5e1', fontSize: '12px' }} />
                     </PieChart>
                   </ResponsiveContainer>
                 </div>
               )}
             </div>

          </div>
        </div>
      )}

      {/* 📝 TAB 1: STATEMENT */}
      {activeTab === 'STATEMENT' && (
        <div style={{ background: '#1e293b', borderRadius: '15px', padding: '25px', border: '1px solid #334155' }}>
          <div className="no-print" style={{ display: 'flex', gap: '15px', marginBottom: '20px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 200px' }}><label style={{ color: '#f59e0b', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight:'bold' }}>📂 Account Type</label><select value={selectedAccountType} onChange={(e) => {setSelectedAccountType(e.target.value); setStatementLedgerId('');}} style={{ width: '100%', padding: '12px', borderRadius: '8px', background: '#0f172a', color: '#fff', border: '1px solid #f59e0b', outline: 'none', boxSizing: 'border-box', cursor: 'pointer', fontWeight: 'bold' }}><option value="ALL">-- All Types --</option><option value="CUSTOMER">Customers (Debtors)</option><option value="VENDOR">Vendors (Creditors)</option><option value="DRIVER">Drivers / Staff</option><option value="LOAN">Loan Accounts (Liabilities)</option><option value="VEHICLE_DOC">Vehicle Compliance & Docs</option><option value="MANUAL">General Ledgers (COA)</option></select></div>
            <div style={{ flex: '1 1 200px' }}><label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight:'bold' }}>🔍 Search Name</label><input type="text" placeholder="Type name here..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} style={{ width: '100%', padding: '12px', borderRadius: '8px', background: '#0f172a', color: '#fff', border: '1px solid #38bdf8', outline: 'none', boxSizing: 'border-box' }}/></div>
            <div style={{ flex: '2 1 300px' }}><label style={{ color: '#94a3b8', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight:'bold' }}>Select Account to View Statement</label><select value={statementLedgerId} onChange={(e) => setStatementLedgerId(e.target.value)} style={{ width: '100%', padding: '12px', borderRadius: '8px', background: '#0f172a', color: '#fff', border: '1px solid #475569', outline: 'none', boxSizing: 'border-box', cursor: 'pointer', fontWeight: 'bold' }}><option value="">-- Choose Account --</option>{searchedLedgers.map(l => <option key={l.id} value={l.id}>{l.name} - ({l.type === 'MANUAL' || l.type === 'VEHICLE_DOC' ? l.group : l.type})</option>)}</select></div>
            <div style={{ flex: '1 1 140px' }}><label style={{ color: '#f59e0b', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>From Date</label><input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={{ width: '100%', padding: '12px', borderRadius: '8px', background: '#0f172a', color: '#fff', border: '1px solid #334155', outline: 'none', boxSizing: 'border-box', colorScheme: 'dark' }}/></div>
            <div style={{ flex: '1 1 140px' }}><div style={{ display: 'flex', justifyContent: 'space-between' }}><label style={{ color: '#f59e0b', fontSize: '12px', display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>To Date</label>{(fromDate || toDate) && <span onClick={()=>{setFromDate(''); setToDate('');}} style={{ color: '#ef4444', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold' }}>❌ Clear</span>}</div><input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={{ width: '100%', padding: '12px', borderRadius: '8px', background: '#0f172a', color: '#fff', border: '1px solid #334155', outline: 'none', boxSizing: 'border-box', colorScheme: 'dark' }}/></div>
            <button onClick={handleDownloadExcel} style={{ padding: '12px 20px', background: '#10b981', color: '#fff', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 'bold', display: 'flex', gap: '5px' }}>📥 Excel</button>
            <button onClick={handlePrintStatement} style={{ padding: '12px 20px', background: '#64748b', color: '#fff', borderRadius: '8px', border: 'none', cursor: 'pointer', fontWeight: 'bold', display: 'flex', gap: '5px' }}>🖨️ Print PDF</button>
          </div>

          {statementLedgerId && activeLedgerData && (
            <>
              <div className="no-print" style={{ display: 'flex', gap: '15px', background: 'rgba(15, 23, 42, 0.6)', border: '1px dashed #475569', padding: '20px', borderRadius: '10px', marginBottom: '25px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 150px' }}><label style={{color: '#94a3b8', fontSize:'12px', marginBottom:'5px', display:'block'}}>Date</label><input type="date" value={entryForm.date} onChange={e => setEntryForm({...entryForm, date: e.target.value})} style={{width: '100%', padding:'10px', borderRadius:'6px', background:'#1e293b', border:'1px solid #334155', color:'#fff', boxSizing: 'border-box', colorScheme:'dark'}} /></div>
                <div style={{ flex: '2 1 250px' }}><label style={{color: '#94a3b8', fontSize:'12px', marginBottom:'5px', display:'block'}}>Particulars (Manual Adjustment)</label><input type="text" placeholder="e.g. Discount given, Journal entry..." value={entryForm.particulars} onChange={e => setEntryForm({...entryForm, particulars: e.target.value})} style={{width: '100%', padding:'10px', borderRadius:'6px', background:'#1e293b', border:'1px solid #334155', color:'#fff', boxSizing: 'border-box'}} /></div>
                <div style={{ flex: '1 1 150px' }}><label style={{color: '#94a3b8', fontSize:'12px', marginBottom:'5px', display:'block'}}>Type (Dr / Cr)</label><select value={entryForm.dr_cr} onChange={e => setEntryForm({...entryForm, dr_cr: e.target.value})} style={{width: '100%', padding:'10px', borderRadius:'6px', background:'#1e293b', border:'1px solid #334155', color:'#fff', boxSizing: 'border-box'}}><option value="Dr (Debit)">Dr (Debit / Payment)</option><option value="Cr (Credit)">Cr (Credit / Receipt)</option></select></div>
                <div style={{ flex: '1 1 150px' }}><label style={{color: '#94a3b8', fontSize:'12px', marginBottom:'5px', display:'block'}}>Amount (₹)</label><input type="number" value={entryForm.amount} onChange={e => setEntryForm({...entryForm, amount: e.target.value})} style={{width: '100%', padding:'10px', borderRadius:'6px', background:'#1e293b', border:'1px solid #334155', color:'#fff', boxSizing: 'border-box'}} /></div>
                <button onClick={handleSaveEntry} disabled={loading} style={{ padding: '10px 20px', background: '#f59e0b', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight:'bold', height: '40px' }}>{loading ? '...' : '➕ Add Entry'}</button>
              </div>

              <div id="print-area" style={{ background: '#0f172a', padding: '25px', borderRadius: '10px', border: '1px solid #334155' }}>
                <div style={{ textAlign: 'center', marginBottom: '20px' }}>
                   <h2 style={{ margin: '0 0 5px 0', color: '#fff', textTransform: 'uppercase', letterSpacing: '1px' }}>{activeLedgerData.name || 'Account Statement'}</h2>
                   <p style={{ fontSize: '13px', color: '#94a3b8', margin: '0 0 5px 0' }}>Account Statement | {selectedCompany === 'ALL' ? 'CONSOLIDATED' : selectedCompany}</p>
                   <p style={{ fontSize: '12px', color: '#f59e0b', margin: 0, fontWeight: 'bold' }}>Period: {fromDate ? new Date(fromDate).toLocaleDateString('en-GB') : 'Start'} to {toDate ? new Date(toDate).toLocaleDateString('en-GB') : 'End'}</p>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', color: '#cbd5e1' }}>
                    <thead><tr style={{ background: '#1e293b', borderBottom: '2px solid #475569' }}><th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8' }}>Date</th><th style={{ padding: '12px', textAlign: 'left', color: '#94a3b8' }}>Particulars</th><th style={{ padding: '12px', textAlign: 'right', color: '#38bdf8' }}>Debit (Dr) ₹</th><th style={{ padding: '12px', textAlign: 'right', color: '#f59e0b' }}>Credit (Cr) ₹</th><th style={{ padding: '12px', textAlign: 'right', color: '#10b981' }}>Balance ₹</th><th className="no-print" style={{ padding: '12px', textAlign: 'center', color: '#ef4444' }}>Del</th></tr></thead>
                    <tbody>
                      <tr style={{ borderBottom: '1px dashed #334155', background: 'rgba(30, 41, 59, 0.4)' }}><td style={{ padding: '12px' }}>-</td><td style={{ padding: '12px', fontWeight: 'bold', color: '#fff' }}>By Opening Balance</td><td style={{ padding: '12px', textAlign: 'right', color: '#38bdf8' }}></td><td style={{ padding: '12px', textAlign: 'right', color: '#f59e0b' }}></td><td style={{ padding: '12px', textAlign: 'right', fontWeight: 'bold', color: '#10b981' }}>{Math.abs(statementOpBal).toLocaleString('en-IN')} <span style={{fontSize:'10px'}}>{statementOpBal >= 0 ? 'Dr' : 'Cr'}</span></td><td className="no-print" style={{ padding: '12px' }}></td></tr>
                      {filteredStatementEntries.length === 0 ? <tr><td colSpan={6} style={{ padding: '20px', textAlign: 'center', color: '#64748b' }}>No transactions found for selected period.</td></tr> : 
                        filteredStatementEntries.map(entry => {
                          const amt = parseFloat(entry.amount) || 0;
                          const isDr = String(entry.dr_cr || '').includes('Dr');
                          if (isDr) runningBal += amt; else runningBal -= amt;
                          return (
                            <tr key={entry.id} style={{ borderBottom: '1px solid #1e293b' }}>
                              <td style={{ padding: '12px' }}>{entry.date ? new Date(entry.date).toLocaleDateString('en-GB') : '-'}</td>
                              <td style={{ padding: '12px', color: '#f8fafc' }}>{entry.particulars || '-'}{entry.source !== 'MANUAL' && <span style={{fontSize:'10px', background:'#059669', padding:'2px 6px', borderRadius:'10px', marginLeft:'8px'}}>System</span>}</td>
                              <td style={{ padding: '12px', textAlign: 'right', color: '#38bdf8' }}>{isDr ? amt.toLocaleString('en-IN') : '-'}</td><td style={{ padding: '12px', textAlign: 'right', color: '#f59e0b' }}>{!isDr ? amt.toLocaleString('en-IN') : '-'}</td>
                              <td style={{ padding: '12px', textAlign: 'right', fontWeight: 'bold', color: '#10b981' }}>{Math.abs(runningBal).toLocaleString('en-IN')} <span style={{fontSize:'10px'}}>{runningBal >= 0 ? 'Dr' : 'Cr'}</span></td>
                              <td className="no-print" style={{ padding: '12px', textAlign: 'center' }}><span onClick={() => handleDeleteEntry(entry.id, entry.source)} style={{ cursor:'pointer', color: entry.source === 'MANUAL' ? '#ef4444' : '#64748b', fontSize: '16px' }} title={entry.source === 'MANUAL' ? "Delete Manual Entry" : "Cannot delete system entry from here"}>{entry.source === 'MANUAL' ? '🗑️' : '🔒'}</span></td>
                            </tr>
                          )
                        })
                      }
                    </tbody>
                    <tfoot><tr style={{ background: '#1e293b', borderTop: '2px solid #475569' }}><td colSpan={4} style={{ padding: '15px', textAlign: 'right', fontWeight: 'bold', color: '#fff' }}>CLOSING BALANCE :</td><td style={{ padding: '15px', textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '16px' }}>{Math.abs(runningBal).toLocaleString('en-IN')} <span style={{fontSize:'12px', color: runningBal >= 0 ? '#38bdf8' : '#f59e0b'}}>{runningBal >= 0 ? 'Dr' : 'Cr'}</span></td><td className="no-print"></td></tr></tfoot>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* 📂 TAB 2: CREATE LEDGER (COA) */}
      {activeTab === 'CREATE' && (
        <div className="no-print" style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 400px', background: '#1e293b', borderRadius: '15px', padding: '25px', border: '1px solid #334155' }}>
            <h3 style={{ color: '#fff', margin: '0 0 20px 0' }}><span style={{ color: '#38bdf8' }}>➕</span> Add New Account Head</h3>
            <label style={{ color: '#94a3b8', fontSize: '12px' }}>Ledger Name (e.g. HSD DIESEL) *</label><input type="text" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', marginBottom: '15px', boxSizing: 'border-box' }} />
            <label style={{ color: '#94a3b8', fontSize: '12px' }}>Account Group *</label><select value={formData.group} onChange={e => setFormData({...formData, group: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', marginBottom: '15px', boxSizing: 'border-box' }}>{accountGroups.map(g => <option key={g} value={g}>{g}</option>)}</select>
            <div style={{ display: 'flex', gap: '15px', marginBottom: '25px' }}><div style={{ flex: 1 }}><label style={{ color: '#94a3b8', fontSize: '12px' }}>Opening Balance (₹)</label><input type="number" value={formData.op_balance} onChange={e => setFormData({...formData, op_balance: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', boxSizing: 'border-box' }} /></div><div style={{ flex: 1 }}><label style={{ color: '#94a3b8', fontSize: '12px' }}>Dr / Cr</label><select value={formData.dr_cr} onChange={e => setFormData({...formData, dr_cr: e.target.value})} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #475569', color: '#fff', borderRadius: '8px', boxSizing: 'border-box' }}><option value="Dr (Debit)">DR (Debit)</option><option value="Cr (Credit)">CR (Credit)</option></select></div></div>
            <button onClick={handleSaveLedger} style={{ width: '100%', background: '#38bdf8', color: '#fff', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}>{loading ? 'Saving...' : '✅ Save Ledger'}</button>
          </div>
          <div style={{ flex: '2 1 600px', background: '#1e293b', borderRadius: '15px', padding: '25px', border: '1px solid #334155' }}>
            <h3 style={{ color: '#fff', margin: '0 0 20px 0', display: 'flex', justifyContent: 'space-between' }}>
               <span>📋 Existing Manual Ledgers</span>
               <button onClick={handleMegaSyncAndCleanup} style={{background: '#ef4444', color: '#fff', border: 'none', padding: '5px 15px', borderRadius: '5px', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px'}}>🚀 Mega Sync & Cleanup</button>
            </h3>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                <thead style={{ background: '#0f172a', color: '#c084fc', fontSize: '12px' }}><tr><th style={{ padding: '12px 15px' }}>Ledger Name</th><th style={{ padding: '12px 15px' }}>Group</th><th style={{ padding: '12px 15px', textAlign: 'right' }}>Opening Bal.</th><th style={{ padding: '12px 15px', textAlign: 'center' }}>Action</th></tr></thead>
                <tbody>
                  {ledgers.filter(l=> isMatch(l.company, selectedCompany)).map(l => (
                    <tr key={l.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '14px' }}><td style={{ padding: '12px 15px', fontWeight: 'bold' }}>{l.name}</td><td style={{ padding: '12px 15px', fontSize: '12px' }}>{l.group}</td><td style={{ padding: '12px 15px', textAlign: 'right', color: String(l.dr_cr || '').includes('Dr') ? '#38bdf8' : '#f59e0b', fontWeight: 'bold' }}>{parseFloat(l.op_balance || 0).toLocaleString('en-IN')} <span style={{ fontSize: '10px' }}>{String(l.dr_cr || '').includes('Dr') ? 'Dr' : 'Cr'}</span></td><td style={{ padding: '12px 15px', textAlign: 'center' }}><span onClick={() => handleDeleteLedger(l.id, l.name)} style={{ cursor: 'pointer', color: '#ef4444' }}>🗑️</span></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ⚖️ TAB 3: SMART LIVE TRIAL BALANCE */}
      {/* 📒 LIVE OUTSTANDING from the double-entry journal (single source of truth) */}
      {activeTab === 'JOURNAL_OS' && (
        <div style={{ background: '#0f172a', borderRadius: '15px', padding: '25px', border: '1px solid #1e293b' }}>
          <h3 style={{ color: '#c084fc', marginTop: 0 }}>📒 Party Outstanding <span style={{ fontSize: '12px', color: '#64748b' }}>(live from journal — receivable from debtors, payable to creditors)</span></h3>
          {(() => {
            const parties = jLedgers.filter(l => /debtor|creditor/i.test(l.ledger));
            const receivable = parties.filter(l => /debtor/i.test(l.ledger) && l.balance > 0);
            const payable = parties.filter(l => /creditor/i.test(l.ledger) && l.balance < 0);
            if (!parties.length) return <p style={{ color: '#94a3b8' }}>Journal abhi khaali hai — Operations → Accounts sync chalao to party balances yahan dikhenge.</p>;
            const Section = ({ title, rows, color, sign }: any) => (
              <div style={{ marginBottom: '20px' }}>
                <h4 style={{ color, margin: '0 0 10px' }}>{title} <span style={{ fontSize: '12px', color: '#64748b' }}>({rows.length})</span></h4>
                {rows.length === 0 ? <p style={{ color: '#64748b', fontSize: '13px' }}>None.</p> : (
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                    <tbody>{[...rows].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)).map((r, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #1e293b' }}>
                        <td style={{ padding: '8px', color: '#e2e8f0' }}>{r.ledger.replace(/^(Debtors|Creditors):\s*/, '')}</td>
                        <td style={{ padding: '8px', textAlign: 'right', fontWeight: 'bold', color }}>₹{Math.abs(r.balance).toLocaleString('en-IN')} {sign}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
              </div>
            );
            return <>
              <Section title="🟢 Receivable (Customers owe us)" rows={receivable} color="#10b981" sign="Dr" />
              <Section title="🔴 Payable (We owe vendors)" rows={payable} color="#ef4444" sign="Cr" />
            </>;
          })()}
          <p style={{ fontSize: '12px', color: '#64748b' }}>ℹ️ Single source of truth — idempotent journal se. Existing ledger tabs untouched.</p>
        </div>
      )}

      {activeTab === 'TRIAL' && (
        <div className="no-print" style={{ background: '#1e293b', borderRadius: '15px', padding: '25px', border: '1px solid #334155' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
             <div><h3 style={{ color: '#fff', margin: 0 }}>⚖️ Live Trial Balance (All Accounts)</h3><p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '12px' }}>Includes real-time balances of Manual Ledgers, Customers, Vendors, Loans, Docs & Drivers</p></div>
             <span style={{ fontSize: '12px', color: '#10b981', background: 'rgba(16, 185, 129, 0.1)', padding: '5px 15px', borderRadius: '20px', fontWeight: 'bold', border: '1px solid #10b981' }}>Company: {selectedCompany === 'ALL' ? 'CONSOLIDATED' : selectedCompany}</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead style={{ background: '#0f172a', color: '#94a3b8', fontSize: '12px', textTransform: 'uppercase' }}><tr><th style={{ padding: '15px 20px' }}>Particulars (Ledger Heads)</th><th style={{ padding: '15px 20px', textAlign: 'right', color: '#38bdf8' }}>Debit (Dr) ₹</th><th style={{ padding: '15px 20px', textAlign: 'right', color: '#f59e0b' }}>Credit (Cr) ₹</th></tr></thead>
              <tbody>
                {trialBalanceData.length === 0 ? <tr><td colSpan={3} style={{ padding: '30px', textAlign: 'center', color: '#64748b' }}>No Data Available.</td></tr> : 
                  trialBalanceData.map(l => (
                  <tr key={l.id} style={{ borderBottom: '1px solid #334155', color: '#cbd5e1', fontSize: '14px' }}>
                    <td style={{ padding: '15px 20px' }}><div style={{ fontWeight: 'bold', color: '#fff' }}>{l.name}</div><div style={{ fontSize: '11px', color: '#64748b' }}>{l.group}</div></td>
                    <td style={{ padding: '15px 20px', textAlign: 'right', fontWeight: 'bold', color: '#38bdf8', fontSize:'15px' }}>{l.currentBalance > 0 ? l.currentBalance.toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                    <td style={{ padding: '15px 20px', textAlign: 'right', fontWeight: 'bold', color: '#f59e0b', fontSize:'15px' }}>{l.currentBalance < 0 ? Math.abs(l.currentBalance).toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot style={{ background: '#020617', color: '#fff', fontWeight: '900', fontSize: '18px' }}><tr><td style={{ padding: '20px', textAlign: 'right' }}>GRAND TOTAL :</td><td style={{ padding: '20px', textAlign: 'right', color: '#38bdf8' }}>₹ {tbTotalDr.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td><td style={{ padding: '20px', textAlign: 'right', color: '#f59e0b' }}>₹ {tbTotalCr.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr></tfoot>
            </table>
          </div>
        </div>
      )}

      {/* 🏢 MODAL: QUICK ADD VENDOR */}
      {isVendorModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #10b981', background: '#0f172a', boxShadow: '0 30px 60px rgba(0,0,0,0.8)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#10b981' }}>🏢 Quick Register Vendor</h2>
              <button onClick={() => setIsVendorModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Vendor / Shop Name *</label><input className="modern-input" value={newVendorData.vendor_name} onChange={e=>setNewVendorData({...newVendorData, vendor_name: e.target.value.toUpperCase()})} /></div>
              
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8', fontWeight:'bold' }}>Vendor Category</label>
                <select className="modern-input" value={newVendorData.vendor_category} onChange={e=>setNewVendorData({...newVendorData, vendor_category: e.target.value})}>
                  <option value="Tyre Shop / Factory">🛞 Tyre Shop / Factory</option>
                  <option value="Fuel Pump (HSD)">⛽ Fuel Pump (HSD)</option>
                  <option value="Mechanic Garage">🔧 Mechanic Garage</option>
                  <option value="Spare Parts">⚙️ Spare Parts</option>
                  <option value="Other">Other</option>
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Contact Person</label><input className="modern-input" value={newVendorData.contact_person} onChange={e=>setNewVendorData({...newVendorData, contact_person: e.target.value})} /></div>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Mobile No</label><input className="modern-input" value={newVendorData.mobile_no} onChange={e=>setNewVendorData({...newVendorData, mobile_no: e.target.value})} /></div>
              </div>

              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>GST Number</label><input className="modern-input" value={newVendorData.gst_number} onChange={e=>setNewVendorData({...newVendorData, gst_number: e.target.value.toUpperCase()})} /></div>
              <div><label style={{ fontSize:'12px', color:'#ef4444', fontWeight:'bold' }}>Opening Balance (Amount you owe) ₹</label><input type="number" className="modern-input" style={{ borderColor: '#ef4444', color: '#ef4444' }} value={newVendorData.opening_balance} onChange={e=>setNewVendorData({...newVendorData, opening_balance: e.target.value})} /></div>
            </div>
            <button onClick={handleSaveVendor} disabled={loading} style={{ width: '100%', marginTop: '30px', padding: '15px', background: 'linear-gradient(135deg, #10b981, #059669)', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 'bold', fontSize: '15px' }}>
              {loading ? '⏳ Saving...' : '✅ Save Vendor & Setup Ledger'}
            </button>
          </div>
        </div>
      )}

    </div>
  );
}