import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  type Account,
  accountListSchema,
  auditPageSchema,
  balanceSheetSchema,
  branchSchema,
  fiscalYearLabel,
  fiscalYearListSchema,
  fiscalYearOf,
  fiscalYearSchema,
  journalEntrySchema,
  ledgerPageSchema,
  memberPageSchema,
  type PermissionKey,
  periodLockSchema,
  problemSchema,
  profitAndLossSchema,
  type ReportSection,
  roleSchema,
  setupSchema,
  shiftIsoDate,
  todayIn,
  trialBalanceSchema,
} from '@omnivo/contracts';
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
// Reads the reports and nothing else: a director who wants the numbers, not the journal
let director: SignedIn;
// Reads the journal, but not the reports
let clerk: SignedIn;
let accounts: Account[];
let factory: string;

// Dates from today, so the test never goes stale: last fiscal year is over, this one is not.
// Bangladesh's July–June year, the default of a new workspace.
const today = todayIn('Asia/Dhaka');
const thisYear = fiscalYearOf(today, 7);
const lastYear = fiscalYearOf(shiftIsoDate(thisYear.start, -1), 7);
const yearBefore = fiscalYearOf(shiftIsoDate(lastYear.start, -1), 7);
const lastYearDay = (days: number) => shiftIsoDate(lastYear.start, days);

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

function line(code: string, debit: string, credit: string, branchId: string | null = null) {
  return { accountId: id(code), branchId, description: '', debit, credit };
}

async function post(date: string, lines: object[], narration = 'Test entry') {
  const res = await send('POST', '/journal-entries', { date, narration, lines, post: true });
  expect(res.statusCode).toBe(201);
  return journalEntrySchema.parse(res.json());
}

async function memberWith(
  person: { fullName: string; email: string; password: string; slug: string },
  permissions: PermissionKey[],
): Promise<SignedIn> {
  await signUp(app, {
    companyName: `${person.fullName} Traders`,
    workspaceSlug: person.slug,
    fullName: person.fullName,
    email: person.email,
    password: person.password,
  });
  await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'rahman-garments' });
  const role = roleSchema.parse(
    (await send('POST', '/roles', { name: `${person.fullName}'s role`, description: '' })).json(),
  );
  const matrix = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(matrix.statusCode).toBe(200);
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const member = items.find((item) => item.email === person.email);
  if (!member) throw new Error(`${person.email} is not a member`);
  const roles = await send('PUT', `/members/${member.membershipId}/roles`, {
    roleIds: [role.id],
    version: member.version,
  });
  expect(roles.statusCode).toBe(200);
  return logIn(app, {
    workspace: 'rahman-garments',
    email: person.email,
    password: person.password,
    keepSignedIn: false,
  });
}

async function trialBalance(from: string, to: string) {
  const res = await send('GET', `/reports/trial-balance?from=${from}&to=${to}`);
  expect(res.statusCode).toBe(200);
  return trialBalanceSchema.parse(res.json());
}

async function profitAndLoss(query: string) {
  const res = await send('GET', `/reports/profit-and-loss?${query}`);
  expect(res.statusCode).toBe(200);
  return profitAndLossSchema.parse(res.json());
}

async function balanceSheet(query: string) {
  const res = await send('GET', `/reports/balance-sheet?${query}`);
  expect(res.statusCode).toBe(200);
  return balanceSheetSchema.parse(res.json());
}

const rowsOf = (section: ReportSection) =>
  section.rows.map((row) => [row.code, row.depth, row.amount]);

async function years() {
  return fiscalYearListSchema.parse((await send('GET', '/fiscal-years')).json());
}

async function balanceOf(code: string, to: string): Promise<string> {
  const res = await send('GET', `/accounts/${id(code)}/ledger?to=${to}`);
  return ledgerPageSchema.parse(res.json()).closingBalance;
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
  factory = branchSchema.parse(
    (
      await send('POST', '/branches', {
        code: 'GZP',
        name: 'Gazipur factory',
        phone: '',
        address: '',
      })
    ).json(),
  ).id;

  director = await memberWith(
    {
      fullName: 'Anwar Hossain',
      email: 'anwar@rahmangarments.com',
      password: 'Director-books-2026',
      slug: 'anwar-traders',
    },
    ['accounting.report.read'],
  );
  clerk = await memberWith(
    {
      fullName: 'Nasrin Akter',
      email: 'nasrin@rahmangarments.com',
      password: 'Tongi-store-2026',
      slug: 'nasrin-traders',
    },
    ['accounting.journal.read'],
  );

  // Last fiscal year: capital, two sales and two costs. Profit: 1,450,000 − 485,000 = 965,000.
  await post(lastYearDay(0), [line('1110', '5000000', ''), line('3100', '', '5000000')]);
  await post(lastYearDay(30), [
    line('1180', '1200000', '', factory),
    line('4110', '', '1200000', factory),
  ]);
  await post(lastYearDay(40), [line('1110', '250000', ''), line('4120', '', '250000')]);
  await post(lastYearDay(60), [line('5210', '400000', ''), line('1110', '', '400000')]);
  await post(lastYearDay(61), [line('5220', '85000', ''), line('1110', '', '85000')]);
  // This year so far, on its first day (always on or before today)
  await post(thisYear.start, [line('1180', '300000', ''), line('4110', '', '300000')]);
  await post(thisYear.start, [line('5230', '18450.50', ''), line('1110', '', '18450.50')]);
  // A draft is not in the books: no report may count it
  const draft = await send('POST', '/journal-entries', {
    date: thisYear.start,
    narration: 'LC opening charges, not checked yet',
    lines: [line('5410', '2300', ''), line('1110', '', '2300')],
    post: false,
  });
  expect(draft.statusCode).toBe(201);
}, 120_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([pg.container.stop(), redis.container.stop()]);
});

