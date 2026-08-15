#!/usr/bin/env bash
# deploy/aws/ci-deploy.sh — the ONE deploy procedure for the AWS box.
#
# Called two ways, same steps either way:
#   cron (every 3 min):   ci-deploy.sh --if-changed    pull-based auto-deploy;
#                         exits quietly while origin/main == HEAD, so a push
#                         to main lands on the box within ~3 minutes with NO
#                         GitHub-held SSH secrets.
#   GitHub Actions:       ci-deploy.sh                 runner-triggered deploy
#                         (works only once AWS_HOST/AWS_PRIVATE_KEY secrets
#                         exist — the pull lane above needs neither).
#
# Every run logs to /tmp/ci-deploy.log; flock guarantees two triggers can
# never deploy on top of each other (the same race the workflow's concurrency
# group guards on the Actions side).
set -euo pipefail

APP_DIR=/var/www/prasad-erp
LOCK=/tmp/prasad-deploy.lock
LOG=/tmp/ci-deploy.log

exec 9>"$LOCK"
flock -n 9 || { echo "another deploy is running — skipped"; exit 0; }

cd "$APP_DIR"
git fetch origin main --quiet
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [ "${1:-}" = "--if-changed" ] && [ "$LOCAL" = "$REMOTE" ]; then
  exit 0   # nothing new — stay silent so the cron log is signal, not noise
fi

exec > >(tee "$LOG") 2>&1
echo "=== deploy start $(date -u) : ${LOCAL:0:7} -> ${REMOTE:0:7} ==="

# ff-only: the box never invents history; a diverged main is a human problem.
git merge --ff-only origin/main

# Full install (Vite is a devDependency and the SPA is served from dist/);
# Playwright browsers are never needed on the box.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install --no-audit --no-fund

npm run build

# Schema before the API that expects it. PG credentials live in .env.api
# (NOT .env). A migration failure aborts here — old API keeps running
# against the old schema.
node --env-file=.env.api server/db/migrate.js

# ⚠️ Shared box with the Jaiswal Capital trading engine — NEVER 'pm2 restart
# all'. Only the three prasad-* apps (deploy/aws/ecosystem.prasad.config.cjs).
pm2 restart prasad-erp-api prasad-erp-web prasad-ai-bridge
pm2 save

echo "=== deploy OK $(date -u) : now at $(git rev-parse --short HEAD) ==="
