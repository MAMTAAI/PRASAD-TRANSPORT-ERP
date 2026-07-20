// 📸 Real media uploads to Firebase Storage — with STRICT client-side
// compression (Subhash Sir mandate 2026-07-20: storage cost ≈ zero).
//
//  • Images  → WebP, quality/dimension search targeting ≤ ~140 KB while
//    keeping documents readable (JPEG fallback for browsers that can't
//    encode WebP, e.g. older Safari).
//  • PDFs    → re-rendered page-by-page via pdfjs and rebuilt with pdf-lib
//    as a compact image-PDF (scanned docs lose nothing; text-PDFs become
//    images, which is fine for KYC/bill archives).
//  • The compressed result is used ONLY when it is actually smaller than
//    the original — compression can never make an upload worse.
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { storage } from '../firebase';

const TARGET_BYTES = 140 * 1024;          // sweet spot of the 100–150 KB mandate
const IMG_EDGES = [1600, 1280, 1024];     // never below 1024px — docs must stay readable
const IMG_QUALITIES = [0.8, 0.65, 0.5, 0.4];
const PDF_PAGE_WIDTH = 1400;              // rendered page width in px
const PDF_QUALITIES = [0.7, 0.55, 0.45];
const PDF_MAX_PAGES = 25;                 // beyond this, keep the original
const MAX_ORIGINAL_MB = 15;

const canvasEncode = (canvas: HTMLCanvasElement, mime: string, q: number) =>
  new Promise<Blob | null>(res => canvas.toBlob(res, mime, q));

interface Compressed { blob: Blob; mime: string; ext: string; }

/** Draw the bitmap at a max-edge size and encode. */
async function encodeBitmap(bitmap: ImageBitmap, maxEdge: number, mime: string, q: number): Promise<Blob | null> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await canvasEncode(canvas, mime, q);
  // Safari can silently fall back to PNG when asked for WebP — reject that.
  return blob && blob.type === mime ? blob : null;
}

/** Compress an image to WebP (JPEG fallback), hunting for ≤ TARGET_BYTES. */
export async function compressImage(file: File): Promise<Compressed> {
  const original: Compressed = { blob: file, mime: file.type || 'application/octet-stream', ext: '' };
  if (!file.type.startsWith('image/')) return original;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return original; // unsupported format — upload as-is

  for (const mime of ['image/webp', 'image/jpeg']) {
    let best: Blob | null = null;
    for (const edge of IMG_EDGES) {
      for (const q of IMG_QUALITIES) {
        const blob = await encodeBitmap(bitmap, edge, mime, q);
        if (!blob) { best = null; break; }        // encoder unsupported → next mime
        best = blob;
        if (blob.size <= TARGET_BYTES) {
          return blob.size < file.size
            ? { blob, mime, ext: mime === 'image/webp' ? '.webp' : '.jpg' }
            : original;
        }
      }
      if (best === null) break;
    }
    // Target not reached at the readability floor — take the smallest we got.
    if (best && best.size < file.size) {
      return { blob: best, mime, ext: mime === 'image/webp' ? '.webp' : '.jpg' };
    }
    if (best) return original; // original already smaller than anything we made
  }
  return original;
}

/** Re-render a PDF as a compact image-PDF. Falls back to the original on any
 *  failure — a broken/encrypted/oversized PDF must still upload. */
export async function compressPdf(file: File): Promise<Compressed> {
  const original: Compressed = { blob: file, mime: 'application/pdf', ext: '.pdf' };
  try {
    const pdfjs: any = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const { PDFDocument } = await import('pdf-lib');

    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    if (pdf.numPages > PDF_MAX_PAGES) return original;

    const out = await PDFDocument.create();
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const vp1 = page.getViewport({ scale: 1 });
      const scale = Math.min(2, PDF_PAGE_WIDTH / vp1.width);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return original;
      await page.render({ canvasContext: ctx, viewport: vp }).promise;

      let jpeg: Blob | null = null;
      for (const q of PDF_QUALITIES) {
        jpeg = await canvasEncode(canvas, 'image/jpeg', q);
        if (jpeg && jpeg.size <= TARGET_BYTES) break;
      }
      if (!jpeg) return original;
      const img = await out.embedJpg(await jpeg.arrayBuffer());
      // Keep the page's real paper size (PDF points) so prints stay correct.
      const p = out.addPage([vp1.width, vp1.height]);
      p.drawImage(img, { x: 0, y: 0, width: vp1.width, height: vp1.height });
    }
    const bytes = await out.save();
    const blob = new Blob([bytes], { type: 'application/pdf' });
    return blob.size < file.size ? { blob, mime: 'application/pdf', ext: '.pdf' } : original;
  } catch (e) {
    console.warn('PDF compression failed — uploading original:', e);
    return original;
  }
}

export interface UploadResult { url: string; path: string; bytes: number; }

/** Compress (image→WebP / PDF→re-render) and upload to Storage; resolves with
 *  the permanent download URL to store in Firestore. Throws on failure —
 *  callers must show a real error, never a fake success. */
export async function uploadMedia(
  file: File,
  path: string,
  onProgress?: (pct: number) => void
): Promise<UploadResult> {
  if (file.size > MAX_ORIGINAL_MB * 1024 * 1024) {
    throw new Error(`File too large (max ${MAX_ORIGINAL_MB} MB)`);
  }
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
  const c = isPdf ? await compressPdf(file) : await compressImage(file);

  // Re-extension the storage path to match what we actually encoded.
  const cleanPath = c.ext ? path.replace(/\.[^.\/]+$/, '') + c.ext : path;
  const storageRef = ref(storage, cleanPath);
  const task = uploadBytesResumable(storageRef, c.blob, { contentType: c.mime });
  await new Promise<void>((resolve, reject) => {
    task.on(
      'state_changed',
      snap => onProgress?.(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      reject,
      () => resolve()
    );
  });
  const url = await getDownloadURL(storageRef);
  return { url, path: cleanPath, bytes: c.blob.size };
}

/** Safe filename fragment from an id/label. */
export const slug = (s: string) => String(s || 'x').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
