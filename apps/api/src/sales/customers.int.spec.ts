import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  type Customer,
  type CustomerFormValues,
  customerGroupListSchema,
  customerGroupSchema,
  customerPageSchema,
  customerSchema,
  journalEntrySchema,
  ledgerPageSchema,
  memberPageSchema,
  openingBalancesSchema,
  priceListSchema,
  problemSchema,
  roleSchema,
  setupSchema,
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
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { joinWithoutRoles } from '../testing/workspace.js';

let pg: TestPostgres;
let redis: TestRedis;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let owner: SignedIn;
// Nasrin: adds and changes customers, but may not see what they owe
let seller: SignedIn;
let accounts: Account[];

function send(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: object,
  as = owner,
) {
  return app.inject({
    method,
    url,
    headers: bearer(as.accessToken),
    ...(payload && { payload }),
  });
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

function id(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

// The garments chart: 1110 cash, 1140 the receivable, 4110 export sales
const RECEIVABLE = '1140';

// What the customer form sends; each test changes a few fields
function customerForm(name: string, extra: Partial<CustomerFormValues> = {}): CustomerFormValues {
  return {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  };
}

// A form built from a saved customer, as the edit page does
function formOf(customer: Customer, extra: Partial<CustomerFormValues> = {}) {
  return {
    code: customer.code,
    name: customer.name,
    groupId: customer.groupId ?? '',
    contactPerson: customer.contactPerson ?? '',
    phone: customer.phone ?? '',
    email: customer.email ?? '',
    bin: customer.bin ?? '',
    paymentTermsDays: customer.paymentTermsDays,
    creditLimit: customer.creditLimit ?? '',
    priceListId: customer.priceListId ?? '',
    notes: customer.notes ?? '',
    addresses: customer.addresses.map((address) => ({
      id: address.id,
      kind: address.kind === 'billing' ? ('billing' as const) : ('shipping' as const),
      label: address.label ?? '',
      address: address.address,
      phone: address.phone ?? '',
    })),
    ...extra,
    version: customer.version,
  };
}

async function addCustomer(name: string, extra: Partial<CustomerFormValues> = {}) {
  const res = await send('POST', '/customers', customerForm(name, extra));
  expect(res.statusCode, res.body).toBe(201);
  return customerSchema.parse(res.json());
}

async function customer(customerId: string, as = owner): Promise<Customer> {
  return customerSchema.parse(
    (await send('GET', `/customers/${customerId}`, undefined, as)).json(),
  );
}

// A line as the journal form sends it: '' on the empty side, '' for "no customer"
function debit(code: string, amount: string, partyId = '') {
  return { accountId: id(code), branchId: '', partyId, description: '', debit: amount, credit: '' };
}
function credit(code: string, amount: string, partyId = '') {
  return { accountId: id(code), branchId: '', partyId, description: '', debit: '', credit: amount };
}

function write(date: string, lines: object[], { post = true, narration = 'Test entry' } = {}) {
  return send('POST', '/journal-entries', { date, narration, lines, post });
}

async function posted(date: string, lines: object[], narration = 'Test entry') {
  const res = await write(date, lines, { narration });
  expect(res.statusCode, res.body).toBe(201);
  return journalEntrySchema.parse(res.json());
}

// Runs SQL as the database superuser: RLS does not apply, but every trigger does
async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// The constraint name a failed statement reports, or null if it did not fail
async function constraintOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    if (error instanceof postgres.PostgresError) return error.constraint_name ?? error.message;
    throw error;
  }
}

