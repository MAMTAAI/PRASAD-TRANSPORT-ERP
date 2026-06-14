// READ-ONLY preview: apply the real posting rules (posting.ts) to real Firestore
// operations data and report what the journal backfill WOULD post. No writes.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const admin = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'firebase-admin'));
admin.initializeApp({ credential: admin.credential.cert(require(path.join(__dirname, '..', 'whatsapp-server', 'serviceAccountKey.json'))) });
const db = admin.firestore();

// transpile the real posting rules
const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'accounting', 'posting.ts'), 'utf8');
const js = esbuild.transformSync(code, { loader: 'ts', format: 'cjs' }).code;
const mod = { exports: {} }; new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const P = mod.exports;

const bal = e => { const dr = e.lines.filter(l => l.dr_cr === 'Dr').reduce((s, l) => s + l.amount, 0); const cr = e.lines.filter(l => l.dr_cr === 'Cr').reduce((s, l) => s + l.amount, 0); return { dr, cr, ok: Math.round((dr - cr) * 100) === 0 }; };

async function readAll(c) { const s = await db.collection(c).get(); return s.docs.map(d => ({ id: d.id, ...d.data() })); }

(async () => {
  const [trips, fuel, vtx, loans] = await Promise.all([readAll('TRIPS'), readAll('FUEL_ENTRIES'), readAll('VENDOR_TXNS'), readAll('LOAN_MASTER')]);
  console.log(`Read: TRIPS ${trips.length}, FUEL ${fuel.length}, VENDOR_TXNS ${vtx.length}, LOAN ${loans.length}`);

  const entries = [];
  trips.forEach(t => { const e = P.tripFreightEntry(t); if (e) entries.push(e); });
  trips.forEach(t => { if (/attach|market|hire|vendor/i.test(String(t.own_attach || t.vehicle_type || ''))) { const e = P.hireEntry(t); if (e) entries.push(e); } });
  fuel.forEach(f => { const e = P.fuelEntry(f); if (e) entries.push(e); });
  vtx.forEach(v => { const e = P.vendorPaymentEntry(v); if (e) entries.push(e); });
  loans.forEach(l => { const e = P.emiEntry(l); if (e) entries.push(e); });

  const bySrc = {}; const byLedger = {}; let unbalanced = 0;
  entries.forEach(e => {
    const b = bal(e); if (!b.ok) unbalanced++;
    bySrc[e.source_type] = (bySrc[e.source_type] || 0) + 1;
    e.lines.forEach(l => { byLedger[l.ledger] = byLedger[l.ledger] || { dr: 0, cr: 0 }; byLedger[l.ledger][l.dr_cr === 'Dr' ? 'dr' : 'cr'] += l.amount; });
  });

  console.log(`\n=== WOULD POST ${entries.length} journal entries (unbalanced: ${unbalanced}) ===`);
  console.log('By source:', JSON.stringify(bySrc));
  console.log('\nLedger totals (top):');
  Object.entries(byLedger).sort((a, b) => (b[1].dr + b[1].cr) - (a[1].dr + a[1].cr)).slice(0, 12)
    .forEach(([l, v]) => console.log(`  ${l.padEnd(40)} Dr ₹${Math.round(v.dr)}  Cr ₹${Math.round(v.cr)}`));

  const revenue = byLedger['Direct Incomes (Freight/Trip Revenue)']?.cr || 0;
  console.log(`\n📊 Trip Freight Revenue that would post: ₹${Math.round(revenue)}`);
  console.log(revenue === 0 ? '   ⚠️ ₹0 — confirms trips carry no freight (Rate=0); add freight to see revenue.' : '   ✅ Revenue flows!');
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
