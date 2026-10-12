import type {
  CreditNoteSummary,
  DeliveryLine,
  InvoiceLine,
  ReceiptSummary,
  SalesReturnLine,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  challanLineToReturn,
  creditableReturnLines,
  creditLeft,
  creditReasonKey,
  firstCreditableInvoice,
  returnableLines,
  returnLineToCredit,
  returnReasonKey,
  refundSourcesOf,
  sourceFields,
  sourceKeyOf,
  toReturnFormLine,
} from './returns';

// Napa tablets, sold by the box of 10 strips; the strip is the base unit
const item = {
  variantId: 'napa',
  productId: 'p-napa',
  productCode: 'P-00031',
  productName: 'Napa 500 mg',
  optionValues: [],
  sku: 'P-00031',
  baseUnitId: 'strip',
  tracking: 'batch',
  hasExpiry: true,
  units: [{ unitId: 'box', factor: '10.000000' }],
};

// A challan line that took 3 boxes (30 strips) of batch NP24117
function challanLine(extra: Partial<DeliveryLine> = {}): DeliveryLine {
  return {
    ...item,
    id: 'dl-1',
    unitId: 'box',
    quantity: '3.0000',
    baseQuantity: '30.0000',
    batchId: 'batch-1',
    lotNumber: 'NP24117',
    expiresOn: '2027-01-31',
    manufacturedOn: null,
    serialNumbers: [],
    orderLineId: null,
    value: '270.0000',
    invoiced: true,
    returnedQuantity: '0.0000',
    ...extra,
  };
}

// The invoice line that billed it: 3 boxes at ৳120, ৳30 off in all, no VAT
function invoiceLine(extra: Partial<InvoiceLine> = {}): InvoiceLine {
  return {
    ...item,
    id: 'il-1',
    productType: 'goods',
    unitId: 'box',
    quantity: '3.0000',
    baseQuantity: '30.0000',
    description: 'Napa 500 mg',
    unitPrice: '120.0000',
    discountType: 'amount',
    discount: '30.0000',
    taxRate: { id: 'exempt', name: 'Exempt', kind: 'exempt', rate: '0.00' },
    net: '330.0000',
    vat: '0.0000',
    total: '330.0000',
    deliveryLineId: 'dl-1',
    orderLineId: null,
    deliveryNumber: 'DC-2026-27-0042',
    orderNumber: null,
    batchId: 'batch-1',
    lotNumber: 'NP24117',
    expiresOn: '2027-01-31',
    serialNumbers: [],
    credited: '0.0000',
    ...extra,
  };
}

// A posted return line: 1 box of that challan line came back, billed on INV-0001
function returnLine(extra: Partial<SalesReturnLine> = {}): SalesReturnLine {
  return {
    ...item,
    id: 'rl-1',
    unitId: 'box',
    quantity: '1.0000',
    baseQuantity: '10.0000',
    batchId: 'batch-1',
    lotNumber: 'NP24117',
    expiresOn: '2027-01-31',
    manufacturedOn: null,
    serialNumbers: [],
    deliveryLineId: 'dl-1',
    deliveryNumber: 'DC-2026-27-0042',
    billed: true,
    invoiceLineId: 'il-1',
    invoiceId: 'inv-1',
    invoiceNumber: 'INV-2026-27-0001',
    creditedQuantity: '0.0000',
    value: '90.0000',
    ...extra,
  };
}

describe('the reasons', () => {
  it('reads a reason this app does not know as Other', () => {
    expect(returnReasonKey('expired')).toBe('salesReturns.reasons.expired');
    expect(returnReasonKey('recalled')).toBe('salesReturns.reasons.other');
    expect(creditReasonKey('billing_error')).toBe('creditNotes.reasons.billing_error');
    expect(creditReasonKey('rebate')).toBe('creditNotes.reasons.other');
  });
});

describe('returnableLines and challanLineToReturn', () => {
  it('leaves out what all came back and what is on the form', () => {
    const lines = [
      challanLine({ id: 'all-back', returnedQuantity: '30.0000' }),
      challanLine({ id: 'on-form' }),
      challanLine({ id: 'open' }),
    ];
    expect(returnableLines(lines, new Set(['on-form'])).map((line) => line.id)).toEqual(['open']);
  });

  it('takes the whole line back in its own unit, with no batch', () => {
    expect(challanLineToReturn(challanLine())).toEqual({
      variantId: 'napa',
      unitId: 'box',
      quantity: '3',
      batchId: '',
      serialNumbers: [],
      deliveryLineId: 'dl-1',
    });
  });

  it('takes what is left in the base unit once some came back', () => {
    expect(challanLineToReturn(challanLine({ returnedQuantity: '12.0000' }))).toMatchObject({
      unitId: 'strip',
      quantity: '18',
    });
  });

  it('does not guess which serial numbers are still out', () => {
    const phones = challanLine({
      tracking: 'serial',
      unitId: 'strip',
      quantity: '2.0000',
      baseQuantity: '2.0000',
      serialNumbers: ['IMEI-1', 'IMEI-2'],
    });
    expect(challanLineToReturn(phones).serialNumbers).toEqual(['IMEI-1', 'IMEI-2']);
    expect(challanLineToReturn({ ...phones, returnedQuantity: '1.0000' }).serialNumbers).toEqual(
      [],
    );
  });

  it("sends a saved challan line back without the challan's batch", () => {
    expect(toReturnFormLine(returnLine())).toMatchObject({ batchId: '', deliveryLineId: 'dl-1' });
    expect(
      toReturnFormLine(returnLine({ deliveryLineId: null, deliveryNumber: null })),
    ).toMatchObject({ batchId: 'batch-1', deliveryLineId: '' });
  });
});

