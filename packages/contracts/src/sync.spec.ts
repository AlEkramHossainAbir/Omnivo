import { describe, expect, it } from 'vitest';

import {
  priceListItemKey,
  registerDeviceInputSchema,
  stockKey,
  syncChangeSchema,
  syncCustomerSchema,
  syncPullQuerySchema,
  syncPullSchema,
} from './sync.js';

const WAREHOUSE = '0192f1c4-0000-7000-8000-00000000000a';
const VARIANT = '0192f1c4-0000-7000-8000-00000000000b';
const BATCH = '0192f1c4-0000-7000-8000-00000000000c';
const PRODUCT = '0192f1c4-0000-7000-8000-00000000000d';
const UNIT = '0192f1c4-0000-7000-8000-00000000000e';
const LIST = '0192f1c4-0000-7000-8000-00000000000f';
const AT = '2026-10-20T04:30:00.000Z';

// Napa 500 mg as the API sends it: a simple product, sold by the strip and the box of 10 strips
const napa = {
  id: PRODUCT,
  code: 'NAPA-500',
  name: 'Napa 500 mg',
  type: 'goods',
  categoryId: null,
  description: null,
  baseUnitId: UNIT,
  salesUnitId: null,
  purchaseUnitId: null,
  tracking: 'batch',
  hasExpiry: true,
  taxRateId: null,
  options: [],
  variants: [
    {
      id: VARIANT,
      sku: 'NAPA-500',
      optionValues: [],
      barcode: '8941100500019',
      salePrice: '12.0000',
      archivedAt: null,
    },
  ],
  units: [],
  customFields: {},
  archivedAt: null,
  version: 3,
  updatedAt: AT,
};

const stockRow = {
  warehouseId: WAREHOUSE,
  productId: PRODUCT,
  variantId: VARIANT,
  batchId: BATCH,
  lotNumber: 'NP24117',
  manufacturedOn: '2026-03-01',
  expiresOn: '2028-02-28',
  quantity: '240.0000',
  updatedAt: AT,
};

describe('sync keys', () => {
  it('keys a stock row by warehouse, variant and batch, with "-" for no batch', () => {
    expect(stockKey(stockRow)).toBe(`${WAREHOUSE}:${VARIANT}:${BATCH}`);
    expect(stockKey({ ...stockRow, batchId: null })).toBe(`${WAREHOUSE}:${VARIANT}:-`);
  });

  it('keys a price by list, variant and unit', () => {
    expect(priceListItemKey({ priceListId: LIST, variantId: VARIANT, unitId: UNIT })).toBe(
      `${LIST}:${VARIANT}:${UNIT}`,
    );
  });
});

describe('sync changes', () => {
  it('reads a page of upserts and deletes, each by its entity', () => {
    const page = syncPullSchema.parse({
      changes: [
        { op: 'upsert', entity: 'product', key: PRODUCT, data: napa },
        { op: 'upsert', entity: 'stock', key: stockKey(stockRow), data: stockRow },
        { op: 'delete', entity: 'customer', key: LIST },
      ],
      cursor: 'opaque',
      hasMore: false,
      full: false,
      serverTime: AT,
    });
    const [product, stock, gone] = page.changes;
    expect(product?.op === 'upsert' && product.entity === 'product' && product.data.name).toBe(
      'Napa 500 mg',
    );
    expect(stock?.op === 'upsert' && stock.entity === 'stock' && stock.data.lotNumber).toBe(
      'NP24117',
    );
    expect(gone).toEqual({ op: 'delete', entity: 'customer', key: LIST });
  });

  it('refuses a row that does not fit its entity, and an entity it does not know', () => {
    // A stock row sent as a product: the entity decides the shape
    expect(
      syncChangeSchema.safeParse({ op: 'upsert', entity: 'product', key: PRODUCT, data: stockRow })
        .success,
    ).toBe(false);
    // A newer protocol's entity never reaches this client: the server checks the protocol first
    expect(
      syncChangeSchema.safeParse({ op: 'delete', entity: 'serial', key: PRODUCT }).success,
    ).toBe(false);
  });

  it('keeps no balance on a customer, even if one is sent', () => {
    const customer = syncCustomerSchema.parse({
      id: LIST,
      code: 'C-00042',
      name: 'Rahman Traders',
      groupId: null,
      contactPerson: null,
      phone: '01711-000000',
      email: null,
      documentLanguage: 'bn',
      bin: null,
      paymentTermsDays: 30,
      creditLimit: '200000.0000',
      priceListId: null,
      notes: null,
      addresses: [],
      isSupplier: false,
      balance: '115000.0000',
      archivedAt: null,
      version: 1,
      updatedAt: AT,
    });
    expect(customer).not.toHaveProperty('balance');
  });
});

describe('pull query', () => {
  it('reads the numbers of a query string, and starts at 500 rows a page', () => {
    expect(syncPullQuerySchema.parse({ deviceId: WAREHOUSE, protocol: '1' })).toEqual({
      deviceId: WAREHOUSE,
      protocol: 1,
      limit: 500,
    });
  });

  it('refuses a page over 1000 rows', () => {
    expect(
      syncPullQuerySchema.safeParse({ deviceId: WAREHOUSE, protocol: '1', limit: '1001' }).success,
    ).toBe(false);
  });
});

describe('device registration', () => {
  it('takes a UUIDv7 made by the browser, and a trimmed name', () => {
    expect(
      registerDeviceInputSchema.parse({ id: VARIANT, name: '  Counter 2 ', branchId: WAREHOUSE }),
    ).toEqual({ id: VARIANT, name: 'Counter 2', branchId: WAREHOUSE });
  });

  it('refuses an id of another kind, a one-letter name and no branch, each with its code', () => {
    const result = registerDeviceInputSchema.safeParse({
      id: '6f1c2a4e-1111-4111-8111-111111111111',
      name: 'C',
      branchId: '',
    });
    expect(result.error?.issues.map((issue) => [issue.path[0], issue.message])).toEqual([
      ['id', 'device_id_invalid'],
      ['name', 'device_name_required'],
      ['branchId', 'device_branch_invalid'],
    ]);
  });
});
