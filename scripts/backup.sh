#!/usr/bin/env bash
# Nightly backup: database dump + uploaded files/recordings. Keeps 14 days.
# Cron (as the deploy user):  30 1 * * * /opt/prisim-crm/scripts/backup.sh >> /var/log/prisim-backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
DEST="${BACKUP_DIR:-/opt/prisim-backups}"
STAMP=$(date +%Y%m%d-%H%M)
mkdir -p "$DEST"
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U prisim -Fc prisim_crm > "$DEST/db-$STAMP.dump"
docker run --rm -v prisim-crm_storage:/s -v "$DEST":/b alpine tar czf "/b/files-$STAMP.tgz" -C /s .
find "$DEST" -type f -mtime +14 -delete
echo "$(date) backup ok: $DEST/db-$STAMP.dump"
# Restore drill:  docker compose -f docker-compose.prod.yml exec -T db pg_restore -U prisim -d prisim_crm --clean < db-XXXX.dump
