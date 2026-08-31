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

// ── TRACK_ONLY ───────────────────────────────────────────────────────────────
// The scope handed out by POST /auth/driver/track, which anyone able to read a
// number off the side of a truck can obtain. Its reach is the single most
// security-relevant thing in this file, so it is asserted rather than trusted.
console.log('\nTRACK_ONLY SESSIONS — one route, and only one');
const trackAuth = async (rq, reply) => {
  const h = rq.headers?.authorization ?? '';
  if (!h.startsWith('Bearer ')) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
  rq.user = { sub: 'driver', role: 'DRIVER', scope: 'TRACK_ONLY' };
};
const trackGuard = makeApiGuard({ requireAuth: trackAuth, serviceToken: SECRET });
const asDriver = (method, path) => req(method, path, { authorization: 'Bearer ' + 'z'.repeat(40) });

check('POST /api/v1/tracking/ping is allowed',
  await run(trackGuard, asDriver('POST', '/api/v1/tracking/ping')), 'allowed');

// Everything a stranger in a lorry park must NOT be able to reach. The assertion
// is REFUSED, not a particular code: POST /ops/trips is a SERVICE_API route, so
// a caller holding a session bearer instead of the service secret is turned away
// at 401 before the scope check is ever reached. Refused is refused; pinning the
// number here would make this test fail the next time a route joins that list,
// which is not a change in what a driver can do.
const refused = (r) => (r === 'allowed' ? 'allowed' : 'refused');
for (const [m, p] of [
  ['GET',  '/api/v1/masters/drivers'],
  ['GET',  '/api/v1/ops/trips'],
  ['POST', '/api/v1/ops/trips'],
  ['GET',  '/api/v1/finance/ledger'],
  ['GET',  '/api/v1/dashboard/v5'],
  ['GET',  '/api/v1/tracking'],              // the fleet board itself
  ['GET',  '/api/v1/tracking/ping'],         // same path, wrong method
  ['POST', '/api/v1/crm/send'],
]) {
  check(`${m} ${p} refused`, refused(await run(trackGuard, asDriver(m, p))), 'refused');
}
// And the ones that are not service routes are refused with the scope's own
// code, so the app can tell "wrong door" from "no session".
check('a plain route refuses TRACK_ONLY with 403',
  await run(trackGuard, asDriver('GET', '/api/v1/dashboard/v5')), 403);

// A FULL driver session must not be caught by the same rule — the link login
// exists precisely so a driver gets the whole duty screen.
const fullAuth = async (rq, reply) => {
  const h = rq.headers?.authorization ?? '';
  if (!h.startsWith('Bearer ')) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
  rq.user = { sub: 'driver', role: 'DRIVER' };   // no scope
};
const fullGuard = makeApiGuard({ requireAuth: fullAuth, serviceToken: SECRET });
check('a full driver session still reaches its trips',
  await run(fullGuard, asDriver('GET', '/api/v1/ops/trips')), 'allowed');

// And an unauthenticated caller is still 401, not 403: the scope check must run
// AFTER the session check, never instead of it.
check('no session is still 401, not 403',
  await run(trackGuard, req('POST', '/api/v1/tracking/ping')), 401);

// ── EXTERNAL ROLES ────────────────────────────────────────────────────────────
// A full driver/vendor/customer session is confined to its own corner of the
// API. This is the second half of the same inversion as TRACK_ONLY: role, not
// just scope. Staff roles are untouched — asserted at the end.
console.log('\nEXTERNAL ROLES — confined to their own corner');
const asRole = (role) => async (rq, reply) => {
  const h = rq.headers?.authorization ?? '';
  if (!h.startsWith('Bearer ')) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
  rq.user = { sub: 'party', role };
};
const roleGuard = (role) => makeApiGuard({ requireAuth: asRole(role), serviceToken: SECRET });
const bear = (method, path) => req(method, path, { authorization: 'Bearer ' + 'z'.repeat(40) });
const refused2 = (r) => (r === 'allowed' ? 'allowed' : 'refused');

