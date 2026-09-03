// server/modules/access.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// THE ADMIN CONTROL HUB — one API over every outside party's portal access.
//
// Five kinds, one shape: Customers, Fleet Partners, Service Vendors, Drivers,
// Market Drivers. For each row the office sees the derived ACCESS STATE
// (ACTIVE / PENDING / BLOCKED / ARCHIVED), whether a login exists, live
// sessions, and takes four decisions — activate, block, archive, edit — plus
// per-party feature toggles and session revocation. Every decision is a row in
// access_hub_audit (131).
//
// What "activate / block / archive" actually do, so nobody has to guess:
//   ACTIVATE  gate open (is_approved_for_portal = true), an ARCHIVED/INACTIVE
//             master row back to ACTIVE, the login (users) ACTIVE — created if
//             the party has none and has a mobile — and a WhatsApp notice.
//   BLOCK     gate closed, login INACTIVE + SUSPENDED, live sessions deleted.
//             The master row keeps its status: the business relationship goes
//             on, only the portal is shut. Reason recorded and shown.
//   ARCHIVE   BLOCK + master status ARCHIVED. Never a DELETE: a party with
//             ledger history must stay referenceable for ever.
//   EDIT      name / mobile / email (+ plan and ceiling for partners); the
//             linked login's name and mobile follow, because OTP login matches
//             by mobile.
// Market drivers have no login: they map onto market_drivers.system_status.
//
// Admin only, every route. External roles cannot reach /api/v1/access at all
// (apiGuard closes every prefix they are not listed for).
// ─────────────────────────────────────────────────────────────────────────────
import { randomBytes } from 'node:crypto';
import { query, withTransaction, isDegraded } from '../db/pool.js';
import { requireAdminRole } from './auth.routes.js';
import { hashPassword, ALGO } from '../lib/auth.js';
import { notifyWhatsApp } from '../lib/notify.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const last10 = (v) => String(v ?? '').replace(/\D/g, '').slice(-10);
const actorOf = (req) => ({ id: req.user?.sub ?? null, name: req.user?.name ?? req.user?.email ?? null });

const KINDS = {
  CUSTOMER:       { table: 'customers', role: 'CUSTOMER', link: 'customer_id', nameCol: 'customer_name', mobileCol: 'mobile_no', features: true },
  FLEET_PARTNER:  { table: 'vendors',   role: 'VENDOR',   link: 'vendor_id',   nameCol: 'vendor_name',   mobileCol: 'mobile_no', features: true, kindWhere: "vendor_kind = 'FLEET_PARTNER'" },
  SERVICE_VENDOR: { table: 'vendors',   role: 'VENDOR',   link: 'vendor_id',   nameCol: 'vendor_name',   mobileCol: 'mobile_no', features: true, kindWhere: "vendor_kind = 'SERVICE'" },
  DRIVER:         { table: 'drivers',   role: 'DRIVER',   nameCol: 'name',   mobileCol: 'mobile' },
  MARKET_DRIVER:  { table: 'market_drivers', nameCol: 'name', mobileCol: 'mobile', market: true },
  // A truck is a party the office turns on and off too (owner, 3-Sep): "a
  // partner/vehicle cannot be used in the system if marked deactivated". It has
  // no login and no mobile — it maps onto market_vehicles.system_status, the
  // same column every dispatch path already checks for 'System Active'.
  MARKET_VEHICLE: { table: 'market_vehicles', nameCol: 'registration_no', mobileCol: null, market: true },
};
const kindOf = (s) => KINDS[String(s ?? '').toUpperCase()] ? String(s).toUpperCase() : null;

