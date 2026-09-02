#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
iocl_ac5_loading.py - AC5 dispatch invoices from Gmail into the Loading Register.

    # dry run, both mailboxes, the mandated window
    python tools/iocl_recon/iocl_ac5_loading.py --window-from 2026-07-01 --window-to 2026-08-14

    # commit
    python tools/iocl_recon/iocl_ac5_loading.py --window-from 2026-07-01 --window-to 2026-08-14 --apply

    # parse what is already on disk, no Gmail
    python tools/iocl_recon/iocl_ac5_loading.py --no-fetch

TWO MAILBOXES, TWO LR SERIES
    gmail_token.json    Prasad Transport            -> operating_company M/S PRASAD TRANSPORT -> PT#####
    jaiswal_token.json  Jaiswal Enterprise          -> operating_company JAISWAL ENTERPRISE   -> JE#####
The server mints the trip_code from operating_company inside the insert
transaction, so two mailboxes can never collide on a number.

DEDUPLICATION IS THE POINT OF THIS SCRIPT
    Trip PT00667 already carries invoice 193680283 on AS 26C 9804. 594 of the
    872 trips already hold an IOCL invoice number, and 130 trips already exist
    inside the requested window. A naive import would double most of a month.

    Three gates, cheapest first:
      1. invoice number already on a trip           -> skip
      2. (invoice number, vehicle) already present  -> skip   [the rule asked for]
      3. same vehicle + same loading date + same qty, no invoice recorded
                                                    -> skip and REPORT, because
         that is almost certainly the same load entered by hand, and attaching
         the invoice to it is a human decision, not an insert.

    Gate 3 is the one that matters. Gates 1 and 2 only catch rows that already
    know their invoice number; the hand-entered loads do not, and those are
    exactly the ones a re-run would duplicate.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from iocl_ac5_parser import parse_ac5, Ac5Load  # noqa: E402
import iocl_bill_parser as billspec  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
AC5_DIR = REPO / "uploads" / "iocl_ac5"

# AC5s arrive under a plain "Invoice" subject. Deliberately NOT matching
# "Transportation Bill" or "Payment Advice" -- those are the settlement chain
# and have their own tools.
AC5_QUERY = (
    'has:attachment filename:pdf '
    '(from:b2bprd OR from:indianoil OR from:iocl) '
    'subject:"Invoice" '
    'after:{after} before:{before}'
)

MAILBOXES = [
    {"token": "gmail_token.json",   "company": "M/S PRASAD TRANSPORT", "label": "Prasad Transport",
     "address": "prasadtransport699@gmail.com"},
# The company string is a GROUPING KEY for billing. It was "JAISWAL
# ENTERPRISE" here while every pre-existing trip said "M/S JAISWAL
# ENTERPRISE  " (with trailing spaces), so one company existed as two
# strings and would have been billed on two separate invoices.
    {"token": "jaiswal_token.json", "company": "M/S JAISWAL ENTERPRISE", "label": "Jaiswal Enterprise",
     "address": "jaiswalenterprise2016@gmail.com"},
]


def api_base() -> str:
    for line in (REPO / ".env").read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("API_PORT="):
            return f"http://127.0.0.1:{line.split('=', 1)[1].strip()}"
    return "http://127.0.0.1:3300"


def api_headers() -> dict:
    """The importer is a machine, not a person: it identifies with the shared
    service secret (see the note at the insert stage)."""
    service_token = os.environ.get("ERP_SERVICE_TOKEN", "")
    headers = {"Content-Type": "application/json"}
    if service_token:
        headers["Authorization"] = f"Bearer {service_token}"
        headers["X-Service-Name"] = "iocl-ac5-importer"
    return headers


def post_trip(body: dict) -> dict:
    """POST /api/v1/ops/trips. Raises with the API's own detail on a 4xx/5xx,
    because 'HTTP Error 400' alone has cost a day of guessing before."""
    import urllib.error
    import urllib.request
    req = urllib.request.Request(f"{api_base()}/api/v1/ops/trips", method="POST",
                                 data=json.dumps(body).encode(), headers=api_headers())
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read()[:200].decode("utf-8", "ignore")
        raise RuntimeError(f"HTTP {e.code}: {detail}") from None


