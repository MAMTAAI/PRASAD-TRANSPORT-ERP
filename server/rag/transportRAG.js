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
import { query, isDegraded } from '../db/pool.js';

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
export async function embed(text) {
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
  return json.embedding;
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
    try {
      vector = await embed(chunks[i]);
      embedded++;
    } catch { /* stored un-embedded; embedPending() will retry */ }
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
