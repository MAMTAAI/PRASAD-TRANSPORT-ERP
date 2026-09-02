"""
AC4 delivery invoices -- the loading the register cannot see yet.

IOCL mails the transporter TWO documents for a road delivery, and they are not
the same document, not the same day, and not the same count:

    AC4  "AC4 Inv.- 7010447890 by IndianOil Corporation Ltd."
         IOCL's TAX INVOICE to the consignee (NTPC, a retail outlet, ...). It
         names our tank truck, the product, the KL, the loading time and the
         customer. It arrives WITHIN THE HOUR of the truck leaving the bay.
    AC5  "AC5 Invoice by IndianOil Corporation Ltd."
         The freight self-invoice on the transporter's contract. THIS is what
         iocl_ac5_loading.py turns into a trip. It can lag the AC4 by hours or
         days, and between 15-Aug and 2-Sep-2026 there were 77 AC4 mails and
         only 32 AC5 mails across both mailboxes.

So on 2-Sep-2026 the owner looked at "Today's Loading Activity", saw zero, and
knew a truck had loaded that morning -- because the AC4 was sitting in the
inbox. The panel was right about AC5s and wrong about the day.

THE OWNER'S RULE (2026-09-02, afternoon): the two documents are two different
processes and are never merged. The AC4 is DAILY LOADING -- it goes into its
own register, iocl_ac4_loads (migration 125), one row per document keyed on
the SAP entry number, and it feeds "Today's Loading Activity". It is never a
trip and carries no freight. The AC5 is FORTNIGHTLY FREIGHT -- it alone
becomes a trips row, in iocl_ac5_loading.py, and it never looks in here.

Read-only against Gmail, downloads into uploads/iocl_ac4/<mailbox>/ (gitignored
with the rest of uploads/), parses only the last few days' files, and returns a
list the sync runner carries to the dashboard.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pdfplumber  # noqa: E402

import iocl_bill_parser as billspec  # noqa: E402
from iocl_ac5_parser import _date, _dec, norm_vehicle  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
AC4_DIR = REPO / "uploads" / "iocl_ac4"

# Same sender as the AC5s, different subject. The bare word "Invoice" in the
# AC5 query does NOT match "AC4 Inv.-", which is why the register never saw
# these -- not a bug in that query, it was written for the freight invoice.
AC4_QUERY = (
    'has:attachment filename:pdf '
    'from:b2bprd '
    'subject:"AC4 Inv" '
    'after:{after} before:{before}'
)

# How many days of AC4 mail to carry to the panel. Two: today, and yesterday
# for the evening loads whose AC5 has not come by the next morning.
AC4_DAYS = 2


def parse_ac4(path: Path) -> dict:
    """The few fields a person needs to recognise the loading. Page 1 only."""
    out: dict = {"pdf_name": path.name, "ok": False, "warnings": []}
    try:
        with pdfplumber.open(path) as pdf:
            text = (pdf.pages[0].extract_text() or "") if pdf.pages else ""
    except Exception as exc:                                  # noqa: BLE001
        out["warnings"].append(f"unreadable: {exc}")
        return out

    if not re.search(r"Form\s*No\s*AC4", text, re.I):
        out["warnings"].append("not an AC4 tax invoice")
        return out

    if m := re.search(r"SAP\s*Entry\s*no\.?\s*(\d{8,12})\s+Date\s+(\S+)", text, re.I):
        out["sap_no"] = m.group(1)
        d = _date(m.group(2))
        out["date"] = d.isoformat() if d else None
    if m := re.search(r"T\.?T\.?\s*No\.?\s*([A-Z0-9]{6,12})\s+Time\s+(\d{1,2}:\d{2})", text, re.I):
        out["vehicle_raw"] = m.group(1)
        out["vehicle_no"] = norm_vehicle(m.group(1)) or m.group(1)
        out["time"] = m.group(2)
    # "PRASAD TRANSPORT Den@15 830.90 ..." -- the contractor line. Which firm
    # IOCL thinks carried it, from the document rather than from the mailbox.
    if m := re.search(r"^([A-Z][A-Z &./]+?)\s+Den@15", text, re.M):
        out["transporter"] = m.group(1).strip()
    if m := re.search(r"Cont\s*Code\s*(\d{6,10})", text, re.I):
        out["contractor_code"] = m.group(1)
    if m := re.search(r"PAYER\s*-\s*(\d+)\s+(.+?)\s*$", text, re.I | re.M):
        out["consignee_code"] = m.group(1)
        out["consignee"] = m.group(2).strip()
    if m := re.search(r"Name\s*&\s*Address\s+(.+?)\s+RC\s+Office", text, re.I):
        out["loading_point"] = m.group(1).strip()
    # "Code 7R01 (CIN:...)" -- the supplying location's SAP plant code, the same
    # one the AC5 carries and the register keys its loading points on.
    if m := re.search(r"\bCode\s+([A-Z0-9]{4})\s*\(CIN", text):
        out["loading_point_code"] = m.group(1)

    # Item lines: "10 50700 HSD-BSVI 12.000 KL 2710 19 44*" -- one per product
    # compartment set. A retail-outlet AC4 routinely carries EBMS + HSD on the
    # same truck, so the quantity is a SUM and the product a list.
    items = []
    for m in re.finditer(r"^\d{2,3}\s+(\d{5})\s+(\S+)\s+([\d.]+)\s+KL\b", text, re.M):
        qty = _dec(m.group(3))
        if qty is not None:
            items.append({"material": m.group(1), "product": m.group(2), "kl": str(qty)})
    out["items"] = items
    out["qty_kl"] = str(sum(_dec(i["kl"]) for i in items)) if items else None
    out["products"] = sorted({i["product"] for i in items})

    out["ok"] = bool(out.get("sap_no") and out.get("vehicle_no") and out.get("date") and items)
    if not out["ok"]:
        missing = [k for k in ("sap_no", "vehicle_no", "date") if not out.get(k)]
        if not items:
            missing.append("items")
        out["warnings"].append("incomplete: " + ", ".join(missing))
    return out


def product_type_for(products: list[str]) -> str:
    """The register's own product vocabulary. 361 rows say "MS + HSD (Part
    Load)", 41 say "MS", 10 say "HSD (Diesel)" -- an AC4 must land in the
    same words or the product filters split one fleet into two. EBMS is
    ethanol-blended motor spirit, which the office has only ever called MS."""
    kinds: set[str] = set()
    for p in products or []:
        u = str(p).upper()
        if u.startswith("HSD"):
            kinds.add("HSD")
        elif u.startswith(("EBMS", "MS", "XP", "XTRA")):
            kinds.add("MS")
        else:
            kinds.add(str(p))
    if kinds == {"MS", "HSD"}:
        return "MS + HSD (Part Load)"
    if kinds == {"HSD"}:
        return "HSD (Diesel)"
    if kinds == {"MS"}:
        return "MS"
    return " + ".join(sorted(kinds)) or "Other"


def company_for(transporter: Optional[str], mailboxes: list[dict], fallback: str) -> str:
    """The firm IOCL printed on the document, resolved to the register's own
    company string. The document outranks the mailbox: a Jaiswal AC4 forwarded
    into the Prasad inbox is still a Jaiswal load."""
    t = (transporter or "").upper()
    for mb in mailboxes:
        key = mb["label"].split()[0].upper()          # PRASAD / JAISWAL
        if key and key in t:
            return mb["company"]
    if "GAUTAM" in t:
        return "M/S GAUTAM PRASAD"
    return fallback


def register_ac4(conn, loads: list[dict], mailboxes: list[dict], apply: bool) -> dict:
    """Write AC4 loads into iocl_ac4_loads -- the loading register, NOT trips.

    One row per document, ON CONFLICT (sap_no) DO NOTHING, so the ten-minute
    re-read of the same mail writes nothing twice. Each load is stamped with
    what became of it (`action`: new / already / failed / dry) so the caller
    can report per document rather than per run.
    """
    counts = {"new": 0, "already": 0, "failed": 0}
    todo = [l for l in loads if l.get("ok")]
    if not todo:
        return counts
    cur = conn.cursor()
    for l in todo:
        sap = str(l["sap_no"])
        mailbox_company = next((mb["company"] for mb in mailboxes if mb["label"] == l.get("mailbox")), None)
        company = company_for(l.get("transporter"), mailboxes, mailbox_company or "M/S PRASAD TRANSPORT")
        # "Bongaigaon RC Office (7R01)" -- the shape the register's 357 typed
        # rows use for the same place, so a filter on loading point finds both.
        lp = (f"{l['loading_point']} RC Office ({l['loading_point_code']})"
              if l.get("loading_point") and l.get("loading_point_code")
              else (l.get("loading_point") or l.get("loading_point_code")))
        row = (sap, l["date"], l.get("time"), l["vehicle_no"], l.get("transporter"),
               l.get("contractor_code"), company, lp, l.get("loading_point_code"),
               l.get("consignee_code"), l.get("consignee"),
               product_type_for(l.get("products", [])), json.dumps(l.get("items", [])),
               Decimal(l["qty_kl"]), l.get("mailbox"), l.get("pdf_name"), l.get("received"))
        l["company"] = company
        if not apply:
            l["action"] = "dry"
            counts["new"] += 1
            continue
        try:
            cur.execute(
                """INSERT INTO iocl_ac4_loads
                       (sap_no, loading_date, loading_time, vehicle_no, transporter,
                        contractor_code, operating_company, loading_point, loading_point_code,
                        consignee_code, consignee, products, items, qty_kl, mailbox,
                        pdf_name, received_on)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s)
                   ON CONFLICT (sap_no) DO NOTHING""", row)
            conn.commit()
            if cur.rowcount == 1:
                l["action"] = "new"
                counts["new"] += 1
            else:
                l["action"] = "already"
                counts["already"] += 1
        except Exception as exc:                              # noqa: BLE001
            conn.rollback()
            l["action"], l["error"] = "failed", str(exc)[:160]
            counts["failed"] += 1
    cur.close()
    return counts


def _received_day(name: str) -> Optional[date]:
    """fetch_bills_from_gmail prefixes every file with the mail's received date."""
    m = re.match(r"(\d{4}-\d{2}-\d{2})_", name)
    return date.fromisoformat(m.group(1)) if m else None


