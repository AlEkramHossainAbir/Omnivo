import { describe, expect, it } from 'vitest';

import { type BillExpense, type BillLine, expenseLineAmounts } from './bills.js';
import {
  canDebitWhole,
  debitNoteAllocationsInputSchema,
  debitNoteInputSchema,
  wholeBillDebit,
} from './debit-notes.js';
import { lineAmounts } from './sales.js';

const SUPPLIER = '01920000-0000-7000-8000-000000000001';
const BILL = '01920000-0000-7000-8000-000000000002';
const BILL_LINE = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const RETURN_LINE = '01920000-0000-7000-8000-000000000005';
const BRANCH = '01920000-0000-7000-8000-000000000006';
const RATE = '01920000-0000-7000-8000-000000000007';
const EXPENSE = '01920000-0000-7000-8000-000000000008';
const OTHER_BILL = '01920000-0000-7000-8000-000000000009';

const VAT_15 = {
  id: RATE,
  name: 'VAT 15%',
  kind: 'standard',
  rate: '15.00',
};

function debitLine(extra: object = {}) {
  return {
    billLineId: BILL_LINE,
    returnLineId: '',
    taxRateId: '',
    unitId: UNIT,
    quantity: '20',
    description: '',
    unitPrice: '315',
    discountType: 'percent',
    discount: '',
    ...extra,
  };
}

