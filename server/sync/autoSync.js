// server/sync/autoSync.js
// ─────────────────────────────────────────────────────────────────────────────
// AWS ↔ Local continuous auto-sync engine, run from BAGALAMUKHI's 30s loop.
//
// Direction: LOCAL (this PC, primary writer) → AWS RDS (replica for the cloud
// API). One-way by design for this phase — a single writer with a read replica
// cannot produce a split brain, and split brain is how a ledger dies.
//
// Mechanism: watermark replication.
//   • Every synced table has updated_at maintained by trigger (001–006).
//   • sync_state keeps one durable cursor per table ('push:trips' → watermark).
//   • A tick reads rows WHERE updated_at > watermark, upserts them on the
//     remote keyed on id, and advances the watermark to the newest row synced —
//     inside a remote transaction, so a half-pushed batch never advances it.
//
// The zero-error offline contract:
//   internet down  → tick fails the remote connect, cursor does NOT move,
//                    nothing is lost; the next successful tick resumes exactly
//                    where the watermark stopped. Errors are counted and shown
//                    on the dashboard, never thrown into the loop.
//   RDS not configured (no RDS_PGHOST) → engine reports STANDBY and does
//                    nothing. Configuration, not failure.
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync, existsSync } from 'node:fs';
import pg from 'pg';
import { query, isDegraded, initDb } from '../db/pool.js';

const { Pool } = pg;

// Tables in FK-dependency order — parents push before children so the remote
// never sees an orphan trip pointing at a vehicle it doesn't have yet.
const SYNC_TABLES = [
  'companies', 'users', 'customers', 'vendors', 'vehicles', 'drivers',
  'vehicle_assignments', 'rtkm_master', 'rate_master', 'trips', 'fuel_entries',
  'ledgers', 'ledger_entries', 'loan_master', 'documents', 'okf_ltm',
  'tally_sync', 'trip_gps_pings',
];
// Append-only tables have no updated_at; their watermark rides created_at.
const APPEND_ONLY = new Set(['ledger_entries', 'okf_ltm', 'trip_gps_pings']);
// Tables whose primary key is not 'id' (tally_sync keys on the source string).
const KEY_COLUMN = { tally_sync: 'source' };
const BATCH = Number.parseInt(process.env.SYNC_BATCH ?? '500', 10);

