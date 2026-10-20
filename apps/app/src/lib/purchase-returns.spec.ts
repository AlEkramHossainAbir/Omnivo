import type {
  BillExpense,
  BillLine,
  DebitNoteSummary,
  GoodsReceiptLine,
  PurchaseReturnLine,
  SupplierPaymentSummary,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  debitableExpenses,
  debitableReturnLines,
  debitFormTotals,
  debitLeft,
  debitStartOf,
  expenseToDebit,
  leftToDebitOf,
  ownReturnLineToDebit,
  receiptLineToReturn,
  returnableReceiptLines,
  returnLineToDebit,
  supplierRefundSourcesOf,
  supplierSourceFields,
  supplierSourceKeyOf,
  toPurchaseReturnFormLine,
} from './purchase-returns';
import { debitReasonKey, purchaseReturnReasonKey } from './returns';

// Denim from a mill, received by the roll of 50 m; the metre is the base unit
const item = {
  variantId: 'denim',
  productId: 'p-denim',
  productCode: 'P-00112',
  productName: '12 oz indigo denim',
  optionValues: [],
  sku: 'P-00112',
  baseUnitId: 'm',
  tracking: 'batch',
  hasExpiry: false,
  units: [{ unitId: 'roll', factor: '50.000000' }],
};

const vat15 = { id: 'vat-15', name: 'VAT 15%', kind: 'standard', rate: '15.00' };

// A goods receipt line that accepted 20 rolls (1,000 m) of lot MD-2610 at ৳350 a metre
function receiptLine(extra: Partial<GoodsReceiptLine> = {}): GoodsReceiptLine {
  return {
    ...item,
    id: 'grl-1',
    unitId: 'roll',
    quantity: '20.0000',
    baseQuantity: '1000.0000',
    batchId: 'batch-1',
    lotNumber: 'MD-2610',
    expiresOn: null,
    manufacturedOn: null,
    serialNumbers: [],
    orderLineId: 'pol-1',
    rejectedQuantity: '0.0000',
    rejectedBaseQuantity: '0.0000',
    rejectionReason: null,
    value: '350000.0000',
    billed: true,
    returnedQuantity: '0.0000',
    ...extra,
  };
}

// The bill line that billed it: 20 rolls at ৳18,000 (৳360 a metre), ৳2,000 off in all, VAT 15%
function billLine(extra: Partial<BillLine> = {}): BillLine {
  return {
    ...item,
    id: 'bl-1',
    productType: 'goods',
    unitId: 'roll',
    quantity: '20.0000',
    baseQuantity: '1000.0000',
    description: '12 oz indigo denim',
    unitPrice: '18000.0000',
    discountType: 'amount',
    discount: '2000.0000',
    taxRate: vat15,
    net: '358000.0000',
    vat: '53700.0000',
    total: '411700.0000',
    receiptLineId: 'grl-1',
    receiptNumber: 'GRN-2026-27-0007',
    orderLineId: 'pol-1',
    orderNumber: 'PO-2026-27-0003',
    accountId: null,
    orderValue: '350000.0000',
    batchId: 'batch-1',
    lotNumber: 'MD-2610',
    expiresOn: null,
    manufacturedOn: null,
    serialNumbers: [],
    debited: '0.0000',
    ...extra,
  };
}

// A posted return line: 2 rolls of a bad shade went back after the bill
function returnLine(extra: Partial<PurchaseReturnLine> = {}): PurchaseReturnLine {
  return {
    ...item,
    id: 'prl-1',
    unitId: 'roll',
    quantity: '2.0000',
    baseQuantity: '100.0000',
    batchId: 'batch-1',
    lotNumber: 'MD-2610',
    expiresOn: null,
    manufacturedOn: null,
    serialNumbers: [],
    receiptLineId: 'grl-1',
    receiptNumber: 'GRN-2026-27-0007',
    billed: true,
    billLineId: 'bl-1',
    billId: 'bill-1',
    billNumber: 'BILL-2026-27-0004',
    debitedQuantity: '0.0000',
    value: '35000.0000',
    ...extra,
  };
}

// A transport charge on the bill: ৳1,000 before VAT
function expense(extra: Partial<BillExpense> = {}): BillExpense {
  return {
    id: 'be-1',
    accountId: 'acc-transport',
    description: 'Truck from Narayanganj',
    amount: '1000.0000',
    taxRate: vat15,
    net: '1000.0000',
    vat: '150.0000',
    total: '1150.0000',
    debited: '0.0000',
    ...extra,
  };
}

