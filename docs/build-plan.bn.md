# Omnivo — ধাপে ধাপে বিল্ড প্ল্যান (ERP + E-commerce)

> এই ডকুমেন্ট **কী বানাব, কোন ক্রমে** সেটার উত্তর দেয়।
> **কেন এই আর্কিটেকচার** তার উত্তর আছে [system-design.bn.md](system-design.bn.md)-এ।
> সিদ্ধান্তের রেকর্ড আছে [adr/](adr/)-এ।

---

## ভূমিকা

`docs/system-design.bn.md`-এ পুরো আর্কিটেকচার চূড়ান্ত। এই ডকুমেন্ট সেই ডিজাইনকে একটা এক্সিকিউটেবল ক্রমে সাজায়।

তিনটা বাধ্যবাধকতা যা পুরো প্ল্যানের আকার ঠিক করেছে:

1. **ফ্রন্টএন্ড আর ব্যাকএন্ড সমান্তরালে** — প্রতিটা ফিচার DB → API → UI একসাথে শেষ হবে (উল্লম্ব স্লাইস / vertical slice), লেয়ার-বাই-লেয়ার নয়। তাই প্রতি ধাপ শেষে ব্রাউজারে কিছু একটা **দেখা ও ছোঁয়া যাবে**।
2. **শেখা একটা লক্ষ্য** — তাই প্রতিটা ধাপে "এই ধাপে কী শিখছেন" আলাদা করে লেখা, আর ম্যাজিক কমিয়ে (কম abstraction, বেশি স্পষ্ট কোড) এগোনো হবে।
3. **একজন ডেভেলপার, পার্টটাইম (সপ্তাহে ১৫–২০ ঘণ্টা)** — তাই টাইমলাইন "সপ্তাহ" নয়, **"ধাপ"** ভিত্তিক। প্রতিটা ধাপের পাশে পার্টটাইম হিসাবে আনুমানিক সময় দেওয়া।

**ফলাফল:** ধাপ ০–২১ শেষে একটা বিক্রিযোগ্য MVP ERP (~১০–১২ মাস), ধাপ ২২–২৫-এ বিলিং ও বেটা লঞ্চ (~১৫ মাস), ধাপ ২৬–২৮-এ Storefront + কুরিয়ার (~১৮ মাস)।

---

## ০. আগে তিনটা সিদ্ধান্ত পাকা করা

### ০.১ Auth: **Better Auth (অ্যাপের ভেতরে)** ✅

| | Better Auth (in-app) | Zitadel / Keycloak (আলাদা IdP) |
|---|---|---|
| ইন্ডাস্ট্রি স্ট্যান্ডার্ড? | **প্রোটোকল** স্ট্যান্ডার্ড (JWT, OIDC claim, refresh rotation) নিজে মানতে হবে | **ডিপ্লয়মেন্ট** স্ট্যান্ডার্ড — Enterprise/SOC2-তে এটাই চায় |
| Debug | ✅ সবই নিজের DB, নিজের টেবিল, নিজের লগ | ❌ আরেকটা সিস্টেমের ভেতরে ঢুকে খুঁজতে হয় |
| UX নিয়ন্ত্রণ | ✅ নিজের React লগইন পেজ, বাংলায়, নিজের onboarding flow | ❌ hosted login page, কাস্টমাইজ সীমিত, redirect-ভারী |
| Dev গতি (একা, পার্টটাইম) | ✅ দিনে চালু | ❌ OIDC flow + আরেকটা কন্টেইনার + শেখার খরচ |
| Enterprise SAML SSO | ❌ নেই | ✅ আছে |

**সিদ্ধান্ত: এখন Better Auth, কিন্তু পরে বদলানো যায় এভাবে ডিজাইন করে।** বদলানোর পথ খোলা রাখার তিনটা নিয়ম (এগুলোই আসল কাজ):

- `packages/auth`-এ একটা **facade** থাকবে। অ্যাপের কোনো মডিউল কখনো সরাসরি Better Auth-এর API চিনবে না, শুধু `getSession()`, `getPrincipal()`, `issueTokens()` চিনবে।
- টোকেন হবে **OIDC-সঙ্গতিপূর্ণ JWT**: `sub`, `iss`, `aud`, `exp`, `iat`, `jti` + কাস্টম `tenant_id`, `membership_id`, `roles[]`। ভবিষ্যতে Zitadel একই আকারের টোকেন দিলে API কোড এক লাইনও বদলাবে না।
- **Authorization কখনো IdP-তে রাখা হবে না।** Role, permission, membership থাকবে Omnivo-র নিজের টেবিলে। IdP শুধু "এই মানুষটা কে" বলবে, "সে কী করতে পারে" বলবে না। এটাই সবচেয়ে গুরুত্বপূর্ণ নিয়ম — এটা মানলে IdP বদলানো ২–৩ দিনের কাজ।

**কখন Zitadel-এ যাবেন:** প্রথম Enterprise ক্লায়েন্ট SAML/SCIM চাইলে, অথবা SOC2/ISO অডিটে গেলে। তার আগে না।

### ০.২ লোকাল DB: Docker Compose (Postgres 17) ✅

RLS, আলাদা DB role, PgBouncer, extension — সব নিজে কনফিগার করে শেখা হবে, আর Testcontainers দিয়ে আসল Postgres-এ integration test চলবে। Neon/Supabase-এ superuser না থাকায় RLS role নিয়ে পরীক্ষা সীমিত হয়ে যেত।

### ০.৩ ইন্ডাস্ট্রি: রিটেইল + ফার্মেসি একসাথে ✅

Inventory-র স্কিমায় **শুরু থেকেই** batch/lot/expiry আর serial ধরা থাকবে, কিন্তু প্রতি প্রোডাক্টে একটা ফিল্ড `tracking: 'none' | 'batch' | 'serial'` দিয়ে UI লুকানো থাকবে। রিটেইল টেন্যান্ট `none` দেখবে, ফার্মেসি `batch`।

