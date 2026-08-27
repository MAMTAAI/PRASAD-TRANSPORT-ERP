// server/lib/waLinkGuard.selftest.js
// ─────────────────────────────────────────────────────────────────────────────
//   node server/lib/waLinkGuard.selftest.js
//
// Exercises the WhatsApp-link boundary with no database, network or browser.
// The rule it guards is small and the cost of getting it wrong is not: too
// tight and the office cannot link at all, too loose and any signed-in driver
// can attach a readable device to a dispatch session. Both failures look
// normal from the outside, which is why they are asserted here rather than
// discovered.
// ─────────────────────────────────────────────────────────────────────────────
import { makeWaLinkGuard, mayLinkWhatsapp, INTERNAL_ROLES, STAFF_ONLY_MESSAGE } from './waLinkGuard.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${name}${ok ? '' : `  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
};

function fakeReply() {
  const r = { statusCode: null, body: null, sent: false };
  r.code = (c) => { r.statusCode = c; return r; };
  r.send = (b) => { r.body = b; r.sent = true; return r; };
  return r;
}

/** requireAuth that always succeeds, having populated req.user. */
const authOk = async () => undefined;
/** requireAuth that rejects — the guard must let its reply stand. */
const auth401 = async (req, reply) => reply.code(401).send({ error: 'NO_TOKEN' });

// The whole user_role enum: migration 001_core.sql + VENDOR from 047.
const ALL_ROLES = ['SUPER_ADMIN', 'ADMIN', 'ACCOUNTS', 'DISPATCH', 'DRIVER', 'CUSTOMER', 'VIEWER', 'VENDOR'];

console.log('\nROLE PREDICATE — every value the enum can hold');
for (const role of ALL_ROLES) {
  check(`${role}`, mayLinkWhatsapp(role), INTERNAL_ROLES.includes(role));
}

console.log('\nTHE TRAPS');
// 'STAFF' is not a role. It is ProfileMenu.tsx's display fallback for a user
// with no role at all, and a gate written literally as "ADMIN and STAFF" would
// have admitted this string while locking out ACCOUNTS, DISPATCH and
// SUPER_ADMIN. Asserted so nobody re-adds it believing it means something.
check("'STAFF' is not a role and is refused", mayLinkWhatsapp('STAFF'), false);
check('no role at all is refused', mayLinkWhatsapp(undefined), false);
check('null role is refused', mayLinkWhatsapp(null), false);
check('empty role is refused', mayLinkWhatsapp(''), false);
// Deny rather than throw: an exception here surfaces as a 500 and gets read as
// "the WhatsApp engine is down", sending the operator to fix the wrong thing.
check('a nonsense role is refused, not thrown', mayLinkWhatsapp({}), false);
check('lowercase still admits an admin', mayLinkWhatsapp('admin'), true);
check('padding still admits an admin', mayLinkWhatsapp('  ADMIN  '), true);

console.log('\nTHE MESSAGE — support quotes this back verbatim');
check('exact wording', STAFF_ONLY_MESSAGE, 'WhatsApp auto-link is strictly reserved for Staff and Admin.');

console.log('\nGUARD BEHAVIOUR — the preHandler the routes actually run');
const guard = makeWaLinkGuard(authOk);

for (const role of INTERNAL_ROLES) {
  const reply = fakeReply();
  const out = await guard({ user: { role } }, reply);
  check(`${role} passes through`, out === undefined && !reply.sent, true);
}

for (const role of ['DRIVER', 'CUSTOMER', 'VENDOR', 'VIEWER']) {
  const reply = fakeReply();
  await guard({ user: { role } }, reply);
  check(`${role} is refused 403`, reply.statusCode, 403);
  check(`${role} gets the STAFF_ONLY code`, reply.body?.error, 'STAFF_ONLY');
  check(`${role} gets the message`, reply.body?.detail, STAFF_ONLY_MESSAGE);
}

// A driver holds a REAL token — /otp/verify issues them — so this is the case
// that was actually open before the gate existed, not a hypothetical one.
console.log('\nTHE HOLE THIS CLOSED');
const drvReply = fakeReply();
await guard({ user: { role: 'DRIVER', sub: 'a-real-driver-id' } }, drvReply);
check('an authenticated driver cannot link', drvReply.statusCode, 403);

console.log('\nDEFERENCE — an unauthenticated caller is 401, never 403');
// Reporting 403 here would tell someone with no token that they had the wrong
// ROLE, which is both wrong and a hint they have not earned.
const unauth = makeWaLinkGuard(auth401);
const unauthReply = fakeReply();
await unauth({}, unauthReply);
check('requireAuth reply stands', unauthReply.statusCode, 401);
check('guard did not overwrite it', unauthReply.body?.error, 'NO_TOKEN');

console.log(failures === 0
  ? '\n✅ waLinkGuard: all checks passed\n'
  : `\n❌ waLinkGuard: ${failures} check(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
