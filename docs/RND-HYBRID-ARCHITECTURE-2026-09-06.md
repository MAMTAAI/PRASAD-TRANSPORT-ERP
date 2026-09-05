# Hybrid Architecture R&D — AWS Execution Node + Local Reasoning Centre
### Prasad Transport ERP · Das Mahavidya 10-Agent Swarm · 6 September 2026

> **Read-only audit.** Nothing in this report has been applied. Every command
> below is a proposal with its rollback. Measurements were taken live from
> `ubuntu@65.0.27.161` and from the repository at `3d3a1ad`.

---

## 0. Executive summary

| | |
|---|---|
| **Finding that changes the plan** | The AWS box has **1,905 MB of RAM, not 4 GB.** The "4 GB" is the *swapfile*. Real headroom today is ~931 MB. |
| **Largest single consumer** | Chrome, 399 MB (21% of RAM), owned by the WhatsApp engine. |
| **Already violating the constraint** | **Ollama is installed, enabled and running on AWS** (`gemma3:270m`, 291 MB on disk). 797 MB is already paged into swap. |
| **Dead intent found** | `OLLAMA_HEAVY_URL` / `OLLAMA_HEAVY_MODEL=deepseek-r1:14b` / `OLLAMA_HEAVY_CHAR_THRESHOLD` are set in the box's `.env` but **referenced nowhere in the codebase**. The offload was designed and never wired. |
| **Tunnel host** | `ollama.prasadtransport.com` resolves to Cloudflare and answers **HTTP 404** — the hostname is provisioned, nothing is behind it. |
| **Hard constraint discovered in code** | `BAGALAMUKHI` (AGENT_08) enforces the invariant `db_stays_loopback_or_vpc`. **The Local PC must never hold a Postgres connection.** This decides the bridge design. |
| **ApprovalQueue.tsx** | **Not pending — already mounted and live in production.** Evidence in §5. |
| **Recoverable RAM** | ~700–800 MB, roughly 40% of the box, without touching the ERP's function. |

---

## 1. AWS 4 GB (actually 2 GB) resource audit & pruning

### 1.1 Live inventory — measured, 6 Sep 19:09 IST

```
Mem:  1905 MB total   973 used   571 free   592 buff/cache   931 available
Swap: 4095 MB total   797 used            (swappiness 10)
CPU:  2 vCPU · load 0.04 · uptime 16 days
Disk: 28 G, 17 G used (59%) · DB 1,128 MB · node_modules 768 MB
Node v20.20.2 · PostgreSQL 18.6 · nginx · pm2 v7.0.3
```

| Process | RSS | Owner | Verdict |
|---|---:|---|---|
| `chrome` (renderer) | 246 MB | whatsapp-web.js | **MOVE** |
| `chrome` (browser) | 65 MB | whatsapp-web.js | **MOVE** |
| `chrome` (network utility) | 46 MB | whatsapp-web.js | **MOVE** |
| `chrome` (renderer 2) | 42 MB | whatsapp-web.js | **MOVE** |
| `prasad-erp-api` | 191 MB | `server/index.js` | **KEEP** (retune heap) |
| `prasad-ai-bridge` | 124 MB | `bridge.cjs` | **KEEP** (slim) |
| `pm2 Serve` | 49 MB | pm2 static server | **PRUNE if nginx serves dist** |
| `prasad-erp-web` | 48 MB | dist server | **PRUNE if nginx serves dist** |
| `prasad-wa-engine` | 39 MB | `whatsapp-server/server.js` | **MOVE** |
| `pm2 God daemon` | 37 MB | pm2 | keep |
| `ollama serve` | 13 MB idle | systemd | **REMOVE** (spikes 300–450 MB) |
| `postgres` backends | ~45 MB each | PostgreSQL | **KEEP** (retune) |

### 1.2 The arithmetic that will cause the next OOM

**pm2 restart ceilings are over-committed by 50%:**

| App | `max_memory_restart` |
|---|---:|
| prasad-erp-api | 1,200 MB |
| prasad-wa-engine | 900 MB |
| prasad-ai-bridge | 500 MB |
| prasad-erp-web | 250 MB |
| **Total** | **2,850 MB on a 1,905 MB box** |

If two apps approach their ceilings together, the **kernel OOM killer fires
before pm2's own limit ever triggers**. pm2 cannot protect a box whose limits
exceed its RAM.

**The API's V8 heap ceiling is larger than the machine:**
`--max-old-space-size=2048`. V8 only becomes aggressive about garbage
collection as it nears its ceiling, so the API will comfortably grow to 1.5 GB
— entirely into swap — before it tries hard to reclaim. This is the most
likely cause of the slow-death restarts already visible (`restarts=253`).

