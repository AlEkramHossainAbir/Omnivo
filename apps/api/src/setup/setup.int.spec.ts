import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  accountListSchema,
  auditPageSchema,
  meResponseSchema,
  notificationPageSchema,
  problemSchema,
  roleListSchema,
  setupSchema,
  stockAccountsSchema,
  taxRateListSchema,
  unitListSchema,
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
  startMail,
  startPostgres,
  startRedis,
  type TestMail,
  type TestPostgres,
  type TestRedis,
} from '../testing/containers.js';
import { bearer, type SignedIn, signUp } from '../testing/http.js';
import { accountCount, catalogCount } from '../testing/chart.js';
import { lastMailTo } from '../testing/mailpit.js';
import { INDUSTRY_TEMPLATES, TAX_RATES } from './templates.js';

const GARMENTS_ACCOUNTS = accountCount(INDUSTRY_TEMPLATES.garments.chart);
const GARMENTS_CATALOG = catalogCount(INDUSTRY_TEMPLATES.garments.catalog);

let pg: TestPostgres;
let redis: TestRedis;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;

beforeAll(async () => {
  [pg, redis, mail] = await Promise.all([startPostgres(), startRedis(), startMail()]);
  app = await createTestApp(testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url }));
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      mailUrl: mail.smtpUrl,
    }),
  );
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop(), mail.container.stop()]);
});

function send(method: 'GET' | 'POST', url: string, payload?: object, as: SignedIn = owner) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

async function setup(as: SignedIn = owner) {
  return setupSchema.parse((await send('GET', '/setup', undefined, as)).json());
}

async function superuserSql(fn: (sql: postgres.Sql) => Promise<unknown>): Promise<void> {
  const sql = postgres(pg.superuserUrl, { max: 1 });
  try {
    await fn(sql);
  } finally {
    await sql.end();
  }
}

