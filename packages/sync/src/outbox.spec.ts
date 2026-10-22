import 'fake-indexeddb/auto';

import { syncCommandSchema } from '@omnivo/contracts';
import { describe, expect, it } from 'vitest';

import type { SyncDatabase } from './database.js';
import { discardEntry, retryEntry, saveCustomer, saveOrderDraft } from './outbox.js';
import { customer, customerInput, inputOf, newDatabase, orderDraft } from './test-fixtures.js';

const SAVED = '2026-10-21T15:00:00.000Z';
const VARIANT = '01928c4e-8888-7000-8000-000000000001';

const rahman = customer({
  name: 'Rahman Traders',
  code: 'C-00042',
  phone: '01711-234567',
  creditLimit: '200000.0000',
  addresses: [
    {
      id: '01928c4e-9999-7000-8000-000000000001',
      kind: 'billing',
      label: null,
      address: 'House 12, Road 7, Uttara, Dhaka',
      phone: null,
    },
  ],
});

async function entries(db: SyncDatabase) {
  return db.outbox.toArray();
}

async function only(db: SyncDatabase) {
  const [entry, ...more] = await entries(db);
  expect(more).toEqual([]);
  if (!entry) throw new Error('the outbox is empty');
  return entry;
}

describe('saveCustomer', () => {
  it('saves a new customer as a create, with the device’s ids, that the server reads as it is', async () => {
    const db = newDatabase();
    const input = customerInput({
      name: 'Tasnim Pharmacy',
      addresses: [
        { id: null, kind: 'billing', label: null, address: 'Agrabad, Chattogram', phone: null },
      ],
    });
    expect(await saveCustomer(db, { base: null, input, savedAt: SAVED })).toBe('saved');
    const entry = await only(db);
    expect(entry).toMatchObject({ status: 'waiting', sent: false, name: 'Tasnim Pharmacy' });
    if (entry.command.type !== 'customer.create') throw new Error('not a create');
    expect(entry.key).toBe(entry.command.customerId);
    expect(entry.command.input.addresses[0]?.id).toMatch(/^[0-9a-f-]{14}7/);
    // The outbox keeps the schema's output; the server parses it again and gets the same command
    expect(syncCommandSchema.parse(entry.command)).toEqual(entry.command);
  });

  it('sends only what changed, and a credit limit typed without decimals is no change', async () => {
    const db = newDatabase();
    const same = { ...inputOf(rahman), creditLimit: '200000' };
    expect(await saveCustomer(db, { base: rahman, input: same, savedAt: SAVED })).toBe('unchanged');
    expect(await entries(db)).toEqual([]);

    await saveCustomer(db, {
      base: rahman,
      input: { ...same, phone: '01819-000111' },
      savedAt: SAVED,
    });
    const entry = await only(db);
    if (entry.command.type !== 'customer.update') throw new Error('not an update');
    expect(entry.command.changes).toEqual({
      phone: { from: '01711-234567', to: '01819-000111' },
    });
    expect(entry.command.addresses).toEqual({ add: [], remove: [], change: [] });
    expect(entry.command.baseVersion).toBe(1);
    expect(syncCommandSchema.parse(entry.command)).toEqual(entry.command);
  });

  it('folds a second edit into the waiting change, with the first `from`, under a new id', async () => {
    const db = newDatabase();
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    const first = await only(db);
    // The form opens on the customer with the change on it, and changes the limit too
    const shown = { ...rahman, phone: '01819-000111' };
    await saveCustomer(db, {
      base: shown,
      input: { ...inputOf(shown), creditLimit: '250000' },
      savedAt: SAVED,
    });
    const second = await only(db);
    expect(second.seq).toBe(first.seq);
    expect(second.command.id).not.toBe(first.command.id);
    if (second.command.type !== 'customer.update') throw new Error('not an update');
    expect(second.command.changes).toEqual({
      phone: { from: '01711-234567', to: '01819-000111' },
      creditLimit: { from: '200000.0000', to: '250000' },
    });

    // Changed back to what the server has: nothing is left to send
    await saveCustomer(db, { base: shown, input: inputOf(rahman), savedAt: SAVED });
    expect(await entries(db)).toEqual([]);
  });

  it('adds a new change after one that was sent without an answer', async () => {
    const db = newDatabase();
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    const sent = await only(db);
    if (sent.seq === undefined) throw new Error('no seq');
    // It may have run on the server: it is never rewritten
    await db.outbox.update(sent.seq, { sent: true });
    const shown = { ...rahman, phone: '01819-000111' };
    await saveCustomer(db, {
      base: shown,
      input: { ...inputOf(shown), name: 'Rahman Traders Ltd' },
      savedAt: SAVED,
    });
    const [kept, added] = await entries(db);
    expect(kept?.command).toEqual(sent.command);
    if (added?.command.type !== 'customer.update') throw new Error('not an update');
    expect(added.command.changes).toEqual({
      name: { from: 'Rahman Traders', to: 'Rahman Traders Ltd' },
    });
  });

  it('turns a refused create, fixed, into a waiting create with a new id', async () => {
    const db = newDatabase();
    const input = customerInput({ name: 'Tasnim Pharmacy', code: 'C-00042' });
    await saveCustomer(db, { base: null, input, savedAt: SAVED });
    const refused = await only(db);
    if (refused.seq === undefined || refused.command.type !== 'customer.create') {
      throw new Error('not a create');
    }
    await db.outbox.update(refused.seq, {
      status: 'failed',
      sent: true,
      error: { code: 'customer_code_taken' },
    });
    const shown = { ...customer({ name: 'Tasnim Pharmacy', code: 'C-00042' }), id: refused.key };
    await saveCustomer(db, {
      base: shown,
      input: { ...input, code: null },
      savedAt: SAVED,
    });
    const fixed = await only(db);
    expect(fixed).toMatchObject({ status: 'waiting', sent: false, error: null, seq: refused.seq });
    if (fixed.command.type !== 'customer.create') throw new Error('not a create');
    expect(fixed.command.id).not.toBe(refused.command.id);
    expect(fixed.command.customerId).toBe(refused.command.customerId);
    expect(fixed.command.input.code).toBeNull();
  });

  it('changes addresses one by one, by id', async () => {
    const db = newDatabase();
    const input = inputOf(rahman);
    await saveCustomer(db, {
      base: rahman,
      input: {
        ...input,
        addresses: [
          {
            id: null,
            kind: 'shipping',
            label: 'Mirpur depot',
            address: 'Mirpur 10, Dhaka',
            phone: null,
          },
        ],
      },
      savedAt: SAVED,
    });
    const entry = await only(db);
    if (entry.command.type !== 'customer.update') throw new Error('not an update');
    expect(entry.command.addresses.remove).toEqual([rahman.addresses[0]?.id]);
    expect(entry.command.addresses.change).toEqual([]);
    expect(entry.command.addresses.add).toMatchObject([
      { kind: 'shipping', label: 'Mirpur depot', address: 'Mirpur 10, Dhaka' },
    ]);
    expect(entry.command.addresses.add[0]?.id).toMatch(/^[0-9a-f-]{14}7/);

    await db.outbox.clear();
    await saveCustomer(db, {
      base: rahman,
      input: {
        ...input,
        addresses: input.addresses.map((address) => ({ ...address, label: 'Head office' })),
      },
      savedAt: SAVED,
    });
    const changed = await only(db);
    if (changed.command.type !== 'customer.update') throw new Error('not an update');
    expect(changed.command.addresses.change).toEqual([
      { id: rahman.addresses[0]?.id, label: 'Head office' },
    ]);
  });
});

