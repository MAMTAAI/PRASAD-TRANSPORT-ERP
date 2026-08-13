# Firebase → AWS PostgreSQL migration

**Target architecture:** Node.js (Fastify) + PostgreSQL on AWS (RDS · EC2 · S3).
Firebase is being retired completely. This document tracks what has already
been removed, what is still live, and the order the rest must come out in.

---

## Status

### Removed (done)

| Artifact | What it was |
|---|---|
| `.firebase/` | Hosting deploy cache (`hosting.ZGlzdA.cache`, `bridge.js`) |
| `functions/` | Cloud Functions codebase — logic archived, see below |
| `functions/firebase-debug.log` | 121 KB CLI debug log |
| `firebase.json` | Hosting / Firestore / Storage / Functions deploy config |
| `.firebaserc` | Project + hosting target aliases (`prasad-transport-grup`) |
| `firestore.rules` · `storage.rules` | Security rules |
| `firestore.indexes.json` | Composite index definitions |
| `dist/assets/vendor-firebase-*.js` | Compiled Firebase SDK bundle chunk |
| `scripts/enable-anonymous-auth.cjs` | Firebase anonymous-auth enablement helper |

The deploy path to Firebase is now closed — nothing in the repo can push to
project `prasad-transport-grup` any more.

Archived under `server/_legacy-firebase/` for porting, not for use:

- `cloud-functions-to-port.js` — `mamtaVoice` (HTTP) and `generateAutoBill`
  (callable). Both must be re-implemented as Fastify routes.
- `firestore.rules.reference` / `storage.rules.reference` — the authorisation
  model to reproduce in the API's RBAC middleware. Rules were the *only* thing
  enforcing access control on the data; that enforcement has to exist in the
  API layer before the SPA stops talking to Firestore directly.

### Still live — deliberately, and why

These four cannot be deleted yet without breaking the running business or
losing data:

| Artifact | Why it must stay for now |
|---|---|
| `src/firebase.ts` | Imported by **62 of 96** source files, backing **496** Firestore call sites. It also holds the *only* pointer to project `prasad-transport-grup` — deleting it before export orphans the live data. |
| `scripts/firestore-backup.cjs` | The export path. This is the tool that reads live Firestore into JSON for loading into PostgreSQL. It is migration infrastructure. |
| `backups/firestore-backup-*.json` | 2.5 MB snapshot of real business data. Currently dated **2026-06-14** — roughly two months stale, so a fresh export is required before cut-over. |
| `firebase` npm dependency | Removed once the last `src/` import is gone. |

---

## Live data to migrate

Counts from the 2026-06-14 snapshot (live totals will be higher):

| Collection | Rows | → target |
|---|---:|---|
| `TRIPS` | 552 | `trips` (002) |
| `LEDGER_ENTRIES` | 220 | `ledger_entries` (003) |
| `FUEL_ENTRIES` | 217 | `fuel_entries` |
| `RTKM_MASTER` | 179 | `rtkm_master` |
| `DRIVER_TRANSACTIONS` | 112 | `driver_transactions` |
| `LEDGERS` | 106 | `ledgers` (003) |
| `Vehicle_Assignments` | 52 | `vehicle_assignments` ✅ **schema ready** |
| `VEHICLES` | 50 | `vehicles` ✅ **schema ready** |
| `DRIVERS` | 49 | `drivers` ✅ **schema ready** |
| `VENDOR_TXNS` | 18 | `vendor_txns` |
| `LOAN_MASTER` | 17 | `loan_master` |
| `VENDORS` | 13 | `vendors` |
| `USERS` | 5 | `users` ✅ **schema ready** |
| `CUSTOMERS` | 4 | `customers` |
| `COMPANIES` / `COMPANY_BANKS` | 3 / 3 | `companies` ✅ **schema ready** |
| `DRIVER_REQUESTS` | 3 | `driver_requests` |
| `BAZAAR_LOADS`, `SAVED_DOCUMENTS` | 2 each | — |
| `BANK_TRANSACTIONS`, `SETTINGS`, `WEBSITE`, `WA_*` | 1 each | — |

### Data problems the relational schema fixes

Worth knowing before writing the loaders — these are real defects in the
current data, not hypotheticals:

1. **Three spellings of one field.** `TRIPS` carries `Vehical_No` (typo),
   `Vehicle_No`, *and* `vehicle_no`. Same for `Trip_ID`/`trip_id`,
   `Loaded_Qty`/`loaded_qty`, `Unloading_Date`/`unloading_date`. The loader
   must coalesce these; the schema then makes one column the only option.
2. **Duplicate master records.** Registration numbers are stored
   inconsistently spaced (`"AS 19C 8666"`), so the same truck can exist twice.
   `vehicles.vehicle_no_norm` with its unique index makes that unrepresentable.
3. **Dates as strings.** `license_expiry: "2031-03-03"` is text, so "what
   expires in 30 days" requires reading every document. Now a `date` column
   with an index.
4. **Plaintext passwords.** `USERS.password` exists as a field. The `users`
   table has `password_hash` only — no column a plaintext secret can occupy.
   Existing credentials must be re-hashed (bcrypt) during load, or reset.
5. **`LEDGERS` field drift.** `ledger_name`/`name`, `group_head`/`group`,
   `opening_balance`/`op_balance` are duplicate pairs.

---

## Cut-over order

Migrations 001 → 003 build bottom-up, because trips FK to vehicles and drivers,
and ledger entries FK to trips.

- [x] **001_core.sql** — `companies`, `users`, `vehicles`, `drivers`,
      `vehicle_assignments` + `v_fleet_current`
- [ ] **002_dispatch.sql** — `customers`, `consignees`, `rtkm_master`,
      `rate_master`, `trips`, `trip_expenses`, `fuel_entries`
- [ ] **003_ledger.sql** — `ledgers`, `ledger_entries`, `journal`,
      `invoices`, `payments`, `settlements`

  Ledger design note: `ledger_entries` gets a
  `CHECK (dr_cr IN ('DR','CR'))` plus a per-voucher balance constraint, so an
  unbalanced journal entry cannot be committed. The document store had no way
  to enforce that, which is the single strongest reason for this move.

- [ ] **004_ops.sql** — tolls, FASTag, fleet cards, tyres, batteries, WhatsApp CRM

### Then, per module

1. Write the loader (`server/db/seed/from-firestore.js`) keyed on `legacy_id`
   with `ON CONFLICT (legacy_id) DO UPDATE`, so it is re-runnable.
2. Build the API routes (pattern: `server/modules/vehicles.routes.js`).
3. Repoint the SPA module from Firestore calls to `fetch` against the API.
4. Only when a module's last Firestore call is gone, delete that import.

`src/firebase.ts` is deleted last, when the count hits zero:

```bash
grep -rn "from 'firebase" src/ | wc -l    # 66 today → must reach 0
```

Then `npm uninstall firebase`.

---

## Parallel-run safety

Do not flip the SPA to PostgreSQL and delete Firebase access in one step. Run
both for at least one full billing cycle:

- PostgreSQL is written and read as the system of record.
- A fresh Firestore export is kept as a rollback point (`legacy_id` makes every
  row traceable back to its source document).
- Reconcile before decommissioning: trip counts, ledger closing balances, and
  outstanding-per-customer must agree between the two systems.

Only after a clean reconciliation should the Firebase project itself be
disabled in the console — that is the irreversible step, and it is the last one.

---

## AWS provisioning checklist

- [ ] RDS PostgreSQL 16, `db.t4g.micro` to start, **Publicly accessible = No**
- [ ] Security group: inbound 5432 from the EC2 security group only
- [ ] Automated backups on, 7-day retention minimum, deletion protection on
- [ ] Credentials in AWS Secrets Manager, not in `.env` on the box
- [ ] Download the RDS CA bundle and set `PGSSL_CA_PATH` — without it the
      connection is encrypted but unverified, and `pool.js` warns on every boot
- [ ] S3 bucket `prasad-erp-documents`, all public access blocked, versioning on
- [ ] EC2 instance IAM role for S3 — no access keys on disk in production
- [ ] Add the API to `deploy/aws/ecosystem.prasad.config.cjs` (PM2) and proxy
      `/api/` to `127.0.0.1:3300` in `nginx-prasadtransport.conf`
- [ ] Extend `deploy/aws/weekly-backup.sh` with `pg_dump` — the existing script
      backs up the old data path and does not know about PostgreSQL yet
