// 📸 Real media uploads to Firebase Storage (Phase A "Truth Sprint").
// Replaces the fake setTimeout + URL.createObjectURL flows that stored
// device-local blob: URLs in Firestore (dead links for every other device).
// Images are canvas-compressed before upload so a driver's 6 MB photo becomes
// ~200-400 KB of data spend.
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { storage } from '../firebase';

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.72;
const MAX_ORIGINAL_MB = 15;

export async function compressImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) return file; // PDFs etc. pass through
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // unsupported format — upload original
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return file;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(res => canvas.toBlob(res, 'image/jpeg', JPEG_QUALITY));
  return blob && blob.size < file.size ? blob : file;
}

export interface UploadResult { url: string; path: string; bytes: number; }

/** Compress (if image) and upload to Storage; resolves with the permanent
 *  download URL to store in Firestore. Throws on failure — callers must show
 *  a real error, never a fake success. */
export async function uploadMedia(
  file: File,
  path: string,
  onProgress?: (pct: number) => void
): Promise<UploadResult> {
  if (file.size > MAX_ORIGINAL_MB * 1024 * 1024) {
    throw new Error(`File too large (max ${MAX_ORIGINAL_MB} MB)`);
  }
  const blob = await compressImage(file);
  const isJpeg = blob !== file;
  const cleanPath = isJpeg && !/\.jpe?g$/i.test(path) ? path.replace(/\.[^.]+$/, '') + '.jpg' : path;
  const storageRef = ref(storage, cleanPath);
  const task = uploadBytesResumable(storageRef, blob, {
    contentType: isJpeg ? 'image/jpeg' : (file.type || 'application/octet-stream'),
  });
  await new Promise<void>((resolve, reject) => {
    task.on(
      'state_changed',
      snap => onProgress?.(Math.round((snap.bytesTransferred / snap.totalBytes) * 100)),
      reject,
      () => resolve()
    );
  });
  const url = await getDownloadURL(storageRef);
  return { url, path: cleanPath, bytes: blob.size };
}

/** Safe filename fragment from an id/label. */
export const slug = (s: string) => String(s || 'x').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
