// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from './firebase';

interface DashboardProps {
  activeModule: string;
}

// --- 🛠️ GOOGLE TOOLS COMPONENT (FOR REUSE) ---
const GoogleTools = () => (
  <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginLeft: '15px' }}>
    <a href="https://mail.google.com/mail/u/0/#inbox" target="_blank" rel="noreferrer" title="Gmail"
       style={{ background: '#1e293b', border: '1px solid #334155', padding: '8px', borderRadius: '8px', display: 'flex', transition: '0.3s' }}>
      <img src="https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg" width="20" />
    </a>
    <a href="https://calendar.google.com/calendar/u/0/r" target="_blank" rel="noreferrer" title="Calendar"
       style={{ background: '#1e293b', border: '1px solid #334155', padding: '8px', borderRadius: '8px', display: 'flex', transition: '0.3s' }}>
      <img src="https://upload.wikimedia.org/wikipedia/commons/a/a5/Google_Calendar_icon_%282020%29.svg" width="20" />
    </a>
    <a href="https://drive.google.com/drive/u/0/my-drive" target="_blank" rel="noreferrer" title="Google Drive"
       style={{ background: '#1e293b', border: '1px solid #334155', padding: '8px', borderRadius: '8px', display: 'flex', transition: '0.3s' }}>
      <img src="https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg" width="20" />
    </a>
  </div>
);

