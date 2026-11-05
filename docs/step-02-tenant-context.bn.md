# ধাপ ২: Tenant context middleware + leak test

> [build-plan.bn.md](build-plan.bn.md)-এর "ধাপ ২" অংশের ইমপ্লিমেন্টেশন গাইড — ঠিক কোন ফাইলে কী
> লিখতে হবে, কোন কমান্ড কোথায় চালাতে হবে।
>
> এই গাইডের প্রতিটা ফাইল একটা আলাদা কপিতে বসিয়ে যাচাই করা (২০২৬-০৯-২৭): `pnpm lint`,
> `pnpm format`, `pnpm typecheck`, `pnpm test` (৪টা middleware টেস্ট), `pnpm test:tenant-leak`
> (Testcontainers-এ ৬টা টেস্ট), `pnpm build`, `pnpm boundaries`, `pnpm dev` → `/health` — সব পাস।

## লক্ষ্য

`AsyncLocalStorage` দিয়ে প্রতি-রিকোয়েস্ট tenant context রাখা, আর Testcontainers দিয়ে সত্যিকারের
Postgres তুলে প্রমাণ করা যে এক টেন্যান্ট আরেক টেন্যান্টের ডেটা কখনো দেখতে বা লিখতে পারে না।

## এই ধাপের দুটো ভিত্তি-সিদ্ধান্ত

1. **`apps/api` হবে ESM** (`"type": "module"`)। আগে `apps/api` CommonJS হিসেবে compile হতো, তাই
   `import.meta.url` লিখলেই `TS1470` error আসত — `env.ts` আর leak test দুটোতেই এটা লাগে।
   `@omnivo/db` আগে থেকেই ESM, তাই পুরো monorepo এখন একই module system-এ।
2. **`@omnivo/db` build হবে `dist/`-এ।** আগে প্যাকেজটা সরাসরি `src/index.ts` export করত। Vitest
   সেটা সামলাতে পারে, কিন্তু Node পারে না — `node dist/main.js` চালালে
   `ERR_MODULE_NOT_FOUND .../schema/index.js` দেয়, কারণ Node-এর type-stripping `.js` import-কে
   `.ts` ফাইলে map করে না। তাই যেদিন API প্রথম `@omnivo/db` import করবে, সেদিন `pnpm dev` crash
   করত। এখন `tsc` দিয়ে `dist/`-এ আসল `.js` + `.d.ts` তৈরি হবে।

## আগের খসড়া থেকে যা বাদ গেছে

- `packages/db/src/client.ts`-এর `export const db = createDb(process.env.DATABASE_URL ?? '')` —
  **বাদ।** `postgres('')` কোনো error দেয় না, বরং `PG*` env বা `localhost`-এ OS ইউজার হিসেবে চুপচাপ
  connect করার চেষ্টা করে — ভুল DB-তে লেখার মতো bug লুকিয়ে যেত। Singleton এখন কেউ ব্যবহারও করে
  না; API-র আসল DB provider ধাপ ৩-এ আসবে, যখন প্রথম consumer আসবে।
- `with-tenant.ts`-এর `export const withTenant = createWithTenant(db)` — একই কারণে **বাদ।**
- `fastify` devDependency — **লাগবে না।** Nest-এর Fastify adapter-এ middleware আসলে raw
  `IncomingMessage`/`ServerResponse` পায়, `FastifyRequest` না — তাই টাইপ `node:http` থেকে আসবে।
- `tenant-leak.spec.ts` নাম — এখন **`tenant-leak.int.spec.ts`**, যাতে Docker-নির্ভর টেস্ট
  সাধারণ `pnpm test` থেকে আলাদা থাকে।

---

## ২.০ — dependency ইনস্টল

```bash
pnpm --filter @omnivo/api add -D @testcontainers/postgresql testcontainers postgres
```

(`@omnivo/db`, `drizzle-orm`, `dotenv` আগেই যোগ হয়ে গেছে — [apps/api/package.json](../apps/api/package.json) দেখুন।)

**কেন:**

- `postgres` — leak test নিজে `omnivo_migrator` আর `postgres` superuser হিসেবে আলাদা connection
  খোলে। pnpm-এর strict `node_modules`-এ `@omnivo/db`-এর dependency `apps/api` থেকে import করা যায়
  না, তাই সরাসরি ঘোষণা করতে হয়। শুধু টেস্টে লাগে, তাই `-D`।
- ইনস্টলের পর pnpm `ssh2`, `cpu-features`, `protobufjs`-এর build script নিয়ে জিজ্ঞেস করবে, আর
  [pnpm-workspace.yaml](../pnpm-workspace.yaml)-এর `allowBuilds`-এ `set this to true or false`
  লিখে রাখবে। তিনটাকেই **`false`** দিন:

  ```yaml
  allowBuilds:
    esbuild: true
    '@swc/core': true
    unrs-resolver: true
    cpu-features: false # testcontainers-এর SSH-এর optional native addon — লোকাল Docker-এ লাগে না
    protobufjs: false # postinstall শুধু version-চেক করে
    ssh2: false # remote Docker host-এর জন্য, আমাদের দরকার নেই
  ```

  কেন `false`: এগুলো optional native build, না চালালেও testcontainers pure-JS fallback-এ কাজ করে
  (যাচাই করা)। অজানা postinstall script কম চালানো মানে supply-chain ঝুঁকিও কম।

---

## ২.১ — `@omnivo/db`-কে build করা প্যাকেজ বানানো

