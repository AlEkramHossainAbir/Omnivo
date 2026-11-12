import { Inject, Injectable } from '@nestjs/common';
import {
  type AuditValue,
  isStockValueSort,
  MAX_REPORT_SCHEDULES,
  nextReportScheduleRun,
  type ReportKind,
  REPORT_KIND_PERMISSIONS,
  reportKindsFor,
  type ReportSchedule,
  type ReportScheduleCandidateList,
  reportScheduleFiltersOf,
  type ReportScheduleInput,
  type ReportScheduleList,
  type ReportScheduleUpdate,
} from '@omnivo/contracts';
import {
  branches,
  customerGroups,
  productCategories,
  reportScheduleRecipients,
  reportSchedules,
  supplierGroups,
  tenantSettings,
  users,
  warehouses,
} from '@omnivo/db';
import { type AnyColumn, and, asc, eq, inArray, type SQL, sql } from 'drizzle-orm';

import { audit, created, diff } from '../common/audit/audit.js';
import { AppError, notFound, versionConflict } from '../common/http/app-error.js';
import { currentPrincipal, getTenantId } from '../common/tenant/tenant-context.js';
import type { Transaction, WithTenant } from '../common/tenant/with-tenant.js';
import { WITH_TENANT } from '../infra/tokens.js';
import { permissionHolders } from '../rbac/holds-permission.js';
import { PermissionService } from '../rbac/permission.service.js';
import { checkCostSort, missingPermission } from './report-access.js';
import { type ScheduleRow, whenColumnsOf, whenOf } from './report-schedule-row.js';

// The names a list shows for the filters' ids (decision 33). Read from the stored filters by
// their field names, which are the same in every report that has them.
interface FilterIds {
  branch: Set<string>;
  warehouse: Set<string>;
  group: Set<string>;
  category: Set<string>;
}

function groupIdOf(filters: Record<string, string>): string | undefined {
  return filters.customerGroupId ?? filters.supplierGroupId;
}

// What the audit log keeps of a schedule: plain values only (auditValueSchema)
function snapshot(row: ScheduleRow, recipientIds: readonly string[]): Record<string, AuditValue> {
  return {
    report: row.report,
    format: row.format,
    frequency: row.frequency,
    hour: row.hour,
    weekday: row.weekday,
    dayOfMonth: row.dayOfMonth,
    recipients: recipientIds.join(', '),
    status: row.status,
  };
}

function recipientsInvalid(): AppError {
  return new AppError(
    409,
    'report_schedule_recipient_invalid',
    'Pick only members who may read this report.',
    { fieldErrors: { recipientIds: ['report_schedule_recipient_invalid'] } },
  );
}

// The workspace's scheduled report emails (step 21c). The route needs core.report.schedule; every
// method here also needs the report's own permission (scheduleRouteBase in the contract), so a
// person cannot send by email what they could not open.
@Injectable()
export class ReportSchedulesService {
  constructor(
    @Inject(WITH_TENANT) private readonly withTenant: WithTenant,
    private readonly permissions: PermissionService,
  ) {}

