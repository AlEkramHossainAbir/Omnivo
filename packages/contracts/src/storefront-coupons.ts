import { z } from 'zod';

import { errorCode } from './errors.js';
import { versionSchema } from './fields.js';
import { defineRoute } from './http.js';
import { compareMoney, isZeroMoney, percentOfMoney, sumMoney } from './money.js';
import { pageOf, pageQuerySchema } from './pagination.js';
import { optionalDateSchema } from './stock.js';
import {
  SHOP_COUPON_MAX_LENGTH,
  shopCouponCodeSchema,
  shopDiscountSchema,
  type ShopCouponResult,
  type ShopDiscount,
} from './storefront.js';

// Step 27c: the shop's coupons. Two halves:
// - the rule: what a code does to a cart. The API's quote and the mock shop (apps/shop, step 26c)
//   both judge a code with the functions below, so the mock can never promise what the real shop
//   refuses
// - the ERP's Coupons page (Storefront → Coupons, storefront.manage): the list, the form and the
//   routes
// A coupon takes money off the items of the whole cart (decision 2), never off the delivery
// charge, and the free delivery and the minimum order still look at the items before the coupon
// (step 26c's decision 8).

// ---------------------------------------------------------------------------------------------
// The rule

// A coupon as the quote needs it. The API reads it from storefront_coupons; the mock keeps a few
// in memory. An archived coupon is never passed in: to the shopper it does not exist.
// - discount: "10% off" or "৳50 off" (the listings' ShopDiscount: a whole percent, or taka)
// - upTo: the most a percent coupon takes off ("10%, up to ৳200"); null = no limit. Always null
//   for an amount, which is its own limit
// - minimum: the items must be worth at least this much; null = any amount
// - startsOn / lastDay: the first and the last day it works, in the shop's time zone (ISO dates,
//   both days included); null = from now on / for good
// - usageLimit: how many orders may have it; null = as many as come
// - onePerPhone: one order per mobile number. The quote cannot check it (the shopper has not typed
//   a phone yet), so the order checks it when it is placed (shop_coupon_used_by_phone)
export interface ShopCouponRule {
  code: string;
  discount: ShopDiscount;
  upTo: string | null;
  minimum: string | null;
  startsOn: string | null;
  lastDay: string | null;
  usageLimit: number | null;
  onePerPhone: boolean;
}

// What the quote knows besides the coupon: the items' worth before the coupon, today in the shop's
// time zone (todayIn() in numbering.ts), and how many orders have the coupon now (decision 3: the
// orders waiting for their phone code count too, so the last use cannot go to two shoppers)
export interface ShopCouponCheck {
  subtotal: string;
  today: string;
  used: number;
}

// What a code does to a cart. `rule` is the coupon with that code, or undefined when the shop has
// none (or only an archived one). A code that does not apply is an answer, never an error (step
// 26c's decision 9). The checks go from "no such code" to "not any more" to "not for this cart", so
// the reason given is the one that matters most: a shopper with an expired code should not be told
// to add items first. ISO dates compare correctly as strings.
export function judgeShopCoupon(
  code: string | undefined,
  rule: ShopCouponRule | undefined,
  check: ShopCouponCheck,
): ShopCouponResult {
  if (code === undefined) return { status: 'none' };
  // Not started yet is "unknown" (decision 3): the promo box must not announce a sale early
  if (rule === undefined || (rule.startsOn !== null && check.today < rule.startsOn)) {
    return { status: 'refused', code, reason: 'shop_coupon_unknown', minimum: null };
  }
  if (rule.lastDay !== null && check.today > rule.lastDay) {
    return { status: 'refused', code, reason: 'shop_coupon_expired', minimum: null };
  }
  if (rule.usageLimit !== null && check.used >= rule.usageLimit) {
    return { status: 'refused', code, reason: 'shop_coupon_used_up', minimum: null };
  }
  if (rule.minimum !== null && compareMoney(check.subtotal, rule.minimum) < 0) {
    return { status: 'refused', code, reason: 'shop_coupon_minimum', minimum: rule.minimum };
  }
  return { status: 'applied', code, discount: rule.discount, upTo: rule.upTo };
}

// What an applied coupon takes off the items, to the paisa. A percent is of the items' worth, cut
// to `upTo`; an amount is the amount. Neither takes off more than the items cost: ৳50 off a ৳30
// cart is ৳30 off, so the total never goes below the delivery charge, and spreadMoney() can share
// the discount over the lines without a line going below zero.
export function shopCouponDiscount(
  applied: { discount: ShopDiscount; upTo: string | null },
  subtotal: string,
): string {
  let discount =
    applied.discount.kind === 'percent'
      ? percentOfMoney(subtotal, String(applied.discount.value))
      : sumMoney([applied.discount.value]);
  if (applied.upTo !== null && compareMoney(discount, applied.upTo) > 0) {
    discount = sumMoney([applied.upTo]);
  }
  return compareMoney(discount, subtotal) > 0 ? sumMoney([subtotal]) : discount;
}

