import 'fake-indexeddb/auto';

import { syncCommandSchema } from '@omnivo/contracts';
import type { SyncCommandError } from '@omnivo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { LocalCopy } from './copy.js';
import type { OutboxEntry } from './database.js';
import { discardEntry, retryEntry, saveCustomer, saveOrderDraft } from './outbox.js';
import { outboxEntries } from './queries.js';
import { sealEntry } from './sealed.js';
import { customer, customerInput, inputOf, newCopy, orderDraft } from './test-fixtures.js';

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

function entries(copy: LocalCopy) {
  return outboxEntries(copy);
}

async function only(copy: LocalCopy) {
  const [entry, ...more] = await entries(copy);
  expect(more).toEqual([]);
  if (!entry) throw new Error('the outbox is empty');
  return entry;
}

// What the push does to a refused command (push.ts): the error is sealed with the rest
async function refuse(copy: LocalCopy, entry: OutboxEntry, error: SyncCommandError) {
  await copy.db.outbox.put(
    await sealEntry(copy, { ...entry, status: 'failed', sent: true, error }),
  );
}

describe('saveCustomer', () => {
  it('saves a new customer as a create, with the device’s ids, that the server reads as it is', async () => {
    const copy = await newCopy();
    const input = customerInput({
      name: 'Tasnim Pharmacy',
      addresses: [
        { id: null, kind: 'billing', label: null, address: 'Agrabad, Chattogram', phone: null },
      ],
    });
    expect(await saveCustomer(copy, { base: null, input, savedAt: SAVED })).toBe('saved');
    const entry = await only(copy);
    expect(entry).toMatchObject({ status: 'waiting', sent: false, name: 'Tasnim Pharmacy' });
    if (entry.command.type !== 'customer.create') throw new Error('not a create');
    expect(entry.key).toBe(entry.command.customerId);
    expect(entry.command.input.addresses[0]?.id).toMatch(/^[0-9a-f-]{14}7/);
    // The outbox keeps the schema's output; the server parses it again and gets the same command
    expect(syncCommandSchema.parse(entry.command)).toEqual(entry.command);
  });

  it('sends only what changed, and a credit limit typed without decimals is no change', async () => {
    const copy = await newCopy();
    const same = { ...inputOf(rahman), creditLimit: '200000' };
    expect(await saveCustomer(copy, { base: rahman, input: same, savedAt: SAVED })).toBe(
      'unchanged',
    );
    expect(await entries(copy)).toEqual([]);

    await saveCustomer(copy, {
      base: rahman,
      input: { ...same, phone: '01819-000111' },
      savedAt: SAVED,
    });
    const entry = await only(copy);
    if (entry.command.type !== 'customer.update') throw new Error('not an update');
    expect(entry.command.changes).toEqual({
      phone: { from: '01711-234567', to: '01819-000111' },
    });
    expect(entry.command.addresses).toEqual({ add: [], remove: [], change: [] });
    expect(entry.command.baseVersion).toBe(1);
    expect(syncCommandSchema.parse(entry.command)).toEqual(entry.command);
  });

  it('folds a second edit into the waiting change, with the first `from`, under a new id', async () => {
    const copy = await newCopy();
    await saveCustomer(copy, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    const first = await only(copy);
    // The form opens on the customer with the change on it, and changes the limit too
    const shown = { ...rahman, phone: '01819-000111' };
    await saveCustomer(copy, {
      base: shown,
      input: { ...inputOf(shown), creditLimit: '250000' },
      savedAt: SAVED,
    });
    const second = await only(copy);
    expect(second.seq).toBe(first.seq);
    expect(second.command.id).not.toBe(first.command.id);
    if (second.command.type !== 'customer.update') throw new Error('not an update');
    expect(second.command.changes).toEqual({
      phone: { from: '01711-234567', to: '01819-000111' },
      creditLimit: { from: '200000.0000', to: '250000' },
    });

    // Changed back to what the server has: nothing is left to send
    await saveCustomer(copy, { base: shown, input: inputOf(rahman), savedAt: SAVED });
    expect(await entries(copy)).toEqual([]);
  });

  it('adds a new change after one that was sent without an answer', async () => {
    const copy = await newCopy();
    await saveCustomer(copy, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    const sent = await only(copy);
    if (sent.seq === undefined) throw new Error('no seq');
    // It may have run on the server: it is never rewritten
    await copy.db.outbox.update(sent.seq, { sent: true });
    const shown = { ...rahman, phone: '01819-000111' };
    await saveCustomer(copy, {
      base: shown,
      input: { ...inputOf(shown), name: 'Rahman Traders Ltd' },
      savedAt: SAVED,
    });
    const [kept, added] = await entries(copy);
    expect(kept?.command).toEqual(sent.command);
    if (added?.command.type !== 'customer.update') throw new Error('not an update');
    expect(added.command.changes).toEqual({
      name: { from: 'Rahman Traders', to: 'Rahman Traders Ltd' },
    });
  });

  it('starts again when a push takes the command while the save seals its change (step 19b)', async () => {
    const copy = await newCopy();
    await saveCustomer(copy, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    const first = await only(copy);
    if (first.seq === undefined) throw new Error('no seq');
    const { seq } = first;
    // The second save opens the waiting change and would fold into it. While it seals (outside
    // any transaction), the push marks that change sent: folding into it now would rewrite a
    // command the server may run.
    const seal = copy.seal.bind(copy);
    let raced = false;
    vi.spyOn(copy, 'seal').mockImplementation(async (table, key, value) => {
      if (!raced) {
        raced = true;
        await copy.db.outbox.update(seq, { status: 'sending', sent: true });
      }
      return seal(table, key, value);
    });
    const shown = { ...rahman, phone: '01819-000111' };
    expect(
      await saveCustomer(copy, {
        base: shown,
        input: { ...inputOf(shown), name: 'Rahman Traders Ltd' },
        savedAt: SAVED,
      }),
    ).toBe('saved');
    const [kept, added] = await entries(copy);
    expect(kept?.command).toEqual(first.command);
    if (added?.command.type !== 'customer.update') throw new Error('not an update');
    expect(added.command.changes).toEqual({
      name: { from: 'Rahman Traders', to: 'Rahman Traders Ltd' },
    });
  });

  it('turns a refused create, fixed, into a waiting create with a new id', async () => {
    const copy = await newCopy();
    const input = customerInput({ name: 'Tasnim Pharmacy', code: 'C-00042' });
    await saveCustomer(copy, { base: null, input, savedAt: SAVED });
    const refused = await only(copy);
    if (refused.seq === undefined || refused.command.type !== 'customer.create') {
      throw new Error('not a create');
    }
    await refuse(copy, refused, { code: 'customer_code_taken' });
    const shown = { ...customer({ name: 'Tasnim Pharmacy', code: 'C-00042' }), id: refused.key };
    await saveCustomer(copy, {
      base: shown,
      input: { ...input, code: null },
      savedAt: SAVED,
    });
    const fixed = await only(copy);
    expect(fixed).toMatchObject({ status: 'waiting', sent: false, error: null, seq: refused.seq });
    if (fixed.command.type !== 'customer.create') throw new Error('not a create');
    expect(fixed.command.id).not.toBe(refused.command.id);
    expect(fixed.command.customerId).toBe(refused.command.customerId);
    expect(fixed.command.input.code).toBeNull();
  });

  it('changes addresses one by one, by id', async () => {
    const copy = await newCopy();
    const input = inputOf(rahman);
    await saveCustomer(copy, {
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
    const entry = await only(copy);
    if (entry.command.type !== 'customer.update') throw new Error('not an update');
    expect(entry.command.addresses.remove).toEqual([rahman.addresses[0]?.id]);
    expect(entry.command.addresses.change).toEqual([]);
    expect(entry.command.addresses.add).toMatchObject([
      { kind: 'shipping', label: 'Mirpur depot', address: 'Mirpur 10, Dhaka' },
    ]);
    expect(entry.command.addresses.add[0]?.id).toMatch(/^[0-9a-f-]{14}7/);

    await copy.db.outbox.clear();
    await saveCustomer(copy, {
      base: rahman,
      input: {
        ...input,
        addresses: input.addresses.map((address) => ({ ...address, label: 'Head office' })),
      },
      savedAt: SAVED,
    });
    const changed = await only(copy);
    if (changed.command.type !== 'customer.update') throw new Error('not an update');
    expect(changed.command.addresses.change).toEqual([
      { id: rahman.addresses[0]?.id, label: 'Head office' },
    ]);
  });
});

describe('saveOrderDraft', () => {
  it('saves a draft, and a second save moves it to the end of the outbox', async () => {
    const copy = await newCopy();
    const draft = orderDraft(rahman.id, VARIANT);
    await saveOrderDraft(copy, {
      orderId: null,
      input: draft,
      name: 'Rahman Traders',
      total: '690',
      savedAt: SAVED,
    });
    await saveCustomer(copy, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: SAVED,
    });
    const [order] = await entries(copy);
    expect(order).toMatchObject({ customerId: rahman.id, lines: 1, total: '690' });
    if (order?.command.type !== 'sales_order.create_draft') throw new Error('not an order');
    expect(syncCommandSchema.parse(order.command)).toEqual(order.command);

    await saveOrderDraft(copy, {
      orderId: order.key,
      input: { ...draft, note: 'Deliver before Friday' },
      name: 'Rahman Traders',
      total: '690',
      savedAt: SAVED,
    });
    const [, moved] = await entries(copy);
    expect(moved?.key).toBe(order.key);
    expect(moved?.command.id).not.toBe(order.command.id);
  });

  it('does not change an order that is being sent', async () => {
    const copy = await newCopy();
    const draft = orderDraft(rahman.id, VARIANT);
    await saveOrderDraft(copy, {
      orderId: null,
      input: draft,
      name: 'Rahman Traders',
      total: '690',
      savedAt: SAVED,
    });
    const order = await only(copy);
    if (order.seq === undefined) throw new Error('no seq');
    await copy.db.outbox.update(order.seq, { status: 'sending', sent: true });
    expect(
      await saveOrderDraft(copy, {
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
    const copy = await newCopy();
    await saveCustomer(copy, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: SAVED,
    });
    const created = await only(copy);
    await saveOrderDraft(copy, {
      orderId: null,
      input: orderDraft(created.customerId, VARIANT),
      name: 'Tasnim Pharmacy',
      total: '690',
      savedAt: SAVED,
    });
    await saveCustomer(copy, {
      base: rahman,
      input: { ...inputOf(rahman), phone: null },
      savedAt: SAVED,
    });
    if (created.seq === undefined) throw new Error('no seq');
    expect(await discardEntry(copy, created.seq)).toBe('saved');
    const left = await only(copy);
    expect(left.customerId).toBe(rahman.id);
  });

  it('retries a refused command under a new id', async () => {
    const copy = await newCopy();
    await saveCustomer(copy, {
      base: rahman,
      input: { ...inputOf(rahman), phone: null },
      savedAt: SAVED,
    });
    const entry = await only(copy);
    if (entry.seq === undefined) throw new Error('no seq');
    expect(await retryEntry(copy, entry.seq)).toBe('unchanged');
    await refuse(copy, entry, { code: 'permission_missing' });
    expect(await retryEntry(copy, entry.seq)).toBe('saved');
    const again = await only(copy);
    expect(again).toMatchObject({ status: 'waiting', sent: false, error: null });
    expect(again.command.id).not.toBe(entry.command.id);
  });
});
