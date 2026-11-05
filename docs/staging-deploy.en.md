# Staging deploy guide

This guide puts Omnivo on a staging server, so that several people can test it from their own
computers and phones at the same time. It has two parts:

- **Part A** is for the person who sets up and runs the server. It adds the files that build and
  deploy Omnivo, sets up one server, and connects it to GitHub Actions.
- **Part B** is for the testers. Send them that part: how to get in, what to test, and how to
  report a problem.

"Staging" means a copy of the product that looks and works like production, but holds only test
data. Nothing on staging is real: no real customers, no real money, no real emails.

## What you get

| Address | What it is | Who uses it |
|---|---|---|
| `https://app.staging.<your-domain>` | The Omnivo app (the PWA) | Testers |
| `https://api.staging.<your-domain>` | The API | The app (nobody opens it by hand) |
| `https://files.staging.<your-domain>` | File storage (MinIO): logos, attachments, PDFs, exports | The app, through signed links |
| `https://mail.staging.<your-domain>` | Mailpit: every email staging sends, in one inbox, with a password | Testers |

Every push to `dev` that passes CI is built and deployed by itself, a few minutes after CI
finishes. The Actions tab also gets a "Run workflow" button to deploy any branch or commit.

```text
            GitHub Actions (push to dev, CI green)
              | build 3 images, push to GHCR
              | ssh: copy the stack files, run deploy.sh
              v
   +---------------- one server (Docker Compose) ----------------+
   |                                                             |
   |  web (Caddy, ports 80/443, HTTPS) ---+-- app files (in the image)
   |        |            |          |     |                      |
   |       api        storage      mail   |                      |
   |    (NestJS)      (MinIO)   (Mailpit) |                      |
   |      |   \                           |                      |
   |      |   worker (same image as api) -+-- SMTP --> mail      |
   |      |    |                                                 |
   |      db (Postgres 17)   cache (Valkey)    migrate (one-off) |
   +-------------------------------------------------------------+
```

### The decisions behind it

These were chosen before the guide was written:

1. **One server with Docker Compose** (Hetzner or DigitalOcean), with Caddy in front. This is
   what `docs/system-design.bn.md` §12.4 suggests for the start. It is cheap, you control every
   part, and the same images can move to k3s later.
2. **Postgres, Valkey and MinIO run as containers on the same server.** This is the same setup as
   your local Docker, so the three database roles and row-level security work the same way. A
   managed Postgres often does not give you a superuser, and the roles need one. A copy of the
   database is made every night.
3. **Mailpit catches every email.** No email leaves the server, so a test can never mail a real
   person. Testers read their invitations in Mailpit's inbox.
4. **A push to `dev` deploys by itself after CI passes.** There is also a button for a manual
   deploy or a rollback.

### What was checked before writing this guide

Everything in Part A was built and run in a scratch clone of the repo, at commit `1219788`
(`dev`), on a Mac (Apple silicon, Docker 29.7, Compose 5.4):

- All three images build. The whole stack starts with `deploy.sh` in about 30 seconds, and a
  second deploy over a running stack works too.
- Through Caddy: sign-up and the welcome email in Mailpit, sign-in in a real browser
  (Chromium), a reload that stays signed in, and the service worker in control with 430 files
  cached.
- A logo upload with a presigned URL from the app's origin (CORS preflight, upload, download, same
  bytes back).
- The audit log records the client's IP with `TRUST_PROXY` on, and Caddy's IP with it off. A
  forged `X-Forwarded-For` header was ignored.
- A Bangla PDF renders inside the API image (the fonts are found).
- Cache headers: `no-cache` on HTML, `sw.js` and the manifest; `immutable` on `/assets/*`; a
  missing chunk is a 404, not `index.html`.
- `backup.sh` and `restore.sh`, run from an empty environment like cron's. After the restore
  the grants and forced RLS were in place and sign-in worked.
- The secret-filling commands of step A5.6 with GNU `sed` on Ubuntu 24.04.
- `pnpm --filter @omnivo/api typecheck`, ESLint and Prettier on the changed files, the API's
  unit tests (130 passed), `actionlint` on both workflows, and `shellcheck` on the scripts.

What could **not** be checked from a laptop, so watch it on the first real deploy:

- The Let's Encrypt certificates. The local test used plain HTTP on `*.localhost`.
- The push to GHCR and the SSH deploy from GitHub Actions.
- The amd64 build. It was built for arm64 locally; the lockfile has the amd64 Linux binaries
  that the build tools need.

---

# Part A: set up staging

## A1. What you need before you start

- **A domain** whose DNS you can change. This guide uses `staging.example.com`; put your own
  domain in its place everywhere. The app and the API must be on the same parent domain
  (`app.staging…` and `api.staging…`). The sign-in cookie is `SameSite=Strict`, and the browser
  sends it only between hosts of the same site.
- **A server**: Ubuntu 24.04, x86 (amd64), 2 vCPU, 4 GB RAM, 40 GB disk or more. For example a
  Hetzner CX22 or a DigitalOcean 4 GB droplet. The whole stack used about 1.1 GB of RAM in the
  test. Nothing is built on the server, so it does not need more. Pick x86, not ARM: GitHub's
  standard runners build amd64 images. An ARM server would need an emulated build that takes
  much longer.
- **Admin rights on the GitHub repo**, to add an environment, secrets and variables.
- On your computer: an SSH client and `ssh-keygen`.

## A2. The code change: the client's real IP behind Caddy

On staging every request reaches the API through Caddy. Without a change, the API sees Caddy's
address as the client's, so every audit log line says `172.20.0.8` (Caddy's container IP). This
change lets the API trust the `X-Forwarded-For` header, but only when you turn it on.

`apps/api/src/config.ts`:

```diff
@@ -26,6 +26,10 @@ const envSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
   API_BASE_URL: z.url(),
   BETTER_AUTH_SECRET: z.string().min(32),
   JWT_SECRET: z.string().min(32),
+  // "true" only when a proxy you run (Caddy on staging) is the one thing that can reach the API.
+  // Fastify then takes the client's address from X-Forwarded-For, so the audit log records the
+  // person's IP, not the proxy's. Left off, a client could write any IP into that header.
+  TRUST_PROXY: z.stringbool().default(false),
 });
 
 const workerEnvSchema = sharedEnvSchema.extend(storageEnvSchema.shape).extend({
@@ -70,6 +74,7 @@ export function loadConfig(env: Record<string, string | undefined>) {
   return {
     port: e.PORT,
     apiBaseUrl: e.API_BASE_URL,
+    trustProxy: e.TRUST_PROXY,
     // /openapi.json আর /docs — production-এ API-র পুরো নকশা বাইরে দেখানো হয় না
     exposeDocs: e.NODE_ENV !== 'production',
     databaseUrl: e.DATABASE_URL,
```

`z.stringbool()` reads the text values `"true"`, `"false"`, `"1"`, `"0"`, `"yes"` and `"no"` and
gives a real `boolean`, so `config.trustProxy` is typed `boolean`, not `string`. A plain
`z.coerce.boolean()` would be wrong here: it turns the string `"false"` into `true`, because any
non-empty string is truthy. `.default(false)` means local dev, CI and the tests need no new line
in `.env`, and nothing changes for them.

The default must be `false`. With `true`, the API takes the IP from a header that the client can
write. Only turn it on when nothing but your own proxy can reach the API. On staging that is
true: the `api` container has no published port, and Caddy replaces any `X-Forwarded-For` that
the client sends. The test showed this. A request with a forged `203.0.113.9` was still logged
with the real address.

`apps/api/src/configure-app.ts`:

```diff
@@ -15,9 +15,10 @@ const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] satisfies
 
 // প্রতিটা request-এর আলাদা id (UUID) — error response-এর requestId আর লগের লাইন এটা দিয়েই মেলে।
 // Fastify-র ডিফল্ট "req-1, req-2" প্রতিটা process-এ আবার ১ থেকে শুরু হয়, একাধিক pod-এ মেলে না।
-// ক্লায়েন্টের পাঠানো x-request-id নেওয়া হয় না (Fastify 5-এর ডিফল্ট) — বাইরের মান বিশ্বাস করা হয় না
-export function createAdapter(): FastifyAdapter {
-  return new FastifyAdapter({ genReqId: () => randomUUID() });
+// ক্লায়েন্টের পাঠানো x-request-id নেওয়া হয় না (Fastify 5-এর ডিফল্ট) — বাইরের মান বিশ্বাস করা হয় না।
+// trustProxy: config.trustProxy (TRUST_PROXY). Tests leave it off, as the API runs with no proxy there.
+export function createAdapter(trustProxy = false): FastifyAdapter {
+  return new FastifyAdapter({ genReqId: () => randomUUID(), trustProxy });
 }
 
 // main.ts আর integration test দুজনেই এটা ডাকে — টেস্টে ঠিক production-এর setup চলে
```

