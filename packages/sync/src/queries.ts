import {
  compareMoney,
  type CustomerSort,
  type CustomerSummary,
  type Product,
  type ProductSort,
  type ProductSummary,
  type SyncCustomer,
} from '@omnivo/contracts';

import type { Table } from 'dexie';

import type {
  CustomerRecord,
  OutboxEntry,
  ProductRecord,
  Stored,
  SyncDatabase,
  SyncNoticeRecord,
} from './database.js';
import { projectCustomer } from './overlay.js';
import { customerMatches, customerRecord, needleOf, productMatches } from './records.js';

// The reads of the products and customers pages and of the pickers. Each is a plain async
// function of the database, so the app runs it inside Dexie's liveQuery (useLiveQuery), and it
// runs again by itself when a pull writes to the tables it read.

// What a list shows: the first `limit` rows in order, and whether there are more. The page asks
// for more as the person scrolls (the DataTable's onEndReached), like a server page.
export interface LocalPage<T> {
  rows: T[];
  more: boolean;
}

// The sorts the device keeps an index for. '-updated' is the server's only.
export type LocalProductSort = Exclude<ProductSort, '-updated'>;
export type LocalCustomerSort = Extract<CustomerSort, 'name' | '-name'>;

export interface LocalProductFilter {
  search: string;
  // The category and every category under it, like the server; null = every product
  categoryIds: ReadonlySet<string> | null;
  sort: LocalProductSort;
  limit: number;
}

// The index walks the rows in order and the filter stops once it has limit + 1 matches: the first
// screen of a long list costs as much as one screen, not the whole table. Two rows with the same
// name come in key (id) order, like the server's (lower(name), id).
export async function productPage(
  db: SyncDatabase,
  filter: LocalProductFilter,
): Promise<LocalPage<Product>> {
  const needle = needleOf(filter.search);
  const index = filter.sort === 'code' || filter.sort === '-code' ? 'sortCode' : 'sortName';
  const ordered = db.products.orderBy(index);
  const found = await (filter.sort.startsWith('-') ? ordered.reverse() : ordered)
    .filter(
      (record: ProductRecord) =>
        (filter.categoryIds === null ||
          (record.data.categoryId !== null && filter.categoryIds.has(record.data.categoryId))) &&
        productMatches(record, needle),
    )
    .limit(filter.limit + 1)
    .toArray();
  return {
    rows: found.slice(0, filter.limit).map((record) => record.data),
    more: found.length > filter.limit,
  };
}

export interface LocalCustomerFilter {
  search: string;
  // '' = every group
  groupId: string;
  sort: LocalCustomerSort;
  limit: number;
}

// The customers the outbox changes (step 18b, decision 34), as the screens show them: the
// server's row with the waiting commands on top, or a customer made on this device. null = the
// device does not have it (a change to a customer archived meanwhile). A handful at most: the
// outbox of one person.
async function pendingCustomers(db: SyncDatabase): Promise<Map<string, SyncCustomer | null>> {
  const entries = await db.outbox.toArray();
  const ids = new Set(
    entries.flatMap((entry) =>
      entry.command.type === 'sales_order.create_draft' ? [] : [entry.customerId],
    ),
  );
  const pending = new Map<string, SyncCustomer | null>();
  for (const id of ids) {
    const row = await db.customers.get(id);
    pending.set(id, projectCustomer(id, row?.data ?? null, entries));
  }
  return pending;
}

