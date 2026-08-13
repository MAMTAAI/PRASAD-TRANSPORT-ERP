#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
iocl_payment_parser.py - THE PAYMENT ADVICE (the third document)
================================================================================
The Transportation Bill says what was EARNED. This says what was PAID, and the
two are not the same number — which is the whole reason this parser exists.

IOCL settles a fortnight by netting several things against the freight before
any money reaches the bank:

    freight bills (gross, rounded to whole rupees on the advice)
      − TDS 194C @ 2%
      − CCMS RECOV ............ HSD/fuel drawn on IOCL's card, recovered at source
      − TOLL EXPENSE-SBIN ..... FASTag/toll paid by IOCL on our behalf
      − Misc. recoveries ...... damages, shortages, plant-level adjustments
      + reimbursements ........ small positive non-freight lines
      ─────────────────────────
      = amount actually remitted

On the 07.08.2026 advice that came to ₹8,74,173.87 remitted against ₹12,43,474
of net freight — roughly 30% of the bill never touched the bank. Booking the
whole net as a bank receipt (which is what the reconciler did before this
existed) overstates the bank and leaves fuel and toll unrecorded.

A CCMS recovery is NOT a loss of income. The freight was earned in full; part of
it was taken as diesel instead of cash. So it belongs in the books as an expense
settled against the receivable, not as a reduction of revenue — which is exactly
why it needs its own document and its own parser rather than a fudge factor.

USAGE
--------------------------------------------------------------------------------
    python iocl_payment_parser.py "payment seet.pdf" --json advice.json
    python iocl_payment_parser.py advices/ --csv advices.csv

Exit codes: 0 ok | 2 nothing extracted | 3 remittance does not tie to the lines
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    import pdfplumber
except ImportError:  # pragma: no cover
    sys.stderr.write("FATAL: pdfplumber not installed — see requirements.txt\n")
    raise SystemExit(1)

from iocl_bill_parser import money, sha256_file, sha1_of  # noqa: E402

TOOL_VERSION = "1.0.0"
ZERO = Decimal("0.00")

# The mode itself contains brackets — 'E-Payment (RTGS/NEFT/ActTfr)' — so the
# capture must run up to 'to your bank', not stop at the first '('.
RE_REMITTED = re.compile(
    r"remitted a sum of Rs\.?\s*([\d,]+\.?\d*)\s+through\s+(.+?)\s+to your bank", re.I)
RE_BANKREF = re.compile(r"Bank Ref:\s*(\S+)", re.I)
RE_ODN = re.compile(r"ODN:\s*(\S+)", re.I)
RE_DATED = re.compile(r"Dated:\s*(\d{2}\.\d{2}\.\d{4})")
RE_ACCOUNT = re.compile(r"Account Number:\s*(\S+)", re.I)
RE_BANKNAME = re.compile(r"Bank Name:\s*(.+?)\s+Bank City:", re.I)
RE_GSTIN = re.compile(r"GSTIN:\s*([0-9A-Z]{15})")

# A voucher line: SAP voucher / item / reference, then the money columns.
# Amounts carry a TRAILING minus in SAP output ('5,846.00-'), never a leading one.
AMT = r"[\d,]+\.\d{2}-?"
# Anchored on the SAP voucher number (4 digits, hyphen, 10 digits) because the
# looser shape matched GST-rate continuation rows and read an amount as the
# reference.
#
# Everything between the voucher and the first money column is taken as one
# blob, then an item number is split off it only if one is clearly there. The
# advice prints the item inconsistently — 'vch/ 1 <bill>' on freight lines,
# 'vch/ <ref>' with no item on plant recoveries — and guessing wrong shifts
# every column right, which silently corrupts the amounts rather than failing.
#
# The reference itself may contain spaces ('CCMS RECOV-7T04'); those recoveries
# are the largest numbers on the sheet, so the blob must tolerate them.
RE_VOUCHER = re.compile(
    rf"^\s*(?P<vch>\d{{4}}-\d{{10}})\s*/\s*(?P<refraw>\S.*?)\s+"
    rf"(?P<gross>{AMT})\s+(?P<gst>{AMT})\s+(?P<tds>{AMT})\s+"
    rf"(?P<ded>{AMT})\s+(?P<net>{AMT})\s+(?P<gsttax>{AMT})"
)
RE_ITEM_PREFIX = re.compile(r"^(?P<item>\d{1,2})\s+(?P<rest>\S.*)$")
RE_BILLNO = re.compile(r"(T?\d{8}[A-Z]{2,4}\d{5})")


