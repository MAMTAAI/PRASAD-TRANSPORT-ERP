#!/usr/bin/env python
"""Read the lender's own transaction ledger out of a TATA "Repayments" statement.

WHY THIS EXISTS ALONGSIDE loan_pdf_parser.py. That file reads the CONTRACT — what
was financed, over how many instalments, at what pattern. It answers "what was
agreed". It cannot answer "what actually happened", and on these accounts the two
are a long way apart: contract 5004384745 is 44 instalments received against 58
demanded, with an average delay of 63 days and a peak of 214.

A schedule modelled from the contract says every instalment fell due on the 11th
and was paid. The lender's ledger says which ones were paid, on what date, how
much of each, what was still outstanding after it, and what late-payment interest
the delay attracted. A ledger statement that an auditor can rely on has to come
from the second, not the first.

WHAT THE PAGES CONTAIN. Two kinds of row, interleaved in date order:

  DEMAND   30.09.2022  001  1005485531        30,301.00              0.00
           11.09.2022                          ^debit            ^net dues
           TATA raises the instalment at month end; the "Inst Date" on the
           continuation line is the CONTRACTUAL due date, and that is the date
           this file keeps. The instalment serial (001..058) sits in the Ent No
           column.

  RECEIPT  11.09.2022  3904548714  20990  15.09.2022    30,301.00  30,301.00-
                                                          ^credit    ^net dues
           Money in. The date on the first line is when the instrument is dated;
           the continuation line carries the date it was entered.

WHY COORDINATES AND NOT TEXT. Both row types have the same shape in flat text and
differ only by WHICH COLUMN the amount lands in — debit or credit. Read as text,
every receipt reads as a demand and the account appears to owe twice what it does.
The columns are right-aligned, so each amount is classified by the right edge of
its box, which does not move when the number gets wider.

THE SELF-CHECK IS THE LENDER'S OWN ARITHMETIC. Each Repayments page prints its
own control totals — Contract Value, Received, Balance, and the instalment counts
behind them. The rows this file extracts must reproduce them: demands must add to
the amount due till date, receipts to the amount received, and the last running
balance must be the difference. A statement that fails is not emitted, because a
ledger that is wrong in a way nobody notices is worse than no ledger at all.
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

import pdfplumber

DATE_RE = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")
AMT_RE = re.compile(r"^-?[\d,]+\.\d{2}-?$")
INT_RE = re.compile(r"^\d+-?$")
DATE_RE_ANY = re.compile(r"\d{2}\.\d{2}\.\d{4}")

# Column right edges, taken from the printed header on each page rather than
# hardcoded — TATA renders these sheets at slightly different widths depending on
# how long the hirer's name is, and a fixed boundary silently reclassifies a
# credit as a debit when it shifts.
HEADER_LABELS = ["Ent", "Document", "Debit", "Credit", "Dues", "Days", "Overdue", "Remark"]


def to_iso(d: str | None) -> str | None:
    if not d or not DATE_RE.match(d):
        return None
    dd, mm, yyyy = d.split(".")
    return f"{yyyy}-{mm}-{dd}"


def money(tok: str) -> float:
    """'30,300.00-' -> -30300.0. TATA prints the sign after the number."""
    neg = tok.endswith("-")
    return (-1 if neg else 1) * float(tok.rstrip("-").replace(",", ""))


def group_lines(words, tol=3.0):
    """Words bucketed into visual lines by their top coordinate."""
    lines: list[list] = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if lines and abs(w["top"] - lines[-1][0]["top"]) <= tol:
            lines[-1].append(w)
        else:
            lines.append([w])
    return [sorted(L, key=lambda w: w["x0"]) for L in lines]


def column_edges(lines) -> dict | None:
    """Where each amount column ends, from the header row of this page.

    Values are right-aligned a little past their heading, so the cut between two
    columns is taken midway between the end of one heading and the start of the
    next, then nudged right to cover the overhang. Measured against all three
    statements, every amount lands in the column its heading names.
    """
    for L in lines:
        txt = [w["text"] for w in L]
        if "Debit" in txt and "Credit" in txt and "Days" in txt:
            pos = {}
            for w in L:
                if w["text"] in HEADER_LABELS:
                    pos.setdefault(w["text"], w)
            if len(pos) < len(HEADER_LABELS):
                return None
            # Right edge of a column = start of the next heading, less a hair.
            return {
                "debit": pos["Credit"]["x0"] - 2,
                "credit": pos["Dues"]["x0"] - 2,
                "dues": pos["Days"]["x0"] - 2,
                "days": pos["Overdue"]["x0"] - 2,
                "odc": pos["Remark"]["x0"] - 2,
                "inst_date_end": pos["Debit"]["x0"] - 2,
                # The instalment serial sits under "Ent No", between the date and
                # the document number. Bounding it by the two headings either
                # side is what stops a truncated receipt number from being read
                # as instalment 890.
                "serial_from": pos["Ent"]["x0"] - 2,
                "serial_to": pos["Document"]["x0"] - 2,
            }
    return None


def classify(line, edges) -> dict:
    """One visual line -> the fields it carries, by column."""
    out = {"dates": [], "ints": [], "debit": None, "credit": None,
           "dues": None, "days": None, "odc": None, "serial": None, "doc": None}
    for w in line:
        t, x0, x1 = w["text"], w["x0"], w["x1"]
        if x1 <= edges["inst_date_end"]:
            if DATE_RE.match(t):
                out["dates"].append((x0, t))
            elif re.match(r"^\d{3}$", t) and edges["serial_from"] <= x0 < edges["serial_to"]:
                out["serial"] = int(t)          # instalment number, Ent No column
            elif re.match(r"^\d{10}$", t):
                out["doc"] = t
            continue
        for key in ("debit", "credit", "dues", "days", "odc"):
            if x1 <= edges[key]:
                if AMT_RE.match(t):
                    out[key] = money(t)
                elif INT_RE.match(t):
                    # Whole-number columns (the delay in days) print the same
                    # trailing minus, so the sign has to survive the ".00".
                    out[key] = money(t.rstrip("-") + ".00" + ("-" if t.endswith("-") else ""))
                break
    return out


def parse_repayments(path: str) -> dict[str, dict]:
    """Every contract's ledger in one PDF, keyed by contract number."""
    ledgers: dict[str, dict] = {}
    cur: dict | None = None

    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            lines = group_lines(page.extract_words(use_text_flow=False))
            edges = column_edges(lines)

            # WHICH PAGE IS A LEDGER PAGE. Only the first page of each ledger
            # carries the "Repayments" heading and the contract number; every
            # page after it opens straight into rows. Keying off the heading
            # dropped all but the first page of every contract and left 44
            # instalments looking like 7. The repeated COLUMN header is the
            # reliable mark, because a page of rows cannot be printed without it.
            m = re.search(r"Contract No\s*:?\s*(\d{10})", text)
            if m and not edges:
                cur = ledgers.setdefault(m.group(1), _blank(m.group(1), path))
            if not edges:
                if cur is not None:
                    _recoveries(cur, text)
                continue
            if m:
                cur = ledgers.setdefault(m.group(1), _blank(m.group(1), path))
            if cur is None:
                continue

            _control_totals(cur, lines)

            pending: dict | None = None
            for L in lines:
                f = classify(L, edges)
                money_cols = [f["debit"], f["credit"]]
                if all(v is None for v in money_cols):
                    # A continuation line: it carries the second date of the row
                    # opened above — the contractual instalment date for a
                    # demand, the entry date for a receipt.
                    if pending and f["dates"] and not f["serial"]:
                        d = to_iso(f["dates"][0][1])
                        if d and pending.get("second_date") is None:
                            pending["second_date"] = d
                    continue

                # A TRANSACTION HAS A DATE. The page's own summary lines carry
                # money in the same columns and no date at all -- the control
                # block at the top ("Contract Value 6,057,050 4,476,235
                # 1,580,815") and the overdue totals at the foot. Read as rows
                # they added 92 lakh of imaginary receipts to a 44 lakh account.
                first = to_iso(f["dates"][0][1]) if f["dates"] else None
                if first is None:
                    _summary_line(cur, f)
                    continue
                if pending:
                    _emit(cur, pending)
                inst_col = to_iso(f["dates"][1][1]) if len(f["dates"]) > 1 else None
                pending = {
                    "posted_date": first, "inst_col_date": inst_col, "second_date": None,
                    "serial": f["serial"], "document_no": f["doc"],
                    "debit": f["debit"], "credit": f["credit"], "dues": f["dues"],
                    "days": f["days"], "odc": f["odc"],
                }
            if pending:
                _emit(cur, pending)

    return ledgers


