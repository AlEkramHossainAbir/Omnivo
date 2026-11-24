import {
  DEFAULT_SETTINGS,
  SHOP_ORDER_HOLD_MINUTES,
  type ShopCouponRule,
  todayIn,
} from '@omnivo/contracts';
import { storefrontCoupons, tenantSettings } from '@omnivo/db';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Transaction } from '../common/tenant/with-tenant.js';
import type { ShopScope } from './shop-db.js';

type CouponRow = typeof storefrontCoupons.$inferSelect;

// Step 27c: a coupon as the shop's side of the API reads it: the quote (omnivo_public) and placing
// an order (omnivo_shop). The ERP's Coupons page has its own service (admin/coupons.service.ts),
// but counts a use with the same database function.

// A coupon the shop knows, with what judgeShopCoupon() needs. `id` and `code` go on the order
export interface ShopCoupon {
  id: string;
  rule: ShopCouponRule;
  used: number;
}

// What quoteCart() gets besides the cart: the coupon with the code the cart names (undefined when
// the cart names none, or the shop has no such coupon), and today in the shop's time zone, for its
// first and last day
export interface QuoteCoupon {
  coupon: ShopCoupon | undefined;
  today: string;
}

const usedSchema = z.array(z.object({ used: z.number().int() }));

// The start of the hold: a pending order older than this has lost its stock and its use
// (storefront_coupon_uses, 0074). The same rule as the verify page's waitingOrder()
export function holdStart(shop: ShopScope): Date {
  return new Date(shop.now.getTime() - SHOP_ORDER_HOLD_MINUTES * 60 * 1000);
}

// Today in the shop's time zone, by ShopDb's clock (the one the order and its hold use)
export async function shopToday(tx: Transaction, shop: ShopScope): Promise<string> {
  const [workspace] = await tx
    .select({ timezone: tenantSettings.timezone })
    .from(tenantSettings)
    .where(eq(tenantSettings.tenantId, shop.tenantId));
  return todayIn(workspace?.timezone ?? DEFAULT_SETTINGS.timezone, shop.now);
}

function ruleOf(row: CouponRow): ShopCouponRule {
  return {
    code: row.code,
    // A percent is a whole number in a numeric(19,4) column ("10.0000"), and ShopDiscount keeps it
    // as a number, as the listings' sale does
    discount:
      row.discountKind === 'percent'
        ? { kind: 'percent', value: Number(row.discountValue) }
        : { kind: 'amount', value: row.discountValue },
    upTo: row.upTo,
    minimum: row.minimum,
    startsOn: row.startsOn,
    lastDay: row.lastDay,
    usageLimit: row.usageLimit,
    onePerPhone: row.onePerPhone,
  };
}

// The quote's read: the coupon and its uses in one statement. Archived coupons, and every coupon
// of a shop that is not launched, are hidden from omnivo_public by 0074's policies, so they are
// "unknown" here without a word of TypeScript. The code is compared as typed:
// shopCouponCodeSchema upper-cased it, like the column
export async function quotedCoupon(
  tx: Transaction,
  shop: ShopScope,
  code: string | undefined,
): Promise<QuoteCoupon> {
  const today = await shopToday(tx, shop);
  if (code === undefined) return { coupon: undefined, today };
  const [row] = await tx
    .select({
      coupon: storefrontCoupons,
      used: sql<number>`storefront_coupon_uses(${storefrontCoupons.id}, ${holdStart(shop).toISOString()}::timestamptz)`.mapWith(
        Number,
      ),
    })
    .from(storefrontCoupons)
    .where(and(eq(storefrontCoupons.tenantId, shop.tenantId), eq(storefrontCoupons.code, code)));
  return {
    coupon:
      row === undefined
        ? undefined
        : { id: row.coupon.id, rule: ruleOf(row.coupon), used: row.used },
    today,
  };
}

async function usesOf(
  tx: Transaction,
  shop: ShopScope,
  couponId: string,
  phone: string | null,
): Promise<number> {
  const [row] = usedSchema.parse(
    await tx.execute(
      sql`SELECT storefront_coupon_uses(${couponId}::uuid, ${holdStart(shop).toISOString()}::timestamptz, ${phone}::text) AS used`,
    ),
  );
  // A function call always answers one row; the check is for TypeScript
  if (row === undefined) throw new Error('storefront_coupon_uses answered no row');
  return row.used;
}

// Placing an order's read (decision 3). Two statements, on purpose:
// 1. the coupon's row FOR UPDATE: a second shopper with the same code waits here until the first
//    one's order is committed (or rolled back). omnivo_shop may lock it because it may UPDATE one
//    of its columns (first_ordered_at, 0074)
// 2. the uses, in a NEW statement. Under READ COMMITTED each statement sees what was committed
//    when it started: a count in the locking statement would be the snapshot from before the wait,
//    and would miss the order the first shopper just placed. The second statement sees it, so two
//    shoppers can never both take the last use
// The caller has locked the cart's variants already; every order takes the variants first and the
// coupon last, so two orders never wait for each other in a circle
export async function lockedCoupon(
  tx: Transaction,
  shop: ShopScope,
  code: string | undefined,
): Promise<QuoteCoupon> {
  const today = await shopToday(tx, shop);
  if (code === undefined) return { coupon: undefined, today };
  const [row] = await tx
    .select()
    .from(storefrontCoupons)
    .where(and(eq(storefrontCoupons.tenantId, shop.tenantId), eq(storefrontCoupons.code, code)))
    .for('update');
  if (row === undefined) return { coupon: undefined, today };
  return {
    coupon: { id: row.id, rule: ruleOf(row), used: await usesOf(tx, shop, row.id, null) },
    today,
  };
}

// Once per mobile number: has this phone an order that holds a use of the coupon now? A cancelled
// one gave its use back, and so did a pending one past its hold. Only placing an order asks: the
// quote does not know the phone yet
export async function usedByPhone(
  tx: Transaction,
  shop: ShopScope,
  couponId: string,
  phone: string,
): Promise<boolean> {
  return (await usesOf(tx, shop, couponId, phone)) > 0;
}

// The first order with the code freezes it (decision 16, 0074's guard). Raw SQL, not drizzle's
// update(): the table's updated_at has $onUpdate, so drizzle would set it as well, and omnivo_shop
// may UPDATE first_ordered_at only (42501). Only while it is still empty: the guard refuses to
// change it once set, and a later order has nothing to add. The row is locked already
// (lockedCoupon), so no other order can set it in between
export async function markOrdered(tx: Transaction, shop: ShopScope, couponId: string) {
  await tx.execute(
    sql`UPDATE storefront_coupons SET first_ordered_at = ${shop.now.toISOString()}::timestamptz
         WHERE tenant_id = ${shop.tenantId}::uuid AND id = ${couponId}::uuid
           AND first_ordered_at IS NULL`,
  );
}
