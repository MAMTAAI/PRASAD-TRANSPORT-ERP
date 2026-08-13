#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
load_advices.py - load parsed payment advices into PostgreSQL.

Idempotent on pdf_sha256 (one advice per file) and line_uid, so re-running
converges. Reads the JSON produced by fetch_advices.py.

    python tools/iocl_recon/load_advices.py --apply
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from iocl_reconcile import connect, load_dotenv  # noqa: E402

REPO = Path(__file__).resolve().parents[2]

UPSERT_ADVICE = """
INSERT INTO iocl_payment_advices
  (odn, bank_ref, advice_date, remitted, computed_net, ties, mode, bank_name,
   account_tail, pdf_name, pdf_sha256, tool_version, warnings)
VALUES (%(odn)s,%(bank_ref)s,%(advice_date)s,%(remitted)s,%(computed_net)s,%(ties)s,
        %(mode)s,%(bank_name)s,%(account_tail)s,%(pdf_name)s,%(pdf_sha256)s,
        %(tool_version)s,%(warnings)s)
-- ODN is the advice's business key, not the file hash: the same advice reaches
-- us as two files (saved by hand and fetched from Gmail) whose bytes differ.
-- Conflicting on the hash therefore let a second copy through, and it collided
-- on odn instead.
ON CONFLICT (odn) DO UPDATE SET
  remitted=EXCLUDED.remitted, computed_net=EXCLUDED.computed_net, ties=EXCLUDED.ties,
  warnings=EXCLUDED.warnings, advice_date=EXCLUDED.advice_date,
  pdf_name=EXCLUDED.pdf_name, pdf_sha256=EXCLUDED.pdf_sha256
RETURNING advice_id::text AS advice_id
"""

UPSERT_LINE = """
INSERT INTO iocl_advice_lines
  (line_uid, advice_id, voucher_no, item, reference, bill_no, plant, material_text,
   kind, gross, tds, deduction, net, gst_tax, page_no)
VALUES (%(line_uid)s,%(advice_id)s,%(voucher_no)s,%(item)s,%(reference)s,%(bill_no)s,
        %(plant)s,%(material_text)s,%(kind)s,%(gross)s,%(tds)s,%(deduction)s,%(net)s,
        %(gst_tax)s,%(page_no)s)
ON CONFLICT (line_uid) DO UPDATE SET
  advice_id=EXCLUDED.advice_id, kind=EXCLUDED.kind, net=EXCLUDED.net,
  gross=EXCLUDED.gross, tds=EXCLUDED.tds, bill_no=EXCLUDED.bill_no
"""


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", type=Path, default=REPO / "reports" / "iocl_recon" / "advices.json")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args(argv)

    load_dotenv(REPO)
    advices = json.loads(args.json.read_text(encoding="utf-8"))
    # Same advice, two files — keep one per ODN so the load is deterministic.
    seen, unique = set(), []
    for a in advices:
        key = a.get("odn") or a["pdf_sha256"]
        if key in seen:
            print(f"  duplicate advice skipped: {a['pdf_name']} (ODN {a.get('odn')})")
            continue
        seen.add(key)
        unique.append(a)
    advices = unique
    print(f"{len(advices)} advices from {args.json.name}")
    if not args.apply:
        print("DRY RUN — pass --apply to write.")
        return 0

    conn = connect(); conn.autocommit = False
    n_adv = n_line = 0
    try:
        with conn.cursor() as cur:
            for a in advices:
                cur.execute(UPSERT_ADVICE, {
                    "odn": a["odn"], "bank_ref": a["bank_ref"], "advice_date": a["advice_date"],
                    "remitted": a["remitted"], "computed_net": a["computed_net"],
                    "ties": a["ties_to_remittance"], "mode": a["mode"],
                    "bank_name": a["bank_name"], "account_tail": a["account_tail"],
                    "pdf_name": a["pdf_name"], "pdf_sha256": a["pdf_sha256"],
                    "tool_version": a["tool_version"], "warnings": json.dumps(a["warnings"]),
                })
                advice_id = cur.fetchone()["advice_id"]
                n_adv += 1
                for l in a["lines"]:
                    cur.execute(UPSERT_LINE, {**l, "advice_id": advice_id,
                                              "material_text": (l.get("material_text") or "")[:400]})
                    n_line += 1
        conn.commit()
        print(f"loaded {n_adv} advices, {n_line} lines")
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM v_settlement_summary")
            for r in cur.fetchall():
                print(f"  {r['kind']:<22}{r['lines']:>5} lines  {float(r['net_amount']):>16,.2f}")
            cur.execute("""SELECT payment_state, count(*) n, SUM(billed_gross)::numeric(14,2) gross
                             FROM v_bill_settlement GROUP BY 1 ORDER BY 1""")
            print("\n  BILL SETTLEMENT")
            for r in cur.fetchall():
                print(f"  {r['payment_state']:<12}{r['n']:>4} bills  {float(r['gross']):>16,.2f}")
        return 0
    except Exception:
        conn.rollback(); raise
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
