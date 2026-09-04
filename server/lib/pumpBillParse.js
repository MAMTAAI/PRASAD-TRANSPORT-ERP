// server/lib/pumpBillParse.js
// ─────────────────────────────────────────────────────────────────────────────
// Reading a petrol pump's own invoice.
//
// NOT OCR. These PDFs carry real text — 71 embedded fonts and one logo image —
// so the characters are read, not guessed at. That matters for money: OCR turns
// 8 into 3 and 92.37 into 9237 often enough that nobody should reach for it
// when the text is right there. BHUVANESHWARI's OCR stays for the bills that
// really are photographs.
//
// TWO PUMPS, TWO SHAPES, and the difference is not cosmetic:
//
//   Sree Krishna  a clean fortnight: Date | Vehicle | Product | Qty | Rate |
//                 Amount, then "Total= 2150 ₹1,98,595.50 0 ₹1,98,595.00".
//                 One invoice = one period's charges. Rows wrap across two
//                 printed lines and the product code drifts between them.
//
//   B N Filling   a RUNNING ACCOUNT: this month's rows, then "B/f:- 471357.00",
//                 "Paid Amount -470216.00", "Grand Total:- 605038.00". The
//                 grand total is NOT this period's bill — it carries the
//                 previous balance forward. Booking 605038 as the month's
//                 charge would put 471357 of already-billed diesel into the
//                 books a second time.
//
// SO EVERY BILL IS CHECKED AGAINST ITS OWN PRINTED TOTAL before it is trusted.
// If the rows this parser found do not add up to what the pump itself printed,
// the bill is refused rather than imported at the wrong number.
// ─────────────────────────────────────────────────────────────────────────────

/** A number as an Indian invoice writes it: 1,98,595.50 → 198595.5 */
export function money(t) {
  if (t == null) return null;
  const s = String(t).replace(/[₹\s]/g, '').replace(/,/g, '');
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** dd.mm.yyyy / dd-mm-yyyy / dd/mm/yyyy → ISO. Day first, always: these are Indian invoices. */
export function toISO(t) {
  const m = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/.exec(String(t ?? ''));
  if (!m) return null;
  let [, d, mo, y] = m;
  y = y.length === 2 ? `20${y}` : y;
  const dt = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(dt) ? dt : null;
}

/** A lorry as our fleet spells it. Same normalisation the database uses. */
export const regKey = (v) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** The pump name, normalised the way migration 153's pump_key() does it. */
export const pumpKey = (t) => String(t ?? '').toUpperCase()
  .replace(/(BHARAT PETROLEUM DEALERS?|BPCL DEALERS?|INDIAN OIL|IOCL|HPCL|PVT LTD|PRIVATE LIMITED)/g, ' ')
  .replace(/\bSTN\b/g, 'STATION')
  .replace(/[^A-Z0-9]/g, '');

export class BillParseError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Turn a PDF into lines of text.
 *
 * A PDF has no lines — only glyphs at coordinates — so the text is regrouped by
 * Y position and then ordered by X. Without that the invoice comes back as one
 * long ribbon and no column can be told from another.
 */
export async function pdfLines(data) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({
    // A Node Buffer IS a Uint8Array subclass, but pdfjs checks the constructor
    // strictly and refuses it. Always hand it a plain view.
    data: new Uint8Array(data.buffer ?? data, data.byteOffset ?? 0, data.byteLength ?? data.length),
    useSystemFonts: true,
    // The invoices carry no scripts and we do not want any evaluated.
    isEvalSupported: false,
  }).promise;

  const pages = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const rows = new Map();
    for (const it of content.items) {
      if (!it.str || !it.str.trim()) continue;
      // Rounded to the whole point: the same printed line can sit a fraction
      // apart when a cell uses a different font size.
      const y = Math.round(it.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], s: it.str });
    }
    pages.push([...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, cells]) => cells.sort((a, b) => a.x - b.x)
        .map((c) => c.s).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean));
  }
  await doc.destroy?.();
  return pages.flat();
}

// ── B N Filling ─────────────────────────────────────────────────────────────
// S.no. | Date | Slip No. | Vehicle Number | Item Name | Qty | Rate | Amount
const BN_ROW = /^(\d{1,3})\s+(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})\s+(\S+)\s+([A-Z0-9\-]{6,})\s+([A-Za-z]+)\s+([\d.]+)\s+([\d.]+)\s+([\d,]+\.?\d*)$/;