// The server's order: lower(name), then the id. Plain `<` compares strings by code unit, the
// way IndexedDB orders its index.
function byName(a: CustomerRecord, b: CustomerRecord): number {
  if (a.sortName !== b.sortName) return a.sortName < b.sortName ? -1 : 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// `pending`: the ids the outbox changes, for the "Not synced" pill
export interface LocalCustomerPage extends LocalPage<SyncCustomer> {
  pending: ReadonlySet<string>;
}

// The walk of the index skips the customers the outbox changes, and their projected rows are put
// back in their place. There are only a few, so the first `limit` of the two lists merged are the
// first `limit` of all: every row past the walk's limit + 1 comes after all of them.
export async function customerPage(
  db: SyncDatabase,
  filter: LocalCustomerFilter,
): Promise<LocalCustomerPage> {
  const needle = needleOf(filter.search);
  const pending = await pendingCustomers(db);
  const matches = (record: CustomerRecord) =>
    (filter.groupId === '' || record.data.groupId === filter.groupId) &&
    customerMatches(record, needle);
  const ordered = db.customers.orderBy('sortName');
  const walked = await (filter.sort === '-name' ? ordered.reverse() : ordered)
    .filter((record: CustomerRecord) => !pending.has(record.key) && matches(record))
    .limit(filter.limit + 1)
    .toArray();
  const projected = [...pending.values()]
    .flatMap((row) => (row?.archivedAt !== null ? [] : [customerRecord(row.id, 0, row)]))
    .filter(matches);
  const direction = filter.sort === '-name' ? -1 : 1;
  const found = [...walked, ...projected].sort((a, b) => direction * byName(a, b));
  return {
    rows: found.slice(0, filter.limit).map((record) => record.data),
    more: found.length > filter.limit,
    pending: new Set(pending.keys()),
  };
}

// One customer as the screens show it: the server's row with the outbox on top (step 18b). null =
// not on this device.
export async function localCustomer(
  db: SyncDatabase,
  customerId: string,
): Promise<SyncCustomer | null> {
  const [row, entries] = await Promise.all([
    db.customers.get(customerId),
    db.outbox.where('customerId').equals(customerId).sortBy('seq'),
  ]);
  return projectCustomer(customerId, row?.data ?? null, entries);
}

// The pickers: the first 20 that match, by name, like the server's search
export const PICKER_LIMIT = 20;

export async function findProducts(db: SyncDatabase, search: string): Promise<Product[]> {
  const page = await productPage(db, {
    search,
    categoryIds: null,
    sort: 'name',
    limit: PICKER_LIMIT,
  });
  return page.rows;
}

export async function findCustomers(db: SyncDatabase, search: string): Promise<SyncCustomer[]> {
  const page = await customerPage(db, { search, groupId: '', sort: 'name', limit: PICKER_LIMIT });
  return page.rows;
}

// A small table whole, as the server's rows (units, categories, groups: tens of rows)
export async function allRows<T>(table: Table<Stored<T>, string>): Promise<T[]> {
  return (await table.toArray()).map((record) => record.data);
}

// The list's row from the whole product, the way the server's list works it out
// (products.service.ts): the active variants only, their lowest and highest sale price
export function productSummaryOf(product: Product): ProductSummary {
  const active = product.variants.filter((variant) => variant.archivedAt === null);
  const prices = active
    .map((variant) => variant.salePrice)
    .filter((price) => price !== null)
    .sort(compareMoney);
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    type: product.type,
    categoryId: product.categoryId,
    baseUnitId: product.baseUnitId,
    tracking: product.tracking,
    hasVariants: product.options.length > 0,
    variantCount: active.length,
    minPrice: prices[0] ?? null,
    maxPrice: prices.at(-1) ?? null,
    archivedAt: product.archivedAt,
    updatedAt: product.updatedAt,
  };
}

// The balance is not on the device (decision 10): null here, filled in by the page when it can
export function customerSummaryOf(customer: SyncCustomer): CustomerSummary {
  return {
    id: customer.id,
    code: customer.code,
    name: customer.name,
    groupId: customer.groupId,
    contactPerson: customer.contactPerson,
    phone: customer.phone,
    paymentTermsDays: customer.paymentTermsDays,
    creditLimit: customer.creditLimit,
    balance: null,
    archivedAt: customer.archivedAt,
    updatedAt: customer.updatedAt,
  };
}

// ---------------------------------------------------------------------------------------------
// The outbox (step 18b)

// Every waiting command, oldest first (the primary key is the seq)
export function outboxEntries(db: SyncDatabase): Promise<OutboxEntry[]> {
  return db.outbox.toArray();
}

// The commands of one customer or one order: a form opens its waiting command by its key, and a
// customer with commands is changed through the outbox, even online (decision 2)
export function outboxOf(db: SyncDatabase, key: string): Promise<OutboxEntry[]> {
  return db.outbox.where('key').equals(key).sortBy('seq');
}

export function customerCommands(db: SyncDatabase, customerId: string): Promise<OutboxEntry[]> {
  return db.outbox.where('customerId').equals(customerId).sortBy('seq');
}

// What the sidebar counts: every command on the device, and the refused ones among them
export async function outboxCounts(db: SyncDatabase): Promise<{ total: number; failed: number }> {
  const entries = await db.outbox.toArray();
  return {
    total: entries.length,
    failed: entries.filter((entry) => entry.status === 'failed').length,
  };
}

// The kept-from-the-server notices, newest first
export async function syncNotices(db: SyncDatabase): Promise<SyncNoticeRecord[]> {
  return (await db.notices.toArray()).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
