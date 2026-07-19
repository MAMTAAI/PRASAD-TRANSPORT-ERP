// 🔒 One-time security migration: convert plaintext USERS passwords to salted
// PBKDF2-HMAC-SHA256 hashes (100k iterations, matches src/lib/passwords.ts),
// then DELETE the plaintext field. Idempotent — docs without a `password`
// field are skipped. Never prints password values.
//
// Run: node scripts/migrate-passwords.cjs
const path = require('path');
const crypto = require('crypto');
const admin = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'firebase-admin'));

const ITERATIONS = 100000;

admin.initializeApp({
  credential: admin.credential.cert(require(path.join(__dirname, '..', 'google-key.json'))),
});
const db = admin.firestore();

(async () => {
  const snap = await db.collection('USERS').get();
  let migrated = 0, skipped = 0;
  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    if (typeof data.password !== 'string' || data.password === '') { skipped++; continue; }
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(data.password, Buffer.from(salt, 'hex'), ITERATIONS, 32, 'sha256').toString('hex');
    await docSnap.ref.update({
      password_hash: hash,
      password_salt: salt,
      password: admin.firestore.FieldValue.delete(),
    });
    migrated++;
    console.log(`migrated: ${docSnap.id} (${data.email || 'no-email'})`);
  }
  console.log(`\nDone. ${migrated} migrated, ${skipped} already clean, ${snap.size} total USERS docs.`);
  process.exit(0);
})().catch(e => { console.error('MIGRATION FAILED:', e.message); process.exit(1); });
