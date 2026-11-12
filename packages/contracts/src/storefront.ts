import { z } from 'zod';

import { errorCode } from './errors.js';
import { isMoneyAmount } from './money.js';
import { LANGUAGE_CODES } from './preferences.js';
import { isTimeZone } from './settings.js';

// Step 26a: what the public shop reads. Today the shop's mock data has this shape; from step 26b on,
// the public API (/public/v1) sends exactly this, so the pages never change when the data goes live.
// Almost everything here is an answer. The one input is the cart quote request (step 26b): ids and
// counts only, because the browser never sends a price.

// A shop price: a decimal string like the rest of the app (CLAUDE.md → Money), never a number
const shopMoneySchema = z.string().refine(isMoneyAmount, errorCode('money_format'));

// A CSS color for the tenant's theme and a banner's colors: #rrggbb only, so it can go straight
// into a style attribute without any chance of injecting other CSS
const hexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i);

// A path on the shop's own site or an absolute https URL. Never javascript: or data: links, because
// banner links come from the tenant and end up in an <a href>
const linkSchema = z.string().regex(/^(\/(?!\/)|https:\/\/)/);

// A picture and the words a screen reader says for it. The alt text is required: a product photo
// is the main content of a shop, and an empty alt would hide it from blind shoppers
export const shopImageSchema = z.object({
  url: linkSchema,
  alt: z.string().min(1),
});

export const shopThemeSchema = z.object({
  // CLAUDE.md → Storefront: only these two come from the tenant; every other color is fixed
  brand: hexColorSchema,
  accent: hexColorSchema,
});

export const publicShopSchema = z.object({
  name: z.string().min(1),
  // null: the shop has no logo of its own, so the Omnivo mark is drawn next to its name
  logo: shopImageSchema.nullable(),
  language: z.enum(LANGUAGE_CODES),
  theme: shopThemeSchema,
  hotline: z.string().min(1),
  // Step 26b: the workspace's time zone ('Asia/Dhaka'). A shop prints its own times (when a sale
  // ends, when an order was placed) in it, never in the server's or the shopper's zone
  timeZone: z.string().refine(isTimeZone),
  address: z.string().min(1),
  social: z.object({
    facebook: linkSchema.nullable(),
    instagram: linkSchema.nullable(),
    x: linkSchema.nullable(),
    linkedin: linkSchema.nullable(),
  }),
});

export const shopCategorySchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  // null for a top category; the filter row shows the top ones and opens their children
  parentId: z.string().min(1).nullable(),
});

export const SHOP_BADGES = ['most_picked', 'new', 'buy_one_get_one'] as const;

export const shopDiscountSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('amount'), value: shopMoneySchema }),
  z.object({ kind: z.literal('percent'), value: z.number().int().min(1).max(99) }),
]);

export const shopListingSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  // The pack size printed under the name ("500ml", "90(±)10gm"): words for people, not a quantity
  packSize: z.string(),
  images: z.array(shopImageSchema).min(1),
  price: shopMoneySchema,
  // The price before the sale, struck through on the product page; null when there is no sale
  compareAtPrice: shopMoneySchema.nullable(),
  saleUntil: z.iso.datetime({ offset: true }).nullable(),
  discount: shopDiscountSchema.nullable(),
  badges: z.array(z.enum(SHOP_BADGES)),
  inStock: z.boolean(),
  categoryId: z.string().min(1),
});

// The big banner at the top of the home page. Desktop and phone draw it differently (CLAUDE.md →
// Hero banner), so it carries both pictures and every word either layout shows
export const heroBannerSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('hero'),
  href: linkSchema,
  headline: z.string().min(1),
  line: z.string().nullable(),
  eyebrow: z.string().nullable(),
  buttonLabel: z.string().min(1),
  desktopImage: shopImageSchema,
  phoneImage: shopImageSchema,
  colors: z.object({
    background: hexColorSchema,
    panel: hexColorSchema,
    button: hexColorSchema,
    buttonText: hexColorSchema,
  }),
});

// A banner that is only a picture ("Mega Sale"): its words are part of the image
export const imageBannerSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('image'),
  href: linkSchema,
  desktopImage: shopImageSchema,
  phoneImage: shopImageSchema,
});

export const shopCollectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  // 'fire': the flame icon after the title, in place of the 🔥 the design used
  icon: z.enum(['fire']).nullable(),
  listings: z.array(shopListingSchema).min(1),
});

