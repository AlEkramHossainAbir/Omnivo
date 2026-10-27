import type {
  SyncCategory,
  SyncChange,
  SyncCustomer,
  SyncCustomerGroup,
  SyncPriceList,
  SyncPull,
  SyncSettings,
  TaxRate,
  Unit,
  Warehouse,
} from '@omnivo/contracts';

import type { LocalCopy } from './copy.js';
import type {
  PriceListItemRow,
  ProductRow,
  PullState,
  SealedRow,
  StockRow,
  SyncDatabase,
  SyncTableName,
} from './database.js';
import { TABLE_OF } from './database.js';
import { productIndex } from './records.js';
import { readPullState } from './state.js';

// A row before the transaction gives it its generation (step 19b): it is sealed first, and the
// generation is only known inside the transaction, from the pull's state
type Unstamped<R> = Omit<R, 'gen'>;

// The rows of one page, sealed and grouped by table. Typed per table, so a product can only go
// into `products`: one `Record<string, unknown[]>` would need a cast to write them.
export interface SealedChanges {
  puts: {
    settings: Unstamped<SealedRow<SyncSettings>>[];
    units: Unstamped<SealedRow<Unit>>[];
    productCategories: Unstamped<SealedRow<SyncCategory>>[];
    taxRates: Unstamped<SealedRow<TaxRate>>[];
    warehouses: Unstamped<SealedRow<Warehouse>>[];
    priceLists: Unstamped<SealedRow<SyncPriceList>>[];
    customerGroups: Unstamped<SealedRow<SyncCustomerGroup>>[];
    products: Unstamped<ProductRow>[];
    priceListItems: Unstamped<PriceListItemRow>[];
    customers: Unstamped<SealedRow<SyncCustomer>>[];
    stock: Unstamped<StockRow>[];
  };
  deletes: Map<SyncTableName, string[]>;
}

async function boxed<T>(
  copy: LocalCopy,
  table: SyncTableName,
  key: string,
  data: T,
): Promise<Unstamped<SealedRow<T>>> {
  return { key, box: await copy.seal(table, key, data) };
}

// Every row of the changes sealed, at once (Promise.all): one seal is quick, but 500 one after
// another would each wait for its own turn of the event loop. Done before the transaction:
// IndexedDB commits a transaction that waits for anything else, and Web Crypto is something else.
export async function sealChanges(
  copy: LocalCopy,
  changes: readonly SyncChange[],
): Promise<SealedChanges> {
  const sealed: SealedChanges = {
    puts: {
      settings: [],
      units: [],
      productCategories: [],
      taxRates: [],
      warehouses: [],
      priceLists: [],
      customerGroups: [],
      products: [],
      priceListItems: [],
      customers: [],
      stock: [],
    },
    deletes: new Map(),
  };
  const { puts, deletes } = sealed;
  await Promise.all(
    changes.map(async (change) => {
      if (change.op === 'delete') {
        const table = TABLE_OF[change.entity];
        deletes.set(table, [...(deletes.get(table) ?? []), change.key]);
        return;
      }
      // A switch on the entity narrows `data` to its own type in each case
      const { key } = change;
      switch (change.entity) {
        case 'settings':
          puts.settings.push(await boxed(copy, 'settings', key, change.data));
          break;
        case 'unit':
          puts.units.push(await boxed(copy, 'units', key, change.data));
          break;
        case 'product_category':
          puts.productCategories.push(await boxed(copy, 'productCategories', key, change.data));
          break;
        case 'tax_rate':
          puts.taxRates.push(await boxed(copy, 'taxRates', key, change.data));
          break;
        case 'warehouse':
          puts.warehouses.push(await boxed(copy, 'warehouses', key, change.data));
          break;
        case 'price_list':
          puts.priceLists.push(await boxed(copy, 'priceLists', key, change.data));
          break;
        case 'customer_group':
          puts.customerGroups.push(await boxed(copy, 'customerGroups', key, change.data));
          break;
        case 'product':
          puts.products.push({
            ...(await boxed(copy, 'products', key, change.data)),
            ...productIndex(change.data),
          });
          break;
        case 'price_list_item':
          puts.priceListItems.push({
            ...(await boxed(copy, 'priceListItems', key, change.data)),
            priceListId: change.data.priceListId,
            variantId: change.data.variantId,
          });
          break;
        case 'customer':
          puts.customers.push(await boxed(copy, 'customers', key, change.data));
          break;
        case 'stock':
          puts.stock.push({
            ...(await boxed(copy, 'stock', key, change.data)),
            warehouseId: change.data.warehouseId,
            variantId: change.data.variantId,
          });
          break;
      }
    }),
  );
  return sealed;
}

