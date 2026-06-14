// 🔧 LLM configuration — driven entirely by .env (VITE_* vars).
// Swap model/variant or endpoint by editing .env only; no code changes needed.

interface LLMConfig {
  provider: string;
  baseUrl: string;
  model: string;
  fallbackModel: string;
  temperature: number;
  requestTimeoutMs: number;
}

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env || {};

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// 🧠 Runtime overrides (AI Brain Control panel) — stored in localStorage so the
// active model / temperature / persona can be swapped without a code or .env
// change and without any Firestore read.
const LS_KEY = 'prasad_ai_overrides';
export interface AiOverrides { model?: string; temperature?: number; persona?: string; }
export function getAiOverrides(): AiOverrides {
  try { return JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(LS_KEY)) || '{}') || {}; }
  catch { return {}; }
}
export function setAiOverrides(next: AiOverrides): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ...getAiOverrides(), ...next })); } catch { /* ignore */ }
}

const ENV_MODEL = env.VITE_LLM_MODEL || 'gemma4:12b';
const ENV_TEMP = num(env.VITE_LLM_TEMPERATURE, 0.4);

// Getters so a localStorage override takes effect immediately, .env is fallback.
export const LLM_CONFIG: LLMConfig = {
  provider: env.VITE_LLM_PROVIDER || 'ollama',
  baseUrl: (env.VITE_LLM_BASE_URL || 'http://localhost:11434').replace(/\/+$/, ''),
  get model() { return getAiOverrides().model || ENV_MODEL; },
  fallbackModel: env.VITE_LLM_FALLBACK_MODEL || 'gemma4:e4b',
  get temperature() { const o = getAiOverrides().temperature; return (typeof o === 'number' && o >= 0) ? o : ENV_TEMP; },
  requestTimeoutMs: num(env.VITE_LLM_TIMEOUT_MS, 120000),
};

/** The active Mamta persona (system-prompt preamble), override-able. */
export const DEFAULT_PERSONA = 'You are MAMTA AI — a warm, graceful, professional female business assistant for PRASAD Transport ERP. Reply concisely and politely in the user\'s language (Hindi/Hinglish/English), addressing the user respectfully (ji/sir). Confirm before any write action.';
export function getPersona(): string { return getAiOverrides().persona || DEFAULT_PERSONA; }
