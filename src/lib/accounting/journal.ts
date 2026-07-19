// 📒 Double-entry JOURNAL — the single source of truth for all financials.
// ADD-ONLY + idempotent: each entry's Firestore doc id is derived from its
// (source_type, source_ref), so re-posting the same event OVERWRITES the same
// document — a second/duplicate entry is impossible (Firestore doc-id is unique).
import { doc, setDoc, getDocs, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../../firebase';

export type DrCr = 'Dr' | 'Cr';
export interface JournalLine { ledger: string; dr_cr: DrCr; amount: number; }

export interface JournalEntry {
  source_type: string;   // e.g. 'TRIP_FREIGHT', 'CUSTOMER_PAYMENT', 'FUEL', 'EMI'
  source_ref: string;    // unique business reference (Trip ID, Bill No, Voucher ID)
  date: string;          // YYYY-MM-DD
  narration: string;
  company?: string;
  lines: JournalLine[];  // must balance: ΣDr === ΣCr
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const journalDocId = (sourceType: string, sourceRef: string) =>
  `${sourceType}__${sourceRef}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 380);

export interface ValidationResult { ok: boolean; error?: string; totalDr: number; totalCr: number; }
export function validateEntry(entry: JournalEntry): ValidationResult {
  const totalDr = round2(entry.lines.filter(l => l.dr_cr === 'Dr').reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const totalCr = round2(entry.lines.filter(l => l.dr_cr === 'Cr').reduce((s, l) => s + (Number(l.amount) || 0), 0));
  if (!entry.source_ref) return { ok: false, error: 'missing source_ref', totalDr, totalCr };
  if (entry.lines.length < 2) return { ok: false, error: 'need at least 2 lines', totalDr, totalCr };
  if (totalDr !== totalCr) return { ok: false, error: `unbalanced (Dr ${totalDr} ≠ Cr ${totalCr})`, totalDr, totalCr };
  if (totalDr === 0) return { ok: false, error: 'zero-amount entry', totalDr, totalCr };
  return { ok: true, totalDr, totalCr };
}

/** Idempotent post: same (source_type, source_ref) overwrites — never duplicates. */
export async function postEntry(entry: JournalEntry): Promise<{ id: string }> {
  const v = validateEntry(entry);
  if (!v.ok) throw new Error(`Journal rejected: ${v.error}`);
  const id = journalDocId(entry.source_type, entry.source_ref);
  await setDoc(doc(db, 'JOURNAL', id), {
    ...entry,
    total: v.totalDr,
    posted_at: serverTimestamp(),
    posted_by: 'system',
  }); // full overwrite => idempotent
  return { id };
}

export interface StoredEntry extends JournalEntry { id: string; total: number; }
export async function getJournal(): Promise<StoredEntry[]> {
  const snap = await getDocs(collection(db, 'JOURNAL'));
  return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
}

// ── Reporting helpers (all finance modules read from here) ──────────────
export interface LedgerBalance { ledger: string; dr: number; cr: number; balance: number; }
export async function ledgerBalances(): Promise<LedgerBalance[]> {
  const entries = await getJournal();
  const map = new Map<string, { dr: number; cr: number }>();
  entries.forEach(e => e.lines?.forEach(l => {
    const cur = map.get(l.ledger) || { dr: 0, cr: 0 };
    if (l.dr_cr === 'Dr') cur.dr += Number(l.amount) || 0; else cur.cr += Number(l.amount) || 0;
    map.set(l.ledger, cur);
  }));
  return [...map.entries()].map(([ledger, v]) => ({ ledger, dr: round2(v.dr), cr: round2(v.cr), balance: round2(v.dr - v.cr) }));
}

// ── Reconciliation / audit (report only — never auto-fixes) ─────────────
export interface AuditFinding { id: string; issue: string; detail: string; }
export async function reconcile(): Promise<{ count: number; balanced: boolean; findings: AuditFinding[] }> {
  const entries = await getJournal();
  const findings: AuditFinding[] = [];
  entries.forEach(e => {
    const v = validateEntry(e);
    if (!v.ok) findings.push({ id: e.id, issue: 'invalid/unbalanced', detail: v.error || '' });
    if (!e.source_ref) findings.push({ id: e.id, issue: 'orphan', detail: 'missing source_ref' });
  });
  return { count: entries.length, balanced: findings.length === 0, findings };
}
