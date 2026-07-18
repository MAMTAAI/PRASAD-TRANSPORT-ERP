# PRASAD TRANSPORT ERP — Project Status & Operations Handover

**As of:** 2026-07-18 · **Branch:** `upgrade-2026` (pushed) · **Live:** https://prasad-transport-grup.web.app
**Full regression sweep:** 99 checks (all modules × desktop + phone, real staff auth) — **0 errors, 0 overflow.**

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

1. **Rotate the old leaked credentials** (3 SMTP passwords, Google TTS + Gemini keys) — they were public on GitHub before the history purge.
2. **Backfill freight** on historical trips (Set Freight Bulk / file AP210s) — activates Revenue KPIs and the payment chase list; 21 flagged "late" trips are mostly never-closed trips worth completing.
3. **Company Master:** add `bank_name`, `account_no`, `ifsc_code`, `udyam_no` so invoices print real bank/UDYAM details.
4. **After all drivers have OTP'd once:** ask for the anonymous-lane retirement (tightens rules to phone-bound writes only).
5. QA scripts note: the localStorage bypass no longer grants data access (by design) — use a dedicated staff account for testing.

## Key engineering references

- `firestore.rules` / `storage.rules` — the enforcement model (staff vs driver lane).
- `src/lib/accounting/tripMath.ts` — canonical money math (both finance screens use it).
- `src/lib/accounting/journal.ts` — idempotent double-entry journal (`postEntry`).
- `src/lib/billScanner.ts` + `src/lib/fleetCard.ts` — document AI (classify → extract → verify arithmetic in code).
- `src/lib/analysis/predictors.ts` — median+MAD predictors feeding the daily report.
- `scripts/` — one-time migrations (all idempotent, all already run) + QA utilities.
