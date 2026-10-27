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

import type { LocalCopy } from './copy.js';
import type { OutboxEntry, SealedRow, SyncNoticeRecord } from './database.js';
import { projectCustomer } from './overlay.js';
import {
  type CustomerRecord,
  customerMatches,
  customerRecord,
  needleOf,
  type ProductRecord,
  productMatches,
} from './records.js';
import { openEntries, openNotices, openRows } from './sealed.js';

// The reads of the products and customers pages and of the pickers. Each is a plain async
// function of the copy, so the app runs it inside the copy's watch (LocalCopy.watch), and it runs
// again by itself when a pull writes to what it read.
//
// Step 19b: the rows are sealed. The lists of products and customers read the in-memory copy
// (copy.ts → Mirror.current), which is already open and is sorted once per change. The other reads
// take their few rows from IndexedDB and open them.

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

// The server's order: lower(name) (or lower(code)), then the id. Plain `<` compares strings by
// code unit, the way the IndexedDB index did before step 19b.
function byKey(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

function byProductName(a: ProductRecord, b: ProductRecord): number {
  if (a.sortName !== b.sortName) return a.sortName < b.sortName ? -1 : 1;
  return byKey(a, b);
}

function byProductCode(a: ProductRecord, b: ProductRecord): number {
  if (a.sortCode !== b.sortCode) return a.sortCode < b.sortCode ? -1 : 1;
  return byKey(a, b);
}

// The first `limit` matches in `order` (backwards for a '-' sort), and whether there are more.
// The walk stops at limit + 1 matches: a search that matches early costs little even in a long
// list.
function firstMatches<E>(
  order: readonly E[],
  backwards: boolean,
  matches: (entry: E) => boolean,
  limit: number,
): E[] {
  const found: E[] = [];
  for (let step = 0; step < order.length && found.length <= limit; step += 1) {
    const entry = order[backwards ? order.length - 1 - step : step];
    if (entry !== undefined && matches(entry)) found.push(entry);
  }
  return found;
}

// Two rows with the same name come in key (id) order, like the server's (lower(name), id); a '-'
// sort is the whole order backwards, as the index's reverse() was.
export async function productPage(
  copy: LocalCopy,
  filter: LocalProductFilter,
): Promise<LocalPage<Product>> {
  const needle = needleOf(filter.search);
  const products = await copy.products.current();
  const byCode = filter.sort === 'code' || filter.sort === '-code';
  const order = byCode
    ? products.ordered('code', byProductCode)
    : products.ordered('name', byProductName);
  const found = firstMatches(
    order,
    filter.sort.startsWith('-'),
    (record) =>
      (filter.categoryIds === null ||
        (record.data.categoryId !== null && filter.categoryIds.has(record.data.categoryId))) &&
      productMatches(record, needle),
    filter.limit,
  );
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
// outbox of one person. The ids come from the rows' clear fields; the rows are opened after the
// reads.
async function pendingCustomers(copy: LocalCopy): Promise<Map<string, SyncCustomer | null>> {
  const { db } = copy;
  const rows = await db.outbox.toArray();
  const ids = [
    ...new Set(
      rows.flatMap((row) => (row.type === 'sales_order.create_draft' ? [] : [row.customerId])),
    ),
  ];
  const customers = await db.customers.bulkGet(ids);
  const entries = await openEntries(copy, rows);
  const pending = new Map<string, SyncCustomer | null>();
  await Promise.all(
    ids.map(async (id, index) => {
      const row = customers[index];
      const data = row ? await copy.open('customers', row.key, row.box) : null;
      pending.set(id, projectCustomer(id, data, entries));
    }),
  );
  return pending;
}

function byCustomerName(a: CustomerRecord, b: CustomerRecord): number {
  if (a.sortName !== b.sortName) return a.sortName < b.sortName ? -1 : 1;
  return byKey(a, b);
}

// `pending`: the ids the outbox changes, for the "Not synced" pill
export interface LocalCustomerPage extends LocalPage<SyncCustomer> {
  pending: ReadonlySet<string>;
}

// The walk skips the customers the outbox changes, and their projected rows are put back in their
// place. There are only a few, so the first `limit` of the two lists merged are the first `limit`
// of all: every row past the walk's limit + 1 comes after all of them.
export async function customerPage(
  copy: LocalCopy,
  filter: LocalCustomerFilter,
): Promise<LocalCustomerPage> {
  const needle = needleOf(filter.search);
  const pending = await pendingCustomers(copy);
  const customers = await copy.customers.current();
  const matches = (record: CustomerRecord) =>
    (filter.groupId === '' || record.data.groupId === filter.groupId) &&
    customerMatches(record, needle);
  const walked = firstMatches(
    customers.ordered('name', byCustomerName),
    filter.sort === '-name',
    (record) => !pending.has(record.key) && matches(record),
    filter.limit,
  );
  const projected = [...pending.values()]
    .flatMap((row) => (row?.archivedAt !== null ? [] : [customerRecord(row.id, row)]))
    .filter(matches);
  const direction = filter.sort === '-name' ? -1 : 1;
  const found = [...walked, ...projected].sort((a, b) => direction * byCustomerName(a, b));
  return {
    rows: found.slice(0, filter.limit).map((record) => record.data),
    more: found.length > filter.limit,
    pending: new Set(pending.keys()),
  };
}

// One customer as the screens show it: the server's row with the outbox on top (step 18b). null =
// not on this device. From IndexedDB, not the in-memory copy: the row and the outbox are then read
// at the same moment, so a push's answer (which writes the one and deletes from the other in one
// transaction) never shows the customer twice or not at all.
export async function localCustomer(
  copy: LocalCopy,
  customerId: string,
): Promise<SyncCustomer | null> {
  const { db } = copy;
  const [row, rows] = await Promise.all([
    db.customers.get(customerId),
    db.outbox.where('customerId').equals(customerId).sortBy('seq'),
  ]);
  const [data, entries] = await Promise.all([
    row ? copy.open('customers', row.key, row.box) : null,
    openEntries(copy, rows),
  ]);
  return projectCustomer(customerId, data, entries);
}

// The pickers: the first 20 that match, by name, like the server's search
export const PICKER_LIMIT = 20;

export async function findProducts(copy: LocalCopy, search: string): Promise<Product[]> {
  const page = await productPage(copy, {
    search,
    categoryIds: null,
    sort: 'name',
    limit: PICKER_LIMIT,
  });
  return page.rows;
}

export async function findCustomers(copy: LocalCopy, search: string): Promise<SyncCustomer[]> {
  const page = await customerPage(copy, { search, groupId: '', sort: 'name', limit: PICKER_LIMIT });
  return page.rows;
}

// A small table whole, as the server's rows (units, categories, groups: tens of rows), opened.
// The table's own name is the label its rows were sealed under (apply.ts).
export async function allRows<T>(
  copy: LocalCopy,
  table: Table<SealedRow<T>, string>,
): Promise<T[]> {
  return openRows(copy, table.name, await table.toArray());
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
export async function outboxEntries(copy: LocalCopy): Promise<OutboxEntry[]> {
  return openEntries(copy, await copy.db.outbox.toArray());
}

// The commands of one customer or one order: a form opens its waiting command by its key, and a
// customer with commands is changed through the outbox, even online (decision 2)
export async function outboxOf(copy: LocalCopy, key: string): Promise<OutboxEntry[]> {
  return openEntries(copy, await copy.db.outbox.where('key').equals(key).sortBy('seq'));
}

export async function customerCommands(
  copy: LocalCopy,
  customerId: string,
): Promise<OutboxEntry[]> {
  return openEntries(
    copy,
    await copy.db.outbox.where('customerId').equals(customerId).sortBy('seq'),
  );
}

// What the sidebar counts: every command on the device, and the refused ones among them. The
// status is clear, so nothing is opened: the count runs on every outbox change, in every tab.
export async function outboxCounts(copy: LocalCopy): Promise<{ total: number; failed: number }> {
  const rows = await copy.db.outbox.toArray();
  return { total: rows.length, failed: rows.filter((row) => row.status === 'failed').length };
}

// The kept-from-the-server notices, newest first
export async function syncNotices(copy: LocalCopy): Promise<SyncNoticeRecord[]> {
  const notices = await openNotices(copy, await copy.db.notices.toArray());
  return notices.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}
