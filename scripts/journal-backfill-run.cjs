// Phase 12.2 EXECUTION: post real operations data into JOURNAL (add-only,
// idempotent via deterministic doc id). Re-runnable; never duplicates; never
// touches existing ops data. Then reads JOURNAL back + reconciles.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const admin = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'firebase-admin'));
admin.initializeApp({ credential: admin.credential.cert(require(path.join(__dirname, '..', 'whatsapp-server', 'serviceAccountKey.json'))) });
const db = admin.firestore();

const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'accounting', 'posting.ts'), 'utf8');
const js = esbuild.transformSync(code, { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const P = mod.exports;

const journalDocId = (st, sr) => `${st}__${sr}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 380);
async function readAll(c) { const s = await db.collection(c).get(); return s.docs.map(d => ({ id: d.id, ...d.data() })); }

(async () => {
  const [trips, fuel, vtx, loans] = await Promise.all([readAll('TRIPS'), readAll('FUEL_ENTRIES'), readAll('VENDOR_TXNS'), readAll('LOAN_MASTER')]);
  const entries = [];
  trips.forEach(t => { const e = P.tripFreightEntry(t); if (e) entries.push(e); });
  trips.forEach(t => { if (/attach|market|hire|vendor/i.test(String(t.own_attach || t.vehicle_type || ''))) { const e = P.hireEntry(t); if (e) entries.push(e); } });
  fuel.forEach(f => { const e = P.fuelEntry(f); if (e) entries.push(e); });
  vtx.forEach(v => { const e = P.vendorPaymentEntry(v); if (e) entries.push(e); });
  loans.forEach(l => { const e = P.emiEntry(l); if (e) entries.push(e); });

  console.log(`Posting ${entries.length} entries to JOURNAL (idempotent, add-only)…`);
  let posted = 0;
  // batched writes
  for (let i = 0; i < entries.length; i += 400) {
    const batch = db.batch();
    entries.slice(i, i + 400).forEach(e => {
      const totalDr = e.lines.filter(l => l.dr_cr === 'Dr').reduce((s, l) => s + l.amount, 0);
      const id = journalDocId(e.source_type, e.source_ref);
      batch.set(db.collection('JOURNAL').doc(id), { ...e, total: totalDr, posted_at: new Date().toISOString(), posted_by: 'system_backfill' });
      posted++;
    });
    await batch.commit();
  }
  console.log(`✅ Posted ${posted}.`);

  // Read back + reconcile + ledger balances
  const snap = await db.collection('JOURNAL').get();
  const stored = snap.docs.map(d => d.data());
  let unbalanced = 0; const led = {};
  stored.forEach(e => {
    const dr = (e.lines || []).filter(l => l.dr_cr === 'Dr').reduce((s, l) => s + l.amount, 0);
    const cr = (e.lines || []).filter(l => l.dr_cr === 'Cr').reduce((s, l) => s + l.amount, 0);
    if (Math.round((dr - cr) * 100) !== 0) unbalanced++;
    (e.lines || []).forEach(l => { led[l.ledger] = led[l.ledger] || 0; led[l.ledger] += (l.dr_cr === 'Dr' ? 1 : -1) * l.amount; });
  });
  console.log(`\n=== JOURNAL now has ${stored.length} entries | unbalanced: ${unbalanced} (must be 0) ===`);
  console.log('Net ledger balances (Dr positive):');
  Object.entries(led).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 10).forEach(([l, v]) => console.log(`  ${l.padEnd(40)} ₹${Math.round(v)}`));
  console.log('\nℹ️ Re-run this script anytime — deterministic ids keep it idempotent (no duplicates).');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
