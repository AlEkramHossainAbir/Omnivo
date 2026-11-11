import { randomUUID } from 'node:crypto';
import type { INestApplicationContext } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  auditPageSchema,
  branchListSchema,
  memberPageSchema,
  nextReportScheduleRun,
  notificationPageSchema,
  type PermissionKey,
  problemSchema,
  reportExportPageSchema,
  type ReportSchedule,
  reportScheduleCandidateListSchema,
  reportScheduleListSchema,
  reportScheduleSchema,
  type ReportScheduleWhen,
  roleListSchema,
  roleSchema,
  setupSchema,
  shiftIsoDate,
  todayIn,
} from '@omnivo/contracts';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type OutboxEvent, PermanentJobError } from '../common/outbox/outbox.js';
import { runWithTenant } from '../common/tenant/tenant-context.js';
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
  startStorage,
  type TestMail,
  type TestPostgres,
  type TestRedis,
  type TestStorage,
} from '../testing/containers.js';
import { bearer, logIn, type SignedIn, signUp } from '../testing/http.js';
import { lastMailTo } from '../testing/mailpit.js';
import { joinWithoutRoles } from '../testing/workspace.js';
import { formatIsoDate } from './export/format.js';
import {
  MAX_REPORT_ATTACHMENT_BYTES,
  ReportScheduleEmailHandler,
} from './report-schedule-email.handler.js';
import { exportIdFor, ReportScheduleRunHandler } from './report-schedule-run.handler.js';
import { ReportScheduleSweep } from './report-schedule-sweep.js';

// Step 21c. Karnaphuli Pharma Distributors in Chattogram sends its reports by email. The API part
// saves, checks and changes schedules; the worker part runs them against a real database, Redis,
// MinIO and Mailpit, with the clock moved by hand: the sweep takes the moment it runs as an
// argument, so a test can say "it is now 08:01 on the day of the run" without waiting for it.
let pg: TestPostgres;
let redis: TestRedis;
let storage: TestStorage;
let mail: TestMail;
let app: NestFastifyApplication;
let worker: INestApplicationContext;
let tenantId: string;
let branchName: string;
let branchId: string;

const TIME_ZONE = 'Asia/Dhaka';
const COMPANY = 'Karnaphuli Pharma Distributors';

interface Person {
  session: SignedIn;
  userId: string;
  email: string;
  // The role made for this person, so a test can take its permissions away
  roleId: string | null;
}

let owner: Person;
// The accountant: reads the accounting reports, manages the schedules, reads Bangla
let mitu: Person;
// The sales manager: the sales report only, and the schedules of it
let sohel: Person;
// Reads the accounting reports, may not manage schedules
let rina: Person;
// A member with no role at all
let babul: Person;
// Someone with a workspace of their own, not a member here
let strangerId: string;

const today = todayIn(TIME_ZONE);

function send(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: object,
  as: SignedIn = owner.session,
) {
  return app.inject({ method, url, headers: bearer(as.accessToken), ...(payload && { payload }) });
}

function problemOf(res: Awaited<ReturnType<typeof send>>) {
  return problemSchema.parse(res.json());
}

// An outbox event's id as the database writes it: a UUIDv7 with this moment in its first 48 bits,
// which exportIdFor() keeps, so the files of a test's run sort with the others
function v7(): string {
  const time = Date.now().toString(16).padStart(12, '0');
  const random = randomUUID();
  return `${time.slice(0, 8)}-${time.slice(8, 12)}-7${random.slice(15, 18)}-${random.slice(19)}`;
}

async function superuserSql<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

// A schedule of the trial balance, the report every accountant has: no documents needed
function trialBalance(
  when: ReportScheduleWhen,
  recipientIds: string[],
  extra: { format?: 'pdf' | 'xlsx'; query?: Record<string, string> } = {},
) {
  return {
    report: 'trial_balance',
    format: extra.format ?? 'pdf',
    query: { from: shiftIsoDate(today, -30), to: today, ...extra.query },
    when,
    recipientIds,
  };
}

async function schedule(body: object, as: SignedIn = owner.session): Promise<ReportSchedule> {
  const res = await send('POST', '/report-schedules', body, as);
  expect(res.statusCode, res.body).toBe(201);
  return reportScheduleSchema.parse(res.json());
}

async function schedulesOf(as: SignedIn = owner.session): Promise<ReportSchedule[]> {
  const res = await send('GET', '/report-schedules', undefined, as);
  expect(res.statusCode, res.body).toBe(200);
  return reportScheduleListSchema.parse(res.json()).items;
}

