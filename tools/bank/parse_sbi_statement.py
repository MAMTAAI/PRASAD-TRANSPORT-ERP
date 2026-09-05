#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
parse_sbi_statement.py — one bank statement (SBI PDF / CSV) → JSON lines.

    python tools/bank/parse_sbi_statement.py --file "April 2026 Prasad SBI 30178368490.pdf" --out lines.json
    python tools/bank/parse_sbi_statement.py --file stmt.pdf --password "..." --out lines.json
    python tools/bank/parse_sbi_statement.py --file export.csv --out lines.json

Two SBI layouts are read (owner's files, 5-Sep-2026):
  A. Current-account PDF (8 columns): Txn Date, Value Date, Description,
     Ref No./Cheque No., Branch Code, Debit, Credit, Balance — cells wrap
     over several lines, "(cid:9)" tabs in the header text.
  B. Savings / YONO export (7 columns): Txn Date, Value Date, Description,
     Ref, Debit, Credit, Balance — "-" where a cell is empty, PDF password.
CSV: the column names above (any order, case-insensitive).

The UTR is lifted from the reference column, the counterparty from the
narration (UPI/DR/<ref>/<NAME>/<bank>/…, "TRANSFER FROM <acct> <NAME>",
NEFT*…*<NAME>), the channel from the wording. Nothing is guessed about
whose money it is — that is TARA's job, on the ERP side.
"""
from __future__ import annotations
import argparse, csv, hashlib, json, re, sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

DATE_RE = re.compile(r"^\d{2}/\d{2}/\d{4}$")
NUM = lambda s: float(str(s).replace(",", "").strip()) if s is not None and re.search(r"\d", str(s)) else 0.0

def to_iso(d: str) -> str | None:
    d = (d or "").strip()
    m = re.match(r"^(\d{2})/(\d{2})/(\d{4})$", d)
    if m: return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", d)
    if m: return d
    m = re.match(r"^(\d{1,2}) (\w{3}) (\d{4})$", d)
    if m:
        mon = {"jan":1,"feb":2,"mar":3,"apr":4,"may":5,"jun":6,"jul":7,"aug":8,"sep":9,"oct":10,"nov":11,"dec":12}[m.group(2).lower()[:3]]
        return f"{m.group(3)}-{mon:02d}-{int(m.group(1)):02d}"
    return None

def enrich(l: dict) -> dict:
    text = f"{l['description']} {l['ref_no']}"
    utr = re.search(r"\b([A-Z]{2}\d[A-Z0-9]{7,13}|[A-Z]{4}[A-Z0-9]{8,20}|N\d{6}[A-Z0-9]{8,12})\b", l["ref_no"] or "")
    l["utr"] = utr.group(1) if utr else None
    d = l["description"]; up = text.upper()
    l["channel"] = ("UPI" if "UPI/" in d else "INB" if "INB" in d else "NEFT" if "NEFT" in up else "IMPS" if "IMPS" in up
                    else "RTGS" if "RTGS" in up else "CHQ" if ("CHEQUE" in up or "CLG" in up) else "CASH" if "CASH" in up
                    else "ATM" if "ATM" in up else "CHG" if re.search(r"CHARGE|CHRG|SMS|GST", up) else "OTHER")
    cp = None
    m = re.search(r"UPI/(?:DR|CR)/[\d ]+/([^/]+)/", d)
    if m: cp = m.group(1).strip()
    m2 = re.search(r"TRANSFER (?:FROM|TO) \d+ ([A-Z][A-Z .&]+?)\s*/?$", l["ref_no"] or "")
    if not cp and m2: cp = m2.group(1).strip()
    m3 = re.search(r"NEFT\*[^*]*\*[^*]*\*([^*]+)", text)
    if not cp and m3: cp = m3.group(1).strip()
    m4 = re.search(r"(?:IMPS|RTGS)[/ ]+[A-Z0-9]+[/ ]+([A-Z][A-Z .&]{3,})", up)
    if not cp and m4: cp = m4.group(1).strip()
    l["counterparty"] = (cp or None)
    return l

def parse_pdf(path: Path, password: str | None) -> dict:
    import pdfplumber
    meta, lines = {}, []
    with pdfplumber.open(str(path), password=password or None) as pdf:
        t0 = (pdf.pages[0].extract_text() or "").replace("(cid:9)", " ")
        m = re.search(r"Account Number\s*:?\s*(\d+)", t0); meta["account_no"] = m.group(1)[-11:] if m else None
        m = re.search(r"Account Name\s*:?\s*(.+)", t0); meta["account_name"] = m.group(1).strip() if m else None
        if not meta["account_name"]:
            m = re.search(r"(Mr\.?|Ms\.?|M/S)\s+([A-Z][A-Z .]+)", t0); meta["account_name"] = m.group(0).strip() if m else None
        m = re.search(r"Opening Balance as on (\d+ \w+ \d{4})\s*:?\s*([\d,\.]+)", t0)
        meta["opening_balance"] = NUM(m.group(2)) if m else None; meta["opening_date"] = to_iso(m.group(1)) if m else None
        m = re.search(r"Account Statement from (\d+ \w+ \d{4}) to (\d+ \w+ \d{4})", t0)
        meta["period_from"], meta["period_to"] = (to_iso(m.group(1)), to_iso(m.group(2))) if m else (None, None)
        for pno, page in enumerate(pdf.pages):
            for tbl in page.extract_tables():
                for r in tbl:
                    if not r or not r[0] or not DATE_RE.match(str(r[0]).strip()): continue
                    r = [(c or "").replace("\n", " ").strip() for c in r]
                    if len(r) == 7:
                        txn, val, desc, ref, dr, cr, bal = r; br = ""
                    else:
                        while len(r) < 8: r.append("")
                        txn, val, desc, ref, br, dr, cr, bal = r[:8]
                    lines.append({"txn_date": to_iso(txn), "value_date": to_iso(val) or to_iso(txn), "description": desc, "ref_no": ref,
                                  "branch_code": br, "debit": NUM(dr), "credit": NUM(cr), "balance": NUM(bal) if re.search(r"\d", bal) else None, "page": pno + 1})
    return {"meta": meta, "lines": lines}

def parse_csv(path: Path) -> dict:
    lines = []; meta = {"account_no": None, "account_name": None, "period_from": None, "period_to": None, "opening_balance": None}
    with open(path, encoding="utf-8-sig", errors="replace", newline="") as fh:
        rows = list(csv.reader(fh))
    # header row = the one holding "Txn Date" (SBI exports carry a preamble)
    hi = next((i for i, r in enumerate(rows) if any("txn date" in (c or "").lower() for c in r)), None)
    if hi is None: raise SystemExit("CSV: no 'Txn Date' header found")
    hdr = [c.strip().lower() for c in rows[hi]]
    col = lambda *names: next((i for i, h in enumerate(hdr) if any(h.startswith(n) for n in names)), None)
    ci = {"txn": col("txn date"), "val": col("value date"), "desc": col("description", "narration"), "ref": col("ref no", "ref./", "cheque"),
          "br": col("branch"), "dr": col("debit", "withdrawal"), "cr": col("credit", "deposit"), "bal": col("balance")}
    for r in rows[hi + 1:]:
        if not r or ci["txn"] is None or ci["txn"] >= len(r) or not to_iso(r[ci["txn"]]): continue
        g = lambda k: (r[ci[k]] if ci[k] is not None and ci[k] < len(r) else "")
        lines.append({"txn_date": to_iso(g("txn")), "value_date": to_iso(g("val")) or to_iso(g("txn")), "description": g("desc").strip(), "ref_no": g("ref").strip(),
                      "branch_code": g("br").strip(), "debit": NUM(g("dr")), "credit": NUM(g("cr")), "balance": NUM(g("bal")) if re.search(r"\d", g("bal")) else None, "page": 1})
    for r in rows[:hi]:
        j = " ".join(c for c in r if c)
        m = re.search(r"Account Number\s*:?\s*(\d+)", j)
        if m: meta["account_no"] = m.group(1)[-11:]
        m = re.search(r"Account Name\s*:?\s*(.+)", j)
        if m: meta["account_name"] = m.group(1).strip()
    return {"meta": meta, "lines": lines}

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="SBI statement → JSON lines")
    ap.add_argument("--file", required=True, type=Path)
    ap.add_argument("--password", default=None)
    ap.add_argument("--account", default=None, help="override / supply the 11-digit account number")
    ap.add_argument("--out", type=Path, default=None)
    a = ap.parse_args(argv)
    ext = a.file.suffix.lower()
    if ext == ".pdf": r = parse_pdf(a.file, a.password)
    elif ext in (".csv", ".txt"): r = parse_csv(a.file)
    elif ext in (".xlsx", ".xls"):
        try:
            import openpyxl  # noqa: F401
        except Exception:
            raise SystemExit("XLSX needs openpyxl on this machine — export the statement as CSV or PDF instead")
        import openpyxl
        wb = openpyxl.load_workbook(str(a.file), read_only=True, data_only=True); ws = wb.active
        tmp = a.file.with_suffix(".csv")
        with open(tmp, "w", encoding="utf-8", newline="") as fh:
            w = csv.writer(fh)
            for row in ws.iter_rows(values_only=True): w.writerow(["" if c is None else str(c) for c in row])
        r = parse_csv(tmp)
    else: raise SystemExit(f"unsupported file type {ext}")
    if a.account: r["meta"]["account_no"] = a.account[-11:]
    acc = r["meta"].get("account_no") or ""
    seen = set(); out = []
    for l in r["lines"]:
        l = enrich(l)
        uid = hashlib.md5(f"{acc}|{l['txn_date']}|{l['debit']:.2f}|{l['credit']:.2f}|{'' if l['balance'] is None else format(l['balance'], '.2f')}|{(l['ref_no'] or '')[:24]}".encode()).hexdigest()
        if uid in seen: continue
        seen.add(uid); l["line_uid"] = uid; out.append(l)
    out.sort(key=lambda x: (x["txn_date"] or "", x["page"]))
    r["lines"] = out
    r["meta"]["rows"] = len(out); r["meta"]["file"] = a.file.name
    r["meta"]["credits"] = round(sum(l["credit"] for l in out), 2); r["meta"]["debits"] = round(sum(l["debit"] for l in out), 2)
    if out and not r["meta"].get("period_from"): r["meta"]["period_from"], r["meta"]["period_to"] = out[0]["txn_date"], out[-1]["txn_date"]
    js = json.dumps(r, ensure_ascii=False, indent=None)
    if a.out: a.out.write_text(js, encoding="utf-8"); print(f"{a.file.name}: account {acc or '?'} · {len(out)} lines · {r['meta']['period_from']} → {r['meta']['period_to']} → {a.out}")
    else: print(js)
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
