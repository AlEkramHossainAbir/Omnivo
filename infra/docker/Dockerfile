# syntax=docker/dockerfile:1.7

# One Dockerfile, four images (build each with --target):
#   api      the API and the worker (same code, a different command)
#   migrate  runs the database migrations once per deploy, then exits
#   web      Caddy: HTTPS in front of everything, and the app's static files
#   shop     the online shop (apps/shop), an Astro Node server. Until step 26's public API exists
#            it shows the mock shop, so on staging it is a demo only
# Build from the repo root: docker build -f infra/docker/Dockerfile --target api .

ARG NODE_IMAGE=node:24.22.2-alpine3.24

# ---------------------------------------------------------------------------------------------
# base: Node plus the pnpm version that package.json pins
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------------------------------------
# deps: download every package once. Only the lockfile is copied first, so this layer is reused
# until the lockfile changes, even when the code changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# ---------------------------------------------------------------------------------------------
# source: the whole repo, installed from the store that deps filled (no network)
FROM deps AS source
COPY . .
RUN pnpm install --offline --frozen-lockfile

# ---------------------------------------------------------------------------------------------
# api-build: build the API and the packages it uses, then copy only what it needs at run time
FROM source AS api-build
RUN pnpm turbo run build --filter=@omnivo/api
RUN pnpm --filter @omnivo/api deploy --prod /out/api

# ---------------------------------------------------------------------------------------------
# migrate-build: the db package with its dev dependencies, because migrate.ts runs through tsx
FROM source AS migrate-build
RUN pnpm turbo run build --filter=@omnivo/db
RUN pnpm --filter @omnivo/db deploy /out/db

# ---------------------------------------------------------------------------------------------
# app-build: the PWA. Vite writes VITE_API_URL into the JavaScript at build time, so the API's
# address is a build argument, not a runtime setting.
FROM source AS app-build
ARG VITE_API_URL
RUN test -n "$VITE_API_URL" || (echo "VITE_API_URL build argument is required" >&2 && exit 1)
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm turbo run build --filter=@omnivo/app

# ---------------------------------------------------------------------------------------------
# shop-build: the shop's server and its files. `astro build` bundles the workspace packages
# (contracts, i18n) into dist/server, but it leaves npm packages (react, zod, the icons) as
# imports, so `deploy --prod` copies the shop with the node_modules those imports need.
FROM source AS shop-build
RUN pnpm turbo run build --filter=@omnivo/shop
RUN pnpm --filter @omnivo/shop deploy --prod /out/shop

# ---------------------------------------------------------------------------------------------
# api: the runtime image for the API and the worker
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=api-build --chown=node:node /out/api ./
USER node
EXPOSE 3000
# The worker uses the same image with: command: ["node", "dist/worker.js"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------------------------
# migrate: applies pending migrations and syncs the permission catalog, then exits
FROM ${NODE_IMAGE} AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=migrate-build --chown=node:node /out/db ./
USER node
CMD ["node_modules/.bin/tsx", "src/migrate.ts"]

# ---------------------------------------------------------------------------------------------
# shop: the shop's Node server. The standalone adapter is the whole server (no Express): it reads
# HOST and PORT from the environment. HOST must be 0.0.0.0, or only the container itself could
# reach it and Caddy would get "connection refused".
FROM ${NODE_IMAGE} AS shop
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321
WORKDIR /app
COPY --from=shop-build --chown=node:node /out/shop ./
USER node
EXPOSE 4321
CMD ["node", "dist/server/entry.mjs"]

# ---------------------------------------------------------------------------------------------
# web: Caddy with the app's files baked in. The Caddyfile comes from the server (a volume), so a
# change of host names does not need a new image.
FROM caddy:2.10.2-alpine AS web
COPY --from=app-build /repo/apps/app/dist /srv/app
