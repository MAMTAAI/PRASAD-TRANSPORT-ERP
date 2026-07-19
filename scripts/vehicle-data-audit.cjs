#!/usr/bin/env node
// READ-ONLY audit: where does vehicle data actually live?
// Lists all collections + counts, then samples vehicle-ish collections.
const path = require('path');
const admin = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'firebase-admin'));
const serviceAccount = require(path.join(__dirname, '..', 'whatsapp-server', 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

(async () => {
  const collections = await db.listCollections();
  console.log('== ALL COLLECTIONS ==');
  const vehicleish = [];
  for (const c of collections) {
    const snap = await c.count().get();
    const n = snap.data().count;
    console.log(`  ${c.id}: ${n}`);
    if (/veh|asset|fleet/i.test(c.id)) vehicleish.push(c.id);
  }
  console.log('\n== VEHICLE-ISH COLLECTIONS: sample docs ==');
  for (const id of vehicleish) {
    const snap = await db.collection(id).limit(50).get();
    console.log(`\n-- ${id} (${snap.size} sampled) --`);
    snap.docs.slice(0, 50).forEach(d => {
      const v = d.data();
      const no = v.vehicle_no || v.Vehicle_No || v.vehical_no || v.Vehical_No || '?';
      const keys = Object.keys(v).slice(0, 14).join(',');
      console.log(`  ${d.id} | no=${no} | own_attach=${v.own_attach || v.asset_type || '-'} | fastag=${v.fastag_id || '-'} | keys: ${keys}`);
    });
  }
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