> ⚠️ এটা ধাপ ১২-তেই যোগ করতে হবে। পরে `stock_movements`-এ batch যোগ করা মানে পুরো ভ্যালুয়েশন লজিক আবার লেখা।

---

## ১. কাজের মূল ছন্দ: উল্লম্ব স্লাইস

প্রতিটা ফিচার (যেমন "প্রোডাক্ট তৈরি") ঠিক এই ৭ ধাপে শেষ হবে:

```
১. packages/contracts-এ Zod schema লিখুন      → CreateProductInput, ProductDto
২. packages/db-এ migration + Drizzle schema   → টেবিল, index (tenant_id দিয়ে শুরু), RLS policy
৩. apps/api-তে repository + service           → business rule, ট্রানজ্যাকশন, outbox
৪. apps/api-তে controller + permission guard  → REST endpoint, OpenAPI auto-doc
৫. `pnpm gen:openapi` চালান                   → openapi.json হালনাগাদ (client-এর টাইপ চুক্তি থেকে নিজেই আসে)
৬. apps/app-এ পেজ + form + list                → TanStack Query + RHF + packages/ui
৭. টেস্ট: unit (rule) + integration (endpoint) + tenant-leak + Playwright (UI)
```

**"রিয়েল-টাইমে দেখা" কীভাবে কাজ করবে:**

- `pnpm dev` একসাথে চালাবে: API (watch mode), ERP app (Vite HMR), worker, Drizzle Studio। এক টার্মিনাল, সব লাইভ।
- ধাপ ৫-এর codegen-এর কারণে ব্যাকএন্ডে ফিল্ড বদলালে **ফ্রন্টএন্ডে সাথে সাথে TypeScript error** দেখাবে। এটাই সমান্তরাল ডেভেলপমেন্টের আসল সেফটি নেট।
- API এখনো না লিখে UI আগে বানাতে চাইলে: **MSW (Mock Service Worker)** + একই Zod schema দিয়ে fake data। পরে আসল API এলে শুধু MSW বন্ধ হবে, UI কোড বদলাবে না।

**প্রতিটা ফিচারের Definition of Done:**

- [ ] `tenant_id` কলাম + RLS policy আছে, index `tenant_id` দিয়ে শুরু
- [ ] টাকা `NUMERIC(19,4)`, কোডে `decimal.js`
- [ ] Permission guard লাগানো
- [ ] `audit()` একই transaction-এ লিখছে, শুধু বদলানো ঘর
- [ ] Tenant-leak টেস্ট পাস (টেন্যান্ট A, টেন্যান্ট B-র ID দিয়ে 404 পায়)
- [ ] মোবাইল viewport-এ কাজ করে (টেবিল → কার্ড)
- [ ] বাংলা + ইংরেজি দুই ভাষায় লেবেল আছে

---

## ২. ধাপে ধাপে রোডম্যাপ

### পর্ব ০ — ভিত্তি (ধাপ ০–৩) · আনুমানিক ৬–৮ সপ্তাহ

#### ধাপ ০: Monorepo ও লোকাল এনভায়রনমেন্ট · ~১ সপ্তাহ

**তৈরি হবে:** `pnpm-workspace.yaml`, `turbo.json`, `packages/config/` (eslint, tsconfig, prettier preset), `apps/api/` (NestJS + Fastify adapter, শুধু `/health`), `apps/app/` (Vite + React, শুধু "Hello"), `infra/docker/docker-compose.yml` (postgres:17, valkey, mailpit, minio)।

**যা দেখবেন:** `pnpm dev` → `localhost:5173`-এ React পেজ, `localhost:3000/health` → `{"status":"ok"}`।
**শিখবেন:** pnpm workspace, Turborepo pipeline, NestJS bootstrap, Docker Compose।

> `dependency-cruiser` বা `eslint-plugin-boundaries` **এখনই** যোগ করুন, পরে না। শুরুতে নিয়ম ফাঁকা থাকুক, কিন্তু কাঠামোটা থাকুক।

#### ধাপ ১: ডাটাবেসের ভিত্তি ও RLS · ~১.৫ সপ্তাহ

**তৈরি হবে:** `packages/db/` — Drizzle config, migration folder, `schema/` (tenants, users, memberships, roles, permissions, role_permissions, audit_logs), একটা `baseColumns()` helper (`id uuidv7, tenant_id, created_at, created_by, updated_at, updated_by, version, deleted_at`), seed script।

**সবচেয়ে গুরুত্বপূর্ণ কাজ:** দুইটা DB role তৈরি —

- `omnivo_app` → NOSUPERUSER, **NOBYPASSRLS** (অ্যাপ এটা দিয়ে কানেক্ট করবে)
- `omnivo_migrator` → migration চালাবে

আর প্রতিটা টেন্যান্ট-টেবিলে `ENABLE` + **`FORCE` ROW LEVEL SECURITY** + policy।

**যা দেখবেন:** `psql`-এ `omnivo_app` হয়ে বসে `SELECT * FROM products;` → শূন্য রো। তারপর `set_config('app.tenant_id', '...', false)` দিলে রো দেখা যাবে। **নিজের চোখে RLS কাজ করতে দেখা** — এই মুহূর্তটা পুরো প্রজেক্টের সবচেয়ে গুরুত্বপূর্ণ শিক্ষা।
**শিখবেন:** Drizzle migration, Postgres RLS, DB role, UUIDv7।

#### ধাপ ২: Tenant context middleware + leak test · ~১ সপ্তাহ

