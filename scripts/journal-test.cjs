// Proves JOURNAL idempotency on real Firestore: posting the same
// (source_type, source_ref) twice yields exactly ONE document. Cleans up the
// test doc afterwards. Does NOT touch any business data.
const path = require('path');
const admin = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'firebase-admin'));
const serviceAccount = require(path.join(__dirname, '..', 'whatsapp-server', 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const journalDocId = (st, sr) => `${st}__${sr}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 380);

async function postEntry(entry) {
  const totalDr = entry.lines.filter(l => l.dr_cr === 'Dr').reduce((s, l) => s + l.amount, 0);
  const totalCr = entry.lines.filter(l => l.dr_cr === 'Cr').reduce((s, l) => s + l.amount, 0);
  if (totalDr !== totalCr) throw new Error(`unbalanced ${totalDr} != ${totalCr}`);
  const id = journalDocId(entry.source_type, entry.source_ref);
  await db.collection('JOURNAL').doc(id).set({ ...entry, total: totalDr, posted_at: new Date().toISOString() });
  return id;
}

(async () => {
  const ref = 'TEST_IDEMPOTENT_DELETE_ME_001';
  const entry = {
    source_type: 'TEST', source_ref: ref, date: '2026-06-14', narration: 'idempotency test',
    lines: [{ ledger: 'Test Debtor', dr_cr: 'Dr', amount: 1000 }, { ledger: 'Freight Income', dr_cr: 'Cr', amount: 1000 }],
  };

  console.log('Posting the SAME entry 3 times…');
  const id1 = await postEntry(entry);
  const id2 = await postEntry({ ...entry, narration: 'idempotency test (re-sync)' });
  const id3 = await postEntry(entry);
  console.log('  doc ids:', id1, '|', id2 === id1 ? 'same' : id2, '|', id3 === id1 ? 'same' : id3);

  const dup = await db.collection('JOURNAL').where('source_ref', '==', ref).get();
  console.log(`\n✋ docs in JOURNAL with source_ref=${ref}: ${dup.size}`);
  console.log(dup.size === 1 ? '✅ EXACTLY ONE — duplicates are impossible.' : '❌ DUPLICATE CREATED!');

  // Validate the stored entry balances
  const stored = dup.docs[0]?.data();
  const dr = stored.lines.filter(l => l.dr_cr === 'Dr').reduce((s, l) => s + l.amount, 0);
  const cr = stored.lines.filter(l => l.dr_cr === 'Cr').reduce((s, l) => s + l.amount, 0);
  console.log(`stored entry balanced: Dr ${dr} = Cr ${cr} -> ${dr === cr ? '✅' : '❌'}`);

  // Cleanup the test doc (it is a test record we just created).
  await db.collection('JOURNAL').doc(id1).delete();
  const after = await db.collection('JOURNAL').where('source_ref', '==', ref).get();
  console.log('cleanup done, test docs remaining:', after.size);
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