// Which generation this page's rows get, and whether it starts a new full pull. A full page
// starts a new generation when the device was not in a full pull, or when it sent no cursor (the
// server started from the beginning, so whatever an earlier full pull wrote does not count).
// Every later page of that full pull writes the same generation.
function nextState(
  state: PullState,
  page: SyncPull,
  sentCursor: string | null,
  now: number,
): PullState {
  const starts = page.full && (!state.full || sentCursor === null);
  const generation = starts ? state.generation + 1 : state.generation;
  const upserts = page.changes.filter((change) => change.op === 'upsert').length;
  return {
    key: 'pull',
    cursor: page.cursor,
    generation,
    // A delta page while a full pull was open cannot happen (the server answers a full pull's
    // cursor with full pages); if it ever does, the full pull is given up, and the next one
    // starts a new generation that sweeps whatever this one left.
    full: page.full && page.hasMore,
    lastSyncAt: page.hasMore ? state.lastSyncAt : page.serverTime,
    syncedAt: page.hasMore ? state.syncedAt : now,
    copied: starts ? upserts : page.full ? state.copied + upserts : state.copied,
  };
}

function stamp<R>(rows: readonly R[], gen: number) {
  return rows.map((row) => ({ ...row, gen }));
}

// Sealed rows into their tables, with the generation given. Called inside a transaction that holds
// every synced table and the marks: a page of the pull (below), or the rows a push's answer sent
// back (push.ts).
export async function writeSealed(
  db: SyncDatabase,
  { puts, deletes }: SealedChanges,
  gen: number,
): Promise<void> {
  for (const [table, keys] of deletes) await db[table].bulkDelete(keys);
  // A key is in a page at most once (the contract), so no row is both put and deleted here
  await db.settings.bulkPut(stamp(puts.settings, gen));
  await db.units.bulkPut(stamp(puts.units, gen));
  await db.productCategories.bulkPut(stamp(puts.productCategories, gen));
  await db.taxRates.bulkPut(stamp(puts.taxRates, gen));
  await db.warehouses.bulkPut(stamp(puts.warehouses, gen));
  await db.priceLists.bulkPut(stamp(puts.priceLists, gen));
  await db.customerGroups.bulkPut(stamp(puts.customerGroups, gen));
  await db.products.bulkPut(stamp(puts.products, gen));
  await db.priceListItems.bulkPut(stamp(puts.priceListItems, gen));
  await db.customers.bulkPut(stamp(puts.customers, gen));
  await db.stock.bulkPut(stamp(puts.stock, gen));
  // Step 19b: only a write that touched them, so a page of stock alone leaves the in-memory
  // copies as they are
  if (puts.products.length > 0 || deletes.has('products')) await db.markWritten('products');
  if (puts.customers.length > 0 || deletes.has('customers')) await db.markWritten('customers');
}

// One page into the database, in one transaction: the rows, the deletes and the cursor are
// saved together or not at all. A tab closed half way through a page leaves the old cursor, and
// the same page comes again; its upserts and deletes give the same result twice. `now` is the
// device's clock (step 18c), a parameter so a test can set it. Step 19b: the rows are sealed
// before the transaction starts (sealChanges).
export async function applyPage(
  copy: LocalCopy,
  page: SyncPull,
  sentCursor: string | null,
  now: number = Date.now(),
): Promise<PullState> {
  const { db } = copy;
  const sealed = await sealChanges(copy, page.changes);
  return db.transaction('rw', [...db.syncTables(), db.meta, db.marks], async () => {
    const state = nextState(await readPullState(db), page, sentCursor, now);
    await writeSealed(db, sealed, state.generation);
    // The last page of a full pull: every row it did not send is older than its generation, and
    // goes (decision 17). Until now, the lists kept showing them.
    if (page.full && !page.hasMore) {
      for (const name of Object.values(TABLE_OF)) {
        const swept = await db[name].where('gen').below(state.generation).delete();
        if (swept > 0 && (name === 'products' || name === 'customers')) {
          await db.markWritten(name);
        }
      }
    }
    await db.meta.put(state);
    return state;
  });
}
