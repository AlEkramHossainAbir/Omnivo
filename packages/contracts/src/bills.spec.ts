import { describe, expect, it } from 'vitest';

import {
  billAmountDueOf,
  billInputSchema,
  type BillLineFormValues,
  billPaymentStatusOf,
  debitStateOf,
  expenseLineAmounts,
  isBillOverdue,
  priceDifferenceOf,
  updateBillInputSchema,
} from './bills.js';
import { documentTotals, lineAmounts } from './sales.js';

const SUPPLIER = '01920000-0000-7000-8000-000000000001';
const BRANCH = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const RATE = '01920000-0000-7000-8000-000000000005';
const RECEIPT_LINE = '01920000-0000-7000-8000-000000000006';
const ORDER_LINE = '01920000-0000-7000-8000-000000000007';
const ACCOUNT = '01920000-0000-7000-8000-000000000008';

function line(extra: Partial<BillLineFormValues> = {}): BillLineFormValues {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '600',
    description: '',
    unitPrice: '312.50',
    discountType: 'percent',
    discount: '',
    taxRateId: RATE,
    receiptLineId: RECEIPT_LINE,
    orderLineId: '',
    accountId: '',
    lotNumber: '',
    expiresOn: '',
    manufacturedOn: '',
    serialNumbers: [],
    ...extra,
  };
}

function bill(extra: Record<string, unknown> = {}) {
  return {
    supplierId: SUPPLIER,
    date: '2026-10-20',
    dueDate: '',
    supplierBillNumber: 'MSM/2026/0412',
    mushakNumber: '',
    mushakDate: '',
    branchId: BRANCH,
    warehouseId: '',
    pricesIncludeVat: false,
    note: '',
    lines: [line()],
    expenses: [],
    submit: false,
    ...extra,
  };
}

describe('bill input', () => {
  it('reads empty boxes as "not set": no due date, no Mushak 6.3, no account, no lot', () => {
    expect(billInputSchema.parse(bill())).toMatchObject({
      dueDate: null,
      mushakNumber: null,
      mushakDate: null,
      warehouseId: null,
      note: null,
      lines: [
        expect.objectContaining({
          receiptLineId: RECEIPT_LINE,
          orderLineId: null,
          accountId: null,
          lotNumber: null,
          discount: '0',
        }),
      ],
    });
  });

  it("needs the supplier's own bill number", () => {
    expect(billInputSchema.safeParse(bill({ supplierBillNumber: '  ' })).error?.issues).toEqual([
      expect.objectContaining({
        path: ['supplierBillNumber'],
        message: 'bill_supplier_number_required',
      }),
    ]);
  });

  it('needs a line or an expense', () => {
    expect(billInputSchema.safeParse(bill({ lines: [] })).error?.issues).toEqual([
      expect.objectContaining({ path: ['lines'], message: 'purchase_lines_required' }),
    ]);
    const expense = {
      accountId: ACCOUNT,
      description: 'Generator repair',
      amount: '8500',
      taxRateId: RATE,
    };
    expect(billInputSchema.safeParse(bill({ lines: [], expenses: [expense] })).success).toBe(true);
  });

  it('refuses a due date before the bill, and a Mushak 6.3 date without its number', () => {
    expect(
      billInputSchema.safeParse(bill({ dueDate: '2026-10-19', mushakDate: '2026-10-18' })).error
        ?.issues,
    ).toEqual([
      expect.objectContaining({ path: ['dueDate'], message: 'bill_due_date' }),
      expect.objectContaining({ path: ['mushakNumber'], message: 'bill_mushak_number_required' }),
    ]);
  });

  it('bills one thing per line: not a receipt line and an order line at once', () => {
    const lines = [line({ orderLineId: ORDER_LINE })];
    expect(billInputSchema.safeParse(bill({ lines })).error?.issues).toEqual([
      expect.objectContaining({ path: ['lines', 0, 'orderLineId'], message: 'bill_line_source' }),
    ]);
  });

  it('keeps an expense account and a lot off a receipt line: it is goods that came in already', () => {
    const lines = [line({ accountId: ACCOUNT, lotNumber: 'L-0918' })];
    expect(billInputSchema.safeParse(bill({ lines })).error?.issues).toEqual([
      expect.objectContaining({
        path: ['lines', 0, 'accountId'],
        message: 'bill_account_not_allowed',
      }),
      expect.objectContaining({
        path: ['lines', 0, 'lotNumber'],
        message: 'bill_stock_not_allowed',
      }),
    ]);
  });

  it('lets a line of its own bring a lot in and name an account', () => {
    const lines = [line({ receiptLineId: '', accountId: ACCOUNT, lotNumber: 'L-0918' })];
    expect(billInputSchema.safeParse(bill({ lines })).success).toBe(true);
  });

  it('bills a receipt line once, and marks the second line', () => {
    const lines = [line(), line()];
    expect(billInputSchema.safeParse(bill({ lines })).error?.issues).toEqual([
      expect.objectContaining({
        path: ['lines', 1, 'receiptLineId'],
        message: 'bill_line_twice',
      }),
    ]);
  });

  it('needs an account, a description and an amount above zero on an expense', () => {
    const expense = { accountId: '', description: 'x', amount: '0', taxRateId: RATE };
    expect(
      billInputSchema
        .safeParse(bill({ expenses: [expense] }))
        .error?.issues.map((issue) => [issue.path.join('.'), issue.message]),
    ).toEqual([
      ['expenses.0.accountId', 'bill_account_required'],
      ['expenses.0.description', 'bill_expense_description_required'],
      ['expenses.0.amount', 'bill_expense_amount_required'],
    ]);
  });

  it('needs the version to change a draft', () => {
    expect(updateBillInputSchema.safeParse(bill()).success).toBe(false);
    expect(updateBillInputSchema.safeParse(bill({ version: 3 })).success).toBe(true);
  });
});

