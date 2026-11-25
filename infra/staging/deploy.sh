#!/usr/bin/env bash
# Deploys one build to this folder's stack: ./deploy.sh <image-tag> [demo|production]
# The tag is the git commit that CI built. GitHub Actions runs this over SSH with the target; you
# can run it by hand on the server too, for example to go back to an earlier build. By hand, the
# target may be left out: it is read from .env.
set -euo pipefail
cd "$(dirname "$0")"

TAG="${1:?usage: ./deploy.sh <image-tag> [demo|production]}"
WANT_TARGET="${2:-}"

# The host names, for the checks at the end (they go through Cloudflare, like a visitor). Read
# before IMAGE_TAG is set below: .env holds the tag of the last deploy, and it must not win over
# the new one.
set -a
# shellcheck source=/dev/null
. ./.env
set +a
export IMAGE_TAG="$TAG"

# Two stacks live on this server. These checks stop a deploy that would land in the wrong one:
# a build for demo copied into the production folder, or a .env without its own project name
# (Compose would then reuse another stack's containers and volumes).
: "${COMPOSE_PROJECT_NAME:?COMPOSE_PROJECT_NAME is missing in .env}"
: "${DEPLOY_TARGET:?DEPLOY_TARGET is missing in .env}"
case "$DEPLOY_TARGET" in
demo | production) ;;
*)
  echo "DEPLOY_TARGET in .env must be demo or production, not '$DEPLOY_TARGET'" >&2
  exit 1
  ;;
esac
if [ -n "$WANT_TARGET" ] && [ "$WANT_TARGET" != "$DEPLOY_TARGET" ]; then
  echo "This folder is the $DEPLOY_TARGET stack, but the build is for $WANT_TARGET. Nothing was changed." >&2
  exit 1
fi

echo "==> Deploying $TAG to $DEPLOY_TARGET ($COMPOSE_PROJECT_NAME)"

echo "==> Pulling images"
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

# Keep the disk from filling up with old builds. The images either stack runs stay, because a
# running container's image is never pruned.
docker image prune -af --filter "until=168h" >/dev/null

echo "==> $DEPLOY_TARGET is on $TAG"
