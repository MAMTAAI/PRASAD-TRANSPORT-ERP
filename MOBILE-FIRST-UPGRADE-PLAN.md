# PRASAD TRANSPORT ERP — 4-Pillar Deep Audit & Mobile-First Upgrade Plan

**Date:** 2026-07-18 · **Branch:** `upgrade-2026` · **Follows:** SYSTEM-AUDIT-REPORT.md (Phase 0 security — complete)
**Method:** 4 parallel deep audits (Trip Command Center, Master Finance Hub, KYC Onboarding, Driver App) — every finding verified with file:line evidence. Design specs are labeled proposals.

---

## Executive Summary

The mandate was a mobile-first + premium-UX overhaul. The audits confirm the UI debt — but they surfaced something more urgent first: **in all four pillars, core business features are silently wrong or silently fake.** A premium redesign painted over these numbers would make wrong data *more* convincing. The plan therefore runs a short "Truth Sprint" first, then the architecture foundation, then the design system and pillar-by-pillar overhaul.

### 🔴 The findings the boss must see (business impact, not style)

| # | Finding | Impact |
|---|---|---|
| 1 | **Diesel cost never enters trip settlement.** The fuel-memo modal has no Rate input, so every `FUEL_ENTRIES.amount` = ₹0 and `total_expense` accrues only cash. `final_balance` (trip profit) **excludes the entire HSD cost** — profits are systematically overstated. (`TripManagment.tsx:353,649`) | Every settlement figure wrong |
| 2 | **Cash advances are booked as P&L expense** *and* as driver recoverables, never netted — profit understated by every unrecovered advance; driver khata and P&L disagree by construction. (`TripManagment.tsx:302,375`; `FinancialReports.tsx:167`) | P&L wrong in the other direction |
| 3 | **The Finance Hub and Financial Reports compute different Revenue and Expenses for the same trip** (different field-fallback orders; `max()` clamp on one side only). Neither reads the reconciled double-entry `JOURNAL` — it's wired to nothing. (`Dashboard.tsx:246` vs `FinancialReports.tsx:161-170`) | Two screens, two "truths" |
| 4 | **Driver POD/challan/KYC photo uploads are fake.** A `blob:` URL (device-local, session-only) is stored in Firestore behind a fake "✅ Uploaded Successfully" — the office can never open any driver photo. The entire Kharcha (expense) tab is dead UI: the submit button has **no onClick**. (`DriverPortal.tsx:180-202,526`) | Proof-of-delivery silently lost |
| 5 | **Portal KYC persists nothing** (fake 3s auto-approve, no Firestore write, no file inputs) and staff-side KYC uploads **discard the file after OCR**, writing a broken `'local-scan'` link. (`CustomerPortal.tsx:149`, `DRIVER.tsx:170-177`) | Onboarding pillar is fiction |
| 6 | **Working GPS telemetry is thrown away.** DriverPortal writes `liveLocation` to trips (unthrottled — a Firestore write every few seconds per moving truck); the Track modal never reads it and shows "GPS Not Detected". (`DriverPortal.tsx:165` vs `TripManagment.tsx:538`) | Live-tracking is 80% built, 0% used |
| 7 | **Completed trips can be silently re-completed** from the Unloading screen (missing status guard), and two clerks can mint the **same LR number** (client-side max+1, no transaction). (`UnlodingDetals.tsx:130`, `LodingDetals.tsx:80-99`) | Data integrity |
| 8 | **Vendor ledgers vanish into Suspense A/c** via a `group_head`-vs-`group` field typo, and vendors are double-counted in the Trial Balance (manual + virtual ledger). (`LedgerMgmt.tsx:174,340`) | Books don't tie out |
| 9 | Date filtering is **lexical string comparison** on mixed-format dates (`DD-MM-YYYY` vs `YYYY-MM-DD`) in FinancialReports, LedgerMgmt, CashBankBook — silent mis-inclusion/exclusion. | Period reports unreliable |
| 10 | Driver "login" = mobile-number lookup with a **demo backdoor advertised in the placeholder** ("Type 1234 for demo"). | Anyone can be any driver |

### Pillar verdicts in one line each
- **Trip Command Center:** real lifecycle is just `created → IN_TRANSIT → COMPLETED` with three inconsistent doors into TRIPS; daily-use modals (Pay/Fuel/Unload/Track) are 450–850px fixed-width — mobile usability 2/10.
- **Master Finance Hub:** two independent, disagreeing ad-hoc calculators over raw collections; the actual accounting journal is display-only; no GST/TDS handling; "YTD" card is life-to-date; "Cash Flow" KPI is a fabricated formula.
- **KYC Onboarding:** no functioning pillar — five disconnected staff forms with no validation, a portal facade that discards data, one live corruption bug (pincode), one crash-class bug (two vendor schemas in one collection silently emptying the list).
- **Driver App:** a demo shell wearing a production costume — fake uploads, dead expense tab, no session persistence, no khata view, no offline handling, and every ₹6,000 phone downloads the full 2.4 MB staff ERP.