let remotePool = null;
// GENERATED ALWAYS columns (vehicle_no_norm, license_no_norm, ...) cannot be
// inserted — the remote recomputes them from the same expression. Cached once.
const generatedCols = new Map();
async function skipCols(table) {
  if (!generatedCols.has(table)) {
    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'ALWAYS'`,
      [table]
    );
    generatedCols.set(table, new Set(rows.map((r) => r.column_name)));
  }
  return generatedCols.get(table);
}
let stats = { state: 'STANDBY', ticks: 0, pushed: 0, errors: 0, last_error: null, last_ok_at: null };

function remoteConfigured() {
  return Boolean(process.env.RDS_PGHOST);
}

function getRemotePool() {
  if (remotePool) return remotePool;
  const caPath = process.env.PGSSL_CA_PATH;
  remotePool = new Pool({
    host: process.env.RDS_PGHOST,
    port: Number.parseInt(process.env.RDS_PGPORT ?? '5432', 10),
    database: process.env.RDS_PGDATABASE ?? 'prasad_erp',
    user: process.env.RDS_PGUSER ?? 'prasad_app',
    password: process.env.RDS_PGPASSWORD ?? '',
    ssl: caPath && existsSync(caPath)
      ? { ca: readFileSync(caPath, 'utf8'), rejectUnauthorized: true }
      : { rejectUnauthorized: false },
    max: 3,                       // replica writer needs almost nothing
    connectionTimeoutMillis: 8000,
  });
  remotePool.on('error', (err) => console.error('[sync] remote idle error:', err.message));
  return remotePool;
}

async function pushTable(remote, table) {
  const tsCol = APPEND_ONLY.has(table) ? 'created_at' : 'updated_at';
  const cursorId = `push:${table}`;

  // The cursor is (timestamp, id) — and the timestamp travels as TEXT.
  // A JS Date only holds milliseconds; PostgreSQL keeps microseconds. Letting
  // the watermark round-trip through a Date truncated it, which made rows in
  // the lost microsecond window match forever (an infinite re-push). Text
  // preserves full precision; the id tiebreaker pages through rows that share
  // one bulk-load transaction timestamp.
  const { rows: [cur] } = await query(
    `INSERT INTO sync_state (id) VALUES ($1)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING watermark::text AS wm, watermark_id AS wm_id`,
    [cursorId]
  );

  const keyCol = KEY_COLUMN[table] ?? 'id';
  const { rows } = await query(
    `SELECT t.*, ${tsCol}::text AS __sync_wm FROM ${table} t
      WHERE ${tsCol} > $1::timestamptz
         OR (${tsCol} = $1::timestamptz AND ${keyCol}::text > $2)
      ORDER BY ${tsCol}, ${keyCol}::text
      LIMIT ${BATCH}`,
    [cur.wm, cur.wm_id]
  );
  if (!rows.length) return 0;

  const skip = await skipCols(table);
  const cols = Object.keys(rows[0]).filter((c) => !skip.has(c) && c !== '__sync_wm');
  const insertOnly = APPEND_ONLY.has(table);

  const client = await remote.connect();
  try {
    await client.query('BEGIN');
    // No replica-role GUC needed (it demands superuser): append-only tables are
    // pushed INSERT-only (DO NOTHING on conflict), so the remote immutability
    // trigger — which guards UPDATE/DELETE — is never provoked.
    for (const row of rows) {
      const vals = cols.map((c) => {
        const v = row[c];
        return v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
      });
      const ph = cols.map((_, i) => `$${i + 1}`);
      if (!insertOnly) {
        const updates = cols.filter((c) => c !== keyCol).map((c) => `${c} = EXCLUDED.${c}`);
        await client.query(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph.join(',')})
           ON CONFLICT (${keyCol}) DO UPDATE SET ${updates.join(',')}`,
          vals
        );
      } else {
        // Append-only: never update, only fill gaps.
        await client.query(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph.join(',')})
           ON CONFLICT DO NOTHING`,
          vals
        );
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Advance the cursor only AFTER the remote batch committed — textual
  // timestamp + id, so not a microsecond is lost.
  const last = rows[rows.length - 1];
  await query(
    `UPDATE sync_state
        SET watermark = $2::timestamptz, watermark_id = $3,
            rows_synced = rows_synced + $4, last_ok_at = now(), last_error = NULL
      WHERE id = $1`,
    [cursorId, last.__sync_wm, String(last[keyCol]), rows.length]
  );
  return rows.length;
}

/** One sync tick. Never throws — the loop must survive any network state. */
export async function tick() {
  stats.ticks++;
  if (!remoteConfigured()) {
    stats.state = 'STANDBY';
    return { state: 'STANDBY', reason: 'RDS_PGHOST not configured — nothing to sync to yet' };
  }
  if (isDegraded()) {
    // First call in a fresh process: resolve the local DB before giving up.
    await initDb({ quiet: true }).catch(() => {});
    if (isDegraded()) {
      stats.state = 'LOCAL_DB_DOWN';
      return { state: stats.state };
    }
  }
  try {
    const remote = getRemotePool();
    let pushed = 0;
    for (const table of SYNC_TABLES) {
      // Drain THIS table completely before its children: fuel_entries FKs into
      // trips, so trips beyond the first batch must land before any fuel row
      // that references them. Bounded by rows/BATCH iterations, not unbounded.
      for (;;) {
        const n = await pushTable(remote, table);
        pushed += n;
        if (n < BATCH) break;
      }
    }
    stats.state = 'SYNCED';
    stats.pushed += pushed;
    stats.last_ok_at = new Date().toISOString();
    return { state: 'SYNCED', pushed };
  } catch (err) {
    // Internet drop / RDS restart: count it, keep the cursor where it was,
    // resume next tick. This is the queue-and-resume guarantee.
    stats.state = 'RETRYING';
    stats.errors++;
    stats.last_error = err.message;
    return { state: 'RETRYING', error: err.message };
  }
}

export function syncStats() {
  return { ...stats, configured: remoteConfigured(), tables: SYNC_TABLES.length };
}

export async function closeSync() {
  if (remotePool) await remotePool.end().catch(() => {});
  remotePool = null;
}

export default { tick, syncStats, closeSync };
