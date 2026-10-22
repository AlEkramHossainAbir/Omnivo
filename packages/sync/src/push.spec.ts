import 'fake-indexeddb/auto';

import type { SyncPush, SyncPushInput } from '@omnivo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxEntry } from './database.js';
import { SyncEngine } from './engine.js';
import { saveCustomer, saveOrderDraft } from './outbox.js';
import { pickBatch } from './push.js';
import {
  customer,
  customerInput,
  inputOf,
  newDatabase,
  orderDraft,
  page,
  upsertCustomer,
} from './test-fixtures.js';

const SAVED = '2026-10-21T15:00:00.000Z';
const SERVER = '2026-10-21T16:00:00.000Z';
const DEVICE = '01928c4e-1111-7000-8000-000000000001';
const VARIANT = '01928c4e-8888-7000-8000-000000000001';

class CodedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function entry(customerId: string, fields: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    command: {
      id: crypto.randomUUID(),
      type: 'customer.update',
      customerId,
      baseVersion: 1,
      changes: {},
      addresses: { add: [], remove: [], change: [] },
    },
    status: 'waiting',
    sent: false,
    error: null,
    customerId,
    key: customerId,
    base: null,
    name: 'Rahman Traders',
    lines: null,
    total: null,
    savedAt: SAVED,
    ...fields,
  };
}

describe('pickBatch', () => {
  it('holds a command behind a refused one or one in the batch on the same customer', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(
      (letter) => `01928c4e-2222-7000-8000-00000000000${letter}`,
    );
    if (a === undefined || b === undefined || c === undefined) throw new Error('ids');
    const refused = entry(a, { status: 'failed' });
    const behindRefused = entry(a);
    const first = entry(b);
    const behindFirst = entry(b);
    const other = entry(c);
    expect(pickBatch([refused, behindRefused, first, behindFirst, other])).toEqual([first, other]);
  });

  it('stops at 50 commands, and before a command that would pass 512 KB', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      entry(`01928c4e-3333-7000-8000-${String(index).padStart(12, '0')}`),
    );
    expect(pickBatch(many)).toHaveLength(50);
    const big = (id: string) =>
      entry(id, {
        command: {
          id: crypto.randomUUID(),
          type: 'customer.update',
          customerId: id,
          baseVersion: 1,
          changes: { notes: { from: null, to: 'x'.repeat(300 * 1024) } },
          addresses: { add: [], remove: [], change: [] },
        },
      });
    const one = big('01928c4e-4444-7000-8000-000000000001');
    const two = big('01928c4e-4444-7000-8000-000000000002');
    // The first always goes, even alone
    expect(pickBatch([one, two])).toEqual([one]);
  });
});

function engineWith(push: (input: SyncPushInput) => Promise<SyncPush>) {
  const db = newDatabase();
  const onPushed = vi.fn();
  const engine = new SyncEngine({
    db,
    deviceId: DEVICE,
    pull: () => Promise.resolve(page({ changes: [] })),
    push,
    onPushed,
    codeOf: (error) => (error instanceof CodedError ? error.code : null),
    registerAgain: () => Promise.resolve(),
    onRevoked: () => undefined,
  });
  return { db, engine, onPushed };
}