async function unpublished(expected: number): Promise<void> {
  await superuserSql(async (sql) => {
    const [row] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL`;
    expect(row?.n).toBe(expected);
  });
}

describe('sign-up', () => {
  it('leaves a new workspace pending, so the app opens the wizard', async () => {
    expect(await setup()).toEqual({ status: 'pending', industry: null });
    const me = meResponseSchema.parse((await send('GET', '/auth/me')).json());
    expect(me.tenant.setupStatus).toBe('pending');
  });

  it('sends the welcome email from the worker, with the workspace address', async () => {
    const welcome = await eventually(() => lastMailTo(mail.apiUrl, 'farhana@rahmangarments.com'));
    expect(welcome.subject).toBe('Welcome to Omnivo, Farhana Rahman');
    expect(welcome.text).toContain('rahman-garments.omnivo.app');
    expect(welcome.text).toContain('http://localhost:5173/login');
  });
});

describe('starting the setup', () => {
  it('answers with "provisioning" at once, then the worker makes the roles and the chart', async () => {
    const res = await send('POST', '/setup', { industry: 'garments' });
    expect(res.statusCode).toBe(200);
    expect(setupSchema.parse(res.json())).toEqual({ status: 'provisioning', industry: 'garments' });

    await eventually(async () => {
      expect((await setup()).status).toBe('ready');
    });
    const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
    expect(items.map((role) => [role.name, role.permissions])).toEqual([
      ['Owner', expect.any(Array)],
      [
        'Accountant',
        [
          'accounting.account.manage',
          'accounting.journal.create',
          'accounting.journal.post',
          'accounting.journal.read',
          'accounting.period.close',
          'accounting.report.read',
          'core.audit.read',
          'core.user.read',
          'inventory.stock.revalue',
          'inventory.stock.value',
          'sales.customer.balance',
          'sales.customer.manage',
          'sales.price_list.manage',
        ],
      ],
      ['Merchandiser', ['core.user.read', 'inventory.product.manage', 'sales.customer.manage']],
      [
        'Store keeper',
        ['inventory.product.manage', 'inventory.stock.adjust', 'inventory.stock.transfer'],
      ],
    ]);
    const chart = accountListSchema.parse((await send('GET', '/accounts')).json());
    expect(chart.items.find((account) => account.code === '4110')).toMatchObject({
      name: 'Export sales',
      purpose: 'sales',
    });
    // Step 14: every stock use has its template account, chosen in the same job
    const choices = stockAccountsSchema.parse((await send('GET', '/stock-accounts')).json());
    const codeOf = (id: string | null) =>
      chart.items.find((account) => account.id === id)?.code ?? null;
    expect(codeOf(choices.in_transit)).toBe('1175');
    expect(codeOf(choices.damaged)).toBe('5150');
    expect(codeOf(choices.revaluation)).toBe('5190');
    expect(codeOf(choices.internal_use)).toBe('5290');
    // Step 15a: the VAT rates, the same for every business type, with 15% as the default
    const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json());
    expect(rates.items.map((rate) => [rate.name, rate.kind, rate.rate, rate.isDefault])).toEqual([
      ['VAT 15%', 'standard', '15.00', true],
      ['VAT 10%', 'reduced', '10.00', false],
      ['VAT 7.5%', 'reduced', '7.50', false],
      ['VAT 5%', 'reduced', '5.00', false],
      ['Exempt', 'exempt', '0.00', false],
      ['Zero-rated', 'zero_rated', '0.00', false],
    ]);
  });

  it('writes the audit log as the system, with the request that started it', async () => {
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace')).json(),
    );
    const [provisioned, started] = items;
    expect(started).toMatchObject({
      action: 'workspace.setup_started',
      actor: { fullName: 'Farhana Rahman' },
      changes: { industry: { from: null, to: 'garments' } },
    });
    expect(provisioned).toMatchObject({
      action: 'workspace.provisioned',
      actor: null,
      changes: {
        roles: { from: null, to: 'Accountant, Merchandiser, Store keeper' },
        accounts: { from: null, to: GARMENTS_ACCOUNTS },
        units: { from: null, to: GARMENTS_CATALOG.units },
        categories: { from: null, to: GARMENTS_CATALOG.categories },
        customFields: { from: null, to: GARMENTS_CATALOG.customFields },
        taxRates: { from: null, to: TAX_RATES.length },
      },
    });
    // The worker ran in the context of the POST /setup request: one click, traced end to end
    expect(provisioned?.requestId).toBe(started?.requestId);
    expect(provisioned?.ipAddress).toBeNull();
  });

  it('puts "Workspace ready" in the owner\'s bell', async () => {
    const { items } = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(items.map((item) => item.type)).toContain('workspace.ready');
  });

  it('can be started only once', async () => {
    const again = await send('POST', '/setup', { industry: 'pharma' });
    expect(again.statusCode).toBe(409);
    expect(problemSchema.parse(again.json()).code).toBe('setup_started');
  });

  it('ignores the same event published twice, and a second run of the job', async () => {
    await superuserSql(async (sql) => {
      // 1) The relay crashed after Redis took the job but before it marked the row: the row is
      //    published again. The job id is the event id, so BullMQ ignores the second add.
      await sql`UPDATE outbox_events SET published_at = NULL
                WHERE type = 'workspace.setup_requested'`;
      // 2) A second event for the same workspace: the handler really runs again, finds 'ready'
      //    and stops — no second set of roles, no second notification
      await sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                SELECT gen_random_uuid(), tenant_id, type, payload FROM outbox_events
                WHERE type = 'workspace.setup_requested'`;
    });
    await eventually(() => unpublished(0));
    // The relay has handed both over; give the queue a moment to run what it will run
    await new Promise((resolve) => setTimeout(resolve, 500));

    const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
    expect(items).toHaveLength(4);
    const chart = accountListSchema.parse((await send('GET', '/accounts')).json());
    expect(chart.items).toHaveLength(GARMENTS_ACCOUNTS);
    const bell = notificationPageSchema.parse((await send('GET', '/notifications')).json());
    expect(bell.items.filter((item) => item.type === 'workspace.ready')).toHaveLength(1);
  });
});