describe('the trial balance', () => {
  it('shows each account once, and both sides add up to the same totals', async () => {
    const tb = await trialBalance(lastYear.start, lastYear.end);
    const cash = tb.rows.find((row) => row.code === '1110');
    expect(cash).toMatchObject({
      opening: '0.0000',
      debit: '5250000.0000',
      credit: '485000.0000',
      closing: '4765000.0000',
    });
    // A credit balance is negative, like the ledger
    expect(tb.rows.find((row) => row.code === '3100')?.closing).toBe('-5000000.0000');
    expect(tb.rows.map((row) => row.code)).toEqual([
      '1110',
      '1180',
      '3100',
      '4110',
      '4120',
      '5210',
      '5220',
    ]);
    expect(tb.totals.debit).toBe(tb.totals.credit);
    expect(tb.totals.closingDebit).toBe(tb.totals.closingCredit);
    // 4,765,000 cash + 1,200,000 receivable + 485,000 costs = 5,000,000 capital + 1,450,000 sales
    expect(tb.totals.closingDebit).toBe('6450000.0000');
  });

  it('carries what came before the range in the opening column', async () => {
    const tb = await trialBalance(thisYear.start, today);
    expect(tb.rows.find((row) => row.code === '1110')).toMatchObject({
      opening: '4765000.0000',
      debit: '0.0000',
      credit: '18450.5000',
      closing: '4746549.5000',
    });
    expect(tb.totals.openingDebit).toBe(tb.totals.openingCredit);
    // The draft's bank charges are nowhere
    expect(tb.rows.map((row) => row.code)).not.toContain('5410');
  });

  it('refuses a range that ends before it starts', async () => {
    const res = await send('GET', `/reports/trial-balance?from=${today}&to=${lastYear.start}`);
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({ to: ['report_range_invalid'] });
  });
});

describe('the profit and loss', () => {
  it('sums the groups and leaves out the accounts that did not move', async () => {
    const pl = await profitAndLoss(`from=${lastYear.start}&to=${lastYear.end}`);
    expect(rowsOf(pl.income)).toEqual([
      ['4100', 0, '1450000.0000'],
      ['4110', 1, '1200000.0000'],
      ['4120', 1, '250000.0000'],
    ]);
    expect(rowsOf(pl.expense)).toEqual([
      ['5200', 0, '485000.0000'],
      ['5210', 1, '400000.0000'],
      ['5220', 1, '85000.0000'],
    ]);
    expect(pl.netProfit).toBe('965000.0000');
    expect(pl.compareNetProfit).toBeNull();
  });

  it('puts a second period next to the first', async () => {
    const pl = await profitAndLoss(
      `from=${thisYear.start}&to=${today}&compareFrom=${lastYear.start}&compareTo=${lastYear.end}`,
    );
    expect(pl.netProfit).toBe('281549.5000');
    expect(pl.compareNetProfit).toBe('965000.0000');
    // 4120 only moved last year: it shows, with zero this year
    expect(pl.income.rows.find((row) => row.code === '4120')).toMatchObject({
      amount: '0.0000',
      compareAmount: '250000.0000',
    });
  });

  it("counts only a branch's own lines when one is picked", async () => {
    const pl = await profitAndLoss(`from=${lastYear.start}&to=${lastYear.end}&branchId=${factory}`);
    expect(rowsOf(pl.income)).toEqual([
      ['4100', 0, '1200000.0000'],
      ['4110', 1, '1200000.0000'],
    ]);
    expect(pl.expense.rows).toEqual([]);
    expect(pl.netProfit).toBe('1200000.0000');
  });

  it('needs both comparison dates', async () => {
    const res = await send(
      'GET',
      `/reports/profit-and-loss?from=${thisYear.start}&to=${today}&compareFrom=${lastYear.start}`,
    );
    expect(res.statusCode).toBe(400);
    expect(problemSchema.parse(res.json()).fieldErrors).toEqual({
      compareFrom: ['report_compare_incomplete'],
    });
  });
});

