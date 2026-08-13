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
        DB_TARGET: 'aws',
        NODE_ENV: 'production',
        // The AWS box has no GPU: local-AI lane parks OCR tasks durably until
        // the Local PC engine is reachable again (or set OCR_LANE=either +
        // AI_ALLOW_CLOUD_FALLBACK=1 to use the cloud engine while PC is off).
        AGENT_LOOPS: '1',
      },
      max_memory_restart: '1200M',
      time: true,
    },
  ],
};
