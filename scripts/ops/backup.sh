#!/usr/bin/env bash
# Runs a compressed pg_dump against $DATABASE_URL and prunes backups older
# than $BACKUP_RETENTION_DAYS. Safe to run repeatedly (idempotent filenames
# include a UTC timestamp) and safe to run from cron, a docker-compose
# sidecar, or a GitHub Actions self-hosted runner with network access to the
# production database.
#
# Required:
#   DATABASE_URL           postgres connection string to back up
# Optional:
#   BACKUP_DIR              destination directory (default: ./backups)
#   BACKUP_RETENTION_DAYS    days to keep dumps before pruning (default: 14)
#   BACKUP_LABEL             filename prefix (default: gyeongbuk)
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_LABEL="${BACKUP_LABEL:-gyeongbuk}"

mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_path="${BACKUP_DIR}/${BACKUP_LABEL}-${timestamp}.dump"
tmp_path="${dump_path}.partial"

echo "[backup] dumping to ${dump_path}"
pg_dump --format=custom --compress=9 --file="$tmp_path" "$DATABASE_URL"
mv "$tmp_path" "$dump_path"
sha256sum "$dump_path" > "${dump_path}.sha256"
echo "[backup] wrote $(du -h "$dump_path" | cut -f1) to ${dump_path}"

echo "[backup] pruning dumps older than ${BACKUP_RETENTION_DAYS} days in ${BACKUP_DIR}"
find "$BACKUP_DIR" -maxdepth 1 -name "${BACKUP_LABEL}-*.dump*" -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete

echo "[backup] current backups:"
find "$BACKUP_DIR" -maxdepth 1 -name "${BACKUP_LABEL}-*.dump" -printf '%TY-%Tm-%Td %f\n' 2>/dev/null | sort || \
  ls -la "$BACKUP_DIR"
