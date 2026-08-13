// scripts/erp_api_shield.cjs
// ERP API SHIELD — exponential backoff + rate-limit + circuit-breaker
// decorator for the external transport APIs (Vahan, Sarathi, E-Way Bill, GST
// portal, GTROPY FASTag). Government portals go down or throttle routinely;
// this layer keeps those outages from cascading into ERP crashes.
//
//   const { createShield } = require('./scripts/erp_api_shield.cjs');
//   const vahan = createShield('VAHAN');
//   const fetchRC = vahan.wrap(async (regNo) => axios.get(url(regNo)));
//   await fetchRC('MH12AB1234');   // retried/backed-off/breaker-guarded
//
// Behavior per call:
//   1. RATE LIMIT  token bucket (ratePerMin). If the bucket is dry the call
//      WAITS its turn, up to maxQueueWaitMs — then RateLimitError. No silent
//      drops: a limited call either runs late or fails loud.
//   2. BREAKER     after breakerThreshold consecutive failures the circuit
//      OPENs: calls fail fast with CircuitOpenError (no hammering a dead
//      government server). After breakerCooldownMs ONE trial call goes
//      through (half-open); success closes the circuit.
//   3. RETRY       retryable failures (network errno + HTTP 408/425/429/5xx,
//      axios-style err.response honored) retry with exponential backoff +
//      full jitter; a Retry-After header wins over the computed delay.
//
// Breaker transitions and retry exhaustion are logged to logs/erp_system.log
// (agent "erp-api-shield"). Self-test (offline, deterministic):
//   node scripts/erp_api_shield.cjs --self-test
'use strict';

const { slog } = require('./erp_system_log.cjs');

const AGENT = 'erp-api-shield';

class ShieldError extends Error {
  constructor(msg, code, meta) { super(msg); this.name = this.constructor.name; this.code = code; this.meta = meta || {}; }
}
class RateLimitError extends ShieldError {}
class CircuitOpenError extends ShieldError {}
class RetriesExhaustedError extends ShieldError {}

const RETRYABLE_ERRNO = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE',
  'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_SOCKET_TIMEOUT',
]);
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function httpStatus(err) {
  if (!err) return null;
  if (Number.isInteger(err.status)) return err.status;                 // fetch-style
  if (err.response && Number.isInteger(err.response.status)) return err.response.status; // axios
  return null;
}

function isRetryable(err) {
  const st = httpStatus(err);
  if (st !== null) return RETRYABLE_STATUS.has(st);
  if (err && RETRYABLE_ERRNO.has(err.code)) return true;
  if (err && err.name === 'AbortError') return true;
  return false; // unknown app-level error: fail loud, do not mask with retries
}

