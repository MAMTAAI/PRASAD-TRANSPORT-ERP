// @ts-nocheck
import React, { useState, useEffect, lazy, Suspense } from 'react';

import { API_BASE } from './lib/apiBase';
import { isAdmin } from './lib/rbac';
const API = API_BASE;

// 🧭 SHELL (needed for first paint — stays in the entry chunk)
import SIDEBAR from './SIDEBAR';
import PublicWebsite from './PublicWebsite';
import Login from './Login';
import { DriverControlHost } from './components/DriverControlDrawer';
import ProfileMenu from './ui/ProfileMenu';
import PortalSwitcher from './ui/PortalSwitcher';
import AccountHoldScreen from './ui/AccountHoldScreen';
import GlobalHeaderNav from './components/GlobalHeaderNav';
import { FilterProvider, useGlobalFilter, navFromUrl } from './lib/filterStore';

// 📦 ALL ERP MODULES — lazy-loaded (Phase B): each module downloads only when
// opened. This cut the boot chunk from one 2.4 MB monolith to a small shell;
// visitors on the public site / login no longer pay for the whole back office.
const Dashboard = lazy(() => import('./Dashboard'));
const OperationsDeck2026 = lazy(() => import('./OperationsDeck2026'));
const AccountsDeck2026 = lazy(() => import('./AccountsDeck2026'));
const MasterControlV5 = lazy(() => import('./mastercontrol/MasterControlApp'));
const MobileSuiteApp = lazy(() => import('./modules/mobile/MobileSuiteApp'));
const AgentFleetCommand = lazy(() => import('./AgentFleetCommand'));
const SmartScanner = lazy(() => import('./SmartScanner'));
const FinanceHub2026 = lazy(() => import('./FinanceHub2026'));
const TripTrackingMap = lazy(() => import('./TripTrackingMap'));
const Vehical = lazy(() => import('./Vehical'));
const DRIVER = lazy(() => import('./DRIVER'));
const TripManagment = lazy(() => import('./TripManagment'));
const FuelMgmt = lazy(() => import('./FuelMgmt'));
const LodingDetals = lazy(() => import('./LodingDetals'));
const MasterTripSettlement = lazy(() => import('./MasterTripSettlement'));
const VehicleSettlement = lazy(() => import('./VehicleSettlement'));
const CommissionMaster = lazy(() => import('./CommissionMaster'));
const VehicleDocs = lazy(() => import('./VehicleDocs'));
const TyreMgmt = lazy(() => import('./TyreMgmt'));
const BatteryMgmt = lazy(() => import('./BatteryMgmt'));
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
const ExceptionResolution = lazy(() => import('./ExceptionResolution'));
const GstMgmt = lazy(() => import('./GstMgmt'));
const BillScanner = lazy(() => import('./BillScanner'));
const FleetCardMgmt = lazy(() => import('./FleetCardMgmt'));
const MonthlyBilling = lazy(() => import('./MonthlyBilling'));
const RateMaster = lazy(() => import('./RateMaster'));
const EmailParserSettings = lazy(() => import('./EmailParserSettings'));
const KycApprovals = lazy(() => import('./KycApprovals'));
const PendingExpenses = lazy(() => import('./PendingExpenses'));
const CustomerLedger = lazy(() => import('./CustomerLedger'));
const OwnerStatement = lazy(() => import('./OwnerStatement'));
const FuelReviewQueue = lazy(() => import('./FuelReviewQueue'));
const ProfitAndLoss = lazy(() => import('./ProfitAndLoss'));
const TdsMgmt = lazy(() => import('./TdsMgmt'));
const StaffPayroll = lazy(() => import('./StaffPayroll'));
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
const CustomerApp = lazy(() => import('./portal/CustomerApp'));
const CustomerPreview = lazy(() => import('./portal/CustomerPreview'));
// One VENDOR login, two businesses: VendorGate reads vendor_kind and opens the
// Fleet Partner app or the Service Vendor portal (2026-09-02).
const VendorGate = lazy(() => import('./portal/ServiceVendorApp').then((m) => ({ default: m.VendorGate })));
const ServiceVendorPreview = lazy(() => import('./portal/ServiceVendorPreview'));
const FleetPartnerPreview = lazy(() => import('./portal/FleetPartnerPreview'));
const AccessHub = lazy(() => import('./AccessHub'));
const DriverPortal = lazy(() => import('./DriverPortal'));

// Branded loading state while a module chunk downloads
const ModuleLoader = () => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', color: '#22d3ee', fontWeight: 900, fontSize: '18px' }}>
    ⏳ Loading module…
  </div>
);

// The filter provider wraps the entire shell, not just Master Control, so every
// screen — P&L, Cash Book, Owner Statement — reads the same Company/Branch/Owner
// scope. Previously it lived inside MasterControlApp and evaporated the moment
// you opened anything else.
export default function App() {
  return (
    <FilterProvider>
      <AppShell />
    </FilterProvider>
  );
}