def fetch(window_from: date, window_to: date, out_dir: Path, limit: Optional[int]) -> dict:
    """Pull AC5 PDFs from every configured mailbox. Missing token = skip, not fail."""
    from iocl_bill_automation import fetch_bills_from_gmail
    here = Path(__file__).resolve().parent
    creds = here / "gmail_credentials.json"
    q = AC5_QUERY.format(after=window_from.strftime("%Y/%m/%d"),
                         before=(window_to + timedelta(days=1)).strftime("%Y/%m/%d"))
    summary = {}
    for mb in MAILBOXES:
        token = here / mb["token"]
        if not token.exists():
            print(f"  {mb['label']:<20} {mb['address']:<32} no token ({mb['token']}) - skipped")
            summary[mb["label"]] = {"status": "no_token"}
            continue
        dest = out_dir / mb["label"].replace(" ", "_")
        dest.mkdir(parents=True, exist_ok=True)
        res = fetch_bills_from_gmail(dest, creds_path=creds, token_path=token, query=q, limit=limit)
        n = len(res.get("downloaded", []))
        print(f"  {mb['label']:<20} {mb['address']:<32} {res.get('status')}  "
              f"downloaded {n}, already had {res.get('skipped_existing', 0)}")
        # A mailbox that needs re-authorisation must be LOUD. It looks exactly like
        # a quiet "0 new invoices" day otherwise, and that is how 18-08 -> 20-08 went
        # missing without anyone noticing the register had stopped moving.
        if res.get("status") not in ("ok", None):
            print(f"  {'':<20} {'':<32} ^^ {res.get('reason', 'no detail')}")
        summary[mb["label"]] = {"status": res.get("status"), "downloaded": n,
                                "reason": res.get("reason"), "dir": str(dest)}
    return summary


def load_existing(conn) -> dict:
    """One read of everything needed to deduplicate, so the loop stays local."""
    cur = conn.cursor()
    cur.execute("""
        SELECT trip_code,
               iocl_invoice_no,
               replace(upper(coalesce(vehicle_no,'')), ' ', '') AS veh,
               loading_date::date                               AS ld,
               round(coalesce(loaded_qty,0)::numeric, 3)        AS qty
          FROM trips
    """)
    # connect() sets row_factory=dict_row, so a row is a DICT. Unpacking it as
    # a tuple yields the column NAMES, not the values -- which silently built an
    # index of five bogus keys instead of 872 trips, and reported "1 by invoice".
    # A dry run that says it will insert 51 rows while claiming the database
    # holds one is the shape of a mass-duplication bug; read the counts, not
    # just the verdicts.
    rows = cur.fetchall()
    by_invoice, by_inv_veh, by_shape = {}, {}, {}
    for r in rows:
        code = r["trip_code"]
        inv = r["iocl_invoice_no"]
        veh = r["veh"]
        ld = r["ld"]
        qty = r["qty"]
        if inv:
            by_invoice.setdefault(str(inv), code)
            by_inv_veh.setdefault((str(inv), veh), code)
        if veh and ld:
            # The shape index carries the trip's invoice too, because WHICH
            # trip a shape hits decides what the new invoice is (see classify).
            by_shape.setdefault((veh, ld, str(qty)), {"code": code, "inv": str(inv) if inv else None})
    cur.close()
    if len(rows) and not by_invoice:
        raise RuntimeError(
            f"read {len(rows)} trips but indexed 0 invoices -- refusing to run, "
            "the deduplication index is not being built and every row would insert")
    return {"by_invoice": by_invoice, "by_inv_veh": by_inv_veh, "by_shape": by_shape,
            "_rows": len(rows)}


