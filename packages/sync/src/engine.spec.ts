import 'fake-indexeddb/auto';

import type { SyncPull, SyncPullQuery } from '@omnivo/contracts';
import { describe, expect, it, vi } from 'vitest';

import { readPullState } from './state.js';
import { SyncEngine, type SyncEngineOptions } from './engine.js';
import { newDatabase, page, product, upsertProduct } from './test-fixtures.js';

// An API error the way the app's ApiRequestError carries it
class CodedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const codeOf = (error: unknown) => (error instanceof CodedError ? error.code : null);
const DEVICE = '01928c4e-1111-7000-8000-000000000001';

function engineWith(
  pull: (query: SyncPullQuery) => Promise<SyncPull>,
  options: Partial<SyncEngineOptions> = {},
) {
  const db = newDatabase();
  const engine = new SyncEngine({
    db,
    deviceId: DEVICE,
    pull,
    // Nothing in the outbox: the 18a tests never push
    push: () => Promise.reject(new Error('no push expected')),
    codeOf,
    registerAgain: () => Promise.resolve(),
    onRevoked: () => undefined,
    ...options,
  });
  return { db, engine };
}

describe('SyncEngine', () => {
  it('asks page after page with the last cursor until hasMore is false', async () => {
    const pages = [
      page({
        full: true,
        hasMore: true,
        cursor: 'a',
        changes: [upsertProduct(product({ name: 'Paracetamol 500' }))],
      }),
      page({
        full: true,
        hasMore: false,
        cursor: 'b',
        changes: [upsertProduct(product({ name: 'Omeprazole 20' }))],
      }),
    ];
    const pull = vi.fn<(query: SyncPullQuery) => Promise<SyncPull>>(() =>
      Promise.resolve(pages.shift() ?? page({ changes: [] })),
    );
    const { db, engine } = engineWith(pull);
    await engine.syncNow();
    expect(pull.mock.calls.map(([query]) => query.cursor)).toEqual([undefined, 'a']);
    expect(pull.mock.calls[0]?.[0]).toMatchObject({ deviceId: DEVICE, protocol: 1, limit: 500 });
    expect(await db.products.count()).toBe(2);
    expect((await readPullState(db)).cursor).toBe('b');
    // The next pull starts from the saved cursor
    await engine.syncNow();
    expect(pull.mock.calls.at(-1)?.[0].cursor).toBe('b');
    expect(engine.getStatus()).toEqual({ syncing: false, problem: null, stopped: false });
  });

  it('runs one pull at a time, and once more when asked during one', async () => {
    let release: () => void = () => undefined;
    const pull = vi.fn(
      () =>
        new Promise<SyncPull>((resolve) => {
          release = () => {
            resolve(page({ changes: [] }));
          };
        }),
    );
    const { engine } = engineWith(pull);
    const first = engine.syncNow();
    const second = engine.syncNow();
    const third = engine.syncNow();
    expect(second).toBe(first);
    expect(third).toBe(first);
    await vi.waitFor(() => {
      expect(pull).toHaveBeenCalledTimes(1);
    });
    release();
    // The asks made during the first run are one more run, not two
    await vi.waitFor(() => {
      expect(pull).toHaveBeenCalledTimes(2);
    });
    release();
    await first;
    expect(pull).toHaveBeenCalledTimes(2);
  });

  it('registers again on device_not_found and pulls once more', async () => {
    const pull = vi
      .fn<(query: SyncPullQuery) => Promise<SyncPull>>()
      .mockRejectedValueOnce(new CodedError('device_not_found'))
      .mockResolvedValueOnce(page({ changes: [] }));
    const registerAgain = vi.fn(() => Promise.resolve());
    const { engine } = engineWith(pull, { registerAgain });
    await engine.syncNow();
    expect(registerAgain).toHaveBeenCalledTimes(1);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(engine.getStatus().problem).toBeNull();
  });

  it('stops for good on device_revoked and tells the app', async () => {
    const pull = vi.fn(() => Promise.reject(new CodedError('device_revoked')));
    const onRevoked = vi.fn();
    const { engine } = engineWith(pull, { onRevoked });
    await engine.syncNow();
    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(engine.getStatus()).toEqual({
      syncing: false,
      problem: 'device_revoked',
      stopped: true,
    });
    await engine.syncNow();
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('stops on sync_protocol_mismatch: only a reload helps', async () => {
    const pull = vi.fn(() => Promise.reject(new CodedError('sync_protocol_mismatch')));
    const { engine } = engineWith(pull);
    await engine.syncNow();
    expect(engine.getStatus()).toMatchObject({ problem: 'sync_protocol_mismatch', stopped: true });
  });

  it('keeps going after a network error, and keeps the pages it had', async () => {
    const pull = vi
      .fn<(query: SyncPullQuery) => Promise<SyncPull>>()
      .mockResolvedValueOnce(
        page({
          full: true,
          hasMore: true,
          cursor: 'a',
          changes: [upsertProduct(product({ name: 'Rice 50 kg sack' }))],
        }),
      )
      .mockRejectedValueOnce(new CodedError('network_error'))
      .mockResolvedValueOnce(page({ full: true, cursor: 'b', changes: [] }));
    const { db, engine } = engineWith(pull);
    await engine.syncNow();
    expect(engine.getStatus()).toEqual({
      syncing: false,
      problem: 'network_error',
      stopped: false,
    });
    // The first page is saved with its cursor, so the next pull goes on from there
    expect(await db.products.count()).toBe(1);
    await engine.syncNow();
    expect(pull.mock.calls.at(-1)?.[0].cursor).toBe('a');
    expect(engine.getStatus().problem).toBeNull();
  });

  it('an error that is not the API’s is unknown_error', async () => {
    const { engine } = engineWith(() => Promise.reject(new TypeError('boom')));
    await engine.syncNow();
    expect(engine.getStatus().problem).toBe('unknown_error');
  });

  it('pulls no more after stop()', async () => {
    const pull = vi.fn(() => Promise.resolve(page({ changes: [] })));
    const { engine } = engineWith(pull);
    engine.stop();
    await engine.syncNow();
    expect(pull).not.toHaveBeenCalled();
  });

  it('tells its listeners when the status changes', async () => {
    const { engine } = engineWith(() => Promise.resolve(page({ changes: [] })));
    const seen: boolean[] = [];
    const unsubscribe = engine.subscribe(() => {
      seen.push(engine.getStatus().syncing);
    });
    await engine.syncNow();
    unsubscribe();
    await engine.syncNow();
    expect(seen).toEqual([true, false]);
  });
});