  // Every schedule of the reports this person may read, oldest first. Not paged (decision 33).
  async list(): Promise<ReportScheduleList> {
    const kinds = reportKindsFor((await this.permissions.ofCurrentUser()).permissions);
    return this.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(reportSchedules)
        .where(
          and(eq(reportSchedules.tenantId, getTenantId()), inArray(reportSchedules.report, kinds)),
        )
        .orderBy(asc(reportSchedules.createdAt), asc(reportSchedules.id));
      return { items: await this.present(tx, rows), timeZone: await timeZoneOf(tx) };
    });
  }

  // The members who could get this report: only they are offered in the form (decision 30)
  async candidates(report: ReportKind): Promise<ReportScheduleCandidateList> {
    await this.checkReport(report);
    return this.withTenant(async (tx) => {
      const holders = await permissionHolders(tx, REPORT_KIND_PERMISSIONS[report]);
      if (holders.size === 0) return { items: [] };
      const people = await tx
        .select({ userId: users.id, name: users.fullName, email: users.email })
        .from(users)
        .where(inArray(users.id, [...holders]))
        .orderBy(sql`lower(${users.fullName})`, asc(users.id));
      return { items: people };
    });
  }

  async create(input: ReportScheduleInput): Promise<ReportSchedule> {
    const access = await this.checkReport(input.report);
    // The same rules as an export of the same query (report-exports.service.ts)
    if (input.report === 'sales_report') {
      checkCostSort(input.query.sort, access.includes('inventory.stock.value'));
    }
    if (
      input.report === 'stock_movement' &&
      isStockValueSort(input.query.sort) &&
      !access.includes('inventory.stock.value')
    ) {
      throw missingPermission('inventory.stock.value');
    }
    const userId = currentPrincipal().userId;
    return this.withTenant(async (tx) => {
      const tenantId = getTenantId();
      // decision 39: two saves at the same moment must not both be the 20th. The lock lasts
      // until the transaction ends, so the count and the insert happen one save at a time.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`report_schedules:${tenantId}`}, 0))`,
      );
      const [counted] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(reportSchedules)
        .where(eq(reportSchedules.tenantId, tenantId));
      if ((counted?.count ?? 0) >= MAX_REPORT_SCHEDULES) {
        throw new AppError(
          409,
          'report_schedule_limit',
          `A workspace can have at most ${String(MAX_REPORT_SCHEDULES)} report emails.`,
        );
      }
      await checkRecipients(tx, input.report, input.recipientIds);
      const [row] = await tx
        .insert(reportSchedules)
        .values({
          tenantId,
          report: input.report,
          format: input.format,
          ...whenColumnsOf(input.when),
          // decision 29: the page sent its query with the dates; only the filters are kept
          filters: reportScheduleFiltersOf(input.query),
          nextRunAt: nextReportScheduleRun(input.when, await timeZoneOf(tx), new Date()),
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      if (!row) throw new Error('Report schedule insert returned no row');
      await saveRecipients(tx, row.id, input.recipientIds);
      await audit(tx, {
        action: 'report_schedule.created',
        entityType: 'report_schedule',
        entityId: row.id,
        changes: created(snapshot(row, input.recipientIds)),
      });
      return this.one(tx, row);
    });
  }

  // The format, the time and the people; the report and its filters stay (decision 10)
  async update(id: string, input: ReportScheduleUpdate): Promise<ReportSchedule> {
    return this.withTenant(async (tx) => {
      const before = await this.lock(tx, id);
      if (before.row.version !== input.version) throw versionConflict();
      await checkRecipients(tx, before.row.report, input.recipientIds);
      const [after] = await tx
        .update(reportSchedules)
        .set({
          format: input.format,
          ...whenColumnsOf(input.when),
          // A new time moves the next run; a paused schedule stays without one
          ...(before.row.status === 'active' && {
            nextRunAt: nextReportScheduleRun(input.when, await timeZoneOf(tx), new Date()),
          }),
          version: sql`${reportSchedules.version} + 1`,
          updatedBy: currentPrincipal().userId,
          updatedAt: new Date(),
        })
        .where(and(eq(reportSchedules.tenantId, getTenantId()), eq(reportSchedules.id, id)))
        .returning();
      if (!after) throw notFound('Report schedule');
      await saveRecipients(tx, id, input.recipientIds);
      await audit(tx, {
        action: 'report_schedule.updated',
        entityType: 'report_schedule',
        entityId: id,
        changes: diff(
          snapshot(before.row, before.recipientIds),
          snapshot(after, input.recipientIds),
        ),
      });
      return this.one(tx, after);
    });
  }

  async pause(id: string, version: number): Promise<ReportSchedule> {
    return this.withTenant(async (tx) => {
      const { row } = await this.lock(tx, id);
      if (row.version !== version) throw versionConflict();
      // Already paused (by someone else, or by the worker): nothing to change
      if (row.status === 'paused') return this.one(tx, row);
      const after = await this.setStatus(tx, id, { status: 'paused', pausedReason: 'manual' });
      await audit(tx, {
        action: 'report_schedule.paused',
        entityType: 'report_schedule',
        entityId: id,
        changes: diff({ status: row.status }, { status: 'paused', pausedReason: 'manual' }),
      });
      return this.one(tx, after);
    });
  }

  // decision 31: refused while nobody on it may read the report, or it would pause itself again
  // at its next run
  async resume(id: string, version: number): Promise<ReportSchedule> {
    return this.withTenant(async (tx) => {
      const { row, recipientIds } = await this.lock(tx, id);
      if (row.version !== version) throw versionConflict();
      if (row.status === 'active') return this.one(tx, row);
      const holders = await permissionHolders(tx, REPORT_KIND_PERMISSIONS[row.report]);
      if (!recipientIds.some((userId) => holders.has(userId))) {
        throw new AppError(
          409,
          'report_schedule_no_recipients',
          'Nobody on this report email may read the report. Add someone who may, then resume it.',
        );
      }
      // From now: the runs it missed while paused are not sent
      const nextRunAt = nextReportScheduleRun(whenOf(row), await timeZoneOf(tx), new Date());
      const after = await this.setStatus(tx, id, {
        status: 'active',
        pausedReason: null,
        nextRunAt,
      });
      await audit(tx, {
        action: 'report_schedule.resumed',
        entityType: 'report_schedule',
        entityId: id,
        changes: diff(
          { status: row.status, pausedReason: row.pausedReason },
          { status: 'active', pausedReason: null },
        ),
      });
      return this.one(tx, after);
    });
  }

  // For real (decision 34): the recipients go with it (ON DELETE CASCADE); the files it sent are
  // report_exports rows of their own and stay on each person's Exports page
  async remove(id: string): Promise<void> {
    await this.withTenant(async (tx) => {
      const { row, recipientIds } = await this.lock(tx, id);
      await tx
        .delete(reportSchedules)
        .where(and(eq(reportSchedules.tenantId, getTenantId()), eq(reportSchedules.id, id)));
      // Every field to null, as the other deletes write it: the log keeps what it was
      const before = snapshot(row, recipientIds);
      await audit(tx, {
        action: 'report_schedule.deleted',
        entityType: 'report_schedule',
        entityId: id,
        changes: diff(
          before,
          Object.fromEntries(Object.keys(before).map((field) => [field, null])),
        ),
      });
    });
  }

  // The person's permissions, after checking the report's own one
  private async checkReport(report: ReportKind): Promise<readonly string[]> {
    const access = await this.permissions.ofCurrentUser();
    const permission = REPORT_KIND_PERMISSIONS[report];
    if (!access.permissions.includes(permission)) throw missingPermission(permission);
    return access.permissions;
  }

  // The row, locked until the transaction ends, with its recipients. A schedule of a report this
  // person may not read is refused like the list leaves it out.
  private async lock(
    tx: Transaction,
    id: string,
  ): Promise<{ row: ScheduleRow; recipientIds: string[] }> {
    const [row] = await tx
      .select()
      .from(reportSchedules)
      .where(and(eq(reportSchedules.tenantId, getTenantId()), eq(reportSchedules.id, id)))
      .for('update');
    if (!row) throw notFound('Report schedule');
    await this.checkReport(row.report);
    const recipients = await tx
      .select({ userId: reportScheduleRecipients.userId })
      .from(reportScheduleRecipients)
      .where(
        and(
          eq(reportScheduleRecipients.tenantId, getTenantId()),
          eq(reportScheduleRecipients.scheduleId, id),
        ),
      )
      .orderBy(asc(reportScheduleRecipients.position));
    return { row, recipientIds: recipients.map((recipient) => recipient.userId) };
  }

  private async setStatus(
    tx: Transaction,
    id: string,
    change:
      | { status: 'paused'; pausedReason: 'manual' }
      | { status: 'active'; pausedReason: null; nextRunAt: Date },
  ): Promise<ScheduleRow> {
    const [after] = await tx
      .update(reportSchedules)
      .set({
        status: change.status,
        pausedReason: change.pausedReason,
        // The check constraint: paused has no next run, active always has one
        nextRunAt: change.status === 'active' ? change.nextRunAt : null,
        version: sql`${reportSchedules.version} + 1`,
        updatedBy: currentPrincipal().userId,
        updatedAt: new Date(),
      })
      .where(and(eq(reportSchedules.tenantId, getTenantId()), eq(reportSchedules.id, id)))
      .returning();
    if (!after) throw notFound('Report schedule');
    return after;
  }

  private async one(tx: Transaction, row: ScheduleRow): Promise<ReportSchedule> {
    const [schedule] = await this.present(tx, [row]);
    if (!schedule) throw new Error('A report schedule presented no answer');
    return schedule;
  }

  // The answer for some rows: their recipients (and whether each can receive it now), who made
  // them, and the names of their filters. One query per kind of thing, not per row.
  private async present(tx: Transaction, rows: readonly ScheduleRow[]): Promise<ReportSchedule[]> {
    if (rows.length === 0) return [];
    const tenantId = getTenantId();
    const ids = rows.map((row) => row.id);
    const [recipients, creators] = await Promise.all([
      tx
        .select({
          scheduleId: reportScheduleRecipients.scheduleId,
          userId: users.id,
          name: users.fullName,
          email: users.email,
        })
        .from(reportScheduleRecipients)
        .innerJoin(users, eq(users.id, reportScheduleRecipients.userId))
        .where(
          and(
            eq(reportScheduleRecipients.tenantId, tenantId),
            inArray(reportScheduleRecipients.scheduleId, ids),
          ),
        )
        .orderBy(asc(reportScheduleRecipients.position)),
      tx
        .select({ id: users.id, name: users.fullName })
        .from(users)
        .where(inArray(users.id, [...new Set(rows.map((row) => row.createdBy))])),
    ]);
    // Who may read each kind of report now, once per kind
    const holders = new Map<ReportKind, Set<string>>();
    for (const report of new Set(rows.map((row) => row.report))) {
      holders.set(report, await permissionHolders(tx, REPORT_KIND_PERMISSIONS[report]));
    }
    const names = await filterNames(tx, rows);
    return rows.map((row) => ({
      id: row.id,
      version: row.version,
      report: row.report,
      format: row.format,
      when: whenOf(row),
      filters: row.filters,
      filterNames: {
        branch: names.get(row.filters.branchId),
        warehouse: names.get(row.filters.warehouseId),
        group: names.get(groupIdOf(row.filters)),
        category: names.get(row.filters.categoryId),
      },
      recipients: recipients
        .filter((recipient) => recipient.scheduleId === row.id)
        .map((recipient) => ({
          userId: recipient.userId,
          name: recipient.name,
          email: recipient.email,
          canReceive: holders.get(row.report)?.has(recipient.userId) ?? false,
        })),
      status: row.status,
      pausedReason: row.pausedReason,
      nextRunAt: row.nextRunAt?.toISOString() ?? null,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      createdByName: creators.find((creator) => creator.id === row.createdBy)?.name ?? '',
      createdAt: row.createdAt.toISOString(),
    }));
  }
}

