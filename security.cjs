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

-- 🛡️ PHASE-1 ACTIVE DEFENSE (shadow-arm by default)
CREATE TABLE IF NOT EXISTS ip_bans (
  ip        TEXT PRIMARY KEY,
  strikes   INTEGER NOT NULL DEFAULT 0,
  first_ts  TEXT NOT NULL,
  last_ts   TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'shadow',  -- shadow (would-ban, not enforced) | enforced
  reason    TEXT
);
CREATE TABLE IF NOT EXISTS soc_meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
`);

// ── Phase-1 config (all env-driven; ARM defaults OFF = shadow) ──────────────
// SOC_ARM=1 is the ONLY switch that lets bans actually block traffic. Kept out
// of any live endpoint on purpose: arming requires an env change + restart, so
// neither an attacker nor a mis-click can flip active defense on.
const ARMED = process.env.SOC_ARM === '1' || process.env.SOC_ARM === 'true';
const STRIKE_THRESHOLD = Math.max(1, Number(process.env.SOC_STRIKE_THRESHOLD) || 5);
const STRIKE_WINDOW_MIN = Math.max(1, Number(process.env.SOC_STRIKE_WINDOW_MIN) || 10);
// Never-ban list: loopback + sibling infra + office/CF ranges via env (CSV).
const IP_ALLOWLIST = new Set(
  ['127.0.0.1', '::1', '::ffff:127.0.0.1']
    .concat((process.env.SOC_IP_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean))
);

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

// ── Strike counter + auto-ban (shadow unless ARMED) ─────────────────────────
const qStrikes = db.prepare(`
  SELECT COUNT(*) AS n FROM security_events
  WHERE ip = ? AND kind = 'threat' AND ts >= ?
`);
const getBan = db.prepare(`SELECT * FROM ip_bans WHERE ip = ?`);
const upsertBan = db.prepare(`
  INSERT INTO ip_bans (ip, strikes, first_ts, last_ts, status, reason)
  VALUES (@ip, @strikes, @ts, @ts, @status, @reason)
  ON CONFLICT(ip) DO UPDATE SET strikes = @strikes, last_ts = @ts, status = @status, reason = @reason
`);

// Called after every threat capture that carries an IP. Counts strikes in the
// rolling window; at/over threshold it records a ban row. In shadow mode the row
// is status='shadow' and NOTHING is blocked — it is purely a "would-ban" record
// so you can watch the logic against real traffic before arming.
function evaluateBan(ip) {
  if (!ip || IP_ALLOWLIST.has(ip)) return;
  const since = new Date(Date.now() - STRIKE_WINDOW_MIN * 60000).toISOString();
  const strikes = qStrikes.get(ip, since).n;
  if (strikes < STRIKE_THRESHOLD) return;
  const existing = getBan.get(ip);
  if (existing && existing.status === 'enforced') return; // already banned
  const status = ARMED ? 'enforced' : 'shadow';
  const ts = new Date().toISOString();
  upsertBan.run({ ip, strikes, ts, status, reason: `${strikes} strikes in ${STRIKE_WINDOW_MIN}m` });
  // Surface the decision as its own event so it shows up red on the radar.
  insEvt.run({
    id: crypto.randomUUID(), ts, kind: 'threat',
    severity: 'critical', source: 'prasad', sensor: 'auto-defense',
    category: ARMED ? 'ip-banned' : 'ip-would-ban', ip,
    method: null, path: null, file: null, line: null,
    message: `${ARMED ? 'BANNED' : 'WOULD BAN'} ${ip} — ${strikes} strikes/${STRIKE_WINDOW_MIN}m (threshold ${STRIKE_THRESHOLD})`,
    action: ARMED ? 'ip-drop' : 'shadow-would-ban', remediation: null,
  });
}

// Enforcement check for the request path. Returns true ONLY when armed AND the
// IP has an enforced ban — shadow bans never block anything.
const qEnforced = db.prepare(`SELECT 1 FROM ip_bans WHERE ip = ? AND status = 'enforced' LIMIT 1`);
function isBanned(ip) {
  if (!ARMED || !ip || IP_ALLOWLIST.has(ip)) return false;
  return !!qEnforced.get(ip);
}

// ── Manual kill-switch (God-triggered, never automatic) ─────────────────────
const getMeta = db.prepare(`SELECT v FROM soc_meta WHERE k = ?`);
const setMeta = db.prepare(`INSERT INTO soc_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`);
function killState() {
  try { return JSON.parse(getMeta.get('killswitch')?.v || '{"active":false}'); }
  catch { return { active: false }; }
}
function setKill(active, by) {
  const state = { active: !!active, by: String(by || 'God'), ts: new Date().toISOString() };
  setMeta.run('killswitch', JSON.stringify(state));
  capture({
    kind: 'threat', severity: 'critical', sensor: 'kill-switch',
    category: active ? 'killswitch-engaged' : 'killswitch-released',
    message: `Manual kill-switch ${active ? 'ENGAGED' : 'released'} by ${state.by}`,
    action: active ? 'system-halt' : 'system-resume',
  });
  return state;
}

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
    // Feed the strike counter — but never recurse on our own auto-defense events.
    if (e.ip && e.sensor !== 'auto-defense') evaluateBan(String(e.ip).slice(0, 60));
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
  const enforced = qBansByStatus.all('enforced');
  const shadow = qBansByStatus.all('shadow');
  return {
    status: 'ok',
    // OBSERVE = shadow (logs would-bans, blocks nothing). ARMED = enforcing.
    armState: ARMED ? 'ARMED' : 'OBSERVE',
    kill: killState(),
    config: { strikeThreshold: STRIKE_THRESHOLD, windowMin: STRIKE_WINDOW_MIN, armed: ARMED },
    counts: {
      threatsToday, bugsToday, bySeverity,
      bannedIps: enforced.length,
      wouldBan: shadow.length, // shadow "would-ban" preview
    },
    events,
    banned: enforced.map((b) => ({ ip: b.ip, reason: b.reason, ts: b.last_ts })),
    wouldBan: shadow.map((b) => ({ ip: b.ip, reason: b.reason, ts: b.last_ts })),
  };
}
const qBansByStatus = db.prepare(`SELECT ip, reason, last_ts FROM ip_bans WHERE status = ? ORDER BY last_ts DESC LIMIT 100`);

const qAck = db.prepare(`UPDATE security_events SET acked = 1 WHERE id = ?`);
function ack(id) {
  const r = qAck.run(String(id || ''));
  return r.changes > 0;
}

module.exports = { capture, radar, ack, isBanned, killState, setKill, armed: ARMED };
