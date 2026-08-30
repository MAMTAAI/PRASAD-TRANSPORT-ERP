#!/usr/bin/env bash
# scripts/backup-aws-to-local.sh
# ─────────────────────────────────────────────────────────────────────────────
# ONE-WAY backup: AWS production  →  Local PC.  NEVER the other direction.
#
# Production (the AWS box, DB_TARGET=local on the box's own Postgres) is the ONE
# writer — that was settled at the 2026-08-24 cutover, and ERP_API.KILL keeps the
# office box from ever booting the API again. This script does NOT revive the
# two-way sync that caused the split-brain. It pulls a COPY down so the office
# has a local backup of the books and every document:
#
#   * the whole document/PDF vault  (both upload roots), and
#   * a compressed pg_dump of prasad_erp  (a file, not a live restore — so it
#     needs no local Postgres running and cannot be written back by accident).
#
# Nothing here writes to AWS. Reviving write-back is a separate, explicit owner
# decision (see sync-from-aws.mjs / PUSH-TO-AWS.md), not this job.
#
# Schedule it from Windows Task Scheduler:
#   "C:\Program Files\Git\bin\bash.exe" -lc "/f/Prasad_Transport_System/PRASAD-TRANSPORT-ERP/scripts/backup-aws-to-local.sh"
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

BOX=ubuntu@65.0.27.161
KEY="$HOME/.ssh/prasad-key.pem"
DEST_ROOT="/f/Prasad_Transport_System/ERP-LOCAL-BACKUP"
KEEP_DAYS=30
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$DEST_ROOT/$STAMP"
SSH="ssh -i $KEY -o ConnectTimeout=15"

mkdir -p "$DEST/uploads/var-www" "$DEST/uploads/var-lib" "$DEST/db" || exit 1
echo "[backup] $STAMP → $DEST"

# ── 1. Documents / PDFs (both roots; one-way copy) ──────────────────────────
echo "[backup] pulling document vault…"
scp -i "$KEY" -r -q "$BOX:/var/www/prasad-erp/uploads/." "$DEST/uploads/var-www/" \
  && echo "[backup]   var-www: $(find "$DEST/uploads/var-www" -type f | wc -l) files"
scp -i "$KEY" -r -q "$BOX:/var/lib/prasad/uploads/."      "$DEST/uploads/var-lib/" \
  && echo "[backup]   var-lib: $(find "$DEST/uploads/var-lib" -type f | wc -l) files"

# ── 2. Database dump (compressed, on the box, then pulled) ──────────────────
# The dump runs on the box with the app's own credentials from .env.api, so no
# password is ever passed on a command line or stored here. -Fc is the custom
# format: restorable with pg_restore, and far smaller than plain SQL.
echo "[backup] dumping prasad_erp on the box…"
REMOTE_DUMP="/tmp/prasad_erp_${STAMP}.dump"
$SSH "$BOX" bash -s <<REMOTE
  set -e
  cd /var/www/prasad-erp
  g() { grep -E "^\$1=" .env.api | head -1 | cut -d= -f2- | tr -d '"'"'"'"'"'; }
  export PGPASSWORD="\$(g PGPASSWORD)"
  pg_dump -h "\$(g PGHOST || echo 127.0.0.1)" -p "\$(g PGPORT || echo 5432)" \
          -U "\$(g PGUSER)" -d "\$(g PGDATABASE || echo prasad_erp)" \
          -Fc -f "$REMOTE_DUMP"
  ls -lh "$REMOTE_DUMP" | awk '{print "[box]   dump size " \$5}'
REMOTE
if [ $? -eq 0 ]; then
  scp -i "$KEY" -q "$BOX:$REMOTE_DUMP" "$DEST/db/" \
    && echo "[backup]   db dump: $(ls -lh "$DEST/db/"*.dump 2>/dev/null | awk '{print $5}')"
  $SSH "$BOX" "rm -f $REMOTE_DUMP"
else
  echo "[backup]   ⚠ db dump failed — documents were still backed up"
fi

# ── 3. Prune old backups ────────────────────────────────────────────────────
find "$DEST_ROOT" -maxdepth 1 -type d -name '20*' -mtime +$KEEP_DAYS \
  -exec echo "[backup] pruning old {}" \; -exec rm -rf {} \; 2>/dev/null

echo "[backup] done. Local copy: $DEST  ($(du -sh "$DEST" | cut -f1))"
echo "[backup] production remains the sole writer — this copy is read-only."