export const shopHomeSchema = z.object({
  hero: heroBannerSchema,
  // The "All Category" grid; the phone shows its first two as "Featured Products"
  featured: z.array(shopListingSchema),
  hasMoreFeatured: z.boolean(),
  blocks: z.array(
    z.discriminatedUnion('kind', [
      imageBannerSchema,
      z.object({ kind: z.literal('collection'), collection: shopCollectionSchema }),
    ]),
  ),
});

export type ShopImage = z.infer<typeof shopImageSchema>;
export type ShopTheme = z.infer<typeof shopThemeSchema>;
export type PublicShop = z.infer<typeof publicShopSchema>;
export type ShopCategory = z.infer<typeof shopCategorySchema>;
export type ShopBadge = (typeof SHOP_BADGES)[number];
export type ShopDiscount = z.infer<typeof shopDiscountSchema>;
export type ShopListing = z.infer<typeof shopListingSchema>;
export type HeroBanner = z.infer<typeof heroBannerSchema>;
export type ImageBanner = z.infer<typeof imageBannerSchema>;
export type ShopCollection = z.infer<typeof shopCollectionSchema>;
export type ShopHome = z.infer<typeof shopHomeSchema>;
export type ShopHomeBlock = ShopHome['blocks'][number];

// ---------------------------------------------------------------------------------------------
// Step 26b: the product page and the cart's prices.

// The gallery shows four thumbnails in one row (CLAUDE.md → Product page, top: 4 × 119px + 3 gaps
// of 16px = the gallery card's 524px). The server sends the listing's first four photos, so a fifth
// can never push the row out of its card.
export const SHOP_GALLERY_MAX = 4;

// One listing with everything its page shows. It is a listing (the same fields as a card, so the
// page and the card can never disagree on a price), plus the parts only the page has.
export const shopProductSchema = shopListingSchema.extend({
  images: z.array(shopImageSchema).min(1).max(SHOP_GALLERY_MAX),
  // The variant's SKU. null: the product has none (a SKU is optional in step 12), so the
  // "SKU: …" line is left out instead of saying "SKU: -"
  sku: z.string().min(1).nullable(),
  // The base unit's name, for "Per Piece" under the price. A name, not a code: "pcs" means
  // nothing to a shopper
  unitName: z.string().min(1),
  // The description, as HTML: one <section> per block, each starting with an <h2>, then <p>, <ul>
  // or <ol>, and <strong> for label words. The ERP cleans it to these tags when the tenant saves it
  // (step 26's API), because the shop puts it on the page as it is. '' = no description, and the
  // page leaves out the whole Overview card
  descriptionHtml: z.string(),
});

// What /p/<slug> needs in one answer: the product and its "Related Products" row. The related
// listings are cards, so they reuse the card's schema. At most 12: the row scrolls a page at a time,
// and three pages are plenty
export const shopProductPageSchema = z.object({
  product: shopProductSchema,
  related: z.array(shopListingSchema).max(12),
});

// The cart's limits. The browser's cart (apps/shop/src/lib/cart.ts) keeps the same 99 in its own
// constant, because importing this file would bring Zod (25 KB gz) to every page; a test in the
// shop checks that the two stay equal.
export const SHOP_CART_MAX_QUANTITY = 99;
// More lines than any real shopping basket, few enough that one request stays small
export const SHOP_CART_MAX_LINES = 50;

const listingIdSchema = z.string().min(1).max(64);

// The cart's lines as the browser sends them: ids and counts, in the cart's order. Never a price, a
// name or a total: those come back from the server (system design §14.4). Step 26c: its own schema,
// because the quote and the order both send it.
const cartLinesSchema = z
  .array(
    z.object({
      listingId: listingIdSchema,
      quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
    }),
  )
  .max(SHOP_CART_MAX_LINES)
  .superRefine((lines, ctx) => {
    // The cart adds to a line instead of making a second one (cart.ts → addLine). Two lines for one
    // listing would be priced twice, so a request that has them is not from our cart
    const seen = new Set<string>();
    lines.forEach((line, index) => {
      if (seen.has(line.listingId)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'listingId'],
          message: errorCode('invalid_input'),
        });
      }
      seen.add(line.listingId);
    });
  });

// A delivery zone's id ("inside_dhaka"). Short, because it only names one of the shop's own zones
const zoneIdSchema = z.string().min(1).max(32);

