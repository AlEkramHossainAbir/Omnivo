# Omnivo

**Omnivo is a multi-tenant, cloud ERP built for small and mid-sized businesses. It is fast, light, works offline, and runs well on mobile.**

One platform for accounting, inventory, sales, purchasing, POS, HR and payroll. Every company (tenant) gets its own isolated workspace, such as `acme.omnivo.app`, and can keep working when the internet drops.

> 📘 The full system design, architecture decisions, scaling strategy and roadmap are in Bangla: **[docs/system-design.bn.md](docs/system-design.bn.md)**
>
> 🧭 Architecture decision records (ADRs) are in [docs/adr/](docs/adr/). The first is [0001: PostgreSQL over MongoDB](docs/adr/0001-postgresql-over-mongodb.md).

---

## What we are building

| Product | Description | Audience |
|---|---|---|
| **Omnivo App** | The ERP web app (PWA). Offline-first, mobile responsive. | Tenant users |
| **Omnivo API** | Multi-tenant backend (modular monolith) | App, integrations |
| **Omnivo Website** | Marketing site, landing page, pricing, blog, docs, and checkout where customers buy plans, modules and add-ons | Prospects, customers |
| **Omnivo Admin** | Internal console for tenants, billing and support. It also manages the product catalog: which plans, modules and add-ons exist, their prices, and which ones the website shows | Omnivo team |
| **Omnivo Mobile** *(later)* | Native wrapper around the PWA (Capacitor) for POS and field sales | Tenant users |

## Core principles

1. **Multi-tenant from day one.** Every row, cache key, job, file and log line is scoped to a tenant.
2. **Fast by default.** p95 API latency under 200 ms. The initial app JS bundle is under 200 KB gzipped. Pages load instantly from the local cache.
3. **Offline-first where it matters.** POS, inventory counts, sales orders and expenses keep working without a connection and sync when it comes back.
4. **Modular monolith first, microservices only when proven necessary.**
5. **Money is sacred.** Double-entry ledger, no floats, and immutable audit trails.
6. **Boring, proven technology.** PostgreSQL, Redis, TypeScript and Docker.

## Modules

**Phase 1 (MVP):** Core platform (tenants, users, roles and permissions, audit log), Accounting and Finance, Inventory, Sales and Invoicing, Purchasing, POS, Reports and Dashboard

**Phase 2:** HR and Payroll, CRM, Expense management, Multi-branch and multi-warehouse, Local tax and VAT compliance

**Phase 3:** Manufacturing (BOM, work orders), Projects and Timesheets, E-commerce integrations, Public API and Webhooks, AI assistant and forecasting

## Tech stack (summary)

| Layer | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Language | TypeScript (end to end) |
| ERP frontend | React + Vite, TanStack Router/Query/Table, Tailwind CSS, shadcn/ui |
| Offline | PWA (Workbox service worker), IndexedDB, sync engine using an outbox pattern |
| Website / landing | Astro (static, near-zero JS) |
| Backend | NestJS on the Fastify adapter (modular monolith) |
| Validation / contracts | Zod schemas shared by frontend and backend |
| ORM | Drizzle ORM |
| Database | PostgreSQL 17 with Row-Level Security; Citus for sharding later |
| Connection pooling | PgBouncer |
| Cache / queue | Redis (Valkey) + BullMQ |
| Search | Meilisearch (later OpenSearch) |
| Analytics / reports | ClickHouse (from Phase 2) |
| File storage | S3-compatible storage (Cloudflare R2 / AWS S3) |
| Auth | OIDC (Zitadel or Keycloak), short-lived JWT, RBAC |
| Billing | Stripe + SSLCommerz / bKash (Bangladesh) |
| Infrastructure | Docker, Kubernetes (k3s → EKS/GKE), OpenTofu (Terraform) |
| CDN / edge / WAF | Cloudflare |
| CI/CD | GitHub Actions, Argo CD |
| Observability | OpenTelemetry, Prometheus, Grafana, Loki, Tempo, Sentry |

