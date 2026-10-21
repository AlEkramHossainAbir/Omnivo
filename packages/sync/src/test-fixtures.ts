import type { Product, SyncChange, SyncCustomer, SyncPull } from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import { SyncDatabase } from './database.js';

// Rows and pages for the specs. Not built into dist (tsconfig.build.json leaves it out).

const UPDATED = '2026-10-21T04:00:00.000Z';

export function newDatabase(): SyncDatabase {
  // A name of its own per test: fake-indexeddb keeps every database of the process in memory
  return new SyncDatabase(`test-${uuidv7()}`);
}

export function product(fields: Partial<Product> & Pick<Product, 'name'>): Product {
  const id = fields.id ?? uuidv7();
  return {
    id,
    code: 'P-0001',
    type: 'goods',
    categoryId: null,
    description: null,
    baseUnitId: '01928c4e-0000-7000-8000-000000000001',
    salesUnitId: null,
    purchaseUnitId: null,
    tracking: 'none',
    hasExpiry: false,
    taxRateId: null,
    options: [],
    variants: [
      {
        id: uuidv7(),
        sku: fields.code ?? 'P-0001',
        optionValues: [],
        barcode: null,
        salePrice: null,
        archivedAt: null,
      },
    ],
    units: [],
    customFields: {},
    archivedAt: null,
    version: 1,
    updatedAt: UPDATED,
    ...fields,
  };
}

export function customer(fields: Partial<SyncCustomer> & Pick<SyncCustomer, 'name'>): SyncCustomer {
  return {
    id: fields.id ?? uuidv7(),
    code: 'C-00001',
    groupId: null,
    contactPerson: null,
    phone: null,
    email: null,
    documentLanguage: 'en',
    bin: null,
    paymentTermsDays: 0,
    creditLimit: null,
    priceListId: null,
    notes: null,
    addresses: [],
    isSupplier: false,
    archivedAt: null,
    version: 1,
    updatedAt: UPDATED,
    ...fields,
  };
}

export function upsertProduct(row: Product): SyncChange {
  return { op: 'upsert', entity: 'product', key: row.id, data: row };
}

export function upsertCustomer(row: SyncCustomer): SyncChange {
  return { op: 'upsert', entity: 'customer', key: row.id, data: row };
}

export function page(fields: Partial<SyncPull> & Pick<SyncPull, 'changes'>): SyncPull {
  return {
    cursor: `cursor-${uuidv7()}`,
    hasMore: false,
    full: false,
    serverTime: '2026-10-21T04:30:00.000Z',
    ...fields,
  };
}