async function current(id: string): Promise<ReportSchedule> {
  const found = (await schedulesOf()).find((item) => item.id === id);
  if (!found) throw new Error(`schedule ${id} is not listed`);
  return found;
}

async function auditOf(id: string) {
  const res = await send('GET', `/audit-logs?entityType=report_schedule&entityId=${id}`);
  expect(res.statusCode, res.body).toBe(200);
  // Newest first; the test reads them oldest first
  return auditPageSchema.parse(res.json()).items.toReversed();
}

async function bellsOf(person: Person) {
  const res = await send('GET', '/notifications', undefined, person.session);
  return notificationPageSchema
    .parse(res.json())
    .items.filter((item) => item.type.startsWith('report.schedule_'));
}

// A member with one new role of exactly these permissions; [] = no role at all
async function memberWith(
  person: { fullName: string; email: string; password: string },
  permissions: PermissionKey[],
): Promise<Person> {
  await signUp(app, {
    companyName: `${person.fullName} Store`,
    workspaceSlug: `${person.email.split('@')[0] ?? 'member'}-store`,
    ...person,
  });
  await joinWithoutRoles(pg.superuserUrl, { email: person.email, workspace: 'karnaphuli-pharma' });
  const { items } = memberPageSchema.parse((await send('GET', '/members')).json());
  const found = items.find((item) => item.email === person.email);
  if (!found) throw new Error(`${person.email} is not a member`);
  let roleId: string | null = null;
  if (permissions.length > 0) {
    const role = roleSchema.parse(
      (await send('POST', '/roles', { name: `${person.fullName}'s role`, description: '' })).json(),
    );
    roleId = role.id;
    await setPermissions(role.id, permissions);
    const roles = await send('PUT', `/members/${found.membershipId}/roles`, {
      roleIds: [role.id],
      version: found.version,
    });
    expect(roles.statusCode, roles.body).toBe(200);
  }
  const session = await logIn(app, {
    workspace: 'karnaphuli-pharma',
    email: person.email,
    password: person.password,
    keepSignedIn: false,
  });
  return { session, userId: found.userId, email: person.email, roleId };
}

async function setPermissions(roleId: string, permissions: PermissionKey[]): Promise<void> {
  const role = roleListSchema
    .parse((await send('GET', '/roles')).json())
    .items.find((item) => item.id === roleId);
  if (!role) throw new Error(`no role ${roleId}`);
  const res = await send('PUT', '/permission-matrix', {
    roles: [{ id: role.id, version: role.version, permissions }],
  });
  expect(res.statusCode, res.body).toBe(200);
}