**ফাইল: `packages/db/tsconfig.build.json`** (নতুন ফাইল)

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "rootDir": "./src",
    "outDir": "./dist",
    "declarationMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/migrate.ts", "src/seed.ts", "src/env.ts"]
}
```

**কোন লাইন কেন:**

- আলাদা `tsconfig.build.json`, মূল `tsconfig.json` না বদলে — মূলটা `typecheck` আর ESLint-এর জন্য,
  যেটা `drizzle.config.ts`-ও চেক করে এবং `noEmit: true`। build-এ শুধু লাইব্রেরি কোড দরকার; দুটো
  কাজ এক config-এ মেশালে `drizzle.config.ts` `dist`-এ চলে যেত আর `rootDir` error দিত।
- `"noEmit": false` — মূল config-এর `noEmit: true` override করা, নাহলে `tsc` কিছুই লিখবে না।
- `"rootDir": "./src"` — না দিলে TS নিজে rootDir অনুমান করে; পরে কোনো ফাইল যোগ হলে `dist/`-এর
  কাঠামো বদলে `dist/src/index.js` হয়ে যেতে পারত, আর `exports` ভেঙে যেত।
- `"declarationMap": true` — `.d.ts.map` তৈরি করে, যাতে API-তে `createDb`-এ "Go to Definition"
  করলে `dist/*.d.ts` না খুলে আসল `src/*.ts` খোলে। base config-এ `declaration: true` আগেই আছে।
- `exclude`-এ `migrate.ts`, `seed.ts`, `env.ts` — এগুলো `tsx` দিয়ে সরাসরি চালানো CLI script,
  লাইব্রেরির অংশ না। `env.ts` `dotenv` import করে, যেটা `devDependency` — `dist`-এ গেলে runtime-এ
  এমন প্যাকেজ লাগত যা production install-এ থাকবে না।

**ফাইল: `packages/db/package.json`** (আপডেট — শুধু `exports` আর দুটো script)

```json
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "dev": "tsc -p tsconfig.build.json --watch --preserveWatchOutput",
    "generate": "drizzle-kit generate",
    ...বাকিগুলো আগের মতো
  },
```

**কোন লাইন কেন:**

- `"types": "./dist/index.d.ts"` — `types` কে `src/index.ts`-এ রাখা লোভনীয় (build ছাড়াই টাইপ পাওয়া
  যেত), কিন্তু তখন `apps/api`-র `tsc` ওই `.ts` ফাইলকে নিজের source হিসেবে ধরে compile করতে চায়, আর
  `apps/api`-র `rootDir: ./src`-এর বাইরে বলে `TS6059` দেয়। `.d.ts` শুধু টাইপ-তথ্য, compile হয় না।
- `"types"` শর্তটা `"default"`-এর **আগে** — `exports` condition উপর থেকে নিচে মেলানো হয়; `default`
  আগে থাকলে TypeScript `.js` ফাইল পেয়ে টাইপ হারাত।
- `"build"` নামটাই রাখা — [turbo.json](../turbo.json)-এর `"dependsOn": ["^build"]` ঠিক এই নামের
  script খোঁজে। এর ফলে `typecheck`/`test`/`dev`-এর আগে turbo নিজে থেকেই db build করে নেয়।
- `"dev"` — `pnpm dev`-এ turbo এটাকে API-র পাশাপাশি চালায়, তাই schema বদলালে `dist` নিজে আপডেট হয়
  আর `nest start --watch` নতুন টাইপ দেখে। `--preserveWatchOutput` দিয়ে turbo-র মেশানো আউটপুটে tsc
  স্ক্রিন clear করে না।

**ফাইল: `packages/db/src/client.ts`** (পুরোটা এভাবে)

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export interface CreateDbOptions {
  max?: number;
}

// import-time singleton না: কোন DB-তে কানেক্ট করবে সেটা caller ঠিক করবে
// (API-তে DATABASE_URL, leak test-এ Testcontainers-এর URL)
export function createDb(connectionString: string, options: CreateDbOptions = {}) {
  const queryClient = postgres(connectionString, options);
  return drizzle(queryClient, { schema });
}

export type Db = ReturnType<typeof createDb>;
```

**কোন লাইন কেন:**

- HEAD-এর comment ফিরিয়ে আনা হয়েছে — uncommitted diff-এ এটা মুছে গিয়েছিল, অথচ এটাই বলে কেন
  singleton নেই। পরে কেউ "সুবিধার জন্য" singleton ফেরত আনতে গেলে এই লাইনটা থামাবে।
- `CreateDbOptions`-এ শুধু `max` — postgres.js-এর পুরো `Options` টাইপ expose করলে `@omnivo/db`-এর
  public API-তে postgres.js লিক হতো, আর তার generic (`Options<T>`) নিয়ে ঝামেলা বাড়ত। এখন যা লাগে
  শুধু সেটুকু; দরকার হলে পরে field যোগ হবে।
- `max?: number` (optional) + `exactOptionalPropertyTypes` — caller `{ max: undefined }` পাঠাতে
  পারবে না, হয় সংখ্যা দেবে নয়তো বাদ দেবে। postgres.js-এর নিজের `max?: number`-এর সাথে টাইপ মিলে যায়,
  কোনো cast লাগে না।
- `max` কেন দরকার: leak test-এ `max: 1` দিয়ে pool-এ একটাই connection রাখা হয়, যাতে "আগের
  transaction-এর tenant setting কি পরের query-তে থেকে গেল?" টেস্টটা নিশ্চিতভাবে **একই** connection-এ
  চলে। একাধিক connection থাকলে টেস্ট ভাগ্যক্রমে অন্য connection পেয়ে ভুলভাবে পাস করতে পারত।
- `options: CreateDbOptions = {}` default — production caller শুধু URL দিলেই চলবে, আগের signature
  ভাঙে না।
- `export type Db = ReturnType<typeof createDb>` — হাতে টাইপ না লিখে আসল return type থেকে derive
  (rule ২), তাই drizzle বা schema বদলালে নিজে থেকে sync থাকে।

---

## ২.২ — turbo আর root script

**ফাইল: `turbo.json`**

```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    },
    "typecheck": {
      "dependsOn": ["^build"]
    },
    "test": {
      "dependsOn": ["^build"]
    },
    "test:integration": {
      "dependsOn": ["^build"],
      "cache": false
    },
    "test:tenant-leak": {
      "dependsOn": ["^build"],
      "cache": false
    }
  }
}
```

**কোন লাইন কেন:**

- `dev`-এ নতুন `"dependsOn": ["^build"]` — fresh clone-এ `packages/db/dist` থাকে না। এটা ছাড়া
  `pnpm dev` চালালে API প্রথমবার `@omnivo/db` resolve করতে গিয়ে fail করত। `^` মানে "আমার
  dependency-গুলোর build", নিজের না।
- `test:integration` আর `test:tenant-leak` আলাদা task, দুটোতেই `^build` — এগুলো `@omnivo/db`-এর
  `dist` import করে।
- `"cache": false` — Docker container-এর বিপরীতে চলা টেস্টের ফল শুধু source-এর ওপর নির্ভর করে না
  (migration, Postgres image, Docker অবস্থা)। turbo cache hit দিলে আসলে টেস্ট না চালিয়েই "pass"
  দেখাত — security টেস্টের জন্য এটা বিপজ্জনক।

**ফাইল: `package.json`** (root — শুধু এই তিনটা script বদলাবে)

```json
    "lint": "turbo run build --filter=@omnivo/db && eslint .",
    "test:integration": "turbo run test:integration",
    "test:tenant-leak": "turbo run test:tenant-leak",
```

**কোন লাইন কেন:**

- `lint`-এর আগে db build — ESLint-এর type-aware rule (`strictTypeChecked`) `@omnivo/db`-এর টাইপ
  `dist/index.d.ts` থেকে পড়ে। fresh clone বা CI-তে `dist` না থাকলে প্রতিটা `db` ব্যবহারে
  `no-unsafe-call`/`no-unsafe-member-access` দিয়ে কয়েক ডজন error আসে (যাচাই করা)। CI-তে Lint ধাপটা
  Build-এর আগে চলে, তাই এটা এখানেই সামলাতে হয়। দ্বিতীয়বার turbo cache থেকে মিলিসেকেন্ডে ফেরে।
- আগের `echo 'skipped: ...'` placeholder দুটো এখন আসল turbo task — এগুলো না বদলালে
  [.github/workflows/ci.yml](../.github/workflows/ci.yml)-এর "Tenant leak tests" ধাপ সবসময়
  সবুজ দেখাত, কিন্তু কোনো টেস্টই চলত না। **CI yml-এ কোনো বদল লাগবে না** — সে আগে থেকেই এই script
  নামগুলো ডাকে।

---

## ২.৩ — `apps/api`-কে ESM বানানো

**ফাইল: `apps/api/package.json`** (আপডেট)

```json
{
  "name": "@omnivo/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "start": "node dist/main.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests --exclude \"**/*.int.spec.ts\"",
    "test:integration": "vitest run --passWithNoTests .int.spec --exclude \"**/tenant-leak.int.spec.ts\"",
    "test:tenant-leak": "vitest run tenant-leak.int.spec"
  },
  ...
}
```

**কোন লাইন কেন:**

- `"type": "module"` — `tsconfig`-এ `"module": "nodenext"` আছে, আর nodenext module system ঠিক করে
  **নিকটতম `package.json`-এর `type` দেখে।** এটা না থাকায় সব ফাইল CommonJS ধরা হচ্ছিল, আর
  CommonJS-এ `import.meta` নেই — সেখান থেকেই `TS1470`। tsconfig-এ কিছু বদলাতে হবে না।
- `test`-এ `--exclude "**/*.int.spec.ts"` — সাধারণ `pnpm test` Docker ছাড়া চলা উচিত, দ্রুত হওয়া
  উচিত। Docker লাগে এমন টেস্ট `.int.spec.ts` নামে আলাদা থাকবে।
- `test:integration`-এ positional `.int.spec` — Vitest-এ positional আর্গুমেন্ট ফাইল-পাথের
  substring filter। `--exclude` দিয়ে leak spec বাদ, কারণ CI-তে সেটা পরের ধাপ `test:tenant-leak`-এ
  আলাদা চলে — নাহলে একই container টেস্ট দুবার চলত। এখন কোনো সাধারণ integration টেস্ট নেই, তাই
  `--passWithNoTests`।
- `test:tenant-leak` আলাদা script — build-plan-এর যাচাই তালিকা আর CI দুটোই এই নামে ডাকে, আর
  এটাকে আলাদা রাখলে একটা fail হলে ঠিক কোনটা ভাঙল তা CI লগে সরাসরি দেখা যায়।

**ফাইল: `apps/api/tsconfig.build.json`** (নতুন ফাইল)

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.spec.ts"]
}
```

