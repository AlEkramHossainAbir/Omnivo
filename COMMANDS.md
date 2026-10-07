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
   - Mailpit (every email the worker sends): http://localhost:8025

   `pnpm dev` also starts the worker (`@omnivo/api:dev:worker` in the log): it sends the emails and runs the
   background jobs. To run it alone: `pnpm --filter @omnivo/api dev:worker`.

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

## Look at the data

Three ways to see what is in the database.

**Drizzle Studio** (browser UI, already set up in the repo):

```sh
pnpm db:studio   # then open the link it prints, usually https://local.drizzle.studio
```

Studio connects as `omnivo_migrator`. Tenant tables (`roles`, `branches`, `invitations` and so on) have
forced row-level security, so Studio may show them empty. `tenants` and `users` have no RLS and show
normally. To see every row of every workspace, use a client that connects as `postgres`.

**A desktop client** (TablePlus, DBeaver, pgAdmin or the VS Code PostgreSQL extension). The `postgres`
superuser bypasses RLS, so all workspaces are visible. Use it to look, not to edit: edits skip the app's
audit log and permission checks.

| Field    | Value       |
| -------- | ----------- |
| Host     | `localhost` |
| Port     | `5432`      |
| Database | `omnivo`    |
| User     | `postgres`  |
| Password | `postgres`  |

**The terminal** (no install):

```sh
pnpm db:psql   # psql shell as postgres
```

Useful inside psql: `\dt` lists tables, `\d tenants` shows the columns of one table,
`SELECT * FROM tenants;` shows rows, and `\q` quits.

```sh
# the journal: entries per status, and any posted entry that does not balance (should be none)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, e.status, count(*) FROM journal_entries e JOIN tenants t ON t.id = e.tenant_id GROUP BY 1, 2"
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT e.number, sum(l.debit) - sum(l.credit) AS out_by FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id WHERE e.status = 'posted' GROUP BY e.number HAVING sum(l.debit) <> sum(l.credit)"
# exports: per person and status (a 'pending' one older than a minute means the worker is not running)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT u.email, x.report, x.format, x.status, x.created_at FROM report_exports x JOIN users u ON u.id = x.requested_by ORDER BY x.id DESC LIMIT 20"
# closing entries in force (one per closed year)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, e.number, e.date FROM journal_entries e JOIN tenants t ON t.id = e.tenant_id WHERE e.source = 'year_close' AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reversal_of_id = e.id)"
# stock balances that do not match their movements (should print nothing; the trigger keeps them equal)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT b.tenant_id, b.warehouse_id, b.variant_id, b.batch_id, b.quantity, m.total FROM stock_balances b LEFT JOIN LATERAL (SELECT coalesce(sum(quantity), 0) AS total FROM stock_movements m WHERE m.tenant_id = b.tenant_id AND m.warehouse_id = b.warehouse_id AND m.variant_id = b.variant_id AND m.batch_id IS NOT DISTINCT FROM b.batch_id) m ON true WHERE b.quantity <> m.total"
# transfers still on the road, oldest first
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, s.number, s.sent_on FROM stock_transfers s JOIN tenants t ON t.id = s.tenant_id WHERE s.status = 'in_transit' ORDER BY s.sent_on"
# items whose stock_values row differs from its movements (should print nothing; the trigger keeps them equal)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT v.tenant_id, v.variant_id, v.quantity, v.value, m.quantity AS moved, m.value AS moved_value FROM stock_values v LEFT JOIN LATERAL (SELECT coalesce(sum(quantity), 0) AS quantity, coalesce(sum(value), 0) AS value FROM stock_movements m WHERE m.tenant_id = v.tenant_id AND m.variant_id = v.variant_id) m ON true WHERE v.quantity <> m.quantity OR v.value <> m.value"
# stock value per workspace, next to its inventory account's balance (the valuation page's check)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, (SELECT coalesce(sum(value), 0) FROM stock_values v WHERE v.tenant_id = t.id) AS stock, (SELECT coalesce(sum(l.debit - l.credit), 0) FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id WHERE l.tenant_id = t.id AND a.purpose = 'inventory' AND e.status = 'posted') AS inventory_account FROM tenants t"
# receivable lines posted without a customer, per workspace (from before step 15a; decision 15 of the guide)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(*) AS lines, sum(l.debit - l.credit) AS amount FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN ledger_accounts a ON a.tenant_id = l.tenant_id AND a.id = l.account_id JOIN tenants t ON t.id = l.tenant_id WHERE a.purpose = 'accounts_receivable' AND e.status = 'posted' AND l.party_id IS NULL GROUP BY t.slug"
# the 20 customers who owe the most (posted lines only)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, p.code, p.name, sum(l.debit - l.credit) AS balance FROM journal_lines l JOIN journal_entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id JOIN parties p ON p.tenant_id = l.tenant_id AND p.id = l.party_id JOIN tenants t ON t.id = l.tenant_id WHERE e.status = 'posted' GROUP BY t.slug, p.code, p.name ORDER BY balance DESC LIMIT 20"
```

## Permission cache (Valkey)

```sh
# list cached permission sets: t:<tenant-id>:perm:<user-id>
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli --scan --pattern 't:*'
# seconds left before a cached set expires (starts at 600)
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli ttl 't:<tenant-id>:perm:<user-id>'
```

## Worker and queues (Valkey)

```sh
# waiting outbox rows (should be 0 a second after any click)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT type, created_at FROM outbox_events WHERE published_at IS NULL"
# accounts per workspace (0 = the chart job has not run yet)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(a.id) FROM tenants t LEFT JOIN ledger_accounts a ON a.tenant_id = t.id GROUP BY t.slug"
# ask the worker to make a missing chart again (it does nothing if the chart exists)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "INSERT INTO outbox_events (id, tenant_id, type, payload) SELECT gen_random_uuid(), id, 'workspace.chart_requested', '{}' FROM tenants WHERE slug = '<slug>'"
# VAT rates per workspace (0 rates = the VAT rates job has not run yet; defaults is always 1 after it)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "SELECT t.slug, count(r.id) AS rates, count(*) FILTER (WHERE r.is_default) AS defaults FROM tenants t LEFT JOIN tax_rates r ON r.tenant_id = t.id AND r.archived_at IS NULL GROUP BY t.slug"
# ask the worker to make the starting VAT rates again (it does nothing if the workspace has any rate)
docker compose -f infra/docker/docker-compose.yml exec db psql -U postgres -d omnivo -c "INSERT INTO outbox_events (id, tenant_id, type, payload) SELECT gen_random_uuid(), id, 'workspace.tax_rates_requested', '{}' FROM tenants WHERE slug = '<slug>'"
# BullMQ's keys: bull:<queue>:completed / :failed (sorted sets), bull:<queue>:<job-id> (one job)
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli zcard bull:email:failed
docker compose -f infra/docker/docker-compose.yml exec cache valkey-cli hget bull:email:<job-id> failedReason
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
