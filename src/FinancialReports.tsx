// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from './firebase';
import { getJournal, ledgerBalances, reconcile } from './lib/accounting/journal';
import { getTripFreight, getTripExpense, round2, isDateInRange as inRange } from './lib/accounting/tripMath';
import { scopeCurrent } from './lib/rbac';
// 📊 IMPORTING CHARTS
import { PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, AreaChart, Area } from 'recharts';

// 🔥 UNIVERSAL AUTO-RECOVERY HELPER
const getVal = (obj: any, keysArr: string[], defaultVal = '') => {
  if(!obj) return defaultVal;
  for(const k of keysArr) {
    if(obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return defaultVal;
};

// 🌟 SMART MATCHING LOGIC
const isMatch = (recordVal: any, filterVal: string) => {
  if (!filterVal || filterVal === 'ALL') return true; 
  if (!recordVal || recordVal === 'ALL') return true; 
  return String(recordVal).trim().toUpperCase() === String(filterVal).trim().toUpperCase();
};

export default function FinancialReports() {
  const [activeTab, setActiveTab] = useState('PNL'); 
  const [loading, setLoading] = useState(false);

  // 🏢 DYNAMIC MASTER DATA STATES
  const [companies, setCompanies] = useState<string[]>(['Loading...']);
  const [branches, setBranches] = useState<string[]>(['Loading...']);
  const [vehicles, setVehicles] = useState<any[]>([]);

  // 🗄️ REAL DATABASE STATES
  const [trips, setTrips] = useState<any[]>([]);
  const [loans, setLoans] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]);
  const [vendors, setVendors] = useState<any[]>([]);
  const [ledgers, setLedgers] = useState<any[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<any[]>([]);
  const [bankTxns, setBankTxns] = useState<any[]>([]);

  // 📒 Live double-entry JOURNAL (single source of truth, additive — does not
  // alter the existing P&L/Balance Sheet logic).
  const [jBal, setJBal] = useState<any[]>([]);
  const [jMeta, setJMeta] = useState<any>({ count: 0, balanced: true, findings: [] });
  useEffect(() => {
    ledgerBalances().then(setJBal).catch(() => setJBal([]));
    reconcile().then(setJMeta).catch(() => {});
  }, []);

  // 🎛️ SMART FILTERS & DATES
  const [selectedCompany, setSelectedCompany] = useState('ALL'); 
  const [selectedBranch, setSelectedBranch] = useState('ALL');
  const [selectedVehicle, setSelectedVehicle] = useState('ALL');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // 🌟 EXPANDABLE ACCORDION STATES
  const [expandedSections, setExpandedSections] = useState<any>({
      dirExp: true, 
      dirInc: true,
      bsCap: true,
      bsLoan: true,
      bsCurLiab: true,
      bsFixed: true,
      bsCurAss: true,
      bsBank: true
  });

  const toggleSection = (section: string) => {
      setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  useEffect(() => {
    fetchMasterData();
    fetchRealSystemData();
  }, []);

  const fetchMasterData = async () => {
    setLoading(true);
    try {
      const cSnap1 = await getDocs(collection(db, "COMPANY")).catch(() => ({ docs: [] }));
      const cSnap2 = await getDocs(collection(db, "COMPANIES")).catch(() => ({ docs: [] }));
      let compList = [...cSnap1.docs, ...cSnap2.docs].map(d => d.data().company_name || d.data().name || d.data().Company_Name);
      compList = [...new Set(compList.filter(Boolean))];
      setCompanies(compList);

      const bSnap = await getDocs(collection(db, "BRANCH")).catch(() => ({ docs: [] }));
      let branchList = bSnap.docs.map(d => d.data().branch_name || d.data().name);
      branchList = [...new Set(branchList.filter(Boolean))];
      setBranches(branchList);

      const vSnap = await getDocs(collection(db, "VEHICLES")).catch(() => ({ docs: [] }));
      const vehList = vSnap.docs.map(d => ({ 
          id: d.id, 
          no: d.data().vehical_no || d.data().vehicle_no, 
          company: d.data().company_name || d.data().Company_Name || d.data().company || 'ALL' 
      }));
      setVehicles(vehList.filter(v => v.no));
    } catch (error) { console.error(error); }
    setLoading(false);
  };

  const fetchRealSystemData = async () => {
    try {
       // All collections in parallel (was 8 sequential round trips)
       const [tSnap, lSnap1, lSnap2, cSnap, vSnap, ledSnap, leSnap, bSnap] = await Promise.all([
         getDocs(collection(db, "TRIPS")).catch(()=>({docs:[]})),
         getDocs(collection(db, "LOAN_MASTER")).catch(()=>({docs:[]})),
         getDocs(collection(db, "LOANS")).catch(()=>({docs:[]})),
         getDocs(collection(db, "CUSTOMERS")).catch(()=>({docs:[]})),
         getDocs(collection(db, "VENDORS")).catch(()=>({docs:[]})),
         getDocs(collection(db, "LEDGERS")).catch(()=>({docs:[]})),
         getDocs(collection(db, "LEDGER_ENTRIES")).catch(()=>({docs:[]})),
         getDocs(collection(db, "BANK_TRANSACTIONS")).catch(()=>({docs:[]})),
       ]);
       // 🔐 RBAC scope — same as Dashboard, so a branch-scoped user sees the
       // same Revenue on both screens (and stops seeing other branches' money).
       setTrips(scopeCurrent(tSnap.docs.map(d => ({id: d.id, ...d.data()}))) || []);
       setLoans([...lSnap1.docs, ...lSnap2.docs].map(d => ({id: d.id, ...d.data()})));
       setCustomers(cSnap.docs.map(d => ({id: d.id, ...d.data()})));
       setVendors(vSnap.docs.map(d => ({id: d.id, ...d.data()})));
       setLedgers(ledSnap.docs.map(d => ({id: d.id, ...d.data()})));
       setLedgerEntries(leSnap.docs.map(d => ({id: d.id, ...d.data()})));
       setBankTxns(bSnap.docs.map(d => ({id: d.id, ...d.data()})));
    } catch(e) { console.error(e); }
  };

  const handlePrint = () => window.print();
  const clearDates = () => { setFromDate(''); setToDate(''); };

  // Normalized date filtering (handles DD-MM-YYYY, ISO, Firestore Timestamp) —
  // the old lexical string compare silently mis-filtered mixed-format rows.
  const isDateInRange = (dateVal: any) => inRange(dateVal, fromDate || undefined, toDate || undefined);

  // ==========================================
  // 📈 PNL CALCULATIONS & DETAILED BREAKDOWN
  // ==========================================
  let directIncomes = 0; 
  let directExpenses = 0; 
  let indirectIncomes = 0; 
  let indirectExpenses = 0; 

  const dirExpBreakdown: any = { 'Fuel (Diesel/Petrol)': 0, 'Driver Bhatta/Salary': 0, 'Toll & Fastag': 0, 'Vehicle Compliance & RTO': 0, 'Other Direct Exp': 0 };
  const dirIncBreakdown: any = { 'Trip Freight Revenue': 0, 'Other Direct Incomes': 0 };
  const indExpBreakdown: any = { 'Office Rent & Utilities': 0, 'Staff Salary': 0, 'Misc Indirect Exp': 0 };
  const indIncBreakdown: any = { 'Discount Received': 0, 'Misc Indirect Inc': 0 };

  trips.forEach(t => {
     const tDate = getVal(t, ['Loading_Date', 'start_date', 'loading_date', 'date']);
     if (!isDateInRange(tDate)) return;
     if (!isMatch(getVal(t, ['Operating_Company', 'operating_company', 'company']), selectedCompany)) return;
     if (!isMatch(getVal(t, ['Branch', 'branch']), selectedBranch)) return;
     if (!isMatch(getVal(t, ['Vehicle_No', 'vehicle_no', 'vehical_no']), selectedVehicle)) return;

     // 💰 Canonical trip math — identical helpers to the Finance Hub, so both
     // screens always report the same Revenue/Expense for the same trip.
     const freightAmt = getTripFreight(t);
     directIncomes = round2(directIncomes + freightAmt);
     dirIncBreakdown['Trip Freight Revenue'] += freightAmt;

     // Breakdown lines are capped so they always sum EXACTLY to the canonical
     // trip expense (legacy rows sometimes carry component fields that exceed
     // total_expense). Note: driver_advance is deliberately NOT an expense —
     // advances are recoverable khata, not P&L.
     const te = getTripExpense(t);
     const fuelRaw = parseFloat(getVal(t, ['diesel_amount', 'fuel_amount', 'diesel'], '0')) || 0;
     const tollRaw = parseFloat(getVal(t, ['toll_amount', 'toll', 'fastag'], '0')) || 0;
     const bhattaRaw = parseFloat(getVal(t, ['driver_bhatta', 'bhatta'], '0')) || 0;
     const fuel = Math.min(fuelRaw, te);
     const toll = Math.min(tollRaw, Math.max(0, te - fuel));
     const bhatta = Math.min(bhattaRaw, Math.max(0, te - fuel - toll));
     const otherExp = round2(Math.max(0, te - fuel - toll - bhatta));

     directExpenses = round2(directExpenses + te);
     dirExpBreakdown['Fuel (Diesel/Petrol)'] += fuel;
     dirExpBreakdown['Toll & Fastag'] += toll;
     dirExpBreakdown['Driver Bhatta/Salary'] += bhatta;
     if(otherExp > 0) dirExpBreakdown['Other Direct Exp'] += otherExp;
  });

  ledgers.forEach(l => {
     if (!isMatch(l.company, selectedCompany)) return;
     if (!isMatch(l.branch, selectedBranch)) return;

     if (selectedVehicle !== 'ALL' && l.linked_module === 'VEHICLE_DOCS') {
         const linkedVeh = vehicles.find(v => v.id === l.linked_id);
         if (!linkedVeh || !isMatch(linkedVeh.no, selectedVehicle)) return;
     } else if (selectedVehicle !== 'ALL') {
         return; 
     }

     ledgerEntries.forEach(e => {
        if(e.ledgerId === l.id && isDateInRange(e.date)) {
           if (!isMatch(e.company, selectedCompany) || !isMatch(e.branch, selectedBranch)) return;
           
           const amt = parseFloat(e.amount || '0');
           if (l.group === 'Direct Incomes (Freight/Trip Revenue)') {
              if (String(e.dr_cr).includes('Cr')) { directIncomes += amt; dirIncBreakdown['Other Direct Incomes'] += amt; } 
              else { directIncomes -= amt; dirIncBreakdown['Other Direct Incomes'] -= amt; }
           } else if (l.group === 'Indirect Incomes') {
              if (String(e.dr_cr).includes('Cr')) { indirectIncomes += amt; indIncBreakdown['Misc Indirect Inc'] += amt; } 
              else { indirectIncomes -= amt; indIncBreakdown['Misc Indirect Inc'] -= amt; }
           } else if (l.group === 'Direct Expenses (Fuel, Toll, Driver Bhatta)' || l.group === 'Direct Expenses (Vehicle Compliance & Docs)') {
              if (String(e.dr_cr).includes('Dr')) { 
                  directExpenses += amt; 
                  if(l.group.includes('Compliance')) dirExpBreakdown['Vehicle Compliance & RTO'] += amt;
                  else dirExpBreakdown['Other Direct Exp'] += amt;
              } else { 
                  directExpenses -= amt; 
                  if(l.group.includes('Compliance')) dirExpBreakdown['Vehicle Compliance & RTO'] -= amt;
                  else dirExpBreakdown['Other Direct Exp'] -= amt;
              }
           } else if (l.group === 'Indirect Expenses (Office Rent, Salary)') {
              if (String(e.dr_cr).includes('Dr')) { indirectExpenses += amt; indExpBreakdown['Misc Indirect Exp'] += amt; } 
              else { indirectExpenses -= amt; indExpBreakdown['Misc Indirect Exp'] -= amt; }
           }
        }
     });
  });

  const pnlData = {
    incomes: { direct: { label: 'Direct Incomes (Freight & Ops)', amount: directIncomes, details: dirIncBreakdown }, indirect: { label: 'Indirect Incomes (Discounts/Misc)', amount: indirectIncomes, details: indIncBreakdown } },
    expenses: { direct: { label: 'Direct Expenses (Fuel, Toll, RTO)', amount: directExpenses, details: dirExpBreakdown }, indirect: { label: 'Indirect Expenses (Office/Staff)', amount: indirectExpenses, details: indExpBreakdown } }
  };

  const grossProfit = pnlData.incomes.direct.amount - pnlData.expenses.direct.amount;
  const netProfit = (grossProfit + pnlData.incomes.indirect.amount) - pnlData.expenses.indirect.amount;

  // ==========================================
  // ⚖️ BALANCE SHEET CALCULATIONS
  // ==========================================
  let capitalAcc = 0; let fixedAssets = 0; let totalLoans = 0; let sundryDebtors = 0; let sundryCreditors = 0; let bankBalances = 0;
  
  const creditorsBreakdown: any = { 'Vendors/Suppliers': 0, 'Drivers/Staff': 0, 'Other Creditors': 0 };
  const debtorsBreakdown: any = { 'Customers (Market)': 0, 'Other Debtors': 0 };
  const bankBreakdown: any = {};

  ledgers.forEach(l => {
     if (!isMatch(l.company, selectedCompany) || !isMatch(l.branch, selectedBranch)) return;
     if (selectedVehicle !== 'ALL') return; 

     const bal = parseFloat(l.op_balance || '0');
     const isOpDr = String(l.dr_cr || '').includes('Dr');
     let currentBalance = isOpDr ? bal : -bal; 

     ledgerEntries.forEach(e => {
        if(e.ledgerId === l.id && isDateInRange(e.date)) {
           if (!isMatch(e.company, selectedCompany) || !isMatch(e.branch, selectedBranch)) return;
           const amt = parseFloat(e.amount || '0');
           if (String(e.dr_cr).includes('Dr')) currentBalance += amt; else currentBalance -= amt;
        }
     });

     if (l.group === 'Capital Account') capitalAcc += Math.abs(currentBalance);
     if (l.group === 'Fixed Assets (Trucks, Office)') fixedAssets += Math.abs(currentBalance);
     if (l.group === 'Sundry Debtors (Customers)') { sundryDebtors += Math.abs(currentBalance); debtorsBreakdown['Other Debtors'] += Math.abs(currentBalance); }
     if (l.group === 'Sundry Creditors (Vendors)') { sundryCreditors += Math.abs(currentBalance); creditorsBreakdown['Other Creditors'] += Math.abs(currentBalance); }
     if (l.group === 'Current Assets' || l.group === 'Cash & Bank') { bankBalances += currentBalance; bankBreakdown[l.name || 'Bank'] = currentBalance; }
  });

  customers.forEach(c => {
     if (!isMatch(c.company, selectedCompany)) return;
     if (selectedVehicle !== 'ALL') return; 
     const cBal = parseFloat(c.opening_balance || c.op_balance || '0');
     sundryDebtors += cBal;
     debtorsBreakdown['Customers (Market)'] += cBal;
  });

  vendors.forEach(v => {
     if (!isMatch(v.company, selectedCompany)) return;
     if (selectedVehicle !== 'ALL') return; 
     const vBal = parseFloat(v.current_balance || v.opening_balance || '0');
     sundryCreditors += vBal;
     creditorsBreakdown['Vendors/Suppliers'] += vBal;
  });

  loans.forEach(l => {
     const status = getVal(l, ['Payment_Status', 'status', 'payment_status']);
     if (status !== 'CLOSED') {
        const vNo = getVal(l, ['Vehicle_No', 'vehicle_no', 'vehical_no']);
        if (selectedVehicle !== 'ALL' && !isMatch(vNo, selectedVehicle)) return;
        const linkedVeh = vehicles.find(v => isMatch(v.no, vNo));
        const vehCompany = linkedVeh ? linkedVeh.company : 'ALL';
        if (selectedCompany !== 'ALL' && !isMatch(vehCompany, selectedCompany)) return;

        totalLoans += parseFloat(getVal(l, ['Remaining_Principal', 'remaining_principal', 'Principal_Amt', 'balance'], '0'));
        if (selectedVehicle !== 'ALL') fixedAssets += parseFloat(getVal(l, ['Principal_Amt', 'principal_amt', 'loan_amount'], '0')); 
     }
  });

  bankTxns.forEach(t => {
     if (!isDateInRange(t.date) || !isMatch(t.company, selectedCompany) || !isMatch(t.branch, selectedBranch)) return;
     if (selectedVehicle !== 'ALL') return; 
     const amt = parseFloat(t.amount || '0');
     if (t.type === 'Receipt (IN)') { bankBalances += amt; bankBreakdown[t.bank_account || 'Bank'] = (bankBreakdown[t.bank_account || 'Bank'] || 0) + amt; }
     else if (t.type === 'Payment (OUT)') { bankBalances -= amt; bankBreakdown[t.bank_account || 'Bank'] = (bankBreakdown[t.bank_account || 'Bank'] || 0) - amt; }
  });

  const bsData = {
    liabilities: { 
      capital: { label: 'Capital Account', amount: capitalAcc, details: {'Owners Capital': capitalAcc} }, 
      loans: { label: 'Secured Loans (Vehicle EMIs)', amount: totalLoans, details: {'Vehicle Finance/EMIs': totalLoans} }, 
      current: { label: 'Sundry Creditors & Payables', amount: sundryCreditors, details: creditorsBreakdown }, 
      pnl: { label: 'Profit & Loss A/c', amount: netProfit, details: {'Current Period Profit': netProfit} } 
    },
    assets: { 
      fixed: { label: 'Fixed Assets (Trucks, Office Eq.)', amount: fixedAssets, details: {'Purchased Assets': fixedAssets} }, 
      current: { label: 'Sundry Debtors (Customers)', amount: sundryDebtors, details: debtorsBreakdown }, 
      bank: { label: 'Cash & Bank Balances', amount: bankBalances, details: Object.keys(bankBreakdown).length > 0 ? bankBreakdown : {'Liquid Cash/Bank Accounts': bankBalances} } 
    }
  };

  const totalLiabilities = Object.values(bsData.liabilities).reduce((acc, curr) => acc + curr.amount, 0);
  const totalAssets = Object.values(bsData.assets).reduce((acc, curr) => acc + curr.amount, 0);

  // CHARTS DATA
  const pnlChartData = [
      { name: 'Income', Value: directIncomes + indirectIncomes, fill: '#10b981' },
      { name: 'Expenses', Value: directExpenses + indirectExpenses, fill: '#ef4444' }
  ];

  const bsPieData = [
      { name: 'Fixed Assets', value: fixedAssets, color: '#8b5cf6' },
      { name: 'Current Assets (Debtors/Bank)', value: sundryDebtors + bankBalances, color: '#38bdf8' },
      { name: 'Current Liabilities (Creditors)', value: sundryCreditors, color: '#f59e0b' },
      { name: 'Long-term Liabilities (Loans)', value: totalLoans, color: '#ec4899' }
  ].filter(d => d.value > 0);

  const handleDownloadExcel = () => {
    let csv = `Company: ${selectedCompany}\nReport: ${activeTab === 'PNL' ? 'Profit & Loss Account' : 'Balance Sheet'}\nPeriod: ${fromDate ? new Date(fromDate).toLocaleDateString('en-GB') : 'Start'} to ${toDate ? new Date(toDate).toLocaleDateString('en-GB') : 'Today'}\n\n`;
    
    if (activeTab === 'PNL') {
      csv += `Expenses (Dr.),Amount (Rs.),Incomes (Cr.),Amount (Rs.)\n`;
      csv += `Direct Expenses,,Direct Incomes,\n`;
      csv += `"${pnlData.expenses.direct.label}",${pnlData.expenses.direct.amount},"${pnlData.incomes.direct.label}",${pnlData.incomes.direct.amount}\n`;
      csv += `"Gross Profit c/d",${grossProfit > 0 ? grossProfit : '0'},"Gross Loss c/d",${grossProfit < 0 ? Math.abs(grossProfit) : '0'}\n\n`;
      csv += `Indirect Expenses,,Indirect Incomes,\n`;
      csv += `"${pnlData.expenses.indirect.label}",${pnlData.expenses.indirect.amount},"${pnlData.incomes.indirect.label}",${pnlData.incomes.indirect.amount}\n`;
      csv += `"Net Profit",${netProfit > 0 ? netProfit : '0'},"Net Loss",${netProfit < 0 ? Math.abs(netProfit) : '0'}\n`;
    } else {
      csv += `Liabilities,Amount (Rs.),Assets,Amount (Rs.)\n`;
      csv += `"${bsData.liabilities.capital.label}",${bsData.liabilities.capital.amount},"${bsData.assets.fixed.label}",${bsData.assets.fixed.amount}\n`;
      csv += `"${bsData.liabilities.pnl.label}",${bsData.liabilities.pnl.amount},"${bsData.assets.current.label}",${bsData.assets.current.amount}\n`;
      csv += `"${bsData.liabilities.loans.label}",${bsData.liabilities.loans.amount},"${bsData.assets.bank.label}",${bsData.assets.bank.amount}\n`;
      csv += `"${bsData.liabilities.current.label}",${bsData.liabilities.current.amount},,\n`;
      csv += `TOTAL,${totalLiabilities},TOTAL,${totalAssets}\n`;
    }
    
    const a = document.createElement('a');
    a.href = window.URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${activeTab === 'PNL' ? 'Profit_Loss' : 'Balance_Sheet'}_${selectedCompany.replace(/ /g, '_')}.csv`;
    a.click();
  };

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px', background: 'radial-gradient(circle at top right, #0f172a, #020617)', minHeight: '100vh', padding: '30px' }}>
      
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .printable-area, .printable-area * { visibility: visible; color: black !important; }
          .printable-area { position: absolute; left: 0; top: 0; width: 100%; background: white !important; padding: 20px; }
          .no-print { display: none !important; }
          .glass-panel { background: white !important; border: none !important; box-shadow: none !important; padding: 0 !important; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          th, td { border: 1px solid #000 !important; padding: 8px !important; color: black !important; }
          th { background: #f0f0f0 !important; -webkit-print-color-adjust: exact; }
          h2, h3, p, div, span { color: black !important; }
          .expand-icon { display: none !important; }
          .details-row { display: table-row !important; } 
        }
        
        .modern-table { width: 100%; border-collapse: collapse; }
        .modern-table th { background: rgba(0,0,0,0.3); color: #94a3b8; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; padding: 15px; border-bottom: 2px solid #334155; }
        .modern-table td { padding: 12px 15px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #e2e8f0; font-size: 13px; }
        
        .expandable-row { cursor: pointer; transition: all 0.3s ease; background: rgba(15, 23, 42, 0.4); }
        .expandable-row:hover { background: rgba(56, 189, 248, 0.1); transform: translateX(2px); border-left: 3px solid #38bdf8; }
        
        .details-row { background: rgba(0,0,0,0.2); animation: fadeIn 0.3s ease-in-out; }
        .details-row td { padding: 8px 15px 8px 40px !important; color: #94a3b8; border-bottom: 1px solid rgba(255,255,255,0.02); }
        .details-row:hover { background: rgba(255,255,255,0.02); color: #fff; }

        .metric-card { background: rgba(30, 41, 59, 0.5); border: 1px solid rgba(255,255,255,0.05); border-radius: 12px; padding: 20px; display: flex; align-items: center; justify-content: center; flex-direction: column; box-shadow: 0 4px 20px rgba(0,0,0,0.3); transition: 0.3s; }
        .metric-card:hover { transform: translateY(-5px); box-shadow: 0 8px 25px rgba(0,0,0,0.5); border-color: rgba(56, 189, 248, 0.3); }

        @keyframes fadeIn { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>

      {/* HEADER SECTION */}
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '32px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px', fontWeight: '900', letterSpacing: '-0.5px' }}>
            📊 Financial Statements (CA Ready)
          </h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Real-Time Consolidated Profit & Loss Account and Balance Sheet</p>
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <button onClick={handleDownloadExcel} style={{ background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', border: '1px solid #10b981', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', transition: '0.3s' }}>
            📥 Export to Excel
          </button>
          <button onClick={handlePrint} style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#0f172a', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 5px 15px rgba(245,158,11,0.4)', transition: '0.3s' }}>
            🖨️ Print Document
          </button>
        </div>
      </div>

      {/* 🏢 SMART FILTERS & DATES */}
      <div className="no-print" style={{ background: 'rgba(15, 23, 42, 0.6)', border: '1px solid rgba(51, 65, 85, 0.5)', padding: '20px', borderRadius: '12px', marginBottom: '25px', display: 'flex', gap: '15px', flexWrap: 'wrap', boxShadow: '0 10px 30px rgba(0,0,0,0.5)' }}>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ color: '#38bdf8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>Company Focus *</label>
          <select value={selectedCompany} onChange={e => setSelectedCompany(e.target.value)} style={{ width: '100%', padding: '12px', background: '#020617', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold', appearance: 'none' }}>
            <option value="ALL">-- All Companies (Consolidated) --</option>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>Branch Level</label>
          <select value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)} style={{ width: '100%', padding: '12px', background: '#020617', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', appearance: 'none' }}>
            <option value="ALL">-- All Branches (Consolidated) --</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ color: '#10b981', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>Vehicle / Fleet Level</label>
          {/* 🌟 SMART SEARCH DROPDOWN FOR VEHICLE */}
          <input 
            list="vehicle-search-list"
            placeholder="Search Vehicle... (Empty = ALL)"
            value={selectedVehicle === 'ALL' ? '' : selectedVehicle} 
            onChange={e => setSelectedVehicle(e.target.value.toUpperCase() || 'ALL')} 
            style={{ width: '100%', padding: '12px', background: '#020617', border: '1px solid #10b981', color: '#10b981', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold', boxSizing: 'border-box' }} 
          />
          <datalist id="vehicle-search-list">
            {vehicles.map((v, i) => <option key={i} value={v.no}>{v.no}</option>)}
          </datalist>
        </div>
        
        {/* 📅 DATE FILTERS */}
        <div style={{ flex: '0.8', minWidth: '150px' }}>
          <label style={{ color: '#f59e0b', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>From Date</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} style={{ width: '100%', padding: '12px', background: '#020617', border: '1px solid #475569', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', colorScheme: 'dark', boxSizing: 'border-box' }} />
        </div>
        <div style={{ flex: '0.8', minWidth: '150px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
             <label style={{ color: '#f59e0b', fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>To Date</label>
             {(fromDate || toDate) && <span onClick={clearDates} style={{ color: '#ef4444', fontSize: '11px', cursor: 'pointer', fontWeight: 'bold', background: 'rgba(239, 68, 68, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>Clear</span>}
          </div>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} style={{ width: '100%', padding: '12px', background: '#020617', border: '1px solid #475569', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', colorScheme: 'dark', boxSizing: 'border-box' }} />
        </div>
      </div>

      {/* MODULE TABS */}
      <div className="no-print" style={{ display: 'flex', gap: '15px', marginBottom: '25px', paddingBottom: '10px' }}>
        <button onClick={() => setActiveTab('PNL')} style={{ padding: '12px 25px', background: activeTab === 'PNL' ? 'rgba(56, 189, 248, 0.15)' : 'rgba(30, 41, 59, 0.5)', color: activeTab === 'PNL' ? '#38bdf8' : '#94a3b8', border: '1px solid', borderColor: activeTab === 'PNL' ? '#38bdf8' : '#334155', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', transition: 'all 0.3s ease', borderRadius: '8px', boxShadow: activeTab === 'PNL' ? '0 0 15px rgba(56, 189, 248, 0.3)' : 'none' }}>
          📊 Statement of Profit & Loss
        </button>
        <button onClick={() => setActiveTab('BS')} style={{ padding: '12px 25px', background: activeTab === 'BS' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(30, 41, 59, 0.5)', color: activeTab === 'BS' ? '#10b981' : '#94a3b8', border: '1px solid', borderColor: activeTab === 'BS' ? '#10b981' : '#334155', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', transition: 'all 0.3s ease', borderRadius: '8px', boxShadow: activeTab === 'BS' ? '0 0 15px rgba(16, 185, 129, 0.3)' : 'none' }}>
          ⚖️ Balance Sheet Position
        </button>
        <button onClick={() => setActiveTab('JOURNAL')} style={{ padding: '12px 25px', background: activeTab === 'JOURNAL' ? 'rgba(192, 132, 252, 0.15)' : 'rgba(30, 41, 59, 0.5)', color: activeTab === 'JOURNAL' ? '#c084fc' : '#94a3b8', border: '1px solid', borderColor: activeTab === 'JOURNAL' ? '#c084fc' : '#334155', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', borderRadius: '8px' }}>
          📒 Live Journal {jMeta.count > 0 && <span style={{fontSize:'11px'}}>({jMeta.count})</span>}
        </button>
      </div>

      {/* 📒 LIVE JOURNAL — single source of truth (double-entry). Additive view. */}
      {activeTab === 'JOURNAL' && (
        <div className="glass-panel" style={{ background: '#0f172a', borderRadius: '15px', padding: '30px', border: '1px solid #1e293b' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '20px' }}>
            <h3 style={{ margin: 0, color: '#c084fc' }}>📒 Live Ledger Balances <span style={{ fontSize: '12px', color: '#64748b' }}>(from double-entry journal)</span></h3>
            <span className={`pt-pill ${jMeta.balanced ? 'pt-pill--completed' : 'pt-pill--pending-unload'}`}>{jMeta.count} entries · {jMeta.balanced ? 'Balanced' : `${jMeta.findings?.length} flagged`}</span>
          </div>
          {jBal.length === 0 ? (
            <p style={{ color: '#94a3b8' }}>Journal abhi khaali hai. Operations → Accounts sync chalao (backfill) tab balances yahan dikhenge.</p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead><tr style={{ color: '#94a3b8', textAlign: 'left', borderBottom: '2px solid #334155' }}>
                  <th style={{ padding: '10px' }}>Ledger</th><th style={{ padding: '10px', textAlign: 'right', color: '#38bdf8' }}>Debit ₹</th><th style={{ padding: '10px', textAlign: 'right', color: '#f59e0b' }}>Credit ₹</th><th style={{ padding: '10px', textAlign: 'right' }}>Balance ₹</th>
                </tr></thead>
                <tbody>
                  {[...jBal].sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)).map((b, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #1e293b' }}>
                      <td style={{ padding: '10px', color: '#e2e8f0' }}>{b.ledger}</td>
                      <td style={{ padding: '10px', textAlign: 'right', color: '#38bdf8' }}>{b.dr ? `₹${b.dr.toLocaleString('en-IN')}` : '-'}</td>
                      <td style={{ padding: '10px', textAlign: 'right', color: '#f59e0b' }}>{b.cr ? `₹${b.cr.toLocaleString('en-IN')}` : '-'}</td>
                      <td style={{ padding: '10px', textAlign: 'right', fontWeight: 'bold', color: b.balance >= 0 ? '#10b981' : '#ef4444' }}>₹{Math.abs(b.balance).toLocaleString('en-IN')} {b.balance >= 0 ? 'Dr' : 'Cr'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p style={{ marginTop: '15px', fontSize: '12px', color: '#64748b' }}>ℹ️ Ye live double-entry journal se aate hain (idempotent, duplicate-proof). P&L/Balance Sheet upar waise ke waise — ye additive view hai.</p>
        </div>
      )}

      {/* 🖨️ PRINTABLE AREA STARTS HERE */}
      <div className="printable-area glass-panel" style={{ background: '#0f172a', borderRadius: '15px', padding: '30px', border: '1px solid #1e293b', boxShadow: '0 20px 40px rgba(0,0,0,0.5)' }}>
        
        {/* REPORT HEADER */}
        <div style={{ textAlign: 'center', marginBottom: '40px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '25px' }}>
          <h2 style={{ margin: '0 0 8px 0', color: '#fff', fontSize: '28px', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: '900' }}>
            {selectedCompany === 'ALL' ? 'CONSOLIDATED FINANCIAL REPORT' : selectedCompany}
          </h2>
          {selectedBranch !== 'ALL' && <div style={{ color: '#94a3b8', fontSize: '15px', marginBottom: '8px', fontWeight: 'bold' }}>Branch Location: {selectedBranch}</div>}
          
          <h3 style={{ margin: '15px 0 8px 0', color: activeTab === 'PNL' ? '#38bdf8' : '#10b981', fontSize: '20px', letterSpacing: '1px' }}>
            {activeTab === 'PNL' ? 'STATEMENT OF PROFIT & LOSS (INCOME STATEMENT)' : 'BALANCE SHEET (STATEMENT OF FINANCIAL POSITION)'}
          </h3>
          
          <p style={{ margin: 0, color: '#f59e0b', fontSize: '14px', fontWeight: 'bold', display: 'inline-block', background: 'rgba(245, 158, 11, 0.1)', padding: '5px 15px', borderRadius: '20px' }}>
            Period: {fromDate ? new Date(fromDate).toLocaleDateString('en-GB') : 'Start of Business'} to {toDate ? new Date(toDate).toLocaleDateString('en-GB') : 'Present Day'}
          </p>

          {selectedVehicle !== 'ALL' && (
            <div style={{ marginTop: '20px' }}>
               <span style={{ display: 'inline-flex', alignItems: 'center', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', padding: '8px 25px', borderRadius: '30px', border: '1px solid #10b981', fontWeight: 'bold', fontSize: '13px', letterSpacing: '1px' }}>
                 🚛 Dedicated Vehicle Tracking: {selectedVehicle}
               </span>
            </div>
          )}
        </div>

        {loading ? (
           <div style={{ textAlign: 'center', color: '#38bdf8', padding: '80px', fontSize: '18px', fontWeight: 'bold' }}>
             <span style={{ fontSize: '30px', display: 'block', marginBottom: '10px' }}>⏳</span>
             Compiling Real-Time Financials...
           </div>
        ) : (
          <>
            {/* 📊 TAB 1: PROFIT & LOSS A/C */}
            {activeTab === 'PNL' && (
              <>
                {/* SMART CHARTS & METRICS (No Print) */}
                <div className="no-print" style={{ display: 'flex', gap: '25px', marginBottom: '40px', flexWrap: 'wrap' }}>
                   
                   {/* Main Metric Card */}
                   <div className="metric-card" style={{ flex: '1 1 250px', background: netProfit >= 0 ? 'linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(5, 150, 105, 0.2))' : 'linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(185, 28, 28, 0.2))', borderColor: netProfit >= 0 ? '#10b981' : '#ef4444' }}>
                       <p style={{ margin: '0 0 10px 0', color: '#e2e8f0', fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 'bold' }}>Net Result for Period</p>
                       <h1 style={{ margin: '0', color: netProfit >= 0 ? '#10b981' : '#ef4444', fontSize: '48px', fontWeight: '900', textShadow: '0 2px 10px rgba(0,0,0,0.5)' }}>
                          ₹{Math.abs(netProfit).toLocaleString('en-IN', {minimumFractionDigits: 2})}
                       </h1>
                       <div style={{ marginTop: '15px', padding: '5px 15px', borderRadius: '20px', background: netProfit >= 0 ? '#10b981' : '#ef4444', color: '#fff', fontSize: '12px', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                          {netProfit >= 0 ? '📈 Profit Generated' : '📉 Loss Incurred'}
                       </div>
                   </div>

                   {/* Chart Card */}
                   <div className="metric-card" style={{ flex: '2 1 400px', height: '250px', padding: '15px', alignItems: 'stretch' }}>
                     <h4 style={{ color: '#94a3b8', textAlign: 'center', margin: '0 0 10px 0', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>Revenue vs Expenses Comparison</h4>
                     <ResponsiveContainer width="100%" height="100%">
                       <BarChart data={pnlChartData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }} barSize={60}>
                         <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                         <XAxis dataKey="name" stroke="#94a3b8" tick={{ fill: '#cbd5e1', fontSize: 12, fontWeight: 'bold' }} axisLine={false} tickLine={false} />
                         <Tooltip cursor={{ fill: 'rgba(255,255,255,0.05)' }} contentStyle={{ background: 'rgba(15, 23, 42, 0.9)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '8px', backdropFilter: 'blur(10px)' }} />
                         <Bar dataKey="Value" radius={[6, 6, 0, 0]}>
                            {pnlChartData.map((entry, index) => <Cell key={`cell-${index}`} fill={entry.fill} />)}
                         </Bar>
                       </BarChart>
                     </ResponsiveContainer>
                   </div>
                </div>

                <div style={{ display: 'flex', gap: '30px', flexWrap: 'wrap' }}>
                  
                  {/* DR. EXPENSES SIDE */}
                  <div style={{ flex: 1, minWidth: '350px' }}>
                    <h3 style={{ color: '#ef4444', margin: '0 0 15px 0', fontSize: '16px', display: 'flex', justifyContent: 'space-between', borderBottom: '2px solid #ef4444', paddingBottom: '10px' }}>
                      <span>DR. EXPENSES</span>
                      <span>₹ {pnlData.expenses.direct.amount + pnlData.expenses.indirect.amount}</span>
                    </h3>
                    
                    <table className="modern-table">
                      <tbody>
                        <tr><td colSpan={2} style={{ padding: '20px 15px 10px 15px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold', background: 'transparent' }}>Operational Costs</td></tr>
                        
                        <tr className="expandable-row" onClick={() => toggleSection('dirExp')}>
                           <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>
                              <span className="expand-icon" style={{marginRight:'10px', display:'inline-block', width:'12px', fontSize:'10px'}}>{expandedSections['dirExp'] ? '▼' : '▶'}</span>
                              {pnlData.expenses.direct.label}
                           </td>
                           <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>
                              {pnlData.expenses.direct.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}
                           </td>
                        </tr>
                        {expandedSections['dirExp'] && Object.keys(pnlData.expenses.direct.details).filter(k => pnlData.expenses.direct.details[k] !== 0).map(k => (
                           <tr key={k} className="details-row">
                             <td style={{ paddingLeft: '35px' }}>{k}</td>
                             <td style={{ textAlign: 'right' }}>{pnlData.expenses.direct.details[k].toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                           </tr>
                        ))}
                        
                        <tr style={{ background: 'rgba(16, 185, 129, 0.05)', borderTop: '2px solid rgba(255,255,255,0.1)' }}>
                          <td style={{ padding: '15px', fontWeight: '900', color: '#10b981', textTransform: 'uppercase', letterSpacing: '1px' }}>Gross Profit Carried Down (c/d)</td>
                          <td style={{ padding: '15px', textAlign: 'right', fontWeight: '900', color: '#10b981', fontSize: '16px' }}>{grossProfit > 0 ? grossProfit.toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                        </tr>

                        <tr><td colSpan={2} style={{ padding: '30px 15px 10px 15px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold', background: 'transparent' }}>Administrative Costs</td></tr>
                        
                        <tr className="expandable-row" onClick={() => toggleSection('indExp')}>
                           <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>
                              <span className="expand-icon" style={{marginRight:'10px', display:'inline-block', width:'12px', fontSize:'10px'}}>{expandedSections['indExp'] ? '▼' : '▶'}</span>
                              {pnlData.expenses.indirect.label}
                           </td>
                           <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>
                              {pnlData.expenses.indirect.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}
                           </td>
                        </tr>
                        {expandedSections['indExp'] && Object.keys(pnlData.expenses.indirect.details).filter(k => pnlData.expenses.indirect.details[k] !== 0).map(k => (
                           <tr key={k} className="details-row">
                             <td style={{ paddingLeft: '35px' }}>{k}</td>
                             <td style={{ textAlign: 'right' }}>{pnlData.expenses.indirect.details[k].toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                           </tr>
                        ))}
                        
                        <tr style={{ background: 'rgba(56, 189, 248, 0.05)', borderTop: '2px solid rgba(255,255,255,0.1)' }}>
                          <td style={{ padding: '20px 15px', fontWeight: '900', color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '1px' }}>Net Profit (Transferred to Capital)</td>
                          <td style={{ padding: '20px 15px', textAlign: 'right', fontWeight: '900', color: '#38bdf8', fontSize: '18px' }}>{netProfit > 0 ? netProfit.toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  {/* CR. INCOMES SIDE */}
                  <div style={{ flex: 1, minWidth: '350px' }}>
                    <h3 style={{ color: '#10b981', margin: '0 0 15px 0', fontSize: '16px', display: 'flex', justifyContent: 'space-between', borderBottom: '2px solid #10b981', paddingBottom: '10px' }}>
                      <span>CR. INCOMES & REVENUES</span>
                      <span>₹ {pnlData.incomes.direct.amount + pnlData.incomes.indirect.amount}</span>
                    </h3>

                    <table className="modern-table">
                      <tbody style={{ color: '#cbd5e1', fontSize: '14px' }}>
                        <tr><td colSpan={2} style={{ padding: '20px 15px 10px 15px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold', background: 'transparent' }}>Operating Revenue</td></tr>
                        
                        <tr className="expandable-row" onClick={() => toggleSection('dirInc')}>
                           <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>
                              <span className="expand-icon" style={{marginRight:'10px', display:'inline-block', width:'12px', fontSize:'10px'}}>{expandedSections['dirInc'] ? '▼' : '▶'}</span>
                              {pnlData.incomes.direct.label}
                           </td>
                           <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>
                              {pnlData.incomes.direct.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}
                           </td>
                        </tr>
                        {expandedSections['dirInc'] && Object.keys(pnlData.incomes.direct.details).filter(k => pnlData.incomes.direct.details[k] !== 0).map(k => (
                           <tr key={k} className="details-row">
                             <td style={{ paddingLeft: '35px' }}>{k}</td>
                             <td style={{ textAlign: 'right' }}>{pnlData.incomes.direct.details[k].toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                           </tr>
                        ))}
                        
                        <tr style={{ background: 'rgba(239, 68, 68, 0.05)', borderTop: '2px solid rgba(255,255,255,0.1)' }}>
                          <td style={{ padding: '15px', fontWeight: '900', color: '#ef4444', textTransform: 'uppercase', letterSpacing: '1px' }}>Gross Loss Carried Down (c/d)</td>
                          <td style={{ padding: '15px', textAlign: 'right', fontWeight: '900', color: '#ef4444', fontSize: '16px' }}>{grossProfit < 0 ? Math.abs(grossProfit).toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                        </tr>

                        <tr><td colSpan={2} style={{ padding: '30px 15px 10px 15px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold', background: 'transparent' }}>Other Incomes</td></tr>
                        
                        <tr className="expandable-row" onClick={() => toggleSection('indInc')}>
                           <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>
                              <span className="expand-icon" style={{marginRight:'10px', display:'inline-block', width:'12px', fontSize:'10px'}}>{expandedSections['indInc'] ? '▼' : '▶'}</span>
                              {pnlData.incomes.indirect.label}
                           </td>
                           <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>
                              {pnlData.incomes.indirect.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}
                           </td>
                        </tr>
                        {expandedSections['indInc'] && Object.keys(pnlData.incomes.indirect.details).filter(k => pnlData.incomes.indirect.details[k] !== 0).map(k => (
                           <tr key={k} className="details-row">
                             <td style={{ paddingLeft: '35px' }}>{k}</td>
                             <td style={{ textAlign: 'right' }}>{pnlData.incomes.indirect.details[k].toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                           </tr>
                        ))}
                        
                        <tr style={{ background: 'rgba(239, 68, 68, 0.05)', borderTop: '2px solid rgba(255,255,255,0.1)' }}>
                          <td style={{ padding: '20px 15px', fontWeight: '900', color: '#ef4444', textTransform: 'uppercase', letterSpacing: '1px' }}>Net Loss (Transferred to Capital)</td>
                          <td style={{ padding: '20px 15px', textAlign: 'right', fontWeight: '900', color: '#ef4444', fontSize: '18px' }}>{netProfit < 0 ? Math.abs(netProfit).toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            )}

            {/* ⚖️ TAB 2: BALANCE SHEET */}
            {activeTab === 'BS' && (
              <>
                {selectedVehicle !== 'ALL' && (
                  <div className="no-print" style={{ textAlign: 'center', padding: '15px', background: 'rgba(245, 158, 11, 0.1)', color: '#f59e0b', borderRadius: '10px', marginBottom: '25px', fontSize: '13px', border: '1px dashed #f59e0b', fontWeight: 'bold' }}>
                    ⚠️ Note: A Balance Sheet reflects the Company's overall financial position. When viewing for a specific Vehicle, only direct apportioned assets and liabilities (like Loan amount) will be shown. For accurate BS, select 'ALL Fleet'.
                  </div>
                )}

                {/* SMART CHARTS (No Print) */}
                <div className="no-print" style={{ display: 'flex', gap: '20px', marginBottom: '40px', flexWrap: 'wrap' }}>
                   
                   <div className="metric-card" style={{ flex: 1, minWidth: '300px', height: '280px', padding: '10px' }}>
                     <h4 style={{ color: '#94a3b8', textAlign: 'center', margin: '0 0 5px 0', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>Asset Distribution Portfolio</h4>
                     {bsPieData.filter(d => d.name.includes('Asset')).length === 0 ? <p style={{color:'#64748b', textAlign:'center', marginTop:'50px'}}>No Assets Logged</p> : (
                       <ResponsiveContainer width="100%" height="100%">
                         <PieChart>
                           <Pie data={bsPieData.filter(d => d.name.includes('Asset'))} cx="50%" cy="45%" innerRadius={50} outerRadius={80} paddingAngle={5} dataKey="value">
                             {bsPieData.filter(d => d.name.includes('Asset')).map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} stroke="none" />)}
                           </Pie>
                           <Tooltip contentStyle={{ background: 'rgba(15, 23, 42, 0.9)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '8px', backdropFilter: 'blur(10px)' }} />
                           <Legend verticalAlign="bottom" height={36} wrapperStyle={{ color: '#cbd5e1', fontSize: '11px', fontWeight: 'bold' }} />
                         </PieChart>
                       </ResponsiveContainer>
                     )}
                   </div>

                   <div className="metric-card" style={{ flex: 1, minWidth: '300px', height: '280px', padding: '10px' }}>
                     <h4 style={{ color: '#94a3b8', textAlign: 'center', margin: '0 0 5px 0', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>Liability & Debt Structure</h4>
                     {bsPieData.filter(d => d.name.includes('Liabilit')).length === 0 ? <p style={{color:'#64748b', textAlign:'center', marginTop:'50px'}}>No Liabilities Logged</p> : (
                       <ResponsiveContainer width="100%" height="100%">
                         <PieChart>
                           <Pie data={bsPieData.filter(d => d.name.includes('Liabilit'))} cx="50%" cy="45%" innerRadius={50} outerRadius={80} paddingAngle={5} dataKey="value">
                             {bsPieData.filter(d => d.name.includes('Liabilit')).map((entry, index) => <Cell key={`cell-${index}`} fill={entry.color} stroke="none" />)}
                           </Pie>
                           <Tooltip contentStyle={{ background: 'rgba(15, 23, 42, 0.9)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', borderRadius: '8px', backdropFilter: 'blur(10px)' }} />
                           <Legend verticalAlign="bottom" height={36} wrapperStyle={{ color: '#cbd5e1', fontSize: '11px', fontWeight: 'bold' }} />
                         </PieChart>
                       </ResponsiveContainer>
                     )}
                   </div>

                </div>

                <div style={{ display: 'flex', gap: '30px', flexWrap: 'wrap' }}>
                  
                  {/* LIABILITIES SIDE */}
                  <div style={{ flex: 1, minWidth: '350px' }}>
                    <h3 style={{ color: '#f59e0b', margin: '0 0 15px 0', fontSize: '16px', display: 'flex', justifyContent: 'space-between', borderBottom: '2px solid #f59e0b', paddingBottom: '10px' }}>
                      <span>CAPITAL & LIABILITIES</span>
                      <span>₹ {totalLiabilities.toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
                    </h3>

                    <table className="modern-table">
                      <tbody>
                        <tr><td colSpan={2} style={{ padding: '20px 15px 10px 15px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold', background: 'transparent' }}>Internal Equity</td></tr>
                        
                        <tr className="expandable-row" onClick={() => toggleSection('bsCap')}>
                           <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>
                              <span className="expand-icon" style={{marginRight:'10px', display:'inline-block', width:'12px', fontSize:'10px'}}>{expandedSections['bsCap'] ? '▼' : '▶'}</span>
                              {bsData.liabilities.capital.label}
                           </td>
                           <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>{bsData.liabilities.capital.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        </tr>
                        {expandedSections['bsCap'] && Object.keys(bsData.liabilities.capital.details).filter(k => bsData.liabilities.capital.details[k] !== 0).map(k => (
                           <tr key={k} className="details-row"><td style={{ paddingLeft: '35px' }}>{k}</td><td style={{ textAlign: 'right' }}>{bsData.liabilities.capital.details[k].toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        ))}

                        <tr>
                          <td style={{ padding: '15px', color: '#10b981', fontWeight: 'bold', background: 'rgba(16, 185, 129, 0.02)' }}>↳ Add: {bsData.liabilities.pnl.label}</td>
                          <td style={{ padding: '15px', textAlign: 'right', color: '#10b981', fontWeight: 'bold', background: 'rgba(16, 185, 129, 0.02)' }}>{bsData.liabilities.pnl.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        </tr>
                        
                        <tr><td colSpan={2} style={{ padding: '30px 15px 10px 15px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold', background: 'transparent' }}>External Liabilities</td></tr>

                        <tr className="expandable-row" onClick={() => toggleSection('bsLoan')}>
                           <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>
                              <span className="expand-icon" style={{marginRight:'10px', display:'inline-block', width:'12px', fontSize:'10px'}}>{expandedSections['bsLoan'] ? '▼' : '▶'}</span>
                              {bsData.liabilities.loans.label}
                           </td>
                           <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>{bsData.liabilities.loans.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        </tr>
                        {expandedSections['bsLoan'] && Object.keys(bsData.liabilities.loans.details).filter(k => bsData.liabilities.loans.details[k] !== 0).map(k => (
                           <tr key={k} className="details-row"><td style={{ paddingLeft: '35px' }}>{k}</td><td style={{ textAlign: 'right' }}>{bsData.liabilities.loans.details[k].toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        ))}

                        <tr className="expandable-row" onClick={() => toggleSection('bsCurLiab')}>
                           <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>
                              <span className="expand-icon" style={{marginRight:'10px', display:'inline-block', width:'12px', fontSize:'10px'}}>{expandedSections['bsCurLiab'] ? '▼' : '▶'}</span>
                              {bsData.liabilities.current.label}
                           </td>
                           <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>{bsData.liabilities.current.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        </tr>
                        {expandedSections['bsCurLiab'] && Object.keys(bsData.liabilities.current.details).filter(k => bsData.liabilities.current.details[k] !== 0).map(k => (
                           <tr key={k} className="details-row"><td style={{ paddingLeft: '35px' }}>{k}</td><td style={{ textAlign: 'right' }}>{bsData.liabilities.current.details[k].toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr style={{ background: 'rgba(255,255,255,0.05)', borderTop: '2px solid #94a3b8' }}>
                          <td style={{ padding: '20px 15px', fontWeight: '900', color: '#fff', fontSize: '18px', textTransform: 'uppercase', letterSpacing: '2px' }}>Total Liabilities</td>
                          <td style={{ padding: '20px 15px', textAlign: 'right', fontWeight: '900', color: '#fff', fontSize: '20px', letterSpacing: '1px' }}>₹ {totalLiabilities.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* ASSETS SIDE */}
                  <div style={{ flex: 1, minWidth: '350px' }}>
                    <h3 style={{ color: '#38bdf8', margin: '0 0 15px 0', fontSize: '16px', display: 'flex', justifyContent: 'space-between', borderBottom: '2px solid #38bdf8', paddingBottom: '10px' }}>
                      <span>ASSETS & PROPERTIES</span>
                      <span>₹ {totalAssets.toLocaleString('en-IN', {minimumFractionDigits: 2})}</span>
                    </h3>

                    <table className="modern-table">
                      <tbody style={{ color: '#cbd5e1', fontSize: '14px' }}>
                        <tr><td colSpan={2} style={{ padding: '20px 15px 10px 15px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold', background: 'transparent' }}>Non-Current Assets</td></tr>
                        
                        <tr className="expandable-row" onClick={() => toggleSection('bsFixed')}>
                           <td style={{ color: '#10b981', fontWeight: 'bold' }}>
                              <span className="expand-icon" style={{marginRight:'10px', display:'inline-block', width:'12px', fontSize:'10px'}}>{expandedSections['bsFixed'] ? '▼' : '▶'}</span>
                              {bsData.assets.fixed.label}
                           </td>
                           <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>{bsData.assets.fixed.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        </tr>
                        {expandedSections['bsFixed'] && Object.keys(bsData.assets.fixed.details).filter(k => bsData.assets.fixed.details[k] !== 0).map(k => (
                           <tr key={k} className="details-row"><td style={{ paddingLeft: '35px' }}>{k}</td><td style={{ textAlign: 'right' }}>{bsData.assets.fixed.details[k].toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        ))}

                        <tr><td colSpan={2} style={{ padding: '30px 15px 10px 15px', color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '2px', fontWeight: 'bold', background: 'transparent' }}>Current & Liquid Assets</td></tr>

                        <tr className="expandable-row" onClick={() => toggleSection('bsCurAss')}>
                           <td style={{ color: '#10b981', fontWeight: 'bold' }}>
                              <span className="expand-icon" style={{marginRight:'10px', display:'inline-block', width:'12px', fontSize:'10px'}}>{expandedSections['bsCurAss'] ? '▼' : '▶'}</span>
                              {bsData.assets.current.label}
                           </td>
                           <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>{bsData.assets.current.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        </tr>
                        {expandedSections['bsCurAss'] && Object.keys(bsData.assets.current.details).filter(k => bsData.assets.current.details[k] !== 0).map(k => (
                           <tr key={k} className="details-row"><td style={{ paddingLeft: '35px' }}>{k}</td><td style={{ textAlign: 'right' }}>{bsData.assets.current.details[k].toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        ))}

                        <tr className="expandable-row" onClick={() => toggleSection('bsBank')}>
                           <td style={{ color: '#10b981', fontWeight: 'bold' }}>
                              <span className="expand-icon" style={{marginRight:'10px', display:'inline-block', width:'12px', fontSize:'10px'}}>{expandedSections['bsBank'] ? '▼' : '▶'}</span>
                              {bsData.assets.bank.label}
                           </td>
                           <td style={{ textAlign: 'right', fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>{bsData.assets.bank.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        </tr>
                        {expandedSections['bsBank'] && Object.keys(bsData.assets.bank.details).filter(k => bsData.assets.bank.details[k] !== 0).map(k => (
                           <tr key={k} className="details-row"><td style={{ paddingLeft: '35px' }}>{k}</td><td style={{ textAlign: 'right' }}>{bsData.assets.bank.details[k].toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr style={{ background: 'rgba(255,255,255,0.05)', borderTop: '2px solid #94a3b8' }}>
                          <td style={{ padding: '20px 15px', fontWeight: '900', color: '#fff', fontSize: '18px', textTransform: 'uppercase', letterSpacing: '2px' }}>Total Assets</td>
                          <td style={{ padding: '20px 15px', textAlign: 'right', fontWeight: '900', color: '#fff', fontSize: '20px', letterSpacing: '1px' }}>₹ {totalAssets.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}