import { describe, expect, it } from 'vitest';

import {
  journalEntryInputSchema,
  openingBalancesInputSchema,
  periodLockInputSchema,
  shiftIsoDate,
} from './journal.js';

const cash = '01939d1c-0000-7000-8000-000000000001';
const capital = '01939d1c-0000-7000-8000-000000000002';

function entry(lines: object[]) {
  return { date: '2026-09-23', narration: 'Capital paid in', lines, post: false };
}

describe('journal entry input', () => {
  it('takes a line with an amount on exactly one side', () => {
    const parsed = journalEntryInputSchema.parse(
      entry([
        { accountId: cash, branchId: '', description: '', debit: '500000', credit: '' },
        { accountId: capital, branchId: null, description: '', debit: '', credit: '500000' },
      ]),
    );
    expect(parsed.lines[0]).toMatchObject({ branchId: null, debit: '500000', credit: '0' });
  });

  it('refuses a line with both sides, or neither, under Debit', () => {
    for (const [debit, credit] of [
      ['100', '100'],
      ['', ''],
      ['0', '0.00'],
    ]) {
      const result = journalEntryInputSchema.safeParse(
        entry([
          { accountId: cash, branchId: null, description: '', debit, credit },
          { accountId: capital, branchId: null, description: '', debit: '', credit: '100' },
        ]),
      );
      expect(result.error?.issues[0]).toMatchObject({
        path: ['lines', 0, 'debit'],
        message: 'journal_line_amount',
      });
    }
  });

  it('reads an empty account select and a missing date as "not chosen"', () => {
    const result = journalEntryInputSchema.safeParse({
      ...entry([
        { accountId: '', branchId: null, description: '', debit: '1', credit: '' },
        { accountId: capital, branchId: null, description: '', debit: '', credit: '1' },
      ]),
      date: '',
    });
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['date', 'journal_date_required'],
      ['lines.0.accountId', 'journal_account_required'],
    ]);
  });

  it('needs two lines; balancing is checked when posting, not here', () => {
    const one = [{ accountId: cash, branchId: null, description: '', debit: '1', credit: '' }];
    expect(journalEntryInputSchema.safeParse(entry(one)).error?.issues[0]?.message).toBe(
      'journal_lines_too_few',
    );
    // A draft may be out of balance while it is being written
    const unbalanced = [...one, { ...one[0], debit: '2' }];
    expect(journalEntryInputSchema.safeParse(entry(unbalanced)).success).toBe(true);
  });
});

describe('lock date input', () => {
  it('reads an empty date picker as "no lock"', () => {
    expect(periodLockInputSchema.parse({ lockDate: '', version: 0 }).lockDate).toBeNull();
    expect(periodLockInputSchema.parse({ lockDate: '2026-06-30', version: 2 }).lockDate).toBe(
      '2026-06-30',
    );
  });
});

describe('shiftIsoDate', () => {
  it('moves across months, years and leap days without a time zone', () => {
    expect(shiftIsoDate('2026-07-01', -1)).toBe('2026-06-30');
    expect(shiftIsoDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(shiftIsoDate('2028-02-28', 1)).toBe('2028-02-29');
  });
});

describe('journal lines with a party (step 15a)', () => {
  const receivable = '01939d1c-0000-7000-8000-000000000003';
  const dealer = '01939d1c-0000-7000-8000-000000000004';

  it('reads a missing or empty customer as "no party"', () => {
    const parsed = journalEntryInputSchema.parse(
      entry([
        {
          accountId: receivable,
          branchId: '',
          description: '',
          debit: '1200',
          credit: '',
          partyId: dealer,
        },
        { accountId: cash, branchId: '', description: '', debit: '', credit: '1200', partyId: '' },
        { accountId: capital, branchId: '', description: '', debit: '', credit: '1' },
      ]),
    );
    expect(parsed.lines.map((line) => line.partyId)).toEqual([dealer, null, null]);
  });

  it('refuses the same account and customer twice in the opening balances', () => {
    const line = { accountId: receivable, partyId: dealer, debit: '5000', credit: '' };
    const result = openingBalancesInputSchema.safeParse({
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [line, { ...line, partyId: '01939d1c-0000-7000-8000-000000000005' }, line],
    });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['lines', 2, 'debit'], message: 'opening_balance_twice' }),
    ]);
  });

  it('lets empty lines repeat: the server drops them', () => {
    const empty = { accountId: receivable, partyId: '', debit: '', credit: '' };
    const result = openingBalancesInputSchema.safeParse({
      goLiveDate: '2026-07-01',
      replaces: null,
      lines: [empty, empty, { ...empty, partyId: dealer, debit: '5000' }],
    });
    expect(result.success).toBe(true);
  });
});
