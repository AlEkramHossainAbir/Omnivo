import { describe, expect, it } from 'vitest';

import {
  canCreditWhole,
  creditNoteAllocationsInputSchema,
  creditNoteInputSchema,
  creditNoteIsLate,
  wholeInvoiceCreditLines,
} from './credit-notes.js';
import { contractErrorMap } from './errors.js';
import type { InvoiceLine } from './invoices.js';
import { lineAmounts } from './sales.js';

const INVOICE = '01920000-0000-7000-8000-000000000001';
const INVOICE_LINE = '01920000-0000-7000-8000-000000000002';
const UNIT = '01920000-0000-7000-8000-000000000003';
const RETURN_LINE = '01920000-0000-7000-8000-000000000004';
const OTHER_INVOICE = '01920000-0000-7000-8000-000000000005';

function creditLine(extra: object = {}) {
  return {
    invoiceLineId: INVOICE_LINE,
    returnLineId: '',
    unitId: UNIT,
    quantity: '3',
    description: '',
    unitPrice: '504',
    discountType: 'percent',
    discount: '',
    ...extra,
  };
}

function creditNote(extra: object = {}) {
  return {
    invoiceId: INVOICE,
    date: '2026-10-11',
    reason: 'goods_returned',
    note: '',
    lines: [creditLine({ returnLineId: RETURN_LINE })],
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

// An invoice line as the API sends it: 2 cases at ৳504 less ৳8, VAT 15% added
function invoiceLine(extra: Partial<InvoiceLine> = {}): InvoiceLine {
  const amounts = lineAmounts(
    { quantity: '2', unitPrice: '504', discountType: 'amount', discount: '8', rate: '15.00' },
    false,
  );
  return {
    id: INVOICE_LINE,
    variantId: '01920000-0000-7000-8000-000000000010',
    productId: '01920000-0000-7000-8000-000000000011',
    productCode: 'P-00001',
    productName: 'Napa 500 mg',
    optionValues: [],
    sku: 'NAPA-500',
    baseUnitId: '01920000-0000-7000-8000-000000000012',
    productType: 'goods',
    tracking: 'batch',
    hasExpiry: true,
    units: [],
    unitId: UNIT,
    quantity: '2.0000',
    baseQuantity: '48.0000',
    description: 'Napa 500 mg',
    unitPrice: '504.0000',
    discountType: 'amount',
    discount: '8.0000',
    taxRate: {
      id: '01920000-0000-7000-8000-000000000013',
      name: 'VAT 15%',
      kind: 'standard',
      rate: '15.00',
    },
    net: amounts.net,
    vat: amounts.vat,
    total: amounts.total,
    deliveryLineId: null,
    orderLineId: null,
    deliveryNumber: null,
    orderNumber: null,
    batchId: null,
    lotNumber: null,
    expiresOn: null,
    serialNumbers: [],
    credited: '0.0000',
    ...extra,
  };
}

describe('credit note input', () => {
  it('takes a line for a return and a price cut on the same invoice line', () => {
    const parsed = creditNoteInputSchema.parse(
      creditNote({
        reason: 'price_adjustment',
        lines: [
          creditLine({ returnLineId: RETURN_LINE }),
          creditLine({ quantity: '48', unitPrice: '2' }),
        ],
      }),
    );
    expect(parsed.lines.map((line) => line.returnLineId)).toEqual([RETURN_LINE, null]);
  });

  it('refuses one return line twice, on the second line', () => {
    const result = creditNoteInputSchema.safeParse(
      creditNote({
        lines: [
          creditLine({ returnLineId: RETURN_LINE }),
          creditLine({ returnLineId: RETURN_LINE }),
        ],
      }),
    );
    expect(errorsOf(result)).toEqual({ 'lines.1.returnLineId': 'credit_note_return_twice' });
  });

  it('never takes back more than the line: the 15b discount rule', () => {
    const result = creditNoteInputSchema.safeParse(
      creditNote({ lines: [creditLine({ discountType: 'amount', discount: '2000' })] }),
    );
    expect(errorsOf(result)).toEqual({ 'lines.0.discount': 'sales_discount_too_large' });
  });

  it('marks every mistake at once', () => {
    const result = creditNoteInputSchema.safeParse(
      creditNote({
        invoiceId: '',
        lines: [
          creditLine({ invoiceLineId: '', returnLineId: RETURN_LINE }),
          creditLine({ returnLineId: RETURN_LINE }),
        ],
      }),
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      invoiceId: 'credit_note_invoice_required',
      'lines.0.invoiceLineId': 'credit_note_line_invalid',
      'lines.1.returnLineId': 'credit_note_return_twice',
    });
  });
});

describe('credit whole invoice', () => {
  it('gives back exactly what each line charged, to the paisa', () => {
    const line = invoiceLine();
    const [credit] = creditNoteInputSchema.parse(
      creditNote({ lines: wholeInvoiceCreditLines({ lines: [line] }) }),
    ).lines;
    expect(credit).toBeDefined();
    if (!credit) return;
    expect(lineAmounts({ ...credit, rate: line.taxRate.rate }, false)).toMatchObject({
      net: line.net,
      vat: line.vat,
      total: line.total,
    });
  });

  it('is offered only for a posted invoice with no posted credit note', () => {
    expect(canCreditWhole({ status: 'posted', creditNotes: [] })).toBe(true);
    expect(canCreditWhole({ status: 'draft', creditNotes: [] })).toBe(false);
    expect(
      canCreditWhole({
        status: 'posted',
        creditNotes: [
          { id: INVOICE, number: 'CN-2026-27-0001', date: '2026-10-11', total: '100.0000' },
        ],
      }),
    ).toBe(false);
  });
});

describe('the 6-month VAT window', () => {
  it('warns only after six months, counting calendar months', () => {
    expect(creditNoteIsLate('2026-04-11', '2026-10-11')).toBe(false);
    expect(creditNoteIsLate('2026-04-11', '2026-10-12')).toBe(true);
    // 31 August + 6 months is the last day of February
    expect(creditNoteIsLate('2026-08-31', '2027-02-28')).toBe(false);
    expect(creditNoteIsLate('2026-08-31', '2027-03-01')).toBe(true);
  });
});

describe('credit note allocations', () => {
  it('uses its own error codes', () => {
    const result = creditNoteAllocationsInputSchema.safeParse({
      version: 1,
      allocations: [
        { invoiceId: OTHER_INVOICE, amount: '0' },
        { invoiceId: OTHER_INVOICE, amount: '10' },
      ],
    });
    expect(errorsOf(result)).toEqual({
      'allocations.0.amount': 'credit_note_amount_required',
      'allocations.1.invoiceId': 'credit_note_invoice_twice',
    });
  });
});