// ---------------------------------------------------------------------------------------------
// The ERP's coupons

export const SHOP_COUPON_KINDS = ['percent', 'amount'] as const;
export type ShopCouponKind = (typeof SHOP_COUPON_KINDS)[number];

// How many orders a coupon may be allowed: a big number, but a number (the column is an integer,
// and a typo of nine digits is a mistake, not a plan)
export const STOREFRONT_COUPON_MAX_USES = 1_000_000;

// What the list's status pill says, worked out by the API from the dates, the uses and the
// archive (storefrontCouponStatus below):
// - scheduled: its first day is later (brand)
// - active: a shopper can use it today (good)
// - ended: its last day has passed, or every use is taken (neutral)
// - archived: the tenant took it away (neutral)
export const STOREFRONT_COUPON_STATUSES = ['active', 'scheduled', 'ended', 'archived'] as const;
export type StorefrontCouponStatus = (typeof STOREFRONT_COUPON_STATUSES)[number];

export function storefrontCouponStatus(
  coupon: {
    archivedAt: string | null;
    startsOn: string | null;
    lastDay: string | null;
    usageLimit: number | null;
    used: number;
  },
  today: string,
): StorefrontCouponStatus {
  if (coupon.archivedAt !== null) return 'archived';
  if (coupon.lastDay !== null && today > coupon.lastDay) return 'ended';
  if (coupon.usageLimit !== null && coupon.used >= coupon.usageLimit) return 'ended';
  if (coupon.startsOn !== null && today < coupon.startsOn) return 'scheduled';
  return 'active';
}

// The list's two tabs: the coupons in play (active, scheduled and ended ones) and the archived
export const STOREFRONT_COUPON_VIEWS = ['current', 'archived'] as const;
export type StorefrontCouponView = (typeof STOREFRONT_COUPON_VIEWS)[number];

// Newest first, paged: a shop that runs a coupon a week has hundreds after a few years
export const storefrontCouponQuerySchema = pageQuerySchema.extend({
  // Part of the code: "WEL" finds WELCOME10. Upper-cased like the code itself
  search: z.string().trim().toUpperCase().max(SHOP_COUPON_MAX_LENGTH).optional(),
  view: z.enum(STOREFRONT_COUPON_VIEWS).default('current'),
});
export type StorefrontCouponQuery = z.input<typeof storefrontCouponQuerySchema>;

export const storefrontCouponSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  discount: shopDiscountSchema,
  upTo: z.string().nullable(),
  minimum: z.string().nullable(),
  startsOn: z.iso.date().nullable(),
  lastDay: z.iso.date().nullable(),
  usageLimit: z.number().int().min(1).nullable(),
  onePerPhone: z.boolean(),
  // The orders that have it now: confirmed and later (not cancelled), plus those still waiting for
  // their phone code (decision 3). "12 of 100 used" in the list
  used: z.number().int().min(0),
  // An order has had this code, even one cancelled since: the code can no longer change, because
  // that order's page and its documents say the old code (storefront_coupon_code_locked)
  codeLocked: z.boolean(),
  status: z.enum(STOREFRONT_COUPON_STATUSES),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type StorefrontCoupon = z.infer<typeof storefrontCouponSchema>;

export const storefrontCouponPageSchema = pageOf(storefrontCouponSchema);
export type StorefrontCouponPage = z.infer<typeof storefrontCouponPageSchema>;

// ---------------------------------------------------------------------------------------------
// The form

// Taka to the paisa at most, like a sales line's discount: the coupon's discount is spread over
// the sales order's lines to the paisa (decision 4), so ৳10.555 could not be given exactly
const COUPON_MONEY = /^\d{1,15}(?:\.\d{1,2})?$/;

// An amount box that may be empty: '' = no limit (null). Zero is refused rather than read as "no
// limit": a minimum of ৳0 or "up to ৳0" is a typo, and the empty box already says "none"
const optionalCouponMoneySchema = z
  .string()
  .trim()
  .refine((value) => value === '' || COUPON_MONEY.test(value), errorCode('money_format'))
  .refine(
    (value) => !COUPON_MONEY.test(value) || !isZeroMoney(value),
    errorCode('storefront_sale_zero'),
  )
  .transform((value) => (value === '' ? null : value));

// '' = as many orders as come (null). Digits only, so "1e3" or "12.5" never become a number
const usageLimitSchema = z
  .string()
  .trim()
  .refine(
    (value) =>
      value === '' ||
      (/^\d{1,7}$/.test(value) &&
        Number(value) >= 1 &&
        Number(value) <= STOREFRONT_COUPON_MAX_USES),
    errorCode('storefront_coupon_limit_format'),
  )
  .transform((value) => (value === '' ? null : Number(value)));

