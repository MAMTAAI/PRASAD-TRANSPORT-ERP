#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
iocl_reconcile.py - THE MATCHER + THE UPDATER
================================================================================
Reconciles parsed IOCL Transportation Bill lines against the manually-entered
trips already in the Prasad Transport ERP (PostgreSQL `prasad_erp`), then writes
payment / TDS / GST back onto the matched trips.

Window: 01-04-2026 .. 21-08-2026 inclusive, enforced on BOTH sides.

--------------------------------------------------------------------------------
THE COMPOSITE KEY, AND WHY IT IS AGGREGATED FIRST
--------------------------------------------------------------------------------
The brief specifies `Vehicle Number + Trip Date + Location`. That key is right
for the ERP but is NOT unique in the PDF:

    1  7008644452 20 10.07.2026 347334-MAA KAMLASWRI KSK 50700 ... 1,605.36
    2  7008644452 10 10.07.2026 347334-MAA KAMLASWRI KSK 16730 ... 1,605.36

One truck, one day, one destination - billed twice because the load carried two
products (50700 = MS, 16730 = HSD). Matching line-by-line would either pair the
same trip twice or drop half the money. So the engine GROUPS PDF lines by the
composite key and sums them, then matches one group to one trip. Group gross is
what lands on the trip.

--------------------------------------------------------------------------------
HOW MATCHING ACTUALLY WORKS (verified against the live DB, 850 trips in window)
--------------------------------------------------------------------------------
  vehicle   PDF 'AS26AC0401'  vs ERP 'AS 26AC 0401'
            -> strip non-alphanumerics. Exact after that. Always required.

  date      PDF 'Date' column vs trips.loading_date. Exact by default;
            --date-tolerance N allows +/-N days, ranked so exact always wins.

  location  PDF '194783-DARAKONA FUELLING STATION'
            ERP '194783 DARAKONA FUELLING STATION'
            -> the 6-digit IOCL ship-to code is present on BOTH sides for 414
               of 850 in-window trips. Equal codes = an exact join (method CODE).
            -> for the rest, difflib similarity on the normalised name against
               consignee_name AND unloading_location (method NAME).

  conflict  A trip may be claimed by only one group. Groups are resolved
            highest-confidence first; a loser is recorded TRIP_ALREADY_CLAIMED
            rather than silently overwriting. The DB backs this with a unique
            index on iocl_recon_matches(trip_id).

Anything the engine cannot decide is written as an exception row, never guessed.
Refusing to match costs a clerk five minutes; a wrong match corrupts the books.

--------------------------------------------------------------------------------
TDS (SECTION 194C)
--------------------------------------------------------------------------------
Rates mirror server/lib/taxEngine.js exactly (1% individual/HUF, 2% other, 20%
no-PAN; thresholds Rs.30,000 single / Rs.1,00,000 FY). Two engines that disagree
about tax are worse than one, so if you change one, change both.

  * Base is GROSS FREIGHT, excluding GST. That is deliberate: CBDT Circular
    23/2017 - where GST is shown separately on the invoice (it is, in its own
    columns), TDS is not deducted on the GST component.
  * Prasad Transport's GSTIN 18AAKFP2339R2ZG carries PAN AAKFP2339R; the 4th
    character 'F' = partnership firm, hence the 2% default.
  * TDS is deducted by IOCL at BILL level. The engine computes it on the bill
    total and allocates it across groups by largest-remainder, in paise, so the
    trip-wise figures sum EXACTLY to the bill-level deduction. No rounding dust.
  * --tds-194c6 sets 0% for a transporter who has filed the 194C(6) declaration
    (<=10 goods carriages + PAN).

--------------------------------------------------------------------------------
GST
--------------------------------------------------------------------------------
Logged verbatim per trip from the bill's IGST / CGST / S-UGST columns. Note the
bill's 'Reverse Charge' banner: under GTA RCM the tax is discharged by IOCL, not
collected by us. These figures are therefore a MEMO on the trip and must not be
posted as output-GST-payable. `trips.gst_reverse_charge` carries that flag.

--------------------------------------------------------------------------------
SAFETY MODEL
--------------------------------------------------------------------------------
  default        read-only. Parses, matches, prints, writes report files.
  --apply        writes staging tables + updates matched trips (one transaction).
  --post-vouchers  additionally posts RECEIPT vouchers through TARA's HTTP API
                   (server/agents/tara.js). Never writes ledger_entries directly:
                   the ledger is append-only and TARA owns the guards.

Re-running the same PDF is safe. Every write is an UPSERT on a deterministic
digest and every money column is set to an ABSOLUTE value, never incremented -
so a second run converges rather than doubling.

USAGE
--------------------------------------------------------------------------------
  python iocl_reconcile.py BILL.pdf                     # dry run + report
  python iocl_reconcile.py BILL.pdf --date-tolerance 2  # loosen date matching
  python iocl_reconcile.py BILL.pdf --apply             # write to ERP
  python iocl_reconcile.py BILL.pdf --apply --post-vouchers --bank-ledger "..."
  python iocl_reconcile.py --from-json parsed.json --apply

Exit codes: 0 ok | 2 nothing to reconcile | 4 match rate below --min-match-rate
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

# The module itself, not its names: WINDOW_FROM/WINDOW_TO are mutable at runtime
# (see set_window) and a from-import would freeze them at their defaults.
import iocl_bill_parser as billspec  # noqa: E402
from iocl_bill_parser import (  # noqa: E402
    TOOL_VERSION, ZERO,
    BillLine, ParsedBill, add_window_args, expand_inputs, money, norm_vehicle,
    parse_bill, set_window, sha1_of, split_ship_to,
)

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "FATAL: psycopg (v3) is not installed.\n"
        "  python -m pip install -r tools/iocl_recon/requirements.txt\n"
    )
    raise SystemExit(1)


# ═════════════════════════════════════════════════════════════════════════════
# TDS rate table - keep in lockstep with server/lib/taxEngine.js RATE_TABLE
# ═════════════════════════════════════════════════════════════════════════════
TDS_194C = {
    "individual_pct": Decimal("1"),
    "other_pct": Decimal("2"),
    "no_pan_pct": Decimal("20"),
    "single_threshold": Decimal("30000"),
    "fy_threshold": Decimal("100000"),
}

DEFAULT_CUSTOMER = "INDIAN OIL CORPORATION LTD"

# The bank account IOCL freight settles into. Confirmed against the live ledger
# set (three SBI accounts exist; this is the one nominated for IOCL receipts).
# ledger_entries is append-only, so a wrong account here costs a reversing
# entry in the permanent audit trail - it is a config constant, not a guess.
DEFAULT_BANK_LEDGER_ID = "SBI (8490)"
DEFAULT_TDS_RECEIVABLE_LEDGER = "TDS Receivable 194C"


def paise(d: Decimal) -> int:
    return int((Decimal(d) * 100).quantize(Decimal("1")))


def rupees(p: int) -> Decimal:
    return (Decimal(p) / 100).quantize(Decimal("0.01"))


def compute_tds_194c(
    gross: Decimal,
    *,
    has_pan: bool = True,
    deductee_type: str = "FIRM",
    fy_aggregate: Decimal = ZERO,
    declaration_194c6: bool = False,
    override_pct: Optional[Decimal] = None,
) -> tuple[Decimal, Decimal, str]:
    """-> (pct, tds_amount, basis). Integer-paise math, no float drift."""
    if declaration_194c6:
        return ZERO, ZERO, "194C(6) declaration on file (<=10 carriages + PAN) - NO TDS"
    amt_p, agg_p = paise(gross), paise(fy_aggregate)
    if override_pct is not None:
        pct = Decimal(override_pct)
        return pct, rupees(round(amt_p * float(pct) / 100)), f"manual override {pct}%"
    if amt_p <= paise(TDS_194C["single_threshold"]) and agg_p + amt_p <= paise(TDS_194C["fy_threshold"]):
        return ZERO, ZERO, "below 194C thresholds (single <= Rs.30,000 and FY <= Rs.1,00,000)"
    if not has_pan:
        pct, basis = TDS_194C["no_pan_pct"], "NO PAN - 20%"
    elif deductee_type.upper() in ("INDIVIDUAL", "HUF"):
        pct, basis = TDS_194C["individual_pct"], "individual/HUF with PAN"
    else:
        pct, basis = TDS_194C["other_pct"], "firm/company with PAN"
    return pct, rupees(round(amt_p * float(pct) / 100)), basis