describe('the balance sheet', () => {
  it('balances with the profit that is not closed yet', async () => {
    const bs = await balanceSheet(`asOf=${lastYear.end}`);
    expect(rowsOf(bs.asset)).toEqual([
      ['1100', 0, '5965000.0000'],
      ['1110', 1, '4765000.0000'],
      ['1180', 1, '1200000.0000'],
    ]);
    expect(bs.liability.total).toBe('0.0000');
    expect(rowsOf(bs.equity)).toEqual([['3100', 0, '5000000.0000']]);
    expect(bs.profitNotClosed).toBe('965000.0000');
    expect(bs.liabilitiesAndEquity).toBe(bs.asset.total);
  });

  it('compares two days', async () => {
    const bs = await balanceSheet(`asOf=${today}&compareAsOf=${lastYear.end}`);
    expect(bs.asset.total).toBe('6246549.5000');
    expect(bs.asset.compareTotal).toBe('5965000.0000');
    expect(bs.compareLiabilitiesAndEquity).toBe('5965000.0000');
    expect(bs.liabilitiesAndEquity).toBe(bs.asset.total);
  });
});

describe('who reads the reports', () => {
  it('lets a member with the report permission read them, without the journal', async () => {
    const tb = await send(
      'GET',
      `/reports/trial-balance?from=${lastYear.start}&to=${lastYear.end}`,
      undefined,
      director,
    );
    expect(tb.statusCode).toBe(200);
    expect((await send('GET', '/journal-entries', undefined, director)).statusCode).toBe(403);
    const close = await send('POST', '/fiscal-years/close', { end: lastYear.end }, director);
    expect(close.statusCode).toBe(403);
  });

  it('keeps the reports from a member who only reads the journal', async () => {
    const res = await send('GET', `/reports/balance-sheet?asOf=${today}`, undefined, clerk);
    expect(res.statusCode).toBe(403);
    expect(problemSchema.parse(res.json()).params).toEqual({
      permissions: 'accounting.report.read',
    });
  });
});

