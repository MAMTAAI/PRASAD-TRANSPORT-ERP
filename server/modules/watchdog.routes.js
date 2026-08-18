// server/modules/watchdog.routes.js
// ─────────────────────────────────────────────────────────────────────────────
// The Smart Watchdog board: what is broken now, on which box, for which firm —
// and what was done about it.
//
// Both environments write here. The office PC posts from erp_auto_healer.cjs;
// the AWS box posts to the same route over the existing tunnel. Neither is the
// source of truth about the other, which is the point: a crash in Mumbai and the
// same crash in Bongaigaon are two incidents, because fixing one fixes nothing
// about the other.
//
// COMPANY IS MANDATORY AND NEVER DEFAULTED.
// Prasad and Jaiswal share nothing — not books, not drives, not boxes. A writer
// that does not say which firm it belongs to is rejected, because an alert
// filed against the wrong company is worse than an alert that never arrived.
//
// WHAT THIS ROUTE WILL NOT DO
// It does not apply fixes. The healer's design is "AI proposes, God disposes" —
// a drafted fix is validated, backed up and then WAITS for approval, with zero
// autonomous overwrites by construction. This exposes that pipeline to a screen;
// it does not remove the gate. An auto-fix path that bypassed the approval would
// undo a safety property somebody chose on purpose.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { query, isDegraded } from '../db/pool.js';

const dbGate = (reply) =>
  reply.code(503).send({ error: 'DB_UNAVAILABLE', detail: 'database not reachable' });

const COMPANY = { type: 'string', enum: ['PRASAD', 'JAISWAL'] };
const ENVIRONMENT = { type: 'string', enum: ['LOCAL', 'AWS'] };

// The identity of an incident: the same crash in the same place is one row that
// counts up. The message is excluded on purpose — the same bug reported with a
// slightly different value is still the same bug, and splitting it would hide
// how often it fires.
const dedupeKey = (b) =>
  createHash('sha256')
    .update([b.service ?? '', b.kind, b.error_type ?? '', b.source_file ?? '', b.source_line ?? ''].join('|'))
    .digest('hex').slice(0, 40);

