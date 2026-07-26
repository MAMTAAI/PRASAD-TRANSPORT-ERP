# PRASAD TRANSPORT ERP — AWS Dual-Hosting Runbook

Deploys the ERP onto the existing t3.large **alongside** Jaiswal Capital with
zero downtime for the trading engine. Architecture on the box after this:

```
Internet
  │
  ├─ jaiswalcapital.com ──► Nginx ──► trading engine (existing PM2 app, UNTOUCHED)
  │
  └─ prasadtransport.com ─► Nginx ─┬─ /      ► :3200 prasad-erp-web   (PM2 static SPA)
                                   └─ /ai/*  ► :3100 prasad-ai-bridge (PM2, bridge.cjs)
                                                         │
                                                         ▼
                                              :11434 Ollama (shared brain,
                                              also used by Jaiswal Capital)
```

**Why the browser never sees `localhost:11434`:** the SPA runs in the
*visitor's* browser — `localhost` there is the visitor's own machine. The
shared-Gemma routing happens **server-side**: the built bundle calls
`https://prasadtransport.com/ai/*`, Nginx hands it to the bridge, and the
bridge talks to Ollama on `127.0.0.1:11434`.

---

## 0. Pre-flight (on the AWS box — read-only, changes nothing)

```bash
pm2 list                                   # note Jaiswal Capital app names/ports
sudo ss -tlnp | grep -E ':3100|:3200'      # MUST print nothing (ports free)
sudo ss -tlnp | grep nginx                 # nginx running
grep -r proxy_pass /etc/nginx/sites-enabled/ /etc/nginx/conf.d/ 2>/dev/null
                                           # confirm which ports Jaiswal uses —
                                           # if 3100/3200 clash, edit the ecosystem
                                           # file + nginx conf to free ports
free -h                                    # RAM headroom check
ollama list                                # confirm Ollama + which models exist
node -v                                    # need Node 20+
```

**RAM reality check:** a t3.large has 8 GB and no GPU. `gemma4:12b` needs more
than the whole box — run `gemma4:e4b` (or another ≤4B model) on AWS, or keep
the front-end pointed at the RTX 3060 tunnel (`https://ollama.prasadtransport.com`)
for 12b quality. If not already present:

```bash
ollama pull gemma4:e4b
# recommended on 8GB shared box — add swap if none exists (swapon --show):
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 1. Get the code

```bash
sudo mkdir -p /var/www && sudo chown "$USER" /var/www
cd /var/www
git clone https://github.com/MAMTAAI/PRASAD-TRANSPORT-ERP.git prasad-erp
cd prasad-erp
git checkout upgrade-2026        # or main once the branch is merged
npm ci                           # full install (vite is a devDependency, needed for build)
```

## 2. Secrets (from the Windows PC — scp, never git)

```powershell
# run on the Windows PC:
scp E:\PRASAD-TRANSPORT-ERP\google-key.json  user@AWS_IP:/var/www/prasad-erp/
```

On the server, create `/var/www/prasad-erp/.env` from
`deploy/aws/env.aws.example` and fill in the real tokens/keys, and create
`/var/www/prasad-erp/.env.production.local` with the build-time block from the
same example file (`VITE_LLM_BASE_URL=https://prasadtransport.com/ai`, etc.).

```bash
chmod 600 /var/www/prasad-erp/.env /var/www/prasad-erp/.env.production.local /var/www/prasad-erp/google-key.json
```

## 3. Build

```bash
cd /var/www/prasad-erp
npm run build                    # emits dist/  (Vite auto-loads .env.production.local)
```

## 4. Start under PM2 (isolated names, isolated ports)

```bash
pm2 start deploy/aws/ecosystem.prasad.config.cjs
pm2 list                         # jaiswal apps still "online" + 2 new prasad-* apps
pm2 save                         # persist across reboots (pm2 startup already set up)
curl -s http://127.0.0.1:3100/api/ai/health   # {"ok":true,...} bridge → ollama
curl -sI http://127.0.0.1:3200/ | head -1     # HTTP/1.1 200
```

## 5. Nginx vhost (additive — Jaiswal block untouched)

```bash
# Ubuntu/Debian:
sudo cp deploy/aws/nginx-prasadtransport.conf /etc/nginx/sites-available/prasadtransport.com
sudo ln -s /etc/nginx/sites-available/prasadtransport.com /etc/nginx/sites-enabled/
# Amazon Linux instead:
#   sudo cp deploy/aws/nginx-prasadtransport.conf /etc/nginx/conf.d/prasadtransport.conf

sudo nginx -t                    # MUST say "syntax is ok / test is successful"
sudo systemctl reload nginx      # graceful reload — zero downtime; NEVER 'restart'
```

If `nginx -t` fails, nothing has been applied — the trading engine is
unaffected. Fix the conf and re-test.

## 6. DNS + TLS

1. Cloudflare dashboard → DNS → `prasadtransport.com` and `www`: **A record →
   the AWS Elastic IP**. (`ollama.prasadtransport.com` tunnel record stays as-is.)
2. TLS on the origin:
   ```bash
   sudo certbot --nginx -d prasadtransport.com -d www.prasadtransport.com
   sudo nginx -t && sudo systemctl reload nginx
   ```
3. If the records are orange-clouded, set Cloudflare SSL/TLS mode to
   **Full (strict)**.

## 7. Verify end-to-end

```bash
curl -s https://prasadtransport.com/ai/api/ai/health          # bridge health via nginx
curl -s https://prasadtransport.com/ai/api/tags \
     -H "X-PT-Token: <prasad-token>"                          # model list via full chain
curl -sI https://jaiswalcapital.com | head -1                 # trading engine still 200
```

Then open https://prasadtransport.com → login → MAMTA Chat → send a message
(Local AI engine) and confirm streamed tokens.

## Rollback (also zero-downtime)

```bash
sudo rm /etc/nginx/sites-enabled/prasadtransport.com   # or the conf.d file
sudo nginx -t && sudo systemctl reload nginx           # domain detaches, jaiswal untouched
pm2 delete prasad-erp-web prasad-ai-bridge && pm2 save
```

## Updating to a new version later

```bash
cd /var/www/prasad-erp
git pull
npm ci && npm run build          # SPA: no process restart needed (static files swap)
pm2 restart prasad-ai-bridge     # only if bridge.cjs itself changed
```
