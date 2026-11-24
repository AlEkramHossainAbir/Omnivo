# Omnivo — সিস্টেম ডিজাইন ও আর্কিটেকচার গাইড (বাংলা)

> **Omnivo**: মাল্টি-টেন্যান্ট, অফলাইন-সাপোর্টেড, মোবাইল-ফ্রেন্ডলি, হালকা ও দ্রুত ক্লাউড ERP।
> এই ডকুমেন্টটি একজন সিস্টেম ডিজাইনার ও DevOps ইঞ্জিনিয়ারের দৃষ্টিকোণ থেকে লেখা। এখানে কী ব্যবহার করবেন, কেন করবেন, তার সুবিধা কী, কোথায় সমস্যা হতে পারে আর কীভাবে ধাপে ধাপে মিলিয়ন ইউজার পর্যন্ত স্কেল করবেন, সব আছে।

---

## সূচিপত্র

0. [এক নজরে মূল সিদ্ধান্ত (TL;DR)](#০-এক-নজরে-মূল-সিদ্ধান্ত-tldr)
1. [লক্ষ্য ও Non-Functional Requirements](#১-লক্ষ্য-ও-non-functional-requirements)
2. [সামগ্রিক আর্কিটেকচার: কেন Modular Monolith](#২-সামগ্রিক-আর্কিটেকচার-কেন-modular-monolith)
3. [Tech Stack: কী, কেন, সুবিধা, সমস্যা](#৩-tech-stack-কী-কেন-সুবিধা-সমস্যা)
4. [Multi-Tenancy ডিজাইন](#৪-multi-tenancy-ডিজাইন)
5. [মিলিয়ন ইউজার হ্যান্ডেল করা: স্কেলিং স্ট্র্যাটেজি](#৫-মিলিয়ন-ইউজার-হ্যান্ডেল-করা-স্কেলিং-স্ট্র্যাটেজি)
6. [পারফরম্যান্স: হালকা ও সুপার ফাস্ট রাখার নিয়ম](#৬-পারফরম্যান্স-হালকা-ও-সুপার-ফাস্ট-রাখার-নিয়ম)
7. [অফলাইন সাপোর্ট (Offline-First)](#৭-অফলাইন-সাপোর্ট-offline-first)
8. [মোবাইল রেসপন্সিভ ও মোবাইল অ্যাপ](#৮-মোবাইল-রেসপন্সিভ-ও-মোবাইল-অ্যাপ)
9. [মডিউল: কোনগুলো সবচেয়ে জরুরি](#৯-মডিউল-কোনগুলো-সবচেয়ে-জরুরি)
10. [ERP-নির্দিষ্ট ডেটা ডিজাইনের নিয়ম](#১০-erp-নির্দিষ্ট-ডেটা-ডিজাইনের-নিয়ম)
11. [সিকিউরিটি](#১১-সিকিউরিটি)
12. [DevOps: CI/CD, Infra, Monitoring, Backup](#১২-devops-cicd-infra-monitoring-backup)
13. [Billing, Pricing Plan ও Feature Gating](#১৩-billing-pricing-plan-ও-feature-gating)
14. [Storefront: টেন্যান্টের পাবলিক অনলাইন শপ ও কুরিয়ার ডেলিভারি](#১৪-storefront-টেন্যান্টের-পাবলিক-অনলাইন-শপ-ও-কুরিয়ার-ডেলিভারি)
15. [বাংলাদেশ-নির্দিষ্ট বিষয়](#১৫-বাংলাদেশ-নির্দিষ্ট-বিষয়)
16. [আনুমানিক খরচ](#১৬-আনুমানিক-খরচ)
17. [রোডম্যাপ ও টিম](#১৭-রোডম্যাপ-ও-টিম)
18. [যে ভুলগুলো অবশ্যই এড়াবেন](#১৮-যে-ভুলগুলো-অবশ্যই-এড়াবেন)
19. [ফাইনাল চেকলিস্ট](#১৯-ফাইনাল-চেকলিস্ট)

---

## ০. এক নজরে মূল সিদ্ধান্ত (TL;DR)

| বিষয় | সিদ্ধান্ত | এক লাইনে কারণ |
|---|---|---|
| আর্কিটেকচার | **Modular Monolith** + Background Workers | দ্রুত ডেভেলপমেন্ট, কম খরচ; পরে দরকার হলে মডিউল আলাদা সার্ভিস করা যাবে |
| ভাষা | **TypeScript** (ফ্রন্টএন্ড + ব্যাকএন্ড) | একই টাইপ ও ভ্যালিডেশন দুই দিকে, ছোট টিমে সবচেয়ে বেশি গতি |
| ব্যাকএন্ড | **NestJS + Fastify adapter** | মডিউলার স্ট্রাকচার, DI, দ্রুত HTTP লেয়ার |
| ডাটাবেস | **PostgreSQL 17** + Row-Level Security | ACID, ERP-এর জন্য সবচেয়ে নির্ভরযোগ্য, RLS দিয়ে টেন্যান্ট আইসোলেশন |
| Multi-tenancy | **Hybrid**: shared DB (ছোট টেন্যান্ট) + dedicated DB (Enterprise) | খরচ কম, আবার বড় ক্লায়েন্টের জন্য আইসোলেশন |
| ERP ফ্রন্টএন্ড | **React + Vite SPA (PWA)** | লগইনের পেছনের অ্যাপে SSR লাগে না; অফলাইনের জন্য SPA সবচেয়ে ভালো |
| ওয়েবসাইট/ল্যান্ডিং | **Astro** | স্ট্যাটিক HTML, প্রায় শূন্য JS, SEO ও স্পিড সেরা |
| অফলাইন | **PWA + IndexedDB + Outbox Sync** | ইন্টারনেট না থাকলেও POS/বিক্রি চলবে |
| Cache/Queue | **Redis (Valkey) + BullMQ** | সহজ, দ্রুত, একটা টুলে দুই কাজ |
| Infra | শুরুতে **Docker Compose / k3s**, পরে **Kubernetes (EKS/GKE)** | শুরুতে কম খরচ, পরে অটো-স্কেল |
| CDN/সিকিউরিটি | **Cloudflare** | ফ্রি টিয়ারেই CDN, WAF, DDoS সুরক্ষা |
| Observability | **OpenTelemetry + Grafana stack + Sentry** | ভেন্ডর লক-ইন নেই |
| টেন্যান্টের অনলাইন শপ | **Storefront** (Astro SSR + CDN, `acme.omnivo.shop`) | টেন্যান্ট নিজের প্রোডাক্ট বিক্রি করবে, স্টক ও হিসাব একই ERP-তে |
| ডেলিভারি | **কুরিয়ার অ্যাডাপ্টার** (Pathao, Steadfast, RedX…), অর্ডার কনফার্ম হলেই অটো কনসাইনমেন্ট | হাতে বুকিং বন্ধ, COD-র টাকা অটো রিকনসাইল |

> **সবচেয়ে গুরুত্বপূর্ণ কথা:** প্রথম দিন থেকে মিলিয়ন ইউজারের জন্য জটিল সিস্টেম বানাবেন না। বানাবেন এমন একটা সিস্টেম যেটা **সহজ**, কিন্তু যার **ডিজাইন স্কেল করার পথ খোলা রাখে**। প্রতিটা টেবিলে `tenant_id`, stateless API আর async jobs, এই তিনটা ঠিক থাকলে পরে স্কেল করা অনেক সহজ।

---

## ১. লক্ষ্য ও Non-Functional Requirements

মাপা যায় এমন লক্ষ্য ঠিক না করলে "সুপার ফাস্ট" কথাটার কোনো অর্থ থাকে না। তাই শুরুতেই সংখ্যা ঠিক করুন:

| মেট্রিক | টার্গেট |
|---|---|
| API latency (p95) | < 200 ms (সাধারণ CRUD < 80 ms) |
| API latency (p99) | < 500 ms |
| ফার্স্ট লোড (4G মোবাইল) | < 2.5 s (LCP) |
| পরের লোড (ক্যাশ থেকে) | < 1 s, অফলাইনেও খুলবে |
| ইনিশিয়াল JS বান্ডেল | < 210 KB gzipped |
| Uptime (SLA) | 99.9% (মাসে ~৪৩ মিনিট ডাউনটাইম), Enterprise-এ 99.95% |
| RPO (কতটুকু ডেটা হারানো চলবে) | ≤ 5 মিনিট |
| RTO (কত দ্রুত ফিরে আসবে) | ≤ 1 ঘণ্টা |
| টেন্যান্ট ডেটা লিক | **শূন্য**। এটা নিয়ে কোনো ছাড় নেই |

### "মিলিয়ন ইউজার" বাস্তবে কতটা লোড?

হিসাবটা আগে করে নিন, তাহলে অকারণে over-engineering করবেন না:

```
রেজিস্টার্ড ইউজার:            1,000,000
দৈনিক সক্রিয় (DAU ~15%):       150,000
পিক সময়ে একসাথে সক্রিয় (~10%):   15,000
প্রতি ইউজার গড়ে ১টা রিকোয়েস্ট / ৫ সেকেন্ড
=> পিক লোড ≈ 3,000 req/sec (সেফটি মার্জিনসহ ~6,000 RPS)
```

- একটা Node.js (Fastify) pod সাধারণ CRUD-এ **১,০০০–৩,০০০ RPS** সামলাতে পারে। মানে **৫–১০টা pod** যথেষ্ট।
- ভালো ইনডেক্সসহ একটা বড় PostgreSQL instance **১০,০০০+ TPS** সামলাতে পারে।
- **উপসংহার:** মিলিয়ন ইউজারের জন্য মাইক্রোসার্ভিস বা শুরু থেকে sharding লাগে না। দরকার **ভালো ইনডেক্সিং, ক্যাশিং, read replica আর async processing**। বটলনেক প্রায় সবসময় **ডাটাবেস** হয়, প্রোগ্রামিং ভাষা না।

---

## ২. সামগ্রিক আর্কিটেকচার: কেন Modular Monolith

### তিনটা অপশনের তুলনা

| | Monolith (এলোমেলো) | **Modular Monolith** ✅ | Microservices |
|---|---|---|---|
| ডেভেলপমেন্ট স্পিড | শুরুতে দ্রুত, পরে ধীর | দ্রুত এবং টেকসই | ধীর |
| অপারেশন খরচ | কম | কম | অনেক বেশি |
| ডিবাগিং | সহজ | সহজ | কঠিন (distributed tracing লাগবে) |
| ট্রানজ্যাকশন (ERP-তে জরুরি) | সহজ | সহজ (একই DB transaction) | কঠিন (Saga লাগবে) |
| টিম সাইজ | ১–৫ | ১–৩০ | ৩০+ |
| পরে ভাগ করা | কঠিন | সহজ | — |

**ERP-তে microservices বিশেষ করে বিপজ্জনক**, কারণ একটা সেলস ইনভয়েস একসাথে Sales, Inventory আর Accounting তিনটা মডিউলে লেখে। এক DB transaction-এ এটা খুব সহজ। তিনটা আলাদা সার্ভিসে করলে distributed transaction লাগে, যেটা ব্যর্থ হলে হিসাব মিলবে না।

### Modular Monolith মানে কী

- কোড **একটাই ডিপ্লয়যোগ্য অ্যাপ**, কিন্তু ভেতরে প্রতিটা মডিউল (Accounting, Inventory, Sales…) আলাদা বক্স।
- এক মডিউল অন্য মডিউলের **টেবিলে সরাসরি হাত দেবে না**। শুধু তার public service/interface বা event ব্যবহার করবে।
- মডিউলের মধ্যে যোগাযোগ দুইভাবে হবে:
  1. **Synchronous**: সরাসরি service call (একই transaction-এ দরকার হলে)
  2. **Asynchronous**: Domain Events + **Transactional Outbox** (যেমন "ইনভয়েস তৈরি হলো, তাই ইমেইল পাঠাও" বা "রিপোর্ট আপডেট করো")

```
apps/api/src/modules/
├── core/          # tenant, user, role, permission, audit, settings
├── accounting/    # chart of accounts, journal, ledger, tax
│   ├── domain/        # entity, business rules (framework-মুক্ত)
│   ├── application/   # use-cases / commands / queries
│   ├── infra/         # repository, drizzle queries
│   ├── api/           # controllers, DTO
│   └── index.ts       # শুধু এটাই বাইরে export হবে
├── inventory/
├── sales/
├── purchase/
├── pos/
├── storefront/    # পাবলিক অনলাইন শপ, কার্ট, চেকআউট, অর্ডার (§১৪)
├── shipping/      # কুরিয়ার অ্যাডাপ্টার, কনসাইনমেন্ট, ট্র্যাকিং, COD রিকনসিলিয়েশন (§১৪)
└── hr/
```

> **টিপস:** `eslint-plugin-boundaries` বা `dependency-cruiser` দিয়ে CI-তে নিয়ম চালু করুন: "sales মডিউল inventory-র infra ফোল্ডার import করতে পারবে না।" এতে মনোলিথ এলোমেলো হয়ে যাবে না।

### হাই-লেভেল আর্কিটেকচার

```mermaid
flowchart TB
  subgraph Client
    B[Browser / PWA]
    M[Mobile - Capacitor]
    IDB[(IndexedDB - অফলাইন ডেটা)]
    B --- IDB
  end

  subgraph Edge[Cloudflare]
    CDN[CDN + WAF + DDoS]
  end

  subgraph Static
    WEB[Astro Website - omnivo.app]
    SHOP[Astro Storefront - টেন্যান্টের শপ]
    APPB[ERP App Bundle]
  end

  subgraph Cluster[Kubernetes Cluster]
    ING[Ingress / Load Balancer]
    API[API Pods - NestJS, stateless, HPA]
    SYNC[Sync Endpoint]
    WRK[Worker Pods - BullMQ]
  end

  subgraph Data
    PGB[PgBouncer]
    PG[(PostgreSQL Primary)]
    PGR[(Read Replicas)]
    RD[(Redis / Valkey)]
    S3[(Object Storage R2/S3)]
    MS[(Meilisearch)]
    CH[(ClickHouse - Analytics)]
  end

  subgraph External[বাইরের সার্ভিস]
    CRR[কুরিয়ার API - Pathao / Steadfast / RedX]
    PAY[পেমেন্ট গেটওয়ে]
  end

  WRK --> CRR & PAY
  CRR -- webhook --> ING

  B & M --> CDN
  CDN --> WEB & SHOP & APPB
  SHOP --> ING
  CDN --> ING --> API & SYNC
  API & SYNC --> PGB --> PG
  PG --> PGR
  API --> RD
  API -- enqueue --> RD
  RD -- jobs --> WRK
  WRK --> PGB & S3 & MS
  PG -. CDC / Outbox .-> CH
```

---

## ৩. Tech Stack: কী, কেন, সুবিধা, সমস্যা

### ৩.১ ব্যাকএন্ড ভাষা: TypeScript নাকি Go?

| | **TypeScript (Node.js)** ✅ প্রস্তাবিত | Go |
|---|---|---|
| পারফরম্যান্স | ভালো (I/O-bound কাজে যথেষ্ট) | খুব ভালো, কম মেমোরি |
| ডেভেলপমেন্ট স্পিড | খুব দ্রুত | মাঝারি |
| ফ্রন্টএন্ডের সাথে কোড শেয়ার | ✅ Zod schema, types, business rules | ❌ |
| হায়ারিং (বাংলাদেশে) | সহজ, অনেক JS/TS ডেভেলপার | তুলনামূলক কঠিন |
| অফলাইন sync-এর লজিক শেয়ার | ✅ একই ভ্যালিডেশন ক্লায়েন্ট আর সার্ভারে | ❌ দুইবার লিখতে হবে |

**সিদ্ধান্ত:** মূল API হবে TypeScript-এ। পরে কোনো নির্দিষ্ট ভারী কাজ (যেমন বিশাল রিপোর্ট জেনারেশন, PDF রেন্ডারিং, ডেটা ইমপোর্ট) বটলনেক হলে শুধু সেই worker-টা Go বা Rust-এ লিখবেন। প্রথমে মাপবেন, তারপর অপ্টিমাইজ করবেন।

### ৩.২ ব্যাকএন্ড ফ্রেমওয়ার্ক: NestJS (Fastify adapter)

- **কেন:** ERP-তে ৫০+ মডিউল হবে। NestJS-এর module system, dependency injection, guards আর interceptors বড় কোডবেসকে গোছানো রাখে। Express-এর বদলে **Fastify adapter** ব্যবহার করলে প্রায় ২–৩ গুণ বেশি throughput পাওয়া যায়।
- **সুবিধা:** স্ট্রাকচার আগে থেকেই ঠিক করা, টেস্টিং সহজ, OpenAPI ডক অটো-জেনারেট হয়, বড় কমিউনিটি।
- **সমস্যা:** কিছুটা boilerplate বেশি আর decorator-নির্ভর। cold start একটু বেশি, তবে আমাদের long-running pod-এ এটা সমস্যা না।
- **বিকল্প:** আরও হালকা চাইলে **Hono** বা শুধু **Fastify** ব্যবহার করা যায়, কিন্তু তখন স্ট্রাকচার নিজেকে বানাতে হবে।

**API স্টাইল:** REST + OpenAPI (বাইরের ইন্টিগ্রেশন ও public API-এর জন্য সহজ)। ফ্রন্টএন্ড আর API একই Zod চুক্তি থেকে টাইপ নেয়; OpenAPI সেই চুক্তি থেকে জেনারেট হয় — বাইরের ইন্টিগ্রেশন আর docs-এর জন্য। GraphQL দরকার নেই, কারণ এটা ক্যাশিং আর পারফরম্যান্স জটিল করে এবং টেন্যান্ট-লেভেলে query cost নিয়ন্ত্রণ করা কঠিন।

### ৩.৩ ডাটাবেস: PostgreSQL 17

- **কেন:** ERP মানে টাকা-পয়সা। তাই লাগবে ACID transaction, শক্ত constraint, foreign key আর `NUMERIC` টাইপ। PostgreSQL-এ সব আছে, সাথে আছে **Row-Level Security** (মাল্টি-টেন্যান্সির জন্য দারুণ), **JSONB** (কাস্টম ফিল্ডের জন্য), partitioning আর logical replication।
- **সুবিধা:** ফ্রি, খুব পরিপক্ব, প্রতিটা ক্লাউডে managed ভার্সন আছে, আর **Citus** দিয়ে পরে horizontally shard করা যায়।
- **সমস্যা:** write scaling মূলত একটা primary-তে সীমিত (Citus না আনা পর্যন্ত)। connection ভারী, তাই **PgBouncer বাধ্যতামূলক**। বড় টেবিলে migration সাবধানে করতে হয়।
- **MongoDB কেন না:** ERP-এর ডেটা খুবই relational (invoice → line items → product → account)। Multi-document transaction আর join-এ Mongo দুর্বল, আর হিসাবের সফটওয়্যারে schema-less থাকা বিপজ্জনক।

**ORM: Drizzle**
- হালকা, SQL-এর খুব কাছাকাছি, runtime overhead প্রায় নেই, TypeScript type inference চমৎকার।
- Prisma-র তুলনায়: Prisma-তে বড় query engine binary আছে, জটিল query আর RLS-এর সাথে কাজ করা ঝামেলা। Drizzle-এ raw SQL-এ নামা সহজ।
- **নিয়ম:** রিপোর্টিং বা জটিল query-র জন্য সরাসরি SQL লিখতে লজ্জা পাবেন না।

### ৩.৪ Cache ও Queue: Redis (Valkey) + BullMQ

- **Redis-এর ব্যবহার:** সেশন/টোকেন blocklist, টেন্যান্ট কনফিগ ক্যাশ, permission ক্যাশ, rate limiting, distributed lock, BullMQ queue।
- **কেন BullMQ:** Node-native, retry, delay, priority, cron আর rate-limit সব built-in। আলাদা Kafka/RabbitMQ চালানোর ঝামেলা নেই।
- **সমস্যা:** Redis মেমোরি-ভিত্তিক, তাই মেমোরি শেষ হলে সমস্যা। queue-তে খুব বেশি job জমলে মনিটর করতে হবে।
- **পরে:** ইভেন্ট ভলিউম অনেক বেড়ে গেলে, বা একাধিক সার্ভিস একই ইভেন্ট পড়তে চাইলে, **NATS JetStream** বা **Kafka (Redpanda)** আনবেন। শুরুতে এগুলো লাগবে না।

### ৩.৫ Search: Meilisearch

- প্রোডাক্ট, কাস্টমার আর ইনভয়েস খোঁজার জন্য typo-tolerant, দ্রুত সার্চ।
- টেন্যান্ট আইসোলেশনের জন্য **tenant token / filter** (`tenant_id = X`) বাধ্যতামূলক।
- ছোট টেন্যান্টদের জন্য প্রথমে শুধু **PostgreSQL `pg_trgm` + full-text search**-ই যথেষ্ট। Meilisearch আনবেন যখন সত্যিই দরকার হবে।

### ৩.৬ Analytics ও রিপোর্ট: ClickHouse (Phase 2)

- ERP-এর ভারী রিপোর্ট (১২ মাসের সেলস ট্রেন্ড, প্রোডাক্ট-ওয়াইজ মার্জিন) OLTP ডাটাবেসে চালালে পুরো অ্যাপ স্লো হয়ে যাবে।
- **সমাধান:** PostgreSQL থেকে CDC (Debezium, PeerDB) বা outbox events দিয়ে ClickHouse-এ ডেটা পাঠাবেন। ড্যাশবোর্ড আর ভারী রিপোর্ট চলবে ClickHouse থেকে।
- **শুরুতে:** Postgres-এই চলবে। ড্যাশবোর্ড পড়ে `account_day_totals` টেবিল থেকে (দিন, ব্রাঞ্চ আর অ্যাকাউন্ট প্রতি এক
  সারি), যেটা জার্নালের trigger পোস্টিং-এর সময়ই বাড়ায় (ধাপ ২১a); ভারী রিপোর্টের জন্য পরে read replica।

### ৩.৭ ফাইল স্টোরেজ: S3-compatible (Cloudflare R2)

- ইনভয়েস PDF, প্রোডাক্ট ছবি, অ্যাটাচমেন্ট রাখার জন্য। R2-তে **egress ফি নেই**, তাই খরচ কম।
- পাথ: `tenants/{tenant_id}/{module}/{yyyy}/{mm}/{uuid}.pdf`
- আপলোড/ডাউনলোড সরাসরি ক্লায়েন্ট থেকে **pre-signed URL** দিয়ে হবে, API সার্ভারের মধ্য দিয়ে না।

### ৩.৮ ERP ফ্রন্টএন্ড: React + Vite SPA (PWA)

| টুল | কাজ | কেন |
|---|---|---|
| **React 19 + Vite** | UI ও বিল্ড | বিশাল ইকোসিস্টেম, দ্রুত বিল্ড |
| **TanStack Router** | রাউটিং | টাইপ-সেফ, route-ভিত্তিক code-splitting |
| **TanStack Query** | সার্ভার স্টেট | ক্যাশ, retry, offline mutation queue, IndexedDB-তে persist |
| **TanStack Table + Virtual** | ডেটা টেবিল | ১০,০০০ রো-ও মসৃণভাবে স্ক্রল হয় |
| **React Hook Form + Zod** | ফর্ম | ERP-তে প্রচুর ফর্ম থাকে। এতে দ্রুত আর কম re-render হয় |
| **Tailwind CSS + shadcn/ui** | ডিজাইন সিস্টেম | কোড নিজের কাছে থাকে, হালকা, কাস্টমাইজ করা সহজ |
| **Zustand** | ক্লায়েন্ট স্টেট | Redux-এর চেয়ে অনেক হালকা |
| **Workbox** | Service Worker | অফলাইন ক্যাশিং |
| **Dexie.js** | IndexedDB wrapper | লোকাল ডাটাবেস |
| **i18next** | ভাষা | ইংরেজি + বাংলা |

**Next.js কেন না (ERP অ্যাপের জন্য)?**
- ERP অ্যাপ লগইনের পেছনে থাকে, তাই SEO বা SSR লাগে না।
- SSR মানে প্রতিটা পেজ সার্ভারে রেন্ডার হয়, এতে সার্ভার খরচ বাড়ে। অফলাইন মোডে সার্ভার না থাকলে SSR কাজই করে না।
- SPA পুরো CDN থেকে static ফাইল হিসেবে সার্ভ হয়। সার্ভার খরচ প্রায় শূন্য, আর একবার লোড হলে অফলাইনেও চলে।

**সমস্যা ও সমাধান:** SPA-র প্রথম লোড ভারী হতে পারে। সমাধান হলো route-based code splitting (প্রতিটা মডিউল আলাদা chunk), আর বান্ডেল বাজেট CI-তে enforce করা (`size-limit`)।

### ৩.৯ ওয়েবসাইট, ল্যান্ডিং ও প্রাইসিং: Astro

- **কেন:** মার্কেটিং সাইটে সবচেয়ে জরুরি হলো SEO আর স্পিড। Astro ডিফল্টভাবে শূন্য JS পাঠায়। প্রয়োজন হলে শুধু নির্দিষ্ট অংশ (যেমন pricing toggle) interactive করা যায় ("islands")।
- একই `packages/ui` থেকে React কম্পোনেন্ট ব্যবহার করা যায়, তাই ডিজাইন একই থাকবে।
- ব্লগ ও ডক্স: Astro Content Collections (Markdown/MDX)। ডক্সের জন্য **Starlight** ব্যবহার করতে পারেন।
- হোস্টিং: Cloudflare Pages, যেখানে ফ্রি আর গ্লোবাল CDN।
- **প্রাইসিং ও প্রোডাক্ট পেজ ডায়নামিক:** কোন প্ল্যান বা মডিউল ওয়েবসাইটে দেখাবে, সেটা Admin Panel থেকে ঠিক হবে। তাই এই পেজগুলো Astro-র on-demand rendering দিয়ে সার্ভারে রেন্ডার হবে আর CDN-এ ক্যাশ থাকবে; বাকি পেজ (ব্লগ, ডক্স, About) স্ট্যাটিক থাকবে। বিস্তারিত [১৩.৩](#১৩৩-product-catalog-admin-panel-থেকে-website-নিয়ন্ত্রণ)-এ।
- **টেন্যান্টের নিজের শপও একই স্ট্যাকে:** `apps/shop` একটা আলাদা Astro অ্যাপ, যেটা একই ডিপ্লয়মেন্ট থেকে সব টেন্যান্টের পাবলিক অনলাইন শপ সার্ভ করে (`acme.omnivo.shop`)। বিস্তারিত [১৪](#১৪-storefront-টেন্যান্টের-পাবলিক-অনলাইন-শপ-ও-কুরিয়ার-ডেলিভারি)-এ।
- Lighthouse স্কোর টার্গেট: ৯৫+।

### ৩.১০ Authentication ও Authorization

- **Identity Provider:** **Zitadel** (মাল্টি-টেন্যান্ট "Organizations" built-in) বা **Keycloak**। নিজে পাসওয়ার্ড হ্যাশিং আর SSO লেখার দরকার নেই।
  - হালকা বিকল্প: **Better Auth** লাইব্রেরি দিয়ে অ্যাপের ভেতরেই auth, যেখানে organization plugin আছে। শুরুতে সহজ, কিন্তু Enterprise SSO (SAML) লাগলে পরে IdP আনতে হবে।
- **টোকেন:** short-lived access JWT (১০–১৫ মিনিট) + rotating refresh token (httpOnly cookie)।
- **Authorization:** RBAC (Role → Permission) + প্রয়োজনে ABAC (যেমন "শুধু নিজের ব্রাঞ্চের ডেটা দেখবে")।
  - Permission স্ট্রিং: `sales.invoice.create`, `accounting.journal.approve`
  - টেন্যান্ট নিজের কাস্টম রোল বানাতে পারবে।
  - Permission সেট Redis-এ ক্যাশ হবে, রোল বদলালে invalidate হবে।
- **একজন ইউজার একাধিক টেন্যান্টে থাকতে পারবে** (যেমন একজন অ্যাকাউন্ট্যান্ট ৫টা কোম্পানির হিসাব দেখে)। তাই `users` আর `memberships (user_id, tenant_id, role_id)` আলাদা টেবিল হবে।

---

## ৪. Multi-Tenancy ডিজাইন

এটাই পুরো সিস্টেমের সবচেয়ে গুরুত্বপূর্ণ সিদ্ধান্ত। পরে বদলানো খুব কঠিন।

### ৪.১ তিনটা মডেল

| মডেল | কীভাবে | সুবিধা | সমস্যা |
|---|---|---|---|
| **Shared DB, Shared Schema (Pool)** | সব টেন্যান্ট একই টেবিলে, `tenant_id` কলাম দিয়ে আলাদা | সবচেয়ে সস্তা, migration একবারই, লাখো টেন্যান্ট সামলানো যায় | একটা বাগে ডেটা লিক হতে পারে, noisy neighbor |
| **Schema-per-Tenant** | প্রতি টেন্যান্টের আলাদা Postgres schema | ভালো আইসোলেশন | ১০,০০০+ schema হলে migration দুঃস্বপ্ন হয়ে যায়, catalog ফুলে ওঠে |
| **DB-per-Tenant (Silo)** | প্রতি টেন্যান্টের আলাদা ডাটাবেস | সর্বোচ্চ আইসোলেশন, আলাদা backup/restore | খুব ব্যয়বহুল, হাজার টেন্যান্টে অপারেশন অসম্ভব |

### ৪.২ প্রস্তাবিত: Hybrid মডেল ✅

```
Free / Starter / Growth টেন্যান্ট  →  Shared DB (Pool) + RLS
Enterprise টেন্যান্ট               →  Dedicated DB (Silo), একই কোড, একই schema
```

- কোড একটাই। শুধু **tenant registry** বলে দেবে কোন টেন্যান্টের ডেটা কোন DB cluster-এ আছে।
- Enterprise ক্লায়েন্টরা আলাদা DB-র জন্য বেশি টাকা দেয় (compliance ও data residency কারণে), আর সেই খরচ তারাই বহন করে।
- পরে Pool DB বড় হয়ে গেলে একাধিক **shard** (Pool-1, Pool-2…) বানাবেন, অথবা Citus-এ `tenant_id` দিয়ে distribute করবেন।

```mermaid
flowchart LR
  REQ[Request: acme.omnivo.app] --> MW[Tenant Middleware]
  MW --> REG[(Tenant Registry - Redis cache)]
  REG -->|tier=pool, shard=1| P1[(Pool DB Shard 1)]
  REG -->|tier=pool, shard=2| P2[(Pool DB Shard 2)]
  REG -->|tier=enterprise| E1[(Dedicated DB - BigCorp)]
```

### ৪.৩ টেন্যান্ট চেনা (Tenant Resolution)

১. **সাবডোমেইন:** `acme.omnivo.app` (প্রধান পদ্ধতি)
২. **কাস্টম ডোমেইন:** `erp.acme.com` → CNAME, Cloudflare for SaaS দিয়ে অটো SSL (Enterprise ফিচার)
৩. **JWT claim:** টোকেনে `tenant_id` থাকবে। সাবডোমেইন আর টোকেনের টেন্যান্ট না মিললে **403**।
৪. **API key:** পাবলিক API-র জন্য কী-টা নিজেই একটা টেন্যান্টের সাথে বাঁধা থাকবে।
৫. **Storefront ডোমেইন:** `acme.omnivo.shop` বা টেন্যান্টের নিজের `shop.acme.com`; এখানে লগইন নেই, তাই টেন্যান্ট আসবে যাচাই করা `storefront_domains` রেকর্ড থেকে (§১৪.২)।

> ⚠️ কখনো request body বা query param থেকে `tenant_id` নিয়ে বিশ্বাস করবেন না। টেন্যান্ট আসবে শুধু যাচাই করা টোকেন থেকে।

### ৪.৪ Row-Level Security: ডেটা লিকের বিরুদ্ধে শেষ দেয়াল

অ্যাপ কোডে `WHERE tenant_id = ?` দিতে ভুলে গেলেও যেন ডাটাবেস নিজেই অন্য টেন্যান্টের ডেটা না দেখায়, সেজন্য RLS:

```sql
-- প্রতিটা টেন্যান্ট-টেবিলে
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoices
  USING      (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

```ts
// প্রতিটা রিকোয়েস্টের DB কাজ একটা transaction-এর ভেতরে
await db.transaction(async (tx) => {
  // 'true' = শুধু এই transaction-এর জন্য (PgBouncer transaction mode-এ নিরাপদ)
  await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
  return handler(tx);
});
```

**জরুরি নিয়ম:**
- অ্যাপ যে DB user দিয়ে কানেক্ট করে, সে **superuser বা `BYPASSRLS` হবে না** (না হলে RLS কাজ করবে না)।
- Migration চালানোর জন্য আলাদা user থাকবে।
- `SET` নয়, সবসময় `set_config(..., true)` বা `SET LOCAL` ব্যবহার করবেন। না হলে PgBouncer-এর connection pool-এ এক টেন্যান্টের সেটিং অন্য টেন্যান্টের রিকোয়েস্টে চলে যেতে পারে। **এটা খুবই বিপজ্জনক বাগ।**
- CI-তে একটা **"tenant leak test suite"** রাখবেন: টেন্যান্ট A দিয়ে লগইন করে প্রতিটা এন্ডপয়েন্টে টেন্যান্ট B-র ID দিয়ে চেষ্টা করবে। সবগুলো 404/403 দিতে হবে।

### ৪.৫ টেন্যান্ট-সচেতন সবকিছু

শুধু DB না, **সবকিছু** টেন্যান্ট দিয়ে আলাদা হবে:

| জায়গা | কীভাবে |
|---|---|
| Primary key / index | প্রতিটা ইনডেক্স শুরু হবে `tenant_id` দিয়ে: `(tenant_id, created_at)`, `(tenant_id, sku)` |
| Unique constraint | `UNIQUE (tenant_id, invoice_no)`, শুধু `invoice_no` না |
| Redis key | `t:{tenant_id}:settings`, `t:{tenant_id}:perm:{user_id}` |
| Queue job | job payload-এ `tenant_id`, worker-এ আবার RLS context সেট করা |
| ফাইল | `tenants/{tenant_id}/...` |
| Search index | প্রতিটা ডকুমেন্টে `tenant_id` + tenant-scoped search token |
| Log / trace | প্রতিটা লগ লাইনে `tenant_id`, যাতে এক টেন্যান্টের সমস্যা দ্রুত খোঁজা যায় |
| Rate limit | টেন্যান্ট ও প্ল্যান অনুযায়ী |
| Metrics | টেন্যান্ট-ভিত্তিক usage (বিলিং ও noisy neighbor ধরার জন্য) |

### ৪.৬ Noisy Neighbor সমস্যা

একটা বড় টেন্যান্ট বিশাল রিপোর্ট চালালে বাকি সবার অ্যাপ যেন স্লো না হয়:
- **Rate limiting** প্রতি টেন্যান্টে (Redis token bucket), প্ল্যান অনুযায়ী লিমিট।
- ভারী রিপোর্ট ও ইমপোর্ট সবসময় **background queue-তে** যাবে, আর প্রতি টেন্যান্টে একসাথে সর্বোচ্চ N টা job চলবে।
- `statement_timeout` (যেমন ৫ সেকেন্ড) OLTP connection-এ। রিপোর্ট চলবে read replica থেকে।
- যে টেন্যান্ট বারবার সমস্যা করে, তাকে আলাদা shard-এ সরিয়ে দেবেন।

### ৪.৭ টেন্যান্ট লাইফসাইকেল

```
Signup → Provisioning (default chart of accounts, roles, settings seed)
       → Trial (14 দিন) → Active → (Past due → Suspended → Read-only)
       → Cancelled → 30 দিন পর Data export + Hard delete
```

- **Provisioning** একটা idempotent background job হবে, যাতে মাঝপথে ব্যর্থ হলে আবার চালানো যায়।
- **Data export:** টেন্যান্ট যেকোনো সময় নিজের সব ডেটা (CSV/JSON) ডাউনলোড করতে পারবে। এটা বিশ্বাস তৈরি করে, আর আইনগতভাবেও দরকার।
- **Tenant migration tool:** একটা টেন্যান্টকে Pool থেকে Dedicated DB-তে বা এক shard থেকে অন্য shard-এ সরানোর স্ক্রিপ্ট। শুরু থেকে এটা মাথায় রাখুন। UUID primary key হলে এটা অনেক সহজ হয়।

### ৪.৮ টেন্যান্ট কাস্টমাইজেশন

প্রতিটা ব্যবসা আলাদা, তাই ERP-তে কাস্টমাইজেশন লাগবেই:
- **Custom fields:** প্রতিটা মূল টেবিলে `custom_fields JSONB` কলাম, আর আলাদা `custom_field_definitions` টেবিলে টাইপ, লেবেল আর ভ্যালিডেশন। দরকার হলে GIN index।
- **Settings:** টেন্যান্ট-লেভেল কনফিগ (currency, fiscal year, tax, numbering format)।
- **Templates:** ইনভয়েস বা রিসিটের PDF টেমপ্লেট কাস্টমাইজ করা।
- **Workflow / Approval:** কনফিগারযোগ্য approval rule (যেমন "১ লাখ টাকার বেশি PO হলে ম্যানেজার অ্যাপ্রুভ করবে")।
- ⚠️ টেন্যান্ট-ভিত্তিক **কাস্টম কোড** কখনো লিখবেন না। সব কাস্টমাইজেশন হবে কনফিগারেশন দিয়ে। না হলে ১০০ টেন্যান্টের জন্য ১০০টা কোডবেস maintain করতে হবে।

---

## ৫. মিলিয়ন ইউজার হ্যান্ডেল করা: স্কেলিং স্ট্র্যাটেজি

### ৫.১ মূলনীতি

1. **API stateless:** কোনো সেশন বা ফাইল লোকাল মেমোরি বা ডিস্কে থাকবে না। তাহলে যত খুশি pod বাড়ানো যায় (horizontal scaling)।
2. **রিকোয়েস্টে ধীর কাজ করবেন না:** ইমেইল, PDF, রিপোর্ট, ইমপোর্ট আর webhook সব queue-তে যাবে।
3. **পড়া আর লেখা আলাদা:** লেখা primary-তে, ভারী পড়া replica-তে।
4. **ক্যাশ করুন, কিন্তু সঠিকভাবে invalidate করুন।**
5. **আগে মাপুন, তারপর অপ্টিমাইজ করুন।**

### ৫.২ ধাপে ধাপে স্কেলিং রোডম্যাপ

| পর্যায় | টেন্যান্ট / ইউজার | Infra |
|---|---|---|
| **Stage 0: MVP** | ০–১০০ টেন্যান্ট, ~১,০০০ ইউজার | ১–২টা VPS (Hetzner/DigitalOcean), Docker Compose, managed Postgres, Cloudflare |
| **Stage 1: Growth** | ১০০–২,০০০ টেন্যান্ট, ~৫০,০০০ ইউজার | k3s বা managed K8s, ৩+ API pod, PgBouncer, ১টা read replica, Redis HA |
| **Stage 2: Scale** | ২,০০০–২০,০০০ টেন্যান্ট, ~৫ লাখ ইউজার | EKS/GKE + HPA, বড় Postgres + ২–৩ replica, ClickHouse, Meilisearch cluster, একাধিক worker pool |
| **Stage 3: Massive** | ২০,০০০+ টেন্যান্ট, ১০ লাখ+ ইউজার | একাধিক Pool shard বা Citus, মাল্টি-রিজিয়ন (read), Enterprise-এর জন্য dedicated DB, Kafka/NATS event bus, প্রয়োজনে কিছু মডিউল আলাদা সার্ভিস |

### ৫.৩ ডাটাবেস স্কেলিংয়ের পথ (এই ক্রমেই)

```
1. সঠিক ইনডেক্স + query অপ্টিমাইজেশন       ← ৮০% সমস্যা এখানেই মেটে
2. PgBouncer (connection pooling)
3. Vertical scaling (বড় মেশিন)             ← আজকাল ১২৮ vCPU পর্যন্ত পাওয়া যায়
4. Read replicas (রিপোর্ট, লিস্ট, সার্চ)
5. Table partitioning (বড় টেবিল: audit_logs, stock_movements, journal_lines, মাস/বছর অনুযায়ী)
6. ভারী analytics ClickHouse-এ সরানো
7. টেন্যান্ট-ভিত্তিক sharding (একাধিক Pool DB বা Citus)
```

> **Citus নিয়ে কথা:** Citus-এ `tenant_id` দিয়ে distribute করলে প্রতিটা টেন্যান্টের সব ডেটা একই নোডে থাকে, তাই join আর transaction স্বাভাবিকভাবে চলে। কিন্তু অপারেশন জটিল, তাই Stage 3-এর আগে দরকার নেই। শুধু শুরু থেকে **প্রতিটা টেবিলে `tenant_id` আর composite key** রাখুন, যাতে পরে সরানো সহজ হয়।

### ৫.৪ ক্যাশিং স্ট্র্যাটেজি

| লেয়ার | কী ক্যাশ হবে | TTL / Invalidation |
|---|---|---|
| **CDN (Cloudflare)** | ওয়েবসাইট, অ্যাপ বান্ডেল, ছবি | Immutable hashed ফাইল, ১ বছর |
| **Service Worker** | অ্যাপ শেল, স্ট্যাটিক অ্যাসেট | নতুন ভার্সন ডিপ্লয় হলে আপডেট |
| **IndexedDB (ক্লায়েন্ট)** | প্রোডাক্ট, কাস্টমার, মাস্টার ডেটা | Sync দিয়ে আপডেট |
| **TanStack Query** | API রেসপন্স | `staleTime` অনুযায়ী |
| **Redis** | টেন্যান্ট কনফিগ, permission, প্রোডাক্ট প্রাইস লিস্ট, রেট লিমিট | Event-ভিত্তিক invalidation |
| **Postgres** | `account_day_totals` (ড্যাশবোর্ডের দিনভিত্তিক যোগফল) | কোনো refresh নেই: এন্ট্রি পোস্ট হওয়ার transaction-এই trigger যোগ করে, তাই কখনো পুরনো হয় না |
| **IndexedDB (ক্লায়েন্ট)** | ড্যাশবোর্ডের শেষ উত্তর, sealed | অনলাইনে প্রতি মিনিটে নতুন; অফলাইনে "As of …" সহ দেখায় |

⚠️ **হিসাবের সংখ্যা (ব্যালেন্স, স্টক) কখনো লম্বা সময়ের জন্য ক্যাশ করবেন না।** ভুল ব্যালেন্স দেখানো ERP-তে সবচেয়ে বড় বিশ্বাসভঙ্গ।

### ৫.৫ Async Processing: Transactional Outbox

```mermaid
sequenceDiagram
  participant API
  participant PG as PostgreSQL
  participant Relay as Outbox Relay
  participant Q as Queue (BullMQ)
  participant W as Worker

  API->>PG: BEGIN
  API->>PG: INSERT invoice, stock_movements, journal_entries
  API->>PG: INSERT outbox (event: InvoiceCreated)
  API->>PG: COMMIT
  Relay->>PG: নতুন outbox রো পড়ো
  Relay->>Q: publish event
  W->>Q: consume
  W->>W: ইমেইল পাঠাও / PDF বানাও / ClickHouse আপডেট / webhook
```

**কেন outbox?** ইনভয়েস সেভ হলো কিন্তু queue-তে ইভেন্ট গেল না, অথবা ইভেন্ট গেল কিন্তু ইনভয়েস rollback হলো, এই দুই ধরনের অসঙ্গতি ঠেকানোর জন্য। Outbox-এ ইভেন্ট একই transaction-এ সেভ হয়। Worker-গুলো **idempotent** হবে (একই ইভেন্ট দুবার এলেও ফল একই)।

### ৫.৬ অন্যান্য স্কেলিং টিপস

- **Pagination:** বড় লিস্টে `OFFSET` নয়, **keyset/cursor pagination** (`WHERE (created_at, id) < (?, ?)`) ব্যবহার করবেন। বড় টেবিলে OFFSET খুব ধীর।
- **Bulk অপারেশন:** ১০,০০০ প্রোডাক্ট ইমপোর্ট হবে batch insert (`COPY` বা multi-row insert) দিয়ে, background job-এ।
- **N+1 query** খুঁজে বের করুন: প্রতিটা এন্ডপয়েন্টে query count লগ করুন।
- **Autoscaling:** Kubernetes HPA দিয়ে CPU/RPS অনুযায়ী API pod, আর queue length অনুযায়ী worker pod (KEDA)।
- **Graceful degradation:** রিপোর্ট সার্ভিস ডাউন থাকলেও যেন ইনভয়েস তৈরি চলতে থাকে।

---

## ৬. পারফরম্যান্স: হালকা ও সুপার ফাস্ট রাখার নিয়ম

### ৬.১ ফ্রন্টএন্ড

- **Performance budget CI-তে:** ইনিশিয়াল JS < 210 KB gz (সব ইংরেজি শব্দ এখনো প্রথম লোডেই আসে; module ধরে শব্দ ভাগ হলে আবার 200), প্রতি মডিউল chunk < 105 KB gz (contracts-এর পুরো route table এখনো প্রায় সব পাতায় আসে; module ধরে route ভাগ হলে আবার 100)। বাজেট ছাড়ালে PR fail করবে।
- **Route-based code splitting:** শুধু Accounting ব্যবহার করে এমন ইউজার যেন Manufacturing-এর কোড ডাউনলোড না করে।
- **ভারী লাইব্রেরি এড়িয়ে চলুন:** moment.js-এর বদলে `date-fns`/`dayjs`, lodash পুরোটা না নিয়ে নির্দিষ্ট ফাংশন। চার্টের জন্য হালকা লাইব্রেরি (যেমন uPlot বা Recharts, lazy-load করা)।
- **Virtualization:** সব বড় টেবিল ও লিস্ট virtualized।
- **Optimistic UI:** সেভ বাটনে চাপ দিলে সঙ্গে সঙ্গে UI আপডেট হবে, সার্ভার কনফার্মেশন আসবে পেছনে। ইউজারের কাছে অ্যাপ "instant" মনে হবে।
- **লোকাল-ফার্স্ট রিড:** প্রোডাক্ট আর কাস্টমার লিস্ট IndexedDB থেকে সাথে সাথে দেখাবে, আর background-এ আপডেট হবে।
- **ফন্ট:** বাংলা ফন্ট (যেমন Hind Siliguri, Noto Sans Bengali) subset করা আর `font-display: swap`।
- **ছবি:** AVIF/WebP, রেসপন্সিভ সাইজ, lazy loading।
- **Keyboard shortcuts:** ERP পাওয়ার ইউজাররা মাউস কম ব্যবহার করে। কীবোর্ড দিয়ে দ্রুত এন্ট্রি অনেক গুরুত্বপূর্ণ (Tally কেন জনপ্রিয় ভাবুন)।

### ৬.২ ব্যাকএন্ড

- Fastify + JSON schema serialization (স্বাভাবিকের চেয়ে দ্রুত)।
- HTTP compression (Brotli) Cloudflare/Ingress লেভেলে, অ্যাপে না।
- শুধু প্রয়োজনীয় কলাম `SELECT` করবেন, `SELECT *` নয়।
- Connection pool সঠিক সাইজের হবে (pod-প্রতি ছোট pool, PgBouncer-এ বড়)।
- প্রতিটা এন্ডপয়েন্টে timeout থাকবে।
- `pg_stat_statements` চালু রাখুন আর প্রতি সপ্তাহে সবচেয়ে ধীর ১০টা query দেখুন।
- Slow query লগ: ২০০ ms-এর বেশি হলে লগ হবে।

### ৬.৩ নেটওয়ার্ক

- সব কিছু Cloudflare-এর পেছনে থাকবে, HTTP/2 ও HTTP/3 চালু।
- বাংলাদেশি ইউজার বেশি হলে **সিঙ্গাপুর (ap-southeast-1) বা মুম্বাই (ap-south-1)** রিজিয়নে সার্ভার রাখুন। ঢাকা থেকে latency কম (~৩০–৬০ ms)। US/EU রিজিয়নে গেলে ২০০ ms+ হবে।

---

## ৭. অফলাইন সাপোর্ট (Offline-First)

বাংলাদেশসহ অনেক দেশে ইন্টারনেট অস্থির। দোকানে নেট চলে গেলে বিক্রি বন্ধ হয়ে যাওয়া **গ্রহণযোগ্য না**। এটা Omnivo-র বড় প্রতিযোগিতামূলক সুবিধা হতে পারে।

### ৭.১ কোন মডিউল অফলাইনে চলবে?

| মডিউল | অফলাইন লেভেল |
|---|---|
| POS / বিক্রি | ✅ পূর্ণ (বিক্রি, রিসিট প্রিন্ট, পেমেন্ট রেকর্ড) |
| Sales Order / Invoice তৈরি | ✅ পূর্ণ |
| Inventory count / stock receive | ✅ পূর্ণ |
| Expense এন্ট্রি | ✅ পূর্ণ |
| কাস্টমার / প্রোডাক্ট দেখা ও সার্চ | ✅ (লোকাল ক্যাশ থেকে) |
| রিপোর্ট ও ড্যাশবোর্ড | 🟡 শেষ sync-এর ডেটা দিয়ে (পুরনো সময় দেখাবে) |
| Accounting journal approve, period close | ❌ শুধু অনলাইন (সার্ভার-অথরিটেটিভ) |
| Payroll run, সেটিংস, ইউজার ম্যানেজমেন্ট | ❌ শুধু অনলাইন |

> সব কিছু অফলাইন করার চেষ্টা করবেন না। শুধু যেসব কাজ **ফিল্ড বা দোকানে** হয়, সেগুলো অফলাইন করবেন।

### ৭.২ আর্কিটেকচার

```mermaid
flowchart LR
  UI[React UI] --> LDB[(IndexedDB - Dexie)]
  UI --> OB[(Outbox - pending mutations)]
  SW[Service Worker] -. app shell cache .-> UI
  OB -- online হলে push --> SAPI[Sync API]
  SAPI -- changes since checkpoint --> LDB
  SAPI --> PG[(PostgreSQL)]
```

**তিনটা অংশ:**

১. **App Shell ক্যাশ (Service Worker/Workbox):** build-এর সব JS, CSS আর woff2 ফন্ট worker আগেই রেখে দেয়
   (precache), আর অ্যাপের প্রতিটা পাতার ঠিকানায় `index.html` দেয়, তাই নেট ছাড়াও অ্যাপ খোলে, reload-এর পরেও।
   API-র উত্তর worker রাখে না: ডেটা IndexedDB-তে। নতুন version অপেক্ষা করে, আর "A new version is ready · Reload"
   দেখায়; অ্যাপ নিজে কখনো reload করে না। সার্ভারের কোনো উত্তর না পেলে (নেট নেই বা 5xx) reload শেষ ব্যবহারকারীর
   কপি খোলে, localStorage-এ রাখা `me` দিয়ে (token কখনো রাখা হয় না); কানেকশন ফিরলে sign-in যাচাই হয়।

   **ডিভাইসের কপি এনক্রিপ্টেড (ধাপ ১৯b):** IndexedDB-র প্রতিটা সারির ডেটা AES-GCM-এ সিল করা (Web Crypto); শুধু id,
   SKU/barcode আর index-এর id খোলা থাকে। একটা random data key দুইভাবে wrap করা: সার্ভারের device key দিয়ে (প্রতি
   ডিভাইসে ৩২ byte, `devices.secret`, revoke হলে মুছে যায়) আর ৬ অঙ্কের PIN দিয়ে (PBKDF2, ৬ লাখ round)। অনলাইনে
   সার্ভারের key কপি খোলে, PIN লাগে না; অফলাইন reload আর "Lock now"-এর পরে lock screen-এ PIN। ৫ বার ভুল PIN হলে
   অফলাইনে খোলা বন্ধ, password দিয়ে sign-in লাগে। সীমা: কেউ পুরো database কপি করে নিলে নিজের মেশিনে ১০ লাখ PIN চেষ্টা
   করতে পারে, অ্যাপের গোনা সেখানে নেই।

২. **Pull (সার্ভার থেকে ক্লায়েন্টে):**
   - প্রতিটা syncable টেবিলে trigger একটা change log-এ (`sync_changes`) লাইন লেখে: কোন entity, কোন key, আর যে
     transaction লিখেছে তার `xid8`। cursor একটা transaction watermark: সার্ভার শুধু সেই transaction-গুলোর
     পরিবর্তন দেয় যেগুলো এখনো চলা সবচেয়ে পুরনো transaction-এর আগে শেষ হয়েছে। সাধারণ sequence number দেরিতে commit
     হওয়া transaction-কে হারিয়ে ফেলে; watermark কখনো হারায় না, বড়জোর এক pull পরে আনে। ডিলিট বা ডেটা-সেট থেকে বেরিয়ে
     যাওয়া (archive, স্টক শূন্য) = delete। log ৩০ দিন থাকে; এর চেয়ে পুরনো cursor-এ পুরো pull।
   - ক্লায়েন্ট বলবে "আমার কাছে version 1520 পর্যন্ত আছে", সার্ভার দেবে এর পরের সব পরিবর্তন (ডিলিট হলে tombstone সহ)।
   - শুধু "POS-ready" ডেটা ক্লায়েন্টে যাবে: সক্রিয় প্রোডাক্ট (variant, pack, barcode সহ), price list ও দাম, VAT
     rate, সক্রিয় কাস্টমার ও group, ডিভাইসের ব্রাঞ্চের warehouse ও তার স্টক, আর সেটিংসের দরকারি অংশ। balance আর
     stock value না (permission লাগে, প্রতি posting-এ বদলায়)। প্রতিটা ব্রাউজার একটা device, একটা ব্রাঞ্চে।
     ব্রাঞ্চ বদলানো যায় শুধু ওই ডিভাইস থেকেই, অনলাইনে, যখন কোনো পরিবর্তন পাঠানো বাকি নেই: পুরনো কপি মুছে নতুন
     ব্রাঞ্চ পুরোটা কপি হয়।

৩. **Push (ক্লায়েন্ট থেকে সার্ভারে): Outbox প্যাটার্ন**
   - অফলাইনে প্রতিটা কাজ একটা **command** হিসেবে Dexie-র `outbox` টেবিলে জমা হয়: `{id: UUIDv7, type, ...}`,
     প্রতিটা type-এর নিজের Zod schema (`customer.create`, `customer.update`, `sales_order.create_draft`)। নতুন
     কাস্টমার, তার ঠিকানা আর অর্ডারের id ডিভাইস নিজেই বানায় (UUIDv7)।
   - অনলাইন হলে `POST /sync/push`-এ ক্রমানুসারে যায়, এক বারে সর্বোচ্চ ৫০টা। প্রতিটা command নিজের transaction-এ
     চলে; একটা refuse হলে বাকিগুলো থামে না। সার্ভার প্রতিটা উত্তর `sync_commands`-এ রাখে (৩০ দিন): একই `id` আবার
     এলে (হারানো উত্তর) আগের উত্তরটাই ফেরত দেয়, কিছু দ্বিতীয়বার চলে না।
   - সার্ভার আসল business rule আবার যাচাই করে, এখনকার role দিয়ে। ক্লায়েন্টকে কখনো অন্ধভাবে বিশ্বাস করবেন না।
     refuse হওয়া command ডিভাইসে "Needs attention" হয়ে থাকে; ঠিক করে আবার পাঠানো বা বাদ দেওয়া যায়, আর যেগুলো
     ওটার উপর নির্ভর করে (নতুন কাস্টমারের অর্ডার) সেগুলো অপেক্ষা করে।

### ৭.৩ Conflict Resolution: সবচেয়ে কঠিন অংশ

সব ডেটার জন্য একই নিয়ম চলবে না। ডেটার ধরন অনুযায়ী আলাদা কৌশল লাগবে:

| ডেটার ধরন | কৌশল | উদাহরণ |
|---|---|---|
| **Append-only (লেনদেন)** | কোনো conflict নেই, শুধু যোগ হয় | বিক্রি, পেমেন্ট, স্টক মুভমেন্ট, জার্নাল এন্ট্রি |
| **মাস্টার ডেটা (সাধারণ ফিল্ড)** | ফিল্ড-লেভেল: শুধু বদলানো ফিল্ড যায় (`{from, to}`), ভিন্ন ফিল্ড দুটোই থাকে, একই ফিল্ডে সার্ভারে যেটা পরে পৌঁছায় সেটা জেতে (ডিভাইসের ঘড়ি দেখা হয় না)। ঠিকানা id ধরে আলাদা আলাদা merge হয়। | কাস্টমারের ফোন নম্বর, প্রোডাক্টের বিবরণ |
| **সংবেদনশীল ফিল্ড** | Server-wins, আর ইউজারকে জানানো হবে | কাস্টমারের ক্রেডিট লিমিট, payment terms, price list, group: device পড়ার পরে সার্ভারে বদলালে সার্ভারেরটা থাকে (`from` আর এখনকার মান আলাদা), আর Sync পাতায় জানানো হয় |
| **স্ট্যাটাস পরিবর্তন** | State machine দিয়ে যাচাই, অবৈধ হলে reject করে ইউজারকে দেখানো | "ইনভয়েস ইতিমধ্যে cancelled" |

**ERP-এর মূল কৌশল: স্টেট নয়, ইভেন্ট সিঙ্ক করুন।**
- ❌ ভুল: "প্রোডাক্ট X-এর স্টক = ৪৫" সিঙ্ক করা (দুই ডিভাইস একসাথে আপডেট করলে একটা হারিয়ে যাবে)
- ✅ সঠিক: "প্রোডাক্ট X থেকে ৩টা বিক্রি হলো" (stock movement) সিঙ্ক করা। স্টক = সব মুভমেন্টের যোগফল। দুই ডিভাইসের বিক্রিই গণনায় থাকবে।

### ৭.৪ অফলাইনের বিশেষ সমস্যা ও সমাধান

| সমস্যা | সমাধান |
|---|---|
| **ইনভয়েস নম্বর** ডুপ্লিকেট (দুই ডিভাইস একই নম্বর দিল) | রেজিস্টার-ভিত্তিক সিরিজ (ধাপ ২০a): প্রতিটা কাউন্টার একটা register (`POS1`), একসাথে শুধু একটা ডিভাইস সেটা ধরে রাখে, আর ডিভাইস নিজেই পরের নম্বর দেয় (`POS1-000123`)। অন্য ডিভাইস নেয় শুধু register খালি হলে: sign-out (কোনো বিক্রি বাকি না থাকলে), অন্য ব্রাঞ্চে সরানো বা revoke। সার্ভার শেষ নম্বরটা জানে, তাই নতুন ডিভাইস সেখান থেকে চালিয়ে যায় |
| **স্টক নেগেটিভ** (অফলাইনে দুই কাউন্টারে শেষ পিস বিক্রি) | POS বিক্রি সার্ভার কখনো স্টকের জন্য refuse করে না (ধাপ ২০a): স্টক শূন্যের নিচে যায়, batch/serial থাকলেও; "Sold short" তালিকায় ওঠে আর `inventory.stock.adjust`-ওয়ালাদের bell যায়। "negative stock allowed" বন্ধ থাকলে স্ক্রিন বিক্রির সময়েই ডিভাইসের কপি দেখে থামায়, ডিভাইসের নিজের না-পাঠানো বিক্রিও গুনে |
| **ক্যাশ ড্রয়ারের হিসাব** (অফলাইনে শিফট চলল, বিক্রি পরে পৌঁছাল) | ধাপ ২০b: একটা শিফট মানে এক ডিভাইস, এক register, এক জন; ডিভাইসই open → বিক্রি/pay in-out → close এই ক্রমে পাঠায়। close পৌঁছালে সার্ভার নিজের সারিগুলো থেকে expected cash আবার গোনে আর তার সংখ্যাই হিসাবে বসে (ডিভাইসের সাথে না মিললে audit log)। close-এর পরে পৌঁছানো বিক্রিও শিফটের ক্যাশে গোনা হয়; হারানো ডিভাইসের শিফট revoke বা manager "close without a count" দিয়ে বন্ধ হয়, আর পরের শিফটের opening count ঘাটতিটা ধরে |
| **একই রিসিটের ফেরত দুই কাউন্টারে** (বা যতটা বিক্রি হয়েছিল তার বেশি) | ধাপ ২০c: রিটার্ন নিজের ডকুমেন্ট (`POS1-R000012`), বিক্রি কখনো বদলায় না। স্ক্রিন যতটা বাকি তার বেশি নিতে দেয় না (ডিভাইসের না-পাঠানো রিটার্নও গোনে), কিন্তু সার্ভার অফলাইনের কাজ কখনো refuse করে না: বিক্রিটা `FOR UPDATE` করে একটার পর একটা লেখে, বেশি হলে বা window পার হলে post করে audit log-এ রাখে। টাকা লাইনের ভাগে (paisa পর্যন্ত), লাইনের শেষ রিটার্ন বাকিটা নেয়, তাই সব রিটার্ন মিলে লাইনের সমান |
| **দাম বদলেছে** কিন্তু ডিভাইসে পুরনো দাম | বিক্রির সময়ের দামই চূড়ান্ত (লাইন আইটেমে দাম সেভ হয়)। শেষ সিঙ্কের ২৪ ঘণ্টা পরে (ডিভাইসের নিজের ঘড়িতে) সাইডবার আর Sync পাতায় `warn` সতর্কবার্তা |
| **অনেক দিন অফলাইন** | ৭ দিন সিঙ্ক না হলে অফলাইনে নতুন কাজ সেভ হয় না (কাস্টমার, অর্ডার)। আগে জমা পরিবর্তনগুলো কানেকশন এলে যায়, অনলাইনের কাজ আগের মতো। সীমাটা ডিভাইসের: সার্ভার অফলাইন ডিভাইস দেখতে পায় না |
| **ডিভাইস চুরি / হারানো** | Workspace → Devices থেকে revoke (`core.device.manage`) বা নিজের My devices থেকে: সিঙ্ক বন্ধ, ওই ব্রাউজারের sign-in শেষ, সার্ভারের device key মুছে যায়, পরের যোগাযোগে কপি আর outbox মুছে যায়। তার আগ পর্যন্ত কপি এনক্রিপ্টেড: খোলে শুধু PIN দিয়ে, ৫ বার ভুল হলে আর না |
| **সময়ের গরমিল** (ডিভাইসের ঘড়ি ভুল) | ডিভাইসের ঘড়ি merge-এ দেখা হয় না: সার্ভারে যেটা পরে পৌঁছায় সেটা জেতে। ঘড়ি শুধু ২৪ ঘণ্টা / ৭ দিনের হিসাবে লাগে, আর সেটা ওই ডিভাইসের নিজের ঘড়িতে শুরু আর শেষ দুটোই মাপা |
| **স্টোরেজ মুছে যাওয়া** (ব্রাউজার ক্লিয়ার) | ডিভাইস সেট-আপের সময় `navigator.storage.persist()` চাওয়া; Sync পাতায় "Kept" / "May be cleared" আর কতটা জায়গা লাগছে; অপেক্ষায় থাকা পরিবর্তনের সংখ্যা সাইডবারে আর install করা অ্যাপের আইকনে (badge) |

### ৭.৫ লাইব্রেরি: নিজে বানাবেন নাকি রেডিমেড?

| অপশন | সুবিধা | সমস্যা |
|---|---|---|
| **নিজস্ব (Dexie + Outbox + Sync API)** ✅ | পূর্ণ নিয়ন্ত্রণ, ERP-এর business rule অনুযায়ী বানানো যায়, কোনো ভেন্ডর লক-ইন নেই | বানাতে সময় লাগে (৪–৮ সপ্তাহ) |
| **PowerSync** | Postgres ↔ SQLite sync রেডিমেড, খুব পরিপক্ব | পেইড (স্কেলে), আরেকটা সার্ভিস চালাতে হয় |
| **ElectricSQL** | Postgres থেকে real-time sync | মূলত read-path sync, write আপনাকেই সামলাতে হবে |
| **RxDB** | ফিচার-সমৃদ্ধ লোকাল DB | কিছু ফিচার পেইড, বড় বান্ডেল |

**প্রস্তাবনা:** ERP-এর লেখা (write) সবসময় business rule দিয়ে যাচাই করতে হয়, তাই **command-based নিজস্ব outbox** সবচেয়ে ভালো। Read-sync (মাস্টার ডেটা ক্লায়েন্টে আনা) নিজে বানাতে পারেন, অথবা পরে PowerSync বা ElectricSQL দিয়ে প্রতিস্থাপন করতে পারেন। কোডটা `packages/sync`-এ আলাদা রাখবেন।

---

## ৮. মোবাইল রেসপন্সিভ ও মোবাইল অ্যাপ

### ৮.১ রেসপন্সিভ ডিজাইনের নিয়ম

- **Mobile-first CSS** (Tailwind breakpoints: ডিফল্ট মোবাইল, তারপর `md:`, `lg:`)।
- **টেবিল সমস্যা:** ERP-তে ১০–১৫ কলামের টেবিল থাকে যেগুলো মোবাইলে চলে না।
  - মোবাইলে টেবিলের বদলে **কার্ড লিস্ট** দেখাবেন (গুরুত্বপূর্ণ ২–৩টা ফিল্ড), আর ট্যাপ করলে বিস্তারিত।
  - ইউজার কোন কলাম দেখবে তা নিজে বেছে নিতে পারবে।
- **ফর্ম:** মোবাইলে এক কলাম, বড় টাচ টার্গেট (≥ ৪৪px), সঠিক `inputmode` (সংখ্যার জন্য numeric কীবোর্ড)।
- **নেভিগেশন:** ডেস্কটপে সাইডবার, মোবাইলে বটম ট্যাব বার + "More" মেনু।
- **POS স্ক্রিন** ট্যাবলেটের জন্য আলাদা অপ্টিমাইজ করা লেআউট।
- **বারকোড স্ক্যান:** ক্যামেরা দিয়ে (`BarcodeDetector` API বা `zxing`), আর USB/Bluetooth স্ক্যানার (কীবোর্ড ইনপুট হিসেবেই আসে)।
- **টেস্টিং:** Playwright দিয়ে মোবাইল viewport-এ E2E টেস্ট, আর আসল কম দামি Android ফোনে (২–৩ GB RAM) নিয়মিত পরীক্ষা। আপনার ইউজারদের অনেকেই এমন ফোন ব্যবহার করবে।

### ৮.২ মোবাইল অ্যাপ স্ট্র্যাটেজি

```
ধাপ ১: PWA (ইনস্টলযোগ্য, অফলাইন, পুশ নোটিফিকেশন)      ← প্রথম দিন থেকে
ধাপ ২: Capacitor র‍্যাপার → Play Store / App Store         ← একই কোডবেস
        (ব্লুটুথ প্রিন্টার, নেটিভ ক্যামেরা, ব্যাকগ্রাউন্ড সিঙ্ক)
ধাপ ৩: শুধু প্রয়োজন হলে React Native (Expo) অ্যাপ          ← ফিল্ড সেলস বা ডেলিভারির মতো নির্দিষ্ট কাজে
```

**কেন Capacitor:** একই React কোড Android/iOS-এ চলবে, আর থার্মাল প্রিন্টারের জন্য নেটিভ প্লাগইন যোগ করা যায়। আলাদা মোবাইল টিম লাগবে না।

---

## ৯. মডিউল: কোনগুলো সবচেয়ে জরুরি

### ৯.১ অগ্রাধিকার ম্যাপ

```
                  ┌──────────────────────────────────────────┐
  Phase 1 (MVP)   │ Core Platform ★★★ │ Accounting ★★★         │
  "টাকা আসে-যায়"   │ Inventory ★★★     │ Sales & Invoicing ★★★  │
                  │ Purchase ★★★      │ POS ★★★                │
                  │ Reports & Dashboard ★★★                    │
                  └──────────────────────────────────────────┘
                  ┌──────────────────────────────────────────┐
  Phase 2         │ HR & Payroll ★★ │ CRM ★★ │ Expense ★★      │
  "ব্যবসা বাড়ে"     │ Multi-branch/Warehouse ★★ │ VAT/Tax ★★★   │
                  │ Storefront + Courier ★★★                   │
                  └──────────────────────────────────────────┘
                  ┌──────────────────────────────────────────┐
  Phase 3         │ Manufacturing ★ │ Projects ★ │ E-commerce ★ │
  "বিশেষায়িত"      │ Public API ★★ │ AI/Forecasting ★ │ Assets ★  │
                  └──────────────────────────────────────────┘
```

### ৯.২ প্রতিটা মডিউলে যা অবশ্যই থাকবে

**১. Core Platform (সবার আগে, সবচেয়ে গুরুত্বপূর্ণ)**
- টেন্যান্ট সাইনআপ ও অনবোর্ডিং উইজার্ড (ব্যবসার ধরন বেছে নিলে ডিফল্ট সেটআপ হয়ে যাবে)
- ইউজার, রোল, পারমিশন, ইনভাইট
- ব্রাঞ্চ ও লোকেশন
- **Audit log** (কে, কখন, কী বদলাল: পুরনো ও নতুন মান সহ)
- Numbering series (INV-2026-0001)
- Currency, fiscal year, timezone, ভাষা
- Notifications (ইন-অ্যাপ, ইমেইল, SMS)
- Attachments, কমেন্ট
- Import/Export (CSV/Excel), যেটা অন্য সফটওয়্যার থেকে মাইগ্রেশনের জন্য জরুরি

**২. Accounting & Finance (ERP-এর হৃদয়)**
- Chart of Accounts (দেশ ও ইন্ডাস্ট্রি অনুযায়ী টেমপ্লেট)
- Double-entry journal (সব মডিউল শেষ পর্যন্ত এখানে পোস্ট করবে)
- Accounts Receivable / Payable, কাস্টমার ও সাপ্লায়ার লেজার
- ব্যাংক ও ক্যাশ অ্যাকাউন্ট, ব্যাংক রিকনসিলিয়েশন
- ট্যাক্স / VAT
- Financial statements: Trial Balance, P&L, Balance Sheet, Cash Flow
- Period closing / lock (বন্ধ মাসে এন্ট্রি হবে না)
- Multi-currency (exchange rate সহ)

**৩. Inventory**
- প্রোডাক্ট, ভ্যারিয়েন্ট (সাইজ/রং), ইউনিট ও ইউনিট কনভার্শন (কার্টন → পিস)
- ওয়্যারহাউস, স্টক মুভমেন্ট (append-only লেজার)
- Stock valuation (FIFO / Weighted Average)
- Batch / Lot / Expiry (ফার্মেসি আর খাদ্য ব্যবসার জন্য জরুরি), Serial number
- Stock transfer, adjustment, reorder level alert
- বারকোড জেনারেশন ও প্রিন্ট

**৪. Sales & Invoicing**
- Quotation → Sales Order → Delivery → Invoice → Payment
- Price list, discount, কাস্টমার-ভিত্তিক দাম
- Credit limit, due tracking
- Returns / Credit note
- ইনভয়েস PDF, ইমেইল, WhatsApp শেয়ার লিংক

**৫. Purchase**
- Requisition → PO → Goods Receipt → Bill → Payment
- সাপ্লায়ার ম্যানেজমেন্ট, Purchase return / Debit note
- Approval workflow

**৬. POS**
- দ্রুত বিক্রি স্ক্রিন (বারকোড, সার্চ, কীবোর্ড শর্টকাট)
- **সম্পূর্ণ অফলাইন**
- একাধিক পেমেন্ট মেথড (ক্যাশ, কার্ড, bKash, Nagad), স্প্লিট পেমেন্ট
- থার্মাল প্রিন্টার (৫৮/৮০ mm), ক্যাশ ড্রয়ার
- শিফট ওপেন/ক্লোজ, ক্যাশ কাউন্ট (blind, নোট গুনে বা মোট), কারণসহ pay in/out, over/short নিজে থেকেই হিসাবে
  (ধাপ ২০b)
- হোল্ড/রিজিউম বিল (ধাপ ২০b)
- রিসিট নম্বর দিয়ে রিটার্ন, অফলাইনেও (register-এর ৩০ দিনের বিক্রি ডিভাইসে); ক্যাশে বা যেভাবে দিয়েছিল সেভাবে
  টাকা ফেরত, বা এক ধাপে এক্সচেঞ্জ (ফেরতের টাকায় নতুন বিক্রি); X ও Z শিফট রিপোর্ট থার্মাল কাগজে (ধাপ ২০c)

**৭. Reports & Dashboard**
- হোম পেজের ড্যাশবোর্ড: আজকের ও মাসের বিক্রি (বইয়ের হিসাবে), গ্রস মার্জিন, ক্যাশ পজিশন, ৩০ দিনের চার্ট, সেরা ৫
  প্রোডাক্ট, কাস্টমার ও সাপ্লায়ারের বকেয়া (overdue সহ), লো স্টক; প্রতিটা কার্ড নিজের permission-এ, ব্রাঞ্চ বাছাই করা
  যায়, অফলাইনে শেষ উত্তর (ধাপ ২১a)
- বিক্রি ও কেনাকাটার রিপোর্ট: যেকোনো সময়ের, কাস্টমার/সাপ্লায়ার, প্রোডাক্ট, ক্যাটাগরি, ব্রাঞ্চ বা অ্যাকাউন্ট আর মাস ধরে; ডকুমেন্টের
  লাইন থেকে হিসাব (VAT ছাড়া, ফেরত বাদে), বিক্রির পাশে বইয়ের সংখ্যা, `inventory.stock.value` থাকলে মার্জিন (ধাপ ২১b)
- AR/AP Aging: যেকোনো দিনের হিসাবে, due date থেকে Current, ১–৩০, ৩১–৬০, ৬১–৯০, ৯০+ দিন; অগ্রিম আলাদা কলামে, পাশে বইয়ের
  ব্যালান্স। কোন টাকা কোন দিন থেকে গোনা হবে সেটা allocation-এর `applied_on` তারিখে থাকে, তাই আগের দিনের রিপোর্ট আগের
  দিনের মতোই দেখায় (ধাপ ২১b)
- VAT রিপোর্ট: যেকোনো সময়ের (প্রথমে আগের মাস), রেট ধরে output, input আর net VAT, ডকুমেন্টের লাইন থেকে (ক্রেডিট নোট,
  POS রিটার্ন আর ডেবিট নোট বাদে), পাশে `vat_output` / `vat_input` অ্যাকাউন্টের বইয়ের সংখ্যা; Mushak 6.3 ছাড়া বিলের VAT
  আলাদা লাইনে। Mushak 9.1 পূরণে সাহায্য করে, রিটার্ন নিজে নয় (ধাপ ২১c)
- স্টক মুভমেন্ট: প্রতিটা variant-এর base unit-এ opening, কেনা, বিক্রি, ট্রান্সফার, অ্যাডজাস্টমেন্ট আর closing, ওয়্যারহাউস আর
  ক্যাটাগরি ধরে; opening নতুন টেবিল ছাড়াই, আজকের ব্যালান্স থেকে পরের মুভমেন্ট বাদ দিয়ে (ধাপ ২১c)
- ট্রায়াল ব্যালান্স, P&L, ব্যালান্স শিট + ফিল্টার + Excel/PDF এক্সপোর্ট
- শিডিউল করা রিপোর্ট ইমেইল: Export মেনু থেকে, প্রতিদিন, প্রতি সপ্তাহে বা প্রতি মাসে, ঠিক এক ঘণ্টায়; প্রতিজন প্রাপক নিজের ভাষায়
  আর নিজের permission-এ নিজের ফাইল পায় (৫ MB পর্যন্ত সংযুক্ত, বড় হলে Exports পেজের লিংক)। worker প্রতি ৫ মিনিটে দেখে
  (`report_schedules.next_run_at`); কেউ পড়তে না পারলে নিজে থেকে থামে (ধাপ ২১c)

**৮. Storefront ও Delivery (Phase 2, বিস্তারিত §১৪)**
- টেন্যান্টের পাবলিক অনলাইন শপ: প্রোডাক্ট পাবলিশ, ক্যাটাগরি, কার্ট, চেকআউট
- **COD ও অনলাইন পেমেন্ট** (টেন্যান্টের নিজের গেটওয়ে অ্যাকাউন্টে)
- অর্ডার বোর্ড, অর্ডার → Sales Order → ইনভয়েস অটোমেশন
- **কুরিয়ার ইন্টিগ্রেশন:** অর্ডার কনফার্ম হলেই অটো কনসাইনমেন্ট, ট্র্যাকিং, লেবেল প্রিন্ট, রিটার্ন
- COD রিকনসিলিয়েশন: কুরিয়ারের কাছে কত টাকা আটকে আছে, রেমিট্যান্স ম্যাচিং

**Phase 2:** HR (কর্মী, উপস্থিতি, ছুটি), Payroll (বেতন, বোনাস, ট্যাক্স, পেস্লিপ), CRM (লিড, পাইপলাইন, ফলো-আপ), Expense (রসিদের ছবি সহ), VAT রিটার্ন রিপোর্ট, Storefront + কুরিয়ার ডেলিভারি।

**Phase 3:** Manufacturing (BOM, Work Order, কাঁচামাল খরচ), Projects ও Timesheet, Fixed Assets ও Depreciation, E-commerce সিঙ্ক (Shopify/WooCommerce/Daraz), Public REST API ও Webhooks, AI সহকারী (স্বাভাবিক ভাষায় রিপোর্ট প্রশ্ন, ডিমান্ড ফোরকাস্ট)।

### ৯.৩ ইন্ডাস্ট্রি ফোকাস

প্রথম দিন থেকে "সবার জন্য ERP" না বানিয়ে **১–২টা ইন্ডাস্ট্রি বেছে নিন** (যেমন রিটেইল/ডিস্ট্রিবিউশন, ফার্মেসি, বা ছোট ম্যানুফ্যাকচারিং), আর তাদের জন্য সেরা হোন। পরে "Industry Template" দিয়ে অন্য ইন্ডাস্ট্রিতে যাবেন। ইন্ডাস্ট্রি টেমপ্লেট মানে ডিফল্ট chart of accounts, প্রোডাক্ট ফিল্ড আর রিপোর্ট।

---

## ১০. ERP-নির্দিষ্ট ডেটা ডিজাইনের নিয়ম

এগুলো ভুল হলে পরে ঠিক করা প্রায় অসম্ভব:

| নিয়ম | বিস্তারিত |
|---|---|
| **টাকা কখনো float নয়** | `NUMERIC(19,4)` DB-তে। কোডে `decimal.js`/`big.js` বা integer (পয়সায়)। `0.1 + 0.2 = 0.30000000000000004` হলে হিসাব মিলবে না |
| **Double-entry বাধ্যতামূলক** | প্রতিটা আর্থিক লেনদেনে debit = credit, DB constraint বা trigger দিয়ে যাচাই |
| **পোস্ট করা ডকুমেন্ট এডিট হবে না** | ভুল হলে reversal বা credit note দিয়ে ঠিক করা হবে, মুছে ফেলা নয়। অডিটের জন্য এটা অপরিহার্য |
| **Primary key: UUIDv7** | সময়-ক্রমানুসারী হওয়ায় ইনডেক্স ভালো থাকে, অফলাইন ক্লায়েন্ট নিজে ID বানাতে পারে, টেন্যান্ট মাইগ্রেশনে collision হয় না |
| **সব সময় UTC** | DB-তে `timestamptz`, আর দেখানোর সময় টেন্যান্টের টাইমজোনে। কিন্তু "ইনভয়েস তারিখ" হবে `date` টাইপ (টাইমজোন ছাড়া ব্যবসায়িক তারিখ) |
| **Soft delete** মাস্টার ডেটায় | `deleted_at`। লেনদেনে ব্যবহৃত প্রোডাক্ট মোছা যাবে না, শুধু archive করা যাবে |
| **Audit columns** সব টেবিলে | `tenant_id, created_at, created_by, updated_at, updated_by, version` |
| **Optimistic locking** | `version` কলাম। দুজন একসাথে এডিট করলে দ্বিতীয়জন "ডেটা বদলে গেছে" মেসেজ পাবে |
| **Snapshot রাখা** | ইনভয়েস লাইনে প্রোডাক্টের নাম, দাম আর ট্যাক্স রেট কপি করে রাখবেন। পরে প্রোডাক্ট বদলালেও পুরনো ইনভয়েস বদলাবে না |
| **Multi-currency** | প্রতিটা লেনদেনে `currency`, `exchange_rate`, আর base currency-তে রূপান্তরিত মান |
| **Zero-downtime migration** | Expand → Migrate → Contract। কলাম রিনেম না করে নতুন কলাম যোগ, ডেটা কপি, তারপর পুরনোটা সরানো |

---

## ১১. সিকিউরিটি

ERP-তে ব্যবসার সবচেয়ে গোপন তথ্য থাকে: বেতন, লাভ, কাস্টমার লিস্ট। তাই একটা ডেটা লিক মানে কোম্পানি শেষ।

- **টেন্যান্ট আইসোলেশন:** RLS + অ্যাপ-লেভেল চেক + লিক টেস্ট (উপরে বলা হয়েছে)।
- **OWASP Top 10:** input validation (Zod), parameterized query (ORM), CSRF সুরক্ষা, সঠিক CORS, security headers (CSP, HSTS)।
- **IDOR প্রতিরোধ:** প্রতিটা রিসোর্স অ্যাক্সেসে owner বা tenant যাচাই।
- **Secrets:** কোডে বা `.env`-এ প্রোডাকশন secret রাখবেন না। ব্যবহার করুন **Doppler / Infisical / AWS Secrets Manager / Sealed Secrets**।
- **এনক্রিপশন:** ট্রানজিটে TLS 1.2+, ডিস্কে at-rest encryption (managed DB-তে ডিফল্ট থাকে)। অতিরিক্ত সংবেদনশীল ফিল্ড (NID, ব্যাংক অ্যাকাউন্ট) application-level encryption দিয়ে।
- **2FA/MFA:** সব ইউজারের জন্য অপশন, অ্যাডমিনদের জন্য বাধ্যতামূলক।
- **Rate limiting ও brute-force সুরক্ষা** লগইনে।
- **Audit log** অপরিবর্তনীয় (append-only টেবিল, আলাদা স্টোরেজে ব্যাকআপ)।
- **Internal admin অ্যাক্সেস:** সাপোর্ট টিম টেন্যান্টের ডেটা দেখতে চাইলে "impersonation" হবে টেন্যান্টের অনুমতি নিয়ে, আর প্রতিটা অ্যাক্সেস লগ হবে।
- **Dependency scanning:** Dependabot/Renovate, `npm audit`, কন্টেইনার স্ক্যান (Trivy)।
- **Pen-test:** বড় লঞ্চের আগে থার্ড-পার্টি পেনিট্রেশন টেস্ট।
- **Compliance (ভবিষ্যৎ):** ISO 27001 / SOC 2। Enterprise ক্লায়েন্টরা এগুলো চাইবে।

---

## ১২. DevOps: CI/CD, Infra, Monitoring, Backup

### ১২.১ Environments

```
local (Docker Compose)  →  preview (প্রতি PR-এ, ঐচ্ছিক)  →  staging  →  production
```
- Staging হবে প্রোডাকশনের মতোই, কিন্তু ছোট। আসল কাস্টমার ডেটা কখনো staging-এ কপি করবেন না (করতে হলে anonymize করবেন)।

### ১২.২ Monorepo ও CI/CD

- **pnpm + Turborepo:** শুধু পরিবর্তিত প্যাকেজ বিল্ড ও টেস্ট হবে (remote cache সহ), তাই CI দ্রুত।
- **GitHub Actions পাইপলাইন:**
  ```
  PR → lint → typecheck → unit test → integration test (Testcontainers: আসল Postgres)
     → tenant-leak test → bundle size check → build Docker image → security scan
  main-এ merge → staging-এ auto deploy → smoke test
  Release tag → production (manual approval) → canary 10% → 100%
  ```
- **GitOps:** Argo CD। Git-এ যা আছে ক্লাস্টারে তা-ই থাকবে, আর রোলব্যাক মানে একটা git revert।
- **ডাটাবেস migration** আলাদা Job-এ ডিপ্লয়ের আগে চলবে, আর অবশ্যই backward compatible হবে (পুরনো কোড নতুন schema-তে চলতে পারবে)।
- **Feature flags** (Unleash / GrowthBook / নিজস্ব): নতুন ফিচার প্রথমে কিছু টেন্যান্টের জন্য চালু করা। Deploy আর Release আলাদা থাকবে।

### ১২.৩ Infrastructure as Code

- **OpenTofu/Terraform:** VPC, DB, Redis, Kubernetes cluster, DNS সব কোডে।
- **Helm charts:** অ্যাপ ডিপ্লয়মেন্টের জন্য।
- **কনটেইনার:** multi-stage Docker build, distroless/alpine বেস ইমেজ, non-root user। ইমেজ ছোট (< 150 MB) রাখবেন।

### ১২.৪ হোস্টিং পরামর্শ

| পর্যায় | পরামর্শ | কারণ |
|---|---|---|
| শুরু | **Hetzner / DigitalOcean** + Coolify বা Docker Compose; managed Postgres (DO / Neon / Supabase) | খুব কম খরচ, সহজ |
| গ্রোথ | **AWS (ap-southeast-1 সিঙ্গাপুর)** বা GCP: EKS, RDS/Aurora PostgreSQL, ElastiCache | managed সার্ভিস, অটো-স্কেল, এন্টারপ্রাইজের আস্থা |
| এন্টারপ্রাইজ | ক্লায়েন্টের পছন্দের রিজিয়নে dedicated stack | ডেটা রেসিডেন্সি |

> শুরুতে Kubernetes শেখা ও চালানো অনেক সময় নেয়। ১–২ জনের টিম হলে প্রথমে Docker Compose বা **k3s** দিয়ে শুরু করুন। কিন্তু অ্যাপটা এমনভাবে বানান (stateless, 12-factor, env-কনফিগ, হেলথ চেক) যাতে পরে K8s-এ সরানো সহজ হয়।

### ১২.৫ Observability

| কী | টুল | কী দেখবেন |
|---|---|---|
| **Metrics** | Prometheus + Grafana | RPS, latency p95/p99, error rate, DB connection, queue length, টেন্যান্ট-ভিত্তিক usage |
| **Logs** | Loki (বা ELK) | Structured JSON লগ, `tenant_id`, `request_id`, `user_id` সহ |
| **Traces** | OpenTelemetry + Tempo/Jaeger | কোন রিকোয়েস্ট কোথায় সময় নিচ্ছে |
| **Errors** | Sentry | ফ্রন্টএন্ড ও ব্যাকএন্ডের exception, রিলিজ-ভিত্তিক |
| **Uptime** | Better Stack / UptimeRobot | বাইরে থেকে চেক + পাবলিক স্ট্যাটাস পেজ |
| **RUM** | Sentry / Web Vitals | আসল ইউজারদের পেজ লোড স্পিড |

**SLO ও Alert:** শুধু "CPU বেশি" দেখে নয়, **ইউজারের কষ্ট** দেখে alert দিন: "৫ মিনিট ধরে error rate > 1%" বা "p95 > 500ms"। Alert যাবে Slack/Telegram/PagerDuty-তে।

### ১২.৬ Backup ও Disaster Recovery

- **PostgreSQL:** continuous WAL archiving + **Point-in-Time Recovery (PITR)** (managed DB-তে বিল্ট-ইন, অথবা pgBackRest/WAL-G)।
- দৈনিক full backup, **অন্য রিজিয়নে** কপি, ৩০ দিন রাখা।
- **৩-২-১ নিয়ম:** ৩টা কপি, ২ ধরনের মিডিয়া, ১টা অফসাইট।
- **প্রতি মাসে restore টেস্ট করুন।** যে ব্যাকআপ কখনো restore করে দেখা হয়নি, সেটা কাজ করবে কিনা নিশ্চিত বলা যায় না।
- **Per-tenant restore:** "একটা টেন্যান্ট ভুল করে সব ডেটা মুছে ফেলেছে, শুধু তারটা ফেরত দাও"। এজন্য PITR থেকে আলাদা instance-এ restore করে সেই টেন্যান্টের ডেটা এক্সপোর্ট করার স্ক্রিপ্ট আগে থেকে বানিয়ে রাখুন।
- **Runbook:** DB ডাউন, রিজিয়ন ডাউন বা ডেটা করাপশন হলে কী করতে হবে, ধাপে ধাপে লেখা থাকবে।

---

## ১৩. Billing, Pricing Plan ও Feature Gating

### ১৩.১ প্রাইসিং মডেল

**Hybrid মডেল:** বেস প্ল্যান + ইউজার সংখ্যা + অ্যাড-অন মডিউল

| প্ল্যান | মাসিক (প্রস্তাবিত, BDT) | মাসিক (USD) | সীমা |
|---|---|---|---|
| **Free** | ৳০ | $0 | ১ ইউজার, ১ ব্রাঞ্চ, মাসে ৫০টা ইনভয়েস |
| **Starter** | ৳১,৫০০ | $15 | ৫ ইউজার, ১ ব্রাঞ্চ, Accounting + Inventory + Sales + POS |
| **Growth** | ৳৪,৯০০ | $49 | ২৫ ইউজার, ৫ ব্রাঞ্চ, সব Phase 1–2 মডিউল, API |
| **Enterprise** | আলোচনা সাপেক্ষে | Custom | আনলিমিটেড, dedicated DB, SSO, SLA, কাস্টম ডোমেইন |

- বাৎসরিক পেমেন্টে ২ মাস ফ্রি।
- অতিরিক্ত ইউজার, অতিরিক্ত ব্রাঞ্চ আর বিশেষ মডিউল (Payroll, Manufacturing) অ্যাড-অন হিসেবে।
- ১৪ দিনের ফ্রি ট্রায়াল (Growth প্ল্যানের সব ফিচার সহ)।
- মূল্য অবশ্যই মার্কেট রিসার্চ করে চূড়ান্ত করবেন। উপরের সংখ্যাগুলো শুধু শুরুর ধারণা।

### ১৩.২ ইমপ্লিমেন্টেশন

- **Entitlements সার্ভিস:** কোডে কখনো `if (plan === 'growth')` লিখবেন না। লিখবেন `if (can(tenant, 'feature.multi_branch'))` আর `limit(tenant, 'users')`। প্ল্যান ও ফিচারের ম্যাপিং থাকবে DB বা কনফিগে, তাই নতুন প্ল্যান বানাতে কোড বদলাতে হবে না।
- **Usage metering:** ইউজার সংখ্যা, ইনভয়েস সংখ্যা আর স্টোরেজ, প্রতিদিন হিসাব হবে।
- **পেমেন্ট গেটওয়ে:**
  - আন্তর্জাতিক: **Stripe** (বা Paddle / Lemon Squeezy, যারা Merchant of Record হিসেবে ট্যাক্স সামলায়)
  - বাংলাদেশ: **SSLCommerz**, **bKash**, **Nagad**, **ShurjoPay**
- **Dunning:** পেমেন্ট ব্যর্থ হলে রিমাইন্ডার (ইমেইল, SMS)। ৭ দিন grace period, তারপর read-only মোড, **কখনো সাথে সাথে ডেটা মুছবেন না।**
- বিলিং ইভেন্ট (subscription changed, payment failed) webhook দিয়ে আসবে, idempotent handler দিয়ে প্রসেস হবে।

### ১৩.৩ Product Catalog: Admin Panel থেকে Website নিয়ন্ত্রণ

কাস্টমার (নতুন ব্যবসা) Omnivo-র **ওয়েবসাইট** থেকে প্ল্যান, মডিউল বা অ্যাড-অন কিনবে। ওয়েবসাইটে কোন প্রোডাক্ট দেখাবে, কোনটা লুকানো থাকবে, দাম কত, কোন ক্রমে দেখাবে, "Most Popular" ব্যাজ কোনটায় থাকবে, এসব ঠিক হবে **Omnivo Admin Panel** থেকে। কোড বা ওয়েবসাইট আবার ডিপ্লয় না করেই।

**তিনটা অংশ:**

| অংশ | কে ব্যবহার করে | কাজ |
|---|---|---|
| **Admin Panel** (`admin.omnivo.app`) | Omnivo টিম | প্রোডাক্ট, দাম, ফিচার, কুপন তৈরি ও এডিট; ওয়েবসাইটে দেখাবে কিনা ঠিক করা; প্রিভিউ ও পাবলিশ |
| **Catalog API** (`apps/api`-এর `catalog` মডিউল) | Website, Admin, Billing | একমাত্র সত্যের উৎস (single source of truth); পাবলিক এন্ডপয়েন্ট শুধু পাবলিশড ও দৃশ্যমান প্রোডাক্ট দেয় |
| **Website** (`omnivo.app`) | সম্ভাব্য কাস্টমার | প্রাইসিং ও প্রোডাক্ট পেজ দেখানো, "Buy / Start trial" থেকে সাইনআপ ও পেমেন্ট |

#### ডেটা মডেল

```
catalog_products
  id, code (starter, growth, payroll_addon), type (plan | module | addon)
  name, description, features (JSONB, বাংলা + ইংরেজি)
  status (draft | published | archived)
  show_on_website (bool)      ← পাবলিশড হলেও ওয়েবসাইটে লুকানো রাখা যায়
  sort_order, badge ("Most Popular"), highlight (bool)
  available_regions (BD, global), publish_at (শিডিউল করে পাবলিশ)

catalog_prices                 ← দাম কখনো এডিট হয় না, নতুন রো তৈরি হয়
  id, product_id, currency (BDT | USD), interval (month | year)
  amount (NUMERIC), active (bool), created_at

catalog_entitlements           ← প্ল্যান কিনলে কী পাবে (১৩.২-এর entitlements)
  product_id, feature_key (feature.multi_branch), limit_value (users = 25)

coupons
  code, discount_type (percent | fixed), value, valid_until, max_redemptions, applies_to

subscriptions
  tenant_id, price_id, status, current_period_end   ← price_id দিয়ে বাঁধা
```

**এই মডেলের মূল নিয়ম:**
- **দাম immutable (versioned):** দাম বদলালে পুরনো `catalog_prices` রো `active = false` হবে আর নতুন রো তৈরি হবে। পুরনো কাস্টমার তাদের পুরনো দামেই থাকবে (grandfathering); নতুন কাস্টমার নতুন দাম পাবে। Stripe-ও এভাবেই কাজ করে।
- **Published বনাম Show on website আলাদা:** একটা প্ল্যান পাবলিশড কিন্তু ওয়েবসাইটে লুকানো থাকতে পারে। যেমন কোনো Enterprise ক্লায়েন্টের জন্য বিশেষ প্ল্যান, যেটা শুধু সরাসরি লিংকে কেনা যাবে।
- **Archive, delete নয়:** যে প্রোডাক্ট কেউ কিনেছে, তা কখনো মুছবেন না। archive করলে ওয়েবসাইট থেকে সরে যাবে, কিন্তু পুরনো সাবস্ক্রিপশন চলতে থাকবে।
- **Region ও currency:** বাংলাদেশ থেকে ঢুকলে BDT আর bKash/SSLCommerz, বাইরে থেকে USD আর Stripe। দেশ চেনা যাবে Cloudflare-এর `CF-IPCountry` হেডার থেকে, সাথে ইউজার নিজে বদলানোর অপশন।

#### পাবলিশ থেকে ওয়েবসাইটে দেখানো পর্যন্ত

```mermaid
sequenceDiagram
  participant A as Admin (Omnivo টিম)
  participant API as Catalog API
  participant PG as PostgreSQL
  participant W as Worker
  participant CF as Cloudflare CDN
  participant Web as Website (Astro)

  A->>API: প্রোডাক্ট এডিট (draft)
  A->>Web: প্রিভিউ লিংক (?preview=token)
  A->>API: Publish
  API->>PG: catalog আপডেট + audit log + outbox (CatalogPublished)
  PG-->>W: outbox event
  W->>CF: /pricing, /products/* ক্যাশ purge
  Note over Web,CF: পরের ভিজিটরে Astro নতুন ডেটা দিয়ে রেন্ডার করে আবার ক্যাশ করে
```

**ওয়েবসাইট কীভাবে ডেটা পাবে? তিনটা অপশন:**

| অপশন | সুবিধা | সমস্যা |
|---|---|---|
| সম্পূর্ণ static, পাবলিশে পুরো সাইট rebuild | সবচেয়ে দ্রুত | প্রতিটা পরিবর্তনে কয়েক মিনিট দেরি, CI-নির্ভর |
| ব্রাউজারে JS দিয়ে API থেকে fetch | সবসময় লেটেস্ট | SEO খারাপ, পেজ লোডে দাম "লাফিয়ে" আসে |
| **সার্ভারে রেন্ডার + CDN ক্যাশ + পাবলিশে purge** ✅ | প্রায় static-এর মতোই দ্রুত, SEO ভালো, পাবলিশের কয়েক সেকেন্ডের মধ্যে আপডেট | purge ঠিকমতো না হলে পুরনো দাম দেখাতে পারে (তাই `s-maxage` ছোট রাখা, যেমন ৫ মিনিট, সেফটি নেট হিসেবে) |

#### কেনার ফ্লো (Website থেকে টেন্যান্ট তৈরি)

```
Website: প্ল্যান বাছাই (price_id)
  → সাইনআপ (ইমেইল, কোম্পানির নাম, সাবডোমেইন)
  → সার্ভার price_id আবার যাচাই করে (active? এই region-এ বিক্রিযোগ্য? কুপন বৈধ?)
  → পেমেন্ট গেটওয়ে (SSLCommerz / bKash / Stripe)
  → গেটওয়ের webhook → subscription active (idempotent)
  → টেন্যান্ট provisioning job (৪.৭)
  → ওয়েলকাম ইমেইল + acme.omnivo.app-এ রিডাইরেক্ট
```

- ⚠️ **দাম কখনো ওয়েবসাইট বা ব্রাউজার থেকে বিশ্বাস করবেন না।** ব্রাউজার শুধু `price_id` আর কুপন কোড পাঠাবে; আসল টাকার অঙ্ক সার্ভার ক্যাটালগ থেকে হিসাব করবে। না হলে কেউ ব্রাউজারে দাম বদলে ১ টাকায় কিনে নেবে।
- ফ্রি ট্রায়ালে পেমেন্ট ধাপ বাদ যাবে; ট্রায়াল শেষে আপগ্রেড পেজে একই ক্যাটালগ দেখাবে।
- টেন্যান্ট অ্যাপের ভেতরের "Upgrade / Add module" পেজও **একই Catalog API** ব্যবহার করবে, তাই ওয়েবসাইট আর অ্যাপে দাম কখনো আলাদা হবে না।

#### Admin Panel-এর নিরাপত্তা

Admin Panel দিয়ে দাম বদলানো যায় আর সব টেন্যান্ট দেখা যায়, তাই এটা সবচেয়ে সংবেদনশীল অংশ:
- আলাদা সাবডোমেইন (`admin.omnivo.app`), সামনে **Cloudflare Access** বা VPN; সাধারণ ইন্টারনেট থেকে লগইন পেজই দেখা যাবে না।
- MFA বাধ্যতামূলক।
- রোল আলাদা: **Super Admin**, **Catalog Manager** (দাম ও প্রোডাক্ট), **Support** (টেন্যান্ট দেখা, দাম বদলানো নয়), **Finance** (পেমেন্ট ও রিফান্ড)।
- ক্যাটালগের প্রতিটা পরিবর্তন audit log-এ (কে, কখন, আগের ও পরের মান)।
- বড় পরিবর্তনে (দাম কমানো বা বাড়ানো) দ্বিতীয় জনের অনুমোদন (four-eyes) রাখা যায়।
- পাবলিশের আগে প্রিভিউ বাধ্যতামূলক।

---

## ১৪. Storefront: টেন্যান্টের পাবলিক অনলাইন শপ ও কুরিয়ার ডেলিভারি

১৩ নম্বর সেকশনের ওয়েবসাইট আর এই সেকশনের Storefront **দুইটা সম্পূর্ণ আলাদা জিনিস**। গুলিয়ে ফেললে পুরো ডিজাইন ভুল হবে:

| | **Omnivo Website** (§১৩.৩) | **Tenant Storefront** (এই সেকশন) |
|---|---|---|
| ডোমেইন | `omnivo.app` | `acme.omnivo.shop` বা `shop.acme.com` |
| কে কেনে | নতুন ব্যবসা (ভবিষ্যৎ টেন্যান্ট) | টেন্যান্টের নিজের ক্রেতা (সাধারণ মানুষ) |
| কী বিক্রি হয় | ERP প্ল্যান, মডিউল, অ্যাড-অন | টেন্যান্টের নিজের প্রোডাক্ট (Inventory থেকে) |
| পেমেন্ট | Stripe / SSLCommerz (Omnivo-র অ্যাকাউন্টে) | COD বা অনলাইন (**টেন্যান্টের নিজের** মার্চেন্ট অ্যাকাউন্টে) |
| কে নিয়ন্ত্রণ করে | Omnivo Admin Panel | টেন্যান্ট নিজে, ERP অ্যাপের Storefront সেটিংস থেকে |
| রেজাল্ট | নতুন টেন্যান্ট তৈরি | নতুন Sales Order + কুরিয়ার কনসাইনমেন্ট |

### ১৪.১ কেন এটা Omnivo-র জন্য বড় সুযোগ

বাংলাদেশের বেশিরভাগ ছোট ব্যবসা এখন ফেসবুক পেজে বিক্রি করে, হাতে অর্ডার লেখে, তারপর কুরিয়ারের আলাদা প্যানেলে গিয়ে আবার একই ঠিকানা টাইপ করে। মানে **একই অর্ডার তিন জায়গায় তিনবার**, আর স্টক কোথাও মেলে না।

Omnivo-তে Inventory, Sales আর Accounting আগে থেকেই আছে। Storefront আসলে সেই ডেটার উপর বসানো একটা **পাবলিক রিড + অর্ডার-ইনটেক চ্যানেল**, নতুন কোনো ব্যবসায়িক লজিক না। তাই:

- **স্টকের উৎস একটাই।** শপে যা দেখায় আর POS-এ যা বিক্রি হয়, দুটো একই `stock_movements` লেজার থেকে আসে। আলাদা Shopify/WooCommerce রাখলে সিঙ্ক সমস্যা চিরকাল থাকবে।
- **অর্ডার এলেই হিসাব।** অর্ডার → Sales Order → ইনভয়েস → জার্নাল, সব অটো।
- **কুরিয়ার অটোমেশন।** অর্ডার কনফার্ম হলেই কনসাইনমেন্ট তৈরি, ট্র্যাকিং ফিরে আসে, COD-র টাকা রিকনসাইল হয়। এটাই টেন্যান্টের সবচেয়ে বড় দৈনিক কষ্ট।

> Phase 3-এর "E-commerce সিঙ্ক" (Shopify/WooCommerce/Daraz) এটার বিকল্প না, **পরিপূরক**। যারা আগে থেকেই অন্য প্ল্যাটফর্মে আছে তারা সিঙ্ক করবে; যাদের কিছু নেই তারা Omnivo Storefront ব্যবহার করবে।

### ১৪.২ আর্কিটেকচার

```
apps/shop/     ← Astro (on-demand rendering + CDN cache), মাল্টি-টেন্যান্ট একটাই ডিপ্লয়মেন্ট
apps/api/src/modules/
├── storefront/   ← পাবলিক ক্যাটালগ, কার্ট, চেকআউট, অর্ডার ইনটেক
└── shipping/     ← কুরিয়ার অ্যাডাপ্টার, কনসাইনমেন্ট, ট্র্যাকিং, COD রিকনসিলিয়েশন
```

- **একটাই Astro অ্যাপ সব টেন্যান্টের শপ সার্ভ করবে**, টেন্যান্ট চেনা যাবে `Host` হেডার থেকে (§৪.৩-এর একই নিয়ম, শুধু আলাদা ডোমেইন টেবিল)। প্রতি টেন্যান্টের জন্য আলাদা সাইট বিল্ড **কখনো করবেন না**, ১,০০০ টেন্যান্ট হলে CI-ই মরে যাবে।
- **কাস্টম ডোমেইন:** `shop.acme.com` → CNAME → **Cloudflare for SaaS**, SSL অটো (§৪.৩-এর মতোই)।
- **পাবলিক API আলাদা:** `/public/v1/*`, JWT নেই। শপের সার্ভার API-কে ভেতর থেকে ডাকে আর ক্রেতার ব্রাউজারের
  host পাঠায় `X-Shop-Host` হেডারে। টেন্যান্ট আসে শুধু সেই host থেকে (subdomain label →
  `storefront_tenant_for_subdomain()`), কখনো query param থেকে না। প্রতিটা রিকোয়েস্ট একটা `READ ONLY`
  transaction, শুরু হয় `SET LOCAL ROLE omnivo_public` দিয়ে: NOLOGIN role, RLS বাইপাস করতে পারে না, শুধু শপের
  দরকারি কলামে `SELECT` আছে, আর restrictive policy-তে শুধু চালু (`launched_at`) শপের প্রকাশিত লিস্টিং দেখে।
  পড়ার রুটের rate limit আপাতত edge-এ (Cloudflare); অর্ডার আর ফোন কোডের limit API-তে, Redis-এ (ধাপ ২৭a)।
- **অর্ডারের রুট শুধু শপের সার্ভারের জন্য (ধাপ ২৭a):** অর্ডার দেওয়া, ফোন কোড, `/order/<no>`, ট্র্যাকিং আর `/track`
  রুটগুলো `auth: 'shop'`। শপের সার্ভার পাঠায় `x-shop-key` (API-র `STOREFRONT_SHOP_KEY`, না থাকলে প্রতিটা অর্ডার
  রুট `401`) আর ক্রেতার ঠিকানা `x-shop-client-address`-এ (ঠিক key-র পাশেই শুধু বিশ্বাস করা হয়)। Key ছাড়া যে কেউ
  API-র ঠিকানা পেলে শপ ভুয়া অর্ডারে ভরে দিতে আর SMS-এর টাকা খরচ করাতে পারত। প্রতিটা token POST body-তে, কখনো
  address-এ না (log আর `Referer`-এ চলে যায়)। লেখা হয় `ShopDb.orders`-এ, নতুন NOLOGIN role `omnivo_shop`-এ:
  `omnivo_public`-এর সব পড়া, আর শুধু অর্ডারের টেবিলে লেখা (কলাম ধরে `UPDATE` grant)। `omnivo_public` সব শপের
  প্রতিটা পেজের জন্য read-only থাকে।
- **রেন্ডারিং:** পেজ শপের সার্ভারে রেন্ডার হয়। API-র উত্তর `Cache-Control: no-store`, কারণ CDN উত্তর চেনে
  address দিয়ে, `X-Shop-Host` দিয়ে না, তাই এক শপের পেজ অন্য শপে চলে যেতে পারত। শপের সার্ভার নিজের মেমরিতে
  host + path ধরে ৩০ সেকেন্ড রাখে (শুধু GET, ব্যর্থ উত্তর রাখে না, quote কখনো না)। শপের পেজ যখন CDN-এ cache
  হবে, তখন পাবলিশ/দাম বদলালে outbox ইভেন্ট → worker → **CDN purge** (§১৩.৩-এর ক্যাটালগ পাবলিশের প্যাটার্ন)।
- **স্টক আর দাম ক্যাশে না রেখে** চেকআউটের সময় সার্ভারে আবার যাচাই হবে (পেজে "৫টা বাকি" পুরনো হতে পারে, কিন্তু অর্ডার নেওয়ার সময় ভুল হওয়া চলবে না)।
- **ছবি:** স্টোরেজের পাবলিক `storefront/` ফোল্ডারে, নাম কখনো বদলায় না (`storefront/<image id>/<size>.webp`:
  small 480px, large 1200px, wide 2560px), তাই CDN রেখে দিতে পারে; signed link না। WebP বানায় worker-এর
  sharp জব (ধাপ ২৬g)। শপের LCP টার্গেট < ২.৫ সেকেন্ড 3G-তে।
- **ছবি আপলোড (ধাপ ২৬g):** ERP-র ব্রাউজার আসল ছবিটা presigned PUT দিয়ে workspace-এর **private** ফোল্ডারে পাঠায়
  (attachment purpose `storefront_image`: JPEG/PNG/WebP, ৮ MB)। `complete`-এ একই transaction-এ attachment
  ready, `storefront_images`-এ `processing` রো আর outbox ইভেন্ট `storefront.image_uploaded`। Worker-এর sharp
  জব আগে হেডার আর বাইট দেখে ফরম্যাট যাচাই করে, EXIF দেখে ছবি সোজা করে, metadata (GPS সহ) ফেলে দেয়, ৪০
  মেগাপিক্সেলের বেশি বা কোনো দিকে ২০০px-এর কম হলে বাতিল করে, ছোট ছবি কখনো বড় করে না, তারপর তিনটা WebP লিখে রো
  `ready` করে (না পারলে `failed` আর কারণের কোড)। স্ক্রিন ২ সেকেন্ড পরপর জিজ্ঞেস করে ("Preparing the photo…")।
  লিস্টিং সেভের সময় API দেখে প্রতিটা ছবি এই workspace-এর আর `ready` কিনা। ছবির id = attachment-এর id।
- **স্টোরেজে শুধু `storefront/` পাবলিক।** বাকি সব (আসল ছবি সহ) signed link-এ। Dev/test-এ API প্রতিবার চালু হওয়ার
  সময় bucket policy বসায়, স্টেজিং-এ `storage-init`-এর `mc anonymous`, আর প্রোডাকশনে (Cloudflare R2) এটা অ্যাপের
  বাইরে: R2-র পাবলিক ঠিকানা আলাদা হোস্টে, তাই `STOREFRONT_MEDIA_URL` সেট করতে হবে।
- **কার্ট:** ব্রাউজারে (localStorage), দাম প্রতিবার সার্ভারের quote থেকে। Abandoned cart রিপোর্ট আর
  রিমাইন্ডার SMS-এর জন্য সার্ভারে `storefront_carts` পরে আসবে।

### ১৪.৩ ডেটা মডেল

```
storefront_settings                ← টেন্যান্টপ্রতি একটা রো (ধাপ ২৬f)
  tenant_id (PK), subdomain (UNIQUE, শুধু label: acme), launched_at (NULL = শপ বন্ধ, 404)
  name, language, logo_image_id, brand_color, accent_color, hotline, address, সোশ্যাল লিংক
  default_warehouse_id, delivery_zones (JSONB: ঢাকার ভিতরে ৮০, বাইরে ১২০)
  free_delivery_from, minimum_order, payment_methods
  (পরে: gateway_credentials, default_courier_account_id, auto_consign, require_phone_otp)

storefront_domains                 ← পরের ধাপে: টেন্যান্টের নিজের কেনা ডোমেইন
  domain (UNIQUE), tenant_id, verified, ssl_status

storefront_categories              ← শপের নিজের ক্যাটাগরি ট্রি (প্রোডাক্টের ক্যাটাগরি না)
  tenant_id, parent_id, slug (UNIQUE per tenant), name, position

storefront_listings                ← Inventory-র variant-কে শপে "প্রকাশ" করা
  tenant_id, product_id, variant_id (FK → product_variants), category_id
  slug, name, pack_size, published_at (NULL = draft)
  price_override (NULL হলে variant-এর sale_price)
  sale_kind (percent | amount | price), sale_value, sale_starts_at, sale_ends_at
  badges, images (JSONB, সর্বোচ্চ ৪টা {id, alt}), description_sections (JSONB, HTML না)
  seo_title, seo_description
  UNIQUE (tenant_id, slug)

storefront_images                  ← একটা শপ-ছবির জবের অবস্থা (ধাপ ২৬g)
  id (PK = attachment-এর id), tenant_id → (tenant_id, id) FK attachments-এ, ON DELETE CASCADE
  status (processing | ready | failed), failure_code (শুধু failed হলে)
  width, height (শুধু ready হলে), processed_at
  ("uploading" মানে attachment এখনো pending আর রো নেই; omnivo_public-এর কোনো grant নেই)

storefront_banners (hero | image), storefront_collections + storefront_collection_items,
storefront_home_blocks (হোমপেজের ক্রম), storefront_pages (privacy | terms | about | contact)
  (টেবিলগুলো ধাপ ২৬f-এর; ধাপ ২৬h-এর CHECK: কালেকশনে position ১–২৪, হোমপেজে ১–১২, ক্যাটাগরির slug `all` না,
   কারণ `/c/all` হলো All Products; settings.logo_image_id → (tenant_id, id) FK storefront_images-এ)
  banners: href (ঠিকানা, id না), computer আর phone-এর আলাদা ছবি {id, alt}; শুধু hero-র headline, button
           আর চারটা রং (image banner-এর কথা ছবির ভেতরেই), workspace-প্রতি একটাই hero
  home_blocks: প্রতিটা রো একটা image banner বা একটা কালেকশন, ঠিক একটা; মুছলে cascade-এ পেজ থেকেও যায়
  pages: sections (JSONB), না লেখা পেজের কোনো রো নেই

storefront_orders                  ← ধাপ ২৭a
  tenant_id, order_no (W-000123, confirm-এ শপের নিজের counter থেকে; pending-এ NULL, তাই বাদ পড়া অর্ডারে ফাঁক নেই)
  status (pending | confirmed | packed | shipped | delivered | cancelled | returned)
  customer_name, phone (01XXXXXXXXX), address, zone_id, zone_name
  payment_method (cod | online), subtotal, discount, coupon_code, delivery_charge, total  ← সবই সার্ভারে হিসাব করা
  coupon_id                        ← ধাপ ২৭c: (tenant_id, coupon_id, coupon_code) FK কুপনে, তাই অর্ডারের কোড সবসময়
                                   কুপনেরই; CHECK: দুটোই থাকে বা দুটোই NULL, কুপন ছাড়া discount ০
  order_token_hash                               ← ব্রাউজারের httpOnly cookie-র token-এর SHA-256 (/order/<no>)
  tracking_token_hash                            ← ট্র্যাকিং লিংকের token-এর hash, confirm-এ; token নিজে কোথাও রাখা হয় না
  code_hash, code_expires_at, code_sent_at, code_sends, code_tries_left  ← ফোন কোড, শুধু pending-এ
  created_at, confirmed_at, packed_at, shipped_at, delivered_at, cancelled_at, returned_at  ← ইতিহাস এই কলামেই
  sales_order_id, delivery_id, invoice_id, sales_return_id  ← ধাপ ২৭b: অর্ডার যে ডকুমেন্ট বানিয়েছে, (tenant_id, id)
                                   FK; CHECK: packed-এর পরে challan, delivered-এ invoice, packed থেকে বাতিলে return
  document_error                   ← ধাপ ২৭b: Sales Order বানানো না গেলে শুধু error code, SO হলেই NULL
  cancel_reason                    ← ধাপ ২৭b: স্টাফের লেখা কারণ (২০০ অক্ষর), SMS-এ যায় না
  UNIQUE (tenant_id, order_no)
  (customer_id নেই: customer Sales Order থেকে পড়া হয়)

storefront_order_lines             ← লিস্টিং-এর কপি (নাম, slug, pack size, ছবি), লিস্টিং-এ FK নেই; variant-এ FK আছে
  tenant_id, order_id, position, listing_id, product_id, variant_id, quantity, unit_price, line_total

storefront_stock_holds             ← অর্ডার যে স্টক ধরে রাখে; নাম, ফোন বা ঠিকানা নেই, তাই omnivo_public পড়তে পারে
  tenant_id, order_id, product_id, variant_id, warehouse_id, quantity (base unit)
  expires_at                       ← pending-এ ৬০ মিনিট পরে; confirm-এ NULL, challan (Packed) বা বাতিল পর্যন্ত

storefront_settings-এ ধাপ ২৭b: delivery_product_id + delivery_variant_id (দুটোই থাকে বা দুটোই NULL) ←
  ডেলিভারি চার্জ যে service product হিসেবে বিল হয়

storefront_order_counters          ← শপ-প্রতি শেষ নম্বর (number_series না, SEQUENCE-ও না: rollback-এ ফাঁক)
  tenant_id, last_value

storefront_coupons                 ← ধাপ ২৭c: পুরো কার্টের কুপন (ডেলিভারি চার্জে কখনো না)
  tenant_id, code (A–Z, ০–৯, হাইফেন, ২০ অক্ষর; UNIQUE per tenant, archived সহ)
  discount_kind (percent | amount), discount_value, up_to (শুধু percent-এ)
  minimum, starts_on, last_day (date, workspace-এর time zone-এ, দুই দিনই ধরে)
  usage_limit, one_per_phone, archived_at (মোছা হয় না)
  first_ordered_at                 ← প্রথম অর্ডারে একবার বসে; এরপর কোড বদলায় না (guard trigger)
  (ব্যবহারের কোনো counter নেই: `storefront_coupon_uses()` SECURITY DEFINER ফাংশন অর্ডার গোনে, বাতিল বাদে,
   pending শুধু hold-এর ৬০ মিনিটের ভেতরে; omnivo_public archived কুপন দেখে না, omnivo_shop শুধু
   first_ordered_at বদলাতে পারে, যেটা কুপনের রো lock করার উপায়)

storefront_payment_gateways        ← ধাপ ২৭d: টেন্যান্টের নিজের SSLCommerz store, টেন্যান্ট-প্রতি একটা রো (PK tenant_id)
  provider (sslcommerz), mode (sandbox | live), store_id
  password_sealed (bytea), key_version  ← AES-256-GCM, `CREDENTIALS_KEY` দিয়ে; পাসওয়ার্ড কখনো API থেকে ফেরত যায় না
  money_account_id, fee_account_id ← টাকা যে অ্যাকাউন্টে ঢোকে আর গেটওয়ের ফি যে খরচের অ্যাকাউন্টে, দুটো আলাদা (CHECK)
  last_tested_at, last_test_problem (rejected | unreachable), version
  (শুধু omnivo_app পড়ে; omnivo_public আর omnivo_shop-এর কোনো grant নেই। শপ শুধু
   `storefront_online_ready()` SECURITY DEFINER ফাংশন থেকে হ্যাঁ/না জানে)

storefront_payments                ← ধাপ ২৭d: একটা অর্ডারের প্রতিটা পেমেন্টের চেষ্টা (try), সর্বোচ্চ ৩টা
  tenant_id, order_id, try_no (১–৩, UNIQUE per order), tran_id (আমাদের নিজের random ২০ অক্ষর, UNIQUE per tenant)
  provider, mode, status (started | not_opened | paid | failed | cancelled), amount
  started_at, settled_at, val_id, card_type, bank_tran_id, store_amount  ← গেটওয়ে নিজে যা বলেছে, ব্রাউজার না
  receipt_id, receipt_error        ← paid try-এর posted money receipt, বা সেটা না হওয়ার error code
  (guard trigger: paid চূড়ান্ত, আর paid try থাকা অর্ডার CASCADE-এ মোছা যায় না; online অর্ডারে ফোন কোডের কলাম খালি)

courier_accounts                   ← টেন্যান্টের নিজের কুরিয়ার অ্যাকাউন্ট
  tenant_id, courier_code (pathao | steadfast | redx | ecourier | paperfly | manual)
  credentials (encrypted), store_id, is_default, enabled, webhook_secret

shipments                          ← একটা কনসাইনমেন্ট
  tenant_id, order_id, courier_account_id
  consignment_id (কুরিয়ারের আইডি), tracking_code, label_url
  status, cod_amount, delivery_fee, cod_collected_at, remittance_id
  attempt_count, last_error, request_payload, response_payload (JSONB)
  UNIQUE (tenant_id, order_id, courier_account_id)   ← ডাবল কনসাইনমেন্ট ঠেকানোর দেয়াল

shipment_events                    ← append-only, কখনো আপডেট হয় না
  shipment_id, status, raw_payload, occurred_at, received_at

courier_remittances                ← কুরিয়ার কবে কত COD ফেরত দিল
  tenant_id, courier_account_id, amount, fee, reference, received_at, journal_entry_id
```

**মূল নিয়ম:**
- **প্রোডাক্ট ডুপ্লিকেট করবেন না।** `storefront_listings` শুধু Inventory-র প্রোডাক্টকে "প্রকাশ" করে, নতুন প্রোডাক্ট টেবিল না। দাম ও স্টকের সত্য একটাই জায়গায়।
- **বর্ণনায় টেন্যান্টের HTML নেই।** বর্ণনা আর টেক্সট পেজ section হিসেবে রাখা হয় (heading আর লেখা, `- `
  তালিকা, `**bold**`, লিংক); API সেখান থেকে HTML বানায় আর টেন্যান্টের লেখা প্রতিটা অক্ষর escape করে।
- **দাম সার্ভার ঠিক করে।** অফার রাখা হয় টেন্যান্ট যেভাবে লিখেছে (৳ বা % ছাড়, বা ছাড়ের পরের দাম); শপের
  দাম, কাটা দাম আর ribbon API বানায়। যে অফারে কিছু কমে না, সেটা দেখানো হয় না।
- **স্টক রিজার্ভেশন:** অর্ডার `pending` হলে স্টক "reserved" হবে (TTL সহ, যেমন ৬০ মিনিট বা কনফার্ম পর্যন্ত), `confirmed` হলে আসল মুভমেন্ট লিখবে। সরাসরি quantity আপডেট **কখনো না** (§১৭-এর ৬ নম্বর ভুল)।
  ধাপ ২৭a-তে: hold নিজের টেবিলে (`storefront_stock_holds`)। শপ দেখায় আর quote হিসাব করে **free = on hand − held**;
  free-র চেয়ে বেশি চাইলে লাইনটা `out_of_stock`। অর্ডার দেওয়ার সময় প্রতিটা variant-এ একটা lock (সাজানো ক্রমে), তাই
  শেষ পিসটা একবারই বিক্রি হয় (টেস্টে দুটো অর্ডার শেষ পিসের জন্য দৌড়ায়)। ধাপ ২৭b-তে: আসল মুভমেন্ট confirm-এ না,
  Packed-এর posted challan-এ, আর একই transaction-এ hold মুছে যায়; ততক্ষণ Sales Order স্টক ধরে না (ধাপ ১৫b),
  hold-ই ধরে।
- **ফোন কোড (ধাপ ২৭a):** ৬ অঙ্ক, শুধু HMAC hash রাখা (key `JWT_SECRET` থেকে HKDF দিয়ে, নিজের label-এ), ১০ মিনিট,
  ৫ বার ভুল, ৪৫ সেকেন্ড পরে নতুন কোড, এক অর্ডারে সর্বোচ্চ ৩টা কোড। ঠিক কোড নিজেই অর্ডার confirm করে: নম্বর, hold
  আর শেষ হয় না, ট্র্যাকিং token, দ্বিতীয় SMS-এ লিংক, আর outbox ইভেন্ট `storefront.order_confirmed` → worker →
  owner আর `storefront.order.read` যাদের আছে তাদের bell। ৫ বার ভুল হলে অর্ডার তখনই মুছে যায়, ৬০ মিনিটে কোড না
  এলে worker-এর ৫ মিনিট পরপর sweep মুছে দেয়, hold সহ: যে ফোন কখনো confirm হয়নি, সেটা রেখে দেওয়ার কারণ নেই।
- **Limit (ধাপ ২৭a):** এক ফোন থেকে ঘণ্টায় ৫টা আর এক connection (IPv6: /64) থেকে ২০টা অর্ডার, সব শপ মিলিয়ে, Redis-এ
  hash করা key-তে; `/track`-এ ১৫ মিনিটে ১০ বার ভুল। Redis বন্ধ থাকলে error (`500`), কখনো "limit নেই" না।
- **SMS (ধাপ ২৭a):** একটাই `SmsSender` interface; dev আর CI-তে প্রতিটা SMS Mailpit-এ একটা ইমেইল
  (`<phone>@sms.invalid`)। আসল provider (BulkSMSBD, SSL Wireless বা Alpha SMS) স্টেজিং আসল SMS পাঠানোর আগে ঠিক
  হবে, শুধু একটা নতুন class। কোড বা লিংক থাকা SMS কখনো outbox-এ যায় না (outbox-এ শুধু id থাকে): নিজের BullMQ
  `sms` queue-তে, transaction commit হওয়ার পরে, পাঠানো হলে Redis থেকে মুছে যায়। SMS হারালেও উত্তর ব্যর্থ হয় না:
  অর্ডার সেভ হয়ে গেছে, ক্রেতা আবার কোড চাইতে পারে।
- **`storefront_orders` ≠ `sales_orders`।** শপের অর্ডার হলো "গ্রাহকের অনুরোধ", যেটা বাতিল বা স্প্যাম হতে পারে। কনফার্ম হলেই সেটা ERP-র Sales Order-এ পরিণত হবে। এতে ভুয়া অর্ডার দিয়ে হিসাব নষ্ট হবে না।
- **সব টেবিলে `tenant_id` + RLS**, শপের কাস্টমার ডেটা (ফোন, ঠিকানা) সবচেয়ে সংবেদনশীল PII।

### ১৪.৪ অর্ডার ফ্লো: COD ও অনলাইন পেমেন্ট

```mermaid
sequenceDiagram
  participant C as ক্রেতা (শপ)
  participant S as Storefront API
  participant PG as PostgreSQL
  participant W as Worker (BullMQ)
  participant GW as পেমেন্ট গেটওয়ে
  participant CR as কুরিয়ার API

  C->>S: চেকআউট (cart_token, ঠিকানা, payment_method)
  S->>S: দাম, স্টক, ডেলিভারি চার্জ সার্ভারে আবার হিসাব
  alt COD
    S->>PG: order (pending) + স্টক reserve + outbox
    S-->>C: "অর্ডার পেয়েছি" + OTP/কল ভেরিফিকেশন
    Note over S,PG: OTP বা সেলস টিম কনফার্ম করলে → confirmed
  else অনলাইন পেমেন্ট (ধাপ ২৭d)
    S->>PG: order (pending) + স্টক hold + try ১ (tran_id)
    S->>GW: পেমেন্ট পেজ চাওয়া (commit-এর পরে, amount সার্ভার থেকে)
    S-->>C: পেমেন্ট পেজের ঠিকানা, ফোন কোড নেই
    C->>GW: পেমেন্ট
    GW-->>S: ব্রাউজারের POST (শপ হয়ে) + IPN: শুধু tran_id, val_id
    S->>GW: validation / transaction query
    S->>PG: try lock করে paid + order confirmed + outbox (idempotent)
    PG-->>W: outbox: storefront.payment_paid → money receipt (advance) + ফি
  end
  PG-->>W: outbox event: OrderConfirmed
  W->>PG: Sales Order + স্টক মুভমেন্ট + জার্নাল
  W->>CR: কনসাইনমেন্ট তৈরি (idempotency key = order_id)
  CR-->>W: consignment_id + tracking_code + label_url
  W->>PG: shipments রো + order → packed/shipped
  W-->>C: SMS: ট্র্যাকিং লিংক
```

- ⚠️ **ব্রাউজার থেকে আসা কোনো দাম, ডিসকাউন্ট বা ডেলিভারি চার্জ বিশ্বাস করবেন না।** ব্রাউজার শুধু `listing_id`, পরিমাণ, এলাকা আর কুপন কোড পাঠাবে; টাকার অঙ্ক সার্ভার হিসাব করবে (§১৩.৩-এর একই সতর্কতা)।
- **COD-এ কনফার্মেশন ধাপ বাধ্যতামূলক রাখুন** (OTP বা ফোন কল)। ভুয়া COD অর্ডার বাংলাদেশে বড় সমস্যা, আর কনসাইনমেন্ট হয়ে গেলে কুরিয়ার ফি ফেরত আসে না।
- **অনলাইন পেমেন্টে গেটওয়ে টেন্যান্টের নিজের** (SSLCommerz/bKash মার্চেন্ট অ্যাকাউন্ট)। Omnivo শুধু কী সংরক্ষণ করে ও কল করে, টাকা কখনো Omnivo-র অ্যাকাউন্টে আসে না। এতে PCI ও মানি-ট্রান্সমিশন ঝুঁকি Omnivo-র ঘাড়ে পড়ে না।
- গেটওয়ের webhook **idempotent** হবে (একই `transaction_id` দুইবার এলে দ্বিতীয়বার কিছুই হবে না)।

### ১৪.৫ টেন্যান্ট তার শপ কীভাবে নিয়ন্ত্রণ করবে

সব নিয়ন্ত্রণ ERP অ্যাপের ভেতরের **Storefront** মেনু থেকে, কোনো কোড বা ডিপ্লয় ছাড়াই:

| সেকশন | কী করা যাবে |
|---|---|
| **Catalog** | কোন প্রোডাক্ট শপে দেখাবে, ছবি, বর্ণনা, SEO, ক্যাটাগরি, সাজানোর ক্রম, শপ-এর জন্য আলাদা দাম বা অফার |
| **Appearance** | লোগো, রং, ব্যানার, হোমপেজ সেকশন, বাংলা/ইংরেজি |
| **Delivery** | এলাকাভিত্তিক ডেলিভারি চার্জ, ফ্রি ডেলিভারির সীমা, কোন এলাকায় ডেলিভারি হবে |
| **Payments** | COD আর Pay online চালু/বন্ধ, Online payment কার্ডে SSLCommerz store আর দুটো অ্যাকাউন্ট (ধাপ ২৭d), ন্যূনতম অর্ডার |
| **Couriers** | কুরিয়ার অ্যাকাউন্ট যোগ করা, ডিফল্ট কুরিয়ার, **অটো-কনসাইনমেন্ট নীতি** (বন্ধ / কনফার্মে / পেমেন্টে) |
| **Coupons** | কুপন কোড: percent বা টাকা, ন্যূনতম অর্ডার, শুরু-শেষ দিন, মোট ব্যবহার, এক নম্বরে একবার (ধাপ ২৭c) |
| **Orders** | অর্ডার বোর্ড (pending → confirmed → packed → shipped → delivered), বাল্ক লেবেল প্রিন্ট, বাল্ক কনসাইনমেন্ট, বাতিল ও রিটার্ন |
| **Domain** | `acme.omnivo.shop` বা নিজের ডোমেইন সংযোগ (DNS ধাপ সহ) |

**ধাপ ২৬g-তে যা তৈরি হয়েছে:**

- পারমিশন `storefront.manage` (নিজের গ্রুপ "Online shop"; retail-এর Shop manager আর সাধারণ Manager টেমপ্লেটে আছে)।
  এটা না থাকলে সাইডবারে Storefront গ্রুপই দেখায় না, আর API প্রতিটা রুটে `403` দেয়। সব পেজ অনলাইনে চলে, প্রতিটা
  ফর্মে version check, প্রতিটা সেভ audit log-এ।
- **Shop settings** (`/storefront/settings`): ঠিকানা (subdomain, workspace-এর slug থেকে শুরু), নাম, ভাষা,
  যোগাযোগ, সোশ্যাল লিংক, ডিফল্ট warehouse, সর্বোচ্চ ৬টা delivery zone, ফ্রি ডেলিভারি, ন্যূনতম অর্ডার, পেমেন্ট মেথড।
  উপরের টেবিলের Delivery আর Payments আলাদা মেনু না, এখানেই। শপ খোলে একটা চেকলিস্ট পূরণ হলে (warehouse, অন্তত
  একটা zone, ছবি আর দাম সহ অন্তত একটা প্রকাশিত লিস্টিং), আর খোলা শপ আর বন্ধ হয় না। খোলার পরেও subdomain বদলানো
  যায়, একটা ডায়ালগ জানায় যে পুরনো লিংক কাজ করবে না (redirect নেই)।
- **Shop categories** (`/storefront/categories`): শপের নিজের ট্রি, Move up/down, লিস্টিং বা ভেতরে ক্যাটাগরি
  থাকলে মোছা যায় না।
- **Catalog** (`/storefront/listings`, সার্ভারে paged) আর লিস্টিং এডিটর: "Add to shop" একটা variant থেকে draft
  বানায়; এডিটরে নাম, link name, pack size, ক্যাটাগরি, badge, ছবি (সর্বোচ্চ ৪টা, alt বাধ্যতামূলক), শপের দাম ও
  অফার (`listingPricing()` দিয়ে লাইভ প্রিভিউ), বর্ণনার section, SEO, তারপর Show in the shop। শপের সার্ভার
  উত্তর ৩০ সেকেন্ড রাখে, তাই প্রতিটা পেজ বলে "Changes show in the shop within a minute"।
- এখনো না: একসাথে অনেক প্রোডাক্ট যোগ, অব্যবহৃত ছবি মুছে ফেলা, নিজের ডোমেইন, `feature.storefront` entitlement।

**ধাপ ২৬h-তে যা তৈরি হয়েছে** (উপরের টেবিলের Appearance; বাকি সেকশন ধাপ ২৭–২৮-এ):

- একই পারমিশন `storefront.manage`, সাইডবারে আরো দুটো: Shop appearance আর Shop pages। API-র ১৬টা রুট
  (`/storefront/appearance/*`, `/storefront/pages/*`), প্রতিটা শপ set up হওয়ার পরেই কাজ করে (আগে
  `409 storefront_not_set_up`, আর স্ক্রিন বলে "Set up the shop first")।
- **Shop appearance** (`/storefront/appearance`): লোগো আর দুটো রং (brand, accent) নিজের ফর্মে, version check সহ।
  রং যাচাই: brand↔accent ৪.৫:১, brand↔cream ৪.৫:১, hero-র বাটন↔তার লেখা ৪.৫:১, সাদা headline↔panel ৩:১ (বড় লেখা)।
  একটাই `contrastRatio()` contracts-এ, ফর্ম টাইপ করার সময় দেখায়, API সেভে আবার যাচাই করে আর error code দিয়ে ফেরায়।
- **Hero** নিজের পেজে (`/storefront/appearance/hero`): কথা, computer আর phone-এর ছবি, "Links to", চারটা রং, আর
  দুই সাইজে শপের মতো একটা লাইভ ড্রয়িং। **Picture banner** একটা ডায়ালগে, **কালেকশন** নিজের পেজে
  (`/storefront/appearance/collections/$id`, সর্বোচ্চ ২৪টা লিস্টিং ক্রমে; draft থাকতে পারে, শপে প্রকাশ হলে দেখায়)।
- **হোমপেজের ক্রম:** প্রতিটা ব্যানার আর কালেকশন হোমপেজেই থাকে, "লুকানো" অবস্থা নেই: যোগ করলে শেষে যায়, মুছলে
  মুছে যায়। সীমা ৬টা picture banner, ৮টা কালেকশন, ১২টা ব্লক। Move up/down আর প্রতিটা যোগ-মোছা একটা শপ-প্রতি
  advisory lock-এর ভেতরে চলে, আর position সবসময় ১..n (মুছলে আবার নম্বর দেয়)। দুটো ব্লক অদলবদল এক UPDATE-এ
  হয় না (unique position), তাই API সব রো মুছে আবার লেখে।
- **"Links to":** ব্যানারের লিংক ঠিকানাই থাকে (`href`, id না): শপের ক্যাটাগরি, একটা প্রোডাক্ট, অফারের প্রোডাক্ট
  (`/c/all?offer=1`), সব প্রোডাক্ট, বা অন্য ঠিকানা। পরে slug বদলালে লিংক "page not found" দেখায়, আর ফর্ম সেটা বলে।
- **Shop pages** (`/storefront/pages`): চারটা পেজ, লিস্টিং-এর বর্ণনার একই section এডিটরে (`SectionsCard`)।
  কোনো template নেই, কারণ privacy আর terms টেন্যান্টের নিজের আইনি কথা। শপের `publicShopSchema`-তে `pages` (শুধু
  লেখা পেজগুলো), তাই ফুটার শুধু সেগুলোর লিংক দেয়।
- **ছবি** (লোগো, hero, ব্যানার) লিস্টিং-এর ছবির মতোই `storefront_image` আপলোড আর sharp জব (ধাপ ২৬g)।
- **Dev seed** `pnpm seed:shop` (`apps/shop/scripts/`): চালু dev stack-এ HTTP API দিয়ে একটা demo workspace
  বানায় (sign-up, warehouse, প্রোডাক্ট আর opening stock, শপের ক্যাটাগরি, মকের ২২টা ছবি সহ লিস্টিং, hero, Mega
  Sale ব্যানার, কালেকশন, চারটা পেজ, তারপর শপ খোলে), ~৭ সেকেন্ডে। workspace আগে থেকে থাকলে বার্তা দিয়ে থামে।
  CI-তে না; সরাসরি DB-তে না লিখে API দিয়ে, তাই প্রতিটা নিয়ম আর audit log আসল পথেই চলে।
- এখনো না: ব্যানারের শুরু-শেষ তারিখ, hero carousel, দুটোর বেশি রং, পেজ template, অব্যবহৃত ছবি মুছে ফেলা।
  স্টেজিং এখনো মক শপ দেখায় (wildcard শপ-হোস্ট লাগবে, `vps-deploy.en.md`)।

**ধাপ ২৭a-তে যা তৈরি হয়েছে** (উপরের টেবিলের Orders-এর ভিত্তি; স্ক্রিন ধাপ ২৭b-তে):

- নতুন পারমিশন `storefront.order.read` (অর্ডার, ক্রেতার ফোন আর ঠিকানা দেখা) আর `storefront.order.manage`
  (অর্ডার এগিয়ে নেওয়া আর বাতিল), `storefront.manage` থেকে আলাদা: প্যাকারের শপের দাম বদলানোর দরকার নেই। নতুন
  workspace-এ শপ চালানোর দুটো role টেমপ্লেট দুটোই পায়।
- শপের `api` source আর মক order book ব্যবহার করে না: চেকআউট, ফোন কোড, `/order/<no>`, `/t/<token>` আর `/track`
  সব API-র ৭টা `auth: 'shop'` রুটে। মক source একই কোডের নিয়ম রাখে (১০ মিনিট, ৩টা কোড), অর্ডারের limit না, তাই
  `pnpm dev` আর Playwright আগের মতো চলে।
- নতুন অর্ডারের bell ("New shop order W-000123 for ৳578.") ধাপ ২৭a-তে Overview খুলত; ধাপ ২৭b থেকে অর্ডারের পেজ।
- অনলাইন পেমেন্ট ধাপ ২৭d পর্যন্ত চেকআউটে দেখাত না (শুধু সেটাই শপের একমাত্র মেথড হলে দেখায়, আর অর্ডার
  `shop_payment_unavailable`)। কুপন ধাপ ২৭c পর্যন্ত "unknown" ছিল।

**ধাপ ২৭b-তে যা তৈরি হয়েছে** (উপরের টেবিলের Orders, বোর্ডের বদলে status tab সহ লিস্ট):

- **Confirm → customer + Sales Order, worker-এ।** `storefront.order_confirmed` ইভেন্টের handler (`omnivo_app`
  হিসেবে, member ছাড়া, তাই ডকুমেন্টের `created_by` NULL) আগে ফোন দিয়ে customer খোঁজে: দুই পাশই ১১ অঙ্কে
  (`01786120356`), কয়েকটা active মিললে সবচেয়ে পুরনোটা, না মিললে ক্রেতার নাম, ফোন আর ঠিকানা দিয়ে নতুন customer
  (credit limit ছাড়া)। তারপর confirmed Sales Order: দাম VAT সহ, লাইনের দাম শপের unit price, তাই ERP-র মোট শপের
  মোটের সাথে পয়সা পর্যন্ত মেলে; ঠিকানা লেখা হিসেবে (customer-এর সেভ করা ঠিকানা বদলায় না)। credit limit পার হলেও
  অর্ডার হয় (POS-এর মতো), audit log-এ actor ছাড়া। ক্রেতার confirm কখনো ERP-র কারণে ব্যর্থ হয় না: handler না
  পারলে (একটা archived প্রোডাক্ট, ধরুন) error code অর্ডারে থাকে (`document_error`), লিস্টে "Needs attention",
  পেজে "Make the sales order" বাটন। handler অর্ডার `FOR UPDATE` lock করে, তাই দুটো SO হয় না।
- **ডেলিভারি চার্জ একটা service product।** প্রথম চার্জওয়ালা অর্ডার "Delivery charge" বানায় একবার (workspace-এর
  pcs unit আর ডিফল্ট VAT rate-এ, settings lock করে), id শপের settings-এ থাকে, Shop settings-এ অন্য service বাছা
  যায়; কোনো অর্ডার ব্যবহার করার পরে খালি করা যায় না। ফ্রি ডেলিভারিতে লাইন নেই।
- **Packed = posted challan** hold-এর warehouse থেকে, একই transaction-এ hold মুছে। ডায়ালগের batch আর পরামর্শ
  নিজের রুট থেকে (`pack-plan`, first-expiry-first সার্ভারে, কারণ প্যাকারের স্টক স্ক্রিন পড়ার অধিকার নেই);
  serial প্রোডাক্টে পরামর্শ নেই। challan হাতে লেখা challan-এর মতোই যাচাই হয় (স্টক না থাকলে তার নিজের error,
  ঠিক সেই pick-এর নিচে)।
- **Shipped শুধু status** (কুরিয়ার ধাপ ২৮-এ)। **Delivered = posted invoice** challan-এর লাইন আর ডেলিভারি চার্জের,
  তারিখ workspace-এর আজ, unpaid; Shipped-এর পরেই শুধু। COD-এর টাকা সাধারণ money receipt-এ ("Record payment"
  লিংক); ধাপ ২৮-এ কুরিয়ারের payout থেকে।
- **Cancel** New-এ (SO বাতিল, hold শেষ) আর Packed-এ (পুরো challan-এর posted sales return, তারপর SO বাতিল: সব
  ফেরত আসার পরে SO কিছুই ডেলিভার করেনি, তাই Close না, Cancel)। Shipped-এর পরে না (সেটা "returned", ধাপ ২৮)।
  commit-এর পরে ক্রেতাকে SMS, শপের hotline সহ; কারণ শুধু স্টাফের।
- **পারমিশন:** `storefront.order.manage` দিয়েই ডকুমেন্ট হয়, প্যাকারের `sales.*` লাগে না। sales service-গুলোর
  ভেতরে caller-এর transaction-এর entry point (`createForShop`, `cancelIn`, `postForShopOrder`, `createIn`), তাই
  শপের নিয়মের আলাদা কপি নেই। প্রতিটা মুভ অর্ডারের audit action (`storefront_order.packed`, …), ডকুমেন্ট নিজেরাও লেখে।
  প্রতিটা মুভে version check, ভুল ধাপে `storefront_order_step_invalid`।
- **স্ক্রিন:** Storefront গ্রুপে প্রথমে Shop orders (গ্রুপ `storefront.order.read` দিয়েও দেখায়, নতুন অর্ডারের
  সংখ্যা নিজের ছোট রুট `counts` থেকে), tab সহ লিস্ট, অর্ডারের পেজ। pending অর্ডার ERP কখনো দেখায় না। অনলাইন শুধু।
- **এখনো না:** কুপন (ধাপ ২৭c) আর SSLCommerz (ধাপ ২৭d), আসল SMS provider, কুরিয়ার, COD-এর টাকা নিজে থেকে আর ফেরত আসা
  পার্সেল (ধাপ ২৮), অর্ডার এডিট, একসাথে অনেক অর্ডার প্যাক। স্টেজিং এখনো মক শপে।

**ধাপ ২৭c-তে যা তৈরি হয়েছে** (কুপন; উপরের টেবিলে নতুন সেকশন, অনলাইন পেমেন্ট ধাপ ২৭d-তে):

- **Shop coupons** (`/storefront/coupons`, পারমিশন `storefront.manage`, Catalog-এর পরে): Current / Archived tab,
  কোড দিয়ে search, ডায়ালগে নতুন বা এডিট, Archive (আগে জিজ্ঞেস করে) আর Restore। শপ set up হওয়ার আগেও চলে।
  প্রতিটা সেভে version check আর audit log (`storefront_coupon.created` / `updated` / `archived` / `restored`)।
- **নিয়ম:** percent (১–৯৯, পূর্ণ সংখ্যা, ঐচ্ছিক "up to") বা টাকা; ঐচ্ছিক ন্যূনতম অর্ডার (ডেলিভারি ছাড়া আইটেমের
  দাম), প্রথম আর শেষ দিন, মোট কয়টা অর্ডার, আর "এক মোবাইল নম্বরে একবার"। প্রথম দিনের আগে আর archived কুপন শপে
  "unknown" (কোডটা আছে কিনা বাইরের কেউ জানতে পারে না)। একটা নিয়ম, একটা ফাংশন: `judgeShopCoupon()` আর
  `shopCouponDiscount()` contracts-এ, API আর মক শপ দুটোই সেটা ডাকে।
- **ব্যবহার গোনা:** অর্ডার দেওয়ার সময় থেকে (ফোন কোডের অপেক্ষায় থাকা অর্ডারও একটা ধরে রাখে, hold-এর ভেতরে), বাতিল
  হলে ফেরত দেয়। অর্ডার দেওয়ার সময় কুপনের রো `FOR UPDATE` lock হয়, তারপর নতুন statement-এ গোনা, তাই শেষ
  ব্যবহারটা একবারই যায়: দৌড়ে হারা অর্ডার মোট বদলেছে বলে `409 shop_order_changed` পায়। "এক নম্বরে একবার"
  শুধু অর্ডার দেওয়ার সময় জানা যায় (`422 shop_coupon_used_by_phone`), quote-এ না।
- **ERP-র ডকুমেন্টে:** ছাড় আইটেমের লাইনগুলোতে line discount হিসেবে ভাগ হয় (`spreadMoney()`, largest remainder,
  পয়সা পর্যন্ত, ডেলিভারি লাইনে কখনো না), তাই Sales Order আর invoice-এর মোট শপের মোটের সাথে মেলে। ধাপ ২৭b-র invoice
  লাইনে discount ০ ছিল; এখন challan-এর লাইনগুলো SO লাইনের ছাড় নিজেদের ভাগমতো নেয়।
- **চেকআউট:** promo box-এ কোড লাগানো থাকলে "WELCOME10 applied: 10% off, up to ৳200"; প্রতিটা প্রত্যাখ্যানের নিজের
  error code (unknown, expired, used up, minimum, used by phone)।
- **এখনো না:** SSLCommerz আর অনলাইন পেমেন্ট (ধাপ ২৭d), নির্দিষ্ট প্রোডাক্ট বা ক্যাটাগরির কুপন, ফ্রি ডেলিভারি কুপন,
  এক অর্ডারে একাধিক কুপন, কুপন-প্রতি রিপোর্ট।

**ধাপ ২৭d-তে যা তৈরি হয়েছে** (অনলাইন পেমেন্ট, SSLCommerz; উপরের টেবিলের Payments আর §১৪.৪-এর অনলাইন ধারা):

- **গেটওয়ে টেন্যান্টের নিজের:** Shop settings-এ Online payment কার্ড (নিজের form, নিজের রুট আর version,
  `storefront.manage`): store ID, sandbox বা live, write-only পাসওয়ার্ড, টাকার অ্যাকাউন্ট আর ফির খরচের অ্যাকাউন্ট।
  পাসওয়ার্ড AES-256-GCM-এ sealed, `CREDENTIALS_KEY` (৩২ byte, `api` আর `worker`-এ একই) আর key version সহ; key না
  থাকলে `storefront_gateway_key_missing`। "Test connection" সেভ করা মান দিয়ে SSLCommerz-এর transaction query করে,
  তাই পাসওয়ার্ড টেস্টের জন্য আবার পাঠাতে হয় না। audit log-এ (`storefront_payment_gateway.created` / `updated` /
  `tested`) পাসওয়ার্ড কখনো থাকে না, শুধু "changed"। কার্ড আর দুটো অ্যাকাউন্ট ঠিক থাকলেই Pay online টিক দেওয়া যায়
  (`storefront_online_not_ready`); টিক তুলে দিলে শপের এক মিনিটের cache-এর মধ্যে চেকআউট থেকে যায়, পথে থাকা পেমেন্ট
  তবুও settle হয়। শপের ব্যবহার করা অ্যাকাউন্ট মোছা যায় না (`account_used_by_shop`), archive করা যায়।
- **গেটওয়ের কোড** `apps/api/src/payments/`-এ (interface, `SslcommerzGateway`, `FakeGateway`), যাতে ধাপ ২৪-এর
  subscription billing-ও এটা নিতে পারে। `PAYMENT_GATEWAY=fake|sslcommerz`: production-এর বাইরে fake, production-এ
  fake চলে না। SSLCommerz-এর sandbox account এখনো নেই, তাই `SslcommerzGateway` শুধু ডকুমেন্টেশনের উত্তর দিয়ে
  যাচাই করা; বাকি সব fake gateway দিয়ে। প্রথম live শপের আগে একবার sandbox store দিয়ে চালাতে হবে।
- **অর্ডার:** online অর্ডার pending হয়, স্টক hold করে আর try ১ বানায়; commit-এর পরে API গেটওয়ের কাছে পেজ চায়
  আর `next: 'pay'` দিয়ে তার ঠিকানা পাঠায় (পেজ না খুললে `paymentUrl: null`, অর্ডার আর hold থাকে)। ফোন কোড নেই:
  পেমেন্টই অর্ডার confirm করে।
- **ফিরে আসা:** SSLCommerz শপে ব্রাউজারকে POST করে (`/checkout/pay/return`) আর নিজে IPN পাঠায়
  (`/api/payments/notice`)। শপ শুধু `tran_id` আর `val_id` পড়ে, একটা `auth: 'shop'` রুট (`/public/v1/payments/settle`)
  গেটওয়েকে নিজে জিজ্ঞেস করে (`val_id` দিয়ে, না থাকলে `tran_id` দিয়ে) আর status, amount, currency আর try মিলিয়ে
  দেখে, try-এর রো lock করে, তাই দ্বিতীয় ডাক কিছু বদলায় না। Astro-র `checkOrigin` বন্ধ, middleware একই চেক
  করে শুধু এই দুটো পথ ছাড়া, আর `same-site`-ও ফেরায় (অন্য টেন্যান্টের শপ একই site)। ফিরে আসার পথ সবসময় 303 দিয়ে
  `/checkout/paid`-এ পাঠায়, যেখানে `SameSite=Lax` cookie কাজ করে।
- **না হলে:** "Try again" (একই অর্ডার আর hold-এ নতুন try, মোট ৩টা) বা "Pay on delivery" (অর্ডার COD হয়ে ফোন কোড
  পায়)। শুধু paid চূড়ান্ত, তাই failed বা cancelled-এর পরে গেটওয়ে paid বললে সেটাই গণ্য। hold শেষ হওয়ার পরে টাকা
  এলেও অর্ডার confirm হয়, স্টক আবার Packed-এ দেখা হয়; sweep pending online অর্ডার মোছার আগে গেটওয়েকে জিজ্ঞেস করে
  (+১ ঘণ্টা সময়)।
- **হিসাব:** paid try-এ worker (outbox `storefront.payment_paid`) একটা posted money receipt বানায় (advance), কার্ডের
  টাকার অ্যাকাউন্টে, reference-এ `bank_tran_id` আর `card_type`। SSLCommerz-এর ফি (`amount − store_amount`) সেই
  receipt-এর entry-তে নিজের লাইনে ফির অ্যাকাউন্টে যায়: Dr টাকা (store_amount), Dr ফি, Cr receivable। Delivered-এ
  invoice এই advance নেয়, তাই invoice paid হয়। receipt না হলে error try-এ থাকে, "Make the receipt" আবার চেষ্টা করে।
- **ERP-র স্ক্রিন:** অর্ডারের পেজে Payments কার্ড (প্রতিটা try, transaction ID, ফি, receipt), টাকা ফেরত দেওয়ার
  দরকার হলে notice আর "Record refund" (ধাপ ১৫d-র refund, receipt থেকে): বাতিল হওয়া paid অর্ডার, দুইবার paid, বা
  paid-এর পরে COD। লিস্টে "Paid online"; timeline-এ "Confirmed when the payment arrived"।
- **শপ:** চেকআউটে "Pay online" ("Mobile Banking"-এর বদলে), `/checkout/paid` (paid, checking, unpaid), আর fake
  gateway-এর নিজের পেজ `/checkout/fake-gateway` (Pay, Fail, Cancel; development, CI আর মক শপে)।
- **এখনো না:** SSLCommerz-এর refund API দিয়ে টাকা ফেরত (ধাপ ২৮), sandbox store দিয়ে আসল যাচাই, bKash-এর নিজের
  API, নিজের ডোমেইনের শপ। স্টেজিং production mode-এ চলে, তাই সেখানে `CREDENTIALS_KEY` সেট না করা পর্যন্ত কার্ড
  সেভ হয় না; স্টেজিং শপ এখনো মক।

- **Omnivo Admin Panel** এখানে শুধু একটা জায়গায় আসে: Storefront কোন প্ল্যানে থাকবে, সেটা `feature.storefront` entitlement দিয়ে ঠিক হবে (§১৩.২)। অর্থাৎ Storefront বিক্রি হবে Growth প্ল্যানের ফিচার বা আলাদা অ্যাড-অন হিসেবে, আর কোডে কখনো `if (plan === 'growth')` লেখা হবে না।
- ⚠️ থিম কাস্টমাইজেশনের চাপ আসবেই। উত্তর হলো **কনফিগারেশন ও কয়েকটা রেডিমেড থিম**, টেন্যান্ট-ভিত্তিক কাস্টম কোড না (§৪.৮)।

### ১৪.৬ কুরিয়ার ইন্টিগ্রেশন: অর্ডার হলেই অটো কনসাইনমেন্ট

এটাই এই সেকশনের সবচেয়ে গুরুত্বপূর্ণ অংশ, আর এখানেই সবচেয়ে বেশি ভুল হয়।

**অ্যাডাপ্টার প্যাটার্ন।** প্রতিটা কুরিয়ারের API আলাদা, তাই ব্যবসায়িক কোড কখনো সরাসরি কুরিয়ারের API চিনবে না:

```ts
// packages/contracts — সব কুরিয়ার এই ইন্টারফেস মেনে চলবে
export interface CourierAdapter {
  code: 'pathao' | 'steadfast' | 'redx' | 'ecourier' | 'paperfly';
  checkServiceability(addr: Address): Promise<{ ok: boolean; zoneId?: string }>;
  quote(input: ShipmentInput): Promise<{ fee: Money; etaDays: number }>;
  createConsignment(input: ShipmentInput, idempotencyKey: string): Promise<Consignment>;
  cancelConsignment(consignmentId: string): Promise<void>;
  getStatus(consignmentId: string): Promise<ShipmentStatus>;   // webhook না থাকলে polling
  parseWebhook(body: unknown, signature: string): ShipmentEvent; // সবসময় signature যাচাই
  printLabel(consignmentId: string): Promise<{ url: string }>;
}
```

প্রতিটা কুরিয়ারের নিজস্ব স্ট্যাটাস নাম (`in_review`, `pickup_pending`, `partial_delivered`…) অ্যাডাপ্টারেই Omnivo-র **একটাই স্ট্যাটাস সেটে** ম্যাপ হবে। ব্যবসায়িক কোড শুধু Omnivo-র স্ট্যাটাস জানবে।

**কনসাইনমেন্ট তৈরির নিয়ম:**

1. অর্ডার `confirmed` হলে (বা পেমেন্ট হলে, নীতি অনুযায়ী) DB transaction-এই **outbox** রো লেখা হবে: `OrderConfirmed`। কুরিয়ারের API কখনো HTTP রিকোয়েস্টের ভেতরে কল করবেন না, না হলে কুরিয়ার ধীর হলে আপনার চেকআউটও ধীর হবে।
2. Worker সেই ইভেন্ট নিয়ে `createConsignment` কল করবে, **idempotency key = `order_id`**, আর `shipments`-এ `UNIQUE (tenant_id, order_id, courier_account_id)` থাকবে। দুইটা মিলে নিশ্চিত করবে: নেটওয়ার্ক টাইমআউটে জব আবার চললেও **এক অর্ডারে দুইটা পার্সেল যাবে না**।
3. টাইমআউট হলে আগে `getStatus` দিয়ে দেখবে কনসাইনমেন্ট আসলে তৈরি হয়ে গিয়েছিল কিনা, তারপরই আবার চেষ্টা করবে।
4. **Retry:** exponential backoff-এ ৫ বার। তারপরও ব্যর্থ হলে অর্ডার `needs_attention` হবে, টেন্যান্টকে নোটিফিকেশন যাবে, আর অ্যাডমিন বোর্ডে "Retry" বাটন থাকবে। **কখনো নীরবে ব্যর্থ হবেন না**, তাহলে ক্রেতার পার্সেল কখনোই যাবে না।
5. কুরিয়ারের অ্যাকাউন্ট ভুল/ক্রেডিট শেষ হলে ভিন্ন এরর মেসেজ দেখাবে, কারণ এটা টেন্যান্টের সমস্যা, Omnivo-র বাগ না।

**স্ট্যাটাস আপডেট (দুই পথ):**
- **Webhook** (যারা দেয়): `POST /public/v1/couriers/:code/webhook` → signature ও timestamp যাচাই → `shipment_events`-এ append → shipment ও order স্ট্যাটাস আপডেট। একই ইভেন্ট দুইবার এলে কিছুই বদলাবে না (idempotent)।
- **Polling fallback:** যেসব কুরিয়ারে webhook নেই, তাদের জন্য শিডিউলড জব (যেমন ১৫ মিনিট পরপর, শুধু চলমান শিপমেন্টের জন্য)। কুরিয়ারের rate limit মাথায় রেখে টেন্যান্টপ্রতি ব্যাচে।
- ক্রেতা ট্র্যাকিং দেখবে SMS-এ পাওয়া লিংকে, `acme.omnivo.shop/t/<token>` (১২৮-bit token, শুধু hash রাখা হয়;
  পেজে নাম, ঠিকানা বা পুরো ফোন নম্বর নেই, কারণ লিংক অন্যকে পাঠানো যায়), আর গুরুত্বপূর্ণ ধাপে SMS পাবে। SMS
  হারালে `/track`-এ ফোন + অর্ডার নম্বর দিয়ে একই পেজ দেখা যায় (এক IP থেকে ১৫ মিনিটে ১০ বার ভুল হলে থামে)।

**যা বানানো হয়েছে (ধাপ ২৮a, ২০২৬-১১-২৩):** উপরের ইন্টারফেসটা পরিকল্পনা ছিল; আসল কোডে `CourierAdapter` ছোট রাখা
হয়েছে, আর এটা `apps/api/src/shipping/`-এ থাকে (contracts-এ নয়, কারণ শুধু API আর worker এটা চেনে):

- `book` / `find` (invoice দিয়ে খোঁজা) / `status` / `readNotice` (webhook-এর body) / `test` (keys ঠিক কিনা)। এখন
  দুইটা: `SteadfastAdapter` আর `FakeCourier` (`COURIER_MODE=fake|live`, production-এ fake চলে না, ২৭d-র fake
  gateway-এর মতো)। Pathao পরে (২৮d), কারণ তার ঠিকানা city/zone/area আলাদা লাগে। `checkServiceability`, `quote`,
  `cancelConsignment` আর `printLabel` নেই: Steadfast-এর cancel API নেই (কুরিয়ারের প্যানেলে cancel), আর লেবেল ERP
  নিজেই A6 শিটে ছাপে।
- **Manual অ্যাকাউন্ট:** যে কুরিয়ারের API নেই, তার জন্য অ্যাকাউন্ট শুধু কুরিয়ারের নাম রাখে; Book courier-এ
  ট্র্যাকিং কোড হাতে লেখা হয়, অর্ডার বাটন দিয়ে চলে। CSV export (Steadfast-এর bulk upload কলাম) আর লেবেল দুই ধরনের
  অ্যাকাউন্টেই কাজে লাগে।
- **কখন বুক হয়:** confirm-এ নয়, **Packed-এ** (তখনই batch/serial বাছা হয় আর বাক্স তৈরি)। Packed dialog-এর "Send
  with" শুরু হয় ডিফল্ট অ্যাকাউন্ট দিয়ে; ডিফল্ট না থাকলে "Don't book now"। তাই "বুক বন্ধ" মানে শুধু ডিফল্ট নেই।
- **Idempotency:** কুরিয়ারের `invoice` = আমাদের অর্ডার নম্বর (`W-000123`, দ্বিতীয় পার্সেল `W-000123-2`), আর
  `storefront_shipments`-এ `UNIQUE (tenant_id, courier_account_id, invoice)` + অর্ডারপ্রতি একটাই চলমান পার্সেল।
  টাইমআউটের পরের চেষ্টায় worker আগে invoice দিয়ে কুরিয়ারকে জিজ্ঞেস করে।
- **Webhook:** অ্যাকাউন্টপ্রতি একটা ঠিকানা `POST /public/v1/couriers/steadfast/<account id>`, অ্যাকাউন্টের নিজের
  Bearer token (একবারই দেখানো হয়, শুধু hash রাখা)। Steadfast signature দেয় না, তাই token-ই যাচাই। body-র shape
  ভুল হলেও 400 দেওয়া হয় না (দিলে কুরিয়ার পাঠানো বন্ধ করে); অপড়া notice raw রেখে দেওয়া হয়।
- **ইভেন্ট:** `storefront_shipment_events` append-only, `event_key` দিয়ে একবারই। Picked up → Shipped (আর ক্রেতাকে
  SMS), delivered → Delivered (ইনভয়েস, ২৭b-র মতো)। পিক আপের পরে cancel নয়, সেটা return (২৮b)।
- কুরিয়ারের keys `CREDENTIALS_KEY` দিয়ে sealed, `courier_accounts` শুধু `omnivo_app` পড়ে; শপ শুধু ট্র্যাকিং কোড
  পাওয়া পার্সেল আর পড়া যায় এমন ইভেন্ট দেখে (`omnivo_shop`-এর column grant + restrictive policy)।
- আসল Steadfast API এখনো চালানো হয়নি (test account নেই); প্রথম live শপের আগে একটা আসল পার্সেল বুক করে দেখতে হবে।

**COD-র টাকা: সবচেয়ে বেশি অবহেলিত অংশ।** কুরিয়ার ক্রেতার কাছ থেকে টাকা তোলে, কিন্তু আপনাকে দেয় ৩–৭ দিন পরে, চার্জ কেটে। তাই হিসাব হবে এভাবে:

| ঘটনা | জার্নাল |
|---|---|
| ইনভয়েস তৈরি | Dr Accounts Receivable / Cr Sales + VAT |
| কুরিয়ারে হস্তান্তর (shipped) | Dr **COD Receivable – Pathao** / Cr Accounts Receivable |
| ডেলিভারি সম্পন্ন | (স্ট্যাটাস আপডেট, হিসাব একই থাকে) |
| রেমিট্যান্স এলো | Dr Bank + Dr Courier Charge (খরচ) / Cr COD Receivable – Pathao |
| রিটার্ন হলো | স্টক ফেরত + COD Receivable বিপরীত এন্ট্রি, কিন্তু কুরিয়ার ফি খরচ হিসেবেই থাকবে |

- প্রতিটা কুরিয়ারের জন্য আলাদা **control account**, তাই "কোন কুরিয়ারের কাছে কত টাকা আটকে আছে" এক রিপোর্টেই দেখা যাবে। এটা টেন্যান্টদের কাছে বিশাল ভ্যালু।
- রেমিট্যান্স CSV আপলোড বা API দিয়ে এলে অটো-ম্যাচিং (consignment_id ধরে), না মিললে "unmatched" তালিকা।
- **Partial delivery ও exchange** (কিছু আইটেম ফেরত) শুরু থেকেই ডেটা মডেলে ধরে রাখুন; বাংলাদেশে এটা খুবই সাধারণ।

**যা বানানো হয়েছে (ধাপ ২৮b, ২০২৬-১১-২৪):** উপরের টেবিলটা পরিকল্পনা ছিল; আসল হিসাব একটু আলাদা, কারণ আমাদের ফ্লোতে
ইনভয়েস (আর তাই receivable) আসে Delivered-এ, Shipped-এ নয়।

- **COD account = টাকা রাখার একটা account:** কুরিয়ার অ্যাকাউন্টে একটা "COD account" বাছা হয় ("Cash with
  Steadfast", cash account-গুলোর নিচে), আর একটা "Courier charges account" (খরচ)। আলাদা control account বা নতুন
  posting কোড লাগেনি: account-টার balance-ই "কুরিয়ারের কাছে কত টাকা", trial balance আর ledger-এ দেখা যায়, আর Shop
  couriers পেজের Holds কলামে ("৳45,200 · 18 parcels")। খালি রাখলে আগের মতো হাতে money receipt।
- **Delivered-এ:** ইনভয়েস posted (Dr AR / Cr Sales + VAT), তারপর COD account-এ একটা posted money receipt (method
  `courier`, শুধু receipt-এর জন্য, ফর্ম বা refund-এ নেই), ইনভয়েসে applied: Dr COD account / Cr AR। Shipped-এ কোনো
  এন্ট্রি নেই। Receipt পার্সেলের (`storefront_shipments.receipt_id`), অর্ডারের নয়, কারণ payout-এর লাইন হবে পার্সেল।
- **কত টাকা:** Steadfast-এর delivered / partial_delivered notice-এর `cod_amount`, পার্সেলের `codAmount`-এর বেশি হলে
  কেটে (raw notice-এ কুরিয়ারের সংখ্যা থাকে); `delivery_charge` পার্সেলে রাখা হয়, payout-এর জন্য। হাতে "Mark
  delivered"-এ member নিজে লেখে। ৳0 = receipt নেই, বাকিটা ইনভয়েসে পাওনা থাকে।
- **কখনো নীরবে ব্যর্থ নয়:** receipt একটা savepoint-এ, তাই ব্যর্থ হলেও কুরিয়ারের খবর আর Delivered থাকে; পার্সেলে
  error, অর্ডার Needs attention, পার্সেলপ্রতি একবার bell (`storefront.cod_receipt_failed`), আর "Make the receipt"।
  একটা trigger (`storefront_shipments_cod_guard`) দেখে receipt posted, `courier`, সংগ্রহের সমান আর ঠিক COD account-এ,
  আর একবার লাগানোর পরে বদলায় না।
- **Partial delivery আর return:** কুরিয়ারের কথায় স্টক কখনো ফেরে না (পথে হারানো পার্সেল স্টকে ঢুকে যেত)। আংশিক
  হলে member "Record what came back"-এ যা ফিরল টিক দেয়: ইনভয়েসের আগে তার sales return (১৫d-র "return before
  billing"), তারপর বাকিটার ইনভয়েস আর COD receipt। পুরোটা ফিরলে "Receive the return": পুরো challan-এর sales return,
  sales order cancel, অর্ডার Returned, ক্রেতাকে SMS। Shop orders-এ Returned ট্যাব আর Shipped-এ দ্বিতীয় `warn` pill।
- **বাকি (২৮c):** কুরিয়ারের payout ডকুমেন্ট (Dr Bank + Dr Courier charges / Cr COD account, পার্সেল লাইন), CSV
  matching (Steadfast preset, আসল payout ফাইল দেখা হয়নি, তাই অনুমান), রিটার্ন চার্জ খরচ হিসেবে। Void হওয়া COD
  receipt পার্সেলে লেগে থাকে, Holds থেকে বাদ যায়, আবার বানানো যায় না (২৭d-র মতো)। Pathao ২৮d-তে।

**চেকআউটে ডেলিভারি চার্জ:** `quote()` দিয়ে লাইভ দাম আনা যায়, কিন্তু কুরিয়ার API ধীর বা ডাউন হলে চেকআউট আটকে যাবে। তাই ডিফল্ট হবে টেন্যান্টের নিজের **zone-ভিত্তিক চার্জ টেবিল**, আর লাইভ quote হবে ঐচ্ছিক ও ক্যাশড (টাইমআউট ১ সেকেন্ড, ব্যর্থ হলে zone চার্জে ফলব্যাক)।

### ১৪.৭ নিরাপত্তা ও অপব্যবহার প্রতিরোধ

- **ভুয়া COD অর্ডার:** ফোন OTP, ব্ল্যাকলিস্ট করা নম্বর, একই ফোন/IP থেকে অর্ডারের হার সীমিত করা, আর কুরিয়ারের "ডেলিভারি সাকসেস রেশিও" API থাকলে চেকআউটে ঝুঁকির ইঙ্গিত দেখানো।
- **পাবলিক এন্ডপয়েন্টে rate limit** IP + ফোন + টেন্যান্ট ভিত্তিক (§৪.৬-এর noisy neighbor নিয়ন্ত্রণের মতোই), সামনে Cloudflare WAF ও bot protection।
- **Oversell ঠেকানো:** চেকআউটে স্টক লক + রিজার্ভেশন; রিজার্ভেশনের TTL শেষ হলে জব দিয়ে ছেড়ে দেওয়া।
- **কুরিয়ার ও গেটওয়ে ক্রেডেনশিয়াল** এনক্রিপ্টেড (KMS/envelope encryption), লগে কখনো যাবে না, অ্যাডমিন UI-তে মাস্কড দেখাবে। ক্রেডেনশিয়াল দেখা বা বদলানোর জন্য আলাদা পারমিশন।
- **Webhook:** signature যাচাই, timestamp উইন্ডো (replay ঠেকাতে), অজানা পেলোড `shipment_events`-এ raw হিসেবে রেখে দেওয়া (ডিবাগের জন্য অমূল্য)।
- **PII:** ক্রেতার ফোন ও ঠিকানা টেন্যান্ট-স্কোপড ও RLS-এর ভেতরে; এক্সপোর্টে অডিট লগ; কুরিয়ারকে শুধু প্রয়োজনীয় ফিল্ড পাঠানো।

### ১৪.৮ কখন বানাবেন ও কী কী ঝুঁকি

**Phase 2**, Sales + Inventory + Accounting শক্ত হওয়ার পরে। Storefront আসলে ঐ তিন মডিউলের উপর নির্ভরশীল; ভিত দুর্বল রেখে শপ বানালে স্টক ও হিসাব দুটোই ভাঙবে।

| ঝুঁকি | সমাধান |
|---|---|
| কুরিয়ার API অস্থির, ডকুমেন্টেশন দুর্বল, rate limit কম | queue + backoff retry + ম্যানুয়াল ফলব্যাক (লেবেল প্রিন্ট করে হাতে বুকিং), আর "manual" নামে একটা অ্যাডাপ্টার যেটা শুধু CSV এক্সপোর্ট দেয় |
| এক অর্ডারে দুইটা কনসাইনমেন্ট | idempotency key + DB unique constraint (দুটোই লাগবে, একটা যথেষ্ট না) |
| কাস্টম ডোমেইনে SSL ঝামেলা | Cloudflare for SaaS, DNS ধাপের চেকলিস্ট UI ও স্ট্যাটাস ইন্ডিকেটর |
| শপ ধীর হলে বিক্রি কমে | SSR + CDN ক্যাশ, ছবি অপ্টিমাইজ, Lighthouse ৯০+ CI গেট |
| টেন্যান্টের বিশাল ট্রাফিক (ক্যাম্পেইন) অন্য টেন্যান্টকে ভোগায় | পাবলিক এন্ডপয়েন্ট আলাদা API pod-এ, আলাদা HPA ও rate limit |
| রিটার্ন ও partial delivery-র হিসাব গোলমাল | শুরু থেকেই রিটার্ন ফ্লো ও COD control account, পরে যোগ করা খুব কঠিন |

---

## ১৫. বাংলাদেশ-নির্দিষ্ট বিষয়

বাংলাদেশের বাজার দিয়ে শুরু করলে এগুলো আপনাকে বিদেশি ERP (Odoo, Zoho, SAP B1) থেকে আলাদা করবে:

- **VAT / মূসক কমপ্লায়েন্স:** NBR-এর নির্ধারিত ফরম্যাটে Mushak-6.3 (ট্যাক্স ইনভয়েস) ও অন্যান্য মূসক ফর্ম, VAT রিটার্ন (Mushak-9.1)-এর জন্য রিপোর্ট। নিয়ম প্রায়ই বদলায়, তাই ট্যাক্স লজিক কনফিগারযোগ্য রাখবেন। এটা ঠিকভাবে করলে বড় বিক্রয় সুবিধা পাবেন।
- **বাংলা ভাষা:** পুরো UI বাংলায়, বাংলা সংখ্যা (১২৩) দেখানোর অপশন, বাংলায় ইনভয়েস প্রিন্ট।
- **সংখ্যার ফরম্যাট:** লাখ/কোটি (১২,৩৪,৫৬৭.০০), আর "কথায় টাকা" (Amount in words) বাংলা ও ইংরেজিতে।
- **মোবাইল ফাইন্যান্স:** bKash/Nagad পেমেন্ট রেকর্ড ও রিকনসিলিয়েশন।
- **কুরিয়ার ও COD:** দেশের বিক্রির বড় অংশ ক্যাশ-অন-ডেলিভারি, আর ডেলিভারি হয় Pathao, Steadfast, RedX, eCourier, Paperfly-র মতো স্থানীয় কুরিয়ারে। এদের API সরাসরি ইন্টিগ্রেট করা আর COD-র টাকা অটো রিকনসাইল করা বিদেশি ERP কেউ করে না, এটা Omnivo-র সবচেয়ে বড় স্থানীয় সুবিধা (§১৪.৬)।
- **ফেসবুক-ভিত্তিক বিক্রি:** অনেক ব্যবসার কোনো ওয়েবসাইট নেই। এক ক্লিকে চালু হওয়া Storefront + অর্ডার লিংক তাদের জন্য বিশাল ভ্যালু (§১৪)।
- **SMS:** বাংলাদেশি SMS গেটওয়ে (যেমন SSL Wireless, BulkSMSBD) দিয়ে ইনভয়েস বা বকেয়ার রিমাইন্ডার।
- **ফিসক্যাল ইয়ার:** জুলাই–জুন (কনফিগারযোগ্য রাখবেন, কারণ অন্য দেশে জানুয়ারি–ডিসেম্বর)।
- **কম দামি ডিভাইস ও ধীর নেটওয়ার্ক:** হালকা অ্যাপ আর অফলাইন সাপোর্ট এখানে সবচেয়ে বড় সুবিধা।
- **থার্মাল প্রিন্টার:** স্থানীয় বাজারে জনপ্রিয় মডেলগুলোর সাথে টেস্ট করবেন।
- **ডেটা সুরক্ষা আইন:** বাংলাদেশের ব্যক্তিগত তথ্য সুরক্ষা সংক্রান্ত আইন ও নীতিমালা, এবং ডেটা লোকালাইজেশনের প্রয়োজনীয়তা আছে কিনা, আইনজীবীর সাথে পরামর্শ করে নিশ্চিত হবেন। দরকার হলে সরকারি বা বড় প্রতিষ্ঠানের জন্য স্থানীয় ডেটা সেন্টারে Enterprise স্ট্যাক দিতে পারবেন (Hybrid tenancy এটা সম্ভব করে)।

---

## ১৬. আনুমানিক খরচ

> আনুমানিক মাসিক ইনফ্রা খরচ (USD), শুধু ধারণার জন্য। আসল খরচ ব্যবহারের ধরনের উপর নির্ভর করবে।

| পর্যায় | Infra | মাসিক খরচ |
|---|---|---|
| MVP (০–১০০ টেন্যান্ট) | ২টা Hetzner VPS + managed Postgres + Cloudflare ফ্রি + R2 + Sentry ফ্রি | **$50 – $150** |
| Growth (~২,০০০ টেন্যান্ট) | ছোট K8s ক্লাস্টার, Postgres + replica, Redis, মনিটরিং | **$500 – $1,500** |
| Scale (~২০,০০০ টেন্যান্ট) | AWS EKS, RDS/Aurora, ElastiCache, ClickHouse, Meilisearch | **$3,000 – $10,000** |

**খরচ কম রাখার উপায়:** Cloudflare (ফ্রি CDN), R2 (egress ফ্রি), static ফ্রন্টএন্ড (সার্ভার লাগে না), reserved/savings plan, আর শুধু প্রয়োজনের সময় স্কেল করা।

---

## ১৭. রোডম্যাপ ও টিম

### ১৭.১ টাইমলাইন (৩–৫ জনের টিম ধরে)

| মাস | কাজ |
|---|---|
| **১** | আর্কিটেকচার চূড়ান্ত করা, monorepo সেটআপ, CI/CD, ডিজাইন সিস্টেম, DB schema-র ভিত্তি, auth + tenancy + RLS |
| **২–৩** | Core platform (ইউজার, রোল, সেটিংস, অডিট), Accounting core, Inventory |
| **৪–৫** | Sales, Purchase, Reports, ইনভয়েস PDF |
| **৫–৬** | POS + অফলাইন sync, মোবাইল রেসপন্সিভ পলিশ |
| **৬** | ওয়েবসাইট + প্রাইসিং + বিলিং, ক্লোজড বেটা (১০–২০টা আসল ব্যবসা) |
| **৭–৯** | বেটা ফিডব্যাক, পারফরম্যান্স, সিকিউরিটি অডিট, **পাবলিক লঞ্চ** |
| **১০–১৮** | HR/Payroll, CRM, VAT কমপ্লায়েন্স, মাল্টি-ব্রাঞ্চ, **Storefront + কুরিয়ার ইন্টিগ্রেশন**, Capacitor মোবাইল অ্যাপ, পাবলিক API |

### ১৭.২ ন্যূনতম টিম

- ১ জন টেক লিড / আর্কিটেক্ট (ব্যাকএন্ড + DevOps)
- ১–২ জন ফুলস্ট্যাক (TypeScript/React)
- ১ জন ফ্রন্টএন্ড / UI-UX
- ১ জন **অ্যাকাউন্টিং ডোমেইন এক্সপার্ট** (পার্ট-টাইম চলবে)। এটা খুবই জরুরি। ডেভেলপাররা অ্যাকাউন্টিং ভুল বুঝলে পুরো প্রোডাক্ট ভুল হবে।
- পরে QA, সাপোর্ট আর সেলস

---

## ১৮. যে ভুলগুলো অবশ্যই এড়াবেন

1. ❌ **শুরু থেকে মাইক্রোসার্ভিস।** টিম ছোট হলে এতে গতি কমবে, খরচ বাড়বে, আর ERP transaction ভেঙে যাবে।
2. ❌ **কোনো টেবিলে `tenant_id` না রাখা**, "এটা তো গ্লোবাল টেবিল" ভেবে। পরে বুঝবেন ওটাও টেন্যান্ট-নির্দিষ্ট ছিল।
3. ❌ **টাকার হিসাবে float ব্যবহার।**
4. ❌ **পোস্ট করা ইনভয়েস বা জার্নাল এডিট বা ডিলিট করতে দেওয়া।**
5. ❌ **সব কিছু অফলাইন করার চেষ্টা।** শুধু যা দরকার তা করুন।
6. ❌ **স্টকের মান (quantity) সরাসরি আপডেট করা।** সবসময় মুভমেন্ট লেজার ব্যবহার করুন।
7. ❌ **টেন্যান্ট-নির্দিষ্ট কাস্টম কোড লেখা।** সব কাস্টমাইজেশন কনফিগারেশন দিয়ে করুন।
8. ❌ **রিপোর্ট প্রাইমারি DB-তে চালানো।**
9. ❌ **ব্যাকআপ restore কখনো টেস্ট না করা।**
10. ❌ **অ্যাকাউন্টিং ডোমেইন এক্সপার্ট ছাড়া অ্যাকাউন্টিং মডিউল বানানো।**
11. ❌ **"সবার জন্য সব ফিচার"।** ১–২টা ইন্ডাস্ট্রিতে সেরা হওয়ার লক্ষ্য রাখুন।
12. ❌ **Observability পরে যোগ করব বলে ফেলে রাখা।** প্রোডাকশনে সমস্যা হলে তখন কিছুই দেখতে পাবেন না।
13. ❌ **ডেটা এক্সপোর্ট অপশন না রাখা।** কাস্টমার আটকে আছে মনে করলে বিশ্বাস হারাবে।
14. ❌ **বাজেট ছাড়া ফ্রন্টএন্ড বড় হতে দেওয়া।** "হালকা ও দ্রুত" একদিনে নষ্ট হয় না, ধীরে ধীরে হয়।
15. ❌ **শপের জন্য আলাদা প্রোডাক্ট বা স্টক টেবিল রাখা।** স্টকের সত্য একটাই জায়গায় থাকবে, না হলে POS আর অনলাইন বিক্রি কখনো মিলবে না।
16. ❌ **HTTP রিকোয়েস্টের ভেতরেই কুরিয়ারের API কল করা।** কুরিয়ার ধীর বা ডাউন হলে আপনার চেকআউটও পড়ে যাবে। সবসময় outbox + worker।
17. ❌ **কনসাইনমেন্ট তৈরিতে idempotency না রাখা।** টাইমআউটে জব আবার চললে এক অর্ডারে দুইটা পার্সেল যাবে, আর টাকাটা আপনার পকেট থেকেই যাবে।
18. ❌ **COD-র টাকা ডেলিভারির দিনই "পেয়েছি" ধরে নেওয়া।** কুরিয়ার টাকা দেয় দিন কয়েক পরে, চার্জ কেটে। আলাদা COD Receivable অ্যাকাউন্ট ছাড়া হিসাব মিলবে না।

---

## ১৯. ফাইনাল চেকলিস্ট

### আর্কিটেকচার
- [ ] Modular monolith, মডিউল বাউন্ডারি lint দিয়ে enforce করা
- [ ] Stateless API, সব কনফিগ env থেকে
- [ ] Transactional outbox + idempotent workers
- [ ] OpenAPI কন্ট্র্যাক্ট + typed client

### Multi-tenancy
- [ ] প্রতিটা টেবিলে `tenant_id`, প্রতিটা ইনডেক্স `tenant_id` দিয়ে শুরু
- [ ] PostgreSQL RLS + `set_config(..., true)`
- [ ] অ্যাপ DB user non-superuser, no BYPASSRLS
- [ ] Tenant leak test suite CI-তে
- [ ] Redis/S3/Search/Queue/Log সব টেন্যান্ট-স্কোপড
- [ ] টেন্যান্ট রেজিস্ট্রি (pool/dedicated routing)
- [ ] টেন্যান্ট-ভিত্তিক rate limit

### ডেটা
- [ ] টাকা `NUMERIC`, UUIDv7 key, `timestamptz`
- [ ] Double-entry validation
- [ ] Immutable posted documents + reversal
- [ ] Audit log
- [ ] Custom fields (JSONB)

### পারফরম্যান্স
- [ ] Bundle size budget CI-তে
- [ ] Route-based code splitting
- [ ] Virtualized tables, keyset pagination
- [ ] `pg_stat_statements` + slow query লগ
- [ ] এশিয়া রিজিয়নে সার্ভার

### অফলাইন ও মোবাইল
- [ ] PWA (Service Worker + manifest)
- [ ] IndexedDB + outbox + sync protocol
- [ ] ডিভাইস-ভিত্তিক নম্বর সিরিজ
- [ ] Conflict কৌশল ডেটা-টাইপ অনুযায়ী
- [ ] মোবাইলে কার্ড-ভিউ, বটম নেভিগেশন
- [ ] কম দামি Android ফোনে টেস্ট

### Storefront ও কুরিয়ার
- [ ] Storefront ডোমেইন → টেন্যান্ট রেজলিউশন (কাস্টম ডোমেইন + SSL)
- [ ] পাবলিক এন্ডপয়েন্টে JWT নেই, তাই rate limit + WAF + read-only DB role
- [ ] দাম, ডিসকাউন্ট ও ডেলিভারি চার্জ শুধু সার্ভারে হিসাব
- [ ] স্টক রিজার্ভেশন (TTL সহ), oversell টেস্ট
- [ ] COD-তে OTP/কনফার্মেশন ধাপ
- [ ] কুরিয়ার অ্যাডাপ্টার ইন্টারফেস + অন্তত একটা `manual` ফলব্যাক
- [ ] কনসাইনমেন্টে idempotency key + DB unique constraint
- [ ] Retry, backoff আর `needs_attention` কিউ (নীরব ব্যর্থতা নয়)
- [ ] Webhook signature + replay protection + idempotent হ্যান্ডলার
- [ ] কুরিয়ারপ্রতি COD Receivable অ্যাকাউন্ট ও রেমিট্যান্স ম্যাচিং
- [ ] রিটার্ন ও partial delivery ফ্লো

### DevOps ও সিকিউরিটি
- [ ] IaC (OpenTofu), GitOps (Argo CD)
- [ ] Zero-downtime migration (expand/contract)
- [ ] Feature flags
- [ ] Metrics + Logs + Traces + Sentry
- [ ] SLO-ভিত্তিক alert
- [ ] PITR backup + মাসিক restore টেস্ট
- [ ] MFA, secrets manager, dependency scanning
- [ ] লঞ্চের আগে pen-test

---

> **শেষ কথা:** সফল SaaS ERP-এর রহস্য জটিল প্রযুক্তি নয়। রহস্য হলো **সঠিক ভিত্তি** (টেন্যান্সি, ডেটা মডেল, অ্যাকাউন্টিং নিয়ম), **সহজ অপারেশন**, আর **আসল ব্যবসার সমস্যা** দ্রুত সমাধান করা। প্রথমে ১০টা ব্যবসাকে খুশি করুন, তারপর ১,০০০টা, তারপর মিলিয়ন ইউজার। এই আর্কিটেকচার আপনাকে পুরো যাত্রায় নতুন করে লেখা ছাড়াই স্কেল করতে দেবে। 🚀
