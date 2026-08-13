-- ═══════════════════════════════════════════════════════════════════════════
-- 003_okf_rag_documents.sql — OKF long-term memory · RAG store · document vault
--
-- Three concerns, one migration, because they share a lifecycle: the OCR
-- auto-filer writes documents + extractions, the RAG engine indexes them, and
-- OKF LTM records what the agents concluded about them.
--
-- Applying this migration un-parks BHUVANESHWARI (04): `documents` and
-- `document_extractions` are its declared requires.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════
-- OKF_LTM — long-term memory, agent-scoped.
--
-- STM lives in-process (server/memory/okf.js); this is the durable half.
-- Facts, audit summaries, trend snapshots and scan verdicts survive restarts
-- and are queryable by agent, kind, and recency.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE okf_ltm (
  id          bigserial PRIMARY KEY,
  agent_id    text NOT NULL,              -- 'AGENT_04' etc.; 'SYSTEM' for shared facts
  kind        text NOT NULL,              -- 'audit' | 'trend' | 'scan_meta' | 'decision' | 'fact'
  mem_key     text,                       -- optional stable key for upsert-style facts
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  importance  smallint NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,                -- NULL = keep forever

  CONSTRAINT okf_ltm_payload_is_object CHECK (jsonb_typeof(payload) = 'object')
);
-- One live value per (agent, key) for keyed facts; history preserved by
-- expiring the old row instead of deleting it.
CREATE UNIQUE INDEX okf_ltm_keyed_uniq ON okf_ltm (agent_id, mem_key)
  WHERE mem_key IS NOT NULL AND expires_at IS NULL;
CREATE INDEX okf_ltm_recall_idx ON okf_ltm (agent_id, kind, created_at DESC);
CREATE INDEX okf_ltm_expiry_idx ON okf_ltm (expires_at) WHERE expires_at IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- DOCUMENTS — every artefact that enters the ERP (owned by BHUVANESHWARI).
-- The file itself lives on disk/S3; this row is the system of record for it.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_id     text UNIQUE,
  doc_type      text NOT NULL DEFAULT 'UNKNOWN',   -- EWAY_BILL | BILTY_POD | FUEL_SLIP | DL | RC | FASTAG | SPARES_BILL | ...
  original_name text,
  mime_type     text,
  byte_size     integer CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256        text NOT NULL,             -- dedupe + evidence integrity
  storage_path  text NOT NULL,             -- local uploads/ path now, s3:// later
  uploaded_by   text,
  status        text NOT NULL DEFAULT 'RECEIVED'
                CHECK (status IN ('RECEIVED','EXTRACTED','REVIEW','FILED','REJECTED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- The same physical file uploaded twice is the same document.
CREATE UNIQUE INDEX documents_sha_uniq ON documents (sha256);
CREATE INDEX documents_type_idx   ON documents (doc_type, created_at DESC);
CREATE INDEX documents_status_idx ON documents (status) WHERE status IN ('RECEIVED','REVIEW');
CREATE TRIGGER documents_touch BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
-- DOCUMENT_EXTRACTIONS — what the OCR engine read, and how sure it was.
-- One document can be re-parsed; each pass is a new row. Human corrections set
-- human_verified and win over any later parse (BHUVANESHWARI's guard).
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE document_extractions (
  id             bigserial PRIMARY KEY,
  document_id    uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  engine         text NOT NULL,            -- 'ollama:gemma4' | 'anthropic:haiku' | 'human'
  fields         jsonb NOT NULL DEFAULT '{}'::jsonb,  -- invoice_no, gstin, vehicle_no, ...
  confidence     numeric(4,3) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  validation     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- per-entity DB verification results
  auto_filed     boolean NOT NULL DEFAULT false,
  filed_event_id bigint,                   -- agent_events.id when auto-filed
  human_verified boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT extraction_fields_is_object CHECK (jsonb_typeof(fields) = 'object')
);
CREATE INDEX extractions_doc_idx    ON document_extractions (document_id, created_at DESC);
CREATE INDEX extractions_review_idx ON document_extractions (created_at DESC)
  WHERE auto_filed = false AND human_verified = false;

-- ═══════════════════════════════════════════════════════════════════════════
-- RAG_CHUNKS — embedded knowledge for the transport RAG loop.
--
-- Embeddings stored as jsonb float arrays, cosine-scored in Node. Deliberate:
-- pgvector is not guaranteed on the target RDS instance, and the corpus
-- (rate cards, regulations, document text) is thousands of chunks, not
-- millions — exact scan beats an index at this size. Swap to pgvector later
-- without changing the table's logical shape.
-- ═══════════════════════════════════════════════════════════════════════════
CREATE TABLE rag_chunks (
  id          bigserial PRIMARY KEY,
  namespace   text NOT NULL DEFAULT 'transport',  -- 'transport' | 'regulations' | 'rate_cards'
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  source      text NOT NULL,               -- human-readable origin
  chunk_no    integer NOT NULL DEFAULT 0,
  content     text NOT NULL,
  embedding   jsonb,                       -- float[] from nomic-embed-text; NULL = pending
  embed_model text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rag_chunks_ns_idx      ON rag_chunks (namespace, created_at DESC);
CREATE INDEX rag_chunks_pending_idx ON rag_chunks (id) WHERE embedding IS NULL;
CREATE UNIQUE INDEX rag_chunks_source_uniq ON rag_chunks (namespace, source, chunk_no);

COMMIT;
