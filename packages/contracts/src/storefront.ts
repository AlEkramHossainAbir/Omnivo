import { z } from 'zod';

import { errorCode } from './errors.js';
import { defineRoute } from './http.js';
import { isMoneyAmount } from './money.js';
import { pageOf } from './pagination.js';
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

// Where a picture is. The links above, plus plain http on this computer only: step 26f's public
// API builds photo addresses from the storage's own address (STOREFRONT_MEDIA_URL), and in dev that
// is MinIO at http://localhost:9000. Never a tenant's typed text, so this loosening opens no way in
// for a stranger's link; production refuses an http address when the API starts (config.ts)
const imageUrlSchema = z
  .string()
  .regex(/^(\/(?!\/)|https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?\/)/);

// A picture and the words a screen reader says for it. The alt text is required: a product photo
// is the main content of a shop, and an empty alt would hide it from blind shoppers
export const shopImageSchema = z.object({
  url: imageUrlSchema,
  alt: z.string().min(1),
});

export const shopThemeSchema = z.object({
  // CLAUDE.md → Storefront: only these two come from the tenant; every other color is fixed
  brand: hexColorSchema,
  accent: hexColorSchema,
});

// The footer's four pages, at /pages/<slug>. Fixed slugs: the footer links to exactly these, and
// each has its title in the shop's words (shop.footer.*), so a link and the page it opens always
// say the same. Step 26h moved it up here: publicShopSchema uses it, and a const is not there
// before its line runs
export const SHOP_TEXT_PAGES = ['privacy', 'terms', 'about', 'contact'] as const;

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
  // Step 26h: the text pages the tenant has written, in the footer's order. The footer links only
  // these, so a shopper never follows a footer link to "page not found"
  pages: z.array(z.enum(SHOP_TEXT_PAGES)),
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
  // Step 26f: null when the tenant has no hero banner (a new shop, or one deleted later). The home
  // page then starts with the "All Category" grid, so a shop never breaks for a missing picture
  hero: heroBannerSchema.nullable(),
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
  // or <ol>, <strong> for label words, <a> and <br>. Step 26f: the tenant never writes HTML; the
  // API writes it from the tenant's sections (renderSections in storefront-content.ts), escaping
  // every character they typed, because the shop puts it on the page as it is. '' = no
  // description, and the page leaves out the whole Overview card
  descriptionHtml: z.string(),
  // Step 26f: what search engines show for the page. The API fills both in, so the shop never
  // decides: the title is the tenant's SEO title or the listing's name, the description their SEO
  // description or the start of the first section ('' when there is neither, and the page then
  // has no <meta name="description">)
  seo: z.object({
    title: z.string().min(1).max(120),
    description: z.string().max(300),
  }),
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
// dashes only: a code is printed on a flyer and typed on a phone. Step 27c: exported, because the
// ERP's coupon form saves a code with the same rule (storefront-coupons.ts), so a code the tenant
// saves is always one a shopper can type
export const SHOP_COUPON_MAX_LENGTH = 20;
export const shopCouponCodeSchema = z
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
  couponCode: shopCouponCodeSchema.optional(),
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
//   "৳50 off" next to the code. Step 27c: `upTo` is the most a percent coupon takes off ("10%
//   off, up to ৳200"); null for an amount, or a percent with no such limit
// - refused: the code did nothing. `reason` is an error code the promo box turns into words:
//   unknown (no such code), expired (its last day has passed) or below its minimum (the items
//   are worth less than `minimum`, which the words name). Step 27c adds used up: the tenant
//   allowed it a number of orders, and that many have it. A code that starts on a later day is
//   unknown, so a sale the tenant has not announced yet does not leak through the promo box
export const SHOP_COUPON_REFUSALS = [
  'shop_coupon_unknown',
  'shop_coupon_expired',
  'shop_coupon_used_up',
  'shop_coupon_minimum',
] as const;
export type ShopCouponRefusal = (typeof SHOP_COUPON_REFUSALS)[number];

