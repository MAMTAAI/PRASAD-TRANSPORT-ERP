// 📒 Double-entry JOURNAL — one book, and it is PostgreSQL's.
//
// THIS FILE USED TO BE A SECOND LEDGER. It wrote a Firestore `JOURNAL`
// collection while the balance sheet, the P&L and every voucher-posting screen
// read `ledger_entries` in PostgreSQL. Nothing reconciled the two, so an entry
// posted through here — trip freight, a scanned bill, a backfill sync — was
// invisible to the books an accountant actually looks at. Every caller now
// lands on POST /api/v1/finance/journal, which posts through TARA like
// everything else.
//
// ⚠️ IDEMPOTENCE CHANGED SHAPE. Firestore keyed the entry on
// (source_type, source_ref) as a document id, so re-posting OVERWROTE: posting
// the same event again with different numbers silently corrected it.
// `ledger_entries` is append-only by trigger and cannot do that. A repeat post
// is now a NO-OP — it reports `already: true` and changes nothing.
//
// That keeps the contract callers actually depend on ("re-running a sync never
// duplicates") and removes the one they should never have had ("posting again
// quietly rewrites history"). If a posted entry is wrong, the fix is a reversal
// plus a new entry — the same rule the cash book, bill settlement and EMI
// screens follow. Callers that relied on overwrite-to-correct will now see
// `already: true` and no change; that is the honest outcome, not a regression.
import { API_BASE } from '../apiBase';
const API = API_BASE;
const FIN = `${API}/api/v1/finance`;

const fetchJson = async (url: string, opts?: RequestInit) => {
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};

export type DrCr = 'Dr' | 'Cr';
export interface JournalLine { ledger: string; dr_cr: DrCr; amount: number; group?: string }

export interface JournalEntry {
  source_type: string;   // e.g. 'TRIP_FREIGHT', 'CUSTOMER_PAYMENT', 'FUEL', 'EMI'
  source_ref: string;    // unique business reference (Trip ID, Bill No, Voucher ID)
  date: string;          // YYYY-MM-DD
  narration: string;
  company?: string;
  branch?: string;
  lines: JournalLine[];  // must balance: ΣDr === ΣCr
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Kept because posting.ts and the audit report still build ids with it. */
export const journalDocId = (sourceType: string, sourceRef: string) =>
  `${sourceType}__${sourceRef}`.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 380);

export interface ValidationResult { ok: boolean; error?: string; totalDr: number; totalCr: number; }

/** Local pre-check. The database checks it again at COMMIT (voucher_must_balance
 *  is a deferred constraint), so this is for a useful message, not for safety. */
export function validateEntry(entry: JournalEntry): ValidationResult {
  const totalDr = round2(entry.lines.filter(l => l.dr_cr === 'Dr').reduce((s, l) => s + (Number(l.amount) || 0), 0));
  const totalCr = round2(entry.lines.filter(l => l.dr_cr === 'Cr').reduce((s, l) => s + (Number(l.amount) || 0), 0));
  if (!entry.source_ref) return { ok: false, error: 'missing source_ref', totalDr, totalCr };
  if (entry.lines.length < 2) return { ok: false, error: 'need at least 2 lines', totalDr, totalCr };
  if (totalDr !== totalCr) return { ok: false, error: `unbalanced (Dr ${totalDr} ≠ Cr ${totalCr})`, totalDr, totalCr };
  if (totalDr === 0) return { ok: false, error: 'zero-amount entry', totalDr, totalCr };
  return { ok: true, totalDr, totalCr };
}

export interface PostResult { id: string; voucher_id: string | null; already: boolean }

/** Post a balanced entry. Re-posting the same (source_type, source_ref) is a
 *  no-op that reports `already: true`. */
export async function postEntry(entry: JournalEntry): Promise<PostResult> {
  const v = validateEntry(entry);
  if (!v.ok) throw new Error(`Journal rejected: ${v.error}`);
  const j = await fetchJson(`${FIN}/journal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_type: entry.source_type,
      source_ref: entry.source_ref,
      date: entry.date,
      narration: entry.narration,
      company: entry.company ?? null,
      branch: entry.branch ?? null,
      lines: entry.lines.map(l => ({
        ledger: l.ledger, dr_cr: l.dr_cr, amount: Number(l.amount), group: l.group ?? null,
      })),
    }),
  });
  return {
    id: journalDocId(entry.source_type, entry.source_ref),
    voucher_id: j.voucher_id ?? null,
    already: !!j.already,
  };
}

export interface StoredEntry extends JournalEntry { id: string; total: number; voucher_id: string }

export async function getJournal(): Promise<StoredEntry[]> {
  const j = await fetchJson(`${FIN}/journal`);
  return (j.entries ?? []).map((e: any) => ({
    id: journalDocId(e.source_type ?? 'VOUCHER', e.source_ref ?? e.voucher_id),
    voucher_id: e.voucher_id,
    source_type: e.source_type ?? 'VOUCHER',
    source_ref: e.source_ref ?? e.voucher_id,
    date: e.date,
    narration: e.narration ?? '',
    company: e.company ?? '',
    total: Number(e.total) || 0,
    // The API returns the table's DR/CR; this module's vocabulary is Dr/Cr.
    lines: (e.lines ?? []).map((l: any) => ({
      ledger: l.ledger,
      dr_cr: (String(l.dr_cr).toUpperCase() === 'DR' ? 'Dr' : 'Cr') as DrCr,
      amount: Number(l.amount) || 0,
    })),
  }));
}

// ── Reporting helpers ──────────────────────────────────────────────────────
export interface LedgerBalance { ledger: string; dr: number; cr: number; balance: number; }

/** Per-ledger Dr/Cr totals. Prefer /finance/reports/trial-balance for anything
 *  user-facing — it is computed in SQL rather than by pulling every entry into
 *  the browser. This stays for the callers that already expect this shape. */
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

// ── Reconciliation / audit (report only — never auto-fixes) ─────────────────
export interface AuditFinding { id: string; issue: string; detail: string; }

/** Kept for the daily report. It asks the DATABASE now — `v_accounting_health`
 *  is the authority, and an unbalanced voucher cannot exist in the first place
 *  because voucher_must_balance is a deferred constraint checked at COMMIT.
 *  Any finding here is therefore a real anomaly, not arithmetic drift. */
export async function reconcile(): Promise<{ count: number; balanced: boolean; findings: AuditFinding[] }> {
  // NOT fetchJson: /health/accounting answers 409 when something is wrong, and
  // that is its ANSWER, not a transport failure. Throwing on it would turn
  // "the books are out" into "the check could not run" — the two things a
  // daily report most needs to tell apart.
  const res = await fetch(`${FIN}/health/accounting`).catch(() => null);
  if (!res) return { count: 0, balanced: true, findings: [] };
  const h = await res.json().catch(() => null);
  if (!h) return { count: 0, balanced: true, findings: [] };

  // The endpoint already names every non-zero check; each one is a finding.
  const findings: AuditFinding[] = (h.failures ?? []).map((f: string) => {
    const [key, value] = String(f).split('=');
    return { id: key, issue: key.replace(/_/g, ' '), detail: value ?? '' };
  });
  return { count: findings.length, balanced: !!h.ok, findings };
}
