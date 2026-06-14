// 🤖 Mamta AI Scanner — 100% LOCAL document extraction via Gemma 4 vision.
// Replaces the old cloud OCR endpoint. Images go straight to the local model;
// PDFs are rendered to an image first with pdf.js (a bundled lib, not a service).

import { llmChat } from './llm';

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
 * fully on-device via Gemma 4 vision. Throws LLMOfflineError if Ollama is down.
 */
export async function extractLoadingSlip(file: File): Promise<ExtractedSlip> {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const imageB64 = isPdf ? await pdfFirstPageToBase64(file) : await fileToBase64(file);

  const res = await llmChat(
    [{ role: 'user', content: PROMPT, images: [imageB64] }],
    { format: 'json', temperature: 0 }
  );

  let parsed: any = {};
  try {
    parsed = JSON.parse(res.content);
  } catch {
    // defensive: strip markdown fences if the model wrapped the JSON
    const m = res.content.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : {};
  }

  const out: any = { _lowConfidence: [] };
  for (const f of FIELDS) {
    const v = String(parsed[f] ?? '').trim();
    out[f] = v;
    if (!v) out._lowConfidence.push(f);
  }
  return out as ExtractedSlip;
}