export const shopCouponResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }),
  z.object({
    status: z.literal('applied'),
    code: shopCouponCodeSchema,
    discount: shopDiscountSchema,
    upTo: shopMoneySchema.nullable(),
  }),
  z.object({
    status: z.literal('refused'),
    code: shopCouponCodeSchema,
    reason: z.enum(SHOP_COUPON_REFUSALS),
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
// tenant's own gateway account (SSLCommerz), which step 27d connects. Figma calls it "Mobile
// Banking"; the shop says "Pay online" (step 27d's decision 9), because SSLCommerz's page takes
// cards and internet banking as well as bKash and Nagad. The value stays `online`: it is saved on
// every order already, and it never was the words.
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
  couponCode: shopCouponCodeSchema.optional(),
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
// Step 27a: the rest of the code's rules, kept by the API.
// - A code works for 10 minutes. An SMS can arrive late, but a code that works for an hour is an
//   hour for a guesser
// - An order gets at most 3 codes: the first and two resends. Each SMS costs the shop money, and
//   a phone that has not got 3 codes will not get a fourth
// - An order and the stock it holds wait 60 minutes for the right code (system design §14.4), then
//   the order is dropped and the stock is free again
export const SHOP_CODE_VALID_MINUTES = 10;
export const SHOP_CODE_SENDS = 3;
export const SHOP_ORDER_HOLD_MINUTES = 60;

// Step 27a: how many orders may be placed in one hour. Each one sends an SMS and holds stock, so
// these limits are what stop a script from emptying a shop's shelves or its SMS balance:
// - 5 from one phone: more than any real shopper places in an hour
// - 20 from one connection: a shop's own office, or a mobile operator's shared address, can
//   place several, so it is higher than the phone's
export const SHOP_ORDERS_PER_PHONE = 5;
export const SHOP_ORDERS_PER_ADDRESS = 20;
export const SHOP_ORDER_WINDOW_MINUTES = 60;

// "01786120356" → "+880 17•• ••• 356". The first two digits say the operator and the last three
// let the shopper see it is their number; the rest stays off a screenshot. Step 27a: moved here
// from the shop's mock, because the API now writes the verify page's line too
export function maskPhone(phone: string): string {
  return `+880 ${phone.slice(1, 3)}•• ••• ${phone.slice(-3)}`;
}

// Step 27d: the payment page the shopper is sent to. SSLCommerz's own page (GatewayPageURL, always
// https), or in development and CI the shop's fake gateway page (SHOP_FAKE_GATEWAY_PATH), which is
// http on localhost. Only http and https: the shop puts it in `location`, and a `javascript:`
// address there would run on the shop's page
export const shopPaymentUrlSchema = z.url({ protocol: /^https?$/ });

// What Confirm Order answers. Which page comes next depends on the payment method:
// - verify: Cash on Delivery. The order waits for the phone code; the browser goes to
//   /checkout/verify, which says where the code went ("+880 17•• ••• 356": the middle is hidden, so
//   a screenshot of the page does not give away the number)
// - pay (step 27d): Pay online. The order waits for its payment, with no phone code (27c's
//   decision 8: a card or a wallet proves more than an SMS). The browser goes to the gateway's
//   page. paymentUrl is null when the gateway did not open a page (it was down, or it refused the
//   shop's account): the order still exists and holds its stock, and the browser goes to
//   /checkout/paid, which offers "Try again" and "Pay on delivery"
// - confirmed: the order needs no code and is paid already. Only the mock answered it (26c); the
//   API never does now, because an online order is confirmed when its payment arrives. Kept, so
//   the checkout's dialog code stays the one place that opens "Order Confirmed"
// The order's secret token is not in the body: the route sets it as an httpOnly cookie, so no
// script on the page can read it (decisions 4 and 5).
export const shopOrderPlacedSchema = z.discriminatedUnion('next', [
  z.object({
    next: z.literal('verify'),
    maskedPhone: z.string().min(1),
    resendInSeconds: z.number().int().min(0),
  }),
  z.object({
    next: z.literal('pay'),
    paymentUrl: shopPaymentUrlSchema.nullable(),
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

// Step 27a: what /checkout/verify draws for the order that waits: the same as the `verify` answer,
// plus the listings it holds. A right code takes them out of this browser's cart (26c's decision
// 23), and the page cannot know them otherwise: the cart may have changed in another tab since
// Confirm Order. It was the shop's own type (ShopCodeWait); it is here now because the API answers it
export const shopCodeWaitSchema = z.object({
  next: z.literal('verify'),
  maskedPhone: z.string().min(1),
  resendInSeconds: z.number().int().min(0),
  listingIds: z.array(listingIdSchema).min(1).max(SHOP_CART_MAX_LINES),
});

// ---------------------------------------------------------------------------------------------
// Step 27d: paying online. An online order is placed like any other (pending, holding its stock),
// then waits for its payment instead of a phone code. Each visit to the gateway's page is one try
// (a payment row in the API, with its own transaction id); the first one starts at Confirm Order.

// A payment try's life:
// - started: the gateway opened its page and the shopper is (or was) on it
// - not_opened: the gateway did not open a page (down, or it refused the shop's account)
// - paid: the gateway said, when the API asked it, that the money arrived in full. Final: no later
//   answer moves it back
// - failed, cancelled: the gateway said the bank refused it, or the shopper pressed Cancel there.
//   Not final: a payment the gateway confirms later still makes it paid (decision 5: money that
//   arrived is never left unrecorded)
export const SHOP_PAYMENT_STATUSES = [
  'started',
  'not_opened',
  'paid',
  'failed',
  'cancelled',
] as const;

// An order gets at most 3 tries, like its 3 phone codes: each one is a page the gateway makes, and
// someone pressing "Try again" all evening is not paying. After the third the shopper can still pay
// on delivery (when the shop takes it) or place the order again
export const SHOP_PAYMENT_TRIES = 3;

// The transaction id the API gives each try, and the gateway sends back (SSLCommerz's tran_id).
// Not the order's number: a pending order has none yet (27a's decision 20). 20 upper-case letters
// and digits, random: SSLCommerz takes up to 30 alphanumeric characters, and an id nobody can
// guess means a made-up post to the return path names no try. The API never trusts what the post
// says about it either way; it asks the gateway (shopGatewayPostSchema)
export const shopPaymentTranIdSchema = z.string().regex(/^[A-Z0-9]{20}$/);

// Where the gateway sends the shopper and its own server back to, on the shop's address. The API
// builds the gateway's URLs from these when it opens a payment page (the success, fail and cancel
// URLs all go to the return path; the server-to-server notice, SSLCommerz's IPN, to the notice
// path), and the shop's middleware lets only these two take a POST from another site (decision 2)
export const SHOP_PAYMENT_RETURN_PATH = '/checkout/pay/return';
export const SHOP_PAYMENT_NOTICE_PATH = '/api/payments/notice';

// What the gateway posts to both paths, as form fields with SSLCommerz's own names. Only the two
// ids are read. Everything else in the post (status, amount, card_type) is what the browser or a
// stranger sent, so the API asks the gateway itself, by val_id when there is one (a paid try) and
// by tran_id when there is not (a failed or cancelled one). An empty val_id is none
export const shopGatewayPostSchema = z.object({
  tran_id: shopPaymentTranIdSchema,
  val_id: z
    .string()
    .max(64)
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? null : value.trim())),
});

// The shop's server passes the two ids on, from either path. The API answers the try's status
// after it asked the gateway; the return path then sends the browser to /checkout/paid, and the
// notice path answers the gateway 200
export const shopPaymentSettleRequestSchema = z.object({
  tranId: shopPaymentTranIdSchema,
  valId: z.string().min(1).max(64).nullable(),
});
export const shopPaymentSettledSchema = z.object({
  status: z.enum(SHOP_PAYMENT_STATUSES),
});

// Why the last try did not pay, in the shopper's words on /checkout/paid:
// - failed, cancelled: the gateway's answer
// - not_opened: the payment page did not open
// - not_finished: the try was started, and the gateway knows no payment for it: the shopper came
//   back without paying (the browser's Back button), or the page is still open in another tab
export const SHOP_PAYMENT_PROBLEMS = ['failed', 'cancelled', 'not_opened', 'not_finished'] as const;

// What /checkout/paid draws for this browser's online order (by the cookie's token, like the
// verify page):
// - paid: the order is confirmed. The page takes its listings out of the cart (as a right phone
//   code does) and opens "Order Confirmed"
// - checking: the gateway could not be asked just now, or says the payment is still being
//   processed. The page asks again after a few seconds
// - unpaid: the last try did not pay. "Try again" while tries are left, "Pay on delivery" when the
//   shop takes it now. The total is the one the shopper agreed to; it never changes on this page
export const shopPaymentWaitSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('paid'),
    orderNo: z.string().min(1),
    phone: z.string().min(1),
    listingIds: z.array(listingIdSchema).min(1).max(SHOP_CART_MAX_LINES),
  }),
  z.object({
    state: z.literal('checking'),
  }),
  z.object({
    state: z.literal('unpaid'),
    problem: z.enum(SHOP_PAYMENT_PROBLEMS),
    triesLeft: z
      .number()
      .int()
      .min(0)
      .max(SHOP_PAYMENT_TRIES - 1),
    payOnDelivery: z.boolean(),
    total: shopMoneySchema,
  }),
]);

