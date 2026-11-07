import { z } from 'zod';

import { errorCode } from './errors.js';
import { isMoneyAmount } from './money.js';
import { LANGUAGE_CODES } from './preferences.js';

// Step 26a: what the public shop reads. Today the shop's mock data has this shape; from step 26b on,
// the public API (/public/v1) sends exactly this, so the pages never change when the data goes live.
// Nothing here is a form: the browser never sends a price, so every schema is an answer, not input.

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
