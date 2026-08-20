// PM2 ecosystem — PRASAD TRANSPORT ERP on the shared AWS t3.large.
// Both app names are prefixed "prasad-" so they can never collide with the
// Jaiswal Capital processes already registered in the same PM2 daemon.
//
// Ports (verify they are free before first start: `sudo ss -tlnp | grep -E ':3100|:3200'`):
//   3200 — static SPA (built dist/, served by PM2's built-in static server, SPA fallback on)
//   3100 — AI bridge (bridge.cjs → token-gated proxy → Ollama on 127.0.0.1:11434)
//
// Nginx is the only public entry point; both ports bind behind it.

const APP_DIR = '/var/www/prasad-erp';

module.exports = {
  apps: [
    {
      // Static front-end. `script: 'serve'` is PM2's built-in static server —
      // no extra dependency. SPA mode: unknown paths fall back to index.html.
      name: 'prasad-erp-web',
      script: 'serve',
      cwd: APP_DIR,
      env: {
        PM2_SERVE_PATH: `${APP_DIR}/dist`,
        PM2_SERVE_PORT: 3200,
        PM2_SERVE_SPA: 'true',
        PM2_SERVE_HOMEPAGE: '/index.html',
      },
      max_memory_restart: '250M',
      time: true,
    },
    {
      // AI bridge — the ERP browser bundle calls https://prasadtransport.com/ai/*
      // which Nginx forwards here; the bridge relays /api/chat & /api/tags to the
      // local Ollama (OLLAMA_BASE_URL in .env) with X-PT-Token auth + streaming.
      name: 'prasad-ai-bridge',
      script: 'bridge.cjs',
      cwd: APP_DIR,
      env: { PORT: 3100 }, // wins over .env (dotenv never overrides existing env)
      max_memory_restart: '500M',
      time: true,
    },
    {
      // Agent/PostgreSQL API — Fastify + the 10-agent Mahavidya swarm.
      // ANTI-DOUBLE-LOAD MANDATE: this box (8GB) also runs the Jaiswal Capital
      // trading agents. V8's old-space is hard-capped at 2GB so a leak in the
      // ERP API can never squeeze the trading side; PM2 recycles the process
      // well before that at 1.2GB RSS.
      //
      // Needs on the box: RDS_PGHOST/RDS_PGPASSWORD (or DB_TARGET=aws + PG*)
      // in /var/www/prasad-erp/.env, plus PGSSL=true + PGSSL_CA_PATH.
      // Port 3300 stays loopback (API_HOST default) — Nginx proxies /api/.
      name: 'prasad-erp-api',
      script: 'server/index.js',
      cwd: APP_DIR,
      node_args: ['--max-old-space-size=2048'],
      env: {
        API_PORT: 3300,
        // 'local' MEANS "postgres on this machine", not "the office PC".
        //
        // This said 'aws', which was right on the shared t3.large where the
        // database lived in RDS and was reached over a tunnel. The dedicated box
        // provisioned on 20-08-2026 runs its own postgres on 127.0.0.1, so 'aws'
        // sends pool.js hunting for RDS_PGHOST — unset here — before falling
        // back. It would mostly have worked, after a failed connection and a
        // startup that reported the wrong topology, which is the kind of
        // half-truth that makes the next outage take an hour longer to read.
        DB_TARGET: 'local',
        NODE_ENV: 'production',
        // THE OTP LANE. otpChannel.js defaults to 127.0.0.1:5001; the engine
        // below listens on 5002. Nothing set this, so on AWS every driver OTP
        // would have been posted to a dead port and every driver login would
        // have failed with the engine sitting there healthy. Set HERE rather
        // than in .env because this block wins over dotenv, so the API and the
        // engine cannot drift apart on the one value they must agree on.
        WA_ENGINE_URL: 'http://127.0.0.1:5002',
        // The IOCL sync shells out to Python. Ubuntu 24.04+ ships no `python`,
        // and PEP 668 makes a system-wide pip install refuse, so the deploy
        // builds a venv and points here at it. Without this the cron spawns
        // ENOENT every fifteen minutes and the loading register quietly stops.
        PYTHON_BIN: APP_DIR + '/.venv/bin/python',
        // The AWS box has no GPU: local-AI lane parks OCR tasks durably until
        // the Local PC engine is reachable again (or set OCR_LANE=either +
        // AI_ALLOW_CLOUD_FALLBACK=1 to use the cloud engine while PC is off).
        AGENT_LOOPS: '1',
      },
      max_memory_restart: '1200M',
      time: true,
    },
    {
      // WhatsApp engine — OTP delivery and the CRM's send path.
      //
      // THE ACTIVE PATH as of 2026-08-20, by the owner's decision: engine and
      // ERP on ONE cloud server, so a driver can log in whether or not the
      // office PC is switched on.
      //
      // It used to be optional, and production reached the engine on the OFFICE
      // PC through a reverse SSH tunnel (WA_ENGINE_URL=127.0.0.1:5601, 5601 held
      // by sshd). That is now the fallback, not the default — and it is exactly
      // why the warning below is not theoretical.
      //
      // NEVER run both linked at once. Two engines authenticated to the same
      // WhatsApp number both auto-reply, and every driver gets each message
      // twice. Before scanning the QR here, STOP the office PC engine — a
      // WhatsApp account can hold several linked devices at once, so nothing
      // will refuse the second link and the duplication is silent.
      //
      // Port 5002 is kept even on a dedicated box where 5001 is free: 5001 on
      // the shared box belongs to the Jaiswal trading API
      // (/home/ubuntu/Algo-Engine/api.py), and one port meaning one thing across
      // both boxes is worth more than reclaiming a number.
      //
      // Binds loopback: the engine's API is unauthenticated unless
      // WA_ENGINE_TOKEN is set, so it must never face the internet.
      //
      // Puppeteer's Chromium is already in ~/.cache/puppeteer on this box, so
      // no browser install is needed. The engine boots to WAITING_FOR_SCAN and
      // stays there until somebody links a phone — deploying it does not, by
      // itself, connect a WhatsApp account.
      name: 'prasad-wa-engine',
      script: 'server.js',
      cwd: APP_DIR + '/whatsapp-server',
      env: {
        PORT: 5002,
        HOST: '127.0.0.1',
        NODE_ENV: 'production',
        WA_CLIENT_ID: 'prasad-aws',
      },
      max_memory_restart: '900M',
      time: true,
    },
  ],
};
