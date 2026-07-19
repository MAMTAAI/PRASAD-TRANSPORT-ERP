# PRASAD TRANSPORT ERP — System Audit Report

**Date:** 2026-07-18 · **Branch:** `upgrade-2026` · **Scope:** full codebase (~23,000 lines, 42 modules, `src/lib` AI stack, servers, build config)
**Method:** 4 parallel deep audits — Architecture/Performance, UI/UX Responsiveness, Hygiene/Security, AI Modules. Every finding verified against source with file:line evidence.

---

## Executive Summary

The ERP is functionally rich and the local-AI foundation (Ollama + Gemma, real RAG with nomic embeddings, streaming LLM layer) is genuinely well-architected. But the audit found **four systemic problems** that must drive the modernization plan:

1. **Security is effectively absent.** There is no real authentication — "login" is a client-side Firestore query against plaintext passwords, a hardcoded `admin` bypass accepting any password ships in the production bundle, the OTP flow accepts any 4 digits, and no Firestore security rules exist in the repo. The entire business database (ledgers, payroll, customer data, plaintext passwords) is effectively world-readable/writable via the public API key. Live SMTP passwords and Google API keys are committed to git history.
2. **The data layer will not scale.** The full `TRIPS` collection is downloaded with no filter/limit by 11 different modules, refetched after every mutation, in sequential await-waterfalls, with zero caching. At thousands of trips this is thousands of billed reads per screen visit.
3. **Zero render optimization.** Not a single `useMemo`, `useCallback`, or `React.memo` exists in the app. Heavy financial aggregations run in render bodies on every keystroke. All 35 modules ship in one 2.3 MB JS chunk with no code-splitting.
4. **Mobile is rescued by a brittle CSS hammer.** Only 1 of 42 modules uses the `useIsMobile` hook; a global attribute-selector override layer in `App.css` masks most sins — but fixed-width modals in Trip Management are clipped and unusable on phones, which is the shipped Android APK experience.

Plus one **crashing bug**: `WhatsappDashboard.tsx` references an undefined variable (`activeChatPhoneView`) — selecting any trip in TRIP CHAT throws a `ReferenceError` and crashes the tab (masked by `@ts-nocheck`).

---

## 🔴 SECTION 1 — SECURITY (act first)

| # | Severity | Finding | Location |
|---|---|---|---|
| S1 | Critical | No Firebase Auth anywhere. Login = client-side Firestore query matching **plaintext passwords** stored in `USERS` | `src/Login.tsx:54`, `src/UGER.tsx:317`, `src/firebase.ts` |
| S2 | Critical | Hardcoded master-key bypass: `admin@prasad.com` / `admin` gets ADMIN role with **any password**; no DEV guard; credentials pre-filled in the form | `src/Login.tsx:19-20, 37-50` |
| S3 | Critical | OTP login is fake — `setTimeout` send, no verification, UI literally says "Any 4 digits". Customer & Fleet Partner portals (billing, KYC, Aadhaar) open to anyone | `src/Login.tsx:79-104, 241` |
| S4 | Critical | Session = unauthenticated `localStorage.prasad_user` blob; RBAC is 100% client-side; any visitor can self-grant Super Admin in DevTools | `src/App.tsx:70-79`, `src/lib/rbac/index.ts` |
| S5 | Critical | No `firestore.rules` / `storage.rules` in repo; `firebase.json` has no firestore section. DB is effectively `allow read, write: if true` (nothing else could work without auth tokens) | `firebase.json` |
| S6 | Critical | **Live SMTP passwords committed to git** (3 accounts incl. company support mailbox) | `test-email.cjs:8,12,16` |
| S7 | High | Hardcoded Google TTS + Gemini API keys in tracked server files | `bridge.cjs:23`, `whatsapp-server/server.js:156` |
| S8 | High | AI write tools (`create_trip`, `add_ledger_entry`) exposed to every chat user with unvalidated model-supplied args; AI ledger entries bypass the double-entry `JOURNAL` | `src/lib/agents/tools.ts:148-204` |
| S9 | High | WhatsApp module posts full message text + phone numbers to an unauthenticated `prasad-api.onrender.com` endpoint every 3s — contradicts the "local-only, no bridge" architecture | `src/WhatsappDashboard.tsx:86,144,175` |
| S10 | Medium | `.env` committed to git (Maps key + OAuth client ID in permanent history); `.gitignore` doesn't list it | `.env`, `.gitignore` |
| S11 | Medium | Service-account keys sitting in repo tree (`google-key.json`, `whatsapp-server/serviceAccountKey.json`) — not tracked, but one `git add -f` from leaking | repo root |
| S12 | Medium | Wide-open CORS on bridge, whatsapp-server, and Cloud Functions | `bridge.cjs:11`, `whatsapp-server/server.js:12`, `functions/index.js:4` |
| S13 | Medium | Aadhaar collected as free text, stored raw in a world-readable DB (PII at rest) | `src/DriverPortal.tsx:553` |

