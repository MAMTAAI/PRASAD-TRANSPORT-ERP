// 🧠 Mamta AI Memory (Phase 14.1) — 100% local. Short-term (session) + long-term
// (vector, IndexedDB) memory, namespaced per agent + shared 'org', RBAC-scoped.
// Lives in its OWN IndexedDB DB (separate from operational data + RAG vectors);
// ADD-ONLY semantics (dedupe = update existing, never deletes ops data).
import { embed, cosineSim } from '../rag/embeddings';
import { scopeFor, type AppUser } from '../rbac';

const DB_NAME = 'prasad_memory';
const STORE = 'memories';
const DB_VERSION = 1;
const DEDUPE_SIM = 0.92; // near-duplicate threshold => update instead of insert

export interface MemoryItem {
  id: string;
  namespace: string;      // agent namespace, or 'org' for shared
  text: string;
  vector: number[];
  scope: string;          // 'all' | vendor/customer/driver name (RBAC tag)
  kind: string;           // 'fact' | 'preference' | 'outcome' | 'conversation'
  created_at: number;
  updated_at: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('namespace', 'namespace', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function allInNamespaces(namespaces: string[]): Promise<MemoryItem[]> {
  const db = await openDB();
  const all = await new Promise<MemoryItem[]>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as MemoryItem[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return all.filter(m => namespaces.includes(m.namespace));
}

async function put(item: MemoryItem): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function newId(ns: string): string {
  // deterministic-ish unique id without Math.random/Date in workflow-safe code
  return `${ns}_${Date.now().toString(36)}_${Math.floor(performance.now() % 1e6).toString(36)}`;
}

export interface RememberOpts { namespace: string; text: string; scope?: string; kind?: string; }
/** Write a salient fact to long-term memory. Dedupes: a near-identical memory
 *  in the same namespace is UPDATED (text+vector refreshed), not duplicated. */
export async function remember(opts: RememberOpts): Promise<{ id: string; updated: boolean }> {
  const text = String(opts.text || '').trim();
  if (!text) throw new Error('empty memory');
  const vector = await embed(text);
  const existing = await allInNamespaces([opts.namespace]);
  let best: { m: MemoryItem; sim: number } | null = null;
  for (const m of existing) {
    const sim = cosineSim(vector, m.vector);
    if (!best || sim > best.sim) best = { m, sim };
  }
  const now = Date.now();
  if (best && best.sim >= DEDUPE_SIM) {
    const upd = { ...best.m, text, vector, updated_at: now };
    await put(upd);
    return { id: upd.id, updated: true };
  }
  const item: MemoryItem = {
    id: newId(opts.namespace), namespace: opts.namespace, text, vector,
    scope: opts.scope || 'all', kind: opts.kind || 'fact', created_at: now, updated_at: now,
  };
  await put(item);
  return { id: item.id, updated: false };
}

export interface RecallOpts { namespace: string; query: string; k?: number; user?: AppUser; }
/** Retrieve top-k relevant memories from the namespace + shared 'org', filtered
 *  by the user's RBAC scope (never recall data outside their permission). */
export async function recall(opts: RecallOpts): Promise<Array<MemoryItem & { score: number }>> {
  const qv = await embed(opts.query);
  const pool = await allInNamespaces([opts.namespace, 'org']);
  const scope = opts.user ? scopeFor(opts.user) : { type: 'all', value: '' };
  const want = String(scope.value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const visible = pool.filter(m => {
    if (m.scope === 'all' || scope.type === 'all') return true;
    return String(m.scope || '').toLowerCase().replace(/[^a-z0-9]/g, '') === want;
  });
  return visible
    .map(m => ({ ...m, score: cosineSim(qv, m.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.k ?? 5);
}

/** Admin-only: clear a namespace (explicit; never automatic). */
export async function forget(namespace: string): Promise<number> {
  const items = await allInNamespaces([namespace]);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    items.forEach(m => os.delete(m.id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
  return items.length;
}

// ── Short-term (session) memory — rolling buffer per namespace ────────────
const STM_MAX = 12;
export function stmPush(namespace: string, role: 'user' | 'assistant', text: string): void {
  try {
    const key = `mamta_stm_${namespace}`;
    const buf = JSON.parse(sessionStorage.getItem(key) || '[]');
    buf.push({ role, text, t: Date.now() });
    sessionStorage.setItem(key, JSON.stringify(buf.slice(-STM_MAX)));
  } catch { /* ignore */ }
}
export function stmGet(namespace: string): Array<{ role: string; text: string }> {
  try { return JSON.parse(sessionStorage.getItem(`mamta_stm_${namespace}`) || '[]'); }
  catch { return []; }
}
export function stmClear(namespace: string): void {
  try { sessionStorage.removeItem(`mamta_stm_${namespace}`); } catch { /* ignore */ }
}