describe('the reasons', () => {
  it('reads a reason this app does not know as Other', () => {
    expect(purchaseReturnReasonKey('quality')).toBe('purchaseReturns.reasons.quality');
    expect(purchaseReturnReasonKey('recalled')).toBe('purchaseReturns.reasons.other');
    expect(debitReasonKey('goods_returned')).toBe('debitNotes.reasons.goods_returned');
    expect(debitReasonKey('rebate')).toBe('debitNotes.reasons.other');
  });
});

describe('returnableReceiptLines and receiptLineToReturn', () => {
  it('leaves out what all went back and what is on the form, billed or not', () => {
    const lines = [
      receiptLine({ id: 'a' }),
      receiptLine({ id: 'b', returnedQuantity: '1000.0000' }),
      receiptLine({ id: 'c', billed: false }),
      receiptLine({ id: 'd' }),
    ];
    expect(returnableReceiptLines(lines, new Set(['d'])).map((line) => line.id)).toEqual([
      'a',
      'c',
    ]);
  });

  it('sends the whole line back in its own unit, with no batch', () => {
    expect(receiptLineToReturn(receiptLine({ serialNumbers: ['R-1'] }))).toEqual({
      variantId: 'denim',
      unitId: 'roll',
      quantity: '20',
      // The server takes the receipt line's own (purchase_return_batch_not_allowed otherwise)
      batchId: '',
      serialNumbers: ['R-1'],
      receiptLineId: 'grl-1',
    });
  });

  it('sends what is kept in the base unit once some went back, without guessing serials', () => {
    expect(
      receiptLineToReturn(receiptLine({ returnedQuantity: '120.0000', serialNumbers: ['R-1'] })),
    ).toMatchObject({ unitId: 'm', quantity: '880', serialNumbers: [] });
  });

  it("keeps a line on its own's batch, and drops a receipt line's", () => {
    expect(toPurchaseReturnFormLine(returnLine()).batchId).toBe('');
    expect(
      toPurchaseReturnFormLine(returnLine({ receiptLineId: null, receiptNumber: null })).batchId,
    ).toBe('batch-1');
  });
});

describe('the return lines a debit note can take', () => {
  // Line 2 went back before the bill (the bill billed less); line 3 came from no receipt
  const purchaseReturn = {
    lines: [
      returnLine(),
      returnLine({ id: 'prl-2', billed: false, billLineId: null, billId: null }),
      returnLine({
        id: 'prl-3',
        receiptLineId: null,
        receiptNumber: null,
        billed: false,
        billLineId: null,
        billId: null,
      }),
    ],
  };

  it('has money to take off for a billed line and a line on its own only', () => {
    expect(purchaseReturn.lines.map(leftToDebitOf)).toEqual(['100.0000', '0', '100.0000']);
    expect(leftToDebitOf(returnLine({ debitedQuantity: '40.0000' }))).toBe('60.0000');
  });

  it("lists a bill's lines, or without a bill the lines on their own", () => {
    const ids = (billId: string | null, onForm: string[] = []) =>
      debitableReturnLines(purchaseReturn, billId, new Set(onForm)).map((line) => line.id);
    expect(ids('bill-1')).toEqual(['prl-1']);
    expect(ids(null)).toEqual(['prl-3']);
    expect(ids('bill-1', ['prl-1'])).toEqual([]);
  });

  it('starts with the first bill that has goods to debit, then with no bill', () => {
    expect(debitStartOf(purchaseReturn)).toEqual({ billId: 'bill-1' });
    expect(debitStartOf({ lines: purchaseReturn.lines.slice(1) })).toEqual({ billId: null });
    expect(debitStartOf({ lines: [returnLine({ debitedQuantity: '100.0000' })] })).toBeNull();
  });

  it('debits the goods at the bill price, with their share of an amount discount', () => {
    expect(returnLineToDebit(returnLine(), billLine())).toEqual({
      billLineId: 'bl-1',
      returnLineId: 'prl-1',
      taxRateId: '',
      unitId: 'roll',
      quantity: '2',
      description: '',
      unitPrice: '18000.0000',
      discountType: 'amount',
      // 100 of the line's 1,000 m carry ৳200 of its ৳2,000 off
      discount: '200',
    });
  });

  it('debits what is left in the base unit, at the price of one metre', () => {
    expect(returnLineToDebit(returnLine({ debitedQuantity: '50.0000' }), billLine())).toMatchObject(
      { unitId: 'm', quantity: '50', unitPrice: '360.0000', discount: '100' },
    );
  });

  it('leaves the price and the rate of a line on its own to be typed', () => {
    expect(ownReturnLineToDebit(purchaseReturn.lines[2] ?? returnLine())).toMatchObject({
      billLineId: '',
      returnLineId: 'prl-3',
      taxRateId: '',
      unitPrice: '',
    });
  });
});

