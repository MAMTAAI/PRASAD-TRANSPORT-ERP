// 🏁 POST-TRIP FINANCIAL ENGINE — ground-reality billing workflow.
// One shared brain for the four post-trip flows:
//   1. Retroactive expenses (bills arrive AFTER unloading) → EXPENSE_APPROVALS
//      queue → admin approval → journal + trip P&L adjust, without touching a
//      closed trip until the boss says yes.
//   2. Auto-draft invoice computed the moment a trip unloads (feeds the
//      Pending Billing dashboard in BillManagement).
//   3. AI-scanned vendor/fuel bills auto-matched to the right trip_id.
//   4. Shortage → driver-liability debit posted straight to the driver khata.
// All money postings go through the idempotent double-entry journal
// (lib/accounting/journal.postEntry) so re-running anything never duplicates.
import {
  collection, doc, addDoc, setDoc, updateDoc, getDoc, getDocs,
  serverTimestamp, increment,
} from 'firebase/firestore';
import { db } from '../firebase';
import { postEntry } from './accounting/journal';
import { getTripFreight, getTripExpense, getField, toISODate, round2 } from './accounting/tripMath';
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
// The vision model is asked for DD-MM-YYYY but real bills come back as
// DD/MM/YY, DD.MM.YYYY (IOCL SAP), YYYY-MM-DD, or with a month>12 swap.
// Returns 'YYYY-MM-DD' or '' — never a guess that silently shifts a month.
export function parseDocDate(raw: any): string {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  const parts = s.match(/\d+/g);
  if (parts && parts.length >= 3) {
    const [a, b] = parts;
    let c = parts[2];
    // 2-digit year → 20xx (bills are never from the 1900s here)
    if (a.length <= 2 && b.length <= 2 && c.length === 2) c = `20${c}`;
    if (c.length === 4) {                       // DD-MM-YYYY family
      let d = parseInt(a, 10), m = parseInt(b, 10);
      if (m > 12 && d <= 12) [d, m] = [m, d];   // model swapped day/month
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12)
        return `${c}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    if (a.length === 4) {                       // YYYY-MM-DD family
      let m = parseInt(b, 10), d = parseInt(c, 10);
      if (m > 12 && d <= 12) [m, d] = [d, m];
      if (d >= 1 && d <= 31 && m >= 1 && m <= 12)
        return `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    // Numeric shape but impossible day/month (e.g. 32-13-2026): refuse rather
    // than let a lenient fallback fabricate a corrupt date.
    return '';
  }
  return toISODate(s);
}

