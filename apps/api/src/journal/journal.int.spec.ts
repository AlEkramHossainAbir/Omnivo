import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  accountSchema,
  journalEntrySchema,
  journalPageSchema,
  ledgerPageSchema,
  memberPageSchema,
  openingBalancesSchema,
  periodLockSchema,
  problemSchema,
  roleListSchema,
  roleSchema,
  settingsSchema,
  setupSchema,
  shiftIsoDate,
  todayIn,
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
let maker: SignedIn;
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

function id(code: string): string {
  const found = accounts.find((account) => account.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found.id;
}

// A line as the form sends it: '' on the empty side
function debit(code: string, amount: string) {
  return { accountId: id(code), branchId: null, description: '', debit: amount, credit: '' };
}
function credit(code: string, amount: string) {
  return { accountId: id(code), branchId: null, description: '', debit: '', credit: amount };
}

function write(
  date: string,
  lines: object[],
  { post = true, narration = 'Test entry', as = owner } = {},
) {
  return send('POST', '/journal-entries', { date, narration, lines, post }, as);
}

async function posted(date: string, lines: object[], narration = 'Test entry') {
  const res = await write(date, lines, { narration });
  expect(res.statusCode).toBe(201);
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

  // A junior accountant: writes drafts, but may not post them (maker-checker)
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
    (await send('POST', '/roles', { name: 'Junior accountant', description: '' })).json(),
  );
  expect(
    (
      await send('PUT', '/permission-matrix', {
        roles: [
          {
            id: role.id,
            version: role.version,
            permissions: ['accounting.journal.read', 'accounting.journal.create'],
          },
        ],
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
  maker = await logIn(app, {
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

describe('writing and posting', () => {
  it('keeps a draft without a number, and numbers it when it is posted', async () => {
    const res = await write('2026-09-01', [debit('1110', '500000'), credit('3100', '500000')], {
      post: false,
      narration: 'Capital paid in by the directors',
    });
    expect(res.statusCode).toBe(201);
    const draft = journalEntrySchema.parse(res.json());
    expect(draft).toMatchObject({ status: 'draft', number: null, total: '500000.0000' });
    expect(draft.lines.map((line) => [line.debit, line.credit])).toEqual([
      ['500000.0000', '0.0000'],
      ['0.0000', '500000.0000'],
    ]);

    const post = await send('POST', `/journal-entries/${draft.id}/post`, {
      version: draft.version,
    });
    expect(post.statusCode).toBe(200);
    // Fiscal year July–June: September 2026 is in 2026-27
    expect(journalEntrySchema.parse(post.json())).toMatchObject({
      status: 'posted',
      number: 'JV-2026-27-0001',
    });

    const direct = await posted('2026-09-02', [debit('5220', '85000'), credit('1110', '85000')]);
    expect(direct.number).toBe('JV-2026-27-0002');
  });

  it('refuses to post an entry that does not balance — and "Post" then saves nothing', async () => {
    const before = journalPageSchema.parse((await send('GET', '/journal-entries')).json());
    const res = await write('2026-09-03', [debit('5230', '12000'), credit('1110', '11000')]);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('journal_unbalanced');
    const after = journalPageSchema.parse((await send('GET', '/journal-entries')).json());
    expect(after.items).toHaveLength(before.items.length);

    // As a draft it may be out of balance while it is written; posting it is refused
    const draft = journalEntrySchema.parse(
      (
        await write('2026-09-03', [debit('5230', '12000'), credit('1110', '11000')], {
          post: false,
        })
      ).json(),
    );
    const post = await send('POST', `/journal-entries/${draft.id}/post`, {
      version: draft.version,
    });
    expect(problemSchema.parse(post.json()).code).toBe('journal_unbalanced');
    // Fixed and posted in one save
    const fixed = await send('PUT', `/journal-entries/${draft.id}`, {
      date: '2026-09-03',
      narration: 'DESCO bill, September',
      lines: [debit('5230', '12000'), credit('1110', '12000')],
      post: true,
      version: draft.version,
    });
    expect(journalEntrySchema.parse(fixed.json())).toMatchObject({
      status: 'posted',
      number: 'JV-2026-27-0003',
    });
  });

  it('refuses a group or an unknown account, under the line it belongs to', async () => {
    const res = await write('2026-09-04', [
      debit('1110', '100'),
      { ...credit('1100', '100') },
      { ...credit('1110', '0'), accountId: '01939d1c-0000-7000-8000-000000000000', credit: '5' },
    ]);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      'lines.1.accountId': ['journal_account_invalid'],
      'lines.2.accountId': ['journal_account_invalid'],
    });
  });
});

describe('a posted entry', () => {
  it('is never changed: the API refuses, and so does the database', async () => {
    const entry = await posted('2026-09-05', [debit('5250', '4500'), credit('1110', '4500')]);
    const edit = await send('PUT', `/journal-entries/${entry.id}`, {
      date: entry.date,
      narration: 'Changed',
      lines: [debit('5250', '450'), credit('1110', '450')],
      post: false,
      version: entry.version,
    });
    expect(problemSchema.parse(edit.json()).code).toBe('journal_not_draft');
    const remove = await send(
      'DELETE',
      `/journal-entries/${entry.id}?version=${String(entry.version)}`,
    );
    expect(problemSchema.parse(remove.json()).code).toBe('journal_not_draft');

    // Even the superuser, past the API and RLS, cannot touch it. Only the debit line changes, so
    // every other rule (one side per line) still holds: only the trigger can refuse this.
    await superuserSql(async (sql) => {
      expect(
        await constraintOf(
          () =>
            sql`UPDATE journal_lines SET debit = 450 WHERE entry_id = ${entry.id} AND debit > 0`,
        ),
      ).toBe('journal_lines_posted_immutable');
      expect(
        await constraintOf(
          () => sql`UPDATE journal_entries SET narration = 'Changed' WHERE id = ${entry.id}`,
        ),
      ).toBe('journal_entries_posted_immutable');
      expect(
        await constraintOf(() => sql`DELETE FROM journal_entries WHERE id = ${entry.id}`),
      ).toBe('journal_entries_posted_immutable');
    });
  });

  it('must balance even when written by hand: the database checks at commit', async () => {
    const failed = await constraintOf(() =>
      superuserSql((sql) =>
        sql.begin(async (tx) => {
          const [entry] = await tx<{ id: string }[]>`
            INSERT INTO journal_entries (id, tenant_id, date, status)
            SELECT gen_random_uuid(), id, '2026-09-06', 'draft' FROM tenants
             WHERE slug = 'rahman-garments'
            RETURNING id`;
          if (!entry) throw new Error('no entry');
          // Two lines, 100 against 90: each statement is fine on its own
          await tx`
            INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_id, debit, credit)
            SELECT gen_random_uuid(), e.tenant_id, e.id, v.line_no, v.account_id::uuid, v.debit, v.credit
              FROM journal_entries e,
                   (VALUES (1, ${id('1110')}, 100, 0), (2, ${id('3100')}, 0, 90))
                     AS v(line_no, account_id, debit, credit)
             WHERE e.id = ${entry.id}`;
          await tx`
            UPDATE journal_entries SET status = 'posted', number = 'JV-HAND-1', posted_at = now()
             WHERE id = ${entry.id}`;
          // …and the imbalance is found at COMMIT
        }),
      ),
    );
    expect(failed).toBe('journal_entries_balanced');
  });

  it('is reversed once, with the sides swapped, never before its own date', async () => {
    const entry = await posted('2026-09-07', [debit('5240', '3200'), credit('1110', '3200')]);
    const early = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-09-06',
    });
    expect(problemSchema.parse(early.json()).fieldErrors).toEqual({
      date: ['journal_reversal_date'],
    });

    const res = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-09-08',
    });
    expect(res.statusCode).toBe(201);
    const reversal = journalEntrySchema.parse(res.json());
    expect(reversal).toMatchObject({
      status: 'posted',
      source: 'reversal',
      reversalOf: { id: entry.id, number: entry.number },
      narration: `Reversal of ${entry.number ?? ''}`,
    });
    expect(reversal.lines.map((line) => [line.debit, line.credit])).toEqual(
      entry.lines.map((line) => [line.credit, line.debit]),
    );
    const original = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${entry.id}`)).json(),
    );
    expect(original.reversedBy).toEqual({ id: reversal.id, number: reversal.number });

    const again = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-09-08',
    });
    expect(problemSchema.parse(again.json()).code).toBe('journal_already_reversed');
    const back = await send('POST', `/journal-entries/${reversal.id}/reverse`, {
      version: reversal.version,
      date: '2026-09-08',
    });
    expect(problemSchema.parse(back.json()).code).toBe('journal_is_reversal');
  });

  it('keeps its account: the account can be archived, not deleted', async () => {
    const bank = accountSchema.parse(
      (
        await send('POST', '/accounts', {
          parentId: id('1120'),
          code: '1121',
          name: 'Dutch-Bangla Bank CD A/C 1234',
          isGroup: false,
          description: '',
        })
      ).json(),
    );
    accounts.push(bank);
    await posted('2026-09-09', [debit('1121', '200000'), credit('1110', '200000')]);
    const res = await send('DELETE', `/accounts/${bank.id}?version=${String(bank.version)}`);
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).code).toBe('account_in_use');
  });

  it('fixes the base currency', async () => {
    const settings = settingsSchema.parse((await send('GET', '/settings')).json());
    const res = await send('PUT', '/settings', {
      version: settings.version,
      companyName: settings.companyName,
      legalName: settings.legalName ?? '',
      bin: settings.bin ?? '',
      phone: settings.phone ?? '',
      email: settings.email ?? '',
      address: settings.address ?? '',
      baseCurrency: 'USD',
      fiscalYearStartMonth: settings.fiscalYearStartMonth,
      timezone: settings.timezone,
      allowNegativeStock: settings.allowNegativeStock,
    });
    expect(res.statusCode).toBe(409);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      baseCurrency: ['base_currency_locked'],
    });
  });
});

describe('the ledger', () => {
  it('lists an account in date order, with a balance that runs on across pages', async () => {
    const tea = accountSchema.parse(
      (
        await send('POST', '/accounts', {
          parentId: id('5200'),
          code: '5290',
          name: 'Tea and entertainment',
          isGroup: false,
          description: '',
        })
      ).json(),
    );
    accounts.push(tea);
    await posted('2026-08-20', [debit('5290', '1500'), credit('1110', '1500')], 'Tea, August');
    await posted(
      '2026-09-10',
      [debit('5290', '2200.50'), credit('1110', '2200.50')],
      'Tea, September',
    );
    await posted(
      '2026-09-12',
      [debit('1110', '300'), credit('5290', '300')],
      'Refund from the canteen',
    );
    // Drafts are not in the books
    await write('2026-09-11', [debit('5290', '999'), credit('1110', '999')], { post: false });

    const first = ledgerPageSchema.parse(
      (await send('GET', `/accounts/${tea.id}/ledger?from=2026-09-01&limit=1`)).json(),
    );
    expect(first).toMatchObject({ openingBalance: '1500.0000', closingBalance: '3400.5000' });
    expect(first.items.map((line) => [line.date, line.debit, line.balance])).toEqual([
      ['2026-09-10', '2200.5000', '3700.5000'],
    ]);
    if (first.nextCursor === null) throw new Error('expected a second page');
    const second = ledgerPageSchema.parse(
      (
        await send(
          'GET',
          `/accounts/${tea.id}/ledger?from=2026-09-01&limit=1&cursor=${first.nextCursor}`,
        )
      ).json(),
    );
    expect(second.items.map((line) => [line.narration, line.credit, line.balance])).toEqual([
      ['Refund from the canteen', '300.0000', '3400.5000'],
    ]);
    expect(second.nextCursor).toBeNull();
  });
});

describe('opening balances', () => {
  it('posts them the day before go-live, with the difference in opening balance equity', async () => {
    expect(openingBalancesSchema.parse((await send('GET', '/opening-balances')).json())).toEqual({
      goLiveDate: null,
      entry: null,
      lines: [],
    });
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [
        { accountId: id('1121'), debit: '1842600.50', credit: '' },
        { accountId: id('1151'), debit: '650000', credit: '' },
        { accountId: id('2110'), debit: '', credit: '412000' },
        { accountId: id('1290'), debit: '', credit: '' },
      ],
    });
    expect(res.statusCode).toBe(200);
    const saved = openingBalancesSchema.parse(res.json());
    expect(saved.goLiveDate).toBe('2026-07-01');
    expect(saved.lines).toHaveLength(3);

    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${saved.entry?.id ?? ''}`)).json(),
    );
    // June 2026 is still the fiscal year 2025-26
    expect(entry).toMatchObject({
      date: '2026-06-30',
      source: 'opening_balance',
      total: '2492600.5000',
    });
    expect(entry.number).toMatch(/^JV-2025-26-/);
    expect(entry.lines.at(-1)).toMatchObject({ accountId: id('3300'), credit: '2080600.5000' });
  });

  it('replaces them by reversing the old entry, and refuses a stale page', async () => {
    const current = openingBalancesSchema.parse((await send('GET', '/opening-balances')).json());
    const stale = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [],
    });
    expect(problemSchema.parse(stale.json()).code).toBe('version_conflict');

    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: current.entry?.id ?? null,
      lines: [
        { accountId: id('1121'), debit: '1842600.50', credit: '' },
        { accountId: id('3100'), debit: '', credit: '1842600.50' },
      ],
    });
    const saved = openingBalancesSchema.parse(res.json());
    expect(saved.entry?.id).not.toBe(current.entry?.id);
    const old = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${current.entry?.id ?? ''}`)).json(),
    );
    expect(old.reversedBy).not.toBeNull();
    // Balanced by itself: no equity line this time
    const entry = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${saved.entry?.id ?? ''}`)).json(),
    );
    expect(entry.lines).toHaveLength(2);
  });

  it('takes balance sheet ledgers only, each once', async () => {
    const current = openingBalancesSchema.parse((await send('GET', '/opening-balances')).json());
    const res = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: current.entry?.id ?? null,
      lines: [
        { accountId: id('1110'), debit: '100', credit: '' },
        { accountId: id('4110'), debit: '', credit: '100' },
        { accountId: id('3300'), debit: '', credit: '100' },
        { accountId: id('1100'), debit: '100', credit: '' },
      ],
    });
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      'lines.1.accountId': ['opening_account_invalid'],
      'lines.2.accountId': ['opening_account_invalid'],
      'lines.3.accountId': ['opening_account_invalid'],
    });
    const twice = await send('PUT', '/opening-balances', {
      goLiveDate: '2026-07-01',
      replaces: current.entry?.id ?? null,
      lines: [
        { accountId: id('1110'), debit: '100', credit: '' },
        { accountId: id('1110'), debit: '', credit: '100' },
      ],
    });
    expect(problemSchema.parse(twice.json()).fieldErrors).toEqual({
      'lines.1.accountId': ['opening_account_twice'],
    });
  });
});

