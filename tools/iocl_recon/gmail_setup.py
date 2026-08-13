#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
gmail_setup.py - one-time Gmail authorisation for the IOCL bill pipeline
================================================================================
Run this ONCE. After it succeeds, iocl_bill_automation.py fetches bills from
Gmail on its own and the manual download/ZIP dance is over.

    python tools/iocl_recon/gmail_setup.py            # authorise + verify
    python tools/iocl_recon/gmail_setup.py --check    # status only, no browser
    python tools/iocl_recon/gmail_setup.py --revoke   # delete the stored token

WHAT THIS SCRIPT CANNOT DO
--------------------------------------------------------------------------------
Create the OAuth client. That lives in YOUR Google account and needs YOUR login,
so it is five minutes of clicking that nobody can do on your behalf:

  1. https://console.cloud.google.com/  -> create (or pick) a project
  2. APIs & Services -> Library -> search "Gmail API" -> ENABLE
  3. APIs & Services -> OAuth consent screen
       User type: External -> fill app name + your email
       Scopes: skip (this script requests them)
       Test users: ADD YOUR OWN GMAIL ADDRESS   <- easy to miss, see below
  4. APIs & Services -> Credentials -> Create credentials
       -> OAuth client ID -> Application type: **Desktop app**   <- must be this
  5. Download JSON -> save as:
       tools/iocl_recon/gmail_credentials.json

Then run this script. A browser opens once, you approve, and a token is written
next to the credentials. That token is a live credential - it is gitignored, and
chmod 600 where the OS supports it.

Scope requested: gmail.readonly. This pipeline can read and download
attachments; it can never send, modify or delete mail.

THE TWO MISTAKES EVERYONE MAKES
--------------------------------------------------------------------------------
* Picking "Web application" instead of "Desktop app" in step 4. The flow then
  fails with redirect_uri_mismatch. This script checks the file up front and
  tells you plainly instead of letting Google's error confuse you.
* Forgetting step 3's "Test users" while the consent screen is in Testing mode.
  Google then answers access_denied even though everything else is correct.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta, UTC
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

HERE = Path(__file__).resolve().parent
CREDS = HERE / "gmail_credentials.json"
TOKEN = HERE / "gmail_token.json"
SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

# The window the pipeline reconciles, used here only to show what Gmail holds.
DEFAULT_FROM = date(2026, 4, 1)
DEFAULT_TO = date(2026, 8, 12)

QUERY = ('has:attachment filename:pdf from:b2bprd '
         'subject:"Transportation Bill" after:{after} before:{before}')


def out(msg: str = "") -> None:
    print(msg, flush=True)


def step(n: str, msg: str) -> None:
    out(f"  [{n}] {msg}")


