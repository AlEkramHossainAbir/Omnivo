#!/usr/bin/env bash
# Empties the DEMO stack: its database, files, job queue and mail. The demo then starts again on
# the same build, with every migration applied to an empty database.
#   cd /srv/omnivo-demo && ./reset-demo.sh
#
# It refuses to run on production. Production's data belongs to the users: it is never reset, only
# backed up (backup.sh) and, after a mistake, restored (restore.sh).
set -euo pipefail
cd "$(dirname "$0")"

set -a
# shellcheck source=/dev/null
. ./.env
set +a

if [ "${DEPLOY_TARGET:-}" != "demo" ] || [ "${COMPOSE_PROJECT_NAME:-}" != "omnivo-demo" ]; then
  echo "This is not the demo stack (DEPLOY_TARGET=${DEPLOY_TARGET:-unset}," \
    "COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-unset}). Nothing was deleted." >&2
  exit 1
fi
: "${IMAGE_TAG:?IMAGE_TAG is empty in .env: deploy the demo once first}"

echo "==> Deleting the demo's containers and volumes ($COMPOSE_PROJECT_NAME)"
docker compose --profile tools down -v --remove-orphans

# No pull: the images of the build that was running are still on the server, and pulling would
# need the registry login that only a deploy has
echo "==> Starting $IMAGE_TAG on an empty database"
docker compose run --rm migrate
docker compose up -d --remove-orphans --wait

echo "==> The demo is empty again, on $IMAGE_TAG"
