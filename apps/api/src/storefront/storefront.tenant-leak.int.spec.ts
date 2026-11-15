import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  productPageSchema,
  setupSchema,
  shopCartQuoteSchema,
  shopCategorySchema,
  shopHomeSchema,
  shopListingPageSchema,
  shopProductPageSchema,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
import type { Db } from '@omnivo/db';
import { sql as drizzleSql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { Transaction } from '../common/tenant/with-tenant.js';
import { DB } from '../infra/tokens.js';
import {
  createTestApp,
  createTestWorker,
  eventually,
  testConfig,
  testWorkerConfig,
} from '../testing/app.js';
import {
  startPostgres,
  startRedis,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import {
  addCategory,
  addListing,
  createProduct,
  insertedId,
  launchShop,
  tenantIdOf,
} from '../testing/storefront.js';
import { ShopDb } from './shop-db.js';

// Step 26f: the public API reads without a login, by the host alone, so a mistake here would show
// one workspace's shop to every stranger. Two launched shops, Nirvor and Acme, that use the same
// slugs on purpose: a host must only ever see its own shop. Then the database's own walls: the
// omnivo_public role reads nothing of the ERP beyond a card's columns, even through a query the
// API would never write, and the pooled connection is omnivo_app again after every request.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let sql: postgres.Sql;
let nirvor: SignedIn;
let acme: SignedIn;
let nirvorId: string;
let acmeId: string;
let acmeTeaId: string;
let acmeOnlyId: string;

const NIRVOR = 'nirvor.localhost';
const ACME = 'acme.localhost';

function get(host: string, url: string) {
  return app.inject({ method: 'GET', url, headers: { 'x-shop-host': host } });
}

// drizzle wraps the driver's error (DrizzleQueryError); Postgres's own code is on a .cause
function pgCodeOf(error: unknown): string | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') return current.code;
  }
  return null;
}

async function workspace(who: SignedIn, slug: string, name: string) {
  const auth = { headers: bearer(who.accessToken) };
  expect(
    (await app.inject({ method: 'POST', url: '/setup', payload: { industry: 'retail' }, ...auth }))
      .statusCode,
  ).toBe(200);
  await eventually(async () => {
    const setup = await app.inject({ method: 'GET', url: '/setup', ...auth });
    expect(setupSchema.parse(setup.json()).status).toBe('ready');
  });
  const warehouses = await app.inject({ method: 'GET', url: '/warehouses', ...auth });
  const warehouseId = warehouseListSchema.parse(warehouses.json()).items[0]?.id ?? '';
  const units = await app.inject({ method: 'GET', url: '/units', ...auth });
  const pcs =
    unitListSchema.parse(units.json()).items.find((unit) => unit.code === 'pcs')?.id ?? '';
  const tenantId = await tenantIdOf(sql, slug);
  await launchShop(sql, { tenantId, subdomain: slug, name, warehouseId });
  // The same category slug in both shops
  const beverages = await addCategory(sql, tenantId, { slug: 'beverages', name: `${name} drinks` });
  const tea = await createProduct(app, who, pcs, `${name} Green Tea`, '120');
  await sql`
    INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, quantity)
    VALUES (${tenantId}, ${warehouseId}, ${tea.id}, ${tea.variants[0]?.id ?? ''}, 5)`;
  // …and the same listing slug
  const teaId = await addListing(sql, tenantId, {
    product: tea,
    categoryId: beverages,
    slug: 'green-tea',
  });
  // A product the shop does not list: the ERP must still see it (INHERIT FALSE)
  await createProduct(app, who, pcs, `${name} Office Paper`, '450');
  return { tenantId, pcs, teaId };
}

