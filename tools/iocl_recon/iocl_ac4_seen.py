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
inbox. The panel was right about AC5s and wrong about the day. This module
makes the AC4 visible as EVIDENCE OF A LOADING, and deliberately nothing more:
it never inserts a trip. An AC4 carries no freight, may list two products on
one truck, and the ERP's row semantics for it are a decision for the office
(see the surface-don't-autofix rule). It is a worklist line, not a record.

Read-only against Gmail, downloads into uploads/iocl_ac4/<mailbox>/ (gitignored
with the rest of uploads/), parses only the last few days' files, and returns a
list the sync runner carries to the dashboard.
"""
from __future__ import annotations

import re
import sys
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pdfplumber  # noqa: E402

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
    from iocl_bill_automation import fetch_bills_from_gmail
    here = Path(__file__).resolve().parent
    creds = here / "gmail_credentials.json"
    since = upto - timedelta(days=days - 1)
    q = AC4_QUERY.format(after=since.strftime("%Y/%m/%d"),
                         before=(upto + timedelta(days=1)).strftime("%Y/%m/%d"))
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
    args = ap.parse_args(argv)
    if args.sweep:
        from iocl_ac5_loading import MAILBOXES
        print(json.dumps(seen_ac4(MAILBOXES, args.upto, args.ac4_dir, args.days), indent=1))
        return 0
    for p in args.pdfs:
        print(json.dumps(parse_ac4(p), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
