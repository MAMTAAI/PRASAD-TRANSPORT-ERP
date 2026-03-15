import React, { useState, useEffect } from 'react';
import { collection, getDocs, addDoc, updateDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

export default function LoanEmiMgmt() {
  const [activeTab, setActiveTab] = useState('LOANS');
  const [loans, setLoans] = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const [isLoanModalOpen, setIsLoanModalOpen] = useState(false);
  const [isEmiModalOpen, setIsEmiModalOpen] = useState(false);

  // 🏦 Loan Master Data (Now with emi_slabs array)
  const [loanData, setLoanData] = useState({
    Loan_Account_No: '', Vehicle_No: '', Loan_Type: 'Chassis Loan', Bank_Name: '',
    Sanction_Date: '', Rate_Of_Interest: '', Principal_Amt: '', Interest_Amt: '',
    Tenure_Months: '', EMI_Start_Date: '', EMI_End_Date: '', 
    emi_slabs: [{ id: Date.now(), from_month: '1', to_month: '', amount: '' }], // 🔥 Structured EMI Slabs
    Remaining_Principal: '0', Total_Interest_Paid: '0', Payment_Status: 'ACTIVE'
  });

  // 💸 EMI Payment Data
  const [emiData, setEmiData] = useState({
    Loan_Account: '', EMI_Date: new Date().toISOString().split('T')[0],
    EMI_Month_Year: '', Total_EMI_Paid: '', Principal_Part: '', Interest_Part: '', Date_of_Payment: new Date().toISOString().split('T')[0]
  });

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const vSnap = await getDocs(collection(db, "VEHICLES"));
      setVehicles(vSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const lSnap = await getDocs(collection(db, "LOAN_MASTER"));
      setLoans(lSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const pSnap = await getDocs(collection(db, "EMI_PAYMENTS"));
      setPayments(pSnap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a,b) => new Date(b.Date_of_Payment).getTime() - new Date(a.Date_of_Payment).getTime()));
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // 🔥 ADD/REMOVE EMI SLABS
  const addEmiSlab = () => {
    setLoanData({ ...loanData, emi_slabs: [...loanData.emi_slabs, { id: Date.now(), from_month: '', to_month: '', amount: '' }] });
  };
  const updateEmiSlab = (id: number, field: string, value: string) => {
    const updated = loanData.emi_slabs.map(slab => slab.id === id ? { ...slab, [field]: value } : slab);
    setLoanData({ ...loanData, emi_slabs: updated });
  };
  const removeEmiSlab = (id: number) => {
    setLoanData({ ...loanData, emi_slabs: loanData.emi_slabs.filter(slab => slab.id !== id) });
  };

  // 📝 SAVE NEW LOAN
  const handleSaveLoan = async () => {
    if (!loanData.Loan_Account_No || !loanData.Vehicle_No || !loanData.Principal_Amt) return alert("Account No, Vehicle, and Principal Amount are required!");
    try {
      const initialRemaining = parseFloat(loanData.Principal_Amt).toFixed(2);
      await addDoc(collection(db, "LOAN_MASTER"), { 
        ...loanData, Remaining_Principal: initialRemaining, Total_Interest_Paid: '0', createdAt: serverTimestamp() 
      });
      alert("✅ Vehicle Loan with Structured EMI Added!");
      setIsLoanModalOpen(false); fetchData();
    } catch (e) { alert("Error saving loan."); }
  };

  // 💰 SAVE EMI PAYMENT & DEDUCT PRINCIPAL
  const handleSaveEmi = async () => {
    if (!emiData.Loan_Account || !emiData.Total_EMI_Paid) return alert("Select Loan and enter EMI Amount!");
    try {
      const selectedLoan = loans.find(l => l.id === emiData.Loan_Account);
      if (!selectedLoan) return;

      const principalPaid = parseFloat(emiData.Principal_Part || '0');
      const interestPaid = parseFloat(emiData.Interest_Part || '0');
      
      let newRemaining = parseFloat(selectedLoan.Remaining_Principal || selectedLoan.Principal_Amt) - principalPaid;
      let newTotalInterest = parseFloat(selectedLoan.Total_Interest_Paid || '0') + interestPaid;
      
      let newStatus = selectedLoan.Payment_Status;
      if (newRemaining <= 0) { newRemaining = 0; newStatus = 'CLOSED'; }

      await addDoc(collection(db, "EMI_PAYMENTS"), { 
        ...emiData, Loan_Account_No: selectedLoan.Loan_Account_No, Vehicle_No: selectedLoan.Vehicle_No, Bank_Name: selectedLoan.Bank_Name, createdAt: serverTimestamp() 
      });

      await updateDoc(doc(db, "LOAN_MASTER", selectedLoan.id), { 
        Remaining_Principal: newRemaining.toFixed(2), Total_Interest_Paid: newTotalInterest.toFixed(2), Payment_Status: newStatus
      });

      alert("✅ EMI Paid! Loan Balance Updated Successfully.");
      setIsEmiModalOpen(false); fetchData();
    } catch (e) { alert("Error saving EMI."); }
  };

  // Dashboard Totals
  const totalPrincipalDue = loans.reduce((acc, curr) => acc + parseFloat(curr.Remaining_Principal || '0'), 0);
  // Get first slab amount for current monthly commitment roughly
  const totalEmiPerMonth = loans.filter(l => l.Payment_Status === 'ACTIVE').reduce((acc, curr) => {
    const firstSlabAmt = curr.emi_slabs && curr.emi_slabs.length > 0 ? parseFloat(curr.emi_slabs[0].amount || '0') : 0;
    return acc + firstSlabAmt;
  }, 0);

  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
      <style>{`
        .glass-card { background: rgba(30, 41, 59, 0.4); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; }
        .glow-btn { background: linear-gradient(135deg, #6366f1, #4f46e5); color: white; border: none; padding: 10px 20px; border-radius: 8px; font-weight: bold; cursor: pointer; transition: 0.3s; }
        .glow-btn:hover { box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4); transform: translateY(-2px); }
        .tab-btn { padding: 12px 25px; background: transparent; color: #94a3b8; border: none; border-bottom: 3px solid transparent; cursor: pointer; font-weight: bold; font-size: 14px; }
        .tab-btn.active { color: #818cf8; border-bottom: 3px solid #818cf8; background: rgba(129, 140, 248, 0.1); border-radius: 8px 8px 0 0; }
        .modern-input { background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(51, 65, 85, 0.8); border-radius: 8px; color: white; padding: 10px; width: 100%; box-sizing: border-box; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; color: #cbd5e1; font-size: 13px; }
        th { background: rgba(255,255,255,0.05); padding: 12px; text-align: left; border-bottom: 2px solid #334155; color: #818cf8; }
        td { padding: 12px; border-bottom: 1px solid #334155; }
        .badge { padding: 4px 8px; border-radius: 12px; font-size: 10px; font-weight: bold; }
      `}</style>

      {/* 🚀 Header & Dashboard */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
        <div>
          <h1 style={{ margin: 0, color: '#f8fafc', fontSize: '32px' }}>Finance & EMI Command</h1>
          <p style={{ color: '#94a3b8', margin: '5px 0' }}>Vehicle-wise Chassis & Body Loan Tracking (Structured EMIs)</p>
        </div>
        <div style={{ display: 'flex', gap: '15px' }}>
          <button className="glow-btn" style={{ background: '#10b981' }} onClick={() => setIsEmiModalOpen(true)}>💸 Pay EMI</button>
          <button className="glow-btn" onClick={() => { setLoanData({...loanData, Loan_Account_No: '', emi_slabs: [{ id: Date.now(), from_month: '1', to_month: '', amount: '' }]}); setIsLoanModalOpen(true); }}>🏦 Add New Loan</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px', marginBottom: '30px' }}>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '5px solid #ef4444' }}>
          <h3 style={{ color: '#94a3b8', margin: '0 0 10px 0', fontSize: '12px' }}>🏦 TOTAL BANK LIABILITY (REMAINING PRINCIPAL)</h3>
          <h1 style={{ color: '#ef4444', margin: 0, fontSize: '30px' }}>₹{totalPrincipalDue.toFixed(2)}</h1>
        </div>
        <div className="glass-card" style={{ padding: '20px', borderLeft: '5px solid #f59e0b' }}>
          <h3 style={{ color: '#94a3b8', margin: '0 0 10px 0', fontSize: '12px' }}>📅 EST. MONTHLY EMI COMMITMENT</h3>
          <h1 style={{ color: '#f59e0b', margin: 0, fontSize: '30px' }}>₹{totalEmiPerMonth.toFixed(2)}+</h1>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #334155' }}>
        <button className={`tab-btn ${activeTab === 'LOANS' ? 'active' : ''}`} onClick={() => setActiveTab('LOANS')}>🏦 VEHICLE LOAN MASTER</button>
        <button className={`tab-btn ${activeTab === 'EMIS' ? 'active' : ''}`} onClick={() => setActiveTab('EMIS')}>💸 EMI PAYMENT HISTORY</button>
      </div>

      {/* 🏦 TAB 1: LOAN MASTER */}
      {activeTab === 'LOANS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
          {loading ? <p style={{ color: '#818cf8' }}>Loading Bank Data...</p> : (
            <table>
              <thead>
                <tr>
                  <th>Vehicle No</th>
                  <th>Bank Name</th>
                  <th>Loan A/C No</th>
                  <th>Type</th>
                  <th>EMI Structure</th>
                  <th>Total Principal</th>
                  <th>Remaining Bal.</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {loans.length === 0 ? <tr><td colSpan={8} style={{ textAlign: 'center', padding: '30px' }}>No Active Loans</td></tr> : 
                  loans.map((l, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 'bold', color: '#fff', fontSize: '16px' }}>{l.Vehicle_No}</td>
                    <td>{l.Bank_Name}</td>
                    <td style={{ color: '#818cf8' }}>{l.Loan_Account_No}</td>
                    <td>
                      <span className="badge" style={{ background: l.Loan_Type === 'Chassis Loan' ? 'rgba(56,189,248,0.2)' : 'rgba(245,158,11,0.2)', color: l.Loan_Type === 'Chassis Loan' ? '#38bdf8' : '#f59e0b' }}>{l.Loan_Type}</span>
                    </td>
                    <td style={{ color: '#f59e0b', fontSize: '11px' }}>
                      {l.emi_slabs && l.emi_slabs.map((slab:any, idx:number) => (
                        <div key={idx}>M({slab.from_month}-{slab.to_month}): <b>₹{slab.amount}</b></div>
                      ))}
                    </td>
                    <td>₹{l.Principal_Amt}</td>
                    <td style={{ color: '#ef4444', fontWeight: 'bold', fontSize: '15px' }}>₹{l.Remaining_Principal}</td>
                    <td>
                      <span className="badge" style={{ background: l.Payment_Status === 'ACTIVE' ? 'rgba(16,185,129,0.2)' : 'rgba(148,163,184,0.2)', color: l.Payment_Status === 'ACTIVE' ? '#10b981' : '#94a3b8' }}>{l.Payment_Status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* 💸 TAB 2: EMI PAYMENTS */}
      {activeTab === 'EMIS' && (
        <div className="glass-card" style={{ padding: '20px', overflowX: 'auto' }}>
           {/* ... (Same as before) */}
           <table>
              <thead>
                <tr>
                  <th>Payment Date</th>
                  <th>Vehicle No</th>
                  <th>Bank / A/C No</th>
                  <th>Month/Year</th>
                  <th>Total EMI Paid</th>
                  <th>Principal Cut</th>
                  <th>Interest Paid</th>
                </tr>
              </thead>
              <tbody>
                {payments.length === 0 ? <tr><td colSpan={7} style={{ textAlign: 'center', padding: '30px' }}>No EMI Payments found</td></tr> : 
                  payments.map((p, i) => (
                  <tr key={i}>
                    <td>{p.Date_of_Payment}</td>
                    <td style={{ fontWeight: 'bold', color: '#fff' }}>{p.Vehicle_No}</td>
                    <td>{p.Bank_Name} <br/><small style={{color:'#818cf8'}}>{p.Loan_Account_No}</small></td>
                    <td>{p.EMI_Month_Year}</td>
                    <td style={{ color: '#10b981', fontWeight: 'bold' }}>₹{p.Total_EMI_Paid}</td>
                    <td style={{ color: '#38bdf8' }}>₹{p.Principal_Part}</td>
                    <td style={{ color: '#ef4444' }}>₹{p.Interest_Part}</td>
                  </tr>
                ))}
              </tbody>
            </table>
        </div>
      )}

      {/* 🏦 MODAL 1: ADD LOAN (STRUCTURED EMI) */}
      {isLoanModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '800px', border: '1px solid #6366f1', background: '#0f172a', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, color: '#818cf8' }}>🏦 Register Vehicle Loan</h2>
              <button onClick={() => setIsLoanModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Vehicle No *</label>
                <select className="modern-input" value={loanData.Vehicle_No} onChange={e=>setLoanData({...loanData, Vehicle_No: e.target.value})}>
                  <option value="">-- Select Vehicle --</option>
                  {vehicles.map(v => <option key={v.id} value={v.vehicle_no}>{v.vehicle_no}</option>)}
                </select>
              </div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Loan Type *</label>
                <select className="modern-input" value={loanData.Loan_Type} onChange={e=>setLoanData({...loanData, Loan_Type: e.target.value})}>
                  <option value="Chassis Loan">Chassis Loan (Company)</option>
                  <option value="Body Loan">Body Building Loan</option>
                  <option value="Refinance">Refinance / Top-up</option>
                </select>
              </div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Bank / Financier Name *</label><input className="modern-input" placeholder="e.g. HDFC Bank" value={loanData.Bank_Name} onChange={e=>setLoanData({...loanData, Bank_Name: e.target.value})} /></div>
              <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Loan Account No *</label><input className="modern-input" value={loanData.Loan_Account_No} onChange={e=>setLoanData({...loanData, Loan_Account_No: e.target.value})} /></div>
              
              <div style={{ gridColumn: 'span 2', background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '10px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                  <div><label style={{ fontSize:'12px', color:'#f59e0b', fontWeight:'bold' }}>Principal Amt (₹) *</label><input type="number" className="modern-input" style={{ border:'1px solid #f59e0b' }} value={loanData.Principal_Amt} onChange={e=>setLoanData({...loanData, Principal_Amt: e.target.value})} /></div>
                  <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>ROI (%)</label><input type="number" className="modern-input" value={loanData.Rate_Of_Interest} onChange={e=>setLoanData({...loanData, Rate_Of_Interest: e.target.value})} /></div>
                  <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Total Tenure (Months)</label><input type="number" className="modern-input" value={loanData.Tenure_Months} onChange={e=>setLoanData({...loanData, Tenure_Months: e.target.value})} /></div>
                </div>
              </div>

              {/* 🔥 STRUCTURED EMI SLABS UI 🔥 */}
              <div style={{ gridColumn: 'span 2', background: 'rgba(99, 102, 241, 0.1)', padding: '15px', borderRadius: '10px', border: '1px dashed #6366f1' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <label style={{ fontSize:'13px', color:'#818cf8', fontWeight: 'bold' }}>📅 EMI Structure (Step-up/Step-down EMIs)</label>
                  <button onClick={addEmiSlab} style={{ background: '#6366f1', color: 'white', border: 'none', padding: '5px 10px', borderRadius: '5px', cursor: 'pointer', fontSize: '11px' }}>+ Add EMI Slab</button>
                </div>
                
                {loanData.emi_slabs.map((slab, index) => (
                  <div key={slab.id} style={{ display: 'flex', gap: '10px', marginBottom: '10px', alignItems: 'center' }}>
                    <div style={{ flex: 1 }}><input type="number" className="modern-input" placeholder="From Month (e.g. 1)" value={slab.from_month} onChange={e=>updateEmiSlab(slab.id, 'from_month', e.target.value)} /></div>
                    <span style={{ color: '#94a3b8' }}>To</span>
                    <div style={{ flex: 1 }}><input type="number" className="modern-input" placeholder="To Month (e.g. 8)" value={slab.to_month} onChange={e=>updateEmiSlab(slab.id, 'to_month', e.target.value)} /></div>
                    <span style={{ color: '#94a3b8' }}>EMI: ₹</span>
                    <div style={{ flex: 2 }}><input type="number" className="modern-input" placeholder="Amount (e.g. 15000)" style={{ border: '1px solid #10b981' }} value={slab.amount} onChange={e=>updateEmiSlab(slab.id, 'amount', e.target.value)} /></div>
                    {loanData.emi_slabs.length > 1 && (
                      <button onClick={() => removeEmiSlab(slab.id)} style={{ background: 'transparent', color: '#ef4444', border: 'none', cursor: 'pointer', fontSize: '18px' }}>🗑️</button>
                    )}
                  </div>
                ))}
                <p style={{ fontSize: '11px', color: '#94a3b8', margin: 0 }}>Example: Month 1 to 8 = ₹15,000 | Month 9 to 47 = ₹50,000 | Month 48 to 48 = ₹20,000</p>
              </div>

            </div>
            <button className="glow-btn" style={{ width: '100%', marginTop: '20px' }} onClick={handleSaveLoan}>✅ Save Loan Account</button>
          </div>
        </div>
      )}

      {/* 💸 MODAL 2: PAY EMI (Remains the same as before, allowing flexible amount entry) */}
      {isEmiModalOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2,6,23,0.9)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000, padding: '20px' }}>
          <div className="glass-card" style={{ padding: '30px', width: '100%', maxWidth: '500px', border: '1px solid #10b981', background: '#0f172a' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, color: '#10b981' }}>💸 Pay EMI & Deduct Balance</h2>
              <button onClick={() => setIsEmiModalOpen(false)} style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div>
                <label style={{ fontSize:'12px', color:'#94a3b8' }}>Select Active Loan Account *</label>
                <select className="modern-input" value={emiData.Loan_Account} onChange={e => {
                  const sLoan = loans.find(l => l.id === e.target.value);
                  // Default to first slab amount if available
                  const defaultEmi = sLoan?.emi_slabs?.length > 0 ? sLoan.emi_slabs[0].amount : '';
                  setEmiData({...emiData, Loan_Account: e.target.value, Total_EMI_Paid: defaultEmi});
                }}>
                  <option value="">-- Choose Loan --</option>
                  {loans.filter(l => l.Payment_Status === 'ACTIVE').map(l => (
                    <option key={l.id} value={l.id}>{l.Vehicle_No} - {l.Bank_Name} ({l.Loan_Type})</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Payment Date</label><input type="date" className="modern-input" value={emiData.Date_of_Payment} onChange={e=>setEmiData({...emiData, Date_of_Payment: e.target.value})} /></div>
                <div><label style={{ fontSize:'12px', color:'#94a3b8' }}>Month/Year (e.g. Mar-2026)</label><input className="modern-input" placeholder="Mar-2026" value={emiData.EMI_Month_Year} onChange={e=>setEmiData({...emiData, EMI_Month_Year: e.target.value})} /></div>
              </div>

              <div><label style={{ fontSize:'12px', color:'#10b981', fontWeight:'bold' }}>Total EMI Paid (₹) *</label>
                <input type="number" className="modern-input" style={{ border: '1px solid #10b981', fontSize: '18px', fontWeight: 'bold' }} value={emiData.Total_EMI_Paid} onChange={e=>setEmiData({...emiData, Total_EMI_Paid: e.target.value})} />
              </div>

              <div style={{ background: 'rgba(255,255,255,0.05)', padding: '15px', borderRadius: '8px', border: '1px dashed #64748b' }}>
                <p style={{ margin: '0 0 10px 0', fontSize: '12px', color: '#f59e0b' }}>Split EMI (Required for accurate Balance)</p>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div><label style={{ fontSize:'11px', color:'#38bdf8' }}>Principal Cut (₹) *</label><input type="number" className="modern-input" value={emiData.Principal_Part} onChange={e=>setEmiData({...emiData, Principal_Part: e.target.value})} placeholder="Reduces Loan" /></div>
                  <div><label style={{ fontSize:'11px', color:'#ef4444' }}>Interest Paid (₹) *</label><input type="number" className="modern-input" value={emiData.Interest_Part} onChange={e=>setEmiData({...emiData, Interest_Part: e.target.value})} placeholder="Bank Profit" /></div>
                </div>
              </div>
            </div>
            
            <button className="glow-btn" style={{ width: '100%', marginTop: '25px', background: '#10b981' }} onClick={handleSaveEmi}>💸 Confirm EMI & Update Balance</button>
          </div>
        </div>
      )}

    </div>
  );
}