def allocate_largest_remainder(total: Decimal, weights: list[Decimal]) -> list[Decimal]:
    """Split `total` across `weights` so the parts sum EXACTLY to the total.

    Bill-level TDS split trip-wise. Naive per-trip rounding drifts by a few
    paise across 40 trips and the ledger stops tying out to IOCL's advice;
    largest-remainder makes the parts reconcile by construction.
    """
    total_p = paise(total)
    wsum = sum(weights)
    if total_p == 0 or wsum == 0:
        return [ZERO for _ in weights]
    exact = [Decimal(total_p) * w / wsum for w in weights]
    floors = [int(e) for e in exact]
    remainder = total_p - sum(floors)
    order = sorted(range(len(weights)), key=lambda i: exact[i] - floors[i], reverse=True)
    for i in order[:remainder]:
        floors[i] += 1
    return [rupees(p) for p in floors]


# ═════════════════════════════════════════════════════════════════════════════
# Normalisation
# ═════════════════════════════════════════════════════════════════════════════
# Suffixes that carry no discriminating power between IOCL retail outlets.
NOISE = re.compile(
    r"\b(SERVICE\s+STATION|FUEL\s+STATION|FUELLING\s+STATION|FILLING\s+STATION|"
    r"PETROLEUM|PETROL\s+PUMP|SERVO|KSK|RO|PVT|LTD|LIMITED|AGENCY|AGENCIES|"
    r"OIL\s+DEPOT|DEPOT|STATION)\b"
)


def norm_name(s: Optional[str]) -> str:
    """Uppercase, drop the leading ship-to code, squash punctuation/space."""
    s = (s or "").upper()
    s = re.sub(r"^\s*\d{4,8}\s*[-–—]?\s*", "", s)
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def core_name(s: Optional[str]) -> str:
    """norm_name minus generic outlet words - the discriminating stem."""
    c = re.sub(r"\s+", " ", NOISE.sub(" ", norm_name(s))).strip()
    return c or norm_name(s)


def erp_ship_code(*fields: Optional[str]) -> Optional[str]:
    """First 4-8 digit prefix among consignee_name / unloading_location."""
    for f in fields:
        if not f:
            continue
        m = re.match(r"^\s*(\d{4,8})\b", f)
        if m:
            return m.group(1)
    return None


def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    base = SequenceMatcher(None, a, b).ratio()
    ca, cb = core_name(a), core_name(b)
    if ca and cb:
        base = max(base, SequenceMatcher(None, ca, cb).ratio())
        # Token containment: 'DARAKONA' inside 'DARAKONA FUELLING' is a hit that
        # raw ratio under-scores when one side is much longer.
        ta, tb = set(ca.split()), set(cb.split())
        if ta and tb and (ta <= tb or tb <= ta):
            base = max(base, 0.94)
    return base


# ═════════════════════════════════════════════════════════════════════════════
# Grouping
# ═════════════════════════════════════════════════════════════════════════════
@dataclass
class ReconGroup:
    """One composite key = one candidate ERP trip."""

    group_uid: str
    bill_no: str
    bill_date: Optional[date]
    vehicle_no_raw: str
    vehicle_norm: str
    trip_date: date
    ship_to_code: Optional[str]
    ship_to_name: str
    reverse_charge: bool = False
    invoice_nos: list[str] = field(default_factory=list)
    lines: list[BillLine] = field(default_factory=list)

    gross_amt: Decimal = ZERO
    penalty_amt: Decimal = ZERO
    igst_amt: Decimal = ZERO
    cgst_amt: Decimal = ZERO
    sgst_amt: Decimal = ZERO

    tds_section: Optional[str] = None
    tds_pct: Decimal = ZERO
    tds_amt: Decimal = ZERO
    tds_basis: str = ""

    match_status: str = "UNMATCHED_NO_TRIP"
    match_method: Optional[str] = None
    confidence: float = 0.0
    date_delta_days: int = 0
    trip_id: Optional[str] = None
    trip_repr: Optional[str] = None
    trip_code: Optional[str] = None
    driver_id: Optional[str] = None
    driver_name: Optional[str] = None
    candidates: list[dict] = field(default_factory=list)
    notes: str = ""

    # Shortage recovery, filled in by post_driver_recoveries()
    recovery_posted: bool = False
    recovery_ref: Optional[str] = None

    @property
    def shortage_qty(self) -> Decimal:
        return sum((ln.shortage or ZERO for ln in self.lines), ZERO)

    @property
    def net_receivable(self) -> Decimal:
        return (self.gross_amt - self.penalty_amt - self.tds_amt).quantize(Decimal("0.01"))

    @property
    def gst_total(self) -> Decimal:
        return (self.igst_amt + self.cgst_amt + self.sgst_amt).quantize(Decimal("0.01"))


def build_groups(lines: list[BillLine]) -> list[ReconGroup]:
    buckets: dict[str, ReconGroup] = {}
    for ln in lines:
        code, name = split_ship_to(ln.ship_to_raw)
        uid = ln.group_uid
        g = buckets.get(uid)
        if g is None:
            g = ReconGroup(
                group_uid=uid,
                bill_no=ln.bill_no,
                bill_date=ln.bill_date,
                vehicle_no_raw=ln.vehicle_no_raw,
                vehicle_norm=ln.vehicle_norm,
                trip_date=ln.line_date,
                ship_to_code=code,
                ship_to_name=name,
                reverse_charge=ln.reverse_charge,
            )
            buckets[uid] = g
        g.lines.append(ln)
        if ln.invoice_no not in g.invoice_nos:
            g.invoice_nos.append(ln.invoice_no)
        g.gross_amt += ln.gross_amt
        g.penalty_amt += ln.penalty_amt
        g.igst_amt += ln.igst_amt
        g.cgst_amt += ln.cgst_amt
        g.sgst_amt += ln.sgst_amt
        g.reverse_charge = g.reverse_charge or ln.reverse_charge
    return sorted(buckets.values(), key=lambda g: (g.trip_date, g.vehicle_norm))


# ═════════════════════════════════════════════════════════════════════════════
# ERP access
# ═════════════════════════════════════════════════════════════════════════════
def load_dotenv(repo_root: Path) -> None:
    """Read the repo .env without adding a dependency. Existing env wins."""
    for name in (".env", ".env.local"):
        p = repo_root / name
        if not p.exists():
            continue
        for raw in p.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)


def connect(dsn: Optional[str] = None):
    if dsn:
        return psycopg.connect(dsn, row_factory=dict_row)
    if os.environ.get("DATABASE_URL"):
        return psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row)
    return psycopg.connect(
        host=os.environ.get("PGHOST", "127.0.0.1"),
        port=int(os.environ.get("PGPORT", "5432")),
        dbname=os.environ.get("PGDATABASE", "prasad_erp"),
        user=os.environ.get("PGUSER", "prasad_app"),
        password=os.environ.get("PGPASSWORD", ""),
        row_factory=dict_row,
    )


TRIP_BASE_COLUMNS = [
    "id::text AS id", "trip_code", "vehicle_no", "loading_date",
    "consignee_name", "unloading_location", "customer_name", "status",
    "freight_amount", "driver_id::text AS driver_id", "driver_name",
]
# Added by 009_iocl_recon.sql. Selected only if present, so a DRY RUN works
# against an un-migrated database - you can validate the matcher on real data
# before altering the schema.
TRIP_OPTIONAL_COLUMNS = ["payment_status", "received_amount"]


