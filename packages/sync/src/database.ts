import type {
  Product,
  SyncCategory,
  SyncCommand,
  SyncCommandError,
  SyncCustomer,
  SyncCustomerGroup,
  SyncEntity,
  SyncPriceList,
  SyncPriceListItem,
  SyncSettings,
  SyncStock,
  TaxRate,
  Unit,
  Warehouse,
} from '@omnivo/contracts';
import { Dexie, type Table } from 'dexie';

import type { Box } from './crypto.js';
import type { KeyRecord } from './keys.js';

// One row on the device (step 19b): the row the server sent, sealed (`box`), under the key of its
// change, and the generation of the pull that wrote it. The generation is how a full pull finds the
// rows it did not send (apply.ts). What is in the box is never changed on the device: it is the
// server's row as it came. Only the key, the generation and a few ids an index needs stay clear.
export interface SealedRow<T> {
  // The row's id, or priceListItemKey() / stockKey(); the settings' key is the workspace's id
  key: string;
  gen: number;
  box: Box<T>;
}

// The barcodes are clear for a scanner (step 20), and the variant ids for a sale line (18b), which
// finds its product by one of them. Names, codes and prices are only in the box: a list sorts and
// searches them in memory (copy.ts).
export interface ProductRow extends SealedRow<Product> {
  barcodes: string[];
  variantIds: string[];
}

// A sale line looks up its price and its stock by these ids (step 18b). They were key paths into
// the server's row before step 19b (`data.priceListId`); the row is sealed now, so they are copied
// out of it.
export interface PriceListItemRow extends SealedRow<SyncPriceListItem> {
  priceListId: string;
  variantId: string;
}

export interface StockRow extends SealedRow<SyncStock> {
  warehouseId: string;
  variantId: string;
}

// Step 19b: the two tables the app keeps opened in memory (copy.ts), and how many times each was
// written. A write to one counts up its mark in the same transaction; a list waits until the
// in-memory copy has caught up with the mark it reads, so it never shows a half-done write.
export type MirroredTable = 'products' | 'customers';

export interface TableMark {
  table: MirroredTable;
  version: number;
}

// Where a pull is: one row in `meta`, under the key 'pull'
export interface PullState {
  key: 'pull';
  // The cursor to send next: the last page's. null = nothing pulled yet, so a full pull.
  cursor: string | null;
  // The generation every row is written with now. A full pull starts a new one.
  generation: number;
  // A full pull is under way: its last page has not come yet
  full: boolean;
  // The server's clock at the end of the last pull that finished. null = no pull has finished,
  // so the device has no complete copy yet.
  lastSyncAt: string | null;
  // Step 18c: this device's own clock at that moment (ms since 1970), for the time limits. A copy
  // made before step 18c has no value here until its next pull ends (readPullState gives null).
  syncedAt: number | null;
  // The rows the running (or the last) full pull wrote, for "1,250 items copied so far"
  copied: number;
}

// Step 18b: one thing the person did on this device, waiting to reach the server. The outbox is in
// the same database as the copy, so signing out deletes both (the app asks first).
export type OutboxStatus = 'waiting' | 'sending' | 'failed';

// An outbox entry as the code works with it: the row opened (sealed.ts). The rows themselves are
// OutboxRow, below.
export interface OutboxEntry {
  // The order the person did things in: the push sends the outbox by seq, oldest first.
  // Auto-increment, so it is missing until Dexie adds the row.
  seq?: number;
  // What the server gets, as the schema reads it (its output). Its own id is the command's id.
  command: SyncCommand;
  // waiting: not sent, or sent with no answer yet. sending: in the push that runs now.
  // failed: the server refused it (error), so it never ran.
  status: OutboxStatus;
  // Sent at least once. A sent command with no answer may have run on the server (the answer was
  // lost), so it is sent again as it is, and never rewritten (decision 33).
  sent: boolean;
  error: SyncCommandError | null;
  // The customer the command is about: its own, or the order's. Two commands on one customer
  // reach the server in the order they were made (decision 13).
  customerId: string;
  // The thing the command makes or changes: the customer, or the order. A form opens its
  // waiting command by it.
  key: string;
  // A change to a customer: the customer as the person saw it when they started, so a second edit
  // keeps the first `from` values. null for the other commands.
  base: SyncCustomer | null;
  // What the Sync page calls it: the customer's name
  name: string;
  // An order: its lines and total, for the Sync page and the unsynced orders. null otherwise.
  lines: number | null;
  total: string | null;
  // When it was saved, by this device's clock: shown, never sent (decision 6)
  savedAt: string;
}

