// 🤖 AI Bill Scanner engine — multi-page tabular extraction, 100% LOCAL via
// Ollama + Gemma vision. Handles freight invoices and HSD/pump bills arriving
// as multi-page PDFs, gallery images, or raw mobile-camera photos.
//
// Design rules (learned from the Phase-A audits):
// - One vision call PER PAGE (12B + one image + table fits the context window;
//   many images in one call silently truncates), rows merged across pages.
// - Output is SCHEMA-CONSTRAINED (Ollama `format: <JSON Schema>`) so the model
//   cannot reply with prose — no fragile regex-rescue parsing.
// - The model is never trusted with arithmetic: qty × rate is recomputed in
//   code, page sums are compared against the stated bill total, and every
//   suspicious field lands in `_review` for the human pass.
import { llmChat } from './llm';
import { toISODate, round2 } from './accounting/tripMath';
import { RX } from './validators';

export type BillKind = 'FREIGHT' | 'HSD';

export interface BillRow {
  page: number;
  vehicle_no: string;
  date: string;          // YYYY-MM-DD (normalized)
  qty: number;           // quantity as billed (litres for HSD; tonnes for LPG/IOCL)
  qty_unit: string;      // 'L' | 'TO' | '' (as detected from the bill)
  shortage: number;
  rate: number;          // ₹ per unit (per litre, or per tonne-km on RTD bills)
  rtd: number;           // round-trip distance km (IOCL tonne-km bills; 0 otherwise)
  gross_amount: number;  // ₹
  gst: number;           // ₹ total GST on this row (IGST+CGST+SGST)
  penalty: number;       // ₹ penalty/deduction column if present
  ref_no: string;        // challan / invoice / memo no for the row, if printed
  _review: string[];     // field names the human should verify
}

export interface BillHeader {
  bill_no: string;
  bill_date: string;     // YYYY-MM-DD
  party_name: string;
  gst_no: string;
  total_amount: number;  // grand total as printed on the bill
  total_gst: number;
}

export interface ExtractedBill {
  kind: BillKind;
  header: BillHeader;
  rows: BillRow[];
  pages: number;
  rowSum: number;            // Σ gross_amount recomputed in code
  totalMatches: boolean;     // rowSum ≈ header.total_amount (±₹10)
  warnings: string[];
}

// ── Page rendering ────────────────────────────────────────────────────────

const MAX_PDF_PAGES = 6;
const MAX_EDGE = 1600;

async function canvasToB64(canvas: HTMLCanvasElement): Promise<string> {
  // JPEG: camera photos compress 10x better than PNG with no OCR quality loss
  return canvas.toDataURL('image/jpeg', 0.85).split(',')[1] || '';
}

async function imageFileToB64(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) {
    // Unsupported encode — fall back to raw file bytes
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Could not read file'));
      r.readAsDataURL(file);
    });
  }
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvasToB64(canvas);
}

export interface PageImage { b64: string; label: string; }

/** Render every input (multi-page PDFs + photos) into a flat page list. */
export async function preparePages(files: File[], onProgress?: (msg: string) => void): Promise<PageImage[]> {
  const pages: PageImage[] = [];
  for (const file of files) {
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!isPdf) {
      onProgress?.(`Reading photo: ${file.name}`);
      pages.push({ b64: await imageFileToB64(file), label: file.name });
      continue;
    }
    const pdfjs: any = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const n = Math.min(pdf.numPages, MAX_PDF_PAGES);
    for (let i = 1; i <= n; i++) {
      onProgress?.(`Rendering ${file.name} — page ${i}/${pdf.numPages}`);
      const page = await pdf.getPage(i);
      const raw = page.getViewport({ scale: 1 });
      const scale = Math.min(2, MAX_EDGE / Math.max(raw.width, raw.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width; canvas.height = viewport.height;
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
      pages.push({ b64: await canvasToB64(canvas), label: `${file.name} p${i}` });
    }
    if (pdf.numPages > MAX_PDF_PAGES) {
      onProgress?.(`⚠️ ${file.name}: ${pdf.numPages} pages — only first ${MAX_PDF_PAGES} scanned`);
    }
  }
  return pages;
}

// ── Extraction ────────────────────────────────────────────────────────────

// Ollama grammar-constrains decoding to this schema — prose replies impossible.
const PAGE_SCHEMA = {
  type: 'object',
  properties: {
    bill_no: { type: 'string' },
    bill_date: { type: 'string' },
    party_name: { type: 'string' },
    gst_no: { type: 'string' },
    total_amount: { type: 'string' },
    total_gst: { type: 'string' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          vehicle_no: { type: 'string' },
          date: { type: 'string' },
          qty: { type: 'string' },
          shortage: { type: 'string' },
          rate: { type: 'string' },
          rtd: { type: 'string' },
          gross_amount: { type: 'string' },
          gst: { type: 'string' },
          penalty: { type: 'string' },
          ref_no: { type: 'string' },
        },
        // ALL fields required: Ollama's grammar constraint omits optional
        // properties entirely — required + "" forces the model to look at
        // every column (verified against real IOCL bills).
        required: ['vehicle_no', 'date', 'qty', 'shortage', 'rate', 'rtd', 'gross_amount', 'gst', 'penalty', 'ref_no'],
      },
    },
  },
  required: ['bill_no', 'bill_date', 'party_name', 'gst_no', 'total_amount', 'total_gst', 'rows'],
};