The setting is a parameter with a default, not a read of `process.env`. The integration tests
(`apps/api/src/testing/app.ts`) and `contract.spec.ts` still call `createAdapter()` with no
argument and keep today's behaviour. Fastify's `trustProxy: true` sets `request.ip` from the
header, and `request-context.ts` already reads `req.ip` first, so nothing else changes.

`apps/api/src/main.ts`:

```diff
@@ -10,7 +10,7 @@ async function bootstrap(): Promise<void> {
   const config = loadConfig(process.env);
   const app = await NestFactory.create<NestFastifyApplication>(
     AppModule.register(config),
-    createAdapter(),
+    createAdapter(config.trustProxy),
   );
   await configureApp(app, config);
   // SIGTERM/SIGINT-এ onApplicationShutdown চলে — DB pool আর Redis বন্ধ হয়
```

`main.ts` already loads the config before it creates the adapter, so the value is there when it
is needed.

You do not need to add `TRUST_PROXY` to the root `.env.example`: dev runs with no proxy, and the
default is right there.

## A3. The files to add

```text
.dockerignore                         new
infra/docker/Dockerfile               new: the api, migrate and web images
infra/staging/compose.yml             new: the stack on the server
infra/staging/Caddyfile               new: HTTPS and the four hosts
infra/staging/.env.example            new: the server's settings, without values
infra/staging/postgres-init/01-roles.sh  new: the three database roles
infra/staging/deploy.sh               new
infra/staging/backup.sh               new
infra/staging/restore.sh              new
.github/workflows/deploy-staging.yml  new
.github/workflows/ci.yml              changed: one job added at the end
```

Make the four `.sh` files executable before you commit them, or the server cannot run them:

```bash
chmod +x infra/staging/*.sh infra/staging/postgres-init/01-roles.sh
```

Git keeps the executable bit, and `scp` keeps it when it copies the files.

### A3.1 `.dockerignore`

```
# What `docker build .` never sends to the builder. node_modules and dist are built inside the
# image for Linux; a copy from a Mac would hold the wrong native binaries and stale output.
**/node_modules
**/dist
**/dist-worker
**/.turbo
**/.vite
**/*.tsbuildinfo
**/test-results
**/playwright-report
**/coverage
.git
.github
.guide
docs
infra/staging
# Secrets stay out of every image
.env
.env.*
!.env.example
**/.DS_Store
```

`docker build .` sends the whole folder to the builder unless this file leaves parts out.
`node_modules` and `dist` must stay out. They were built on a Mac, so their native binaries
(esbuild, rolldown, lightningcss) are for macOS and would break the Linux build or run the wrong
code. They are also hundreds of MB that would be uploaded on every build. `.env` stays out so
that no secret can end up in an image layer, where anyone who pulls the image could read it.
`infra/staging` is left out because the images do not need it. Without this line, a change to
`deploy.sh` would rebuild every image.

### A3.2 `infra/docker/Dockerfile`

One Dockerfile with several stages. Each image is a `--target`. The first part installs the
dependencies:

```
# syntax=docker/dockerfile:1.7

# One Dockerfile, three images (build each with --target):
#   api      the API and the worker (same code, a different command)
#   migrate  runs the database migrations once per deploy, then exits
#   web      Caddy: HTTPS in front of everything, and the app's static files
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
```

- `ARG NODE_IMAGE=node:24.22.2-alpine3.24` pins the exact Node version. `.nvmrc` says `24`, so
  this is the same major version as CI. With an exact tag, a rebuild next month uses the same
  Node, and the version only changes when you change this line.
- `corepack enable` makes `pnpm` the version that `package.json` names (`pnpm@12.5.1`).
  `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` stops corepack from waiting for a "yes" that a build can
  never type.
- `deps` copies only the lockfile and the workspace files, then runs `pnpm fetch`. Docker reuses
  a layer while its inputs stay the same. A code change does not touch the lockfile, so the
  ~700 MB download is skipped on most builds. `pnpm fetch` in pnpm 12 takes no
  `--frozen-lockfile` flag (the build fails with "unexpected argument"); it only reads the
  lockfile anyway.
- The store stays in the image layer at `/pnpm/store`, on purpose. A BuildKit cache mount
  (`RUN --mount=type=cache`) looks faster, but GitHub's layer cache does not save cache mounts.
  On a fresh runner the cached `deps` layer would come back with an empty store, and
  `pnpm install --offline` would then fail.
- `source` copies the repo and installs from that store with `--offline`, so the install itself
  never touches the network. `--frozen-lockfile` fails the build if `package.json` and the
  lockfile disagree, as in CI.

Then each image's build:

```
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
```

- `turbo run build --filter=@omnivo/api` also builds the packages that the API imports
  (`contracts`, `db`, `auth`), because `turbo.json` says `build` depends on `^build`.
- `pnpm --filter @omnivo/api deploy --prod /out/api` writes a folder with the API, its production
  dependencies and real copies of the workspace packages (with their `dist`). The runtime image
  copies only this folder, without the source of the other apps or the dev tools.
- `migrate-build` deploys `@omnivo/db` **with** its dev dependencies (no `--prod`).
  `packages/db/src/migrate.ts` is never compiled: `tsconfig.build.json` leaves it out, and it
  runs through `tsx` with `dotenv`, which are both dev dependencies. A `--prod` deploy would
  have no `tsx`.
- `app-build` needs `VITE_API_URL` at build time. Vite replaces `import.meta.env.VITE_API_URL`
  with the text of the value inside the JavaScript (`apps/app/src/lib/api.ts:20`). After the
  build there is no setting left to change. The `test -n` line stops the build if the argument
  is missing. Without it, the app would silently fall back to `http://localhost:3000`, and on
  staging every request would fail in the browser.

And the three runtime images:

```
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
# web: Caddy with the app's files baked in. The Caddyfile comes from the server (a volume), so a
# change of host names does not need a new image.
FROM caddy:2.10.2-alpine AS web
COPY --from=app-build /repo/apps/app/dist /srv/app
```

- The runtime stages start again from the bare Node image, so nothing from the build stages (the
  store, the source, the compilers) comes along.
- `NODE_ENV=production` turns on what the API does differently in production (`config.ts`):
  `Secure` cookies, no `/docs` or `/openapi.json`, and no bucket creation by the API.
- `USER node`: the process does not run as root. If someone broke into the API, they could not
  change the files in the image. `--chown=node:node` makes the copied files belong to that user.
- One image serves both the API and the worker. Only the command differs (`dist/main.js` or
  `dist/worker.js`). This is how `apps/api/src/worker.ts` was designed in step 8.
- `web` is Caddy with the app's built files in `/srv/app`. The Caddyfile is **not** in the image.
  It comes from the server (see `compose.yml`), so the host names can change without a new
  build.

About the size: the `api` image is about 640 MB on arm64. `better-auth` lists `drizzle-kit`,
`vitest`, `react` and `react-dom` as optional peer dependencies. With `autoInstallPeers: true`,
pnpm installs them because they exist in the workspace, even in a `--prod` deploy. That is fine
for staging: the Node base layer is shared and downloaded once, and a deploy downloads only the
app layer (about 100 MB compressed). Making the image smaller means changing how pnpm resolves
peers in the whole repo. Leave that to the production work of step 25.

### A3.3 `infra/staging/Caddyfile`

```
# Caddy on staging: one server in front of everything. It gets and renews the HTTPS certificates
# by itself (Let's Encrypt). Each site address is a full URL from the server's .env, so the
# addresses live in one place. The API, the S3 client and this file all read the same values.

{
	email {$ACME_EMAIL}
}

(common) {
	encode zstd gzip
	header {
		# Staging must never show up in a search engine
		X-Robots-Tag "noindex, nofollow"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}
	log {
		output stdout
		format json
	}
}

# The app: static files from the image
{$APP_ORIGIN} {
	import common
	root * /srv/app

	# Built files have a hash in their name, so a new build never reuses a name. They can be kept
	# for a year. A missing one is a plain 404: never index.html, or an old tab would run HTML as JS.
	handle /assets/* {
		header Cache-Control "public, max-age=31536000, immutable"
		file_server
	}

	# Everything else (index.html, sw.js, the manifest, the icons, and every app route like /login or
	# /d/<token>) must be checked again on each load. The service worker finds a new version only
	# when sw.js is not cached.
	handle {
		header Cache-Control "no-cache"
		try_files {path} /index.html
		file_server
	}
}

# The API
{$API_BASE_URL} {
	import common
	reverse_proxy api:3000
}

# File storage (MinIO). The browser uploads and downloads here with presigned URLs. Caddy keeps
# the Host header as it is, which matters: it is part of the URL's signature.
{$S3_ENDPOINT} {
	header X-Robots-Tag "noindex, nofollow"
	reverse_proxy storage:9000
}

# Mailpit: every email staging sends. Mailpit asks for the password itself (MP_UI_AUTH).
{$MAIL_URL} {
	import common
	reverse_proxy mail:8025
}
```

