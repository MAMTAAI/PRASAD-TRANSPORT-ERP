// server/agents/bus.js
// ─────────────────────────────────────────────────────────────────────────────
// The event bus: PostgreSQL LISTEN/NOTIFY bridged onto a Node EventEmitter.
//
//   emit()  →  INSERT INTO agent_events  →  trigger  →  pg_notify
//                                                          ↓
//   EventEmitter  ←  claim (FOR UPDATE SKIP LOCKED)  ←  LISTEN
//
// Two properties this shape buys, both of which a bare EventEmitter lacks:
//
//   • Durability. An event is a committed row before anyone reacts to it. Kill
//     the process mid-settlement and the event is still there on restart.
//   • Multi-process fan-out. NOTIFY reaches every connected API instance, and
//     SKIP LOCKED guarantees only one of them handles each event.
//
// A poll fallback runs alongside LISTEN. NOTIFY is delivered at most once — if
// the listener is reconnecting at the moment of the notify, that wake-up is
// lost. The poll makes delivery eventual rather than best-effort.
// ─────────────────────────────────────────────────────────────────────────────
import { EventEmitter } from 'node:events';
import { createDedicatedClient, query, isDegraded, DbUnavailableError } from '../db/pool.js';

const CHANNEL = 'prasad_agent_events';

export const bus = new EventEmitter();
// Ten agents can legitimately subscribe to one popular event (trip.completed).
bus.setMaxListeners(50);

let listener = null;         // dedicated LISTEN client
let pollTimer = null;
let draining = false;
let stopped = true;
let reconnectDelay = 1000;

const POLL_MS = Number.parseInt(process.env.AGENT_POLL_MS ?? '5000', 10);
const BATCH = Number.parseInt(process.env.AGENT_BATCH ?? '10', 10);

// ── Emitting ────────────────────────────────────────────────────────────────

/**
 * Publish an event.
 *
 * Pass `tx` (a client inside withTransaction) to make the event part of the
 * caller's transaction — the transactional-outbox guarantee. Without it the
 * event commits on its own and can outlive a rolled-back business write, so
 * anything ₹-affecting must pass `tx`.
 */
export async function emit(eventType, { aggregate, aggregateId = null, payload = {}, emittedBy = null, correlationId = null, tx = null } = {}) {
  if (!aggregate) throw new Error(`emit('${eventType}') requires an aggregate`);

  const sql = `
    INSERT INTO agent_events (event_type, aggregate, aggregate_id, payload, emitted_by, correlation_id)
    VALUES ($1, $2, $3, $4::jsonb, $5, COALESCE($6::uuid, gen_random_uuid()))
    RETURNING id, event_type, correlation_id`;
  const params = [eventType, aggregate, aggregateId, JSON.stringify(payload), emittedBy, correlationId];

  if (tx) {
    const { rows } = await tx.query(sql, params);
    return rows[0];
  }
  const { rows } = await query(sql, params);
  return rows[0];
}

// ── Listening ───────────────────────────────────────────────────────────────

async function connectListener() {
  listener = await createDedicatedClient();
  await listener.query(`LISTEN ${CHANNEL}`);

  listener.on('notification', () => {
    // The payload carries only id + type. We ignore it and drain the queue,
    // because draining is what respects SKIP LOCKED across instances — acting
    // on the notified id directly would race other workers.
    drain().catch((err) => console.error('[bus] drain failed:', err.message));
  });

  listener.on('error', (err) => {
    console.error('[bus] listener error:', err.message);
    scheduleReconnect();
  });
  listener.on('end', () => {
    if (!stopped) scheduleReconnect();
  });

  reconnectDelay = 1000;
  console.log(`[bus] LISTEN ${CHANNEL} active`);
}

function scheduleReconnect() {
  if (stopped) return;
  const client = listener;
  listener = null;
  client?.end?.().catch(() => {});

  const delay = reconnectDelay;
  // Exponential backoff to 30s, so a database outage does not turn into a
  // reconnect storm against a struggling RDS instance.
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  console.warn(`[bus] reconnecting listener in ${delay}ms`);
  setTimeout(() => {
    if (stopped) return;
    connectListener().catch((err) => {
      console.error('[bus] reconnect failed:', err.message);
      scheduleReconnect();
    });
  }, delay);
}

// ── Draining ────────────────────────────────────────────────────────────────

/**
 * Claim and dispatch a batch. Serialised by the `draining` flag so a burst of
 * notifications cannot start ten overlapping drains in this process.
 */
export async function drain() {
  if (draining || stopped) return 0;
  draining = true;
  let handled = 0;
  try {
    // Keep going while full batches come back — a backlog clears in one pass
    // instead of one batch per poll interval.
    for (;;) {
      const { rows } = await query('SELECT * FROM claim_agent_events($1)', [BATCH]);
      if (!rows.length) break;
      for (const event of rows) {
        // Dispatch is awaited so agent_events state transitions stay ordered
        // per batch; the registry decides which agents run and in what order.
        await dispatch(event);
        handled++;
      }
      if (rows.length < BATCH) break;
    }
  } catch (err) {
    if (err instanceof DbUnavailableError) {
      // Degraded mode: nothing to drain, and saying so every 5s is noise.
    } else {
      throw err;
    }
  } finally {
    draining = false;
  }
  return handled;
}

// The registry installs the real dispatcher. Kept as an injected function so
// bus.js has no import back into registry.js (which imports bus.js).
let dispatch = async (event) => {
  console.warn(`[bus] no dispatcher installed — event ${event.id} (${event.event_type}) dropped`);
};

export function setDispatcher(fn) {
  dispatch = fn;
}

// ── Event state transitions ─────────────────────────────────────────────────

export async function markDone(eventId) {
  await query(`UPDATE agent_events SET state = 'DONE', processed_at = now() WHERE id = $1`, [eventId]);
}

/**
 * Mark an event failed. After 5 attempts it becomes DEAD and stops being
 * claimed — a poison event must not spin forever, it must become visible.
 */
export async function markFailed(eventId, error) {
  const { rows } = await query(
    `UPDATE agent_events
        SET state = CASE WHEN attempts >= 5 THEN 'DEAD'::agent_event_state
                         ELSE 'FAILED'::agent_event_state END,
            last_error = $2
      WHERE id = $1
      RETURNING state, attempts`,
    [eventId, String(error).slice(0, 2000)]
  );
  if (rows[0]?.state === 'DEAD') {
    console.error(`[bus] event ${eventId} DEAD after ${rows[0].attempts} attempts: ${error}`);
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export async function startBus() {
  if (!stopped) return;
  stopped = false;

  if (isDegraded()) {
    // No database means no outbox. Local EventEmitter delivery still works for
    // in-process signalling, but nothing is durable — say so plainly.
    console.warn('[bus] database degraded — durable event delivery is OFF');
    return;
  }

  try {
    await connectListener();
  } catch (err) {
    console.error('[bus] initial LISTEN failed:', err.message);
    scheduleReconnect();
  }

  // Safety net for lost notifications, and the only delivery path while the
  // listener is reconnecting.
  pollTimer = setInterval(() => {
    drain().catch((err) => console.error('[bus] poll drain failed:', err.message));
  }, POLL_MS);
  pollTimer.unref?.();

  await drain().catch(() => {});
}

export async function stopBus() {
  stopped = true;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  const client = listener;
  listener = null;
  if (client) {
    try {
      await client.query(`UNLISTEN ${CHANNEL}`);
    } catch { /* connection may already be gone */ }
    await client.end().catch(() => {});
  }
  console.log('[bus] stopped');
}
