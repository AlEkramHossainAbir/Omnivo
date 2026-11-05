import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { applyPage } from './apply.js';
import { allRows } from './queries.js';
import { NO_PULL, readPullState, syncedAtOf } from './state.js';
import { newCopy, page, product, upsertProduct } from './test-fixtures.js';

const shirt = product({ name: 'Polo shirt', code: 'FG-0001' });
const trouser = product({ name: 'Chino trouser', code: 'FG-0002' });
const jacket = product({ name: 'Denim jacket', code: 'FG-0003' });

async function keys(copy: Awaited<ReturnType<typeof newCopy>>): Promise<string[]> {
  return (await copy.db.products.toArray()).map((row) => row.key).sort();
}

describe('applyPage', () => {
  it('keeps what the device had until the last page of a full pull, then drops what it did not send', async () => {
    const copy = await newCopy();
    const { db } = copy;
    await applyPage(
      copy,
      page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] }),
      null,
    );
    expect(await keys(copy)).toEqual([shirt.id, trouser.id].sort());

    // A later full pull (a resync) that no longer has the trouser: two pages
    const first = page({ full: true, hasMore: true, changes: [upsertProduct(jacket)] });
    await applyPage(copy, first, null);
    // Half way: the trouser is still there, so the list does not shrink while the pull runs
    expect(await keys(copy)).toEqual([shirt.id, trouser.id, jacket.id].sort());
    expect((await readPullState(db)).full).toBe(true);

    await applyPage(copy, page({ full: true, changes: [upsertProduct(shirt)] }), first.cursor);
    expect(await keys(copy)).toEqual([shirt.id, jacket.id].sort());
    const state = await readPullState(db);
    expect(state.full).toBe(false);
    expect(state.copied).toBe(2);
  });

  it('applies a delta: upserts replace, deletes remove, nothing else is touched', async () => {
    const copy = await newCopy();
    const { db } = copy;
    const full = page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] });
    await applyPage(copy, full, null);
    const renamed = { ...shirt, name: 'Polo shirt (piqué)', version: 2 };
    await applyPage(
      copy,
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
    expect(await allRows(copy, db.products)).toEqual([renamed]);
  });

  it('a delta upsert keeps the generation, so the next full pull still sweeps it', async () => {
    const copy = await newCopy();
    const full = page({ full: true, changes: [upsertProduct(shirt)] });
    await applyPage(copy, full, null);
    await applyPage(copy, page({ changes: [upsertProduct(trouser)] }), full.cursor);
    // A resync without the trouser removes it, though a delta wrote it
    await applyPage(copy, page({ full: true, changes: [upsertProduct(shirt)] }), null);
    expect(await keys(copy)).toEqual([shirt.id]);
  });

  it('a full pull resumed after a reload continues its generation', async () => {
    const copy = await newCopy();
    const { db } = copy;
    await applyPage(copy, page({ full: true, changes: [upsertProduct(trouser)] }), null);
    const first = page({ full: true, hasMore: true, changes: [upsertProduct(shirt)] });
    await applyPage(copy, first, null);
    // The tab closed; the next start sends the saved cursor and the server goes on
    const { cursor } = await readPullState(db);
    expect(cursor).toBe(first.cursor);
    await applyPage(copy, page({ full: true, changes: [upsertProduct(jacket)] }), cursor);
    // The shirt of the first page counts: it was sent by this full pull
    expect(await keys(copy)).toEqual([shirt.id, jacket.id].sort());
  });

  it('a pull sent without a cursor starts over, even in the middle of a full pull', async () => {
    const copy = await newCopy();
    // A full pull stops half way (its first page had the shirt)
    await applyPage(
      copy,
      page({ full: true, hasMore: true, changes: [upsertProduct(shirt)] }),
      null,
    );
    // The device starts from the beginning (a cursor the server refused, 18c's "sync again");
    // the server no longer has the shirt, so the shirt of the old half must not count
    await applyPage(copy, page({ full: true, changes: [upsertProduct(jacket)] }), null);
    expect(await keys(copy)).toEqual([jacket.id]);
  });

  it('a page applied twice gives the same result', async () => {
    const copy = await newCopy();
    const full = page({ full: true, changes: [upsertProduct(shirt), upsertProduct(trouser)] });
    await applyPage(copy, full, null);
    const delta = page({ changes: [{ op: 'delete', entity: 'product', key: shirt.id }] });
    await applyPage(copy, delta, full.cursor);
    await applyPage(copy, delta, full.cursor);
    expect(await keys(copy)).toEqual([trouser.id]);
  });

  it('sets the last sync only when a pull ends, from the server clock', async () => {
    const copy = await newCopy();
    const { db } = copy;
    const first = page({
      full: true,
      hasMore: true,
      changes: [],
      serverTime: '2026-10-21T04:00:00.000Z',
    });
    await applyPage(copy, first, null);
    expect((await readPullState(db)).lastSyncAt).toBeNull();
    await applyPage(
      copy,
      page({ full: true, changes: [], serverTime: '2026-10-21T04:00:05.000Z' }),
      first.cursor,
    );
    expect((await readPullState(db)).lastSyncAt).toBe('2026-10-21T04:00:05.000Z');
  });

  it("keeps the device's own clock at the end of a pull, for the time limits (step 18c)", async () => {
    const copy = await newCopy();
    const { db } = copy;
    // The device's clock is three hours behind the server's: the limits count on the device's
    const deviceNow = Date.parse('2026-10-21T01:00:00.000Z');
    const first = page({ full: true, hasMore: true, changes: [] });
    await applyPage(copy, first, null, deviceNow - 5000);
    expect((await readPullState(db)).syncedAt).toBeNull();
    await applyPage(
      copy,
      page({ full: true, changes: [], serverTime: '2026-10-21T04:00:05.000Z' }),
      first.cursor,
      deviceNow,
    );
    const state = await readPullState(db);
    expect(state.syncedAt).toBe(deviceNow);
    expect(syncedAtOf(state)).toBe(deviceNow);
  });

  it('reads a pull state saved before step 18c, with the server time standing in', async () => {
    const copy = await newCopy();
    const { db } = copy;
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
    const copy = await newCopy();
    const { db } = copy;
    const priceKey = `${shirt.id}:${shirt.variants[0]?.id ?? ''}:${shirt.baseUnitId}`;
    await applyPage(
      copy,
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
    const row = await db.priceListItems.get(priceKey);
    // Clear for the sale line's lookups (prices.ts), sealed for the rest
    expect(row?.priceListId).toBe(shirt.id);
    expect(row?.variantId).toBe(shirt.variants[0]?.id);
    expect((await allRows(copy, db.priceListItems))[0]?.price).toBe('450.0000');
  });

  it('writes nothing a person typed in clear: only keys, the generation and index ids (step 19b)', async () => {
    const copy = await newCopy();
    const coded = product({
      name: 'Polo shirt',
      code: 'FG-0001',
      variants: [
        {
          id: shirt.variants[0]?.id ?? '',
          sku: 'FG-0001-M',
          optionValues: [],
          barcode: '8901234567890',
          salePrice: '450.0000',
          archivedAt: null,
        },
      ],
    });
    await applyPage(copy, page({ full: true, changes: [upsertProduct(coded)] }), null);
    const [row] = await copy.db.products.toArray();
    expect(Object.keys(row ?? {}).sort()).toEqual(['barcodes', 'box', 'gen', 'key', 'variantIds']);
    expect(row?.barcodes).toEqual(['8901234567890']);
    const bytes = new TextDecoder('latin1').decode(row?.box);
    for (const typed of ['Polo shirt', 'FG-0001', '450.0000']) expect(bytes).not.toContain(typed);
  });
});