describe('closing a fiscal year', () => {
  it('refuses a year that has not ended, and a day that does not end a year', async () => {
    const open = await send('POST', '/fiscal-years/close', { end: thisYear.end });
    expect(problemSchema.parse(open.json()).code).toBe('year_not_ended');
    const wrong = await send('POST', '/fiscal-years/close', { end: lastYearDay(10) });
    expect(wrong.statusCode).toBe(409);
    expect(problemSchema.parse(wrong.json()).fieldErrors).toEqual({ end: ['year_end_invalid'] });
  });

  it('refuses while a draft is dated in the year', async () => {
    const draft = journalEntrySchema.parse(
      (
        await send('POST', '/journal-entries', {
          date: lastYearDay(100),
          narration: 'LC charges, not checked yet',
          lines: [line('5410', '2300', ''), line('1110', '', '2300')],
          post: false,
        })
      ).json(),
    );
    const res = await send('POST', '/fiscal-years/close', { end: lastYear.end });
    expect(problemSchema.parse(res.json())).toMatchObject({
      code: 'year_has_drafts',
      params: { count: 1 },
    });
    expect(
      (await send('DELETE', `/journal-entries/${draft.id}?version=${String(draft.version)}`))
        .statusCode,
    ).toBe(204);
  });

  it('moves the profit into retained earnings and closes the books up to the last day', async () => {
    const res = await send('POST', '/fiscal-years/close', { end: lastYear.end });
    expect(res.statusCode).toBe(200);
    const year = fiscalYearSchema.parse(res.json());
    expect(year).toMatchObject({ status: 'closed', netProfit: '965000.0000', drafts: 0 });
    expect(year.closingEntry?.number).toMatch(/^JV-\d{4}-\d{2}-\d{4}$/);

    const closing = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${year.closingEntry?.id ?? ''}`)).json(),
    );
    expect(closing).toMatchObject({ source: 'year_close', date: lastYear.end, status: 'posted' });
    // Income and expenses are empty at the year end; the profit sits in retained earnings
    expect(await balanceOf('4110', lastYear.end)).toBe('0.0000');
    expect(await balanceOf('5210', lastYear.end)).toBe('0.0000');
    expect(await balanceOf('3200', lastYear.end)).toBe('-965000.0000');

    const list = await years();
    expect(list.lockDate).toBe(lastYear.end);
    expect(list.items.map((item) => [item.label, item.status])).toEqual([
      [fiscalYearLabel(thisYear.start, 7), 'open'],
      [fiscalYearLabel(lastYear.start, 7), 'closed'],
    ]);
  });

  it('still reports the closed year with its profit, and the balance sheet still balances', async () => {
    const pl = await profitAndLoss(`from=${lastYear.start}&to=${lastYear.end}`);
    expect(pl.netProfit).toBe('965000.0000');
    const bs = await balanceSheet(`asOf=${lastYear.end}`);
    expect(bs.profitNotClosed).toBe('0.0000');
    expect(rowsOf(bs.equity)).toEqual([
      ['3100', 0, '5000000.0000'],
      ['3200', 0, '965000.0000'],
    ]);
    expect(bs.liabilitiesAndEquity).toBe(bs.asset.total);
  });

  it('keeps the closed year shut: no posting into it, no second close, no reversal by hand', async () => {
    const late = await send('POST', '/journal-entries', {
      date: lastYearDay(200),
      narration: 'Forgotten bill',
      lines: [line('5220', '1000', ''), line('1110', '', '1000')],
      post: true,
    });
    expect(problemSchema.parse(late.json()).code).toBe('journal_period_locked');
    const again = await send('POST', '/fiscal-years/close', { end: lastYear.end });
    expect(problemSchema.parse(again.json()).code).toBe('year_already_closed');

    const closingId = (await years()).items[1]?.closingEntry?.id ?? '';
    const closing = journalEntrySchema.parse(
      (await send('GET', `/journal-entries/${closingId}`)).json(),
    );
    const reverse = await send('POST', `/journal-entries/${closingId}/reverse`, {
      version: closing.version,
      date: today,
    });
    expect(problemSchema.parse(reverse.json()).code).toBe('journal_is_year_close');
  });

  it('reopens the year: the closing entry is reversed on its own day, and the books open again', async () => {
    const res = await send('POST', '/fiscal-years/reopen', { end: lastYear.end });
    expect(res.statusCode).toBe(200);
    expect(fiscalYearSchema.parse(res.json())).toMatchObject({
      status: 'open',
      closingEntry: null,
      netProfit: '965000.0000',
    });
    expect(await balanceOf('4110', lastYear.end)).toBe('-1200000.0000');
    expect(await balanceOf('3200', lastYear.end)).toBe('0.0000');
    expect((await years()).lockDate).toBe(yearBefore.end);
    // The reversal is not income or expense either: the profit stays the same
    const pl = await profitAndLoss(`from=${lastYear.start}&to=${lastYear.end}`);
    expect(pl.netProfit).toBe('965000.0000');
  });

  it('closes years in order and reopens them backwards', async () => {
    // A cost in the year before, which nobody closed: open the books to post it
    const lock = periodLockSchema.parse((await send('GET', '/period-lock')).json());
    expect(
      (await send('PUT', '/period-lock', { lockDate: '', version: lock.version })).statusCode,
    ).toBe(200);
    await post(shiftIsoDate(yearBefore.end, -5), [
      line('5410', '1500', ''),
      line('2150', '', '1500'),
    ]);
    // Archived since: the closing entry must still empty it (archiving hides an account from new
    // work, it does not take its balance away)
    const bankCharges = accounts.find((account) => account.code === '5410');
    const archive = await send('POST', `/accounts/${id('5410')}/archive`, {
      version: bankCharges?.version ?? 1,
    });
    expect(archive.statusCode).toBe(200);

    const skipped = await send('POST', '/fiscal-years/close', { end: lastYear.end });
    expect(problemSchema.parse(skipped.json()).code).toBe('year_earlier_open');

    const first = await send('POST', '/fiscal-years/close', { end: yearBefore.end });
    expect(fiscalYearSchema.parse(first.json())).toMatchObject({
      status: 'closed',
      netProfit: '-1500.0000',
    });
    expect(await balanceOf('3200', yearBefore.end)).toBe('1500.0000');
    const second = await send('POST', '/fiscal-years/close', { end: lastYear.end });
    expect(fiscalYearSchema.parse(second.json()).status).toBe('closed');
    expect(await balanceOf('3200', lastYear.end)).toBe('-963500.0000');
  });

  it('reopens only the latest closed year', async () => {
    const backwards = await send('POST', '/fiscal-years/reopen', { end: yearBefore.end });
    expect(problemSchema.parse(backwards.json()).code).toBe('year_later_closed');
    const notClosed = await send('POST', '/fiscal-years/reopen', { end: thisYear.end });
    expect(problemSchema.parse(notClosed.json()).code).toBe('year_not_closed');
  });

  it('logs the close and the reopen in the audit log', async () => {
    const res = await send('GET', '/audit-logs?entityType=workspace&limit=100');
    const actions = auditPageSchema.parse(res.json()).items.map((item) => item.action);
    expect(actions).toEqual(expect.arrayContaining(['books.year_closed', 'books.year_reopened']));
  });
});
