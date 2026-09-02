#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
iocl_bill_automation.py - PRASAD TRANSPORT · END-TO-END IOCL BILLING PIPELINE
================================================================================
One command, five stages:

    1. FETCH    pull IOCL Transportation Bill PDFs out of Gmail, restricted to
                the reconciliation window (default 01-04-2026 .. 21-08-2026;
                override with --window-from / --window-to), into a local folder
    2. PARSE    extract vehicle / invoice / date / location / gross / GST /
                shortage / penalty  (iocl_bill_parser.py)
    3. MATCH    reconcile against ERP trips on vehicle + date + ship-to
    4. POST     trip payment + TDS 194C + GST; RECEIPT voucher routed to
                DEFAULT_BANK_LEDGER_ID through TARA
    5. RECOVER  debit each shortage penalty to the trip driver's ledger

Run:
    python tools/iocl_recon/iocl_bill_automation.py                 # dry run
    python tools/iocl_recon/iocl_bill_automation.py --live          # commit
    python tools/iocl_recon/iocl_bill_automation.py --live --no-fetch

Nothing touches the database unless --live is passed. Every stage is idempotent:
re-running the same bills converges instead of double-posting (deterministic
digests as keys, absolute money assignment, and TARA's duplicate-reference guard
on the voucher).

--------------------------------------------------------------------------------
STAGE 1 NEEDS GOOGLE CREDENTIALS
--------------------------------------------------------------------------------
Gmail's API requires an OAuth client that only the account owner can create - it
cannot be provisioned from here. Without it the stage is SKIPPED, not failed,
and the pipeline runs on whatever PDFs are already in --bill-dir. That is the
normal mode when bills are saved by hand.

To enable it once:
    python -m pip install google-api-python-client google-auth-oauthlib
    # https://console.cloud.google.com -> enable Gmail API -> OAuth client ID
    # (Desktop app) -> download to tools/iocl_recon/gmail_credentials.json
First run opens a browser once and writes gmail_token.json beside it.
Scope is gmail.readonly - this pipeline can read and download, never send or
delete.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
from datetime import date, datetime, timedelta, UTC
from decimal import Decimal
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

