# Prasad Transport ERP — working notes for Claude

Transport/logistics ERP. React + Vite front end, Fastify + raw `pg` back end,
PostgreSQL (`prasad_erp`), and a 10-agent swarm in `server/agents/`.

## Layout

| path | what |
|---|---|
| `src/` | React SPA (inline styles + local Tailwind) |
| `server/index.js` | Fastify API, `http://127.0.0.1:3300` |
| `server/agents/` | the 10 Mahavidya agents; **one writer per table** |
| `server/db/migrations/` | ordered SQL; apply with `node server/db/migrate.js` |
| `server/lib/taxEngine.js` | deterministic TDS/GST rule table |
| `tools/iocl_recon/` | IOCL bill → ERP reconciliation pipeline (below) |

## Rules that are not negotiable

- **TARA owns money.** Never `INSERT` into `ledger_entries` from anywhere but
  `server/agents/tara.js`. The table is append-only by trigger, and a deferred
  constraint enforces ΣDr = ΣCr per voucher at COMMIT. A correction is a
  reversing entry, never an edit.
- **One writer per table.** Agents declare `owns.tables` and the registry
  enforces it at boot. `trips` is KALI's, `fuel_entries` is CHHINNAMASTA's, etc.
- **Money is `numeric`, parsed as string.** `pool.js` keeps NUMERIC as text so a
  15-digit rupee value never round-trips through a JS float. Do arithmetic in
  SQL or a decimal library — never in JS floats.
- **PowerShell scripts must be ASCII.** Non-ASCII breaks the scheduled tasks.

- **App data lives on `F:\Prasad_Transport_Data`, never in the repo.** `.env`
  sets `LOCAL_STORAGE_PATH` / `UPLOAD_DIR` / `LOG_DIR`, and
  `server/config/init_drives.js` lays the tree out at boot and refuses to start
  when the volume is missing rather than quietly recreating it on the wrong
  drive. Anything that writes uploads, logs or build artefacts must READ those
  variables, not `path.join(__dirname, 'logs')`. Three writers hardcoded the
  repo path and survived the 15-08-2026 move unnoticed, leaving two live log
  directories; `F:\...uilds` meanwhile still held a broken bundle because
  nothing published there automatically. Both classes of bug fail by *working*.
  Sweep leftovers with `scripts/migrate-logs-to-storage.ps1` (it skips files a
  live writer holds open — run it again after the next logon).

- **The repo's data directories are junctions, not folders.** `uploads`,
  `backups`, `reports`, `data`, `mobile-shots` and `.screenshots` all point at
  `F:\Prasad_Transport_Data`. Roughly fifteen writers across JavaScript and
  Python use the repo path, so a junction moves the bytes without moving the
  path and no writer can be "the one that was missed". Re-create them after a
  fresh clone with `scripts/consolidate-to-storage.ps1` — it is idempotent,
  refuses to move a file a process holds open, and never overwrites on merge.
  `logs` is the exception: its writers read `LOG_DIR` directly, because the
  healer *tails* those files and reader and writer have to agree on one path.

- **Pushing `main` is deploying.** `deploy/aws/ci-deploy.sh` runs on the AWS box
  from cron every 3 minutes: it fetches `origin/main`, fast-forwards, and
  `pm2 restart`s the API, the web app and the AI bridge. There is no approval
  step and no confirmation — the push *is* the release, with a three-minute
  fuse. On 16-08-2026 six commits reached production this way during what
  everyone involved believed was ordinary committing.

  **Work goes to `upgrade-2026`. `main` is the approval gate.**

  ```bash
  git push origin upgrade-2026                          # normal
  PRASAD_DEPLOY_APPROVED=1 git push origin main         # deliberate release
  ```

  Enforced by `.githooks/pre-push` (`core.hooksPath=.githooks`), which refuses a
  `main` push without that variable. A fresh clone must run
  `git config core.hooksPath .githooks` once — hooks are not cloned.

---

# OPERATIONAL SKILL: IOCL Bill Automation