export async function registerWatchdogRoutes(app) {
  // ── the board a dashboard polls ──────────────────────────────────────────
  app.get(
    '/board',
    { schema: { querystring: { type: 'object', required: ['company'], properties: {
      company: COMPANY,
      environment: { type: ['string', 'null'], enum: ['LOCAL', 'AWS', null] },
      include_resolved: { type: 'boolean', default: true },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { company, environment = null, include_resolved = true, limit = 50 } = req.query ?? {};
      const { rows: summary } = await query(
        `SELECT * FROM v_watchdog_summary WHERE company = $1 ORDER BY environment`, [company]);
      const { rows: alerts } = await query(
        `SELECT * FROM v_watchdog_board
          WHERE company = $1
            AND ($2::text IS NULL OR environment = $2)
            AND ($3::boolean OR status <> 'GREEN')
          ORDER BY CASE status WHEN 'RED' THEN 0 WHEN 'DIAGNOSING' THEN 1
                               WHEN 'FIX_PROPOSED' THEN 2 ELSE 3 END,
                   CASE severity WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3
                                 WHEN 'MEDIUM' THEN 2 ELSE 1 END DESC,
                   last_seen_at DESC
          LIMIT $4`, [company, environment, include_resolved, limit]);

      // A board with nothing on it is only reassuring if something is watching.
      const stale = summary.filter((s) => s.watchdogs > 0 && s.watchdogs_alive < s.watchdogs);
      return {
        company,
        summary,
        watchdog_warning: stale.length
          ? `${stale.map((s) => s.environment).join(', ')}: a watchdog has stopped reporting — an empty board may not mean an empty problem`
          : null,
        total: alerts.length,
        alerts,
      };
    }
  );

  // ── ingest, from either environment ──────────────────────────────────────
  app.post(
    '/alert',
    { schema: { body: { type: 'object', required: ['company', 'environment', 'kind', 'title'], properties: {
      company: COMPANY, environment: ENVIRONMENT,
      host: { type: ['string', 'null'], maxLength: 80 },
      service: { type: ['string', 'null'], maxLength: 60 },
      severity: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], default: 'HIGH' },
      kind: { type: 'string', enum: ['CRASH', 'LEAK', 'BUG', 'UNRESPONSIVE', 'INTEGRATION'] },
      title: { type: 'string', maxLength: 200 },
      error_type: { type: ['string', 'null'], maxLength: 60 },
      error_message: { type: ['string', 'null'], maxLength: 2000 },
      source_file: { type: ['string', 'null'], maxLength: 300 },
      source_line: { type: ['integer', 'null'] },
      stack: { type: ['string', 'null'], maxLength: 6000 },
      proposal_id: { type: ['string', 'null'], maxLength: 80 },
      proposal_status: { type: ['string', 'null'], maxLength: 40 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      const { rows: [row] } = await query(
        `INSERT INTO watchdog_alerts
           (company, environment, host, service, severity, kind, title, error_type,
            error_message, source_file, source_line, stack, proposal_id, proposal_status, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (company, environment, dedupe_key) DO UPDATE
           SET occurrences  = watchdog_alerts.occurrences + 1,
               last_seen_at = now(),
               error_message = EXCLUDED.error_message,
               stack        = EXCLUDED.stack,
               proposal_id  = COALESCE(EXCLUDED.proposal_id, watchdog_alerts.proposal_id),
               proposal_status = COALESCE(EXCLUDED.proposal_status, watchdog_alerts.proposal_status),
               -- A resolved incident that fires again is not resolved. It goes
               -- back to RED and keeps its old report as history.
               status = CASE WHEN watchdog_alerts.status = 'GREEN' THEN 'RED'
                             ELSE watchdog_alerts.status END,
               updated_at = now()
         RETURNING id, status, occurrences`,
        [b.company, b.environment, b.host ?? null, b.service ?? null, b.severity ?? 'HIGH',
         b.kind, b.title, b.error_type ?? null, b.error_message ?? null, b.source_file ?? null,
         b.source_line ?? null, b.stack ?? null, b.proposal_id ?? null, b.proposal_status ?? null,
         dedupeKey(b)]);
      return { ok: true, ...row };
    }
  );

  // ── lifecycle ────────────────────────────────────────────────────────────
  app.post(
    '/alert/:id/status',
    { schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', required: ['status'], properties: {
        status: { type: 'string', enum: ['RED', 'DIAGNOSING', 'FIX_PROPOSED', 'GREEN', 'MUTED'] },
        // Required to go green — enforced by the table, checked here so the
        // caller gets a sentence rather than a constraint violation.
        fix_report: { type: ['string', 'null'], maxLength: 4000 },
        fix_diff: { type: ['string', 'null'], maxLength: 20000 },
        fixed_by: { type: ['string', 'null'], maxLength: 80 },
        proposal_id: { type: ['string', 'null'], maxLength: 80 },
        proposal_status: { type: ['string', 'null'], maxLength: 40 },
      } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      if (b.status === 'GREEN' && !b.fix_report) {
        return reply.code(400).send({
          error: 'FIX_REPORT_REQUIRED',
          detail: 'Closing an incident needs a report saying what was wrong and what was done. A colour change on its own cannot be audited.',
        });
      }
      const { rows: [row] } = await query(
        `UPDATE watchdog_alerts
            SET status = $2,
                fix_report = COALESCE($3, fix_report),
                fix_diff   = COALESCE($4, fix_diff),
                fixed_by   = CASE WHEN $2 = 'GREEN' THEN COALESCE($5, fixed_by) ELSE fixed_by END,
                fixed_at   = CASE WHEN $2 = 'GREEN' THEN now() ELSE fixed_at END,
                proposal_id = COALESCE($6, proposal_id),
                proposal_status = COALESCE($7, proposal_status),
                updated_at = now()
          WHERE id = $1::uuid
        RETURNING id, company, environment, status, fixed_at`,
        [req.params.id, b.status, b.fix_report ?? null, b.fix_diff ?? null,
         b.fixed_by ?? null, b.proposal_id ?? null, b.proposal_status ?? null]);
      if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { ok: true, ...row };
    }
  );

  app.post(
    '/alert/:id/acknowledge',
    { schema: {
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', properties: { by: { type: ['string', 'null'], maxLength: 80 } } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows: [row] } = await query(
        `UPDATE watchdog_alerts
            SET acknowledged_by = $2, acknowledged_at = now(),
                status = CASE WHEN status = 'RED' THEN 'DIAGNOSING' ELSE status END,
                updated_at = now()
          WHERE id = $1::uuid RETURNING id, status`,
        [req.params.id, req.body?.by ?? 'staff']);
      if (!row) return reply.code(404).send({ error: 'NOT_FOUND' });
      return { ok: true, ...row };
    }
  );

  // ── heartbeat ────────────────────────────────────────────────────────────
  app.post(
    '/heartbeat',
    { schema: { body: { type: 'object', required: ['company', 'environment', 'watchdog'], properties: {
      company: COMPANY, environment: ENVIRONMENT,
      watchdog: { type: 'string', maxLength: 60 },
      host: { type: ['string', 'null'], maxLength: 80 },
      version: { type: ['string', 'null'], maxLength: 40 },
      detail: { type: 'object', default: {} },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const b = req.body;
      await query(
        `INSERT INTO watchdog_heartbeats (company, environment, watchdog, host, version, beat_at, detail)
         VALUES ($1,$2,$3,$4,$5, now(), $6::jsonb)
         ON CONFLICT (company, environment, watchdog) DO UPDATE
           SET beat_at = now(), host = EXCLUDED.host,
               version = EXCLUDED.version, detail = EXCLUDED.detail`,
        [b.company, b.environment, b.watchdog, b.host ?? null, b.version ?? null,
         JSON.stringify(b.detail ?? {})]);
      return { ok: true };
    }
  );

  // ── the work queue an agent drains ───────────────────────────────────────
  // What a Claude Code run (scheduled, or started by a person) picks up. It is
  // a QUEUE, not a push: nothing here can wake an agent by itself, and
  // pretending otherwise would leave incidents sitting behind a webhook nobody
  // is listening to.
  app.get(
    '/queue',
    { schema: { querystring: { type: 'object', required: ['company'], properties: {
      company: COMPANY,
      limit: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
    } } } },
    async (req, reply) => {
      if (isDegraded()) return dbGate(reply);
      const { rows } = await query(
        `SELECT id, company, environment, host, service, severity, kind, title,
                error_type, error_message, source_file, source_line, stack,
                occurrences, first_seen_at, last_seen_at
           FROM watchdog_alerts
          WHERE company = $1 AND status IN ('RED', 'DIAGNOSING')
          ORDER BY CASE severity WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3
                                 WHEN 'MEDIUM' THEN 2 ELSE 1 END DESC,
                   occurrences DESC, first_seen_at
          LIMIT $2`, [req.query.company, req.query.limit ?? 5]);
      return {
        company: req.query.company,
        awaiting_diagnosis: rows.length,
        instructions: 'Diagnose each, then POST /alert/:id/status with status=GREEN and a fix_report. Code changes still go through the healer approval gate.',
        items: rows,
      };
    }
  );
}
