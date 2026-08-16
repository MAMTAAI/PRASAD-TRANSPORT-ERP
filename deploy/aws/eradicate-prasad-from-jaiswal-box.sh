#!/usr/bin/env bash
# eradicate-prasad-from-jaiswal-box.sh
#
# Removes every trace of Prasad Transport from 13.127.25.123, leaving that box
# 100% Jaiswal Capital. Run it ON the box.
#
#     bash eradicate-prasad-from-jaiswal-box.sh              # dry run
#     bash eradicate-prasad-from-jaiswal-box.sh --execute    # asks for a typed phrase
#
# ############################################################################
# DO NOT RUN THIS UNTIL www.prasadtransport.com IS SERVING FROM THE NEW BOX.
#
# This drops the production database. 874 trips, 5,595 ledger entries,
# Dr = Cr = 133,862,674.30. There is no undo. As of 2026-08-16 the dedicated
# Prasad EC2 instance did not exist -- the Prasad AWS account (7341-4385-0337)
# was still completing payment verification, and 13.127.25.123 belongs to the
# Jaiswal Capital account (8227-2596-3166). Running this before the new box is
# live takes the ERP down with nowhere to fail over to.
#
# The preflight below enforces that: it refuses unless NEW_PRASAD_HOST is set
# AND that host answers healthy AND its database reports the same row counts.
# ############################################################################
set -euo pipefail

EXECUTE=0
[ "${1:-}" = "--execute" ] && EXECUTE=1

say() { printf '\n=== %s\n' "$1"; }
BASELINE_TRIPS=874
BASELINE_LEDGER=5595

say "PREFLIGHT -- the new box must already be serving"

if [ -z "${NEW_PRASAD_HOST:-}" ]; then
  echo "  REFUSED: NEW_PRASAD_HOST is not set."
  echo "  Set it to the new Prasad box and re-run, e.g.:"
  echo "      NEW_PRASAD_HOST=1.2.3.4 bash $0 --execute"
  exit 1
fi
echo "  new host: $NEW_PRASAD_HOST"

if ! curl -fsS -m 10 "http://$NEW_PRASAD_HOST:3300/api/v1/auth/health" >/dev/null 2>&1; then
  echo "  REFUSED: $NEW_PRASAD_HOST is not answering /api/v1/auth/health."
  exit 1
fi
echo "  new box API: healthy"

NEW_TRIPS=$(ssh -o BatchMode=yes "ubuntu@$NEW_PRASAD_HOST" "sudo -u postgres psql -d prasad_erp -tAc 'SELECT count(*) FROM trips'" 2>/dev/null || echo 0)
NEW_LEDGER=$(ssh -o BatchMode=yes "ubuntu@$NEW_PRASAD_HOST" "sudo -u postgres psql -d prasad_erp -tAc 'SELECT count(*) FROM ledger_entries'" 2>/dev/null || echo 0)
echo "  new box data: $NEW_TRIPS trips / $NEW_LEDGER ledger entries (need >= $BASELINE_TRIPS / $BASELINE_LEDGER)"
if [ "$NEW_TRIPS" -lt "$BASELINE_TRIPS" ] || [ "$NEW_LEDGER" -lt "$BASELINE_LEDGER" ]; then
  echo "  REFUSED: the new box does not hold the full dataset."
  exit 1
fi

# Balanced books on the new side, or the restore lost a leg.
NEW_BAL=$(ssh -o BatchMode=yes "ubuntu@$NEW_PRASAD_HOST" "sudo -u postgres psql -d prasad_erp -tAc \"SELECT CASE WHEN sum(CASE WHEN dr_cr='DR' THEN amount ELSE 0 END) = sum(CASE WHEN dr_cr='CR' THEN amount ELSE 0 END) THEN 'BALANCED' ELSE 'IMBALANCED' END FROM ledger_entries\"" 2>/dev/null || echo UNKNOWN)
echo "  new box books: $NEW_BAL"
[ "$NEW_BAL" = "BALANCED" ] || { echo "  REFUSED: books do not balance on the new box."; exit 1; }