const KIND_HINT: Record<BillKind, string> = {
  FREIGHT: `This is a FREIGHT / TRANSPORTATION BILL from an Indian oil-company contract (IOCL/HPCL/BPCL "Transportation Bill" format). The table lists one trip per row with columns like: SNo, Invoice No, Date, Ship-to-party, Material, Quantity (in TO tonnes or KL), Shortage, RTD (round-trip distance km), RATE, Gross Amt, Penalty Amt, IGST, CGST, S/UGST.
IMPORTANT LAYOUT NOTES:
- The tanker vehicle number (e.g. AS26C5105) often appears as a GROUP HEADER line ABOVE its rows, followed by "Subtotal for Vehicle" — assign that vehicle number to every row in its group.
- RTD and RATE each spread across three sub-columns (P / H / HH) — take the FIRST non-zero value of each.
- Do NOT swap RTD and RATE: RTD is the BIG kilometre figure (e.g. 2,520.0); RATE is the SMALL per-tonne-km figure (e.g. 3.432495).
- gst for a row = IGST + CGST + S/UGST added together.
- Copy the Penalty column into penalty when present.`,
  HSD: `This is a PETROL-PUMP (HSD diesel) invoice from an Indian fuel station. The table lists one fuel issue per row with columns like: Date, Vehicle No, Product, Memo No, Qnty/Ltr, Rate, Amount, Cash, Total Amount. A row's values may wrap onto two printed lines — treat them as ONE row.
- Skip "R/O" (round-off) and "Total" lines — they have no vehicle number.
- Vehicle numbers may contain dashes (AS-26C-5108) — copy as printed.`,
};

function pagePrompt(kind: BillKind): string {
  return `${KIND_HINT[kind]}
Extract the bill header fields (empty string when not on this page) and EVERY table row visible on this page.
Rules:
- bill_no is the INVOICE/BILL NUMBER (may contain letters and slashes, e.g. SKSC/386/26-27 or 11024699AS26062) — never a date.
- vehicle_no: Indian tanker plate as printed (dashes/spaces OK).
- Rows without a vehicle number (Subtotal / Total / R.O. / carried-forward lines): SKIP them.
- date: as printed (17.06.2026, DD-MM-YYYY, DD/MM/YY — any format).
- qty and shortage: number as printed WITH its unit if shown (e.g. "17.660 TO", "20.5 KL", "160").
- rate, rtd, gross_amount, gst, penalty, total_amount, total_gst: plain numbers only — strip ₹ signs and Indian commas (1,56,281.00 => 156281.00).
- total_amount: the GRAND total ("Total of All Bills" / "Invoice Total Amount") — the largest total on the bill, not a subtotal.
- Do NOT calculate anything. Copy the printed values exactly.
- Do NOT invent rows. Fewer correct rows beat guessed rows.`;
}

