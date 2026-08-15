// 🔎 RAG over ERP data — 100% local. Read-only: builds a local vector index
// from the ERP API and grounds Gemma 4 answers in retrieved ERP context.
//
// The embeddings and the vector store stay in the browser (IndexedDB); only the
// source rows come from PostgreSQL now. Each collection has its own endpoint
// and its own response key, so the map below is the whole difference between
// this and the old getDocs() loop.
import { llmComplete } from '../llm';
import { embed, embedBatch } from './embeddings';
import { buildDoc } from './documents';
import { putVectors, searchVectors, countVectors, clearVectors, type SearchHit } from './store';

import { API_BASE } from '../apiBase';
const API = API_BASE;

// Collections worth retrieving over (core entities first). The names are kept
// in their Firestore spelling because they are stored on every indexed vector
// and shown as the source label — renaming them would invalidate the index.
export const RAG_COLLECTIONS = ['TRIPS', 'VEHICLES', 'DRIVERS', 'LEDGERS'];

const SOURCES: Record<string, { url: string; key: string }> = {
  TRIPS:    { url: `${API}/api/v1/ops/trips?limit=1000`, key: 'trips' },
  VEHICLES: { url: `${API}/api/v1/masters/vehicles`,     key: 'vehicles' },
  DRIVERS:  { url: `${API}/api/v1/masters/drivers`,      key: 'drivers' },
  LEDGERS:  { url: `${API}/api/v1/finance/ledgers`,      key: 'ledgers' },
};

export interface IndexProgress { phase: string; done: number; total: number; }

/** Rebuild the local vector index from the ERP API. Read-only. */
export async function buildIndex(onProgress?: (p: IndexProgress) => void): Promise<{ indexed: number }> {
  await clearVectors();
  // 1) Read + build text docs
  const docs: ReturnType<typeof buildDoc>[] = [];
  for (const coll of RAG_COLLECTIONS) {
    onProgress?.({ phase: `Reading ${coll}`, done: 0, total: 0 });
    const src = SOURCES[coll];
    if (!src) continue;
    // One slow or missing endpoint should degrade the index, not abort the
    // whole rebuild and leave the store empty.
    try {
      const res = await fetch(src.url);
      if (!res.ok) continue;
      const json = await res.json();
      for (const row of (json[src.key] ?? [])) docs.push(buildDoc(coll, String(row.id), row));
    } catch { continue; }
  }
  // 2) Embed in batches, persisting as we go
  const now = Date.now();
  let done = 0;
  const CHUNK = 25;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const slice = docs.slice(i, i + CHUNK);
    const vecs = await embedBatch(slice.map(d => d.text));
    await putVectors(slice.map((d, j) => ({ ...d, vector: vecs[j], indexedAt: now })));
    done += slice.length;
    onProgress?.({ phase: 'Embedding', done, total: docs.length });
  }
  return { indexed: docs.length };
}

export async function ragStatus(): Promise<{ count: number }> {
  return { count: await countVectors() };
}

/** Retrieve the top-k most relevant ERP chunks for a query. */
export async function retrieve(query: string, k = 6, collections?: string[]): Promise<SearchHit[]> {
  const qVec = await embed(query);
  return searchVectors(qVec, k, collections);
}

const SYSTEM = `You are MAMTA AI, the assistant for PRASAD Transport ERP (petroleum logistics: HSD/MS/ATF/LPG; clients IOCL/HPCL/BPCL).
Answer the user's question using ONLY the ERP context provided. If the context does not contain the answer, say you don't have that record. Be concise. Reply in the user's language (Hindi/Hinglish or English). Never invent vehicle numbers, names, or amounts.`;

/** Retrieve ERP context and answer with Gemma 4. Streams tokens via onToken. */
export async function ragAnswer(
  query: string,
  onToken?: (t: string) => void,
  k = 6,
): Promise<{ answer: string; sources: SearchHit[] }> {
  const hits = await retrieve(query, k);
  const context = hits.map((h, i) => `[${i + 1}] ${h.text}`).join('\n');
  const answer = await llmComplete(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `ERP CONTEXT:\n${context}\n\nQUESTION: ${query}` },
    ],
    { temperature: 0.2 },
    onToken,
  );
  return { answer, sources: hits };
}
