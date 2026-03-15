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
    if (isMobile) {
      onClose();
    }
  };

  const hasPermission = (itemId: string, module: string) => {
    if (!user) return false;
    if (user.role === 'ADMIN') return true; 

    // 🌟 AI Letter Pad को सबको देखने की परमिशन दे दी है (या आप इसे सिर्फ एडमिन तक सीमित कर सकते हैं)
    if (itemId === 'AI_DOCS') return true; 

    const perms = user.permissions || [];
    const checkView = (permName: string) => {
      const p = perms.find((x: any) => x.name === permName);
      return p ? p.view : false;
    };

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

  const sidebarStyle: React.CSSProperties = {
    width: isMobile ? '260px' : (isExpanded ? '260px' : '80px'),
    background: '#0f172a',
    borderRight: '1px solid #1e293b',
    height: '100vh',
    color: 'white',
    transition: 'all 0.3s ease',
    display: 'flex',
    flexDirection: 'column',
    position: isMobile ? 'fixed' : 'relative',
    top: 0,
    left: isMobile ? (isOpen ? '0' : '-100%') : '0',
    zIndex: 1000,
    overflowY: 'auto'
  };

  const getMenuItems = () => {
    let items = [];
    
    if (activeModule === 'OPERATION') {
      items = [
        { id: 'DASHBOARD', label: 'Dashboard', icon: '🖥️' },
        { id: 'AI_DOCS', label: 'AI Letter & Docs', icon: '📝' }, // 🌟 यहाँ जुड़ गया!
        { id: 'VEHICLE', label: 'Vehicle Fleet', icon: '🚛' },
        { id: 'DRIVER', label: 'Driver Master', icon: '👨‍✈️' },
        { id: 'TRIP', label: 'Trip Management', icon: '🛣️' },
        { id: 'LOCATION_RTKM', label: 'Route & RTKM', icon: '📍' }, 
        { id: 'FUEL', label: 'Fuel (HSD) Mgmt', icon: '⛽' },
        { id: 'LOADING', label: 'Loading Details', icon: '📦' },
        { id: 'UNLOADING', label: 'Unloading Details', icon: '🛢️' },
        { id: 'DOCS', label: 'Vehicle Documents', icon: '📄' },
        { id: 'TYRE', label: 'Tyre Management', icon: '🛞' },
        { id: 'MAINTENANCE', label: 'Workshop & Maint.', icon: '🛠️' }
      ];
    } else if (activeModule === 'ACCOUNTS') {
      items = [
        { id: 'DASHBOARD', label: 'Finance Hub', icon: '💰' },
        { id: 'AI_DOCS', label: 'AI Letter & Docs', icon: '📝' }, // 🌟 यहाँ भी जुड़ गया!
        { id: 'UGER', label: 'User & Role Mgmt', icon: '👥' },
        { id: 'BANK', label: 'Cash & Bank Book', icon: '🏦' },
        { id: 'LEDGER', label: 'Ledgers & Trial Bal', icon: '⚖️' },
        { id: 'PNL', label: 'Final Accounts', icon: '📊' },
        { id: 'BILLING', label: 'Bill Management', icon: '🧾' },
        { id: 'LOCATION_RTKM', label: 'RTKM Route Master', icon: '📍' },
        { id: 'LOAN', label: 'Loan & EMI Mgmt', icon: '🏦' },
        { id: 'TOLL', label: 'Toll & Fastag', icon: '🛣️' },
        { id: 'GST', label: 'GST Management', icon: '🏛️' },
        { id: 'TDS', label: 'TDS Management', icon: '✂️' },
        { id: 'VENDOR', label: 'Vendor Master', icon: '🤝' },
        { id: 'COMPANY', label: 'Company Master', icon: '🏢' }
      ];
    } else if (activeModule === 'CRM') {
      items = [
        { id: 'DASHBOARD', label: 'CRM Dashboard', icon: '📈' },
        { id: 'INBOX', label: 'Company Webmail & AI', icon: '📧' },
        { id: 'AI_DOCS', label: 'AI Letter & Docs', icon: '📝' }, // 🌟 और यहाँ भी जुड़ गया!
        { id: 'CUSTOMER', label: 'Customer Master', icon: '🏢' }
      ];
    }
    
    return items.filter(item => hasPermission(item.id, activeModule));
  };

  return (
    <div style={sidebarStyle} className="hide-scrollbar">
      <style>{`
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
        .menu-item:hover { background: rgba(56, 189, 248, 0.1) !important; color: #38bdf8 !important; }
      `}</style>

      <div style={{ padding: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #1e293b', background: '#020617' }}>
        <h2 style={{ margin: 0, color: '#38bdf8', fontSize: isExpanded || isMobile ? '24px' : '14px', textAlign: 'center', width: '100%', whiteSpace: 'nowrap', overflow: 'hidden' }}>
          {isExpanded || isMobile ? 'PRASAD ERP' : 'ERP'}
        </h2>
        {isMobile && (
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#ef4444', fontSize: '24px', cursor: 'pointer' }}>✕</button>
        )}
      </div>

      <ul style={{ listStyle: 'none', padding: '10px 0', margin: 0, flex: 1 }}>
        {getMenuItems().map(item => (
          <li 
            key={item.id}
            className="menu-item"
            onClick={() => handleMenuClick(item.id)} 
            style={{ 
              padding: '15px 20px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '15px', 
              background: activeComponent === item.id ? 'linear-gradient(90deg, rgba(56,189,248,0.2), transparent)' : 'transparent', 
              borderLeft: activeComponent === item.id ? '4px solid #38bdf8' : '4px solid transparent', 
              transition: '0.3s', color: activeComponent === item.id ? '#38bdf8' : '#cbd5e1', fontWeight: activeComponent === item.id ? 'bold' : 'normal'
            }}
          >
            <span style={{ fontSize: '18px' }}>{item.icon}</span> 
            {(isExpanded || isMobile) && <span style={{ fontSize: '14px', whiteSpace: 'nowrap' }}>{item.label}</span>}
          </li>
        ))}
      </ul>

      {!isMobile && (
        <div onClick={() => setIsExpanded(!isExpanded)} style={{ padding: '15px', textAlign: 'center', cursor: 'pointer', background: '#020617', borderTop: '1px solid #1e293b', color: '#94a3b8' }}>
          {isExpanded ? '◀ Collapse' : '▶'}
        </div>
      )}
    </div>
  );
}