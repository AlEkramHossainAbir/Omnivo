import type { Account } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { balanceSide, fiscalYearStart, ledgerOptions, openingAccounts, totalsOf } from './journal';

function account(code: string, fields: Partial<Account> = {}): Account {
  return {
    id: `id-${code}`,
    parentId: null,
    code,
    name: `Account ${code}`,
    type: 'asset',
    isGroup: false,
    purpose: null,
    description: null,
    archivedAt: null,
    version: 1,
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...fields,
  };
}

describe('journal helpers', () => {
  it('offers active ledgers in code order, and keeps an archived one a draft uses', () => {
    const accounts = [
      account('1120', { isGroup: true }),
      account('1130'),
      account('1110'),
      account('1-10'),
      account('1-2'),
      account('1140', { archivedAt: '2026-09-01T00:00:00.000Z' }),
    ];
    expect(ledgerOptions(accounts).map((option) => option.label)).toEqual([
      '1-2 · Account 1-2',
      '1-10 · Account 1-10',
      '1110 · Account 1110',
      '1130 · Account 1130',
    ]);
    expect(ledgerOptions(accounts, ['id-1140']).map((option) => option.value)).toContain('id-1140');
  });

  it('takes opening balances on balance sheet ledgers only, without opening balance equity', () => {
    const accounts = [
      account('1110'),
      account('2110', { type: 'liability' }),
      account('3300', { type: 'equity', purpose: 'opening_balance_equity' }),
      account('4110', { type: 'income' }),
      account('1100', { isGroup: true }),
    ];
    expect(openingAccounts(accounts).map((item) => item.code)).toEqual(['1110', '2110']);
  });

  it('totals exactly and calls an empty form unbalanced', () => {
    expect(
      totalsOf([
        { debit: '0.1', credit: '' },
        { debit: '0.2', credit: '' },
        { debit: '', credit: '0.3' },
      ]),
    ).toEqual({
      debit: '0.3000',
      credit: '0.3000',
      difference: '0.0000',
      balanced: true,
    });
    expect(totalsOf([{ debit: '', credit: '' }]).balanced).toBe(false);
    expect(
      totalsOf([
        { debit: '100', credit: '' },
        { debit: '', credit: '90' },
      ]).difference,
    ).toBe('10.0000');
  });

  it('reads a balance as an amount and a side', () => {
    expect(balanceSide('-1200.0000')).toEqual({ amount: '1200.0000', side: 'credit' });
    expect(balanceSide('350.5000')).toEqual({ amount: '350.5000', side: 'debit' });
    expect(balanceSide('0.0000')).toEqual({ amount: '0', side: null });
  });
});

describe('fiscalYearStart', () => {
  it('finds the July (or January) that opens the year', () => {
    expect(fiscalYearStart('2026-09-23', 7)).toBe('2026-07-01');
    expect(fiscalYearStart('2027-03-10', 7)).toBe('2026-07-01');
    expect(fiscalYearStart('2026-07-01', 7)).toBe('2026-07-01');
    expect(fiscalYearStart('2026-09-23', 1)).toBe('2026-01-01');
  });
});
