// @ts-nocheck
import React, { useState, useEffect } from 'react';

// 📦 ALL COMPONENTS
import SIDEBAR from './SIDEBAR';
import Dashboard from './Dashboard';
import Vehical from './Vehical';
import DRIVER from './DRIVER';
import TripManagment from './TripManagment';
import FuelMgmt from './FuelMgmt';
import LodingDetals from './LodingDetals'; // 👈 आपकी गाड़ी का लोडिंग पेज
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
import WhatsappDashboard from './WhatsappDashboard'; 
import AiSettings from './AiSettings';
import WebSettings from './WebSettings';
import PublicWebsite from './PublicWebsite'; // 👈 आपकी नई वेबसाइट का नाम!

export default function App() {
  const [showPublicWebsite, setShowPublicWebsite] = useState(true);
  const [user, setUser] = useState<any>(null);
  const [isDriverMode, setIsDriverMode] = useState(false); 
  const [authLoading, setAuthLoading] = useState(true);

  const [activeModule, setActiveModule] = useState('OPERATION'); 
  const [activeComponent, setActiveComponent] = useState('DASHBOARD');
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 1024);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false); 

  useEffect(() => {
    const savedUser = localStorage.getItem('prasad_user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
      setShowPublicWebsite(false); 
    }
    setAuthLoading(false);
    
    const handleResize = () => setIsMobile(window.innerWidth <= 1024);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleComponentChange = (comp: string) => {
    setIsTransitioning(true);
    setTimeout(() => {
      setActiveComponent(comp);
      setIsTransitioning(false);
    }, 200); 
  };

  const handleModuleChange = (mod: string) => {
    setActiveModule(mod);
    handleComponentChange('DASHBOARD');
  };

  const handleLogout = () => {
    if (window.confirm('Are you sure you want to log out?')) {
      localStorage.clear();
      sessionStorage.clear();
      setUser(null);
      setIsDriverMode(false);
      setShowPublicWebsite(true); 
    }
  };

  const handleLoginSuccess = (userData: any) => {
    localStorage.setItem('prasad_user', JSON.stringify(userData));
    setUser(userData);
    setShowPublicWebsite(false); 
  };

  const checkView = (permName: string) => {
    if (!user) return false;
    if (user.role === 'ADMIN' || user.role === 'Super Admin') return true;
    const p = user.permissions?.find((x: any) => x.name === permName);
    return p ? p.view : false;
  };

  const hasPermission = (itemId: string, module: string) => {
    if (!user) return false;
    if (user.role === 'ADMIN' || user.role === 'Super Admin') return true;
    
    if (itemId === 'AI_DOCS' || itemId === 'WHATSAPP' || itemId === 'AI_SETTINGS' || itemId === 'WEB_SETTINGS') return true; 

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
      if (itemId === 'DASHBOARD' || itemId === 'INBOX' || itemId === 'WHATSAPP') return true;
      if (itemId === 'CUSTOMER') return checkView('Customer Master');
    }
    return false;
  };

  if (authLoading) return <div style={{background:'#020617', height:'100vh', display:'flex', alignItems:'center', justifyContent:'center', color:'#38bdf8', fontSize: '24px', fontWeight: 'bold'}}>Loading...</div>;

  // 🌐 यहाँ हमने PublicWebsite सेट कर दिया है!
  if (showPublicWebsite && !user) {
    return <PublicWebsite onLoginClick={() => setShowPublicWebsite(false)} />;
  }

  if (!user && !showPublicWebsite && !isDriverMode) {
    return <Login onLoginSuccess={handleLoginSuccess} onDriverClick={() => setIsDriverMode(true)} onBackToWeb={() => setShowPublicWebsite(true)} />;
  }

  if (isDriverMode) {
    return <DriverPortal onBack={() => { setIsDriverMode(false); setShowPublicWebsite(true); }} />;
  }

  const renderActiveComponent = () => {
    if (!hasPermission(activeComponent, activeModule)) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '80vh', textAlign: 'center', animation: 'fadeIn 0.5s' }}>
          <div style={{ fontSize: '80px', marginBottom: '20px' }}>🔒</div>
          <h2 style={{ color: '#ef4444', margin: '0 0 10px 0', fontSize: '32px', fontWeight: '900' }}>ACCESS RESTRICTED</h2>
          <p style={{ color: '#94a3b8' }}>Contact Admin.</p>
        </div>
      );
    }
    switch (activeComponent) {
      case 'DASHBOARD': return <Dashboard activeModule={activeModule} />;
      case 'AI_DOCS': return <AiLetterPad />;
      case 'WHATSAPP': return <WhatsappDashboard />;
      case 'AI_SETTINGS': return <AiSettings />; 
      case 'WEB_SETTINGS': return <WebSettings />; 
      case 'UGER': return <UGER />;
      case 'VEHICLE': return <Vehical />;
      case 'DRIVER': return <DRIVER />;
      case 'TRIP': return <TripManagment />;
      case 'FUEL': return <FuelMgmt />;
      case 'LOADING': return <LodingDetals />; // 👈 यहाँ आपका गाड़ी का लोडिंग पेज खुलेगा
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

  const profileAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.full_name || user.name || 'User')}&background=38bdf8&color=fff&bold=true&size=100`;

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', overflow: 'hidden', background: '#020617', fontFamily: "'Inter', sans-serif" }}>
      
      <style>{`
        .fade-content { transition: opacity 0.2s ease-in-out; opacity: ${isTransitioning ? 0 : 1}; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .nav-btn { padding: 12px 20px; border-radius: 10px; border: none; font-weight: bold; cursor: pointer; transition: 0.3s; font-size: 13px; white-space: nowrap; }
        .nav-btn:hover { transform: translateY(-2px); }
        .tool-btn { display: flex; padding: 8px; background: #1e293b; border-radius: 8px; border: 1px solid #334155; transition: 0.3s; }
        .tool-btn:hover { background: #334155; transform: scale(1.1); }
      `}</style>

      {isMobile && mobileMenuOpen && (
        <div onClick={() => setMobileMenuOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 998, backdropFilter: 'blur(4px)' }} />
      )}

      <SIDEBAR 
        activeComponent={activeComponent} 
        setActiveComponent={handleComponentChange} 
        activeModule={activeModule} 
        setActiveModule={setActiveModule}
        isMobile={isMobile}
        isOpen={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
      />

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', width: isMobile ? '100%' : 'calc(100% - 260px)' }}>
        
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', background: 'rgba(15, 23, 42, 0.8)', backdropFilter: 'blur(10px)', borderBottom: '1px solid #1e293b', zIndex: 10 }}>
          
          <div style={{ display: 'flex', gap: '15px', alignItems: 'center', overflowX: 'auto', flex: 1, paddingBottom: isMobile ? '5px' : '0' }} className="hide-scrollbar">
            {isMobile && (
              <button onClick={() => setMobileMenuOpen(true)} style={{ background: 'transparent', border: 'none', color: '#38bdf8', fontSize: '28px', cursor: 'pointer', padding: '0 10px 0 0' }}>☰</button>
            )}

            <button onClick={() => handleModuleChange('OPERATION')} className="nav-btn" style={{ background: activeModule === 'OPERATION' ? 'linear-gradient(135deg, #3b82f6, #6366f1)' : '#1e293b', color: activeModule === 'OPERATION' ? '#fff' : '#94a3b8', boxShadow: activeModule === 'OPERATION' ? '0 4px 15px rgba(59,130,246,0.4)' : 'none' }}>🚛 OPERATIONS</button>
            <button onClick={() => handleModuleChange('ACCOUNTS')} className="nav-btn" style={{ background: activeModule === 'ACCOUNTS' ? 'linear-gradient(135deg, #10b981, #059669)' : '#1e293b', color: activeModule === 'ACCOUNTS' ? '#fff' : '#94a3b8', boxShadow: activeModule === 'ACCOUNTS' ? '0 4px 15px rgba(16,185,129,0.4)' : 'none' }}>💰 ACCOUNTS & ADMIN</button>
            <button onClick={() => handleModuleChange('CRM')} className="nav-btn" style={{ background: activeModule === 'CRM' ? 'linear-gradient(135deg, #f59e0b, #d97706)' : '#1e293b', color: activeModule === 'CRM' ? '#fff' : '#94a3b8', boxShadow: activeModule === 'CRM' ? '0 4px 15px rgba(245,158,11,0.4)' : 'none' }}>🤝 CRM (MAMTA AI)</button>

            {!isMobile && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginLeft: '10px', paddingLeft: '15px', borderLeft: '1px solid #334155' }}>
                <a href="https://mail.google.com" target="_blank" rel="noreferrer" title="Open Gmail" className="tool-btn">
                  <img src="https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg" width="18" height="18" alt="Gmail" />
                </a>
                <a href="https://calendar.google.com" target="_blank" rel="noreferrer" title="Open Calendar" className="tool-btn">
                  <img src="https://upload.wikimedia.org/wikipedia/commons/a/a5/Google_Calendar_icon_%282020%29.svg" width="18" height="18" alt="Calendar" />
                </a>
                
                <button onClick={() => { handleModuleChange('CRM'); handleComponentChange('WHATSAPP'); }} title="WhatsApp Master Dashboard" style={{ display: 'flex', padding: '8px 12px', background: 'linear-gradient(135deg, #128C7E, #25D366)', borderRadius: '8px', border: 'none', cursor: 'pointer', gap: '8px', alignItems: 'center', boxShadow: '0 4px 10px rgba(37, 211, 102, 0.3)', marginLeft: '5px', transition: '0.3s' }}>
                  <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" width="18" height="18" alt="WA" style={{ filter: 'brightness(0) invert(1)' }} />
                  <span style={{color:'white', fontWeight:'bold', fontSize:'12px'}}>CRM PANEL</span>
                </button>

                <button onClick={() => { handleModuleChange('CRM'); handleComponentChange('WEB_SETTINGS'); }} title="Edit Public Website" style={{ display: 'flex', padding: '8px 12px', background: 'linear-gradient(135deg, #38bdf8, #818cf8)', borderRadius: '8px', border: 'none', cursor: 'pointer', gap: '8px', alignItems: 'center', boxShadow: '0 4px 10px rgba(56, 189, 248, 0.3)', marginLeft: '5px', transition: '0.3s' }}>
                  <span style={{color:'white', fontWeight:'bold', fontSize:'12px'}}>🌐 EDIT WEBSITE</span>
                </button>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '15px', marginLeft: '10px' }}>
            {!isMobile && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'rgba(30, 41, 59, 0.8)', padding: '5px 15px 5px 5px', borderRadius: '50px', border: '1px solid rgba(255,255,255,0.05)' }}>
                <img src={profileAvatar} alt="User" style={{ width: '36px', height: '36px', borderRadius: '50%', border: '2px solid #38bdf8' }} />
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold', lineHeight: '1.2' }}>{user.full_name || user.name || 'Admin'}</span>
                  <span style={{ color: '#38bdf8', fontSize: '10px', fontWeight: '900', letterSpacing: '0.5px' }}>{user.role || 'SYSTEM ADMIN'}</span>
                </div>
              </div>
            )}
            <button onClick={handleLogout} title="Logout" style={{ background: 'linear-gradient(135deg, #ef4444, #b91c1c)', color: 'white', border: 'none', padding: isMobile ? '10px' : '12px 20px', borderRadius: '10px', fontWeight: '900', cursor: 'pointer', fontSize: '12px', boxShadow: '0 4px 15px rgba(239, 68, 68, 0.4)', transition: '0.3s' }}>
              {isMobile ? '🚪' : 'LOGOUT'}
            </button>
          </div>
        </div>

        <div className="fade-content" style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '15px' : '25px', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
            {renderActiveComponent()}
        </div>

      </div>
    </div>
  );
}