**Trigger — "Claude, run the IOCL Bill Automation"** (or "process the IOCL
bills" / "reconcile the IOCL statements"). On this trigger, run the pipeline
end-to-end and report the final summary.

Full instructions: `.claude/skills/iocl-bill-automation/SKILL.md`
Reference docs: `tools/iocl_recon/README.md`

## What it does

Five stages, one command:

1. **Fetch** — pull IOCL Transportation Bill PDFs from Gmail into
   `uploads/iocl_bills/`, bounded by the date window. Skips cleanly (does not
   fail) when no OAuth client is configured.
2. **Parse** — `iocl_bill_parser.py`, pdfplumber word-coordinates. Handles the
   vehicle sub-header hierarchy, wrapped `Ship-to-party` cells, and
   name-glued-to-material tokens. Self-checks against the bill's printed
   subtotals.
3. **Match** — vehicle + trip date + ship-to, **aggregated per load first**
   (IOCL bills one truck-load as several product line items).
4. **Post** — trip payment, TDS 194C, GST; RECEIPT voucher through TARA.
5. **Recover** — shortage penalty debited to the trip driver's ledger.

## Commands

```bash
python tools/iocl_recon/iocl_bill_automation.py            # dry run (default)
python tools/iocl_recon/iocl_bill_automation.py --live     # commit
python tools/iocl_recon/iocl_bill_automation.py --live --no-fetch

# different period — never edit the constants, pass the window
python tools/iocl_recon/iocl_bill_automation.py --live \
  --window-from 2026-04-01 --window-to 2026-08-12
```

Dry run first, always. Nothing writes without `--live`.

`--window-from/--window-to` bind the Gmail search, the PDF line filter and the
ERP trip query together, so those three can never disagree about the period.

## Fixed configuration

| | |
|---|---|
| Date window | default **01-04-2026 .. 21-08-2026** inclusive; override per run |
| `DEFAULT_BANK_LEDGER_ID` | **SBI (8490)** |
| TDS | 194C @ 2% (firm with PAN), base = gross freight excl. GST |
| GST | logged as a **memo** — reverse charge, discharged by IOCL, not our output tax |

## Accounting shape

```
Dr  SBI (8490)              net cash remitted
Dr  TDS Receivable 194C     withheld from us (asset, Loans & Advances)
    Cr  INDIAN OIL CORPORATION LTD    gross receivable, cleared
```

`postVoucher` infers the TDS side from the voucher type: RECEIPT → asset (Dr),
PAYMENT → liability (Cr). CONTRA with TDS is refused.

## Safety properties

- Idempotent. Re-running converges: deterministic digest keys, absolute money
  assignment, and TARA returns `409 DUPLICATE_REF` on a replayed voucher.
  **409s on a re-run are correct, not a bug.**
- Refuses rather than guesses. `AMBIGUOUS` / `UNMATCHED_*` go to
  `v_iocl_recon_exceptions` for a human. Do **not** loosen `--threshold`,
  `--date-tolerance` or `--allow-blank-location` to inflate the match rate —
  loosening recovered nothing on the tested bills, so a low rate means the ERP
  is missing trips.
- One trip can be settled by one bill group only (unique index).

## Status as of 2026-08-12

Migrations `009_iocl_recon.sql` and `010_iocl_open_items.sql` applied. Gmail
fetch is live (`prasadtransport699@gmail.com`, `gmail.readonly`). Window
01-04-2026 → 12-08-2026 posted: **238 of 330 loads matched (72.1%)**,
₹78,90,465.88 gross, ₹1,57,809.32 TDS, ₹3,94,523.24 GST, ₹76,91,068.85 received
into SBI (8490), 29 vouchers (87 legs), 7 driver recoveries ₹57,346.31.
Voucher-era ledger imbalance: 0.00.

Still unmatched: all of April and 01-15 May. Those bills exist in Gmail but the
ERP trips for those fortnights do not line up — a data question, not a matcher
one.

**Open items:** bills where penalty exceeds freight get no voucher and stay open
to net against a later remittance (`v_iocl_open_items`). One live:
`11024699AS26075`, ₹5,970.52 owed to IOCL. Trip marked `DISPUTED`,
`received_amount = 0` — never a negative figure.

~~**Known gap:** driver shortage recovery writes `driver_transactions` but has no
GL journal leg~~ — **CLOSED.** TARA has a JOURNAL voucher type, and
`POST /ops/trips/:id/unload` posts the recovery's GL leg in the same transaction
as the khata row.

---

# Vehicle loans: step-up EMIs and the ledger statement (2026-08-18)

29 loans, two lenders, and an EMI that is **never flat**. Every TATA contract
steps up — a low run while the truck is being bodied, then the contractual
instalment — and disbursal is not one month before the first EMI.

## The shape of a loan

```
5004384745   AS 26C 9816   disbursed 14-07-2022   first EMI 11-09-2022 (59 days)
  001-001     30,301        the odd first month
  002-006     30,285        five low instalments
  007-058    112,987        the contractual EMI
```

| table | what |
|---|---|
| `loan_emi_tiers` | the step-up pattern, one row per tier |
| `loan_instalments` | every instalment, `MODELLED` or `LENDER_STATEMENT` |
| `loan_receipts` | what the lender banked, on its dates — **not** `emi_payments` |
| `loan_charges` | LPC, bounce, legal, repossession; `is_penal` separates arrears from fees |

- **`tenure_months` is the TERM; `instalment_count` is the instalments.** They
  are not the same number and they used to be the same column — TATA prints
  "No.of Instls 058" while IndusInd runs a 60-month facility that collects 58
  after a two-month moratorium. `tenure_months = moratorium_months +
  instalment_count` on all 29; `v_loan_term_check` must stay empty.
- **A deferred trigger enforces the tiers.** They must start at 1, not overlap,
  leave no gap, and end on `instalment_count`. A gap means two months are never
  billed and the total still looks plausible — the failure a jsonb array could
  not catch. Rewrite tiers **inside a transaction** (`syncTiers`); statement-by-
  statement the deferred check fires mid-rewrite.
- **`loan_receipts` is the lender's book; `emi_payments` is ours.** They will
  not agree row for row. The gap between them *is* the reconciliation — merging
  them destroys the only evidence a payment went missing.

## The moratorium

`buildSchedule` takes `disbursal` and reports `lead_period_days` /
`moratorium_months`. **The lead-period interest is NOT capitalised** — that was
tested, not assumed: capitalising moves the solved rate *away* from the printed
IRR on all three contracts that print both (10.8625% vs 10.5301% plain, 10.1836%
capitalised). TATA discloses the lead period and amortises the raw finance
amount from the first instalment date.

Due dates are **clamped to month end**. A 31st due date used to roll to 3 March
and 1 May, silently skipping two months. It never fired live — these loans
collect on the 2nd, 7th, 11th and 24th — which is why it needed a test.

```bash
npm run loans:selftest        # 21 checks, no database
```

## Opening balance — strictly before, both sides

```
  instalments due  <  cut-off
- payments cleared <  cut-off
+ penal charges raised < cut-off
```

`loan_opening_balance(p_as_of date DEFAULT '2026-04-01')` — a **function**, so
the period is an argument, never an edit. Struck at 01-04-2026 it reproduces
TATA's own printed "Overdue Installment" to the rupee (5004384745: ₹3,37,958.00).

Two figures stay **outside** the total and are printed beside it:

- **undated penal charges** — the lender states a balance and no date; a cut-off
  cannot be applied to a figure that has none (₹4,17,240.90 across the fleet);
- **accrued overdue interest** — TATA's per-instalment ODC is an accrual it
  discloses, *not* a sum it has debited (₹1.65 lakh accrued against ₹13 of LPC
  actually charged on one contract). Adding it would invent arrears.

## Loading a lender statement

```bash
python tools/loan_recon/loan_ledger_parser.py --dir "<folder of PDFs>" \
       --json reports/loan_bills/tata_ledgers.json
node -r dotenv/config scripts/load-loan-statements.mjs              # dry run
node -r dotenv/config scripts/load-loan-statements.mjs --commit
```

The parser reads **coordinates, not text**: a demand and a receipt are identical
in flat text and differ only by which column the amount lands in. Read as text,
every receipt becomes a demand and the account appears to owe twice what it
does. It refuses any statement that does not reproduce the lender's own printed
control totals — all 27 reconcile.

Import is **idempotent by replacement**, one transaction per loan. `MODELLED`
instalments the lender has not raised yet survive, so the statement still runs
start to end.

`v_loan_ledger_health.drift` must be 0 — the instalments the lender *raised*,
less its receipts, must equal the closing balance it printed. It excludes future
modelled instalments; comparing all of them reported 16 of 29 loans as broken
when none were.

## The statement

`GET /api/v1/loans/ledger?loan_no=…&as_of=…` → header, opening balance, charges,
health and all 58 rows in one response. `src/LoanLedgerStatement.tsx` renders it;
**Loan & EMI Mgmt → 📜 LEDGER STATEMENT**.

Printing uses `@media print` on the page itself, not `window.open` +
`document.write` like the vouchers do. A 58-row statement written twice is two
implementations that drift, and the page the auditor signs stops matching the
one the operator checked. The shell is blanked with `visibility`, not
`display:none` — the component cannot know how the sidebar is nested.

Payments are allocated **FIFO**, because TATA does not allocate receipts to
instalments at all (47 demands, 39 receipts, one running balance). Earlier
arrears discharge first; that is what reproduces the lender's own balance.

## The dashboard's headline figure

`GET /api/v1/loans/due-summary` → **TOTAL EMI DUE (CURRENT & OVERDUE)**, the
card that used to read TOTAL BANK LIABILITY. Principal outstanding is true and
unactionable — it does not move when an EMI is paid or missed — so it is now a
small badge with a tooltip, and it is sourced from a stale denormalised counter
anyway (see [Dead denormalised columns]).

```
loan_emi_due(p_through date DEFAULT <end of current month>)
  instalments due <= p_through that the money has not reached   (FIFO)
+ penal charges outstanding
```

- **One payment book per loan, lender first.** `v_loan_payments_effective` is
  where that rule lives. `loan_receipts` is the lender's record and
  `emi_payments` is ours; summing both double-counts every TATA instalment,
  while using only the lender's reports **₹16 lakh of phantom arrears on the
  three IndusInd loans**, whose EMIs were paid on the day they fell due and
  exist only in our book.
- **Undated penal charges count only when `p_through >= CURRENT_DATE`.** There
  is no cut-off in "what do we owe now", so they are in — that is why the
  dashboard figure includes the ₹4.17 lakh the ledger statement leaves out.
  Backdate the query and they drop out, because an undated figure cannot be
  placed before a cut-off. Asked for 01-04-2026 the function returns
  ₹41,25,268.17, the same fleet arrears `loan_opening_balance` computes.
- Red only when something is payable. A dashboard that is permanently red is a
  dashboard nobody reads.

## EMI Payment History

`GET /api/v1/assets/loans/payments` — every payment, **loan joined**. The screen
printed empty Vehicle No and Bank / A/C No on all 150 rows because
`emi_payments` carries `loan_id` and nothing else about the loan; the join is
server-side so no consumer has to re-answer "which truck was this". Company and
owner come from the loan, not from the copies frozen on the payment row (54
nulls and two spellings of the same firm). It replaces 29 per-loan round trips —
a bank block is one transfer covering seven trucks, so the screen needs the
fleet at once anyway.

Two data bugs the screen exposed, both fixed at the writer:

- **`emi_month` had two spellings** — `2026-04` from `/post-emis`, `Apr-2026`
  from the browser. The same month sorted apart, and the duplicate guard in
  `/post-emis` had to test both, one forgotten `OR` away from charging an EMI
  twice. Migration 081 unifies it to `YYYY-MM` and constrains the column;
  `normaliseEmiMonth` accepts either shape at the API boundary so the edit
  dialog still works. Display formats it back to `Apr-2026`.
- **`months_paid` held the instalment serial.** `/post-emis` wrote
  `months_paid = r.month_no`, so 96 payments claimed a single ₹1,12,987 transfer
  settled 44–48 months ("Block: 48 Mth" on screen). Not cosmetic: the delete
  path subtracts `months_paid` from `emis_completed`, so undoing one would have
  wound the loan back forty-eight instalments. Migration 082 moves the serial to
  `emi_payments.instalment_no` where the schedule corroborates it (all 150 did),
  resets `months_paid` to 1, and `v_emi_payment_month_check` lists anything that
  cannot be tied — a genuine multi-month settlement must not be rewritten.

### Counters (083) — and the view that mis-measured them

`/post-emis` inserted payments and never touched `loan_master`, so 108 payments
carrying ₹83.2 lakh of principal went in without the liability coming down. The
counters are now moved (083) and the route moves them in the insert's
transaction, the rule 035 set.

**Payments for months BEFORE the cut-off do not move anything.**
`opening_remaining_principal` is the balance *at* 01-04-2026 — every instalment
due before it is already inside that figure. `v_loan_reconciliation` was
subtracting all 150 payments including the 21 for Feb/Mar 2026 (₹15.6 lakh),
charging the same repayment twice; applied literally it drove seven body loans
to **minus ₹27,689**. The rule is:

```
remaining = opening − Σ principal WHERE emi_month >= opening month
```

Three body loans still overshoot by ₹49 total — the modelled opening
(₹1,12,891.27) against instalments that actually repay ₹1,12,940.51 on a loan at
its 47th of 47. Floored at zero and reported as `overpaid_vs_model`, not absorbed.

`total_interest_paid` had no frozen opening and held a partial figure on 17 loans
and NULL on 12. `opening_total_interest_paid` is frozen at **0** and the column
now means *interest paid since the cut-off* — pre-cut-off interest was paid on
paper over four years and cannot be sourced.

### CLOSED means the lender says so (085)

083 closed nine loans whose modelled principal hit zero. All nine were wrong:
TATA was still demanding **₹4,32,645 of instalments and ₹83,367 of penal
charges**, and since `loan_emi_due` excludes CLOSED loans, that came straight off
the dashboard. Principal exhausted ≠ debt discharged — the final instalments are
mostly interest, and arrears sit outside the principal entirely.

A loan closes on the lender's ledger (`raised − received <= 10`, no penal
outstanding, every instalment raised), or on modelled principal only where there
is **no** lender ledger — the three IndusInd NPAs. `v_loan_closure_check` shows
the basis; a CLOSED loan whose basis is not `settled` is wrong. Neither payment
path auto-closes any more.

