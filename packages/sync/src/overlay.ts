import type {
  CustomerAddress,
  CustomerAddressChanges,
  CustomerChanges,
  SyncCustomer,
  SyncCustomerInput,
} from '@omnivo/contracts';

import type { OutboxEntry } from './database.js';

// A customer as it will be once the outbox reaches the server (decision 34): the server's row on
// the device, with the waiting commands applied on top, in their order. The rows in the database
// are never changed: they stay the server's, and a pull keeps them right. Pure functions, so the
// specs check them without a database.

// The server's order: the billing address first, then the shipping ones as they were put.
// Array.prototype.sort is stable, so the shipping ones keep their order.
function billingFirst(addresses: CustomerAddress[]): CustomerAddress[] {
  return addresses.sort((a, b) => Number(b.kind === 'billing') - Number(a.kind === 'billing'));
}

// A customer.create as a row. The code is '' until the server gives the next number (decision
// 16); the version is 0, which no server row has.
export function createdCustomer(
  customerId: string,
  input: SyncCustomerInput,
  savedAt: string,
): SyncCustomer {
  return {
    id: customerId,
    code: input.code ?? '',
    name: input.name,
    groupId: input.groupId,
    contactPerson: input.contactPerson,
    phone: input.phone,
    email: input.email,
    documentLanguage: input.documentLanguage,
    bin: input.bin,
    paymentTermsDays: input.paymentTermsDays,
    creditLimit: input.creditLimit,
    priceListId: input.priceListId,
    notes: input.notes,
    // In the order typed, not billing first: a refusal names an address of a new customer by its
    // place in the command (decision 22), and the form that opens it must have it in that place
    addresses: input.addresses.map((address) => ({
      id: address.id,
      kind: address.kind,
      label: address.label,
      address: address.address,
      phone: address.phone,
    })),
    isSupplier: false,
    archivedAt: null,
    version: 0,
    updatedAt: savedAt,
  };
}

// A changed field's new value, or the current one when the field did not change. `to` may be null
// (a phone taken away), so `??` would be wrong here.
function valueOf<T>(change: { to: T } | undefined, current: T): T {
  return change === undefined ? current : change.to;
}

function changedAddresses(
  current: readonly CustomerAddress[],
  changes: CustomerAddressChanges,
): CustomerAddress[] {
  const removed = new Set(changes.remove);
  const kept = current
    .filter((address) => !removed.has(address.id))
    .map((address) => {
      const change = changes.change.find((item) => item.id === address.id);
      if (!change) return address;
      // A field the change does not name is undefined; a label taken away is null
      return {
        id: address.id,
        kind: change.kind ?? address.kind,
        label: change.label === undefined ? address.label : change.label,
        address: change.address ?? address.address,
        phone: change.phone === undefined ? address.phone : change.phone,
      };
    });
  const added = changes.add.map((address) => ({
    id: address.id,
    kind: address.kind,
    label: address.label,
    address: address.address,
    phone: address.phone,
  }));
  return billingFirst([...kept, ...added]);
}

// A customer.update on a row. The code: an empty box keeps the code the customer has.
export function changedCustomer(
  row: SyncCustomer,
  changes: CustomerChanges,
  addresses: CustomerAddressChanges,
): SyncCustomer {
  return {
    ...row,
    code: valueOf(changes.code, row.code) ?? row.code,
    name: valueOf(changes.name, row.name),
    groupId: valueOf(changes.groupId, row.groupId),
    contactPerson: valueOf(changes.contactPerson, row.contactPerson),
    phone: valueOf(changes.phone, row.phone),
    email: valueOf(changes.email, row.email),
    documentLanguage: valueOf(changes.documentLanguage, row.documentLanguage),
    bin: valueOf(changes.bin, row.bin),
    paymentTermsDays: valueOf(changes.paymentTermsDays, row.paymentTermsDays),
    creditLimit: valueOf(changes.creditLimit, row.creditLimit),
    priceListId: valueOf(changes.priceListId, row.priceListId),
    notes: valueOf(changes.notes, row.notes),
    addresses: changedAddresses(row.addresses, addresses),
  };
}

// The row the screens show: `row` is the server's (null when the device does not have it), and
// `entries` the outbox in seq order; the ones of other customers and the orders are passed over.
// null = no such customer on this device.
export function projectCustomer(
  customerId: string,
  row: SyncCustomer | null,
  entries: readonly OutboxEntry[],
): SyncCustomer | null {
  let current = row;
  for (const entry of entries) {
    const { command } = entry;
    if (command.type === 'customer.create' && command.customerId === customerId) {
      current = createdCustomer(customerId, command.input, entry.savedAt);
    } else if (command.type === 'customer.update' && command.customerId === customerId) {
      // A change to a customer the device no longer has (archived on the server meanwhile): it
      // is still sent, and the server answers it (sync_customer_gone)
      if (current !== null) current = changedCustomer(current, command.changes, command.addresses);
    }
  }
  return current;
}