describe('saveOrderDraft', () => {
  it('saves a draft, and a second save moves it to the end of the outbox', async () => {
    const db = newDatabase();
    const draft = orderDraft(rahman.id, VARIANT);
    await saveOrderDraft(db, {
      orderId: null,
      input: draft,
      name: 'Rahman Traders',
      total: '690',
      savedAt: SAVED,
    });
    await saveCustomer(db, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: SAVED,
    });
    const [order] = await entries(db);
    expect(order).toMatchObject({ customerId: rahman.id, lines: 1, total: '690' });
    if (order?.command.type !== 'sales_order.create_draft') throw new Error('not an order');
    expect(syncCommandSchema.parse(order.command)).toEqual(order.command);

    await saveOrderDraft(db, {
      orderId: order.key,
      input: { ...draft, note: 'Deliver before Friday' },
      name: 'Rahman Traders',
      total: '690',
      savedAt: SAVED,
    });
    const [, moved] = await entries(db);
    expect(moved?.key).toBe(order.key);
    expect(moved?.command.id).not.toBe(order.command.id);
  });

  it('does not change an order that is being sent', async () => {
    const db = newDatabase();
    const draft = orderDraft(rahman.id, VARIANT);
    await saveOrderDraft(db, {
      orderId: null,
      input: draft,
      name: 'Rahman Traders',
      total: '690',
      savedAt: SAVED,
    });
    const order = await only(db);
    if (order.seq === undefined) throw new Error('no seq');
    await db.outbox.update(order.seq, { status: 'sending', sent: true });
    expect(
      await saveOrderDraft(db, {
        orderId: order.key,
        input: draft,
        name: 'Rahman Traders',
        total: '690',
        savedAt: SAVED,
      }),
    ).toBe('busy');
  });
});

describe('discardEntry and retryEntry', () => {
  it('discards a new customer with the orders that need it, and a change alone', async () => {
    const db = newDatabase();
    await saveCustomer(db, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: SAVED,
    });
    const created = await only(db);
    await saveOrderDraft(db, {
      orderId: null,
      input: orderDraft(created.customerId, VARIANT),
      name: 'Tasnim Pharmacy',
      total: '690',
      savedAt: SAVED,
    });
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: null },
      savedAt: SAVED,
    });
    if (created.seq === undefined) throw new Error('no seq');
    expect(await discardEntry(db, created.seq)).toBe('saved');
    const left = await only(db);
    expect(left.customerId).toBe(rahman.id);
  });

  it('retries a refused command under a new id', async () => {
    const db = newDatabase();
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: null },
      savedAt: SAVED,
    });
    const entry = await only(db);
    if (entry.seq === undefined) throw new Error('no seq');
    expect(await retryEntry(db, entry.seq)).toBe('unchanged');
    await db.outbox.update(entry.seq, {
      status: 'failed',
      sent: true,
      error: { code: 'permission_missing' },
    });
    expect(await retryEntry(db, entry.seq)).toBe('saved');
    const again = await only(db);
    expect(again).toMatchObject({ status: 'waiting', sent: false, error: null });
    expect(again.command.id).not.toBe(entry.command.id);
  });
});
