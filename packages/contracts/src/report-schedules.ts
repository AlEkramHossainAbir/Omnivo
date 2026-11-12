import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { shiftIsoDate } from './journal.js';
import { todayIn } from './numbering.js';
import {
  EXPORT_FORMATS,
  type ReportKind,
  reportExportInputSchema,
  REPORT_KINDS,
} from './reports.js';

// Scheduled report emails (step 21c): a report that goes by email by itself, daily, weekly or
// monthly, to members of the workspace.
//
// - A schedule keeps the report's filters and never its dates: each run works out its own period
//   (reportSchedulePeriod below), so "last month" is always last month.
// - Each person gets their own file, in their own language and with what their own permissions
//   show: one report_exports row per person. So the margin column reaches only the people who may
//   see it, and the file is on their Exports page too.
// - Who may read the report is checked again at every run. A person who lost the permission is left
//   out, and the person who made the schedule is told.
// - A schedule belongs to the workspace, not to the person who made it: the monthly report to the
//   director must not stop because an accountant left.

export const MAX_REPORT_SCHEDULES = 20;
export const MAX_REPORT_SCHEDULE_RECIPIENTS = 10;

// ---------------------------------------------------------------------------------------------
// When it runs. Times are in the workspace's time zone.

export const REPORT_SCHEDULE_FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;
export type ReportScheduleFrequency = (typeof REPORT_SCHEDULE_FREQUENCIES)[number];

// A whole hour: the worker looks for due schedules every 5 minutes, so a minute would promise more
// than it can keep
const hourSchema = z.number().int().min(0).max(23);

// A discriminated union, so a weekly schedule cannot exist without its day, and the form's type
// says so. dayOfMonth stops at 28: every month has it, so "the 31st" never has to mean something
// else in February.
export const reportScheduleWhenSchema = z.discriminatedUnion('frequency', [
  z.object({ frequency: z.literal('daily'), hour: hourSchema }),
  // 0 = Sunday, as Date.getUTCDay() counts
  z.object({
    frequency: z.literal('weekly'),
    hour: hourSchema,
    weekday: z.number().int().min(0).max(6),
  }),
  z.object({
    frequency: z.literal('monthly'),
    hour: hourSchema,
    dayOfMonth: z.number().int().min(1).max(28),
  }),
]);
export type ReportScheduleWhen = z.infer<typeof reportScheduleWhenSchema>;

function isRunDay(when: ReportScheduleWhen, isoDate: string): boolean {
  switch (when.frequency) {
    case 'daily':
      return true;
    case 'weekly':
      return new Date(`${isoDate}T00:00:00Z`).getUTCDay() === when.weekday;
    case 'monthly':
      return Number(isoDate.slice(8, 10)) === when.dayOfMonth;
  }
}

// How far a time zone is ahead of UTC at one moment, in milliseconds. Intl is the only thing in
// the runtime that knows the zones, and it speaks in wall-clock parts, so the parts are read back
// as if they were UTC and the difference is the offset.
function zoneOffset(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((item) => item.type === type)?.value);
  const wallClock = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  // Intl's parts have no milliseconds, so the instant must lose them too
  return wallClock - Math.floor(instant / 1000) * 1000;
}

// The moment a wall clock in a time zone shows this date and whole hour. The offset is read twice:
// the first guess can land on the other side of a clock change. An hour that a clock change skips
// or repeats resolves to one of its neighbours, which is good enough for a report email.
function atHourIn(isoDate: string, hour: number, timeZone: string): Date {
  const wall = Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
    hour,
  );
  const first = wall - zoneOffset(wall, timeZone);
  return new Date(wall - zoneOffset(first, timeZone));
}

// The first run strictly after `after`. The API calls it when a schedule is saved, the worker after
// each run. Strictly after: a run that finishes at its own time must move on to the next one.
export function nextReportScheduleRun(
  when: ReportScheduleWhen,
  timeZone: string,
  after: Date,
): Date {
  const today = todayIn(timeZone, after);
  // Ends: every frequency has a run day within 31 days of any date
  for (let offset = 0; ; offset += 1) {
    const day = shiftIsoDate(today, offset);
    if (!isRunDay(when, day)) continue;
    const run = atHourIn(day, when.hour, timeZone);
    if (run > after) return run;
  }
}

// ---------------------------------------------------------------------------------------------
// What each run covers

export interface ReportSchedulePeriod {
  from: string;
  to: string;
}