**তৈরি হবে:** `apps/api/src/common/tenant/` — AsyncLocalStorage-ভিত্তিক request context, একটা `withTenant(fn)` helper যা প্রতিটা DB কাজ transaction-এ মুড়ে `set_config('app.tenant_id', $1, true)` চালায় (`true` = transaction-local, PgBouncer-নিরাপদ), আর একটা `TenantGuard`।

**যা দেখবেন:** Testcontainers দিয়ে আসল Postgres তুলে একটা টেস্ট: টেন্যান্ট A-র context-এ টেন্যান্ট B-র রো পড়ার চেষ্টা → শূন্য। **এই টেস্ট ফাইলটাই পরে পুরো `tenant-leak.spec.ts` স্যুটের বীজ।**
**শিখবেন:** AsyncLocalStorage, Nest interceptor/guard, Testcontainers।

> ⚠️ এখানে ভুল করলে পরে সব জায়গায় ছড়াবে। `SET` কখনো ব্যবহার করবেন না, সবসময় `set_config(..., true)`।

#### ধাপ ৩: Auth + RBAC + প্রথম দৃশ্যমান স্ক্রিন · ~২ সপ্তাহ

**ব্যাকএন্ড:** `packages/auth/` facade + Better Auth (email/password, session, refresh rotation)। Signup → tenant তৈরি + membership। `POST /auth/login` টোকেনে `tenant_id` দেবে। `@RequirePermission('core.user.invite')` decorator + Redis-এ permission cache।
**ফ্রন্টএন্ড:** লগইন পেজ, TanStack Router-এ protected route, auth store (Zustand), টোকেন refresh interceptor, tenant switcher (একজন ইউজার একাধিক টেন্যান্টে থাকতে পারে)।

**যা দেখবেন:** 🎉 **সাইনআপ → লগইন → নিজের টেন্যান্টের খালি ড্যাশবোর্ড।** এখান থেকেই অ্যাপটা "আসল" মনে হবে।
**শিখবেন:** JWT lifecycle, refresh rotation, RBAC, httpOnly cookie, CORS।

---

### পর্ব ১ — ডিজাইন সিস্টেম ও কন্ট্র্যাক্ট (ধাপ ৪–৫) · ~৩–৪ সপ্তাহ

> এই দুই ধাপ বিরক্তিকর মনে হবে, কিন্তু **বাকি ২৩টা ধাপের গতি এখানেই ঠিক হবে**। তাড়াহুড়ো করবেন না।

#### ধাপ ৪: `packages/ui` — শেয়ার্ড ডিজাইন সিস্টেম · ~২ সপ্তাহ

Tailwind preset + design token, shadcn/ui বেস কম্পোনেন্ট, বাংলা ফন্ট (Hind Siliguri, subset করা), `packages/i18n` (bn/en), `AppShell` (ডেস্কটপে সাইডবার / মোবাইলে বটম ট্যাব), **`DataTable`** (TanStack Table + Virtual, মোবাইলে অটো কার্ড-ভিউ), **`FormField`** (RHF + Zod), `MoneyInput` (decimal.js), `DatePicker`, `PageHeader`, `EmptyState`।

**যা দেখবেন:** একটা `/kitchen-sink` রুটে সব কম্পোনেন্ট, ডেস্কটপ ও মোবাইল দুই সাইজে।
**শিখবেন:** ডিজাইন টোকেন, virtualization, responsive টেবিল প্যাটার্ন, i18n।

> ERP মানে ৮০% ফর্ম আর টেবিল। এই দুটো এখানে ভালো বানালে পরের প্রতিটা স্ক্রিন কয়েক ঘণ্টার কাজ হয়ে যাবে।

#### ধাপ ৫: কন্ট্র্যাক্ট ও codegen পাইপলাইন · ~১ সপ্তাহ

`packages/contracts/` — Zod schema (একই schema সার্ভারে validation, ক্লায়েন্টে form validation)। Zod route রেজিস্ট্রি (টাইপ সরাসরি Zod থেকে, codegen নেই) + রেজিস্ট্রি থেকে OpenAPI 3.1 + TanStack Query hooks। সাথে ঠিক হবে: error envelope ফরম্যাট, **keyset pagination** কনভেনশন, MSW mock setup।

**যা দেখবেন:** contracts-এ একটা ফিল্ডের নাম বদলান → সাথে সাথে API আর ফ্রন্টএন্ডে লাল দাগ; `pnpm gen:openapi` → স্পেকের diff। **এটাই parallel dev-এর ইঞ্জিন।**
**শিখবেন:** OpenAPI, code generation, contract-first ডেভেলপমেন্ট।

---

### পর্ব ২ — Core Platform (ধাপ ৬–৮) · ~৫–৬ সপ্তাহ

| ধাপ | কাজ | ব্যাকএন্ড | ফ্রন্টএন্ড | সময় |
|---|---|---|---|---|
| **৬** | সেটিংস ও ভিত্তি | tenant settings (currency, fiscal year, timezone, ভাষা), **numbering series** (`INV-2026-0001`), branches/locations, **audit()** (বদলের সাথে একই transaction-এ, request-এর id/IP নিজে থেকে), attachments (MinIO presigned URL) | Settings পেজ, ব্রাঞ্চ CRUD, Audit log viewer (কে কখন কী বদলাল), ইউজারের ভাষা/থিম, Playwright e2e (MSW) | ~২ সপ্তাহ |
| **৭** | ইউজার ও রোল | invite flow (ইমেইল, Mailpit), কাস্টম রোল, permission matrix API, owner = system role, escalation বন্ধ, বাদ পড়া সদস্য সাথে সাথে 401 | টিমের পেজ, ইনভাইট মডাল, join পেজ, **permission matrix গ্রিড** (চেকবক্সের ছক) | ~১.৫ সপ্তাহ |
| **৮** | Queue, Worker, Outbox | apps/api-র দ্বিতীয় entrypoint (`worker.ts`), BullMQ (`email`, `jobs`), transactional outbox + relay (SKIP LOCKED, `omnivo_worker`), idempotent provisioning job (industry template), welcome ও invitation ইমেইল worker থেকে, notifications | Onboarding wizard (ব্যবসার ধরন → কোম্পানির তথ্য → টিম), notification bell, job status (sending/provisioning) | ~২ সপ্তাহ |