def seen_ac4(mailboxes: list[dict], upto: date, ac4_dir: Path = AC4_DIR,
             days: int = AC4_DAYS, limit: Optional[int] = None) -> dict:
    """Sweep the last `days` days of AC4 mail in every mailbox.

    Returns {label: {"status", "downloaded", "reason", "loads": [...]}}. Never
    raises for one mailbox's sake: a mailbox that cannot be read is reported
    with its status, exactly as the AC5 fetch does, and the others still run.
    """
    since = upto - timedelta(days=days - 1)
    q = AC4_QUERY.format(after=since.strftime("%Y/%m/%d"),
                         before=(upto + timedelta(days=1)).strftime("%Y/%m/%d"))
    # fetch_bills_from_gmail re-checks every mail against billspec.WINDOW_*,
    # whose module DEFAULT is hardcoded 21-08-2026 -- the cliff that froze the
    # AC5 register on 31-Aug. Set the window to this sweep and put the caller's
    # back afterwards (the AC5 run has set its own before calling here).
    prev_window = (billspec.WINDOW_FROM, billspec.WINDOW_TO)
    billspec.set_window(since, upto)
    try:
        return _sweep(mailboxes, q, since, ac4_dir, limit)
    finally:
        billspec.set_window(*prev_window)


def _sweep(mailboxes: list[dict], q: str, since: date, ac4_dir: Path, limit: Optional[int]) -> dict:
    from iocl_bill_automation import fetch_bills_from_gmail
    here = Path(__file__).resolve().parent
    creds = here / "gmail_credentials.json"
    summary: dict = {}
    for mb in mailboxes:
        label = mb["label"]
        token = here / mb["token"]
        entry: dict = {"status": None, "downloaded": 0, "reason": None, "loads": []}
        summary[label] = entry
        if not token.exists():
            entry["status"] = "no_token"
            continue
        dest = ac4_dir / label.replace(" ", "_")
        dest.mkdir(parents=True, exist_ok=True)
        try:
            res = fetch_bills_from_gmail(dest, creds_path=creds, token_path=token, query=q, limit=limit)
        except Exception as exc:                              # noqa: BLE001
            entry["status"] = "error"
            entry["reason"] = str(exc)[:200]
            continue
        entry["status"] = res.get("status")
        entry["downloaded"] = len(res.get("downloaded", []))
        entry["reason"] = res.get("reason")
        if entry["status"] not in ("ok", None):
            continue
        # Parse only what is recent. The folder keeps every AC4 ever fetched
        # (useful later for reconciliation) but the panel wants two days, and
        # pdfplumber over a growing folder every ten minutes is how the AC5 tick
        # came to take two and a half minutes.
        for p in sorted(dest.glob("*.pdf")) + sorted(dest.glob("*.PDF")):
            rd = _received_day(p.name)
            if rd is None or rd < since:
                continue
            rec = parse_ac4(p)
            rec["mailbox"] = label
            rec["received"] = rd.isoformat()
            entry["loads"].append(rec)
        entry["loads"].sort(key=lambda r: (r.get("date") or "", r.get("time") or ""), reverse=True)
    return summary


