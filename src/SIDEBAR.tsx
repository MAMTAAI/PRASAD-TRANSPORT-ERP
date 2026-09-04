// @ts-nocheck
import React, { useState, useEffect } from 'react';

import { API_BASE } from './lib/apiBase';
import { isAdmin } from './lib/rbac';
const API = API_BASE;

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

  // 🔴 LIVE pending counts (replaces the old hardcoded "3" badge)
  const [pendingKyc, setPendingKyc] = useState(0);
  const [pendingReq, setPendingReq] = useState(0);
  const [pendingExp, setPendingExp] = useState(0);
  // Three Firestore listeners became one endpoint returning three integers,
  // polled while the tab is visible. A badge does not need a live socket, and
  // the counts are one query server-side.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`${API}/api/v1/queues/badges`);
        if (!res.ok || !alive) return;
        const b = await res.json();
        setPendingKyc(b.pending_kyc ?? 0);
        setPendingReq(b.pending_requests ?? 0);
        setPendingExp(b.pending_expenses ?? 0);
      } catch { /* a badge is not worth an error surface */ }
    };
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const badgeFor = (id) => (id === 'ONBOARDING' || id === 'BAZAAR_ADMIN') ? pendingKyc : id === 'DRIVER' ? pendingReq : id === 'EXPENSE_APPROVALS' ? pendingExp : 0;

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
    if (isAdmin(user)) return true;
    
    // 🔒 SECURITY: आम स्टाफ को Master Setup नहीं दिखेगा
    if (['COMPANY', 'BRANCH', 'UGER', 'ACCESS_HUB', 'WEB_SETTINGS', 'EMAIL_PARSER'].includes(itemId)) {
      return false;
    }
    
    // 🔓 DEFAULT OPEN FOR ALL STAFF
    if (['DASHBOARD', 'OPS_DECK', 'ACCT_DECK', 'MASTER_CONTROL_V5', 'SUPER_APP', 'AI_DOCS', 'WHATSAPP'].includes(itemId)) return true;

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
      if (itemId === 'LOADING' || itemId === 'UNLOADING' || itemId === 'SETTLEMENT') return checkView('Loading / Unloading');
      return false;
    }
    
    if (module === 'ACCOUNTS') {
      if (itemId === 'BANK' || itemId === 'LEDGER') return checkView('Ledger & Cash Book');
      if (itemId === 'PNL' || itemId === 'LOAN') return checkView('Finance Hub');
      if (itemId === 'BILLING' || itemId === 'AUTO_BILLING' || itemId === 'AI_SCANNER'
          || itemId === 'RATE_MASTER' || itemId === 'COMMISSION_MASTER') return checkView('Billing & Invoicing');
      if (itemId === 'EXPENSE_APPROVALS') return checkView('Billing & Invoicing') || checkView('Ledger & Cash Book');
      if (itemId === 'CUST_LEDGER' || itemId === 'OWNER_STATEMENT' || itemId === 'FUEL_REVIEW') return checkView('Ledger & Cash Book') || checkView('Billing & Invoicing');
      if (itemId === 'CA_PNL') return checkView('Finance Hub');
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
        // The 2026 Command Deck is the Operations Home — a top-level live summary.
        // The full granular console (Master Control v5.0) sits right below it,
        // unchanged, so nothing that ran there is lost.
        { id: 'OPS_DECK', label: 'Command Deck (Home)', icon: '🛰️' },
        { id: 'MASTER_CONTROL_V5', label: 'Master Control v5.0', icon: '🚀' },
        { id: 'SUPER_APP', label: 'Super App (5-Role Mobile)', icon: '📱' },
        // The duplicate DASHBOARD entries in ACCOUNTS ("Finance Hub") and CRM
        // ("CRM Dashboard") went first — they were one screen under three
        // names. The last copy ("Live Books") is gone too: it only survived
        // because v5.0 was on demo numbers, and v5.0 now reads the real
        // PostgreSQL books through /api/v1/dashboard/v5. One home, not two.
        // AI Agent Fleet moved to the CRM (MAMTA AI) module on 2026-08-16. It is
        // the AI control surface, not a dispatch screen, and it sat here only
        // because that is where it was first built.
        { id: 'SMART_SCANNER', label: 'Smart Scanner (0-cost)', icon: '📸' },
        // NOT a dashboard — this is the voucher entry desk (RECEIPT / PAYMENT
        // / CONTRA through TARA) and the only posting path in the UI. Renamed
        // from "Finance Hub 2026" so it stops reading as a rival home screen.
        { id: 'FINANCE_2026', label: 'Voucher Entry (TARA)', icon: '💠' },
        { id: 'LIVE_TRACKING', label: 'Live Tracking (GPS)', icon: '🛰' },
        { id: 'BAZAAR_ADMIN', label: 'Bazaar Admin (KYC/Bids)', icon: '🌍' }, 
        { id: 'TRIP', label: 'Trip Management', icon: '🛣️' },
        { id: 'LOADING', label: 'Loading Details', icon: '📦' },
        { id: 'SETTLEMENT', label: 'Master Trip Settlement', icon: '🧾' },
        // Per-LORRY, per-fortnight P&L. Master Trip Settlement above is the
        // DRIVER's hisaab (advances, carry-forward); this one is the vehicle's.
        { id: 'VEHICLE_SETTLEMENT', label: 'Vehicle 15-Day Settlement', icon: '📅' },
        { id: 'VEHICLE', label: 'Our Vehicle Fleet', icon: '🚛' },
        { id: 'MARKET_VEHICLE', label: 'Market Vehicles (Fleet Partners)', icon: '🚚' },
        { id: 'DRIVER', label: 'Driver Master', icon: '👨‍✈️' },
        { id: 'VEHICLE_DRIVER_LINK', label: 'Link Vehicle & Driver', icon: '🔗' },
        { id: 'LOCATION_RTKM', label: 'Route & RTKM', icon: '📍' },
        { id: 'FUEL', label: 'Fuel (HSD) Mgmt', icon: '⛽' },
        { id: 'DOCS', label: 'Vehicle Documents', icon: '📄' },
        { id: 'TYRE', label: 'Tyre Management', icon: '🛞' },
        { id: 'BATTERY', label: 'Battery Management', icon: '🔋' },
        { id: 'MAINTENANCE', label: 'Workshop/Maint.', icon: '🛠️' },
        { id: 'AI_DOCS', label: 'AI Letter Pad', icon: '📝' },
      ];
    } else if (activeModule === 'ACCOUNTS') {
      return [
        // The 2026 Command Deck is the Accounts Home — a top-level live summary
        // off the posted books. Every granular tool sits right below it,
        // unchanged, so nothing that ran there is lost.
        { id: 'ACCT_DECK', label: 'Command Deck (Home)', icon: '🧮' },
        { id: 'MASTER_CONTROL_V5', label: 'Master Control v5.0', icon: '🚀' },
        { id: 'BANK', label: 'Cash & Bank Book', icon: '🏦' },
        { id: 'LEDGER', label: 'Ledgers & Party', icon: '📖' },
        { id: 'CUST_LEDGER', label: 'Customer Khata (Live)', icon: '🧾' },
        { id: 'OWNER_STATEMENT', label: 'Owner Khata & Statement', icon: '🚛' },
        { id: 'FUEL_REVIEW', label: 'Fuel Import Review', icon: '⛽' },
        { id: 'PNL', label: 'Balance Sheet/P&L', icon: '📊' },
        { id: 'CA_PNL', label: 'Company P&L (Live)', icon: '📈' },
        { id: 'BILLING', label: 'Bill Management', icon: '🧾' },
        { id: 'EXPENSE_APPROVALS', label: 'Pending Expenses', icon: '⏳' },
        { id: 'AUTO_BILLING', label: 'Auto Billing (Monthly)', icon: '⚡' },
        { id: 'RATE_MASTER', label: 'Rate Master (Freight Rules)', icon: '💹' },
        // Sits beside Rate Master because it answers the mirror question:
        // Rate Master is what we CHARGE the customer, this is what we KEEP
        // out of an attached or market lorry's freight. 16 attached lorries
        // carry ~45% of a fortnight's freight and none of them has a rate.
        { id: 'COMMISSION_MASTER', label: 'Commission & Rate Master', icon: '💼' },
        { id: 'AI_SCANNER', label: 'AI Bill Scanner', icon: '🤖' },
        { id: 'EMAIL_PARSER', label: 'Email Bill Parser (Auto)', icon: '📧' },
        { id: 'FLEET_CARD', label: 'Fleet Card & Settlement', icon: '💳' },
        { id: 'LOAN', label: 'Loan & EMI Mgmt', icon: '💸' },
        { id: 'EXCEPTIONS', label: 'Exception Resolution', icon: '🛠️' },
        { id: 'TOLL', label: 'Toll & Fastag', icon: '🛣️' },
        { id: 'GST', label: 'GST Management', icon: '🏛️' },
        { id: 'TDS', label: 'TDS Management', icon: '✂️' },
        { id: 'VENDOR', label: 'Vendor Master', icon: '🤝' },
      ];
    } else { 
      // 🤝 CRM MODULE (WITH ADMIN SETUP AT BOTTOM)
      return [
        { id: 'MASTER_CONTROL_V5', label: 'Master Control v5.0', icon: '🚀' },
        { id: 'WHATSAPP', label: 'WhatsApp CRM', icon: '💬' },
        { id: 'INBOX', label: 'Super CRM/Inbox', icon: '📧' },
        { id: 'AI_SETTINGS', label: 'AI Brain Control', icon: '🧠' },
        // Moved here from OPERATIONS (2026-08-16): the ten Mahavidya agents are
        // MAMTA AI's own control surface and belong beside AI Brain Control,
        // not beside Trip Management.
        { id: 'AGENT_FLEET', label: 'AI Agent Fleet', icon: '🤖' },
        { id: 'WEB_SETTINGS', label: 'Website Builder', icon: '🌐' },
        { id: 'CUSTOMER', label: 'Customer Master', icon: '🏢' },
        { id: 'ONBOARDING', label: 'KYC Approvals', icon: '🪪' },
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
    <div style={{ width: isMobile ? '260px' : (isExpanded ? '260px' : '80px'), background: 'linear-gradient(185deg, #16224a 0%, #101a34 55%, #0c1329 100%)', borderRight: '1px solid #27395f', boxShadow: '1px 0 0 rgba(255,255,255,0.03), 8px 0 32px rgba(4,9,26,0.45)', height: '100vh', display: 'flex', flexDirection: 'column', position: isMobile ? 'fixed' : 'relative', left: isMobile ? (isOpen ? '0' : '-100%') : '0', zIndex: 1000, transition: 'all 0.3s ease' }}>
      <style>{`
        .hide-scrollbar::-webkit-scrollbar { display: none; }
        /* 2026 "Indigo Deck": the rail sits on a navy gradient, so a row needs
           a lit edge and a glow to read as selected rather than just filled.
           translateX on hover is kept — it is the only affordance an icon-only
           collapsed rail has. */
        .menu-item { position: relative; border-radius: 10px; margin: 2px 10px; cursor: pointer;
          display: flex; align-items: center; gap: 15px; color: #c4d1ea; padding: 12px 15px;
          border: 1px solid transparent;
          transition: background .18s ease, color .18s ease, border-color .18s ease, transform .18s ease, box-shadow .22s ease; }
        .menu-item:hover { background: rgba(34, 211, 238, 0.10); border-color: rgba(34, 211, 238, 0.22); transform: translateX(4px); color: #fff; }
        .active-item { background: rgba(34, 211, 238, 0.16) !important; color: #22d3ee !important;
          border-color: rgba(34, 211, 238, 0.42) !important;
          box-shadow: inset 3px 0 0 #22d3ee, 0 0 22px rgba(34, 211, 238, 0.26) !important; }
        .highlight-item { background: rgba(255, 178, 36, 0.10); border-color: rgba(255, 178, 36, 0.30); box-shadow: inset 3px 0 0 #ffb224; color: #fcd34d; }
        .highlight-item:hover { background: rgba(255, 178, 36, 0.18); border-color: rgba(255, 178, 36, 0.45); color: #ffb224; }
        .active-highlight { background: rgba(255, 178, 36, 0.22) !important; color: #ffb224 !important;
          border-color: rgba(255, 178, 36, 0.50) !important;
          box-shadow: inset 3px 0 0 #ffb224, 0 0 22px rgba(255, 178, 36, 0.26) !important; }
        /* The count badge is a call to action, so it glows like every other
           "waiting on a person" surface in the theme. */
        .menu-badge { margin-left: auto; background: rgba(255, 107, 129, 0.18); color: #ff6b81;
          border: 1px solid rgba(255, 107, 129, 0.45); box-shadow: 0 0 14px rgba(255, 107, 129, 0.30);
          padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 800;
          font-variant-numeric: tabular-nums; }
      `}</style>
      
      <div style={{ padding: '20px', background: 'linear-gradient(180deg, rgba(34,211,238,0.10), rgba(34,211,238,0))', textAlign: 'center', borderBottom: '1px solid #27395f' }}>
        <h2 style={{ margin: 0, color: '#22d3ee', textShadow: '0 0 20px rgba(34,211,238,0.45)', letterSpacing: '0.02em', fontSize: isExpanded || isMobile ? '22px' : '14px', fontWeight: '900' }}>
          {isExpanded || isMobile ? 'PRASAD ERP' : 'ERP'}
        </h2>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }} className="hide-scrollbar">
        {getMenuItems().filter(item => item.isDivider ? isAdmin(user) : hasPermission(item.id, activeModule)).map(item => {
          
          // 🔥 RENDER MASTER ADMIN HEADING
          if (item.isDivider) {
             return (isExpanded || isMobile) && (
               <div key={item.id} style={{ fontSize: '10px', color: '#7288b3', fontWeight: 800, margin: '25px 15px 10px', textTransform: 'uppercase', letterSpacing: '0.16em', borderBottom: '1px solid #27395f', paddingBottom: '6px' }}>
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
                  {badgeFor(item.id) > 0 && <span className="menu-badge">{badgeFor(item.id)}</span>}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {!isMobile && (
        <div onClick={() => setIsExpanded(!isExpanded)} style={{ padding: '15px', textAlign: 'center', cursor: 'pointer', borderTop: '1px solid #18244a', color: '#9aadd4', fontSize: '12px' }}>
          {isExpanded ? '◀ COLLAPSE' : '▶'}
        </div>
      )}
    </div>
  );
}