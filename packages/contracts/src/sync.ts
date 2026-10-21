import { z } from 'zod';

import { customerGroupSchema, customerSchema } from './customers.js';
import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { priceListSchema } from './price-lists.js';
import { productCategorySchema } from './product-categories.js';
import { productSchema } from './products.js';
import { settingsSchema } from './settings.js';
import { taxRateSchema } from './tax-rates.js';
import { unitSchema } from './units.js';
import { warehouseSchema } from './warehouses.js';

// Step 18a: the read half of the sync engine. A device (one browser profile, for one person in
// one workspace) keeps a copy of the data a shop or a sales officer needs without a connection,
// and asks the server for what changed since its last pull:
//
//   GET /sync/pull?deviceId=…&protocol=1             first pull: every row, a page at a time
//   GET /sync/pull?deviceId=…&protocol=1&cursor=…    later: only what changed since that cursor
//
// The cursor is opaque: only the server reads it. A pull answers pages until `hasMore` is false;
// the last page's cursor is the one to keep for the next pull.
//
// What a device holds ("POS-ready", decision 2): the active products with their variants, packs
// and barcodes, the price lists and their prices, the VAT rates, the units and categories, the
// active customers with their groups, the warehouses of the device's branch and the stock in them,
// and the part of the settings a sale needs. No customer balances and no stock values: they
// change with every invoice and every movement, and they need their own permissions.

// The version of this protocol: what the entities below are and what their rows hold. A client
// sends the version it was built with; the server answers sync_protocol_mismatch to any other,
// and the app asks the person to reload. That is how a new entity can be added later: an older
// client never receives a row it cannot read, and a client that moved to a new version starts
// again with a full pull, so it does not miss the rows of an entity it did not know before.
export const SYNC_PROTOCOL = 1;

