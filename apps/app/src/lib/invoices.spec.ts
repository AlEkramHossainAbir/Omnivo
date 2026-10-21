import type {
  DeliveryLine,
  Invoice,
  InvoiceLine,
  InvoiceSummary,
  ReceiptAllocation,
  SalesOrderLine,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  allocationRows,
  appliedOf,
  challanLinesLeft,
  billedQuantityOf,
  challanLineToInvoice,
  chargesLeft,
  daysLate,
  type LineOrigin,
  orderPricing,
  savedInvoiceLines,
  suggestAllocations,
} from './invoices';

const item = {
  variantId: 'juice',
  productId: 'p-juice',
  productCode: 'P-00012',
  productName: 'Mango juice 250 ml',
  optionValues: [],
  sku: 'P-00012',
  baseUnitId: 'pcs',
  tracking: 'none',
  hasExpiry: false,
  units: [{ unitId: 'case', factor: '24.000000' }],
};

// The order line of lib/sales.spec.ts: 2 cases of 24 at ৳504 a case, 10% off
function orderLine(extra: Partial<SalesOrderLine> = {}): SalesOrderLine {
  return {
    ...item,
    id: 'line-juice',
    productType: 'goods',
    unitId: 'case',
    quantity: '2.0000',
    baseQuantity: '48.0000',
    description: 'Mango juice 250 ml',
    unitPrice: '504.0000',
    discountType: 'percent',
    discount: '10.0000',
    taxRate: { id: 'vat15', name: 'VAT 15%', kind: 'standard', rate: '15.00' },
    net: '907.2000',
    vat: '136.0800',
    total: '1043.2800',
    deliveredQuantity: '48.0000',
    invoicedQuantity: '0.0000',
    ...extra,
  };
}

// A challan line that took 12 pieces of that order line
function challanLine(extra: Partial<DeliveryLine> = {}): DeliveryLine {
  return {
    ...item,
    id: 'dl-1',
    unitId: 'pcs',
    quantity: '12.0000',
    baseQuantity: '12.0000',
    batchId: null,
    lotNumber: null,
    expiresOn: null,
    manufacturedOn: null,
    serialNumbers: [],
    orderLineId: 'line-juice',
    value: null,
    invoiced: false,
    returnedQuantity: '0.0000',
    ...extra,
  };
}

describe('challanLineToInvoice', () => {
  it('bills the challan line whole, at the order price moved to the challan unit', () => {
    expect(challanLineToInvoice(challanLine(), orderLine(), undefined)).toEqual({
      variantId: 'juice',
      unitId: 'pcs',
      quantity: '12',
      deliveryLineId: 'dl-1',
      orderLineId: '',
      batchId: '',
      serialNumbers: [],
      // The order's text is the product's name: an empty box, like a saved line
      description: '',
      // ৳504 a case of 24 is ৳21 a piece
      unitPrice: '21.0000',
      discountType: 'percent',
      discount: '10',
      taxRateId: 'vat15',
    });
  });

  it('gives an amount discount the share of the order this line carries', () => {
    // ৳100 off 48 pieces; 12 of them went on this challan
    const line = challanLineToInvoice(
      challanLine(),
      orderLine({ discountType: 'amount', discount: '100.0000' }),
      undefined,
    );
    expect(line.discountType).toBe('amount');
    expect(line.discount).toBe('25');
  });

  it('takes the looked-up price when no order is behind the challan', () => {
    const line = challanLineToInvoice(challanLine({ orderLineId: null }), undefined, {
      variantId: 'juice',
      unitId: 'pcs',
      price: '22.5000',
      source: 'price_list',
      taxRateId: 'vat15',
    });
    expect(line).toMatchObject({ unitPrice: '22.5000', taxRateId: 'vat15', discount: '' });
  });

  // Step 15d: 2 cases left, 6 pieces came back before the invoice
  it('bills what is left in the base unit when something came back first', () => {
    const line = challanLineToInvoice(
      challanLine({
        unitId: 'case',
        quantity: '2.0000',
        baseQuantity: '48.0000',
        returnedQuantity: '6.0000',
      }),
      orderLine({ discountType: 'amount', discount: '96.0000' }),
      undefined,
    );
    expect(line).toMatchObject({
      unitId: 'pcs',
      quantity: '42',
      // ৳504 a case is ৳21 a piece, and the 42 pieces carry 42/48 of the ৳96 off
      unitPrice: '21.0000',
      discount: '84',
    });
  });

  // 2 cases left, one whole case came back: the rest is still a whole number of cases
  it("keeps the challan's unit when what is left is a whole number of it", () => {
    const line = challanLineToInvoice(
      challanLine({
        unitId: 'case',
        quantity: '2.0000',
        baseQuantity: '48.0000',
        returnedQuantity: '24.0000',
      }),
      orderLine({ discountType: 'amount', discount: '96.0000' }),
      undefined,
    );
    // The order's own price, not one moved to pieces and rounded
    expect(line).toMatchObject({
      unitId: 'case',
      quantity: '1',
      unitPrice: '504.0000',
      discount: '48',
    });
  });
});

