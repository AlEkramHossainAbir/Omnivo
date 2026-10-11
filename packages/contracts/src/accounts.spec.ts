import { describe, expect, it } from 'vitest';

import {
  type Account,
  createAccountInputSchema,
  moneyAccountIds,
  updateAccountInputSchema,
} from './accounts.js';

const valid = {
  parentId: '01939d1c-0000-7000-8000-000000000001',
  code: '1121',
  name: 'Dutch-Bangla Bank CD A/C 1234',
  isGroup: false,
  holdsMoney: true,
  description: '',
};

describe('account input', () => {
  it('takes codes of digits, split by dots or hyphens', () => {
    for (const code of ['1121', '1-1-21', '11.21', ' 1121 ']) {
      expect(createAccountInputSchema.safeParse({ ...valid, code }).success).toBe(true);
    }
  });

  it('refuses letters, spaces inside and a trailing separator, with a field code', () => {
    for (const code of ['CASH', '11 21', '1121-', '', '1'.repeat(21)]) {
      const result = createAccountInputSchema.safeParse({ ...valid, code });
      expect(result.error?.issues[0]).toMatchObject({
        path: ['code'],
        message: 'account_code_format',
      });
    }
  });

  it('reads an empty parent select as "not chosen"', () => {
    const result = createAccountInputSchema.safeParse({ ...valid, parentId: '' });
    expect(result.error?.issues[0]).toMatchObject({
      path: ['parentId'],
      message: 'account_parent_required',
    });
  });

  it('stores an empty description as null', () => {
    expect(createAccountInputSchema.parse(valid).description).toBeNull();
  });

  it('lets only an update keep the parent empty (a top-level group)', () => {
    const top = {
      parentId: null,
      code: '1000',
      name: 'Assets',
      holdsMoney: false,
      description: '',
      version: 3,
    };
    expect(updateAccountInputSchema.parse(top).parentId).toBeNull();
    expect(createAccountInputSchema.safeParse({ ...valid, parentId: null }).success).toBe(false);
  });
});

describe('moneyAccountIds', () => {
  type Row = Pick<Account, 'id' | 'parentId' | 'isGroup' | 'holdsMoney' | 'archivedAt'>;
  const row = (id: string, parentId: string | null, isGroup: boolean, holdsMoney = false): Row => ({
    id,
    parentId,
    isGroup,
    holdsMoney,
    archivedAt: null,
  });
  // Assets → Current assets → Cash in hand (flagged), Bank accounts (flagged group) → DBBL, and a
  // receivable that holds no money
  const chart: Row[] = [
    row('assets', null, true),
    row('current', 'assets', true),
    row('cash', 'current', false, true),
    row('banks', 'current', true, true),
    row('dbbl', 'banks', false),
    row('receivable', 'current', false),
  ];

  it('takes flagged accounts and every account under a flagged group, never the group', () => {
    expect([...moneyAccountIds(chart)].sort()).toEqual(['cash', 'dbbl']);
  });

  it('leaves out an archived account', () => {
    const archived = chart.map((account) =>
      account.id === 'dbbl' ? { ...account, archivedAt: '2026-10-01T00:00:00.000Z' } : account,
    );
    expect([...moneyAccountIds(archived)]).toEqual(['cash']);
  });

  it('stops on a chart with a loop instead of hanging', () => {
    const loop = [row('a', 'b', true), row('b', 'a', true), row('c', 'a', false)];
    expect(moneyAccountIds(loop).size).toBe(0);
  });
});