- Each site address is a full URL from the server's `.env`, the same variables the API reads
  (`APP_ORIGIN`, `API_BASE_URL`, `S3_ENDPOINT`). So the four addresses live in one place, and
  Caddy, CORS and the signed file links cannot disagree. With `https://` Caddy gets a Let's
  Encrypt certificate by itself and redirects HTTP to HTTPS.
- `email {$ACME_EMAIL}`: Let's Encrypt writes to this address if a certificate cannot be renewed.
- `X-Robots-Tag "noindex, nofollow"` keeps staging out of search engines. Testers may share links,
  and a search result for a staging sign-in page would look like a phishing site.
- `/assets/*` gets `immutable` for one year. Vite puts a content hash in every file name there,
  so a new build never reuses a name, and keeping old files in the cache is safe.
- `/assets/*` has **no** `try_files` fallback. After a deploy, a tab that is still open asks for
  an old chunk that no longer exists. A 404 lets the app's error handling act. Returning
  `index.html` with status 200 would make the browser run HTML as JavaScript, and the page would
  break with an unclear MIME error.
- Everything else gets `Cache-Control: no-cache`, and unknown paths fall back to `index.html`, so
  links like `/login`, `/invoices/…` and the public `/d/<token>` page open the app. `no-cache`
  matters most for `sw.js`: the browser finds a new version of the service worker only when it
  checks `sw.js` again. A cached `sw.js` would keep testers on the old build. `no-cache` still
  lets the browser keep the file; it only checks first (a cheap 304).
- The files host has no `encode` and no `log`. Caddy keeps the `Host` header when it proxies, and
  that matters here: the `Host` is part of a presigned URL's signature. The API signs for
  `files.staging…`, and MinIO checks the signature against the `Host` it receives. If you add
  `header_up Host storage:9000`, every upload fails with `SignatureDoesNotMatch`.
- Mailpit asks for its own password (`MP_UI_AUTH` in `compose.yml`), so Caddy needs no
  `basic_auth`. Caddy's `basic_auth` would need a bcrypt hash made by hand. Mailpit takes the
  password as it is.
- `log { output stdout; format json }` writes one JSON line per request to `docker compose logs
  web`. That is where you find a tester's failed request by time and path.

### A3.4 `infra/staging/compose.yml`

The top of the file:

```yaml
# The staging stack. It runs on one server from /srv/omnivo, next to the .env made from
# .env.example. Only Caddy (web) opens ports; everything else talks on the stack's own network.
#
#   docker compose up -d             start or update everything
#   docker compose run --rm migrate  apply new migrations (deploy.sh does this first)
#   docker compose logs -f api       follow one service's log

name: omnivo-staging

# Each container's log is cut at 10 MB and only 5 files are kept, so the disk never fills up
x-logging: &logging
  driver: json-file
  options:
    max-size: 10m
    max-file: '5'

# What the API and the worker both need from file storage
x-storage-env: &storage-env
  S3_ENDPOINT: ${S3_ENDPOINT:?set S3_ENDPOINT in .env}
  S3_BUCKET: omnivo
  S3_ACCESS_KEY_ID: omnivo-app
  S3_SECRET_ACCESS_KEY: ${S3_APP_SECRET:?set S3_APP_SECRET in .env}
```

- `name: omnivo-staging` gives the containers and volumes their own names
  (`omnivo-staging-db-1`, `omnivo-staging_db-data`). The dev compose file is called `omnivo`.
  So if you ever run this file on your own machine, it cannot pick up your dev containers or your
  dev database volume.
- `x-logging`: Docker keeps container logs forever by default, and a busy log can fill the disk
  in a few weeks. 5 × 10 MB per container is enough to look back a few days.
- `x-storage-env` holds the S3 settings that the API and the worker share, so the two cannot drift
  apart. `S3_ACCESS_KEY_ID: omnivo-app` is a MinIO user made by `storage-init`, not the root user.

The database and the cache:

```yaml
services:
  db:
    image: postgres:17-alpine
    restart: unless-stopped
    logging: *logging
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD in .env}
      POSTGRES_DB: omnivo
      # Read only by postgres-init/01-roles.sh, on the first start
      MIGRATOR_DB_PASSWORD: ${MIGRATOR_DB_PASSWORD:?set MIGRATOR_DB_PASSWORD in .env}
      APP_DB_PASSWORD: ${APP_DB_PASSWORD:?set APP_DB_PASSWORD in .env}
      WORKER_DB_PASSWORD: ${WORKER_DB_PASSWORD:?set WORKER_DB_PASSWORD in .env}
    volumes:
      - db-data:/var/lib/postgresql/data
      - ./postgres-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U postgres -d omnivo']
      interval: 5s
      timeout: 5s
      retries: 20

  cache:
    image: valkey/valkey:8-alpine
    restart: unless-stopped
    logging: *logging
    # BullMQ's jobs live here: never drop keys when memory is full
    command: ['valkey-server', '--maxmemory-policy', 'noeviction', '--save', '60', '1000']
    volumes:
      - cache-data:/data
    healthcheck:
      test: ['CMD', 'valkey-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 20
```

- `${POSTGRES_PASSWORD:?…}`: compose stops with that message if the value is missing or empty.
  Without `:?` an empty value would start Postgres with an empty password, or the API with a
  broken URL. You would then see the error much later and much less clearly.
- No `ports:` on `db` or `cache`. They are reachable only on the stack's own network, never from
  the internet. Use `docker compose exec db psql …` to look inside (A9).
- `./postgres-init` is mounted where the Postgres image runs scripts on its **first** start only,
  when the volume is empty. The three role passwords are passed to it as environment variables.
- `postgres:17-alpine` and `valkey/valkey:8-alpine` are the same images that dev and the
  integration tests use, so staging runs on what was tested.
- Valkey runs with `--maxmemory-policy noeviction`. BullMQ keeps its jobs in Valkey. Under memory
  pressure, a policy that evicts keys would silently delete queued jobs (an invitation email, a
  PDF). With `noeviction`, Valkey refuses new writes instead, and the error shows up in the logs.
  `--save 60 1000` writes a snapshot to the volume, so queued jobs survive a restart.

Storage, its set-up, and Mailpit:

```yaml
  storage:
    image: pgsty/minio:RELEASE.2026-08-04T00-00-00Z
    restart: unless-stopped
    logging: *logging
    command: ['server', '/data']
    environment:
      MINIO_ROOT_USER: omnivo-root
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD in .env}
      # Browser uploads come from the app's origin only
      MINIO_API_CORS_ALLOW_ORIGIN: ${APP_ORIGIN:?set APP_ORIGIN in .env}
    volumes:
      - storage-data:/data
    healthcheck:
      test: ['CMD', 'curl', '-fsS', 'http://localhost:9000/minio/health/live']
      interval: 5s
      timeout: 5s
      retries: 20

  # Runs on every `up` and exits: makes the bucket and the app's own key (not the root one).
  # Safe to run again: each command skips what already exists.
  storage-init:
    image: pgsty/minio:RELEASE.2026-08-04T00-00-00Z
    logging: *logging
    depends_on:
      storage:
        condition: service_healthy
    environment:
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD}
      S3_APP_SECRET: ${S3_APP_SECRET}
    entrypoint: ['/bin/sh', '-c']
    # $$ is a $ for the shell inside the container, not for compose
    command:
      - |
        set -e
        mc alias set local http://storage:9000 omnivo-root "$$MINIO_ROOT_PASSWORD"
        mc mb --ignore-existing local/omnivo
        mc admin user add local omnivo-app "$$S3_APP_SECRET"
        mc admin policy attach local readwrite --user omnivo-app || true

  mail:
    image: axllent/mailpit:v1.31.2
    restart: unless-stopped
    logging: *logging
    environment:
      MP_UI_AUTH: ${MAIL_UI_USER:?set MAIL_UI_USER in .env}:${MAIL_UI_PASSWORD:?set MAIL_UI_PASSWORD in .env}
      MP_DATABASE: /data/mailpit.db
      MP_MAX_MESSAGES: 5000
    volumes:
      - mail-data:/data
```

