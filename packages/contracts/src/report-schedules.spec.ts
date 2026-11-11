import { describe, expect, it } from 'vitest';

import {
  nextReportScheduleRun,
  reportScheduleFiltersOf,
  reportScheduleInputSchema,
  reportSchedulePeriod,
  reportScheduleQuery,
} from './report-schedules.js';

const DHAKA = 'Asia/Dhaka';
const NEW_YORK = 'America/New_York';

describe('nextReportScheduleRun', () => {
  const daily = { frequency: 'daily', hour: 8 } as const;

  it('takes today when the hour is still ahead in the workspace', () => {
    // 01:30 UTC is 07:30 in Dhaka
    expect(nextReportScheduleRun(daily, DHAKA, new Date('2026-11-09T01:30:00Z'))).toEqual(
      new Date('2026-11-09T02:00:00Z'),
    );
  });

  it('moves on from a run that has just happened', () => {
    expect(nextReportScheduleRun(daily, DHAKA, new Date('2026-11-09T02:00:00Z'))).toEqual(
      new Date('2026-11-10T02:00:00Z'),
    );
  });

  it('uses the workspace day, not the UTC day', () => {
    // 02:00 UTC on the 9th is still 21:00 on the 8th in New York, so 22:00 is one hour away. The
    // UTC day would skip it and wait until 22:00 on the 9th.
    expect(
      nextReportScheduleRun(
        { frequency: 'daily', hour: 22 },
        NEW_YORK,
        new Date('2026-11-09T02:00:00Z'),
      ),
    ).toEqual(new Date('2026-11-09T03:00:00Z'));
  });

  it('finds the weekday, counting 0 as Sunday', () => {
    // 2026-11-09 is a Monday; the next Sunday is the 15th
    expect(
      nextReportScheduleRun(
        { frequency: 'weekly', hour: 8, weekday: 0 },
        DHAKA,
        new Date('2026-11-09T06:00:00Z'),
      ),
    ).toEqual(new Date('2026-11-15T02:00:00Z'));
  });

  it('goes to next month once the day has passed, across a year end', () => {
    expect(
      nextReportScheduleRun(
        { frequency: 'monthly', hour: 8, dayOfMonth: 1 },
        DHAKA,
        new Date('2026-12-01T03:00:00Z'),
      ),
    ).toEqual(new Date('2027-01-01T02:00:00Z'));
  });

  it('keeps the wall clock across a change of the clocks', () => {
    // New York left summer time on 2026-11-01: 08:00 is 12:00 UTC before it and 13:00 UTC after
    expect(nextReportScheduleRun(daily, NEW_YORK, new Date('2026-10-31T13:00:00Z'))).toEqual(
      new Date('2026-11-01T13:00:00Z'),
    );
    expect(nextReportScheduleRun(daily, NEW_YORK, new Date('2026-10-30T13:00:00Z'))).toEqual(
      new Date('2026-10-31T12:00:00Z'),
    );
  });

  it('finds an hour just after the clocks go forward', () => {
    // New York jumped from 02:00 to 03:00 on 2026-03-08, so 03:00 that day is 07:00 UTC. Reading the
    // offset only once, from the night before, would give 08:00 UTC, which is 04:00 on the clock.
    expect(
      nextReportScheduleRun(
        { frequency: 'daily', hour: 3 },
        NEW_YORK,
        new Date('2026-03-07T12:00:00Z'),
      ),
    ).toEqual(new Date('2026-03-08T07:00:00Z'));
  });
});

describe('reportSchedulePeriod', () => {
  it('daily is yesterday', () => {
    expect(reportSchedulePeriod('daily', '2026-11-09')).toEqual({
      from: '2026-11-08',
      to: '2026-11-08',
    });
  });

  it('weekly is the seven days up to yesterday', () => {
    expect(reportSchedulePeriod('weekly', '2026-11-09')).toEqual({
      from: '2026-11-02',
      to: '2026-11-08',
    });
  });

  it('monthly is the whole month before, also over a leap February and a year end', () => {
    expect(reportSchedulePeriod('monthly', '2028-03-15')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(reportSchedulePeriod('monthly', '2027-01-01')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
});

describe('the filters of a schedule', () => {
  it('keeps the filters and drops every date', () => {
    expect(
      reportScheduleFiltersOf({
        from: '2026-07-01',
        to: '2026-07-31',
        compareFrom: '2025-07-01',
        compareTo: '2025-07-31',
        branchId: 'b',
        categoryId: undefined,
      }),
    ).toEqual({ branchId: 'b' });
  });

  it('gives a range report its dates and an as-of report the last day', () => {
    const period = { from: '2026-10-01', to: '2026-10-31' };
    expect(reportScheduleQuery('vat_report', { branchId: 'b' }, period)).toEqual({
      branchId: 'b',
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(reportScheduleQuery('ar_aging', { show: 'all' }, period)).toEqual({
      show: 'all',
      asOf: '2026-10-31',
    });
  });
});

describe('reportScheduleInputSchema', () => {
  const recipient = '0198b0a0-0000-7000-8000-000000000001';
  const valid = {
    report: 'vat_report',
    format: 'pdf',
    query: { from: '2026-10-01', to: '2026-10-31' },
    when: { frequency: 'monthly', hour: 8, dayOfMonth: 1 },
    recipientIds: [recipient],
  };

  it('takes an export query plus when and to whom', () => {
    expect(reportScheduleInputSchema.safeParse(valid).success).toBe(true);
  });

  it('needs the day of a weekly schedule', () => {
    expect(
      reportScheduleInputSchema.safeParse({ ...valid, when: { frequency: 'weekly', hour: 8 } })
        .success,
    ).toBe(false);
  });

  it('stops at the 28th, which every month has', () => {
    expect(
      reportScheduleInputSchema.safeParse({
        ...valid,
        when: { frequency: 'monthly', hour: 8, dayOfMonth: 29 },
      }).success,
    ).toBe(false);
  });

  it('refuses nobody, too many people and the same person twice', () => {
    const message = (recipientIds: string[]): string | undefined =>
      reportScheduleInputSchema.safeParse({ ...valid, recipientIds }).error?.issues[0]?.message;
    expect(message([])).toBe('report_schedule_recipients_needed');
    expect(message(Array.from({ length: 11 }, () => recipient))).toBe(
      'report_schedule_recipients_too_many',
    );
    expect(message([recipient, recipient])).toBe('report_schedule_recipient_invalid');
  });
});