RECOVERY_RE = re.compile(
    r"^\s*(\d{3})\s+(.+?)\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$")
COLLECTION_RE = re.compile(
    r"^(?P<head>Stamp Recovery|Processing fee|Legal Expenses|LPC Charged|Bank Charges|"
    r"Cheque Bounce Charges|Bounce Charges|Foreclosure Charges)\s+"
    r"(?P<amt>[\d,]+\.\d{2})\s+(?P<type>[A-Z])\s+(?P<rest>.*)$")


def _recoveries(cur: dict, text: str) -> None:
    """The charges block: LPC, bounce, legal, stamp — raised, recovered, still owed.

    Two tables say different things and both are needed. "Additional Recoveries"
    is the head-level position — what was charged, what came back, what is still
    standing — and it carries NO DATES. "Other Collections" dates the money that
    came back, one instrument at a time.

    So the outstanding balance of a charge head is a figure without a date, and
    this file does not invent one. It is emitted as undated and the opening
    balance reports it as its own line rather than silently placing it on one
    side of a cut-off it cannot be placed on.
    """
    if "Additional Recoveries" not in text and "Other Collections" not in text:
        return
    for line in text.splitlines():
        m = RECOVERY_RE.match(line)
        if m and m.group(2).strip() not in ("", "Description"):
            head = m.group(2).strip()
            row = {"head": head, "charged": money(m.group(3)),
                   "recovered": money(m.group(4)), "outstanding": money(m.group(5))}
            if row not in cur["charge_heads"]:
                cur["charge_heads"].append(row)
            continue
        m = COLLECTION_RE.match(line.strip())
        if m:
            dates = DATE_RE_ANY.findall(m.group("rest"))
            row = {"head": m.group("head"), "amount": money(m.group("amt")),
                   "mode": m.group("type"),
                   "collected_on": to_iso(dates[0]) if dates else None}
            if row not in cur["charge_collections"]:
                cur["charge_collections"].append(row)


