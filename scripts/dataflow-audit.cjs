#!/usr/bin/env node
// READ-ONLY: field-presence statistics — how many records would each strict
// filter silently drop? The ground truth behind the "data not flowing" audit.
const path = require('path');
const admin = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'firebase-admin'));
const serviceAccount = require(path.join(__dirname, '..', 'whatsapp-server', 'serviceAccountKey.json'));
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const count = (arr, fn) => arr.filter(fn).length;
const dist = (arr, fn) => {
  const m = new Map();
  arr.forEach(x => { const k = String(fn(x) ?? '(missing)') || '(empty)'; m.set(k, (m.get(k) || 0) + 1); });
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ');
};

(async () => {
  const trips = (await db.collection('TRIPS').get()).docs.map(d => d.data());
  console.log(`== TRIPS (${trips.length}) ==`);
  console.log('billing_status:', dist(trips, t => t.billing_status));
  console.log('trip_status:', dist(trips, t => t.trip_status || t.Trip_Status));
  console.log('has unloading_date:', count(trips, t => t.unloading_date || t.Unloading_Date), '/', trips.length);
  console.log('operating_company:', dist(trips, t => (t.operating_company || t.Operating_Company || t.company || '').toString().trim().toUpperCase() || null));
  console.log('customer present:', count(trips, t => t.customer_name || t.Customer || t.Registered_Assessee), '/', trips.length);
  console.log('qty>0:', count(trips, t => parseFloat(t.qty || t.loaded_qty || t.Loaded_Qty || 0) > 0), '| rate>0:', count(trips, t => parseFloat(t.rate || t.freight_rate || 0) > 0), '| gross_freight>0:', count(trips, t => parseFloat(t.gross_freight || t.Gross_Freight || 0) > 0));

  // The exact Pending-Billing query: where('billing_status','==','PENDING')
  const qPending = (await db.collection('TRIPS').where('billing_status', '==', 'PENDING').get()).size;
  const completed = trips.filter(t => ['COMPLETED', 'UNLOADED'].includes(String(t.trip_status || t.Trip_Status || '')) || t.unloading_date || t.Unloading_Date);
  const completedNotBilled = completed.filter(t => (t.billing_status || '') !== 'BILLED');
  console.log(`\n🎯 PIPELINE MATH: where(billing_status==PENDING) returns ${qPending} trips`);
  console.log(`   but completed & NOT billed trips = ${completedNotBilled.length} (ye sab pipeline me dikhne chahiye)`);
  console.log(`   => SILENTLY DROPPED: ${completedNotBilled.length - qPending}`);

  const vehicles = (await db.collection('VEHICLES').get()).docs.map(d => d.data());
  console.log(`\n== VEHICLES (${vehicles.length}) ==`);
  console.log('fastag_id set:', count(vehicles, v => v.fastag_id), '| company_name:', dist(vehicles, v => v.company_name || v.Company_Name || null));

  const tolls = (await db.collection('TOLL_TRANSACTIONS').get()).docs.map(d => d.data());
  console.log(`\n== TOLL_TRANSACTIONS (${tolls.length}) ==`);
  console.log('company:', dist(tolls, t => t.company || null));
  console.log('linked to trip:', count(tolls, t => t.trip_db_id || (t.linked_trip_id && t.linked_trip_id !== 'UNMAPPED')), '/', tolls.length);

  const led = (await db.collection('LEDGERS').get()).docs.map(d => d.data());
  console.log(`\n== LEDGERS (${led.length}) ==`);
  console.log('has group:', count(led, l => l.group), '| has only group_head (no group):', count(led, l => !l.group && l.group_head));
  console.log('company:', dist(led, l => l.company || null));

  const le = (await db.collection('LEDGER_ENTRIES').get()).docs.map(d => d.data());
  console.log(`\n== LEDGER_ENTRIES (${le.length}) ==`);
  console.log('company:', dist(le, e => e.company || null));

  const bank = (await db.collection('BANK_TRANSACTIONS').get()).docs.map(d => d.data());
  console.log(`\n== BANK_TRANSACTIONS (${bank.length}) ==`);
  console.log('type:', dist(bank, b => b.type || null));
  console.log('company:', dist(bank, b => b.company || null));
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
