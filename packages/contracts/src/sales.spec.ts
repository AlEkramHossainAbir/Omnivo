import { describe, expect, it } from 'vitest';

import { deliveryInputSchema } from './deliveries.js';
import { contractErrorMap } from './errors.js';
import { quotationInputSchema } from './quotations.js';
import { salesOrderInputSchema } from './sales-orders.js';
import {
  defaultLineDescription,
  documentTotals,
  draftLineAmounts,
  lineAmounts,
  salesLineInputSchema,
} from './sales.js';

const CUSTOMER = '01920000-0000-7000-8000-000000000001';
const WAREHOUSE = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const RATE = '01920000-0000-7000-8000-000000000005';
const ORDER = '01920000-0000-7000-8000-000000000006';
const ORDER_LINE = '01920000-0000-7000-8000-000000000007';

function salesLine(extra: object = {}) {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '3',
    description: '',
    unitPrice: '1200.50',
    discountType: 'percent',
    discount: '',
    taxRateId: RATE,
    ...extra,
  };
}

function deliveryLine(extra: object = {}) {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '2',
    batchId: '',
    serialNumbers: [],
    orderLineId: ORDER_LINE,
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

describe('line amounts', () => {
  it('adds the VAT to a price typed without it', () => {
    // 3 × ৳1,200.50 = ৳3,601.50; 10% off = ৳360.15; VAT 15% of ৳3,241.35 = ৳486.2025 → ৳486.20
    expect(
      lineAmounts(
        {
          quantity: '3',
          unitPrice: '1200.50',
          discountType: 'percent',
          discount: '10',
          rate: '15',
        },
        false,
      ),
    ).toEqual({
      gross: '3601.5000',
      discount: '360.1500',
      net: '3241.3500',
      vat: '486.2000',
      total: '3727.5500',
    });
  });

  it('takes the VAT out of a price that includes it', () => {
    // 2 × ৳115 − ৳30 = ৳200 to pay; it holds 200 × 15 ÷ 115 = ৳26.0869… → ৳26.09 of VAT
    expect(
      lineAmounts(
        { quantity: '2', unitPrice: '115', discountType: 'amount', discount: '30', rate: '15.00' },
        true,
      ),
    ).toEqual({
      gross: '230.0000',
      discount: '30.0000',
      net: '173.9100',
      vat: '26.0900',
      total: '200.0000',
    });
  });

  it('charges nothing on an exempt line, with or without VAT in the price', () => {
    const line = {
      quantity: '10',
      unitPrice: '0.8512',
      discountType: 'amount',
      discount: '0',
      rate: '0.00',
    } as const;
    // 10 strips at ৳0.8512 = ৳8.512 → ৳8.51: the line is kept to the paisa
    expect(lineAmounts(line, false)).toMatchObject({
      net: '8.5100',
      vat: '0.0000',
      total: '8.5100',
    });
    expect(lineAmounts(line, true)).toMatchObject({
      net: '8.5100',
      vat: '0.0000',
      total: '8.5100',
    });
  });

  it('totals a document from its rounded lines', () => {
    const lines = [
      lineAmounts(
        { quantity: '1', unitPrice: '0.10', discountType: 'percent', discount: '0', rate: '15' },
        false,
      ),
      lineAmounts(
        { quantity: '1', unitPrice: '0.10', discountType: 'percent', discount: '0', rate: '15' },
        false,
      ),
    ];
    // Each line's VAT is ৳0.015 → ৳0.02, so the document's is ৳0.04 (not 15% of ৳0.20 = ৳0.03):
    // the total is what the printed lines add up to
    expect(documentTotals(lines)).toEqual({
      discount: '0.0000',
      net: '0.2000',
      vat: '0.0400',
      total: '0.2400',
    });
  });

  it('waits for complete boxes while a line is typed', () => {
    const typed = {
      quantity: '1.',
      unitPrice: '100',
      discountType: 'percent',
      discount: '',
    } as const;
    expect(draftLineAmounts(typed, '15', false)).toBeNull();
    expect(draftLineAmounts({ ...typed, quantity: '1' }, null, false)).toBeNull();
    expect(draftLineAmounts({ ...typed, quantity: '1', unitPrice: '' }, '15', false)).toBeNull();
    expect(draftLineAmounts({ ...typed, quantity: ' 1 ' }, '15', false)).toMatchObject({
      vat: '15.0000',
      total: '115.0000',
    });
  });
});

describe('sales line input', () => {
  it('names a line by its product, and its variant’s options', () => {
    expect(defaultLineDescription({ productName: 'Napa 500 mg', optionValues: [] })).toBe(
      'Napa 500 mg',
    );
    expect(defaultLineDescription({ productName: 'Polo shirt', optionValues: ['M', 'Navy'] })).toBe(
      'Polo shirt — M, Navy',
    );
  });

  it('turns empty boxes into "no description" and "no discount"', () => {
    const parsed = salesLineInputSchema.parse(salesLine());
    expect(parsed).toMatchObject({ description: null, discount: '0' });
  });

  it('needs a price, and takes ৳0 for a free sample', () => {
    const empty = salesLineInputSchema.safeParse(salesLine({ unitPrice: ' ' }), {
      error: contractErrorMap,
    });
    expect(errorsOf(empty)).toEqual({ unitPrice: 'sales_price_required' });
    expect(salesLineInputSchema.safeParse(salesLine({ unitPrice: '0' })).success).toBe(true);
  });

  it('never takes more off than the line', () => {
    const percent = salesLineInputSchema.safeParse(salesLine({ discount: '100.01' }), {
      error: contractErrorMap,
    });
    expect(errorsOf(percent)).toEqual({ discount: 'sales_discount_too_large' });
    // 3 × ৳1,200.50 = ৳3,601.50: all of it is fine, a paisa more is not
    expect(
      salesLineInputSchema.safeParse(salesLine({ discountType: 'amount', discount: '3601.50' }))
        .success,
    ).toBe(true);
    const amount = salesLineInputSchema.safeParse(
      salesLine({ discountType: 'amount', discount: '3601.51' }),
      { error: contractErrorMap },
    );
    expect(errorsOf(amount)).toEqual({ discount: 'sales_discount_too_large' });
  });

  it('keeps a discount to the paisa', () => {
    const result = salesLineInputSchema.safeParse(salesLine({ discount: '2.555' }), {
      error: contractErrorMap,
    });
    expect(errorsOf(result)).toEqual({ discount: 'money_format' });
  });
});

describe('sales documents', () => {
  it('ends a quotation on or after its date', () => {
    const quotation = {
      customerId: CUSTOMER,
      date: '2026-10-07',
      validUntil: '2026-10-06',
      note: '',
      lines: [salesLine()],
    };
    const result = quotationInputSchema.safeParse(quotation, { error: contractErrorMap });
    expect(errorsOf(result)).toEqual({ validUntil: 'quotation_valid_until' });
    expect(quotationInputSchema.parse({ ...quotation, validUntil: '' }).validUntil).toBeNull();
  });

  it('needs a customer, a line, and a delivery date after the order', () => {
    const order = {
      customerId: '',
      date: '2026-10-07',
      customerReference: 'PO-H&M-55120',
      deliveryDate: '2026-10-01',
      warehouseId: WAREHOUSE,
      shippingAddressId: '',
      note: '',
      lines: [],
      confirm: false,
    };
    // Every mistake at once, so the form marks them all on the first save
    const result = salesOrderInputSchema.safeParse(order, { error: contractErrorMap });
    expect(errorsOf(result)).toEqual({
      customerId: 'sales_customer_required',
      deliveryDate: 'order_delivery_date',
      lines: 'sales_lines_required',
    });
    const parsed = salesOrderInputSchema.parse({
      ...order,
      customerId: CUSTOMER,
      deliveryDate: '',
      lines: [salesLine()],
    });
    // A form that starts from nothing does not send the quotation
    expect(parsed).toMatchObject({
      quotationId: null,
      shippingAddressId: null,
      deliveryDate: null,
    });
  });

  it('delivers order lines from an order, and only from an order', () => {
    const delivery = {
      customerId: CUSTOMER,
      orderId: ORDER,
      date: '2026-10-07',
      warehouseId: WAREHOUSE,
      shippingAddressId: '',
      vehicle: 'Dhaka Metro-Ta 11-2233',
      note: '',
      lines: [deliveryLine(), deliveryLine({ orderLineId: '' })],
      post: true,
    };
    const fromOrder = deliveryInputSchema.safeParse(delivery, { error: contractErrorMap });
    expect(errorsOf(fromOrder)).toEqual({ 'lines.1.orderLineId': 'delivery_order_line_required' });
    const withoutOrder = deliveryInputSchema.safeParse(
      { ...delivery, orderId: '' },
      { error: contractErrorMap },
    );
    expect(errorsOf(withoutOrder)).toEqual({
      'lines.0.orderLineId': 'delivery_order_line_invalid',
    });
    // One order line over two batches
    expect(
      deliveryInputSchema.safeParse({ ...delivery, lines: [deliveryLine(), deliveryLine()] })
        .success,
    ).toBe(true);
  });
});
