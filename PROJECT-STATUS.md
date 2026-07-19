# PRASAD TRANSPORT ERP — Project Status & Operations Handover

**As of:** 2026-07-19 · **Branch:** `upgrade-2026` (pushed) · **Live:** https://prasad-transport-grup.web.app
**Latest smoke sweep (2026-07-19):** 14 checks — 7 new/rebuilt modules × desktop + phone — **0 errors, 0 overflow.** (Prior full sweep 2026-07-18: 99 checks clean.)

---

## 2026-07-19 — Post-Trip Financial & Billing Engine (this release)

| Feature | Delivered | Verified how |
|---|---|---|
| **Retro expenses + admin approval** | `EXPENSE_APPROVALS` queue (ACCOUNTS → Pending Expenses, live sidebar badge): late HSD/toll/vendor bills filed manually or via Mamta AI scan; ADMIN approval posts journal + retro-adjusts the trip P&L and re-finalizes COMPLETED-trip settlements (idempotent); admin-only approval enforced in `firestore.rules` | Rules deployed; UI verified both roles |
| **Unloading → billing pipeline** | Both completion doors (Unloading Details + Trip Command Center) stamp `draft_invoice` + `billing_status:'PENDING'`; Bill Management = customer-wise Pending Billing dashboard (KPIs, aging, 2-step preview→generate); company-PDF reconciliation marks trips RECONCILED; explicit PENDING PAYMENT receivables | Screenshots + live data |
| **Auto-shortage recovery** | Unloading with shortage auto-debits the driver's khata (`DRIVER_TRANSACTIONS` deterministic id `SHORTAGE__<trip>` — can never double-charge) + journal `SHORTAGE_RECOVERY`; penalty-rate chips (₹50/90/100/110); shows on WhatsApp confirmation + registers + client bill deduction | Idempotency by doc id |
| **AI bill → trip mapping** | Vendor/fuel bill scans extract vehicle_no; engine maps to the exact trip by vehicle + date window; active trip → direct post, closed trip → approval queue; hardened `parseDocDate` (2-digit years, day/month swap, refuses impossible dates) | 11-case date test suite |
| **Smart UI/UX layer** | design-system additions (pt-card/kpi/badge/chip/seg/tab/switch + animations, reduced-motion safe); BottomSheet modals everywhere; tap-first chips; 44px+ targets; mobile card views | 0 overflow/errors sweep |
| **Offline Toll engine** | `tollParse.ts`/`tollEngine.ts`: ICICI FASTag PDF parser (**verified 67/67 tolls, ₹39,305 exact vs the real statement**), any-bank CSV/XLSX, date-window trip mapping, idempotent `TOLL_TRANSACTIONS` (`TFS_<ref>`), multi-company; IOCL claim generator reproduces the real Summary + Annexure-I to the layout (claim no format `110246990726012` matched); `TOLL_CLAIMS` register + reprint | `scripts/toll-parse-test.cjs` 11/11 |
| **Multi-company auto-billing** | MonthlyBilling rebuilt: HARD RULE one invoice = one operating company (top-bar filter + save-time source verification + `billed_company` stamp); 100% dynamic letterhead from Company Master (no hardcoding); exact AADHAR-format Tax Invoice (HSN 996791, CGST/SGST 2.5+2.5 RCM) + Detention bill + annexure; real detention rule (reporting + free days, inclusive); live sticky summary; per-customer `billing_cycle` (15/30 days) with fortnight chips + wrong-cycle warning; Deductions panel (TDS freight-only, shortage, advance) with Net Payable on screen + PDF + invoice record | Real-bill formats reproduced; 14/14 math-proof tests (boundaries, leap yr, paisa parity) |
| **QA audit fixes** | State-leakage hard reset on customer/company/month/period change; pre-commit `.every()` company check against source data + double-billing guard; paisa-exact freight (per-trip rounding = journal parity, old method drifted ₹1.50) | Proof tests + audit report |
| **Cloud transaction guard** | `functions/index.js` → `generateAutoBill` v2 callable: server Firestore transaction rereads trips, aborts on mismatch/already-BILLED, atomic invoice+flips; frontend calls it first, guarded client fallback if unreachable | **Deploy pending Blaze** (see checklist) |
| **Ledgers & P&L** | Customer Khata (Live): unified real-time statement — Auto-Billing + Bill Mgmt invoices as Cr, manual `CUSTOMER_PAYMENTS` + settle receipts as Dr, running balance + opening balance, payment BottomSheet posts journal too, CSV export; Company P&L (Live): revenue ex-GST, tolls/fuel (no double-count)/shortage expenses, recovery add-back, green/red hero card, CSV | Screenshots, live data |

**New operating notes:** Pending Expenses = ACCOUNTS → ⏳ (admin approves); Toll statements = ACCOUNTS → Toll & Fastag → 📄 Statement Sync (upload ICICI PDF/CSV/Excel) then 🧾 IOCL Toll Claims (fortnight → generate); Khata = ACCOUNTS → Customer Khata (Live) → ＋ Add Payment Entry; P&L = ACCOUNTS → Company P&L (Live).

---

## What was delivered (from the original SYSTEM-AUDIT-REPORT.md)

