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

// What the browser sends to get its cart priced: ids and counts, in the cart's order. Never a
// price, a name or a total: those come back from the server (system design §14.4). It is the one
// input in this file, so it is strict about what it takes.
export const shopCartQuoteRequestSchema = z
  .object({
    lines: z
      .array(
        z.object({
          listingId: listingIdSchema,
          quantity: z.number().int().min(1).max(SHOP_CART_MAX_QUANTITY),
        }),
      )
      .max(SHOP_CART_MAX_LINES),
  })
  .superRefine((request, ctx) => {
    // The cart adds to a line instead of making a second one (cart.ts → addLine). Two lines for one
    // listing would be priced twice, so a request that has them is not from our cart
    const seen = new Set<string>();
    request.lines.forEach((line, index) => {
      if (seen.has(line.listingId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['lines', index, 'listingId'],
          message: errorCode('invalid_input'),
        });
      }
      seen.add(line.listingId);
    });
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

// The answer. The subtotal and the item count are the server's sums of the available lines, so the
// drawer never adds money in the browser. Step 26c adds the delivery zone, the coupon and the total
export const shopCartQuoteSchema = z.object({
  lines: z.array(shopCartQuoteLineSchema),
  itemCount: z.number().int().min(0),
  subtotal: shopMoneySchema,
});

export type ShopProduct = z.infer<typeof shopProductSchema>;
export type ShopProductPage = z.infer<typeof shopProductPageSchema>;
export type ShopCartQuoteRequest = z.infer<typeof shopCartQuoteRequestSchema>;
export type ShopCartQuoteLine = z.infer<typeof shopCartQuoteLineSchema>;
export type ShopCartQuote = z.infer<typeof shopCartQuoteSchema>;
