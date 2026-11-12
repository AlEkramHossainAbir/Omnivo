import { nextReportScheduleRun, type ReportScheduleWhen } from '@omnivo/contracts';
import type { reportSchedules } from '@omnivo/db';

// A schedule's time is four columns in the database (21c decision 35) and a discriminated union in
// the contract (decision 26). These two functions are the only places that turn one into the
// other, for the API and the worker alike.

export type ScheduleRow = typeof reportSchedules.$inferSelect;

type WhenColumns = Pick<ScheduleRow, 'frequency' | 'hour' | 'weekday' | 'dayOfMonth'>;

export function whenColumnsOf(when: ReportScheduleWhen): WhenColumns {
  return {
    frequency: when.frequency,
    hour: when.hour,
    weekday: when.frequency === 'weekly' ? when.weekday : null,
    dayOfMonth: when.frequency === 'monthly' ? when.dayOfMonth : null,
  };
}

// The database's checks keep each day with its frequency, so a missing day here is a row changed
// by hand: an error, not a guess
export function whenOf(row: WhenColumns): ReportScheduleWhen {
  switch (row.frequency) {
    case 'daily':
      return { frequency: 'daily', hour: row.hour };
    case 'weekly':
      if (row.weekday === null) throw new Error('A weekly report schedule has no weekday');
      return { frequency: 'weekly', hour: row.hour, weekday: row.weekday };
    case 'monthly':
      if (row.dayOfMonth === null) throw new Error('A monthly report schedule has no day');
      return { frequency: 'monthly', hour: row.hour, dayOfMonth: row.dayOfMonth };
  }
}

// What the sweep does with a schedule that is due: the run it sends and the next one (decision 9).
// A worker that was down for three days finds a daily schedule three runs behind; it sends one, for
// the latest run that is due (so the email is about yesterday, not about four days ago), and moves
// on to the first run after now.
export function catchUp(
  when: ReportScheduleWhen,
  timeZone: string,
  due: Date,
  now: Date,
): { runAt: Date; nextRunAt: Date } {
  let runAt = due;
  // Ends: each step is a later run, and now is a fixed moment
  for (;;) {
    const next = nextReportScheduleRun(when, timeZone, runAt);
    if (next > now) return { runAt, nextRunAt: next };
    runAt = next;
  }
}