function retryAfterMs(err) {
  const h = err && err.response && err.response.headers;
  const v = h && (h['retry-after'] || h['Retry-After']);
  if (!v) return null;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const when = Date.parse(v);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEFAULTS = {
  maxRetries: 3,          // attempts = maxRetries + 1
  baseDelayMs: 2000,
  maxDelayMs: 60000,
  ratePerMin: 30,
  burst: null,            // bucket capacity; default = ratePerMin
  maxQueueWaitMs: 90000,
  breakerThreshold: 5,
  breakerCooldownMs: 120000,
};

// Government portals get gentler pacing than commercial APIs.
const PRESETS = {
  VAHAN:    { ratePerMin: 20, baseDelayMs: 3000, breakerCooldownMs: 300000 },
  SARATHI:  { ratePerMin: 20, baseDelayMs: 3000, breakerCooldownMs: 300000 },
  EWAYBILL: { ratePerMin: 30, baseDelayMs: 2000, breakerCooldownMs: 180000 },
  GST:      { ratePerMin: 30, baseDelayMs: 2000, breakerCooldownMs: 180000 },
  GTROPY:   { ratePerMin: 60, baseDelayMs: 1000, breakerCooldownMs: 60000 },
};

class ApiShield {
  constructor(name, opts = {}) {
    this.name = String(name || 'API').toUpperCase();
    this.cfg = { ...DEFAULTS, ...(PRESETS[this.name] || {}), ...opts };
    this.cfg.burst = this.cfg.burst || this.cfg.ratePerMin;
    // token bucket
    this._tokens = this.cfg.burst;
    this._lastRefill = Date.now();
    // breaker
    this._state = 'CLOSED';           // CLOSED | OPEN | HALF_OPEN
    this._consecFails = 0;
    this._openedAt = 0;
    this._stats = { calls: 0, retries: 0, rateWaits: 0, breakerFastFails: 0 };
  }

  state() {
    return { name: this.name, breaker: this._state, tokens: Math.floor(this._tokens),
             consecFails: this._consecFails, ...this._stats };
  }

  _refill() {
    const now = Date.now();
    this._tokens = Math.min(this.cfg.burst,
      this._tokens + ((now - this._lastRefill) / 60000) * this.cfg.ratePerMin);
    this._lastRefill = now;
  }

  async _acquire() {
    this._refill();
    if (this._tokens >= 1) { this._tokens -= 1; return; }
    const waitMs = ((1 - this._tokens) / this.cfg.ratePerMin) * 60000;
    if (waitMs > this.cfg.maxQueueWaitMs) {
      throw new RateLimitError(`${this.name}: rate queue full (${Math.round(waitMs / 1000)}s wait)`,
                               'SHIELD_RATE_LIMIT', { waitMs });
    }
    this._stats.rateWaits += 1;
    await sleep(waitMs);
    this._refill();
    this._tokens = Math.max(0, this._tokens - 1);
  }

  _breakerGate() {
    if (this._state !== 'OPEN') return;
    if (Date.now() - this._openedAt >= this.cfg.breakerCooldownMs) {
      this._transition('HALF_OPEN', 'cooldown elapsed — one trial call allowed');
      return;
    }
    this._stats.breakerFastFails += 1;
    throw new CircuitOpenError(
      `${this.name}: circuit OPEN (fail-fast; retry after cooldown)`,
      'SHIELD_CIRCUIT_OPEN',
      { openForMs: Date.now() - this._openedAt, cooldownMs: this.cfg.breakerCooldownMs });
  }

  _onSuccess() {
    this._consecFails = 0;
    if (this._state !== 'CLOSED') this._transition('CLOSED', 'call succeeded');
  }

  _onFailure(err) {
    this._consecFails += 1;
    if (this._state === 'HALF_OPEN') {
      this._transition('OPEN', `half-open trial failed: ${err && err.message}`);
    } else if (this._state === 'CLOSED' && this._consecFails >= this.cfg.breakerThreshold) {
      this._transition('OPEN', `${this._consecFails} consecutive failures`);
    }
  }

  _transition(next, why) {
    const prev = this._state;
    this._state = next;
    if (next === 'OPEN') this._openedAt = Date.now();
    slog(AGENT, next === 'OPEN' ? 'GATE_FAIL' : 'GATE_PASS', {
      cycle: 'shield',
      fail_codes: next === 'OPEN' ? ['API_CIRCUIT_OPEN'] : [],
      extra: { api: this.name, from: prev, to: next, why: String(why).slice(0, 200) },
    });
  }

  async call(fn, ...args) {
    this._breakerGate();
    await this._acquire();
    this._stats.calls += 1;
    let lastErr = null;
    for (let attempt = 0; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const res = await fn(...args);
        this._onSuccess();
        return res;
      } catch (err) {
        lastErr = err;
        this._onFailure(err);
        const retryable = isRetryable(err);
        if (!retryable || attempt === this.cfg.maxRetries || this._state === 'OPEN') {
          if (retryable && attempt === this.cfg.maxRetries) {
            slog(AGENT, 'GATE_FAIL', {
              cycle: 'shield', fail_codes: ['API_RETRIES_EXHAUSTED'],
              extra: { api: this.name, attempts: attempt + 1,
                       err: String(err && err.message).slice(0, 200),
                       status: httpStatus(err) },
            });
            throw new RetriesExhaustedError(
              `${this.name}: ${attempt + 1} attempts failed — last: ${err && err.message}`,
              'SHIELD_RETRIES_EXHAUSTED', { attempts: attempt + 1, cause: err });
          }
          throw err; // non-retryable (or breaker just opened): propagate as-is
        }
        this._stats.retries += 1;
        const backoff = Math.min(this.cfg.maxDelayMs,
                                 this.cfg.baseDelayMs * 2 ** attempt);
        const jittered = backoff * (0.5 + Math.random() * 0.5);
        await sleep(retryAfterMs(err) ?? jittered);
      }
    }
    throw lastErr; // unreachable, kept for safety
  }

  wrap(fn) {
    const shield = this;
    return function shielded(...args) { return shield.call(fn, ...args); };
  }
}

function createShield(name, opts) { return new ApiShield(name, opts); }

module.exports = { ApiShield, createShield, PRESETS,
                   ShieldError, RateLimitError, CircuitOpenError, RetriesExhaustedError,
                   isRetryable };

// ── self-test (offline, no real APIs) ────────────────────────────────────────
if (require.main === module && process.argv.includes('--self-test')) {
  (async () => {
    const assert = require('assert');

    // 1. retry: fails twice with ECONNRESET, then succeeds
    const s1 = createShield('TEST1', { baseDelayMs: 5, maxRetries: 3 });
    let n = 0;
    const flaky = async () => {
      n += 1;
      if (n < 3) { const e = new Error('reset'); e.code = 'ECONNRESET'; throw e; }
      return 'ok';
    };
    assert.strictEqual(await s1.call(flaky), 'ok');
    assert.strictEqual(n, 3);
    console.log('[1/4] retry-then-succeed          PASS');

    // 2. non-retryable error propagates immediately (no retries)
    const s2 = createShield('TEST2', { baseDelayMs: 5 });
    let m = 0;
    const appErr = async () => { m += 1; const e = new Error('bad request'); e.response = { status: 400 }; throw e; };
    await assert.rejects(() => s2.call(appErr), /bad request/);
    assert.strictEqual(m, 1);
    console.log('[2/4] non-retryable-no-retry      PASS');

    // 3. breaker opens after threshold, then fails fast
    const s3 = createShield('TEST3', { baseDelayMs: 1, maxRetries: 0, breakerThreshold: 3, breakerCooldownMs: 60000 });
    const dead = async () => { const e = new Error('down'); e.code = 'ETIMEDOUT'; throw e; };
    for (let i = 0; i < 3; i++) await assert.rejects(() => s3.call(dead));
    await assert.rejects(() => s3.call(dead), CircuitOpenError);
    assert.strictEqual(s3.state().breaker, 'OPEN');
    console.log('[3/4] breaker-opens-fails-fast    PASS');

    // 4. rate limiter delays the burst+1-th call
    const s4 = createShield('TEST4', { ratePerMin: 600, burst: 2, maxQueueWaitMs: 5000 });
    const t0 = Date.now();
    const quick = async () => 'y';
    await s4.call(quick); await s4.call(quick); await s4.call(quick);
    assert.ok(Date.now() - t0 >= 80, 'third call should have waited ~100ms');
    console.log('[4/4] rate-limit-queues           PASS');

    console.log('ERP API SHIELD self-test: ALL PASS');
  })().catch((e) => { console.error('SELF-TEST FAIL:', e); process.exit(1); });
}