describe('permissions', () => {
  it('lets a maker write drafts, and only a poster post them', async () => {
    const draft = await write('2026-09-14', [debit('5260', '1800'), credit('1110', '1800')], {
      post: false,
      as: maker,
    });
    expect(draft.statusCode).toBe(201);
    const direct = await write('2026-09-14', [debit('5260', '1800'), credit('1110', '1800')], {
      as: maker,
    });
    expect(direct.statusCode).toBe(403);
    expect(problemSchema.parse(direct.json())).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'accounting.journal.post' },
    });
    const entry = journalEntrySchema.parse(draft.json());
    const post = await send(
      'POST',
      `/journal-entries/${entry.id}/post`,
      { version: entry.version },
      maker,
    );
    expect(post.statusCode).toBe(403);
    // The checker posts the maker's draft
    const checked = await send('POST', `/journal-entries/${entry.id}/post`, {
      version: entry.version,
    });
    expect(journalEntrySchema.parse(checked.json()).status).toBe('posted');
  });

  it('gives the Accountant role of a new workspace the whole journal', async () => {
    const { items } = roleListSchema.parse((await send('GET', '/roles')).json());
    expect(items.find((role) => role.name === 'Accountant')?.permissions).toEqual(
      expect.arrayContaining([
        'accounting.journal.read',
        'accounting.journal.create',
        'accounting.journal.post',
        'accounting.period.close',
      ]),
    );
  });
});

