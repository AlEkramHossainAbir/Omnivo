import type {
  Account,
  BillSummary,
  GoodsReceiptLine,
  PaymentAllocation,
  PurchaseOrderLine,
  StockAccounts,
} from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import {
  billAllocationRows,
  billFormTotals,
  billOrderPricing,
  costAccounts,
  formPriceDifference,
  ownBillLine,
  receiptLinesLeft,
  receiptLineToBill,
  receiptOrderValue,
  servicesLeft,
} from './bills';

// An order line of 40 bags of 30s yarn (a bag is 50 kg) at ৳7,800 a bag, ৳2,000 off the line:
// ৳3,10,000 before VAT
function orderLine(extra: Partial<PurchaseOrderLine> = {}): PurchaseOrderLine {
  return {
    id: 'order-line-1',
    variantId: 'yarn',
    productId: 'p-yarn',
    productCode: 'P-00007',
    productName: '30s combed cotton yarn',
    optionValues: [],
    sku: 'P-00007',
    baseUnitId: 'kg',
    productType: 'goods',
    tracking: 'batch',
    hasExpiry: false,
    units: [{ unitId: 'bag', factor: '50.000000' }],
    unitId: 'bag',
    quantity: '40.0000',
    baseQuantity: '2000.0000',
    description: '30s combed cotton yarn',
    unitPrice: '7800.0000',
    discountType: 'amount',
    discount: '2000.0000',
    taxRate: { id: 'vat-15', name: 'VAT 15%', kind: 'standard', rate: '15.00' },
    net: '310000.0000',
    vat: '46500.0000',
    total: '356500.0000',
    requisitionLine: null,
    receivedQuantity: '800.0000',
    rejectedQuantity: '0.0000',
    billedQuantity: '0.0000',
    ...extra,
  };
}

// A goods receipt line that accepted 800 kg of it
function receiptLine(extra: Partial<GoodsReceiptLine> = {}): GoodsReceiptLine {
  return {
    id: 'receipt-line-1',
    variantId: 'yarn',
    productId: 'p-yarn',
    productCode: 'P-00007',
    productName: '30s combed cotton yarn',
    optionValues: [],
    sku: 'P-00007',
    baseUnitId: 'kg',
    tracking: 'batch',
    hasExpiry: false,
    units: [{ unitId: 'bag', factor: '50.000000' }],
    unitId: 'kg',
    quantity: '800.0000',
    baseQuantity: '800.0000',
    batchId: 'batch-1',
    lotNumber: 'MSM-2611',
    expiresOn: null,
    manufacturedOn: null,
    serialNumbers: [],
    orderLineId: 'order-line-1',
    rejectedQuantity: '0.0000',
    rejectedBaseQuantity: '0.0000',
    rejectionReason: null,
    value: '124000.0000',
    billed: false,
    returnedQuantity: '0.0000',
    ...extra,
  };
}

const rateOf = (id: string) => (id === 'vat-15' ? '15.00' : id === 'vat-0' ? '0.00' : null);

