// ☁️ Cloud AI provider — Claude Haiku via the local bridge server (bridge.cjs).
// The browser NEVER holds the Anthropic API key: requests go to the bridge's
// /api/ai/chat controller, which loads the key from process.env.ANTHROPIC_API_KEY
// and calls the official @anthropic-ai/sdk. Implements the same LLMProvider
// interface as OllamaProvider, so billScanner/agents work unchanged on either
// engine — sirf provider switch hota hai.
import type { ChatMessage, ChatOptions, ChatResult, LLMHealth, LLMProvider, StreamChunk } from '../types';
import { LLMOfflineError, LLMError } from '../types';

export class ClaudeBridgeProvider implements LLMProvider {
  readonly name = 'claude-bridge';

  constructor(private baseUrl: string, private timeoutMs = 180000, private authToken = '') {}

  /** Token header only when configured (tunnel path). Empty = local dev, gate off. */
  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.authToken) h['X-PT-Token'] = this.authToken;
    return h;
  }

  async health(): Promise<LLMHealth> {
    try {
      const r = await fetch(`${this.baseUrl}/api/ai/health`, { headers: this.headers(), signal: AbortSignal.timeout(5000) });
      const data = await r.json();
      return {
        online: !!data.cloud_configured,
        baseUrl: this.baseUrl,
        models: data.cloud_model ? [data.cloud_model] : [],
        primaryInstalled: !!data.cloud_configured,
        error: data.cloud_configured ? undefined : 'Bridge server par ANTHROPIC_API_KEY set nahi hai',
      };
    } catch {
      return { online: false, baseUrl: this.baseUrl, models: [], primaryInstalled: false, error: 'Bridge server (bridge.cjs) not reachable' };
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions & { model: string }): Promise<ChatResult> {
    let r: Response;
    try {
      r = await fetch(`${this.baseUrl}/api/ai/chat`, {
        method: 'POST',
        headers: this.headers(true),
        signal: opts.signal ?? AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          engine: 'cloud',
          messages,
          options: {
            // model yahan deliberately NOT bheja jata — cloud model bridge ke
            // .env (ANTHROPIC_MODEL) se aata hai; frontend ka gemma model name
            // Claude par apply nahi hota.
            temperature: opts.temperature,
            format: typeof opts.format === 'object' ? opts.format : undefined,
          },
        }),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new LLMOfflineError('Cloud AI bridge server not reachable — bridge.cjs chalu hai?');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.success) {
      if (r.status === 503) throw new LLMOfflineError(data.error || 'Cloud AI unavailable');
      throw new LLMError(data.error || `Cloud AI error (${r.status})`, r.status);
    }
    return { content: data.content || '', model: data.model || 'claude', usedFallback: false };
  }

  // Bill-scanner path is single-shot; stream = chat delivered as one chunk.
  async *stream(messages: ChatMessage[], opts: ChatOptions & { model: string }): AsyncGenerator<StreamChunk> {
    const res = await this.chat(messages, opts);
    yield { delta: res.content, done: true };
  }
}