// Worked out from the day of the run, in the workspace's time zone. It never includes that day: a
// report sent at 08:00 about today would be a third of a day. Daily is yesterday, weekly is the
// seven days up to yesterday, monthly is the whole of the month before.
export function reportSchedulePeriod(
  frequency: ReportScheduleFrequency,
  runDate: string,
): ReportSchedulePeriod {
  const yesterday = shiftIsoDate(runDate, -1);
  switch (frequency) {
    case 'daily':
      return { from: yesterday, to: yesterday };
    case 'weekly':
      return { from: shiftIsoDate(yesterday, -6), to: yesterday };
    case 'monthly': {
      const to = shiftIsoDate(`${runDate.slice(0, 7)}-01`, -1);
      return { from: `${to.slice(0, 7)}-01`, to };
    }
  }
}

// Whether a report covers a range of days or shows one day. The aging and the balance sheet show
// the last day of the period.
const REPORT_PERIOD_SHAPE = {
  trial_balance: 'range',
  profit_and_loss: 'range',
  balance_sheet: 'as_of',
  sales_report: 'range',
  purchase_report: 'range',
  ar_aging: 'as_of',
  ap_aging: 'as_of',
  vat_report: 'range',
  stock_movement: 'range',
} as const satisfies Record<ReportKind, 'range' | 'as_of'>;

// The fields a schedule does not keep. The comparison dates go too: "compare with" is a choice about
// one fixed period, and a schedule has none.
const PERIOD_FIELDS = new Set(['from', 'to', 'asOf', 'compareFrom', 'compareTo', 'compareAsOf']);

// The filters a schedule keeps out of the query the report page sent
export function reportScheduleFiltersOf(
  query: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [field, value] of Object.entries(query)) {
    if (value !== undefined && !PERIOD_FIELDS.has(field)) filters[field] = value;
  }
  return filters;
}

// One run's query: the kept filters and the run's dates. The export handler parses it with the
// report's own schema, as it does every export.
export function reportScheduleQuery(
  report: ReportKind,
  filters: Readonly<Record<string, string>>,
  period: ReportSchedulePeriod,
): Record<string, string> {
  return REPORT_PERIOD_SHAPE[report] === 'as_of'
    ? { ...filters, asOf: period.to }
    : { ...filters, from: period.from, to: period.to };
}

// ---------------------------------------------------------------------------------------------
// What is sent and answered

// Member user ids. Whether each one may read the report is the API's check.
const recipientIdsSchema = z
  .array(z.uuid())
  .min(1, { error: errorCode('report_schedule_recipients_needed') })
  .max(MAX_REPORT_SCHEDULE_RECIPIENTS, { error: errorCode('report_schedule_recipients_too_many') })
  .refine((ids) => new Set(ids).size === ids.length, {
    error: errorCode('report_schedule_recipient_invalid'),
  });

// The same report, format and query as an export, plus when and to whom. The page sends the query
// it already has, dates included, so the report's own schema checks the filters (a sort the group
// has no column for, say). The API keeps only reportScheduleFiltersOf() of it.
export const reportScheduleInputSchema = reportExportInputSchema.and(
  z.object({ when: reportScheduleWhenSchema, recipientIds: recipientIdsSchema }),
);
export type ReportScheduleInput = z.infer<typeof reportScheduleInputSchema>;

// The report and its filters stay as they were made. Other filters are a new schedule, made from
// the report page, where the filters are.
export const reportScheduleUpdateSchema = z.object({
  format: z.enum(EXPORT_FORMATS),
  when: reportScheduleWhenSchema,
  recipientIds: recipientIdsSchema,
  version: versionSchema,
});
export type ReportScheduleUpdate = z.infer<typeof reportScheduleUpdateSchema>;

export const reportScheduleVersionSchema = z.object({ version: versionSchema });

export const REPORT_SCHEDULE_STATUSES = ['active', 'paused'] as const;
export type ReportScheduleStatus = (typeof REPORT_SCHEDULE_STATUSES)[number];

// manual: someone pressed Pause. no_recipients: nobody on it may read the report any more.
export const REPORT_SCHEDULE_PAUSE_REASONS = ['manual', 'no_recipients'] as const;
export type ReportSchedulePauseReason = (typeof REPORT_SCHEDULE_PAUSE_REASONS)[number];

export const reportScheduleRecipientSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string(),
  // false: they stopped being a member or lost the report's permission. The list says so, because
  // this person gets no email until that changes.
  canReceive: z.boolean(),
});
export type ReportScheduleRecipient = z.infer<typeof reportScheduleRecipientSchema>;

