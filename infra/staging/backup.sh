#!/usr/bin/env bash
# A copy of this stack's database, kept for 7 days. cron runs it every night for production
# (see docs/vps-deploy.en.md). Run it from the stack's own folder: each folder is its own database.
# Restore one:  ./restore.sh backups/omnivo-2026-11-05-0300.dump
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p backups

FILE="backups/omnivo-$(date -u +%Y-%m-%d-%H%M).dump"
# -Fc: Postgres's own compressed format, which pg_restore can load table by table
docker compose exec -T db pg_dump -U postgres -d omnivo -Fc >"$FILE.part"
# Renamed only when the dump finished, so a half-written file never looks like a backup
mv "$FILE.part" "$FILE"

find backups -name 'omnivo-*.dump' -mtime +7 -delete
echo "backup: $FILE ($(du -h "$FILE" | cut -f1))"
