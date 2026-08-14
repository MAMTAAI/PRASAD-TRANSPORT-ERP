// 🏁 POST-TRIP FINANCIAL ENGINE — ground-reality billing workflow.
// One shared brain for the four post-trip flows:
//   1. Retroactive expenses (bills arrive AFTER unloading) → EXPENSE_APPROVALS
//      queue → admin approval → journal + trip P&L adjust, without touching a
//      closed trip until the boss says yes.
//   2. Auto-draft invoice computed the moment a trip unloads (feeds the
//      Pending Billing dashboard in BillManagement).
//   3. AI-scanned vendor/fuel bills auto-matched to the right trip_id.
//   4. (was) Shortage → driver khata. Moved to the unload endpoint — see below.
// All money postings go through TARA on the server (never from this file — see
// approveRetroExpense), so re-running anything returns 409 instead of posting
// the same cost twice.
import { getField, round2 } from './accounting/tripMath';

const API = (import.meta as any).env?.VITE_AGENT_API_URL || 'http://127.0.0.1:3300';
const QUEUES = `${API}/api/v1/queues`;

const queuesFetch = async (path: string, opts?: RequestInit) => {
  const res = await fetch(`${QUEUES}${path}`, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.detail || json.error || `HTTP ${res.status}`), { code: json.error });
  return json;
};
import { logAudit } from './audit';

// ── Types ────────────────────────────────────────────────────────────────
export type ExpenseType = 'FUEL' | 'TOLL' | 'VENDOR' | 'OTHER';

export interface RetroExpense {
  id?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  expense_type: ExpenseType;
  trip_db_id: string;        // Firestore TRIPS doc id ('' when unmatched)
  trip_id: string;           // business Trip ID / LR (PT00xxx)
  vehicle_no: string;
  driver_name: string;
  customer_name: string;
  vendor_name: string;
  bill_no: string;
  bill_date: string;         // YYYY-MM-DD
  amount: number;
  gst_amount: number;
  description: string;
  source: 'manual' | 'ai_scan';
  entered_by: string;
  trip_status_at_entry: string;
  match_confidence?: 'MATCHED' | 'AMBIGUOUS' | 'NONE';
}

export const EXPENSE_LEDGER: Record<ExpenseType, string> = {
  FUEL: 'Diesel / Fuel Expense',
  TOLL: 'Toll & Fastag Expense',
  VENDOR: 'Purchases / Expense',
  OTHER: 'Purchases / Expense',
};

export const EXPENSE_TYPE_META: Record<ExpenseType, { label: string; icon: string }> = {
  FUEL: { label: 'HSD / Fuel Pump Bill', icon: '⛽' },
  TOLL: { label: 'Toll / Fastag', icon: '🛣️' },
  VENDOR: { label: 'Vendor / Parts Bill', icon: '🧾' },
  OTHER: { label: 'Other Trip Expense', icon: '📎' },
};

// ── Date parsing (hardened for AI-scanned documents) ─────────────────────
// Trip matching and document-date parsing moved to ./tripMatch — they are pure
// and are needed by PostgreSQL-backed screens that must not pull in the
// Firestore SDK this module imports. Re-exported so callers here are unchanged.
export { normalizeVehicleNo, parseDocDate, matchTripForBill } from './tripMatch';
export type { TripMatch } from './tripMatch';

/** Guess FUEL/TOLL/VENDOR from scanned vendor name + description text. */
export function classifyExpenseType(text: string): ExpenseType {
  const s = (text || '').toLowerCase();
  if (/(hsd|diesel|petrol|fuel|pump|filling|ioc|hpcl|bpcl|petro)/.test(s)) return 'FUEL';
  if (/(toll|fastag|nhai|plaza)/.test(s)) return 'TOLL';
  return 'VENDOR';
}

// ── 1. Retroactive expense queue (EXPENSE_APPROVALS) ─────────────────────
const tripBrief = (t: any) => ({
  trip_db_id: t?.id || '',
  trip_id: String(getField(t, ['trip_id', 'Trip_ID']) || t?.id || ''),
  vehicle_no: String(getField(t, ['vehicle_no', 'Vehical_No', 'vehical_no']) || ''),
  driver_name: String(getField(t, ['driver_name', 'Driver_Name']) || ''),
  customer_name: String(getField(t, ['customer_name', 'Customer', 'Registered_Assessee']) || ''),
  trip_status_at_entry: String(getField(t, ['trip_status', 'Trip_Status']) || ''),
});

/** File a post-unloading bill into the Pending Expenses queue (status PENDING).
 *  Nothing touches the books until an admin approves. */