export const normalizeVehicleNo = (v: any): string =>
  String(v || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();

// ── Trip matching (bill → trip_id) ───────────────────────────────────────
export interface TripMatch {
  trip: any | null;
  confidence: 'MATCHED' | 'AMBIGUOUS' | 'NONE';
  candidates: any[];
}

/** Match a bill (vehicle + date) to the right TRIPS doc. Same vehicle can run
 *  many trips; the bill date must sit inside loading→unloading (+graceDays for
 *  bills raised a few days after unloading). Falls back to the nearest trip by
 *  loading date when nothing brackets the date. */
export function matchTripForBill(trips: any[], billVehicle: any, billDateISO: string, graceDays = 5): TripMatch {
  const veh = normalizeVehicleNo(billVehicle);
  if (!veh) return { trip: null, confidence: 'NONE', candidates: [] };
  const vehicleTrips = trips.filter(t =>
    normalizeVehicleNo(getField(t, ['vehicle_no', 'Vehical_No', 'vehical_no'])) === veh);
  if (!vehicleTrips.length) return { trip: null, confidence: 'NONE', candidates: [] };
  if (!billDateISO) {
    return vehicleTrips.length === 1
      ? { trip: vehicleTrips[0], confidence: 'MATCHED', candidates: vehicleTrips }
      : { trip: null, confidence: 'AMBIGUOUS', candidates: vehicleTrips };
  }
  const billT = new Date(billDateISO).getTime();
  const grace = graceDays * 86400000;
  const inWindow = vehicleTrips.filter(t => {
    const ld = toISODate(getField(t, ['loading_date', 'Loading_Date', 'start_date', 'date']));
    const ud = toISODate(getField(t, ['unloading_date', 'Unloading_Date']));
    const from = ld ? new Date(ld).getTime() - grace : -Infinity;
    const to = ud ? new Date(ud).getTime() + grace : Infinity;
    return billT >= from && billT <= to;
  });
  if (inWindow.length === 1) return { trip: inWindow[0], confidence: 'MATCHED', candidates: inWindow };
  if (inWindow.length > 1) {
    // Prefer the trip whose loading date is closest to the bill date.
    const scored = [...inWindow].sort((a, b) => {
      const da = Math.abs(billT - new Date(toISODate(getField(a, ['loading_date', 'Loading_Date', 'start_date', 'date'])) || billDateISO).getTime());
      const dbb = Math.abs(billT - new Date(toISODate(getField(b, ['loading_date', 'Loading_Date', 'start_date', 'date'])) || billDateISO).getTime());
      return da - dbb;
    });
    return { trip: scored[0], confidence: 'AMBIGUOUS', candidates: scored };
  }
  return { trip: null, confidence: 'NONE', candidates: vehicleTrips };
}

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
  const brief = trip ? tripBrief(trip) : {};
  const docData = {
    status: 'PENDING',
    expense_type: exp.expense_type || 'VENDOR',
    trip_db_id: '', trip_id: '', vehicle_no: '', driver_name: '', customer_name: '', trip_status_at_entry: '',
    vendor_name: exp.vendor_name || '',
    bill_no: exp.bill_no || '',
    bill_date: exp.bill_date || '',
    amount: round2(Number(exp.amount) || 0),
    gst_amount: round2(Number(exp.gst_amount) || 0),
    description: exp.description || '',
    source: exp.source || 'manual',
    entered_by: exp.entered_by || 'staff',
    match_confidence: exp.match_confidence || (trip ? 'MATCHED' : 'NONE'),
    ...brief,
    ...(exp.trip_db_id ? { trip_db_id: exp.trip_db_id } : {}),
    ...(exp.trip_id ? { trip_id: exp.trip_id } : {}),
    ...(exp.vehicle_no ? { vehicle_no: exp.vehicle_no } : {}),
    created_at: serverTimestamp(),
  };
  const ref = await addDoc(collection(db, 'EXPENSE_APPROVALS'), docData);
  logAudit({ action: 'RETRO_EXPENSE_SUBMITTED', target: docData.trip_id || docData.bill_no, details: `${docData.expense_type} ₹${docData.amount} (${docData.vendor_name || 'no vendor'})` });
  return ref.id;
}

/** ADMIN APPROVAL: post the retro expense into the books —
 *  Dr expense ledger / Cr vendor (or Cash), bump the trip's total_expense,
 *  and re-finalize a COMPLETED trip's settlement so the closed P&L stays true.
 *  Idempotent: journal doc id is derived from the approval doc id. */
export async function approveRetroExpense(exp: RetroExpense & { id: string }, approverName: string): Promise<void> {
  const amount = round2(Number(exp.amount) || 0);
  if (amount <= 0) throw new Error('Zero-amount expense cannot be approved');
  const ledger = EXPENSE_LEDGER[exp.expense_type] || EXPENSE_LEDGER.OTHER;
  const creditLedger = exp.vendor_name ? `Creditors: ${exp.vendor_name}` : 'Cash';
  const tag = exp.trip_id ? ` [Trip ${exp.trip_id}]` : '';

  await postEntry({
    source_type: 'RETRO_EXPENSE',
    source_ref: exp.id,
    date: exp.bill_date || new Date().toISOString().slice(0, 10),
    narration: `Retro ${exp.expense_type.toLowerCase()} bill ${exp.bill_no || ''} — ${exp.vendor_name || 'cash'}${tag} (${exp.vehicle_no || ''})`,
    lines: [
      { ledger, dr_cr: 'Dr', amount },
      { ledger: creditLedger, dr_cr: 'Cr', amount },
    ],
  });

  // Retro-adjust the specific trip's P&L (and its frozen settlement figure).
  if (exp.trip_db_id) {
    const tripRef = doc(db, 'TRIPS', exp.trip_db_id);
    const patch: any = { total_expense: increment(amount) };
    try {
      const snap = await getDoc(tripRef);
      if (snap.exists()) {
        const t = snap.data();
        const status = String(getField(t, ['trip_status', 'Trip_Status']) || '');
        if (status === 'COMPLETED') {
          const penalty = Number(getField(t, ['shortage_penalty', 'Shortage_Penalty'])) || 0;
          patch.final_balance = round2(getTripFreight(t) - (getTripExpense(t) + amount) - penalty);
          patch.retro_adjusted_at = new Date().toISOString();
        }
      }
    } catch { /* trip re-read failed — expense increment still applies */ }
    await updateDoc(tripRef, patch);
  }

  // Fuel bills also land in the FUEL_ENTRIES register (idempotent doc id).
  if (exp.expense_type === 'FUEL') {
    await setDoc(doc(db, 'FUEL_ENTRIES', `RETRO_${exp.id}`), {
      memo_no: exp.bill_no || `RETRO-${exp.id.slice(0, 6)}`,
      vehicle_no: exp.vehicle_no || '', trip_id: exp.trip_id || '',
      vendor_name: exp.vendor_name || '', amount, date: exp.bill_date || '',
      fuel_type: 'RETRO_BILL', source: 'expense_approval', created_at: serverTimestamp(),
    });
  }

  await updateDoc(doc(db, 'EXPENSE_APPROVALS', exp.id), {
    status: 'APPROVED', approved_by: approverName, approved_at: serverTimestamp(),
  });
  logAudit({ action: 'RETRO_EXPENSE_APPROVED', target: exp.trip_id || exp.bill_no, details: `${exp.expense_type} ₹${amount} by ${approverName}` });
}

