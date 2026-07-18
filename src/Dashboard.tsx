// @ts-nocheck
import React, { useState, useEffect, useRef } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from './firebase';
import { scopeCurrent } from './lib/rbac';
import { getTripFreight, getTripExpense, round2 } from './lib/accounting/tripMath';

interface DashboardProps {
  activeModule: string; 
  currentUser?: any; 
}

// --- 🛠️ GOOGLE TOOLS COMPONENT ---
const GoogleTools = () => (
  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginLeft: '15px' }}>
    <a href="https://mail.google.com/mail/u/0/#inbox" target="_blank" rel="noreferrer" title="Gmail"
       style={{ background: '#1e293b', border: '1px solid #334155', padding: '8px', borderRadius: '8px', display: 'flex', transition: '0.3s' }}>
      <img src="https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg" width="20" alt="Gmail" />
    </a>
    <a href="https://calendar.google.com/calendar/u/0/r" target="_blank" rel="noreferrer" title="Calendar"
       style={{ background: '#1e293b', border: '1px solid #334155', padding: '8px', borderRadius: '8px', display: 'flex', transition: '0.3s' }}>
      <img src="https://upload.wikimedia.org/wikipedia/commons/a/a5/Google_Calendar_icon_%282020%29.svg" width="20" alt="Calendar" />
    </a>
  </div>
);

// 🔥 CRASH-FREE FIELD EXTRACTOR
const getVal = (obj: any, keysArr: string[]) => {
  if(!obj) return '';
  const objKeys = Object.keys(obj);
  for(const k of keysArr) {
      const target = k.toLowerCase().replace(/[^a-z0-9]/g, '');
      const found = objKeys.find(ok => ok.toLowerCase().replace(/[^a-z0-9]/g, '') === target);
      if(found && obj[found]) return obj[found];
  }
  return '';
};