async function timeZoneOf(tx: Transaction): Promise<string> {
  const [settings] = await tx
    .select({ timeZone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, getTenantId()));
  if (!settings) throw new Error(`tenant_settings row missing for tenant ${getTenantId()}`);
  return settings.timeZone;
}

// Every person must be a member who may read the report (decision 30). The contract already
// refused nobody, more than 10 and the same person twice.
async function checkRecipients(
  tx: Transaction,
  report: ReportKind,
  recipientIds: readonly string[],
): Promise<void> {
  const holders = await permissionHolders(tx, REPORT_KIND_PERMISSIONS[report]);
  if (!recipientIds.every((userId) => holders.has(userId))) throw recipientsInvalid();
}

// All of a schedule's rows again, in the order they were picked: simpler than working out which
// moved, and a schedule has at most 10
async function saveRecipients(
  tx: Transaction,
  scheduleId: string,
  recipientIds: readonly string[],
): Promise<void> {
  const tenantId = getTenantId();
  await tx
    .delete(reportScheduleRecipients)
    .where(
      and(
        eq(reportScheduleRecipients.tenantId, tenantId),
        eq(reportScheduleRecipients.scheduleId, scheduleId),
      ),
    );
  await tx.insert(reportScheduleRecipients).values(
    recipientIds.map((userId, index) => ({
      tenantId,
      scheduleId,
      userId,
      position: index + 1,
    })),
  );
}

