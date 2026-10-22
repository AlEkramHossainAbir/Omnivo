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

// One row on the device: the row the server sent (`data`), under the key of its change, and the
// generation of the pull that wrote it. The generation is how a full pull finds the rows it did
// not send (apply.ts). `data` is never changed on the device: it is the server's row as it came.
export interface Stored<T> {
  // The row's id, or priceListItemKey() / stockKey(); the settings' key is the workspace's id
  key: string;
  gen: number;
  data: T;
}

// A product with what its list needs to search and sort without opening every row: the server
// sorts on lower(name) and lower(code), so the device does too.
export interface ProductRecord extends Stored<Product> {
  sortName: string;
  sortCode: string;
  // The name, the code and the SKUs in lower case, for "contains"
  text: string;
  // Every barcode of the product: its variants' and its packs'. A barcode is matched whole.
  barcodes: string[];
  // Its variants' ids (step 18b): the order form offline finds a line's product by its variant
  variantIds: string[];
}

export interface CustomerRecord extends Stored<SyncCustomer> {
  sortName: string;
  // The name, the code, the contact person and the phone in lower case, for "contains"
  text: string;
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
  // The rows the running (or the last) full pull wrote, for "1,250 items copied so far"
  copied: number;
}

// Step 18b: one thing the person did on this device, waiting to reach the server. The outbox is in
// the same database as the copy, so signing out deletes both (the app asks first).
export type OutboxStatus = 'waiting' | 'sending' | 'failed';

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
  settings!: Table<Stored<SyncSettings>, string>;
  units!: Table<Stored<Unit>, string>;
  productCategories!: Table<Stored<SyncCategory>, string>;
  taxRates!: Table<Stored<TaxRate>, string>;
  warehouses!: Table<Stored<Warehouse>, string>;
  priceLists!: Table<Stored<SyncPriceList>, string>;
  customerGroups!: Table<Stored<SyncCustomerGroup>, string>;
  products!: Table<ProductRecord, string>;
  priceListItems!: Table<Stored<SyncPriceListItem>, string>;
  customers!: Table<CustomerRecord, string>;
  stock!: Table<Stored<SyncStock>, string>;
  meta!: Table<PullState, string>;
  outbox!: Table<OutboxEntry, number>;
  notices!: Table<SyncNoticeRecord, string>;

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
          .table<ProductRecord, string>('products')
          .toCollection()
          .modify((record) => {
            record.variantIds = record.data.variants.map((variant) => variant.id);
          });
      });
  }

  // Every synced table, to sweep or clear them all. Not `this.tables`, which has `meta` too.
  syncTables() {
    return Object.values(TABLE_OF).map((name) => this[name]);
  }
}