// "Try again" answers the new try's page, null when the gateway did not open one (the page then
// says so, and the try counts: it is a row the API keeps)
export const shopPaymentRetrySchema = z.object({
  paymentUrl: shopPaymentUrlSchema.nullable(),
});

// Development and CI: the fake gateway (PAYMENT_GATEWAY=fake in the API, and the shop's mock
// source) opens this page on the shop instead of SSLCommerz's. It shows the amount and three
// buttons, and posts what SSLCommerz posts to SHOP_PAYMENT_RETURN_PATH. Its val_id carries the
// try and what happened: the amount it says was paid (so a test can pay a wrong amount by changing
// the address), or that the bank refused it or the shopper cancelled. The API refuses
// PAYMENT_GATEWAY=fake in production, and the real gateway asks SSLCommerz about a val_id, so one
// of these typed into a live shop pays nothing
export const SHOP_FAKE_GATEWAY_PATH = '/checkout/fake-gateway';
export const FAKE_GATEWAY_OUTCOMES = ['paid', 'failed', 'cancelled'] as const;

export const fakeGatewayParamsSchema = z.object({
  tranId: shopPaymentTranIdSchema,
  amount: shopMoneySchema,
});

// What one press on the fake page says. Step 27d.3: failed and cancelled are in the val_id too.
// SSLCommerz says them in its own answer to the API; the fake gateway keeps no table, so without
// this the API could not tell "the bank refused it" from "the shopper never paid"
export type FakeGatewayAnswer =
  | { tranId: string; outcome: 'paid'; amount: string }
  | { tranId: string; outcome: 'failed' | 'cancelled' };

const FAKE_REFUSALS = { failed: 'FAILED', cancelled: 'CANCELLED' } as const;

export function fakeValId(
  tranId: string,
  answer: { outcome: 'paid'; amount: string } | { outcome: 'failed' | 'cancelled' },
): string {
  return answer.outcome === 'paid'
    ? `FAKE_${tranId}_${answer.amount}`
    : `FAKE_${tranId}_${FAKE_REFUSALS[answer.outcome]}`;
}