if ! curl -fsS -m 10 -o /dev/null "https://www.prasadtransport.com/"; then
  echo "  WARNING: the public domain is not answering. Check DNS before proceeding."
fi

say "WHAT WILL BE REMOVED FROM THIS BOX"
cat <<PLAN
  pm2   : prasad-erp-api, prasad-erp-web, prasad-ai-bridge, prasad-wa-engine
          (delete + pm2 save; the jaiswal-* apps are never touched)
  files : /var/www/prasad-erp                      (~1.1 GB)
          /home/ubuntu/backups/weekly/*prasad*
  db    : DROP DATABASE prasad_erp                 (80 MB)
          DROP DATABASE prasad_transport_db        (8.4 MB)
          DROP ROLE prasad_app
  nginx : /etc/nginx/sites-enabled/prasadtransport.com  (unlink, keep available)
  certs : /etc/letsencrypt/live/www.prasadtransport.com (certbot delete)
  cron  : the ci-deploy.sh entry for /var/www/prasad-erp

  UNTOUCHED: jaiswal_capital_db (17 GB), every jaiswal-* pm2 app,
             api.jaiswalcapital.com + jaiswalcapital.com nginx sites and certs.
PLAN

if [ "$EXECUTE" -ne 1 ]; then
  say "DRY RUN -- nothing was changed. Re-run with --execute."
  exit 0
fi

say "FINAL CONFIRMATION"
echo "This drops prasad_erp permanently on this box."
echo "Type exactly:  ERADICATE PRASAD"
read -r ANSWER
[ "$ANSWER" = "ERADICATE PRASAD" ] || { echo "aborted."; exit 1; }

# One last local dump, kept on the box, in case the new side is wrong in a way
# the preflight could not see.
say "final safety dump"
STAMP=$(date +%Y%m%d-%H%M%S)
FINAL=/home/ubuntu/prasad_erp-FINAL-BEFORE-DROP-$STAMP.dump
sudo -u postgres pg_dump -Fc -d prasad_erp -f /tmp/final.dump
sudo mv /tmp/final.dump "$FINAL"; sudo chown ubuntu:ubuntu "$FINAL"
echo "  $FINAL ($(du -h "$FINAL" | cut -f1))"

say "pm2"
for app in prasad-erp-api prasad-erp-web prasad-ai-bridge prasad-wa-engine; do
  pm2 delete "$app" >/dev/null 2>&1 && echo "  deleted $app" || echo "  $app not present"
done
pm2 save

say "nginx"
sudo rm -f /etc/nginx/sites-enabled/prasadtransport.com
sudo nginx -t && sudo systemctl reload nginx && echo "  prasadtransport.com unlinked, nginx reloaded"

say "cron"
( crontab -l 2>/dev/null | grep -v 'prasad-erp' ) | crontab -
echo "  prasad deploy cron removed"

say "databases"
sudo -u postgres psql -c "DROP DATABASE IF EXISTS prasad_erp;"
sudo -u postgres psql -c "DROP DATABASE IF EXISTS prasad_transport_db;"
sudo -u postgres psql -c "DROP ROLE IF EXISTS prasad_app;"
echo "  dropped"

say "files"
sudo rm -rf /var/www/prasad-erp
rm -f /home/ubuntu/backups/weekly/*prasad* 2>/dev/null || true
echo "  removed (the safety dump above is deliberately kept)"

say "certificates"
sudo certbot delete --cert-name www.prasadtransport.com --non-interactive 2>/dev/null \
  && echo "  cert deleted" || echo "  cert not found or certbot unavailable"

say "VERIFY -- this box should now be Jaiswal only"
echo "--- pm2"; pm2 list | grep -ci prasad | sed 's/^/    prasad apps remaining: /'
echo "--- databases"; sudo -u postgres psql -tAc "SELECT datname FROM pg_database WHERE datname LIKE '%prasad%'" | sed 's/^/    /'
echo "--- files"; ls -d /var/www/prasad-erp 2>/dev/null || echo "    /var/www/prasad-erp: gone"
echo "--- nginx"; ls /etc/nginx/sites-enabled/ | sed 's/^/    /'
say "done -- jaiswal_capital_db and all jaiswal-* services untouched"
