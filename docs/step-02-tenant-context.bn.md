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

(`!` এর বদলে `?? ''` — কারণ import-time-এ env এখনো লোড না-ও হতে পারে; `postgres()` lazy, প্রথম
query না চালানো পর্যন্ত আসলে কানেক্ট করে না, তাই খালি স্ট্রিং দিয়েও import নিরাপদ।)

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
