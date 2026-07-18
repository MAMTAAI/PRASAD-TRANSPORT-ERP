// @ts-nocheck
import React, { useState, useEffect, lazy, Suspense } from 'react';
import { authReady } from './firebase';

// 🧭 SHELL (needed for first paint — stays in the entry chunk)
import SIDEBAR from './SIDEBAR';
import PublicWebsite from './PublicWebsite';
import Login from './Login';

// 📦 ALL ERP MODULES — lazy-loaded (Phase B): each module downloads only when
// opened. This cut the boot chunk from one 2.4 MB monolith to a small shell;
// visitors on the public site / login no longer pay for the whole back office.
const Dashboard = lazy(() => import('./Dashboard'));
const Vehical = lazy(() => import('./Vehical'));
const DRIVER = lazy(() => import('./DRIVER'));
const TripManagment = lazy(() => import('./TripManagment'));
const FuelMgmt = lazy(() => import('./FuelMgmt'));
const LodingDetals = lazy(() => import('./LodingDetals'));
const UnlodingDetals = lazy(() => import('./UnlodingDetals'));
const VehicleDocs = lazy(() => import('./VehicleDocs'));
const TyreMgmt = lazy(() => import('./TyreMgmt'));
const VehicleMaintenance = lazy(() => import('./VehicleMaintenance'));
const CashBankBook = lazy(() => import('./CashBankBook'));
const LedgerMgmt = lazy(() => import('./LedgerMgmt'));
const FinancialReports = lazy(() => import('./FinancialReports'));
const BillManagement = lazy(() => import('./BillManagement'));
const LocationRtkmMaster = lazy(() => import('./LocationRtkmMaster'));
const Customer = lazy(() => import('./Customer'));
const Vander = lazy(() => import('./Vander'));
const TollFastagMgmt = lazy(() => import('./TollFastagMgmt'));
const LoanEmiMgmt = lazy(() => import('./LoanEmiMgmt'));
const GstMgmt = lazy(() => import('./GstMgmt'));
const BillScanner = lazy(() => import('./BillScanner'));
const FleetCardMgmt = lazy(() => import('./FleetCardMgmt'));
const MonthlyBilling = lazy(() => import('./MonthlyBilling'));
const KycApprovals = lazy(() => import('./KycApprovals'));
const TdsMgmt = lazy(() => import('./TdsMgmt'));
const UGER = lazy(() => import('./UGER'));
const CompanyInbox = lazy(() => import('./CompanyInbox'));
const AiLetterPad = lazy(() => import('./AiLetterpad'));
const WhatsappDashboard = lazy(() => import('./WhatsappDashboard'));
const AiSettings = lazy(() => import('./AiSettings'));
const WebSettings = lazy(() => import('./WebSettings'));
const VehicleDriverLink = lazy(() => import('./VehicleDriverLink'));
const COMPANY = lazy(() => import('./COMPANY'));
const BRANCH = lazy(() => import('./BRANCH'));
const BazaarAdmin = lazy(() => import('./BazaarAdmin'));
const MarketVehicles = lazy(() => import('./MarketVehicles'));
const CustomerPortal = lazy(() => import('./CustomerPortal'));
const FleetPartnerPortal = lazy(() => import('./FleetPartnerPortal'));
const DriverPortal = lazy(() => import('./DriverPortal'));

// Branded loading state while a module chunk downloads
const ModuleLoader = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#38bdf8', fontWeight: 900, fontSize: '18px' }}>
    ⏳ Loading module…
  </div>
);

