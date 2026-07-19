// 🦙 Ollama provider — talks to the local Ollama engine (default http://localhost:11434).
// Pure fetch + NDJSON streaming so it works in the browser and in Node 18+.

import type {
  ChatMessage, ChatOptions, ChatResult, LLMHealth, LLMProvider, StreamChunk, ToolCall,
} from '../types';
import { LLMError, LLMOfflineError } from '../types';

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
}

function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  return messages.map((m) => {
    const msg: OllamaMessage = { role: m.role, content: m.content };
    if (m.images?.length) msg.images = m.images;
    if (m.tool_calls?.length) msg.tool_calls = m.tool_calls;
    return msg;
  });
}

function buildBody(messages: ChatMessage[], opts: ChatOptions & { model: string }, stream: boolean) {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: toOllamaMessages(messages),
    stream,
    options: opts.numCtx ? { temperature: opts.temperature ?? 0.4, num_ctx: opts.numCtx } : { temperature: opts.temperature ?? 0.4 },
  };
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.format) body.format = opts.format;
  if (opts.think !== undefined) body.think = opts.think;
  return body;
}

/** A network-level failure (server unreachable) -> offline; otherwise an engine error. */
function classifyFetchError(err: unknown): never {
  if (err instanceof DOMException && err.name === 'AbortError') {
    throw err; // caller-initiated cancellation/timeout
  }
  // fetch() rejects with a TypeError when the host can't be reached.
  throw new LLMOfflineError('Cannot reach the local AI engine (is Ollama running?)');
}

export class OllamaProvider implements LLMProvider {
  readonly name = 'ollama';
  private baseUrl: string;
  private timeoutMs: number;
  private authToken: string;

  constructor(baseUrl: string, timeoutMs: number, authToken = '') {
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.authToken = authToken;
  }

  /** Common headers. `X-PT-Token` sirf tabhi lagta hai jab configure kiya ho
   *  (tunnel path). Raw local Ollama ise ignore kar deta hai, to bhejna safe hai. */
  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (json) h['Content-Type'] = 'application/json';
    if (this.authToken) h['X-PT-Token'] = this.authToken;
    return h;
  }

  private withTimeout(signal?: AbortSignal): { signal: AbortSignal; clear: () => void } {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
  }

  async health(): Promise<LLMHealth> {
    const base: LLMHealth = { online: false, baseUrl: this.baseUrl, models: [], primaryInstalled: false };
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { method: 'GET', headers: this.headers() });
      if (!res.ok) return { ...base, error: `HTTP ${res.status}` };
      const data = await res.json();
      const models: string[] = (data.models || []).map((m: { name: string }) => m.name);
      return { ...base, online: true, models, primaryInstalled: true };
    } catch (err) {
      return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async chat(messages: ChatMessage[], opts: ChatOptions & { model: string }): Promise<ChatResult> {
    const { signal, clear } = this.withTimeout(opts.signal);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(buildBody(messages, opts, false)),
        signal,
      });
    } catch (err) {
      clear();
      classifyFetchError(err);
    }
    clear();
    if (!res!.ok) {
      const text = await res!.text().catch(() => '');
      throw new LLMError(`Ollama error: ${text || res!.statusText}`, res!.status);
    }
    const data = await res!.json();
    return {
      content: data.message?.content ?? '',
      tool_calls: data.message?.tool_calls as ToolCall[] | undefined,
      model: opts.model,
      usedFallback: false,
    };
  }

  async *stream(messages: ChatMessage[], opts: ChatOptions & { model: string }): AsyncGenerator<StreamChunk> {
    const { signal, clear } = this.withTimeout(opts.signal);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(buildBody(messages, opts, true)),
        signal,
      });
    } catch (err) {
      clear();
      classifyFetchError(err);
    }
    if (!res!.ok) {
      clear();
      const text = await res!.text().catch(() => '');
      throw new LLMError(`Ollama error: ${text || res!.statusText}`, res!.status);
    }
    const reader = res!.body?.getReader();
    if (!reader) {
      clear();
      throw new LLMError('No response body from Ollama');
    }
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let json: { message?: { content?: string; tool_calls?: ToolCall[] }; done?: boolean };
          try { json = JSON.parse(line); } catch { continue; }
          yield {
            delta: json.message?.content ?? '',
            done: !!json.done,
            tool_calls: json.message?.tool_calls,
          };
        }
      }
    } finally {
      clear();
      reader.releaseLock();
    }
  }
}
