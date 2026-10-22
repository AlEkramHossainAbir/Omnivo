import {
  type AddressKind,
  type CustomerAddressChanges,
  type CustomerChanges,
  type CustomerField,
  type CustomerInput,
  MAX_CUSTOMER_ADDRESSES,
  SERVER_WINS_CUSTOMER_FIELDS,
} from '@omnivo/contracts';

import { AppError } from '../common/http/app-error.js';
import type { CustomerWithoutBalance } from './customer-read.js';

// An address as the table keeps it, with its kind typed (the API's customer has it as a string)
export interface CurrentAddress {
  id: string;
  kind: AddressKind;
  label: string | null;
  address: string;
  phone: string | null;
}

// Step 18b: a change made on a device, merged into the customer as the server has it now. Pure,
// so the rules are tested without a database (customer-merge.spec.ts); CustomersService locks
// the customer, reads it, calls this, and saves the result like a save from the form.
export interface MergedCustomer {
  // The customer to save, as the form would send it
  input: CustomerInput;
  // The head-office fields the server kept (the kept_server_value notice)
  kept: CustomerField[];
}

const SERVER_WINS: ReadonlySet<CustomerField> = new Set(SERVER_WINS_CUSTOMER_FIELDS);

export function mergeCustomer(
  now: CustomerWithoutBalance,
  addresses: CurrentAddress[],
  command: { changes: CustomerChanges; addresses: CustomerAddressChanges },
): MergedCustomer {
  const { changes } = command;
  const kept: CustomerField[] = [];

  // One field. Not changed on the device: the server's value. A head-office field the server
  // changed since the device read it (its value is no longer `from`): the server's value, and the
  // field is named in the answer. Anything else: the device's value, whatever the server had —
  // the later arrival wins (decision 6). `From extends To`: every value the API sends for a field
  // is also a value the form may send, so the server's value fits the input as it is.
  function take<From extends To, To>(
    field: CustomerField,
    change: { from: From; to: To } | undefined,
    current: From,
  ): To {
    if (change === undefined) return current;
    if (SERVER_WINS.has(field) && change.from !== current) {
      kept.push(field);
      return current;
    }
    return change.to;
  }

  // Written out field by field, not in a loop over the keys: a loop loses each field's type
  const input: CustomerInput = {
    code: take('code', changes.code, now.code),
    name: take('name', changes.name, now.name),
    groupId: take('groupId', changes.groupId, now.groupId),
    contactPerson: take('contactPerson', changes.contactPerson, now.contactPerson),
    phone: take('phone', changes.phone, now.phone),
    email: take('email', changes.email, now.email),
    documentLanguage: take('documentLanguage', changes.documentLanguage, now.documentLanguage),
    bin: take('bin', changes.bin, now.bin),
    paymentTermsDays: take('paymentTermsDays', changes.paymentTermsDays, now.paymentTermsDays),
    creditLimit: take('creditLimit', changes.creditLimit, now.creditLimit),
    priceListId: take('priceListId', changes.priceListId, now.priceListId),
    notes: take('notes', changes.notes, now.notes),
    addresses: mergeAddresses(addresses, command.addresses),
  };
  return { input, kept };
}

// The addresses, one by one, by id (decision 4). Removed: gone, if the server still has it.
// Changed: only the fields sent, on an address the server still has; one the server removed in
// the meantime stays removed (the removal was a person's decision too, decision 14). Added: at
// the end, with the device's id. Then the form's two rules again, on the merged list: two changes
// that are each fine can together give two billing addresses, or more than 20.
export function mergeAddresses(
  current: CurrentAddress[],
  changes: CustomerAddressChanges,
): CustomerInput['addresses'] {
  const removed = new Set(changes.remove);
  const changed = new Map(changes.change.map((change) => [change.id, change]));
  const own = new Set(current.map((address) => address.id));
  const taken = changes.add.find((address) => own.has(address.id));
  if (taken) throw idTaken(taken.id);

  // Every id is known here: the server's, or the device's for an added one
  const merged: (CustomerInput['addresses'][number] & { id: string })[] = [
    ...current
      .filter((address) => !removed.has(address.id))
      .map((address) => {
        const change = changed.get(address.id);
        // A field left out of the change is undefined; a field cleared on the device is null
        return {
          id: address.id,
          kind: change?.kind ?? address.kind,
          label: change?.label === undefined ? address.label : change.label,
          address: change?.address ?? address.address,
          phone: change?.phone === undefined ? address.phone : change.phone,
        };
      }),
    ...changes.add,
  ];

  if (merged.length > MAX_CUSTOMER_ADDRESSES) {
    throw new AppError(409, 'too_long', 'This customer would have too many addresses.', {
      fieldErrors: { addresses: ['too_long'] },
    });
  }
  const billing = merged.filter((address) => address.kind === 'billing');
  const second = billing[1];
  if (second !== undefined) {
    // The error sits on a billing address this change made, the one the person can fix in the
    // outbox; the other one was made on the server. Paths name an address by its id (decision 22).
    const touched = new Set([
      ...changes.add.map((address) => address.id),
      ...changes.change.flatMap((change) => (change.kind === undefined ? [] : [change.id])),
    ]);
    const { id } = billing.find((address) => touched.has(address.id)) ?? second;
    throw new AppError(409, 'customer_billing_twice', 'A customer has one billing address.', {
      fieldErrors: { [`addresses.${id}.kind`]: ['customer_billing_twice'] },
    });
  }
  return merged;
}

function idTaken(id: string): AppError {
  return new AppError(409, 'sync_id_taken', 'An id made on the device is already used.', {
    fieldErrors: { [`addresses.${id}`]: ['sync_id_taken'] },
  });
}
