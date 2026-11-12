import type { ReportScheduleWhen } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { catchUp, whenColumnsOf, whenOf } from './report-schedule-row.js';

// Dhaka is UTC+6 all year: 08:00 there is 02:00 UTC
const TIME_ZONE = 'Asia/Dhaka';

describe('a schedule time in the database', () => {
  it('keeps the day of its own frequency only, and reads back the same', () => {
    const times: ReportScheduleWhen[] = [
      { frequency: 'daily', hour: 8 },
      { frequency: 'weekly', hour: 9, weekday: 0 },
      { frequency: 'monthly', hour: 7, dayOfMonth: 28 },
    ];
    expect(times.map(whenColumnsOf)).toEqual([
      { frequency: 'daily', hour: 8, weekday: null, dayOfMonth: null },
      { frequency: 'weekly', hour: 9, weekday: 0, dayOfMonth: null },
      { frequency: 'monthly', hour: 7, weekday: null, dayOfMonth: 28 },
    ]);
    // Sunday is 0: a falsy day must not be lost on the way back
    expect(times.map((when) => whenOf(whenColumnsOf(when)))).toEqual(times);
  });

  it('refuses a row whose day is missing, rather than guess one', () => {
    expect(() => whenOf({ frequency: 'weekly', hour: 9, weekday: null, dayOfMonth: 5 })).toThrow(
      'no weekday',
    );
    expect(() => whenOf({ frequency: 'monthly', hour: 9, weekday: 1, dayOfMonth: null })).toThrow(
      'no day',
    );
  });
});

describe('catching up with the runs that are due', () => {
  const daily: ReportScheduleWhen = { frequency: 'daily', hour: 8 };

  it('sends the run that is due and moves on to the next one', () => {
    const due = new Date('2026-11-10T02:00:00Z');
    expect(catchUp(daily, TIME_ZONE, due, new Date('2026-11-10T02:04:00Z'))).toEqual({
      runAt: due,
      nextRunAt: new Date('2026-11-11T02:00:00Z'),
    });
  });

  it('sends only the latest of the runs a stopped worker missed', () => {
    // Down from Tuesday morning to Friday 08:01: four runs due, one sent, about Thursday
    expect(
      catchUp(daily, TIME_ZONE, new Date('2026-11-10T02:00:00Z'), new Date('2026-11-13T02:01:00Z')),
    ).toEqual({
      runAt: new Date('2026-11-13T02:00:00Z'),
      nextRunAt: new Date('2026-11-14T02:00:00Z'),
    });
    // Just before Friday's run: Thursday's is the latest, Friday's is next
    expect(
      catchUp(daily, TIME_ZONE, new Date('2026-11-10T02:00:00Z'), new Date('2026-11-13T01:59:00Z')),
    ).toEqual({
      runAt: new Date('2026-11-12T02:00:00Z'),
      nextRunAt: new Date('2026-11-13T02:00:00Z'),
    });
  });

  it('counts weeks for a weekly schedule', () => {
    const sunday: ReportScheduleWhen = { frequency: 'weekly', hour: 9, weekday: 0 };
    // Three Sundays missed: 8, 15 and 22 November; the 29th is the latest
    expect(
      catchUp(
        sunday,
        TIME_ZONE,
        new Date('2026-11-08T03:00:00Z'),
        new Date('2026-11-29T03:30:00Z'),
      ),
    ).toEqual({
      runAt: new Date('2026-11-29T03:00:00Z'),
      nextRunAt: new Date('2026-12-06T03:00:00Z'),
    });
  });
});