// The part of an entry that is sealed: everything a person typed or read
export type OutboxBody = Pick<
  OutboxEntry,
  'command' | 'error' | 'base' | 'name' | 'lines' | 'total' | 'savedAt'
>;

// Step 19b: an outbox row. What the push and the sidebar need without the key stays clear: ids,
// the command's type, its state and its size. The push picks a batch, marks it and counts the
// outbox from these alone, inside one transaction (a transaction cannot wait for Web Crypto).
export interface OutboxRow extends Pick<
  OutboxEntry,
  'seq' | 'status' | 'sent' | 'customerId' | 'key'
> {
  // The command's id: the box is sealed under it, and an answer finds its row by it
  commandId: string;
  type: SyncCommand['type'];
  // The command's size as JSON, for the 512 KB limit of a push (push.ts)
  bytes: number;
  box: Box<OutboxBody>;
}

// A head-office field the server kept (a kept_server_value notice), shown on the Sync page until
// the person dismisses it. The command itself is gone: it was accepted.
export interface SyncNoticeRecord {
  commandId: string;
  customerId: string;
  name: string;
  fields: string[];
  // The server's time of the push that brought it
  at: string;
}

// Step 19b: a notice is sealed whole; its command's id is the row's key
export interface NoticeRow {
  commandId: string;
  box: Box<SyncNoticeRecord>;
}

// The tables, by entity. The names are the ones the app reads (db.products, db.customers).
export const TABLE_OF = {
  settings: 'settings',
  unit: 'units',
  product_category: 'productCategories',
  tax_rate: 'taxRates',
  warehouse: 'warehouses',
  price_list: 'priceLists',
  customer_group: 'customerGroups',
  product: 'products',
  price_list_item: 'priceListItems',
  customer: 'customers',
  stock: 'stock',
} as const satisfies Record<SyncEntity, string>;
export type SyncTableName = (typeof TABLE_OF)[SyncEntity];

// One local database per person and workspace: two people on one shop computer never read each
// other's copy, and a person in two workspaces keeps both.
export function databaseName(tenantId: string, userId: string): string {
  return `omnivo-${tenantId}-${userId}`;
}

// Signing out deletes the copy (decision 41): the next person at a shop computer cannot read it
// in the browser's tools. A tab still holding it open closes it by itself: Dexie closes a
// database when another connection asks to delete it.
export async function deleteLocalDatabase(tenantId: string, userId: string): Promise<void> {
  await Dexie.delete(databaseName(tenantId, userId));
}