**কেন:** Nest CLI `nest build`-এ ডিফল্টভাবে `tsconfig.build.json` খোঁজে, না পেলে `tsconfig.json`
ব্যবহার করে। এটা না থাকলে spec ফাইলগুলো `dist/`-এ compile হয়ে যেত — production bundle-এ
`testcontainers`-এর মতো devDependency-র import ঢুকত। মূল `tsconfig.json` spec সহ রাখা হয়েছে যাতে
`pnpm typecheck` টেস্ট ফাইলগুলোও type check করে (rule ২)।

**ফাইল: `apps/api/src/env.ts`**

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

// pnpm --filter চালালে cwd হয় apps/api, তাই root .env-এর পাথ ফাইলের লোকেশন থেকে বের করা
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
config({ path: path.join(repoRoot, '.env'), quiet: true });
```

**কোন লাইন কেন:**

- `import.meta.url` — ESM-এ `__dirname` নেই; এটাই ফাইলের নিজের লোকেশন জানার উপায়। `pnpm` কোথা থেকে
  চালানো হলো তার ওপর নির্ভর করে না।
- `'../../..'` — build-এর পর ফাইলটা থাকে `apps/api/dist/env.js`-এ, dev-এর সময়ও Nest `dist` থেকেই
  চালায়। `dist` → `api` → `apps` → repo root, তিন ধাপ উপরে। (`src/env.ts` থেকেও একই গভীরতা, তাই
  দুই জায়গাতেই ঠিক।)
- `quiet: true` — dotenv v17+ প্রতিবার লোডে কনসোলে একটা লাইন ছাপে। `packages/db/src/env.ts`-এও
  একই অপশন আছে, সামঞ্জস্য রাখা।
- ফাইলের শেষে newline রাখবেন — এখনকার ফাইলে না থাকায় `pnpm format` fail করছে।

**ফাইল: `apps/api/src/main.ts`**

```ts
import './env.js';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
  await app.listen(3000, '0.0.0.0');
}

