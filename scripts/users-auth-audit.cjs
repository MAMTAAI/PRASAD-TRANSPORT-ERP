#!/usr/bin/env node
// READ-ONLY: compare USERS docs (Firestore) vs Firebase Auth accounts.
// isStaff() rules need USERS/{auth.uid} to EXIST — any mismatch = staff-only
// collections (VEHICLES etc.) silently read-denied => "missing old data".
const path = require('path');
const admin = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'firebase-admin'));
const serviceAccount = require(path.join(__dirname, '..', 'whatsapp-server', 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

(async () => {
  const usersSnap = await db.collection('USERS').get();
  console.log('== USERS docs (Firestore) ==');
  const docsByEmail = new Map();
  usersSnap.docs.forEach(d => {
    const u = d.data();
    console.log(`  docId=${d.id} | email=${u.email || '-'} | role=${u.role || '-'} | status=${u.status || '-'} | name=${u.full_name || u.name || '-'}`);
    if (u.email) docsByEmail.set(String(u.email).toLowerCase(), d.id);
  });

  console.log('\n== Firebase Auth users ==');
  const list = await admin.auth().listUsers(100);
  list.users.forEach(u => {
    const provider = (u.providerData || []).map(p => p.providerId).join(',') || 'anonymous';
    const docId = docsByEmail.get(String(u.email || '').toLowerCase());
    const match = docId === u.uid ? '✅ uid-keyed' : docId ? `❌ MISMATCH (doc=${docId})` : (u.email ? '❌ NO USERS DOC' : '(anonymous)');
    console.log(`  uid=${u.uid} | email=${u.email || '-'} | provider=${provider} | ${match}`);
  });
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
