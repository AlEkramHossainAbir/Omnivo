import { describe, expect, it } from 'vitest';

import { contractErrorMap } from './errors.js';
import {
  customerUpdateCommandSchema,
  deviceKeySchema,
  posSaleCommandSchema,
  priceListItemKey,
  registerDeviceInputSchema,
  salesOrderDraftCommandSchema,
  stockKey,
  syncChangeSchema,
  syncCommandSchema,
  syncCustomerSchema,
  syncPullQuerySchema,
  syncPullSchema,
  syncPushInputSchema,
  syncPushSchema,
  syncUpsertSchema,
  type SyncCommandInput,
  type SyncPushInput,
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

// ---------------------------------------------------------------------------------------------
// The push (step 18b)

const COMMAND = '0192f1c5-0000-7000-8000-000000000001';
const CUSTOMER = '0192f1c5-0000-7000-8000-000000000002';
const ADDRESS = '0192f1c5-0000-7000-8000-000000000003';
const ORDER = '0192f1c5-0000-7000-8000-000000000004';
const RATE = '0192f1c5-0000-7000-8000-000000000005';
// A v4 id: what another library would make
const V4 = '6f1c2a4e-1111-4111-8111-111111111111';

// The error codes where the form will show them: field path → code
function errorsOf(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return Object.fromEntries(
    (result.error?.issues ?? []).map((issue) => [issue.path.map(String).join('.'), issue.message]),
  );
}

// A pharmacy a sales officer adds in Chattogram with no signal: as the customer form sends it
function newCustomer(extra: object = {}) {
  return {
    code: '',
    name: 'Rahman Pharmacy',
    groupId: '',
    contactPerson: 'Abdur Rahman',
    phone: '01819-123456',
    email: '',
    documentLanguage: 'bn' as const,
    bin: '',
    paymentTermsDays: 15,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [
      {
        id: ADDRESS,
        kind: 'billing' as const,
        label: '',
        address: 'Agrabad C/A, Chattogram',
        phone: '',
      },
    ],
    ...extra,
  };
}

describe('device key', () => {
  // Base64 by hand: 'A' is six 0 bits, so 43 of them and '=' are 32 zero bytes. The contracts
  // run in the browser too, so there is no Buffer here.
  it('is 32 bytes in standard base64', () => {
    const key = `${'A'.repeat(43)}=`;
    expect(deviceKeySchema.parse({ key })).toEqual({ key });
  });

  it('refuses any other size, and base64url', () => {
    for (const key of [
      // 16 bytes would still make an AES key, a weaker one: the app must never take it
      `${'A'.repeat(22)}==`,
      // 31 and 33 bytes: 44 characters too
      `${'A'.repeat(42)}==`,
      'A'.repeat(44),
      // base64url drops the '=' and uses - and _
      '_'.repeat(43),
    ]) {
      expect(deviceKeySchema.safeParse({ key }).success, key).toBe(false);
    }
  });
});

describe('sync commands', () => {
  it('adds a customer with the device ids, and leaves the code to the server', () => {
    const command = syncCommandSchema.parse({
      id: COMMAND,
      type: 'customer.create',
      customerId: CUSTOMER,
      input: newCustomer(),
    });
    expect(command.type === 'customer.create' && command.input).toMatchObject({
      code: null,
      creditLimit: null,
      addresses: [{ id: ADDRESS, label: null, phone: null }],
    });
  });

  it('needs a UUIDv7 for every new id, an address too', () => {
    const result = syncCommandSchema.safeParse(
      {
        id: V4,
        type: 'customer.create',
        customerId: V4,
        input: newCustomer({
          addresses: [
            { id: null, kind: 'billing', label: '', address: 'Agrabad C/A, Chattogram', phone: '' },
          ],
        }),
      },
      { error: contractErrorMap },
    );
    expect(errorsOf(result)).toEqual({
      id: 'invalid_format',
      customerId: 'invalid_format',
      'input.addresses.0.id': 'invalid_value',
    });
  });

  it("keeps the form's one-billing rule", () => {
    const result = syncCommandSchema.safeParse({
      id: COMMAND,
      type: 'customer.create',
      customerId: CUSTOMER,
      input: newCustomer({
        addresses: [
          {
            id: ADDRESS,
            kind: 'billing',
            label: '',
            address: 'Agrabad C/A, Chattogram',
            phone: '',
          },
          { id: ORDER, kind: 'billing', label: '', address: 'GEC Circle, Chattogram', phone: '' },
        ],
      }),
    });
    expect(errorsOf(result)).toEqual({ 'input.addresses.1.kind': 'customer_billing_twice' });
  });

  it('changes only the fields sent: the old value as the API sent it, the new as the form', () => {
    const command = customerUpdateCommandSchema.parse({
      id: COMMAND,
      type: 'customer.update',
      customerId: CUSTOMER,
      baseVersion: 4,
      changes: {
        creditLimit: { from: '200000.0000', to: '' },
        phone: { from: null, to: ' 01711-000000 ' },
      },
      addresses: {
        add: [],
        remove: [],
        change: [{ id: ADDRESS, label: 'Head office' }],
      },
    });
    // '' is "no limit" in the form, null on the server
    expect(command.changes).toEqual({
      creditLimit: { from: '200000.0000', to: null },
      phone: { from: null, to: '01711-000000' },
    });
    expect(command.addresses.change).toEqual([{ id: ADDRESS, label: 'Head office' }]);
  });

  it('writes an order as a draft only, and still checks its dates', () => {
    const order = {
      customerId: CUSTOMER,
      date: '2026-10-21',
      customerReference: '',
      deliveryDate: '2026-10-20',
      warehouseId: CUSTOMER,
      shippingAddressId: ADDRESS,
      note: '',
      lines: [
        {
          variantId: VARIANT,
          unitId: UNIT,
          quantity: '20',
          description: '',
          unitPrice: '120',
          discountType: 'percent',
          discount: '',
          taxRateId: RATE,
        },
      ],
      // A device cannot confirm: the field is dropped, not obeyed
      confirm: true,
    };
    const command = { id: COMMAND, type: 'sales_order.create_draft', orderId: ORDER };
    expect(errorsOf(salesOrderDraftCommandSchema.safeParse({ ...command, input: order }))).toEqual({
      'input.deliveryDate': 'order_delivery_date',
    });
    const parsed = salesOrderDraftCommandSchema.parse({
      ...command,
      input: { ...order, deliveryDate: '' },
    });
    expect(parsed.input).not.toHaveProperty('confirm');
  });
});

describe('push', () => {
  it('takes a command it cannot read, so the server can refuse that one alone', () => {
    const command: SyncCommandInput = {
      id: COMMAND,
      type: 'customer.create',
      customerId: CUSTOMER,
      input: newCustomer(),
    };
    // A command the device made fits what the request takes, as a type too
    const commands: SyncPushInput['commands'] = [command, { id: ORDER, type: 'sale.refund' }];
    const input = syncPushInputSchema.parse({ deviceId: CUSTOMER, protocol: 1, commands });
    expect(input.commands[0]).toEqual(command);
    expect(syncCommandSchema.safeParse(input.commands[1]).success).toBe(false);
  });

  it('sends at most 50 commands, and at least one', () => {
    const commands = Array.from({ length: 51 }, () => ({ id: COMMAND, type: 'customer.create' }));
    expect(
      syncPushInputSchema.safeParse({ deviceId: CUSTOMER, protocol: 1, commands }).success,
    ).toBe(false);
    expect(
      syncPushInputSchema.safeParse({ deviceId: CUSTOMER, protocol: 1, commands: [] }).success,
    ).toBe(false);
  });

  it('answers each command: accepted with its rows and notices, or refused with its error', () => {
    const answer = syncPushSchema.parse({
      results: [
        {
          id: COMMAND,
          status: 'accepted',
          notices: [{ code: 'kept_server_value', fields: ['creditLimit'] }],
          changes: [],
        },
        {
          id: ORDER,
          status: 'rejected',
          error: { code: 'customer_code_taken', fieldErrors: { code: ['customer_code_taken'] } },
        },
      ],
      serverTime: AT,
    });
    const [accepted, rejected] = answer.results;
    expect(accepted?.status === 'accepted' && accepted.notices[0]?.fields).toEqual(['creditLimit']);
    expect(rejected?.status === 'rejected' && rejected.error.code).toBe('customer_code_taken');
  });
});

// ---------------------------------------------------------------------------------------------
// The POS (step 20a)

describe('POS on the device', () => {
  const register = {
    id: ORDER,
    code: 'POS1',
    name: 'Front counter',
    branchId: CUSTOMER,
    warehouseId: WAREHOUSE,
    accounts: { cash: RATE, card: null, bkash: null, nagad: null },
    maxDiscountPercent: '10.00',
    paperWidth: '58',
    receiptFooter: null,
    deviceId: COMMAND,
    lastNumber: 122,
    archivedAt: null,
    version: 4,
    updatedAt: AT,
  };

  it('keeps a register without its last number, which changes with every sale', () => {
    const change = syncUpsertSchema.parse({
      op: 'upsert',
      entity: 'pos_register',
      key: ORDER,
      data: register,
    });
    expect(change.entity === 'pos_register' && change.data.code).toBe('POS1');
    expect(change.data).not.toHaveProperty('lastNumber');
  });

  it('sends a sale under an id the device made, and refuses one of another kind', () => {
    const input = {
      registerId: ORDER,
      sequence: 123,
      date: '2026-10-27',
      soldAt: AT,
      customerId: null,
      pricesIncludeVat: true,
      lines: [
        {
          variantId: VARIANT,
          unitId: UNIT,
          quantity: '10',
          description: '',
          unitPrice: '12',
          discountType: 'percent',
          discount: '',
          taxRateId: RATE,
          rate: '0.00',
          startingPrice: '12.0000',
          batchId: BATCH,
          serialNumbers: [],
        },
      ],
      billDiscountType: 'percent',
      billDiscount: '',
      payments: [{ method: 'cash', amount: '120', reference: '' }],
    };
    const command = { id: COMMAND, type: 'pos_sale.create', saleId: CUSTOMER, input };
    expect(syncCommandSchema.parse(command).type).toBe('pos_sale.create');
    expect(errorsOf(posSaleCommandSchema.safeParse({ ...command, saleId: V4 }))).toEqual({
      saleId: 'Invalid UUID',
    });
  });
});