void bootstrap();
```

**কোন লাইন কেন:**

- `'./env.js'`, `'./app.module.js'` — ESM-এ Node relative import-এর extension নিজে থেকে খোঁজে না।
  `.js` লিখতে হয় (`.ts` না), কারণ import-টা runtime-এ compile হওয়া `.js` ফাইলকে বোঝায়;
  TypeScript nodenext মোডে `.js` দেখে নিজেই `.ts` source খুঁজে নেয়। extension ছাড়া লিখলে `tsc`
  `TS2835` error দেবে।
- `import './env.js'` সবার প্রথমে — ESM-এ import-গুলো লেখার ক্রমে evaluate হয়, তাই পরের কোনো
  module `process.env` পড়ার আগেই `.env` লোড হয়ে যায়।

> **নিয়ম (এখন থেকে `apps/api`-এর প্রতিটা ফাইলে):** প্রতিটা relative import `.js` দিয়ে শেষ হবে —
> `./health/health.controller.js`, `./tenant-context.js` ইত্যাদি। প্যাকেজ import (`@nestjs/common`,
> `@omnivo/db`)-এ extension লাগে না।

---

## ২.৪ — AsyncLocalStorage tenant context

**ফাইল: `apps/api/src/common/tenant/tenant-context.ts`** (আগের মতোই — শুধু শেষে newline যোগ করুন)

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

- `new AsyncLocalStorage<TenantStore>()` — প্রতিটা layer-এ (middleware → guard → service →
  repository) `tenantId` প্যারামিটার হিসেবে পাস করলে একটা জায়গায় ভুলে গেলেই leak-এর ঝুঁকি।
  `AsyncLocalStorage` পুরো async call chain-এ context নিজে থেকে বহন করে।
- `getStore()` এর টাইপ `TenantStore | undefined` — `if (!store)` এর পর TS সেটাকে `TenantStore`-এ
  narrow করে, তাই `store.tenantId` `string`, কোনো `!` লাগে না।
- `throw`, silent `undefined` না — tenant না থাকলে কোনো query চলাই উচিত না। Fail-loud ইচ্ছাকৃত।
  leak test-এর শেষ কেসটা ঠিক এই আচরণ যাচাই করে।
- `runWithTenant<T>` — store-এর shape (`{ tenantId }`) এক জায়গায় বাঁধা থাকে। Generic `T` দিয়ে
  callback যা রিটার্ন করে (sync মান বা `Promise`) সেটাই হুবহু বেরিয়ে আসে।

---

## ২.৫ — `withTenant()` helper

**ফাইল: `apps/api/src/common/tenant/with-tenant.ts`** (নতুন ফাইল)

```ts
import { sql } from 'drizzle-orm';
import type { Db } from '@omnivo/db';

import { getTenantId } from './tenant-context.js';

export type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

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

