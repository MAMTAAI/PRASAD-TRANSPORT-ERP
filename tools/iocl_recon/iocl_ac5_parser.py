#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
iocl_ac5_parser.py - read an IOCL AC5 dispatch invoice into a loading entry.

The AC5 ("STOCK TRANSFER - ISSUES UNDER RULE 11", Form No AC5) is the document
raised AT THE LOADING POINT when a tank truck is filled. iocl_bill_parser.py
recognises the type and deliberately skips it, because it carries no freight
amount and there is nothing in it to reconcile against a payment. That is the
right call for the settlement chain -- and it is exactly why the loading side
had nothing to read.

What the AC5 does carry is the load itself:

    Form No AC5 22A SAP Doc.No.193680283 Date 16-07-2026 ...
    Del Mode Road T.T.No. AS26C9804 Time 14:39 ...
    Code 7D18            <- loading point
    ZC7A01               <- consignee code, with "Destination: Agartala AFS 7A01"
    1 32000 JET A-1 (ATF) 40.000 KL 2710 19 39 2121DP7A01
                          ^^^^^^ the dispatched quantity

QUANTITY IS TAKEN FROM THE ITEM LINE, NOT FROM "Qty:".
The header also shows a Qty: figure -- 1,279.46 KL on the sample -- but that is
the batch/assessable quantity for the whole tank, not this truck's load. Reading
it would inflate a 40 KL load by a factor of thirty.

    python tools/iocl_recon/iocl_ac5_parser.py <file.pdf> [more.pdf ...]