function parseBN(lines) {
  const rows = [];
  for (const l of lines) {
    const m = BN_ROW.exec(l);
    if (!m) continue;
    rows.push({
      sno: Number(m[1]),
      date: toISO(m[2]),
      date_raw: m[2],
      slip_no: /^x+$/i.test(m[3]) ? null : m[3],
      vehicle_raw: m[4],
      vehicle_key: regKey(m[4]),
      product: m[5],
      qty: money(m[6]),
      rate: money(m[7]),
      amount: money(m[8]),
    });
  }

  const grab = (re) => {
    for (const l of lines) { const m = re.exec(l); if (m) return money(m[1]); }
    return null;
  };
  const totals = {
    // A RUNNING ACCOUNT. Grand total carries the previous balance; the
    // period's own charge is the rows.
    brought_forward: grab(/B\/f[:\-\s]*([\d,]+\.?\d*)/i),
    paid: grab(/Paid Amount\s*-?\s*([\d,]+\.?\d*)/i),
    grand_total: grab(/Grand Total[:\-\s]*([\d,]+\.?\d*)/i),
    net_amount: grab(/Net Amount[:\-\s]*([\d,]+\.?\d*)/i),
    stated_qty: null,
    stated_amount: null,
  };
  // What the pump says this period cost, derived from its own arithmetic:
  //   grand total = brought forward - paid + this period
  if (totals.grand_total != null && totals.brought_forward != null && totals.paid != null) {
    totals.stated_amount = Number(
      (totals.grand_total - totals.brought_forward + totals.paid).toFixed(2));
  }

  const inv = /([A-Z]{2,6}\/\d+\/\d{4}-\d{2})/.exec(lines.join(' '));
  const dateLine = lines.find((l) => /Date:?-?\s*\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}/i.test(l));
  return {
    format: 'BN',
    pump: 'B N FILLING STATION',
    invoice_no: inv ? inv[1] : null,
    invoice_date: dateLine ? toISO(dateLine.replace(/^.*Date:?-?\s*/i, '')) : null,
    buyer: /jaiswal/i.test(lines.join(' ')) ? 'JAISWAL ENTERPRISE'
         : /prasad/i.test(lines.join(' ')) ? 'PRASAD TRANSPORT' : null,
    rows,
    totals,
  };
}

// ── Sree Krishna ────────────────────────────────────────────────────────────
// Rows wrap over two printed lines and the product code moves between them:
//   "08.04.2026 NL-01AA-3054 350 ₹ 32,329.50"  /  "HSD 92.37 ₹ 32,329.50"
//   "09.04.2026 NL-01AA-3056 HSD 300 ₹ 27,711.00"  /  "92.37 ₹ 27,711.00"
// So the first line is matched for date+vehicle+qty+amount, and the rate is
// taken from whichever of the two lines carries it.
// A row STARTS with a date and a lorry. Everything after that is read by
// position rather than by one big pattern, because the columns move:
//
//   "16.07.2026 NL-01AA-3054 HSD 225 ₹ 22,540.50"        rate on the next line
//   "18.07.2026 NL-01AA-3056 HSD 350 100.18 ₹ 35,063.00 ₹ 35,063.00"   all here
//
// THE AMOUNT IS THE FIRST ₹ FIGURE, never simply "the number after the litres".
// A single pattern that took the next number read the RATE as the amount on the
// second shape above — 100.18 instead of 35,063.00 — and the July 16–31 invoice
// came out ₹34,962.82 short. It was the pump's own printed total that caught
// it, which is exactly why that check exists.
const SK_HEAD = /^(\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4})\s+([A-Z0-9][A-Z0-9\-]{5,})\s+(.*)$/;
/** Diesel sells between about ₹50 and ₹200 a litre; a litre count does not. */
const looksLikeRate = (n) => n != null && n >= 50 && n <= 200 && !Number.isInteger(n);

