// 🔗 Posting rules: map an Operations event -> a balanced double-entry
// JournalEntry (Phase 12.2). Pure functions (no Firestore) so they're easy to
// test and reuse. Each entry's source_ref is deterministic => idempotent via
// postEntry(). A builder returns null when there's nothing to post (e.g. ₹0).
import type { JournalEntry } from './journal';

const g = (o: any, keys: string[], dflt = ''): string => {
  for (const k of keys) {
    const hit = Object.keys(o || {}).find(ok => ok.toLowerCase().replace(/[^a-z0-9]/g, '') === k.toLowerCase().replace(/[^a-z0-9]/g, ''));
    if (hit && o[hit] != null && String(o[hit]).trim() !== '') return String(o[hit]);
  }
  return dflt;
};
const num = (o: any, keys: string[]): number => parseFloat(g(o, keys, '0')) || 0;

// Customers are debtor ledgers, vendors are creditor ledgers (shared masters).
const debtor = (name: string) => `Debtors: ${name || 'Unknown Customer'}`;
const creditor = (name: string) => `Creditors: ${name || 'Unknown Vendor'}`;

/** Trip completed / LR freight -> Dr Customer (Receivable), Cr Freight Income.
 *  ★ This is what makes Total Revenue non-zero once trips carry a freight value. */
export function tripFreightEntry(trip: any): JournalEntry | null {
  const freight = num(trip, ['gross_freight', 'Gross_Freight', 'Freight', 'Rate', 'total_freight']);
  if (freight <= 0) return null; // nothing to post (today's data: Rate=0)
  const ref = g(trip, ['trip_id', 'Trip_ID', 'id']);
  const cust = g(trip, ['customer_name', 'Customer', 'Registered_Assessee']);
  return {
    source_type: 'TRIP_FREIGHT', source_ref: ref,
    date: g(trip, ['unloading_date', 'start_date', 'Loading_Date']) || '',
    narration: `Freight income — trip ${ref} (${cust})`,
    company: g(trip, ['operating_company', 'Operating_Company']),
    lines: [
      { ledger: debtor(cust), dr_cr: 'Dr', amount: freight },
      { ledger: 'Direct Incomes (Freight/Trip Revenue)', dr_cr: 'Cr', amount: freight },
    ],
  };
}

/** Customer payment received -> Dr Cash/Bank, Cr Customer. */
export function customerPaymentEntry(p: any): JournalEntry | null {
  const amt = num(p, ['amount', 'Amount', 'paid']);
  if (amt <= 0) return null;
  const ref = g(p, ['payment_id', 'voucher_id', 'id', 'ref_no']);
  const cust = g(p, ['customer_name', 'Customer', 'party_name']);
  const mode = g(p, ['mode', 'payment_mode'], 'Cash');
  const intoBank = /bank|neft|rtgs|upi|cheque|online/i.test(mode);
  return {
    source_type: 'CUSTOMER_PAYMENT', source_ref: ref,
    date: g(p, ['date', 'payment_date']) || '',
    narration: `Payment received — ${cust} (${mode})`,
    lines: [
      { ledger: intoBank ? 'Bank' : 'Cash', dr_cr: 'Dr', amount: amt },
      { ledger: debtor(cust), dr_cr: 'Cr', amount: amt },
    ],
  };
}

/** Fuel (HSD) issued -> Dr Diesel Expense, Cr Pump/Vendor (or Cash). */
export function fuelEntry(f: any): JournalEntry | null {
  const amt = num(f, ['amount', 'Amount', 'fuel_amount']);
  if (amt <= 0) return null;
  const ref = g(f, ['memo_no', 'voucher_id', 'id']);
  const pump = g(f, ['vendor_name', 'pump_name', 'pump']);
  const onCash = !pump || /cash/i.test(g(f, ['fuel_type', 'mode']));
  return {
    source_type: 'FUEL', source_ref: ref,
    date: g(f, ['date']) || '',
    narration: `Diesel issued — ${pump || 'Cash'} (${g(f, ['vehicle_no', 'Vehical_No'])})`,
    lines: [
      { ledger: 'Diesel / Fuel Expense', dr_cr: 'Dr', amount: amt },
      { ledger: onCash ? 'Cash' : creditor(pump), dr_cr: 'Cr', amount: amt },
    ],
  };
}