// The try and the answer a fake val_id names, or null for anything else (a real SSLCommerz val_id)
export function readFakeValId(valId: string): FakeGatewayAnswer | null {
  const match = /^FAKE_([A-Z0-9]{20})_(\d{1,12}(?:\.\d{1,4})?|FAILED|CANCELLED)$/.exec(valId);
  const tranId = match?.[1];
  const said = match?.[2];
  if (tranId === undefined || said === undefined) return null;
  if (said === FAKE_REFUSALS.failed) return { tranId, outcome: 'failed' };
  if (said === FAKE_REFUSALS.cancelled) return { tranId, outcome: 'cancelled' };
  return { tranId, outcome: 'paid', amount: said };
}

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
  couponCode: shopCouponCodeSchema.nullable(),
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
export type ShopCodeWait = z.infer<typeof shopCodeWaitSchema>;
export type ShopOrderStatus = (typeof SHOP_ORDER_STATUSES)[number];
export type ShopOrderLine = z.infer<typeof shopOrderLineSchema>;
export type ShopOrder = z.infer<typeof shopOrderSchema>;
export type ShopPaymentStatus = (typeof SHOP_PAYMENT_STATUSES)[number];
export type ShopPaymentProblem = (typeof SHOP_PAYMENT_PROBLEMS)[number];
export type ShopGatewayPost = z.infer<typeof shopGatewayPostSchema>;
export type ShopPaymentSettleRequest = z.infer<typeof shopPaymentSettleRequestSchema>;
export type ShopPaymentSettled = z.infer<typeof shopPaymentSettledSchema>;
export type ShopPaymentWait = z.infer<typeof shopPaymentWaitSchema>;
export type ShopPaymentRetry = z.infer<typeof shopPaymentRetrySchema>;
export type FakeGatewayOutcome = (typeof FAKE_GATEWAY_OUTCOMES)[number];
export type FakeGatewayParams = z.infer<typeof fakeGatewayParamsSchema>;

// ---------------------------------------------------------------------------------------------
// Step 26d: the category and search pages (/c/<slug>, /search).

// "Sort By". newest: the most recently published first, the order a shop shows by default. The
// four a shopper understands without a word of help; "Popular" needs sales numbers the public API
// does not give
export const SHOP_SORTS = ['newest', 'price_asc', 'price_desc', 'name'] as const;

// Cards per answer: four rows of the desktop grid's five columns, so Load More always adds whole
// rows. Not a request field: a shopper cannot ask for 1,000 cards in one page
export const SHOP_PAGE_SIZE = 20;

// A search word longer than this is never a real search. The header's box has the same maxlength
export const SHOP_SEARCH_MAX_LENGTH = 100;

// A price filter: whole taka, as a decimal string like every amount. A shopper types "500", never
// paisa, and an amount over ৳999,999,999 is not a filter
const shopPriceFilterSchema = z.string().regex(/^(0|[1-9]\d{0,8})$/);

// What the category and search pages ask the source for. The page builds it from the address
// (apps/shop/src/lib/listing-query.ts), where every value is optional and a broken one is dropped,
// so this is the clean shape: every field is present, with null for "not set"
export const shopListingQuerySchema = z
  .object({
    // A category's slug: its listings and those of every category under it. null: every listing
    // (/c/all and /search). The same characters the ERP allows in a slug, so it is safe in a URL
    category: z
      .string()
      .max(100)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .nullable(),
    // The search words. Trimmed first, so "  " is no search at all and the page sends null
    q: z.string().trim().min(1).max(SHOP_SEARCH_MAX_LENGTH).nullable(),
    sort: z.enum(SHOP_SORTS),
    // On the price the shopper pays (`price`), not the struck-out one
    minPrice: shopPriceFilterSchema.nullable(),
    maxPrice: shopPriceFilterSchema.nullable(),
    inStock: z.boolean(),
    // Only listings on sale: with a discount ribbon or a struck-out price (the "Offer" chip)
    offer: z.boolean(),
    // Where the previous answer stopped (pagination.ts: opaque, only the source reads it). null:
    // the first page
    cursor: z.string().min(1).max(512).nullable(),
  })
  // Compared as numbers: as strings "90" > "500". The page swaps a pair typed the wrong way round
  // before it gets here, so this only stops a source call that skipped the page
  .refine(
    (query) =>
      query.minPrice === null ||
      query.maxPrice === null ||
      Number(query.minPrice) <= Number(query.maxPrice),
    { message: errorCode('invalid_value'), path: ['maxPrice'] },
  );

// One page of cards, the ERP's list shape (pagination.ts): items and the next page's cursor, null
// on the last page. No total on purpose, as in the ERP: the pages never show a count
export const shopListingPageSchema = pageOf(shopListingSchema).extend({
  items: z.array(shopListingSchema).max(SHOP_PAGE_SIZE),
});

export type ShopSort = (typeof SHOP_SORTS)[number];
export type ShopListingQuery = z.infer<typeof shopListingQuerySchema>;
export type ShopListingPage = z.infer<typeof shopListingPageSchema>;

// ---------------------------------------------------------------------------------------------
// Step 26e: tracking an order, and the shop's own text pages.