# Module, not names — the window is mutable at runtime (see set_window).
import iocl_bill_parser as billspec  # noqa: E402
from iocl_bill_parser import (  # noqa: E402
    ZERO, add_window_args, expand_inputs, parse_bill, set_window,
)
from iocl_reconcile import (  # noqa: E402
    DEFAULT_BANK_LEDGER_ID, DEFAULT_CUSTOMER, DEFAULT_TDS_RECEIVABLE_LEDGER,
    apply_tds, build_groups, connect, fetch_trips, load_dotenv, match_groups,
    missing_recon_schema, post_driver_recoveries, post_vouchers, write_to_erp,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BILL_DIR = REPO_ROOT / "uploads" / "iocl_bills"
DEFAULT_REPORT_DIR = REPO_ROOT / "reports" / "iocl_recon"

# Gmail search: the sender IOCL's B2B portal posts from, plus the two subjects
# it uses. Dates are bounded by the mandated window (Gmail's before: is
# EXCLUSIVE, hence the +1 day).
GMAIL_QUERY = (
    'has:attachment filename:pdf '
    '(from:b2bprd OR from:indianoil OR from:iocl) '
    '(subject:"Transportation Bill" OR subject:"Payment Advice" OR subject:"Invoice") '
    'after:{after} before:{before}'
)
GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

# Filenames IOCL's B2B portal actually uses, for the "I saved the attachments by
# hand" path (--import-from). Three shapes seen in the live mailbox:
#   0011024699_7R01_16-30.06.2026.PDF   depot transportation bill
#   0193715742.pdf                      AC5 invoice (10-digit doc number)
#   PDF ATTCHMNT.pdf / *Transportation Bill*.pdf
IOCL_PDF_PATTERN = re.compile(
    r"(^00\d{8}_|^\d{10}\.pdf$|transport\w*\s*bill|attchmnt|payment\s*advice)",
    re.I,
)
# Gmail's "Download all attachments" button returns one ZIP per email - by far
# the fastest manual route (one click per billing period instead of one per
# depot). Unpack those too.
ZIP_PATTERN = re.compile(r"\.zip$", re.I)


def import_local_bills(src_dirs: list[Path], bill_dir: Path) -> dict:
    """Copy IOCL-looking PDFs from a download folder into the working dir.

    The bridge for when Gmail cannot be reached programmatically: the operator
    saves the attachments from the browser, this picks them up by filename.
    Copies rather than moves - the original stays where the user put it - and
    skips files already present with the same size.
    """
    import shutil
    import zipfile
    out = {"stage": "import", "copied": [], "skipped_existing": 0, "scanned": 0,
           "zips_opened": 0, "status": "ok"}
    bill_dir.mkdir(parents=True, exist_ok=True)

    def take(name: str, read_bytes, size: int) -> None:
        """Land one PDF in the bill dir, skipping an identical existing copy."""
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", Path(name).name)[:120]
        dest = bill_dir / safe
        if dest.exists() and dest.stat().st_size == size:
            out["skipped_existing"] += 1
            return
        dest.write_bytes(read_bytes())
        out["copied"].append(safe)
        log(f"    imported {safe}")

    for src in src_dirs:
        if not src.exists():
            out.setdefault("missing_dirs", []).append(str(src))
            continue
        for f in sorted(src.iterdir()):
            if not f.is_file():
                continue

            if ZIP_PATTERN.search(f.name):
                # Only open archives that actually contain IOCL bills, so a
                # random zip in Downloads is left alone.
                try:
                    with zipfile.ZipFile(f) as z:
                        members = [m for m in z.infolist()
                                   if not m.is_dir()
                                   and m.filename.lower().endswith(".pdf")
                                   and IOCL_PDF_PATTERN.search(Path(m.filename).name)]
                        if not members:
                            continue
                        out["zips_opened"] += 1
                        log(f"    opening {f.name} ({len(members)} bill PDFs)")
                        for m in members:
                            out["scanned"] += 1
                            take(m.filename, lambda m=m, z=z: z.read(m), m.file_size)
                except (zipfile.BadZipFile, OSError) as exc:
                    out.setdefault("zip_errors", []).append(f"{f.name}: {exc}")
                continue

            if f.suffix.lower() != ".pdf":
                continue
            out["scanned"] += 1
            if not IOCL_PDF_PATTERN.search(f.name):
                continue
            take(f.name, f.read_bytes, f.stat().st_size)
    return out


def dedupe_bills(bills: list) -> dict:
    """Collapse the same billed load appearing in more than one PDF.

    IOCL's mailbox produces duplicates two different ways, and both were live
    in the real data:

      1. The SAME attachment saved twice - once by hand into Downloads, once by
         the Gmail fetcher. Byte-identical, caught by pdf_sha256.

      2. A CONSOLIDATED RE-ISSUE. '7B03_01-30.06.2026' turned out to contain
         exactly the union of '7B03_01-15.06' and '7B03_16-30.06' - same bill
         numbers, same invoices, 10 + 9 = 19 lines. A different file, different
         name, identical money.

    Case 2 is the dangerous one: nothing about the filename reveals it. But
    line_uid is sha1(bill_no, invoice_no, item_code, date, vehicle, material),
    so a re-issued line hashes to exactly what the original hashed to. One key
    therefore handles both cases, and the check is on billed content rather
    than on how the file arrived.

    Money was never actually at risk - trip claiming, the unique index on
    iocl_recon_matches(trip_id) and TARA's duplicate-reference guard each block
    double-posting. What duplicates DO corrupt is the audit trail: the second
    copy's groups come back TRIP_ALREADY_CLAIMED and the UPSERT would overwrite
    a MATCHED row with trip_id NULL, leaving a trip marked paid whose match
    record denies it.
    """
    stats = {"pdfs_in": len(bills), "pdf_dupes": [], "line_dupes": 0, "bills_emptied": []}
    seen_sha: dict[str, str] = {}
    seen_line: dict[str, str] = {}
    kept = []

    for bill in bills:
        if bill.pdf_sha256 in seen_sha:
            stats["pdf_dupes"].append({"pdf": bill.pdf_name, "same_as": seen_sha[bill.pdf_sha256]})
            continue
        seen_sha[bill.pdf_sha256] = bill.pdf_name

        fresh = []
        for ln in bill.lines:
            uid = ln.line_uid
            if uid in seen_line:
                stats["line_dupes"] += 1
                continue
            seen_line[uid] = bill.pdf_name
            fresh.append(ln)

        if bill.lines and not fresh:
            stats["bills_emptied"].append(bill.pdf_name)
            continue
        bill.lines = fresh
        kept.append(bill)

    stats["pdfs_out"] = len(kept)
    return {"bills": kept, "stats": stats}


def log(msg: str = "") -> None:
    print(msg, flush=True)


def rule(title: str) -> None:
    log("\n" + "=" * 78)
    log(f" {title}")
    log("=" * 78)


# ═════════════════════════════════════════════════════════════════════════════
# STAGE 1 - FETCH
# ═════════════════════════════════════════════════════════════════════════════
def fetch_bills_from_gmail(bill_dir: Path, *, creds_path: Path, token_path: Path,
                           query: Optional[str] = None, limit: Optional[int] = None) -> dict:
    """Download IOCL bill PDFs from Gmail into `bill_dir`.

    Returns a status dict; never raises for a missing-credentials case, because
    "no OAuth client configured" is a setup state, not a pipeline failure.
    """
    out = {"stage": "fetch", "downloaded": [], "skipped_existing": 0, "status": "ok"}

    try:
        from google.auth.exceptions import RefreshError
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from google_auth_oauthlib.flow import InstalledAppFlow
        from googleapiclient.discovery import build
    except ImportError:
        out["status"] = "skipped"
        out["reason"] = ("google-api-python-client / google-auth-oauthlib not installed - "
                         "run: python -m pip install google-api-python-client google-auth-oauthlib")
        return out

    creds = None
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), GMAIL_SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            # A revoked -- or 7-day Testing-mode expired -- refresh token raises
            # RefreshError here. That is a SETUP state, not a pipeline failure, and
            # this function's contract is to report those, not raise them. It used
            # to raise, and the exception unwound past the per-mailbox loop in
            # iocl_ac5_loading.fetch(): on 18-08-2026 the Prasad token was revoked
            # and silently stopped JAISWAL ENTERPRISE importing as well, because
            # Prasad is simply first in MAILBOXES. One dead mailbox must never be
            # able to stop the others.
            try:
                creds.refresh(Request())
            except RefreshError as exc:
                out["status"] = "reauth_required"
                out["reason"] = (
                    f"{token_path.name}: {exc}. Re-authorise with: "
                    f"python tools/iocl_recon/gmail_setup.py --token {token_path.name}"
                )
                return out
        elif creds_path.exists():
            creds = InstalledAppFlow.from_client_secrets_file(
                str(creds_path), GMAIL_SCOPES).run_local_server(port=0)
        else:
            out["status"] = "skipped"
            out["reason"] = f"no OAuth client at {creds_path} (see this file's header)"
            return out
        token_path.write_text(creds.to_json(), encoding="utf-8")
        try:
            os.chmod(token_path, 0o600)   # the token is a live credential
        except OSError:
            pass

    q = query or GMAIL_QUERY.format(
        after=billspec.WINDOW_FROM.strftime("%Y/%m/%d"),
        # Gmail's before: is exclusive; +1 day keeps 21-08-2026 inclusive.
        before=(billspec.WINDOW_TO + timedelta(days=1)).strftime("%Y/%m/%d"),
    )
    out["query"] = q
    bill_dir.mkdir(parents=True, exist_ok=True)

    # Page through EVERYTHING by default. Gmail returns newest-first, so any cap
    # silently amputates the OLDEST bills - the exact failure that hid April and
    # May behind a 200-message limit while the log cheerfully reported "matched
    # 200 mails". If a limit is ever set and more remain, say so loudly: a
    # coverage bound that is not reported reads as complete coverage.
    service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    messages, page_token = [], None
    while True:
        want = 500 if limit is None else min(500, limit - len(messages))
        if want <= 0:
            break
        resp = service.users().messages().list(
            userId="me", q=q, pageToken=page_token, maxResults=want).execute()
        messages.extend(resp.get("messages", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    out["messages_matched"] = len(messages)
    out["truncated"] = bool(page_token)
    if page_token:
        out["warning"] = (f"TRUNCATED at limit={limit}: more mail matches than was "
                          f"fetched. Oldest bills are the ones dropped.")
        log(f"    !! {out['warning']}")

    # DO NOT RE-DOWNLOAD WHAT IS ALREADY HELD. Every saved file ends in
    # __<last 8 of the Gmail message id>, so a message whose attachments are
    # on disk can be recognised BEFORE the full-body round trip. Without this
    # a quiet ten-minute tick spent two minutes pulling 139 known messages
    # from Gmail (one second each) to be told, file by file, "already had".
    held_ids = set()
    try:
        for p in bill_dir.iterdir():
            if "__" in p.name and p.stat().st_size > 0:
                held_ids.add(p.name.rsplit("__", 1)[1].split(".", 1)[0])
    except OSError:
        pass

    for m in messages:
        if m["id"][-8:] in held_ids:
            out["skipped_existing"] += 1
            continue
        msg = service.users().messages().get(userId="me", id=m["id"], format="full").execute()
        # Gmail's internalDate is ms since epoch, UTC - the authoritative
        # received time, unlike the spoofable Date: header.
        received = datetime.fromtimestamp(int(msg["internalDate"]) / 1000, UTC).date()
        if not (billspec.WINDOW_FROM <= received <= billspec.WINDOW_TO):
            continue  # belt and braces; the query already bounds this

        for part in _walk_parts(msg.get("payload", {})):
            filename = part.get("filename") or ""
            if not filename.lower().endswith(".pdf"):
                continue
            body = part.get("body", {})
            data = body.get("data")
            if not data and body.get("attachmentId"):
                att = service.users().messages().attachments().get(
                    userId="me", messageId=m["id"], id=body["attachmentId"]).execute()
                data = att.get("data")
            if not data:
                continue

            # IOCL names EVERY payment advice attachment 'PDF ATTCHMNT.PDF'.
            # Keying the file on date + filename therefore collided whenever two
            # advices arrived the same day, and the second was silently dropped
            # as "already held" — 33 advice mails yielded only 24 files. The
            # Gmail message id makes the name unique per attachment, so nothing
            # is lost, while the date prefix keeps the folder readable.
            safe = re.sub(r"[^A-Za-z0-9._-]", "_", filename)[:100]
            stem, dot, ext = safe.rpartition(".")
            uniq = f"{stem or safe}__{m['id'][-8:]}{dot}{ext}"
            dest = bill_dir / f"{received.isoformat()}_{uniq}"
            if dest.exists() and dest.stat().st_size > 0:
                out["skipped_existing"] += 1
                continue
            dest.write_bytes(base64.urlsafe_b64decode(data))
            out["downloaded"].append(str(dest))
            log(f"    downloaded {dest.name}")

    return out


def _walk_parts(payload: dict):
    """Depth-first walk of a Gmail MIME tree; attachments nest arbitrarily."""
    stack = [payload]
    while stack:
        p = stack.pop()
        yield p
        stack.extend(p.get("parts", []) or [])


# ═════════════════════════════════════════════════════════════════════════════
# Argument surface shared with iocl_reconcile
# ═════════════════════════════════════════════════════════════════════════════
class PipelineArgs:
    """The knobs iocl_reconcile's helpers read off an args object."""

    def __init__(self, ns: argparse.Namespace):
        self.settlement_basis = ns.settlement_basis
        self.mark_settled = ns.mark_settled
        self.deductee_type = ns.deductee_type
        self.no_pan = ns.no_pan
        self.tds_194c6 = ns.tds_194c6
        self.tds_pct = ns.tds_pct
        self.fy_aggregate = ns.fy_aggregate
        self.customer = ns.customer
        self.api_base = ns.api_base
        self.bank_ledger = ns.bank_ledger
        self.party_ledger = ns.party_ledger
        self.tds_ledger = ns.tds_ledger
        self.voucher_dry_run = ns.voucher_dry_run


def build_argparser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="End-to-end IOCL bill automation for Prasad Transport "
                    f"({billspec.WINDOW_FROM} .. {billspec.WINDOW_TO}).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--live", action="store_true",
                    help="COMMIT: trip updates, vouchers, driver recovery. Without this "
                         "the whole run is read-only.")
    ap.add_argument("--bill-dir", type=Path, default=DEFAULT_BILL_DIR,
                    help="where fetched PDFs land and where parsing reads from")
    ap.add_argument("--extra-pdfs", nargs="*", default=[],
                    help="additional PDFs/dirs/globs to include")

    g_fetch = ap.add_argument_group("stage 1 - fetch")
    g_fetch.add_argument("--no-fetch", action="store_true", help="skip Gmail, use --bill-dir as-is")
    g_fetch.add_argument("--import-from", nargs="*", type=Path, default=None,
                         help="folder(s) of manually-saved attachments to pull IOCL PDFs from "
                              "(defaults to the user's Downloads folder when passed with no value)")
    g_fetch.add_argument("--gmail-query", help="override the Gmail search string")
    g_fetch.add_argument("--fetch-limit", type=int, default=None,
                         help="cap the number of mails fetched (default: no cap). "
                              "Gmail returns newest-first, so a cap drops the OLDEST bills; "
                              "truncation is reported, never silent.")
    g_fetch.add_argument("--gmail-credentials", type=Path,
                         default=Path(__file__).resolve().parent / "gmail_credentials.json")
    g_fetch.add_argument("--gmail-token", type=Path,
                         default=Path(__file__).resolve().parent / "gmail_token.json")

    g_match = ap.add_argument_group("stage 3 - match")
    g_match.add_argument("--threshold", type=float, default=0.86)
    g_match.add_argument("--date-tolerance", type=int, default=0)
    g_match.add_argument("--allow-blank-location", action="store_true")
    g_match.add_argument("--customer", default=DEFAULT_CUSTOMER)

    g_tax = ap.add_argument_group("stage 4 - tax + money")
    g_tax.add_argument("--deductee-type", default="FIRM",
                       choices=("FIRM", "COMPANY", "INDIVIDUAL", "HUF"))
    g_tax.add_argument("--no-pan", action="store_true")
    g_tax.add_argument("--tds-194c6", action="store_true")
    g_tax.add_argument("--tds-pct", type=float, default=None)
    g_tax.add_argument("--fy-aggregate", default="10000000",
                       help="freight already received from IOCL this FY. Default assumes the "
                            "Rs.1,00,000 194C FY threshold is already crossed, which it is by "
                            "any real month of operations.")
    g_tax.add_argument("--settlement-basis", choices=("paid", "billed"), default="paid")
    g_tax.add_argument("--mark-settled", action="store_true")
    g_tax.add_argument("--bank-ledger", default=DEFAULT_BANK_LEDGER_ID,
                       help="DEFAULT_BANK_LEDGER_ID - where IOCL money lands")
    g_tax.add_argument("--party-ledger", default=DEFAULT_CUSTOMER)
    g_tax.add_argument("--tds-ledger", default=DEFAULT_TDS_RECEIVABLE_LEDGER)
    g_tax.add_argument("--api-base", default=os.environ.get("ERP_API_BASE", "http://127.0.0.1:3300"))
    g_tax.add_argument("--no-vouchers", action="store_true",
                       help="apply trip/TDS/GST but do NOT post bank receipts")
    g_tax.add_argument("--voucher-dry-run", action="store_true",
                       help="let TARA validate each voucher then roll it back")

    g_rec = ap.add_argument_group("stage 5 - driver recovery")
    g_rec.add_argument("--no-recovery", action="store_true",
                       help="do not debit shortage penalties to driver ledgers")

    ap.add_argument("--report-dir", type=Path, default=DEFAULT_REPORT_DIR)
    ap.add_argument("--strict-checksum", action="store_true",
                    help="refuse to commit a bill whose printed subtotals disagree")
    ap.add_argument("--dsn")
    add_window_args(ap)
    return ap


# ═════════════════════════════════════════════════════════════════════════════
# Pipeline
# ═════════════════════════════════════════════════════════════════════════════
def main(argv: Optional[list[str]] = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ns = build_argparser().parse_args(argv)
    # Before anything reads the window: the Gmail query, the PDF filter and the
    # ERP trip query must all agree on the same dates.
    set_window(ns.window_from, ns.window_to)
    args = PipelineArgs(ns)
    load_dotenv(REPO_ROOT)
    started = datetime.now()

    summary = {
        "started_at": started.isoformat(timespec="seconds"),
        "mode": "LIVE" if ns.live else "DRY RUN",
        "window": [billspec.WINDOW_FROM.isoformat(), billspec.WINDOW_TO.isoformat()],
        "bank_ledger": ns.bank_ledger,
        "stages": {},
        "bills": [],
    }

    rule(f"PRASAD TRANSPORT · IOCL BILL AUTOMATION   [{summary['mode']}]")
    log(f" window {billspec.WINDOW_FROM} .. {billspec.WINDOW_TO} (inclusive)")
    log(f" bank   {ns.bank_ledger}      party {ns.party_ledger}")

    # ── STAGE 1 ─────────────────────────────────────────────────────────────
    rule("STAGE 1/5  FETCH")
    if ns.no_fetch:
        fetch = {"stage": "fetch", "status": "skipped", "reason": "--no-fetch"}
        log("  skipped (--no-fetch)")
    else:
        fetch = fetch_bills_from_gmail(
            ns.bill_dir, creds_path=ns.gmail_credentials,
            token_path=ns.gmail_token, query=ns.gmail_query, limit=ns.fetch_limit)
        if fetch["status"] == "skipped":
            log(f"  skipped: {fetch['reason']}")
        else:
            log(f"  matched {fetch.get('messages_matched', 0)} mails · "
                f"downloaded {len(fetch['downloaded'])} · "
                f"already had {fetch['skipped_existing']}")
    summary["stages"]["fetch"] = fetch

    # Manual bridge: attachments saved from the browser get picked up by name.
    if ns.import_from is not None:
        src_dirs = ns.import_from or [Path.home() / "Downloads", Path.home() / "Desktop"]
        imp = import_local_bills(src_dirs, ns.bill_dir)
        log(f"  imported {len(imp['copied'])} new PDF(s) from "
            f"{', '.join(str(d) for d in src_dirs)} "
            f"(scanned {imp['scanned']}, already had {imp['skipped_existing']})")
        summary["stages"]["import"] = imp

    inputs = []
    if ns.bill_dir.exists():
        inputs.append(str(ns.bill_dir))
    inputs.extend(ns.extra_pdfs)
    paths = expand_inputs(inputs)
    if not paths:
        log(f"\nNo PDFs to process. Put bills in {ns.bill_dir} or pass --extra-pdfs.")
        return 2
    log(f"  {len(paths)} PDF(s) queued")

    # ── STAGE 2 ─────────────────────────────────────────────────────────────
    rule("STAGE 2/5  PARSE")
    bills = []
    for p in paths:
        b = parse_bill(p)
        bills.append(b)
        ck = "PASS" if b.checksum_ok else ("FAIL" if b.checksum_ok is False else "n/a")
        log(f"  {p.name[:46]:<48}{len(b.lines):>4} lines  checksum {ck}")
        for w in b.warnings[:3]:
            log(f"      WARN {w}")
    parsed_lines = sum(len(b.lines) for b in bills)
    summary["stages"]["parse"] = {
        "pdfs": len(bills),
        "lines_in_window": parsed_lines,
        "lines_excluded": sum(len(b.out_of_window) for b in bills),
        "checksums_failed": [b.pdf_name for b in bills if b.checksum_ok is False],
    }

    # ── DEDUPE ──────────────────────────────────────────────────────────────
    dd = dedupe_bills(bills)
    bills, dstats = dd["bills"], dd["stats"]
    summary["stages"]["dedupe"] = dstats
    if dstats["pdf_dupes"] or dstats["line_dupes"]:
        log("")
        log(f"  DEDUPE: {len(dstats['pdf_dupes'])} identical PDF(s), "
            f"{dstats['line_dupes']} duplicate line item(s) removed")
        for d in dstats["pdf_dupes"][:8]:
            log(f"    {d['pdf'][:44]:<46} == {d['same_as'][:40]}")
        if len(dstats["pdf_dupes"]) > 8:
            log(f"    ... and {len(dstats['pdf_dupes']) - 8} more")
        for n in dstats["bills_emptied"][:8]:
            log(f"    {n[:44]:<46} fully superseded (re-issue)")
        log(f"    {parsed_lines} parsed -> {sum(len(b.lines) for b in bills)} unique line items")

    # ── STAGES 3-5 ──────────────────────────────────────────────────────────
    log("\nconnecting to ERP ...")
    conn = connect(ns.dsn)
    conn.autocommit = False
    totals = {k: ZERO for k in ("gross", "penalty", "gst", "tds", "net", "recovery")}
    counts = {"groups": 0, "matched": 0, "trips": 0, "vouchers": 0, "recoveries": 0}

    try:
        with conn.cursor() as cur:
            cur.execute("SELECT current_database() AS db, current_user AS usr")
            who = cur.fetchone()
        log(f"  connected: {who['db']} as {who['usr']}")

        missing = missing_recon_schema(conn)
        if missing and ns.live:
            sys.stderr.write("\nFATAL: --live needs migration 009_iocl_recon.sql.\n"
                             "  node server/db/migrate.js\n")
            return 2
        if missing:
            log(f"  schema: 009 not applied ({len(missing)} objects) - dry run continues")

        trips = fetch_trips(conn, ns.customer)
        conn.rollback()
        log(f"  ERP trips in window: {len(trips)}")

        rule("STAGE 3/5  MATCH   +   STAGE 4/5  POST   +   STAGE 5/5  RECOVER")
        for bill in bills:
            if not bill.lines:
                log(f"\n{bill.pdf_name}: no in-window lines - skipped")
                continue

            groups = build_groups(bill.lines)
            match_groups(groups, trips,
                         threshold=ns.threshold,
                         date_tolerance=ns.date_tolerance,
                         allow_blank_location=ns.allow_blank_location)
            apply_tds(groups, args)

            matched = [g for g in groups if g.match_status == "MATCHED"]
            counts["groups"] += len(groups)
            counts["matched"] += len(matched)
            for g in matched:
                totals["gross"] += g.gross_amt
                totals["penalty"] += g.penalty_amt
                totals["gst"] += g.gst_total
                totals["tds"] += g.tds_amt
                totals["net"] += g.net_receivable

            log(f"\n  {bill.pdf_name[:44]:<46}{len(groups):>3} grp  {len(matched):>3} matched  "
                f"gross {sum((g.gross_amt for g in matched), ZERO):>12,}")
            for g in groups:
                if g.match_status != "MATCHED":
                    log(f"      {g.match_status:<22}{g.trip_date} {g.vehicle_no_raw:<12}"
                        f"{g.ship_to_name[:24]:<26}{g.gross_amt:>10,}")

            bill_row = {
                "pdf": bill.pdf_name,
                "checksum_ok": bill.checksum_ok,
                "groups": len(groups),
                "matched": len(matched),
                "gross_matched": str(sum((g.gross_amt for g in matched), ZERO)),
                "gross_unmatched": str(sum((g.gross_amt for g in groups
                                            if g.match_status != "MATCHED"), ZERO)),
            }

            # A trip settled by this bill must not be offered to the next one.
            claimed = {g.trip_id for g in groups if g.trip_id}
            trips = [t for t in trips if t["id"] not in claimed]

            if ns.live:
                if ns.strict_checksum and bill.checksum_ok is False:
                    log("      REFUSED: checksum mismatch (--strict-checksum)")
                    bill_row["applied"] = False
                    summary["bills"].append(bill_row)
                    continue

                stats = write_to_erp(conn, bill, groups, args)
                conn.commit()
                counts["trips"] += stats["trips_updated"]
                bill_row.update(applied=True, run_id=stats["run_id"],
                                trips_updated=stats["trips_updated"])
                log(f"      APPLIED  {stats['trips_updated']} trips  (run {stats['run_id'][:8]})")

                if not ns.no_recovery:
                    rec = post_driver_recoveries(conn, groups)
                    conn.commit()
                    bill_row["driver_recovery"] = rec
                    counts["recoveries"] += rec["posted"]
                    totals["recovery"] += rec["amount"]
                    for r in rec["rows"]:
                        log(f"      RECOVERY {r['driver_name']:<24}{r['vehicle']:<12}"
                            f"short {r['shortage_qty']:>6}  Rs.{r['amount']:>10}")
                    for s in rec["skipped_no_driver"]:
                        log(f"      RECOVERY SKIPPED (no driver): {s['trip']} {s['penalty']}")

                if not ns.no_vouchers:
                    vouchers = post_vouchers(groups, args)
                    bill_row["vouchers"] = vouchers
                    counts["vouchers"] += sum(1 for v in vouchers if v.get("http") in (200, 201))
            else:
                bill_row["applied"] = False

            summary["bills"].append(bill_row)

        # ── SUMMARY ─────────────────────────────────────────────────────────
        rule("FINAL SUMMARY")
        rate = (counts["matched"] / counts["groups"] * 100) if counts["groups"] else 0.0
        log(f"  mode                  : {summary['mode']}")
        log(f"  bills processed       : {len(bills)}")
        log(f"  loads (groups)        : {counts['groups']}")
        log(f"  matched to ERP trips  : {counts['matched']}  ({rate:.1f}%)")
        log(f"  gross freight matched : {totals['gross']:>14,}")
        log(f"  shortage penalty      : {totals['penalty']:>14,}")
        log(f"  GST logged (RCM memo) : {totals['gst']:>14,}")
        log(f"  TDS 194C              : {totals['tds']:>14,}")
        log(f"  net receivable        : {totals['net']:>14,}")
        if ns.live:
            log(f"  trips updated         : {counts['trips']}")
            log(f"  receipt vouchers      : {counts['vouchers']}  -> {ns.bank_ledger}")
            log(f"  driver recoveries     : {counts['recoveries']}  "
                f"({totals['recovery']:,})")
        else:
            log("\n  DRY RUN - nothing written. Re-run with --live to commit.")

        summary["totals"] = {k: str(v) for k, v in totals.items()}
        summary["counts"] = counts
        summary["match_rate_pct"] = round(rate, 2)
        summary["finished_at"] = datetime.now().isoformat(timespec="seconds")
        summary["duration_s"] = round((datetime.now() - started).total_seconds(), 1)

        ns.report_dir.mkdir(parents=True, exist_ok=True)
        out = ns.report_dir / f"automation_{started.strftime('%Y%m%d-%H%M%S')}.json"
        # default=str: Decimal and date travel through the nested stage results
        # (driver_recovery amounts, bill dates). Money must never round-trip as
        # a float, so stringify rather than coerce.
        out.write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")
        log(f"\n  report -> {out}")
        return 0

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