// Last: once the books are closed, the tests above could not post into August and September
describe('the lock date', () => {
  it('closes the books up to a day, for posting and reversing, but not in the future', async () => {
    const entry = await posted('2026-08-25', [debit('5270', '7000'), credit('1110', '7000')]);
    const future = shiftIsoDate(todayIn('Asia/Dhaka'), 1);
    const ahead = await send('PUT', '/period-lock', { lockDate: future, version: 0 });
    expect(problemSchema.parse(ahead.json()).fieldErrors).toEqual({
      lockDate: ['period_lock_future'],
    });

    const lock = await send('PUT', '/period-lock', { lockDate: '2026-08-31', version: 0 });
    expect(periodLockSchema.parse(lock.json())).toEqual({ lockDate: '2026-08-31', version: 1 });

    const late = await write('2026-08-31', [debit('5270', '100'), credit('1110', '100')]);
    expect(problemSchema.parse(late.json()).fieldErrors).toEqual({
      date: ['journal_period_locked'],
    });
    const reverse = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-08-30',
    });
    expect(problemSchema.parse(reverse.json()).code).toBe('journal_period_locked');
    // The day after is open, and a reversal can be dated there
    const open = await send('POST', `/journal-entries/${entry.id}/reverse`, {
      version: entry.version,
      date: '2026-09-01',
    });
    expect(open.statusCode).toBe(201);

    const reopen = await send('PUT', '/period-lock', { lockDate: '', version: 1 });
    expect(periodLockSchema.parse(reopen.json())).toEqual({ lockDate: null, version: 2 });
  });
});
