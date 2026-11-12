import {
  EXPORT_FORMATS,
  REPORT_KINDS,
  REPORT_SCHEDULE_FREQUENCIES,
  REPORT_SCHEDULE_PAUSE_REASONS,
  REPORT_SCHEDULE_STATUSES,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';
import { users } from './users.js';

// Step 21c: a report that goes by email by itself (the contract's report-schedules.ts). The worker
// finds the due rows by next_run_at; each run writes one report_exports row per recipient. The
// rules on who may read what live in migration 0062.

export const reportSchedules = pgTable(
  'report_schedules',
  {
    // baseColumns without deleted_at: Delete removes a schedule for real (decision 34). The files
    // it already sent are report_exports rows of their own, which do not point back here, so they
    // stay. version: Update, Pause and Resume carry it.
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Fixed once saved (decision 10): the API's update has no field for them
    report: text('report', { enum: REPORT_KINDS }).notNull(),
    format: text('format', { enum: EXPORT_FORMATS }).notNull(),
    // The contract's reportScheduleWhenSchema, as columns: the checks below then keep a weekly row
    // with its day and a daily row without one, which a jsonb column could not promise
    frequency: text('frequency', { enum: REPORT_SCHEDULE_FREQUENCIES }).notNull(),
    hour: smallint('hour').notNull(),
    // 0 = Sunday. Only on a weekly schedule.
    weekday: smallint('weekday'),
    // 1–28. Only on a monthly schedule.
    dayOfMonth: smallint('day_of_month'),
    // The report's filters without the dates (reportScheduleFiltersOf()). The worker parses them
    // again with the report's own schema at every run, as it does every export's query.
    filters: jsonb('filters').$type<Record<string, string>>().notNull().default({}),
    status: text('status', { enum: REPORT_SCHEDULE_STATUSES }).notNull().default('active'),
    pausedReason: text('paused_reason', { enum: REPORT_SCHEDULE_PAUSE_REASONS }),
    // When the sweep should hand it to the worker. NULL while paused, so the sweep's index holds
    // only the schedules that can run.
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    // Who made it gets the bells (decision 12). Required here, unlike baseColumns' createdBy: a
    // schedule is only ever made by a person.
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    // The recipients' foreign key
    uniqueIndex('report_schedules_tenant_id_idx').on(table.tenantId, table.id),
    // The sweep, every 5 minutes, across every workspace: so not tenant first. Partial, so the
    // paused schedules are not in it.
    index('report_schedules_due_idx')
      .on(table.nextRunAt)
      .where(sql`${table.nextRunAt} IS NOT NULL`),
    check('report_schedules_hour_check', sql`${table.hour} BETWEEN 0 AND 23`),
    // Each day field belongs to its frequency, and only to it
    check(
      'report_schedules_weekday_check',
      sql`(${table.frequency} = 'weekly') = (${table.weekday} IS NOT NULL) AND (${table.weekday} IS NULL OR ${table.weekday} BETWEEN 0 AND 6)`,
    ),
    check(
      'report_schedules_day_of_month_check',
      sql`(${table.frequency} = 'monthly') = (${table.dayOfMonth} IS NOT NULL) AND (${table.dayOfMonth} IS NULL OR ${table.dayOfMonth} BETWEEN 1 AND 28)`,
    ),
    // A paused schedule says why and never runs; an active one always has its next run
    check(
      'report_schedules_status_check',
      sql`(${table.status} = 'paused') = (${table.pausedReason} IS NOT NULL) AND (${table.status} = 'active') = (${table.nextRunAt} IS NOT NULL)`,
    ),
  ],
);

// Who gets it, in the order they were picked. A save replaces all of a schedule's rows.
export const reportScheduleRecipients = pgTable(
  'report_schedule_recipients',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    scheduleId: uuid('schedule_id').notNull(),
    // 1 = picked first
    position: smallint('position').notNull(),
    // A user, not a membership: someone who left the workspace stays on the list, shown as
    // "cannot receive it" (canReceive), until someone takes them off. Members are only ever
    // soft-deleted, so a user row never goes away.
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    uniqueIndex('report_schedule_recipients_position_idx').on(
      table.tenantId,
      table.scheduleId,
      table.position,
    ),
    // The contract's report_schedule_recipient_invalid again: each person once
    primaryKey({
      name: 'report_schedule_recipients_pkey',
      columns: [table.tenantId, table.scheduleId, table.userId],
    }),
    foreignKey({
      name: 'report_schedule_recipients_schedule_fk',
      columns: [table.tenantId, table.scheduleId],
      foreignColumns: [reportSchedules.tenantId, reportSchedules.id],
    }).onDelete('cascade'),
    // 10 = the contract's MAX_REPORT_SCHEDULE_RECIPIENTS; with the unique position, a schedule
    // never has more
    check('report_schedule_recipients_position_check', sql`${table.position} BETWEEN 1 AND 10`),
  ],
);
