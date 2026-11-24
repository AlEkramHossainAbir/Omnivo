import { SHOP_COUPON_KINDS, STOREFRONT_COUPON_MAX_USES } from '@omnivo/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { baseColumns } from '../base-columns.js';
import { tenants } from './tenants.js';

// Step 27c: the shop's coupons (decision 2). One table, for the whole cart: a coupon takes money
// off the items, never off the delivery charge. The ERP's Coupons page writes it as omnivo_app;
// the shop's quote reads it as omnivo_public, and placing an order locks its row as omnivo_shop
// (migration 0074). A coupon is never deleted: an order points at it, so it is archived instead.
export const storefrontCoupons = pgTable(
  'storefront_coupons',
  {
    id: baseColumns().id,
    createdAt: baseColumns().createdAt,
    updatedAt: baseColumns().updatedAt,
    updatedBy: baseColumns().updatedBy,
    version: baseColumns().version,
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    // "WELCOME10", as shopCouponCodeSchema writes it: upper case, so one code is one row
    code: text('code').notNull(),
    // The discount as two columns, like a listing's sale (ShopDiscount): a whole percent or taka
    discountKind: text('discount_kind', { enum: SHOP_COUPON_KINDS }).notNull(),
    discountValue: numeric('discount_value', { precision: 19, scale: 4 }).notNull(),
    // The most a percent takes off ("10%, up to ৳200"). NULL = no limit
    upTo: numeric('up_to', { precision: 19, scale: 4 }),
    // The items must be worth at least this much. NULL = any amount
    minimum: numeric('minimum', { precision: 19, scale: 4 }),
    // Whole days in the workspace's time zone, both included. NULL = from now on / for good
    startsOn: date('starts_on', { mode: 'string' }),
    lastDay: date('last_day', { mode: 'string' }),
    // How many orders may have it. NULL = as many as come
    usageLimit: integer('usage_limit'),
    onePerPhone: boolean('one_per_phone').notNull().default(false),
    // When the first order was placed with it (decision 16). Set by placing an order, while it
    // holds the row's lock (27c.3), and never changed again: from then on the code is frozen,
    // because that order's page and its documents say this code. The guard in 0074 keeps both
    // rules
    firstOrderedAt: timestamp('first_ordered_at', { withTimezone: true }),
    // NULL = the shop knows it. Archived = to the shop it does not exist (0074's policy)
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (table) => [
    // One code per workspace, archived ones included (storefront_coupon_code_taken): restoring an
    // archived WELCOME10 must not meet a second one. A constraint, so the API answers by its name
    unique('storefront_coupons_code_key').on(table.tenantId, table.code),
    // The target of the orders' foreign key, which names the code as well as the id: the code an
    // order says is then always its coupon's code. A constraint, not an index, for 27a's reason
    // (drizzle writes it inside CREATE TABLE, before the foreign key that needs it)
    unique('storefront_coupons_order_key').on(table.tenantId, table.id, table.code),
    // The Coupons page: one workspace, newest first
    index('storefront_coupons_list_idx').on(
      table.tenantId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    // shopCouponCodeSchema's pattern
    check('storefront_coupons_code_check', sql`${table.code} ~ '^[A-Z0-9-]{1,20}$'`),
    // The form's rules again (createStorefrontCouponInputSchema), so a row the API did not write
    // is still one judgeShopCoupon() and spreadMoney() can use. Every amount is above zero and to
    // the paisa (decision 13): numeric(19,4) keeps four places, so "= round(x, 2)" is the test. A
    // percent is whole, 1 to 99; "up to" belongs to a percent only
    check(
      'storefront_coupons_discount_check',
      sql`${table.discountValue} > 0
        AND CASE ${table.discountKind}
          WHEN 'percent' THEN ${table.discountValue} = trunc(${table.discountValue}) AND ${table.discountValue} <= 99
          ELSE ${table.discountValue} = round(${table.discountValue}, 2) AND ${table.upTo} IS NULL END
        AND (${table.upTo} IS NULL OR (${table.upTo} > 0 AND ${table.upTo} = round(${table.upTo}, 2)))
        AND (${table.minimum} IS NULL OR (${table.minimum} > 0 AND ${table.minimum} = round(${table.minimum}, 2)))`,
    ),
    // The same day twice is a one-day coupon
    check(
      'storefront_coupons_days_check',
      sql`${table.startsOn} IS NULL OR ${table.lastDay} IS NULL OR ${table.lastDay} >= ${table.startsOn}`,
    ),
    check(
      'storefront_coupons_usage_limit_check',
      sql`${table.usageLimit} IS NULL OR ${table.usageLimit} BETWEEN 1 AND ${sql.raw(String(STOREFRONT_COUPON_MAX_USES))}`,
    ),
  ],
);