| Phase | Delivered | Verified how |
|---|---|---|
| **0 — Security emergency** | Admin backdoor + fake OTP deleted; plaintext passwords → salted PBKDF2 (all 5 users migrated); leaked SMTP/API keys stripped from code **and git history** (force-pushed); first-pass Firestore/Storage rules; WhatsApp crash fixed | Live REST checks: unauthenticated reads 403 |
| **1 — Real staff auth** | Firebase email/password for all 5 staff (**existing passwords preserved** via PBKDF2 hash import); roles enforced server-side from `USERS/{uid}`; UGER creates real auth accounts; password changes via reset email | 10/10 security matrix + real UI login on live site |
| **1b — Driver/portal auth** | Firebase Phone OTP for drivers (persistent device sessions, `driver_uid` binding) and portals; SMS region IN enabled; demo only via staff preview | End-to-end OTP login on live site (Firebase test number) |
| **A — Truth Sprint** | Fuel Rate field (diesel cost was ₹0 in every settlement); advances split from expenses (197 trips migrated, 174 settlements recomputed); Dashboard/Reports revenue-expense math unified (`lib/accounting/tripMath.ts`); real Storage uploads for POD/KYC (were fake blob: URLs); GPS wired to Track modal + throttled; ledger `group` typo patched (84 docs); KYC validators + pincode corruption fix | Node/Web-Crypto parity test; data patches logged |
| **B — Architecture** | Code-split boot chunk 2,416→197 KB (−92%); Firestore persistent cache; parallel fetches; memoized P&L/trip filters + debounced search; driver-scoped trip query; TRIPS pagination (mount reads 846→146, −83%) with composite index + `sort_date` backfill | Playwright smoke on every change |
| **C — Mobile design system** | `src/ui/BottomSheet.tsx` (replaced all 450–850px fixed modals); trip cards with HSD/Cash meters; Finance Hub hero-KPI layout + honest labels; Driver App Hindi-first (big tiles, working खर्चा form, मेरी रिक्वेस्ट status, plant-reporting stamp); Vehicle Docs vault mobile + real uploads | Phone-viewport screenshots each release |
| **AI suite** | **AI Bill Scanner** (IOCL tonne-km, HSD pump, BPCL AP210 formats — auto-classified, one-tap filing to trips+journal+wallet); **Fleet Card & Settlement** (pump credit → card swipe → freight-deduction recharge, statement reconciler for IOCL/HPCL/BPCL); **Auto Billing** (monthly freight+detention RCM invoices matching the physical format to the rupee); **Predictive daily report** (late-trip flags — 21 found on real data, fuel anomalies, payment chase list); multi-turn Mamta chat (shared CRM+Dashboard brain) | Every extractor validated against the owner's real PDFs via local gemma4:12b |
| **KYC & billing ops** | KYC approval queue (approve → master+ledger atomically); live sidebar badges; MONTHLY_INVOICES + journal posting; duplicate-CN dedupe | Real Aadhar June-2026 bill reproduced exactly |

## How to operate

- **Staff login:** same email+password as always (server-verified now). New staff via UGER (creates the auth account); password changes send a reset email.
- **Drivers:** phone number + OTP once per device; session persists. Unregistered numbers are told to call the office.
- **Monthly billing:** ACCOUNTS → Auto Billing → customer+month → review → Print/PDF → Save (marks trips BILLED + posts journal).
- **Oil-company bills:** ACCOUNTS → AI Bill Scanner → drop the PDF (auto-detects IOCL/HSD/BPCL-AP210) → review → file.
- **Card statements:** ACCOUNTS → Fleet Card → reconciler → upload statement → red rows = swipes with no ERP settlement.
- **Daily report:** CRM → Mamta chat → daily report includes ⏰ late trips / ⛽ fuel anomalies / 💰 chase list, computed from live data.
- **Local AI:** everything AI runs on this machine's Ollama (`gemma4:12b`) — keep Ollama running; when it's off, scanners say so honestly and the Dashboard chat falls back to instant keyword answers.

## Owner's outstanding checklist (not code)

1. **Upgrade to Blaze** (Firebase console → Upgrade; billing account `017033-7CAF33-C668E8` is linked but disabled) then ask for `generateAutoBill` deploy — makes double-billing 100% race-proof server-side. Usage stays in the free tier.
2. **Company Master:** fill GSTIN/PAN/bank/UDYAM for **JAISWAL ENTERPRISE** and **M/S GAUTAM PRASAD** — multi-company invoices print only what the master holds (nothing is hardcoded anymore).
3. **Rotate the old leaked credentials** (3 SMTP passwords, Google TTS + Gemini keys) — they were public on GitHub before the history purge.
4. **Backfill freight** on historical trips (Set Freight Bulk / file AP210s) — activates Revenue KPIs and the payment chase list.
5. **After all drivers have OTP'd once:** ask for the anonymous-lane retirement (tightens rules to phone-bound writes only).
6. QA scripts note: the localStorage bypass no longer grants data access (by design) — use a dedicated staff account for testing.

## Key engineering references

- `firestore.rules` / `storage.rules` — the enforcement model (staff vs driver lane; `EXPENSE_APPROVALS` admin-only approval).
- `src/lib/accounting/tripMath.ts` — canonical money math (both finance screens use it).
- `src/lib/accounting/journal.ts` — idempotent double-entry journal (`postEntry`).
- `src/lib/postTripEngine.ts` — post-trip brain: retro expenses, bill→trip matching, draft invoices, shortage recovery, `parseDocDate`.
- `src/lib/tollParse.ts` (pure, Node-tested) + `src/lib/tollEngine.ts` — FASTag statement parsing, trip mapping, IOCL claim rendering.
- `functions/index.js` → `generateAutoBill` — server transaction guard for billing (deploy pending Blaze).
- `src/lib/billScanner.ts` + `src/lib/fleetCard.ts` — document AI (classify → extract → verify arithmetic in code).
- `src/lib/analysis/predictors.ts` — median+MAD predictors feeding the daily report.
- `scripts/` — one-time migrations (all idempotent, all already run) + QA utilities.