describe('billedQuantityOf', () => {
  const gross = {
    unitId: 'gross',
    baseUnitId: 'pcs',
    units: [{ unitId: 'gross', factor: '144.000000' }],
    quantity: '600.0000',
    baseQuantity: '86400.0000',
  };

  it('bills the line as it left when nothing came back', () => {
    expect(billedQuantityOf({ ...gross, returnedQuantity: '0.0000' }, '86400.0000')).toEqual({
      unitId: 'gross',
      quantity: '600',
    });
  });

  // ৳62 a gross is ৳0.4306 a piece: 500 gross billed as 72,000 pcs would come to ৳3.20 more
  it('keeps the unit for a whole number of it, and moves to the base unit only when it must', () => {
    expect(billedQuantityOf({ ...gross, returnedQuantity: '14400.0000' }, '72000.0000')).toEqual({
      unitId: 'gross',
      quantity: '500',
    });
    expect(billedQuantityOf({ ...gross, returnedQuantity: '100.0000' }, '86300.0000')).toEqual({
      unitId: 'pcs',
      quantity: '86300',
    });
  });
});

describe('challanLinesLeft', () => {
  it('leaves out billed lines, lines on the form and lines that all came back', () => {
    const lines = [
      challanLine({ id: 'billed', invoiced: true }),
      challanLine({ id: 'on-form' }),
      challanLine({ id: 'all-back', returnedQuantity: '12.0000' }),
      challanLine({ id: 'some-back', returnedQuantity: '5.0000' }),
      challanLine({ id: 'open' }),
    ];
    expect(challanLinesLeft(lines, new Set(['on-form'])).map((line) => line.id)).toEqual([
      'some-back',
      'open',
    ]);
  });
});

describe('chargesLeft', () => {
  it('keeps the service lines not billed yet and not on the form', () => {
    const lines = [
      orderLine(),
      orderLine({ id: 'delivery', productType: 'service' }),
      orderLine({ id: 'billed', productType: 'service', invoicedQuantity: '1.0000' }),
      orderLine({ id: 'on-form', productType: 'service' }),
    ];
    expect(chargesLeft(lines, new Set(['on-form'])).map((line) => line.id)).toEqual(['delivery']);
  });
});

describe('orderPricing', () => {
  const origins = new Map<string, LineOrigin>([
    [
      'dl-1',
      { deliveryNumber: 'DC-1', orderNumber: null, pricesIncludeVat: null, returnedQuantity: '0' },
    ],
    [
      'dl-2',
      {
        deliveryNumber: 'DC-2',
        orderNumber: 'SO-1',
        pricesIncludeVat: true,
        returnedQuantity: '0',
      },
    ],
  ]);

  it('follows the first line an order prices', () => {
    expect(
      orderPricing(
        [{ deliveryLineId: '' }, { deliveryLineId: 'dl-1' }, { deliveryLineId: 'dl-2' }],
        origins,
      ),
    ).toBe(true);
  });

  it('is null when no order is behind any line', () => {
    expect(orderPricing([{ deliveryLineId: 'dl-1' }, { deliveryLineId: null }], origins)).toBe(
      null,
    );
  });
});