export async function rejectRetroExpense(expId: string, reason: string, approverName: string): Promise<void> {
  await updateDoc(doc(db, 'EXPENSE_APPROVALS', expId), {
    status: 'REJECTED', rejection_reason: reason || '', approved_by: approverName, approved_at: serverTimestamp(),
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
/** Post the shortage penalty as a driver liability the moment unloading is
 *  approved: DRIVER_TRANSACTIONS debit (deterministic doc id — approving the
 *  same trip twice can never double-charge the driver) + journal entry
 *  Dr Driver Advances (recoverable) / Cr Shortage Recovery. */
export async function postShortageRecovery(trip: any, args: { shortage_qty: number; penalty_amount: number; date?: string }): Promise<boolean> {
  const penalty = round2(Number(args.penalty_amount) || 0);
  if (penalty <= 0) return false;
  const b = tripBrief(trip);
  const dateISO = args.date || new Date().toISOString().slice(0, 10);
  const driver = b.driver_name || 'Unknown Driver';
  const txnId = `SHORTAGE__${(b.trip_id || trip.id).replace(/[^A-Za-z0-9_-]/g, '_')}`;

  await setDoc(doc(db, 'DRIVER_TRANSACTIONS', txnId), {
    driver_name: driver, vehicle_no: b.vehicle_no, trip_id: b.trip_id,
    txn_type: 'SHORTAGE_DEDUCTION', amount: penalty, date: dateISO,
    remarks: `Auto: unloading shortage ${args.shortage_qty || 0} units @ trip ${b.trip_id} — recoverable from driver`,
    source: 'auto_unloading', createdAt: serverTimestamp(),
  });

  await postEntry({
    source_type: 'SHORTAGE_RECOVERY',
    source_ref: b.trip_id || trip.id,
    date: dateISO,
    narration: `Shortage penalty — driver ${driver}, trip ${b.trip_id} (${b.vehicle_no}), qty short ${args.shortage_qty || 0}`,
    lines: [
      { ledger: `Driver Advances: ${driver}`, dr_cr: 'Dr', amount: penalty },
      { ledger: 'Shortage / Loss Recovery', dr_cr: 'Cr', amount: penalty },
    ],
  }).catch(() => { /* journal is idempotent; khata entry above already stands */ });

  logAudit({ action: 'SHORTAGE_AUTO_DEBIT', target: b.trip_id, details: `₹${penalty} → ${driver} khata (${args.shortage_qty || 0} short)` });
  return true;
}

// ── Shared: all-trips fetch for bill matching (rare, on-demand) ──────────
let tripsCache: { at: number; trips: any[] } | null = null;
export async function fetchTripsForMatching(maxAgeMs = 120000): Promise<any[]> {
  if (tripsCache && Date.now() - tripsCache.at < maxAgeMs) return tripsCache.trips;
  const snap = await getDocs(collection(db, 'TRIPS'));
  const trips = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  tripsCache = { at: Date.now(), trips };
  return trips;
}
