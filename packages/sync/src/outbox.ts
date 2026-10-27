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

import type { LocalCopy } from './copy.js';
import type { OutboxEntry, OutboxRow } from './database.js';
import { openEntries, openEntry, sealEntry } from './sealed.js';

// Saving work done on the device as commands (step 18b), and the outbox's own changes: retry,
// discard. No Dexie import: everything goes through the copy the session opened, so the forms
// that save here stay small (see index.ts).
//
// Step 19b: the commands are sealed, and a transaction cannot wait for Web Crypto. So a save opens
// what it needs first, seals what it writes, and only then starts the transaction, which decides on
// the clear fields (status, sent, the command's id) alone.

// saved: in the outbox. unchanged: the form holds what the customer already has, so nothing is
// sent. busy: the command is on its way to the server, or was sent without an answer, so it
// cannot be changed now (decision 33).
export type SaveResult = 'saved' | 'unchanged' | 'busy';

// A command the server certainly never ran: it was refused, or never sent. Only these may be
// rewritten. A sent command without an answer may have run (the answer was lost), so it is sent
// again as it is, and a change after it is a command of its own.
export function isOpen(entry: Pick<OutboxEntry, 'status' | 'sent'>): boolean {
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

// What saveCustomer writes, worked out from the customer's entries, opened
interface CustomerWrites {
  deletes: number[];
  // With a seq: written in that entry's place. Without: added at the end.
  put: OutboxEntry | null;
  result: SaveResult;
}

// A new customer, or a change to one (decision 33). The customer's open commands (never sent, or
// refused) are folded into the first of them, which keeps its place in the outbox: an order on
// this device for a new customer stays behind that customer's create. The folded command gets a
// new id: a refused id is answered from what the server kept (decision 10).
function customerWrites(
  entries: readonly OutboxEntry[],
  save: CustomerSave,
  customerId: string,
): CustomerWrites {
  const open = entries.filter(
    (entry) => entry.command.type !== 'sales_order.create_draft' && isOpen(entry),
  );
  const [first, ...rest] = open;
  const folded = rest.flatMap((entry) => entry.seq ?? []);
  const fields = { customerId, key: customerId, name: save.input.name, savedAt: save.savedAt };
  if (first?.seq !== undefined) {
    // A create stays a create, with what the form holds now. A change is worked out again from
    // the first change's base, so its `from` values stay the ones the person first saw.
    const base = first.base ?? save.base;
    const command =
      first.command.type === 'customer.create'
        ? createCommand(customerId, save.input)
        : base && updateCommand(base, save.input);
    // Changed back to what the customer has: nothing is left to send
    if (command === null) return { deletes: [...folded, first.seq], put: null, result: 'saved' };
    return {
      deletes: folded,
      put: { ...entryOf(command, { ...fields, base: first.base }), seq: first.seq },
      result: 'saved',
    };
  }
  if (save.base === null) {
    return {
      deletes: [],
      put: entryOf(createCommand(customerId, save.input), { ...fields, base: null }),
      result: 'saved',
    };
  }
  const command = updateCommand(save.base, save.input);
  if (command === null) return { deletes: [], put: null, result: 'unchanged' };
  return { deletes: [], put: entryOf(command, { ...fields, base: save.base }), result: 'saved' };
}

// What a customer's commands are, in short: a save writes only if they are still the ones it
// opened. Every rewrite gives a command a new id, and a push changes the status.
function stateOf(rows: readonly OutboxRow[]): string {
  return rows
    .map((row) => `${String(row.seq)}:${row.commandId}:${row.status}:${String(row.sent)}`)
    .join(',');
}

const SAVE_ATTEMPTS = 3;

// Opened, worked out and sealed outside the transaction; written only if no one changed this
// customer's commands in between (another tab saved, the push took them). Then it starts again
// from what is there now. Three times in a row would take three saves racing on one customer.
export async function saveCustomer(copy: LocalCopy, save: CustomerSave): Promise<SaveResult> {
  const { db } = copy;
  const customerId = save.base?.id ?? uuidv7();
  const rowsOf = () => db.outbox.where('customerId').equals(customerId).sortBy('seq');
  for (let attempt = 1; ; attempt += 1) {
    const rows = await rowsOf();
    const writes = customerWrites(await openEntries(copy, rows), save, customerId);
    const row = writes.put && (await sealEntry(copy, writes.put));
    const written = await db.transaction('rw', db.outbox, async () => {
      if (stateOf(await rowsOf()) !== stateOf(rows)) return false;
      await db.outbox.bulkDelete(writes.deletes);
      // put: in the first entry's place when it has a seq, else at the end (auto-increment)
      if (row) await db.outbox.put(row);
      return true;
    });
    if (written) return writes.result;
    if (attempt === SAVE_ATTEMPTS) throw new Error('The outbox kept changing during the save');
  }
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
// nothing after it, and its customer may now be one added on this device after it. The new entry
// does not depend on the old one, so it is sealed first, and the transaction only checks the old
// one's clear fields.
export async function saveOrderDraft(copy: LocalCopy, save: OrderSave): Promise<SaveResult> {
  const { db } = copy;
  const orderId = save.orderId ?? uuidv7();
  const row = await sealEntry(
    copy,
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
  return db.transaction('rw', db.outbox, async () => {
    const [old] = await db.outbox.where('key').equals(orderId).toArray();
    if (old && !isOpen(old)) return 'busy';
    if (old?.seq !== undefined) await db.outbox.delete(old.seq);
    await db.outbox.add(row);
    return 'saved';
  });
}

// ---------------------------------------------------------------------------------------------
// The Sync page

// The later commands on the same customer
function later<E extends Pick<OutboxEntry, 'seq' | 'customerId'>>(
  items: readonly E[],
  item: E,
): E[] {
  const { seq } = item;
  if (seq === undefined) return [];
  return items.filter((other) => other.customerId === item.customerId && (other.seq ?? 0) > seq);
}

// What goes with an entry when it is discarded: a new customer takes every later command on that
// customer (its changes and its orders), which the server could only refuse without it. A change
// or an order goes alone.
export function dependentsOf(entries: readonly OutboxEntry[], entry: OutboxEntry): OutboxEntry[] {
  return entry.command.type === 'customer.create' ? later(entries, entry) : [];
}

// Discard: the entry and its dependents leave the device and never reach the server. A command
// being sent is left alone (busy); the page offers Discard again once it has its answer. The
// clear fields say all of it: nothing is opened.
export async function discardEntry(copy: LocalCopy, seq: number): Promise<SaveResult> {
  const { db } = copy;
  return db.transaction('rw', db.outbox, async () => {
    const row = await db.outbox.get(seq);
    if (!row) return 'unchanged';
    if (row.status === 'sending') return 'busy';
    const others = await db.outbox.where('customerId').equals(row.customerId).toArray();
    const gone = [row, ...(row.type === 'customer.create' ? later(others, row) : [])].filter(
      (item) => item.status !== 'sending',
    );
    await db.outbox.bulkDelete(gone.flatMap((item) => item.seq ?? []));
    return 'saved';
  });
}

// Retry a refused command as it is, under a new id (the old id's refusal is kept on the server).
// For a refusal that was not the command's fault: a permission given back, a code freed. Opened
// and sealed again first; written only if it is still the same refused command.
export async function retryEntry(copy: LocalCopy, seq: number): Promise<SaveResult> {
  const { db } = copy;
  const row = await db.outbox.get(seq);
  if (row?.status !== 'failed') return 'unchanged';
  const entry = await openEntry(copy, row);
  const next = await sealEntry(copy, {
    ...entry,
    command: { ...entry.command, id: uuidv7() },
    status: 'waiting',
    sent: false,
    error: null,
  });
  return db.transaction('rw', db.outbox, async () => {
    const now = await db.outbox.get(seq);
    // Discarded, edited or retried meanwhile (another tab): this retry is out of date
    if (now?.status !== 'failed' || now.commandId !== row.commandId) return 'unchanged';
    await db.outbox.put(next);
    return 'saved';
  });
}

export async function dismissNotice(copy: LocalCopy, commandId: string): Promise<void> {
  await copy.db.notices.delete(commandId);
}
