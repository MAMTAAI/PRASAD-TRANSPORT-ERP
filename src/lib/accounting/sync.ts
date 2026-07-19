// 🔄 Backfill / live-sync: read Operations collections and post them into the
// JOURNAL via the posting rules. Idempotent end-to-end (deterministic
// source_ref => re-running never duplicates). READ-heavy: run when the
// Firestore read quota allows. Read-only on source data; only writes JOURNAL.
import { getDocs, collection } from 'firebase/firestore';
import { db } from '../../firebase';
import { postEntry, type JournalEntry } from './journal';
import {
  tripFreightEntry, hireEntry, fuelEntry, vendorPaymentEntry, emiEntry,
} from './posting';

export interface SyncProgress { phase: string; posted: number; skipped: number; }
export interface SyncResult { posted: number; skipped: number; failed: number; bySource: Record<string, number>; }

async function runRule(
  collName: string,
  build: (row: any) => JournalEntry | null,
  isMarketHire: ((row: any) => boolean) | null,
  acc: SyncResult,
  onProgress?: (p: SyncProgress) => void,
) {
  const snap = await getDocs(collection(db, collName));
  for (const d of snap.docs) {
    const row: any = { id: d.id, ...d.data() };
    if (isMarketHire && !isMarketHire(row)) continue;
    const entry = build(row);
    if (!entry) { acc.skipped++; continue; }
    try {
      await postEntry(entry);
      acc.posted++;
      acc.bySource[entry.source_type] = (acc.bySource[entry.source_type] || 0) + 1;
    } catch { acc.failed++; }
    onProgress?.({ phase: collName, posted: acc.posted, skipped: acc.skipped });
  }
}

/**
 * Post every supported Operations event into the JOURNAL. Safe to re-run any
 * time — idempotent. Returns counts. Builders that return null (e.g. freight 0,
 * which is today's data) are counted as `skipped`, not errors.
 */
export async function syncAllToJournal(onProgress?: (p: SyncProgress) => void): Promise<SyncResult> {
  const acc: SyncResult = { posted: 0, skipped: 0, failed: 0, bySource: {} };

  // Trips → freight income (own vehicles) and hire expense (market vehicles).
  await runRule('TRIPS', tripFreightEntry, null, acc, onProgress);
  await runRule('TRIPS', hireEntry, (t) => /attach|market|hire|vendor/i.test(String(t.own_attach || t.vehicle_type || '')), acc, onProgress);

  // Fuel issued → diesel expense.
  await runRule('FUEL_ENTRIES', fuelEntry, null, acc, onProgress);

  // Vendor transactions → vendor payments.
  await runRule('VENDOR_TXNS', vendorPaymentEntry, null, acc, onProgress);

  // Loan master → EMI splits (if EMI rows are embedded, callers can extend).
  await runRule('LOAN_MASTER', emiEntry, null, acc, onProgress);

  return acc;
}
