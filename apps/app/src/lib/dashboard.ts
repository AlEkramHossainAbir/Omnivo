import {
  absMoney,
  changePercent,
  type Dashboard,
  type DashboardCard,
  isNegativeMoney,
  isZeroMoney,
  percentOfWhole,
  subtractMoney,
  todayIn,
} from '@omnivo/contracts';

// Step 21a: what the Overview works out from the answer before it writes anything. Pure, so the
// rules are tested without a page.

// The cards a branch changes (decision 11). With none of them, the branch select would change
// nothing on the page, so it is not shown.
export const BRANCH_CARDS: readonly DashboardCard[] = ['sales', 'margin', 'topProducts'];

// A sales change line. `percent` has no sign: the words say "more" or "less" (dashboard.sales.*).
// none = nothing to compare with (no sales yesterday): no percent at all (decision 20).
export type SalesChange =
  { kind: 'more' | 'less'; percent: string } | { kind: 'same' } | { kind: 'none' };

export function salesChange(current: string, previous: string): SalesChange {
  const percent = changePercent(current, previous);
  if (percent === null) return { kind: 'none' };
  // "0.0" and "-0.0" (a change smaller than 0.05%) both read "The same as yesterday"
  if (isZeroMoney(percent)) return { kind: 'same' };
  // The sign is cut off, not absMoney(): that writes 4 decimals, and a percent keeps its one
  return percent.startsWith('-')
    ? { kind: 'less', percent: percent.slice(1) }
    : { kind: 'more', percent };
}

// The cash's change line against the end of yesterday (decision 21). `amount` has no sign either.
export type CashChange = { kind: 'up' | 'down'; amount: string } | { kind: 'same' };

export function cashChange(cash: NonNullable<Dashboard['cash']>): CashChange {
  const change = subtractMoney(cash.total, cash.yesterday);
  if (isZeroMoney(change)) return { kind: 'same' };
  return { kind: isNegativeMoney(change) ? 'down' : 'up', amount: absMoney(change) };
}

// The width of a top product's bar: its share of the first one's amount, as a CSS percent. The
// first is the largest (the API's order), so every bar fits; one below zero (more taken off than
// sold is not possible, but a bar must never point backwards) is empty.
export function barWidth(amount: string, largest: string): string {
  if (isZeroMoney(largest) || isNegativeMoney(amount)) return '0%';
  return `${percentOfWhole(amount, largest)}%`;
}

// Whether every day of the chart is zero: then the card says so instead of a flat line
export function nothingSold(days: readonly { amount: string }[]): boolean {
  return days.every((day) => isZeroMoney(day.amount));
}

// "As of 10:42" for an answer made today in the workspace, the date and time before that: a
// device offline over a weekend must not say "As of 10:42" for Friday's numbers.
export function madeToday(generatedAt: string, timeZone: string, now: Date = new Date()): boolean {
  return todayIn(timeZone, new Date(generatedAt)) === todayIn(timeZone, now);
}