### Payment blocks (084) — one cheque or RTGS, one block

`ref_no` held two things again: our per-payment voucher reference (the duplicate
guard) and the bank's UTR. Split into `instrument_ref`, which is **shared** by
every payment one transfer settled.

```
emi_batch_key(date, financier, paid_from_account, instrument_ref)
```

With an instrument, the instrument is the block; without one, the block is the
day's transfer to that financier from that account. **Not** the amount and not a
tolerance window — guessing from amounts would merge two genuine same-day
transfers, and a block that silently combines two payments is worse than
thirteen that were never combined.

114 blocks became **19**: thirteen trucks paid to TATA on 11-08-2026 are one
block of ₹14,68,831, and the six real UTRs still show their seven each.
`missing_instrument` marks the ones with no UTR on record, and the header says
so rather than showing a voucher number that looks like one.

### Read it by year, or by lender (086, 087)

`GET /api/v1/loans/ledger` now takes `loan_no`, `vehicle_no` **or `financier`**,
and every response carries `financial_years` per loan plus `group` /
`group_financial_years` when a whole lender was asked for.

- **The year is taken from the DUE date, never the payment date.** These
  accounts settle two and three months in arrears, so a February instalment paid
  in May belongs to the year it fell due in. Indian FY, 1 Apr – 31 Mar: these
  loans span **2022-23 to 2027-28**, and neither the first nor the last year is
  twelve instalments.