const num = (v: any): number => {
  const n = parseFloat(String(v ?? '').replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/** Parse a billed quantity with its unit. "20.5 KL" → {20500, 'L'};
 *  "17.660 TO" → {17.66, 'TO'} (IOCL tonne bills); "160" → {160, ''}. */
export function parseQty(v: any): { qty: number; unit: string } {
  const s = String(v ?? '').trim();
  const n = num(s);
  if (/\bkl\b/i.test(s)) return { qty: round2(n * 1000), unit: 'L' };
  if (/\b(to|mt|ton(ne)?s?)\b/i.test(s)) return { qty: round2(n), unit: 'TO' };
  if (/\b(l|ltr|litre?s?)\b/i.test(s)) return { qty: round2(n), unit: 'L' };
  return { qty: round2(n), unit: '' };
}

/** Legacy litre coercion for matching against trip loaded_qty fields. */
function toLitres(v: any): number {
  const s = String(v ?? '').trim();
  const n = num(s);
  if (/\bkl\b/i.test(s) || (n > 0 && n < 100 && /\./.test(s))) return round2(n * 1000);
  return round2(n);
}

function cleanPlate(v: any): string {
  return String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeRow(raw: any, page: number, kind: BillKind): BillRow | null {
  const vehicle = cleanPlate(raw.vehicle_no);
  if (!vehicle) return null;
  const review: string[] = [];
  if (!RX.vehicleNo.test(vehicle)) review.push('vehicle_no');

  const date = toISODate(raw.date);
  if (!date) review.push('date');

  const q = parseQty(raw.qty);
  const qty = q.qty;
  const shortage = parseQty(raw.shortage).qty;
  const rate = round2(num(raw.rate));
  const rtd = round2(num(raw.rtd));
  let gross = round2(num(raw.gross_amount));
  const gst = round2(num(raw.gst));
  const penalty = round2(num(raw.penalty));
  if (qty <= 0) review.push('qty');
  if (rate <= 0) review.push('rate');

  // Arithmetic check in CODE (never trust model math). Indian transport bills
  // use three bases, verified against real samples:
  //   HSD pump:       gross = litres × rate                (e.g. 160 × 100.18)
  //   Freight per-KL: gross = (litres/1000) × rate
  //   IOCL tonne-km:  gross = qty(TO) × RTD(km) × rate     (17.660 × 1503 × 3.432495)
  if (qty > 0 && rate > 0) {
    const bases = [round2(qty * rate), round2((qty / 1000) * rate)];
    if (rtd > 0) bases.push(round2(qty * rtd * rate));
    const matches = (b: number) => gross > 0 && Math.abs(b - gross) <= Math.max(1, gross * 0.005);
    if (!bases.some(matches)) {
      if (gross <= 0) gross = rtd > 0 ? round2(qty * rtd * rate) : (kind === 'FREIGHT' ? round2((qty / 1000) * rate) : round2(qty * rate));
      else review.push('gross_amount');
    }
  } else if (gross <= 0) review.push('gross_amount');

  return { page, vehicle_no: vehicle, date, qty, qty_unit: q.unit, shortage, rate, rtd, gross_amount: gross, gst, penalty, ref_no: String(raw.ref_no ?? '').trim(), _review: review };
}

/** Run the full multi-page extraction. Throws LLMOfflineError if Ollama is down. */
export async function extractBill(
  files: File[],
  kind: BillKind,
  onProgress?: (msg: string) => void
): Promise<ExtractedBill> {
  const pages = await preparePages(files, onProgress);
  if (!pages.length) throw new Error('No readable pages in the selected files');

  const header: BillHeader = { bill_no: '', bill_date: '', party_name: '', gst_no: '', total_amount: 0, total_gst: 0 };
  const rows: BillRow[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < pages.length; i++) {
    onProgress?.(`🤖 Mamta AI reading page ${i + 1}/${pages.length}…`);
    const res = await llmChat(
      [{ role: 'user', content: pagePrompt(kind), images: [pages[i].b64] }],
      { format: PAGE_SCHEMA, temperature: 0, numCtx: 8192, think: false }
    );
    let parsed: any = {};
    try { parsed = JSON.parse(res.content); }
    catch {
      try { const m = res.content.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : {}; }
      catch { parsed = {}; }
    }
    if (!parsed.rows?.length) warnings.push(`Page ${i + 1} (${pages[i].label}): no table rows found`);

    // Header: first page wins; later pages only fill gaps.
    if (!header.bill_no && parsed.bill_no) header.bill_no = String(parsed.bill_no).trim();
    if (!header.bill_date && parsed.bill_date) header.bill_date = toISODate(parsed.bill_date);
    if (!header.party_name && parsed.party_name) header.party_name = String(parsed.party_name).trim();
    if (!header.gst_no && parsed.gst_no) header.gst_no = String(parsed.gst_no).toUpperCase().trim();
    if (num(parsed.total_amount) > header.total_amount) header.total_amount = round2(num(parsed.total_amount));
    if (num(parsed.total_gst) > header.total_gst) header.total_gst = round2(num(parsed.total_gst));

    for (const r of parsed.rows || []) {
      const row = normalizeRow(r, i + 1, kind);
      if (row) rows.push(row);
    }
  }

  const rowSum = round2(rows.reduce((s, r) => s + r.gross_amount, 0));
  const totalMatches = header.total_amount > 0 ? Math.abs(rowSum - header.total_amount) <= 10 : true;
  if (header.total_amount > 0 && !totalMatches) {
    warnings.push(`Row total ₹${rowSum.toLocaleString('en-IN')} ≠ bill total ₹${header.total_amount.toLocaleString('en-IN')} — a page or rows may be missing/misread`);
  }
  return { kind, header, rows, pages: pages.length, rowSum, totalMatches, warnings };
}

// ── Document classification (multi-schema router) ─────────────────────────
// Every oil company ships a different format. Mamta AI first CLASSIFIES the
// document from text cues (instant, free), falling back to an LLM call only
// when heuristics don't fire — then routes to the right extraction schema.

export type DocKind =
  | 'IOCL_STATEMENT'     // XTRAPOWER monthly card statement
  | 'HPCL_DRIVETRACK'    // DriveTrack Plus account statement
  | 'BPCL_STATEMENT'     // Hello Fleet / SmartFleet account statement
  | 'BPCL_FREIGHT_BILL'  // AP210 transportation bill (freight + TDS/Loss/FLEET CARD DEBIT)
  | 'IOCL_FREIGHT_BILL'  // IOCL Transportation Bill (tonne-km, Subtotal for Vehicle)
  | 'HSD_PUMP_BILL'      // local petrol pump invoice
  | 'UNKNOWN';

/** Extract the first page's text layer (empty string for scans/photos). */
export async function firstPageText(file: File): Promise<string> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) return '';
  try {
    const pdfjs: any = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const tc = await (await pdf.getPage(1)).getTextContent();
    return tc.items.map((i: any) => i.str).join(' ');
  } catch { return ''; }
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: { kind: { type: 'string', enum: ['IOCL_STATEMENT', 'HPCL_DRIVETRACK', 'BPCL_STATEMENT', 'BPCL_FREIGHT_BILL', 'IOCL_FREIGHT_BILL', 'HSD_PUMP_BILL', 'UNKNOWN'] } },
  required: ['kind'],
};

/** Classify a document. Heuristics first; LLM only as fallback. */
export async function classifyDocument(file: File): Promise<DocKind> {
  const text = await firstPageText(file);
  if (text) {
    if (/XTRAPOWER/i.test(text)) return 'IOCL_STATEMENT';
    if (/Drive\s*Track/i.test(text)) return 'HPCL_DRIVETRACK';
    if (/FLEET CARD DEBIT|AP\s?210|Clearing Document/i.test(text)) return 'BPCL_FREIGHT_BILL';
    if (/Hello\s*Fleet|SMARTFLEET/i.test(text)) return 'BPCL_STATEMENT';
    if (/Subtotal for Vehicle|Transportation Bill/i.test(text) && /RTD|IGST/i.test(text)) return 'IOCL_FREIGHT_BILL';
    if (/Qnty\/?Ltr|SERVICE CENTRE|SERVICE STATION|FILLING STATION|Petrol Pump/i.test(text) && /HSD|Diesel/i.test(text)) return 'HSD_PUMP_BILL';
  }
  // Fallback: ask the model (text when available, vision for photos)
  try {
    const prompt = `Classify this Indian transport/fuel document into exactly one kind:
IOCL_STATEMENT (XTRAPOWER card statement) | HPCL_DRIVETRACK (DriveTrack Plus statement) | BPCL_STATEMENT (Hello Fleet/SmartFleet statement) | BPCL_FREIGHT_BILL (AP210 transportation bill with Gross Amount/TDS Recovery/Loss Recovery/FLEET CARD DEBIT) | IOCL_FREIGHT_BILL (IOCL transportation bill, tonne-km) | HSD_PUMP_BILL (local petrol pump diesel invoice) | UNKNOWN`;
    const msg = text
      ? { role: 'user' as const, content: `${prompt}\n\nDOCUMENT TEXT (first page):\n${text.slice(0, 4000)}` }
      : { role: 'user' as const, content: prompt, images: [(await preparePages([file]))[0]?.b64].filter(Boolean) as string[] };
    const res = await llmChat([msg], { format: CLASSIFY_SCHEMA, temperature: 0, numCtx: 8192, think: false });
    const parsed = JSON.parse(res.content);
    return (parsed.kind as DocKind) || 'UNKNOWN';
  } catch { return 'UNKNOWN'; }
}

// ── BPCL AP210 Transportation Bill (freight + deductions + card debit) ─────

export interface BpclFreightBill {
  vendor_code: string;
  clearing_doc: string;
  clearing_date: string;   // YYYY-MM-DD
  period: string;
  gross_amount: number;    // total freight credited
  tds_recovery: number;    // -> TDS Receivable ledger
  loss_recovery: number;   // total debits (INCLUDES fleet_card_debit — SAP lumps them)
  fleet_card_debit: number;// -> Fleet Card wallet RECHARGE
  net_payable: number;     // lands in bank
  rows: BillRow[];         // freight rows, reusing the BillRow shape for matching/filing
  lossRows: { date: string; vehicle_no: string; detail: string; amount: number }[];
  warnings: string[];
  checks: { label: string; ok: boolean; detail: string }[];
}

const BPCL_SCHEMA = {
  type: 'object',
  properties: {
    vendor_code: { type: 'string' },
    clearing_doc: { type: 'string' },
    clearing_date: { type: 'string' },
    period: { type: 'string' },
    gross_amount: { type: 'string' },
    tds_recovery: { type: 'string' },
    loss_recovery: { type: 'string' },
    net_payable: { type: 'string' },
    fleet_card_debit: { type: 'string' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          row_type: { type: 'string', enum: ['FREIGHT', 'LOSS_RECOVERY', 'FLEET_CARD_DEBIT'] },
          date: { type: 'string' },
          ship_no: { type: 'string' },
          vehicle_no: { type: 'string' },
          destination: { type: 'string' },
          qty: { type: 'string' },
          rate: { type: 'string' },
          distance: { type: 'string' },
          credit_amount: { type: 'string' },
          debit_amount: { type: 'string' },
        },
        required: ['row_type', 'date', 'ship_no', 'vehicle_no', 'destination', 'qty', 'rate', 'distance', 'credit_amount', 'debit_amount'],
      },
    },
  },
  required: ['vendor_code', 'clearing_doc', 'clearing_date', 'period', 'gross_amount', 'tds_recovery', 'loss_recovery', 'net_payable', 'fleet_card_debit', 'rows'],
};