def missing_recon_schema(conn) -> list[str]:
    """Which pieces of 009_iocl_recon.sql are not in this database yet."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name FROM information_schema.columns
             WHERE table_name = 'trips' AND column_name = ANY(%s)
        """, [TRIP_OPTIONAL_COLUMNS + ["billed_amount", "tds_amount", "reconciled_at"]])
        have_cols = {r["column_name"] for r in cur.fetchall()}
        cur.execute("""
            SELECT table_name FROM information_schema.tables
             WHERE table_name = ANY(%s)
        """, [["iocl_bill_runs", "iocl_bill_lines", "iocl_recon_matches"]])
        have_tables = {r["table_name"] for r in cur.fetchall()}
    missing = [c for c in TRIP_OPTIONAL_COLUMNS + ["billed_amount", "tds_amount", "reconciled_at"]
               if c not in have_cols]
    missing += [t for t in ("iocl_bill_runs", "iocl_bill_lines", "iocl_recon_matches")
                if t not in have_tables]
    return missing


def fetch_trips(conn, customer_filter: str) -> list[dict]:
    """The whole in-window trip set, once. ~850 rows - matching in Python beats
    850 round-trips, and lets the matcher rank candidates it can see together."""
    with conn.cursor() as cur:
        cur.execute("""
            SELECT column_name FROM information_schema.columns
             WHERE table_name = 'trips' AND column_name = ANY(%s)
        """, [TRIP_OPTIONAL_COLUMNS])
        present = {r["column_name"] for r in cur.fetchall()}
        # Interpolated, but only ever from the two hard-coded allowlists above -
        # never from user input.
        cols = TRIP_BASE_COLUMNS + [c for c in TRIP_OPTIONAL_COLUMNS if c in present]
        cur.execute(f"""
            SELECT {', '.join(cols)}
              FROM trips
             WHERE loading_date BETWEEN %(w_from)s AND %(w_to)s
               AND vehicle_no IS NOT NULL
               AND (%(customer)s = '' OR customer_name IS NULL
                    OR upper(customer_name) LIKE %(customer_like)s)
        """, {
            "w_from": billspec.WINDOW_FROM, "w_to": billspec.WINDOW_TO,
            "customer": customer_filter,
            "customer_like": f"%{customer_filter.upper()}%" if customer_filter else "%",
        })
        rows = cur.fetchall()
    for r in rows:
        for optional in TRIP_OPTIONAL_COLUMNS:
            r.setdefault(optional, None)
        r["vehicle_norm"] = norm_vehicle(r["vehicle_no"])
        r["ship_code"] = erp_ship_code(r["consignee_name"], r["unloading_location"])
        r["name_a"] = norm_name(r["consignee_name"])
        r["name_b"] = norm_name(r["unloading_location"])
        if isinstance(r["loading_date"], datetime):
            r["loading_date"] = r["loading_date"].date()
    return rows


def index_trips(trips: list[dict]) -> dict[tuple[str, date], list[dict]]:
    idx: dict[tuple[str, date], list[dict]] = defaultdict(list)
    for t in trips:
        if t["vehicle_norm"] and t["loading_date"]:
            idx[(t["vehicle_norm"], t["loading_date"])].append(t)
    return idx


# ═════════════════════════════════════════════════════════════════════════════
# THE MATCHER
# ═════════════════════════════════════════════════════════════════════════════
def score_candidate(g: ReconGroup, trip: dict, allow_blank_location: bool) -> tuple[float, str]:
    # 1. Ship-to code equality - the strongest signal on offer.
    if g.ship_to_code and trip["ship_code"] and g.ship_to_code == trip["ship_code"]:
        return 1.0, "CODE"
    # A code mismatch is a positive disagreement, not a missing signal.
    if g.ship_to_code and trip["ship_code"] and g.ship_to_code != trip["ship_code"]:
        return 0.0, "CODE_CONFLICT"
    # 2. Name similarity against either ERP location field.
    best = max(similarity(g.ship_to_name, trip["name_a"]),
               similarity(g.ship_to_name, trip["name_b"]))
    if best > 0:
        return best, "NAME"
    # 3. Trip carries no destination at all (32 such rows live). Only usable if
    #    it is the single candidate, and only when explicitly permitted.
    if allow_blank_location and not trip["name_a"] and not trip["name_b"]:
        return 0.50, "VEHICLE_DATE_ONLY"
    return 0.0, "NONE"


def match_groups(
    groups: list[ReconGroup],
    trips: list[dict],
    *,
    threshold: float,
    date_tolerance: int,
    allow_blank_location: bool,
    ambiguity_margin: float = 0.02,
) -> None:
    idx = index_trips(trips)

    # Pass 1 - rank every group's candidates independently.
    proposals: list[tuple[float, ReconGroup, dict, str, int]] = []
    for g in groups:
        offsets = [0] + [d for n in range(1, date_tolerance + 1) for d in (-n, n)]
        scored: list[tuple[float, dict, str, int]] = []
        seen_ids: set[str] = set()
        for off in offsets:
            probe = g.trip_date + timedelta(days=off)
            for t in idx.get((g.vehicle_norm, probe), []):
                if t["id"] in seen_ids:
                    continue
                seen_ids.add(t["id"])
                s, method = score_candidate(g, t, allow_blank_location)
                if s <= 0:
                    continue
                # An off-by-N date is real evidence of doubt; discount it so an
                # exact-date candidate always outranks a tolerant one.
                s_adj = s - (abs(off) * 0.03)
                scored.append((s_adj, t, method, off))

        scored.sort(key=lambda x: (-x[0], x[3]))
        g.candidates = [{
            "trip_id": t["id"], "trip_code": t["trip_code"], "vehicle_no": t["vehicle_no"],
            "loading_date": str(t["loading_date"]), "consignee_name": t["consignee_name"],
            "score": round(s, 4), "method": m, "date_delta": off,
        } for s, t, m, off in scored[:5]]

        # IOCL bills one truck-load per invoice number. If a composite group
        # ever gathers two invoices it has merged two loads into one, and the
        # money would land on a single trip. It does not happen on the bills
        # seen so far (50 invoices -> 50 groups, exactly 1:1) but the day it
        # does, it must be visible rather than silently absorbed.
        if len(g.invoice_nos) > 1:
            g.notes = (f"group spans {len(g.invoice_nos)} invoices "
                       f"({', '.join(g.invoice_nos)}) - verify this is one load")

        if not scored:
            # Distinguish "ERP knows nothing about this vehicle that day" from
            # "ERP has that vehicle out, but to a different destination" - a
            # different conversation with a different person.
            same_day = [t for o in offsets
                        for t in idx.get((g.vehicle_norm, g.trip_date + timedelta(days=o)), [])]
            g.match_status = "UNMATCHED_LOCATION" if same_day else "UNMATCHED_NO_TRIP"
            g.candidates = [{
                "trip_id": t["id"], "trip_code": t["trip_code"], "vehicle_no": t["vehicle_no"],
                "loading_date": str(t["loading_date"]), "consignee_name": t["consignee_name"],
                "score": 0.0, "method": "REJECTED", "date_delta": 0,
            } for t in same_day[:5]]
            if same_day:
                g.notes = ("ERP has this vehicle on this date going to: "
                           + "; ".join(str(t["consignee_name"]) for t in same_day[:3]))
            continue

        top_s, top_t, top_m, top_off = scored[0]
        if top_s < threshold:
            g.match_status = "UNMATCHED_LOCATION"
            g.confidence = round(top_s, 4)
            g.notes = f"best candidate scored {top_s:.3f} < threshold {threshold}"
            continue
        if len(scored) > 1 and (top_s - scored[1][0]) < ambiguity_margin:
            g.match_status = "AMBIGUOUS"
            g.confidence = round(top_s, 4)
            g.notes = (f"{len(scored)} candidates within {ambiguity_margin} "
                       f"({scored[0][1]['trip_code']} vs {scored[1][1]['trip_code']})")
            continue
        proposals.append((top_s, g, top_t, top_m, top_off))

    # Pass 2 - one trip, one group. Highest confidence wins; the runner-up is
    # recorded, not overwritten.
    proposals.sort(key=lambda x: (-x[0], x[1].trip_date))
    claimed: dict[str, ReconGroup] = {}
    for s, g, t, method, off in proposals:
        holder = claimed.get(t["id"])
        if holder is not None:
            g.match_status = "TRIP_ALREADY_CLAIMED"
            g.confidence = round(s, 4)
            g.notes = (f"trip {t['trip_code'] or t['id'][:8]} already matched by "
                       f"bill {holder.bill_no} inv {','.join(holder.invoice_nos)}")
            continue
        claimed[t["id"]] = g
        g.match_status = "MATCHED"
        g.match_method = method
        g.confidence = round(s, 4)
        g.date_delta_days = off
        g.trip_id = t["id"]
        g.trip_code = t["trip_code"]
        g.driver_id = t.get("driver_id")
        g.driver_name = t.get("driver_name")
        g.trip_repr = f"{t['trip_code'] or t['id'][:8]} {t['vehicle_no']} {t['loading_date']}"


