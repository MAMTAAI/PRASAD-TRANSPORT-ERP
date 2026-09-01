// 🤖 Mamta AI Scanner — 100% LOCAL document extraction.
// Replaces the old cloud OCR endpoint. PDFs are rendered to an image first with
// pdf.js (a bundled lib, not a service), then Tesseract turns the page into
// text and DeepSeek parses it. Vision is the fallback, not the default.

import { llmChat } from './llm';
import { API_BASE } from './apiBase';

// Two models, because they do different jobs and are not interchangeable.
//   TEXT_MODEL   reads OCR output. deepseek-r1 is a reasoning text model.
//   VISION_MODEL reads pixels when OCR fails. MUST be multimodal; deepseek
//                cannot do this and returns an empty object rather than an
//                error, which is the worst way for it to fail.
// Overridable so a box with different models pulled can point at its own.
const TEXT_MODEL = (import.meta as any).env?.VITE_LLM_SCAN_TEXT_MODEL || 'deepseek-r1:8b';
const VISION_MODEL = (import.meta as any).env?.VITE_LLM_SCAN_VISION_MODEL || 'gemma4:12b';

export interface ExtractedSlip {
  challan_no: string;
  document_date: string;   // DD-MM-YYYY
  vehicle_no: string;
  driver_name: string;
  loading_point: string;
  consignee_name: string;
  product_type: string;    // HSD | MS | ATF | LPG
  loaded_qty: string;      // litres, plain number
  customer: string;
  _lowConfidence: string[]; // field keys the user should double-check (empty ones)
}

const FIELDS = ['challan_no', 'document_date', 'vehicle_no', 'driver_name', 'loading_point', 'consignee_name', 'product_type', 'loaded_qty', 'customer'] as const;

const PROMPT = `You are a logistics document parser for an Indian petroleum-transport company (products: HSD diesel, MS petrol, ATF, LPG; customers like IOCL/HPCL/BPCL).
Read the attached loading slip / invoice image and extract these fields. Reply with ONLY a JSON object, no prose:
{"challan_no":"","document_date":"DD-MM-YYYY","vehicle_no":"","driver_name":"","loading_point":"","consignee_name":"","product_type":"HSD|MS|ATF|LPG","loaded_qty":"","customer":""}
Rules:
- Use an empty string when a field is not present.
- vehicle_no: Indian plate format, uppercase, no spaces (e.g. AS01CC4567).
- loaded_qty: in LITRES as a plain integer (20.000 KL => 20000).
- challan_no: the invoice / SAP / document number (digits).
- product_type: one of HSD, MS, ATF, LPG.`;

export interface ExtractedDoc {
  document_number: string;
  expiry_date: string;   // DD-MM-YYYY
  issue_date: string;    // DD-MM-YYYY
  holder_name: string;
  _lowConfidence: string[];
}

const DOC_FIELDS = ['document_number', 'expiry_date', 'issue_date', 'holder_name'] as const;

/**
 * Extract a vehicle/driver document's key fields (number + validity) locally
 * via Gemma 4 vision. `docType` is a hint (e.g. 'Insurance', 'RC', 'DL', 'PUC').
 */
