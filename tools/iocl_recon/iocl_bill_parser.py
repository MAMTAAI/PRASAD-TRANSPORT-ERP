#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
iocl_bill_parser.py - THE EXTRACTOR
================================================================================
Parses an IOCL "Transportation Bill" PDF (the statement B2BPRD mails to the
vendor code) into structured line items.

WHY WORD-COORDINATES AND NOT camelot / extract_table()
--------------------------------------------------------------------------------
This statement is a *hierarchical* table, not a grid:

    Reverse Charge                    Bill No. & Date:- 11024699AS26083 31.07.2026
    AS26AC0401                                              <- vehicle sub-header
    1  7008644452 20 10.07.2026 347334-MAA KAMLASWRI KSK ... 1,605.36 0.00 0.00 40.13 40.13
    2  7008644452 10 10.07.2026 347334-MAA KAMLASWRI KSK ... 1,605.36 0.00 0.00 40.13 40.13
                                Subtotal for Vehicle:        3,210.72 0.00 0.00 80.26 80.26
    AS26AC0405
    ...
    5  7008771076 20 15.07.2026 375161-JAI BAJRANGBALI SERVO ...
                                STATION                      <- WRAPPED cell

Three properties defeat a naive table extractor:
  1. the vehicle number is a *row* that scopes every row beneath it;
  2. Ship-to-party wraps onto continuation rows with no other columns;
  3. subtotal/total rows share the money columns but are not data.

Ruling lines exist only around the header, so camelot's `lattice` finds no
cells and `stream` mis-splits the wrapped names. pdfplumber's per-word (x0,x1,
top) coordinates let us do the one thing that is actually reliable here: bind
each number to a column by its RIGHT edge, because every money column in this
bill is right-aligned.

SELF-VERIFICATION
--------------------------------------------------------------------------------
The bill prints "Subtotal for Vehicle:" and "Total for Bill:". The parser sums
what it extracted and compares. A silent mis-parse is the failure mode that
costs money, so a checksum mismatch is reported loudly and (with --strict-
checksum) is fatal.

DATE WINDOW
--------------------------------------------------------------------------------
Only trips dated 01-04-2026 .. 21-08-2026 inclusive are emitted. Out-of-window
lines are counted and (optionally) listed, never silently dropped - the
checksum runs over ALL parsed lines, before filtering, so the window cannot
mask an extraction error.

