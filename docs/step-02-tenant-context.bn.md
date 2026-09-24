# ধাপ ২: Tenant context middleware + leak test

> [build-plan.bn.md](build-plan.bn.md)-এর "ধাপ ২" অংশের ইমপ্লিমেন্টেশন গাইড — ঠিক কোন ফাইলে কী
> লিখতে হবে, কোন কমান্ড কোথায় চালাতে হবে।

## লক্ষ্য

`AsyncLocalStorage` দিয়ে প্রতি-রিকোয়েস্ট tenant context রাখা, আর Testcontainers দিয়ে সত্যিকারের
Postgres তুলে প্রমাণ করা যে এক টেন্যান্ট আরেক টেন্যান্টের ডেটা কখনো দেখতে পারে না।

## কেন `packages/db/src/client.ts` আগে রিফ্যাক্টর করতে হচ্ছে

`db` এখন একটা module-load-time singleton, `process.env.DATABASE_URL` দিয়ে বাঁধা। কিন্তু leak
test চালাতে হবে একটা আলাদা Testcontainers Postgres-এর বিপরীতে — তাই client-টাকে একটা factory
ফাংশনে ভাঙা হচ্ছে (`createDb(connectionString)`), production-এ singleton হিসেবে আর test-এ
নিজস্ব connection দিয়ে ব্যবহার হবে। এখানে ভুল করলে (build-plan-এর নিজের ভাষায়) "পরে সব জায়গায়
ছড়াবে"।

---

## ২.০ — dependency ইনস্টল

```bash
pnpm --filter @omnivo/api add dotenv @omnivo/db drizzle-orm
pnpm --filter @omnivo/api add -D fastify @testcontainers/postgresql testcontainers
```

## ২.১ — `packages/db/src/client.ts` রিফ্যাক্টর (factory)

**ফাইল: `packages/db/src/client.ts`**

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export function createDb(connectionString: string) {
  const queryClient = postgres(connectionString);
  return drizzle(queryClient, { schema });
}

export type Db = ReturnType<typeof createDb>;

export const db = createDb(process.env.DATABASE_URL ?? '');
```

**কোন লাইন কেন:**

- `export function createDb(connectionString: string)` — আগে `db` module-load-time singleton
  ছিল। সমস্যা: leak test চালাতে হবে Testcontainers-এর একটা random port-এ ওঠা Postgres-এর
  বিপরীতে, যার connection string শুধু runtime-এ জানা যায়। Singleton হলে সেটা override করার
  উপায় নেই — তাই connection string-কে parameter বানানো হয়েছে, production-এ একবার কল হবে,
  test-এ প্রতিবার নিজের container-এর URL দিয়ে।
- `export type Db = ReturnType<typeof createDb>` — হাতে ইন্টারফেস না লিখে আসল return type থেকে
  derive করা (rule ২), যাতে drizzle/schema বদলালে এই টাইপ নিজে থেকেই sync থাকে।
- `export const db = createDb(process.env.DATABASE_URL ?? '')` — backward-compatible singleton
  export, যাতে বাকি অ্যাপ কোড (যেটা এখনো `db` সরাসরি import করে) না ভাঙে।
- `!` এর বদলে `?? ''` — import-time-এ env এখনো লোড না-ও হতে পারে (import order-নির্ভর); `postgres()`
  lazy — constructor-এ আসলে connect করে না, প্রথম query-তে করে। তাই খালি স্ট্রিং দিয়েও import
  নিরাপদ, সমস্যা হবে শুধু env লোড হওয়ার আগে কেউ আসলে query চালালে।

## ২.২ — `apps/api`-এ env লোডিং

`packages/db`-তে যে cwd-সমস্যা হয়েছিল (দেখুন নিচের নোট), একই কারণে `apps/api`-রও দরকার root
`.env` explicitly লোড করা।

> নোট: `pnpm --filter <pkg> <script>` চালালে cwd হয় ওই প্যাকেজের ফোল্ডার, repo root না। তাই
> `dotenv/config`-এর ডিফল্ট cwd-ভিত্তিক লুকআপ root `.env` খুঁজে পায় না — ফাইলের নিজের লোকেশন
> থেকে explicit পাথ resolve করতে হয়।

**ফাইল: `apps/api/src/env.ts`** (নতুন ফাইল)

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: path.join(repoRoot, '.env') });
```

**ফাইল: `apps/api/src/main.ts`** — সবার প্রথম import হিসেবে বসান

```ts
import './env';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await app.listen(3000, '0.0.0.0');
}

void bootstrap();
```

