#!/usr/bin/env node
// scripts/sync-tunnel.cjs — BAGALAMUKHI's secure channel to the AWS PostgreSQL.
//
//   node scripts/sync-tunnel.cjs           run supervised (auto-reconnect)
//   node scripts/sync-tunnel.cjs --status  is the tunnel port answering?
//
// Forwards 127.0.0.1:15432 (this PC) → 127.0.0.1:5432 (AWS box) over SSH.
// The cloud postgres binds loopback-only — this tunnel is the ONLY path in,
// which is exactly the isolation Bagalamukhi's guards demand (no public 5432,
// no security-group juggling, encryption included).
//
// Supervised like the WhatsApp engine: if ssh dies (sleep, network drop, AWS
// reboot) it relaunches with backoff. The sync engine tolerates the gap — its
// watermark cursor simply holds until the tunnel answers again.
//
// ⚠️ THIS IS A WINDOW, NOT A DOOR BACK IN. Production is the single writer of
// these books (see ERP_API.KILL at the repo root). The tunnel exists so someone
// at this desk can READ production — psql, a report, a data question — without
// opening 5432 to the internet. It is not a route for the office PC to start
// writing again: that decision was made on 24-08-2026 after the two copies
// diverged, and reviving it needs the owner, not a convenient port.
const { spawn, execSync } = require('node:child_process');
const { existsSync, mkdirSync, appendFileSync } = require('node:fs');
const { join } = require('node:path');
const os = require('node:os');
const net = require('node:net');

const LOCAL_PORT = Number(process.env.SYNC_TUNNEL_PORT ?? 15432);

// PRASAD'S BOX, AND PRASAD'S KEY.
//
// These defaulted to ubuntu@api.jaiswalcapital.com with the jaiswal_claude key
// — correct before 20-08-2026, when this ERP ran on the shared Jaiswal box, and
// wrong every day since the cutover. `npm run sync:tunnel` in the PRASAD repo
// opened a tunnel to another company's server, and did it quietly, because a
// working SSH connection looks identical whichever host answers.
//
// Overridable for a staging box, but the default has to be this firm's own.
const REMOTE = process.env.SYNC_TUNNEL_HOST ?? 'ubuntu@65.0.27.161';
const KEY = process.env.SYNC_TUNNEL_KEY ?? join(os.homedir(), '.ssh', 'prasad-key.pem');
const LOG_DIR = process.env.LOG_DIR || join(__dirname, '..', 'logs'); // F: isolation when set
const LOG = join(LOG_DIR, 'sync-tunnel.log');

mkdirSync(LOG_DIR, { recursive: true });
const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  process.stdout.write(line);
  try { appendFileSync(LOG, line); } catch { /* logging must never kill the tunnel */ }
};

// ── --status: probe the forwarded port ──────────────────────────────────────
if (process.argv.includes('--status')) {
  const sock = net.connect({ host: '127.0.0.1', port: LOCAL_PORT, timeout: 3000 });
  sock.on('connect', () => { console.log(`TUNNEL UP — 127.0.0.1:${LOCAL_PORT} answering`); sock.end(); process.exit(0); });
  sock.on('error', () => { console.log('TUNNEL DOWN'); process.exit(1); });
  sock.on('timeout', () => { console.log('TUNNEL DOWN (timeout)'); process.exit(1); });
  return;
}

if (!existsSync(KEY)) {
  log(`FATAL: SSH key not found at ${KEY}`);
  process.exit(1);
}

// ── Supervisor loop ─────────────────────────────────────────────────────────
let backoffMs = 2000;
let stopping = false;

function launch() {
  if (stopping) return;
  const args = [
    '-i', KEY,
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',   // detect a dead peer inside a minute…
    '-o', 'ServerAliveCountMax=2',
    '-o', 'ExitOnForwardFailure=yes', // …and refuse to sit on a broken forward
    '-N',
    '-L', `127.0.0.1:${LOCAL_PORT}:127.0.0.1:5432`,
    // THE REVERSE LANE IS GONE, ON PURPOSE.
    //
    // It used to publish this PC's WhatsApp engine (:5001) to the box at :5601,
    // because the engine ran here. It runs on the box now — pm2 app
    // prasad-wa-engine, and WA_ENGINE_URL there reads http://127.0.0.1:5002.
    // Keeping the lane would offer the box a second engine on a port nothing
    // reads, and would fail the whole tunnel under ExitOnForwardFailure the
    // moment :5601 was already bound.
    REMOTE,
  ];
  log(`tunnel starting → ${REMOTE} (local :${LOCAL_PORT})`);
  const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => log(`ssh: ${String(d).trim()}`));
  child.stderr.on('data', (d) => log(`ssh: ${String(d).trim()}`));

  child.on('spawn', () => {
    // Successful sustained connection resets the backoff.
    setTimeout(() => { if (child.exitCode === null) backoffMs = 2000; }, 15_000);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    log(`tunnel exited (code=${code} signal=${signal}) — relaunch in ${backoffMs / 1000}s`);
    setTimeout(launch, backoffMs);
    backoffMs = Math.min(backoffMs * 2, 60_000); // cap at 1 min between tries
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      stopping = true;
      log(`${sig} — closing tunnel`);
      child.kill();
      process.exit(0);
    });
  }
}

launch();