# ═════════════════════════════════════════════════════════════════════════════
# TDS allocation (bill level -> trip level)
# ═════════════════════════════════════════════════════════════════════════════
def apply_tds(groups: list[ReconGroup], args) -> dict[str, dict]:
    """Compute per-bill 194C TDS, then split it across that bill's groups."""
    by_bill: dict[str, list[ReconGroup]] = defaultdict(list)
    for g in groups:
        by_bill[g.bill_no].append(g)

    summary: dict[str, dict] = {}
    for bill_no, gs in by_bill.items():
        bill_gross = sum((g.gross_amt for g in gs), ZERO)
        pct, tds_total, basis = compute_tds_194c(
            bill_gross,
            has_pan=not args.no_pan,
            deductee_type=args.deductee_type,
            fy_aggregate=money(args.fy_aggregate),
            declaration_194c6=args.tds_194c6,
            override_pct=Decimal(str(args.tds_pct)) if args.tds_pct is not None else None,
        )
        shares = allocate_largest_remainder(tds_total, [g.gross_amt for g in gs])
        for g, share in zip(gs, shares):
            g.tds_section = "194C"
            g.tds_pct = pct
            g.tds_amt = share
            g.tds_basis = basis
        summary[bill_no] = {
            "gross": bill_gross, "tds_pct": pct, "tds_total": tds_total,
            "basis": basis, "groups": len(gs),
        }
    return summary


# ═════════════════════════════════════════════════════════════════════════════
# THE UPDATER
# ═════════════════════════════════════════════════════════════════════════════
UPSERT_RUN = """
INSERT INTO iocl_bill_runs (pdf_path, pdf_name, pdf_sha256, tool_version, vendor_code,
       vendor_gstin, rc_office, bill_period_from, bill_period_to, window_from, window_to,
       pages, lines_parsed, lines_in_window, lines_out_window, checksum_ok, checksum_detail,
       parse_warnings)
VALUES (%(pdf_path)s, %(pdf_name)s, %(pdf_sha256)s, %(tool_version)s, %(vendor_code)s,
        %(vendor_gstin)s, %(rc_office)s, %(period_from)s, %(period_to)s, %(window_from)s,
        %(window_to)s, %(pages)s, %(lines_parsed)s, %(lines_in_window)s, %(lines_out_window)s,
        %(checksum_ok)s, %(checksum_detail)s, %(parse_warnings)s)
RETURNING run_id::text AS run_id
"""

UPSERT_LINE = """
INSERT INTO iocl_bill_lines (line_uid, run_id, group_uid, bill_no, bill_date, reverse_charge,
       s_no, invoice_no, item_code, line_date, vehicle_no_raw, vehicle_norm, ship_to_raw,
       ship_to_code, ship_to_name, material, quantity_kl, shortage, gross_amt, penalty_amt,
       igst_amt, cgst_amt, sgst_amt, page_no, source_line, rtd, rate)
VALUES (%(line_uid)s, %(run_id)s, %(group_uid)s, %(bill_no)s, %(bill_date)s, %(reverse_charge)s,
        %(s_no)s, %(invoice_no)s, %(item_code)s, %(line_date)s, %(vehicle_no_raw)s,
        %(vehicle_norm)s, %(ship_to_raw)s, %(ship_to_code)s, %(ship_to_name)s, %(material)s,
        %(quantity_kl)s, %(shortage)s, %(gross_amt)s, %(penalty_amt)s, %(igst_amt)s,
        %(cgst_amt)s, %(sgst_amt)s, %(page_no)s, %(source_line)s, %(rtd)s, %(rate)s)
ON CONFLICT (line_uid) DO UPDATE SET
  run_id = EXCLUDED.run_id, group_uid = EXCLUDED.group_uid, gross_amt = EXCLUDED.gross_amt,
  penalty_amt = EXCLUDED.penalty_amt, igst_amt = EXCLUDED.igst_amt,
  cgst_amt = EXCLUDED.cgst_amt, sgst_amt = EXCLUDED.sgst_amt,
  ship_to_raw = EXCLUDED.ship_to_raw, source_line = EXCLUDED.source_line,
  rtd = EXCLUDED.rtd, rate = EXCLUDED.rate
"""

UPSERT_MATCH = """
INSERT INTO iocl_recon_matches (group_uid, run_id, bill_no, bill_date, invoice_nos, line_count,
       vehicle_no_raw, vehicle_norm, trip_date, ship_to_code, ship_to_name, gross_amt,
       penalty_amt, igst_amt, cgst_amt, sgst_amt, tds_section, tds_pct, tds_amt,
       net_receivable, match_status, match_method, confidence, date_delta_days, trip_id,
       candidates, applied, applied_at, settlement_basis, notes)
VALUES (%(group_uid)s, %(run_id)s, %(bill_no)s, %(bill_date)s, %(invoice_nos)s, %(line_count)s,
        %(vehicle_no_raw)s, %(vehicle_norm)s, %(trip_date)s, %(ship_to_code)s, %(ship_to_name)s,
        %(gross_amt)s, %(penalty_amt)s, %(igst_amt)s, %(cgst_amt)s, %(sgst_amt)s,
        %(tds_section)s, %(tds_pct)s, %(tds_amt)s, %(net_receivable)s, %(match_status)s,
        %(match_method)s, %(confidence)s, %(date_delta_days)s, %(trip_id)s, %(candidates)s,
        %(applied)s, %(applied_at)s, %(settlement_basis)s, %(notes)s)
ON CONFLICT (group_uid) DO UPDATE SET
  run_id = EXCLUDED.run_id, gross_amt = EXCLUDED.gross_amt, penalty_amt = EXCLUDED.penalty_amt,
  igst_amt = EXCLUDED.igst_amt, cgst_amt = EXCLUDED.cgst_amt, sgst_amt = EXCLUDED.sgst_amt,
  tds_section = EXCLUDED.tds_section, tds_pct = EXCLUDED.tds_pct, tds_amt = EXCLUDED.tds_amt,
  net_receivable = EXCLUDED.net_receivable, match_status = EXCLUDED.match_status,
  match_method = EXCLUDED.match_method, confidence = EXCLUDED.confidence,
  date_delta_days = EXCLUDED.date_delta_days, trip_id = EXCLUDED.trip_id,
  candidates = EXCLUDED.candidates, applied = EXCLUDED.applied,
  applied_at = EXCLUDED.applied_at, settlement_basis = EXCLUDED.settlement_basis,
  notes = EXCLUDED.notes, line_count = EXCLUDED.line_count, invoice_nos = EXCLUDED.invoice_nos
"""