**Immediate (this week):** rotate all 5 leaked credentials (S6, S7) — they are live in git history today regardless of any other fix.

---

## 🟠 SECTION 2 — ARCHITECTURE & PERFORMANCE

### Data fetching (Firestore)

| # | Severity | Finding | Location |
|---|---|---|---|
| A1 | Critical | Full `TRIPS` collection fetched with no `where`/`limit` by **11 modules**; no pagination anywhere. `BillManagement.tsx:98` is the lone correct example (`where("billing_status","==","PENDING")`) | `Dashboard.tsx:111`, `TripManagment.tsx:120`, `LodingDetals.tsx:108`, `UnlodingDetals.tsx:25`, `FinancialReports.tsx:107`, `CashBankBook.tsx:153`, `WhatsappDashboard.tsx:81` (as realtime listener!), +4 more |
| A2 | High | Sequential await-waterfalls: Dashboard does **9 sequential** `getDocs`; LedgerMgmt ~15 (and fetches VEHICLES **twice**, lines 85 & 134) | `Dashboard.tsx:105-128`, `LedgerMgmt.tsx:74-158`, `FinancialReports.tsx:83-127` |
| A3 | High | Every mutation triggers a full refetch of all collections (one field edit = thousands of reads) | `TripManagment.tsx:260,308,400,433`, `LodingDetals.tsx:286,396,428` |
| A4 | High | Bulk updates loop `await updateDoc` per doc — non-atomic, N round trips; mid-loop failure leaves vendor balances inconsistent | `TripManagment.tsx:73-75, 369-389` |
| A5 | Medium | 10 unbounded realtime listeners + 3s HTTP polling in WhatsApp module; WA_LOGS/WA_CHATS grow forever, re-sorted client-side per snapshot | `WhatsappDashboard.tsx:71-99` |
| A6 | Medium | No Firestore persistent local cache (`initializeFirestore` + `persistentLocalCache` would serve repeat reads from IndexedDB) | `src/firebase.ts:20` |
| A7 | Medium | Identical fetch+normalize logic copy-pasted across ≥5 modules; field-name chaos (`vehicle_no || Vehical_No || vehical_no`) papered over at every read site | `Dashboard.tsx:27`, `TripManagment.tsx:10`, `FinancialReports.tsx:10`, … |
| A8 | Medium | Dashboard refetches all 9 collections whenever the module tab changes (data doesn't depend on the tab) | `Dashboard.tsx:94-97` |
| A9 | Medium | Client-side max-ID scan generates LR/trip numbers — two concurrent users → duplicate LR numbers | `LodingDetals.tsx:72-103`; also `tools.ts:150` (5-digit random trip ID, ~50% collision odds by ~350 trips) |

### React rendering

| # | Severity | Finding | Location |
|---|---|---|---|
| R1 | Critical | FinancialReports: O(ledgers × entries) double-nested aggregation runs **in the render body, twice, un-memoized** — re-executes on every keystroke of the vehicle search box | `FinancialReports.tsx:177-215, 234-248, 423-428` |
| R2 | High | Dashboard: all fleet analytics (trip partitions, finance aggregation, 6-month trend, expiry scans) recompute on every keystroke of the AI chat input because chat state lives in the same 1,179-line component | `Dashboard.tsx:144-552, 1171` |
| R3 | High | TripManagment: per-row O(rtkmMaster × regex) lookups inside the table map, re-run per keystroke of global search | `TripManagment.tsx:438-472, 819` |
| R4 | High | **Zero** `useMemo`/`useCallback`/`React.memo` app-wide (verified by grep); no child can ever bail out of re-render | all of `src/` |
| R5 | Medium | LedgerMgmt: same nested render-body aggregation pattern | `LedgerMgmt.tsx:258-393` |
| R6 | Medium | Modal/history tables render every row, no virtualization/pagination (all completed trips ever, ×12+ cells) | `TripManagment.tsx:879`, `LodingDetals.tsx:971`, `Dashboard.tsx:999` |

### Bundle & app shell

| # | Severity | Finding | Location |
|---|---|---|---|
| B1 | Critical | All 35 modules eagerly imported → single **2.3 MB** chunk (`dist/assets/index-*.js`); PWA precache cap raised to 10 MB to accommodate it; public website/login pay for the whole back office | `App.tsx:5-48`, `vite.config.ts:13` |
| B2 | High | recharts (~400 KB) in the boot chunk though RBAC denies finance to most roles | `FinancialReports.tsx:7`, `LedgerMgmt.tsx:8` |
| B3 | Medium | Hand-rolled `useState` "router": no URLs/deep-links/back button; every navigation unmounts + remounts + refetches everything; 200ms setTimeout double-render per switch | `App.tsx:96-102, 226-295` |
| B4 | Low | `AdminDashboard.tsx` is entirely hardcoded dummy data, shipped in the production bundle | `AdminDashboard.tsx:13-31` |

---

## 🟡 SECTION 3 — UI/UX & MOBILE

Context: the app relies on a global `[style*=...]` attribute-selector override layer (`App.css:16-72`) + `overflow-x: hidden` on body. It works today but silently breaks the moment inline styles change. Only `WhatsappDashboard` uses `useIsMobile`. The Capacitor Android app means every ≤600px finding is the **default APK experience**.

| # | Severity | Finding | Location |
|---|---|---|---|
| U1 | Critical | TripManagment modals: fixed `width: 800px` / `850px` / `450px`, pad-less overlay, no `maxWidth`. With body overflow hidden, Track/Route, Fuel Memo, and Pay Driver modals are **centered and clipped with no way to reach the hidden half** on phones | `TripManagment.tsx:502-504, 602` |
| U2 | High | Master Fleet Command time-range control (Today/15/30/All) has no `flexWrap` — buttons clipped and unreachable on ≤400px | `Dashboard.tsx:698-707` |
| U3 | High | AI chat FAB (`bottom: 30px`, fix fires only ≤480px) sits on top of the app's bottom nav across 481–1024px, covering the CRM tab | `Dashboard.tsx:574,606-609` vs `App.tsx:385` |
| U4 | High | Touch targets far below 40px on money-action buttons: DRIVER WhatsApp btn ~20px tall, LoanEmi Edit/Delete ~24px, BazaarAdmin "Award Load" ~22px, LodingDetals 5-button pill row ~29px each | `DRIVER.tsx:500`, `LoanEmiMgmt.tsx:1015`, `BazaarAdmin.tsx:260`, `LodingDetals.tsx:986-998` |
| U5 | Medium | Finance Hub branch of Dashboard has **zero** responsive CSS (36px fixed headings, 38px KPI numbers, unrescued tables) — the responsive `<style>` block only renders in the ops branch | `Dashboard.tsx:300-380` |
| U6 | Medium | BRANCH/UGER modals hard-code `350px 1fr` grid → right pane becomes a ~160px sliver on ~601px tablets (the CSS hammer misses this pattern) | `BRANCH.tsx:196`, `UGER.tsx:289` |
| U7 | Medium | `minmax(400px, 1fr)` grids intrinsically overflow <400px, saved only by the global hammer | `BazaarAdmin.tsx:189`, `LedgerMgmt.tsx:457`, `VehicleMaintenance.tsx:216` |
| U8 | Medium | Custom bar-chart values are hover-only (`title` attr) — unreadable on touch; bars 18px wide | `Dashboard.tsx:341-342` |
| U9 | Medium | `viewport-fit=cover` missing while the shell uses `env(safe-area-inset-bottom)` → inset evaluates to 0 on notched devices | `index.html:5` |
| U10 | Low | Dead `src/index.css` contains template CSS (`#root { width: 1126px }`) that would break the app if ever imported; external images (Wikimedia, Wix) break offline in the APK | `index.css:53`, `Dashboard.tsx:17,21,809` |

**Good citizens to copy:** WhatsappDashboard (hook-driven), FinancialReports/LedgerMgmt (recharts inside `ResponsiveContainer` — correct), AdminDashboard/CustomerPortal/FleetPartnerPortal (Tailwind responsive classes), App shell (hamburger, off-canvas sidebar, bottom nav).

---

## 🟢 SECTION 4 — CODE HYGIENE

| # | Severity | Finding | Location |
|---|---|---|---|
| H1 | High | Silent `.catch(() => {})` on **accounting writes**: bill saved but double-entry `postEntry` fails silently → bill exists with no journal entry, nobody told. Same on EMI payment deletions | `BillManagement.tsx:34`, `LoanEmiMgmt.tsx:420,485-486`, `FinancialReports.tsx:49` |
| H2 | Medium-High | 200+ `parseFloat` money fields with no NaN/negative guards — `parseFloat('') → NaN` propagates into ledger balances and Firestore docs | `TripManagment.tsx` (37 sites), `TyreMgmt.tsx` (24), `BillManagement.tsx` (23), … |
| H3 | Medium | `// @ts-nocheck` in **38 of ~40** tsx files — TypeScript effectively disabled (this is what hid the WhatsApp crash bug) | app-wide |
| H4 | Medium | 348 `window.alert` + 38 `confirm()` as the universal error/success channel | peak: `TyreMgmt.tsx` (41) |
| H5 | Medium | No GST/PAN/mobile validation anywhere (only `.toUpperCase()`); Aadhaar free-text | `Customer.tsx:387`, `COMPANY.tsx`, `DriverPortal.tsx:553` |
| H6 | Medium | Server deps (`express`, `cors`, `multer`, `nodemailer`, `googleapis`, `dotenv`, npm `stream` shim) in the **frontend** package.json; `@google/generative-ai` still present despite local-AI architecture; `react-quill@2` unmaintained w/ XSS advisories | `package.json` |
| H7 | Low-Medium | 106 console statements across 35 files; several log full Firestore error objects in financial flows | `LoanEmiMgmt.tsx` (12), … |
| H8 | Low | Dead files: `LooKerAnalytics.tsx`, `calendaeService.js` (zero references); root-level ad-hoc scripts tracked; `.firebase/` deploy cache + `.wwebjs_cache` HTML committed | repo root |
| H9 | Low | Naming debt: `LodingDetals`, `UnlodingDetals`, `Vehical`, `Vander`, `UGER`, `TripManagment` — safe to rename since imports centralize in `App.tsx` | `src/` |
| H10 | Low | God components: `LoanEmiMgmt` 1,489 lines, `TyreMgmt` 1,190, `Dashboard` 1,179; zero shared form/table components | `src/` |

---

## 🔵 SECTION 5 — AI / SMART MODULES

### Verdict

The `src/lib` stack is the strongest code in the repo: real streaming provider abstraction with 12b→e4b fallback and offline classification, genuine local RAG (nomic-embed-text 768-dim vectors in IndexedDB, cosine top-k), human-in-the-loop write proposals, and code-side arithmetic validation in the bill scanners (`FuelMgmt.tsx:284`, `GstMgmt.tsx:22` — correct pattern). The problems are integration gaps and three fake "AI" surfaces.

### Bugs & gaps

| # | Severity | Finding | Location |
|---|---|---|---|
| AI1 | **Critical** | `activeChatPhoneView` referenced but never defined (declared as `activePhoneToView`) — selecting a trip in TRIP CHAT throws `ReferenceError` and crashes the tab | `WhatsappDashboard.tsx:185 vs 293,295,308-311` |
| AI2 | High | No conversation history ever sent — every question is turn 1. The STM buffer built for this (`stmPush`/`stmGet`, capped 12 turns) is **dead code, zero callers**. ~10-line fix enables multi-turn | `MamtaChat.tsx:93`, `lib/memory/index.ts:126-142` |
| AI3 | High | `buildIndex` wipes the vector index **before** rebuilding — Ollama dying mid-build leaves an empty index; no delta indexing; no staleness indicator (trips created by Mamta's own `create_trip` are invisible until manual "Refresh Index") | `lib/rag/index.ts:16-17` |
| AI4 | High | Auto-remember self-poisoning: every Q→A persisted and re-injected into the **system prompt** as fact — "TRP-123 is IN_TRANSIT" recalled as truth next week; 👎-rated answers still remembered | `lib/agents/orchestrator.ts:44-49, 61-65` |
| AI5 | High | Bill scanner reads **page 1 only** of PDFs, then autofills the total into ledger reconciliation — multi-page pump bills silently short by every later page | `lib/aiScanner.ts:83-98`, `FuelMgmt.tsx:275-305` |
| AI6 | High | Memory/search RBAC is substring matching on chunk text against a client-editable localStorage role — driver "Ram" matches "Ramnagar"; cosmetic at best | `lib/memory/index.ts:99-104`, `lib/agents/tools.ts:55-60` |
| AI7 | Medium | `num_ctx` never set → Ollama default (2-4k); agent loop (system + memory + 5 tool rounds, `search_erp` returns 8 chunks, full tool results un-truncated at `orchestrator.ts:92`) silently truncates early context — exactly where the "don't invent data" rules live | `lib/llm/providers/ollama.ts:25-35` |
| AI8 | Medium | 120s timeout not reset on token arrival → long generations abort mid-stream AND the catch handler **replaces** the streamed partial with the error text | `ollama.ts:56-61`, `MamtaChat.tsx:111-117` |
| AI9 | Medium | No cancellation: `ChatOptions.signal` supported end-to-end in the provider but never passed by any UI; unmount leaves GPU burning | `MamtaChat.tsx:78-119` |
| AI10 | Medium | Single global model toggle — switching to e4b for fast chat silently degrades **vision bill extraction** too; no per-task routing despite both models installed | `lib/llm/config.ts:40` |
| AI11 | Medium | Scanner fallback `JSON.parse` inside catch is itself unprotected (greedy regex can grab malformed spans → uncaught throw); `_lowConfidence` only flags **empty** fields — wrong plate/date/qty formats pass silently; `Number("20.000 KL") → NaN` can write literal `"NaN"` into `Loaded_Qty` | `aiScanner.ts:54,69,118-128`, `LodingDetals.tsx:233` |
| AI12 | Medium | `llmHealth()` hardcodes `primaryInstalled: true` — AiSettings shows "✅ Installed" even if gemma4:12b was deleted | `ollama.ts:70` |
| AI13 | Medium | Three inconsistent "Mamta AI"s: the real agent (`MamtaChat`), a keyword if/else bot on the Dashboard (`Dashboard.tsx:203-233`), and a `setTimeout`+canned-template fake in CompanyInbox (`CompanyInbox.tsx:104-163`). "AI AD STUDIO" is pure string interpolation, no model call (`Dashboard.tsx:149-153`) | see locations |
| AI14 | Low | nomic task prefixes (`search_document:` / `search_query:`) not used → measurable retrieval quality loss on Hinglish queries; one-request-per-doc embedding via deprecated endpoint; full IndexedDB read + O(N·768) scan per query AND per remember | `lib/rag/embeddings.ts:8-33`, `lib/rag/store.ts:75-82` |

### Making it predictive (RTX 3060-realistic)

The highest-leverage insight: **the data for prediction already exists — compute signals in plain JS, let Gemma narrate** (the pattern `dailyReport.ts` already uses correctly):

1. **ETA / delay flags** — per-route median transit hours + MAD from TRIPS timestamps; flag in-transit trips beyond `median + 2·MAD`. Milliseconds of JS, no GPU.
2. **Fuel anomaly** — litres/km per vehicle from FUEL_ENTRIES ÷ RTKM; robust z-score vs the vehicle's own trailing 90 days catches pilferage.
3. **Payment risk** — `ledgerBalances()` already exists; rank debtors by `balance × days-since-last-payment`.
4. Feed all three into `buildDailySummary` → the existing Gemma daily report becomes genuinely predictive at zero inference cost.

Plus: stream the agent's final answer (first-token latency instead of full-answer waits), explicit two-model routing with per-request `keep_alive` (e4b resident 30m for chat, 12b 5m for extraction — all three models don't fit in 12 GB simultaneously), background pre-computation on idle (daily report cached by date, delta-embed changed docs from `onSnapshot` feeds), schema-constrained extraction (`format: <JSON Schema>` — Ollama grammar-constrains decoding), and a query-embedding LRU + in-memory `Float32Array` vector matrix.

---

## 📋 ACTION PLAN — Phased Modernization

### Phase 0 — Emergency (this week, ~2 days)
1. **Rotate credentials**: 3 SMTP passwords (`test-email.cjs`), Google TTS key (`bridge.cjs`), Gemini key (`whatsapp-server/server.js`). They are live in git history now.
2. `git rm --cached .env test-email.cjs`; add `.env`, `.firebase/` to `.gitignore`; move both service-account JSONs outside the repo tree; purge secrets from history (`git filter-repo`).
3. **Fix the WhatsApp crash**: rename `activeChatPhoneView` → `activePhoneToView` (4 JSX references).
4. Delete the `admin` master-key bypass and fake OTP path from `Login.tsx` (or gate behind `import.meta.env.DEV`); disable customer/partner portals until real OTP exists.
5. Write and deploy first-pass `firestore.rules` + `storage.rules` (deny-all default, then per-collection allowances), wired into `firebase.json`.

### Phase 1 — Real authentication (week 2)
6. Migrate to **Firebase Auth** (email/password): create auth users, drop the `password` field from `USERS` docs entirely, map roles to **custom claims**.
7. Rewrite Firestore rules keyed on `request.auth` + claims; keep client RBAC as UX only.
8. Firebase Phone Auth for customer/partner portal OTP.
9. Gate AI write tools (`commitWrite`) on role allowlist + arg validation (amount > 0, type enum, plate regex); route `add_ledger_entry` through `postEntry` so AI entries hit the double-entry journal.

### Phase 2 — Data layer (weeks 3-4) — biggest cost & speed win
10. Enable Firestore **persistent local cache** (`initializeFirestore` + `persistentLocalCache`) — one-line mitigation while queries are refactored.
11. Add `where`/`orderBy`/`limit(50)` + `startAfter` cursor pagination to all 11 TRIPS fetch sites (use `BillManagement.tsx:98` as template); composite indexes as needed.
12. Replace await-waterfalls with `Promise.all`; dedupe the double VEHICLES fetch in LedgerMgmt.
13. Replace full-refetch-after-mutation with optimistic local updates; convert bulk loops to `writeBatch` (atomic, ≤500 ops).
14. Build one shared data layer — a `useCollection(name, queryOpts)` hook with module-level cache (or TanStack Query) — and a single `lib/normalize.ts`; plan a one-time field-name migration (`Vehical_No` → `vehicle_no`).
15. Move LR/trip-ID generation to a Firestore transaction/counter (fixes duplicate-ID race).

### Phase 3 — Rendering & bundle (weeks 4-5)
16. `React.lazy` + `<Suspense>` per module in `App.tsx`; `manualChunks` for firebase/recharts/react-quill; split PublicWebsite/Login from the ERP shell. Expected: >70% initial-chunk reduction.
17. `useMemo` the render-body aggregations (FinancialReports P&L/BS with an `entriesByLedger` index, Dashboard analytics, LedgerMgmt, TripManagment filters); debounce all search inputs.
18. Extract the chat widget + AD STUDIO modal out of Dashboard so their keystrokes stop re-rendering fleet analytics; `React.memo` row components.
19. Adopt `react-router` (URLs, deep links, back button) or at minimum stop unmount-refetch per tab.
20. Paginate history tables; `react-window` (or `content-visibility: auto`) for long lists.

### Phase 4 — Mobile & UX polish (week 6)
21. Fix TripManagment modals: `width: 'min(800px, 100%)'` + overlay padding (unblocks phone ops).
22. `flexWrap` on the Dashboard time-range control; FAB media query to ≤1024px to clear the bottom nav; hoist the responsive `<style>` block above the Finance Hub early-return.
23. Global `@media (pointer: coarse) { button { min-height: 40px } }`; fix the worst touch targets (DRIVER, LoanEmi, BazaarAdmin, LodingDetals).
24. `viewport-fit=cover` in index.html; delete dead `index.css`; bundle external images locally; replace `minmax(400px,…)` with `minmax(min(100%,400px),…)`; retire the App.css attribute-selector hammer module-by-module.
25. Replace alert/confirm with one toast + dialog component (348 call sites, mechanical).

### Phase 5 — AI upgrade (weeks 7-8)
26. Wire STM into MamtaChat (~10 lines) → multi-turn conversations.
27. Set `num_ctx: 8192`; idle-reset the stream timeout; append (don't replace) partials on error; thread `AbortController` + Stop button; per-task model routing (12b pinned for vision/extraction, e4b for chat) with per-request `keep_alive`.
28. RAG: staging rebuild (no wipe-first), delta indexing off `onSnapshot`, staleness badge, nomic task prefixes, `/api/embed` batching, `Float32Array` matrix cache.
29. Restrict auto-remember to 👍-confirmed + stable facts; prefix injected memories "possibly outdated — verify with tools".
30. Scanner: multi-page PDF support (or "3 pages, only 1 scanned" warning), schema-constrained output (`format: <JSON Schema>`), format validators (plate/date/qty/product enum) feeding `_reviewFields`.
31. Consolidate the three Mamta AIs onto the real LLM layer (Dashboard chat → `runAgent`; CompanyInbox → `llmComplete` over the full email body; Ad Studio → `llmComplete` with product/route/season context); keep templates as `LLMOfflineError` fallbacks.
32. Ship the JS-side predictors (ETA/fuel/payment-risk) into the daily report.

### Phase 6 — Hygiene (ongoing)
33. Surface accounting write failures; make bill+journal a `writeBatch`. Shared `validators.ts` (GSTIN/PAN/mobile/amount guards) on all save paths.
34. `esbuild.drop: ['console']` in the prod build; remove `@ts-nocheck` file-by-file as modules are touched; move server deps out of the frontend package.json; drop `@google/generative-ai` and npm `stream`; evaluate `react-quill` replacement.
35. Delete dead files; rename misspelled modules (imports centralize in `App.tsx`); begin splitting the three 1,100+ line god components.

---

## Effort & impact summary

| Phase | Effort | Impact |
|---|---|---|
| 0 Emergency | ~2 days | Stops live credential exposure + crash; closes admin backdoor |
| 1 Auth | ~1 week | Database goes from world-writable to enforced |
| 2 Data layer | ~2 weeks | 10-100× fewer reads; screens load in ms from cache |
| 3 Render/bundle | ~1.5 weeks | >70% smaller boot; keystroke freezes eliminated |
| 4 Mobile | ~1 week | Trip ops usable on the shipped APK |
| 5 AI | ~2 weeks | Multi-turn, predictive, robust extraction |
| 6 Hygiene | ongoing | Compounding maintainability |
