// 🔌 FASTAG PROVIDERS — browser side of the multi-provider API integration
// (GTROPY, ICICI, SBI, Wheelseye, BlackBuck …). Live PostgreSQL, migration 033.
//
// SECRETS NEVER REACH THIS FILE. `auth_token` and `password` are masked by the
// API on every read, and writing the mask back is ignored server-side — so a
// provider can be edited from the UI without the browser ever holding a
// credential, and without an accidental save wiping one. The Node runner
// (toll-sync.cjs) reads the real values over a loopback PostgreSQL connection
// on the same host; nothing exposes them over HTTP.
//
// Pure normalization/adapters still live in tollParse.ts.
import { logAudit } from './audit';
import { PROVIDER_TEMPLATES } from './tollParse';

const API = (import.meta as any).env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300';
const TOLL = `${API}/api/v1/toll`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};
const jsonBody = (b: any): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
});

export const MASK = '••••••••';

export interface FastagProvider {
  id?: string;
  name: string;              // admin label ("Prasad GTROPY Corporate")
  type: string;              // 'gtropy' | 'icici' | 'sbi' | 'wheelseye' | 'blackbuck'
  base_url: string;
  auth_token?: string;       // secret — masked on read
  username?: string;
  password?: string;         // secret — masked on read
  company: string;           // ledger the tolls post under
  active: boolean;
  sync_window_days?: number; // how far back each sync looks (default 2)
  last_sync_at?: any;
  last_sync_result?: string;
  last_sync_error?: string;
}

const SECRET_FIELDS: (keyof FastagProvider)[] = ['auth_token', 'password'];

/** List providers. Secrets arrive already masked from the API. */
export async function listProviders(): Promise<FastagProvider[]> {
  const j = await fetchJson(`${TOLL}/providers`);
  return j.providers ?? [];
}

/** Create or update a provider.
 *  URL cleaning and the Bearer/Authorization strip now happen server-side, so
 *  the runner and this screen cannot disagree about what was actually stored. */
export async function saveProvider(p: FastagProvider): Promise<string> {
  const j = await fetchJson(`${TOLL}/providers`, jsonBody({
    id: p.id || null,
    name: (p.name || '').trim(),
    type: (p.type || 'gtropy').toLowerCase(),
    base_url: p.base_url || '',
    auth_token: p.auth_token || null,
    username: (p.username || '').trim(),
    password: p.password || null,
    company: p.company || 'PRASAD TRANSPORT',
    active: !!p.active,
    sync_window_days: Number(p.sync_window_days) > 0 ? Number(p.sync_window_days) : 2,
  }));
  const saved = j.provider;
  logAudit({ action: 'FASTAG_PROVIDER_SAVE', target: saved.name, details: `${saved.type} · ${saved.active ? 'ACTIVE' : 'paused'}` });
  return saved.id;
}

export async function toggleProvider(id: string, active: boolean): Promise<void> {
  await fetchJson(`${TOLL}/providers/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active }),
  });
  logAudit({ action: 'FASTAG_PROVIDER_TOGGLE', target: id, details: active ? 'ACTIVE' : 'paused' });
}

export async function deleteProvider(id: string): Promise<void> {
  await fetchJson(`${TOLL}/providers/${id}`, { method: 'DELETE' });
  logAudit({ action: 'FASTAG_PROVIDER_DELETE', target: id });
}

/** Trigger a one-off sync of all active providers. The runner polls this flag
 *  and clears it, so there is exactly one sync entry point for both the
 *  scheduled run and the operator's "Force Sync" button. */
export async function requestProviderSync(): Promise<void> {
  await fetchJson(`${TOLL}/settings/auto_sync`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force_sync_requested: true }),
  });
  logAudit({ action: 'FASTAG_PROVIDER_FORCE_SYNC', target: 'all_active' });
}

export interface FastagAccount {
  id: string;                // account_id
  account_id: string;
  vehicle_number?: string;
  balance: number;
  total_debit?: number;
  total_credit?: number;
  last_txn_at?: any;
  provider?: string;
  provider_type?: string;
}

/** Live per-account FASTag wallet balances (maintained by the runner). */
export async function listAccounts(): Promise<FastagAccount[]> {
  const j = await fetchJson(`${TOLL}/accounts`);
  return (j.accounts ?? []).map((a: any) => ({ ...a, id: a.account_id }));
}

export { PROVIDER_TEMPLATES };