- `MINIO_API_CORS_ALLOW_ORIGIN` lets only the app's origin upload from the browser. The test
  showed MinIO answering the preflight with exactly that origin.
- The health check uses `curl`, which the `pgsty/minio` image includes.
- `storage-init` uses the same image, because it includes the `mc` client. It runs on every `up`
  and exits. `mc mb --ignore-existing` skips a bucket that exists, `mc admin user add` updates the
  user's secret if it exists, and `|| true` skips an "already attached" policy. So it is safe on
  every deploy, and it also puts a changed `S3_APP_SECRET` into effect.
- The API gets its own MinIO user, not the root key. A leaked app key cannot create users or change
  MinIO's settings. The `readwrite` policy still covers every bucket; on staging there is only
  one.
- The API makes the bucket itself only outside production (`createBucket` in `config.ts`). This
  stack runs with `NODE_ENV=production`, so `storage-init` makes it.
- `$$MINIO_ROOT_PASSWORD`: compose replaces `$NAME` in the file itself, and `$$` is how to write a
  `$` that the shell inside the container should see. Then the secret comes from the container's
  environment and never appears in `docker compose config` output.
- Mailpit's `MP_DATABASE` keeps the emails in a volume, so they survive a restart.
  `MP_MAX_MESSAGES: 5000` deletes the oldest ones beyond that.

The migrations, the API and the worker:

```yaml
  # One-off: `docker compose run --rm migrate`. The profile keeps `up` from starting it.
  migrate:
    image: ${REGISTRY:?set REGISTRY in .env}/omnivo-migrate:${IMAGE_TAG:?IMAGE_TAG is written by deploy.sh. Run ./deploy.sh <tag> first}
    profiles: ['tools']
    logging: *logging
    depends_on:
      db:
        condition: service_healthy
    environment:
      MIGRATOR_DATABASE_URL: postgres://omnivo_migrator:${MIGRATOR_DB_PASSWORD}@db:5432/omnivo

  api:
    image: ${REGISTRY}/omnivo-api:${IMAGE_TAG}
    restart: unless-stopped
    logging: *logging
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_healthy
      storage-init:
        condition: service_completed_successfully
    environment:
      <<: *storage-env
      NODE_ENV: production
      DATABASE_URL: postgres://omnivo_app:${APP_DB_PASSWORD}@db:5432/omnivo
      REDIS_URL: redis://cache:6379
      API_BASE_URL: ${API_BASE_URL:?set API_BASE_URL in .env}
      APP_ORIGIN: ${APP_ORIGIN}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET in .env}
      JWT_SECRET: ${JWT_SECRET:?set JWT_SECRET in .env}
      # Only Caddy can reach this container, so its X-Forwarded-For is the client's address
      TRUST_PROXY: 'true'
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 20s
    stop_grace_period: 30s

  worker:
    image: ${REGISTRY}/omnivo-api:${IMAGE_TAG}
    command: ['node', 'dist/worker.js']
    restart: unless-stopped
    logging: *logging
    depends_on:
      db:
        condition: service_healthy
      cache:
        condition: service_healthy
      storage-init:
        condition: service_completed_successfully
    environment:
      <<: *storage-env
      NODE_ENV: production
      DATABASE_URL: postgres://omnivo_app:${APP_DB_PASSWORD}@db:5432/omnivo
      WORKER_DATABASE_URL: postgres://omnivo_worker:${WORKER_DB_PASSWORD}@db:5432/omnivo
      REDIS_URL: redis://cache:6379
      APP_ORIGIN: ${APP_ORIGIN}
      SMTP_URL: smtp://mail:1025
      MAIL_FROM: Omnivo Staging <no-reply@${MAIL_FROM_DOMAIN:?set MAIL_FROM_DOMAIN in .env}>
    # A deploy waits for the running jobs (a PDF, an export) to finish
    stop_grace_period: 60s
```

- `migrate` has `profiles: ['tools']`, so `docker compose up` never starts it. It runs only when
  `deploy.sh` calls `docker compose run --rm migrate`. It connects as `omnivo_migrator`, the only
  role that may change the schema.
- `${IMAGE_TAG:?…}`: every image is a commit hash, never `latest`. `deploy.sh` writes the tag into
  `.env`, so every later `docker compose` command on the server (logs, the backup, a restore)
  knows which build runs. Before the first deploy, compose says what to do instead of pulling a
  wrong image.
- Each service gets only the variables it needs, as the API's own `config.ts` intends ("the
  worker never holds the JWT secret, and the API never holds the SMTP password"). That is why
  this file lists the variables one by one instead of using `env_file: .env`.
- `depends_on … service_completed_successfully` on `storage-init`: the API starts only after the
  bucket and its key exist. Otherwise the first upload after a fresh install would fail.
- `TRUST_PROXY: 'true'` is the setting from A2. It is safe because the `api` service has no
  `ports:`, so only Caddy can reach it.
- The health check uses `fetch`, which is built into Node 24, so the image needs no `curl`.
  `start_period: 20s` gives Nest time to start before a failed check counts. `deploy.sh` waits on
  this check (`up --wait`), and Caddy starts only once the API is healthy.
- `stop_grace_period`: on a deploy, Docker sends SIGTERM and waits this long before it kills the
  process. The worker gets 60 seconds to finish a running job (a PDF, an export), because
  `worker.ts` closes cleanly on SIGTERM.
- `SMTP_URL: smtp://mail:1025` sends every email to Mailpit. Nothing can reach a real mailbox.

Caddy and the volumes:

```yaml
  web:
    image: ${REGISTRY}/omnivo-web:${IMAGE_TAG}
    restart: unless-stopped
    logging: *logging
    depends_on:
      api:
        condition: service_healthy
    ports:
      - '80:80'
      - '443:443'
      - '443:443/udp'
    environment:
      ACME_EMAIL: ${ACME_EMAIL:?set ACME_EMAIL in .env}
      APP_ORIGIN: ${APP_ORIGIN}
      API_BASE_URL: ${API_BASE_URL}
      S3_ENDPOINT: ${S3_ENDPOINT}
      MAIL_URL: ${MAIL_URL:?set MAIL_URL in .env}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      # The certificates. Losing this volume means asking Let's Encrypt again, which has limits
      - caddy-data:/data
      - caddy-config:/config

volumes:
  db-data:
  cache-data:
  storage-data:
  mail-data:
  caddy-data:
  caddy-config:
```

- Only `web` publishes ports. `443/udp` is HTTP/3, which Caddy turns on by itself.
- `caddy-data` holds the certificates. If you delete it, Caddy asks Let's Encrypt again, and Let's
  Encrypt allows only 5 certificates for the same host names per week. So do not delete it when
  you reset staging (A9.5).

### A3.5 `infra/staging/postgres-init/01-roles.sh`

```bash
#!/bin/sh
# Runs once, when the Postgres volume is created for the first time (like the dev script
# infra/docker/postgres/init/01-roles.sql). It makes the same three roles, but the passwords come
# from the server's .env instead of being written here. Keep the two files in step: a role or a
# grant added to one must be added to the other.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v migrator_password="$MIGRATOR_DB_PASSWORD" \
  -v app_password="$APP_DB_PASSWORD" \
  -v worker_password="$WORKER_DB_PASSWORD" <<'SQL'
-- Runs the migrations and owns the schema
CREATE ROLE omnivo_migrator WITH LOGIN PASSWORD :'migrator_password' CREATEDB CREATEROLE;
GRANT ALL PRIVILEGES ON DATABASE omnivo TO omnivo_migrator;
ALTER DATABASE omnivo OWNER TO omnivo_migrator;

-- The API and the worker's jobs. NOBYPASSRLS: every query goes through row-level security
CREATE ROLE omnivo_app WITH LOGIN PASSWORD :'app_password' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE omnivo TO omnivo_app;
GRANT USAGE ON SCHEMA public TO omnivo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE omnivo_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO omnivo_app;
ALTER DEFAULT PRIVILEGES FOR ROLE omnivo_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO omnivo_app;

-- The worker's outbox relay. Its rights come from the migrations (0012 and later)
CREATE ROLE omnivo_worker WITH LOGIN PASSWORD :'worker_password' NOSUPERUSER NOBYPASSRLS;
GRANT CONNECT ON DATABASE omnivo TO omnivo_worker;
GRANT USAGE ON SCHEMA public TO omnivo_worker;
SQL
```

This makes the same three roles as the dev script `infra/docker/postgres/init/01-roles.sql`,
with the same rights. The passwords come from the environment instead of the file. A shell
script, because a `.sql` file in that folder cannot read environment variables.

- `psql -v name=value` and then `:'name'` in the SQL put each password in as a quoted string
  literal. psql does the quoting, so a password with a quote in it could not break the SQL. The
  heredoc is `<<'SQL'` (quoted), so the shell leaves `:'…'` alone and psql sees it.