**কোন লাইন কেন:**

- `env.ts`-এ `path.resolve(..., '../../..')` দিয়ে `repoRoot` বের করা — `pnpm --filter <pkg>
  <script>` চালালে cwd হয় প্যাকেজের নিজের ফোল্ডার (`apps/api`), repo root না। `dotenv/config`-এর
  ডিফল্ট cwd-based lookup তাই root `.env` খুঁজে পায় না। `import.meta.url` থেকে ফাইলের নিজের
  ডিস্ক-লোকেশন জেনে সেখান থেকে resolve করা হচ্ছে — এটা deterministic, `pnpm` কোথা থেকে চালানো
  হলো তার ওপর নির্ভর করে না।
- `main.ts`-এ `import './env'` সবচেয়ে প্রথম লাইন — ES module import hoisting-এর নিয়মে, নিচে যত
  `import { NestFactory } ...` থাকুক, `./env` আগে থাকলে সেটার side-effect (dotenv `config()` কল)
  আগে রান হয়। প্রথমে না থাকলে `NestFactory.create` চলার সময় `DATABASE_URL` undefined থাকতে
  পারে — এটাই ঠিক ২.১-এর `?? ''` fallback যে সমস্যা এড়াতে চাইছে তার root cause।

## ২.৩ — AsyncLocalStorage tenant context

**ফাইল: `apps/api/src/common/tenant/tenant-context.ts`** (নতুন ফাইল)

```ts
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantStore {
  tenantId: string;
}

export const tenantStorage = new AsyncLocalStorage<TenantStore>();

export function getTenantId(): string {
  const store = tenantStorage.getStore();
  if (!store) {
    throw new Error('No tenant context — did TenantMiddleware run for this request?');
  }
  return store.tenantId;
}

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStorage.run({ tenantId }, fn);
}
```

**কোন লাইন কেন:**

- `export const tenantStorage = new AsyncLocalStorage<TenantStore>()` — প্রতিটা layer-এ
  (middleware → guard → service → repository) `tenantId` ম্যানুয়ালি প্যারামিটার হিসেবে পাস
  করলে একটা জায়গায় ভুলে গেলেই leak-এর ঝুঁকি থাকে। `AsyncLocalStorage` request-এর পুরো async
  call chain-এ context implicitly carry করে, তাই কোনো লেয়ারে ভুলে বাদ পড়ার সুযোগ কম।
- `getTenantId()`-এ `if (!store) throw new Error(...)` — silent `undefined` রিটার্ন না করে
  explicit throw, কারণ এটাই tenant-isolation নিরাপত্তার ভিত্তি: `tenantId` না থাকলে কোনো query
  চালানো উচিত না। Fail-loud এখানে ইচ্ছাকৃত — fail-silent হলে tenant filter ছাড়াই query চলে
  যাওয়ার মতো bug চুপচাপ ঘটে যেতে পারত।
- `runWithTenant<T>(tenantId, fn)` `tenantStorage.run(...)`-কে wrap করছে শুধু call-site-এ
  পরিষ্কার নাম দেওয়ার জন্য না — raw `tenantStorage.run` প্রতিটা call-site-এ সরাসরি ছড়িয়ে থাকলে
  store-এর shape (`{ tenantId }`) বারবার মনে রাখতে হতো; একটা জায়গায় বেঁধে রাখলে leak-surface কম।

## ২.৪ — `withTenant()` helper

**ফাইল: `apps/api/src/common/tenant/with-tenant.ts`** (নতুন ফাইল)

```ts
import { sql } from 'drizzle-orm';
import { db, type Db } from '@omnivo/db';
import { getTenantId } from './tenant-context';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createWithTenant(database: Db) {
  return async function withTenant<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const tenantId = getTenantId();
    return database.transaction(async (tx) => {
      // true = transaction-local — commit/rollback-এর সাথে এই সেটিংও যায়, PgBouncer-নিরাপদ
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  };
}

// অ্যাপ runtime-এর জন্য singleton — production/dev কোডে এটাই import করবেন
export const withTenant = createWithTenant(db);
```

> ⚠️ কখনো `SET app.tenant_id = ...` লিখবেন না, সবসময় `set_config(..., true)` — `SET`
> PgBouncer-এর transaction pooling মোডে connection-এর মধ্যে leak করতে পারে।

**কোন লাইন কেন:**

