// server/ai_engine/nodes/bagalamukhiNode.js
// ─────────────────────────────────────────────────────────────────────────────
// BAGALAMUKHI — 360° system defense, payload sanitizer, auto-healer.
// FIRST node on every path: nothing reaches the CEO or a worker without
// passing this shield. Three duties, in order:
//
//   1. SANITIZE  strip prototype-pollution keys, control characters,
//                oversize strings; neutralize script/SQL injection carriers.
//   2. HEAL      deterministic auto-repairs (numeric strings → numbers,
//                trimmed keys, non-object payload wrapped) — every repair is
//                recorded in security_audit.healed, nothing is silent.
//   3. JUDGE     fraud/absurdity checks. Anything hostile → QUARANTINED and
//                the graph short-circuits to the CEO's finalize step; the
//                event is failed with an audit trail, workers never see it.
//
// Deterministic by design — a defense layer that asks an LLM whether an
// attack is an attack has already lost. (The DeepSeek lane stays available to
// ANNOTATE quarantined payloads asynchronously; it never decides.)
// ─────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_STRING = 20_000;          // one payload string
const MAX_PAYLOAD_BYTES = 256_000;  // whole payload, serialized
const MAX_DEPTH = 12;

// Carriers, not vocabulary: matching words like "select" would quarantine a
// trip note that says "selected route". These match structural attack shapes.
const THREAT_PATTERNS = [
  { re: /<\s*script[\s>]/i, tag: 'script-tag' },
  { re: /javascript\s*:/i, tag: 'js-uri' },
  { re: /on(?:error|load|click)\s*=/i, tag: 'inline-handler' },
  { re: /;\s*(?:drop|truncate|delete)\s+(?:table|from)\s/i, tag: 'sql-chain' },
  { re: /union\s+select\s/i, tag: 'sql-union' },
  { re: /\$\{.*\}/, tag: 'template-injection' },
];

// Money fields the fraud check recognizes across event payloads.
const MONEY_KEYS = /^(amount|freight|gross|net|advance|balance|rate|total|paid|payment|penalty)(_|$)/i;
const MONEY_ABSURD = 1e11; // ₹100 crore in one event is not transport, it is fraud or corruption

function sanitizeValue(value, audit, depth, path) {
  if (depth > MAX_DEPTH) { audit.threats.push(`depth>${MAX_DEPTH} at ${path}`); return null; }

  if (typeof value === 'string') {
    let v = value;
    // eslint-disable-next-line no-control-regex
    const stripped = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
    if (stripped !== v) { audit.healed.push(`control-chars stripped at ${path}`); v = stripped; }
    if (v.length > MAX_STRING) { audit.healed.push(`string truncated at ${path}`); v = v.slice(0, MAX_STRING); }
    for (const { re, tag } of THREAT_PATTERNS) {
      if (re.test(v)) audit.threats.push(`${tag} at ${path}`);
    }
    return v;
  }

  if (Array.isArray(value)) {
    return value.map((item, i) => sanitizeValue(item, audit, depth + 1, `${path}[${i}]`));
  }

  if (value && typeof value === 'object') {
    const clean = {};
    for (const [rawKey, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(rawKey)) { audit.threats.push(`proto-pollution key '${rawKey}' at ${path}`); continue; }
      const key = rawKey.trim();
      if (key !== rawKey) audit.healed.push(`key '${rawKey}' trimmed at ${path}`);
      clean[key] = sanitizeValue(v, audit, depth + 1, `${path}.${key}`);
    }
    return clean;
  }

  return value; // numbers, booleans, null pass through
}

function fraudCheck(payload, audit, path = '$') {
  if (!payload || typeof payload !== 'object') return;
  for (const [key, value] of Object.entries(payload)) {
    if (MONEY_KEYS.test(key)) {
      // Money arrives as numeric strings by design (pool.js keeps NUMERIC as
      // text). Validate the magnitude WITHOUT converting the stored value.
      const n = Number(value);
      if (Number.isFinite(n)) {
        if (n < 0) audit.threats.push(`negative money '${key}' at ${path} — corrections are reversing entries, never negatives`);
        if (Math.abs(n) > MONEY_ABSURD) audit.threats.push(`absurd magnitude '${key}'=${value} at ${path}`);
      }
    }
    if (value && typeof value === 'object') fraudCheck(value, audit, `${path}.${key}`);
  }
}

/** Build the shield node. deps: { activeHalt, runAgentDuty } */
export function makeBagalamukhiNode({ activeHalt, runAgentDuty }) {
  return async function bagalamukhiNode(state) {
    const started = Date.now();
    const audit = { status: 'PENDING', threats: [], healed: [], sanitized: false };

    // Non-object payload is healed, not rejected — legacy emitters exist.
    let payload = state.payload;
    if (payload == null || typeof payload !== 'object') {
      audit.healed.push('payload wrapped into { value }');
      payload = { value: payload };
    }
    if (JSON.stringify(payload).length > MAX_PAYLOAD_BYTES) {
      audit.threats.push(`payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
      payload = {};
    }

    payload = sanitizeValue(payload, audit, 0, '$');
    fraudCheck(payload, audit);
    audit.sanitized = true;

    // A swarm-wide halt is itself a defense verdict: while halted, only infra
    // traffic (Bagalamukhi's own domain — including the resume) may flow.
    const halt = await activeHalt(null).catch(() => null);
    if (halt && state.aggregate !== 'infra') {
      audit.threats.push(`swarm halted: ${halt.reason}`);
    }

    audit.status = audit.threats.length ? 'QUARANTINED' : 'PASS';

    const results = [...state.execution_results, {
      node: 'bagalamukhi', agent_id: 'AGENT_08',
      outcome: audit.status === 'PASS' ? 'OK' : 'BLOCKED',
      reason: audit.status === 'PASS'
        ? (audit.healed.length ? `clean after ${audit.healed.length} heal(s)` : 'clean')
        : audit.threats.join('; '),
      duration_ms: Date.now() - started,
    }];

    // AGENT_08's own scheduled duty (infra.tunnel.check etc.) executes inside
    // the shield visit — the defense agent is its own worker.
    if (audit.status === 'PASS' && runAgentDuty) {
      const duty = await runAgentDuty('AGENT_08', { ...state, payload });
      if (duty) results.push(duty);
    }

    return { payload, security_audit: audit, execution_results: results };
  };
}

/** Conditional router out of the shield. */
export function shieldRouter(state) {
  return state.security_audit.status === 'QUARANTINED' ? 'quarantine' : 'pass';
}
