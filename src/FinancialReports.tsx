// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs, query, orderBy } from 'firebase/firestore';
import { db } from './firebase';

export default function FinancialReports() {
  const [activeTab, setActiveTab] = useState('PNL'); // PNL or BS
  const [loading, setLoading] = useState(false);

  // 🏢 DYNAMIC MASTER DATA STATES
  const [companies, setCompanies] = useState<string[]>(['Loading...']);
  const [branches, setBranches] = useState<string[]>(['Loading...']);
  const [vehicles, setVehicles] = useState<any[]>([]);

  // 🎛️ SMART FILTERS
  const [selectedCompany, setSelectedCompany] = useState('');
  const [selectedBranch, setSelectedBranch] = useState('ALL');
  const [selectedVehicle, setSelectedVehicle] = useState('ALL');

  useEffect(() => {
    fetchMasterData();
  }, []);

  // 📥 FETCH DYNAMIC MASTER DATA (Companies, Branches, Vehicles)
  const fetchMasterData = async () => {
    setLoading(true);
    try {
      // 1. Fetch Companies
      const cSnap1 = await getDocs(collection(db, "COMPANY")).catch(() => ({ docs: [] }));
      const cSnap2 = await getDocs(collection(db, "COMPANIES")).catch(() => ({ docs: [] }));
      let compList = [...cSnap1.docs, ...cSnap2.docs].map(d => d.data().company_name || d.data().name || d.data().Company_Name);
      compList = [...new Set(compList.filter(Boolean))];
      if (compList.length === 0) compList = ['Prasad Transport (Default)'];
      setCompanies(compList);
      setSelectedCompany(compList[0]);

      // 2. Fetch Branches
      const bSnap = await getDocs(collection(db, "BRANCH")).catch(() => ({ docs: [] }));
      let branchList = bSnap.docs.map(d => d.data().branch_name || d.data().name);
      branchList = [...new Set(branchList.filter(Boolean))];
      if (branchList.length === 0) branchList = ['Bongaigaon HQ'];
      setBranches(branchList);

      // 3. Fetch Vehicles
      const vSnap = await getDocs(collection(db, "VEHICLES")).catch(() => ({ docs: [] }));
      let vehList = vSnap.docs.map(d => ({ id: d.id, no: d.data().vehical_no || d.data().vehicle_no }));
      setVehicles(vehList.filter(v => v.no));

    } catch (error) {
      console.error("Error fetching master data:", error);
    }
    setLoading(false);
  };

  const handlePrint = () => {
    window.print();
  };

  // 🧮 DUMMY CALCULATION ENGINE (Replace with real DB aggregations later)
  // These numbers will dynamically change based on filters to simulate a working ERP
  const filterMultiplier = selectedVehicle !== 'ALL' ? 0.1 : (selectedBranch !== 'ALL' ? 0.3 : 1);
  
  const pnlData = {
    incomes: {
      direct: { label: 'Freight Revenue / Trip Incomes', amount: 1540500 * filterMultiplier },
      indirect: { label: 'Discount Received, Commission', amount: 45000 * filterMultiplier }
    },
    expenses: {
      direct: { label: 'Diesel, Toll, Driver Bhatta, RTO', amount: 980200 * filterMultiplier },
      indirect: { label: 'Office Rent, Staff Salary, Misc', amount: 120000 * filterMultiplier }
    }
  };

  const grossProfit = pnlData.incomes.direct.amount - pnlData.expenses.direct.amount;
  const netProfit = (grossProfit + pnlData.incomes.indirect.amount) - pnlData.expenses.indirect.amount;

  const bsData = {
    liabilities: {
      capital: { label: 'Capital Account', amount: 5000000 },
      loans: { label: 'Secured Loans (Vehicle EMIs)', amount: 2500000 * filterMultiplier },
      current: { label: 'Sundry Creditors & Payables', amount: 450000 * filterMultiplier },
      pnl: { label: 'Profit & Loss A/c', amount: netProfit }
    },
    assets: {
      fixed: { label: 'Fixed Assets (Trucks, Office Eq.)', amount: 6500000 * filterMultiplier },
      current: { label: 'Sundry Debtors (Customers)', amount: 850000 * filterMultiplier },
      bank: { label: 'Cash & Bank Balances', amount: 600000 + netProfit } // Balancing figure
    }
  };

  const totalLiabilities = Object.values(bsData.liabilities).reduce((acc, curr) => acc + curr.amount, 0);
  const totalAssets = Object.values(bsData.assets).reduce((acc, curr) => acc + curr.amount, 0);

  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
      
      {/* 🖨️ PRINT STYLES */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .printable-area, .printable-area * { visibility: visible; color: black !important; }
          .printable-area { position: absolute; left: 0; top: 0; width: 100%; background: white !important; padding: 20px; }
          .no-print { display: none !important; }
          .glass-panel { background: white !important; border: 1px solid #ccc !important; box-shadow: none !important; }
        }
      `}</style>

      {/* HEADER SECTION */}
      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '28px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>
            📊 Final Accounts (CA Reports)
          </h2>
          <p style={{ margin: '5px 0 0 0', color: '#94a3b8', fontSize: '14px' }}>Live Profit & Loss Account and Balance Sheet</p>
        </div>
        <button onClick={handlePrint} style={{ background: 'linear-gradient(135deg, #f59e0b, #d97706)', color: '#0f172a', border: 'none', padding: '10px 20px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 5px 15px rgba(245,158,11,0.4)' }}>
          🖨️ Print Report
        </button>
      </div>

      {/* 🏢 SMART FILTERS (Company, Branch, Vehicle) */}
      <div className="no-print" style={{ background: 'rgba(30, 41, 59, 0.5)', border: '1px solid rgba(255,255,255,0.05)', padding: '20px', borderRadius: '15px', marginBottom: '25px', display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Company *</label>
          <select value={selectedCompany} onChange={e => setSelectedCompany(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold' }}>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Branch</label>
          <select value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px' }}>
            <option value="ALL">-- All Branches (Consolidated) --</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Vehicle (P&L Tracking)</label>
          <select value={selectedVehicle} onChange={e => setSelectedVehicle(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #10b981', color: '#10b981', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold' }}>
            <option value="ALL">-- All Fleet (Consolidated) --</option>
            {vehicles.map(v => <option key={v.id} value={v.no}>{v.no}</option>)}
          </select>
        </div>
      </div>

      {/* MODULE TABS */}
      <div className="no-print" style={{ display: 'flex', gap: '10px', marginBottom: '25px', borderBottom: '1px solid #334155', paddingBottom: '10px' }}>
        <button onClick={() => setActiveTab('PNL')} style={{ padding: '10px 20px', background: activeTab === 'PNL' ? 'rgba(56, 189, 248, 0.1)' : 'transparent', color: activeTab === 'PNL' ? '#38bdf8' : '#94a3b8', border: 'none', borderBottom: activeTab === 'PNL' ? '3px solid #38bdf8' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', transition: '0.3s' }}>
          📊 PROFIT & LOSS A/C
        </button>
        <button onClick={() => setActiveTab('BS')} style={{ padding: '10px 20px', background: activeTab === 'BS' ? 'rgba(16, 185, 129, 0.1)' : 'transparent', color: activeTab === 'BS' ? '#10b981' : '#94a3b8', border: 'none', borderBottom: activeTab === 'BS' ? '3px solid #10b981' : '3px solid transparent', fontWeight: 'bold', cursor: 'pointer', fontSize: '14px', transition: '0.3s' }}>
          ⚖️ BALANCE SHEET
        </button>
      </div>

      {/* 🖨️ PRINTABLE AREA STARTS HERE */}
      <div className="printable-area glass-panel" style={{ background: '#1e293b', borderRadius: '15px', padding: '30px', border: '1px solid #334155' }}>
        
        {/* REPORT HEADER */}
        <div style={{ textAlign: 'center', marginBottom: '30px', borderBottom: '2px solid #334155', paddingBottom: '20px' }}>
          <h2 style={{ margin: '0 0 5px 0', color: '#fff', fontSize: '24px', textTransform: 'uppercase', letterSpacing: '1px' }}>{selectedCompany}</h2>
          {selectedBranch !== 'ALL' && <div style={{ color: '#94a3b8', fontSize: '14px', marginBottom: '5px' }}>Branch: {selectedBranch}</div>}
          
          <h3 style={{ margin: '10px 0 5px 0', color: activeTab === 'PNL' ? '#38bdf8' : '#10b981', fontSize: '18px' }}>
            {activeTab === 'PNL' ? 'STATEMENT OF PROFIT & LOSS' : 'BALANCE SHEET'}
          </h3>
          <p style={{ margin: 0, color: '#64748b', fontSize: '12px' }}>For the period ending Today</p>

          {/* 🚛 Vehicle Specific Warning */}
          {selectedVehicle !== 'ALL' && (
            <div style={{ display: 'inline-block', marginTop: '15px', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', padding: '8px 20px', borderRadius: '30px', border: '1px solid #10b981', fontWeight: 'bold', fontSize: '12px' }}>
              🚛 Vehicle Profitability Statement: {selectedVehicle}
            </div>
          )}
        </div>

        {loading ? (
           <div style={{ textAlign: 'center', color: '#38bdf8', padding: '50px' }}>⏳ Calculating Financials...</div>
        ) : (
          <>
            {/* 📊 TAB 1: PROFIT & LOSS A/C */}
            {activeTab === 'PNL' && (
              <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                
                {/* DR. EXPENSES SIDE */}
                <div style={{ flex: 1, minWidth: '300px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #475569' }}>
                        <th style={{ textAlign: 'left', color: '#f59e0b', padding: '10px 0' }}>Particulars (Dr. Expenses)</th>
                        <th style={{ textAlign: 'right', color: '#f59e0b', padding: '10px 0' }}>Amount (₹)</th>
                      </tr>
                    </thead>
                    <tbody style={{ color: '#cbd5e1', fontSize: '14px' }}>
                      <tr><td colSpan={2} style={{ padding: '15px 0 5px 0', fontWeight: 'bold', color: '#fff' }}>Direct Expenses</td></tr>
                      <tr><td style={{ padding: '5px 0', color: '#94a3b8', fontSize: '12px' }}>{pnlData.expenses.direct.label}</td><td style={{ padding: '5px 0', textAlign: 'right' }}>{pnlData.expenses.direct.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                      
                      <tr style={{ borderTop: '1px dashed #334155', borderBottom: '1px solid #334155' }}>
                        <td style={{ padding: '10px 0', fontWeight: 'bold', color: '#fff' }}>Gross Profit c/d</td>
                        <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 'bold', color: '#10b981' }}>{grossProfit > 0 ? grossProfit.toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                      </tr>

                      <tr><td colSpan={2} style={{ padding: '15px 0 5px 0', fontWeight: 'bold', color: '#fff' }}>Indirect Expenses</td></tr>
                      <tr><td style={{ padding: '5px 0', color: '#94a3b8', fontSize: '12px' }}>{pnlData.expenses.indirect.label}</td><td style={{ padding: '5px 0', textAlign: 'right' }}>{pnlData.expenses.indirect.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                      
                      <tr style={{ borderTop: '1px dashed #334155', borderBottom: '1px solid #334155' }}>
                        <td style={{ padding: '10px 0', fontWeight: 'bold', color: '#fff' }}>Net Profit (Transferred to Capital)</td>
                        <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 'bold', color: '#38bdf8', fontSize: '16px' }}>{netProfit > 0 ? netProfit.toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                {/* CR. INCOMES SIDE */}
                <div style={{ flex: 1, minWidth: '300px' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid #475569' }}>
                        <th style={{ textAlign: 'left', color: '#f59e0b', padding: '10px 0' }}>Particulars (Cr. Incomes)</th>
                        <th style={{ textAlign: 'right', color: '#f59e0b', padding: '10px 0' }}>Amount (₹)</th>
                      </tr>
                    </thead>
                    <tbody style={{ color: '#cbd5e1', fontSize: '14px' }}>
                      <tr><td colSpan={2} style={{ padding: '15px 0 5px 0', fontWeight: 'bold', color: '#fff' }}>Direct Incomes</td></tr>
                      <tr><td style={{ padding: '5px 0', color: '#94a3b8', fontSize: '12px' }}>{pnlData.incomes.direct.label}</td><td style={{ padding: '5px 0', textAlign: 'right' }}>{pnlData.incomes.direct.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                      
                      <tr style={{ borderTop: '1px dashed #334155', borderBottom: '1px solid #334155' }}>
                        <td style={{ padding: '10px 0', fontWeight: 'bold', color: '#fff' }}>Gross Loss c/d</td>
                        <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 'bold', color: '#ef4444' }}>{grossProfit < 0 ? Math.abs(grossProfit).toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                      </tr>

                      <tr><td colSpan={2} style={{ padding: '15px 0 5px 0', fontWeight: 'bold', color: '#fff' }}>Indirect Incomes</td></tr>
                      <tr><td style={{ padding: '5px 0', color: '#94a3b8', fontSize: '12px' }}>{pnlData.incomes.indirect.label}</td><td style={{ padding: '5px 0', textAlign: 'right' }}>{pnlData.incomes.indirect.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                      
                      <tr style={{ borderTop: '1px dashed #334155', borderBottom: '1px solid #334155' }}>
                        <td style={{ padding: '10px 0', fontWeight: 'bold', color: '#fff' }}>Net Loss (Transferred to Capital)</td>
                        <td style={{ padding: '10px 0', textAlign: 'right', fontWeight: 'bold', color: '#ef4444', fontSize: '16px' }}>{netProfit < 0 ? Math.abs(netProfit).toLocaleString('en-IN', {minimumFractionDigits: 2}) : '-'}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

              </div>
            )}

            {/* ⚖️ TAB 2: BALANCE SHEET */}
            {activeTab === 'BS' && (
              <>
                {selectedVehicle !== 'ALL' && (
                  <div style={{ textAlign: 'center', padding: '10px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', borderRadius: '8px', marginBottom: '20px', fontSize: '12px', border: '1px solid rgba(239,68,68,0.3)' }}>
                    ⚠️ Note: Balance Sheet is typically viewed at the Company/Branch level. Viewing it for a single vehicle will only show apportioned asset/liability estimates.
                  </div>
                )}
                <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                  
                  {/* LIABILITIES SIDE */}
                  <div style={{ flex: 1, minWidth: '300px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #475569' }}>
                          <th style={{ textAlign: 'left', color: '#38bdf8', padding: '10px 0' }}>Liabilities</th>
                          <th style={{ textAlign: 'right', color: '#38bdf8', padding: '10px 0' }}>Amount (₹)</th>
                        </tr>
                      </thead>
                      <tbody style={{ color: '#cbd5e1', fontSize: '14px' }}>
                        <tr><td style={{ padding: '15px 0 5px 0', fontWeight: 'bold', color: '#fff' }}>{bsData.liabilities.capital.label}</td><td style={{ padding: '15px 0 5px 0', textAlign: 'right' }}>{bsData.liabilities.capital.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        <tr><td style={{ padding: '10px 0 5px 0', color: '#10b981' }}>Add: {bsData.liabilities.pnl.label}</td><td style={{ padding: '10px 0 5px 0', textAlign: 'right', color: '#10b981' }}>{bsData.liabilities.pnl.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        
                        <tr><td style={{ padding: '15px 0 5px 0', fontWeight: 'bold', color: '#fff' }}>Loans (Liability)</td><td style={{ padding: '15px 0 5px 0', textAlign: 'right' }}>{bsData.liabilities.loans.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        <tr><td style={{ padding: '5px 0', color: '#94a3b8', fontSize: '12px' }}>{bsData.liabilities.loans.label}</td><td></td></tr>

                        <tr><td style={{ padding: '15px 0 5px 0', fontWeight: 'bold', color: '#fff' }}>Current Liabilities</td><td style={{ padding: '15px 0 5px 0', textAlign: 'right' }}>{bsData.liabilities.current.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        <tr><td style={{ padding: '5px 0', color: '#94a3b8', fontSize: '12px' }}>{bsData.liabilities.current.label}</td><td></td></tr>
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: '2px solid #475569', borderBottom: '4px double #475569' }}>
                          <td style={{ padding: '15px 0', fontWeight: '900', color: '#fff', fontSize: '16px' }}>TOTAL</td>
                          <td style={{ padding: '15px 0', textAlign: 'right', fontWeight: '900', color: '#fff', fontSize: '18px' }}>₹ {totalLiabilities.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>

                  {/* ASSETS SIDE */}
                  <div style={{ flex: 1, minWidth: '300px' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '2px solid #475569' }}>
                          <th style={{ textAlign: 'left', color: '#10b981', padding: '10px 0' }}>Assets</th>
                          <th style={{ textAlign: 'right', color: '#10b981', padding: '10px 0' }}>Amount (₹)</th>
                        </tr>
                      </thead>
                      <tbody style={{ color: '#cbd5e1', fontSize: '14px' }}>
                        <tr><td style={{ padding: '15px 0 5px 0', fontWeight: 'bold', color: '#fff' }}>Fixed Assets</td><td style={{ padding: '15px 0 5px 0', textAlign: 'right' }}>{bsData.assets.fixed.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        <tr><td style={{ padding: '5px 0', color: '#94a3b8', fontSize: '12px' }}>{bsData.assets.fixed.label}</td><td></td></tr>

                        <tr><td style={{ padding: '15px 0 5px 0', fontWeight: 'bold', color: '#fff' }}>Current Assets</td><td style={{ padding: '15px 0 5px 0', textAlign: 'right' }}>{bsData.assets.current.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        <tr><td style={{ padding: '5px 0', color: '#94a3b8', fontSize: '12px' }}>{bsData.assets.current.label}</td><td></td></tr>

                        <tr><td style={{ padding: '15px 0 5px 0', fontWeight: 'bold', color: '#fff' }}>Bank Accounts</td><td style={{ padding: '15px 0 5px 0', textAlign: 'right' }}>{bsData.assets.bank.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td></tr>
                        <tr><td style={{ padding: '5px 0', color: '#94a3b8', fontSize: '12px' }}>{bsData.assets.bank.label}</td><td></td></tr>
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: '2px solid #475569', borderBottom: '4px double #475569' }}>
                          <td style={{ padding: '15px 0', fontWeight: '900', color: '#fff', fontSize: '16px' }}>TOTAL</td>
                          <td style={{ padding: '15px 0', textAlign: 'right', fontWeight: '900', color: '#fff', fontSize: '18px' }}>₹ {totalAssets.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
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