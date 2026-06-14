// 🔐 RBAC — role + scope based access (Phase 10). Pure functions (no Firestore)
// so every data surface (tables, dashboards, RAG, Mamta AI) filters the same way.
// Applies app-wide: a vendor sees only their vehicles, a customer only their
// loads, a driver only their trips. Admin/Manager/Accounts see (per matrix) all.

export type Role = 'Admin' | 'Super Admin' | 'Manager' | 'Operator' | 'Accounts' | 'Vendor' | 'Customer' | 'Driver';

export interface AppUser {
  role: Role | string;
  full_name?: string;
  name?: string;
  email?: string;
  // scope keys (set on the user record for external roles)
  vendor_name?: string;
  customer_name?: string;
  driver_name?: string;
  permissions?: { name: string; view?: boolean; edit?: boolean }[];
}

const norm = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ── Module access matrix ────────────────────────────────────────────────
// '*' = all modules. financials = may view ledger/P&L/cash. write = may edit.
interface RoleCaps { modules: string[] | '*'; financials: boolean; write: boolean }
const MATRIX: Record<string, RoleCaps> = {
  admin:        { modules: '*', financials: true, write: true },
  superadmin:   { modules: '*', financials: true, write: true },
  manager:      { modules: ['DASHBOARD', 'TRIP', 'LOADING', 'UNLOADING', 'VEHICLE', 'MARKET_VEHICLE', 'DRIVER', 'VEHICLE_DRIVER_LINK', 'LOCATION_RTKM', 'FUEL', 'DOCS', 'TYRE', 'MAINTENANCE', 'BAZAAR_ADMIN', 'WHATSAPP'], financials: false, write: true },
  operator:     { modules: ['DASHBOARD', 'TRIP', 'LOADING', 'UNLOADING', 'VEHICLE', 'DRIVER', 'FUEL', 'DOCS'], financials: false, write: true },
  accounts:     { modules: ['DASHBOARD', 'BANK', 'LEDGER', 'PNL', 'BILLING', 'LOAN', 'TOLL', 'GST', 'TDS', 'VENDOR', 'CUSTOMER'], financials: true, write: true },
  vendor:       { modules: ['DASHBOARD', 'MARKET_VEHICLE', 'TRIP'], financials: false, write: false },
  customer:     { modules: ['DASHBOARD', 'TRIP'], financials: false, write: false },
  driver:       { modules: ['DASHBOARD', 'TRIP', 'FUEL'], financials: false, write: false },
};
const capsFor = (user: AppUser): RoleCaps => MATRIX[norm(user?.role)] || MATRIX['operator'];

export function canAccessModule(user: AppUser, moduleId: string): boolean {
  const caps = capsFor(user);
  return caps.modules === '*' || caps.modules.includes(moduleId);
}
export function canSeeFinancials(user: AppUser): boolean { return capsFor(user).financials; }
export function canWrite(user: AppUser): boolean { return capsFor(user).write; }

// ── Data scope ──────────────────────────────────────────────────────────
export type ScopeType = 'all' | 'vendor' | 'customer' | 'driver';
export interface Scope { type: ScopeType; value: string }

export function scopeFor(user: AppUser): Scope {
  const r = norm(user?.role);
  if (r === 'vendor') return { type: 'vendor', value: user.vendor_name || user.full_name || user.name || '' };
  if (r === 'customer') return { type: 'customer', value: user.customer_name || user.full_name || user.name || '' };
  if (r === 'driver') return { type: 'driver', value: user.driver_name || user.full_name || user.name || '' };
  return { type: 'all', value: '' };
}

const FIELD_BY_SCOPE: Record<ScopeType, string[]> = {
  all: [],
  vendor: ['owner_name', 'vendor_name', 'vendor_agency', 'Operating_Company', 'operating_company'],
  customer: ['customer_name', 'Customer', 'Registered_Assessee'],
  driver: ['driver_name', 'Driver_Name'],
};

/** Filter a list of records to only those within the user's scope. */
export function scopeFilter<T extends Record<string, any>>(user: AppUser, records: T[]): T[] {
  const scope = scopeFor(user);
  if (scope.type === 'all') return records;
  const want = norm(scope.value);
  if (!want) return []; // scoped role with no scope value => see nothing (safe default)
  const fields = FIELD_BY_SCOPE[scope.type];
  return records.filter(r => fields.some(f => {
    const hit = Object.keys(r).find(k => norm(k) === norm(f));
    return hit && norm(r[hit]) === want;
  }));
}

/** One-line scope description for grounding Mamta AI / RAG. */
export function describeScope(user: AppUser): string {
  const s = scopeFor(user);
  if (s.type === 'all') return canSeeFinancials(user) ? 'full access (all data incl. financials)' : 'all operational data (no financials)';
  return `restricted to ${s.type} = "${s.value}" only`;
}

/** Should Mamta AI refuse this query for the user? (financial ask by non-finance role) */
export function shouldRefuseFinancial(user: AppUser, query: string): boolean {
  if (canSeeFinancials(user)) return false;
  return /profit|loss|p&l|pnl|revenue|ledger|balance ?sheet|bakaya|outstanding|payable|receivable|salary|income|expense|cash ?book|bank/i.test(query);
}

export const REFUSAL_HI = 'Maaf kijiye, ye jaankari aapke access me nahi hai.';

/** The logged-in user from localStorage (for UI-side scope filtering). */
export function currentUser(): AppUser | null {
  try { return JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem('prasad_user')) || 'null'); }
  catch { return null; }
}

/** Convenience: filter a list to the current user's scope (UI tables). */
export function scopeCurrent<T extends Record<string, any>>(records: T[]): T[] {
  const u = currentUser();
  return u ? scopeFilter(u, records) : records;
}
