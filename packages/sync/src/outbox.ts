import {
  compareMoney,
  type CustomerAddress,
  type CustomerAddressChanges,
  type CustomerChanges,
  type CustomerInput,
  type SalesOrderDraftInput,
  type SyncCommand,
  type SyncCustomer,
} from '@omnivo/contracts';
import { uuidv7 } from 'uuidv7';

import type { OutboxEntry, SyncDatabase } from './database.js';

// Saving work done on the device as commands (step 18b), and the outbox's own changes: retry,
// discard. No Dexie import: everything goes through the database the session opened, so the
// forms that save here stay small (see index.ts).

// saved: in the outbox. unchanged: the form holds what the customer already has, so nothing is
// sent. busy: the command is on its way to the server, or was sent without an answer, so it
// cannot be changed now (decision 33).
export type SaveResult = 'saved' | 'unchanged' | 'busy';

// A command the server certainly never ran: it was refused, or never sent. Only these may be
// rewritten. A sent command without an answer may have run (the answer was lost), so it is sent
// again as it is, and a change after it is a command of its own.
export function isOpen(entry: OutboxEntry): boolean {
  return entry.status === 'failed' || (entry.status === 'waiting' && !entry.sent);
}

// ---------------------------------------------------------------------------------------------
// What changed

function sameMoney(a: string | null, b: string | null): boolean {
  return a === null || b === null ? a === b : compareMoney(a, b) === 0;
}

// Only the fields that differ from what the person started from (decision 6): `from` as the
// device had it, `to` as the form sends it. The credit limit compares as money: "200000" is the
// "200000.0000" the API sent, not a change.
export function customerChangesOf(base: SyncCustomer, input: CustomerInput): CustomerChanges {
  return {
    ...(input.code !== base.code && { code: { from: base.code, to: input.code } }),
    ...(input.name !== base.name && { name: { from: base.name, to: input.name } }),
    ...(input.groupId !== base.groupId && { groupId: { from: base.groupId, to: input.groupId } }),
    ...(input.contactPerson !== base.contactPerson && {
      contactPerson: { from: base.contactPerson, to: input.contactPerson },
    }),
    ...(input.phone !== base.phone && { phone: { from: base.phone, to: input.phone } }),
    ...(input.email !== base.email && { email: { from: base.email, to: input.email } }),
    ...(input.documentLanguage !== base.documentLanguage && {
      documentLanguage: { from: base.documentLanguage, to: input.documentLanguage },
    }),
    ...(input.bin !== base.bin && { bin: { from: base.bin, to: input.bin } }),
    ...(input.paymentTermsDays !== base.paymentTermsDays && {
      paymentTermsDays: { from: base.paymentTermsDays, to: input.paymentTermsDays },
    }),
    ...(!sameMoney(input.creditLimit, base.creditLimit) && {
      creditLimit: { from: base.creditLimit, to: input.creditLimit },
    }),
    ...(input.priceListId !== base.priceListId && {
      priceListId: { from: base.priceListId, to: input.priceListId },
    }),
    ...(input.notes !== base.notes && { notes: { from: base.notes, to: input.notes } }),
  };
}

// The addresses one by one, by id (decision 4). An address without an id, or with an id the base
// does not have (one this device added in an earlier, still waiting change), is added with that
// id; an address of the base that the form no longer has is removed.
export function addressChangesOf(
  base: readonly CustomerAddress[],
  input: CustomerInput['addresses'],
): CustomerAddressChanges {
  const before = new Map(base.map((address) => [address.id, address]));
  const kept = new Set<string>();
  const changes: CustomerAddressChanges = { add: [], remove: [], change: [] };
  for (const address of input) {
    const old = address.id === null ? undefined : before.get(address.id);
    if (!old) {
      changes.add.push({ ...address, id: address.id ?? uuidv7() });
      continue;
    }
    kept.add(old.id);
    const fields = {
      ...(address.kind !== old.kind && { kind: address.kind }),
      ...(address.label !== old.label && { label: address.label }),
      ...(address.address !== old.address && { address: address.address }),
      ...(address.phone !== old.phone && { phone: address.phone }),
    };
    if (Object.keys(fields).length > 0) changes.change.push({ id: old.id, ...fields });
  }
  changes.remove = base.filter((address) => !kept.has(address.id)).map((address) => address.id);
  return changes;
}

function nothingChanged(changes: CustomerChanges, addresses: CustomerAddressChanges): boolean {
  return (
    Object.keys(changes).length === 0 &&
    addresses.add.length === 0 &&
    addresses.remove.length === 0 &&
    addresses.change.length === 0
  );
}

// ---------------------------------------------------------------------------------------------
// Saving

export interface CustomerSave {
  // The customer the form started from, as the screens showed it (the server's row with the
  // waiting changes on it); null = a new customer
  base: SyncCustomer | null;
  input: CustomerInput;
  // This device's clock, for the Sync page only
  savedAt: string;
}

function createCommand(customerId: string, input: CustomerInput): SyncCommand {
  return {
    id: uuidv7(),
    type: 'customer.create',
    customerId,
    // Every address gets the device's id now: an order on this device may point at it
    input: {
      ...input,
      addresses: input.addresses.map((address) => ({ ...address, id: address.id ?? uuidv7() })),
    },
  };
}

function updateCommand(base: SyncCustomer, input: CustomerInput): SyncCommand | null {
  const changes = customerChangesOf(base, input);
  const addresses = addressChangesOf(base.addresses, input.addresses);
  if (nothingChanged(changes, addresses)) return null;
  return {
    id: uuidv7(),
    type: 'customer.update',
    customerId: base.id,
    baseVersion: base.version,
    changes,
    addresses,
  };
}

