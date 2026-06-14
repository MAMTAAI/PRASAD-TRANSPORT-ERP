// 🗄️ IndexedDB-backed vector store. Persists embeddings locally (offline-safe);
// cosine search runs in-memory (fast for the ERP's ~1k vectors).
import { cosineSim } from './embeddings';
import type { RagDoc } from './documents';

const DB_NAME = 'prasad_rag';
const STORE = 'vectors';
const DB_VERSION = 1;

export interface StoredVec extends RagDoc {
  vector: number[];
  indexedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putVectors(items: StoredVec[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    items.forEach(it => os.put(it));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getAllVectors(): Promise<StoredVec[]> {
  const db = await openDB();
  const all = await new Promise<StoredVec[]>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as StoredVec[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return all;
}

export async function countVectors(): Promise<number> {
  const db = await openDB();
  const n = await new Promise<number>((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return n;
}

export async function clearVectors(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export interface SearchHit extends StoredVec { score: number; }

/** Top-k cosine matches for a query vector, optionally filtered by collection. */
export async function searchVectors(queryVec: number[], k = 6, collections?: string[]): Promise<SearchHit[]> {
  const all = await getAllVectors();
  const pool = collections?.length ? all.filter(v => collections.includes(v.collection)) : all;
  return pool
    .map(v => ({ ...v, score: cosineSim(queryVec, v.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
