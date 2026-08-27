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

# RE-EXEC IF THIS SCRIPT IS PART OF WHAT JUST LANDED.
#
# bash does not read a script whole — it reads it lazily, by byte offset. The
# merge above can therefore rewrite THIS FILE underneath the interpreter, and
# everything after that point is read from the new bytes at the old offset:
# usually a half-line, which under `set -e` kills the run.
#
# The damage is not the failed run, it is the next one. The merge already
# happened, so --if-changed sees LOCAL == REMOTE and exits silently, and the
# build, the migration and the restart are simply never done. A deploy that
# half-happened and then reported nothing is exactly the "we shipped it and the
# system never updated" the rest of this file is being edited to stop.
#
# Re-exec deliberately drops --if-changed: the work still has to be done, and a
# fresh run would otherwise decide there was nothing to do. It cannot loop — by
# then LOCAL is REMOTE, so this diff is empty on the second pass.
if git diff --name-only "$LOCAL" "$REMOTE" | grep -q '^deploy/aws/ci-deploy\.sh$'; then
  echo "ci-deploy.sh itself changed -- restarting with the new version"
  exec bash "$APP_DIR/deploy/aws/ci-deploy.sh"
fi


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
# all'. Only the prasad-* apps (deploy/aws/ecosystem.prasad.config.cjs).
pm2 restart prasad-erp-api prasad-erp-web prasad-ai-bridge

# THE ENGINE IS RESTARTED ONLY WHEN ITS OWN CODE MOVED.
#
# prasad-wa-engine is in the ecosystem file but was missing from the line
# above, so whatsapp-server/ shipped to the box and then went on running the
# previous build — for as long as nobody restarted it by hand. Code that
# deploys and never runs is the worst of both: the repo says one thing and
# production does another, with nothing on screen to say so.
#
# It is NOT restarted unconditionally, because a restart re-launches Chromium
# and re-attaches the WhatsApp session — a minute during which no OTP and no
# password-reset code can be sent. That is worth paying when the engine
# changed and pure cost when it did not.
if git diff --name-only "$LOCAL" "$REMOTE" | grep -q "^whatsapp-server/"; then
  echo "whatsapp-server/ changed -> restarting prasad-wa-engine (OTP pauses ~1 min)"
  pm2 restart prasad-wa-engine
else
  echo "whatsapp-server/ unchanged -> leaving prasad-wa-engine alone"
fi

pm2 save

echo "=== deploy OK $(date -u) : now at $(git rev-parse --short HEAD) ==="