// An order number as the shopper types it from the SMS. Bangla digits become ASCII ones, spaces go,
// and the letters are upper-cased, so "w-000123", "W 000123" and "W-০০০১২৩" are one number. A
// shopper who leaves out the dash ("W000123") or the letter ("000123") gets it added: the SMS says
// "W-000123", and a phone keyboard makes the dash the hardest part to type. "W-" goes in front of
// anything; what follows it that is not digits ("W-SO-2026") is then refused by the check. Six to
// nine digits: the mock counts from W-000001 (26c's decision 3), and a shop with a billion orders
// is not a worry
export const shopOrderNoSchema = z
  .string()
  .transform((value) => {
    const plain = asciiDigits(value).replace(/\s/g, '').toUpperCase();
    return plain.replace(/^(?:W-?)?/, 'W-');
  })
  .refine((value) => /^W-\d{6,9}$/.test(value), errorCode('shop_order_no_format'));

// What the /track form sends: the phone the order was placed with and its number. Both must match
// the same order; any mismatch gets the same "not found" (shop_track_not_found), so the form never
// says that a number exists with another phone
export const shopTrackRequestSchema = z.object({
  phone: shopPhoneSchema,
  orderNo: shopOrderNoSchema,
});

// The form's limit: this many tries from one connection in this many minutes. A wrong pair is the
// only answer a guesser gets, so the limit is what keeps someone from walking the order numbers
// with a phone they know
export const SHOP_TRACK_TRIES = 10;
export const SHOP_TRACK_WINDOW_MINUTES = 15;

// The token in a tracking link (/t/<token>): 16 random bytes in base64url, 22 characters, the same
// rule as the ERP's share links (document-output.ts). 128 bits cannot be guessed, so the link alone
// is the key, and the page checks the shape before it asks the source for anything
export const shopTrackingTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

// Step 27a: the key a connection's limits are counted under (the /track form's misses, the orders
// per connection). Moved here from the shop's server (26e's rate-limit.ts), because the API now
// keeps both limits. An IPv4 address is its own key; an IPv6 address counts by its /64, because
// one home or phone gets a whole /64 and could change the last half of its address at will.
export function addressKey(address: string): string {
  // "%en0" is a link-local address's interface name, not part of the address
  const plain = address.trim().toLowerCase().replace(/%.*$/, '');
  // An IPv4 address written as IPv6 ("::ffff:203.0.113.7"), which Node gives on a server that
  // listens on both
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(plain);
  if (mapped?.[1] !== undefined) return mapped[1];
  if (!plain.includes(':')) return plain;

  // "2001:db8::7" leaves out the groups that are zero. Put them back, so "2001:db8::7" and
  // "2001:db8:0:0::8" give the same /64
  const [head = '', tail] = plain.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array.from({ length: missing }, () => '0'), ...tailGroups];
  // Leading zeros dropped too ("0db8" and "db8" are the same group)
  const block = groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, ''));
  return `${block.join(':')}::/64`;
}

// Step 27a: the order's other token, the one in the browser's cookies (26c's decisions 4 and 5).
// The same shape, but a different value from the tracking link's: this one opens /order/<no>, which
// shows the buyer's phone and address, and it never leaves the browser that placed the order. The
// tracking link goes by SMS and gets forwarded, so it opens only the page without them
export const shopOrderTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

// The couriers the system design's adapters cover (§14.6). Their own names are brand names and the
// same in every language; the shop still writes them through t() (shop.track.couriers)
export const SHOP_COURIERS = ['pathao', 'steadfast', 'redx', 'ecourier', 'paperfly'] as const;

// Where a parcel is, in our own words. Each courier has its own statuses (Steadfast's
// "in_review" and "hold", Pathao's "At the Sorting HUB" and "Assigned for Delivery"); the courier's
// adapter maps them to this one set (step 28), so the page has words for every one, whichever
// courier the shop uses:
// - booked: the shop has handed the parcel's details to the courier, nobody has picked it up yet
// - picked_up, in_transit (between the courier's hubs), out_for_delivery (a rider has it)
// - delivered, partly_delivered (the shopper kept some items and sent the rest back)
// - on_hold: the rider could not deliver it (nobody at home, the phone did not answer) and will try
//   again; the courier's note says why
// - returning, returned: the parcel goes back to the shop, and is back
// - cancelled: the booking was cancelled before the courier picked it up
export const SHOP_SHIPMENT_STATUSES = [
  'booked',
  'picked_up',
  'in_transit',
  'out_for_delivery',
  'delivered',
  'partly_delivered',
  'on_hold',
  'returning',
  'returned',
  'cancelled',
] as const;

// One step the courier reported. `note` is the courier's own words ("Customer not reachable",
// "Received at Sylhet hub"), shown as they came: they are in the courier's language, not the
// shop's, and they are often the most useful line on the page. null: the courier sent none
export const shopShipmentEventSchema = z.object({
  status: z.enum(SHOP_SHIPMENT_STATUSES),
  at: z.iso.datetime({ offset: true }),
  note: z.string().trim().min(1).max(300).nullable(),
});

