// 🧭 Orchestrator — Gemma 4 tool-calling loop over the read-only agent tools.
// Routes a user question to the right tool(s), runs them locally, and lets the
// model compose a grounded final answer. Emits a trace for observability.
import { llmChat } from '../llm';
import type { ChatMessage } from '../llm/types';
import { enabledTools, type AgentTool } from './tools';
import { shouldRefuseFinancial, describeScope, REFUSAL_HI, scopeFor, type AppUser } from '../rbac';
import { recall, remember } from '../memory';

export interface AgentEvent {
  type: 'tool_call' | 'tool_result' | 'final' | 'error' | 'pending_write';
  agent?: string;
  tool?: string;
  args?: any;
  text?: string;
}

export interface PendingWrite { tool: string; agent?: string; args: any; }

const SYSTEM = `You are MAMTA AI, the orchestrator for PRASAD Transport ERP (petroleum logistics).
You have tools to read ERP data. Decide which tool(s) to call to answer the user, then give a concise final answer in the user's language (Hindi/Hinglish/English).
Rules: never invent data — only use tool results. If tools return nothing relevant, say you don't have that record. You cannot modify data.`;

const MAX_STEPS = 5;

export async function runAgent(
  userMessage: string,
  onEvent?: (e: AgentEvent) => void,
  user?: AppUser,
  history?: Array<{ role: 'user' | 'assistant'; text: string }>, // 🧠 multi-turn context (STM)
): Promise<{ answer: string; trace: AgentEvent[]; pendingWrite?: PendingWrite }> {
  // 🔐 RBAC: a non-finance role asking for financials is politely declined.
  if (user && shouldRefuseFinancial(user, userMessage)) {
    onEvent?.({ type: 'final', text: REFUSAL_HI });
    return { answer: REFUSAL_HI, trace: [{ type: 'final', text: REFUSAL_HI }] };
  }
  const tools = enabledTools();
  const byName = new Map<string, AgentTool>(tools.map(t => [t.definition.function.name, t]));
  const toolDefs = tools.map(t => t.definition);
  const trace: AgentEvent[] = [];
  const emit = (e: AgentEvent) => { trace.push(e); onEvent?.(e); };

  const scopeNote = user ? `\nThe current user's data access is: ${describeScope(user)}. Only discuss data within this scope; politely decline anything outside it in Hindi.` : '';

  // 🧠 Long-term memory recall (RBAC-scoped) injected as context.
  let memoryNote = '';
  try {
    const mems = await recall({ namespace: 'mamta', query: userMessage, k: 3, user });
    if (mems.length) memoryNote = `\nRelevant remembered facts:\n${mems.map(m => `- ${m.text}`).join('\n')}`;
  } catch { /* memory optional */ }

  // 🧠 Multi-turn: prior turns (short-term memory) come BEFORE the new
  // question, so "aur uska mobile number?" finally works. Capped upstream.
  const historyMsgs: ChatMessage[] = (history || []).slice(-10).map(h => ({ role: h.role, content: h.text }));

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM + scopeNote + memoryNote },
    ...historyMsgs,
    { role: 'user', content: userMessage },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    // numCtx: the loop accumulates history + tool results — Ollama's small
    // default context would silently drop the system rules first.
    const res = await llmChat(messages, { tools: toolDefs, temperature: 0.2, numCtx: 8192 } as any);

    if (!res.tool_calls?.length) {
      emit({ type: 'final', text: res.content });
      // 🧠 Persist a concise outcome to long-term memory (RBAC-scoped, deduped).
      if (res.content) {
        const sc = user ? scopeFor(user) : { type: 'all', value: '' };
        remember({ namespace: 'mamta', text: `Q: ${userMessage} → ${String(res.content).slice(0, 220)}`, scope: sc.type === 'all' ? 'all' : sc.value, kind: 'conversation' }).catch(() => {});
      }
      return { answer: res.content || '(no answer)', trace };
    }

    // A write tool? Do NOT execute — surface it for user confirmation (Section 0).
    const writeCall = res.tool_calls.find(c => byName.get(c.function?.name)?.write);
    if (writeCall) {
      const tool = byName.get(writeCall.function.name);
      const pending = { tool: writeCall.function.name, agent: tool?.agent, args: writeCall.function.arguments || {} };
      emit({ type: 'pending_write', agent: tool?.agent, tool: pending.tool, args: pending.args });
      return { answer: '', trace, pendingWrite: pending };
    }

    // Record the assistant's tool-call turn, then execute each (read-only) call.
    messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.tool_calls } as any);
    for (const call of res.tool_calls) {
      const name = call.function?.name;
      const args = call.function?.arguments || {};
      const tool = byName.get(name);
      emit({ type: 'tool_call', agent: tool?.agent, tool: name, args });
      let result: string;
      try {
        result = tool ? await tool.run(args, { user }) : `Unknown tool: ${name}`;
      } catch (e: any) {
        result = `Tool error: ${e?.message || 'failed'}`;
      }
      emit({ type: 'tool_result', agent: tool?.agent, tool: name, text: result.slice(0, 200) });
      // Cap what re-enters the context — an unbounded tool dump evicts the
      // system rules long before Gemma sees the question again.
      messages.push({ role: 'tool', name, content: result.length > 2000 ? result.slice(0, 2000) + '\n…(truncated)' : result } as any);
    }
  }

  // Safety: ran out of steps — ask the model to answer from what it has.
  const final = await llmChat([...messages, { role: 'user', content: 'Give your best final answer now from the tool results above.' }], { temperature: 0.2, numCtx: 8192 } as any);
  emit({ type: 'final', text: final.content });
  return { answer: final.content || '(no answer)', trace };
}
