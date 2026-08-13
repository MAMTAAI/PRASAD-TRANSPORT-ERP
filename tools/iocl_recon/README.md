# IOCL Transportation Bill → ERP Reconciliation

Parses the IOCL "Transportation Bill" PDFs (the statements B2BPRD mails against
vendor code `11024699`), matches each billed load to the manually-entered trip
already in `prasad_erp`, and writes back **payment, TDS and GST**.

**Date window defaults to `01-04-2026 .. 21-08-2026`, both ends inclusive**, and
is enforced on both sides — PDF lines outside it are excluded, and the ERP query
is bounded by the same dates.

Override it per run rather than editing code:

```bash
--window-from 2026-04-01 --window-to 2026-08-12    # YYYY-MM-DD or DD-MM-YYYY
```

`set_window()` in `iocl_bill_parser.py` is the single source of truth; the other
tools read it through the module (`billspec.WINDOW_FROM`) rather than by
from-import, so one override binds the Gmail search, the PDF filter and the ERP
query together and they cannot drift apart. A reversed range is refused.

---

## Install

```bash
python -m pip install -r tools/iocl_recon/requirements.txt
```

That is `pdfplumber`, `psycopg[binary]` and `requests`. On a machine with no
compiler, `psycopg[binary]` matters — it ships libpq, so nothing needs building.

Apply the schema migration once:

```bash
node server/db/migrate.js
# or, directly:
psql -d prasad_erp -f server/db/migrations/009_iocl_recon.sql
```

The migration is additive and re-runnable (`ADD COLUMN IF NOT EXISTS`,
`CREATE TABLE IF NOT EXISTS`). A **dry run works without it** — you can validate
matching against real data before touching the schema.

### Why pdfplumber and not Camelot

Camelot is the usual reflex for PDF tables, and it is the wrong tool here.
`lattice` mode needs ruled cells; this bill only rules the header, so it finds
nothing. `stream` mode infers columns from whitespace and mis-splits the wrapped
`Ship-to-party` cells, which is precisely the column the match depends on.

Beyond that, three properties of the layout need code no table extractor
provides: the vehicle number is a *row* that scopes the rows beneath it,
destination names wrap onto bare continuation rows, and subtotal rows share the
money columns without being data. pdfplumber's per-word `(x0, x1, top)`
coordinates let the parser bind numbers to columns by right edge — the one
invariant this bill actually guarantees.

If you want it anyway: `python -m pip install "camelot-py[cv]"` (also needs
Ghostscript). It is not imported by anything here.

---

## Gmail (optional, one-time)

Stage 1 can pull the bills straight out of Gmail instead of you saving
attachments by hand. It needs an OAuth client from your own Google account:

```bash
python tools/iocl_recon/gmail_setup.py            # guided setup + verification
python tools/iocl_recon/gmail_setup.py --check    # status, never opens a browser
python tools/iocl_recon/gmail_setup.py --revoke   # delete the stored token
```

The script validates the client secret before Google can fail cryptically — it
catches the two usual mistakes (a **Web application** client instead of
**Desktop app**, and forgetting to add yourself under *Test users* while the
consent screen is in Testing mode). On success it surveys the mailbox and
prints every billing period it can see, so you know the coverage before any
download runs.

Scope is `gmail.readonly`. Both `gmail_credentials.json` and `gmail_token.json`
are gitignored, and the token is written `chmod 600`.

**Without Gmail**, save the attachments yourself and let `--import-from` collect
them — it reads Gmail's "Download all attachments" ZIPs directly, so it is one
click per billing period rather than one per depot:

```bash
python tools/iocl_recon/iocl_bill_automation.py --live --no-fetch --import-from
```

## Use

```bash
# 1. Extract only — no database touched.
python tools/iocl_recon/iocl_bill_parser.py BILL.pdf --json out.json --csv out.csv

# 2. Reconcile — read-only dry run, prints the report, writes report JSON.
python tools/iocl_recon/iocl_reconcile.py BILL.pdf --fy-aggregate 5000000

# 3. Commit — staging tables + trip payment/TDS/GST columns, one transaction.
python tools/iocl_recon/iocl_reconcile.py BILL.pdf --fy-aggregate 5000000 --apply

# A whole folder at once; --from-json skips re-parsing.
python tools/iocl_recon/iocl_bill_parser.py uploads/bills --json all.json --quiet
python tools/iocl_recon/iocl_reconcile.py --from-json all.json --apply
```