const BPCL_HINT = `This is a BPCL "AP210" TRANSPORTATION BILL / clearing statement (SAP format) for a transport vendor.
Header: "AP210 for Vendor <code> for <MM/YYYY>" => vendor_code and period; Clearing Document Number => clearing_doc; Clearing Date => clearing_date; Gross Amount; TDS Recovery; Loss Recovery; Net Amount Payable.
Table columns: DtOfDesp (DD-MM-YYYY), Ship.No, Tpp/Consgn, Veh.No. (e.g. NL01AD0831 — may be prefixed by a Tpp code like "1226"), Cust/Plant name (e.g. GUWAHATI AFS), Product, Prod.Qty, Rate, Distance, CreditAmount, DebitAmount.
Row typing:
- Normal trip rows (CreditAmount > 0) => row_type FREIGHT, credit_amount = CreditAmount.
- Rows whose Cust/Plant text contains "Loss Rec" (DebitAmount > 0) => row_type LOSS_RECOVERY, debit_amount = DebitAmount.
- The row whose Veh.No./description says "FLEET CARD DEBIT" => row_type FLEET_CARD_DEBIT, debit_amount = that amount; ALSO copy that amount into the header field fleet_card_debit.
Rules: numbers plain (strip commas). vehicle_no = only the vehicle registration (drop the leading Tpp code). Do NOT calculate. Do NOT invent rows.`;

