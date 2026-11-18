import {
  SHOP_CART_MAX_LINES,
  SHOP_CART_MAX_QUANTITY,
  SHOP_CODE_SENDS,
  SHOP_CODE_TRIES,
  SHOP_ORDER_STATUSES,
  SHOP_PAYMENT_METHODS,
  type StorefrontImage,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { productVariants } from './products.js';
import { tenants } from './tenants.js';
import { warehouses } from './warehouses.js';

// Step 27a: the shop's orders. A shopper's request, not an ERP document (system design §14.3):
// it may be fake or cancelled, so it lives apart from sales_orders, and step 27b makes the sales
// order only once the order is confirmed. The shop's server writes these tables as omnivo_shop
// (migration 0071), the ERP's screens (27b) as omnivo_app.

// A SHA-256 or HMAC-SHA256 in lower-case hex, as document_shares keeps its token's hash
const HASH_PATTERN = '^[0-9a-f]{64}$';

// One order. It is "pending" while it waits for the phone code: then it has the code's columns and
// no number. The right code confirms it (decision 2): it gets its number and its tracking token,
// and the code's columns are emptied. A pending order is never kept: five wrong codes delete it at
// once, and the worker's sweep deletes the ones older than SHOP_ORDER_HOLD_MINUTES (decision 19)
export const storefrontOrders = pgTable(
  'storefront_orders',
  {
    id: baseColumns().id,
    // When the shopper pressed Confirm Order: the "Placed on" date and the first dot of the
    // timeline (shopOrderSchema.placedAt)
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    // The member who last changed it in the ERP (27b); NULL while only the shopper has
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // "W-000123", given at confirm (decision 20). NULL while pending
    orderNo: text('order_no'),
    status: text('status', { enum: SHOP_ORDER_STATUSES }).notNull().default('pending'),
    // The delivery details as the shopper typed them. The checkout's rules (shopOrderRequestSchema)
    // again in the checks below, so a row the API did not write is still one the courier can use
    customerName: text('customer_name').notNull(),
    // 11 digits, "01786120356": shopPhoneSchema's form. The SMS, the limits and /track compare it
    // as it is, so one phone is always written one way
    phone: text('phone').notNull(),
    address: text('address').notNull(),
    // The zone the shopper picked, with its name and charge as they were. Copies: the tenant may
    // rename or remove a zone later, and the order must still say where it goes and what it cost
    zoneId: text('zone_id').notNull(),
    zoneName: text('zone_name').notNull(),
    paymentMethod: text('payment_method', { enum: SHOP_PAYMENT_METHODS }).notNull(),
    // The server's own sums, never the browser's (system design §14.4). discount and coupon_code
    // stay '0' and NULL until coupons come in 27c
    subtotal: numeric('subtotal', { precision: 19, scale: 4 }).notNull(),
    discount: numeric('discount', { precision: 19, scale: 4 }).notNull().default('0'),
    couponCode: text('coupon_code'),
    deliveryCharge: numeric('delivery_charge', { precision: 19, scale: 4 }).notNull(),
    total: numeric('total', { precision: 19, scale: 4 }).notNull(),
    // The browser's token, kept in its httpOnly cookie (decision 16). Only its SHA-256 is here:
    // a leaked database dump cannot be turned back into cookies that open the orders
    orderTokenHash: text('order_token_hash').notNull(),
    // The tracking link's token (decision 9), made at confirm and sent by SMS. NULL while pending
    trackingTokenHash: text('tracking_token_hash'),
    // The phone code (decision 7), only while pending. The hash is an HMAC with the API's own key
    // over the order's id and the code: with a plain SHA-256, a leaked dump would give the code
    // back after a million tries, which takes a laptop a second
    codeHash: text('code_hash'),
    // When the code stops working (SHOP_CODE_VALID_MINUTES after it was sent)
    codeExpiresAt: timestamp('code_expires_at', { withTimezone: true }),
    // When the last code was sent: "Resend code" opens SHOP_CODE_RESEND_SECONDS after it
    codeSentAt: timestamp('code_sent_at', { withTimezone: true }),
    // How many codes were sent (1 to SHOP_CODE_SENDS), and how many wrong ones may still come
    codeSends: smallint('code_sends'),
    codeTriesLeft: smallint('code_tries_left'),
    // When each step happened: the order's history (shopOrderSchema.history) is read from these,
    // so there is no table of events to keep in step with the status
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    packedAt: timestamp('packed_at', { withTimezone: true }),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    returnedAt: timestamp('returned_at', { withTimezone: true }),
  },
  (table) => [
    // The target of the lines' and the holds' FKs. A constraint, not a uniqueIndex like the other
    // tables' (tenant_id, id): drizzle writes a constraint inside CREATE TABLE, but an index after
    // every ALTER TABLE … ADD FOREIGN KEY, and Postgres refuses an FK whose target has no unique
    // index yet (42830). The lines and the holds are in the same migration, so the order matters
    unique('storefront_orders_tenant_id_key').on(table.tenantId, table.id),
    // One number, one order, in each shop. NULLs (pending orders) never collide
    uniqueIndex('storefront_orders_order_no_idx').on(table.tenantId, table.orderNo),
    // The cookie's and the link's lookups. A token is 128 random bits, so two orders never share
    // one; unique all the same, so a bug that wrote one twice fails here instead of opening
    // another person's order
    uniqueIndex('storefront_orders_order_token_idx').on(table.tenantId, table.orderTokenHash),
    uniqueIndex('storefront_orders_tracking_token_idx')
      .on(table.tenantId, table.trackingTokenHash)
      .where(sql`${table.trackingTokenHash} IS NOT NULL`),
    // The worker's sweep looks for old pending orders in EVERY workspace, so this index does not
    // start with tenant_id, like the outbox's. Partial: only the few pending rows are in it
    index('storefront_orders_pending_idx')
      .on(table.createdAt)
      .where(sql`${table.status} = 'pending'`),
    check(
      'storefront_orders_order_no_check',
      sql`${table.orderNo} IS NULL OR ${table.orderNo} ~ '^W-[0-9]{6,9}$'`,
    ),
    check('storefront_orders_phone_check', sql`${table.phone} ~ '^01[3-9][0-9]{8}$'`),
    check(
      'storefront_orders_text_check',
      sql`char_length(${table.customerName}) BETWEEN 1 AND 80
        AND char_length(${table.address}) BETWEEN 10 AND 300
        AND char_length(${table.zoneId}) BETWEEN 1 AND 32
        AND char_length(${table.zoneName}) >= 1`,
    ),
    // The bill adds up: the total is what the courier collects, so it must be the parts' sum
    check(
      'storefront_orders_amounts_check',
      sql`${table.subtotal} > 0 AND ${table.discount} >= 0 AND ${table.discount} <= ${table.subtotal}
        AND ${table.deliveryCharge} >= 0
        AND ${table.total} = ${table.subtotal} - ${table.discount} + ${table.deliveryCharge}`,
    ),
    check(
      'storefront_orders_hashes_check',
      sql`${table.orderTokenHash} ~ '${sql.raw(HASH_PATTERN)}'
        AND (${table.trackingTokenHash} IS NULL OR ${table.trackingTokenHash} ~ '${sql.raw(HASH_PATTERN)}')
        AND (${table.codeHash} IS NULL OR ${table.codeHash} ~ '${sql.raw(HASH_PATTERN)}')`,
    ),
    // Two exact cases. Pending: every code column, and no number, no tracking token, no
    // confirmed_at. Anything after it: the other way round. So a confirmed order can never still
    // answer a code, and a pending one can never be tracked
    check(
      'storefront_orders_pending_check',
      sql`(${table.status} = 'pending'
          AND num_nonnulls(${table.codeHash}, ${table.codeExpiresAt}, ${table.codeSentAt}, ${table.codeSends}, ${table.codeTriesLeft}) = 5
          AND num_nonnulls(${table.orderNo}, ${table.trackingTokenHash}, ${table.confirmedAt}) = 0)
        OR (${table.status} <> 'pending'
          AND num_nonnulls(${table.codeHash}, ${table.codeExpiresAt}, ${table.codeSentAt}, ${table.codeSends}, ${table.codeTriesLeft}) = 0
          AND num_nonnulls(${table.orderNo}, ${table.trackingTokenHash}, ${table.confirmedAt}) = 3)`,
    ),
    // The code's counts stay inside the contract's rules. SHOP_CODE_TRIES wrong codes delete the
    // order, so a pending row has at least one try left
    check(
      'storefront_orders_code_check',
      sql`${table.codeSends} IS NULL OR (
        ${table.codeSends} BETWEEN 1 AND ${sql.raw(String(SHOP_CODE_SENDS))}
        AND ${table.codeTriesLeft} BETWEEN 1 AND ${sql.raw(String(SHOP_CODE_TRIES))}
        AND ${table.codeExpiresAt} > ${table.codeSentAt})`,
    ),
    // The time of the status the order is in is always known, and the two ends (cancelled,
    // returned) only on an order that ended that way. Which step may follow which is the API's
    // rule (27b), not the database's: a parcel can come back before or after it was delivered
    check(
      'storefront_orders_steps_check',
      sql`CASE ${table.status}
          WHEN 'packed' THEN ${table.packedAt} IS NOT NULL
          WHEN 'shipped' THEN ${table.shippedAt} IS NOT NULL
          WHEN 'delivered' THEN ${table.deliveredAt} IS NOT NULL
          ELSE true END
        AND (${table.status} = 'cancelled') = (${table.cancelledAt} IS NOT NULL)
        AND (${table.status} = 'returned') = (${table.returnedAt} IS NOT NULL)`,
    ),
  ],
);

// What was bought, priced at the moment of the order. Copies of the listing (its name, link name,
// pack size and first photo), because the listing may change or go, and the order must still say
// what it was (shopOrderSchema's lines). Written once with the order, never changed.
export const storefrontOrderLines = pgTable(
  'storefront_order_lines',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    // 1 = the cart's first line, so the order page lists them as the cart did
    position: smallint('position').notNull(),
    // The listing it came from, as a copy with no FK (decision 21): an FK would stop the tenant
    // from deleting a listing that was ever ordered, and the order needs only its id and words
    listingId: uuid('listing_id').notNull(),
    // The stock item. A real FK: 27b's sales order and challan need it, and a product that was
    // ordered cannot be deleted (it is archived instead), like every other document line
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    packSize: text('pack_size').notNull(),
    // The listing's first photo then (StorefrontImage: id and alt text)
    image: jsonb('image').$type<StorefrontImage>().notNull(),
    // In the product's base unit: a listing is priced per base unit ("Per Piece")
    quantity: integer('quantity').notNull(),
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    lineTotal: numeric('line_total', { precision: 19, scale: 4 }).notNull(),
  },
  (table) => [
    primaryKey({
      name: 'storefront_order_lines_pkey',
      columns: [table.tenantId, table.orderId, table.position],
    }),
    // A cart has each listing once (cartLinesSchema), so an order does too
    uniqueIndex('storefront_order_lines_listing_idx').on(
      table.tenantId,
      table.orderId,
      table.listingId,
    ),
    // A pending order's lines go with it
    foreignKey({
      name: 'storefront_order_lines_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [storefrontOrders.tenantId, storefrontOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'storefront_order_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    check(
      'storefront_order_lines_position_check',
      sql`${table.position} BETWEEN 1 AND ${sql.raw(String(SHOP_CART_MAX_LINES))}`,
    ),
    check(
      'storefront_order_lines_quantity_check',
      sql`${table.quantity} BETWEEN 1 AND ${sql.raw(String(SHOP_CART_MAX_QUANTITY))}`,
    ),
    check(
      'storefront_order_lines_amounts_check',
      sql`${table.unitPrice} > 0 AND ${table.lineTotal} > 0`,
    ),
    check(
      'storefront_order_lines_text_check',
      sql`char_length(${table.slug}) >= 1 AND char_length(${table.name}) >= 1 AND jsonb_typeof(${table.image}) = 'object'`,
    ),
  ],
);

// The stock an order holds (decision 6). The shop shows what is on hand in its warehouse minus
// what is held there, so the last piece is sold once. A pending order's hold ends at expires_at
// (SHOP_ORDER_HOLD_MINUTES after the order); confirm sets it to NULL, and the hold then lasts
// until 27b's challan takes the stock out for real. Its own table, not a column on the lines:
// omnivo_public reads it to count what is free, and it holds no name, phone or address.
export const storefrontStockHolds = pgTable(
  'storefront_stock_holds',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    orderId: uuid('order_id').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    // The shop's warehouse when the order was placed. A copy: if the tenant picks another
    // warehouse later, an order already confirmed is still picked where its stock was held
    warehouseId: uuid('warehouse_id').notNull(),
    // In the base unit, like stock_balances.quantity, so the two subtract with no conversion
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    // NULL = held until the challan (a confirmed order)
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [
    // One hold per variant per order: the lines are one per listing, a listing one per variant
    primaryKey({
      name: 'storefront_stock_holds_pkey',
      columns: [table.tenantId, table.orderId, table.variantId],
    }),
    // "How much of this variant is held in this warehouse": the shop's cards, the quote and every
    // order placed read this sum
    index('storefront_stock_holds_variant_idx').on(
      table.tenantId,
      table.warehouseId,
      table.variantId,
    ),
    // A dropped order frees its stock in the same statement
    foreignKey({
      name: 'storefront_stock_holds_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [storefrontOrders.tenantId, storefrontOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'storefront_stock_holds_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'storefront_stock_holds_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check('storefront_stock_holds_quantity_check', sql`${table.quantity} > 0`),
  ],
);

// The last order number each shop gave (decision 20). Not number_series: a tenant may change an
// ERP document's prefix and year in Settings → Numbering, but the shop's /track form and links
// read "W-" and digits only (shopOrderNoSchema). Not a SEQUENCE either, for number_series'
// reason: a sequence does not roll back, and a confirm that failed would leave a gap. The row
// goes up inside the confirm's own transaction, and its row lock puts two confirms in a line.
export const storefrontOrderCounters = pgTable(
  'storefront_order_counters',
  {
    tenantId: uuid('tenant_id')
      .primaryKey()
      .references(() => tenants.id),
    lastValue: integer('last_value').notNull(),
  },
  (table) => [
    // W- and 6 to 9 digits: the number after 999,999,999 could not be written
    check('storefront_order_counters_value_check', sql`${table.lastValue} BETWEEN 1 AND 999999999`),
  ],
);