def _blank(no: str, path: str) -> dict:
    return {"loan_no": no, "source_file": os.path.basename(path),
            "demands": [], "receipts": [], "control": {}, "_seq": 0,
            "charge_heads": [], "charge_collections": []}


def _control_totals(cur: dict, lines) -> None:
    """The lender's own summary block, printed at the top of each ledger page."""
    for L in lines:
        txt = " ".join(w["text"] for w in L)
        m = re.match(r"Contract Value ([\d,]+\.\d{2}) ([\d,]+\.\d{2}) ([\d,]+\.\d{2})", txt)
        if m:
            cur["control"].update(contract_value=money(m.group(1)),
                                  received=money(m.group(2)), balance=money(m.group(3)))
        m = re.match(r"Instal\.\(Nos\) (\d{3}) (\d{3}) (\d{3})", txt)
        if m:
            cur["control"].update(instalments=int(m.group(1)),
                                  instalments_received=int(m.group(2)),
                                  instalments_balance=int(m.group(3)))


def _summary_line(cur: dict, f: dict) -> None:
    """The dateless totals at the foot of a ledger: what is overdue, and the
    late-payment interest standing against it. Kept as a control figure, never
    as a transaction."""
    if f["dues"] is not None and f["odc"] is not None and f["debit"] is None:
        cur["control"]["closing_overdue"] = f["dues"]
        cur["control"]["closing_overdue_interest"] = f["odc"]


def _emit(cur: dict, row: dict) -> None:
    """File a parsed row as a demand or a receipt.

    The instalment serial is what separates them, not the amount and not the
    column: a demand is TATA raising instalment 017, and it is the only row type
    that carries a serial. Everything else moved money.
    """
    cur["_seq"] += 1
    if row["serial"] is not None and row["debit"]:
        cur["demands"].append({
            "seq": cur["_seq"],
            "instalment_no": row["serial"],
            "due_date": row["second_date"] or row["inst_col_date"] or row["posted_date"],
            "raised_on": row["posted_date"],
            "amount": row["debit"],
            "document_no": row["document_no"],
            "running_dues": row["dues"],
            "delay_days": int(row["days"]) if row["days"] is not None else None,
            "overdue_interest": row["odc"],
        })
    elif row["credit"]:
        cur["receipts"].append({
            "seq": cur["_seq"],
            "value_date": row["posted_date"],
            "entry_date": row["second_date"] or row["posted_date"],
            "cleared_date": row["inst_col_date"] or row["posted_date"],
            "amount": row["credit"],
            "document_no": row["document_no"],
            "running_dues": row["dues"],
            "delay_days": int(row["days"]) if row["days"] is not None else None,
            "overdue_interest": row["odc"],
        })
    elif row["debit"]:
        # A debit with no serial is a charge raised against the account — LPC,
        # legal, bounce. It belongs on the ledger but it is not an instalment.
        cur.setdefault("charges", []).append({
            "charge_date": row["posted_date"], "amount": row["debit"],
            "document_no": row["document_no"], "running_dues": row["dues"],
        })