**Spikes that can legitimately coincide today:**

| Spike source | Cost | Gate today |
|---|---:|---|
| Chrome / WhatsApp baseline | 399 MB | none |
| Ollama loading `gemma3:270m` | 300–450 MB | none |
| `tesseract.js` OCR worker (WASM heap) | 150–250 MB | 1 at a time, floor `OCR_MIN_FREE_MB=220` ✅ |
| `pdfjs-dist` parsing an AC5 PDF | 100–200 MB | none |
| `xlsx` building the CA pack | 50–150 MB | none |
| **Realistic worst case** | **≈1.7 GB + baselines** | → swap thrash → OOM |

The OCR gate is the *only* one of these that is already defended. That defence
was written correctly and should be the model for the rest.

### 1.3 MUST REMOVE from AWS — ranked by MB recovered per unit of risk

**① Ollama — the constraint violation.** *Frees 291 MB disk, eliminates a
300–450 MB spike class.*

```bash
sudo systemctl disable --now ollama
sudo rm -rf /usr/share/ollama/.ollama/models    # 291 MB, after §3 is live
```
*Safe because the degradation path already exists and is tested:*
`server/services/universalScan.js` falls back to patterns-only, and
`src/lib/aiScanner.ts` falls back to `POST /api/v1/scan`. Both already handle a
dead engine — that is why scans kept working when nobody was running Ollama
locally.
**Rollback:** `sudo systemctl enable --now ollama`.

**② `AI_LOCAL_ENRICH=0` — stop *trying*.** Not set today, so
`universalScan.js:37` defaults to enabled and attempts a local call on every
scan, paying the connect/timeout cost each time.

```bash
echo 'AI_LOCAL_ENRICH=0' >> /var/www/prasad-erp/.env && pm2 restart prasad-erp-api
```

**③ Pin the model default — a latent 8 GB pull.** `server/ai/router.js:30`
defaults `LOCAL_AI_MODEL` to **`gemma4:12b`**, a model that cannot exist on this
box. Any code path reaching it on a machine *with* Ollama would attempt an 8 GB
download onto a disk with 12 GB free. Set `LOCAL_AI_MODEL=gemma3:270m`
explicitly until §3 moves the call off-box entirely.

**④ WhatsApp engine → Local PC. The single biggest win: ~438 MB (23% of RAM).**
`whatsapp-web.js` drives a full headless Chrome. Prior incident history already
records that *pairing failures on this box are usually RAM, not code.* Chrome
does not belong on a 2 GB machine.
*Sequenced in §4 Phase 3 — it carries the driver OTP path, so it moves with a
tested fallback, not first.*

**⑤ `mongoose` in the WhatsApp engine.** `whatsapp-server/server.js:15` imports
Mongoose. The ERP has been PostgreSQL-only since the Firestore migration; if it
is still dialling a MongoDB that no longer exists, it is holding a retry loop
open for nothing. `firebase-admin` sits in the same `package.json` and Firebase
is retired.
```bash
grep -n "mongoose.connect\|MONGO" whatsapp-server/server.js    # confirm first
```
**Verify before removing** — this is the one item in this list I could not
prove unused from the outside.

**⑥ Duplicate static serving — ~97 MB.** `prasad-erp-web` (48 MB) plus
`pm2 Serve` (49 MB) both exist while **nginx is already running**. If nginx has
a `root .../dist` block, both pm2 processes are redundant.
```bash
grep -rn "root.*dist\|try_files" /etc/nginx/sites-enabled/   # confirm first
pm2 delete prasad-erp-web && pm2 save                        # then
```

**⑦ Puppeteer's Chrome download.** After ④, `~/.cache/puppeteer` (several
hundred MB) can go from disk.

### 1.4 MUST RETUNE (not remove)

| Setting | Now | Proposed | Why |
|---|---:|---:|---|
| `prasad-erp-api` `--max-old-space-size` | 2048 MB | **512 MB** | Above physical RAM today; forces early GC instead of swap. |
| pm2 `max_memory_restart` api | 1,200 MB | **700 MB** | Sum of all ceilings must sit under ~1.4 GB. |
| pm2 `max_memory_restart` bridge | 500 MB | **250 MB** | Steady state is 124 MB. |
| PG `effective_cache_size` | **5 GB** | **900 MB** | Planner hint claiming 5 GB of cache on a 1.9 GB box → wrong plans, more random I/O. |
| PG `max_connections` | 100 | **30** | 100 × 4 MB `work_mem` = 400 MB of sort memory the box does not have. |
| PG `shared_buffers` | 160 MB | 160 MB | Correct at ~8% — leave it. |
| `GRAPH_CYCLE_MS` | 15,000 | 30,000 | Halves swarm wakeups; every node is independently `due()`-gated, so nothing is skipped. |