USAGE
--------------------------------------------------------------------------------
    python iocl_bill_parser.py BILL.pdf --json out.json --csv out.csv
    python iocl_bill_parser.py uploads/*.pdf --quiet --json all.json

Exit codes: 0 ok | 2 nothing extracted | 3 checksum failed under --strict-checksum
"""

from __future__ import annotations

import argparse
import csv
import glob
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field, asdict
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable, Optional

try:
    import pdfplumber
except ImportError:  # pragma: no cover - dependency guard
    sys.stderr.write(
        "FATAL: pdfplumber is not installed.\n"
        "  python -m pip install -r tools/iocl_recon/requirements.txt\n"
    )
    raise SystemExit(1)

TOOL_VERSION = "1.0.0"

# ── The mandated window. Both ends inclusive. ────────────────────────────────
# These are DEFAULTS. Every tool exposes --window-from/--window-to and calls
# set_window(), so a run can be scoped to a different period without editing
# code.
#
# Consumers MUST read these through the module (`billspec.WINDOW_FROM`), never
# via `from iocl_bill_parser import WINDOW_FROM` — a from-import binds the value
# at import time and would silently ignore an override, which on a money
# pipeline means filtering by a window the operator did not ask for.
WINDOW_FROM = date(2026, 4, 1)
WINDOW_TO = date(2026, 8, 21)


def set_window(w_from: date | str | None, w_to: date | str | None) -> tuple[date, date]:
    """Override the reconciliation window for this process. Returns the pair."""
    global WINDOW_FROM, WINDOW_TO
    def coerce(v, fallback):
        if v is None or v == "":
            return fallback
        if isinstance(v, date):
            return v
        s = str(v).strip()
        for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%Y"):
            try:
                return datetime.strptime(s, fmt).date()
            except ValueError:
                continue
        raise ValueError(f"unparseable date {v!r} (use YYYY-MM-DD or DD-MM-YYYY)")

    new_from, new_to = coerce(w_from, WINDOW_FROM), coerce(w_to, WINDOW_TO)
    if new_from > new_to:
        raise ValueError(f"window start {new_from} is after end {new_to}")
    WINDOW_FROM, WINDOW_TO = new_from, new_to
    return WINDOW_FROM, WINDOW_TO


def add_window_args(ap: argparse.ArgumentParser) -> None:
    """Attach --window-from/--window-to to any of the tools' parsers."""
    g = ap.add_argument_group("date window (both ends inclusive)")
    g.add_argument("--window-from", default=None,
                   help=f"start date, YYYY-MM-DD or DD-MM-YYYY (default {WINDOW_FROM})")
    g.add_argument("--window-to", default=None,
                   help=f"end date, YYYY-MM-DD or DD-MM-YYYY (default {WINDOW_TO})")

ZERO = Decimal("0.00")

# ── Recognisers ─────────────────────────────────────────────────────────────
RE_BILL_NO = re.compile(
    r"Bill\s*No\.?\s*&\s*Date\s*:?\s*-?\s*([A-Z0-9/]+)\s+(\d{2}\.\d{2}\.\d{4})", re.I
)
RE_PERIOD = re.compile(
    r"Period\s*:?\s*(\d{2}\.\d{2}\.\d{4})\s*to\s*(\d{2}\.\d{2}\.\d{4})", re.I
)
RE_VENDOR = re.compile(r"Vendor\s*code\s*:?\s*([0-9]+)", re.I)
# TWO GSTINs sit in the header and they are not interchangeable:
#     (GSTIN:- 18AAACI1681G1ZO)   <- IOCL's RC office, parenthesised. The BUYER.
#      GSTIN:- 18AAKFP2339R2ZG    <- Prasad Transport. The VENDOR (us).
# Taking whichever appears first would file the customer's GSTIN as our own, so
# the parenthesis is what distinguishes them.
RE_GSTIN_BUYER = re.compile(r"\(\s*GSTIN\s*:?\s*-?\s*([0-9A-Z]{15})\s*\)")
RE_GSTIN_ANY = re.compile(r"GSTIN\s*:?\s*-?\s*([0-9A-Z]{15})")
RE_RC_OFFICE = re.compile(r"^(.{2,40}?RC\s+Office)\s*\(([A-Z0-9]+)\)", re.I)

# "AS26AC0401" as printed; tolerant of the spaced/hyphenated spellings in case a
# future bill revision changes the rendering.
RE_VEHICLE = re.compile(r"^[A-Z]{2}[-\s]?\d{1,2}[-\s]?[A-Z]{0,3}[-\s]?\d{3,4}$")
RE_DDMMYYYY = re.compile(r"^\d{2}\.\d{2}\.\d{4}$")
RE_NUMERIC = re.compile(r"^-?[\d,]*\d(?:\.\d+)?$")
RE_MONEY_HDR = re.compile(r"\(Rs\.?\)", re.I)
# Ship-to codes come in two flavours across the depots:
#   '347352-BIDANGSHREE SERVICE STATION'   retail outlet, 6 numeric
#   'ZC7B02-LPG BP -Sarpara 7B02'          LPG plant, alphanumeric
# Requiring at least one digit in the code stops a hyphenated NAME
# ('SHREE-BAJRANG') from being mistaken for a coded destination.
RE_SHIP_CODE_NUM = re.compile(r"^\s*(\d{4,8})\s*[-–—]?\s*(.*)$")
RE_SHIP_CODE_ALNUM = re.compile(r"^\s*([A-Z0-9]{4,8})\s*[-–—]\s*(.+)$")
RE_INVOICE = re.compile(r"^\d{8,14}$")
RE_ITEM = re.compile(r"^\d{1,3}$")

# Lines that share the data band but are structure, not data.
RE_MARKER = re.compile(
    r"(Subtotal\s+for\s+Vehicle|Total\s+for\s+Bill|Total\s+of\s+All\s+Bills|Reverse\s+Charge|"
    r"Page\s+\d+\s+of\s+\d+|System\s+generated|Transportation\s+Bill|"
    r"Tax\s+Invoice\s+issued|Indian\s+Oil\s+AOD|RC\s+Office|Ship-to-party)",
    re.I,
)


# ═════════════════════════════════════════════════════════════════════════════
# Small helpers
# ═════════════════════════════════════════════════════════════════════════════
def money(tok: Any) -> Decimal:
    """'1,605.36' -> Decimal('1605.36'). Never raises; junk becomes 0.00."""
    if tok is None:
        return ZERO
    if isinstance(tok, Decimal):
        return tok
    try:
        return Decimal(str(tok).replace(",", "").strip() or "0").quantize(Decimal("0.01"))
    except (InvalidOperation, ValueError):
        return ZERO


def qty(tok: Any) -> Optional[Decimal]:
    if tok is None:
        return None
    try:
        return Decimal(str(tok).replace(",", "").strip()).quantize(Decimal("0.001"))
    except (InvalidOperation, ValueError):
        return None


def ddmmyyyy(tok: str) -> Optional[date]:
    try:
        return datetime.strptime(tok.strip(), "%d.%m.%Y").date()
    except (ValueError, AttributeError):
        return None


def norm_vehicle(v: Optional[str]) -> str:
    """'AS 26AC 0401' and 'AS26AC0401' must collapse to one key.

    Mirrors the SQL expression on trips_vehnorm_date_idx in 009_iocl_recon.sql.
    """
    return re.sub(r"[^A-Z0-9]", "", (v or "").upper())


def split_ship_to(raw: Optional[str]) -> tuple[Optional[str], str]:
    """'347334-MAA KAMLASWRI KSK' -> ('347334', 'MAA KAMLASWRI KSK').

    The numeric prefix is IOCL's ship-to-party code and is the single most
    reliable join key we have - the ERP stores the same code, just space- rather
    than dash-separated.
    """
    if not raw:
        return None, ""
    s = raw.strip()
    for rx in (RE_SHIP_CODE_NUM, RE_SHIP_CODE_ALNUM):
        m = rx.match(s)
        if m and m.group(2).strip() and any(ch.isdigit() for ch in m.group(1)):
            return m.group(1), re.sub(r"\s+", " ", m.group(2)).strip().upper()
    return None, re.sub(r"\s+", " ", s).upper()


def sha1_of(*parts: Any) -> str:
    return hashlib.sha1("|".join("" if p is None else str(p) for p in parts).encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ═════════════════════════════════════════════════════════════════════════════
# Data model
# ═════════════════════════════════════════════════════════════════════════════
@dataclass
class BillLine:
    """One physical line item: one invoice + one item code + one compartment.

    NOT a trip. Two lines (MS 50700 + HSD 16730) routinely share a vehicle,
    date and destination - they are one truck-load billed in two products.
    """

    bill_no: str
    bill_date: Optional[date]
    reverse_charge: bool
    s_no: Optional[int]
    invoice_no: str
    item_code: Optional[str]
    line_date: date
    vehicle_no_raw: str
    ship_to_raw: str
    material: Optional[str]
    quantity_kl: Optional[Decimal]
    shortage: Optional[Decimal]
    gross_amt: Decimal
    penalty_amt: Decimal
    igst_amt: Decimal
    cgst_amt: Decimal
    sgst_amt: Decimal
    page_no: int
    source_line: str
    # RTD = round-trip distance (km), RATE = Rs per unit per km. IOCL bills
    # gross = rate x rtd x quantity; capturing both is what lets the ERP
    # reproduce the figure instead of guessing at it. Defaulted, so they sit
    # after every required field.
    rtd: Optional[Decimal] = None
    rate: Optional[Decimal] = None

    @property
    def vehicle_norm(self) -> str:
        return norm_vehicle(self.vehicle_no_raw)

    @property
    def ship_to_code(self) -> Optional[str]:
        return split_ship_to(self.ship_to_raw)[0]

    @property
    def ship_to_name(self) -> str:
        return split_ship_to(self.ship_to_raw)[1]

    @property
    def computed_gross(self) -> Optional[Decimal]:
        """IOCL's own formula, recomputed: rate x RTD x quantity.

        The ERP's trip module computes rate x quantity and omits the distance
        entirely, which is why its freight came out 500-700x too small. Deriving
        the figure here proves the formula against every billed line rather than
        against one worked example.
        """
        if self.rate is None or self.rtd is None or self.quantity_kl is None:
            return None
        return (self.rate * self.rtd * self.quantity_kl).quantize(Decimal("0.01"))

    @property
    def formula_ok(self) -> Optional[bool]:
        c = self.computed_gross
        if c is None:
            return None
        return abs(c - self.gross_amt) <= Decimal("1.00")

    @property
    def in_window(self) -> bool:
        return WINDOW_FROM <= self.line_date <= WINDOW_TO

    @property
    def line_uid(self) -> str:
        return sha1_of(
            self.bill_no, self.invoice_no, self.item_code,
            self.line_date.isoformat(), self.vehicle_norm, self.material,
        )

    @property
    def group_uid(self) -> str:
        """The composite key the reconciler matches on: vehicle + date + ship-to."""
        code, name = split_ship_to(self.ship_to_raw)
        return sha1_of(self.vehicle_norm, self.line_date.isoformat(), code or name)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["bill_date"] = self.bill_date.isoformat() if self.bill_date else None
        d["line_date"] = self.line_date.isoformat()
        for k in ("quantity_kl", "shortage", "gross_amt", "penalty_amt",
                  "igst_amt", "cgst_amt", "sgst_amt"):
            d[k] = None if d[k] is None else str(d[k])
        for k in ("rtd", "rate"):
            d[k] = None if d[k] is None else str(d[k])
        d.update(
            computed_gross=str(self.computed_gross) if self.computed_gross is not None else None,
            formula_ok=self.formula_ok,
            vehicle_norm=self.vehicle_norm,
            ship_to_code=self.ship_to_code,
            ship_to_name=self.ship_to_name,
            line_uid=self.line_uid,
            group_uid=self.group_uid,
            in_window=self.in_window,
        )
        return d


@dataclass
class ParsedBill:
    pdf_path: str
    pdf_name: str
    pdf_sha256: str
    tool_version: str = TOOL_VERSION
    vendor_code: Optional[str] = None
    vendor_gstin: Optional[str] = None      # Prasad Transport (us)
    buyer_gstin: Optional[str] = None       # IOCL RC office (them)
    rc_office: Optional[str] = None
    period_from: Optional[date] = None
    period_to: Optional[date] = None
    pages: int = 0
    doc_type: Optional[str] = None   # TRANSPORTATION_BILL | AC5_INVOICE | PAYMENT_ADVICE
    lines: list[BillLine] = field(default_factory=list)
    out_of_window: list[BillLine] = field(default_factory=list)
    checksums: list[dict] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def checksum_ok(self) -> Optional[bool]:
        if not self.checksums:
            return None
        return all(c["ok"] for c in self.checksums)

    def totals(self) -> dict[str, Decimal]:
        t = {k: ZERO for k in ("gross", "penalty", "igst", "cgst", "sgst")}
        for ln in self.lines:
            t["gross"] += ln.gross_amt
            t["penalty"] += ln.penalty_amt
            t["igst"] += ln.igst_amt
            t["cgst"] += ln.cgst_amt
            t["sgst"] += ln.sgst_amt
        return t

    def to_dict(self, include_out_of_window: bool = False) -> dict:
        d = {
            "pdf_path": self.pdf_path,
            "pdf_name": self.pdf_name,
            "pdf_sha256": self.pdf_sha256,
            "tool_version": self.tool_version,
            "vendor_code": self.vendor_code,
            "vendor_gstin": self.vendor_gstin,
            "buyer_gstin": self.buyer_gstin,
            "rc_office": self.rc_office,
            "period_from": self.period_from.isoformat() if self.period_from else None,
            "period_to": self.period_to.isoformat() if self.period_to else None,
            "window_from": WINDOW_FROM.isoformat(),
            "window_to": WINDOW_TO.isoformat(),
            "pages": self.pages,
            "lines_parsed": len(self.lines) + len(self.out_of_window),
            "lines_in_window": len(self.lines),
            "lines_out_window": len(self.out_of_window),
            "checksum_ok": self.checksum_ok,
            "checksums": self.checksums,
            "warnings": self.warnings,
            "totals": {k: str(v) for k, v in self.totals().items()},
            "lines": [ln.to_dict() for ln in self.lines],
        }
        if include_out_of_window:
            d["excluded_lines"] = [ln.to_dict() for ln in self.out_of_window]
        return d


# ═════════════════════════════════════════════════════════════════════════════
# Layout primitives
# ═════════════════════════════════════════════════════════════════════════════
def group_words_into_lines(words: list[dict], y_tol: float = 2.5) -> list[dict]:
    """Bucket words into visual rows by their `top` coordinate.

    pdfplumber emits words in reading order but a table row's words can differ
    by a fraction of a point vertically; y_tol absorbs that without merging
    genuinely separate rows (row pitch in this bill is ~11pt).
    """
    lines: list[dict] = []
    current: Optional[dict] = None
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if current is None or abs(w["top"] - current["top"]) > y_tol:
            current = {"top": w["top"], "words": [w]}
            lines.append(current)
        else:
            current["words"].append(w)
    for ln in lines:
        ln["words"].sort(key=lambda w: w["x0"])
        ln["text"] = " ".join(w["text"] for w in ln["words"])
    return lines


def find_money_edges(lines: list[dict]) -> Optional[list[float]]:
    """Right edges of the five money columns, read off the header row.

    Every money column header - and only those - ends in "(Rs.)":
        Gross Amt.(Rs.) | PenaltyAmt.(Rs.) | IGST(Rs.) | CGST(Rs.) | S/UGST(Rs.)
    so five "(Rs.)" hits in x-order ARE the five columns. No positional
    guesswork, no hard-coded millimetres.
    """
    for ln in lines:
        txt = ln["text"]
        if "SNo" not in txt or "Invoice" not in txt:
            continue
        hits = [w for w in ln["words"] if RE_MONEY_HDR.search(w["text"])]
        if len(hits) >= 5:
            return [w["x1"] for w in hits[-5:]]
    return None


def centre(w: dict) -> float:
    return (w["x0"] + w["x1"]) / 2.0


def find_columns(lines: list[dict]) -> Optional[dict]:
    """Column x-bands for Ship-to-party and Material, read off the header row.

    Two traps, both hit on the real bill:

    1. Headers are CENTRED over their columns, data is LEFT-ALIGNED. The header
       'Ship-to-party' starts at x=172.8 while its data starts at x=138.9, so a
       band taken from the header's own extent silently excludes every value
       and every wrapped continuation. Bands are therefore measured between
       NEIGHBOURING anchors: ship-to runs from the right edge of Date to the
       left edge of Material.

    2. A value can be wider than its header. Material '16730' spans x0=252.3,
       which is 0.9pt left of the Material header's x0=255.2 - so an x0 test
       misfiles it as part of the destination name. Classifying by the token's
       CENTRE (260.7) puts it unambiguously in the Material column.
    """
    for ln in lines:
        txt = ln["text"]
        if "SNo" not in txt or "Invoice" not in txt:
            continue
        anchor: dict[str, dict] = {}
        for w in ln["words"]:
            for key, label in (("date", "Date"), ("shipto", "Ship-to-party"),
                               ("material", "Material"), ("quantity", "Quantity")):
                if key not in anchor and w["text"].startswith(label):
                    anchor[key] = w
        if "material" not in anchor:
            continue
        mat_x0 = anchor["material"]["x0"]
        left = anchor["date"]["x1"] + 1.0 if "date" in anchor else mat_x0 - 130.0
        quantity_x0 = anchor["quantity"]["x0"] if "quantity" in anchor else mat_x0 + 40.0
        return {
            "shipto": (left, mat_x0 - 2.0),
            "material": (mat_x0 - 10.0, quantity_x0 - 2.0),
        }
    return None


def assign_money_by_edge(
    words: list[dict], edges: list[float], tol: float
) -> Optional[list[Decimal]]:
    """Bind numbers to columns by right-edge proximity.

    Right-alignment is the invariant this bill actually guarantees: '1,605.36'
    and '12,938.08' have different widths but identical right edges. Each token
    is consumed at most once, so a stray number cannot fill two columns.
    """
    numeric = [w for w in words if RE_NUMERIC.match(w["text"])]
    out: list[Optional[Decimal]] = [None] * len(edges)
    taken: set[int] = set()
    for i, edge in enumerate(edges):
        best_j, best_d = None, tol + 1.0
        for j, w in enumerate(numeric):
            if j in taken:
                continue
            d = abs(w["x1"] - edge)
            if d < best_d:
                best_d, best_j = d, j
        if best_j is not None and best_d <= tol:
            taken.add(best_j)
            out[i] = money(numeric[best_j]["text"])
    if any(v is None for v in out):
        return None
    return [v for v in out if v is not None]


def assign_money_by_tail(words: list[dict]) -> Optional[list[Decimal]]:
    """Fallback: the last five numbers on the row.

    Holds because the money block is always the rightmost run of numbers and
    IOCL prints 0.00 rather than leaving a cell blank.
    """
    numeric = [w["text"] for w in words if RE_NUMERIC.match(w["text"])]
    if len(numeric) < 5:
        return None
    return [money(t) for t in numeric[-5:]]


# ═════════════════════════════════════════════════════════════════════════════
# Row classification
# ═════════════════════════════════════════════════════════════════════════════
def looks_like_vehicle_header(ln: dict) -> Optional[str]:
    """A vehicle sub-header is a lone registration number on its own row."""
    words = ln["words"]
    if len(words) != 1:
        return None
    tok = words[0]["text"].strip()
    if RE_VEHICLE.match(tok) and not RE_DDMMYYYY.match(tok):
        return tok
    return None


def looks_like_data_row(ln: dict) -> Optional[dict]:
    """SNo | InvoiceNo | Item | dd.mm.yyyy | ... - the only shape data takes."""
    w = [x["text"] for x in ln["words"]]
    if len(w) < 6:
        return None
    if RE_MARKER.search(ln["text"]):
        return None
    # Layout A (as printed): 1 7008644452 20 10.07.2026 ...
    if w[0].isdigit() and RE_INVOICE.match(w[1]) and RE_ITEM.match(w[2]) and RE_DDMMYYYY.match(w[3]):
        return {"s_no": int(w[0]), "invoice_no": w[1], "item_code": w[2], "date_idx": 3}
    # Layout B (defensive): SNo merged away, invoice first.
    if RE_INVOICE.match(w[0]) and RE_ITEM.match(w[1]) and RE_DDMMYYYY.match(w[2]):
        return {"s_no": None, "invoice_no": w[0], "item_code": w[1], "date_idx": 2}
    return None


def extract_ship_to_and_material(
    ln: dict, date_idx: int, cols: Optional[dict]
) -> tuple[str, Optional[str]]:
    """Split the row's middle into destination name and material code.

    Everything whose centre lies in the Ship-to-party column is the destination
    ('347352-BIDANGSHREE SERVICE'); the first token at or beyond the Material
    column closes it. Material is a 4-6 digit product code (50700 = MS,
    16730 = HSD). Column-anchored rather than word-counted, because destination
    names run from one word to four.
    """
    tail = ln["words"][date_idx + 1:]
    name_parts: list[str] = []
    material: Optional[str] = None

    if cols is None:  # geometry unavailable - fall back to the code heuristic
        for w in tail:
            if re.fullmatch(r"\d{4,6}", w["text"]) and name_parts:
                material = w["text"]
                break
            name_parts.append(w["text"])
        return " ".join(name_parts).strip(), material

    shipto_right = cols["shipto"][1]
    mat_lo, mat_hi = cols["material"]
    for w in tail:
        c, t = centre(w), w["text"]

        # A long destination can run flush against the material code with no
        # intervening space, and pdfplumber then emits ONE word:
        #   '332916-BALAJAN KISAN SEVA KENDRA50700'
        # Real, and it appears in the live bills. Detect it by the token
        # physically reaching into the Material column, and split it.
        if w["x1"] >= mat_lo:
            glued = re.fullmatch(r"(.*[A-Za-z])(\d{4,6})", t)
            if glued:
                name_parts.append(glued.group(1))
                material = glued.group(2)
                break

        if c < shipto_right:
            name_parts.append(t)
            continue
        if mat_lo <= c <= mat_hi and re.fullmatch(r"\d{4,6}", t):
            material = t
        break  # past the destination column either way
    return " ".join(name_parts).strip(), material


def is_continuation(ln: dict, cols: Optional[dict]) -> bool:
    """A wrapped Ship-to-party cell: every word centred inside that column.

    'STATION' on its own row under '375161-JAI BAJRANGBALI SERVO' is one cell,
    not one row. Subtotal/marker rows are filtered before this and money rows
    sit far to the right, so the band test alone separates them.
    """
    if cols is None or not ln["words"]:
        return False
    if RE_MARKER.search(ln["text"]):
        return False
    if looks_like_data_row(ln) or looks_like_vehicle_header(ln):
        return False
    lo, hi = cols["shipto"]
    return all(lo <= centre(w) <= hi for w in ln["words"])


# ═════════════════════════════════════════════════════════════════════════════
# The parser
# ═════════════════════════════════════════════════════════════════════════════
def parse_bill(
    pdf_path: Path,
    edge_tol: float = 14.0,
    strategy: str = "auto",
    verbose: bool = False,
) -> ParsedBill:
    """Read one Transportation Bill PDF into a ParsedBill.

    `strategy`: auto (edge, then tail) | edge | tail
    """
    bill = ParsedBill(
        pdf_path=str(pdf_path),
        pdf_name=pdf_path.name,
        pdf_sha256=sha256_file(pdf_path),
    )

    # Parser state that persists across pages: a vehicle block and its bill
    # header continue over a page break without being reprinted.
    cur_bill_no: Optional[str] = None
    cur_bill_date: Optional[date] = None
    cur_vehicle: Optional[str] = None
    reverse_charge = False
    # (bill_no, vehicle, block_seq) -> running sums, checked at "Subtotal".
    block_sums: dict[str, Decimal] = {k: ZERO for k in ("gross", "penalty", "igst", "cgst", "sgst")}
    block_label = ""
    bill_sums: dict[str, Decimal] = {k: ZERO for k in ("gross", "penalty", "igst", "cgst", "sgst")}
    last_line: Optional[BillLine] = None
    all_lines: list[BillLine] = []

    def reset(d: dict[str, Decimal]) -> None:
        for k in d:
            d[k] = ZERO

    def add(d: dict[str, Decimal], vals: list[Decimal]) -> None:
        for k, v in zip(("gross", "penalty", "igst", "cgst", "sgst"), vals):
            d[k] += v

    def check(label: str, printed: list[Decimal], ours: dict[str, Decimal]) -> None:
        keys = ("gross", "penalty", "igst", "cgst", "sgst")
        deltas = {k: (p - ours[k]) for k, p in zip(keys, printed)}
        ok = all(abs(v) <= Decimal("0.05") for v in deltas.values())
        bill.checksums.append({
            "scope": label,
            "ok": ok,
            "printed": {k: str(p) for k, p in zip(keys, printed)},
            "parsed": {k: str(ours[k]) for k in keys},
            "delta": {k: str(v) for k, v in deltas.items()},
        })
        if not ok:
            bill.warnings.append(
                f"CHECKSUM MISMATCH {label}: printed gross {printed[0]} vs parsed {ours['gross']}"
            )

    with pdfplumber.open(str(pdf_path)) as pdf:
        bill.pages = len(pdf.pages)
        edges: Optional[list[float]] = None
        cols: Optional[dict] = None

        for page_no, page in enumerate(pdf.pages, start=1):
            words = page.extract_words(
                x_tolerance=1.5, y_tolerance=2.0, keep_blank_chars=False, use_text_flow=False
            )
            if not words:
                bill.warnings.append(f"page {page_no}: no extractable text (scanned image?)")
                continue
            lines = group_words_into_lines(words)

            if bill.doc_type is None:
                page_text = " ".join(ln["text"] for ln in lines[:24])
                if re.search(r"Transportation\s+Bill", page_text, re.I):
                    bill.doc_type = "TRANSPORTATION_BILL"
                elif re.search(r"STOCK\s+TRANSFER|Form\s*No\s*AC5", page_text, re.I):
                    bill.doc_type = "AC5_INVOICE"
                elif re.search(r"Payment\s+Advice", page_text, re.I):
                    bill.doc_type = "PAYMENT_ADVICE"

            # Column geometry is re-read per page; every page reprints the header.
            page_edges = find_money_edges(lines)
            if page_edges:
                edges = page_edges
            page_cols = find_columns(lines)
            if page_cols:
                cols = page_cols

            for ln in lines:
                text = ln["text"]

                # ── Document-level facts (printed on every page header) ──────
                if bill.vendor_code is None:
                    m = RE_VENDOR.search(text)
                    if m:
                        bill.vendor_code = m.group(1)
                m_buyer = RE_GSTIN_BUYER.search(text)
                if m_buyer and bill.buyer_gstin is None:
                    bill.buyer_gstin = m_buyer.group(1)
                elif bill.vendor_gstin is None:
                    m = RE_GSTIN_ANY.search(text)
                    if m and m.group(1) != bill.buyer_gstin:
                        bill.vendor_gstin = m.group(1)
                if bill.rc_office is None:
                    m = RE_RC_OFFICE.match(text)
                    if m:
                        bill.rc_office = f"{m.group(1).strip()} ({m.group(2)})"
                if bill.period_from is None:
                    m = RE_PERIOD.search(text)
                    if m:
                        bill.period_from = ddmmyyyy(m.group(1))
                        bill.period_to = ddmmyyyy(m.group(2))

                # ── Bill block boundary ──────────────────────────────────────
                m = RE_BILL_NO.search(text)
                if m:
                    cur_bill_no = m.group(1)
                    cur_bill_date = ddmmyyyy(m.group(2))
                    cur_vehicle = None
                    reset(bill_sums)
                    reverse_charge = "reverse charge" in text.lower()
                    last_line = None
                    continue

                if re.search(r"Reverse\s+Charge", text, re.I):
                    reverse_charge = True
                    continue

                # ── Vehicle sub-header: scopes every row until the next one ──
                veh = looks_like_vehicle_header(ln)
                if veh:
                    cur_vehicle = veh
                    reset(block_sums)
                    block_label = f"vehicle {veh} @ bill {cur_bill_no}"
                    last_line = None
                    continue

                # ── Subtotal / total: verify, do not ingest ──────────────────
                if re.search(r"Subtotal\s+for\s+Vehicle", text, re.I):
                    printed = (
                        (assign_money_by_edge(ln["words"], edges, edge_tol) if edges else None)
                        or assign_money_by_tail(ln["words"])
                    )
                    if printed:
                        check(block_label or "vehicle block", printed, block_sums)
                    last_line = None
                    continue

                # Document grand total - the strongest check available, because
                # it covers every bill block on every page at once.
                if re.search(r"Total\s+of\s+All\s+Bills", text, re.I):
                    printed = (
                        (assign_money_by_edge(ln["words"], edges, edge_tol) if edges else None)
                        or assign_money_by_tail(ln["words"])
                    )
                    if printed:
                        doc_sums = {k: ZERO for k in ("gross", "penalty", "igst", "cgst", "sgst")}
                        for prev in all_lines:
                            add(doc_sums, [prev.gross_amt, prev.penalty_amt,
                                           prev.igst_amt, prev.cgst_amt, prev.sgst_amt])
                        check("ALL BILLS (document total)", printed, doc_sums)
                    last_line = None
                    continue

                if re.search(r"Total\s+for\s+Bill", text, re.I):
                    printed = (
                        (assign_money_by_edge(ln["words"], edges, edge_tol) if edges else None)
                        or assign_money_by_tail(ln["words"])
                    )
                    if printed:
                        check(f"bill {cur_bill_no}", printed, bill_sums)
                    last_line = None
                    continue

                # ── Wrapped Ship-to-party cell ───────────────────────────────
                if last_line is not None and is_continuation(ln, cols):
                    last_line.ship_to_raw = f"{last_line.ship_to_raw} {text}".strip()
                    last_line.source_line += " | " + text
                    continue

                # ── Data row ─────────────────────────────────────────────────
                head = looks_like_data_row(ln)
                if not head:
                    continue

                line_date = ddmmyyyy(ln["words"][head["date_idx"]]["text"])
                if line_date is None:
                    bill.warnings.append(f"page {page_no}: unparseable date in: {text[:90]}")
                    continue

                vals: Optional[list[Decimal]] = None
                if strategy in ("auto", "edge") and edges:
                    vals = assign_money_by_edge(ln["words"], edges, edge_tol)
                if vals is None and strategy in ("auto", "tail"):
                    vals = assign_money_by_tail(ln["words"])
                if vals is None:
                    bill.warnings.append(
                        f"page {page_no}: could not bind money columns in: {text[:90]}"
                    )
                    continue

                if cur_vehicle is None:
                    bill.warnings.append(
                        f"page {page_no}: data row before any vehicle sub-header: {text[:90]}"
                    )
                    continue

                ship_raw, material = extract_ship_to_and_material(ln, head["date_idx"], cols)

                # Quantity / shortage are the first two 1-3dp decimals after the
                # material code ('6.000 KL  0.000 L'). The RTD/RATE block that
                # follows uses 1dp and 6dp, so it cannot be mistaken for them.
                after_mat = [w["text"] for w in ln["words"][head["date_idx"] + 1:]]
                decs = [t for t in after_mat if re.fullmatch(r"\d+\.\d{1,3}", t)]
                quantity = qty(decs[0]) if len(decs) >= 1 else None
                shortage = qty(decs[1]) if len(decs) >= 2 else None

                # A data row's trailing numbers are always the same eleven:
                #   RTD(P,H,HH)  RATE(P,H,HH)  gross penalty igst cgst sgst
                # Only the P (petrol/primary) leg is ever used on these bills;
                # H and HH carry 0. Taking them from the tail rather than by
                # x-position keeps this working when the RTD/RATE sub-headers
                # shift, which they do between depot layouts.
                nums = [w["text"] for w in ln["words"] if RE_NUMERIC.match(w["text"])]
                rtd = rate = None
                if len(nums) >= 11:
                    rtd = qty(nums[-11])
                    try:
                        rate = Decimal(nums[-8].replace(",", ""))
                    except (InvalidOperation, ValueError):
                        rate = None

                bl = BillLine(
                    bill_no=cur_bill_no or "UNKNOWN",
                    bill_date=cur_bill_date,
                    reverse_charge=reverse_charge,
                    s_no=head["s_no"],
                    invoice_no=head["invoice_no"],
                    item_code=head["item_code"],
                    line_date=line_date,
                    vehicle_no_raw=cur_vehicle,
                    ship_to_raw=ship_raw,
                    material=material,
                    quantity_kl=quantity,
                    shortage=shortage,
                    rtd=rtd,
                    rate=rate,
                    gross_amt=vals[0],
                    penalty_amt=vals[1],
                    igst_amt=vals[2],
                    cgst_amt=vals[3],
                    sgst_amt=vals[4],
                    page_no=page_no,
                    source_line=text,
                )
                all_lines.append(bl)
                last_line = bl
                add(block_sums, vals)
                add(bill_sums, vals)

                if verbose:
                    print(f"  [{page_no}] {cur_vehicle} {line_date} {ship_raw[:34]:34s} {vals[0]:>10}")

    # ── Window filter LAST, so checksums saw every row ───────────────────────
    for bl in all_lines:
        (bill.lines if bl.in_window else bill.out_of_window).append(bl)

    if not all_lines:
        # Distinguish "wrong document type" from "unreadable document". IOCL
        # mails several PDFs against the same vendor code and only the
        # Transportation Bill is a freight statement:
        #   AC5 / "STOCK TRANSFER - ISSUES UNDER RULE 11"  per-load dispatch
        #       invoice - carries T.T. No and product, but NO freight amount,
        #       so there is nothing here to reconcile against a trip.
        #   Payment Advice  remittance summary, no per-trip lines.
        # Telling an operator to OCR a perfectly readable AC5 sends them down a
        # blind alley.
        if bill.doc_type and bill.doc_type != "TRANSPORTATION_BILL":
            bill.warnings.append(
                f"Not a Transportation Bill - this is a {bill.doc_type.replace('_', ' ')} "
                f"document, which carries no freight amounts. Nothing to reconcile; skipped."
            )
        else:
            bill.warnings.append(
                "No data rows extracted. If the PDF is a scan rather than a digital "
                "statement, OCR it first (see README) - this parser reads text, not pixels."
            )
    return bill


# ═════════════════════════════════════════════════════════════════════════════
# Output
# ═════════════════════════════════════════════════════════════════════════════
CSV_COLUMNS = [
    "pdf_name", "bill_no", "bill_date", "reverse_charge", "s_no", "invoice_no",
    "item_code", "line_date", "vehicle_no_raw", "vehicle_norm", "ship_to_code",
    "ship_to_name", "material", "quantity_kl", "shortage", "gross_amt",
    "penalty_amt", "igst_amt", "cgst_amt", "sgst_amt", "page_no",
    "line_uid", "group_uid",
]


def write_csv(bills: list[ParsedBill], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for b in bills:
            for ln in b.lines:
                row = ln.to_dict()
                row["pdf_name"] = b.pdf_name
                w.writerow(row)


def print_report(bill: ParsedBill) -> None:
    t = bill.totals()
    print(f"\n=== {bill.pdf_name} ===")
    print(f"  vendor {bill.vendor_code or '?'}   our GSTIN {bill.vendor_gstin or '?'}   "
          f"buyer {bill.buyer_gstin or '?'}   {bill.rc_office or ''}")
    if bill.period_from:
        print(f"  bill period      : {bill.period_from} .. {bill.period_to}")
    print(f"  window applied   : {WINDOW_FROM} .. {WINDOW_TO}  (inclusive)")
    print(f"  pages            : {bill.pages}")
    print(f"  lines in window  : {len(bill.lines)}")
    print(f"  lines EXCLUDED   : {len(bill.out_of_window)}  (outside window)")
    print(f"  gross (in window): {t['gross']:>14,}")
    print(f"  IGST/CGST/SGST   : {t['igst']:>14,} / {t['cgst']:,} / {t['sgst']:,}")
    ck = bill.checksum_ok
    verdict = "PASS" if ck else ("FAIL" if ck is False else "n/a (no subtotals found)")
    print(f"  subtotal checksum: {verdict}  ({len(bill.checksums)} blocks verified)")
    for c in bill.checksums:
        if not c["ok"]:
            print(f"     ! {c['scope']}: printed {c['printed']['gross']} vs parsed {c['parsed']['gross']}")
    for w in bill.warnings[:12]:
        print(f"  WARN: {w}")
    if len(bill.warnings) > 12:
        print(f"  ... and {len(bill.warnings) - 12} more warnings")


# ═════════════════════════════════════════════════════════════════════════════
def expand_inputs(patterns: Iterable[str]) -> list[Path]:
    out: list[Path] = []
    for p in patterns:
        path = Path(p)
        if path.is_dir():
            # Both cases, deliberately: IOCL names depot transportation bills
            # `...06.2026.PDF` and Linux glob is case-sensitive. On Windows the
            # two patterns match the same files and the resolve() de-dupe below
            # collapses them. Same lesson iocl_ac5_loading.py already carries —
            # on the AWS box a single-case glob silently parsed 0 of 252 bills.
            out.extend(sorted([*path.glob("*.pdf"), *path.glob("*.PDF")]))
        elif any(ch in p for ch in "*?["):
            out.extend(sorted(Path(m) for m in glob.glob(p)))
        elif path.exists():
            out.append(path)
        else:
            sys.stderr.write(f"WARN: no such file: {p}\n")
    # de-duplicate, preserve order
    seen, uniq = set(), []
    for p in out:
        rp = p.resolve()
        if rp not in seen:
            seen.add(rp)
            uniq.append(p)
    return uniq


def main(argv: Optional[list[str]] = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser(
        description="Parse IOCL Transportation Bill PDFs into structured line items.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("pdfs", nargs="+", help="PDF file(s), directory, or glob")
    ap.add_argument("--json", type=Path, help="write parsed output as JSON")
    ap.add_argument("--csv", type=Path, help="write in-window line items as CSV")
    ap.add_argument("--strategy", choices=("auto", "edge", "tail"), default="auto",
                    help="money-column binding (default: auto = edge, fall back to tail)")
    ap.add_argument("--edge-tol", type=float, default=14.0,
                    help="points of slack when binding a number to a column right-edge")
    ap.add_argument("--keep-out-of-window", action="store_true",
                    help="include excluded rows in the JSON under 'excluded_lines' (for audit)")
    ap.add_argument("--strict-checksum", action="store_true",
                    help="exit 3 if any printed subtotal disagrees with the parsed sum")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    add_window_args(ap)
    args = ap.parse_args(argv)
    set_window(args.window_from, args.window_to)

    paths = expand_inputs(args.pdfs)
    if not paths:
        sys.stderr.write("FATAL: no input PDFs resolved\n")
        return 2

    bills = [parse_bill(p, edge_tol=args.edge_tol, strategy=args.strategy, verbose=args.verbose)
             for p in paths]

    if not args.quiet:
        for b in bills:
            print_report(b)

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        payload = [b.to_dict(include_out_of_window=args.keep_out_of_window) for b in bills]
        args.json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        if not args.quiet:
            print(f"\nJSON -> {args.json}")

    if args.csv:
        write_csv(bills, args.csv)
        if not args.quiet:
            print(f"CSV  -> {args.csv}")

    total_lines = sum(len(b.lines) for b in bills)
    if total_lines == 0:
        sys.stderr.write("FATAL: zero in-window line items extracted\n")
        return 2
    if args.strict_checksum and any(b.checksum_ok is False for b in bills):
        sys.stderr.write("FATAL: subtotal checksum failed (--strict-checksum)\n")
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
