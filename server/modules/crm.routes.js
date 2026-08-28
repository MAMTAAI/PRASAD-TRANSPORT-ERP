// server/modules/crm.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// /api/v1/crm — WhatsApp CRM, plus the small stores that had nowhere else to go:
// the AI letterpad's saved documents, the audit trail, the public-website
// content and the settings singletons.
//
//   GET/POST/PATCH/DELETE  /contacts /leads /rules /schedules
//   GET/POST               /chats            both sides of every conversation
//   GET/POST               /logs             CRM action log
//   GET/POST/DELETE        /documents        AI letterpad output
//   GET/POST               /activity         app-wide audit trail
//   GET/PUT                /website          public site content (singleton)
//   GET/PUT                /settings/:key    app_settings key/value
//
// TWO WRITERS, ONE TABLE. `wa_chats` and `wa_logs` are written both by the SPA
// (an operator sending from Trip Chat) and by the WhatsApp engine in
// whatsapp-server/, which used firebase-admin directly. The engine now posts
// here instead, so there is one insert path and one dedupe rule rather than two
// services racing on the same collection.
//
// `wa_msg_id` is WhatsApp's own message id and carries a UNIQUE constraint. The
// engine retries sends after a reconnect, so POST /chats treats a repeat as
// success (ON CONFLICT DO NOTHING → 200 with the existing row) instead of
// surfacing a 409 the engine would have to special-case.
// ─────────────────────────────────────────────────────────────────────────────
import { query, isDegraded } from '../db/pool.js';
import { listDirectory, resolveContact, last10 } from '../lib/contactDirectory.js';
import { WA_BASE } from '../lib/otpChannel.js';

const dbGate = (reply) => reply.code(503).send({ error: 'DB_UNAVAILABLE' });
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clamp = (v, d, max) => Math.min(Number.parseInt(v ?? d, 10) || d, max);

const pgErr = (reply, err) => {
  if (err.code === '23505') return reply.code(409).send({ error: 'DUPLICATE', detail: err.detail ?? err.message });
  if (err.code === '23514') return reply.code(400).send({ error: 'CONSTRAINT', detail: err.message });
  throw err;
};

