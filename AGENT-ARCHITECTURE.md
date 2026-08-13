# Prasad Transport ERP — 10-Agent Mahavidya Swarm

**Domain:** logistics, freight and fleet management. Petroleum tanker haulage
(HSD, MS, ATF) for IOCL and comparable customers, out of Assam depots.

**Isolation:** this swarm is scoped to Prasad Transport only. It shares no
database, no event channel and no agent with Jaiswal Capital. The two systems
co-reside on one AWS box (see `deploy/aws/`) and share nothing above the OS.

**Stack:** Node.js + Fastify · PostgreSQL (local dev → AWS RDS) · S3 for
documents · PM2 behind Nginx.

---

## 1. Deep analysis findings

Read from `src/` (36,839 lines across 96 files), `server/db/migrations/`, and the
2026-06-14 production snapshot (27 collections).

### Real operational scale

| Entity | Live rows | Largest owning module |
|---|---:|---|
| Trips | 552 | `TripManagment.tsx` (1,402 lines) |
| Ledger entries | 220 | `LedgerMgmt.tsx` |
| Fuel (HSD) entries | 217 | `FuelMgmt.tsx` |
| RTKM lane masters | 179 | `LocationRtkmMaster.tsx` |
| Driver transactions | 112 | `DRIVER.tsx` |
| Ledgers | 106 | `CashBankBook.tsx` |
| Vehicle assignments | 52 | `Vehical.tsx` |
| Vehicles | 50 | `Vehical.tsx` |
| Drivers | 49 | `DRIVER.tsx` |
| Vendor txns / Loans / Vendors | 18 / 17 / 13 | `Vander.tsx`, `LoanEmiMgmt.tsx` (1,489 lines) |

### What the data actually tells us

A single `RTKM_MASTER` row carries the whole commercial model of a lane:

```
Customer   INDIAN OIL CORPORATION LTD
Depot      LUMDING TERMINAL (7T04) -> MOHANBARI AFS 7A09
Capacity   40 KL (18 Wheeler)        Item   ATF (Aviation)
RTKM       838.3 km                  Fixed_HSD 280 L    Fixed_Cash Rs.2000
```

Three engines fall directly out of that, and all three are now agent-owned:

1. **Cost floor** = `Fixed_HSD x pump rate + Fixed_Cash + Toll`. Any rate below
   it loses money — TRIPURA SUNDARI refuses to quote there.
2. **Expected mileage** = `838.3 / 280` ≈ **2.99 km/L**. Actual consumption
   outside a tolerance band is pilferage or a leaking tank — CHHINNAMASTA's
   anomaly detector.
3. **Compliance gate.** ATF/HSD loads legally require a live hazardous-goods
   endorsement, and `capacity_kl` is the overload ceiling — BHAIRAVI's veto.

### Pre-existing assets the swarm reuses rather than rewrites

Building these again would have been the biggest available mistake:

| Asset | Size | Now owned by |
|---|---|---|
| `src/lib/accounting/posting.ts` | 7 posting rules, full chart of accounts | TARA |
| `src/lib/accounting/journal.ts` | `validateEntry`, `reconcile`, balances | TARA |
| `src/lib/billScanner.ts` | document classify + extract | BHUVANESHWARI |
| `src/lib/tollParse.ts` | 30 KB toll/FASTag parser | BHUVANESHWARI |
| `SETTINGS.masterPrompt` | tuned "Mamta AI" extraction prompt, live in DB | BHUVANESHWARI |
| `src/lib/freightEngine.ts` | freight computation | TRIPURA SUNDARI |
| `security.cjs` | SOC store, `killState`/`setKill`, ban evaluation | BAGALAMUKHI |
| `whatsapp-server/` :5001 | hardened session + watchdog | MATANGI |
| `src/lib/agents/orchestrator.ts` | MAMTA AI LLM tool-loop with HITL | *see §5* |

### Data defects the relational schema makes unrepresentable

Found in the live snapshot — these are real, not hypothetical:

1. **`TRIPS` stores the vehicle number three ways**: `Vehical_No` (typo),
   `Vehicle_No`, and `vehicle_no`. Same drift on `Trip_ID`/`trip_id`,
   `Loaded_Qty`/`loaded_qty`, `Unloading_Date`/`unloading_date`.
