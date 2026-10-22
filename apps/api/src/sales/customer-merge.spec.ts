import type { CustomerAddressChanges, CustomerChanges } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import { AppError } from '../common/http/app-error.js';
import type { CustomerWithoutBalance } from './customer-read.js';
import { type CurrentAddress, mergeAddresses, mergeCustomer } from './customer-merge.js';

const dealerList = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c30';
const retailList = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c31';
const pharmacyGroup = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c32';
const billing = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c40';
const depot = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c41';
const godown = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c42';
const added = '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c43';

// Karim Store as the server has it now: the API's shape, the `from` values come in this shape
const now: CustomerWithoutBalance = {
  id: '0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2c3d',
  code: 'C-00007',
  name: 'Karim Store',
  groupId: null,
  contactPerson: 'Abdul Karim',
  phone: '01711-000000',
  email: null,
  documentLanguage: 'bn',
  bin: null,
  paymentTermsDays: 30,
  creditLimit: '50000.0000',
  priceListId: dealerList,
  notes: null,
  addresses: [],
  isSupplier: false,
  archivedAt: null,
  version: 4,
  updatedAt: '2026-10-21T04:00:00.000Z',
};

// And its addresses as the table keeps them: the billing one first, then two shipping ones
const addresses: CurrentAddress[] = [
  { id: billing, kind: 'billing', label: null, address: 'Bazar Road, Narsingdi', phone: null },
  { id: depot, kind: 'shipping', label: 'Depot', address: 'Station Road, Bhairab', phone: null },
  { id: godown, kind: 'shipping', label: 'Godown', address: 'Ghat Road, Narsingdi', phone: '017' },
];

const noAddressChanges: CustomerAddressChanges = { add: [], remove: [], change: [] };

function merge(changes: CustomerChanges, addressChanges = noAddressChanges) {
  return mergeCustomer(now, addresses, { changes, addresses: addressChanges });
}

// The refusal a merge throws, as the push would put it in the answer
function refusalOf(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return { code: error.code, ...error.options };
    throw error;
  }
  throw new Error('the merge did not refuse');
}

describe('mergeCustomer: the fields', () => {
  it('keeps the server customer as it is when nothing changed', () => {
    const { input, kept } = merge({});
    expect(kept).toEqual([]);
    expect(input).toEqual({
      code: 'C-00007',
      name: 'Karim Store',
      groupId: null,
      contactPerson: 'Abdul Karim',
      phone: '01711-000000',
      email: null,
      documentLanguage: 'bn',
      bin: null,
      paymentTermsDays: 30,
      creditLimit: '50000.0000',
      priceListId: dealerList,
      notes: null,
      addresses,
    });
  });

  it('takes the device value of an ordinary field, even one the server changed since', () => {
    // The device read "01700-000000"; the server has another number now. The later arrival wins.
    const { input, kept } = merge({
      phone: { from: '01700-000000', to: '01811-111111' },
      name: { from: 'Karim Store', to: 'Karim General Store' },
      notes: { from: null, to: 'Pays on Thursdays' },
    });
    expect(kept).toEqual([]);
    expect(input).toMatchObject({
      phone: '01811-111111',
      name: 'Karim General Store',
      notes: 'Pays on Thursdays',
      contactPerson: 'Abdul Karim',
    });
  });

  it('takes a head-office field the server did not change since the device read it', () => {
    const { input, kept } = merge({
      creditLimit: { from: '50000.0000', to: '75000' },
      paymentTermsDays: { from: 30, to: 45 },
    });
    expect(kept).toEqual([]);
    expect(input).toMatchObject({ creditLimit: '75000', paymentTermsDays: 45 });
  });

  it('keeps each head-office field the server changed, and takes the rest of the command', () => {
    const { input, kept } = merge({
      creditLimit: { from: '40000.0000', to: '90000' },
      paymentTermsDays: { from: 15, to: 60 },
      priceListId: { from: retailList, to: null },
      groupId: { from: pharmacyGroup, to: pharmacyGroup },
      phone: { from: '01711-000000', to: '01811-111111' },
    });
    // In the order of the fields, the order the notice lists them in
    expect(kept).toEqual(['groupId', 'paymentTermsDays', 'creditLimit', 'priceListId']);
    expect(input).toMatchObject({
      creditLimit: '50000.0000',
      paymentTermsDays: 30,
      priceListId: dealerList,
      groupId: null,
      phone: '01811-111111',
    });
  });

  it('does not keep a head-office field the server changed and then changed back', () => {
    // Only the value counts, not its history: 50,000 → 80,000 → 50,000 is still what the device read
    const { input, kept } = merge({ creditLimit: { from: '50000.0000', to: null } });
    expect(kept).toEqual([]);
    expect(input.creditLimit).toBeNull();
  });

  it('compares a limit as the API sends it, so a limit typed another way is changed on the server', () => {
    // "50000" is what the form sends, not what the API sends: the server reads it as changed
    const { kept } = merge({ creditLimit: { from: '50000', to: '60000' } });
    expect(kept).toEqual(['creditLimit']);
  });

  it('clears a field the device cleared', () => {
    const { input } = merge({
      contactPerson: { from: 'Abdul Karim', to: null },
      priceListId: { from: dealerList, to: null },
    });
    expect(input).toMatchObject({ contactPerson: null, priceListId: null });
  });
});