export class SyncDatabase extends Dexie {
  // `!`: Dexie makes these properties itself, from the stores() below
  settings!: Table<SealedRow<SyncSettings>, string>;
  units!: Table<SealedRow<Unit>, string>;
  productCategories!: Table<SealedRow<SyncCategory>, string>;
  taxRates!: Table<SealedRow<TaxRate>, string>;
  warehouses!: Table<SealedRow<Warehouse>, string>;
  priceLists!: Table<SealedRow<SyncPriceList>, string>;
  customerGroups!: Table<SealedRow<SyncCustomerGroup>, string>;
  products!: Table<ProductRow, string>;
  priceListItems!: Table<PriceListItemRow, string>;
  customers!: Table<SealedRow<SyncCustomer>, string>;
  stock!: Table<StockRow, string>;
  meta!: Table<PullState, string>;
  outbox!: Table<OutboxRow, number>;
  notices!: Table<NoticeRow, string>;
  // Step 19b: the data key, wrapped (keys.ts). One row.
  keys!: Table<KeyRecord, string>;
  marks!: Table<TableMark, string>;
  // Step 19b: the outbox and the notices of version 2, still clear, until the key opens and
  // copy.ts seals them (an upgrade cannot wait for Web Crypto). Empty after that.
  legacyOutbox!: Table<OutboxEntry, number>;
  legacyNotices!: Table<SyncNoticeRecord, string>;

  constructor(name: string) {
    super(name);
    // The first word is the primary key; the others are indexes. `gen` on every synced table:
    // the end of a full pull deletes the rows of older generations with one range each.
    // `*barcodes` is a multi-entry index (one entry per barcode), for a scanner (step 20).
    // `data.priceListId`, `data.warehouseId` and the others are key paths into the server's row:
    // a sale line (18b) looks up its price and its stock by them.
    this.version(1).stores({
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
    // Step 18b: the outbox and its notices, and the products by variant. The copy stays: Dexie
    // keeps the tables of version 1, adds the new ones, and the upgrade fills the new field of the
    // products it already has. `++seq` counts up by itself. `key` and `customerId` find a form's
    // waiting command and the commands of one customer.
    this.version(2)
      .stores({
        products: 'key, gen, sortName, sortCode, *barcodes, *variantIds',
        outbox: '++seq, key, customerId',
        notices: 'commandId',
      })
      .upgrade(async (tx) => {
        await tx
          .table<{ data: Product; variantIds: string[] }, string>('products')
          .toCollection()
          .modify((record) => {
            record.variantIds = record.data.variants.map((variant) => variant.id);
          });
      });
    // Step 19b: sealed rows. The synced tables are emptied and the pull starts again from nothing:
    // a full pull writes them back sealed, so no clear copy stays on the disk. The outbox and its
    // notices are the person's own work and must not be lost: they move to the legacy tables as
    // they are, and copy.ts seals them back into the outbox once the key opens (an upgrade runs in
    // one transaction, which cannot wait for Web Crypto). The ids an index needs are now copied
    // out of the row (priceListId, warehouseId, variantId); the name and code indexes go, because
    // a name in an index would be clear on the disk.
    this.version(3)
      .stores({
        products: 'key, gen, *barcodes, *variantIds',
        priceListItems: 'key, gen, priceListId, variantId',
        customers: 'key, gen',
        stock: 'key, gen, warehouseId, variantId',
        keys: 'key',
        marks: 'table',
        legacyOutbox: 'seq',
        legacyNotices: 'commandId',
      })
      .upgrade(async (tx) => {
        for (const name of Object.values(TABLE_OF)) await tx.table(name).clear();
        await tx.table('meta').delete('pull');
        const outbox = tx.table<OutboxEntry, number>('outbox');
        await tx.table<OutboxEntry, number>('legacyOutbox').bulkAdd(await outbox.toArray());
        await outbox.clear();
        const notices = tx.table<SyncNoticeRecord, string>('notices');
        await tx.table<SyncNoticeRecord, string>('legacyNotices').bulkAdd(await notices.toArray());
        await notices.clear();
      });
  }

  // Every synced table, to sweep or clear them all. Not `this.tables`, which has `meta` too.
  syncTables() {
    return Object.values(TABLE_OF).map((name) => this[name]);
  }

  // Step 19b: one write more to a mirrored table. Called inside the transaction that wrote it.
  async markWritten(table: MirroredTable): Promise<void> {
    const mark = await this.marks.get(table);
    await this.marks.put({ table, version: (mark?.version ?? 0) + 1 });
  }
}
