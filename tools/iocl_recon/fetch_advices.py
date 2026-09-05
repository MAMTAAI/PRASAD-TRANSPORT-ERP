#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fetch_advices.py - pull IOCL Payment Advices out of Gmail and parse them.

Step 1 of the settlement chain. The Transportation Bill says what was earned;
this says what was actually remitted and what IOCL kept back (fuel on the CCMS
card, toll paid on our behalf, TDS). Without these, the split between bank and
fuel account is guesswork — and roughly 30% of the freight rides on that split.

    python tools/iocl_recon/fetch_advices.py                      # fetch + parse
    python tools/iocl_recon/fetch_advices.py --no-fetch           # parse local only
    python tools/iocl_recon/fetch_advices.py --window-from 2026-04-01
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import iocl_bill_parser as billspec  # noqa: E402
from iocl_bill_parser import add_window_args, set_window  # noqa: E402
from iocl_bill_automation import fetch_bills_from_gmail, import_local_bills  # noqa: E402
from iocl_payment_parser import parse_advice, report  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
ADVICE_DIR = REPO / "uploads" / "iocl_advices"

# BOTH FIRMS GET PAID BY IOCL, EACH INTO ITS OWN MAILBOX AND BANK (owner,
# 5-Sep-2026: "Jaiswal aur Prasad dono ka email theek se check karo"). Until
# today this script opened only gmail_token.json, so every Jaiswal advice went
# unread and every Jaiswal receipt on file was assumed from the bill. The
# mailbox an advice arrives in names the firm whose books it settles; each
# mailbox files into its own folder so two advices can never be confused.
MAILBOXES = [
    {"key": "prasad",  "token": "gmail_token.json",   "company": "M/S PRASAD TRANSPORT",
     "dir": ADVICE_DIR},
    {"key": "jaiswal", "token": "jaiswal_token.json", "company": "M/S JAISWAL ENTERPRISE",
     "dir": REPO / "uploads" / "iocl_advices_jaiswal"},
]

