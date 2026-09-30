# Commands

Quick reference for commands used often in this repo. Add to this file as new
important commands come up.

## Run the full stack (db + backend + frontend)

0. Make sure Docker Desktop is running first — `pnpm db:up` needs the daemon.
   If you get `failed to connect to the docker API ... no such file or
   directory`, Docker Desktop isn't started:

   ```sh
   open -a Docker
   ```

   Wait for the whale icon in the menu bar to go steady before continuing.

1. Start infra (Postgres, Valkey cache, Mailpit, MinIO) in Docker, and wait for
   health checks:

   ```sh
   pnpm db:up
   ```

2. Start backend and frontend dev servers together (Turborepo runs both `dev`
   tasks in parallel):

   ```sh
   pnpm dev
   ```

   - API (`@omnivo/api`, NestJS/Fastify): http://localhost:3000
   - App (`@omnivo/app`, Vite/React): http://localhost:5173
   - Kitchen sink (every shared ui component, both themes and languages):
     http://localhost:5173/kitchen-sink — only in `pnpm dev`, needs a signed-in user
   - API docs (Scalar, from the contract registry): http://localhost:3000/docs — dev only
   - MinIO console: http://localhost:9001 (omnivo / omnivo-dev-secret) — uploaded files are under the
     omnivo bucket, tenants/<tenant-id>/…
   - Mailpit (every email the API sends): http://localhost:8025

   To run the app alone, without the API, Postgres or Docker:

   ```sh
   pnpm dev:mock   # the app alone on MSW mocks — no API, Postgres or Docker needed
   ```

   Mock sign-in: any password works except `wrong-password`; the sign-up address
   `rahman-garments` is already taken.

Stop infra when done:

```sh
pnpm db:down
```

## Database

```sh
pnpm db:up      # start db + cache + mail + storage containers
pnpm db:down    # stop them
pnpm db:psql    # open a psql shell to the omnivo db
pnpm db:psql:app # psql as omnivo_app (NOBYPASSRLS) — RLS applies, use to see isolation
pnpm db:migrate # apply pending migrations (as omnivo_migrator), then sync the permission catalog
pnpm db:seed    # idempotent seed: Acme tenant, admin user, Owner role + permissions
pnpm db:generate --name <name> # new migration from schema changes (never hand-write the SQL)
```

The seeded `admin@acme.omnivo.app` has no password, so it can't sign in. To see
the login flow, create a new workspace from the sign-up page.

## Permission cache (Valkey)

```sh
# list cached permission sets: t:<tenant-id>:perm:<user-id>
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli --scan --pattern 't:*'
# seconds left before a cached set expires (starts at 600)
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli ttl 't:<tenant-id>:perm:<user-id>'
```

## Checks

```sh
pnpm typecheck  # tsc --noEmit across all workspaces
pnpm lint       # eslint .
pnpm format     # prettier --check .
pnpm test       # vitest unit tests across all workspaces (no Docker needed)
pnpm test:integration # API integration tests on Testcontainers (Docker must be running)
pnpm test:tenant-leak # RLS + HTTP-level tenant isolation tests (Docker must be running)
pnpm test:e2e     # Playwright on the MSW mocks, desktop + 390px — no API or Docker needed
pnpm --filter @omnivo/app exec playwright install chromium   # once per machine, before the first test:e2e
pnpm build      # build every package and app
pnpm test:bundle-size # build the app, then fail if first-load JS > 200 KB gz or a route chunk > 100 KB gz
pnpm boundaries # dependency-cruiser on apps/packages
pnpm dedupe --check # fail if the lockfile has duplicate copies (e.g. drizzle-orm)
pnpm gen:openapi  # rewrite packages/contracts/openapi.json from the route registry — commit it
pnpm test:openapi # fail if openapi.json is out of date, and validate it as OpenAPI 3.1
```
