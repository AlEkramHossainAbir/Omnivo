import { fiscalYearOf, shiftIsoDate } from '@omnivo/contracts';

// The report pages' dates, as ISO strings worked out from their parts. Never a Date in the local
// time zone: new Date('2026-07-01') is midnight UTC, which is still 30 June west of Greenwich.

export interface DateRange {
  from: string;
  to: string;
}

export const PERIOD_PRESETS = [
  'this_year',
  'last_year',
  'this_quarter',
  'last_quarter',
  'this_month',
  'last_month',
  'custom',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const COMPARE_MODES = ['none', 'previous_period', 'previous_year'] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

export const COMPARE_AS_OF_MODES = ['none', 'year_end', 'previous_year'] as const;
export type CompareAsOfMode = (typeof COMPARE_AS_OF_MODES)[number];

function parts(iso: string): { year: number; month: number; day: number } {
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

function iso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

// Days since 1970, for counting the days of a range
function dayNumber(date: string): number {
  const { year, month, day } = parts(date);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

function lastDayOf(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// The same day `months` months away; a day the target month does not have becomes its last day
// (31 March − 1 month = 28 or 29 February, not 3 March)
export function shiftMonths(date: string, months: number): string {
  const { year, month, day } = parts(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  return iso(targetYear, targetMonth, Math.min(day, lastDayOf(targetYear, targetMonth)));
}

function monthStart(date: string): string {
  const { year, month } = parts(date);
  return iso(year, month, 1);
}

function monthEnd(date: string): string {
  const { year, month } = parts(date);
  return iso(year, month, lastDayOf(year, month));
}

// The fiscal quarter that holds `date`: three-month blocks from the first month of the fiscal
// year (July–September is the first quarter of a July year)
function quarterStart(date: string, startMonth: number): string {
  const yearStart = fiscalYearOf(date, startMonth).start;
  const { year, month } = parts(date);
  const { year: y0, month: m0 } = parts(yearStart);
  const monthsIn = (year - y0) * 12 + (month - m0);
  return shiftMonths(yearStart, monthsIn - (monthsIn % 3));
}

// The dates of a preset on `today`. A period that is still running ends today, not on its last
// day: a report of days that have not happened yet only shows zeros.
export function presetRange(
  preset: Exclude<PeriodPreset, 'custom'>,
  today: string,
  startMonth: number,
): DateRange {
  switch (preset) {
    case 'this_year':
      return { from: fiscalYearOf(today, startMonth).start, to: today };
    case 'last_year': {
      const year = fiscalYearOf(
        shiftIsoDate(fiscalYearOf(today, startMonth).start, -1),
        startMonth,
      );
      return { from: year.start, to: year.end };
    }
    case 'this_quarter':
      return { from: quarterStart(today, startMonth), to: today };
    case 'last_quarter': {
      const from = shiftMonths(quarterStart(today, startMonth), -3);
      return { from, to: shiftIsoDate(shiftMonths(from, 3), -1) };
    }
    case 'this_month':
      return { from: monthStart(today), to: today };
    case 'last_month': {
      const from = shiftMonths(monthStart(today), -1);
      return { from, to: monthEnd(from) };
    }
  }
}

// The second column of a profit and loss.
// - previous_year: the same days a year earlier.
// - previous_period: the block of the same size just before. A range that starts on the first of
//   a month moves back by whole months (July–September → April–June, 1–15 October → 1–15
//   September), because months are not all the same length; any other range moves back by its
//   own number of days.
export function compareRange(range: DateRange, mode: CompareMode): DateRange | null {
  if (mode === 'none') return null;
  if (mode === 'previous_year') {
    return { from: shiftMonths(range.from, -12), to: shiftMonths(range.to, -12) };
  }
  const from = parts(range.from);
  if (from.day === 1) {
    const to = parts(range.to);
    const months = (to.year - from.year) * 12 + (to.month - from.month) + 1;
    const start = shiftMonths(range.from, -months);
    // A range that ends on a month's last day compares with a range that does too
    const end =
      range.to === monthEnd(range.to)
        ? monthEnd(shiftMonths(range.to, -months))
        : shiftMonths(range.to, -months);
    return { from: start, to: end };
  }
  const days = dayNumber(range.to) - dayNumber(range.from);
  const to = shiftIsoDate(range.from, -1);
  return { from: shiftIsoDate(to, -days), to };
}

// The second column of a balance sheet: the last day of the fiscal year before, or the same day
// a year earlier
export function compareAsOf(
  asOf: string,
  mode: CompareAsOfMode,
  startMonth: number,
): string | null {
  if (mode === 'none') return null;
  if (mode === 'year_end') return shiftIsoDate(fiscalYearOf(asOf, startMonth).start, -1);
  return shiftMonths(asOf, -12);
}
