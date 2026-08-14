// 🧾 Audit log (Phase 10) — APPEND-ONLY record of who did what. Never updates
// or deletes; its own activity_logs table (separate from operational data).
import { currentUser } from '../rbac';

const API = (import.meta as any).env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300';
const CRM = `${API}/api/v1/crm`;

export interface AuditEntry {
  action: string;          // e.g. 'TRIP_CREATE', 'JOURNAL_POST', 'ROLE_CHANGE', 'VIEW_FINANCE'
  target?: string;         // affected id / ref
  details?: string;        // short human description
}

/** Append an audit record. Fire-and-forget; never throws into the caller.
 *
 *  The endpoint answers 202 rather than an error when the write itself fails
 *  (database degraded, constraint), so a lost audit line can never turn into a
 *  failed trip save. The catch here covers the transport instead. */
export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const u: any = currentUser();
    await fetch(`${CRM}/activity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keepalive so an entry logged during a navigation or tab close still
      // leaves the browser — Firestore's SDK queued these itself.
      keepalive: true,
      body: JSON.stringify({
        action: entry.action,
        target: entry.target || '',
        details: entry.details || '',
        user: u?.full_name || u?.name || u?.email || 'unknown',
        role: u?.role || 'unknown',
      }),
    });
  } catch { /* audit must never break the main action */ }
}

export interface AuditRow extends AuditEntry { id: string; user: string; role: string; timestamp: any; }

/** Read recent audit entries (admin viewer). */
export async function recentAudit(max = 100): Promise<AuditRow[]> {
  try {
    const res = await fetch(`${CRM}/activity?limit=${max}`);
    if (!res.ok) return [];
    const json = await res.json();
    // The viewer renders `user` and `timestamp`; the columns are `user_name`
    // and `ts`. Mapped here so the admin screen needs no change.
    return (json.activity ?? []).map((r: any) => ({
      id: String(r.id),
      action: r.action,
      target: r.target ?? '',
      details: r.details ?? '',
      user: r.user_name ?? 'unknown',
      role: r.role ?? 'unknown',
      timestamp: r.ts,
    }));
  } catch { return []; }
}
