# Access Control Matrix — who sees what, who controls it, and how outside data reaches the core

Prasad Transport ERP · 2026-09-02 · owner directive: *"kisko kya dikhana hai ya nahi — yeh office staff ke permission se show hoga"* and *"no external user writes directly to the core database"*.

This is the analysis the Admin Control Hub and the Smart Approval Desk are built on. Every statement below was checked against the code and migrations on `upgrade-2026` on the date above; file references are given so the next person can re-verify.

---

## 1. The two laws

**Law 1 — the gate.** An outside party is dark until the office opens it. `is_approved_for_portal` on `customers`, `vendors`, `drivers` (migration 068) is checked on *every* request, not at login (`portal.routes.js resolveParty`, `driverPortal.routes.js resolveDriver`). Withdrawing approval takes effect on the next call.

**Law 2 — the quarantine.** An outside party never writes a core table. Every external write lands in a staging table in a PENDING state; the core (trips, ledgers, masters, settlements' money) changes only when office staff press APPROVE, and the voucher is posted by TARA inside that approval transaction. Since 2026-09-02 this is enforced physically at the database pool (`server/lib/staging.js`, section 6), not only by route design.

Three layers decide visibility, ANDed — never ORed — so a layer can only *subtract*:

| Layer | Where | Who edits it | Screen |
|---|---|---|---|
| Party gate | `<party>.is_approved_for_portal` | ADMIN / SUPER_ADMIN | Access Control Hub (new), Master Control → Portal Access |
| Role-wide matrix | `portal_role_access` (page + field toggles per role) | ADMIN / SUPER_ADMIN | Access Control Hub → Role Matrix tab (same component as Master Control) |
| Per-party features | `customers.portal_features`, `vendors.portal_features` (short keys, `false` hides) | ADMIN / SUPER_ADMIN | Access Control Hub → row → Features |

Sensitive fields (freight amount, driver phone, outstanding balance, rate breakdown, target price, khata balance) are **hidden by default** in the role matrix (`is_visible = NOT sensitive`) and must be opened deliberately.

---

## 2. Identity — who logs in, how, and what the session is

| Party | Login row | Credential | Session row | Scope in token |
|---|---|---|---|---|
| Office staff | `users` (SUPER_ADMIN, ADMIN, ACCOUNTS, DISPATCH, VIEWER) | password + OTP (2FA since 31-Aug) | `auth_sessions.user_id` | `role` |
| Customer | `users` role CUSTOMER, `users.customer_id` → `customers` (one login per party, unique index) | OTP on mobile (password reset available) | `auth_sessions.user_id` | party derived server-side, never from a param |
| Fleet partner | `users` role VENDOR, `users.vendor_id` → `vendors` where `vendor_kind='FLEET_PARTNER'` | OTP on mobile | `auth_sessions.user_id` | same |
| Service vendor | `users` role VENDOR, `vendor_kind='SERVICE'` | OTP on mobile | `auth_sessions.user_id` | same |
| Driver (own fleet) | **no `users` row** — token `sub` = `drivers.id` | OTP on mobile, or a one-tap login link sent from Driver Master (`POST /auth/driver/link`) | `auth_sessions.driver_id` | role DRIVER |
| Track-only driver | none — a vehicle/mobile number | `POST /auth/driver/track` | `auth_sessions.driver_id` (nullable) | `scope: TRACK_ONLY` → only `POST /tracking/ping` |
| Market driver | **does not log in.** A row in `market_drivers` registered by a fleet partner; the office approves or blocks it. | — | — | — |

Consequences the Hub must respect:
- A customer / vendor with no `users` row cannot log in even when approved. "Activate" in the Hub creates the login (random password, `must_change_password`, OTP on the party's mobile) the same way KYC approval does.
- Blocking must do three things: close the gate, set the login INACTIVE/SUSPENDED, and delete live `auth_sessions`. Closing the gate alone leaves the token valid until the next request; deleting sessions alone lets them log straight back in.
- Drivers have no login row, so "block" = gate closed + sessions deleted. Drivers also have **no `portal_features` column** and the driver portal does not consult the role matrix (`driverPortal.routes.js` checks only `status='ACTIVE'` and the gate). Driver visibility is therefore the gate only; the DRIVER rows in the role matrix are documentation until the driver portal reads them (follow-up, section 8).

---

## 3. Per user type — what they see, what they can do, what the office controls

### 3.1 Customer (customer app · `src/portal/CustomerApp.tsx`)

**Sees (pages, role matrix keys):** Dashboard `cust.dashboard` · Shipments `cust.shipments` · Live GPS tracking `cust.tracking` · Proof of delivery `cust.pods` · Place new order `cust.place_order` · Ledger & invoices `cust.ledger` *(sensitive — off by default)*.
**Fields off by default:** freight amount on shipments, driver name & phone, outstanding balance.
**Sees only its own rows:** every query is `WHERE customer_id = <party from session>`; field gating happens in the SELECT list (`withheld[]`), never by stripping JSON afterwards.

**Can do (all land in staging):**
| Action | Route | Lands in | State | Becomes core when |
|---|---|---|---|---|
| Place a load | `POST /portal/customer/loads` | `bazaar_loads` | `PENDING_REVIEW`, `posted_by='CUSTOMER_PORTAL'` | desk approves → `OPEN` (`bazaar.routes.js` load review) |
| Accept a bid | `POST /portal/customer/loads/:id/accept-bid` | `bazaar_loads` | `AWARD_REQUESTED` (202) | desk award-review → `awardInTx` → settlement opened |
| Change own password | `/auth/me/password` (OTP) | `users` (own row) | — | exempt: self-credential only |

**Never sees:** other customers, target price, competitors' bids, partner payables, any staff screen, any file outside `up/customer/<id>/…` plus the POD on its own settlement (`files.routes.js mayReadKey`).

**Office controls:** gate on/off, login create, block, archive, edit name/mobile/email, per-party feature toggles (`cust.*` short keys), kill sessions, view-as preview (read-only, ADMIN only), KYC approval (`bazaar/onboarding`).

### 3.2 Fleet partner (partner app · `src/portal/FleetPartnerApp.tsx`)

**Sees:** Dashboard `vend.dashboard` · My vehicles `vend.vehicles` · Load Bazaar `vend.bazaar` · Bills & payments `vend.bills` *(sensitive)* · Submit bill `vend.submit_bill` · 15-day credit bill `vend.credit_bill`.
**Fields off by default:** rate breakdown, the office's target price.
**Blind bidding:** a partner never sees another partner's bid amount.

**Can do (all staging):**
| Action | Route | Lands in | State | Becomes core when |
|---|---|---|---|---|
| Bid / withdraw | `/portal/vendor/loads/:id/bid`, `/bids/:id/withdraw` | `bazaar_bids` | `PENDING` / `WITHDRAWN` | award review by the desk |
| Book-Now | `/portal/vendor/loads/:id/book-now` | `bazaar_bids` + `bazaar_loads` | `AWARD_REQUESTED` | award review |
| Confirm settlement / name a truck | `/portal/vendor/settlements/:id/confirm`, `/assign` | `bazaar_settlements` | workflow state only | money moves only via admin deposit / advance / balance routes (`requireAdminRole`) |
| Submit POD | `/portal/vendor/settlements/:id/pod` | `bazaar_settlements.pod_file` | `POD_SUBMITTED` | admin `pod/verify` → then balance |
| Register a truck | `/portal/vendor/fleet/vehicle` | `market_vehicles` | `PENDING APPROVAL` | admin approve → `System Active` |
| Register a driver | `/portal/vendor/fleet/driver` | `market_drivers` | `PENDING APPROVAL` | admin approve (Access Hub → Market Drivers) |
| Upload a document | `/portal/vendor/documents` | `partner_documents` | `PENDING` | desk approve (bills auto-file into `expense_approvals`, still PENDING) |

**Never sees:** own-fleet trips, the company's ledgers, other partners, service-vendor bills. Market money is fenced by the `ledger_fleet_segment_guard` trigger (migration 129) so a market voucher cannot touch an own-fleet ledger even by staff mistake.

**Office controls:** everything in 3.1 plus subscription plan / vehicle ceiling, truck approve/reject, market-driver approve/block/reject, award decisions, POD verify, settlement money.

### 3.3 Service vendor (pump, tyre shop, spares · `src/portal/ServiceVendorApp.tsx`)

**Sees:** Dashboard · My bills · Submit bill. `vend.bazaar` is refused for this kind (`vendor_kind='SERVICE'` → 409 on bazaar routes) even if the role matrix opens it.

**Can do:** upload a bill PDF/photo → `POST /portal/vendor/expense-bills` → `expense_approvals` (`status='PENDING'`, `source='VENDOR_PORTAL'`, `file_key`, `vendor_id`). Nothing else writes.
**Becomes core when:** admin approves on the Pending Expenses desk → TARA JOURNAL (Dr expense / Cr `Creditors: <vendor>`), trip P&L retro-adjusted, row stamped with `voucher_id`.

**Office controls:** gate, login, block, archive, edit, features (`vend.*`), sessions, bill approve / edit-before-approve / reject with reason (Smart Approval Desk), view-as preview.

### 3.4 Driver — own & attached fleet (driver app · `src/DriverPortal.tsx`, routes `driverPortal.routes.js`)

**Sees:** current duty (trip rows *without* freight, margin, office notes — the SELECT list is explicit), own khata, own documents.
**Can do (staging):**
| Action | Route | Lands in | State | Becomes core when |
|---|---|---|---|---|
| Upload POD / toll / fuel / other paper | `POST /portal/driver/documents` | `partner_documents` | `PENDING` | desk approve; a bill auto-files into `expense_approvals` PENDING, then the money approval |
| Ask for advance / fuel / expense / leave | `POST /portal/driver/requests` | `driver_requests` | `PENDING` | Driver Master approve / pay → `driver_transactions` |
| Send GPS | `POST /tracking/ping` | `trip_gps_pings` | telemetry | never "approved" — it is not a business fact |

**Never sees:** freight, rates, other drivers' trips, any file outside `up/driver/<id>/…` and `drivers/<id>/…`.
**Office controls:** gate (the only driver-side switch today), block, archive, edit, sessions, login link, master approval (`approval_status`), request approve/pay.

### 3.5 Market driver (a partner's driver · `market_drivers`)

Not a user. The partner registers them; the office approves (`System Active`), blocks, or rejects with a reason the partner sees. Until 2026-09-02 no staff screen existed for this — the Access Hub's Market Drivers tab is that screen.

### 3.6 Office staff (`users`, screen `UGER`)

Role + per-module grants (`permissions.grants`), 2FA, `account_status` PENDING/ACTIVE/SUSPENDED, sessions revoked on suspend. Two admin-only actions everywhere in this document: **ADMIN / SUPER_ADMIN** (`requireAdminRole`). Non-admin staff may read queues but not decide them (server-enforced from this release, section 8).

---

## 4. Staging-to-production matrix (the quarantine, table by table)

| Staging table | Filled by | Pending state | Approve where | Core effect of APPROVE | TARA |
|---|---|---|---|---|---|
| `onboarding_applications` | public KYC form | `SUBMITTED` | KYC Approvals | gate opened, `vendor_kind='FLEET_PARTNER'`, login created | — |
| `partner_documents` | driver app, partner app | `PENDING` | Pending Expenses → App Uploads (drawer) | document verified; bills → `expense_approvals` (still PENDING) | — |
| `expense_approvals` | service-vendor portal, partner-doc approval, staff manual/AI entry, e-mail parser | `PENDING` | Pending Expenses (drawer: approve / edit / reject / print) | `ledger_entries` JOURNAL, `trips.total_expense`, settlement re-finalised | yes |
| `driver_requests` | driver app | `PENDING` | Driver Master | `driver_transactions` on pay | yes (pay) |
| `market_vehicles` | partner app | `PENDING APPROVAL` | Market Vehicles / Command Deck | truck may be assigned to settlements | — |
| `market_drivers` | partner app | `PENDING APPROVAL` | Access Hub → Market Drivers | driver may be named on a truck | — |
| `bazaar_loads` | customer app | `PENDING_REVIEW` → `OPEN` → `AWARD_REQUESTED` | Bazaar Admin (review, award-review) | `awardInTx`: bid ACCEPTED, settlement opened | — |
| `bazaar_bids` | partner app | `PENDING` | award review | ACCEPTED / REJECTED | — |
| `bazaar_settlements` | partner app (confirm, assign, POD) | `POD_SUBMITTED` | Bazaar Admin (POD verify; deposit / advance / balance) | market-segment vouchers | yes (admin routes only) |
| `trip_gps_pings`, `maps_cache`, `agent_events`, `share_links` | telemetry, cache, event outbox, share-link open counter | — | — | none — not business facts | — |

Everything not in this table — `trips`, `ledger_entries`, `vouchers`, `customers`, `vendors`, `drivers`, `vehicles`, `users`, `invoices`, `driver_transactions`, … — is **core** and unreachable for an external session.

---

## 5. Office-side permissions — who may do what on the office side

| Action | VIEWER / DISPATCH / ACCOUNTS | ADMIN / SUPER_ADMIN |
|---|---|---|
| See queues (expenses, partner docs, KYC, bazaar) | read (per UGER grants) | yes |
| Approve / edit / reject an expense or partner document | **no** (server 403 since this release) | yes |
| KYC approve/reject, market truck/driver approve | no | yes |
| Award review, POD verify, settlement money | no | yes |
| Gate, block, archive, features, sessions (Access Hub) | no (screen is admin-only in sidebar and API) | yes |
| Role matrix | no | yes |
| View-as preview | no | yes (read-only) |
| Staff users (UGER) | no | yes; SUPER_ADMIN rows protected from ADMIN |

---

## 6. The physical guard — `server/lib/staging.js`

- An `AsyncLocalStorage` request context is opened in an `onRequest` hook **after** `apiGuard` has authenticated the caller. It records `role`, `method`, `path`, and `external = (no session) OR role ∈ {DRIVER, VENDOR, CUSTOMER} OR scope TRACK_ONLY`.
- `db/pool.js` calls `assertExternalWrite(sql)` on every `query()` and on every statement inside `withTransaction()` (the client handed to the callback is a proxy). If the context is external and the SQL writes (`INSERT INTO`, `UPDATE`, `DELETE FROM`, DDL) a table outside `STAGING_TABLES`, the statement is refused with `403 STAGING_ONLY` before it reaches PostgreSQL, the transaction rolls back, and the refusal is logged with role, path and table.
- `/api/v1/auth/*` is exempt: those routes act on the caller's own credential rows (`auth_otp`, `auth_sessions`, own `users` row) by design and are already confined by `apiGuard`.
- Modes: `STAGING_GUARD_MODE=enforce` (default) · `report` (log only) · `off`. Flip to `report` only to diagnose, never to ship.
- Adding a table to `STAGING_TABLES` is a deliberate, reviewed act: it must be a quarantine table (rows wait for APPROVE) or telemetry — never a ledger, a trip table, or a master.
- Limits: SQL-level, so a *function* that writes (`SELECT post_voucher(...)`) is not seen; no external route calls one, and apiGuard's prefix allow-list is the second fence.
- Self-test: `node scripts/staging-selftest.mjs`.

---

## 7. The two screens

**Access Control Hub** (`src/AccessHub.tsx`, API `server/modules/access.routes.js`, sidebar → Master Admin Setup, admin-only). One table per party kind — Customers, Fleet Partners, Service Vendors, Drivers, Market Drivers — with: the derived access state (ACTIVE / PENDING / BLOCKED / ARCHIVED), login presence and last login, live sessions, inline edit of name / mobile / email, per-party feature toggles, an audit timeline, and four decisions: **Activate** (opens the gate, re-activates an archived row, creates the login if missing, WhatsApp notice), **Block** (closes the gate, suspends the login, deletes sessions; reason recorded), **Archive** (block + `status='ARCHIVED'`; never a DELETE — a party with ledger history must stay referenceable), **Edit**. A quarantine strip on top shows every staging queue's pending count. The Role Matrix tab hosts the role-wide page/field toggles. Every decision is written to `access_hub_audit` (migration 131).

**Smart Approval Desk** (`src/components/ApprovalDrawer.tsx`). "View" on an expense bill, an app upload, or a POD opens a drawer with the document rendered in place (PDF in an iframe, photo as an image, token-fetched from the vault), the row's fields editable in place, and the decisions next to the document: **Approve** (with the edited fields, `PATCH /queues/expenses/:id` then approve), **Reject** (reason mandatory; the uploader is told on WhatsApp), **Print**, **Open in new tab**. Wired into Pending Expenses (both queues) and Bazaar Admin settlements (POD verify).

---

## 8. Gaps found in this analysis and what was done

| Finding | Decision |
|---|---|
| `queues.routes.js` approve/reject/edit routes had no admin `preHandler`; only the UI hid the buttons | added `requireAdminRole` to expense PATCH/approve/reject and partner-document approve/reject |
| Partner-app bills filed into `expense_approvals` without the photo key, so the desk could not see the paper | approve now copies `file_key` and `vendor_id` |
| No staff screen for `market_drivers` | Access Hub → Market Drivers |
| Legacy "Vendor Portal" preview opened the hardcoded KYC page | preview now mounts the real partner app under view-as |
| Driver portal ignores the role matrix and has no `portal_features` | left as is; documented. Follow-up: add `drivers.portal_features` and route driver reads through `visibleModules` |
| UGER permission names ≠ `checkView` names in `App.tsx` (e.g. "Driver Master (DL)" vs "Driver Master") | documented; fix belongs with a UGER rewrite, not this release |
| `SIDEBAR.tsx` and `App.tsx` carry two copies of `hasPermission` | both updated for the new screen; consolidation is a follow-up |
