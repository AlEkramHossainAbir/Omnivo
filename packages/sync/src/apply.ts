import type {
  SyncCategory,
  SyncChange,
  SyncCustomerGroup,
  SyncPriceList,
  SyncPriceListItem,
  SyncPull,
  SyncSettings,
  SyncStock,
  TaxRate,
  Unit,
  Warehouse,
} from '@omnivo/contracts';

import {
  type CustomerRecord,
  type ProductRecord,
  type PullState,
  type Stored,
  type SyncDatabase,
  type SyncTableName,
  TABLE_OF,
} from './database.js';
import { customerRecord, productRecord } from './records.js';
import { readPullState } from './state.js';

// The rows of one page, grouped by table. Typed per table, so a product can only go into
// `products`: one `Record<string, unknown[]>` would need a cast to write them.
interface Writes {
  settings: Stored<SyncSettings>[];
  units: Stored<Unit>[];
  productCategories: Stored<SyncCategory>[];
  taxRates: Stored<TaxRate>[];
  warehouses: Stored<Warehouse>[];
  priceLists: Stored<SyncPriceList>[];
  customerGroups: Stored<SyncCustomerGroup>[];
  products: ProductRecord[];
  priceListItems: Stored<SyncPriceListItem>[];
  customers: CustomerRecord[];
  stock: Stored<SyncStock>[];
}

function emptyWrites(): Writes {
  return {
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
  };
}

function groupChanges(changes: readonly SyncChange[], gen: number) {
  const puts = emptyWrites();
  const deletes = new Map<SyncTableName, string[]>();
  for (const change of changes) {
    if (change.op === 'delete') {
      const table = TABLE_OF[change.entity];
      deletes.set(table, [...(deletes.get(table) ?? []), change.key]);
      continue;
    }
    // A switch on the entity narrows `data` to its own type in each case
    const { key } = change;
    switch (change.entity) {
      case 'settings':
        puts.settings.push({ key, gen, data: change.data });
        break;
      case 'unit':
        puts.units.push({ key, gen, data: change.data });
        break;
      case 'product_category':
        puts.productCategories.push({ key, gen, data: change.data });
        break;
      case 'tax_rate':
        puts.taxRates.push({ key, gen, data: change.data });
        break;
      case 'warehouse':
        puts.warehouses.push({ key, gen, data: change.data });
        break;
      case 'price_list':
        puts.priceLists.push({ key, gen, data: change.data });
        break;
      case 'customer_group':
        puts.customerGroups.push({ key, gen, data: change.data });
        break;
      case 'product':
        puts.products.push(productRecord(key, gen, change.data));
        break;
      case 'price_list_item':
        puts.priceListItems.push({ key, gen, data: change.data });
        break;
      case 'customer':
        puts.customers.push(customerRecord(key, gen, change.data));
        break;
      case 'stock':
        puts.stock.push({ key, gen, data: change.data });
        break;
    }
  }
  return { puts, deletes };
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

// Rows into their tables, with the generation given. Called inside a transaction that holds every
// synced table: a page of the pull (below), or the rows a push's answer sent back (push.ts).
export async function writeChanges(
  db: SyncDatabase,
  changes: readonly SyncChange[],
  gen: number,
): Promise<void> {
  const { puts, deletes } = groupChanges(changes, gen);
  for (const [table, keys] of deletes) await db[table].bulkDelete(keys);
  // A key is in a page at most once (the contract), so no row is both put and deleted here
  await db.settings.bulkPut(puts.settings);
  await db.units.bulkPut(puts.units);
  await db.productCategories.bulkPut(puts.productCategories);
  await db.taxRates.bulkPut(puts.taxRates);
  await db.warehouses.bulkPut(puts.warehouses);
  await db.priceLists.bulkPut(puts.priceLists);
  await db.customerGroups.bulkPut(puts.customerGroups);
  await db.products.bulkPut(puts.products);
  await db.priceListItems.bulkPut(puts.priceListItems);
  await db.customers.bulkPut(puts.customers);
  await db.stock.bulkPut(puts.stock);
}

// One page into the database, in one transaction: the rows, the deletes and the cursor are
// saved together or not at all. A tab closed half way through a page leaves the old cursor, and
// the same page comes again; its upserts and deletes give the same result twice. `now` is the
// device's clock (step 18c), a parameter so a test can set it.
export async function applyPage(
  db: SyncDatabase,
  page: SyncPull,
  sentCursor: string | null,
  now: number = Date.now(),
): Promise<PullState> {
  return db.transaction('rw', [...db.syncTables(), db.meta], async () => {
    const state = nextState(await readPullState(db), page, sentCursor, now);
    await writeChanges(db, page.changes, state.generation);
    // The last page of a full pull: every row it did not send is older than its generation, and
    // goes (decision 17). Until now, the lists kept showing them.
    if (page.full && !page.hasMore) {
      for (const table of db.syncTables()) {
        await table.where('gen').below(state.generation).delete();
      }
    }
    await db.meta.put(state);
    return state;
  });
}
