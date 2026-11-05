import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  overAllocated,
  receiptAllocationsInputSchema,
  receiptInputSchema,
  voidReceiptInputSchema,
} from './receipts.js';

const CUSTOMER = '01920000-0000-7000-8000-000000000001';
const BRANCH = '01920000-0000-7000-8000-000000000002';
const ACCOUNT = '01920000-0000-7000-8000-000000000003';
const INVOICE_A = '01920000-0000-7000-8000-000000000004';
const INVOICE_B = '01920000-0000-7000-8000-000000000005';

function receipt(extra: object = {}) {
  return {
    customerId: CUSTOMER,
    date: '2026-10-08',
    amount: '50000',
    accountId: ACCOUNT,
    method: 'cheque',
    reference: 'DBBL 0048812',
    branchId: BRANCH,
    note: '',
    allocations: [
      { invoiceId: INVOICE_A, amount: '30000' },
      { invoiceId: INVOICE_B, amount: '20000' },
    ],
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

describe('receipt input', () => {
  it('takes a receipt applied in full, in part, or not at all (an advance)', () => {
    expect(receiptInputSchema.safeParse(receipt()).success).toBe(true);
    expect(
      receiptInputSchema.safeParse(
        receipt({ allocations: [{ invoiceId: INVOICE_A, amount: '1' }] }),
      ).success,
    ).toBe(true);
    expect(receiptInputSchema.parse(receipt({ allocations: [] })).allocations).toEqual([]);
  });

  it('needs an amount above zero, one error per box', () => {
    for (const amount of ['', '0', '0.00']) {
      const result = receiptInputSchema.safeParse(receipt({ amount, allocations: [] }));
      expect(errorsOf(result)).toEqual({ amount: 'receipt_amount_required' });
    }
    const typo = receiptInputSchema.safeParse(receipt({ amount: '50,000', allocations: [] }));
    expect(errorsOf(typo)).toEqual({ amount: 'money_format' });
  });

  it('never applies more than the receipt, nor one invoice twice', () => {
    const over = receiptInputSchema.safeParse(receipt({ amount: '49999.99' }));
    expect(errorsOf(over)).toEqual({ allocations: 'receipt_over_allocated' });

    const twice = receiptInputSchema.safeParse(
      receipt({
        allocations: [
          { invoiceId: INVOICE_A, amount: '100' },
          { invoiceId: INVOICE_A, amount: '100' },
        ],
      }),
    );
    expect(errorsOf(twice)).toEqual({ 'allocations.1.invoiceId': 'receipt_invoice_twice' });
  });

  it('marks every mistake at once', () => {
    const result = receiptInputSchema.safeParse(
      receipt({
        customerId: '',
        accountId: '',
        branchId: '',
        allocations: [{ invoiceId: '', amount: '0' }],
      }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      customerId: 'sales_customer_required',
      accountId: 'receipt_account_invalid',
      branchId: 'sales_branch_invalid',
      'allocations.0.invoiceId': 'receipt_invoice_invalid',
      'allocations.0.amount': 'receipt_amount_required',
    });
  });

  it('applies again without the amount, which the server knows', () => {
    const result = receiptAllocationsInputSchema.safeParse({
      version: 2,
      allocations: [
        { invoiceId: INVOICE_B, amount: '5000' },
        { invoiceId: INVOICE_B, amount: '5000' },
      ],
    });
    expect(errorsOf(result)).toEqual({ 'allocations.1.invoiceId': 'receipt_invoice_twice' });
    expect(overAllocated('50000', [{ amount: '30000' }, { amount: '20000.0001' }])).toBe(true);
    expect(overAllocated('50000', [{ amount: '30000' }, { amount: '20000' }])).toBe(false);
  });

  it('voids only with a reason', () => {
    const result = voidReceiptInputSchema.safeParse({
      version: 1,
      date: '2026-10-12',
      reason: '  ',
    });
    expect(errorsOf(result)).toEqual({ reason: 'receipt_void_reason_required' });
  });
});
