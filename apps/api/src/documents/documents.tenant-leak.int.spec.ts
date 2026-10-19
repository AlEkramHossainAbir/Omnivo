import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createdShareSchema,
  customerSchema,
  documentEmailListSchema,
  documentFileSchema,
  documentShareListSchema,
  invoiceSchema,
  productSchema,
  publicDocumentSchema,
  setupSchema,
  taxRateListSchema,
  unitListSchema,
  warehouseListSchema,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
import { hashShareToken } from './share-token.js';

// Step 16's eight routes take a document's id in the path; the public route takes only a token.
// Tenant A, signed in with every permission of its own workspace, tries each of them on tenant
// B's invoice. Every answer must be a 404 or an empty list, never B's file, email, link or
// customer. The worker has no storage and no mail server: B's rows end up failed, which is all
// these tests need.
let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantA: SignedIn;
let tenantB: SignedIn;
let invoiceOfB: string;
let fileOfB: string;
let shareOfB: string;
let tokenOfB: string;

function as(who: SignedIn | null, method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({
    method,
    url,
    ...(who && { headers: bearer(who.accessToken) }),
    ...(payload && { payload }),
  });
}

// The body of a 201, or the failure with the API's own answer
function created(res: Awaited<ReturnType<typeof as>>): unknown {
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
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
  tenantA = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  tenantB = await signUp(app, {
    companyName: 'Karim Pharma',
    workspaceSlug: 'karim-pharma',
    fullName: 'Karim Uddin',
    email: 'karim@karimpharma.com',
    password: 'Batch-expiry-2026',
  });
  // A medicine distributor: the pharma preset would ask every product for its generic name
  expect((await as(tenantB, 'POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await as(tenantB, 'GET', '/setup')).json()).status).toBe('ready');
  });

  // B's invoice: a service, so no stock is needed, to a customer with an email and a phone
  const [pcs] = unitListSchema
    .parse((await as(tenantB, 'GET', '/units')).json())
    .items.filter((unit) => unit.code === 'pcs');
  const [rate] = taxRateListSchema.parse((await as(tenantB, 'GET', '/tax-rates')).json()).items;
  const [warehouse] = warehouseListSchema.parse(
    (await as(tenantB, 'GET', '/warehouses')).json(),
  ).items;
  if (!pcs || !rate || !warehouse) throw new Error('setup made no unit, VAT rate or warehouse');
  const service = productSchema.parse(
    created(
      await as(tenantB, 'POST', '/products', {
        code: '',
        name: 'Cold chain delivery',
        type: 'service',
        categoryId: '',
        description: '',
        baseUnitId: pcs.id,
        salesUnitId: '',
        purchaseUnitId: '',
        tracking: 'none',
        hasExpiry: false,
        taxRateId: '',
        options: [],
        variants: [
          { id: null, sku: '', optionValues: [], barcode: '', salePrice: '', archived: false },
        ],
        units: [],
        customFields: {},
      }),
    ),
  );
  const customer = customerSchema.parse(
    created(
      await as(tenantB, 'POST', '/customers', {
        code: '',
        name: 'Lazz Pharma, Kalabagan',
        groupId: '',
        contactPerson: '',
        phone: '01819-223344',
        email: 'purchase@lazzpharma.com',
        documentLanguage: 'en',
        bin: '',
        paymentTermsDays: 30,
        creditLimit: '',
        priceListId: '',
        notes: '',
        addresses: [],
      }),
    ),
  );
  const invoice = await as(tenantB, 'POST', '/invoices', {
    customerId: customer.id,
    date: '2026-10-06',
    dueDate: '',
    customerReference: '',
    branchId: warehouse.branchId,
    warehouseId: '',
    note: '',
    lines: [
      {
        variantId: service.variants[0]?.id,
        unitId: pcs.id,
        quantity: '1',
        description: '',
        unitPrice: '1500',
        discountType: 'percent',
        discount: '',
        taxRateId: rate.id,
        deliveryLineId: '',
        orderLineId: '',
        batchId: '',
        serialNumbers: [],
      },
    ],
    post: true,
  });
  expect(invoice.statusCode, invoice.body).toBe(201);
  invoiceOfB = invoiceSchema.parse(invoice.json()).id;

  // B's own file, email and link of that invoice, made through the API
  const path = `/documents/invoice/${invoiceOfB}`;
  fileOfB = documentFileSchema.parse(
    (await as(tenantB, 'POST', `${path}/files`, { language: 'en' })).json(),
  ).id;
  const email = await as(tenantB, 'POST', `${path}/emails`, {
    to: 'purchase@lazzpharma.com',
    cc: '',
    subject: 'Invoice',
    message: '',
    language: 'en',
  });
  expect(email.statusCode, email.body).toBe(201);
  const share = createdShareSchema.parse(
    created(await as(tenantB, 'POST', `${path}/shares`, { language: 'en' })),
  );
  shareOfB = share.share.id;
  tokenOfB = share.url.slice(share.url.lastIndexOf('/') + 1);
}, 180_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe("tenant A can't reach tenant B's documents", () => {
  it("answers 404 for every route that names B's invoice", async () => {
    const path = `/documents/invoice/${invoiceOfB}`;
    const attempts = [
      as(tenantA, 'POST', `${path}/files`, { language: 'en' }),
      as(tenantA, 'GET', `${path}/files/${fileOfB}`),
      as(tenantA, 'GET', `${path}/email-draft?language=en`),
      as(tenantA, 'POST', `${path}/emails`, {
        to: 'someone@rahmangarments.com',
        cc: '',
        subject: 'Invoice',
        message: '',
        language: 'en',
      }),
      as(tenantA, 'POST', `${path}/shares`, { language: 'en' }),
      as(tenantA, 'POST', `${path}/shares/${shareOfB}/revoke`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode, res.body).toBe(404);
    }
    // The link still works: A's revoke changed nothing
    expect((await as(null, 'GET', `/public/documents/${tokenOfB}`)).statusCode).toBe(200);
  });

  it("lists none of B's emails or links", async () => {
    const path = `/documents/invoice/${invoiceOfB}`;
    const emails = documentEmailListSchema.parse(
      (await as(tenantA, 'GET', `${path}/emails`)).json(),
    );
    expect(emails.items).toEqual([]);
    const shares = documentShareListSchema.parse(
      (await as(tenantA, 'GET', `${path}/shares`)).json(),
    );
    expect(shares.items).toEqual([]);
    // B sees its own, so they were really there
    const own = documentShareListSchema.parse((await as(tenantB, 'GET', `${path}/shares`)).json());
    expect(own.items.map((item) => item.id)).toEqual([shareOfB]);
  });

  it("shows only B's own invoice behind B's link, whoever opens it", async () => {
    const page = publicDocumentSchema.parse(
      (await as(tenantA, 'GET', `/public/documents/${tokenOfB}`)).json(),
    );
    expect([page.company, page.recipient]).toEqual(['Karim Pharma', 'Lazz Pharma, Kalabagan']);
  });
});

describe('the share_by_token policy', () => {
  it('shows one link, only to someone who holds its token, and never for writing', async () => {
    // As omnivo_app (NOBYPASSRLS) with no tenant context: exactly where the public lookup starts
    const appDb = postgres(pg.appUrl, { max: 1 });
    try {
      expect(await appDb`SELECT id FROM document_shares`).toHaveLength(0);
      await appDb.begin(async (tx) => {
        await tx`SELECT set_config('app.share_token_hash', ${hashShareToken(tokenOfB)}, true)`;
        const visible = await tx<{ id: string }[]>`SELECT id FROM document_shares`;
        expect(visible.map((row) => row.id)).toEqual([shareOfB]);
        // The policy is for SELECT only: the opening is stamped later, in the link's tenant
        const updated = await tx`UPDATE document_shares SET revoked_at = now()`;
        expect(updated.count).toBe(0);
        // The token shows the link, nothing else of B's
        expect(await tx`SELECT id FROM document_files`).toHaveLength(0);
        expect(await tx`SELECT id FROM document_emails`).toHaveLength(0);
      });
      // A wrong token shows nothing; an empty one neither (NULLIF in the policy)
      for (const hash of [hashShareToken('AAAAAAAAAAAAAAAAAAAAAA'), '']) {
        await appDb.begin(async (tx) => {
          await tx`SELECT set_config('app.share_token_hash', ${hash}, true)`;
          expect(await tx`SELECT id FROM document_shares`).toHaveLength(0);
        });
      }
    } finally {
      await appDb.end();
    }
  });
});