describe('when the setup job fails', () => {
  let pharmaOwner: SignedIn;

  beforeAll(async () => {
    pharmaOwner = await signUp(app, {
      companyName: 'Karim Pharma',
      workspaceSlug: 'karim-pharma',
      fullName: 'Karim Uddin',
      email: 'karim@karimpharma.com',
      password: 'Batch-expiry-2026',
    });
  });

  it('marks it failed, and Retry finishes it once the cause is fixed', async () => {
    const me = meResponseSchema.parse(
      (await send('GET', '/auth/me', undefined, pharmaOwner)).json(),
    );
    // A role named like the template's "Depot manager", made by the owner before the job runs
    const own = await send(
      'POST',
      '/roles',
      { name: 'depot manager', description: 'Our own' },
      pharmaOwner,
    );
    expect(own.statusCode).toBe(201);

    // A broken start: an industry the code does not know. Running the job again cannot help, so
    // it gives up at once (PermanentJobError, no retries) and onGiveUp marks the setup failed.
    await superuserSql(async (sql) => {
      await sql`UPDATE tenants SET setup_status = 'provisioning', industry = 'shipping'
                WHERE slug = 'karim-pharma'`;
      await sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                SELECT gen_random_uuid(), id, 'workspace.setup_requested',
                       jsonb_build_object('userId', ${me.user.id}::text)
                FROM tenants WHERE slug = 'karim-pharma'`;
    });
    // Read from the table: while the industry is broken, GET /setup itself fails its response
    // contract ('shipping' is not an industry) — the API refuses to send data it cannot vouch for
    await eventually(() =>
      superuserSql(async (sql) => {
        const [row] = await sql<{ setup_status: string }[]>`
          SELECT setup_status FROM tenants WHERE slug = 'karim-pharma'`;
        expect(row?.setup_status).toBe('failed');
      }),
    );

    await superuserSql(
      (sql) => sql`UPDATE tenants SET industry = 'pharma' WHERE slug = 'karim-pharma'`,
    );
    // Step 9's migration queues a chart, step 12's a catalog and step 15a's the VAT rates, for
    // every workspace that is not 'pending' — this failed one too. All three arrive before the
    // retry, so the retried setup job must leave them alone.
    await superuserSql(
      (sql) => sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                   SELECT gen_random_uuid(), id, event, '{}'::jsonb
                   FROM tenants, unnest(ARRAY['workspace.chart_requested', 'workspace.catalog_requested',
                                              'workspace.tax_rates_requested']) AS event
                   WHERE slug = 'karim-pharma'`,
    );
    await eventually(async () => {
      const rates = taxRateListSchema.parse(
        (await send('GET', '/tax-rates', undefined, pharmaOwner)).json(),
      );
      expect(rates.items).toHaveLength(TAX_RATES.length);
    });
    await eventually(async () => {
      const units = unitListSchema.parse(
        (await send('GET', '/units', undefined, pharmaOwner)).json(),
      );
      expect(units.items).toHaveLength(INDUSTRY_TEMPLATES.pharma.catalog.units.length);
    });
    const pharmaAccounts = accountCount(INDUSTRY_TEMPLATES.pharma.chart);
    await eventually(async () => {
      const chart = accountListSchema.parse(
        (await send('GET', '/accounts', undefined, pharmaOwner)).json(),
      );
      expect(chart.items).toHaveLength(pharmaAccounts);
    });

    const retried = await send('POST', '/setup/retry', undefined, pharmaOwner);
    expect(setupSchema.parse(retried.json())).toEqual({
      status: 'provisioning',
      industry: 'pharma',
    });
    await eventually(async () => {
      expect((await setup(pharmaOwner)).status).toBe('ready');
    });

    // The owner's own "depot manager" is kept as it was; the template's did not overwrite it
    const { items } = roleListSchema.parse(
      (await send('GET', '/roles', undefined, pharmaOwner)).json(),
    );
    // (the list is sorted by name as stored, so the lowercase name comes last)
    expect(items.map((role) => role.name)).toEqual([
      'Owner',
      'Accountant',
      'Sales representative',
      'depot manager',
    ]);
    expect(items.find((role) => role.name === 'depot manager')).toMatchObject({
      description: 'Our own',
      permissions: [],
    });
    // Still one chart, and the setup's audit row says it added none (no taxRates in it either)
    const chart = accountListSchema.parse(
      (await send('GET', '/accounts', undefined, pharmaOwner)).json(),
    );
    expect(chart.items).toHaveLength(pharmaAccounts);
    // …one set of VAT rates, with one default…
    const rates = taxRateListSchema.parse(
      (await send('GET', '/tax-rates', undefined, pharmaOwner)).json(),
    );
    expect(rates.items).toHaveLength(TAX_RATES.length);
    expect(rates.items.filter((rate) => rate.isDefault)).toHaveLength(1);
    const log = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace', undefined, pharmaOwner)).json(),
    );
    expect(log.items.find((entry) => entry.action === 'workspace.provisioned')?.changes).toEqual({
      industry: { from: null, to: 'pharma' },
      roles: { from: null, to: 'Accountant, Sales representative' },
    });
  });

  it('refuses a retry when nothing failed', async () => {
    const res = await send('POST', '/setup/retry', undefined, pharmaOwner);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('setup_not_failed');
  });
});