export async function submitRetroExpense(exp: Partial<RetroExpense> & { amount: number }, trip?: any): Promise<string> {
  const brief: any = trip ? tripBrief(trip) : {};
  const payload = {
    expense_type: exp.expense_type || 'VENDOR',
    // PostgreSQL keeps the FK and the human code apart: `trip_id` is the uuid,
    // `trip_ref` the PT00xxx the bill quotes. The API sorts a non-uuid into
    // trip_ref itself, so both spellings can be sent.
    trip_id: exp.trip_db_id || brief.trip_db_id || null,
    trip_ref: exp.trip_id || brief.trip_id || null,
    vehicle_no: exp.vehicle_no || brief.vehicle_no || '',
    driver_name: brief.driver_name || '',
    vendor_name: exp.vendor_name || '',
    bill_no: exp.bill_no || '',
    bill_date: exp.bill_date || null,
    amount: round2(Number(exp.amount) || 0),
    description: exp.description || '',
    source: exp.source || 'manual',
    entered_by: exp.entered_by || 'staff',
    match_confidence: null,
    trip_status_at_entry: brief.trip_status_at_entry || '',
  };
  const { expense } = await queuesFetch('/expenses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  logAudit({ action: 'RETRO_EXPENSE_SUBMITTED', target: payload.trip_ref || payload.bill_no, details: `${payload.expense_type} ₹${payload.amount} (${payload.vendor_name || 'no vendor'})` });
  return expense.id;
}

/** ADMIN APPROVAL: post the retro expense into the books.
 *
 *  THE POSTING IS NO LONGER DONE HERE. This used to build both legs of a double
 *  entry in the browser and write them through lib/accounting/journal. On
 *  PostgreSQL `ledger_entries` belongs to TARA — append-only by trigger, with a
 *  deferred Dr=Cr constraint — so a client-side posting is impossible by
 *  design, not merely discouraged. The endpoint posts a JOURNAL voucher
 *  (Dr expense / Cr creditor-or-cash), stamps the approval with its voucher_id
 *  and adjusts the trip's P&L in one transaction.
 *
 *  Still idempotent, and more strictly than before: the voucher carries the
 *  approval id as its reference, so a replay returns 409 rather than posting
 *  the cost twice. */
export async function approveRetroExpense(exp: RetroExpense & { id: string }, approverName: string): Promise<void> {
  const amount = round2(Number(exp.amount) || 0);
  if (amount <= 0) throw new Error('Zero-amount expense cannot be approved');
  await queuesFetch(`/expenses/${exp.id}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved_by: approverName }),
  });
  logAudit({ action: 'RETRO_EXPENSE_APPROVED', target: exp.trip_id || exp.bill_no, details: `${exp.expense_type} ₹${amount} by ${approverName}` });
}

export async function rejectRetroExpense(expId: string, reason: string, approverName: string): Promise<void> {
  await queuesFetch(`/expenses/${expId}/reject`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason || '', rejected_by: approverName }),
  });
  logAudit({ action: 'RETRO_EXPENSE_REJECTED', target: expId, details: reason || '' });
}

// ── 2. Auto-draft invoice (computed at unloading) ────────────────────────
export interface DraftInvoice {
  qty: number; rate: number; gross: number;
  shortage_qty: number; shortage_amt: number;
  tds: number; net: number;
  customer: string; generated_at: string;
}

/** Compute the client-format draft figures the moment a trip unloads.
 *  Same math the Pending Billing dashboard / invoice generator uses
 *  (gross = freight or qty×rate; TDS 2% u/s 194C; net = gross − shortage − TDS). */
export function buildDraftInvoice(trip: any, patch: { unloaded_qty?: any; shortage_qty?: any; penalty_amount?: any } = {}): DraftInvoice {
  const qty = Number(getField(trip, ['qty', 'weight', 'quantity', 'loaded_qty', 'Loaded_Qty'])) || 1;
  const rate = Number(getField(trip, ['rate', 'freight_rate'])) || 0;
  const gross = round2(Number(getField(trip, ['gross_freight', 'Gross_Freight'])) || (qty * rate));
  const shortage_qty = Number(patch.shortage_qty ?? getField(trip, ['shortage_qty', 'Shortage_Qty'])) || 0;
  const shortage_amt = round2(Number(patch.penalty_amount ?? getField(trip, ['shortage_amt', 'Shortage_Amt', 'shortage_penalty'])) || 0);
  const tds = round2(gross * 0.02);
  return {
    qty, rate, gross, shortage_qty, shortage_amt, tds,
    net: round2(gross - shortage_amt - tds),
    customer: String(getField(trip, ['customer_name', 'Customer', 'Registered_Assessee']) || ''),
    generated_at: new Date().toISOString(),
  };
}

// ── 4. Auto-shortage recovery → driver khata ─────────────────────────────
// REMOVED — the server does this now, and did it better.
//
// postShortageRecovery() debited DRIVER_TRANSACTIONS and posted the journal
// from the browser. POST /api/v1/ops/trips/:id/unload already does both inside
// the transaction that records the unloading, keyed on the trip so a re-save
// converges instead of charging the driver twice. It had no callers left here.
//
// This also closes the "driver shortage recovery has no GL leg" gap noted in
// CLAUDE.md: it has one, posted by TARA at unloading.

// ── Shared: all-trips fetch for bill matching (rare, on-demand) ──────────
let tripsCache: { at: number; trips: any[] } | null = null;
export async function fetchTripsForMatching(maxAgeMs = 120000): Promise<any[]> {
  if (tripsCache && Date.now() - tripsCache.at < maxAgeMs) return tripsCache.trips;
  const res = await fetch(`${API}/api/v1/ops/trips?limit=1000`);
  if (!res.ok) return tripsCache?.trips ?? [];
  const json = await res.json();
  const trips = json.trips ?? [];
  tripsCache = { at: Date.now(), trips };
  return trips;
}
