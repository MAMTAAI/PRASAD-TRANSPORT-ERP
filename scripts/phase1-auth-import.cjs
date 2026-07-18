// 🔐 Phase 1: import all USERS into Firebase Authentication.
// uid = the existing Firestore USERS doc id (so rules can do
// get(/USERS/$(request.auth.uid)) role lookups directly), password hashes
// carried over via PBKDF2_SHA256 import — staff keep their passwords.
// Idempotent: already-imported uids are skipped.
const admin = require('E:/PRASAD-TRANSPORT-ERP/whatsapp-server/node_modules/firebase-admin');
admin.initializeApp({ credential: admin.credential.cert(require('E:/PRASAD-TRANSPORT-ERP/google-key.json')) });

(async () => {
  const db = admin.firestore();
  const auth = admin.auth();
  const snap = await db.collection('USERS').get();
  const toImport = [];
  for (const d of snap.docs) {
    const u = d.data();
    const email = String(u.email || '').trim().toLowerCase();
    if (!email || !u.password_hash || !u.password_salt) { console.log('skip (no email/hash):', d.id, email || '-'); continue; }
    try { await auth.getUser(d.id); console.log('already imported:', email); continue; } catch {}
    toImport.push({
      uid: d.id,
      email,
      displayName: u.full_name || '',
      disabled: u.status === 'INACTIVE',
      passwordHash: Buffer.from(u.password_hash, 'hex'),
      passwordSalt: Buffer.from(u.password_salt, 'hex'),
    });
  }
  if (!toImport.length) { console.log('nothing to import'); process.exit(0); }
  const res = await auth.importUsers(toImport, { hash: { algorithm: 'PBKDF2_SHA256', rounds: 100000 } });
  console.log(`imported: ${res.successCount} ok, ${res.failureCount} failed`);
  res.errors.forEach(e => console.log('  error idx', e.index, e.error.message));
  process.exit(res.failureCount ? 1 : 0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