export async function extractBpclFreightBill(file: File, onProgress?: (m: string) => void): Promise<BpclFreightBill> {
  onProgress?.('Reading BPCL AP210 bill…');
  const text = await firstPageText(file);
  const msg = text
    ? { role: 'user' as const, content: `${BPCL_HINT}\nExtract header + EVERY row.\n\nBILL TEXT:\n${text}` }
    : { role: 'user' as const, content: BPCL_HINT + '\nExtract header + EVERY row.', images: [(await preparePages([file], onProgress))[0]?.b64].filter(Boolean) as string[] };
  onProgress?.('🤖 Mamta AI reading AP210 bill…');
  const res = await llmChat([msg], { format: BPCL_SCHEMA, temperature: 0, numCtx: 16384, think: false });

  let parsed: any = {};
  try { parsed = JSON.parse(res.content); }
  catch { try { const m = res.content.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : {}; } catch { parsed = {}; } }

  const bill: BpclFreightBill = {
    vendor_code: String(parsed.vendor_code ?? '').trim(),
    clearing_doc: String(parsed.clearing_doc ?? '').trim(),
    clearing_date: toISODate(parsed.clearing_date),
    period: String(parsed.period ?? '').trim(),
    gross_amount: round2(num(parsed.gross_amount)),
    tds_recovery: round2(num(parsed.tds_recovery)),
    loss_recovery: round2(num(parsed.loss_recovery)),
    fleet_card_debit: round2(num(parsed.fleet_card_debit)),
    net_payable: round2(num(parsed.net_payable)),
    rows: [], lossRows: [], warnings: [], checks: [],
  };

  for (const r of parsed.rows || []) {
    const vehicle = cleanPlate(String(r.vehicle_no ?? '').replace(/^1?\d{3}\s*/, '')); // strip Tpp prefix remnants
    const date = toISODate(r.date);
    if (r.row_type === 'FLEET_CARD_DEBIT' || /FLEETCARDDEBIT/.test(cleanPlate(r.vehicle_no) + cleanPlate(r.destination))) {
      const amt = round2(num(r.debit_amount) || num(r.credit_amount));
      if (amt > 0 && !bill.fleet_card_debit) bill.fleet_card_debit = amt;
      continue;
    }
    if (r.row_type === 'LOSS_RECOVERY' || /Loss Rec/i.test(String(r.destination ?? ''))) {
      const amt = round2(num(r.debit_amount));
      if (amt > 0) bill.lossRows.push({ date, vehicle_no: vehicle, detail: String(r.destination ?? '').trim().slice(0, 60), amount: amt });
      continue;
    }
    const credit = round2(num(r.credit_amount));
    if (credit <= 0 || !vehicle) continue;
    const review: string[] = [];
    if (!RX.vehicleNo.test(vehicle)) review.push('vehicle_no');
    if (!date) review.push('date');
    bill.rows.push({
      page: 1, vehicle_no: vehicle, date, qty: round2(num(r.qty)), qty_unit: '',
      shortage: 0, rate: round2(num(r.rate)), rtd: round2(num(r.distance)),
      gross_amount: credit, gst: 0, penalty: 0,
      ref_no: String(r.ship_no ?? '').trim(), _review: review,
    });
  }

  // Code-side verification (never trust model math)
  const rowSum = round2(bill.rows.reduce((s, r) => s + r.gross_amount, 0));
  const grossOk = bill.gross_amount > 0 ? Math.abs(rowSum - bill.gross_amount) <= Math.max(10, bill.gross_amount * 0.005) : true;
  bill.checks.push({ label: 'Σ freight rows = Gross Amount', ok: grossOk, detail: `${rowSum.toLocaleString('en-IN')} vs ${bill.gross_amount.toLocaleString('en-IN')}` });
  const netCalc = round2(bill.gross_amount - bill.tds_recovery - bill.loss_recovery);
  const netOk = Math.abs(netCalc - bill.net_payable) <= 1;
  bill.checks.push({ label: 'Gross − TDS − Loss Recovery = Net Payable', ok: netOk, detail: `${netCalc.toLocaleString('en-IN')} vs ${bill.net_payable.toLocaleString('en-IN')}` });
  if (bill.fleet_card_debit > bill.loss_recovery) bill.warnings.push('FLEET CARD DEBIT loss-recovery total se bada hai — figures verify karein.');
  if (!grossOk) bill.warnings.push('Freight rows ka total Gross se match nahi hua — kuch rows missing/misread ho sakti hain.');
  if (!netOk) bill.warnings.push('Header ka net math tally nahi hua — bill dhyaan se verify karein.');
  return bill;
}