beforeAll(async () => {
  [pg, redis] = await Promise.all([startPostgres(), startRedis()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
    }),
  );
  sql = postgres(pg.superuserUrl, { max: 2 });
  nirvor = await signUp(app, {
    companyName: 'Nirvor Pharmacy',
    workspaceSlug: 'nirvor',
    fullName: 'Nusrat Jahan',
    email: 'nusrat@nirvor.com',
    password: 'Nirvor-pharmacy-2026',
  });
  acme = await signUp(app, {
    companyName: 'Acme Distribution',
    workspaceSlug: 'acme',
    fullName: 'Farhan Ahmed',
    email: 'farhan@acme.com.bd',
    password: 'Acme-distribution-2026',
  });
  const a = await workspace(nirvor, 'nirvor', 'Nirvor');
  const b = await workspace(acme, 'acme', 'Acme');
  nirvorId = a.tenantId;
  acmeId = b.tenantId;
  acmeTeaId = b.teaId;

  // What only Acme has: a category, a listing in it, a text page, a draft, and a home row
  const acmeOnly = await addCategory(sql, acmeId, { slug: 'acme-only', name: 'Acme only' });
  const soap = await createProduct(app, acme, b.pcs, 'Acme Soap', '60');
  acmeOnlyId = await addListing(sql, acmeId, {
    product: soap,
    categoryId: acmeOnly,
    slug: 'acme-soap',
  });
  // The soap's stock is in a second warehouse, not the shop's
  const factory = insertedId(
    await sql`
      INSERT INTO warehouses (id, tenant_id, branch_id, code, name)
      SELECT gen_random_uuid(), tenant_id, branch_id, 'FACTORY', 'Factory store'
        FROM warehouses WHERE tenant_id = ${acmeId} LIMIT 1
      RETURNING id::text`,
  );
  await sql`
    INSERT INTO stock_balances (tenant_id, warehouse_id, product_id, variant_id, quantity)
    VALUES (${acmeId}, ${factory}, ${soap.id}, ${soap.variants[0]?.id ?? ''}, 7)`;
  const draft = await createProduct(app, acme, b.pcs, 'Acme Draft', '60');
  await addListing(sql, acmeId, {
    product: draft,
    categoryId: acmeOnly,
    slug: 'acme-draft',
    publishedDaysAgo: null,
  });
  await sql`
    INSERT INTO storefront_pages (tenant_id, slug, sections)
    VALUES (${acmeId}, 'about', ${sql.json([{ heading: 'About Acme', body: 'Since 1998.' }])})`;
  const picks = insertedId(
    await sql`
      INSERT INTO storefront_collections (id, tenant_id, title)
      VALUES (gen_random_uuid(), ${acmeId}, 'Acme picks') RETURNING id::text`,
  );
  await sql`
    INSERT INTO storefront_collection_items (tenant_id, collection_id, listing_id, position)
    VALUES (${acmeId}, ${picks}, ${acmeOnlyId}, 1)`;
  await sql`
    INSERT INTO storefront_home_blocks (tenant_id, position, collection_id)
    VALUES (${acmeId}, 1, ${picks})`;
}, 240_000);

