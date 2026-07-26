#!/usr/bin/env bash
# ============================================================================
# weekly-backup.sh — Sunday server backup + strict 4-week retention
# (God/Subhash directive 2026-07-26)
#
# Backs up the SMALL, CRITICAL server state (Prasad ERP + AI bridge + certs)
# to /home/ubuntu/backups/weekly/ and mirrors to Google Drive via rclone.
#
# Retention policy, applied to BOTH destinations:
#   - delete backup archives older than RETENTION_DAYS (30)
#   - locally, ALWAYS keep the newest KEEP_MIN (4) regardless of age, so a
#     paused cron can never delete the last good backups
#
# NOTE: this deliberately does NOT touch Algo-Engine/Mamta_AI_Database/Archive
# — those files are the ONLY copy of >90-day market history (moved there by
# archive_manager.py, not copied). Age-deleting them = permanent data loss.
#
# Cron (IST): 30 2 * * 0  /home/ubuntu/weekly-backup.sh >> /home/ubuntu/backups/weekly/backup.log 2>&1
# ============================================================================
set -euo pipefail

BACKUP_DIR=/home/ubuntu/backups/weekly
GDRIVE_REMOTE=gdrive
GDRIVE_PATH=JaiswalCapital/ServerBackups/weekly
RETENTION_DAYS=30
KEEP_MIN=4
STAMP=$(date +%Y%m%d-%H%M)

mkdir -p "$BACKUP_DIR"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
echo "=== $(date '+%F %T') weekly backup starting ==="

# ── Collect: Prasad ERP + AI bridge state ───────────────────────────────────
mkdir -p "$WORK/prasad"
if command -v sqlite3 >/dev/null 2>&1 && [ -f /var/www/prasad-erp/data/mamta-kg.db ]; then
  sqlite3 /var/www/prasad-erp/data/mamta-kg.db ".backup '$WORK/prasad/mamta-kg.db'"   # online-safe snapshot
else
  cp /var/www/prasad-erp/data/mamta-kg.db* "$WORK/prasad/" 2>/dev/null || true
fi
cp /var/www/prasad-erp/.env                     "$WORK/prasad/env"                  2>/dev/null || true
cp /var/www/prasad-erp/.env.production.local    "$WORK/prasad/env.production.local" 2>/dev/null || true
cp /etc/nginx/sites-available/prasadtransport.com "$WORK/prasad/nginx-prasadtransport.conf" 2>/dev/null || true
cp /home/ubuntu/.pm2/dump.pm2                   "$WORK/prasad/pm2-dump.pm2"         2>/dev/null || true
sudo tar czf "$WORK/prasad/letsencrypt.tar.gz" -C /etc letsencrypt 2>/dev/null || true

OUT="$BACKUP_DIR/server-weekly-$STAMP.tar.gz"
tar czf "$OUT" -C "$WORK" .
echo "[backup] wrote $OUT ($(du -h "$OUT" | cut -f1))"

# ── Local retention: older than RETENTION_DAYS AND not in the newest KEEP_MIN ──
mapfile -t ALL < <(ls -1t "$BACKUP_DIR"/server-weekly-*.tar.gz 2>/dev/null)
for i in "${!ALL[@]}"; do
  f="${ALL[$i]}"
  if [ "$i" -ge "$KEEP_MIN" ] && [ -n "$(find "$f" -mtime +"$RETENTION_DAYS" -print 2>/dev/null)" ]; then
    echo "[retention] deleting local $(basename "$f")"
    rm -f "$f"
  fi
done
echo "[retention] local backups now: $(ls -1 "$BACKUP_DIR"/server-weekly-*.tar.gz 2>/dev/null | wc -l)"

# ── Google Drive mirror + prune (skips gracefully while the remote is broken) ──
if rclone lsd "$GDRIVE_REMOTE:" >/dev/null 2>&1; then
  rclone copy "$OUT" "$GDRIVE_REMOTE:$GDRIVE_PATH" --quiet
  rclone delete "$GDRIVE_REMOTE:$GDRIVE_PATH" --min-age "${RETENTION_DAYS}d" --quiet || true
  echo "[gdrive] mirrored $(basename "$OUT") + pruned archives older than ${RETENTION_DAYS}d"
else
  echo "[gdrive] WARNING: remote '$GDRIVE_REMOTE:' unreachable — upload & prune SKIPPED. Fix with: rclone config reconnect $GDRIVE_REMOTE: (or recreate the OAuth client)"
fi
echo "=== $(date '+%F %T') weekly backup done ==="
