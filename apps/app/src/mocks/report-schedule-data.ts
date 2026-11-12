import {
  type AuditChanges,
  type AuditValue,
  type ExportFormat,
  MAX_REPORT_SCHEDULES,
  nextReportScheduleRun,
  type PermissionKey,
  type ReportKind,
  REPORT_KIND_PERMISSIONS,
  reportKindsFor,
  type ReportSchedule,
  type ReportScheduleCandidateList,
  reportScheduleFiltersOf,
  type ReportScheduleInput,
  type ReportScheduleList,
  type ReportSchedulePauseReason,
  type ReportScheduleStatus,
  type ReportScheduleUpdate,
  type ReportScheduleWhen,
} from '@omnivo/contracts';

import { OWNER } from './fixtures';
import { MockProblem } from './mock';
import { record, type WorkspaceData } from './workspace-data';

// Step 21c: the workspace's scheduled report emails, with the API's rules
// (report-schedules.service.ts): at most 20, recipients who are members and may read the report,
// the report and its filters fixed once saved (decision 10), version checks, a resume refused while
// nobody on it may read the report. The mock has no worker: nothing is ever sent, so lastRunAt
// stays what the seed gave.

// A schedule as stored: the recipients and the creator by id, like the API's rows. Their names,
// whether each may still get it and the filters' names are worked out on read.
export interface MockReportSchedule {
  id: string;
  version: number;
  report: ReportKind;
  format: ExportFormat;
  when: ReportScheduleWhen;
  filters: Record<string, string>;
  recipientIds: string[];
  status: ReportScheduleStatus;
  pausedReason: ReportSchedulePauseReason | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdBy: string;
  createdAt: string;
}

// The members whose roles hold a permission (the API's permissionHolders)
function holdersOf(data: WorkspaceData, permission: PermissionKey): Set<string> {
  const roles = new Set(
    data.people.roles
      .filter((role) => role.permissions.includes(permission))
      .map((role) => role.id),
  );
  return new Set(
    data.people.members
      .filter((member) => member.roles.some((role) => roles.has(role.id)))
      .map((member) => member.userId),
  );
}

// A filter's name as the API's filterNames gives it: a branch or a warehouse with its code
function nameOf(data: WorkspaceData, id: string | undefined): string | null {
  if (id === undefined) return null;
  const place = [...data.branches, ...data.stock.warehouses].find((item) => item.id === id);
  if (place) return `${place.code} · ${place.name}`;
  const named = [...data.sales.groups, ...data.suppliers.groups, ...data.catalog.categories].find(
    (item) => item.id === id,
  );
  return named?.name ?? null;
}

function present(data: WorkspaceData, item: MockReportSchedule): ReportSchedule {
  const holders = holdersOf(data, REPORT_KIND_PERMISSIONS[item.report]);
  const members = new Map(data.people.members.map((member) => [member.userId, member]));
  return {
    id: item.id,
    version: item.version,
    report: item.report,
    format: item.format,
    when: item.when,
    filters: item.filters,
    filterNames: {
      branch: nameOf(data, item.filters.branchId),
      warehouse: nameOf(data, item.filters.warehouseId),
      group: nameOf(data, item.filters.customerGroupId ?? item.filters.supplierGroupId),
      category: nameOf(data, item.filters.categoryId),
    },
    // A person who left is no member any more: no name to show, so the API's join leaves them out
    recipients: item.recipientIds.flatMap((userId) => {
      const member = members.get(userId);
      return member
        ? [
            {
              userId,
              name: member.fullName,
              email: member.email,
              canReceive: holders.has(userId),
            },
          ]
        : [];
    }),
    status: item.status,
    pausedReason: item.pausedReason,
    nextRunAt: item.nextRunAt,
    lastRunAt: item.lastRunAt,
    createdByName: members.get(item.createdBy)?.fullName ?? '',
    createdAt: item.createdAt,
  };
}

function nextRun(data: WorkspaceData, when: ReportScheduleWhen): string {
  return nextReportScheduleRun(when, data.settings.timezone, new Date()).toISOString();
}

// The person signed in must read the report too (scheduleRouteBase)
function checkReport(report: ReportKind, permissions: readonly string[]): void {
  if (!permissions.includes(REPORT_KIND_PERMISSIONS[report])) {
    throw new MockProblem(403, 'permission_missing');
  }
}

function checkRecipients(data: WorkspaceData, report: ReportKind, ids: readonly string[]): void {
  const holders = holdersOf(data, REPORT_KIND_PERMISSIONS[report]);
  if (!ids.every((id) => holders.has(id))) {
    throw new MockProblem(409, 'report_schedule_recipient_invalid', {
      recipientIds: ['report_schedule_recipient_invalid'],
    });
  }
}

// A schedule of a report this person may not read is not found, like the list leaves it out
function find(data: WorkspaceData, id: string, permissions: readonly string[]) {
  const found = data.reportSchedules.find((item) => item.id === id);
  if (!found) throw new MockProblem(404, 'not_found');
  checkReport(found.report, permissions);
  return found;
}

// What the audit log keeps of a schedule (the API's snapshot)
function snapshot(item: MockReportSchedule): Record<string, AuditValue> {
  return {
    report: item.report,
    format: item.format,
    frequency: item.when.frequency,
    hour: item.when.hour,
    weekday: item.when.frequency === 'weekly' ? item.when.weekday : null,
    dayOfMonth: item.when.frequency === 'monthly' ? item.when.dayOfMonth : null,
    recipients: item.recipientIds.join(', '),
    status: item.status,
  };
}