function AppShell() {
  const [showPublicWebsite, setShowPublicWebsite] = useState(false); 
  const [user, setUser] = useState<any>(null);
  const [authLoading, setAuthLoading] = useState(true);
  
  // ✨ NEW: SPLASH SCREEN STATE
  const [showSplash, setShowSplash] = useState(true); 
  
  // 🚪 EXTERNAL PORTAL MODES
  //
  // DRIVER MODE OPENS FROM THE URL, NOT ONLY FROM A BUTTON.
  //
  // The WhatsApp login link is https://prasadtransport.com/driver?k=<token>,
  // and until this read the URL that address landed on the public website with
  // the token sitting unused in the address bar — a login link that logs
  // nobody in. A driver arriving from WhatsApp has no way to find the button
  // this state used to be set by, which is the entire point of sending a link.
  //
  // ?k= alone is enough on purpose: whatever path the link is shortened,
  // forwarded or rewritten to, the token is what says "this is a driver".
  const [isDriverMode, setIsDriverMode] = useState(() => {
    if (typeof window === 'undefined') return false;
    const { pathname, search } = window.location;
    return /^\/driver\/?$/i.test(pathname) || new URLSearchParams(search).has('k');
  });
  const [isCustomerMode, setIsCustomerMode] = useState(false); 
  const [isPartnerMode, setIsPartnerMode] = useState(false);
  // THE TWO DOORS (owner, 2026-09-03: "strict separation between external
  // users and office staff").
  //
  //   Gate 2 — the mobile Super-App gateway (mobile number + OTP, server picks
  //            the portal) — opens for the /app path, for ?gateway, and for any
  //            phone or tablet that is not explicitly asking for the office door.
  //   Gate 1 — the office login (username + password + one-time code, lands on
  //            Command Center) — opens for everything else, and ALWAYS for
  //            /login or /office, so a staff member on a phone can still reach
  //            it by link. Neither door carries the other's buttons.
  const isGatewayMode = (() => {
    if (typeof window === 'undefined') return false;
    const { pathname, search } = window.location;
    if (/^\/(login|office)\/?$/i.test(pathname)) return false;
    // The WhatsApp login link (/driver?k=…) is its own door — the token IS the
    // login. It must reach DriverPortal's claim, never the OTP screen.
    if (/^\/driver\/?$/i.test(pathname) || new URLSearchParams(search).has('k')) return false;
    if (/^\/app\/?$/i.test(pathname) || new URLSearchParams(search).has('gateway')) return true;
    return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|Mobile/i.test(navigator.userAgent || '');
  })();

  // Set when the server says this account may not be used yet (403
  // ACCOUNT_PENDING_APPROVAL / ACCOUNT_SUSPENDED). Held separately from `user`
  // so the hold screen can name the person it is holding.
  const [accountHold, setAccountHold] = useState(null);

  // Boot from the URL when it carries a context, so a refresh or a pasted link
  // lands on the same screen instead of bouncing back to the default home.
  const boot = navFromUrl();
  const [activeModule, setActiveModule] = useState(
    ['OPERATION', 'ACCOUNTS', 'CRM'].includes(boot.module) ? boot.module : 'OPERATION');
  // Landing page = Command Center: Transport Fleet Ops (Master Control v5.0,
  // ops tab) — Gate 1 "routes strictly to Command Center" (owner, 2026-09-03).
  // Accounts still lands on its own deck; a URL that names a screen wins.
  const [activeComponent, setActiveComponent] = useState(
    boot.screen || (boot.module === 'ACCOUNTS' ? 'ACCT_DECK' : 'MASTER_CONTROL_V5'));
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
    // 🔐 SESSION GUARD. There is no anonymous Firebase token to wait for any
    // more; the question is simply whether the stored session token is still
    // good. /auth/me answers that in one call — it checks the signature AND
    // that the session has not been revoked, which a local expiry check cannot.
    //
    // A profile in localStorage without a valid token is exactly the stale
    // login that used to make staff-only screens come back silently empty, so
    // it is cleared rather than trusted. ('@local' = Playwright QA bypass.)
    (async () => {
      try {
        const saved = JSON.parse(localStorage.getItem('prasad_user') || 'null');
        const token = localStorage.getItem('prasad_token');
        const isQaBypass = String(saved?.email || '').endsWith('@local');
        if (saved && !isQaBypass) {
          let ok = false;
          if (token) {
            try {
              const res = await fetch(`${API}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
              ok = res.ok;
              // A 503 means the database is down, not that the session is bad —
              // logging everyone out over an outage would be the wrong call.
              if (res.status === 503) ok = true;
              // 403 is the approval gate, not a bad session. Clearing the login
              // here would bounce a PENDING user to the password screen, where
              // a correct password looks like it failed. Hold them instead.
              if (res.status === 403) {
                const body = await res.json().catch(() => ({}));
                if (body.error === 'ACCOUNT_PENDING_APPROVAL' || body.error === 'ACCOUNT_SUSPENDED') {
                  setAccountHold({ status: body.error === 'ACCOUNT_SUSPENDED' ? 'SUSPENDED' : 'PENDING', user: saved });
                  ok = true;
                }
              }
            } catch { ok = true; }   // network blip: keep the session, do not evict
          }
          if (!ok) {
            localStorage.removeItem('prasad_user');
            localStorage.removeItem('prasad_token');
            localStorage.removeItem('prasad_token_expires');
            setUser(null);
            setShowPublicWebsite(false); // login screen dikhao, public site nahi
            alert('🔐 Aapka login session expire ho gaya hai.\n\nKripya apne email/password se DOBARA LOGIN karein.');
          }
        }
      } catch { /* guard is best-effort */ }
      setAuthLoading(false);
    })();
    
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

  // The Owner Fleet Matrix's KHATA button lives inside Master Control, but the
  // statement is a separate Accounts screen. A window event carries the jump so
  // the matrix does not need to know how the shell routes.
  useEffect(() => {
    const open = () => {
      setActiveModule('ACCOUNTS');
      setActiveComponent('OWNER_STATEMENT');
    };
    window.addEventListener('pt:open-owner-statement', open);
    return () => window.removeEventListener('pt:open-owner-statement', open);
  }, []);

  // The general form of the jump above, for the drill-down drawer: a row in the
  // viewer opens the screen that owns that record. Same reasoning -- the drawer
  // is nested inside three different dashboards and must not learn how the shell
  // routes.
  //
  // focusId rides along in the URL as ?focus=, so the target screen can scroll
  // to or preselect the record. A screen that ignores it simply opens normally,
  // which is why this is safe to dispatch for every metric rather than only the
  // ones already wired to read it.
  useEffect(() => {
    const go = (e: any) => {
      const d = e?.detail ?? {};
      if (!d.screen) return;
      if (d.module && ['OPERATION', 'ACCOUNTS', 'CRM'].includes(d.module)) setActiveModule(d.module);
      setActiveComponent(d.screen);
      if (d.focusId) {
        const u = new URL(window.location.href);
        u.searchParams.set('focus', String(d.focusId));
        window.history.replaceState(null, '', u.toString());
      }
    };
    window.addEventListener('pt:navigate', go);
    return () => window.removeEventListener('pt:navigate', go);
  }, []);

  // Keep module + screen in the URL alongside the filter, so refreshing or
  // sharing the link reproduces the exact context. Written by the filter store
  // with replaceState — a filter change is not navigation and must not stack
  // history entries that make Back walk through every dropdown twiddle.
  const gf = useGlobalFilter();
  useEffect(() => { gf.setNav(activeModule, activeComponent); }, [activeModule, activeComponent]);

  const handleComponentChange = (comp: string) => {
    setIsTransitioning(true);
    setTimeout(() => { 
      setActiveComponent(comp); 
      setIsTransitioning(false); 
    }, 200); 
  };

  // A preview is never a place to get stuck (owner, 2026-09-02): Escape leaves
  // any portal preview and lands on Master Control v5.0, the same as every
  // preview's Exit button. The view-as keys are cleared so the next staff call
  // is not scoped to a party by accident.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !String(activeComponent).endsWith('_PREVIEW')) return;
      try { localStorage.removeItem('prasad_view_as_customer'); localStorage.removeItem('prasad_view_as_vendor'); } catch { /* private mode */ }
      handleComponentChange('MASTER_CONTROL_V5');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeComponent]);

  const handleModuleChange = (mod: string) => {
    setActiveModule(mod);
    // Operations and Accounts land on their 2026 Command Decks (the top-level
    // summary Homes); each deck keeps its full granular console one click away.
    // CRM keeps the control centre, which opens its own tab.
    handleComponentChange(mod === 'OPERATION' ? 'OPS_DECK' : mod === 'ACCOUNTS' ? 'ACCT_DECK' : 'MASTER_CONTROL_V5');
  };

  const handleLogout = () => {
    if (window.confirm('Are you sure you want to log out?')) {
      // Tell the server first: a JWT cannot be withdrawn on its own, so logout
      // is the request that deletes the session row. keepalive because the
      // clear() and re-render below happen immediately after.
      const token = localStorage.getItem('prasad_token');
      if (token) {
        fetch(`${API}/api/v1/auth/logout`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, keepalive: true,
        }).catch(() => {});
      }
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
    if (isAdmin(user)) return true;
    // `permissions` arrives from /auth/login already unwrapped to an array
    // (permsOut flattens the {grants:[…]} jsonb). Guard anyway: a stale
    // localStorage profile written before that unwrap is still an object, and
    // .find on an object throws rather than returning false.
    const p = Array.isArray(user.permissions)
      ? user.permissions.find((x: any) => x.name === permName)
      : null;
    return p ? p.view : false;
  };

  const hasPermission = (itemId: string, module: string) => {
    if (!user) return false;

    if (itemId === 'UGER' || itemId === 'ACCESS_HUB' || itemId === 'COMPANY' || itemId === 'BRANCH' || itemId === 'WEB_SETTINGS' || itemId === 'EMAIL_PARSER') {
      return isAdmin(user);
    }

    // Admins see everything — without this, any module id missing from the
    // mapping below fell through to `return false` even for Super Admin
    // (this silently locked newly added modules for everyone).
    if (isAdmin(user)) return true;

    if (['DASHBOARD', 'OPS_DECK', 'ACCT_DECK', 'MASTER_CONTROL_V5', 'SUPER_APP', 'AI_DOCS', 'WHATSAPP', 'PARTNER_PORTAL_PREVIEW', 'CUSTOMER_PORTAL_PREVIEW', 'SERVICE_VENDOR_PORTAL_PREVIEW', 'DRIVER_PORTAL_PREVIEW'].includes(itemId)) return true;

    if (module === 'OPERATION') {
      if (itemId === 'BAZAAR_ADMIN') return checkView('Load Bazaar Admin'); 
      if (itemId === 'VEHICLE' || itemId === 'VEHICLE_DRIVER_LINK') return checkView('Vehicle Fleet');
      if (itemId === 'MARKET_VEHICLE') return checkView('Vehicle Fleet') || checkView('Vendor Master'); 
      if (itemId === 'DRIVER') return checkView('Driver Master');
      if (itemId === 'TRIP' || itemId === 'LOCATION_RTKM') return checkView('Trip Management');
      if (itemId === 'FUEL' || itemId === 'MAINTENANCE' || itemId === 'TYRE' || itemId === 'DOCS') return checkView('Fuel & Maintenance');
      if (itemId === 'LOADING' || itemId === 'UNLOADING' || itemId === 'SETTLEMENT') return checkView('Loading / Unloading');
    }
    
    if (module === 'ACCOUNTS') {
      if (itemId === 'BANK' || itemId === 'LEDGER') return checkView('Ledger & Cash Book');
      if (itemId === 'PNL' || itemId === 'LOAN' || itemId === 'EXCEPTIONS') return checkView('Finance Hub');
      if (itemId === 'BILLING' || itemId === 'AI_SCANNER' || itemId === 'AUTO_BILLING' || itemId === 'RATE_MASTER') return checkView('Billing & Invoicing');
      if (itemId === 'EXPENSE_APPROVALS') return checkView('Billing & Invoicing') || checkView('Ledger & Cash Book');
      if (itemId === 'CUST_LEDGER' || itemId === 'OWNER_STATEMENT' || itemId === 'FUEL_REVIEW') return checkView('Ledger & Cash Book') || checkView('Billing & Invoicing');
      if (itemId === 'CA_PNL') return checkView('Finance Hub');
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

  // ── which top-level modules may this person enter ───────────────────────
  // The three module tabs were rendered unconditionally, so a data-entry
  // clerk with nothing but Operations ticked still saw ACCOUNTS & ADMIN and
  // CRM, could open them, and got "You do not have permission to view this
  // module" — a dead end presented as a destination. The tick boxes in User
  // & Role already say who may see what; they just were not consulted this
  // far up.
  //
  // DERIVED FROM hasPermission, NOT FROM A SECOND LIST OF NAMES. Writing out
  // which permissions belong to which module here would be a copy of the
  // mapping above, and the two would drift the first time a screen moved
  // module. Instead each module names the screens it owns and asks the same
  // function the sidebar and the router ask.
  //
  // The ids below deliberately EXCLUDE the always-allowed set (DASHBOARD,
  // MASTER_CONTROL_V5, SUPER_APP, AI_DOCS, WHATSAPP, the portal previews):
  // hasPermission returns true for those whatever the module, so including
  // one would make every tab visible to everybody and quietly undo this.
  const MODULE_SCREENS = {
    OPERATION: ['BAZAAR_ADMIN', 'VEHICLE', 'VEHICLE_DRIVER_LINK', 'MARKET_VEHICLE', 'DRIVER', 'TRIP', 'LOCATION_RTKM', 'FUEL', 'MAINTENANCE', 'TYRE', 'DOCS', 'LOADING', 'UNLOADING', 'SETTLEMENT'],
    ACCOUNTS:  ['BANK', 'LEDGER', 'PNL', 'LOAN', 'EXCEPTIONS', 'BILLING', 'AI_SCANNER', 'AUTO_BILLING', 'RATE_MASTER', 'EXPENSE_APPROVALS', 'CUST_LEDGER', 'OWNER_STATEMENT', 'FUEL_REVIEW', 'CA_PNL', 'FLEET_CARD', 'GST', 'TDS', 'TOLL', 'VENDOR'],
    CRM:       ['CUSTOMER', 'ONBOARDING', 'INBOX', 'AI_SETTINGS'],
  };
  const canEnterModule = (mod) =>
    isAdmin(user) || (MODULE_SCREENS[mod] ?? []).some((id) => hasPermission(id, mod));
  const visibleModules = ['OPERATION', 'ACCOUNTS', 'CRM'].filter(canEnterModule);

  // A module can stop being permitted between renders — a URL pasted from
  // somebody with more access, or an admin editing the ticks while the
  // person is signed in. Land them on one they can actually use instead of
  // leaving them staring at the permission notice with no way out.
  useEffect(() => {
    if (!user || !visibleModules.length) return;
    if (!visibleModules.includes(activeModule)) setActiveModule(visibleModules[0]);
  }, [user, activeModule, visibleModules.join(",")]);

  // ==========================================
  // 🌟 NATIVE SPLASH SCREEN (Swiggy / Uber Style)
  // ==========================================
  if (showSplash || authLoading) {
    return (
      <div style={{ position: 'fixed', inset: 0, background: '#0a1024', zIndex: 99999, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <style>{`
          @keyframes pulseLogo {
            0% { transform: scale(1); box-shadow: 0 0 0 0 rgba(34, 211, 238, 0.7); }
            70% { transform: scale(1.1); box-shadow: 0 0 0 20px rgba(34, 211, 238, 0); }
            100% { transform: scale(1); box-shadow: 0 0 0 0 rgba(34, 211, 238, 0); }
          }
          @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes loadBar { 0% { width: 0%; } 100% { width: 100%; } }
        `}</style>
        
        <div style={{ width: '120px', height: '120px', background: 'linear-gradient(135deg, #3b82f6, #22d3ee)', borderRadius: '35px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '55px', animation: 'pulseLogo 2s infinite', marginBottom: '25px', boxShadow: '0 10px 30px rgba(34, 211, 238, 0.4)' }}>
          🚛
        </div>
        
        <h1 style={{ color: 'white', fontSize: '32px', fontWeight: '900', margin: '0 0 10px 0', letterSpacing: '1px', animation: 'slideUp 0.5s ease-out forwards', textAlign: 'center' }}>
          PRASAD TRANSPORT
        </h1>
        <p style={{ color: '#22d3ee', fontSize: '13px', fontWeight: 'bold', letterSpacing: '4px', textTransform: 'uppercase', animation: 'slideUp 0.5s ease-out 0.2s forwards', opacity: 0 }}>
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
  // 🔒 APPROVAL GATE. Ahead of every other route: a held account must not reach
  // a portal, a preview or the shell. The server refuses its requests anyway —
  // this is what turns that refusal into an explanation.
  if (accountHold) {
    return (
      <AccountHoldScreen
        status={accountHold.status}
        user={accountHold.user}
        onLogout={() => {
          localStorage.clear();
          sessionStorage.clear();
          setAccountHold(null);
          setUser(null);
          setShowPublicWebsite(false);
        }}
      />
    );
  }

  if (showPublicWebsite && !user) return <PublicWebsite onLoginClick={() => setShowPublicWebsite(false)} />;
  // CUSTOMER MODE SPLITS ON WHETHER THERE IS A SESSION — the same rule the
  // partner door follows just below, for the same reason: the signed-in app
  // (post loads, compare bids, accept, track — all customer-scoped server
  // routes) has nothing to show a party that does not exist yet, and the old
  // portal is still where onboarding lives.
  if (isCustomerMode) {
    const customerSignedIn = !!localStorage.getItem('prasad_token');
    return (
      <Suspense fallback={<ModuleLoader />}>
        {customerSignedIn
          ? <CustomerApp />
          : <CustomerPortal onLogout={() => { setIsCustomerMode(false); setShowPublicWebsite(true); }} />}
      </Suspense>
    );
  }
  // PARTNER MODE SPLITS ON WHETHER THERE IS A SESSION.
  //
  // A signed-in partner gets the 2026 mobile app: blind-bid load board, own
  // fleet, earnings — all of it reading the vendor-scoped portal routes that
  // enforce the gate and the RBAC matrix server-side.
  //
  // Someone who has NOT signed in still gets the old portal, because that is
  // where onboarding lives (POST /bazaar/onboarding). Replacing it outright
  // would have deleted the only way a new partner can apply — the new app has
  // nothing to show a party that does not exist yet.
  if (isPartnerMode) {
    const partnerSignedIn = !!localStorage.getItem('prasad_token');
    return (
      <Suspense fallback={<ModuleLoader />}>
        {partnerSignedIn
          ? <VendorGate />
          : <FleetPartnerPortal onBack={() => { setIsPartnerMode(false); setShowPublicWebsite(true); }} />}
      </Suspense>
    );
  }
  if (isGatewayMode && !user) {
    return (
      <Suspense fallback={<ModuleLoader />}>
        <div style={{ position: 'fixed', inset: 0, overflowY: 'auto', background: '#0a1024' }}><MobileSuiteApp /></div>
      </Suspense>
    );
  }
  if (isDriverMode) return <Suspense fallback={<ModuleLoader />}><DriverPortal onBack={() => { setIsDriverMode(false); setShowPublicWebsite(true); }} /></Suspense>;
  
  if (!user && !showPublicWebsite && !isDriverMode && !isCustomerMode && !isPartnerMode) {
    return (
      // GATE 1. Staff only; the outside parties' buttons that used to sit on
      // this screen are gone — they enter through Gate 2 (/app).
      <Login
        onLoginSuccess={handleLoginSuccess}
        onAccountHold={setAccountHold}
        onBackToWeb={() => setShowPublicWebsite(true)}
      />
    );
  }

  const renderActiveComponent = () => {
    if (!hasPermission(activeComponent, activeModule)) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '80vh', textAlign: 'center', animation: 'fadeIn 0.5s' }}>
          <div style={{ fontSize: '80px', marginBottom: '20px' }}>🔒</div>
          <h2 style={{ color: '#ff6b81', margin: '0 0 10px 0', fontSize: '32px', fontWeight: '900' }}>ACCESS RESTRICTED</h2>
          <p style={{ color: '#9aadd4' }}>You do not have permission to view this module. Contact Admin.</p>
        </div>
      );
    }
    
    switch (activeComponent) {
      // 🔥 MAIN FIX IS HERE: PASSING currentUser={user} TO DASHBOARD
      case 'DASHBOARD': return <Dashboard activeModule={activeModule} currentUser={user} />;
      case 'OPS_DECK': return <OperationsDeck2026 currentUser={user} onOpenConsole={handleComponentChange} />;
      case 'ACCT_DECK': return <AccountsDeck2026 currentUser={user} onOpenTool={handleComponentChange} />;
      // 🚀 v5.0 Master Control — opens on the tab matching the current ERP module
      case 'MASTER_CONTROL_V5':
        return <MasterControlV5 initialTab={activeModule === 'ACCOUNTS' ? 'finance' : activeModule === 'CRM' ? 'crm' : 'ops'} />;
      // 📱 1-App/5-Role Super App (Ola/Uber-style live fleet) — full-screen like the portals
      case 'SUPER_APP':
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'radial-gradient(rgba(154,173,212,0.07) 1px, transparent 1px) 0 0/22px 22px, radial-gradient(1100px 700px at 50% 0%, rgba(34,211,238,0.06) 0%, transparent 60%), #05070e', overflowY: 'auto' }}>
            <button onClick={() => handleComponentChange('MASTER_CONTROL_V5')} style={{ position: 'fixed', top: 12, right: 14, zIndex: 10000, background: 'rgba(24, 36, 74,0.9)', color: '#9aadd4', border: '1px solid #27395f', padding: '8px 14px', borderRadius: '10px', fontWeight: 900, fontSize: '11px', cursor: 'pointer' }}>✕ EXIT SUPER APP</button>
            <MobileSuiteApp />
          </div>
        );
      case 'AGENT_FLEET': return <AgentFleetCommand />;
      case 'SMART_SCANNER': return <SmartScanner />;
      case 'FINANCE_2026': return <FinanceHub2026 />;
      case 'LIVE_TRACKING': return <TripTrackingMap />;
      case 'BAZAAR_ADMIN': return <BazaarAdmin />; 
      case 'MARKET_VEHICLE': return <MarketVehicles />; 
      
      // 🔥 PREVIEW PORTALS RENDER
      case 'PARTNER_PORTAL_PREVIEW': 
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'radial-gradient(rgba(154,173,212,0.07) 1px, transparent 1px) 0 0/22px 22px, radial-gradient(1100px 700px at 50% 0%, rgba(34,211,238,0.06) 0%, transparent 60%), #05070e', overflowY: 'auto' }}>
            {/* The REAL signed-in Fleet Partner App, scoped read-only to a chosen
                partner (2026-09-02). FleetPartnerPortal.tsx stays as the
                pre-login onboarding door only. */}
            <FleetPartnerPreview onExit={() => handleComponentChange('MASTER_CONTROL_V5')} />
          </div>
        );
      case 'CUSTOMER_PORTAL_PREVIEW': 
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'radial-gradient(rgba(154,173,212,0.07) 1px, transparent 1px) 0 0/22px 22px, radial-gradient(1100px 700px at 50% 0%, rgba(34,211,238,0.06) 0%, transparent 60%), #05070e', overflowY: 'auto' }}>
            {/* The REAL signed-in Customer App, scoped read-only to a chosen
                customer (2026-09-02). The legacy CustomerPortal.tsx stays as
                the pre-login onboarding door only. */}
            <CustomerPreview onExit={() => handleComponentChange('MASTER_CONTROL_V5')} />
          </div>
        );
      case 'SERVICE_VENDOR_PORTAL_PREVIEW':
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'radial-gradient(rgba(154,173,212,0.07) 1px, transparent 1px) 0 0/22px 22px, radial-gradient(1100px 700px at 50% 0%, rgba(34,211,238,0.06) 0%, transparent 60%), #05070e', overflowY: 'auto' }}>
            <ServiceVendorPreview onExit={() => handleComponentChange('MASTER_CONTROL_V5')} />
          </div>
        );
      case 'DRIVER_PORTAL_PREVIEW':
        return (
          <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'radial-gradient(rgba(154,173,212,0.07) 1px, transparent 1px) 0 0/22px 22px, radial-gradient(1100px 700px at 50% 0%, rgba(34,211,238,0.06) 0%, transparent 60%), #05070e', overflowY: 'auto' }}>
            <DriverPortal preview onBack={() => handleComponentChange('MASTER_CONTROL_V5')} />
          </div>
        );

      case 'COMPANY': return <COMPANY />; 
      case 'BRANCH': return <BRANCH />; 
      case 'UGER': return <UGER />;
      case 'ACCESS_HUB': return <AccessHub onNavigate={handleComponentChange} />;
      case 'AI_DOCS': return <AiLetterPad />;
      case 'WHATSAPP': return <WhatsappDashboard />;
      case 'AI_SETTINGS': return <AiSettings />; 
      case 'WEB_SETTINGS': return <WebSettings />; 
      case 'VEHICLE': return <Vehical />;
      case 'DRIVER': return <DRIVER />;
      case 'TRIP': return <TripManagment />;
      case 'FUEL': return <FuelMgmt />;
      case 'LOADING': return <LodingDetals />;
      case 'SETTLEMENT': return <MasterTripSettlement />;
      case 'VEHICLE_SETTLEMENT': return <VehicleSettlement />;
      case 'COMMISSION_MASTER': return <CommissionMaster />;
      // Legacy key (stale saved nav state) → same module, unloading lives in its tab
      case 'UNLOADING': return <MasterTripSettlement />;
      case 'DOCS': return <VehicleDocs />;
      case 'TYRE': return <TyreMgmt />;
      case 'BATTERY': return <BatteryMgmt />;
      case 'MAINTENANCE': return <VehicleMaintenance />;
      case 'BANK': return <CashBankBook />;
      case 'LEDGER': return <LedgerMgmt />;
      case 'PNL': return <FinancialReports />;
      case 'BILLING': return <BillManagement />;
      case 'AI_SCANNER': return <BillScanner />;
      case 'FLEET_CARD': return <FleetCardMgmt />;
      case 'AUTO_BILLING': return <MonthlyBilling />;
      case 'RATE_MASTER': return <RateMaster />;
      case 'EMAIL_PARSER': return <EmailParserSettings />;
      case 'EXPENSE_APPROVALS': return <PendingExpenses />;
      case 'CUST_LEDGER': return <CustomerLedger />;
      case 'OWNER_STATEMENT': return <OwnerStatement />;
      case 'FUEL_REVIEW': return <FuelReviewQueue />;
      case 'CA_PNL': return <ProfitAndLoss />;
      case 'ONBOARDING': return <KycApprovals />;
      case 'LOCATION_RTKM': return <LocationRtkmMaster />;
      case 'CUSTOMER': return <Customer />;
      case 'VENDOR': return <Vander />;
      case 'TOLL': return <TollFastagMgmt />;
      case 'LOAN': return <LoanEmiMgmt />;
      case 'EXCEPTIONS': return <ExceptionResolution />;
      case 'GST': return <GstMgmt />;
      case 'TDS': return <TdsMgmt />;
      case 'STAFF_PAYROLL': return <StaffPayroll />;
      case 'INBOX': return <CompanyInbox />;
      case 'VEHICLE_DRIVER_LINK': return <VehicleDriverLink />;
      // 🔥 MAIN FIX IS HERE TOO
      // Unknown / stale saved nav state lands on the control centre, not the
      // legacy dashboard.
      default:
        return <MasterControlV5 initialTab={activeModule === 'ACCOUNTS' ? 'finance' : activeModule === 'CRM' ? 'crm' : 'ops'} />;
    }
  };

  // The avatar used to be fetched from ui-avatars.com — an external request, on
  // every page load, carrying a staff member's real name in the query string to
  // a third party. ProfileMenu draws initials locally instead.

  return (
    <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', overflow: 'hidden', background: 'radial-gradient(1200px 680px at 88% -8%, rgba(34,211,238,0.10) 0%, transparent 60%), radial-gradient(900px 620px at 2% 104%, rgba(167,139,250,0.09) 0%, transparent 58%), linear-gradient(180deg, #0b1228 0%, #0a1024 100%)', fontFamily: "'Inter', sans-serif" }}>
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
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px', padding: isMobile ? '10px 15px' : '15px 20px', background: 'rgba(18, 28, 56, 0.88)', backdropFilter: 'blur(14px)', borderBottom: '1px solid #18244a', position: 'relative', zIndex: 100 }}>
          
          {isMobile ? (
            // 📱 MOBILE TOP BAR (Clean & Native App Look)
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
                <button onClick={() => setMobileMenuOpen(true)} style={{ background: 'transparent', border: 'none', color: '#22d3ee', fontSize: '26px', cursor: 'pointer', padding: 0 }}>☰</button>
                <span style={{ color: '#fff', fontSize: '16px', fontWeight: '900', letterSpacing: '1px' }}>PRASAD TRANSPORT</span>
              </div>
              {/* Same menu as desktop. The bare 🚪 that used to live here was a
                  one-tap logout with no confirmation target and no way to see
                  which account you were signed in as. */}
              <ProfileMenu user={user} onLogout={handleLogout} compact />
            </div>
          ) : (
            // 💻 DESKTOP TOP BAR
            <>
              <div style={{ display: 'flex', gap: '15px', alignItems: 'center', flexWrap: 'wrap' }}>
                {/* Persistent on every screen — the shell header renders on all of
                    them. Switching module never touches the global filter, so the
                    Company/Branch/Owner scope carries straight across. */}
                <GlobalHeaderNav activeModule={activeModule} onChange={handleModuleChange} allowed={visibleModules} />

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginLeft: '10px', paddingLeft: '15px', borderLeft: '1px solid #27395f' }}>
                  {visibleModules.includes('CRM') && (
                  <button onClick={() => { handleModuleChange('CRM'); handleComponentChange('WHATSAPP'); }} title="WhatsApp Master Dashboard" style={{ display: 'flex', padding: '8px 12px', background: 'linear-gradient(135deg, #128C7E, #25D366)', borderRadius: '8px', border: 'none', cursor: 'pointer', gap: '8px', alignItems: 'center' }}>
                    <span style={{color:'white', fontWeight:'bold', fontSize:'12px'}}>CRM PANEL</span>
                  </button>
                  )}
                  
                  {isAdmin(user) && (
                    <button onClick={() => { handleModuleChange('CRM'); handleComponentChange('WEB_SETTINGS'); }} style={{ display: 'flex', padding: '8px 12px', background: 'linear-gradient(135deg, #22d3ee, #818cf8)', borderRadius: '8px', border: 'none', cursor: 'pointer', gap: '8px', alignItems: 'center' }}>
                      <span style={{color:'white', fontWeight:'bold', fontSize:'12px'}}>🌐 EDIT WEBSITE</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Right cluster: the three portal previews collapse into one
                  "View As" menu, and the name/role/LOGOUT block collapses into
                  a single avatar. That is ~260px of header handed back to the
                  module tabs, which used to wrap onto a second row on a
                  laptop. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', justifyContent: 'flex-end', flexShrink: 0 }}>
                <PortalSwitcher onOpen={handleComponentChange} activeComponent={activeComponent} />
                <div style={{ width: 1, height: 26, background: '#27395f', flexShrink: 0 }} />
                <ProfileMenu user={user} onLogout={handleLogout} />
              </div>
            </>
          )}
        </div>

        {/* 📝 MAIN CONTENT */}
        <div className="fade-content" style={{ flex: 1, overflowY: 'auto', padding: isMobile ? '10px' : '25px', paddingBottom: isMobile ? '80px' : '25px', background: 'radial-gradient(1200px 680px at 88% -8%, rgba(34,211,238,0.10) 0%, transparent 60%), radial-gradient(900px 620px at 2% 104%, rgba(167,139,250,0.09) 0%, transparent 58%), linear-gradient(180deg, #0b1228 0%, #0a1024 100%)', backgroundAttachment: 'fixed' }}>
            <Suspense fallback={<ModuleLoader />}>{renderActiveComponent()}</Suspense>
            {/* Driver Control Dashboard (owner, 2026-09-03): mounted ONCE for the
                whole ERP, so a driver's name on any screen — Command Center,
                dispatch chat, fleet map, Driver Master — slides it out in place. */}
            <DriverControlHost />
        </div>

        {/* 📱 NATIVE APP BOTTOM NAVIGATION BAR (ONLY VISIBLE ON MOBILE) */}
        {isMobile && (
          <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: '65px', background: '#121c38', borderTop: '1px solid #18244a', display: 'flex', justifyContent: 'space-around', alignItems: 'center', zIndex: 50, paddingBottom: 'env(safe-area-inset-bottom)', boxShadow: '0 -4px 15px rgba(0,0,0,0.5)' }}>
            
            {visibleModules.includes('OPERATION') && (
            <button onClick={() => handleModuleChange('OPERATION')} style={{ background: 'none', border: 'none', color: activeModule === 'OPERATION' ? '#22d3ee' : '#5d7196', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer', flex: 1 }}>
              <span style={{ fontSize: activeModule === 'OPERATION' ? '24px' : '20px', transition: '0.2s', filter: activeModule === 'OPERATION' ? 'drop-shadow(0 0 5px rgba(34, 211, 238,0.5))' : 'none' }}>🚛</span>
              <span style={{ fontSize: '10px', fontWeight: activeModule === 'OPERATION' ? '900' : 'normal' }}>Ops</span>
            </button>
            )}

            {visibleModules.includes('ACCOUNTS') && (
            <button onClick={() => handleModuleChange('ACCOUNTS')} style={{ background: 'none', border: 'none', color: activeModule === 'ACCOUNTS' ? '#2fe39b' : '#5d7196', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer', flex: 1 }}>
              <span style={{ fontSize: activeModule === 'ACCOUNTS' ? '24px' : '20px', transition: '0.2s', filter: activeModule === 'ACCOUNTS' ? 'drop-shadow(0 0 5px rgba(47, 227, 155,0.5))' : 'none' }}>💰</span>
              <span style={{ fontSize: '10px', fontWeight: activeModule === 'ACCOUNTS' ? '900' : 'normal' }}>Accounts</span>
            </button>
            )}

            {visibleModules.includes('CRM') && (
            <button onClick={() => handleModuleChange('CRM')} style={{ background: 'none', border: 'none', color: activeModule === 'CRM' ? '#ffb224' : '#5d7196', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', cursor: 'pointer', flex: 1 }}>
              <span style={{ fontSize: activeModule === 'CRM' ? '24px' : '20px', transition: '0.2s', filter: activeModule === 'CRM' ? 'drop-shadow(0 0 5px rgba(255, 178, 36,0.5))' : 'none' }}>🤝</span>
              <span style={{ fontSize: '10px', fontWeight: activeModule === 'CRM' ? '900' : 'normal' }}>CRM</span>
            </button>
            )}

          </div>
        )}

      </div>
    </div>
  );
}