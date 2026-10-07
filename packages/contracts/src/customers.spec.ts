import { describe, expect, it } from 'vitest';

import { type CustomerFormValues, customerInputSchema } from './customers.js';
import { setPriceListItemsInputSchema } from './price-lists.js';

function customer(extra: Partial<CustomerFormValues> = {}): CustomerFormValues {
  return {
    code: '',
    name: 'Rahman Traders',
    groupId: '',
    contactPerson: '',
    phone: '01711-000000',
    email: '',
    bin: '',
    paymentTermsDays: 30,
    creditLimit: '',
    priceListId: '',
    notes: '',
    addresses: [],
    ...extra,
  };
}

describe('customer input', () => {
  it('reads empty boxes as "not set": no code, no group, no limit', () => {
    expect(customerInputSchema.parse(customer())).toMatchObject({
      code: null,
      groupId: null,
      email: null,
      bin: null,
      creditLimit: null,
      priceListId: null,
    });
  });

  it('keeps a credit limit of zero: cash only is a real limit', () => {
    expect(customerInputSchema.parse(customer({ creditLimit: '0' })).creditLimit).toBe('0');
  });

  it('refuses a second billing address, on the second one', () => {
    const address = {
      id: null,
      kind: 'billing',
      label: '',
      address: 'House 12, Road 3, Mirpur',
      phone: '',
    } as const;
    const result = customerInputSchema.safeParse(
      customer({ addresses: [address, { ...address, kind: 'shipping' }, address] }),
    );
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['addresses', 2, 'kind'],
        message: 'customer_billing_twice',
      }),
    ]);
  });

  it('cleans a BIN typed with hyphens, and refuses a short one', () => {
    expect(customerInputSchema.parse(customer({ bin: '000123456-0101' })).bin).toBe(
      '0001234560101',
    );
    expect(
      customerInputSchema.safeParse(customer({ bin: '12345' })).error?.issues[0]?.message,
    ).toBe('bin_format');
  });
});

describe('price list changes', () => {
  const variant = '01939d1c-0000-7000-8000-000000000001';
  const carton = '01939d1c-0000-7000-8000-000000000002';
  const piece = '01939d1c-0000-7000-8000-000000000003';

  it('reads an empty price as "take it out of the list"', () => {
    const parsed = setPriceListItemsInputSchema.parse({
      changes: [
        { variantId: variant, unitId: piece, price: '' },
        { variantId: variant, unitId: carton, price: '2150' },
      ],
    });
    expect(parsed.changes.map((change) => change.price)).toEqual([null, '2150']);
  });

  it('refuses the same item and unit twice in one save', () => {
    const change = { variantId: variant, unitId: carton, price: '2150' };
    const result = setPriceListItemsInputSchema.safeParse({ changes: [change, change] });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['changes', 1, 'price'], message: 'price_list_item_twice' }),
    ]);
  });
});