function debitNote(extra: object = {}) {
  return {
    supplierId: SUPPLIER,
    billId: BILL,
    date: '2026-10-28',
    branchId: '',
    pricesIncludeVat: false,
    reason: 'goods_returned',
    supplierCreditNumber: '',
    supplierCreditDate: '',
    note: '',
    lines: [debitLine({ returnLineId: RETURN_LINE })],
    expenses: [],
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

// A bill line as the API sends it: 600 m of jersey at ৳315 less 2%, VAT 15% added
function billLine(extra: Partial<BillLine> = {}): BillLine {
  const amounts = lineAmounts(
    { quantity: '600', unitPrice: '315', discountType: 'percent', discount: '2', rate: '15.00' },
    false,
  );
  return {
    id: BILL_LINE,
    variantId: '01920000-0000-7000-8000-000000000010',
    productId: '01920000-0000-7000-8000-000000000011',
    productCode: 'P-00007',
    productName: 'Single jersey 160 GSM',
    optionValues: ['Navy'],
    sku: 'SJ-160-NAVY',
    baseUnitId: UNIT,
    productType: 'goods',
    tracking: 'batch',
    hasExpiry: false,
    units: [],
    unitId: UNIT,
    quantity: '600.0000',
    baseQuantity: '600.0000',
    description: 'Single jersey 160 GSM — Navy',
    unitPrice: '315.0000',
    discountType: 'percent',
    discount: '2.0000',
    taxRate: VAT_15,
    net: amounts.net,
    vat: amounts.vat,
    total: amounts.total,
    receiptLineId: '01920000-0000-7000-8000-000000000012',
    receiptNumber: 'GRN-2026-27-0001',
    orderLineId: '01920000-0000-7000-8000-000000000013',
    orderNumber: 'PO-2026-27-0001',
    accountId: null,
    orderValue: '187500.0000',
    batchId: '01920000-0000-7000-8000-000000000014',
    lotNumber: 'MSM-2610-07',
    expiresOn: null,
    manufacturedOn: null,
    serialNumbers: [],
    debited: '0.0000',
    ...extra,
  };
}

// A truck from the mill to the Gazipur store, ৳4,000 before VAT
function billExpense(): BillExpense {
  const amounts = expenseLineAmounts({ amount: '4000', rate: '15.00' }, false);
  return {
    id: EXPENSE,
    accountId: '01920000-0000-7000-8000-000000000015',
    description: 'Truck, Narayanganj to Gazipur',
    amount: '4000.0000',
    taxRate: VAT_15,
    net: amounts.net,
    vat: amounts.vat,
    total: amounts.total,
    debited: '0.0000',
  };
}

describe('debit note input, with a bill', () => {
  it('takes a line for a return and a price cut on the same bill line, and an expense', () => {
    const parsed = debitNoteInputSchema.parse(
      debitNote({
        lines: [
          debitLine({ returnLineId: RETURN_LINE }),
          debitLine({ quantity: '580', unitPrice: '2.50' }),
        ],
        expenses: [{ billExpenseId: EXPENSE, amount: '500' }],
      }),
    );
    expect(
      parsed.lines.map((line) => [line.billLineId, line.returnLineId, line.taxRateId]),
    ).toEqual([
      [BILL_LINE, RETURN_LINE, null],
      [BILL_LINE, null, null],
    ]);
    expect(parsed.expenses).toEqual([{ billExpenseId: EXPENSE, amount: '500' }]);
  });

  it("needs the bill's line, and takes no VAT rate of its own", () => {
    const result = debitNoteInputSchema.safeParse(
      debitNote({ lines: [debitLine({ billLineId: '', taxRateId: RATE })] }),
    );
    expect(errorsOf(result)).toEqual({
      'lines.0.billLineId': 'debit_note_line_invalid',
      'lines.0.taxRateId': 'debit_note_tax_rate_not_allowed',
    });
  });

  it('refuses one return line twice and one expense twice, on the second row', () => {
    const result = debitNoteInputSchema.safeParse(
      debitNote({
        lines: [debitLine({ returnLineId: RETURN_LINE }), debitLine({ returnLineId: RETURN_LINE })],
        expenses: [
          { billExpenseId: EXPENSE, amount: '500' },
          { billExpenseId: EXPENSE, amount: '100' },
        ],
      }),
    );
    expect(errorsOf(result)).toEqual({
      'lines.1.returnLineId': 'debit_note_return_twice',
      'expenses.1.billExpenseId': 'debit_note_expense_twice',
    });
  });

  it('takes something off, and a Mushak 6.7 date only with its number', () => {
    const result = debitNoteInputSchema.safeParse(
      debitNote({ lines: [], supplierCreditDate: '2026-10-27' }),
    );
    expect(errorsOf(result)).toEqual({
      lines: 'purchase_lines_required',
      supplierCreditNumber: 'debit_note_supplier_credit_required',
    });
  });

  it('never takes off more than the line: the 15b discount rule', () => {
    const result = debitNoteInputSchema.safeParse(
      debitNote({ lines: [debitLine({ discountType: 'percent', discount: '101' })] }),
    );
    expect(errorsOf(result)).toEqual({ 'lines.0.discount': 'sales_discount_too_large' });
  });
});

describe('debit note input, without a bill', () => {
  // Expired Napa strips bought before Omnivo, sent back to the distributor
  const ownLine = debitLine({
    billLineId: '',
    returnLineId: RETURN_LINE,
    taxRateId: RATE,
    unitPrice: '21',
  });

  it('takes return lines of their own with a VAT rate, on a branch', () => {
    const parsed = debitNoteInputSchema.parse(
      debitNote({ billId: '', branchId: BRANCH, lines: [ownLine] }),
    );
    expect([parsed.billId, parsed.branchId, parsed.lines[0]?.taxRateId]).toEqual([
      null,
      BRANCH,
      RATE,
    ]);
  });

  it('needs a branch, a return line and a rate on every line, and no expense', () => {
    const result = debitNoteInputSchema.safeParse(
      debitNote({
        billId: '',
        lines: [debitLine()],
        expenses: [{ billExpenseId: EXPENSE, amount: '500' }],
      }),
    );
    expect(errorsOf(result)).toEqual({
      branchId: 'purchase_branch_invalid',
      expenses: 'debit_note_expense_invalid',
      'lines.0.billLineId': 'debit_note_line_invalid',
      'lines.0.returnLineId': 'debit_note_return_required',
      'lines.0.taxRateId': 'tax_rate_invalid',
    });
  });
});

describe('debit whole bill', () => {
  it('takes off exactly what each line and expense charged, to the paisa', () => {
    const line = billLine();
    const expense = billExpense();
    const parsed = debitNoteInputSchema.parse(
      debitNote(wholeBillDebit({ lines: [line], expenses: [expense] })),
    );
    const [debited] = parsed.lines;
    const [expenseDebited] = parsed.expenses;
    expect(debited).toBeDefined();
    expect(expenseDebited).toBeDefined();
    if (!debited || !expenseDebited) return;
    expect(lineAmounts({ ...debited, rate: line.taxRate.rate }, false)).toMatchObject({
      net: line.net,
      vat: line.vat,
      total: line.total,
    });
    expect(
      expenseLineAmounts({ amount: expenseDebited.amount, rate: expense.taxRate.rate }, false),
    ).toMatchObject({ net: expense.net, vat: expense.vat, total: expense.total });
  });

  it('is offered only for a posted bill with no posted debit note', () => {
    expect(canDebitWhole({ status: 'posted', debitNotes: [] })).toBe(true);
    expect(canDebitWhole({ status: 'pending', debitNotes: [] })).toBe(false);
    expect(
      canDebitWhole({
        status: 'posted',
        debitNotes: [{ id: BILL, number: 'DN-2026-27-0001', date: '2026-10-28', total: '1.0000' }],
      }),
    ).toBe(false);
  });
});

describe('debit note allocations', () => {
  it('uses its own error codes', () => {
    const result = debitNoteAllocationsInputSchema.safeParse({
      version: 1,
      allocations: [
        { billId: OTHER_BILL, amount: '0' },
        { billId: OTHER_BILL, amount: '10' },
      ],
    });
    expect(errorsOf(result)).toEqual({
      'allocations.0.amount': 'debit_note_amount_required',
      'allocations.1.billId': 'debit_note_bill_twice',
    });
  });
});