- `type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0]` — `Db['transaction']`
  মেথডের callback প্যারামিটারের টাইপ বের করছে, হাতে duplicate টাইপ না লিখে (rule ২)। Drizzle-এর
  transaction টাইপ জটিল ও ভার্সনে বদলাতে পারে বলে এভাবে derive করাই একমাত্র নিরাপদ উপায় — হাতে
  লিখলে drizzle আপডেট হলে সাইলেন্টলি out-of-sync হয়ে যেত।
- `createWithTenant(database: Db)` ফ্যাক্টরি — ঠিক `createDb`-এর মতো কারণে: leak test-এ
  Testcontainers-এর `Db` ইনস্ট্যান্স দিয়ে আলাদা `withTenant` লাগবে, production `db` দিয়ে না।
- `database.transaction(async (tx) => { ... })` — `set_config` আর আসল query একই transaction-এ,
  কারণ Postgres session variable transaction-scope-এ set করলে সেটা commit/rollback-এর সাথে
  automatically পরিষ্কার হয়ে যায়। আলাদা query হিসেবে set করলে connection pooling-এর সাথে leak
  হওয়ার ঝুঁকি থাকত।
- `set_config('app.tenant_id', ${tenantId}, true)`-এর তৃতীয় আর্গুমেন্ট `true` মানে "is_local =
  true", অর্থাৎ transaction-local, session-wide না — উপরের comment-টাই এটা বলছে।
- warning-এর কারণ: `SET app.tenant_id = ...` (ordinary SQL SET) ব্যবহার না করার কারণ — PgBouncer-এর
  transaction pooling মোডে একই physical connection একাধিক client-এর মধ্যে reuse হয়। `SET` দিয়ে
  করা session-level change transaction শেষেও connection-এ থেকে যেতে পারে, ফলে পরের client (অন্য
  tenant) সেই leaked `tenant_id` নিয়ে query চালিয়ে ফেলতে পারে — এটাই সবচেয়ে বিপজ্জনক tenant-leak
  vector, তাই `set_config(..., true)` বাধ্যতামূলক।
- `` sql`...${tenantId}` `` — string concatenation না করার কারণ SQL injection এড়ানো; drizzle-এর
  `sql` tag নিজে থেকেই parameterize করে।

## ২.৫ — Middleware + Guard

**ফাইল: `apps/api/src/common/tenant/tenant.middleware.ts`** (নতুন ফাইল)

```ts
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { runWithTenant } from './tenant-context';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantMiddleware implements NestMiddleware<FastifyRequest, FastifyReply> {
  use(req: FastifyRequest, _res: FastifyReply, next: () => void): void {
    // TODO ধাপ ৩: JWT-এর tenant_id claim এলে এই header-ভিত্তিক এক্সট্র্যাকশন সরিয়ে দিন
    const header = req.headers['x-tenant-id'];
    const tenantId = Array.isArray(header) ? header[0] : header;

    if (tenantId && UUID_RE.test(tenantId)) {
      runWithTenant(tenantId, next);
      return;
    }

    next();
  }
}
```

**ফাইল: `apps/api/src/common/tenant/tenant.guard.ts`** (নতুন ফাইল — যেসব রুটে tenant
বাধ্যতামূলক, শুধু সেখানে `@UseGuards(TenantGuard)` দিয়ে বসাবেন; `/health`-এর মতো পাবলিক রুট এটা
এড়িয়ে যাবে)

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { tenantStorage } from './tenant-context';

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (!tenantStorage.getStore()) {
      throw new ForbiddenException('This route requires a tenant context (x-tenant-id header)');
    }
    return true;
  }
}
```

**কোন লাইন কেন:**

- `const UUID_RE = /^[0-9a-f]{8}-.../i` — header থেকে আসা যেকোনো স্ট্রিং সরাসরি tenant context-এ
  বসানো বিপজ্জনক (পরে সেটা `set_config` SQL-এ যাবে)। UUID শেপ validate করে নেওয়া হচ্ছে প্রাথমিক
  sanity-check হিসেবে — যদিও এটা authorization check না (valid-shaped যেকোনো UUID পাঠালেই সেই
  tenant হিসেবে চলে যাবে), সেটা পরের ধাপে JWT দিয়ে ঠিক হবে, TODO কমেন্টে সেটাই লেখা আছে।
- `Array.isArray(header) ? header[0] : header` — Fastify-তে duplicate header থাকলে
  `req.headers[...]`-এর টাইপ `string | string[] | undefined` হয়। এই লাইনটা টাইপ normalize
  করছে যাতে regex test-এ single string যায় — টাইপ-নিরাপত্তার (rule ২) জন্যও দরকার, `.test()`
  `string[]`-এ কাজ করবে না।
- `if (tenantId && UUID_RE.test(tenantId)) { runWithTenant(tenantId, next); return; }` — `next`
  কে সরাসরি না ডেকে `runWithTenant`-এর ভেতর দিয়ে ডাকা হচ্ছে, কারণ `AsyncLocalStorage.run()`-এর
  callback-এর ভেতরে যা কিছু sync/async চলবে (পুরো বাকি request lifecycle) সেটাই ওই tenant
  context পাবে। `next()` কে বাইরে থেকে normally কল করলে middleware-এর পরের async কোড
  context-এর বাইরে চলে যেত।
- header না থাকলে বা invalid UUID হলে প্লেইন `next()` — tenant ছাড়া request-কে block না করে pass
  করে দেওয়া হচ্ছে, কারণ `/health`-এর মতো পাবলিক রুটে tenant লাগবে না। Enforcement-এর দায়িত্ব
  middleware-এর না, `TenantGuard`-এর — এই আলাদা করাটাই route-ভিত্তিক নিয়ন্ত্রণ সম্ভব করছে।
- `TenantGuard.canActivate` `tenantStorage.getStore()`-কে সরাসরি চেক করছে, `getTenantId()` কল
  করে exception ধরার বদলে — কারণ এখানে NestJS-এর `ForbiddenException` (403) ছুঁড়তে হবে,
  `getTenantId()`-এর generic `Error` (যেটা internal invariant-violation বোঝায়, যেমন middleware-ই
  না চলা) না।

**ফাইল: `apps/api/src/app.module.ts`** (আপডেট)

```ts
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';

