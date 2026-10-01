import { describe, expect, it } from 'vitest';

import { journalEntryInputSchema, periodLockInputSchema, shiftIsoDate } from './journal.js';

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