**Nothing is written without `--apply`.** Re-running the same bill is safe: every
key is a deterministic digest and every money column is assigned an absolute
value, never incremented, so a second run converges instead of double-counting.
(Verified against the live schema — including a re-run — in a rolled-back
transaction.)

### `--fy-aggregate` matters

TDS 194C has a ₹1,00,000 **financial-year** threshold. Left at the default `0`,
a small bill looks below-threshold and computes ₹0 TDS. Pass the freight already
received from IOCL this FY so the threshold test is answered correctly:

```bash
--fy-aggregate 5000000
```

---

## How matching works

Composite key: **vehicle + trip date + ship-to**, as specified — but PDF lines
are **aggregated onto that key first**. IOCL bills one truck-load as several
line items, one per product:

```
1  7008644452 20 10.07.2026 347334-MAA KAMLASWRI KSK 50700 ... 1,605.36
2  7008644452 10 10.07.2026 347334-MAA KAMLASWRI KSK 16730 ... 1,605.36
```

One truck, one day, one destination, two products (50700 = MS, 16730 = HSD).
Matching line-by-line would pair the same trip twice or drop half the money.

On the bills checked so far the grouping is exactly 1:1 with the invoice number
(50 invoices → 50 groups), which is the independent confirmation that a group is
a load. If a group ever gathers two invoice numbers, it says so in `notes` —
that would mean two loads merged into one and needs a human.

| Field | PDF | ERP | Rule |
|---|---|---|---|
| vehicle | `AS26AC0401` | `AS 26AC 0401` | strip non-alphanumerics, then exact. Always required. |
| date | `Date` column | `loading_date` | exact by default; `--date-tolerance N` allows ±N days, discounted so exact always wins |
| location | `194783-DARAKONA FUELLING STATION` | `194783 DARAKONA FUELLING STATION` | **ship-to code equality** (method `CODE`), else `difflib` similarity ≥ `--threshold` (method `NAME`) |

The 6-digit ship-to code is present on both sides for 414 of the 850 in-window
trips, and it carried **every** match on the 7R01 bill. Depots that use
alphanumeric codes (`ZC7B02-LPG BP -Sarpara`) fall through to name matching.

A trip can be claimed by **one** group only. Groups resolve highest-confidence
first; a loser is recorded `TRIP_ALREADY_CLAIMED` rather than overwriting. A
unique index on `iocl_recon_matches(trip_id)` enforces this in the database, so a
bug in the ranking cannot produce a double payment — it produces an error.

### Verdicts

| status | meaning |
|---|---|
| `MATCHED` | one trip, above threshold — money applied |
| `AMBIGUOUS` | 2+ indistinguishable trips (ERP has genuine same-vehicle/date/destination duplicates) — refused |
| `UNMATCHED_LOCATION` | that vehicle ran that day, but to a different destination — `notes` names where the ERP thinks it went |
| `UNMATCHED_NO_TRIP` | ERP has nothing for that vehicle on that date |
| `TRIP_ALREADY_CLAIMED` | another group won the trip on a higher score |

Everything except `MATCHED` lands in `v_iocl_recon_exceptions`. Refusing to match
costs a clerk five minutes; a wrong match corrupts the books.

---

## Tax

**TDS 194C.** Rates mirror `server/lib/taxEngine.js` exactly — 1% individual/HUF,
2% other, 20% no-PAN, thresholds ₹30,000 single / ₹1,00,000 FY. Change one,
change both.

* Base is **gross freight excluding GST**. GST is shown in its own columns on
  this bill, so per CBDT Circular 23/2017 it is not part of the TDS base.
* Default is **2%** — Prasad Transport's GSTIN `18AAKFP2339R2ZG` carries PAN
  `AAKFP2339R`, whose 4th character `F` denotes a partnership firm.
* IOCL deducts at **bill** level. The engine computes there and allocates across
  the bill's groups by largest-remainder in integer paise, so trip-wise TDS sums
  to the bill deduction exactly — no rounding dust against Form 26AS.
* `--tds-194c6` sets 0% where the small-transporter declaration (≤10 carriages +
  PAN) is on file. `--tds-pct` overrides outright.
* TDS attributable to *unreconciled* groups is reported separately. It is real
  money with nowhere to sit until those exceptions are cleared.

**GST.** IGST/CGST/SGST are logged verbatim per trip. Note the bill's
`Reverse Charge` banner: under GTA RCM the tax is discharged by IOCL, not
collected by us, so these are a **memo** — do not post them as output GST
payable. `trips.gst_reverse_charge` carries the flag.

