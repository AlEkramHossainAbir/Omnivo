import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  dueDateOf,
  invoiceInputSchema,
  isOverdue,
  paymentStatusOf,
  postInvoiceInputSchema,
} from './invoices.js';

const CUSTOMER = '01920000-0000-7000-8000-000000000001';
const BRANCH = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const RATE = '01920000-0000-7000-8000-000000000005';
const DELIVERY_LINE = '01920000-0000-7000-8000-000000000006';
const ORDER_LINE = '01920000-0000-7000-8000-000000000007';
const BATCH = '01920000-0000-7000-8000-000000000008';
const SERVICE_LINE = '01920000-0000-7000-8000-000000000009';

function invoiceLine(extra: object = {}) {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '2',
    description: '',
    unitPrice: '504',
    discountType: 'percent',
    discount: '',
    taxRateId: RATE,
    deliveryLineId: '',
    orderLineId: '',
    batchId: '',
    serialNumbers: [],
    ...extra,
  };
}

function invoice(extra: object = {}) {
  return {
    customerId: CUSTOMER,
    date: '2026-10-08',
    dueDate: '',
    customerReference: '',
    branchId: BRANCH,
    warehouseId: '',
    note: '',
    lines: [invoiceLine({ deliveryLineId: DELIVERY_LINE })],
    post: false,
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

describe('payment status', () => {
  it('reads unpaid, partly paid and paid from the total and what was paid', () => {
    expect(paymentStatusOf({ total: '1150.0000', amountPaid: '0.0000' })).toBe('unpaid');
    expect(paymentStatusOf({ total: '1150.0000', amountPaid: '1000.0000' })).toBe('partly_paid');
    expect(paymentStatusOf({ total: '1150.0000', amountPaid: '1150.0000' })).toBe('paid');
    // A free sample owes nothing
    expect(paymentStatusOf({ total: '0.0000', amountPaid: '0.0000' })).toBe('paid');
  });

  it('is overdue only after the due date, while money is still owed', () => {
    const posted = {
      status: 'posted',
      dueDate: '2026-10-08',
      total: '1150.0000',
      amountPaid: '0.0000',
    };
    expect(isOverdue(posted, '2026-10-08')).toBe(false);
    expect(isOverdue(posted, '2026-10-09')).toBe(true);
    expect(isOverdue({ ...posted, amountPaid: '1150.0000' }, '2026-10-09')).toBe(false);
    // A draft asks for nothing yet
    expect(isOverdue({ ...posted, status: 'draft' }, '2026-10-09')).toBe(false);
  });

  it('starts the due date at the date plus the payment terms', () => {
    expect(dueDateOf('2026-10-08', 30)).toBe('2026-11-07');
    expect(dueDateOf('2026-10-08', 0)).toBe('2026-10-08');
    expect(dueDateOf('2027-06-15', 30)).toBe('2027-07-15');
  });
});

describe('invoice input', () => {
  it('reads empty boxes as "not chosen", and never overrides the credit limit unasked', () => {
    const parsed = invoiceInputSchema.parse(invoice());
    expect(parsed).toMatchObject({
      dueDate: null,
      customerReference: null,
      warehouseId: null,
      overrideCreditLimit: false,
    });
    expect(parsed.lines[0]).toMatchObject({ orderLineId: null, batchId: null });
    expect(postInvoiceInputSchema.parse({ version: 3 }).overrideCreditLimit).toBe(false);
  });

  it('marks every mistake at once', () => {
    const result = invoiceInputSchema.safeParse(
      invoice({
        customerId: '',
        branchId: '',
        dueDate: '2026-10-01',
        lines: [
          // One line cannot bill a challan line and an order line
          invoiceLine({ deliveryLineId: DELIVERY_LINE, orderLineId: ORDER_LINE }),
          // A service of the order has no batch to pick
          invoiceLine({ orderLineId: SERVICE_LINE, batchId: BATCH, serialNumbers: ['SN-1'] }),
        ],
      }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      customerId: 'sales_customer_required',
      branchId: 'sales_branch_invalid',
      dueDate: 'invoice_due_date',
      'lines.0.orderLineId': 'invoice_line_source',
      'lines.1.batchId': 'invoice_stock_not_allowed',
      'lines.1.serialNumbers': 'invoice_stock_not_allowed',
    });
  });

  it('bills a challan line once, and moves a serial number once', () => {
    const twice = invoiceInputSchema.safeParse(
      invoice({
        lines: [
          invoiceLine({ deliveryLineId: DELIVERY_LINE }),
          invoiceLine({ deliveryLineId: DELIVERY_LINE }),
        ],
      }),
    );
    expect(errorsOf(twice)).toEqual({ 'lines.1.deliveryLineId': 'invoice_line_twice' });

    // Two lines of its own, the same phone scanned on both
    const serials = invoiceInputSchema.safeParse(
      invoice({
        lines: [
          invoiceLine({ serialNumbers: ['IMEI-356938035643809'] }),
          invoiceLine({ serialNumbers: ['IMEI-356938035643809'] }),
        ],
      }),
    );
    expect(errorsOf(serials)).toEqual({ 'lines.1.serialNumbers.0': 'stock_serial_twice' });
  });

  it('lets a line of its own pick its batch, and keeps the discount rule of every sales line', () => {
    expect(
      invoiceInputSchema.safeParse(invoice({ lines: [invoiceLine({ batchId: BATCH })] })).success,
    ).toBe(true);
    const tooMuch = invoiceInputSchema.safeParse(
      invoice({ lines: [invoiceLine({ discountType: 'amount', discount: '1009' })] }),
    );
    // 2 × ৳504 = ৳1,008: ৳1,009 off is more than the line
    expect(errorsOf(tooMuch)).toEqual({ 'lines.0.discount': 'sales_discount_too_large' });
  });
});