def sap(tok: str) -> Decimal:
    """'5,846.00-' → Decimal('-5846.00'). SAP puts the sign on the right."""
    t = tok.strip().replace(",", "")
    neg = t.endswith("-")
    return (Decimal(t.rstrip("-")) * (-1 if neg else 1)).quantize(Decimal("0.01"))


def classify(text: str, ref: str) -> str:
    """What kind of line this is — the classification drives the accounting.

    CCMS and TOLL are settled expenses, not lost revenue, so they must be
    told apart from a genuine freight bill and from each other.
    """
    blob = f"{ref} {text}".upper()
    if "CCMS" in blob:
        return "FUEL_CCMS_RECOVERY"
    if "TOLL" in blob:
        return "TOLL_RECOVERY"
    if "RECOVER" in blob:
        return "MISC_RECOVERY"
    if re.match(r"^T\d{8}", ref):
        return "TOLL_RECOVERY"
    # Tank-truck hire is a SECOND revenue stream, not an adjustment to freight:
    # IOCL rents VMUS tanks at Lumding and pays for them on the same advice.
    # Lumping it into 'other' hid ₹16.6 L of income behind a residual bucket.
    if "RENTAL" in blob or "RENTING" in blob or "VMUS" in blob:
        return "RENTAL_INCOME"
    if RE_BILLNO.search(ref) and not ref.startswith("T"):
        return "FREIGHT_BILL"
    # 11024699 + period, no AS-series bill number: the non-freight billing
    # series (misc services). Income, so it must not sit in a residual bucket
    # either — but it is billed separately from the transportation bills.
    if re.fullmatch(r"11024699\d{6,8}", ref):
        return "OTHER_BILLED_INCOME"
    return "OTHER"


@dataclass
class AdviceLine:
    voucher_no: str
    item: str
    reference: str
    bill_no: Optional[str]
    plant: Optional[str]
    material_text: str
    kind: str
    gross: Decimal
    tds: Decimal
    deduction: Decimal
    net: Decimal
    gst_tax: Decimal
    page_no: int

    @property
    def line_uid(self) -> str:
        return sha1_of(self.voucher_no, self.item, self.reference, str(self.net))

    def to_dict(self) -> dict:
        d = asdict(self)
        for k in ("gross", "tds", "deduction", "net", "gst_tax"):
            d[k] = str(d[k])
        d["line_uid"] = self.line_uid
        return d