---

## Money postings

`--post-vouchers` (requires `--apply`) posts one RECEIPT per bill through
`POST /api/v1/finance/vouchers` — TARA's API in `server/agents/tara.js`. It never
writes `ledger_entries` directly: that table is append-only by trigger, and TARA
owns the duplicate-reference and overdraft guards. `ref_no` is `IOCL-<bill_no>`,
so a replayed run is rejected by TARA's duplicate check rather than double-posted.
`--voucher-dry-run` makes TARA validate and roll back.

The amount posted is **net of TDS** — the cash IOCL actually remits:

```
Dr  <bank>              net
    Cr  IOCL                net
```

**The TDS leg is not posted.** TARA's RECEIPT voucher is two lines (Dr bank /
Cr party) with no third leg, so the complete entry —

```
Dr  <bank>                    net
Dr  TDS Receivable 194C       tds
    Cr  IOCL                      gross
```

— cannot be expressed through it today. The tool prints the pending amount after
posting; put it through as a JV, or extend `postVoucher` to accept a TDS leg on
RECEIPT the way it already does on PAYMENT.

### `--settlement-basis`

`paid` (default) sets `received_amount = gross − penalty − TDS` and
`payment_status = PAID`. `billed` leaves `received_amount` alone and sets
`BILLED`. The transportation bill is IOCL's settlement statement, so `paid`
matches how the money actually behaves — but if you reconcile the separate
*Payment Advice* PDFs against receipts, run `billed` here and let the advice
drive `received_amount`.

`--mark-settled` additionally moves `trips.status` `COMPLETED → SETTLED`. Off by
default, because `trip_settlements` is TARA's lifecycle and this tool does not
write it.

---

## What lands in the database

| object | grain |
|---|---|
| `iocl_bill_runs` | one row per PDF parsed — sha256, window, checksum verdict, warnings |
| `iocl_bill_lines` | one row per PDF line item, verbatim (a *compartment*, not a trip) |
| `iocl_recon_matches` | one row per composite group — verdict, money, trip, rejected candidates |
| `trips.*` | `billed_amount`, `received_amount`, `tds_amount`, `igst/cgst/sgst_amount`, `penalty_amount`, `iocl_bill_no`, `iocl_invoice_no`, `payment_status`, `reconciled_at` |
| `v_iocl_recon_exceptions` | the clerk's work queue |
| `v_iocl_bill_summary` | per-bill money and match rate |

`payment_status` is deliberately separate from `trips.status`: a trip can be
`COMPLETED` and unpaid for ninety days, and one column cannot hold both facts.

---

## Self-verification

The bill prints `Subtotal for Vehicle`, `Total for Bill` and `Total of All
Bills`. The parser sums what it extracted and compares against all three. A
silent mis-parse is the failure mode that costs money, so a mismatch is reported
loudly, and `--strict-checksum` makes it fatal (parser) or refuses to apply
(reconciler).

Checksums run over **every** parsed row, before the date window is applied, so
filtering cannot mask an extraction error.

Verified on the seven live bills in `Downloads/0011024699_*.PDF`
(depots 7B02, 7B03, 7B16, 7D18, 7R01, 7R02, 7T04): **all blocks reconcile**.

Exit codes — parser: `0` ok, `2` nothing extracted, `3` checksum failed under
`--strict-checksum`. Reconciler: `0` ok, `2` nothing to reconcile / migration
missing, `4` match rate below `--min-match-rate` (use it to gate a cron job).

---

## Troubleshooting

**"no extractable text (scanned image?)"** — the parser reads text, not pixels.
The B2BPRD statements are digital, but a scanned copy needs OCR first
(`ocrmypdf in.pdf out.pdf`), and OCR'd coordinates are much less reliable.

**Match rate collapses** — check `vehicle_no` spellings first; the whole match
hangs off vehicle + date. `v_iocl_recon_exceptions` with `notes` tells you
whether the ERP disagrees about the destination or has no trip at all.

**Many `UNMATCHED_NO_TRIP`** — usually the manual entry genuinely is not there.
On the 7R01 bill, loosening both `--date-tolerance` and `--allow-blank-location`
recovered nothing, which is how you tell a data gap from a matcher weakness.

**`AMBIGUOUS` on same-vehicle-same-day loads** — two ERP trips really do share
vehicle, date and destination. Add distinguishing data (challan no) or settle
those by hand.