describe('savedInvoiceLines', () => {
  it('sends a challan line back without its order line and its batch', () => {
    const line: InvoiceLine = {
      ...orderLine(),
      id: 'il-1',
      deliveryLineId: 'dl-1',
      orderLineId: 'line-juice',
      deliveryNumber: 'DC-2026-27-0042',
      orderNumber: 'SO-2026-27-0007',
      batchId: 'batch-1',
      lotNumber: 'MJ2409',
      expiresOn: '2027-03-01',
      serialNumbers: [],
      credited: '0.0000',
    };
    const invoice = {
      customer: { id: 'c-1', code: 'C-00001', name: 'Rahman Traders' },
      pricesIncludeVat: false,
      lines: [line],
    } satisfies Pick<Invoice, 'customer' | 'pricesIncludeVat' | 'lines'>;
    const saved = savedInvoiceLines(invoice);
    expect(saved.values[0]).toMatchObject({
      deliveryLineId: 'dl-1',
      orderLineId: '',
      batchId: '',
      serialNumbers: [],
    });
    expect(saved.origins.get('dl-1')).toEqual({
      deliveryNumber: 'DC-2026-27-0042',
      orderNumber: 'SO-2026-27-0007',
      pricesIncludeVat: false,
      returnedQuantity: '0',
    });
  });
});

function invoice(
  id: string,
  dueDate: string,
  total: string,
  amountPaid: string,
  amountCredited = '0.0000',
): InvoiceSummary {
  return {
    id,
    number: `INV-${id}`,
    date: '2026-09-01',
    dueDate,
    customer: { id: 'c-1', code: 'C-00001', name: 'Rahman Traders' },
    customerReference: null,
    branchId: 'b-1',
    status: 'posted',
    net: total,
    vat: '0.0000',
    total,
    amountPaid,
    amountCredited,
    creditNoteTotal: amountCredited,
    lineCount: 1,
    postedAt: '2026-09-01T04:00:00.000Z',
    version: 1,
    updatedAt: '2026-09-01T04:00:00.000Z',
  };
}

describe('allocationRows and suggestAllocations', () => {
  const open = [
    invoice('2', '2026-10-15', '800.0000', '0.0000'),
    invoice('1', '2026-10-01', '1000.0000', '200.0000'),
  ];

  it('lists the oldest due date first, with what each still owes', () => {
    expect(allocationRows(open, []).map((row) => [row.number, row.due])).toEqual([
      ['INV-1', '800.0000'],
      ['INV-2', '800.0000'],
    ]);
  });

  // Step 15d: a credit note took ৳150 off INV-3, so ৳150 less is due
  it('leaves out what credit notes took off', () => {
    const credited = invoice('3', '2026-10-20', '500.0000', '100.0000', '150.0000');
    expect(allocationRows([credited], [])[0]?.due).toBe('250.0000');
  });

  it("counts this receipt's own amount back in, and keeps an invoice it paid in full", () => {
    const mine: ReceiptAllocation[] = [
      {
        invoiceId: '1',
        invoiceNumber: 'INV-1',
        invoiceDate: '2026-09-01',
        dueDate: '2026-10-01',
        invoiceTotal: '1000.0000',
        amount: '200.0000',
      },
      {
        invoiceId: '0',
        invoiceNumber: 'INV-0',
        invoiceDate: '2026-08-01',
        dueDate: '2026-09-01',
        invoiceTotal: '300.0000',
        amount: '300.0000',
      },
    ];
    expect(allocationRows(open, mine).map((row) => [row.number, row.due])).toEqual([
      ['INV-0', '300.0000'],
      ['INV-1', '1000.0000'],
      ['INV-2', '800.0000'],
    ]);
  });

  it('pays the oldest first until the money runs out', () => {
    const rows = allocationRows(open, []);
    expect(suggestAllocations('1000', rows)).toEqual([
      { id: '1', amount: '800' },
      { id: '2', amount: '200' },
    ]);
    // More than is owed: every invoice in full, the rest stays as an advance
    expect(suggestAllocations('5000', rows)).toEqual([
      { id: '1', amount: '800' },
      { id: '2', amount: '800' },
    ]);
    expect(suggestAllocations('12.', rows)).toEqual([]);
  });

  it('adds up only the boxes that hold an amount', () => {
    expect(appliedOf([{ amount: '800' }, { amount: '1.' }, { amount: '' }])).toBe('800.0000');
  });
});

describe('daysLate', () => {
  it('counts the days after the due date, and none on it', () => {
    expect(daysLate('2026-10-01', '2026-10-08')).toBe(7);
    expect(daysLate('2026-10-08', '2026-10-08')).toBe(0);
    expect(daysLate('2026-10-20', '2026-10-08')).toBe(0);
  });
});