- `closing_arrears` is what was owed **on 31 March** — a balance at a date, not a
  running total — so it is computed in SQL and sent, never re-derived in the
  browser.
- The moratorium year shows what it should: FY 2022-23 on a 46-lakh chassis loan
  is ₹2,94,713 of instalments against ₹1,044.95 of principal, because the six
  low EMIs barely cover their own interest.
- Groups: `v_loan_financier_summary` and `v_loan_fy_by_financier`.
  `loans_with_ledger` short of `loans` is a group saying part of its own figure
  is modelled — the three IndusInd NPAs — and the statement prints that warning
  rather than averaging them in.

**One payment book everywhere.** `v_loan_ledger` used to allocate from
`loan_receipts` alone, so the three IndusInd loans showed four instalments and
no payments against them when all four were paid on the day they fell due. It
reads `v_loan_payments_effective` now — the same lender-first rule the dashboard
uses — so the statement, the year summary and the headline card cannot disagree
about whether an instalment was paid.

`contract_value` / `interest_amt` printed as `—` on all 29 loans (074 added the
columns; the import was never re-run). Backfilled as **arithmetic on the tiers**,
not re-read from the PDFs: instalments summed = ₹60,57,050 and less the finance
amount = ₹14,57,050, which is exactly what TATA prints. `v_loan_contract_check`
is empty.