// One parcel with a courier. An order has one, or a second one when the first courier gave it back
// and the shop booked it again with another (the system design allows one per courier account)
export const shopShipmentSchema = z.object({
  courier: z.enum(SHOP_COURIERS),
  // The courier's code for the parcel ("SFR2611150042"), which its own call centre asks for
  trackingCode: z.string().trim().min(1).max(64),
  // The courier's own tracking page, when it has one. https only: it goes into an <a href>, and it
  // comes from the courier's answer, not from us
  trackingUrl: z
    .string()
    .regex(/^https:\/\//)
    .nullable(),
  // Oldest first, as they happened, like the order's history. A parcel exists from the moment it
  // was booked, so there is at least that event; the newest one is where the parcel is now
  events: z.array(shopShipmentEventSchema).min(1).max(100),
});

// What a tracking link and the /track form show. Less than the order page on purpose: a link in an
// SMS gets forwarded (to a family member, to a delivery group), so there is no address, no phone,
// no name and no line of what was bought. The number, the timeline, how many items, what to pay,
// and the parcel's way are what the person at the door needs
export const shopTrackingSchema = z.object({
  orderNo: z.string().min(1),
  placedAt: z.iso.datetime({ offset: true }),
  status: z.enum(SHOP_ORDER_STATUSES),
  // The same history as the order page, so 26c's timeline draws it
  history: shopOrderSchema.shape.history,
  // The pieces, not the lines: two face washes and a tea are 3 items
  itemCount: z.number().int().min(1),
  total: shopMoneySchema,
  // Cash on Delivery: the page says how much cash to keep ready for the rider
  paymentMethod: z.enum(SHOP_PAYMENT_METHODS),
  // Oldest first. Empty until the shop books the parcel with a courier
  shipments: z.array(shopShipmentSchema).max(5),
});

// The footer's four pages: SHOP_TEXT_PAGES, near the top (publicShopSchema lists the written ones)

// One text page. The HTML is the description's kind (step 26b): <section>s with an <h2>, then <p>,
// <ul>, <ol>, <strong>, <a> and <br>, written by the API from the tenant's sections (step 26f),
// drawn as it is with the description's prose style. A page the tenant has not written does not come at
// all (the source answers null and the shop shows "page not found"), so html is never empty
export const shopTextPageSchema = z.object({
  slug: z.enum(SHOP_TEXT_PAGES),
  html: z.string().min(1),
  // When the tenant last changed it, for "Last updated 1 Nov 2026" under the title. Terms and a
  // privacy policy are read with their date. null: the date is not known (an imported page)
  updatedAt: z.iso.datetime({ offset: true }).nullable(),
});

export type ShopTrackRequest = z.infer<typeof shopTrackRequestSchema>;
export type ShopCourier = (typeof SHOP_COURIERS)[number];
export type ShopShipmentStatus = (typeof SHOP_SHIPMENT_STATUSES)[number];
export type ShopShipmentEvent = z.infer<typeof shopShipmentEventSchema>;
export type ShopShipment = z.infer<typeof shopShipmentSchema>;
export type ShopTracking = z.infer<typeof shopTrackingSchema>;
export type ShopTextPage = z.infer<typeof shopTextPageSchema>;
export type ShopTextPageSlug = (typeof SHOP_TEXT_PAGES)[number];

// ---------------------------------------------------------------------------------------------
// Step 26f: the public API (/public/v1). What the shop's server asks the ERP's API for, with no
// login. Every answer is one of the shapes above, so the shop's pages do not change when its data
// source goes from the mock to this API.

// Which shop: the address the shopper typed ("acme.omnivo.shop"), as the shop's server received it
// in its own Host header. The shop's server calls the API from inside the network, so the API's
// own Host header is the API's name, not the shop's; this header carries the shop's. It names a
// shop and nothing else: anyone may send any value, and all it can get is what that shop's own
// pages already show to anyone (published listings, never an order or a phone). The API takes the
// subdomain from it ("acme") and looks it up with the database's storefront_tenant_for_subdomain
// (migration 0064); an address that is not a launched shop gets 404 storefront_not_found. Never a
// query parameter (system design §14.2): a link with ?shop=… would be a way to pass one shop off as
// another.
export const SHOP_HOST_HEADER = 'x-shop-host';

// A slug in an address: the characters the ERP allows in one, so it is safe in a URL and in a
// cache key
const slugParamSchema = z
  .string()
  .max(100)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

// The category and search query as a querystring. Every value arrives as text and may be left out;
// the flags are "1" or absent, as in the shop's own addresses (?stock=1&offer=1). Turned into the
// clean ShopListingQuery by listingQueryFromParams.
export const publicListingParamsSchema = z
  .object({
    category: slugParamSchema.optional(),
    q: z.string().trim().max(SHOP_SEARCH_MAX_LENGTH).optional(),
    sort: z.enum(SHOP_SORTS).optional(),
    minPrice: shopPriceFilterSchema.optional(),
    maxPrice: shopPriceFilterSchema.optional(),
    inStock: z.literal('1').optional(),
    offer: z.literal('1').optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  // The same rule as shopListingQuerySchema, so a wrong pair is a 400 at the door, not a ZodError
  // deep in the service
  .refine(
    (params) =>
      params.minPrice === undefined ||
      params.maxPrice === undefined ||
      Number(params.minPrice) <= Number(params.maxPrice),
    { message: errorCode('invalid_value'), path: ['maxPrice'] },
  );

export type PublicListingParams = z.input<typeof publicListingParamsSchema>;

// The API's side: the querystring (parsed) as the clean query the listing search takes. A search
// of only spaces is no search, as on the shop's pages
export function listingQueryFromParams(
  params: z.output<typeof publicListingParamsSchema>,
): ShopListingQuery {
  return {
    category: params.category ?? null,
    q: params.q === undefined || params.q === '' ? null : params.q,
    sort: params.sort ?? 'newest',
    minPrice: params.minPrice ?? null,
    maxPrice: params.maxPrice ?? null,
    inStock: params.inStock === '1',
    offer: params.offer === '1',
    cursor: params.cursor ?? null,
  };
}

// The shop's side: the clean query as the querystring it sends. Only what is set, so the default
// first page of /c/all is the plain address, the same cache entry for every shopper
export function listingParamsFromQuery(query: ShopListingQuery): PublicListingParams {
  const params: PublicListingParams = {};
  if (query.category !== null) params.category = query.category;
  if (query.q !== null) params.q = query.q;
  if (query.sort !== 'newest') params.sort = query.sort;
  if (query.minPrice !== null) params.minPrice = query.minPrice;
  if (query.maxPrice !== null) params.maxPrice = query.maxPrice;
  if (query.inStock) params.inStock = '1';
  if (query.offer) params.offer = '1';
  if (query.cursor !== null) params.cursor = query.cursor;
  return params;
}

// ---------------------------------------------------------------------------------------------
// Step 27a: the shop server's calls for orders, the phone code and tracking.

// The shop's server proves it is the shop's server with this header: a key only it and the API
// know (the API's STOREFRONT_SHOP_KEY, the shop's SHOP_API_KEY). The routes below place orders,
// send SMS and answer with a buyer's phone and address, so they are not for anyone who finds the
// API's address, as the read routes above are. auth: 'shop' in the route says so
export const SHOP_KEY_HEADER = 'x-shop-key';

// The shopper's own address (IP), as the shop's server got it from its proxy. The API sees only the
// shop's server, so the order limits (SHOP_ORDERS_PER_ADDRESS) and the /track limit need this.
// Trusted only next to a right SHOP_KEY_HEADER: anyone else could send any address
export const SHOP_CLIENT_ADDRESS_HEADER = 'x-shop-client-address';

// The bodies that carry a token. Every one is a POST with the token in its body, never in the
// path or the query: an address ends up in logs, a proxy's history and a Referer header, and these
// tokens open a buyer's order (26e's decision 3 kept the /track form's phone out of addresses for
// the same reason)
const orderTokenBodySchema = z.object({ token: shopOrderTokenSchema });

// What Confirm Order answers to the shop's server: the shopper's answer, and the token the server
// puts in the httpOnly cookie. The token is only in this answer, never in the shopper's: the API
// keeps only its hash, so this is the one moment it exists outside the cookie
export const publicOrderPlacedSchema = z.object({
  answer: shopOrderPlacedSchema,
  token: shopOrderTokenSchema,
});

export type PublicOrderPlaced = z.infer<typeof publicOrderPlacedSchema>;

// Orders, the phone code and tracking (step 27a) are under auth: 'shop', the read routes under
// 'public'. The quote stays public: the cart drawer needs today's prices and stock, and it only
// reads.
export const publicStorefrontRoutes = {
  shop: defineRoute({
    method: 'GET',
    path: '/public/v1/shop',
    summary: 'The shop named by the X-Shop-Host header: name, logo, colors, contact (no login)',
    auth: 'public',
    status: 200,
    response: publicShopSchema,
  }),
  categories: defineRoute({
    method: 'GET',
    path: '/public/v1/categories',
    summary: "The shop's categories, every level, in their order (no login)",
    auth: 'public',
    status: 200,
    response: z.array(shopCategorySchema),
  }),
  home: defineRoute({
    method: 'GET',
    path: '/public/v1/home',
    summary:
      "The shop's home page: hero banner, featured listings, banners and collections (no login)",
    auth: 'public',
    status: 200,
    response: shopHomeSchema,
  }),
  listings: defineRoute({
    method: 'GET',
    path: '/public/v1/listings',
    summary: 'Published listings of a category or a search, filtered, sorted and paged (no login)',
    auth: 'public',
    status: 200,
    query: publicListingParamsSchema,
    response: shopListingPageSchema,
  }),
  product: defineRoute({
    method: 'GET',
    path: '/public/v1/products/:slug',
    summary: 'One published listing with its gallery, description and related listings (no login)',
    auth: 'public',
    status: 200,
    params: z.object({ slug: slugParamSchema }),
    response: shopProductPageSchema,
  }),
  quote: defineRoute({
    method: 'POST',
    path: '/public/v1/cart/quote',
    summary: "Today's prices, stock and delivery charge for a cart of listing ids (no login)",
    auth: 'public',
    status: 200,
    body: shopCartQuoteRequestSchema,
    response: shopCartQuoteSchema,
  }),
  checkoutSettings: defineRoute({
    method: 'GET',
    path: '/public/v1/checkout-settings',
    summary: 'Delivery zones, payment methods, free delivery and minimum order (no login)',
    auth: 'public',
    status: 200,
    response: shopCheckoutSettingsSchema,
  }),
  textPage: defineRoute({
    method: 'GET',
    path: '/public/v1/pages/:slug',
    summary: 'One of the footer pages (privacy, terms, about, contact) (no login)',
    auth: 'public',
    status: 200,
    params: z.object({ slug: z.enum(SHOP_TEXT_PAGES) }),
    response: shopTextPageSchema,
  }),

  // Step 27a. Confirm Order: the API prices the order again, holds its stock and sends the phone
  // code. 201, as an order was made, even though it still waits for its code
  placeOrder: defineRoute({
    method: 'POST',
    path: '/public/v1/orders',
    summary: 'Place an order: price it, hold its stock and send the phone code (shop server only)',
    auth: 'shop',
    status: 201,
    body: shopOrderRequestSchema,
    response: publicOrderPlacedSchema,
  }),
  // The verify page's order, by the cookie's token. 404 shop_code_no_order when none waits
  codeWait: defineRoute({
    method: 'POST',
    path: '/public/v1/orders/code-wait',
    summary: 'The order that waits for its phone code, by its token (shop server only)',
    auth: 'shop',
    status: 200,
    body: orderTokenBodySchema,
    response: shopCodeWaitSchema,
  }),
  verifyCode: defineRoute({
    method: 'POST',
    path: '/public/v1/orders/verify',
    summary: 'Check the phone code; a right one confirms the order (shop server only)',
    auth: 'shop',
    status: 200,
    body: orderTokenBodySchema.extend(shopVerifyCodeRequestSchema.shape),
    response: shopOrderConfirmedSchema,
  }),
  resendCode: defineRoute({
    method: 'POST',
    path: '/public/v1/orders/resend',
    summary: 'Send the phone code again (shop server only)',
    auth: 'shop',
    status: 200,
    body: orderTokenBodySchema,
    response: shopCodeResentSchema,
  }),
  // /order/<no>: both must match (26c's decision 5). 404 not_found for anything else
  order: defineRoute({
    method: 'POST',
    path: '/public/v1/orders/find',
    summary:
      'A confirmed order for the browser that placed it, by number and token (shop server only)',
    auth: 'shop',
    status: 200,
    body: orderTokenBodySchema.extend({ orderNo: shopOrderNoSchema }),
    response: shopOrderSchema,
  }),
  // A tracking link (/t/<token>). 404 not_found for a link that names no order
  tracking: defineRoute({
    method: 'POST',
    path: '/public/v1/tracking',
    summary:
      "An order's tracking by its link's token: no name, phone or address (shop server only)",
    auth: 'shop',
    status: 200,
    body: z.object({ token: shopTrackingTokenSchema }),
    response: shopTrackingSchema,
  }),
  // The /track form. 404 shop_track_not_found for any wrong pair, 429 shop_track_too_many past
  // SHOP_TRACK_TRIES misses from one address
  track: defineRoute({
    method: 'POST',
    path: '/public/v1/track',
    summary:
      "An order's tracking by its number and the phone it was placed with (shop server only)",
    auth: 'shop',
    status: 200,
    body: shopTrackRequestSchema,
    response: shopTrackingSchema,
  }),

  // Step 27d. The gateway came back (the shopper's browser on the return path, or the gateway's
  // own server on the notice path): the API asks the gateway and settles the try. The same call
  // twice, or the browser and the notice at once, settle it once. 404 not_found for a transaction
  // id that is not this shop's
  settlePayment: defineRoute({
    method: 'POST',
    path: '/public/v1/payments/settle',
    summary: 'Ask the gateway about a payment try and record what it says (shop server only)',
    auth: 'shop',
    status: 200,
    body: shopPaymentSettleRequestSchema,
    response: shopPaymentSettledSchema,
  }),
  // /checkout/paid, by the cookie's token. 404 shop_payment_no_order when no online order waits
  // in this browser (it was dropped after its hour, or the cookie is gone)
  paymentWait: defineRoute({
    method: 'POST',
    path: '/public/v1/orders/payment',
    summary: "This browser's online order and where its payment is (shop server only)",
    auth: 'shop',
    status: 200,
    body: orderTokenBodySchema,
    response: shopPaymentWaitSchema,
  }),
  // "Try again". 422 shop_payment_tries_used after SHOP_PAYMENT_TRIES; 409 shop_payment_settled
  // when it is paid already, or moved to cash on delivery
  retryPayment: defineRoute({
    method: 'POST',
    path: '/public/v1/orders/payment/retry',
    summary: 'Open a new payment page for the online order (shop server only)',
    auth: 'shop',
    status: 200,
    body: orderTokenBodySchema,
    response: shopPaymentRetrySchema,
  }),
  // "Pay on delivery": the order becomes Cash on Delivery and gets its phone code, then goes on as
  // any such order does (/checkout/verify). 422 shop_payment_unavailable when the shop does not
  // take it; 409 shop_payment_settled when it is paid already
  payOnDelivery: defineRoute({
    method: 'POST',
    path: '/public/v1/orders/payment/cod',
    summary:
      'Turn the online order into cash on delivery and send its phone code (shop server only)',
    auth: 'shop',
    status: 200,
    body: orderTokenBodySchema,
    response: shopCodeWaitSchema,
  }),
};
