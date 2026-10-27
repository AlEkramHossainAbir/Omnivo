import type {
  CustomerInput,
  Product,
  SalesOrderDraftInput,
  SyncChange,
  SyncCustomer,
  SyncPull,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import { LocalCopy } from './copy.js';
import { SyncDatabase } from './database.js';
import { openKey } from './keys.js';

// Rows and pages for the specs. Not built into dist (tsconfig.build.json leaves it out).

const UPDATED = '2026-10-21T04:00:00.000Z';

export function newDatabase(name = `test-${uuidv7()}`): SyncDatabase {
  // A name of its own per test: fake-indexeddb keeps every database of the process in memory
  return new SyncDatabase(name);
}

// Step 19b: the 32 bytes the server would give this device (19b.2), the same in every spec
export const SERVER_KEY = new Uint8Array(32).fill(7);

// A copy opened the way the app opens it online: the server's key makes the data key the first
// time and opens it after. Close it at the end of the test (copy.close(), db.close()).
export async function openCopy(db: SyncDatabase): Promise<LocalCopy> {
  const opened = await openKey(db, { serverKey: SERVER_KEY });
  if (opened.kind !== 'open') throw new Error(`The test key did not open: ${opened.kind}`);
  return LocalCopy.open(db, opened.key);
}

export function newCopy(): Promise<LocalCopy> {
  return openCopy(newDatabase());
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

// What the customer form sends (the schema's output): every empty box is null
export function customerInput(
  fields: Partial<CustomerInput> & Pick<CustomerInput, 'name'>,
): CustomerInput {
  return {
    code: null,
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
    ...fields,
  };
}

// The form's values of a customer the device has: what a form opened on it sends unchanged
export function inputOf(row: SyncCustomer): CustomerInput {
  return {
    code: row.code,
    name: row.name,
    groupId: row.groupId,
    contactPerson: row.contactPerson,
    phone: row.phone,
    email: row.email,
    documentLanguage: row.documentLanguage,
    bin: row.bin,
    paymentTermsDays: row.paymentTermsDays,
    creditLimit: row.creditLimit,
    priceListId: row.priceListId,
    notes: row.notes,
    addresses: row.addresses.map((address) => ({
      id: address.id,
      kind: address.kind === 'billing' ? 'billing' : 'shipping',
      label: address.label,
      address: address.address,
      phone: address.phone,
    })),
  };
}

export const WAREHOUSE = '01928c4e-7777-7000-8000-000000000001';
export const VAT_15 = '01928c4e-7777-7000-8000-000000000002';

export function orderDraft(customerId: string, variantId: string): SalesOrderDraftInput {
  return {
    customerId,
    date: '2026-10-21',
    deliveryDate: null,
    customerReference: null,
    warehouseId: WAREHOUSE,
    shippingAddressId: null,
    note: null,
    lines: [
      {
        variantId,
        unitId: '01928c4e-0000-7000-8000-000000000001',
        quantity: '12',
        description: null,
        unitPrice: '50',
        discountType: 'percent',
        discount: '0',
        taxRateId: VAT_15,
      },
    ],
  };
}