- `ON_ERROR_STOP=1` makes a failed statement stop the script. Then the container stops instead of
  starting with half the roles.
- The rights of `omnivo_worker` on the outbox tables come from the migrations (0012 and later),
  as in dev.
- When someone adds a role or a grant to the dev script, it must be added here too. The comment
  at the top says so.

### A3.6 `infra/staging/.env.example`

```
# The staging server's settings. Copy to /srv/omnivo/.env on the server, fill it in, and
# `chmod 600 .env`. Never commit the filled-in file.
#
# Make each secret with:  openssl rand -hex 32
# Hex (0-9, a-f) has no character that needs escaping inside a URL or this file.

# --- Addresses (full URLs, no trailing slash). Caddy gets a certificate for each host. ---
APP_ORIGIN=https://app.staging.example.com
API_BASE_URL=https://api.staging.example.com
S3_ENDPOINT=https://files.staging.example.com
MAIL_URL=https://mail.staging.example.com

# Let's Encrypt writes here when a certificate is about to run out and something is wrong
ACME_EMAIL=you@example.com
# Emails come "from" no-reply@ this domain. Mailpit catches them all, so nothing is sent out.
MAIL_FROM_DOMAIN=staging.example.com

# --- Images ---
REGISTRY=ghcr.io/your-github-user-or-org
# The git commit that is running. deploy.sh writes this line; leave it empty.
IMAGE_TAG=

# --- Database. Each role has its own password. ---
POSTGRES_PASSWORD=
MIGRATOR_DB_PASSWORD=
APP_DB_PASSWORD=
WORKER_DB_PASSWORD=

# --- Auth. At least 32 characters each. Changing one signs everyone out. ---
BETTER_AUTH_SECRET=
JWT_SECRET=

# --- File storage (MinIO). The root key only sets things up; the API uses its own key. ---
MINIO_ROOT_PASSWORD=
S3_APP_SECRET=

# --- Mailpit's sign-in. Share it with the testers. ---
MAIL_UI_USER=tester
MAIL_UI_PASSWORD=
```

This is the template for the file that holds every secret on the server. It lives in the repo
without values. The root `.gitignore` ignores `.env.*` but keeps `.env.example`, so this file
can be committed and a filled-in `.env` next to it never can. You fill it in on the server in
step A5.6.

The secrets are hex (`openssl rand -hex 32`) on purpose. They appear inside URLs
(`postgres://omnivo_app:<password>@db…`), and base64 can contain `/`, `+` and `=`. Those would
need URL escaping, or the API would read a wrong user or host. They would also break the `sed`
command used in A5.6.

### A3.7 `infra/staging/deploy.sh`

```bash
#!/usr/bin/env bash
# Deploys one build to staging: ./deploy.sh <image-tag>
# The tag is the git commit that CI built. GitHub Actions runs this over SSH; you can run it by
# hand on the server too, for example to go back to an earlier build.
set -euo pipefail
cd "$(dirname "$0")"

TAG="${1:?usage: ./deploy.sh <image-tag>}"

# The addresses, for the checks at the end. Read before IMAGE_TAG is set below: .env holds the
# tag of the last deploy, and it must not win over the new one.
set -a
# shellcheck source=/dev/null
. ./.env
set +a
export IMAGE_TAG="$TAG"

echo "==> Pulling images for $TAG"
docker compose --profile tools pull --quiet migrate api worker web

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
curl -fsS --retry 10 --retry-delay 3 --retry-all-errors "$API_BASE_URL/health" >/dev/null
curl -fsS --retry 5 --retry-delay 2 --retry-all-errors "$APP_ORIGIN/" | grep -q '<div id="root">'

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $TAG" >>deploys.log

# Keep the disk from filling up with old builds (the ones in use stay)
docker image prune -af --filter "until=168h" >/dev/null

echo "==> Staging is on $TAG"
```

- `set -euo pipefail` stops the script at the first failed command, an unset variable, or a failed
  part of a pipe. A failed migration must never be followed by starting the new code.
- `.env` is read **before** `IMAGE_TAG` is set. `.env` holds the tag of the last deploy, and
  sourcing it afterwards would put the old tag back.
- `--profile tools pull … migrate …`: naming the services pulls the four images. The profile
  is needed so compose knows the `migrate` service at all.
- Migrations run **before** the new code starts, while the old API still serves requests. So
  every migration must also work with the old code (add a column first, use it in a later
  deploy). This is the rule from system-design §12.2. Drizzle prints a few `NOTICE … already
  exists, skipping` lines on every run. They are normal; dev shows them too.
- The tag is written into `.env` through a temp file and `mv`, so a crash can never leave a
  half-written `.env`. `chmod 600` keeps it readable by the deploy user only.
- `up -d --remove-orphans --wait` starts the new containers, removes services that no longer exist
  in the file, and waits until every health check passes. It returns an error if one does not,
  so the GitHub job turns red.
- The two `curl` lines check from the outside, through Caddy and HTTPS: the API answers `/health`,
  and the app's `index.html` has the root element. `--retry-all-errors` covers the few seconds
  in which Caddy may still be getting a certificate on the first deploy.
- `deploys.log` keeps every tag with its time. To go back, pick a line from it (A9.3).
- `image prune --filter until=168h` deletes images older than 7 days that no container uses. The
  last week's builds stay, so a rollback within a week needs no new build.

### A3.8 `infra/staging/backup.sh` and `restore.sh`

```bash
#!/usr/bin/env bash
# A copy of the staging database, kept for 7 days. cron runs it every night (see the guide).
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
```

- `exec -T`: no terminal, so the dump's bytes go to the file unchanged. With a terminal, Docker
  would change line endings and the dump would be broken.
- The `.part` file and the `mv`: if the dump fails halfway, no file named `*.dump` exists, and a
  broken file is never mistaken for a backup.
- 7 days are kept. This is staging; the files (MinIO) are not backed up. Uploaded logos and
  attachments would be lost in a full disaster, and the PDFs are made again when needed.

```bash
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
```

- The API and the worker stop first, so nothing writes while the tables are being replaced.
- The roles are not in a database dump. They already exist, because `01-roles.sh` made them when
  the volume was created. So the dump's owners, grants and RLS policies load as they were. The
  test showed this: after a restore, `omnivo_app` could still insert into `journal_entries` and
  still could not update `audit_logs`.
- `FLUSHALL` empties Valkey. Queued jobs point at rows of the database that was just replaced,
  and running them would act on data that no longer exists.

### A3.9 The GitHub Actions workflow

`.github/workflows/deploy-staging.yml`, the build:

```yaml
name: Deploy staging

# Two ways in:
#   - ci.yml calls this after its gate job passes on a push to dev (workflow_call)
#   - the "Run workflow" button in the Actions tab, to deploy any branch or commit, or to go back to
#     an earlier one (workflow_dispatch). GitHub shows the button only once this file is on main.
on:
  workflow_call:
  workflow_dispatch:
    inputs:
      ref:
        description: Branch, tag or commit to deploy
        required: true
        default: dev

# One deploy at a time. A second one waits instead of cancelling the first one halfway through.
concurrency:
  group: staging
  cancel-in-progress: false

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      tag: ${{ steps.meta.outputs.tag }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.ref || github.sha }}

      # The image tag is the full commit, so every build on staging points at one exact commit.
      # GHCR wants the owner in lower case.
      - id: meta
        run: |
          echo "tag=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
          echo "registry=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}" >> "$GITHUB_OUTPUT"

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      # The three images share their first stages. One builder builds them one after the other, so
      # the shared stages are built once. The gha cache keeps every stage for the next run.
      - name: Build and push api
        uses: docker/build-push-action@v6
        with:
          context: .
          file: infra/docker/Dockerfile
          target: api
          push: true
          tags: ${{ steps.meta.outputs.registry }}/omnivo-api:${{ steps.meta.outputs.tag }}
          cache-from: type=gha,scope=staging
          cache-to: type=gha,scope=staging,mode=max

      - name: Build and push migrate
        uses: docker/build-push-action@v6
        with:
          context: .
          file: infra/docker/Dockerfile
          target: migrate
          push: true
          tags: ${{ steps.meta.outputs.registry }}/omnivo-migrate:${{ steps.meta.outputs.tag }}
          cache-from: type=gha,scope=staging

      - name: Build and push web
        uses: docker/build-push-action@v6
        with:
          context: .
          file: infra/docker/Dockerfile
          target: web
          push: true
          # Vite writes the API's address into the app's JavaScript. It must equal API_BASE_URL in the
          # server's .env.
          build-args: VITE_API_URL=${{ vars.STAGING_API_URL }}
          tags: ${{ steps.meta.outputs.registry }}/omnivo-web:${{ steps.meta.outputs.tag }}
          cache-from: type=gha,scope=staging
```