// A coupon code as the shopper typed it. Trimmed and upper-cased here, so " welcome10 " and
// "WELCOME10" are one code, and the server never compares two spellings of it. Letters, digits and
// dashes only: a code is printed on a flyer and typed on a phone
export const SHOP_COUPON_MAX_LENGTH = 20;
const couponCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9-]{1,20}$/, errorCode('shop_coupon_format'));

// What the browser sends to get its cart priced. The drawer sends only the lines; the checkout
// (step 26c) also sends the delivery zone the shopper picked and the coupon they applied, so the
// answer carries the delivery charge, the discount and the total. Both are optional, never
// required: an old drawer that sends `{ lines }` still gets its subtotal.
export const shopCartQuoteRequestSchema = z.object({
  lines: cartLinesSchema,
  zoneId: zoneIdSchema.optional(),
  couponCode: couponCodeSchema.optional(),
});

// The parts of a listing a cart line draws: the 96×80 image box, the name (a link to its page) and
// the pack size
const quoteLineListingSchema = z.object({
  listingId: listingIdSchema,
  slug: z.string().min(1),
  name: z.string().min(1),
  packSize: z.string(),
  image: shopImageSchema,
});

// One line of the answer, in the request's order. Three cases, because the cart in the browser can
// be days old:
// - available: priced at today's price, and counted in the subtotal
// - out_of_stock: still shown, so the shopper sees what happened, but not counted and not sold
// - unavailable: the listing is gone (unpublished or deleted). The answer says only its id, and the
//   browser drops it from the stored cart
export const shopCartQuoteLineSchema = z.discriminatedUnion('status', [
  quoteLineListingSchema.extend({
    status: z.literal('available'),
    quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
    unitPrice: shopMoneySchema,
    lineTotal: shopMoneySchema,
  }),
  quoteLineListingSchema.extend({
    status: z.literal('out_of_stock'),
    quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
  }),
  z.object({ status: z.literal('unavailable'), listingId: listingIdSchema }),
]);

// What happened to the coupon the request sent. A coupon that does not apply never fails the quote:
// the cart is still priced, and the promo box says why the code did nothing.
// - none: no code was sent
// - applied: the code took money off; `discount` says how, so the promo box can say "10% off" or
//   "৳50 off" next to the code
// - refused: the code did nothing. `reason` is an error code the promo box turns into words:
//   unknown (no such code), expired (its last day has passed) or below its minimum (the items
//   are worth less than `minimum`, which the words name)
export const shopCouponResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({
    status: z.literal('applied'),
    code: couponCodeSchema,
    discount: shopDiscountSchema,
  }),
  z.object({
    status: z.literal('refused'),
    code: couponCodeSchema,
    reason: z.enum(['shop_coupon_unknown', 'shop_coupon_expired', 'shop_coupon_minimum']),
    // Only for shop_coupon_minimum: "Add ৳120 more to use this code" needs the amount
    minimum: shopMoneySchema.nullable(),
  }),
]);

// The answer. Every amount is the server's: the subtotal and the item count are sums of the
// available lines, so the drawer and the checkout never add money in the browser.
// Step 26c adds the rest of the bill:
// - discount: what the coupon took off the subtotal ('0' without one). Never off the delivery
// - deliveryCharge: the zone's charge, '0' when the order gets free delivery, null when no zone
//   was sent (the drawer, or a checkout before the shopper picks one)
// - freeDelivery: the subtotal reached the shop's free-delivery amount, so the Delivery Charge row
//   says "Free" instead of "৳0"
// - total: subtotal − discount + delivery charge. Without a zone it is the items only, and the
//   checkout does not offer Confirm Order until a zone is picked
// - belowMinimum: the subtotal is under the shop's minimum order; Confirm Order is disabled and
//   says how much more is needed (the shop's settings have the minimum)
export const shopCartQuoteSchema = z.object({
  lines: z.array(shopCartQuoteLineSchema),
  itemCount: z.number().int().min(0),
  subtotal: shopMoneySchema,
  discount: shopMoneySchema,
  coupon: shopCouponResultSchema,
  deliveryCharge: shopMoneySchema.nullable(),
  freeDelivery: z.boolean(),
  total: shopMoneySchema,
  belowMinimum: z.boolean(),
});