// What every external role KEEPS.
for (const role of ['DRIVER', 'VENDOR', 'CUSTOMER']) {
  const g = roleGuard(role);
  check(`${role} reaches /portal/me`, await run(g, bear('GET', '/api/v1/portal/me')), 'allowed');
  check(`${role} reaches its own files`, await run(g, bear('GET', '/api/v1/files/drivers/x/dl.pdf')), 'allowed');
  check(`${role} reaches /auth/me`, await run(g, bear('GET', '/api/v1/auth/me')), 'allowed');
  check(`${role} reaches map cache`, await run(g, bear('GET', '/api/v1/maps/directions')), 'allowed');
  // What NO external role may reach — the office books and masters.
  check(`${role} refused finance`, refused2(await run(g, bear('GET', '/api/v1/finance/ledgers'))), 'refused');
  check(`${role} refused masters`, refused2(await run(g, bear('GET', '/api/v1/masters/customers'))), 'refused');
  check(`${role} refused dashboard`, refused2(await run(g, bear('GET', '/api/v1/dashboard/v5'))), 'refused');
  check(`${role} refused crm send`, refused2(await run(g, bear('POST', '/api/v1/crm/send'))), 'refused');
  check(`${role} refused with 403 not 401`, await run(g, bear('GET', '/api/v1/finance/ledgers')), 403);
}

// Role-specific surfaces: a DRIVER keeps the duty screen; a CUSTOMER does not.
check('DRIVER reaches its duty trips',
  await run(roleGuard('DRIVER'), bear('GET', '/api/v1/ops/trips')), 'allowed');
check('CUSTOMER cannot reach /ops',
  refused2(await run(roleGuard('CUSTOMER'), bear('GET', '/api/v1/ops/trips'))), 'refused');
// '/api/v1/vendor/' was a dead allow-list entry — no module ever registered
// that prefix (the fleet app lives under /portal/vendor/, inside the common
// prefix). Removed 2026-08-31; a dead entry must now REFUSE, so the next
// route that happens to match it cannot be opened by accident.
check('VENDOR refused at the dead /vendor/ prefix',
  refused2(await run(roleGuard('VENDOR'), bear('POST', '/api/v1/vendor/bills'))), 'refused');
check('VENDOR reaches its real bills door',
  await run(roleGuard('VENDOR'), bear('GET', '/api/v1/portal/vendor/bills')), 'allowed');
check('DRIVER cannot reach the vendor door',
  refused2(await run(roleGuard('DRIVER'), bear('POST', '/api/v1/vendor/bills'))), 'refused');

// Staff is NOT confined — the whole point is that the office ERP is unchanged.
const asStaff = async (rq, reply) => {
  const h = rq.headers?.authorization ?? '';
  if (!h.startsWith('Bearer ')) return reply.code(401).send({ error: 'UNAUTHENTICATED' });
  rq.user = { sub: 'boss', role: 'ADMIN' };
};
const staffGuard = makeApiGuard({ requireAuth: asStaff, serviceToken: SECRET });
check('ADMIN still reaches finance',
  await run(staffGuard, req('GET', '/api/v1/finance/ledgers', { authorization: 'Bearer abc' })), 'allowed');
check('ADMIN still reaches masters',
  await run(staffGuard, req('GET', '/api/v1/masters/customers', { authorization: 'Bearer abc' })), 'allowed');

console.log('\nTHE TWO NEW DOORS ARE PUBLIC — a driver has no session yet');
check('POST /api/v1/auth/driver/claim',
  await run(guard, req('POST', '/api/v1/auth/driver/claim')), 'allowed');
check('POST /api/v1/auth/driver/track',
  await run(guard, req('POST', '/api/v1/auth/driver/track')), 'allowed');
// Minting one is staff work and must NOT be public.
check('POST /api/v1/auth/driver/link needs a session',
  await run(guard, req('POST', '/api/v1/auth/driver/link')), 401);

console.log(failures === 0
  ? '\n✅ apiGuard: all checks passed\n'
  : `\n❌ apiGuard: ${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
