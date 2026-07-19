// 🤖 PRASAD ERP — Local LLM service (public API)
// One import for the whole app:  import { llmChat, llmChatStream, llmHealth } from '@/lib/llm'
//
// • 100% local (Ollama + Gemma 4). No cloud APIs.
// • Streaming + tool-calling + vision.
// • Auto-fallback: primary model -> lighter model on engine error.
// • Clean "engine offline" signal so the UI can show a friendly message.

import { LLM_CONFIG, BRIDGE_URL, getAiEngine } from './config';
import { OllamaProvider } from './providers/ollama';
import { ClaudeBridgeProvider } from './providers/claudeBridge';
import type {
  ChatMessage, ChatOptions, ChatResult, LLMHealth, LLMProvider, StreamChunk,
} from './types';
import { LLMOfflineError, LLMError } from './types';

export * from './types';
export { LLM_CONFIG, getAiEngine, setAiEngine, AI_ENGINES } from './config';
export type { AiEngine } from './config';

function makeProvider(): LLMProvider {
  switch (LLM_CONFIG.provider) {
    case 'ollama':
    default:
      return new OllamaProvider(LLM_CONFIG.baseUrl, LLM_CONFIG.requestTimeoutMs);
  }
}

// 🔀 DUAL-AI: local (Ollama — unchanged default) + cloud (Claude via bridge).
// Har call par engine selection padha jata hai — user dropdown se switch kare
// to agla hi request naye engine par jata hai, reload ki zaroorat nahi.
const localProvider = makeProvider();
const cloudProvider = new ClaudeBridgeProvider(BRIDGE_URL, LLM_CONFIG.requestTimeoutMs);
const activeProvider = (): LLMProvider => getAiEngine() === 'cloud' ? cloudProvider : localProvider;

function shouldFallback(err: unknown, opts: ChatOptions, primary: string): boolean {
  if (opts.noFallback) return false;
  // Model-fallback sirf LOCAL engine ka concept hai (12b -> e4b). Cloud par
  // Anthropic SDK khud retries karta hai; gemma fallback wahan meaningless hai.
  if (getAiEngine() === 'cloud') return false;
  if (LLM_CONFIG.fallbackModel === primary) return false;
  // Don't fallback on user-cancellation or full server-offline (fallback can't help).
  if (err instanceof DOMException && err.name === 'AbortError') return false;
  if (err instanceof LLMOfflineError) return false;
  return err instanceof LLMError;
}

/** Is the ACTIVE engine reachable (local: Ollama; cloud: bridge + key)? */
export function llmHealth(): Promise<LLMHealth> {
  return activeProvider().health();
}

/** One-shot chat. Returns the full answer (and which model produced it). */
export async function llmChat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
  const provider = activeProvider();
  const primary = opts.model || LLM_CONFIG.model;
  const base = { ...opts, temperature: opts.temperature ?? LLM_CONFIG.temperature };
  try {
    return await provider.chat(messages, { ...base, model: primary });
  } catch (err) {
    if (!shouldFallback(err, opts, primary)) throw err;
    const result = await provider.chat(messages, { ...base, model: LLM_CONFIG.fallbackModel });
    return { ...result, usedFallback: true };
  }
}

/** Streaming chat. Yields incremental chunks; falls back if the primary fails before streaming. */
export async function* llmChatStream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<StreamChunk> {
  const provider = activeProvider();
  const primary = opts.model || LLM_CONFIG.model;
  const base = { ...opts, temperature: opts.temperature ?? LLM_CONFIG.temperature };
  try {
    yield* provider.stream(messages, { ...base, model: primary });
  } catch (err) {
    if (!shouldFallback(err, opts, primary)) throw err;
    yield* provider.stream(messages, { ...base, model: LLM_CONFIG.fallbackModel });
  }
}

/** Convenience: drain a stream into a single string (optionally pipe tokens to a callback). */
export async function llmComplete(
  messages: ChatMessage[],
  opts: ChatOptions = {},
  onToken?: (delta: string) => void,
): Promise<string> {
  let out = '';
  for await (const chunk of llmChatStream(messages, opts)) {
    if (chunk.delta) {
      out += chunk.delta;
      onToken?.(chunk.delta);
    }
  }
  return out;
}
