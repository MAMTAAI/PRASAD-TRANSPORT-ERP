// @ts-nocheck
import React, { useState, useEffect } from 'react';
import SIDEBAR from './SIDEBAR';
import Dashboard from './Dashboard';
import Vehical from './Vehical';
import DRIVER from './DRIVER';
import TripManagment from './TripManagment';
import FuelMgmt from './FuelMgmt';
import LodingDetals from './LodingDetals';
import UnlodingDetals from './UnlodingDetals';
import VehicleDocs from './VehicleDocs';
import TyreMgmt from './TyreMgmt';
import VehicleMaintenance from './VehicleMaintenance';
import CashBankBook from './CashBankBook';
import LedgerMgmt from './LedgerMgmt';
import FinancialReports from './FinancialReports';
import BillManagement from './BillManagement';
import LocationRtkmMaster from './LocationRtkmMaster';
import Customer from './Customer';
import Vander from './Vander';
import TollFastagMgmt from './TollFastagMgmt';
import LoanEmiMgmt from './LoanEmiMgmt';
import GstMgmt from './GstMgmt';
import TdsMgmt from './TdsMgmt';
import Login from './Login';
import DriverPortal from './DriverPortal';
import UGER from './UGER';
import CompanyInbox from './CompanyInbox';
import AiLetterPad from './AiLetterPad'; 
import WhatsappDashboard from './WhatsappDashboard'; // 🔥 NEW: WhatsApp Component Import