# Absolute assignment, never `col = col + x`: this is what makes a re-run
# converge instead of double-counting.
UPDATE_TRIP = """
UPDATE trips SET
  billed_amount      = %(gross)s,
  received_amount    = %(received)s,
  tds_amount         = %(tds)s,
  igst_amount        = %(igst)s,
  cgst_amount        = %(cgst)s,
  sgst_amount        = %(sgst)s,
  penalty_amount     = %(penalty)s,
  shortage_qty       = %(shortage_qty)s,
  shortage_penalty   = %(penalty)s,
  iocl_bill_no       = %(bill_no)s,
  iocl_invoice_no    = %(invoice_no)s,
  gst_reverse_charge = %(reverse_charge)s,
  payment_status     = %(payment_status)s,
  reconciled_at      = now(),
  status             = CASE WHEN %(mark_settled)s AND status = 'COMPLETED'
                            THEN 'SETTLED' ELSE status END
WHERE id = %(trip_id)s
"""


def write_to_erp(conn, bill: ParsedBill, groups: list[ReconGroup], args) -> dict:
    """Staging rows + trip updates, all inside one transaction."""
    stats = {"run_id": None, "lines": 0, "matches": 0, "trips_updated": 0}
    basis = args.settlement_basis

    with conn.cursor() as cur:
        cur.execute(UPSERT_RUN, {
            "pdf_path": bill.pdf_path, "pdf_name": bill.pdf_name, "pdf_sha256": bill.pdf_sha256,
            "tool_version": TOOL_VERSION, "vendor_code": bill.vendor_code,
            "vendor_gstin": bill.vendor_gstin, "rc_office": bill.rc_office,
            "period_from": bill.period_from, "period_to": bill.period_to,
            "window_from": billspec.WINDOW_FROM, "window_to": billspec.WINDOW_TO, "pages": bill.pages,
            "lines_parsed": len(bill.lines) + len(bill.out_of_window),
            "lines_in_window": len(bill.lines), "lines_out_window": len(bill.out_of_window),
            "checksum_ok": bill.checksum_ok,
            "checksum_detail": json.dumps(bill.checksums),
            "parse_warnings": json.dumps(bill.warnings),
        })
        run_id = cur.fetchone()["run_id"]
        stats["run_id"] = run_id

        for ln in bill.lines:
            code, name = split_ship_to(ln.ship_to_raw)
            cur.execute(UPSERT_LINE, {
                "line_uid": ln.line_uid, "run_id": run_id, "group_uid": ln.group_uid,
                "bill_no": ln.bill_no, "bill_date": ln.bill_date,
                "reverse_charge": ln.reverse_charge, "s_no": ln.s_no,
                "invoice_no": ln.invoice_no, "item_code": ln.item_code,
                "line_date": ln.line_date, "vehicle_no_raw": ln.vehicle_no_raw,
                "vehicle_norm": ln.vehicle_norm, "ship_to_raw": ln.ship_to_raw,
                "ship_to_code": code, "ship_to_name": name, "material": ln.material,
                "quantity_kl": ln.quantity_kl, "shortage": ln.shortage,
                "gross_amt": ln.gross_amt, "penalty_amt": ln.penalty_amt,
                "igst_amt": ln.igst_amt, "cgst_amt": ln.cgst_amt, "sgst_amt": ln.sgst_amt,
                "page_no": ln.page_no, "source_line": ln.source_line[:2000],
                "rtd": ln.rtd, "rate": ln.rate,
            })
            stats["lines"] += 1

        now = datetime.now()
        for g in groups:
            will_apply = g.match_status == "MATCHED" and g.trip_id is not None

            # Settle FIRST, write second: the open-item note below has to be in
            # g.notes before the match row is written, or the reason a receipt
            # was skipped never reaches the audit trail.
            #
            # A load can settle NEGATIVE: IOCL's shortage penalty sometimes
            # exceeds the freight it is charged against (ATF especially - one
            # 0.195 KL shortage carried a Rs.25,117.88 penalty against
            # Rs.9,550.29 of freight). Writing that straight through would put a
            # negative figure in 'received_amount' and mark the trip PAID, which
            # reads as "settled" when nothing arrived and money is in fact owed.
            #
            # Treatment: nothing received, status DISPUTED, and the shortfall is
            # left as an OPEN ITEM against IOCL to net off a later bill. The
            # penalty is still recorded on the trip and still recovered from the
            # driver.
            received, payment_status = ZERO, "BILLED"
            if will_apply and basis == "paid":
                if g.net_receivable < 0:
                    received, payment_status = ZERO, "DISPUTED"
                    g.notes = ((g.notes + " | ") if g.notes else "") + (
                        f"OPEN ITEM: penalty {g.penalty_amt} exceeds freight {g.gross_amt}; "
                        f"{abs(g.net_receivable)} owed to {args.party_ledger}, "
                        f"to be netted against a later bill. No receipt posted.")
                else:
                    received, payment_status = g.net_receivable, "PAID"

            cur.execute(UPSERT_MATCH, {
                "group_uid": g.group_uid, "run_id": run_id, "bill_no": g.bill_no,
                "bill_date": g.bill_date, "invoice_nos": g.invoice_nos,
                "line_count": len(g.lines), "vehicle_no_raw": g.vehicle_no_raw,
                "vehicle_norm": g.vehicle_norm, "trip_date": g.trip_date,
                "ship_to_code": g.ship_to_code, "ship_to_name": g.ship_to_name,
                "gross_amt": g.gross_amt, "penalty_amt": g.penalty_amt,
                "igst_amt": g.igst_amt, "cgst_amt": g.cgst_amt, "sgst_amt": g.sgst_amt,
                "tds_section": g.tds_section, "tds_pct": g.tds_pct, "tds_amt": g.tds_amt,
                "net_receivable": g.net_receivable, "match_status": g.match_status,
                "match_method": g.match_method, "confidence": g.confidence,
                "date_delta_days": g.date_delta_days, "trip_id": g.trip_id,
                "candidates": json.dumps(g.candidates), "applied": will_apply,
                "applied_at": now if will_apply else None,
                "settlement_basis": basis if will_apply else None, "notes": g.notes or None,
            })
            stats["matches"] += 1

            if not will_apply:
                continue
            cur.execute(UPDATE_TRIP, {
                "gross": g.gross_amt, "received": received, "tds": g.tds_amt,
                "igst": g.igst_amt, "cgst": g.cgst_amt, "sgst": g.sgst_amt,
                "penalty": g.penalty_amt, "shortage_qty": g.shortage_qty,
                "bill_no": g.bill_no,
                "invoice_no": ",".join(g.invoice_nos)[:200],
                "reverse_charge": g.reverse_charge, "payment_status": payment_status,
                "mark_settled": bool(args.mark_settled and basis == "paid"),
                "trip_id": g.trip_id,
            })
            stats["trips_updated"] += cur.rowcount
    return stats


# ═════════════════════════════════════════════════════════════════════════════
# DRIVER SHORTAGE RECOVERY
# ═════════════════════════════════════════════════════════════════════════════
# IOCL deducts a penalty when a load arrives short. The bill carries both the
# shortage quantity and the rupee penalty; the penalty is the amount actually
# withheld, so that is what gets recovered from the driver who ran the trip.
#
# The row goes to `driver_transactions` - this ERP's per-driver subsidiary
# ledger (293 rows already, txn_type ADVANCE_GIVEN / PAYMENT_GIVEN / ...). It is
# NOT posted into `ledger_entries`: that table is TARA's exclusive territory
# ("no other agent may write to a ledger table"), and the existing driver
# transactions are not GL-posted either, so writing one here would make this
# tool the sole inconsistent producer. See the note printed after posting.
#
# Idempotency rides on driver_transactions.legacy_id, which is UNIQUE: the key
# is derived from the group digest, so re-running converges instead of
# recovering the same shortage twice from the same driver.
RECOVERY_SQL = """
INSERT INTO driver_transactions (legacy_id, driver_id, driver_name, txn_date, txn_type,
                                 amount, mode, remarks)
VALUES (%(legacy_id)s, %(driver_id)s, %(driver_name)s, %(txn_date)s, 'SHORTAGE_RECOVERY',
        %(amount)s, 'Bill Deduction', %(remarks)s)
ON CONFLICT (legacy_id) DO UPDATE SET
  amount = EXCLUDED.amount, remarks = EXCLUDED.remarks, txn_date = EXCLUDED.txn_date,
  driver_id = EXCLUDED.driver_id, driver_name = EXCLUDED.driver_name
RETURNING id
"""