describe('bill amounts', () => {
  it('works an expense out like one unit of a sales line, with or without VAT in it', () => {
    // A DESCO bill of ৳11,500 with 15% VAT in it holds ৳1,500 of VAT
    expect(expenseLineAmounts({ amount: '11500', rate: '15.00' }, true)).toMatchObject({
      net: '10000.0000',
      vat: '1500.0000',
      total: '11500.0000',
    });
    expect(expenseLineAmounts({ amount: '8500', rate: '15.00' }, false)).toEqual(
      lineAmounts(
        { quantity: '1', unitPrice: '8500', discountType: 'amount', discount: '0', rate: '15.00' },
        false,
      ),
    );
  });

  it("adds an expense to the item lines' totals", () => {
    const yarn = lineAmounts(
      { quantity: '600', unitPrice: '315', discountType: 'percent', discount: '0', rate: '15.00' },
      false,
    );
    const carriage = expenseLineAmounts({ amount: '4000', rate: '0' }, false);
    expect(documentTotals([yarn, carriage])).toMatchObject({
      net: '193000.0000',
      vat: '28350.0000',
      total: '221350.0000',
    });
  });

  it("says what a receipt line's price changed by: up, down, or nothing without an order price", () => {
    // 600 m of jersey booked at ৳312.50 (৳1,87,500), billed at ৳315
    expect(priceDifferenceOf({ net: '189000.0000', orderValue: '187500.0000' })).toBe('1500.0000');
    expect(priceDifferenceOf({ net: '186000.0000', orderValue: '187500.0000' })).toBe('-1500.0000');
    expect(priceDifferenceOf({ net: '4000.0000', orderValue: null })).toBe('0.0000');
  });

  it('is paid by what payments applied, and overdue only after its due date', () => {
    const posted = {
      status: 'posted',
      dueDate: '2026-11-19',
      total: '221350.0000',
      amountDebited: '0.0000',
    };
    expect(billPaymentStatusOf({ ...posted, amountPaid: '0.0000' })).toBe('unpaid');
    expect(billPaymentStatusOf({ ...posted, amountPaid: '100000.0000' })).toBe('partly_paid');
    expect(billAmountDueOf({ ...posted, amountPaid: '100000.0000' })).toBe('121350.0000');
    expect(billPaymentStatusOf({ ...posted, amountPaid: '221350.0000' })).toBe('paid');
    expect(isBillOverdue({ ...posted, amountPaid: '0.0000' }, '2026-11-19')).toBe(false);
    expect(isBillOverdue({ ...posted, amountPaid: '0.0000' }, '2026-11-20')).toBe(true);
    expect(isBillOverdue({ ...posted, amountPaid: '221350.0000' }, '2026-11-20')).toBe(false);
  });

  it('owes less by what debit notes applied, like money paid (step 17d)', () => {
    // 20 m of torn jersey went back: a debit note of ৳7,245 applied to the bill
    const posted = {
      status: 'posted',
      dueDate: '2026-11-19',
      total: '221350.0000',
      amountDebited: '7245.0000',
    };
    expect(billAmountDueOf({ ...posted, amountPaid: '0.0000' })).toBe('214105.0000');
    expect(billPaymentStatusOf({ ...posted, amountPaid: '0.0000' })).toBe('partly_paid');
    expect(billPaymentStatusOf({ ...posted, amountPaid: '214105.0000' })).toBe('paid');
    expect(isBillOverdue({ ...posted, amountPaid: '214105.0000' }, '2026-11-20')).toBe(false);
  });

  it('is debited by the posted debit notes written for it, wherever their money went', () => {
    expect(debitStateOf({ total: '221350.0000', debitNoteTotal: '0.0000' })).toBe('none');
    expect(debitStateOf({ total: '221350.0000', debitNoteTotal: '7245.0000' })).toBe(
      'partly_debited',
    );
    expect(debitStateOf({ total: '221350.0000', debitNoteTotal: '221350.0000' })).toBe('debited');
  });
});