function parseSK(lines) {
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = SK_HEAD.exec(lines[i]);
    if (!m) continue;
    const [, d, veh, rest] = m;
    if (!toISO(d)) continue;

    const tail = i + 1 < lines.length ? lines[i + 1] : '';
    const product = (/\b(HSD|MS|DIESEL|PETROL)\b/i.exec(rest)
                  ?? /\b(HSD|MS|DIESEL|PETROL)\b/i.exec(tail))?.[1]?.toUpperCase() ?? 'HSD';

    // The amount: the first figure the invoice marks with a rupee sign, on this
    // line or the continuation.
    const amount = money((/₹\s*([\d,]+\.?\d*)/.exec(rest) ?? /₹\s*([\d,]+\.?\d*)/.exec(tail))?.[1]);

    // Everything numeric before the first ₹ on this line: the litres, and
    // sometimes the rate as well.
    const beforeRupee = rest.split('₹')[0];
    const nums = (beforeRupee.match(/\d[\d,]*\.?\d*/g) ?? []).map(money).filter((n) => n != null);
    const qty = nums.find((n) => !looksLikeRate(n)) ?? null;

    // The rate is on this line or the next; either way it is the rate-shaped one.
    const tailNums = (tail.match(/\d[\d,]*\.?\d*/g) ?? []).map(money).filter((n) => n != null);
    const rate = nums.find(looksLikeRate) ?? tailNums.find(looksLikeRate) ?? null;

    rows.push({
      sno: rows.length + 1,
      date: toISO(d),
      date_raw: d,
      slip_no: null,
      vehicle_raw: veh,
      vehicle_key: regKey(veh),
      product,
      qty,
      rate,
      amount,
    });
  }

  // "Total= 2150 ₹ 1,98,595.50 0 ₹ 1,98,595.00"
  let stated_qty = null; let gross = null; let net = null;
  for (const l of lines) {
    const m = /Total=\s*([\d,.]+)\s*₹?\s*([\d,]+\.?\d*)\s*([\d,]*)\s*₹?\s*([\d,]+\.?\d*)?/.exec(l);
    if (m) { stated_qty = money(m[1]); gross = money(m[2]); net = money(m[4]) ?? gross; break; }
  }
  // "R/O" is printed on its own line and the figure lands on the next one.
  let round_off = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/R\/O/i.test(lines[i])) continue;
    const here = /(-?[\d,]+\.\d{1,2})/.exec(lines[i].replace(/R\/O/i, ''));
    const next = i + 1 < lines.length ? /(-?[\d,]+\.\d{1,2})/.exec(lines[i + 1]) : null;
    round_off = money(here?.[1] ?? next?.[1]);
    break;
  }

  const inv = /([A-Z]{2,6}\/\d+\/\d{2}-\d{2})/.exec(lines.join(' '));
  const invLine = lines.find((l) => /Invoice No/i.test(l));
  return {
    format: 'SK',
    pump: 'SREE KRISHNA SERVICE CENTRE',
    invoice_no: inv ? inv[1] : null,
    invoice_date: invLine ? toISO(invLine) : null,
    buyer: /jaiswal/i.test(lines.join(' ')) ? 'JAISWAL ENTERPRISE'
         : /prasad/i.test(lines.join(' ')) ? 'PRASAD TRANSPORT' : null,
    rows,
    totals: {
      brought_forward: null,
      paid: null,
      grand_total: net,
      net_amount: net,
      round_off,
      stated_qty,
      stated_amount: gross,
    },
  };
}

/**
 * Parse one pump invoice.
 *
 * The format is decided by the invoice's own header, never by the filename —
 * a file called "May 2026.pdf" is a promise, not evidence.
 *
 * @returns {object} the bill, its rows, and a `check` saying whether the rows
 *   add up to what the pump printed. `check.ok === false` means DO NOT IMPORT.
 */
