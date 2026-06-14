#!/usr/bin/env node
/**
 * Firestore FULL BACKUP — read-only. Dumps every collection (incl. subcollections)
 * to a timestamped JSON file under ./backups/. NEVER writes to Firestore.
 *
 * Usage:  node scripts/firestore-backup.cjs
 */
const path = require('path');
const fs = require('fs');

// firebase-admin lives in whatsapp-server/node_modules; service account key sits beside it.
const admin = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'firebase-admin'));
const serviceAccount = require(path.join(__dirname, '..', 'whatsapp-server', 'serviceAccountKey.json'));

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function dumpCollection(collRef, out) {
  const snap = await collRef.get();
  let docCount = 0;
  for (const doc of snap.docs) {
    docCount++;
    out[doc.id] = { __data__: doc.data(), __subcollections__: {} };
    // recurse into subcollections (read-only)
    const subs = await doc.ref.listCollections();
    for (const sub of subs) {
      out[doc.id].__subcollections__[sub.id] = {};
      await dumpCollection(sub, out[doc.id].__subcollections__[sub.id]);
    }
  }
  return docCount;
}

(async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupsDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const outFile = path.join(backupsDir, `firestore-backup-${stamp}.json`);

  console.log('Connecting to project: prasad-transport-grup');
  const collections = await db.listCollections();
  console.log(`Found ${collections.length} top-level collections:`, collections.map(c => c.id).join(', '));

  const backup = { __meta__: { project: 'prasad-transport-grup', takenAt: new Date().toISOString() }, collections: {} };
  const counts = {};
  for (const coll of collections) {
    backup.collections[coll.id] = {};
    const n = await dumpCollection(coll, backup.collections[coll.id]);
    counts[coll.id] = n;
    console.log(`  ✓ ${coll.id}: ${n} docs`);
  }

  fs.writeFileSync(outFile, JSON.stringify(backup, null, 2), 'utf8');
  const sizeMB = (fs.statSync(outFile).size / (1024 * 1024)).toFixed(2);
  console.log('\n✅ BACKUP COMPLETE');
  console.log('File:', outFile);
  console.log('Size:', sizeMB, 'MB');
  console.log('Doc counts:', JSON.stringify(counts));
  process.exit(0);
})().catch(err => {
  console.error('\n❌ BACKUP FAILED:', err.message);
  process.exit(1);
});