// Every kind of row a device keeps. The order is the order of a full pull: the small lists that
// the others point at come first, so a page never shows a product before its units.
export const SYNC_ENTITIES = [
  'settings',
  'unit',
  'product_category',
  'tax_rate',
  'warehouse',
  'price_list',
  'customer_group',
  'product',
  'price_list_item',
  'customer',
  'stock',
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

// The most rows one page sends. A product counts as one row with all its variants, so a page of
// garments styles in 300 variants each is still a few MB at most.
export const MAX_SYNC_PAGE = 1000;

// ---------------------------------------------------------------------------------------------
// The rows a device keeps: the shapes the API already sends, without the counts and sums that
// change when another row changes. A price list's itemCount changes with each price, so keeping
// it would send the list again for every price.

// What a sale needs from the settings: how to work out the VAT, whether stock may go below zero,
// the time zone of its dates, and the company's name and BIN for a receipt (step 20). Not the logo:
// its url is signed for a short time and would be dead by the next day.
export const syncSettingsSchema = settingsSchema.pick({
  companyName: true,
  legalName: true,
  bin: true,
  phone: true,
  address: true,
  baseCurrency: true,
  fiscalYearStartMonth: true,
  timezone: true,
  allowNegativeStock: true,
  pricesIncludeVat: true,
  version: true,
});
export type SyncSettings = z.infer<typeof syncSettingsSchema>;

export const syncCategorySchema = productCategorySchema.omit({ productCount: true });
export type SyncCategory = z.infer<typeof syncCategorySchema>;

export const syncPriceListSchema = priceListSchema.omit({ itemCount: true, customerCount: true });
export type SyncPriceList = z.infer<typeof syncPriceListSchema>;

export const syncCustomerGroupSchema = customerGroupSchema.omit({ customerCount: true });
export type SyncCustomerGroup = z.infer<typeof syncCustomerGroupSchema>;

// A customer with its addresses, without the balance (decision 10: the list asks the server for
// the balances of the rows it shows, online only)
export const syncCustomerSchema = customerSchema.omit({ balance: true });
export type SyncCustomer = z.infer<typeof syncCustomerSchema>;

// One price of a list: a variant, in one unit. Its key is the three ids (priceListItemKey).
export const syncPriceListItemSchema = z.object({
  priceListId: z.uuid(),
  productId: z.uuid(),
  variantId: z.uuid(),
  unitId: z.uuid(),
  // Per one of this unit, 4 decimals
  price: z.string(),
  updatedAt: z.iso.datetime(),
});
export type SyncPriceListItem = z.infer<typeof syncPriceListItemSchema>;

// What is in one warehouse of the device's branch: a variant, and its batch for a batch product.
// The batch's lot number and dates come with the row, so a sale can pick the first to expire
// (FEFO) without a table of batches. Quantities only, in the base unit: never a cost
// (inventory.stock.value). A row whose quantity reaches zero is deleted from the device.
export const syncStockSchema = z.object({
  warehouseId: z.uuid(),
  productId: z.uuid(),
  variantId: z.uuid(),
  batchId: z.uuid().nullable(),
  lotNumber: z.string().nullable(),
  manufacturedOn: z.iso.date().nullable(),
  expiresOn: z.iso.date().nullable(),
  // 4 decimals, in the product's base unit. Negative only when the workspace allows it.
  quantity: z.string(),
  updatedAt: z.iso.datetime(),
});
export type SyncStock = z.infer<typeof syncStockSchema>;

// The rows without an id of their own are keyed by the ids that make them one row. The database's
// change log (step 18a.2) writes the same keys in SQL, so the format must not change: a stock row
// of an untracked variant ends in '-', never in an empty part.
export function priceListItemKey(
  item: Pick<SyncPriceListItem, 'priceListId' | 'variantId' | 'unitId'>,
): string {
  return `${item.priceListId}:${item.variantId}:${item.unitId}`;
}

export function stockKey(row: Pick<SyncStock, 'warehouseId' | 'variantId' | 'batchId'>): string {
  return `${row.warehouseId}:${row.variantId}:${row.batchId ?? '-'}`;
}

// ---------------------------------------------------------------------------------------------
// A change: a row to put in (insert or replace), or a key to take out. A row is taken out when it
// is deleted, and also when it leaves what the device keeps: an archived product, a customer that
// is now only a supplier, a warehouse moved to another branch, a stock row at zero.

function upsertOf<const E extends SyncEntity, S extends z.ZodType>(entity: E, data: S) {
  return z.object({
    op: z.literal('upsert'),
    entity: z.literal(entity),
    // The row's id, or the key from priceListItemKey / stockKey; the settings' key is the
    // workspace's id
    key: z.string(),
    data,
  });
}

export const syncUpsertSchema = z.discriminatedUnion('entity', [
  upsertOf('settings', syncSettingsSchema),
  upsertOf('unit', unitSchema),
  upsertOf('product_category', syncCategorySchema),
  upsertOf('tax_rate', taxRateSchema),
  upsertOf('warehouse', warehouseSchema),
  upsertOf('price_list', syncPriceListSchema),
  upsertOf('customer_group', syncCustomerGroupSchema),
  upsertOf('product', productSchema),
  upsertOf('price_list_item', syncPriceListItemSchema),
  upsertOf('customer', syncCustomerSchema),
  upsertOf('stock', syncStockSchema),
]);
export type SyncUpsert = z.infer<typeof syncUpsertSchema>;

// The row type of one entity: SyncRow<'product'> is a Product
export type SyncRow<E extends SyncEntity> = Extract<SyncUpsert, { entity: E }>['data'];

export const syncDeleteSchema = z.object({
  op: z.literal('delete'),
  entity: z.enum(SYNC_ENTITIES),
  key: z.string(),
});
export type SyncDelete = z.infer<typeof syncDeleteSchema>;

export const syncChangeSchema = z.union([syncUpsertSchema, syncDeleteSchema]);
export type SyncChange = z.infer<typeof syncChangeSchema>;

// ---------------------------------------------------------------------------------------------
// The pull

export const syncPullQuerySchema = z.object({
  deviceId: z.uuid(),
  // SYNC_PROTOCOL of the client. Any number passes here; the server compares it, so the answer
  // is the one code the app looks for (sync_protocol_mismatch), not a field error.
  protocol: z.coerce.number<number>().int(),
  // None = a full pull. The server may also start a full pull itself (see `full`).
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number<number>().int().min(1).max(MAX_SYNC_PAGE).default(500),
});
export type SyncPullQuery = z.input<typeof syncPullQuerySchema>;

export const syncPullSchema = z.object({
  // In the order to apply them. A key is in a page at most once, in its latest state.
  changes: z.array(syncChangeSchema),
  // Send it with the next page, or keep it for the next pull once hasMore is false
  cursor: z.string(),
  hasMore: z.boolean(),
  // This page is part of a full pull: every row the device should keep, not only what changed.
  // The server starts one when there is no cursor, when the cursor is older than the change log
  // keeps, or when the device moved to another branch. On the last page of a full pull, the
  // device drops every row the full pull did not send. Until then it keeps showing what it had.
  full: z.boolean(),
  // The server's clock when the page was read. "Last synced" and the offline time limits (step
  // 18c) are counted from it, never from the device's clock, which may be wrong.
  serverTime: z.iso.datetime(),
});
export type SyncPull = z.infer<typeof syncPullSchema>;

// ---------------------------------------------------------------------------------------------
// Devices. Step 18a registers one; step 18c lists them, renames them, moves them to another
// branch and revokes them.

export const deviceSchema = z.object({
  id: z.uuid(),
  // "Chrome on Windows", "Counter 2"
  name: z.string(),
  // The branch whose warehouses and stock the device keeps, and (step 18b) where its offline
  // orders are made. Members have no branch, so the device says where it is (decision 9).
  branchId: z.uuid(),
  // The person who registered it. A device is one person's: another person signing in on the
  // same browser gets a device (and a local database) of their own.
  userId: z.uuid(),
  // When it last finished a pull, by the server's clock; null before the first one
  lastSyncAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  version: z.number().int(),
});
export type Device = z.infer<typeof deviceSchema>;

export const deviceNameSchema = z.string().trim().min(2, errorCode('device_name_required')).max(60);

export const registerDeviceInputSchema = z.object({
  // Made by the browser, a UUIDv7 like every id: if the answer is lost on a bad connection, the
  // retry registers the same device instead of a second one
  id: z.uuidv7(errorCode('device_id_invalid')),
  name: deviceNameSchema,
  // The form's empty select sends '' — "not chosen", with its own message
  branchId: z.uuid(errorCode('device_branch_invalid')),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceInputSchema>;
export type RegisterDeviceFormValues = z.input<typeof registerDeviceInputSchema>;

// No permission: every member may work offline. What a device receives is what its person may
// read anyway (products, customers, prices and stock need no permission to read).
export const syncRoutes = {
  registerDevice: defineRoute({
    method: 'POST',
    path: '/sync/devices',
    summary: 'Register this browser as a device of the signed-in person, in one branch',
    auth: 'bearer',
    status: 201,
    body: registerDeviceInputSchema,
    response: deviceSchema,
  }),
  pull: defineRoute({
    method: 'GET',
    path: '/sync/pull',
    summary: 'The rows a device keeps: all of them, or what changed since a cursor',
    auth: 'bearer',
    status: 200,
    query: syncPullQuerySchema,
    response: syncPullSchema,
  }),
};
