// server/db/pool.js
// ─────────────────────────────────────────────────────────────────────────────
// PostgreSQL connection layer — the single database entry point for the ERP.
//
// Resolution chain (first target that answers wins, so a dead local postgres
// never halts the system):
//
//   DB_TARGET=local  →  local 127.0.0.1  →  AWS RDS  →  degraded
//   DB_TARGET=aws    →  AWS RDS          →  local    →  degraded
//
// "Degraded" is explicit, not silent: `isDegraded()` is true, every write path
// throws a typed DbUnavailableError, and the agent swarm parks instead of
// pretending a trip was saved. A logistics ERP that loses a ₹-affecting write
// quietly is worse than one that refuses it loudly.
//
// Deliberately raw `pg` (no ORM): the ledger/settlement core needs exact SQL —
// CTEs, window functions, SELECT ... FOR UPDATE row locks, and transactional
// double-entry posting. An ORM abstracts away precisely the parts we must own.
// ─────────────────────────────────────────────────────────────────────────────
import { existsSync, readFileSync } from 'node:fs';
import pg from 'pg';

const { Pool, types } = pg;

// ── Type coercion ───────────────────────────────────────────────────────────
// NUMERIC (OID 1700) stays a string so 15-digit money never loses precision
// through a JS float. Arithmetic happens in SQL or a decimal library.
types.setTypeParser(1700, (v) => v);
// DATE (OID 1082) → 'YYYY-MM-DD', not a timezone-shifted Date. A trip dated
// 2026-08-12 must not become 2026-08-11 when the box is in IST.
types.setTypeParser(1082, (v) => v);

const env = (k, fallback) => process.env[k] ?? fallback;
const bool = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const DB_TARGET = env('DB_TARGET', 'local');

/** Thrown when no database target is reachable. Callers can catch this
 *  specifically to distinguish "infrastructure down" from "bad query". */
export class DbUnavailableError extends Error {
  constructor(message = 'No PostgreSQL target reachable') {
    super(message);
    this.name = 'DbUnavailableError';
    this.code = 'DB_UNAVAILABLE';
  }
}

// ── TLS ─────────────────────────────────────────────────────────────────────
function buildSsl(kind) {
  // RDS mandates TLS; local postgres must not use it.
  if (!bool(env('PGSSL'), kind === 'aws')) return false;

  const caPath = env('PGSSL_CA_PATH');
  if (caPath && existsSync(caPath)) {
    // Verified TLS — the correct production posture. Fetch the bundle once:
    //   curl -o certs/rds-global-bundle.pem \
    //     https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
    return { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true };
  }
  if (caPath) console.warn(`[db] PGSSL_CA_PATH set but not found: ${caPath}`);
  // Encrypted but unverified — acceptable only for a first RDS smoke test.
  // Loud, because shipping this to production invites a MITM.
  console.warn(
    '[db] TLS certificate NOT verified — set PGSSL_CA_PATH to the RDS CA bundle before going live.'
  );
  return { rejectUnauthorized: false };
}

// POOL SIZING, AND WHY 10 WAS WRONG.
//
// Ten agent loops, the scheduler, the event-bus drainer and every HTTP request
// share this one pool. At max: 10 they contend for the same ten connections, so
// a caller that needs one WAITS — up to connectionTimeoutMillis, which is why
// the log filled with "slow query 10009ms" against a ONE-ROW table and with
// "Connection terminated due to connection timeout". Neither was a slow query:
// both were a queue. A mobile scan sat behind that queue and answered in 34
// seconds on a pipeline that does its own work in under five.
//
// 25 is chosen against this box's max_connections of 100, leaving room for
// psql, the migration runner and a second app process. Raising it further would
// not help: once the queue empties, more connections only add contention inside
// Postgres instead of inside the pool.
const poolTuning = () => ({
  max: int(env('PG_POOL_MAX'), 25),
  idleTimeoutMillis: int(env('PG_IDLE_TIMEOUT_MS'), 30_000),
  connectionTimeoutMillis: int(env('PG_CONNECT_TIMEOUT_MS'), 10_000),
  statement_timeout: int(env('PG_STATEMENT_TIMEOUT_MS'), 30_000),
  application_name: env('PG_APP_NAME', 'prasad-erp-api'),
  allowExitOnIdle: false,
});

/**
 * Candidate targets in preference order. A candidate is only offered if it is
 * actually configured — we never dial an RDS host that was never set up.
 */