// Columns the inline editor may touch, per kind. Anything else is 400.
const EDITABLE = {
  CUSTOMER:       { name: 'customer_name', mobile: 'mobile_no', email: 'email', contact_person: 'contact_person', gst_no: 'gst_no' },
  FLEET_PARTNER:  { name: 'vendor_name', mobile: 'mobile_no', email: 'email', owner_name: 'owner_name', pan_no: 'pan_no', subscription_plan: 'subscription_plan', max_vehicle_limit: 'max_vehicle_limit' },
  SERVICE_VENDOR: { name: 'vendor_name', mobile: 'mobile_no', email: 'email', owner_name: 'owner_name', pan_no: 'pan_no' },
  DRIVER:         { name: 'name', mobile: 'mobile', license_no: 'license_no', license_expiry: 'license_expiry' },
  MARKET_DRIVER:  { name: 'name', mobile: 'mobile', licence_no: 'licence_no', licence_expiry: 'licence_expiry' },
  MARKET_VEHICLE: { vehicle_class: 'vehicle_class', capacity: 'capacity', engine_no: 'engine_no', chassis_no: 'chassis_no' },
};

const LAST_ACTION = `
  LEFT JOIN LATERAL (
    SELECT a.action, a.reason, a.actor_name, a.created_at
      FROM access_hub_audit a WHERE a.party_id = x.id
     ORDER BY a.created_at DESC LIMIT 1) la ON true`;

const SEARCH = (nameCol, mobileCol) =>
  `($1 = '' OR x.${nameCol} ILIKE '%' || $1 || '%' OR COALESCE(x.${mobileCol}, '') LIKE '%' || $1 || '%'`
  + ` OR COALESCE(x.email::text, '') ILIKE '%' || $1 || '%')`;

