// @ts-nocheck
import React, { useState, useEffect } from 'react';
// 💸 LOAN & EMI — vehicle finance, live PostgreSQL (`loan_master` +
// `emi_payments`, migration 035).
//
// TWO THINGS CHANGED SHAPE, and both were wrong before.
//
// 1. AN EMI IS NOT ONE NUMBER. Principal repays the loan (a liability falling);
//    interest is a finance cost. This screen wrote ONE BANK_TRANSACTIONS row
//    for the total, so the books could never separate them and interest never
//    appeared as an expense at all. The API posts a three-leg JOURNAL — Dr the
//    loan, Dr Interest on Vehicle Loans, Cr the bank — through TARA.
//
// 2. THE COUNTERS MOVED IN THE BROWSER. remaining_principal / EMIs_Completed
//    were read here, adjusted, and written back across three separate writes.
//    Two people paying at once lost one payment with no trace. The API now
//    moves them inside the same transaction as the payment row, and
//    `v_loan_reconciliation` compares the stored figure against the recorded
//    payments so drift is visible instead of silent.
//    (The counters stay STORED, not derived — the 17 loans carry years of EMIs
//    paid before this system existed, so deriving would report debt already
//    repaid. Migration 035 sets out the reasoning.)
import { API_BASE } from './lib/apiBase';
import LoanLedgerStatement from './LoanLedgerStatement';
const API = API_BASE;
const ASSETS = `${API}/api/v1/assets`;
const MASTERS = `${API}/api/v1/masters`;
const FIN = `${API}/api/v1/finance`;
const LOANS_API = `${API}/api/v1/loans`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

// The ~1,400 lines of JSX below speak the Firestore-era PascalCase. Mapped once
// here rather than renamed throughout — the same deliberate, visible debt
// DRIVER.tsx and TripManagment.tsx carry.
const loanFromApi = (l: any) => ({
  ...l,
  Loan_Account_No: l.loan_account_no ?? '',
  Vehicle_No: l.vehicle_no ?? '',
  Owner_Name: l.owner_name ?? '',
  Company_Name: l.company_name ?? '',
  Loan_Type: l.loan_type ?? '',
  Bank_Name: l.bank_name ?? '',
  Sanction_Date: l.sanction_date ?? '',
  Rate_Of_Interest: l.rate_of_interest ?? '',
  Principal_Amt: l.principal_amt ?? 0,
  Tenure_Months: l.tenure_months ?? '',
  Moratorium_Months: l.moratorium_months ?? 0,
  EMI_Amount: l.emi_amount ?? 0,
  As_On_Date: l.as_on_date ?? '',
  EMIs_Completed: l.emis_completed ?? 0,
  Remaining_Principal: l.remaining_principal ?? 0,
  Total_Interest_Paid: l.total_interest_paid ?? 0,
  Payment_Status: l.payment_status ?? 'ACTIVE',
  emi_slabs: Array.isArray(l.emi_slabs) ? l.emi_slabs : [],
  repayment_schedule: Array.isArray(l.repayment_schedule) ? l.repayment_schedule : [],
});

const loanToApi = (f: any) => ({
  loan_account_no: f.Loan_Account_No || null,
  vehicle_no: f.Vehicle_No || null,
  owner_name: f.Owner_Name || null,
  company_name: f.Company_Name || null,
  loan_type: f.Loan_Type || null,
  bank_name: f.Bank_Name || null,
  sanction_date: f.Sanction_Date || null,
  rate_of_interest: parseFloat(f.Rate_Of_Interest) || 0,
  principal_amt: parseFloat(f.Principal_Amt) || 0,
  tenure_months: parseInt(f.Tenure_Months) || null,
  moratorium_months: parseInt(f.Moratorium_Months) || 0,
  emi_amount: parseFloat(f.EMI_Amount) || 0,
  as_on_date: f.As_On_Date || null,
  emis_completed: parseInt(f.Old_EMIs_Paid || f.EMIs_Completed || '0') || 0,
  remaining_principal: parseFloat(f.Remaining_Principal_As_On || f.Remaining_Principal || f.Principal_Amt) || 0,
  payment_status: f.Payment_Status || 'ACTIVE',
  emi_slabs: f.emi_slabs ?? [],
  repayment_schedule: f.repayment_schedule ?? [],
});

const paymentFromApi = (pmt: any) => ({
  ...pmt,
  _collection: 'emi_payments',
  Date_of_Payment: pmt.payment_date ?? '',
  EMI_Month_Year: pmt.emi_month ?? '',
  Months_Paid: pmt.months_paid ?? 1,
  Principal_Part: pmt.principal_part ?? 0,
  Interest_Part: pmt.interest_part ?? 0,
  Total_EMI_Paid: pmt.total_paid ?? 0,
  Payment_Mode: pmt.payment_mode ?? '',
  Ref_No: pmt.ref_no ?? '',
  Payment_From_Account: pmt.paid_from_account ?? '',
});

// 🔥 UNIVERSAL AUTO-RECOVERY & PARSING HELPERS (100% CRASH-PROOF)
const getVal = (obj: any, keysArr: string[], defaultVal = '') => {
  if(!obj || typeof obj !== 'object') return defaultVal;
  const objKeys = Object.keys(obj);
  for(const k of keysArr) {
     const target = String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
     const found = objKeys.find(ok => String(ok).toLowerCase().replace(/[^a-z0-9]/g, '') === target);
     if(found && obj[found] !== undefined && obj[found] !== null && String(obj[found]).trim() !== '') return String(obj[found]);
  }
  return defaultVal;
};

// 🔥 SMART PARSER TO HANDLE NUMBERS WITH COMMAS (CRASH-PROOF)
const parseNum = (val: any) => {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/,/g, '').trim();
  return parseFloat(cleaned) || 0;
};

