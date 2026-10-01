import type { Account } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { groupOptions, suggestCode } from './account-tree';

let next = 0;
function account(code: string, parent: Account | null, fields: Partial<Account> = {}): Account {
  next += 1;
  return {
    id: `01939d1c-0000-7000-8000-${String(next).padStart(12, '0')}`,
    parentId: parent?.id ?? null,
    code,
    name: `Account ${code}`,
    type: parent?.type ?? 'asset',
    isGroup: false,
    purpose: null,
    description: null,
    archivedAt: null,
    version: 1,
    updatedAt: '2026-09-30T10:00:00.000Z',
    ...fields,
  };
}

const assets = account('1000', null, { isGroup: true });
const current = account('1100', assets, { isGroup: true });
const cash = account('1110', current);
const banks = account('1120', current, { isGroup: true });
const expenses = account('5000', null, { isGroup: true, type: 'expense' });
const chart = [assets, current, cash, banks, expenses];

describe('suggestCode', () => {
  it('continues after the last account in the group', () => {
    expect(suggestCode(current, chart)).toBe('1130');
  });

  it('starts an empty group one place below its own code', () => {
    expect(suggestCode(banks, chart)).toBe('1121');
    expect(suggestCode(assets, [assets])).toBe('1100');
  });

  it('skips a code already taken elsewhere, and gives up at the edge of the group', () => {
    const taken = account('1130', banks);
    expect(suggestCode(current, [...chart, taken])).toBe('1140');
    const full = account('1190', current);
    expect(suggestCode(current, [...chart, full])).toBe('');
  });

  it('suggests nothing for codes it cannot count, like 1-1-10', () => {
    expect(suggestCode(account('1-1', null, { isGroup: true }), chart)).toBe('');
  });
});

describe('groupOptions', () => {
  it('lists active groups in tree order, indented', () => {
    expect(groupOptions(chart).map((option) => option.label)).toEqual([
      '1000 · Account 1000',
      ' 1100 · Account 1100',
      '  1120 · Account 1120',
      '5000 · Account 5000',
    ]);
  });

  it('never offers a moved group itself, its own branch, or another type', () => {
    expect(groupOptions(chart, current).map((option) => option.value)).toEqual([assets.id]);
  });
});