---

## PART 1 — Design System Overhaul (the shared foundation)

One design system, applied per pillar. New files under `src/ui/` + `src/design-system.css` extension.

### 1.1 Tokens (CSS custom properties)
```css
:root {
  /* Fluid type — kills every fixed 36/38/48px */
  --fs-page-title: clamp(20px, 5vw, 36px);
  --fs-kpi-hero:   clamp(28px, 8vw, 48px);
  --fs-kpi-value:  clamp(22px, 6.5vw, 38px);
  --fs-body:       clamp(14px, 3.8vw, 15px);
  --fs-label:      clamp(11px, 3vw, 13px);
  /* Fluid space — kills fixed 30px page padding */
  --pad-page: clamp(12px, 4vw, 30px);
  --pad-card: clamp(14px, 3.5vw, 25px);
  --radius-card: 16px;  --radius-sheet: 16px 16px 0 0;
  /* Touch */
  --touch-min: 48px;    --touch-driver: 56px;
}
@media (pointer: coarse) { button, [role="button"] { min-height: var(--touch-min); } }
```
- Money everywhere via `new Intl.NumberFormat('en-IN')` (lakh/crore grouping) + `font-variant-numeric: tabular-nums` on amount columns.
- Staff app keeps the dark premium theme; **Driver App flips to a light, WCAG-AAA high-contrast theme** (sunlight readability — current `#050505` + 40%-opacity text is sunlight-hostile).

### 1.2 Core shared components (`src/ui/`)
| Component | Replaces | Spec |
|---|---|---|
| `BottomSheet` | All fixed-width modals (800/850/450px × ~15 call sites) | Phone: slides from bottom, `max-height: 92dvh`, drag-to-dismiss (~30-line pointer handler, no lib), sticky full-width 52px CTA footer, `env(safe-area-inset-bottom)`. Desktop ≥1024px: same component centers at `min(92vw, 720px)`. |
| `EntityCard` / `CardList` | Heavy tables on phones | `useIsMobile()` switch: cards <600px, existing tables ≥600px. Memoized rows. |
| `StickyFilterBar` | Scrolling-away search rows | `position: sticky; top: 0`, debounced search (250ms), horizontal-scroll status chips with `scroll-snap`. |
| `Toast` + `ConfirmDialog` | 348 `alert()` + 38 `confirm()` | Non-blocking, styled, Hindi/English message support, retry affordance. |
| `KpiCard` / `KpiGrid` | Ad-hoc stat cards | `repeat(auto-fit, minmax(150px, 1fr))` → 2-col at 360px; hero variant spans full width. |
| `WizardShell` | Mega-forms | Step dots + label, per-step validation, back-preserving, draft persistence. |
| `lib/validators.ts` | No validation anywhere | `mobileIN /^[6-9]\d{9}$/`, `gstin /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/`, `pan`, `aadhaar` (+Verhoeff), `ifsc /^[A-Z]{4}0[A-Z0-9]{6}$/`, `pincode`, `vehicleNo`, `accountNo`; returns `{ok, message}` bilingual. Bonus: GSTIN→PAN auto-derive, GSTIN state-code→State autofill. |
| `lib/uploadMedia.ts` | Fake blob-URL uploads | Canvas-compress to ≤1600px JPEG q0.72 → `uploadBytesResumable` to Firebase Storage → downloadURL into doc; progress + retry; offline queue (IndexedDB) for the driver app. |

### 1.3 Interaction rules
- Every phone table either becomes cards or gets column-priority + row-expand — **zero horizontal page scroll anywhere**.
- Hover-only affordances banned (title-attr tooltips → tap-to-reveal; group-hover overlays → visible buttons).
- Add `viewport-fit=cover` to `index.html`; delete dead `src/index.css`; bundle external images (Wikimedia/Wix/ui-avatars) locally; retire the `App.css` attribute-selector hammer module-by-module as source-level `min(100%, Npx)` patterns replace it.

---

## PART 2 — Prioritized Execution Plan

### 🩹 PHASE A — Truth Sprint (week 1-2) · make the ERP honest before making it pretty
*Small diffs, huge business value. No visual changes.*

