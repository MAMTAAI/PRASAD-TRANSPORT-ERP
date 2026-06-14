// 🧭 Orchestrator — Gemma 4 tool-calling loop over the read-only agent tools.
// Routes a user question to the right tool(s), runs them locally, and lets the
// model compose a grounded final answer. Emits a trace for observability.
import { llmChat } from '../llm';
import type { ChatMessage } from '../llm/types';
import { enabledTools, type AgentTool } from './tools';

export interface AgentEvent {
  type: 'tool_call' | 'tool_result' | 'final' | 'error';
  agent?: string;
  tool?: string;
  args?: any;
  text?: string;
}

const SYSTEM = `You are MAMTA AI, the orchestrator for PRASAD Transport ERP (petroleum logistics).
You have tools to read ERP data. Decide which tool(s) to call to answer the user, then give a concise final answer in the user's language (Hindi/Hinglish/English).
Rules: never invent data — only use tool results. If tools return nothing relevant, say you don't have that record. You cannot modify data.`;

const MAX_STEPS = 5;

export async function runAgent(
  userMessage: string,
  onEvent?: (e: AgentEvent) => void,
): Promise<{ answer: string; trace: AgentEvent[] }> {
  const tools = enabledTools();
  const byName = new Map<string, AgentTool>(tools.map(t => [t.definition.function.name, t]));
  const toolDefs = tools.map(t => t.definition);
  const trace: AgentEvent[] = [];
  const emit = (e: AgentEvent) => { trace.push(e); onEvent?.(e); };

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userMessage },
  ];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await llmChat(messages, { tools: toolDefs, temperature: 0.2 });

    if (!res.tool_calls?.length) {
      emit({ type: 'final', text: res.content });
      return { answer: res.content || '(no answer)', trace };
    }

    // Record the assistant's tool-call turn, then execute each call.
    messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.tool_calls } as any);
    for (const call of res.tool_calls) {
      const name = call.function?.name;
      const args = call.function?.arguments || {};
      const tool = byName.get(name);
      emit({ type: 'tool_call', agent: tool?.agent, tool: name, args });
      let result: string;
      try {
        result = tool ? await tool.run(args) : `Unknown tool: ${name}`;
      } catch (e: any) {
        result = `Tool error: ${e?.message || 'failed'}`;
      }
      emit({ type: 'tool_result', agent: tool?.agent, tool: name, text: result.slice(0, 200) });
      messages.push({ role: 'tool', name, content: result } as any);
    }
  }

  // Safety: ran out of steps — ask the model to answer from what it has.
  const final = await llmChat([...messages, { role: 'user', content: 'Give your best final answer now from the tool results above.' }], { temperature: 0.2 });
  emit({ type: 'final', text: final.content });
  return { answer: final.content || '(no answer)', trace };
}