export async function extractDocument(file: File, docType = 'document'): Promise<ExtractedDoc> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const imageB64 = isPdf ? await pdfFirstPageToBase64(file) : await fileToBase64(file);
  const prompt = `You are parsing an Indian transport ${docType}. Extract these fields and reply with ONLY JSON, no prose:
{"document_number":"","expiry_date":"DD-MM-YYYY","issue_date":"DD-MM-YYYY","holder_name":""}
Rules: document_number is the policy/certificate/registration number (keep letters+digits). Dates as DD-MM-YYYY. Empty string if absent.`;
  // think:false is CRITICAL: on hard documents the reasoning mode can spend the
  // whole output budget "thinking" and return empty content (verified on real
  // IOCL bills). numCtx gives the vision prompt headroom over Ollama's default.
  let parsed: any = {};
  try {
    const res = await llmChat([{ role: 'user', content: prompt, images: [imageB64] }], { format: 'json', temperature: 0, think: false, numCtx: 8192 });
    try { parsed = JSON.parse(res.content); }
    catch { try { const m = res.content.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : {}; } catch { parsed = {}; } }
  } catch {
    // Local vision unreachable — fall through to the server. Deliberately not
    // rethrown here: see scanOnServer for why the browser is the wrong place to
    // insist on a local model.
    parsed = {};
  }

  const out: any = { _lowConfidence: [] };
  for (const f of DOC_FIELDS) { const v = String(parsed[f] ?? '').trim(); out[f] = v; if (!v) out._lowConfidence.push(f); }

  // A DEAD LOCAL MODEL MUST NOT MEAN "NO SCAN".
  //
  // llmChat talks to VITE_LLM_BASE_URL, which is baked at build time and is
  // http://localhost:11434 — i.e. the OPERATOR'S OWN PC, not the server. On the
  // production box nobody has Ollama running behind that address, so every scan
  // took the catch branch and every expiry date had to be typed by hand while
  // the button still said it would read the document.
  //
  // The API already has a scanner that needs no model at all: tesseract WASM
  // plus the pattern tables in docPatterns.js, which is what the phone has been
  // using all along. Use it whenever the local pass came back with nothing.
  if (!out.document_number && !out.expiry_date && !out.issue_date) {
    try { return await scanOnServer(file, out); } catch { /* keep the empty local result below */ }
  }
  return out as ExtractedDoc;
}

/**
 * Server-side extraction via POST /api/v1/scan — OCR + pattern tables, no LLM.
 * Returns the same ExtractedDoc shape so callers need no second branch.
 *
 * Dates come back ISO (YYYY-MM-DD); every caller runs them through its own
 * date formatter, which reads ISO and DD-MM-YYYY alike, so they are passed
 * through untouched rather than reformatted twice.
 */
async function scanOnServer(file: File, local: any): Promise<ExtractedDoc> {
  const form = new FormData();
  // `source` BEFORE the file: @fastify/multipart only exposes fields that
  // precede the file part, so a field appended after it is invisible server-side.
  form.append('source', 'erp-web');
  form.append('file', file, file.name || 'document');

  // THE HEADER IS THE WHOLE FEATURE. /api/v1/scan is not in apiGuard's public
  // list, so this call has been answering 401 since it was written — and the
  // 401 was invisible: extractDocument catches the throw and returns its empty
  // local result, so the screen reported "scan complete", filled nothing, and
  // every operator concluded the AI simply could not read Indian paperwork.
  //
  // The local Ollama pass cannot cover for it either. VITE_LLM_BASE_URL is
  // baked at build time as http://localhost:11434 — the OPERATOR'S OWN PC, not
  // the server — so on production the local pass always fails and this fallback
  // is the ONLY scanner there is. Unauthenticated, there was none at all.
  const token = (() => {
    try { return localStorage.getItem('prasad_token') || ''; } catch { return ''; }
  })();
  const res = await fetch(`${API_BASE}/api/v1/scan`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(body.detail || body.error || `Scan failed (HTTP ${res.status})`);
  }

  const expiry = String(body.expiry_date ?? '');
  // The issue date is not read separately by the pattern pass. The earliest
  // date on the page that is not the expiry is the honest best guess, and it
  // is reported as low-confidence so the operator checks it.
  const dates: string[] = Array.isArray(body.all_dates) ? [...body.all_dates].sort() : [];
  const issue = dates.find((d) => d && d !== expiry) ?? '';

  const out: any = {
    document_number: String(local?.document_number ?? ''),
    expiry_date: expiry,
    issue_date: issue,
    holder_name: String(local?.holder_name ?? ''),
    _lowConfidence: [] as string[],
  };
  for (const f of DOC_FIELDS) if (!out[f]) out._lowConfidence.push(f);
  // An uncued date is the parser's own doubt, not ours — surface it even when
  // a date WAS found, or a misread issue date walks in as an expiry unchecked.
  if (expiry && !body.expiry_cued && !out._lowConfidence.includes('expiry_date')) {
    out._lowConfidence.push('expiry_date');
  }
  return out as ExtractedDoc;
}