@dataclass
class PaymentAdvice:
    pdf_path: str
    pdf_name: str
    pdf_sha256: str
    tool_version: str = TOOL_VERSION
    odn: Optional[str] = None
    bank_ref: Optional[str] = None
    advice_date: Optional[date] = None
    remitted: Decimal = ZERO
    mode: Optional[str] = None
    bank_name: Optional[str] = None
    account_tail: Optional[str] = None
    vendor_gstin: Optional[str] = None
    pages: int = 0
    lines: list[AdviceLine] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def by_kind(self) -> dict[str, Decimal]:
        out: dict[str, Decimal] = {}
        for ln in self.lines:
            out[ln.kind] = out.get(ln.kind, ZERO) + ln.net
        return out

    @property
    def freight_gross(self) -> Decimal:
        return sum((l.gross for l in self.lines if l.kind == "FREIGHT_BILL"), ZERO)

    @property
    def tds_total(self) -> Decimal:
        return sum((l.tds for l in self.lines), ZERO)

    @property
    def computed_net(self) -> Decimal:
        return sum((l.net for l in self.lines), ZERO)

    @property
    def ties(self) -> bool:
        """The advice must add up to what was remitted, within rounding."""
        return abs(self.computed_net - self.remitted) <= Decimal("1.00")

    def to_dict(self) -> dict:
        return {
            "pdf_path": self.pdf_path, "pdf_name": self.pdf_name,
            "pdf_sha256": self.pdf_sha256, "tool_version": self.tool_version,
            "odn": self.odn, "bank_ref": self.bank_ref,
            "advice_date": self.advice_date.isoformat() if self.advice_date else None,
            "remitted": str(self.remitted), "mode": self.mode,
            "bank_name": self.bank_name, "account_tail": self.account_tail,
            "vendor_gstin": self.vendor_gstin, "pages": self.pages,
            "freight_gross": str(self.freight_gross),
            "tds_total": str(self.tds_total),
            "computed_net": str(self.computed_net),
            "ties_to_remittance": self.ties,
            "totals_by_kind": {k: str(v) for k, v in self.by_kind().items()},
            "warnings": self.warnings,
            "lines": [l.to_dict() for l in self.lines],
        }


def parse_advice(pdf_path: Path) -> PaymentAdvice:
    adv = PaymentAdvice(pdf_path=str(pdf_path), pdf_name=pdf_path.name,
                        pdf_sha256=sha256_file(pdf_path))

    with pdfplumber.open(str(pdf_path)) as pdf:
        adv.pages = len(pdf.pages)
        page_texts = [(i, (p.extract_text() or "")) for i, p in enumerate(pdf.pages, start=1)]

    whole = "\n".join(t for _, t in page_texts)
    if m := RE_REMITTED.search(whole):
        adv.remitted = money(m.group(1))
        adv.mode = m.group(2).strip().strip('"')
    for rx, attr in ((RE_ODN, "odn"), (RE_BANKREF, "bank_ref"),
                     (RE_ACCOUNT, "account_tail"), (RE_GSTIN, "vendor_gstin")):
        if (m := rx.search(whole)) and getattr(adv, attr) is None:
            setattr(adv, attr, m.group(1).strip())
    if m := RE_BANKNAME.search(whole):
        adv.bank_name = m.group(1).strip()
    if m := RE_DATED.search(whole):
        try:
            adv.advice_date = datetime.strptime(m.group(1), "%d.%m.%Y").date()
        except ValueError:
            pass

    for page_no, text in page_texts:
        rows = text.split("\n")
        for i, raw in enumerate(rows):
            m = RE_VOUCHER.match(raw)
            if not m:
                continue
            # The description sits on the following one to three wrapped rows;
            # the money row itself carries no words worth reading.
            tail = " ".join(r.strip() for r in rows[i + 1:i + 4])
            tail = re.sub(r"\bSAC_GOODS\b|\bTRANSPORT\b|\bAGENCY SERVICES\b|^\d+\s|^[\d.]+\s", " ", tail)
            material = re.sub(r"\s+", " ", tail).strip()[:180]
            plant = None
            if pm := re.search(r"(Depot|Terminal|RC Office|Plant|BP\s*-\s*\w+)", material):
                plant = pm.group(0)

            refraw = m.group("refraw")
            item = ""
            # Split a leading item number off only when what follows still looks
            # like a reference — never when it would leave the reference empty.
            if im := RE_ITEM_PREFIX.match(refraw):
                item, refraw = im.group("item"), im.group("rest")
            ref = refraw
            bill = RE_BILLNO.search(ref)
            adv.lines.append(AdviceLine(
                voucher_no=m.group("vch"), item=item, reference=ref,
                bill_no=bill.group(1) if bill else None, plant=plant,
                material_text=material, kind=classify(material, ref),
                gross=sap(m.group("gross")), tds=sap(m.group("tds")),
                deduction=sap(m.group("ded")), net=sap(m.group("net")),
                gst_tax=sap(m.group("gsttax")), page_no=page_no,
            ))

    if not adv.lines:
        adv.warnings.append("No voucher lines matched — layout may differ from the 2026 SAP advice.")
    elif not adv.ties:
        adv.warnings.append(
            f"Lines sum to {adv.computed_net} but the advice says {adv.remitted} was remitted "
            f"(difference {adv.computed_net - adv.remitted}). Some lines were not parsed.")
    return adv