**ধাপ ৮-এ যা দেখবেন:** সাইনআপ করলে background-এ chart of accounts + রোল + সেটিংস seed হয়ে যাবে, Mailpit-এ welcome ইমেইল আসবে। **প্রথম async আর্কিটেকচার চোখে দেখা।**
**শিখবেন:** BullMQ, transactional outbox, idempotency, background worker।

---

### পর্ব ৩ — Accounting Core (ধাপ ৯–১১) · ~৬–৭ সপ্তাহ · **ERP-এর হৃদয়**

> ⚠️ এই পর্ব শুরুর আগে একজন **অ্যাকাউন্ট্যান্টের সাথে ২–৩টা সেশন করুন**। সিস্টেম ডিজাইনের ১৮ নম্বর ভুলের তালিকায় এটাই ১০ নম্বর। নিজে যা বুঝেছেন তা দিয়ে journal লিখলে ৬ মাস পরে সব ভাঙবে।

#### ধাপ ৯: Chart of Accounts · ~১.৫ সপ্তাহ

`ledger_accounts` টেবিল (tree, type: asset/liability/equity/income/expense, parent FK-এ type — DB নিজেই টাইপ মেলায়), ছয় ইন্ডাস্ট্রির **template** (একটা standard chart + ইন্ডাস্ট্রির অংশ), ১০টা system account (`purpose`), পুরনো workspace-এর জন্য migration থেকে outbox job। Opening balance ধাপ ১০-এ, প্রথম journal entry হিসেবে।
**দেখবেন:** গাছের মতো অ্যাকাউন্ট ট্রি UI, নতুন অ্যাকাউন্ট যোগ করা।

#### ধাপ ১০: Double-Entry Journal · ~৩ সপ্তাহ · **সবচেয়ে সতর্ক ধাপ**

`journal_entries` + `journal_lines`, draft → posted (`accounting.journal.create` / `.post`, আলাদা রোল = maker-checker), DB-তে deferred constraint trigger দিয়ে `SUM(debit) = SUM(credit)`, posted entry ও তার লাইন trigger দিয়ে frozen — শুধু reversal, lock date (একটা তারিখ পর্যন্ত বই বন্ধ), ওপেনিং ব্যালান্সের পাতা, লাইনে ঐচ্ছিক ব্রাঞ্চ, `PostingService.postNew()` পরের সব মডিউলের জন্য।

`postJournal()` একটা internal service হবে যেটা পরে Sales/Inventory/Purchase সবাই ডাকবে — **এটাই সব মডিউলের মিলনস্থল**, তাই API ডিজাইনে সময় দিন।

**দেখবেন:** ম্যানুয়াল journal entry ফর্ম (লাইন যোগ, debit/credit না মিললে সেভ বন্ধ), ledger ভিউ, reversal বাটন।

#### ধাপ ১১: Financial Statements · ~২ সপ্তাহ

Trial Balance, P&L, Balance Sheet (কাঁচা SQL-এ, API আর worker একই query), ধাপ ১০-এর `postNew()` দিয়ে বছর শেষের ক্লোজিং এন্ট্রি + lock date (ক্রমে ক্লোজ, উল্টো ক্রমে reopen), Excel/PDF এক্সপোর্ট worker-এ (S3 + বেল), আলাদা permission `accounting.report.read`। Cash flow পরে।
**দেখবেন:** আসল ট্রায়াল ব্যালেন্স যেখানে দুই পাশ মেলে। 🎉
**শিখবেন:** ডাবল-এন্ট্রি হিসাব, immutable document, state machine, আর্থিক রিপোর্টের SQL।

---

### পর্ব ৪ — Inventory (ধাপ ১২–১৪) · ~৫–৬ সপ্তাহ

#### ধাপ ১২: প্রোডাক্ট · ~২ সপ্তাহ

`products`, `product_variants` (সাইজ/রং), `uoms` + কনভার্শন (কার্টন→পিস), ক্যাটাগরি, বারকোড, `custom_fields JSONB`, **`tracking: none | batch | serial`** (ধাপ ০.৩-এর সিদ্ধান্ত), `batches` টেবিল (lot no, expiry) ও `serials` টেবিল — স্কিমা এখনই, UI পরে।
**দেখবেন:** প্রোডাক্ট লিস্ট (virtualized, ১০,০০০ রো মসৃণ), ভ্যারিয়েন্ট সহ ফর্ম, CSV import।

#### ধাপ ১৩: স্টক লেজার · ~২ সপ্তাহ

`warehouses` (ব্রাঞ্চের অধীনে), **`stock_movements` (append-only — trigger UPDATE/DELETE আটকায়)**,
`stock_balances` (trigger দিয়ে রাখা, কোড লেখে না), adjustment (opening stock সহ, draft → posted, `ADJ-…`),
দুই ধাপের transfer (in transit, ঘাটতি থাকে), batch + expiry + FEFO, serial number, reorder level + বেলের alert,
workspace সেটিং "negative stock" (ডিফল্ট বন্ধ)। `StockPostingService.post()` — স্টকে ঢোকার একমাত্র পথ।

> ⚠️ সিস্টেম ডিজাইনের ৬ নম্বর ভুল: **কখনো `products.quantity` কলাম রাখবেন না।** স্টক = সব মুভমেন্টের যোগফল। এটা অফলাইন sync-এর জন্যও অপরিহার্য।

