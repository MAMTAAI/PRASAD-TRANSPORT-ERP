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
  ],
};