/**
 * Generic: run a custom JSON-extraction prompt over an image/PDF via LOCAL
 * Gemma 4 vision. Returns the parsed object (or {} on parse failure).
 */
export async function extractJsonFromImage(file: File, prompt: string): Promise<any> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const imageB64 = isPdf ? await pdfFirstPageToBase64(file) : await fileToBase64(file);
  const res = await llmChat([{ role: 'user', content: prompt, images: [imageB64] }], { format: 'json', temperature: 0, think: false, numCtx: 8192 });
  try { return JSON.parse(res.content); }
  catch { try { const m = res.content.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : {}; } catch { return {}; } }
}

/** Read a File as a base64 string (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}

/** Render PDF page 1 to a PNG base64 (no data: prefix) using pdf.js. */
async function pdfFirstPageToBase64(file: File): Promise<string> {
  const pdfjs: any = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

  const buf = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toDataURL('image/png').split(',')[1] || '';
}

/**
 * Extract structured fields from a loading slip / invoice (image or PDF),
 * fully on-device. Throws LLMOfflineError if Ollama is down.
 *
 * OCR FIRST, THEN DEEPSEEK. VISION ONLY IF OCR COMES BACK THIN.
 *
 * This used to hand the raw image to the model and let it read the pixels,
 * which only works on a MULTIMODAL model. gemma4 is one; deepseek-r1 and
 * deepseek-coder are not -- they are text models and will cheerfully return an
 * empty object when handed an image, with no error to notice. So "switch the
 * scanner to DeepSeek" cannot be a one-line model swap: it needs the pixels
 * turned into text first.
 *
 * Tesseract does that here, in the browser, which is the same shape as the
 * zero-cost pipeline SmartScanner.tsx already uses (Tesseract -> deepseek-r1).
 * Nothing leaves the machine either way.
 *
 * The vision path stays as the fallback for the case OCR genuinely cannot
 * handle -- a photographed slip at an angle, faint dot-matrix print -- where a
 * multimodal model still reads what Tesseract cannot. Below MIN_OCR_CHARS we
 * assume that is what happened.
 */
const MIN_OCR_CHARS = 120;

async function ocrToText(imageB64: string): Promise<string> {
  try {
    const { createWorker } = await import('tesseract.js');
    const worker = await createWorker('eng');
    try {
      const { data } = await worker.recognize(`data:image/png;base64,${imageB64}`);
      return (data.text || '').trim();
    } finally {
      await worker.terminate();
    }
  } catch {
    return '';   // OCR unavailable -> caller falls back to vision
  }
}

export async function extractLoadingSlip(file: File): Promise<ExtractedSlip> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const imageB64 = isPdf ? await pdfFirstPageToBase64(file) : await fileToBase64(file);

  const ocrText = await ocrToText(imageB64);
  const useText = ocrText.length >= MIN_OCR_CHARS;

  const res = useText
    ? await llmChat(
        [{ role: 'user', content: `${PROMPT}\n\nDocument text (OCR):\n"""\n${ocrText}\n"""` }],
        { format: 'json', temperature: 0, think: false, numCtx: 8192, model: TEXT_MODEL }
      )
    // Vision fallback: needs a multimodal model, so it must NOT inherit the
    // text model. Passing it explicitly keeps the two paths honest.
    : await llmChat(
        [{ role: 'user', content: PROMPT, images: [imageB64] }],
        { format: 'json', temperature: 0, think: false, numCtx: 8192, model: VISION_MODEL }
      );

  let parsed: any = {};
  try {
    parsed = JSON.parse(res.content);
  } catch {
    // defensive: strip markdown fences if the model wrapped the JSON
    try { const m = res.content.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : {}; } catch { parsed = {}; }
  }

  const out: any = { _lowConfidence: [] };
  for (const f of FIELDS) {
    const v = String(parsed[f] ?? '').trim();
    out[f] = v;
    if (!v) out._lowConfidence.push(f);
  }
  return out as ExtractedSlip;
}
