// 🧾 Audit log (Phase 10) — APPEND-ONLY record of who did what. Never updates
// or deletes; its own AUDIT_LOG collection (separate from operational data).
import { collection, addDoc, getDocs, query, orderBy, limit, serverTimestamp } from 'firebase/firestore';
import { db } from '../../firebase';
import { currentUser } from '../rbac';

export interface AuditEntry {
  action: string;          // e.g. 'TRIP_CREATE', 'JOURNAL_POST', 'ROLE_CHANGE', 'VIEW_FINANCE'
  target?: string;         // affected id / ref
  details?: string;        // short human description
}

// Writes to ACTIVITY_LOGS (the same collection the UGER admin viewer reads),
// so audit entries show up there automatically — one unified log, no duplicate.
const LOG_COLLECTION = 'ACTIVITY_LOGS';

/** Append an audit record. Fire-and-forget; never throws into the caller. */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const u: any = currentUser();
    await addDoc(collection(db, LOG_COLLECTION), {
      action: entry.action,
      target: entry.target || '',
      details: entry.details || '',
      user: u?.full_name || u?.name || u?.email || 'unknown',
      role: u?.role || 'unknown',
      timestamp: serverTimestamp(), // UGER viewer orders by this
    });
  } catch { /* audit must never break the main action */ }
}

export interface AuditRow extends AuditEntry { id: string; user: string; role: string; timestamp: any; }
/** Read recent audit entries (admin viewer). */
export async function recentAudit(max = 100): Promise<AuditRow[]> {
  try {
    const snap = await getDocs(query(collection(db, LOG_COLLECTION), orderBy('timestamp', 'desc'), limit(max)));
    return snap.docs.map(d => ({ id: d.id, ...(d.data() as any) }));
  } catch { return []; }
}