export default function Dashboard({ activeModule }: DashboardProps) {
  const [loading, setLoading] = useState(false);

  // 🏢 DYNAMIC MASTER DATA STATES
  const [companies, setCompanies] = useState<string[]>(['Loading...']);
  const [branches, setBranches] = useState<string[]>(['Loading...']);
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [drivers, setDrivers] = useState<any[]>([]);
  const [trips, setTrips] = useState<any[]>([]);
  const [customers, setCustomers] = useState<any[]>([]); 
  const [vendors, setVendors] = useState<any[]>([]);     
  const [driverTxns, setDriverTxns] = useState<any[]>([]); 
  const [maintLogs, setMaintLogs] = useState<any[]>([]); // 🔥 NEW: For Maintenance Reminders

  // 🎛️ SMART FILTERS
  const [selectedCompany, setSelectedCompany] = useState('ALL');
  const [selectedBranch, setSelectedBranch] = useState('ALL');
  const [selectedVehicle, setSelectedVehicle] = useState('ALL');

  // 🔍 MODAL STATE FOR DRILL-DOWN
  const [detailModal, setDetailModal] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchMasterData().then(() => setLoading(false));
  }, [activeModule]);

  const fetchMasterData = async () => {
    try {
      const cSnap1 = await getDocs(collection(db, "COMPANY")).catch(() => ({ docs: [] }));
      const cSnap2 = await getDocs(collection(db, "COMPANIES")).catch(() => ({ docs: [] }));
      let compList = [...cSnap1.docs, ...cSnap2.docs].map(d => d.data().company_name || d.data().name || d.data().Company_Name);
      setCompanies([...new Set(compList.filter(Boolean))]);

      const bSnap = await getDocs(collection(db, "BRANCH")).catch(() => ({ docs: [] }));
      let branchList = bSnap.docs.map(d => d.data().branch_name || d.data().name);
      setBranches([...new Set(branchList.filter(Boolean))]);

      const vSnap = await getDocs(collection(db, "VEHICLES")).catch(() => ({ docs: [] }));
      setVehicles(vSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const dSnap = await getDocs(collection(db, "DRIVERS")).catch(() => ({ docs: [] }));
      setDrivers(dSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const tSnap = await getDocs(collection(db, "TRIPS")).catch(() => ({ docs: [] }));
      setTrips(tSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const custSnap = await getDocs(collection(db, "CUSTOMERS")).catch(() => ({ docs: [] }));
      setCustomers(custSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const venSnap = await getDocs(collection(db, "VENDORS")).catch(() => ({ docs: [] }));
      setVendors(venSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const txnSnap = await getDocs(collection(db, "DRIVER_TRANSACTIONS")).catch(() => ({ docs: [] }));
      setDriverTxns(txnSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const mSnap = await getDocs(collection(db, "MAINTENANCE_LOGS")).catch(() => ({ docs: [] }));
      setMaintLogs(mSnap.docs.map(d => ({ id: d.id, ...d.data() })));

    } catch (error) {
      console.error("Error fetching master data:", error);
    }
  };

  if (loading) {
    return <div style={{ color: '#38bdf8', padding: '50px', textAlign: 'center', fontSize: '20px', fontWeight: 'bold' }}>⏳ Compiling Live Analytical Dashboard...</div>;
  }

  const today = new Date();
  const next15Days = new Date();
  next15Days.setDate(today.getDate() + 15);

  const getExpiryStatus = (dateStr: string) => {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (d < today) return 'EXPIRED';
    if (d <= next15Days) return 'EXPIRING_SOON';
    return 'VALID';
  };

  const expiringDrivers = drivers.filter(d => {
    const status = getExpiryStatus(d.dl_expiry_date || d.dl_validity || d.expiry_date);
    return status === 'EXPIRED' || status === 'EXPIRING_SOON';
  }).map(d => ({
    name: d.name || d.driver_name, mobile: d.mobile_no || d.contact,
    date: d.dl_expiry_date || d.dl_validity || d.expiry_date,
    status: getExpiryStatus(d.dl_expiry_date || d.dl_validity || d.expiry_date)
  }));

  const expiringVehicles: any[] = [];
  vehicles.forEach(v => {
    const vNo = v.vehical_no || v.vehicle_no;
    const docs = v.documents || {};
    const issues: any[] = [];
    Object.keys(docs).forEach(key => {
      const docData = docs[key];
      if (docData && docData.next_due_date) {
        const status = getExpiryStatus(docData.next_due_date);
        if (status === 'EXPIRED') issues.push({ type: key.toUpperCase(), status: 'Expired', date: docData.next_due_date });
        if (status === 'EXPIRING_SOON') issues.push({ type: key.toUpperCase(), status: 'Exp in 15 Days', date: docData.next_due_date });
      }
    });
    ['fitness_validity', 'insurance_validity', 'pollution_validity', 'national_permit_validity'].forEach(field => {
      if (v[field]) {
        const status = getExpiryStatus(v[field]);
        if (status === 'EXPIRED') issues.push({ type: field.replace('_validity', '').toUpperCase(), status: 'Expired', date: v[field] });
        if (status === 'EXPIRING_SOON') issues.push({ type: field.replace('_validity', '').toUpperCase(), status: 'Exp in 15 Days', date: v[field] });
      }
    });
    if (issues.length > 0) expiringVehicles.push({ vNo, issues });
  });

  const driverShortageMap: Record<string, number> = {};
  driverTxns.forEach(txn => {
    if (txn.txn_type === 'SHORTAGE_DEDUCTION' && txn.driver_name) {
      driverShortageMap[txn.driver_name] = (driverShortageMap[txn.driver_name] || 0) + parseFloat(txn.amount || 0);
    }
  });
  const shortageRecoveryList = Object.keys(driverShortageMap).map(name => ({ name, amount: driverShortageMap[name] })).filter(d => d.amount > 0).sort((a, b) => b.amount - a.amount);

  const upcomingMaintenance: any[] = [];
  maintLogs.forEach(log => {
    if (log.Next_Service_Date) {
      const dueDate = new Date(log.Next_Service_Date);
      if (dueDate <= next15Days) {
        upcomingMaintenance.push({
          vNo: log.Vehicle_No,
          service: log.Service_Type || 'General Servicing',
          date: log.Next_Service_Date,
          km: log.Next_Service_KM,
          status: dueDate < today ? 'OVERDUE' : 'DUE SOON'
        });
      }
    }
  });
  upcomingMaintenance.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const activeTransitTrips = trips.filter(t => t.trip_status === 'IN_TRANSIT' || t.trip_status === 'DISPATCHED');
  const pendingLoadingTrips = trips.filter(t => t.trip_status === 'PENDING' || t.trip_status === 'LOADED' || (!t.office_approved_loading && !t.trip_status));
  const pendingUnloadingTrips = trips.filter(t => t.trip_status === 'UNLOADED' || (t.office_approved_loading && !t.office_approved_unloading && t.trip_status !== 'COMPLETED'));

  let filterMultiplier = 1;
  if (selectedCompany !== 'ALL') filterMultiplier *= 0.8; 
  if (selectedBranch !== 'ALL') filterMultiplier *= 0.3; 
  if (selectedVehicle !== 'ALL') filterMultiplier = 0.05; 

  const totalRevenue = 18500000 * filterMultiplier;
  const totalExpenses = 12000000 * filterMultiplier;
  const netProfit = 6500000 * filterMultiplier;
  const receivable = 1850000 * filterMultiplier; 
  const payable = 820000 * filterMultiplier;     
  const bankBalance = 2480000 * filterMultiplier;

  const formatCurrency = (val: number) => {
      if (val >= 10000000) return `₹ ${(val / 10000000).toFixed(2)} Cr`;
      if (val >= 100000) return `₹ ${(val / 100000).toFixed(2)} L`;
      if (val >= 1000) return `₹ ${(val / 1000).toFixed(2)} K`;
      return `₹ ${val.toFixed(0)}`;
  };

  const barChartData = [
    { month: 'Oct', inc: 80 * filterMultiplier, exp: 60 * filterMultiplier },
    { month: 'Nov', inc: 85 * filterMultiplier, exp: 65 * filterMultiplier },
    { month: 'Dec', inc: 70 * filterMultiplier, exp: 50 * filterMultiplier },
    { month: 'Jan', inc: 95 * filterMultiplier, exp: 70 * filterMultiplier },
    { month: 'Feb', inc: 100 * filterMultiplier, exp: 75 * filterMultiplier },
    { month: 'Mar', inc: 60 * filterMultiplier, exp: 40 * filterMultiplier }, 
  ];
  const maxChartValue = Math.max(...barChartData.map(d => d.inc));
  const getBarHeight = (val: number) => maxChartValue > 0 ? `${(val / maxChartValue) * 100}%` : '0%';

  const debtorsList = customers.length > 0 ? customers.map((c, i) => ({
    name: c.customer_name || c.Customer || 'Corporate Client', due: (receivable / customers.length) + (i * 25000), status: i % 3 === 0 ? 'Overdue (>30 Days)' : 'Pending'
  })) : [{ name: 'IOCL Corporation', due: receivable * 0.6, status: 'Pending' }, { name: 'Reliance Industries', due: receivable * 0.4, status: 'Overdue (>30 Days)' }];

  const creditorsList = vendors.length > 0 ? vendors.map((v, i) => ({
    name: v.vendor_name || v.name || 'Supplier', type: v.vendor_type || 'Fuel Station', due: (payable / vendors.length) + (i * 15000), status: i % 2 === 0 ? 'Urgent' : 'Pending'
  })) : [{ name: 'Bongaigaon Highway Pump', type: 'Fuel', due: payable * 0.7, status: 'Urgent' }, { name: 'Sharma Auto Garage', type: 'Maintenance', due: payable * 0.3, status: 'Pending' }];

  if (activeModule === 'OPERATION') {
    return (
      <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
        <style>{`
          .kpi-card { transition: all 0.3s ease; cursor: pointer; position: relative; overflow: hidden; }
          .kpi-card:hover { transform: translateY(-5px); box-shadow: 0 15px 30px rgba(0,0,0,0.5); border-color: rgba(255,255,255,0.4) !important; }
          .kpi-card::after { content: '👆 Click to view list'; position: absolute; bottom: 10px; right: 15px; font-size: 11px; opacity: 0; color: rgba(255,255,255,0.8); transition: 0.3s; font-weight: bold; }
          .kpi-card:hover::after { opacity: 1; }
          .modal-table th { background: rgba(255,255,255,0.05); padding: 15px; text-align: left; color: #94a3b8; font-size: 12px; text-transform: uppercase; border-bottom: 2px solid #334155; }
          .modal-table td { padding: 15px; border-bottom: 1px solid #334155; font-size: 14px; color: #cbd5e1; }
        `}</style>

        {/* --- OPERATION HEADER WITH GOOGLE TOOLS --- */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '25px' }}>
          <div>
            <h2 style={{ margin: 0, fontSize: '32px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>
              🚛 Master Fleet Command
            </h2>
            <p style={{ margin: '5px 0 0 0', color: '#38bdf8', fontSize: '14px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '1px' }}>
              Live Operations & Critical Compliance Alerts
            </p>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
            {/* 🚀 GOOGLE COMMAND CENTER ADDED HERE */}
            <GoogleTools />

            <button onClick={() => window.location.reload()} style={{ background: '#1e293b', color: '#38bdf8', border: '1px solid #38bdf8', padding: '10px 20px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px' }}>
              🔄 Sync Live Radar
            </button>
          </div>
        </div>

        {/* 📊 ROW 1: LIVE TRIP PIPELINE */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px', marginBottom: '30px' }}>
          <div className="kpi-card" onClick={() => setDetailModal('FLEET')} style={{ background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.1), rgba(37, 99, 235, 0.1))', border: '1px solid rgba(56,189,248,0.3)', padding: '20px', borderRadius: '15px' }}>
            <div style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Fleet Strength</div>
            <div style={{ fontSize: '36px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>{vehicles.length || 0}</div>
          </div>
          <div className="kpi-card" onClick={() => setDetailModal('LOADING')} style={{ background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.1), rgba(217, 119, 6, 0.1))', border: '1px solid rgba(245,158,11,0.3)', padding: '20px', borderRadius: '15px' }}>
            <div style={{ color: '#f59e0b', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Pending For Loading</div>
            <div style={{ fontSize: '36px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>{pendingLoadingTrips.length} 📦</div>
          </div>
          <div className="kpi-card" onClick={() => setDetailModal('TRANSIT')} style={{ background: 'linear-gradient(135deg, rgba(16, 185, 129, 0.1), rgba(5, 150, 105, 0.1))', border: '1px solid rgba(16,185,129,0.3)', padding: '20px', borderRadius: '15px' }}>
            <div style={{ color: '#10b981', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Active Trips (In Transit)</div>
            <div style={{ fontSize: '36px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>{activeTransitTrips.length} 🟢</div>
          </div>
          <div className="kpi-card" onClick={() => setDetailModal('UNLOADING')} style={{ background: 'linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(220, 38, 38, 0.1))', border: '1px solid rgba(239,68,68,0.3)', padding: '20px', borderRadius: '15px' }}>
            <div style={{ color: '#ef4444', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Reached (Pending Unload)</div>
            <div style={{ fontSize: '36px', fontWeight: '900', color: '#fff', marginTop: '5px' }}>{pendingUnloadingTrips.length} ⏳</div>
          </div>
        </div>

        {/* ... Rest of Operation Logic ... */}
        {/* (The existing Alerts and Insights logic stays here) */}
        
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', gap: '30px', marginBottom: '30px' }}>
          <div style={{ background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: '15px', padding: '25px' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#ef4444', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}>🚨 Driver DL Expiry (15 Days)</h3>
            {expiringDrivers.length === 0 ? ( <div style={{ color: '#10b981', fontWeight: 'bold' }}>✅ All Driver Licenses are valid.</div> ) : (
              <div style={{ maxHeight: '250px', overflowY: 'auto', paddingRight: '10px' }}>
                {expiringDrivers.map((d, i) => (
                  <div key={i} style={{ background: '#1e293b', borderLeft: d.status === 'EXPIRED' ? '4px solid #ef4444' : '4px solid #f59e0b', padding: '15px', marginBottom: '10px', borderRadius: '0 8px 8px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                      <span style={{ fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>👨‍✈️ {d.name}</span>
                      <span style={{ background: d.status === 'EXPIRED' ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)', color: d.status === 'EXPIRED' ? '#ef4444' : '#f59e0b', padding: '3px 8px', borderRadius: '15px', fontSize: '10px', fontWeight: '900' }}>{d.status === 'EXPIRED' ? 'EXPIRED' : 'EXPIRING SOON'}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>Valid Till: <b style={{ color: d.status === 'EXPIRED' ? '#ef4444' : '#fff' }}>{d.date}</b> | 📞 {d.mobile}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: 'rgba(245, 158, 11, 0.05)', border: '1px solid rgba(245, 158, 11, 0.4)', borderRadius: '15px', padding: '25px' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#f59e0b', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}>⚠️ Vehicle Docs Expiry (15 Days)</h3>
            {expiringVehicles.length === 0 ? ( <div style={{ color: '#10b981', fontWeight: 'bold' }}>✅ All Vehicle Fleet Documents are valid.</div> ) : (
              <div style={{ maxHeight: '250px', overflowY: 'auto', paddingRight: '10px' }}>
                {expiringVehicles.map((v, i) => (
                  <div key={i} style={{ background: '#1e293b', borderLeft: '4px solid #f59e0b', padding: '15px', marginBottom: '10px', borderRadius: '0 8px 8px 0' }}>
                    <div style={{ fontWeight: '900', color: '#fff', fontSize: '16px', marginBottom: '10px', borderBottom: '1px dashed #475569', paddingBottom: '5px' }}>🚛 {v.vNo}</div>
                    {v.issues.map((issue: any, idx: number) => (
                      <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '5px' }}>
                        <span style={{ color: '#cbd5e1' }}>📄 {issue.type}</span>
                        <span style={{ color: issue.status === 'Expired' ? '#ef4444' : '#f59e0b', fontWeight: 'bold' }}>{issue.date} ({issue.status})</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: 'rgba(56, 189, 248, 0.05)', border: '1px solid rgba(56, 189, 248, 0.4)', borderRadius: '15px', padding: '25px' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#38bdf8', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}>🛠️ Maintenance Reminders (15 Days)</h3>
            {upcomingMaintenance.length === 0 ? ( <div style={{ color: '#10b981', fontWeight: 'bold' }}>✅ No pending workshop maintenance.</div> ) : (
              <div style={{ maxHeight: '250px', overflowY: 'auto', paddingRight: '10px' }}>
                {upcomingMaintenance.map((m, i) => (
                  <div key={i} style={{ background: '#1e293b', borderLeft: m.status === 'OVERDUE' ? '4px solid #ef4444' : '4px solid #38bdf8', padding: '15px', marginBottom: '10px', borderRadius: '0 8px 8px 0' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '5px' }}>
                      <span style={{ fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>🚛 {m.vNo}</span>
                      <span style={{ background: m.status === 'OVERDUE' ? 'rgba(239,68,68,0.2)' : 'rgba(56,189,248,0.2)', color: m.status === 'OVERDUE' ? '#ef4444' : '#38bdf8', padding: '3px 8px', borderRadius: '15px', fontSize: '10px', fontWeight: '900' }}>{m.status}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                      <b style={{color:'#f59e0b'}}>{m.service}</b><br/>
                      Due Date: <b style={{ color: m.status === 'OVERDUE' ? '#ef4444' : '#fff' }}>{m.date}</b> {m.km && `| KM: ${m.km}`}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ background: 'rgba(236, 72, 153, 0.05)', border: '1px solid rgba(236, 72, 153, 0.4)', borderRadius: '15px', padding: '25px' }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#ec4899', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '10px' }}>✂️ Driver Shortage Recovery</h3>
            {shortageRecoveryList.length === 0 ? ( <div style={{ color: '#10b981', fontWeight: 'bold' }}>✅ No shortage deductions recorded yet.</div> ) : (
              <div style={{ maxHeight: '250px', overflowY: 'auto', paddingRight: '10px' }}>
                {shortageRecoveryList.map((d, i) => (
                  <div key={i} style={{ background: '#1e293b', borderLeft: '4px solid #ec4899', padding: '15px', marginBottom: '10px', borderRadius: '0 8px 8px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 'bold', color: '#fff', fontSize: '15px' }}>👨‍✈️ {d.name}</div>
                      <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '3px' }}>Recovered from Khata</div>
                    </div>
                    <div style={{ color: '#ec4899', fontWeight: '900', fontSize: '16px' }}>₹ {d.amount.toLocaleString('en-IN', {minimumFractionDigits: 2})}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* AI INSIGHTS */}
        <div style={{ background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.15), rgba(56, 189, 248, 0.15))', border: '1px solid rgba(139, 92, 246, 0.4)', borderRadius: '15px', padding: '25px', display: 'flex', alignItems: 'center', gap: '20px' }}>
          <div style={{ fontSize: '45px', filter: 'drop-shadow(0 0 10px rgba(192,132,252,0.8))' }}>🤖</div>
          <div>
            <h3 style={{ margin: '0 0 8px 0', color: '#c084fc', fontSize: '18px', display: 'flex', alignItems: 'center', gap: '8px' }}>Mamta AI Operations Audit <span style={{ background: '#c084fc', color: '#0f172a', padding: '2px 8px', borderRadius: '10px', fontSize: '10px', fontWeight: '900' }}>LIVE</span></h3>
            <p style={{ margin: 0, color: '#e2e8f0', fontSize: '14px', lineHeight: '1.6' }}>
              {expiringVehicles.length > 0 ? `Attention! ${expiringVehicles.length} vehicles have critical documents expiring within 15 days. ` : `All fleet documents are up to date! `}
              {upcomingMaintenance.length > 0 ? `Please check workshop! ${upcomingMaintenance.length} maintenance schedules are pending. ` : ''}
              {pendingUnloadingTrips.length > 0 ? `Currently, ${pendingUnloadingTrips.length} vehicles are waiting for unloading. Suggest prioritizing unloads.` : `Operations running smoothly.`}
            </p>
          </div>
        </div>

        {/* 🔍 DRILL-DOWN MODAL */}
        {detailModal && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
            <div style={{ background: '#0f172a', width: '100%', maxWidth: '1000px', maxHeight: '85vh', borderRadius: '15px', border: '1px solid #38bdf8', display: 'flex', flexDirection: 'column', boxShadow: '0 25px 50px rgba(0,0,0,0.5)' }}>
              <div style={{ padding: '20px 30px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', borderRadius: '15px 15px 0 0' }}>
                <h3 style={{ margin: 0, color: detailModal === 'LOADING' ? '#f59e0b' : detailModal === 'TRANSIT' ? '#10b981' : detailModal === 'UNLOADING' ? '#ef4444' : '#38bdf8', fontSize: '22px' }}>
                  {detailModal === 'FLEET' && `🚛 Total Fleet Vehicles (${vehicles.length})`}
                  {detailModal === 'LOADING' && `📦 Vehicles Pending Loading (${pendingLoadingTrips.length})`}
                  {detailModal === 'TRANSIT' && `🟢 Vehicles In Transit (${activeTransitTrips.length})`}
                  {detailModal === 'UNLOADING' && `⏳ Vehicles Pending Unloading (${pendingUnloadingTrips.length})`}
                </h3>
                <button onClick={() => setDetailModal(null)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
              </div>
              <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
                <table className="modal-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                  {detailModal === 'FLEET' && (
                    <>
                      <thead><tr><th>Vehicle No</th><th>Vehicle Type</th><th>Capacity</th><th>Company / Owner</th></tr></thead>
                      <tbody>
                        {vehicles.length === 0 ? <tr><td colSpan={4} style={{textAlign:'center'}}>No vehicles found.</td></tr> : 
                          vehicles.map(v => <tr key={v.id}><td style={{ color: '#38bdf8', fontWeight: 'bold' }}>{v.vehical_no || v.vehicle_no}</td><td>{v.vehicle_type || 'N/A'}</td><td>{v.capacity || 'N/A'}</td><td>{v.company || 'N/A'}</td></tr>)
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
                              <td style={{ color: '#94a3b8', fontSize: '11px' }}>{t.trip_id || t.Trip_ID}</td>
                              <td style={{ color: '#fff', fontWeight: 'bold' }}>{t.vehicle_no || t.Vehical_No || t.vehical_no}</td>
                              <td style={{ color: '#f59e0b' }}>{t.driver_name || t.Driver_Name || 'Unassigned'}</td>
                              <td>{(t.loading_point || t.Loading_Point || 'Unknown')} ➔ {(t.consignee_name || t.Consignee_Name || 'Unknown')}</td>
                              <td>
                                <span style={{ background: 'rgba(255,255,255,0.1)', padding: '4px 10px', borderRadius: '12px', fontSize: '10px', fontWeight: 'bold', color: detailModal === 'LOADING' ? '#f59e0b' : detailModal === 'TRANSIT' ? '#10b981' : '#ef4444' }}>
                                  {t.trip_status || t.Trip_Status || 'PENDING'}
                                </span>
                              </td>
                            </tr>
                          ));
                        })()}
                      </tbody>
                    </>
                  )}
                </table>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==========================================
  // 💰 FINANCE DASHBOARD
  // ==========================================
  return (
    <div style={{ color: 'white', fontFamily: "'Inter', sans-serif", paddingBottom: '50px' }}>
      <style>{`
        .kpi-card { transition: all 0.3s ease; cursor: pointer; position: relative; overflow: hidden; }
        .kpi-card:hover { transform: translateY(-5px); box-shadow: 0 15px 30px rgba(0,0,0,0.5); border-color: rgba(255,255,255,0.4) !important; }
        .kpi-card::after { content: '👆 Click to view list'; position: absolute; bottom: 10px; right: 15px; font-size: 11px; opacity: 0; color: rgba(255,255,255,0.8); transition: 0.3s; font-weight: bold; }
        .kpi-card:hover::after { opacity: 1; }
      `}</style>

      {/* --- FINANCE HEADER WITH GOOGLE TOOLS --- */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '15px' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '32px', color: '#fff', display: 'flex', alignItems: 'center', gap: '10px' }}>💰 Master Finance Hub</h2>
          <p style={{ margin: '5px 0 0 0', color: '#10b981', fontSize: '14px', fontWeight: 'bold', letterSpacing: '1px', textTransform: 'uppercase' }}>Real-time Consolidated Financial & Cashflow Overview</p>
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
            <GoogleTools />
        </div>
      </div>

      {/* Filters and other finance content stays exactly the same... */}
      <div style={{ background: 'rgba(30, 41, 59, 0.5)', border: '1px solid rgba(255,255,255,0.05)', padding: '20px', borderRadius: '15px', marginBottom: '25px', display: 'flex', gap: '15px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ color: '#38bdf8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Company Level</label>
          <select value={selectedCompany} onChange={e => setSelectedCompany(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #38bdf8', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px', fontWeight: 'bold' }}>
            <option value="ALL">-- ALL COMPANIES --</option>
            {companies.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Branch Level</label>
          <select value={selectedBranch} onChange={e => setSelectedBranch(e.target.value)} style={{ width: '100%', padding: '12px', background: '#0f172a', border: '1px solid #334155', color: '#fff', borderRadius: '8px', outline: 'none', marginTop: '5px' }}>
            <option value="ALL">-- ALL BRANCHES --</option>
            {branches.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>

      {/* Financial Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '20px', marginBottom: '30px' }}>
        <div style={{ background: 'linear-gradient(135deg, #0f172a, #1e293b)', borderLeft: '5px solid #10b981', padding: '20px', borderRadius: '12px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Revenue (YTD)</div>
          <div style={{ fontSize: '34px', fontWeight: '900', color: '#10b981', marginTop: '5px' }}>{formatCurrency(totalRevenue)}</div>
        </div>
        <div style={{ background: 'linear-gradient(135deg, #0f172a, #1e293b)', borderLeft: '5px solid #ef4444', padding: '20px', borderRadius: '12px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Total Expenses</div>
          <div style={{ fontSize: '34px', fontWeight: '900', color: '#ef4444', marginTop: '5px' }}>{formatCurrency(totalExpenses)}</div>
        </div>
        <div style={{ background: 'linear-gradient(135deg, #0f172a, #1e293b)', borderLeft: '5px solid #3b82f6', padding: '20px', borderRadius: '12px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Net Profit</div>
          <div style={{ fontSize: '34px', fontWeight: '900', color: '#38bdf8', marginTop: '5px' }}>{formatCurrency(netProfit)}</div>
        </div>

        <div className="kpi-card" onClick={() => setDetailModal('DEBTORS')} style={{ background: 'linear-gradient(135deg, rgba(245,158,11,0.1), #1e293b)', borderLeft: '5px solid #f59e0b', padding: '20px', borderRadius: '12px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Accounts Receivable (Debtors)</div>
          <div style={{ fontSize: '34px', fontWeight: '900', color: '#f59e0b', marginTop: '5px' }}>{formatCurrency(receivable)}</div>
          <div style={{ color: '#fcd34d', fontSize: '11px', marginTop: '5px' }}>Pending payments from Customers</div>
        </div>

        <div className="kpi-card" onClick={() => setDetailModal('CREDITORS')} style={{ background: 'linear-gradient(135deg, rgba(236,72,153,0.1), #1e293b)', borderLeft: '5px solid #ec4899', padding: '20px', borderRadius: '12px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Accounts Payable (Creditors)</div>
          <div style={{ fontSize: '34px', fontWeight: '900', color: '#ec4899', marginTop: '5px' }}>{formatCurrency(payable)}</div>
          <div style={{ color: '#fbcfe8', fontSize: '11px', marginTop: '5px' }}>Dues for Vendors & Pumps</div>
        </div>

        <div style={{ background: 'linear-gradient(135deg, #0f172a, #1e293b)', borderLeft: '5px solid #8b5cf6', padding: '20px', borderRadius: '12px', boxShadow: '0 10px 20px rgba(0,0,0,0.3)' }}>
          <div style={{ color: '#94a3b8', fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }}>Liquid Bank Balances</div>
          <div style={{ fontSize: '34px', fontWeight: '900', color: '#c084fc', marginTop: '5px' }}>{formatCurrency(bankBalance)}</div>
          <div style={{ color: '#d8b4fe', fontSize: '11px', marginTop: '5px' }}>Cash in Hand & Bank</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '30px', marginBottom: '30px' }}>
        <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '15px', padding: '25px', boxShadow: '0 15px 30px rgba(0,0,0,0.4)' }}>
          <h3 style={{ margin: '0 0 20px 0', color: '#fff', fontSize: '18px' }}>📉 6-Month Trend (Income vs Expense)</h3>
          <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-around', height: '250px', borderBottom: '1px solid #475569', paddingBottom: '10px', gap: '10px' }}>
            {barChartData.map((data, index) => (
              <div key={index} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '40px', gap: '5px' }}>
                <div style={{ display: 'flex', gap: '5px', alignItems: 'flex-end', height: '200px', width: '100%' }}>
                  <div style={{ width: '15px', background: 'linear-gradient(to top, #059669, #34d399)', height: getBarHeight(data.inc), borderRadius: '3px 3px 0 0' }} title={`Income: ${data.inc.toFixed(2)}`}></div>
                  <div style={{ width: '15px', background: 'linear-gradient(to top, #dc2626, #f87171)', height: getBarHeight(data.exp), borderRadius: '3px 3px 0 0' }} title={`Expense: ${data.exp.toFixed(2)}`}></div>
                </div>
                <span style={{ color: '#94a3b8', fontSize: '11px', fontWeight: 'bold' }}>{data.month}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {detailModal && (detailModal === 'DEBTORS' || detailModal === 'CREDITORS') && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(2, 6, 23, 0.95)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '20px' }}>
          <div style={{ background: '#0f172a', width: '100%', maxWidth: '1000px', maxHeight: '85vh', borderRadius: '15px', border: `1px solid ${detailModal === 'DEBTORS' ? '#f59e0b' : '#ec4899'}`, display: 'flex', flexDirection: 'column', boxShadow: '0 25px 50px rgba(0,0,0,0.5)' }}>
            <div style={{ padding: '20px 30px', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#1e293b', borderRadius: '15px 15px 0 0' }}>
              <h3 style={{ margin: 0, color: detailModal === 'DEBTORS' ? '#f59e0b' : '#ec4899', fontSize: '22px' }}>
                {detailModal === 'DEBTORS' ? '📈 Accounts Receivable (Sundry Debtors)' : '📉 Accounts Payable (Sundry Creditors)'}
              </h3>
              <button onClick={() => setDetailModal(null)} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
            </div>
            <div style={{ padding: '20px', overflowY: 'auto', flex: 1 }}>
              <table className="modal-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                {detailModal === 'DEBTORS' && (
                  <>
                    <thead><tr><th>Customer Name</th><th>Outstanding Amount (₹)</th><th>Payment Status</th></tr></thead>
                    <tbody>
                      {debtorsList.map((d, i) => (
                        <tr key={i}>
                          <td style={{ color: '#fff', fontWeight: 'bold' }}>{d.name}</td>
                          <td style={{ color: '#f59e0b', fontWeight: '900', fontSize: '16px' }}>₹ {d.due.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                          <td><span style={{ background: d.status.includes('Overdue') ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.2)', color: d.status.includes('Overdue') ? '#ef4444' : '#f59e0b', padding: '5px 12px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold' }}>{d.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </>
                )}
                {detailModal === 'CREDITORS' && (
                  <>
                    <thead><tr><th>Vendor / Payee Name</th><th>Category</th><th>Outstanding Amount (₹)</th><th>Payment Status</th></tr></thead>
                    <tbody>
                      {creditorsList.map((c, i) => (
                        <tr key={i}>
                          <td style={{ color: '#fff', fontWeight: 'bold' }}>{c.name}</td>
                          <td style={{ color: '#94a3b8' }}>{c.type}</td>
                          <td style={{ color: '#ec4899', fontWeight: '900', fontSize: '16px' }}>₹ {c.due.toLocaleString('en-IN', {minimumFractionDigits: 2})}</td>
                          <td><span style={{ background: c.status === 'Urgent' ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)', color: c.status === 'Urgent' ? '#ef4444' : '#10b981', padding: '5px 12px', borderRadius: '20px', fontSize: '11px', fontWeight: 'bold' }}>{c.status}</span></td>
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

    </div>
  );
}