export default function LoanEmiMgmt() {
  const [activeTab, setActiveTab] = useState('LOANS');
  // The tracker is computed on the server, per instalment, against the stored
  // repayment schedule. It is deliberately NOT derived here from loan counters:
  // an instalment that fell due before the opening balance was struck is not
  // outstanding — it is the reason the opening balance is what it is — and only
  // the server knows that cut-off date per loan.
  const [tracker, setTracker] = useState<any | null>(null);
  const [trackerErr, setTrackerErr] = useState<string | null>(null);
  const [loans, setLoans] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [bankAccounts, setBankAccounts] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const [globalSearch, setGlobalSearch] = useState('');
  const [isLoanModalOpen, setIsLoanModalOpen] = useState(false);
  const [isEmiModalOpen, setIsEmiModalOpen] = useState(false);
  const [editingLoanId, setEditingLoanId] = useState<string | null>(null); 

  // 📅 EMI HISTORY DATE FILTERS
  const [historyFromDate, setHistoryFromDate] = useState('');
  const [historyToDate, setHistoryToDate] = useState('');

  // ✏️ EDIT PAYMENT STATE
  const [paymentEditData, setPaymentEditData] = useState<any>(null);

  // 🏦 LOAN MASTER STATE
  const [loanData, setLoanData] = useState({
    Loan_Account_No: '', Vehicle_No: '', Owner_Name: '', Company_Name: '', Loan_Type: 'Chassis Loan', Bank_Name: '',
    Sanction_Date: '', Rate_Of_Interest: '', Principal_Amt: '', 
    Tenure_Months: '', Moratorium_Months: '0', EMI_Amount: '', 
    As_On_Date: new Date().toISOString().split('T')[0], 
    Remaining_Principal_As_On: '', 
    Old_EMIs_Paid: '0', 
    emi_slabs: [{ id: Date.now(), date: '', from_month: '1', to_month: '', amount: '' }], 
    repayment_schedule: [], 
    Total_Interest_Paid: '0', Payment_Status: 'ACTIVE'
  });

  // 💸 MULTI-LOAN SMART BULK PAYMENT DATA
  const [bulkBankFilter, setBulkBankFilter] = useState('');
  const [bulkTypeFilter, setBulkTypeFilter] = useState('ALL'); 
  const [bulkOwnerFilter, setBulkOwnerFilter] = useState('ALL');
  const [selectAll, setSelectAll] = useState(false);
  const [multiEmi, setMultiEmi] = useState({
    Date_of_Payment: new Date().toISOString().split('T')[0],
    Payment_Mode: 'Bank Auto-Debit',
    Ref_No: '',
    Payment_From_Account: '' 
  });
  const [emiEntries, setEmiEntries] = useState<any[]>([]);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [vehRes, loanRes, accRes] = await Promise.all([
        fetchJson(`${MASTERS}/vehicles?limit=1000`).catch(() => ({ vehicles: [] })),
        fetchJson(`${ASSETS}/loans`).catch(() => ({ loans: [] })),
        fetchJson(`${FIN}/accounts`).catch(() => ({ accounts: [] })),
      ]);
      setVehicles(vehRes.vehicles ?? []);
      const loanRows = (loanRes.loans ?? []).map(loanFromApi);
      setLoans(loanRows);

      // Payments for every loan, newest first. The old code merged two Firestore
      // collections (EMI_PAYMENTS and LOAN_PAYMENTS) that had drifted apart and
      // then deleted from both on every removal — there is one table now.
      const perLoan = await Promise.all(loanRows.map((l: any) =>
        fetchJson(`${ASSETS}/loans/${l.id}/payments`)
          .then(r => (r.payments ?? []).map(paymentFromApi))
          .catch(() => [])));
      setPayments(perLoan.flat().sort((a: any, b: any) =>
        String(b.Date_of_Payment).localeCompare(String(a.Date_of_Payment))));

      // Bank/cash accounts come from the chart of accounts — the same list every
      // other payment screen uses, so an EMI cannot be paid from an account the
      // ledger has never heard of.
      setBankAccounts((accRes.accounts ?? []).map((a: any) => a.ledger_name));

      // Separate call, and separately fault-tolerant: the tracker is a reporting
      // view, and a failure to build it must not blank out the loan master and
      // the payment screens beside it.
      fetchJson(`${LOANS_API}/emi-tracker?months_ahead=6`)
        .then((t) => { setTracker(t); setTrackerErr(null); })
        .catch((e) => { setTracker(null); setTrackerErr(e.message || 'tracker unavailable'); });
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 🛡️ CRASH-PROOF FINDER
  const findVehicleMaster = (vNo: any) => {
      if (!vNo) return null;
      const cleanVNo = String(vNo).replace(/[^A-Z0-9]/ig, '').toUpperCase();
      return vehicles.find(v => {
          const tempNo = String(getVal(v, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'vehicleno', 'registration_no', 'registrationno', 'Registration_No'])).replace(/[^A-Z0-9]/ig, '').toUpperCase();
          return tempNo === cleanVNo;
      });
  };

  // 🛡️ CRASH-PROOF OWNER RESOLVER
  const getRealOwner = (record: any) => {
      if (!record) return 'PRASAD TRANSPORT';
      const vObj = findVehicleMaster(getVal(record, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'vehicleno', 'registration_no']));
      if (vObj) {
           const masterOwner = getVal(vObj, ['asset_owner_name', 'Asset_Owner_Name', 'asset_owner', 'Asset_Owner', 'owner_name', 'Owner_Name', 'ownername', 'owner']);
           if (masterOwner && masterOwner.trim() !== '' && masterOwner !== 'N/A') return masterOwner;
      }
      const savedOwner = getVal(record, ['Owner_Name', 'owner_name', 'owner', 'asset_owner_name', 'assetowner']);
      return (savedOwner && savedOwner.trim() !== '') ? savedOwner : 'PRASAD TRANSPORT';
  };

  // 🛡️ CRASH-PROOF COMPANY RESOLVER
  const getRealCompany = (record: any) => {
      if (!record) return 'PRASAD TRANSPORT';
      const vObj = findVehicleMaster(getVal(record, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'vehicleno', 'registration_no']));
      if (vObj) {
           const masterComp = getVal(vObj, ['operating_company', 'Operating_Company', 'Company_Name', 'company_name', 'companyname', 'company']);
           if (masterComp && masterComp.trim() !== '' && masterComp !== 'N/A') return masterComp;
      }
      const savedComp = getVal(record, ['Company_Name', 'company_name', 'company', 'Operating_Company', 'operating_company']);
      return (savedComp && savedComp.trim() !== '') ? savedComp : 'PRASAD TRANSPORT';
  };

  // 🛡️ CRASH-PROOF LEDGER EXTRACTOR
  const getLedgerEntityName = (record: any) => {
     if (!record) return 'PRASAD TRANSPORT';
     const owner = getRealOwner(record);
     if (owner && owner !== 'PRASAD TRANSPORT' && owner !== 'N/A') return owner; 
     const comp = getRealCompany(record);
     if (comp && comp !== 'N/A') return comp;
     return 'PRASAD TRANSPORT';
  };

  const uniqueOwnersList = [...new Set([
    ...vehicles.map(v => getVal(v, ['asset_owner_name', 'Asset_Owner_Name', 'asset_owner', 'Asset_Owner', 'owner_name', 'Owner_Name', 'ownername', 'owner'])),
    ...loans.map(l => getVal(l, ['Owner_Name', 'owner_name', 'owner']))
  ])].filter(name => name && String(name).trim() !== '' && name !== 'N/A').sort();

  const uniqueCompaniesList = [...new Set([
    ...vehicles.map(v => getVal(v, ['operating_company', 'Operating_Company', 'company_name', 'Company_Name', 'company', 'companyname'])),
    ...loans.map(l => getVal(l, ['Company_Name', 'company_name', 'company']))
  ])].filter(name => name && String(name).trim() !== '' && name !== 'N/A').sort();

  const getCurrentEmiAmount = (l: any) => {
    if(!l) return 0;
    if (l.repayment_schedule && Array.isArray(l.repayment_schedule) && l.repayment_schedule.length > 0) {
        const emisCleared = parseInt(getVal(l, ['EMIs_Completed', 'emis_completed', 'old_emis_paid'], '0')) || 0;
        const safeIndex = Math.min(emisCleared, l.repayment_schedule.length - 1);
        const currentRow = l.repayment_schedule[safeIndex];
        if (currentRow) return parseNum(currentRow.emi);
    }
    if (l.emi_slabs && Array.isArray(l.emi_slabs) && l.emi_slabs.length > 0 && l.emi_slabs[0].amount) return parseNum(l.emi_slabs[0].amount);
    return parseNum(getVal(l, ['EMI_Amount', 'emi_amount', 'amount', 'EMI'], '0'));
  };

  const getDueStatus = (l: any) => {
    if(!l) return { status: '🟢 Up to Date', dueMonths: 0, dueAmount: 0, color: '#10b981', currentEmiAmt: 0 };
    const todayStr = new Date().toISOString().split('T')[0];
    let expectedTotalPaid = 0;
    const currentEmiAmt = getCurrentEmiAmount(l);

    if (l.repayment_schedule && Array.isArray(l.repayment_schedule) && l.repayment_schedule.length > 0) {
        expectedTotalPaid = l.repayment_schedule.filter((s:any) => s.date <= todayStr).length;
    } else {
        const startDate = new Date(l.As_On_Date || l.Sanction_Date || new Date());
        const now = new Date();
        const monthsElapsed = (now.getFullYear() - startDate.getFullYear()) * 12 + now.getMonth() - startDate.getMonth();
        expectedTotalPaid = Math.max(0, parseInt(getVal(l, ['Old_EMIs_Paid', 'old_emis_paid'], '0')) + monthsElapsed);
    }

    const actualCompleted = parseInt(getVal(l, ['EMIs_Completed', 'emis_completed', 'old_emis_paid'], '0')) || 0;
    const dueMonths = Math.max(0, expectedTotalPaid - actualCompleted);
    const dueAmount = dueMonths * currentEmiAmt;

    if (dueMonths === 0) return { status: '🟢 Up to Date', dueMonths: 0, dueAmount: 0, color: '#10b981', currentEmiAmt };
    return { status: `🔴 ${dueMonths} Month(s) Overdue`, dueMonths, dueAmount, color: '#ef4444', currentEmiAmt };
  };

  // -------------------------------------------------------------
  // 💸 SMART BULK PAYMENT LOGIC (With Auto Ledger Update)
  // -------------------------------------------------------------
  const uniqueBanks = [...new Set(loans.filter(l => getVal(l, ['Payment_Status', 'status']) === 'ACTIVE').map(l => getVal(l, ['Bank_Name', 'bank_name', 'financier_name'])))].filter(Boolean);

  const handleBankSelect = (bankName: string) => {
    setBulkBankFilter(bankName); setBulkTypeFilter('ALL'); setBulkOwnerFilter('ALL'); setSelectAll(false);
    if (!bankName) { setEmiEntries([]); return; }

    const bankLoans = loans.filter(l => getVal(l, ['Payment_Status', 'status']) === 'ACTIVE' && getVal(l, ['Bank_Name', 'bank_name', 'financier_name']) === bankName);
    
    const newEntries = bankLoans.map(sLoan => {
       const cleared = parseInt(getVal(sLoan, ['EMIs_Completed', 'emis_completed', 'old_emis_paid'], '0')) || 0;
       let tEmi = 0, tPri = 0, tInt = 0, mthYr = '';
       
       if (sLoan.repayment_schedule && Array.isArray(sLoan.repayment_schedule) && sLoan.repayment_schedule[cleared]) {
          const row = sLoan.repayment_schedule[cleared];
          tEmi = parseNum(row.emi); tPri = parseNum(row.principal); tInt = parseNum(row.interest);
          mthYr = `${new Date(row.date).toLocaleString('default', { month: 'short' })}-${new Date(row.date).getFullYear()}`;
       } else {
          tEmi = getCurrentEmiAmount(sLoan);
          mthYr = new Date().toLocaleString('default', { month: 'short' }) + '-' + new Date().getFullYear();
       }

       return {
          id: sLoan.id, Loan_Account: sLoan.id, selected: false,
          EMI_Month_Year: mthYr, Months_Paid: '1', Total_EMI_Paid: tEmi.toFixed(2), Principal_Part: tPri.toFixed(2), Interest_Part: tInt.toFixed(2),
          _vehicle: getVal(sLoan, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no']),
          _owner: getRealOwner(sLoan), 
          _company: getRealCompany(sLoan), 
          _loanAc: getVal(sLoan, ['Loan_Account_No', 'loan_account_no']),
          _type: getVal(sLoan, ['Loan_Type', 'loan_type']),
          _tenure: getVal(sLoan, ['Tenure_Months', 'tenure_months']),
          _cleared: cleared,
          _dueStatus: getDueStatus(sLoan)
       };
    });
    setEmiEntries(newEntries);
  };

  const handleToggleSelectAll = () => {
    const newState = !selectAll;
    setSelectAll(newState);
    setEmiEntries(prev => prev.map(e => {
      const eType = String(e._type || '').toLowerCase();
      const bType = String(bulkTypeFilter || '').toLowerCase();
      const isTypeMatch = bulkTypeFilter === 'ALL' || eType === bType || eType.includes(bType);
      
      const eOwner = String(e._owner || '').toLowerCase();
      const bOwner = String(bulkOwnerFilter || '').toLowerCase();
      const isOwnerMatch = bulkOwnerFilter === 'ALL' || eOwner === bOwner;
      
      if (isTypeMatch && isOwnerMatch) return { ...e, selected: newState };
      return e;
    }));
  };

  const handleEmiEntryChange = (id: string, field: string, value: any) => {
    setEmiEntries(prev => prev.map(entry => {
      if (entry.id === id) {
        const newEntry = { ...entry, [field]: value };
        
        if (field === 'Months_Paid') {
          const sLoan = loans.find(l => l.id === newEntry.Loan_Account);
          if (sLoan) {
            const mths = parseInt(value) || 1;
            const cleared = parseInt(getVal(sLoan, ['EMIs_Completed', 'emis_completed'], '0')) || 0;
            if (sLoan.repayment_schedule && Array.isArray(sLoan.repayment_schedule) && sLoan.repayment_schedule[cleared]) {
                let tEmi = 0, tPri = 0, tInt = 0;
                for(let i=0; i<mths; i++) {
                    const row = sLoan.repayment_schedule[cleared + i];
                    if(row) { tEmi += parseNum(row.emi); tPri += parseNum(row.principal); tInt += parseNum(row.interest); }
                }
                newEntry.Total_EMI_Paid = tEmi.toFixed(2); newEntry.Principal_Part = tPri.toFixed(2); newEntry.Interest_Part = tInt.toFixed(2);
            } else {
                newEntry.Total_EMI_Paid = (getCurrentEmiAmount(sLoan) * mths).toFixed(2);
            }
          }
        }
        
        if (field === 'Total_EMI_Paid') {
            const intPart = parseNum(newEntry.Interest_Part);
            newEntry.Principal_Part = Math.max(0, parseNum(value) - intPart).toFixed(2);
        }

        return newEntry;
      }
      return entry;
    }));
  };

  const filteredEmiEntries = emiEntries.filter(e => {
      const eType = String(e._type || '').toLowerCase();
      const bType = String(bulkTypeFilter || '').toLowerCase();
      const isTypeMatch = bulkTypeFilter === 'ALL' || eType === bType || eType.includes(bType);
      
      const eOwner = String(e._owner || '').toLowerCase();
      const bOwner = String(bulkOwnerFilter || '').toLowerCase();
      const isOwnerMatch = bulkOwnerFilter === 'ALL' || eOwner === bOwner;
      
      return isTypeMatch && isOwnerMatch;
  });

  const currentTotalPayout = filteredEmiEntries.filter(e => e.selected).reduce((sum, e) => sum + parseNum(e.Total_EMI_Paid), 0);

  const handleSaveMultiEmi = async () => {
    const selectedEntries = emiEntries.filter(e => e.selected);
    if (selectedEntries.length === 0) return alert("⚠️ Please select at least one vehicle to pay!");
    if (currentTotalPayout === 0) return alert("⚠️ Payment amount cannot be zero!");
    if (!multiEmi.Payment_From_Account) return alert("⚠️ Please select 'Payment From (Our Bank)' account to deduct balance!");
    
    setLoading(true);
    try {
      for (const entry of selectedEntries) {
        const selectedLoan = loans.find(l => l.id === entry.Loan_Account);
        if(!selectedLoan) continue;
        
        const principalPaid = parseNum(entry.Principal_Part);
        const interestPaid = parseNum(entry.Interest_Part);
        const noOfMonths = parseInt(entry.Months_Paid || '1');

        const oldRemaining = parseNum(getVal(selectedLoan, ['Remaining_Principal', 'balance', 'Principal_Amt']));
        const oldInterest = parseNum(getVal(selectedLoan, ['Total_Interest_Paid', 'total_interest']));
        const oldMonths = parseInt(getVal(selectedLoan, ['EMIs_Completed', 'emis_completed'], '0'));

        const actualOwner = getRealOwner(selectedLoan);
        const actualCompany = getRealCompany(selectedLoan);
        const ledgerEntityName = getLedgerEntityName(selectedLoan); 

        // ONE call. The API validates the split, refuses an over-repayment,
        // posts the three-leg journal through TARA, and moves the loan counters
        // in the SAME transaction as the payment row. This used to be three
        // separate writes from the browser that could half-succeed.
        const res = await fetchJson(`${ASSETS}/loans/${selectedLoan.id}/emi`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            total_paid: parseNum(entry.Total_EMI_Paid),
            principal_part: principalPaid,
            interest_part: interestPaid,
            payment_date: multiEmi.Date_of_Payment,
            emi_month: entry.EMI_Month_Year || null,
            months_paid: noOfMonths,
            payment_mode: multiEmi.Payment_Mode || null,
            ref_no: multiEmi.Ref_No || null,
            account: multiEmi.Payment_From_Account || null,
            company: ledgerEntityName || null,
            created_by: (JSON.parse(localStorage.getItem('prasad_user') || '{}').email) || null,
          }),
        });
        if (res.ledger_note) ledgerWarnings.push(`${getVal(selectedLoan, ['Vehicle_No', 'vehicle_no'])}: ${res.ledger_note}`);
      }
      alert(`✅ Smart Bulk EMI Payment Successful!\nTotal ₹${currentTotalPayout.toLocaleString('en-IN')} Deducted from ${multiEmi.Payment_From_Account}`
        + (ledgerWarnings.length ? `\n\n⚠️ Ledger:\n${ledgerWarnings.join('\n')}` : ''));
      setIsEmiModalOpen(false); handleBankSelect(''); fetchData();
    } catch (e: any) {
      // The API's refusals are specific; passing them through means the operator
      // learns what to fix instead of seeing "Error saving payments".
      const said = {
        BAD_SPLIT: 'Principal + Interest, Total EMI ke barabar nahi hai — split theek karein.',
        OVER_REPAYMENT: 'Principal loan ke bache hue amount se zyada hai.',
        DUPLICATE: 'Yeh Ref/UTR is loan par pehle hi darj hai.',
        DUPLICATE_REF: 'Yeh Ref/UTR ledger me pehle hi post ho chuka hai.',
        OVERDRAFT: 'Us account me itna balance nahi hai.',
        NO_ACCOUNT: 'Payment kis account se gaya — woh chunein.',
      }[e?.code];
      alert("❌ " + (said || e?.message || 'Error saving payments.'));
      console.error(e);
    }
    setLoading(false);
  };

  const handleDeletePayment = async (payment: any) => {
    if(!window.confirm(`⚠️ Delete EMI Payment for ${getVal(payment, ['Vehicle_No', 'vehicleno'])}?\nThis will reverse the payment and restore the loan balance automatically!`)) return;
    setLoading(true);
    try {
       // ONE call: the API reverses the ledger entry, deletes the payment and
       // restores the loan counters in a single transaction. It refuses outright
       // if the reversal fails, rather than deleting the payment and leaving the
       // books saying the loan was repaid.
       //
       // What this replaces: three counter writes, a delete from EMI_PAYMENTS,
       // a delete of its twin in LOAN_PAYMENTS, and a scan of every
       // BANK_TRANSACTIONS document for one with a matching date and an amount
       // within Rs.2 — which could just as easily have deleted someone else's.
       const res = await fetchJson(`${ASSETS}/loans/${payment.loan_id}/payments/${payment.id}`, {
         method: 'DELETE', headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({ reason: 'EMI payment deleted from Loan & EMI screen' }),
       });

       alert("✅ Payment Deleted & Loan Balance Restored!"
         + (res.reversal_voucher_id ? "\n🧾 Ledger entry reversed — delete nahi, reversing entry." : ""));
       await fetchData();
    } catch(e: any) {
      alert(e?.code === 'REVERSAL_FAILED' ? `🔒 ${e.message}` : "❌ Error deleting payment: " + (e?.message || ''));
      console.error(e);
    }
    setLoading(false);
  };

  const handleDeleteBlock = async (group: any[]) => {
    if(!window.confirm(`⚠️ Delete ENTIRE BLOCK of ${group.length} payments?\nThis will reverse ALL these payments and restore loan balances!`)) return;
    setLoading(true);
    // Each payment goes through the same endpoint the single delete uses, so a
    // block behaves exactly like doing them one at a time — including refusing
    // any whose ledger entry cannot be reversed. Failures are collected and
    // reported rather than aborting halfway with no account of what was done.
    const failed: string[] = [];
    let done = 0;
    for (const payment of group) {
      try {
        await fetchJson(`${ASSETS}/loans/${payment.loan_id}/payments/${payment.id}`, {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'EMI block deleted from Loan & EMI screen' }),
        });
        done++;
      } catch (e: any) {
        failed.push(`${getVal(payment, ['Vehicle_No','vehicle_no']) || payment.id}: ${e?.message || 'failed'}`);
      }
    }
    alert(`✅ ${done} payment(s) deleted and balances restored.`
      + (failed.length ? `\n\n❌ ${failed.length} could NOT be deleted:\n${failed.join('\n')}` : ''));
    await fetchData();
    setLoading(false);
  };

  const handleSaveEditedPayment = async () => {
      setLoading(true);
      try {
          const original = payments.find(p => p.id === paymentEditData.id);
          // A correction is an UNDO plus a REDO, not an in-place edit. That is
          // the same rule the ledger follows (ledger_entries is append-only, so
          // the old entry is reversed and a new one posted) and it means the
          // loan counters are adjusted by the two verified endpoints rather than
          // by a third piece of diff arithmetic that could disagree with both.
          //
          // The re-posted entry carries a "-C" reference: the original ref is
          // still on the reversed voucher, so re-using it verbatim would be
          // refused as a duplicate — and the suffix makes the correction
          // visible in the ledger instead of looking like the original.
          await fetchJson(`${ASSETS}/loans/${original.loan_id}/payments/${original.id}`, {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: 'EMI payment edited — superseded by a corrected entry' }),
          });

          const correctedRef = (paymentEditData.Ref_No || original.Ref_No)
            ? `${paymentEditData.Ref_No || original.Ref_No}-C`
            : null;

          await fetchJson(`${ASSETS}/loans/${original.loan_id}/emi`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              total_paid: parseNum(paymentEditData.Total_EMI_Paid || original.Total_EMI_Paid),
              principal_part: parseNum(paymentEditData.Principal_Part || original.Principal_Part),
              interest_part: parseNum(paymentEditData.Interest_Part || original.Interest_Part),
              payment_date: paymentEditData.Date_of_Payment || original.Date_of_Payment,
              emi_month: paymentEditData.EMI_Month_Year || original.EMI_Month_Year || null,
              months_paid: parseInt(paymentEditData.Months_Paid || original.Months_Paid || '1') || 1,
              payment_mode: original.Payment_Mode || null,
              ref_no: correctedRef,
              account: paymentEditData.Payment_From_Account || original.Payment_From_Account || null,
              created_by: (JSON.parse(localStorage.getItem('prasad_user') || '{}').email) || null,
            }),
          });

          alert("✅ Payment Updated & Balances Adjusted Automatically!");
          setPaymentEditData(null);
          await fetchData();
      } catch(e: any) {
        const said = {
          BAD_SPLIT: 'Principal + Interest, Total EMI ke barabar nahi hai.',
          OVER_REPAYMENT: 'Principal loan ke bache hue amount se zyada hai.',
          REVERSAL_FAILED: e?.message,
          DUPLICATE: 'Corrected reference pehle se maujood hai.',
        }[e?.code];
        alert("❌ " + (said || e?.message || 'Error updating payment'));
        console.error(e);
      }
      setLoading(false);
  };

  // -------------------------------------------------------------
  // CRASH-PROOF SAFE FILTERS & SEARCH
  // -------------------------------------------------------------
  const filteredLoans = loans.filter(l => {
    const lVNo = String(getVal(l, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no']) || '').toLowerCase();
    const lBank = String(getVal(l, ['Bank_Name', 'bank_name', 'financier_name']) || '').toLowerCase();
    const lAc = String(getVal(l, ['Loan_Account_No', 'loan_account_no', 'account_no']) || '').toLowerCase();
    const lOwner = String(getRealOwner(l) || '').toLowerCase();
    const lComp = String(getRealCompany(l) || '').toLowerCase();
    const sTerm = String(globalSearch || '').toLowerCase();

    return lVNo.includes(sTerm) || lBank.includes(sTerm) || lAc.includes(sTerm) || lOwner.includes(sTerm) || lComp.includes(sTerm);
  });

  const filteredPayments = payments.filter(p => {
    const pVNo = String(getVal(p, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no']) || '').toLowerCase();
    const pBank = String(getVal(p, ['Bank_Name', 'bank_name', 'financier_name']) || '').toLowerCase();
    const pMth = String(getVal(p, ['EMI_Month_Year', 'month_year', 'EMI_Month']) || '').toLowerCase();
    const pRef = String(getVal(p, ['Ref_No', 'ref_no', 'utr', 'transaction_id']) || '').toLowerCase();
    const pOwner = String(getRealOwner(p) || '').toLowerCase();
    const pComp = String(getRealCompany(p) || '').toLowerCase();
    const sTerm = String(globalSearch || '').toLowerCase();

    const searchMatch = pVNo.includes(sTerm) || pBank.includes(sTerm) || pMth.includes(sTerm) || pRef.includes(sTerm) || pOwner.includes(sTerm) || pComp.includes(sTerm);
    
    const pDate = getVal(p, ['Date_of_Payment', 'date_of_payment', 'date', 'EMI_Date']);
    const fromMatch = historyFromDate ? pDate >= historyFromDate : true;
    const toMatch = historyToDate ? pDate <= historyToDate : true;
    
    return searchMatch && fromMatch && toMatch;
  });

  const groupedHistoryPayments: any = {};
  filteredPayments.forEach(p => {
      const date = getVal(p, ['Date_of_Payment', 'date_of_payment', 'date', 'EMI_Date', 'emi_date'], 'Unknown_Date');
      const ref = getVal(p, ['Ref_No', 'ref_no', 'utr', 'transaction_id'], 'No_Ref');
      const bank = getVal(p, ['Payment_From_Account'], 'Unknown_Bank');
      const key = `${date}_${bank}_${ref}`;
      if (!groupedHistoryPayments[key]) groupedHistoryPayments[key] = [];
      groupedHistoryPayments[key].push(p);
  });

  const activeLoansList = filteredLoans.filter(l => getVal(l, ['Payment_Status', 'status', 'payment_status']) !== 'CLOSED');
  const totalPrincipalDue = activeLoansList.reduce((acc, curr) => acc + parseNum(getVal(curr, ['Remaining_Principal', 'remaining_principal', 'Principal_Amt', 'balance'])), 0);
  const totalEmiPerMonth = activeLoansList.reduce((acc, curr) => acc + getCurrentEmiAmount(curr), 0);

  const reportData = activeLoansList.map(l => ({ ...l, ...getDueStatus(l) }));
  const totalOverdueAmount = reportData.reduce((acc, curr) => acc + curr.dueAmount, 0);

  const resetLoanForm = () => {
    setLoanData({ Loan_Account_No: '', Vehicle_No: '', Owner_Name: '', Company_Name: '', Loan_Type: 'Chassis Loan', Bank_Name: '', Sanction_Date: '', Rate_Of_Interest: '', Principal_Amt: '', Tenure_Months: '', Moratorium_Months: '0', EMI_Amount: '', As_On_Date: new Date().toISOString().split('T')[0], Remaining_Principal_As_On: '', Old_EMIs_Paid: '0', emi_slabs: [{ id: Date.now(), date: '', from_month: '1', to_month: '', amount: '' }], repayment_schedule: [], Total_Interest_Paid: '0', Payment_Status: 'ACTIVE' });
    setEditingLoanId(null);
  };
  const addEmiSlab = () => setLoanData({ ...loanData, emi_slabs: [...loanData.emi_slabs, { id: Date.now(), date: '', from_month: '', to_month: '', amount: '' }] });
  const updateEmiSlab = (id: number, field: string, value: string) => setLoanData({ ...loanData, emi_slabs: loanData.emi_slabs.map(slab => slab.id === id ? { ...slab, [field]: value } : slab) });
  const removeEmiSlab = (id: number) => setLoanData({ ...loanData, emi_slabs: loanData.emi_slabs.filter(slab => slab.id !== id) });

  const handleEditLoan = (loan: any) => {
    const currentOwner = getRealOwner(loan);
    const currentCompany = getRealCompany(loan);

    setLoanData({
      Loan_Account_No: getVal(loan, ['Loan_Account_No', 'loan_account_no', 'account_no']), 
      Vehicle_No: getVal(loan, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no']), 
      Owner_Name: currentOwner, 
      Company_Name: currentCompany, 
      Loan_Type: getVal(loan, ['Loan_Type', 'loan_type'], 'Chassis Loan'), 
      Bank_Name: getVal(loan, ['Bank_Name', 'bank_name', 'financier_name']), 
      Sanction_Date: loan.Sanction_Date || '', Rate_Of_Interest: loan.Rate_Of_Interest || '', 
      Principal_Amt: getVal(loan, ['Principal_Amt', 'principal_amt', 'amount'], '0'), 
      Tenure_Months: getVal(loan, ['Tenure_Months', 'tenure_months', 'tenure'], ''), 
      Moratorium_Months: getVal(loan, ['Moratorium_Months', 'moratorium_months', 'moratorium'], '0'), 
      EMI_Amount: getVal(loan, ['EMI_Amount', 'emi_amount', 'amount'], ''), 
      As_On_Date: loan.As_On_Date || new Date().toISOString().split('T')[0], 
      Remaining_Principal_As_On: getVal(loan, ['Remaining_Principal', 'balance', 'Principal_Amt'], '0'), 
      Old_EMIs_Paid: getVal(loan, ['EMIs_Completed', 'old_emis_paid'], '0'), 
      emi_slabs: loan.emi_slabs && Array.isArray(loan.emi_slabs) && loan.emi_slabs.length > 0 && loan.emi_slabs[0].amount ? loan.emi_slabs : [{ id: Date.now(), date: '', from_month: '1', to_month: '', amount: '' }], 
      repayment_schedule: loan.repayment_schedule || [], 
      Total_Interest_Paid: getVal(loan, ['Total_Interest_Paid'], '0'), 
      Payment_Status: getVal(loan, ['Payment_Status', 'status'], 'ACTIVE')
    });
    setEditingLoanId(loan.id); setIsLoanModalOpen(true);
  };

  const generateSchedule = () => {
    const P = parseNum(loanData.Principal_Amt); 
    const N = parseInt(loanData.Tenure_Months); 
    const M = parseInt(loanData.Moratorium_Months) || 0; 
    const R_annual = parseNum(loanData.Rate_Of_Interest); 

    if(!P || !N) return alert("⚠️ Please enter Principal Amount and Tenure.");
    const r_monthly = (R_annual / 12) / 100;
    
    const validSlabs = loanData.emi_slabs.filter(s => s.amount && s.to_month);
    const hasCustomSlabs = validSlabs.length > 0;
    const standardEmi = parseNum(loanData.EMI_Amount);
    
    if (!hasCustomSlabs && standardEmi === 0) return alert("⚠️ Please enter 'Standard EMI' OR 'EMI Slabs'!");
    
    const getEmiForMonth = (monthNo: number) => {
      if (monthNo <= M) return 0; 

      if (hasCustomSlabs) {
        for (const slab of validSlabs) { 
           if (monthNo >= (parseInt(slab.from_month)||1) && monthNo <= (parseInt(slab.to_month)||N)) return parseNum(slab.amount); 
        }
      }
      return standardEmi;
    };

    const schedule = []; 
    let balance = P; 
    const currentDate = new Date(loanData.As_On_Date || new Date());
    currentDate.setMonth(currentDate.getMonth() + 1);

    for(let i = 1; i <= N; i++) {
        let currentEmi = getEmiForMonth(i); 
        const interest = balance * r_monthly; 
        let principal = currentEmi - interest; 

        if (i === N || (balance + interest <= currentEmi && currentEmi > 0)) { 
            principal = balance; 
            currentEmi = principal + interest; 
        }
        
        balance -= principal; 
        if(balance < 0.05) balance = 0;
        
        schedule.push({ 
            month_no: i, 
            date: currentDate.toISOString().split('T')[0], 
            emi: currentEmi.toFixed(2), 
            interest: interest.toFixed(2), 
            principal: principal.toFixed(2), 
            balance: balance.toFixed(2) 
        });
        
        if (balance === 0 && i > M) break;
        currentDate.setMonth(currentDate.getMonth() + 1);
    }

    setLoanData({ 
        ...loanData, 
        repayment_schedule: schedule, 
        emi_slabs: hasCustomSlabs ? loanData.emi_slabs : [{ id: Date.now(), date: schedule[0].date, from_month: '1', to_month: String(N), amount: standardEmi.toFixed(2) }] 
    });
    
    alert(`✅ Schedule Generated Successfully!${M > 0 ? `\n(Includes ${M} Months Moratorium Period where interest is capitalized)` : ''}`);
  };

  const handleSaveLoan = async () => {
    if (!loanData.Loan_Account_No || !loanData.Vehicle_No || !loanData.Principal_Amt) return alert("⚠️ Required fields missing!");
    try {
      const initialRemaining = loanData.Remaining_Principal_As_On ? parseNum(loanData.Remaining_Principal_As_On).toFixed(2) : parseNum(loanData.Principal_Amt).toFixed(2);
      if (editingLoanId) {
        await fetchJson(`${ASSETS}/loans/${editingLoanId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(loanToApi({ ...loanData, Remaining_Principal: initialRemaining })),
        });
      } else {
        await fetchJson(`${ASSETS}/loans`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(loanToApi({ ...loanData, Remaining_Principal: initialRemaining })),
        });
      }
      setIsLoanModalOpen(false); resetLoanForm(); fetchData();
    } catch (e) { alert("❌ Error saving loan."); }
  };

  const handleDeleteLoan = async (id: string) => {
    if (window.confirm(`⚠️ Delete this Loan Account?`)) {
      // A loan with payments recorded against it is history, not a typo — the
      // API refuses and says so rather than erasing the repayment trail.
      try {
        await fetchJson(`${ASSETS}/loans/${id}`, { method: 'DELETE' });
        fetchData();
      } catch (error: any) {
        alert(error?.code === 'HAS_PAYMENTS' ? `🔒 ${error.message}` : "❌ Error deleting: " + (error?.message || ''));
      }
    }
  };

  const getHtmlHeader = (title: string) => `
    <html><head><title>${title}</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap" rel="stylesheet">
    <style>
      body { font-family: 'Inter', sans-serif; padding: 40px; color: #334155; background-color: #fff; margin: 0; }
      .header-container { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #1e293b; padding-bottom: 15px; margin-bottom: 30px; }
      .company-title { font-size: 28px; font-weight: 900; color: #0f172a; margin: 0; text-transform: uppercase; letter-spacing: 1px; }
      .report-title { font-size: 16px; color: #64748b; margin: 5px 0 0 0; text-transform: uppercase; letter-spacing: 2px; }
      .date-text { font-size: 13px; color: #475569; font-weight: 600; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; text-align: left; }
      thead tr { background-color: #1e293b; color: #ffffff; }
      th { padding: 12px; border-bottom: 2px solid #cbd5e1; }
      td { padding: 12px; border: 1px solid #e2e8f0; }
      @media print { body { padding: 20px; -webkit-print-color-adjust: exact; print-color-adjust: exact; } .page-break { page-break-before: always; } }
    </style></head><body>
    <div class="header-container"><div><h1 class="company-title">PRASAD TRANSPORT</h1><p class="report-title">${title}</p></div>
    <div class="date-text">Generated On: ${new Date().toLocaleDateString('en-GB')}</div></div>
  `;

  const getHtmlFooter = () => `
    <div style="margin-top: 50px; text-align: center; border-top: 1px dashed #cbd5e1; padding-top: 15px; color: #64748b; font-size: 11px;">
      <p><b>Note:</b> This is an auto-generated system report and does not require any physical signature.</p>
    </div>
    <script>window.onload = function() { setTimeout(function() { window.print(); }, 800); }</script></body></html>
  `;

  const handlePrintPDF = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return alert("Please allow popups to generate PDF.");

    let tableHTML = '';
    let title = '';

    if (activeTab === 'LOANS') {
       title = "Vehicle Loan Master Report";
       tableHTML = `<table><thead><tr><th>Vehicle No</th><th>Company</th><th>Owner Name</th><th>Bank Name</th><th>Loan A/C No</th><th>Type</th><th style="text-align:right;">Total Principal</th><th style="text-align:right;">Remaining Bal.</th></tr></thead><tbody>
         ${filteredLoans.map((l, idx) => {
           const vNo = getVal(l, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no'], '-');
           const bName = getVal(l, ['Bank_Name', 'bank_name', 'financier_name'], '-');
           const aNo = getVal(l, ['Loan_Account_No', 'loan_account_no', 'account_no'], '-');
           const type = getVal(l, ['Loan_Type', 'loan_type'], 'Loan');
           const pAmt = parseNum(getVal(l, ['Principal_Amt', 'principal_amt', 'loan_amount', 'amount'])).toLocaleString('en-IN');
           const remAmt = parseNum(getVal(l, ['Remaining_Principal', 'remaining_principal', 'Principal_Amt', 'balance'])).toLocaleString('en-IN', {minimumFractionDigits: 2});
           return `<tr style="background-color: ${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};"><td><b>${vNo}</b></td><td>${getRealCompany(l)}</td><td>${getRealOwner(l)}</td><td>${bName}</td><td>${aNo}</td><td>${type}</td><td style="text-align:right;">₹ ${pAmt}</td><td style="text-align:right;"><b>₹ ${remAmt}</b></td></tr>`;
         }).join('')}</tbody></table>`;
    } else if (activeTab === 'EMIS') {
       title = `EMI Payment History Report ${historyFromDate ? `(${new Date(historyFromDate).toLocaleDateString('en-GB')} to ${historyToDate ? new Date(historyToDate).toLocaleDateString('en-GB') : 'Now'})` : ''}`;
       tableHTML = `<table><thead><tr><th>Date</th><th>Vehicle No</th><th>Company</th><th>Owner Name</th><th>Bank</th><th>Month/Year</th><th style="text-align:right;">Total EMI Paid</th><th style="text-align:right;">Principal Cut</th><th style="text-align:right;">Interest Paid</th></tr></thead><tbody>
         ${filteredPayments.map((p, idx) => {
           const date = getVal(p, ['Date_of_Payment', 'date_of_payment', 'date', 'EMI_Date', 'emi_date'], '-');
           const vNo = getVal(p, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no'], '-');
           const bName = getVal(p, ['Bank_Name', 'bank_name', 'financier_name'], '-');
           const mYr = getVal(p, ['EMI_Month_Year', 'month_year', 'EMI_Month'], 'N/A');
           const totEmi = parseNum(getVal(p, ['Total_EMI_Paid', 'total_emi', 'amount', 'EMI_Amount', 'Amount'])).toLocaleString('en-IN');
           const prin = parseNum(getVal(p, ['Principal_Part', 'principal_part', 'principal'])).toLocaleString('en-IN');
           const intP = parseNum(getVal(p, ['Interest_Part', 'interest_part', 'interest'])).toLocaleString('en-IN');
           return `<tr style="background-color: ${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};"><td>${date}</td><td><b>${vNo}</b></td><td>${getRealCompany(p)}</td><td>${getRealOwner(p)}</td><td>${bName}</td><td>${mYr}</td><td style="text-align:right; color: #15803d; font-weight: bold;">₹ ${totEmi}</td><td style="text-align:right;">₹ ${prin}</td><td style="text-align:right;">₹ ${intP}</td></tr>`;
         }).join('')}</tbody></table>`;
    } else if (activeTab === 'REPORT') {
       title = "EMI Due & Overdue Report";
       tableHTML = `<table><thead><tr><th>Vehicle & Bank</th><th>Company</th><th>Owner Name</th><th style="text-align:right;">Current EMI</th><th>Cleared / Total</th><th>Pending EMIs</th><th style="text-align:right;">Due Amount</th><th>Status</th></tr></thead><tbody>
         ${reportData.map((r, idx) => {
           const vNo = getVal(r, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no'], '-');
           const bName = getVal(r, ['Bank_Name', 'bank_name', 'financier_name'], '-');
           const curEmi = (r.currentEmiAmt || 0).toLocaleString('en-IN');
           const clr = getVal(r, ['EMIs_Completed', 'emis_completed', 'old_emis_paid'], '0');
           const tot = getVal(r, ['Tenure_Months', 'tenure_months', 'tenure'], '-');
           return `<tr style="background-color: ${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};"><td><b>${vNo}</b><br><span style="font-size:10px; color:#64748b;">${bName}</span></td><td>${getRealCompany(r)}</td><td>${getRealOwner(r)}</td><td style="text-align:right;">₹ ${curEmi}</td><td>${clr} / ${tot}</td><td style="color: ${r.dueMonths > 0 ? '#b91c1c' : '#15803d'}; font-weight: bold;">${r.dueMonths} Month(s)</td><td style="text-align:right; color: ${r.dueAmount > 0 ? '#b91c1c' : '#0f172a'}; font-weight: bold;">₹ ${r.dueAmount.toLocaleString('en-IN')}</td><td>${r.status}</td></tr>`;
         }).join('')}</tbody></table>`;
    }

    const htmlContent = getHtmlHeader(title) + tableHTML + getHtmlFooter();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
  };

  const handlePrintBankSheet = () => {
    const printWindow = window.open('', '_blank');
    if (!printWindow) return alert("Please allow popups to generate PDF.");

    const grouped: any = {};
    filteredPayments.forEach(p => {
      const key = `${getVal(p, ['Date_of_Payment', 'date_of_payment', 'date', 'EMI_Date']) || 'N/A'}_${getVal(p, ['Ref_No', 'ref_no', 'utr', 'transaction_id']) || 'CASH'}`;
      if(!grouped[key]) grouped[key] = [];
      grouped[key].push(p);
    });

    let allHtml = '';
    Object.keys(grouped).forEach(key => {
      const group = grouped[key];
      const dateStr = getVal(group[0], ['Date_of_Payment', 'date_of_payment', 'date', 'EMI_Date']);
      const date = dateStr ? new Date(dateStr).toLocaleDateString('en-GB') : '-';
      const refNo = getVal(group[0], ['Ref_No', 'ref_no', 'utr', 'transaction_id'], '-');
      const paymentMode = getVal(group[0], ['Payment_Mode', 'payment_mode', 'Mode'], 'Auto-Debit');
      const totalAmt = group.reduce((sum: number, g: any) => sum + parseNum(getVal(g, ['Total_EMI_Paid', 'total_emi', 'amount', 'EMI_Amount', 'Amount'])), 0);

      let rowsHtml = '';
      group.forEach((p: any, idx: number) => {
        const lType = p.Loan_Type || (loans.find(l => getVal(l, ['Loan_Account_No', 'loan_account_no', 'account_no']) === getVal(p, ['Loan_Account_No', 'loan_account_no', 'account_no']))?.Loan_Type || 'CHASSIS');
        const cName = getRealOwner(p); 
        const totEmi = parseNum(getVal(p, ['Total_EMI_Paid', 'total_emi', 'amount', 'EMI_Amount', 'Amount'])).toLocaleString('en-IN', {minimumFractionDigits: 2});
        
        rowsHtml += `<tr style="background-color: ${idx % 2 === 0 ? '#ffffff' : '#f8fafc'};">
          <td style="text-align: center;">${idx + 1}</td>
          <td style="text-transform: uppercase; font-weight: 600;">${cName}</td>
          <td style="text-align: center;">${getVal(p, ['Loan_Account_No', 'loan_account_no', 'account_no'], '-')}</td>
          <td style="text-align: center; font-weight: bold; color: #0f172a;">${getVal(p, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no'], '-')}</td>
          <td style="text-align: center; text-transform: uppercase;">${lType.replace(' Loan', '')}</td>
          <td style="text-align: right; font-weight: 600;">₹ ${totEmi}</td>
          ${idx === 0 ? `<td rowspan="${group.length}" style="text-align: center; vertical-align: middle;">${date}</td><td rowspan="${group.length}" style="text-align: right; vertical-align: middle; font-weight: bold; font-size: 14px; color: #15803d;">₹ ${totalAmt.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td><td rowspan="${group.length}" style="text-align: center; vertical-align: middle; font-weight: bold;">${refNo}<br/><span style="font-size:10px; color:#64748b; font-weight:normal;">(${paymentMode})</span></td>` : ''}
        </tr>`;
      });

      allHtml += `
      <div style="margin-bottom: 50px; page-break-inside: avoid; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.05);">
        <div style="background-color: #f1f5f9; padding: 12px 20px; border-bottom: 1px solid #cbd5e1; display: flex; justify-content: space-between; align-items: center;">
           <h3 style="margin: 0; color: #0f172a; font-size: 16px;">💳 Payment Schedule: <span style="color: #2563eb;">${date}</span></h3>
           <span style="font-size: 14px; font-weight: bold; color: #475569;">Ref: ${refNo}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th style="text-align: center;">Sl No.</th>
              <th>Borrower Name</th>
              <th style="text-align: center;">Loan No.</th>
              <th style="text-align: center;">Vehicle No.</th>
              <th style="text-align: center;">Loan Type</th>
              <th style="text-align: right;">Payment Amt</th>
              <th style="text-align: center;">Date</th>
              <th style="text-align: right;">Total Amt</th>
              <th style="text-align: center;">Txn Details</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
            <tr style="font-weight: bold; background-color: #e2e8f0; border-top: 2px solid #94a3b8;">
              <td colspan="5" style="text-align: right; text-transform: uppercase;">Total of this block:</td>
              <td style="text-align: right;">₹ ${totalAmt.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
              <td></td><td style="text-align: right; font-size: 14px; color: #15803d;">₹ ${totalAmt.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td><td></td>
            </tr>
          </tbody>
        </table>
      </div>`;
    });

    const htmlContent = getHtmlHeader("Bank Submission Annexure") + (allHtml || '<p style="text-align:center; font-size: 16px; color: #94a3b8; padding: 50px;">No payment records found.</p>') + getHtmlFooter();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
  };

  const handleEmailBankReport = () => {
    const bankGroups: any = {};
    reportData.forEach(r => {
       const bank = getVal(r, ['Bank_Name', 'bank_name', 'financier_name'], 'Unknown Bank');
       if (!bankGroups[bank]) bankGroups[bank] = [];
       bankGroups[bank].push(r);
    });

    let emailBody = "Dear Sir/Madam,%0D%0A%0D%0APlease find the summary of our Active Vehicle Loans and Current EMI Due status below:%0D%0A%0D%0A";
    Object.keys(bankGroups).forEach(bank => {
       emailBody += `🏦 BANK: ${bank.toUpperCase()}%0D%0A`;
       emailBody += `---------------------------------%0D%0A`;
       bankGroups[bank].forEach((r:any) => {
          emailBody += `Vehicle: ${getVal(r, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no'])} | A/C: ${getVal(r, ['Loan_Account_No', 'loan_account_no', 'account_no'])}%0D%0A`;
          emailBody += `Status: ${r.status.replace(/🔴|🟢/g, '').trim()} | Due: Rs. ${r.dueAmount}%0D%0A%0D%0A`;
       });
    });

    emailBody += `Total Outstanding Market Due: Rs. ${totalOverdueAmount}%0D%0A%0D%0A`;
    emailBody += "Regards,%0D%0APrasad Transport Accounts Team";
    window.open(`mailto:?subject=Vehicle Loan EMI Status Report - Prasad Transport&body=${emailBody}`, '_blank');
  };

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; }
        .glow-btn { background: linear-gradient(135deg, #6366f1, #4f46e5); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4); transform: translateY(-2px); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; transition: 0.3s;}
        .tab-btn.active { color: #818cf8; border-bottom: 3px solid #818cf8; background: rgba(129, 140, 248, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; outline: none; colorScheme: dark;}
        .modern-input:focus { border-color: #818cf8; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(255,255,255,0.05); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #818cf8; text-transform: uppercase; font-size: 11px; letter-spacing: 1px;}
        td { padding: 12px; border-bottom: 1px solid #334155; }
        tr.selected { background: rgba(16, 185, 129, 0.15) !important; border-left: 3px solid #10b981; }
        tr:hover { background: rgba(255,255,255,0.02); }
        .badge { padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; }
        .smart-table-input { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #fff; padding: 5px; width: 100%; box-sizing: border-box; border-radius: 4px; text-align: center; }
        .smart-table-input:focus { border-color: #38bdf8; outline: none; background: rgba(0,0,0,0.5); }
        .gradient-text { background: linear-gradient(135deg, #38bdf8, #818cf8, #c084fc); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
      `}</style>

      {/* 🚀 Header & Dashboard */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h1 className="gradient-text" style={{ margin: 0, fontSize: '32px', fontWeight: '900' }}>Finance & EMI Command</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Vehicle-wise Chassis & Body Loan Tracking</p>
        </div>
        <div style={{ display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
          <button className="glow-btn" style={{ background: '#334155', border: '1px solid #475569' }} onClick={handlePrintPDF}>🖨️ Print List PDF</button>
          <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)' }} onClick={() => setIsEmiModalOpen(true)}>💸 Pay Multi-Loan EMIs</button>
          <button className="glow-btn" onClick={() => { resetLoanForm(); setIsLoanModalOpen(true); }}>🏦 Add New Loan</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginBottom: '20px' }}>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '5px solid #ef4444' }}>
          <h3 style={{ color: '#94a3b8', margin: '0 0 10px 0', fontSize: '12px' }}>🏦 TOTAL BANK LIABILITY (ACTIVE PRINCIPAL)</h3>
          <h1 style={{ color: '#ef4444', margin: 0, fontSize: '30px' }}>₹{totalPrincipalDue.toLocaleString('en-IN', {minimumFractionDigits: 2})}</h1>
        </div>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '5px solid #f59e0b' }}>
          <h3 style={{ color: '#94a3b8', margin: '0 0 10px 0', fontSize: '12px' }}>📅 EST. MONTHLY EMI COMMITMENT</h3>
          <h1 style={{ color: '#f59e0b', margin: 0, fontSize: '30px' }}>₹{totalEmiPerMonth.toLocaleString('en-IN', {minimumFractionDigits: 2})}+</h1>
        </div>
      </div>

      {/* 🔍 GLOBAL SEARCH BAR */}
      <div style={{ marginBottom: '20px' }}>
         <input type="text" className="modern-input" placeholder="🔍 Search by Vehicle No, Owner Name, Company, Bank Name, Loan Account, or UTR..." value={globalSearch} onChange={e => setGlobalSearch(e.target.value)} style={{ border: '1px solid #6366f1', fontSize: '15px', background: '#1e293b' }} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', borderBottom: '1px solid #334155', marginBottom: '20px' }}>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button className={`tab-btn ${activeTab === 'LOANS' ? 'active' : ''}`} onClick={() => setActiveTab('LOANS')}>🏦 VEHICLE LOAN MASTER</button>
          <button className={`tab-btn ${activeTab === 'EMIS' ? 'active' : ''}`} onClick={() => setActiveTab('EMIS')}>💸 EMI PAYMENT HISTORY</button>
          <button className={`tab-btn ${activeTab === 'REPORT' ? 'active' : ''}`} onClick={() => setActiveTab('REPORT')}>📊 EMI DUE REPORT</button>
          <button className={`tab-btn ${activeTab === 'TRACKER' ? 'active' : ''}`} onClick={() => setActiveTab('TRACKER')}>🗓️ EMI TRACKER</button>
          <button className={`tab-btn ${activeTab === 'LEDGER' ? 'active' : ''}`} onClick={() => setActiveTab('LEDGER')}>📜 LEDGER STATEMENT</button>
        </div>
      </div>

      {/* 📜 TAB 5: LEDGER STATEMENT — start-to-end history of one loan, printable.
          Rendered outside a glass-card on purpose: the component owns its own
          frame because that frame is what gets printed, and wrapping it in the
          dark chrome would put a border on the paper that nobody asked for. */}
      {activeTab === 'LEDGER' && <LoanLedgerStatement loans={loans} />}

      {/* 🏦 TAB 1: LOAN MASTER */}
      {activeTab === 'LOANS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          {loading ? <p style={{ color: '#818cf8' }}>Loading Bank Data...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Vehicle No</th><th>Company</th><th>Owner Name</th><th>Bank / A/C No</th><th>Type</th>
                  <th>EMI Structure</th><th>EMIs Cleared</th><th>Total Principal</th>
                  <th style={{ color: '#ef4444' }}>Remaining Bal.</th><th>Status</th><th style={{ textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredLoans.length === 0 ? <tr><td colSpan={11} style={{ textAlign: 'center', padding: '30px' }}>No Loans Found</td></tr> : 
                  filteredLoans.map((l, i) => {
                    const status = getVal(l, ['Payment_Status', 'status', 'payment_status'], 'ACTIVE');
                    
                    let showSlabs = false;
                    let showEmiBox = '';
                    if (l.repayment_schedule && Array.isArray(l.repayment_schedule) && l.repayment_schedule.length > 0) {
                        showEmiBox = <span style={{color: '#10b981', fontWeight: 'bold'}}>✅ Auto Schedule</span>;
                    } else if (l.emi_slabs && Array.isArray(l.emi_slabs) && l.emi_slabs.length > 0 && l.emi_slabs[0].amount) {
                        showSlabs = true;
                    } else {
                        showEmiBox = <div><b style={{ color: '#fff' }}>₹{getVal(l, ['EMI_Amount', 'emi_amount', 'amount', 'EMI'], '0')}</b></div>;
                    }

                    return (
                      <tr key={i} style={{ opacity: status === 'CLOSED' ? 0.6 : 1 }}>
                        <td><b style={{ color: '#fff', fontSize: '14px' }}>{getVal(l, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no'])}</b></td>
                        <td style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold' }}>🏢 {getRealCompany(l)}</td>
                        <td style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold' }}>👤 {getRealOwner(l)}</td>
                        <td>
                          {getVal(l, ['Bank_Name', 'bank_name', 'financier_name'])}<br/>
                          <span style={{ color: '#818cf8', fontWeight: 'bold', fontSize: '11px' }}>{getVal(l, ['Loan_Account_No', 'loan_account_no', 'account_no'])}</span>
                        </td>
                        <td><span className="badge" style={{ background: getVal(l, ['Loan_Type', 'loan_type']) === 'Chassis Loan' ? 'rgba(56,189,248,0.2)' : 'rgba(245,158,11,0.2)', color: getVal(l, ['Loan_Type', 'loan_type']) === 'Chassis Loan' ? '#38bdf8' : '#f59e0b' }}>{getVal(l, ['Loan_Type', 'loan_type'], 'Loan')}</span></td>
                        <td style={{ color: '#f59e0b', fontSize: '11px' }}>
                          {showSlabs ? l.emi_slabs.map((slab:any, idx:number) => (
                              <div key={idx} style={{ marginBottom: '3px' }}><span style={{ color: '#94a3b8' }}>{slab.date ? `[${new Date(slab.date).toLocaleDateString('en-GB')}] ` : ''}</span> M({slab.from_month}-{slab.to_month}): <b style={{ color: '#fff' }}>₹{slab.amount}</b></div>
                            )) : showEmiBox}
                        </td>
                        <td><span style={{ color: '#10b981', fontWeight: 'bold' }}>{getVal(l, ['EMIs_Completed', 'emis_completed', 'old_emis_paid'], '0')}</span> / {getVal(l, ['Tenure_Months', 'tenure_months', 'tenure'], '-')}</td>
                        <td>₹{parseNum(getVal(l, ['Principal_Amt', 'principal_amt', 'loan_amount', 'amount'])).toLocaleString('en-IN')}</td>
                        <td style={{ color: '#ef4444', fontWeight: '900', fontSize: '15px' }}>₹{parseNum(getVal(l, ['Remaining_Principal', 'remaining_principal', 'balance', 'Principal_Amt'])).toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        <td><span className="badge" style={{ background: status === 'ACTIVE' ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)', color: status === 'ACTIVE' ? '#10b981' : '#ef4444', border: `1px solid ${status === 'ACTIVE' ? '#10b981' : '#ef4444'}` }}>{status === 'CLOSED' ? 'DEACTIVE' : status}</span></td>
                        <td style={{ textAlign: 'center' }}>
                          <div style={{ display: 'flex', gap: '5px', justifyContent: 'center' }}>
                            <button onClick={() => handleEditLoan(l)} style={{ background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>✏️ Edit</button>
                            <button onClick={() => handleDeleteLoan(l.id)} style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>🗑️</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                }
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 💸 TAB 2: EMI PAYMENTS */}
      {activeTab === 'EMIS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
           <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '15px' }}>
              <div style={{ display: 'flex', gap: '15px', background: 'rgba(0,0,0,0.3)', padding: '10px', borderRadius: '10px' }}>
                 <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>From Date</label><input type="date" className="modern-input" style={{ padding: '5px 10px', colorScheme: 'dark' }} value={historyFromDate} onChange={e=>setHistoryFromDate(e.target.value)} /></div>
                 <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>To Date</label><input type="date" className="modern-input" style={{ padding: '5px 10px', colorScheme: 'dark' }} value={historyToDate} onChange={e=>setHistoryToDate(e.target.value)} /></div>
                 <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                   <button onClick={()=>{setHistoryFromDate(''); setHistoryToDate('');}} style={{ background: 'transparent', border: '1px solid #ef4444', color: '#ef4444', padding: '5px 15px', borderRadius: '5px', cursor: 'pointer', height: '32px' }}>Clear</button>
                 </div>
              </div>
              <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', padding: '10px 20px' }} onClick={handlePrintBankSheet}>
                🏦 Print Selected Bank Submission Sheet
              </button>
           </div>
           
           {Object.keys(groupedHistoryPayments).length === 0 ? (
             <div style={{ textAlign: 'center', padding: '30px', color: '#94a3b8' }}>No EMI Payments found for selected dates/search.</div>
           ) : (
             Object.keys(groupedHistoryPayments).map((key, idx) => {
               const group = groupedHistoryPayments[key];
               const first = group[0];
               const blockTotal = group.reduce((sum: number, p: any) => sum + parseNum(getVal(p, ['Total_EMI_Paid', 'total_emi', 'amount', 'EMI_Amount', 'Amount'])), 0);

               return (
                 <div key={idx} style={{ marginBottom: '30px', background: 'rgba(15,23,42,0.8)', border: '1px solid #334155', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 4px 6px rgba(0,0,0,0.3)' }}>
                   {/* BLOCK HEADER */}
                   <div style={{ background: 'rgba(16, 185, 129, 0.1)', padding: '15px 20px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
                      <div>
                        <h3 style={{ margin: '0 0 5px 0', color: '#10b981', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          📅 {getVal(first, ['Date_of_Payment', 'date_of_payment', 'date', 'EMI_Date', 'emi_date'])} 
                          <span className="badge" style={{ background: 'rgba(56,189,248,0.2)', color: '#38bdf8', fontSize: '12px' }}>{group.length} Vehicles</span>
                        </h3>
                        <span style={{ color: '#94a3b8', fontSize: '13px' }}>🏦 Paid From: <b style={{color: '#818cf8'}}>{getVal(first, ['Payment_From_Account'], 'N/A')}</b> | 🔖 Ref/UTR: <b style={{color: '#c084fc'}}>{getVal(first, ['Ref_No', 'ref_no', 'utr', 'transaction_id'], 'N/A')}</b></span>
                      </div>
                      <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: '20px' }}>
                        <div>
                          <span style={{ color: '#94a3b8', fontSize: '11px', textTransform: 'uppercase' }}>Total Block Payout</span>
                          <h2 style={{ margin: '0', color: '#fff' }}>₹{blockTotal.toLocaleString('en-IN', {minimumFractionDigits: 2})}</h2>
                        </div>
                        <button onClick={() => handleDeleteBlock(group)} style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', padding: '8px 15px', borderRadius: '8px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px' }}>
                          {loading ? '⏳ Deleting...' : '🗑️ Delete Entire Block'}
                        </button>
                      </div>
                   </div>
                   
                   {/* BLOCK TABLE */}
                   <div style={{ overflowX: 'auto', padding: '10px' }}>
                     <table style={{ margin: 0, width: '100%' }}>
                       <thead>
                         <tr>
                           <th>Vehicle No</th><th>Company</th><th>Owner Name</th><th>Bank / A/C No</th><th>Month/Year</th>
                           <th style={{ color: '#10b981' }}>Total EMI Paid</th><th style={{ color: '#38bdf8' }}>Principal Cut</th><th style={{ color: '#ef4444' }}>Interest Paid</th><th style={{ textAlign: 'center' }}>Action</th>
                         </tr>
                       </thead>
                       <tbody>
                          {group.map((p: any, i: number) => (
                            <tr key={i} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                              <td><b style={{ color: '#fff', fontSize: '14px' }}>{getVal(p, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no'])}</b></td>
                              <td style={{ color: '#38bdf8', fontSize: '11px', fontWeight: 'bold' }}>🏢 {getRealCompany(p)}</td>
                              <td style={{ color: '#10b981', fontSize: '11px', fontWeight: 'bold' }}>👤 {getRealOwner(p)}</td>
                              <td>{getVal(p, ['Bank_Name', 'bank_name', 'financier_name'])} <br/><small style={{color:'#818cf8', fontWeight:'bold'}}>{getVal(p, ['Loan_Account_No', 'loan_account_no', 'account_no'])}</small></td>
                              <td><span style={{ color: '#f59e0b', fontWeight: 'bold' }}>{getVal(p, ['EMI_Month_Year', 'month_year', 'month', 'EMI_Month'], 'N/A')}</span><br/><small style={{ color: '#cbd5e1' }}>Block: {getVal(p, ['Months_Paid', 'months_paid'], '1')} Mth</small></td>
                              <td style={{ color: '#10b981', fontWeight: 'bold', fontSize: '14px' }}>₹{parseNum(getVal(p, ['Total_EMI_Paid', 'total_emi', 'amount', 'EMI_Amount', 'Amount'])).toLocaleString('en-IN')}</td>
                              <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>₹{parseNum(getVal(p, ['Principal_Part', 'principal_part', 'principal'])).toLocaleString('en-IN')}</td>
                              <td style={{ color: '#ef4444', fontWeight: 'bold' }}>₹{parseNum(getVal(p, ['Interest_Part', 'interest_part', 'interest'])).toLocaleString('en-IN')}</td>
                              <td style={{ textAlign: 'center' }}>
                                <div style={{ display: 'flex', gap: '5px', justifyContent: 'center' }}>
                                  <button onClick={() => setPaymentEditData(p)} style={{ background: 'rgba(56, 189, 248, 0.1)', border: '1px solid #38bdf8', color: '#38bdf8', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>✏️ Edit</button>
                                  <button onClick={() => handleDeletePayment(p)} style={{ background: 'rgba(239, 68, 68, 0.1)', border: '1px solid #ef4444', color: '#ef4444', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>🗑️ Delete</button>
                                </div>
                              </td>
                            </tr>
                          ))}
                       </tbody>
                     </table>
                   </div>
                 </div>
               );
             })
           )}
        </div>
      )}

      {/* 📊 TAB 3: EMI DUE REPORT */}
      {activeTab === 'TRACKER' && (
        <>
          {trackerErr && (
            <div className="glass-card" style={{ padding: '18px', marginBottom: '18px', border: '1px solid #ef4444' }}>
              <b style={{ color: '#ef4444' }}>EMI tracker unavailable</b>
              <div style={{ color: '#94a3b8', fontSize: '12px', marginTop: '6px' }}>{trackerErr}</div>
            </div>
          )}
          {tracker && (() => {
            const rup = (n: number) => '₹' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
            const tile = (label: string, value: string, colour: string, note?: string) => (
              <div style={{ background: `${colour}1a`, padding: '14px 22px', border: `1px solid ${colour}`, borderRadius: '12px', minWidth: '170px' }}>
                <div style={{ color: colour, fontSize: '11px', fontWeight: 'bold', letterSpacing: '.4px' }}>{label}</div>
                <div style={{ fontSize: '24px', fontWeight: 900, color: '#fff', marginTop: '4px' }}>{value}</div>
                {note && <div style={{ color: '#94a3b8', fontSize: '10px', marginTop: '2px' }}>{note}</div>}
              </div>
            );
            return (
              <>
                <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginBottom: '18px' }}>
                  {tile('✅ PAID', String(tracker.totals.PAID), '#10b981', rup(tracker.money.paid))}
                  {tile('⚠️ OVERDUE', String(tracker.totals.OVERDUE), '#ef4444', rup(tracker.money.overdue))}
                  {tile('🗓️ UPCOMING', String(tracker.totals.UPCOMING), '#38bdf8', `next 6 months ${rup(tracker.money.upcoming)}`)}
                  {tile('📘 IN OPENING BAL.', String(tracker.totals.SETTLED_IN_OPENING), '#a78bfa', 'settled before cut-off')}
                </div>
                <div style={{ color: '#94a3b8', fontSize: '11px', marginBottom: '14px' }}>
                  Status is judged per instalment as at {tracker.as_of}. Instalments that fell due before a
                  loan's opening balance date are shown as settled in the opening balance, not as arrears —
                  they are already inside the figure carried into the books.
                </div>
                <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Loan / Vehicle</th><th>Financier</th><th>Type</th>
                        <th style={{ color: '#10b981' }}>Paid</th>
                        <th style={{ color: '#ef4444' }}>Overdue</th>
                        <th style={{ color: '#ef4444' }}>Overdue ₹</th>
                        <th>Next Due</th><th>Opening Principal</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tracker.tracker.map((t: any) => (
                        <tr key={t.loan_no}>
                          <td><b style={{ color: '#fff', fontSize: '13px' }}>{t.vehicle || '—'}</b><br/>
                              <span style={{ color: '#94a3b8', fontSize: '10px' }}>{t.loan_no}</span></td>
                          <td style={{ fontSize: '11px' }}>{t.financier}</td>
                          <td style={{ fontSize: '11px' }}>{t.loan_type}</td>
                          <td style={{ color: '#10b981', fontWeight: 'bold' }}>{t.paid_count}</td>
                          <td style={{ color: t.overdue_count ? '#ef4444' : '#64748b', fontWeight: 'bold' }}>{t.overdue_count}</td>
                          <td style={{ color: t.overdue_amount ? '#ef4444' : '#64748b', fontWeight: 'bold' }}>{rup(t.overdue_amount)}</td>
                          <td style={{ fontSize: '11px' }}>
                            {t.next_due
                              ? <><b style={{ color: '#38bdf8' }}>{t.next_due.due_date}</b><br/>{rup(t.next_due.emi)}</>
                              : <span style={{ color: '#94a3b8' }}>no forward schedule</span>}
                          </td>
                          <td style={{ fontSize: '11px' }}>
                            {t.opening_principal == null ? '—'
                              : <><b style={{ color: '#fff' }}>{rup(t.opening_principal)}</b><br/>
                                 <span style={{ color: '#94a3b8', fontSize: '10px' }}>as at {t.opening_as_of}</span></>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()}
        </>
      )}

      {activeTab === 'REPORT' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
             <div style={{ display: 'flex', gap: '20px' }}>
                <div style={{ background: 'rgba(239, 68, 68, 0.1)', padding: '15px 25px', border: '1px solid #ef4444', borderRadius: '12px' }}>
                  <div style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold' }}>⚠️ TOTAL OVERDUE AMOUNT</div>
                  <div style={{ fontSize: '28px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>₹{totalOverdueAmount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>
                </div>
             </div>
             <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #ec4899, #db2777)', padding: '15px 25px' }} onClick={handleEmailBankReport}>
                ✉️ Email Bank-wise Report
             </button>
          </div>

          <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
             <table>
                <thead>
                  <tr>
                    <th>Vehicle & Bank</th><th>Company</th><th>Owner Name</th><th>Current EMI</th><th>Tenure & Cleared</th>
                    <th style={{ color: '#f59e0b' }}>Pending EMIs</th><th style={{ color: '#ef4444' }}>Due Amount (₹)</th><th>Live Status</th>
                  </tr>
                </thead>
                <tbody>
                  {reportData.length === 0 ? <tr><td colSpan={8} style={{ textAlign: 'center', padding: '30px' }}>No Active Loans found for report.</td></tr> : 
                    reportData.map((r, i) => {
                      const curEmi = (r.currentEmiAmt || 0).toLocaleString('en-IN');
                      return (
                        <tr key={i}>
                          <td><b style={{ color: '#fff', fontSize: '14px' }}>{getVal(r, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'registration_no'])}</b><br/><span style={{ color: '#94a3b8', fontSize: '10px' }}>{getVal(r, ['Bank_Name', 'bank_name', 'financier_name'])}</span></td>
                          <td><span style={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '11px' }}>🏢 {getRealCompany(r)}</span></td>
                          <td><span style={{ color: '#10b981', fontWeight: 'bold', fontSize: '11px' }}>👤 {getRealOwner(r)}</span></td>
                          <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>₹{curEmi}</td>
                          <td><span style={{ color: '#10b981', fontWeight: 'bold' }}>{getVal(r, ['EMIs_Completed', 'emis_completed', 'old_emis_paid'], '0')}</span> / {getVal(r, ['Tenure_Months', 'tenure_months', 'tenure'], '-')}</td>
                          <td style={{ color: r.dueMonths > 0 ? '#ef4444' : '#10b981', fontWeight: 'bold', fontSize: '15px' }}>{r.dueMonths} Month(s)</td>
                          <td style={{ color: r.dueAmount > 0 ? '#ef4444' : '#cbd5e1', fontWeight: 'bold', fontSize: '15px' }}>₹{r.dueAmount.toLocaleString('en-IN')}</td>
                          <td><span style={{ color: r.color, fontWeight: 'bold', background: `${r.color}20`, padding: '5px 10px', borderRadius: '20px', border: `1px solid ${r.color}` }}>{r.status}</span></td>
                        </tr>
                      )
                    }
                  )}
                </tbody>
              </table>
          </div>
        </>
      )}

      {/* -------------------------------------------------------- */}
      {/* ✏️ MODAL: EDIT INDIVIDUAL EMI PAYMENT (WITH AUTO-ADJUST) */}
      {/* -------------------------------------------------------- */}
      {paymentEditData && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '800px', border: '1px solid #38bdf8', background: '#0f172a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#38bdf8' }}>✏️ Edit EMI Payment & Auto-Adjust Balances</h2>
              <button onClick={() => setPaymentEditData(null)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ background: 'rgba(0,0,0,0.3)', padding: '15px', borderRadius: '10px', marginBottom: '20px', display: 'flex', justifyContent: 'space-between' }}>
               <div><span style={{ color: '#94a3b8', fontSize: '12px' }}>Vehicle</span><br/><b style={{ color: '#fff', fontSize: '16px' }}>{getVal(paymentEditData, ['Vehicle_No', 'vehicle_no', 'registration_no'])}</b></div>
               <div><span style={{ color: '#94a3b8', fontSize: '12px' }}>Loan A/C</span><br/><b style={{ color: '#818cf8', fontSize: '16px' }}>{getVal(paymentEditData, ['Loan_Account_No'])}</b></div>
               <div><span style={{ color: '#94a3b8', fontSize: '12px' }}>Bank</span><br/><b style={{ color: '#10b981', fontSize: '16px' }}>{getVal(paymentEditData, ['Bank_Name'])}</b></div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Deduction Date</label><input type="date" className="modern-input" value={paymentEditData.Date_of_Payment} onChange={e=>setPaymentEditData({...paymentEditData, Date_of_Payment: e.target.value})} style={{colorScheme:'dark'}}/></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Paid From (Our Bank)</label>
                 <select className="modern-input" value={paymentEditData.Payment_From_Account} onChange={e=>setPaymentEditData({...paymentEditData, Payment_From_Account: e.target.value})}>
                    <option value="">-- Select Bank Account --</option>
                    {bankAccounts.map((b, i) => <option key={i} value={b}>{b}</option>)}
                 </select>
              </div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Mth/Year (e.g. Mar-26)</label><input type="text" className="modern-input" value={paymentEditData.EMI_Month_Year} onChange={e=>setPaymentEditData({...paymentEditData, EMI_Month_Year: e.target.value})} /></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Ref / UTR No</label><input type="text" className="modern-input" value={paymentEditData.Ref_No} onChange={e=>setPaymentEditData({...paymentEditData, Ref_No: e.target.value})} /></div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '15px', padding: '15px', background: 'rgba(245,158,11,0.05)', borderRadius: '10px', border: '1px dashed #f59e0b' }}>
               <div><label style={{ fontSize:'11px', color:'#38bdf8', fontWeight:'bold' }}>No. of EMIs</label><input type="number" className="modern-input" style={{ borderColor: '#38bdf8', color: '#38bdf8', fontWeight: 'bold' }} value={paymentEditData.Months_Paid} onChange={e=>setPaymentEditData({...paymentEditData, Months_Paid: e.target.value})} /></div>
               <div><label style={{ fontSize:'11px', color:'#10b981', fontWeight:'bold' }}>Total EMI Paid (₹)</label><input type="number" className="modern-input" style={{ borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }} value={paymentEditData.Total_EMI_Paid} onChange={e=>setPaymentEditData({...paymentEditData, Total_EMI_Paid: e.target.value})} /></div>
               <div><label style={{ fontSize:'11px', color:'#f59e0b', fontWeight:'bold' }}>Principal Cut (₹)</label><input type="number" className="modern-input" style={{ borderColor: '#f59e0b', color: '#f59e0b', fontWeight: 'bold' }} value={paymentEditData.Principal_Part} onChange={e=>setPaymentEditData({...paymentEditData, Principal_Part: e.target.value})} /></div>
               <div><label style={{ fontSize:'11px', color:'#ef4444', fontWeight:'bold' }}>Interest Paid (₹)</label><input type="number" className="modern-input" style={{ borderColor: '#ef4444', color: '#ef4444', fontWeight: 'bold' }} value={paymentEditData.Interest_Part} onChange={e=>setPaymentEditData({...paymentEditData, Interest_Part: e.target.value})} /></div>
            </div>
            
            <p style={{ fontSize: '11px', color: '#ef4444', textAlign: 'center', marginTop: '15px' }}>⚠️ Warning: Changing Principal or Month values here will automatically adjust the Main Loan Account's Remaining Balance.</p>
            
            <button className="glow-btn" style={{ width: '100%', marginTop: '10px', padding: '15px', fontSize: '16px' }} onClick={handleSaveEditedPayment} disabled={loading}>
              {loading ? '⏳ Updating...' : '✅ Save & Auto-Adjust Balances'}
            </button>
          </div>
        </div>
      )}

      {/* 🏦 MODAL 1: ADD / EDIT LOAN MASTER */}
      {isLoanModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '850px', border: '1px solid #6366f1', background: '#0f172a', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#818cf8' }}>{editingLoanId ? '✏️ Edit & Update Loan' : '🏦 Register Vehicle Loan'}</h2>
              <button onClick={() => setIsLoanModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', marginBottom: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight: 'bold' }}>Vehicle No *</label>
                <input 
                  className="modern-input" 
                  list="vehicle-list-options" 
                  placeholder="Search or Select Vehicle..."
                  value={loanData.Vehicle_No} 
                  onChange={e => {
                     const val = e.target.value;
                     const cleanVal = String(val).replace(/[^A-Z0-9]/ig, '').toUpperCase();
                     const selV = vehicles.find(v => {
                         const tempNo = String(getVal(v, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'vehicleno', 'registration_no', 'registrationno'])).replace(/[^A-Z0-9]/ig, '').toUpperCase();
                         return tempNo === cleanVal;
                     });
                     
                     setLoanData({
                         ...loanData, 
                         Vehicle_No: val, 
                         Owner_Name: selV ? getVal(selV, ['asset_owner_name', 'Asset_Owner_Name', 'asset_owner', 'Asset_Owner', 'owner_name', 'Owner_Name', 'ownername', 'owner'], 'PRASAD TRANSPORT') : 'PRASAD TRANSPORT', 
                         Company_Name: selV ? getVal(selV, ['operating_company', 'Operating_Company', 'company_name', 'Company_Name', 'company', 'companyname'], 'PRASAD TRANSPORT') : 'PRASAD TRANSPORT'
                     });
                  }}
                />
                <datalist id="vehicle-list-options">
                  {vehicles.map(v => {
                      const vNo = getVal(v, ['Vehicle_No', 'vehicle_no', 'vehical_no', 'vehicleno', 'registration_no', 'registrationno', 'Registration_No']);
                      return <option key={v.id} value={vNo} />
                  })}
                </datalist>
              </div>
              
              <div>
                <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight: 'bold' }}>Company Name *</label>
                <input 
                  className="modern-input" 
                  style={{ borderColor: '#38bdf8' }} 
                  list="company-list-options"
                  placeholder="Search or Type Company..."
                  value={loanData.Company_Name} 
                  onChange={e=>setLoanData({...loanData, Company_Name: e.target.value})} 
                />
                <datalist id="company-list-options">
                  {uniqueCompaniesList.map((comp, idx) => <option key={idx} value={comp} />)}
                </datalist>
              </div>

              <div>
                <label style={{ fontSize:'12px', color:'#10b981', fontWeight: 'bold' }}>Owner Name (Ledger) *</label>
                <input 
                  className="modern-input" 
                  style={{ borderColor: '#10b981' }} 
                  list="owner-list-options"
                  placeholder="Search or Type Owner..."
                  value={loanData.Owner_Name} 
                  onChange={e=>setLoanData({...loanData, Owner_Name: e.target.value})} 
                />
                <datalist id="owner-list-options">
                  {uniqueOwnersList.map((owner, idx) => <option key={idx} value={owner} />)}
                </datalist>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '15px', marginBottom: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8', fontWeight: 'bold' }}>Loan Type *</label>
                <select className="modern-input" value={loanData.Loan_Type} onChange={e=>setLoanData({...loanData, Loan_Type: e.target.value})}>
                  <option value="Chassis Loan">Chassis Loan (Company)</option>
                  <option value="Body Loan">Body Building Loan</option>
                  <option value="Refinance">Refinance / Top-up</option>
                </select>
              </div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Bank / Financier Name *</label><input className="modern-input" placeholder="e.g. HDFC Bank" value={loanData.Bank_Name} onChange={e=>setLoanData({...loanData, Bank_Name: e.target.value})} /></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Loan Account No *</label><input className="modern-input" value={loanData.Loan_Account_No} onChange={e=>setLoanData({...loanData, Loan_Account_No: e.target.value})} /></div>
            </div>

            <div style={{ gridColumn: 'span 2', background: 'rgba(245, 158, 11, 0.05)', padding: '15px', borderRadius: '10px', border: '1px dashed #f59e0b', marginBottom: '20px' }}>
               <h4 style={{ margin: '0 0 10px 0', color: '#f59e0b', fontSize: '13px' }}>⏳ Master Loan Setup (For Amortization)</h4>
               <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: '15px' }}>
                  <div><label style={{ fontSize:'11px', color:'#f59e0b', fontWeight:'bold' }}>Original Principal (₹) *</label><input type="number" className="modern-input" style={{ border:'1px solid #f59e0b', color: '#f59e0b', fontWeight: 'bold' }} placeholder="e.g. 2000000" value={loanData.Principal_Amt} onChange={e=>setLoanData({...loanData, Principal_Amt: e.target.value})} /></div>
                  <div><label style={{ fontSize:'11px', color:'#10b981', fontWeight:'bold' }}>Loan Start Date</label><input type="date" className="modern-input" value={loanData.As_On_Date} onChange={e=>setLoanData({...loanData, As_On_Date: e.target.value})} style={{colorScheme:'dark'}}/></div>
                  <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Total Tenure (Months)</label><input type="number" className="modern-input" placeholder="e.g. 48" value={loanData.Tenure_Months} onChange={e=>setLoanData({...loanData, Tenure_Months: e.target.value})} /></div>
                  <div><label style={{ fontSize:'11px', color:'#94a3b8' }}>Bank ROI (%)</label><input type="number" className="modern-input" placeholder="e.g. 8.5" value={loanData.Rate_Of_Interest} onChange={e=>setLoanData({...loanData, Rate_Of_Interest: e.target.value})} /></div>
                  
                  <div><label style={{ fontSize:'11px', color:'#c084fc', fontWeight:'bold' }}>Moratorium (Gap) Mths</label><input type="number" className="modern-input" style={{ border:'1px solid #c084fc', color: '#c084fc', fontWeight: 'bold' }} placeholder="e.g. 1 or 2" value={loanData.Moratorium_Months} onChange={e=>setLoanData({...loanData, Moratorium_Months: e.target.value})} /></div>
                  
                  <div><label style={{ fontSize:'11px', color:'#38bdf8', fontWeight:'bold' }}>Standard EMI (₹)</label><input type="number" className="modern-input" style={{ border:'1px solid #38bdf8', color: '#38bdf8', fontWeight: 'bold' }} placeholder="e.g. 45000" value={loanData.EMI_Amount} onChange={e=>setLoanData({...loanData, EMI_Amount: e.target.value})} /></div>

                  <div><label style={{ fontSize:'11px', color:'#10b981', fontWeight:'bold' }}>Remaining Bal (If Old) ₹</label><input type="number" className="modern-input" style={{ border:'1px solid #10b981', color: '#10b981', fontWeight: 'bold' }} placeholder="Leave blank if new" value={loanData.Remaining_Principal_As_On} onChange={e=>setLoanData({...loanData, Remaining_Principal_As_On: e.target.value})} /></div>
                  <div><label style={{ fontSize:'11px', color:'#38bdf8', fontWeight:'bold' }}>Old EMIs Paid</label><input type="number" className="modern-input" placeholder="e.g. 12" style={{ border:'1px solid #38bdf8', color: '#38bdf8', fontWeight: 'bold' }} value={loanData.Old_EMIs_Paid} onChange={e=>setLoanData({...loanData, Old_EMIs_Paid: e.target.value})} /></div>
                  
                  {editingLoanId && (
                    <div style={{ gridColumn: 'span 4' }}>
                      <label style={{ fontSize:'11px', color:'#ef4444', fontWeight:'bold' }}>Loan Status</label>
                      <select className="modern-input" style={{ border: '1px solid #ef4444', color: loanData.Payment_Status === 'ACTIVE' ? '#10b981' : '#ef4444', fontWeight: 'bold' }} value={loanData.Payment_Status} onChange={e=>setLoanData({...loanData, Payment_Status: e.target.value})}>
                        <option value="ACTIVE">🟢 ACTIVE</option><option value="CLOSED">🔴 CLOSED / DEACTIVE</option>
                      </select>
                    </div>
                  )}
               </div>
               
               <button onClick={generateSchedule} style={{ width: '100%', background: 'linear-gradient(135deg, #ec4899, #db2777)', color: 'white', border: 'none', padding: '10px', borderRadius: '5px', cursor: 'pointer', fontSize: '13px', fontWeight: 'bold', marginTop: '15px' }}>
                 🤖 Auto Generate Repayment Schedule (Reducing Balance)
               </button>
            </div>

            <div style={{ gridColumn: 'span 2', background: 'rgba(99, 102, 241, 0.1)', padding: '15px', borderRadius: '10px', border: '1px dashed #6366f1' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                <label style={{ fontSize:'13px', color:'#818cf8', fontWeight: 'bold' }}>{loanData.repayment_schedule && loanData.repayment_schedule.length > 0 ? '📊 Generated Amortization Schedule' : '📅 Manual EMI Structure (Step-up/Step-down)'}</label>
                {(!loanData.repayment_schedule || loanData.repayment_schedule.length === 0) && <button onClick={addEmiSlab} style={{ background: '#6366f1', color: 'white', border: 'none', padding: '5px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold' }}>+ Add EMI Slab</button>}
              </div>
              
              {loanData.repayment_schedule && loanData.repayment_schedule.length > 0 ? (
                <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                  <table style={{ width: '100%', textAlign: 'center', fontSize: '11px' }}>
                    <thead style={{ background: '#0f172a', position: 'sticky', top: 0 }}>
                      <tr><th>Month</th><th>Date</th><th>EMI</th><th>Interest</th><th>Principal</th><th>Balance</th></tr>
                    </thead>
                    <tbody>
                      {loanData.repayment_schedule.map((row:any, idx:number) => (
                        <tr key={idx} style={{ color: '#94a3b8' }}>
                          <td>{row.month_no}</td><td>{row.date}</td><td style={{color:'#10b981', fontWeight:'bold'}}>{row.emi}</td>
                          <td style={{color:'#ef4444'}}>{row.interest}</td><td style={{color:'#38bdf8'}}>{row.principal}</td>
                          <td style={{fontWeight:'bold'}}>{row.balance}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                loanData.emi_slabs.map((slab, index) => (
                  <div key={slab.id} style={{ display: 'flex', gap: '8px', marginBottom: '10px', alignItems: 'center' }}>
                    <div style={{ flex: 1.5 }}><input type="date" className="modern-input" title="EMI Deduction Date" value={slab.date} onChange={e=>updateEmiSlab(slab.id, 'date', e.target.value)} style={{colorScheme:'dark'}}/></div>
                    <div style={{ flex: 1 }}><input type="number" className="modern-input" placeholder="From Mth" value={slab.from_month} onChange={e=>updateEmiSlab(slab.id, 'from_month', e.target.value)} /></div>
                    <span style={{ color: '#94a3b8', fontSize: '12px' }}>To</span>
                    <div style={{ flex: 1 }}><input type="number" className="modern-input" placeholder="To Mth" value={slab.to_month} onChange={e=>updateEmiSlab(slab.id, 'to_month', e.target.value)} /></div>
                    <span style={{ color: '#94a3b8', fontSize: '12px' }}>EMI: ₹</span>
                    <div style={{ flex: 1.5 }}><input type="number" className="modern-input" placeholder="Amount" style={{ border: '1px solid #10b981', color: '#10b981', fontWeight: 'bold' }} value={slab.amount} onChange={e=>updateEmiSlab(slab.id, 'amount', e.target.value)} /></div>
                    {loanData.emi_slabs.length > 1 && <button onClick={() => removeEmiSlab(slab.id)} style={{ background: 'transparent', color: '#ef4444', border: 'none', cursor: 'pointer', fontSize: '18px' }}>✕</button>}
                  </div>
                ))
              )}
            </div>

            <button className="glow-btn" style={{ width: '100%', marginTop: '25px', padding: '15px', fontSize: '16px', justifyContent: 'center' }} onClick={handleSaveLoan} disabled={loading}>
              {loading ? '⏳ Saving...' : (editingLoanId ? '✅ Update & Save Changes' : '✅ Save Advanced Loan Account')}
            </button>
          </div>
        </div>
      )}

      {/* 💸 MODAL 2: 🚀 SMART BULK PAY EMI */}
      {isEmiModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.95)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '20px', width: '100%', maxWidth: '1400px', border: '1px solid #10b981', background: '#0f172a', maxHeight: '95vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '15px' }}>
              <h2 style={{ margin: 0, color: '#10b981' }}>🚀 Smart Bulk EMI Payment</h2>
              <button onClick={() => setIsEmiModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', background: '#1e293b', padding: '15px', borderRadius: '10px', flexWrap: 'wrap' }}>
               <div style={{ flex: 1, minWidth: '200px' }}>
                 <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight: 'bold' }}>1. Select Financier (Bank) *</label>
                 <select className="modern-input" value={bulkBankFilter} onChange={e => handleBankSelect(e.target.value)} style={{ border: '1px solid #38bdf8', fontWeight: 'bold' }}>
                    <option value="">-- Choose Bank to Fetch Loans --</option>
                    {uniqueBanks.map((b, i) => <option key={i} value={b}>{b}</option>)}
                 </select>
               </div>
               <div style={{ flex: 1, minWidth: '150px' }}>
                 <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight: 'bold' }}>2. Filter Loan Type</label>
                 <select className="modern-input" value={bulkTypeFilter} onChange={e => { setBulkTypeFilter(e.target.value); setSelectAll(false); }} style={{ border: '1px solid #38bdf8', fontWeight: 'bold' }}>
                    <option value="ALL">-- All Types --</option>
                    <option value="Chassis Loan">Chassis Loan</option>
                    <option value="Body Loan">Body Loan</option>
                    <option value="Refinance">Refinance</option>
                 </select>
               </div>
               
               {/* 🌟 SMART SEARCHABLE DROPDOWN FOR OWNER NAME FILTER */}
               <div style={{ flex: 1, minWidth: '150px' }}>
                 <label style={{ fontSize:'12px', color:'#38bdf8', fontWeight: 'bold' }}>3. Filter Owner Name</label>
                 <select className="modern-input" value={bulkOwnerFilter} onChange={e => { setBulkOwnerFilter(e.target.value); setSelectAll(false); }} style={{ border: '1px solid #38bdf8', fontWeight: 'bold' }}>
                    <option value="ALL">-- All Owners --</option>
                    {uniqueOwnersList.map((owner, i) => <option key={i} value={owner}>{owner}</option>)}
                 </select>
               </div>

               <div style={{ flex: 1, minWidth: '200px' }}>
                 <label style={{ fontSize:'12px', color:'#10b981', fontWeight: 'bold' }}>4. Payment From (Our Bank) *</label>
                 <select className="modern-input" value={multiEmi.Payment_From_Account} onChange={e=>setMultiEmi({...multiEmi, Payment_From_Account: e.target.value})} style={{ border: '1px solid #10b981', fontWeight: 'bold' }}>
                    <option value="">-- Select Bank Account --</option>
                    {bankAccounts.map((b, i) => <option key={i} value={b}>{b}</option>)}
                 </select>
               </div>
            </div>
            
            <div style={{ display: 'flex', gap: '15px', marginBottom: '20px', background: '#1e293b', padding: '15px', borderRadius: '10px', flexWrap: 'wrap' }}>
               <div style={{ flex: 1, minWidth: '150px' }}>
                 <label style={{ fontSize:'12px', color:'#94a3b8' }}>Deduction Date</label>
                 <input type="date" className="modern-input" value={multiEmi.Date_of_Payment} onChange={e=>setMultiEmi({...multiEmi, Date_of_Payment: e.target.value})} style={{colorScheme:'dark'}}/>
               </div>
               <div style={{ flex: 1, minWidth: '150px' }}>
                 <label style={{ fontSize:'12px', color:'#94a3b8' }}>Payment Mode</label>
                 <select className="modern-input" value={multiEmi.Payment_Mode} onChange={e=>setMultiEmi({...multiEmi, Payment_Mode: e.target.value})}>
                    <option value="Bank Auto-Debit">Bank Auto-Debit</option><option value="NEFT/RTGS">NEFT / RTGS</option>
                 </select>
               </div>
               <div style={{ flex: 1, minWidth: '150px' }}>
                 <label style={{ fontSize:'12px', color:'#94a3b8' }}>Ref No (Optional)</label>
                 <input type="text" className="modern-input" placeholder="UTR/Ref" value={multiEmi.Ref_No} onChange={e=>setMultiEmi({...multiEmi, Ref_No: e.target.value})}/>
               </div>
            </div>

            {bulkBankFilter && (
              <div style={{ overflowX: 'auto', background: 'rgba(0,0,0,0.3)', borderRadius: '10px', border: '1px solid #334155' }}>
                <table style={{ minWidth: '1000px' }}>
                  <thead>
                    <tr>
                      <th style={{ width: '40px', textAlign: 'center' }}>Sl</th>
                      <th style={{ width: '50px', textAlign: 'center' }}>
                        <input type="checkbox" checked={selectAll} onChange={handleToggleSelectAll} style={{ transform: 'scale(1.5)', cursor: 'pointer' }} title="Select All"/>
                      </th>
                      <th>Vehicle No</th>
                      <th>Entity (Company)</th>
                      <th>Owner Name</th>
                      <th>Loan A/C No</th>
                      <th>Type / Tenure</th>
                      <th style={{ color: '#ef4444' }}>Pending / Due</th>
                      <th>Mth/Yr</th>
                      <th style={{ color: '#38bdf8' }}>No. EMIs</th>
                      <th style={{ color: '#10b981' }}>Total EMI (₹)*</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEmiEntries.length === 0 ? <tr><td colSpan={11} style={{ textAlign: 'center' }}>No active loans found for this bank/type.</td></tr> :
                     filteredEmiEntries.map((e, i) => (
                      <tr key={e.id} className={e.selected ? 'selected' : ''}>
                        <td style={{ textAlign: 'center' }}>{i + 1}</td>
                        <td style={{ textAlign: 'center' }}>
                          <input type="checkbox" checked={e.selected} onChange={(ev) => handleEmiEntryChange(e.id, 'selected', ev.target.checked)} style={{ transform: 'scale(1.5)', cursor: 'pointer' }} />
                        </td>
                        <td><b style={{ color: '#fff' }}>{e._vehicle}</b></td>
                        <td style={{ color: '#38bdf8', fontSize: '11px', fontWeight: 'bold' }}>🏢 {e._company}</td>
                        <td style={{ color: '#10b981', fontSize: '11px', fontWeight: 'bold' }}>👤 {e._owner}</td>
                        <td style={{ color: '#818cf8', fontWeight: 'bold' }}>{e._loanAc}</td>
                        <td>
                           <span className="badge" style={{ background: '#334155' }}>{e._type}</span><br/>
                           <b style={{ color: '#10b981' }}>{e._cleared}</b> / {e._tenure}
                        </td>
                        <td>
                           <span style={{ color: e._dueStatus.dueMonths > 0 ? '#ef4444' : '#10b981', fontWeight: 'bold' }}>{e._dueStatus.dueMonths} Mths</span><br/>
                           <small style={{ color: e._dueStatus.dueAmount > 0 ? '#ef4444' : '#94a3b8' }}>₹{e._dueStatus.dueAmount.toLocaleString('en-IN')}</small>
                        </td>
                        <td><input className="smart-table-input" style={{ width: '80px' }} value={e.EMI_Month_Year} onChange={ev => handleEmiEntryChange(e.id, 'EMI_Month_Year', ev.target.value)} disabled={!e.selected}/></td>
                        <td><input type="number" className="smart-table-input" style={{ width: '60px', borderColor: '#38bdf8', color: '#38bdf8', fontWeight: 'bold' }} value={e.Months_Paid} onChange={ev => handleEmiEntryChange(e.id, 'Months_Paid', ev.target.value)} disabled={!e.selected}/></td>
                        <td><input type="number" className="smart-table-input" style={{ width: '100px', borderColor: '#10b981', color: '#10b981', fontWeight: 'bold' }} value={e.Total_EMI_Paid} onChange={ev => handleEmiEntryChange(e.id, 'Total_EMI_Paid', ev.target.value)} disabled={!e.selected}/></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '20px', padding: '20px', border: '1px solid #10b981', borderRadius: '10px', background: 'rgba(16,185,129,0.05)' }}>
               <div>
                 <p style={{ margin: 0, color: '#94a3b8', fontSize: '13px' }}>Grand Total Deducted from Bank (Selected Only):</p>
                 <h2 style={{ margin: 0, color: '#10b981', fontSize: '32px' }}>₹{currentTotalPayout.toLocaleString('en-IN', {minimumFractionDigits: 2})}</h2>
               </div>
               <button className="glow-btn" style={{ background: 'linear-gradient(135deg, #10b981, #059669)', padding: '15px 40px', fontSize: '18px' }} onClick={handleSaveMultiEmi} disabled={loading || currentTotalPayout === 0}>
                 {loading ? '⏳ Processing...' : '✅ Confirm Bulk Payment'}
               </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}