// The form's boxes as typed. kind and value are two boxes (a select and a number), not the
// ShopDiscount union, so the form has one value box that keeps what was typed when the select
// changes; the rules below check the value for the kind, and the output joins them.
const couponFieldsSchema = z.object({
  code: shopCouponCodeSchema,
  kind: z.enum(SHOP_COUPON_KINDS),
  value: z.string().trim(),
  upTo: optionalCouponMoneySchema,
  minimum: optionalCouponMoneySchema,
  startsOn: optionalDateSchema,
  lastDay: optionalDateSchema,
  usageLimit: usageLimitSchema,
  onePerPhone: z.boolean(),
});
type CouponFields = z.output<typeof couponFieldsSchema>;

function couponRules(input: CouponFields, ctx: z.RefinementCtx<CouponFields>) {
  // A percent is whole, 1 to 99, like a listing's sale and the shop's "10% OFF" (100% gives the
  // goods away). An amount is taka above zero. The listings' words fit both
  if (input.kind === 'percent' && !/^[1-9]\d?$/.test(input.value)) {
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message: errorCode('storefront_sale_percent'),
    });
  }
  if (input.kind === 'amount') {
    if (!COUPON_MONEY.test(input.value)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: errorCode('money_format') });
    } else if (isZeroMoney(input.value)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: errorCode('storefront_sale_zero') });
    }
    // "৳50 off, up to ৳30" says two things; the form hides the box for an amount, so only
    // another client gets here
    if (input.upTo !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['upTo'],
        message: errorCode('storefront_coupon_up_to'),
      });
    }
  }
  // Both days are included, so one day (the same date twice) is a coupon for that day
  if (input.startsOn !== null && input.lastDay !== null && input.lastDay < input.startsOn) {
    ctx.addIssue({
      code: 'custom',
      path: ['lastDay'],
      message: errorCode('storefront_coupon_dates'),
    });
  }
}

// The checked boxes as the API saves them: the kind and the value as one ShopDiscount (a percent
// as a number, like the listings' ShopDiscount)
function asCoupon<T extends CouponFields>(input: T) {
  const { kind, value, ...rest } = input;
  const discount: ShopDiscount =
    kind === 'percent' ? { kind, value: Number(value) } : { kind, value };
  return { ...rest, discount };
}

export const createStorefrontCouponInputSchema = couponFieldsSchema
  .superRefine(couponRules)
  .transform(asCoupon);
export type CreateStorefrontCouponInput = z.output<typeof createStorefrontCouponInputSchema>;

export const updateStorefrontCouponInputSchema = couponFieldsSchema
  .extend({ version: versionSchema })
  .superRefine(couponRules)
  .transform(asCoupon);
export type UpdateStorefrontCouponInput = z.output<typeof updateStorefrontCouponInputSchema>;
// The form's values: what the boxes hold before the schema checks them
export type StorefrontCouponFormValues = z.input<typeof createStorefrontCouponInputSchema>;

export const storefrontCouponVersionInputSchema = z.object({ version: versionSchema });

// ---------------------------------------------------------------------------------------------
// The routes. All storefront.manage: a coupon is the shop's price, like a listing's sale

const idParamsSchema = z.object({ id: z.uuid() });

export const storefrontCouponRoutes = {
  listCoupons: defineRoute({
    method: 'GET',
    path: '/storefront/coupons',
    summary: "The shop's coupons, newest first, with how many orders have each",
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    query: storefrontCouponQuerySchema,
    response: storefrontCouponPageSchema,
  }),
  getCoupon: defineRoute({
    method: 'GET',
    path: '/storefront/coupons/:id',
    summary: 'One coupon',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    response: storefrontCouponSchema,
  }),
  createCoupon: defineRoute({
    method: 'POST',
    path: '/storefront/coupons',
    summary: 'Make a coupon the shop takes from its first day',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 201,
    body: createStorefrontCouponInputSchema,
    response: storefrontCouponSchema,
  }),
  updateCoupon: defineRoute({
    method: 'PUT',
    path: '/storefront/coupons/:id',
    summary: 'Change a coupon; its code only while no order has had it',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: updateStorefrontCouponInputSchema,
    response: storefrontCouponSchema,
  }),
  archiveCoupon: defineRoute({
    method: 'POST',
    path: '/storefront/coupons/:id/archive',
    summary: 'Take a coupon away: the shop no longer knows its code',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontCouponVersionInputSchema,
    response: storefrontCouponSchema,
  }),
  restoreCoupon: defineRoute({
    method: 'POST',
    path: '/storefront/coupons/:id/restore',
    summary: 'Give an archived coupon back to the shop',
    auth: 'bearer',
    permission: 'storefront.manage',
    status: 200,
    params: idParamsSchema,
    body: storefrontCouponVersionInputSchema,
    response: storefrontCouponSchema,
  }),
};
