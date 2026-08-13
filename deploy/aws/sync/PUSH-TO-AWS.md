# Push local PostgreSQL + new build to AWS

Everything below needs the SSH key `~/.ssh/jaiswal_claude_ed25519`, which is not
on this machine — so these four steps are yours to run. Everything that could be
prepared locally already has been:

| ready | what |
|---|---|
| `deploy/aws/sync/prasad_erp_YYYYMMDD.dump` | full local DB, custom format, 1.1 MB |
| `dist/` | rebuilt with `VITE_AGENT_API_URL=https://prasadtransport.com/api` |
| `deploy/aws/sync/nginx-api-block.conf` | the `/api/` route nginx is missing |

---

## 0. Open the tunnel (needed for step 2 only)

```bash
node scripts/sync-tunnel.cjs
# expects ubuntu@api.jaiswalcapital.com and ~/.ssh/jaiswal_claude_ed25519
# verify: node scripts/sync-tunnel.cjs --status   → TUNNEL UP on :15432
```

## 1. Ship the build

```bash
scp -r dist/* ubuntu@api.jaiswalcapital.com:/var/www/prasad-erp/dist/
```

## 2. Restore the database

The dump carries migrations 001–016 **and** the reconciled data — 489 trips,
33 payment advices, the chart of accounts, and every voucher. Restoring over a
populated AWS database will conflict; `--clean` drops the objects it replaces,
so take a backup on the far side first.

```bash
# on AWS, back up whatever is there now
pg_dump -U prasad_app -d prasad_erp -Fc -f ~/prasad_erp_before_sync.dump

# from here, through the tunnel
pg_restore -h 127.0.0.1 -p 15432 -U prasad_app -d prasad_erp \
  --clean --if-exists --no-owner --no-privileges \
  deploy/aws/sync/prasad_erp_20260812.dump
```

⚠ **Never point this at `prasad_transport_db`** — that is a different database on
the same host and is not ours to touch.

## 3. Give nginx an `/api/` route

This is the step that makes the new dashboard work at all. Right now
`https://prasadtransport.com/api/v1/finance/dashboard` returns **HTTP 200 with
`Content-Type: text/html`** — nginx has no `/api/` block, so the request falls
through to the SPA and is answered with `index.html`. The browser gets a web
page where it expects JSON. The 200 makes it look healthy, which is why it went
unnoticed.

```bash
sudo nano /etc/nginx/sites-available/prasadtransport.com
#   paste the block from deploy/aws/sync/nginx-api-block.conf
#   ABOVE the existing `location / { ... }`  — nginx picks the longest
#   matching prefix, so order matters less than the block simply existing
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Start the API

`prasad-erp-api` is defined in `ecosystem.prasad.config.cjs` but nothing was
routing to it, so it may never have been started.

```bash
cd /var/www/prasad-erp
pm2 start deploy/aws/ecosystem.prasad.config.cjs --only prasad-erp-api
pm2 save
pm2 logs prasad-erp-api --lines 20      # expect: connected → local · prasad_erp
```

The API needs its own `.env` on AWS with `PGPASSWORD` etc. Confirm before
starting: a degraded API answers 503 and the dashboard will say so plainly
rather than showing zeros.

---

## Verify (all four must pass)

```bash
# real JSON, not the SPA fallback
curl -s https://prasadtransport.com/api/v1/finance/health/accounting | head -c 120
#   → {"ok":true,"failures":[],...}      NOT <!doctype html>

curl -s https://prasadtransport.com/api/v1/finance/dashboard \
  | python -c "import sys,json;d=json.load(sys.stdin);print(d['source'],d['kpi']['cash_and_bank'])"
#   → postgres 17497990.38

curl -s https://prasadtransport.com/ | grep -o '/assets/index-[^\"]*\.js'
#   → must differ from index-Buo9fPg3.js (the old deployed bundle)
```

Then open the site. If it still shows ₹8.39 L, it is the installed PWA serving
its cache: **Ctrl+Shift+R**, or F12 → Application → Service Workers → Unregister.
The build is `registerType: autoUpdate`, so once it fetches the new `sw.js` it
keeps itself current.

---

## What "done" looks like

| KPI | before | after |
|---|---|---|
| Revenue | ₹8.39 L | ₹1.53 Cr |
| Expenses | ₹18.30 L | ₹63.50 L |
| Cash & Bank | — | **₹1.75 Cr** |

`SBI (8490)` = ₹1,74,97,990.38
