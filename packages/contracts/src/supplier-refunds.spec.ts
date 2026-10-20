import { describe, expect, it } from 'vitest';

import { supplierRefundInputSchema } from './supplier-refunds.js';

const SUPPLIER = '01920000-0000-7000-8000-000000000001';
const ACCOUNT = '01920000-0000-7000-8000-000000000002';
const BRANCH = '01920000-0000-7000-8000-000000000003';
const DEBIT_NOTE = '01920000-0000-7000-8000-000000000004';
const PAYMENT = '01920000-0000-7000-8000-000000000005';

function refund(extra: Record<string, unknown> = {}) {
  return {
    supplierId: SUPPLIER,
    date: '2026-11-02',
    amount: '7245',
    accountId: ACCOUNT,
    method: 'bank_transfer',
    reference: 'BEFTN 2611020041',
    branchId: BRANCH,
    note: '',
    debitNoteId: DEBIT_NOTE,
    paymentId: '',
    ...extra,
  };
}

describe('supplier refund input', () => {
  it("takes back a debit note's money or a payment's advance", () => {
    expect(supplierRefundInputSchema.parse(refund()).debitNoteId).toBe(DEBIT_NOTE);
    const parsed = supplierRefundInputSchema.parse(refund({ debitNoteId: '', paymentId: PAYMENT }));
    expect([parsed.debitNoteId, parsed.paymentId]).toEqual([null, PAYMENT]);
  });

  it('needs exactly one source, on the first box', () => {
    for (const sources of [
      { debitNoteId: '', paymentId: '' },
      { debitNoteId: DEBIT_NOTE, paymentId: PAYMENT },
    ]) {
      expect(supplierRefundInputSchema.safeParse(refund(sources)).error?.issues).toEqual([
        expect.objectContaining({ path: ['debitNoteId'], message: 'supplier_refund_source' }),
      ]);
    }
  });

  it('needs an amount above zero, with its own error code', () => {
    for (const amount of ['', '0']) {
      expect(supplierRefundInputSchema.safeParse(refund({ amount })).error?.issues).toEqual([
        expect.objectContaining({ path: ['amount'], message: 'supplier_refund_amount_required' }),
      ]);
    }
  });
});
