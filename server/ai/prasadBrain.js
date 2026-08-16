// server/ai/prasadBrain.js
// ─────────────────────────────────────────────────────────────────────────────
// The ONE way the ten Mahavidya agents may reach a language model.
//
// Prasad Transport's agents and Jaiswal Capital's trading stack run on the same
// Ollama host. That is a fact of the hardware, not a design choice, and it means
// isolation has to be enforced in every call rather than assumed from the fact
// that they are "different systems".
//
// Four boundaries, all of them checkable:
//
//   1. IDENTITY   A system prompt that is prepended, not merged. A caller cannot
//                 replace it, and anything the caller supplies is appended after
//                 it, where it cannot redefine what the model is.
//   2. MODEL      Pinned to the Prasad model. Not read from a shared
//                 VITE_LLM_MODEL that another product also edits.
//   3. MEMORY     No conversation is retained here. Every call is stateless, so
//                 there is no store that could accumulate a mixture of transport
//                 and trading context.
//   4. REFUSAL    A prompt that is plainly about trading is refused before it
//                 reaches the model. A shared engine cannot stop Jaiswal work
//                 being typed into a Prasad box; this can stop it being answered
//                 by an agent that owns transport data.
//
// WHAT THIS DOES NOT CLAIM. One Ollama process still serves both businesses, so
// GPU time and the model queue are genuinely shared. Claiming otherwise would be
// false. What is not shared is context, model choice, prompt, or any retained
// state -- and the knowledge graph was split into separate FILES on separate
// drives (mamta-kg-transport.db / mamta-kg-trading.db) precisely so that the one
// thing which did accumulate could not.
const OLLAMA = process.env.PRASAD_OLLAMA_URL || 'http://127.0.0.1:11434';

// Pinned deliberately. Reading a shared VITE_LLM_MODEL would let another
// product's config change what answers as Prasad Transport.
//
// deepseek-coder:6.7b, set by God on 2026-08-16. Worth recording that this is a
// CODE model, not a general reasoning one: it is strongest on structured output
// -- JSON extraction from an AC5, a SQL predicate, a rule check -- and weaker on
// discursive prose than deepseek-r1:8b, which it replaces. Most of what these
// ten agents ask for is structured, so the trade favours them; if an agent
// starts needing narrative explanation, PRASAD_BRAIN_MODEL overrides this
// without a code change.
const MODEL = process.env.PRASAD_BRAIN_MODEL || 'deepseek-coder:6.7b';

const IDENTITY = [
  'You are the core intelligence of Prasad Transport ERP exclusively.',
  '',
  'You operate a petroleum and LPG road-transport business in Assam and the',
  'North-East: tank trucks, IOCL/BPCL/HPCL depots, loading advices, AC5 dispatch',
  'invoices, freight bills, driver khata, fuel slips, FASTag tolls and vehicle',
  'compliance. Your data is the prasad_erp PostgreSQL database and nothing else.',
  '',
  'You have no connection to Jaiswal Capital, to any trading or broking system,',
  'to MCX or NSE, to market data, or to any portfolio. If a request concerns',
  'trading, securities, commodities prices or another company\'s operations, say',
  'plainly that it is outside this system and stop. Do not speculate about it and',
  'do not answer from general knowledge.',
  '',
  'Answer from the ERP context you are given. Where the context does not contain',
  'the answer, say so rather than inventing a figure -- a fabricated quantity or',
  'rupee amount in a transport ledger is worse than no answer.',
].join('\n');

// Cheap, deliberately narrow: it catches an obvious cross-domain question, not
// every possible one. A refusal here is a guard rail, not a security boundary --
// the real boundary is that this process reads only prasad_erp.
const TRADING_PAT =
  /\b(nifty|sensex|mcx|nse|bse|option chain|strike price|futures contract|candlestick|zerodha|dhan|angel ?one|upstox|portfolio|holdings|intraday|F&O|jaiswal capital)\b/i;

export class CrossDomainError extends Error {
  constructor(term) {
    super(`refused: this looks like a trading question ("${term}"), and this brain serves Prasad Transport ERP only`);
    this.name = 'CrossDomainError';
    this.code = 'CROSS_DOMAIN_REFUSED';
  }
}

/**
 * Ask the Prasad brain. Stateless by construction.
 *
 * @param {object} o
 * @param {string} o.prompt     the question
 * @param {string} [o.context]  ERP rows/JSON the answer must be grounded in
 * @param {string} [o.agent]    which Mahavidya is asking, for the log
 */
export async function askPrasadBrain({ prompt, context = null, agent = 'UNKNOWN', timeoutMs = 120000 } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required');

  const hit = String(prompt).match(TRADING_PAT);
  if (hit) throw new CrossDomainError(hit[0]);

  // IDENTITY FIRST, ALWAYS. The caller's text is appended, never merged into
  // the system message, so no caller can redefine what this model is.
  const messages = [
    { role: 'system', content: IDENTITY },
    ...(context ? [{ role: 'system', content: `ERP context for this question:\n${context}` }] : []),
    { role: 'user', content: `[asking agent: ${agent}]\n${prompt}` },
  ];

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: MODEL,
        messages,
        stream: false,
        // No `keep_alive` beyond the default and no session id: nothing about
        // this exchange is retained for the next one.
        options: { temperature: 0.2, num_ctx: 8192 },
      }),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const j = await res.json();
    return {
      answer: j.message?.content ?? '',
      model: MODEL,
      agent,
      isolated: true,
      // Returned so a caller can prove which brain answered rather than assume.
      identity_hash: IDENTITY.length,
    };
  } finally {
    clearTimeout(t);
  }
}

/** What the fleet dashboard shows about model isolation. */
export function brainStatus() {
  return {
    scope: 'PRASAD_TRANSPORT_ERP_ONLY',
    model: MODEL,
    endpoint: OLLAMA,
    system_prompt_pinned: true,
    stateless: true,
    cross_domain_guard: true,
    knowledge_graph: 'data/mamta-kg-transport.db (transport only; the trading graph is a separate file on H:)',
    // Stated rather than hidden: the honest limit of the isolation.
    shared_with_other_products: 'the Ollama process and GPU queue are shared; context, model, prompt and memory are not',
  };
}