afterAll(async () => {
  await sql.end();
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('one host, one shop', () => {
  it('answers each shop its own listing for the same slug', async () => {
    const mine = shopProductPageSchema.parse(
      (await get(NIRVOR, '/public/v1/products/green-tea')).json(),
    );
    const theirs = shopProductPageSchema.parse(
      (await get(ACME, '/public/v1/products/green-tea')).json(),
    );
    expect(mine.product.name).toBe('Nirvor Green Tea');
    expect(theirs.product.name).toBe('Acme Green Tea');
    expect(mine.product.id).not.toBe(theirs.product.id);
  });

  it('never lists, finds or links the other shop', async () => {
    const all = shopListingPageSchema.parse((await get(NIRVOR, '/public/v1/listings')).json());
    expect(all.items.map((card) => card.name)).toEqual(['Nirvor Green Tea']);
    // Acme's words find nothing in Nirvor's shop
    const search = shopListingPageSchema.parse(
      (await get(NIRVOR, '/public/v1/listings?q=acme')).json(),
    );
    expect(search.items).toEqual([]);
    // Acme's category slug is an unknown category here: an empty page, not Acme's cards
    const category = shopListingPageSchema.parse(
      (await get(NIRVOR, '/public/v1/listings?category=acme-only')).json(),
    );
    expect(category.items).toEqual([]);
    const tree = z
      .array(shopCategorySchema)
      .parse((await get(NIRVOR, '/public/v1/categories')).json());
    expect(tree.map((one) => one.name)).toEqual(['Nirvor drinks']);
    expect((await get(NIRVOR, '/public/v1/products/acme-soap')).statusCode).toBe(404);
    // Acme wrote an About page; Nirvor did not
    expect((await get(ACME, '/public/v1/pages/about')).statusCode).toBe(200);
    expect((await get(NIRVOR, '/public/v1/pages/about')).statusCode).toBe(404);
    const home = shopHomeSchema.parse((await get(NIRVOR, '/public/v1/home')).json());
    expect(home.blocks).toEqual([]);
    expect(home.featured.map((card) => card.name)).toEqual(['Nirvor Green Tea']);
  });

  it('quotes the other shop listings as unavailable', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/v1/cart/quote',
      headers: { 'x-shop-host': NIRVOR },
      payload: {
        lines: [
          { listingId: acmeTeaId, quantity: 1 },
          { listingId: acmeOnlyId, quantity: 1 },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const quote = shopCartQuoteSchema.parse(res.json());
    expect(quote.lines.map((line) => line.status)).toEqual(['unavailable', 'unavailable']);
    expect(quote.subtotal).toBe('0.0000');
  });
});

describe('the omnivo_public role', () => {
  // ShopDb.read is the API's own way in: SET LOCAL ROLE omnivo_public, Nirvor's workspace. The
  // queries below are ones the public API never writes, as a bug might
  function asShop<T>(query: (tx: Transaction) => Promise<T>, host = NIRVOR): Promise<T> {
    return app.get(ShopDb).read(host, (tx) => query(tx));
  }

  it('cannot read the ERP tables or columns a card does not need', async () => {
    const forbidden = [
      // Customers and suppliers (step 15a's parties), their invoices, the books
      drizzleSql`SELECT count(*) FROM parties`,
      drizzleSql`SELECT count(*) FROM invoices`,
      drizzleSql`SELECT count(*) FROM journal_entries`,
      // product_variants: the SKU and price are granted, the barcode and options are not
      drizzleSql`SELECT option_values FROM product_variants`,
      drizzleSql`SELECT * FROM products`,
      // stock_balances: only whether there is any, never what it is worth
      drizzleSql`SELECT batch_id FROM stock_balances`,
    ];
    for (const query of forbidden) {
      const error = await asShop((tx) => tx.execute(query)).catch((caught: unknown) => caught);
      // 42501 = insufficient_privilege ("permission denied")
      expect(pgCodeOf(error)).toBe('42501');
    }
  });

  it('writes nothing, even to the shop own tables', async () => {
    const error = await asShop((tx) =>
      tx.execute(drizzleSql`UPDATE storefront_listings SET name = 'Hacked'`),
    ).catch((caught: unknown) => caught);
    // 25006 = read_only_sql_transaction: READ ONLY answers before the missing grant does
    expect(pgCodeOf(error)).toBe('25006');
  });

  // In Acme's shop, which has a draft and stock in a second warehouse
  it('sees only the published listings, the variants they sell and the shop stock', async () => {
    const counts = await asShop(
      async (tx) =>
        z.array(z.object({ listings: z.number(), variants: z.number(), stock: z.number() })).parse(
          await tx.execute(drizzleSql`
            SELECT (SELECT count(*)::int FROM storefront_listings) AS listings,
                   (SELECT count(*)::int FROM product_variants) AS variants,
                   (SELECT count(*)::int FROM stock_balances) AS stock`),
        ),
      ACME,
    );
    // Four products: the tea and the soap are published, the draft is not, the paper is not
    // listed. Stock: the tea's in the shop's warehouse; the soap's is in the factory store
    expect(counts).toEqual([{ listings: 2, variants: 2, stock: 1 }]);
  });

  // Straight in the database, without the API: the role alone, as the superuser becomes it
  it('sees no shop at all without a workspace, and none of a shop not launched', async () => {
    const count = (rows: unknown) => z.array(z.object({ n: z.number() })).parse(rows)[0]?.n;
    const unset = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE omnivo_public`;
      return count(await tx`SELECT count(*)::int AS n FROM storefront_listings`);
    });
    expect(unset).toBe(0);
    // The same query with Nirvor's workspace finds its one listing: the zero above is the wall,
    // not a query that can find nothing
    const own = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE omnivo_public`;
      await tx`SELECT set_config('app.tenant_id', ${nirvorId}, true)`;
      return count(await tx`SELECT count(*)::int AS n FROM storefront_listings`);
    });
    expect(own).toBe(1);
    try {
      await sql`UPDATE storefront_settings SET launched_at = NULL WHERE tenant_id = ${acmeId}`;
      const closed = await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE omnivo_public`;
        await tx`SELECT set_config('app.tenant_id', ${acmeId}, true)`;
        return count(
          await tx`
          SELECT (SELECT count(*) FROM storefront_listings)::int
               + (SELECT count(*) FROM storefront_pages)::int
               + (SELECT count(*) FROM product_variants)::int AS n`,
        );
      });
      // A bug that set Acme's workspace still finds nothing while Acme's shop is closed
      expect(closed).toBe(0);
    } finally {
      await sql`UPDATE storefront_settings SET launched_at = now() WHERE tenant_id = ${acmeId}`;
    }
    // The lookup function answers a launched shop's id, and only that
    const lookup = await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE omnivo_public`;
      return z
        .array(z.object({ id: z.string().nullable() }))
        .parse(await tx`SELECT storefront_tenant_for_subdomain('acme')::text AS id`);
    });
    expect(lookup).toEqual([{ id: acmeId }]);
  });

  it('leaves the pooled connections as omnivo_app with no workspace', async () => {
    // Public requests, one of them failing mid-transaction
    await asShop((tx) => tx.execute(drizzleSql`SELECT count(*) FROM parties`)).catch(() => null);
    await Promise.all(Array.from({ length: 6 }, () => get(NIRVOR, '/public/v1/listings')));
    const db = app.get<symbol, Db>(DB);
    // In parallel, so they take different connections of the pool
    const rows = await Promise.all(
      Array.from({ length: 8 }, async () =>
        z
          .array(z.object({ who: z.string(), tenant: z.string().nullable() }))
          .parse(
            await db.execute(
              drizzleSql`SELECT current_user AS who, nullif(current_setting('app.tenant_id', true), '') AS tenant`,
            ),
          ),
      ),
    );
    expect(rows.flat()).toEqual(
      Array.from({ length: 8 }, () => ({ who: 'omnivo_app', tenant: null })),
    );
  });

  it('does not hide the products the shop does not list from the ERP', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/products',
      headers: bearer(nirvor.accessToken),
    });
    expect(res.statusCode, res.body).toBe(200);
    // The restrictive policies are for omnivo_public only: the ERP sees both products
    expect(
      productPageSchema
        .parse(res.json())
        .items.map((item) => item.name)
        .sort(),
    ).toEqual(['Nirvor Green Tea', 'Nirvor Office Paper']);
  });
});