# Payment advices come from the same sender as the bills but under their own
# subject. Kept separate from the bill query so a broad match cannot drag
# hundreds of AC5 invoices into the advice folder.
ADVICE_QUERY = (
    'has:attachment filename:pdf '
    '(from:b2bprd OR from:indianoil OR from:iocl) '
    '(subject:"Payment Advice" OR subject:"Remittance" OR subject:"payment advise") '
    'after:{after} before:{before}'
)


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="Fetch and parse IOCL payment advices.")
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--import-from", nargs="*", type=Path, default=None)
    ap.add_argument("--advice-dir", type=Path, default=ADVICE_DIR)
    ap.add_argument("--json", type=Path, default=REPO / "reports" / "iocl_recon" / "advices.json")
    ap.add_argument("--gmail-credentials", type=Path,
                    default=Path(__file__).resolve().parent / "gmail_credentials.json")
    ap.add_argument("--gmail-token", type=Path, default=None,
                    help="one explicit token (legacy single-mailbox mode); default reads --mailbox")
    ap.add_argument("--mailbox", choices=["all", "prasad", "jaiswal"], default="all",
                    help="which firm's mailbox(es) to read; 'all' is the daily job")
    add_window_args(ap)
    args = ap.parse_args(argv)
    set_window(args.window_from, args.window_to)

    from datetime import timedelta
    print("=" * 74)
    print(f" IOCL PAYMENT ADVICES   window {billspec.WINDOW_FROM} .. {billspec.WINDOW_TO}")
    print("=" * 74)

    # Which folders to read, and whose books each one settles.
    if args.gmail_token is not None:
        boxes = [{"key": "explicit", "token": args.gmail_token.name, "company": None,
                  "dir": args.advice_dir, "token_path": args.gmail_token}]
    else:
        boxes = [dict(b, token_path=Path(__file__).resolve().parent / b["token"])
                 for b in MAILBOXES if args.mailbox in ("all", b["key"])]
    tools_dir = Path(__file__).resolve().parent

    q = ADVICE_QUERY.format(
        after=billspec.WINDOW_FROM.strftime("%Y/%m/%d"),
        before=(billspec.WINDOW_TO + timedelta(days=1)).strftime("%Y/%m/%d"))
    mailbox_status = {}
    for box in boxes:
        box["dir"].mkdir(parents=True, exist_ok=True)
        if args.no_fetch:
            continue
        print(f"\n  [{box['key']}] {box['token']} -> {box['dir'].relative_to(REPO) if str(box['dir']).startswith(str(REPO)) else box['dir']}")
        res = fetch_bills_from_gmail(box["dir"], creds_path=args.gmail_credentials,
                                     token_path=box["token_path"], query=q)
        mailbox_status[box["key"]] = res.get("status")
        if res["status"] == "skipped":
            # A dead token must be LOUD — it is the single most common reason the
            # books stop moving (memory: gmail-token-expiry-breaks-loading-sync).
            print(f"  MAILBOX UNAVAILABLE ({box['key']}): {res['reason']}")
        else:
            print(f"  {res.get('messages_matched', 0)} mails · "
                  f"{len(res['downloaded'])} new · {res['skipped_existing']} already held")

    if args.import_from is not None:
        src = args.import_from or [Path.home() / "Downloads", Path.home() / "Desktop"]
        imp = import_local_bills(src, boxes[0]["dir"])
        print(f"  imported {len(imp['copied'])} into {boxes[0]['key']} from {', '.join(str(s) for s in src)}")

    advices, kept = [], []
    for box in boxes:
        pdfs = sorted(p for p in box["dir"].iterdir() if p.suffix.lower() == ".pdf")
        if not pdfs:
            print(f"\n  No advices in {box['dir']}.")
            continue
        print(f"\n  parsing {len(pdfs)} PDF(s) from {box['key']}…\n")
        for p in pdfs:
            a = parse_advice(p)
            # A Transportation Bill saved into this folder by mistake parses to zero
            # voucher lines; skip it rather than report a broken advice.
            if not a.lines:
                continue
            a.operating_company = box["company"]
            advices.append(a)
            kept.append(p.name)
    if not advices:
        print("\n  No advices parsed.")
        return 2
    if mailbox_status and all(v == "skipped" for v in mailbox_status.values()) and not args.no_fetch:
        print("\n  EVERY MAILBOX WAS UNAVAILABLE — re-authorise: "
              "python tools/iocl_recon/gmail_setup.py --token <name> --force")
        report(a)

    if not advices:
        print("  No parseable payment advices found.")
        return 2

    total_freight = sum(a.freight_gross for a in advices)
    total_remit = sum(a.remitted for a in advices)
    ties = sum(1 for a in advices if a.ties)
    agg: dict[str, object] = {}
    for a in advices:
        for k, v in a.by_kind().items():
            agg[k] = agg.get(k, 0) + v

    print("\n" + "=" * 74)
    print(" ALL ADVICES")
    print("=" * 74)
    print(f"  advices parsed        : {len(advices)}   ({ties} tie to their remittance)")
    print(f"  freight gross         : {total_freight:>16,}")
    for k, v in sorted(agg.items(), key=lambda kv: kv[1]):
        if k != "FREIGHT_BILL":
            print(f"  {k.replace('_',' ').lower():<22}: {v:>16,}")
    print(f"  remitted to bank      : {total_remit:>16,}")
    if total_freight:
        held = total_freight - total_remit
        print(f"  NOT banked            : {held:>16,}   ({held / total_freight * 100:.1f}% of freight)")

    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps([dict(a.to_dict(), operating_company=getattr(a, "operating_company", None))
                                     for a in advices], indent=2), encoding="utf-8")
    if mailbox_status:
        print("  mailboxes: " + ", ".join(f"{k}={v}" for k, v in mailbox_status.items()))
    print(f"\n  JSON -> {args.json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