2. **`RTKM_MASTER` duplicates every field** in PascalCase and snake_case
   (`Fixed_HSD` + `fixed_hsd`, `RTKM_Distance` + `rtkm_distance`).
3. **`LEDGERS` field drift**: `ledger_name`/`name`, `group_head`/`group`,
   `opening_balance`/`op_balance`.
4. **Registration numbers stored inconsistently spaced** (`"AS 19C 8666"`), so
   one truck can exist as two master records.
5. **`USERS.password` is a plaintext field.**
6. **Every date is a string**, so "what expires in 30 days" means reading the
   whole collection into the browser.

Items 1–3 are why the loaders must coalesce field names; 4–6 are fixed by
`001_core.sql` (`vehicle_no_norm` unique index, `password_hash` only, `date`
columns with partial indexes).

---

## 2. Event-driven architecture

```
   API request / clerk action / OCR result
                  |
                  v
   +----------------------------------+
   |  agent_events  (outbox table)    |   <-- durable, transactional
   +----------------------------------+
                  | AFTER INSERT trigger
                  v
        pg_notify('prasad_agent_events', {id, event_type})
                  |
     +------------+------------+          reaches EVERY API instance
     v                         v
  instance A               instance B
  LISTEN + poll            LISTEN + poll
     |                         |
     v                         v
  claim_agent_events(10)  -- FOR UPDATE SKIP LOCKED
     |                         |
     |  exactly one instance wins each event
     v
  registry.dispatch(event)
     |
     +--> subscribed agents, in roster order
     |      each run recorded in agent_runs (OK/SKIPPED/BLOCKED/ERROR)
     |
     +--> bus.emit('agent:run', ...)   Node EventEmitter, for live dashboards
```

### Why an outbox rather than bare LISTEN/NOTIFY

`NOTIFY` alone was rejected on three counts:

- **It is fire-and-forget.** No listener connected at that instant means the
  event is gone. Unacceptable when the event is *"trip settled, post the freight
  to the ledger"*.
- **8000-byte payload cap.** So the notification carries `{id, event_type}` only
  and the agent reads the row. Payload size stops being a design constraint.
- **No retry, no audit, no dead-letter.** A durable row gives all three.

`emit()` accepts a `tx` parameter. Anything ₹-affecting **must** pass it, which
puts the event in the same transaction as the business write — either both land
or neither does. That is the transactional-outbox guarantee, and it is the thing
Firestore could not offer at all.

### Delivery semantics

- **At-least-once**, not exactly-once. Agents must be idempotent; `agent_runs`
  has a unique index on `(event_id, agent_id) WHERE outcome = 'OK'`, so a
  redelivered event cannot double-post through an agent that already succeeded.
- **A poll runs alongside LISTEN** (`AGENT_POLL_MS`, default 5s). `NOTIFY` is
  delivered at most once, so a notify landing during a listener reconnect is
  lost; the poll makes delivery eventual rather than best-effort.
- **5 attempts, then `DEAD`.** A poison event becomes visible at
  `GET /api/agents/ops/dead-letters` instead of spinning forever.

### Concurrency control

`pg_advisory_xact_lock(namespace, hashtext(id))`, held by KAMALA
(`withAggregateLock`). Two operators settling one trip concurrently would each
read a stale balance and post twice. The advisory lock serialises them and
releases automatically when the transaction ends — a lock *table* would leak a
held lock if the process died mid-write.

---

## 3. The ten fixed roles

Roles are **declared in code and enforced at boot**, not described in prose.
`defineAgent()` validates each declaration; `initSwarm()` refuses to start if two
agents own the same table; `agentEmit()` throws if an agent emits an event
outside its declared `emits`.