function listSql(kind) {
  const k = KINDS[kind];
  if (kind === 'CUSTOMER') return `
    SELECT x.id, x.customer_name AS name, x.mobile_no AS mobile, x.email::text AS email, x.gst_no::text AS gst_no,
           x.contact_person, x.status::text AS record_status, x.is_approved_for_portal AS portal_approved,
           x.portal_approved_at, x.approval_status, x.customer_source,
           COALESCE(x.portal_features, '{}'::jsonb) AS features,
           u.id AS login_id, u.mobile AS login_mobile, u.status::text AS login_status, u.account_status,
           u.last_login_at, u.must_change_password,
           (SELECT count(*) FROM auth_sessions s WHERE s.user_id = u.id AND s.expires_at > now())::int AS live_sessions,
           (SELECT max(s.issued_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_seen,
           (SELECT count(*) FROM bazaar_loads l WHERE l.customer_id = x.id)::int AS activity,
           la.action AS last_action, la.reason AS last_reason, la.actor_name AS last_actor, la.created_at AS last_action_at
      FROM customers x
      LEFT JOIN users u ON u.customer_id = x.id
      ${LAST_ACTION}
     WHERE ${SEARCH('customer_name', 'mobile_no')}
     ORDER BY x.customer_name LIMIT $2`;
  if (k.table === 'vendors') return `
    SELECT x.id, x.vendor_name AS name, x.mobile_no AS mobile, x.email::text AS email, x.pan_no::text AS pan_no,
           x.owner_name, x.vendor_type, x.vendor_kind, x.subscription_plan, x.max_vehicle_limit,
           x.status::text AS record_status, x.is_approved_for_portal AS portal_approved, x.portal_approved_at,
           COALESCE(x.portal_features, '{}'::jsonb) AS features,
           u.id AS login_id, u.mobile AS login_mobile, u.status::text AS login_status, u.account_status,
           u.last_login_at, u.must_change_password,
           (SELECT count(*) FROM auth_sessions s WHERE s.user_id = u.id AND s.expires_at > now())::int AS live_sessions,
           (SELECT max(s.issued_at) FROM auth_sessions s WHERE s.user_id = u.id) AS last_seen,
           (SELECT count(*) FROM market_vehicles mv WHERE mv.vendor_id = x.id)::int AS trucks,
           (SELECT count(*) FROM expense_approvals e WHERE e.vendor_id = x.id)::int AS bills,
           la.action AS last_action, la.reason AS last_reason, la.actor_name AS last_actor, la.created_at AS last_action_at
      FROM vendors x
      LEFT JOIN users u ON u.vendor_id = x.id
      ${LAST_ACTION}
     WHERE x.${k.kindWhere} AND ${SEARCH('vendor_name', 'mobile_no')}
     ORDER BY x.vendor_name LIMIT $2`;
  if (kind === 'DRIVER') return `
    SELECT x.id, x.name, x.mobile, NULL::text AS email, x.license_no, x.license_expiry, x.approval_status::text AS approval_status,
           x.status::text AS record_status, x.is_approved_for_portal AS portal_approved, x.portal_approved_at,
           '{}'::jsonb AS features, x.user_id AS login_id, NULL::text AS login_status, NULL::text AS account_status,
           (SELECT count(*) FROM auth_sessions s WHERE s.driver_id = x.id AND s.expires_at > now())::int AS live_sessions,
           (SELECT max(s.issued_at) FROM auth_sessions s WHERE s.driver_id = x.id) AS last_seen,
           (SELECT count(*) FROM trips t WHERE t.driver_id = x.id)::int AS activity,
           la.action AS last_action, la.reason AS last_reason, la.actor_name AS last_actor, la.created_at AS last_action_at
      FROM drivers x
      ${LAST_ACTION}
     WHERE ($1 = '' OR x.name ILIKE '%' || $1 || '%' OR COALESCE(x.mobile, '') LIKE '%' || $1 || '%')
     ORDER BY x.name LIMIT $2`;
  if (kind === 'MARKET_VEHICLE') {
    // A truck has no name and no mobile; the plate is its name, and the partner
    // it belongs to is what the office searches by just as often.
    return `
      SELECT x.id, x.registration_no AS name, NULL::text AS mobile, NULL::text AS email,
             x.vehicle_class, x.capacity, x.rc_expiry, x.ins_expiry, x.fit_expiry,
             x.system_status, x.reject_reason, x.deactivated_reason,
             x.created_at, x.approved_at, x.vendor_id, v.vendor_name AS partner_name,
             '{}'::jsonb AS features, NULL::uuid AS login_id, 0::int AS live_sessions, NULL::timestamptz AS last_seen,
             (SELECT count(*) FROM bazaar_settlements s WHERE s.market_vehicle_id = x.id)::int AS activity,
             la.action AS last_action, la.reason AS last_reason, la.actor_name AS last_actor, la.created_at AS last_action_at
        FROM market_vehicles x
        LEFT JOIN vendors v ON v.id = x.vendor_id
        ${LAST_ACTION}
       WHERE ($1 = '' OR x.registration_no ILIKE '%' || $1 || '%' OR COALESCE(v.vendor_name, '') ILIKE '%' || $1 || '%')
       ORDER BY x.created_at DESC LIMIT $2`;
  }
  return `
    SELECT x.id, x.name, x.mobile, NULL::text AS email, x.licence_no, x.licence_expiry, x.system_status, x.reject_reason,
           x.created_at, x.approved_at, x.vendor_id, v.vendor_name AS partner_name,
           '{}'::jsonb AS features, NULL::uuid AS login_id, 0::int AS live_sessions, NULL::timestamptz AS last_seen,
           (SELECT count(*) FROM market_vehicles mv WHERE mv.market_driver_id = x.id)::int AS activity,
           la.action AS last_action, la.reason AS last_reason, la.actor_name AS last_actor, la.created_at AS last_action_at
      FROM market_drivers x
      LEFT JOIN vendors v ON v.id = x.vendor_id
      ${LAST_ACTION}
     WHERE ($1 = '' OR x.name ILIKE '%' || $1 || '%' OR COALESCE(x.mobile, '') LIKE '%' || $1 || '%' OR COALESCE(v.vendor_name, '') ILIKE '%' || $1 || '%')
     ORDER BY x.created_at DESC LIMIT $2`;
}