### 1.5 The AWS Execution Node role — the definition to hold the line on

> **AWS EC2 is a transaction recorder, not a thinker.**
> It may hold: **Node.js ERP API** (Fastify + the 12 self-gating scheduler
> jobs), **PostgreSQL** (loopback only), **nginx** (TLS + static dist), and the
> **Bridge/Webhook API** (`bridge.cjs`, inbound webhooks and the agent job
> endpoint).
> It may **never** hold: a model runtime, a browser, an unbounded OCR worker,
> or any process whose memory ceiling is not declared and summed.
>
> **The rule:** *the sum of all pm2 `max_memory_restart` values must stay below
> 75% of physical RAM.* Today: 2,850 / 1,905 = 150%. Target: ≤ 1,400 MB.

---

## 2. Local PC (32 GB) — the Heavy Processing Centre

### 2.1 What the PC is for

| Workload | Model / runtime | Peak RAM | Why it cannot live on AWS |
|---|---|---:|---|
| DeerFlow 2.0 orchestration | Python | 1–2 GB | Long-lived planner state |
| Deep reasoning | `deepseek-r1:14b` (q4) | ~9 GB | 4.7× the whole AWS box |
| Document vision / OCR | vision model + `tesseract` | 4–6 GB | Competes with the ERP for the same 900 MB |
| RAG embeddings + index | `nomic-embed-text` | 1–2 GB | Index rebuild is a batch job |
| Backtests / what-if | Node + Postgres **replica** | 2–4 GB | Never against the live books |
| WhatsApp engine (Chrome) | `whatsapp-web.js` | ~450 MB | The 23% of AWS RAM recovered in §1.3 ④ |
| **Total under load** | | **~20 GB of 32 GB** | leaves 12 GB headroom |

### 2.2 The ten agents — where each one belongs

The swarm runs as a **graph traversal** (`graphEngine.js`, default), not ten
timers; `AGENT_ENGINE=loop` falls back to `loopEngine.js`. The split below is by
*what the work actually costs*, not by seniority.

| # | Agent | Title | Cadence | Cost profile | **Runs on** |
|---|---|---|---:|---|---|
| 00 | **KAMALA** | Chief ERP Orchestrator | 15 s | Routing + reasoning | **PC** (as DeerFlow) — thin `route` node stays on AWS |
| 01 | **KALI** | Dispatch & Trip Execution | 10 s / mail 10 min | SQL + IMAP | **AWS** |
| 02 | **TARA** | Financial Auditor & Ledger Guard | 30 s | Pure SQL, double-entry | **AWS** — must stay next to the DB |
| 03 | **TRIPURA SUNDARI** | Bazaar Admin & Freight Rate Engine | 120 s | SQL + rate maths | **AWS** |
| 04 | **BHUVANESHWARI** | Data Vault & Document OCR Parser | 20 s / mail 10 min | **OCR + vision — heaviest** | **PC** ⭐ |
| 05 | **BHAIRAVI** | Compliance Guard & Risk Shield | 300 s | SQL date checks | **AWS** |
| 06 | **CHHINNAMASTA** | Fuel/HSD & Pump Settlement | 60 s | SQL + arithmetic | **AWS** |
| 07 | **DHUMAVATI** | Tyre & Vehicle Maintenance | 300 s | SQL | **AWS** |
| 08 | **BAGALAMUKHI** | Infra Hard-Halt & **AWS Reverse Tunnel Security Guard** | 30 s | Guard invariants | **AWS** — it *is* the tunnel's guard |
| 09 | **MATANGI** | CRM & Driver WhatsApp AI Assistant | 45 s | Chrome + drafting | **PC** ⭐ |

**Only three of ten agents move.** The other seven are SQL-bound and belong
beside the database — moving them would add a network hop to every ledger read
for no memory saving. This is the core insight of the split: *the swarm is not
uniformly heavy; two agents carry almost all of the weight.*

### 2.3 Local stack

```
Windows 32 GB
├─ Ollama            deepseek-r1:14b · a vision model · nomic-embed-text
├─ DeerFlow 2.0      master orchestrator = Maha Kamala-00
├─ agent-worker.mjs  outbound HTTPS pull loop (the only network client)
├─ WhatsApp engine   whatsapp-web.js + Chrome (after Phase 3)
└─ Postgres replica  read-only, for backtests only — never the live books
```