**দেখবেন:** স্টক রিপোর্ট; stock adjustment করলে লেজারে নতুন লাইন যোগ হয়, পুরনো লাইন অপরিবর্তিত থাকে।

#### ধাপ ১৪: Valuation + প্রথম মডিউল-ইন্টিগ্রেশন · ~২ সপ্তাহ

Weighted Average (পুরো কোম্পানিতে প্রতি আইটেমের একটা গড় খরচ; FIFO পরে), প্রতিটা স্টক মুভমেন্টের মূল্য
(`stock_movements.value`, `stock_values` trigger দিয়ে রাখা), আর প্রতিটা স্টক ডকুমেন্টের **নিজের journal entry**
(`StockBooksService` → ধাপ ১০-এর `PostingService.postNew()`, একই transaction-এ)। Settings → Inventory-তে
স্টকের অ্যাকাউন্ট, দুই ব্রাঞ্চের মধ্যে transfer "Goods in transit" দিয়ে, "Revalue stock" ডকুমেন্ট (`REV-…`),
`inventory.stock.value` / `inventory.stock.revalue` permission।
**দেখবেন:** স্টক রিসিভ করলেন → Balance Sheet-এ Inventory-র অঙ্ক নিজে থেকে বাড়ল। **প্রথমবার দুই মডিউল একসাথে কথা বলল।** 🎉
**শিখবেন:** append-only ledger, inventory valuation, মডিউল-বাউন্ডারি পেরিয়ে service call।

---

### পর্ব ৫ — Sales ও Purchase (ধাপ ১৫–১৭) · ~৭–৮ সপ্তাহ

| ধাপ | কাজ | মূল বিষয় | সময় |
|---|---|---|---|
| **১৫** | Sales | customers, price list, **Quotation → Sales Order → Delivery → Invoice → Payment**, credit limit, return/credit note। লাইন আইটেমে প্রোডাক্টের নাম-দাম-ট্যাক্স **snapshot** করে রাখা | ~৩.৫ সপ্তাহ |
| **১৬** | ডকুমেন্ট আউটপুট | Invoice PDF (worker-এ, বাংলা ফন্ট সহ), R2/MinIO-তে সেভ, ইমেইল, WhatsApp শেয়ার লিংক, "কথায় টাকা" (বাংলা + ইংরেজি) | ~১.৫ সপ্তাহ |
| **১৭** | Purchase | suppliers, **Requisition → PO → Goods Receipt → Bill → Payment**, purchase return/debit note, কনফিগারযোগ্য approval workflow | ~৩ সপ্তাহ |

#### ধাপ ১৫: Sales — চারটা গাইডে

**১৫a (customers, price lists, VAT):** একটা `parties` টেবিল (`is_customer` / `is_supplier`), কাস্টমার গ্রুপ, একাধিক
ঠিকানা, payment terms, credit limit (চেক ১৫c-তে); AR একটাই control account, প্রতিটা AR লাইনে `party_id` — কাস্টমারের
balance ও statement সেখান থেকে; opening balances পেজে AR কাস্টমার ধরে ভাগ; VAT rates টেবিল (standard, reduced,
zero-rated, exempt; একটা default), workspace সেটিং "prices include VAT"; নামসহ price list (variant + unit ধরে দাম)।
**১৫b (quotation → order → delivery):** quotation (QT, save করলেই নম্বর; open/accepted/declined, মেয়াদ পেরোলে
"Expired" — পেজ নিজে হিসাব করে), sales order (confirm করলে SO নম্বর; delivered/closed/cancelled), delivery challan
(DC, post করলে স্টক বের হয়, একটা order কয়েক challan-এ; batch/serial, FEFO)। Delivery post করলেই moving average
cost-এ Dr Cost of goods sold / Cr Inventory; স্টক hold হয় না, স্টক পেজে "On order"। লাইনের হিসাব (discount, তারপর
VAT, লাইন ধরে paisa-তে round) contracts-এ, form-API-mock একই function; price lookup: কাস্টমারের price list → প্রোডাক্টের
দাম। প্রিন্ট নেই (১৫c বা পরে)।
**১৫c** invoice, payment, credit limit · **১৫d** return ও credit note।

**দেখবেন:** একটা ইনভয়েস কাটলেন → স্টক কমল → AR বাড়ল → P&L-এ বিক্রি দেখাল → PDF ডাউনলোড হলো। **এখানেই ERP-টা সত্যিকারের ERP হয়ে গেল।** 🎉

---

### পর্ব ৬ — POS + অফলাইন (ধাপ ১৮–২০) · ~৮–১০ সপ্তাহ · **সবচেয়ে কঠিন পর্ব**

> এটা একদম আলাদা করে নিন। একইসাথে নতুন ফিচার আর sync engine — দুটো করবেন না।

#### ধাপ ১৮: `packages/sync` — সিঙ্ক ইঞ্জিন · ~৪ সপ্তাহ

- **Pull:** প্রতি syncable টেবিলে `updated_at` + টেন্যান্ট-ভিত্তিক monotonic `change_seq`। `GET /sync/pull?since=1520` → পরিবর্তন + tombstone। শুধু দরকারি ডেটা (ইউজারের ব্রাঞ্চ, সক্রিয় প্রোডাক্ট, সাম্প্রতিক কাস্টমার), পুরো ডাটাবেস না।
- **Push:** ক্লায়েন্টে Dexie-তে outbox, প্রতিটা কাজ একটা **command** (`{id: uuidv7, type: 'pos.sale.create', payload, device_id}`)। `POST /sync/push` — সার্ভার `id` দেখে idempotency নিশ্চিত করবে এবং **সব business rule আবার যাচাই করবে**।
- **Conflict:** ডেটার ধরন অনুযায়ী আলাদা নীতি (লেনদেন = append-only তাই conflict নেই; মাস্টার ডেটা = field-level LWW; দাম/ক্রেডিট লিমিট = server-wins)।

