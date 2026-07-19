// 🔬 Phase 1 gate: verify Firebase Auth can consume our PBKDF2-SHA256 hashes
// (salt-hex + 100k rounds, as produced by src/lib/passwords.ts) via
// auth.importUsers — so real staff keep their existing passwords.
// Creates a throwaway user with a KNOWN password, imports its hash, then
// attempts a real signInWithPassword against Identity Toolkit. Cleans up.
const crypto = require('crypto');
const admin = require('E:/PRASAD-TRANSPORT-ERP/whatsapp-server/node_modules/firebase-admin');

admin.initializeApp({ credential: admin.credential.cert(require('E:/PRASAD-TRANSPORT-ERP/google-key.json')) });

const WEB_KEY = 'AIzaSyBzbSLXzmbOvaQlCZKFuUcJqPLGp_a6Bv8';
const EMAIL = 'hashcompat-test@prasad-internal.test';
const PASSWORD = 'Test@1234#compat';
const ITER = 100000;

(async () => {
  const auth = admin.auth();
  // cleanup any previous run
  try { const u = await auth.getUserByEmail(EMAIL); await auth.deleteUser(u.uid); } catch {}

  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(PASSWORD, salt, ITER, 32, 'sha256');

  const res = await auth.importUsers(
    [{ uid: 'hash-compat-test-uid', email: EMAIL, passwordHash: hash, passwordSalt: salt }],
    { hash: { algorithm: 'PBKDF2_SHA256', rounds: ITER } }
  );
  console.log('import:', res.successCount, 'ok,', res.failureCount, 'failed', res.errors.map(e => e.error.message));
  if (res.failureCount) process.exit(1);

  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${WEB_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, returnSecureToken: true }),
  });
  const j = await r.json();
  if (j.idToken) console.log('✅ SIGN-IN OK — PBKDF2 hashes are COMPATIBLE. Staff keep their passwords.');
  else console.log('❌ SIGN-IN FAILED:', JSON.stringify(j.error || j).slice(0, 200));

  await auth.deleteUser('hash-compat-test-uid').catch(() => {});
  process.exit(j.idToken ? 0 : 2);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
