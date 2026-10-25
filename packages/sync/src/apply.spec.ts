import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import { NO_PULL, readPullState, syncedAtOf } from './state.js';
import { newDatabase, page, product, upsertProduct } from './test-fixtures.js';

const shirt = product({ name: 'Polo shirt', code: 'FG-0001' });
const trouser = product({ name: 'Chino trouser', code: 'FG-0002' });
const jacket = product({ name: 'Denim jacket', code: 'FG-0003' });

async function keys(db: ReturnType<typeof newDatabase>): Promise<string[]> {
  return (await db.products.toArray()).map((record) => record.key).sort();
}

describe('applyPage', () => {
  it('keeps what the device had until the last page of a full pull, then drops what it did not send', async () => {
    const db = newDatabase();
    await applyPage(
      db,
      page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] }),
      null,
    );
    expect(await keys(db)).toEqual([shirt.id, trouser.id].sort());

    // A later full pull (a resync) that no longer has the trouser: two pages
    const first = page({ full: true, hasMore: true, changes: [upsertProduct(jacket)] });
    await applyPage(db, first, null);
    // Half way: the trouser is still there, so the list does not shrink while the pull runs
    expect(await keys(db)).toEqual([shirt.id, trouser.id, jacket.id].sort());
    expect((await readPullState(db)).full).toBe(true);

    await applyPage(db, page({ full: true, changes: [upsertProduct(shirt)] }), first.cursor);
    expect(await keys(db)).toEqual([shirt.id, jacket.id].sort());
    const state = await readPullState(db);
    expect(state.full).toBe(false);
    expect(state.copied).toBe(2);
  });

  it('applies a delta: upserts replace, deletes remove, nothing else is touched', async () => {
    const db = newDatabase();
    const full = page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] });
    await applyPage(db, full, null);
    const renamed = { ...shirt, name: 'Polo shirt (piqué)', version: 2 };
    await applyPage(
      db,
      page({
        changes: [
          upsertProduct(renamed),
          { op: 'delete', entity: 'product', key: trouser.id },
          // A delete of a row the device never had is harmless (decision 27)
          { op: 'delete', entity: 'stock', key: 'not-here' },
        ],
      }),
      full.cursor,
    );
    const rows = await db.products.toArray();
    expect(rows.map((record) => record.data)).toEqual([renamed]);
    expect(rows[0]?.sortName).toBe('polo shirt (piqué)');
  });

  it('a delta upsert keeps the generation, so the next full pull still sweeps it', async () => {
    const db = newDatabase();
    const full = page({ full: true, changes: [upsertProduct(shirt)] });
    await applyPage(db, full, null);
    await applyPage(db, page({ changes: [upsertProduct(trouser)] }), full.cursor);
    // A resync without the trouser removes it, though a delta wrote it
    await applyPage(db, page({ full: true, changes: [upsertProduct(shirt)] }), null);
    expect(await keys(db)).toEqual([shirt.id]);
  });

  it('a full pull resumed after a reload continues its generation', async () => {
    const db = newDatabase();
    await applyPage(db, page({ full: true, changes: [upsertProduct(trouser)] }), null);
    const first = page({ full: true, hasMore: true, changes: [upsertProduct(shirt)] });
    await applyPage(db, first, null);
    // The tab closed; the next start sends the saved cursor and the server goes on
    const { cursor } = await readPullState(db);
    expect(cursor).toBe(first.cursor);
    await applyPage(db, page({ full: true, changes: [upsertProduct(jacket)] }), cursor);
    // The shirt of the first page counts: it was sent by this full pull
    expect(await keys(db)).toEqual([shirt.id, jacket.id].sort());
  });

  it('a pull sent without a cursor starts over, even in the middle of a full pull', async () => {
    const db = newDatabase();
    // A full pull stops half way (its first page had the shirt)
    await applyPage(db, page({ full: true, hasMore: true, changes: [upsertProduct(shirt)] }), null);
    // The device starts from the beginning (a cursor the server refused, 18c's "sync again");
    // the server no longer has the shirt, so the shirt of the old half must not count
    await applyPage(db, page({ full: true, changes: [upsertProduct(jacket)] }), null);
    expect(await keys(db)).toEqual([jacket.id]);
  });

  it('a page applied twice gives the same result', async () => {
    const db = newDatabase();
    const full = page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] });
    await applyPage(db, full, null);
    const delta = page({ changes: [{ op: 'delete', entity: 'product', key: shirt.id }] });
    await applyPage(db, delta, full.cursor);
    await applyPage(db, delta, full.cursor);
    expect(await keys(db)).toEqual([trouser.id]);
  });

  it('sets the last sync only when a pull ends, from the server clock', async () => {
    const db = newDatabase();
    const first = page({
      full: true,
      hasMore: true,
      changes: [],
      serverTime: '2026-10-21T04:00:00.000Z',
    });
    await applyPage(db, first, null);
    expect((await readPullState(db)).lastSyncAt).toBeNull();
    await applyPage(
      db,
      page({ full: true, changes: [], serverTime: '2026-10-21T04:00:05.000Z' }),
      first.cursor,
    );
    expect((await readPullState(db)).lastSyncAt).toBe('2026-10-21T04:00:05.000Z');
  });

  it("keeps the device's own clock at the end of a pull, for the time limits (step 18c)", async () => {
    const db = newDatabase();
    // The device's clock is three hours behind the server's: the limits count on the device's
    const deviceNow = Date.parse('2026-10-21T01:00:00.000Z');
    const first = page({ full: true, hasMore: true, changes: [] });
    await applyPage(db, first, null, deviceNow - 5000);
    expect((await readPullState(db)).syncedAt).toBeNull();
    await applyPage(
      db,
      page({ full: true, changes: [], serverTime: '2026-10-21T04:00:05.000Z' }),
      first.cursor,
      deviceNow,
    );
    const state = await readPullState(db);
    expect(state.syncedAt).toBe(deviceNow);
    expect(syncedAtOf(state)).toBe(deviceNow);
  });

  it('reads a pull state saved before step 18c, with the server time standing in', async () => {
    const db = newDatabase();
    await db.meta.put({ ...NO_PULL, cursor: 'c', lastSyncAt: '2026-10-21T04:00:05.000Z' });
    // An older app saved the row without syncedAt: take the field off, as it was stored then
    await db.meta.update('pull', (row) => {
      Reflect.deleteProperty(row, 'syncedAt');
    });
    expect(await db.meta.get('pull')).not.toHaveProperty('syncedAt');
    const state = await readPullState(db);
    expect(state.syncedAt).toBeNull();
    expect(syncedAtOf(state)).toBe(Date.parse('2026-10-21T04:00:05.000Z'));
    expect(syncedAtOf(NO_PULL)).toBeNull();
  });

  it('keeps the price and the stock keys the server sends', async () => {
    const db = newDatabase();
    const priceKey = `${shirt.id}:${shirt.variants[0]?.id ?? ''}:${shirt.baseUnitId}`;
    await applyPage(
      db,
      page({
        full: true,
        changes: [
          {
            op: 'upsert',
            entity: 'price_list_item',
            key: priceKey,
            data: {
              priceListId: shirt.id,
              productId: shirt.id,
              variantId: shirt.variants[0]?.id ?? '',
              unitId: shirt.baseUnitId,
              price: '450.0000',
              updatedAt: shirt.updatedAt,
            },
          },
        ],
      }),
      null,
    );
    expect((await db.priceListItems.get(priceKey))?.data.price).toBe('450.0000');
  });
});