describe("a debit note's totals and expenses", () => {
  const rateOf = (id: string) => (id === 'vat-15' ? '15.00' : null);
  const bill = { lines: [billLine()], expenses: [expense()] };

  it("adds lines at their bill line's rate and expenses at theirs", () => {
    const totals = debitFormTotals(
      [returnLineToDebit(returnLine(), billLine())],
      [{ billExpenseId: 'be-1', amount: '500' }],
      bill,
      rateOf,
      false,
    );
    // ৳36,000 less ৳200 = ৳35,800, plus ৳500 of transport; 15% VAT on both
    expect(totals).toMatchObject({ net: '36300.0000', vat: '5445.0000', total: '41745.0000' });
  });

  it('works out a line without a bill at its own rate, and skips one being typed', () => {
    const own = {
      ...ownReturnLineToDebit(returnLine({ receiptLineId: null })),
      unitPrice: '17500',
      taxRateId: 'vat-15',
    };
    const typing = { ...own, unitPrice: '' };
    expect(debitFormTotals([own, typing], [], null, rateOf, false)).toMatchObject({
      net: '35000.0000',
      vat: '5250.0000',
      total: '40250.0000',
    });
  });

  it('takes an expense off whole, or the share of what is left', () => {
    expect(expenseToDebit(expense())).toEqual({ billExpenseId: 'be-1', amount: '1000' });
    // ৳575 of ৳1,150 is left: half of the typed ৳1,000
    expect(expenseToDebit(expense({ debited: '575.0000' })).amount).toBe('500');
    expect(debitLeft(expense({ debited: '575.0000' }))).toBe('575.0000');
    expect(
      debitableExpenses(
        [expense(), expense({ id: 'be-2', debited: '1150.0000' }), expense({ id: 'be-3' })],
        new Set(['be-3']),
      ).map((item) => item.id),
    ).toEqual(['be-1']);
  });
});

describe('supplierRefundSourcesOf', () => {
  function debitNote(extra: Partial<DebitNoteSummary> = {}): DebitNoteSummary {
    return {
      id: 'dn-1',
      number: 'DN-2026-27-0002',
      date: '2026-10-12',
      supplier: { id: 's', code: 'S-00004', name: 'Padma Denim Mills' },
      bill: null,
      branchId: 'b-1',
      reason: 'goods_returned',
      status: 'posted',
      supplierCreditNumber: null,
      supplierCreditDate: null,
      net: '20000.0000',
      vat: '3000.0000',
      total: '23000.0000',
      applied: '0.0000',
      refunded: '3000.0000',
      lineCount: 1,
      postedAt: '2026-10-12T05:00:00.000Z',
      version: 2,
      updatedAt: '2026-10-12T05:00:00.000Z',
      ...extra,
    };
  }
  function payment(extra: Partial<SupplierPaymentSummary> = {}): SupplierPaymentSummary {
    return {
      id: 'sp-1',
      number: 'SP-2026-27-0009',
      date: '2026-10-01',
      supplier: { id: 's', code: 'S-00004', name: 'Padma Denim Mills' },
      amount: '50000.0000',
      applied: '30000.0000',
      refunded: '0.0000',
      method: 'bank_transfer',
      reference: null,
      accountId: 'acc-bank',
      branchId: 'b-2',
      order: null,
      status: 'posted',
      postedAt: '2026-10-01T05:00:00.000Z',
      version: 1,
      updatedAt: '2026-10-01T05:00:00.000Z',
      ...extra,
    };
  }

  it('lists the money left on posted documents, the oldest first', () => {
    const sources = supplierRefundSourcesOf(
      [
        debitNote(),
        debitNote({ id: 'dn-draft', number: null, status: 'draft' }),
        debitNote({ id: 'dn-used', applied: '20000.0000' }),
      ],
      [payment(), payment({ id: 'sp-void', status: 'voided' })],
    );
    expect(sources.map((source) => [source.type, source.id, source.left])).toEqual([
      ['supplier_payment', 'sp-1', '20000.0000'],
      ['debit_note', 'dn-1', '20000.0000'],
    ]);
    expect(sources[0]?.branchId).toBe('b-2');
  });

  it("turns the select's value into the two boxes and back", () => {
    expect(supplierSourceKeyOf({ type: 'debit_note', id: 'dn-1' })).toBe('debit_note:dn-1');
    expect(supplierSourceFields('supplier_payment:sp-1')).toEqual({
      debitNoteId: '',
      paymentId: 'sp-1',
    });
    expect(supplierSourceFields('')).toEqual({ debitNoteId: '', paymentId: '' });
  });
});
