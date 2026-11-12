#!/usr/bin/env bash
# Puts a backup from backup.sh back: ./restore.sh backups/omnivo-2026-11-05-0300.dump
# Everything written since that backup is lost. The API and the worker stop meanwhile.
set -euo pipefail
cd "$(dirname "$0")"

FILE="${1:?usage: ./restore.sh <backup file>}"
test -f "$FILE"

docker compose stop api worker
# The roles are not in the dump; 01-roles.sh made them when the volume was created, so the
# dump's owners and grants load as they were. --clean --if-exists drops each object first.
docker compose exec -T db pg_restore -U postgres -d omnivo --clean --if-exists <"$FILE"
# Queued jobs refer to rows of the old database
docker compose exec -T cache valkey-cli FLUSHALL
docker compose up -d --wait
echo "restored $FILE"