describe('mergeAddresses', () => {
  it('adds an address at the end, with the id the device made', () => {
    const merged = mergeAddresses(addresses, {
      ...noAddressChanges,
      add: [
        { id: added, kind: 'shipping', label: null, address: 'College Road, Bhairab', phone: null },
      ],
    });
    expect(merged.map((address) => address.id)).toEqual([billing, depot, godown, added]);
  });

  it('removes an address, and ignores one the server removed already', () => {
    const merged = mergeAddresses(addresses, { ...noAddressChanges, remove: [depot, added] });
    expect(merged.map((address) => address.id)).toEqual([billing, godown]);
  });

  it('changes only the fields sent, and clears a field sent as null', () => {
    const merged = mergeAddresses(addresses, {
      ...noAddressChanges,
      change: [
        { id: depot, phone: '01911-222222' },
        { id: godown, label: null },
      ],
    });
    expect(merged[1]).toEqual({
      id: depot,
      kind: 'shipping',
      label: 'Depot',
      address: 'Station Road, Bhairab',
      phone: '01911-222222',
    });
    // Not the old "Godown": `?? old` would have put it back
    expect(merged[2]).toMatchObject({ id: godown, label: null, phone: '017' });
  });

  it('drops a change of an address the server removed, without an error', () => {
    const removedOnServer = addresses.filter((address) => address.id !== depot);
    const merged = mergeAddresses(removedOnServer, {
      ...noAddressChanges,
      change: [{ id: depot, address: 'New Station Road, Bhairab' }],
    });
    expect(merged.map((address) => address.id)).toEqual([billing, godown]);
  });

  it('lets the device move the billing address: the old one removed, a new one added', () => {
    const merged = mergeAddresses(addresses, {
      add: [
        { id: added, kind: 'billing', label: null, address: 'Court Road, Narsingdi', phone: null },
      ],
      remove: [billing],
      change: [],
    });
    expect(merged.filter((address) => address.kind === 'billing').map((a) => a.id)).toEqual([
      added,
    ]);
  });

  it('refuses an added id the customer has already', () => {
    expect(
      refusalOf(() =>
        mergeAddresses(addresses, {
          ...noAddressChanges,
          add: [{ id: godown, kind: 'shipping', label: null, address: 'Ghat Road', phone: null }],
        }),
      ),
    ).toEqual({
      code: 'sync_id_taken',
      fieldErrors: { [`addresses.${godown}`]: ['sync_id_taken'] },
    });
  });

  it('refuses a second billing address, on the address this change made', () => {
    expect(
      refusalOf(() =>
        mergeAddresses(addresses, {
          ...noAddressChanges,
          add: [{ id: added, kind: 'billing', label: null, address: 'Court Road', phone: null }],
        }),
      ),
    ).toEqual({
      code: 'customer_billing_twice',
      fieldErrors: { [`addresses.${added}.kind`]: ['customer_billing_twice'] },
    });
    // A shipping address turned into a billing one: the error is on that one, not on the server's
    expect(
      refusalOf(() =>
        mergeAddresses(addresses, {
          ...noAddressChanges,
          change: [{ id: godown, kind: 'billing' }],
        }),
      ),
    ).toMatchObject({ fieldErrors: { [`addresses.${godown}.kind`]: ['customer_billing_twice'] } });
  });

  it('refuses more addresses than a customer may have, counted after the merge', () => {
    const many = Array.from({ length: 18 }, (_, n) => ({
      id: `0199a3c2-5f1e-7c3a-9b2d-4e8f6a1b2d${String(n).padStart(2, '0')}`,
      kind: 'shipping' as const,
      label: null,
      address: `Shop ${String(n + 1)}, Bazar Road`,
      phone: null,
    }));
    // 3 + 17 = 20 is fine, 3 + 18 is one too many, and 3 − 1 + 18 is fine again
    expect(mergeAddresses(addresses, { ...noAddressChanges, add: many.slice(1) })).toHaveLength(20);
    expect(refusalOf(() => mergeAddresses(addresses, { ...noAddressChanges, add: many }))).toEqual({
      code: 'too_long',
      fieldErrors: { addresses: ['too_long'] },
    });
    expect(mergeAddresses(addresses, { add: many, remove: [godown], change: [] })).toHaveLength(20);
  });

  it('merges the addresses of a whole customer change too', () => {
    const { input } = merge(
      { phone: { from: '01711-000000', to: '01811-111111' } },
      { add: [], remove: [godown], change: [{ id: depot, label: 'Bhairab depot' }] },
    );
    expect(input.addresses).toEqual([addresses[0], { ...addresses[1], label: 'Bhairab depot' }]);
  });
});
