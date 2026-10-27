import 'fake-indexeddb/auto';

import type { SyncPush, SyncPushInput } from '@omnivo/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { OutboxRow } from './database.js';
import { SyncEngine } from './engine.js';
import { saveCustomer, saveOrderDraft } from './outbox.js';
import { pickBatch } from './push.js';
import { localCustomer, outboxEntries, syncNotices } from './queries.js';
import {
  customer,
  customerInput,
  inputOf,
  newCopy,
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

// A row as pickBatch sees it: the clear fields only (the box is never opened there)
function row(customerId: string, fields: Partial<OutboxRow> = {}): OutboxRow {
  return {
    commandId: crypto.randomUUID(),
    type: 'customer.update',
    status: 'waiting',
    sent: false,
    customerId,
    key: customerId,
    bytes: 200,
    box: new Uint8Array(0),
    ...fields,
  };
}

describe('pickBatch', () => {
  it('holds a command behind a refused one or one in the batch on the same customer', () => {
    const [a, b, c] = ['a', 'b', 'c'].map(
      (letter) => `01928c4e-2222-7000-8000-00000000000${letter}`,
    );
    if (a === undefined || b === undefined || c === undefined) throw new Error('ids');
    const refused = row(a, { status: 'failed' });
    const behindRefused = row(a);
    const first = row(b);
    const behindFirst = row(b);
    const other = row(c);
    expect(pickBatch([refused, behindRefused, first, behindFirst, other])).toEqual([first, other]);
  });

  it('stops at 50 commands, and before a command that would pass 512 KB', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      row(`01928c4e-3333-7000-8000-${String(index).padStart(12, '0')}`),
    );
    expect(pickBatch(many)).toHaveLength(50);
    // The size counted when the command was saved (step 19b), not the command itself
    const one = row('01928c4e-4444-7000-8000-000000000001', { bytes: 300 * 1024 });
    const two = row('01928c4e-4444-7000-8000-000000000002', { bytes: 300 * 1024 });
    // The first always goes, even alone
    expect(pickBatch([one, two])).toEqual([one]);
  });
});

async function engineWith(push: (input: SyncPushInput) => Promise<SyncPush>) {
  const copy = await newCopy();
  const onPushed = vi.fn();
  const engine = new SyncEngine({
    copy,
    deviceId: DEVICE,
    pull: () => Promise.resolve(page({ changes: [] })),
    push,
    onPushed,
    codeOf: (error) => (error instanceof CodedError ? error.code : null),
    registerAgain: () => Promise.resolve(),
    onRevoked: () => undefined,
  });
  return { copy, db: copy.db, engine, onPushed };
}

describe('SyncEngine push', () => {
  it('sends a new customer, writes its row, then sends its order in the next round', async () => {
    const sent: string[][] = [];
    const { copy, db, engine, onPushed } = await engineWith((input) => {
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
    await saveCustomer(copy, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: SAVED,
    });
    const [created] = await db.outbox.toArray();
    if (!created) throw new Error('no create');
    await saveOrderDraft(copy, {
      orderId: null,
      input: orderDraft(created.customerId, VARIANT),
      name: 'Tasnim Pharmacy',
      total: '690',
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(sent).toEqual([['customer.create'], ['sales_order.create_draft']]);
    expect(await db.outbox.count()).toBe(0);
    expect((await localCustomer(copy, created.customerId))?.code).toBe('C-00043');
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
    const { copy, db, engine } = await engineWith(pushed);
    await saveCustomer(copy, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy', code: 'C-00042' }),
      savedAt: SAVED,
    });
    const [created] = await db.outbox.toArray();
    if (!created) throw new Error('no create');
    await saveOrderDraft(copy, {
      orderId: null,
      input: orderDraft(created.customerId, VARIANT),
      name: 'Tasnim Pharmacy',
      total: '690',
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(pushed).toHaveBeenCalledTimes(1);
    const [failed, order] = await outboxEntries(copy);
    expect(failed).toMatchObject({
      status: 'failed',
      sent: true,
      error: { code: 'customer_code_taken' },
    });
    expect(order).toMatchObject({ status: 'waiting', sent: false });
  });

  it('puts a batch back when the push fails, still marked as sent', async () => {
    const { copy, engine } = await engineWith(() =>
      Promise.reject(new CodedError('network_error')),
    );
    const rahman = customer({ name: 'Rahman Traders' });
    await saveCustomer(copy, {
      base: rahman,
      input: { ...inputOf(rahman), phone: '01819-000111' },
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(engine.getStatus().problem).toBe('network_error');
    const [waiting] = await outboxEntries(copy);
    expect(waiting).toMatchObject({ status: 'waiting', sent: true });
  });

  it('keeps the notice of a head-office field the server kept', async () => {
    const rahman = customer({ name: 'Rahman Traders', creditLimit: '200000.0000' });
    const { copy, engine, onPushed } = await engineWith((input) =>
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
    await saveCustomer(copy, {
      base: rahman,
      input: { ...inputOf(rahman), creditLimit: '500000' },
      savedAt: SAVED,
    });
    await engine.syncNow();
    expect(await syncNotices(copy)).toMatchObject([
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
    const { copy, db, engine } = await engineWith(pushed);
    const rahman = customer({ name: 'Rahman Traders' });
    await saveCustomer(copy, {
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