export type ShopProduct = z.infer<typeof shopProductSchema>;
export type ShopProductPage = z.infer<typeof shopProductPageSchema>;
export type ShopCartQuoteRequest = z.infer<typeof shopCartQuoteRequestSchema>;
export type ShopCartQuoteLine = z.infer<typeof shopCartQuoteLineSchema>;
export type ShopCartQuote = z.infer<typeof shopCartQuoteSchema>;
export type ShopCouponResult = z.infer<typeof shopCouponResultSchema>;

// ---------------------------------------------------------------------------------------------
// Step 26c: checkout, the phone code and the order.

// How the shopper pays. The system design's payment_method is cod | online; "online" is the
// tenant's own gateway (SSLCommerz, bKash), which step 27 connects. The checkout calls it
// "Mobile Banking", as Figma does.
export const SHOP_PAYMENT_METHODS = ['cod', 'online'] as const;

// A delivery zone the shop delivers to, with its charge ("Inside Dhaka — ৳80")
export const shopDeliveryZoneSchema = z.object({
  id: zoneIdSchema,
  name: z.string().min(1),
  charge: shopMoneySchema,
});

// What /checkout needs before the first quote: the zones and payment methods to offer, and the
// amounts the page explains ("Free delivery on orders over ৳1,000"). Its own answer, not part of
// the shop: only this page uses it, and every other page loads the shop. The quote applies the same
// settings on the server; the page only shows them.
export const shopCheckoutSettingsSchema = z.object({
  // At least one, or nothing can be delivered. Six fit the radio cards' two columns on one screen
  zones: z.array(shopDeliveryZoneSchema).min(1).max(6),
  paymentMethods: z.array(z.enum(SHOP_PAYMENT_METHODS)).min(1),
  // null: the shop never delivers for free / takes an order of any size. Compared with the
  // subtotal (the items before the coupon), so a coupon never takes free delivery away
  freeDeliveryFrom: shopMoneySchema.nullable(),
  minimumOrder: shopMoneySchema.nullable(),
});

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

function asciiDigits(value: string): string {
  return value.replace(/[০-৯]/g, (digit) => String(BANGLA_DIGITS.indexOf(digit)));
}

// A Bangladeshi mobile number, the way a courier and an SMS gateway need it: 01 then the operator
// digit (3–9) then 8 digits, 11 in all ("01786120356"). The shopper may type it any common way:
// "+880 1786-120356", "8801786120356", Bangla digits from a Bangla keyboard. All of them become
// the same 11 digits here, so one phone is one phone in the orders, the code's limits and the
// SMS. A landline or a foreign number is refused: the code goes by SMS, and the courier calls it.
export const shopPhoneSchema = z
  .string()
  .transform((value) => {
    const digits = asciiDigits(value).replace(/[\s-]/g, '');
    return digits.replace(/^(?:\+?880)(?=1)/, '0');
  })
  .refine((value) => /^01[3-9]\d{8}$/.test(value), errorCode('shop_phone_format'));

// What Confirm Order sends. The same lines, zone and coupon as the last quote, plus the delivery
// details and the payment method. Never an amount the server trusts:
// - expectedTotal is the total the shopper saw on the screen. The server works the order out again
//   and refuses it (shop_order_changed) when its total is different, because a price, the stock or
//   the coupon changed after the last quote. The shopper then sees the new total before paying it
// - termsAccepted must be true; the button is disabled until the box is ticked, and the server
//   checks again, because the shop owner may need to show that the shopper agreed
export const shopOrderRequestSchema = z.object({
  lines: cartLinesSchema.min(1, errorCode('shop_cart_empty')),
  zoneId: zoneIdSchema,
  couponCode: couponCodeSchema.optional(),
  name: z.string().trim().min(1, errorCode('required')).max(80, errorCode('too_long')),
  phone: shopPhoneSchema,
  // Long enough for "House 12, Road 5, Block C, Mirpur 10, Dhaka", short enough for a label
  address: z
    .string()
    .trim()
    .min(10, errorCode('shop_address_too_short'))
    .max(300, errorCode('too_long')),
  paymentMethod: z.enum(SHOP_PAYMENT_METHODS),
  termsAccepted: z.literal(true, errorCode('shop_terms_required')),
  expectedTotal: shopMoneySchema,
});

// The phone code's rules (system design §14.4: Cash on Delivery always confirms the phone)
export const SHOP_CODE_LENGTH = 6;
export const SHOP_CODE_TRIES = 5;
export const SHOP_CODE_RESEND_SECONDS = 45;

