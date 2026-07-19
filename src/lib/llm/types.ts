// 🤖 PRASAD ERP — Local LLM service layer (provider-agnostic types)
// Everything here is provider-neutral so we can swap Ollama/Gemma for another
// local engine later without touching feature code.

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** base64-encoded images (NO `data:` prefix) — for multimodal/vision prompts (Phase 3 PDFs). */
  images?: string[];
  /** populated on assistant messages that requested tool calls */
  tool_calls?: ToolCall[];
  /** name of the tool this message is a result for (role: 'tool') */
  tool_name?: string;
}

/** OpenAI/Ollama-compatible tool (function) definition — used by Phase 4 agents. */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ChatOptions {
  /** Override the configured model for this single call. */
  model?: string;
  temperature?: number;
  /** Tool/function definitions the model may call. */
  tools?: ToolDefinition[];
  /** Ask the model for structured output: 'json' or a JSON Schema object. */
  format?: 'json' | Record<string, unknown>;
  /** Context window override (tokens). Vision/tabular extraction needs headroom
   *  beyond Ollama's small default or early prompt content silently truncates. */
  numCtx?: number;
  /** Reasoning toggle for thinking-capable models. MUST be false for
   *  schema-constrained extraction: on hard documents the model can spend its
   *  entire output budget "thinking" and return empty content (done_reason:
   *  length) — verified against real IOCL bills. */
  think?: boolean;
  /** Abort in-flight requests (e.g. user navigates away / cancels). */
  signal?: AbortSignal;
  /** Disable automatic fallback to the lighter model on failure. */
  noFallback?: boolean;
}

export interface ChatResult {
  content: string;
  tool_calls?: ToolCall[];
  /** Which model actually answered (may be the fallback). */
  model: string;
  /** True if the fallback model was used because the primary failed. */
  usedFallback: boolean;
}

export interface StreamChunk {
  /** Incremental text token(s). */
  delta: string;
  done: boolean;
  tool_calls?: ToolCall[];
}

export interface LLMHealth {
  online: boolean;
  baseUrl: string;
  /** Installed model names reported by the engine. */
  models: string[];
  /** Whether the configured primary model is installed. */
  primaryInstalled: boolean;
  error?: string;
}

/** A swappable local-LLM backend. Implement this to add a new provider. */
export interface LLMProvider {
  readonly name: string;
  health(): Promise<LLMHealth>;
  chat(messages: ChatMessage[], opts: ChatOptions & { model: string }): Promise<ChatResult>;
  stream(messages: ChatMessage[], opts: ChatOptions & { model: string }): AsyncGenerator<StreamChunk>;
}

/** Thrown when the local engine is unreachable (server down). */
export class LLMOfflineError extends Error {
  constructor(message = 'Local AI engine is offline') {
    super(message);
    this.name = 'LLMOfflineError';
  }
}

/** Thrown for engine-side errors (bad request, model missing, etc.). */
export class LLMError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}