function entryOf(
  command: SyncCommand,
  fields: Pick<OutboxEntry, 'customerId' | 'key' | 'base' | 'name' | 'savedAt'> &
    Partial<Pick<OutboxEntry, 'lines' | 'total'>>,
): OutboxEntry {
  return {
    command,
    status: 'waiting',
    sent: false,
    error: null,
    lines: null,
    total: null,
    ...fields,
  };
}

// A new customer, or a change to one (decision 33). The customer's open commands (never sent, or
// refused) are folded into the first of them, which keeps its place in the outbox: an order on
// this device for a new customer stays behind that customer's create. The folded command gets a
// new id: a refused id is answered from what the server kept (decision 10).
export async function saveCustomer(db: SyncDatabase, save: CustomerSave): Promise<SaveResult> {
  const customerId = save.base?.id ?? uuidv7();
  return db.transaction('rw', db.outbox, async () => {
    const entries = await db.outbox.where('customerId').equals(customerId).sortBy('seq');
    const open = entries.filter(
      (entry) => entry.command.type !== 'sales_order.create_draft' && isOpen(entry),
    );
    const [first, ...rest] = open;
    if (first?.seq !== undefined) {
      // A create stays a create, with what the form holds now. A change is worked out again from
      // the first change's base, so its `from` values stay the ones the person first saw.
      const base = first.base ?? save.base;
      const command =
        first.command.type === 'customer.create'
          ? createCommand(customerId, save.input)
          : base && updateCommand(base, save.input);
      await db.outbox.bulkDelete(
        rest.flatMap((entry) => (entry.seq === undefined ? [] : [entry.seq])),
      );
      if (command === null) {
        // Changed back to what the customer has: nothing is left to send
        await db.outbox.delete(first.seq);
        return 'saved';
      }
      await db.outbox.put({
        ...entryOf(command, {
          customerId,
          key: customerId,
          base: first.base,
          name: save.input.name,
          savedAt: save.savedAt,
        }),
        seq: first.seq,
      });
      return 'saved';
    }
    if (save.base === null) {
      await db.outbox.add(
        entryOf(createCommand(customerId, save.input), {
          customerId,
          key: customerId,
          base: null,
          name: save.input.name,
          savedAt: save.savedAt,
        }),
      );
      return 'saved';
    }
    const command = updateCommand(save.base, save.input);
    if (command === null) return 'unchanged';
    await db.outbox.add(
      entryOf(command, {
        customerId,
        key: customerId,
        base: save.base,
        name: save.input.name,
        savedAt: save.savedAt,
      }),
    );
    return 'saved';
  });
}

export interface OrderSave {
  // A waiting order opened again; null = a new one
  orderId: string | null;
  input: SalesOrderDraftInput;
  // The customer's name and the order's total, for the Sync page and the unsynced orders
  name: string;
  total: string;
  savedAt: string;
}

// A draft order (decision 15). Saved again, it goes to the end of the outbox: an order needs
// nothing after it, and its customer may now be one added on this device after it.
export async function saveOrderDraft(db: SyncDatabase, save: OrderSave): Promise<SaveResult> {
  const orderId = save.orderId ?? uuidv7();
  return db.transaction('rw', db.outbox, async () => {
    const [entry] = await db.outbox.where('key').equals(orderId).toArray();
    if (entry && !isOpen(entry)) return 'busy';
    if (entry?.seq !== undefined) await db.outbox.delete(entry.seq);
    await db.outbox.add(
      entryOf(
        { id: uuidv7(), type: 'sales_order.create_draft', orderId, input: save.input },
        {
          customerId: save.input.customerId,
          key: orderId,
          base: null,
          name: save.name,
          savedAt: save.savedAt,
          lines: save.input.lines.length,
          total: save.total,
        },
      ),
    );
    return 'saved';
  });
}

// ---------------------------------------------------------------------------------------------
// The Sync page

// What goes with an entry when it is discarded: a new customer takes every later command on that
// customer (its changes and its orders), which the server could only refuse without it. A change
// or an order goes alone.
export function dependentsOf(entries: readonly OutboxEntry[], entry: OutboxEntry): OutboxEntry[] {
  if (entry.command.type !== 'customer.create' || entry.seq === undefined) return [];
  const { seq } = entry;
  return entries.filter((other) => other.customerId === entry.customerId && (other.seq ?? 0) > seq);
}

// Discard: the entry and its dependents leave the device and never reach the server. A command
// being sent is left alone (busy); the page offers Discard again once it has its answer.
export async function discardEntry(db: SyncDatabase, seq: number): Promise<SaveResult> {
  return db.transaction('rw', db.outbox, async () => {
    const entry = await db.outbox.get(seq);
    if (!entry) return 'unchanged';
    if (entry.status === 'sending') return 'busy';
    const others = await db.outbox.where('customerId').equals(entry.customerId).toArray();
    const gone = [entry, ...dependentsOf(others, entry)].filter(
      (item) => item.status !== 'sending',
    );
    await db.outbox.bulkDelete(gone.flatMap((item) => (item.seq === undefined ? [] : [item.seq])));
    return 'saved';
  });
}

// Retry a refused command as it is, under a new id (the old id's refusal is kept on the server).
// For a refusal that was not the command's fault: a permission given back, a code freed.
export async function retryEntry(db: SyncDatabase, seq: number): Promise<SaveResult> {
  return db.transaction('rw', db.outbox, async () => {
    const entry = await db.outbox.get(seq);
    if (entry?.status !== 'failed') return 'unchanged';
    await db.outbox.put({
      ...entry,
      command: { ...entry.command, id: uuidv7() },
      status: 'waiting',
      sent: false,
      error: null,
    });
    return 'saved';
  });
}

export async function dismissNotice(db: SyncDatabase, commandId: string): Promise<void> {
  await db.notices.delete(commandId);
}
