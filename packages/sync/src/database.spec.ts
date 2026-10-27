import 'fake-indexeddb/auto';

import { Dexie } from 'dexie';
import { uuidv7 } from 'uuidv7';
import { describe, expect, it } from 'vitest';

import { LocalCopy } from './copy.js';
import type { OutboxEntry, SyncNoticeRecord } from './database.js';
import { openKey } from './keys.js';
import { saveCustomer } from './outbox.js';
import { outboxEntries, syncNotices } from './queries.js';
import { readPullState } from './state.js';
import {
  customer,
  customerInput,
  newDatabase,
  openCopy,
  product,
  SERVER_KEY,
} from './test-fixtures.js';

// A device on 18b's app: version 2, every row clear
function versionTwo(name: string): Dexie {
  const old = new Dexie(name);
  old.version(1).stores({
    settings: 'key, gen',
    units: 'key, gen',
    productCategories: 'key, gen',
    taxRates: 'key, gen',
    warehouses: 'key, gen',
    priceLists: 'key, gen',
    customerGroups: 'key, gen',
    products: 'key, gen, sortName, sortCode, *barcodes',
    priceListItems: 'key, gen, data.priceListId, data.variantId',
    customers: 'key, gen, sortName',
    stock: 'key, gen, data.warehouseId, data.variantId',
    meta: 'key',
  });
  old.version(2).stores({
    products: 'key, gen, sortName, sortCode, *barcodes, *variantIds',
    outbox: '++seq, key, customerId',
    notices: 'commandId',
  });
  return old;
}

const tasnim = customer({ name: 'Tasnim Pharmacy' });
const SAVED = '2026-10-21T15:00:00.000Z';

function waiting(seq: number): OutboxEntry {
  return {
    seq,
    command: {
      id: uuidv7(),
      type: 'customer.create',
      customerId: tasnim.id,
      input: { ...customerInput({ name: 'Tasnim Pharmacy' }), addresses: [] },
    },
    status: 'waiting',
    sent: true,
    error: null,
    customerId: tasnim.id,
    key: tasnim.id,
    base: null,
    name: 'Tasnim Pharmacy',
    lines: null,
    total: null,
    savedAt: SAVED,
  };
}

const notice: SyncNoticeRecord = {
  commandId: uuidv7(),
  customerId: tasnim.id,
  name: 'Tasnim Pharmacy',
  fields: ['creditLimit'],
  at: '2026-10-21T16:00:00.000Z',
};

async function oldCopy(name: string, entries: OutboxEntry[]): Promise<void> {
  const old = versionTwo(name);
  const shirt = product({ name: 'Polo shirt' });
  await old.table('products').put({
    key: shirt.id,
    gen: 1,
    data: shirt,
    sortName: 'polo shirt',
    sortCode: 'p-0001',
    text: 'polo shirt',
    barcodes: [],
    variantIds: [],
  });
  await old
    .table('customers')
    .put({ key: tasnim.id, gen: 1, data: tasnim, sortName: '', text: '' });
  await old.table('meta').put({ key: 'pull', cursor: 'c-41', generation: 1, full: false });
  await old.table('outbox').bulkPut(entries);
  await old.table('notices').put(notice);
  old.close();
}

describe('SyncDatabase version 3 (step 19b)', () => {
  it('empties the clear copy and keeps the outbox aside until the key opens', async () => {
    const name = `test-${uuidv7()}`;
    // seq 4 and 9: the order survives with its gaps (an auto-increment never reuses a number)
    const entries = [waiting(4), waiting(9)];
    await oldCopy(name, entries);

    const db = newDatabase(name);
    expect(await db.products.count()).toBe(0);
    expect(await db.customers.count()).toBe(0);
    // No cursor: the next pull is a full one, and writes everything back sealed
    expect((await readPullState(db)).cursor).toBeNull();
    expect(await db.outbox.count()).toBe(0);
    expect(await db.legacyOutbox.count()).toBe(2);

    const copy = await openCopy(db);
    expect(await db.legacyOutbox.count()).toBe(0);
    expect(await db.legacyNotices.count()).toBe(0);
    expect(await outboxEntries(copy)).toEqual(entries);
    expect(await syncNotices(copy)).toEqual([notice]);
    // Sealed: the name is not on the disk any more
    const [row] = await db.outbox.toArray();
    expect(new TextDecoder('latin1').decode(row?.box)).not.toContain('Tasnim');
    // A new save comes after them: the auto-increment did not start again
    await saveCustomer(copy, {
      base: null,
      input: customerInput({ name: 'Rahman Traders' }),
      savedAt: SAVED,
    });
    expect((await outboxEntries(copy)).map((entry) => entry.seq ?? 0)[2]).toBeGreaterThan(9);
    copy.close();
    db.close();
  });

  it('moves each waiting entry once when two tabs open the copy at the same time', async () => {
    const name = `test-${uuidv7()}`;
    const entries = [waiting(1)];
    await oldCopy(name, entries);
    const [first, second] = [newDatabase(name), newDatabase(name)];
    // One key for both: the second tab opens the record the first one made
    const [keyOne, keyTwo] = await Promise.all([
      openKey(first, { serverKey: SERVER_KEY }),
      openKey(second, { serverKey: SERVER_KEY }),
    ]);
    if (keyOne.kind !== 'open' || keyTwo.kind !== 'open') throw new Error('not opened');
    const [one, two] = await Promise.all([
      LocalCopy.open(first, keyOne.key),
      LocalCopy.open(second, keyTwo.key),
    ]);
    expect(await outboxEntries(one)).toEqual(entries);
    expect(await outboxEntries(two)).toEqual(entries);
    for (const copy of [one, two]) {
      copy.close();
      copy.db.close();
    }
  });
});