// Makes a posted entry look like one written before step 15a: no customer on any line. Only with
// the triggers off (session_replication_role = replica), because the entry is posted: the
// immutability trigger would refuse the change, and the party rule would refuse the commit.
async function asBeforeStep15a(entryId: string): Promise<void> {
  await superuserSql((sql) =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE journal_lines SET party_id = NULL WHERE entry_id = ${entryId}`;
    }),
  );
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
  owner = await signUp(app, {
    companyName: 'Rahman Garments Ltd.',
    workspaceSlug: 'rahman-garments',
    fullName: 'Farhana Rahman',
    email: 'farhana@rahmangarments.com',
    password: 'Gazipur-knit-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;

  // A salesperson: keeps the customer records, but what they owe is the accountant's business
  await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
  });
  await joinWithoutRoles(pg.superuserUrl, {
    email: 'nasrin@rahmangarments.com',
    workspace: 'rahman-garments',
  });
  const role = roleSchema.parse(
    (await send('POST', '/roles', { name: 'Field sales', description: '' })).json(),
  );
  expect(
    (
      await send('PUT', '/permission-matrix', {
        roles: [{ id: role.id, version: role.version, permissions: ['sales.customer.manage'] }],
      })
    ).statusCode,
  ).toBe(200);
  const { items: members } = memberPageSchema.parse((await send('GET', '/members')).json());
  const nasrin = members.find((member) => member.email === 'nasrin@rahmangarments.com');
  if (!nasrin) throw new Error('Nasrin is not a member');
  expect(
    (
      await send('PUT', `/members/${nasrin.membershipId}/roles`, {
        roleIds: [role.id],
        version: nasrin.version,
      })
    ).statusCode,
  ).toBe(200);
  seller = await logIn(app, {
    workspace: 'rahman-garments',
    email: 'nasrin@rahmangarments.com',
    password: 'Tongi-store-2026',
    keepSignedIn: false,
  });
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('customer groups', () => {
  it('are added and renamed, each name once in any case', async () => {
    const res = await send('POST', '/customer-groups', { name: 'Export buyer' });
    expect(res.statusCode).toBe(201);
    expect(customerGroupSchema.parse(res.json())).toMatchObject({ customerCount: 0, version: 1 });

    const same = await send('POST', '/customer-groups', { name: 'export BUYER' });
    expect(same.statusCode).toBe(409);
    expect(problemOf(same).fieldErrors).toEqual({ name: ['customer_group_name_taken'] });

    const local = customerGroupSchema.parse(
      (await send('POST', '/customer-groups', { name: 'Local wholesale' })).json(),
    );
    const renamed = await send('PUT', `/customer-groups/${local.id}`, {
      name: 'Local wholesaler',
      version: local.version,
    });
    expect(customerGroupSchema.parse(renamed.json())).toMatchObject({
      name: 'Local wholesaler',
      version: 2,
    });
    const { items } = customerGroupListSchema.parse((await send('GET', '/customer-groups')).json());
    expect(items.map((group) => group.name)).toEqual(['Export buyer', 'Local wholesaler']);
  });
});

describe('customers', () => {
  it('get the next code from the series, and keep a code typed by hand', async () => {
    const first = await addCustomer('Nordic Apparel AB');
    expect(first).toMatchObject({ code: 'C-00001', balance: '0.0000', isSupplier: false });
    const typed = await addCustomer('Baltic Fashion GmbH', { code: 'C-00002' });
    expect(typed.code).toBe('C-00002');
    // The series does not refuse a number someone typed: it skips it
    expect((await addCustomer('Tongi Wholesale')).code).toBe('C-00003');

    const taken = await send('POST', '/customers', customerForm('Copy', { code: 'c-00001' }));
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken).fieldErrors).toEqual({ code: ['customer_code_taken'] });
    // An empty code on an edit keeps the one it has
    const kept = await send('PUT', `/customers/${first.id}`, formOf(first, { code: '' }));
    expect(customerSchema.parse(kept.json()).code).toBe('C-00001');
  });

  it('keep one billing address first, the others in order, each with its id', async () => {
    const saved = await addCustomer('Mirpur Fabrics Traders', {
      addresses: [
        {
          id: null,
          kind: 'shipping',
          label: 'Mirpur depot',
          address: 'Section 7, Mirpur, Dhaka',
          phone: '',
        },
        {
          id: null,
          kind: 'billing',
          label: 'Head office',
          address: 'Motijheel C/A, Dhaka 1000',
          phone: '',
        },
        {
          id: null,
          kind: 'shipping',
          label: 'Gazipur depot',
          address: 'Board Bazar, Gazipur',
          phone: '',
        },
      ],
    });
    expect(saved.addresses.map((address) => [address.kind, address.label])).toEqual([
      ['billing', 'Head office'],
      ['shipping', 'Mirpur depot'],
      ['shipping', 'Gazipur depot'],
    ]);
    const [office, mirpur] = saved.addresses;
    if (!office || !mirpur) throw new Error('addresses missing');

    // The depot becomes the billing address and the head office a shipping one, in one save:
    // for a moment the database must never hold two billing addresses
    const res = await send(
      'PUT',
      `/customers/${saved.id}`,
      formOf(saved, {
        addresses: [
          {
            id: office.id,
            kind: 'shipping',
            label: 'Head office',
            address: office.address,
            phone: '',
          },
          {
            id: mirpur.id,
            kind: 'billing',
            label: 'Mirpur depot',
            address: mirpur.address,
            phone: '',
          },
          {
            id: null,
            kind: 'shipping',
            label: 'Savar depot',
            address: 'Hemayetpur, Savar',
            phone: '',
          },
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const after = customerSchema.parse(res.json());
    expect(after.addresses.map((address) => [address.id, address.kind, address.label])).toEqual([
      [mirpur.id, 'billing', 'Mirpur depot'],
      [office.id, 'shipping', 'Head office'],
      [expect.any(String), 'shipping', 'Savar depot'],
    ]);

    const twice = await send(
      'POST',
      '/customers',
      customerForm('Two invoices', {
        addresses: [
          { id: null, kind: 'billing', label: '', address: 'Agrabad, Chattogram', phone: '' },
          { id: null, kind: 'billing', label: '', address: 'Khatunganj, Chattogram', phone: '' },
        ],
      }),
    );
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({
      'addresses.1.kind': ['customer_billing_twice'],
    });
  });

  it("never moves another customer's address: its id only makes a new one", async () => {
    const other = await addCustomer('Narayanganj Knit Hub', {
      addresses: [
        { id: null, kind: 'billing', label: '', address: 'BSCIC, Narayanganj', phone: '' },
      ],
    });
    const theirs = other.addresses[0];
    if (!theirs) throw new Error('no address');
    const mine = await addCustomer('Fatullah Traders', {
      addresses: [
        { id: theirs.id, kind: 'billing', label: '', address: 'Fatullah, Narayanganj', phone: '' },
      ],
    });
    expect(mine.addresses[0]?.id).not.toBe(theirs.id);
    expect((await customer(other.id)).addresses).toEqual(other.addresses);
  });

  it('check the group and the price list; a customer keeps a list archived since', async () => {
    const missing = await send(
      'POST',
      '/customers',
      customerForm('Lost group', { groupId: '01939d1c-0000-7000-8000-000000000000' }),
    );
    expect(problemOf(missing).fieldErrors).toEqual({ groupId: ['customer_group_invalid'] });

    const list = priceListSchema.parse(
      (await send('POST', '/price-lists', { name: 'Wholesale', description: '' })).json(),
    );
    const onList = await addCustomer('Gulistan Garments Wholesale', { priceListId: list.id });
    const archived = await send('POST', `/price-lists/${list.id}/archive`, {
      version: list.version,
    });
    expect(archived.statusCode).toBe(200);

    const kept = await send(
      'PUT',
      `/customers/${onList.id}`,
      formOf(onList, { phone: '01819-445566' }),
    );
    expect(kept.statusCode, kept.body).toBe(200);
    expect(customerSchema.parse(kept.json()).priceListId).toBe(list.id);
    const fresh = await send(
      'POST',
      '/customers',
      customerForm('New on old list', { priceListId: list.id }),
    );
    expect(problemOf(fresh).fieldErrors).toEqual({ priceListId: ['price_list_invalid'] });
  });

  it('are found by name, code, contact person or phone, a page at a time', async () => {
    const { items: groups } = customerGroupListSchema.parse(
      (await send('GET', '/customer-groups')).json(),
    );
    const local = groups.find((group) => group.name === 'Local wholesaler');
    if (!local) throw new Error('no group');
    await addCustomer('Kawran Bazar Cloth Store', {
      groupId: local.id,
      contactPerson: 'Anwar Hossain',
      phone: '01711-234567',
    });
    await addCustomer('Islampur Fabrics', { groupId: local.id, phone: '01911-987654' });

    async function search(query: string) {
      const page = customerPageSchema.parse((await send('GET', `/customers?${query}`)).json());
      return page.items.map((item) => item.name);
    }
    expect(await search('search=1711')).toEqual(['Kawran Bazar Cloth Store']);
    expect(await search('search=anwar')).toEqual(['Kawran Bazar Cloth Store']);
    expect(await search('search=C-00002')).toEqual(['Baltic Fashion GmbH']);
    // LIKE's wildcards are meant literally: "%" finds nothing here
    expect(await search('search=%25')).toEqual([]);
    expect(await search(`groupId=${local.id}`)).toEqual([
      'Islampur Fabrics',
      'Kawran Bazar Cloth Store',
    ]);

    // Name order, two at a time: every customer once, none skipped
    const names: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '' : `&cursor=${cursor}`;
      const page = customerPageSchema.parse(
        (await send('GET', `/customers?sort=-name&limit=2${query}`)).json(),
      );
      names.push(...page.items.map((item) => item.name));
      cursor = page.nextCursor;
    } while (cursor !== null);
    const all = customerPageSchema.parse((await send('GET', '/customers?limit=100')).json());
    expect(names).toEqual(all.items.map((item) => item.name).reverse());
  });

  it('are archived out of the list, and stay readable', async () => {
    const shop = await addCustomer('Bongshal Tailors');
    const archived = await send('POST', `/customers/${shop.id}/archive`, { version: shop.version });
    expect(customerSchema.parse(archived.json()).archivedAt).not.toBeNull();
    const active = customerPageSchema.parse(
      (await send('GET', '/customers?search=bongshal')).json(),
    );
    expect(active.items).toEqual([]);
    const old = customerPageSchema.parse(
      (await send('GET', '/customers?search=bongshal&status=archived')).json(),
    );
    expect(old.items.map((item) => item.id)).toEqual([shop.id]);
    expect((await customer(shop.id)).name).toBe('Bongshal Tailors');
  });
});

describe('customers in the books', () => {
  let buyer: Customer;
  let gone: Customer;

  beforeAll(async () => {
    buyer = await addCustomer('Aarhus Knitwear ApS', { paymentTermsDays: 90 });
    gone = await addCustomer('Closed Shop');
    gone = customerSchema.parse(
      (await send('POST', `/customers/${gone.id}/archive`, { version: gone.version })).json(),
    );
  });

  it('need a customer on every receivable line, and none on any other line', async () => {
    const res = await write('2026-09-01', [
      debit(RECEIVABLE, '100'),
      credit('4110', '100', buyer.id),
    ]);
    expect(res.statusCode).toBe(409);
    // Every wrong row at once, each with its own code
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.0.partyId': ['journal_party_required'],
      'lines.1.partyId': ['journal_party_not_allowed'],
    });

    // Archived, made up: the same answer, like an account that cannot be used
    const invalid = await write('2026-09-01', [
      debit(RECEIVABLE, '100', gone.id),
      debit(RECEIVABLE, '100', '01939d1c-0000-7000-8000-000000000000'),
      credit('4110', '200'),
    ]);
    expect(problemOf(invalid).fieldErrors).toEqual({
      'lines.0.partyId': ['journal_party_invalid'],
      'lines.1.partyId': ['journal_party_invalid'],
    });
  });

  it('let a draft wait for its customer; posting it needs one', async () => {
    const res = await write('2026-09-02', [debit(RECEIVABLE, '480000'), credit('4110', '480000')], {
      post: false,
      narration: 'Invoice EXP-118, 12,000 pcs polo shirts',
    });
    expect(res.statusCode, res.body).toBe(201);
    const draft = journalEntrySchema.parse(res.json());
    const post = await send('POST', `/journal-entries/${draft.id}/post`, {
      version: draft.version,
    });
    expect(problemOf(post).fieldErrors).toEqual({ 'lines.0.partyId': ['journal_party_required'] });

    const fixed = await send('PUT', `/journal-entries/${draft.id}`, {
      date: '2026-09-02',
      narration: 'Invoice EXP-118, 12,000 pcs polo shirts',
      lines: [debit(RECEIVABLE, '480000', buyer.id), credit('4110', '480000')],
      post: true,
      version: draft.version,
    });
    const entry = journalEntrySchema.parse(fixed.json());
    expect(entry.status).toBe('posted');
    expect(entry.lines.map((line) => line.party)).toEqual([
      { id: buyer.id, code: buyer.code, name: 'Aarhus Knitwear ApS' },
      null,
    ]);
  });

  it('show what a customer owes only to those who may see it', async () => {
    expect((await customer(buyer.id)).balance).toBe('480000.0000');
    const list = customerPageSchema.parse((await send('GET', '/customers?search=aarhus')).json());
    expect(list.items[0]?.balance).toBe('480000.0000');

    // The salesperson reads the customer, without the balance; the statement is refused
    expect((await customer(buyer.id, seller)).balance).toBeNull();
    const theirs = customerPageSchema.parse(
      (await send('GET', '/customers?search=aarhus', undefined, seller)).json(),
    );
    expect(theirs.items[0]?.balance).toBeNull();
    const statement = await send('GET', `/customers/${buyer.id}/statement`, undefined, seller);
    expect(statement.statusCode).toBe(403);
    expect(problemOf(statement).params).toEqual({ permissions: 'sales.customer.balance' });
  });

  it('give a statement like a ledger: opening balance, running balance, pages', async () => {
    // The buyer pays part by TT, and is invoiced again; another customer's invoice is not theirs
    await posted('2026-09-20', [debit('1110', '300000'), credit(RECEIVABLE, '300000', buyer.id)]);
    await posted('2026-10-01', [
      debit(RECEIVABLE, '125000.50', buyer.id),
      credit('4110', '125000.50'),
    ]);
    const other = await addCustomer('Odense Sportswear');
    await posted('2026-09-21', [debit(RECEIVABLE, '99000', other.id), credit('4110', '99000')]);
    // Drafts are not in the books
    await write('2026-09-25', [debit(RECEIVABLE, '7000', buyer.id), credit('4110', '7000')], {
      post: false,
    });

    const first = ledgerPageSchema.parse(
      (await send('GET', `/customers/${buyer.id}/statement?from=2026-09-10&limit=1`)).json(),
    );
    expect(first).toMatchObject({ openingBalance: '480000.0000', closingBalance: '305000.5000' });
    expect(first.items.map((line) => [line.date, line.credit, line.balance])).toEqual([
      ['2026-09-20', '300000.0000', '180000.0000'],
    ]);
    if (first.nextCursor === null) throw new Error('expected a second page');
    const second = ledgerPageSchema.parse(
      (
        await send(
          'GET',
          `/customers/${buyer.id}/statement?from=2026-09-10&limit=1&cursor=${first.nextCursor}`,
        )
      ).json(),
    );
    expect(second.items.map((line) => [line.date, line.debit, line.balance])).toEqual([
      ['2026-10-01', '125000.5000', '305000.5000'],
    ]);
    expect(second.nextCursor).toBeNull();

    // The receivable's own ledger shows whose line each one is
    const ledger = ledgerPageSchema.parse(
      (
        await send('GET', `/accounts/${id(RECEIVABLE)}/ledger?from=2026-09-21&to=2026-09-21`)
      ).json(),
    );
    expect(ledger.items.map((line) => line.party?.name)).toEqual(['Odense Sportswear']);
  });

  it('reverse an entry onto the same customer', async () => {
    const entry = await posted('2026-10-02', [
      debit(RECEIVABLE, '5000', buyer.id),
      credit('4110', '5000'),
    ]);
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-03',
    });
    expect(res.statusCode, res.body).toBe(201);
    const reversal = journalEntrySchema.parse(res.json());
    expect(reversal.lines.map((line) => line.party?.id ?? null)).toEqual([buyer.id, null]);
    expect((await customer(buyer.id)).balance).toBe('305000.5000');
  });

  it('reverse an entry from before step 15a, whose receivable line names no customer', async () => {
    const entry = await posted('2026-08-15', [
      debit(RECEIVABLE, '64000', buyer.id),
      credit('4110', '64000'),
    ]);
    await asBeforeStep15a(entry.id);
    // Out of the customer's balance: it names no customer now
    expect((await customer(buyer.id)).balance).toBe('305000.5000');

    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-04',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(journalEntrySchema.parse(res.json()).lines.map((line) => line.party)).toEqual([
      null,
      null,
    ]);
  });

  it('keep a receivable line without a customer out of the books, even written by hand', async () => {
    const failed = await constraintOf(() =>
      superuserSql((sql) =>
        sql.begin(async (tx) => {
          const [entry] = await tx<{ id: string }[]>`
            INSERT INTO journal_entries (id, tenant_id, date, status)
            SELECT gen_random_uuid(), id, '2026-10-05', 'draft' FROM tenants
             WHERE slug = 'rahman-garments'
            RETURNING id`;
          if (!entry) throw new Error('no entry');
          await tx`
            INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_id, debit, credit)
            SELECT gen_random_uuid(), e.tenant_id, e.id, v.line_no, v.account_id::uuid, v.debit, v.credit
              FROM journal_entries e,
                   (VALUES (1, ${id(RECEIVABLE)}, 100, 0), (2, ${id('4110')}, 0, 100))
                     AS v(line_no, account_id, debit, credit)
             WHERE e.id = ${entry.id}`;
          await tx`
            UPDATE journal_entries SET status = 'posted', number = 'JV-HAND-2', posted_at = now()
             WHERE id = ${entry.id}`;
        }),
      ),
    );
    expect(failed).toBe('journal_lines_party_check');
  });

  it('delete a customer nothing uses, and refuse one with entries', async () => {
    const mistake = await addCustomer('Typed by mistake');
    const removed = await send(
      'DELETE',
      `/customers/${mistake.id}?version=${String(mistake.version)}`,
    );
    expect(removed.statusCode).toBe(204);
    expect((await send('GET', `/customers/${mistake.id}`)).statusCode).toBe(404);

    const current = await customer(buyer.id);
    const inUse = await send('DELETE', `/customers/${buyer.id}?version=${String(current.version)}`);
    expect(inUse.statusCode).toBe(409);
    expect(problemOf(inUse).code).toBe('customer_in_use');
  });

  it('keep a group while any customer is in it, archived ones too', async () => {
    const group = customerGroupSchema.parse(
      (await send('POST', '/customer-groups', { name: 'Closed accounts' })).json(),
    );
    const shop = await send('PUT', `/customers/${gone.id}`, formOf(gone, { groupId: group.id }));
    expect(shop.statusCode, shop.body).toBe(200);
    const { items } = customerGroupListSchema.parse((await send('GET', '/customer-groups')).json());
    expect(items.find((item) => item.id === group.id)?.customerCount).toBe(1);

    const inUse = await send('DELETE', `/customer-groups/${group.id}?version=1`);
    expect(inUse.statusCode).toBe(409);
    expect(problemOf(inUse).code).toBe('customer_group_in_use');

    const moved = customerSchema.parse(shop.json());
    const out = await send('PUT', `/customers/${gone.id}`, formOf(moved, { groupId: '' }));
    expect(out.statusCode).toBe(200);
    expect((await send('DELETE', `/customer-groups/${group.id}?version=1`)).statusCode).toBe(204);
  });
});

describe('opening balances by customer', () => {
  let dhaka: Customer;
  let chattogram: Customer;

  beforeAll(async () => {
    dhaka = await addCustomer('Dhaka Denim Wholesale');
    chattogram = await addCustomer('Chattogram Export House');
  });

  async function current() {
    return openingBalancesSchema.parse((await send('GET', '/opening-balances')).json());
  }

  it('split the receivable into one line per customer', async () => {
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [
        { accountId: id('1110'), partyId: '', debit: '85000', credit: '' },
        { accountId: id(RECEIVABLE), partyId: dhaka.id, debit: '1200000', credit: '' },
        { accountId: id(RECEIVABLE), partyId: chattogram.id, debit: '640000.50', credit: '' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = openingBalancesSchema.parse(res.json());
    expect(saved.lines.map((line) => [line.party?.name ?? null, line.debit])).toEqual([
      [null, '85000.0000'],
      ['Dhaka Denim Wholesale', '1200000.0000'],
      ['Chattogram Export House', '640000.5000'],
    ]);
    expect((await customer(dhaka.id)).balance).toBe('1200000.0000');
    expect((await customer(chattogram.id)).balance).toBe('640000.5000');
  });

  it('put each customer error under the row it came from', async () => {
    const before = await current();
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: before.entry?.id ?? null,
      lines: [
        // An empty row is dropped before the check: the errors must still name rows 1 and 2
        { accountId: id('1110'), partyId: '', debit: '', credit: '' },
        { accountId: id(RECEIVABLE), partyId: '', debit: '5000', credit: '' },
        { accountId: id('1110'), partyId: dhaka.id, debit: '', credit: '5000' },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.1.partyId': ['journal_party_required'],
      'lines.2.partyId': ['journal_party_not_allowed'],
    });

    const twice = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: before.entry?.id ?? null,
      lines: [
        { accountId: id(RECEIVABLE), partyId: dhaka.id, debit: '100', credit: '' },
        { accountId: id(RECEIVABLE), partyId: dhaka.id, debit: '200', credit: '' },
      ],
    });
    expect(twice.statusCode).toBe(400);
    expect(problemOf(twice).fieldErrors).toEqual({ 'lines.1.debit': ['opening_balance_twice'] });
  });

  it('replace opening balances saved before step 15a, which named no customer', async () => {
    const before = await current();
    if (before.entry === null) throw new Error('no opening balances');
    await asBeforeStep15a(before.entry.id);
    // The page shows the old receivable lines without a customer, for the person to split
    const old = await current();
    expect(old.lines.map((line) => line.party)).toEqual([null, null, null]);

    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: old.entry?.id ?? null,
      lines: [
        { accountId: id('1110'), partyId: '', debit: '85000', credit: '' },
        { accountId: id(RECEIVABLE), partyId: dhaka.id, debit: '1100000', credit: '' },
        { accountId: id(RECEIVABLE), partyId: chattogram.id, debit: '740000.50', credit: '' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    // The old entry was reversed without a customer, the new one names them
    const reversed = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${before.entry.id}`)).json(),
    );
    expect(reversed.reversedBy).not.toBeNull();
    expect((await customer(dhaka.id)).balance).toBe('1100000.0000');
    expect((await customer(chattogram.id)).balance).toBe('740000.5000');
  });
});