describe('SyncEngine push', () => {
  it('sends a new customer, writes its row, then sends its order in the next round', async () => {
    const sent: string[][] = [];
    const { db, engine, onPushed } = engineWith((input) => {
      sent.push(input.commands.map((command) => command.type));
      return Promise.resolve({
        serverTime: SERVER,
        results: input.commands.map((command) => {
          if (command.type !== 'customer.create') {
            return { id: command.id, status: 'accepted' as const, notices: [], changes: [] };
          }
          const id = String(command.customerId);
          return {
            id: command.id,
            status: 'accepted' as const,
            notices: [],
            changes: [upsertCustomer(customer({ id, name: 'Tasnim Pharmacy', code: 'C-00043' }))],
          };
        }),
      });
    });
    await saveCustomer(db, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: SAVED,
    });
    const [created] = await db.outbox.toArray();
    if (!created) throw new Error('no create');
    await saveOrderDraft(db, {
      orderId: null,
      input: orderDraft(created.customerId, VARIANT),
      name: 'Tasnim Pharmacy',
      total: '690',
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(sent).toEqual([['customer.create'], ['sales_order.create_draft']]);
    expect(await db.outbox.count()).toBe(0);
    expect((await db.customers.get(created.customerId))?.data.code).toBe('C-00043');
    expect(onPushed).toHaveBeenCalledWith({ accepted: 2, rejected: 0, kept: 0 });
    expect(engine.getStatus()).toEqual({ syncing: false, problem: null, stopped: false });
  });

  it('keeps a refused command with its error, and its order waits', async () => {
    const pushed = vi.fn((input: SyncPushInput) =>
      Promise.resolve<SyncPush>({
        serverTime: SERVER,
        results: input.commands.map((command) => ({
          id: command.id,
          status: 'rejected' as const,
          error: { code: 'customer_code_taken', fieldErrors: { code: ['customer_code_taken'] } },
        })),
      }),
    );
    const { db, engine } = engineWith(pushed);
    await saveCustomer(db, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy', code: 'C-00042' }),
      savedAt: SAVED,
    });
    const [created] = await db.outbox.toArray();
    if (!created) throw new Error('no create');
    await saveOrderDraft(db, {
      orderId: null,
      input: orderDraft(created.customerId, VARIANT),
      name: 'Tasnim Pharmacy',
      total: '690',
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(pushed).toHaveBeenCalledTimes(1);
    const [failed, order] = await db.outbox.toArray();
    expect(failed).toMatchObject({
      status: 'failed',
      sent: true,
      error: { code: 'customer_code_taken' },
    });
    expect(order).toMatchObject({ status: 'waiting', sent: false });
  });

  it('puts a batch back when the push fails, still marked as sent', async () => {
    const { db, engine } = engineWith(() => Promise.reject(new CodedError('network_error')));
    const rahman = customer({ name: 'Rahman Traders' });
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(engine.getStatus().problem).toBe('network_error');
    const [waiting] = await db.outbox.toArray();
    expect(waiting).toMatchObject({ status: 'waiting', sent: true });
  });

  it('keeps the notice of a head-office field the server kept', async () => {
    const rahman = customer({ name: 'Rahman Traders', creditLimit: '200000.0000' });
    const { db, engine, onPushed } = engineWith((input) =>
      Promise.resolve({
        serverTime: SERVER,
        results: input.commands.map((command) => ({
          id: command.id,
          status: 'accepted' as const,
          notices: [{ code: 'kept_server_value', fields: ['creditLimit'] }],
          changes: [upsertCustomer(rahman)],
        })),
      }),
    );
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), creditLimit: '500000' },
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(await db.notices.toArray()).toMatchObject([
      { name: 'Rahman Traders', fields: ['creditLimit'], at: SERVER },
    ]);
    expect(onPushed).toHaveBeenCalledWith({ accepted: 1, rejected: 0, kept: 1 });
  });

  it('sends a command left "sending" by a closed tab again', async () => {
    const pushed = vi.fn((input: SyncPushInput) =>
      Promise.resolve<SyncPush>({
        serverTime: SERVER,
        results: input.commands.map((command) => ({
          id: command.id,
          status: 'accepted' as const,
          notices: [],
          changes: [],
        })),
      }),
    );
    const { db, engine } = engineWith(pushed);
    const rahman = customer({ name: 'Rahman Traders' });
    await saveCustomer(db, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    await db.outbox.toCollection().modify({ status: 'sending', sent: true });
    await engine.syncNow();
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(await db.outbox.count()).toBe(0);
  });
});
