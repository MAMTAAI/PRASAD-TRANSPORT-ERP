// @ts-nocheck
import React, { useState, useEffect } from 'react';

interface SidebarProps {
  activeComponent: string;
  setActiveComponent: (comp: string) => void;
  activeModule: string;
  setActiveModule: (mod: string) => void;
  isMobile: boolean;
  isOpen: boolean;
  onClose: () => void;
}

export default function SIDEBAR({ activeComponent, setActiveComponent, activeModule, setActiveModule, isMobile, isOpen, onClose }: SidebarProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    if (!isMobile && window.innerWidth < 1024) {
      setIsExpanded(false);
    }
    const savedUser = localStorage.getItem('prasad_user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
    }
  }, [isMobile]);

  const handleMenuClick = (component: string) => {
    setActiveComponent(component);
    if (isMobile) onClose();
  };

  // ==========================================
  // 🛡️ STRICT PERMISSION SYNCED WITH APP.TSX
  // ==========================================
  const hasPermission = (itemId: string, module: string) => {
    if (!user) return false;
    
    // 👑 ADMIN BYPASS: मालिक को सब कुछ दिखेगा
    if (user.role === 'ADMIN' || user.role === 'Super Admin') return true; 
    
    // 🔒 SECURITY: आम स्टाफ को Master Setup नहीं दिखेगा
    if (['COMPANY', 'BRANCH', 'UGER', 'WEB_SETTINGS'].includes(itemId)) {
      return false; 
    }
    
    // 🔓 DEFAULT OPEN FOR ALL STAFF
    if (['DASHBOARD', 'AI_DOCS', 'WHATSAPP'].includes(itemId)) return true;

    const perms = user.permissions || [];
    const checkView = (name: string) => perms.find((x: any) => x.name === name)?.view;

    if (module === 'OPERATION') {
      if (itemId === 'BAZAAR_ADMIN') return checkView('Load Bazaar Admin'); 
      if (itemId === 'VEHICLE' || itemId === 'VEHICLE_DRIVER_LINK') return checkView('Vehicle Fleet');
      // 🔥 MARKET VEHICLE CHECK (Vehicle Fleet ya Vendor Master ki permission chahiye)
      if (itemId === 'MARKET_VEHICLE') return checkView('Vehicle Fleet') || checkView('Vendor Master'); 
      if (itemId === 'DRIVER') return checkView('Driver Master');
      if (itemId === 'TRIP' || itemId === 'LOCATION_RTKM') return checkView('Trip Management');
      if (itemId === 'FUEL' || itemId === 'MAINTENANCE' || itemId === 'TYRE' || itemId === 'DOCS') return checkView('Fuel & Maintenance');
      if (itemId === 'LOADING' || itemId === 'UNLOADING') return checkView('Loading / Unloading');
      return false;
    }
    
    if (module === 'ACCOUNTS') {
      if (itemId === 'BANK' || itemId === 'LEDGER') return checkView('Ledger & Cash Book');
      if (itemId === 'PNL' || itemId === 'LOAN') return checkView('Finance Hub');
      if (itemId === 'BILLING') return checkView('Billing & Invoicing');
      if (itemId === 'GST' || itemId === 'TDS' || itemId === 'TOLL') return checkView('Tax (GST/TDS) & Toll');
      if (itemId === 'VENDOR') return checkView('Vendor Master');
      return false;
    }

    if (module === 'CRM') {
      if (itemId === 'CUSTOMER') return checkView('Customer Master');
      if (itemId === 'INBOX' || itemId === 'AI_SETTINGS') return checkView('CRM Tools');
      return false;
    }
    
    return false; 
  };

  const getMenuItems = () => {
    if (activeModule === 'OPERATION') {
      return [
        { id: 'DASHBOARD', label: 'Dashboard', icon: '🖥️' },
        { id: 'BAZAAR_ADMIN', label: 'Bazaar Admin (KYC/Bids)', icon: '🌍' }, 
        { id: 'TRIP', label: 'Trip Management', icon: '🛣️' },
        { id: 'LOADING', label: 'Loading Details', icon: '📦' },
        { id: 'UNLOADING', label: 'Unloading Details', icon: '📥' },
        { id: 'VEHICLE', label: 'Our Vehicle Fleet', icon: '🚛' },
        { id: 'MARKET_VEHICLE', label: 'Market Vehicles (Vendors)', icon: '🚚' }, 
        { id: 'DRIVER', label: 'Driver Master', icon: '👨‍✈️' },
        { id: 'VEHICLE_DRIVER_LINK', label: 'Link Vehicle & Driver', icon: '🔗' },
        { id: 'LOCATION_RTKM', label: 'Route & RTKM', icon: '📍' },
        { id: 'FUEL', label: 'Fuel (HSD) Mgmt', icon: '⛽' },
        { id: 'DOCS', label: 'Vehicle Documents', icon: '📄' },
        { id: 'TYRE', label: 'Tyre Management', icon: '🛞' },
        { id: 'MAINTENANCE', label: 'Workshop/Maint.', icon: '🛠️' },
        { id: 'AI_DOCS', label: 'AI Letter Pad', icon: '📝' },
      ];
    } else if (activeModule === 'ACCOUNTS') {
      return [
        { id: 'DASHBOARD', label: 'Finance Hub', icon: '💰' },
        { id: 'BANK', label: 'Cash & Bank Book', icon: '🏦' },
        { id: 'LEDGER', label: 'Ledgers & Party', icon: '📖' },
        { id: 'PNL', label: 'Balance Sheet/P&L', icon: '📊' },
        { id: 'BILLING', label: 'Bill Management', icon: '🧾' },
        { id: 'AI_SCANNER', label: 'AI Bill Scanner', icon: '🤖' },
        { id: 'FLEET_CARD', label: 'Fleet Card & Settlement', icon: '💳' },
        { id: 'LOAN', label: 'Loan & EMI Mgmt', icon: '💸' },
        { id: 'TOLL', label: 'Toll & Fastag', icon: '🛣️' },
        { id: 'GST', label: 'GST Management', icon: '🏛️' },
        { id: 'TDS', label: 'TDS Management', icon: '✂️' },
        { id: 'VENDOR', label: 'Vendor Master', icon: '🤝' },
      ];
    } else { 
      // 🤝 CRM MODULE (WITH ADMIN SETUP AT BOTTOM)
      return [
        { id: 'DASHBOARD', label: 'CRM Dashboard', icon: '📈' },
        { id: 'WHATSAPP', label: 'WhatsApp CRM', icon: '💬' },
        { id: 'INBOX', label: 'Super CRM/Inbox', icon: '📧' },
        { id: 'AI_SETTINGS', label: 'AI Brain Control', icon: '🧠' },
        { id: 'WEB_SETTINGS', label: 'Website Builder', icon: '🌐' },
        { id: 'CUSTOMER', label: 'Customer Master', icon: '🏢' },
        { id: 'AI_DOCS', label: 'AI Letter Pad', icon: '📝' },
        
        // 👑 ADMIN HEADINGS (ISKO MAP ME HANDLE KIYA HAI)
        { id: 'DIVIDER', label: 'MASTER ADMIN SETUP', icon: '👑', isDivider: true },
        { id: 'COMPANY', label: 'Company Master', icon: '🏢' },
        { id: 'BRANCH', label: 'Branch Setup', icon: '📍' },
        { id: 'UGER', label: 'User & Role (UGER)', icon: '🔐' },
      ];
    }
  };

  return (
    <div style={{ width: isMobile ? '260px' : (isExpanded ? '260px' : '80px'), background: '#0f172a', borderRight: '1px solid #1e293b', height: '100vh', display: 'flex', flexDirection: 'column', position: isMobile ? 'fixed' : 'relative', left: isMobile ? (isOpen ? '0' : '-100%') : '0', zIndex: 1000, transition: 'all 0.3s ease' }}>
      <style>{`
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .menu-item { border-radius: 8px; margin: 2px 10px; transition: 0.2s; cursor: pointer; display: flex; align-items: center; gap: 15px; color: #cbd5e1; padding: 12px 15px; }
        .menu-item:hover { background: rgba(56, 189, 248, 0.1); transform: translateX(5px); color: #fff; }
        .active-item { background: rgba(56, 189, 248, 0.2) !important; color: #38bdf8 !important; border-left: 4px solid #38bdf8 !important; }
        .highlight-item { background: rgba(245, 158, 11, 0.1); border-left: 4px solid #f59e0b; color: #fcd34d; }
        .highlight-item:hover { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
        .active-highlight { background: rgba(245, 158, 11, 0.3) !important; border-left: 4px solid #f59e0b !important; color: #f59e0b !important; }
      `}</style>
      
      <div style={{ padding: '20px', background: '#020617', textAlign: 'center', borderBottom: '1px solid #1e293b' }}>
        <h2 style={{ margin: 0, color: '#38bdf8', fontSize: isExpanded || isMobile ? '22px' : '14px', fontWeight: '900' }}>
          {isExpanded || isMobile ? 'PRASAD ERP' : 'ERP'}
        </h2>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }} className="hide-scrollbar">
        {getMenuItems().filter(item => item.isDivider ? (user?.role === 'ADMIN' || user?.role === 'Super Admin') : hasPermission(item.id, activeModule)).map(item => {
          
          // 🔥 RENDER MASTER ADMIN HEADING
          if (item.isDivider) {
             return (isExpanded || isMobile) && (
               <div key={item.id} style={{ fontSize: '10px', color: '#38bdf8', fontWeight: 'bold', margin: '25px 15px 10px', textTransform: 'uppercase', letterSpacing: '1px', borderBottom: '1px solid #1e293b', paddingBottom: '5px' }}>
                 {item.icon} {item.label}
               </div>
             );
          }

          // 📄 RENDER NORMAL MENU ITEMS
          return (
            <div 
              key={item.id}
              className={`menu-item ${activeComponent === item.id ? (item.id === 'BAZAAR_ADMIN' ? 'active-highlight' : 'active-item') : (item.id === 'BAZAAR_ADMIN' ? 'highlight-item' : '')}`}
              onClick={() => handleMenuClick(item.id)}
            >
              <span style={{ fontSize: '18px' }}>{item.icon}</span>
              {(isExpanded || isMobile) && (
                <span style={{ fontSize: '14px', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                  {item.label}
                  {item.id === 'BAZAAR_ADMIN' && <span style={{ marginLeft: 'auto', background: '#ef4444', color: 'white', padding: '2px 6px', borderRadius: '10px', fontSize: '10px', fontWeight: 'bold' }}>3</span>}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {!isMobile && (
        <div onClick={() => setIsExpanded(!isExpanded)} style={{ padding: '15px', textAlign: 'center', cursor: 'pointer', borderTop: '1px solid #1e293b', color: '#94a3b8', fontSize: '12px' }}>
          {isExpanded ? '◀ COLLAPSE' : '▶'}
        </div>
      )}
    </div>
  );
}