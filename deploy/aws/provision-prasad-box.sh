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

say "0/8 swap"
# NOT OPTIONAL ON A SMALL BOX, AND THE FAILURES ARE ALL SILENT-ISH.
#
# The 20-08-2026 target is a t3.small: 2 GB. On it these run together —
# Chromium under the WhatsApp engine (~700 MB alone), PostgreSQL, the Fastify
# API and the static server. `vite build` in step 7 also peaks near a gigabyte
# on its own, so a swapless 2 GB box can die during PROVISIONING and leave a
# half-built tree that looks installed.
#
# Linux does not slow down when it runs out, it kills: the OOM killer takes the
# largest RSS, which is Chromium, so the engine vanishes and driver OTP stops
# with the API still reporting healthy. Swap turns that cliff into a slope.
#
# Sized from RAM, capped at 4 G. Idempotent: an existing swapfile is left alone.
if [ -z "$(swapon --show --noheadings 2>/dev/null)" ]; then
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
  if   [ "$mem_mb" -le 2600 ]; then swap_g=4
  elif [ "$mem_mb" -le 5000 ]; then swap_g=2
  else swap_g=0; fi
  if [ "$swap_g" -gt 0 ]; then
    echo "RAM ${mem_mb}MB -> creating ${swap_g}G swapfile"
    sudo fallocate -l "${swap_g}G" /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=$((swap_g*1024))
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    # Default 60 evicts app pages too eagerly on a box this size; 10 keeps swap
    # as the safety net it is meant to be rather than a first resort.
    sudo sysctl -w vm.swappiness=10 >/dev/null
    grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf >/dev/null
  else
    echo "RAM ${mem_mb}MB -> swap not required"
  fi
else
  echo "swap already present:"; swapon --show
fi
free -h | head -3

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
# Puppeteer ships its own Chromium but not these leaf libs. Without them Chrome
# exits 127 and the engine can never link -- it cycles RECONNECTING forever while
# the API reports the OTP channel down and every driver login fails.
#
# The first eight sufficed on Ubuntu 24.04. On 26.04 (20-08-2026) Chrome still
# died on libXcomposite, libXfixes, libXrandr and libgbm. A hardcoded list rots
# every time the base image moves, so the check before step 7 asks the binary
# instead of trusting this line.
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  libxdamage1 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libatspi2.0-0t64 libcairo2 libcups2t64 libpango-1.0-0 \
  libxcomposite1 libxfixes3 libxrandr2 libgbm1

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

say "chrome sanity check"
# AFTER npm install has pulled Puppeteer's Chromium. Better to stop here with a
# clear message than hand over a box whose OTP lane is dead and whose API says
# only "engine RECONNECTING".
CHROME="$(ls -d "$HOME"/.cache/puppeteer/chrome/*/chrome-linux64/chrome 2>/dev/null | head -1 || true)"
if [ -n "$CHROME" ]; then
  MISSING="$(ldd "$CHROME" 2>/dev/null | awk '/not found/ {print $1}' | sort -u | tr '
' ' ')"
  if [ -n "$MISSING" ]; then
    echo "  Chrome cannot start, missing: $MISSING"
    echo "  apt-get install the providers and re-run -- the engine cannot link without Chrome."
    exit 1
  fi
  echo "  chrome: all shared libraries resolved"
else
  echo "  chrome not downloaded yet (whatsapp-server npm install pulls it)"
fi

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
# `timeout 1800` IS LOAD-BEARING, NOT TIDINESS.
#
# ci-deploy.sh takes an flock so two triggers cannot deploy on top of each
# other, and gives up immediately when it cannot get it. That is right for a
# deploy that is genuinely running and catastrophic for one that has HUNG: the
# holder never exits, every later cron pass prints "another deploy is running --
# skipped" into a log nobody reads, and the box serves the old build for ever.
#
# Exactly that happened on 27-08-2026. A deploy died inside the version of this
# script that still rewrote itself under bash, hung holding the lock, and four
# hours of releases -- an API lockdown among them -- never reached the box while
# every push reported success.
#
# A dead process releases an flock by itself; only a live, wedged one holds it.
# So the deploy is bounded instead: thirty minutes is far longer than a real run
# (npm install, build, migrate, restart) and far shorter than a working day.
( crontab -l 2>/dev/null | grep -v ci-deploy.sh; \
  echo "*/3 * * * * timeout 1800 bash $APP_DIR/deploy/aws/ci-deploy.sh --if-changed >> /tmp/ci-deploy-cron.log 2>&1" ) | crontab -

say "done"
pm2 list
echo
echo "Verify BEFORE moving DNS:"
echo "  curl -s localhost:3200 >/dev/null && echo 'SPA ok'"
echo "  curl -s localhost:3300/api/v1/auth/health"
echo "Then point the Cloudflare A record for www.prasadtransport.com at this box."
