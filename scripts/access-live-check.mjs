// scripts/access-live-check.mjs — end-to-end proof on a box, against the RUNNING
// API: the Access Control Hub answers for an admin, an external (driver) session
// can write its staging table and read its own data but cannot reach the hub,
// and nothing it touched is left behind.
//   cd /var/www/prasad-erp && DOTENV_CONFIG_PATH=.env.api node scripts/access-live-check.mjs
// Writes exactly two rows and deletes both: one 10-minute admin session for the
// check itself, and one driver request the dev-bypass driver files.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { query, closePool } from '../server/db/pool.js';
import { issueToken } from '../server/lib/auth.js';

const BASE = process.env.CHECK_BASE ?? `http://127.0.0.1:${process.env.API_PORT ?? 3300}`;
const out = {};
const call = async (path, { token, method = 'GET', body } = {}) => {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
};

// ── 1. The hub, as an admin (temporary session, removed at the end) ──────────
const { rows: [adm] } = await query(
  `SELECT id, full_name, role::text AS role FROM users
    WHERE role IN ('SUPER_ADMIN', 'ADMIN') AND status = 'ACTIVE' ORDER BY role DESC, created_at LIMIT 1`);
const jti = randomUUID();
const { token } = issueToken({ sub: adm.id, jti, role: adm.role, name: adm.full_name });
await query(
  `INSERT INTO auth_sessions (jti, user_id, expires_at, user_agent, ip)
   VALUES ($1::uuid, $2::uuid, now() + interval '10 minutes', 'access-live-check', '127.0.0.1')`, [jti, adm.id]);
try {
  const s = await call('/api/v1/access/summary', { token });
  out.summary = {
    status: s.status, guard: s.j.guard, staging: s.j.staging,
    kinds: Object.fromEntries(Object.entries(s.j.kinds ?? {}).map(([k, v]) =>
      [k, `${v.total} total · ${v.ACTIVE} active · ${v.PENDING} pending · ${v.BLOCKED} blocked · ${v.ARCHIVED} archived · logins ${v.logins}`])),
  };
  for (const kind of ['CUSTOMER', 'FLEET_PARTNER', 'SERVICE_VENDOR', 'DRIVER', 'MARKET_DRIVER']) {
    const p = await call(`/api/v1/access/parties?kind=${kind}&limit=3`, { token });
    out[`parties_${kind}`] = {
      status: p.status, count: p.j.count, error: p.j.error,
      sample: (p.j.parties ?? []).slice(0, 2).map((r) => ({ name: r.name, access: r.access, login: !!r.login_id, sessions: r.live_sessions })),
    };
  }
  const m = await call('/api/v1/access/modules?role=VENDOR', { token });
  out.modules_vendor = { status: m.status, n: m.j.modules?.length };
  out.bad_kind_status = (await call('/api/v1/access/parties?kind=NOPE', { token })).status;
} finally {
  await query('DELETE FROM auth_sessions WHERE jti = $1::uuid', [jti]);
}

// ── 2. An external session: staging write OK, own reads OK, the hub closed ───
const mobile = String(process.env.OTP_DEV_BYPASS_MOBILES ?? '').split(/[,\s]+/).filter(Boolean)[0];
if (!mobile) {
  out.driver = 'OTP_DEV_BYPASS_MOBILES not set — external leg skipped';
} else {
  const rq = await call('/api/v1/auth/otp/request', { method: 'POST', body: { mobile } });
  const vr = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { mobile, code: process.env.OTP_DEV_CODE ?? '123456' } });
  out.driver_login = { request: rq.status, channel: rq.j.channel, verify: vr.status, role: vr.j.role };
  const dt = vr.j.token;
  if (dt) {
    out.driver_read_trips = (await call('/api/v1/portal/driver/trips', { token: dt })).status;
    const w = await call('/api/v1/portal/driver/requests', { method: 'POST', token: dt,
      body: { request_type: 'OTHER', amount: 0, remarks: 'staging fence live check — auto-removed' } });
    out.driver_staging_write = { status: w.status, state: w.j.status, error: w.j.error };
    if (w.j.id) {
      await query('DELETE FROM driver_requests WHERE id = $1::uuid', [w.j.id]);
      out.driver_staging_write.cleaned = true;
    }
    out.driver_hits_hub_status = (await call('/api/v1/access/summary', { token: dt })).status;
    await call('/api/v1/auth/logout', { method: 'POST', token: dt });
  }
}

console.log(JSON.stringify(out, null, 2));
await closePool();
const ok = out.summary?.status === 200 && out.bad_kind_status === 400
  && (!out.driver_staging_write || out.driver_staging_write.status === 201)
  && (out.driver_hits_hub_status === undefined || out.driver_hits_hub_status === 403);
process.exit(ok ? 0 : 1);