## What is NOT covered

The three **IndusInd** loans (`SXB0040*`, ₹61.4 lakh) have **no instalment
ledger**. They were restructured in January 2024, are classified NPA, and the
bank sends photographs — the scanned statements carry no machine-readable text.
Arrears cannot be struck for them, so the statement prints **NOT ON RECORD** and
the book principal outstanding instead of a confident ₹0.00. `v_loan_statement_coverage`
lists them. Contract `5003502544` (matured 10-2024, fully received) is in the
PDFs but not in `loan_master`; the loader skips it rather than inventing a row.

---

# Shipping the phone apps (2026-08-17)

**Android** goes to Google Play as `com.prasadtransport.erp`. **iPhone has no
native build and is not getting one** — iOS users install the PWA from Safari.

Full runbook, store copy and every Play form answer: `play-store/README.md`.
iPhone install instructions: `docs/IPHONE-PWA.md`.

## Building a release

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-android.ps1 -Bump patch
```

Never assemble one by hand. The script bakes the production API origin into
the bundle and then refuses to hand over an AAB that does not carry it.

- **A native build is not same-origin.** Capacitor serves the app from
  `https://localhost`, so `src/lib/apiBase.ts` must resolve to an absolute
  origin. The 15-08-2026 bundle resolved to `http://127.0.0.1:3300` and told
  every handset to call itself; it installed, launched and failed every screen.
