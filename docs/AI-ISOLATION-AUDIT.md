# AI isolation audit — Prasad Transport vs Jaiswal Capital

Audited 2026-08-16 against the live local environment.

## Answer: NO

The two companies' AI is **not** isolated. It is one engine, one gateway
process, and one database file, logically partitioned by an auth token. That
partition is real and enforced, but it is a permission check inside a shared
system, not two independent systems.

---

## What is actually shared

| | |
|---|---|
| **Inference engine** | One Ollama at `localhost:11434`. Prasad's `.env` points at it (`VITE_LLM_PROVIDER=ollama`, `VITE_LLM_MODEL=gemma4:12b`); Jaiswal's tree references `11434` in 20 places. One process, one model in VRAM, one queue. |
| **Gateway** | One `bridge.cjs` on `:3000`. Its own comments say so: `PT_BRIDGE_TOKEN=<prasad-token>,<jaiswal-token>` and "index doubles as the client identity: 0 = Prasad Transport, 1 = Jaiswal Capital". Jaiswal's tree references `mamta-bridge` 106 times. |
| **Knowledge graph** | One SQLite file, `data/mamta-kg.db`, inside the **Prasad** repo. It holds a `domain` column. Right now it contains **25 nodes and 26 edges, all `trading`** — Jaiswal Capital's knowledge, stored in Prasad's project directory. |
| **Capacity** | Shared by construction. A long Jaiswal generation occupies the GPU that a Prasad request then waits behind. There is no per-tenant quota. |

## What is genuinely isolated

Credit where due — the tenancy control is not naive:

- **Domain is fixed by the authenticated token, not by the caller.** `bridge.cjs`
  strips any client-supplied `kg_domain` and denies a cross-tenant
  `X-KG-Domain`, so a transport token cannot read trading facts. Retrieval is
  correctly partitioned.
- **API keys are already separate.** Prasad uses local Ollama
  (`OLLAMA_BASE_URL`, `VITE_LLM_*`); Jaiswal uses `ANTHROPIC_API_KEY` and
  `GEMINI_API_KEY` in `E:\jaiswal-terminal\.env`. No cloud AI key is shared.
- **There is no `DEEPSEEK_API_KEY` in either project.** Nothing to separate.
- **No shared chat history table** was found; conversation state is per-app.

So: **context and retrieval are isolated. Compute, process, storage file, and
failure domain are not.**

---

## The bit that collides with the drive-separation rule

`data/mamta-kg.db` currently holds *only* Jaiswal trading data, and it lives
inside `E:\PRASAD-TRANSPORT-ERP`. Moving that repo to `F:\` puts Jaiswal
Capital's knowledge graph on the Prasad drive — breaking the F:/H: rule in the
same operation that is supposed to enforce it. Splitting the graph has to
happen before, or as part of, that move.

---

## What "zero cross-contamination" would require

1. **Two Ollama instances** — a second on `11435` with its own `OLLAMA_MODELS`,
   or accept that compute is shared and say so explicitly. (Note: two 12B models
   resident at once needs the VRAM headroom to exist; on a 12 GB RTX 3060 that
   is the binding constraint, not the software.)
2. **Two bridge processes** — one per tenant, one token each, different ports.
   Deleting the multi-token allowlist is what makes the separation structural
   rather than conditional.
3. **Two knowledge-graph files** — `mamta-kg-transport.db` on `F:\`,
   `mamta-kg-trading.db` on `H:\`. The `domain` column then becomes redundant,
   which is the point: isolation you cannot misconfigure.
4. **Split `bridge.cjs`** out of the Prasad repo, or vendor a copy per side, so
   neither company's deploy can change the other's AI gateway.

Items 2-4 are mechanical. Item 1 is a hardware judgement.

Until those are done, the honest statement is: *shared engine, enforced tenant
partition* — which is a reasonable architecture, but it is not two independent
entities, and it should not be described to anyone as if it were.
