// 🧮 Local embeddings via Ollama (nomic-embed-text). 100% on-device.
import { LLM_CONFIG } from '../llm/config';

const EMBED_MODEL =
  (import.meta as any).env?.VITE_LLM_EMBED_MODEL || 'nomic-embed-text';

/** Embed a single text into a 768-dim vector. */
export async function embed(text: string, signal?: AbortSignal): Promise<number[]> {
  const res = await fetch(`${LLM_CONFIG.baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    signal,
  });
  if (!res.ok) throw new Error(`Embedding failed (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data.embedding)) throw new Error('No embedding returned');
  return data.embedding as number[];
}

/** Embed many texts sequentially (nomic is fast; keeps GPU memory steady). */
export async function embedBatch(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(await embed(texts[i], signal));
    onProgress?.(i + 1, texts.length);
  }
  return out;
}

export function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
