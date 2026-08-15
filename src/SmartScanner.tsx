// 📸 SMART DOCUMENT SCANNER — native PWA scanner for the zero-cost OCR pipeline
// (Tesseract + local DeepSeek via AGENT_04 BHUVANESHWARI; no paid APIs).
//
//   Mobile driver  → WebRTC camera, tap to capture, auto-crop + enhance
//   Desktop admin  → glowing dropzone, multi-file, multi-page PDF
//   Both           → live preprocess preview → upload → extraction + filing
//                    verdict → HITL review queue with 1-click approve
//
// PDFs are rasterised CLIENT-SIDE (pdfjs-dist, already in the bundle for the
// bill scanner) so the server pipeline only ever sees clean page images.
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { API_BASE } from './lib/apiBase';
const API = API_BASE;

const C = {
  bg: '#0f172a', card: 'rgba(30,41,59,0.55)', line: '#334155', dim: '#94a3b8',
  text: '#e2e8f0', ok: '#10b981', warn: '#f59e0b', bad: '#ef4444', purple: '#c084fc', blue: '#38bdf8',
};

// ═══════════════════════════════════════════════════════════════════════════
// Canvas preprocessing — the "CamScanner feel", entirely client-side.
//   1. downscale to a sane OCR size (long edge 1600px)
//   2. grayscale + contrast stretch (2%..98% percentile window)
//   3. document bounding-box detection on the darkened-pixel mask → auto-crop
// ═══════════════════════════════════════════════════════════════════════════
function preprocess(source: HTMLImageElement | HTMLCanvasElement): HTMLCanvasElement {
  const MAX = 1600;
  const sw = source.width, sh = source.height;
  const scale = Math.min(1, MAX / Math.max(sw, sh));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, w, h);

  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  // grayscale + histogram
  const hist = new Array(256).fill(0);
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0; i < px.length; i += 4) {
    const g = Math.round(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
    gray[i / 4] = g;
    hist[g]++;
  }
  // percentile window for contrast stretch
  const total = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (let g = 0; g < 256; g++) { acc += hist[g]; if (acc >= total * 0.02) { lo = g; break; } }
  acc = 0;
  for (let g = 255; g >= 0; g--) { acc += hist[g]; if (acc >= total * 0.02) { hi = g; break; } }
  const range = Math.max(hi - lo, 1);

  // stretched grayscale back into the canvas + build dark-pixel mask bounds
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(((gray[i] - lo) / range) * 255)));
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
    if (v < 128) { // ink
      const x = i % w, y = (i / w) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  ctx.putImageData(img, 0, 0);

  // auto-crop to the detected document region (with margin), if a sane box found
  const boxW = maxX - minX, boxH = maxY - minY;
  if (boxW > w * 0.25 && boxH > h * 0.25) {
    const m = Math.round(Math.max(w, h) * 0.02);
    const cx = Math.max(0, minX - m), cy = Math.max(0, minY - m);
    const cw = Math.min(w - cx, boxW + 2 * m), ch = Math.min(h - cy, boxH + 2 * m);
    const cropped = document.createElement('canvas');
    cropped.width = cw; cropped.height = ch;
    cropped.getContext('2d')!.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
    return cropped;
  }
  return canvas;
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
}

async function fileToImage(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(file);
  });
}