function buildCandidates() {
  const candidates = [];

  if (env('DATABASE_URL')) {
    candidates.push({
      name: 'DATABASE_URL',
      kind: DB_TARGET,
      config: { connectionString: env('DATABASE_URL'), ssl: buildSsl(DB_TARGET), ...poolTuning() },
    });
  }

  const local = {
    name: 'local',
    kind: 'local',
    config: {
      host: env('PGHOST', '127.0.0.1'),
      port: int(env('PGPORT'), 5432),
      database: env('PGDATABASE', 'prasad_erp'),
      user: env('PGUSER', 'prasad_app'),
      password: env('PGPASSWORD', ''),
      ssl: false,
      ...poolTuning(),
    },
  };

  // RDS_* vars describe the AWS fallback independently of the primary PG* vars,
  // so one box can hold both without either overwriting the other.
  const rdsHost = env('RDS_PGHOST');
  const aws = rdsHost
    ? {
        name: 'aws-rds',
        kind: 'aws',
        config: {
          host: rdsHost,
          port: int(env('RDS_PGPORT'), 5432),
          database: env('RDS_PGDATABASE', env('PGDATABASE', 'prasad_erp')),
          user: env('RDS_PGUSER', env('PGUSER', 'prasad_app')),
          password: env('RDS_PGPASSWORD', env('PGPASSWORD', '')),
          ssl: buildSsl('aws'),
          ...poolTuning(),
        },
      }
    : null;

  // DB_TARGET decides which way round the fallback runs.
  if (DB_TARGET === 'aws') {
    if (aws) candidates.push(aws);
    candidates.push(local);
  } else {
    candidates.push(local);
    if (aws) candidates.push(aws);
  }
  return candidates;
}

// ── Active connection state ─────────────────────────────────────────────────
let active = null; // { name, kind, pool }
let initPromise = null;

function attachErrorHandler(pool, name) {
  // An idle client dying (RDS failover, network blip) emits 'error' on the
  // pool. Without this listener Node treats it as unhandled and kills the
  // process. The pool discards the dead client and carries on.
  pool.on('error', (err) => {
    console.error(`[db:${name}] idle client error — client discarded: ${err.message}`);
  });
}

async function probe(candidate) {
  const pool = new Pool(candidate.config);
  attachErrorHandler(pool, candidate.name);
  try {
    const { rows } = await pool.query('SELECT current_database() AS db, version() AS version');
    return { ...candidate, pool, info: rows[0] };
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
}

/**
 * Resolve a live database, trying every configured candidate. Safe to call
 * repeatedly and concurrently — the in-flight promise is shared.
 */
export async function initDb({ attempts = 2, delayMs = 1500, quiet = false } = {}) {
  if (active) return describeActive();
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const candidates = buildCandidates();
    const failures = [];

    for (const candidate of candidates) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const resolved = await probe(candidate);
          active = resolved;
          const server = resolved.info.version.split(' ').slice(0, 2).join(' ');
          console.log(
            `[db] connected → ${resolved.name} · ${resolved.info.db} (${server})` +
              (resolved.name !== candidates[0].name ? '  ⚠ FALLBACK target in use' : '')
          );
          return describeActive();
        } catch (err) {
          const where = `${candidate.name}:${candidate.config.host ?? 'url'}`;
          if (!quiet) console.error(`[db] ${where} attempt ${attempt}/${attempts}: ${err.message}`);
          if (attempt === attempts) failures.push(`${candidate.name} (${err.message})`);
          else await new Promise((r) => setTimeout(r, delayMs * attempt));
        }
      }
    }

    // Every target refused. Stay up in degraded mode rather than crash-looping,
    // but make the state impossible to mistake for healthy.
    console.error('┌──────────────────────────────────────────────────────────────');
    console.error('│ [db] DEGRADED MODE — no PostgreSQL target reachable');
    for (const f of failures) console.error(`│   ✖ ${f}`);
    console.error('│ Reads and writes will throw DbUnavailableError.');
    console.error('│ Fix: powershell -ExecutionPolicy Bypass -File scripts/pg-bootstrap.ps1');
    console.error('│   or set RDS_PGHOST + RDS_PGPASSWORD to fail over to AWS RDS.');
    console.error('└──────────────────────────────────────────────────────────────');
    return { ok: false, degraded: true, tried: failures };
  })();

  try {
    return await initPromise;
  } finally {
    // Clear on failure so a later call can retry; keep it resolved on success.
    if (!active) initPromise = null;
  }
}

function describeActive() {
  return {
    ok: true,
    degraded: false,
    target: active.name,
    kind: active.kind,
    database: active.info.db,
    server: active.info.version.split(' ').slice(0, 2).join(' '),
    pool: { total: active.pool.totalCount, idle: active.pool.idleCount, waiting: active.pool.waitingCount },
  };
}

export const isDegraded = () => active === null;