describe('the return lines a credit note can take', () => {
  const salesReturn = {
    lines: [
      returnLine({ id: 'credited', creditedQuantity: '10.0000' }),
      returnLine({ id: 'unbilled', invoiceLineId: null, invoiceId: null, billed: false }),
      returnLine({ id: 'other-invoice', invoiceId: 'inv-2', invoiceLineId: 'il-9' }),
      returnLine({ id: 'open' }),
    ],
  };

  it('lists billed lines of this invoice that are not all credited', () => {
    expect(creditableReturnLines(salesReturn, 'inv-1', new Set()).map((line) => line.id)).toEqual([
      'open',
    ]);
    expect(creditableReturnLines(salesReturn, 'inv-1', new Set(['open']))).toEqual([]);
  });

  it('starts with the first invoice that still has goods to credit', () => {
    expect(firstCreditableInvoice(salesReturn)).toBe('inv-2');
    expect(firstCreditableInvoice({ lines: [returnLine({ creditedQuantity: '10.0000' })] })).toBe(
      null,
    );
  });

  it('credits the goods at the invoice price, with their share of an amount discount', () => {
    expect(returnLineToCredit(returnLine(), invoiceLine())).toEqual({
      invoiceLineId: 'il-1',
      returnLineId: 'rl-1',
      unitId: 'box',
      quantity: '1',
      description: '',
      unitPrice: '120.0000',
      discountType: 'amount',
      // 10 of the 30 strips carry a third of the ৳30
      discount: '10',
    });
  });

  it('credits what is left in the base unit, at the price of one strip', () => {
    const line = returnLineToCredit(
      returnLine({ quantity: '2.0000', baseQuantity: '20.0000', creditedQuantity: '5.0000' }),
      invoiceLine(),
    );
    expect(line).toMatchObject({ unitId: 'strip', quantity: '15', unitPrice: '12.0000' });
  });

  it('knows what an invoice line can still give back', () => {
    expect(creditLeft(invoiceLine({ credited: '110.0000' }))).toBe('220.0000');
  });
});

describe('refundSourcesOf', () => {
  const receipt = (extra: Partial<ReceiptSummary>): ReceiptSummary => ({
    id: 'r-1',
    number: 'MR-2026-27-0003',
    date: '2026-09-10',
    customer: { id: 'c-1', code: 'C-00007', name: 'Tamanna Pharmacy' },
    amount: '5000.0000',
    applied: '3000.0000',
    refunded: '500.0000',
    method: 'cash',
    reference: null,
    accountId: 'cash',
    branchId: 'b-1',
    status: 'posted',
    version: 1,
    updatedAt: '2026-09-10T04:00:00.000Z',
    ...extra,
  });
  const creditNote = (extra: Partial<CreditNoteSummary>): CreditNoteSummary => ({
    id: 'cn-1',
    number: 'CN-2026-27-0001',
    date: '2026-09-01',
    customer: { id: 'c-1', code: 'C-00007', name: 'Tamanna Pharmacy' },
    invoice: { id: 'inv-1', number: 'INV-2026-27-0001', date: '2026-08-20' },
    branchId: 'b-2',
    reason: 'goods_returned',
    status: 'posted',
    net: '230.0000',
    vat: '0.0000',
    total: '230.0000',
    applied: '0.0000',
    refunded: '0.0000',
    lineCount: 1,
    postedAt: '2026-09-01T04:00:00.000Z',
    version: 1,
    updatedAt: '2026-09-01T04:00:00.000Z',
    ...extra,
  });

  it('lists the money left on posted documents, the oldest first', () => {
    const sources = refundSourcesOf(
      [
        receipt({}),
        receipt({ id: 'r-void', status: 'voided' }),
        receipt({ id: 'r-used', applied: '4500.0000' }),
      ],
      [creditNote({}), creditNote({ id: 'cn-draft', status: 'draft', number: null })],
    );
    expect(sources.map((source) => [source.type, source.id, source.left])).toEqual([
      ['credit_note', 'cn-1', '230.0000'],
      ['receipt', 'r-1', '1500.0000'],
    ]);
    expect(sources[0]?.branchId).toBe('b-2');
  });

  it("turns the select's value into the two boxes and back", () => {
    expect(sourceKeyOf({ type: 'credit_note', id: 'cn-1' })).toBe('credit_note:cn-1');
    expect(sourceFields('credit_note:cn-1')).toEqual({ receiptId: '', creditNoteId: 'cn-1' });
    expect(sourceFields('receipt:r-1')).toEqual({ receiptId: 'r-1', creditNoteId: '' });
    expect(sourceFields('')).toEqual({ receiptId: '', creditNoteId: '' });
  });
});