export const reportScheduleSchema = z.object({
  id: z.uuid(),
  version: versionSchema,
  // z.string(), like an export: the app narrows them with isReportKind() and isExportFormat()
  report: z.string(),
  format: z.string(),
  when: reportScheduleWhenSchema,
  filters: z.record(z.string(), z.string()),
  // The names of the filters' ids, for the list. null when that filter is not set. A branch and a
  // warehouse are "HO · Head office", as the report pages' selects name them.
  filterNames: z.object({
    branch: z.string().nullable(),
    warehouse: z.string().nullable(),
    group: z.string().nullable(),
    category: z.string().nullable(),
  }),
  recipients: z.array(reportScheduleRecipientSchema),
  status: z.enum(REPORT_SCHEDULE_STATUSES),
  pausedReason: z.enum(REPORT_SCHEDULE_PAUSE_REASONS).nullable(),
  // null while paused
  nextRunAt: z.iso.datetime().nullable(),
  lastRunAt: z.iso.datetime().nullable(),
  createdByName: z.string(),
  createdAt: z.iso.datetime(),
});
export type ReportSchedule = z.infer<typeof reportScheduleSchema>;

// Not paged: a workspace has at most MAX_REPORT_SCHEDULES. The time zone is what `hour` means.
export const reportScheduleListSchema = z.object({
  items: z.array(reportScheduleSchema),
  timeZone: z.string(),
});
export type ReportScheduleList = z.infer<typeof reportScheduleListSchema>;

export const reportScheduleRecipientQuerySchema = z.object({ report: z.enum(REPORT_KINDS) });

export const reportScheduleCandidateListSchema = z.object({
  items: z.array(reportScheduleRecipientSchema.omit({ canReceive: true })),
});
export type ReportScheduleCandidateList = z.infer<typeof reportScheduleCandidateListSchema>;

const reportScheduleParamsSchema = z.object({ id: z.uuid() });

// The permission here says who may manage schedules at all. The API also checks the report's own
// permission (REPORT_KIND_PERMISSIONS), and the list leaves out the schedules of reports this
// person may not read.
const scheduleRouteBase = { auth: 'bearer', permission: 'core.report.schedule' } as const;

export const reportScheduleRoutes = {
  list: defineRoute({
    ...scheduleRouteBase,
    method: 'GET',
    path: '/report-schedules',
    summary: "The workspace's scheduled report emails",
    status: 200,
    response: reportScheduleListSchema,
  }),
  // Only the people who could get this report, so the form can offer nobody else
  candidates: defineRoute({
    ...scheduleRouteBase,
    method: 'GET',
    path: '/report-schedules/recipients',
    summary: 'The members who may read a report and so may get it by email',
    status: 200,
    query: reportScheduleRecipientQuerySchema,
    response: reportScheduleCandidateListSchema,
  }),
  create: defineRoute({
    ...scheduleRouteBase,
    method: 'POST',
    path: '/report-schedules',
    summary: 'Send a report by email on a schedule',
    status: 201,
    body: reportScheduleInputSchema,
    response: reportScheduleSchema,
  }),
  update: defineRoute({
    ...scheduleRouteBase,
    method: 'PUT',
    path: '/report-schedules/:id',
    summary: 'Change when a scheduled report goes, in which format and to whom',
    status: 200,
    params: reportScheduleParamsSchema,
    body: reportScheduleUpdateSchema,
    response: reportScheduleSchema,
  }),
  pause: defineRoute({
    ...scheduleRouteBase,
    method: 'POST',
    path: '/report-schedules/:id/pause',
    summary: 'Stop sending a scheduled report for now',
    status: 200,
    params: reportScheduleParamsSchema,
    body: reportScheduleVersionSchema,
    response: reportScheduleSchema,
  }),
  // Refused (report_schedule_no_recipients) when nobody on it may read the report now
  resume: defineRoute({
    ...scheduleRouteBase,
    method: 'POST',
    path: '/report-schedules/:id/resume',
    summary: 'Start sending a paused report again',
    status: 200,
    params: reportScheduleParamsSchema,
    body: reportScheduleVersionSchema,
    response: reportScheduleSchema,
  }),
  remove: defineRoute({
    ...scheduleRouteBase,
    method: 'DELETE',
    path: '/report-schedules/:id',
    summary: 'Delete a scheduled report',
    status: 204,
    params: reportScheduleParamsSchema,
    response: z.void(),
  }),
};