/** The live pool, or throw. Never returns a half-dead handle. */
export function getPool() {
  if (!active) throw new DbUnavailableError();
  return active.pool;
}

/** Run a query, initialising the connection on first use. */
export async function query(text, params) {
  if (!active) {
    await initDb({ quiet: true });
    if (!active) throw new DbUnavailableError();
  }
  // SEPARATE THE WAIT FROM THE WORK.
  //
  // This used to time pool.query() as a whole and call the total "slow query".
  // It is not the same thing: pool.query() acquires a connection first, and when
  // the pool is saturated that acquire is where the seconds go. The old message
  // blamed the SQL — reporting a one-row lookup on agent_halts as a 10-second
  // query — and sent anyone reading the log hunting for a missing index that
  // was never missing. Acquire and execute are now measured and named apart, so
  // the log says which of the two actually needs fixing.
  const t0 = process.hrtime.bigint();
  let client;
  let acquiredAt = t0;
  try {
    client = await active.pool.connect();
    acquiredAt = process.hrtime.bigint();
    return await client.query(text, params);
  } finally {
    client?.release();
    const end = process.hrtime.bigint();
    const waitMs = Number(acquiredAt - t0) / 1e6;
    const execMs = Number(end - acquiredAt) / 1e6;
    const threshold = int(env('PG_SLOW_QUERY_MS'), 500);
    const waitThreshold = int(env('PG_SLOW_ACQUIRE_MS'), 250);
    const sql = text.replace(/\s+/g, ' ').slice(0, 140);

    if (waitMs > waitThreshold) {
      // Not a query problem. Says so, and reports the saturation that caused it.
      const s = poolStats();
      console.warn(
        `[db] pool wait ${waitMs.toFixed(0)}ms (pool ${s.total}/${s.max}, ${s.waiting} queued) before: ${sql}`
      );
    }
    if (execMs > threshold) {
      console.warn(`[db] slow query ${execMs.toFixed(0)}ms exec: ${sql}`);
    }
  }
}

/** Live pool saturation — the number that predicts the queue before it forms. */
export function poolStats() {
  if (!active?.pool) return { available: false };
  const p = active.pool;
  return {
    available: true,
    max: p.options?.max ?? null,
    total: p.totalCount,      // connections currently open
    idle: p.idleCount,        // of those, free right now
    waiting: p.waitingCount,  // callers queued for one — above 0 IS the problem
  };
}

/** Fetch exactly one row, or null. */
export async function queryOne(text, params) {
  const { rows } = await query(text, params);
  return rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction on one dedicated client.
 *
 * Every multi-row money operation — trip settlement, ledger posting, invoice
 * generation — goes through here. Firestore had no real multi-collection
 * atomicity; PostgreSQL does, and this is where we cash that in.
 */
export async function withTransaction(fn) {
  if (!active) {
    await initDb({ quiet: true });
    if (!active) throw new DbUnavailableError();
  }
  const client = await active.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // Rollback can itself fail on a broken connection; never let that mask the
    // original error, which is the one that explains what went wrong.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] ROLLBACK failed:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * A dedicated, non-pooled connection for LISTEN/NOTIFY.
 *
 * LISTEN registers against a *session*, so it cannot use a pooled client: the
 * moment that client is released the subscription is silently lost. The agent
 * bus owns one of these for its lifetime and reconnects it on failure.
 */
export async function createDedicatedClient() {
  if (!active) {
    await initDb({ quiet: true });
    if (!active) throw new DbUnavailableError();
  }
  // Reuse the resolved target's config so the listener can never end up on a
  // different database than the one the pool is talking to.
  const client = new pg.Client(active.config);
  await client.connect();
  return client;
}

/** Liveness probe for /readyz. */
export async function healthCheck() {
  if (!active) {
    await initDb({ quiet: true });
    if (!active) throw new DbUnavailableError();
  }
  const startedAt = process.hrtime.bigint();
  const row = await queryOne('SELECT current_database() AS db, version() AS version');
  return {
    ...describeActive(),
    database: row.db,
    latencyMs: Number(Number(process.hrtime.bigint() - startedAt) / 1e6).toFixed(1),
  };
}

/** Back-compat alias — initDb() already retries across every candidate. */
export const connectWithRetry = (opts) => initDb(opts);

/** Drain the pool on shutdown so in-flight transactions finish cleanly. */
export async function closePool() {
  if (!active) return;
  const { pool, name } = active;
  active = null;
  initPromise = null;
  await pool.end();
  console.log(`[db:${name}] pool closed`);
}

export default {
  initDb, getPool, query, queryOne, withTransaction, healthCheck,
  connectWithRetry, closePool, isDegraded, DB_TARGET, DbUnavailableError,
};
