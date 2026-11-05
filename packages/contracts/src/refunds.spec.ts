import { describe, expect, it } from 'vitest';

import { unappliedOf } from './receipts.js';
import { refundInputSchema } from './refunds.js';

const CUSTOMER = '01920000-0000-7000-8000-000000000001';
const BRANCH = '01920000-0000-7000-8000-000000000002';
const ACCOUNT = '01920000-0000-7000-8000-000000000003';
const RECEIPT = '01920000-0000-7000-8000-000000000004';
const CREDIT_NOTE = '01920000-0000-7000-8000-000000000005';

function refund(extra: object = {}) {
  return {
    customerId: CUSTOMER,
    date: '2026-10-11',
    amount: '5000',
    accountId: ACCOUNT,
    method: 'mobile_wallet',
    reference: 'BKS 9F3K2L1M',
    branchId: BRANCH,
    note: '',
    receiptId: '',
    creditNoteId: CREDIT_NOTE,
    ...extra,
  };
}

// The error codes where the form will show them: field path → code
function errorsOf(result: {
  success: boolean;
  error?: { issues: { path: PropertyKey[]; message: string }[] };
}) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

describe('refund input', () => {
  it("pays back a credit note's money or a receipt's", () => {
    expect(refundInputSchema.parse(refund())).toMatchObject({
      receiptId: null,
      creditNoteId: CREDIT_NOTE,
    });
    expect(refundInputSchema.parse(refund({ receiptId: RECEIPT, creditNoteId: '' }))).toMatchObject(
      { receiptId: RECEIPT, creditNoteId: null },
    );
  });

  it('needs exactly one source', () => {
    for (const source of [
      { receiptId: '', creditNoteId: '' },
      { receiptId: RECEIPT, creditNoteId: CREDIT_NOTE },
    ]) {
      expect(errorsOf(refundInputSchema.safeParse(refund(source)))).toEqual({
        receiptId: 'refund_source',
      });
    }
  });

  it('needs an amount above zero, with its own error code', () => {
    for (const amount of ['', '0', '0.00']) {
      expect(errorsOf(refundInputSchema.safeParse(refund({ amount })))).toEqual({
        amount: 'refund_amount_required',
      });
    }
  });
});

describe('unapplied money', () => {
  it('is the amount less what is applied and what refunds paid back', () => {
    expect(
      unappliedOf({ amount: '50000.0000', applied: '30000.0000', refunded: '5000.0000' }),
    ).toBe('15000.0000');
  });
});
