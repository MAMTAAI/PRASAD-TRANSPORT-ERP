// server/lib/realtime.js
// ─────────────────────────────────────────────────────────────────────────────
// Socket.io on the same HTTP server Fastify already owns.
//
// WHAT THIS IS AND IS NOT FOR. It pushes GPS fixes to the dispatch board the
// moment they are ingested, so the map updates without a reload and without
// every open board polling /api/v1/tracking on a timer.
//
// It does NOT reduce Google Maps spend, and it should not be sold as doing so:
// Maps JS is billed per map load and marker movement is free. What sockets save
// is OUR server's load and the latency between a truck reporting and the board
// showing it. The Google cost lives in Directions/Distance Matrix, which is what
// maps_cache (migration 052) is for.
//
// AUTH. A socket is a long-lived connection, so it is authenticated once at
// handshake against the same JWT + session + account_status rules as HTTP. A
// suspended account cannot hold an open socket open as a side door — that is
// exactly the gap an approval workflow would otherwise leave.
// ─────────────────────────────────────────────────────────────────────────────
import { Server } from 'socket.io';
import { query, isDegraded } from '../db/pool.js';
import { verifyToken } from './auth.js';

let io = null;

const ORIGINS = String(process.env.ALLOWED_ORIGINS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** Attach to Fastify's underlying Node server. Must run after app.listen(). */
export function initRealtime(httpServer, log) {
  if (io) return io;

  io = new Server(httpServer, {
    path: '/socket.io',
    // Same origin policy as the REST API. A wildcard here would let any page on
    // the internet open an authenticated socket with a stolen token.
    cors: { origin: ORIGINS.length ? ORIGINS : false, credentials: true },
    // Long-poll fallback stays enabled ON PURPOSE: the production nginx in
    // deploy/aws/ does not yet forward the Upgrade/Connection headers, so a
    // websocket-only client would fail there outright. Polling is slower but it
    // works; remove it once nginx is reloaded with the patched config.
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      const claims = verifyToken(String(token ?? ''));
      if (!claims) return next(new Error('UNAUTHENTICATED'));
      if (isDegraded()) return next(new Error('DB_UNAVAILABLE'));

      const { rows } = await query(
        `SELECT u.account_status::text AS account_status
           FROM auth_sessions s
           LEFT JOIN users u ON u.id = s.user_id
          WHERE s.jti = $1::uuid AND s.expires_at > now()`, [claims.jti]);
      if (!rows.length) return next(new Error('SESSION_REVOKED'));
      // NULL = driver session (drivers are not `users` rows); they are governed
      // by the drivers master, not the staff approval workflow.
      const st = rows[0].account_status;
      if (st && st !== 'ACTIVE') return next(new Error(`ACCOUNT_${st}`));

      socket.data.user = { id: claims.sub, role: claims.role, name: claims.name };
      return next();
    } catch (e) {
      return next(new Error('HANDSHAKE_FAILED'));
    }
  });

  io.on('connection', (socket) => {
    // One room. Everyone watching the board wants the same firehose of fixes,
    // and per-trip rooms would mean re-subscribing every time the board's trip
    // list changes.
    socket.join('fleet');
    log?.info({ user: socket.data.user?.name }, 'realtime: client connected');
    socket.on('disconnect', () => log?.debug('realtime: client disconnected'));
  });

  log?.info({ origins: ORIGINS }, 'realtime: socket.io attached');
  return io;
}

/** Push one GPS fix to every open dispatch board. Never throws — telemetry must
 *  not be able to fail an ingest that already succeeded. */
export function broadcastFix(fix) {
  try {
    io?.to('fleet').emit('gps:fix', fix);
  } catch { /* a dropped frame is not worth an error surface */ }
}

export const realtimeStatus = () => ({
  attached: !!io,
  clients: io ? io.engine.clientsCount : 0,
});