def post_driver_recoveries(conn, groups: list[ReconGroup], dry_run: bool = False) -> dict:
    """Recover each matched group's shortage penalty from that trip's driver."""
    out = {"posted": 0, "amount": ZERO, "skipped_no_driver": [], "rows": []}
    for g in groups:
        if g.match_status != "MATCHED" or g.penalty_amt <= 0:
            continue
        if not g.driver_name:
            # A penalty with nobody to recover from is a fact someone must see,
            # not a row to invent an owner for.
            out["skipped_no_driver"].append({
                "trip": g.trip_repr, "vehicle": g.vehicle_no_raw,
                "date": str(g.trip_date), "penalty": str(g.penalty_amt),
            })
            continue

        legacy_id = f"IOCL-SHORT-{g.group_uid[:24]}"
        remarks = (f"Trip: {g.trip_code or g.trip_repr} - IOCL shortage penalty, "
                   f"bill {g.bill_no} inv {','.join(g.invoice_nos)}, "
                   f"shortage {g.shortage_qty}")
        row = {
            "legacy_id": legacy_id, "driver_id": g.driver_id, "driver_name": g.driver_name,
            "txn_date": g.trip_date, "amount": g.penalty_amt, "remarks": remarks[:500],
        }
        if not dry_run:
            with conn.cursor() as cur:
                cur.execute(RECOVERY_SQL, row)
        g.recovery_posted = not dry_run
        g.recovery_ref = legacy_id
        out["posted"] += 1
        out["amount"] += g.penalty_amt
        out["rows"].append({
            "driver_name": g.driver_name, "driver_id": g.driver_id,
            "trip": g.trip_code or g.trip_repr, "vehicle": g.vehicle_no_raw,
            "date": str(g.trip_date), "shortage_qty": str(g.shortage_qty),
            "amount": str(g.penalty_amt), "ref": legacy_id,
        })
    return out


# ═════════════════════════════════════════════════════════════════════════════
# Voucher posting - through TARA, never straight into ledger_entries
# ═════════════════════════════════════════════════════════════════════════════
def post_vouchers(groups: list[ReconGroup], args) -> list[dict]:
    """One RECEIPT per bill, via POST /api/v1/finance/vouchers.

    ledger_entries is append-only and guarded by a deferred balance constraint;
    TARA (server/agents/tara.js) owns the duplicate-reference and overdraft
    checks. Bypassing it from Python would bypass those guards, so we do not.

    `amount` is the GROSS receivable (bill gross less IOCL's shortage penalty,
    which never becomes cash and is recovered from the driver instead). TARA
    infers the TDS side from the voucher type and posts three legs:

        Dr  SBI (8490)              net cash actually remitted
        Dr  TDS Receivable 194C     withheld from us, claimable
            Cr  IOCL                    full receivable, cleared

    ref_no is 'IOCL-<bill_no>', so TARA's duplicate-reference guard makes a
    replayed run a 409 rather than a second payment.
    """
    try:
        import requests
    except ImportError:
        sys.stderr.write("FATAL: --post-vouchers needs `requests` (pip install requests)\n")
        return []

    url = args.api_base.rstrip("/") + "/api/v1/finance/vouchers"
    by_bill: dict[str, list[ReconGroup]] = defaultdict(list)
    for g in groups:
        if g.match_status == "MATCHED":
            by_bill[g.bill_no].append(g)

    results = []
    for bill_no, gs in sorted(by_bill.items()):
        gross = sum((g.gross_amt for g in gs), ZERO)
        penalty = sum((g.penalty_amt for g in gs), ZERO)
        tds = sum((g.tds_amt for g in gs), ZERO)
        receivable = (gross - penalty).quantize(Decimal("0.01"))
        if receivable <= 0:
            # NOT silent. A bill whose penalties swallow its freight produces no
            # receipt - there is no such thing as receiving negative money - but
            # skipping it quietly is how a Rs.5,970 hole stays invisible until
            # someone reconciles by hand. It is an open item, and it is reported.
            results.append({
                "bill_no": bill_no, "skipped": "NEGATIVE_RECEIVABLE",
                "gross": str(gross), "penalty": str(penalty), "tds": str(tds),
                "net": str(receivable), "owed_to_party": str(-receivable),
                "trips": len(gs),
            })
            print(f"  voucher {bill_no}: SKIPPED - penalty {penalty:,} exceeds freight "
                  f"{gross:,}; {-receivable:,} OPEN ITEM owed to {args.party_ledger}")
            continue
        payload = {
            "type": "RECEIPT",
            "party_ledger": args.party_ledger,
            "party_group": "Sundry Debtors",
            "account": args.bank_ledger,
            "amount": float(receivable),
            "ref_no": f"IOCL-{bill_no}",
            "entry_date": str(max(g.bill_date or g.trip_date for g in gs)),
            "narration": (f"IOCL transportation bill {bill_no} - {len(gs)} trips, "
                          f"gross {gross}, penalty {penalty}, TDS 194C {tds}"),
            "created_by": "iocl_reconcile.py",
            "dry_run": bool(args.voucher_dry_run),
        }
        if tds > 0:
            payload["tds"] = {"ledger": args.tds_ledger, "amount": float(tds)}
        try:
            r = requests.post(url, json=payload, timeout=30)
            body = (r.json() if r.headers.get("content-type", "").startswith("application/json")
                    else {"raw": r.text[:400]})
            results.append({"bill_no": bill_no, "http": r.status_code,
                            "receivable": str(receivable), "tds": str(tds), "response": body})
            legs = body.get("lines")
            print(f"  voucher {bill_no}: HTTP {r.status_code} "
                  f"{body.get('voucher_id') or body.get('error') or ''}"
                  + (f"  ({len(legs)} legs)" if legs else ""))
        except Exception as exc:  # network / server down
            results.append({"bill_no": bill_no, "error": str(exc), "receivable": str(receivable)})
            print(f"  voucher {bill_no}: FAILED {exc}")
    return results