- **Why `workflow_call`, and not `workflow_run`?** A `workflow_run` or `workflow_dispatch`
  workflow only runs from its copy on the default branch (`main`). You work on `dev`, so a
  `workflow_run` trigger would never fire. `ci.yml` calls this file instead, as a job after its
  `gate` job (below). A called workflow runs from the same commit as its caller, so the copy on
  `dev` is the one that runs.
- The "Run workflow" button (`workflow_dispatch`) appears only after this file reaches `main`.
  Until then, deploy by hand on the server (A9.3).
- `concurrency: staging` with `cancel-in-progress: false`: two quick pushes deploy one after the
  other. Cancelling a deploy halfway could stop it between the migration and the start.
- `inputs.ref || github.sha`: from `ci.yml` there is no input, so it builds the pushed commit.
  From the button it builds what you typed.
- `${GITHUB_REPOSITORY_OWNER,,}` makes the owner lower case. GHCR refuses image names with capital
  letters, and a GitHub user or org name may have them.
- `GITHUB_TOKEN` pushes to GHCR. `permissions: packages: write` allows that, so no extra secret is
  needed. The first push creates the three packages as private packages of this repository.
- The three builds run one after the other in one job, on one builder. The second and third find
  the shared stages (`deps`, `source`) already built. `cache-to … mode=max` on the first build saves
  every stage in GitHub's cache, so the next run skips the install when the lockfile did not
  change.
- `VITE_API_URL=${{ vars.STAGING_API_URL }}` comes from a repository variable (A6), not a secret:
  it is not secret, and it ends up in the app's JavaScript anyway.

The deploy:

```yaml
  deploy:
    needs: build
    runs-on: ubuntu-latest
    # The server only pulls: the token it is lent may read packages, not write them
    permissions:
      contents: read
      packages: read
    environment:
      name: staging
      url: ${{ vars.STAGING_APP_URL }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ needs.build.outputs.tag }}

      # Secrets go through env, never straight into the script, so a value is never read as shell code
      - name: Set up SSH
        env:
          SSH_KEY: ${{ secrets.STAGING_SSH_KEY }}
          KNOWN_HOSTS: ${{ secrets.STAGING_KNOWN_HOSTS }}
        run: |
          install -m 700 -d ~/.ssh
          printf '%s\n' "$SSH_KEY" > ~/.ssh/staging
          chmod 600 ~/.ssh/staging
          printf '%s\n' "$KNOWN_HOSTS" > ~/.ssh/known_hosts

      # The stack's files come from the commit being deployed. The server's .env is never touched.
      - name: Copy the stack files
        env:
          TARGET: ${{ secrets.STAGING_SSH_USER }}@${{ secrets.STAGING_SSH_HOST }}
        run: |
          scp -i ~/.ssh/staging -r \
            infra/staging/compose.yml infra/staging/Caddyfile \
            infra/staging/deploy.sh infra/staging/backup.sh infra/staging/restore.sh \
            infra/staging/postgres-init \
            "$TARGET:/srv/omnivo/"

      # The job's own token logs the server in to GHCR for this pull only. No lasting registry
      # password is kept on the server.
      - name: Deploy
        env:
          TARGET: ${{ secrets.STAGING_SSH_USER }}@${{ secrets.STAGING_SSH_HOST }}
          TAG: ${{ needs.build.outputs.tag }}
          GHCR_USER: ${{ github.actor }}
          GHCR_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          printf '%s' "$GHCR_TOKEN" | ssh -i ~/.ssh/staging "$TARGET" \
            "docker login ghcr.io -u '$GHCR_USER' --password-stdin"
          ssh -i ~/.ssh/staging "$TARGET" "cd /srv/omnivo && ./deploy.sh '$TAG'; status=\$?; docker logout ghcr.io >/dev/null; exit \$status"
```

- `environment: staging` takes the secrets from the "staging" environment (A6), shows the deploy
  on the repo's page with a link, and lets you add a required reviewer later.
- `permissions: packages: read`: the token that is lent to the server can only pull images.
- Every secret goes into the script through `env:`, never as `${{ secrets.X }}` inside the
  script text. GitHub pastes `${{ }}` into the script before it runs, so a value with a quote or
  a `$(…)` in it would run as shell code.
- `STAGING_KNOWN_HOSTS` holds the server's SSH host key. Without it, `ssh` would either ask
  (and the job would hang) or have to be told to trust any server, which lets a fake server take
  the deploy.
- `scp` copies the stack files of **this** commit, so the compose file and the images always
  match. `.env` is never copied and never overwritten. It lives only on the server.
- The server logs in to GHCR with the job's own token, which stops working when the job ends, and
  logs out after the deploy. No registry password stays on the server. `exit $status` keeps
  `deploy.sh`'s result even though `docker logout` runs after it.

`.github/workflows/ci.yml`, the new job at the end:

```diff
@@ -61,3 +61,13 @@ jobs:
 
       - name: Module boundaries
         run: pnpm boundaries
+
+  # Every push to dev that passes the gate goes to staging. Pull requests and main never deploy here.
+  deploy-staging:
+    needs: gate
+    if: github.event_name == 'push' && github.ref == 'refs/heads/dev'
+    uses: ./.github/workflows/deploy-staging.yml
+    permissions:
+      contents: read
+      packages: write
+    secrets: inherit
```

- `needs: gate`: staging only gets code that passed every CI check (lint, types, all tests,
  build, bundle size).
- The `if:` limits it to pushes to `dev`. Pull requests run CI but never deploy. A PR from a fork
  has no access to the secrets anyway, and a PR's code should not reach a shared server before it
  is merged.
- A job that calls a reusable workflow cannot widen the token's rights, so `packages: write` must
  be granted here too, not only inside `deploy-staging.yml`.
- `secrets: inherit` passes the repo's secrets to the called workflow. The environment secrets
  work because the called workflow's `deploy` job names the environment.

## A4. Check it before you push

Run these from the repo root after you have added the files:

```bash
pnpm --filter @omnivo/api typecheck
pnpm exec eslint apps/api/src/config.ts apps/api/src/configure-app.ts apps/api/src/main.ts
pnpm format            # checks the new YAML files too
pnpm --filter @omnivo/api test

# The images build (on a Mac this builds arm64, which is fine for a check)
docker build -f infra/docker/Dockerfile --target api .
docker build -f infra/docker/Dockerfile --target migrate .
docker build -f infra/docker/Dockerfile --target web --build-arg VITE_API_URL=https://api.staging.example.com .

# Optional: lint the workflows and the scripts without installing anything
docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest -no-color
docker run --rm -v "$PWD/infra/staging:/mnt" koalaman/shellcheck:stable \
  /mnt/deploy.sh /mnt/backup.sh /mnt/restore.sh /mnt/postgres-init/01-roles.sh
```

The first build takes a few minutes; later ones reuse the cached layers.

Do **not** push to `dev` yet. The new job would run and fail, because the server and the secrets
do not exist yet. Set up the server first (A5, A6), then push (A7).

## A5. Set up the server

Do this once. Commands start with `local$` (your computer) or `server$` (the server).

### A5.1 Create the server and point DNS at it

1. Create the server (Ubuntu 24.04, x86, 4 GB) with your SSH key. Note its public IPv4 address.
2. Add four DNS `A` records, each pointing at that address:

   | Name | Type | Value |
   |---|---|---|
   | `app.staging` | A | the server's IPv4 |
   | `api.staging` | A | the server's IPv4 |
   | `files.staging` | A | the server's IPv4 |
   | `mail.staging` | A | the server's IPv4 |

   If the domain is on Cloudflare, set these four records to **DNS only** (grey cloud). Then Caddy
   gets its own certificates directly, and nothing between the browser and the server changes
   requests. Cloudflare's proxy can come later, in step 25.
3. Check from your computer that all four names answer, before Caddy asks Let's Encrypt for them:

   ```bash
   local$ for h in app api files mail; do dig +short $h.staging.example.com; done
   ```

### A5.2 First login, updates and the firewall

```bash
local$  ssh root@<server-ip>
server$ apt update && apt -y upgrade
server$ timedatectl set-timezone UTC
server$ ufw allow OpenSSH && ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
server$ ufw --force enable
```

UTC keeps every log time and backup name in one zone. The app shows times in each workspace's own
time zone anyway. The firewall leaves only SSH and the web ports open. Note: ports that Docker
publishes skip `ufw`, which is one more reason that only Caddy has `ports:` in the compose file.

