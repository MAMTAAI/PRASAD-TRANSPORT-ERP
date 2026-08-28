// server/lib/contactDirectory.js
// ─────────────────────────────────────────────────────────────────────────────
// WHO IS ON OUR BOOKS, AND WHAT KIND ARE THEY — in one place.
//
// This answer was being derived in three places that had already drifted apart:
//
//   1. dashboard.routes.js  drivers ∪ customers ∪ vendors, to label the Live
//                           Dispatch Chat tabs.
//   2. crm.routes.js        the same three, again, as the privacy gate on
//                           POST /chats.
//   3. WhatsappDashboard.tsx  drivers ∪ customers ∪ companies ∪ wa_contacts,
//                           assembled in the BROWSER from four fetches, to fill
//                           the Broadcast Center.
//
// So the Broadcast Center listed all 74 reachable people while Live Dispatch
// Chat could recognise none of them, and the fuel pumps — the numbers dispatch
// rings most — were not a category anywhere. Same question, three answers.
//
// FUEL PUMPS ARE NOT A NEW TABLE. There are 11 of them, and they have been in
// `vendors` all along under `vendor_type = 'Fuel Pump'`. Copies 1 and 2 flattened
// every vendor to VENDOR, which is why a pump writing in landed in "Anjaan": not
// unknown at all, just unasked-for. Splitting them out here gives dispatch the
// tab it needs without a migration.
//
// LAST TEN DIGITS IS THE KEY, everywhere. `+91 98765-43210`, `919876543210` and
// `9876543210` are one person, and WhatsApp hands us whichever it feels like.
// ─────────────────────────────────────────────────────────────────────────────
import { query } from '../db/pool.js';

export const last10 = (p) => String(p ?? '').replace(/\D/g, '').slice(-10);

/** Ordered: lower rank wins when one number appears on two masters. An
 *  owner-driver who is also a vendor is a DRIVER to dispatch — that is the
 *  relationship the office has with the number when it rings. Fixed, not
 *  arbitrary, so a contact cannot change tab between two refreshes. */
export const KINDS = ['DRIVER', 'PUMP', 'VENDOR', 'CUSTOMER', 'CONTACT'];

/** The union, as a CTE body. Exported as SQL text rather than as rows because
 *  its callers join against it inside larger queries — pulling 74 rows into
 *  node to filter them there would be the same drift in a new costume. */
export const DIRECTORY_CTE = `
  directory AS (
    SELECT right(regexp_replace(mobile, '[^0-9]', '', 'g'), 10) AS phone,
           'DRIVER'::text AS kind, id AS driver_id, name AS contact_name,
           NULL::text AS sub, 1 AS rank
      FROM drivers
     WHERE mobile IS NOT NULL
       AND length(regexp_replace(mobile, '[^0-9]', '', 'g')) >= 10
    UNION ALL
    -- Fuel pumps first, so the CASE below cannot put one in the VENDOR bucket.
    SELECT right(regexp_replace(mobile_no, '[^0-9]', '', 'g'), 10),
           CASE WHEN vendor_type = 'Fuel Pump' THEN 'PUMP' ELSE 'VENDOR' END,
           NULL::uuid, vendor_name, vendor_type,
           CASE WHEN vendor_type = 'Fuel Pump' THEN 2 ELSE 3 END
      FROM vendors
     WHERE mobile_no IS NOT NULL AND status = 'ACTIVE'
       AND length(regexp_replace(mobile_no, '[^0-9]', '', 'g')) >= 10
    UNION ALL
    SELECT right(regexp_replace(mobile_no, '[^0-9]', '', 'g'), 10),
           'CUSTOMER', NULL::uuid, customer_name, NULL::text, 4
      FROM customers
     WHERE mobile_no IS NOT NULL AND status = 'ACTIVE'
       AND length(regexp_replace(mobile_no, '[^0-9]', '', 'g')) >= 10
    UNION ALL
    -- Hand-added numbers. Last by rank on purpose: a master record carries a
    -- relationship the ERP can act on, a typed-in one carries a name.
    SELECT right(regexp_replace(phone, '[^0-9]', '', 'g'), 10),
           CASE upper(COALESCE(category, ''))
             WHEN 'DRIVER' THEN 'DRIVER' WHEN 'VENDOR' THEN 'VENDOR'
             WHEN 'CUSTOMER' THEN 'CUSTOMER' WHEN 'PUMP' THEN 'PUMP'
             ELSE 'CONTACT' END,
           NULL::uuid, name, category, 5
      FROM wa_contacts
     WHERE phone IS NOT NULL
       AND length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 10
  ),
  dir AS (
    SELECT DISTINCT ON (phone) phone, kind, driver_id, contact_name, sub
      FROM directory ORDER BY phone, rank
  )`;

/** The picker's list. `q` matches name OR number, because dispatch remembers
 *  one or the other and never reliably both. */
export async function listDirectory({ q = '', kind = '', limit = 500 } = {}) {
  const args = [];
  const where = [];
  if (q) {
    args.push(`%${String(q).trim()}%`);
    args.push(`%${String(q).replace(/\D/g, '')}%`);
    where.push(`(contact_name ILIKE $${args.length - 1} OR ($${args.length} <> '%%' AND phone LIKE $${args.length}))`);
  }
  if (kind && KINDS.includes(String(kind).toUpperCase())) {
    args.push(String(kind).toUpperCase());
    where.push(`kind = $${args.length}`);
  }
  args.push(Math.min(Number.parseInt(limit, 10) || 500, 2000));
  const { rows } = await query(`
    WITH ${DIRECTORY_CTE}
    SELECT phone, kind, driver_id, contact_name, sub
      FROM dir
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY kind, contact_name
     LIMIT $${args.length}`, args);
  return rows.map((r) => ({
    phone: r.phone,
    name: r.contact_name || null,
    kind: r.kind,
    sub: r.sub || null,
    driver_id: r.driver_id || null,
  }));
}

/** One number. Returns null when the ERP has never heard of it — which is a
 *  real answer the callers act on, not an error. */
export async function resolveContact(phone) {
  const p = last10(phone);
  if (p.length < 10) return null;
  const { rows } = await query(`
    WITH ${DIRECTORY_CTE}
    SELECT phone, kind, driver_id, contact_name, sub FROM dir WHERE phone = $1`, [p]);
  if (!rows.length) return null;
  const r = rows[0];
  return { phone: r.phone, name: r.contact_name || null, kind: r.kind, sub: r.sub || null, driver_id: r.driver_id || null };
}