# ═════════════════════════════════════════════════════════════════════════════
# Reporting
# ═════════════════════════════════════════════════════════════════════════════
def print_recon_report(bill: ParsedBill, groups: list[ReconGroup], tds_summary: dict, args) -> dict:
    by_status: dict[str, list[ReconGroup]] = defaultdict(list)
    for g in groups:
        by_status[g.match_status].append(g)

    matched = by_status.get("MATCHED", [])
    total_gross = sum((g.gross_amt for g in groups), ZERO)
    matched_gross = sum((g.gross_amt for g in matched), ZERO)
    rate = (len(matched) / len(groups) * 100) if groups else 0.0

    print("\n" + "=" * 78)
    print(f" RECONCILIATION  {bill.pdf_name}")
    print(f" window {billspec.WINDOW_FROM} .. {billspec.WINDOW_TO} (inclusive)   basis: {args.settlement_basis.upper()}")
    print("=" * 78)
    print(f"  PDF line items (in window) : {len(bill.lines)}")
    print(f"  excluded (out of window)   : {len(bill.out_of_window)}")
    print(f"  composite groups           : {len(groups)}   <- vehicle + date + ship-to")
    print(f"  MATCHED                    : {len(matched)}  ({rate:.1f}%)")
    for st in ("AMBIGUOUS", "UNMATCHED_LOCATION", "UNMATCHED_NO_TRIP", "TRIP_ALREADY_CLAIMED"):
        if by_status.get(st):
            print(f"  {st:<27}: {len(by_status[st])}")

    print("\n  -- MONEY ---------------------------------------------------------")
    print(f"  gross (all groups)         : {total_gross:>14,}")
    print(f"  gross (matched only)       : {matched_gross:>14,}")
    print(f"  gross (unreconciled)       : {total_gross - matched_gross:>14,}")
    print(f"  IGST / CGST / SGST         : {sum((g.igst_amt for g in groups), ZERO):,} / "
          f"{sum((g.cgst_amt for g in groups), ZERO):,} / {sum((g.sgst_amt for g in groups), ZERO):,}")
    for bill_no, s in sorted(tds_summary.items()):
        print(f"  TDS 194C bill {bill_no:<20}: {s['tds_total']:>12,} @ {s['tds_pct']}%  ({s['basis']})")
    tds_all = sum((g.tds_amt for g in groups), ZERO)
    tds_matched = sum((g.tds_amt for g in matched), ZERO)
    print(f"  net receivable (matched)   : {sum((g.net_receivable for g in matched), ZERO):>14,}")
    if tds_all != tds_matched:
        # IOCL deducts TDS on the whole bill, but only matched groups can carry
        # it onto a trip. The difference is real money with nowhere to sit yet -
        # it must be visible or the 26AS reconciliation will not tie out.
        print(f"  TDS on UNRECONCILED groups : {tds_all - tds_matched:>14,}  "
              f"<- not posted to any trip; clear the exceptions to place it")

    if matched:
        print("\n  -- MATCHED (first 15) --------------------------------------------")
        print(f"  {'date':<11}{'vehicle':<14}{'ship-to':<30}{'gross':>11} {'tds':>9}  m")
        for g in matched[:15]:
            print(f"  {str(g.trip_date):<11}{g.vehicle_no_raw:<14}{g.ship_to_name[:29]:<30}"
                  f"{g.gross_amt:>11,} {g.tds_amt:>9,}  {g.match_method[:4]}")
        if len(matched) > 15:
            print(f"  ... {len(matched) - 15} more")

    exceptions = [g for g in groups if g.match_status != "MATCHED"]
    if exceptions:
        print("\n  -- EXCEPTIONS (need a human) -------------------------------------")
        for g in exceptions[:20]:
            print(f"  {g.match_status:<22}{str(g.trip_date):<11}{g.vehicle_no_raw:<14}"
                  f"{g.ship_to_name[:26]:<27}{g.gross_amt:>10,}")
            if g.notes:
                print(f"      {g.notes}")
            elif g.candidates:
                c = g.candidates[0]
                print(f"      nearest: {c['consignee_name']} ({c['score']}, {c['method']})")
        if len(exceptions) > 20:
            print(f"  ... {len(exceptions) - 20} more (see the report JSON / v_iocl_recon_exceptions)")

    return {
        "pdf": bill.pdf_name,
        "groups": len(groups),
        "matched": len(matched),
        "match_rate_pct": round(rate, 2),
        "gross_total": str(total_gross),
        "gross_matched": str(matched_gross),
        "gross_unreconciled": str(total_gross - matched_gross),
        "tds": {k: {kk: str(vv) for kk, vv in v.items()} for k, v in tds_summary.items()},
        "by_status": {k: len(v) for k, v in by_status.items()},
    }


def group_to_dict(g: ReconGroup) -> dict:
    return {
        "group_uid": g.group_uid, "bill_no": g.bill_no,
        "bill_date": g.bill_date.isoformat() if g.bill_date else None,
        "invoice_nos": g.invoice_nos, "line_count": len(g.lines),
        "vehicle_no_raw": g.vehicle_no_raw, "vehicle_norm": g.vehicle_norm,
        "trip_date": g.trip_date.isoformat(), "ship_to_code": g.ship_to_code,
        "ship_to_name": g.ship_to_name, "reverse_charge": g.reverse_charge,
        "gross_amt": str(g.gross_amt), "penalty_amt": str(g.penalty_amt),
        "igst_amt": str(g.igst_amt), "cgst_amt": str(g.cgst_amt), "sgst_amt": str(g.sgst_amt),
        "gst_total": str(g.gst_total), "tds_section": g.tds_section,
        "tds_pct": str(g.tds_pct), "tds_amt": str(g.tds_amt), "tds_basis": g.tds_basis,
        "net_receivable": str(g.net_receivable), "match_status": g.match_status,
        "match_method": g.match_method, "confidence": g.confidence,
        "date_delta_days": g.date_delta_days, "trip_id": g.trip_id, "trip": g.trip_repr,
        "trip_code": g.trip_code, "driver_id": g.driver_id, "driver_name": g.driver_name,
        "shortage_qty": str(g.shortage_qty), "recovery_posted": g.recovery_posted,
        "recovery_ref": g.recovery_ref,
        "candidates": g.candidates, "notes": g.notes,
    }


# ═════════════════════════════════════════════════════════════════════════════
def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Reconcile IOCL Transportation Bills against ERP trips "
                    "(window 01-04-2026 .. 21-08-2026) and update payment/TDS/GST.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("pdfs", nargs="*", help="PDF file(s), directory, or glob")
    ap.add_argument("--from-json", type=Path, help="use iocl_bill_parser.py JSON instead of re-parsing")

    g_match = ap.add_argument_group("matching")
    g_match.add_argument("--threshold", type=float, default=0.86,
                         help="minimum location similarity to accept a match (default 0.86)")
    g_match.add_argument("--date-tolerance", type=int, default=0,
                         help="allow loading_date to differ by +/-N days (default 0 = exact)")
    g_match.add_argument("--allow-blank-location", action="store_true",
                         help="permit matching a trip that has no consignee/unloading location")
    g_match.add_argument("--customer", default=DEFAULT_CUSTOMER,
                         help="restrict ERP trips to this customer ('' for all)")

    g_tax = ap.add_argument_group("tax")
    g_tax.add_argument("--deductee-type", default="FIRM", choices=("FIRM", "COMPANY", "INDIVIDUAL", "HUF"),
                       help="194C deductee class (default FIRM -> 2%%)")
    g_tax.add_argument("--no-pan", action="store_true", help="no PAN on file -> 20%%")
    g_tax.add_argument("--tds-194c6", action="store_true",
                       help="194C(6) small-transporter declaration filed -> 0%%")
    g_tax.add_argument("--tds-pct", type=float, default=None, help="manual TDS %% override")
    g_tax.add_argument("--fy-aggregate", default="0",
                       help="freight already received from this payer this FY (threshold test)")

    g_write = ap.add_argument_group("writing")
    g_write.add_argument("--apply", action="store_true",
                         help="WRITE: staging tables + trip payment/TDS/GST columns")
    g_write.add_argument("--settlement-basis", choices=("paid", "billed"), default="paid",
                         help="paid: received_amount = gross-penalty-TDS, status PAID (default). "
                              "billed: leave received_amount alone, status BILLED")
    g_write.add_argument("--mark-settled", action="store_true",
                         help="also move trips.status COMPLETED -> SETTLED (off by default: "
                              "TARA's trip_settlements owns that lifecycle)")
    g_write.add_argument("--post-vouchers", action="store_true",
                         help="post RECEIPT vouchers via the finance API (requires --apply)")
    g_write.add_argument("--voucher-dry-run", action="store_true",
                         help="let TARA validate + roll back each voucher instead of posting")
    g_write.add_argument("--api-base", default=os.environ.get("ERP_API_BASE", "http://127.0.0.1:3300"))
    g_write.add_argument("--bank-ledger", default=DEFAULT_BANK_LEDGER_ID,
                         help=f"bank ledger receiving the money (default {DEFAULT_BANK_LEDGER_ID!r})")
    g_write.add_argument("--party-ledger", default=DEFAULT_CUSTOMER)
    g_write.add_argument("--tds-ledger", default=DEFAULT_TDS_RECEIVABLE_LEDGER,
                         help="asset ledger for TDS withheld from us by the customer")
    g_write.add_argument("--recover-shortage", action="store_true",
                         help="post the IOCL shortage penalty as a SHORTAGE_RECOVERY on the "
                              "trip driver's ledger (requires --apply)")

    g_out = ap.add_argument_group("output / gates")
    g_out.add_argument("--report-dir", type=Path, default=Path("reports/iocl_recon"))
    g_out.add_argument("--min-match-rate", type=float, default=0.0,
                       help="exit 4 if the match rate falls below this percentage")
    g_out.add_argument("--strict-checksum", action="store_true",
                       help="refuse to --apply when a printed subtotal disagrees")
    g_out.add_argument("--dsn", help="explicit PostgreSQL DSN (overrides .env)")
    add_window_args(ap)
    return ap