describe('a goods receipt line on a bill', () => {
  it("starts at the order's price, moved to the receipt line's unit", () => {
    const line = receiptLineToBill(receiptLine(), orderLine());
    expect(line).toMatchObject({
      variantId: 'yarn',
      unitId: 'kg',
      quantity: '800',
      receiptLineId: 'receipt-line-1',
      // The API reads the order line from the receipt line; both on one line is bill_line_source
      orderLineId: '',
      // ৳7,800 a bag of 50 kg is ৳156 a kg
      unitPrice: '156.0000',
      discountType: 'amount',
      // The share of the order's ৳2,000 off that 800 of its 2,000 kg carry
      discount: '800',
      taxRateId: 'vat-15',
      // The product's own name stays an empty box, so a renamed product is followed
      description: '',
    });
  });

  it('keeps a percent discount as it is, and leaves the price empty without an order line', () => {
    const percent = orderLine({ discountType: 'percent', discount: '5.0000' });
    expect(receiptLineToBill(receiptLine(), percent).discount).toBe('5');
    expect(receiptLineToBill(receiptLine(), undefined)).toMatchObject({
      unitPrice: '',
      taxRateId: '',
    });
  });

  it('knows what the goods receipt booked, and finds no difference at the same price', () => {
    expect(receiptOrderValue(receiptLine(), orderLine())).toBe('124000.0000');
    const line = receiptLineToBill(receiptLine(), orderLine());
    const origins = new Map([
      [
        'receipt-line-1',
        {
          receiptNumber: 'GRN-2026-27-0007',
          orderNumber: 'PO-2026-27-0003',
          pricesIncludeVat: false,
          orderValue: '124000.0000',
          returnedQuantity: '0',
        },
      ],
    ]);
    expect(formPriceDifference([line], origins, rateOf, false)).toBe('0.0000');
    // The mill billed ৳157 a kg: ৳800 over the order (800 kg × ৳1)
    expect(formPriceDifference([{ ...line, unitPrice: '157' }], origins, rateOf, false)).toBe(
      '800.0000',
    );
  });

  it('leaves out what is billed, what accepted nothing, and what the form holds', () => {
    const lines = [
      receiptLine({ id: 'a' }),
      receiptLine({ id: 'b', billed: true }),
      // Everything turned back at the gate: nothing to bill (decision 43)
      receiptLine({ id: 'c', quantity: '0.0000', baseQuantity: '0.0000' }),
      receiptLine({ id: 'd' }),
      // Step 17d: everything went back on a purchase return before a bill came
      receiptLine({ id: 'e', returnedQuantity: '800.0000' }),
    ];
    expect(receiptLinesLeft(lines, new Set(['d'])).map((line) => line.id)).toEqual(['a']);
  });

  it('bills what is left after a return, at its share of the order', () => {
    // 16 bags came in; 3 bags (150 kg) of a bad shade went back before the bill: 13 bags are
    // left, still a whole number of bags
    const partly = receiptLine({
      unitId: 'bag',
      quantity: '16.0000',
      returnedQuantity: '150.0000',
    });
    expect(receiptLineToBill(partly, orderLine())).toMatchObject({
      unitId: 'bag',
      quantity: '13',
      unitPrice: '7800.0000',
      // 650 of the order's 2,000 kg carry ৳650 of its ৳2,000 off
      discount: '650',
    });
    // The receipt booked ৳1,24,000; the return took 150 of 800 kg of it (৳23,250) off
    expect(receiptOrderValue(partly, orderLine())).toBe('100750.0000');
    // 140 kg went back: 660 kg is 13.2 bags, so the line bills kilograms
    expect(
      receiptLineToBill(
        receiptLine({ unitId: 'bag', quantity: '16.0000', returnedQuantity: '140.0000' }),
        orderLine(),
      ),
    ).toMatchObject({ unitId: 'kg', quantity: '660', unitPrice: '156.0000' });
    // Nothing went back: the receipt's own unit, as before
    expect(
      receiptLineToBill(receiptLine({ unitId: 'bag', quantity: '16.0000' }), orderLine()),
    ).toMatchObject({ unitId: 'bag', quantity: '16', unitPrice: '7800.0000' });
  });
});

describe("an order's services on a bill", () => {
  it('offers only the services no posted bill bills, and not what the form holds', () => {
    const lines = [
      orderLine({ id: 'goods' }),
      orderLine({ id: 'dyeing', productType: 'service' }),
      orderLine({ id: 'transport', productType: 'service', billedQuantity: '1.0000' }),
      orderLine({ id: 'washing', productType: 'service' }),
    ];
    expect(servicesLeft(lines, new Set(['washing'])).map((line) => line.id)).toEqual(['dyeing']);
  });
});

describe("the bill's prices and totals", () => {
  it("takes the orders' way of writing prices from the first line that has one", () => {
    const origins = new Map([
      [
        'r1',
        {
          receiptNumber: 'GRN-1',
          orderNumber: 'PO-1',
          pricesIncludeVat: true,
          orderValue: null,
          returnedQuantity: '0',
        },
      ],
    ]);
    const own = ownBillLine({
      variantId: 'v',
      unitId: 'u',
      quantity: '1',
      description: '',
      unitPrice: '10',
      discountType: 'percent',
      discount: '',
      taxRateId: 'vat-15',
    });
    expect(billOrderPricing([own], origins)).toBeNull();
    expect(billOrderPricing([own, { ...own, receiptLineId: 'r1' }], origins)).toBe(true);
  });

  it('adds the expenses to the item lines, each rounded like a line', () => {
    const line = receiptLineToBill(receiptLine(), orderLine());
    const totals = billFormTotals(
      [line],
      [
        // Electricity for September: ৳12,345.67 before VAT, 15% is ৳1,851.85
        { amount: '12345.67', taxRateId: 'vat-15' },
        // One being typed counts as nothing
        { amount: '12.', taxRateId: 'vat-15' },
      ],
      rateOf,
      false,
    );
    expect(totals).toEqual({
      discount: '800.0000',
      net: '136345.6700',
      vat: '20451.8500',
      total: '156797.5200',
    });
  });
});