/** The one state the office reasons about. Derived, never stored. */
export function accessState(r, kind) {
  if (kind === 'MARKET_DRIVER' || kind === 'MARKET_VEHICLE') {
    return { 'System Active': 'ACTIVE', 'PENDING APPROVAL': 'PENDING', BLOCKED: 'BLOCKED', REJECTED: 'ARCHIVED' }[r.system_status] ?? 'PENDING';
  }
  if (r.record_status === 'ARCHIVED') return 'ARCHIVED';
  if (r.last_action === 'BLOCK' || ['BLACKLISTED', 'INACTIVE'].includes(r.record_status)
      || r.login_status === 'INACTIVE' || r.account_status === 'SUSPENDED') return 'BLOCKED';
  if (r.portal_approved) return 'ACTIVE';
  return 'PENDING';
}

async function listParties(kind, q, limit) {
  const { rows } = await query(listSql(kind), [String(q ?? '').trim(), limit]);
  return rows.map((r) => ({ ...r, kind, access: accessState(r, kind) }));
}

async function snapshot(t, kind, id) {
  const k = KINDS[kind];
  const cols = k.market
    ? `id, ${k.nameCol} AS name, ${k.mobileCol ?? 'NULL::text'} AS mobile, system_status, reject_reason`
    : `id, ${k.nameCol} AS name, ${k.mobileCol} AS mobile, status::text AS status, is_approved_for_portal`;
  const { rows } = await t.query(`SELECT ${cols} FROM ${k.table} WHERE id = $1::uuid`, [id]);
  return rows[0] ?? null;
}

async function audit(t, { kind, id, action, before, after, reason, actor }) {
  await t.query(
    `INSERT INTO access_hub_audit (kind, party_id, action, before, after, reason, actor_id, actor_name)
     VALUES ($1, $2::uuid, $3, $4::jsonb, $5::jsonb, $6, $7::uuid, $8)`,
    [kind, id, action, JSON.stringify(before ?? null), JSON.stringify(after ?? null), reason ?? null, actor.id, actor.name]);
}

/** Same recipe as KYC approval (bazaar.routes.js): OTP login on the party's
 *  mobile, random password, must_change_password. Returns a note for the UI. */
async function ensureLogin(t, kind, partyId) {
  const k = KINDS[kind];
  if (!k.link) return null;
  const { rows: existing } = await t.query(`SELECT id FROM users WHERE ${k.link} = $1::uuid`, [partyId]);
  if (existing.length) {
    await t.query(`UPDATE users SET status = 'ACTIVE', account_status = 'ACTIVE', updated_at = now() WHERE id = $1::uuid`, [existing[0].id]);
    return 'login re-enabled';
  }
  const { rows: party } = await t.query(
    `SELECT ${k.nameCol} AS name, email::text AS email, ${k.mobileCol} AS mobile FROM ${k.table} WHERE id = $1::uuid`, [partyId]);
  const mobile = last10(party[0]?.mobile);
  if (mobile.length < 10) return 'no 10-digit mobile on file — login NOT created (add the mobile, then Activate again)';
  const { rows: taken } = await t.query('SELECT id, role FROM users WHERE mobile = $1 LIMIT 1', [mobile]);
  if (taken.length) return `mobile ${mobile} already belongs to another login (${taken[0].role}) — login NOT created`;
  const email = String(party[0].email ?? '').trim().toLowerCase()
    || `portal-${String(partyId).slice(0, 8)}@login.prasadtransport.com`;
  const { saltHex, hashHex } = hashPassword(randomBytes(14).toString('base64url'));
  await t.query(
    `INSERT INTO users (full_name, email, mobile, password_hash, password_salt, password_algo,
                        role, permissions, status, must_change_password, ${k.link})
     VALUES ($1, $2::citext, $3, $4, $5, $6, $7::user_role, '{"grants":[]}'::jsonb, 'ACTIVE', true, $8::uuid)`,
    [party[0].name, email, mobile, hashHex, saltHex, ALGO, k.role, partyId]);
  return `login created — OTP login on ${mobile}`;
}