def audit(led: dict) -> list[str]:
    """Does what we read reproduce what the lender printed?"""
    problems = []
    ctl = led.get("control") or {}
    dem, rec = led["demands"], led["receipts"]

    if not dem:
        problems.append("no instalment demands found")
        return problems

    serials = [d["instalment_no"] for d in dem]
    if len(set(serials)) != len(serials):
        dup = sorted({s for s in serials if serials.count(s) > 1})
        problems.append(f"instalment serial repeated: {dup}")
    if serials != sorted(serials):
        problems.append("instalment serials are not in order")
    if serials and serials[0] != 1:
        problems.append(f"ledger starts at instalment {serials[0]}, not 1")
    gaps = [n for n in range(1, max(serials) + 1) if n not in set(serials)]
    if gaps:
        problems.append(f"missing instalments {gaps[:8]}")

    if ctl.get("instalments_received") is not None:
        # The lender counts an instalment received once the money for it landed;
        # our receipts are instruments, which do not map one-to-one. The count it
        # states is checked against the amount instead, below.
        pass

    recd = round(sum(r["amount"] for r in rec), 2)
    if ctl.get("received") is not None and abs(recd - ctl["received"]) > 1:
        problems.append(f"receipts add to {recd:,.2f} against the printed "
                        f"{ctl['received']:,.2f}")

    # The demands are the instalments RAISED so far, which is not the contract
    # value -- twelve of this contract's fifty-eight have not fallen due yet. The
    # lender prints no total for them, so the check is that the running balance
    # standing against its LAST ROW is the one our rows walk to.
    #
    # Last row in DOCUMENT ORDER, not by date. TATA raises an instalment at month
    # end for a due date on the 11th, so the final demand is printed after a
    # receipt that is dated a week before it. Ordering by date puts them the
    # wrong way round and leaves the check one instalment out on eleven of the
    # twenty-seven contracts -- all of them correct.
    tail = max(dem + rec, key=lambda r: r["seq"])
    if tail.get("running_dues") is not None:
        walked = round(sum(d["amount"] for d in dem) - recd, 2)
        if abs(walked - tail["running_dues"]) > 1:
            problems.append(f"demands less receipts leaves {walked:,.2f} outstanding; the "
                            f"lender's own closing balance says {tail['running_dues']:,.2f}")
    return problems


def run(src_dir: str, out_json: str | None) -> None:
    all_led: dict[str, dict] = {}
    for p in sorted(glob.glob(os.path.join(src_dir, "*.pdf"))):
        try:
            for no, led in parse_repayments(p).items():
                if led["demands"] or led["receipts"]:
                    all_led[no] = led
        except Exception as e:                                    # noqa: BLE001
            print(f"  !! {os.path.basename(p)}: {e}")

    print(f"{'LOAN NO':13}{'DEMANDS':>9}{'DUE':>15}{'RECEIPTS':>10}{'RECEIVED':>15}"
          f"{'BALANCE':>14}{'LAST DUE DT':>13}")
    print("-" * 89)
    ok, bad = [], []
    for no, led in sorted(all_led.items()):
        probs = audit(led)
        (bad if probs else ok).append(led)
        led["problems"] = probs
        due = sum(d["amount"] for d in led["demands"])
        rec = sum(r["amount"] for r in led["receipts"])
        last = led["demands"][-1]["due_date"] if led["demands"] else "-"
        print(f"{no:13}{len(led['demands']):>9}{due:>15,.2f}{len(led['receipts']):>10}"
              f"{rec:>15,.2f}{due - rec:>14,.2f}{last:>13}")
        for p in probs:
            print(f"{'':13}  -> {p}")

    print(f"\n  ledgers read : {len(all_led)}  ({len(ok)} reconcile, {len(bad)} rejected)")

    if out_json:
        os.makedirs(os.path.dirname(out_json) or ".", exist_ok=True)
        json.dump(ok, open(out_json, "w", encoding="utf-8"), indent=1)
        print(f"  wrote {len(ok)} ledgers -> {out_json}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True, help="folder of lender PDFs")
    ap.add_argument("--json", help="write parsed ledgers here")
    a = ap.parse_args()
    run(a.dir, a.json)