def main(argv: list[str]) -> int:
    """Dry probe: parse AC4 PDFs given on the command line, or sweep the mailboxes."""
    import argparse
    import json
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdfs", nargs="*", type=Path, help="AC4 PDFs to parse (no Gmail)")
    ap.add_argument("--sweep", action="store_true", help="read the mailboxes for the last days")
    ap.add_argument("--upto", type=date.fromisoformat, default=date.today())
    ap.add_argument("--days", type=int, default=AC4_DAYS)
    ap.add_argument("--ac4-dir", type=Path, default=AC4_DIR)
    ap.add_argument("--apply", action="store_true",
                    help="with --sweep: write the loads into iocl_ac4_loads (default is a dry run)")
    args = ap.parse_args(argv)
    if args.sweep:
        from iocl_ac5_loading import MAILBOXES
        from iocl_reconcile import connect, load_dotenv
        res = seen_ac4(MAILBOXES, args.upto, args.ac4_dir, args.days)
        for label, v in res.items():
            print(f"  {label:<20} {v.get('status')}  downloaded {v.get('downloaded', 0)}, "
                  f"parsed {len(v.get('loads', []))} ({sum(1 for l in v.get('loads', []) if l.get('ok'))} readable)")
        loads = [l for v in res.values() for l in v.get("loads", [])]
        # Writes only to iocl_ac4_loads, never to trips, and ON CONFLICT DO
        # NOTHING -- so this is safe beside the cron's own run.
        load_dotenv(REPO)
        conn = connect()
        counts = register_ac4(conn, loads, MAILBOXES, apply=args.apply)
        conn.close()
        print(f"  {'' if args.apply else 'DRY RUN - '}register: new {counts['new']}, "
              f"already {counts['already']}, failed {counts['failed']}")
        for l in sorted((l for l in loads if l.get("ok")), key=lambda x: (x.get("date") or "", x.get("time") or "")):
            print(f"    {l.get('date')} {l.get('time') or '--:--'}  {l.get('vehicle_no'):<13} {l.get('qty_kl'):>8} KL  "
                  f"{(l.get('consignee') or '')[:32]:<32} {l.get('action')}{(' ' + l['error']) if l.get('error') else ''}")
        bad = [l for l in loads if not l.get("ok")]
        for l in bad:
            print(f"    !! {l.get('pdf_name')}: {'; '.join(l.get('warnings', []))}")
        print("RESULT_JSON " + json.dumps({"ac4_new": counts["new"], "ac4_already": counts["already"],
                                          "ac4_failed": counts["failed"], "unreadable": len(bad)}))
        return 0
    for p in args.pdfs:
        print(json.dumps(parse_ac4(p), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
