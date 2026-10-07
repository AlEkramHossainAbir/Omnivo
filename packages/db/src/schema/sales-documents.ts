import {
  DISCOUNT_TYPES,
  ORDER_STATUSES,
  QUOTATION_STATUSES,
  STOCK_DOCUMENT_STATUSES,
  TAX_RATE_KINDS,
} from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { batches } from './batches.js';
import { parties } from './parties.js';
import { productVariants } from './products.js';
import { stockLineColumns } from './stock-documents.js';
import { taxRates } from './tax-rates.js';
import { tenants } from './tenants.js';
import { units } from './units.js';
import { warehouses } from './warehouses.js';

// Step 15b: quotations, sales orders and deliveries (challans). The rules on what may change when
// (a confirmed order's lines, a posted delivery) live in migration 0028, like the stock documents'.

// The columns a quotation line and an order line share: the product, the quantity (as typed and in
// the base unit, like a stock line), the price and discount as typed, and a copy of the VAT rate.
// net, vat and total are what contracts' lineAmounts() gave when the line was saved: stored, not
// worked out on every read, so a list shows the totals without the arithmetic, and a document reads
// the same in five years whatever happens to the code.
function salesLineColumns() {
  return {
    id: baseColumns().id,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    lineNo: smallint('line_no').notNull(),
    productId: uuid('product_id').notNull(),
    variantId: uuid('variant_id').notNull(),
    unitId: uuid('unit_id').notNull(),
    quantity: numeric('quantity', { precision: 19, scale: 4 }).notNull(),
    factor: numeric('factor', { precision: 19, scale: 6 }).notNull(),
    baseQuantity: numeric('base_quantity', { precision: 19, scale: 4 }).notNull(),
    // As it will be printed: the person's own text, or the product's name when they typed none
    description: text('description').notNull(),
    // Per one of the unit, as typed: with or without VAT, as the document's prices_include_vat says
    unitPrice: numeric('unit_price', { precision: 19, scale: 4 }).notNull(),
    discountType: text('discount_type', { enum: DISCOUNT_TYPES }).notNull(),
    // As typed: 12.5 (percent) or 250 (taka off the line)
    discount: numeric('discount', { precision: 19, scale: 4 }).notNull().default('0'),
    // The rate the line used, and a copy of it: when a rate is changed or archived, an old line
    // still says what it charged
    taxRateId: uuid('tax_rate_id').notNull(),
    taxRateName: text('tax_rate_name').notNull(),
    taxRateKind: text('tax_rate_kind', { enum: TAX_RATE_KINDS }).notNull(),
    taxRate: numeric('tax_rate', { precision: 5, scale: 2 }).notNull(),
    net: numeric('net', { precision: 19, scale: 4 }).notNull(),
    vat: numeric('vat', { precision: 19, scale: 4 }).notNull(),
    total: numeric('total', { precision: 19, scale: 4 }).notNull(),
  };
}

// The totals every quotation and order keeps: the sums of its lines (contracts' documentTotals)
function totalColumns() {
  return {
    discount: numeric('discount', { precision: 19, scale: 4 }).notNull().default('0'),
    net: numeric('net', { precision: 19, scale: 4 }).notNull().default('0'),
    vat: numeric('vat', { precision: 19, scale: 4 }).notNull().default('0'),
    total: numeric('total', { precision: 19, scale: 4 }).notNull().default('0'),
  };
}

// ---------------------------------------------------------------------------------------------
// Quotations

