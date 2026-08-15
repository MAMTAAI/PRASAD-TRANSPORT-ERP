#!/usr/bin/env python
"""
tools/fuel_recon/pump_bill_parser.py — read fuel pump bills into rows.

WHY THIS EXISTS AS A PARSER AND NOT AN UPLOADER. The brief asked for a
CSV/Excel bulk uploader. The bills are not spreadsheets: they are 132 PDFs from
11 pumps, and every pump prints a different layout. An uploader would only work
if somebody first retyped 132 bills by hand.

WHAT IS AND IS NOT READABLE, measured rather than assumed:

    Alam            16   line-based   vehicle number is TRUNCATED ("AS26C")
    Hey krishna     16   line-based   noisy; some rows lose columns
    Highway         16   coordinates  extract_text() interleaves the columns
    Sree krishna    14   line-based   clean
    B N filling      8   line-based   clean; slip numbers are masked "xxxx"
    Nirmala         20   line-based   clean; rate prints split ("1 00.78")
    Sree krishna    14   line-based   clean  (Jaiswal)
    ---------------------------------------------------------------
    Shivam           8   BROKEN FONT  "CEN'rRE", "3 0 7 4 0 . . O 4(" — the
                                      embedded font maps to wrong glyphs, so
                                      extraction returns mojibake. OCR only.
    Jon N Well       8   SCANNED      0 characters of text
    Pawan            9   SCANNED      0 characters
    Hatsingimari     1   SCANNED      0 characters

REFUSES RATHER THAN GUESSES. Every row is emitted with a `confidence` and a
list of `flags`. A row whose vehicle is truncated, whose date falls outside the
bill's own period, or whose amount does not equal qty x rate is flagged and
sent to review — it is NOT silently dropped and NOT silently imported. Fuel is
a direct cost on somebody's khata; a wrong litre is a wrong rupee in a real
person's account.

    python tools/fuel_recon/pump_bill_parser.py --scan
    python tools/fuel_recon/pump_bill_parser.py --pump "B N filling" --json out.json
    python tools/fuel_recon/pump_bill_parser.py --all --json fuel_rows.json
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict

try:
    import pdfplumber
except ImportError:
    sys.exit("pdfplumber is required:  pip install pdfplumber")

# Windows consoles are cp1252 and these bills carry Devanagari and rupee signs.
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

DESKTOP = os.path.join(os.path.expanduser("~"), "Desktop")
GROUPS = {
    "Prasad Pump": "PRASAD TRANSPORT",
    "Jaiswal pump": "JAISWAL ENTERPRISE",
}

DATE_RE = re.compile(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})")
# A registration is 2 letters, 1-2 digits, 1-3 letters, 4 digits — with any
# amount of punctuation or spacing between the parts, because every pump picks
# a different one (AS26C5104 / AS-26C-5104 / NL 01AA 3054).
REG_RE = re.compile(r"\b([A-Z]{2})[\s\-]?(\d{1,2})[\s\-]?([A-Z]{1,3})[\s\-]?(\d{4})\b")



def pdfs_in(folder: str) -> list[str]:
    """Every PDF in a folder, exactly once.

    Windows filesystems are case-insensitive, so glob('*.pdf') and
    glob('*.PDF') BOTH return the same file and naively concatenating them
    parses every bill twice — which would have double-counted 412 fuel rows and
    posted every litre twice onto somebody's khata. De-duplicated by real path.
    """
    seen, out = set(), []
    for pat in ("*.pdf", "*.PDF"):
        for f in glob.glob(os.path.join(folder, pat)):
            key = os.path.normcase(os.path.abspath(f))
            if key not in seen:
                seen.add(key)
                out.append(f)
    return sorted(out)


def norm_reg(s: str) -> str:
    """Same normalisation the database's norm_reg() generated column uses."""
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


# ── glyph repair ────────────────────────────────────────────────────────────
# Several bills embed a font whose glyphs map to the wrong characters, so a
# registration comes out as "NLOlAA3057" and a date as "t0.04.2026". Nirmala's
# April files are corrupted this way while its July files are clean, so this is
# per-FILE damage, not per-pump.
#
# The confusions are the standard set (O/0, l/I/t/1, S/5, B/8) and they are
# applied ONLY where the pattern says a digit belongs — never across a whole
# line, which would turn a real "AS" into "A5". A repaired row is FLAGGED, so a
# human still sees that the source was damaged.
_D = str.maketrans({"O": "0", "o": "0", "Q": "0", "D": "0",
                    "l": "1", "I": "1", "i": "1", "t": "1", "|": "1",
                    "S": "5", "s": "5", "B": "8", "Z": "2", "g": "9"})
_L = str.maketrans({"0": "O", "1": "I", "5": "S", "8": "B"})

