// 🔌 FASTAG PROVIDERS — browser/Firestore side of the multi-provider API
// integration (GTROPY, ICICI, SBI, Wheelseye, BlackBuck …). Credentials live
// in FASTAG_PROVIDERS (admin-only per firestore.rules); the Node background
// runner (toll-sync.cjs) reads active providers via the Admin SDK and fetches
// their transactions. Pure normalization/adapters live in tollParse.ts.
import {
  collection, doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';
import { logAudit } from './audit';
import { PROVIDER_TEMPLATES } from './tollParse';

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

/** List providers with secrets masked (never send raw creds to the UI). */
export async function listProviders(): Promise<FastagProvider[]> {
  const snap = await getDocs(collection(db, 'FASTAG_PROVIDERS'));
  return snap.docs.map(d => {
    const data = d.data() as FastagProvider;
    for (const f of SECRET_FIELDS) if (data[f]) (data as any)[f] = MASK;
    return { id: d.id, ...data };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Create/update a provider. Masked secrets are never written back (so the UI
 *  can safely echo the mask); only freshly-typed secrets overwrite. */
export async function saveProvider(p: FastagProvider): Promise<string> {
  // Strip wrapping quotes AND any pasted ?query string (users often copy the
  // whole curl URL) — the runner appends its own start_time/end_index params,
  // so a leftover query string would produce duplicate keys → provider 500.
  const cleanUrl = (u: string) => {
    const s = String(u || '').trim().replace(/^['"]+|['"]+$/g, '').trim();
    if (!s) return '';
    try { const url = new URL(s); return `${url.origin}${url.pathname}`; } catch { return s; }
  };
  const payload: any = {
    name: (p.name || '').trim(),
    type: (p.type || 'gtropy').toLowerCase(),
    base_url: cleanUrl(p.base_url),
    username: (p.username || '').trim(),
    company: p.company || 'PRASAD TRANSPORT',
    active: !!p.active,
    sync_window_days: Number(p.sync_window_days) > 0 ? Number(p.sync_window_days) : 2,
    updatedAt: serverTimestamp(),
  };
  for (const f of SECRET_FIELDS) {
    let v = ((p[f] as string) || '').trim();
    if (f === 'auth_token') v = v.replace(/^Authorization:\s*/i, '').replace(/^Bearer\s+/i, '').trim();
    if (v && v !== MASK) payload[f] = v;   // only overwrite when a real value typed
  }
  let id = p.id;
  if (id) {
    await updateDoc(doc(db, 'FASTAG_PROVIDERS', id), payload);
  } else {
    payload.createdAt = serverTimestamp();
    id = (await addDoc(collection(db, 'FASTAG_PROVIDERS'), payload)).id;
  }
  logAudit({ action: 'FASTAG_PROVIDER_SAVE', target: payload.name, details: `${payload.type} · ${payload.active ? 'ACTIVE' : 'paused'}` });
  return id!;
}

export async function toggleProvider(id: string, active: boolean): Promise<void> {
  await updateDoc(doc(db, 'FASTAG_PROVIDERS', id), { active, updatedAt: serverTimestamp() });
  logAudit({ action: 'FASTAG_PROVIDER_TOGGLE', target: id, details: active ? 'ACTIVE' : 'paused' });
}

export async function deleteProvider(id: string): Promise<void> {
  await deleteDoc(doc(db, 'FASTAG_PROVIDERS', id));
  logAudit({ action: 'FASTAG_PROVIDER_DELETE', target: id });
}

/** Trigger a one-off sync of all active providers (background runner picks the
 *  flag up within ~30s). Reuses the same TOLL_SETTINGS/auto_sync flag the
 *  legacy "Force Sync" button uses, so there is a single sync entry point. */
export async function requestProviderSync(): Promise<void> {
  await setDoc(doc(db, 'TOLL_SETTINGS', 'auto_sync'),
    { force_sync_requested: true, updatedAt: serverTimestamp() }, { merge: true });
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
  const snap = await getDocs(collection(db, 'FASTAG_ACCOUNTS'));
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
    .sort((a, b) => (a.vehicle_number || a.account_id || '').localeCompare(b.vehicle_number || b.account_id || ''));
}

export { PROVIDER_TEMPLATES };