export default function App() {
  const [user, setUser] = useState(null);
  const [isDriverMode, setIsDriverMode] = useState(false); 
  const [authLoading, setAuthLoading] = useState(true);

  const [activeModule, setActiveModule] = useState('OPERATION'); 
  const [activeComponent, setActiveComponent] = useState('DASHBOARD');
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const savedUser = localStorage.getItem('prasad_user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
    }
    setAuthLoading(false);
    
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleLogout = () => {
    if (window.confirm('Are you sure you want to securely log out?')) {
      localStorage.clear();
      sessionStorage.clear();
      setUser(null);
      setIsDriverMode(false);
    }
  };

  const handleLoginSuccess = (userData) => {
    localStorage.setItem('prasad_user', JSON.stringify(userData));
    setUser(userData);
  };

  const checkView = (permName: string) => {
    if (!user) return false;
    if (user.role === 'ADMIN') return true;
    const p = user.permissions?.find((x: any) => x.name === permName);
    return p ? p.view : false;
  };

  const hasPermission = (itemId: string, module: string) => {
    if (!user) return false;
    if (user.role === 'ADMIN') return true;
    
    if (itemId === 'AI_DOCS') return true;
    if (itemId === 'WHATSAPP') return true; // 🔥 NEW: Everyone gets WhatsApp access for now

    if (module === 'OPERATION') {
      if (itemId === 'DASHBOARD') return checkView('Operations Dashboard');
      if (itemId === 'VEHICLE') return checkView('Vehicle Fleet');
      if (itemId === 'DRIVER') return checkView('Driver Master');
      if (itemId === 'TRIP') return checkView('Trip Management');
      if (itemId === 'FUEL' || itemId === 'MAINTENANCE' || itemId === 'TYRE' || itemId === 'DOCS') return checkView('Fuel & Maintenance');
      if (itemId === 'LOADING' || itemId === 'UNLOADING') return checkView('Loading / Unloading');
      if (itemId === 'LOCATION_RTKM') return checkView('Trip Management'); 
    }
    if (module === 'ACCOUNTS') {
      if (itemId === 'DASHBOARD' || itemId === 'PNL' || itemId === 'COMPANY' || itemId === 'VENDOR' || itemId === 'LOAN') return checkView('Finance Hub');
      if (itemId === 'UGER') return checkView('User & Role Mgmt');
      if (itemId === 'BILLING') return checkView('Billing & Invoicing');
      if (itemId === 'BANK' || itemId === 'LEDGER') return checkView('Ledger & Cash Book');
      if (itemId === 'GST' || itemId === 'TDS' || itemId === 'TOLL') return checkView('Tax (GST/TDS) & Toll');
      if (itemId === 'LOCATION_RTKM') return checkView('Finance Hub'); 
    }
    if (module === 'CRM') {
      if (itemId === 'DASHBOARD' || itemId === 'INBOX') return checkView('CRM Dashboard');
      if (itemId === 'CUSTOMER') return checkView('Customer Master');
    }
    return false;
  };

  if (authLoading) return <div style={{background:'#020617', height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', color:'#38bdf8'}}>Loading Prasad ERP...</div>;

  if (isDriverMode) {
    return <DriverPortal onBack={() => setIsDriverMode(false)} />;
  }

  if (!user) {
    return <Login onLoginSuccess={handleLoginSuccess} onDriverClick={() => setIsDriverMode(true)} />;
  }

  const renderActiveComponent = () => {
    if (!hasPermission(activeComponent, activeModule)) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '80vh', textAlign: 'center' }}>
          <div style={{ fontSize: '80px', marginBottom: '20px', filter: 'drop-shadow(0 0 30px rgba(239, 68, 68, 0.6))' }}>🔒</div>
          <h2 style={{ color: '#ef4444', margin: '0 0 10px 0', fontSize: '32px', fontWeight: '900', letterSpacing: '2px' }}>ACCESS RESTRICTED</h2>
          <p style={{ color: '#94a3b8', fontSize: '16px' }}>You do not have authorization to view this module.</p>
        </div>
      );
    }
    switch (activeComponent) {
      case 'DASHBOARD': return <Dashboard activeModule={activeModule} />;
      case 'AI_DOCS': return <AiLetterPad />;
      case 'WHATSAPP': return <WhatsappDashboard />; // 🔥 NEW: Render WhatsApp Page
      case 'UGER': return <UGER />;
      case 'VEHICLE': return <Vehical />;
      case 'DRIVER': return <DRIVER />;
      case 'TRIP': return <TripManagment />;
      case 'FUEL': return <FuelMgmt />;
      case 'LOADING': return <LodingDetals />;
      case 'UNLOADING': return <UnlodingDetals />;
      case 'DOCS': return <VehicleDocs />;
      case 'TYRE': return <TyreMgmt />;
      case 'MAINTENANCE': return <VehicleMaintenance />;
      case 'BANK': return <CashBankBook />;
      case 'LEDGER': return <LedgerMgmt />;
      case 'PNL': return <FinancialReports />;
      case 'BILLING': return <BillManagement />;
      case 'LOCATION_RTKM': return <LocationRtkmMaster />;
      case 'CUSTOMER': return <Customer />;
      case 'VENDOR': return <Vander />;
      case 'TOLL': return <TollFastagMgmt />;
      case 'LOAN': return <LoanEmiMgmt />;
      case 'GST': return <GstMgmt />;
      case 'TDS': return <TdsMgmt />;
      case 'INBOX': return <CompanyInbox />;
      default: return <Dashboard activeModule={activeModule} />;
    }
  };

  const profileAvatar = `https://ui-avatars.com/api/?name=${user.full_name || user.name || 'User'}&background=38bdf8&color=fff&bold=true&size=100`;

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', overflow: 'hidden', background: '#020617', fontFamily: "'Inter', sans-serif" }}>
      
      {isMobile && mobileMenuOpen && (
        <div onClick={() => setMobileMenuOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 998, backdropFilter: 'blur(4px)' }} />
      )}

      <SIDEBAR 
        activeComponent={activeComponent} 
        setActiveComponent={setActiveComponent} 
        activeModule={activeModule} 
        setActiveModule={setActiveModule}
        isMobile={isMobile}
        isOpen={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', width: isMobile ? '100%' : 'calc(100% - 260px)' }}>
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', background: '#0f172a', borderBottom: '1px solid #1e293b' }}>
          
          <div style={{ display: 'flex', gap: '15px', alignItems: 'center', overflowX: 'auto', flex: 1 }}>
            {isMobile && (
              <button onClick={() => setMobileMenuOpen(true)} style={{ background: 'transparent', border: 'none', color: '#38bdf8', fontSize: '28px', cursor: 'pointer', padding: '0 10px 0 0' }}>☰</button>
            )}

            <button onClick={() => { setActiveModule('OPERATION'); setActiveComponent('DASHBOARD'); }} style={{ padding: '12px 20px', borderRadius: '10px', border: 'none', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s', fontSize: '13px', whiteSpace: 'nowrap', background: activeModule === 'OPERATION' ? 'linear-gradient(135deg, #3b82f6, #6366f1)' : '#1e293b', color: activeModule === 'OPERATION' ? '#fff' : '#94a3b8', boxShadow: activeModule === 'OPERATION' ? '0 4px 15px rgba(59,130,246,0.4)' : 'none' }}>🚛 OPERATIONS</button>
            <button onClick={() => { setActiveModule('ACCOUNTS'); setActiveComponent('DASHBOARD'); }} style={{ padding: '12px 20px', borderRadius: '10px', border: 'none', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s', fontSize: '13px', whiteSpace: 'nowrap', background: activeModule === 'ACCOUNTS' ? 'linear-gradient(135deg, #10b981, #059669)' : '#1e293b', color: activeModule === 'ACCOUNTS' ? '#fff' : '#94a3b8', boxShadow: activeModule === 'ACCOUNTS' ? '0 4px 15px rgba(16,185,129,0.4)' : 'none' }}>💰 ACCOUNTS & ADMIN</button>
            <button onClick={() => { setActiveModule('CRM'); setActiveComponent('DASHBOARD'); }} style={{ padding: '12px 20px', borderRadius: '10px', border: 'none', fontWeight: 'bold', cursor: 'pointer', transition: '0.3s', fontSize: '13px', whiteSpace: 'nowrap', background: activeModule === 'CRM' ? 'linear-gradient(135deg, #f59e0b, #d97706)' : '#1e293b', color: activeModule === 'CRM' ? '#fff' : '#94a3b8', boxShadow: activeModule === 'CRM' ? '0 4px 15px rgba(245,158,11,0.4)' : 'none' }}>🤝 CUSTOMER (CRM)</button>

            {/* --- GOOGLE & WHATSAPP COMMAND CENTER START --- */}
            {!isMobile && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginLeft: '10px', paddingLeft: '15px', borderLeft: '1px solid #334155' }}>
                <a href="https://mail.google.com/mail/u/0/#inbox" target="_blank" rel="noreferrer" title="Open Gmail" style={{ display: 'flex', padding: '10px', background: '#1e293b', borderRadius: '8px', border: '1px solid #334155', transition: '0.3s' }}>
                  <img src="https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg" width="20" height="20" alt="Gmail" />
                </a>
                <a href="https://calendar.google.com/calendar/u/0/r" target="_blank" rel="noreferrer" title="Open Calendar" style={{ display: 'flex', padding: '10px', background: '#1e293b', borderRadius: '8px', border: '1px solid #334155', transition: '0.3s' }}>
                  <img src="https://upload.wikimedia.org/wikipedia/commons/a/a5/Google_Calendar_icon_%282020%29.svg" width="20" height="20" alt="Calendar" />
                </a>
                <a href="https://drive.google.com/drive/u/0/my-drive" target="_blank" rel="noreferrer" title="Open Google Drive" style={{ display: 'flex', padding: '10px', background: '#1e293b', borderRadius: '8px', border: '1px solid #334155', transition: '0.3s' }}>
                  <img src="https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg" width="20" height="20" alt="Drive" />
                </a>

                {/* 🔥 MASTER WHATSAPP BUTTON */}
                <button onClick={() => { setActiveModule('CRM'); setActiveComponent('WHATSAPP'); }} title="Master WhatsApp Dashboard" style={{ display: 'flex', padding: '10px', marginLeft: '5px', background: 'linear-gradient(135deg, #128C7E, #25D366)', borderRadius: '8px', border: 'none', cursor: 'pointer', transition: '0.3s', boxShadow: '0 4px 10px rgba(37, 211, 102, 0.3)' }}>
                  <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="20" height="20" alt="WhatsApp" style={{ filter: 'brightness(0) invert(1)' }} />
                </button>
              </div>
            )}
            {/* --- GOOGLE & WHATSAPP COMMAND CENTER END --- */}

          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '15px', marginLeft: '20px' }}>
            {!isMobile && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'rgba(30, 41, 59, 0.8)', padding: '6px 15px 6px 6px', borderRadius: '50px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <img src={profileAvatar} alt="User" style={{ width: '35px', height: '35px', borderRadius: '50%', border: '2px solid #38bdf8' }} />
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold', lineHeight: '1' }}>{user.full_name || user.name || 'Admin User'}</span>
                  <span style={{ color: '#38bdf8', fontSize: '10px', fontWeight: '900', letterSpacing: '0.5px', marginTop: '3px' }}>{user.role || 'SYSTEM ADMIN'}</span>
                </div>
              </div>
            )}

            <button onClick={handleLogout} style={{ background: 'linear-gradient(135deg, #ef4444, #b91c1c)', color: 'white', border: 'none', padding: '12px 20px', borderRadius: '10px', fontWeight: '900', cursor: 'pointer', fontSize: '13px', textTransform: 'uppercase', boxShadow: '0 4px 15px rgba(239, 68, 68, 0.4)', transition: 'all 0.3s ease', whiteSpace: 'nowrap' }}>
              {isMobile ? '🚪' : 'LOGOUT 🚪'}
            </button>
          </div>

        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '15px' : '25px', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
           {renderActiveComponent()}
        </div>

      </div>
    </div>
  );
}