export default function App() {
  const [showPublicWebsite, setShowPublicWebsite] = useState(false); 
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  
  // ✨ NEW: SPLASH SCREEN STATE
  const [showSplash, setShowSplash] = useState(true); 
  
  // 🚪 EXTERNAL PORTAL MODES
  const [isDriverMode, setIsDriverMode] = useState(false); 
  const [isCustomerMode, setIsCustomerMode] = useState(false); 
  const [isPartnerMode, setIsPartnerMode] = useState(false);

  const [activeModule, setActiveModule] = useState('OPERATION'); 
  const [activeComponent, setActiveComponent] = useState('DASHBOARD');
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 1024);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false); 

  useEffect(() => {
    const savedUser = localStorage.getItem('prasad_user');
    if (savedUser) {
      try {
        const parsedUser = JSON.parse(savedUser);
        setUser(parsedUser);
        setShowPublicWebsite(false); 
      } catch (e) {
        console.error("Error parsing user data", e);
      }
    }
    // Wait for the Firebase (anonymous) auth token before any Firestore reads —
    // security rules reject requests made without it.
    authReady.then(() => setAuthLoading(false));
    
    // ✨ SPLASH SCREEN TIMER 
    const splashTimer = setTimeout(() => {
      setShowSplash(false);
    }, 2500);
    
    const handleResize = () => setIsMobile(window.innerWidth <= 1024);
    window.addEventListener('resize', handleResize);
    
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(splashTimer);
    };
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
      setIsCustomerMode(false);
      setIsPartnerMode(false);
      setShowPublicWebsite(true); 
    }
  };

  const handleLoginSuccess = (userData: any) => {
    localStorage.setItem('prasad_user', JSON.stringify(userData));
    setUser(userData);
    setShowPublicWebsite(false); 
  };

  // ==========================================
  // 🛡️ USER-WISE PERMISSION LOGIC (SMART RBAC)
  // ==========================================
  const checkView = (permName: string) => {
    if (!user) return false;
    if (user.role === 'ADMIN' || user.role === 'Super Admin') return true;
    const p = user.permissions?.find((x: any) => x.name === permName);
    return p ? p.view : false;
  };

  const hasPermission = (itemId: string, module: string) => {
    if (!user) return false;

    if (itemId === 'UGER' || itemId === 'COMPANY' || itemId === 'BRANCH' || itemId === 'WEB_SETTINGS') {
      return user.role === 'ADMIN' || user.role === 'Super Admin';
    }

    // Admins see everything — without this, any module id missing from the
    // mapping below fell through to `return false` even for Super Admin
    // (this silently locked newly added modules for everyone).
    if (user.role === 'ADMIN' || user.role === 'Super Admin') return true;

    if (['DASHBOARD', 'AI_DOCS', 'WHATSAPP', 'PARTNER_PORTAL_PREVIEW', 'CUSTOMER_PORTAL_PREVIEW', 'DRIVER_PORTAL_PREVIEW'].includes(itemId)) return true; 

    if (module === 'OPERATION') {
      if (itemId === 'BAZAAR_ADMIN') return checkView('Load Bazaar Admin'); 
      if (itemId === 'VEHICLE' || itemId === 'VEHICLE_DRIVER_LINK') return checkView('Vehicle Fleet');
      if (itemId === 'MARKET_VEHICLE') return checkView('Vehicle Fleet') || checkView('Vendor Master'); 
      if (itemId === 'DRIVER') return checkView('Driver Master');
      if (itemId === 'TRIP' || itemId === 'LOCATION_RTKM') return checkView('Trip Management');
      if (itemId === 'FUEL' || itemId === 'MAINTENANCE' || itemId === 'TYRE' || itemId === 'DOCS') return checkView('Fuel & Maintenance');
      if (itemId === 'LOADING' || itemId === 'UNLOADING') return checkView('Loading / Unloading');
    }
    
    if (module === 'ACCOUNTS') {
      if (itemId === 'BANK' || itemId === 'LEDGER') return checkView('Ledger & Cash Book');
      if (itemId === 'PNL' || itemId === 'LOAN') return checkView('Finance Hub');
      if (itemId === 'BILLING' || itemId === 'AI_SCANNER' || itemId === 'AUTO_BILLING') return checkView('Billing & Invoicing');
      if (itemId === 'FLEET_CARD') return checkView('Ledger & Cash Book') || checkView('Fuel & Maintenance');
      if (itemId === 'GST' || itemId === 'TDS' || itemId === 'TOLL') return checkView('Tax (GST/TDS) & Toll');
      if (itemId === 'VENDOR') return checkView('Vendor Master');
    }

    if (module === 'CRM') {
      if (itemId === 'CUSTOMER' || itemId === 'ONBOARDING') return checkView('Customer Master');
      if (itemId === 'INBOX' || itemId === 'AI_SETTINGS') return checkView('CRM Tools');
    }
    
    return false;
  };

  // ==========================================
  // 🌟 NATIVE SPLASH SCREEN (Swiggy / Uber Style)
  // ==========================================
  if (showSplash || authLoading) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#020617', zIndex: 99999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <style>{`
          @keyframes pulseLogo {
            0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.7); }
            70% { transform: scale(1.1); box-shadow: 0 0 0 20px rgba(56, 189, 248, 0); }
            100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(56, 189, 248, 0); }
          }
          @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes loadBar { 0% { width: 0%; } 100% { width: 100%; } }
        `}</style>
        
        <div style={{ width: '120px', height: '120px', background: 'linear-gradient(135deg, #3b82f6, #38bdf8)', borderRadius: '35px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '55px', animation: 'pulseLogo 2s infinite', marginBottom: '25px', boxShadow: '0 10px 30px rgba(56, 189, 248, 0.4)' }}>
          🚛
        </div>
        
        <h1 style={{ color: 'white', fontSize: '32px', fontWeight: '900', margin: '0 0 10px 0', letterSpacing: '1px', animation: 'slideUp 0.5s ease-out forwards', textAlign: 'center' }}>
          PRASAD TRANSPORT
        </h1>
        <p style={{ color: '#38bdf8', fontSize: '13px', fontWeight: 'bold', letterSpacing: '4px', textTransform: 'uppercase', animation: 'slideUp 0.5s ease-out 0.2s forwards', opacity: 0 }}>
          Premium ERP Edition
        </p>
        
        <div style={{ width: '200px', height: '4px', background: 'rgba(255,255,255,0.05)', borderRadius: '10px', marginTop: '50px', overflow: 'hidden' }}>
           <div style={{ height: '100%', background: '#38bdf8', animation: 'loadBar 2.5s ease-in-out forwards', borderRadius: '10px' }}></div>
        </div>
      </div>
    );
  }

  // ==========================================
  // 🌐 APP ROUTING
  // ==========================================
  if (showPublicWebsite && !user) return <PublicWebsite onLoginClick={() => setShowPublicWebsite(false)} />;
  if (isCustomerMode) return <Suspense fallback={<ModuleLoader />}><CustomerPortal onLogout={() => { setIsCustomerMode(false); setShowPublicWebsite(true); }} /></Suspense>;
  if (isPartnerMode) return <Suspense fallback={<ModuleLoader />}><FleetPartnerPortal onBack={() => { setIsPartnerMode(false); setShowPublicWebsite(true); }} /></Suspense>;
  if (isDriverMode) return <Suspense fallback={<ModuleLoader />}><DriverPortal onBack={() => { setIsDriverMode(false); setShowPublicWebsite(true); }} /></Suspense>;
  
  if (!user && !showPublicWebsite && !isDriverMode && !isCustomerMode && !isPartnerMode) {
    return (
      <Login 
        onLoginSuccess={handleLoginSuccess} 
        onCustomerClick={() => setIsCustomerMode(true)} 
        onPartnerClick={() => setIsPartnerMode(true)} 
        onDriverClick={() => setIsDriverMode(true)} 
        onBackToWeb={() => setShowPublicWebsite(true)} 
      />
    );
  }

  const renderActiveComponent = () => {
    if (!hasPermission(activeComponent, activeModule)) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '80vh', textAlign: 'center', animation: 'fadeIn 0.5s' }}>
          <div style={{ fontSize: '80px', marginBottom: '20px' }}>🔒</div>
          <h2 style={{ color: '#ef4444', margin: '0 0 10px 0', fontSize: '32px', fontWeight: '900' }}>ACCESS RESTRICTED</h2>
          <p style={{ color: '#94a3b8' }}>You do not have permission to view this module. Contact Admin.</p>
        </div>
      );
    }
    
    switch (activeComponent) {
      // 🔥 MAIN FIX IS HERE: PASSING currentUser={user} TO DASHBOARD
      case 'DASHBOARD': return <Dashboard activeModule={activeModule} currentUser={user} />;
      case 'BAZAAR_ADMIN': return <BazaarAdmin />; 
      case 'MARKET_VEHICLE': return <MarketVehicles />; 
      
      // 🔥 PREVIEW PORTALS RENDER
      case 'PARTNER_PORTAL_PREVIEW': 
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#020617' }}>
            <FleetPartnerPortal onBack={() => handleComponentChange('MARKET_VEHICLE')} />
          </div>
        );
      case 'CUSTOMER_PORTAL_PREVIEW': 
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#020617' }}>
            <CustomerPortal onLogout={() => handleComponentChange('CUSTOMER')} />
          </div>
        );
      case 'DRIVER_PORTAL_PREVIEW': 
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#020617' }}>
            <DriverPortal onBack={() => handleComponentChange('DASHBOARD')} />
          </div>
        );

      case 'COMPANY': return <COMPANY />; 
      case 'BRANCH': return <BRANCH />; 
      case 'UGER': return <UGER />;
      case 'AI_DOCS': return <AiLetterPad />;
      case 'WHATSAPP': return <WhatsappDashboard />;
      case 'AI_SETTINGS': return <AiSettings />; 
      case 'WEB_SETTINGS': return <WebSettings />; 
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
      case 'AI_SCANNER': return <BillScanner />;
      case 'FLEET_CARD': return <FleetCardMgmt />;
      case 'AUTO_BILLING': return <MonthlyBilling />;
      case 'ONBOARDING': return <KycApprovals />;
      case 'LOCATION_RTKM': return <LocationRtkmMaster />;
      case 'CUSTOMER': return <Customer />;
      case 'VENDOR': return <Vander />;
      case 'TOLL': return <TollFastagMgmt />;
      case 'LOAN': return <LoanEmiMgmt />;
      case 'GST': return <GstMgmt />;
      case 'TDS': return <TdsMgmt />;
      case 'INBOX': return <CompanyInbox />;
      case 'VEHICLE_DRIVER_LINK': return <VehicleDriverLink />;
      // 🔥 MAIN FIX IS HERE TOO
      default: return <Dashboard activeModule={activeModule} currentUser={user} />;
    }
  };

  const profileAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(user?.full_name || user?.name || 'User')}&background=38bdf8&color=fff&bold=true&size=100`;

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', overflow: 'hidden', background: '#020617', fontFamily: "'Inter', sans-serif" }}>
      <style>{`
        .fade-content { transition: opacity 0.2s ease-in-out; opacity: ${isTransitioning ? 0 : 1}; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .nav-btn { padding: 12px 20px; border-radius: 10px; border: none; font-weight: bold; cursor: pointer; transition: 0.3s; font-size: 13px; white-space: nowrap; }
        .nav-btn:hover { transform: translateY(-2px); }
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
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
        
        {/* 📱 HEADER NAVBAR (SMART UI) */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', padding: isMobile ? '10px 15px' : '15px 20px', background: 'rgba(15, 23, 42, 0.95)', backdropFilter: 'blur(10px)', borderBottom: '1px solid #1e293b', zIndex: 10 }}>
          
          {isMobile ? (
            // 📱 MOBILE TOP BAR (Clean & Native App Look)
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                <button onClick={() => setMobileMenuOpen(true)} style={{ background: 'transparent', border: 'none', color: '#38bdf8', fontSize: '26px', cursor: 'pointer', padding: 0 }}>☰</button>
                <span style={{ color: '#fff', fontSize: '16px', fontWeight: '900', letterSpacing: '1px' }}>PRASAD TRANSPORT</span>
              </div>
              <button onClick={handleLogout} style={{ background: 'linear-gradient(135deg, #ef4444, #b91c1c)', color: 'white', border: 'none', padding: '8px 12px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer', boxShadow: '0 4px 10px rgba(239, 68, 68, 0.4)' }}>🚪</button>
            </div>
          ) : (
            // 💻 DESKTOP TOP BAR
            <>
              <div style={{ display: 'flex', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
                <button onClick={() => handleModuleChange('OPERATION')} className="nav-btn" style={{ background: activeModule === 'OPERATION' ? 'linear-gradient(135deg, #3b82f6, #6366f1)' : '#1e293b', color: activeModule === 'OPERATION' ? '#fff' : '#94a3b8', boxShadow: activeModule === 'OPERATION' ? '0 4px 15px rgba(59,130,246,0.4)' : 'none' }}>🚛 OPERATIONS</button>
                <button onClick={() => handleModuleChange('ACCOUNTS')} className="nav-btn" style={{ background: activeModule === 'ACCOUNTS' ? 'linear-gradient(135deg, #10b981, #059669)' : '#1e293b', color: activeModule === 'ACCOUNTS' ? '#fff' : '#94a3b8', boxShadow: activeModule === 'ACCOUNTS' ? '0 4px 15px rgba(16,185,129,0.4)' : 'none' }}>💰 ACCOUNTS & ADMIN</button>
                <button onClick={() => handleModuleChange('CRM')} className="nav-btn" style={{ background: activeModule === 'CRM' ? 'linear-gradient(135deg, #f59e0b, #d97706)' : '#1e293b', color: activeModule === 'CRM' ? '#fff' : '#94a3b8', boxShadow: activeModule === 'CRM' ? '0 4px 15px rgba(245,158,11,0.4)' : 'none' }}>🤝 CRM (MAMTA AI)</button>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginLeft: '10px', paddingLeft: '15px', borderLeft: '1px solid #334155' }}>
                  <button onClick={() => { handleModuleChange('CRM'); handleComponentChange('WHATSAPP'); }} title="WhatsApp Master Dashboard" style={{ display: 'flex', padding: '8px 12px', background: 'linear-gradient(135deg, #128C7E, #25D366)', borderRadius: '8px', border: 'none', cursor: 'pointer', gap: '8px', alignItems: 'center' }}>
                    <span style={{color:'white', fontWeight:'bold', fontSize:'12px'}}>CRM PANEL</span>
                  </button>
                  
                  {(user?.role === 'ADMIN' || user?.role === 'Super Admin') && (
                    <button onClick={() => { handleModuleChange('CRM'); handleComponentChange('WEB_SETTINGS'); }} style={{ display: 'flex', padding: '8px 12px', background: 'linear-gradient(135deg, #38bdf8, #818cf8)', borderRadius: '8px', border: 'none', cursor: 'pointer', gap: '8px', alignItems: 'center' }}>
                      <span style={{color:'white', fontWeight:'bold', fontSize:'12px'}}>🌐 EDIT WEBSITE</span>
                    </button>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <div style={{ display: 'flex', gap: '10px', marginRight: '15px', paddingRight: '15px', borderRight: '1px solid #334155', flexWrap: 'wrap' }}>
                  <button onClick={() => handleComponentChange('PARTNER_PORTAL_PREVIEW')} style={{ background: 'linear-gradient(135deg, #f97316, #ea580c)', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}><span>👁️</span> VENDOR</button>
                  <button onClick={() => handleComponentChange('CUSTOMER_PORTAL_PREVIEW')} style={{ background: 'linear-gradient(135deg, #ec4899, #be185d)', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}><span>👁️</span> CUSTOMER</button>
                  <button onClick={() => handleComponentChange('DRIVER_PORTAL_PREVIEW')} style={{ background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: 'white', border: 'none', padding: '8px 15px', borderRadius: '8px', fontWeight: 'bold', cursor: 'pointer' }}><span>👁️</span> DRIVER APP</button>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'rgba(30, 41, 59, 0.8)', padding: '5px 15px 5px 5px', borderRadius: '50px' }}>
                  <img src={profileAvatar} alt="User" style={{ width: '36px', height: '36px', borderRadius: '50%', border: '2px solid #38bdf8' }} />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ color: '#fff', fontSize: '13px', fontWeight: 'bold', lineHeight: '1.2' }}>{user?.full_name || user?.name || 'Staff'}</span>
                    <span style={{ color: '#38bdf8', fontSize: '10px', fontWeight: '900' }}>{user?.role || 'STAFF'}</span>
                  </div>
                </div>
                <button onClick={handleLogout} style={{ background: 'linear-gradient(135deg, #ef4444, #b91c1c)', color: 'white', border: 'none', padding: '12px 20px', borderRadius: '10px', fontWeight: '900', cursor: 'pointer' }}>LOGOUT</button>
              </div>
            </>
          )}
        </div>

        {/* 📝 MAIN CONTENT */}
        <div className="fade-content" style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '10px' : '25px', paddingBottom: isMobile ? '80px' : '25px', background: 'radial-gradient(circle at top right, #0f172a, #020617)' }}>
            <Suspense fallback={<ModuleLoader />}>{renderActiveComponent()}</Suspense>
        </div>

        {/* 📱 NATIVE APP BOTTOM NAVIGATION BAR (ONLY VISIBLE ON MOBILE) */}
        {isMobile && (
          <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: '65px', background: '#0f172a', borderTop: '1px solid #1e293b', display: 'flex', justifyContent: 'space-around', alignItems: 'center', zIndex: 50, paddingBottom: 'env(safe-area-inset-bottom)', boxShadow: '0 -4px 15px rgba(0,0,0,0.5)' }}>
            
            <button onClick={() => handleModuleChange('OPERATION')} style={{ background: 'none', border: 'none', color: activeModule === 'OPERATION' ? '#38bdf8' : '#64748b', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer', flex: 1 }}>
              <span style={{ fontSize: activeModule === 'OPERATION' ? '24px' : '20px', transition: '0.2s', filter: activeModule === 'OPERATION' ? 'drop-shadow(0 0 5px rgba(56,189,248,0.5))' : 'none' }}>🚛</span>
              <span style={{ fontSize: '10px', fontWeight: activeModule === 'OPERATION' ? '900' : 'normal' }}>Ops</span>
            </button>

            <button onClick={() => handleModuleChange('ACCOUNTS')} style={{ background: 'none', border: 'none', color: activeModule === 'ACCOUNTS' ? '#10b981' : '#64748b', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer', flex: 1 }}>
              <span style={{ fontSize: activeModule === 'ACCOUNTS' ? '24px' : '20px', transition: '0.2s', filter: activeModule === 'ACCOUNTS' ? 'drop-shadow(0 0 5px rgba(16,185,129,0.5))' : 'none' }}>💰</span>
              <span style={{ fontSize: '10px', fontWeight: activeModule === 'ACCOUNTS' ? '900' : 'normal' }}>Accounts</span>
            </button>

            <button onClick={() => handleModuleChange('CRM')} style={{ background: 'none', border: 'none', color: activeModule === 'CRM' ? '#f59e0b' : '#64748b', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer', flex: 1 }}>
              <span style={{ fontSize: activeModule === 'CRM' ? '24px' : '20px', transition: '0.2s', filter: activeModule === 'CRM' ? 'drop-shadow(0 0 5px rgba(245,158,11,0.5))' : 'none' }}>🤝</span>
              <span style={{ fontSize: '10px', fontWeight: activeModule === 'CRM' ? '900' : 'normal' }}>CRM</span>
            </button>

          </div>
        )}

      </div>
    </div>
  );
}