beforeAll(async () => {
  [pg, redis, storage, mail] = await Promise.all([
    startPostgres(),
    startRedis(),
    startStorage(),
    startMail(),
  ]);
  app = await createTestApp(
    testConfig({ databaseUrl: pg.appUrl, redisUrl: redis.url, storageUrl: storage.url }),
  );
  worker = await createTestWorker(
    testWorkerConfig({
      databaseUrl: pg.appUrl,
      workerDatabaseUrl: pg.workerUrl,
      redisUrl: redis.url,
      storageUrl: storage.url,
      mailUrl: mail.smtpUrl,
    }),
  );
  const ownerSession = await signUp(app, {
    companyName: COMPANY,
    workspaceSlug: 'karnaphuli-pharma',
    fullName: 'Jahid Hasan',
    email: 'jahid@karnaphulipharma.com',
    password: 'Agrabad-depot-2026',
  });
  owner = { session: ownerSession, userId: '', email: 'jahid@karnaphulipharma.com', roleId: null };
  expect((await send('POST', '/setup', { industry: 'distribution' })).statusCode).toBe(200);
  await eventually(async () => {
    expect(setupSchema.parse((await send('GET', '/setup')).json()).status).toBe('ready');
  });
  const members = memberPageSchema.parse((await send('GET', '/members')).json()).items;
  owner.userId = members.find((item) => item.email === owner.email)?.userId ?? '';
  const [branch] = branchListSchema.parse((await send('GET', '/branches')).json()).items;
  if (!branch) throw new Error('sign-up made no branch');
  branchId = branch.id;
  branchName = `${branch.code} · ${branch.name}`;
  tenantId = await superuserSql(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      SELECT id FROM tenants WHERE slug = 'karnaphuli-pharma'`;
    if (!row) throw new Error('no tenant');
    return row.id;
  });

  mitu = await memberWith(
    { fullName: 'Mitu Barua', email: 'mitu@karnaphulipharma.com', password: 'Ledger-desk-2026' },
    ['accounting.report.read', 'core.report.schedule'],
  );
  const bangla = await send('PATCH', '/me/preferences', { language: 'bn' }, mitu.session);
  expect(bangla.statusCode, bangla.body).toBe(200);
  sohel = await memberWith(
    { fullName: 'Sohel Rana', email: 'sohel@karnaphulipharma.com', password: 'Sales-floor-2026' },
    ['sales.report.read', 'core.report.schedule'],
  );
  rina = await memberWith(
    { fullName: 'Rina Das', email: 'rina@karnaphulipharma.com', password: 'Books-only-2026' },
    ['accounting.report.read'],
  );
  babul = await memberWith(
    { fullName: 'Babul Mia', email: 'babul@karnaphulipharma.com', password: 'Store-keeper-2026' },
    [],
  );
  // Nasrin signs up for her own workspace and never joins this one
  const nasrin = await signUp(app, {
    companyName: 'Nasrin Traders',
    workspaceSlug: 'nasrin-traders',
    fullName: 'Nasrin Akter',
    email: 'nasrin@nasrintraders.com',
    password: 'Tongi-store-2026',
  });
  strangerId =
    memberPageSchema
      .parse((await send('GET', '/members', undefined, nasrin)).json())
      .items.find((item) => item.email === 'nasrin@nasrintraders.com')?.userId ?? '';
  expect(strangerId).not.toBe('');
}, 240_000);

afterAll(async () => {
  await worker.close();
  await app.close();
  await Promise.all([
    pg.container.stop(),
    redis.container.stop(),
    storage.container.stop(),
    mail.container.stop(),
  ]);
});

describe('Scheduling a report', () => {
  const monthly: ReportScheduleWhen = { frequency: 'monthly', hour: 8, dayOfMonth: 1 };
  let vatSchedule: ReportSchedule;

  it('keeps the filters without the dates, and works out the first run', async () => {
    const before = new Date();
    vatSchedule = await schedule({
      report: 'vat_report',
      format: 'pdf',
      query: { from: shiftIsoDate(today, -30), to: today, branchId },
      when: monthly,
      recipientIds: [owner.userId, mitu.userId],
    });
    expect(vatSchedule).toMatchObject({
      version: 1,
      report: 'vat_report',
      format: 'pdf',
      when: monthly,
      // decision 29: each run works out its own dates
      filters: { branchId },
      filterNames: { branch: branchName, warehouse: null, group: null, category: null },
      recipients: [
        { userId: owner.userId, name: 'Jahid Hasan', canReceive: true },
        { userId: mitu.userId, name: 'Mitu Barua', canReceive: true },
      ],
      status: 'active',
      pausedReason: null,
      lastRunAt: null,
      createdByName: 'Jahid Hasan',
    });
    // 08:00 on the next 1st, in Dhaka: worked out from the moment it was saved
    expect(vatSchedule.nextRunAt).toBe(
      nextReportScheduleRun(monthly, TIME_ZONE, before).toISOString(),
    );
    const [created] = await auditOf(vatSchedule.id);
    expect(created).toMatchObject({
      action: 'report_schedule.created',
      actor: { fullName: 'Jahid Hasan' },
      changes: {
        report: { from: null, to: 'vat_report' },
        recipients: { from: null, to: `${owner.userId}, ${mitu.userId}` },
      },
    });
    const { timeZone } = reportScheduleListSchema.parse(
      (await send('GET', '/report-schedules')).json(),
    );
    expect(timeZone).toBe(TIME_ZONE);
  });

  it('offers only the members who may read the report', async () => {
    const namesFor = async (report: string) => {
      const res = await send('GET', `/report-schedules/recipients?report=${report}`);
      expect(res.statusCode, res.body).toBe(200);
      return reportScheduleCandidateListSchema.parse(res.json()).items.map((item) => item.name);
    };
    // By name; Babul has no role, Nasrin is not a member
    expect(await namesFor('vat_report')).toEqual(['Jahid Hasan', 'Mitu Barua', 'Rina Das']);
    expect(await namesFor('sales_report')).toEqual(['Jahid Hasan', 'Sohel Rana']);
  });

  it('refuses a member who may not read it, a stranger, the same person twice and too many', async () => {
    for (const recipientIds of [[owner.userId, babul.userId], [strangerId], [randomUUID()]]) {
      const res = await send('POST', '/report-schedules', trialBalance(monthly, recipientIds));
      expect(res.statusCode).toBe(409);
      expect(problemOf(res)).toMatchObject({
        code: 'report_schedule_recipient_invalid',
        fieldErrors: { recipientIds: ['report_schedule_recipient_invalid'] },
      });
    }
    // These the contract refuses before the database is asked
    for (const [recipientIds, code] of [
      [[mitu.userId, mitu.userId], 'report_schedule_recipient_invalid'],
      [[], 'report_schedule_recipients_needed'],
      [Array.from({ length: 11 }, () => randomUUID()), 'report_schedule_recipients_too_many'],
    ] as const) {
      const res = await send('POST', '/report-schedules', trialBalance(monthly, [...recipientIds]));
      expect(res.statusCode).toBe(400);
      expect(problemOf(res).fieldErrors).toEqual({ recipientIds: [code] });
    }
    // A whole hour only (decision 13)
    const halfPast = await send(
      'POST',
      '/report-schedules',
      trialBalance({ frequency: 'daily', hour: 8.5 }, [owner.userId]),
    );
    expect(halfPast.statusCode).toBe(400);
    // Nothing was saved
    expect((await schedulesOf()).map((item) => item.id)).toEqual([vatSchedule.id]);
  });

  it("needs the schedules permission and the report's own", async () => {
    // Rina reads the report but may not manage schedules
    expect((await send('GET', '/report-schedules', undefined, rina.session)).statusCode).toBe(403);
    // Sohel manages schedules, but may not read the VAT report
    const vat = await send(
      'POST',
      '/report-schedules',
      { ...trialBalance(monthly, [sohel.userId]), report: 'vat_report' },
      sohel.session,
    );
    expect(vat.statusCode).toBe(403);
    expect(problemOf(vat)).toMatchObject({
      code: 'permission_missing',
      params: { permissions: 'accounting.report.read' },
    });
    // His own sales report, weekly on Sunday at 09:00
    const sales = await schedule(
      {
        report: 'sales_report',
        format: 'xlsx',
        query: { from: shiftIsoDate(today, -6), to: today, groupBy: 'product', sort: 'name' },
        when: { frequency: 'weekly', hour: 9, weekday: 0 },
        recipientIds: [sohel.userId, owner.userId],
      },
      sohel.session,
    );
    expect(sales.filters).toEqual({ groupBy: 'product', sort: 'name' });
    // The list leaves out the reports he may not read; the owner sees both
    expect((await schedulesOf(sohel.session)).map((item) => item.report)).toEqual(['sales_report']);
    expect((await schedulesOf()).map((item) => item.report)).toEqual([
      'vat_report',
      'sales_report',
    ]);
    // A schedule he cannot see, he cannot change either
    const change = await send(
      'POST',
      `/report-schedules/${vatSchedule.id}/pause`,
      { version: vatSchedule.version },
      sohel.session,
    );
    expect(change.statusCode).toBe(403);
    // The order of the rows would tell the cost he may not see (as for an export)
    const byMargin = await send(
      'POST',
      '/report-schedules',
      {
        report: 'sales_report',
        format: 'pdf',
        query: { from: today, to: today, sort: '-margin' },
        when: monthly,
        recipientIds: [sohel.userId],
      },
      sohel.session,
    );
    expect(byMargin.statusCode).toBe(403);
    expect(problemOf(byMargin).params).toEqual({ permissions: 'inventory.stock.value' });
  });

  it('changes the format, the time and the people, never the filters', async () => {
    const before = new Date();
    const res = await send('PUT', `/report-schedules/${vatSchedule.id}`, {
      format: 'xlsx',
      when: { frequency: 'monthly', hour: 10, dayOfMonth: 5 },
      recipientIds: [mitu.userId, rina.userId],
      version: vatSchedule.version,
    });
    expect(res.statusCode, res.body).toBe(200);
    const changed = reportScheduleSchema.parse(res.json());
    expect(changed).toMatchObject({
      version: 2,
      format: 'xlsx',
      filters: { branchId },
      recipients: [{ name: 'Mitu Barua' }, { name: 'Rina Das' }],
    });
    expect(changed.nextRunAt).toBe(
      nextReportScheduleRun(
        { frequency: 'monthly', hour: 10, dayOfMonth: 5 },
        TIME_ZONE,
        before,
      ).toISOString(),
    );
    // Saved over by someone else meanwhile: the old version is refused
    const stale = await send('PUT', `/report-schedules/${vatSchedule.id}`, {
      format: 'pdf',
      when: monthly,
      recipientIds: [mitu.userId],
      version: vatSchedule.version,
    });
    expect(stale.statusCode).toBe(409);
    expect(problemOf(stale).code).toBe('version_conflict');
    expect((await auditOf(vatSchedule.id)).map((entry) => entry.action)).toEqual([
      'report_schedule.created',
      'report_schedule.updated',
    ]);
    vatSchedule = changed;
  });

  it('pauses with no next run, and resumes from now', async () => {
    const paused = reportScheduleSchema.parse(
      (
        await send('POST', `/report-schedules/${vatSchedule.id}/pause`, {
          version: vatSchedule.version,
        })
      ).json(),
    );
    expect(paused).toMatchObject({
      version: 3,
      status: 'paused',
      pausedReason: 'manual',
      nextRunAt: null,
    });
    // Already paused: nothing changes, not even the version
    const again = await send('POST', `/report-schedules/${vatSchedule.id}/pause`, {
      version: paused.version,
    });
    expect(reportScheduleSchema.parse(again.json()).version).toBe(3);
    const before = new Date();
    const resumed = reportScheduleSchema.parse(
      (
        await send('POST', `/report-schedules/${vatSchedule.id}/resume`, {
          version: paused.version,
        })
      ).json(),
    );
    expect(resumed).toMatchObject({ version: 4, status: 'active', pausedReason: null });
    expect(resumed.nextRunAt).toBe(
      nextReportScheduleRun(vatSchedule.when, TIME_ZONE, before).toISOString(),
    );
    vatSchedule = resumed;
  });

  it('refuses to resume while nobody on it may read the report', async () => {
    const onlyRina = await schedule(trialBalance(monthly, [rina.userId]));
    const pause = await send('POST', `/report-schedules/${onlyRina.id}/pause`, {
      version: onlyRina.version,
    });
    expect(pause.statusCode, pause.body).toBe(200);
    if (rina.roleId === null) throw new Error('Rina has no role');
    await setPermissions(rina.roleId, []);
    // The list says she would get nothing
    expect((await current(onlyRina.id)).recipients).toEqual([
      expect.objectContaining({ name: 'Rina Das', canReceive: false }),
    ]);
    const refused = await send('POST', `/report-schedules/${onlyRina.id}/resume`, {
      version: onlyRina.version + 1,
    });
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused).code).toBe('report_schedule_no_recipients');
    await setPermissions(rina.roleId, ['accounting.report.read']);
    const resumed = await send('POST', `/report-schedules/${onlyRina.id}/resume`, {
      version: onlyRina.version + 1,
    });
    expect(resumed.statusCode, resumed.body).toBe(200);
  });

  it('keeps at most 20 in a workspace, even when they are saved at the same moment', async () => {
    // In Sohel's own workspace, where he is the owner and has none yet
    const own = await logIn(app, {
      workspace: 'sohel-store',
      email: 'sohel@karnaphulipharma.com',
      password: 'Sales-floor-2026',
      keepSignedIn: false,
    });
    const [me] = memberPageSchema.parse(
      (await send('GET', '/members', undefined, own)).json(),
    ).items;
    if (!me) throw new Error('Sohel is not in his own workspace');
    const answers = await Promise.all(
      Array.from({ length: 25 }, () =>
        send(
          'POST',
          '/report-schedules',
          trialBalance({ frequency: 'daily', hour: 7 }, [me.userId]),
          own,
        ),
      ),
    );
    const codes = answers.map((res) => res.statusCode);
    expect(codes.filter((code) => code === 201)).toHaveLength(20);
    expect(codes.filter((code) => code === 409)).toHaveLength(5);
    expect(
      answers.filter((res) => res.statusCode === 409).map((res) => problemOf(res).code),
    ).toEqual(Array.from({ length: 5 }, () => 'report_schedule_limit'));
    // Cleared again, so the worker's tests below find only this workspace's schedules
    for (const item of await schedulesOf(own)) {
      expect(
        (await send('DELETE', `/report-schedules/${item.id}`, undefined, own)).statusCode,
      ).toBe(204);
    }
    expect(await schedulesOf(own)).toEqual([]);
  });

  it('deletes a schedule for good, and the audit log keeps what it was', async () => {
    for (const item of await schedulesOf()) {
      const res = await send('DELETE', `/report-schedules/${item.id}`);
      expect(res.statusCode, res.body).toBe(204);
    }
    expect(await schedulesOf()).toEqual([]);
    const deleted = (await auditOf(vatSchedule.id)).at(-1);
    expect(deleted).toMatchObject({
      action: 'report_schedule.deleted',
      changes: { report: { from: 'vat_report', to: null }, status: { from: 'active', to: null } },
    });
    // Gone: a change to it is 404, like an id that never was
    const gone = await send('POST', `/report-schedules/${vatSchedule.id}/pause`, {
      version: vatSchedule.version,
    });
    expect(gone.statusCode).toBe(404);
  });
});

describe('Running the schedules', () => {
  // The daily trial balance at 08:00, to the owner and to Mitu (in Bangla)
  let daily: ReportSchedule;
  let sweep: ReportScheduleSweep;
  let runs: ReportScheduleRunHandler;
  let emails: ReportScheduleEmailHandler;

  const minute = 60_000;
  const later = (iso: string | null, ms: number) => {
    if (iso === null) throw new Error('no next run');
    return new Date(new Date(iso).getTime() + ms);
  };
  // A monthly day at least a week away: never due in the sweeps below, which look at most 4 days
  // ahead. The 28th at most, as the contract allows.
  const farDay = () => Math.min(Number(shiftIsoDate(today, 10).slice(8, 10)), 28);

  // The period of a daily run: the day before the day it runs, in Dhaka
  const dayBefore = (runAt: Date) => shiftIsoDate(todayIn(TIME_ZONE, runAt), -1);

  function dueEvent(scheduleId: string, runAt: Date): OutboxEvent<'report.schedule_due'> {
    return {
      id: v7(),
      tenantId,
      type: 'report.schedule_due',
      payload: { scheduleId, runAt: runAt.toISOString() },
      requestId: null,
    };
  }

  const run = (event: OutboxEvent<'report.schedule_due'>) =>
    runWithTenant(tenantId, () => runs.handle(event));

  async function exportsOf(person: Person) {
    const res = await send('GET', '/report-exports', undefined, person.session);
    return reportExportPageSchema.parse(res.json()).items;
  }

  // How many emails this person has had (the welcome email of their sign-up too)
  const mailboxSchema = z.object({
    messages: z.array(z.object({ To: z.array(z.object({ Address: z.string() })) })),
  });
  async function mailsTo(person: Person): Promise<number> {
    const res = await fetch(`${mail.apiUrl}/api/v1/messages`);
    const { messages } = mailboxSchema.parse(await res.json());
    return messages.filter((message) => message.To.some((to) => to.Address === person.email))
      .length;
  }

  // Waits for the newest email to this person to be the one the test expects
  function newestMail(person: Person, subject: string) {
    return eventually(async () => {
      const found = await lastMailTo(mail.apiUrl, person.email);
      expect(found.subject).toBe(subject);
      return found;
    }, 15_000);
  }

  beforeAll(async () => {
    sweep = worker.get(ReportScheduleSweep);
    runs = worker.get(ReportScheduleRunHandler);
    emails = worker.get(ReportScheduleEmailHandler);
    daily = await schedule(
      trialBalance({ frequency: 'daily', hour: 8 }, [owner.userId, mitu.userId]),
    );
  });

  it('hands nothing over before the time', async () => {
    expect(await sweep.run(later(daily.nextRunAt, -minute))).toBe(0);
    expect((await current(daily.id)).nextRunAt).toBe(daily.nextRunAt);
  });

  it('leaves a schedule to whoever holds it', async () => {
    const now = later(daily.nextRunAt, minute);
    // Someone saving the schedule right now: their transaction holds the row
    const holder = postgres(pg.superuserUrl, { max: 1, onnotice: () => undefined });
    try {
      await holder.begin(async (sql) => {
        await sql`SELECT id FROM report_schedules WHERE id = ${daily.id} FOR UPDATE`;
        expect(await sweep.run(now)).toBe(0);
      });
    } finally {
      await holder.end();
    }
    expect((await current(daily.id)).lastRunAt).toBeNull();
  });

  it('sends each person their own file, in their own language', async () => {
    const runAt = later(daily.nextRunAt, 0);
    const now = later(daily.nextRunAt, minute);
    expect(await sweep.run(now)).toBe(1);
    const moved = await current(daily.id);
    expect(moved.lastRunAt).toBe(now.toISOString());
    // The next day at 08:00
    expect(moved.nextRunAt).toBe(nextReportScheduleRun(daily.when, TIME_ZONE, now).toISOString());

    const day = dayBefore(runAt);
    const fileName = `trial-balance-${day}-to-${day}.pdf`;
    const english = await newestMail(
      owner,
      `Trial balance, ${formatIsoDate(day, 'en')} – ${formatIsoDate(day, 'en')} · ${COMPANY}`,
    );
    expect(english.attachments).toEqual([
      expect.objectContaining({ fileName, contentType: 'application/pdf' }),
    ]);
    expect(english.text).toContain('http://localhost:5173/reports/schedules');
    expect(english.text).toContain(`${COMPANY} sends this report to you every day`);
    const bangla = await newestMail(
      mitu,
      `ট্রায়াল ব্যালান্স, ${formatIsoDate(day, 'bn')} – ${formatIsoDate(day, 'bn')} · ${COMPANY}`,
    );
    expect(bangla.text).toContain('প্রতিদিন');
    // The file is on each person's own Exports page too
    for (const person of [owner, mitu]) {
      expect((await exportsOf(person)).map((item) => [item.fileName, item.status])).toEqual([
        [fileName, 'ready'],
      ]);
    }
    daily = moved;
  });

  it('sends one email after a long stop, about the latest day it missed', async () => {
    const before = await exportsOf(owner);
    // The worker was down for three days: three runs are due, one is sent
    const latest = later(daily.nextRunAt, 3 * 24 * 60 * minute);
    const now = new Date(latest.getTime() + minute);
    expect(await sweep.run(now)).toBe(1);
    expect((await current(daily.id)).nextRunAt).toBe(
      nextReportScheduleRun(daily.when, TIME_ZONE, now).toISOString(),
    );
    const day = dayBefore(latest);
    await newestMail(
      owner,
      `Trial balance, ${formatIsoDate(day, 'en')} – ${formatIsoDate(day, 'en')} · ${COMPANY}`,
    );
    const after = await exportsOf(owner);
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]?.fileName).toBe(`trial-balance-${day}-to-${day}.pdf`);
    daily = await current(daily.id);
  });

  it('makes each file once, however often the run job runs', async () => {
    const mailed = { owner: await mailsTo(owner), mitu: await mailsTo(mitu) };
    const event = dueEvent(daily.id, later(daily.nextRunAt, 0));
    await run(event);
    // A retry after a crash, or a second worker that got the same job
    await run(event);
    const ids = [owner.userId, mitu.userId].map((userId) => exportIdFor(event.id, userId));
    const counted = await superuserSql(
      (sql) => sql<{ files: number; events: number }[]>`
        SELECT (SELECT count(*)::int FROM report_exports WHERE id = ANY(${ids}::uuid[])) AS files,
               (SELECT count(*)::int FROM outbox_events
                 WHERE type = 'report.export_requested'
                   AND payload->>'exportId' = ANY(${ids}::text[])) AS events`,
    );
    expect(counted).toEqual([{ files: 2, events: 2 }]);
    // Each file is the person's own, and both get their email
    const owned = await superuserSql(
      (sql) => sql<{ requested_by: string }[]>`
        SELECT requested_by FROM report_exports WHERE id = ANY(${ids}::uuid[]) ORDER BY requested_by`,
    );
    expect(owned.map((row) => row.requested_by)).toEqual([owner.userId, mitu.userId].toSorted());
    // One email each, not two
    await eventually(async () => {
      expect({ owner: await mailsTo(owner), mitu: await mailsTo(mitu) }).toEqual({
        owner: mailed.owner + 1,
        mitu: mailed.mitu + 1,
      });
    }, 15_000);
  });

  it('leaves out a person who lost the permission, and tells whoever made it', async () => {
    // Mitu moves to another job: her role loses the accounting reports
    if (mitu.roleId === null) throw new Error('Mitu has no role');
    await setPermissions(mitu.roleId, ['core.report.schedule']);
    const mituBefore = (await exportsOf(mitu)).length;
    const ownerBefore = (await exportsOf(owner)).length;
    const mailed = { owner: await mailsTo(owner), mitu: await mailsTo(mitu) };
    await run(dueEvent(daily.id, later(daily.nextRunAt, 0)));
    expect(await exportsOf(owner)).toHaveLength(ownerBefore + 1);
    expect(await exportsOf(mitu)).toHaveLength(mituBefore);
    await eventually(async () => {
      expect(await mailsTo(owner)).toBe(mailed.owner + 1);
    }, 15_000);
    expect(await mailsTo(mitu)).toBe(mailed.mitu);
    expect((await bellsOf(owner)).map((bell) => [bell.type, bell.params])).toEqual([
      ['report.schedule_skipped', { report: 'trial_balance', count: 1 }],
    ]);
    expect((await current(daily.id)).recipients.map((item) => item.canReceive)).toEqual([
      true,
      false,
    ]);
  });

  it('pauses when nobody on it may read the report any more', async () => {
    // Made while Mitu could read it; the time is far away, so only this test runs it
    if (mitu.roleId === null) throw new Error('Mitu has no role');
    await setPermissions(mitu.roleId, ['accounting.report.read', 'core.report.schedule']);
    const onlyMitu = await schedule(
      trialBalance({ frequency: 'monthly', hour: 8, dayOfMonth: farDay() }, [mitu.userId]),
    );
    await setPermissions(mitu.roleId, ['core.report.schedule']);
    await run(dueEvent(onlyMitu.id, new Date()));
    expect(await current(onlyMitu.id)).toMatchObject({
      status: 'paused',
      pausedReason: 'no_recipients',
      nextRunAt: null,
      version: 2,
    });
    // The worker did it: no person in the audit log
    expect((await auditOf(onlyMitu.id)).at(-1)).toMatchObject({
      action: 'report_schedule.paused',
      actor: null,
      changes: { pausedReason: { from: null, to: 'no_recipients' } },
    });
    expect((await bellsOf(owner)).map((bell) => bell.type)).toContain('report.schedule_paused');
    // A run that comes after the pause sends nothing and changes nothing
    await run(dueEvent(onlyMitu.id, new Date()));
    expect((await current(onlyMitu.id)).version).toBe(2);
  });

  it('gives up on filters it cannot read, and tells whoever made it', async () => {
    // The profit and loss, which has a branch filter (the trial balance has none to break)
    const broken = await schedule({
      ...trialBalance({ frequency: 'monthly', hour: 9, dayOfMonth: farDay() }, [owner.userId]),
      report: 'profit_and_loss',
      query: { from: shiftIsoDate(today, -30), to: today, branchId },
    });
    // A row changed by hand: a branch id that is not an id
    await superuserSql(
      (sql) => sql`
        UPDATE report_schedules SET filters = '{"branchId": "Agrabad"}'::jsonb WHERE id = ${broken.id}`,
    );
    const event = dueEvent(broken.id, new Date());
    await expect(run(event)).rejects.toBeInstanceOf(PermanentJobError);
    // What the job runner does after the last try
    await runWithTenant(tenantId, () => runs.onGiveUp(event));
    expect((await bellsOf(owner)).map((bell) => [bell.type, bell.params])).toContainEqual([
      'report.schedule_failed',
      { report: 'profit_and_loss', format: 'pdf' },
    ]);
  });

  it('attaches a file up to 5 MB, and links to the exports page above that', async () => {
    const [newest] = await exportsOf(owner);
    if (!newest) throw new Error('the owner has no export');
    // As if the file were 1 byte over the limit: the size is all the handler looks at
    await superuserSql(
      (sql) => sql`
        UPDATE report_exports SET size_bytes = ${MAX_REPORT_ATTACHMENT_BYTES + 1}
         WHERE id = ${newest.id}`,
    );
    const before = await mailsTo(owner);
    await runWithTenant(tenantId, () =>
      emails.handle({
        id: v7(),
        tenantId,
        type: 'report.schedule_email',
        payload: { exportId: newest.id, scheduleId: daily.id },
        requestId: null,
      }),
    );
    // The handler returns once the mail server took it
    expect(await mailsTo(owner)).toBe(before + 1);
    const large = await lastMailTo(mail.apiUrl, owner.email);
    expect(large.attachments).toEqual([]);
    expect(large.text).toContain('The file is too large to attach');
    expect(large.text).toContain('http://localhost:5173/reports/exports');
    // The way to stop it is still in the email
    expect(large.text).toContain('To change or stop it: http://localhost:5173/reports/schedules');
  });

  it('sends nothing for a schedule deleted since the run, and keeps the files', async () => {
    const [newest] = await exportsOf(owner);
    if (!newest) throw new Error('the owner has no export');
    const files = (await exportsOf(owner)).length;
    expect((await send('DELETE', `/report-schedules/${daily.id}`)).statusCode).toBe(204);
    const before = await mailsTo(owner);
    await runWithTenant(tenantId, () =>
      emails.handle({
        id: v7(),
        tenantId,
        type: 'report.schedule_email',
        payload: { exportId: newest.id, scheduleId: daily.id },
        requestId: null,
      }),
    );
    expect(await mailsTo(owner)).toBe(before);
    expect(await exportsOf(owner)).toHaveLength(files);
  });
});