def main(argv: Optional[list[str]] = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    args = build_argparser().parse_args(argv)
    set_window(args.window_from, args.window_to)
    repo_root = Path(__file__).resolve().parents[2]
    load_dotenv(repo_root)

    if not args.pdfs and not args.from_json:
        sys.stderr.write("FATAL: give at least one PDF, or --from-json\n")
        return 2
    if args.post_vouchers and not args.apply:
        sys.stderr.write("FATAL: --post-vouchers requires --apply\n")
        return 2
    if args.recover_shortage and not args.apply:
        sys.stderr.write("FATAL: --recover-shortage requires --apply\n")
        return 2

    # ── 1. EXTRACT ──────────────────────────────────────────────────────────
    bills: list[ParsedBill] = []
    if args.from_json:
        raw = json.loads(args.from_json.read_text(encoding="utf-8"))
        for entry in (raw if isinstance(raw, list) else [raw]):
            pb = ParsedBill(
                pdf_path=entry["pdf_path"], pdf_name=entry["pdf_name"],
                pdf_sha256=entry["pdf_sha256"], vendor_code=entry.get("vendor_code"),
                vendor_gstin=entry.get("vendor_gstin"), rc_office=entry.get("rc_office"),
                pages=entry.get("pages", 0), checksums=entry.get("checksums", []),
                warnings=entry.get("warnings", []),
            )
            for d in entry.get("lines", []):
                pb.lines.append(BillLine(
                    bill_no=d["bill_no"],
                    bill_date=date.fromisoformat(d["bill_date"]) if d.get("bill_date") else None,
                    reverse_charge=d.get("reverse_charge", False), s_no=d.get("s_no"),
                    invoice_no=d["invoice_no"], item_code=d.get("item_code"),
                    line_date=date.fromisoformat(d["line_date"]),
                    vehicle_no_raw=d["vehicle_no_raw"], ship_to_raw=d.get("ship_to_raw", ""),
                    material=d.get("material"),
                    quantity_kl=money(d["quantity_kl"]) if d.get("quantity_kl") else None,
                    shortage=money(d["shortage"]) if d.get("shortage") else None,
                    gross_amt=money(d["gross_amt"]), penalty_amt=money(d["penalty_amt"]),
                    igst_amt=money(d["igst_amt"]), cgst_amt=money(d["cgst_amt"]),
                    sgst_amt=money(d["sgst_amt"]), page_no=d.get("page_no", 0),
                    source_line=d.get("source_line", ""),
                ))
            bills.append(pb)
    else:
        paths = expand_inputs(args.pdfs)
        if not paths:
            sys.stderr.write("FATAL: no input PDFs resolved\n")
            return 2
        for p in paths:
            print(f"parsing {p.name} ...")
            bills.append(parse_bill(p))

    # ── 2. MATCH ────────────────────────────────────────────────────────────
    print("\nconnecting to ERP ...")
    conn = connect(args.dsn)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT current_database() AS db, current_user AS usr")
            who = cur.fetchone()
        print(f"  connected: {who['db']} as {who['usr']}")
        missing = missing_recon_schema(conn)
        if missing:
            print(f"  schema: 009_iocl_recon.sql NOT applied (missing: {', '.join(missing[:4])}"
                  f"{'...' if len(missing) > 4 else ''})")
            if args.apply:
                sys.stderr.write(
                    "\nFATAL: --apply needs migration 009_iocl_recon.sql.\n"
                    "  node server/db/migrate.js\n"
                    "  (or: psql -d prasad_erp -f server/db/migrations/009_iocl_recon.sql)\n")
                return 2
            print("  -> dry run continues; matching is validated read-only.")

        trips = fetch_trips(conn, args.customer)
        print(f"  ERP trips in window: {len(trips)}"
              f"  (customer filter: {args.customer or 'none'})")
        conn.rollback()  # the read needs no transaction held open

        all_reports, exit_code = [], 0
        for bill in bills:
            if not bill.lines:
                print(f"\n{bill.pdf_name}: no in-window line items - skipped")
                continue

            groups = build_groups(bill.lines)
            match_groups(
                groups, trips,
                threshold=args.threshold,
                date_tolerance=args.date_tolerance,
                allow_blank_location=args.allow_blank_location,
            )
            tds_summary = apply_tds(groups, args)
            report = print_recon_report(bill, groups, tds_summary, args)

            # A matched trip is spent: it must not be claimed by the next bill.
            claimed_ids = {g.trip_id for g in groups if g.trip_id}
            trips = [t for t in trips if t["id"] not in claimed_ids]

            # ── 3. UPDATE ───────────────────────────────────────────────────
            if args.apply:
                if args.strict_checksum and bill.checksum_ok is False:
                    print("  REFUSING TO APPLY: subtotal checksum failed (--strict-checksum)")
                    report["applied"] = False
                else:
                    stats = write_to_erp(conn, bill, groups, args)
                    conn.commit()
                    print(f"\n  APPLIED  run {stats['run_id']}: {stats['lines']} lines, "
                          f"{stats['matches']} groups, {stats['trips_updated']} trips updated")
                    report["applied"] = True
                    report["run_id"] = stats["run_id"]
                    report["trips_updated"] = stats["trips_updated"]

                    if args.recover_shortage:
                        rec = post_driver_recoveries(conn, groups)
                        conn.commit()
                        report["driver_recovery"] = rec
                        if rec["posted"]:
                            print(f"\n  DRIVER RECOVERY: {rec['posted']} posted, "
                                  f"total {rec['amount']:,}")
                            for r in rec["rows"]:
                                print(f"    {r['driver_name']:<26}{r['vehicle']:<12}{r['date']}"
                                      f"  short {r['shortage_qty']:>6}  Rs.{r['amount']:>10}")
                        for s in rec["skipped_no_driver"]:
                            print(f"    SKIPPED (no driver on trip): {s['trip']} "
                                  f"penalty {s['penalty']}")
                        if rec["posted"]:
                            print("    NOTE: written to driver_transactions (the per-driver "
                                  "subsidiary ledger). No GL leg - see README.")

                    if args.post_vouchers:
                        print("\n  posting vouchers via TARA ...")
                        report["vouchers"] = post_vouchers(groups, args)
            else:
                print("\n  DRY RUN - nothing written. Re-run with --apply to commit.")
                report["applied"] = False

            # Report artefacts
            args.report_dir.mkdir(parents=True, exist_ok=True)
            stem = Path(bill.pdf_name).stem
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            out = args.report_dir / f"{stem}_{stamp}.json"
            out.write_text(json.dumps({
                "summary": report,
                "parse": {
                    "checksum_ok": bill.checksum_ok, "checksums": bill.checksums,
                    "warnings": bill.warnings,
                    "excluded_out_of_window": [
                        {"date": l.line_date.isoformat(), "vehicle": l.vehicle_no_raw,
                         "invoice": l.invoice_no, "gross": str(l.gross_amt)}
                        for l in bill.out_of_window
                    ],
                },
                "groups": [group_to_dict(g) for g in groups],
            }, indent=2), encoding="utf-8")
            print(f"  report -> {out}")

            all_reports.append(report)
            if args.min_match_rate and report["match_rate_pct"] < args.min_match_rate:
                sys.stderr.write(
                    f"GATE FAILED: {bill.pdf_name} matched {report['match_rate_pct']}% "
                    f"< --min-match-rate {args.min_match_rate}\n")
                exit_code = 4

        if not all_reports:
            return 2
        return exit_code

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
