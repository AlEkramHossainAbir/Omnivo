import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  auditPageSchema,
  type Customer,
  customerGroupSchema,
  customerSchema,
  journalEntrySchema,
  ledgerPageSchema,
  memberPageSchema,
  openingBalancesSchema,
  type PermissionKey,
  type Product,
  productSchema,
  problemSchema,
  roleSchema,
  setupSchema,
  type Supplier,
  type SupplierFormValues,
  supplierGroupListSchema,
  supplierGroupSchema,
  supplierPageSchema,
  supplierSchema,
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
// Tanvir: keeps the supplier records, but what the company owes them is the accountant's business
let buyer: SignedIn;
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

// The garments chart: 1110 cash, 1140 the receivable, 2110 the payable
const RECEIVABLE = '1140';
const PAYABLE = '2110';

// What the supplier form sends; each test changes a few fields
function supplierForm(name: string, extra: Partial<SupplierFormValues> = {}): SupplierFormValues {
  return {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 30,
    address: '',
    bankAccounts: [],
    notes: '',
    ...extra,
  };
}

// A form built from a saved supplier, as the edit page does
function formOf(supplier: Supplier, extra: Partial<SupplierFormValues> = {}) {
  return {
    code: supplier.code,
    name: supplier.name,
    groupId: supplier.groupId ?? '',
    contactPerson: supplier.contactPerson ?? '',
    phone: supplier.phone ?? '',
    email: supplier.email ?? '',
    documentLanguage: supplier.documentLanguage,
    bin: supplier.bin ?? '',
    paymentTermsDays: supplier.paymentTermsDays,
    address: supplier.address ?? '',
    bankAccounts: supplier.bankAccounts.map((account) => ({
      id: account.id,
      bankName: account.bankName,
      branchName: account.branchName ?? '',
      accountName: account.accountName,
      accountNumber: account.accountNumber,
      routingNumber: account.routingNumber ?? '',
    })),
    notes: supplier.notes ?? '',
    ...extra,
    version: supplier.version,
  };
}

// A new bank account as the form sends it
function bankAccount(bankName: string, accountNumber: string, extra: object = {}) {
  return {
    id: null,
    bankName,
    branchName: '',
    accountName: 'Square Yarns Ltd.',
    accountNumber,
    routingNumber: '',
    ...extra,
  };
}

async function addSupplier(name: string, extra: Partial<SupplierFormValues> = {}) {
  const res = await send('POST', '/suppliers', supplierForm(name, extra));
  expect(res.statusCode, res.body).toBe(201);
  return supplierSchema.parse(res.json());
}

