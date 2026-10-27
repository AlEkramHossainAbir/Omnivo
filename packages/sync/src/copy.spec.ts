import 'fake-indexeddb/auto';

import { uuidv7 } from 'uuidv7';
import { describe, expect, it, vi } from 'vitest';

import { applyPage } from './apply.js';
import { watch } from './live.js';
import { saveCustomer } from './outbox.js';
import { allRows, customerPage, productPage } from './queries.js';
import {
  customer,
  customerInput,
  newDatabase,
  openCopy,
  page,
  product,
  upsertCustomer,
  upsertProduct,
} from './test-fixtures.js';

const shirt = product({ name: 'Polo shirt', code: 'FG-0001' });
const trouser = product({ name: 'Chino trouser', code: 'FG-0002' });
const jacket = product({ name: 'Denim jacket', code: 'FG-0003' });
const ALL = { search: '', categoryIds: null, sort: 'name', limit: 10 } as const;

const names = (rows: readonly { name: string }[]) => rows.map((row) => row.name);

describe('LocalCopy', () => {
  it('follows a write made in another tab before a list reads it', async () => {
    const name = `test-${uuidv7()}`;
    // Two connections to one database: two tabs of the same browser
    const here = await openCopy(newDatabase(name));
    const there = await openCopy(newDatabase(name));
    await applyPage(there, page({ full: true, changes: [upsertProduct(shirt)] }), null);
    // No waiting in the test: the read waits for the in-memory copy to reach the write's mark
    expect(names((await productPage(here, ALL)).rows)).toEqual(['Polo shirt']);
    for (const copy of [here, there]) {
      copy.close();
      copy.db.close();
    }
  });

  it('opens again only the rows a write changed', async () => {
    const copy = await openCopy(newDatabase());
    const full = page({
      full: true,
      changes: [shirt, trouser, jacket].map(upsertProduct),
    });
    await applyPage(copy, full, null);
    await productPage(copy, ALL);
    const open = vi.spyOn(copy, 'open');
    await applyPage(
      copy,
      page({ changes: [upsertProduct({ ...shirt, name: 'Polo shirt (piqué)' })] }),
      full.cursor,
    );
    expect(names((await productPage(copy, ALL)).rows)).toEqual([
      'Chino trouser',
      'Denim jacket',
      'Polo shirt (piqué)',
    ]);
    expect(open.mock.calls.map(([table]) => table)).toEqual(['products']);
    copy.close();
  });

  it('runs a watched list again when a pull writes a customer, after opening the outbox', async () => {
    const copy = await openCopy(newDatabase());
    // One waiting command: the list opens it (Web Crypto) before it reads the customers' mark,
    // so the mark is read after an await that Dexie did not make (crypto.ts → unseal)
    await saveCustomer(copy, {
      base: null,
      input: customerInput({ name: 'Tasnim Pharmacy' }),
      savedAt: '2026-10-21T15:00:00.000Z',
    });
    const seen: string[][] = [];
    const stop = watch(
      () => customerPage(copy, { search: '', groupId: '', sort: 'name', limit: 10 }),
      (found) => seen.push(names(found.rows)),
      () => undefined,
    );
    await vi.waitFor(() => {
      expect(seen.at(-1)).toEqual(['Tasnim Pharmacy']);
    });
    await applyPage(
      copy,
      page({ full: true, changes: [upsertCustomer(customer({ name: 'Rahman Traders' }))] }),
      null,
    );
    await vi.waitFor(() => {
      expect(seen.at(-1)).toEqual(['Rahman Traders', 'Tasnim Pharmacy']);
    });
    stop();
    copy.close();
  });

  it('keeps following a read made after opening a row, or after current()', async () => {
    const copy = await openCopy(newDatabase());
    await applyPage(copy, page({ full: true, changes: [upsertProduct(shirt)] }), null);
    const { db } = copy;
    const counts: number[][] = [];
    // A read of IndexedDB after each kind of wait that Dexie did not make itself. Without the wrap
    // in crypto.ts → unseal, liveQuery would stop following after the open, and the unit added
    // below would never show.
    const stop = watch(
      async () => {
        const row = await db.products.get(shirt.id);
        if (row) await copy.open('products', row.key, row.box);
        const afterOpen = await db.units.count();
        await copy.products.current();
        const afterCurrent = await db.taxRates.count();
        return [afterOpen, afterCurrent];
      },
      (value) => counts.push(value),
      () => undefined,
    );
    await vi.waitFor(() => {
      expect(counts.at(-1)).toEqual([0, 0]);
    });
    // Rows of any content: only the counts are read
    await db.units.put({ key: 'u-pcs', gen: 1, box: new Uint8Array(0) });
    await vi.waitFor(() => {
      expect(counts.at(-1)).toEqual([1, 0]);
    });
    await db.taxRates.put({ key: 't-15', gen: 1, box: new Uint8Array(0) });
    await vi.waitFor(() => {
      expect(counts.at(-1)).toEqual([1, 1]);
    });
    // A product written: this run waits in current() until the in-memory copy has it, and the
    // read after that wait is still followed
    await applyPage(copy, page({ changes: [upsertProduct(trouser)] }), 'cursor');
    await db.taxRates.put({ key: 't-5', gen: 1, box: new Uint8Array(0) });
    await vi.waitFor(() => {
      expect(counts.at(-1)).toEqual([1, 2]);
    });
    stop();
    copy.close();
  });

  it('reads nothing once it is locked', async () => {
    const copy = await openCopy(newDatabase());
    await applyPage(copy, page({ full: true, changes: [upsertProduct(shirt)] }), null);
    copy.close();
    await expect(productPage(copy, ALL)).rejects.toThrow('locked');
    await expect(allRows(copy, copy.db.units)).resolves.toEqual([]);
    const [row] = await copy.db.products.toArray();
    if (!row) throw new Error('no row');
    // At once, not a rejected promise: every caller awaits it inside an async function
    expect(() => copy.open('products', row.key, row.box)).toThrow('locked');
  });

  it('does not open a row moved under another key', async () => {
    const copy = await openCopy(newDatabase());
    await applyPage(copy, page({ full: true, changes: [shirt, trouser].map(upsertProduct) }), null);
    const shirtRow = await copy.db.products.get(shirt.id);
    if (!shirtRow) throw new Error('no row');
    // The shirt's box put in the trouser's place, by someone with the browser's tools
    await copy.db.products.put({ ...shirtRow, key: trouser.id });
    await expect(allRows(copy, copy.db.products)).rejects.toThrow();
    copy.close();
  });
});
