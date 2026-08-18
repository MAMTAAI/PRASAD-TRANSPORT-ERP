// server/rag/transportRAG.js
// ─────────────────────────────────────────────────────────────────────────────
// Transport RAG engine — parsing, embedding and retrieval over the documents
// the ERP actually holds: E-Way bills, RCs, rate cards, transport regulations,
// and extracted OCR text.
//
// Embeddings come from the local Ollama instance (nomic-embed-text — the model
// already configured in .env as VITE_LLM_EMBED_MODEL). Vectors are stored as
// jsonb float arrays in rag_chunks and cosine-scored in Node: the corpus is
// thousands of chunks, not millions, so an exact scan is both simpler and
// faster than maintaining a pgvector dependency the RDS target may not have.
//
// Strictly transport-domain: the namespace whitelist below is the boundary.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { query, isDegraded } from '../db/pool.js';
import { attempt } from '../lib/zeroGap.js';

const OLLAMA = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const EMBED_MODEL = process.env.RAG_EMBED_MODEL ?? process.env.VITE_LLM_EMBED_MODEL ?? 'nomic-embed-text';
const NAMESPACES = new Set(['transport', 'regulations', 'rate_cards', 'documents']);

// ── Chunking ────────────────────────────────────────────────────────────────
// Paragraph-first, sentence-fallback. Bilty text and regulation clauses are
// short; 900 chars with 120 overlap keeps a clause intact within one chunk.
export function chunkText(text, { size = 900, overlap = 120 } = {}) {
  const clean = String(text).replace(/\r/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      // Prefer to break on a paragraph, then a sentence, then a space.
      const window = clean.slice(start, end);
      const brk = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf(' '));
      if (brk > size * 0.4) end = start + brk + 1;
    }
    chunks.push(clean.slice(start, end).trim());
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

// ── Embedding ───────────────────────────────────────────────────────────────
//
// EVERY CALL WENT TO OLLAMA, INCLUDING THE ONES IT HAD ALREADY ANSWERED.
// An embedding is a pure function of (model, text): the same chunk re-indexed
// after an edit elsewhere in the document, the same question asked twice, a
// re-run of the backfill — all paid the full round trip again, and each costs
// GPU time the OCR worker and the enrichment pass are also queueing for.
//
// Two layers, both keyed by a hash of model+text so a model change can never
// serve a stale vector:
//   MEMORY  bounded LRU, instant, lost on restart
//   DISK    JSON per vector under the data volume, survives restarts and the
//           nightly backfill, which is where the repetition actually is
//
// Bounded on purpose. An unbounded cache in a long-lived API process is a leak
// with a friendly name; at 2000 entries × ~768 floats this is a few tens of MB.
const EMBED_CACHE_MAX = Number.parseInt(process.env.RAG_EMBED_CACHE_MAX ?? '2000', 10);
const EMBED_CACHE_DIR = process.env.RAG_EMBED_CACHE_DIR
  ?? join(process.env.LOCAL_STORAGE_PATH || 'F:/Prasad_Transport_Data', 'cache', 'embeddings');
const memCache = new Map();
const embedStats = { hits_mem: 0, hits_disk: 0, misses: 0, errors: 0 };

const cacheKey = (text) =>
  createHash('sha256').update(`${EMBED_MODEL}\u0000${text}`).digest('hex');

function memGet(key) {
  if (!memCache.has(key)) return null;
  // Re-insert to make this the most-recently-used entry.
  const v = memCache.get(key);
  memCache.delete(key);
  memCache.set(key, v);
  return v;
}
function memPut(key, vec) {
  memCache.set(key, vec);
  if (memCache.size > EMBED_CACHE_MAX) memCache.delete(memCache.keys().next().value);
}

export async function embed(text) {
  const key = cacheKey(text);
  const hot = memGet(key);
  if (hot) { embedStats.hits_mem++; return hot; }

  const file = join(EMBED_CACHE_DIR, key.slice(0, 2), `${key}.json`);
  try {
    const vec = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(vec) && vec.length) { embedStats.hits_disk++; memPut(key, vec); return vec; }
  } catch { /* not cached yet, or unreadable — recompute */ }

  embedStats.misses++;
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    signal: AbortSignal.timeout(Number.parseInt(process.env.RAG_EMBED_TIMEOUT_MS ?? '20000', 10)),
  });
  if (!res.ok) throw new Error(`embedding failed: ${res.status} ${await res.text().catch(() => '')}`);
  const json = await res.json();
  if (!Array.isArray(json.embedding) || !json.embedding.length) {
    throw new Error('embedding response carried no vector');
  }

  memPut(key, json.embedding);
  // Persisting must never fail the caller: a cache that can break the thing it
  // was added to speed up is not worth having.
  void mkdir(dirname(file), { recursive: true })
    .then(() => writeFile(file, JSON.stringify(json.embedding)))
    .catch(() => { embedStats.errors++; });

  return json.embedding;
}

