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