---

## 3. Hybrid bridging & DeerFlow 2.0 integration

### 3.1 Protocol decision

| Option | Verdict |
|---|---|
| **A. Reverse tunnel** (Cloudflare Tunnel / `autossh -R`) exposing PC-Ollama to AWS | **Secondary.** Fits `ollama.prasadtransport.com`, which already exists in DNS. But when the PC is off, every dependent request **fails hard** rather than waiting. |
| **B. gRPC** | **Rejected.** Requires an inbound listener and a proto layer; buys nothing over HTTPS+JSON at this volume, and adds a build step to a 2 GB box. |
| **C. Outbound job queue** — AWS writes a row, the PC polls over HTTPS, posts results back | **Primary.** No inbound port on the PC, survives a home NAT, a dynamic IP and a switched-off PC. **The ERP already works this way.** |

**Recommendation: C as the backbone, A only for synchronous scans.**

The decisive reason is a constraint found in the code, not a preference:
**BAGALAMUKHI enforces `db_stays_loopback_or_vpc`.** The Local PC therefore
**must never open a Postgres connection.** It talks to the API over HTTPS or it
does not talk at all. A pull queue is the only shape that satisfies this
without weakening the guard the swarm already enforces.

The second reason: **this pattern is already proven in production here.**
`partner_documents` carries `ocr_status` (PENDING → RUNNING → DONE / FAILED)
with a 10-minute sweep and a stale-RUNNING reclaim. That *is* a job queue with
lease semantics. Phase 2 generalises it rather than inventing anything.

### 3.2 The contract

```
AWS (producer)                          Local PC (consumer)
─────────────                           ───────────────────
agent_jobs row                          every 5 s, outbound HTTPS:
  kind: OCR_DOC | REASON | DRAFT_MSG      POST /api/v1/agent/jobs/claim
  payload / status / lease_until            → lease 1 job for 120 s
  attempts / result / error               run deepseek-r1 / vision locally
                                          POST /api/v1/agent/jobs/:id/result
                                            → result JSON + confidence
Never: Postgres from the PC.            Never: an inbound port on the PC.
```

Rules carried over from what already works here:

1. **A result is a proposal, never a posting.** Same rule BHUVANESHWARI's OCR
   already follows — the desk approves; the model never writes to the books.
2. **Leases, not locks.** A job whose `lease_until` has passed returns to
   PENDING. The PC can crash mid-job without stranding work.
3. **Degrade, don't fail.** If no worker claims within N minutes, AWS runs the
   deterministic path (tesseract + `docPatterns.js`) and marks the result
   `engine: patterns-only`. **The ERP never waits on the PC.**
4. **One token, one scope.** A dedicated `agent-worker` role limited to the two
   job endpoints. Not an admin token.

### 3.3 DeerFlow 2.0 as Maha Kamala-00

DeerFlow sits on the PC as the **planner**, and AWS keeps a **thin `route`
node**. The division:

- **AWS KAMALA `route`** — cheap triage: what happened, which agent owns it,
  does it need a model at all? Most events never leave the box.
- **PC DeerFlow KAMALA-00** — only for work that genuinely needs reasoning:
  fan-out across sub-agents, multi-document correlation, month-end anomaly
  review, backtests. It pulls its own jobs from the same queue and may enqueue
  follow-up jobs for BHUVANESHWARI or MATANGI.

Parallelism is bounded **on the PC, by the PC** — a worker concurrency of 2–3
against a 14B model on 32 GB. AWS is never asked to hold anything open while
the PC thinks, because the queue is asynchronous by construction.

---

## 4. Deployment roadmap — five phases, each reversible

Each phase ends with a verification and a rollback. **No phase depends on the
next one succeeding.**

### Phase 0 — Safety net *(30 min, zero risk)*
- Add a `MemoryMax=` systemd slice or pm2 ceiling **before** pruning, so a
  mistake restarts one app instead of OOM-killing Postgres.
- Snapshot: `pm2 save`, `cp .env .env.bak-$(date +%F)`, EBS snapshot.
- **Verify:** `pm2 resurrect` restores. **Rollback:** n/a — additive only.