// A branch or a warehouse as the report pages' selects name it ("HO · Head office"), so the list
// and the change dialog say what the dialog that made the schedule said. Groups and categories
// show no code anywhere: their names alone.
function codeAndName(code: AnyColumn, name: AnyColumn): SQL<string> {
  return sql<string>`${code} || ' · ' || ${name}`;
}

// The names of every id the rows' filters hold, in one map: an id is unique across the tables, so
// one map serves them all. undefined (no such filter) and an id that is gone give null.
async function filterNames(
  tx: Transaction,
  rows: readonly ScheduleRow[],
): Promise<{ get: (id: string | undefined) => string | null }> {
  const tenantId = getTenantId();
  const ids: FilterIds = {
    branch: new Set(),
    warehouse: new Set(),
    group: new Set(),
    category: new Set(),
  };
  for (const { filters } of rows) {
    if (filters.branchId !== undefined) ids.branch.add(filters.branchId);
    if (filters.warehouseId !== undefined) ids.warehouse.add(filters.warehouseId);
    const group = groupIdOf(filters);
    if (group !== undefined) ids.group.add(group);
    if (filters.categoryId !== undefined) ids.category.add(filters.categoryId);
  }
  const found = await Promise.all([
    ids.branch.size === 0
      ? []
      : tx
          .select({ id: branches.id, name: codeAndName(branches.code, branches.name) })
          .from(branches)
          .where(and(eq(branches.tenantId, tenantId), inArray(branches.id, [...ids.branch]))),
    ids.warehouse.size === 0
      ? []
      : tx
          .select({ id: warehouses.id, name: codeAndName(warehouses.code, warehouses.name) })
          .from(warehouses)
          .where(
            and(eq(warehouses.tenantId, tenantId), inArray(warehouses.id, [...ids.warehouse])),
          ),
    ids.group.size === 0
      ? []
      : tx
          .select({ id: customerGroups.id, name: customerGroups.name })
          .from(customerGroups)
          .where(
            and(eq(customerGroups.tenantId, tenantId), inArray(customerGroups.id, [...ids.group])),
          ),
    ids.group.size === 0
      ? []
      : tx
          .select({ id: supplierGroups.id, name: supplierGroups.name })
          .from(supplierGroups)
          .where(
            and(eq(supplierGroups.tenantId, tenantId), inArray(supplierGroups.id, [...ids.group])),
          ),
    ids.category.size === 0
      ? []
      : tx
          .select({ id: productCategories.id, name: productCategories.name })
          .from(productCategories)
          .where(
            and(
              eq(productCategories.tenantId, tenantId),
              inArray(productCategories.id, [...ids.category]),
            ),
          ),
  ]);
  const byId = new Map(found.flat().map((item) => [item.id, item.name]));
  return { get: (id) => (id === undefined ? null : (byId.get(id) ?? null)) };
}