# ═════════════════════════════════════════════════════════════════════════════
def inspect_credentials() -> dict:
    """Validate the downloaded client secret before Google gets a chance to
    fail cryptically."""
    if not CREDS.exists():
        return {"ok": False, "reason": "missing"}
    try:
        data = json.loads(CREDS.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return {"ok": False, "reason": f"not valid JSON: {exc}"}

    if "installed" in data:
        client = data["installed"]
        return {"ok": True, "type": "Desktop app",
                "client_id": client.get("client_id", "")[:32] + "...",
                "project": client.get("project_id")}
    if "web" in data:
        return {"ok": False, "reason": (
            "this is a WEB APPLICATION client, not a Desktop app. The desktop "
            "flow needs the 'installed' variety. Go back to Credentials -> "
            "Create credentials -> OAuth client ID -> Application type: Desktop app.")}
    return {"ok": False, "reason": "unrecognised client secret (no 'installed' or 'web' key)"}


def load_token():
    from google.oauth2.credentials import Credentials
    if not TOKEN.exists():
        return None
    try:
        return Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
    except Exception:
        return None


def save_token(creds) -> None:
    TOKEN.write_text(creds.to_json(), encoding="utf-8")
    try:
        os.chmod(TOKEN, 0o600)
    except OSError:
        pass


def authorise(force: bool = False, account: str | None = None):
    from google.auth.transport.requests import Request
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = None if force else load_token()
    if creds and creds.valid:
        step("2", "existing token is valid - no browser needed")
        return creds
    if creds and creds.expired and creds.refresh_token:
        step("2", "token expired - refreshing silently")
        creds.refresh(Request())
        save_token(creds)
        return creds

    step("2", "opening your browser for consent (approve, then come back here)")
    step("2", "PICK THE MAILBOX THAT RECEIVES THE IOCL BILLS - if you are signed")
    step(" ", "into several Google accounts it is easy to approve the wrong one,")
    step(" ", "and the result is a valid token over an empty mailbox.")
    if account:
        step(" ", f"expecting: {account}")
    flow = InstalledAppFlow.from_client_secrets_file(str(CREDS), SCOPES)
    # select_account forces the chooser even when a session already exists;
    # login_hint pre-selects the intended mailbox so the right one is one click
    # away rather than one mis-click away.
    kwargs = {"prompt": "select_account consent"}
    if account:
        kwargs["login_hint"] = account
    creds = flow.run_local_server(port=0, **kwargs)
    save_token(creds)
    step("2", f"token saved -> {TOKEN.name} (chmod 600, gitignored)")
    return creds


# ═════════════════════════════════════════════════════════════════════════════
def survey(creds, w_from: date, w_to: date) -> int:
    """Prove the connection works AND show what is actually reachable.

    An auth check that only says "connected" is worth little; what matters is
    whether the bills the pipeline needs are visible. This lists them by
    billing period so the coverage gap is obvious before any download runs.
    """
    from googleapiclient.discovery import build

    service = build("gmail", "v1", credentials=creds, cache_discovery=False)
    profile = service.users().getProfile(userId="me").execute()
    step("3", f"connected as {profile.get('emailAddress')} "
              f"({profile.get('messagesTotal', 0):,} messages)")

    q = QUERY.format(after=w_from.strftime("%Y/%m/%d"),
                     before=(w_to + timedelta(days=1)).strftime("%Y/%m/%d"))
    out(f"\n  query: {q}\n")

    messages, page = [], None
    while True:
        resp = service.users().messages().list(
            userId="me", q=q, pageToken=page, maxResults=100).execute()
        messages.extend(resp.get("messages", []))
        page = resp.get("nextPageToken")
        if not page:
            break

    if not messages:
        out("  NO MATCHING MAIL IN THIS ACCOUNT.")
        out("")
        out(f"  You authorised: {profile.get('emailAddress')}")
        out("  The commonest cause by far is approving the wrong Google account")
        out("  when several are signed in - the token is perfectly valid, it just")
        out("  points at a mailbox with no IOCL bills in it. Check the address")
        out("  above against the inbox where the bills actually arrive, then:")
        out("")
        out("    python tools/iocl_recon/gmail_setup.py --revoke")
        out("    python tools/iocl_recon/gmail_setup.py")
        out("")
        out("  (If that address IS right, widen the window or adjust QUERY at the")
        out("  top of this file - the sender may not be 'b2bprd'.)")
        return 0

    periods: dict[str, dict] = defaultdict(lambda: {"pdfs": 0, "mails": 0, "dates": set()})
    total_pdfs = 0
    import re
    for m in messages:
        msg = service.users().messages().get(
            userId="me", id=m["id"], format="full").execute()
        received = datetime.fromtimestamp(int(msg["internalDate"]) / 1000, UTC).date()
        headers = {h["name"].lower(): h["value"] for h in msg["payload"].get("headers", [])}
        subject = headers.get("subject", "")
        snippet = msg.get("snippet", "")
        pm = re.search(r"(\d{2}\.\d{2}\.\d{4})\s*-\s*(\d{2}\.\d{2}\.\d{4})", subject + " " + snippet)
        key = f"{pm.group(1)} - {pm.group(2)}" if pm else "period not stated"

        stack, pdfs = [msg.get("payload", {})], 0
        while stack:
            p = stack.pop()
            if (p.get("filename") or "").lower().endswith(".pdf"):
                pdfs += 1
            stack.extend(p.get("parts", []) or [])

        periods[key]["pdfs"] += pdfs
        periods[key]["mails"] += 1
        periods[key]["dates"].add(received)
        total_pdfs += pdfs

    out(f"  {len(messages)} mails · {total_pdfs} PDF attachments\n")
    out(f"  {'billing period':<28}{'mails':>6}{'PDFs':>7}   received")
    out("  " + "-" * 62)
    for key in sorted(periods, key=lambda k: k[-4:] + k[3:5] + k[:2]):
        v = periods[key]
        seen = ", ".join(str(d) for d in sorted(v["dates"])[:3])
        out(f"  {key:<28}{v['mails']:>6}{v['pdfs']:>7}   {seen}")
    out("  " + "-" * 62)
    out(f"  {'TOTAL':<28}{len(messages):>6}{total_pdfs:>7}")
    return total_pdfs


# ═════════════════════════════════════════════════════════════════════════════
def main(argv: list[str] | None = None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    ap = argparse.ArgumentParser(description="One-time Gmail authorisation for the IOCL pipeline.")
    ap.add_argument("--check", action="store_true", help="report status only; never open a browser")
    ap.add_argument("--revoke", action="store_true", help="delete the stored token")
    ap.add_argument("--force", action="store_true", help="re-authorise even if a token exists")
    ap.add_argument("--account", default=None,
                    help="the mailbox that receives the bills. Pre-selects it in the consent "
                         "screen and REJECTS the token if a different account is approved.")
    ap.add_argument("--window-from", default=str(DEFAULT_FROM))
    ap.add_argument("--window-to", default=str(DEFAULT_TO))
    args = ap.parse_args(argv)

    out("=" * 70)
    out(" GMAIL SETUP · IOCL bill automation")
    out("=" * 70)

    if args.revoke:
        if TOKEN.exists():
            TOKEN.unlink()
            out("  token deleted. Re-run without --revoke to authorise again.")
        else:
            out("  no token to delete.")
        return 0

    try:
        import googleapiclient  # noqa: F401
        import google_auth_oauthlib  # noqa: F401
    except ImportError:
        out("  MISSING LIBRARIES. Run:")
        out("    python -m pip install google-api-python-client google-auth-oauthlib")
        return 2

    info = inspect_credentials()
    if not info["ok"]:
        if info["reason"] == "missing":
            out(f"\n  WAITING ON YOU: {CREDS} does not exist yet.\n")
            out("  Five minutes in the Google Cloud Console:")
            out("    1. https://console.cloud.google.com/  -> create/pick a project")
            out("    2. APIs & Services > Library > 'Gmail API' > ENABLE")
            out("    3. APIs & Services > OAuth consent screen > External")
            out("       -> add YOUR OWN gmail address under 'Test users'")
            out("    4. APIs & Services > Credentials > Create credentials")
            out("       -> OAuth client ID > Application type: DESKTOP APP")
            out(f"    5. Download the JSON and save it as:\n         {CREDS}")
            out("\n  Then run this script again.")
        else:
            out(f"\n  CREDENTIALS PROBLEM: {info['reason']}")
        return 2

    step("1", f"credentials OK - {info['type']}"
              + (f", project {info['project']}" if info.get("project") else ""))

    if args.check:
        creds = load_token()
        if creds and creds.valid:
            step("2", "token present and valid")
            survey(creds, date.fromisoformat(args.window_from), date.fromisoformat(args.window_to))
            out("\n  READY. Run the pipeline:")
            out("    python tools/iocl_recon/iocl_bill_automation.py --live \\")
            out(f"      --window-from {args.window_from} --window-to {args.window_to}")
            return 0
        step("2", "no valid token yet - re-run without --check to authorise")
        return 1

    try:
        creds = authorise(force=args.force, account=args.account)
    except Exception as exc:
        msg = str(exc)
        out(f"\n  AUTHORISATION FAILED: {msg[:300]}")
        if "access_denied" in msg or "403" in msg:
            out("\n  Most likely: your consent screen is in Testing mode and your own")
            out("  address is not listed under 'Test users'. Add it and retry.")
        elif "redirect_uri" in msg:
            out("\n  Most likely: the client is a Web application, not a Desktop app.")
            out("  Create a new OAuth client ID with type 'Desktop app'.")
        return 2

    # Guard: an authorisation over the WRONG mailbox is the failure mode that
    # actually happens, and it looks like success from every angle - valid
    # token, clean connection, zero bills. Refuse it explicitly.
    from googleapiclient.discovery import build
    actual = build("gmail", "v1", credentials=creds, cache_discovery=False) \
        .users().getProfile(userId="me").execute().get("emailAddress", "")
    if args.account and actual.lower() != args.account.lower():
        TOKEN.unlink(missing_ok=True)
        out(f"\n  WRONG MAILBOX - token discarded.")
        out(f"    expected : {args.account}")
        out(f"    got      : {actual}")
        out("\n  You approved a different Google account than the one asked for.")
        out("  Two things make this stick:")
        out(f"    1. Sign in to {args.account} in this browser first")
        out("       (Gmail > profile icon > Add another account)")
        out(f"    2. Console > OAuth consent screen > Test users > ADD {args.account}")
        out("       - while the app is in Testing mode, any account not listed")
        out("         there is refused, and it is easy to fall back to the wrong one.")
        out("\n  Then re-run the same command.")
        return 2

    try:
        found = survey(creds, date.fromisoformat(args.window_from), date.fromisoformat(args.window_to))
    except Exception as exc:
        out(f"\n  Connected, but the survey failed: {exc}")
        return 2

    if not found:
        # Connected, but nothing to fetch: not a setup worth calling complete.
        out("\n" + "=" * 70)
        out(f" NOT USABLE YET · authorised {actual} but 0 bills reachable")
        out("=" * 70)
        return 1

    out("\n" + "=" * 70)
    out(f" SETUP COMPLETE · {found} bill PDFs reachable in {actual}")
    out("=" * 70)
    out(" Now run the pipeline (dry run first):")
    out(f"   python tools/iocl_recon/iocl_bill_automation.py \\")
    out(f"     --window-from {args.window_from} --window-to {args.window_to}")
    out(" Then add --live to commit.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
