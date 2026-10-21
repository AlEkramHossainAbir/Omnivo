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

import type { CustomerRecord, ProductRecord, Stored, SyncDatabase } from './database.js';
import { customerMatches, needleOf, productMatches } from './records.js';

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

export async function customerPage(
  db: SyncDatabase,
  filter: LocalCustomerFilter,
): Promise<LocalPage<SyncCustomer>> {
  const needle = needleOf(filter.search);
  const ordered = db.customers.orderBy('sortName');
  const found = await (filter.sort === '-name' ? ordered.reverse() : ordered)
    .filter(
      (record: CustomerRecord) =>
        (filter.groupId === '' || record.data.groupId === filter.groupId) &&
        customerMatches(record, needle),
    )
    .limit(filter.limit + 1)
    .toArray();
  return {
    rows: found.slice(0, filter.limit).map((record) => record.data),
    more: found.length > filter.limit,
  };
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