**দেখবেন:** DevTools-এ নেটওয়ার্ক "Offline" করে প্রোডাক্ট লিস্ট দেখা, একটা কাজ করা, তারপর অনলাইন করলে সার্ভারে পৌঁছানো।

#### ধাপ ১৯: PWA শেল · ~১.৫ সপ্তাহ

Workbox service worker, manifest, install prompt, `navigator.storage.persist()`, UI-তে **"৫টা বিক্রি সিঙ্ক বাকি" ব্যাজ**, IndexedDB-তে সংবেদনশীল ডেটা এনক্রিপ্ট (Web Crypto)।

#### ধাপ ২০: POS স্ক্রিন · ~৩ সপ্তাহ

দ্রুত বিক্রি স্ক্রিন (বারকোড স্ক্যান, কীবোর্ড শর্টকাট — মাউস ছাড়া পুরো বিক্রি), split payment (ক্যাশ/কার্ড/bKash/Nagad), hold/resume বিল, রিটার্ন, শিফট open/close ও ক্যাশ কাউন্ট, **থার্মাল প্রিন্ট (৫৮/৮০mm)**, **ডিভাইস-ভিত্তিক নম্বর সিরিজ** (`POS1-000123`), negative stock সেটিং।

**দেখবেন:** ওয়াইফাই বন্ধ করে ট্যাবলেটে ১০টা বিক্রি করে, রিসিট প্রিন্ট করে, তারপর ওয়াইফাই চালু করলে সব সার্ভারে গিয়ে হিসাবে বসল। 🎉 **এটাই Omnivo-র সবচেয়ে বড় প্রতিযোগিতামূলক সুবিধা।**
**শিখবেন:** offline-first আর্কিটেকচার, conflict কৌশল, service worker, idempotency, Web Crypto।

---

### পর্ব ৭ — Reports ও Dashboard (ধাপ ২১) · ~২.৫ সপ্তাহ

রিয়েল-টাইম KPI (আজকের বিক্রি, ক্যাশ পজিশন, বকেয়া, লো স্টক), স্ট্যান্ডার্ড রিপোর্ট (Sales, Stock, AR/AP Aging, Tax, P&L) + ফিল্টার + Excel/PDF export, শিডিউল করা রিপোর্ট ইমেইল, materialized view + refresh job।
**দেখবেন:** হোম পেজে আসল সংখ্যা সহ ড্যাশবোর্ড।

> 🏁 **এখানে MVP শেষ।** ধাপ ০–২১ = পার্টটাইমে আনুমানিক **১০–১২ মাস**। এই পর্যায়ে ২–৩টা আসল দোকানে বিনামূল্যে বসিয়ে দিন — কোড লেখার চেয়ে এই ফিডব্যাক বেশি দামি।

---

### পর্ব ৮ — Website, Admin ও Billing (ধাপ ২২–২৪) · ~৭–৮ সপ্তাহ

| ধাপ | কাজ | বিস্তারিত | সময় |
|---|---|---|---|
| **২২** | `apps/web` (Astro) | ল্যান্ডিং, ফিচার, ব্লগ/ডক্স (Content Collections), স্ট্যাটিক, Lighthouse ৯৫+, `packages/ui` রিইউজ | ~২ সপ্তাহ |
| **২৩** | Catalog + `apps/admin` | `catalog` মডিউল (products, **immutable versioned prices**, entitlements, coupons), Admin Panel (Catalog Manager / Support / Finance রোল, MFA), pricing পেজ SSR + CDN cache + publish-এ purge | ~৩ সপ্তাহ |
| **২৪** | Billing | **Entitlements service** (`can(tenant,'feature.x')`, `limit(tenant,'users')` — কোডে কখনো `if(plan==='growth')` নয়), subscriptions, SSLCommerz/bKash + Stripe, idempotent webhook, dunning (৭ দিন grace → read-only, কখনো ডেটা মুছবেন না) | ~৩ সপ্তাহ |

**দেখবেন:** Admin Panel-এ দাম বদলে Publish চাপলে কয়েক সেকেন্ডে ওয়েবসাইটের pricing পেজে নতুন দাম। কেউ প্ল্যান কিনলে অটো টেন্যান্ট তৈরি হয়ে ওয়েলকাম ইমেইল যায়। 🎉

---

### পর্ব ৯ — বেটা লঞ্চের প্রস্তুতি (ধাপ ২৫) · ~৪ সপ্তাহ

- **Observability:** OpenTelemetry trace, Prometheus + Grafana, Loki (structured JSON log, প্রতি লাইনে `tenant_id`/`request_id`), Sentry (front + back)। **SLO-ভিত্তিক alert** ("৫ মিনিট ধরে error rate > 1%"), CPU-ভিত্তিক নয়।
- **ব্যাকআপ:** PITR চালু, অন্য রিজিয়নে কপি, **একবার আসল restore করে দেখা**, per-tenant restore স্ক্রিপ্ট।
- **Infra:** staging environment, GitHub Actions ফুল পাইপলাইন, Hetzner/DO-তে Docker Compose বা k3s ডিপ্লয়, সামনে Cloudflare।
- **সিকিউরিটি:** secrets manager (Infisical/Doppler), MFA, rate limiting, security headers, dependency scanning, এবং **থার্ড-পার্টি pen-test**।
- **ক্লোজড বেটা:** ১০–২০টা আসল ব্যবসা।

---

### পর্ব ১০ — Storefront + কুরিয়ার (ধাপ ২৬–২৮) · ~৯–১১ সপ্তাহ