// ── Trip / fuel-entry matching ────────────────────────────────────────────

export type MatchStatus = 'MATCHED' | 'AMBIGUOUS' | 'UNMATCHED';
export interface RowMatch {
  status: MatchStatus;
  targetId: string;        // chosen doc id ('' when unmatched)
  candidates: { id: string; label: string; score: number }[];
}

const dayDiff = (a: string, b: string): number => {
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  if (isNaN(ta) || isNaN(tb)) return 99;
  return Math.abs(ta - tb) / 86400000;
};

/** Match extracted rows against TRIPS by vehicle + date proximity (+qty). */
export function matchRowsToTrips(rows: BillRow[], trips: any[]): RowMatch[] {
  const indexed = trips.map(t => ({
    t,
    plate: cleanPlate(t.vehicle_no || t.Vehical_No || t.vehical_no),
    date: toISODate(t.start_date || t.Loading_Date || t.loading_date || t.created_at),
    qty: toLitres(t.loaded_qty || t.Loaded_Qty || t.driver_loaded_qty),
  }));
  return rows.map(row => {
    const cands = indexed
      .filter(x => x.plate && x.plate === row.vehicle_no)
      .map(x => {
        const dd = row.date && x.date ? dayDiff(row.date, x.date) : 99;
        let score = dd <= 1 ? 100 : dd <= 3 ? 70 : dd <= 7 ? 40 : 5;
        // Unit-aware qty bonus: bills may state TO/KL while trips store litres/kg
        const rowQ = row.qty_unit === 'TO' || row.qty_unit === 'L' ? row.qty : row.qty;
        const variants = [rowQ, rowQ * 1000];
        if (rowQ > 0 && x.qty > 0 && variants.some(v => Math.abs(v - x.qty) / v < 0.05)) score += 30;
        return { id: x.t.id, label: `${x.t.trip_id || x.t.Trip_ID || x.t.id} · ${x.date || 'no date'} · ${x.qty ? x.qty + 'L' : '?'}`, score };
      })
      .filter(c => c.score > 20)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (!cands.length) return { status: 'UNMATCHED' as MatchStatus, targetId: '', candidates: [] };
    if (cands.length === 1 || cands[0].score - cands[1].score >= 30) {
      return { status: 'MATCHED' as MatchStatus, targetId: cands[0].id, candidates: cands };
    }
    return { status: 'AMBIGUOUS' as MatchStatus, targetId: cands[0].id, candidates: cands };
  });
}