// Only the fields that changed, as { from, to }: the API's diff(). Both sides' fields, so a
// creation (nothing before) lists every field.
function changesOf(
  before: Record<string, AuditValue>,
  after: Record<string, AuditValue>,
): AuditChanges {
  const changes: AuditChanges = {};
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[field] ?? null;
    const to = after[field] ?? null;
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}

export function scheduleListOf(
  data: WorkspaceData,
  permissions: readonly string[],
): ReportScheduleList {
  const kinds = new Set<string>(reportKindsFor(permissions));
  return {
    items: data.reportSchedules
      .filter((item) => kinds.has(item.report))
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((item) => present(data, item)),
    timeZone: data.settings.timezone,
  };
}

export function scheduleCandidatesOf(
  data: WorkspaceData,
  report: ReportKind,
  permissions: readonly string[],
): ReportScheduleCandidateList {
  checkReport(report, permissions);
  const holders = holdersOf(data, REPORT_KIND_PERMISSIONS[report]);
  return {
    items: data.people.members
      .filter((member) => holders.has(member.userId))
      .map((member) => ({ userId: member.userId, name: member.fullName, email: member.email }))
      .toSorted(
        (a, b) =>
          a.name.toLowerCase().localeCompare(b.name.toLowerCase()) ||
          a.userId.localeCompare(b.userId),
      ),
  };
}

export function createSchedule(
  data: WorkspaceData,
  input: ReportScheduleInput,
  permissions: readonly string[],
): ReportSchedule {
  checkReport(input.report, permissions);
  if (data.reportSchedules.length >= MAX_REPORT_SCHEDULES) {
    throw new MockProblem(409, 'report_schedule_limit');
  }
  checkRecipients(data, input.report, input.recipientIds);
  const item: MockReportSchedule = {
    id: crypto.randomUUID(),
    version: 1,
    report: input.report,
    format: input.format,
    when: input.when,
    // decision 29: only the filters are kept, never the dates
    filters: reportScheduleFiltersOf(input.query),
    recipientIds: [...input.recipientIds],
    status: 'active',
    pausedReason: null,
    nextRunAt: nextRun(data, input.when),
    lastRunAt: null,
    createdBy: OWNER.id,
    createdAt: new Date().toISOString(),
  };
  data.reportSchedules.push(item);
  record(
    data,
    'report_schedule.created',
    'report_schedule',
    item.id,
    changesOf({}, snapshot(item)),
  );
  return present(data, item);
}

export function updateSchedule(
  data: WorkspaceData,
  id: string,
  input: ReportScheduleUpdate,
  permissions: readonly string[],
): ReportSchedule {
  const item = find(data, id, permissions);
  if (item.version !== input.version) throw new MockProblem(409, 'version_conflict');
  checkRecipients(data, item.report, input.recipientIds);
  const before = snapshot(item);
  Object.assign(item, {
    format: input.format,
    when: input.when,
    recipientIds: [...input.recipientIds],
    // A new time moves the next run; a paused schedule stays without one
    nextRunAt: item.status === 'active' ? nextRun(data, input.when) : null,
    version: item.version + 1,
  });
  record(data, 'report_schedule.updated', 'report_schedule', id, changesOf(before, snapshot(item)));
  return present(data, item);
}

export function pauseSchedule(
  data: WorkspaceData,
  id: string,
  version: number,
  permissions: readonly string[],
): ReportSchedule {
  const item = find(data, id, permissions);
  if (item.version !== version) throw new MockProblem(409, 'version_conflict');
  if (item.status === 'paused') return present(data, item);
  Object.assign(item, {
    status: 'paused',
    pausedReason: 'manual',
    nextRunAt: null,
    version: item.version + 1,
  });
  record(data, 'report_schedule.paused', 'report_schedule', id, {
    status: { from: 'active', to: 'paused' },
    pausedReason: { from: null, to: 'manual' },
  });
  return present(data, item);
}

// decision 31: refused while nobody on it may read the report
export function resumeSchedule(
  data: WorkspaceData,
  id: string,
  version: number,
  permissions: readonly string[],
): ReportSchedule {
  const item = find(data, id, permissions);
  if (item.version !== version) throw new MockProblem(409, 'version_conflict');
  if (item.status === 'active') return present(data, item);
  const holders = holdersOf(data, REPORT_KIND_PERMISSIONS[item.report]);
  if (!item.recipientIds.some((userId) => holders.has(userId))) {
    throw new MockProblem(409, 'report_schedule_no_recipients');
  }
  const reason = item.pausedReason;
  Object.assign(item, {
    status: 'active',
    pausedReason: null,
    // From now: the runs it missed while paused are not sent
    nextRunAt: nextRun(data, item.when),
    version: item.version + 1,
  });
  record(data, 'report_schedule.resumed', 'report_schedule', id, {
    status: { from: 'paused', to: 'active' },
    pausedReason: { from: reason, to: null },
  });
  return present(data, item);
}

// For real (decision 34); the files it sent stay on the Exports page
export function removeSchedule(
  data: WorkspaceData,
  id: string,
  permissions: readonly string[],
): void {
  const item = find(data, id, permissions);
  data.reportSchedules = data.reportSchedules.filter((candidate) => candidate.id !== id);
  const before = snapshot(item);
  record(
    data,
    'report_schedule.deleted',
    'report_schedule',
    id,
    changesOf(before, Object.fromEntries(Object.keys(before).map((field) => [field, null]))),
  );
}