def report(adv: PaymentAdvice) -> None:
    print(f"\n=== {adv.pdf_name} ===")
    print(f"  ODN {adv.odn or '?'}   bank ref {adv.bank_ref or '?'}   dated {adv.advice_date or '?'}")
    print(f"  {adv.mode or 'remittance'} to {adv.bank_name or '?'} a/c {adv.account_tail or '?'}")
    print(f"  pages {adv.pages} · {len(adv.lines)} voucher lines")
    print("\n  ── SETTLEMENT ──────────────────────────────────────────────")
    print(f"  freight gross (as billed)  {adv.freight_gross:>15,}")
    print(f"  TDS 194C                   {adv.tds_total:>15,}")
    for kind, amt in sorted(adv.by_kind().items(), key=lambda kv: kv[1]):
        if kind == "FREIGHT_BILL":
            continue
        print(f"  {kind.replace('_',' ').lower():<26} {amt:>15,}")
    print(f"  {'─'*44}")
    print(f"  computed net               {adv.computed_net:>15,}")
    print(f"  remitted per advice        {adv.remitted:>15,}   {'TIES' if adv.ties else 'MISMATCH'}")
    if adv.freight_gross:
        held = adv.freight_gross - adv.remitted
        pct = held / adv.freight_gross * 100
        print(f"\n  NOT paid in cash           {held:>15,}   ({pct:.1f}% of freight)")
        print("  (recovered as fuel, toll and tax — earned, but never banked)")
    for w in adv.warnings:
        print(f"  WARN: {w}")


CSV_COLUMNS = ["pdf_name", "odn", "advice_date", "voucher_no", "item", "reference",
               "bill_no", "kind", "plant", "gross", "tds", "net", "gst_tax", "material_text"]


def main(argv: Optional[list[str]] = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="Parse IOCL payment advices (remittance sheets).")
    ap.add_argument("pdfs", nargs="+")
    ap.add_argument("--json", type=Path)
    ap.add_argument("--csv", type=Path)
    ap.add_argument("--strict", action="store_true",
                    help="exit 3 if any advice does not tie to its remittance")
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args(argv)

    paths: list[Path] = []
    for p in args.pdfs:
        q = Path(p)
        paths.extend(sorted(q.glob("*.pdf")) if q.is_dir() else [q])
    paths = [p for p in paths if p.exists()]
    if not paths:
        sys.stderr.write("FATAL: no input PDFs\n")
        return 2

    advices = [parse_advice(p) for p in paths]
    if not args.quiet:
        for a in advices:
            report(a)

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps([a.to_dict() for a in advices], indent=2), encoding="utf-8")
        print(f"\nJSON -> {args.json}")
    if args.csv:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        with args.csv.open("w", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=CSV_COLUMNS, extrasaction="ignore")
            w.writeheader()
            for a in advices:
                for ln in a.lines:
                    w.writerow({**ln.to_dict(), "pdf_name": a.pdf_name, "odn": a.odn,
                                "advice_date": a.advice_date})
        print(f"CSV  -> {args.csv}")

    if not any(a.lines for a in advices):
        return 2
    if args.strict and any(not a.ties for a in advices):
        sys.stderr.write("FATAL: an advice does not tie to its remittance (--strict)\n")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