| # | Task | Fixes | Effort |
|---|---|---|---|
| A1 | Add **Rate field** to fuel memo rows (amount = qty × rate); decide & remove the latent vendor double-credit (`TripManagment.tsx:384` vs FuelMgmt verification credit) | Diesel cost ₹0 bug | S |
| A2 | Stop booking driver/pump **cash advances into `total_expense`** — post to driver ledger; expense = bhatta + fuel + toll. Includes historical-trip migration script | P&L wrong both ways | M |
| A3 | Shared `getTripFreight(t)` / `getTripExpense(t)` in `lib/accounting/` — one canonical fallback order used by Dashboard + FinancialReports | Two-truths revenue/expense | S |
| A4 | Shared `toISODate()` normalizer at fetch; replace all three lexical date compares | Silent period-filter corruption | S |
| A5 | Fix `group_head`→`group` typo + data patch for Suspense vendor ledgers; dedupe manual/virtual vendor ledger pair | Books tie-out | S |
| A6 | **Real uploads**: `lib/uploadMedia.ts` → Firebase Storage for driver POD/challan/KYC and staff KYC docs (stop discarding files post-OCR) | Silent data loss | M |
| A7 | Wire the dead **Kharcha tab** (state + handlers + `DRIVER_REQUESTS` type EXPENSE — staff pay-path already understands it) or hide it | Dead money feature | S |
| A8 | Trip integrity: unify completion writes (both doors set `office_approved_unloading`, `completed_at`, dual-case); add `trip_status !== 'COMPLETED'` guard to APP SYNC approvals; transaction-based LR counter | Re-completion + LR collisions | M |
| A9 | Remove driver demo backdoor from prod; throttle GPS to 1 write/3-5min or 500m delta (subcollection `pings`) | Backdoor + write burn | S |
| A10 | `writeBatch` + `increment()` for fuel memo / driver payment / bulk freight chains; disable submit buttons while pending | Non-atomic money writes | M |
| A11 | Fix Customer pincode corruption bug (split field); crash-safe Vander sort (two vendor schemas); delete dead `AdminDashboard.tsx`, portal dummy arrays, fake toll engine | Live bugs + dead weight | S |
| A12 | Surface (don't swallow) `postEntry` failures in BillManagement; wrap bill+journal in one `writeBatch` | Accounting integrity | S |

### 🏗️ PHASE B — Architecture Foundation (week 3-4) · perf that the redesign stands on

| # | Task | Effort |
|---|---|---|
| B1 | **Code-split**: `React.lazy` + Suspense for all ~35 modules in App.tsx; `manualChunks` (firebase/recharts/react-quill); split PublicWebsite+Login from ERP shell. Target: boot chunk −70% | M |
| B2 | **Separate driver entry** (second Vite input `driver.html` mounting only DriverPortal + firebase) — driver JS ~400 KB instead of 2.4 MB; trim SW precache (no pdfjs worker) | M |
| B3 | **Scoped queries + pagination**: TRIPS by lifecycle tab (`where status`, `orderBy created_at`, `limit 50`, cursor); driver trips by `where('driver_mobil_no'…)` (standardize the typo field first); RBAC scope applied in LodingDetals/UnlodingDetals/DriverPortal/FinancialReports | L |
| B4 | Firestore `persistentLocalCache` (instant warm loads + free offline write queue) | S |
| B5 | Kill full-refetch-after-mutation → optimistic local patch; `Promise.all` the fetch waterfalls; dedupe double VEHICLES fetch | M |
| B6 | **Memoization pass**: `useMemo` P&L/BS block, Dashboard analytics, trip filters; `entriesByLedger` Map index; pre-normalized `rtkmMaster` Map; debounced searches; extract chat/Ad-Studio state out of Dashboard | M |
| B7 | `selectors.ts` canonicalizers (`resolveTrip`, `computeBalances`) — one home for the `x \|\| X_Case` dance, shared by table + card renderers | M |

### 🎨 PHASE C — Design System + Pillar Overhauls (week 5-8)

**C0 (S):** Land tokens, `BottomSheet`, `Toast`, `KpiCard`, `StickyFilterBar`, validators — the shared kit above.

**C1 · Trip Command Center (M-L):**
- `TripCard` (phone <600px): vehicle+status pill / route line / **HSD & Cash mini progress meters** / driver tap-to-call + GPS-age chip; 4 equal 48px actions (Pay · Fuel · Unload · Track).
- All 5 modals → BottomSheets; FuelMemoSheet reflows pump rows to stacked cards (with the new Rate field).
- Sticky filter bar + status chips; "Start Trip" becomes a FAB; swipe-left quick actions via CSS scroll-snap (zero JS).
- `TripStatusTimeline` (Created→Loaded→In Transit→Unloaded→Completed→Billed) — forcing function to actually write the intermediate statuses.
- **TrackSheet v1**: read `liveLocation` + route via Maps SDK + staleness badge (the 80%-built feature, finally displayed); fix the broken `q=`+`destination=` embed URL as an interim one-liner.

**C2 · Master Finance Hub (M):**
- Extract `FinanceHub.tsx` from Dashboard; apply clamp() scale; 2×3 KPI grid with Net-Profit hero card; relabel/fix "YTD" and "Cash Flow" KPIs.
- Bar chart → recharts (already in bundle, tap tooltips work) or 44px button-columns with always-visible ₹-compact labels.
- P&L/BS sides `min(100%, 350px)` and stacked on phone; modal tables → stacked card rows; tab rows get `overflowX:auto` + snap; collapsible sections persisted to localStorage.
- Real-time-ness: aggregate queries (`getAggregateFromServer` sum/count — needs canonical `freight_amt` from A3) + `onSnapshot` on JOURNAL only; "Updated HH:MM" stamp meanwhile.

**C3 · Driver App (M-L):** *the deepest redesign — target: one-handed, ₹6,000 phone, sunlight, Hindi*
- Light AAA theme; Devanagari-first labels ≥16px (today: 8-9px English); money in en-IN.
- Home = current-trip card (माल qty · एडवांस मिला · बाकी खाता) + **4 tiles ≥96px**: 📸 पर्ची भेजो (unified photo-first POD/expense flow) · 💸 पैसा माँगो (numeric keypad + status timeline भेजा→मंज़ूर→मिल गया) · 📞 ऑफिस को फोन (`tel:`) · 🆘 मदद (emergency + auto-dial).
- 3 bottom tabs: ड्यूटी · खाता (driver-scoped `DRIVER_TRANSACTIONS` list — closes the "driver never sees his balance" loop) · कागज़.
- Offline-first upload queue (IndexedDB + Filesystem, drain on resume/network/60s, per-item status); replace Maps iframes with "Open in Google Maps" intent links; drop ui-avatars.
- Staff side: `onSnapshot` + sidebar badge on `DRIVER_REQUESTS` (emergencies currently sit unseen until someone opens the module).
- Capacitor hardening: Camera/Geolocation/Network/App plugins, Android back-button, native splash.

**C4 · KYC Onboarding (M-L):**
- `lib/validators.ts` retrofitted into all staff masters with inline errors (replaces alert()).
- Customer wizard (5 steps, ≤4 fields/screen): mobile-OTP → business identity (GSTIN auto-fills PAN+state) → address → document capture → review. Partner wizard adds Aadhaar (masked display) + bank + first vehicle steps. Camera-first capture, compression, resumable Storage uploads, `ONBOARDING_DRAFTS` persistence with resume banner.
- **Admin review queue** (replaces dead AdminDashboard + hardcoded "3" badge): list with auto-check summary + SLA age; detail drawer with masked-PII reveal-on-click (audited); Approve→transactional canonical doc + ledger; Reject→reasoned, returns applicant to the failing step.
- Data-model unification: one VENDORS shape (`party_type`), merge EXTERNAL_CUSTOMERS into CUSTOMERS, doc-ID references instead of name-string FKs. Migration scripts + read-compat.

### 🔐 PHASE D — Auth-dependent finishers (with Phase-1 Firebase Auth)
- Firebase Phone Auth: staff (email) + drivers/portals (phone OTP, SMS auto-read, persistent device session, multi-driver-per-phone picker, staff unbind button).
- Per-role security rules: drivers update only `driver_*` fields on own trips; applicants read/write own draft only; KYC PII readable by staff claims only; `canApprove` from custom claims not localStorage.
- Bids/loads keyed by uid; portal dashboards rebuilt on real scoped data.
- Promote JOURNAL to the KPI source of record (complete posting coverage → backfill → KPIs from `ledgerBalances()`); GST/TDS ledgering (output payable / input credit / TDS receivable).

---

## Sequencing rationale & effort summary

| Phase | Why this order | Effort |
|---|---|---|
| A Truth | Wrong numbers + fake features must die before a premium UI makes them more convincing | ~2 wks |
| B Architecture | Code-split & scoped queries make every later screen fast; memoization must precede tap-interactions | ~2 wks |
| C Design | Shared kit first (C0), then pillars in business-priority order: Trips (daily ops) → Finance (boss's screen) → Driver (field force) → KYC (greenfield) | ~4 wks |
| D Auth-dependent | Real enforcement + real identity; unblocks portals publicly | with Phase 1 |

**Definition of done per pillar:** zero horizontal scroll at 360px · all touch targets ≥48px (56px driver) · no `alert()`/`prompt()` · P&L ties to journal (finance) · POD photo visible in office within 1 minute of driver capture (trips/driver) · onboarding submission visible in admin queue (KYC) · Lighthouse mobile perf ≥85 on driver entry.