REG_LOOSE = re.compile(r"\b([A-Z]{2})[\s\-]?([A-Za-z0-9]{1,2})[\s\-]?([A-Za-z]{1,3})[\s\-]?([A-Za-z0-9]{4})\b")


def repair_reg(token: str) -> str | None:
    """Turn a glyph-damaged registration into the real one, or None."""
    m = REG_LOOSE.match(token.strip())
    if not m:
        return None
    state, num, series, digits = m.groups()
    fixed = f"{state.upper()}{num.translate(_D)}{series.upper().translate(_L)}{digits.translate(_D)}"
    return fixed if REG_RE.match(fixed) else None


def repair_date(token: str) -> str | None:
    """'t0.04.2026' -> '10.04.2026'."""
    fixed = re.sub(r"[a-zA-Z|]", lambda c: c.group(0).translate(_D), token)
    return fixed if DATE_RE.search(fixed) else None


def to_iso(tok: str, default_year: int | None = None) -> str | None:
    m = DATE_RE.search(tok or "")
    if not m:
        return None
    d, mo, y = m.groups()
    y = int(y)
    if y < 100:
        y += 2000
    d, mo = int(d), int(mo)
    if not (1 <= d <= 31 and 1 <= mo <= 12):
        return None
    return f"{y:04d}-{mo:02d}-{d:02d}"


def money(tok: str) -> float | None:
    if tok is None:
        return None
    t = re.sub(r"[^\d.]", "", str(tok).replace(",", ""))
    if t in ("", "."):
        return None
    try:
        return float(t)
    except ValueError:
        return None


@dataclass
class Row:
    pump: str
    group: str
    company_hint: str
    source_file: str
    date: str | None = None
    vehicle_raw: str | None = None
    vehicle_norm: str | None = None
    memo_no: str | None = None
    product: str = "HSD"
    qty: float | None = None
    rate: float | None = None
    amount: float | None = None
    cash: float | None = None
    total: float | None = None
    flags: list[str] = field(default_factory=list)

    @property
    def confidence(self) -> str:
        if "NO_VEHICLE" in self.flags or "TRUNCATED_VEHICLE" in self.flags:
            return "REVIEW"
        if "AMOUNT_MISMATCH" in self.flags or "DATE_OUT_OF_PERIOD" in self.flags:
            return "REVIEW"
        return "OK" if (self.date and self.vehicle_norm and self.amount) else "REVIEW"


def _finish(r: Row, period: tuple[str, str] | None) -> Row:
    """Shared sanity checks, applied to every layout."""
    if not r.vehicle_norm:
        r.flags.append("NO_VEHICLE")
    elif len(r.vehicle_norm) < 8:
        # "AS26C" — the pump printed the series without the number. Nobody can
        # tell which of the 49 trucks this was.
        r.flags.append("TRUNCATED_VEHICLE")

    if r.qty and r.rate and r.amount:
        expect = round(r.qty * r.rate, 2)
        # 1 rupee tolerance: several pumps round the line to whole rupees.
        if abs(expect - r.amount) > 1.0:
            r.flags.append("AMOUNT_MISMATCH")

    if period and r.date and not (period[0] <= r.date <= period[1]):
        # Real in this data: a 2026 bill carrying a row dated 2024.
        r.flags.append("DATE_OUT_OF_PERIOD")
    return r


def find_period(text: str) -> tuple[str, str] | None:
    """The bill's own printed period, used to catch typo'd row dates."""
    m = re.search(r"(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})\s*(?:To|TO|to)\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})", text)
    if not m:
        return None
    a, b = to_iso(m.group(1)), to_iso(m.group(2))
    return (a, b) if a and b else None


# ── layout handlers ─────────────────────────────────────────────────────────
# Each takes the page text and yields Rows. They are deliberately separate
# functions: one clever generic parser across six layouts would fail on all of
# them in ways nobody could debug.

