// ═══════════════════════════════════════════════════════════════════════════
// statements.routes.js — account statement PDFs, scoped and master
//
// One data path, two doors:
//
//   /portal/…/statement.pdf   the party downloads THEIR OWN statement. Scope
//                             is the session's party id (portal rules: derived,
//                             never accepted), gated by the same module keys as
//                             the on-screen ledger.
//   /reports/…                the office generates the same document for ANY
//                             party, or the all-accounts master summary.
//                             Admin-only.
//
// Both call the same fetchers, so what a customer downloads and what the
// office prints for them are the same numbers by construction.
// ═══════════════════════════════════════════════════════════════════════════
import { query, isDegraded } from '../db/pool.js';
import { needsModule } from './portal.routes.js';
import { resolveDriver } from './driverPortal.routes.js';
import { requireAdminRole } from './auth.routes.js';
import { buildStatementPdf, fyWindow, inr } from '../lib/statementPdf.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sendPdf = (reply, bytes, filename) => reply
  .header('Content-Type', 'application/pdf')
  .header('Content-Disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
  .header('Cache-Control', 'no-store')
  .send(Buffer.from(bytes));

// ── Fetchers — one per party kind, identical for portal and office ──────────

async function customerStatement(customerId, win) {
  const { rows: [c] } = await query(
    `SELECT customer_name, gst_no::text AS gst_no, city, state, payment_terms, current_outstanding
       FROM customers WHERE id = $1::uuid`, [customerId]);
  if (!c) return null;
  const ledger = `Debtors: ${c.customer_name}`;
  const { rows: [op] } = await query(
    `SELECT COALESCE((SELECT opening_balance FROM ledgers WHERE lower(ledger_name)=lower($1) LIMIT 1),0)
          + COALESCE(SUM(amount) FILTER (WHERE dr_cr='DR'),0)
          - COALESCE(SUM(amount) FILTER (WHERE dr_cr='CR'),0) AS opening
       FROM ledger_entries WHERE lower(ledger_name)=lower($1) AND entry_date < $2::date`,
    [ledger, win.from]);
  const { rows: entries } = await query(
    `SELECT entry_date::text AS d, particulars, dr_cr, amount
       FROM ledger_entries
      WHERE lower(ledger_name)=lower($1) AND entry_date BETWEEN $2::date AND $3::date
      ORDER BY entry_date, id`, [ledger, win.from, win.to]);
  const { rows: bills } = await query(
    `SELECT bill_no, bill_date::text AS d, total_net, received_amount, status
       FROM company_bills
      WHERE customer_id = $1::uuid AND bill_date BETWEEN $2::date AND $3::date
      ORDER BY bill_date`, [customerId, win.from, win.to]);

  let bal = Number(op.opening);
  const rows = entries.map((e) => {
    bal += e.dr_cr === 'DR' ? Number(e.amount) : -Number(e.amount);
    return {
      d: e.d, p: e.particulars ?? '',
      dr: e.dr_cr === 'DR' ? inr(e.amount) : '', cr: e.dr_cr === 'CR' ? inr(e.amount) : '',
      bal: `${inr(Math.abs(bal))} ${bal >= 0 ? 'Dr' : 'Cr'}`,
    };
  });
  const totalDr = entries.filter((e) => e.dr_cr === 'DR').reduce((s, e) => s + Number(e.amount), 0);
  const totalCr = entries.filter((e) => e.dr_cr === 'CR').reduce((s, e) => s + Number(e.amount), 0);

  return {
    party: {
      name: c.customer_name,
      lines: [
        [c.city, c.state].filter(Boolean).join(', '),
        c.gst_no ? `GSTIN: ${c.gst_no}` : null,
        c.payment_terms ? `Terms: ${c.payment_terms}` : null,
      ].filter(Boolean),
    },
    sections: [
      {
        heading: 'Ledger (khata)',
        columns: [
          { key: 'd', label: 'DATE', w: 62 },
          { key: 'p', label: 'PARTICULARS', w: 213, max: 52 },
          { key: 'dr', label: 'DEBIT', w: 80, align: 'right' },
          { key: 'cr', label: 'CREDIT', w: 80, align: 'right' },
          { key: 'bal', label: 'BALANCE', w: 80, align: 'right' },
        ],
        rows,
        note: `Opening balance on ${win.from}: ${inr(Math.abs(op.opening))} ${Number(op.opening) >= 0 ? 'Dr' : 'Cr'}`,
      },
      {
        heading: 'Bills in the period',
        columns: [
          { key: 'bill_no', label: 'BILL NO', w: 110 },
          { key: 'd', label: 'DATE', w: 70 },
          { key: 'net', label: 'AMOUNT', w: 110, align: 'right' },
          { key: 'recv', label: 'RECEIVED', w: 110, align: 'right' },
          { key: 'status', label: 'STATUS', w: 115 },
        ],
        rows: bills.map((b) => ({
          bill_no: b.bill_no, d: b.d, net: inr(b.total_net), recv: inr(b.received_amount), status: b.status ?? '',
        })),
      },
    ],
    summary: [
      ['Total debits in period', inr(totalDr)],
      ['Total credits in period', inr(totalCr)],
      ['Closing balance', `${inr(Math.abs(bal))} ${bal >= 0 ? 'Dr' : 'Cr'}`],
    ],
  };
}

async function vendorStatement(vendorId, win) {
  const { rows: [v] } = await query(
    `SELECT vendor_name, gst_no::text AS gst_no, payment_terms, current_balance, opening_balance
       FROM vendors WHERE id = $1::uuid`, [vendorId]);
  if (!v) return null;
  const { rows: txns } = await query(
    `SELECT txn_date::text AS d, txn_type, amount, payment_mode, remarks,
            approval_status, voucher_id
       FROM vendor_txns
      WHERE vendor_id = $1::uuid AND txn_date BETWEEN $2::date AND $3::date
      ORDER BY txn_date, created_at`, [vendorId, win.from, win.to]);
  const sum = (f) => txns.filter(f).reduce((s, t) => s + Number(t.amount), 0);
  const posted = sum((t) => t.approval_status === 'APPROVED' && t.voucher_id);
  return {
    party: {
      name: v.vendor_name,
      lines: [
        v.gst_no ? `GSTIN: ${v.gst_no}` : null,
        v.payment_terms ? `Terms: ${v.payment_terms}` : null,
      ].filter(Boolean),
    },
    sections: [{
      heading: 'Account transactions',
      columns: [
        { key: 'd', label: 'DATE', w: 62 },
        { key: 't', label: 'TYPE', w: 105 },
        { key: 'amt', label: 'AMOUNT', w: 85, align: 'right' },
        { key: 'mode', label: 'MODE', w: 78 },
        { key: 'st', label: 'STATE', w: 70 },
        { key: 'rem', label: 'REMARKS', w: 115, max: 30 },
      ],
      rows: txns.map((t) => ({
        d: t.d, t: t.txn_type ?? '', amt: inr(t.amount), mode: t.payment_mode ?? '',
        st: t.approval_status === 'APPROVED' && t.voucher_id ? 'in books' : 'pending',
        rem: t.remarks ?? '',
      })),
      note: '"pending" rows await office approval and are not yet money owed either way.',
    }],
    summary: [
      ['Transactions in period', String(txns.length)],
      ['Amount posted to books (period)', inr(posted)],
      ['Current account balance', inr(v.current_balance)],
    ],
  };
}

async function driverStatement(driverId, win) {
  const { rows: [d] } = await query(
    `SELECT id, name, mobile FROM drivers WHERE id = $1::uuid`, [driverId]);
  if (!d) return null;
  const { rows: txns } = await query(
    `SELECT dt.txn_date::text AS dte, dt.txn_type, dt.amount, dt.mode, dt.remarks, t.trip_code
       FROM driver_transactions dt LEFT JOIN trips t ON t.id = dt.trip_id
      WHERE (dt.driver_id = $1::uuid OR dt.driver_name = $2)
        AND dt.txn_date BETWEEN $3::date AND $4::date
      ORDER BY dt.txn_date, dt.created_at`, [d.id, d.name, win.from, win.to]);
  const given = txns.filter((t) => ['ADVANCE_GIVEN', 'FUEL_EXPENSE'].includes(t.txn_type))
    .reduce((s, t) => s + Number(t.amount), 0);
  const earned = txns.filter((t) => !['ADVANCE_GIVEN', 'FUEL_EXPENSE'].includes(t.txn_type))
    .reduce((s, t) => s + Number(t.amount), 0);
  return {
    party: { name: d.name, lines: [d.mobile ? `Mobile: ${d.mobile}` : null].filter(Boolean) },
    sections: [{
      heading: 'Khata entries',
      columns: [
        { key: 'dte', label: 'DATE', w: 62 },
        { key: 't', label: 'TYPE', w: 110 },
        { key: 'amt', label: 'AMOUNT', w: 85, align: 'right' },
        { key: 'trip', label: 'TRIP', w: 90 },
        { key: 'rem', label: 'REMARKS', w: 168, max: 42 },
      ],
      rows: txns.map((t) => ({
        dte: t.dte, t: t.txn_type ?? '', amt: inr(t.amount), trip: t.trip_code ?? '', rem: t.remarks ?? '',
      })),
    }],
    summary: [
      ['Advances / fuel given', inr(given)],
      ['Earned / recovered', inr(earned)],
      ['Net for period', inr(earned - given)],
    ],
  };
}

const KIND_FETCHERS = { CUSTOMER: customerStatement, VENDOR: vendorStatement, DRIVER: driverStatement };

async function servePdf(reply, kind, partyId, q) {
  const win = fyWindow(q?.from, q?.to);
  const data = await KIND_FETCHERS[kind](partyId, win);
  if (!data) return reply.code(404).send({ error: 'NOT_FOUND' });
  const bytes = await buildStatementPdf({
    firm: 'PRASAD TRANSPORT',
    title: `${kind.charAt(0)}${kind.slice(1).toLowerCase()} Account Statement`,
    period: win.label,
    ...data,
  });
  return sendPdf(reply, bytes, `statement-${data.party.name}-${win.from}-${win.to}.pdf`);
}

export function registerStatementRoutes(app) {
  // ── The party's own statement — same gates as the on-screen ledger ───────
  app.get('/portal/customer/statement.pdf', { preHandler: needsModule('cust.ledger') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    return servePdf(reply, 'CUSTOMER', req.party.customerId, req.query);
  });
  app.get('/portal/vendor/statement.pdf', { preHandler: needsModule('vend.bills') }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    return servePdf(reply, 'VENDOR', req.party.vendorId, req.query);
  });
  app.get('/portal/driver/statement.pdf', { preHandler: resolveDriver }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    return servePdf(reply, 'DRIVER', req.driver.id, req.query);
  });

  // ── Office: any one party ────────────────────────────────────────────────
  app.get('/reports/party-statement.pdf', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kind = String(req.query?.kind ?? '').toUpperCase();
    if (!KIND_FETCHERS[kind]) return reply.code(400).send({ error: 'BAD_KIND', detail: 'kind must be CUSTOMER, VENDOR or DRIVER' });
    if (!UUID_RE.test(String(req.query?.id ?? ''))) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'id (uuid) is required' });
    return servePdf(reply, kind, req.query.id, req.query);
  });

  // ── Office: the master summary — every account, one line each ────────────
  app.get('/reports/all-accounts.pdf', { preHandler: requireAdminRole }, async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const win = fyWindow(req.query?.from, req.query?.to);
    const [customers, vendors, drivers] = await Promise.all([
      query(`SELECT customer_name, current_outstanding FROM customers
              WHERE status='ACTIVE' ORDER BY current_outstanding DESC NULLS LAST LIMIT 500`),
      query(`SELECT vendor_name, current_balance FROM vendors
              WHERE status='ACTIVE' ORDER BY abs(current_balance) DESC NULLS LAST LIMIT 500`),
      query(`SELECT d.name,
                    COALESCE(sum(dt.amount) FILTER (WHERE dt.txn_type IN ('ADVANCE_GIVEN','FUEL_EXPENSE')),0)
                  - COALESCE(sum(dt.amount) FILTER (WHERE dt.txn_type NOT IN ('ADVANCE_GIVEN','FUEL_EXPENSE')),0) AS outstanding
               FROM drivers d LEFT JOIN driver_transactions dt
                 ON dt.driver_id = d.id OR dt.driver_name = d.name
              WHERE d.status='ACTIVE' GROUP BY d.id, d.name
              ORDER BY 2 DESC NULLS LAST LIMIT 500`),
    ]);
    const two = (label, rows2, k1, k2) => ({
      heading: label,
      columns: [
        { key: 'n', label: 'ACCOUNT', w: 330, max: 70 },
        { key: 'v', label: 'BALANCE', w: 185, align: 'right' },
      ],
      rows: rows2.map((r) => ({ n: r[k1], v: inr(r[k2]) })),
    });
    const bytes = await buildStatementPdf({
      firm: 'PRASAD TRANSPORT',
      title: 'Master Account Summary — all parties',
      period: win.label,
      party: { name: 'All accounts', lines: ['Customers, fleet partners (vendors) and drivers with active status'] },
      sections: [
        two(`Customers (${customers.rows.length}) — outstanding receivable`, customers.rows, 'customer_name', 'current_outstanding'),
        two(`Fleet partners / vendors (${vendors.rows.length}) — account balance`, vendors.rows, 'vendor_name', 'current_balance'),
        two(`Drivers (${drivers.rows.length}) — net advance outstanding`, drivers.rows, 'name', 'outstanding'),
      ],
      summary: [
        ['Total customer outstanding', inr(customers.rows.reduce((s, r) => s + Number(r.current_outstanding ?? 0), 0))],
        ['Total vendor balances', inr(vendors.rows.reduce((s, r) => s + Number(r.current_balance ?? 0), 0))],
        ['Total driver net advances', inr(drivers.rows.reduce((s, r) => s + Number(r.outstanding ?? 0), 0))],
      ],
    });
    return sendPdf(reply, bytes, `all-accounts-${win.from}-${win.to}.pdf`);
  });
}
