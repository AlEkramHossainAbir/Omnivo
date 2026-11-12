#!/usr/bin/env bash
# Deploys one build to staging: ./deploy.sh <image-tag>
# The tag is the git commit that CI built. GitHub Actions runs this over SSH; you can run it by
# hand on the server too, for example to go back to an earlier build.
set -euo pipefail
cd "$(dirname "$0")"

TAG="${1:?usage: ./deploy.sh <image-tag>}"

# The host names, for the checks at the end (they go through Cloudflare, like a visitor). Read
# before IMAGE_TAG is set below: .env holds the tag of the last deploy, and it must not win over
# the new one.
set -a
# shellcheck source=/dev/null
. ./.env
set +a
export IMAGE_TAG="$TAG"

echo "==> Pulling images for $TAG"
docker compose --profile tools pull --quiet migrate api worker web shop

echo "==> Applying migrations"
# The old API keeps running meanwhile, so every migration must work with the old code too
docker compose run --rm migrate

# Written into .env, so every later `docker compose` command (logs, the nightly backup, a restore)
# knows which build is running, without anyone typing the tag
grep -v '^IMAGE_TAG=' .env >.env.next
echo "IMAGE_TAG=$TAG" >>.env.next
chmod 600 .env.next
mv .env.next .env

echo "==> Starting the new build"
docker compose up -d --remove-orphans --wait

echo "==> Checking it answers"
curl -fsS --retry 10 --retry-delay 3 --retry-all-errors "https://$API_HOST/health" >/dev/null
curl -fsS --retry 5 --retry-delay 2 --retry-all-errors "https://$APP_HOST/" | grep -q '<div id="root">'
curl -fsS --retry 5 --retry-delay 2 --retry-all-errors "https://$SHOP_HOST/" >/dev/null

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG" >>deploys.log

# Keep the disk from filling up with old builds (the ones in use stay)
docker image prune -af --filter "until=168h" >/dev/null

echo "==> Staging is on $TAG"