// Migration 0014 queues one 'workspace.chart_requested' per workspace that was set up before
// step 9. Here the same row is written by hand for a workspace that looks like one from before
// step 8: set up, but with no business type.
describe('a workspace set up before the chart of accounts', () => {
  let oldOwner: SignedIn;

  beforeAll(async () => {
    oldOwner = await signUp(app, {
      companyName: 'Hossain Traders',
      workspaceSlug: 'hossain-traders',
      fullName: 'Anwar Hossain',
      email: 'anwar@hossaintraders.com',
      password: 'Moulvibazar-2026',
    });
    await superuserSql(
      (sql) => sql`UPDATE tenants SET setup_status = 'ready' WHERE slug = 'hossain-traders'`,
    );
  });

  async function requestChart(): Promise<void> {
    await superuserSql(
      (sql) => sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                   SELECT gen_random_uuid(), id, 'workspace.chart_requested', '{}'::jsonb
                   FROM tenants WHERE slug = 'hossain-traders'`,
    );
  }

  async function accounts() {
    return accountListSchema.parse((await send('GET', '/accounts', undefined, oldOwner)).json())
      .items;
  }

  it('gets the general chart from the worker, logged as the system', async () => {
    expect(await accounts()).toEqual([]);
    await requestChart();
    const general = accountCount(INDUSTRY_TEMPLATES.other.chart);
    await eventually(async () => {
      expect(await accounts()).toHaveLength(general);
    });

    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace', undefined, oldOwner)).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'workspace.chart_created',
      actor: null,
      changes: { industry: { from: null, to: 'other' }, accounts: { from: null, to: general } },
    });
  });

  it('adds nothing when the event comes again', async () => {
    const before = await accounts();
    await requestChart();
    await eventually(() => unpublished(0));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await accounts()).toHaveLength(before.length);
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace', undefined, oldOwner)).json(),
    );
    expect(items.filter((entry) => entry.action === 'workspace.chart_created')).toHaveLength(1);
  });

  // Step 15a: migration 0026 queues one 'workspace.tax_rates_requested' per workspace that is not
  // 'pending'. This one has none yet.
  async function requestTaxRates(): Promise<void> {
    await superuserSql(
      (sql) => sql`INSERT INTO outbox_events (id, tenant_id, type, payload)
                   SELECT gen_random_uuid(), id, 'workspace.tax_rates_requested', '{}'::jsonb
                   FROM tenants WHERE slug = 'hossain-traders'`,
    );
  }

  async function taxRates() {
    return taxRateListSchema.parse((await send('GET', '/tax-rates', undefined, oldOwner)).json())
      .items;
  }

  it('gets the VAT rates from the worker, logged as the system', async () => {
    expect(await taxRates()).toEqual([]);
    await requestTaxRates();
    await eventually(async () => {
      expect(await taxRates()).toHaveLength(TAX_RATES.length);
    });
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace', undefined, oldOwner)).json(),
    );
    expect(items[0]).toMatchObject({
      action: 'tax_rates.created',
      actor: null,
      changes: { rates: { from: null, to: TAX_RATES.length } },
    });
  });

  it('adds no second set when the event comes again, even after the owner changed them', async () => {
    // The owner archives a rate the business never uses. A second set would bring it back.
    const fivePercent = (await taxRates()).find((rate) => rate.name === 'VAT 5%');
    if (!fivePercent) throw new Error('no 5% rate');
    const archived = await send(
      'POST',
      `/tax-rates/${fivePercent.id}/archive`,
      { version: fivePercent.version },
      oldOwner,
    );
    expect(archived.statusCode).toBe(200);

    await requestTaxRates();
    await eventually(() => unpublished(0));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await taxRates();
    expect(after).toHaveLength(TAX_RATES.length);
    expect(after.find((rate) => rate.id === fivePercent.id)?.archivedAt).not.toBeNull();
    const { items } = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace', undefined, oldOwner)).json(),
    );
    expect(items.filter((entry) => entry.action === 'tax_rates.created')).toHaveLength(1);
  });
});