> Sales + Inventory + Accounting শক্ত হওয়ার **আগে এটা শুরু করবেন না**। Storefront ঐ তিনটার উপর দাঁড়ানো। বিস্তারিত ডিজাইন [system-design.bn.md §১৪](system-design.bn.md#১৪-storefront-টেন্যান্টের-পাবলিক-অনলাইন-শপ-ও-কুরিয়ার-ডেলিভারি)-এ।

#### ধাপ ২৬: শপের ভিত্তি · ~৩.৫ সপ্তাহ

`storefront` মডিউল: `storefront_settings`, `storefront_domains` (Host → tenant), **`storefront_listings`** (Inventory-র প্রোডাক্টকে "প্রকাশ" করা — নতুন প্রোডাক্ট টেবিল **নয়**), categories, banners, carts।
`apps/shop` (Astro, on-demand render + CDN cache) — **একটাই ডিপ্লয়মেন্ট সব টেন্যান্টের শপ সার্ভ করবে**, `Host` হেডার দিয়ে টেন্যান্ট চেনা।
পাবলিক API `/public/v1/*` — JWT নেই, তাই আলাদা **read-mostly DB role** + rate limit + WAF।
ERP অ্যাপে Storefront মেনু: Catalog, Appearance, Delivery zones।
**দেখবেন:** `acme.localhost:4321`-এ আসল শপ, ERP-র প্রোডাক্ট দেখাচ্ছে।

#### ধাপ ২৭: চেকআউট ও অর্ডার · ~২.৫ সপ্তাহ

কার্ট → চেকআউট (**দাম, ডিসকাউন্ট, ডেলিভারি চার্জ সব সার্ভারে হিসাব — ব্রাউজার শুধু `listing_id`, পরিমাণ, এলাকা আর কুপন কোড পাঠাবে**), **স্টক রিজার্ভেশন TTL সহ**, COD + **ফোন OTP বাধ্যতামূলক**, অনলাইন পেমেন্ট (টেন্যান্টের নিজের গেটওয়ে, এনক্রিপ্টেড credentials), `storefront_orders`, অর্ডার বোর্ড UI, confirm হলে outbox → worker → Sales Order + স্টক মুভমেন্ট + জার্নাল।

#### ধাপ ২৮: কুরিয়ার অটোমেশন · ~৩.৫ সপ্তাহ

`shipping` মডিউল + `packages/contracts`-এ **`CourierAdapter` ইন্টারফেস**। **প্রথমে `manual` অ্যাডাপ্টার** (শুধু CSV export + লেবেল), তারপর Steadfast, তারপর Pathao।

- কনসাইনমেন্ট **সবসময় worker-এ**, কখনো HTTP রিকোয়েস্টের ভেতরে নয়
- **idempotency key = `order_id`** + DB-তে `UNIQUE (tenant_id, order_id, courier_account_id)` — দুটোই লাগবে, একটা যথেষ্ট না
- Retry: exponential backoff ৫ বার → তারপর `needs_attention` + নোটিফিকেশন + Retry বাটন (**কখনো নীরবে ব্যর্থ নয়**)
- স্ট্যাটাস: webhook (signature + timestamp যাচাই) + polling fallback, `shipment_events` append-only
- **কুরিয়ারপ্রতি COD Receivable control account**, remittance CSV/API auto-matching, return ও partial delivery

**দেখবেন:** শপে অর্ডার → OTP → কনফার্ম → Sales Order + ইনভয়েস + কনসাইনমেন্ট অটো তৈরি → ট্র্যাকিং SMS → রেমিট্যান্স এলে ব্যাংকে টাকা বসল। 🎉 **এটাই বাংলাদেশের বাজারে Omnivo-র সবচেয়ে বড় অস্ত্র।**

---

### পর্ব ১১ — এরপরে (ধাপ ২৯+)

HR + Payroll → CRM → Expense → **VAT/মূসক কমপ্লায়েন্স (Mushak-6.3, 9.1)** → Capacitor মোবাইল অ্যাপ → Public API + Webhooks → Manufacturing (BOM) → ClickHouse analytics → Meilisearch → AI সহকারী।

---

## ৩. টাইমলাইন সারাংশ (পার্টটাইম, ১৫–২০ ঘণ্টা/সপ্তাহ)

| পর্ব | ধাপ | আনুমানিক | ক্রমযোগ |
|---|---|---|---|
| ভিত্তি | ০–৩ | ৬–৮ সপ্তাহ | ~২ মাস |
| ডিজাইন সিস্টেম + কন্ট্র্যাক্ট | ৪–৫ | ৩–৪ সপ্তাহ | ~৩ মাস |
| Core Platform | ৬–৮ | ৫–৬ সপ্তাহ | ~৪.৫ মাস |
| Accounting | ৯–১১ | ৬–৭ সপ্তাহ | ~৬ মাস |
| Inventory | ১২–১৪ | ৫–৬ সপ্তাহ | ~৭.৫ মাস |
| Sales + Purchase | ১৫–১৭ | ৭–৮ সপ্তাহ | ~৯.৫ মাস |
| POS + অফলাইন | ১৮–২০ | ৮–১০ সপ্তাহ | ~১১.৫ মাস |
| Reports | ২১ | ২.৫ সপ্তাহ | **~১২ মাস — MVP** 🏁 |
| Website + Billing | ২২–২৪ | ৭–৮ সপ্তাহ | ~১৪ মাস |
| লঞ্চ প্রস্তুতি | ২৫ | ৪ সপ্তাহ | **~১৫ মাস — পাবলিক লঞ্চ** 🚀 |
| Storefront + কুরিয়ার | ২৬–২৮ | ৯–১১ সপ্তাহ | ~১৮ মাস |

> এই সংখ্যাগুলো সৎ অনুমান, প্রতিশ্রুতি নয়। প্রথম ৩টা ধাপ শেষ করে নিজের আসল গতি মেপে নিন, তারপর বাকিটা সমন্বয় করুন।

---

## ৪. শুরু থেকেই যা enforce করা হবে (CI gate)

এগুলো ধাপ ০-তেই পাইপলাইনে বসবে, পরে যোগ করা কষ্টকর:

```
lint → typecheck → unit test → integration test (Testcontainers)
  → tenant-leak test  → bundle size (initial < 200 KB gz)
  → module boundary check (dependency-cruiser)
```

---

## ৫. যা এখন করা হবে না (ইচ্ছাকৃতভাবে)

| জিনিস | কখন |
|---|---|
| Kubernetes | ধাপ ২৫-এও না; Docker Compose বা k3s যথেষ্ট |
| ClickHouse, Meilisearch, Citus, read replica | যখন মেপে দেখা যাবে দরকার (আগে Postgres FTS + materialized view) |
| মাইক্রোসার্ভিস | কখনো না, যতক্ষণ না টিম ৩০+ |
| Multi-currency লজিক | Phase 2; স্কিমায় `currency`/`exchange_rate` কলাম শুরু থেকেই থাকবে |
| GraphQL, Kafka/NATS, Zitadel | দরকার প্রমাণিত না হওয়া পর্যন্ত |
| ১৫+ কুরিয়ার অ্যাডাপ্টার | প্রথমে `manual` + Steadfast, চাহিদা দেখে বাড়ানো হবে |

---

## ৬. যেখানে আটকে যাওয়ার ঝুঁকি বেশি

| ঝুঁকি | প্রশমন |
|---|---|
| **অ্যাকাউন্টিং ভুল বোঝা** — সবচেয়ে বড় ঝুঁকি | ধাপ ৯-এর আগে অ্যাকাউন্ট্যান্টের সাথে বসুন; journal-এর টেস্ট কেস তাঁকে দিয়ে যাচাই করান |
| **Sync engine গিলে ফেলা** (ধাপ ১৮) | টাইমবক্স করুন। ৬ সপ্তাহ পেরোলে PowerSync/ElectricSQL-এ read-sync অফলোড করুন; write outbox নিজের রাখুন |
| **পার্টটাইমে গতি হারানো** | প্রতি ধাপ শেষে **একটা দৃশ্যমান জিনিস** — প্রতিটা ধাপের "যা দেখবেন" অংশটাই জ্বালানি |
| **Scope creep** (নতুন মডিউলের লোভ) | ধাপ ২১-এর আগে কোনো Phase 2 মডিউল ছোঁবেন না |
| **নতুন টেবিলে RLS ভুলে যাওয়া** | rls-coverage টেস্ট (tenant-leak স্যুট): tenant_id-ওয়ালা প্রতিটা টেবিলে FORCE RLS না থাকলে CI fail |
| **PgBouncer + `SET` বাগ** | ধাপ ২-এ `set_config(..., true)` ছাড়া কিছু লেখা হবে না; PgBouncer transaction mode-এ টেস্ট |

---

## ৭. যাচাই (কীভাবে বোঝা যাবে ধাপটা সত্যিই শেষ)

প্রতিটা ধাপ শেষে:

```bash
pnpm lint && pnpm typecheck          # কোড স্বাস্থ্য
pnpm test                            # unit + integration (Testcontainers)
pnpm test:tenant-leak                # টেন্যান্ট A কি B-র ডেটা দেখতে পায়?
pnpm test:e2e                        # Playwright, ডেস্কটপ + মোবাইল viewport
```

আর হাতে-কলমে, প্রতিটা ধাপের "যা দেখবেন" অংশটা **ব্রাউজারে সত্যিই করে দেখা** — ডেস্কটপে একবার, মোবাইল viewport-এ একবার।

পর্ব ৬ (POS) থেকে অতিরিক্ত: **DevTools → Network → Offline** করে পুরো ফ্লো চালিয়ে, তারপর অনলাইন করে ডেটা মিলিয়ে দেখা।

---

## ৮. প্রথম যে ফাইলগুলো তৈরি হবে (ধাপ ০)

```
pnpm-workspace.yaml, turbo.json, .nvmrc, .editorconfig
packages/config/{eslint,tsconfig,prettier,tailwind}/
apps/api/          NestJS + Fastify, /health
apps/app/          Vite + React, "Hello"
infra/docker/docker-compose.yml   postgres:17, valkey, mailpit, minio
.github/workflows/ci.yml
docs/adr/0002-better-auth-over-external-idp.md   ← ধাপ ০.১-এর সিদ্ধান্ত লিখে রাখা
```

---

## ৯. অগ্রগতি

- [x] **ধাপ ০** — Monorepo, Docker Compose, CI কঙ্কাল
- [x] **ধাপ ১** — DB ভিত্তি + RLS
- [x] **ধাপ ২** — Tenant context + leak test
- [x] **ধাপ ৩** — Auth + RBAC + প্রথম ড্যাশবোর্ড
- [x] **ধাপ ৪–৫** — ডিজাইন সিস্টেম + API কন্ট্র্যাক্ট
- [x] **ধাপ ৬–৮** — Core Platform
- [ ] **ধাপ ৯–১১** — Accounting
- [ ] **ধাপ ১২–১৪** — Inventory
- [ ] **ধাপ ১৫–১৭** — Sales + Purchase
- [ ] **ধাপ ১৮–২০** — POS + অফলাইন
- [ ] **ধাপ ২১** — Reports 🏁 MVP
- [ ] **ধাপ ২২–২৪** — Website + Admin + Billing
- [ ] **ধাপ ২৫** — বেটা লঞ্চের প্রস্তুতি 🚀
- [ ] **ধাপ ২৬–২৮** — Storefront + কুরিয়ার