### A5.3 Install Docker

```bash
server$ curl -fsSL https://get.docker.com | sh
server$ docker compose version     # must print v2.24 or newer (the guide was tested on 5.4)
```

The script adds Docker's own apt repository, so `apt upgrade` keeps Docker up to date.

### A5.4 A deploy user

```bash
server$ adduser --disabled-password --gecos "" deploy
server$ usermod -aG docker deploy
server$ mkdir -p /srv/omnivo && chown deploy:deploy /srv/omnivo
```

GitHub Actions logs in as `deploy`, never as root. Be aware that the `docker` group can do
anything on the server (it can start a container that mounts `/`). So the SSH key that GitHub
holds is as strong as root. Keep it only in the GitHub environment.

### A5.5 An SSH key for GitHub Actions

Make a new key just for deploys, not your own key:

```bash
local$ ssh-keygen -t ed25519 -N "" -C "github-actions-staging" -f ./staging_deploy_key
local$ ssh root@<server-ip> "mkdir -p ~deploy/.ssh && cat >> ~deploy/.ssh/authorized_keys && chown -R deploy:deploy ~deploy/.ssh && chmod 700 ~deploy/.ssh && chmod 600 ~deploy/.ssh/authorized_keys" < ./staging_deploy_key.pub
local$ ssh -i ./staging_deploy_key deploy@<server-ip> docker ps    # must work, with no password
local$ ssh-keyscan -t ed25519 <server-ip> > ./staging_known_hosts
```

Compare the fingerprint `ssh-keygen -lf ./staging_known_hosts` prints with the one in your
provider's console (or `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server). This
makes sure the key you trust is your server's. You need `staging_deploy_key` (the private key)
and `staging_known_hosts` in A6. Delete both from your computer afterwards.

### A5.6 The stack files and `.env`

Copy the stack's files once by hand. After this, each deploy copies them, except `.env`:

```bash
local$ scp -i ./staging_deploy_key -r infra/staging/. deploy@<server-ip>:/srv/omnivo/
local$ ssh -i ./staging_deploy_key deploy@<server-ip>
server$ cd /srv/omnivo
server$ cp .env.example .env && chmod 600 .env
server$ for k in POSTGRES_PASSWORD MIGRATOR_DB_PASSWORD APP_DB_PASSWORD WORKER_DB_PASSWORD \
          BETTER_AUTH_SECRET JWT_SECRET MINIO_ROOT_PASSWORD S3_APP_SECRET; do
          sed -i "s/^$k=\$/$k=$(openssl rand -hex 32)/" .env
        done
server$ sed -i "s/^MAIL_UI_PASSWORD=\$/MAIL_UI_PASSWORD=$(openssl rand -hex 8)/" .env
server$ nano .env
```

The loop fills each empty secret with its own random value. `^$k=\$` matches only a line that is
still empty, so running the loop again never replaces a secret that is already in use. That
matters: a new database password would no longer match the role that `01-roles.sh` already
made. The Mailpit password is shorter (16 characters), because testers type it.

In `nano`, set the addresses, `ACME_EMAIL`, `MAIL_FROM_DOMAIN` and `REGISTRY`
(`ghcr.io/<your-github-user-or-org>`, lower case). Leave `IMAGE_TAG=` empty. Then check that no
line is empty except `IMAGE_TAG`:

```bash
server$ grep -E '^[A-Z_]+=$' .env      # must print only IMAGE_TAG=
```

`.env` is now the only copy of these secrets. If you lose it, you lose the database passwords,
and so access to the data. Keep a copy in your password manager.

### A5.7 Nightly backups

```bash
server$ mkdir -p /srv/omnivo/backups
server$ crontab -e
```

Add this line (03:00 UTC, which is 09:00 in Dhaka):

```text
0 3 * * * /srv/omnivo/backup.sh >> /srv/omnivo/backups/backup.log 2>&1
```

## A6. Set up GitHub

In the repo on GitHub:

1. **Settings → Environments → New environment**, named `staging`. Under "Environment secrets"
   add:

   | Secret | Value |
   |---|---|
   | `STAGING_SSH_HOST` | the server's IPv4 address |
   | `STAGING_SSH_USER` | `deploy` |
   | `STAGING_SSH_KEY` | the whole content of `staging_deploy_key` (the private key, with its BEGIN and END lines) |
   | `STAGING_KNOWN_HOSTS` | the whole content of `staging_known_hosts` |

2. **Settings → Secrets and variables → Actions → Variables** (repository variables):

   | Variable | Value |
   |---|---|
   | `STAGING_API_URL` | `https://api.staging.example.com`, exactly `API_BASE_URL` in the server's `.env` |
   | `STAGING_APP_URL` | `https://app.staging.example.com` |

   `STAGING_API_URL` is a repository variable, not an environment variable, because the `build`
   job uses it and that job has no environment. If it differs from the server's
   `API_BASE_URL`, the app calls one address and the server's CORS allows another, and every
   request fails in the browser.

3. If the repo belongs to an organization: **Settings → Actions → General → Workflow
   permissions**. The workflows ask for `packages: write` themselves. If the organization blocks
   that, allow it there.

## A7. The first deploy

Commit the files (A2, A3) and push to `dev`. Then watch **Actions → CI**: after the `gate` job, the
`deploy-staging` job builds and deploys. The first build takes longest, because it installs every
package; later builds reuse GitHub's cache.

On the very first deploy, on the server:

- Postgres starts with an empty volume and runs `01-roles.sh`.
- `migrate` applies every migration and syncs the permission catalog.
- `storage-init` makes the bucket and the app's key.
- Caddy gets four certificates. The first HTTPS request can take a few seconds.

Then check it yourself:

```bash
local$ curl -s https://api.staging.example.com/health          # {"status":"ok"}
local$ curl -sI https://app.staging.example.com/sw.js | grep -i cache-control   # no-cache
```

Open `https://app.staging.example.com`, create a workspace, and check that:

1. The welcome email is in `https://mail.staging.example.com` (user `tester`, the
   `MAIL_UI_PASSWORD` from `.env`).
2. **Settings → Logo**: an upload works and the logo shows. This checks the files host,
   CORS and the signed links.
3. A quotation's **Send → Download PDF** gives a PDF with Bangla text drawn right. This checks the
   worker, the fonts and storage.
4. **Workspace → Audit log** shows your real IP address, not `172.x.x.x`.

When all four work, staging is ready for testers. Send them Part B with the two addresses and
the Mailpit password.

## A8. Every deploy after that

Push to `dev`. Nothing else is needed. Each deploy:

1. builds the three images for the commit and pushes them to GHCR,
2. copies the stack files to `/srv/omnivo`,
3. pulls the images, runs the new migrations, and starts the new containers,
4. checks the API and the app from outside, and logs the tag in `deploys.log`.

The API is down for a few seconds while its container is replaced. A request in that moment
fails like a short network error, and trying again works. Open tabs show the update notice
("A new version of Omnivo is ready…") and keep working until the tester reloads.

Tell testers before a deploy that changes how something works, so they do not report the change
as a bug.

## A9. Running staging

All commands run on the server, in `/srv/omnivo`, as `deploy`.

### A9.1 See what is running and read the logs

```bash
docker compose ps                         # every service and its health
docker compose logs -f --tail 100 api     # the API (also: worker, web, db, storage, mail)
docker compose logs web | grep '"uri":"/invoices'   # Caddy's request log, one JSON line each
tail deploys.log                          # which commit is deployed since when
```