async function revokeSessions(t, kind, id) {
  const k = KINDS[kind];
  if (kind === 'DRIVER') {
    const { rowCount } = await t.query('DELETE FROM auth_sessions WHERE driver_id = $1::uuid', [id]);
    return rowCount;
  }
  if (!k.link) return 0;
  const { rowCount } = await t.query(
    `DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE ${k.link} = $1::uuid)`, [id]);
  return rowCount;
}

export function registerAccessRoutes(app) {
  app.addHook('preHandler', requireAdminRole);

  const parseKind = (req, reply) => {
    const kind = kindOf(req.params.kind ?? req.query?.kind);
    if (!kind) { reply.code(400).send({ error: 'BAD_KIND', detail: `kind must be one of ${Object.keys(KINDS).join(', ')}` }); return null; }
    return kind;
  };
  const parseId = (req, reply) => {
    const id = String(req.params.id ?? '');
    if (!UUID_RE.test(id)) { reply.code(400).send({ error: 'BAD_ID' }); return null; }
    return id;
  };

  // ── The table behind each tab ─────────────────────────────────────────────
  app.get('/parties', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kind = parseKind(req, reply); if (!kind) return;
    const limit = Math.min(Math.max(Number(req.query?.limit) || 500, 1), 2000);
    const rows = await listParties(kind, req.query?.q, limit);
    const state = String(req.query?.state ?? 'ALL').toUpperCase();
    return { kind, count: rows.length, parties: state === 'ALL' ? rows : rows.filter((r) => r.access === state) };
  });

  // ── Counts for the tab strip and the quarantine strip ────────────────────
  app.get('/summary', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kinds = {};
    for (const kind of Object.keys(KINDS)) {
      const rows = await listParties(kind, '', 5000);
      const by = { ACTIVE: 0, PENDING: 0, BLOCKED: 0, ARCHIVED: 0 };
      for (const r of rows) by[r.access] = (by[r.access] ?? 0) + 1;
      kinds[kind] = { total: rows.length, ...by, logins: rows.filter((r) => r.login_id).length,
                      live_sessions: rows.reduce((s, r) => s + (r.live_sessions ?? 0), 0) };
    }
    const { rows: [staging] } = await query(`
      SELECT (SELECT count(*) FROM onboarding_applications WHERE status = 'PENDING_KYC')::int          AS kyc,
             (SELECT count(*) FROM partner_documents WHERE status = 'PENDING')::int                  AS app_uploads,
             (SELECT count(*) FROM expense_approvals WHERE status = 'PENDING')::int                  AS expense_bills,
             (SELECT count(*) FROM driver_requests WHERE status = 'PENDING')::int                    AS driver_requests,
             (SELECT count(*) FROM market_vehicles WHERE system_status = 'PENDING APPROVAL')::int    AS market_trucks,
             (SELECT count(*) FROM market_drivers WHERE system_status = 'PENDING APPROVAL')::int     AS market_drivers,
             (SELECT count(*) FROM bazaar_loads WHERE status = 'PENDING_REVIEW')::int                AS loads_review,
             (SELECT count(*) FROM bazaar_loads WHERE status = 'AWARD_REQUESTED')::int               AS award_requests,
             (SELECT count(*) FROM bazaar_settlements WHERE status = 'POD_SUBMITTED')::int           AS pods`);
    return { kinds, staging, guard: { mode: String(process.env.STAGING_GUARD_MODE ?? 'enforce') } };
  });

  // ── Feature keys a party can be narrowed on (role matrix, short keys) ────
  app.get('/modules', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const role = String(req.query?.role ?? '').toUpperCase();
    if (!['CUSTOMER', 'VENDOR', 'DRIVER'].includes(role)) return reply.code(400).send({ error: 'BAD_ROLE' });
    const { rows } = await query(
      `SELECT module_key, label, description, parent_key, sensitive, sort_order, is_visible
         FROM v_portal_role_matrix WHERE role = $1 ORDER BY sort_order`, [role]);
    return { role, modules: rows.map((m) => ({ ...m, short: m.module_key.split('.').slice(1).join('.') })) };
  });

  // ── One party's audit trail ──────────────────────────────────────────────
  app.get('/:kind/:id/audit', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kind = parseKind(req, reply); if (!kind) return;
    const id = parseId(req, reply); if (!id) return;
    const { rows: hub } = await query(
      `SELECT id, action, before, after, reason, actor_name, created_at FROM access_hub_audit
        WHERE party_id = $1::uuid ORDER BY created_at DESC LIMIT 100`, [id]);
    const { rows: gate } = await query(
      `SELECT id, was_visible, now_visible, actor_name, created_at FROM portal_access_audit
        WHERE module_key = $1 ORDER BY created_at DESC LIMIT 50`, [`party:${id}`]);
    return { kind, id, hub, gate };
  });

  // ── ACTIVATE ──────────────────────────────────────────────────────────────
  app.post('/:kind/:id/activate', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kind = parseKind(req, reply); if (!kind) return;
    const id = parseId(req, reply); if (!id) return;
    const k = KINDS[kind]; const actor = actorOf(req); const notes = [];
    let out;
    try {
      out = await withTransaction(async (t) => {
        const before = await snapshot(t, kind, id);
        if (!before) return null;
        if (k.market) {
          // Same statement for a market driver and a market truck; only the
          // table differs, and a truck also clears its deactivation note.
          await t.query(
            `UPDATE ${k.table} SET system_status = 'System Active', approved_by = $2::uuid, approved_at = now(),
                    reject_reason = NULL, updated_at = now()
                    ${kind === 'MARKET_VEHICLE' ? ', blocked_at = NULL, blocked_by = NULL, deactivated_reason = NULL' : ''}
              WHERE id = $1::uuid`, [id, actor.id]);
        } else {
          await t.query(
            `UPDATE ${k.table}
                SET status = CASE WHEN status IN ('ARCHIVED', 'INACTIVE') THEN 'ACTIVE'::record_status ELSE status END,
                    is_approved_for_portal = true, portal_approved_by = $2::uuid, portal_approved_at = now()
              WHERE id = $1::uuid`, [id, actor.id]);
          if (before.status === 'BLACKLISTED') notes.push('master row is BLACKLISTED — portal stays shut until it is cleared in the master');
          const note = await ensureLogin(t, kind, id);
          if (note) notes.push(note);
          if (note && note.startsWith('login created')) {
            await audit(t, { kind, id, action: 'LOGIN_CREATED', before: null, after: { note }, actor });
          }
        }
        const after = await snapshot(t, kind, id);
        await audit(t, { kind, id, action: 'ACTIVATE', before, after, reason: req.body?.reason ?? null, actor });
        return { before, after };
      });
    } catch (e) {
      if (e.code === '23505') return reply.code(409).send({ error: 'NAME_TAKEN', detail: 'an ACTIVE party with this name already exists — rename one of them first' });
      throw e;
    }
    if (!out) return reply.code(404).send({ error: 'NOT_FOUND' });
    const mobile = last10(out.after?.mobile);
    if (mobile.length === 10 && !k.market) {
      Promise.resolve(notifyWhatsApp(mobile,
        `✅ Prasad Transport: aapka portal access ON ho gaya hai. Apne registered mobile ${mobile} se OTP login karein.`))
        .catch(() => {});
    }
    return { ok: true, access: 'ACTIVE', notes, ...out };
  });

  // ── BLOCK ─────────────────────────────────────────────────────────────────
  const blockInTx = async (t, kind, id, actor, reason, archive) => {
    const k = KINDS[kind];
    const before = await snapshot(t, kind, id);
    if (!before) return null;
    if (k.market) {
      await t.query(
        `UPDATE ${k.table} SET system_status = $2, reject_reason = $3, updated_at = now()
                ${kind === 'MARKET_VEHICLE' ? ', blocked_at = now(), blocked_by = $4::uuid, deactivated_reason = $3' : ''}
          WHERE id = $1::uuid`,
        kind === 'MARKET_VEHICLE'
          ? [id, archive ? 'REJECTED' : 'BLOCKED', reason, actor.id]
          : [id, archive ? 'REJECTED' : 'BLOCKED', reason]);
    } else {
      await t.query(
        `UPDATE ${k.table}
            SET is_approved_for_portal = false, portal_approved_by = NULL, portal_approved_at = NULL
                ${archive ? ", status = 'ARCHIVED'::record_status" : ''}
          WHERE id = $1::uuid`, [id]);
      if (k.link) {
        await t.query(
          `UPDATE users SET status = 'INACTIVE', account_status = 'SUSPENDED', updated_at = now() WHERE ${k.link} = $1::uuid`, [id]);
      }
    }
    const revoked = await revokeSessions(t, kind, id);
    const after = await snapshot(t, kind, id);
    await audit(t, { kind, id, action: archive ? 'ARCHIVE' : 'BLOCK', before, after: { ...after, sessions_revoked: revoked }, reason, actor });
    return { before, after, sessions_revoked: revoked };
  };

  app.post('/:kind/:id/block', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kind = parseKind(req, reply); if (!kind) return;
    const id = parseId(req, reply); if (!id) return;
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED', detail: 'say why — the party sees this reason' });
    const out = await withTransaction((t) => blockInTx(t, kind, id, actorOf(req), reason, false));
    if (!out) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true, access: 'BLOCKED', ...out };
  });

  // ── ARCHIVE (block + status ARCHIVED; never a DELETE) ────────────────────
  app.post('/:kind/:id/archive', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kind = parseKind(req, reply); if (!kind) return;
    const id = parseId(req, reply); if (!id) return;
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) return reply.code(400).send({ error: 'REASON_REQUIRED' });
    const out = await withTransaction((t) => blockInTx(t, kind, id, actorOf(req), reason, true));
    if (!out) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true, access: 'ARCHIVED', ...out };
  });

  // ── EDIT (inline) ─────────────────────────────────────────────────────────
  app.patch('/:kind/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kind = parseKind(req, reply); if (!kind) return;
    const id = parseId(req, reply); if (!id) return;
    const k = KINDS[kind]; const allowed = EDITABLE[kind];
    const body = req.body ?? {};
    const sets = []; const vals = [id]; const changes = {};
    for (const [field, col] of Object.entries(allowed)) {
      if (!Object.hasOwn(body, field)) continue;
      let v = body[field];
      if (field === 'mobile') {
        v = last10(v);
        if (v.length !== 10) return reply.code(400).send({ error: 'BAD_MOBILE', detail: '10 digits' });
      } else if (field === 'max_vehicle_limit') {
        v = Number(v); if (!Number.isInteger(v) || v < 0) return reply.code(400).send({ error: 'BAD_LIMIT' });
      } else if (field === 'subscription_plan') {
        v = String(v).toUpperCase();
        if (!['FREE', 'SILVER', 'GOLD', 'PLATINUM'].includes(v)) return reply.code(400).send({ error: 'BAD_PLAN' });
      } else if (v === '' || v === undefined) {
        v = null;
      } else {
        v = String(v).trim();
      }
      vals.push(v); sets.push(`${col} = $${vals.length}`); changes[field] = v;
    }
    const unknown = Object.keys(body).filter((f) => !Object.hasOwn(allowed, f));
    if (unknown.length) return reply.code(400).send({ error: 'UNKNOWN_FIELD', detail: unknown.join(', ') });
    if (!sets.length) return reply.code(400).send({ error: 'NOTHING_TO_CHANGE' });

    try {
      const out = await withTransaction(async (t) => {
        const before = await snapshot(t, kind, id);
        if (!before) return null;
        if (k.link && changes.mobile) {
          const { rows: taken } = await t.query(
            `SELECT id FROM users WHERE mobile = $1 AND ${k.link} IS DISTINCT FROM $2::uuid LIMIT 1`, [changes.mobile, id]);
          if (taken.length) throw Object.assign(new Error('MOBILE_TAKEN'), { code: 'MOBILE_TAKEN' });
        }
        await t.query(`UPDATE ${k.table} SET ${sets.join(', ')} WHERE id = $1::uuid`, vals);
        if (k.link && (changes.name || changes.mobile)) {
          await t.query(
            `UPDATE users SET full_name = COALESCE($2, full_name), mobile = COALESCE($3, mobile), updated_at = now()
              WHERE ${k.link} = $1::uuid`, [id, changes.name ?? null, changes.mobile ?? null]);
        }
        const after = await snapshot(t, kind, id);
        await audit(t, { kind, id, action: 'EDIT', before, after: { ...after, changes }, actor: actorOf(req) });
        return { before, after, changes };
      });
      if (!out) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { ok: true, ...out };
    } catch (e) {
      if (e.code === 'MOBILE_TAKEN') return reply.code(409).send({ error: 'MOBILE_TAKEN', detail: 'that mobile already logs in as another party' });
      if (e.code === '23505') return reply.code(409).send({ error: 'NAME_TAKEN', detail: 'an ACTIVE party with this name already exists' });
      throw e;
    }
  });

  // ── FEATURES (per-party narrowing; false hides, true restores the role default) ──
  app.post('/:kind/:id/features', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kind = parseKind(req, reply); if (!kind) return;
    const id = parseId(req, reply); if (!id) return;
    const k = KINDS[kind];
    if (!k.features) return reply.code(409).send({ error: 'NO_FEATURES', detail: `${kind} has no per-party feature map (gate only)` });
    const features = req.body?.features;
    if (!features || typeof features !== 'object' || Array.isArray(features)) return reply.code(400).send({ error: 'BAD_FEATURES' });
    const { rows: mods } = await query('SELECT module_key FROM portal_modules WHERE role = $1', [k.role]);
    const known = new Set(mods.map((m) => m.module_key.split('.').slice(1).join('.')));
    for (const [key, val] of Object.entries(features)) {
      if (!known.has(key)) return reply.code(400).send({ error: 'UNKNOWN_FEATURE', detail: key });
      if (typeof val !== 'boolean') return reply.code(400).send({ error: 'BAD_FEATURES', detail: `${key} must be true or false` });
    }
    const out = await withTransaction(async (t) => {
      const { rows: b } = await t.query(`SELECT COALESCE(portal_features, '{}'::jsonb) AS f FROM ${k.table} WHERE id = $1::uuid`, [id]);
      if (!b.length) return null;
      const { rows: a } = await t.query(
        `UPDATE ${k.table} SET portal_features = COALESCE(portal_features, '{}'::jsonb) || $2::jsonb
          WHERE id = $1::uuid RETURNING portal_features AS f`, [id, JSON.stringify(features)]);
      await audit(t, { kind, id, action: 'FEATURES', before: b[0].f, after: a[0].f, actor: actorOf(req) });
      return a[0].f;
    });
    if (out === null) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true, features: out };
  });

  // ── Kill every live session of one party ──────────────────────────────────
  app.post('/:kind/:id/sessions/revoke', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const kind = parseKind(req, reply); if (!kind) return;
    const id = parseId(req, reply); if (!id) return;
    const out = await withTransaction(async (t) => {
      const before = await snapshot(t, kind, id);
      if (!before) return null;
      const revoked = await revokeSessions(t, kind, id);
      await audit(t, { kind, id, action: 'REVOKE_SESSIONS', before: null, after: { sessions_revoked: revoked }, actor: actorOf(req) });
      return revoked;
    });
    if (out === null) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { ok: true, sessions_revoked: out };
  });
}
