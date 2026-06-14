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

export const LLM_CONFIG: LLMConfig = {
  provider: env.VITE_LLM_PROVIDER || 'ollama',
  baseUrl: (env.VITE_LLM_BASE_URL || 'http://localhost:11434').replace(/\/+$/, ''),
  model: env.VITE_LLM_MODEL || 'gemma4:12b',
  fallbackModel: env.VITE_LLM_FALLBACK_MODEL || 'gemma4:e4b',
  temperature: num(env.VITE_LLM_TEMPERATURE, 0.4),
  requestTimeoutMs: num(env.VITE_LLM_TIMEOUT_MS, 120000),
};