/** Rasterise every PDF page to a canvas (client-side, pdfjs-dist). */
async function pdfToCanvases(file: File): Promise<HTMLCanvasElement[]> {
  const pdfjs = await import('pdfjs-dist');
  // Vite worker wiring — same approach the bill scanner uses.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const out: HTMLCanvasElement[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 10); p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width; canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
    out.push(canvas);
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// UI atoms
// ═══════════════════════════════════════════════════════════════════════════
const Badge = ({ text, color }: { text: string; color: string }) => (
  <span style={{ fontSize: 10, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 10, padding: '1px 8px' }}>{text}</span>
);

function ResultCard({ r }: { r: any }) {
  const conf = r.confidence?.effective ?? 0;
  const confColor = conf >= 0.9 ? C.ok : conf >= 0.6 ? C.warn : C.bad;
  const FIELDS = ['invoice_no', 'gstin', 'vehicle_no', 'driver_name', 'freight_amount', 'hsd_litres', 'date', 'consignee'];
  return (
    <div style={{ background: '#0b1220', border: `1px solid ${C.line}`, borderLeft: `3px solid ${confColor}`, borderRadius: 10, padding: 12, fontSize: 12, color: C.text }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        <Badge text={r.page ? `PAGE ${r.page}` : 'SCAN'} color={C.dim} />
        <Badge text={r.doc_type ?? '…'} color={C.blue} />
        {r.confidence && <Badge text={`${Math.round(conf * 100)}%`} color={confColor} />}
        {r.filing?.auto_filed
          ? <Badge text="✔ AUTO-FILED" color={C.ok} />
          : r.doc_type === 'PENDING_EXTRACTION'
            ? <Badge text="⏸ PARKED (AI offline)" color={C.warn} />
            : <Badge text={r.duplicate ? 'DUPLICATE' : '⚠ REVIEW'} color={C.warn} />}
      </div>
      <table style={{ fontSize: 11 }}><tbody>
        {FIELDS.filter((k) => r.fields?.[k] !== undefined && r.fields?.[k] !== '').map((k) => (
          <tr key={k}>
            <td style={{ color: C.dim, paddingRight: 10 }}>{k}</td>
            <td>{String(r.fields[k])}</td>
            <td style={{ paddingLeft: 8 }}>
              {r.validation?.[k === 'vehicle_no' ? 'vehicle' : k === 'driver_name' ? 'driver' : k]?.ok === true && <span style={{ color: C.ok }}>✔ DB</span>}
              {r.validation?.[k === 'vehicle_no' ? 'vehicle' : k === 'driver_name' ? 'driver' : k]?.ok === false && <span style={{ color: C.bad }}>✖</span>}
            </td>
          </tr>
        ))}
      </tbody></table>
      <div style={{ color: C.dim, fontSize: 10, marginTop: 6 }}>{r.filing?.reason} · {r.engine ?? ''} · {r.ms}ms</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HITL review queue — the Admin Dashboard warning list with 1-click resolve.
// ═══════════════════════════════════════════════════════════════════════════
function ReviewQueue() {
  const [queue, setQueue] = useState<any[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/v1/documents/review-queue`);
      if (res.ok) setQueue((await res.json()).data ?? []);
    } catch { /* API offline — the scanner section already shows that */ }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const resolve = async (id: string, action: 'approve' | 'reject', fields?: any) => {
    setBusy(id);
    try {
      let corrections = {};
      if (action === 'approve' && fields) {
        // 1-click default; a prompt only when the operator wants to fix a field.
        const fix = window.prompt('Corrections as field=value, comma-separated (blank = accept as-is):', '');
        if (fix) {
          corrections = Object.fromEntries(fix.split(',').map((p) => p.split('=').map((x) => x.trim())).filter((p) => p.length === 2));
        }
      }
      const res = await fetch(`${API}/api/v1/documents/${id}/review`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, reviewer: localStorage.getItem('pt_user_name') ?? 'ADMIN', corrections }),
      });
      if (!res.ok) alert(`Review failed: ${(await res.json()).detail ?? res.status}`);
      load();
    } finally { setBusy(null); }
  };

  if (!queue.length) return null;
  return (
    <div style={{ background: C.card, border: `1px dashed ${C.warn}`, borderRadius: 16, padding: 16, marginTop: 18 }}>
      <h3 style={{ color: C.warn, margin: '0 0 10px' }}>⚠ Human Review Queue ({queue.length})</h3>
      {queue.map((d) => (
        <div key={d.id} style={{ display: 'flex', gap: 10, alignItems: 'center', borderTop: `1px solid ${C.line}`, padding: '8px 0', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 220, fontSize: 12, color: C.text }}>
            <Badge text={d.doc_type} color={C.blue} />{' '}
            <span style={{ color: C.dim }}>{d.original_name ?? d.id.slice(0, 8)}</span>
            <div style={{ fontSize: 11, color: C.dim, marginTop: 2 }}>
              {['vehicle_no', 'invoice_no', 'freight_amount', 'hsd_litres', 'date']
                .filter((k) => d.fields?.[k]).map((k) => `${k}: ${d.fields[k]}`).join(' · ') || 'no fields extracted'}
              {d.confidence !== null && ` · conf ${Math.round(Number(d.confidence) * 100)}%`}
            </div>
          </div>
          <button disabled={busy === d.id} onClick={() => resolve(d.id, 'approve', d.fields)}
            style={{ padding: '6px 14px', background: 'transparent', color: C.ok, border: `1px solid ${C.ok}`, borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 11 }}>
            ✔ APPROVE & FILE
          </button>
          <button disabled={busy === d.id} onClick={() => resolve(d.id, 'reject')}
            style={{ padding: '6px 14px', background: 'transparent', color: C.bad, border: `1px solid ${C.bad}`, borderRadius: 8, cursor: 'pointer', fontWeight: 700, fontSize: 11 }}>
            ✖ REJECT
          </button>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Main scanner
// ═══════════════════════════════════════════════════════════════════════════
export default function SmartScanner() {
  const [mode, setMode] = useState<'idle' | 'camera'>('idle');
  const [drag, setDrag] = useState(false);
  const [busyMsg, setBusyMsg] = useState<string | null>(null);
  const [previews, setPreviews] = useState<string[]>([]);
  const [results, setResults] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setMode('idle');
  }, []);
  useEffect(() => () => stopCamera(), [stopCamera]);

  const startCamera = async () => {
    setError(null);
    try {
      // Rear camera on phones; any camera on desktop.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      streamRef.current = stream;
      setMode('camera');
      // ref mounts after render
      setTimeout(() => { if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play(); } }, 50);
    } catch (e: any) {
      setError(`Camera unavailable: ${e.message}`);
    }
  };

  const uploadCanvas = async (canvas: HTMLCanvasElement, name: string, page?: number) => {
    const processed = preprocess(canvas);
    setPreviews((p) => [...p.slice(-3), processed.toDataURL('image/jpeg', 0.6)]);
    const blob = await canvasToBlob(processed);
    const form = new FormData();
    form.append('file', blob, name);
    const res = await fetch(`${API}/api/v1/documents/auto-scan-file`, { method: 'POST', body: form });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || json.error || `HTTP ${res.status}`);
    setResults((r) => [{ ...json, page }, ...r].slice(0, 12));
  };

  const capture = async () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d')!.drawImage(video, 0, 0);
    stopCamera();
    setBusyMsg('Enhancing & scanning…');
    try { await uploadCanvas(canvas, `camera-${Date.now()}.png`); }
    catch (e: any) { setError(e.message); }
    finally { setBusyMsg(null); }
  };

  const handleFiles = async (files: FileList | File[]) => {
    setError(null);
    for (const file of Array.from(files)) {
      try {
        if (file.type === 'application/pdf') {
          setBusyMsg(`Rasterising PDF ${file.name}…`);
          const pages = await pdfToCanvases(file);
          for (let i = 0; i < pages.length; i++) {
            setBusyMsg(`Scanning ${file.name} — page ${i + 1}/${pages.length}…`);
            await uploadCanvas(pages[i], `${file.name}-p${i + 1}.png`, i + 1);
          }
        } else if (/^image\//.test(file.type)) {
          setBusyMsg(`Scanning ${file.name}…`);
          const img = await fileToImage(file);
          const canvas = document.createElement('canvas');
          canvas.width = img.width; canvas.height = img.height;
          canvas.getContext('2d')!.drawImage(img, 0, 0);
          await uploadCanvas(canvas, file.name);
        } else {
          setError(`${file.name}: unsupported type ${file.type}`);
        }
      } catch (e: any) {
        setError(`${file.name}: ${e.message}`);
      }
    }
    setBusyMsg(null);
  };

  return (
    <div style={{ padding: 20, background: C.bg, minHeight: '100vh' }}>
      <h2 style={{ color: C.purple, margin: '0 0 4px' }}>
        📸 Smart Document Scanner
        <span style={{ fontSize: 11, color: C.ok, border: `1px solid ${C.ok}`, borderRadius: 10, padding: '1px 8px', marginLeft: 8 }}>
          100% LOCAL · ZERO API COST
        </span>
      </h2>
      <div style={{ fontSize: 11, color: C.dim, marginBottom: 14 }}>
        Tesseract OCR → DeepSeek structured parsing → PostgreSQL validation → auto-file at ≥90% (below → review queue).
        Managed by AGENT_04 BHUVANESHWARI. E-Way bills · Bilty/POD · fuel slips · DL · RC · multi-page PDF.
      </div>

      {mode === 'camera' ? (
        <div style={{ position: 'relative', maxWidth: 720 }}>
          <video ref={videoRef} playsInline muted style={{ width: '100%', borderRadius: 14, border: `2px solid ${C.purple}` }} />
          <div style={{ position: 'absolute', inset: 12, border: `2px dashed rgba(192,132,252,0.6)`, borderRadius: 10, pointerEvents: 'none' }} />
          <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
            <button onClick={capture}
              style={{ flex: 1, padding: '14px 0', fontSize: 15, fontWeight: 800, background: C.purple, color: '#0f172a', border: 'none', borderRadius: 12, cursor: 'pointer' }}>
              📷 CAPTURE DOCUMENT
            </button>
            <button onClick={stopCamera}
              style={{ padding: '14px 18px', background: 'transparent', color: C.dim, border: `1px solid ${C.line}`, borderRadius: 12, cursor: 'pointer' }}>
              ✕
            </button>
          </div>
        </div>
      ) : (
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); e.dataTransfer.files?.length && handleFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          style={{
            border: `2px dashed ${drag ? C.purple : C.line}`, borderRadius: 16, padding: '38px 20px', textAlign: 'center',
            cursor: 'pointer', background: drag ? 'rgba(192,132,252,0.08)' : '#0b1220', transition: 'all .2s',
            boxShadow: drag ? `0 0 24px rgba(192,132,252,0.35)` : '0 0 12px rgba(56,189,248,0.12)',
          }}>
          <input ref={inputRef} type="file" multiple hidden accept="image/png,image/jpeg,image/webp,application/pdf"
            onChange={(e) => e.target.files?.length && handleFiles(e.target.files)} />
          <div style={{ fontSize: 34 }}>{busyMsg ? '🔎' : '🗂️'}</div>
          <div style={{ color: C.text, fontWeight: 800, fontSize: 15 }}>
            {busyMsg ?? 'Drop bills / PODs / PDFs here — or click to browse'}
          </div>
          <div style={{ color: C.dim, fontSize: 11, marginTop: 6 }}>auto-crop · contrast enhance · multi-page PDF · duplicate-proof</div>
          <button onClick={(e) => { e.stopPropagation(); startCamera(); }}
            style={{ marginTop: 16, padding: '12px 26px', fontSize: 14, fontWeight: 800, background: 'transparent', color: C.purple, border: `2px solid ${C.purple}`, borderRadius: 12, cursor: 'pointer' }}>
            📷 OPEN CAMERA (driver mode)
          </button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12, padding: '10px 14px', border: `1px dashed ${C.bad}`, borderRadius: 10, color: C.bad, fontSize: 12 }}>⚠️ {error}</div>
      )}

      {previews.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          {previews.map((src, i) => (
            <img key={i} src={src} alt={`processed ${i}`} style={{ height: 110, borderRadius: 8, border: `1px solid ${C.line}` }} />
          ))}
          <div style={{ alignSelf: 'center', fontSize: 10, color: C.dim }}>← preprocessed<br />(what the OCR sees)</div>
        </div>
      )}

      {results.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 10, marginTop: 14 }}>
          {results.map((r, i) => <ResultCard key={i} r={r} />)}
        </div>
      )}

      <ReviewQueue />
    </div>
  );
}