def classify(load: Ac5Load, existing: dict) -> tuple[str, Optional[str]]:
    veh = (load.vehicle_no or "").replace(" ", "").upper()
    inv = str(load.doc_no or "")
    qty = str(round(load.qty_kl, 3)) if load.qty_kl is not None else None

    if inv and inv in existing["by_invoice"]:
        return "DUP_INVOICE", existing["by_invoice"][inv]
    if inv and (inv, veh) in existing["by_inv_veh"]:
        return "DUP_INVOICE_VEHICLE", existing["by_inv_veh"][(inv, veh)]
    if veh and load.loading_date and qty:
        hit = existing["by_shape"].get((veh, load.loading_date, qty))
        if hit:
            # Same truck, date and quantity as a trip already in the register.
            # WHICH trip decides what this invoice is:
            #
            #  - the trip carries a DIFFERENT invoice: IOCL issued two AC5s for
            #    one truck-day. On 29-Aug-2026 that was a second 40 KL run
            #    (shipment 120195452, three hours after 120130253); on 13-Aug
            #    two 20 KL deliveries under one shipment (119902136). Either
            #    way this is a billable document on no trip -- the AC5 is the
            #    unit of fortnightly billing -- so it is a NEW trip, and the
            #    sibling's code travels with it into the remarks. Holding these
            #    for a person hid a real 40 KL run for four days.
            #
            #  - the trip carries NO invoice: a person typed it, and whether
            #    this AC5 is that movement is still their call. HELD.
            if hit["inv"] and hit["inv"] != inv:
                return "NEW", hit["code"]
            return "DUP_SHAPE", hit["code"]
    return "NEW", None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--window-from", type=lambda s: datetime.strptime(s, "%Y-%m-%d").date(),
                    default=date(2026, 7, 1))
    ap.add_argument("--window-to", type=lambda s: datetime.strptime(s, "%Y-%m-%d").date(),
                    default=date(2026, 8, 14))
    ap.add_argument("--no-fetch", action="store_true", help="parse what is on disk")
    ap.add_argument("--apply", action="store_true", help="actually insert (default is a dry run)")
    ap.add_argument("--ac5-dir", type=Path, default=AC5_DIR)
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--ac4-days", type=int, default=2,
                    help="days of AC4 loading mail to sweep into iocl_ac4_loads (default 2: today and yesterday)")
    ap.add_argument("--json", type=Path, default=REPO / "reports" / "iocl_recon" / "ac5_loading.json")
    args = ap.parse_args(argv)

    print(f"AC5 -> Loading Register    window {args.window_from} .. {args.window_to}")
    print(f"mode: {'APPLY' if args.apply else 'DRY RUN - nothing will be inserted'}\n")

    # THE WINDOW MUST REACH billspec, NOT ONLY THE GMAIL QUERY. This script
    # formats its own dates into AC5_QUERY, so the search matched — but
    # fetch_bills_from_gmail re-checks every message's received date against
    # billspec.WINDOW_FROM..WINDOW_TO ("belt and braces"), and those were still
    # the module DEFAULTS, whose upper end is frozen at 21-08-2026. Every mail
    # received after that date was matched by the query and then silently
    # dropped by the belt: downloaded 0, mailboxes "ok", register frozen at
    # 21-08 for ten days while every health signal stayed green.
    billspec.set_window(args.window_from, args.window_to)

    args.ac5_dir.mkdir(parents=True, exist_ok=True)
    # THE RETURN VALUE USED TO BE THROWN AWAY, AND IT IS THE MOST IMPORTANT
    # THING THIS FUNCTION KNOWS. fetch() already detects a mailbox whose OAuth
    # token has expired -- it prints "reauth_required" and the invalid_grant
    # detail, loudly, for a person watching a terminal. Nobody watches a cron.
    # The summary never reached RESULT_JSON, so the scheduler recorded
    # event:"ok" with inserted:0 while BOTH mailboxes were dead, and the loading
    # register stood still from 21-08 to 28-08 with every health check green.
    mailboxes = {}
    if not args.no_fetch:
        print("=== fetch")
        mailboxes = fetch(args.window_from, args.window_to, args.ac5_dir, args.limit) or {}
        print()

    # ── AC4: THE DAILY LOADING CYCLE ─────────────────────────────────────────
    # IOCL mails two documents per delivery and the owner has ruled (2026-09-02)
    # that they are two different processes. The AC4 -- the consignee's tax
    # invoice, within the hour of the truck leaving the bay -- is DAILY LOADING
    # and goes into its own register, iocl_ac4_loads, one row per document.
    # It is never a trip and carries no freight. The AC5 handled below is the
    # fortnightly FREIGHT document and is the only thing that becomes a trip.
    # The two stages share this ten-minute tick and nothing else: an AC4
    # failure cannot cost the AC5 import, and the AC5 never looks at AC4 rows.
    ac4: dict = {}
    ac4_error = None
    ac4_counts = {"new": 0, "already": 0, "failed": 0}
    if not args.no_fetch:
        print("=== AC4 daily loading (mail -> iocl_ac4_loads)")
        try:
            from iocl_ac4_seen import seen_ac4
            ac4 = seen_ac4(MAILBOXES, args.window_to, days=args.ac4_days)
            for label, v in ac4.items():
                print(f"  {label:<20} {v.get('status')}  downloaded {v.get('downloaded', 0)}, "
                      f"last {args.ac4_days} days: {len(v.get('loads', []))} "
                      f"({sum(1 for l in v.get('loads', []) if l.get('ok'))} readable)")
        except Exception as exc:                          # noqa: BLE001
            ac4_error = str(exc)[:200]
            print(f"  AC4 sweep failed (AC5 import unaffected): {ac4_error}")
        print()

    pdfs = sorted(p for p in args.ac5_dir.rglob("*.pdf")) + \
           sorted(p for p in args.ac5_dir.rglob("*.PDF"))
    pdfs = sorted(set(pdfs))
    print(f"=== parse  ({len(pdfs)} pdf files on disk)")

    parsed, rejected = [], []
    for p in pdfs:
        try:
            load = parse_ac5(p)
        except Exception as exc:                      # noqa: BLE001
            rejected.append((p.name, f"parse error: {exc}"))
            continue
        if not load.ok:
            rejected.append((p.name, "; ".join(load.warnings) or "incomplete"))
            continue
        if not (args.window_from <= load.loading_date <= args.window_to):
            rejected.append((p.name, f"outside window ({load.loading_date})"))
            continue
        # Which mailbox this came from decides the operating company, and so the
        # LR series. fetch() files each mailbox into its own subdirectory.
        load._source_dir = str(p.parent)
        parsed.append(load)
    print(f"  usable AC5 loads: {len(parsed)}   rejected: {len(rejected)}")

    from iocl_reconcile import connect, load_dotenv  # noqa: E402
    load_dotenv(REPO)          # takes the repo ROOT and appends .env itself
    conn = connect()
    existing = load_existing(conn)
    print(f"  existing trips indexed: {len(existing['by_shape'])} by shape, "
          f"{len(existing['by_invoice'])} by invoice\n")

    # The AC4 loads go into their own table now that there is a connection.
    # ON CONFLICT DO NOTHING on the SAP number; the dry run writes nothing.
    if ac4 and not ac4_error:
        try:
            from iocl_ac4_seen import register_ac4
            ac4_loads = [l for v in ac4.values() for l in (v or {}).get("loads", [])]
            ac4_counts = register_ac4(conn, ac4_loads, MAILBOXES, apply=args.apply)
            print(f"=== AC4 loading register: {'' if args.apply else 'DRY RUN - '}"
                  f"new {ac4_counts['new']}, already {ac4_counts['already']}, failed {ac4_counts['failed']}")
            for l in ac4_loads:
                if l.get("ok") and l.get("action") in ("new", "dry", "failed"):
                    print(f"      {l.get('date')} {l.get('time') or '--:--'}  {str(l.get('vehicle_no')):<13} "
                          f"{str(l.get('qty_kl')):>8} KL  {(l.get('consignee') or '')[:30]:<30} {l.get('action')}"
                          f"{(' ' + l['error']) if l.get('error') else ''}")
            print()
        except Exception as exc:                          # noqa: BLE001
            ac4_error = str(exc)[:200]
            print(f"  AC4 register failed (AC5 import unaffected): {ac4_error}\n")

    print("=== deduplicate")
    buckets: dict[str, list] = {"NEW": [], "DUP_INVOICE": [], "DUP_INVOICE_VEHICLE": [], "DUP_SHAPE": []}
    for load in parsed:
        verdict, trip = classify(load, existing)
        buckets[verdict].append((load, trip))
        # A NEW row must also not collide with another NEW row from this same
        # run -- IOCL mails the same invoice more than once.
        if verdict == "NEW":
            inv = str(load.doc_no)
            veh = (load.vehicle_no or "").replace(" ", "").upper()
            existing["by_invoice"][inv] = "(this run)"
            existing["by_inv_veh"][(inv, veh)] = "(this run)"
            if load.qty_kl is not None:
                existing["by_shape"].setdefault(
                    (veh, load.loading_date, str(round(load.qty_kl, 3))), {"code": "(this run)", "inv": inv})

    for k in ("DUP_INVOICE", "DUP_INVOICE_VEHICLE", "DUP_SHAPE", "NEW"):
        print(f"  {k:<20} {len(buckets[k])}")
    second = [(l, t) for l, t in buckets["NEW"] if t]
    if second:
        print(f"  {'  of which 2nd inv':<20} {len(second)}  (another AC5 already sits on the same truck-day)")
        for load, t in second[:10]:
            print(f"      inv {load.doc_no}  {load.vehicle_no}  {load.loading_date} {load.loading_time or ''}  "
                  f"{load.qty_kl} KL  sibling {t}  shipment {load.shipment_no or '?'}")
    if buckets["DUP_SHAPE"]:
        print("\n  DUP_SHAPE - same truck, date and quantity as an existing trip that has")
        print("  no invoice number recorded. Not inserted. Attaching the invoice to these")
        print("  is a human call:")
        for load, trip in buckets["DUP_SHAPE"][:10]:
            print(f"      {trip}  {load.vehicle_no}  {load.loading_date}  {load.qty_kl} {load.unit or '?'}  inv {load.doc_no}")

    if rejected:
        print(f"\n  rejected files ({len(rejected)}):")
        for name, why in rejected[:10]:
            print(f"      {name}: {why}")

    print("\n=== insert")
    inserted_count = 0
    insert_failed: list[tuple[str, str]] = []
    if not buckets["NEW"]:
        print("  nothing new to insert.")
    elif not args.apply:
        print(f"  DRY RUN - {len(buckets['NEW'])} would be inserted:")
        for load, sibling in buckets["NEW"][:15]:
            print(f"      {load.vehicle_no}  {load.loading_date}  {load.qty_kl} {load.unit or '?'}  "
                  f"{load.product}  inv {load.doc_no}{f'  (2nd inv, see {sibling})' if sibling else ''}")
    else:
        import urllib.request
        base = api_base()

        # THE API IS CLOSED BY DEFAULT (server/lib/apiGuard.js). This importer is
        # not a person and holds no session, so it identifies as a machine with
        # the shared service secret — the same door the WhatsApp engine uses for
        # POST /crm/chats and the reconciler for POST /finance/vouchers.
        #
        # Sending nothing is what broke the register on 21-08: every insert came
        # back 401, the failures were counted into a local list that never left
        # this function, and the tick reported "ok, inserted 0" — the same shape
        # as a quiet day. Three days later the Gmail token expired too and took
        # the blame for both.
        #
        # ERP_SERVICE_TOKEN reaches here because ioclSyncRunner spawns this with
        # the API's own env; a hand-run without it fails loudly below rather than
        # silently filing nothing.
        service_token = os.environ.get("ERP_SERVICE_TOKEN", "")
        headers = {"Content-Type": "application/json"}
        if service_token:
            headers["Authorization"] = f"Bearer {service_token}"
            headers["X-Service-Name"] = "iocl-ac5-importer"
        else:
            print("  ⚠ ERP_SERVICE_TOKEN not set — inserts will 401 unless the API "
                  "is running with no service secret configured.")

        done, failed = 0, []
        for load, sibling in buckets["NEW"]:
            src = load_source(load)
            company = next((mb["company"] for mb in MAILBOXES
                            if mb["label"].replace(" ", "_") in src),
                           "M/S PRASAD TRANSPORT")
            body = {
                "operating_company": company,
                "vehicle_no": load.vehicle_no,
                "loading_date": load.loading_date.isoformat(),
                "loaded_qty": float(load.qty_kl),
                "product_type": load.product,
                "iocl_invoice_no": str(load.doc_no),
                # NAME FIRST, CODE IN BRACKETS — "Lumding Terminal (7T04)".
                #
                # This posted the bare code, and the name the parser had already
                # read off the same invoice was thrown away. The register then
                # held "7T04" as a loading point, which Google cannot geocode,
                # so Route Tracking opened on a map of the planet. It also broke
                # the shape the rest of the table uses: 357 typed rows read
                # "BONGAIGAON  RC  OFFICE  (7R01)" and the imported ones did not
                # match any of them.
                #
                # Falls back to the bare code when the invoice had no usable
                # name, because the code is still the thing the office says out
                # loud and losing it would be worse than an unfindable pin.
                "loading_point": (f"{load.loading_point} ({load.loading_point_code})"
                                  if load.loading_point and load.loading_point_code
                                  else (load.loading_point or load.loading_point_code)),
                "consignee_name": load.consignee_name,
                "status": "IN_TRANSIT",
            }
            if sibling:
                # Two AC5s on one truck-day. Say so on the row, with the paper
                # trail a person needs to check it: the other trip, IOCL's
                # shipment and delivery numbers, and the loading time.
                body["remarks"] = (
                    f"AC5 {load.doc_no}: 2nd invoice for {load.vehicle_no} on {load.loading_date}"
                    f" (see {sibling}); shipment {load.shipment_no or '?'},"
                    f" delivery {load.delivery_no or '?'}, loaded {load.loading_time or '?'}")[:500]
            try:
                created = post_trip(body)
                trip = created.get("trip") or created
                print(f"      {trip.get('trip_code')}  {load.vehicle_no}  {load.qty_kl} {load.unit or '?'}  "
                      f"inv {load.doc_no}{f'  (2nd inv, see {sibling})' if sibling else ''}")
                done += 1
            except Exception as exc:                  # noqa: BLE001
                failed.append((load.doc_no, str(exc)[:160]))
        print(f"  inserted {done}, failed {len(failed)}")
        inserted_count = done
        insert_failed = failed
        for inv, why in failed[:10]:
            print(f"      inv {inv}: {why}")

    conn.close()
    args.json.parent.mkdir(parents=True, exist_ok=True)
    args.json.write_text(json.dumps({
        "window": [args.window_from.isoformat(), args.window_to.isoformat()],
        "applied": bool(args.apply),
        "counts": {k: len(v) for k, v in buckets.items()},
        "rejected": [{"file": n, "why": w} for n, w in rejected],
        "new": [l.as_dict() for l, _ in buckets["NEW"]],
        "dup_shape": [{"trip": t, **l.as_dict()} for l, t in buckets["DUP_SHAPE"]],
    }, indent=1), encoding="utf-8")
    print(f"\nreport -> {args.json}")

    # One machine-readable line at the end, so the API parses a value instead of
    # scraping prose that was written for a person to read.
    # A mailbox is "healthy" only when it actually answered. no_token and
    # reauth_required both mean zero mail was read, and zero mail read is not
    # the same fact as zero new invoices -- telling them apart is the whole
    # point of carrying this out of fetch().
    unhealthy = {k: v for k, v in mailboxes.items()
                 if (v or {}).get("status") not in ("ok", None)}
    # AN INSERT THAT 401s IS NOT A QUIET DAY EITHER.
    #
    # `failed` used to live and die inside the insert branch: it was printed to
    # a stdout nobody reads and never reached this line, so a run where every
    # single insert was refused reported inserted:0 and the runner logged "ok".
    # That is the same mistake the mailbox statuses above were carried out to
    # fix, one stage further down the pipeline — zero rows written is not the
    # same fact as zero rows to write, and only the importer can tell them apart.
    print("RESULT_JSON " + json.dumps({
        "inserted": inserted_count,
        "insert_failed": len(insert_failed),
        "insert_errors": [{"invoice": str(i), "why": w} for i, w in insert_failed[:10]],
        "duplicates": len(buckets["DUP_INVOICE"]) + len(buckets["DUP_INVOICE_VEHICLE"]),
        "held_for_review": len(buckets["DUP_SHAPE"]),
        "parsed": len(parsed),
        "rejected": len(rejected),
        "applied": bool(args.apply),
        "window": [args.window_from.isoformat(), args.window_to.isoformat()],
        "mailboxes": mailboxes,
        "mailboxes_failed": sorted(unhealthy.keys()),
        "downloaded": sum(int((v or {}).get("downloaded") or 0) for v in mailboxes.values()),
        # Per mailbox: status + the last two days' AC4 loads (see above). Health
        # of the AC4 sweep is its own field; it must not colour the AC5 verdict.
        "ac4": ac4,
        "ac4_error": ac4_error,
        "ac4_new": ac4_counts["new"],
        "ac4_already": ac4_counts["already"],
        "ac4_failed": ac4_counts["failed"],
        "second_invoice": len([1 for _, t in buckets["NEW"] if t]),
    }))
    return 0


def load_source(load: Ac5Load) -> str:
    """Which mailbox folder a parsed load came from (set by the fetch stage)."""
    return getattr(load, "_source_dir", "")


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
