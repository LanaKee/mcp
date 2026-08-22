#!/usr/bin/env bash
# Restores a pg_dump custom-format backup produced by backup.sh into
# $DATABASE_URL. Verifies the accompanying .sha256 checksum before touching
# the database, and refuses to run without an explicit --confirm flag so it
# cannot be triggered by an accidental copy/paste against production.
#
# Usage: restore.sh <path-to-.dump> --confirm
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

dump_path="${1:-}"
confirm="${2:-}"

if [[ -z "$dump_path" || "$confirm" != "--confirm" ]]; then
  echo "Usage: restore.sh <path-to-.dump> --confirm" >&2
  echo "This will DROP and recreate objects in the target database. Pass --confirm to proceed." >&2
  exit 1
fi

if [[ ! -f "$dump_path" ]]; then
  echo "[restore] dump not found: $dump_path" >&2
  exit 1
fi

if [[ -f "${dump_path}.sha256" ]]; then
  echo "[restore] verifying checksum"
  sha256sum -c "${dump_path}.sha256"
else
  echo "[restore] warning: no .sha256 sidecar found for ${dump_path}, skipping integrity check" >&2
fi

echo "[restore] restoring ${dump_path} into target database (clean + create)"
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$DATABASE_URL" "$dump_path"
echo "[restore] done"
