import { describe, expect, it } from 'vitest';

import { costLookupInputSchema } from './purchase.js';
import {
  purchaseOrderInputSchema,
  type PurchaseOrderLineFormValues,
  updatePurchaseOrderInputSchema,
} from './purchase-orders.js';
import { documentTotals, lineAmounts } from './sales.js';

const SUPPLIER = '01920000-0000-7000-8000-000000000001';
const WAREHOUSE = '01920000-0000-7000-8000-000000000002';
const VARIANT = '01920000-0000-7000-8000-000000000003';
const UNIT = '01920000-0000-7000-8000-000000000004';
const RATE = '01920000-0000-7000-8000-000000000005';
const REQUISITION_LINE = '01920000-0000-7000-8000-000000000006';

function line(extra: Partial<PurchaseOrderLineFormValues> = {}): PurchaseOrderLineFormValues {
  return {
    variantId: VARIANT,
    unitId: UNIT,
    quantity: '40',
    description: '',
    unitPrice: '4250.50',
    discountType: 'percent',
    discount: '',
    taxRateId: RATE,
    requisitionLineId: '',
    ...extra,
  };
}

function order(extra: Record<string, unknown> = {}) {
  return {
    supplierId: SUPPLIER,
    date: '2026-10-18',
    expectedDate: '',
    warehouseId: WAREHOUSE,
    supplierReference: '',
    paymentTermsDays: 30,
    pricesIncludeVat: false,
    note: '',
    lines: [line()],
    ...extra,
  };
}

describe('purchase order input', () => {
  it('reads empty boxes as "not set": no expected date, no requisition, no discount', () => {
    expect(purchaseOrderInputSchema.parse(order())).toMatchObject({
      expectedDate: null,
      supplierReference: null,
      note: null,
      lines: [expect.objectContaining({ requisitionLineId: null, discount: '0' })],
    });
  });

  it('needs a supplier, on that box', () => {
    expect(purchaseOrderInputSchema.safeParse(order({ supplierId: '' })).error?.issues).toEqual([
      expect.objectContaining({ path: ['supplierId'], message: 'purchase_supplier_required' }),
    ]);
  });

  it('refuses an expected date before the order', () => {
    expect(
      purchaseOrderInputSchema.safeParse(order({ expectedDate: '2026-10-17' })).error?.issues,
    ).toEqual([
      expect.objectContaining({ path: ['expectedDate'], message: 'purchase_expected_date' }),
    ]);
  });

  it('takes a requisition line once, and marks the second line', () => {
    const lines = [
      line({ requisitionLineId: REQUISITION_LINE }),
      line({ requisitionLineId: REQUISITION_LINE }),
    ];
    expect(purchaseOrderInputSchema.safeParse(order({ lines })).error?.issues).toEqual([
      expect.objectContaining({
        path: ['lines', 1, 'requisitionLineId'],
        message: 'purchase_requisition_line_twice',
      }),
    ]);
  });

  it('keeps the sales line rules: no discount bigger than the line', () => {
    const lines = [line({ discountType: 'amount', discount: '170020.01' })];
    expect(purchaseOrderInputSchema.safeParse(order({ lines })).error?.issues).toEqual([
      expect.objectContaining({
        path: ['lines', 0, 'discount'],
        message: 'sales_discount_too_large',
      }),
    ]);
  });

  it('keeps payment terms within a year, and the edit form sends its version', () => {
    expect(purchaseOrderInputSchema.safeParse(order({ paymentTermsDays: 366 })).success).toBe(
      false,
    );
    expect(updatePurchaseOrderInputSchema.safeParse(order()).success).toBe(false);
    expect(updatePurchaseOrderInputSchema.safeParse(order({ version: 3 })).success).toBe(true);
  });

  it('works the totals out like a sales document: discount, then VAT, per line', () => {
    // 40 rolls at ৳4,250.50 less 2.5% = ৳165,769.50 before VAT, ৳24,865.43 VAT at 15%
    const amounts = lineAmounts(
      {
        quantity: '40',
        unitPrice: '4250.50',
        discountType: 'percent',
        discount: '2.5',
        rate: '15',
      },
      false,
    );
    expect(documentTotals([amounts])).toEqual({
      discount: '4250.5000',
      net: '165769.5000',
      vat: '24865.4300',
      total: '190634.9300',
    });
  });
});

describe('purchase cost lookup input', () => {
  it('needs no supplier: a requisition has none', () => {
    expect(
      costLookupInputSchema.parse({ items: [{ variantId: VARIANT, unitId: UNIT }] }).supplierId,
    ).toBeNull();
  });
});
