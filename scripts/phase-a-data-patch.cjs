// 🩹 Phase A (Truth Sprint) one-time data patches. Idempotent.
//
// PATCH 1 — LEDGERS: docs written with only `group_head` (readers key on
//   `group`) landed in Suspense A/c. Copy group_head → group where missing.
//
// PATCH 2 — TRIPS: total_expense historically accumulated recoverable cash
//   advances (office cash / bank / pump cash). Under the corrected model those
//   are driver-khata advances, not P&L expenses. For each trip:
//     advances   = office_cash_paid + bank_paid + pump_cash_advance
//     total_expense = max(0, old_total_expense - advances)
//     total_advances = advances
//   and for COMPLETED trips final_balance is recomputed as
//     gross_freight - total_expense - shortage_penalty.
//   Marked with expense_migrated:true so re-runs are no-ops.
//   NOTE: diesel value on historical trips remains 0 — rates were never
//   captured before this fix, so the true fuel cost is unrecoverable.
//
// Run: node scripts/phase-a-data-patch.cjs
const path = require('path');
const admin = require(path.join(__dirname, '..', 'whatsapp-server', 'node_modules', 'firebase-admin'));

admin.initializeApp({ credential: admin.credential.cert(require(path.join(__dirname, '..', 'google-key.json'))) });
const db = admin.firestore();
const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

(async () => {
  // ---- PATCH 1: ledger group ----
  const ledgers = await db.collection('LEDGERS').get();
  let ledgerPatched = 0;
  for (const d of ledgers.docs) {
    const l = d.data();
    if (!l.group && l.group_head) {
      await d.ref.update({ group: l.group_head });
      ledgerPatched++;
    }
  }
  console.log(`PATCH 1 (LEDGERS): ${ledgerPatched} docs given group=group_head (of ${ledgers.size} total)`);

  // ---- PATCH 2: trip expense vs advances ----
  const trips = await db.collection('TRIPS').get();
  let migrated = 0, skipped = 0, settlementsFixed = 0;
  for (const d of trips.docs) {
    const t = d.data();
    if (t.expense_migrated === true) { skipped++; continue; }
    const advances = round2(num(t.office_cash_paid) + num(t.bank_paid) + num(t.pump_cash_advance));
    if (advances <= 0) { skipped++; continue; }

    const oldExpense = num(t.total_expense);
    const newExpense = round2(Math.max(0, oldExpense - advances));
    const update = { total_expense: newExpense, total_advances: advances, expense_migrated: true };

    const status = t.trip_status || t.Trip_Status;
    if (status === 'COMPLETED') {
      const gross = num(t.gross_freight) || num(t.total_freight) || num(t.Freight) || num(t.Rate);
      const penalty = num(t.shortage_penalty) || num(t.Shortage_Penalty);
      update.final_balance = round2(gross - newExpense - penalty);
      settlementsFixed++;
    }
    await d.ref.update(update);
    migrated++;
    console.log(`  ${t.trip_id || t.Trip_ID || d.id}: expense ${oldExpense} -> ${newExpense}, advances ${advances}${update.final_balance !== undefined ? `, settlement -> ${update.final_balance}` : ''}`);
  }
  console.log(`PATCH 2 (TRIPS): ${migrated} migrated (${settlementsFixed} settlements recomputed), ${skipped} skipped, ${trips.size} total`);
  process.exit(0);
})().catch(e => { console.error('PATCH FAILED:', e.message); process.exit(1); });
