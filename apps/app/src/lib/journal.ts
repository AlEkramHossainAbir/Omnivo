import {
  absMoney,
  type Account,
  isNegativeMoney,
  isZeroMoney,
  subtractMoney,
  sumMoney,
} from '@omnivo/contracts';
import type { SelectOption } from '@omnivo/ui';

// Sorts "1120" after "1110" and "1-2" before "1-10", like the chart of accounts does
const byCode = new Intl.Collator('en', { numeric: true });

// The accounts a journal line can post to: active ledgers, in code order. Groups never take an
// entry. `keep`: the accounts a draft already uses stay in the list even if they were archived
// since — otherwise the select would silently show another account. The server then refuses
// the archived one with a clear error under the line.
export function ledgerOptions(
  accounts: readonly Account[],
  keep: readonly string[] = [],
): SelectOption[] {
  return accounts
    .filter(
      (account) => !account.isGroup && (account.archivedAt === null || keep.includes(account.id)),
    )
    .toSorted((a, b) => byCode.compare(a.code, b.code))
    .map((account) => ({ value: account.id, label: `${account.code} · ${account.name}` }));
}

// The accounts that take an opening balance: active balance sheet ledgers, without the one the
// server fills itself (opening balance equity). Income and expenses start at zero.
export function openingAccounts(accounts: readonly Account[]): Account[] {
  return accounts
    .filter(
      (account) =>
        !account.isGroup &&
        account.archivedAt === null &&
        account.purpose !== 'opening_balance_equity' &&
        (account.type === 'asset' || account.type === 'liability' || account.type === 'equity'),
    )
    .toSorted((a, b) => byCode.compare(a.code, b.code));
}

export interface Totals {
  debit: string;
  credit: string;
  // debit − credit: what the entry is out by
  difference: string;
  // Equal, and not both zero: an empty form is not "balanced"
  balanced: boolean;
}

// The form's live totals. Decimal strings all the way: 0.1 + 0.2 must be 0.3 here too.
export function totalsOf(lines: readonly { debit: string; credit: string }[]): Totals {
  const debit = sumMoney(lines.map((line) => line.debit));
  const credit = sumMoney(lines.map((line) => line.credit));
  const difference = subtractMoney(debit, credit);
  return { debit, credit, difference, balanced: isZeroMoney(difference) && !isZeroMoney(debit) };
}

// A signed balance (debit − credit) as an amount and a side: "-1200.0000" → 1200, credit.
// Zero has no side.
export function balanceSide(value: string): { amount: string; side: 'debit' | 'credit' | null } {
  if (isZeroMoney(value)) return { amount: '0', side: null };
  return { amount: absMoney(value), side: isNegativeMoney(value) ? 'credit' : 'debit' };
}

// The server sends "0.0000" for the empty side; the form shows it empty
export function formAmount(value: string): string {
  return isZeroMoney(value) ? '' : value;
}

// The first day of the fiscal year that holds `isoDate`: 2026-09-23 with a July start →
// 2026-07-01; 2027-03-10 → 2026-07-01 too. The ledger opens on it.
export function fiscalYearStart(isoDate: string, startMonth: number): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  const startYear = month >= startMonth ? year : year - 1;
  return `${String(startYear)}-${String(startMonth).padStart(2, '0')}-01`;
}

// A field of one row in react-hook-form's field array: linePath(2, 'debit') → "lines.2.debit".
// react-hook-form types it `lines.${number}.debit`. The lint rule restrict-template-expressions
// wants String(index) inside a template, but that gives `${string}`, which react-hook-form does not
// accept. The one cast here only says "this text was made from a number" — String(index) makes
// sure of it. Kept in this one place (CLAUDE.md rule 3).
export function linePath<F extends string>(index: number, field: F): `lines.${number}.${F}` {
  return `lines.${String(index)}.${field}` as `lines.${number}.${F}`;
}
