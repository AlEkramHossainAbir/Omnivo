# ADR 0001: PostgreSQL over MongoDB

- **Status:** Accepted
- **Date:** 2026-09-19
- **Context:** Choosing the primary database for Omnivo, a multi-tenant ERP.

## Decision

Omnivo uses **PostgreSQL** as its primary database. We use `JSONB` columns where we need document-style flexibility, such as per-tenant custom fields.

## Why PostgreSQL over MongoDB

MongoDB is a good database, and it now supports multi-document transactions and schema validation. For ERP data, though, PostgreSQL does the job with less effort and less risk:

| ERP need | PostgreSQL | MongoDB |
|---|---|---|
| **Highly related data** (invoice → lines → product → tax → account → customer) | Joins and foreign keys are built in; the database prevents a line pointing to a deleted product | `$lookup` is slower and clumsier; the app has to enforce the relationships itself |
| **Money-critical transactions** (one sale writes invoice, stock and ledger together) | Transactions are the default, mature and cheap | Supported since v4.0, but with more overhead and limits; its design favours single-document writes |
| **Accounting rules** (debit = credit, no duplicate invoice numbers per tenant) | `CHECK`, `UNIQUE (tenant_id, invoice_no)`, triggers and constraints enforce this in the database | Mostly enforced in application code, and a bug means the books don't balance |
| **Exact money values** | `NUMERIC(19,4)` | `Decimal128` exists but is awkward to use in the driver and ORMs |
| **Multi-tenant isolation** | **Row-level security**: the database blocks cross-tenant reads even if the code forgets a filter | No equivalent; isolation depends entirely on the application |
| **Reports** (P&L, aging, stock valuation) | SQL with `GROUP BY`, window functions, CTEs and materialized views | Aggregation pipelines work but are harder to write and maintain |
| **Flexible fields** (per-tenant custom fields) | `JSONB` with indexes gives document flexibility where needed | Its main strength |

**In short:** an ERP is mostly structured, relational, money-critical data, which is the kind of data PostgreSQL was designed for. `JSONB` covers the flexible part, so we get most of MongoDB's benefit without the downsides.

MongoDB is a better fit for content-heavy apps, event logs, product catalogs with widely varying shapes, or apps where each record stands alone.

## Hosting: the equivalent of MongoDB Atlas

Hosting is not a reason to choose MongoDB. PostgreSQL has as many hosted options as Atlas, and more:

| Service | Good for | Notes |
|---|---|---|
| **Neon** | Starting out, MVP | Serverless; free tier; creates a database branch per PR (useful for preview environments). The free tier sleeps when idle, so the first request after a pause is slow |
| **Supabase** | Starting out | PostgreSQL plus a dashboard, auth and storage; free tier (projects pause when inactive) |
| **DigitalOcean Managed PostgreSQL** | MVP to growth | Simple, predictable price; has a Singapore region; standby node and PITR |
| **AWS RDS / Aurora PostgreSQL** | Growth to scale | Singapore region; read replicas, PITR, Multi-AZ |
| **Google Cloud SQL / Azure Flexible Server** | Same as RDS | Pick whichever cloud we standardize on |
| **Crunchy Bridge, Aiven** | Managed by PostgreSQL specialists | Strong support and tooling |

All of these give us automatic backups, point-in-time restore, monitoring, read replicas and one-click upgrades, the same convenience Atlas offers.

Because it's standard PostgreSQL everywhere, moving between providers is a `pg_dump`/restore or a replication cutover. That makes PostgreSQL easier to leave than Atlas.

## Hosting plan for Omnivo

1. **Development and MVP:** Neon or Supabase free tier. Neon's per-PR branches fit the CI plan.
2. **First paying customers:** DigitalOcean Managed PostgreSQL or AWS RDS in the **Singapore** region, with a standby node and PITR turned on.
3. **At scale:** AWS Aurora PostgreSQL or RDS with read replicas (see [system-design.bn.md](../system-design.bn.md), section 5).

## Consequences and caveats

- The provider must let us create a **non-superuser application role**, because row-level security doesn't apply to superusers or `BYPASSRLS` roles.
- The provider's connection pooler must work in **transaction mode** with `set_config('app.tenant_id', ..., true)`. Neon, Supabase, DigitalOcean and RDS (with PgBouncer or RDS Proxy) all support this.
- Write scaling is limited to one primary until we introduce sharding or Citus. The capacity estimate in the design doc shows this is not a concern before the scale stage.
- Schema changes need migrations and care on large tables (expand, migrate, contract).
