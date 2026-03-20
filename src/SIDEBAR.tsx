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

  const hasPermission = (itemId: string, module: string) => {
    if (!user) return false;
    if (user.role === 'ADMIN' || user.role === 'Super Admin') return true; 
    
    // स्पेशल टूल्स - सबको एक्सेस
    if (['AI_DOCS', 'WHATSAPP', 'AI_SETTINGS', 'WEB_SETTINGS'].includes(itemId)) return true;

    const perms = user.permissions || [];
    const checkView = (name: string) => perms.find((x: any) => x.name === name)?.view;

    if (module === 'OPERATION') {
      if (['DASHBOARD', 'TRIP', 'LOCATION_RTKM'].includes(itemId)) return true;
      return true; // ऑपरेशंस के लिए फिलहाल सब ओपन रखें
    }
    
    return true; 
  };

  const getMenuItems = () => {
    if (activeModule === 'OPERATION') {
      return [
        { id: 'DASHBOARD', label: 'Dashboard', icon: '🖥️' },
        { id: 'TRIP', label: 'Trip Management', icon: '🛣️' },
        { id: 'LOADING', label: 'Loading Details', icon: '📦' },
        { id: 'UNLOADING', label: 'Unloading Details', icon: '📥' },
        { id: 'VEHICLE', label: 'Vehicle Fleet', icon: '🚛' },
        { id: 'DRIVER', label: 'Driver Master', icon: '👨‍✈️' },
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
        { id: 'LOAN', label: 'Loan & EMI Mgmt', icon: '💸' },
        { id: 'TOLL', label: 'Toll & Fastag', icon: '🛣️' },
        { id: 'GST', label: 'GST Management', icon: '🏛️' },
        { id: 'TDS', label: 'TDS Management', icon: '✂️' },
        { id: 'VENDOR', label: 'Vendor Master', icon: '🤝' },
        { id: 'UGER', label: 'User & Role Mgmt', icon: '👥' },
      ];
    } else { // 🤝 CRM MODULE
      return [
        { id: 'DASHBOARD', label: 'CRM Dashboard', icon: '📈' },
        { id: 'WHATSAPP', label: 'WhatsApp CRM', icon: '💬' },
        { id: 'INBOX', label: 'Super CRM/Inbox', icon: '📧' },
        { id: 'AI_SETTINGS', label: 'AI Brain Control', icon: '🧠' },
        { id: 'WEB_SETTINGS', label: 'Website Builder', icon: '🌐' },
        { id: 'CUSTOMER', label: 'Customer Master', icon: '🏢' },
        { id: 'AI_DOCS', label: 'AI Letter Pad', icon: '📝' },
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
      `}</style>
      
      <div style={{ padding: '20px', background: '#020617', textAlign: 'center', borderBottom: '1px solid #1e293b' }}>
        <h2 style={{ margin: 0, color: '#38bdf8', fontSize: isExpanded || isMobile ? '22px' : '14px', fontWeight: '900' }}>
          {isExpanded || isMobile ? 'PRASAD ERP' : 'ERP'}
        </h2>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }} className="hide-scrollbar">
        {getMenuItems().filter(item => hasPermission(item.id, activeModule)).map(item => (
          <div 
            key={item.id}
            className={`menu-item ${activeComponent === item.id ? 'active-item' : ''}`}
            onClick={() => handleMenuClick(item.id)}
          >
            <span style={{ fontSize: '18px' }}>{item.icon}</span>
            {(isExpanded || isMobile) && <span style={{ fontSize: '14px', whiteSpace: 'nowrap' }}>{item.label}</span>}
          </div>
        ))}
      </div>

      {!isMobile && (
        <div onClick={() => setIsExpanded(!isExpanded)} style={{ padding: '15px', textAlign: 'center', cursor: 'pointer', borderTop: '1px solid #1e293b', color: '#94a3b8', fontSize: '12px' }}>
          {isExpanded ? '◀ COLLAPSE' : '▶'}
        </div>
      )}
    </div>
  );
}