export async function registerCrmRoutes(app) {
  // A small CRUD factory — these four tables are genuinely the same shape of
  // thing (a flat config list the dashboard edits), so writing the handlers out
  // four times would only create four places for them to drift.
  const crud = (path, table, cols, { required = [], transform = (b) => b, order = 'created_at DESC' } = {}) => {
    app.get(path, async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(`SELECT * FROM ${table} ORDER BY ${order}`);
      return { items: rows };
    });

    app.post(path, async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = transform(req.body ?? {});
      const missing = required.filter((c) => b[c] === undefined || b[c] === null || b[c] === '');
      if (missing.length) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: missing.join(', ') });
      try {
        const { rows } = await query(
          `INSERT INTO ${table} (${cols.join(', ')})
           VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
          cols.map((c) => b[c] ?? null));
        return reply.code(201).send({ item: rows[0] });
      } catch (e) { return pgErr(reply, e); }
    });

    app.patch(`${path}/:id`, async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = transform(req.body ?? {});
      const set = cols.filter((c) => b[c] !== undefined);
      if (!set.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
      const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'legacy_id = $1';
      try {
        const { rows } = await query(
          `UPDATE ${table} SET ${set.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE ${idCol} RETURNING *`,
          [req.params.id, ...set.map((c) => b[c])]);
        if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
        return { item: rows[0] };
      } catch (e) { return pgErr(reply, e); }
    });

    app.delete(`${path}/:id`, async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'legacy_id = $1';
      const { rowCount } = await query(`DELETE FROM ${table} WHERE ${idCol}`, [req.params.id]);
      if (!rowCount) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { deleted: true };
    });
  };

  crud('/contacts', 'wa_contacts', ['name', 'phone', 'category'],
    { required: ['name', 'phone'], transform: (b) => ({ ...b, phone: last10(b.phone) }) });

  crud('/leads', 'wa_leads', ['name', 'req', 'status'], { required: ['name'] });

  // Keywords are matched lowercased by the engine, so they are stored that way.
  crud('/rules', 'wa_rules', ['keyword', 'reply', 'action'],
    { required: ['keyword', 'reply'],
      transform: (b) => ({ ...b, keyword: b.keyword === undefined ? undefined : String(b.keyword).toLowerCase().trim() }) });

  crud('/schedules', 'wa_schedules', ['phone', 'message', 'send_at', 'status'],
    { required: ['phone', 'message', 'send_at'], order: 'send_at ASC',
      transform: (b) => ({ ...b, phone: b.phone === undefined ? undefined : last10(b.phone),
                                 send_at: b.send_at ?? b.datetime }) });

  // ═══ DIRECTORY ════════════════════════════════════════════════════════════
  // EVERY NUMBER THE ERP CAN REACH, IN ONE CALL.
  //
  // Live Dispatch Chat could only ever show numbers that had already written
  // in — it is an inbox, and an inbox cannot start a conversation. So dispatch
  // could see 11 strangers and none of the 54 drivers, 11 fuel pumps or the
  // customers whose numbers are sitting in the masters. To message a pump you
  // left the ERP, found the number somewhere else and typed it into a phone.
  //
  // The Broadcast Center already had this list, but assembled in the browser
  // from four separate fetches, which is why it could not be reused anywhere
  // and why it and the dispatch tabs disagreed about who exists.
  app.get('/directory', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { q, kind, limit } = req.query ?? {};
    const contacts = await listDirectory({ q, kind, limit });
    // Counts are over the FILTERED set on purpose: they label the tabs the
    // operator is looking at, so they have to move when the search does.
    const counts = contacts.reduce((a, c) => { a[c.kind] = (a[c.kind] || 0) + 1; return a; }, {});
    return { contacts, counts, total: contacts.length };
  });

  // ═══ SEND ═════════════════════════════════════════════════════════════════
  // THE ROUTE THAT WAS NEVER THERE.
  //
  // The SPA has been posting to `${ERP_API}/api/v1/api/send-whatsapp` — note
  // the doubled segment — from the Broadcast Center and Trip Chat since they
  // were written. Nothing has ever answered it. `wa_chats` holds 165 incoming
  // messages and ZERO outgoing, across the whole system, which is the shape of
  // that 404: every send silently failed, and the broadcast path did not even
  // read the response.
  //
  // THE FOOTPRINT COMES FROM THE TOKEN, NOT THE BODY. The old callers passed
  // `sentByUserId` and `sentByUserName` up from browser state, so the audit
  // trail recorded whoever the client claimed to be. Here it is taken from the
  // session, which is the only version of that answer worth storing.
  //
  // THE ROW IS WRITTEN BY THE ENGINE, NOT HERE. doSend() already inserts
  // through POST /chats with the message id, the session and its kind — things
  // only it knows. A second insert on this side would be a second insert path
  // for the same event, which is exactly what the note at the top of this file
  // says was removed.
  app.post('/send', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const phone = last10(b.phone ?? b.number);
    const text = String(b.text ?? b.message ?? '').trim();
    if (phone.length < 10) return reply.code(400).send({ error: 'BAD_PHONE', detail: 'phone must have at least 10 digits' });
    if (!text) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'text is required' });

    // Recorded so the stored row carries the relationship, not just a number —
    // null for a stranger, which is legitimate and must not block the send:
    // the first message to a new pump is exactly when you have no record yet.
    const contact = await resolveContact(phone);

    // The sender's OWN session when they have linked one, so the driver sees
    // the name of the person who is actually talking to them. The engine falls
    // back to the company line when it is not connected, so this is a
    // preference rather than a requirement — see doSend().
    const sessionId = req.user?.sub ? `u${String(req.user.sub).replace(/-/g, '')}` : undefined;

    let res;
    try {
      res = await fetch(`${WA_BASE}/api/send-whatsapp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          number: phone,
          message: text,
          sessionId,
          userId: req.user?.name ?? 'ERP',
          sentByUserId: req.user?.sub ?? null,
          sentByUserName: req.user?.name ?? 'ERP',
          tripId: UUID_RE.test(String(b.trip_id ?? b.tripId ?? '')) ? (b.trip_id ?? b.tripId) : null,
          role: contact?.kind ?? null,
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      // Unreachable engine is not a 500 on the ERP: nothing here is broken, and
      // the operator needs to be told which half is down.
      return reply.code(502).send({ error: 'ENGINE_UNREACHABLE', detail: e.name === 'TimeoutError' ? 'engine timeout' : e.message });
    }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.success === false) {
      return reply.code(502).send({ error: 'SEND_FAILED', detail: j.message || `engine returned ${res.status}` });
    }
    return { ok: true, phone, contact };
  });

  // ═══ CHATS ════════════════════════════════════════════════════════════════
  app.get('/chats', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { phone, trip_id, limit } = req.query ?? {};
    const where = [], args = [];
    if (phone) { args.push(last10(phone)); where.push(`phone = $${args.length}`); }
    if (trip_id && UUID_RE.test(String(trip_id))) { args.push(trip_id); where.push(`trip_id = $${args.length}::uuid`); }
    // Newest-first in SQL so a busy number does not have to be read whole, then
    // reversed for display — the dashboard renders oldest → newest.
    args.push(clamp(limit, 500, 2000));
    const { rows } = await query(
      `SELECT * FROM wa_chats ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ts DESC LIMIT $${args.length}`, args);
    return { chats: rows.reverse() };
  });

  app.post('/chats', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    // The engine's field is `type`; the column is `direction` because `type` is
    // a reserved-ish word in enough places to be worth avoiding.
    const direction = b.direction ?? b.type;
    if (!b.phone || !b.text || !['incoming', 'outgoing'].includes(direction)) {
      return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'phone, text and direction (incoming|outgoing) are required' });
    }
    const phone = last10(b.phone);
    const waSession = String(b.wa_session ?? b.waSession ?? 'company');
    const waKind = b.wa_session_kind === 'user' ? 'user' : 'company';

    // ── THE PRIVACY GATE ────────────────────────────────────────────────────
    // A staff member who links their own WhatsApp turns this endpoint into a
    // firehose of their private life: the engine's message handler posts every
    // message the linked device sees, and it has no idea which of them are work.
    // Storing that would put a staff member's family chats in the company books
    // — readable by anyone who can read wa_chats.
    //
    // So a USER session may only write conversations with a number the ERP
    // already knows: a driver, a customer or a vendor. Anything else is
    // acknowledged and dropped, here, before it touches the table.
    //
    // THE FILTER LIVES IN THE ERP, NOT THE ENGINE, because answering "is this
    // one of ours" needs the drivers, customers and vendors tables and the
    // engine has none of them. It also means the rule cannot be bypassed by an
    // engine that is out of date.
    //
    // The company number is NOT filtered: it is a business line, its traffic is
    // business record, and filtering it would silently discard a first message
    // from a driver phoning in on a number nobody has entered yet.
    //
    // "One of ours" is now answered by server/lib/contactDirectory.js rather
    // than by a third copy of the union living here. The copy this replaces had
    // already drifted: it knew nothing of wa_contacts, so a number somebody had
    // deliberately typed into the System Directory was treated as a stranger.
    //
    // OUTGOING IS NEVER FILTERED, AND THAT IS NOT A HOLE IN THE GATE.
    //
    // The gate above is about traffic the linked handset merely WITNESSES. But
    // the engine subscribes to `message`, not `message_create` — it is only
    // ever told about INCOMING messages, so a staff member's private outgoing
    // chats do not reach this endpoint at all and there is nothing here to
    // leak. Every outgoing row that does arrive was composed inside the ERP
    // (POST /crm/send) or by the bot, which makes it business record by
    // construction.
    //
    // Filtering it cost real records: a message sent from a staff member's own
    // linked number to a pump or a driver not yet on a master went out over
    // WhatsApp and was then dropped here — the reply would be kept once that
    // contact existed, but the message that started it never was. A footprint
    // with the first half missing is worse than none, because it reads as if
    // the office never wrote.
    if (waKind === 'user' && direction === 'incoming') {
      const known = await resolveContact(phone);
      if (!known) {
        // 200, not an error: nothing went wrong, and an engine that treated
        // this as a failure would retry a message it must never store.
        return { chat: null, skipped: 'NOT_A_KNOWN_PARTY' };
      }
    }

    const { rows } = await query(`
      INSERT INTO wa_chats (phone, text, direction, user_id, sent_by_user_id, sent_by_user_name,
        trip_id, role, wa_from, wa_msg_id, wa_session, wa_session_kind, ts)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz, now()))
      ON CONFLICT (wa_msg_id) DO NOTHING
      RETURNING *`,
      [phone, b.text, direction, b.userId ?? b.user_id ?? null,
       b.sentByUserId ?? b.sent_by_user_id ?? null, b.sentByUserName ?? b.sent_by_user_name ?? null,
       UUID_RE.test(String(b.tripId ?? b.trip_id ?? '')) ? (b.tripId ?? b.trip_id) : null,
       b.role ?? null, b.wa_from ?? null, b.wa_msg_id ?? null, waSession, waKind,
       b.timestamp ?? b.ts ?? null]);
    // DO NOTHING returns no row on a replayed send — report the existing one.
    if (!rows.length) {
      const { rows: existing } = await query('SELECT * FROM wa_chats WHERE wa_msg_id = $1', [b.wa_msg_id]);
      return { chat: existing[0] ?? null, duplicate: true };
    }
    return reply.code(201).send({ chat: rows[0] });
  });

  // ═══ CRM ACTION LOG ═══════════════════════════════════════════════════════
  app.get('/logs', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query('SELECT * FROM wa_logs ORDER BY ts DESC LIMIT $1', [clamp(req.query?.limit, 200, 1000)]);
    return { logs: rows };
  });

  app.post('/logs', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.action) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'action is required' });
    const { rows } = await query(
      'INSERT INTO wa_logs (user_name, action, ts) VALUES ($1,$2,COALESCE($3::timestamptz, now())) RETURNING *',
      [b.user ?? b.user_name ?? null, b.action, b.timestamp ?? null]);
    return reply.code(201).send({ log: rows[0] });
  });

  // ═══ SAVED DOCUMENTS (AI letterpad) ═══════════════════════════════════════
  app.get('/documents', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query('SELECT * FROM saved_documents ORDER BY created_at DESC LIMIT $1',
      [clamp(req.query?.limit, 200, 1000)]);
    return { documents: rows };
  });

  app.post('/documents', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    if (!b.title || !b.content) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'title and content are required' });
    const { rows } = await query(`
      INSERT INTO saved_documents (title, authority, vehicle_no, content, created_by)
      VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.title, b.authority ?? null, b.vehicle_no ?? null, b.content, b.created_by ?? null]);
    return reply.code(201).send({ document: rows[0] });
  });

  // Edit keeps created_at — the letterpad treats a re-save as a revision of the
  // same document, not a new one.
  app.patch('/documents/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const b = req.body ?? {};
    const cols = ['title', 'authority', 'vehicle_no', 'content'].filter((c) => b[c] !== undefined);
    if (!cols.length) return reply.code(400).send({ error: 'NOTHING_TO_UPDATE' });
    const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'legacy_id = $1';
    const { rows } = await query(
      `UPDATE saved_documents SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE ${idCol} RETURNING *`,
      [req.params.id, ...cols.map((c) => b[c])]);
    if (!rows.length) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { document: rows[0] };
  });

  app.delete('/documents/:id', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const idCol = UUID_RE.test(String(req.params.id)) ? 'id = $1::uuid' : 'legacy_id = $1';
    const { rowCount } = await query(`DELETE FROM saved_documents WHERE ${idCol}`, [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'NOT_FOUND' });
    return { deleted: true };
  });

  // ═══ ACTIVITY TRAIL ═══════════════════════════════════════════════════════
  app.get('/activity', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { action, limit } = req.query ?? {};
    const { rows } = action
      ? await query('SELECT * FROM activity_logs WHERE action = $1 ORDER BY ts DESC LIMIT $2', [action, clamp(limit, 200, 1000)])
      : await query('SELECT * FROM activity_logs ORDER BY ts DESC LIMIT $1', [clamp(limit, 200, 1000)]);
    return { activity: rows };
  });

  // Audit writes must never break the action they are recording — a failed log
  // returns 202 with the reason rather than an error the caller has to handle.
  app.post('/activity', async (req, reply) => {
    if (isDegraded()) return reply.code(202).send({ logged: false, reason: 'DB_UNAVAILABLE' });
    const b = req.body ?? {};
    if (!b.action) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'action is required' });
    try {
      const { rows } = await query(`
        INSERT INTO activity_logs (user_name, role, action, target, details, ts)
        VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz, now())) RETURNING *`,
        [b.user ?? b.user_name ?? null, b.role ?? null, b.action, b.target ?? null,
         b.details ?? null, b.timestamp ?? null]);
      return reply.code(201).send({ logged: true, entry: rows[0] });
    } catch (e) {
      req.log.warn({ err: e }, 'activity log insert failed');
      return reply.code(202).send({ logged: false, reason: e.code ?? 'ERROR' });
    }
  });

  // ═══ WEBSITE CONTENT ══════════════════════════════════════════════════════
  // A CMS document, stored whole as app_settings['website'] — see migration 043
  // for why this is not a table with a column per marketing field. The blob is
  // passed through in the camelCase shape both screens already use, so neither
  // needs a field-name adapter.
  app.get('/website', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query(`SELECT value, updated_at FROM app_settings WHERE key = 'website'`);
    // The public site must render before anyone has opened WebSettings, so
    // "never saved" is null, not a 404 — the screen falls back to its defaults.
    return { website: rows[0]?.value ?? null, updated_at: rows[0]?.updated_at ?? null };
  });

  app.put('/website', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const content = req.body?.website ?? req.body;
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return reply.code(400).send({ error: 'BAD_CONTENT', detail: 'expected the website settings object' });
    }
    const { rows } = await query(`
      INSERT INTO app_settings (key, value, updated_by)
      VALUES ('website', $1::jsonb, $2)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING value, updated_at`, [JSON.stringify(content), req.body?.updated_by ?? null]);
    return { website: rows[0].value, updated_at: rows[0].updated_at };
  });

  // ═══ APP SETTINGS ═════════════════════════════════════════════════════════
  app.get('/settings/:key', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const { rows } = await query('SELECT * FROM app_settings WHERE key = $1', [req.params.key]);
    return { key: req.params.key, value: rows[0]?.value ?? null, updated_at: rows[0]?.updated_at ?? null };
  });

  app.put('/settings/:key', async (req, reply) => {
    if (isDegraded()) return dbGate(reply);
    const value = req.body?.value;
    if (value === undefined) return reply.code(400).send({ error: 'MISSING_FIELDS', detail: 'value is required' });
    const { rows } = await query(`
      INSERT INTO app_settings (key, value, updated_by)
      VALUES ($1, $2::jsonb, $3)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
      RETURNING *`, [req.params.key, JSON.stringify(value), req.body?.updated_by ?? null]);
    return { setting: rows[0] };
  });
}