export type WithTenant = ReturnType<typeof createWithTenant>;
```

> ⚠️ কখনো `SET app.tenant_id = ...` লিখবেন না, সবসময় `set_config(..., true)` — `SET`
> PgBouncer-এর transaction pooling মোডে connection-এর মধ্যে leak করতে পারে।

**কোন লাইন কেন:**

- `import type { Db }` — এখানে শুধু টাইপ লাগে, runtime-এ `@omnivo/db` থেকে কিছু না। `type` import
  compile-এর পর মুছে যায়, আর ESLint-এর `consistent-type-imports` rule এটাই চায়। আগের খসড়ায় `db`
  singleton import ছিল, সেটা বাদ গেছে বলে এই ফাইল এখন কোনো global DB-র ওপর নির্ভর করে না।
- `type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0]` — `db.transaction(cb)`-এর
  `cb`-এর প্রথম প্যারামিটারের টাইপ বের করা। Drizzle-এর transaction টাইপ অনেক generic-ভরা আর
  ভার্সনে বদলায়; হাতে লিখলে drizzle আপডেট হলে চুপচাপ out-of-sync হয়ে যেত। `export` করা হয়েছে যাতে
  পরে repository ফাংশন `tx: Transaction` নিতে পারে।
- `createWithTenant(database: Db)` factory — `Db` বাইরে থেকে আসে: টেস্টে Testcontainers-এর DB, ধাপ
  ৩-এ Nest provider থেকে আসল DB।
- `const tenantId = getTenantId()` transaction শুরুর **আগে** — context না থাকলে DB connection না
  নিয়েই সঙ্গে সঙ্গে throw করে। ভেতরে রাখলে আগে একটা `BEGIN` পাঠিয়ে তারপর rollback করতে হতো।
- `database.transaction(...)` — `set_config` আর আসল query একই transaction-এ থাকতে হবে। আলাদা
  query-তে set করলে pool অন্য connection দিয়ে দিতে পারে, তখন setting এক connection-এ আর query
  অন্যটায়।
- `set_config(..., true)`-এর তৃতীয় আর্গুমেন্ট `is_local = true` — setting transaction শেষে নিজে
  মুছে যায়। **যাচাই করা হয়েছে:** `true`-কে `false` করে leak test চালালে ঠিক দুটো কেস fail করে —
  "context ছাড়া কিছু দেখা যায় না" আর "reused connection-এ setting থেকে যায় না"। অর্থাৎ টেস্ট
  স্যুট এই bug ধরতে পারে।
- `` sql`...${tenantId}` `` — drizzle-এর `sql` tag মানটাকে `$1` parameter হিসেবে পাঠায়, string-এ
  জোড়া লাগায় না, তাই SQL injection সম্ভব না।
- `WithTenant` টাইপ export — টেস্টে `let withTenant: WithTenant` লেখার জন্য, আবার
  `ReturnType<typeof createWithTenant>` না লিখে।

---

## ২.৬ — Middleware + Guard

**ফাইল: `apps/api/src/common/tenant/tenant.middleware.ts`** (নতুন ফাইল)

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';

import { runWithTenant } from './tenant-context.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  use(req: IncomingMessage, _res: ServerResponse, next: () => void): void {
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

**কোন লাইন কেন:**

- `IncomingMessage`/`ServerResponse` (`node:http`), `FastifyRequest` না — Nest Fastify adapter-এ
  middleware চালায় middie, যেটা Fastify-র wrapper না দিয়ে Node-এর raw request দেয়। `FastifyRequest`
  লিখলে টাইপ মিথ্যা বলত: `req.body`, `req.params`-এর মতো জিনিস টাইপে আছে কিন্তু runtime-এ নেই।
  বোনাস: `fastify` devDependency আর লাগে না।
- `type NestMiddleware` — interface শুধু টাইপ-চেকের জন্য, runtime-এ লাগে না।
- `UUID_RE` — header-এর যেকোনো স্ট্রিং tenant context-এ বসানো ঝুঁকিপূর্ণ। UUID শেপ যাচাই একটা
  sanity-check, authorization না (যেকোনো valid UUID পাঠালেই সেই tenant) — ধাপ ৩-এ JWT দিয়ে ঠিক হবে,
  TODO-তে সেটাই লেখা।
- `Array.isArray(header) ? header[0] : header` — `req.headers[...]`-এর টাইপ
  `string | string[] | undefined`। এর পর `tenantId`-এর টাইপ `string | undefined` (`header[0]`
  `noUncheckedIndexedAccess`-এর কারণে `string | undefined`)। `tenantId &&` এর পর সেটা `string`-এ
  narrow হয়, তাই `.test(tenantId)` টাইপ-নিরাপদ।
- `runWithTenant(tenantId, next)` — `next`-কে `run()`-এর ভেতর দিয়ে ডাকা হচ্ছে, যাতে বাকি request
  lifecycle (guard, handler, তার ভেতরের সব `await`) এই context পায়। **যাচাই করা হয়েছে:** Nest 12 +
  Fastify-তে context handler পর্যন্ত পৌঁছায়, handler-এর ভেতরের `await`-এর পরেও থাকে (২.৭-এর
  টেস্ট)।
- header না থাকলে বা ভুল হলে প্লেইন `next()` — `/health`-এর মতো পাবলিক রুট যেন block না হয়।
  enforce করবে `TenantGuard`, middleware না।

**ফাইল: `apps/api/src/common/tenant/tenant.guard.ts`** (নতুন ফাইল)

```ts
import { type CanActivate, ForbiddenException, Injectable } from '@nestjs/common';

import { tenantStorage } from './tenant-context.js';

@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(): boolean {
    if (!tenantStorage.getStore()) {
      throw new ForbiddenException('This route requires a tenant context (x-tenant-id header)');
    }
    return true;
  }
}
```

**কোন লাইন কেন:**

- `canActivate()` কোনো প্যারামিটার ছাড়া — আগের খসড়ায় `_context: ExecutionContext` ছিল কিন্তু
  ব্যবহার হতো না। TypeScript-এ কম প্যারামিটারের method interface-কে বৈধভাবে implement করে, তাই
  অব্যবহৃত import আর প্যারামিটার দুটোই বাদ।
- `tenantStorage.getStore()` সরাসরি, `getTenantId()` ধরে না — এখানে ক্লায়েন্টকে `403` দিতে হবে।
  `getTenantId()`-এর generic `Error` Nest-এ `500` হয়ে যেত, আর সেটা "সার্ভারের bug" বোঝায়, "তোমার
  request-এ tenant নেই" না।
- যেসব রুটে tenant বাধ্যতামূলক শুধু সেখানে `@UseGuards(TenantGuard)` বসবে।

**ফাইল: `apps/api/src/app.module.ts`** (আপডেট)

```ts
import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';

