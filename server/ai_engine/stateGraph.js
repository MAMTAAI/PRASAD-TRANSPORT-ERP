// server/ai_engine/stateGraph.js
// ─────────────────────────────────────────────────────────────────────────────
// Minimal LangGraph-compatible StateGraph engine (JS, zero dependencies).
//
// WHY HAND-ROLLED. The graph below never calls an LLM in its control path —
// routing an ERP event is a deterministic decision, and this box shares 8 GB
// with a live trading system. @langchain/langgraph would add a dependency tree
// for exactly the four primitives used here, so those primitives are
// implemented directly with the SAME API shape (addNode / addEdge /
// addConditionalEdges / setEntryPoint / compile → invoke, END sentinel).
// Swapping in the real library later is a mechanical import change.
//
// HARD GUARANTEE — NO RECURSIVE LOOPS. invoke() counts every node visit;
// crossing `recursionLimit` throws GraphRecursionError instead of spinning.
// The compiled app is therefore guaranteed to terminate on every input.
// ─────────────────────────────────────────────────────────────────────────────

export const END = '__end__';

export class GraphRecursionError extends Error {
  constructor(limit, path) {
    super(`graph exceeded recursionLimit=${limit} — path: ${path.join(' → ')}`);
    this.name = 'GraphRecursionError';
  }
}

export class StateGraph {
  constructor() {
    this.nodes = new Map();        // name -> async (state) => partialState
    this.edges = new Map();        // name -> name (unconditional)
    this.conditional = new Map();  // name -> { router: (state) => key, mapping: {key: name} }
    this.entryPoint = null;
  }

  addNode(name, fn) {
    if (name === END) throw new Error(`'${END}' is reserved`);
    if (this.nodes.has(name)) throw new Error(`node '${name}' already defined`);
    this.nodes.set(name, fn);
    return this;
  }

  addEdge(from, to) {
    this.edges.set(from, to);
    return this;
  }

  /** router(state) returns a key; mapping[key] names the next node (or END). */
  addConditionalEdges(from, router, mapping) {
    this.conditional.set(from, { router, mapping });
    return this;
  }

  setEntryPoint(name) {
    this.entryPoint = name;
    return this;
  }

  compile({ recursionLimit = 32 } = {}) {
    // Validate the topology at compile time — a typo'd edge must fail here,
    // not on the first live event that walks it.
    const known = (n) => n === END || this.nodes.has(n);
    if (!this.entryPoint || !this.nodes.has(this.entryPoint)) {
      throw new Error(`entry point '${this.entryPoint}' is not a node`);
    }
    for (const [from, to] of this.edges) {
      if (!this.nodes.has(from)) throw new Error(`edge from unknown node '${from}'`);
      if (!known(to)) throw new Error(`edge '${from}' → unknown node '${to}'`);
    }
    for (const [from, { mapping }] of this.conditional) {
      if (!this.nodes.has(from)) throw new Error(`conditional edge from unknown node '${from}'`);
      for (const [key, to] of Object.entries(mapping)) {
        if (!known(to)) throw new Error(`conditional '${from}'[${key}] → unknown node '${to}'`);
      }
    }
    // Every node must have a way out.
    for (const name of this.nodes.keys()) {
      if (!this.edges.has(name) && !this.conditional.has(name)) {
        throw new Error(`node '${name}' has no outgoing edge — the graph would dead-end`);
      }
    }

    const { nodes, edges, conditional, entryPoint } = this;

    return {
      /** Run the graph to END. Returns the final state (with __path audit). */
      async invoke(initialState) {
        let state = { ...initialState, __path: [] };
        let current = entryPoint;
        let steps = 0;

        while (current !== END) {
          if (++steps > recursionLimit) throw new GraphRecursionError(recursionLimit, state.__path);
          state.__path.push(current);

          const fn = nodes.get(current);
          const partial = await fn(state);
          if (partial && typeof partial === 'object') state = { ...state, ...partial };

          const cond = conditional.get(current);
          if (cond) {
            const key = cond.router(state);
            const next = cond.mapping[key];
            if (!next) throw new Error(`node '${current}' routed to unmapped key '${key}'`);
            current = next;
          } else {
            current = edges.get(current);
          }
        }
        return state;
      },
    };
  }
}