// 🔥 CRASH-FREE DATE PARSER
const parseSafeDate = (dObj: any) => {
    if (!dObj) return new Date();
    if (dObj.seconds) return new Date(dObj.seconds * 1000);
    if (typeof dObj === 'string' && dObj.includes('-')) {
        const parts = dObj.split('-');
        if (parts[0].length === 2 && parts[2]?.length === 4) {
            return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`); 
        }
    }
    return new Date(dObj);
};

export default function Dashboard({ activeModule, currentUser }: DashboardProps) {
  const [loading, setLoading] = useState(false);

  // DATA STATES
  const [companies, setCompanies] = useState<string[]>([]);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [trips, setTrips] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]); 
  const [vendors, setVendors] = useState<any[]>([]);       
  const [driverTxns, setDriverTxns] = useState<any[]>([]); 
  const [maintLogs, setMaintLogs] = useState<any[]>([]);

  // CONFIG & MODALS
  const [alertThreshold, setAlertThreshold] = useState(15);
  const [timeRange, setTimeRange] = useState('ALL'); 
  const [selectedCompany, setSelectedCompany] = useState('ALL');
  const [detailModal, setDetailModal] = useState<string | null>(null);
  const [selectedPerfVehicle, setSelectedPerfVehicle] = useState<string>('');

  // DASHBOARD CONFIG
  const [dashConfig, setDashConfig] = useState({ showPipeline: true, showAnalytics: true, showAlerts: true, showAiAudit: true });

  // 🎬 AI AD STUDIO STATES
  const [adProduct, setAdProduct] = useState('');
  const [generatedScript, setGeneratedScript] = useState('');
  const [adType, setAdType] = useState('PHOTO'); 

  // 🤖 MAMTA AI CHAT STATES
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [aiInput, setAiInput] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [chatMessages, setChatMessages] = useState([
    { sender: 'ai', text: 'नमस्ते सुभाष सर! मैं आपकी AI असिस्टेंट ममता हूँ। आप मुझसे फ्लीट का डेटा या गाड़ियों की जानकारी पूछ सकते हैं।' }
  ]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const activeModString = String(activeModule || '').toUpperCase();
  const isFinanceModule = activeModString.includes('FINANCE') || activeModString.includes('ACCOUNT') || activeModString.includes('ADMIN');
  const isCrmModule = activeModString.includes('CRM') || activeModString.includes('MAMTA');

  const isAdmin = currentUser?.role === 'ADMIN' || currentUser?.role === 'Super Admin';

  // Fetch once per mount — the data doesn't depend on which module tab is
  // active (the old [activeModule] dep re-downloaded all 9 collections on
  // every top-nav click).
  useEffect(() => {
    setLoading(true);
    fetchMasterData().then(() => setLoading(false)).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, isAiOpen]);

  const fetchMasterData = async () => {
    try {
      // All 9 collections in parallel — the old sequential awaits made cold
      // load time the SUM of round trips instead of the slowest one.
      const [vSnap, dSnap, tSnap, custSnap, venSnap, txnSnap, mSnap, cSnap1, cSnap2] = await Promise.all([
        getDocs(collection(db, "VEHICLES")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "DRIVERS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "TRIPS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "CUSTOMERS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "VENDORS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "DRIVER_TRANSACTIONS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "MAINTENANCE_LOGS")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "COMPANY")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "COMPANIES")).catch(() => ({ docs: [] })),
      ]);

      setVehicles(scopeCurrent(vSnap.docs.map(d => ({ id: d.id, ...d.data() }))) || []);
      setDrivers(dSnap.docs.map(d => ({ id: d.id, ...d.data() })) || []);
      setTrips(scopeCurrent(tSnap.docs.map(d => ({ id: d.id, ...d.data() }))) || []); // 🔐 RBAC scope
      setCustomers(custSnap.docs.map(d => ({ id: d.id, ...d.data() })) || []);
      setVendors(venSnap.docs.map(d => ({ id: d.id, ...d.data() })) || []);
      setDriverTxns(txnSnap.docs.map(d => ({ id: d.id, ...d.data() })) || []);
      setMaintLogs(mSnap.docs.map(d => ({ id: d.id, ...d.data() })) || []);
      const compList = [...(cSnap1.docs||[]), ...(cSnap2.docs||[])].map(d => d.data().company_name || d.data().name || d.data().Company_Name);
      setCompanies([...new Set(compList.filter(Boolean))]);

    } catch (error) {
      console.error("Data Fetch Error:", error);
    }
  };

  if (loading) {
    return <div style={{ color: '#38bdf8', padding: '50px', textAlign: 'center', fontSize: '22px', fontWeight: '900' }}>⏳ Loading Prasad ERP Control Center...</div>;
  }

  const safeTrips = trips || [];
  const safeVehicles = vehicles || [];
  const safeDrivers = drivers || [];

  const activeTransitTrips = safeTrips.filter(t => t.trip_status === 'IN_TRANSIT' || t.trip_status === 'DISPATCHED');
  const pendingLoadingTrips = safeTrips.filter(t => t.trip_status === 'PENDING' || t.trip_status === 'LOADED');
  const pendingUnloadingTrips = safeTrips.filter(t => t.trip_status === 'UNLOADED' || t.trip_status === 'ARRIVED_DESTINATION');
  const completedTrips = safeTrips.filter(t => t.trip_status === 'COMPLETED');

  const generateAdScript = () => {
    if(!adProduct) return alert("Please enter a product or service!");
    const typeText = adType === 'VIDEO' ? 'cinematic video ad' : adType === 'FULL_SCENE' ? 'full cinematic photo' : '3D brand photo';
    setGeneratedScript(`🌟 Prasad Transport Presents: ${adProduct} 🌟\n\n[Scenario for ${typeText}]: A sophisticated AI model, 'Mamta', standing confidently. Behind her, a line of Ultra-HD 3D Prasad Transport trucks are ready to move across India. \n\nMamta (with consistent face lock) says: "Are you seeking reliability and speed? Let Mamta AI and the Prasad Transport fleet manage your ${adProduct} across India with 100% safety and real-time tracking!"\n\n📞 Contact us today for unmatched rates!\n#PrasadTransport #LogisticsManager #MamtaAIAutomation`);
  };

  const shareOnWhatsApp = () => {
    if(!generatedScript) return alert("Generate a script first!");
    window.open(`https://wa.me/?text=${encodeURIComponent(generatedScript)}`, '_blank');
  };
  
  const shareOnFacebook = () => {
    if(!generatedScript) return alert("Generate a script first!");
    alert("Script copied! Paste it in your Facebook post.");
    navigator.clipboard.writeText(generatedScript);
  };

  const shareOnLinkedIn = () => {
    if(!generatedScript) return alert("Generate a script first!");
     window.open(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent('https://www.prasadtransport.com')}&title=${encodeURIComponent('AI Logistics Ad')}&summary=${encodeURIComponent(generatedScript)}`, '_blank');
  };

  const handleAiVoiceStart = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      alert("❌ आपका ब्राउज़र वॉइस फीचर सपोर्ट नहीं करता (कृपया Google Chrome इस्तेमाल करें)।");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = 'hi-IN';
    recognition.interimResults = false;
    
    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (event: any) => {
      const transcript = event.results[0][0].transcript;
      setAiInput(transcript);
      handleAiSubmit(transcript);
      setIsListening(false);
    };
    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);
    recognition.start();
  };

  const speakAiResponse = (text: string) => {
    if ('speechSynthesis' in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'hi-IN';
      utterance.pitch = 1;
      utterance.rate = 1;
      window.speechSynthesis.speak(utterance);
    }
  };

  const handleAiSubmit = (textOverride?: string) => {
    const userText = textOverride || aiInput;
    if (!userText.trim()) return;

    setChatMessages(prev => [...prev, { sender: 'user', text: userText }]);
    setAiInput('');

    setTimeout(() => {
      const q = userText.toLowerCase();
      let reply = "माफ़ करें सर, मैं समझ नहीं पाई। आप मुझसे लोडिंग, फ्लीट, रास्ते की गाड़ियां या अनलोडिंग के बारे में पूछ सकते हैं।";

      if (q.includes('total') || q.includes('kitni gadi') || q.includes('fleet')) {
        reply = `सर, सिस्टम में अभी कुल ${vehicles.length} गाड़ियां रजिस्टर्ड हैं।`;
      } 
      else if (q.includes('loading') || q.includes('load')) {
        reply = `सर, अभी ${pendingLoadingTrips.length} गाड़ियां लोडिंग के लिए खड़ी (पेंडिंग) हैं।`;
      } 
      else if (q.includes('transit') || q.includes('rasta') || q.includes('raaste') || q.includes('chal rahi')) {
        reply = `अभी कुल ${activeTransitTrips.length} गाड़ियां रास्ते (Transit) में हैं।`;
      } 
      else if (q.includes('unload') || q.includes('khali') || q.includes('pahuch')) {
        reply = `सर, ${pendingUnloadingTrips.length} गाड़ियां कंसाइनी के पास पहुँच चुकी हैं और अनलोडिंग के लिए रुकी हैं।`;
      }
      else if (q.includes('namaste') || q.includes('hello') || q.includes('hi')) {
        reply = `नमस्ते सुभाष सर! बताइए आज मैं आपका क्या काम आसान कर सकती हूँ?`;
      }

      setChatMessages(prev => [...prev, { sender: 'ai', text: reply }]);
      speakAiResponse(reply); 
    }, 1000);
  };

  if (isFinanceModule) {
    const filteredFinanceTrips = safeTrips.filter(t => {
      if (selectedCompany !== 'ALL') {
        const tComp = String(t.Operating_Company || t.operating_company || '').toUpperCase();
        if (tComp !== selectedCompany.toUpperCase()) return false;
      }
      return true;
    });

    let realRevenue = 0; let realExpenses = 0; const realDebtorsMap: any = {};
    filteredFinanceTrips.forEach(t => {
      // 💰 Canonical trip math (lib/accounting/tripMath) — SAME helpers as
      // FinancialReports, so the two screens can never disagree again.
      const freight = getTripFreight(t);
      const expense = getTripExpense(t);
      realRevenue = round2(realRevenue + freight); realExpenses = round2(realExpenses + expense);

      if (t.billing_status !== 'PAID' && t.trip_status === 'COMPLETED') {
         const cName = t.Customer || t.customer_name || t.Registered_Assessee || 'Unknown Customer';
         if (!realDebtorsMap[cName]) realDebtorsMap[cName] = 0;
         realDebtorsMap[cName] += freight;
      }
    });

    const realProfit = realRevenue - realExpenses;
    const realDebtorsList = Object.keys(realDebtorsMap).map(k => ({ name: k, due: realDebtorsMap[k], status: 'Pending' })).filter(d => d.due > 0).sort((a,b) => b.due - a.due);
    const totalReceivable = realDebtorsList.reduce((sum, d) => sum + d.due, 0);

    const realCreditorsList = vendors.map(v => ({
      name: v.vendor_name || v.name || 'Unknown Vendor', type: v.vendor_type || 'General',
      due: parseFloat(v.current_balance || '0') || 0,
      status: (parseFloat(v.current_balance || '0') || 0) > 50000 ? 'Urgent' : 'Pending'
    })).filter(v => v.due > 0).sort((a,b) => b.due - a.due);
    const totalPayable = realCreditorsList.reduce((sum, v) => sum + v.due, 0);
    const calculatedBankBalance = realProfit - totalReceivable + totalPayable;

    const last6Months: any[] = [];
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const currDate = new Date();
    for (let i = 5; i >= 0; i--) {
        const tempDate = new Date(currDate.getFullYear(), currDate.getMonth() - i, 1);
        last6Months.push({ month: monthNames[tempDate.getMonth()], monthIndex: tempDate.getMonth(), year: tempDate.getFullYear(), inc: 0, exp: 0 });
    }

    filteredFinanceTrips.forEach(t => {
        const tripDateStr = t.Loading_Date || t.loading_date || t.start_date || t.created_at;
        if (!tripDateStr) return;
        const tDate = parseSafeDate(tripDateStr);
        const matchMonth = last6Months.find(m => m.monthIndex === tDate.getMonth() && m.year === tDate.getFullYear());
        if (matchMonth) {
            matchMonth.inc += (parseFloat(t.gross_freight || t.Rate || '0') || 0);
            matchMonth.exp += (parseFloat(t.total_expense || '0') || 0);
        }
    });

    const realChartData = last6Months.map(m => ({ month: m.month, inc: m.inc / 100000, exp: m.exp / 100000 }));
    const maxChartValue = Math.max(...realChartData.map(d => Math.max(d.inc, d.exp)), 1);
    const getBarHeight = (val: number) => maxChartValue > 0 ? `${(val / maxChartValue) * 100}%` : '0%';

    const formatCurrency = (value: number) => {
        const val = Number(value) || 0; const absVal = Math.abs(val); const sign = val < 0 ? '-' : '';
        if (absVal >= 10000000) return `${sign}₹ ${(absVal / 10000000).toFixed(2)} Cr`;
        if (absVal >= 100000) return `${sign}₹ ${(absVal / 100000).toFixed(2)} L`;
        if (absVal >= 1000) return `${sign}₹ ${(absVal / 1000).toFixed(2)} K`;
        return `${sign}₹ ${absVal.toFixed(0)}`;
    };

    return (
      <div style={{ padding: '30px', minHeight: '100vh', background: '#0a0f1c', fontFamily: "'Inter', sans-serif", color: 'white', paddingBottom: '100px' }}>
        <style>{`.fin-card { transition: 0.3s; cursor: pointer; } .fin-card:hover { transform: translateY(-5px); box-shadow: 0 10px 20px rgba(0,0,0,0.5); } .bar { transition: 0.5s; cursor: pointer; } .bar:hover { filter: brightness(1.2); } .modal-table th { background: rgba(255,255,255,0.05); padding: 15px; text-align: left; color: #94a3b8; text-transform: uppercase; font-size: 12px; } .modal-table td { padding: 15px; border-bottom: 1px solid #334155; font-size: 14px; }`}</style>
        
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
          <div><h2 style={{ margin: 0, fontSize: '36px', color: '#fff', fontWeight: '900' }}>💰 Master Finance Hub</h2><p style={{ margin: '5px 0 0 0', color: '#10b981', fontWeight: 'bold' }}>Real-time Consolidated Financial Overview</p></div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
            <GoogleTools />
            {isAdmin && (
              <button onClick={() => alert("Report downloaded!")} style={{ background: 'linear-gradient(135deg, #10b981, #059669)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>📥 Download MIS Report</button>
            )}
          </div>
        </div>

        <div style={{ background: 'rgba(30, 41, 59, 0.5)', border: '1px solid rgba(255,255,255,0.05)', padding: '20px', borderRadius: '15px', marginBottom: '30px', display: 'flex', gap: '20px' }}>
          <div style={{ flex: 1 }}>
            <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold' }}>Company Filter</label>
            <select value={selectedCompany} onChange={e => setSelectedCompany(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', marginTop: '5px', outline: 'none' }}>
              <option value="ALL">-- ALL COMPANIES (Consolidated) --</option>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 300px), 1fr))', gap: '25px', marginBottom: '35px' }}>
          <div style={{ background: '#0f172a', borderLeft: '5px solid #10b981', padding: '25px', borderRadius: '15px' }}><div style={{ color: '#94a3b8' }}>Total Revenue (YTD)</div><div style={{ fontSize: '38px', fontWeight: '900', color: '#10b981' }}>{formatCurrency(realRevenue)}</div></div>
          <div style={{ background: '#0f172a', borderLeft: '5px solid #ef4444', padding: '25px', borderRadius: '15px' }}><div style={{ color: '#94a3b8' }}>Total Expenses</div><div style={{ fontSize: '38px', fontWeight: '900', color: '#ef4444' }}>{formatCurrency(realExpenses)}</div></div>
          <div style={{ background: '#0f172a', borderLeft: '5px solid #3b82f6', padding: '25px', borderRadius: '15px' }}><div style={{ color: '#94a3b8' }}>Net Profit</div><div style={{ fontSize: '38px', fontWeight: '900', color: '#38bdf8' }}>{formatCurrency(realProfit)}</div></div>
          
          <div className={isAdmin ? "fin-card" : ""} onClick={() => isAdmin && setDetailModal('DEBTORS')} style={{ background: '#0f172a', borderLeft: '5px solid #f59e0b', padding: '25px', borderRadius: '15px' }}><div style={{ color: '#94a3b8' }}>Accounts Receivable (Debtors)</div><div style={{ fontSize: '38px', fontWeight: '900', color: '#f59e0b' }}>{formatCurrency(totalReceivable)}</div></div>
          <div className={isAdmin ? "fin-card" : ""} onClick={() => isAdmin && setDetailModal('CREDITORS')} style={{ background: '#0f172a', borderLeft: '5px solid #ec4899', padding: '25px', borderRadius: '15px' }}><div style={{ color: '#94a3b8' }}>Accounts Payable (Creditors)</div><div style={{ fontSize: '38px', fontWeight: '900', color: '#ec4899' }}>{formatCurrency(totalPayable)}</div></div>
          <div style={{ background: '#0f172a', borderLeft: '5px solid #8b5cf6', padding: '25px', borderRadius: '15px' }}><div style={{ color: '#94a3b8' }}>Calculated Cash Flow</div><div style={{ fontSize: '38px', fontWeight: '900', color: '#c084fc' }}>{formatCurrency(calculatedBankBalance)}</div></div>
        </div>

        <div style={{ background: '#1e293b', borderRadius: '15px', padding: '30px' }}>
          <h3 style={{ margin: '0 0 20px 0', color: '#fff' }}>📉 6-Month Trend (Income vs Expense)</h3>
          {realRevenue === 0 && realExpenses === 0 ? ( <div style={{ height: '280px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b' }}>No financial data available.</div> ) : (
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-around', height: '280px', borderBottom: '2px solid #475569', paddingBottom: '10px' }}>
              {realChartData.map((data, index) => (
                <div key={index} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}>
                  <div style={{ position: 'relative', display: 'flex', gap: '4px', alignItems: 'flex-end', height: '100%', width: '100%', justifyContent: 'center' }}>
                    <div className="bar" style={{ width: '18px', background: '#10b981', height: getBarHeight(data.inc) }} title={`₹${(Number(data.inc)||0).toFixed(2)}L`}></div>
                    <div className="bar" style={{ width: '18px', background: '#ef4444', height: getBarHeight(data.exp) }} title={`₹${(Number(data.exp)||0).toFixed(2)}L`}></div>
                  </div>
                  <span style={{ color: '#cbd5e1', fontSize: '13px', marginTop:'10px' }}>{data.month}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {detailModal && (detailModal === 'DEBTORS' || detailModal === 'CREDITORS') && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
            <div style={{ background: '#0f172a', width: '100%', maxWidth: '900px', maxHeight: '85vh', borderRadius: '15px', display: 'flex', flexDirection: 'column', border: `1px solid ${detailModal === 'DEBTORS' ? '#f59e0b' : '#ec4899'}` }}>
              <div style={{ padding: '20px 30px', display: 'flex', justifyContent: 'space-between', background: '#1e293b', borderRadius: '15px 15px 0 0' }}>
                <h3 style={{ margin: 0, color: detailModal === 'DEBTORS' ? '#f59e0b' : '#ec4899' }}>{detailModal === 'DEBTORS' ? '📈 Accounts Receivable' : '📉 Accounts Payable'}</h3>
                <button onClick={() => setDetailModal(null)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
              </div>
              <div style={{ padding: '20px', overflowY: 'auto' }}>
                <table className="modal-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th>Name</th><th>Amount (₹)</th><th>Status</th></tr></thead>
                  <tbody>
                    {(detailModal === 'DEBTORS' ? realDebtorsList : realCreditorsList).length === 0 ? (
                      <tr><td colSpan={3} style={{textAlign:'center'}}>No pending records found.</td></tr>
                    ) : (
                      (detailModal === 'DEBTORS' ? realDebtorsList : realCreditorsList).map((d:any, i) => (
                        <tr key={i}>
                          <td style={{ color: '#fff', fontWeight: 'bold' }}>{d.name}</td>
                          <td style={{ color: detailModal === 'DEBTORS' ? '#f59e0b' : '#ec4899', fontWeight: '900' }}>₹ {(Number(d.due)||0).toLocaleString('en-IN', {maximumFractionDigits:0})}</td>
                          <td><span style={{ color: d.status.includes('Overdue')||d.status==='Urgent' ? '#ef4444' : '#10b981' }}>{d.status}</span></td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==========================================
  // 🚛 2. OPERATIONS / CRM DASHBOARD RENDER
  // ==========================================
  
  const todayDateObj = new Date();
  const nextDaysLimit = new Date(); 
  nextDaysLimit.setDate(todayDateObj.getDate() + alertThreshold);

  // 🔥 CORE FIX: DEEP SCANNING FOR NEW DOCUMENT VAULT STRUCTURE
  const getExpiryStatusOps = (docObj: any) => {
    if (!docObj) return null;
    
    let targetDate = null;
    
    // Support for NEW nested Object structure from Document Vault
    if (typeof docObj === 'object' && docObj.next_due_date) {
        targetDate = parseSafeDate(docObj.next_due_date);
    } 
    // Support for older flat string structure
    else if (typeof docObj === 'string') {
        targetDate = parseSafeDate(docObj);
    }
    
    if (!targetDate || isNaN(targetDate.getTime())) return null;

    if (targetDate < todayDateObj) return 'EXPIRED';
    if (targetDate <= nextDaysLimit) return 'EXPIRING_SOON';
    return 'VALID';
  };

  // 🔥 PRETTY DATE RENDERER
  const renderDocDate = (docObj: any) => {
    if (!docObj) return "N/A";
    if (typeof docObj === 'object' && docObj.next_due_date) {
      return String(docObj.next_due_date);
    }
    return String(docObj); 
  };

  const getFilteredTripsForOps = () => {
    if (timeRange === 'ALL') return safeTrips; 
    const endOfDay = new Date(); endOfDay.setHours(23, 59, 59, 999);
    const pastDate = new Date(); pastDate.setHours(0, 0, 0, 0);
    if (timeRange === '15') pastDate.setDate(todayDateObj.getDate() - 15);
    else if (timeRange === '30') pastDate.setDate(todayDateObj.getDate() - 30);

    return safeTrips.filter(t => {
      const tripDateStr = t.Loading_Date || t.loading_date || t.start_date || t.created_at;
      if (!tripDateStr) return false;
      const tDate = parseSafeDate(tripDateStr);
      if (isNaN(tDate.getTime())) return false;
      tDate.setHours(0,0,0,0);
      return tDate >= pastDate && tDate <= endOfDay;
    });
  };

  const performanceTrips = getFilteredTripsForOps();
  const aggregatedData: any = {};
  const routeData: any = {};
  const productData: any = {};
  let periodTrips = 0; let periodRTKM = 0; let periodFreight = 0;

  performanceTrips.forEach(t => {
    const vNo = String(t.Vehical_No || t.vehicle_no || 'UNKNOWN').toUpperCase();
    if (!aggregatedData[vNo]) aggregatedData[vNo] = { vehicle: vNo, trips: 0, rtkm: 0, freight: 0 };
    aggregatedData[vNo].trips += 1;
    
    const routeName = `${t.Loading_Point || t.loading_point || 'Unknown'} ➔ ${t.Consignee_Name || t.consignee_name || 'Unknown'}`;
    if(!routeData[routeName]) routeData[routeName] = 0;
    routeData[routeName] += 1;

    const prodName = t.Product_Type || t.product_type || 'Other';
    if(!productData[prodName]) productData[prodName] = 0;
    productData[prodName] += 1;

    periodTrips += 1;
    const rtkm = parseFloat(t.RTKM || t.rtkm || t.RTKM_Distance || '0') || 0;
    aggregatedData[vNo].rtkm += rtkm; periodRTKM += rtkm;
    const freight = parseFloat(t.gross_freight || t.Rate || t.Freight || '0') || 0; 
    aggregatedData[vNo].freight += freight; periodFreight += freight;
  });

  const reportList = Object.values(aggregatedData);
  const topTrips = [...reportList].sort((a: any, b: any) => b.trips - a.trips).slice(0, 5);
  const maxTrips = Math.max(...topTrips.map(v => v.trips), 1);
  const topRTKM = [...reportList].sort((a: any, b: any) => b.rtkm - a.rtkm).slice(0, 5);
  const maxRTKM = Math.max(...topRTKM.map(v => v.rtkm), 1);
  const topRoutes = Object.keys(routeData).map(k => ({ route: k, count: routeData[k] })).sort((a,b) => b.count - a.count).slice(0, 5);
  const maxRouteCount = Math.max(...topRoutes.map(r => r.count), 1);
  const productChart = Object.keys(productData).map(k => ({ product: k, count: productData[k] })).sort((a,b) => b.count - a.count);

  const openPerfDetail = (vehicleNo: string) => { setSelectedPerfVehicle(vehicleNo); setDetailModal('PERF_DETAIL'); };

  // 🚨 DRIVER ALERTS
  const expDrvs = safeDrivers.filter(d => {
    const status = getExpiryStatusOps(d.dl_expiry_date || d.dl_validity || d.expiry_date || d.license_expiry || d.DL_Expiry);
    return status === 'EXPIRED' || status === 'EXPIRING_SOON';
  }).map(d => ({
    name: d.name || d.driver_name, mobile: d.mobile_no || d.mobile || d.contact,
    date: renderDocDate(d.dl_expiry_date || d.dl_validity || d.expiry_date || d.license_expiry || d.DL_Expiry),
    status: getExpiryStatusOps(d.dl_expiry_date || d.dl_validity || d.expiry_date || d.license_expiry || d.DL_Expiry)
  }));

  // 🚨 VEHICLE ALERTS (Deep Scanning new Structure)
  const expVehs: any[] = [];
  safeVehicles.forEach(v => {
    const vNo = v.vehical_no || v.vehicle_no || v.registration_no;
    const issues: any[] = [];
    
    // First check nested 'documents' object from new Vault
    if (v.documents) {
       Object.keys(v.documents).forEach(docKey => {
          const docData = v.documents[docKey];
          const status = getExpiryStatusOps(docData);
          const niceName = docData.doc_name || docKey.replace('_', ' ').toUpperCase();
          
          if (status === 'EXPIRED') issues.push({ type: niceName, status: 'Expired 🔴', date: renderDocDate(docData) });
          if (status === 'EXPIRING_SOON') issues.push({ type: niceName, status: `Exp in ${alertThreshold} Days ⚠️`, date: renderDocDate(docData) });
       });
    }

    // Fallback: Check flat fields if Vault wasn't used yet for this vehicle
    const flatFields = [
      { key: 'fitness_validity', label: 'Fitness' },
      { key: 'insurance_validity', label: 'Insurance' },
      { key: 'pollution_validity', label: 'PUC / Pollution' },
      { key: 'national_permit_validity', label: 'National Permit' },
      { key: 'tax_validity', label: 'Tax Token' },
      { key: 'explosive_validity', label: 'Explosive License' },
      { key: 'calibration_validity', label: 'Calibration Cert' }
    ];

    flatFields.forEach(field => {
      // Only check flat fields if we haven't already checked them in nested docs
      if (!v.documents || (!v.documents[field.key] && !v.documents[field.key.replace('_validity', '')])) {
         const docData = v[field.key] || v[field.key.replace('_validity', '')]; 
         if (docData) {
           const status = getExpiryStatusOps(docData);
           if (status === 'EXPIRED') issues.push({ type: field.label, status: 'Expired 🔴', date: renderDocDate(docData) });
           if (status === 'EXPIRING_SOON') issues.push({ type: field.label, status: `Expiring Soon ⚠️`, date: renderDocDate(docData) });
         }
      }
    });

    if (issues.length > 0) expVehs.push({ vNo, issues });
  });

  const upcomingMaintenanceOps: any[] = [];
  maintLogs.forEach(log => {
    if (log.Next_Service_Date) {
      const dueDate = parseSafeDate(log.Next_Service_Date);
      if (dueDate <= nextDaysLimit) {
        upcomingMaintenanceOps.push({
          vNo: log.Vehicle_No,
          service: log.Service_Type || 'General Servicing',
          date: log.Next_Service_Date,
          km: log.Next_Service_KM,
          status: dueDate < todayDateObj ? 'OVERDUE' : 'DUE SOON'
        });
      }
    }
  });

  const driverShortageMapOps: Record<string, number> = {};
  driverTxns.forEach(txn => {
    if (txn.txn_type === 'SHORTAGE_DEDUCTION' && txn.driver_name) {
      driverShortageMapOps[txn.driver_name] = (driverShortageMapOps[txn.driver_name] || 0) + parseFloat(txn.amount || 0);
    }
  });
  const shortageRecoveryListOps = Object.keys(driverShortageMapOps).map(name => ({ name, amount: driverShortageMapOps[name] })).filter(d => d.amount > 0).sort((a, b) => b.amount - a.amount);


  return (
    <div style={{ padding: '30px', minHeight: '100vh', background: '#0a0f1c', fontFamily: "'Inter', sans-serif", color: 'white', paddingBottom: '50px', position: 'relative' }}>
      <style>{`
        .kpi-card { transition: all 0.4s cubic-bezier(0.4, 0, 0.2, 1); cursor: pointer; position: relative; overflow: hidden; }
        .kpi-card:hover { transform: translateY(-8px); box-shadow: 0 20px 40px rgba(0,0,0,0.6); border-color: rgba(255,255,255,0.5) !important; }
        .perf-bar-row { cursor: pointer; transition: 0.2s; padding: 5px; border-radius: 8px; }
        .perf-bar-row:hover { background: rgba(255,255,255,0.05); transform: scale(1.02); }
        .perf-bar { transition: width 1s ease-in-out; }
        .modal-table th { background: rgba(255,255,255,0.05); padding: 15px; text-align: left; color: #94a3b8; font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #334155; }
        .modal-table td { padding: 15px; border-bottom: 1px solid #334155; font-size: 14px; color: #cbd5e1; }
        .modal-table tr:hover td { background: rgba(255,255,255,0.02); }
        
        .ad-mode-btn { border: 2px solid transparent; background: #0a0f1c; color: #fff; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; flex: 1; transition: 0.3s; text-align: center; }
        .ad-mode-btn:hover { background: #334155; }
        .ad-mode-btn.active { border-color: #c084fc; background: rgba(192, 132, 252, 0.2); color: #fff; }
        .share-btn { border: none; border-radius: 8px; padding: 10px 15px; cursor: pointer; color: white; font-weight: bold; transition: 0.3s; font-size: 13px; }
        .share-btn:hover { transform: scale(1.05); }

        /* 🤖 CHATBOT CSS */
        .ai-chat-btn { position: fixed; bottom: 30px; right: 30px; background: linear-gradient(135deg, #c084fc, #9333ea); width: 60px; height: 60px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 30px; cursor: pointer; box-shadow: 0 10px 25px rgba(147,51,234,0.5); z-index: 1000; transition: 0.3s; border: none; }
        .ai-chat-btn:hover { transform: scale(1.1); }
        .ai-chat-window { position: fixed; bottom: 100px; right: 30px; width: 350px; height: 500px; background: #0f172a; border: 1px solid #c084fc; border-radius: 15px; box-shadow: 0 20px 40px rgba(0,0,0,0.8); z-index: 1000; display: flex; flex-direction: column; overflow: hidden; animation: slideUp 0.3s ease-out; }
        @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
        .ai-chat-header { background: #1e293b; padding: 15px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #334155; }
        .ai-chat-body { flex: 1; padding: 15px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; background: #0a0f1c; }
        .chat-msg { max-width: 80%; padding: 10px 15px; border-radius: 15px; font-size: 13px; line-height: 1.5; }
        .chat-msg.user { align-self: flex-end; background: #38bdf8; color: #0f172a; border-bottom-right-radius: 0; }
        .chat-msg.ai { align-self: flex-start; background: #1e293b; color: #fff; border-bottom-left-radius: 0; border: 1px solid #334155; }
        .ai-chat-footer { padding: 15px; background: #1e293b; display: flex; gap: 10px; align-items: center; border-top: 1px solid #334155; }
        
        input[type="checkbox"].toggle-switch::before { content: ''; position: absolute; width: 16px; height: 16px; border-radius: 50%; top: 2px; left: 2px; background: white; transition: 0.3s; }
        input[type="checkbox"].toggle-switch:checked::before { transform: translateX(20px); }

        /* ===== 📱 RESPONSIVE LAYER (layout only — no logic changes) ===== */
        /* KPI cards: 4 on desktop, 2 on tablet, 1 on phone */
        .kpi-grid { display: grid; gap: 25px; margin-bottom: 35px; grid-template-columns: repeat(4, 1fr); }
        @media (max-width: 1024px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); gap: 18px; } }
        @media (max-width: 560px)  { .kpi-grid { grid-template-columns: 1fr; gap: 15px; } }

        /* Wide modal tables become horizontally scrollable instead of overflowing the page */
        @media (max-width: 768px) {
          .modal-table { display: block; overflow-x: auto; white-space: nowrap; -webkit-overflow-scrolling: touch; }
          .modal-table th, .modal-table td { padding: 10px 12px; font-size: 12px; }
        }

        /* Touch targets: min 44x44 on touch screens */
        @media (max-width: 768px) {
          .nav-btn, .ad-mode-btn, .share-btn { min-height: 44px; }
        }

        /* AI chat window: fits any phone instead of a fixed 350px that hangs off-screen */
        @media (max-width: 480px) {
          .ai-chat-window { width: auto; left: 10px; right: 10px; bottom: 80px; height: 65vh; }
          .ai-chat-btn { bottom: 80px; right: 16px; }
        }
      `}</style>

      {/* HEADER */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 'clamp(22px, 5vw, 36px)', color: '#fff', display: 'flex', alignItems: 'center', gap: '12px', fontWeight: '900', letterSpacing: '-1px' }}>
            {isCrmModule ? '🧠 Mamta AI CRM' : '🚛 Master Fleet Command'}
          </h2>
          <p style={{ margin: '5px 0 0 0', color: isCrmModule ? '#c084fc' : '#38bdf8', fontSize: '13px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '2px' }}>
            {isCrmModule ? 'Customer Relation & Ad Studio' : 'Live Operations & compliance alerts'}
          </p>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
          {isAdmin && (
            <>
               <button onClick={() => setDetailModal('AD_STUDIO')} style={{ background: 'linear-gradient(135deg, #ec4899, #c084fc)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '10px', fontWeight: '900', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 0 20px rgba(192, 132, 252, 0.4)' }}>
                 🎬 AI AD STUDIO
               </button>
               {!isCrmModule && (
                 <>
                   <button onClick={() => setDetailModal('ADV_ANALYTICS')} style={{ background: 'linear-gradient(135deg, #f59e0b, #ea580c)', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '10px', fontWeight: '900', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', boxShadow: '0 0 20px rgba(245, 158, 11, 0.4)' }}>
                     📈 SMART CHARTS
                   </button>
                   <button onClick={() => setDetailModal('SETTINGS')} style={{ background: '#1e293b', color: '#cbd5e1', border: '1px solid #475569', padding: '10px 20px', borderRadius: '10px', fontWeight: 'bold', cursor: 'pointer' }}>
                     ⚙️ SETUP
                   </button>
                 </>
               )}
            </>
          )}
          <GoogleTools />
        </div>
      </div>

      {/* CRM EXCLUSIVE CONTENT */}
      {isCrmModule && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 250px), 1fr))', gap: '25px', marginBottom: '35px' }}>
          <div style={{ background: 'linear-gradient(135deg, rgba(192, 132, 252, 0.15), rgba(147, 51, 234, 0.15))', border: '1px solid rgba(192,132,252,0.4)', padding: '25px', borderRadius: '15px' }}>
            <div style={{ color: '#c084fc', fontSize: '13px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Active Clients</div>
            <div style={{ fontSize: '42px', fontWeight: '900', color: '#fff', marginTop: '10px' }}>{customers.length || 0} 🤝</div>
          </div>
          <div style={{ background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.15), rgba(37, 99, 235, 0.15))', border: '1px solid rgba(56,189,248,0.4)', padding: '25px', borderRadius: '15px' }}>
            <div style={{ color: '#38bdf8', fontSize: '13px', fontWeight: 'bold', textTransform: 'uppercase' }}>AI Tasks Processed (Today)</div>
            <div style={{ fontSize: '42px', fontWeight: '900', color: '#fff', marginTop: '10px' }}>0 🤖</div>
          </div>
          <div style={{ background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.15), rgba(5, 150, 105, 0.15))', border: '1px solid rgba(16,185,129,0.4)', padding: '25px', borderRadius: '15px' }}>
            <div style={{ color: '#10b981', fontSize: '13px', fontWeight: 'bold', textTransform: 'uppercase' }}>Auto WhatsApp Sent</div>
            <div style={{ fontSize: '42px', fontWeight: '900', color: '#fff', marginTop: '10px' }}>0 💬</div>
          </div>
        </div>
      )}

      {/* ROW 1: PIPELINE */}
      {(!isCrmModule && dashConfig.showPipeline) && (
      <>
        {/* 🚦 Trip lifecycle status pills (Phase 4 design system) */}
        <div className="pt-glass" style={{ padding: '14px 18px', marginBottom: '18px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span className="pt-section-title" style={{ fontSize: '14px', margin: 0 }}>🚦 Trip Lifecycle</span>
          <span className="pt-pill pt-pill--pending-load">Pending Load · {pendingLoadingTrips.length}</span>
          <span className="pt-pill pt-pill--transit">In Transit · {activeTransitTrips.length}</span>
          <span className="pt-pill pt-pill--pending-unload">Pending Unload · {pendingUnloadingTrips.length}</span>
          <span className="pt-pill pt-pill--completed">Completed · {completedTrips.length}</span>
        </div>
        <div className="kpi-grid">
          <div className="kpi-card" onClick={() => setDetailModal('FLEET')} style={{ background: '#0f172a', border: '1px solid rgba(56,189,248,0.2)', padding: '25px', borderRadius: '15px', borderLeft: '4px solid #38bdf8' }}>
            <div style={{ color: '#38bdf8', fontSize: '13px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Fleet Vehicles</div>
            <div style={{ fontSize: '42px', fontWeight: '900', color: '#fff', marginTop: '10px' }}>{safeVehicles.length}</div>
          </div>
          <div className="kpi-card" onClick={() => setDetailModal('LOADING')} style={{ background: '#0f172a', border: '1px solid rgba(245,158,11,0.2)', padding: '25px', borderRadius: '15px', borderLeft: '4px solid #f59e0b' }}>
            <div style={{ color: '#f59e0b', fontSize: '13px', fontWeight: 'bold', textTransform: 'uppercase' }}>Pending For Loading</div>
            <div style={{ fontSize: '42px', fontWeight: '900', color: '#fff', marginTop: '10px' }}>{pendingLoadingTrips.length} 📦</div>
          </div>
          <div className="kpi-card" onClick={() => setDetailModal('TRANSIT')} style={{ background: '#0f172a', border: '1px solid rgba(16,185,129,0.2)', padding: '25px', borderRadius: '15px', borderLeft: '4px solid #10b981' }}>
            <div style={{ color: '#10b981', fontSize: '13px', fontWeight: 'bold', textTransform: 'uppercase' }}>Active In Transit</div>
            <div style={{ fontSize: '42px', fontWeight: '900', color: '#fff', marginTop: '10px' }}>{activeTransitTrips.length} 🟢</div>
          </div>
          <div className="kpi-card" onClick={() => setDetailModal('UNLOADING')} style={{ background: '#0f172a', border: '1px solid rgba(239,68,68,0.2)', padding: '25px', borderRadius: '15px', borderLeft: '4px solid #ef4444' }}>
            <div style={{ color: '#ef4444', fontSize: '13px', fontWeight: 'bold', textTransform: 'uppercase' }}>Pending Unload</div>
            <div style={{ fontSize: '42px', fontWeight: '900', color: '#fff', marginTop: '10px' }}>{pendingUnloadingTrips.length} ⏳</div>
          </div>
        </div>
      </>
      )}

      {/* PERFORMANCE ANALYTICS */}
      {(!isCrmModule && dashConfig.showAnalytics) && (
        <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '15px', padding: '25px', marginBottom: '35px', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', borderBottom: '1px solid #1e293b', paddingBottom: '15px' }}>
            <h3 style={{ margin: 0, color: '#fff', fontSize: '20px', display: 'flex', alignItems: 'center', gap: '10px' }}>
              📈 Fleet Performance Analytics <span style={{fontSize:'12px', color:'#94a3b8'}}>(Click vehicle bar for details)</span>
            </h3>
            <div style={{ display: 'flex', gap: '5px', background: '#0a0f1c', padding: '5px', borderRadius: '8px', border: '1px solid #1e293b' }}>
              <button onClick={() => setTimeRange('1')} style={{ padding: '8px 20px', borderRadius: '5px', border: 'none', fontWeight: 'bold', cursor: 'pointer', background: timeRange === '1' ? '#38bdf8' : 'transparent', color: timeRange === '1' ? '#0f172a' : '#94a3b8' }}>Today</button>
              <button onClick={() => setTimeRange('15')} style={{ padding: '8px 20px', borderRadius: '5px', border: 'none', fontWeight: 'bold', cursor: 'pointer', background: timeRange === '15' ? '#10b981' : 'transparent', color: timeRange === '15' ? '#0f172a' : '#94a3b8' }}>15 Days</button>
              <button onClick={() => setTimeRange('30')} style={{ padding: '8px 20px', borderRadius: '5px', border: 'none', fontWeight: 'bold', cursor: 'pointer', background: timeRange === '30' ? '#f59e0b' : 'transparent', color: timeRange === '30' ? '#0f172a' : '#94a3b8' }}>30 Days</button>
              <button onClick={() => setTimeRange('ALL')} style={{ padding: '8px 20px', borderRadius: '5px', border: 'none', fontWeight: 'bold', cursor: 'pointer', background: timeRange === 'ALL' ? '#c084fc' : 'transparent', color: timeRange === 'ALL' ? '#0f172a' : '#94a3b8' }}>All Time</button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '20px', marginBottom: '25px', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: '200px', background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(16, 185, 129, 0.05))', border: '1px solid rgba(16, 185, 129, 0.2)', borderRadius: '12px', padding: '15px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 'bold' }}>Period Loadings</div>
              <div style={{ fontSize: '28px', fontWeight: '900', color: '#10b981', margin: '5px 0' }}>{periodTrips}</div>
            </div>
            <div style={{ flex: 1, minWidth: '200px', background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.1), rgba(245, 158, 11, 0.05))', border: '1px solid rgba(245, 158, 11, 0.2)', borderRadius: '12px', padding: '15px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 'bold' }}>Period RTKM Run</div>
              <div style={{ fontSize: '28px', fontWeight: '900', color: '#f59e0b', margin: '5px 0' }}>{periodRTKM.toLocaleString()}</div>
            </div>
            <div style={{ flex: 1, minWidth: '200px', background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.1), rgba(168, 85, 247, 0.05))', border: '1px solid rgba(168, 85, 247, 0.2)', borderRadius: '12px', padding: '15px', textAlign: 'center' }}>
              <div style={{ fontSize: '12px', color: '#94a3b8', textTransform: 'uppercase', fontWeight: 'bold' }}>Est. Period Freight</div>
              <div style={{ fontSize: '28px', fontWeight: '900', color: '#c084fc', margin: '5px 0' }}>₹{periodFreight.toLocaleString()}</div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 350px), 1fr))', gap: '25px' }}>
            <div style={{ background: '#0a0f1c', border: '1px solid #1e293b', padding: '20px', borderRadius: '12px' }}>
              <h4 style={{ margin: '0 0 15px 0', color: '#38bdf8', fontSize: '14px', textTransform: 'uppercase' }}>🏆 Top Vehicles (Loadings)</h4>
              {topTrips.length === 0 ? <p style={{color:'#64748b', fontSize:'13px'}}>No data.</p> : topTrips.map((v, i) => (
                <div key={i} className="perf-bar-row" onClick={() => openPerfDetail(v.vehicle)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ width: '90px', fontSize: '11px', color: '#cbd5e1' }}>{v.vehicle}</div>
                    <div style={{ flex: 1, height: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '5px' }}>
                      <div style={{ width: `${(v.trips / maxTrips) * 100}%`, height: '100%', background: '#38bdf8', borderRadius: '5px' }}></div>
                    </div>
                    <div style={{ width: '30px', fontSize: '11px', fontWeight: 'bold', textAlign: 'right', color: '#38bdf8' }}>{v.trips}</div>
                  </div>
                </div>
              ))}
            </div>
            <div style={{ background: '#0a0f1c', border: '1px solid #1e293b', padding: '20px', borderRadius: '12px' }}>
              <h4 style={{ margin: '0 0 15px 0', color: '#10b981', fontSize: '14px', textTransform: 'uppercase' }}>🚀 Longest Runners (RTKM)</h4>
              {topRTKM.length === 0 ? <p style={{color:'#64748b', fontSize:'13px'}}>No data.</p> : topRTKM.map((v, i) => (
                <div key={i} className="perf-bar-row" onClick={() => openPerfDetail(v.vehicle)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ width: '90px', fontSize: '11px', color: '#cbd5e1' }}>{v.vehicle}</div>
                    <div style={{ flex: 1, height: '10px', background: 'rgba(255,255,255,0.05)', borderRadius: '5px' }}>
                      <div style={{ width: `${(v.rtkm / maxRTKM) * 100}%`, height: '100%', background: '#10b981', borderRadius: '5px' }}></div>
                    </div>
                    <div style={{ width: '40px', fontSize: '11px', fontWeight: 'bold', textAlign: 'right', color: '#10b981' }}>{v.rtkm}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      
      {/* 🚨 CRITICAL ALERTS (WITH REAL-TIME VAULT SYNC) */}
      {(!isCrmModule && dashConfig.showAlerts) && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 350px), 1fr))', gap: '30px', marginBottom: '30px' }}>

          <div className="kpi-card" onClick={() => setDetailModal('DL_ALERTS')} style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '15px', padding: '25px', borderTop: expDrvs.length > 0 ? '4px solid #ef4444' : '4px solid #10b981' }}>
            <h3 style={{ margin: '0 0 20px 0', color: expDrvs.length > 0 ? '#ef4444' : '#10b981', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}>
               {expDrvs.length > 0 ? `🚨 Driver DL Expiry (${alertThreshold} Days)` : `✅ Driver DL Verified`}
            </h3>
            {expDrvs.length === 0 ? ( <div style={{ color: '#10b981', fontWeight: 'bold' }}>All driver licenses are valid.</div> ) : (<div style={{ color: '#fff', fontSize: '14px' }}><b>{expDrvs.length} Drivers</b> have expired/expiring DLs.</div>)}
          </div>
          
          <div className="kpi-card" onClick={() => setDetailModal('DOC_ALERTS')} style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '15px', padding: '25px', borderTop: expVehs.length > 0 ? '4px solid #f59e0b' : '4px solid #10b981' }}>
            <h3 style={{ margin: '0 0 20px 0', color: expVehs.length > 0 ? '#f59e0b' : '#10b981', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}>
               {expVehs.length > 0 ? `⚠️ Vehicle Docs (${alertThreshold} Days)` : `✅ Vehicle Docs Verified`}
            </h3>
            {expVehs.length === 0 ? ( <div style={{ color: '#10b981', fontWeight: 'bold' }}>All fleet documents are valid.</div> ) : (<div style={{ color: '#fff', fontSize: '14px' }}><b>{expVehs.length} Vehicles</b> have document issues.</div>)}
          </div>
          
        </div>
      )}

      {/* AI INSIGHTS */}
      {(!isCrmModule && dashConfig.showAiAudit) && (
        <div style={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: '15px', padding: '30px', display: 'flex', alignItems: 'center', gap: '25px' }}>
          <div style={{ fontSize: '50px' }}>🤖</div>
          <div>
            <h3 style={{ margin: '0 0 10px 0', color: '#c084fc', fontSize: '22px', display: 'flex', alignItems: 'center', gap: '10px', fontWeight: '900' }}>
              Mamta AI Operations Audit 
              <span style={{ background: '#c084fc', color: '#0f172a', padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: '900' }}>LIVE SYNC</span>
            </h3>
            <p style={{ margin: 0, color: '#e2e8f0', fontSize: '15px', lineHeight: '1.6' }}>
              {expVehs.length > 0 ? <span style={{color: '#f59e0b'}}>⚠️ Attention! <b>{expVehs.length} vehicles</b> have critical documents expiring. Please click the alert box to check details.</span> : <span style={{color: '#10b981'}}>✅ All fleet documents are up to date! </span>}
              <br/>
              {pendingUnloadingTrips.length > 0 ? <span style={{color: '#ef4444'}}>⏳ Currently, <b>{pendingUnloadingTrips.length} vehicles</b> are waiting for unloading.</span> : `🚀 Operations running smoothly at maximum efficiency.`}
            </p>
          </div>
        </div>
      )}

      {/* 🎬 🌟 MAMTA AI AD STUDIO MODAL */}
      {detailModal === 'AD_STUDIO' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
          <div style={{ background: '#0f172a', width: '100%', maxWidth: '950px', maxHeight: '90vh', overflowY:'auto', borderRadius: '15px', border: '1px solid #c084fc', display: 'flex', flexDirection: 'column', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            <div style={{ padding: '20px 30px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', borderRadius: '15px 15px 0 0' }}>
              <h3 style={{ margin: 0, color: '#c084fc', fontSize: '24px', display: 'flex', alignItems: 'center', gap: '10px' }}>🎬 Mamta AI Brand Ad Studio 2.0</h3>
              <button onClick={() => setDetailModal(null)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
            </div>
            
            <div style={{ padding: '30px', display: 'flex', gap: '30px', flexWrap: 'wrap' }}>
              <div style={{ flex: '1', minWidth: '320px', background: '#1e293b', borderRadius: '12px', padding: '20px', border: '1px solid #334155', textAlign: 'center' }}>
                <div style={{ width: '100%', height: '280px', background: '#0a0f1c', borderRadius: '8px', border: '2px dashed #c084fc', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '15px', overflow: 'hidden', position: 'relative' }}>
                   <img src="https://static.wixstatic.com/media/078d10_1a415392070c46f39d22425553b497cb~URI~v1/fill/w_560,h_658,al_c,q_85,usm_0.66_1.00_0.01,enc_auto/WomanInBusiness_mamtaai.png" alt="Mamta AI Consistent Model" style={{ height: '100%', width: '100%', objectFit: 'cover' }} />
                   <div style={{ position: 'absolute', bottom: '10px', background: 'rgba(192,132,252,0.9)', padding: '3px 12px', borderRadius: '15px', fontSize: '11px', fontWeight: '900', color:'#0f172a' }}>FACE LOCK ACTIVE</div>
                </div>
                <h4 style={{ color: '#fff', margin: '0 0 5px 0' }}>Mamta AI Model (Consistent)</h4>
                <p style={{ color: '#94a3b8', fontSize: '12px', margin: 0 }}>This face & persona are locked as your consistent reference for all brand photo and video generation.</p>
              </div>

              <div style={{ flex: '2', minWidth: '350px' }}>
                <h4 style={{ color: '#38bdf8', marginTop: 0 }}>Create New Ad Campaign</h4>
                <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Enter Product/Service to Advertise:</label>
                <input 
                  type="text" 
                  placeholder="e.g. LPG Bulk Transport, Express Delivery, Agri Logistics..." 
                  value={adProduct}
                  onChange={(e) => setAdProduct(e.target.value)}
                  style={{ width: '100%', padding: '12px', background: '#0a0f1c', border: '1px solid #334155', color: '#fff', borderRadius: '8px', marginBottom: '20px', outline: 'none' }}
                />

                <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '10px' }}>Select Ad Output Type:</label>
                <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
                   <button className={`ad-mode-btn ${adType === 'PHOTO' ? 'active' : ''}`} onClick={() => setAdType('PHOTO')}>📸 3D Photo</button>
                   <button className={`ad-mode-btn ${adType === 'VIDEO' ? 'active' : ''}`} onClick={() => setAdType('VIDEO')}>🎥 Cinematic Video</button>
                   <button className={`ad-mode-btn ${adType === 'FULL_SCENE' ? 'active' : ''}`} onClick={() => setAdType('FULL_SCENE')}>🖥️ Full Scene</button>
                </div>
                
                <button onClick={generateAdScript} style={{ width: '100%', background: 'linear-gradient(135deg, #ec4899, #c084fc)', color: '#fff', border: 'none', padding: '15px', borderRadius: '8px', fontWeight: '900', cursor: 'pointer', display:'flex', gap:'8px', alignItems:'center', justifyContent:'center', fontSize:'15px' }}>
                  ✨ Generate Ad & Scenario (Face Locked)
                </button>

                {generatedScript && (
                  <div style={{ background: 'rgba(192, 132, 252, 0.1)', border: '1px solid rgba(192,132,252,0.4)', padding: '20px', borderRadius: '8px', marginTop:'25px', boxShadow: '0 0 15px rgba(192,132,252,0.1)' }}>
                    <h4 style={{ color: '#c084fc', margin: '0 0 10px 0', fontSize: '13px', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                       ✨ AI Generated Ad Scenario
                       <button onClick={() => navigator.clipboard.writeText(generatedScript)} style={{ background:'transparent', border:'none', color:'#cbd5e1', fontSize:'11px', cursor:'pointer' }}>📋 Copy</button>
                    </h4>
                    <pre style={{ color: '#e2e8f0', whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: '14px', margin: '0 0 20px 0', lineHeight: '1.6', maxHeight:'200px', overflowY:'auto', background:'rgba(0,0,0,0.3)', padding:'10px', borderRadius:'5px' }}>
                      {generatedScript}
                    </pre>
                    
                    <label style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>Share generated ad content (Full scenario):</label>
                    <div style={{ display: 'flex', gap: '10px', flexWrap:'wrap' }}>
                        <button className="share-btn" style={{ background: '#25D366' }} onClick={shareOnWhatsApp}>
                           Share to WhatsApp
                        </button>
                        <button className="share-btn" style={{ background: '#1877F2' }} onClick={shareOnFacebook}>
                           Post to Facebook
                        </button>
                        <button className="share-btn" style={{ background: '#0A66C2' }} onClick={shareOnLinkedIn}>
                           Post to LinkedIn
                        </button>
                         <button className="share-btn" style={{ background: '#ea580c' }} onClick={() => alert("Connecting to Photo/Video AI generation API...")}>
                           🚀 Download Photo/Video
                        </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ⚙️ SETUP MODAL */}
      {detailModal === 'SETTINGS' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
          <div style={{ background: '#0f172a', width: '100%', maxWidth: '500px', borderRadius: '15px', border: '1px solid #475569', display: 'flex', flexDirection: 'column', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            <div style={{ padding: '20px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', borderRadius: '15px 15px 0 0' }}>
              <h3 style={{ margin: 0, color: '#fff', fontSize: '20px' }}>⚙️ Customize Dashboard</h3>
              <button onClick={() => setDetailModal(null)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ padding: '30px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.05)', padding: '12px 20px', borderRadius: '8px', marginBottom: '10px' }}>
                <span style={{ fontWeight: 'bold', color: '#fff' }}>🚛 Live Trip Pipeline (KPIs)</span>
                <input type="checkbox" style={{ appearance: 'none', width: '40px', height: '20px', background: dashConfig.showPipeline ? '#10b981' : '#334155', borderRadius: '20px', position: 'relative', cursor: 'pointer', outline: 'none' }} className="toggle-switch" checked={dashConfig.showPipeline} onChange={() => setDashConfig({...dashConfig, showPipeline: !dashConfig.showPipeline})} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.05)', padding: '12px 20px', borderRadius: '8px', marginBottom: '10px' }}>
                <span style={{ fontWeight: 'bold', color: '#fff' }}>📈 Performance Analytics</span>
                <input type="checkbox" style={{ appearance: 'none', width: '40px', height: '20px', background: dashConfig.showAnalytics ? '#10b981' : '#334155', borderRadius: '20px', position: 'relative', cursor: 'pointer', outline: 'none' }} className="toggle-switch" checked={dashConfig.showAnalytics} onChange={() => setDashConfig({...dashConfig, showAnalytics: !dashConfig.showAnalytics})} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.05)', padding: '12px 20px', borderRadius: '8px', marginBottom: '10px' }}>
                <span style={{ fontWeight: 'bold', color: '#fff' }}>🚨 Critical Alerts</span>
                <input type="checkbox" style={{ appearance: 'none', width: '40px', height: '20px', background: dashConfig.showAlerts ? '#10b981' : '#334155', borderRadius: '20px', position: 'relative', cursor: 'pointer', outline: 'none' }} className="toggle-switch" checked={dashConfig.showAlerts} onChange={() => setDashConfig({...dashConfig, showAlerts: !dashConfig.showAlerts})} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'rgba(255,255,255,0.05)', padding: '12px 20px', borderRadius: '8px', marginBottom: '10px' }}>
                <span style={{ fontWeight: 'bold', color: '#fff' }}>🤖 Mamta AI Audit</span>
                <input type="checkbox" style={{ appearance: 'none', width: '40px', height: '20px', background: dashConfig.showAiAudit ? '#10b981' : '#334155', borderRadius: '20px', position: 'relative', cursor: 'pointer', outline: 'none' }} className="toggle-switch" checked={dashConfig.showAiAudit} onChange={() => setDashConfig({...dashConfig, showAiAudit: !dashConfig.showAiAudit})} />
              </div>
              <div style={{ marginTop: '20px', borderTop: '1px solid #334155', paddingTop: '20px' }}>
                <label style={{ color: '#94a3b8', fontSize: '13px', fontWeight: 'bold' }}>Alert Expiry Threshold (Days):</label>
                <select value={alertThreshold} onChange={(e) => setAlertThreshold(Number(e.target.value))} style={{ width: '100%', padding: '10px', marginTop: '10px', background: '#1e293b', border: '1px solid #475569', color: '#fff', borderRadius: '8px' }}>
                  <option value={7}>7 Days Before</option><option value={15}>15 Days Before</option><option value={30}>30 Days Before</option><option value={60}>60 Days Before</option>
                </select>
              </div>
              <button onClick={() => setDetailModal(null)} style={{ width: '100%', padding: '15px', background: '#38bdf8', color: '#0f172a', border: 'none', borderRadius: '8px', fontWeight: 'bold', fontSize: '16px', marginTop: '20px', cursor: 'pointer' }}>Save Settings</button>
            </div>
          </div>
        </div>
      )}

      {/* 📈 ADVANCED SMART ANALYTICS MODAL */}
      {detailModal === 'ADV_ANALYTICS' && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
          <div style={{ background: '#0f172a', width: '100%', maxWidth: '1200px', height: '90vh', borderRadius: '15px', border: '1px solid #f59e0b', display: 'flex', flexDirection: 'column', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            <div style={{ padding: '20px 30px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', borderRadius: '15px 15px 0 0' }}>
              <h3 style={{ margin: 0, color: '#f59e0b', fontSize: '24px', display: 'flex', alignItems: 'center', gap: '10px' }}>📈 Advanced Smart Analytics Studio</h3>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <select value={timeRange} onChange={(e) => setTimeRange(e.target.value)} style={{ background: '#0f172a', color: '#38bdf8', border: '1px solid #38bdf8', padding: '8px 12px', borderRadius: '6px', fontWeight: 'bold', outline: 'none' }}>
                  <option value="1">Today</option><option value="15">Last 15 Days</option><option value="30">Last 30 Days</option><option value="ALL">All Time</option>
                </select>
                <button onClick={() => setDetailModal(null)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer' }}>✕</button>
              </div>
            </div>
            <div style={{ padding: '30px', overflowY: 'auto', flex: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 400px), 1fr))', gap: '30px' }}>
              <div style={{ background: '#1e293b', padding: '25px', borderRadius: '15px', border: '1px solid #334155' }}>
                <h4 style={{ color: '#10b981', margin: '0 0 20px 0', fontSize: '16px' }}>🗺️ Top 5 Busiest Routes</h4>
                {topRoutes.length === 0 ? <p style={{color:'#64748b'}}>No route data.</p> : topRoutes.map((r, i) => (
                  <div key={i} style={{ marginBottom: '15px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#cbd5e1', marginBottom: '5px' }}>
                      <span style={{ fontWeight: 'bold' }}>{r.route}</span><span style={{ color: '#10b981', fontWeight: 'bold' }}>{r.count} Trips</span>
                    </div>
                    <div style={{ height: '12px', background: 'rgba(255,255,255,0.05)', borderRadius: '10px', overflow: 'hidden' }}>
                      <div className="perf-bar" style={{ width: `${(r.count / maxRouteCount) * 100}%`, height: '100%', background: 'linear-gradient(90deg, #059669, #10b981)', borderRadius: '10px' }}></div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ background: '#1e293b', padding: '25px', borderRadius: '15px', border: '1px solid #334155' }}>
                <h4 style={{ color: '#c084fc', margin: '0 0 20px 0', fontSize: '16px' }}>📦 Product / Material Distribution</h4>
                {productChart.length === 0 ? <p style={{color:'#64748b'}}>No product data.</p> : 
                  <div style={{ display: 'grid', gap: '15px' }}>
                    {productChart.map((p, i) => {
                      const colors = ['#c084fc', '#38bdf8', '#f59e0b', '#10b981', '#ec4899'];
                      return (
                        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '15px', background: 'rgba(0,0,0,0.3)', padding: '15px', borderRadius: '10px' }}>
                          <div style={{ width: '40px', height: '40px', borderRadius: '8px', background: colors[i % colors.length], display: 'flex', justifyContent: 'center', alignItems: 'center', color: '#0f172a', fontWeight: '900', fontSize: '18px' }}>{p.count}</div>
                          <div style={{ flex: 1 }}><div style={{ color: '#fff', fontWeight: 'bold', fontSize: '15px' }}>{p.product}</div><div style={{ color: '#94a3b8', fontSize: '12px' }}>Total Loadings</div></div>
                        </div>
                      )
                    })}
                  </div>
                }
              </div>
              <div style={{ background: '#1e293b', padding: '25px', borderRadius: '15px', border: '1px solid #334155', gridColumn: '1 / -1' }}>
                 <h4 style={{ color: '#38bdf8', margin: '0 0 20px 0', fontSize: '16px' }}>📋 Analytics Summary Report</h4>
                 <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, padding: '20px', background: '#0f172a', border: '1px dashed #475569', borderRadius: '12px', textAlign: 'center' }}>
                      <div style={{ color: '#94a3b8', fontSize: '13px', textTransform: 'uppercase' }}>Active Vehicles Contributing</div>
                      <div style={{ fontSize: '32px', color: '#fff', fontWeight: '900', marginTop: '10px' }}>{reportList.length}</div>
                    </div>
                    <div style={{ flex: 1, padding: '20px', background: '#0f172a', border: '1px dashed #475569', borderRadius: '12px', textAlign: 'center' }}>
                      <div style={{ color: '#94a3b8', fontSize: '13px', textTransform: 'uppercase' }}>Avg RTKM per Vehicle</div>
                      <div style={{ fontSize: '32px', color: '#10b981', fontWeight: '900', marginTop: '10px' }}>{reportList.length ? Math.round(periodRTKM / reportList.length).toLocaleString() : 0} KM</div>
                    </div>
                    <div style={{ flex: 1, padding: '20px', background: '#0f172a', border: '1px dashed #475569', borderRadius: '12px', textAlign: 'center' }}>
                      <div style={{ color: '#94a3b8', fontSize: '13px', textTransform: 'uppercase' }}>Est. Total Revenue Generated</div>
                      <div style={{ fontSize: '32px', color: '#f59e0b', fontWeight: '900', marginTop: '10px' }}>₹{periodFreight.toLocaleString()}</div>
                    </div>
                 </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 🔍 DRILL-DOWN ALERTS MODALS */}
      {detailModal && (['FLEET', 'LOADING', 'TRANSIT', 'UNLOADING', 'PERF_DETAIL', 'DL_ALERTS', 'DOC_ALERTS', 'MAINT_ALERTS', 'SHORTAGE_ALERTS'].includes(detailModal)) && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', zIndex: 9998, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
          <div style={{ background: '#0f172a', width: '100%', maxWidth: '1000px', maxHeight: '85vh', borderRadius: '15px', border: '1px solid #38bdf8', display: 'flex', flexDirection: 'column', boxShadow: '0 25px 50px rgba(0,0,0,0.8)' }}>
            <div style={{ padding: '20px 30px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', borderRadius: '15px 15px 0 0' }}>
              <h3 style={{ margin: 0, color: detailModal === 'LOADING' ? '#f59e0b' : detailModal === 'TRANSIT' ? '#10b981' : detailModal === 'UNLOADING' ? '#ef4444' : '#38bdf8', fontSize: '22px' }}>
                {detailModal === 'FLEET' && `🚛 Total Fleet Vehicles (${safeVehicles.length})`}
                {detailModal === 'LOADING' && `📦 Vehicles Pending Loading (${pendingLoadingTrips.length})`}
                {detailModal === 'TRANSIT' && `🟢 Vehicles In Transit (${activeTransitTrips.length})`}
                {detailModal === 'UNLOADING' && `⏳ Vehicles Pending Unloading (${pendingUnloadingTrips.length})`}
                {detailModal === 'PERF_DETAIL' && `📊 Operations Log for: ${selectedPerfVehicle}`}
                {detailModal === 'DL_ALERTS' && `🚨 Driver DL Expiry Alerts`}
                {detailModal === 'DOC_ALERTS' && `⚠️ Vehicle Document Expiry Alerts`}
                {detailModal === 'MAINT_ALERTS' && `🛠️ Maintenance Reminders`}
                {detailModal === 'SHORTAGE_ALERTS' && `✂️ Driver Shortage Recovery List`}
              </h3>
              <button onClick={() => setDetailModal(null)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '28px', cursor: 'pointer', transition: '0.2s' }}>✕</button>
            </div>
            <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
              <table className="modal-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                
                {detailModal === 'FLEET' && (
                  <>
                    <thead><tr><th>Vehicle No</th><th>Vehicle Type</th><th>Capacity</th><th>Company / Owner</th></tr></thead>
                    <tbody>
                      {safeVehicles.length === 0 ? <tr><td colSpan={4} style={{textAlign:'center'}}>No vehicles found.</td></tr> : 
                        safeVehicles.map(v => {
                           const vType = getVal(v, ['vehicle_type', 'Vehicle_Type', 'Vehicle_Class', 'Asset_Type', 'type']) || 'N/A';
                           const vCap = getVal(v, ['capacity', 'Capacity', 'Vehicle_Capacity', 'cap']) || 'N/A';
                           const vComp = getVal(v, ['company', 'Company', 'Operating_Company', 'Operating Company', 'owner_name']) || 'N/A';
                           return (
                             <tr key={v.id}>
                               <td style={{ color: '#38bdf8', fontWeight: 'bold' }}>{v.vehical_no || v.vehicle_no || v.registration_no}</td>
                               <td>{vType}</td>
                               <td>{vCap}</td>
                               <td>{vComp}</td>
                             </tr>
                           )
                        })
                      }
                    </tbody>
                  </>
                )}

                {(detailModal === 'LOADING' || detailModal === 'TRANSIT' || detailModal === 'UNLOADING') && (
                  <>
                    <thead><tr><th>Trip ID</th><th>Vehicle No</th><th>Driver Name</th><th>Route (From ➔ To)</th><th>Status</th></tr></thead>
                    <tbody>
                      {(() => {
                        const dataToShow = detailModal === 'LOADING' ? pendingLoadingTrips : detailModal === 'TRANSIT' ? activeTransitTrips : pendingUnloadingTrips;
                        if (dataToShow.length === 0) return <tr><td colSpan={5} style={{textAlign:'center'}}>No trips found in this category.</td></tr>;
                        return dataToShow.map(t => (
                          <tr key={t.id}>
                            <td style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold' }}>{t.trip_id || t.Trip_ID}</td>
                            <td style={{ color: '#fff', fontWeight: 'bold', fontSize: '15px' }}>{t.vehicle_no || t.Vehical_No || t.vehical_no}</td>
                            <td style={{ color: '#f59e0b' }}>{t.driver_name || t.Driver_Name || 'Unassigned'}</td>
                            <td>{(t.loading_point || t.Loading_Point || 'Unknown')} ➔ {(t.consignee_name || t.Consignee_Name || 'Unknown')}</td>
                            <td>
                              <span style={{ background: 'rgba(255,255,255,0.1)', padding: '5px 12px', borderRadius: '12px', fontSize: '10px', fontWeight: 'bold', color: detailModal === 'LOADING' ? '#f59e0b' : detailModal === 'TRANSIT' ? '#10b981' : '#ef4444', border: `1px solid ${detailModal === 'LOADING' ? '#f59e0b' : detailModal === 'TRANSIT' ? '#10b981' : '#ef4444'}` }}>
                                {t.trip_status || t.Trip_Status || 'PENDING'}
                              </span>
                            </td>
                          </tr>
                        ));
                      })()}
                    </tbody>
                  </>
                )}

                {detailModal === 'PERF_DETAIL' && (
                  <>
                    <thead><tr><th>Date</th><th>Trip / Challan</th><th>Route</th><th>Product</th><th>RTKM</th><th>Freight (₹)</th></tr></thead>
                    <tbody>
                      {(() => {
                        const vehTrips = performanceTrips.filter(t => (t.Vehical_No || t.vehicle_no || '').toUpperCase() === selectedPerfVehicle.toUpperCase());
                        if (vehTrips.length === 0) return <tr><td colSpan={6} style={{textAlign:'center'}}>No trips found.</td></tr>;
                        
                        return vehTrips.map((t, i) => (
                          <tr key={i}>
                            <td style={{ color: '#fff', fontWeight: 'bold' }}>{t.Loading_Date || t.loading_date || t.start_date || 'N/A'}</td>
                            <td style={{ color: '#94a3b8', fontSize:'12px' }}>ID: {t.Trip_ID || t.trip_id}<br/><span style={{color:'#f59e0b'}}>CH: {t.Challan_No || t.challan_no || 'N/A'}</span></td>
                            <td>{t.Loading_Point || t.loading_point} ➔ {t.Consignee_Name || t.consignee_name}</td>
                            <td style={{ color: '#38bdf8' }}>{t.Product_Type || t.product_type || 'N/A'} <br/><span style={{color:'#10b981', fontSize:'11px'}}>{t.Loaded_Qty || t.loaded_qty}</span></td>
                            <td style={{ color: '#10b981', fontWeight: 'bold' }}>{t.RTKM || t.rtkm || t.RTKM_Distance}</td>
                            <td style={{ color: '#c084fc', fontWeight: 'bold' }}>₹{t.gross_freight || t.Rate || t.Freight || '0'}</td>
                          </tr>
                        ));
                      })()}
                    </tbody>
                  </>
                )}

                {detailModal === 'DL_ALERTS' && (
                  <>
                    <thead><tr><th>Driver Name</th><th>Mobile</th><th>Valid Till</th><th>Status</th></tr></thead>
                    <tbody>
                      {expDrvs.map((d, i) => (
                        <tr key={i}>
                          <td style={{ color: '#fff', fontWeight: 'bold' }}>👨‍✈️ {d.name}</td>
                          <td>{d.mobile}</td>
                          <td style={{ color: d.status === 'EXPIRED' ? '#ef4444' : '#fff' }}>{d.date}</td>
                          <td><span style={{ background: d.status === 'EXPIRED' ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)', color: d.status === 'EXPIRED' ? '#ef4444' : '#f59e0b', padding: '5px 10px', borderRadius: '15px', fontSize: '10px', fontWeight: 'bold' }}>{d.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </>
                )}

                {/* 🚨 THE FIXED VEHICLE DOC ALERTS TABLE */}
                {detailModal === 'DOC_ALERTS' && (
                  <>
                    <thead><tr><th>Vehicle No</th><th>Document Details</th></tr></thead>
                    <tbody>
                      {expVehs.map((v, i) => (
                        <tr key={i}>
                          <td style={{ color: '#fff', fontWeight: 'bold', fontSize: '16px', verticalAlign: 'top' }}>🚛 {v.vNo}</td>
                          <td>
                            {v.issues.map((iss:any, idx:number) => (
                              <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px dashed #334155', padding: '8px 0', color: iss.status.includes('Expired') ? '#ef4444' : '#f59e0b' }}>
                                <span>📄 {iss.type}</span> 
                                <span>
                                  <b style={{marginRight:'10px'}}>{iss.date}</b>
                                  <span style={{ background: iss.status.includes('Expired') ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)', padding:'2px 8px', borderRadius:'10px', fontSize:'10px'}}>{iss.status}</span>
                                </span>
                              </div>
                            ))}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </>
                )}

                {detailModal === 'MAINT_ALERTS' && (
                  <>
                    <thead><tr><th>Vehicle No</th><th>Service Type</th><th>Due Date</th><th>Status</th></tr></thead>
                    <tbody>
                      {upcomingMaintenanceOps.map((m, i) => (
                        <tr key={i}>
                          <td style={{ color: '#fff', fontWeight: 'bold' }}>🚛 {m.vNo}</td>
                          <td style={{ color: '#f59e0b' }}>{m.service}</td>
                          <td style={{ color: m.status === 'OVERDUE' ? '#ef4444' : '#fff' }}>{m.date} {m.km ? `(${m.km} KM)` : ''}</td>
                          <td><span style={{ background: m.status === 'OVERDUE' ? 'rgba(239,68,68,0.2)' : 'rgba(56,189,248,0.2)', color: m.status === 'OVERDUE' ? '#ef4444' : '#38bdf8', padding: '5px 10px', borderRadius: '15px', fontSize: '10px', fontWeight: 'bold' }}>{m.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </>
                )}

                {detailModal === 'SHORTAGE_ALERTS' && (
                  <>
                    <thead><tr><th>Driver Name</th><th>Deduction Type</th><th>Amount (₹)</th></tr></thead>
                    <tbody>
                      {shortageRecoveryListOps.map((s, i) => (
                        <tr key={i}>
                          <td style={{ color: '#fff', fontWeight: 'bold' }}>👨‍✈️ {s.name}</td>
                          <td style={{ color: '#94a3b8' }}>Trip Shortage Recovery</td>
                          <td style={{ color: '#ec4899', fontWeight: 'bold', fontSize: '16px' }}>₹{s.amount.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </>
                )}
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ========================================== */}
      {/* 🤖 MAMTA AI CHAT WIDGET */}
      {/* ========================================== */}
      <button className="ai-chat-btn" onClick={() => setIsAiOpen(!isAiOpen)}>
        {isAiOpen ? '💬' : '🤖'}
      </button>

      {isAiOpen && (
        <div className="ai-chat-window">
          <div className="ai-chat-header">
            <h4 style={{ margin: 0, color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>
              🤖 Mamta AI Assistant
            </h4>
            <button onClick={() => setIsAiOpen(false)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '16px', cursor: 'pointer' }}>✕</button>
          </div>
          
          <div className="ai-chat-body">
            {chatMessages.map((msg, idx) => (
              <div key={idx} className={`chat-msg ${msg.sender}`}>
                {msg.text}
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          <div className="ai-chat-footer">
            <button onClick={handleAiVoiceStart} style={{ background: isListening ? '#ef4444' : '#334155', border: 'none', borderRadius: '50%', width: '40px', height: '40px', color: '#fff', fontSize: '18px', cursor: 'pointer', flexShrink: 0, transition: '0.3s' }}>
              {isListening ? '🎙️' : '🎤'}
            </button>
            <input type="text" placeholder="Ask anything about fleet..." value={aiInput} onChange={(e) => setAiInput(e.target.value)} onKeyPress={(e) => e.key === 'Enter' && handleAiSubmit()} style={{ flex: 1, background: '#0a0f1c', border: '1px solid #334155', color: '#fff', padding: '10px 15px', borderRadius: '20px', outline: 'none', fontSize: '13px' }} />
            <button onClick={() => handleAiSubmit()} style={{ background: '#c084fc', border: 'none', borderRadius: '50%', width: '40px', height: '40px', color: '#fff', fontSize: '18px', cursor: 'pointer', flexShrink: 0 }}>
              ➤
            </button>
          </div>
        </div>
      )}
    </div>
  );
}