import { TenantMiddleware } from './common/tenant/tenant.middleware.js';
import { HealthController } from './health/health.controller.js';

@Module({
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('{*splat}');
  }
}
```

**কোন লাইন কেন:**

- `type MiddlewareConsumer`, `type NestModule` — দুটোই শুধু টাইপ; `Module` decorator runtime-এ লাগে
  বলে সেটা সাধারণ import।
- `'{*splat}'` — Nest 11+ path-to-regexp v8 ব্যবহার করে, যেখানে "সব রুট" লেখার ডকুমেন্টেড রূপ এটাই
  (`{...}` মানে root `/`-ও মিলবে)। Nest 12-এ পুরনো `'*'`-ও কাজ করে, কোনো warning দেয় না (যাচাই করা),
  তাই এটা bug fix না — ভবিষ্যতে legacy রূপ সরিয়ে দিলে যেন না ভাঙে।
- middleware সব রুটে — context পার্স করে বসায়, enforce করে না। নতুন রুটে guard বসাতে ভুলে গেলেও
  middleware চলবে, আর ধাপ ৩-এ JWT এলে শুধু এই একটা ফাইল বদলাতে হবে।

---

## ২.৭ — middleware থেকে handler পর্যন্ত টেস্ট (Docker লাগে না)

leak test শুধু `runWithTenant` সরাসরি ডেকে টেস্ট করে — "HTTP header → middleware → guard → handler"
পথটা কেউ টেস্ট করে না। এই টেস্ট সেই ফাঁক পূরণ করে।

**ফাইল: `apps/api/src/common/tenant/tenant.middleware.spec.ts`** (নতুন ফাইল)

```ts
import {
  Controller,
  Get,
  Module,
  type MiddlewareConsumer,
  type NestModule,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getTenantId } from './tenant-context.js';
import { TenantGuard } from './tenant.guard.js';
import { TenantMiddleware } from './tenant.middleware.js';

@Controller('probe')
class ProbeController {
  @Get()
  @UseGuards(TenantGuard)
  probe(): { tenantId: string } {
    return { tenantId: getTenantId() };
  }

  @Get('async')
  @UseGuards(TenantGuard)
  async probeAsync(): Promise<{ tenantId: string }> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { tenantId: getTenantId() };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('{*splat}');
  }
}

let app: NestFastifyApplication;

beforeAll(async () => {
  app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), {
    logger: false,
  });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app.close();
});

describe('TenantMiddleware + TenantGuard', () => {
  const tenantId = '0192f0c4-7b6e-7c1a-9d2e-3f4a5b6c7d8e';

  it('carries x-tenant-id into the handler through AsyncLocalStorage', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': tenantId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tenantId });
  });

  it('keeps the context across an await inside the handler', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe/async',
      headers: { 'x-tenant-id': tenantId },
    });
    expect(res.json()).toEqual({ tenantId });
  });

  it('rejects a request without a tenant with 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a malformed tenant id with 403', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-tenant-id': "x' OR 1=1" },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

**কোন লাইন কেন:**

- টেস্টের ভেতরে নিজস্ব `ProbeController`/`ProbeModule`, `AppModule` না — `AppModule`-এ এখনো কোনো
  tenant-guarded রুট নেই, আর ধাপ ৩-এ ওটায় DB provider যোগ হলে টেস্টে `DATABASE_URL` লাগত। ছোট
  module-এ শুধু যা টেস্ট হচ্ছে সেটুকুই থাকে।
- `probeAsync`-এর `setTimeout` — `AsyncLocalStorage`-এর আসল পরীক্ষা হলো `await`-এর পর context
  থাকে কিনা। sync handler-এ context থাকা প্রায় নিশ্চিত; timer-এর পর থাকাটাই প্রমাণ করে async
  propagation কাজ করছে।
- `logger: false` — টেস্ট আউটপুটে Nest-এর startup লগ না ভরানো।
- `await app.init()` তারপর `getInstance().ready()` — `init()` Nest-এর রুট আর middleware বসায়;
  `ready()` Fastify-র plugin লোড শেষ হওয়া পর্যন্ত অপেক্ষা করে। Fastify-তে টেস্টের জন্য Nest-এর
  ডকুমেন্টেশন এই দুই ধাপই বলে — plugin লোড অসম্পূর্ণ থাকলে `inject()` অসম্পূর্ণ app-এ চলতে পারে।
- `app.inject(...)` — Fastify-র বিল্ট-ইন in-memory HTTP। কোনো পোর্ট খোলে না, তাই CI-তে পোর্ট
  সংঘর্ষ বা `supertest`-এর মতো বাড়তি dependency লাগে না।
- `"x' OR 1=1"` কেস — `UUID_RE` যে injection-ধাঁচের ইনপুট কেটে দেয় আর guard তখন `403` দেয়, সেটা
  প্রমাণ করা।
- Decorator Vitest-এ কাজ করে কিনা — **যাচাই করা হয়েছে**, এই টেস্ট বাড়তি কোনো plugin (যেমন
  `unplugin-swc`) ছাড়াই পাস করে। ধাপ ৩-এ constructor
  injection (`emitDecoratorMetadata`-নির্ভর) টেস্টে এলে আবার দেখে নিতে হবে।

---

## ২.৮ — Testcontainers দিয়ে leak test (এই ধাপের মূল লক্ষ্য)

**ফাইল: `apps/api/src/common/tenant/tenant-leak.int.spec.ts`** (নতুন ফাইল)

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db, memberships, tenants, users } from '@omnivo/db';