export const quotations = pgTable(
  'quotations',
  {
    // deleted_at is not used: an open quotation is deleted for real, an answered one never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is saved ('sales.quotation'): the customer quotes it back
    number: text('number').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    validUntil: date('valid_until', { mode: 'string' }),
    customerId: uuid('customer_id').notNull(),
    // The workspace setting when it was written (step 15a)
    pricesIncludeVat: boolean('prices_include_vat').notNull(),
    status: text('status', { enum: QUOTATION_STATUSES }).notNull().default('open'),
    note: text('note'),
    ...totalColumns(),
  },
  (table) => [
    uniqueIndex('quotations_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('quotations_tenant_number_idx').on(table.tenantId, table.number),
    // The list: newest date first, keyset on (date, id)
    index('quotations_tenant_date_idx').on(table.tenantId, table.date, table.id),
    // One customer's quotations (the list's filter), and the customer FK's check on delete
    index('quotations_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // No ON DELETE: a customer with a quotation cannot be deleted (customer_in_use)
    foreignKey({
      name: 'quotations_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    check(
      'quotations_valid_until_check',
      sql`${table.validUntil} IS NULL OR ${table.validUntil} >= ${table.date}`,
    ),
    check(
      'quotations_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
  ],
);

export const quotationLines = pgTable(
  'quotation_lines',
  {
    ...salesLineColumns(),
    quotationId: uuid('quotation_id').notNull(),
  },
  (table) => [
    uniqueIndex('quotation_lines_line_idx').on(table.tenantId, table.quotationId, table.lineNo),
    // A line blocks deleting its variant (product_variant_in_use), and finds where it is used
    index('quotation_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    foreignKey({
      name: 'quotation_lines_quotation_fk',
      columns: [table.tenantId, table.quotationId],
      foreignColumns: [quotations.tenantId, quotations.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'quotation_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'quotation_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    // Rates are archived, never deleted, so this never blocks anything; it keeps the id honest
    foreignKey({
      name: 'quotation_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    check(
      'quotation_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    // The contract's rules again: a discount never takes more than the line (and so net >= 0), and
    // total is net plus VAT, to the paisa
    check(
      'quotation_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check('quotation_lines_tax_rate_check', sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Sales orders

export const salesOrders = pgTable(
  'sales_orders',
  {
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when it is first confirmed ('sales.order'). Kept when it goes back to draft, so the
    // number the customer was told never changes.
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    deliveryDate: date('delivery_date', { mode: 'string' }),
    customerId: uuid('customer_id').notNull(),
    // The buyer's PO number, a pharmacy's indent number
    customerReference: text('customer_reference'),
    // Where deliveries take the goods from by default, and where "on order" is counted
    warehouseId: uuid('warehouse_id').notNull(),
    // An address of this customer (the FK is in migration 0028: it needs ON DELETE SET NULL on one
    // column, which Drizzle cannot write), and its text when the order was saved
    shippingAddressId: uuid('shipping_address_id'),
    shippingAddress: text('shipping_address'),
    // The quotation it was made from
    quotationId: uuid('quotation_id'),
    pricesIncludeVat: boolean('prices_include_vat').notNull(),
    status: text('status', { enum: ORDER_STATUSES }).notNull().default('draft'),
    note: text('note'),
    ...totalColumns(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmedBy: uuid('confirmed_by'),
  },
  (table) => [
    uniqueIndex('sales_orders_tenant_id_idx').on(table.tenantId, table.id),
    // The target of the delivery's FK: an order of THIS customer
    uniqueIndex('sales_orders_customer_id_idx').on(table.tenantId, table.customerId, table.id),
    uniqueIndex('sales_orders_tenant_number_idx').on(table.tenantId, table.number),
    // A quotation becomes one order at most. NULLs never collide.
    uniqueIndex('sales_orders_quotation_idx').on(table.tenantId, table.quotationId),
    index('sales_orders_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('sales_orders_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // What confirmed orders still have to deliver, per warehouse: the stock list's "on order".
    // Partial: delivered, closed and cancelled orders (most of them, after a year) are not in it.
    index('sales_orders_open_idx')
      .on(table.tenantId, table.warehouseId)
      .where(sql`${table.status} = 'confirmed'`),
    foreignKey({
      name: 'sales_orders_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    foreignKey({
      name: 'sales_orders_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    foreignKey({
      name: 'sales_orders_quotation_fk',
      columns: [table.tenantId, table.quotationId],
      foreignColumns: [quotations.tenantId, quotations.id],
    }),
    // Out of draft ⇔ confirmed at a time. A draft may still have a number: it was confirmed once,
    // then reopened.
    check(
      'sales_orders_confirmed_check',
      sql`(${table.status} = 'draft') = (${table.confirmedAt} IS NULL) AND (${table.status} = 'draft' OR ${table.number} IS NOT NULL)`,
    ),
    check(
      'sales_orders_delivery_date_check',
      sql`${table.deliveryDate} IS NULL OR ${table.deliveryDate} >= ${table.date}`,
    ),
    check(
      'sales_orders_totals_check',
      sql`${table.discount} >= 0 AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
  ],
);

export const salesOrderLines = pgTable(
  'sales_order_lines',
  {
    ...salesLineColumns(),
    orderId: uuid('order_id').notNull(),
    // In the base unit: the sum of the posted delivery lines that point here. Written by the
    // delivery's posting, under a lock on the order (15b.3).
    deliveredQuantity: numeric('delivered_quantity', { precision: 19, scale: 4 })
      .notNull()
      .default('0'),
  },
  (table) => [
    uniqueIndex('sales_order_lines_line_idx').on(table.tenantId, table.orderId, table.lineNo),
    // The target of the delivery line's FK
    uniqueIndex('sales_order_lines_tenant_id_idx').on(table.tenantId, table.id),
    index('sales_order_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    foreignKey({
      name: 'sales_order_lines_order_fk',
      columns: [table.tenantId, table.orderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'sales_order_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'sales_order_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    // Rates are archived, never deleted, so this never blocks anything; it keeps the id honest
    foreignKey({
      name: 'sales_order_lines_tax_rate_fk',
      columns: [table.tenantId, table.taxRateId],
      foreignColumns: [taxRates.tenantId, taxRates.id],
    }),
    check(
      'sales_order_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    // The contract's rules again: a discount never takes more than the line (and so net >= 0), and
    // total is net plus VAT, to the paisa
    check(
      'sales_order_lines_amounts_check',
      sql`${table.unitPrice} >= 0 AND ${table.discount} >= 0 AND (${table.discountType} = 'amount' OR ${table.discount} <= 100) AND ${table.net} >= 0 AND ${table.vat} >= 0 AND ${table.total} = ${table.net} + ${table.vat}`,
    ),
    check(
      'sales_order_lines_tax_rate_check',
      sql`${table.taxRate} >= 0 AND ${table.taxRate} < 100`,
    ),
    // Never more than was ordered: the last word on over-delivery, whatever the API checked first
    check(
      'sales_order_lines_delivered_check',
      sql`${table.deliveredQuantity} BETWEEN 0 AND ${table.baseQuantity}`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------------
// Deliveries (delivery challans)

export const deliveries = pgTable(
  'deliveries',
  {
    // deleted_at is not used: a draft is deleted for real, a posted delivery never
    ...baseColumns(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // Given when posted ('sales.delivery'), so numbers have no gaps
    number: text('number'),
    date: date('date', { mode: 'string' }).notNull(),
    customerId: uuid('customer_id').notNull(),
    // NULL = a delivery without an order
    orderId: uuid('order_id'),
    warehouseId: uuid('warehouse_id').notNull(),
    // Like the order's: an address of this customer (FK in 0028) and its text on the challan
    shippingAddressId: uuid('shipping_address_id'),
    shippingAddress: text('shipping_address'),
    vehicle: text('vehicle'),
    note: text('note'),
    status: text('status', { enum: STOCK_DOCUMENT_STATUSES }).notNull().default('draft'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: uuid('posted_by'),
  },
  (table) => [
    uniqueIndex('deliveries_tenant_id_idx').on(table.tenantId, table.id),
    uniqueIndex('deliveries_tenant_number_idx').on(table.tenantId, table.number),
    index('deliveries_tenant_date_idx').on(table.tenantId, table.date, table.id),
    index('deliveries_customer_idx').on(table.tenantId, table.customerId, table.date, table.id),
    // An order's deliveries (its page; "has it any delivery?" before a reopen)
    index('deliveries_order_idx')
      .on(table.tenantId, table.orderId)
      .where(sql`${table.orderId} IS NOT NULL`),
    index('deliveries_warehouse_idx').on(table.tenantId, table.warehouseId),
    foreignKey({
      name: 'deliveries_customer_fk',
      columns: [table.tenantId, table.customerId],
      foreignColumns: [parties.tenantId, parties.id],
    }),
    // customer_id is in both keys: a delivery's order is always an order of the same customer
    foreignKey({
      name: 'deliveries_order_fk',
      columns: [table.tenantId, table.customerId, table.orderId],
      foreignColumns: [salesOrders.tenantId, salesOrders.customerId, salesOrders.id],
    }),
    foreignKey({
      name: 'deliveries_warehouse_fk',
      columns: [table.tenantId, table.warehouseId],
      foreignColumns: [warehouses.tenantId, warehouses.id],
    }),
    check(
      'deliveries_posted_check',
      sql`(${table.status} = 'posted') = (${table.number} IS NOT NULL AND ${table.postedAt} IS NOT NULL)`,
    ),
  ],
);

export const deliveryLines = pgTable(
  'delivery_lines',
  {
    ...stockLineColumns(),
    deliveryId: uuid('delivery_id').notNull(),
    // The order line it delivers; NULL on a delivery without an order
    orderLineId: uuid('order_line_id'),
    // What the goods cost, at the average cost when posted (step 14); NULL while a draft
    value: numeric('value', { precision: 19, scale: 4 }),
  },
  (table) => [
    uniqueIndex('delivery_lines_line_idx').on(table.tenantId, table.deliveryId, table.lineNo),
    index('delivery_lines_variant_idx').on(table.tenantId, table.productId, table.variantId),
    // The order line FK's check when a draft order's lines are replaced
    index('delivery_lines_order_line_idx')
      .on(table.tenantId, table.orderLineId)
      .where(sql`${table.orderLineId} IS NOT NULL`),
    foreignKey({
      name: 'delivery_lines_delivery_fk',
      columns: [table.tenantId, table.deliveryId],
      foreignColumns: [deliveries.tenantId, deliveries.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'delivery_lines_order_line_fk',
      columns: [table.tenantId, table.orderLineId],
      foreignColumns: [salesOrderLines.tenantId, salesOrderLines.id],
    }),
    foreignKey({
      name: 'delivery_lines_variant_fk',
      columns: [table.tenantId, table.productId, table.variantId],
      foreignColumns: [productVariants.tenantId, productVariants.productId, productVariants.id],
    }),
    foreignKey({
      name: 'delivery_lines_unit_fk',
      columns: [table.tenantId, table.unitId],
      foreignColumns: [units.tenantId, units.id],
    }),
    foreignKey({
      name: 'delivery_lines_batch_fk',
      columns: [table.tenantId, table.variantId, table.batchId],
      foreignColumns: [batches.tenantId, batches.variantId, batches.id],
    }),
    check(
      'delivery_lines_quantity_check',
      sql`${table.quantity} > 0 AND ${table.factor} > 0 AND ${table.baseQuantity} > 0`,
    ),
    check('delivery_lines_value_check', sql`${table.value} IS NULL OR ${table.value} >= 0`),
  ],
);