### Phase 1 — Prune AWS *(1 hour, low risk, ~350 MB + 291 MB disk)*
1. `AI_LOCAL_ENRICH=0`, pin `LOCAL_AI_MODEL`.
2. `systemctl disable --now ollama`.
3. Retune the four pm2 ceilings and `--max-old-space-size=512`.
4. Retune `effective_cache_size` → 900 MB, `max_connections` → 30.
5. Confirm nginx serves `dist`; if yes, `pm2 delete prasad-erp-web`.
- **Verify:** `/api/v1/health` 200; a KYC scan still returns fields via
  patterns-only; `free -m` shows available > 1.2 GB; 24 h with no restart.
- **Rollback:** re-enable Ollama, `pm2 resurrect`, restore `.env.bak`.

### Phase 2 — Local PC stack *(half a day, no AWS change at all)*
1. Ollama + `deepseek-r1:14b` + vision + embeddings on the PC.
2. DeerFlow 2.0, pointed at a **local Postgres replica** for backtests.
3. `agent-worker.mjs` written but pointed at a **staging** job table.
- **Verify:** the worker claims and completes a synthetic job end-to-end.
- **Rollback:** stop the worker; AWS never knew it existed.

### Phase 3 — The bridge, one agent at a time *(1 day)*
1. Migration `176_agent_jobs.sql` — table, lease, indexes. **Additive only.**
2. Endpoints `claim` / `result` behind the `agent-worker` role.
3. **Migrate BHUVANESHWARI first** — highest memory saving, and its
   degradation path is already proven.
4. Watch a full week. Only then migrate MATANGI (and Chrome with it).
- **Verify:** OCR results still land as *proposals*; with the PC switched off,
  scans fall back to patterns-only and nothing queues indefinitely.
- **Rollback:** flip one env flag; the AWS sweep resumes.

### Phase 4 — WhatsApp engine to the PC *(half a day, highest care)*
Last, because it carries driver OTP. Move the engine, repoint `WA_ENGINE_URL`
at the tunnel, keep the AWS engine installed but stopped for one week.
- **Verify:** OTP delivery on a real handset before the AWS engine is removed.
- **Rollback:** restart the AWS engine, repoint to `127.0.0.1:5002`.

### Phase 5 — Reclaim *(after two clean weeks)*
Delete `~/.cache/puppeteer`, Ollama models, `mongoose`/`firebase-admin`.
Re-baseline. **Expected end state: ~600–700 MB used of 1,905 MB, no swap.**

---

## 5. ApprovalQueue.tsx — readiness confirmed

**It is not pending. It is mounted, built and live in production.**

| Check | Evidence |
|---|---|
| Component imported | `src/StaffPayroll.tsx:14` — `import ApprovalQueue from './payroll/ApprovalQueue'` |
| Rendered as the **default** tab | `src/StaffPayroll.tsx:45` — `{tab === 'QUEUE' && …<ApprovalQueue …/>}`, initial state `useState('QUEUE')` |
| Route registered | `src/App.tsx:66` lazy import, `:670` — `case 'STAFF_PAYROLL': return <StaffPayroll />` |
| Menu entry | `src/SIDEBAR.tsx` — *Staff & Partner Payroll* under Accounts & Admin |
| **In the deployed bundle** | `dist/assets/StaffPayroll-Cehtx4zL.js` contains "Approval Queue" |
| Bundle is current | `dist/index.html` built **5 Sep 18:57**; `.last-deployed-sha` = `3d3a1ad` = repo HEAD ✅ |
| Backend live | `/api/v1/payroll/approval-queue` answers 401 unauthenticated — mounted and guarded ✅ |

No action required. Reaching it: **Accounts & Admin → Staff & Partner Payroll**;
the Approval Queue is the tab that opens first.

---

## 6. What I need from you before Phase 1

1. **Confirm the box size.** The plan above is written for 1.9 GB. If you
   intended to *upgrade* to 4 GB (`t3.small` → `t3.medium`), say so — that
   changes the pruning list from "must" to "should", and it is ~₹1,400/month.
2. **Is `mongoose` in the WhatsApp engine live or dead?** I would not remove it
   on inference.
3. **Does nginx already serve `dist`?** If yes, two pm2 apps (~97 MB) go today.
4. **Local PC availability window.** If it sleeps at night, the queue design
   holds; a reverse tunnel alone would not.

---

## 7. One caution

The most valuable thing in this codebase is that **the degradation paths are
already written and tested** — the OCR memory gate, the patterns-only scan
fallback, the "proposal, never a posting" rule, `db_stays_loopback_or_vpc`.
The hybrid split works because it extends those, not because it adds
infrastructure. Any phase that requires *removing* one of those guards to make
the bridge work is the wrong phase — stop and re-plan instead.
