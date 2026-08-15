#!/usr/bin/env python
"""Turn hand-read scanned bills into import rows — but only the ones that prove out.

THE READING IS THE RISK. These thirty bills are handwritten, so nothing
mechanical read them; a person did, from images. A misread digit here is a wrong
rupee on a real driver's khata, and unlike a parser bug it leaves no trace in
the code. So no transcription is trusted on its own say-so.

WHAT PROVES A BILL. Every one of these pumps totals its own rows, and that total
is written twice — once in figures, once in words. A transcription that is right
will reproduce BOTH the litres and the rupees the pump added up itself. One that
is wrong will not. So each bill is re-added from the rows and checked against its
printed subtotal; a bill that misses by more than 0.5% is rejected WHOLE, rows
and all, exactly as pump_bill_parser.reconcile() rejects a bad machine read.
Whole, because a partial read produces individually plausible rows that quietly
understate a payable.

The tolerance is tighter than the parser's 2% because these subtotals are added
by the pump on the same sheet, in the same ink, as the rows they total. There is
no rounding to absorb — it either adds up or it was read wrong.

CASH IS DERIVED, NEVER TRANSCRIBED. Several pumps hand the driver cash at the
counter and bill it on the same line as the diesel, so the written line amount is
fuel + cash with nothing to separate them. Rather than guess which part is which,
the diesel is computed from the two figures the pump wrote down (qty x rate) and
the cash is whatever is left over. That makes the split arithmetic instead of
editorial, and it self-checks: leftovers are cash advances, which are handed over
in whole hundreds. A remainder that is negative, or not a round hundred, means
the line was misread — so the row is flagged and the bill fails.

SUBTOTAL, NOT TOTAL. Hey krishna, Alam and Nirmala all run a cumulative account:
the bottom TOTAL is this bill's fuel PLUS the balance carried from the last bill,
and payments are netted into the carry. Reconciling against it would fail every
bill, and posting the carry line as fuel would bill the same diesel twice. Only
the subtotal — the row that totals this sheet's own fills — is used.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from decimal import Decimal, ROUND_HALF_UP

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

TOLERANCE = Decimal("0.005")      # 0.5% of the bill's own printed subtotal
CASH_STEP = Decimal("100")        # cash advances come in whole hundreds
ROUNDING_SLACK = Decimal("1.00")  # a rupee, for pumps that round their own maths


def bill_value(bill: dict) -> Decimal:
    """What this sheet's own fills came to, whatever the pump chose to print.

    Two of these pumps print only a running account balance, never a subtotal of
    the fills on the page: Pawan opens with "O/P Blance" and closes with a TOTAL
    that already has the fortnight's payments ("Paid in IOCL card", "Paid in
    BPCL") deducted. Reconciling rows against that number compares this bill's
    diesel with months of unpaid history and fails every time.

    So when a bill states an opening balance, the figure to prove the rows
    against is the running total BEFORE payments, less what was already owed on
    arrival. Payments are deliberately not subtracted here — they settle the
    account, they do not change how much fuel was drawn.
    """
    if bill.get("printed_subtotal_amount") is not None:
        return D(bill["printed_subtotal_amount"])
    return D(bill["printed_running_total"]) - D(bill.get("opening_balance", 0))


def D(x) -> Decimal:
    return Decimal(str(x))


def money(x: Decimal) -> Decimal:
    return x.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def norm_vehicle(v: str | None) -> str | None:
    if not v:
        return None
    return "".join(c for c in str(v).upper() if c.isalnum())


def expand(v: str | None, fleet: list[str]) -> tuple[str | None, str | None]:
    """Resolve a registration the pump wrote short against the actual fleet.

    John N Well writes only the last four digits — "0403", not AS26AC0403 — so
    the row cannot be matched to a truck as written, and the import route's
    edit-distance-1 fuzzy match is nowhere near close enough to bridge it.

    Expanding is only safe when it is not a choice. If exactly ONE truck in the
    fleet ends with those digits then the registration is forced: there is no
    other vehicle it could mean, and writing it out adds no information that was
    not already on the bill. If two trucks end the same way, nobody can tell
    which fuelled — so it stays as written and the row goes to a human. The same
    rule that governs the route's fuzzy match: correct a near-miss, never
    choose between candidates.

    Returns (normalised registration, note) — note is set only when expanded, so
    every expansion is visible on the row it changed.
    """
    n = norm_vehicle(v)
    if not n or n in fleet:
        return n, None
    if n.isdigit() and len(n) == 4:
        hits = [f for f in fleet if f.endswith(n)]
        if len(hits) == 1:
            return hits[0], f"expanded {n} -> {hits[0]} (only truck ending {n})"
        return n, f"{n} matches {len(hits)} trucks — not expandable"
    return n, None


def check_bill(bill: dict, fleet: list[str]) -> dict:
    """Re-add one bill from its rows and judge it against its own printed figures."""
    rows_out, notes = [], []
    sum_line = Decimal("0")
    sum_qty = Decimal("0")

    for i, r in enumerate(bill["rows"], 1):
        qty, rate = D(r["qty"]), D(r["rate"])
        line = D(r["line_amount"])

        if "cash" in r:
            # Pawan writes the counter advance on its own line under the fill it
            # belongs to, so the split is stated rather than inferred. Take it as
            # written and check the diesel still answers to qty x rate — within a
            # rupee, because this pump rounds its own multiplication.
            cash = D(r["cash"])
            diesel = money(line - cash)
            # Scaled to the row, not a flat rupee: these pumps write fractional
            # litres (50.22, 160.71) and round the product their own way, so a
            # few rupees on a 15,000 line is their arithmetic, while a misread
            # digit moves the line by a factor of ten and still trips.
            slack = max(ROUNDING_SLACK, money(diesel * TOLERANCE))
            if abs(diesel - qty * rate) > slack:
                notes.append(f"row {i}: diesel {diesel} is not {qty} x {rate} "
                             f"(= {money(qty * rate)}) — misread")
        else:
            diesel = money(qty * rate)
            cash = money(line - diesel)
            if cash < 0:
                notes.append(f"row {i}: line {line} is below diesel {diesel} — misread")
            elif cash % CASH_STEP != 0:
                notes.append(f"row {i}: leftover {cash} is not a round hundred — misread")

        sum_line += line
        sum_qty += qty
        vnorm, vnote = expand(r["vehicle"], fleet)
        rows_out.append({
            "pump": bill["pump"],
            "group": bill["group"],
            "company_hint": bill["company_hint"],
            "source_file": bill["source_file"],
            "date": r["date"],
            "vehicle_raw": r["vehicle"],
            "vehicle_norm": vnorm,
            "vehicle_note": vnote,
            "memo_no": r.get("sl") or bill.get("bill_no"),
            "product": r.get("item", "HSD"),
            "qty": float(qty),
            "rate": float(rate),
            "amount": float(diesel),          # diesel only — the route posts this as fuel
            "lub": None,
            "cash": float(cash) if cash > 0 else None,
            "total": float(line),
            "flags": ["OCR_HANDREAD"],
            "reconcile_note": None,
            "confidence": "OK",
        })

    want_amt = bill_value(bill)
    diff = abs(sum_line - want_amt)
    ok_amt = want_amt > 0 and diff <= want_amt * TOLERANCE
    if not ok_amt:
        notes.append(f"rows add to {money(sum_line)} against printed {money(want_amt)} "
                     f"(off by {money(sum_line - want_amt)})")

    ok_qty = True
    if bill.get("printed_subtotal_qty") is not None:
        want_qty = D(bill["printed_subtotal_qty"])
        ok_qty = abs(sum_qty - want_qty) <= Decimal("0.5")
        if not ok_qty:
            notes.append(f"litres add to {sum_qty} against printed {want_qty}")

    # A bill can reconcile perfectly and still carry a line that must not be
    # posted as diesel. Shivam's April bill bills two tins of engine oil on the
    # same invoice as the fuel; the import route stamps fuel_type 'HSD' on
    # everything it is given, so posting those would put 960 rupees of lubricant
    # into diesel consumption and quietly corrupt every mileage figure derived
    # from it. They are real costs and they belong to a real truck, so they are
    # kept and sent to a human rather than dropped.
    for row in rows_out:
        if str(row["product"]).upper() not in ("HSD", "DIESEL"):
            row["confidence"] = "REVIEW"
            row["flags"] = row["flags"] + ["NON_FUEL_ITEM"]
            row["reconcile_note"] = f"{row['product']} — not diesel, needs its own expense head"

    trusted = ok_amt and ok_qty and not notes
    if not trusted:
        for r in rows_out:
            r["confidence"] = "REVIEW"
            r["flags"] = ["OCR_HANDREAD", "TOTAL_MISMATCH"]
            r["reconcile_note"] = "; ".join(notes)[:400]

    return {
        "pump": bill["pump"], "file": bill["source_file"], "bill_no": bill.get("bill_no"),
        "rows": rows_out, "trusted": trusted, "notes": notes,
        "sum_line": money(sum_line), "printed": money(want_amt),
        "sum_qty": sum_qty, "printed_qty": bill.get("printed_subtotal_qty"),
        "diesel": money(sum(D(r["amount"]) for r in rows_out)),
        "cash": money(sum(D(r["cash"] or 0) for r in rows_out)),
    }


def load_bills(src: str) -> list[dict]:
    """One transcription file, or a directory of them (one per pump)."""
    if os.path.isdir(src):
        bills = []
        for fn in sorted(os.listdir(src)):
            if fn.endswith(".json") and not fn.startswith("_"):
                bills += json.load(open(os.path.join(src, fn), encoding="utf-8"))
        return bills
    return json.load(open(src, encoding="utf-8"))


def main(src: str, out_json: str | None, include_rejected: bool, fleet_file: str) -> None:
    bills = load_bills(src)
    fleet = json.load(open(fleet_file, encoding="utf-8")) if os.path.exists(fleet_file) else []
    if not fleet:
        print(f"  WARNING: no fleet list at {fleet_file} — short registrations cannot be expanded")
    results = [check_bill(b, fleet) for b in bills]

    print(f"{'PUMP':14}{'FILE':30}{'ROWS':>5}{'LITRES':>9}{'READ':>13}{'PRINTED':>13}  OK")
    print("-" * 92)
    for r in results:
        mark = "yes" if r["trusted"] else "NO"
        print(f"{r['pump']:14}{r['file'][:29]:30}{len(r['rows']):>5}{r['sum_qty']:>9}"
              f"{r['sum_line']:>13,}{r['printed']:>13,}  {mark}")
        for n in r["notes"]:
            print(f"{'':14}  -> {n}")

    expansions = {}
    for r in results:
        for row in r["rows"]:
            if row.get("vehicle_note"):
                expansions[row["vehicle_note"]] = expansions.get(row["vehicle_note"], 0) + 1
    if expansions:
        print("\n  registrations resolved against the fleet:")
        for note, n in sorted(expansions.items()):
            print(f"   {n:>4}  {note}")

    good = [r for r in results if r["trusted"]]
    bad = [r for r in results if not r["trusted"]]
    rows = [row for r in results if r["trusted"] or include_rejected for row in r["rows"]]

    print(f"\n  bills reconciling: {len(good)} of {len(results)}")
    print(f"  rows            : {sum(len(r['rows']) for r in good)}")
    print(f"  litres          : {sum(r['sum_qty'] for r in good):,}")
    print(f"  diesel          : {sum(r['diesel'] for r in good):,}")
    print(f"  cash at counter : {sum(r['cash'] for r in good):,}")
    print(f"  bill value      : {sum(r['sum_line'] for r in good):,}")
    if bad:
        print(f"\n  REJECTED WHOLE ({len(bad)}): " + ", ".join(f"{r['pump']}/{r['file']}" for r in bad))

    if out_json:
        with open(out_json, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, indent=1)
        print(f"\n  wrote {len(rows)} rows -> {out_json}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="reports/ocr_transcribed.json")
    ap.add_argument("--json", help="write import-ready rows here")
    ap.add_argument("--include-rejected", action="store_true",
                    help="also emit rejected rows (flagged REVIEW) so a human sees them")
    ap.add_argument("--fleet", default="reports/fleet_norms.json",
                    help="JSON list of fleet registrations, for expanding short ones")
    a = ap.parse_args()
    main(a.src, a.json, a.include_rejected, a.fleet)