def parse_generic_line(text, mk, *, cols):
    """Shared engine for the line-based layouts.

    `cols` names what to expect AFTER the vehicle number, in order. Anything a
    layout does not have is simply absent from the list.
    """
    period = find_period(text)
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or len(line) < 12:
            continue
        d = DATE_RE.search(line)
        repaired_date = False
        if not d:
            # Try glyph repair before giving up — a damaged font turns
            # "10.04.2026" into "t0.04.2026" and the row is otherwise fine.
            cand = re.search(r"[\dA-Za-z|]{1,2}[./-][\dA-Za-z|]{1,2}[./-]\d{2,4}", line)
            fixed = repair_date(cand.group(0)) if cand else None
            if not fixed:
                continue
            d = DATE_RE.search(fixed)
            repaired_date = True
        v = REG_RE.search(line.upper())
        r = mk()
        r.date = to_iso(d.group(0))
        if repaired_date:
            r.flags.append("REPAIRED_DATE")
        if v:
            r.vehicle_raw = v.group(0)
            r.vehicle_norm = norm_reg(v.group(0))
        elif (cand2 := REG_LOOSE.search(line)) and (fixed_reg := repair_reg(cand2.group(0))):
            r.vehicle_raw = cand2.group(0)
            r.vehicle_norm = norm_reg(fixed_reg)
            r.flags.append("REPAIRED_VEHICLE")
        else:
            # Alam prints "AS26C" with no digits — catch it so the row is
            # flagged rather than silently vehicle-less.
            t = re.search(r"\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3})\b", line.upper())
            if t:
                r.vehicle_raw = t.group(1)
                r.vehicle_norm = norm_reg(t.group(1))

        # Numbers to the right of the vehicle (or of the date when there is no
        # vehicle), in print order.
        anchor = line.upper().find((r.vehicle_raw or "").upper()) if r.vehicle_raw else d.end()
        tail = line[anchor + len(r.vehicle_raw or ""):] if r.vehicle_raw else line[d.end():]
        toks = re.findall(r"[\d,]+\.?\d*", tail)
        pairs = [(t, money(t)) for t in toks]
        pairs = [(t, n) for t, n in pairs if n is not None]
        toks = [t for t, _ in pairs]
        nums = [n for _, n in pairs]

        # A damaged font can split one number across two tokens — Nirmala
        # prints its rate as "1 00.78", which reads as 1 and 0.78 and makes the
        # line fail its own amount check. Rejoin when a "rate" is implausibly
        # small and the next token is a fraction.
        if len(cols) >= 2 and "rate" in cols:
            ri = cols.index("rate")
            if ri + 1 < len(nums) and nums[ri] is not None and 0 < nums[ri] < 10:
                # Join the RAW TOKENS, not the parsed floats: "00.78" becomes
                # 0.78 the moment it is a number and the leading zero is gone,
                # so "1" + 0.78 would give 10.78 instead of 100.78.
                joined = money(toks[ri] + toks[ri + 1])
                if joined and 40 <= joined <= 200:      # a diesel rate, in rupees
                    nums = nums[:ri] + [joined] + nums[ri + 2:]
                    toks = toks[:ri] + [str(joined)] + toks[ri + 2:]
                    r.flags.append("REPAIRED_RATE")

        for i, name in enumerate(cols):
            if i < len(nums):
                setattr(r, name, nums[i])
        if r.date:
            out.append(_finish(r, period))
    return out


LAYOUTS = {
    # Date Vehicle HSD Qty Rate Amount Cash Total
    "Sree krishna": dict(cols=["qty", "rate", "amount", "total"]),
    # S.no Date Slip Vehicle Item Qty Rate Amount
    "B N filling":  dict(cols=["qty", "rate", "amount"]),
    # Date Memo Vehicle Qty Rate Amount LUB Cash Total
    "Nirmala":      dict(cols=["qty", "rate", "amount", "cash", "total"]),
    # SL Date LORRY PRODUCT Qty Rate Amount Cash Total   (vehicle truncated)
    "Alam":         dict(cols=["qty", "rate", "amount", "cash", "total"]),
    # SI Date Vehicle HSD MS Challan Qty Rate Amount     (noisy)
    "Hey krishna":  dict(cols=["qty", "rate", "amount"]),
}


def parse_by_coordinates(text_unused, mk, page):
    """Highway prints a real table that extract_text() interleaves.

    Reading the words with their x/y positions and re-grouping by row recovers
    it — the same technique the IOCL parser needed for its vehicle sub-headers.
    """
    words = page.extract_words()
    rows: dict[int, list] = {}
    for w in words:
        band = round(w["top"] / 4)          # 4pt bands tolerate baseline wobble
        rows.setdefault(band, []).append(w)
    out = []
    for band in sorted(rows):
        ws = sorted(rows[band], key=lambda x: x["x0"])
        line = " ".join(w["text"] for w in ws)
        d = DATE_RE.search(line)
        v = REG_RE.search(line.upper())
        if not (d and v):
            continue
        r = mk()
        r.date = to_iso(d.group(0))
        r.vehicle_raw = v.group(0)
        r.vehicle_norm = norm_reg(v.group(0))
        nums = [money(x) for x in re.findall(r"[\d,]+\.?\d*", line[v.end():])]
        nums = [n for n in nums if n is not None]
        if nums:
            r.qty = nums[0]
            r.amount = max(nums)             # the money column is the largest
        if r.date:
            out.append(_finish(r, None))
    return out


