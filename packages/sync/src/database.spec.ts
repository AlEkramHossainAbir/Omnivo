import 'fake-indexeddb/auto';

import { Dexie } from 'dexie';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';

import { SyncDatabase } from './database.js';
import { productRecord } from './records.js';
import { product } from './test-fixtures.js';

describe('SyncDatabase version 2', () => {
  it('keeps the copy of version 1 and gives its products their variant ids', async () => {
    const name = `test-${uuidv7()}`;
    const shirt = product({ name: 'Polo shirt' });
    // A device on 18a's app: version 1, products without variantIds
    const old = new Dexie(name);
    old.version(1).stores({ products: 'key, gen, sortName, sortCode, *barcodes' });
    const full = productRecord(shirt.id, 1, shirt);
    await old.table('products').put({
      key: full.key,
      gen: full.gen,
      data: full.data,
      sortName: full.sortName,
      sortCode: full.sortCode,
      text: full.text,
      barcodes: full.barcodes,
    });
    old.close();

    const db = new SyncDatabase(name);
    const variantId = shirt.variants[0]?.id ?? '';
    expect((await db.products.get(shirt.id))?.variantIds).toEqual([variantId]);
    expect(await db.products.where('variantIds').equals(variantId).count()).toBe(1);
    expect(await db.outbox.count()).toBe(0);
    db.close();
  });
});
