import { describe, expect, it } from 'vitest';

import { datedAllocations } from './applied-on.js';

// The rows of a receipt as the service has them: the invoice, the amount, and (now) the day
const now = [
  { invoiceId: 'inv-1', amount: '5000.0000', appliedOn: '2026-10-01' },
  { invoiceId: 'inv-2', amount: '3000.0000', appliedOn: '2026-10-03' },
];
const invoiceOf = (row: { invoiceId: string }) => row.invoiceId;

describe('datedAllocations', () => {
  it('keeps the day of a pair whose amount did not change, however the form writes it', () => {
    const rows = datedAllocations(
      [
        { invoiceId: 'inv-1', amount: '5000' },
        { invoiceId: 'inv-2', amount: '3000.00' },
      ],
      now,
      invoiceOf,
      '2026-11-05',
    );
    expect(rows.map((row) => row.appliedOn)).toEqual(['2026-10-01', '2026-10-03']);
  });

  it('gives the new day to a changed amount and to an invoice that was not paid before', () => {
    const rows = datedAllocations(
      [
        { invoiceId: 'inv-1', amount: '5000' },
        { invoiceId: 'inv-2', amount: '2000' },
        { invoiceId: 'inv-3', amount: '1000' },
      ],
      now,
      invoiceOf,
      '2026-11-05',
    );
    expect(rows).toEqual([
      { invoiceId: 'inv-1', amount: '5000', appliedOn: '2026-10-01' },
      // ৳1,000 less: the whole row is new, the known limit of decision 30
      { invoiceId: 'inv-2', amount: '2000', appliedOn: '2026-11-05' },
      { invoiceId: 'inv-3', amount: '1000', appliedOn: '2026-11-05' },
    ]);
  });

  it('dates every row by the day when the document had none', () => {
    const rows = datedAllocations(
      [{ invoiceId: 'inv-1', amount: '5000' }],
      [],
      invoiceOf,
      '2026-10-07',
    );
    expect(rows).toEqual([{ invoiceId: 'inv-1', amount: '5000', appliedOn: '2026-10-07' }]);
  });

  it('writes nothing for a pair that is gone', () => {
    expect(
      datedAllocations<{ invoiceId: string; amount: string }>([], now, invoiceOf, '2026-11-05'),
    ).toEqual([]);
  });
});
