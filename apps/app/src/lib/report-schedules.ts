import {
  isReportKind,
  PURCHASE_REPORT_GROUPS,
  type ReportKind,
  type ReportSchedule,
  type ReportScheduleWhen,
  routes,
  SALES_REPORT_GROUPS,
} from '@omnivo/contracts';
import { useLocale } from '@omnivo/i18n';
import { queryOptions } from '@tanstack/react-query';
import { useCallback } from 'react';

import { call } from './api';

// Step 21c: what the scheduled emails page and the schedule dialog share. Its own module: the
// dialog is a lazy chunk, and the page must not pull it in to get the words of a row.

// The workspace's schedules. Not paged: a workspace has at most 20 (MAX_REPORT_SCHEDULES).
export function reportSchedulesQuery(tenantId: string) {
  return queryOptions({
    queryKey: ['report-schedules', tenantId],
    queryFn: () => call(routes.reportSchedules.list),
  });
}

// The members who may read the report, so the form offers nobody else. Under the list's key, so
// saving a schedule (which invalidates the list) asks again too.
export function reportScheduleCandidatesQuery(tenantId: string, report: ReportKind) {
  return queryOptions({
    queryKey: ['report-schedules', tenantId, 'candidates', report],
    queryFn: () => call(routes.reportSchedules.candidates, { query: { report } }),
  });
}

// 0 = Sunday, as the contract counts (Date.getUTCDay()). The keys of reportSchedules.weekdays in
// this order (decision 52), so the number never has to be a key.
export const WEEKDAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

export const SCHEDULE_HOURS = Array.from({ length: 24 }, (_, hour) => hour);

// The words of a schedule: "Every Sunday at 08:00", the report's name and its filter lines
export function useScheduleWords() {
  const { t, format } = useLocale();

  // A whole hour as the clock shows it ("08:00", "০৮:০০"). Read in UTC from a UTC date, so no time
  // zone moves it: the hour means the workspace's time, and the page only names it.
  const hour = useCallback(
    (value: number) => format.time(new Date(Date.UTC(2026, 0, 1, value)), 'UTC'),
    [format],
  );

  const when = useCallback(
    (value: ReportScheduleWhen) => {
      const time = hour(value.hour);
      switch (value.frequency) {
        case 'daily':
          return t('reportSchedules.when.daily', { time });
        case 'weekly':
          return t('reportSchedules.when.weekly', {
            time,
            // weekday is 0–6 (the contract checks it), so the key is always there
            weekday: t(`reportSchedules.weekdays.${WEEKDAY_KEYS[value.weekday] ?? 'sunday'}`),
          });
        case 'monthly':
          return t('reportSchedules.when.monthly', { time, day: format.number(value.dayOfMonth) });
      }
    },
    [t, format, hour],
  );

  // The report's name, or the raw kind from a newer server this app does not know yet
  const report = useCallback(
    (kind: string) => (isReportKind(kind) ? t(`reports.kinds.${kind}`) : kind),
    [t],
  );

  // The lines under a schedule's name: the filters it keeps, by name (the API resolved the ids).
  // Group by is a word of the report, not an id, so the page names it from the kept filters.
  const filterLines = useCallback(
    (schedule: Pick<ReportSchedule, 'report' | 'filters' | 'filterNames'>): string[] => {
      const lines: string[] = [];
      const group = groupByWord(schedule.report, schedule.filters.groupBy);
      if (group !== null) lines.push(t('reportSchedules.filterLines.groupBy', { name: t(group) }));
      const names = schedule.filterNames;
      if (names.branch !== null) {
        lines.push(t('reportSchedules.filterLines.branch', { name: names.branch }));
      }
      if (names.warehouse !== null) {
        lines.push(t('reportSchedules.filterLines.warehouse', { name: names.warehouse }));
      }
      if (names.group !== null) {
        lines.push(t('reportSchedules.filterLines.group', { name: names.group }));
      }
      if (names.category !== null) {
        lines.push(t('reportSchedules.filterLines.category', { name: names.category }));
      }
      return lines;
    },
    [t],
  );

  return { hour, when, report, filterLines };
}

// The i18n key of a sales or purchase report's Group by, or null for every other report (and for
// a value this app does not know). find() narrows the string to the report's own groups.
function groupByWord(report: string, value: string | undefined) {
  if (value === undefined) return null;
  if (report === 'sales_report') {
    const group = SALES_REPORT_GROUPS.find((item) => item === value);
    return group === undefined ? null : (`reports.sales.groups.${group}` as const);
  }
  if (report === 'purchase_report') {
    const group = PURCHASE_REPORT_GROUPS.find((item) => item === value);
    return group === undefined ? null : (`reports.purchases.groups.${group}` as const);
  }
  return null;
}