The Bangla design document explains the reason, benefits and trade-offs behind each choice.

## High-level architecture

```mermaid
flowchart LR
  U[Users - Browser / PWA / Mobile] --> CF[Cloudflare CDN + WAF]
  CF --> WEB[Website - Astro, catalog pages from API]
  CF --> APP[ERP App - static PWA bundle]
  CF --> LB[Load Balancer / Ingress]
  LB --> API1[API pod]
  LB --> API2[API pod]
  WEB -- published catalog --> LB
  API1 & API2 --> PGB[PgBouncer]
  PGB --> PG[(PostgreSQL primary)]
  PG --> PGR[(Read replicas)]
  API1 & API2 --> R[(Redis)]
  API1 & API2 --> Q[BullMQ queue]
  Q --> W[Workers - reports, email, sync, imports]
  W --> PG
  W --> S3[(Object storage)]
  PG -. CDC .-> CH[(ClickHouse - analytics)]
```

## Planned repository structure

```
omnivo/
├── apps/
│   ├── web/            # Astro — marketing site, landing, pricing, blog
│   ├── app/            # React + Vite — ERP PWA
│   ├── admin/          # React — internal admin console (tenants, billing, product catalog)
│   ├── api/            # NestJS — modular monolith
│   └── worker/         # Background jobs (BullMQ)
├── packages/
│   ├── ui/             # Shared design system (shadcn/ui + Tailwind)
│   ├── contracts/      # Zod schemas and shared types (API contracts)
│   ├── db/             # Drizzle schema, migrations, seed
│   ├── sync/           # Offline sync engine (client + server protocol)
│   ├── i18n/           # English + Bangla translations
│   └── config/         # Shared eslint, tsconfig, tailwind presets
├── infra/
│   ├── docker/         # Dockerfiles, docker-compose for local dev
│   ├── k8s/            # Helm charts / manifests
│   └── terraform/      # OpenTofu IaC
├── docs/
│   └── system-design.bn.md
└── .github/workflows/  # CI/CD
```

## Pricing (draft)

| Plan | Target | Includes |
|---|---|---|
| **Free** | Freelancers, trial | 1 user, 1 branch, basic accounting and invoicing |
| **Starter** | Small shops | Up to 5 users, Accounting, Inventory, Sales, POS |
| **Growth** | Growing SMBs | Up to 25 users, all Phase 1–2 modules, multi-branch, API |
| **Enterprise** | Large businesses | Unlimited users, dedicated database, SSO, SLA, custom domain |

Paid plans are billed monthly or yearly (yearly gets 2 months free). Add-on modules can be purchased separately.

The table above is only a starting point. Plans, prices and what the website shows are **not hard-coded**: they live in the product catalog and are managed from the Admin panel. Pricing and product pages are rendered on the server, cached at the CDN, and refreshed when an admin publishes a change. Prices are versioned, so existing subscribers keep their price when it changes. Details are in section 13.3 of [docs/system-design.bn.md](docs/system-design.bn.md).

## Getting started

> The codebase is not scaffolded yet. The intended local workflow is:

```bash
pnpm install
docker compose -f infra/docker/docker-compose.yml up -d   # postgres, redis, meilisearch
pnpm db:migrate
pnpm dev                                                  # runs all apps via turbo
```

## Roadmap

- [ ] Monorepo scaffold, CI, local Docker environment
- [ ] Core platform: tenancy, auth, RBAC, audit log
- [ ] Accounting core (chart of accounts, journal, ledger)
- [ ] Inventory + Sales + Purchasing
- [ ] POS with offline support
- [ ] Website + pricing + billing integration
- [ ] Beta launch
- [ ] HR and Payroll, CRM, VAT compliance
- [ ] Manufacturing, public API, integrations

## License

Proprietary © Omnivo. All rights reserved.