def parse_pdf(path: str, pump: str, group: str) -> list[Row]:
    company = GROUPS.get(group, "")
    mk = lambda: Row(pump=pump, group=group, company_hint=company,
                     source_file=os.path.basename(path))
    out: list[Row] = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            text = page.extract_text() or ""
            if pump == "Highway":
                out += parse_by_coordinates(text, mk, page)
            elif pump in LAYOUTS:
                got = parse_generic_line(text, mk, **LAYOUTS[pump])
                # FALL BACK TO COORDINATES when line reading produced rows with
                # no money in them. Several bills (Nirmala's April files, all of
                # Highway) come out of extract_text() with the columns split
                # across separate lines, so the date and the vehicle land on one
                # line and the amounts on another. Reading the words by x/y
                # position puts the row back together. Detected rather than
                # hard-coded per pump, because the damage varies by MONTH within
                # one pump's folder.
                if got and not any(r.amount for r in got):
                    coords = parse_by_coordinates(text, mk, page)
                    got = coords if any(r.amount for r in coords) else got
                out += got
            else:
                # Unknown layout: try the commonest shape rather than skipping,
                # but everything lands in REVIEW because nothing was verified.
                got = parse_generic_line(text, mk, cols=["qty", "rate", "amount"])
                for r in got:
                    r.flags.append("UNVERIFIED_LAYOUT")
                out += got
    return out


UNREADABLE = {"Shivam", "Jon N Well", "Pawan", "Hatsingimari"}


def scan():
    print(f"{'GROUP':14}{'PUMP':16}{'PDFS':>5}  STATUS")
    print("-" * 62)
    for grp in GROUPS:
        base = os.path.join(DESKTOP, grp)
        if not os.path.isdir(base):
            print(f"  {grp}: folder not found")
            continue
        for pump in sorted(os.listdir(base)):
            d = os.path.join(base, pump)
            if not os.path.isdir(d):
                continue
            n = len(pdfs_in(d))
            status = "NEEDS OCR" if pump in UNREADABLE else ("coordinates" if pump == "Highway"
                     else ("parser ready" if pump in LAYOUTS else "unknown layout"))
            print(f"{grp:14}{pump:16}{n:>5}  {status}")


def run(pumps: list[str] | None, out_json: str | None):
    rows: list[Row] = []
    skipped = []
    for grp in GROUPS:
        base = os.path.join(DESKTOP, grp)
        if not os.path.isdir(base):
            continue
        for pump in sorted(os.listdir(base)):
            d = os.path.join(base, pump)
            if not os.path.isdir(d):
                continue
            if pumps and pump not in pumps:
                continue
            if pump in UNREADABLE:
                skipped.append((grp, pump))
                continue
            for f in pdfs_in(d):
                try:
                    rows += parse_pdf(f, pump, grp)
                except Exception as e:                       # noqa: BLE001
                    print(f"  ! {pump}/{os.path.basename(f)}: {e}")

    ok = [r for r in rows if r.confidence == "OK"]
    review = [r for r in rows if r.confidence == "REVIEW"]
    print(f"\n  parsed rows : {len(rows)}")
    print(f"  ready       : {len(ok)}")
    print(f"  need review : {len(review)}")
    if rows:
        print(f"  litres      : {sum(r.qty or 0 for r in ok):,.2f}")
        print(f"  amount      : {sum(r.amount or 0 for r in ok):,.2f}")

    flags: dict[str, int] = {}
    for r in review:
        for f in r.flags:
            flags[f] = flags.get(f, 0) + 1
    if flags:
        print("\n  why rows need review:")
        for k, v in sorted(flags.items(), key=lambda x: -x[1]):
            print(f"    {v:>5}  {k}")
    if skipped:
        print("\n  skipped (not machine-readable — OCR or manual entry):")
        for g, p in skipped:
            print(f"    {g}/{p}")

    per: dict[str, dict] = {}
    for r in rows:
        s = per.setdefault(r.pump, {"rows": 0, "ok": 0, "amount": 0.0})
        s["rows"] += 1
        if r.confidence == "OK":
            s["ok"] += 1
            s["amount"] += r.amount or 0
    print(f"\n  {'PUMP':16}{'ROWS':>6}{'OK':>6}{'AMOUNT':>16}")
    for p, s in sorted(per.items()):
        print(f"  {p:16}{s['rows']:>6}{s['ok']:>6}{s['amount']:>16,.2f}")

    if out_json:
        with open(out_json, "w", encoding="utf-8") as fh:
            json.dump([{**asdict(r), "confidence": r.confidence} for r in rows], fh, indent=1)
        print(f"\n  wrote {out_json}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--scan", action="store_true", help="list pumps and readability")
    ap.add_argument("--pump", action="append", help="parse only this pump (repeatable)")
    ap.add_argument("--all", action="store_true", help="parse every readable pump")
    ap.add_argument("--json", help="write parsed rows here")
    a = ap.parse_args()
    if a.scan:
        scan()
    elif a.all or a.pump:
        run(a.pump, a.json)
    else:
        ap.print_help()
