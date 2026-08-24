---
name: iocl-bill-automation
description: Run the Prasad Transport IOCL bill pipeline end-to-end — fetch Transportation Bill PDFs from Gmail, parse them, reconcile against ERP trips, and post payment, TDS 194C, GST and driver shortage recovery. Use when the user says "run the IOCL Bill Automation", "process the IOCL bills", "reconcile the IOCL statements", or asks to update billing/TDS/GST from IOCL bills.
---

# IOCL Bill Automation — Prasad Transport

End-to-end pipeline: Gmail → PDF → parse → reconcile → post money.
Owner tooling lives in `tools/iocl_recon/`. Full reference: `tools/iocl_recon/README.md`.

## Trigger

The user says **"Claude, run the IOCL Bill Automation"** (or any close variant).

## WHERE IT RUNS: the production box, over SSH (since 2026-08-24)

The office PC is retired as a writer (ERP_API.KILL — the local API refuses to
boot, so a local run cannot post vouchers and would reconcile against a frozen
archive). The pipeline runs ON the AWS box, where the live database and API
are both loopback-local:

```bash
SSH='ssh -i ~/.ssh/prasad-key.pem ubuntu@65.0.27.161'

# 1. DRY RUN — read-only, prints the full report
$SSH 'cd /var/www/prasad-erp && .venv/bin/python tools/iocl_recon/iocl_bill_automation.py'

# 2. LIVE — only after the dry run looks right
$SSH 'cd /var/www/prasad-erp && .venv/bin/python tools/iocl_recon/iocl_bill_automation.py --live'
```

Box facts (verified 2026-08-24): `.venv` has every dependency; both Gmail
tokens sit in `tools/iocl_recon/`; `ERP_SERVICE_TOKEN` and the PG credentials
are in the box's `.env`, which the Python reads itself; historical bills live
in `/var/lib/prasad/uploads/iocl_bills` and the repo's `uploads/iocl_bills`
is a symlink to it.

Add `--no-fetch` to skip Gmail and use whatever is already in
`uploads/iocl_bills/`. The Gmail stage needs an OAuth client; when absent it
*skips*, it does not fail.

If the user has fresh bill PDFs only on the PC, scp them into the box first:

```bash
scp -i ~/.ssh/prasad-key.pem <files> ubuntu@65.0.27.161:/var/lib/prasad/uploads/iocl_bills/
```

## Report back

Give the user the final summary block: bills processed, loads matched and the
match rate, gross freight, GST, TDS 194C, net receivable, trips updated,
receipt vouchers, driver recoveries. Then list the exceptions — every group that
did not match is real money that did not reconcile, and it is the part that
needs a human.

## Date window

Defaults to **01-04-2026 .. 21-08-2026**, both inclusive. If the user names a
different range, pass it — do not edit the constants:

```bash
$SSH 'cd /var/www/prasad-erp && .venv/bin/python tools/iocl_recon/iocl_bill_automation.py --live \
  --window-from 2026-04-01 --window-to 2026-08-12'
```

Accepts `YYYY-MM-DD` or `DD-MM-YYYY`. One override binds all three consumers of
the window at once — the Gmail search, the PDF line filter, and the ERP trip
query — so they cannot disagree.

## Other fixed parameters — do not change without asking

| | |
|---|---|
| Bank ledger | **SBI (8490)** — `DEFAULT_BANK_LEDGER_ID` |
| TDS | 194C @ 2% (firm with PAN); `--fy-aggregate` defaults high because the ₹1,00,000 FY threshold is already crossed |
| Party ledger | INDIAN OIL CORPORATION LTD |

## What it writes

- `trips` — `billed_amount`, `received_amount`, `tds_amount`, `igst/cgst/sgst_amount`, `penalty_amount`, `shortage_qty`, `iocl_bill_no`, `payment_status`
- `iocl_bill_runs` / `iocl_bill_lines` / `iocl_recon_matches` — staging + audit
- `ledger_entries` — via TARA's API only, three legs:
  `Dr SBI (8490)` net · `Dr TDS Receivable 194C` · `Cr IOCL` gross
- `driver_transactions` — `SHORTAGE_RECOVERY` against the trip's driver

## Safety properties — rely on these, don't re-verify by hand

- **Nothing writes without `--live`.**
- **Idempotent.** Re-running the same bills converges. Deterministic digests key
  every staging row, trip money is assigned absolutely (never incremented), and
  TARA answers a replayed voucher with `409 DUPLICATE_REF`. Seeing 409s on a
  re-run is correct behaviour, not an error to fix.
- **Self-verifying.** The parser checks its own totals against the bill's printed
  `Subtotal for Vehicle` / `Total for Bill` / `Total of All Bills`. Report any
  checksum FAIL prominently and do not commit that bill (`--strict-checksum`).
- **Refuses rather than guesses.** `AMBIGUOUS`, `UNMATCHED_LOCATION`,
  `UNMATCHED_NO_TRIP` and `TRIP_ALREADY_CLAIMED` are surfaced for a human. Do not
  loosen `--threshold`, `--date-tolerance` or `--allow-blank-location` to make
  the match rate look better — on the bills tested, loosening recovered nothing,
  so a low rate means missing ERP data, not a matcher problem.
- A trip can be settled by one bill group only, enforced by a unique index.

## Open items — bills that settle negative

IOCL's shortage penalty can exceed the freight it is charged against. Such a
bill gets **no voucher** (you cannot receive negative money) and, by the
owner's decision, **no payment voucher either** — the balance stays open and is
netted against a later remittance. The trip is marked `DISPUTED` with
`received_amount = 0`, never a negative figure, and the penalty is still
recovered from the driver.

The register is `v_iocl_open_items`. Check it after every run and report any
row — an empty view is the healthy state:

```sql
SELECT * FROM v_iocl_open_items;
```

When a later bill's remittance nets one off, that is a manual accounting step;
this pipeline does not clear open items on its own.

## Duplicates

Gmail delivers the same bill more than once — the identical attachment resent,
and consolidated re-issues (`7B03_01-30.06` contained exactly the union of
`01-15.06` and `16-30.06`, same bill numbers). The pipeline dedupes on
`line_uid` before matching, which catches both. Expect the run to report
removals; that is normal, not an error.

Money was never at risk from duplicates — trip claiming, the unique index on
`iocl_recon_matches(trip_id)` and TARA's duplicate-reference guard each block
double-posting — but the audit trail was, so the dedupe stays.

## Known gap

The driver shortage recovery posts to `driver_transactions` (the per-driver
subsidiary ledger) but has **no GL journal leg** — `Dr Driver Advance: <name> /
Cr Shortage Recovery` needs a JOURNAL voucher type that TARA does not have
(RECEIPT/PAYMENT/CONTRA only). This matches how the other 293 driver
transactions behave. Mention it if the user asks about GL completeness.
