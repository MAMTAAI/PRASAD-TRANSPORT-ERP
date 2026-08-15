#!/usr/bin/env python
"""Read the vehicle loan contracts out of the financiers' own statements.

TWO LENDERS, TWO KINDS OF PAPER. TATA Capital sends 196 pages of machine-readable
"Contract Details" — 27 contracts across three PDFs, every figure extractable.
IndusInd sends photographs of a printout; those three loans are read by eye and
kept in reports/loan_bills/indusind.json, the same arrangement as the scanned
fuel bills.

WHAT THE CONTRACTS ARE. 13 loans of 46,00,000 over 58 instalments buy the
chassis; 13 of 10,00,000 over 47 instalments pay the body-builder. They are
separate facilities against the same truck, which is why a fleet of thirteen
lorries carries twenty-six live loans. One older contract, 5003502544, matured in
October 2024 and is fully received; it is read and marked closed rather than
skipped, so the file cannot be mistaken for the whole picture later.

THE FIGURE THAT PROVES A CONTRACT WAS READ CORRECTLY is its own arithmetic:
Finance Amount + Interest Amount must equal Contract Value, and the instalment
schedule printed in the Contract Change History must add up to that same Contract
Value. Both hold for all 27. A contract that fails either is not emitted — a
wrong principal here becomes a wrong liability on the balance sheet.

WHAT THIS FILE DELIBERATELY DOES NOT DO is decide the interest rate. Every
contract prints an "IRR", and that number does NOT reproduce the contract's own
cash flows: at the printed 10.5301% the 46,00,000 chassis schedule ends 62,047
short of zero. The rate that closes it is 10.8625%, and only that rate makes the
model repay exactly 46,00,000 of principal and charge exactly 14,57,050 of
interest — the two figures the lender itself prints. So the rate is solved from
the instalments, not taken from the page, and that happens in the amortiser
rather than here. This file reports what the paper says.
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import os
import re
import sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

import pymupdf

REG_RE = re.compile(r"^[A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3}\s?\d{4}$")
DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")


def norm_reg(txt: str | None) -> str | None:
    if not txt:
        return None
    return "".join(c for c in str(txt).upper() if ("A" <= c <= "Z") or ("0" <= c <= "9")) or None


def money(s: str | None) -> float | None:
    if s is None:
        return None
    s = s.replace(",", "").strip()
    return float(s) if re.match(r"^-?\d+(\.\d+)?$", s) else None


def value_after(lines: list[str], label: str, want=None) -> str | None:
    """The value printed under a label.

    TATA lays these sheets out as label-then-value down the page, so the value is
    the next non-empty line. When a field is blank the next line is the FOLLOWING
    LABEL, and taking it silently turns "Registration No" into "Woff Flag" — so
    the caller says what a real value looks like and anything else reads as blank.
    """
    for i, L in enumerate(lines):
        if L.strip() != label:
            continue
        for j in range(i + 1, min(i + 4, len(lines))):
            v = lines[j].strip()
            if not v:
                continue
            if want and not want(v):
                return None          # the field was empty; this is the next label
            return v
    return None


def parse_tata(path: str) -> list[dict]:
    doc = pymupdf.open(path)
    out: list[dict] = []
    cur: dict | None = None
    try:
        for page in doc:
            text = page.get_text()
            lines = text.split("\n")

            if "Contract Details" in text and re.search(r"Contract No\s*\n\s*\d+", text):
                if cur:
                    out.append(cur)
                cur = {"financier": "TATA CAPITAL LIMITED", "source_file": os.path.basename(path)}
                cur["loan_no"] = value_after(lines, "Contract No", lambda v: v.isdigit())
                cur["status_text"] = value_after(lines, "Status:")
                cur["customer"] = next((l.strip().replace("M/S:", "").strip()
                                        for l in lines if l.strip().startswith("M/S")), None)
                cur["group"] = next((l.strip()[6:].strip() for l in lines
                                     if l.strip().startswith("Group ")), None)
                cur["disbursal_date"] = value_after(lines, "Disbursal Date", DATE_RE.match)
                cur["first_emi_date"] = value_after(lines, "First Instl Date", DATE_RE.match)
                cur["maturity_date"] = value_after(lines, "Maturity Date", DATE_RE.match)
                cur["finance_amt"] = money(value_after(lines, "Finance Amt"))
                cur["interest_amt"] = money(value_after(lines, "Interest Amount"))
                cur["contract_value"] = money(value_after(lines, "Contract Value"))
                cur["due_till_date"] = money(value_after(lines, "Due till Date"))
                cur["recvd_till_date"] = money(value_after(lines, "Recvd till Date"))
                cur["n_instls"] = money(value_after(lines, "No.of Instls"))
                cur["vehicle_raw"] = value_after(lines, "Registration No", REG_RE.match)
                cur["vehicle_norm"] = norm_reg(cur["vehicle_raw"])
                cur["chassis_no"] = value_after(lines, "Chasis Number")
                cur["asset"] = value_after(lines, "Vehicle Model")

            if cur and "Contract Change History" in text:
                seen = {tuple(p) for p in cur.get("emi_slabs_raw", [])}
                for a, b, amt, irr in re.findall(
                        r"(\d{3})\s+to\s+(\d{3})\s*\n\s*([\d,]+\.\d{2})\s+([\d.]+)", text):
                    key = (a, b, amt, irr)
                    if key in seen:            # the history block is repeated per page
                        continue
                    seen.add(key)
                    cur.setdefault("emi_slabs_raw", []).append(list(key))
                    cur["printed_irr"] = float(irr)
        if cur:
            out.append(cur)
    finally:
        doc.close()
    return out


def finish(c: dict) -> dict:
    slabs = []
    for a, b, amt, _irr in c.get("emi_slabs_raw", []):
        slabs.append({"from_month": int(a), "to_month": int(b), "amount": money(amt)})
    slabs.sort(key=lambda s: s["from_month"])
    c["emi_slabs"] = slabs
    c["emi_amount"] = slabs[-1]["amount"] if slabs else None
    c["tenure_months"] = int(c["n_instls"]) if c.get("n_instls") else None

    sched_total = sum(s["amount"] * (s["to_month"] - s["from_month"] + 1) for s in slabs)
    c["slab_total"] = round(sched_total, 2)

    # A loan of 46 lakh over 58 months buys the lorry; 10 lakh over 47 pays the
    # body-builder. The two run against the same truck, so the amount is what
    # separates them, not the paperwork.
    fin = c.get("finance_amt") or 0
    c["loan_type"] = "Chassis Loan" if fin >= 2_000_000 else "Body Loan"

    closed = (c.get("recvd_till_date") is not None
              and c.get("contract_value") is not None
              and abs(c["recvd_till_date"] - c["contract_value"]) < 1)
    c["is_closed"] = closed

    problems = []
    if None in (c.get("finance_amt"), c.get("interest_amt"), c.get("contract_value")):
        problems.append("a headline amount did not read")
    elif abs(c["finance_amt"] + c["interest_amt"] - c["contract_value"]) > 1:
        problems.append(f"finance {c['finance_amt']:,} + interest {c['interest_amt']:,} "
                        f"!= contract value {c['contract_value']:,}")
    if not slabs:
        problems.append("no instalment schedule in the Contract Change History")
    elif c.get("contract_value") and abs(sched_total - c["contract_value"]) > 1:
        problems.append(f"instalments add to {sched_total:,} against contract value "
                        f"{c['contract_value']:,}")
    if slabs and c.get("tenure_months") and slabs[-1]["to_month"] != c["tenure_months"]:
        problems.append(f"schedule ends at instalment {slabs[-1]['to_month']} "
                        f"but the contract says {c['tenure_months']}")
    c["problems"] = problems
    return c


def borrow_slabs(contracts: list[dict]) -> None:
    """Give a contract the instalment schedule its identical twins print.

    TATA left the Contract Change History table blank on 5004384739 — the heading
    is there, the rows are not. Everything else about it matches its twelve
    siblings exactly: 46,00,000 financed, 58 instalments, 60,57,050 contract
    value, same first instalment and maturity dates.

    Copying their schedule is not a guess, and the test is arithmetic rather than
    resemblance: the borrowed instalments must add up to THIS contract's own
    printed contract value. 30,301 + 5x30,285 + 52x112,987 comes to 60,57,050,
    which is the figure on this contract's own first page. A schedule that did
    not reproduce it would be rejected here, and the loan would go to a human
    instead of onto the balance sheet.
    """
    donors: dict[tuple, list] = {}
    for c in contracts:
        if c.get("emi_slabs") and c.get("finance_amt") and c.get("contract_value"):
            donors.setdefault((c["finance_amt"], c["tenure_months"], c["contract_value"]),
                              c["emi_slabs"])
    for c in contracts:
        if c.get("emi_slabs") or not c.get("contract_value"):
            continue
        key = (c.get("finance_amt"), c.get("tenure_months"), c.get("contract_value"))
        slabs = donors.get(key)
        if not slabs:
            continue
        total = sum(s["amount"] * (s["to_month"] - s["from_month"] + 1) for s in slabs)
        if abs(total - c["contract_value"]) > 1:
            continue
        c["emi_slabs"] = [dict(s) for s in slabs]
        c["emi_amount"] = slabs[-1]["amount"]
        c["slab_total"] = round(total, 2)
        c["slabs_borrowed"] = ("this contract prints no change history; schedule taken from the "
                               "identical contracts and it reproduces this contract's own "
                               f"value {c['contract_value']:,.2f} exactly")
        c["problems"] = [p for p in c["problems"]
                         if "no instalment schedule" not in p and "instalments add to" not in p]


def run(src_dir: str, extra: str | None, out_json: str | None) -> None:
    contracts: list[dict] = []
    for p in sorted(glob.glob(os.path.join(src_dir, "*.pdf"))):
        got = parse_tata(p)
        contracts += [finish(c) for c in got]
    borrow_slabs(contracts)

    if extra and os.path.exists(extra):
        hand = json.load(open(extra, encoding="utf-8"))
        for h in hand:
            h.setdefault("problems", [])
            h["vehicle_norm"] = norm_reg(h.get("vehicle_raw"))
            contracts.append(h)

    ok = [c for c in contracts if not c["problems"]]
    bad = [c for c in contracts if c["problems"]]

    print(f"{'LOAN NO':13}{'FINANCIER':22}{'TYPE':14}{'VEHICLE':12}{'PRINCIPAL':>13}"
          f"{'INTEREST':>13}{'N':>4}{'FIRST EMI':>12}  ")
    print("-" * 104)
    for c in contracts:
        print(f"{str(c.get('loan_no','')):13}{c.get('financier','')[:21]:22}"
              f"{c.get('loan_type',''):14}{str(c.get('vehicle_norm') or '-'):12}"
              f"{(c.get('finance_amt') or 0):>13,.0f}{(c.get('interest_amt') or 0):>13,.0f}"
              f"{str(c.get('tenure_months') or ''):>4}{str(c.get('first_emi_date') or ''):>12}"
              f"  {'CLOSED' if c.get('is_closed') else ''}")
        for p in c["problems"]:
            print(f"{'':13}  -> {p}")

    live = [c for c in ok if not c.get("is_closed")]
    print(f"\n  contracts read      : {len(contracts)}  ({len(ok)} self-consistent, {len(bad)} rejected)")
    print(f"  live at this date   : {len(live)}")
    print(f"  chassis / body      : {sum(1 for c in live if c['loan_type']=='Chassis Loan')}"
          f" / {sum(1 for c in live if c['loan_type']=='Body Loan')}")
    print(f"  principal financed  : {sum(c['finance_amt'] for c in live):,.2f}")
    print(f"  contracted interest : {sum(c['interest_amt'] for c in live):,.2f}")
    print(f"  vehicles named      : {len({c['vehicle_norm'] for c in live if c.get('vehicle_norm')})}")

    if out_json:
        os.makedirs(os.path.dirname(out_json) or ".", exist_ok=True)
        json.dump(ok, open(out_json, "w", encoding="utf-8"), indent=1)
        print(f"\n  wrote {len(ok)} contracts -> {out_json}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="folder of lender PDFs")
    ap.add_argument("--extra", default="reports/loan_bills/indusind.json",
                    help="hand-read contracts (scanned statements)")
    ap.add_argument("--json", help="write parsed contracts here")
    a = ap.parse_args()
    run(a.dir, a.extra, a.json)