To find a tester's problem, ask for the time and the page. Every API response carries an
`x-request-id` header (an error's body has it as `requestId` too). Caddy's log has every request
with that header, and the API logs each server error (5xx) with its stack and the same id:

```bash
docker compose logs api | grep <request-id>
docker compose logs web | grep <request-id>
```

Errors of the worker's jobs (emails, PDFs, exports) are in `docker compose logs worker`.

### A9.2 Look at the data

```bash
docker compose exec db psql -U postgres -d omnivo
```

`postgres` is the superuser, so it sees every workspace and skips RLS. Use it to look, never to
fix data by hand. Edits there skip the audit log and every check of the API. The queries in
`COMMANDS.md` work here as they are; only the `docker compose -f …` part is different.

### A9.3 Go back to an earlier build

- **Within 7 days**, on the server: pick a tag from `deploys.log`, then
  `./deploy.sh <that-tag>`. The images are still on the server.
- **Any commit**: once `deploy-staging.yml` is on `main`, use **Actions → Deploy staging → Run
  workflow** with the commit. It builds that commit and deploys it.

Migrations only go forward. If the build you go back to is older than a migration that already
ran, the old code meets a newer schema. That usually works, because the migrations are written to
work with the old code (A3.7). If it does not, restore the backup from before the deploy (A9.4)
and then deploy the old build.

### A9.4 Restore a backup

```bash
ls backups/
./restore.sh backups/omnivo-2026-11-05-0300.dump
```

Everything written after that backup is lost. Tell the testers first.

Do one test restore after the first week, so that you know the backups work when you need them.

### A9.5 Start staging again from empty

For example before a new round of testing:

```bash
docker compose down
docker volume rm omnivo-staging_db-data omnivo-staging_cache-data \
  omnivo-staging_storage-data omnivo-staging_mail-data
./deploy.sh "$(grep '^IMAGE_TAG=' .env | cut -d= -f2)"
```

This deletes every workspace, file and email. The `caddy-data` volume is left alone on purpose,
so the certificates stay (Let's Encrypt limits new ones). The passwords in `.env` stay the same,
and `01-roles.sh` runs again on the new, empty database volume.

### A9.6 Change a setting or a secret

Edit `.env`, then `docker compose up -d`. Compose restarts only the containers whose settings
changed. Two exceptions:

- **A database password**: the role inside Postgres keeps the old one. Change it there first,
  for example `ALTER ROLE omnivo_app PASSWORD '<new>'` in psql, then in `.env`.
- **`BETTER_AUTH_SECRET` or `JWT_SECRET`**: everyone is signed out and must sign in again.

### A9.7 Disk and updates

- `df -h /` now and then. The database, the backups (7 days) and the images (7 days) are the
  largest parts.
- `apt update && apt -y upgrade` once a month, then `reboot` if it asks. Every service has
  `restart: unless-stopped`, so the stack comes back by itself.

## A10. When something goes wrong

| What you see | Why | What to do |
|---|---|---|
| The job fails at "Deploy" with `Host key verification failed` | `STAGING_KNOWN_HOSTS` is wrong or the server was rebuilt | Run `ssh-keyscan` again (A5.5) and update the secret |
| `required variable … is missing a value` | A line in `.env` is empty | Fill it in (A5.6) |
| `pull access denied` for a `ghcr.io/…` image | `REGISTRY` has capital letters or the wrong owner | `REGISTRY` must be `ghcr.io/<owner>` in lower case, the same as in the job's log |
| Caddy logs `challenge failed` and the browser shows a certificate error | DNS does not point at the server yet, or Cloudflare's proxy is on | Check `dig` (A5.1). Set the records to DNS only. Then `docker compose restart web` |
| The app loads but every action fails, and the browser console shows a CORS error | `STAGING_API_URL` (build) differs from `API_BASE_URL` / `APP_ORIGIN` (server) | Make them the same, then deploy again (the app must be rebuilt) |
| Signed in, but a reload signs you out | The app and the API are not on the same parent domain, so the `SameSite=Strict` cookie is not sent | Use `app.` and `api.` under the same domain (A1) |
| A logo upload fails with `SignatureDoesNotMatch` (403) | The `Host` reaching MinIO differs from `S3_ENDPOINT`'s host | Do not change the `Host` header in the Caddyfile. `S3_ENDPOINT` must be the public files address |
| `migrate` fails and the deploy stops | A migration error. The old build keeps running | `docker compose run --rm migrate` shows the error. Fix it in code and push again |
| Emails do not show in Mailpit | The worker is not running | `docker compose ps worker` and `docker compose logs worker` |
| The audit log shows `172.x.x.x` | `TRUST_PROXY` is not on, or the A2 change is not in this build | Check `TRUST_PROXY: 'true'` in `compose.yml` and that A2 is committed |

---

# Part B: for the testers

This part is for the people who test Omnivo on staging. You do not need to know how it is built.

## B1. Where to go

| What | Address |
|---|---|
| Omnivo | `https://app.staging.example.com` |
| The email inbox | `https://mail.staging.example.com` (user and password: ask the person who runs staging) |

The email inbox is shared. It holds **every** email that staging sends, to anyone: invitations,
welcome emails, documents sent by email. No email leaves staging. So you can use any email
address when you sign up or invite someone, even one that does not exist. Use one with your own
name in it (`sumi.akter@example.com`), so that your emails are easy to find and nobody else uses
the same address.

## B2. Rules

- **Never enter real data.** No real customers, phone numbers, prices or bank details. Use made-up
  names, like "Sylhet Pharmacy" or "Rahman Garments".
- **Staging can be emptied.** Before a new round of testing, everything may be deleted. Do not
  keep anything there that you need.
- **It changes often.** A new version can arrive several times a day. When you see "A new version
  of Omnivo is ready", save what you are doing and click Reload.
- **Do not share the addresses** outside the testing group.
- Staging is slower than production will be: it runs on one small server.

## B3. Getting an account

There are two ways. The person who runs staging tells you which to use.

**Join a shared workspace** (best for testing roles and approvals together):

1. The workspace owner opens **Workspace → Team → Invite people** and invites your address with a
   role.
2. Open the email inbox, find the invitation to your address, and click its link.
3. Set your name and password. You are in the workspace.

**Make your own workspace** (best for testing set-up, or when you need the Owner role):

1. Open the app and click **Create a workspace** on the sign-in page.
2. Pick a workspace address that includes your name (`sumi-test`), so it is easy to tell apart.
3. Choose the business type and follow the set-up steps.

To sign in later you need the workspace address, your email and your password.

## B4. What to test

Test like a real user of that kind of business would work, not just one screen at a time. For
example: make a product, buy it from a supplier, receive it into stock, sell it, take the
payment, and check the reports. Agree in the group who tests which area, so every area gets
covered.

| Area | Where in the app | Look especially at |
|---|---|---|
| Set-up | Sign up, the set-up steps, Settings, Branches, Numbering | Each business type gives sensible roles and accounts |
| People and rights | Team, Roles, Approval levels, Audit log | A role without a right really cannot see or do it |
| Accounting | Chart of accounts, Journal, Ledger, Opening balances, Year-end close | Totals add up; a closed period cannot be changed |
| Reports | Trial balance, Profit and loss, Balance sheet, Exports, Overview | Numbers match the documents; Excel and PDF exports download |
| Products and stock | Products, Categories, Units, Imports, Stock, Adjustments, Transfers, Batches and expiry, Valuation | Units and packs convert right; batch and expiry rules |
| Sales | Customers, Price lists, Quotations, Sales orders, Deliveries, Invoices, Money receipts, Sales returns, Credit notes, Refunds | Credit limits, partial deliveries, overdue invoices |
| Purchase | Suppliers, Requisitions, Purchase orders, Goods receipts, Supplier bills, Supplier payments, Purchase returns, Debit notes, Approvals | Approvals by amount; prices that differ from the order |
| Documents | Print, Send → Download PDF, Email, Share on WhatsApp | Bangla text in PDFs; the shared link opens without a login |
| POS | POS registers, POS cash reasons, the POS screen, POS sales, shifts, returns | Shifts, the cash count, receipts, returns and exchanges |
| Offline | Sync, My devices, Devices, the PIN and the lock screen | See B5 |
| Language and screens | The language switch, phone and tablet sizes, light and dark | Bangla text, numbers and dates; nothing cut off on a phone |

## B5. Testing offline

Omnivo keeps working without the internet for POS, customers and sales order drafts. To test
this:

1. Sign in. If it asks which branch the device is in, pick one. Set a PIN for the device when it
   asks.
2. Wait until **Sync** in the sidebar says "Online" and nothing is waiting.
3. Turn off Wi-Fi (or, in Chrome, DevTools → Network → Offline).
4. Work: make a POS sale, a customer or a sales order draft. The forms say "Save on this device".
5. Reload the page while offline: it opens and asks for your PIN.
6. Turn Wi-Fi back on. The **Sync** page shows the changes being sent. Check that they arrived.

You can also install Omnivo as an app: in Chrome or Edge from the account menu (**Install app**),
on an iPhone from Safari (Share → Add to Home Screen).

## B6. Reporting a problem

Report each problem on its own, with:

1. **What you did**, step by step, so someone else can do it again.
2. **What you expected** and **what happened instead**.
3. **When** it happened (date and time, to the minute). The logs are searched by time.
4. **Where**: the workspace address, the page's address (copy it from the browser), and the
   language.
5. **Your device and browser**: for example "Windows, Chrome" or "iPhone, Safari", and whether you
   were offline.
6. **A screenshot** or a short screen recording.

If you know the browser's developer tools: open **Network**, click the request that failed, and
copy its `x-request-id` response header. With it, the exact error can be found in the logs
straight away.

A problem that loses or changes data (wrong totals, a missing document, stock that does not
match) is the most important kind. Say so in the report's first line.