import { runWithTenant } from './tenant-context.js';
import { createWithTenant, type WithTenant } from './with-tenant.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

let container: StartedPostgreSqlContainer;
let appDb: Db;
let withTenant: WithTenant;
let tenantAId: string;
let tenantBId: string;

async function seedTenant(slug: string): Promise<string> {
  const [tenant] = await appDb.insert(tenants).values({ name: slug, slug }).returning();
  const [user] = await appDb
    .insert(users)
    .values({ email: `${slug}@example.com`, fullName: slug })
    .returning();
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

  // superuser URL থেকে বাকি দুই role-এর URL বানানো — host/port হাতে জোড়া লাগাতে হয় না
  const urlFor = (username: string, password: string): string => {
    const url = new URL(container.getConnectionUri());
    url.username = username;
    url.password = password;
    return url.toString();
  };

  const admin = postgres(container.getConnectionUri(), { max: 1 });
  await admin.unsafe(
    readFileSync(path.join(repoRoot, 'infra/docker/postgres/init/01-roles.sql'), 'utf-8'),
  );
  await admin.end();

  const migratorClient = postgres(urlFor('omnivo_migrator', 'migrator_dev_password'), { max: 1 });
  await migrate(drizzle(migratorClient), {
    migrationsFolder: path.join(repoRoot, 'packages/db/migrations'),
  });
  await migratorClient.end();

  appDb = createDb(urlFor('omnivo_app', 'app_dev_password'), { max: 1 });
  withTenant = createWithTenant(appDb);

  tenantAId = await seedTenant('tenant-a');
  tenantBId = await seedTenant('tenant-b');
}, 120_000);

afterAll(async () => {
  await appDb.$client.end();
  await container.stop();
});

describe('tenant isolation (RLS)', () => {
  it('tenant A cannot read tenant B rows, even when explicitly filtering by B', async () => {
    const leaked = await runWithTenant(tenantAId, () =>
      withTenant((tx) => tx.select().from(memberships).where(eq(memberships.tenantId, tenantBId))),
    );
    expect(leaked).toHaveLength(0);
  });

  it('tenant A sees exactly its own rows', async () => {
    const own = await runWithTenant(tenantAId, () =>
      withTenant((tx) => tx.select().from(memberships)),
    );
    expect(own).toHaveLength(1);
    expect(own[0]?.tenantId).toBe(tenantAId);
  });

  it('without a tenant context the app role sees nothing', async () => {
    const rows = await appDb.select().from(memberships);
    expect(rows).toHaveLength(0);
  });

  it('tenant A cannot write a row for tenant B', async () => {
    const [userRow] = await appDb.select().from(users).limit(1);
    if (!userRow) throw new Error('no user');
    await expect(
      runWithTenant(tenantAId, () =>
        withTenant(async (tx) => {
          await tx.insert(memberships).values({ tenantId: tenantBId, userId: userRow.id });
        }),
      ),
    ).rejects.toThrow();
  });

  it('the tenant setting does not survive the transaction on a reused connection', async () => {
    await runWithTenant(tenantAId, () => withTenant((tx) => tx.select().from(memberships)));
    const rows = await appDb.select().from(memberships);
    expect(rows).toHaveLength(0);
  });

  it('withTenant fails loudly outside a tenant context', async () => {
    await expect(withTenant((tx) => tx.select().from(memberships))).rejects.toThrow(
      /No tenant context/,
    );
  });
});
```

**কোন লাইন কেন:**

- ফাইলের নাম `.int.spec.ts` — ২.৩-এর script এই suffix দেখেই ঠিক করে কোন টেস্ট Docker চায়।
- Mock DB না, আসল Postgres — tenant isolation-এর গ্যারান্টি আসে Postgres RLS policy থেকে; mock সেই
  policy বোঝেই না, ভুল policy থাকলেও mock টেস্ট পাস করত।
- `repoRoot` = পাঁচ ধাপ উপরে — `tenant` → `common` → `src` → `api` → `apps` → root। Vitest source
  ফাইল থেকেই চালায় (dist না), তাই `src`-ভিত্তিক গণনা।
- `seedTenant`-এ `tenants`/`users` insert `appDb` দিয়ে সরাসরি, context ছাড়া — এই দুই টেবিল global,
  এগুলোতে RLS নেই। কিন্তু `memberships`-এ `FORCE RLS` + `WITH CHECK` আছে, তাই সেই insert
  `runWithTenant` + `withTenant`-এর ভেতরে; নাহলে policy insert আটকে দিত।
- `const [tenant] = ...` তারপর `if (!tenant || !user) throw` — `noUncheckedIndexedAccess`-এর কারণে
  destructure করা মান `T | undefined`। throw-এর পর TS দুটোকেই narrow করে, `!` লাগে না।
- দুই tenant একবার `beforeAll`-এ seed — আগের খসড়ায় টেস্টের ভেতরে seed হতো, তাহলে দ্বিতীয় টেস্ট
  চালালে একই `slug`/`email`-এ unique constraint ভাঙত। এখন সব টেস্ট একই শুরুর ডেটা দেখে।
- `urlFor` + `container.getConnectionUri()` — আগে `` `postgres://...@${host}:${port}/omnivo` ``
  লেখা ছিল; `port` একটা `number`, আর ESLint-এর `restrict-template-expressions` সেটা আটকায়।
  `URL` object-এ শুধু username/password বদলালে host, port, database container থেকেই আসে, আর password-এ
  বিশেষ অক্ষর থাকলেও `URL` সঠিকভাবে encode করে।