export function embedCacheStats() {
  const total = embedStats.hits_mem + embedStats.hits_disk + embedStats.misses;
  return {
    ...embedStats,
    entries_in_memory: memCache.size,
    max_in_memory: EMBED_CACHE_MAX,
    hit_rate: total ? Number((((embedStats.hits_mem + embedStats.hits_disk) / total) * 100).toFixed(1)) : null,
    model: EMBED_MODEL,
    disk: EMBED_CACHE_DIR,
  };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ── Ingest ──────────────────────────────────────────────────────────────────

/**
 * Ingest a text into a namespace. Idempotent per (namespace, source): re-ingest
 * replaces the old chunks, so an updated rate card does not leave stale clauses
 * behind to be retrieved alongside the new ones.
 *
 * Embeddings are computed best-effort: if Ollama is down the chunks are stored
 * with NULL embeddings and picked up later by embedPending().
 */
export async function ingest({ namespace = 'transport', source, text, documentId = null }) {
  if (!NAMESPACES.has(namespace)) throw new Error(`namespace '${namespace}' is outside the transport domain`);
  if (!source || !text) throw new Error('ingest needs source and text');
  if (isDegraded()) throw new Error('database degraded — cannot ingest');

  const chunks = chunkText(text);
  await query(`DELETE FROM rag_chunks WHERE namespace = $1 AND source = $2`, [namespace, source]);

  let embedded = 0;
  for (let i = 0; i < chunks.length; i++) {
    let vector = null;
    // Storing un-embedded is a legitimate fallback — but silently is not. If
    // the embedder has been down all week, the retrieval quality is degraded
    // and only this row will say so.
    vector = await attempt({
      process: 'rag.embed', kind: 'AI_FAILURE', severity: 'LOW',
      title: 'Embedding unavailable — chunks stored without vectors',
      action: 'Check Ollama is running, then run embedPending() to backfill.',
      subjectType: 'rag', subjectId: source,
      context: { namespace, source, chunk: i },
    }, () => embed(chunks[i]), null);
    if (vector) embedded++;
    await query(
      `INSERT INTO rag_chunks (namespace, document_id, source, chunk_no, content, embedding, embed_model)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [namespace, documentId, source, i, chunks[i], vector ? JSON.stringify(vector) : null, vector ? EMBED_MODEL : null]
    );
  }
  return { chunks: chunks.length, embedded };
}

/** Embed chunks that were stored while Ollama was unreachable. */
export async function embedPending(limit = 50) {
  if (isDegraded()) return 0;
  const { rows } = await query(
    `SELECT id, content FROM rag_chunks WHERE embedding IS NULL ORDER BY id LIMIT $1`,
    [limit]
  );
  let done = 0;
  for (const row of rows) {
    try {
      const vector = await embed(row.content);
      await query(`UPDATE rag_chunks SET embedding = $2::jsonb, embed_model = $3 WHERE id = $1`,
        [row.id, JSON.stringify(vector), EMBED_MODEL]);
      done++;
    } catch {
      break; // engine still down; stop burning the queue
    }
  }
  return done;
}

// ── Retrieve ────────────────────────────────────────────────────────────────

/**
 * Retrieve the k most relevant chunks for a question. Scans up to `candidates`
 * newest embedded chunks in the namespace — exact cosine over a bounded set.
 */
export async function retrieve(question, { namespace = 'transport', k = 5, candidates = 2000 } = {}) {
  if (isDegraded()) return { context: [], degraded: true };

  const qv = await embed(question);
  const { rows } = await query(
    `SELECT id, source, chunk_no, content, embedding
       FROM rag_chunks
      WHERE ($1::text = 'transport' OR namespace = $1)  -- 'transport' queries all transport-domain namespaces
        AND embedding IS NOT NULL
      ORDER BY created_at DESC
      LIMIT $2`,
    [namespace, candidates]
  );

  const scored = rows
    .map((r) => ({
      id: r.id,
      source: r.source,
      chunk_no: r.chunk_no,
      content: r.content,
      score: cosine(qv, typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return { context: scored, degraded: false };
}

/** Corpus stats for telemetry. */
export async function ragStats() {
  if (isDegraded()) return { degraded: true, chunks: 0, pending: 0 };
  const { rows } = await query(
    `SELECT count(*)::int AS chunks,
            count(*) FILTER (WHERE embedding IS NULL)::int AS pending,
            count(DISTINCT source)::int AS sources
       FROM rag_chunks`
  );
  return { degraded: false, ...rows[0] };
}

export default { chunkText, embed, ingest, embedPending, retrieve, ragStats };