/** Match extracted HSD rows against FUEL_ENTRIES by vehicle + date + litres. */
export function matchRowsToFuelEntries(rows: BillRow[], entries: any[]): RowMatch[] {
  const indexed = entries.map(f => ({
    f,
    plate: cleanPlate(f.vehicle_no),
    date: toISODate(f.date),
    litres: round2(num(f.liters)),
  }));
  return rows.map(row => {
    const cands = indexed
      .filter(x => x.plate && x.plate === row.vehicle_no)
      .map(x => {
        const dd = row.date && x.date ? dayDiff(row.date, x.date) : 99;
        let score = dd <= 1 ? 100 : dd <= 3 ? 60 : 10;
        if (row.qty > 0 && x.litres > 0 && Math.abs(row.qty - x.litres) <= Math.max(2, row.qty * 0.02)) score += 40;
        return { id: x.f.id, label: `${x.f.memo_no || x.f.id} · ${x.date} · ${x.litres}L`, score };
      })
      .filter(c => c.score > 30)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    if (!cands.length) return { status: 'UNMATCHED' as MatchStatus, targetId: '', candidates: [] };
    if (cands.length === 1 || cands[0].score - cands[1].score >= 30) {
      return { status: 'MATCHED' as MatchStatus, targetId: cands[0].id, candidates: cands };
    }
    return { status: 'AMBIGUOUS' as MatchStatus, targetId: cands[0].id, candidates: cands };
  });
}