- তিনটা আলাদা role, প্রতিটা আলাদা জিনিস প্রমাণ করতে:
  - `postgres` superuser দিয়ে `01-roles.sql` — docker-compose যে script চালায় হুবহু সেটাই, তাই
    টেস্ট আর dev environment-এর role setup কখনো আলাদা হয় না।
  - `omnivo_migrator` দিয়ে migration — আসল `packages/db/migrations` ফোল্ডার থেকে, তাই RLS policy-র
    যেকোনো ভুল migration এই টেস্টেই ধরা পড়ে।
  - `omnivo_app` দিয়ে সব assertion — `NOBYPASSRLS` role। superuser দিয়ে চালালে RLS bypass হতো আর
    টেস্ট মিথ্যাভাবে পাস করত। **এটাই এই ফাইলের সবচেয়ে গুরুত্বপূর্ণ লাইন।**
- `createDb(..., { max: 1 })` — pool-এ একটাই connection, তাই "reused connection" টেস্ট নিশ্চিতভাবে
  আগের transaction-এর connection-টাই পায়। (২.১-এ `CreateDbOptions` যোগ করার কারণ এটাই।)
- `afterAll`-এ `appDb.$client.end()` container বন্ধের **আগে** — pool খোলা থাকলে Vitest open handle-এর
  জন্য ঝুলে থাকতে পারে, আর আগে container বন্ধ করলে খোলা connection-গুলো হঠাৎ কেটে যায় — ক্রমটা
  উল্টালে পরিষ্কার শাটডাউন হয় না।
  `$client` drizzle-এর নিজস্ব property, postgres.js client-টা দেয় — `Db` টাইপেই আছে, cast লাগে না।
- `120_000` ms timeout — প্রথম রানে `postgres:17-alpine` ইমেজ pull হয়; Vitest-এর ডিফল্ট ১০ সেকেন্ডে
  কুলাবে না।
- ছয়টা কেস, প্রতিটা আলাদা ঝুঁকি ধরে:
  1. **B-র id দিয়ে explicit filter → ০ রো** — সবচেয়ে খারাপ অবস্থা: অ্যাপ কোডে bug থাকলেও (ভুল
     tenant-এর id দিয়ে filter), RLS শেষ প্রতিরক্ষা হিসেবে ডেটা আটকায়।
  2. **নিজের রো ঠিক ১টা, আর সেটা A-র** — policy যেন সব কিছু লুকিয়ে না ফেলে (over-blocking)। ১ আর
     ২ মিলে প্রমাণ করে policy ঠিক tenant-scoped।
  3. **context ছাড়া ০ রো** — `omnivo_app` যেন tenant setting ছাড়া কিছুই না দেখে।
  4. **A-র context-এ B-র জন্য insert → reject** — policy-র `WITH CHECK` অংশ কাজ করছে; শুধু পড়া না,
     লেখাও আটকানো।
  5. **একই connection-এ আগের transaction-এর setting থাকে না** — `set_config(..., true)`-এর আসল
     প্রমাণ, PgBouncer-ধরনের leak-এর বিরুদ্ধে। `false` দিয়ে mutation-test করে দেখা হয়েছে যে ৩ আর ৫
     fail করে।
  6. **context ছাড়া `withTenant` → `No tenant context` error** — fail-loud আচরণ বজায় আছে।

---

## ২.৯ — রান করুন

```bash
pnpm install                 # ২.০-এর পর lockfile আপডেট
pnpm typecheck               # turbo আগে @omnivo/db build করবে
pnpm test                    # middleware টেস্ট — Docker লাগে না
pnpm test:tenant-leak        # Docker Desktop চালু থাকতে হবে
```

(প্রথম রানে `postgres:17-alpine` ইমেজ pull হবে — একটু সময় লাগবে। Testcontainers নিজেই Docker
ব্যবহার করে, তাই `pnpm db:up` লাগবে না — এটা নিজের আলাদা container তোলে আর শেষে মুছে ফেলে।)

---

## যাচাইয়ের তালিকা

```bash
pnpm lint
pnpm format
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:tenant-leak
pnpm build
pnpm boundaries
```

সব পাস করলে, ম্যানুয়ালি `curl` দিয়েও দেখতে পারেন:

```bash
pnpm dev   # আরেক টার্মিনালে
curl http://localhost:3000/health -H "x-tenant-id: $(node -e 'console.log(crypto.randomUUID())')"
# → {"status":"ok"}
```

শেষে [build-plan.bn.md](build-plan.bn.md)-এর "৯. অগ্রগতি"-তে ধাপ ২ টিক দিন।

## ধাপ ৩-এর জন্য রেখে যাওয়া নোট

- API-র আসল DB: একটা Nest provider (`DB` token) যেটা `createDb(requireEnv('DATABASE_URL'))` তৈরি
  করবে আর `onModuleDestroy`-এ `$client.end()` ডাকবে; `withTenant` সেখান থেকে
  `createWithTenant(db)` দিয়ে inject হবে। Constructor injection-এ `Db` যেহেতু type-only, তাই
  `@Inject(DB)` দিয়ে token দিতে হবে — `emitDecoratorMetadata` interface/type থেকে টোকেন বের করতে পারে না।
- `tenants` আর `users` টেবিলে RLS নেই — `omnivo_app` সব ইউজারের `password_hash` পড়তে পারে। auth-এর
  আগে ঠিক করতে হবে: RLS policy (`app.user_id` দিয়ে), column-level `GRANT`, নাকি auth-এর জন্য আলাদা
  role।
- `TenantMiddleware`-এর header-ভিত্তিক tenant সরিয়ে JWT claim।
