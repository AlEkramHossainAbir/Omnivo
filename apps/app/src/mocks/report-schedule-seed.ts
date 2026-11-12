import {
  nextReportScheduleRun,
  type ReportSchedulePauseReason,
  type ReportScheduleWhen,
} from '@omnivo/contracts';

import type { MockReportSchedule } from './report-schedule-data';
import type { WorkspaceData } from './workspace-data';

// Step 21c: the seed of the scheduled report emails. A file of its own, with type imports only:
// report-schedule-data.ts writes audit entries with workspace-data.ts's record(), and
// workspace-data.ts calls this seed, so one file would be an import cycle.
//
// The garments workspace's four schedules, as the approved mockup draws them: a monthly VAT report,
// a weekly sales report with one person on it who may not read it now (Kamal Uddin, the Purchase
// manager), a daily payables aging paused because nobody on it may read it, and a stock movement
// someone paused.

const DAY_MS = 24 * 60 * 60 * 1000;

function nextRun(data: WorkspaceData, when: ReportScheduleWhen): string {
  return nextReportScheduleRun(when, data.settings.timezone, new Date()).toISOString();
}

// The run before now: the last run of a schedule that has been going for a while
function lastRun(data: WorkspaceData, when: ReportScheduleWhen): string {
  const zone = data.settings.timezone;
  const now = new Date();
  let run = nextReportScheduleRun(when, zone, new Date(now.getTime() - 32 * DAY_MS));
  for (;;) {
    const next = nextReportScheduleRun(when, zone, run);
    if (next > now) return run.toISOString();
    run = next;
  }
}

export function seedReportSchedules(data: WorkspaceData): void {
  const person = (name: string) =>
    data.people.members.find((member) => member.fullName === name)?.userId;
  const nusrat = person('Nusrat Jahan');
  const rafiq = person('Rafiq Ahmed');
  const kamal = person('Kamal Uddin');
  const head = data.branches.find((item) => item.code === 'HO');
  const depot = data.stock.warehouses.find((item) => item.code === 'CTG');
  const yarn = data.suppliers.groups.find((item) => item.name === 'Yarn and fabric');
  if (!nusrat || !rafiq || !kamal || !head || !depot || !yarn) return;

  const made = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
  const schedule = (
    fields: Pick<MockReportSchedule, 'report' | 'format' | 'when' | 'filters' | 'recipientIds'> & {
      createdBy: string;
      createdAt: string;
      paused: ReportSchedulePauseReason | null;
      sent: boolean;
    },
  ): MockReportSchedule => ({
    id: crypto.randomUUID(),
    version: 1,
    report: fields.report,
    format: fields.format,
    when: fields.when,
    filters: fields.filters,
    recipientIds: fields.recipientIds,
    status: fields.paused === null ? 'active' : 'paused',
    pausedReason: fields.paused,
    nextRunAt: fields.paused === null ? nextRun(data, fields.when) : null,
    lastRunAt: fields.sent ? lastRun(data, fields.when) : null,
    createdBy: fields.createdBy,
    createdAt: fields.createdAt,
  });

  data.reportSchedules = [
    schedule({
      report: 'vat_report',
      format: 'pdf',
      when: { frequency: 'monthly', hour: 8, dayOfMonth: 1 },
      filters: {},
      recipientIds: [nusrat, rafiq],
      createdBy: nusrat,
      createdAt: made(90),
      paused: null,
      sent: true,
    }),
    schedule({
      report: 'sales_report',
      format: 'xlsx',
      when: { frequency: 'weekly', hour: 8, weekday: 0 },
      filters: { groupBy: 'customer', branchId: head.id, sort: '-net' },
      recipientIds: [nusrat, rafiq, kamal],
      createdBy: rafiq,
      createdAt: made(60),
      paused: null,
      sent: true,
    }),
    schedule({
      report: 'ap_aging',
      format: 'pdf',
      when: { frequency: 'daily', hour: 9 },
      filters: { supplierGroupId: yarn.id, show: 'all', sort: '-balance' },
      recipientIds: [kamal],
      createdBy: nusrat,
      createdAt: made(40),
      paused: 'no_recipients',
      sent: true,
    }),
    schedule({
      report: 'stock_movement',
      format: 'xlsx',
      when: { frequency: 'weekly', hour: 18, weekday: 6 },
      filters: { warehouseId: depot.id, show: 'moved', sort: 'name' },
      recipientIds: [nusrat, rafiq],
      createdBy: nusrat,
      createdAt: made(10),
      paused: 'manual',
      sent: false,
    }),
  ];
}