| # | Agent | Codename | Owns (exclusive write) | Hard guards |
|---|---|---|---|---|
| 00 | Chief ERP Orchestrator | **KAMALA** | `agent_events`, `agent_runs` | 3 |
| 01 | Dispatch & Trip Execution | **KALI** | `trips`, `trip_legs`, `trip_gps_pings` | 4 |
| 02 | Financial Auditor & Ledger Guard | **TARA** | `ledgers`, `ledger_entries`, `journal`, `invoices`, `payments`, `trip_settlements` | 5 |
| 03 | Bazaar Admin & Freight Rate Engine | **TRIPURA SUNDARI** | `rtkm_master`, `rate_master`, `bazaar_loads`, `bids`, `market_vehicles` | 4 |
| 04 | Data Vault & Document OCR | **BHUVANESHWARI** | `documents`, `document_extractions`, `email_parsed_bills` | 4 |
| 05 | Compliance Guard & Risk Shield | **BHAIRAVI** | `compliance_checks`, `compliance_violations` | 5 |
| 06 | Fuel/HSD & Pump Settlement | **CHHINNAMASTA** | `fuel_entries`, `pump_settlements`, `fuel_price_history` | 4 |
| 07 | Tyre & Vehicle Maintenance | **DHUMAVATI** | `tyres`, `tyre_fitments`, `batteries`, `maintenance_jobs`, `spares_inventory` | 4 |
| 08 | Infra Hard-Halt & Tunnel Guard | **BAGALAMUKHI** | `agent_halts`, `infra_health_checks` | 5 |
| 09 | CRM & Driver WhatsApp AI | **MATANGI** | `notifications`, `wa_*` | 5 |

37 owned tables, 51 event types, zero ownership conflicts.

### The four structural rules

These are what stop a ten-agent swarm from degenerating into ten agents that all
write `trips`:

1. **One writer per table.** Enforced at boot. TARA alone writes ledgers.
2. **KAMALA owns no business table.** An orchestrator with its own domain data
   becomes a second source of truth.
3. **BAGALAMUKHI touches no business table at all** — not even read. The kill
   switch must not be able to corrupt what it protects.
4. **MATANGI has no financial authority.** WhatsApp is exactly where that
   authority must not exist: a spoofed message must never release cash. Driver
   advances become *proposals*; a human approves and TARA posts.

### Canonical flow — dispatch to settlement

```
load.assigned                    (API / TRIPURA SUNDARI)
  -> KALI: compliance.clearance.requested
       -> BHAIRAVI checks licence, hazmat, 5 vehicle docs, overload, assignment
            -> denied  => KALI blocked, trip never leaves PENDING
            -> granted => trip proceeds
  -> trip.unloading.recorded      (clerk)
       -> KALI: shortage beyond tolerance => trip.shortage.detected
       -> KALI: trip.completed
            -> CHHINNAMASTA: mileage vs RTKM allowance => fuel.mileage.anomaly
            -> MATANGI: POD notification queued to customer
  -> trip.settlement.requested    (operator)
       -> KAMALA: halt check, then advisory lock, then settlement.authorised
            -> TARA: FOR UPDATE, verify COMPLETED, post balanced voucher,
                     mark SETTLED, request invoice
                 -> MATANGI: invoice dispatched
```

Note what KALI cannot do: price the load, post the shortage penalty, or mark the
trip `SETTLED`. Note what BHAIRAVI's denial does: it is final, and not even
KAMALA may override it.

---

## 4. Zero-divergence rule (TARA)

The existing browser-side `validateEntry()` checks `ΣDr === ΣCr` in JavaScript
floats, and a caller can simply not call it. Server-side, correctness moves into
the database:

- Balance becomes a **deferred constraint** in `003_ledger.sql`, so an
  unbalanced voucher cannot exist even if every line of application code is
  wrong.
- `NUMERIC` is parsed as a **string** in `server/db/pool.js`, so a 15-digit
  rupee value never passes through a float.
- Sums are computed **in SQL**, exactly — summing 220+ entries in JS floats
  accumulates error.
- `ledger_entries` is **append-only**. A correction is a reversing entry, never
  an edit.
- A detected imbalance **halts the entire swarm** via BAGALAMUKHI rather than
  letting further postings pile onto a broken book.

---

## 5. Relationship to the existing MAMTA AI orchestrator

`src/lib/agents/orchestrator.ts` already runs a Gemma-4 tool-calling loop with
RBAC scoping, memory recall and human-in-the-loop pending writes. It is **not**
replaced and **not** duplicated. The two occupy different layers:

| | MAMTA AI (existing) | Mahavidya swarm (new) |
|---|---|---|
| Runs in | browser | server |
| Trigger | a human asking a question | a committed database event |
| Nature | probabilistic, LLM-driven | deterministic business rules |
| Authority | read-only + HITL proposals | owns writes within its table scope |

The intended composition: MAMTA AI becomes a **client** of the swarm. Its tools
in `src/lib/agents/tools.ts` (currently `agent: 'Operations' | 'Analytics'`,
hitting Firestore directly) get repointed at the agent APIs. The LLM then keeps
its HITL discipline while the deterministic guards become unbypassable — an LLM
cannot talk BHAIRAVI into clearing an expired licence, because clearance is SQL,
not a prompt.

---

## 6. Files delivered

```
server/agents/
  base.js            defineAgent() contract + validation + outcome helpers
  bus.js             LISTEN/NOTIFY <-> EventEmitter, claim/drain, retry, DLQ
  registry.js        roster load, boot validation, dispatch, readiness
  selftest.js        20 boundary assertions, runs with no database
  kamala.js  (00)    orchestrator + withAggregateLock()
  kali.js    (01)    TRIP_FLOW state machine + canTransition()
  tara.js    (02)    POSTING_RULES + settlement + zero-divergence audit
  tripura.js (03)    cost-floor rate engine
  bhuvaneshwari.js (04)  OCR proposal pipeline
  bhairavi.js (05)   compliance veto — fully implemented, 1 query, 5 guards
  chhinnamasta.js (06)  slip arithmetic + mileage-vs-RTKM anomaly
  dhumavati.js (07)  tyre serial lifecycle + cost-per-km
  bagalamukhi.js (08)  halt switch, wraps security.cjs
  matangi.js  (09)   WhatsApp CRM, advance proposals

server/db/
  pool.js                       local -> RDS failover, degraded mode, NUMERIC-as-string
  migrate.js                    forward-only runner with checksum drift detection
  migrations/001_core.sql       companies, users, vehicles, drivers, assignments
  migrations/002_agent_events.sql  outbox, NOTIFY trigger, agent_runs, agent_halts

server/modules/
  vehicles.routes.js   reference CRUD module
  agents.routes.js     roster, role cards, health, DLQ, event injection, halt/resume

scripts/pg-bootstrap.ps1   detect -> start -> install -> create role/db -> migrate
```

### Commands

```bash
npm run agents:test      # 20 boundary assertions (no DB needed)
npm run agents:roster    # roster table with live PARKED/ACTIVE state
npm run db:bootstrap     # local PostgreSQL setup
npm run db:migrate
npm run api              # http://127.0.0.1:3300
```

---

## 7. Readiness

All ten agents are **PARKED**, which is the correct and honest state: their
declarations are validated and their guards are written, but the tables they
require do not exist yet. `POST /api/agents/ops/refresh-readiness` flips them to
ACTIVE without a restart once migrations land.

| Agent | Blocked on |
|---|---|
| BHAIRAVI (05) | **nothing but a running PostgreSQL** — `001_core.sql` covers it |
| KAMALA (00), BAGALAMUKHI (08) | `002_agent_events.sql` applied |
| KALI (01) | `003_dispatch.sql` — `trips` |
| TARA (02) | `004_ledger.sql` — `ledgers`, `ledger_entries` |
| TRIPURA SUNDARI (03) | `003_dispatch.sql` — `rtkm_master`, `rate_master` |
| CHHINNAMASTA (06) | `003_dispatch.sql` — `fuel_entries` |
| BHUVANESHWARI (04) | `005_documents.sql` |
| DHUMAVATI (07) | `006_maintenance.sql` |
| MATANGI (09) | `007_crm.sql` |

BHAIRAVI is deliberately the reference implementation — it is the one agent whose
dependencies are fully satisfied by migration 001, so its clearance logic is
written in full (a single query covering all five guards) rather than declared
and parked.

### Not yet verified

`001_core.sql` and `002_agent_events.sql` have **never been executed**. There is
no PostgreSQL and no Docker on this machine, so the SQL is authored and reviewed
but unproven. Everything that does not need a database *is* verified: 20/20
self-test assertions pass, all ten agents load with zero ownership conflicts, and
the API boots and serves the roster in degraded mode.
