#!/usr/bin/env bash
# deploy/aws/provision-prasad-box.sh
#
# Bring up a DEDICATED Prasad Transport box from a bare Ubuntu 24.04 EC2
# instance. Run it ON the new box as the `ubuntu` user.
#
#   bash provision-prasad-box.sh
#
# Idempotent: every step checks before it acts, so re-running after a failure
# resumes rather than duplicates.
#
# WHAT THIS DELIBERATELY DOES NOT DO
#
#   It does not move the database. prasad_erp lives on the old shared box and
#   is 79 MB / 874 trips / 5,595 ledger entries. Copying it is a separate,
#   deliberate step (see restore-db below) because the ledger is append-only
#   and running two writable copies of it -- new box and old box both live --
#   is how you get the same voucher under two different UUIDs. That has already
#   happened once on this project. One copy is authoritative; the other must be
#   shut off, not left running.
#
#   It does not touch DNS. www.prasadtransport.com is behind Cloudflare, so the
#   cutover is an origin A-record edit, done once the new box serves correctly.
set -euo pipefail

APP_DIR=/var/www/prasad-erp
REPO=https://github.com/mamta-ai/PRASAD-TRANSPORT-ERP.git   # adjust if the remote differs
BRANCH=main

say() { printf '\n=== %s\n' "$1"; }

say "1/8 system packages"
sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  git curl ca-certificates nginx postgresql postgresql-contrib ufw

say "2/8 node 20 + pm2"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
command -v pm2 >/dev/null 2>&1 || sudo npm install -g pm2 serve
node -v; pm2 -v

say "3/8 chrome libraries for the WhatsApp engine"
# Puppeteer ships its own Chromium but not these 8 leaf libs. Without them
# Chrome exits 127 and the engine can never link.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  libxdamage1 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libatspi2.0-0t64 libcairo2 libcups2t64 libpango-1.0-0

say "4/8 code"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER":"$USER" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin "$BRANCH" --quiet
  git -C "$APP_DIR" checkout "$BRANCH" --quiet
  git -C "$APP_DIR" merge --ff-only "origin/$BRANCH" --quiet
else
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install --no-audit --no-fund
( cd whatsapp-server && npm install --no-audit --no-fund )

say "5/8 env files"
# .env      -> front-end build vars (VITE_*) and shared config
# .env.api  -> database credentials, read by server/index.js via --env-file
for f in .env .env.api; do
  [ -f "$f" ] || { touch "$f"; chmod 600 "$f"; echo "  created empty $f"; }
done
cat <<'NOTE'
  Fill these in before continuing (values are NOT in git):
    .env      VITE_GOOGLE_MAPS_API_KEY=   GOOGLE_MAPS_SERVER_KEY=
    .env.api  PGHOST=127.0.0.1  PGUSER=  PGPASSWORD=  PGDATABASE=prasad_erp
              DB_TARGET=local
NOTE

say "6/8 database (empty schema only -- data restore is a separate step)"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='prasad_erp'" | grep -q 1 \
  || sudo -u postgres createdb prasad_erp
echo "  to restore the real data, from the OLD box:"
echo "    sudo -u postgres pg_dump -Fc prasad_erp > /tmp/prasad_erp.dump"
echo "  then on THIS box:"
echo "    sudo -u postgres pg_restore -d prasad_erp --clean --if-exists /tmp/prasad_erp.dump"
echo "  and only then stop the old box's API, so one copy is ever writable."

say "7/8 build + migrate + pm2"
npm run build
node --env-file=.env.api server/db/migrate.js
pm2 start deploy/aws/ecosystem.prasad.config.cjs
pm2 save
sudo env PATH="$PATH" pm2 startup systemd -u "$USER" --hp "$HOME" | tail -1 | sudo bash || true

say "8/8 nginx + firewall"
sudo cp deploy/aws/nginx-prasadtransport.conf /etc/nginx/sites-available/prasadtransport
sudo ln -sf /etc/nginx/sites-available/prasadtransport /etc/nginx/sites-enabled/prasadtransport
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp
sudo ufw --force enable

say "deploy cron (pull-based, every 3 min -- no secrets held off-box)"
( crontab -l 2>/dev/null | grep -v ci-deploy.sh; \
  echo "*/3 * * * * bash $APP_DIR/deploy/aws/ci-deploy.sh --if-changed >> /tmp/ci-deploy-cron.log 2>&1" ) | crontab -

say "done"
pm2 list
echo
echo "Verify BEFORE moving DNS:"
echo "  curl -s localhost:3200 >/dev/null && echo 'SPA ok'"
echo "  curl -s localhost:3300/api/v1/auth/health"
echo "Then point the Cloudflare A record for www.prasadtransport.com at this box."
