// server/lib/payouts.js
// ─────────────────────────────────────────────────────────────────────────────
// THE PAYOUT ENGINE'S PURE PARTS — the UPI URI, the PIN, and the OTP decision.
//
// Everything here is deliberately free of routes and of Fastify, so the rules
// can be unit-tested without a server and reused by any screen that pays
// somebody. The money itself moves in payouts.routes.js, inside one transaction.
//
// NO PROVIDER IS CONNECTED. The owner chose "rail-ready" on 6-Sep-2026: an
// instruction reaches PENDING_BANK and a person completes the transfer in
// net-banking and enters the UTR. When RazorpayX or Cashfree is signed up, the
// adapter lands in sendViaRail() below and nothing else changes shape.
// ─────────────────────────────────────────────────────────────────────────────
import { hashCode, verifyCode } from './auth.js';

/** The kinds an account may be allowed to pay. OWNER = personal withdrawal. */
export const BENEFICIARY_KINDS = ['DRIVER', 'VENDOR', 'PUMP', 'FLEET_PARTNER', 'STAFF', 'OWNER'];
export const RAILS = ['UPI_QR', 'IMPS', 'NEFT', 'CASH'];

/** A VPA is `handle@psp`. Same expression as the CHECK in migration 177, so the
 *  API refuses what the database would refuse, with a readable message. */
export const VPA_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z]{2,32}$/;

/**
 * Build the `upi://pay` URI for a QR.
 *
 * The payee is the PAYING ENTITY's VPA — that is the entire point of a
 * multi-company payout, and passing a global handle here would silently route
 * every firm's money through one account.
 *
 * NPCI's spec is strict in two ways worth knowing:
 *   · `am` must be a plain decimal with two places. "18400" and "18,400.00"
 *     are both refused by some PSP apps, and a refusal here looks to a driver
 *     like the QR is broken.
 *   · every value is percent-encoded. A transaction note carrying "TS-2609/41"
 *     would otherwise truncate the URI at the slash in a few readers.
 */
export function buildUpiUri({ vpa, payeeName, amount, note, txnRef }) {
  if (!VPA_RE.test(String(vpa ?? '')))
    throw Object.assign(new Error(`'${vpa}' is not a valid UPI VPA`), { code: 'BAD_VPA' });
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0)
    throw Object.assign(new Error('amount must be > 0'), { code: 'BAD_AMOUNT' });

  const p = new URLSearchParams();
  p.set('pa', String(vpa));
  if (payeeName) p.set('pn', String(payeeName).slice(0, 50));
  p.set('am', amt.toFixed(2));
  p.set('cu', 'INR');
  if (txnRef) p.set('tr', String(txnRef).slice(0, 35));
  if (note) p.set('tn', String(note).slice(0, 50));
  // URLSearchParams encodes space as '+', which UPI readers take literally.
  return `upi://pay?${p.toString().replace(/\+/g, '%20')}`;
}

// ── The PIN ─────────────────────────────────────────────────────────────────
// Reuses hashCode/verifyCode from lib/auth.js rather than inventing a second
// hashing scheme in the same codebase — one place to fix if the algorithm ever
// has to change.

export const PIN_RE = /^\d{4,6}$/;
const MAX_PIN_FAILS = 3;
const PIN_LOCK_MINUTES = 15;

/** Reject the PINs an attacker tries first. A 4-digit secret guarding a bank
 *  payout cannot also be 1234. */
const WEAK_PINS = new Set(['0000', '1111', '2222', '3333', '4444', '5555', '6666',
  '7777', '8888', '9999', '1234', '4321', '0123', '123456', '654321', '111111', '000000']);

export function pinProblem(pin) {
  if (!PIN_RE.test(String(pin ?? ''))) return 'PIN must be 4 to 6 digits';
  if (WEAK_PINS.has(String(pin))) return 'that PIN is too easy to guess — choose another';
  if (/^(\d)\1+$/.test(String(pin))) return 'a PIN of one repeated digit is too easy to guess';
  return null;
}

export const hashPin = (pin) => hashCode(String(pin));

/**
 * Verify a PIN against a user row and say what should happen next.
 *
 * Returns { ok, reason, lockFor } — the caller writes the fail count, because
 * that write belongs in the same transaction as the payout it guards.
 */
export function checkPin(user, pin) {
  if (!user?.pin_hash || !user?.pin_salt)
    return { ok: false, reason: 'PIN_NOT_SET', detail: 'Set your payout PIN in Profile before authorising a payment.' };
  if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date())
    return { ok: false, reason: 'PIN_LOCKED', detail: `Too many wrong PINs. Try again after ${new Date(user.pin_locked_until).toLocaleTimeString('en-IN')}.` };
  if (!PIN_RE.test(String(pin ?? '')))
    return { ok: false, reason: 'BAD_PIN', detail: 'PIN must be 4 to 6 digits.' };
  if (!verifyCode(String(pin), user.pin_salt, user.pin_hash)) {
    const fails = Number(user.pin_fail_count ?? 0) + 1;
    return {
      ok: false, reason: 'BAD_PIN', fails,
      lockFor: fails >= MAX_PIN_FAILS ? PIN_LOCK_MINUTES : 0,
      detail: fails >= MAX_PIN_FAILS
        ? `Wrong PIN. Locked for ${PIN_LOCK_MINUTES} minutes.`
        : `Wrong PIN. ${MAX_PIN_FAILS - fails} attempt(s) left.`,
    };
  }
  return { ok: true };
}

// ── The rail ────────────────────────────────────────────────────────────────

/**
 * Hand the instruction to a bank rail.
 *
 * There is no provider today, so this returns `accepted:false` with a reason
 * and the caller parks the payout at PENDING_BANK for a person to complete.
 * It is a function rather than an `if` at the call site precisely so signing up
 * with RazorpayX or Cashfree is one implementation here, not a redesign — and
 * so the route's shape is already the shape a real rail needs: idempotency key
 * in, provider reference out.
 */
export async function sendViaRail({ rail, idempotencyKey }) {   // eslint-disable-line no-unused-vars
  if (rail === 'CASH' || rail === 'UPI_QR') {
    return { accepted: false, manual: true, reason: 'NO_RAIL_NEEDED' };
  }
  return {
    accepted: false,
    manual: true,
    reason: 'NO_PROVIDER',
    detail: 'No bank payout provider is connected. Complete the transfer in net-banking and enter the UTR.',
  };
}