import { HealthController } from './health/health.controller';
import { TenantMiddleware } from './common/tenant/tenant.middleware';

@Module({
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
```

**কোন লাইন কেন:** `consumer.apply(TenantMiddleware).forRoutes('*')` — middleware সব রুটে চলে
(parse করে context বসায়, কিন্তু enforce করে না), যাতে যেকোনো নতুন রুটে ভুলে guard বসাতে ভুলে
গেলেও অন্তত middleware চলবে এবং পরে guard-ভিত্তিক enforcement যোগ করা সহজ হয়।

## ২.৬ — Testcontainers দিয়ে leak test (এই ধাপের মূল লক্ষ্য)

**ফাইল: `apps/api/src/common/tenant/tenant-leak.spec.ts`** (নতুন ফাইল)

```ts
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { createDb, memberships, tenants, users, type Db } from '@omnivo/db';
import { runWithTenant } from './tenant-context';
import { createWithTenant } from './with-tenant';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

let container: StartedPostgreSqlContainer;
let appDb: Db;
let withTenant: ReturnType<typeof createWithTenant>;

async function seedTenant(name: string, slug: string, email: string) {
  const [tenant] = await appDb.insert(tenants).values({ name, slug }).returning();
  const [user] = await appDb.insert(users).values({ email, fullName: name }).returning();
  if (!tenant || !user) throw new Error('seed failed');

  await runWithTenant(tenant.id, () =>
    withTenant(async (tx) => {
      await tx.insert(memberships).values({ tenantId: tenant.id, userId: user.id });
    }),
  );

  return tenant.id;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('omnivo')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(5432);

  // ১. role bootstrap — ঠিক সেই SQL যেটা docker-compose-এও চলে
  const rolesSql = readFileSync(
    path.join(repoRoot, 'infra/docker/postgres/init/01-roles.sql'),
    'utf-8',
  );
  const admin = postgres({ host, port, database: 'omnivo', username: 'postgres', password: 'postgres' });
  await admin.unsafe(rolesSql);
  await admin.end();

  // ২. migration — omnivo_migrator দিয়ে, আসল packages/db/migrations ফোল্ডার থেকে
  const migratorClient = postgres({
    host,
    port,
    database: 'omnivo',
    username: 'omnivo_migrator',
    password: 'migrator_dev_password',
    max: 1,
  });
  await migrate(drizzle(migratorClient), {
    migrationsFolder: path.join(repoRoot, 'packages/db/migrations'),
  });
  await migratorClient.end();

  // ৩. app runtime role দিয়ে — এটাই আসল প্রোডাকশন কানেকশন, RLS bypass করতে পারে না
  appDb = createDb(`postgres://omnivo_app:app_dev_password@${host}:${port}/omnivo`);
  withTenant = createWithTenant(appDb);
}, 60_000);

afterAll(async () => {
  await container.stop();
});

describe('tenant isolation (RLS)', () => {
  it('tenant A cannot read tenant B rows, even when explicitly filtering by B', async () => {
    const tenantAId = await seedTenant('Tenant A', 'tenant-a', 'a@example.com');
    const tenantBId = await seedTenant('Tenant B', 'tenant-b', 'b@example.com');

    const leaked = await runWithTenant(tenantAId, () =>
      withTenant((tx) => tx.select().from(memberships).where(eq(memberships.tenantId, tenantBId))),
    );
    expect(leaked).toHaveLength(0);

    const own = await runWithTenant(tenantAId, () => withTenant((tx) => tx.select().from(memberships)));
    expect(own).toHaveLength(1);
  });
});
```

**কোন লাইন কেন:**

- Mock/in-memory DB না, real Testcontainers Postgres — কারণ tenant isolation-এর আসল গ্যারান্টিটা
  আসছে Postgres RLS policy থেকে, mock DB সেই policy বুঝবেই না; bug-ভরা RLS policy দিয়েও mock
  টেস্ট pass করে যেতে পারত।
- তিনটা আলাদা role দিয়ে তিনটা ধাপ চালানো হচ্ছে, প্রতিটা আলাদা জিনিস প্রমাণ করার জন্য:
  - `postgres` (superuser) দিয়ে `01-roles.sql` রান করা — এটাই docker-compose-এ production-এ যা
    চলে ঠিক সেই bootstrap script, যাতে টেস্ট আর real environment-এর role setup ড্রিফট না করে।
  - `omnivo_migrator` role দিয়ে migration — migration role-এর DDL privilege লাগে, কিন্তু app
    role-এর সেটা থাকা উচিত না (least privilege)।
  - `omnivo_app` role দিয়ে আসল টেস্ট query (`appDb = createDb(...)`) — এটাই সবচেয়ে গুরুত্বপূর্ণ
    লাইন, comment-এই বলা আছে: এটাই আসল প্রোডাকশন কানেকশন, RLS bypass করতে পারে না। ভুল করে
    superuser role দিয়ে চললে RLS policy থাকলেও superuser সেটা bypass করে ফেলতে পারত এবং টেস্ট
    false-positive pass দিত।
- `seedTenant`-এর `membership` insert `runWithTenant(tenant.id, () => withTenant(...))`-এর
  ভেতরে — কারণ RLS policy সাধারণত `app.tenant_id`-এর ওপর নির্ভর করে insert-ও গেট করে; সেই
  context ছাড়া insert-ই fail করতে পারে বা ভুল tenant-এ যেতে পারে।
- মূল assertion: `runWithTenant(tenantAId, ...)` context-এর ভেতরে থেকে explicitly
  `eq(memberships.tenantId, tenantBId)` দিয়ে filter করে B-এর row চাওয়া হচ্ছে, এবং
  `expect(leaked).toHaveLength(0)` — এটা ইচ্ছাকৃতভাবে সবচেয়ে খারাপ কেসটা টেস্ট করছে: অ্যাপ কোডে
  বাগ থাকলেও (কেউ ভুল tenant-এর ID দিয়ে filter লিখে ফেললেও), RLS policy-টাই যেন শেষ লাইন অফ
  ডিফেন্স হিসেবে ডেটা আটকায়। শুধু "নিজের tenant-এর ডেটা পাওয়া যায়" টেস্ট করলে এই
  defense-in-depth গ্যারান্টিটা প্রমাণ হতো না।
- `own` assertion আলাদা করে থাকার কারণ — এটা নিশ্চিত করছে RLS policy শুধু leak আটকাচ্ছে না,
  বরং একেবারেই সব data hide করে দিচ্ছে না (over-blocking না)। দুটো assertion মিলিয়েই প্রমাণ হয়
  policy-টা ঠিক exactly tenant-scoped, বেশিও না কমও না।

## ২.৭ — রান করুন

```bash
pnpm --filter @omnivo/api typecheck
pnpm --filter @omnivo/api test
```

(প্রথম রানে `postgres:17-alpine` ইমেজ pull হবে — একটু সময় লাগবে; Docker Desktop চালু থাকতে হবে,
যেহেতু Testcontainers নিজেই Docker ব্যবহার করে।)

---

## যাচাইয়ের তালিকা

```bash
pnpm typecheck
pnpm boundaries
pnpm format
pnpm --filter @omnivo/api test
```

সব পাস করলে, ম্যানুয়ালি `curl` দিয়েও middleware দেখতে পারেন:

```bash
pnpm dev   # আরেক টার্মিনালে
curl http://localhost:3000/health -H "x-tenant-id: $(node -e 'console.log(crypto.randomUUID())')"
```