export function parsePumpBill(lines) {
  const all = lines.join(' ');
  let bill;
  if (/BN FILLING STATION/i.test(all) || /S\.no\.\s+Date\s+Slip No/i.test(all)) bill = parseBN(lines);
  else if (/SREE KRISHNA/i.test(all) || /Qnty\/Ltr/i.test(all)) bill = parseSK(lines);
  else {
    throw new BillParseError('UNKNOWN_PUMP_FORMAT',
      'this invoice is from a pump whose layout is not known yet',
      lines.slice(0, 8));
  }

  if (!bill.rows.length) {
    throw new BillParseError('NO_LINES', 'no diesel rows could be read from this invoice');
  }

  bill.pump_key = pumpKey(bill.pump);

  // The period is the rows' own span, not the filename and not the invoice
  // date — a bill dated 16.04 covers 1–15 April.
  const dates = bill.rows.map((r) => r.date).filter(Boolean).sort();
  bill.period_from = dates[0] ?? null;
  bill.period_to = dates[dates.length - 1] ?? null;

  const sum = (f) => Number(bill.rows.reduce((s, r) => s + (Number(r[f]) || 0), 0).toFixed(2));
  bill.computed = { qty: sum('qty'), amount: sum('amount'), rows: bill.rows.length };

  // ── the check that decides whether this bill may be trusted ──────────────
  const stated = bill.totals.stated_amount;
  const diff = stated == null ? null : Number((bill.computed.amount - stated).toFixed(2));
  bill.check = {
    stated_amount: stated,
    computed_amount: bill.computed.amount,
    difference: diff,
    stated_qty: bill.totals.stated_qty,
    computed_qty: bill.computed.qty,
    // A rupee of slack for the round-off line the pumps print; nothing more.
    ok: stated == null ? false : Math.abs(diff) <= 1.01,
    why: stated == null
      ? 'the invoice does not state a period total this parser could find'
      : Math.abs(diff) <= 1.01
        ? null
        : `rows add to ${bill.computed.amount} but the invoice states ${stated}`,
  };

  // Rows whose date falls outside the bill's own month are real and common —
  // B N's April invoice carries an 01.04.2024 typo and a 09.03.2026 line. They
  // are flagged, never corrected: a date this parser rewrote is a date nobody
  // can check against the paper.
  const month = bill.invoice_date?.slice(0, 7);
  bill.anomalies = [];
  for (const r of bill.rows) {
    if (!r.date) bill.anomalies.push({ sno: r.sno, kind: 'BAD_DATE', raw: r.date_raw });
    else if (month && r.date.slice(0, 7) !== month) {
      // A line from the month before is ordinary — a slip that reached the pump
      // late. A line from two years before is a typo the pump made (B N's April
      // invoice really does carry 01.04.2024). Both are shown; neither is
      // corrected here, because a date this parser rewrote is a date nobody can
      // check against the paper.
      bill.anomalies.push({
        sno: r.sno, kind: 'DATE_OUTSIDE_BILL', raw: r.date_raw, date: r.date,
        previous_month: r.date.slice(0, 7) === prevMonth(month),
      });
    }
    if (r.qty == null || r.amount == null) {
      bill.anomalies.push({ sno: r.sno, kind: 'MISSING_FIGURE', raw: r.date_raw });
    } else if (r.rate != null && Math.abs(r.qty * r.rate - r.amount) > 1.01) {
      bill.anomalies.push({
        sno: r.sno, kind: 'LINE_ARITHMETIC', raw: r.date_raw,
        detail: `${r.qty} × ${r.rate} = ${(r.qty * r.rate).toFixed(2)}, printed ${r.amount}`,
      });
    }
  }
  return bill;
}

function prevMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Read and parse in one step. */
export async function parsePumpBillPdf(data) {
  return parsePumpBill(await pdfLines(data));
}

// ── handing the invoice to the importer that already exists ─────────────────
//
// This file does ONE new thing: read the PDF. Everything after that — matching
// the lorry (including the narrow edit-distance-1 fuzzy match), routing the
// diesel by who owns the truck, posting through TARA, and parking what it will
// not trust in fuel_import_review — is already built in
// server/modules/fuelImport.routes.js and works. So the invoice is converted
// into exactly the rows that importer expects, and nothing here writes to a
// ledger or to a review queue.
//
// CONFIDENCE IS NOT OPTIMISM. A row is only 'OK' when the bill's own arithmetic
// closed AND that row carries no anomaly of its own. Everything else is handed
// over as REVIEW with the reason attached, so it lands on the Fuel Import
// Manual Verification screen instead of in the books.
export function toBulkImportRows(bill, { sourceFile = null } = {}) {
  const billOk = bill.check?.ok === true;
  const byRow = new Map();
  for (const a of bill.anomalies ?? []) {
    if (!byRow.has(a.sno)) byRow.set(a.sno, []);
    byRow.get(a.sno).push(a.kind);
  }

  return bill.rows.map((r) => {
    const flags = [...(byRow.get(r.sno) ?? [])];
    if (!billOk) flags.push('TOTAL_MISMATCH');
    if (r.qty != null && r.rate != null && r.amount != null
        && Math.abs(r.qty * r.rate - r.amount) > 1.01) {
      if (!flags.includes('LINE_ARITHMETIC')) flags.push('LINE_ARITHMETIC');
    }
    return {
      pump: bill.pump,
      company_hint: bill.buyer,
      source_file: sourceFile,
      date: r.date,
      vehicle_raw: r.vehicle_raw,
      vehicle_norm: r.vehicle_key,
      memo_no: r.slip_no,
      qty: r.qty,
      rate: r.rate,
      amount: r.amount,
      cash: null,
      confidence: flags.length === 0 ? 'OK' : 'REVIEW',
      flags,
    };
  });
}
