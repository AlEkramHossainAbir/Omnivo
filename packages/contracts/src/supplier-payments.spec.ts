import { describe, expect, it } from 'vitest';

import {
  paymentAllocationsInputSchema,
  supplierPaymentInputSchema,
  unappliedPaymentOf,
} from './supplier-payments.js';

const SUPPLIER = '01920000-0000-7000-8000-000000000001';
const ACCOUNT = '01920000-0000-7000-8000-000000000002';
const BRANCH = '01920000-0000-7000-8000-000000000003';
const BILL_A = '01920000-0000-7000-8000-000000000004';
const BILL_B = '01920000-0000-7000-8000-000000000005';

function payment(extra: Record<string, unknown> = {}) {
  return {
    supplierId: SUPPLIER,
    date: '2026-11-05',
    amount: '150000',
    accountId: ACCOUNT,
    method: 'cheque',
    reference: 'CHQ 0045123',
    supplierBankAccountId: '',
    branchId: BRANCH,
    orderId: '',
    note: '',
    allocations: [{ billId: BILL_A, amount: '100000' }],
    submit: false,
    ...extra,
  };
}

describe('supplier payment input', () => {
  it('reads empty boxes as "not set": no bank account, no order, no note', () => {
    expect(supplierPaymentInputSchema.parse(payment())).toMatchObject({
      supplierBankAccountId: null,
      orderId: null,
      note: null,
    });
  });

  it('takes a payment with no bill at all: the whole amount is an advance', () => {
    expect(supplierPaymentInputSchema.safeParse(payment({ allocations: [] })).success).toBe(true);
  });

  it('needs an amount above zero', () => {
    expect(
      supplierPaymentInputSchema.safeParse(payment({ amount: '0', allocations: [] })).error?.issues,
    ).toEqual([expect.objectContaining({ path: ['amount'], message: 'payment_amount_required' })]);
  });

  it('never applies more than it pays', () => {
    const allocations = [
      { billId: BILL_A, amount: '100000' },
      { billId: BILL_B, amount: '50000.01' },
    ];
    expect(supplierPaymentInputSchema.safeParse(payment({ allocations })).error?.issues).toEqual([
      expect.objectContaining({ path: ['allocations'], message: 'payment_over_allocated' }),
    ]);
  });

  it('puts a bill on one row only', () => {
    const allocations = [
      { billId: BILL_A, amount: '100' },
      { billId: BILL_A, amount: '200' },
    ];
    expect(
      paymentAllocationsInputSchema.safeParse({ version: 2, allocations }).error?.issues,
    ).toEqual([
      expect.objectContaining({
        path: ['allocations', 1, 'billId'],
        message: 'payment_bill_twice',
      }),
    ]);
  });

  it('leaves the over-applied check to the box that is wrong', () => {
    // A malformed amount is its own error; adding it up would only throw
    const allocations = [{ billId: BILL_A, amount: '1.23456' }];
    expect(supplierPaymentInputSchema.safeParse(payment({ allocations })).error?.issues).toEqual([
      expect.objectContaining({ path: ['allocations', 0, 'amount'], message: 'money_format' }),
    ]);
  });

  it('says what is left to apply, less what supplier refunds paid back', () => {
    expect(
      unappliedPaymentOf({ amount: '150000.0000', applied: '100000.0000', refunded: '0.0000' }),
    ).toBe('50000.0000');
    expect(
      unappliedPaymentOf({ amount: '150000.0000', applied: '100000.0000', refunded: '20000.0000' }),
    ).toBe('30000.0000');
  });
});