/** Market-vehicle hire -> Dr Hire Expense, Cr Vendor (Creditor). */
export function hireEntry(h: any): JournalEntry | null {
  const amt = num(h, ['hire_amount', 'amount', 'Rate']);
  if (amt <= 0) return null;
  const ref = g(h, ['trip_id', 'Trip_ID', 'id']);
  const vendor = g(h, ['vendor_name', 'owner_name', 'vendor_agency']);
  return {
    source_type: 'MARKET_HIRE', source_ref: ref,
    date: g(h, ['start_date', 'date']) || '',
    narration: `Market vehicle hire — ${vendor}`,
    lines: [
      { ledger: 'Direct Expenses (Vehicle Hire)', dr_cr: 'Dr', amount: amt },
      { ledger: creditor(vendor), dr_cr: 'Cr', amount: amt },
    ],
  };
}

/** Vendor payment -> Dr Vendor, Cr Bank. */
export function vendorPaymentEntry(p: any): JournalEntry | null {
  const amt = num(p, ['amount', 'Amount', 'paid']);
  if (amt <= 0) return null;
  const ref = g(p, ['payment_id', 'voucher_id', 'id', 'ref_no']);
  const vendor = g(p, ['vendor_name', 'party_name']);
  const mode = g(p, ['mode', 'payment_mode'], 'Bank');
  return {
    source_type: 'VENDOR_PAYMENT', source_ref: ref,
    date: g(p, ['date', 'payment_date']) || '',
    narration: `Paid vendor — ${vendor} (${mode})`,
    lines: [
      { ledger: creditor(vendor), dr_cr: 'Dr', amount: amt },
      { ledger: /cash/i.test(mode) ? 'Cash' : 'Bank', dr_cr: 'Cr', amount: amt },
    ],
  };
}

/** Toll / Fastag -> Dr Toll Expense, Cr Bank/wallet. */
export function tollEntry(t: any): JournalEntry | null {
  const amt = num(t, ['toll_amt', 'amount', 'Toll']);
  if (amt <= 0) return null;
  const ref = g(t, ['toll_id', 'txn_id', 'id', 'trip_id']);
  return {
    source_type: 'TOLL', source_ref: ref,
    date: g(t, ['date']) || '',
    narration: `Toll/Fastag — ${g(t, ['vehicle_no', 'Vehical_No'])}`,
    lines: [
      { ledger: 'Toll & Fastag Expense', dr_cr: 'Dr', amount: amt },
      { ledger: 'Fastag Wallet / Bank', dr_cr: 'Cr', amount: amt },
    ],
  };
}

/** Loan EMI -> split Dr Loan (principal) + Dr Interest, Cr Bank. */
export function emiEntry(e: any): JournalEntry | null {
  const principal = num(e, ['principal', 'principal_amt']);
  const interest = num(e, ['interest', 'interest_amt']);
  const total = principal + interest || num(e, ['emi_amount', 'amount']);
  if (total <= 0) return null;
  const ref = g(e, ['emi_id', 'voucher_id', 'id']);
  const lender = g(e, ['lender', 'loan_name', 'bank']);
  const lines = [];
  if (principal > 0) lines.push({ ledger: `Loan: ${lender}`, dr_cr: 'Dr' as const, amount: principal });
  if (interest > 0) lines.push({ ledger: 'Interest Expense', dr_cr: 'Dr' as const, amount: interest });
  if (!lines.length) lines.push({ ledger: `Loan: ${lender}`, dr_cr: 'Dr' as const, amount: total });
  lines.push({ ledger: 'Bank', dr_cr: 'Cr' as const, amount: total });
  return {
    source_type: 'EMI', source_ref: ref,
    date: g(e, ['date', 'due_date']) || '',
    narration: `EMI paid — ${lender} (P ${principal} + I ${interest})`,
    lines,
  };
}

export const POSTING_RULES = {
  TRIP_FREIGHT: tripFreightEntry,
  CUSTOMER_PAYMENT: customerPaymentEntry,
  FUEL: fuelEntry,
  MARKET_HIRE: hireEntry,
  VENDOR_PAYMENT: vendorPaymentEntry,
  TOLL: tollEntry,
  EMI: emiEntry,
};