// What Confirm Order answers. Which page comes next depends on the payment method:
// - verify: Cash on Delivery. The order waits for the phone code; the browser goes to
//   /checkout/verify, which says where the code went ("+880 17•• ••• 356": the middle is hidden, so
//   a screenshot of the page does not give away the number)
// - confirmed: the order needs no code (Mobile Banking in the mock, until step 27's gateway). The
//   checkout opens the "Order Confirmed" dialog
// The order's secret token is not in the body: the route sets it as an httpOnly cookie, so no
// script on the page can read it (decisions 4 and 5).
export const shopOrderPlacedSchema = z.discriminatedUnion('next', [
  z.object({
    next: z.literal('verify'),
    maskedPhone: z.string().min(1),
    resendInSeconds: z.number().int().min(0),
  }),
  z.object({
    next: z.literal('confirmed'),
    orderNo: z.string().min(1),
    phone: z.string().min(1),
  }),
]);

// What /checkout/verify sends: the six digits. Bangla digits are accepted, like the phone
export const shopVerifyCodeRequestSchema = z.object({
  code: z
    .string()
    .transform((value) => asciiDigits(value).replace(/\s/g, ''))
    .refine((value) => /^\d{6}$/.test(value), errorCode('shop_code_format')),
});

// A right code confirms the order: the same answer as an order that needed no code, so the page
// opens the same dialog
export const shopOrderConfirmedSchema = z.object({
  orderNo: z.string().min(1),
  phone: z.string().min(1),
});

// "Resend code" answers when the next one may be asked for
export const shopCodeResentSchema = z.object({
  resendInSeconds: z.number().int().min(0),
});

// An order's life (system design §14.3 storefront_orders.status). Cancelled and returned end it
export const SHOP_ORDER_STATUSES = [
  'pending',
  'confirmed',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'returned',
] as const;

// One line of a placed order, priced as it was at that moment. A copy, not the listing: the
// listing's price, name or photo may change later, and the order must still say what was bought
const shopOrderLineSchema = quoteLineListingSchema.extend({
  quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
  unitPrice: shopMoneySchema,
  lineTotal: shopMoneySchema,
});

// What /order/<no> shows. Only the browser that placed the order gets it (decision 5): it has the
// shopper's phone and address
export const shopOrderSchema = z.object({
  orderNo: z.string().min(1),
  placedAt: z.iso.datetime({ offset: true }),
  status: z.enum(SHOP_ORDER_STATUSES),
  // When each step happened, oldest first: the timeline draws a done dot with its date for each,
  // and the steps still ahead without one. Starts with pending at placedAt
  history: z
    .array(z.object({ status: z.enum(SHOP_ORDER_STATUSES), at: z.iso.datetime({ offset: true }) }))
    .min(1),
  name: z.string().min(1),
  phone: z.string().min(1),
  address: z.string().min(1),
  zoneName: z.string().min(1),
  paymentMethod: z.enum(SHOP_PAYMENT_METHODS),
  lines: z.array(shopOrderLineSchema).min(1),
  subtotal: shopMoneySchema,
  discount: shopMoneySchema,
  couponCode: couponCodeSchema.nullable(),
  deliveryCharge: shopMoneySchema,
  total: shopMoneySchema,
});

export type ShopPaymentMethod = (typeof SHOP_PAYMENT_METHODS)[number];
export type ShopDeliveryZone = z.infer<typeof shopDeliveryZoneSchema>;
export type ShopCheckoutSettings = z.infer<typeof shopCheckoutSettingsSchema>;
export type ShopOrderRequest = z.infer<typeof shopOrderRequestSchema>;
export type ShopOrderRequestInput = z.input<typeof shopOrderRequestSchema>;
export type ShopOrderPlaced = z.infer<typeof shopOrderPlacedSchema>;
export type ShopVerifyCodeRequest = z.infer<typeof shopVerifyCodeRequestSchema>;
export type ShopOrderConfirmed = z.infer<typeof shopOrderConfirmedSchema>;
export type ShopCodeResent = z.infer<typeof shopCodeResentSchema>;
export type ShopOrderStatus = (typeof SHOP_ORDER_STATUSES)[number];
export type ShopOrderLine = z.infer<typeof shopOrderLineSchema>;
export type ShopOrder = z.infer<typeof shopOrderSchema>;