describe('the accounts a service or an expense may post to', () => {
  function account(id: string, extra: Partial<Account> = {}): Account {
    return {
      id,
      parentId: null,
      code: id,
      name: id,
      type: 'expense',
      isGroup: false,
      purpose: null,
      holdsMoney: false,
      description: null,
      archivedAt: null,
      version: 1,
      updatedAt: '2026-10-19T00:00:00.000Z',
      ...extra,
    };
  }
  const stock: StockAccounts = { ...emptyStock(), in_transit: '1160', received_not_billed: '2150' };

  it("leaves out what the system posts to by itself, the API's own rule (decision 40)", () => {
    const accounts = [
      account('5170'),
      account('1510', { type: 'asset' }),
      account('5000', { isGroup: true }),
      account('5900', { archivedAt: '2026-09-01T00:00:00.000Z' }),
      account('5100', { purpose: 'cost_of_goods_sold' }),
      account('1110', { type: 'asset', holdsMoney: true }),
      account('1160', { type: 'asset' }),
      account('2150', { type: 'liability' }),
      account('4100', { type: 'income' }),
    ];
    expect(costAccounts(accounts, stock, []).map((each) => each.id)).toEqual(['1510', '5170']);
    // A draft's own account stays, so its select does not move to another one
    expect(costAccounts(accounts, stock, ['5900']).map((each) => each.id)).toEqual([
      '1510',
      '5170',
      '5900',
    ]);
  });
});

function emptyStock(): StockAccounts {
  return {
    in_transit: null,
    found: null,
    damaged: null,
    expired: null,
    lost: null,
    sample: null,
    internal_use: null,
    correction: null,
    transfer_shortage: null,
    revaluation: null,
    received_not_billed: null,
  };
}

describe("a payment's bills", () => {
  function bill(id: string, dueDate: string, total: string, amountPaid: string): BillSummary {
    return {
      id,
      number: `BILL-${id}`,
      date: '2026-09-01',
      dueDate,
      supplier: { id: 's', code: 'S-00001', name: 'Meghna Spinning Mills' },
      supplierBillNumber: `MSM/${id}`,
      mushakNumber: null,
      mushakDate: null,
      branchId: 'b',
      status: 'posted',
      net: total,
      vat: '0.0000',
      total,
      amountPaid,
      amountDebited: '0.0000',
      debitNoteTotal: '0.0000',
      lineCount: 1,
      postedAt: '2026-09-01T00:00:00.000Z',
      version: 1,
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
  }
  const open = [
    bill('2', '2026-10-20', '800.0000', '0.0000'),
    bill('1', '2026-10-01', '1000.0000', '200.0000'),
  ];
  // The payment names bill 1 (৳200) and bill 0, which is paid in full
  const mine: PaymentAllocation[] = [
    {
      billId: '1',
      billNumber: 'BILL-1',
      supplierBillNumber: 'MSM/1',
      billDate: '2026-09-01',
      dueDate: '2026-10-01',
      billTotal: '1000.0000',
      amount: '200.0000',
    },
    {
      billId: '0',
      billNumber: 'BILL-0',
      supplierBillNumber: 'MSM/0',
      billDate: '2026-08-01',
      dueDate: '2026-09-01',
      billTotal: '300.0000',
      amount: '300.0000',
    },
  ];

  it("counts a posted payment's own amounts back in, oldest due first", () => {
    expect(
      billAllocationRows(open, mine, true).map((row) => [row.number, row.detail, row.due]),
    ).toEqual([
      ['BILL-0', 'MSM/0', '300.0000'],
      ['BILL-1', 'MSM/1', '1000.0000'],
      ['BILL-2', 'MSM/2', '800.0000'],
    ]);
  });

  it("does not count a draft's plan: it holds nothing (decision 23)", () => {
    expect(billAllocationRows(open, mine, false).map((row) => [row.number, row.due])).toEqual([
      ['BILL-0', '0.0000'],
      ['BILL-1', '800.0000'],
      ['BILL-2', '800.0000'],
    ]);
  });
});