async function supplier(supplierId: string, as = owner): Promise<Supplier> {
  const res = await send('GET', `/suppliers/${supplierId}`, undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return supplierSchema.parse(res.json());
}

async function addCustomer(name: string, extra: object = {}): Promise<Customer> {
  const res = await send('POST', '/customers', {
    code: '',
    name,
    groupId: '',
    contactPerson: '',
    phone: '',
    email: '',
    documentLanguage: 'en',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  return customerSchema.parse(res.json());
}

async function customer(customerId: string): Promise<Customer> {
  const res = await send('GET', `/customers/${customerId}`);
  expect(res.statusCode, res.body).toBe(200);
  return customerSchema.parse(res.json());
}

// A party that both sells to the company and buys from it: a customer made a supplier too
async function bothSides(name: string, extra: object = {}): Promise<Supplier> {
  const made = await addCustomer(name, extra);
  const res = await send('POST', `/customers/${made.id}/make-supplier`, { version: made.version });
  expect(res.statusCode, res.body).toBe(200);
  return supplierSchema.parse(res.json());
}

// A line as the journal form sends it: '' on the empty side, '' for "no party"
function debit(code: string, amount: string, partyId = '') {
  return { accountId: id(code), branchId: '', partyId, description: '', debit: amount, credit: '' };
}
function credit(code: string, amount: string, partyId = '') {
  return { accountId: id(code), branchId: '', partyId, description: '', debit: '', credit: amount };
}

function write(date: string, lines: object[], { post = true } = {}) {
  return send('POST', '/journal-entries', { date, narration: 'Test entry', lines, post });
}

async function posted(date: string, lines: object[]) {
  const res = await write(date, lines);
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

async function bankRowsOf(partyId: string): Promise<number> {
  const [row] = await superuserSql(
    (sql) => sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM party_bank_accounts WHERE party_id = ${partyId}`,
  );
  return row?.n ?? 0;
}

// A user who signs up for a workspace of their own, then joins this one with one role
async function member(
  email: string,
  fullName: string,
  password: string,
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${fullName} Trading`,
    workspaceSlug: email.split('@')[0] ?? 'trading',
    fullName,
    email,
    password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email, workspace: 'meghna-knit' });
  const made = await send('POST', '/roles', { name: 'Purchase desk', description: '' });
  expect(made.statusCode, made.body).toBe(201);
  const role = roleSchema.parse(made.json());
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode, matrix.body).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const found = items.find((item) => item.email === email);
  if (!found) throw new Error(`${email} is not a member`);
  const assigned = await send('PUT', `/members/${found.membershipId}/roles`, {
    roleIds: [role.id],
    version: found.version,
  });
  expect(assigned.statusCode, assigned.body).toBe(200);
  return logIn(app, { workspace: 'meghna-knit', email, password, keepSignedIn: false });
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
    companyName: 'Meghna Knit Composite Ltd.',
    workspaceSlug: 'meghna-knit',
    fullName: 'Shahana Karim',
    email: 'shahana@meghnaknit.com',
    password: 'Narayanganj-knit-2026',
  });
  expect((await send('POST', '/setup', { industry: 'garments' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  accounts = accountListSchema.parse((await send('GET', '/accounts')).json()).items;
  buyer = await member('tanvir@meghnaknit.com', 'Tanvir Hasan', 'Fatullah-yarn-2026', [
    'purchase.supplier.manage',
  ]);
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('supplier groups', () => {
  it('are added and renamed, each name once in any case', async () => {
    const res = await send('POST', '/supplier-groups', { name: 'Yarn' });
    expect(res.statusCode).toBe(201);
    expect(supplierGroupSchema.parse(res.json())).toMatchObject({ supplierCount: 0, version: 1 });

    const same = await send('POST', '/supplier-groups', { name: 'YARN' });
    expect(same.statusCode).toBe(409);
    expect(problemOf(same).fieldErrors).toEqual({ name: ['supplier_group_name_taken'] });

    const trims = supplierGroupSchema.parse(
      (await send('POST', '/supplier-groups', { name: 'Trim' })).json(),
    );
    const renamed = await send('PUT', `/supplier-groups/${trims.id}`, {
      name: 'Trims and accessories',
      version: trims.version,
    });
    expect(supplierGroupSchema.parse(renamed.json())).toMatchObject({
      name: 'Trims and accessories',
      version: 2,
    });
    const { items } = supplierGroupListSchema.parse((await send('GET', '/supplier-groups')).json());
    expect(items.map((group) => group.name)).toEqual(['Trims and accessories', 'Yarn']);
  });

  it('keep a group while any supplier is in it, archived ones too', async () => {
    const group = supplierGroupSchema.parse(
      (await send('POST', '/supplier-groups', { name: 'Packaging' })).json(),
    );
    const cartons = await addSupplier('Bengal Carton Industries', { groupId: group.id });
    const archived = await send('POST', `/suppliers/${cartons.id}/archive`, {
      version: cartons.version,
    });
    expect(archived.statusCode, archived.body).toBe(200);

    const { items } = supplierGroupListSchema.parse((await send('GET', '/supplier-groups')).json());
    const counted = items.find((item) => item.id === group.id);
    expect(counted?.supplierCount).toBe(1);
    const refused = await send('DELETE', `/supplier-groups/${group.id}?version=1`);
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused).code).toBe('supplier_group_in_use');

    // A customer group is not a supplier group: the customer side of a party has its own
    const empty = supplierGroupSchema.parse(
      (await send('POST', '/supplier-groups', { name: 'Chemicals' })).json(),
    );
    expect((await send('DELETE', `/supplier-groups/${empty.id}?version=1`)).statusCode).toBe(204);
  });
});

describe('suppliers', () => {
  it('get the next code from the S- series; a code is one party, customer or supplier', async () => {
    const first = await addSupplier('Square Yarns Ltd.');
    expect(first).toMatchObject({
      balance: '0.0000',
      isCustomer: false,
      address: null,
      bankAccounts: [],
    });
    // S-00001 went to the packaging supplier above; the numbers after it are worked out, not typed
    const next = (step: number) =>
      `S-${String(Number(first.code.slice(2)) + step).padStart(5, '0')}`;
    expect(first.code).toMatch(/^S-\d{5}$/);
    // A customer typed the next number by hand: the series skips it, like the customers' own
    await addCustomer('Fakir Fashion', { code: next(1) });
    expect((await addSupplier('Padma Accessories')).code).toBe(next(2));

    const taken = await send(
      'POST',
      '/suppliers',
      supplierForm('Copy', { code: next(1).toLowerCase() }),
    );
    expect(taken.statusCode).toBe(409);
    expect(problemOf(taken).fieldErrors).toEqual({ code: ['supplier_code_taken'] });
    // An empty code on an edit keeps the one it has
    const kept = await send('PUT', `/suppliers/${first.id}`, formOf(first, { code: '' }));
    expect(supplierSchema.parse(kept.json()).code).toBe(first.code);
  });

  it('check the group: a customer group or an unknown id is not one', async () => {
    const customerGroup = await send('POST', '/customer-groups', { name: 'Export buyer' });
    expect(customerGroup.statusCode).toBe(201);
    const { id: groupId } = customerGroupSchema.parse(customerGroup.json());
    const res = await send('POST', '/suppliers', supplierForm('Dhaka Trims House', { groupId }));
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({ groupId: ['supplier_group_invalid'] });
  });

  it('keep their bank accounts in order, cleaned, each with its id', async () => {
    const saved = await addSupplier('Square Yarns Mills', {
      bankAccounts: [
        bankAccount('Dutch-Bangla Bank', '0123-4567890-01', {
          branchName: 'Motijheel',
          routingNumber: '090 275 431',
        }),
        bankAccount('BRAC Bank', '1501 2040 5566 7001'),
      ],
    });
    expect(
      saved.bankAccounts.map((account) => [
        account.bankName,
        account.branchName,
        account.accountNumber,
        account.routingNumber,
      ]),
    ).toEqual([
      ['Dutch-Bangla Bank', 'Motijheel', '0123456789001', '090275431'],
      ['BRAC Bank', null, '1501204055667001', null],
    ]);
    const [dbbl, brac] = saved.bankAccounts;
    if (!dbbl || !brac) throw new Error('expected two bank accounts');

    // BRAC moves to the top and keeps its id, DBBL goes, a new City Bank account comes last
    const res = await send(
      'PUT',
      `/suppliers/${saved.id}`,
      formOf(saved, {
        bankAccounts: [
          {
            id: brac.id,
            bankName: 'BRAC Bank',
            branchName: 'Gulshan',
            accountName: 'Square Yarns Mills',
            accountNumber: brac.accountNumber,
            routingNumber: '',
          },
          bankAccount('City Bank', '2102233445001'),
        ],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const changed = supplierSchema.parse(res.json());
    expect(changed.bankAccounts.map((account) => [account.bankName, account.branchName])).toEqual([
      ['BRAC Bank', 'Gulshan'],
      ['City Bank', null],
    ]);
    expect(changed.bankAccounts[0]?.id).toBe(brac.id);
    expect(await bankRowsOf(saved.id)).toBe(2);

    // The audit log shows an account by its last four digits, never the whole number
    const log = auditPageSchema.parse(
      (await send('GET', `/audit-logs?entityType=supplier&entityId=${saved.id}`)).json(),
    );
    const updated = log.items.find((entry) => entry.action === 'supplier.updated');
    expect(updated?.changes.bankAccounts).toEqual({
      from: 'Dutch-Bangla Bank …9001, BRAC Bank …7001',
      to: 'BRAC Bank …7001, City Bank …5001',
    });
  });

  it("never moves another supplier's bank account: its id only makes a new one", async () => {
    const yarns = await addSupplier('Zaber Spinning', {
      bankAccounts: [bankAccount('Eastern Bank', '1011060012345')],
    });
    const other = await addSupplier('Akij Spinning');
    const foreign = yarns.bankAccounts[0];
    if (!foreign) throw new Error('expected a bank account');
    const res = await send(
      'PUT',
      `/suppliers/${other.id}`,
      formOf(other, {
        bankAccounts: [{ ...bankAccount('Eastern Bank', '1011060099999'), id: foreign.id }],
      }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const [added] = supplierSchema.parse(res.json()).bankAccounts;
    expect(added?.id).not.toBe(foreign.id);
    expect((await supplier(yarns.id)).bankAccounts).toEqual(yarns.bankAccounts);
  });

  it('refuse a bad account number, a bad routing number and a sixth account', async () => {
    const res = await send(
      'POST',
      '/suppliers',
      supplierForm('Rupali Dyes', {
        bankAccounts: [
          bankAccount('Sonali Bank', '12AB'),
          bankAccount('Janata Bank', '0011223344', { routingNumber: '1234' }),
        ],
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(problemOf(res).fieldErrors).toEqual({
      'bankAccounts.0.accountNumber': ['bank_account_number_format'],
      'bankAccounts.1.routingNumber': ['routing_number_format'],
    });

    const six = Array.from({ length: 6 }, (_, index) =>
      bankAccount('Sonali Bank', `00112233${String(index)}0`),
    );
    const many = await send(
      'POST',
      '/suppliers',
      supplierForm('Rupali Dyes', { bankAccounts: six }),
    );
    expect(many.statusCode).toBe(400);
  });

  it('are found by name, code, contact person or phone, by group, a page at a time', async () => {
    const group = supplierGroupSchema.parse(
      (await send('POST', '/supplier-groups', { name: 'Dyes and chemicals' })).json(),
    );
    await addSupplier('Asian Dyeing Chemicals', {
      groupId: group.id,
      contactPerson: 'Mahbub Alam',
      phone: '01711-556677',
    });
    await addSupplier('Bismillah Chemicals', { groupId: group.id });

    const byPerson = supplierPageSchema.parse(
      (await send('GET', '/suppliers?search=mahbub')).json(),
    );
    expect(byPerson.items.map((item) => item.name)).toEqual(['Asian Dyeing Chemicals']);
    const byPhone = supplierPageSchema.parse(
      (await send('GET', '/suppliers?search=556677')).json(),
    );
    expect(byPhone.items.map((item) => item.name)).toEqual(['Asian Dyeing Chemicals']);

    const first = supplierPageSchema.parse(
      (await send('GET', `/suppliers?groupId=${group.id}&limit=1`)).json(),
    );
    expect(first.items.map((item) => item.name)).toEqual(['Asian Dyeing Chemicals']);
    if (first.nextCursor === null) throw new Error('expected a second page');
    const second = supplierPageSchema.parse(
      (
        await send('GET', `/suppliers?groupId=${group.id}&limit=1&cursor=${first.nextCursor}`)
      ).json(),
    );
    expect(second.items.map((item) => item.name)).toEqual(['Bismillah Chemicals']);
    expect(second.nextCursor).toBeNull();

    // A customer is not in the supplier list, even with a matching name
    await addCustomer('Asian Dyeing Buyer Ltd.');
    const suppliersOnly = supplierPageSchema.parse(
      (await send('GET', '/suppliers?search=asian')).json(),
    );
    expect(suppliersOnly.items.map((item) => item.name)).toEqual(['Asian Dyeing Chemicals']);
  });
});

describe('a party on both sides', () => {
  it('becomes a supplier too with the supplier fields at their defaults', async () => {
    const made = await addCustomer('Ha-Meem Washing', {
      paymentTermsDays: 45,
      creditLimit: '500000',
    });
    const res = await send('POST', `/customers/${made.id}/make-supplier`, {
      version: made.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const both = supplierSchema.parse(res.json());
    expect(both).toMatchObject({
      code: made.code,
      groupId: null,
      paymentTermsDays: 0,
      bankAccounts: [],
      isCustomer: true,
    });
    // Its customer side is as it was
    expect(await customer(made.id)).toMatchObject({
      paymentTermsDays: 45,
      creditLimit: '500000.0000',
      isSupplier: true,
    });

    const again = await send('POST', `/customers/${made.id}/make-supplier`, {
      version: both.version,
    });
    expect(again.statusCode).toBe(409);
    expect(problemOf(again).code).toBe('party_role_exists');
    const stale = await send('POST', `/customers/${made.id}/make-supplier`, {
      version: made.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');
  });

  it('becomes a customer too with the customer fields at their defaults', async () => {
    const made = await addSupplier('Mondol Knitwears', { paymentTermsDays: 60 });
    const res = await send('POST', `/suppliers/${made.id}/make-customer`, {
      version: made.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(customerSchema.parse(res.json())).toMatchObject({
      code: made.code,
      paymentTermsDays: 0,
      creditLimit: null,
      priceListId: null,
      isSupplier: true,
    });
    expect((await supplier(made.id)).paymentTermsDays).toBe(60);
  });

  it('shares one billing address: the supplier changes its text, the label and phone stay', async () => {
    const both = await bothSides('Envoy Textiles', {
      addresses: [
        {
          id: null,
          kind: 'billing',
          label: 'Head office',
          address: 'Envoy Tower, Panthapath, Dhaka',
          phone: '02-9102030',
        },
        { id: null, kind: 'shipping', label: 'Mymensingh mill', address: 'Bhaluka', phone: '' },
      ],
    });
    expect(both.address).toBe('Envoy Tower, Panthapath, Dhaka');

    const res = await send(
      'PUT',
      `/suppliers/${both.id}`,
      formOf(both, { address: 'Envoy Tower, 18/E Lake Circus, Dhaka 1205' }),
    );
    expect(res.statusCode, res.body).toBe(200);
    const billing = (await customer(both.id)).addresses.find((item) => item.kind === 'billing');
    expect(billing).toMatchObject({
      label: 'Head office',
      address: 'Envoy Tower, 18/E Lake Circus, Dhaka 1205',
      phone: '02-9102030',
    });

    // An empty address removes it from both sides; the shipping address is the customer's own
    const cleared = await send(
      'PUT',
      `/suppliers/${both.id}`,
      formOf(supplierSchema.parse(res.json()), { address: '' }),
    );
    expect(supplierSchema.parse(cleared.json()).address).toBeNull();
    expect((await customer(both.id)).addresses.map((item) => item.kind)).toEqual(['shipping']);
  });

  it('is archived as one business, from either side', async () => {
    const both = await bothSides('Pacific Jeans');
    const res = await send('POST', `/suppliers/${both.id}/archive`, { version: both.version });
    expect(res.statusCode, res.body).toBe(200);
    expect((await customer(both.id)).archivedAt).not.toBeNull();
    const archived = supplierPageSchema.parse(
      (await send('GET', '/suppliers?status=archived&search=pacific')).json(),
    );
    expect(archived.items.map((item) => item.name)).toEqual(['Pacific Jeans']);

    const back = await send('POST', `/suppliers/${both.id}/restore`, {
      version: supplierSchema.parse(res.json()).version,
    });
    expect(supplierSchema.parse(back.json()).archivedAt).toBeNull();
    expect((await customer(both.id)).archivedAt).toBeNull();
  });
});

describe('suppliers in the books', () => {
  let square: Supplier;

  beforeAll(async () => {
    square = await addSupplier('Square Spinning Unit 2');
  });

  it('need a supplier on every payable line, and the right kind of party', async () => {
    const someone = await addCustomer('Walton Retail');
    const res = await write('2026-10-01', [
      debit('1110', '1000'),
      credit(PAYABLE, '1000'),
      debit(RECEIVABLE, '500', square.id),
      credit(PAYABLE, '500', someone.id),
    ]);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({
      'lines.1.partyId': ['journal_party_required'],
      'lines.2.partyId': ['journal_party_invalid'],
      'lines.3.partyId': ['journal_party_invalid'],
    });
    const notAllowed = await write('2026-10-01', [
      debit('1110', '1000', square.id),
      credit(PAYABLE, '1000', square.id),
    ]);
    expect(problemOf(notAllowed).fieldErrors).toEqual({
      'lines.0.partyId': ['journal_party_not_allowed'],
    });
  });

  it('show what the company owes only to those who may see it', async () => {
    // Yarn bought on credit: the company owes ৳4,50,000, then pays ৳1,00,000 of it
    await posted('2026-09-10', [debit('1110', '450000'), credit(PAYABLE, '450000', square.id)]);
    await posted('2026-09-25', [debit(PAYABLE, '100000', square.id), credit('1110', '100000')]);
    // Drafts are not in the books
    const draft = await write(
      '2026-09-26',
      [debit('1110', '7000'), credit(PAYABLE, '7000', square.id)],
      { post: false },
    );
    expect(draft.statusCode, draft.body).toBe(201);
    expect((await supplier(square.id)).balance).toBe('350000.0000');
    const list = supplierPageSchema.parse((await send('GET', '/suppliers?search=unit 2')).json());
    expect(list.items[0]?.balance).toBe('350000.0000');

    // The purchase desk reads the supplier without the balance; the statement is refused
    expect((await supplier(square.id, buyer)).balance).toBeNull();
    const theirs = supplierPageSchema.parse(
      (await send('GET', '/suppliers?search=unit 2', undefined, buyer)).json(),
    );
    expect(theirs.items[0]?.balance).toBeNull();
    const statement = await send('GET', `/suppliers/${square.id}/statement`, undefined, buyer);
    expect(statement.statusCode).toBe(403);
    expect(problemOf(statement).params).toEqual({ permissions: 'purchase.supplier.balance' });
  });

  it('give a statement of the payable lines only, with a running balance', async () => {
    const page = ledgerPageSchema.parse(
      (await send('GET', `/suppliers/${square.id}/statement?from=2026-09-01`)).json(),
    );
    // debit − credit, like every ledger: negative while the company owes
    expect(page).toMatchObject({ openingBalance: '0.0000', closingBalance: '-350000.0000' });
    expect(page.items.map((line) => [line.date, line.debit, line.credit, line.balance])).toEqual([
      ['2026-09-10', '0.0000', '450000.0000', '-450000.0000'],
      ['2026-09-25', '100000.0000', '0.0000', '-350000.0000'],
    ]);
    // A customer is not a supplier: its id has no supplier statement
    const someone = await addCustomer('Agora Superstores');
    expect((await send('GET', `/suppliers/${someone.id}/statement`)).statusCode).toBe(404);
  });

  it("keep each side's balance apart for a party that is both", async () => {
    const both = await bothSides('Opex Sinha Textiles');
    // It owes the company ৳80,000 for fabric it bought, and the company owes it ৳1,20,000 for yarn
    await posted('2026-10-02', [debit(RECEIVABLE, '80000', both.id), credit('1110', '80000')]);
    await posted('2026-10-02', [debit('1110', '120000'), credit(PAYABLE, '120000', both.id)]);
    expect((await supplier(both.id)).balance).toBe('120000.0000');
    expect((await customer(both.id)).balance).toBe('80000.0000');

    const supplierSide = ledgerPageSchema.parse(
      (await send('GET', `/suppliers/${both.id}/statement`)).json(),
    );
    expect(supplierSide.items.map((line) => line.credit)).toEqual(['120000.0000']);
    const customerSide = ledgerPageSchema.parse(
      (await send('GET', `/customers/${both.id}/statement`)).json(),
    );
    expect(customerSide.items.map((line) => line.debit)).toEqual(['80000.0000']);
  });

  it('reverse an entry onto the same supplier', async () => {
    const entry = await posted('2026-10-03', [
      debit('1110', '5000'),
      credit(PAYABLE, '5000', square.id),
    ]);
    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-10-04',
    });
    expect(res.statusCode, res.body).toBe(201);
    const reversal = journalEntrySchema.parse(res.json());
    expect(reversal.lines.map((line) => line.party?.id ?? null)).toEqual([null, square.id]);
    expect((await supplier(square.id)).balance).toBe('350000.0000');
  });
});

describe('deleting', () => {
  it('deletes a supplier nothing uses, with its bank accounts', async () => {
    const mistake = await addSupplier('Typo Trims', {
      bankAccounts: [bankAccount('Prime Bank', '2126110012345')],
    });
    expect(await bankRowsOf(mistake.id)).toBe(1);
    const res = await send('DELETE', `/suppliers/${mistake.id}?version=${String(mistake.version)}`);
    expect(res.statusCode, res.body).toBe(204);
    expect((await send('GET', `/suppliers/${mistake.id}`)).statusCode).toBe(404);
    expect(await bankRowsOf(mistake.id)).toBe(0);
  });

  it('refuses a supplier with payable lines: archive it instead', async () => {
    const used = await addSupplier('Northern Yarn');
    await posted('2026-10-05', [debit('1110', '1500'), credit(PAYABLE, '1500', used.id)]);
    const res = await send('DELETE', `/suppliers/${used.id}?version=${String(used.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('supplier_in_use');
  });

  it('drops only the supplier side of a party that is both', async () => {
    const both = await bothSides('Beximco Textiles');
    const res = await send(
      'PUT',
      `/suppliers/${both.id}`,
      formOf(both, {
        paymentTermsDays: 15,
        bankAccounts: [bankAccount('Islami Bank', '20501770100123')],
      }),
    );
    const saved = supplierSchema.parse(res.json());
    // Its receivable lines are the customer's: they do not stop the supplier side going
    await posted('2026-10-05', [debit(RECEIVABLE, '9000', both.id), credit('1110', '9000')]);

    const removed = await send('DELETE', `/suppliers/${both.id}?version=${String(saved.version)}`);
    expect(removed.statusCode, removed.body).toBe(204);
    expect((await send('GET', `/suppliers/${both.id}`)).statusCode).toBe(404);
    expect(await bankRowsOf(both.id)).toBe(0);
    expect(await customer(both.id)).toMatchObject({ isSupplier: false, balance: '9000.0000' });
    const [row] = await superuserSql(
      (sql) => sql<{ terms: number }[]>`
        SELECT supplier_payment_terms_days AS terms FROM parties WHERE id = ${both.id}`,
    );
    expect(row?.terms).toBe(0);
  });

  it('refuses to drop the supplier side once a payable line names it', async () => {
    const both = await bothSides('Thermax Yarn');
    await posted('2026-10-05', [debit('1110', '2500'), credit(PAYABLE, '2500', both.id)]);
    const res = await send('DELETE', `/suppliers/${both.id}?version=${String(both.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('supplier_in_use');
  });

  it('drops only the customer side of a party that is both, with its shipping addresses', async () => {
    const both = await bothSides('DBL Ceramics', {
      addresses: [
        { id: null, kind: 'billing', label: '', address: 'Gulshan 2, Dhaka', phone: '' },
        { id: null, kind: 'shipping', label: 'Gazipur', address: 'Kashimpur', phone: '' },
      ],
    });
    // The supplier side's payable lines do not stop the customer side going
    await posted('2026-10-05', [debit('1110', '3000'), credit(PAYABLE, '3000', both.id)]);
    const before = await customer(both.id);
    const res = await send('DELETE', `/customers/${both.id}?version=${String(before.version)}`);
    expect(res.statusCode, res.body).toBe(204);
    expect((await send('GET', `/customers/${both.id}`)).statusCode).toBe(404);
    expect(await supplier(both.id)).toMatchObject({
      isCustomer: false,
      address: 'Gulshan 2, Dhaka',
      balance: '3000.0000',
    });
    const [row] = await superuserSql(
      (sql) => sql<{ shipping: number; terms: number }[]>`
        SELECT (SELECT count(*)::int FROM party_addresses
                 WHERE party_id = ${both.id} AND kind = 'shipping') AS shipping,
               payment_terms_days AS terms
          FROM parties WHERE id = ${both.id}`,
    );
    expect(row).toEqual({ shipping: 0, terms: 0 });
  });

  it('refuses to drop the customer side once a sales document or receivable line names it', async () => {
    const quoted = await bothSides('Snowtex Outerwear');
    const units = unitListSchema.parse((await send('GET', '/units')).json()).items;
    const pcs = units.find((unit) => unit.code === 'pcs');
    const rates = taxRateListSchema.parse((await send('GET', '/tax-rates')).json()).items;
    const vat = rates.find((rate) => rate.name === 'VAT 15%');
    if (!pcs || !vat) throw new Error('no pcs or VAT 15%');
    const made = await send('POST', '/products', {
      code: '',
      name: 'Polo shirt, pique',
      type: 'goods',
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
    });
    expect(made.statusCode, made.body).toBe(201);
    const polo: Product = productSchema.parse(made.json());
    const quotation = await send('POST', '/quotations', {
      customerId: quoted.id,
      date: '2026-10-05',
      validUntil: '2026-10-20',
      note: '',
      lines: [
        {
          variantId: polo.variants[0]?.id ?? '',
          unitId: pcs.id,
          quantity: '100',
          description: '',
          unitPrice: '450',
          discountType: 'percent',
          discount: '',
          taxRateId: vat.id,
        },
      ],
    });
    expect(quotation.statusCode, quotation.body).toBe(201);
    const first = await customer(quoted.id);
    const res = await send('DELETE', `/customers/${quoted.id}?version=${String(first.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).code).toBe('customer_in_use');

    const owing = await bothSides('Sinha Knit');
    await posted('2026-10-05', [debit(RECEIVABLE, '700', owing.id), credit('1110', '700')]);
    const second = await customer(owing.id);
    const refused = await send(
      'DELETE',
      `/customers/${owing.id}?version=${String(second.version)}`,
    );
    expect(problemOf(refused).code).toBe('customer_in_use');
    expect((await supplier(owing.id)).isCustomer).toBe(true);
  });
});

describe('opening balances by supplier', () => {
  let akij: Supplier;
  let rahim: Supplier;

  beforeAll(async () => {
    akij = await addSupplier('Akij Yarn Unit');
    rahim = await addSupplier('Rahim Afrooz Packaging');
  });

  it('split the payable into one line per supplier', async () => {
    const current = openingBalancesSchema.parse((await send('GET', '/opening-balances')).json());
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: current.entry?.id ?? null,
      lines: [
        { accountId: id('1110'), partyId: '', debit: '900000', credit: '' },
        { accountId: id(PAYABLE), partyId: akij.id, debit: '', credit: '650000' },
        { accountId: id(PAYABLE), partyId: rahim.id, debit: '', credit: '48250.75' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const saved = openingBalancesSchema.parse(res.json());
    expect(saved.lines.map((line) => [line.party?.name ?? null, line.credit])).toEqual([
      [null, '0.0000'],
      ['Akij Yarn Unit', '650000.0000'],
      ['Rahim Afrooz Packaging', '48250.7500'],
    ]);
    expect((await supplier(akij.id)).balance).toBe('650000.0000');

    // The audit row counts the suppliers apart from the customers
    const log = auditPageSchema.parse(
      (await send('GET', '/audit-logs?entityType=workspace&limit=5')).json(),
    );
    const entry = log.items.find((item) => item.action === 'journal.opening_balances_saved');
    expect(entry?.changes.customers).toEqual({ from: null, to: 0 });
    expect(entry?.changes.suppliers).toEqual({ from: null, to: 2 });
  });

  it('put a customer on the payable under the row it came from', async () => {
    const current = openingBalancesSchema.parse((await send('GET', '/opening-balances')).json());
    const someone = await addCustomer('Shwapno Retail');
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: current.entry?.id ?? null,
      lines: [
        { accountId: id('1110'), partyId: '', debit: '', credit: '' },
        { accountId: id('1110'), partyId: '', debit: '5000', credit: '' },
        { accountId: id(PAYABLE), partyId: someone.id, debit: '', credit: '5000' },
      ],
    });
    expect(res.statusCode).toBe(409);
    expect(problemOf(res).fieldErrors).toEqual({ 'lines.2.partyId': ['journal_party_invalid'] });
  });
});