- **`https://localhost` must stay in `ALLOWED_ORIGINS`.** That is the app's
  CORS origin. Remove it and the phone app dies while the browser stays fine.
- **`import.meta.env.VITE_AGENT_API_URL` must keep that exact spelling.** Vite
  substitutes the literal text; the optional-chained form compiles to a read
  from an empty object, and the variable is set and then ignored.
- **versionCode lives in `android/version.properties`** and must increase on
  every upload. Play rejects a reused code permanently.
- The upload keystore is on `F:\Prasad_Transport_Data\keystore` and is not in
  git. It is the only way to update the listing.

---

# Firebase is gone (2026-08-14)

The app has no Firebase. `src/firebase.ts` is deleted, the `firebase` package is
uninstalled, and every screen, the WhatsApp engine and the bill parser read and
write PostgreSQL through the API. Migrations 040–046 added the last tables.

**Do not re-add a Firebase import.** If something appears to need one, the thing
it actually needs is an endpoint.

## Two things the cutover still requires

1. **Every staff password must be set again.** Firebase Auth held the
   credentials; they cannot be exported. All six `users.password_hash` values
   were the placeholder `MIGRATION-RESET-REQUIRED`, and `/auth/login` answers
   `409 PASSWORD_RESET_REQUIRED` for those accounts so the message is clear.
   Break the circle from the box itself — the endpoint needs an admin token that
   nobody can obtain yet:

   ```bash
   node -r dotenv/config scripts/set-password.mjs --list
   node -r dotenv/config scripts/set-password.mjs --email <addr> --generate
   ```

2. **OTP now goes over WhatsApp, not SMS.** Firebase sent the SMS; there is no
   gateway on this host, so `server/lib/otpChannel.js` uses the engine on :5001.
   **If that engine is not linked, no driver and no portal user can log in** —
   `GET /api/v1/auth/health` reports the channel state. Buying an SMS gateway
   means implementing one `send()` in that file and setting `OTP_CHANNEL=sms`.

## Still Firebase-shaped, on purpose

`scripts/firestore-backup.cjs` and `scripts/kg-sync-transport.cjs` use
`firebase-admin` (from `whatsapp-server/node_modules`, not the root package).
The backup script is how you take the FINAL export before disabling the project
— deleting it before that would be the one irreversible mistake here.