"""
from __future__ import annotations

import hashlib
import re
import sys
from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional

import pdfplumber

TOOL_VERSION = "ac5-1.0.0"


@dataclass
class Ac5Load:
    pdf_name: str
    pdf_sha256: str
    doc_no: Optional[str] = None          # SAP Doc.No -> iocl_invoice_no
    loading_date: Optional[date] = None
    loading_time: Optional[str] = None
    vehicle_raw: Optional[str] = None     # T.T.No as printed, e.g. AS26C9804
    vehicle_no: Optional[str] = None      # normalised, e.g. AS 26C 9804
    product: Optional[str] = None
    material_code: Optional[str] = None
    qty_kl: Optional[Decimal] = None
    unit: Optional[str] = None
    density_15: Optional[Decimal] = None
    loading_point_code: Optional[str] = None
    loading_point: Optional[str] = None
    consignee_code: Optional[str] = None
    consignee_name: Optional[str] = None
    value_rs: Optional[Decimal] = None
    delivery_no: Optional[str] = None
    shipment_no: Optional[str] = None
    tool_version: str = TOOL_VERSION
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        """Enough to make a loading entry that can be deduplicated."""
        return bool(self.doc_no and self.vehicle_no and self.loading_date and self.qty_kl)

    def as_dict(self) -> dict:
        d = asdict(self)
        d["loading_date"] = self.loading_date.isoformat() if self.loading_date else None
        for k in ("qty_kl", "density_15", "value_rs"):
            d[k] = str(d[k]) if d[k] is not None else None
        return d


# ── vehicle normalisation ────────────────────────────────────────────────────
# The AC5 prints AS26C9804; the ERP stores "AS 26C 9804". Matching the ERP's
# own shape matters -- a trip keyed on the wrong spelling is a duplicate waiting
# to happen, which is the one thing this import must not produce.
_VEH = re.compile(r"^([A-Z]{2})\s*(\d{1,2})\s*([A-Z]{0,3})\s*(\d{1,4})$")


def norm_vehicle(raw: str) -> Optional[str]:
    if not raw:
        return None
    s = re.sub(r"[^A-Za-z0-9]", "", raw).upper()
    m = _VEH.match(s)
    if not m:
        return None
    st, dist, series, num = m.groups()
    return f"{st} {dist}{series} {num}".strip() if series else f"{st} {dist} {num}"


def _dec(s: str) -> Optional[Decimal]:
    try:
        return Decimal(s.replace(",", "").strip())
    except (InvalidOperation, AttributeError):
        return None


def _date(s: str) -> Optional[date]:
    # IOCL renders the invoice date at least two ways, depot by depot:
    #   Date 16-07-2026     numeric, on the Prasad Transport documents
    #   Date 07-Jul-26      dd-Mon-yy, on the Jaiswal Enterprise ones
    # Supporting only the first silently dropped about half of the second
    # mailbox as "missing loading_date" -- rejected files, not wrong data, but
    # a silent under-import is the worse failure of the two.
    for fmt in ("%d-%m-%Y", "%d.%m.%Y", "%d/%m/%Y",
                "%d-%b-%Y", "%d-%b-%y", "%d-%B-%Y", "%d %b %Y"):
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            continue
    return None


def parse_ac5(path: Path) -> Ac5Load:
    raw = path.read_bytes()
    load = Ac5Load(pdf_name=path.name, pdf_sha256=hashlib.sha256(raw).hexdigest())

    with pdfplumber.open(path) as pdf:
        text = "\n".join((pg.extract_text() or "") for pg in pdf.pages)

    if not re.search(r"Form\s*No\s*AC5|STOCK\s+TRANSFER", text, re.I):
        load.warnings.append("not an AC5 dispatch invoice")
        return load

    if m := re.search(r"SAP\s*Doc\.?No\.?\s*(\d{6,12})", text, re.I):
        load.doc_no = m.group(1)
    # Anchored on the literal "Date " label, and it must stay anchored: the page
    # also carries excise registration dates (30.06.2017, 13.05.2002 on one
    # sample), so a free-floating date pattern picks up a decade-old licence
    # date instead of the dispatch.
    if m := re.search(
        r"\bDate\s+(\d{1,2}[-./][A-Za-z]{3,9}[-./]\d{2,4}|\d{1,2}[-./]\d{1,2}[-./]\d{2,4})",
        text,
    ):
        load.loading_date = _date(m.group(1))
    if m := re.search(r"T\.?T\.?No\.?\s*([A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3}\s?\d{1,4})", text, re.I):
        load.vehicle_raw = m.group(1).strip()
        load.vehicle_no = norm_vehicle(load.vehicle_raw)
    if m := re.search(r"\bTime\s+(\d{1,2}:\d{2})", text):
        load.loading_time = m.group(1)
    if m := re.search(r"Den@?15[:\s]*([\d,]+\.?\d*)", text, re.I):
        load.density_15 = _dec(m.group(1))

    # Item line: "<n> <matcode> <description> <qty> KL ..."  The quantity is the
    # first decimal that is followed by a unit, which keeps HSN codes and batch
    # numbers out of it.
    #
    # "TO" IS TONNES, AND LEAVING IT OUT COST THREE WEEKS OF LPG.
    # Petroleum moves in KL and LPG moves in weight, and IOCL writes the LPG
    # item line with the unit "TO":
    #
    #     1 94000 LPG NON-DOMESTIC NON-EXEMPTED 17.570 TO 271119 EXCSBONDNE
    #     Taxable Value 17570.000 KG 70747.62 KG 1243035.68
    #
    # 17.570 TO is 17,570.000 KG on the very next line, so the unit is
    # unambiguous. It was simply missing from this list, so every LPG AC5 fell
    # through to "no item-line quantity found" and was rejected -- silently,
    # because a rejected file is a count in a log and not an alert. The eight
    # LPG tankers stopped appearing in the loading register after 20-07-2026,
    # which is when hand entry stopped, and ten loads between 18-07 and 14-08
    # were never imported at all.
    #
    # The safety rule below is untouched: the header "Qty:" is still refused,
    # because that is the batch total for the whole tank.
    for line in text.split("\n"):
        m = re.match(
            r"^\s*\d+\s+(\d{4,6})\s+(.+?)\s+([\d,]+\.\d{1,3})\s+(KL|MT|LTR|KG|TO)\b",
            line, re.I)
        if m:
            load.material_code = m.group(1)
            load.product = m.group(2).strip()
            load.qty_kl = _dec(m.group(3))
            load.unit = m.group(4).upper()
            break

    if load.product is None:
        if m := re.search(r"Desc\.?\s*of\s*goods\s*:?\s*(.+)", text, re.I):
            load.product = m.group(1).strip()
    if load.qty_kl is None:
        load.warnings.append(
            "no item-line quantity found; refusing to fall back to the header Qty:, "
            "which is the batch total for the tank and not this truck's load")

    if m := re.search(r"Ex-Depot\s+Price\(DP\).*?([\d,]+\.\d{2})\s*$", text, re.I | re.M):
        load.value_rs = _dec(m.group(1))
    if m := re.search(r"Delivery\s*No\.?\s*(\d{6,12})", text, re.I):
        load.delivery_no = m.group(1)
    if m := re.search(r"Shipment\s*no\s*:?\s*(\d{6,12})", text, re.I):
        load.shipment_no = m.group(1)

    # Loading point: "Code 7D18" is the registered person (issuing depot).
    if m := re.search(r"\bCode\s+([0-9][A-Z0-9]{3})\b", text):
        load.loading_point_code = m.group(1)
    if m := re.search(r"Name\s*&\s*Address\s+(.+)", text):
        load.loading_point = m.group(1).strip()

    # Consignee: the ZC-prefixed code and the printed Destination.
    if m := re.search(r"\b(ZC[0-9A-Z]{4})\b", text):
        load.consignee_code = m.group(1)
    if m := re.search(r"Destination\s*:?\s*(.+)", text):
        load.consignee_name = m.group(1).strip()

    if not load.ok:
        missing = [k for k, v in (("doc_no", load.doc_no), ("vehicle_no", load.vehicle_no),
                                  ("loading_date", load.loading_date), ("qty", load.qty_kl)) if not v]
        load.warnings.append(f"incomplete: missing {', '.join(missing)}")
    return load


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    for a in argv:
        p = Path(a)
        if not p.exists():
            print(f"  MISSING {p}")
            continue
        load = parse_ac5(p)
        flag = "OK " if load.ok else "BAD"
        print(f"  [{flag}] {p.name}")
        print(f"        doc={load.doc_no}  vehicle={load.vehicle_no} (raw {load.vehicle_raw})")
        print(f"        date={load.loading_date} {load.loading_time or ''}  qty={load.qty_kl} {load.unit or ''}")
        print(f"        product={load.product}  material={load.material_code}")
        print(f"        from={load.loading_point_code} {load.loading_point}")
        print(f"        to={load.consignee_code} {load.consignee_name}")
        for w in load.warnings:
            print(f"        ! {w}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
