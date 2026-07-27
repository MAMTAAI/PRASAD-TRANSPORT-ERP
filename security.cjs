// =======================================================
// 🛡️ MAMTA SOC — Phase-0 SHADOW security-event store (observe-only)
// Prasad Transport port of the Jaiswal Capital SOC radar (§18b).
// better-sqlite3 (WAL) — same zero-server pattern as kg/graph.cjs.
//
// Phase-0 = capture + classify + display ONLY. Active defense (IP bans,
// kill-switch) stays God-gated and is NOT implemented here — armState is
// hardwired to OBSERVE until that phase is explicitly ordered.
//
// Sensors feeding this store:
//   bridge.cjs itself  → direct soc.capture() on auth/CORS failures
//   WhatsApp engine (:5001) + payout server (:5000) → POST /security/ingest
// =======================================================
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const DB_PATH = process.env.SECURITY_DB_PATH || path.join(__dirname, 'data', 'security-events.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
CREATE TABLE IF NOT EXISTS security_events (
  id          TEXT PRIMARY KEY,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'threat',   -- threat | bug
  severity    TEXT NOT NULL DEFAULT 'med',      -- critical | high | med | low
  source      TEXT NOT NULL DEFAULT 'prasad',   -- prasad | jaiswal
  sensor      TEXT,
  category    TEXT,
  ip          TEXT,
  method      TEXT,
  path        TEXT,
  file        TEXT,
  line        INTEGER,
  message     TEXT,
  action      TEXT,
  acked       INTEGER NOT NULL DEFAULT 0,
  remediation TEXT
);
CREATE INDEX IF NOT EXISTS idx_sec_ts ON security_events(ts);
`);

const insEvt = db.prepare(`
  INSERT INTO security_events (id, ts, kind, severity, source, sensor, category, ip, method, path, file, line, message, action, remediation)
  VALUES (@id, @ts, @kind, @severity, @source, @sensor, @category, @ip, @method, @path, @file, @line, @message, @action, @remediation)
`);
const pruneEvt = db.prepare(`
  DELETE FROM security_events WHERE id IN (
    SELECT id FROM security_events ORDER BY ts DESC LIMIT -1 OFFSET 5000
  )
`);

const KINDS = ['threat', 'bug'];
const SEVERITIES = ['critical', 'high', 'med', 'low'];

// Best-effort, never throws — a broken SOC store must never break the request
// path it is observing.
function capture(evt) {
  try {
    const e = evt || {};
    insEvt.run({
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      kind: KINDS.includes(e.kind) ? e.kind : 'threat',
      severity: SEVERITIES.includes(e.severity) ? e.severity : 'med',
      source: e.source === 'jaiswal' ? 'jaiswal' : 'prasad',
      sensor: String(e.sensor || 'unknown').slice(0, 60),
      category: String(e.category || 'uncategorized').slice(0, 60),
      ip: e.ip ? String(e.ip).slice(0, 60) : null,
      method: e.method ? String(e.method).slice(0, 10) : null,
      path: e.path ? String(e.path).slice(0, 200) : null,
      file: e.file ? String(e.file).slice(0, 200) : null,
      line: Number.isFinite(Number(e.line)) ? Number(e.line) : null,
      message: e.message ? String(e.message).slice(0, 500) : null,
      action: String(e.action || 'logged').slice(0, 100),
      remediation: e.remediation ? JSON.stringify(e.remediation).slice(0, 1000) : null,
    });
    pruneEvt.run();
  } catch (err) {
    console.warn('SOC capture skipped:', err.message);
  }
}

const qToday = db.prepare(`
  SELECT kind, severity, COUNT(*) AS n FROM security_events
  WHERE substr(ts, 1, 10) = ? GROUP BY kind, severity
`);
const qRecent = db.prepare(`SELECT * FROM security_events ORDER BY ts DESC LIMIT ?`);

// RadarData shape — identical to the Jaiswal SecurityRadar widget contract.
function radar(limit = 100) {
  const today = new Date().toISOString().slice(0, 10);
  const bySeverity = {};
  let threatsToday = 0, bugsToday = 0;
  for (const r of qToday.all(today)) {
    bySeverity[r.severity] = (bySeverity[r.severity] || 0) + r.n;
    if (r.kind === 'bug') bugsToday += r.n; else threatsToday += r.n;
  }
  const events = qRecent.all(Math.min(Number(limit) || 100, 500)).map((r) => ({
    ...r,
    acked: !!r.acked,
    remediation: r.remediation ? JSON.parse(r.remediation) : undefined,
  }));
  return {
    status: 'ok',
    armState: 'OBSERVE', // Phase-0 SHADOW — flips only on an explicit God order
    counts: { threatsToday, bugsToday, bySeverity, bannedIps: 0 },
    events,
    banned: [], // active defense not armed in Phase-0
  };
}

const qAck = db.prepare(`UPDATE security_events SET acked = 1 WHERE id = ?`);
function ack(id) {
  const r = qAck.run(String(id || ''));
  return r.changes > 0;
}

module.exports = { capture, radar, ack };
