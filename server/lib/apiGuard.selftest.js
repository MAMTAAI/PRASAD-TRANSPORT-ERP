// server/lib/apiGuard.selftest.js
// ─────────────────────────────────────────────────────────────────────────────
//   node server/lib/apiGuard.selftest.js
//
// Exercises every branch of the guard without a database, a network or a
// browser. It matters that this is cheap to run: the guard decides whether the
// firm's books are readable by the internet, and the failure mode is silent —
// a route that is accidentally public looks exactly like a route that works.
// ─────────────────────────────────────────────────────────────────────────────
import { makeApiGuard, PUBLIC_API, SERVICE_API } from './apiGuard.js';

const SECRET = 'x'.repeat(48);

let failures = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${got}, want ${want})`}`);
};

/** A reply that records what the guard did to it instead of sending anything. */
function fakeReply() {
  const r = { statusCode: null, body: null, sent: false };
  r.code = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = b; r.sent = true; return r; };
  return r;
}

const req = (method, url, headers = {}) => ({ method, url, raw: { url }, headers });

/** Stands in for the session guard: refuses unless a bearer is present. */
const requireAuth = async (rq, reply) => {
  const h = rq.headers?.authorization ?? '';
  if (!h.startsWith('Bearer ')) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
  rq.user = { sub: 'someone' };
};

/** Returns 'allowed' or the status the guard refused with. */
async function run(guard, rq) {
  const reply = fakeReply();
  await guard(rq, reply);
  return reply.sent ? reply.statusCode : 'allowed';
}

const guard = makeApiGuard({ requireAuth, serviceToken: SECRET });
const guardNoSecret = makeApiGuard({ requireAuth, serviceToken: undefined });

console.log('\nPUBLIC — reachable with no credential');
for (const entry of PUBLIC_API) {
  const [method, path] = entry.split(' ');
  check(entry, await run(guard, req(method, path)), 'allowed');
}

console.log('\nPROTECTED — refused without a session');
for (const path of [
  '/api/v1/masters/drivers',
  '/api/v1/finance/ledgers',
  '/api/v1/billing/bills',
  '/api/v1/masters/customers',
  '/api/v1/dashboard/v5',
  '/api/v1/tracking',
  '/api/v1/owners/matrix',
  '/api/vehicles',
  '/api/agents',
]) {
  check(`GET ${path}`, await run(guard, req('GET', path)), 401);
}

console.log('\nPROTECTED — allowed with a session');
check('GET /api/v1/masters/drivers (bearer)',
  await run(guard, req('GET', '/api/v1/masters/drivers', { authorization: 'Bearer abc' })), 'allowed');

console.log('\nMETHOD AND PATH ARE BOTH PART OF THE KEY');
// The onboarding POST is public; the same prefix under other methods is not.
// A Set keyed on the path alone would have opened all of them together.
check('GET /api/v1/bazaar/onboarding',
  await run(guard, req('GET', '/api/v1/bazaar/onboarding')), 401);
// The load board LOOKS like it should be public — the pre-login partner portal
// calls it — but it has carried requireAdminRole all along and answers 401 in
// production. Listing it would not have preserved behaviour, it would have
// published the load book. Same for /bids. Pinned so a future reading of the
// front end cannot talk somebody into opening them.
check('GET /api/v1/bazaar/loads', await run(guard, req('GET', '/api/v1/bazaar/loads')), 401);
check('POST /api/v1/bazaar/loads', await run(guard, req('POST', '/api/v1/bazaar/loads')), 401);
check('GET /api/v1/bazaar/bids', await run(guard, req('GET', '/api/v1/bazaar/bids')), 401);
check('POST /api/v1/bazaar/bids', await run(guard, req('POST', '/api/v1/bazaar/bids')), 401);
check('GET /api/v1/auth/login', await run(guard, req('GET', '/api/v1/auth/login')), 401);
// A query string must not defeat the match in either direction.
check('GET /api/v1/crm/website?x=1',
  await run(guard, req('GET', '/api/v1/crm/website?x=1')), 'allowed');
check('GET /api/v1/masters/drivers?x=1',
  await run(guard, req('GET', '/api/v1/masters/drivers?x=1')), 401);
// Prefix games: a path that merely STARTS with a public one is not that route.
check('GET /api/v1/crm/website/secret',
  await run(guard, req('GET', '/api/v1/crm/website/secret')), 401);

console.log('\nOUTSIDE /api/ — untouched');
check('GET /healthz', await run(guard, req('GET', '/healthz')), 'allowed');
check('GET /readyz', await run(guard, req('GET', '/readyz')), 'allowed');
check('GET /socket.io/', await run(guard, req('GET', '/socket.io/')), 'allowed');

console.log('\nCORS PREFLIGHT — never refused');
check('OPTIONS /api/v1/masters/drivers',
  await run(guard, req('OPTIONS', '/api/v1/masters/drivers')), 'allowed');

console.log('\nSERVICE ROUTES — secret configured');
for (const entry of SERVICE_API) {
  const [method, path] = entry.split(' ');
  check(`${entry} (no token)`, await run(guard, req(method, path)), 401);
  check(`${entry} (wrong token)`,
    await run(guard, req(method, path, { authorization: 'Bearer ' + 'y'.repeat(48) })), 401);
  check(`${entry} (right token)`,
    await run(guard, req(method, path, { authorization: `Bearer ${SECRET}` })), 'allowed');
  // A token of a different LENGTH must fail on the length check rather than
  // reaching timingSafeEqual, which throws on mismatched buffers.
  check(`${entry} (short token)`,
    await run(guard, req(method, path, { authorization: 'Bearer short' })), 401);
}

console.log('\nSERVICE ROUTES — no secret configured (open, loudly)');
for (const entry of SERVICE_API) {
  const [method, path] = entry.split(' ');
  check(`${entry} (unconfigured)`, await run(guardNoSecret, req(method, path)), 'allowed');
}
// The absence of a service secret must not open anything else.
check('GET /api/v1/masters/drivers (unconfigured)',
  await run(guardNoSecret, req('GET', '/api/v1/masters/drivers')), 401);

console.log(failures === 0
  ? '\n✅ apiGuard: all checks passed\n'
  : `\n❌ apiGuard: ${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
